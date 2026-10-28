// lib/mr-point-auto.js
// Dépôt : misu-webhook (porté de bbp-webhook le 19/10/2026)
//
// POINT RELAIS ATTRIBUÉ D'OFFICE (Luc, 14/10/2026, 19 h 29)
// « Pour le cas où la personne n'envoie toujours pas son point relais malgré la
// page checkout, la page thank you et le mail, au bout d'une heure, on prend le
// point relais le plus proche de chez elle, avec l'amplitude horaire la plus
// large, c'est-à-dire ouvert le samedi et après 18 h. »
//
// RÈGLE DE CHOIX (fonctions pures, testées par scripts/test-mr-point-auto.js)
//  1. On part de l'adresse de livraison de la cliente : géocodée par la Base
//     Adresse Nationale (api-adresse.data.gouv.fr, service public gratuit).
//     Si le géocodage échoue, on cherche autour du code postal.
//  2. On écarte les points indisponibles (Available = false, en congés…) et,
//     sauf s'il n'y a rien d'autre, les lockers : une boîte de bottes n'y tient
//     pas toujours, et la cliente n'a rien choisi.
//  3. Parmi les points à distance raisonnable du plus proche (écart ≤ 2 km,
//     MR_AUTO_ECART_KM), on prend le PLUS PROCHE qui est ouvert le samedi ET
//     ferme après 18 h au moins 4 jours sur 5 en semaine.
//  4. Si aucun ne remplit les deux conditions, on prend dans la même zone celui
//     qui a la plus grande amplitude (samedi d'abord, puis le soir, puis le
//     nombre d'heures d'ouverture par semaine).
//
// GARDE-FOUS (orchestration : api/mondial-relay/point-auto.js)
//  - seulement une commande Mondial Relay, sans point, non annulée, non
//    expédiée, passée depuis plus de 60 min (MR_AUTO_DELAI_MIN) et moins de
//    3 jours ;
//  - jamais si Mobiltron l'a déjà importée (tag WMS_*) : il ne revient pas
//    sur une commande ;
//  - commande relue juste avant d'écrire : si un point est arrivé entre-temps,
//    on ne touche à rien ;
//  - n'écrit QUE si MR_POINT_AUTO = "1" sur Vercel (sinon : à blanc, on dit
//    seulement quel point serait choisi).

const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const SEMAINE = ["monday", "tuesday", "wednesday", "thursday", "friday"];
const SOIR_MIN = 18 * 60;           // « après 18 h » : ferme strictement après 18 h 00
const SOIRS_REQUIS = 4;             // au moins 4 soirs sur 5 (beaucoup de commerces ferment le lundi)
const ECART_KM = Number(process.env.MR_AUTO_ECART_KM || 2);
const DELAI_MIN = Number(process.env.MR_AUTO_DELAI_MIN || 60);
const AGE_MAX_JOURS = 3;
const TAG_AUTO = "mr-point-auto";

/** "10:00 - 13:00 | 15:30 - 20:00" → [[600, 780], [930, 1200]] ; "Closed" / "" → []. */
function creneaux(texte) {
  const out = [];
  const re = /(\d{1,2})[:h](\d{2})\s*-\s*(\d{1,2})[:h](\d{2})/gi;
  let m;
  while ((m = re.exec(String(texte || "")))) {
    const a = Number(m[1]) * 60 + Number(m[2]);
    let b = Number(m[3]) * 60 + Number(m[4]);
    if (b === 0) b = 24 * 60; // « 00:00 » en fin = minuit
    if (b > a) out.push([a, b]);
  }
  return out;
}

/** Profil horaire d'un point : samedi, soirs, minutes par semaine. */
function profilHoraires(hours) {
  const h = hours || {};
  const parJour = {};
  for (const d of DAYS) parJour[d] = creneaux(h[d]);
  const fermeture = (d) => parJour[d].reduce((max, [, b]) => Math.max(max, b), 0);
  const samedi = parJour.saturday.length > 0;
  const soirs = SEMAINE.filter((d) => fermeture(d) > SOIR_MIN).length;
  const minutes = DAYS.reduce((s, d) => s + parJour[d].reduce((t, [a, b]) => t + (b - a), 0), 0);
  const connu = DAYS.some((d) => parJour[d].length > 0);
  return { samedi, soirs, minutes, connu, large: samedi && soirs >= SOIRS_REQUIS };
}

function distanceKm(a, b) {
  if (!a || !b || a.lat == null || a.lng == null || b.lat == null || b.lng == null) return null;
  const R = 6371;
  const rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(s)) * 1000) / 1000;
}

/**
 * Choisit le point à attribuer.
 * @param {Array} points  résultats de searchPoints (ordre Mondial Relay = proximité du centre de recherche)
 * @param {{lat,lng}|null} domicile  coordonnées de l'adresse de livraison, si connues
 * @returns {{ point, raison, distance_km, profil, candidats } | { point: null, raison }}
 */
