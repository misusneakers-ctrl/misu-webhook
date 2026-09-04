import { findOrder } from '../lib/shopify.js';
  import { assignLabel } from '../lib/dropbox.js';
    import { sendReturnEvent } from '../lib/klaviyo.js';

      export default async function handler(req, res) {
        res.setHeader('Access-Control-Allow-Origin', 'https://misu-sneakers.fr');
          res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
              if (req.method === 'OPTIONS') return res.status(200).end();
                if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

                  const { orderNumber, zipCode, returnType, product, size } = req.body || {};
                  if (!orderNumber || !zipCode || !returnType) {
                      return res.status(400).json({ error: 'Champs manquants' });
                    }

                      try {
                      const order = await findOrder(orderNumber, zipCode);
                      if (!order) {
                        return res.status(404).json({ error: 'Commande non trouvée. Vérifiez le numéro et le code postal.' });
                      }

                      const fulfillment = order.fulfillments?.[0];
                      if (!fulfillment) {
                        return res.status(400).json({ error: "Cette commande n'a pas encore été expédiée." });
                      }

                      const shippedDate = new Date(fulfillment.createdAt);
                      const daysAgo = Math.floor((new Date() - shippedDate) / (1000 * 60 * 60 * 24));
                      if (daysAgo > 15) {
                        return res.status(400).json({ error: `Délai de retour dépassé (commande expédiée il y a ${daysAgo} jours, max 15).` });
                      }

                      const label = await assignLabel(order.name);
                      if (!label) {
                        return res.status(500).json({ error: "Plus d'étiquettes disponibles. Contactez le support." });
                      }

                      await sendReturnEvent(order.email, {
                                orderNumber: order.name,
                                returnType,
                                product: product || null,
                                size: size || null,
                                trackingNumber: label.tracking_number
                          });

                      return res.status(200).json({
                                success: true,
                                trackingNumber: label.tracking_number
                          });
                      } catch (err) {
                      console.error(err);
                      return res.status(500).json({ error: 'Erreur serveur' });
                    }
                  }
                    
