// scripts/test-mr-point-auto.js — dépôt misu-webhook (porté de bbp-webhook le 19/10/2026, ES modules)
// Tests hors ligne du point relais attribué d'office (lib/mr-point-auto.js) :
//   node scripts/test-mr-point-auto.js
process.env.MR_LINK_SECRET = process.env.MR_LINK_SECRET || 'test-secret';
import * as mr from '../lib/mondial-relay.js';
import * as auto from '../lib/mr-point-auto.js';

let ok = 0;
let ko = 0;
function verifie(nom, cond, detail) {
  if (cond) { ok += 1; console.log('  ok   ' + nom); } else { ko += 1; console.log('  ÉCHEC ' + nom + (detail ? '\n        → ' + detail : '')); }
}

const H = (lun, sam, dim = 'Closed') => ({ monday: lun, tuesday: lun, wednesday: lun, thursday: lun, friday: lun, saturday: sam, sunday: dim });
// Domicile : Châtillon (92320), coordonnées proches des points relevés le 14/10.
const DOMICILE = { lat: 48.8045, lng: 2.2900 };
const pt = (id, name, lat, lng, hours, extra = {}) => ({ id, name, address: '1 RUE X', zip: '92320', city: 'CHATILLON', country: 'FR', lat, lng, hours, locker: /locker/i.test(name), available: true, warning: null, ...extra });

// Horaires relevés en réel le 14/10 sur Mondial Relay (Châtillon).
const PROXI = pt('031993', 'PROXI', 48.804033, 2.289312, H('10:00 - 20:00', '10:00 - 20:00'));
const MERMOZ = pt('033800', 'LES VERGERS DE MERMOZ', 48.809657, 2.291172, H('11:30 - 13:30 | 15:30 - 20:00', '11:30 - 20:00', '11:30 - 13:30'), { available: false, warning: 'En congés jusqu au 31/10/2026' });
const PRESSING = pt('012177', 'PRESSING NEW CLEAN', 48.814331, 2.28638, H('09:00 - 12:30 | 14:00 - 18:00', 'Closed'));

console.log('\n1. Lecture des horaires');
verifie('créneaux simples et coupés', JSON.stringify(auto.creneaux('09:00 - 12:30 | 14:00 - 19:00')) === '[[540,750],[840,1140]]');
verifie('« Closed » et vide = fermé', auto.creneaux('Closed').length === 0 && auto.creneaux('').length === 0);
verifie('format Mondial Relay brut « 10h00-20h00 » lu aussi', JSON.stringify(auto.creneaux('10h00-20h00')) === '[[600,1200]]');
verifie('minuit en fin de créneau', JSON.stringify(auto.creneaux('18:00 - 00:00')) === '[[1080,1440]]');
const pProxi = auto.profilHoraires(PROXI.hours);
verifie('PROXI : samedi + 5 soirs = large', pProxi.samedi && pProxi.soirs === 5 && pProxi.large);
const pPress = auto.profilHoraires(PRESSING.hours);
verifie('pressing fermé à 18 h pile : pas un soir, pas de samedi', !pPress.samedi && pPress.soirs === 0 && !pPress.large);
const lundiFerme = auto.profilHoraires({ ...H('10:00 - 19:00', '10:00 - 19:00'), monday: 'Closed' });
verifie('fermé le lundi mais 4 soirs : accepté', lundiFerme.large && lundiFerme.soirs === 4);
const deuxLundis = auto.profilHoraires({ ...H('10:00 - 19:00', '10:00 - 19:00'), monday: 'Closed', tuesday: 'Closed' });
verifie('3 soirs seulement : refusé', !deuxLundis.large);

console.log('\n2. Choix du point');
let c = auto.choisirPoint([PRESSING, MERMOZ, PROXI], DOMICILE);
verifie('PROXI choisi (ouvert samedi et après 18 h, le plus proche)', c.point && c.point.id === '031993', JSON.stringify(c));
verifie('raison explicite', c.raison === 'plus_proche_ouvert_samedi_et_apres_18h');
verifie('distance calculée', c.distance_km !== null && c.distance_km < 0.2, String(c.distance_km));

c = auto.choisirPoint([MERMOZ, PRESSING], DOMICILE);
verifie('point en congés jamais choisi, même plus large', c.point && c.point.id === '012177', JSON.stringify(c.point));
verifie('à défaut, la plus grande amplitude de la zone', c.raison === 'plus_grande_amplitude_de_la_zone');

const LOCKER = pt('099999', 'LOCKER 24/7 LIDL', 48.8044, 2.2901, H('00:01 - 23:59', '00:01 - 23:59', '00:01 - 23:59'), { locker: true });
c = auto.choisirPoint([LOCKER, PRESSING, PROXI], DOMICILE);
verifie('locker écarté quand un point tenu existe', c.point.id === '031993');
c = auto.choisirPoint([LOCKER], DOMICILE);
verifie('locker accepté seulement faute de mieux', c.point.id === '099999' && c.raison === 'locker_faute_de_point');

