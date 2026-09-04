// Lit / écrit INVENTORY.csv sur Dropbox pour assigner les étiquettes Colissimo.
//
// Colonnes réelles du fichier :
//   label_number,tracking_number,status,assigned_return_id,date_assigned
//
// Deux particularités du compte MISÜ :
//   - les tokens d'accès expirent au bout de 4 h, on part donc d'un refresh token
//   - c'est un compte d'équipe : les fichiers vivent dans l'espace d'équipe,
//     pas dans l'espace personnel, d'où l'en-tête Dropbox-API-Path-Root

const RETURNS_FOLDER = '/New Brands/misü/Ecommerce/Returns';
const INVENTORY_PATH = `${RETURNS_FOLDER}/INVENTORY.csv`;
const LABELS_FOLDER = `${RETURNS_FOLDER}/AVAILABLE`;
const LABEL_PREFIX = '202609021636-10-Bons Baisers de Paname-part-';

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

async function downloadCSV() {
  const res = await fetch('https://content.dropboxapi.com/2/files/download', {
    method: 'POST',
    headers: await dropboxHeaders({ 'Dropbox-API-Arg': apiArg({ path: INVENTORY_PATH }) })
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Lecture INVENTORY.csv refusée par Dropbox (HTTP ${res.status}) : ${detail}`);
  }

  return res.text();
}

async function uploadCSV(content) {
  const res = await fetch('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST',
    headers: await dropboxHeaders({
      'Dropbox-API-Arg': apiArg({ path: INVENTORY_PATH, mode: 'overwrite' }),
      'Content-Type': 'application/octet-stream'
    }),
    body: content
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Écriture INVENTORY.csv refusée par Dropbox (HTTP ${res.status}) : ${detail}`);
  }
}

function parseCSV(text) {
  const lines = text.trim().split('\n').filter((l) => l.trim() !== '');
  const headers = lines[0].split(',').map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const values = line.split(',');
    const row = {};
    headers.forEach((h, i) => (row[h] = (values[i] || '').trim()));
    return row;
  });
}

function toCSV(rows) {
  const headers = ['label_number', 'tracking_number', 'status', 'assigned_return_id', 'date_assigned'];
  const lines = [headers.join(',')];
  rows.forEach((r) => lines.push(headers.map((h) => r[h] || '').join(',')));
  return lines.join('\n');
}

// Assigne la première étiquette AVAILABLE à une commande, puis sauvegarde.
// Renvoie null s'il n'en reste aucune.
export async function assignLabel(orderNumber) {
  const text = await downloadCSV();
  const rows = parseCSV(text);
  const available = rows.find((r) => r.status === 'AVAILABLE');
  if (!available) return null;

  available.status = 'ASSIGNED';
  available.assigned_return_id = orderNumber;
  available.date_assigned = new Date().toISOString().slice(0, 10);

  await uploadCSV(toCSV(rows));

  return {
    ...available,
    remaining: rows.filter((r) => r.status === 'AVAILABLE').length,
    pdf_path: `${LABELS_FOLDER}/${LABEL_PREFIX}${available.label_number}.pdf`
  };
}
