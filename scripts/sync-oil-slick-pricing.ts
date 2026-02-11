#!/usr/bin/env npx tsx --tsconfig tsconfig.scripts.json
// =============================================================================
// Sync Oil Slick Pricing — match all Oil Slick vendor products to
// kraftandkitchen.com pricing (price + compare_at_price)
//
// Usage:
//   npx tsx --tsconfig tsconfig.scripts.json scripts/sync-oil-slick-pricing.ts --dry-run
//   npx tsx --tsconfig tsconfig.scripts.json scripts/sync-oil-slick-pricing.ts
//
// Environment variables required:
//   SHOPIFY_STORE_NAME, SHOPIFY_ACCESS_TOKEN
// =============================================================================

// ---------------------------------------------------------------------------
// Kraft & Kitchen reference pricing (scraped from kraftandkitchen.com/products.json)
// ---------------------------------------------------------------------------

interface RefVariant {
  title: string;
  sku: string;
  price: string;
  compare_at_price: string | null;
}

interface RefProduct {
  title: string;
  /** Lowercase keywords to match Shopify product titles */
  matchKeywords: string[];
  variants: RefVariant[];
}

const KRAFT_KITCHEN_PRICING: RefProduct[] = [
  {
    title: 'Mylar Bags for Storage',
    matchKeywords: ['mylar', 'bags', 'storage'],
    variants: [
      { title: '1g / 100 / Matte Black', sku: 'MYLAR-G-100B', price: '15.00', compare_at_price: '30.00' },
      { title: '1g / 100 / Matte Black w/ window', sku: 'MYLAR-G-100BW', price: '15.00', compare_at_price: '30.00' },
      { title: '1g / 500 / Matte Black', sku: 'MYLAR-G-500B', price: '50.00', compare_at_price: '100.00' },
      { title: '1g / 500 / Matte Black w/ window', sku: 'MYLAR-G-500BW', price: '50.00', compare_at_price: '100.00' },
      { title: '1g / 1000 / Matte Black', sku: 'MYLAR-G-1000B', price: '75.00', compare_at_price: '150.00' },
      { title: '1g / 1000 / Matte Black w/ window', sku: 'MYLAR-G-1000BW', price: '75.00', compare_at_price: '150.00' },
      { title: '1g / 5000 / Matte Black', sku: 'MYLAR-G-5000B', price: '300.00', compare_at_price: '600.00' },
      { title: '1g / 5000 / Matte Black w/ window', sku: 'MYLAR-G-5000BW', price: '300.00', compare_at_price: '600.00' },
      { title: '1/8oz / 100 / Matte Black', sku: 'MYLAR-E-100B', price: '22.00', compare_at_price: '44.00' },
      { title: '1/8oz / 100 / Matte Black w/ window', sku: 'MYLAR-E-100BW', price: '22.00', compare_at_price: '44.00' },
      { title: '1/8oz / 500 / Matte Black', sku: 'MYLAR-E-500B', price: '90.00', compare_at_price: '180.00' },
      { title: '1/8oz / 500 / Matte Black w/ window', sku: 'MYLAR-E-500BW', price: '90.00', compare_at_price: '180.00' },
      { title: '1/8oz / 1000 / Matte Black', sku: 'MYLAR-E-1000B', price: '120.00', compare_at_price: '240.00' },
      { title: '1/8oz / 1000 / Matte Black w/ window', sku: 'MYLAR-E-1000BW', price: '120.00', compare_at_price: '240.00' },
      { title: '1/8oz / 5000 / Matte Black', sku: 'MYLAR-E-5000B', price: '550.00', compare_at_price: '1100.00' },
      { title: '1/8oz / 5000 / Matte Black w/ window', sku: 'MYLAR-E-5000BW', price: '550.00', compare_at_price: '1100.00' },
      { title: '1/4oz / 100 / Matte Black', sku: 'MYLAR-Q-100B', price: '25.00', compare_at_price: '50.00' },
      { title: '1/4oz / 100 / Matte Black w/ window', sku: 'MYLAR-Q-100BW', price: '25.00', compare_at_price: '50.00' },
      { title: '1/4oz / 500 / Matte Black', sku: 'MYLAR-Q-500B', price: '97.50', compare_at_price: '195.00' },
      { title: '1/4oz / 500 / Matte Black w/ window', sku: 'MYLAR-Q-500BW', price: '97.50', compare_at_price: '195.00' },
      { title: '1/4oz / 1000 / Matte Black', sku: 'MYLAR-Q-1000B', price: '130.00', compare_at_price: '260.00' },
      { title: '1/4oz / 1000 / Matte Black w/ window', sku: 'MYLAR-Q-1000BW', price: '130.00', compare_at_price: '260.00' },
      { title: '1/4oz / 5000 / Matte Black', sku: 'MYLAR-Q-5000B', price: '600.00', compare_at_price: '1200.00' },
      { title: '1/4oz / 5000 / Matte Black w/ window', sku: 'MYLAR-Q-5000BW', price: '600.00', compare_at_price: '1200.00' },
      { title: '1/2oz / 100 / Matte Black', sku: 'MYLAR-H-100B', price: '30.00', compare_at_price: '60.00' },
      { title: '1/2oz / 100 / Matte Black w/ window', sku: 'MYLAR-H-100BW', price: '30.00', compare_at_price: '60.00' },
      { title: '1/2oz / 500 / Matte Black', sku: 'MYLAR-H-500B', price: '100.00', compare_at_price: '200.00' },
      { title: '1/2oz / 500 / Matte Black w/ window', sku: 'MYLAR-H-500BW', price: '100.00', compare_at_price: '200.00' },
      { title: '1/2oz / 1000 / Matte Black', sku: 'MYLAR-H-1000B', price: '150.00', compare_at_price: '300.00' },
      { title: '1/2oz / 1000 / Matte Black w/ window', sku: 'MYLAR-H-1000BW', price: '150.00', compare_at_price: '300.00' },
      { title: '1/2oz / 5000 / Matte Black', sku: 'MYLAR-H-5000B', price: '725.00', compare_at_price: '1500.00' },
      { title: '1/2oz / 5000 / Matte Black w/ window', sku: 'MYLAR-H-5000BW', price: '725.00', compare_at_price: '1500.00' },
      { title: 'Pre-roll / 100 / Matte Black w/ window', sku: 'MYLAR-PR-100', price: '22.00', compare_at_price: '44.00' },
      { title: 'Pre-roll / 500 / Matte Black w/ window', sku: 'MYLAR-PR-500', price: '80.00', compare_at_price: '160.00' },
      { title: 'Pre-roll / 1000 / Matte Black w/ window', sku: 'MYLAR-PR-1000', price: '120.00', compare_at_price: '240.00' },
      { title: 'Pre-roll / 5000 / Matte Black w/ window', sku: 'MYLAR-PR-5000', price: '550.00', compare_at_price: '1100.00' },
      { title: '1oz 1000 Matte Black w/ window / 1000 / Matte Black w/ window', sku: 'B0DJ1N955G', price: '170.00', compare_at_price: '30.00' },
    ],
  },
  {
    title: '116mm Opaque Child Resistant Tube',
    matchKeywords: ['116mm', 'child resistant', 'tube'],
    variants: [
      { title: '10', sku: 'PREROLL', price: '7.50', compare_at_price: null },
      { title: '100', sku: 'PREROLL-2', price: '30.00', compare_at_price: null },
      { title: '500', sku: 'PREROLL-3', price: '75.00', compare_at_price: null },
      { title: '1000', sku: 'PREROLL-4', price: '110.00', compare_at_price: null },
      { title: '5000', sku: 'PREROLL-5', price: '475.00', compare_at_price: null },
    ],
  },
  {
    title: '7ml UV Resistant Round Bottom Jar with Child Resistant Black Lids',
    matchKeywords: ['7ml', 'uv', 'jar'],
    variants: [
      { title: '1 (SAMPLE ONLY 5 MAX)', sku: '', price: '8.00', compare_at_price: null },
      { title: '80', sku: '7mluv - 80', price: '66.00', compare_at_price: '132.00' },
      { title: '160', sku: '', price: '110.00', compare_at_price: '220.00' },
      { title: '320', sku: '', price: '211.20', compare_at_price: '422.40' },
      { title: '1280', sku: '', price: '827.20', compare_at_price: '1650.00' },
      { title: '2560', sku: '', price: '1240.00', compare_at_price: '1480.00' },
    ],
  },
  {
    title: '3oz Glass Jar with Black CR Lid',
    matchKeywords: ['3oz', 'glass jar', 'cr lid'],
    variants: [
      { title: '1 SAMPLE 5 MAX', sku: '3OZCR-1', price: '5.00', compare_at_price: '15.00' },
      { title: '50', sku: '3OZCR-50', price: '52.00', compare_at_price: '65.00' },
      { title: '150', sku: '3OZCR-150', price: '120.00', compare_at_price: '125.00' },
      { title: '600', sku: '3OZCR-600', price: '450.00', compare_at_price: '580.00' },
      { title: '1500', sku: '3OZCR-1500', price: '1080.00', compare_at_price: '2555.00' },
      { title: '4500', sku: '3OZCR-4500', price: '2152.00', compare_at_price: '2690.00' },
    ],
  },
  {
    title: '5ml Screw Top Jar with Black Lids',
    matchKeywords: ['5ml', 'screw top', 'jar'],
    variants: [
      { title: '1 (SAMPLE ONLY 5 MAX)', sku: '5MLST-1', price: '5.00', compare_at_price: null },
      { title: '100', sku: '5MLST-100', price: '40.00', compare_at_price: '88.12' },
      { title: '200', sku: '5MLST-250', price: '67.20', compare_at_price: '135.00' },
      { title: '500', sku: '5MLST-500', price: '175.00', compare_at_price: '350.00' },
      { title: '1000', sku: '5MLST-1000', price: '240.00', compare_at_price: '500.00' },
      { title: '5000', sku: '5MLST-5000', price: '1080.00', compare_at_price: '2200.00' },
    ],
  },
];

