// api/create-return.js
// Dépôt : bbp-webhook
//
// MODÈLE DU 18/09/2026 (claude/DECISIONS-Portail-Retours-BBP-2026-09-18) —
// trois choix PAR ARTICLE, et plus rien à payer :
//  - "refund"   : remboursement, 5,90 € de frais retenus (voir lib/settlement) ;
//  - "exchange" : échange d'une autre TAILLE du MÊME modèle, jamais plus cher,
//                 donc toujours offert — un seul échange par commande ;
//  - "credit"   : avoir en carte cadeau Shopify, valeur entière, sans frais,
//                 émis à la réception du colis (lib/gift-card.js).
// Conséquence : plus de solde à régler, donc plus de brouillon en attente de
// paiement, plus de facture, plus de compteur d'échanges, et plus de webhook
// "Order payment" (api/webhooks/order-paid.js supprimé). La création d'un
// retour est de nouveau un chemin unique : contrôles, étiquette, CSV, tag,
// email — via lib/finalize-return.js.
//
// Contrôles conservés de l'audit du 17/09 :
//  - valorisation partagée avec receive-return (lib/order-payments.js) ;
//  - "vide la commande" tient compte des quantités (lib/settlement.js) ;
//  - articles envoyés par la page vérifiés côté serveur : ligne de CETTE
//    commande, quantité, doublon, action connue, variante d'échange
//    existante, active, en vente, pas une carte cadeau ;
//  - les attributs techniques bbp_* de la commande d'origine ne sont pas
//    recopiés sur le brouillon d'échange.
//
// Création d'un retour : vérifie l'éligibilité (14 jours depuis livraison),
// assigne une étiquette Chronopost depuis l'inventaire, calcule les frais
// (5,90 € dès qu'un article est remboursé, sinon 0), et crée pour un échange
// de taille un brouillon de commande entièrement remisé (stock réservé
// 30 jours), libéré de son blocage à la réception du colis.
//
// La MODIFICATION d'un retour existant (returnId fourni) garde son chemin
// propre, plus bas dans ce fichier : mêmes contrôles, pas de nouvel email.
//
// POST /api/create-return
// Body (création): {
// order: "C294509", zip: "59680",
// items: [
// { lineItemId, variantId, title, quantity, reason, comment,
// action: "refund" | "exchange",
// exchangeVariantId?, exchangeTitle? }
// ]
// }
// Body (modification) : idem + returnId: "R-C294509-1"

const { shopifyGraphQL } = require("../lib/shopify.cjs");
const { downloadFile, updateTextFile, RETURNS_ROOT } = require("../lib/dropbox.cjs");
const { finalizeNewReturn } = require("../lib/finalize-return.cjs");
// analyzeOrderPayments n'est plus appelé ici depuis le 18/09 : l'échange est
// limité à une autre taille du même modèle au même prix, il n'y a donc plus de
// crédit à calculer à la création. Seuls les fragments de requête restent
// utiles (receive-return relit la commande avec les mêmes champs).
const { ORDER_PAYMENT_FIELDS, LINE_ITEM_PAYMENT_FIELDS } = require("../lib/order-payments.cjs");
const { round2 } = require("../lib/settlement.cjs");
// 22/09 : pousse la fiche retour vers la messagerie (messagerie-influence-sav).
// Ne jette JAMAIS — voir lib/notify-messagerie.js.
const { notifierMessagerie } = require("../lib/notify-messagerie.cjs");

const INVENTORY_PATH = `${RETURNS_ROOT}/INVENTORY.csv`;
const RETURNS_CSV_PATH = `${RETURNS_ROOT}/RETURNS.csv`;
const AVAILABLE_DIR = `${RETURNS_ROOT}/AVAILABLE`;
const CONFIRMED_DIR = `${RETURNS_ROOT}/CONFIRMED`;

