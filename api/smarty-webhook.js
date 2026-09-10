// Réception des notifications de suivi Smarty365 et mise à jour de la
// commande Shopify correspondante.
//
// Smarty365 pousse un appel à chaque changement de statut coché dans sa
// configuration (EN COURS DE LIVRAISON / LIVRÉ / COLIS RETOURNÉ). On
// retrouve la commande via sa référence, puis on écrit le statut dans un
// métachamp que track-order.js relit pour l'afficher sur /pages/portal.
//
// Le format exact du payload Smarty365 n'a pas pu être confirmé à l'avance
// (documentation développeur non consultable sans session ouverte) : ce
// fichier journalise systématiquement le corps brut reçu dans les logs
// Vercel. Au premier appel réel, vérifie ces logs — si l'extraction
// ci-dessous ne trouve pas la référence de commande ou le statut, les
// noms de champs à ajouter dans pick() seront visibles dans le JSON loggé.

import { findOrderByName, setReturnMetafields } from '../lib/shopify.js';

const STATUS_LABELS = {
  IN_TRANSIT: 'En cours de livraison',
  DELIVERED: 'Livré',
  RETURNED: 'Colis retourné'
};

// Essaie plusieurs noms de champs possibles pour une même information,
// Smarty365 n'ayant pas de documentation publique de son format de payload.
function pick(obj, keys) {
  for (const key of keys) {
    if (obj && obj[key] !== undefined && obj[key] !== null && obj[key] !== '') {
      return obj[key];
    }
  }
  return null;
}

function normalizeStatus(raw) {
  if (!raw) return null;
  const value = String(raw).toUpperCase().replace(/[\s-]+/g, '_');
  if (value.includes('LIVR') || value === 'DELIVERED') return 'DELIVERED';
  if (value.includes('RETOUR') || value === 'RETURNED') return 'RETURNED';
  if (value.includes('TRANSIT') || value.includes('COURS') || value === 'IN_TRANSIT') return 'IN_TRANSIT';
  return null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Secret partagé, à renseigner dans le champ "Header" de la config
  // webhook Smarty365 : { "x-smarty-secret": "la-meme-valeur-que-sur-Vercel" }
  const expectedSecret = process.env.SMARTY365_WEBHOOK_SECRET;
  if (expectedSecret && req.headers['x-smarty-secret'] !== expectedSecret) {
    console.warn('Smarty365 webhook : secret manquant ou incorrect');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const body = req.body || {};

  // Toujours journalisé, même en cas de succès : c'est ce qui permettra de
  // vérifier le format réel dès le premier appel et d'ajuster pick() si
  // les champs ci-dessous ne correspondent pas.
  console.log('Smarty365 webhook reçu :', JSON.stringify(body));

  const orderReference = pick(body, [
    'orderReference', 'order_reference', 'reference', 'orderNumber',
    'order_number', 'clientReference', 'client_reference',
    'externalReference', 'external_reference', 'orderName', 'order_name'
  ]);

  const rawStatus = pick(body, ['status', 'parcelStatus', 'colisStatus', 'state']);
  const status = normalizeStatus(rawStatus);

  const trackingNumber = pick(body, ['trackingNumber', 'tracking_number', 'numero_suivi']);
  const trackingEvents = pick(body, ['events', 'trackingEvents', 'tracking_info', 'suivi']);

  if (!orderReference) {
    console.warn('Smarty365 webhook : aucune référence de commande identifiable dans le payload');
    return res.status(200).json({ received: true, matched: false, reason: 'no_reference' });
  }

  if (!status) {
    console.warn(`Smarty365 webhook : statut non reconnu (${rawStatus})`);
    return res.status(200).json({ received: true, matched: false, reason: 'unknown_status' });
  }

  try {
    const order = await findOrderByName(orderReference);
    if (!order) {
      console.warn(`Smarty365 webhook : commande introuvable pour la référence ${orderReference}`);
      return res.status(200).json({ received: true, matched: false, reason: 'order_not_found' });
    }

    await setReturnMetafields(order.id, {
      carrier_status: status,
      carrier_status_label: STATUS_LABELS[status],
      carrier_updated_at: new Date().toISOString(),
      carrier_tracking_number: trackingNumber || undefined,
      carrier_events: trackingEvents || undefined
    });

    return res.status(200).json({ received: true, matched: true, order: order.name, status });
  } catch (err) {
    console.error('Smarty365 webhook : erreur lors de la mise à jour Shopify', err);
    // 200 quand même : on ne veut pas que Smarty365 réessaie en boucle sur
    // une erreur qui ne se résoudra pas toute seule côté Shopify. L'erreur
    // reste visible dans les logs Vercel pour diagnostic.
    return res.status(200).json({ received: true, matched: false, error: true });
  }
}
