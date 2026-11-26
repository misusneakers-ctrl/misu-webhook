// lib/finalize-return.js
// Dépôt : bbp-webhook
//
// Logique partagée pour finaliser un NOUVEAU retour : assigner une étiquette
// Chronopost depuis l'inventaire, écrire RETURNS.csv/INVENTORY.csv,
// taguer/noter la commande d'origine, déclencher l'événement Klaviyo
// "Retour Demandé BBP" (email avec le lien d'étiquette).
//
// Appelée par api/create-return.js pour tout nouveau retour. Depuis le
// modèle du 18/09 (remboursement / échange de taille / avoir), aucun retour
// n'a plus de solde à payer : c'est le SEUL appelant, le webhook de paiement
// api/webhooks/order-paid.js ayant été supprimé. Ne gère pas la modification
// d'un retour existant.
//
// AUDIT 17/09 :
//  - ATTRIBUTION D'ÉTIQUETTE ATOMIQUE : la lecture d'INVENTORY.csv, le choix
//    de l'étiquette, le contrôle anti-doublon (même brouillon / même
//    commande d'échange déjà finalisé) et l'écriture se font dans une seule
//    écriture conditionnelle (lib/dropbox.js#updateTextFile). Deux
//    traitements simultanés (double clic, deux clientes en même temps) ne
//    peuvent plus prendre la même étiquette ni créer deux retours.
//  - ARTICLES DÉJÀ ENGAGÉS : si un article du retour a déjà une ligne dans
//    RETURNS.csv pour cette commande (lien de paiement réglé très tard,
//    retour modifié entre-temps…), rien n'est créé : erreur
//    ARTICLES_DEJA_RETOURNES, renvoyée en 409 par create-return.js.
//  - PDF déplacé APRÈS l'enregistrement de l'attribution ; en cas d'échec
//    du déplacement, l'étiquette est rendue au stock dans INVENTORY.csv.
//  - RETURNS.csv : ajout des lignes en écriture conditionnelle.
//
// 18/09 : frais d'étiquette dus dès qu'un article est REMBOURSÉ (un échange
// de taille ou un avoir n'en porte pas).

const { shopifyGraphQL } = require("./shopify.cjs");
const { downloadFile, updateTextFile, moveFile, RETURNS_ROOT } = require("./dropbox.cjs");
const { trackReturnRequested } = require("./klaviyo.cjs");

const INVENTORY_PATH = `${RETURNS_ROOT}/INVENTORY.csv`;
const RETURNS_CSV_PATH = `${RETURNS_ROOT}/RETURNS.csv`;
const AVAILABLE_DIR = `${RETURNS_ROOT}/AVAILABLE`;
const CONFIRMED_DIR = `${RETURNS_ROOT}/CONFIRMED`;

const INVENTORY_HEADER =
  "label_number,tracking_number,label_status,return_id,order_name,return_status,draft_order_id,pdf_file,date_assigned,date_received";
const RETURNS_HEADER =
  "return_id,order_name,line_item_id,barcode,product_title,variant_title,quantity,reason,comment,action,exchange_barcode,exchange_title,item_status,received_at";

// Doit correspondre exactement à API_BASE dans api/create-return.js, le JS
// de la page retour-bbp, et au format lu par api/label.js.
// 21/09 : bascule vers le sous-domaine de marque. Tant que
// PUBLIC_API_BASE n'est pas défini sur Vercel, on reste sur l'URL Vercel —
// changer le défaut avant que le CNAME `retours` ne résolve casserait tous
// les liens d'étiquette déjà envoyés aux clientes.
const API_BASE = require("./brand.cjs").apiBase;

// Lien d'étiquette signé (HMAC du retour avec MISU_STAFF_TOKEN) : même format
// que api/label.js, qui reste en place côté MISÜ.
function signReturnId(returnId) {
  const secret = process.env.MISU_STAFF_TOKEN || "";
  return require("crypto").createHmac("sha256", secret).update(String(returnId)).digest("hex").slice(0, 20);
}
const REFUND_FEE = 5.9;

class AlreadyReturnedError extends Error {
  constructor(message) {
    super(message);
    this.code = "ARTICLES_DEJA_RETOURNES";
  }
}

function splitCsv(content, header) {
  const lines = String(content || "").trim().split("\n");
  if (!lines[0]) return { header, rows: [] };
  return { header: lines[0], rows: lines.slice(1).filter(Boolean) };
}

function joinCsv(header, rows) {
  return [header, ...rows].join("\n") + "\n";
}

