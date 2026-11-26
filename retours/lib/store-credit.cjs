// lib/store-credit.cjs
// Dépôt : misu-webhook
//
// Émission des AVOIRS de retour sous forme de CRÉDIT BOUTIQUE (« cagnotte »)
// Shopify, rattaché au compte de la cliente.
//
// Différence voulue avec BBP : le portail BBP émet une carte cadeau (lib/
// gift-card.js). Pour MISÜ, Luc a choisi le crédit boutique le 26/11/2026 :
// pas de code à copier, le solde apparaît dans le compte client et se déduit
// au paiement. Tout le reste du modèle est identique (6 mois, valeur entière
// de l'article, aucun frais, nouvel avoir à chaque retour).
//
// IDEMPOTENCE — un retour ne doit JAMAIS créditer deux fois, même si le scan
// est relancé après une erreur réseau. Un crédit boutique n'a pas de code
// déterministe que Shopify refuserait en doublon (contrairement à une carte
// cadeau), le témoin est donc la SEULE protection, et il est posé AVANT
// l'appel :
//  1. métachamp de commande « <espace>.avoir_<retour> » lu en premier :
//     - statut « fait »     → déjà crédité, on renvoie le crédit existant ;
//     - statut « engage »   → un essai précédent n'a pas rendu de réponse :
//       on NE rejoue PAS, on signale qu'il faut vérifier le solde du compte ;
//  2. témoin « engage » écrit avant storeCreditAccountCredit ;
//  3. témoin « fait » (avec l'identifiant de transaction) écrit après.
// Sous-créditer se rattrape à la main ; sur-créditer se propage en silence.
//
// Exige sur l'app Shopify : write_store_credit_account_transactions (et
// read_store_credit_accounts pour lire le solde). Sans ce droit, l'appel est
// refusé : rien n'est crédité, le témoin passe en « echec » et la commande est
// taguée « avoir-a-emettre » par l'appelant.

const shopify = require("./shopify.cjs");
const BRAND = require("./brand.cjs");

// Validité décidée comme chez BBP : 6 mois. Constante unique.
const CREDIT_VALIDITY_MONTHS = 6;

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function metafieldKeyFor(returnId) {
  return `avoir_${String(returnId).replace(/[^A-Za-z0-9_-]/g, "")}`.slice(0, 60);
}

// Échéance à N mois de date à date (YYYY-MM-DD). 31 août + 6 mois → 28 février.
function expiryDateFor(months = CREDIT_VALIDITY_MONTHS, from = new Date()) {
  const d = new Date(from.getTime());
  const day = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + months);
  if (d.getUTCDate() < day) d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
}

// Instant UTC correspondant à 23 h 59 min 59 s, heure de Paris, à la date donnée
// (le crédit court jusqu'à la fin de la journée d'échéance, comme la bascule
// fidélité de BBP).
function endOfDayParis(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d, 23, 59, 59);
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Paris",
    hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(guess)).map((p) => [p.type, p.value]));
  const asParis = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
  const offset = asParis - guess; // décalage de Paris à cet instant
  return new Date(guess - offset).toISOString();
}

const M_CREDIT = `mutation CreditRetour($id: ID!, $input: StoreCreditAccountCreditInput!) {
  storeCreditAccountCredit(id: $id, creditInput: $input) {
    storeCreditAccountTransaction { id amount { amount currencyCode } balanceAfterTransaction { amount } expiresAt account { id } }
    userErrors { field message code }
  }
}`;

async function readWitness(shopifyGraphQL, orderId, returnId) {
  const data = await shopifyGraphQL(
    `query AvoirDejaEmis($id: ID!, $namespace: String!, $key: String!) {
       order(id: $id) { metafield(namespace: $namespace, key: $key) { value } }
     }`,
    { id: orderId, namespace: BRAND.metafieldNamespace, key: metafieldKeyFor(returnId) }
  );
  const raw = data?.order?.metafield?.value;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : { status: "illisible" };
  } catch {
    // Témoin illisible : traité comme « engagé ». Ne rien refaire est le choix sûr.
    return { status: "illisible" };
  }
}

async function writeWitness(orderId, returnId, value) {
  await shopify.setReturnMetafields(orderId, { [metafieldKeyFor(returnId)]: value });
}

function toResult(w, type) {
  return {
    type,
    kind: "store_credit",
    amount: round2(w.amount),
    expiresOn: w.expiresOn || null,
    expiresAt: w.expiresAt || null,
    transactionId: w.transactionId || null,
    attachedToCustomer: true,
  };
}

