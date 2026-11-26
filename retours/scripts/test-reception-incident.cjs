#!/usr/bin/env node
// scripts/test-reception-incident.js — dépôt misu-webhook
// Constat de l'entrepôt au scan (13/10/2026) : article manquant / problème,
// photos, message → retour en litige + ticket SAV dans la messagerie.
// Fait tourner le VRAI api/receive-return.cjs, avec Shopify, Dropbox et la
// messagerie simulés (aucun réseau).
//   node scripts/test-reception-incident.js

const path = require("path");
let echecs = 0;
let reussites = 0;
const verifie = (titre, ok, detail) => {
  if (ok) { reussites += 1; console.log("  ok   " + titre); }
  else { echecs += 1; console.log("  ÉCHEC " + titre + (detail ? "\n        → " + detail : "")); }
};

process.env.RECEPTION_API_KEY = "cle-test";

// --- Faux modules -----------------------------------------------------------
const fichiers = {};
const appelsShopify = [];
const envois = { fiche: [], incident: [] };

function stub(rel, exportsObj) {
  const full = require.resolve(path.join(__dirname, "..", rel));
  require.cache[full] = { id: full, filename: full, loaded: true, exports: exportsObj };
}

stub("lib/dropbox.cjs", {
  RETURNS_ROOT: "/R",
  downloadFile: async (p) => { if (!(p in fichiers)) throw new Error("not_found"); return Buffer.from(fichiers[p]); },
  updateTextFile: async (p, fn) => { fichiers[p] = fn(fichiers[p] || ""); },
  moveFile: async () => {},
});
stub("lib/klaviyo.cjs", { trackAvoirIssued: async () => {} });
stub("lib/store-credit.cjs", { issueStoreCredit: async () => { throw new Error("pas attendu en litige"); }, CREDIT_VALIDITY_MONTHS: 6 });
const appelsStock = [];
stub("lib/inventory.cjs", { restockReceivedItems: async (_g, a) => { appelsStock.push(a); return { applied: true, replay: false, lines: a.lines }; } });
stub("lib/notify-messagerie.cjs", {
  notifierMessagerie: async (p) => { envois.fiche.push(p); return { sent: true }; },
  signalerIncidentReception: async (p) => envois.reponseIncident(p),
});
envois.reponseIncident = async (p) => { envois.incident.push(p); return { sent: true, body: { ticket_id: "t-1", photos: (p.photos || []).length } }; };

const ORDER = {
  id: "gid://shopify/Order/1",
  name: "C300001",
  note: "",
  email: "cliente@example.fr",
  customer: { id: "gid://shopify/Customer/9" },
  shippingAddress: { firstName: "Camille" },
  totalRefundedSet: { shopMoney: { amount: "0.00" } },
  tags: [],
  subtotalPriceSet: { shopMoney: { amount: "200.00" } },
  paymentGatewayNames: ["shopify_payments"],
  transactions: [{ gateway: "shopify_payments", kind: "SALE", status: "SUCCESS", amountSet: { shopMoney: { amount: "200.00" } } }],
  discountApplications: { edges: [] },
  refunds: [],
  lineItems: {
    edges: [
      { node: { id: "gid://shopify/LineItem/A", image: null, variant: { id: "v1", barcode: "111", price: "100.00", inventoryItem: { id: "i1" } }, quantity: 1, originalUnitPriceSet: { shopMoney: { amount: "100.00" } }, discountAllocations: [] } },
      { node: { id: "gid://shopify/LineItem/B", image: null, variant: { id: "v2", barcode: "222", price: "100.00", inventoryItem: { id: "i2" } }, quantity: 1, originalUnitPriceSet: { shopMoney: { amount: "100.00" } }, discountAllocations: [] } },
    ],
  },
};
stub("lib/shopify.cjs", {
  shopifyGraphQL: async (q, v) => {
    appelsShopify.push({ q, v });
    if (/FindOrderForReception/.test(q)) return { orders: { edges: [{ node: ORDER }] } };
    if (/orderUpdate/.test(q)) return { orderUpdate: { userErrors: [] } };
    if (/tagsAdd/.test(q)) return { tagsAdd: { userErrors: [] }, tagsRemove: { userErrors: [] } };
    return {};
  },
});

const handler = require("../api/receive-return.cjs");

