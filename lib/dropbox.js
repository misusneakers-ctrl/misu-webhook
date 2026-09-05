// Accès Dropbox : inventaire d'étiquettes + contenu des retours.
//
// Deux fichiers, deux rôles distincts :
//
//   INVENTORY.csv  une ligne par étiquette. C'est le stock.
//     label_number,tracking_number,label_status,return_id,order_name,
//     return_status,date_assigned,date_received
//
//   RETURNS.csv    une ligne par article retourné.
//     return_id,order_name,line_item_id,barcode,product_title,variant_title,
//     quantity,reason,comment,action,exchange_barcode,exchange_title,
//     item_status,received_at
//
// Une commande peut porter plusieurs retours (R-1042-1, R-1042-2...).
// Chaque retour consomme sa propre étiquette et regroupe un ou plusieurs
// articles, chacun avec son motif et son action.
//
// Deux particularités du compte MISÜ :
//   - les tokens d'accès expirent au bout de 4 h, on part d'un refresh token
//   - c'est un compte d'équipe : les fichiers vivent dans l'espace d'équipe,
//     d'où l'en-tête Dropbox-API-Path-Root

const RETURNS_FOLDER = '/New Brands/misü/Ecommerce/Returns';
const INVENTORY_PATH = `${RETURNS_FOLDER}/INVENTORY.csv`;
const RETURNS_PATH = `${RETURNS_FOLDER}/RETURNS.csv`;
const FOLDER_AVAILABLE = `${RETURNS_FOLDER}/AVAILABLE`;
const FOLDER_CONFIRMED = `${RETURNS_FOLDER}/CONFIRMED`;
const FOLDER_RECEIVED = `${RETURNS_FOLDER}/RECEIVED`;
const LABEL_PREFIX = '202609021636-10-Bons Baisers de Paname-part-';

const INVENTORY_COLUMNS = [
  'label_number',
  'tracking_number',
  'label_status',
  'return_id',
  'order_name',
  'return_status',
  'draft_order_id',
  'date_assigned',
  'date_received'
];

const RETURNS_COLUMNS = [
  'return_id',
  'order_name',
  'line_item_id',
  'barcode',
  'product_title',
  'variant_title',
  'quantity',
  'reason',
  'comment',
  'action',
  'exchange_barcode',
  'exchange_title',
  'item_status',
  'received_at'
];

// États d'une étiquette dans le stock.
export const LABEL_AVAILABLE = 'AVAILABLE';
export const LABEL_ASSIGNED = 'ASSIGNED';

// Cycle de vie d'un retour.
export const RETURN_REQUESTED = 'REQUESTED';
export const RETURN_RECEIVED = 'RECEIVED';
export const RETURN_DISPUTED = 'DISPUTED';
export const RETURN_PROCESSED = 'PROCESSED';

// Cycle de vie d'un article dans un retour.
export const ITEM_REQUESTED = 'REQUESTED';
export const ITEM_RECEIVED = 'RECEIVED';
export const ITEM_MISSING = 'MISSING';
export const ITEM_UNEXPECTED = 'UNEXPECTED';
export const ITEM_WRONG_VARIANT = 'WRONG_VARIANT';

let cachedToken = null;
let cachedExpiry = 0;
let cachedRootNamespace = null;

async function getAccessToken() {
  const appKey = process.env.DROPBOX_APP_KEY;
  const appSecret = process.env.DROPBOX_APP_SECRET;
  const refreshToken = process.env.DROPBOX_REFRESH_TOKEN;

  if (!appKey || !appSecret || !refreshToken) {
    throw new Error(
      'Variables manquantes : DROPBOX_APP_KEY, DROPBOX_APP_SECRET, DROPBOX_REFRESH_TOKEN'
    );
  }

  // Marge de 60 s pour ne pas utiliser un token qui expire en cours de requête.
  if (cachedToken && Date.now() < cachedExpiry - 60000) {
    return cachedToken;
  }

  const res = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: appKey,
      client_secret: appSecret
    })
  });

  const data = await res.json().catch(() => null);

  if (!res.ok || !data?.access_token) {
    throw new Error(
      `Authentification Dropbox refusée (HTTP ${res.status}) : ${JSON.stringify(data)}`
    );
  }

  cachedToken = data.access_token;
  cachedExpiry = Date.now() + (data.expires_in || 14400) * 1000;
  return cachedToken;
}

