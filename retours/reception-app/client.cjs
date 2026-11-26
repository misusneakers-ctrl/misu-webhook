
const BZR_API = 'https://misu-webhook.vercel.app/api/receive-return';
// AUDIT 17/09 : l'API exige la clé d'accès entrepôt (variable Vercel
// RECEPTION_API_KEY). Saisie une fois par appareil, gardée dans ce navigateur.
const BZR_KEY_STORAGE = 'misuReceptionKey';

let bzr = { step: 1, tracking: '', orderName: '', returnId: '', announced: [], ticked: [], scanned: [], gotByItem: [], result: null, busy: false, cam: null, camOn: false, lastScan: '', lock: false, cams: [], camId: null, mode: 'label', torch: false, issues: {}, horsStock: {}, photos: [], note: '', incidentId: '', photoBusy: false };

// 13/10 (Luc) — CONSTAT DE L'ENTREPÔT. Pour chaque article : « Manquant » ou
// « Problème » (+ précision). En bas : photos (appareil photo du téléphone ou
// fichiers) et message. À la validation, un retour avec un signalement passe
// en litige et un ticket SAV « Retour non conforme » est créé dans la
// messagerie avec les photos. Les photos sont réduites ici (1600 px, JPEG)
// pour tenir dans un seul envoi.
const BZR_MAX_PHOTOS = 8;
const BZR_BUDGET_PHOTOS = 3200000; // caractères base64 au total (~2,4 Mo)
function bzrNewIncidentId() { return 'inc-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8); }
function bzrHasIssues() { return Object.keys(bzr.issues).length > 0; }

const BZR_TACTILE = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;

function bzrEsc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function bzrSay(t, k, extra) {
  const e = document.getElementById('bzr-msg');
  if (!e) return;
  if (!t) { e.innerHTML = ''; e.className = 'bzr-msg'; return; }
  e.className = 'bzr-msg ' + k;
  e.innerHTML = bzrEsc(t) + (extra || '');
}
function bzrEur(n) { return Number(n || 0).toFixed(2).replace('.', ',') + ' €'; }
// Modèle du 18/09 : trois choix possibles par article. Sans ce libellé, un
// article pour lequel la cliente a demandé un AVOIR s'affichait en entrepôt
// comme un « remboursement » — de quoi rembourser deux fois.
function bzrActionLabel(action, exchangeTitle) {
  if (action === 'exchange') return `échange de taille${exchangeTitle ? ' → ' + bzrEsc(exchangeTitle) : ''}`;
  if (action === 'credit') return 'AVOIR (crédit boutique)';
  return 'remboursement';
}
// 06/11 (Luc) : affichage allégé. Pour un échange, seule la taille visée
// compte (le modèle est le même) : « Échange → BLEU / 38 ».
function bzrActionCourt(action, exchangeTitle) {
  if (action === 'exchange') {
    const t = String(exchangeTitle || '');
    const m = / — Taille (.+)$/.exec(t);
    return 'Échange' + (t ? ' → ' + bzrEsc(m ? m[1] : t) : '');
  }
  if (action === 'credit') return 'Avoir';
  return 'Remboursement';
}
// 06/11 (Luc) : le motif du retour est toujours visible, avec le commentaire
// de la cliente s'il y en a un.
function bzrMotif(it) {
  const r = String(it.reason || '').trim();
  const c = String(it.comment || '').trim();
  return `<span class="bzr-motif">Motif : <b>${bzrEsc(r || 'non précisé')}</b>${c ? ' — « ' + bzrEsc(c) + ' »' : ''}</span>`;
}
// Échéance d'un crédit boutique (YYYY-MM-DD renvoyé par Shopify) en JJ/MM/AAAA.
function bzrDateFr(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(iso || '');
}

function bzrGetKey() { try { return localStorage.getItem(BZR_KEY_STORAGE) || ''; } catch (e) { return bzr.key || ''; } }
function bzrSetKey(v) { bzr.key = v; try { if (v) localStorage.setItem(BZR_KEY_STORAGE, v); else localStorage.removeItem(BZR_KEY_STORAGE); } catch (e) {} }
function bzrSaveKey() {
  const el = document.getElementById('bzr-key');
  const v = (el ? el.value : '').trim();
  if (!v) { bzrSay("Clé d'accès manquante.", 'ko'); return; }
  bzrSetKey(v); bzrSay('', ''); bzrPaint();
}
function bzrForgetKey() { bzrSetKey(''); bzrReset(); }
async function bzrPost(body) {
  return fetch(BZR_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Misu-Reception-Key': bzrGetKey() },
    body: JSON.stringify(body)
  });
}
// 401 : clé refusée → on l'oublie et on revient à la saisie. 503 : clé pas configurée côté serveur.
function bzrAuthFailed(res, data) {
  if (res.status !== 401 && res.status !== 503) return false;
  if (res.status === 401) bzrSetKey('');
  bzr.step = 1; bzrPaint();
  bzrSay(data.error || "Accès refusé.", 'ko');
  return true;
}

