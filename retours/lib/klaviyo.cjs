// lib/klaviyo.js
// Dépôt : bbp-webhook
//
// AUDIT 17/09 : révision d'API 2024-10-15 → 2026-01-15. D'après la politique
// Klaviyo (1 an stable, 1 an dépréciée, puis retirée), 2024-10-15 est retirée
// le 15/10/2026 ; les appels seraient alors redirigés vers une autre révision,
// avec risque de comportement différent. Le format de POST /api/events est
// inchangé entre ces révisions.
// Déclenche des événements Klaviyo — même mécanisme que misu-webhook : on
// envoie l'événement, c'est le flow Klaviyo (créé dans l'interface) qui gère
// l'email réellement, pas ce code.
//
//  - trackReturnRequested : "Retour Demandé BBP" — envoyé à la cliente
//    quand elle crée un retour (create-return.js).
//  - trackDailyDigest : "BBP — Digest Quotidien Retours" — envoyé chaque
//    matin à hello@bonsbaisersdepaname.com, récapitulatif des retours reçus
//    la veille (api/daily-digest.js, déclenché par le cron Vercel).

// 14/10 (Luc) : pas de décimales sur un montant rond (« 40 »), sinon « 40,50 ».
function libelleEuros(n) {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(".", ",");
}

const KLAVIYO_API_KEY = process.env.KLAVIYO_API_KEY;
const KLAVIYO_REVISION = "2026-01-15";

