// lib/sav-actions.js
// Dépôt : bbp-webhook
//
// Briques communes aux gestes SAV déclenchés depuis la MESSAGERIE
// (messagerie-influence-sav) : remboursement carte et émission d'avoir.
//
// Ajout 2026-09-21, demandé par Luc : « je dois aussi pouvoir rembourser une
// commande, je dois pouvoir émettre un avoir et l'envoyer à la cliente »
// depuis le back-office de la messagerie.
//
// POURQUOI ICI ET PAS DANS LA MESSAGERIE. Les règles d'argent vivent déjà
// dans ce dépôt : lib/settlement.js (règles R1–R9, les 5,90 €, la part carte
// prioritaire), lib/gift-card.js (code déterministe, échéance 6 mois, trois
// filets anti-doublon), lib/klaviyo.js (flow « Avoir émis »). Les recopier
// ailleurs, ce serait deux versions des mêmes règles qui divergeraient à la
// première évolution — sur de l'argent réel. La messagerie orchestre et
// affiche ; ce dépôt exécute.
//
// SÉCURITÉ. Ces routes déplacent de l'argent. Elles sont protégées par
// SAV_ACTIONS_SECRET, une variable DISTINCTE de CRON_SECRET,
// MARK_REFUNDED_SECRET et RECEPTION_API_KEY : une fuite de l'une ne donne pas
// le droit de rembourser.

const { shopifyGraphQL } = require("./shopify.cjs");
const { safeEqual } = require("./admin-auth.cjs");

const TAG_REMBOURSEMENT = "remboursement-a-faire";

// Passerelles qui ne sont PAS de l'argent rendu sur un moyen de paiement.
// Un règlement en carte cadeau se rend en avoir, jamais en virement : c'est
// tout le sens du correctif du 18/09 sur lib/order-payments.js.
// 14/10/2026 : le crédit boutique remonte sous « shopify_store_credit » (vu sur
// C295825…C295853). Sans lui, la part payée en cagnotte était comptée comme de
// l'argent remboursable sur la carte bancaire.
const GATEWAYS_NON_REMBOURSABLES = new Set(["gift_card", "store_credit", "shopify_store_credit"]);

// États d'une transaction REFUND qui ne correspondent à AUCUN argent engagé.
// Tout le reste — SUCCESS, mais aussi PENDING et AWAITING_RESPONSE — est de
// l'argent déjà sorti ou en train de sortir, donc à déduire du disponible.
//
// DÉDUPLICATION 22/09. Cette définition existait en TROIS exemplaires :
// ici, dans lib/settlement.js (`ETATS_REMBOURSEMENT_ECHOUE`, consommée par
// `refundsEngaged`) et implicitement dans lib/order-payments.js. La
// transmission du 21/09 demandait qu'elle finisse « en un seul endroit du
// socle ». Le portail a fait sa moitié le 22/09 en la consommant depuis
// settlement.js ; voici la mienne. Une règle d'argent écrite deux fois, ce
// sont deux règles qui divergent à la première évolution.
//
// Pas de cycle : settlement.js ne requiert ni ce fichier ni order-payments.
const { ETATS_REMBOURSEMENT_ECHOUE } = require("./settlement.cjs");

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * Contrôle d'accès des routes /api/sav/*, EN-TÊTE UNIQUEMENT.
 *
 * checkAdminToken() accepte aussi « ?token=<secret> », ce qui est pratique pour
 * les liens cliquables du digest. Mais un secret dans une URL finit dans les
 * journaux d'accès du serveur, dans l'en-tête Referer et dans l'historique du
 * navigateur. Sur des routes qui déplacent de l'argent, ça ne va pas — signalé
 * par la revue du portail le 21/09, et corrigé ici plutôt que dans
 * lib/admin-auth.js, que d'autres routes partagent.
 *
 * Une requête qui porte quand même un ?token= est refusée SANS le comparer :
 * si le secret a voyagé dans l'URL, il est déjà compromis, et l'accepter
 * reviendrait à récompenser la mauvaise pratique.
 *
 * Renvoie null si autorisé, sinon { status, error }.
 */
function controleAccesSav(req, envName = "SAV_ACTIONS_SECRET") {
  const attendu = process.env[envName];
  if (!attendu) return { status: 503, error: `${envName} n'est pas configuré sur Vercel.` };
  if ((req.query || {}).token) {
    return {
      status: 400,
      error: "secret_en_parametre_url",
      detail: "Le secret doit voyager dans l'en-tête Authorization, jamais dans l'URL.",
    };
  }
  const auth = String((req.headers || {}).authorization || "");
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (bearer && safeEqual(bearer, attendu)) return null;
  return { status: 403, error: "Non autorisé." };
}