function bzrFocusScan() {
  if (BZR_TACTILE || bzr.camOn) return;
  const el = document.getElementById(bzr.step === 1 ? (bzrGetKey() ? 'bzr-track' : 'bzr-key') : 'bzr-item');
  if (el) { el.focus(); if (el.select) el.select(); }
}

function bzrOnKey(e, action) {
  if (e.key === 'Enter') { e.preventDefault(); action(); }
}

async function bzrSetTracking() {
  const el = document.getElementById('bzr-track');
  const v = (el ? el.value : '').trim();
  if (!v) { bzrSay('Numéro de suivi manquant.', 'ko'); return; }
  await bzrStopCam();
  bzr.busy = true; bzrPaint();

  try {
    const res = await bzrPost({ mode: 'lookup', trackingNumber: v });
    const data = await res.json().catch(() => ({}));
    bzr.busy = false;

    if (bzrAuthFailed(res, data)) return;
    if (res.status === 409) { bzrPaint(); bzrSay(data.error || 'Ce retour a déjà été réceptionné.', 'ko'); return; }
    if (res.status === 404) { bzrPaint(); bzrSay(data.error || "Étiquette introuvable dans l'inventaire.", 'ko', `<span class="bzr-code">Numéro saisi : ${bzrEsc(v)}</span>`); return; }
    if (!res.ok || !data.ok) { bzrPaint(); bzrSay(data.error || 'Erreur lors de la recherche.', 'ko'); return; }

    bzr.tracking = v; bzr.orderName = data.orderName || ''; bzr.returnId = data.returnId || ''; bzr.announced = data.items || []; bzr.ticked = []; bzr.scanned = []; bzr.gotByItem = bzr.announced.map(() => 0); bzr.step = 2;
    bzr.issues = {}; bzr.horsStock = {}; bzr.photos = []; bzr.note = ''; bzr.constatOuvert = false; bzr.incidentId = bzrNewIncidentId();
    bzrSay('', ''); bzrPaint();
  } catch (e) {
    bzr.busy = false;
    bzrPaint();
    bzrSay("Impossible de contacter le serveur. Vérifiez la connexion et réessayez.", 'ko');
  }
}

// Manual tick = the same thing as a scan for that item: when the backend tells us the
// item's real barcode (mode:lookup, field `barcode`), ticking pushes that barcode into
// bzr.scanned exactly as a physical scan would, so bzrConfirm() sends an identical payload
// either way. If the backend hasn't been updated yet to expose `barcode`, we fall back to
// the old purely-visual tick so nothing breaks in the meantime.
function bzrToggleTick(i) {
  const it = bzr.announced[i];
  if (!it) return;
  const need = it.quantity || 1;

  if (!it.barcode) {
    const p = bzr.ticked.indexOf(i);
    if (p >= 0) bzr.ticked.splice(p, 1); else bzr.ticked.push(i);
    bzrPaint();
    return;
  }

  const got = bzr.gotByItem[i] || 0;
  if (got >= need) {
    for (let k = 0; k < need; k++) {
      const idx = bzr.scanned.lastIndexOf(it.barcode);
      if (idx >= 0) bzr.scanned.splice(idx, 1);
    }
    bzr.gotByItem[i] = 0;
  } else {
    for (let k = got; k < need; k++) bzr.scanned.push(it.barcode);
    bzr.gotByItem[i] = need;
  }
  bzrSay('', '');
  bzrPaint();
}

function bzrSetIssue(i, type) {
  const cur = bzr.issues[i];
  if (cur && cur.type === type) delete bzr.issues[i];
  else bzr.issues[i] = { type, comment: cur ? cur.comment : '' };
  if (bzr.issues[i]) delete bzr.horsStock[i];
  bzrSay('', '');
  bzrPaint();
  const c = document.getElementById('bzr-issue-' + i);
  if (c && bzr.issues[i]) c.focus();
}
// 06/11 (Luc) : écarter un article du stock à la main (ex. boîte abîmée,
// produit correct). Le retour reste conforme ; seule la remise en stock
// automatique saute cet article.
function bzrToggleHorsStock(i) {
  if (bzr.horsStock[i]) delete bzr.horsStock[i]; else bzr.horsStock[i] = { comment: '' };
  bzrPaint();
  const c = document.getElementById('bzr-hs-' + i); if (c) c.focus();
}
function bzrHorsStockComment(i, v) { if (bzr.horsStock[i]) bzr.horsStock[i].comment = v; }
function bzrIssueComment(i, v) { if (bzr.issues[i]) bzr.issues[i].comment = v; }
function bzrSetNote(v) { bzr.note = v; }

