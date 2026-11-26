#!/usr/bin/env node
// scripts/test-order-payments.js
// Dépôt : bbp-webhook
//
// LE NET CARTE CADEAU (22/09/2026) — dernier angle mort de la même famille.
//
// Le 21/09, `cashAlreadySettled` sous-estimait ce qui avait déjà été rendu
// parce qu'un remboursement carte reste PENDING plusieurs jours. Le même
// défaut vivait encore dans `lib/order-payments.js` ligne 69 : le net carte
// cadeau n'acceptait que les transactions `SUCCESS`, REFUND compris.
//
// Pourquoi ça compte. `giftCardPaidFromTransactions()` décide du partage
// entre `avoirPaid` et `cashPaid`, donc de ce qu'une cliente reçoit EN ARGENT
// RÉEL au retour suivant. Un REFUND carte cadeau ignoré laisse le net trop
// haut : on croit que la commande a été payée en avoir plus qu'elle ne l'a
// été, et la part carte à rembourser est calculée trop basse.
//
// Ces tests ne touchent pas le réseau.
//
//   node scripts/test-order-payments.js

const { analyzeOrderPayments } = require("../lib/order-payments.cjs");
const { round2 } = require("../lib/settlement.cjs");

let echecs = 0;
let reussites = 0;
const verifie = (titre, ok, detail) => {
  if (ok) { reussites += 1; console.log("  ok   " + titre); }
  else { echecs += 1; console.log("  ÉCHEC " + titre + (detail ? "\n        → " + detail : "")); }
};
const groupe = (n) => console.log("\n" + n);

// Un GraphQL qui n'est jamais appelé : aucune commande de ces tests n'a de
// code de réduction à résoudre. S'il était appelé, le test échouerait — c'est
// voulu, ça signalerait un changement de comportement du module.
const graphqlInterdit = async () => {
  throw new Error("aucun appel réseau ne doit être nécessaire dans ces tests");
};

function tx(gateway, kind, status, amount) {
  return { gateway, kind, status, amountSet: { shopMoney: { amount: String(amount) } } };
}

function commande({ subtotal, transactions }) {
  return {
    id: "gid://shopify/Order/1",
    name: "C999999",
    tags: [],
    subtotalPriceSet: { shopMoney: { amount: String(subtotal) } },
    paymentGatewayNames: ["gift_card"],
    transactions,
    discountApplications: { edges: [] },
    lineItems: { edges: [] },
  };
}

async function analyser(order) {
  return analyzeOrderPayments(graphqlInterdit, order, { onError: () => {} });
}