// ---------------------------------------------------------------------------
// Shopify API helpers (standalone — no imports from src/lib to avoid Next.js deps)
// ---------------------------------------------------------------------------

const SHOPIFY_API_VERSION = '2024-10';

function getShopifyConfig() {
  const store = process.env.SHOPIFY_STORE_NAME;
  const token = process.env.SHOPIFY_ACCESS_TOKEN;
  if (!store || !token) {
    console.error('ERROR: Set SHOPIFY_STORE_NAME and SHOPIFY_ACCESS_TOKEN environment variables');
    process.exit(1);
  }
  return { store, token };
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

async function shopifyREST(path: string, options: RequestInit = {}) {
  const { store, token } = getShopifyConfig();
  const url = `https://${store}.myshopify.com/admin/api/${SHOPIFY_API_VERSION}/${path}`;

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
    throw new Error(`Shopify REST error ${res.status}: ${body}`);
  }

  return res.json();
}

function extractId(gid: string): string {
  return gid.split('/').pop() || gid;
}

// Simple rate limiter: wait between Shopify REST API calls
async function wait(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Fetch Oil Slick products from Shopify
// ---------------------------------------------------------------------------

interface ShopifyVariant {
  id: string;
  title: string;
  sku: string | null;
  price: string;
  compareAtPrice: string | null;
}

interface ShopifyProduct {
  id: string;
  title: string;
  vendor: string | null;
  variants: ShopifyVariant[];
}

async function fetchOilSlickProducts(): Promise<ShopifyProduct[]> {
  const query = `
    query getOilSlickProducts($cursor: String) {
      products(first: 100, after: $cursor, query: "vendor:'Oil Slick'") {
        pageInfo { hasNextPage endCursor }
        edges {
          node {
            id
            title
            vendor
            variants(first: 100) {
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

  const allProducts: ShopifyProduct[] = [];
  let hasNextPage = true;
  let cursor: string | null = null;

  while (hasNextPage) {
    const data = await shopifyGraphQL(query, { cursor });
    const products = data.products;

    for (const edge of products.edges) {
      const node = edge.node;
      allProducts.push({
        id: node.id,
        title: node.title,
        vendor: node.vendor,
        variants: node.variants.edges.map((ve: { node: ShopifyVariant }) => ve.node),
      });
    }

    hasNextPage = products.pageInfo.hasNextPage;
    cursor = products.pageInfo.endCursor;
  }

  return allProducts;
}

// ---------------------------------------------------------------------------
// Matching logic
// ---------------------------------------------------------------------------

function normalizeStr(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
}

function findRefProduct(shopifyProduct: ShopifyProduct): RefProduct | null {
  const shopTitle = normalizeStr(shopifyProduct.title);

  // Try exact title match first
  for (const ref of KRAFT_KITCHEN_PRICING) {
    if (normalizeStr(ref.title) === shopTitle) return ref;
  }

  // Try keyword matching
  for (const ref of KRAFT_KITCHEN_PRICING) {
    const allMatch = ref.matchKeywords.every(kw => shopTitle.includes(kw.toLowerCase()));
    if (allMatch) return ref;
  }

  return null;
}

function findRefVariant(shopifyVariant: ShopifyVariant, refProduct: RefProduct): RefVariant | null {
  const shopSku = (shopifyVariant.sku || '').trim();
  const shopVTitle = normalizeStr(shopifyVariant.title);

  // 1. Match by SKU (most reliable)
  if (shopSku) {
    for (const ref of refProduct.variants) {
      if (ref.sku && ref.sku.toLowerCase() === shopSku.toLowerCase()) {
        return ref;
      }
    }
  }

  // 2. Match by exact variant title
  for (const ref of refProduct.variants) {
    if (normalizeStr(ref.title) === shopVTitle) {
      return ref;
    }
  }

  // 3. Match by variant title containing the ref title or vice versa
  for (const ref of refProduct.variants) {
    const refNorm = normalizeStr(ref.title);
    if (shopVTitle.includes(refNorm) || refNorm.includes(shopVTitle)) {
      return ref;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Update variant price + compare_at_price on Shopify
// ---------------------------------------------------------------------------

interface PriceUpdate {
  shopifyVariantGid: string;
  productTitle: string;
  variantTitle: string;
  currentPrice: string;
  currentCompareAt: string | null;
  newPrice: string;
  newCompareAt: string | null;
  matchedBy: string;
}

async function applyPriceUpdate(update: PriceUpdate, dryRun: boolean): Promise<boolean> {
  const variantId = extractId(update.shopifyVariantGid);
  const label = `${update.productTitle} / ${update.variantTitle} (${variantId})`;

  const priceChanged = update.currentPrice !== update.newPrice;
  const compareChanged = update.currentCompareAt !== update.newCompareAt;

  if (!priceChanged && !compareChanged) {
    log(`  SKIP (already matched): ${label} — $${update.currentPrice}`);
    return true;
  }

  const changes: string[] = [];
  if (priceChanged) changes.push(`price $${update.currentPrice} -> $${update.newPrice}`);
  if (compareChanged) changes.push(`compare_at $${update.currentCompareAt || 'null'} -> $${update.newCompareAt || 'null'}`);

  if (dryRun) {
    log(`  DRY RUN: ${label} — ${changes.join(', ')}`);
    return true;
  }

  try {
    const body: Record<string, unknown> = { id: parseInt(variantId) };
    if (priceChanged) body.price = update.newPrice;
    if (compareChanged) body.compare_at_price = update.newCompareAt;

    const response = await shopifyREST(`variants/${variantId}.json`, {
      method: 'PUT',
      body: JSON.stringify({ variant: body }),
    });

    const returnedPrice = response?.variant?.price;
    if (priceChanged && returnedPrice !== update.newPrice) {
      logError(`Price mismatch for ${label}: sent ${update.newPrice}, got ${returnedPrice}`);
      return false;
    }

    log(`  UPDATED: ${label} — ${changes.join(', ')}`);
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logError(`Failed to update ${label}: ${msg}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
function log(msg: string) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] ${msg}`);
}

function logError(msg: string) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.error(`[${ts}] ERROR: ${msg}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const dryRun = process.argv.includes('--dry-run');

  console.log('\n' + '='.repeat(70));
  console.log('  Oil Slick Pricing Sync — kraftandkitchen.com reference');
  console.log('='.repeat(70));
  console.log(`  Dry run:  ${dryRun}`);
  console.log(`  Source:   kraftandkitchen.com (${KRAFT_KITCHEN_PRICING.length} products, ${KRAFT_KITCHEN_PRICING.reduce((s, p) => s + p.variants.length, 0)} variants)`);
  console.log('='.repeat(70) + '\n');

  // Validate env
  if (!process.env.SHOPIFY_STORE_NAME || !process.env.SHOPIFY_ACCESS_TOKEN) {
    console.error('ERROR: Set SHOPIFY_STORE_NAME and SHOPIFY_ACCESS_TOKEN');
    process.exit(1);
  }

  // Fetch Oil Slick products from Shopify
  log('Fetching Oil Slick vendor products from Shopify...');
  const shopifyProducts = await fetchOilSlickProducts();
  const totalVariants = shopifyProducts.reduce((s, p) => s + p.variants.length, 0);
  log(`Found ${shopifyProducts.length} products, ${totalVariants} variants\n`);

  if (shopifyProducts.length === 0) {
    log('No Oil Slick products found on Shopify. Make sure products have vendor set to "Oil Slick".');
    process.exit(0);
  }

  // Match and build update list
  const updates: PriceUpdate[] = [];
  const unmatched: { product: string; variant: string; sku: string | null }[] = [];
  const unmatchedProducts: string[] = [];

  for (const product of shopifyProducts) {
    const refProduct = findRefProduct(product);
    if (!refProduct) {
      unmatchedProducts.push(product.title);
      log(`WARNING: No matching Kraft & Kitchen product for "${product.title}"`);
      continue;
    }

    log(`Matched product: "${product.title}" -> "${refProduct.title}"`);

    for (const variant of product.variants) {
      const refVariant = findRefVariant(variant, refProduct);
      if (!refVariant) {
        unmatched.push({
          product: product.title,
          variant: variant.title,
          sku: variant.sku,
        });
        log(`  WARNING: No matching variant for "${variant.title}" (SKU: ${variant.sku || 'none'})`);
        continue;
      }

      const matchedBy = variant.sku && refVariant.sku &&
        variant.sku.toLowerCase() === refVariant.sku.toLowerCase()
        ? `SKU:${refVariant.sku}`
        : `title:"${refVariant.title}"`;

      updates.push({
        shopifyVariantGid: variant.id,
        productTitle: product.title,
        variantTitle: variant.title,
        currentPrice: variant.price,
        currentCompareAt: variant.compareAtPrice,
        newPrice: refVariant.price,
        newCompareAt: refVariant.compare_at_price,
        matchedBy,
      });
    }
  }

  // Summary before applying
  const needsUpdate = updates.filter(u =>
    u.currentPrice !== u.newPrice || u.currentCompareAt !== u.newCompareAt
  );

  console.log('\n' + '-'.repeat(70));
  log(`Matched: ${updates.length} variants`);
  log(`Need update: ${needsUpdate.length} variants`);
  log(`Already correct: ${updates.length - needsUpdate.length} variants`);
  log(`Unmatched variants: ${unmatched.length}`);
  log(`Unmatched products: ${unmatchedProducts.length}`);
  console.log('-'.repeat(70) + '\n');

  if (unmatched.length > 0) {
    log('Unmatched variants (on Shopify but no Kraft & Kitchen match):');
    for (const u of unmatched) {
      log(`  - ${u.product} / ${u.variant} (SKU: ${u.sku || 'none'})`);
    }
    console.log('');
  }

  // Apply updates
  if (updates.length === 0) {
    log('No variants to update.');
    process.exit(0);
  }

  log(dryRun ? 'DRY RUN — showing what would change:\n' : 'Applying price updates...\n');

  let success = 0;
  let failed = 0;
  let skipped = 0;

  for (let i = 0; i < updates.length; i++) {
    const update = updates[i];
    const priceChanged = update.currentPrice !== update.newPrice;
    const compareChanged = update.currentCompareAt !== update.newCompareAt;

    if (!priceChanged && !compareChanged) {
      skipped++;
      continue;
    }

    const ok = await applyPriceUpdate(update, dryRun);
    if (ok) {
      success++;
    } else {
      failed++;
    }

    // Rate limit: ~2 requests per second for Shopify REST API
    if (!dryRun && i < updates.length - 1) {
      await wait(500);
    }
  }

  // Final summary
  console.log('\n' + '='.repeat(70));
  console.log(`  Sync ${dryRun ? 'Preview' : 'Complete'}`);
  console.log('='.repeat(70));
  console.log(`  Total matched:     ${updates.length}`);
  console.log(`  Already correct:   ${skipped}`);
  console.log(`  Updated:           ${success}`);
  console.log(`  Failed:            ${failed}`);
  console.log(`  Unmatched variants: ${unmatched.length}`);
  console.log(`  Unmatched products: ${unmatchedProducts.length}`);
  console.log('='.repeat(70) + '\n');

  if (dryRun && needsUpdate.length > 0) {
    log('To apply these changes, run again without --dry-run');
  }

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch(e => {
  logError(`Unhandled error: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
