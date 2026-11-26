// api/sav/refund.js
// Dépôt : bbp-webhook
//
// GET  /api/sav/refund?order=C294671  → ce qu'on PEUT rembourser, sans rien faire
// POST /api/sav/refund                → exécute le remboursement
//
// Ajout 2026-09-21. Appelé par la messagerie (messagerie-influence-sav), sur
// un clic de Luc. C'est la première route de ce dépôt qui déplace vraiment de
// l'argent : api/mark-refunded.js, lui, ne fait que retirer un tag une fois le
// virement fait à la main.
//
// SIX GARDE-FOUS, dans cet ordre :
//  1. Secret partagé SAV_ACTIONS_SECRET, distinct des autres secrets du dépôt.
//  2. Clé d'idempotence OBLIGATOIRE, mémorisée en métachamp de commande AVANT
//     l'appel à Shopify : une réponse perdue en route ne se rejoue pas.
//  3. Montant borné par ce qui a réellement été encaissé et pas encore
//     remboursé.
//  4. Jamais sur une transaction carte cadeau : une commande réglée en avoir
//     se rend en avoir, pas en virement (correctif du 18/09 sur
//     lib/order-payments.js — 10 commandes sur 100 sont concernées chez BBP).
//  5. Le GET permet à l'appelant d'afficher le montant AVANT de proposer le
//     bouton : rien ne part sans que Luc ait vu le chiffre.
//  6. Aucune valeur par défaut silencieuse : sans montant explicite, on prend
//     celui écrit dans la note par api/receive-return.js — le même que celui
//     du digest — et on le renvoie dans la réponse pour qu'il soit vérifiable.

const { shopifyGraphQL } = require("../../lib/shopify.cjs");
const { setReturnMetafields } = require("../../lib/shopify.cjs");
const {
  round2,
  controleAccesSav,
  chargerCommande,
  montantDuDansLaNote,
  transactionsRemboursables,
  repartirSurTransactions,
  erreurDeterministe,
  messageLisible,
  avertissementsCommande,
  marquerRembourse,
} = require("../../lib/sav-actions.cjs");

const NAMESPACE = require("../../lib/brand.cjs").metafieldNamespace;

function cleIdempotence(key) {
  return `sav_refund_${String(key).replace(/[^A-Za-z0-9_-]/g, "")}`.slice(0, 60);
}

async function lireTemoin(orderId, key) {
  const data = await shopifyGraphQL(
    `query Temoin($id: ID!, $key: String!) {
       order(id: $id) { metafield(namespace: "${NAMESPACE}", key: $key) { value } }
     }`,
    { id: orderId, key: cleIdempotence(key) }
  );
  const brut = data?.order?.metafield?.value;
  if (!brut) return null;
  try { return JSON.parse(brut); } catch { return null; }
}

