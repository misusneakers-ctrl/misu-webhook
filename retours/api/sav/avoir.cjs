// api/sav/avoir.js
// Dépôt : bbp-webhook
//
// POST /api/sav/avoir → émet une carte cadeau (avoir) et l'envoie à la cliente
//
// Ajout 2026-09-21, appelé par la messagerie sur un clic de Luc.
//
// Ne réimplémente RIEN : l'émission passe par lib/gift-card.js, exactement
// comme api/receive-return.js. Même code déterministe, même échéance de
// 6 mois, mêmes trois filets anti-doublon, même rattachement au compte
// cliente. L'e-mail part par le flow Klaviyo « Avoir émis » déjà en place.
//
// Identifiant d'avoir. lib/gift-card.js dérive le code et le métachamp témoin
// d'un identifiant de retour. Un avoir émis depuis la messagerie n'a pas
// toujours de retour derrière lui (geste commercial, colis perdu) : on
// fabrique alors un identifiant stable à partir de la clé d'idempotence,
// « SAV-<commande>-<clé> ». Deux clics avec la même clé retombent donc sur le
// même code, que Shopify refuse comme déjà pris — c'est le filet n°2.

const { shopifyGraphQL } = require("../../lib/shopify.cjs");
const { issueStoreCredit, readIssuedCredit, CREDIT_VALIDITY_MONTHS: GIFT_CARD_VALIDITY_MONTHS } = require("../../lib/store-credit.cjs");
const { trackAvoirIssued } = require("../../lib/klaviyo.cjs");
const {
  round2,
  controleAccesSav,
  chargerCommande,
  montantDuDansLaNote,
  avertissementsCommande,
  disponibleAvoir,
  PLAFOND_AVOIR,
} = require("../../lib/sav-actions.cjs");

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