async function trackReturnRequested({ email, firstName, orderName, returnId, trackingNumber, labelUrl, items }) {
  if (!KLAVIYO_API_KEY) {
    throw new Error("Variable KLAVIYO_API_KEY manquante.");
  }
  if (!email) {
    // Pas d'email sur la commande (rare) — on ne bloque pas le retour pour
    // autant, on signale juste qu'aucun email n'a pu être envoyé.
    return { sent: false, reason: "Pas d'adresse email sur la commande." };
  }

  const res = await fetch("https://a.klaviyo.com/api/events", {
    method: "POST",
    headers: {
      Authorization: `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
      "Content-Type": "application/json",
      revision: KLAVIYO_REVISION,
    },
    body: JSON.stringify({
      data: {
        type: "event",
        attributes: {
          properties: {
            order_name: orderName,
            return_id: returnId,
            tracking_number: trackingNumber,
            label_url: labelUrl,
            items: items.map((i) => ({
              title: i.title,
              variant: i.variantTitle,
              action: i.action,
              exchange_title: i.exchangeTitle || null,
            })),
          },
          metric: { data: { type: "metric", attributes: { name: require("./brand.cjs").klaviyo.returnRequested } } },
          profile: {
            data: {
              type: "profile",
              attributes: {
                email,
                first_name: firstName || undefined,
              },
            },
          },
          time: new Date().toISOString(),
        },
      },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Échec envoi événement Klaviyo (${res.status}): ${text}`);
  }

  return { sent: true };
}

// Envoie le récapitulatif quotidien des retours reçus hier à une adresse
// interne (hello@bonsbaisersdepaname.com), pas à une cliente — pas de
// first_name, le profil Klaviyo ciblé est celui de la boîte SAV elle-même.
// 18/09 : l'email doit se lire d'un coup d'œil (demande de Luc). Le digest
// envoie donc des listes DÉJÀ triées et des libellés DÉJÀ écrits — "todo"
// (avec montant, ancienneté et boutons), "info" (une ligne par réception sans
// suite) et "totals" (le bandeau du haut). "returns"/"counts"/"outstanding"
// restent envoyés pour ne pas casser un gabarit qui les utiliserait encore.
async function trackDailyDigest({ email, date, dateLabel, todo = [], info = [], totals = null, returns, counts, outstanding = [] }) {
  if (!KLAVIYO_API_KEY) {
    throw new Error("Variable KLAVIYO_API_KEY manquante.");
  }
  if (!email) {
    return { sent: false, reason: "Adresse email destinataire manquante." };
  }

  const res = await fetch("https://a.klaviyo.com/api/events", {
    method: "POST",
    headers: {
      Authorization: `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
      "Content-Type": "application/json",
      revision: KLAVIYO_REVISION,
    },
    body: JSON.stringify({
      data: {
        type: "event",
        attributes: {
          properties: {
            date,
            date_label: dateLabel || date,
            todo,
            info,
            totals,
            returns,
            counts,
            // Ajout audit 17/09 : actions manuelles encore en attente, tous jours confondus.
            outstanding,
          },
          metric: { data: { type: "metric", attributes: { name: require("./brand.cjs").klaviyo.dailyDigest } } },
          profile: {
            data: {
              type: "profile",
              attributes: { email },
            },
          },
          time: new Date().toISOString(),
        },
      },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Échec envoi événement Klaviyo (${res.status}): ${text}`);
  }

  return { sent: true };
}

// Notifie la cliente que son avoir a été émis en règlement d'un retour.
// Ajouté le 15/09 (le code était créé côté Shopify mais jamais communiqué).
// 18/09 : l'avoir est une CARTE CADEAU (elle garde son solde), et deux cas
// bien différents doivent être racontés à la cliente — d'où `reason` :
//  - "choix_cliente"            : elle a demandé un avoir plutôt qu'un
//                                 remboursement (montant entier, sans frais) ;
//  - "commande_payee_en_avoir"  : sa commande avait été payée avec un avoir,
//                                 le montant lui est restitué de la même façon.
async function trackAvoirIssued({ email, firstName, orderName, returnId, code, amount, type, endsAt, reason }) {
  if (!KLAVIYO_API_KEY) {
    throw new Error("Variable KLAVIYO_API_KEY manquante.");
  }
  if (!email) {
    return { sent: false, reason: "Pas d'adresse email sur la commande." };
  }

  const res = await fetch("https://a.klaviyo.com/api/events", {
    method: "POST",
    headers: {
      Authorization: `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
      "Content-Type": "application/json",
      revision: KLAVIYO_REVISION,
    },
    body: JSON.stringify({
      data: {
        type: "event",
        attributes: {
          properties: {
            order_name: orderName,
            return_id: returnId,
            code,
            amount,
            // "gift_card_created" : carte cadeau créée par ce scan. Un avoir
            // déjà émis (nouveau scan du même retour) ne renvoie pas d'email.
            settlement_type: type,
            ends_at: endsAt,
            // Pourquoi cet avoir : "choix_cliente" ou "commande_payee_en_avoir".
            reason: reason || null,
          },
          metric: { data: { type: "metric", attributes: { name: require("./brand.cjs").klaviyo.avoirIssued } } },
          profile: {
            data: {
              type: "profile",
              attributes: {
                email,
                first_name: firstName || undefined,
              },
            },
          },
          time: new Date().toISOString(),
        },
      },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Échec envoi événement Klaviyo (${res.status}): ${text}`);
  }

  return { sent: true };
}

// Rappelle à la cliente qu'un avoir NON DÉPENSÉ arrive à échéance.
// Ajouté le 22/09 — décision de Luc : pas de rappel en aveugle.
//
// Cet événement n'est JAMAIS émis par un délai Klaviyo. Il est émis par le
// balayage matinal (lib/avoir-expiry.js, appelé par api/daily-digest.js) qui
// a d'abord relu le solde réel de la carte dans Shopify. Autrement dit :
// recevoir cet événement PROUVE qu'il reste de l'argent sur la carte, et
// `amount` est ce qui reste — pas le montant d'origine.
//
// `days_left` vaut 60 ou 15 : c'est sur lui que le flow Klaviyo embranche
// vers l'un ou l'autre gabarit.
async function trackAvoirExpiring({ email, firstName, code, maskedCode, amount, initialAmount, endsAt, endsAtLabel, daysLeft, returnId, orderName }) {
  if (!KLAVIYO_API_KEY) {
    throw new Error("Variable KLAVIYO_API_KEY manquante.");
  }
  if (!email) {
    return { sent: false, reason: "Pas d'adresse email pour cet avoir." };
  }

  const res = await fetch("https://a.klaviyo.com/api/events", {
    method: "POST",
    headers: {
      Authorization: `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
      "Content-Type": "application/json",
      revision: KLAVIYO_REVISION,
    },
    body: JSON.stringify({
      data: {
        type: "event",
        attributes: {
          properties: {
            // Solde RESTANT relu dans Shopify à l'instant du balayage.
            amount,
            initial_amount: initialAmount ?? null,
            // Code complet recalculé ; à défaut les 4 derniers caractères.
            code: code || maskedCode || null,
            code_is_partial: !code,
            ends_at: endsAt,
            ends_at_label: endsAtLabel || endsAt,
            days_left: daysLeft,
            return_id: returnId || null,
            order_name: orderName || null,
          },
          metric: { data: { type: "metric", attributes: { name: require("./brand.cjs").klaviyo.avoirExpiring } } },
          profile: {
            data: {
              type: "profile",
              attributes: {
                email,
                first_name: firstName || undefined,
              },
            },
          },
          time: new Date().toISOString(),
        },
      },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Échec envoi événement Klaviyo (${res.status}): ${text}`);
  }

  return { sent: true };
}

// Crédit fidélité 10 % émis en crédit boutique Shopify (13/10/2026).
// Choix de Luc : l'e-mail part par un flow Klaviyo déclenché par cet
// événement (Shopify n'envoie rien, notify: false). Le crédit se voit dans le
// compte client et se déduit au paiement quand la cliente est connectée :
// pas de code à communiquer. `balance` est le solde total après ce crédit.
async function trackCreditFideliteEmis({ email, firstName, orderName, amount, balance, expiresAt, expiresAtLabel }) {
  if (!KLAVIYO_API_KEY) {
    throw new Error("Variable KLAVIYO_API_KEY manquante.");
  }
  if (!email) {
    return { sent: false, reason: "Pas d'adresse email pour cette cliente." };
  }
  const res = await fetch("https://a.klaviyo.com/api/events", {
    method: "POST",
    headers: {
      Authorization: `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
      "Content-Type": "application/json",
      revision: KLAVIYO_REVISION,
    },
    body: JSON.stringify({
      data: {
        type: "event",
        attributes: {
          properties: {
            order_name: orderName,
            amount,
            amount_label: libelleEuros(amount),
            balance,
            balance_label: libelleEuros(balance),
            expires_at: expiresAt || null,
            expires_at_label: expiresAtLabel || null,
            account_url: "https://bonsbaisers.paris/account",
          },
          metric: { data: { type: "metric", attributes: { name: "Crédit Fidélité Émis MISÜ" } } },
          // Une commande ne donne qu'un crédit : un seul e-mail, même si la passe est rejouée.
          unique_id: `fid-emis-${orderName}`,
          profile: {
            data: {
              type: "profile",
              attributes: { email, first_name: firstName || undefined },
            },
          },
          time: new Date().toISOString(),
        },
      },
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Échec envoi événement Klaviyo (${res.status}): ${text}`);
  }
  return { sent: true };
}

// Rappel avant expiration du crédit fidélité (J-45 / J-30), décidé par Luc le
// 13/10/2026. Émis par la passe quotidienne de api/fidelite.js, seulement s'il
// RESTE du crédit (relu dans Shopify) : `amount` est ce qui expire, pas le
// montant d'origine. `days_left` sert au flow pour choisir le gabarit.
async function trackCreditFideliteExpire({ email, firstName, amount, balance, expiresAt, expiresAtLabel, daysLeft, orders, uniqueId }) {
  if (!KLAVIYO_API_KEY) {
    throw new Error("Variable KLAVIYO_API_KEY manquante.");
  }
  if (!email) {
    return { sent: false, reason: "Pas d'adresse email pour cette cliente." };
  }
  const res = await fetch("https://a.klaviyo.com/api/events", {
    method: "POST",
    headers: {
      Authorization: `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
      "Content-Type": "application/json",
      revision: KLAVIYO_REVISION,
    },
    body: JSON.stringify({
      data: {
        type: "event",
        attributes: {
          properties: {
            amount,
            amount_label: libelleEuros(amount),
            balance,
            balance_label: libelleEuros(balance),
            expires_at: expiresAt || null,
            expires_at_label: expiresAtLabel || null,
            days_left: daysLeft,
            orders: orders || [],
            account_url: "https://bonsbaisers.paris/account",
          },
          metric: { data: { type: "metric", attributes: { name: "Crédit Fidélité Bientôt Expiré MISÜ" } } },
          unique_id: uniqueId || undefined,
          profile: {
            data: {
              type: "profile",
              attributes: { email, first_name: firstName || undefined },
            },
          },
          time: new Date().toISOString(),
        },
      },
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Échec envoi événement Klaviyo (${res.status}): ${text}`);
  }
  return { sent: true };
}

// Bascule Rise → crédit boutique (13/10/2026) : une cliente dont la cagnotte
// est passée en crédit boutique. Le flow « Cagnotte Transférée BBP » (Klaviyo)
// explique où la retrouver : compte client, déduite au paiement, sans code.
// unique_id par cliente : une seule annonce, même si un lot est rejoué.
async function trackCagnotteTransferee({ email, firstName, customerId, amount, expiresAt, expiresAtLabel }) {
  if (!KLAVIYO_API_KEY) throw new Error("Variable KLAVIYO_API_KEY manquante.");
  if (!email) return { sent: false, reason: "Pas d'adresse email pour cette cliente." };
  const res = await fetch("https://a.klaviyo.com/api/events", {
    method: "POST",
    headers: {
      Authorization: `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
      "Content-Type": "application/json",
      revision: KLAVIYO_REVISION,
    },
    body: JSON.stringify({
      data: {
        type: "event",
        attributes: {
          properties: {
            amount,
            amount_label: libelleEuros(amount),
            expires_at: expiresAt || null,
            expires_at_label: expiresAtLabel || null,
            account_url: "https://bonsbaisers.paris/account",
          },
          metric: { data: { type: "metric", attributes: { name: "Cagnotte Transférée MISÜ" } } },
          unique_id: `bascule-${String(customerId || email).split("/").pop()}`,
          profile: { data: { type: "profile", attributes: { email, first_name: firstName || undefined } } },
          time: new Date().toISOString(),
        },
      },
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Échec envoi événement Klaviyo (${res.status}): ${text.slice(0, 200)}`);
  }
  return { sent: true };
}

// AMORÇAGE DES MÉTRIQUES (13/10/2026). Klaviyo range un événement sous la
// métrique de la SOURCE qui l'envoie : un événement créé depuis l'outil
// Klaviyo de Claude atterrit sous « Klaviyo MCP Server », le même nom envoyé
// ici avec la clé API atterrit sous « API » — deux métriques distinctes
// (constaté : « Retour Demandé BBP » existe en double). Un flow construit sur
// la mauvaise ne part jamais. Pour pouvoir construire les flows AVANT le
// premier envoi réel, on envoie ici, avec la vraie clé, un événement de
// rattrapage (backfill : il ne déclenche aucun flow) sur l'adresse interne.
// unique_id fixe : Klaviyo ne l'enregistre qu'une fois, même rejoué chaque jour.
const METRIQUES_A_AMORCER = [
  require("./brand.cjs").klaviyo.avoirIssued,
  require("./brand.cjs").klaviyo.avoirExpiring,
];

async function amorcerMetriques(email = require("./brand.cjs").contactEmail) {
  if (!KLAVIYO_API_KEY) throw new Error("Variable KLAVIYO_API_KEY manquante.");
  const faits = [];
  for (const nom of METRIQUES_A_AMORCER) {
    const res = await fetch("https://a.klaviyo.com/api/events", {
      method: "POST",
      headers: {
        Authorization: `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
        "Content-Type": "application/json",
        revision: KLAVIYO_REVISION,
      },
      body: JSON.stringify({
        data: {
          type: "event",
          attributes: {
            properties: { amorcage: true },
            metric: { data: { type: "metric", attributes: { name: nom } } },
            profile: { data: { type: "profile", attributes: { email } } },
            unique_id: `amorcage-${nom}`,
            backfill: true,
            time: "2026-10-13T12:00:00Z",
          },
        },
      }),
    });
    faits.push({ nom, ok: res.ok, status: res.status });
  }
  return faits;
}

module.exports = { trackReturnRequested, trackDailyDigest, trackAvoirIssued, trackAvoirExpiring, trackCreditFideliteEmis, trackCreditFideliteExpire, trackCagnotteTransferee, amorcerMetriques };