async function lireCorps(req) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch { return {}; } }
  const brut = await new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
  try { return JSON.parse(brut); } catch { return {}; }
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  // En-tête uniquement : pas de ?token= sur une route qui déplace de l'argent.
  const refus = controleAccesSav(req);
  if (refus) {
    res.status(refus.status).json({ ok: false, error: refus.error, detail: refus.detail });
    return;
  }
  if (req.method !== "GET" && req.method !== "POST") {
    res.status(405).json({ ok: false, error: "method_not_allowed" });
    return;
  }

  const corps = req.method === "POST" ? await lireCorps(req) : req.query || {};
  const orderRef = corps.order || (req.query || {}).order;
  if (!orderRef) {
    res.status(400).json({ ok: false, error: "order_requis" });
    return;
  }

  let order;
  try {
    order = await chargerCommande(orderRef);
  } catch (e) {
    res.status(502).json({ ok: false, error: "shopify_indisponible", detail: String(e.message || e).slice(0, 300) });
    return;
  }
  if (!order) {
    res.status(404).json({ ok: false, error: "commande_introuvable" });
    return;
  }

  const duNote = montantDuDansLaNote(order.note);
  const remboursable = transactionsRemboursables(order);

  // --- GET : on regarde, on ne touche à rien -------------------------------
  if (req.method === "GET") {
    res.status(200).json({
      ok: true,
      order: order.name,
      currency: order.currentTotalPriceSet?.shopMoney?.currencyCode || order.currencyCode || "EUR",
      annonce_dans_la_note: duNote.refund,
      avoir_non_emis: duNote.avoir,
      deja_rembourse: remboursable.dejaRembourse,
      // Un remboursement carte reste PENDING plusieurs jours avant d'entrer
      // dans totalRefundedSet. L'afficher à part évite la question « pourquoi
      // le disponible a baissé alors que rien n'apparaît comme remboursé ».
      rembourse_en_attente: remboursable.rembourse_en_attente,
      encaisse_remboursable: remboursable.totalPaye,
      restant_par_paiement: remboursable.restantParPaiement,
      disponible: remboursable.disponible,
      tags: order.tags || [],
      annulee: Boolean(order.cancelledAt),
      statut_financier: order.displayFinancialStatus || null,
      // Rien ici n'interdit le remboursement — le montant reste borné par
      // `disponible`. Mais l'interface doit l'afficher avant le bouton.
      avertissements: avertissementsCommande(order),
      // Ce que l'interface doit proposer par défaut : le montant de la note,
      // borné par ce qui reste réellement remboursable.
      propose: round2(Math.min(duNote.refund || 0, remboursable.disponible)),
      moyens: remboursable.payantes.map((t) => ({
        gateway: t.gateway,
        amount: t.amountSet?.shopMoney?.amount || null,
      })),
    });
    return;
  }

  // --- POST : on exécute ---------------------------------------------------
  const key = corps.idempotency_key ? String(corps.idempotency_key).slice(0, 80) : null;
  if (!key) {
    res.status(400).json({ ok: false, error: "idempotency_key_requise" });
    return;
  }

  // Traçabilité : sur une route qui déplace de l'argent, on veut savoir qui a
  // cliqué. Obligatoire depuis la revue du 21/09 — c'est ce qui rend le témoin
  // métachamp exploitable en audit.
  const demandePar = corps.created_by ? String(corps.created_by).trim().slice(0, 80) : "";
  if (!demandePar) {
    res.status(400).json({ ok: false, error: "created_by_requis", detail: "L'appelant doit s'identifier." });
    return;
  }

  // Le témoin d'idempotence. NE JAMAIS avaler l'erreur de lecture : une panne
  // réseau Shopify passagère est indiscernable de « pas de témoin », et le
  // code en concluait « jamais remboursé ». C'était le seul chemin du lot qui
  // sortait réellement de l'argent en double (revue du 21/09).
  let temoin;
  try {
    temoin = await lireTemoin(order.id, key);
  } catch (e) {
    res.status(503).json({
      ok: false,
      error: "verification_idempotence_impossible",
      detail: "Impossible de vérifier si ce remboursement a déjà été fait. Rien n'a été tenté — réessayer plus tard.",
    });
    return;
  }
  if (temoin) {
    res.status(200).json({ ok: true, replay: true, ...temoin });
    return;
  }

  const demande = corps.amount !== undefined && corps.amount !== null && corps.amount !== ""
    ? round2(corps.amount)
    : duNote.refund;

  if (!(demande > 0)) {
    res.status(400).json({ ok: false, error: "montant_nul", detail: "Aucun montant à rembourser : ni fourni, ni annoncé dans la note." });
    return;
  }
  if (demande > remboursable.disponible) {
    res.status(409).json({
      ok: false,
      error: "montant_superieur_au_disponible",
      demande,
      disponible: remboursable.disponible,
      detail: "Le montant dépasse ce qui a été encaissé sur un moyen de paiement remboursable et pas encore rendu.",
    });
    return;
  }
  if (!remboursable.payantes.length) {
    res.status(409).json({
      ok: false,
      error: "aucune_transaction_remboursable",
      detail: "Aucun paiement carte sur cette commande — un règlement en carte cadeau se rend en avoir, pas en virement.",
    });
    return;
  }

  // Répartition sur les transactions (lib/sav-actions.js, testée là-bas).
  const devise = order.currentTotalPriceSet?.shopMoney?.currencyCode || order.currencyCode || "EUR";
  const { parts, reste } = repartirSurTransactions(remboursable.payantes, demande);
  if (reste > 0) {
    res.status(409).json({ ok: false, error: "repartition_impossible", reste });
    return;
  }
  const transactions = parts.map((p) => ({
    orderId: order.id,
    parentId: p.transaction.id,
    gateway: p.gateway,
    kind: "REFUND",
    amount: p.amount,
  }));

  // Témoin AVANT l'appel : si la réponse se perd, le prochain essai avec la
  // même clé lit le témoin et ne rembourse pas une seconde fois.
  const temoinValeur = {
    order: order.name,
    amount: demande,
    currency: devise,
    idempotency_key: key,
    demande_par: demandePar,
    engage_a: new Date().toISOString(),
    status: "engage",
  };
  try {
    await setReturnMetafields(order.id, { [cleIdempotence(key)]: temoinValeur });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: "temoin_idempotence_impossible",
      detail: "Impossible de mémoriser la demande avant l'appel : remboursement NON exécuté, pour ne pas risquer un doublon.",
    });
    return;
  }

  let refund;
  try {
    // @idempotent est OBLIGATOIRE sur refundCreate depuis l'API 2026-04
    // (optionnel depuis 2026-01). Sans lui, Shopify refuse la requête en
    // BAD_REQUEST — c'est ce qui s'est passé au premier essai réel du 21/09.
    //
    // Bonne nouvelle au passage : on lui donne NOTRE clé d'idempotence. Le
    // dédoublonnage est donc désormais assuré par Shopify lui-même, en plus du
    // témoin métachamp. Rejouer le même clic ne peut plus rembourser deux fois,
    // même si notre témoin est illisible.
    const data = await shopifyGraphQL(
      `mutation RemboursementSav($input: RefundInput!, $cle: String!) {
         refundCreate(input: $input) @idempotent(key: $cle) {
           refund { id totalRefundedSet { shopMoney { amount currencyCode } } }
           userErrors { field message }
         }
       }`,
      {
        cle: cleIdempotence(key),
        input: {
          orderId: order.id,
          currency: devise,
          note: String(corps.note || "Remboursement SAV depuis la messagerie").slice(0, 300),
          notify: corps.notify === true,
          transactions,
        },
      }
    );
    const erreurs = data?.refundCreate?.userErrors || [];
    refund = data?.refundCreate?.refund;
    if (erreurs.length || !refund) {
      const message = erreurs.map((e) => e.message).join(" ; ") || "refund_create_failed";
      await setReturnMetafields(order.id, { [cleIdempotence(key)]: { ...temoinValeur, status: "echec", erreur: message } }).catch(() => {});
      res.status(502).json({ ok: false, error: "refund_refuse_par_shopify", detail: message });
      return;
    }
  } catch (e) {
    const brut = String(e.message || e);
    const message = messageLisible(brut);

    // Refus net de Shopify : la requête n'a jamais été exécutée. On le dit,
    // plutôt que d'envoyer Luc vérifier dans Shopify pour rien.
    if (erreurDeterministe(brut)) {
      await setReturnMetafields(order.id, {
        [cleIdempotence(key)]: { ...temoinValeur, status: "echec", erreur: message },
      }).catch(() => {});
      res.status(502).json({
        ok: false,
        error: "refund_refuse_par_shopify",
        detail: `${message} — aucun remboursement n'a été exécuté.`,
      });
      return;
    }

    // Sinon : coupure, délai, 5xx. L'appel a PEUT-ÊTRE abouti. On NE retire
    // PAS le témoin. Rejouer avec la même clé est sans danger (@idempotent
    // côté Shopify), mais c'est à Luc de le décider en connaissance de cause.
    await setReturnMetafields(order.id, {
      [cleIdempotence(key)]: { ...temoinValeur, status: "incertain", erreur: message },
    }).catch(() => {});
    res.status(502).json({
      ok: false,
      error: "refund_incertain",
      detail: `${message} — vérifier dans Shopify AVANT de réessayer : le remboursement a peut-être abouti.`,
    });
    return;
  }

  const resultat = {
    ...temoinValeur,
    status: "fait",
    refund_id: refund.id,
    total_rembourse_commande: refund.totalRefundedSet?.shopMoney?.amount || null,
    fait_a: new Date().toISOString(),
  };
  await setReturnMetafields(order.id, { [cleIdempotence(key)]: resultat }).catch(() => {});
  // Le marquage dit s'il reste dû : un acompte ne solde pas la note et garde
  // le tag, pour que le digest continue de réclamer le reste.
  const marquage = await marquerRembourse(order, demande).catch((e) => {
    console.warn(`sav-refund ${order.name} : marquage non fait — ${e.message}`);
    return null;
  });

  res.status(201).json({
    ok: true,
    replay: false,
    ...resultat,
    solde_total: marquage ? marquage.soldeTotal : null,
    reste_du: marquage ? marquage.reste : null,
  });
};

// maxDuration se règle dans vercel.json (bloc `functions`) pour les fonctions
// Vercel hors Next.js — l'entrée y est, cet export n'est qu'un doublon inoffensif.
module.exports.config = { maxDuration: 60 };
