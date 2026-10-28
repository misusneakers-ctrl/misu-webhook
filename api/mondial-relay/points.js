// api/mondial-relay/points.js — dépôt misu-webhook (porté de bbp-webhook le 19/10/2026, ES modules)
// Liste des points relais Mondial Relay les plus proches, pour le panier, la page de
// remerciement (extension bbp-checkout) et la page /pages/point-relais.
//
// GET ?zip=75003            → points autour d'un code postal
// GET ?lat=48.86&lng=2.35   → points autour d'une position (bouton « autour de moi »)
// Réponse : { ok, points: [{ id, name, address, zip, city, lat, lng, locker, hours{monday…} }] }
// Données publiques : CORS ouvert (l'extension de paiement tourne sans origine fixe).

import * as mr from '../../lib/mondial-relay.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET attendu' });

  const q = req.query || {};
  const zip = String(q.zip || '').trim();
  const lat = q.lat != null && q.lat !== '' ? Number(q.lat) : null;
  const lng = q.lng != null && q.lng !== '' ? Number(q.lng) : null;
  const geo = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  if (!/^\d{5}$/.test(zip) && !geo) {
    return res.status(400).json({ ok: false, error: 'Indiquez un code postal à 5 chiffres.' });
  }
  try {
    const points = await mr.searchPoints(geo && !/^\d{5}$/.test(zip) ? { lat, lng, n: q.n || 10 } : { zip, n: q.n || 10 });
    res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
    return res.status(200).json({ ok: true, points });
  } catch (e) {
    console.error('[mr points]', e.message);
    return res.status(502).json({ ok: false, error: 'Recherche Mondial Relay indisponible, réessayez dans un instant.' });
  }
};
