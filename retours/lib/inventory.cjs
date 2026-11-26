// lib/inventory.js
// Dépôt : bbp-webhook
//
// Remise en stock des articles rendus, à la validation de réception.
//
// Ajout 21/09/2026, demandé par Luc : « quand je reçois les retours, il faut
// que le stock se rajoute, mais uniquement sur Showroom Turbigo ».
//
// EMPLACEMENT. MISÜ remet la paire sur l'emplacement où elle se vend :
// décision de Luc du 26/11/2026 (« même emplacement que les ventes Misü »).
// Ordre de résolution :
//   1. RESTOCK_LOCATION_ID (variable Vercel) si elle est définie ;
//   2. sinon l'emplacement d'expédition de la commande d'origine
//      (fulfillmentOrders.assignedLocation) ;
//   3. sinon RIEN n'est recrédité : la note signale « stock à ajuster à la
//      main ». Mieux vaut ne pas toucher au stock que l'écrire au mauvais endroit.
//
// POURQUOI UN TÉMOIN. Un retour en litige puis rescanné conforme repasse dans
// ce code. Sans témoin, chaque scan rajouterait une unité — et une erreur de
// stock ne se voit pas, elle se découvre trois mois plus tard en rupture
// fantôme. Le témoin est posé AVANT l'appel : si la réponse se perd, le scan
// suivant ne réapplique rien et signale qu'il faut vérifier à la main.
// Sous-créditer se rattrape ; sur-créditer se propage en silence.


// Emplacement de remise en stock pour une commande : variable d'environnement,
// sinon emplacement d'expédition de la commande d'origine. Renvoie null si
// introuvable (l'appelant ne touche alors pas au stock).
async function resolveRestockLocation(shopifyGraphQL, orderId) {
  const fixe = process.env.RESTOCK_LOCATION_ID || null;
  if (fixe) return fixe;
  const data = await shopifyGraphQL(
    `query EmplacementCommande($id: ID!) {
       order(id: $id) {
         fulfillmentOrders(first: 10) { edges { node { assignedLocation { location { id } } } } }
       }
     }`,
    { id: orderId }
  );
  const ids = (data?.order?.fulfillmentOrders?.edges || [])
    .map((e) => e?.node?.assignedLocation?.location?.id)
    .filter(Boolean);
  return ids[0] || null;
}

const NAMESPACE = require("./brand.cjs").metafieldNamespace;
const witnessKey = (returnId) =>
  `restock_${String(returnId).replace(/[^A-Za-z0-9_-]/g, "")}`.slice(0, 60);

// CORRECTIF 29/09, constaté en réel sur R-C294971-1 (commande C294971) :
// l'API Admin 2026-07 refuse désormais `inventoryAdjustQuantities` sans la
// directive `@idempotent` — « The @idempotent directive is required for this
// mutation but was not provided ». Elle se pose sur le CHAMP, pas sur la
// mutation (vérifié contre le schéma : « Directive "@idempotent" may not be
// used on MUTATION »).
//
// La clé doit être DÉTERMINISTE par retour, et c'est un gain, pas une
// contrainte : Shopify reconnaît lui-même un rejeu et ne réapplique pas
// l'ajustement. Le témoin de ce fichier reste la protection principale —
// il couvre aussi le cas où la réponse se perd — mais l'idempotence côté
// Shopify devient un second filet, indépendant du nôtre.
//
// Dérivée du seul identifiant de retour : deux scans du même retour donnent
// la même clé, deux retours différents ne peuvent pas se télescoper.
const idempotencyKeyFor = (returnId) =>
  `misu-restock-${String(returnId).replace(/[^A-Za-z0-9_-]/g, "")}`.slice(0, 255);

async function readWitness(shopifyGraphQL, orderId, returnId) {
  const data = await shopifyGraphQL(
    `query TemoinRestock($id: ID!, $key: String!) {
       order(id: $id) { metafield(namespace: "${NAMESPACE}", key: $key) { value } }
     }`,
    { id: orderId, key: witnessKey(returnId) }
  );
  const raw = data?.order?.metafield?.value;
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    // Témoin illisible : on le traite comme présent. Ne rien faire est le
    // choix sûr — on ne peut pas savoir si le stock a déjà été crédité.
    return { status: "illisible" };
  }
}

async function writeWitness(shopifyGraphQL, orderId, returnId, value) {
  await shopifyGraphQL(
    `mutation PoseTemoinRestock($metafields: [MetafieldsSetInput!]!) {
       metafieldsSet(metafields: $metafields) { userErrors { field message } }
     }`,
    {
      metafields: [
        {
          ownerId: orderId,
          namespace: NAMESPACE,
          key: witnessKey(returnId),
          type: "json",
          value: JSON.stringify(value),
        },
      ],
    }
  );
}

/**
 * Remet en stock les articles reçus, sur l'emplacement de vente MISÜ.
 *
 * @param {Function} shopifyGraphQL
 * @param {Object}   params
 * @param {string}   params.orderId   GID de la commande d'origine
 * @param {string}   params.returnId  ex. "R-C295145-1"
 * @param {Array}    params.lines     [{ inventoryItemId, quantity, title }]
 * @returns {Promise<Object>} { applied, replay, skipped, lines, location, error }
 */
