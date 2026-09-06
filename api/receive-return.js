// Réception d'un colis retour.
//
// Deux modes :
//   lookup  — scan de l'étiquette : renvoie ce qui est attendu dans le colis
//   confirm — scan des articles : compare, met à jour, complète l'échange
//
// Règle posée avec Luc : au moindre écart entre l'annoncé et le reçu, rien
// ne repart. Le retour passe DISPUTED, le brouillon d'échange reste en
// attente, et l'écart est consigné article par article.
//
// Cet endpoint est réservé à un usage interne. Il n'est pas appelé depuis
// la boutique : l'origine autorisée est donc restreinte à la page de
// réception, et un jeton partagé est exigé.

import { findReturnByTracking, receiveReturn } from '../lib/dropbox.js';
import { completeExchangeDraft, addOrderTags, removeOrderTags, appendOrderNote, setReturnMetafields, findOrderByName } from '../lib/shopify.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://misu-sneakers.fr');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Misu-Token');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Écran interne : sans ce jeton, n'importe qui pourrait marquer un colis
  // comme reçu et déclencher l'expédition d'un échange.
  const expected = process.env.MISU_STAFF_TOKEN;
  if (!expected || req.headers['x-misu-token'] !== expected) {
    return res.status(401).json({ error: 'Accès refusé.' });
  }

  const { mode, tracking, barcodes } = req.body || {};

  if (!tracking) {
    return res.status(400).json({ error: "Numéro de suivi manquant." });
  }

  try {
    const found = await findReturnByTracking(tracking);
    if (!found) {
      return res.status(404).json({
        error: "Aucun retour ne correspond à cette étiquette. Vérifiez que le colis vient bien d'une demande enregistrée."
      });
    }

    // Mode lecture : on affiche ce qui devrait se trouver dans le carton.
    if (mode !== 'confirm') {
      return res.status(200).json({
        returnId: found.returnId,
        orderName: found.orderName,
        status: found.status,
        alreadyReceived: found.status !== 'REQUESTED',
        dateReceived: found.dateReceived,
        items: found.items
      });
    }

    if (found.status !== 'REQUESTED') {
      return res.status(409).json({
        error: `Ce retour a déjà été réceptionné le ${found.dateReceived || 'précédemment'}.`,
        returnId: found.returnId,
        status: found.status
      });
    }

    if (!Array.isArray(barcodes) || !barcodes.length) {
      return res.status(400).json({ error: 'Aucun article scanné.' });
    }

    const result = await receiveReturn(found.returnId, barcodes);
    if (!result) {
      return res.status(500).json({ error: 'Retour introuvable au moment de la mise à jour.' });
    }

    // La commande d'origine, pour y écrire l'issue de la réception.
    let order = null;
    try {
      order = await findOrderByName(result.orderName);
    } catch (err) {
      console.error(`Commande ${result.orderName} illisible : ${err.message}`);
    }

    let exchangeOrder = null;

    if (result.complete) {
      // Tout correspond : l'échange peut partir. Le brouillon devient une
      // commande à préparer, et le stock réservé est enfin consommé.
      if (found.draftOrderId) {
        try {
          exchangeOrder = await completeExchangeDraft(found.draftOrderId);
        } catch (err) {
          console.error(`Complétion du brouillon ${found.draftOrderId} impossible : ${err.message}`);
        }
      }

      if (order) {
        await addOrderTags(order.id, ['retour-recu']).catch(() => {});
        await removeOrderTags(order.id, ['retour-en-cours']).catch(() => {});
        await appendOrderNote(
          order.id,
          result.returnId,
          `[${result.returnId}] Colis reçu et conforme.${exchangeOrder ? ` Échange à préparer : ${exchangeOrder.name}.` : ''}`
        ).catch(() => {});
        await setReturnMetafields(order.id, {
          return_status: 'RECEIVED',
          exchange_order: exchangeOrder?.name || ''
        }).catch(() => {});
      }
    } else {
      // Écart constaté : rien ne repart, la commande est signalée.
      const ecarts = [
        ...result.missing.map((i) => `manquant : ${i.productTitle} (${i.variantTitle})`),
        ...result.unexpected.map((b) => `non annoncé : ${b}`)
      ].join(' ; ');

      if (order) {
        await addOrderTags(order.id, ['retour-litige']).catch(() => {});
        await appendOrderNote(
          order.id,
          result.returnId,
          `[${result.returnId}] Colis reçu NON CONFORME. ${ecarts}. Échange en attente, à traiter manuellement.`
        ).catch(() => {});
        await setReturnMetafields(order.id, { return_status: 'DISPUTED' }).catch(() => {});
      }
    }

    return res.status(200).json({
      returnId: result.returnId,
      orderName: result.orderName,
      status: result.status,
      complete: result.complete,
      missing: result.missing,
      unexpected: result.unexpected,
      received: result.received,
      exchangeOrder: exchangeOrder?.name || null,
      hasPendingExchange: Boolean(found.draftOrderId) && !result.complete
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
}