/**
 * Crédite (ou retrouve) l'avoir d'un retour.
 *
 * @returns {Promise<object|null>}
 *   { type: "credit_created" | "credit_existing" | "credit_uncertain", amount, expiresOn, transactionId }
 *   null si rien à créditer.
 * @throws si le crédit n'a pas pu être émis (l'appelant tague « avoir-a-emettre »).
 */
async function issueStoreCredit({ shopifyGraphQL, orderId, returnId, amount, customerId, onWarning, now = new Date() }) {
  const warn = (label, message) => {
    if (onWarning) onWarning(label, message);
    else console.warn(`[store-credit ${returnId}] ${label} : ${message}`);
  };
  const value = round2(amount);
  if (value <= 0) return null;

  // 1. Déjà traité ?
  const witness = await readWitness(shopifyGraphQL, orderId, returnId);
  if (witness) {
    if (witness.status === "fait") {
      if (Math.abs(round2(witness.amount) - value) >= 0.01) {
        warn(
          "avoir déjà émis pour ce retour",
          `montant existant ${round2(witness.amount).toFixed(2)} € ≠ montant calculé ${value.toFixed(2)} € — à vérifier`
        );
      }
      return toResult(witness, "credit_existing");
    }
    if (witness.status !== "echec") {
      // « engage » ou illisible : on ne sait pas si Shopify a crédité.
      warn(
        "crédit à vérifier",
        "un essai précédent n'a pas confirmé le crédit — vérifier le solde du compte client AVANT de créditer à la main"
      );
      return toResult({ ...witness, amount: witness.amount ?? value }, "credit_uncertain");
    }
    // « echec » : Shopify a refusé nettement, rien n'a été crédité → on retente.
  }

  if (!customerId) {
    throw new Error(
      "commande sans compte client : un crédit boutique est impossible — créditer à la main ou rembourser"
    );
  }

  const expiresOn = expiryDateFor(CREDIT_VALIDITY_MONTHS, now);
  const expiresAt = endOfDayParis(expiresOn);

  // 2. Témoin AVANT l'appel.
  const base = { returnId, amount: value, expiresOn, expiresAt, kind: "store_credit", engagedAt: now.toISOString() };
  try {
    await writeWitness(orderId, returnId, { ...base, status: "engage" });
  } catch (e) {
    throw new Error(`témoin non posé (${String(e.message || e).slice(0, 160)}) — rien crédité`);
  }

  // 3. Crédit.
  let transaction = null;
  let refusal = null;
  try {
    const data = await shopifyGraphQL(M_CREDIT, {
      id: customerId,
      input: {
        creditAmount: { amount: value.toFixed(2), currencyCode: "EUR" },
        expiresAt,
        notify: false, // l'e-mail de la cliente part de Klaviyo, pas de Shopify
      },
    });
    const payload = data?.storeCreditAccountCredit;
    transaction = payload?.storeCreditAccountTransaction || null;
    if (!transaction) refusal = JSON.stringify(payload?.userErrors || []).slice(0, 300);
  } catch (e) {
    const message = String(e.message || e).slice(0, 300);
    // Une erreur GraphQL / HTTP franche (droit manquant, compte invalide)
    // prouve que rien n'a été crédité. Une erreur réseau, non : le témoin
    // reste « engagé » et le scan suivant demandera une vérification.
    if (/access denied|not approved|scope|permission|userErrors|invalid|not found|HTTP 4\d\d/i.test(message)) {
      refusal = message;
    } else {
      warn("crédit boutique : réponse perdue", message);
      return toResult({ ...base }, "credit_uncertain");
    }
  }

  if (!transaction) {
    await writeWitness(orderId, returnId, { ...base, status: "echec", erreur: refusal }).catch(() => {});
    throw new Error(`crédit boutique refusé par Shopify : ${refusal}`);
  }

  const done = {
    ...base,
    status: "fait",
    transactionId: transaction.id,
    expiresAt: transaction.expiresAt || expiresAt,
    faitA: new Date().toISOString(),
  };
  await writeWitness(orderId, returnId, done).catch((e) =>
    warn("mémorisation de l'avoir sur la commande", e.message)
  );
  return toResult(done, "credit_created");
}

module.exports = {
  CREDIT_VALIDITY_MONTHS,
  metafieldKeyFor,
  expiryDateFor,
  endOfDayParis,
  readIssuedCredit: readWitness,
  issueStoreCredit,
};