function bzrPhotosSize() { return bzr.photos.reduce((n, p) => n + p.data.length, 0); }
function bzrCompress(file, max, q) {
  return new Promise((ok, ko) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const r = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement('canvas');
        c.width = Math.round(img.naturalWidth * r); c.height = Math.round(img.naturalHeight * r);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        ok(c.toDataURL('image/jpeg', q));
      } catch (e) { URL.revokeObjectURL(url); ko(e); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); ko(new Error('illisible')); };
    img.src = url;
  });
}
async function bzrAddPhotos(input) {
  const files = Array.from((input && input.files) || []);
  if (input) input.value = '';
  if (!files.length) return;
  bzr.photoBusy = true; bzrPaint();
  const refus = [];
  for (const f of files) {
    if (bzr.photos.length >= BZR_MAX_PHOTOS) { refus.push(`${f.name} (${BZR_MAX_PHOTOS} photos au plus)`); continue; }
    try {
      let data = await bzrCompress(f, 1600, 0.72);
      if (bzrPhotosSize() + data.length > BZR_BUDGET_PHOTOS) data = await bzrCompress(f, 1100, 0.6);
      if (bzrPhotosSize() + data.length > BZR_BUDGET_PHOTOS) { refus.push(`${f.name} (trop de photos au total)`); continue; }
      const base = String(f.name || 'photo').replace(/\.[a-z0-9]{2,5}$/i, '');
      bzr.photos.push({ name: base + '.jpg', data });
    } catch (e) { refus.push(`${f.name} (format non lu — prenez la photo avec l'appareil du téléphone)`); }
  }
  bzr.photoBusy = false; bzrPaint();
  if (refus.length) bzrSay('Photo(s) non ajoutée(s) : ' + refus.join(', '), 'ko');
}
function bzrRemovePhoto(k) { bzr.photos.splice(k, 1); bzrPaint(); }

function bzrAddScan(code) {
  const c = String(code || '').trim();
  if (!c) return;
  bzr.lastScan = c;

  // Try to match a still-incomplete announced item by its real barcode, and auto-tick it.
  let matched = false;
  for (let i = 0; i < bzr.announced.length; i++) {
    const it = bzr.announced[i];
    if (!it.barcode || it.barcode !== c) continue;
    const need = it.quantity || 1;
    const got = bzr.gotByItem[i] || 0;
    if (got < need) { bzr.gotByItem[i] = got + 1; matched = true; }
    break;
  }

  if (!matched && bzr.scanned.includes(c)) return;
  bzr.scanned.push(c);
  bzrSay('', '');
  bzrPaint();
}
function bzrManualScan() {
  const el = document.getElementById('bzr-item');
  const v = el.value;
  el.value = '';
  bzrAddScan(v);
}
function bzrUndo(code) {
  const i = bzr.scanned.indexOf(code);
  if (i < 0) return;
  bzr.scanned.splice(i, 1);
  for (let j = 0; j < bzr.announced.length; j++) {
    const it = bzr.announced[j];
    if (it.barcode === code && (bzr.gotByItem[j] || 0) > 0) { bzr.gotByItem[j]--; break; }
  }
  bzrSay('', '');
  bzrPaint();
}

function bzrShowCam(on, hint) {
  const w = document.getElementById('bzr-camwrap');
  const h = document.getElementById('bzr-camhint');
  if (w) w.style.display = on ? 'block' : 'none';
  if (h) h.textContent = on ? (hint || '') : '';
}

function bzrScanConfig() {
  const F = window.Html5QrcodeSupportedFormats || {};
  const formats = [F.CODE_128, F.CODE_39, F.EAN_13, F.ITF, F.CODABAR, F.EAN_8, F.UPC_A, F.DATA_MATRIX].filter(x => x !== undefined);
  return {
    fps: 15,
    qrbox: (w, h) => ({ width: Math.floor(w * 0.92), height: Math.max(90, Math.floor(h * 0.34)) }),
    formatsToSupport: formats.length ? formats : undefined,
    videoConstraints: {
      deviceId: bzr.camId ? { exact: bzr.camId } : undefined,
      facingMode: bzr.camId ? undefined : { ideal: 'environment' },
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      advanced: [{ focusMode: 'continuous' }]
    },
    experimentalFeatures: { useBarCodeDetectorIfSupported: true },
    disableFlip: true
  };
}

