// api/create-return.js — dépôt misu-webhook
// Point d'entrée (URL inchangée). La logique vit dans retours/api/create-return.cjs :
// le portail de retours est le même que celui de BBP, paramétré par
// retours/lib/brand.cjs.
import handler from '../retours/api/create-return.cjs';
export default handler;
