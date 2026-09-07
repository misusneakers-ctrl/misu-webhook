// Téléchargement de l'étiquette de retour.
//
// Le lien envoyé par email pointe ici, jamais sur le fichier lui-même.
// À chaque clic, un lien Dropbox frais est fabriqué et la cliente y est
// redirigée. Le lien du mail ne périme donc jamais, contrairement à un
// lien de fichier qui expirerait au bout de quelques heures.
//
// L'accès est protégé par un jeton signé : sans lui, il suffirait de
// deviner un identifiant de retour pour récupérer une étiquette.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { getLabelLink } from '../lib/dropbox.js';

// Signature courte dérivée de l'identifiant du retour. Le secret ne quitte
// jamais le serveur : le jeton ne permet pas de le reconstituer.
export function signReturnId(returnId) {
  const secret = process.env.MISU_STAFF_TOKEN || '';
  return createHmac('sha256', secret).update(String(returnId)).digest('hex').slice(0, 20);
}

function validToken(returnId, token) {
  const expected = signReturnId(returnId);
  const given = String(token || '');
  if (given.length !== expected.length) return false;
  // Comparaison à durée constante : une comparaison naïve laisserait
  // deviner le jeton caractère par caractère.
  return timingSafeEqual(Buffer.from(expected), Buffer.from(given));
}

export default async function handler(req, res) {
  const returnId = String(req.query?.r || '').trim();
  const token = String(req.query?.t || '').trim();

  if (!returnId || !token) {
    return res.status(400).send(page("Lien incomplet.", "Le lien utilisé n'est pas valide. Reprends celui de ton email de retour."));
  }

  if (!process.env.MISU_STAFF_TOKEN) {
    console.error('MISU_STAFF_TOKEN absente : impossible de vérifier les liens.');
    return res.status(500).send(page('Service indisponible.', 'Réessaie dans quelques minutes.'));
  }

  if (!validToken(returnId, token)) {
    return res.status(403).send(page('Lien invalide.', "Ce lien ne correspond à aucun retour. Reprends celui de ton email."));
  }

  try {
    const found = await getLabelLink(returnId);
    if (!found) {
      return res.status(404).send(
        page(
          'Étiquette introuvable.',
          "Nous n'avons pas retrouvé le fichier de ton étiquette. Écris-nous à bonjour@misu-sneakers.fr en précisant ta commande, nous te la renvoyons."
        )
      );
    }

    // Redirection sans mise en cache : le lien Dropbox expire, celui-ci non.
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    return res.redirect(302, found.link);
  } catch (err) {
    console.error(err);
    return res.status(500).send(
      page('Téléchargement momentanément impossible.', 'Réessaie dans quelques minutes, ou écris-nous à bonjour@misu-sneakers.fr.')
    );
  }
}

// Page d'erreur minimale : une cliente qui clique depuis son email ne doit
// pas tomber sur un message technique.
function page(titre, message) {
  return `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MISÜ</title></head><body style="margin:0;padding:0;background:#fff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#000;"><div style="max-width:460px;margin:0 auto;padding:60px 24px;text-align:center;"><div style="font-size:12px;letter-spacing:4px;text-transform:uppercase;margin-bottom:32px;">MISÜ</div><div style="font-size:20px;font-weight:300;letter-spacing:1px;line-height:1.5;margin-bottom:18px;">${titre}</div><div style="font-size:14px;font-weight:300;line-height:1.7;color:#666;">${message}</div><a href="https://misu-sneakers.fr/pages/retour" style="display:inline-block;margin-top:32px;padding:16px 24px;border:1px solid #000;font-size:11px;letter-spacing:2px;text-transform:uppercase;text-decoration:none;color:#000;">Retour au portail</a></div></body></html>`;
}