const LOIN = pt('055555', 'TABAC LOIN', 48.84, 2.29, H('08:00 - 21:00', '08:00 - 21:00'));
const PRES = pt('044444', 'EPICERIE PRES', 48.8046, 2.2901, H('09:00 - 17:00', 'Closed'));
c = auto.choisirPoint([PRES, LOIN], DOMICILE);
verifie('un point « large » à 4 km ne l\'emporte pas sur un point à 20 m', c.point.id === '044444', JSON.stringify({ id: c.point.id, d: c.distance_km }));

const SAMEDI_SEUL = pt('066666', 'BOULANGERIE', 48.8050, 2.2905, H('07:00 - 13:00', '07:00 - 13:00'));
const SOIR_SEUL = pt('077777', 'SUPERETTE', 48.8052, 2.2906, H('10:00 - 21:00', 'Closed'));
c = auto.choisirPoint([SOIR_SEUL, SAMEDI_SEUL], DOMICILE);
verifie('à défaut des deux : le samedi d\'abord', c.point.id === '066666');

c = auto.choisirPoint([PRESSING, PROXI], null);
verifie('sans géocodage : ordre Mondial Relay, mêmes critères', c.point.id === '031993' && c.distance_km === null);
verifie('aucun point : pas de choix', auto.choisirPoint([], DOMICILE).point === null);
verifie('tous indisponibles : pas de choix', auto.choisirPoint([MERMOZ], DOMICILE).raison === 'aucun_point_disponible');

console.log('\n3. Commandes éligibles');
const MAINTENANT = Date.parse('2026-10-14T17:30:00Z');
const base = {
  createdAt: '2026-10-14T13:50:49Z', cancelledAt: null, displayFulfillmentStatus: 'UNFULFILLED',
  tags: ['OUTLET', 'point-relais-manquant'], shippingLine: { title: 'Mondial Relay - Livraison en point de retrait (choix après le paiement)' },
  customAttributes: [{ key: 'igId', value: 'x' }],
};
const el = (o, m = MAINTENANT) => auto.eligible(o, { maintenant: m, isMondialRelayTitle: mr.isMondialRelayTitle, pointFromAttributes: mr.pointFromAttributes, attrsToMap: mr.attrsToMap });
verifie('C295881 (sans point, 3 h 40) : éligible', el(base).ok, JSON.stringify(el(base)));
verifie('moins d\'1 h : trop tôt', el(base, Date.parse('2026-10-14T14:20:00Z')).raison === 'trop_tot');
verifie('déjà importée par Mobiltron : refus', el({ ...base, tags: [...base.tags, 'WMS_Moby_OK'] }).raison === 'deja_importee_par_mobiltron');
verifie('annulée : refus', el({ ...base, cancelledAt: '2026-10-14T15:00:00Z' }).raison === 'annulee');
verifie('Colissimo : refus', el({ ...base, shippingLine: { title: 'Colissimo' } }).raison === 'pas_mondial_relay');
verifie('déjà expédiée : refus', el({ ...base, displayFulfillmentStatus: 'FULFILLED' }).raison === 'deja_traitee');
const avecPoint = { ...base, customAttributes: [...base.customAttributes, ...Object.entries(mr.pointToAttributes({ id: '031993', name: 'PROXI', address: '1 RUE X', zip: '92320', city: 'CHATILLON', country: 'FR' })).map(([key, value]) => ({ key, value }))] };
verifie('point choisi entre-temps : on ne touche à rien', el(avecPoint).raison === 'point_deja_choisi');
verifie('déjà attribué d\'office : pas deux fois', el({ ...base, tags: [...base.tags, 'mr-point-auto'] }).raison === 'deja_attribue');
verifie('plus de 3 jours : laissé à Luc', el(base, Date.parse('2026-10-18T14:00:00Z')).raison === 'trop_ancienne');

console.log('\n4. Lecture Mondial Relay et e-mail');
const brut = { ID: '33800', Nom: 'LES VERGERS DE MERMOZ', Adresse1: '2 AV', CP: '92320', Ville: 'CHATILLON', Pays: 'FR', Lat: '48,809657', Long: '2,291172', Available: false, Warning: 'En congés jusqu\'au 31/10/2026', HoursHtmlTable: "<table><tr><th>Lundi</th><td>16h00-20h00</td><td></td></tr><tr><th>Samedi</th><td>11h30-20h00</td><td></td></tr></table>" };
// pointFromSearch n'est pas exporté : on passe par le même chemin que searchPoints.
import * as lu from '../lib/mondial-relay.js';
const parse = lu.parseHours(brut.HoursHtmlTable);
verifie('horaires Mondial Relay lus au format attendu', parse.monday === '16:00 - 20:00' && parse.saturday === '11:30 - 20:00', JSON.stringify(parse));
verifie('horaires lisibles pour l\'e-mail', /Lundi : 10h00 - 20h00/.test(auto.horairesLisibles(PROXI.hours)) && /Dimanche : fermé/.test(auto.horairesLisibles(PROXI.hours)));

