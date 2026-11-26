#!/usr/bin/env node
// scripts/test-settlement.js
// Dépôt : bbp-webhook
//
// « Ce qui a DÉJÀ été rendu sur cette commande » — le terme le plus dangereux
// du calcul de règlement (21/09/2026).
//
// Sous-estimer ce terme ne fait pas sortir d'argent tout seul : le portail
// ne rembourse jamais. Mais il écrit « Remboursement à faire : X € » dans la
// note, repose le tag, et le digest du lendemain demande à Luc de rembourser
// une somme déjà partie. S'il suit l'instruction, c'est un double
// remboursement — fait à la main, sur une consigne fausse.
//
// Les données de ce fichier sont RÉELLES : commande C295145, 21/09/2026.
//
//   node scripts/test-settlement.js

const {
  parseCashAlreadySettled,
  refundsEngaged,
  computeSettlement,
  round2,
} = require("../lib/settlement.cjs");

let echecs = 0;
let reussites = 0;
const verifie = (titre, ok, detail) => {
  if (ok) { reussites += 1; console.log("  ok   " + titre); }
  else { echecs += 1; console.log("  ÉCHEC " + titre + (detail ? "\n        → " + detail : "")); }
};
const groupe = (n) => console.log("\n" + n);

// Note de C295145 telle qu'elle est en production, APRÈS le remboursement
// exécuté depuis la messagerie à 15h15.
const NOTE_C295145 = `
[R-C295145-1] Retour demandé le 2026-09-21 — étiquette XT269234252TS — 3 article(s)
[R-C295145-1-RECEPTION] Reçu le 2026-09-21 — statut RECEIVED — Conforme à l'annoncé. — Règlement : Remboursement FAIT le 21/09/2026 : 23.10 € (carte) / Avoir 19.00 €, dont 19.00 € d'avoir demandé par la cliente : nouvelle carte cadeau émise (AVYAMF6YBQ7769WZ, valable jusqu'au 2027-03-21)
[SAV 21/09/2026] Remboursement de 23.10 € exécuté depuis la messagerie.

Rise.ai updated the order's reward due to refund`;

groupe("1. Note de commande — une ligne soldée reste de l'argent rendu");

verifie("une ligne « Remboursement FAIT le … » est comptée",
  parseCashAlreadySettled(NOTE_C295145, "R-C295145-2") === 23.1,
  String(parseCashAlreadySettled(NOTE_C295145, "R-C295145-2")));

verifie("une ligne « Remboursement à faire » l'est toujours aussi",
  parseCashAlreadySettled(
    "[R-C1-RECEPTION] Reçu — Règlement : Remboursement à faire : 19.00 € (carte)", "R-C1-2") === 19);

verifie("le retour EN COURS ne se compte pas lui-même",
  parseCashAlreadySettled(NOTE_C295145, "R-C295145-1") === 0,
  String(parseCashAlreadySettled(NOTE_C295145, "R-C295145-1")));

verifie("la ligne [SAV …] de la messagerie n'est PAS comptée en double",
  parseCashAlreadySettled(
    "[SAV 21/09/2026] Remboursement de 23.10 € exécuté depuis la messagerie.", "R-X-1") === 0);

verifie("deux réceptions s'additionnent",
  parseCashAlreadySettled(
    "[R-C1-RECEPTION] Remboursement FAIT le 21/09/2026 : 10.00 €\n" +
    "[R-C2-RECEPTION] Remboursement à faire : 5.50 €", "R-C3") === 15.5);

verifie("une note vide ne donne rien",
  parseCashAlreadySettled("", "R-X") === 0 && parseCashAlreadySettled(null, "R-X") === 0);

groupe("2. Transactions — un remboursement PENDING est de l'argent parti");

// État réel de C295145 : REFUND 23,10 € en PENDING, totalRefundedSet à 0,00 €.
const TX_C295145 = {
  totalRefundedSet: { shopMoney: { amount: "0.0" } },
  transactions: [
    { kind: "SALE", status: "SUCCESS", gateway: "shopify_payments", amountSet: { shopMoney: { amount: "69.9" } } },
    { kind: "REFUND", status: "PENDING", gateway: "shopify_payments", amountSet: { shopMoney: { amount: "23.1" } } },
  ],
};

