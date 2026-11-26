// lib/settlement.js
// Dépôt : bbp-webhook
//
// Calcul du règlement d'un retour à la réception (carte / avoir).
// Fonctions PURES (aucun appel réseau) : testables à part, utilisées par
// api/receive-return.js.
//
// MODÈLE DU 18/09/2026 (claude/DECISIONS-Portail-Retours-BBP-2026-09-18) :
// trois choix par article — remboursement (− 5,90 € retenus sur la part carte
// en priorité), échange de TAILLE du même modèle (gratuit, sans différence de
// prix possible), ou avoir en CARTE CADEAU (valeur entière, sans frais).
// L'échange n'a donc plus aucune incidence sur le règlement : il est compensé
// EN NATURE (la cliente reçoit la taille choisie). computeExchangeCredit(),
// qui valorisait un échange vers un autre modèle, a été supprimée avec lui.
//
// Règles de Luc (16/09) :
//  1. Commande payée (en tout ou partie) avec un AVOIR : on rembourse d'abord
//     la part payée en carte (dans la limite de ce qui n'a pas déjà été
//     remboursé en carte), puis le reste en avoir, dans la limite de la
//     valeur de l'article.
//     Ex. 100 € d'avoir + 19 € carte, article de 59,50 € retourné
//         → 19 € carte + 34,60 € avoir (59,50 − 5,90 de frais − 19).
//  2. Le retour qui VIDE la commande rend tout ce qui reste : avoir(s) +
//     montant payé − valeur des articles déjà retournés.
//     Ex. 59,50 € payés avec un avoir de 100 € → 100 − 5,90 = 94,10 € d'avoir.
//  3. (Supprimée le 18/09 : l'échange ne portant plus que sur une autre
//     taille du même modèle, au même prix, il n'y a plus de différence.)
//  4. Frais d'étiquette 5,90 € déduits dès qu'un article est REMBOURSÉ
//     (18/09 : un échange de taille dans le même retour n'en exonère plus —
//     sinon il suffisait d'ajouter un échange pour éviter les frais ; un
//     avoir demandé par la cliente n'en porte jamais).
//
// Ce qui compte comme "avoir" :
//  - un code à montant fixe à usage unique (usageLimit = 1) : avoirs Rise
//    et Baback (vérifié le 17/09 : BABACK-… et TEST-… ont usageLimit 1,
//    WELCOME10 / BISOU10 ont usageLimit null → codes promo, PAS des avoirs) ;
//  - sur une commande d'échange, la remise "Valeur avoir / store credit" ou
//    "Valeur article(s) retourné(s)" reportée depuis la commande d'origine :
//    c'est un moyen de paiement, pas une réduction. Elle est rendue en avoir
//    si la commande d'origine avait été payée avec un avoir, en carte sinon.

// 23/10 : "BA-EXCHANGE" = remise posée par Baback sur ses commandes d'échange
// (avant le portail maison). Même nature : valeur de l'article rendu, donc un
// moyen de paiement. Constaté sur C294650 (échange de C293861) : sans ce
// titre, l'article valait 0 € et son retour en remboursement ne rendait rien.
const EXCHANGE_CREDIT_TITLES = ["Valeur avoir / store credit", "Valeur article(s) retourné(s)", "BA-EXCHANGE"];

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function isExchangeCreditTitle(title) {
  return EXCHANGE_CREDIT_TITLES.includes(String(title || ""));
}

// Clé d'identification d'une application de remise (code ou titre manuel),
// pour relier une allocation de ligne à son application.
function applicationKey(app) {
  if (!app) return null;
  if (app.code) return `code:${String(app.code).toUpperCase()}`;
  if (app.title) return `manual:${app.title}`;
  return null;
}

