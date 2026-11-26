// api/exchange-options.js — dépôt misu-webhook
// Point d'entrée (URL inchangée). La logique vit dans retours/api/exchange-options.cjs :
// le portail de retours est le même que celui de BBP, paramétré par
// retours/lib/brand.cjs.
import handler from '../retours/api/exchange-options.cjs';
export default handler;
