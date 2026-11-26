// lib/order-payments.js
// Dépôt : bbp-webhook
//
// NOUVEAU (audit du 17/09) — analyse des moyens de paiement d'une commande,
// partagée par api/create-return.js et api/receive-return.js.
//
// Avant ce module, les deux fichiers valorisaient différemment la même
// commande :
//  - create-return : prix catalogue du jour (variant.price) et TOUT code à
//    montant fixe compté comme avoir ;
//  - receive-return : prix payé (prix d'origine − codes promo) et seuls les
//    codes à usage unique (usageLimit = 1) comptés comme avoir.
// Conséquence : le crédit accordé à l'échange et le règlement à la réception
// pouvaient ne pas correspondre (ex. commande WELCOME10 + avoir, ou article
// dont le prix a changé depuis l'achat, French Days). Les deux fichiers
// appellent maintenant analyzeOrderPayments().
//
// Ce qui compte comme "avoir" (inchangé par rapport à receive-return du 17/09) :
//  - code à montant fixe avec usageLimit = 1 (avoirs Rise, Baback et autres
//    générateurs : vérifié sur les 50 derniers codes de la boutique le 17/09,
//    tous les codes fixes à usage unique sont des avoirs) ;
//  - code introuvable ou illisible : traité comme avoir, erreur signalée ;
//  - sur une commande d'échange (tag ECHANGE_<origine>), les remises
//    manuelles "Valeur avoir / store credit" / "Valeur article(s)
//    retourné(s)" : moyen de paiement, rendu en avoir si la commande
//    d'origine avait un avoir, en carte sinon ;
//  - CORRECTIF DU 18/09 : une CARTE CADEAU Shopify utilisée en paiement.
//
// ⚠️ Pourquoi ce correctif (à ne jamais re-casser). Jusqu'ici ce module ne
// cherchait un paiement en avoir que dans discountApplications, c'est-à-dire
// dans des CODES DE RÉDUCTION. Or :
//  - depuis le 18/09 un avoir BBP n'est plus un code mais une CARTE CADEAU ;
//  - les crédits de fidélité Rise sont eux aussi des cartes cadeaux.
// Une carte cadeau n'apparaît PAS dans discountApplications : elle est une
// TRANSACTION (gateway "gift_card"), et subtotalPriceSet reste égal à la
// valeur entière des articles. Le module concluait donc avoirPaid = 0 et
// cashPaid = tout le sous-total, soit « la cliente a tout payé par carte ».
// Conséquences, constatées sur la boutique le 18/09 :
//  - C295029, 119 € payés INTÉGRALEMENT en carte cadeau (0 € encaissé) : un
//    retour aurait donné l'ordre « Remboursement à faire : 113,10 € (carte) ».
//    Argent réel rendu pour une commande jamais payée en argent réel.
//  - dans l'autre sens, la règle 2 de settlement.js (le retour qui vide une
//    commande payée en avoir rend tout le solde) ne se déclenchait jamais :
//    la cliente était sous-remboursée.
// 10 des 100 commandes du 12 au 18/09 comportaient un paiement carte cadeau.
//
// Le net carte cadeau se calcule en SOUSTRAYANT les transactions REFUND :
// Shopify produit de vraies séquences SALE → REFUND → SALE du même montant
// (constaté sur C295055 et C295039), et un remboursement déjà rendu sur la
// carte ne doit plus compter comme payé.

const {
  round2,
  isExchangeCreditTitle,
  applicationKey,
  unitValue,
  // CORRECTIF 22/09 : la définition des remboursements qui n'engagent aucun
  // argent existait déjà en double (ETATS_REMBOURSEMENT_ECHOUE côté
  // messagerie, refundsEngaged côté portail). Elle vit désormais en UN SEUL
  // endroit du socle, et ce module la consomme au lieu d'en écrire une
  // troisième version.
  ETATS_REMBOURSEMENT_ECHOUE,
} = require("./settlement.cjs");

function isAccessDenied(err) {
  return /access denied|ACCESS_DENIED|read_discounts/i.test(String(err?.message || err || ""));
}

// Montant NET réglé par carte cadeau sur cette commande, lu dans les
// transactions (gateway "gift_card"). Encaissements moins remboursements,
// transactions en échec ignorées. AUTHORIZATION est volontairement exclu pour
// ne pas compter deux fois une autorisation suivie de sa capture.
const GIFT_CARD_GATEWAY = "gift_card";
const PAYMENT_KINDS = ["SALE", "CAPTURE"];