// Plafond d'un avoir. C'est une CONSTANTE du serveur, pas une suggestion :
// l'appelant peut l'abaisser, jamais le lever (corrigé le 21/09 après revue —
// un plafond que l'appelant fournit n'est pas un plafond).
//
// 300 € depuis le 21/09, demande de Luc. Une carte cadeau est de l'argent au
// porteur, et contrairement au remboursement elle n'est bornée par RIEN d'autre
// que ce plafond : ni par ce que la cliente a payé, ni par ce qu'elle a
// renvoyé. C'est donc le seul garde-fou sur le montant, d'où un chiffre bas.
// Relevable par la variable d'environnement PLAFOND_AVOIR sur bbp-webhook, si
// un cas le justifie un jour.
const PLAFOND_AVOIR = Math.round((Number(process.env.PLAFOND_AVOIR) || 300) * 100) / 100;

const ORDER_QUERY = `
  query CommandeSav($query: String!) {
    orders(first: 1, query: $query) {
      edges { node {
        id name note tags email
        cancelledAt
        metafields(namespace: "${require("./brand.cjs").metafieldNamespace}", first: 50) { edges { node { key value } } }
        displayFinancialStatus
        customer { id firstName }
        currencyCode
        totalRefundedSet { shopMoney { amount } }
        currentTotalPriceSet { shopMoney { amount currencyCode } }
        transactions(first: 30) {
          id kind status gateway
          parentTransaction { id }
          amountSet { shopMoney { amount currencyCode } }
        }
      } }
    }
  }
`;

async function chargerCommande(orderNameOrGid) {
  const data = await shopifyGraphQL(ORDER_QUERY, {
    query: String(orderNameOrGid).startsWith("gid://")
      ? `id:${String(orderNameOrGid).split("/").pop()}`
      : `name:${orderNameOrGid}`,
  });
  return data?.orders?.edges?.[0]?.node || null;
}

/**
 * Montant encore annoncé comme dû dans la note de commande. MÊME LECTURE que
 * api/daily-digest.js : la messagerie doit afficher exactement le chiffre du
 * digest, sinon les deux se contredisent sous les yeux de Luc.
 */
function montantDuDansLaNote(note) {
  let refund = 0;
  let avoir = 0;
  for (const line of String(note || "").split("\n")) {
    const m = line.match(/Remboursement à faire : ([\d.]+) €/);
    if (m) refund += parseFloat(m[1]) || 0;
    const a = line.match(/Avoir ([\d.]+) €[^\n]*NON ÉMIS/);
    if (a) avoir += parseFloat(a[1]) || 0;
  }
  return { refund: round2(refund), avoir: round2(avoir) };
}

/**
 * Transactions de paiement remboursables : ventes ou captures réussies, hors
 * carte cadeau. Renvoie aussi le total déjà remboursé, pour borner.
 *
 * Deux bornes, et on garde la plus basse (durci le 21/09) :
 *  - GLOBALE : totalRefundedSet, ce que Shopify dit avoir déjà rendu sur la
 *    commande. Conservatrice : elle inclut aussi les avoirs, donc elle
 *    sous-estime le disponible plutôt que de le surestimer.
 *  - PAR TRANSACTION : chaque paiement ne peut rendre que ce qu'il a encaissé,
 *    moins ce qui lui a déjà été repris (transactions REFUND rattachées par
 *    parentTransaction). Sans ça, une commande réglée en deux fois et déjà
 *    remboursée en partie sur l'un des deux paiements laissait proposer un
 *    montant que Shopify aurait refusé au dernier moment.
 */
