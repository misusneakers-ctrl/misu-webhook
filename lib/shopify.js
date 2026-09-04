// Authentification Shopify + recherche de commande.
//
// Les apps créées dans le Dev Dashboard n'ont pas de token statique.
// On échange client_id + client_secret contre un token valable 24 h
// (client credentials grant), qu'on garde en mémoire entre deux appels.

const API_VERSION = '2025-10';

let cachedToken = null;
let cachedExpiry = 0;

async function getAccessToken() {
  const shop = process.env.SHOPIFY_SHOP_DOMAIN;
  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;

  if (!shop || !clientId || !clientSecret) {
    throw new Error(
      'Variables manquantes : SHOPIFY_SHOP_DOMAIN, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET'
    );
  }

  // Marge de 60 s avant l'expiration réelle, pour éviter d'utiliser
  // un token qui expire pendant la requête.
  if (cachedToken && Date.now() < cachedExpiry - 60000) {
    return cachedToken;
  }

  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret
    })
  });

  const data = await res.json().catch(() => null);

  if (!res.ok || !data?.access_token) {
    throw new Error(
      `Authentification Shopify refusée (HTTP ${res.status}) : ${JSON.stringify(data)}`
    );
  }

  cachedToken = data.access_token;
  cachedExpiry = Date.now() + data.expires_in * 1000;
  return cachedToken;
}

export async function findOrder(orderNumber, zipCode) {
  const shop = process.env.SHOPIFY_SHOP_DOMAIN;
  const token = await getAccessToken();

  const query = `
    query FindOrder($q: String!) {
      orders(first: 1, query: $q) {
        edges {
          node {
            id
            name
            email
            displayFulfillmentStatus
            shippingAddress { zip }
            fulfillments(first: 5) {
              createdAt
              trackingInfo { number url company }
            }
          }
        }
      }
    }`;

  // Le client peut saisir 1001 ou #1001 : les deux fonctionnent côté
  // Shopify, mais on normalise pour rester prévisible.
  const cleanNumber = String(orderNumber).trim().replace(/^#/, '');

  const res = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token
    },
    body: JSON.stringify({ query, variables: { q: `name:${cleanNumber}` } })
  });

  const data = await res.json().catch(() => null);

  // On remonte les vraies erreurs au lieu de les replier sur null :
  // sinon un problème d'authentification ressemble à une commande
  // introuvable, ce qui rend le diagnostic impossible.
  if (!res.ok) {
    throw new Error(`Shopify a répondu HTTP ${res.status} : ${JSON.stringify(data)}`);
  }
  if (data?.errors) {
    throw new Error(`Erreur GraphQL Shopify : ${JSON.stringify(data.errors)}`);
  }

  const order = data?.data?.orders?.edges?.[0]?.node;
  if (!order) return null;

  // Vérification du code postal : empêche de suivre n'importe quelle
  // commande en devinant simplement son numéro.
  const expected = (order.shippingAddress?.zip || '').replace(/\s/g, '');
  const provided = String(zipCode || '').replace(/\s/g, '');
  if (!expected || expected !== provided) return null;

  return order;
}
