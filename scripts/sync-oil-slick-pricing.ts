#!/usr/bin/env npx tsx --tsconfig tsconfig.scripts.json
// =============================================================================
// Sync Oil Slick Pricing — reads competitor pricing research CSV and updates
// all Oil Slick vendor products on your Shopify store to the recommended prices.
//
// The CSV ("oil_slick_competitor_pricing_master.csv") contains per-variant
// competitor research with columns: SKU, Current Price, Recommended Shopify
// Price, and Recommendation Action (Keep / Raise / Lower).
//
// Matching is done by SKU — product title differences are irrelevant.
//
// Usage:
//   npx tsx --tsconfig tsconfig.scripts.json scripts/sync-oil-slick-pricing.ts --dry-run
//   npx tsx --tsconfig tsconfig.scripts.json scripts/sync-oil-slick-pricing.ts
//
// Options:
//   --dry-run       Preview changes without applying
//   --csv <path>    Path to competitor pricing CSV (default: "oil_slick_competitor_pricing_master.csv")
//   --skip-keep     Skip variants where Recommendation Action is "Keep" (only apply Raise/Lower)
//
// Environment variables required:
//   SHOPIFY_STORE_NAME, SHOPIFY_ACCESS_TOKEN
// =============================================================================

import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// CSV parser — handles quoted fields with commas and newlines
// ---------------------------------------------------------------------------

function parseCSV(content: string): Record<string, string>[] {
  const rows: string[][] = [];
  let current: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    const next = content[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        field += '"';
        i++; // skip escaped quote
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        current.push(field);
        field = '';
      } else if (ch === '\n' || (ch === '\r' && next === '\n')) {
        current.push(field);
        field = '';
        if (current.length > 1) rows.push(current);
        current = [];
        if (ch === '\r') i++; // skip \n after \r
      } else {
        field += ch;
      }
    }
  }
  // Last field/row
  if (field || current.length > 0) {
    current.push(field);
    if (current.length > 1) rows.push(current);
  }

  if (rows.length === 0) return [];

  const headers = rows[0];
  return rows.slice(1).map(row => {
    const obj: Record<string, string> = {};
    for (let i = 0; i < headers.length; i++) {
      obj[headers[i].trim()] = (row[i] || '').trim();
    }
    return obj;
  });
}

// ---------------------------------------------------------------------------
// Parse the competitor pricing CSV into a SKU -> recommended price map
// ---------------------------------------------------------------------------

interface PricingEntry {
  productTitle: string;
  handle: string;
  sku: string;
  currentPrice: string;
  recommendedPrice: string;
  action: string; // Keep, Raise, Lower
  competitorName: string;
  competitorPrice: string;
}

function loadCompetitorPricing(csvPath: string): Map<string, PricingEntry> {
  const content = fs.readFileSync(csvPath, 'utf8');
  const rows = parseCSV(content);
  const skuMap = new Map<string, PricingEntry>();

  for (const row of rows) {
    const sku = (row['SKU'] || '').trim();
    const recommendedPrice = (row['Recommended Shopify Price'] || '').trim();
    const action = (row['Recommendation Action'] || '').trim();

    if (!sku || !recommendedPrice) continue;

    skuMap.set(sku.toLowerCase(), {
      productTitle: row['Product Title'] || '',
      handle: row['Handle'] || '',
      sku,
      currentPrice: formatPrice(row['Current Price'] || '0'),
      recommendedPrice: formatPrice(recommendedPrice),
      action,
      competitorName: row['Competitor Name'] || '',
      competitorPrice: row['Competitor Price (for same qty)'] || '',
    });
  }

  return skuMap;
}

function formatPrice(p: string): string {
  const num = parseFloat(p);
  if (isNaN(num)) return p;
  return num.toFixed(2);
}

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

// (matching is done directly by SKU in main — no separate matching functions needed)

// ---------------------------------------------------------------------------
// Update variant price on Shopify
// ---------------------------------------------------------------------------

interface PriceUpdate {
  shopifyVariantGid: string;
  productTitle: string;
  variantTitle: string;
  sku: string;
  currentPrice: string;
  newPrice: string;
  action: string;
  competitorName: string;
}

