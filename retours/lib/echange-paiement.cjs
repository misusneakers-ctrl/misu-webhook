// lib/echange-paiement.js
// Dépôt : bbp-webhook
//
// 13/10/2026 (Luc) — « Envoyer le lien de paiement MAINTENANT » pour un
// échange vers un article plus cher, AVANT la réception du colis retour
// (option de la fenêtre « Changer » de la messagerie).
//
// POURQUOI PAS « commande payée + mise en attente de préparation ».
// Mobiltron importe les commandes et ne revient jamais dessus (Luc, 13/10), et
// rien ne garantit qu'il respecte une mise en attente (fulfillment hold). Une
// commande d'échange payée avant la réception risquerait donc de partir avant
// que l'ancien article soit revenu.
//
// CE QUI EST FAIT À LA PLACE — aucune commande expédiable n'existe avant la
// réception ET le paiement :
//  1. la différence est payée par un lien SÉPARÉ (lib/lien-paiement.js) : un
//     brouillon d'une seule ligne NON EXPÉDIABLE (« Différence d'échange —
//     retour R-… »). Son paiement crée une commande qui n'a rien à préparer ;
//  2. le brouillon d'échange (l'article à envoyer) reste un BROUILLON, remisé
//     du seul crédit, avec l'attribut bbp_paiement_difference = le lien et le
//     tag ECHANGE_PAIEMENT_SEPARE ;
//  3. il n'est achevé (remise portée au prix total, puis draftOrderComplete)
//     que lorsque le colis est reçu ET le lien payé :
//       - au scan (api/receive-return.js), si le lien est déjà payé ;
//       - sinon par la ronde des 10 minutes (api/sav/echanges-payes.js,
//         appelée par le cron de la messagerie), dès que le lien est payé.
//
// Risque restant : aucun côté marchandise. Côté argent, une cliente qui paie
// la différence puis ne renvoie jamais son colis (ou un colis en litige) doit
// être remboursée de ce lien à la main (bouton « Rembourser » sur la commande
// de paiement) — la note de la commande d'origine le dit.

const { lirePaiement } = require("./lien-paiement.cjs");

const TAG_PAIEMENT_SEPARE = "ECHANGE_PAIEMENT_SEPARE";
const ATTR_PAIEMENT = require("./brand.cjs").attrPrefix + "paiement_difference";

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function attribut(liste, cle) {
  const a = (liste || []).find((x) => x.key === cle);
  return a ? a.value : null;
}

const DRAFT_QUERY = `
  query EchangeAPaiementSepare($id: ID!) {
    draftOrder(id: $id) {
      id name status tags
      order { id name }
      appliedDiscount { title value valueType }
      customAttributes { key value }
    }
  }
`;

/**
 * Achève le brouillon d'échange SI le lien de différence est payé.
 * À n'appeler que si le colis retour est reçu (l'appelant le vérifie).
 * @returns {{ etat: 'commande'|'attente_paiement'|'pas_concerne'|'introuvable', order?, paiement? }}
 */
async function completerEchangePaye(shopifyGraphQL, draftId) {
  const data = await shopifyGraphQL(DRAFT_QUERY, { id: draftId });
  const d = data?.draftOrder;
  if (!d) return { etat: "introuvable" };
  if (String(d.status).toUpperCase() === "COMPLETED" && d.order?.id) return { etat: "commande", order: d.order, deja: true };
  const paiementId = attribut(d.customAttributes, ATTR_PAIEMENT);
  const aPayer = round2(parseFloat(attribut(d.customAttributes, require("./brand.cjs").attrPrefix + "difference_a_payer") || "0"));
  if (!paiementId || !(aPayer > 0)) return { etat: "pas_concerne" };

  const paiement = await lirePaiement(shopifyGraphQL, paiementId);
  if (!paiement.paye) return { etat: "attente_paiement", paiement };

  // Différence payée à part : la remise du brouillon couvre désormais tout.
  const remiseActuelle = round2(d.appliedDiscount?.value || 0);
  await shopifyGraphQL(
    `mutation RemiseEchangePaye($id: ID!, $input: DraftOrderInput!) {
       draftOrderUpdate(id: $id, input: $input) { draftOrder { id } userErrors { field message } }
     }`,
    {
      id: d.id,
      input: {
        appliedDiscount: {
          valueType: "FIXED_AMOUNT",
          value: round2(remiseActuelle + aPayer),
          title: d.appliedDiscount?.title || "Valeur article(s) retourné(s)",
        },
      },
    }
  );
  const fin = await shopifyGraphQL(
    `mutation CompleterEchangePaye($id: ID!) { draftOrderComplete(id: $id) { draftOrder { id order { id name } } userErrors { field message } } }`,
    { id: d.id }
  );
  const order = fin?.draftOrderComplete?.draftOrder?.order || null;
  return order ? { etat: "commande", order, paiement } : { etat: "introuvable", paiement };
}

module.exports = { TAG_PAIEMENT_SEPARE, ATTR_PAIEMENT, completerEchangePaye, attribut };
