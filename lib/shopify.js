// Authentification Shopify, lecture de commandes et écriture des échanges.
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

// Un seul point de passage pour toutes les requêtes : les erreurs HTTP et
// GraphQL remontent avec leur contenu réel, au lieu d'être repliées sur un
// message générique qui rend le diagnostic impossible.
async function shopifyGraphQL(query, variables = {}) {
  const shop = process.env.SHOPIFY_SHOP_DOMAIN;
  const token = await getAccessToken();

  const res = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token
    },
    body: JSON.stringify({ query, variables })
  });

  const data = await res.json().catch(() => null);

  if (!res.ok) {
    throw new Error(`Shopify a répondu HTTP ${res.status} : ${JSON.stringify(data)}`);
  }
  if (data?.errors) {
    throw new Error(`Erreur GraphQL Shopify : ${JSON.stringify(data.errors)}`);
  }

  return data?.data;
}

// Portées réellement accordées au token, telles que Shopify les voit.
// C'est la seule vérification qui fasse foi : le tableau de bord peut
// afficher des portées qui n'ont pas été accordées faute de réinstallation.
export async function getGrantedScopes() {
  const data = await shopifyGraphQL(`
    query Scopes {
      currentAppInstallation {
        accessScopes { handle }
      }
    }`);

  return (data?.currentAppInstallation?.accessScopes || []).map((s) => s.handle).sort();
}