async function applyPriceUpdate(update: PriceUpdate, dryRun: boolean): Promise<boolean> {
  const variantId = extractId(update.shopifyVariantGid);
  const label = `${update.productTitle} / ${update.variantTitle} [${update.sku}]`;
  const priceChanged = update.currentPrice !== update.newPrice;

  if (!priceChanged) {
    log(`  SKIP (already correct): ${label} — $${update.currentPrice}`);
    return true;
  }

  const change = `$${update.currentPrice} -> $${update.newPrice} (${update.action})`;

  if (dryRun) {
    log(`  DRY RUN: ${label} — ${change}`);
    return true;
  }

  try {
    const response = await shopifyREST(`variants/${variantId}.json`, {
      method: 'PUT',
      body: JSON.stringify({ variant: { id: parseInt(variantId), price: update.newPrice } }),
    });

    const returnedPrice = response?.variant?.price;
    if (returnedPrice !== update.newPrice) {
      logError(`Price mismatch for ${label}: sent ${update.newPrice}, got ${returnedPrice}`);
      return false;
    }

    log(`  UPDATED: ${label} — ${change}`);
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
// CLI argument parsing
// ---------------------------------------------------------------------------

function getArg(flag: string): string | null {
  const args = process.argv.slice(2);
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const skipKeep = process.argv.includes('--skip-keep');
  const csvPath = getArg('--csv') || path.join(process.cwd(), 'oil_slick_competitor_pricing_master.csv');

  console.log('\n' + '='.repeat(70));
  console.log('  Oil Slick Pricing Sync — from Competitor Pricing Research');
  console.log('='.repeat(70));
  console.log(`  Dry run:    ${dryRun}`);
  console.log(`  Skip Keep:  ${skipKeep}`);
  console.log(`  CSV:        ${csvPath}`);
  console.log('='.repeat(70) + '\n');

  // Validate env
  if (!process.env.SHOPIFY_STORE_NAME || !process.env.SHOPIFY_ACCESS_TOKEN) {
    console.error('ERROR: Set SHOPIFY_STORE_NAME and SHOPIFY_ACCESS_TOKEN');
    process.exit(1);
  }

  // Load competitor pricing CSV
  if (!fs.existsSync(csvPath)) {
    console.error(`ERROR: CSV file not found: ${csvPath}`);
    console.error('  Place "oil_slick_competitor_pricing_master.csv" in the repo root');
    process.exit(1);
  }

  log(`Loading competitor pricing from: ${csvPath}`);
  const pricingMap = loadCompetitorPricing(csvPath);
  log(`Loaded ${pricingMap.size} SKUs with recommended prices`);

  // Summarize actions in CSV
  const actionCounts = { Keep: 0, Raise: 0, Lower: 0, Other: 0 };
  for (const entry of pricingMap.values()) {
    if (entry.action === 'Keep') actionCounts.Keep++;
    else if (entry.action === 'Raise') actionCounts.Raise++;
    else if (entry.action === 'Lower') actionCounts.Lower++;
    else actionCounts.Other++;
  }
  log(`  Raise: ${actionCounts.Raise}, Lower: ${actionCounts.Lower}, Keep: ${actionCounts.Keep}`);
  console.log('');

  // Fetch Oil Slick products from Shopify
  log('Fetching Oil Slick vendor products from Shopify...');
  const shopifyProducts = await fetchOilSlickProducts();
  const totalVariants = shopifyProducts.reduce((s, p) => s + p.variants.length, 0);
  log(`Found ${shopifyProducts.length} products, ${totalVariants} variants on Shopify\n`);

  if (shopifyProducts.length === 0) {
    log('No Oil Slick products found on Shopify. Make sure products have vendor set to "Oil Slick".');
    process.exit(0);
  }

  // Match Shopify variants to competitor pricing by SKU
  const updates: PriceUpdate[] = [];
  const unmatchedVariants: { product: string; variant: string; sku: string | null }[] = [];
  const skippedKeep: string[] = [];
  const matchedProducts = new Set<string>();

  for (const product of shopifyProducts) {
    let productHasMatch = false;

    for (const variant of product.variants) {
      const shopSku = (variant.sku || '').trim().toLowerCase();
      if (!shopSku) {
        unmatchedVariants.push({ product: product.title, variant: variant.title, sku: null });
        continue;
      }

      const entry = pricingMap.get(shopSku);
      if (!entry) {
        unmatchedVariants.push({ product: product.title, variant: variant.title, sku: variant.sku });
        continue;
      }

      productHasMatch = true;

      // Skip "Keep" actions if --skip-keep flag is set
      if (skipKeep && entry.action === 'Keep') {
        skippedKeep.push(`${product.title} / ${variant.title} [${variant.sku}]`);
        continue;
      }

      updates.push({
        shopifyVariantGid: variant.id,
        productTitle: product.title,
        variantTitle: variant.title,
        sku: variant.sku || shopSku,
        currentPrice: variant.price,
        newPrice: entry.recommendedPrice,
        action: entry.action,
        competitorName: entry.competitorName,
      });
    }

    if (productHasMatch) {
      matchedProducts.add(product.title);
    }
  }

  const unmatchedProductsList = shopifyProducts
    .filter(p => !matchedProducts.has(p.title))
    .map(p => p.title);

  // Summary
  const needsUpdate = updates.filter(u => u.currentPrice !== u.newPrice);
  const alreadyCorrect = updates.filter(u => u.currentPrice === u.newPrice);

  console.log('\n' + '-'.repeat(70));
  log(`Matched: ${updates.length} variants across ${matchedProducts.size} products`);
  log(`Need update: ${needsUpdate.length} variants`);
  log(`Already correct: ${alreadyCorrect.length} variants`);
  if (skippedKeep.length > 0) log(`Skipped (Keep): ${skippedKeep.length} variants`);
  log(`Unmatched variants (no SKU in CSV): ${unmatchedVariants.length}`);
  log(`Shopify products not in CSV: ${unmatchedProductsList.length}`);
  console.log('-'.repeat(70) + '\n');

  // Show breakdown by action
  if (needsUpdate.length > 0) {
    const raises = needsUpdate.filter(u => u.action === 'Raise');
    const lowers = needsUpdate.filter(u => u.action === 'Lower');
    const keeps = needsUpdate.filter(u => u.action === 'Keep');
    log(`  Price changes: ${raises.length} raises, ${lowers.length} lowers, ${keeps.length} keeps`);
    console.log('');
  }

  if (unmatchedVariants.length > 0) {
    log('Unmatched variants (no matching SKU in competitor CSV):');
    for (const u of unmatchedVariants) {
      log(`  - ${u.product} / ${u.variant} (SKU: ${u.sku || 'none'})`);
    }
    console.log('');
  }

  if (unmatchedProductsList.length > 0) {
    log(`${unmatchedProductsList.length} Shopify products have no matching SKUs in CSV:`);
    for (const name of unmatchedProductsList) {
      log(`  - ${name}`);
    }
    console.log('');
  }

  // Apply updates
  if (updates.length === 0) {
    log('No variants matched. Nothing to update.');
    process.exit(0);
  }

  if (needsUpdate.length === 0) {
    log('All matched variants already have correct pricing. Nothing to update.');
    process.exit(0);
  }

  log(dryRun ? 'DRY RUN — showing what would change:\n' : 'Applying price updates...\n');

  let success = 0;
  let failed = 0;
  let skipped = 0;

  for (let i = 0; i < updates.length; i++) {
    const update = updates[i];

    if (update.currentPrice === update.newPrice) {
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
  console.log(`  Total matched:      ${updates.length}`);
  console.log(`  Already correct:    ${skipped}`);
  console.log(`  ${dryRun ? 'Would update' : 'Updated'}:        ${success}`);
  console.log(`  Failed:             ${failed}`);
  console.log(`  Unmatched variants: ${unmatchedVariants.length}`);
  console.log(`  Products not in CSV: ${unmatchedProductsList.length}`);
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
