#!/usr/bin/env node
// scripts/test-sav-actions.js
// Dépôt : bbp-webhook
//
// Tests des gestes SAV appelés par la messagerie (21/09/2026). Sans
// dépendance, sans réseau, sans Shopify : on teste le calcul et les
// garde-fous, c'est-à-dire tout ce qui décide COMBIEN part et VERS QUOI.
//
//   node scripts/test-sav-actions.js

const {
  round2,
  montantDuDansLaNote,
  transactionsRemboursables,
  repartirSurTransactions,
  avertissementsCommande,
  erreurDeterministe,
  messageLisible,
  decisionMarquage,
  controleAccesSav,
  avoirsDejaEmis,
  disponibleAvoir,
  GATEWAYS_NON_REMBOURSABLES,
  PLAFOND_AVOIR,
} = require("../lib/sav-actions.cjs");

let echecs = 0;
let reussites = 0;
const verifie = (titre, ok, detail) => {
  if (ok) { reussites += 1; console.log("  ok   " + titre); }
  else { echecs += 1; console.log("  ÉCHEC " + titre + (detail ? "\n        → " + detail : "")); }
};
const groupe = (n) => console.log("\n" + n);

groupe("1. Lecture du montant dû dans la note — même règle que le digest");

// Note telle que api/receive-return.js l'écrit réellement.
const NOTE = `Commande passée le 15/08.
[R-C293832-1-RECEPTION] Retour reçu le 21/09. Remboursement à faire : 113.10 € (carte)
[R-C293832-1-RECEPTION] Avoir 40.50 € (carte cadeau) NON ÉMIS — droit manquant`;

const du = montantDuDansLaNote(NOTE);
verifie("le remboursement annoncé est lu", du.refund === 113.1, String(du.refund));
verifie("l'avoir non émis est lu", du.avoir === 40.5, String(du.avoir));

verifie("une ligne déjà soldée n'est plus comptée",
  montantDuDansLaNote("[R-1-RECEPTION] Remboursement FAIT le 21/09/2026 : 113.10 € (carte)").refund === 0);
verifie("un avoir déjà émis n'est pas recompté",
  montantDuDansLaNote("Avoir 40.50 € émis (AVXXXX)").avoir === 0);
verifie("deux retours sur la même commande s'additionnent",
  montantDuDansLaNote("Remboursement à faire : 10.00 €\nRemboursement à faire : 5.50 €").refund === 15.5);
verifie("une note vide ne donne rien", montantDuDansLaNote("").refund === 0 && montantDuDansLaNote(null).avoir === 0);

groupe("2. Ce qui est remboursable — le cœur du correctif du 18/09");

const tx = (kind, status, gateway, amount, parentId) => ({
  id: `gid://shopify/OrderTransaction/${Math.random().toString(36).slice(2)}`,
  kind, status, gateway,
  parentTransaction: parentId ? { id: parentId } : null,
  amountSet: { shopMoney: { amount: String(amount), currencyCode: "EUR" } },
});

const carte = transactionsRemboursables({
  transactions: [tx("SALE", "SUCCESS", "shopify_payments", 119)],
  totalRefundedSet: { shopMoney: { amount: "0.00" } },
});
verifie("un paiement carte est remboursable", carte.disponible === 119, String(carte.disponible));

// C295029, cas réel du 18/09 : 119 € réglés entièrement en carte cadeau.
// Zéro euro encaissé. Rembourser en virement serait rendre de l'argent réel
// contre du crédit magasin.
const avoirSeul = transactionsRemboursables({
  transactions: [tx("SALE", "SUCCESS", "gift_card", 119)],
  totalRefundedSet: { shopMoney: { amount: "0.00" } },
});
verifie("une commande payée en carte cadeau n'est PAS remboursable en virement",
  avoirSeul.disponible === 0 && avoirSeul.payantes.length === 0, String(avoirSeul.disponible));

const mixte = transactionsRemboursables({
  transactions: [tx("SALE", "SUCCESS", "gift_card", 100), tx("SALE", "SUCCESS", "shopify_payments", 19)],
  totalRefundedSet: { shopMoney: { amount: "0.00" } },
});
verifie("sur un paiement mixte, seule la part carte est remboursable",
  mixte.disponible === 19, String(mixte.disponible));

