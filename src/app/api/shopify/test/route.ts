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

  // Simple GraphQL query to test access
  const query = `
    query {
      products(first: 5) {
        edges {
          node {
            id
            title
            status
          }
        }
      }
    }
  `;

  const url = `https://${store}.myshopify.com/admin/api/2024-10/graphql.json`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query }),
    });

    const status = res.status;
    const body = await res.text();

    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = null;
    }

    return NextResponse.json({
      url,
      httpStatus: status,
      hasErrors: !!parsed?.errors,
      errors: parsed?.errors || null,
      productCount: parsed?.data?.products?.edges?.length || 0,
      products: parsed?.data?.products?.edges?.map((e: { node: { id: string; title: string; status: string } }) => ({
        id: e.node.id,
        title: e.node.title,
        status: e.node.status,
      })) || [],
      rawBody: body.slice(0, 1000),
    });
  } catch (e: unknown) {
    return NextResponse.json({
      error: e instanceof Error ? e.message : 'Unknown error',
    });
  }
}
