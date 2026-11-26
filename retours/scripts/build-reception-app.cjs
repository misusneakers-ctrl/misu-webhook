#!/usr/bin/env node
// scripts/build-reception-app.cjs — dépôt misu-webhook
// Régénère lib/reception-app-source.cjs à partir de reception-app/client.cjs et
// reception-app/style.css (page de réception des retours, servie par
// api/reception-app.js). À relancer après toute modification de ces deux
// fichiers ; scripts/test-reception-incident.js vérifie qu'ils sont à jour.
//   node scripts/build-reception-app.cjs
const fs = require("fs");
const path = require("path");

function construire() {
  const dir = path.join(__dirname, "..", "reception-app");
  const js = fs.readFileSync(path.join(dir, "client.cjs"), "utf8");
  const css = fs.readFileSync(path.join(dir, "style.css"), "utf8");
  return "// FICHIER GÉNÉRÉ par scripts/build-reception-app.cjs — ne pas modifier à la main.\n"
    + "// Sources : reception-app/client.cjs et reception-app/style.css.\n"
    + `module.exports = {\n  JS: ${JSON.stringify(js)},\n  CSS: ${JSON.stringify(css)},\n};\n`;
}

if (require.main === module) {
  fs.writeFileSync(path.join(__dirname, "..", "lib", "reception-app-source.cjs"), construire());
  console.log("lib/reception-app-source.cjs régénéré.");
}
module.exports = { construire };