const dejaRendu = transactionsRemboursables({
  transactions: [tx("SALE", "SUCCESS", "shopify_payments", 119)],
  totalRefundedSet: { shopMoney: { amount: "50.00" } },
});
verifie("ce qui a déjà été remboursé est déduit", dejaRendu.disponible === 69, String(dejaRendu.disponible));

verifie("un remboursement ne peut pas dépasser l'encaissé",
  transactionsRemboursables({
    transactions: [tx("SALE", "SUCCESS", "shopify_payments", 50)],
    totalRefundedSet: { shopMoney: { amount: "50.00" } },
  }).disponible === 0);

const echouee = transactionsRemboursables({
  transactions: [tx("SALE", "FAILURE", "shopify_payments", 119)],
  totalRefundedSet: { shopMoney: { amount: "0.00" } },
});
verifie("une transaction échouée ne compte pas", echouee.disponible === 0);

const autorisation = transactionsRemboursables({
  transactions: [tx("AUTHORIZATION", "SUCCESS", "shopify_payments", 119)],
  totalRefundedSet: { shopMoney: { amount: "0.00" } },
});
verifie("une simple autorisation (non capturée) ne compte pas", autorisation.disponible === 0);

verifie("store_credit est aussi exclu", GATEWAYS_NON_REMBOURSABLES.has("store_credit"));
verifie("shopify_store_credit (nom réel Shopify) est aussi exclu", GATEWAYS_NON_REMBOURSABLES.has("shopify_store_credit"));

// Durcissement du 21/09 : un paiement ne peut rendre que ce qu'il lui reste.
// Une commande réglée en deux fois, déjà remboursée sur l'un des deux, laissait
// proposer un montant que Shopify aurait refusé au dernier moment.
const paiementA = tx("SALE", "SUCCESS", "shopify_payments", 80);
const partiel = transactionsRemboursables({
  transactions: [
    paiementA,
    tx("SALE", "SUCCESS", "paypal", 39),
    tx("REFUND", "SUCCESS", "shopify_payments", 60, paiementA.id),
  ],
  totalRefundedSet: { shopMoney: { amount: "60.00" } },
});
verifie("un remboursement déjà passé est déduit du paiement concerné",
  partiel.restantParPaiement === 59, String(partiel.restantParPaiement));
verifie("le disponible retient la borne la plus basse des deux",
  partiel.disponible === 59, String(partiel.disponible));

const toutRendu = transactionsRemboursables({
  transactions: [paiementA, tx("REFUND", "SUCCESS", "shopify_payments", 80, paiementA.id)],
  totalRefundedSet: { shopMoney: { amount: "80.00" } },
});
verifie("un paiement entièrement rendu sort de la liste",
  toutRendu.payantes.length === 0 && toutRendu.disponible === 0);

// Premier remboursement réel (C295145, 21/09) : la transaction REFUND reste
// PENDING plusieurs jours et totalRefundedSet vaut toujours 0 pendant ce
// temps. Les deux bornes voyaient donc 69,90 € disponibles sur une commande
// dont 23,10 € étaient déjà partis.
const salePending = tx("SALE", "SUCCESS", "shopify_payments", 69.9);
const enAttente = transactionsRemboursables({
  transactions: [salePending, tx("REFUND", "PENDING", "shopify_payments", 23.1, salePending.id)],
  totalRefundedSet: { shopMoney: { amount: "0.0" } },
});
verifie("un remboursement PENDING est de l'argent engagé : il est déduit",
  enAttente.disponible === 46.8, String(enAttente.disponible));
verifie("le montant en attente est affichable à part",
  enAttente.rembourse_en_attente === 23.1, String(enAttente.rembourse_en_attente));

const echec = transactionsRemboursables({
  transactions: [salePending, tx("REFUND", "FAILURE", "shopify_payments", 23.1, salePending.id)],
  totalRefundedSet: { shopMoney: { amount: "0.0" } },
});
verifie("un remboursement ÉCHOUÉ ne se déduit pas — l'argent n'est pas parti",
  echec.disponible === 69.9, String(echec.disponible));

groupe("3. Répartition sur plusieurs transactions");

// Depuis la revue du 21/09, le test importe la VRAIE fonction. Il en gardait
// une copie, donc il validait sa copie et pas le code qui tourne.
const repartir = (payantes, demande) => {
  const { parts, reste } = repartirSurTransactions(payantes, demande);
  return { transactions: parts.map((p) => ({ gateway: p.gateway, amount: p.amount })), reste };
};