function bzrCamControls() {
  const box = document.getElementById('bzr-camctl');
  if (!box) return;
  if (bzr.cams.length < 2 && !bzr.torchAvailable) { box.innerHTML = ''; return; }
  const options = bzr.cams.map(c => `<option value="${bzrEsc(c.id)}" ${c.id === bzr.camId ? 'selected' : ''}>${bzrEsc(c.label || 'Caméra')}</option>`).join('');
  box.innerHTML = `<div class="bzr-camrow">${bzr.cams.length > 1 ? `<select onchange="bzrChangeCam(this.value)">${options}</select>` : ''}${bzr.torchAvailable ? `<button onclick="bzrToggleTorch()">${bzr.torch ? 'Lampe on' : 'Lampe'}</button>` : ''}</div>`;
}

async function bzrChangeCam(id) {
  bzr.camId = id;
  try { localStorage.setItem('misuCamId', id); } catch (e) {}
  const mode = bzr.mode;
  await bzrStopCam();
  bzrStartCam(mode);
}

async function bzrToggleTorch() {
  if (!bzr.cam) return;
  try {
    bzr.torch = !bzr.torch;
    await bzr.cam.applyVideoConstraints({ advanced: [{ torch: bzr.torch }] });
    bzrCamControls();
  } catch (e) { bzr.torch = false; }
}

async function bzrStartCam(mode) {
  if (bzr.camOn) { await bzrStopCam(); return; }
  if (typeof Html5Qrcode === 'undefined') { bzrSay("Le lecteur de code-barres n'a pas pu se charger. Utilisez la saisie manuelle.", 'ko'); return; }

  bzr.mode = mode;
  const onCode = mode === 'label' ? (v) => { document.getElementById('bzr-track').value = v; bzrSetTracking(); } : bzrAddScan;
  const hint = mode === 'label'
    ? "Approche l'étiquette à 10-15 cm et cadre le grand code-barres du bas dans toute la largeur."
    : "Cadre le code-barres collé sur la boîte de l'article.";

  bzr.camOn = true; bzr.lock = false;
  bzrShowCam(true, hint);
  bzrPaint();

  try {
    if (!bzr.cams.length) {
      try {
        bzr.cams = await Html5Qrcode.getCameras();
        const memo = localStorage.getItem('misuCamId');
        if (memo && bzr.cams.some(c => c.id === memo)) bzr.camId = memo;
      } catch (e) { bzr.cams = []; }
    }

    bzr.cam = new Html5Qrcode('bzr-cam', { verbose: false });
    const source = bzr.camId ? { deviceId: { exact: bzr.camId } } : { facingMode: 'environment' };
    await bzr.cam.start(source, bzrScanConfig(), (txt) => { onCode(txt); }, () => {});

    try {
      const caps = bzr.cam.getRunningTrackCapabilities();
      bzr.torchAvailable = Boolean(caps && caps.torch);
    } catch (e) { bzr.torchAvailable = false; }

    bzrCamControls();
  } catch (e) {
    bzr.camOn = false; bzr.cam = null;
    bzrShowCam(false);
    bzrPaint();
    bzrSay("Caméra inaccessible. Vérifiez l'autorisation du navigateur, ou saisissez le code à la main.", 'ko');
  }
}

async function bzrStopCam() {
  if (bzr.cam) { try { await bzr.cam.stop(); } catch (e) {} try { bzr.cam.clear(); } catch (e) {} }
  bzr.cam = null; bzr.camOn = false; bzr.lock = false; bzr.torch = false;
  const box = document.getElementById('bzr-camctl');
  if (box) box.innerHTML = '';
  bzrShowCam(false);
}

// CORRECTIF 06/11 : un article SANS code-barres dans Shopify (ex. « Seconde
// chance ») ne peut être que coché. Avant, s'il y avait au moins un code-
// barres connu dans le colis, la coche ne comptait pas ; et s'il n'y en avait
// aucun, il fallait un scan : le bouton restait grisé. Désormais chaque
// article est jugé à part : signalé, scanné, ou coché s'il n'a pas de code.
function bzrAllComplete() {
  if (!bzr.announced.length) return false;
  return bzr.announced.every((it, i) => bzr.issues[i]
    || (it.barcode ? (bzr.gotByItem[i] || 0) >= (it.quantity || 1) : bzr.ticked.includes(i)));
}