export async function findOrder(orderNumber, zipCode) {
  // Le client peut saisir 1001 ou #1001 : les deux fonctionnent côté
  // Shopify, mais on normalise pour rester prévisible.
  const cleanNumber = String(orderNumber).trim().replace(/^#/, '');

  const data = await shopifyGraphQL(
    `query FindOrder($q: String!) {
      orders(first: 10, query: $q) {
        edges {
          node {
            id
            name
            email
            displayFulfillmentStatus
            shippingAddress {
              firstName lastName company address1 address2
              city zip province provinceCode countryCodeV2 phone
            }
            shippingLine {
              title
              originalPriceSet { shopMoney { amount currencyCode } }
            }
            customAttributes { key value }
            customer { id }
            lineItems(first: 50) {
              nodes {
                id
                title
                quantity
                variant { id title barcode sku }
                product { id title productType }
                discountedUnitPriceSet { shopMoney { amount currencyCode } }
                image { url }
              }
            }
            fulfillments(first: 5) {
              createdAt
              displayStatus
              trackingInfo { number url company }
              events(first: 20) {
                edges { node { status happenedAt } }
              }
            }
          }
        }
      }
    }`,
    { q: `name:${cleanNumber}` }
  );

  const nodes = data?.orders?.edges?.map((e) => e.node) || [];

  // Shopify fait une recherche par mot, pas une égalité stricte : « 1001 »
  // peut remonter « #10010 ». On exige le numéro exact, sinon une cliente
  // pourrait tomber sur la commande d'une autre.
  const order = nodes.find((n) => String(n.name).replace(/^#/, '') === cleanNumber);
  if (!order) return null;

  // Vérification du code postal : empêche de suivre n'importe quelle
  // commande en devinant simplement son numéro.
  const expected = (order.shippingAddress?.zip || '').replace(/\s/g, '');
  const provided = String(zipCode || '').replace(/\s/g, '');
  if (!expected || expected !== provided) return null;

  return order;
}

// Recherche une commande par son seul numéro, sans vérification de code
// postal. Réservé aux écrans internes : le contrôle du code postal protège
// le portail client, il n'a pas de sens quand c'est Luc qui scanne un colis.
export async function findOrderByName(orderName) {
  const clean = String(orderName).trim().replace(/^#/, '');

  const data = await shopifyGraphQL(
    `query FindByName($q: String!) {
      orders(first: 10, query: $q) {
        edges {
          node {
            id
            name
            email
            lineItems(first: 50) {
              nodes {
                id
                title
                discountedUnitPriceSet { shopMoney { amount currencyCode } }
              }
            }
          }
        }
      }
    }`,
    { q: `name:${clean}` }
  );

  const nodes = data?.orders?.edges?.map((e) => e.node) || [];
  return nodes.find((n) => String(n.name).replace(/^#/, '') === clean) || null;
}

// Date de livraison réelle, si le transporteur l'a remontée à Shopify.
// Renvoie null quand l'information n'est pas disponible.
export function getDeliveredAt(order) {
  const fulfillment = order?.fulfillments?.[0];
  if (!fulfillment) return null;

  const events = fulfillment.events?.edges?.map((e) => e.node) || [];
  const delivered = events
    .filter((e) => e.status === 'DELIVERED' && e.happenedAt)
    .sort((a, b) => new Date(a.happenedAt) - new Date(b.happenedAt))[0];

  return delivered ? delivered.happenedAt : null;
}

// Catalogue actif, avec les stocks réels et les codes-barres de chaque taille.
// Le code-barres sert au scan de réception : c'est lui qui identifie la
// variante exacte, taille comprise.
export async function getCatalog() {
  const data = await shopifyGraphQL(`
    query Catalog {
      products(first: 100, query: "status:active") {
        nodes {
          id
          title
          productType
          featuredMedia { ... on MediaImage { image { url } } }
          variants(first: 50) {
            nodes { id title price barcode sku availableForSale inventoryQuantity }
          }
        }
      }
    }`);

  return data?.products?.nodes || [];
}

// Crée le brouillon de la commande d'échange et réserve le stock.
//
// La réservation expire d'elle-même : si le colis retour n'arrive jamais,
// le stock redevient vendable sans intervention.
//
// L'échange étant gratuit, une remise de 100 % ramène le total à zéro :
// la commande pourra être complétée sans paiement dû.
export async function createExchangeDraft({
  customerId,
  shippingAddress,
  shippingTitle,
  customAttributes,
  email,
  variantIds,
  originOrderName,
  returnId,
  reserveDays = 30
}) {
  const reserveUntil = new Date(Date.now() + reserveDays * 86400000).toISOString();

  const lineItems = variantIds.map((variantId) => ({ variantId, quantity: 1 }));

  const input = {
    email: email || undefined,
    purchasingEntity: customerId ? { customerId } : undefined,
    shippingAddress: shippingAddress || undefined,
    lineItems,
    reserveInventoryUntil: reserveUntil,
    // Même mode de livraison que la commande d'origine, mais à zéro euro :
    // la réexpédition d'un échange est à notre charge.
    shippingLine: shippingTitle
      ? { title: shippingTitle, priceWithCurrency: { amount: '0.00', currencyCode: 'EUR' } }
      : undefined,
    // Les attributs portent parfois le point relais choisi au paiement.
    customAttributes: customAttributes && customAttributes.length ? customAttributes : undefined,
    // À la création, l'identifiant du retour n'existe pas encore : il est
    // posé en tag juste après, une fois l'étiquette assignée.
    tags: returnId ? ['echange', returnId] : ['echange'],
    note: returnId
      ? `Échange sans frais — retour ${returnId} de la commande ${originOrderName}.`
      : `Échange sans frais de la commande ${originOrderName}.`,
    appliedDiscount: {
      valueType: 'PERCENTAGE',
      value: 100,
      title: 'Échange',
      description: `Échange sans frais — commande ${originOrderName}`
    }
  };

  const data = await shopifyGraphQL(
    `mutation CreateDraft($input: DraftOrderInput!) {
      draftOrderCreate(input: $input) {
        draftOrder { id name invoiceUrl reserveInventoryUntil }
        userErrors { field message }
      }
    }`,
    { input }
  );

  const errors = data?.draftOrderCreate?.userErrors || [];
  if (errors.length) {
    throw new Error(`Création du brouillon refusée : ${JSON.stringify(errors)}`);
  }

  return data?.draftOrderCreate?.draftOrder || null;
}

// Transforme le brouillon en vraie commande, à préparer.
// Appelé uniquement à réception du colis retour, jamais avant.
export async function completeExchangeDraft(draftOrderId) {
  const data = await shopifyGraphQL(
    `mutation CompleteDraft($id: ID!) {
      draftOrderComplete(id: $id, paymentPending: false) {
        draftOrder { id name order { id name } }
        userErrors { field message }
      }
    }`,
    { id: draftOrderId }
  );

  const errors = data?.draftOrderComplete?.userErrors || [];
  if (errors.length) {
    throw new Error(`Complétion du brouillon refusée : ${JSON.stringify(errors)}`);
  }

  return data?.draftOrderComplete?.draftOrder?.order || null;
}

// Libère la réservation si le retour est abandonné : le stock redevient
// vendable immédiatement au lieu d'attendre l'expiration.
export async function deleteDraft(draftOrderId) {
  const data = await shopifyGraphQL(
    `mutation DeleteDraft($input: DraftOrderDeleteInput!) {
      draftOrderDelete(input: $input) {
        deletedId
        userErrors { field message }
      }
    }`,
    { input: { id: draftOrderId } }
  );

  const errors = data?.draftOrderDelete?.userErrors || [];
  if (errors.length) {
    throw new Error(`Suppression du brouillon refusée : ${JSON.stringify(errors)}`);
  }

  return data?.draftOrderDelete?.deletedId || null;
}

// Ajoute un tag sans toucher aux autres. tagsAdd est incrémental, là où
// écrire le champ « tags » remplacerait la liste entière.
export async function addOrderTags(orderId, tags) {
  const data = await shopifyGraphQL(
    `mutation AddTags($id: ID!, $tags: [String!]!) {
      tagsAdd(id: $id, tags: $tags) {
        userErrors { field message }
      }
    }`,
    { id: orderId, tags }
  );

  const errors = data?.tagsAdd?.userErrors || [];
  if (errors.length) {
    throw new Error(`Ajout de tag refusé : ${JSON.stringify(errors)}`);
  }
}

export async function removeOrderTags(orderId, tags) {
  const data = await shopifyGraphQL(
    `mutation RemoveTags($id: ID!, $tags: [String!]!) {
      tagsRemove(id: $id, tags: $tags) {
        userErrors { field message }
      }
    }`,
    { id: orderId, tags }
  );

  const errors = data?.tagsRemove?.userErrors || [];
  if (errors.length) {
    throw new Error(`Retrait de tag refusé : ${JSON.stringify(errors)}`);
  }
}

// La note est un champ unique : on la relit et on la complète, sinon on
// efface ce que Shopify ou Luc y avaient écrit.
//
// Chaque retour occupe une ligne préfixée de son identifiant. Une mise à
// jour remplace cette ligne au lieu d'en ajouter une seconde : sans ça, la
// note accumule les versions successives, dont les périmées.
export async function appendOrderNote(orderId, returnId, addition) {
  const data = await shopifyGraphQL(
    `query OrderNote($id: ID!) { order(id: $id) { note } }`,
    { id: orderId }
  );

  const existing = data?.order?.note || '';
  const prefix = `[${returnId}]`;

  const kept = existing
    .split('\n')
    .filter((line) => !line.trim().startsWith(prefix));

  const note = [...kept, addition].filter((l) => l.trim()).join('\n');
  if (note === existing) return;

  const result = await shopifyGraphQL(
    `mutation UpdateNote($input: OrderInput!) {
      orderUpdate(input: $input) {
        userErrors { field message }
      }
    }`,
    { input: { id: orderId, note } }
  );

  const errors = result?.orderUpdate?.userErrors || [];
  if (errors.length) {
    throw new Error(`Écriture de la note refusée : ${JSON.stringify(errors)}`);
  }
}

// Métachamps de suivi du retour, dans l'espace « misu ».
//
// fields : { return_status, return_label, exchange_order, origin_order,
//            settlement }
// settlement est un objet ; il est stocké en JSON pour rester exploitable.
export async function setReturnMetafields(orderId, fields) {
  const metafields = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => ({
      ownerId: orderId,
      namespace: 'misu',
      key,
      type: typeof value === 'object' ? 'json' : 'single_line_text_field',
      value: typeof value === 'object' ? JSON.stringify(value) : String(value)
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
