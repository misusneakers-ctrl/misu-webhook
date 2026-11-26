// api/receive-return.js
// Dépôt : bbp-webhook
//
// Réception d'un retour au scan, en deux modes (repris de l'architecture Misü) :
//
//  - mode: "lookup"  → à partir du seul numéro de suivi, renvoie les articles
//                       annoncés pour ce retour (titre, variante, quantité,
//                       action, image, barcode) SANS rien écrire. Sert à
//                       afficher le récapitulatif visuel avant de scanner, et
//                       à faire correspondre un scan/une coche à l'article
//                       exact.
//  - mode: "confirm" (comportement par défaut si "mode" absent) → comparaison
//                       aux codes-barres scannés, finalisation de l'échange,
//                       calcul du règlement, écriture CSV + Shopify.
//
// Au moindre écart en confirmation : rien ne part (pas de complétion
// d'échange, pas d'avoir), le retour passe DISPUTED, l'écart est consigné
// article par article.
//
// Depuis le 15/09 (paiement d'abord), un échange payant est déjà une vraie
// commande au moment du scan : il reste seulement à lever son hold de
// préparation. Un échange gratuit est encore un brouillon, complété ici.
//
// La colonne "barcode" de RETURNS.csv contient le tracking de l'étiquette,
// pas le code-barres de l'article : on lit variant.barcode sur Shopify.
//
// POST /api/receive-return
// En-tête obligatoire : X-BBP-Reception-Key: <RECEPTION_API_KEY>
// Body (lookup): { mode: "lookup", trackingNumber: "XT269025577TS" }
// Body (confirm): { mode: "confirm", trackingNumber: "...", scannedBarcodes: ["376…", "376…"],
//                   issues?: [{ lineItemId, type: "manquant"|"probleme", comment }],
//                   horsStock?: [{ lineItemId, comment }],
//                   confirmedLineItems?: [lineItemId],          // 06/11 : article SANS code-barres, coché à la main   // 06/11 : article conforme mais PAS remis en stock
//                   incident?: { id, note, photos: [{ filename, content_type, content_base64 }] } }
//
// 13/10 (Luc) — CONSTAT DE L'ENTREPÔT : au scan, l'opérateur peut marquer un
// article « manquant » ou « problème » (abîmé, porté, pas le bon modèle…),
// ajouter des photos et un message. Un article signalé n'est jamais conforme,
// même scanné : le retour passe DISPUTED (rien ne part). Dès qu'un retour est
// en litige — ou qu'un message / des photos accompagnent un retour conforme —,
// le constat part à la messagerie, qui ouvre un ticket SAV « Retour non
// conforme — commande Cxxxxx » avec les photos (lib/notify-messagerie.js →
// signalerIncidentReception). Non bloquant, comme la fiche retour.
//
// Correctif 17/09 (matin) — règlement carte / avoir, voir lib/settlement.js.
//
// AUDIT 17/09 (correctifs, voir claude/AUDIT-Retours-BBP-2026-09-17.md) :
//  - ACCÈS PROTÉGÉ : l'endpoint était public et la page reception-bbp est
//    publiée (coche manuelle possible). N'importe qui connaissant un numéro
//    de suivi (imprimé sur l'étiquette, numéros consécutifs) pouvait valider
//    un retour sans rien renvoyer et obtenir un avoir ou l'expédition de son
//    échange. Les deux modes exigent maintenant l'en-tête X-BBP-Reception-Key
//    égal à la variable d'environnement Vercel RECEPTION_API_KEY (refus si la
//    variable n'est pas définie) ;
//  - RE-SCAN D'UN RETOUR EN LITIGE : le PDF déjà dans RECEIVED faisait
//    planter la réception APRÈS l'émission de l'avoir (un nouvel avoir +
//    email à chaque nouvel essai, rien d'écrit). Maintenant : PDF déplacé en
//    premier et toléré s'il l'est déjà, brouillon déjà complété réutilisé,
//    avoir déjà émis pour ce retour retrouvé (titre "Avoir <returnId>") au
//    lieu d'en créer un autre, tag retour-litige retiré si le retour devient
//    conforme ;
//  - RETURNS.csv réécrit AVEC échappement (un commentaire contenant une
//    virgule décalait toutes les colonnes de la ligne) ;
//  - plus de réactivation du code d'origine : toujours un nouveau code
//    (la réactivation ne servait que si le montant égalait exactement la
//    valeur du code, rendait le code réutilisable par quiconque le connaît,
//    et n'était pas rejouable sans risque) ;
//  - suffixe du code avoir = HMAC(secret, returnId) : non devinable et
//    identique à chaque essai (idempotence sans dépendre de la recherche) ;
//  - commande d'échange dont l'origine a été payée en carte : la note précise
//    la part carte à rembourser sur la commande d'origine ;
//  - analyse des paiements partagée avec create-return (lib/order-payments.js).

const crypto = require("crypto");
const { shopifyGraphQL } = require("../lib/shopify.cjs");
const { downloadFile, updateTextFile, moveFile, RETURNS_ROOT } = require("../lib/dropbox.cjs");
const { trackAvoirIssued } = require("../lib/klaviyo.cjs");
const { round2, parseCashAlreadySettled, refundsEngaged, returnNumber, computeSettlement } = require("../lib/settlement.cjs");
const { ORDER_PAYMENT_FIELDS, LINE_ITEM_PAYMENT_FIELDS, analyzeOrderPayments } = require("../lib/order-payments.cjs");
const { issueStoreCredit, CREDIT_VALIDITY_MONTHS: GIFT_CARD_VALIDITY_MONTHS } = require("../lib/store-credit.cjs");
const { restockReceivedItems } = require("../lib/inventory.cjs");
// 22/09 : pousse la fiche retour vers la messagerie (messagerie-influence-sav).
// Ne jette JAMAIS — voir lib/notify-messagerie.js.
const { notifierMessagerie, signalerIncidentReception } = require("../lib/notify-messagerie.cjs");
// 13/10 : échange plus cher dont la différence est payée par un lien séparé.
const { completerEchangePaye, ATTR_PAIEMENT } = require("../lib/echange-paiement.cjs");

const INVENTORY_PATH = `${RETURNS_ROOT}/INVENTORY.csv`;
const RETURNS_CSV_PATH = `${RETURNS_ROOT}/RETURNS.csv`;
const CONFIRMED_DIR = `${RETURNS_ROOT}/CONFIRMED`;
const RECEIVED_DIR = `${RETURNS_ROOT}/RECEIVED`;