async function bzrConfirm() {
  if (bzr.busy || bzr.photoBusy || !bzrAllComplete()) return;
  for (const k of Object.keys(bzr.issues)) {
    if (bzr.issues[k].type === 'probleme' && !String(bzr.issues[k].comment || '').trim()) {
      bzrSay('Précisez le problème de chaque article signalé (abîmé, porté, mauvais modèle…).', 'ko');
      const c = document.getElementById('bzr-issue-' + k); if (c) c.focus();
      return;
    }
  }
  await bzrStopCam();
  bzr.busy = true; bzrPaint();
  try {
    const issues = Object.keys(bzr.issues).map(k => ({
      lineItemId: (bzr.announced[k] || {}).lineItemId,
      type: bzr.issues[k].type,
      comment: String(bzr.issues[k].comment || '').trim(),
    })).filter(x => x.lineItemId);
    const photos = bzr.photos.map(p => ({ filename: p.name, content_type: 'image/jpeg', content_base64: p.data.split(',')[1] || '' }));
    const res = await bzrPost({
      mode: 'confirm', trackingNumber: bzr.tracking, scannedBarcodes: bzr.scanned,
      issues,
      // Articles sans code-barres, confirmés par la coche.
      confirmedLineItems: bzr.ticked.filter(i => bzr.announced[i] && !bzr.announced[i].barcode).map(i => bzr.announced[i].lineItemId).filter(Boolean),
      horsStock: Object.keys(bzr.horsStock).map(k => ({ lineItemId: (bzr.announced[k] || {}).lineItemId, comment: String(bzr.horsStock[k].comment || '').trim() })).filter(x => x.lineItemId),
      incident: { id: bzr.incidentId, note: String(bzr.note || '').trim(), photos }
    });
    const data = await res.json().catch(() => ({}));
    bzr.busy = false;

    if (bzrAuthFailed(res, data)) return;
    if (res.status === 409) {
      bzrPaint();
      bzrSay(data.error || 'Ce retour a déjà été réceptionné.', 'ko');
      return;
    }
    if (res.status === 404) {
      bzrPaint();
      bzrSay(data.error || 'Étiquette introuvable dans l\'inventaire.', 'ko', `<span class="bzr-code">Numéro saisi : ${bzrEsc(bzr.tracking)}</span>`);
      return;
    }
    if (!res.ok || !data.ok) {
      bzrPaint();
      bzrSay((data.error || 'Erreur lors de la validation.') + ' Vous pouvez relancer la validation : un avoir déjà émis ne sera pas recréé.', 'ko');
      return;
    }

    bzr.result = data; bzr.step = 3; bzrSay('', ''); bzrPaint();
  } catch (e) {
    bzr.busy = false;
    bzrPaint();
    bzrSay("Impossible de contacter le serveur. Vérifiez la connexion et réessayez.", 'ko');
  }
}

async function bzrReset() {
  await bzrStopCam();
  bzr.step = 1; bzr.tracking = ''; bzr.orderName = ''; bzr.returnId = ''; bzr.announced = []; bzr.ticked = []; bzr.scanned = []; bzr.gotByItem = []; bzr.result = null; bzr.lastScan = '';
  bzr.issues = {}; bzr.photos = []; bzr.note = ''; bzr.incidentId = '';
  bzrSay('', ''); bzrPaint();
}

