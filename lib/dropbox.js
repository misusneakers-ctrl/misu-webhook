// Lit / écrit INVENTORY.csv sur Dropbox pour assigner les étiquettes Colissimo.
// Format attendu du CSV : label_id,tracking_number,status,order_number,assigned_date

const INVENTORY_PATH = '/New Brands/misü/Ecommerce/Returns/INVENTORY.csv';

// L'en-tête Dropbox-API-Arg doit être en ASCII pur. Le « ü » du chemin
// doit donc être échappé en \uXXXX, sinon la requête part malformée.
function apiArg(obj) {
  return JSON.stringify(obj).replace(
    /[\u007f-\uffff]/g,
    (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')
  );
}

async function downloadCSV() {
  const res = await fetch('https://content.dropboxapi.com/2/files/download', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.DROPBOX_ACCESS_TOKEN}`,
      'Dropbox-API-Arg': apiArg({ path: INVENTORY_PATH })
    }
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(
      `Lecture INVENTORY.csv refusée par Dropbox (HTTP ${res.status}) : ${detail}`
    );
  }

  return res.text();
}

async function uploadCSV(content) {
  const res = await fetch('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.DROPBOX_ACCESS_TOKEN}`,
      'Dropbox-API-Arg': apiArg({ path: INVENTORY_PATH, mode: 'overwrite' }),
      'Content-Type': 'application/octet-stream'
    },
    body: content
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(
      `Écriture INVENTORY.csv refusée par Dropbox (HTTP ${res.status}) : ${detail}`
    );
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