function transactionsRemboursables(order) {
  const transactions = order.transactions || [];

  const rendusParPaiement = new Map();
  for (const t of transactions) {
    if (String(t.kind).toUpperCase() !== "REFUND") continue;
    // On compte TOUT ce qui n'a pas échoué, PENDING compris.
    //
    // Trouvé sur le premier remboursement réel (C295145, 21/09) : un
    // remboursement carte reste PENDING plusieurs jours, et Shopify ne
    // l'ajoute à totalRefundedSet qu'une fois encaissé. Pendant tout ce
    // temps, les deux bornes le voyaient comme inexistant — l'écran annonçait
    // 69,90 € disponibles sur une commande dont 23,10 € étaient déjà partis.
    // Un remboursement en attente est de l'argent engagé : il se déduit.
    if (ETATS_REMBOURSEMENT_ECHOUE.has(String(t.status).toUpperCase())) continue;
    const parent = t.parentTransaction?.id;
    if (!parent) continue;
    rendusParPaiement.set(
      parent,
      round2((rendusParPaiement.get(parent) || 0) + parseFloat(t.amountSet?.shopMoney?.amount || "0"))
    );
  }

  const encaissements = transactions.filter(
    (t) => ["SALE", "CAPTURE"].includes(String(t.kind).toUpperCase())
      && String(t.status).toUpperCase() === "SUCCESS"
      && !GATEWAYS_NON_REMBOURSABLES.has(String(t.gateway || "").toLowerCase())
  );
  const payantes = encaissements
    .map((t) => ({
      ...t,
      restant: round2(Math.max(
        0,
        parseFloat(t.amountSet?.shopMoney?.amount || "0") - (rendusParPaiement.get(t.id) || 0)
      )),
    }))
    .filter((t) => t.restant > 0);

  const totalPaye = round2(encaissements.reduce((s, t) => s + parseFloat(t.amountSet?.shopMoney?.amount || "0"), 0));
  const restantParPaiement = round2(payantes.reduce((s, t) => s + t.restant, 0));
  // totalRefundedSet n'inclut PAS les remboursements encore en attente : la
  // borne globale seule sous-estime donc ce qui est déjà parti. C'est la borne
  // par paiement, elle, qui voit le PENDING. On garde la plus basse des deux.
  const dejaRembourse = round2(parseFloat(order.totalRefundedSet?.shopMoney?.amount || "0"));
  const enAttente = round2(totalPaye - dejaRembourse - restantParPaiement);
  return {
    payantes,
    totalPaye,
    dejaRembourse,
    rembourse_en_attente: Math.max(0, enAttente),
    restantParPaiement,
    disponible: round2(Math.min(Math.max(0, totalPaye - dejaRembourse), restantParPaiement)),
  };
}

/**
 * Somme des avoirs DÉJÀ ÉMIS sur la commande.
 *
 * Source : les témoins `bbp.avoir_<identifiant>` posés par lib/gift-card.js à
 * chaque émission, qui portent le montant. C'est la seule trace fiable — la
 * note de commande, elle, n'est pas réécrite par api/sav/avoir.js, et un
 * avoir émis depuis la messagerie n'y apparaît donc pas (constaté le 22/09
 * sur C295145 : 219 € d'avoirs, dont la note n'en mentionnait que 19).
 *
 * Un témoin illisible est ignoré plutôt que compté à zéro en silence : il
 * ressort dans `illisibles`, et l'appelant refuse. Sous-estimer les avoirs
 * déjà émis, ce serait sur-autoriser le suivant.
 */
function avoirsDejaEmis(order) {
  const edges = order?.metafields?.edges || [];
  let total = 0;
  const illisibles = [];
  const details = [];
  for (const edge of edges) {
    const key = edge?.node?.key || "";
    if (!key.startsWith("avoir_")) continue;
    let parsed;
    try {
      parsed = JSON.parse(edge.node.value);
    } catch {
      illisibles.push(key);
      continue;
    }
    const montant = Number(parsed?.amount);
    if (!Number.isFinite(montant) || montant < 0) {
      illisibles.push(key);
      continue;
    }
    total = round2(total + montant);
    details.push({ key, code: parsed.code || null, amount: round2(montant) });
  }
  return { total: round2(total), details, illisibles };
}

/**
 * Montant maximum qu'un NOUVEL avoir peut porter sur cette commande.
 *
 * RÈGLE POSÉE PAR LUC LE 22/09 : « il n'y a aucune raison pour qu'un avoir
 * soit supérieur à une commande », et ce qui a déjà été rendu se déduit.
 *
 * Avant ce jour, un avoir n'était borné QUE par PLAFOND_AVOIR. Le 22/09 à
 * 06h45, un avoir de 200 € est parti sur C295145 — une commande de 69,90 €
 * déjà remboursée de 23,10 € et déjà créditée de 19 € d'avoir. Soit 242,10 €
 * rendus pour 69,90 € encaissés, sans qu'aucun garde-fou ne bronche. Avec
 * cette fonction, le disponible ce jour-là valait 27,80 € et les 200 €
 * étaient refusés.
 *
 *   restitué   = remboursements (PENDING COMPRIS) + avoirs déjà émis
 *   disponible = max(0, total commande − restitué)
 *   plafond    = min(PLAFOND_AVOIR, disponible)
 *
 * Les remboursements sont comptés via transactionsRemboursables(), qui sait
 * voir le PENDING : un remboursement carte reste en attente plusieurs jours
 * et n'entre pas dans totalRefundedSet. Ne compter que ce dernier laisserait
 * le disponible trop généreux pendant tout ce temps (piège du 21/09).
 *
 * C'est une BORNE DURE, comme PLAFOND_AVOIR depuis la revue du 21/09 :
 * l'appelant peut seulement l'abaisser, jamais la lever. Un geste commercial
 * qui doit dépasser la commande se fait à la main dans Shopify — c'est un
 * autre acte, et il laisse une autre trace.
 */
