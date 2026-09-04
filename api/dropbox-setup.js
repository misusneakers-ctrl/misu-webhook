// ENDPOINT TEMPORAIRE — à supprimer une fois le refresh token obtenu.
//
// Échange le code d'autorisation Dropbox contre un refresh token permanent.
// L'app key et l'app secret sont lus depuis les variables Vercel : ils ne
// transitent jamais par l'URL.

export default async function handler(req, res) {
  const code = req.query.code;

  if (!code) {
    return res
      .status(400)
      .send('Ajoutez ?code=... à l URL, avec le code obtenu sur la page d autorisation Dropbox.');
  }

  const appKey = process.env.DROPBOX_APP_KEY;
  const appSecret = process.env.DROPBOX_APP_SECRET;

  if (!appKey || !appSecret) {
    return res
      .status(500)
      .send('Variables manquantes sur Vercel : DROPBOX_APP_KEY et DROPBOX_APP_SECRET.');
  }

  const response = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      grant_type: 'authorization_code',
      client_id: appKey,
      client_secret: appSecret
    })
  });

  const data = await response.json().catch(() => null);

  if (!response.ok || !data?.refresh_token) {
    return res
      .status(500)
      .send(
        'Echec de l echange (HTTP ' +
          response.status +
          ') : ' +
          JSON.stringify(data) +
          '\n\nLe code n est valable qu une fois et environ 10 minutes. Recommencez depuis la page d autorisation.'
      );
  }

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  return res.status(200).send(
    'REFRESH TOKEN (a coller dans la variable Vercel DROPBOX_REFRESH_TOKEN) :\n\n' +
      data.refresh_token +
      '\n\nScopes accordes : ' +
      (data.scope || 'non communiques') +
      '\n\nPensez a supprimer ce fichier api/dropbox-setup.js du depot ensuite.'
  );
}
