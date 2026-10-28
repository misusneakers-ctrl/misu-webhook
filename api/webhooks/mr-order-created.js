// api/webhooks/mr-order-created.js — dépôt misu-webhook (porté de bbp-webhook le 19/10/2026, ES modules)
// Webhook Shopify « Création de commande » (orders/create), format JSON.
//
// 1. Commande Mondial Relay AVEC point choisi dans le panier
//      → écrit le métachamp mondial_relay_app.mondial_relay_pickup_point (format de l'ancienne appli,
//        lu par Mobiltron) et pose le tag « mr-point-panier ».
// 2. Commande Mondial Relay SANS point
//      → tag « point-relais-manquant » ; si MR_RELANCE_ACTIVE = "1", envoie l'événement Klaviyo
//        « Point Relais Manquant Misü » avec le lien vers /pages/point-relais.
// 3. Commande NON Mondial Relay mais avec un point choisi dans le panier (la cliente a changé d'avis)
//      → retire les attributs Mondial Relay pour que le logisticien ne s'y trompe pas.

import * as mr from '../../lib/mondial-relay.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST attendu' });

  let raw;
  try {
    raw = await mr.readRawBody(req);
  } catch (e) {
    return res.status(400).json({ ok: false, error: 'corps illisible' });
  }
  if (!mr.verifyShopifyHmac(raw, req.headers['x-shopify-hmac-sha256'])) {
    console.warn('[mr-order-created] signature invalide');
    return res.status(401).json({ ok: false, error: 'signature invalide' });
  }

  let payload;
  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch (e) {
    return res.status(400).json({ ok: false, error: 'JSON invalide' });
  }

  const orderGid = payload.admin_graphql_api_id || `gid://shopify/Order/${payload.id}`;
  const shippingTitle = (payload.shipping_lines && payload.shipping_lines[0] && payload.shipping_lines[0].title) || '';
  const isMR = mr.isMondialRelayTitle(shippingTitle);
  const attrMap = mr.attrsToMap(payload.note_attributes);
  const cartPoint = mr.pointFromAttributes(attrMap);

  try {
    // Cas 3 : point choisi dans le panier mais autre transporteur au paiement.
    if (!isMR) {
      if (attrMap.mondial_relay_id) {
        const order = await mr.getOrder(orderGid);
        await mr.removePickupAttributes(order);
        return res.status(200).json({ ok: true, action: 'attributs-retires', order: payload.name });
      }
      return res.status(200).json({ ok: true, action: 'ignore', order: payload.name });
    }

    const order = await mr.getOrder(orderGid);
    if (!order) return res.status(200).json({ ok: true, action: 'commande-introuvable' });

    // Cas 1 : point présent.
    if (cartPoint) {
      if (!order.metafield || !order.metafield.value) {
        const official = await mr.lookupPoint(cartPoint.id, cartPoint.zip);
        await mr.writePickupPoint(order, official ? { ...cartPoint, hours: official.hours } : cartPoint);
      }
      await mr.setTags(order.id, [mr.TAG_PANIER], [mr.TAG_MANQUANT]);
      return res.status(200).json({ ok: true, action: 'metachamp-ecrit', order: order.name, point: cartPoint.id });
    }

    // Cas 2 : point manquant. (Pendant la cohabitation avec l'ancienne appli, on ne fait que taguer.)
    if (!(order.tags || []).includes(mr.TAG_MANQUANT)) {
      await mr.setTags(order.id, [mr.TAG_MANQUANT]);
    }
    let relance = 'desactivee';
    if (process.env.MR_RELANCE_ACTIVE === '1' && order.email && !order.cancelledAt) {
      await mr.sendMissingPointEvent({
        email: order.email,
        firstName: order.shippingAddress && order.shippingAddress.firstName,
        orderName: order.name,
        orderId: order.id,
        url: mr.pickupPageUrl(order.id),
      });
      relance = 'envoyee';
    }
    return res.status(200).json({ ok: true, action: 'point-manquant', relance, order: order.name });
  } catch (e) {
    console.error('[mr-order-created]', payload.name, e.message);
    // 500 → Shopify renverra le webhook ; toutes les écritures ci-dessus sont rejouables sans doublon.
    return res.status(500).json({ ok: false, error: e.message });
  }
};

// La signature HMAC se calcule sur le corps brut : on empêche Vercel de le parser avant nous.
export const config = { api: { bodyParser: false } };
