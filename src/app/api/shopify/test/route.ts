import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  const store = process.env.SHOPIFY_STORE_NAME;
  const token = process.env.SHOPIFY_ACCESS_TOKEN;

  if (!store || !token) {
    return NextResponse.json({
      error: 'Missing env vars',
      hasStore: !!store,
      hasToken: !!token,
    });
  }

  const url = `https://${store}.myshopify.com/admin/api/2024-10/graphql.json`;
  const results: Record<string, unknown> = { url };

  // Test 1: Simple query
  const simpleQuery = `
    query {
      products(first: 5) {
        edges {
          node { id title status }
        }
      }
    }
  `;

  try {
    const res1 = await fetch(url, {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: simpleQuery }),
    });
    const data1 = await res1.json();
    results.simpleQuery = {
      status: res1.status,
      productCount: data1?.data?.products?.edges?.length || 0,
      products: data1?.data?.products?.edges?.map((e: { node: { id: string; title: string; status: string } }) => ({
        title: e.node.title,
        status: e.node.status,
      })) || [],
      errors: data1?.errors || null,
    };
  } catch (e) {
    results.simpleQuery = { error: e instanceof Error ? e.message : 'Unknown error' };
  }

  // Test 2: Query WITH inventory (the one that might fail)
  const inventoryQuery = `
    query {
      products(first: 5) {
        edges {
          node {
            id
            title
            variants(first: 5) {
              edges {
                node {
                  id
                  price
                  inventoryItem {
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

  try {
    const res2 = await fetch(url, {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: inventoryQuery }),
    });
    const data2 = await res2.json();
    results.inventoryQuery = {
      status: res2.status,
      productCount: data2?.data?.products?.edges?.length || 0,
      hasInventoryData: !!data2?.data?.products?.edges?.[0]?.node?.variants?.edges?.[0]?.node?.inventoryItem,
      errors: data2?.errors || null,
      sample: data2?.data?.products?.edges?.[0] || null,
    };
  } catch (e) {
    results.inventoryQuery = { error: e instanceof Error ? e.message : 'Unknown error' };
  }

  return NextResponse.json(results);
}
