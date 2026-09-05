// Tout ce dont la page de retour a besoin en un seul appel :
//   - les articles de la commande, avec ce qui reste retournable
//   - le catalogue actif pour les échanges
//   - les retours déjà en cours sur cette commande
//
// Aucun produit ni aucune taille n'est écrit en dur : un nouveau drop est
// pris en compte sans toucher à ce fichier.

import { findOrder, getCatalog, getDeliveredAt } from '../lib/shopify.js';
import { getReturnsForOrder } from '../lib/dropbox.js';

const RETURN_WINDOW_DAYS = 14;
const ESTIMATED_DELIVERY_DAYS = 7;

// "NOIR / 38" -> { color: "NOIR", size: "38" }
function splitVariantTitle(title) {
  const parts = String(title || '').split('/');
  const size = parts[parts.length - 1].trim();
  const color = parts.slice(0, -1).join('/').trim();
  return { color, size };
}

function buildProduct(node) {
  const sizes = node.variants.nodes.map((v) => {
    const { size } = splitVariantTitle(v.title);
    return {
      size,
      variantId: v.id,
      barcode: v.barcode || null,
      price: Number(v.price),
      available: Boolean(v.availableForSale) && Number(v.inventoryQuantity) > 0
    };
  });

  return {
    productId: node.id,
    title: node.title,
    productType: node.productType || '',
    // "MISÜ 01 - Black" -> "Black"
    color: node.title.includes(' - ') ? node.title.split(' - ').pop().trim() : node.title,
    image: node.featuredMedia?.image?.url || null,
    sizes,
    anyAvailable: sizes.some((s) => s.available)
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://misu-sneakers.fr');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { orderNumber, zipCode } = req.body || {};
  if (!orderNumber || !zipCode) {
    return res.status(400).json({ error: 'Champs manquants' });
  }

  try {
    const order = await findOrder(orderNumber, zipCode);
    if (!order) {
      return res
        .status(404)
        .json({ error: 'Commande non trouvée. Vérifiez le numéro et le code postal.' });
    }

    const fulfillment = order.fulfillments?.[0];
    if (!fulfillment) {
      return res.status(400).json({ error: "Cette commande n'a pas encore été expédiée." });
    }

    // Délai calculé depuis la réception quand le transporteur l'a remontée,
    // sinon depuis l'expédition avec 7 jours d'acheminement estimés.
    const deliveredAt = getDeliveredAt(order);
    const daysSince = (date) => Math.floor((new Date() - new Date(date)) / 86400000);
    const daysAgo = daysSince(deliveredAt || fulfillment.createdAt);
    const limit = deliveredAt
      ? RETURN_WINDOW_DAYS
      : RETURN_WINDOW_DAYS + ESTIMATED_DELIVERY_DAYS;

    if (daysAgo > limit) {
      const repere = deliveredAt
        ? `Votre commande a été livrée il y a ${daysAgo} jours`
        : `Votre commande a été expédiée il y a ${daysAgo} jours`;
      return res.status(400).json({
        error: `Le délai de retour est dépassé. ${repere}, au-delà des 14 jours prévus par nos conditions générales de vente. Nous ne pouvons donc pas accepter ce retour.`
      });
    }

    const [catalogNodes, existingReturns] = await Promise.all([
      getCatalog(),
      getReturnsForOrder(order.name)
    ]);

    const products = catalogNodes.map(buildProduct);

    // Quantités déjà engagées dans un retour, ligne par ligne. Une cliente
    // qui a demandé le retour d'une paire sur deux peut encore retourner
    // l'autre, mais pas réclamer deux fois la même.
    const engaged = new Map();
    existingReturns.forEach((r) =>
      r.items.forEach((i) => {
        if (!i.lineItemId) return;
        engaged.set(i.lineItemId, (engaged.get(i.lineItemId) || 0) + (i.quantity || 1));
      })
    );

    const items = (order.lineItems?.nodes || []).map((line) => {
      const variant = line.variant ? splitVariantTitle(line.variant.title) : null;
      const already = engaged.get(line.id) || 0;
      const remaining = Math.max(0, Number(line.quantity || 1) - already);

      return {
        lineItemId: line.id,
        title: line.title,
        productId: line.product?.id || null,
        productType: line.product?.productType || '',
        variantTitle: line.variant?.title || '',
        size: variant?.size || null,
        barcode: line.variant?.barcode || null,
        image: line.image?.url || null,
        quantity: Number(line.quantity || 1),
        returnable: remaining,
        paidUnitPrice: Number(line.discountedUnitPriceSet?.shopMoney?.amount || 0),
        currency: line.discountedUnitPriceSet?.shopMoney?.currencyCode || 'EUR'
      };
    });

    return res.status(200).json({
      orderName: order.name,
      deliveredAt: deliveredAt || null,
      items,
      // Rien de retournable : tout est déjà engagé dans un retour existant.
      anyReturnable: items.some((i) => i.returnable > 0),
      products,
      existingReturns,
      hasCustomerAccount: Boolean(order.customer?.id)
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
}