// Bloc règlement (AUDIT 17/09) : part carte et part avoir affichées séparément.
// Avant, un avoir non émis était additionné à la carte dans "À rembourser à la
// main", et la part carte disparaissait dès qu'un code avoir était affiché.
function bzrPaymentBlock(d) {
  if (d.status !== 'RECEIVED') {
    return d.refundAmount > 0 ? `<div class="bzr-hint">Montant théorique : ${bzrEur(d.refundAmount)} — rien n'est réglé tant que le litige n'est pas résolu.</div>` : '';
  }
  const hasSplit = typeof d.cashRefundAmount === 'number' || typeof d.avoirAmount === 'number';
  const cash = hasSplit ? (d.cashRefundAmount || 0) : (d.discountSettlement ? 0 : (d.refundAmount || 0));
  const avoir = hasSplit ? (d.avoirAmount || 0) : (d.discountSettlement ? d.discountSettlement.amount : 0);
  let html = '';

  if (cash > 0) {
    const onOrigin = d.cashRefundOnOriginal > 0
      ? ` Dont ${bzrEur(d.cashRefundOnOriginal)} à rembourser sur la commande d'origine ${bzrEsc(d.originalOrderName || '')}.`
      : '';
    html += `<div class="bzr-pay"><div class="bzr-pay-l">À rembourser à la main (carte)</div><div class="bzr-pay-v">${bzrEur(cash)}</div><div class="bzr-pay-d">Commande ${bzrEsc(d.orderName)} dans Shopify.${onOrigin}</div></div>`;
  }
  if (avoir > 0) {
    // 18/09 : l'avoir est désormais une CARTE CADEAU Shopify (elle garde son
    // solde). avoirSettlement remplace discountSettlement, conservé en repli
    // le temps que le déploiement soit partout.
    const av = d.avoirSettlement || d.discountSettlement;
    if (av && av.type) {
      const incertain = av.type === 'credit_uncertain';
      const dejaEmis = av.type === 'credit_existing';
      const label = incertain
        ? 'Crédit boutique À VÉRIFIER'
        : dejaEmis ? 'Crédit boutique déjà émis pour ce retour' : 'Crédit boutique ajouté au compte de la cliente';
      const validite = av.expiresOn ? ` — valable jusqu'au ${bzrEsc(bzrDateFr(av.expiresOn))}` : '';
      const alerte = incertain
        ? ' ⚠ Réponse de Shopify non confirmée : vérifier le solde du compte client AVANT de créditer à la main.'
        : '';
      html += `<div class="bzr-pay${incertain ? ' ko' : ''}"><div class="bzr-pay-l">${label}</div><div class="bzr-pay-v">${bzrEur(avoir)}</div><div class="bzr-pay-d">Cagnotte rattachée au compte client${validite}.${alerte}</div></div>`;
    } else {
      html += `<div class="bzr-pay ko"><div class="bzr-pay-l">Avoir NON émis — crédit boutique à créer à la main</div><div class="bzr-pay-v">${bzrEur(avoir)}</div><div class="bzr-pay-d">Ne pas rembourser ce montant en carte bancaire. Commande taguée avoir-a-emettre.</div></div>`;
    }
  }
  // AUDIT 17/09 (tests réels) : sans ce bloc, un retour sans montant à rendre
  // n'affichait rien du tout — on ne savait pas si c'était 0 € ou un bug.
  if (cash <= 0 && avoir <= 0) {
    html += `<div class="bzr-pay"><div class="bzr-pay-l">Rien à rembourser</div><div class="bzr-pay-v">0,00 €</div><div class="bzr-pay-d">${bzrEsc(d.settlementNotice || "Aucun montant à rendre à la cliente pour ce retour.")}</div></div>`;
  }
  if (d.holdReleaseError) {
    html += `<div class="bzr-msg ko" style="display:block">Échange encore BLOQUÉ en préparation — à débloquer à la main dans Shopify : ${bzrEsc(d.holdReleaseError)}</div>`;
  }
  if (d.settlementError) {
    html += `<div class="bzr-msg ko" style="display:block">Erreur de règlement : ${bzrEsc(d.settlementError)}</div>`;
  }
  return html;
}

// 13/10 : résultat du ticket SAV créé dans la messagerie.
function bzrTicketBlock(d) {
  const t = d.ticketSav;
  if (!t || t.skipped) return '';
  if (t.sent) {
    const n = t.body && typeof t.body.photos === 'number' ? t.body.photos : 0;
    const quoi = t.body && t.body.appended ? 'Constat ajouté au ticket SAV existant' : 'Ticket SAV créé dans la messagerie';
    return `<div class="bzr-box">✓ ${quoi} — ${n} photo${n > 1 ? 's' : ''}.</div>`;
  }
  return `<div class="bzr-msg ko" style="display:block">Ticket SAV NON créé (${bzrEsc(t.error || 'erreur')}). La réception est bien enregistrée : prévenez Luc et gardez les photos.</div>`;
}

