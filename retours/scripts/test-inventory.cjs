#!/usr/bin/env node
// scripts/test-inventory.cjs
// Dépôt : misu-webhook
//
// Tests de la remise en stock des retours (21/09/2026). Sans réseau, sans
// Shopify : on remplace shopifyGraphQL par un faux et on vérifie ce qui
// compte — sur QUEL emplacement on écrit, COMBIEN, et surtout qu'on
// n'écrit pas deux fois.
//
//   node scripts/test-inventory.cjs

const LOCATION_SHOWROOM_TURBIGO = "gid://shopify/Location/TEST-MISU";
process.env.RESTOCK_LOCATION_ID = LOCATION_SHOWROOM_TURBIGO;
const { restockReceivedItems, resolveRestockLocation } = require("../lib/inventory.cjs");

let echecs = 0;
let reussites = 0;
const verifie = (titre, ok, detail) => {
  if (ok) { reussites += 1; console.log("  ok   " + titre); }
  else { echecs += 1; console.log("  ÉCHEC " + titre + (detail ? "\n        → " + detail : "")); }
};
const groupe = (n) => console.log("\n" + n);

const ITEM_A = "gid://shopify/InventoryItem/21528589041777"; // Rive Gauche GRIS/S
const ITEM_B = "gid://shopify/InventoryItem/39702987178159"; // Sweatshirt GRIS/L
const ORDER = "gid://shopify/Order/17841523327325";

// Faux Shopify : mémorise les appels, sert un témoin optionnel, peut tomber.
function faireFaux({ temoin = null, echecLecture = false, echecAjustement = false } = {}) {
  const appels = [];
  let stocke = temoin;
  const fn = async (query, variables) => {
    appels.push({ query, variables });
    // L'écriture d'abord : « PoseTemoinRestock » contient « TemoinRestock »,
    // tester la lecture en premier attraperait aussi les écritures.
    if (query.includes("PoseTemoinRestock")) {
      stocke = JSON.parse(variables.metafields[0].value);
      return { metafieldsSet: { userErrors: [] } };
    }
    if (query.includes("TemoinRestock")) {
      if (echecLecture) throw new Error("réseau coupé");
      return { order: { metafield: stocke ? { value: JSON.stringify(stocke) } : null } };
    }
    if (query.includes("RemiseEnStock")) {
      if (echecAjustement) throw new Error("502 Shopify");
      return { inventoryAdjustQuantities: { inventoryAdjustmentGroup: { createdAt: "x", reason: "restock" }, userErrors: [] } };
    }
    throw new Error("requête inattendue");
  };
  return {
    fn,
    appels,
    get temoin() { return stocke; },
    ajustements: () => appels.filter((a) => a.query.includes("RemiseEnStock")),
  };
}

groupe("1. Cas nominal — le stock repart sur l'emplacement configuré, et nulle part ailleurs");

