// lib/dropbox.js
// Dépôt : bbp-webhook
// Authentification (refresh token) et opérations fichiers Dropbox.
// Compte d'équipe Bons baisers de Paname — mêmes contraintes que documentées
// pour Misü.
//
// AUDIT 17/09 : l'en-tête annonçait des "écritures conditionnelles", mais
// tous les appels écrivaient INVENTORY.csv / RETURNS.csv en mode
// "overwrite" après les avoir lus plusieurs secondes plus tôt : deux
// traitements simultanés (une réception pendant une demande client, deux
// livraisons du webhook orders/paid) pouvaient effacer les lignes l'un de
// l'autre, ou attribuer la même étiquette deux fois. Ajout de
// updateTextFile() : lecture avec révision, modification, écriture
// conditionnelle (mode "update" + rev) et nouvel essai en cas de conflit.
// uploadFile() et downloadFile() gardent leur comportement pour les appels
// existants.

const APP_KEY = process.env.DROPBOX_APP_KEY;
const APP_SECRET = process.env.DROPBOX_APP_SECRET;
const REFRESH_TOKEN = process.env.DROPBOX_REFRESH_TOKEN;

const BRAND = require("./brand.cjs");
const RETURNS_ROOT = BRAND.returnsRoot;

// L'en-tête Dropbox-API-Arg doit être en ASCII pur : le « ü » du dossier
// MISÜ doit être échappé en \\uXXXX, sinon la requête part malformée (piège
// déjà documenté pour l'ancien portail Misü).
function apiArg(obj) {
  return JSON.stringify(obj).replace(
    /[\u007f-\uffff]/g,
    (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")
  );
}

let cachedToken = null;
let cachedTokenExpiry = 0;

async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && now < cachedTokenExpiry) {
    return cachedToken;
  }

  if (!APP_KEY || !APP_SECRET || !REFRESH_TOKEN) {
    throw new Error(
      "Variables Dropbox manquantes : DROPBOX_APP_KEY, DROPBOX_APP_SECRET, DROPBOX_REFRESH_TOKEN"
    );
  }

  const res = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: REFRESH_TOKEN,
      client_id: APP_KEY,
      client_secret: APP_SECRET,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Échec auth Dropbox (${res.status}): ${text}`);
  }

  const data = await res.json();
  cachedToken = data.access_token;
  cachedTokenExpiry = now + (data.expires_in - 60) * 1000;
  return cachedToken;
}

// Compte d'équipe : sans l'en-tête Dropbox-API-Path-Root pointant vers le
// bon root_namespace_id, l'API renvoie path/not_found même si le fichier
// existe (même piège que documenté pour misu-webhook). On le résout une
// fois et on le met en cache mémoire.
let cachedPathRoot = null;

async function getPathRootHeader(token) {
  if (cachedPathRoot) return cachedPathRoot;

  const res = await fetch("https://api.dropboxapi.com/2/users/get_current_account", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Échec récupération root_namespace (${res.status})`);
  }
  const account = await res.json();
  const namespaceId = account.root_info?.root_namespace_id;
  if (!namespaceId) {
    // Compte personnel, pas d'équipe — pas besoin de l'en-tête.
    cachedPathRoot = "";
    return cachedPathRoot;
  }
  cachedPathRoot = JSON.stringify({ ".tag": "root", root: namespaceId });
  return cachedPathRoot;
}

async function apiCall(endpoint, body) {
  const token = await getAccessToken();
  const pathRoot = await getPathRootHeader(token);
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  if (pathRoot) headers["Dropbox-API-Path-Root"] = pathRoot;

  const res = await fetch(`https://api.dropboxapi.com/2/${endpoint}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Dropbox ${endpoint} error: ${JSON.stringify(data)}`);
  }
  return data;
}

async function listFolder(path) {
  const data = await apiCall("files/list_folder", { path });
  let entries = data.entries;
  let cursor = data.cursor;
  while (data.has_more) {
    const more = await apiCall("files/list_folder/continue", { cursor });
    entries = entries.concat(more.entries);
    cursor = more.cursor;
    if (!more.has_more) break;
  }
  return entries;
}

