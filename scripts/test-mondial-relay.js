// scripts/test-mondial-relay.js — dépôt misu-webhook (porté de bbp-webhook le 19/10/2026, ES modules)
// Tests hors ligne des règles de lib/mondial-relay.js : node scripts/test-mondial-relay.js
import assert from 'assert';
process.env.MR_LINK_SECRET = 'test-secret';
process.env.SHOPIFY_WEBHOOK_SECRET = 'whsec';
import * as mr from '../lib/mondial-relay.js';
import crypto from 'crypto';

let n = 0;
function t(name, fn) { fn(); n++; console.log('ok -', name); }

// Format réel relevé sur la commande C295782 (écrit par l'ancienne appli).
const REEL = '{"mondial_relay_id":"019958","mondial_relay_name":"LOCKER 24/7 LIDL VENDARGUES","mondial_relay_address":"45 AVENUE DES BIGOS","mondial_relay_zip":"34740","mondial_relay_city":"VENDARGUES","mondial_relay_country":"FR","mondial_relay_liv":true,"mondial_relay_monday_hours":"00:01 - 23:59","mondial_relay_tuesday_hours":"00:01 - 23:59","mondial_relay_wednesday_hours":"00:01 - 23:59","mondial_relay_thursday_hours":"00:01 - 23:59","mondial_relay_friday_hours":"00:01 - 23:59","mondial_relay_saturday_hours":"00:01 - 23:59","mondial_relay_sunday_hours":"00:01 - 23:59"}';

t('titre de livraison reconnu', () => {
  assert(mr.isMondialRelayTitle('Mondial Relay - Livraison en point de retrait (choix après le paiement)'));
  assert(mr.isMondialRelayTitle('MONDIAL RELAY'));
  assert(!mr.isMondialRelayTitle('Colissimo'));
});

t('point du widget normalisé', () => {
  const r = mr.normalizePoint({ ID: '019958', Nom: 'LOCKER 24/7 LIDL VENDARGUES', Adresse1: '45 AVENUE DES BIGOS', Adresse2: '', CP: '34740', Ville: 'VENDARGUES', Pays: 'FR' });
  assert(r.ok);
  assert.strictEqual(r.point.id, '019958');
  assert.strictEqual(r.point.address, '45 AVENUE DES BIGOS');
});

t('préfixe pays retiré, zéros rétablis', () => {
  assert.strictEqual(mr.normalizePoint({ id: 'FR-19958', name: 'X', address: 'Y', zip: '34740', city: 'Z' }).point.id, '019958');
});

