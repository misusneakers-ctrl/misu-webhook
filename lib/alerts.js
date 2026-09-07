// Alertes internes envoyées à MISÜ, pas aux clientes.
//
// Le stock d'étiquettes s'épuisait silencieusement : l'alerte n'existait
// que sous forme d'un console.error dans les logs Vercel, que personne ne
// consulte. Une cliente aurait découvert le problème avant nous.
//
// L'alerte part sur des PALIERS, pas sous un seuil. Avec un stock de dix
// étiquettes, alerter « sous dix » enverrait un email à chaque retour et
// Luc cesserait de les lire. Chaque palier n'est franchi qu'une fois,
// puisque le stock décroît d'une unité à la fois.

const KLAVIYO_API = 'https://a.klaviyo.com/api/events/';
const KLAVIYO_REVISION = '2024-10-15';
const ALERT_EMAIL = 'bonjour@misu-sneakers.fr';
const METRIC_NAME = 'Stock Étiquettes Bas';

// Paliers d'alerte, du plus large au plus urgent.
export const ALERT_LEVELS = [10, 5, 3, 2, 1, 0];

export function shouldAlert(remaining) {
  return ALERT_LEVELS.includes(Number(remaining));
}

function describe(remaining) {
  if (remaining === 0) {
    return {
      niveau: 'EPUISE',
      titre: 'Plus aucune étiquette de retour',
      message:
        "Le stock d'étiquettes est épuisé. Les prochaines demandes de retour échoueront tant que de nouvelles étiquettes ne seront pas ajoutées à INVENTORY.csv."
    };
  }
  if (remaining <= 3) {
    return {
      niveau: 'CRITIQUE',
      titre: `Très peu d'étiquettes : ${remaining} restante${remaining > 1 ? 's' : ''}`,
      message: `Il ne reste que ${remaining} étiquette${remaining > 1 ? 's' : ''} de retour. Génère un nouveau lot dès maintenant : au rythme actuel, le stock sera épuisé sous peu.`
    };
  }
  return {
    niveau: 'SURVEILLANCE',
    titre: `Peu d'étiquettes : ${remaining} restantes`,
    message: `Il reste ${remaining} étiquettes de retour. Ce n'est pas encore critique, mais c'est le bon moment pour préparer le prochain lot.`
  };
}

// Envoie une alerte de stock.
//
// Ne lève jamais : une alerte qui échoue ne doit pas faire échouer le
// retour d'une cliente. L'échec est simplement tracé.
export async function sendLowStockAlert(remaining, context = {}) {
  const key = process.env.KLAVIYO_API_KEY;
  if (!key) {
    console.error('KLAVIYO_API_KEY absente : alerte de stock non envoyée.');
    return false;
  }

  const n = Number(remaining);
  const info = describe(n);

  const body = {
    data: {
      type: 'event',
      attributes: {
        properties: {
          remaining: n,
          niveau: info.niveau,
          titre: info.titre,
          message: info.message,
          returnId: context.returnId || null,
          orderName: context.orderName || null
        },
        metric: {
          data: { type: 'metric', attributes: { name: METRIC_NAME } }
        },
        profile: {
          data: { type: 'profile', attributes: { email: ALERT_EMAIL } }
        }
      }
    }
  };

  try {
    const res = await fetch(KLAVIYO_API, {
      method: 'POST',
      headers: {
        Authorization: `Klaviyo-API-Key ${key}`,
        revision: KLAVIYO_REVISION,
        'Content-Type': 'application/json',
        accept: 'application/json'
      },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.error(`Alerte de stock refusée par Klaviyo (HTTP ${res.status}) : ${detail}`);
      return false;
    }

    return true;
  } catch (err) {
    console.error(`Alerte de stock impossible : ${err.message}`);
    return false;
  }
}