verifie("un REFUND PENDING compte, alors que totalRefundedSet dit 0",
  refundsEngaged(TX_C295145) === 23.1 &&
  parseFloat(TX_C295145.totalRefundedSet.shopMoney.amount) === 0,
  String(refundsEngaged(TX_C295145)));

verifie("un REFUND SUCCESS compte",
  refundsEngaged({ transactions: [
    { kind: "REFUND", status: "SUCCESS", amountSet: { shopMoney: { amount: "50.00" } } }] }) === 50);

verifie("un REFUND en échec ne compte pas",
  refundsEngaged({ transactions: [
    { kind: "REFUND", status: "FAILURE", amountSet: { shopMoney: { amount: "50.00" } } }] }) === 0);

verifie("un SALE n'est pas un remboursement",
  refundsEngaged({ transactions: [
    { kind: "SALE", status: "SUCCESS", amountSet: { shopMoney: { amount: "69.90" } } }] }) === 0);

verifie("plusieurs remboursements s'additionnent",
  refundsEngaged({ transactions: [
    { kind: "REFUND", status: "PENDING", amountSet: { shopMoney: { amount: "10.00" } } },
    { kind: "REFUND", status: "SUCCESS", amountSet: { shopMoney: { amount: "5.50" } } },
    { kind: "REFUND", status: "ERROR", amountSet: { shopMoney: { amount: "99.00" } } }] }) === 15.5);

verifie("une commande sans transaction ne plante pas",
  refundsEngaged({}) === 0 && refundsEngaged(null) === 0);

groupe("3. Le scénario complet — deuxième retour sur C295145");

// La cliente renvoie un 4e article de la même commande pendant que les
// 23,10 € sont encore PENDING. cashPaid = 69,90 € (tout en carte).
const cashAlreadySettled = Math.max(
  parseCashAlreadySettled(NOTE_C295145, "R-C295145-2"),
  parseFloat(TX_C295145.totalRefundedSet.shopMoney.amount),
  refundsEngaged(TX_C295145)
);
verifie("le terme « déjà réglé » vaut 23,10 € et non 0", cashAlreadySettled === 23.1, String(cashAlreadySettled));

const avecCorrectif = computeSettlement({
  refundItemsValue: 29, creditItemsValue: 0, emptiesOrder: false,
  avoirPaid: 0, cashPaid: 69.9, previouslyReturnedValue: 0,
  exchangeItemsValue: 0, cashAlreadySettled, fee: 5.9,
});
const sansCorrectif = computeSettlement({
  refundItemsValue: 29, creditItemsValue: 0, emptiesOrder: false,
  avoirPaid: 0, cashPaid: 69.9, previouslyReturnedValue: 0,
  exchangeItemsValue: 0, cashAlreadySettled: 0, fee: 5.9,
});
verifie("avec le correctif, la part carte est bornée par ce qui reste (69,90 − 23,10 = 46,80)",
  avecCorrectif.cash === round2(29 - 5.9), JSON.stringify(avecCorrectif));
verifie("sans le correctif, le calcul partait de 69,90 € encore disponibles",
  sansCorrectif.cash === round2(29 - 5.9), JSON.stringify(sansCorrectif));

// Le cas qui fait vraiment mal : il ne reste presque plus rien en carte.
const presqueEpuise = Math.max(0, 69.9 - 60);
const borne = computeSettlement({
  refundItemsValue: 29, creditItemsValue: 0, emptiesOrder: false,
  avoirPaid: 0, cashPaid: 69.9, previouslyReturnedValue: 0,
  exchangeItemsValue: 0, cashAlreadySettled: 60, fee: 5.9,
});
verifie("60 € déjà rendus : la part carte tombe à ce qui reste, pas à la valeur de l'article",
  borne.cash === round2(presqueEpuise - 5.9), JSON.stringify(borne));
verifie("et le reliquat bascule en avoir, il n'est pas perdu",
  round2(borne.cash + borne.avoir + borne.fee) === 29, JSON.stringify(borne));
verifie("l'erreur, si elle survenait, annoncerait TROP de carte et TROP PEU d'avoir",
  sansCorrectif.cash >= borne.cash && sansCorrectif.avoir <= borne.avoir);

console.log("\n" + (echecs === 0
  ? `Tous les tests passent (${reussites}).`
  : `${echecs} ÉCHEC(S) sur ${reussites + echecs} tests.`));
process.exit(echecs === 0 ? 0 : 1);
