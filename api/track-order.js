import { findOrder } from '../lib/shopify.js';
import { getCarrierTracking } from '../lib/carrier-tracking.js';

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

    // Anciens métachamps posés par le webhook Smarty365 (désormais retiré —
    // voir historique de transmission). Gardés uniquement en tout dernier
    // recours si l'appel en direct ci-dessous échoue ou n'a encore jamais
    // tourné pour cette commande ; jamais comme source principale, puisqu'ils
    // ne seront plus mis à jour.
    const metafields = Object.fromEntries(
      (order.metafields?.nodes || []).map((m) => [m.key, m.value])
    );

    // Statut réel interrogé en direct auprès du transporteur (Colissimo,
    // Chronopost, Mondial Relay) à partir du seul numéro de suivi déjà connu
    // par Shopify — ne dépend plus de Smarty365 ni d'aucune plateforme
    // d'expédition. Voir lib/carrier-tracking.js.
    let carrierTracking = null;
    if (tracking?.number) {
      try {
        carrierTracking = await getCarrierTracking({
          company: tracking.company,
          trackingNumber: tracking.number,
          zip: zipCode,
        });
      } catch (err) {
        console.error('Suivi transporteur en direct indisponible :', err.message);
      }
    }

    let carrierEvents = carrierTracking?.events || null;
    if (!carrierEvents && metafields.carrier_events) {
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
      carrier: tracking?.company || carrierTracking?.carrier || 'Colissimo',
      shippedAt: fulfillment?.createdAt || null,
      // Statut réel, désormais interrogé en direct à chaque appel (voir
      // lib/carrier-tracking.js) ; retombe sur les anciens métachamps Smarty365
      // seulement si l'appel en direct échoue :
      carrierStatus: carrierTracking
        ? (carrierTracking.delivered ? 'DELIVERED' : 'IN_TRANSIT')
        : (metafields.carrier_status || null),
      carrierStatusLabel: carrierTracking?.statusLabel || metafields.carrier_status_label || null,
      carrierUpdatedAt: carrierTracking ? new Date().toISOString() : (metafields.carrier_updated_at || null),
      carrierStep: carrierTracking?.step ?? null,
      carrierTotalSteps: carrierTracking?.totalSteps ?? null,
      carrierEstimatedDeliveryDate: carrierTracking?.estimatedDeliveryDate || null,
      carrierEvents
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
}
