// lib/brand.cjs
// Dépôt : misu-webhook
//
// Tout ce qui distingue MISÜ de BBP dans le portail de retours.
//
// Le noyau de retours (retours/) est le portail BBP porté tel quel : mêmes
// règles, même calcul, même réception. Ce fichier est donc le SEUL endroit
// où vivent les valeurs propres à la marque — dossier Dropbox, espace des
// métachamps, noms d'événements Klaviyo, URL publique, adresse de contact.
// Un changement de marque ne doit jamais demander de toucher au code métier.

const BRAND = {
  slug: "misu",
  name: "MISÜ",

  // Boutique et contact
  siteUrl: "https://misu-sneakers.fr",
  accountUrl: "https://misu-sneakers.fr/account",
  contactEmail: "bonjour@misu-sneakers.fr",
  returnPageUrl: "https://misu-sneakers.fr/pages/retour",

  // URL publique de cette API (liens d'étiquette envoyés aux clientes).
  apiBase: process.env.PUBLIC_API_BASE || "https://misu-webhook.vercel.app",

  // Dropbox : même arborescence qu'avant (AVAILABLE / CONFIRMED / RECEIVED,
  // INVENTORY.csv, RETURNS.csv), le « ü » est échappé dans les en-têtes.
  returnsRoot: "/New Brands/misü/Ecommerce/Returns",

  // Métachamps de commande : l'espace « misu » est déjà lu par le portail de
  // suivi (track-order) et par la messagerie (return_status, settlement…).
  metafieldNamespace: "misu",

  // Préfixe des attributs et étiquettes techniques posés par le portail.
  attrPrefix: "misu_",
  tagPrefix: "misu-",

  // Messagerie (messagerie-influence-sav) : espace de la marque.
  messagerieTenantSlug: process.env.MESSAGERIE_TENANT_SLUG || "misu",

  // Remise en stock : l'emplacement Shopify où la paire revient. Défini par
  // RESTOCK_LOCATION_ID, sinon déduit de l'emplacement d'expédition de la
  // commande d'origine (voir lib/inventory.cjs).
  restockLocationId: process.env.RESTOCK_LOCATION_ID || null,

  // Événements Klaviyo. « Retour Demandé » existe déjà côté MISÜ (flow
  // SQa43f) : on garde son nom pour ne rien casser.
  klaviyo: {
    returnRequested: "Retour Demandé",
    avoirIssued: "Avoir Émis MISÜ",
    avoirExpiring: "Avoir Bientôt Expiré MISÜ",
    dailyDigest: "MISÜ — Digest Quotidien Retours",
  },

  // Accès réception : en-têtes acceptés, et clé (RECEPTION_API_KEY, sinon le
  // jeton interne MISU_STAFF_TOKEN déjà utilisé par l'ancienne page).
  receptionKeyHeaders: ["x-misu-reception-key", "x-misu-token"],
};

module.exports = BRAND;