(async () => {
  const faux = faireFaux();
  const r = await restockReceivedItems(faux.fn, {
    orderId: ORDER,
    returnId: "R-C295145-1",
    lines: [
      { inventoryItemId: ITEM_A, quantity: 1, title: "T Shirt-Rive Gauche Gris Chiné" },
      { inventoryItemId: ITEM_B, quantity: 1, title: "Sweatshirt-CHAMPIONNES GRIS CHINE" },
    ],
  });
  verifie("l'ajustement est appliqué", r.applied === true, JSON.stringify(r));
  const changes = faux.ajustements()[0]?.variables?.input?.changes || [];
  verifie("deux articles, deux changements", changes.length === 2, JSON.stringify(changes));
  verifie("tout part sur SHOWROOM TURBIGO",
    changes.every((c) => c.locationId === LOCATION_SHOWROOM_TURBIGO), JSON.stringify(changes));
  verifie("aucun changement sur MOBILTRON",
    changes.every((c) => c.locationId !== "gid://shopify/Location/22086985"));
  verifie("aucun changement sur TURENNE",
    changes.every((c) => c.locationId !== "gid://shopify/Location/62808916143"));
  verifie("les deltas sont positifs", changes.every((c) => c.delta === 1));
  // Régression 22/09 (R-C295147-1) : sans cette clé, l'API 2026-07 rejette
  // tout le changement — « InventoryChangeInput must include the following
  // argument: changeFromQuantity ». La clé doit EXISTER, même à null : un
  // simple `c.changeFromQuantity === null` passerait aussi si elle était
  // absente, d'où le test sur la présence de la propriété.
  verifie("chaque changement porte la clé changeFromQuantity",
    changes.every((c) => Object.prototype.hasOwnProperty.call(c, "changeFromQuantity")),
    JSON.stringify(changes));
  verifie("le compare-and-swap est volontairement désactivé",
    changes.every((c) => c.changeFromQuantity === null),
    JSON.stringify(changes.map((c) => c.changeFromQuantity)));

  // CORRECTIF 29/09 — la directive @idempotent, et surtout sa CLÉ.
  const { idempotencyKeyFor } = require("../lib/inventory.cjs");
  verifie("la clé d'idempotence est déterministe : deux scans du même retour donnent la même",
    idempotencyKeyFor("R-C294971-1") === idempotencyKeyFor("R-C294971-1"));
  verifie("deux retours différents ne partagent jamais la même clé",
    idempotencyKeyFor("R-C294971-1") !== idempotencyKeyFor("R-C294971-2"));
  verifie("la clé reste dans les caractères acceptés et sous la limite",
    /^[A-Za-z0-9_-]+$/.test(idempotencyKeyFor("R-C294971-1")) && idempotencyKeyFor("R-C294971-1").length <= 255,
    idempotencyKeyFor("R-C294971-1"));
  verifie("un identifiant exotique est assaini plutôt que refusé",
    /^[A-Za-z0-9_-]+$/.test(idempotencyKeyFor("R-C29/49 71#1")), idempotencyKeyFor("R-C29/49 71#1"));
  const input = faux.ajustements()[0]?.variables?.input || {};
  verifie("la raison Shopify est 'restock'", input.reason === "restock", String(input.reason));
  verifie("on écrit bien sur la quantité disponible", input.name === "available", String(input.name));
  verifie("le retour est tracé dans l'historique Shopify",
    String(input.referenceDocumentUri).includes("R-C295145-1"), String(input.referenceDocumentUri));
  verifie("le témoin final dit 'fait'", faux.temoin?.status === "fait", JSON.stringify(faux.temoin));

  groupe("2. Deux fois le même article — un seul changement, delta cumulé");

  const faux2 = faireFaux();
  await restockReceivedItems(faux2.fn, {
    orderId: ORDER,
    returnId: "R-C000-1",
    lines: [
      { inventoryItemId: ITEM_A, quantity: 1, title: "A" },
      { inventoryItemId: ITEM_A, quantity: 2, title: "A" },
    ],
  });
  const ch2 = faux2.ajustements()[0]?.variables?.input?.changes || [];
  verifie("un seul changement pour la même variante", ch2.length === 1, JSON.stringify(ch2));
  verifie("les quantités s'additionnent (1 + 2 = 3)", ch2[0]?.delta === 3, JSON.stringify(ch2));

  groupe("3. Rescan — le stock ne repart pas une deuxième fois");

  const faux3 = faireFaux({ temoin: { status: "fait", return_id: "R-C295145-1" } });
  const r3 = await restockReceivedItems(faux3.fn, {
    orderId: ORDER,
    returnId: "R-C295145-1",
    lines: [{ inventoryItemId: ITEM_A, quantity: 1, title: "A" }],
  });
  verifie("c'est un rejeu, pas une application", r3.replay === true && r3.applied === false, JSON.stringify(r3));
  verifie("AUCUN ajustement envoyé à Shopify", faux3.ajustements().length === 0);

  groupe("4. Quand on ne SAIT PAS — on ne touche à rien");

  const faux4 = faireFaux({ echecLecture: true });
  const r4 = await restockReceivedItems(faux4.fn, {
    orderId: ORDER,
    returnId: "R-C001-1",
    lines: [{ inventoryItemId: ITEM_A, quantity: 1, title: "A" }],
  });
  verifie("une lecture de témoin impossible bloque l'ajustement",
    r4.applied === false && Boolean(r4.error), JSON.stringify(r4));
  verifie("rien n'est envoyé à Shopify", faux4.ajustements().length === 0);
  verifie("le message dit quoi faire", String(r4.error).includes("à la main"), String(r4.error));

  const faux5 = faireFaux({ echecAjustement: true });
  const r5 = await restockReceivedItems(faux5.fn, {
    orderId: ORDER,
    returnId: "R-C002-1",
    lines: [{ inventoryItemId: ITEM_A, quantity: 1, title: "A" }],
  });
  verifie("une erreur d'ajustement est signalée, pas avalée",
    r5.applied === false && Boolean(r5.error), JSON.stringify(r5));
  verifie("le témoin reste posé en 'incertain' — un rescan ne doublera pas",
    faux5.temoin?.status === "incertain", JSON.stringify(faux5.temoin));

  groupe("5. Rien à remettre");

  const faux6 = faireFaux();
  const r6 = await restockReceivedItems(faux6.fn, { orderId: ORDER, returnId: "R-C003-1", lines: [] });
  verifie("aucune ligne : aucun appel", r6.applied === false && faux6.appels.length === 0, JSON.stringify(r6));

  const faux7 = faireFaux();
  const r7 = await restockReceivedItems(faux7.fn, {
    orderId: ORDER,
    returnId: "R-C004-1",
    lines: [{ inventoryItemId: null, quantity: 1, title: "Article sans variante" }],
  });
  verifie("un article sans article d'inventaire est ignoré, sans planter",
    r7.applied === false && faux7.appels.length === 0, JSON.stringify(r7));

  groupe("6. Emplacement déduit de la commande (sans variable d'environnement)");

  delete process.env.RESTOCK_LOCATION_ID;
  const depuisCommande = async (edges) =>
    resolveRestockLocation(async () => ({ order: { fulfillmentOrders: { edges } } }), ORDER);
  verifie("emplacement d'expédition de la commande utilisé",
    (await depuisCommande([{ node: { assignedLocation: { location: { id: "gid://shopify/Location/42" } } } }])) === "gid://shopify/Location/42");
  verifie("aucun emplacement trouvé : null (le stock n'est pas touché)",
    (await depuisCommande([])) === null);
  const fauxSans = faireFaux();
  const fnSans = async (q, v) => (q.includes("EmplacementCommande") ? { order: { fulfillmentOrders: { edges: [] } } } : fauxSans.fn(q, v));
  const r8 = await restockReceivedItems(fnSans, { orderId: ORDER, returnId: "R-C005-1", lines: [{ inventoryItemId: ITEM_A, quantity: 1, title: "x" }] });
  verifie("sans emplacement : rien écrit, erreur claire",
    r8.applied === false && Boolean(r8.error) && fauxSans.ajustements().length === 0, JSON.stringify(r8));

  console.log("\n" + (echecs === 0
    ? `Tous les tests passent (${reussites}).`
    : `${echecs} ÉCHEC(S) sur ${reussites + echecs} tests.`));
  process.exit(echecs === 0 ? 0 : 1);
})();