console.log('\n5. Géocodage (simulé)');
(async () => {
  const faux = (rep) => async () => ({ ok: true, json: async () => rep });
  const g = await auto.geocoder({ address1: '12 rue de la Gare', zip: '92320', city: 'Châtillon' }, { fetchImpl: faux({ features: [{ geometry: { coordinates: [2.29, 48.8045] }, properties: { score: 0.91, type: 'housenumber' } }] }) });
  verifie('adresse géocodée (lat, lng)', g && g.lat === 48.8045 && g.lng === 2.29 && g.precision === 'housenumber', JSON.stringify(g));
  const g2 = await auto.geocoder({ address1: 'xx', zip: '92320', city: 'Châtillon' }, { fetchImpl: faux({ features: [{ geometry: { coordinates: [2.29, 48.8] }, properties: { score: 0.2 } }] }) });
  verifie('géocodage peu sûr ignoré (repli sur le code postal)', g2 === null);
  const g3 = await auto.geocoder({ address1: '1 rue', zip: '', city: 'X' }, { fetchImpl: faux({}) });
  verifie('sans code postal : pas de géocodage', g3 === null);
  const g4 = await auto.geocoder({ address1: '1 rue', zip: '92320', city: 'X' }, { fetchImpl: async () => { throw new Error('réseau'); } });
  verifie('service en panne : null, jamais d\'exception', g4 === null);

  console.log('\n6. Plafond de la recherche Mondial Relay (au-delà de 16, plus aucun résultat)');
  const urls = [];
  const vraiFetch = global.fetch;
  global.fetch = async (u) => { urls.push(String(u)); return { ok: true, text: async () => 'cb({"PRList":[]})' }; };
  await mr.searchPoints({ zip: '92320', n: 30 });
  await mr.lookupPoint('031993', '92320');
  global.fetch = vraiFetch;
  verifie('n = 30 demandé → 15 envoyés', /NbResults=15\b/.test(urls[0]), urls[0]);
  verifie('lookupPoint demande 15, plus 30', /NbResults=15\b/.test(urls[1]), urls[1]);

  console.log('\n7. Flow Klaviyo actif (simulé)');
  process.env.KLAVIYO_API_KEY = 'pk_test';
  const appels = [];
  global.fetch = async (u) => {
    u = String(u); appels.push(u);
    if (u.includes('/api/metrics?')) return { ok: true, json: async () => ({ data: [{ id: 'AAA', attributes: { name: 'Autre' } }, { id: 'XGX9JP', attributes: { name: 'Point Relais Attribué Misü' } }], links: { next: null } }) };
    if (u.includes('/flow-triggers')) return { ok: true, json: async () => ({ data: [{ id: 'F1' }] }) };
    if (u.includes('/api/flows/F1')) return { ok: true, json: async () => ({ data: { attributes: { status: 'live', archived: false } } }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  let fa = await mr.fluxPointAttribueActif();
  verifie('métrique trouvée par son nom parmi celles de l\'API, flow live détecté', fa.actif && fa.flow === 'F1' && fa.metrique === 'XGX9JP', JSON.stringify(fa));
  verifie('aucun filtre par nom envoyé à Klaviyo (refusé en 400)', !appels.some((u) => /equals%28name/.test(u)));
  global.fetch = async (u) => {
    u = String(u);
    if (u.includes('/api/metrics?')) return { ok: true, json: async () => ({ data: [{ id: 'XGX9JP', attributes: { name: 'Point Relais Attribué Misü' } }], links: { next: null } }) };
    if (u.includes('/flow-triggers')) return { ok: true, json: async () => ({ data: [{ id: 'F1' }] }) };
    return { ok: true, json: async () => ({ data: { attributes: { status: 'draft', archived: false } } }) };
  };
  fa = await mr.fluxPointAttribueActif();
  verifie('flow en brouillon : pas actif, donc pas d\'attribution', !fa.actif && fa.raison === 'aucun_flow_actif', JSON.stringify(fa));
  global.fetch = vraiFetch;

  console.log('\n' + (ko === 0 ? `Tous les tests passent (${ok}).` : `${ko} ÉCHEC(S) sur ${ok + ko} tests.`));
  process.exit(ko === 0 ? 0 : 1);
})();