async function downloadFile(path) {
  const token = await getAccessToken();
  const pathRoot = await getPathRootHeader(token);
  const headers = {
    Authorization: `Bearer ${token}`,
    "Dropbox-API-Arg": apiArg({ path }),
  };
  if (pathRoot) headers["Dropbox-API-Path-Root"] = pathRoot;

  const res = await fetch("https://content.dropboxapi.com/2/files/download", {
    method: "POST",
    headers,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Échec téléchargement Dropbox (${res.status}): ${text}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  return buffer;
}

// Comme downloadFile, mais renvoie aussi la révision Dropbox du fichier
// (nécessaire pour une écriture conditionnelle).
async function downloadFileWithMeta(path) {
  const token = await getAccessToken();
  const pathRoot = await getPathRootHeader(token);
  const headers = {
    Authorization: `Bearer ${token}`,
    "Dropbox-API-Arg": apiArg({ path }),
  };
  if (pathRoot) headers["Dropbox-API-Path-Root"] = pathRoot;

  const res = await fetch("https://content.dropboxapi.com/2/files/download", {
    method: "POST",
    headers,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Échec téléchargement Dropbox (${res.status}): ${text}`);
  }
  let meta = {};
  try {
    meta = JSON.parse(res.headers.get("dropbox-api-result") || "{}");
  } catch (e) {
    meta = {};
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, rev: meta.rev || null };
}

// mode : "add" | "overwrite" | { ".tag": "update", update: "<rev>" }
async function uploadFile(path, content, mode = "add") {
  const token = await getAccessToken();
  const pathRoot = await getPathRootHeader(token);
  // Écriture conditionnelle (update + rev) : conflit renvoyé même si le
  // fichier a été supprimé entre-temps. Les autres modes sont envoyés
  // exactement comme avant.
  const conditional = typeof mode === "object";
  const headers = {
    Authorization: `Bearer ${token}`,
    "Dropbox-API-Arg": apiArg({
      path,
      mode,
      mute: true,
      ...(conditional ? { autorename: false, strict_conflict: true } : {}),
    }),
    "Content-Type": "application/octet-stream",
  };
  if (pathRoot) headers["Dropbox-API-Path-Root"] = pathRoot;

  const res = await fetch("https://content.dropboxapi.com/2/files/upload", {
    method: "POST",
    headers,
    body: content,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Échec upload Dropbox (${res.status}): ${text}`);
  }
  return res.json();
}

class DropboxConflictError extends Error {}

// Lecture-modification-écriture sûre d'un fichier texte.
// mutate(content: string) → nouveau contenu (string). mutate peut lever une
// erreur pour annuler (rien n'est écrit) ; il est rappelé sur le contenu
// FRAIS à chaque nouvel essai, il doit donc être rejouable.
// defaultContent : contenu de départ si le fichier n'existe pas encore.
async function updateTextFile(path, mutate, { defaultContent = "", maxAttempts = 5 } = {}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let content = defaultContent;
    let rev = null;
    try {
      const file = await downloadFileWithMeta(path);
      content = file.buffer.toString("utf-8");
      rev = file.rev;
    } catch (e) {
      if (!/not_found/.test(e.message)) throw e;
    }
    const next = await mutate(content);
    if (next === content) return content;
    const mode = rev ? { ".tag": "update", update: rev } : "add";
    try {
      await uploadFile(path, next, mode);
      return next;
    } catch (e) {
      if (!/conflict/.test(e.message)) throw e;
      if (attempt === maxAttempts) {
        throw new DropboxConflictError(`Conflit d'écriture persistant sur ${path} (${maxAttempts} essais).`);
      }
      // Petite attente aléatoire avant de relire la version à jour.
      await new Promise((r) => setTimeout(r, 150 + Math.floor(Math.random() * 350)));
    }
  }
  throw new DropboxConflictError(`Conflit d'écriture sur ${path}.`);
}

async function moveFile(fromPath, toPath) {
  return apiCall("files/move_v2", {
    from_path: fromPath,
    to_path: toPath,
    autorename: true,
  });
}

module.exports = {
  getAccessToken,
  listFolder,
  downloadFile,
  downloadFileWithMeta,
  uploadFile,
  updateTextFile,
  DropboxConflictError,
  moveFile,
  getPathRootHeader,
  RETURNS_ROOT,
};