const deuxPaiements = [tx("SALE", "SUCCESS", "shopify_payments", 80), tx("SALE", "SUCCESS", "paypal", 39)];
const r1 = repartir(deuxPaiements, 100);
verifie("100 € se répartissent sur les deux paiements",
  r1.reste === 0 && r1.transactions.length === 2, JSON.stringify(r1.transactions));
verifie("la plus grosse transaction est servie en premier",
  r1.transactions[0].amount === "80.00" && r1.transactions[1].amount === "20.00",
  JSON.stringify(r1.transactions));

const r2 = repartir(deuxPaiements, 50);
verifie("un montant qui tient sur une seule transaction n'en touche qu'une",
  r2.transactions.length === 1 && r2.transactions[0].amount === "50.00");

const r3 = repartir(deuxPaiements, 200);
verifie("un montant trop grand laisse un reste — et la route refuse alors",
  r3.reste > 0, String(r3.reste));

// La répartition doit suivre le restant, pas le montant brut encaissé.
const r4 = repartirSurTransactions(partiel.payantes, 59);
verifie("la répartition ne dépasse pas ce qui reste sur chaque paiement",
  r4.reste === 0
    && r4.parts.every((p) => parseFloat(p.amount) <= p.transaction.restant + 0.001),
  JSON.stringify(r4.parts.map((p) => [p.gateway, p.amount, p.transaction.restant])));
verifie("le paiement le plus garni est servi en premier, restant compris",
  r4.parts[0].gateway === "paypal" && r4.parts[0].amount === "39.00",
  JSON.stringify(r4.parts.map((p) => [p.gateway, p.amount])));

groupe("3 bis. Ce que le GET doit afficher en rouge avant le bouton");

verifie("une commande annulée est signalée",
  avertissementsCommande({ cancelledAt: "2026-09-01T10:00:00Z" }).some((a) => /ANNUL/.test(a)));
verifie("un remboursement partiel déjà passé est signalé",
  avertissementsCommande({ displayFinancialStatus: "PARTIALLY_REFUNDED" }).length === 1);
verifie("une commande saine ne produit aucun avertissement",
  avertissementsCommande({ displayFinancialStatus: "PAID" }).length === 0);
verifie("le plafond d'avoir est une constante du serveur", PLAFOND_AVOIR > 0);
// Demande de Luc, 21/09 : 300 € maximum. Une carte cadeau est de l'argent au
// porteur, et c'est le SEUL garde-fou sur son montant — rien ne la borne par
// ce que la cliente a payé ni par ce qu'elle a renvoyé.
verifie("le plafond d'avoir est bien de 300 €", PLAFOND_AVOIR === 300, String(PLAFOND_AVOIR));
// L'appelant ne peut qu'abaisser : Math.min(demandé, PLAFOND_AVOIR).
const plafondEffectif = (demandeParAppelant) => Math.min(demandeParAppelant || PLAFOND_AVOIR, PLAFOND_AVOIR);
verifie("un appelant peut abaisser le plafond", plafondEffectif(50) === 50);
verifie("un appelant NE PEUT PAS le lever", plafondEffectif(99999) === 300, String(plafondEffectif(99999)));
verifie("sans valeur fournie, c'est le plafond du serveur", plafondEffectif(undefined) === 300);

groupe("3 ter. Marquage de la note — le reste dû ne doit jamais disparaître");

// Avant la revue du 21/09, le /g soldait TOUTES les lignes et le tag partait
// sans condition : un acompte effaçait le reste de la note ET du digest.
const NOTE_DEUX = "[R-1-RECEPTION] Remboursement à faire : 100.00 € (carte)\n"
  + "[R-2-RECEPTION] Remboursement à faire : 50.00 € (carte)";

const acompte = decisionMarquage(NOTE_DEUX, 100, "21/09/2026");
verifie("un acompte n'est pas un solde", acompte.soldeTotal === false);
verifie("le reste dû est calculé", acompte.reste === 50, String(acompte.reste));
verifie("un acompte GARDE le tag du digest", acompte.retirerTag === false);
verifie("un acompte n'efface aucune ligne « à faire »",
  (acompte.note.match(/Remboursement à faire : /g) || []).length === 2,
  acompte.note);
