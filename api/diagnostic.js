// Vérification des portées réellement accordées à l'app.
//
// Le Dev Dashboard peut afficher des portées qui n'ont jamais été accordées,
// faute de réinstallation après la publication d'une version. Cet endpoint
// interroge Shopify directement : c'est la seule réponse qui fasse foi.
//
// À ouvrir dans un navigateur :
//   https://misu-webhook.vercel.app/api/diagnostic

import { getGrantedScopes } from '../lib/shopify.js';

// Ce dont le portail a besoin, et pourquoi.
const REQUIRED = {
  read_orders: 'lire les commandes (suivi et retours)',
  read_products: 'afficher le catalogue et les stocks',
  read_customers: 'reconnaître un compte client',
  write_orders: 'tags, notes et métachamps sur la commande',
  read_draft_orders: 'relire le brouillon d’échange',
  write_draft_orders: 'créer le brouillon et réserver le stock'
};

const OPTIONAL = {
  read_returns: 'retours natifs visibles dans l’admin',
  write_returns: 'créer le retour natif',
  read_all_orders: 'historique au-delà de 60 jours (accord Shopify requis)'
};

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  try {
    const granted = await getGrantedScopes();

    const missing = Object.keys(REQUIRED).filter((s) => !granted.includes(s));
    const missingOptional = Object.keys(OPTIONAL).filter((s) => !granted.includes(s));

    return res.status(200).json({
      ok: missing.length === 0,
      verdict: missing.length
        ? 'Portées manquantes : la nouvelle version n’a pas été accordée. As-tu réinstallé l’app après avoir publié la version ?'
        : 'Toutes les portées nécessaires sont accordées.',
      granted,
      missing: missing.map((s) => ({ scope: s, usage: REQUIRED[s] })),
      missingOptional: missingOptional.map((s) => ({ scope: s, usage: OPTIONAL[s] }))
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      verdict: 'Impossible de joindre Shopify. Vérifie les variables d’environnement sur Vercel.',
      error: err.message
    });
  }
}
