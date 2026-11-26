// api/exchange-options.js
// Charge une commande pour la page de retour client : articles éligibles,
// délai, et TAILLES DISPONIBLES DU MÊME PRODUIT (sameProductSizes).
//
// MODÈLE DU 18/09/2026 : l'échange ne porte plus que sur une autre taille du
// même modèle — le sélecteur à 3 niveaux (autres modèles, collections) et son
// endpoint /api/exchange-browse ont été supprimés, comme les échanges en
// attente de paiement.
// Ne crée rien — /api/create-return reste le seul endpoint qui écrit.
//
// Renvoie aussi "existingReturns" (miroir de Misü, 11/09) : les retours déjà
// créés pour cette commande, avec leur statut. La page retour-bbp affiche un
// écran "Vos retours en cours" à partir de ce tableau et propose "Modifier
// ce retour" tant que status === "REQUESTED" (colis pas encore reçu) ; figé
// dès que le statut passe à RECEIVED/DISPUTED par receive-return.js.
//
// POST /api/exchange-options
// Body: { order: "C294509", zip: "59680" }

const { shopifyGraphQL } = require("../lib/shopify.cjs");
const { downloadFile, RETURNS_ROOT } = require("../lib/dropbox.cjs");
const { CREDIT_VALIDITY_MONTHS: GIFT_CARD_VALIDITY_MONTHS, expiryDateFor } = require("../lib/store-credit.cjs");

const RETURNS_CSV_PATH = `${RETURNS_ROOT}/RETURNS.csv`;
const INVENTORY_PATH = `${RETURNS_ROOT}/INVENTORY.csv`;
const RETURN_WINDOW_DAYS = 14;
const FALLBACK_WINDOW_DAYS = 21;

function parseCsvLine(line) {
  const cols = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      cols.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  cols.push(current);
  return cols;
}

async function alreadyReturnedLineItemIds(orderName) {
  try {
    const buf = await downloadFile(RETURNS_CSV_PATH);
    const lines = buf.toString("utf-8").trim().split("\n").slice(1).filter(Boolean);
    return new Set(
      lines
        .map((l) => parseCsvLine(l))
        .filter((cols) => cols[1] === orderName)
        .map((cols) => cols[2])
    );
  } catch (e) {
    return new Set();
  }
}

// Construit "Vos retours en cours" pour la commande : un retour par ligne
// INVENTORY.csv (1 étiquette = 1 retour), avec ses articles retrouvés dans
// RETURNS.csv via le return_id. Utilisé par le front pour afficher/permettre
// de modifier un retour tant qu'il n'est pas encore reçu.
async function loadExistingReturns(orderName) {
  let inventoryRows = [];
  try {
    const buf = await downloadFile(INVENTORY_PATH);
    inventoryRows = buf.toString("utf-8").trim().split("\n").slice(1).filter(Boolean).map(parseCsvLine);
  } catch (e) {
    return [];
  }

  let returnsRows = [];
  try {
    const buf = await downloadFile(RETURNS_CSV_PATH);
    returnsRows = buf.toString("utf-8").trim().split("\n").slice(1).filter(Boolean).map(parseCsvLine);
  } catch (e) {
    returnsRows = [];
  }

  return inventoryRows
    .filter((cols) => cols[4] === orderName)
    .map((cols) => {
      const [, trackingNumber, , returnId, , returnStatus] = cols;
      const items = returnsRows
        .filter((r) => r[0] === returnId)
        .map((r) => ({
          lineItemId: r[2],
          title: r[4],
          variantTitle: r[5],
          quantity: parseInt(r[6], 10) || 1,
          reason: r[7],
          comment: r[8],
          action: r[9],
          exchangeTitle: r[11] || null,
        }));
      return {
        returnId,
        status: returnStatus,
        trackingNumber,
        modifiable: returnStatus === "REQUESTED",
        items,
      };
    });
}

