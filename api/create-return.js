// Création et mise à jour d'un retour.
//
// Un retour porte un ou plusieurs articles, chacun avec son motif et son
// action. Une commande peut porter plusieurs retours successifs ; chacun
// consomme sa propre étiquette.
//
// Règles appliquées ici :
//   - 5,90 € déduits pour l'étiquette, SAUF si le colis contient au moins
//     un échange : dans ce cas le retour est entièrement gratuit
//   - échange à prix égal uniquement
//   - un article déjà engagé dans un retour ne peut pas l'être une seconde fois
//   - le brouillon d'échange réserve le stock mais ne devient une commande
//     qu'à réception du colis

import { findOrder, getCatalog, getDeliveredAt, createExchangeDraft, deleteDraft, addOrderTags, appendOrderNote, setReturnMetafields } from '../lib/shopify.js';
import { createReturn, updateReturn, getReturnsForOrder } from '../lib/dropbox.js';
import { sendReturnEvent } from '../lib/klaviyo.js';

// Les PDF d'étiquettes sont hébergés dans les fichiers Shopify.
// Shopify a remplacé les espaces par des underscores à l'upload, et ajoute
// un paramètre de version propre à chaque fichier : les URLs sont donc
// écrites telles quelles, et non reconstruites. Si une étiquette est
// réuploadée un jour, son URL change et doit être mise à jour ici.
const LABEL_BASE =
  'https://cdn.shopify.com/s/files/1/1018/0562/1630/files/202609021636-10-Bons_Baisers_de_Paname-part-';

const LABEL_URLS = {
  1: `${LABEL_BASE}1.pdf?v=1788520026`,
  2: `${LABEL_BASE}2.pdf?v=1788520026`,
  3: `${LABEL_BASE}3.pdf?v=1788520026`,
  4: `${LABEL_BASE}4.pdf?v=1788520026`,
  5: `${LABEL_BASE}5.pdf?v=1788520026`,
  6: `${LABEL_BASE}6.pdf?v=1788520026`,
  7: `${LABEL_BASE}7.pdf?v=1788520025`,
  8: `${LABEL_BASE}8.pdf?v=1788520026`,
  9: `${LABEL_BASE}9.pdf?v=1788520026`,
  10: `${LABEL_BASE}10.pdf?v=1788520026`
};

// Droit de rétractation : 14 jours calendaires à compter de la RÉCEPTION
// (art. L221-18, repris à l'article 6 des CGV).
// Quand la date de livraison n'est pas remontée par le transporteur, on
// estime 7 jours d'acheminement et on compte donc 21 jours depuis
// l'expédition — volontairement plus large, pour ne jamais être plus
// restrictif que ce qu'annoncent les CGV.
const RETURN_WINDOW_DAYS = 14;
const ESTIMATED_DELIVERY_DAYS = 7;
const DEPOSIT_DEADLINE = '3 jours';
const LABEL_FEE = 5.9;
const LOW_STOCK_THRESHOLD = 3;
const RESERVE_DAYS = 30;

// NOT_AS_PICTURED remplace COLOR_MISMATCH, qui ne parlait que de couleur.
// L'ancien code reste accepté : des retours en cours le portent encore.
const VALID_REASONS = [
  'TOO_SMALL',
  'TOO_BIG',
  'NOT_AS_PICTURED',
  'COLOR_MISMATCH',
  'NOT_LIKED',
  'OTHER'
];
const VALID_ACTIONS = ['REFUND', 'EXCHANGE'];

