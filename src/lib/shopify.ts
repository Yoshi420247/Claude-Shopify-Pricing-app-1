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

// Fetch ALL products with variants and costs via GraphQL pagination
export async function fetchAllProducts() {
  const query = `
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
            variants(first: 100) {
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

  const allProducts: ShopifyProductNode[] = [];
  let hasNextPage = true;
  let cursor: string | null = null;
  let pageCount = 0;

  while (hasNextPage) {
    pageCount++;
    const data = await shopifyGraphQL(query, { cursor });
    const products = data.products;

    for (const edge of products.edges) {
      allProducts.push(edge.node);
    }

    hasNextPage = products.pageInfo.hasNextPage;
    cursor = products.pageInfo.endCursor;

    if (pageCount > 200) {
      console.warn('Hit Shopify pagination safety limit at 200 pages');
      break;
    }
  }

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
    const data = await shopifyFetch('shop.json');
    return { success: true, shopName: data.shop?.name };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Unknown error';
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