function giftCardPaidFromTransactions(transactions) {
  let net = 0;
  for (const t of transactions || []) {
    if (String(t.gateway || "") !== GIFT_CARD_GATEWAY) continue;
    const kind = String(t.kind || "").toUpperCase();
    const status = String(t.status || "").toUpperCase();
    const amount = parseFloat(t.amountSet?.shopMoney?.amount || "0");

    if (PAYMENT_KINDS.includes(kind)) {
      // Un ENCAISSEMENT ne compte que s'il a réussi : tant qu'une vente n'est
      // pas SUCCESS, rien n'a été prélevé sur la carte cadeau.
      if (status && status !== "SUCCESS") continue;
      net += amount;
      continue;
    }

    if (kind !== "REFUND") continue;

    // CORRECTIF 22/09 — MÊME ANGLE MORT QUE CELUI CORRIGÉ LE 21/09 SUR
    // `cashAlreadySettled`, ici sur la carte cadeau.
    //
    // L'ancien code exigeait `status === "SUCCESS"` pour TOUTES les
    // transactions, REFUND compris. Or un remboursement reste PENDING
    // plusieurs jours (constaté en vrai sur C295145 : REFUND de 23,10 € posé
    // à 13h15, `totalRefundedSet` encore à 0,00 €). Pendant tout ce temps le
    // remboursement était ignoré, donc le net carte cadeau restait trop haut.
    //
    // Conséquence : `avoirPaid` surévalué et `cashPaid` sous-évalué. Sur un
    // retour suivant, la part carte rendue à la cliente était trop faible et
    // la part avoir trop élevée — la cliente était sous-remboursée en argent
    // réel, exactement le sens d'erreur que le correctif du 21/09 a éliminé
    // ailleurs.
    //
    // Règle désormais alignée sur `refundsEngaged` : tout REFUND qui n'a pas
    // ÉCHOUÉ est de l'argent sorti, ou en train de sortir.
    if (ETATS_REMBOURSEMENT_ECHOUE.has(status)) continue;
    net -= amount;
  }
  return round2(Math.max(0, net));
}

const ORIGINAL_ORDER_TAG = /^(?:ECHANGE|BB_EXCHANGE)_(C?\d+)$/i;

function originalOrderNameFromTags(tags) {
  for (const t of tags || []) {
    const m = String(t).trim().match(ORIGINAL_ORDER_TAG);
    if (m) return m[1].toUpperCase();
  }
  return null;
}

// Champs à inclure dans la requête "order" (au niveau de la commande).
const ORDER_PAYMENT_FIELDS = `
  tags
  subtotalPriceSet { shopMoney { amount } }
  paymentGatewayNames
  transactions(first: 30) {
    gateway
    kind
    status
    amountSet { shopMoney { amount } }
  }
  discountApplications(first: 10) {
    edges {
      node {
        __typename
        ... on DiscountCodeApplication { code }
        ... on ManualDiscountApplication { title }
        value {
          __typename
          ... on MoneyV2 { amount }
        }
      }
    }
  }
`;

// Champs à inclure dans chaque ligne de commande (lineItems.edges.node).
const LINE_ITEM_PAYMENT_FIELDS = `
  quantity
  originalUnitPriceSet { shopMoney { amount } }
  discountAllocations {
    allocatedAmountSet { shopMoney { amount } }
    discountApplication {
      __typename
      ... on DiscountCodeApplication { code }
      ... on ManualDiscountApplication { title }
    }
  }
`;

const LOOKUP_CODE_QUERY = `
  query FindDiscountCode($code: String!) {
    codeDiscountNodeByCode(code: $code) {
      id
      codeDiscount {
        __typename
        ... on DiscountCodeBasic {
          status
          usageLimit
          appliesOncePerCustomer
          customerGets { value { ... on DiscountAmount { amount { amount } } } }
        }
      }
    }
  }
`;

const ORIGINAL_ORDER_QUERY = `
  query FindOriginalOrderDiscount($query: String!) {
    orders(first: 1, query: $query) {
      edges {
        node {
          name
          discountApplications(first: 10) {
            edges { node { __typename ... on DiscountCodeApplication { code } value { __typename ... on MoneyV2 { amount } } } }
          }
        }
      }
    }
  }
`;

// Données d'une ligne, au format attendu par settlement.unitValue.
function toLineInfo(node) {
  return {
    id: node.id,
    quantity: node.quantity || 1,
    originalUnitPrice: node.originalUnitPriceSet?.shopMoney?.amount || node.variant?.price || "0",
    discountAllocations: (node.discountAllocations || []).map((a) => ({
      amount: a.allocatedAmountSet?.shopMoney?.amount || "0",
      application: a.discountApplication || null,
    })),
  };
}

/**
 * @param {Function} shopifyGraphQL
 * @param {object} order  commande avec ORDER_PAYMENT_FIELDS et lineItems (LINE_ITEM_PAYMENT_FIELDS + id)
 * @param {object} [opts]
 * @param {Function} [opts.onError] (label, err) => void
 * @param {boolean} [opts.strict] true : toute erreur de lecture est relancée
 *   (code introuvable = avoir reste la règle ; seule une ERREUR est relancée)
 */
