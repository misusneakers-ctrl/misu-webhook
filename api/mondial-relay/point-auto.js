// api/mondial-relay/point-auto.js — dépôt misu-webhook (porté de bbp-webhook le 19/10/2026, ES modules)
//
// POINT RELAIS ATTRIBUÉ D'OFFICE (Luc, 14/10/2026). Règles : lib/mr-point-auto.js.
//
// Cron Vercel toutes les 10 min : « Authorization: Bearer <CRON_SECRET> ».
// À la main (navigateur) :
//   /api/mondial-relay/point-auto?token=<CRON_SECRET>                 → aperçu de toutes les commandes en attente
//   /api/mondial-relay/point-auto?token=…&commande=C295881            → aperçu d'une commande
//   /api/mondial-relay/point-auto?token=…&commande=C295881&ecrire=1   → attribue pour cette commande, même avant
//                                                                       l'allumage général (le délai d'1 h s'applique)
//
// ÉCRITURE : seulement si MR_POINT_AUTO = "1" sur Vercel (ou ecrire=1 sur une commande nommée).
// Sinon tout tourne à blanc : on renvoie le point qui SERAIT choisi, sans rien écrire.

import * as mr from '../../lib/mondial-relay.js';
import * as auto from '../../lib/mr-point-auto.js';
import { checkAdminToken } from '../../lib/admin-auth.js';

const Q_ATTENTE = `query($q: String!) { orders(first: 50, query: $q, sortKey: CREATED_AT) { nodes { id name } } }`;

async function traiter(ref, { ecrire, maintenant }) {
  const order = await mr.getOrder(ref.id);
  const e = auto.eligible(order, {
    maintenant,
    isMondialRelayTitle: mr.isMondialRelayTitle,
    pointFromAttributes: mr.pointFromAttributes,
    attrsToMap: mr.attrsToMap,
  });
  if (!e.ok) return { commande: ref.name, statut: 'ignoree', ...e };

  const adresse = order.shippingAddress || {};
  const domicile = await auto.geocoder(adresse);
  let points = [];
  try {
    // 15 au plus : au-delà, Mondial Relay ne renvoie plus rien (constaté le 14/10).
    if (domicile) points = await mr.searchPoints({ lat: domicile.lat, lng: domicile.lng, n: mr.MR_MAX_RESULTATS });
    if (!points.length) points = await mr.searchPoints({ zip: adresse.zip, n: mr.MR_MAX_RESULTATS });
  } catch (err) {
    return { commande: order.name, statut: 'erreur', raison: 'recherche_mondial_relay', detail: String(err.message || err).slice(0, 120) };
  }
  const choix = auto.choisirPoint(points, domicile);
  if (!choix.point) return { commande: order.name, statut: 'sans_choix', raison: choix.raison };

  const resume = {
    commande: order.name,
    code_postal: adresse.zip || null,
    geocodage: domicile ? domicile.precision || 'ok' : 'echec_code_postal_seul',
    point: { id: choix.point.id, name: choix.point.name, address: choix.point.address, zip: choix.point.zip, city: choix.point.city },
    distance_km: choix.distance_km,
    raison: choix.raison,
    samedi: choix.profil.samedi,
    soirs_apres_18h: choix.profil.soirs,
    plus_proche: choix.plus_proche,
  };
  if (!ecrire) return { ...resume, statut: 'a_blanc' };

  // Relecture juste avant d'écrire : la cliente a pu choisir entre-temps.
  const frais = await mr.getOrder(order.id);
  const e2 = auto.eligible(frais, {
    maintenant: Date.now(),
    isMondialRelayTitle: mr.isMondialRelayTitle,
    pointFromAttributes: mr.pointFromAttributes,
    attrsToMap: mr.attrsToMap,
  });
  if (!e2.ok) return { ...resume, statut: 'ignoree', raison: e2.raison };

  const p = choix.point;
  await mr.writePickupPoint(frais, { id: p.id, name: p.name, address: p.address, zip: p.zip, city: p.city, country: p.country || 'FR', hours: p.hours });
  await mr.setTags(frais.id, [auto.TAG_AUTO], [mr.TAG_MANQUANT]);
  let email = 'non_envoye';
  try {
    const ok = await mr.sendPointAttribueEvent({
      email: frais.email,
      firstName: adresse.firstName,
      orderName: frais.name,
      orderId: frais.id,
      point: p,
      horaires: auto.horairesLisibles(p.hours),
    });
    email = ok ? 'evenement_klaviyo_envoye' : 'pas_d_email';
  } catch (err) {
    email = `echec_klaviyo : ${String(err.message || err).slice(0, 80)}`;
  }
  return { ...resume, statut: 'attribue', email };
}

