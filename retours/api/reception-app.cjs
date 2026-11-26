// api/reception-app.cjs — dépôt misu-webhook
// GET /api/reception-app → le script de la page de réception des retours
// (Shopify /pages/reception-retours), styles compris.
//
// 13/10/2026 : le code de la page vivait dans le corps HTML de la page
// Shopify (30 Ko collés dans l'éditeur). Il est désormais ici, versionné avec
// l'API qu'il appelle ; la page Shopify ne contient plus que son cadre et
// deux balises <script>. Sources : reception-app/client.js et
// reception-app/style.css, rassemblées dans lib/reception-app-source.js par
// scripts/build-reception-app.js.
//
// Pas de secret ici : le script est public (comme avant dans la page). L'API
// /api/receive-return reste protégée par la clé d'accès entrepôt.
const { JS, CSS } = require("../lib/reception-app-source.cjs");

const SCRIPT = `(function () {
  if (document.getElementById("misu-rec-style")) return;
  var st = document.createElement("style");
  st.id = "misu-rec-style";
  st.textContent = ${JSON.stringify(CSS)};
  document.head.appendChild(st);
})();
${JS}
`;

module.exports = (req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.status(405).end();
    return;
  }
  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  // Court : une correction est en ligne en une minute sur les appareils de l'entrepôt.
  res.setHeader("Cache-Control", "public, max-age=60, s-maxage=60");
  res.setHeader("Access-Control-Allow-Origin", require("../lib/brand.cjs").siteUrl);
  res.status(200).send(req.method === "HEAD" ? "" : SCRIPT);
};