(async () => {
  groupe("1. Le cas qui motive le correctif — REFUND carte cadeau PENDING");

  // 100 € payés intégralement en carte cadeau, puis 30 € remboursés sur cette
  // même carte. Le remboursement est PENDING, comme Shopify le laisse
  // plusieurs jours.
  const pending = await analyser(commande({
    subtotal: 100,
    transactions: [
      tx("gift_card", "SALE", "SUCCESS", 100),
      tx("gift_card", "REFUND", "PENDING", 30),
    ],
  }));
  verifie("un REFUND PENDING est soustrait du net carte cadeau",
    pending.giftCardPaid === 70, JSON.stringify(pending.giftCardPaid));
  verifie("avoirPaid suit le net corrigé",
    pending.avoirPaid === 70, JSON.stringify(pending.avoirPaid));
  verifie("et les 30 € libérés retombent bien en part carte",
    pending.cashPaid === 30, JSON.stringify(pending.cashPaid));
  verifie("avoirPaid + cashPaid couvrent exactement le sous-total",
    round2(pending.avoirPaid + pending.cashPaid) === 100);

  groupe("2. Les états de REFUND, un par un");

  for (const etat of ["SUCCESS", "PENDING", ""]) {
    const r = await analyser(commande({
      subtotal: 100,
      transactions: [tx("gift_card", "SALE", "SUCCESS", 100), tx("gift_card", "REFUND", etat, 40)],
    }));
    verifie(`REFUND ${etat || "(sans statut)"} : compté comme argent sorti`,
      r.giftCardPaid === 60, JSON.stringify(r.giftCardPaid));
  }
  for (const etat of ["FAILURE", "ERROR", "UNKNOWN"]) {
    const r = await analyser(commande({
      subtotal: 100,
      transactions: [tx("gift_card", "SALE", "SUCCESS", 100), tx("gift_card", "REFUND", etat, 40)],
    }));
    verifie(`REFUND ${etat} : ignoré, aucun argent n'est sorti`,
      r.giftCardPaid === 100, JSON.stringify(r.giftCardPaid));
  }

  groupe("3. Les encaissements restent stricts");

  // Un encaissement non abouti ne doit PAS compter : rien n'a été prélevé.
  const ventePending = await analyser(commande({
    subtotal: 100,
    transactions: [tx("gift_card", "SALE", "PENDING", 100)],
  }));
  verifie("une vente PENDING ne compte pas comme payée",
    ventePending.giftCardPaid === 0, JSON.stringify(ventePending.giftCardPaid));
  verifie("toute la commande est alors considérée payée en carte",
    ventePending.cashPaid === 100, JSON.stringify(ventePending.cashPaid));

  const venteEchouee = await analyser(commande({
    subtotal: 100,
    transactions: [tx("gift_card", "SALE", "FAILURE", 100)],
  }));
  verifie("une vente en échec ne compte pas non plus",
    venteEchouee.giftCardPaid === 0, JSON.stringify(venteEchouee.giftCardPaid));

  groupe("4. Ce qui ne devait pas changer");

  const autreMoyen = await analyser(commande({
    subtotal: 100,
    transactions: [
      tx("shopify_payments", "SALE", "SUCCESS", 100),
      tx("shopify_payments", "REFUND", "PENDING", 50),
    ],
  }));
  verifie("les transactions hors carte cadeau restent ignorées ici",
    autreMoyen.giftCardPaid === 0, JSON.stringify(autreMoyen.giftCardPaid));

  const capture = await analyser(commande({
    subtotal: 100,
    transactions: [
      tx("gift_card", "AUTHORIZATION", "SUCCESS", 100),
      tx("gift_card", "CAPTURE", "SUCCESS", 100),
    ],
  }));
  verifie("AUTHORIZATION reste exclu, pas de double comptage avec CAPTURE",
    capture.giftCardPaid === 100, JSON.stringify(capture.giftCardPaid));

  const plusQuePaye = await analyser(commande({
    subtotal: 100,
    transactions: [
      tx("gift_card", "SALE", "SUCCESS", 100),
      tx("gift_card", "REFUND", "PENDING", 150),
    ],
  }));
  verifie("le net ne devient jamais négatif",
    plusQuePaye.giftCardPaid === 0, JSON.stringify(plusQuePaye.giftCardPaid));

  const plafond = await analyser(commande({
    subtotal: 80,
    transactions: [tx("gift_card", "SALE", "SUCCESS", 100)],
  }));
  verifie("la part imputée aux articles reste plafonnée au sous-total (la carte a pu payer la livraison)",
    plafond.giftCardPaidOnItems === 80 && plafond.cashPaid === 0,
    JSON.stringify({ items: plafond.giftCardPaidOnItems, cash: plafond.cashPaid }));

  groupe("5. Le sens de l'erreur, si le correctif était retiré");

  // Sans le correctif, le REFUND PENDING serait ignoré : net = 100.
  const sansCorrectif = { giftCardPaid: 100, avoirPaid: 100, cashPaid: 0 };
  verifie("l'ancien code surévaluait l'avoir et sous-évaluait la carte",
    sansCorrectif.avoirPaid > pending.avoirPaid && sansCorrectif.cashPaid < pending.cashPaid,
    JSON.stringify({ avant: sansCorrectif, apres: { avoir: pending.avoirPaid, cash: pending.cashPaid } }));

  groupe("6. Échange Baback remboursé ensuite (C294650, échange de C293861 — 23/10)");

  // Reproduction de la vraie commande : 1 article à 39 €, remise manuelle
  // BA-EXCHANGE de 39 €, total 0 €, tags Baback. C293861 payée en carte, sans code.
  const ligne = {
    id: "gid://shopify/LineItem/47011968680285",
    quantity: 1,
    originalUnitPriceSet: { shopMoney: { amount: "39.0" } },
    discountAllocations: [{
      allocatedAmountSet: { shopMoney: { amount: "39.0" } },
      discountApplication: { __typename: "ManualDiscountApplication", title: "BA-EXCHANGE" },
    }],
  };
  const echangeBaback = {
    id: "gid://shopify/Order/17813478932829",
    name: "C294650",
    tags: ["BABACK", "BB_EXCHANGE", "BB_EXCHANGE_C293861", "C293861-R1", "OUTLET", "R-C294650-1", "ZERO"],
    subtotalPriceSet: { shopMoney: { amount: "0.0" } },
    paymentGatewayNames: [],
    transactions: [],
    discountApplications: { edges: [{ node: { __typename: "ManualDiscountApplication", title: "BA-EXCHANGE", value: { __typename: "MoneyV2", amount: "39.0" } } }] },
    lineItems: { edges: [{ node: ligne }] },
  };
  const origineSansCode = async (q, v) => {
    if (/FindOriginalOrderDiscount/.test(q) && v.query === "name:C293861") {
      return { orders: { edges: [{ node: { name: "C293861", discountApplications: { edges: [] } } }] } };
    }
    throw new Error("appel inattendu : " + q.slice(0, 60));
  };
  const pb = await analyzeOrderPayments(origineSansCode, echangeBaback, { onError: () => {} });
  verifie("la commande d'origine est retrouvée par le tag Baback", pb.originalOrderName === "C293861", pb.originalOrderName);
  verifie("l'article vaut 39 € (BA-EXCHANGE est un moyen de paiement, pas une remise)", pb.valueOfLine(ligne.id) === 39, String(pb.valueOfLine(ligne.id)));
  verifie("les 39 € sont de la carte payée sur l'origine", pb.cashPaidOnOriginal === 39 && pb.cashPaid === 39 && pb.cashPaidOnThisOrder === 0,
    JSON.stringify({ orig: pb.cashPaidOnOriginal, cash: pb.cashPaid, ici: pb.cashPaidOnThisOrder }));
  const { computeSettlement } = require("../lib/settlement.cjs");
  const r = computeSettlement({ refundItemsValue: 39, creditItemsValue: 0, emptiesOrder: true, avoirPaid: pb.avoirPaid, cashPaid: pb.cashPaid, previouslyReturnedValue: 0, exchangeItemsValue: 0, cashAlreadySettled: 0, fee: 5.9 });
  verifie("règlement : 33,10 € en carte (39 − 5,90), rien en avoir", r.cash === 33.1 && r.avoir === 0, JSON.stringify(r));

  groupe("7. Tags qui commencent par ECHANGE_ sans être une commande");
  const { originalOrderNameFromTags } = require("../lib/order-payments.cjs");
  verifie("ECHANGE_A_PAYER trié avant ECHANGE_C… n'est pas pris pour l'origine",
    originalOrderNameFromTags(["ECHANGE", "ECHANGE_A_PAYER", "ECHANGE_C295310"]) === "C295310");
  verifie("ECHANGE_DIFFERENCE / ECHANGE_PAIEMENT_SEPARE seuls → aucune origine",
    originalOrderNameFromTags(["ECHANGE_DIFFERENCE", "ECHANGE_PAIEMENT_SEPARE"]) === null);
  verifie("BB_RETURN_EXCHANGE_39.00_EUR n'est pas une origine",
    originalOrderNameFromTags(["BB_RETURN_EXCHANGE", "BB_RETURN_EXCHANGE_39.00_EUR"]) === null);

  console.log("\n" + (echecs === 0
    ? `Tous les tests passent (${reussites}).`
    : `${echecs} ÉCHEC(S) sur ${reussites + echecs} tests.`));
  process.exit(echecs === 0 ? 0 : 1);
})();
