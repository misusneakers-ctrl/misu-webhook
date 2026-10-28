// lib/mondial-relay.js — dépôt misu-webhook (porté de bbp-webhook le 19/10/2026, ES modules)
// Remplacement de l'appli Shopify « Mondial Relay » : point relais choisi dans le panier
// (attributs de panier → attributs de commande) ou après paiement via la page /pages/point-relais.
//
// Module AUTONOME : il n'importe aucun autre fichier du dépôt (lib/shopify.js, lib/klaviyo.js…)
// pour ne rien casser chez les autres chantiers. Il utilise uniquement des variables
// d'environnement déjà présentes sur Vercel, plus deux nouvelles :
//   SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET, SHOPIFY_SHOP_DOMAIN   (existantes)
//   SHOPIFY_WEBHOOK_SECRET                                           (existante, webhooks signés)
//   KLAVIYO_API_KEY                                                  (existante)
//   MR_LINK_SECRET      (NOUVELLE) — signe les liens envoyés aux clientes
//   MR_RELANCE_ACTIVE   (NOUVELLE) — "1" pour envoyer l'e-mail « choisissez votre point ».
//                                    Laisser vide tant que l'ancienne appli est installée.

import crypto from 'crypto';

const API_VERSION = '2025-10';
// Suffixe des métriques Klaviyo (« Point Relais Manquant Misü »…) : un compte Klaviyo par marque.
const MARQUE = process.env.MR_MARQUE || 'Misü';
const ATTR_KEYS = [
  'mondial_relay_country',
  'mondial_relay_id',
  'mondial_relay_name',
  'mondial_relay_zip',
  'mondial_relay_liv',
  'mondial_relay_city',
  'mondial_relay_address',
];
const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const METAFIELD_NAMESPACE = 'mondial_relay_app';
const METAFIELD_KEY = 'mondial_relay_pickup_point';
const ALLOWED_COUNTRIES = ['FR', 'MC'];

const TAG_MANQUANT = 'point-relais-manquant';
const TAG_APRES_PAIEMENT = 'mr-point-apres-paiement';
const TAG_PANIER = 'mr-point-panier';
const TAG_MODIFIE = 'mr-point-modifie';
// Délai pendant lequel la cliente peut changer de point depuis la page de remerciement (minutes).
// Au-delà, la commande a pu partir chez le logisticien : le changement passe par le service client.
const CHANGE_WINDOW_MIN = Number(process.env.MR_CHANGE_WINDOW_MIN || 60);

// ---------------------------------------------------------------- Shopify

let tokenCache = { token: null, expiresAt: 0 };

async function getAdminToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt) return tokenCache.token;
  const shop = process.env.SHOPIFY_SHOP_DOMAIN;
  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.SHOPIFY_CLIENT_ID,
      client_secret: process.env.SHOPIFY_CLIENT_SECRET,
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    throw new Error(`Jeton Shopify refusé (${res.status}) : ${JSON.stringify(json).slice(0, 200)}`);
  }
  const ttl = Number(json.expires_in || 3600) * 1000;
  tokenCache = { token: json.access_token, expiresAt: Date.now() + ttl - 5 * 60 * 1000 };
  return tokenCache.token;
}

async function adminGraphql(query, variables = {}) {
  const token = await getAdminToken();
  const shop = process.env.SHOPIFY_SHOP_DOMAIN;
  const res = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.errors) {
    throw new Error(`GraphQL ${res.status} : ${JSON.stringify(json.errors || json).slice(0, 400)}`);
  }
  return json.data;
}

// ---------------------------------------------------------------- Règles métier (pures, testées)

function isMondialRelayTitle(title) {
  return /mondial\s*relay/i.test(String(title || ''));
}

// Les attributs arrivent sous deux formes : [{key,value}] (GraphQL) ou [{name,value}] (webhook REST).
function attrsToMap(list) {
  const map = {};
  for (const a of list || []) {
    const k = a.key != null ? a.key : a.name;
    if (k != null) map[k] = a.value == null ? '' : String(a.value);
  }
  return map;
}