// Doit correspondre exactement à API_BASE dans le JS de la page retour-bbp,
// dans lib/finalize-return.js, et au format lu par api/label.js.
// 21/09 : bascule vers le sous-domaine de marque. Tant que
// PUBLIC_API_BASE n'est pas défini sur Vercel, on reste sur l'URL Vercel —
// changer le défaut avant que le CNAME `retours` ne résolve casserait tous
// les liens d'étiquette déjà envoyés aux clientes.
const API_BASE = require("../lib/brand.cjs").apiBase;

const RETURN_WINDOW_DAYS = 14;
const FALLBACK_WINDOW_DAYS = 21; // si la date de livraison est inconnue
const REFUND_FEE = 5.9;

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


// Lecture d'une ligne CSV en respectant les guillemets (les titres produits
// peuvent contenir des virgules).
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

// Attributs techniques du portail : jamais recopiés d'une commande vers un
// nouveau brouillon.
function withoutBbpAttributes(attributes) {
  return (attributes || []).filter((a) => !String(a.key || "").startsWith(require("../lib/brand.cjs").attrPrefix));
}

function csvEscape(value) {
  const str = String(value ?? "");
  return str.includes(",") || str.includes('"')
    ? `"${str.replace(/"/g, '""')}"`
    : str;
}

