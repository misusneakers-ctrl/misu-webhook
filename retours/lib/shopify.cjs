// lib/shopify.js
// Authentification (client credentials grant) et appels GraphQL Admin API.
// Même mécanisme que misu-webhook : SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET,
// pas de token statique (SHOPIFY_ADMIN_TOKEN n'existe pas ici).

const SHOP_DOMAIN = process.env.SHOPIFY_SHOP_DOMAIN;
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const API_VERSION = "2026-07";

// Cache mémoire simple — utile sur les invocations "chaudes" de la même
// fonction serverless, sans conséquence si elle ne survit pas (on refait
// juste un appel de plus).
let cachedToken = null;
let cachedTokenExpiry = 0;

async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && now < cachedTokenExpiry) {
    return cachedToken;
  }

  if (!SHOP_DOMAIN || !CLIENT_ID || !CLIENT_SECRET) {
    throw new Error(
      "Variables Shopify manquantes : SHOPIFY_SHOP_DOMAIN, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET"
    );
  }

  const res = await fetch(`https://${SHOP_DOMAIN}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: "client_credentials",
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Échec auth Shopify (${res.status}): ${text}`);
  }

  const data = await res.json();
  cachedToken = data.access_token;
  // expires_in est en secondes ; on se garde une marge de 60s.
  cachedTokenExpiry = now + (data.expires_in - 60) * 1000;
  return cachedToken;
}

async function shopifyGraphQL(query, variables = {}) {
  const token = await getAccessToken();

  const res = await fetch(
    `https://${SHOP_DOMAIN}/admin/api/${API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
      body: JSON.stringify({ query, variables }),
    }
  );

  const body = await res.json();

  if (body.errors) {
    throw new Error(`Erreur GraphQL Shopify: ${JSON.stringify(body.errors)}`);
  }
  if (body.data && Object.values(body.data).some((v) => v && v.userErrors && v.userErrors.length)) {
    throw new Error(`userErrors Shopify: ${JSON.stringify(body.data)}`);
  }

  return body.data;
}

// Ajouté le 11/09 : suivi transporteur en direct depuis Smarty365 (voir
// api/smarty-webhook.js). BBP expédie une partie de ses colis via Smarty365
// (compte partagé avec Misü) et une autre partie via Mobiltron. Smarty365 ne
// fournit qu'un numéro de suivi dans son webhook, jamais de numéro de
// commande : on retrouve donc la commande en parcourant les commandes
// expédiées les plus récentes et en comparant le numéro de suivi de chaque
// fulfillment. Fonctionne bien puisque le webhook arrive juste après
// l'expédition — la commande recherchée est presque toujours dans les tout
// premiers résultats.
async function findOrderByTrackingNumber(trackingNumber, { maxOrders = 250, pageSize = 50 } = {}) {
  const target = String(trackingNumber || "").trim();
  if (!target) return null;

  let cursor = null;
  let scanned = 0;

  while (scanned < maxOrders) {
    const data = await shopifyGraphQL(
      `query FindByTracking($first: Int!, $after: String) {
        orders(
          first: $first
          after: $after
          sortKey: PROCESSED_AT
          reverse: true
          query: "fulfillment_status:fulfilled OR fulfillment_status:partial"
        ) {
          pageInfo { hasNextPage endCursor }
          edges {
            node {
              id
              name
              fulfillments(first: 10) {
                trackingInfo { number url company }
              }
            }
          }
        }
      }`,
      { first: pageSize, after: cursor }
    );

    const edges = data?.orders?.edges || [];
    const match = edges.find(({ node }) =>
      node.fulfillments?.some((f) => f.trackingInfo?.some((t) => t.number === target))
    );
    if (match) return match.node;

    scanned += edges.length;
    const pageInfo = data?.orders?.pageInfo;
    if (!pageInfo?.hasNextPage || edges.length === 0) break;
    cursor = pageInfo.endCursor;
  }

  return null;
}

// Métachamps de suivi transporteur, dans l'espace « bbp » (même principe que
// l'espace « misu » côté Misü). Posés par le webhook Smarty365 uniquement —
// n'existent donc que pour les commandes BBP réellement expédiées via
// Smarty365, jamais pour celles parties via Mobiltron.
async function setReturnMetafields(orderId, fields) {
  const metafields = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => ({
      ownerId: orderId,
      namespace: require("./brand.cjs").metafieldNamespace,
      key,
      type: typeof value === "object" ? "json" : "single_line_text_field",
      value: typeof value === "object" ? JSON.stringify(value) : String(value),
    }));

  if (!metafields.length) return;

  const data = await shopifyGraphQL(
    `mutation SetMetafields($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        userErrors { field message }
      }
    }`,
    { metafields }
  );

  const errors = data?.metafieldsSet?.userErrors || [];
  if (errors.length) {
    throw new Error(`Écriture des métachamps refusée : ${JSON.stringify(errors)}`);
  }
}

module.exports = {
  getAccessToken,
  shopifyGraphQL,
  SHOP_DOMAIN,
  API_VERSION,
  findOrderByTrackingNumber,
  setReturnMetafields,
};
