import { findOrder, getDeliveredAt } from '../lib/shopify.js';
import { assignLabel } from '../lib/dropbox.js';
import { sendReturnEvent } from '../lib/klaviyo.js';

// Les PDF d'étiquettes sont hébergés dans les fichiers Shopify.
// Shopify a remplacé les espaces par des underscores à l'upload, et ajoute
// un paramètre de version propre à chaque fichier : les URLs sont donc
// écrites telles quelles, et non reconstruites. Si une étiquette est
// réuploadée un jour, son URL change et doit être mise à jour ici.
const LABEL_BASE =
  'https://cdn.shopify.com/s/files/1/1018/0562/1630/files/202609021636-10-Bons_Baisers_de_Paname-part-';

const LABEL_URLS = {
  1: `${LABEL_BASE}1.pdf?v=1788520026`,
  2: `${LABEL_BASE}2.pdf?v=1788520026`,
  3: `${LABEL_BASE}3.pdf?v=1788520026`,
  4: `${LABEL_BASE}4.pdf?v=1788520026`,
  5: `${LABEL_BASE}5.pdf?v=1788520026`,
  6: `${LABEL_BASE}6.pdf?v=1788520026`,
  7: `${LABEL_BASE}7.pdf?v=1788520025`,
  8: `${LABEL_BASE}8.pdf?v=1788520026`,
  9: `${LABEL_BASE}9.pdf?v=1788520026`,
  10: `${LABEL_BASE}10.pdf?v=1788520026`
};

// Droit de rétractation : 14 jours calendaires à compter de la RÉCEPTION
// (art. L221-18, repris à l'article 6 des CGV).
// Quand la date de livraison n'est pas remontée par le transporteur, on
// estime 7 jours d'acheminement et on compte donc 21 jours depuis
// l'expédition — volontairement plus large, pour ne jamais être plus
// restrictif que ce qu'annoncent les CGV.
const RETURN_WINDOW_DAYS = 14;
const ESTIMATED_DELIVERY_DAYS = 7;
const DEPOSIT_DEADLINE = '3 jours';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://misu-sneakers.fr');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { orderNumber, zipCode, returnType, product, size } = req.body || {};

  if (!orderNumber || !zipCode || !returnType) {
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

    const deliveredAt = getDeliveredAt(order);
    const daysSince = (date) => Math.floor((new Date() - new Date(date)) / 86400000);

    let expired;
    let daysAgo;
    if (deliveredAt) {
      daysAgo = daysSince(deliveredAt);
      expired = daysAgo > RETURN_WINDOW_DAYS;
    } else {
      daysAgo = daysSince(fulfillment.createdAt);
      expired = daysAgo > RETURN_WINDOW_DAYS + ESTIMATED_DELIVERY_DAYS;
    }

    if (expired) {
      const repere = deliveredAt
        ? `Votre commande a été livrée il y a ${daysAgo} jours`
        : `Votre commande a été expédiée il y a ${daysAgo} jours`;
      return res.status(400).json({
        error: `Le délai de retour est dépassé. ${repere}, au-delà des 14 jours prévus par nos conditions générales de vente. Nous ne pouvons donc pas accepter ce retour.`
      });
    }

    const label = await assignLabel(order.name);
    if (!label) {
      return res
        .status(500)
        .json({ error: "Plus d'étiquettes disponibles. Contactez le support." });
    }

    const labelUrl = LABEL_URLS[Number(label.label_number)] || null;

    // Si le PDF est introuvable, on continue quand même : la cliente reçoit
    // au moins son numéro de suivi, et l'anomalie est visible dans les logs.
    if (!labelUrl) {
      console.error(
        `Aucune URL de PDF pour l'étiquette ${label.label_number} (commande ${order.name})`
      );
    }

    // Alerte quand le stock d'étiquettes s'épuise.
    if (typeof label.remaining === 'number' && label.remaining <= 3) {
      console.error(
        `Stock d'étiquettes bas : ${label.remaining} restantes après la commande ${order.name}`
      );
    }

    await sendReturnEvent(order.email, {
      orderNumber: order.name,
      returnType,
      product: product || null,
      size: size || null,
      trackingNumber: label.tracking_number,
      labelNumber: label.label_number,
      labelUrl,
      depositDeadline: DEPOSIT_DEADLINE
    });

    return res.status(200).json({
      success: true,
      trackingNumber: label.tracking_number,
      labelUrl,
      depositDeadline: DEPOSIT_DEADLINE,
      reused: Boolean(label.reused),
      deliveredAt: deliveredAt || null
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
}