module.exports = async (req, res) => {
  // CORS — nécessaire dès que cet endpoint est appelé en fetch() depuis une
  // page du navigateur (domaine boutique) plutôt qu'en curl. Sans ces
  // en-têtes, le navigateur bloque la lecture de la réponse même si le
  // serveur répond correctement (symptôme observé : "Failed to fetch" côté
  // JS malgré une vraie réponse visible côté réseau).
  res.setHeader("Access-Control-Allow-Origin", require("../lib/brand.cjs").siteUrl);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Méthode non autorisée, utiliser POST." });
    return;
  }

  try {
    const { order, zip, items, returnId: editingReturnId } = req.body || {};

    if (!order || !zip || !Array.isArray(items) || items.length === 0) {
      res.status(400).json({ ok: false, error: "Paramètres 'order', 'zip' et 'items' requis." });
      return;
    }

    const orderName = order.startsWith("#") ? order : `#${order}`;

    // 1. Récupération commande + vérification code postal + éligibilité.
    const data = await shopifyGraphQL(
      `
      query FindOrder($query: String!) {
        orders(first: 1, query: $query) {
          edges {
            node {
              id
              name
              email
              note
              customer { id }
              shippingAddress { firstName lastName zip address1 address2 city province country countryCodeV2 provinceCode phone }
              shippingLine { code source title }
              customAttributes { key value }
              ${ORDER_PAYMENT_FIELDS}
              lineItems(first: 50) {
                edges { node { id name title variant { id title price product { id } } ${LINE_ITEM_PAYMENT_FIELDS} } }
              }
              fulfillments(first: 5) {
                deliveredAt
                createdAt
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
      res.status(404).json({ ok: false, error: "Commande introuvable." });
      return;
    }

    const normalizedZip = (foundOrder.shippingAddress?.zip || "").replace(/\s/g, "");
    if (normalizedZip !== zip.replace(/\s/g, "")) {
      res.status(404).json({ ok: false, error: "Commande introuvable." });
      return;
    }

    // Contrôle des articles envoyés par la page (ajout audit 17/09) : la page
    // n'est pas une source de confiance (quantités, lignes d'une autre
    // commande, doublons).
    const orderLineById = {};
    for (const edge of foundOrder.lineItems.edges) orderLineById[edge.node.id] = edge.node;
    const seenLineItems = new Set();
    for (const item of items) {
      const line = orderLineById[item.lineItemId];
      const qty = Number(item.quantity || 1);
      let error = null;
      if (!line) error = "Article introuvable dans cette commande.";
      else if (seenLineItems.has(item.lineItemId)) error = `L'article ${item.title || ""} apparaît deux fois dans la demande.`;
      else if (!Number.isInteger(qty) || qty < 1 || qty > (line.quantity || 1)) error = `Quantité invalide pour ${item.title || "un article"}.`;
      else if (item.action !== "refund" && item.action !== "exchange" && item.action !== "credit")
        error = "Action invalide (remboursement, échange de taille ou avoir).";
      else if (item.action === "exchange" && !item.exchangeVariantId) error = `Choisissez l'article d'échange pour ${item.title || "cet article"}.`;
      if (error) {
        res.status(400).json({ ok: false, error });
        return;
      }
      seenLineItems.add(item.lineItemId);
    }

    // Textes affichés (page "Vos retours en cours", email Klaviyo) : repris
    // de Shopify, plus du navigateur (audit 17/09). Avant, un titre inventé
    // envoyé à l'API était enregistré tel quel dans RETURNS.csv, puis
    // réaffiché en HTML sur la page retour-bbp et dans l'email envoyé à la
    // cliente sous la marque BBP.
    const cleanText = (value, max) =>
      String(value ?? "").replace(/[\u0000-\u001f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
    for (const item of items) {
      const line = orderLineById[item.lineItemId];
      // 21/09 : `name` vaut « Produit - GRIS / S », variante comprise. Comme
      // `variantTitle` est affiché juste à côté (email de retour, écran de
      // réception), la taille sortait deux fois : « T Shirt-Rive Gauche Gris
      // Chiné - GRIS / S  GRIS / S ». On prend donc `title`, qui est le titre
      // du produit seul ; `name` reste le repli si Shopify ne le renvoie pas.
      item.title = line.title || line.name;
      item.variantTitle = line.variant?.title || "";
      item.quantity = Number(item.quantity || 1);
      item.reason = cleanText(item.reason, 120);
      item.comment = cleanText(item.comment, 500);
      if (item.action !== "exchange") {
        delete item.exchangeVariantId;
        delete item.exchangeTitle;
      }
    }

    // Variantes choisies en échange : prix du jour + contrôle (ajout audit
    // 17/09) — existante, produit actif, en vente, pas une carte cadeau.
    // Fait AVANT toute écriture (en modification, l'ancien brouillon est
    // supprimé plus bas : un refus après coup laissait le retour sans brouillon).
    const exchangeVariantById = {};
    const requestedExchangeItems = items.filter((i) => i.action === "exchange" && i.exchangeVariantId);
    if (requestedExchangeItems.length > 0) {
      const uniqueExchangeVariantIds = [...new Set(requestedExchangeItems.map((i) => i.exchangeVariantId))];
      const variantPriceData = await shopifyGraphQL(
        `
        query GetExchangeVariantPrices($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on ProductVariant { id title price availableForSale product { id title status isGiftCard } }
          }
        }
        `,
        { ids: uniqueExchangeVariantIds }
      );
      for (const node of variantPriceData.nodes || []) {
        if (node?.id) exchangeVariantById[node.id] = node;
      }
      for (const item of requestedExchangeItems) {
        const v = exchangeVariantById[item.exchangeVariantId];
        if (!v || v.product?.isGiftCard || v.product?.status !== "ACTIVE") {
          res.status(400).json({ ok: false, error: `L'article choisi en échange pour ${item.title || "cet article"} n'est pas disponible.` });
          return;
        }
        if (!v.availableForSale) {
          res.status(409).json({ ok: false, error: `L'article choisi en échange pour ${item.title || "cet article"} vient d'être épuisé. Choisissez une autre taille ou un autre modèle.` });
          return;
        }
        // MODÈLE DU 18/09 : l'échange ne porte QUE sur une autre taille du même
        // modèle. Pour un autre article, la cliente prend un avoir et commande
        // ce qu'elle veut sur le site — plus aucune différence de prix à régler.
        const returnedLine = orderLineById[item.lineItemId];
        const returnedProductId = returnedLine?.variant?.product?.id || null;
        if (!returnedProductId || v.product?.id !== returnedProductId) {
          res.status(400).json({
            ok: false,
            error: `L'échange se fait uniquement dans une autre taille de « ${item.title || "cet article"} ». Pour un autre modèle, choisissez l'avoir : vous commanderez ce que vous voulez sur le site.`,
          });
          return;
        }
        const returnedPrice = parseFloat(returnedLine?.variant?.price || "0");
        if (parseFloat(v.price || "0") > returnedPrice + 0.001) {
          res.status(400).json({
            ok: false,
            error: `Cette taille de « ${item.title || "cet article"} » est vendue à un prix supérieur : choisissez le remboursement ou l'avoir.`,
          });
          return;
        }
        item.exchangeTitle = `${v.product?.title || ""} — Taille ${v.title || ""}`.trim();
      }
    }

    const fulfillment = foundOrder.fulfillments[0];
    if (!fulfillment) {
      res.status(400).json({ ok: false, error: "Commande pas encore expédiée, retour impossible." });
      return;
    }

    const referenceDate = fulfillment.deliveredAt
      ? new Date(fulfillment.deliveredAt)
      : new Date(fulfillment.createdAt);
    const windowDays = fulfillment.deliveredAt ? RETURN_WINDOW_DAYS : FALLBACK_WINDOW_DAYS;
    const deadline = new Date(referenceDate.getTime() + windowDays * 24 * 60 * 60 * 1000);

    if (new Date() > deadline) {
      res.status(400).json({
        ok: false,
        error: `Retour non éligible : délai de ${windowDays} jours dépassé (référence : ${referenceDate.toISOString().slice(0, 10)}).`,
      });
      return;
    }

    // 2. Charger RETURNS.csv (utile dans les deux cas : création et modif).
    const returnsCsv = await readCsv(
      RETURNS_CSV_PATH,
      "return_id,order_name,line_item_id,barcode,product_title,variant_title,quantity,reason,comment,action,exchange_barcode,exchange_title,item_status,received_at"
    );
    const existingForOrder = returnsCsv.rows.filter((r) => parseCsvLine(r)[1] === foundOrder.name);

    const isEditing = Boolean(editingReturnId);

    // MODÈLE DU 18/09 : un seul échange de taille par commande. Au-delà, la
    // cliente choisit le remboursement ou l'avoir — chaque aller-retour coûte
    // une étiquette, et le portail n'a plus de mécanisme de paiement.
    if (items.some((i) => i.action === "exchange")) {
      const previousExchange = existingForOrder
        .map((r) => parseCsvLine(r))
        .filter((cols) => !isEditing || cols[0] !== editingReturnId)
        .some((cols) => cols[9] === "exchange");
      if (previousExchange) {
        res.status(409).json({
          ok: false,
          error:
            "Un échange de taille a déjà été fait sur cette commande. Pour ce retour, choisissez le remboursement ou l'avoir.",
        });
        return;
      }
    }
    let returnId;
    let trackingNumber;
    let pdfFile;
    let invIndex = -1;
    let inventoryCsv;

    if (isEditing) {
      // --- Modification d'un retour existant, tant que non reçu. ---
      // Comportement INCHANGÉ (hors périmètre du paiement différé — voir
      // en-tête du fichier).
      inventoryCsv = await readCsv(
        INVENTORY_PATH,
        "label_number,tracking_number,label_status,return_id,order_name,return_status,draft_order_id,pdf_file,date_assigned,date_received"
      );
      invIndex = inventoryCsv.rows.findIndex((r) => {
        const cols = r.split(",");
        return cols[3] === editingReturnId && cols[4] === foundOrder.name;
      });
      if (invIndex === -1) {
        res.status(404).json({ ok: false, error: `Retour ${editingReturnId} introuvable pour cette commande.` });
        return;
      }
      const invCols = inventoryCsv.rows[invIndex].split(",");
      const [, existingTracking, , , , existingStatus, existingDraftOrderId, existingPdfFile] = invCols;
      if (existingStatus !== "REQUESTED") {
        res.status(409).json({
          ok: false,
          error: `Ce retour a déjà été reçu (statut ${existingStatus}) — modification impossible.`,
        });
        return;
      }

      returnId = editingReturnId;
      trackingNumber = existingTracking;
      pdfFile = existingPdfFile;

      // Refuser un article déjà engagé dans un AUTRE retour (celui qu'on
      // modifie ne doit pas se bloquer lui-même).
      const alreadyReturnedLineItems = new Set(
        existingForOrder.filter((r) => r.split(",")[0] !== editingReturnId).map((r) => r.split(",")[2])
      );
      for (const item of items) {
        if (alreadyReturnedLineItems.has(item.lineItemId)) {
          res.status(400).json({
            ok: false,
            error: `L'article ${item.title || item.lineItemId} a déjà un retour en cours.`,
          });
          return;
        }
      }

      // Retirer les anciennes lignes RETURNS.csv de ce retour — remplacées
      // plus bas par les nouvelles (jamais d'accumulation).
      returnsCsv.rows = returnsCsv.rows.filter((r) => r.split(",")[0] !== editingReturnId);

      // Ancien brouillon d'échange : supprimé sans risque (un retour encore
      // REQUESTED n'a jamais eu son brouillon complété en vraie commande
      // par receive-return.js).
      if (existingDraftOrderId) {
        try {
          await shopifyGraphQL(
            `
            mutation DeleteDraft($input: DraftOrderDeleteInput!) {
              draftOrderDelete(input: $input) {
                deletedId
                userErrors { field message }
              }
            }
            `,
            { input: { id: existingDraftOrderId } }
          );
        } catch (e) {
          // Non bloquant — au pire un brouillon orphelin reste dans Shopify.
          console.error(`Échec suppression ancien brouillon ${existingDraftOrderId}:`, e.message);
        }
      }
    } else {
      // --- Création d'un nouveau retour. ---
      // Refuser un article déjà engagé dans un retour précédent — vérifié
      // ici (avant tout appel réseau supplémentaire) mais l'étiquette n'est
      // PLUS assignée à ce stade : elle ne le sera que si ce retour ne
      // nécessite aucun paiement préalable (voir plus bas, après le calcul
      // de l'échange).
      const alreadyReturnedLineItems = new Set(existingForOrder.map((r) => r.split(",")[2]));
      for (const item of items) {
        if (alreadyReturnedLineItems.has(item.lineItemId)) {
          res.status(400).json({
            ok: false,
            error: `L'article ${item.title || item.lineItemId} a déjà un retour en cours.`,
          });
          return;
        }
      }

    }

    // 3. Échange de taille (modèle du 18/09) : même modèle, prix jamais
    // supérieur — la commande d'échange est donc TOUJOURS offerte. Plus de
    // solde à régler, plus de facture, plus de brouillon en attente de
    // paiement, plus de compteur d'échanges : l'article choisi est simplement
    // remisé de son prix dans le brouillon.
    const exchangeItems = items.filter((i) => i.action === "exchange" && i.exchangeVariantId);
    const hasExchange = exchangeItems.length > 0;
    const discountAmount = round2(
      exchangeItems.reduce(
        (sum, i) => sum + parseFloat(exchangeVariantById[i.exchangeVariantId]?.price || "0") * (i.quantity || 1),
        0
      )
    );

    // 5. À partir d'ici : remboursement, échange gratuit, ou modification —
    // le retour est finalisé tout de suite (comportement historique).
    //
    // CORRECTIF 16/09 : ce fichier déplaçait ici une étiquette AVAILABLE →
    // CONFIRMED dans Dropbox, PUIS appelait finalizeNewReturn() (étape 7)
    // qui relisait INVENTORY.csv (pas encore mis à jour), reprenait la MÊME
    // étiquette et tentait de la déplacer une 2e fois → erreur Dropbox
    // "from_lookup/not_found", code 500, étiquette sortie du stock sans être
    // enregistrée. Conséquence : tout nouveau remboursement et tout échange
    // gratuit plantait depuis la réécriture du 15/09, et bloquait ensuite
    // toutes les demandes suivantes (y compris la finalisation des échanges
    // payés). L'attribution de l'étiquette est désormais faite UNIQUEMENT
    // dans lib/finalize-return.js.
    //
    // Pas d'attribution d'étiquette ici pour un nouveau retour.

    const now = new Date().toISOString();

    // 6. Échange gratuit (ou échange payant en modification, cas hors
    // périmètre — voir en-tête) : (re)créer un brouillon de commande, stock
    // réservé 30 jours.
    let draftOrderId = null;

    if (hasExchange) {
      if (!isEditing) {
        // returnId n'a pas encore été généré pour un nouveau retour non
        // payant — on le fait ici, juste avant d'en avoir besoin pour le
        // tag/la note du brouillon.
        const existingReturnNumbers = new Set(
          existingForOrder.map((r) => parseInt(r.split(",")[0].split("-")[2], 10))
        );
        let n = 1;
        while (existingReturnNumbers.has(n)) n++;
        returnId = `R-${foundOrder.name.replace("#", "")}-${n}`;
      }

      const reserveUntil = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      const draftData = await shopifyGraphQL(
        `
        mutation CreateDraft($input: DraftOrderInput!) {
          draftOrderCreate(input: $input) {
            draftOrder { id name }
            userErrors { field message }
          }
        }
        `,
        {
          input: {
            ...(foundOrder.customer ? { purchasingEntity: { customerId: foundOrder.customer.id } } : {}),
            email: foundOrder.email || undefined,
            lineItems: exchangeItems.map((i) => ({
              variantId: i.exchangeVariantId,
              quantity: i.quantity || 1,
            })),
            appliedDiscount:
              discountAmount > 0
                ? {
                    valueType: "FIXED_AMOUNT",
                    value: discountAmount,
                    title: "Valeur article(s) retourné(s)",
                  }
                : undefined,
            shippingAddress: {
              firstName: foundOrder.shippingAddress?.firstName,
              lastName: foundOrder.shippingAddress?.lastName,
              address1: foundOrder.shippingAddress?.address1,
              address2: foundOrder.shippingAddress?.address2,
              city: foundOrder.shippingAddress?.city,
              provinceCode: foundOrder.shippingAddress?.provinceCode,
              zip: foundOrder.shippingAddress?.zip,
              countryCode: foundOrder.shippingAddress?.countryCodeV2,
              phone: foundOrder.shippingAddress?.phone,
            },
            shippingLine: foundOrder.shippingLine
              ? {
                  title: foundOrder.shippingLine.title,
                  price: "0.00",
                }
              : undefined,
            customAttributes: withoutBbpAttributes(foundOrder.customAttributes),
            tags: ["ECHANGE", `ECHANGE_${foundOrder.name.replace("#", "")}`, returnId],
            note: `Échange de taille du retour ${returnId} — commande à ne préparer qu'à réception du colis.`,
            reserveInventoryUntil: reserveUntil,
          },
        }
      );
      if (draftData.draftOrderCreate.userErrors?.length) {
        res.status(400).json({
          ok: false,
          error: `Échec création brouillon d'échange: ${JSON.stringify(draftData.draftOrderCreate.userErrors)}`,
        });
        return;
      }
      draftOrderId = draftData.draftOrderCreate.draftOrder?.id || null;

    }

    // 7. Nouveau retour (remboursement ou échange gratuit) : finaliser via
    // la logique partagée avec order-paid.js.
    if (!isEditing) {
      let result;
      try {
        result = await finalizeNewReturn({
          foundOrder,
          items,
          draftOrderId,
          hasExchange,
        });
      } catch (finalizeErr) {
        if (finalizeErr.code === "ARTICLES_DEJA_RETOURNES") {
          res.status(409).json({ ok: false, error: "Un retour est déjà en cours pour cet article." });
          return;
        }
        throw finalizeErr;
      }
      // Messagerie (22/09) : après finalizeNewReturn, donc le retour est déjà
      // écrit. `settlement` et `restock` n'existent pas à la demande — c'est
      // normal, la messagerie les attend seulement à la réception.
      const messagerie = await notifierMessagerie({
        return_id: result.returnId,
        order_number: foundOrder.name,
        customer_email: foundOrder.email,
        customer_name: foundOrder.shippingAddress?.firstName || null,
        status: "REQUESTED",
        label: result.trackingNumber || null,
        exchange_order: null,
        items,
        received_at: new Date().toISOString(),
      });
      if (!messagerie.sent) {
        console.warn(`[create-return] messagerie non notifiée (${result.returnId}) :`, messagerie.error);
      }

      res.status(200).json({ ...result, messagerie });
      return;
    }

    // 8. Modification d'un retour existant : comportement historique
    // inchangé, inline (hors périmètre du paiement différé).
    // Écritures conditionnelles (audit 17/09) : rejouées sur le contenu à
    // jour si un autre traitement a écrit le fichier entre-temps.
    await updateTextFile(INVENTORY_PATH, (content) => {
      const inv = parseCsv(content);
      inv.rows = inv.rows.map((r) => {
        const cols = parseCsvLine(r);
        if (cols[3] !== returnId || cols[4] !== foundOrder.name) return r;
        return cols
          .map((v, idx) => {
            if (idx === 6) return draftOrderId || "";
            if (idx === 8) return now; // date_assigned mise à jour à la modif
            return v;
          })
          .map(csvEscape)
          .join(",");
      });
      return [inv.header, ...inv.rows].join("\n") + "\n";
    });

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
    await updateTextFile(RETURNS_CSV_PATH, (content) => {
      const ret = parseCsv(content);
      const kept = ret.rows.filter((r) => parseCsvLine(r)[0] !== returnId);
      return [ret.header, ...kept, ...newReturnRows].join("\n") + "\n";
    });

    // Frais affichés : 5,90 € uniquement s'il y a au moins un article
    // remboursé (un avoir ou un échange de taille n'en porte pas).
    const fee = items.some((i) => i.action === "refund") ? REFUND_FEE : 0;

    const existingNote = foundOrder.note || "";
    const noteLines = existingNote.split("\n").filter((l) => !l.startsWith(`[${returnId}]`));
    noteLines.push(
      `[${returnId}] Retour modifié le ${now.slice(0, 10)} — étiquette ${trackingNumber} — ${items.length} article(s)`
    );

    await shopifyGraphQL(
      `
      mutation UpdateOrder($input: OrderInput!) {
        orderUpdate(input: $input) {
          userErrors { field message }
        }
      }
      `,
      {
        input: {
          id: foundOrder.id,
          note: noteLines.join("\n"),
        },
      }
    );
    await shopifyGraphQL(
      `
      mutation TagOrder($id: ID!, $tags: [String!]!) {
        tagsAdd(id: $id, tags: $tags) {
          userErrors { field message }
        }
      }
      `,
      {
        id: foundOrder.id,
        tags: ["retour-pending", returnId],
      }
    );

    // Pas d'événement Klaviyo à la modification — une modification ne doit
    // pas renvoyer le même email de confirmation à la cliente.

    // Messagerie (22/09) : une modification change la composition du retour,
    // la fiche côté messagerie doit suivre. Même statut REQUESTED.
    const messagerie = await notifierMessagerie({
      return_id: returnId,
      order_number: foundOrder.name,
      customer_email: foundOrder.email,
      customer_name: foundOrder.shippingAddress?.firstName || null,
      status: "REQUESTED",
      label: trackingNumber || null,
      exchange_order: null,
      items,
      received_at: now,
    });
    if (!messagerie.sent) {
      console.warn(`[create-return] messagerie non notifiée (${returnId}) :`, messagerie.error);
    }

    res.status(200).json({
      ok: true,
      returnId,
      orderName: foundOrder.name,
      trackingNumber,
      fee,
      hasExchange,
      draftOrderId,
      itemsCount: items.length,
      updated: true,
      messagerie,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
};
