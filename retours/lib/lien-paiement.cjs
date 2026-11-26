// lib/lien-paiement.js
// Dépôt : bbp-webhook
//
// 13/10/2026 — briques d'un LIEN DE PAIEMENT Shopify « sans rien à expédier » :
// un brouillon de commande avec UNE ligne personnalisée non expédiable
// (requiresShipping: false), taxable (prix TTC : TVA 20 % incluse, réglage
// « taxes incluses » de la boutique), puis sa facture (draftOrderInvoiceSend).
// Le paiement transforme le brouillon en commande… qui n'a RIEN à préparer :
// l'entrepôt n'a rien à expédier.
//
// Utilisé par :
//  - api/sav/lien-paiement.js : lien libre depuis la messagerie (supplément
//    de livraison, etc.) ;
//  - api/sav/changer-action.js : différence d'un échange plus cher payée
//    AVANT la réception du colis retour (option « lien maintenant »). Le
//    brouillon d'échange, lui, reste un brouillon jusqu'à la réception ET le
//    paiement : aucune commande expédiable n'existe avant.

const TAG_LIEN = "LIEN_PAIEMENT";

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * Crée le brouillon (n'envoie rien).
 * @returns {Promise<{id, name, invoiceUrl}>}
 */
async function creerBrouillonPaiement(shopifyGraphQL, { montant, libelle, email, customerId = null, tags = [], note = "", attributs = [] }) {
  const data = await shopifyGraphQL(
    `mutation CreerLienPaiement($input: DraftOrderInput!) {
       draftOrderCreate(input: $input) { draftOrder { id name invoiceUrl } userErrors { field message } }
     }`,
    {
      input: {
        ...(customerId ? { purchasingEntity: { customerId } } : {}),
        email,
        lineItems: [{
          title: String(libelle).slice(0, 120),
          originalUnitPrice: round2(montant).toFixed(2),
          quantity: 1,
          requiresShipping: false,
          taxable: true,
        }],
        tags: [...new Set([TAG_LIEN, ...tags])],
        note: String(note || "").slice(0, 5000),
        customAttributes: [{ key: require("./brand.cjs").attrPrefix + "lien_paiement", value: "1" }, ...attributs],
      },
    }
  );
  const d = data?.draftOrderCreate;
  if (d?.userErrors?.length || !d?.draftOrder?.id) {
    throw new Error(`Brouillon de paiement refusé par Shopify : ${JSON.stringify(d?.userErrors || []).slice(0, 300)}`);
  }
  return d.draftOrder;
}

/** Envoie la facture (e-mail Shopify) ; renvoie l'URL de paiement. */
async function envoyerFacture(shopifyGraphQL, draftId) {
  const env = await shopifyGraphQL(
    `mutation EnvoyerLienPaiement($id: ID!) { draftOrderInvoiceSend(id: $id) { draftOrder { id status invoiceUrl } userErrors { field message } } }`,
    { id: draftId }
  );
  return env?.draftOrderInvoiceSend?.draftOrder?.invoiceUrl || null;
}

/** État d'un lien : payé si le brouillon est devenu une commande payée. */
async function lirePaiement(shopifyGraphQL, draftId) {
  const data = await shopifyGraphQL(
    `query EtatLienPaiement($id: ID!) {
       draftOrder(id: $id) { id name status totalPriceSet { shopMoney { amount } } order { id name displayFinancialStatus } }
     }`,
    { id: draftId }
  );
  const d = data?.draftOrder;
  if (!d) return { existe: false, paye: false };
  const statut = String(d.status || "").toUpperCase();
  const fin = String(d.order?.displayFinancialStatus || "").toUpperCase();
  return {
    existe: true,
    nom: d.name,
    statut,
    montant: round2(parseFloat(d.totalPriceSet?.shopMoney?.amount || "0")),
    paye: statut === "COMPLETED" && (!fin || ["PAID", "PARTIALLY_REFUNDED", "REFUNDED"].includes(fin)),
    commande: d.order?.name || null,
  };
}

async function supprimerBrouillonPaiement(shopifyGraphQL, draftId) {
  await shopifyGraphQL(
    `mutation SupprimerLienPaiement($input: DraftOrderDeleteInput!) { draftOrderDelete(input: $input) { deletedId userErrors { field message } } }`,
    { input: { id: draftId } }
  );
}

module.exports = { TAG_LIEN, creerBrouillonPaiement, envoyerFacture, lirePaiement, supprimerBrouillonPaiement };