const REFUND_FEE = 5.9;
// Validité d'un avoir : 6 mois, définie dans lib/gift-card.js.
const AVOIR_VALIDITY_MONTHS = GIFT_CARD_VALIDITY_MONTHS;
const BRAND = require("../lib/brand.cjs");
const RECEPTION_KEY_HEADERS = BRAND.receptionKeyHeaders;

// --- Helpers CSV (dupliqués de create-return.js). ---

function parseCsv(content) {
  const lines = content.trim().split("\n");
  return { header: lines[0], rows: lines.slice(1).filter(Boolean) };
}

async function readCsv(path, defaultHeader) {
  try {
    const buf = await downloadFile(path);
    return parseCsv(buf.toString("utf-8"));
  } catch (e) {
    return { header: defaultHeader, rows: [] };
  }
}

// Réécrit les lignes d'un CSV en écriture conditionnelle (audit 17/09) :
// mapRow(cols, rowIndexAmongMatches) est rejoué sur le contenu à jour si un
// autre traitement a écrit le fichier entre-temps.
async function rewriteCsvRows(path, match, mapRow) {
  await updateTextFile(path, (content) => {
    const { header, rows } = parseCsv(content);
    let k = 0;
    const next = rows.map((r) => {
      const cols = parseCsvLine(r);
      if (!match(cols)) return r;
      return mapRow(cols, k++).map((v) => csvEscape(v)).join(",");
    });
    return [header, ...next].join("\n") + "\n";
  });
}

function csvEscape(value) {
  const str = String(value ?? "");
  return str.includes(",") || str.includes('"') || str.includes("\n")
    ? `"${str.replace(/"/g, '""')}"`
    : str;
}

// Parse d'une ligne CSV en tenant compte des champs entre guillemets.
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