function identifiantAvoir({ returnId, orderName, key }) {
  if (returnId) return String(returnId);
  return `SAV-${orderName}-${String(key).replace(/[^A-Za-z0-9_-]/g, "")}`.slice(0, 60);
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

  // Règle du 22/09 : un avoir ne peut pas dépasser ce qui reste dû sur la
  // commande, remboursements ET avoirs déjà émis déduits. Voir disponibleAvoir().
  const bornes = disponibleAvoir(order);

  if (req.method === "GET") {
    res.status(200).json({
      ok: true,
      order: order.name,
      email: order.email || null,
      avoir_non_emis: duNote.avoir,
      // On propose le montant annoncé dans la note, mais JAMAIS au-delà du
      // disponible : l'écran ne doit pas suggérer un montant que la route
      // refusera trois secondes plus tard.
      propose: round2(Math.min(duNote.avoir || 0, bornes.plafond)),
      validite_mois: GIFT_CARD_VALIDITY_MONTHS,
      // `plafond` est désormais le plafond EFFECTIF (le plus bas des deux) :
      // c'est lui que l'interface doit afficher et opposer à la saisie.
      plafond: bornes.plafond,
      plafond_absolu: PLAFOND_AVOIR,
      total_commande: bornes.total_commande,
      deja_rembourse: bornes.rembourse,
      avoirs_deja_emis: bornes.avoirs_deja_emis,
      avoirs_details: bornes.avoirs_details,
      restitue: bornes.restitue,
      disponible: bornes.disponible,
      devise: order.currentTotalPriceSet?.shopMoney?.currencyCode || order.currencyCode || "EUR",
      annulee: Boolean(order.cancelledAt),
      avertissements: avertissementsCommande(order),
    });
    return;
  }

  const key = corps.idempotency_key ? String(corps.idempotency_key).slice(0, 80) : null;
  if (!key) {
    res.status(400).json({ ok: false, error: "idempotency_key_requise" });
    return;
  }

  const montant = corps.amount !== undefined && corps.amount !== null && corps.amount !== ""
    ? round2(corps.amount)
    : duNote.avoir;
  if (!(montant > 0)) {
    res.status(400).json({ ok: false, error: "montant_nul", detail: "Aucun montant d'avoir : ni fourni, ni annoncé dans la note." });
    return;
  }
  // Un témoin d'avoir illisible fausse le calcul du disponible par le BAS :
  // on autoriserait plus qu'il ne faut. On s'arrête plutôt que de deviner.
  if (bornes.avoirs_illisibles.length) {
    res.status(503).json({
      ok: false,
      error: "avoirs_deja_emis_illisibles",
      detail: "Un témoin d'avoir de cette commande n'a pas pu être lu : impossible de calculer ce qui reste disponible.",
      cles: bornes.avoirs_illisibles,
    });
    return;
  }

  // DEUX bornes, et on garde la plus basse (règle posée par Luc le 22/09).
  //
  //  1. PLAFOND_AVOIR (300 €) — une carte cadeau est de l'argent au porteur,
  //     on refuse les montants absurdes plutôt que d'en émettre une à 5 000 €
  //     sur une faute de frappe.
  //  2. LE DISPONIBLE — total de la commande moins ce qui a déjà été rendu,
  //     remboursements (PENDING compris) et avoirs déjà émis. « Il n'y a
  //     aucune raison pour qu'un avoir soit supérieur à une commande. »
  //
  // Les deux sont des constantes du SERVEUR : l'appelant peut seulement les
  // abaisser, jamais les lever. Avant la revue du 21/09, le plafond était
  // fourni par l'appelant — ce n'était donc pas un plafond.
  const plafond = Math.min(round2(corps.plafond || PLAFOND_AVOIR), bornes.plafond);
  if (montant > plafond) {
    res.status(409).json({
      ok: false,
      error: montant > PLAFOND_AVOIR ? "montant_au_dessus_du_plafond" : "montant_superieur_au_disponible",
      montant,
      plafond,
      plafond_absolu: PLAFOND_AVOIR,
      total_commande: bornes.total_commande,
      deja_rembourse: bornes.rembourse,
      avoirs_deja_emis: bornes.avoirs_deja_emis,
      disponible: bornes.disponible,
    });
    return;
  }

  const demandePar = corps.created_by ? String(corps.created_by).trim().slice(0, 80) : "";
  if (!demandePar) {
    res.status(400).json({ ok: false, error: "created_by_requis", detail: "L'appelant doit s'identifier." });
    return;
  }

  const returnId = identifiantAvoir({ returnId: corps.return_id, orderName: order.name, key });

  // Filet n°1 : le témoin posé par une émission précédente.
  // readIssuedGiftCard prend ses arguments par position, contrairement à
  // issueGiftCard qui prend un objet — vérifié dans lib/gift-card.js.
  //
  // Une erreur de LECTURE n'est pas une absence de témoin : on s'arrête. Le
  // code déterministe de la carte est certes un deuxième filet (Shopify refuse
  // un code déjà pris), mais on ne s'appuie pas sur un filet quand on peut
  // simplement ne pas sauter (revue du 21/09).
  let deja;
  try {
    deja = await readIssuedCredit(shopifyGraphQL, order.id, returnId);
    if (deja && deja.status === "echec") deja = null;
  } catch (e) {
    res.status(503).json({
      ok: false,
      error: "verification_idempotence_impossible",
      detail: "Impossible de vérifier si un avoir a déjà été émis pour ce retour. Rien n'a été tenté — réessayer plus tard.",
    });
    return;
  }
  if (deja) {
    res.status(200).json({ ok: true, replay: true, order: order.name, return_id: returnId, ...deja });
    return;
  }

  const avertissements = [];
  let carte;
  try {
    carte = await issueStoreCredit({
      shopifyGraphQL,
      orderId: order.id,
      returnId,
      amount: montant,
      customerId: order.customer?.id || null,
      onWarning: (label, message) => avertissements.push(`${label} : ${message}`),
    });
  } catch (e) {
    res.status(502).json({ ok: false, error: "emission_impossible", detail: String(e.message || e).slice(0, 300) });
    return;
  }

  // L'e-mail part par le flow Klaviyo déjà en place. Un échec d'envoi ne doit
  // pas faire croire que l'avoir n'existe pas : la carte, elle, est émise.
  let email = { sent: false };
  try {
    email = await trackAvoirIssued({
      email: order.email,
      firstName: order.customer?.firstName || null,
      orderName: order.name,
      returnId,
      code: null,
      amount: carte.amount,
      type: carte.type,
      endsAt: carte.expiresOn,
      reason: corps.reason === "commande_payee_en_avoir" ? "commande_payee_en_avoir" : "choix_cliente",
    });
  } catch (e) {
    avertissements.push(`e-mail Klaviyo non envoyé : ${String(e.message || e).slice(0, 200)}`);
  }

  res.status(201).json({
    ok: true,
    replay: false,
    order: order.name,
    return_id: returnId,
    kind: "store_credit",
    amount: carte.amount,
    expires_on: carte.expiresOn,
    attached_to_customer: carte.attachedToCustomer,
    email_envoye: email.sent !== false,
    avertissements,
  });
};

module.exports.config = { maxDuration: 60 };
