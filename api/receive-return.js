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
        error: "Aucun retour ne correspond à cette étiquette.",
        scanned: String(tracking).trim(),
        hint: "Une étiquette porte plusieurs codes-barres : celui du suivi, mais aussi des codes de tri. Vise celui qui se trouve sous le numéro de suivi imprimé en clair, ou saisis-le à la main."
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

      // Montant à rembourser, calculé mais jamais exécuté : le remboursement
      // reste une action manuelle de Luc dans Shopify.
      const refund = computeRefund(found.items, result.received, order);

      if (order) {
        const tags = ['retour-recu'];
        if (refund.amount > 0) tags.push('remboursement-a-faire');

        await addOrderTags(order.id, tags).catch(() => {});
        await removeOrderTags(order.id, ['retour-en-cours']).catch(() => {});
        await appendOrderNote(
          order.id,
          result.returnId,
          `[${result.returnId}] Colis reçu et conforme.` +
            (exchangeOrder ? ` Échange à préparer : ${exchangeOrder.name}.` : '') +
            (refund.amount > 0
              ? ` À REMBOURSER À LA MAIN : ${refund.amount.toFixed(2)} € (${refund.detail}).`
              : ' Aucun remboursement à effectuer.')
        ).catch(() => {});
        await setReturnMetafields(order.id, {
          return_status: 'RECEIVED',
          exchange_order: exchangeOrder?.name || '',
          settlement: {
            type: refund.amount > 0 ? 'REFUND_DUE' : 'NONE',
            amount: Number(refund.amount.toFixed(2)),
            currency: 'EUR',
            fee: refund.fee,
            detail: refund.detail,
            manual: true
          }
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
      refund: result.complete ? computeRefund(found.items, result.received, order) : null,
      exchangeOrder: exchangeOrder?.name || null,
      hasPendingExchange: Boolean(found.draftOrderId) && !result.complete
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
}

const LABEL_FEE = 5.9;

// Calcule ce qui est dû à la cliente, sans jamais l'exécuter.
//
// Seuls les articles effectivement reçus et demandés en remboursement sont
// comptés. Les 5,90 € de l'étiquette ne sont retenus que si le colis ne
// contenait aucun échange, conformément à la règle commerciale.
function computeRefund(expected, received, order) {
  const prices = new Map();
  (order?.lineItems?.nodes || []).forEach((l) =>
    prices.set(l.id, Number(l.discountedUnitPriceSet?.shopMoney?.amount || 0))
  );

  const refunded = (received || []).filter((i) => i.action === 'REFUND');
  const gross = refunded.reduce((sum, i) => sum + (prices.get(i.lineItemId) || 0), 0);

  if (gross <= 0) {
    return { amount: 0, fee: 0, detail: 'aucun article à rembourser' };
  }

  const hasExchange = (expected || []).some((i) => i.action === 'EXCHANGE');
  const fee = hasExchange ? 0 : LABEL_FEE;
  const amount = Math.max(0, gross - fee);

  const detail = `${refunded.length} article${refunded.length > 1 ? 's' : ''} à ${gross.toFixed(2)} €` +
    (fee ? ` moins ${fee.toFixed(2)} € d'étiquette` : ', étiquette offerte');

  return { amount, fee, detail };
}