function disponibleAvoir(order) {
  const total = round2(parseFloat(order?.currentTotalPriceSet?.shopMoney?.amount || "0"));
  const paiements = transactionsRemboursables(order);
  // dejaRembourse (totalRefundedSet) ignore le PENDING ; rembourse_en_attente
  // le rattrape. La somme des deux est ce qui est réellement engagé.
  const rembourse = round2(paiements.dejaRembourse + paiements.rembourse_en_attente);
  const avoirs = avoirsDejaEmis(order);
  const restitue = round2(rembourse + avoirs.total);
  const disponible = round2(Math.max(0, total - restitue));
  return {
    total_commande: total,
    rembourse,
    avoirs_deja_emis: avoirs.total,
    avoirs_details: avoirs.details,
    avoirs_illisibles: avoirs.illisibles,
    restitue,
    disponible,
    plafond: round2(Math.min(PLAFOND_AVOIR, disponible)),
  };
}

/**
 * Répartit un montant sur les paiements, du plus gros au plus petit : une
 * commande réglée en deux fois se rembourse sur les deux.
 *
 * Extraite ici le 21/09 après revue. Elle vivait en double — une fois dans
 * api/sav/refund.js, une fois recopiée dans le test. Le test validait donc sa
 * propre copie, pas le code qui tourne.
 *
 * `reste > 0` en sortie veut dire que la demande ne tient pas : à l'appelant
 * de refuser, jamais de rembourser partiellement en silence.
 */
function repartirSurTransactions(payantes, demande) {
  const dispo = (t) => (t.restant !== undefined
    ? t.restant
    : round2(parseFloat(t.amountSet?.shopMoney?.amount || "0")));
  const triees = [...payantes].sort((a, b) => dispo(b) - dispo(a));
  let reste = round2(demande);
  const parts = [];
  for (const t of triees) {
    if (reste <= 0) break;
    const part = round2(Math.min(reste, dispo(t)));
    if (part <= 0) continue;
    parts.push({ transaction: t, gateway: t.gateway, amount: part.toFixed(2) });
    reste = round2(reste - part);
  }
  return { parts, reste };
}

/**
 * Marque le remboursement dans la commande.
 *
 * DEUX CAS, distingués depuis la revue du 21/09. Avant, le `/g` réécrivait
 * TOUTES les lignes « Remboursement à faire » et le tag partait sans
 * condition : deux retours sur la même commande, ou un acompte, et le solde
 * restant disparaissait de la note ET du digest, silencieusement.
 *
 *  - Le remboursement couvre tout ce qui est annoncé → on solde : les lignes
 *    passent en « Remboursement FAIT le … » et le tag est retiré. C'est le
 *    comportement de api/mark-refunded.js, mot pour mot, pour que les deux
 *    chemins laissent la même trace.
 *  - Il ne couvre pas tout → on N'EFFACE RIEN. On ajoute une ligne d'acompte
 *    qui dit ce qui reste, et LE TAG RESTE. Le tag est la source de vérité du
 *    digest : tant qu'il reste dû, il doit rester.
 */
function decisionMarquage(noteActuelle, montant, jour) {
  const du = round2(montantDuDansLaNote(noteActuelle).refund);
  // Une note qui n'annonce rien (geste commercial hors retour) est soldée :
  // il n'y a pas de reste à préserver.
  const soldeTotal = !(du > 0) || round2(montant) >= du - 0.005;
  const reste = soldeTotal ? 0 : round2(du - montant);
  const note = (soldeTotal
    ? String(noteActuelle || "").replace(/Remboursement à faire : /g, `Remboursement FAIT le ${jour} : `)
      + `\n[SAV ${jour}] Remboursement de ${round2(montant).toFixed(2)} € exécuté depuis la messagerie.`
    : String(noteActuelle || "")
      + `\n[SAV ${jour}] Acompte de ${round2(montant).toFixed(2)} € remboursé depuis la messagerie`
      + ` — reste ${reste.toFixed(2)} € à faire.`
  ).slice(0, 5000);
  return { soldeTotal, reste, annonce: du, note, retirerTag: soldeTotal };
}