function cleanText(value) {
  return String(value == null ? '' : value).replace(/[\r\n]+/g, ' ').trim().slice(0, 300);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://misu-sneakers.fr');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { orderNumber, zipCode, items, returnId } = req.body || {};

  if (!orderNumber || !zipCode || !Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: 'Champs manquants' });
  }

  try {
    const order = await findOrder(orderNumber, zipCode);
    if (!order) {
      return res
        .status(404)
        .json({ error: 'Commande non trouvée. Vérifiez le numéro et le code postal.' });
    }

    const fulfillment = order.fulfillments?.[0];
    if (!fulfillment) {
      return res.status(400).json({ error: "Cette commande n'a pas encore été expédiée." });
    }

    const deliveredAt = getDeliveredAt(order);
    const daysSince = (date) => Math.floor((new Date() - new Date(date)) / 86400000);
    const daysAgo = daysSince(deliveredAt || fulfillment.createdAt);
    const limit = deliveredAt
      ? RETURN_WINDOW_DAYS
      : RETURN_WINDOW_DAYS + ESTIMATED_DELIVERY_DAYS;

    if (daysAgo > limit) {
      const repere = deliveredAt
        ? `Votre commande a été livrée il y a ${daysAgo} jours`
        : `Votre commande a été expédiée il y a ${daysAgo} jours`;
      return res.status(400).json({
        error: `Le délai de retour est dépassé. ${repere}, au-delà des 14 jours prévus par nos conditions générales de vente. Nous ne pouvons donc pas accepter ce retour.`
      });
    }

    // Articles de la commande, indexés par ligne.
    const lines = new Map();
    (order.lineItems?.nodes || []).forEach((l) => lines.set(l.id, l));

    // Quantités déjà engagées ailleurs. Une mise à jour ne se bloque pas
    // elle-même : on ignore le retour en cours de modification.
    const existingReturns = await getReturnsForOrder(order.name);
    const engaged = new Map();
    existingReturns
      .filter((r) => r.returnId !== returnId)
      .forEach((r) =>
        r.items.forEach((i) => {
          if (!i.lineItemId) return;
          engaged.set(i.lineItemId, (engaged.get(i.lineItemId) || 0) + (i.quantity || 1));
        })
      );

    const catalog = await getCatalog();
    const variantById = new Map();
    catalog.forEach((p) =>
      p.variants.nodes.forEach((v) =>
        variantById.set(v.id, { product: p, variant: v })
      )
    );

    // Validation article par article, avant toute écriture.
    const prepared = [];

    for (const item of items) {
      const line = lines.get(item.lineItemId);
      if (!line) {
        return res.status(400).json({ error: 'Un des articles ne fait pas partie de cette commande.' });
      }

      if (!VALID_REASONS.includes(item.reason)) {
        return res.status(400).json({ error: 'Motif de retour invalide.' });
      }

      const comment = cleanText(item.comment);
      if (item.reason === 'OTHER' && !comment) {
        return res.status(400).json({
          error: `Merci de préciser le motif du retour pour « ${line.title} ».`
        });
      }

      if (!VALID_ACTIONS.includes(item.action)) {
        return res.status(400).json({ error: 'Action de retour invalide.' });
      }

      const quantity = Math.max(1, Number(item.quantity || 1));
      const already = engaged.get(line.id) || 0;
      if (already + quantity > Number(line.quantity || 1)) {
        return res.status(400).json({
          error: `« ${line.title} » a déjà fait l'objet d'une demande de retour.`
        });
      }
      engaged.set(line.id, already + quantity);

      let exchange = null;

      if (item.action === 'EXCHANGE') {
        const target = variantById.get(item.exchangeVariantId);
        if (!target) {
          return res.status(400).json({ error: 'La taille choisie pour l\u2019échange est introuvable.' });
        }

        const available =
          Boolean(target.variant.availableForSale) && Number(target.variant.inventoryQuantity) > 0;
        if (!available) {
          return res.status(400).json({
            error: `La taille choisie pour « ${target.product.title} » vient d'être épuisée. Choisissez-en une autre.`
          });
        }

        const paid = Number(line.discountedUnitPriceSet?.shopMoney?.amount || 0);
        if (Math.abs(Number(target.variant.price) - paid) > 0.01) {
          return res.status(400).json({
            error: 'Les échanges sont possibles uniquement vers un article de même prix.'
          });
        }

        exchange = {
          variantId: target.variant.id,
          barcode: target.variant.barcode || '',
          title: `${target.product.title} — ${target.variant.title}`
        };
      }

      prepared.push({
        lineItemId: line.id,
        barcode: line.variant?.barcode || '',
        productTitle: line.title,
        variantTitle: line.variant?.title || '',
        quantity,
        reason: item.reason,
        comment,
        action: item.action,
        exchangeBarcode: exchange?.barcode || '',
        exchangeTitle: exchange?.title || '',
        exchangeVariantId: exchange?.variantId || null
      });
    }

    // Un seul échange dans le colis suffit à rendre le retour gratuit.
    const hasExchange = prepared.some((i) => i.action === 'EXCHANGE');
    const fee = hasExchange ? 0 : LABEL_FEE;

    // Le brouillon d'abord : il réserve le stock. S'il échoue, aucune
    // étiquette n'a été consommée et la cliente peut recommencer.
    let draft = null;
    const exchangeVariantIds = prepared
      .filter((i) => i.exchangeVariantId)
      .flatMap((i) => Array(i.quantity).fill(i.exchangeVariantId));

    // Sur une mise à jour, on repart d'un brouillon neuf : le précédent est
    // supprimé plus bas, une fois le nouveau créé.
    const previous = existingReturns.find((r) => r.returnId === returnId);

    if (exchangeVariantIds.length) {
      // L'adresse de la commande d'origine est reprise telle quelle : sur
      // une livraison en point relais, c'est celle du relais choisi.
      const addr = order.shippingAddress || null;
      const shippingAddress = addr
        ? {
            firstName: addr.firstName || undefined,
            lastName: addr.lastName || undefined,
            company: addr.company || undefined,
            address1: addr.address1 || undefined,
            address2: addr.address2 || undefined,
            city: addr.city || undefined,
            zip: addr.zip || undefined,
            provinceCode: addr.provinceCode || undefined,
            countryCode: addr.countryCodeV2 || undefined,
            phone: addr.phone || undefined
          }
        : null;

      draft = await createExchangeDraft({
        customerId: order.customer?.id || null,
        email: order.email,
        shippingAddress,
        shippingTitle: order.shippingLine?.title || null,
        customAttributes: (order.customAttributes || []).map((a) => ({
          key: a.key,
          value: a.value
        })),
        variantIds: exchangeVariantIds,
        originOrderName: order.name,
        returnId: returnId || null,
        reserveDays: RESERVE_DAYS
      });
    }

    let result;
    try {
      result = returnId
        ? await updateReturn(returnId, prepared, draft?.id || null)
        : await createReturn(order.name, prepared, draft?.id || null);
    } catch (err) {
      // Le retour n'a pas pu être enregistré : on relâche le stock réservé
      // plutôt que de le laisser bloqué trente jours pour rien.
      if (draft) await deleteDraft(draft.id).catch(() => {});
      throw err;
    }

    if (!result) {
      if (draft) await deleteDraft(draft.id).catch(() => {});
      return res
        .status(500)
        .json({ error: "Plus d'étiquettes disponibles. Contactez le support." });
    }

    if (result.locked) {
      if (draft) await deleteDraft(draft.id).catch(() => {});
      return res.status(409).json({
        error: 'Ce retour a déjà été réceptionné et ne peut plus être modifié.'
      });
    }

    const finalReturnId = result.returnId;
    const labelUrl = LABEL_URLS[Number(result.labelNumber)] || null;

    // Si le PDF est introuvable, on continue quand même : la cliente reçoit
    // au moins son numéro de suivi, et l'anomalie est visible dans les logs.
    if (!labelUrl) {
      console.error(
        `Aucune URL de PDF pour l'étiquette ${result.labelNumber} (retour ${finalReturnId})`
      );
    }

    if (typeof result.remaining === 'number' && result.remaining <= LOW_STOCK_THRESHOLD) {
      console.error(
        `Stock d'étiquettes bas : ${result.remaining} restantes après le retour ${finalReturnId}`
      );
    }

    // Écritures sur la commande d'origine. Aucune n'est bloquante : la
    // cliente a déjà son étiquette, un échec de tag ne doit pas lui
    // renvoyer une erreur.
    const settlement = hasExchange
      ? { type: 'NONE', amount: 0, currency: 'EUR', reason: 'Échange sans frais' }
      : { type: 'LABEL_FEE', amount: LABEL_FEE, currency: 'EUR', reason: 'Étiquette de retour' };

    const resume = prepared
      .map((i) => `${i.productTitle} (${i.variantTitle}) — ${i.action === 'EXCHANGE' ? `échange vers ${i.exchangeTitle}` : 'remboursement'}`)
      .join(' ; ');

    try {
      await addOrderTags(order.id, ['retour-en-cours']);
      await appendOrderNote(
        order.id,
        finalReturnId,
        `[${finalReturnId}] ${resume}. Étiquette ${result.labelNumber} (${result.trackingNumber}).${fee ? ` Frais retenus : ${LABEL_FEE} €.` : ' Retour gratuit (échange).'}`
      );
      await setReturnMetafields(order.id, {
        return_status: 'REQUESTED',
        return_label: `${result.labelNumber} / ${result.trackingNumber}`,
        exchange_order: draft?.name || '',
        settlement
      });

      if (draft) {
        // Le brouillon porte enfin son identifiant de retour, visible
        // directement dans la liste des brouillons.
        await addOrderTags(draft.id, [finalReturnId]).catch(() => {});
        await setReturnMetafields(draft.id, {
          origin_order: order.name,
          return_id: finalReturnId,
          return_status: 'REQUESTED',
          settlement
        }).catch(() => {});
      }
    } catch (err) {
      console.error(`Écriture Shopify partielle pour ${finalReturnId} : ${err.message}`);
    }

    // Le brouillon précédent devient caduc : son stock doit être relâché,
    // sinon la réservation resterait bloquée trente jours pour rien.
    const staleDraftId = result.previousDraftId || previous?.draftOrderId || null;
    if (staleDraftId && staleDraftId !== draft?.id) {
      await deleteDraft(staleDraftId).catch(() => {});
    }

    // Premier article conservé à plat pour que le gabarit Klaviyo existant
    // continue de fonctionner sans modification.
    const first = prepared[0];

    await sendReturnEvent(order.email, {
      orderNumber: order.name,
      returnId: finalReturnId,
      returnType: hasExchange ? 'exchange' : 'refund',
      product: first.exchangeTitle || first.productTitle,
      size: first.variantTitle,
      items: prepared.map((i) => ({
        product: i.productTitle,
        variant: i.variantTitle,
        quantity: i.quantity,
        action: i.action,
        exchange: i.exchangeTitle || null,
        reason: i.reason
      })),
      itemCount: prepared.reduce((n, i) => n + i.quantity, 0),
      fee,
      trackingNumber: result.trackingNumber,
      labelNumber: result.labelNumber,
      labelUrl,
      depositDeadline: DEPOSIT_DEADLINE
    });

    return res.status(200).json({
      success: true,
      returnId: finalReturnId,
      trackingNumber: result.trackingNumber,
      labelUrl,
      fee,
      depositDeadline: DEPOSIT_DEADLINE,
      updated: Boolean(returnId),
      exchangeOrder: draft?.name || null,
      deliveredAt: deliveredAt || null
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
}
