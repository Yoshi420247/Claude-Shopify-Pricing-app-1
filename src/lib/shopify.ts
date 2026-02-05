// Server-side Shopify API client — no CORS issues since this runs on the server

const SHOPIFY_API_VERSION = '2024-10';

function getShopifyConfig() {
  const store = process.env.SHOPIFY_STORE_NAME;
  const token = process.env.SHOPIFY_ACCESS_TOKEN;
  if (!store || !token) {
    throw new Error('Shopify configuration missing. Set SHOPIFY_STORE_NAME and SHOPIFY_ACCESS_TOKEN.');
  }
  return { store, token };
}

function shopifyAdminUrl(store: string, path: string) {
  return `https://${store}.myshopify.com/admin/api/${SHOPIFY_API_VERSION}/${path}`;
}

async function shopifyFetch(path: string, options: RequestInit = {}) {
  const { store, token } = getShopifyConfig();
  const url = shopifyAdminUrl(store, path);

  const res = await fetch(url, {
    ...options,
    headers: {
      'X-Shopify-Access-Token': token,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Shopify API error ${res.status}: ${body}`);
  }

  return res.json();
}

async function shopifyGraphQL(query: string, variables: Record<string, unknown> = {}) {
  const { store, token } = getShopifyConfig();
  const url = `https://${store}.myshopify.com/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Shopify GraphQL error ${res.status}: ${body}`);
  }

  const result = await res.json();
  if (result.errors) {
    throw new Error(result.errors[0]?.message || 'GraphQL query failed');
  }

  return result.data;
}

// Progress callback type for streaming sync status
export type SyncProgressCallback = (event: {
  phase: 'fetching' | 'saving' | 'complete' | 'error';
  message: string;
  productsFound?: number;
  page?: number;
}) => void;

// Fetch ALL products with variants and costs via GraphQL pagination
export async function fetchAllProducts(onProgress?: SyncProgressCallback) {
  // Query with cost data (requires read_inventory scope)
  // Using variants(first: 250) — Shopify's max per connection
  const queryWithCost = `
    query getProductsWithCost($cursor: String) {
      products(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        edges {
          node {
            id
            title
            description
            descriptionHtml
            vendor
            productType
            handle
            tags
            status
            featuredImage { url }
            variants(first: 250) {
              pageInfo { hasNextPage }
              edges {
                node {
                  id
                  title
                  sku
                  price
                  compareAtPrice
                  inventoryItem {
                    id
                    unitCost { amount currencyCode }
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  // Fallback query without cost data (if read_inventory scope is missing)
  const queryWithoutCost = `
    query getProducts($cursor: String) {
      products(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        edges {
          node {
            id
            title
            description
            descriptionHtml
            vendor
            productType
            handle
            tags
            status
            featuredImage { url }
            variants(first: 250) {
              pageInfo { hasNextPage }
              edges {
                node {
                  id
                  title
                  sku
                  price
                  compareAtPrice
                }
              }
            }
          }
        }
      }
    }
  `;

  const allProducts: ShopifyProductNode[] = [];
  let hasNextPage = true;
  let cursor: string | null = null;
  let pageCount = 0;
  let useFallback = false;

  while (hasNextPage) {
    pageCount++;

    // Retry logic: up to 3 attempts per page with exponential backoff
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const query = useFallback ? queryWithoutCost : queryWithCost;
        const data = await shopifyGraphQL(query, { cursor });
        const products = data.products;

        for (const edge of products.edges) {
          // Warn if a product has more variants than we fetched
          if (edge.node.variants?.pageInfo?.hasNextPage) {
            console.warn(`Product "${edge.node.title}" has >250 variants — only first 250 imported`);
          }
          allProducts.push(edge.node);
        }

        hasNextPage = products.pageInfo.hasNextPage;
        cursor = products.pageInfo.endCursor;
        lastError = null;
        break; // Success — exit retry loop
      } catch (e: unknown) {
        lastError = e instanceof Error ? e : new Error(String(e));
        const message = lastError.message;

        // First page with inventory query error → switch to fallback
        if (pageCount === 1 && attempt === 1 && !useFallback) {
          console.warn(`Error with inventory query (${message.slice(0, 150)}), retrying without cost data`);
          useFallback = true;
          continue;
        }

        // Throttled by Shopify — wait and retry
        if (message.includes('429') || message.includes('Throttled')) {
          const wait = attempt * 2000; // 2s, 4s, 6s
          console.warn(`Shopify rate limit on page ${pageCount}, waiting ${wait}ms (attempt ${attempt}/3)`);
          onProgress?.({ phase: 'fetching', message: `Rate limited, retrying in ${wait / 1000}s...`, productsFound: allProducts.length, page: pageCount });
          await new Promise(r => setTimeout(r, wait));
          continue;
        }

        // Other error — wait briefly and retry
        if (attempt < 3) {
          const wait = attempt * 1500;
          console.warn(`Shopify error on page ${pageCount} (attempt ${attempt}/3): ${message.slice(0, 100)}`);
          await new Promise(r => setTimeout(r, wait));
          continue;
        }
      }
    }

    // If all retries failed, throw
    if (lastError) {
      console.error(`Shopify sync failed on page ${pageCount} after 3 attempts: ${lastError.message}`);
      throw lastError;
    }

    // Progress reporting
    if (pageCount % 2 === 0 || !hasNextPage) {
      const msg = `Fetched ${allProducts.length} products (page ${pageCount})...`;
      console.log(msg);
      onProgress?.({ phase: 'fetching', message: msg, productsFound: allProducts.length, page: pageCount });
    }

    // Rate limiting: small delay between pages to avoid Shopify throttling
    if (hasNextPage) {
      await new Promise(r => setTimeout(r, 250));
    }

    if (pageCount > 200) {
      console.warn('Hit Shopify pagination safety limit at 200 pages (20,000 products max)');
      break;
    }
  }

  console.log(`Shopify sync complete: ${allProducts.length} products in ${pageCount} pages (usedFallback: ${useFallback})`);
  return allProducts;
}

// Update a variant's price
export async function updateVariantPrice(variantId: string, newPrice: number) {
  return shopifyFetch(`variants/${variantId}.json`, {
    method: 'PUT',
    body: JSON.stringify({
      variant: { id: parseInt(variantId), price: newPrice.toFixed(2) },
    }),
  });
}

// Test the Shopify connection
export async function testConnection() {
  try {
    // Check env vars first
    const store = process.env.SHOPIFY_STORE_NAME;
    const token = process.env.SHOPIFY_ACCESS_TOKEN;

    if (!store) {
      return { success: false, error: 'SHOPIFY_STORE_NAME env var not set' };
    }
    if (!token) {
      return { success: false, error: 'SHOPIFY_ACCESS_TOKEN env var not set' };
    }

    // Check if store name looks wrong
    if (store.includes('.myshopify.com') || store.includes('http')) {
      return { success: false, error: `SHOPIFY_STORE_NAME should be just the store name (e.g., "my-store"), not "${store}"` };
    }

    const url = `https://${store}.myshopify.com/admin/api/${SHOPIFY_API_VERSION}/shop.json`;

    const res = await fetch(url, {
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json',
      },
    });

    if (!res.ok) {
      const body = await res.text();
      return { success: false, error: `Shopify API ${res.status}: ${body.slice(0, 200)}` };
    }

    const data = await res.json();
    return { success: true, shopName: data.shop?.name };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Unknown error';
    // Add more context for common errors
    if (message.includes('fetch failed') || message.includes('ENOTFOUND')) {
      return { success: false, error: `Network error - check SHOPIFY_STORE_NAME is correct. Error: ${message}` };
    }
    return { success: false, error: message };
  }
}

// Extract numeric ID from Shopify GID
export function extractId(gid: string): string {
  return gid.split('/').pop() || gid;
}

// ============================================================================
// Shopify GraphQL Types (internal)
// ============================================================================

interface ShopifyProductNode {
  id: string;
  title: string;
  description: string | null;
  descriptionHtml: string | null;
  vendor: string | null;
  productType: string | null;
  handle: string | null;
  tags: string[];
  status: string;
  featuredImage: { url: string } | null;
  variants: {
    pageInfo?: { hasNextPage: boolean };
    edges: {
      node: {
        id: string;
        title: string;
        sku: string | null;
        price: string;
        compareAtPrice: string | null;
        inventoryItem: {
          id: string;
          unitCost: { amount: string; currencyCode: string } | null;
        } | null;
      };
    }[];
  };
}

export type { ShopifyProductNode };