// Normalise un numéro de suivi (saisie exacte ou scan du gros code-barres
// de routage, qui contient l'identifiant sans le suffixe "TS").
function normalizeTracking(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function findInventoryIndex(inventoryRows, trackingNumber) {
  const normalizedScan = normalizeTracking(trackingNumber);
  return inventoryRows.findIndex((r) => {
    const stored = parseCsvLine(r)[1];
    if (!stored) return false;
    if (normalizeTracking(stored) === normalizedScan) return true;
    const storedCore = stored.replace(/TS$/i, "");
    return storedCore.length > 0 && normalizedScan.includes(normalizeTracking(storedCore));
  });
}

// Contrôle de la clé d'accès entrepôt (comparaison à temps constant).
function checkReceptionKey(req) {
  // Clé dédiée, sinon le jeton interne déjà utilisé par l'ancienne page de
  // réception MISÜ : les postes existants continuent de fonctionner.
  const expected = process.env.RECEPTION_API_KEY || process.env.MISU_STAFF_TOKEN || "";
  if (!expected) {
    return { status: 503, error: "Réception désactivée : RECEPTION_API_KEY n'est pas configurée sur Vercel." };
  }
  const headers = req.headers || {};
  let provided = "";
  for (const name of RECEPTION_KEY_HEADERS) {
    if (headers[name]) { provided = String(headers[name]); break; }
  }
  const a = crypto.createHash("sha256").update(provided).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  if (!provided || !crypto.timingSafeEqual(a, b)) {
    return { status: 401, error: "Clé d'accès entrepôt manquante ou incorrecte." };
  }
  return null;
}

function isNotFoundError(err) {
  return /not_found/i.test(String(err?.message || err || ""));
}

// CORRECTIF 06/11 : recale un brouillon d'échange OFFERT avant de l'achever
// (prix de la variante changé depuis la demande, ex. promo Black November).
// Lignes re-posées au prix du jour + remise de 100 % → total 0 € quoi qu'il
// arrive au prix. Exporté pour les tests.
async function recalerEchangeOffert(shopifyGraphQL, draftOrderId) {
  const lu = await shopifyGraphQL(
    `query EchangeARecaler($id: ID!) {
      draftOrder(id: $id) {
        id status reserveInventoryUntil
        appliedDiscount { title value valueType }
        lineItems(first: 50) { nodes { quantity variant { id price } originalUnitPriceSet { shopMoney { amount } } } }
      }
    }`,
    { id: draftOrderId }
  );
  const d = lu && lu.draftOrder;
  if (!d || d.status === "COMPLETED") return { recale: false };
  const lignes = (d.lineItems?.nodes || []).filter((l) => l.variant && l.variant.id);
  if (!lignes.length) return { recale: false };
  const dejaBon =
    d.appliedDiscount && d.appliedDiscount.valueType === "PERCENTAGE" && Number(d.appliedDiscount.value) === 100 &&
    lignes.every((l) => Number(l.originalUnitPriceSet?.shopMoney?.amount) === Number(l.variant.price));
  if (dejaBon) return { recale: false };
  const input = {
    lineItems: lignes.map((l) => ({ variantId: l.variant.id, quantity: l.quantity || 1 })),
    appliedDiscount: { valueType: "PERCENTAGE", value: 100, title: d.appliedDiscount?.title || "Valeur article(s) retourné(s)" },
  };
  if (d.reserveInventoryUntil && Date.parse(d.reserveInventoryUntil) > Date.now()) input.reserveInventoryUntil = d.reserveInventoryUntil;
  const r = await shopifyGraphQL(
    `mutation RecalerEchange($id: ID!, $input: DraftOrderInput!) {
      draftOrderUpdate(id: $id, input: $input) { draftOrder { id totalPriceSet { shopMoney { amount } } } userErrors { field message } }
    }`,
    { id: draftOrderId, input }
  );
  const errs = r?.draftOrderUpdate?.userErrors || [];
  if (errs.length) throw new Error(`Recalage du brouillon d'échange impossible : ${JSON.stringify(errs)}`);
  return { recale: true, total: r?.draftOrderUpdate?.draftOrder?.totalPriceSet?.shopMoney?.amount };
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", require("../lib/brand.cjs").siteUrl);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Misu-Reception-Key, X-Misu-Token");
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Méthode non autorisée, utiliser POST." });
    return;
  }

  const authError = checkReceptionKey(req);
  if (authError) {
    res.status(authError.status).json({ ok: false, error: authError.error });
    return;
  }

  try {
    const { mode, trackingNumber, scannedBarcodes, issues, incident, horsStock, confirmedLineItems } = req.body || {};
    const effectiveMode = mode === "lookup" ? "lookup" : "confirm";

    if (!trackingNumber) {
      res.status(400).json({ ok: false, error: "Paramètre 'trackingNumber' requis." });
      return;
    }
    if (effectiveMode === "confirm" && !Array.isArray(scannedBarcodes)) {
      res.status(400).json({ ok: false, error: "Paramètre 'scannedBarcodes' requis pour la confirmation." });
      return;
    }

    // 1. Retrouver le retour associé à cette étiquette dans INVENTORY.csv.
    const inventoryCsv = await readCsv(
      INVENTORY_PATH,
      "label_number,tracking_number,label_status,return_id,order_name,return_status,draft_order_id,pdf_file,date_assigned,date_received"
    );
    const invIndex = findInventoryIndex(inventoryCsv.rows, trackingNumber);
    if (invIndex === -1) {
      res.status(404).json({ ok: false, error: "Étiquette introuvable dans l'inventaire." });
      return;
    }
    const invCols = parseCsvLine(inventoryCsv.rows[invIndex]);
    const [, , , returnId, orderName, currentReturnStatus, draftOrderId, pdfFile] = invCols;

    if (!returnId) {
      res.status(404).json({ ok: false, error: "Cette étiquette n'est attribuée à aucun retour." });
      return;
    }
    if (currentReturnStatus === "RECEIVED") {
      res.status(409).json({ ok: false, error: `Ce retour (${returnId}) a déjà été réceptionné.` });
      return;
    }

    // 2. Articles annoncés pour ce retour.
    const returnsCsv = await readCsv(
      RETURNS_CSV_PATH,
      "return_id,order_name,line_item_id,barcode,product_title,variant_title,quantity,reason,comment,action,exchange_barcode,exchange_title,item_status,received_at"
    );
    const itemRowIndexes = returnsCsv.rows
      .map((r, idx) => ({ cols: parseCsvLine(r), idx }))
      .filter(({ cols }) => cols[0] === returnId);

    if (itemRowIndexes.length === 0) {
      res.status(404).json({ ok: false, error: `Aucun article trouvé pour le retour ${returnId}.` });
      return;
    }

    // 3. Commande Shopify : codes-barres, images, paiements.
    const data = await shopifyGraphQL(
      `
      query FindOrderForReception($query: String!) {
        orders(first: 1, query: $query) {
          edges {
            node {
              id
              name
              note
              email
              customer { id }
              shippingAddress { firstName }
              totalRefundedSet { shopMoney { amount } }
              ${ORDER_PAYMENT_FIELDS}
              lineItems(first: 50) {
                edges {
                  node {
                    id
                    image { url altText }
                    variant { id barcode price inventoryItem { id } }
                    ${LINE_ITEM_PAYMENT_FIELDS}
                  }
                }
              }
            }
          }
        }
      }
      `,
      { query: `name:${orderName}` }
    );

    const foundOrder = data.orders.edges[0]?.node;
    if (!foundOrder) {
      res.status(404).json({ ok: false, error: `Commande ${orderName} introuvable sur Shopify.` });
      return;
    }

    const lineItemMap = {};
    for (const edge of foundOrder.lineItems.edges) {
      lineItemMap[edge.node.id] = {
        barcode: edge.node.variant?.barcode || null,
        image: edge.node.image?.url || null,
        // Remise en stock à la réception (21/09) — voir lib/inventory.js.
        inventoryItemId: edge.node.variant?.inventoryItem?.id || null,
      };
    }

    // --- Mode "lookup" : récapitulatif visuel, rien d'écrit. ---
    if (effectiveMode === "lookup") {
      const items = itemRowIndexes.map(({ cols }) => {
        const lineItemId = cols[2];
        const shopifyInfo = lineItemMap[lineItemId] || {};
        return {
          lineItemId,
          title: cols[4],
          variantTitle: cols[5],
          quantity: parseInt(cols[6], 10) || 1,
          reason: cols[7],
          comment: cols[8] || null,
          action: cols[9],
          exchangeTitle: cols[11] || null,
          image: shopifyInfo.image || null,
          barcode: shopifyInfo.barcode || null,
        };
      });
      res.status(200).json({ ok: true, returnId, orderName, status: currentReturnStatus, items });
      return;
    }

    // --- Mode "confirm". ---

    const settlementErrors = [];
    const logSettlementError = (label, err) => {
      const msg = err?.message || (typeof err === "string" ? err : JSON.stringify(err));
      console.error(`[receive-return ${returnId}] ${label} : ${msg}`);
      settlementErrors.push(`${label} : ${msg}`);
    };

    // 3bis. Moyens de paiement (avoir / carte), valeur des articles au prix payé.
    const payments = await analyzeOrderPayments(shopifyGraphQL, foundOrder, { onError: logSettlementError });
    const valueOfLine = payments.valueOfLine;

    // 4. Comparer article par article.
    // Articles signalés par l'entrepôt (13/10). Seuls deux types existent.
    const issueByLine = {};
    for (const it of Array.isArray(issues) ? issues : []) {
      if (!it || !it.lineItemId || !["manquant", "probleme"].includes(it.type)) continue;
      issueByLine[it.lineItemId] = { type: it.type, comment: String(it.comment || "").trim().slice(0, 500) };
    }

    // 06/11 (Luc) : article conforme (le retour suit son cours : échange,
    // avoir, remboursement) mais ÉCARTÉ du stock à la main — ex. boîte
    // abîmée. La remise en stock automatique le saute ; c'est noté.
    const horsStockByLine = {};
    for (const it of Array.isArray(horsStock) ? horsStock : []) {
      if (!it || !it.lineItemId) continue;
      horsStockByLine[it.lineItemId] = { comment: String(it.comment || "").trim().slice(0, 300) };
    }

    const remainingScans = [...scannedBarcodes];
    const itemResults = [];
    let hasDiscrepancy = false;
    let refundTotal = 0;
    // Modèle du 18/09 : action "credit" = la cliente a demandé un AVOIR sur cet
    // article (crédit boutique, valeur entière, sans frais de retour).
    let creditTotal = 0;
    // Valeur des articles échangés (compensés en nature) : sert à la règle 2.
    let exchangeTotal = 0;
    const exchangeItemsPresent = itemRowIndexes.some(({ cols }) => cols[9] === "exchange");
    const nowIso = new Date().toISOString();

    for (const { cols, idx } of itemRowIndexes) {
      const lineItemId = cols[2];
      const quantity = parseInt(cols[6], 10) || 1;
      const action = cols[9];
      const expectedBarcode = (lineItemMap[lineItemId] || {}).barcode;

      let matchedCount = 0;
      // CORRECTIF 06/11 (C296009, articles « Seconde chance ») : un article
      // sans code-barres dans Shopify ne peut pas être scanné. Coché par
      // l'entrepôt, il compte comme reçu en entier.
      if (!expectedBarcode && Array.isArray(confirmedLineItems) && confirmedLineItems.includes(lineItemId)) matchedCount = quantity;
      else for (let q = 0; q < quantity; q++) {
        const scanIdx = remainingScans.indexOf(expectedBarcode);
        if (expectedBarcode && scanIdx !== -1) {
          remainingScans.splice(scanIdx, 1);
          matchedCount++;
        }
      }

      const issue = issueByLine[lineItemId] || null;
      // Un article signalé (manquant / problème) n'est jamais conforme, même scanné.
      const compliant = matchedCount === quantity && !issue;
      if (!compliant) hasDiscrepancy = true;
      if (action === "refund") refundTotal += valueOfLine(lineItemId) * matchedCount;
      if (action === "credit") creditTotal += valueOfLine(lineItemId) * matchedCount;
      if (action === "exchange") exchangeTotal += valueOfLine(lineItemId) * matchedCount;

      itemResults.push({
        lineItemId,
        title: cols[4],
        variantTitle: cols[5],
        action,
        expectedQuantity: quantity,
        receivedQuantity: matchedCount,
        compliant,
        exchangeTitle: cols[11] || null,
        reason: cols[7] || null,
        comment: cols[8] || null,
        issue,
        horsStock: horsStockByLine[lineItemId] || null,
      });

      // Réécriture AVEC échappement (correctif audit 17/09).
      returnsCsv.rows[idx] = cols
        .map((v, i) => {
          if (i === 12) return compliant ? "RECEIVED" : "DISPUTED";
          if (i === 13) return nowIso;
          return csvEscape(v);
        })
        .join(",");
    }

    const unexpectedScans = remainingScans;
    if (unexpectedScans.length > 0) hasDiscrepancy = true;
    const finalStatus = hasDiscrepancy ? "DISPUTED" : "RECEIVED";

    // 5. PDF CONFIRMED → RECEIVED en PREMIER (avant tout effet de bord). Déjà
    // déplacé (re-scan d'un retour en litige) : on continue.
    // MISÜ : les étiquettes déjà assignées avant la bascule ont été RENOMMÉES
    // « <commande>_<retour>_<original> » ; les nouvelles gardent leur nom. On
    // essaie les deux, le premier trouvé gagne.
    {
      const cleanOrder = String(orderName || "").replace(/^#/, "");
      const noms = [pdfFile, `${cleanOrder}_${returnId}_${pdfFile}`];
      let deplace = false;
      for (const nom of noms) {
        try {
          await moveFile(`${CONFIRMED_DIR}/${nom}`, `${RECEIVED_DIR}/${nom}`);
          deplace = true;
          break;
        } catch (moveErr) {
          if (!isNotFoundError(moveErr)) throw moveErr;
        }
      }
      if (!deplace) {
        console.warn(`[receive-return ${returnId}] PDF ${pdfFile} absent de CONFIRMED (déjà déplacé ?) — on continue.`);
      }
    }

    // 6. Échange : seulement si TOUT le retour est conforme.
    // exchangeAvoirDifference ne concerne plus que les retours créés AVANT la
    // bascule du 18/09 (échange vers un autre modèle moins cher) : la
    // différence est ajoutée à l'avoir pour que ces retours se règlent
    // correctement. Aucun retour créé après n'en porte.
    // 13/10 : bbp_avoir_difference est de nouveau posé, par les échanges vers
    // un article MOINS cher décidés depuis la messagerie (api/sav/changer-action.js).
    let exchangeAvoirDifference = 0;
    // 13/10 : échange vers un article PLUS cher (messagerie) — lien de paiement.
    let exchangeDifferenceAPayer = 0;
    let exchangePaymentLinkSent = false;
    let exchangePaymentLink = null;
    // 13/10 : lien de différence envoyé avant réception, pas encore payé.
    let exchangeAwaitingPayment = null;
    let exchangeOrderId = null;
    let exchangeOrderName = null;
    const holdReleaseErrors = [];
    if (!hasDiscrepancy && exchangeItemsPresent && draftOrderId) {
      if (draftOrderId.startsWith("gid://shopify/Order/")) {
        // Échange payant déjà payé — lever le(s) hold(s) de préparation.
        exchangeOrderId = draftOrderId;
        const foQuery = await shopifyGraphQL(
          `
          query GetExchangeOrderFulfillmentOrders($id: ID!) {
            order(id: $id) {
              name
              fulfillmentOrders(first: 10) {
                edges { node { id status } }
              }
            }
          }
          `,
          { id: draftOrderId }
        );
        exchangeOrderName = foQuery.order?.name || null;
        const fulfillmentOrders = foQuery.order?.fulfillmentOrders?.edges || [];
        for (const edge of fulfillmentOrders) {
          if (edge.node.status && edge.node.status !== "ON_HOLD") continue;
          // lib/shopify.js lève une erreur sur userErrors : non bloquant ici,
          // signalé dans la note (le hold se lève aussi à la main).
          try {
            await shopifyGraphQL(
              `
              mutation ReleaseHold($id: ID!) {
                fulfillmentOrderReleaseHold(id: $id) {
                  fulfillmentOrder { id status }
                  userErrors { field message }
                }
              }
              `,
              { id: edge.node.id }
            );
          } catch (releaseErr) {
            console.error(`Échec levée du hold sur ${edge.node.id} (${exchangeOrderName}):`, releaseErr.message);
            holdReleaseErrors.push(`${exchangeOrderName || edge.node.id} : ${releaseErr.message}`);
          }
        }
      } else if (draftOrderId.startsWith("gid://shopify/DraftOrder/")) {
        // Échange gratuit : différence éventuelle (attribut posé par
        // create-return), lue avant la complétion ; brouillon déjà complété
        // (re-scan) → on réutilise sa commande.
        const draftData = await shopifyGraphQL(
          `
          query GetExchangeDraft($id: ID!) {
            draftOrder(id: $id) { id status order { id name } customAttributes { key value } }
          }
          `,
          { id: draftOrderId }
        );
        const draft = draftData.draftOrder;
        if (!draft) {
          res.status(500).json({ ok: false, error: `Retour conforme mais brouillon d'échange ${draftOrderId} introuvable.` });
          return;
        }
        const attr = (draft.customAttributes || []).find((a) => a.key === BRAND.attrPrefix + "avoir_difference");
        exchangeAvoirDifference = round2(parseFloat(attr?.value || "0"));
        // 13/10 : échange vers un article PLUS CHER, posé depuis la messagerie
        // (api/sav/changer-action.js). La cliente doit payer la différence :
        // achever le brouillon ici le marquerait PAYÉ et l'article partirait
        // gratuitement. On envoie donc le lien de paiement (facture du
        // brouillon) maintenant que le colis est reçu ; la commande d'échange
        // naîtra du paiement — jamais avant réception ET paiement.
        const attrAPayer = (draft.customAttributes || []).find((a) => a.key === BRAND.attrPrefix + "difference_a_payer");
        exchangeDifferenceAPayer = round2(parseFloat(attrAPayer?.value || "0"));

        // 13/10 : différence payée par un lien SÉPARÉ envoyé avant réception
        // (lib/echange-paiement.js) : le brouillon ne s'achève que si ce lien
        // est payé ; sinon la ronde de 10 min s'en chargera au paiement.
        const paiementAttr = (draft.customAttributes || []).find((a) => a.key === ATTR_PAIEMENT);

        if (draft.status === "COMPLETED" && draft.order?.id) {
          exchangeOrderId = draft.order.id;
          exchangeOrderName = draft.order.name || null;
        } else if (exchangeDifferenceAPayer > 0 && paiementAttr) {
          try {
            const cr = await completerEchangePaye(shopifyGraphQL, draftOrderId);
            if (cr.etat === "commande") {
              exchangeOrderId = cr.order.id;
              exchangeOrderName = cr.order.name || null;
            } else {
              exchangeAwaitingPayment = cr.paiement && cr.paiement.nom ? cr.paiement.nom : true;
            }
          } catch (payErr) {
            exchangeAwaitingPayment = true;
            logSettlementError("échange à différence payée à part", payErr);
          }
        } else if (exchangeDifferenceAPayer > 0) {
          try {
            const sent = await shopifyGraphQL(
              `
              mutation EnvoyerLienEchange($id: ID!) {
                draftOrderInvoiceSend(id: $id) {
                  draftOrder { id status invoiceUrl }
                  userErrors { field message }
                }
              }
              `,
              { id: draftOrderId }
            );
            exchangePaymentLink = sent?.draftOrderInvoiceSend?.draftOrder?.invoiceUrl || null;
            exchangePaymentLinkSent = true;
          } catch (sendErr) {
            // Non bloquant : le brouillon reste, le lien s'envoie à la main
            // depuis Shopify (le colis est reçu, c'est sans risque).
            logSettlementError(`envoi du lien de paiement de l'échange (${exchangeDifferenceAPayer.toFixed(2)} €)`, sendErr);
          }
        } else {
          // CORRECTIF 06/11 (Black November) : le brouillon garde le prix de
          // l'article au jour de la demande et une remise FIXE du même montant.
          // Si le prix a baissé depuis (promo), Shopify refuse d'achever :
          // « previously proposed price was invalid » + « custom discount was
          // not honoured » (remise > nouveau sous-total). L'échange de taille
          // étant toujours offert, on recale le brouillon juste avant de
          // l'achever : lignes au prix du jour, remise de 100 %.
          await recalerEchangeOffert(shopifyGraphQL, draftOrderId);
          const completeData = await shopifyGraphQL(
            `
            mutation CompleteDraft($id: ID!) {
              draftOrderComplete(id: $id) {
                draftOrder { id order { id name } }
                userErrors { field message }
              }
            }
            `,
            { id: draftOrderId }
          );
          if (completeData.draftOrderComplete.userErrors?.length) {
            res.status(500).json({
              ok: false,
              error: `Retour conforme mais échec de complétion de l'échange : ${JSON.stringify(completeData.draftOrderComplete.userErrors)}`,
            });
            return;
          }
          exchangeOrderId = completeData.draftOrderComplete.draftOrder?.order?.id || null;
          exchangeOrderName = completeData.draftOrderComplete.draftOrder?.order?.name || null;
        }
      }
    }

    // 7. Règlement (voir lib/settlement.js). Le remboursement carte n'est
    // JAMAIS exécuté : calculé, noté, tagué "remboursement-a-faire". La part
    // avoir est émise automatiquement si le retour est conforme.
    const currentNumber = returnNumber(returnId);
    const orderReturnRows = returnsCsv.rows.map((r) => parseCsvLine(r)).filter((cols) => cols[1] === orderName);
    // Retours de la même commande créés AVANT celui-ci (numéro inférieur).
    const earlierRows = orderReturnRows.filter((cols) => cols[0] !== returnId && returnNumber(cols[0]) < currentNumber);
    const previouslyReturnedValue = round2(
      earlierRows.reduce((sum, cols) => sum + valueOfLine(cols[2]) * (parseInt(cols[6], 10) || 1), 0)
    );
    const coveredQty = {};
    for (const cols of [...earlierRows, ...itemRowIndexes.map(({ cols }) => cols)]) {
      coveredQty[cols[2]] = (coveredQty[cols[2]] || 0) + (parseInt(cols[6], 10) || 1);
    }
    const emptiesOrder = foundOrder.lineItems.edges.every(
      (edge) => (coveredQty[edge.node.id] || 0) >= (edge.node.quantity || 1)
    );
    // CORRECTIF 21/09 — trois sources, on garde la plus élevée. Chacune a un
    // angle mort que les deux autres couvrent :
    //  - la note : ce que les réceptions précédentes ont annoncé, y compris
    //    une ligne déjà soldée par la messagerie ;
    //  - totalRefundedSet : l'encaissé Shopify, qui ignore les PENDING ;
    //  - les transactions REFUND : l'argent engagé, PENDING compris.
    // Sous-estimer ce terme fait annoncer à Luc un remboursement déjà parti.
    const cashAlreadySettled = Math.max(
      parseCashAlreadySettled(foundOrder.note, returnId),
      parseFloat(foundOrder.totalRefundedSet?.shopMoney?.amount || "0"),
      refundsEngaged(foundOrder)
    );

    const settlement = hasDiscrepancy
      ? { cash: 0, avoir: 0, fee: 0, feeOnCash: 0, feeOnAvoir: 0, base: 0, basis: "disputed", creditItemsValue: 0 }
      : computeSettlement({
          refundItemsValue: refundTotal,
          creditItemsValue: round2(creditTotal + exchangeAvoirDifference),
          emptiesOrder,
          avoirPaid: payments.avoirPaid,
          cashPaid: payments.cashPaid,
          previouslyReturnedValue,
          exchangeItemsValue: exchangeTotal,
          cashAlreadySettled,
          fee: REFUND_FEE,
        });

    let refundAmount = null;
    if (hasDiscrepancy) {
      const theorique = round2(refundTotal + creditTotal - (refundTotal > 0 ? REFUND_FEE : 0));
      if (theorique > 0) refundAmount = theorique;
    } else if (settlement.cash + settlement.avoir > 0) {
      refundAmount = round2(settlement.cash + settlement.avoir);
    }
    const cashRefundAmount = settlement.cash;
    const avoirAmount = settlement.avoir;

    // Rien à rendre à la cliente : on explique POURQUOI (note + page réception).
    const nothingToSettle = !hasDiscrepancy && cashRefundAmount === 0 && avoirAmount === 0;
    const settlementNotice = !nothingToSettle
      ? null
      : refundTotal > 0
        ? `Rien à rembourser : frais de retour ${REFUND_FEE.toFixed(2)} € ≥ valeur des articles remboursés (${round2(
            refundTotal
          ).toFixed(2)} €)`
        : exchangeDifferenceAPayer > 0
          ? "Rien à rembourser : échange avec une différence à payer par la cliente"
          : "Rien à rembourser : échange de taille, sans différence de prix";

    // Part carte à rembourser sur la commande d'ORIGINE (commande d'échange
    // dont le crédit vient d'un paiement carte sur l'origine) : ce qui dépasse
    // le montant encore remboursable sur cette commande-ci.
    const cashRefundableHere = round2(Math.max(0, payments.cashPaidOnThisOrder - cashAlreadySettled));
    const cashRefundOnOriginal =
      payments.originalOrderName && payments.cashPaidOnOriginal > 0
        ? round2(Math.max(0, cashRefundAmount - cashRefundableHere))
        : 0;

    // 7. Émission de l'AVOIR en CRÉDIT BOUTIQUE (voir lib/store-credit.cjs). Un seul mécanisme pour les deux cas : avoir demandé
    // par la cliente sur un article, et part avoir d'un remboursement quand la
    // commande avait été réglée avec un avoir. Le remboursement carte, lui,
    // n'est JAMAIS exécuté : calculé, noté, tagué "remboursement-a-faire".
    let avoirSettlement = null;

    if (!hasDiscrepancy && avoirAmount > 0) {
      try {
        avoirSettlement = await issueStoreCredit({
          shopifyGraphQL,
          orderId: foundOrder.id,
          returnId,
          amount: avoirAmount,
          customerId: foundOrder.customer?.id || null,
          onWarning: (label, message) => logSettlementError(label, message),
        });
      } catch (e) {
        // Rien émis : la commande est taguée "avoir-a-emettre" plus bas et le
        // scan peut être relancé — le code étant déterministe, aucun doublon.
        logSettlementError(`crédit boutique ${avoirAmount.toFixed(2)} €`, e);
      }

      // Email Klaviyo (non bloquant) — seulement pour une carte NOUVELLE.
      if (avoirSettlement && avoirSettlement.type === "credit_created") {
        try {
          await trackAvoirIssued({
            email: foundOrder.email,
            firstName: foundOrder.shippingAddress?.firstName,
            orderName,
            returnId,
            code: null,
            amount: avoirSettlement.amount,
            type: avoirSettlement.type,
            endsAt: avoirSettlement.expiresOn || null,
            // Distingue les deux cas dans l'email : avoir choisi par la
            // cliente, ou avoir parce que la commande avait été payée en avoir.
            reason: creditTotal > 0 ? "choix_cliente" : "commande_payee_en_avoir",
          });
        } catch (klaviyoErr) {
          console.error(
            `Échec notification Klaviyo de l'avoir (${returnId}) :`,
            klaviyoErr.message
          );
        }
      }
    }

    // Compatibilité : la page réception publiée avant cette version lit encore
    // "discountSettlement". Même objet, retiré une fois les pages à jour.
    const discountSettlement = avoirSettlement;

    // 7bis. REMISE EN STOCK — emplacement de vente MISÜ (voir
    // lib/inventory.cjs). Uniquement sur un retour ENTIÈREMENT conforme :
    // même règle que l'échange et l'avoir. Un retour en litige ne recrédite
    // rien tout seul, c'est Luc qui tranche. Non bloquant : un échec est
    // écrit dans la note et renvoyé à la page de réception.
    let restock = { applied: false, replay: false, skipped: "retour_en_litige", lines: [] };
    if (!hasDiscrepancy) {
      const restockLines = itemResults
        .filter((i) => i.compliant && i.receivedQuantity > 0 && !i.horsStock)
        .map((i) => ({
          inventoryItemId: (lineItemMap[i.lineItemId] || {}).inventoryItemId || null,
          quantity: i.receivedQuantity,
          title: i.title,
        }));
      const sansInventaire = restockLines.filter((l) => !l.inventoryItemId);
      try {
        restock = await restockReceivedItems(shopifyGraphQL, {
          orderId: foundOrder.id,
          returnId,
          lines: restockLines,
        });
      } catch (e) {
        restock = { applied: false, replay: false, error: String(e.message || e).slice(0, 200), lines: [] };
      }
      if (sansInventaire.length) {
        restock.warning = `${sansInventaire.length} article(s) sans article d'inventaire Shopify : ${sansInventaire
          .map((l) => l.title)
          .join(", ")} — stock à ajuster à la main`;
      }
      if (restock.error) logSettlementError("remise en stock", restock.error);
      if (restock.warning) logSettlementError("remise en stock", restock.warning);
    }

    // 8. Note + tags (relecture avant écriture, remplacement de la ligne du
    // même retour — jamais d'accumulation).
    const existingNote = foundOrder.note || "";
    const noteLines = existingNote.split("\n").filter((l) => !l.startsWith(`[${returnId}-RECEPTION]`));
    const summary = hasDiscrepancy
      ? `Écarts : ${itemResults
          .filter((i) => !i.compliant)
          .map((i) => (i.issue ? `${i.title} (${i.issue.type === "manquant" ? "MANQUANT" : "PROBLÈME"}${i.issue.comment ? " : " + i.issue.comment.slice(0, 80) : ""})` : i.title))
          .join(", ")}${unexpectedScans.length ? ` + ${unexpectedScans.length} scan(s) non attendu(s)` : ""}`
      : "Conforme à l'annoncé.";
    // "Remboursement à faire : X €" est lu par le digest quotidien et
    // api/mark-refunded.js : formule conservée, part carte uniquement.
    const settlementParts = [];
    if (hasDiscrepancy) {
      if (refundAmount > 0) settlementParts.push(`montant théorique ${refundAmount.toFixed(2)} € (litige : rien réglé)`);
    } else {
      if (cashRefundAmount > 0) {
        const originInfo =
          cashRefundOnOriginal > 0
            ? `, dont ${cashRefundOnOriginal.toFixed(2)} € à rembourser sur la commande d'origine ${payments.originalOrderName}`
            : "";
        // Carte cadeau (avoirs Rise) : Shopify rembourse sur les moyens de
        // paiement d'origine, carte cadeau comprise — le libellé le rappelle.
        const gateways = foundOrder.paymentGatewayNames || [];
        const means = gateways.includes("gift_card") ? "carte / carte cadeau, via Shopify" : "carte";
        settlementParts.push(`Remboursement à faire : ${cashRefundAmount.toFixed(2)} € (${means}${originInfo})`);
      }
      if (avoirAmount > 0) {
        const partInfo =
          creditTotal > 0
            ? `, dont ${round2(creditTotal).toFixed(2)} € d'avoir demandé par la cliente`
            : "";
        if (avoirSettlement) {
          const how =
            avoirSettlement.type === "credit_existing"
              ? "crédit boutique déjà émis"
              : avoirSettlement.type === "credit_uncertain"
                ? "crédit boutique À VÉRIFIER (solde du compte client)"
                : "nouveau crédit boutique émis";
          const attach = "";
          settlementParts.push(
            `Avoir ${avoirAmount.toFixed(2)} €${partInfo} : ${how} (valable jusqu'au ${
              avoirSettlement.expiresOn || "?"
            })${attach}`
          );
        } else {
          settlementParts.push(`Avoir ${avoirAmount.toFixed(2)} €${partInfo} NON ÉMIS — crédit boutique à créer à la main`);
        }
      }
      if (settlement.basis === "order_emptied_remaining") {
        settlementParts.push("retour qui vide la commande : tout l'avoir restant est rendu");
      }
      // AUDIT 17/09 (tests réels C295015 / C295017) : quand il n'y a rien à
      // rendre, la note n'en disait rien — impossible, six mois plus tard, de
      // distinguer "montant nul" de "montant oublié". On l'écrit noir sur blanc.
      if (settlementNotice) settlementParts.push(settlementNotice);
    }
    const ecartes = itemResults.filter((i) => i.horsStock && i.receivedQuantity > 0);
    if (ecartes.length) {
      restock.ecartes = ecartes.map((i) => ({ title: i.title, variantTitle: i.variantTitle, quantity: i.receivedQuantity, comment: i.horsStock.comment }));
      settlementParts.push(
        `Écarté du stock à la réception (pas remis en stock) : ${ecartes
          .map((i) => `${i.title} ${i.variantTitle || ""}`.trim() + (i.horsStock.comment ? ` — ${i.horsStock.comment}` : ""))
          .join(" ; ")}`
      );
    }
    if (restock.applied) {
      const totalRemis = restock.lines.reduce((s, l) => s + l.quantity, 0);
      settlementParts.push(`Remise en stock : +${totalRemis}`);
    } else if (restock.replay) {
      settlementParts.push("Stock déjà recrédité par un scan précédent");
    }
    if (settlementErrors.length) {
      settlementParts.push(`Erreur : ${settlementErrors.join(" ; ").slice(0, 300)}`);
    }
    // 13/10 : échange plus cher décidé depuis la messagerie.
    if (!hasDiscrepancy && exchangeAwaitingPayment && !exchangeOrderId) {
      settlementParts.push(
        `Échange : différence de ${exchangeDifferenceAPayer.toFixed(2)} € PAS ENCORE PAYÉE (lien ${exchangeAwaitingPayment === true ? "séparé" : exchangeAwaitingPayment}) — la commande d'échange sera créée au paiement`
      );
    } else if (!hasDiscrepancy && exchangeDifferenceAPayer > 0 && !exchangeOrderId) {
      settlementParts.push(
        exchangePaymentLinkSent
          ? `Échange : lien de paiement de ${exchangeDifferenceAPayer.toFixed(2)} € envoyé à la cliente (la commande d'échange naît du paiement)`
          : `Échange : lien de paiement de ${exchangeDifferenceAPayer.toFixed(2)} € NON ENVOYÉ — à envoyer depuis le brouillon dans Shopify`
      );
    }
    if (holdReleaseErrors.length) {
      settlementParts.push(`HOLD NON LEVÉ — à lever à la main : ${holdReleaseErrors.join(" ; ").slice(0, 200)}`);
    }
    const settlementNote = settlementParts.length ? ` — Règlement : ${settlementParts.join(" / ")}` : "";
    noteLines.push(
      `[${returnId}-RECEPTION] Reçu le ${nowIso.slice(0, 10)} — statut ${finalStatus} — ${summary}${settlementNote}`
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

    const tagsToAdd = [hasDiscrepancy ? "retour-litige" : "retour-recu"];
    if (!hasDiscrepancy && cashRefundAmount > 0) tagsToAdd.push("remboursement-a-faire");
    if (!hasDiscrepancy && avoirAmount > 0 && !avoirSettlement) tagsToAdd.push("avoir-a-emettre");
    if (holdReleaseErrors.length) tagsToAdd.push(BRAND.tagPrefix + "hold-a-lever");
    if (!hasDiscrepancy && exchangeAwaitingPayment && !exchangeOrderId) tagsToAdd.push(BRAND.tagPrefix + "echange-attente-paiement");
    if (!hasDiscrepancy && !exchangeAwaitingPayment && exchangeDifferenceAPayer > 0 && !exchangeOrderId && !exchangePaymentLinkSent) {
      tagsToAdd.push(BRAND.tagPrefix + "lien-echange-a-envoyer");
    }
    // Re-scan conforme d'un retour en litige : le tag litige tombe, sauf si
    // un AUTRE retour de la commande est encore en litige.
    const otherDisputed = orderReturnRows.some((cols) => cols[0] !== returnId && cols[12] === "DISPUTED");
    const tagsToRemove = ["retour-pending"];
    if (!hasDiscrepancy && !otherDisputed) tagsToRemove.push("retour-litige");
    // Avoir enfin émis (ou retrouvé) lors de ce scan : l'alerte tombe.
    if (!hasDiscrepancy && avoirSettlement) tagsToRemove.push("avoir-a-emettre");

    await shopifyGraphQL(
      `
      mutation RetagOrder($id: ID!, $tagsToAdd: [String!]!, $tagsToRemove: [String!]!) {
        tagsAdd(id: $id, tags: $tagsToAdd) { userErrors { field message } }
        tagsRemove(id: $id, tags: $tagsToRemove) { userErrors { field message } }
      }
      `,
      { id: foundOrder.id, tagsToAdd, tagsToRemove }
    );

    // 9. INVENTORY.csv puis RETURNS.csv, EN DERNIER (audit 17/09) : si la
    // note ou les tags Shopify échouent, le retour n'est pas encore marqué
    // reçu et un nouveau scan reprend proprement (avoir déjà émis retrouvé).
    // Écritures conditionnelles : une demande client ou une autre réception
    // écrite pendant ce traitement n'est plus écrasée.
    await rewriteCsvRows(
      INVENTORY_PATH,
      (cols) => cols[1] === invCols[1] && cols[3] === returnId,
      (cols) => cols.map((v, i) => (i === 5 ? finalStatus : i === 9 ? nowIso : v))
    );
    await rewriteCsvRows(
      RETURNS_CSV_PATH,
      (cols) => cols[0] === returnId,
      (cols, k) =>
        cols.map((v, i) => {
          if (i === 12) return itemResults[k] && itemResults[k].compliant ? "RECEIVED" : "DISPUTED";
          if (i === 13) return nowIso;
          return v;
        })
    );

    // 10. Messagerie (22/09). APRÈS les écritures CSV : la réception est déjà
    // actée quand on appelle, donc une messagerie en panne ne peut pas faire
    // échouer un retour scanné en entrepôt. `notifierMessagerie` ne jette
    // jamais et renvoie { sent:false, error } — on le remonte dans la réponse
    // pour diagnostic, sans toucher ni à la note ni aux tags.
    const messagerie = await notifierMessagerie({
      return_id: returnId,
      order_number: foundOrder.name,
      customer_email: foundOrder.email,
      customer_name: foundOrder.shippingAddress?.firstName || null,
      // 13/10 : le vrai statut (la fiche disait toujours RECEIVED, même en litige).
      status: finalStatus,
      label: trackingNumber || null,
      exchange_order: exchangeOrderName || null,
      items: itemResults,
      settlement,
      restock,
      received_at: nowIso,
    });
    if (!messagerie.sent) {
      console.warn(`[receive-return] messagerie non notifiée (${returnId}) :`, messagerie.error);
    }

    // 11. Constat de l'entrepôt → ticket SAV (13/10). Retour en litige, ou
    // retour conforme accompagné d'un message ou de photos.
    const constat = incident && typeof incident === "object" ? incident : {};
    const photos = Array.isArray(constat.photos) ? constat.photos : [];
    const noteEntrepot = String(constat.note || "").trim();
    let ticketSav = { sent: false, skipped: "rien_a_signaler" };
    if (hasDiscrepancy || noteEntrepot || photos.length) {
      ticketSav = await signalerIncidentReception({
        incident_id: constat.id ? String(constat.id).slice(0, 80) : null,
        return_id: returnId,
        order_number: foundOrder.name,
        customer_email: foundOrder.email,
        customer_name: foundOrder.shippingAddress?.firstName || null,
        label: trackingNumber || null,
        status: finalStatus,
        items: itemResults,
        unexpected_scans: unexpectedScans,
        note: noteEntrepot,
        photos,
        received_at: nowIso,
      });
      if (!ticketSav.sent) {
        console.warn(`[receive-return] ticket SAV non créé (${returnId}) :`, ticketSav.error);
      }
    }

    res.status(200).json({
      ok: true,
      returnId,
      orderName,
      status: finalStatus,
      compliant: !hasDiscrepancy,
      items: itemResults,
      unexpectedScans,
      refundAmount,
      cashRefundAmount,
      cashRefundOnOriginal,
      originalOrderName: payments.originalOrderName,
      avoirAmount,
      creditItemsValue: round2(creditTotal),
      avoirSettlement,
      nothingToSettle,
      settlementNotice,
      settlementBasis: settlement.basis,
      fee: settlement.fee,
      feeOnCash: settlement.feeOnCash,
      discountSettlement,
      settlementError: settlementErrors.length ? settlementErrors.join(" ; ") : null,
      holdReleaseError: holdReleaseErrors.length ? holdReleaseErrors.join(" ; ") : null,
      exchangeCompleted: Boolean(exchangeOrderId),
      exchangeOrderName,
      // 13/10 : échange plus cher (messagerie) — différence à payer par lien.
      exchangePaymentDue: exchangeDifferenceAPayer > 0 && !exchangeOrderId ? exchangeDifferenceAPayer : 0,
      exchangePaymentLinkSent,
      exchangePaymentLink,
      exchangeAwaitingPayment: Boolean(exchangeAwaitingPayment),
      // Remise en stock Showroom Turbigo (21/09).
      restock,
      // Notification messagerie (22/09) — diagnostic, jamais bloquant.
      messagerie,
      // Ticket SAV du constat (13/10) : { sent, body: { ticket_id, photos, … } }.
      ticketSav,
    });
  } catch (err) {
    console.error("[receive-return] erreur :", err);
    res.status(500).json({ ok: false, error: err.message });
  }
};
module.exports.recalerEchangeOffert = recalerEchangeOffert;
