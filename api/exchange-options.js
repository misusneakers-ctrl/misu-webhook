// Renvoie les options d'échange pour une commande : l'article réellement
// commandé (affiché par défaut) et le catalogue actif, avec pour chaque
// taille sa disponibilité réelle.
//
// Aucun produit ni aucune taille n'est écrit en dur : un nouveau drop est
// pris en compte sans toucher à ce fichier.

import { findOrder, getCatalog } from '../lib/shopify.js';

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
      price: Number(v.price),
      available: Boolean(v.availableForSale) && Number(v.inventoryQuantity) > 0
    };
  });

  return {
    productId: node.id,
    title: node.title,
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

    const catalogNodes = await getCatalog();
    const products = catalogNodes.map(buildProduct);

    // Article commandé : on prend la première ligne de la commande.
    // Le prix retenu est celui réellement payé, remise comprise — c'est lui
    // qui servira de base au calcul de la différence lors d'un échange.
    const line = order.lineItems?.nodes?.[0] || null;
    const orderedProductId = line?.product?.id || null;
    const orderedVariant = line?.variant ? splitVariantTitle(line.variant.title) : null;

    const ordered = line
      ? {
          productId: orderedProductId,
          title: line.title,
          size: orderedVariant?.size || null,
          image: line.image?.url || null,
          paidUnitPrice: Number(line.discountedUnitPriceSet?.shopMoney?.amount || 0),
          currency: line.discountedUnitPriceSet?.shopMoney?.currencyCode || 'EUR',
          // Le modèle commandé est-il encore proposé à l'échange ?
          stillAvailable: products.some(
            (p) => p.productId === orderedProductId && p.anyAvailable
          )
        }
      : null;

    return res.status(200).json({
      ordered,
      products,
      hasCustomerAccount: Boolean(order.customer?.id)
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
}