function initFichiers() {
  fichiers["/R/INVENTORY.csv"] = "label_number,tracking_number,label_status,return_id,order_name,return_status,draft_order_id,pdf_file,date_assigned,date_received\n"
    + "L1,XT1TS,USED,R-C300001-1,C300001,CONFIRMED,,l1.pdf,2026-10-10,\n";
  fichiers["/R/RETURNS.csv"] = "return_id,order_name,line_item_id,barcode,product_title,variant_title,quantity,reason,comment,action,exchange_barcode,exchange_title,item_status,received_at\n"
    + "R-C300001-1,C300001,gid://shopify/LineItem/A,XT1TS,Edith,ROSE / 38,1,Trop petit,,refund,,,REQUESTED,\n"
    + "R-C300001-1,C300001,gid://shopify/LineItem/B,XT1TS,Simone,NOIR / 39,1,Trop grand,,refund,,,REQUESTED,\n";
  envois.fiche.length = 0; envois.incident.length = 0; appelsShopify.length = 0;
}

async function appeler(body) {
  const res = { code: 0, json: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(j) { this.json = j; return this; }, end() { return this; } };
  await handler({ method: "POST", headers: { "x-misu-reception-key": "cle-test" }, body }, res);
  return res;
}

const INVENTAIRE = () => fichiers["/R/INVENTORY.csv"];
const PHOTO = { filename: "colis.jpg", content_type: "image/jpeg", content_base64: Buffer.from("jpeg").toString("base64") };