t('données douteuses refusées', () => {
  assert(!mr.normalizePoint({ id: 'abc', name: 'X', address: 'Y', zip: '34740', city: 'Z' }).ok);
  assert(!mr.normalizePoint({ id: '019958', name: 'X', address: 'Y', zip: '3474', city: 'Z' }).ok);
  assert(!mr.normalizePoint({ id: '019958', name: 'X', address: 'Y', zip: '34740', city: 'Z', country: 'BE' }).ok);
  assert(!mr.normalizePoint({ id: '019958', name: '', address: 'Y', zip: '34740', city: 'Z' }).ok);
  const xss = mr.normalizePoint({ id: '019958', name: '<script>"x"</script>', address: 'Y', zip: '34740', city: 'Z' });
  assert(xss.ok && !/[<>"]/.test(xss.point.name));
});

t('métachamp : mêmes clés, même ordre que l\'ancienne appli', () => {
  const p = mr.normalizePoint({ id: '019958', name: 'LOCKER 24/7 LIDL VENDARGUES', address: '45 AVENUE DES BIGOS', zip: '34740', city: 'VENDARGUES' }).point;
  assert.deepStrictEqual(Object.keys(JSON.parse(mr.pickupMetafieldValue(p))), Object.keys(JSON.parse(REEL)));
  assert.strictEqual(JSON.parse(mr.pickupMetafieldValue(p)).mondial_relay_liv, true);
});

t('attributs : les autres sont conservés, les anciens MR remplacés', () => {
  const existing = [
    { key: 'ab_nav_split', value: 'A' },
    { key: 'mondial_relay_id', value: '000001' },
    { key: 'bbdp_origine', value: 'x|y' },
  ];
  const p = mr.normalizePoint({ id: '023110', name: 'I TEK TELECOM', address: '114 RUE PAUL VAILLANT COUTURIER', zip: '94140', city: 'ALFORTVILLE' }).point;
  const out = mr.mergeAttributes(existing, mr.pointToAttributes(p));
  const map = mr.attrsToMap(out);
  assert.strictEqual(map.ab_nav_split, 'A');
  assert.strictEqual(map.bbdp_origine, 'x|y');
  assert.strictEqual(map.mondial_relay_id, '023110');
  assert.strictEqual(out.filter((a) => a.key === 'mondial_relay_id').length, 1);
  assert.strictEqual(map.mondial_relay_liv, 'true');
});

t('retrait des attributs MR', () => {
  const out = mr.mergeAttributes([{ name: 'ab_nav_split', value: 'B' }, { name: 'mondial_relay_zip', value: '94140' }], null);
  assert.deepStrictEqual(out, [{ key: 'ab_nav_split', value: 'B' }]);
});

t('point relu depuis les attributs d\'une vraie commande (format webhook)', () => {
  const note = [
    { name: 'mondial_relay_country', value: 'FR' }, { name: 'mondial_relay_id', value: '031198' },
    { name: 'mondial_relay_name', value: 'LOCKER MR CITY' }, { name: 'mondial_relay_zip', value: '92410' },
    { name: 'mondial_relay_liv', value: 'true' }, { name: 'mondial_relay_city', value: "VILLE D''AVRAY" },
    { name: 'mondial_relay_address', value: '9 RUE DE SEVRES' },
  ];
  const p = mr.pointFromAttributes(mr.attrsToMap(note));
  assert(p && p.id === '031198' && p.zip === '92410');
  assert.strictEqual(mr.pointFromAttributes({}), null);
});

t('lien signé', () => {
  const sig = mr.signOrder('gid://shopify/Order/123456');
  assert(mr.verifyOrderSignature('123456', sig));
  assert(!mr.verifyOrderSignature('123457', sig));
  assert(!mr.verifyOrderSignature('123456', ''));
  assert(mr.pickupPageUrl('gid://shopify/Order/123456').endsWith(`?o=123456&t=${sig}`));
});

t('numéro de confirmation (page de remerciement)', () => {
  const order = { confirmationNumber: 'KX2PA9RTQ' };
  assert(mr.verifyConfirmationNumber(order, 'KX2PA9RTQ'));
  assert(mr.verifyConfirmationNumber(order, 'kx2pa9rtq'));
  assert(!mr.verifyConfirmationNumber(order, 'KX2PA9RTX'));
  assert(!mr.verifyConfirmationNumber(order, ''));
  assert(!mr.verifyConfirmationNumber({ confirmationNumber: null }, ''));
});

t('changement de point : fenêtre d\'une heure après la commande', () => {
  const now = Date.parse('2026-10-12T18:00:00Z');
  assert(mr.withinChangeWindow({ createdAt: '2026-10-12T17:10:00Z' }, now));
  assert(!mr.withinChangeWindow({ createdAt: '2026-10-12T16:59:00Z' }, now));
  assert(!mr.withinChangeWindow({ createdAt: null }, now));
});

t('signature webhook Shopify', () => {
  const body = Buffer.from('{"id":1}');
  const h = crypto.createHmac('sha256', 'whsec').update(body).digest('base64');
  assert(mr.verifyShopifyHmac(body, h));
  assert(!mr.verifyShopifyHmac(Buffer.from('{"id":2}'), h));
  assert(!mr.verifyShopifyHmac(body, undefined));
});

t('horaires Mondial Relay → format de l\'ancienne appli', () => {
  const html = "<table class='PR-Hours'><tr><th>Lundi</th><td>09h30-13h00</td><td>15h30-19h00</td></tr></table>"
    + "<table class='PR-Hours'><tr class='d'><th>Mardi</th><td>08h00-20h00</td><td></td></tr></table>"
    + "<table class='PR-Hours'><tr><th>Dimanche</th><td></td><td></td></tr></table>";
  const h = mr.parseHours(html);
  assert.strictEqual(h.monday, '09:30 - 13:00 | 15:30 - 19:00');
  assert.strictEqual(h.tuesday, '08:00 - 20:00');
  assert.strictEqual(h.sunday, 'Closed');
  assert.strictEqual(h.wednesday, '');
  // version anglaise renvoyée par le service selon la langue
  assert.strictEqual(mr.parseHours("<tr><th>Monday</th><td>09h30-13h00</td><td>15h30-19h00</td></tr>").monday, '09:30 - 13:00 | 15:30 - 19:00');
});

async function asyncTests() {
  const realFetch = global.fetch;
  global.fetch = async (url) => ({
    ok: true,
    text: async () => 'cb({"Error":null,"PRList":[{"ID":"16484","Nom":"LAND OR","Adresse1":"5 RUE CHAPON","Adresse2":"","CP":"75003","Ville":"PARIS","Pays":"FR","Lat":"48,8628794","Long":"2,3567723","HoursHtmlTable":"<tr><th>Lundi</th><td>09h30-13h00</td></tr>"},{"ID":"019958","Nom":"LOCKER 24/7 LIDL","Adresse1":"45 AV","Adresse2":"","CP":"34740","Ville":"VENDARGUES","Pays":"FR","Lat":"43,6","Long":"3,9","HoursHtmlTable":""}]})',
  });
  const pts = await mr.searchPoints({ zip: '75003' });
  assert.strictEqual(pts.length, 2);
  assert.strictEqual(pts[0].id, '016484');
  assert.strictEqual(pts[0].lat, 48.8628794);
  assert.strictEqual(pts[0].hours.monday, '09:30 - 13:00');
  assert.strictEqual(pts[1].locker, true);
  assert.strictEqual((await mr.lookupPoint('19958', '34740')).name, 'LOCKER 24/7 LIDL');
  assert.strictEqual(await mr.lookupPoint('999999', '34740'), null);
  global.fetch = async () => { throw new Error('réseau'); };
  assert.strictEqual(await mr.lookupPoint('019958', '34740'), null);
  global.fetch = realFetch;
  n++; console.log('ok - recherche de points (réponse JSONP, panne réseau)');
}

asyncTests().then(() => console.log(`\n${n} tests Mondial Relay : tout passe.`)).catch((e) => { console.error(e); process.exit(1); });