module.exports = async (req, res) => {
  // CORS — nécessaire dès que cet endpoint est appelé en fetch() depuis une
  // page du navigateur (domaine boutique) plutôt qu'en curl. Sans ces
  // en-têtes, le navigateur bloque la lecture de la réponse même si le
  // serveur répond correctement (symptôme observé : "Failed to fetch" côté
  // JS malgré une vraie réponse visible côté réseau).
  res.setHeader("Access-Control-Allow-Origin", require("../lib/brand.cjs").siteUrl);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Méthode non autorisée, utiliser POST." });
    return;
  }

  try {
    const { order, zip } = req.body || {};
    if (!order || !zip) {
      res.status(400).json({ ok: false, error: "Paramètres 'order' et 'zip' requis." });
      return;
    }

    const orderName = order.startsWith("#") ? order : `#${order}`;

    const data = await shopifyGraphQL(
      `
      query LoadOrderForReturn($query: String!) {
        orders(first: 1, query: $query) {
          edges {
            node {
              id
              name
              shippingAddress { zip }
              fulfillments(first: 5) { deliveredAt createdAt }
              lineItems(first: 50) {
                edges {
                  node {
                    id
                    name
                    quantity
                    image { url altText }
                    variant {
                      id
                      title
                      price
                      product {
                        id
                        title
                        productType
                        variants(first: 50) {
                          edges {
                            node { id title price availableForSale }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
      `,
      { query: `name:${orderName}` }
    );

    const foundOrder = data.orders.edges[0]?.node;
    if (!foundOrder) {
      res.status(404).json({ ok: false, error: "Commande introuvable." });
      return;
    }

    const normalizedZip = (foundOrder.shippingAddress?.zip || "").replace(/\s/g, "");
    if (normalizedZip !== zip.replace(/\s/g, "")) {
      res.status(404).json({ ok: false, error: "Commande introuvable." });
      return;
    }

    const existingReturns = await loadExistingReturns(foundOrder.name);

    const fulfillment = foundOrder.fulfillments[0];
    if (!fulfillment) {
      res.status(200).json({
        ok: true,
        orderName: foundOrder.name,
        eligible: false,
        reason: "Commande pas encore expédiée.",
        items: [],
        existingReturns,
      });
      return;
    }

    const referenceDate = fulfillment.deliveredAt
      ? new Date(fulfillment.deliveredAt)
      : new Date(fulfillment.createdAt);
    const windowDays = fulfillment.deliveredAt ? RETURN_WINDOW_DAYS : FALLBACK_WINDOW_DAYS;
    const deadline = new Date(referenceDate.getTime() + windowDays * 24 * 60 * 60 * 1000);
    const withinWindow = new Date() <= deadline;

    const engagedLineItemIds = await alreadyReturnedLineItemIds(foundOrder.name);

    const items = foundOrder.lineItems.edges.map((edge) => {
      const node = edge.node;
      const alreadyEngaged = engagedLineItemIds.has(node.id);
      const price = parseFloat(node.variant?.price || "0");
      const product = node.variant?.product;

      // Autres tailles (variantes) du MÊME produit.
      const sameProductSizes = (product?.variants?.edges || [])
        .map((v) => v.node)
        .map((v) => ({
          size: v.title,
          variantId: v.id,
          price: parseFloat(v.price || "0"),
          available: v.availableForSale,
          isCurrent: v.id === node.variant.id,
        }));

      return {
        lineItemId: node.id,
        title: node.name,
        variantTitle: node.variant?.title || "",
        price,
        image: node.image?.url || null,
        quantity: node.quantity,
        eligible: withinWindow && !alreadyEngaged,
        ineligibleReason: !withinWindow
          ? `Délai de retour dépassé (${windowDays} jours).`
          : alreadyEngaged
          ? "Un retour est déjà en cours pour cet article."
          : null,
        productId: product?.id || null,
        productTitle: product?.title || node.name,
        // Les autres tailles du MÊME modèle : seul échange possible depuis le
        // 18/09. Les tailles indisponibles sont renvoyées aussi, grisées côté
        // page, pour que la cliente voie tout l'éventail.
        sameProductSizes,
      };
    });

    // Un seul échange de taille par commande (modèle du 18/09) : la page
    // masque le choix « échange » si un échange a déjà été fait ici.
    const exchangeAlreadyUsed = existingReturns.some((r) =>
      (r.items || []).some((i) => i.action === "exchange")
    );

    res.status(200).json({
      ok: true,
      orderName: foundOrder.name,
      eligible: withinWindow,
      deadline: deadline.toISOString().slice(0, 10),
      items,
      existingReturns,
      exchangeAlreadyUsed,
      // Avoir (carte cadeau) : la page l'annonce AVANT le choix, échéance
      // comprise. Calculée ici pour qu'un changement de durée côté serveur
      // (lib/gift-card.js) n'oblige pas à retoucher la page.
      avoirValidityMonths: GIFT_CARD_VALIDITY_MONTHS,
      avoirExpiryExample: expiryDateFor(),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
};