async function analyzeOrderPayments(shopifyGraphQL, order, opts = {}) {
  const onError = opts.onError || (() => {});

  async function classifyCodes(applications) {
    const result = [];
    for (const app of applications) {
      if (app.__typename !== "DiscountCodeApplication" || app.value?.__typename !== "MoneyV2") continue;
      const value = parseFloat(app.value.amount || "0");
      let node = null;
      try {
        const data = await shopifyGraphQL(LOOKUP_CODE_QUERY, { code: app.code });
        node = data?.codeDiscountNodeByCode || null;
      } catch (e) {
        // strict (création d'un retour) : une erreur PASSAGÈRE ne doit pas
        // décider seule du crédit → on remonte l'erreur, la cliente réessaie.
        // Droit read_discounts absent (constaté le 17/09 : l'app ne l'a pas) :
        // l'erreur est permanente, on applique la règle "code illisible =
        // avoir" comme à la réception, pour ne pas bloquer tous les échanges.
        if (opts.strict && !isAccessDenied(e)) throw e;
        onError(`lecture du code ${app.code}`, e);
      }
      const basic = node?.codeDiscount?.__typename === "DiscountCodeBasic" ? node.codeDiscount : null;
      const isAvoir = basic ? basic.usageLimit === 1 : true;
      result.push({ code: app.code, value, isAvoir, node, basic });
    }
    return result;
  }

  const orderApplications = (order.discountApplications?.edges || []).map((e) => e.node);
  const orderCodes = await classifyCodes(orderApplications);

  // Commande d'origine d'un échange :
  //  - portail maison : tag ECHANGE_<origine> ;
  //  - Baback (échanges antérieurs) : tag BB_EXCHANGE_<origine> (23/10, C294650).
  // On n'accepte qu'un NOM de commande (C123456 ou 123456) : les tags
  // ECHANGE_A_PAYER, ECHANGE_DIFFERENCE, ECHANGE_PAIEMENT_SEPARE commencent
  // aussi par "ECHANGE_" et sont triés AVANT ECHANGE_C… par Shopify — l'ancien
  // startsWith() pouvait prendre "A_PAYER" pour la commande d'origine.
  const originalOrderName = originalOrderNameFromTags(order.tags);
  let originalCodes = [];
  if (originalOrderName) {
    try {
      const data = await shopifyGraphQL(ORIGINAL_ORDER_QUERY, { query: `name:${originalOrderName}` });
      const apps = (data?.orders?.edges?.[0]?.node?.discountApplications?.edges || []).map((e) => e.node);
      originalCodes = await classifyCodes(apps);
    } catch (e) {
      if (opts.strict) throw e;
      onError(`lecture de la commande d'origine ${originalOrderName}`, e);
    }
  }
  const originalHasAvoir = originalCodes.some((c) => c.isAvoir);

  const paymentKeys = new Set();
  let avoirPaid = 0;
  let cashPaidExtra = 0;
  for (const c of orderCodes) {
    if (!c.isAvoir) continue;
    paymentKeys.add(applicationKey({ code: c.code }));
    avoirPaid += c.value;
  }
  for (const app of orderApplications) {
    if (app.__typename !== "ManualDiscountApplication" || !isExchangeCreditTitle(app.title)) continue;
    paymentKeys.add(applicationKey({ title: app.title }));
    const value = parseFloat(app.value?.amount || "0");
    if (originalHasAvoir) avoirPaid += value;
    else cashPaidExtra += value;
  }

  const subtotal = round2(parseFloat(order.subtotalPriceSet?.shopMoney?.amount || "0"));

  // Carte cadeau utilisée en paiement (avoir BBP depuis le 18/09, ou crédit
  // Rise) : c'est de l'avoir, et ce n'est donc PAS de la carte bancaire.
  // Plafonné au sous-total : la carte a pu payer aussi la livraison, qui
  // n'entre pas dans cashPaid (lequel ne porte que les articles).
  const giftCardNet = giftCardPaidFromTransactions(order.transactions);
  const giftCardOnItems = round2(Math.min(giftCardNet, subtotal));
  const cashOnItems = round2(Math.max(0, subtotal - giftCardOnItems));

  const lines = {};
  for (const edge of order.lineItems?.edges || []) lines[edge.node.id] = toLineInfo(edge.node);

  return {
    avoirPaid: round2(avoirPaid + giftCardOnItems),
    // Part "carte" : sous-total payé EN ARGENT sur CETTE commande (donc hors
    // carte cadeau) + crédit d'échange venu d'une commande d'origine payée en
    // carte.
    cashPaid: round2(cashOnItems + cashPaidExtra),
    cashPaidOnThisOrder: cashOnItems,
    giftCardPaid: giftCardNet,
    giftCardPaidOnItems: giftCardOnItems,
    cashPaidOnOriginal: round2(cashPaidExtra),
    originalOrderName,
    originalHasAvoir,
    orderCodes,
    originalCodes,
    paymentKeys,
    lines,
    valueOfLine: (lineItemId) => (lines[lineItemId] ? unitValue(lines[lineItemId], paymentKeys) : 0),
  };
}

module.exports = { ORDER_PAYMENT_FIELDS, LINE_ITEM_PAYMENT_FIELDS, analyzeOrderPayments, toLineInfo, originalOrderNameFromTags };