export default async function handler(req, res) {
  const refus = checkAdminToken(req);
  if (refus) return res.status(refus.status).json({ ok: false, error: refus.error });

  const q = req.query || {};
  const general = process.env.MR_POINT_AUTO === '1';
  const maintenant = Date.now();
  try {
    let refs;
    if (q.commande) {
      const o = await mr.adminGraphql(Q_ATTENTE, { q: `name:${String(q.commande).replace(/^#/, '')}` });
      refs = (o.orders && o.orders.nodes) || [];
    } else {
      const depuis = new Date(maintenant - auto.AGE_MAX_JOURS * 86400000).toISOString();
      const o = await mr.adminGraphql(Q_ATTENTE, { q: `tag:'${mr.TAG_MANQUANT}' created_at:>='${depuis}' status:open fulfillment_status:unshipped` });
      refs = (o.orders && o.orders.nodes) || [];
    }
    let ecrire = general || (Boolean(q.commande) && q.ecrire === '1');
    // Pas d'attribution sans e-mail à la cliente : un flow Klaviyo ACTIF doit être branché sur
    // « Point Relais Attribué Misü » (MR_POINT_AUTO_SANS_EMAIL = "1" pour passer outre).
    let klaviyo = null;
    if (ecrire && process.env.MR_POINT_AUTO_SANS_EMAIL !== '1') {
      try {
        await mr.amorcerMetriquePointAttribue();
        klaviyo = await mr.fluxPointAttribueActif();
      } catch (err) {
        klaviyo = { actif: false, raison: `klaviyo_injoignable : ${String(err.message || err).slice(0, 80)}` };
      }
      if (!klaviyo.actif) {
        console.log(`[mr-point-auto] écriture suspendue : pas de flow Klaviyo actif (${klaviyo.raison})`);
        ecrire = false;
      }
    }
    const resultats = [];
    for (const ref of refs.slice(0, 20)) {
      try {
        resultats.push(await traiter(ref, { ecrire, maintenant }));
      } catch (err) {
        resultats.push({ commande: ref.name, statut: 'erreur', detail: String(err.message || err).slice(0, 160) });
      }
    }
    const attribues = resultats.filter((r) => r.statut === 'attribue').length;
    if (resultats.length) console.log(`[mr-point-auto] ${ecrire ? 'écriture' : 'à blanc'} : ${resultats.length} commande(s), ${attribues} attribuée(s)`);
    // Une ligne par commande : lisible dans les logs Vercel, sans secret (aucune donnée personnelle hors n° de commande et CP).
    for (const r of resultats) {
      console.log(`[mr-point-auto] ${r.commande} ${r.statut}${r.raison ? ' (' + r.raison + ')' : ''}`
        + (r.point ? ` → ${r.point.id} ${r.point.name} ${r.point.zip}, ${r.distance_km ?? '?'} km, samedi ${r.samedi ? 'oui' : 'non'}, soirs ${r.soirs_apres_18h}/5` : '')
        + (r.email ? ` — ${r.email}` : ''));
    }
    return res.status(200).json({ ok: true, mode: ecrire ? 'ecriture' : 'a_blanc', allume: general, klaviyo, commandes: resultats });
  } catch (err) {
    console.error('[mr-point-auto]', err.message);
    return res.status(500).json({ ok: false, error: String(err.message || err).slice(0, 200) });
  }
};