verifie("un acompte écrit ce qui reste", /reste 50\.00 € à faire/.test(acompte.note), acompte.note);

const solde = decisionMarquage(NOTE_DEUX, 150, "21/09/2026");
verifie("un remboursement complet solde", solde.soldeTotal === true && solde.reste === 0);
verifie("un solde réécrit toutes les lignes",
  !/Remboursement à faire : /.test(solde.note)
    && (solde.note.match(/Remboursement FAIT le 21\/09\/2026 : /g) || []).length === 2,
  solde.note);
verifie("un solde retire le tag", solde.retirerTag === true);

verifie("un centime de moins que l'annoncé reste un acompte",
  decisionMarquage("Remboursement à faire : 100.00 €", 99.99, "21/09/2026").soldeTotal === false);
verifie("l'égalité au centime près solde",
  decisionMarquage("Remboursement à faire : 100.00 €", 100, "21/09/2026").soldeTotal === true);
verifie("un geste commercial sur une note sans annonce solde",
  decisionMarquage("Commande passée le 15/08.", 20, "21/09/2026").soldeTotal === true);

groupe("3 quater. Refus net de Shopify ≠ résultat incertain");

// Premier essai réel du 21/09 : Shopify a refusé faute de directive
// @idempotent (obligatoire sur refundCreate depuis l'API 2026-04). Comme
// lib/shopify.js jette aussi sur userErrors, ce refus PROPRE tombait dans le
// filet des coupures réseau et ressortait en « incertain — va vérifier dans
// Shopify ». Alors qu'on savait de façon certaine que rien n'était parti.
const ERREUR_IDEMPOTENT = 'Erreur GraphQL Shopify: [{"message":"The @idempotent directive is '
  + 'required for this mutation but was not provided.","locations":[{"line":2,"column":10}],'
  + '"extensions":{"code":"BAD_REQUEST"},"path":["refundCreate"]}]';

verifie("un BAD_REQUEST est un refus, pas un doute", erreurDeterministe(ERREUR_IDEMPOTENT) === true);
verifie("le message rendu est lisible, pas du JSON",
  messageLisible(ERREUR_IDEMPOTENT) === "The @idempotent directive is required for this mutation but was not provided.",
  messageLisible(ERREUR_IDEMPOTENT));

verifie("un userErrors est un refus",
  erreurDeterministe('userErrors Shopify: {"refundCreate":{"userErrors":[{"message":"Non"}]}}') === true);
verifie("un droit manquant est un refus",
  erreurDeterministe('Erreur GraphQL Shopify: [{"message":"nope","extensions":{"code":"ACCESS_DENIED"}}]') === true);

verifie("une coupure réseau reste INCERTAINE — on ne prétend pas savoir",
  erreurDeterministe("fetch failed") === false);
verifie("un 502 de passage reste incertain",
  erreurDeterministe("Erreur GraphQL Shopify: [{\"message\":\"Internal error\"}]") === false);
verifie("un message non JSON ne fait pas planter la lecture",
  messageLisible("fetch failed") === "fetch failed");

groupe("3 quinquies. Accès aux routes d'argent — en-tête uniquement");

// Signalé par la revue du portail le 21/09 : checkAdminToken accepte aussi
// « ?token=<secret> ». Pratique pour les liens du digest, inacceptable sur une
// route qui déplace de l'argent — une URL finit dans les journaux d'accès,
// dans le Referer et dans l'historique du navigateur.
const AVANT = process.env.SAV_ACTIONS_SECRET;
process.env.SAV_ACTIONS_SECRET = "secret-de-test";

const entete = (v) => ({ headers: { authorization: v }, query: {} });

verifie("le bon secret en en-tête passe",
  controleAccesSav(entete("Bearer secret-de-test")) === null);
verifie("un mauvais secret est refusé",
  controleAccesSav(entete("Bearer pas-le-bon"))?.status === 403);
verifie("aucun en-tête est refusé",
  controleAccesSav({ headers: {}, query: {} })?.status === 403);
verifie("un secret « Basic » ne passe pas pour un Bearer",
  controleAccesSav(entete("Basic secret-de-test"))?.status === 403);

