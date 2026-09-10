// Réception des notifications de suivi Smarty365 et mise à jour de la
// commande Shopify correspondante.
//
// Format réel confirmé par les logs Vercel (premier appel en production) :
// le corps est un TABLEAU de colis, chacun avec seulement trackingNumber,
// status et traces — aucune référence de commande n'est fournie. On
// retrouve donc la commande via son numéro de suivi
// (findOrderByTrackingNumber dans lib/shopify.js), pas via un numéro de
// commande.
//
// Statuts observés en réel jusqu'ici : ARRIVED, DELIVERING. LIVRÉ et COLIS
// RETOURNÉ (les 2 autres cases cochées dans la config Smarty365) n'ont pas
// encore été observés : dès qu'un exemple réel apparaît dans les logs
// Vercel, ajoute son code exact dans STATUS_LABELS ci-dessous.

import { findOrderByTrackingNumber, setReturnMetafields } from '../lib/shopify.js';

const STATUS_LABELS = {
  ARRIVED: 'Colis pris en charge par Smarty365',
  DELIVERING: 'En cours de livraison',
  DELIVERED: 'Livré',
  RETURNED: 'Colis retourné'
};

// Correspondance directe avec les codes Smarty365. Un code non reconnu
// n'est pas perdu : il est journalisé et renvoyé tel quel (préfixé RAW_
// pour le statut, libellé brut Smarty365 pour l'affichage), ce qui permet
// de repérer un nouveau code dès son premier appel réel sans casser
// l'affichage côté portail.
function normalizeStatus(raw) {
  if (!raw) return { code: null, label: null };
  const value = String(raw).trim().toUpperCase();
  if (STATUS_LABELS[value]) return { code: value, label: STATUS_LABELS[value] };
  return { code: `RAW_${value}`, label: String(raw) };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Secret partagé, renseigné dans le champ "Header" de la config webhook
  // Smarty365 : { "x-smarty-secret": "la-meme-valeur-que-sur-Vercel" }
  const expectedSecret = process.env.SMARTY365_WEBHOOK_SECRET;
  if (expectedSecret && req.headers['x-smarty-secret'] !== expectedSecret) {
    console.warn('Smarty365 webhook : secret manquant ou incorrect');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const body = req.body || {};

  // Toujours journalisé : c'est ce qui a permis de découvrir le format réel
  // et ce qui permettra de repérer un futur statut non reconnu.
  console.log('Smarty365 webhook reçu :', JSON.stringify(body));

  const parcels = Array.isArray(body) ? body : [body];
  const results = [];

  for (const parcel of parcels) {
    const trackingNumber = parcel?.trackingNumber;

    if (!trackingNumber) {
      console.warn('Smarty365 webhook : colis sans trackingNumber, ignoré :', JSON.stringify(parcel));
      results.push({ matched: false, reason: 'no_tracking_number' });
      continue;
    }

    const { code: status, label: statusLabel } = normalizeStatus(parcel.status);

    try {
      const order = await findOrderByTrackingNumber(trackingNumber);

      if (!order) {
        console.warn(`Smarty365 webhook : aucune commande trouvée pour le suivi ${trackingNumber}`);
        results.push({ matched: false, trackingNumber, reason: 'order_not_found' });
        continue;
      }

      await setReturnMetafields(order.id, {
        carrier_status: status,
        carrier_status_label: statusLabel,
        carrier_updated_at: new Date().toISOString(),
        carrier_tracking_number: trackingNumber,
        carrier_events: Array.isArray(parcel.traces) ? parcel.traces : undefined
      });

      results.push({ matched: true, order: order.name, trackingNumber, status });
    } catch (err) {
      console.error(`Smarty365 webhook : erreur lors de la mise à jour pour ${trackingNumber}`, err);
      results.push({ matched: false, trackingNumber, error: true });
    }
  }

  // 200 dans tous les cas, même si un colis du tableau n'a pas matché :
  // Smarty365 ne doit pas réessayer en boucle tout le tableau à cause d'un
  // seul colis introuvable. Le détail par colis reste dans results et dans
  // les logs Vercel pour diagnostic.
  return res.status(200).json({ received: true, results });
}