function cleanText(v, max) {
  return String(v == null ? '' : v)
    .replace(/[\u0000-\u001f<>"\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

// Valide et normalise un point relais venant du navigateur (donc non fiable).
// Retourne { ok:true, point } ou { ok:false, error }.
function normalizePoint(input) {
  const p = input || {};
  let id = String(p.id != null ? p.id : p.ID || '').trim().toUpperCase();
  id = id.replace(/^[A-Z]{2}-/, ''); // "FR-019958" → "019958"
  if (!/^\d{5,6}$/.test(id)) return { ok: false, error: 'identifiant de point relais invalide' };
  id = id.padStart(6, '0');
  const country = String(p.country || p.Pays || 'FR').trim().toUpperCase();
  if (!ALLOWED_COUNTRIES.includes(country)) return { ok: false, error: 'pays non livré' };
  const zip = String(p.zip || p.CP || '').trim();
  if (!/^\d{5}$/.test(zip)) return { ok: false, error: 'code postal invalide' };
  const name = cleanText(p.name || p.Nom, 64);
  const address = cleanText([p.address || p.Adresse1, p.address2 || p.Adresse2].filter(Boolean).join(' '), 96);
  const city = cleanText(p.city || p.Ville, 48);
  if (!name || !address || !city) return { ok: false, error: 'adresse du point relais incomplète' };
  const hours = {};
  for (const d of DAYS) hours[d] = cleanText(p.hours && p.hours[d], 40);
  return { ok: true, point: { id, name, address, zip, city, country, hours } };
}

function pointToAttributes(point) {
  return {
    mondial_relay_country: point.country,
    mondial_relay_id: point.id,
    mondial_relay_name: point.name,
    mondial_relay_zip: point.zip,
    mondial_relay_liv: 'true',
    mondial_relay_city: point.city,
    mondial_relay_address: point.address,
  };
}

function pointFromAttributes(map) {
  if (!map || !map.mondial_relay_id) return null;
  const r = normalizePoint({
    id: map.mondial_relay_id,
    name: map.mondial_relay_name,
    address: map.mondial_relay_address,
    zip: map.mondial_relay_zip,
    city: map.mondial_relay_city,
    country: map.mondial_relay_country || 'FR',
  });
  return r.ok ? r.point : null;
}

// Même JSON, même ordre de clés que l'appli Mondial Relay (lu par Mobiltron).
function pickupMetafieldValue(point) {
  const o = {
    mondial_relay_id: point.id,
    mondial_relay_name: point.name,
    mondial_relay_address: point.address,
    mondial_relay_zip: point.zip,
    mondial_relay_city: point.city,
    mondial_relay_country: point.country,
    mondial_relay_liv: true,
  };
  for (const d of DAYS) o[`mondial_relay_${d}_hours`] = (point.hours && point.hours[d]) || '';
  return JSON.stringify(o);
}

// Remplace les attributs Mondial Relay en gardant tous les autres (ab_nav_split, bbdp_origine…).
function mergeAttributes(existingList, mrAttrs) {
  const out = [];
  for (const a of existingList || []) {
    const k = a.key != null ? a.key : a.name;
    if (ATTR_KEYS.includes(k)) continue;
    out.push({ key: k, value: a.value == null ? '' : String(a.value) });
  }
  if (mrAttrs) for (const k of ATTR_KEYS) out.push({ key: k, value: mrAttrs[k] });
  return out;
}

// ---------------------------------------------------------------- Lien signé envoyé à la cliente

function orderNumericId(idOrGid) {
  const m = String(idOrGid || '').match(/(\d+)$/);
  return m ? m[1] : '';
}

function signOrder(idOrGid) {
  const secret = process.env.MR_LINK_SECRET;
  if (!secret) throw new Error('MR_LINK_SECRET manquant');
  return crypto.createHmac('sha256', secret).update(`mr:${orderNumericId(idOrGid)}`).digest('hex').slice(0, 32);
}

function verifyOrderSignature(idOrGid, sig) {
  try {
    const a = Buffer.from(signOrder(idOrGid));
    const b = Buffer.from(String(sig || ''));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (e) {
    return false;
  }
}

// Preuve alternative utilisée par la page de remerciement : le numéro de confirmation de la commande
// (code aléatoire affiché uniquement à l'acheteuse, champ Order.confirmationNumber de l'Admin API).
function verifyConfirmationNumber(order, c) {
  const a = String((order && order.confirmationNumber) || '').trim().toUpperCase();
  const b = String(c || '').trim().toUpperCase();
  if (!a || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// Changement de point autorisé : commande récente (fenêtre CHANGE_WINDOW_MIN) et pas encore traitée.
function withinChangeWindow(order, now = Date.now()) {
  const t = Date.parse(order && order.createdAt);
  if (!Number.isFinite(t)) return false;
  return now - t <= CHANGE_WINDOW_MIN * 60 * 1000;
}

function pickupPageUrl(idOrGid) {
  const base = process.env.MR_PAGE_URL || 'https://www.misu-sneakers.fr/pages/point-relais';
  const id = orderNumericId(idOrGid);
  return `${base}?o=${id}&t=${signOrder(id)}`;
}

// ---------------------------------------------------------------- Webhooks Shopify

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function verifyShopifyHmac(rawBody, hmacHeader) {
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  if (!secret || !hmacHeader) return false;
  const digest = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
  const a = Buffer.from(digest);
  const b = Buffer.from(String(hmacHeader));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------- Écritures Shopify

const ORDER_QUERY = `query($id: ID!) {
  order(id: $id) {
    id name email confirmationNumber createdAt cancelledAt displayFulfillmentStatus tags
    shippingLine { title }
    shippingAddress { firstName address1 zip city }
    customAttributes { key value }
    metafield(namespace: "${METAFIELD_NAMESPACE}", key: "${METAFIELD_KEY}") { value }
  }
}`;

async function getOrder(idOrGid) {
  const id = String(idOrGid).startsWith('gid://') ? idOrGid : `gid://shopify/Order/${orderNumericId(idOrGid)}`;
  const data = await adminGraphql(ORDER_QUERY, { id });
  return data.order;
}

async function writePickupPoint(order, point) {
  const data = await adminGraphql(
    `mutation($input: OrderInput!, $mf: [MetafieldsSetInput!]!) {
      orderUpdate(input: $input) { userErrors { field message } }
      metafieldsSet(metafields: $mf) { userErrors { field message } }
    }`,
    {
      input: { id: order.id, customAttributes: mergeAttributes(order.customAttributes, pointToAttributes(point)) },
      mf: [{
        ownerId: order.id,
        namespace: METAFIELD_NAMESPACE,
        key: METAFIELD_KEY,
        type: 'single_line_text_field',
        value: pickupMetafieldValue(point),
      }],
    }
  );
  const errs = [...data.orderUpdate.userErrors, ...data.metafieldsSet.userErrors];
  if (errs.length) throw new Error(`Écriture point relais refusée : ${JSON.stringify(errs)}`);
}

async function removePickupAttributes(order) {
  const data = await adminGraphql(
    `mutation($input: OrderInput!) { orderUpdate(input: $input) { userErrors { field message } } }`,
    { input: { id: order.id, customAttributes: mergeAttributes(order.customAttributes, null) } }
  );
  if (data.orderUpdate.userErrors.length) throw new Error(JSON.stringify(data.orderUpdate.userErrors));
}

async function setTags(orderId, add = [], remove = []) {
  if (add.length) {
    await adminGraphql(`mutation($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { message } } }`, { id: orderId, tags: add });
  }
  if (remove.length) {
    await adminGraphql(`mutation($id: ID!, $tags: [String!]!) { tagsRemove(id: $id, tags: $tags) { userErrors { message } } }`, { id: orderId, tags: remove });
  }
}

// ---------------------------------------------------------------- Klaviyo (e-mail « choisissez votre point »)

async function sendMissingPointEvent({ email, firstName, orderName, orderId, url }) {
  const key = process.env.KLAVIYO_API_KEY;
  if (!key) throw new Error('KLAVIYO_API_KEY manquant');
  const res = await fetch('https://a.klaviyo.com/api/events', {
    method: 'POST',
    headers: {
      Authorization: `Klaviyo-API-Key ${key}`,
      'Content-Type': 'application/vnd.api+json',
      accept: 'application/vnd.api+json',
      revision: '2025-01-15',
    },
    body: JSON.stringify({
      data: {
        type: 'event',
        attributes: {
          unique_id: `mr-manquant-${orderNumericId(orderId)}`, // Klaviyo ignore les doublons
          properties: { commande: orderName, lien_point_relais: url, prenom: firstName || '' },
          metric: { data: { type: 'metric', attributes: { name: `Point Relais Manquant ${MARQUE}` } } },
          profile: { data: { type: 'profile', attributes: { email, first_name: firstName || undefined } } },
        },
      },
    }),
  });
  if (!res.ok && res.status !== 202) {
    throw new Error(`Klaviyo ${res.status} : ${(await res.text()).slice(0, 200)}`);
  }
}

async function sendPointChosenEvent({ email, orderName, orderId, point }) {
  const key = process.env.KLAVIYO_API_KEY;
  if (!key || !email) return;
  const res = await fetch('https://a.klaviyo.com/api/events', {
    method: 'POST',
    headers: {
      Authorization: `Klaviyo-API-Key ${key}`,
      'Content-Type': 'application/vnd.api+json',
      accept: 'application/vnd.api+json',
      revision: '2025-01-15',
    },
    body: JSON.stringify({
      data: {
        type: 'event',
        attributes: {
          unique_id: `mr-choisi-${orderNumericId(orderId)}`,
          properties: { commande: orderName, point_relais: point.name, point_relais_id: point.id },
          metric: { data: { type: 'metric', attributes: { name: `Point Relais Choisi ${MARQUE}` } } },
          profile: { data: { type: 'profile', attributes: { email } } },
        },
      },
    }),
  });
  if (!res.ok && res.status !== 202) throw new Error(`Klaviyo ${res.status}`);
}

// 14/10 (Luc) : point attribué d'office au bout d'une heure sans choix (lib/mr-point-auto.js).
// L'e-mail à la cliente part d'un flow Klaviyo branché sur cette métrique (envoyée par l'API).
async function sendPointAttribueEvent({ email, firstName, orderName, orderId, point, horaires }) {
  const key = process.env.KLAVIYO_API_KEY;
  if (!key || !email) return false;
  const res = await fetch('https://a.klaviyo.com/api/events', {
    method: 'POST',
    headers: {
      Authorization: `Klaviyo-API-Key ${key}`,
      'Content-Type': 'application/vnd.api+json',
      accept: 'application/vnd.api+json',
      revision: '2025-01-15',
    },
    body: JSON.stringify({
      data: {
        type: 'event',
        attributes: {
          unique_id: `mr-auto-${orderNumericId(orderId)}`,
          properties: {
            commande: orderName,
            prenom: firstName || '',
            point_relais: point.name,
            point_relais_id: point.id,
            point_relais_adresse: point.address,
            point_relais_code_postal: point.zip,
            point_relais_ville: point.city,
            point_relais_horaires: horaires || '',
          },
          metric: { data: { type: 'metric', attributes: { name: `Point Relais Attribué ${MARQUE}` } } },
          profile: { data: { type: 'profile', attributes: { email, first_name: firstName || undefined } } },
        },
      },
    }),
  });
  if (!res.ok && res.status !== 202) throw new Error(`Klaviyo ${res.status}`);
  return true;
}

const METRIQUE_POINT_ATTRIBUE = `Point Relais Attribué ${MARQUE}`;

function enTetesKlaviyo() {
  return {
    Authorization: `Klaviyo-API-Key ${process.env.KLAVIYO_API_KEY}`,
    'Content-Type': 'application/vnd.api+json',
    accept: 'application/vnd.api+json',
    revision: '2025-01-15',
  };
}

// Crée la métrique côté « API » (et pas « Klaviyo MCP Server ») sans déclencher de flow :
// événement passé (backfill), unique_id fixe, sur la boîte de la marque. Rejouable sans effet.
async function amorcerMetriquePointAttribue(email = process.env.MR_EMAIL_MARQUE || 'bonjour@misu-sneakers.fr') {
  if (!process.env.KLAVIYO_API_KEY) return false;
  const res = await fetch('https://a.klaviyo.com/api/events', {
    method: 'POST',
    headers: enTetesKlaviyo(),
    body: JSON.stringify({ data: { type: 'event', attributes: {
      properties: { amorcage: true },
      metric: { data: { type: 'metric', attributes: { name: METRIQUE_POINT_ATTRIBUE } } },
      profile: { data: { type: 'profile', attributes: { email } } },
      unique_id: 'amorcage-point-relais-attribue',
      backfill: true,
      time: '2026-10-14T12:00:00Z',
    } } }),
  });
  return res.ok || res.status === 202;
}

// Un flow ACTIF (live) est-il branché sur la métrique « Point Relais Attribué Misü » ?
// Sans lui, la cliente ne serait pas prévenue : le cron n'attribue rien (14/10, choix de Claude
// validé par la mise en route décrite dans le CR).
async function fluxPointAttribueActif() {
  if (!process.env.KLAVIYO_API_KEY) return { actif: false, raison: 'cle_klaviyo_absente' };
  // L'API ne filtre les métriques QUE par intégration (un filtre par nom renvoie 400, constaté le
  // 14/10) : on liste celles de l'intégration « API » et on cherche le nom nous-mêmes.
  const filtre = encodeURIComponent('equals(integration.name,"API")');
  let url = `https://a.klaviyo.com/api/metrics?filter=${filtre}`;
  const metriques = [];
  for (let page = 0; url && page < 10; page += 1) {
    const rm = await fetch(url, { headers: enTetesKlaviyo() });
    if (!rm.ok) return { actif: false, raison: `klaviyo_metriques_${rm.status}` };
    const corps = await rm.json();
    for (const m of corps.data || []) if (m.attributes && m.attributes.name === METRIQUE_POINT_ATTRIBUE) metriques.push(m);
    url = corps.links && corps.links.next;
  }
  if (!metriques.length) return { actif: false, raison: 'metrique_absente' };
  for (const m of metriques) {
    const rf = await fetch(`https://a.klaviyo.com/api/metrics/${m.id}/flow-triggers`, { headers: enTetesKlaviyo() });
    if (!rf.ok) continue;
    const flows = ((await rf.json()).data || []).map((f) => f.id);
    for (const id of flows) {
      const r = await fetch(`https://a.klaviyo.com/api/flows/${id}`, { headers: enTetesKlaviyo() });
      if (!r.ok) continue;
      const statut = ((await r.json()).data || {}).attributes || {};
      if (statut.status === 'live' && !statut.archived) return { actif: true, flow: id, metrique: m.id };
    }
  }
  return { actif: false, raison: 'aucun_flow_actif', metriques: metriques.map((m) => m.id) };
}

// ---------------------------------------------------------------------------
// Recherche de points relais (service public du widget Mondial Relay, code enseigne).
// Même source que la carte officielle, sans clé privée. Réponse JSONP, lue côté serveur.
const MR_BRAND = process.env.MR_BRAND || 'F1MOBSAN';
const MR_MAX_RESULTATS = 15;
const MR_SEARCH_URL = 'https://widget.mondialrelay.com/parcelshop-picker/v4_0/services/parcelshop-picker.svc/SearchPR';
// Le service renvoie les jours en français ou en anglais selon la langue demandée : on accepte les deux.
const JOURS_FR = { lundi: 'monday', mardi: 'tuesday', mercredi: 'wednesday', jeudi: 'thursday', vendredi: 'friday', samedi: 'saturday', dimanche: 'sunday',
  monday: 'monday', tuesday: 'tuesday', wednesday: 'wednesday', thursday: 'thursday', friday: 'friday', saturday: 'saturday', sunday: 'sunday' };

function num(v) {
  const n = parseFloat(String(v == null ? '' : v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

// "<th>Lundi</th><td>09h30-13h00</td><td>15h30-19h00</td>" → { monday: "09:30 - 13:00 | 15:30 - 19:00", … }
// Même écriture que l'ancienne appli ; jour sans créneau → "Closed".
function parseHours(html) {
  const hours = {};
  for (const d of DAYS) hours[d] = '';
  const rows = String(html || '').match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
  for (const row of rows) {
    const th = (row.match(/<th[^>]*>([\s\S]*?)<\/th>/i) || [])[1];
    const day = th && JOURS_FR[th.replace(/<[^>]+>/g, '').trim().toLowerCase()];
    if (!day) continue;
    const slots = (row.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || [])
      .map((td) => td.replace(/<[^>]+>/g, '').trim())
      .filter((t) => /\d/.test(t))
      .map((t) => t.replace(/h/gi, ':').replace(/\s*-\s*/, ' - '));
    hours[day] = slots.length ? slots.join(' | ') : 'Closed';
  }
  return hours;
}

function pointFromSearch(r) {
  const name = cleanText(r.Nom, 64);
  return {
    id: String(r.ID || '').trim().padStart(6, '0'),
    name,
    address: cleanText([r.Adresse1, r.Adresse2].filter(Boolean).join(' '), 96),
    zip: String(r.CP || '').trim(),
    city: cleanText(r.Ville, 48),
    country: String(r.Pays || 'FR').trim().toUpperCase(),
    lat: num(r.Lat),
    lng: num(r.Long),
    locker: /locker/i.test(name),
    hours: parseHours(r.HoursHtmlTable),
    // 14/10 : un point en congés ou fermé est renvoyé avec Available = false et un
    // avertissement (« en congés jusqu'au … »). Le choix d'office l'écarte.
    available: !(r.Available === false || /^(false|0|non|no)$/i.test(String(r.Available == null ? '' : r.Available).trim())),
    warning: cleanText(r.Warning, 160) || null,
  };
}

// { zip } ou { lat, lng } (géolocalisation) ; n résultats (10 par défaut, 15 max).
// 14/10 : au-delà de 16 résultats, Mondial Relay ne renvoie PLUS RIEN (PRList null, « Désolé,
// nous n'avons pas été en mesure de trouver des Relais… ») — vérifié à 20 et 30. D'où le plafond.
async function searchPoints({ zip, city, lat, lng, n } = {}) {
  const q = new URLSearchParams({
    method: 'cb', Brand: MR_BRAND, Country: 'FR', PostCode: zip ? String(zip).trim() : '',
    ColLivMod: '24R', Weight: '', NbResults: String(Math.min(Math.max(Number(n) || 10, 1), MR_MAX_RESULTATS)),
    SearchDelay: '', SearchFar: '75', ClientContainerId: 'misu', VacationBefore: '', VacationAfter: '',
    Service: '', Latitude: lat != null ? String(lat) : '', Longitude: lng != null ? String(lng) : '',
    City: city ? String(city) : '', WidgetLanguage: '',
  });
  const res = await fetch(`${MR_SEARCH_URL}?${q}`, { headers: { accept: '*/*' } });
  if (!res.ok) throw new Error(`Mondial Relay ${res.status}`);
  const text = await res.text();
  const m = text.match(/^[^(]*\(([\s\S]*)\)\s*;?\s*$/);
  const data = JSON.parse(m ? m[1] : text);
  const list = Array.isArray(data && data.PRList) ? data.PRList : [];
  return list.map(pointFromSearch).filter((p) => /^\d{6}$/.test(p.id) && /^\d{5}$/.test(p.zip));
}

// Retrouve un point par son numéro autour de son code postal : confirme qu'il existe
// et donne les données officielles (adresse, horaires). null si introuvable ou service indisponible.
async function lookupPoint(id, zip) {
  try {
    const want = String(id || '').padStart(6, '0');
    const list = await searchPoints({ zip, n: MR_MAX_RESULTATS });
    return list.find((p) => p.id === want) || null;
  } catch (e) {
    console.warn('[mondial-relay] recherche indisponible', e.message);
    return null;
  }
}

export {
  ATTR_KEYS, METAFIELD_NAMESPACE, METAFIELD_KEY,
  TAG_MANQUANT, TAG_APRES_PAIEMENT, TAG_PANIER, TAG_MODIFIE, CHANGE_WINDOW_MIN, withinChangeWindow,
  parseHours, searchPoints, lookupPoint,
  isMondialRelayTitle, attrsToMap, normalizePoint, pointToAttributes, pointFromAttributes,
  pickupMetafieldValue, mergeAttributes,
  orderNumericId, signOrder, verifyOrderSignature, verifyConfirmationNumber, pickupPageUrl,
  readRawBody, verifyShopifyHmac,
  adminGraphql, getOrder, writePickupPoint, removePickupAttributes, setTags, sendMissingPointEvent, sendPointChosenEvent, sendPointAttribueEvent,
  amorcerMetriquePointAttribue, fluxPointAttribueActif, METRIQUE_POINT_ATTRIBUE, MR_MAX_RESULTATS,
};
