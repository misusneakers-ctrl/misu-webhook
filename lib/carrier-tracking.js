// lib/carrier-tracking.js
// Interroge directement les transporteurs (Colissimo, Chronopost, Mondial Relay)
// pour obtenir un statut de livraison réel, sans dépendre de la plateforme
// d'expédition (Smarty365) qui peut changer un jour.
//
// Deux services publics, sans authentification, découverts en inspectant le
// trafic réseau de leurs propres pages de suivi :
// - Colissimo + Chronopost (service unifié La Poste) : laposte.fr/ssu/sun/back/suivi-unifie
//   (détecte automatiquement le transporteur au format du numéro de suivi)
// - Mondial Relay : mondialrelay.fr/api/tracking (nécessite le code postal)
//
// Tout appel qui échoue (réseau, format inattendu, transporteur non reconnu)
// renvoie simplement `null` : l'appelant garde alors le comportement existant
// (lien de suivi générique / anciens métachamps), sans jamais faire échouer
// la requête pour la cliente.

const MONDIAL_RELAY_TIMEOUT_MS = 5000;
const LAPOSTE_TIMEOUT_MS = 5000;

function isMondialRelay(company) {
  return /mondial\s*relay/i.test(String(company || ""));
}

// Diagnostic temporaire (11/09) : le statut HTTP seul ne suffit pas à
// comprendre pourquoi un appel pourtant "réussi" (200) ne renvoie parfois pas
// de données exploitables — on journalise le corps brut dans ce cas-là, pour
// le lire dans les logs Vercel. À retirer une fois le comportement confirmé
// stable en production.
async function fetchJsonWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const rawText = await res.text();
    if (!res.ok) {
      console.warn(`[carrier-tracking] ${url} -> HTTP ${res.status} : ${rawText.slice(0, 300)}`);
      return null;
    }
    try {
      return JSON.parse(rawText);
    } catch (parseErr) {
      console.warn(`[carrier-tracking] ${url} -> HTTP 200 mais réponse non-JSON : ${rawText.slice(0, 300)}`);
      return null;
    }
  } catch (err) {
    console.warn(`[carrier-tracking] ${url} -> échec réseau : ${err.message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function trackMondialRelay(trackingNumber, zip) {
  if (!trackingNumber || !zip) return null;

  const url = `https://www.mondialrelay.fr/api/tracking?shipment=${encodeURIComponent(
    trackingNumber
  )}&postcode=${encodeURIComponent(zip)}&brand=&codePays=fr`;

  const data = await fetchJsonWithTimeout(url, MONDIAL_RELAY_TIMEOUT_MS);
  const expedition = data?.Expedition;
  if (!expedition) {
    if (data) {
      console.warn(`[carrier-tracking] Mondial Relay : réponse reçue mais forme inattendue pour ${trackingNumber} : ${JSON.stringify(data).slice(0, 400)}`);
    }
    return null;
  }

  const steps = expedition.SuiviParEtapes || {};
  const completedStepNumbers = Object.values(steps)
    .filter((s) => s && s.Evenement)
    .map((s) => s.Numero);
  const currentStep = completedStepNumbers.length ? Math.max(...completedStepNumbers) : null;

  const events = (expedition.Evenements || [])
    .map((e) => ({ date: e.Date, label: e.Libelle }))
    .sort((a, b) => new Date(b.date) - new Date(a.date));

  const estimatedDeliveryDate =
    expedition.EstimatedDeliveryDate && !String(expedition.EstimatedDeliveryDate).startsWith("0001-01-01")
      ? expedition.EstimatedDeliveryDate
      : null;

  return {
    carrier: "Mondial Relay",
    statusLabel: expedition.SuiviContextuel || null,
    step: currentStep,
    totalSteps: 5,
    delivered: currentStep === 5,
    estimatedDeliveryDate,
    events,
  };
}

async function trackLaPosteUnifie(trackingNumber) {
  if (!trackingNumber) return null;

  const url = `https://www.laposte.fr/ssu/sun/back/suivi-unifie/${encodeURIComponent(
    trackingNumber
  )}?lang=fr`;

  const data = await fetchJsonWithTimeout(url, LAPOSTE_TIMEOUT_MS);
  const result = Array.isArray(data) ? data[0] : data;
  const shipment = result?.shipment;
  if (!shipment || result?.returnCode !== 200) {
    if (data) {
      console.warn(`[carrier-tracking] La Poste : réponse reçue mais forme inattendue pour ${trackingNumber} : ${JSON.stringify(data).slice(0, 400)}`);
    }
    return null;
  }

  const events = (shipment.event || [])
    .map((e) => ({ date: e.date, label: e.label }))
    .sort((a, b) => new Date(b.date) - new Date(a.date));

  const carrierLabel = shipment.product === "chronopost" ? "Chronopost" : "Colissimo";

  return {
    carrier: carrierLabel,
    statusLabel: shipment.currentState?.shortLabel || null,
    step: shipment.currentState?.stepId ?? null,
    totalSteps: (shipment.timeline || []).length || 5,
    delivered: Boolean(shipment.isFinal) || shipment.currentState?.stepId === 5,
    estimatedDeliveryDate: shipment.isFinal ? shipment.deliveryDate : shipment.estimDate || null,
    events,
  };
}

// Point d'entrée unique : à partir du transporteur et du numéro de suivi déjà
// connus (fulfillment Shopify), va chercher le statut réel à la source.
// Renvoie null si rien n'a pu être récupéré — l'appelant garde alors le lien
// de suivi générique / les anciens métachamps déjà en place.
export async function getCarrierTracking({ company, trackingNumber, zip }) {
  if (!trackingNumber) return null;

  if (isMondialRelay(company)) {
    return trackMondialRelay(trackingNumber, zip);
  }

  // Colissimo, Chronopost, et par défaut tout le reste : le service unifié
  // La Poste détecte le transporteur au format du numéro de suivi.
  return trackLaPosteUnifie(trackingNumber);
}