async function marquerRembourse(order, montant) {
  const jour = new Date().toISOString().slice(0, 10).split("-").reverse().join("/");
  const { soldeTotal, reste, annonce, note } = decisionMarquage(order.note, montant, jour);

  try {
    await shopifyGraphQL(
      `mutation NoteSav($input: OrderInput!) { orderUpdate(input: $input) { userErrors { field message } } }`,
      { input: { id: order.id, note } }
    );
  } catch (e) {
    // La note est un confort ; le tag est la source de vérité du digest.
    console.warn(`sav-refund ${order.name} : note non mise à jour — ${e.message}`);
  }

  if (soldeTotal && (order.tags || []).includes(TAG_REMBOURSEMENT)) {
    await shopifyGraphQL(
      `mutation RetireTag($id: ID!) { tagsRemove(id: $id, tags: ["${TAG_REMBOURSEMENT}"]) { userErrors { field message } } }`,
      { id: order.id }
    );
  }
  return { soldeTotal, reste, annonce };
}

/**
 * Un échec de Shopify est-il DÉTERMINISTE — c'est-à-dire refusé avant toute
 * exécution — ou incertain ?
 *
 * La distinction compte, et elle nous a manqué au premier essai réel du 21/09 :
 * `lib/shopify.js` jette AUSSI sur `userErrors`, donc un refus propre de
 * Shopify (ici « @idempotent manquant », une erreur de requête) tombait dans
 * le même filet qu'une coupure réseau et ressortait en « incertain — va
 * vérifier dans Shopify ». Alors qu'on savait, de façon certaine, que rien
 * n'était parti.
 *
 * Tous les cas listés ici sont rejetés par Shopify AVANT d'exécuter quoi que
 * ce soit : requête mal formée, droit manquant, quota dépassé, refus métier.
 */
function erreurDeterministe(message) {
  const m = String(message || "");
  return m.startsWith("userErrors Shopify:")
    || /"code"\s*:\s*"(BAD_REQUEST|BAD_USER_INPUT|GRAPHQL_VALIDATION_FAILED|UNDEFINED_FIELD|ACCESS_DENIED|UNAUTHORIZED|THROTTLED)"/.test(m)
    || /@idempotent/.test(m);
}

/** Message lisible à partir du JSON d'erreurs de Shopify. */
function messageLisible(brut) {
  const m = String(brut || "");
  const json = m.slice(m.indexOf("["));
  try {
    const liste = JSON.parse(json);
    const messages = (Array.isArray(liste) ? liste : [])
      .map((e) => e && e.message)
      .filter(Boolean);
    if (messages.length) return messages.join(" ; ").slice(0, 300);
  } catch { /* on retombe sur le message brut */ }
  return m.slice(0, 300);
}

/**
 * Ce qui mérite d'être affiché en rouge AVANT le bouton. Aucun de ces cas
 * n'empêche techniquement le remboursement (le montant reste borné par
 * `disponible`), mais aucun ne devrait passer sans que Luc l'ait vu.
 */
function avertissementsCommande(order) {
  const out = [];
  if (order.cancelledAt) {
    out.push("Cette commande est ANNULÉE dans Shopify.");
  }
  const statut = String(order.displayFinancialStatus || "").toUpperCase();
  if (statut === "REFUNDED") {
    out.push("Shopify considère cette commande comme déjà entièrement remboursée.");
  } else if (statut === "PARTIALLY_REFUNDED") {
    out.push("Cette commande a déjà fait l'objet d'un remboursement partiel.");
  } else if (statut === "VOIDED") {
    out.push("Le paiement de cette commande a été annulé (voided).");
  }
  return out;
}

module.exports = {
  TAG_REMBOURSEMENT,
  GATEWAYS_NON_REMBOURSABLES,
  ETATS_REMBOURSEMENT_ECHOUE,
  controleAccesSav,
  PLAFOND_AVOIR,
  round2,
  chargerCommande,
  montantDuDansLaNote,
  transactionsRemboursables,
  avoirsDejaEmis,
  disponibleAvoir,
  repartirSurTransactions,
  avertissementsCommande,
  erreurDeterministe,
  messageLisible,
  decisionMarquage,
  marquerRembourse,
};