function choisirPoint(points, domicile, { ecartKm = ECART_KM } = {}) {
  const tous = (points || [])
    .filter((p) => p && /^\d{6}$/.test(String(p.id || "")))
    .map((p, rang) => ({ p, rang, d: distanceKm(domicile, p), profil: profilHoraires(p.hours) }));
  if (!tous.length) return { point: null, raison: "aucun_point_trouve" };

  const ouverts = tous.filter((x) => x.p.available !== false && !x.p.warning);
  if (!ouverts.length) return { point: null, raison: "aucun_point_disponible" };
  const horsLocker = ouverts.filter((x) => !x.p.locker);
  const base = horsLocker.length ? horsLocker : ouverts;

  // Tri par distance réelle si on connaît le domicile, sinon ordre Mondial Relay.
  const parDistance = base.slice().sort((x, y) =>
    (x.d != null && y.d != null) ? (x.d - y.d) || (x.rang - y.rang) : (x.rang - y.rang));
  const plusProche = parDistance[0];
  const zone = parDistance.filter((x) => x.d == null || plusProche.d == null || x.d <= plusProche.d + ecartKm);

  const resume = (x, raison) => ({
    point: x.p,
    raison,
    distance_km: x.d,
    profil: x.profil,
    plus_proche: { id: plusProche.p.id, name: plusProche.p.name, distance_km: plusProche.d },
    candidats: zone.length,
    locker: Boolean(x.p.locker),
  });

  const large = zone.find((x) => x.profil.large);
  if (large) return resume(large, horsLocker.length ? "plus_proche_ouvert_samedi_et_apres_18h" : "locker_faute_de_point");

  // Personne n'est ouvert le samedi ET le soir : la plus grande amplitude de la zone.
  const meilleur = zone.slice().sort((x, y) =>
    (y.profil.samedi - x.profil.samedi)
    || (y.profil.soirs - x.profil.soirs)
    || (y.profil.minutes - x.profil.minutes)
    || ((x.d ?? x.rang) - (y.d ?? y.rang)))[0];
  return resume(meilleur, horsLocker.length ? "plus_grande_amplitude_de_la_zone" : "locker_faute_de_point");
}

/**
 * La commande peut-elle recevoir un point d'office maintenant ?
 * @param {object} order  { createdAt, cancelledAt, displayFulfillmentStatus, tags, shippingLine, customAttributes, metafield }
 */
function eligible(order, { maintenant = Date.now(), delaiMin = DELAI_MIN, isMondialRelayTitle, pointFromAttributes, attrsToMap } = {}) {
  if (!order) return { ok: false, raison: "commande_introuvable" };
  const tags = order.tags || [];
  if (order.cancelledAt) return { ok: false, raison: "annulee" };
  if (!isMondialRelayTitle(order.shippingLine && order.shippingLine.title)) return { ok: false, raison: "pas_mondial_relay" };
  if (pointFromAttributes(attrsToMap(order.customAttributes))) return { ok: false, raison: "point_deja_choisi" };
  if (!["UNFULFILLED", "SCHEDULED", "ON_HOLD"].includes(String(order.displayFulfillmentStatus || "").toUpperCase())) return { ok: false, raison: "deja_traitee" };
  if (tags.some((t) => /^WMS_/i.test(t))) return { ok: false, raison: "deja_importee_par_mobiltron" };
  if (tags.includes(TAG_AUTO)) return { ok: false, raison: "deja_attribue" };
  const age = maintenant - Date.parse(order.createdAt);
  if (!Number.isFinite(age)) return { ok: false, raison: "date_illisible" };
  if (age < delaiMin * 60000) return { ok: false, raison: "trop_tot", attendre_min: Math.ceil((delaiMin * 60000 - age) / 60000) };
  if (age > AGE_MAX_JOURS * 86400000) return { ok: false, raison: "trop_ancienne" };
  return { ok: true };
}

/** Horaires lisibles pour l'e-mail : « Lundi : 10:00 - 20:00 » … */
function horairesLisibles(hours) {
  const FR = { monday: "Lundi", tuesday: "Mardi", wednesday: "Mercredi", thursday: "Jeudi", friday: "Vendredi", saturday: "Samedi", sunday: "Dimanche" };
  return DAYS.map((d) => {
    const c = creneaux((hours || {})[d]);
    const pad = (n) => String(Math.floor(n / 60)).padStart(2, "0") + "h" + String(n % 60).padStart(2, "0");
    return `${FR[d]} : ${c.length ? c.map(([a, b]) => `${pad(a)} - ${pad(b)}`).join(", ") : "fermé"}`;
  }).join("\n");
}

// ─── Géocodage (Base Adresse Nationale) ────────────────────────────────────

async function geocoder(adresse, { fetchImpl = fetch } = {}) {
  const a = adresse || {};
  const zip = String(a.zip || "").trim();
  const q = [a.address1, zip, a.city].filter(Boolean).join(" ").trim();
  if (!q || !/^\d{5}$/.test(zip)) return null;
  try {
    const url = `https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(q)}&postcode=${zip}&limit=1`;
    const res = await fetchImpl(url, { headers: { accept: "application/json" } });
    if (!res.ok) return null;
    const data = await res.json();
    const f = data && Array.isArray(data.features) ? data.features[0] : null;
    if (!f || !f.geometry || !Array.isArray(f.geometry.coordinates)) return null;
    if (Number(f.properties && f.properties.score) < 0.4) return null;
    const [lng, lat] = f.geometry.coordinates;
    return { lat: Number(lat), lng: Number(lng), precision: f.properties.type || null };
  } catch {
    return null;
  }
}

export {
  TAG_AUTO, DELAI_MIN, AGE_MAX_JOURS, ECART_KM, SOIR_MIN, SOIRS_REQUIS,
  creneaux, profilHoraires, distanceKm, choisirPoint, eligible, horairesLisibles, geocoder,
};
