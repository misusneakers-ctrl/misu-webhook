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

    // Statut réel remonté par Smarty365 via webhook (api/smarty-webhook.js),
    // stocké en métachamp sur la commande. Absent tant qu'aucune notification
    // n'a encore été reçue pour cette commande — les champs restent alors null,
    // sans casser l'affichage existant (lien de suivi transporteur inchangé).
    const metafields = Object.fromEntries(
      (order.metafields?.nodes || []).map((m) => [m.key, m.value])
    );

    let carrierEvents = null;
    if (metafields.carrier_events) {
      try {
        carrierEvents = JSON.parse(metafields.carrier_events);
      } catch {
        carrierEvents = metafields.carrier_events;
      }
    }

    return res.status(200).json({
      orderNumber: order.name,
      status,
      trackingNumber: tracking?.number || metafields.carrier_tracking_number || null,
      trackingUrl: tracking?.url || null,
      carrier: tracking?.company || 'Colissimo',
      shippedAt: fulfillment?.createdAt || null,
      // Nouveaux champs, alimentés par le webhook Smarty365 :
      carrierStatus: metafields.carrier_status || null,           // IN_TRANSIT | DELIVERED | RETURNED
      carrierStatusLabel: metafields.carrier_status_label || null, // "En cours de livraison" / "Livré" / "Colis retourné"
      carrierUpdatedAt: metafields.carrier_updated_at || null,     // ISO 8601
      carrierEvents                                                 // détail du suivi si Smarty365 le fournit, sinon null
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
}