// Même JUSTE, un secret passé en URL est refusé : s'il a voyagé là, il est
// déjà compromis.
const parUrl = controleAccesSav({ headers: {}, query: { token: "secret-de-test" } });
verifie("le secret en paramètre d'URL est REFUSÉ, même correct",
  parUrl?.status === 400 && parUrl.error === "secret_en_parametre_url", JSON.stringify(parUrl));
verifie("un ?token= invalide ne fuite pas la raison du refus",
  controleAccesSav({ headers: { authorization: "Bearer secret-de-test" }, query: { token: "x" } })?.status === 400);

delete process.env.SAV_ACTIONS_SECRET;
verifie("variable absente : fermé (503), jamais ouvert",
  controleAccesSav(entete("Bearer quoi-que-ce-soit"))?.status === 503);
if (AVANT === undefined) delete process.env.SAV_ACTIONS_SECRET;
else process.env.SAV_ACTIONS_SECRET = AVANT;

groupe("4. Arrondis");

verifie("les centimes ne dérivent pas", round2(113.104) === 113.1 && round2(113.105) === 113.11);
verifie("0.1 + 0.2 ne donne pas 0.30000000000000004", round2(0.1 + 0.2) === 0.3);

groupe("3 sexies. Poussée vers la messagerie");

// Vérifié en base le 21/09 : `return_cases` contenait ZÉRO ligne. Les deux
// secrets étaient posés, l'endpoint de réception existait, mais personne
// n'appelait. D'où lib/notify-messagerie.js.
const { notifierMessagerie, _internal: interneNotif } = require("../lib/notify-messagerie.cjs");

const SAUVE = {
  base: process.env.MESSAGERIE_BASE_URL,
  secret: process.env.RETURNS_WEBHOOK_SECRET,
};
delete process.env.MESSAGERIE_BASE_URL;
delete process.env.RETURNS_WEBHOOK_SECRET;