// Sur un compte d'équipe, l'app se place par défaut dans l'espace personnel du
// membre. On récupère la racine de l'équipe pour viser le bon espace.
async function getRootNamespace(token) {
  if (cachedRootNamespace !== null) return cachedRootNamespace;

  const res = await fetch('https://api.dropboxapi.com/2/users/get_current_account', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` }
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Lecture du compte Dropbox refusée (HTTP ${res.status}) : ${detail}`);
  }

  const account = await res.json();
  cachedRootNamespace = account?.root_info?.root_namespace_id || '';
  return cachedRootNamespace;
}

// L'en-tête Dropbox-API-Arg doit être en ASCII pur : le « ü » du chemin
// doit être échappé en \uXXXX, sinon la requête part malformée.
function apiArg(obj) {
  return JSON.stringify(obj).replace(
    /[\u007f-\uffff]/g,
    (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')
  );
}

async function dropboxHeaders(extra = {}) {
  const token = await getAccessToken();
  const root = await getRootNamespace(token);

  const headers = { Authorization: `Bearer ${token}`, ...extra };
  if (root) {
    headers['Dropbox-API-Path-Root'] = JSON.stringify({ '.tag': 'root', root });
  }
  return headers;
}

// Télécharge un CSV et renvoie son contenu accompagné de sa révision.
// La révision sert à écrire sans écraser une modification concurrente.
// Un fichier absent renvoie un contenu vide plutôt qu'une erreur : c'est le
// cas de RETURNS.csv tant qu'aucun retour n'a été créé.
async function downloadCSV(path) {
  const res = await fetch('https://content.dropboxapi.com/2/files/download', {
    method: 'POST',
    headers: await dropboxHeaders({ 'Dropbox-API-Arg': apiArg({ path }) })
  });

  if (res.status === 409) {
    return { content: '', rev: null };
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Lecture ${path} refusée par Dropbox (HTTP ${res.status}) : ${detail}`);
  }

  let rev = null;
  try {
    rev = JSON.parse(res.headers.get('dropbox-api-result') || '{}').rev || null;
  } catch {
    rev = null;
  }

  return { content: await res.text(), rev };
}

// Écrit un CSV. Avec une révision, Dropbox refuse l'écriture si le fichier a
// changé entre-temps : deux retours validés à la même seconde ne peuvent plus
// s'écraser silencieusement.
async function uploadCSV(path, content, rev) {
  const mode = rev ? { '.tag': 'update', update: rev } : 'overwrite';

  const res = await fetch('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST',
    headers: await dropboxHeaders({
      'Dropbox-API-Arg': apiArg({ path, mode, autorename: false, mute: true }),
      'Content-Type': 'application/octet-stream'
    }),
    body: content
  });

  if (res.status === 409) {
    const detail = await res.text().catch(() => '');
    const conflict = new Error(`Conflit d'écriture sur ${path} : ${detail}`);
    conflict.isConflict = true;
    throw conflict;
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Écriture ${path} refusée par Dropbox (HTTP ${res.status}) : ${detail}`);
  }
}

// Déplace un fichier. Une cible déjà occupée n'est pas une erreur fatale :
// l'étiquette a simplement déjà été rangée lors d'un appel précédent.
async function moveFile(fromPath, toPath) {
  const res = await fetch('https://api.dropboxapi.com/2/files/move_v2', {
    method: 'POST',
    headers: await dropboxHeaders({ 'Content-Type': 'application/json' }),
    body: apiArg({ from_path: fromPath, to_path: toPath, autorename: true })
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Déplacement ${fromPath} refusé (HTTP ${res.status}) : ${detail}`);
  }

  return res.json();
}

// Découpe une ligne CSV en respectant les guillemets, pour qu'un commentaire
// contenant une virgule ne décale pas les colonnes suivantes.
function splitLine(line) {
  const values = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      values.push(current);
      current = '';
    } else {
      current += char;
    }
  }

  values.push(current);
  return values;
}

