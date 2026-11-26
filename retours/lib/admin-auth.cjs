// lib/admin-auth.js
// Dépôt : misu-webhook
//
// NOUVEAU (audit 17/09) — protection des endpoints d'administration
// (api/import-labels.js, api/diagnostic.js) qui étaient appelables par
// n'importe qui. Réutilise CRON_SECRET (déjà défini sur Vercel) :
//  - soit en-tête "Authorization: Bearer <CRON_SECRET>" (appels Vercel/cron),
//  - soit paramètre "?token=<CRON_SECRET>" (appel à la main dans le navigateur).

const crypto = require("crypto");

function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a || "")).digest();
  const hb = crypto.createHash("sha256").update(String(b || "")).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Renvoie null si autorisé, sinon { status, error }.
function checkAdminToken(req, envName = "CRON_SECRET") {
  const expected = process.env[envName];
  if (!expected) return { status: 503, error: `${envName} n'est pas configuré sur Vercel.` };
  const auth = String((req.headers || {}).authorization || "");
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const token = String((req.query || {}).token || "");
  if ((bearer && safeEqual(bearer, expected)) || (token && safeEqual(token, expected))) return null;
  return { status: 403, error: "Non autorisé." };
}

module.exports = { safeEqual, checkAdminToken };