function csvEscape(value) {
  const str = String(value ?? "");
  return str.includes(",") || str.includes('"') || str.includes("\n")
    ? `"${str.replace(/"/g, '""')}"`
    : str;
}

function parseCsvLine(line) {
  const cols = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      cols.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  cols.push(current);
  return cols;
}

// foundOrder : { id, name, note, email, shippingAddress: { firstName } } —
// commande D'ORIGINE.
// items : objets envoyés par la page retour-bbp (lineItemId, title,
// variantTitle, quantity, reason, comment, action, exchangeVariantId?,
// exchangeTitle?).
// draftOrderId : GID du brouillon (échange gratuit) OU de la commande
// d'échange déjà payée (gid://shopify/Order/...).
async function finalizeNewReturn({ foundOrder, items, draftOrderId, hasExchange }) {
  // 0. Articles déjà engagés dans un retour de cette commande → on n'invente
  // pas un 2e retour (lecture simple : un doublon strictement simultané est
  // de toute façon arrêté par l'anti-doublon atomique ci-dessous).
  let existingReturnsCols = [];
  try {
    const buf = await downloadFile(RETURNS_CSV_PATH);
    existingReturnsCols = splitCsv(buf.toString("utf-8"), RETURNS_HEADER)
      .rows.map(parseCsvLine)
      .filter((cols) => cols[1] === foundOrder.name);
  } catch (e) {
    if (!/not_found/.test(e.message)) throw e;
  }

  // 1. Attribution atomique de l'étiquette dans INVENTORY.csv.
  let assigned = null; // { returnId, trackingNumber, pdfFile, labelNumber }
  let alreadyFinalized = null; // cols de la ligne existante
  const nowIso = new Date().toISOString();

  await updateTextFile(
    INVENTORY_PATH,
    (content) => {
      assigned = null;
      alreadyFinalized = null;
      const inv = splitCsv(content, INVENTORY_HEADER);
      const invCols = inv.rows.map(parseCsvLine);

      if (draftOrderId) {
        const existing = invCols.find((cols) => cols[6] === draftOrderId);
        if (existing) {
          alreadyFinalized = existing;
          return content; // rien à écrire
        }
      }

      const engaged = new Set(existingReturnsCols.map((cols) => cols[2]));
      const clash = items.find((it) => engaged.has(it.lineItemId));
      if (clash) {
        throw new AlreadyReturnedError(
          `L'article ${clash.title || clash.lineItemId} a déjà un retour sur ${foundOrder.name} — retour non créé.`
        );
      }

      const idx = invCols.findIndex((cols) => cols[2] === "AVAILABLE");
      if (idx === -1) throw new Error("Plus aucune étiquette Chronopost disponible en stock.");

      // Numéro du retour : d'après les retours déjà attribués dans
      // INVENTORY (source atomique) et RETURNS.csv.
      const usedNumbers = new Set(
        [...invCols.filter((cols) => cols[4] === foundOrder.name).map((cols) => cols[3]), ...existingReturnsCols.map((cols) => cols[0])]
          .map((id) => parseInt(String(id || "").split("-").pop(), 10))
          .filter(Number.isFinite)
      );
      let n = 1;
      while (usedNumbers.has(n)) n++;
      const returnId = `R-${foundOrder.name.replace("#", "")}-${n}`;

      const labelCols = invCols[idx];
      assigned = { returnId, trackingNumber: labelCols[1], pdfFile: labelCols[7], labelNumber: labelCols[0] };
      inv.rows[idx] = [
        labelCols[0],
        labelCols[1],
        "CONFIRMED",
        returnId,
        foundOrder.name,
        "REQUESTED",
        draftOrderId || "",
        labelCols[7],
        nowIso,
        "",
      ]
        .map(csvEscape)
        .join(",");
      return joinCsv(inv.header, inv.rows);
    },
    { defaultContent: INVENTORY_HEADER + "\n" }
  );

  if (alreadyFinalized) {
    console.warn(`finalizeNewReturn : ${draftOrderId} déjà finalisé (${alreadyFinalized[3]}) — doublon ignoré.`);
    return {
      ok: true,
      alreadyFinalized: true,
      returnId: alreadyFinalized[3],
      orderName: foundOrder.name,
      trackingNumber: alreadyFinalized[1],
      fee: items.some((i) => i.action === "refund") ? REFUND_FEE : 0,
      hasExchange,
      draftOrderId,
      itemsCount: items.length,
      updated: false,
    };
  }

  const { returnId, trackingNumber, pdfFile } = assigned;

  // 2. PDF AVAILABLE → CONFIRMED. Échec : l'étiquette est rendue au stock.
  try {
    await moveFile(`${AVAILABLE_DIR}/${pdfFile}`, `${CONFIRMED_DIR}/${pdfFile}`);
  } catch (moveErr) {
    try {
      await updateTextFile(INVENTORY_PATH, (content) => {
        const inv = splitCsv(content, INVENTORY_HEADER);
        inv.rows = inv.rows.map((r) => {
          const cols = parseCsvLine(r);
          if (cols[1] !== trackingNumber || cols[3] !== returnId) return r;
          return [cols[0], cols[1], "AVAILABLE", "", "", "", "", cols[7], "", ""].map(csvEscape).join(",");
        });
        return joinCsv(inv.header, inv.rows);
      });
    } catch (rollbackErr) {
      console.error(
        `finalizeNewReturn : ÉCHEC remise en stock de l'étiquette ${trackingNumber} (${pdfFile}) après échec du déplacement — à corriger à la main dans INVENTORY.csv :`,
        rollbackErr.message
      );
    }
    throw moveErr;
  }

  // 3. Lignes RETURNS.csv (écriture conditionnelle).
  const newReturnRows = items.map((item) =>
    [
      returnId,
      foundOrder.name,
      item.lineItemId,
      trackingNumber,
      csvEscape(item.title || ""),
      csvEscape(item.variantTitle || ""),
      item.quantity || 1,
      csvEscape(item.reason || ""),
      csvEscape(item.comment || ""),
      item.action,
      item.action === "exchange" ? trackingNumber : "",
      csvEscape(item.exchangeTitle || ""),
      "REQUESTED",
      "",
    ].join(",")
  );
  await updateTextFile(
    RETURNS_CSV_PATH,
    (content) => {
      const ret = splitCsv(content, RETURNS_HEADER);
      if (ret.rows.some((r) => parseCsvLine(r)[0] === returnId)) return content; // déjà écrit (nouvel essai)
      return joinCsv(ret.header, [...ret.rows, ...newReturnRows]);
    },
    { defaultContent: RETURNS_HEADER + "\n" }
  );

  // 4. Note + tags sur la commande d'origine.
  // Frais de retour : 5,90 € dès qu'un article est remboursé ; un avoir ou un
  // échange de taille n'en porte pas (modèle du 18/09).
  const fee = items.some((i) => i.action === "refund") ? REFUND_FEE : 0;
  const existingNote = foundOrder.note || "";
  const noteLines = existingNote.split("\n").filter((l) => !l.startsWith(`[${returnId}]`));
  noteLines.push(
    `[${returnId}] Retour demandé le ${nowIso.slice(0, 10)} — étiquette ${trackingNumber} — ${items.length} article(s)`
  );

  await shopifyGraphQL(
    `
    mutation UpdateOrder($input: OrderInput!) {
      orderUpdate(input: $input) {
        userErrors { field message }
      }
    }
    `,
    { input: { id: foundOrder.id, note: noteLines.join("\n") } }
  );
  await shopifyGraphQL(
    `
    mutation TagOrder($id: ID!, $tags: [String!]!) {
      tagsAdd(id: $id, tags: $tags) {
        userErrors { field message }
      }
    }
    `,
    { id: foundOrder.id, tags: ["retour-pending", returnId] }
  );

  // 5. Événement Klaviyo "Retour Demandé BBP" (email avec le lien
  // d'étiquette). Flow S4rGV9 encore en brouillon au 17/09 : l'événement
  // part mais aucun email n'est envoyé tant qu'il n'est pas activé.
  const labelUrl = `${API_BASE}/api/label?r=${encodeURIComponent(returnId)}&t=${signReturnId(returnId)}`;
  try {
    await trackReturnRequested({
      email: foundOrder.email,
      firstName: foundOrder.shippingAddress?.firstName,
      orderName: foundOrder.name,
      returnId,
      trackingNumber,
      labelUrl,
      items,
    });
  } catch (klaviyoErr) {
    console.error("finalizeNewReturn : échec envoi événement Klaviyo (retour créé quand même):", klaviyoErr.message);
  }

  return {
    ok: true,
    returnId,
    orderName: foundOrder.name,
    trackingNumber,
    fee,
    hasExchange,
    draftOrderId,
    itemsCount: items.length,
    updated: false,
  };
}

module.exports = { finalizeNewReturn, AlreadyReturnedError };