function parseCSV(text) {
  const lines = String(text || '')
    .replace(/\r\n/g, '\n')
    .trim()
    .split('\n')
    .filter((l) => l.trim() !== '');

  if (!lines.length) return [];

  const headers = splitLine(lines[0]).map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const values = splitLine(line);
    const row = {};
    headers.forEach((h, i) => (row[h] = (values[i] || '').trim()));
    return row;
  });
}

// Protège toutes les colonnes, pas seulement le commentaire : un titre de
// produit contenant une virgule casserait le fichier de la même façon.
function escapeValue(value) {
  const text = String(value == null ? '' : value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function toCSV(columns, rows) {
  const lines = [columns.join(',')];
  rows.forEach((r) => lines.push(columns.map((c) => escapeValue(r[c])).join(',')));
  return lines.join('\n');
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

// Les anciennes lignes utilisaient « status » ; on accepte les deux noms le
// temps que le fichier soit entièrement réécrit au nouveau format.
function labelStatus(row) {
  return row.label_status || row.status || '';
}

async function readInventory() {
  const { content, rev } = await downloadCSV(INVENTORY_PATH);
  return { rows: parseCSV(content), rev };
}

async function readReturns() {
  const { content, rev } = await downloadCSV(RETURNS_PATH);
  return { rows: parseCSV(content), rev };
}

// Retours d'une commande, articles inclus. Lecture seule : rien n'est écrit,
// ce qui permet de l'appeler à chaque affichage de la page sans effet de bord.
export async function getReturnsForOrder(orderName) {
  const [{ rows: labels }, { rows: items }] = await Promise.all([
    readInventory(),
    readReturns()
  ]);

  return labels
    .filter((l) => l.order_name === orderName && l.return_id)
    .map((label) => ({
      returnId: label.return_id,
      orderName: label.order_name,
      status: label.return_status || RETURN_REQUESTED,
      labelNumber: label.label_number,
      trackingNumber: label.tracking_number,
      draftOrderId: label.draft_order_id || null,
      dateAssigned: label.date_assigned || null,
      dateReceived: label.date_received || null,
      items: items
        .filter((i) => i.return_id === label.return_id)
        .map((i) => ({
          lineItemId: i.line_item_id,
          barcode: i.barcode,
          productTitle: i.product_title,
          variantTitle: i.variant_title,
          quantity: Number(i.quantity || 1),
          reason: i.reason,
          comment: i.comment,
          action: i.action,
          exchangeBarcode: i.exchange_barcode || null,
          exchangeTitle: i.exchange_title || null,
          status: i.item_status || ITEM_REQUESTED,
          receivedAt: i.received_at || null
        }))
    }));
}

// Identifiants de ligne déjà engagés dans un retour non annulé. Sert à ne pas
// reproposer un article qu'une cliente a déjà demandé à retourner.
export async function getLockedLineItems(orderName) {
  const returns = await getReturnsForOrder(orderName);
  const locked = new Set();
  returns.forEach((r) => r.items.forEach((i) => locked.add(i.lineItemId)));
  return locked;
}

export async function getLabelStock() {
  const { rows } = await readInventory();
  return rows.filter((r) => labelStatus(r) === LABEL_AVAILABLE).length;
}

function nextReturnId(labels, orderName) {
  const base = `R-${String(orderName).replace(/^#/, '')}`;
  const used = labels
    .filter((l) => l.order_name === orderName && l.return_id)
    .map((l) => Number(String(l.return_id).split('-').pop()) || 0);
  const next = used.length ? Math.max(...used) + 1 : 1;
  return `${base}-${next}`;
}

// Range le PDF de l'étiquette dans le dossier correspondant à son état.
// Un échec est signalé mais n'interrompt rien : la cliente reçoit son
// étiquette depuis Shopify, le rangement Dropbox est un confort interne.
async function fileLabel(labelNumber, orderName, returnId, destination) {
  const source = `${FOLDER_AVAILABLE}/${LABEL_PREFIX}${labelNumber}.pdf`;
  const cleanOrder = String(orderName).replace(/^#/, '');
  const target = `${destination}/${cleanOrder}_${returnId}_part-${labelNumber}.pdf`;

  try {
    await moveFile(source, target);
    return target;
  } catch (err) {
    // Le fichier a pu être déplacé à la main, ou déjà rangé. On le signale
    // sans faire échouer le retour.
    console.error(`Rangement de l'étiquette ${labelNumber} impossible : ${err.message}`);
    return null;
  }
}

// Crée un retour et lui assigne une étiquette.
//
// items : [{ lineItemId, barcode, productTitle, variantTitle, quantity,
//            reason, comment, action, exchangeBarcode, exchangeTitle }]
//
// Renvoie null s'il ne reste aucune étiquette disponible.
export async function createReturn(orderName, items, draftOrderId = null, attempt = 0) {
  const { rows: labels, rev: labelsRev } = await readInventory();

  const available = labels.find((r) => labelStatus(r) === LABEL_AVAILABLE);
  if (!available) return null;

  const returnId = nextReturnId(labels, orderName);

  available.label_status = LABEL_ASSIGNED;
  delete available.status;
  available.return_id = returnId;
  available.order_name = orderName;
  available.return_status = RETURN_REQUESTED;
  available.draft_order_id = draftOrderId || '';
  available.date_assigned = today();
  available.date_received = '';

  const { rows: existingItems, rev: itemsRev } = await readReturns();

  const newItems = items.map((item) => ({
    return_id: returnId,
    order_name: orderName,
    line_item_id: item.lineItemId || '',
    barcode: item.barcode || '',
    product_title: item.productTitle || '',
    variant_title: item.variantTitle || '',
    quantity: String(item.quantity || 1),
    reason: item.reason || '',
    comment: item.comment || '',
    action: item.action || '',
    exchange_barcode: item.exchangeBarcode || '',
    exchange_title: item.exchangeTitle || '',
    item_status: ITEM_REQUESTED,
    received_at: ''
  }));

  try {
    await uploadCSV(INVENTORY_PATH, toCSV(INVENTORY_COLUMNS, labels), labelsRev);
    await uploadCSV(
      RETURNS_PATH,
      toCSV(RETURNS_COLUMNS, [...existingItems, ...newItems]),
      itemsRev
    );
  } catch (err) {
    // Deux clientes ont validé au même instant : on relit et on recommence
    // plutôt que d'écraser la demande de l'autre.
    if (err.isConflict && attempt < 2) {
      return createReturn(orderName, items, draftOrderId, attempt + 1);
    }
    throw err;
  }

  const pdfPath = await fileLabel(
    available.label_number,
    orderName,
    returnId,
    FOLDER_CONFIRMED
  );

  return {
    returnId,
    labelNumber: available.label_number,
    trackingNumber: available.tracking_number,
    draftOrderId: draftOrderId || null,
    remaining: labels.filter((r) => labelStatus(r) === LABEL_AVAILABLE).length,
    pdfPath
  };
}

// Remplace le contenu d'un retour existant, tant qu'il n'est pas réceptionné.
// L'étiquette ne change pas : c'est le même colis qui reviendra.
export async function updateReturn(returnId, items, draftOrderId = null, attempt = 0) {
  const { rows: labels, rev: labelsRev } = await readInventory();
  const label = labels.find((l) => l.return_id === returnId);

  if (!label) return null;
  if ((label.return_status || RETURN_REQUESTED) !== RETURN_REQUESTED) {
    return { locked: true, status: label.return_status };
  }

  // Le brouillon précédent est renvoyé pour que l'appelant relâche son stock.
  const previousDraftId = label.draft_order_id || null;
  label.draft_order_id = draftOrderId || '';

  const { rows: existingItems, rev: itemsRev } = await readReturns();
  const others = existingItems.filter((i) => i.return_id !== returnId);

  const newItems = items.map((item) => ({
    return_id: returnId,
    order_name: label.order_name,
    line_item_id: item.lineItemId || '',
    barcode: item.barcode || '',
    product_title: item.productTitle || '',
    variant_title: item.variantTitle || '',
    quantity: String(item.quantity || 1),
    reason: item.reason || '',
    comment: item.comment || '',
    action: item.action || '',
    exchange_barcode: item.exchangeBarcode || '',
    exchange_title: item.exchangeTitle || '',
    item_status: ITEM_REQUESTED,
    received_at: ''
  }));

  try {
    await uploadCSV(INVENTORY_PATH, toCSV(INVENTORY_COLUMNS, labels), labelsRev);
    await uploadCSV(RETURNS_PATH, toCSV(RETURNS_COLUMNS, [...others, ...newItems]), itemsRev);
  } catch (err) {
    if (err.isConflict && attempt < 2) {
      return updateReturn(returnId, items, draftOrderId, attempt + 1);
    }
    throw err;
  }

  return {
    returnId,
    labelNumber: label.label_number,
    trackingNumber: label.tracking_number,
    draftOrderId: draftOrderId || null,
    previousDraftId,
    locked: false
  };
}

// Réception d'un colis. scannedBarcodes est la liste des EAN réellement
// trouvés dans le carton.
//
// Le retour ne passe RECEIVED que si tout correspond. Au moindre écart il
// passe DISPUTED : rien ne part, la commande reste en attente et l'écart est
// consigné article par article.
export async function receiveReturn(returnId, scannedBarcodes = [], attempt = 0) {
  const { rows: labels, rev: labelsRev } = await readInventory();
  const label = labels.find((l) => l.return_id === returnId);
  if (!label) return null;

  const { rows: allItems, rev: itemsRev } = await readReturns();
  const items = allItems.filter((i) => i.return_id === returnId);
  if (!items.length) return null;

  const remaining = [...scannedBarcodes.map(String)];
  const now = new Date().toISOString();

  items.forEach((item) => {
    const index = remaining.indexOf(String(item.barcode));
    if (index >= 0) {
      remaining.splice(index, 1);
      item.item_status = ITEM_RECEIVED;
      item.received_at = now;
    } else {
      item.item_status = ITEM_MISSING;
      item.received_at = '';
    }
  });

  // Ce qui reste n'était pas annoncé : mauvaise taille, mauvais modèle, ou
  // article ajouté par la cliente. Consigné plutôt qu'ignoré.
  const extras = remaining.map((barcode) => ({
    return_id: returnId,
    order_name: label.order_name,
    line_item_id: '',
    barcode,
    product_title: '',
    variant_title: '',
    quantity: '1',
    reason: '',
    comment: '',
    action: '',
    exchange_barcode: '',
    exchange_title: '',
    item_status: ITEM_UNEXPECTED,
    received_at: now
  }));

  const missing = items.filter((i) => i.item_status === ITEM_MISSING);
  const complete = missing.length === 0 && extras.length === 0;

  label.return_status = complete ? RETURN_RECEIVED : RETURN_DISPUTED;
  label.date_received = today();

  const others = allItems.filter((i) => i.return_id !== returnId);

  try {
    await uploadCSV(INVENTORY_PATH, toCSV(INVENTORY_COLUMNS, labels), labelsRev);
    await uploadCSV(
      RETURNS_PATH,
      toCSV(RETURNS_COLUMNS, [...others, ...items, ...extras]),
      itemsRev
    );
  } catch (err) {
    if (err.isConflict && attempt < 2) {
      return receiveReturn(returnId, scannedBarcodes, attempt + 1);
    }
    throw err;
  }

  await fileLabel(label.label_number, label.order_name, returnId, FOLDER_RECEIVED);

  return {
    returnId,
    orderName: label.order_name,
    status: label.return_status,
    draftOrderId: label.draft_order_id || null,
    complete,
    missing: missing.map((i) => ({
      barcode: i.barcode,
      productTitle: i.product_title,
      variantTitle: i.variant_title
    })),
    unexpected: extras.map((i) => i.barcode),
    received: items
      .filter((i) => i.item_status === ITEM_RECEIVED)
      .map((i) => ({
        lineItemId: i.line_item_id,
        barcode: i.barcode,
        action: i.action,
        exchangeBarcode: i.exchange_barcode || null
      }))
  };
}