// paymentKeys : Set des clés d'applications considérées comme un moyen de
// paiement (avoirs + crédit d'échange). Valeur unitaire d'un article =
// prix d'origine − remises "réelles" (codes promo, remises auto) réparties
// sur la ligne. Les avoirs ne réduisent pas la valeur de l'article.
function unitValue(lineItem, paymentKeys) {
  const qty = lineItem.quantity || 1;
  const original = parseFloat(lineItem.originalUnitPrice || "0");
  let realDiscounts = 0;
  for (const alloc of lineItem.discountAllocations || []) {
    const key = applicationKey(alloc.application);
    if (key && paymentKeys.has(key)) continue;
    realDiscounts += parseFloat(alloc.amount || "0");
  }
  return round2(Math.max(0, original - realDiscounts / qty));
}

// Montants "carte" déjà réglés par les réceptions précédentes, relus dans
// la note de commande ("Remboursement à faire : 19.00 € (carte)" ; même
// formule qu'avant le 17/09, lue aussi par le digest quotidien).
//
// CORRECTIF 21/09 — les deux formulations comptent. Depuis que la messagerie
// exécute les remboursements (lib/sav-actions.js, marquerRembourse), la ligne
// « Remboursement à faire : 23.10 € » est RÉÉCRITE en « Remboursement FAIT le
// 21/09/2026 : 23.10 € ». L'ancienne expression ne la reconnaissait plus : une
// somme réellement sortie disparaissait purement et simplement du calcul, et
// un deuxième retour sur la même commande repartait comme si rien n'avait été
// rendu. C'est exactement le défaut que nos deux dépôts pouvaient créer
// ensemble sans qu'aucun des deux ne soit fautif seul.
const REMBOURSEMENT_NOTE = /Remboursement (?:à faire|FAIT le \d{2}\/\d{2}\/\d{4}) : ([\d.]+) €/;

function parseCashAlreadySettled(note, currentReturnId) {
  let total = 0;
  for (const line of String(note || "").split("\n")) {
    const m = line.match(/^\[(R-[^\]]+)-RECEPTION\]/);
    if (!m || m[1] === currentReturnId) continue;
    const m2 = line.match(REMBOURSEMENT_NOTE);
    if (m2) total += parseFloat(m2[1]);
  }
  return round2(total);
}

// États d'une transaction REFUND qui ne correspondent à AUCUN argent engagé.
// Repris à l'identique de lib/sav-actions.js : une même vérité des deux côtés.
const ETATS_REMBOURSEMENT_ECHOUE = new Set(["FAILURE", "ERROR", "UNKNOWN"]);

/**
 * Remboursements déjà ENGAGÉS sur la commande, d'après les transactions.
 *
 * CORRECTIF 21/09 — `totalRefundedSet` ne compte que l'encaissé : un
 * remboursement carte reste PENDING plusieurs jours et vaut 0 pendant tout ce
 * temps. Constaté en vrai sur C295145 : transaction REFUND de 23,10 € posée à
 * 13h15, `totalRefundedSet` à 0,00 € — et `refunds[0].totalRefundedSet` à 0,00 €
 * lui aussi. Tout REFUND qui n'a pas échoué est de l'argent sorti ou en train
 * de sortir.
 */
function refundsEngaged(order) {
  const transactions = (order && order.transactions) || [];
  const total = transactions.reduce((sum, t) => {
    if (String(t.kind || "").toUpperCase() !== "REFUND") return sum;
    if (ETATS_REMBOURSEMENT_ECHOUE.has(String(t.status || "").toUpperCase())) return sum;
    return sum + parseFloat(t.amountSet?.shopMoney?.amount || "0");
  }, 0);
  return round2(total);
}