function bzrPaint() {
  let b = '';

  if (bzr.step === 1 && !bzrGetKey()) {
    b = `<div class="bzr-h2">Accès entrepôt</div><div class="bzr-step">Réception des retours</div>` +
      `<div class="bzr-fg"><label>Clé d'accès</label><input type="password" id="bzr-key" autocomplete="off" onkeydown="bzrOnKey(event, bzrSaveKey)"></div>` +
      `<button class="bzr-btn bzr-btn-dark" onclick="bzrSaveKey()">Enregistrer sur cet appareil</button>` +
      `<div class="bzr-hint">La clé est demandée une seule fois par appareil. Demandez-la à Luc.</div>`;
  }

  else if (bzr.step === 1) {
    b = `<div class="bzr-h2">Scanner l'étiquette</div>` +
      `<div class="bzr-fg"><label>Numéro de suivi</label><input type="text" id="bzr-track" autocomplete="off" placeholder="XT26 8888 4225 13D" value="${bzrEsc(bzr.lastScan)}" onkeydown="bzrOnKey(event, bzrSetTracking)" ${bzr.busy ? 'disabled' : ''}></div>` +
      `<button class="bzr-btn bzr-btn-dark" onclick="bzrSetTracking()" ${bzr.busy ? 'disabled' : ''}>${bzr.busy ? 'Recherche...' : 'Continuer'}</button>` +
      (bzr.camOn ? '' : `<button class="bzr-link" onclick="bzrStartCam('label')">Utiliser la caméra</button>`) +
      `<div><button class="bzr-link bzr-discret" onclick="bzrForgetKey()">Oublier la clé sur cet appareil</button></div>`;
  }

  else if (bzr.step === 2) {
    const announced = bzr.announced.map((it, i) => {
      const need = it.quantity || 1;
      const got = it.barcode ? (bzr.gotByItem[i] || 0) : (bzr.ticked.includes(i) ? need : 0);
      const done = got >= need;
      const img = it.image
        ? `<img class="bzr-pimg" src="${bzrEsc(it.image)}" alt="">`
        : `<div class="bzr-pimg-ph">Photo</div>`;
      const qty = need > 1 ? ` · ${got}/${need}` : '';
      const iss = bzr.issues[i];
      const hs = bzr.horsStock[i];
      const flag = iss ? (iss.type === 'manquant' ? 'MANQUANT' : 'PROBLÈME') : (hs ? 'HORS STOCK' : '');
      return `<div class="bzr-pitem"><div class="bzr-pline ${done && !iss ? 'ticked' : ''} ${iss ? 'flagged' : ''}">${img}` +
        `<span class="bzr-pt"><b>${bzrEsc(it.title)}</b><span>${bzrEsc(it.variantTitle)}${qty} · ${bzrActionCourt(it.action, it.exchangeTitle)}${flag ? ' · <em' + (iss ? '' : ' class="hs"') + '>' + flag + '</em>' : ''}</span>${bzrMotif(it)}</span>` +
        `<button class="bzr-pcheck" onclick="bzrToggleTick(${i})" title="Cocher = scanné">${done && !iss ? '✓' : (iss ? '!' : '')}</button></div>` +
        `<div class="bzr-issuebar"><button class="bzr-chip ${iss && iss.type === 'manquant' ? 'on' : ''}" onclick="bzrSetIssue(${i}, 'manquant')">Manquant</button>` +
        `<button class="bzr-chip ${iss && iss.type === 'probleme' ? 'on' : ''}" onclick="bzrSetIssue(${i}, 'probleme')">Problème</button>` +
        (iss ? '' : `<button class="bzr-chip bzr-chip-hs ${hs ? 'on' : ''}" onclick="bzrToggleHorsStock(${i})" title="Produit correct, mais ne pas le remettre en stock">Hors stock</button>`) + `</div>` +
        (hs && !iss ? `<input class="bzr-issue-in bzr-hs-in" id="bzr-hs-${i}" type="text" maxlength="300" placeholder="Pourquoi ? (facultatif) boîte abîmée…" value="${bzrEsc(hs.comment)}" oninput="bzrHorsStockComment(${i}, this.value)">` : '') +
        (iss ? `<input class="bzr-issue-in" id="bzr-issue-${i}" type="text" maxlength="300" placeholder="${iss.type === 'manquant' ? 'Précision : boîte vide, une seule chaussure…' : 'Quel problème ? abîmé, porté, sale…'}" value="${bzrEsc(iss.comment)}" oninput="bzrIssueComment(${i}, this.value)">` : '') +
        `</div>`;
    }).join('');

    // Codes scannés : une ligne discrète, seulement s'il y en a.
    const lignes = bzr.scanned.length
      ? `<div class="bzr-scans">${bzr.scanned.map(c => `<span class="bzr-scan">${bzrEsc(c)} <button onclick="bzrUndo('${bzrEsc(c)}')" title="Retirer">×</button></span>`).join('')}</div>`
      : '';

    // Photos et message : repliés, sauf si un article est signalé ou si
    // quelque chose y a déjà été mis.
    const ouvert = bzrHasIssues() || bzr.photos.length || bzr.note || bzr.constatOuvert;
    const constat = ouvert
      ? `<div class="bzr-section-label">Photos et message${bzrHasIssues() ? ' (conseillés)' : ''}</div>` +
        `<div class="bzr-photos">${bzr.photos.map((p, k) => `<div class="bzr-ph"><img src="${p.data}" alt=""><button onclick="bzrRemovePhoto(${k})" title="Retirer">×</button></div>`).join('')}` +
        (bzr.photos.length < BZR_MAX_PHOTOS ? `<label class="bzr-ph-add">${bzr.photoBusy ? '…' : '+ Photo'}<input type="file" accept="image/*" capture="environment" multiple onchange="bzrAddPhotos(this)"></label>` : '') + `</div>` +
        `<div class="bzr-fg"><textarea id="bzr-note" rows="3" maxlength="2000" placeholder="Message pour le SAV (état du colis, ce qui manque…)" oninput="bzrSetNote(this.value)">${bzrEsc(bzr.note)}</textarea></div>`
      : `<button class="bzr-link" onclick="bzr.constatOuvert = true; bzrPaint()">+ Photos ou message</button>`;

    const allDone = bzrAllComplete();

    b = `<div class="bzr-h2">Scanner les articles</div><div class="bzr-step">${bzrEsc(bzr.orderName)} · colis ${bzrEsc(bzr.tracking)}</div>` +
      announced +
      `<div class="bzr-fg" style="margin-top:20px"><label>Code-barres de l'article</label><input type="text" id="bzr-item" autocomplete="off" onkeydown="bzrOnKey(event, bzrManualScan)"></div>` +
      (BZR_TACTILE ? `<button class="bzr-btn" onclick="bzrManualScan()">Ajouter ce code</button>` : '') +
      (bzr.camOn ? '' : `<button class="bzr-link" onclick="bzrStartCam('item')">Utiliser la caméra</button>`) +
      lignes +
      constat +
      (bzrHasIssues() ? `<div class="bzr-hint bzr-warn">Retour signalé : il passera en litige et un ticket SAV sera créé avec les photos.</div>` : '') +
      `<button class="bzr-btn bzr-btn-dark bzr-btn2" onclick="bzrConfirm()" ${bzr.busy || bzr.photoBusy || !allDone ? 'disabled' : ''}>${bzr.busy ? 'Validation...' : (bzrHasIssues() ? 'Valider — colis non conforme' : 'Valider la réception')}</button>` +
      (allDone ? '' : `<div class="bzr-hint">Scanne, coche ou signale chaque article pour valider.</div>`) +
      `<button class="bzr-link" onclick="bzrReset()">← Autre colis</button>`;
  }

  else if (bzr.step === 3) {
    const d = bzr.result;
    const items = (d.items || []).map(i => {
      const ok = i.compliant;
      const need = i.expectedQuantity || 1, got = i.receivedQuantity || 0;
      const flag = i.issue ? ` — ${i.issue.type === 'manquant' ? 'MANQUANT' : 'PROBLÈME'}${i.issue.comment ? ' : ' + bzrEsc(i.issue.comment) : ''}`
        : (i.horsStock ? ` — pas remis en stock${i.horsStock.comment ? ' : ' + bzrEsc(i.horsStock.comment) : ''}` : '');
      return `<div class="bzr-line ${ok ? 'done' : ''}"><span class="bzr-tick">${ok ? '✓' : '!'}</span><span class="bzr-t"><b>${bzrEsc(i.title)}</b><span>${bzrEsc(i.variantTitle)} · ${bzrActionCourt(i.action, i.exchangeTitle)}${need > 1 ? ` · ${got}/${need}` : ''}${flag}</span>${i.reason !== undefined ? bzrMotif(i) : ''}</span></div>`;
    }).join('');
    const extras = (d.unexpectedScans || []).map(c => `<div class="bzr-line extra"><span class="bzr-tick">!</span><span class="bzr-t"><b>Non annoncé</b><span>${bzrEsc(c)}</span></span></div>`).join('');

    b = `<div class="bzr-h2">${d.status === 'RECEIVED' ? 'Colis conforme' : 'Colis non conforme'}</div><div class="bzr-step">${bzrEsc(d.returnId)} — commande ${bzrEsc(d.orderName)}</div>` +
      `<div class="bzr-box">${d.status === 'RECEIVED' ? (d.exchangeCompleted ? `Réception validée. L'échange ${bzrEsc(d.exchangeOrderName || '')} est à préparer.` : 'Réception validée.') : 'Réception enregistrée en litige. Aucun échange ne sera expédié tant que la situation n’est pas réglée.'}</div>` +
      bzrPaymentBlock(d) +
      bzrTicketBlock(d) +
      `<div style="margin-top:20px">${items}${extras}</div>` +
      `<button class="bzr-btn bzr-btn-dark" onclick="bzrReset()">Colis suivant</button>`;
  }

  document.getElementById('bzr-body').innerHTML = b;
  bzrFocusScan();
}

bzrPaint();
