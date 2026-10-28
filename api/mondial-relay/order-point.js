// api/mondial-relay/order-point.js — dépôt misu-webhook (porté de bbp-webhook le 19/10/2026, ES modules)
// Utilisé par la page Shopify /pages/point-relais (lien envoyé à la cliente après paiement).
//
// GET  ?o=<id commande>&t=<signature>   ou   ?o=<id>&c=<numéro de confirmation>
// POST { o, t | c, point:{id,name,address,zip,city,country} } → enregistre le point relais
//
// Sécurité, deux preuves possibles :
//  - t : signature HMAC de l'id commande (MR_LINK_SECRET), dans le lien de l'e-mail de secours ;
//  - c : numéro de confirmation de la commande, que seule l'acheteuse voit (bouton de la page de
//        remerciement). Vérifié contre Order.confirmationNumber.
// Un point se choisit avant expédition. Il peut être CHANGÉ uniquement depuis la page de
// remerciement (preuve c), dans les MR_CHANGE_WINDOW_MIN minutes (60 par défaut) qui suivent la
// commande et tant qu'elle n'est pas traitée ; la commande reçoit alors le tag mr-point-modifie.
// Au-delà, le point a pu être transmis au logisticien : le changement passe par le service client.

import * as mr from '../../lib/mondial-relay.js';

// CORS ouvert : l'extension de la page de remerciement tourne dans un Web Worker sans origine
// fixe (exigence Shopify). La sécurité repose sur la preuve t ou c, pas sur l'origine.
function cors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
}

function describe(order, viaConfirmation) {
  const attrs = mr.attrsToMap(order.customAttributes);
  const point = mr.pointFromAttributes(attrs);
  const isMR = mr.isMondialRelayTitle(order.shippingLine && order.shippingLine.title);
  const unfulfilled = ['UNFULFILLED', 'SCHEDULED', 'ON_HOLD'].includes(order.displayFulfillmentStatus);
  return {
    order: order.name,
    firstName: (order.shippingAddress && order.shippingAddress.firstName) || '',
    zip: (order.shippingAddress && order.shippingAddress.zip) || '',
    isMR,
    hasPoint: Boolean(point),
    point: point ? { id: point.id, name: point.name, address: point.address, zip: point.zip, city: point.city } : null,
    canChoose: isMR && !point && !order.cancelledAt && unfulfilled,
    canChange: Boolean(viaConfirmation) && isMR && Boolean(point) && !order.cancelledAt && unfulfilled
      && mr.withinChangeWindow(order),
    shipped: !unfulfilled,
    cancelled: Boolean(order.cancelledAt),
  };
}

export default async function handler(req, res) {
  cors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  const input = req.method === 'POST' ? (typeof req.body === 'string' ? safeJson(req.body) : req.body || {}) : req.query || {};
  const o = mr.orderNumericId(input.o);
  const viaSignature = Boolean(input.t);
  if (!o || (!input.t && !input.c) || (viaSignature && !mr.verifyOrderSignature(o, input.t))) {
    return res.status(403).json({ ok: false, error: 'Lien invalide ou expiré.' });
  }

  try {
    const order = await mr.getOrder(o);
    // 404 juste après le paiement : la commande peut mettre quelques secondes à exister. La page réessaie.
    if (!order) return res.status(404).json({ ok: false, retry: true, error: 'Commande en cours d\u2019enregistrement.' });
    if (!viaSignature && !mr.verifyConfirmationNumber(order, input.c)) {
      return res.status(403).json({ ok: false, error: 'Lien invalide ou expiré.' });
    }
    const state = describe(order, !viaSignature);

    if (req.method === 'GET') return res.status(200).json({ ok: true, ...state });
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Méthode non autorisée.' });

    if (!state.canChoose && !state.canChange) {
      const why = state.hasPoint ? 'Un point relais est déjà enregistré pour cette commande. Pour le changer, répondez à l\u2019e-mail de confirmation de commande.'
        : state.cancelled ? 'Cette commande a été annulée.'
        : state.shipped ? 'Cette commande est déjà en préparation ou expédiée.'
        : "Cette commande n'est pas en livraison Mondial Relay.";
      return res.status(409).json({ ok: false, error: why, ...state });
    }

    const check = mr.normalizePoint(input.point);
    if (!check.ok) return res.status(400).json({ ok: false, error: `Point relais refusé : ${check.error}.` });
    // Données officielles (adresse exacte, horaires) relues chez Mondial Relay quand c'est possible.
    const official = await mr.lookupPoint(check.point.id, check.point.zip);
    if (official) check.point = { ...check.point, name: official.name, address: official.address, zip: official.zip, city: official.city, hours: official.hours };

    await mr.writePickupPoint(order, check.point);
    const changed = state.hasPoint && (!state.point || state.point.id !== check.point.id);
    await mr.setTags(order.id, changed ? [mr.TAG_APRES_PAIEMENT, mr.TAG_MODIFIE] : [mr.TAG_APRES_PAIEMENT], [mr.TAG_MANQUANT]);
    if (changed) console.log('[mr order-point] point modifié', order.name, state.point && state.point.id, '→', check.point.id);
    // Arrête le flow Klaviyo de relance (filtre « Point Relais Choisi Misü » zéro fois depuis l'entrée).
    try {
      await mr.sendPointChosenEvent({ email: order.email, orderName: order.name, orderId: order.id, point: check.point });
    } catch (e) { console.warn('[mr order-point] Klaviyo', e.message); }
    const after = describe(await mr.getOrder(o), !viaSignature);
    return res.status(200).json({ ok: true, saved: true, changed, ...after });
  } catch (e) {
    console.error('[mr order-point]', o, e.message);
    return res.status(500).json({ ok: false, error: 'Erreur technique, réessayez dans un instant.' });
  }
};

function safeJson(s) {
  try { return JSON.parse(s); } catch (e) { return {}; }
}