function returnNumber(returnId) {
  const n = parseInt(String(returnId || "").split("-").pop(), 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * @param {object} p
 * @param {number} p.refundItemsValue   valeur des articles "remboursement" reçus conformes
 * @param {boolean} p.hasExchangeInReturn
 * @param {boolean} p.emptiesOrder      ce retour (avec ceux créés avant lui) couvre toute la commande
 * @param {number} p.avoirPaid          part payée en avoir (valeur nominale des avoirs)
 * @param {number} p.cashPaid           part payée en carte (articles, hors livraison)
 * @param {number} p.previouslyReturnedValue valeur des articles des retours créés avant celui-ci
 * @param {number} p.cashAlreadySettled carte déjà remboursée / à rembourser par d'autres retours
 * @param {number} p.fee
 */
function computeSettlement(p) {
  const V = round2(p.refundItemsValue);
  const C = round2(p.creditItemsValue || 0);
  const avoirPaid = round2(p.avoirPaid);
  const cashPaid = round2(p.cashPaid);

  // Frais dus dès qu'il y a un article REMBOURSÉ dans le retour (modèle du
  // 18/09). Un avoir choisi par la cliente n'en porte jamais : c'est tout
  // l'intérêt du choix. Un échange de taille n'exonère plus le remboursement
  // des frais — sinon il suffisait d'ajouter un échange pour les éviter.
  const fee = V > 0 ? round2(p.fee) : 0;

  // Règle 2 : le retour qui VIDE une commande payée en avoir rend tout ce qui
  // reste (avoir + carte − articles déjà retournés), jamais moins que la
  // valeur des articles de ce retour.
  let base = round2(V + C);
  let basis = "item_value";
  if (base > 0 && avoirPaid > 0 && p.emptiesOrder) {
    // Les articles ÉCHANGÉS sont compensés en nature (la cliente reçoit la
    // taille choisie) : leur valeur ne peut pas être rendue une 2e fois.
    const remaining = round2(
      avoirPaid + cashPaid - (p.previouslyReturnedValue || 0) - (p.exchangeItemsValue || 0)
    );
    if (remaining > base) {
      base = remaining;
      basis = "order_emptied_remaining";
    }
  }
  // Ce que la règle 2 ajoute au-delà des articles est par nature de l'avoir.
  const extra = round2(Math.max(0, base - V - C));

  // Part carte : issue des seuls articles remboursés, dans la limite de ce qui
  // a réellement été payé en carte et n'a pas déjà été réglé.
  const cashLeft = round2(Math.max(0, cashPaid - (p.cashAlreadySettled || 0)));
  const cashBeforeFee = round2(Math.min(V, cashLeft));
  // Décision D1 : les frais sont retenus SUR LA PART CARTE en priorité.
  const feeOnCash = round2(Math.min(cashBeforeFee, fee));
  const cash = round2(cashBeforeFee - feeOnCash);
  const feeOnAvoir = round2(fee - feeOnCash);

  // Part avoir : le reliquat des articles remboursés (moins le solde de frais
  // que la carte n'a pas absorbé), les articles dont la cliente a demandé un
  // avoir, et le complément de la règle 2.
  const refundInAvoir = round2(Math.max(0, V - cashBeforeFee - feeOnAvoir));
  const avoir = round2(refundInAvoir + C + extra);

  return {
    cash,
    avoir,
    fee,
    feeOnCash,
    feeOnAvoir,
    base: round2(base),
    basis,
    refundItemsValue: V,
    creditItemsValue: C,
  };
}

// Quantités couvertes par des lignes RETURNS.csv (colonnes 2 et 6) + les
// articles du retour en cours ; true si toute la commande est couverte.
// Tient compte des quantités (une ligne ×2 dont 1 seul exemplaire est
// retourné ne "vide" pas la commande).
function coversOrder(orderLines, returnRowsCols, currentItems) {
  const covered = {};
  for (const cols of returnRowsCols) covered[cols[2]] = (covered[cols[2]] || 0) + (parseInt(cols[6], 10) || 1);
  for (const it of currentItems) covered[it.lineItemId] = (covered[it.lineItemId] || 0) + (parseInt(it.quantity, 10) || 1);
  return orderLines.every((l) => (covered[l.id] || 0) >= (l.quantity || 1));
}

module.exports = {
  coversOrder,
  EXCHANGE_CREDIT_TITLES,
  round2,
  isExchangeCreditTitle,
  applicationKey,
  unitValue,
  parseCashAlreadySettled,
  refundsEngaged,
  ETATS_REMBOURSEMENT_ECHOUE,
  returnNumber,
  computeSettlement,
};
