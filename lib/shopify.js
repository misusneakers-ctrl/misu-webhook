// Cherche une commande Shopify par numéro + vérifie le code postal de livraison
export async function findOrder(orderNumber, zipCode) {
  const shop = process.env.SHOPIFY_SHOP_DOMAIN;
    const token = process.env.SHOPIFY_ADMIN_TOKEN;

      const query = `
          query FindOrder($q: String!) {
                orders(first: 1, query: $q) {
                        edges {
                                  node {
                                              id
                                                          name
                                                                      email
                                                                                  displayFulfillmentStatus
                                                                                              shippingAddress { zip }
                                                                                                          fulfillments(first: 5) {
                                                                                                                        createdAt
                                                                                                                                      trackingInfo { number url company }
                                                                                                                                                  }
                                                                                                                                                            }
                                                                                                                                                                    }
                                                                                                                                                                          }
                                                                                                                                                                              }`;
                                                                                                                                                                              
                                                                                                                                                                                const response = await fetch(`https://${shop}/admin/api/2025-01/graphql.json`, {
                                                                                                                                                                                    method: 'POST',
                                                                                                                                                                                        headers: {
                                                                                                                                                                                              'Content-Type': 'application/json',
                                                                                                                                                                                                    'X-Shopify-Access-Token': token
                                                                                                                                                                                                        },
                                                                                                                                                                                                            body: JSON.stringify({ query, variables: { q: `name:${orderNumber}` } })
                                                                                                                                                                                                              });
                                                                                                                                                                                                              
                                                                                                                                                                                                                const data = await response.json();
                                                                                                                                                                                                                  const order = data?.data?.orders?.edges?.[0]?.node;
                                                                                                                                                                                                                    if (!order) return null;
                                                                                                                                                                                                                    
                                                                                                                                                                                                                      const orderZip = (order.shippingAddress?.zip || '').replace(/\s/g, '');
                                                                                                                                                                                                                        const inputZip = (zipCode || '').replace(/\s/g, '');
                                                                                                                                                                                                                          if (orderZip !== inputZip) return null;
                                                                                                                                                                                                                          
                                                                                                                                                                                                                            return order;
                                                                                                                                                                                                                            }
                                                                                                                                                                                                                            