(async () => {
  const sansConfig = await notifierMessagerie({ return_id: "R-1" });
  verifie("sans configuration, on ne tente rien et on ne jette pas",
    sansConfig.sent === false && sansConfig.error === "messagerie_non_configuree",
    JSON.stringify(sansConfig));

  process.env.MESSAGERIE_BASE_URL = "https://exemple.invalid/";
  process.env.RETURNS_WEBHOOK_SECRET = "secret";
  verifie("la barre finale de l'URL est retirée",
    interneNotif.configuration().base === "https://exemple.invalid");
  verifie("le délai est borné", interneNotif.DELAI_MS > 0 && interneNotif.DELAI_MS <= 10000);

  const sansId = await notifierMessagerie({ order_number: "C1" });
  verifie("un retour sans identifiant est refusé avant tout appel réseau",
    sansId.sent === false && sansId.error === "return_id_manquant");

  // Hôte injoignable : la fonction doit rendre la main proprement.
  const injoignable = await notifierMessagerie({ return_id: "R-1" });
  verifie("un hôte injoignable ne fait pas échouer le retour",
    injoignable.sent === false && typeof injoignable.error === "string",
    JSON.stringify(injoignable));

  if (SAUVE.base === undefined) delete process.env.MESSAGERIE_BASE_URL;
  else process.env.MESSAGERIE_BASE_URL = SAUVE.base;
  if (SAUVE.secret === undefined) delete process.env.RETURNS_WEBHOOK_SECRET;
  else process.env.RETURNS_WEBHOOK_SECRET = SAUVE.secret;


groupe("9. Plafond d'avoir — règle du 22/09 : jamais plus que la commande");

// Fabrique une commande minimale : total, encaissements, remboursements,
// témoins d'avoir. Les formes sont celles que renvoie ORDER_QUERY.
function commande({ total, transactions = [], rembourseGlobal = 0, avoirs = [] }) {
  return {
    currentTotalPriceSet: { shopMoney: { amount: String(total), currencyCode: "EUR" } },
    totalRefundedSet: { shopMoney: { amount: String(rembourseGlobal) } },
    transactions,
    metafields: {
      edges: avoirs.map(([key, value]) => ({ node: { key, value: typeof value === "string" ? value : JSON.stringify(value) } })),
    },
  };
}
const vente = (id, montant) => ({ id, kind: "SALE", status: "SUCCESS", gateway: "shopify_payments", amountSet: { shopMoney: { amount: String(montant), currencyCode: "EUR" } } });
const remb = (id, parent, montant, status = "SUCCESS") => ({ id, kind: "REFUND", status, gateway: "shopify_payments", parentTransaction: { id: parent }, amountSet: { shopMoney: { amount: String(montant), currencyCode: "EUR" } } });

// --- Somme des avoirs déjà émis ---
const a1 = avoirsDejaEmis(commande({
  total: 69.9,
  avoirs: [
    ["avoir_R-C295145-1", { code: "AVYAMF6YBQ7769WZ", amount: 19 }],
    ["avoir_SAV-C295145-av-xxx", { code: "AVAH8UJSX7MUTDHZ", amount: 200 }],
    ["sav_refund_ref-zzz", { amount: 23.1 }],
  ],
}));
verifie("seuls les témoins avoir_* sont comptés, pas les témoins de remboursement",
  a1.total === 219 && a1.details.length === 2, JSON.stringify(a1));

const a2 = avoirsDejaEmis(commande({ total: 50, avoirs: [["avoir_x", "{ceci n'est pas du json"]] }));
verifie("un témoin illisible est signalé, jamais compté comme zéro",
  a2.total === 0 && a2.illisibles.length === 1, JSON.stringify(a2));

verifie("une commande sans métachamp ne casse rien",
  avoirsDejaEmis({}).total === 0);

// --- Le cas réel du 22/09 sur C295145 ---
const c295145 = commande({
  total: 69.9,
  transactions: [vente("t1", 69.9), remb("r1", "t1", 23.1, "PENDING")],
  rembourseGlobal: 0,
  avoirs: [["avoir_R-C295145-1", { amount: 19 }]],
});
const b = disponibleAvoir(c295145);
verifie("C295145 : le remboursement PENDING de 23,10 € est bien déduit",
  b.rembourse === 23.1, JSON.stringify(b));
verifie("C295145 : l'avoir de 19 € déjà émis est bien déduit",
  b.avoirs_deja_emis === 19);
verifie("C295145 : disponible = 69,90 − 23,10 − 19 = 27,80 €",
  b.disponible === 27.8, JSON.stringify(b));
verifie("C295145 : le plafond effectif est le disponible, pas les 300 €",
  b.plafond === 27.8);
verifie("C295145 : les 200 € émis le 22/09 auraient été refusés",
  200 > b.plafond);

// --- Le plafond absolu reste la borne haute ---
const grosse = disponibleAvoir(commande({ total: 900, transactions: [vente("t1", 900)] }));
verifie("sur une grosse commande, c'est PLAFOND_AVOIR qui borne",
  grosse.disponible === 900 && grosse.plafond === PLAFOND_AVOIR, JSON.stringify(grosse));

// --- Commande entièrement restituée ---
const soldee = disponibleAvoir(commande({
  total: 80,
  transactions: [vente("t1", 80), remb("r1", "t1", 80)],
  rembourseGlobal: 80,
}));
verifie("une commande entièrement remboursée ne laisse aucun avoir possible",
  soldee.disponible === 0 && soldee.plafond === 0, JSON.stringify(soldee));

// --- Jamais négatif ---
const surRestituee = disponibleAvoir(commande({
  total: 69.9,
  transactions: [vente("t1", 69.9), remb("r1", "t1", 23.1)],
  rembourseGlobal: 23.1,
  avoirs: [["avoir_a", { amount: 19 }], ["avoir_b", { amount: 200 }]],
}));
verifie("déjà sur-restituée (le cas réel après coup) : disponible plancher à 0, jamais négatif",
  surRestituee.disponible === 0 && surRestituee.restitue === 242.1, JSON.stringify(surRestituee));

// --- Un remboursement échoué ne se déduit pas ---
const echoue = disponibleAvoir(commande({
  total: 100,
  transactions: [vente("t1", 100), remb("r1", "t1", 40, "FAILURE")],
}));
verifie("un remboursement en ÉCHEC n'ampute pas le disponible",
  echoue.disponible === 100, JSON.stringify(echoue));

  bilan();
})();

function bilan() {
  console.log("\n" + (echecs === 0
    ? `Tous les tests passent (${reussites}).`
    : `${echecs} ÉCHEC(S) sur ${reussites + echecs} tests.`));
  process.exit(echecs === 0 ? 0 : 1);
}
