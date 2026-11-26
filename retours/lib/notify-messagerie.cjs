// lib/notify-messagerie.js
// Dépôt : bbp-webhook
//
// Pousse un retour vers la messagerie (messagerie-influence-sav), qui en fait
// une FICHE dans sa vue « Retours » — jamais un ticket dans la boîte ni dans la
// file de validation.
//
// POURQUOI CE FICHIER EXISTE (21/09/2026).
// La messagerie a son endpoint de réception depuis ce matin
// (`api/webhooks/return.js`), les deux secrets sont posés dans Vercel des deux
// côtés… et personne n'appelle. Vérifié en base : `return_cases` contient
// ZÉRO ligne. Les retours du portail ne sont donc jamais arrivés dans la
// messagerie ; sa vue « Retours » ne tourne que sur les retours natifs Shopify.
// Le côté émetteur n'avait simplement jamais été écrit.
//
// NOUVEAU FICHIER, volontairement. Le protocole convenu le 21/09 entre les
// deux chats dit : ne jamais modifier les fichiers de l'autre. `receive-return`
// et `create-return` appartiennent au portail. Ce module est donc autonome, et
// il suffit d'une ligne d'appel chez eux (voir plus bas).
//
// ---------------------------------------------------------------------------
// COMMENT L'APPELER — une ligne, en fin de traitement, après l'écriture CSV :
//
//   const { notifierMessagerie } = require("../lib/notify-messagerie.cjs");
//   ...
//   await notifierMessagerie({
//     return_id: returnId,
//     order_number: order.name,
//     customer_email: order.email,
//     customer_name: `${order.customer?.firstName || ""} ${order.customer?.lastName || ""}`.trim(),
//     status: "RECEIVED",              // ou "REQUESTED" dans create-return.js
//     label: trackingNumber || null,
//     exchange_order: exchangeOrderName || null,
//     items: itemResults,              // titre, variante, quantité, choix
//     settlement,                      // le calcul complet, tel quel
//     restock,                         // { applied, location, lines, ... }
//     received_at: new Date().toISOString(),
//   });
//
// Elle ne jette JAMAIS. Un retour reçu en entrepôt ne doit pas échouer parce
// que la messagerie est en panne ou en cours de déploiement : elle renvoie
// { sent:false, error } et l'appelant peut le glisser dans la note, comme il
// le fait déjà pour les avertissements de remise en stock.
// ---------------------------------------------------------------------------

const DELAI_MS = 8000;

function configuration() {
  const base = process.env.MESSAGERIE_BASE_URL;
  const secret = process.env.RETURNS_WEBHOOK_SECRET;
  return {
    base: base ? String(base).replace(/\/+$/, "") : null,
    secret: secret || null,
    // La messagerie est multi-marque : sans cet en-tête elle répond
    // 400 tenant_not_resolved. On préfère le domaine myshopify, qu'elle
    // résout directement ; le slug est la roue de secours.
    shopDomain: process.env.SHOPIFY_SHOP_DOMAIN || null,
    tenantSlug: require("./brand.cjs").messagerieTenantSlug,
  };
}

/**
 * Envoi commun aux deux points d'entrée de la messagerie.
 * @returns {Promise<{sent:boolean, status?:number, error?:string, body?:object}>}
 */
async function poster(chemin, payload, delaiMs) {
  const { base, secret, shopDomain, tenantSlug } = configuration();
  if (!base || !secret) {
    // Pas configuré = pas une erreur : le portail doit tourner seul.
    return { sent: false, error: "messagerie_non_configuree" };
  }
  if (!payload || !payload.return_id) {
    return { sent: false, error: "return_id_manquant" };
  }

  const ctrl = new AbortController();
  const minuteur = setTimeout(() => ctrl.abort(), delaiMs);
  try {
    const res = await fetch(`${base}${chemin}`, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "content-type": "application/json",
        // Secret en en-tête, jamais dans l'URL.
        "x-returns-secret": secret,
        ...(shopDomain ? { "x-shop-domain": shopDomain } : {}),
        "x-tenant-slug": tenantSlug,
      },
      body: JSON.stringify(payload),
    });
    const texte = await res.text();
    let body = null;
    try { body = texte ? JSON.parse(texte) : null; } catch { body = { brut: texte.slice(0, 200) }; }
    if (!res.ok) {
      return { sent: false, status: res.status, error: (body && body.error) || `http_${res.status}`, body };
    }
    return { sent: true, status: res.status, body };
  } catch (e) {
    return {
      sent: false,
      error: e.name === "AbortError" ? `pas de réponse en ${delaiMs / 1000} s` : String(e.message || e).slice(0, 200),
    };
  } finally {
    clearTimeout(minuteur);
  }
}

/** Fiche retour (vue « Retours » de la messagerie). Ne jette jamais. */
async function notifierMessagerie(payload) {
  return poster("/api/webhooks/return", payload, DELAI_MS);
}

// 13/10 (Luc) — constat de l'entrepôt au scan (article manquant / problème,
// photos, message) → TICKET SAV « Retour non conforme » dans la messagerie
// (api/webhooks/reception-incident.js, même secret). Délai plus long : la
// messagerie dépose les photos sur son stockage avant de répondre.
// Ne jette jamais, comme notifierMessagerie.
const DELAI_INCIDENT_MS = 25000;
async function signalerIncidentReception(payload) {
  return poster("/api/webhooks/reception-incident", payload, DELAI_INCIDENT_MS);
}

module.exports = { notifierMessagerie, signalerIncidentReception, _internal: { configuration, DELAI_MS, DELAI_INCIDENT_MS } };
