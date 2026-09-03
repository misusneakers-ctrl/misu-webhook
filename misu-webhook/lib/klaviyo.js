// Envoie un événement Klaviyo "Retour Demandé" qui déclenche le flow email
// (le flow email lui-même se configure dans l'interface Klaviyo, pas ici)
export async function sendReturnEvent(email, properties) {
  if (!email) return;

  await fetch('https://a.klaviyo.com/api/events/', {
    method: 'POST',
    headers: {
      Authorization: `Klaviyo-API-Key ${process.env.KLAVIYO_API_KEY}`,
      'Content-Type': 'application/json',
      revision: '2024-10-15'
    },
    body: JSON.stringify({
      data: {
        type: 'event',
        attributes: {
          properties,
          metric: { data: { type: 'metric', attributes: { name: 'Retour Demandé' } } },
          profile: { data: { type: 'profile', attributes: { email } } }
        }
      }
    })
  });
}
