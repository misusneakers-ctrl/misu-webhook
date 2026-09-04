import { findOrder } from '../lib/shopify.js';

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', 'https://misu-sneakers.fr');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { orderNumber, zipCode } = req.body || {};
    if (!orderNumber || !zipCode) {
          return res.status(400).json({ error: 'Numéro de commande et code postal requis' });
    }

  try {
        const order = await findOrder(orderNumber, zipCode);
        if (!order) {
                return res.status(404).json({ error: 'Commande non trouvée. Vérifiez le numéro et le code postal.' });
        }

      const fulfillment = order.fulfillments?.[0];
        const tracking = fulfillment?.trackingInfo?.[0];

      let status = 'confirmed';
        if (order.displayFulfillmentStatus === 'FULFILLED' || order.displayFulfillmentStatus === 'PARTIALLY_FULFILLED') {
                status = 'shipped';
        }

      return res.status(200).json({
              orderNumber: order.name,
              status,
              trackingNumber: tracking?.number || null,
              trackingUrl: tracking?.url || null,
              carrier: tracking?.company || 'Colissimo',
              shippedAt: fulfillment?.createdAt || null
      });
  } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'Erreur serveur' });
  }
}