async function restockReceivedItems(shopifyGraphQL, { orderId, returnId, lines, locationId }) {
  let RESTOCK_LOCATION = locationId || null;
  // Regroupement par article d'inventaire : deux lignes du même retour
  // peuvent porter la même variante (deux tailles identiques commandées
  // séparément). Shopify refuse deux changements sur le même couple
  // (inventoryItemId, locationId) — on additionne les deltas.
  const retenues = (lines || []).filter((l) => l && l.inventoryItemId && Number(l.quantity) > 0);
  if (!RESTOCK_LOCATION && retenues.length) {
    try {
      RESTOCK_LOCATION = await resolveRestockLocation(shopifyGraphQL, orderId);
    } catch (e) {
      return { applied: false, replay: false, error: `emplacement introuvable (${String(e.message || e).slice(0, 120)}) — stock NON recrédité, à faire à la main`, lines: [] };
    }
    if (!RESTOCK_LOCATION) {
      return { applied: false, replay: false, error: "emplacement de stock introuvable pour cette commande — stock NON recrédité, à faire à la main (ou définir RESTOCK_LOCATION_ID)", lines: [] };
    }
  }
  const parArticle = new Map();
  for (const l of retenues) {
    parArticle.set(l.inventoryItemId, (parArticle.get(l.inventoryItemId) || 0) + Number(l.quantity));
  }
  const changes = [...parArticle.entries()].map(([inventoryItemId, delta]) => ({
    inventoryItemId,
    locationId: RESTOCK_LOCATION,
    delta,
    // CORRECTIF 22/09, constaté en réel sur R-C295147-1 : l'API Admin 2026-07
    // rejette le changement sans ce champ —
    // « InventoryChangeInput must include the following argument:
    //   changeFromQuantity ». La clé doit être PRÉSENTE, même nulle.
    //
    // `null` désactive volontairement le contrôle compare-and-swap : il
    // faudrait sinon connaître la quantité exacte avant l'ajustement, donc
    // une requête de plus, et un rescan échouerait sur une valeur périmée.
    // C'est sans risque ici : Mobiltron ne touche qu'à son propre
    // emplacement (confirmé par Luc), Turbigo n'a donc pas d'écrivain
    // concurrent, et le double comptage est déjà couvert par le témoin
    // posé par retour plus bas dans ce fichier.
    changeFromQuantity: null,
  }));

  if (!changes.length) {
    return { applied: false, replay: false, skipped: "aucun_article_a_remettre", lines: [] };
  }

  // Témoin : lecture impossible ⇒ on ne touche à rien. Une erreur réseau ne
  // doit pas se traduire par un stock crédité deux fois.
  let witness;
  try {
    witness = await readWitness(shopifyGraphQL, orderId, returnId);
  } catch (e) {
    return {
      applied: false,
      replay: false,
      error: `vérification impossible (${String(e.message || e).slice(0, 160)}) — stock NON recrédité, à faire à la main`,
      lines: [],
    };
  }
  if (witness) {
    return { applied: false, replay: true, witness, lines: [] };
  }

  const engaged = {
    return_id: returnId,
    location: RESTOCK_LOCATION,
    lines: changes.map((c) => ({ inventory_item: c.inventoryItemId, delta: c.delta })),
    engage_a: new Date().toISOString(),
    status: "engage",
  };
  try {
    await writeWitness(shopifyGraphQL, orderId, returnId, engaged);
  } catch (e) {
    return {
      applied: false,
      replay: false,
      error: `témoin non posé (${String(e.message || e).slice(0, 160)}) — stock NON recrédité, à faire à la main`,
      lines: [],
    };
  }

  try {
    await shopifyGraphQL(
      `mutation RemiseEnStock($input: InventoryAdjustQuantitiesInput!, $cleIdempotence: String!) {
         inventoryAdjustQuantities(input: $input) @idempotent(key: $cleIdempotence) {
           inventoryAdjustmentGroup { createdAt reason }
           userErrors { field message }
         }
       }`,
      {
        cleIdempotence: idempotencyKeyFor(returnId),
        input: {
          name: "available",
          reason: "restock",
          referenceDocumentUri: `gid://misu-webhook/Return/${returnId}`,
          changes,
        },
      }
    );
  } catch (e) {
    const message = String(e.message || e).slice(0, 200);
    // On NE retire PAS le témoin : l'ajustement a pu passer malgré l'erreur.
    await writeWitness(shopifyGraphQL, orderId, returnId, {
      ...engaged,
      status: "incertain",
      erreur: message,
    }).catch(() => {});
    return {
      applied: false,
      replay: false,
      error: `${message} — vérifier le stock AVANT de rescanner`,
      lines: [],
    };
  }

  await writeWitness(shopifyGraphQL, orderId, returnId, {
    ...engaged,
    status: "fait",
    fait_a: new Date().toISOString(),
  }).catch(() => {});

  return {
    applied: true,
    replay: false,
    location: RESTOCK_LOCATION,
    lines: retenues.map((l) => ({ title: l.title || null, quantity: Number(l.quantity) })),
  };
}

module.exports = {
  resolveRestockLocation,
  idempotencyKeyFor,
  restockReceivedItems,
};