(async () => {
  console.log("\n1. Tout scanné, rien signalé — comportement d'avant inchangé");
  initFichiers();
  let r = await appeler({ mode: "confirm", trackingNumber: "XT1TS", scannedBarcodes: ["111", "222"] });
  verifie("200", r.code === 200, JSON.stringify(r.json).slice(0, 300));
  verifie("RECEIVED", r.json && r.json.status === "RECEIVED");
  verifie("pas de ticket SAV", envois.incident.length === 0 && r.json.ticketSav && r.json.ticketSav.skipped === "rien_a_signaler");
  verifie("fiche retour envoyée avec le vrai statut", envois.fiche[0] && envois.fiche[0].status === "RECEIVED");

  console.log("\n2. Un article manquant (non scanné) + un problème (scanné mais abîmé), photos et message");
  initFichiers();
  r = await appeler({
    mode: "confirm",
    trackingNumber: "XT1TS",
    scannedBarcodes: ["222"],
    issues: [
      { lineItemId: "gid://shopify/LineItem/A", type: "manquant", comment: "boîte vide" },
      { lineItemId: "gid://shopify/LineItem/B", type: "probleme", comment: "semelle usée" },
      { lineItemId: "gid://shopify/LineItem/B", type: "pirate" },
    ],
    incident: { id: "inc-1", note: "Colis ouvert", photos: [PHOTO, PHOTO] },
  });
  verifie("200", r.code === 200, JSON.stringify(r.json).slice(0, 300));
  verifie("DISPUTED", r.json.status === "DISPUTED");
  verifie("article scanné mais signalé = non conforme", r.json.items[1].compliant === false && r.json.items[1].receivedQuantity === 1);
  verifie("problème gardé sur l'article", r.json.items[1].issue && r.json.items[1].issue.type === "probleme" && r.json.items[1].issue.comment === "semelle usée");
  verifie("type inconnu ignoré (le dernier n'écrase pas)", r.json.items[1].issue.type === "probleme");
  verifie("aucun remboursement calculé à régler", !r.json.cashRefundAmount || r.json.status === "DISPUTED");
  verifie("ticket SAV demandé", envois.incident.length === 1);
  const inc = envois.incident[0] || {};
  verifie("constat : id, retour, commande, e-mail", inc.incident_id === "inc-1" && inc.return_id === "R-C300001-1" && inc.order_number === "C300001" && inc.customer_email === "cliente@example.fr");
  verifie("constat : 2 photos et le message", inc.photos.length === 2 && inc.note === "Colis ouvert");
  verifie("constat : articles avec signalements", inc.items[0].issue.type === "manquant" && inc.items[1].issue.type === "probleme");
  verifie("réponse : ticket SAV créé", r.json.ticketSav && r.json.ticketSav.sent === true);
  verifie("fiche retour en DISPUTED (corrigé : disait toujours RECEIVED)", envois.fiche[0].status === "DISPUTED");
  const note = (appelsShopify.find((a) => /orderUpdate/.test(a.q)) || {}).v;
  const texteNote = note && note.input && note.input.note || "";
  verifie("note de commande : MANQUANT et PROBLÈME", /Edith \(MANQUANT : boîte vide\)/.test(texteNote) && /Simone \(PROBLÈME : semelle usée\)/.test(texteNote), texteNote);
  const tags = (appelsShopify.find((a) => /tagsAdd/.test(a.q)) || {}).v;
  verifie("tag retour-litige", tags && tags.tagsToAdd.includes("retour-litige"));
  verifie("INVENTORY passe en DISPUTED", /,DISPUTED,/.test(INVENTAIRE()));

  console.log("\n3. Colis conforme mais message de l'entrepôt");
  initFichiers();
  r = await appeler({ mode: "confirm", trackingNumber: "XT1TS", scannedBarcodes: ["111", "222"], incident: { note: "Boîte abîmée, chaussures OK" } });
  verifie("RECEIVED (la remarque ne bloque pas le remboursement)", r.json.status === "RECEIVED");
  verifie("ticket SAV quand même (message)", envois.incident.length === 1 && envois.incident[0].status === "RECEIVED");

  console.log("\n4. Écart sans rien signaler (ancien cas C294887) → ticket quand même");
  initFichiers();
  r = await appeler({ mode: "confirm", trackingNumber: "XT1TS", scannedBarcodes: ["111", "999"] });
  verifie("DISPUTED", r.json.status === "DISPUTED");
  verifie("ticket SAV avec le scan non annoncé", envois.incident.length === 1 && envois.incident[0].unexpected_scans.includes("999"));

  console.log("\n5. Messagerie en panne → la réception réussit quand même");
  initFichiers();
  envois.reponseIncident = async () => ({ sent: false, error: "pas de réponse en 25 s" });
  r = await appeler({ mode: "confirm", trackingNumber: "XT1TS", scannedBarcodes: ["222"], issues: [{ lineItemId: "gid://shopify/LineItem/A", type: "manquant" }] });
  verifie("200 malgré la panne", r.code === 200 && r.json.ok);
  verifie("erreur remontée à la page", r.json.ticketSav && r.json.ticketSav.sent === false);

  console.log("\n5bis. Article conforme écarté du stock à la main (06/11)");
  initFichiers();
  envois.reponseIncident = async () => ({ sent: true });
  appelsStock.length = 0;
  r = await appeler({ mode: "confirm", trackingNumber: "XT1TS", scannedBarcodes: ["111", "222"], horsStock: [{ lineItemId: "gid://shopify/LineItem/A", comment: "Boîte abîmée" }] });
  verifie("RECEIVED (le retour suit son cours)", r.json.status === "RECEIVED", JSON.stringify(r.json).slice(0, 300));
  verifie("remise en stock : seul l'article B", appelsStock.length === 1 && appelsStock[0].lines.length === 1 && appelsStock[0].lines[0].title === "Simone");
  verifie("écart signalé à la page", r.json.restock && r.json.restock.ecartes && r.json.restock.ecartes[0].comment === "Boîte abîmée");
  verifie("article marqué hors stock", r.json.items.find((i) => i.title === "Edith").horsStock !== null);

  console.log("\n5ter. Article SANS code-barres (Seconde chance, C296009) confirmé par la coche");
  initFichiers();
  const ligneB = ORDER.lineItems.edges[1].node.variant; ligneB.barcode = null;
  r = await appeler({ mode: "confirm", trackingNumber: "XT1TS", scannedBarcodes: ["111"] });
  verifie("sans la coche : litige (comme avant)", r.json.status === "DISPUTED");
  initFichiers();
  r = await appeler({ mode: "confirm", trackingNumber: "XT1TS", scannedBarcodes: ["111"], confirmedLineItems: ["gid://shopify/LineItem/B"] });
  verifie("avec la coche : conforme", r.json.status === "RECEIVED", JSON.stringify(r.json.items));
  ligneB.barcode = "222";

  console.log("\n6. Script de la page à jour avec ses sources");
  const { construire } = require("./build-reception-app.cjs");
  const genere = require("fs").readFileSync(require("path").join(__dirname, "..", "lib", "reception-app-source.cjs"), "utf8");
  verifie("lib/reception-app-source.cjs = reception-app/* (sinon : node scripts/build-reception-app.cjs)", genere === construire());
  const servi = {}; require("../api/reception-app.cjs")({ method: "GET" }, { setHeader(k, v) { servi[k] = v; }, status() { return this; }, send(b) { servi.body = b; } });
  let syntaxe = true; try { new Function(servi.body); } catch (e) { syntaxe = false; }
  verifie("GET /api/reception-app : JavaScript valide", syntaxe && /javascript/.test(servi["Content-Type"]));

  console.log(`\n${reussites} réussite(s), ${echecs} échec(s)`);
  process.exit(echecs ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
