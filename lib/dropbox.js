// Lit / écrit INVENTORY.csv sur Dropbox pour assigner les étiquettes Colissimo.
// Format attendu du CSV : label_id,tracking_number,status,order_number,assigned_date
//
// Les tokens d'accès Dropbox expirent au bout de 4 h. On stocke donc un
// refresh token permanent et on obtient un token d'accès à la demande.

const INVENTORY_PATH = '/New Brands/misü/Ecommerce/Returns/INVENTORY.csv';

let cachedToken = null;
let cachedExpiry = 0;

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

// L'en-tête Dropbox-API-Arg doit être en ASCII pur. Le « ü » du chemin
// doit donc être échappé en \uXXXX, sinon la requête part malformée.
function apiArg(obj) {
  return JSON.stringify(obj).replace(
    /[\u007f-\uffff]/g,
    (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')
  );
}

async function downloadCSV() {
  const token = await getAccessToken();

  const res = await fetch('https://content.dropboxapi.com/2/files/download', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Dropbox-API-Arg': apiArg({ path: INVENTORY_PATH })
    }
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Lecture INVENTORY.csv refusée par Dropbox (HTTP ${res.status}) : ${detail}`);
  }

  return res.text();
}

async function uploadCSV(content) {
  const token = await getAccessToken();

  const res = await fetch('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Dropbox-API-Arg': apiArg({ path: INVENTORY_PATH, mode: 'overwrite' }),
      'Content-Type': 'application/octet-stream'
    },
    body: content
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Écriture INVENTORY.csv refusée par Dropbox (HTTP ${res.status}) : ${detail}`);
  }
}

function parseCSV(text) {
  const lines = text.trim().split('\n');
  const headers = lines[0].split(',').map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const values = line.split(',');
    const row = {};
    headers.forEach((h, i) => (row[h] = (values[i] || '').trim()));
    return row;
  });
}

function toCSV(rows) {
  const headers = ['label_id', 'tracking_number', 'status', 'order_number', 'assigned_date'];
  const lines = [headers.join(',')];
  rows.forEach((r) => lines.push(headers.map((h) => r[h] || '').join(',')));
  return lines.join('\n');
}

// Assigne la première étiquette AVAILABLE à une commande, puis sauvegarde.
export async function assignLabel(orderNumber) {
  const text = await downloadCSV();
  const rows = parseCSV(text);
  const available = rows.find((r) => r.status === 'AVAILABLE');
  if (!available) return null;

  available.status = 'ASSIGNED';
  available.order_number = orderNumber;
  available.assigned_date = new Date().toISOString().slice(0, 10);

  await uploadCSV(toCSV(rows));
  return available;
}
