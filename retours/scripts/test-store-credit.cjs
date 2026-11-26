#!/usr/bin/env node
// Tests du crédit boutique de retour (lib/store-credit.cjs) — sans réseau.
//   node retours/scripts/test-store-credit.cjs
process.env.MISU_STAFF_TOKEN = "t";
const { issueStoreCredit, metafieldKeyFor, expiryDateFor } = require("../lib/store-credit.cjs");
let ko = 0, ok = 0;
const v = (t, c, d) => { if (c) { ok++; console.log("  ok   " + t); } else { ko++; console.log("  ÉCHEC " + t + (d ? "\n        → " + d : "")); } };

function faux({ temoin = null, creditErr = null, creditOk = true } = {}) {
  const s = { appels: [], temoin };
  s.fn = async (q, vars) => {
    s.appels.push(q.slice(0, 40));
    if (q.includes("AvoirDejaEmis")) return { order: { metafield: s.temoin ? { value: JSON.stringify(s.temoin) } : null } };
    if (q.includes("storeCreditAccountCredit")) {
      if (creditErr) throw new Error(creditErr);
      s.input = vars;
      return creditOk
        ? { storeCreditAccountCredit: { storeCreditAccountTransaction: { id: "gid://shopify/StoreCreditAccountCreditTransaction/1", expiresAt: vars.input.expiresAt }, userErrors: [] } }
        : { storeCreditAccountCredit: { storeCreditAccountTransaction: null, userErrors: [{ message: "refus" }] } };
    }
    throw new Error("requête inattendue " + q.slice(0, 40));
  };
  return s;
}

// setReturnMetafields passe par shopify.cjs : on l'intercepte pour capter le témoin.
const shopifyPath = require.resolve("../lib/shopify.cjs");
const temoins = [];
require.cache[shopifyPath].exports.setReturnMetafields = async (_o, m) => { temoins.push(m); };

(async () => {
  console.log("\n1. Émission nominale");
  let f = faux();
  let r = await issueStoreCredit({ shopifyGraphQL: f.fn, orderId: "o", returnId: "R-C1-1", amount: 89.9, customerId: "gid://shopify/Customer/9" });
  v("crédit créé", r.type === "credit_created" && r.amount === 89.9, JSON.stringify(r));
  v("montant et devise envoyés à Shopify", f.input.input.creditAmount.amount === "89.90" && f.input.input.creditAmount.currencyCode === "EUR");
  v("pas d'e-mail Shopify (Klaviyo s'en charge)", f.input.input.notify === false);
  v("témoin « engage » puis « fait » écrits", temoins.length === 2 && temoins[0][metafieldKeyFor("R-C1-1")].status === "engage" && temoins[1][metafieldKeyFor("R-C1-1")].status === "fait", JSON.stringify(temoins));

  console.log("\n2. Rescan : jamais de double crédit");
  f = faux({ temoin: { status: "fait", amount: 89.9, expiresOn: "2027-05-26" } });
  r = await issueStoreCredit({ shopifyGraphQL: f.fn, orderId: "o", returnId: "R-C1-1", amount: 89.9, customerId: "c" });
  v("crédit existant renvoyé", r.type === "credit_existing" && !f.input);
  f = faux({ temoin: { status: "engage", amount: 89.9 } });
  r = await issueStoreCredit({ shopifyGraphQL: f.fn, orderId: "o", returnId: "R-C1-1", amount: 89.9, customerId: "c" });
  v("témoin « engage » : on ne recrédite pas, on signale", r.type === "credit_uncertain" && !f.input, JSON.stringify(r));

  console.log("\n3. Échecs");
  temoins.length = 0;
  f = faux({ creditOk: false });
  let err = null;
  try { await issueStoreCredit({ shopifyGraphQL: f.fn, orderId: "o", returnId: "R-C2-1", amount: 50, customerId: "c" }); } catch (e) { err = e; }
  v("refus Shopify : exception (l'appelant tague avoir-a-emettre)", Boolean(err));
  v("témoin « echec » posé, un rescan peut réessayer", temoins.at(-1)[metafieldKeyFor("R-C2-1")].status === "echec");
  f = faux({ temoin: { status: "echec" } });
  r = await issueStoreCredit({ shopifyGraphQL: f.fn, orderId: "o", returnId: "R-C2-1", amount: 50, customerId: "c" });
  v("après un échec franc, le rescan crédite", r.type === "credit_created");
  f = faux({ creditErr: "ECONNRESET socket hang up" });
  r = await issueStoreCredit({ shopifyGraphQL: f.fn, orderId: "o", returnId: "R-C3-1", amount: 50, customerId: "c" });
  v("réponse perdue : incertain, pas d'exception, témoin laissé « engage »", r.type === "credit_uncertain" && temoins.at(-1)[metafieldKeyFor("R-C3-1")].status === "engage");
  err = null;
  try { await issueStoreCredit({ shopifyGraphQL: faux().fn, orderId: "o", returnId: "R-C4-1", amount: 50, customerId: null }); } catch (e) { err = e; }
  v("commande sans compte client : refusé proprement", Boolean(err) && /compte client/.test(err.message));
  r = await issueStoreCredit({ shopifyGraphQL: faux().fn, orderId: "o", returnId: "R-C5-1", amount: 0, customerId: "c" });
  v("montant nul : rien", r === null);

  console.log("\n4. Échéance");
  v("6 mois", expiryDateFor(6, new Date("2026-11-26T10:00:00Z")) === "2027-05-26");
  v("fin de mois bornée", expiryDateFor(6, new Date("2026-08-31T10:00:00Z")) === "2027-02-28");

  console.log("\n" + (ko ? `${ko} ÉCHEC(S)` : `Tous les tests passent (${ok}).`));
  process.exit(ko ? 1 : 0);
})();
