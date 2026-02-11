#!/usr/bin/env npx tsx --tsconfig tsconfig.scripts.json
// =============================================================================
// Sync Oil Slick Pricing — reads "kk export.csv" (Shopify products export from
// kraftandkitchen.com) and updates all Oil Slick vendor products on your Shopify
// store to match those prices exactly (price + compare_at_price).
//
// Usage:
//   npx tsx --tsconfig tsconfig.scripts.json scripts/sync-oil-slick-pricing.ts --dry-run
//   npx tsx --tsconfig tsconfig.scripts.json scripts/sync-oil-slick-pricing.ts
//
// Options:
//   --dry-run       Preview changes without applying
//   --csv <path>    Path to CSV file (default: "kk export.csv" in repo root)
//   --vendor <name> Vendor to filter in CSV (default: "Oil Slick")
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
// Parse the KK export CSV into reference pricing data
// ---------------------------------------------------------------------------

interface RefVariant {
  title: string;
  sku: string;
  price: string;
  compare_at_price: string | null;
}

interface RefProduct {
  handle: string;
  title: string;
  variants: RefVariant[];
}

function loadPricingFromCSV(csvPath: string, vendorFilter: string): RefProduct[] {
  const content = fs.readFileSync(csvPath, 'utf8');
  const rows = parseCSV(content);

  const products: RefProduct[] = [];
  let currentProduct: RefProduct | null = null;
  let currentHandle = '';

  for (const row of rows) {
    const handle = row['Handle'] || '';
    const vendor = row['Vendor'] || '';
    const title = row['Title'] || '';
    const variantPrice = row['Variant Price'] || '';
    const compareAt = row['Variant Compare At Price'] || '';
    const sku = row['Variant SKU'] || '';
    const opt1 = row['Option1 Value'] || '';
    const opt2 = row['Option2 Value'] || '';
    const opt3 = row['Option3 Value'] || '';

    // Shopify CSV repeats the handle on every row, but vendor/title only on
    // the first row. Detect a NEW product by handle changing (not just present).
    const isNewProduct = handle && handle !== currentHandle;

    if (isNewProduct) {
      // Save previous product if it was Oil Slick
      if (currentProduct && currentProduct.variants.length > 0) {
        products.push(currentProduct);
      }
      currentHandle = handle;

      // Check vendor — only on the first row of each product
      if (vendor.toLowerCase() === vendorFilter.toLowerCase()) {
        currentProduct = { handle, title, variants: [] };
      } else {
        currentProduct = null;
      }
    }

    // Skip if not an Oil Slick product
    if (!currentProduct) continue;

    // Build variant title from options
    const optParts = [opt1, opt2, opt3].filter(Boolean);
    const variantTitle = optParts.join(' / ') || 'Default';

    if (variantPrice) {
      currentProduct.variants.push({
        title: variantTitle,
        sku,
        price: formatPrice(variantPrice),
        compare_at_price: compareAt ? formatPrice(compareAt) : null,
      });
    }
  }

  // Don't forget the last product
  if (currentProduct && currentProduct.variants.length > 0) {
    products.push(currentProduct);
  }

  return products;
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

// ---------------------------------------------------------------------------
// Matching logic — SKU-first global matching
//
// Product names differ between Oil Slick Pad (Shopify) and Kraft & Kitchen,
// but SKUs are shared. Strategy:
//   1. Build a global SKU -> CSV variant+product map
//   2. For each Shopify variant, look up by SKU directly (ignoring product title)
//   3. For variants without SKU matches, fall back to variant title matching
//      within products that were already identified via SKU matches
// ---------------------------------------------------------------------------

interface SkuMapEntry {
  refProduct: RefProduct;
  refVariant: RefVariant;
}

function buildSkuMap(refProducts: RefProduct[]): Map<string, SkuMapEntry> {
  const map = new Map<string, SkuMapEntry>();
  for (const refProduct of refProducts) {
    for (const refVariant of refProduct.variants) {
      if (refVariant.sku) {
        map.set(refVariant.sku.toLowerCase(), { refProduct, refVariant });
      }
    }
  }
  return map;
}

function normalizeStr(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * For variants without a SKU match, try to find a matching CSV variant
 * within a known ref product by variant title.
 */
function findRefVariantByTitle(shopifyVariant: ShopifyVariant, refProduct: RefProduct): RefVariant | null {
  const shopVTitle = normalizeStr(shopifyVariant.title);

  // Exact normalized title match
  for (const ref of refProduct.variants) {
    if (normalizeStr(ref.title) === shopVTitle) {
      return ref;
    }
  }

  // Containment match
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
  sku: string | null;
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
  const csvPath = getArg('--csv') || path.join(process.cwd(), 'kk export.csv');
  const vendorFilter = getArg('--vendor') || 'Oil Slick';

  console.log('\n' + '='.repeat(70));
  console.log('  Oil Slick Pricing Sync — from Kraft & Kitchen CSV export');
  console.log('='.repeat(70));
  console.log(`  Dry run:  ${dryRun}`);
  console.log(`  CSV:      ${csvPath}`);
  console.log(`  Vendor:   ${vendorFilter}`);
  console.log('='.repeat(70) + '\n');

  // Validate env
  if (!process.env.SHOPIFY_STORE_NAME || !process.env.SHOPIFY_ACCESS_TOKEN) {
    console.error('ERROR: Set SHOPIFY_STORE_NAME and SHOPIFY_ACCESS_TOKEN');
    process.exit(1);
  }

  // Load CSV
  if (!fs.existsSync(csvPath)) {
    console.error(`ERROR: CSV file not found: ${csvPath}`);
    console.error('  Place the Kraft & Kitchen Shopify products export as "kk export.csv" in the repo root');
    process.exit(1);
  }

  log(`Loading pricing from CSV: ${csvPath}`);
  const refProducts = loadPricingFromCSV(csvPath, vendorFilter);
  const totalRefVariants = refProducts.reduce((s, p) => s + p.variants.length, 0);
  log(`Loaded ${refProducts.length} "${vendorFilter}" products, ${totalRefVariants} variants from CSV`);

  for (const p of refProducts) {
    log(`  - ${p.title} (${p.variants.length} variants)`);
  }
  console.log('');

  if (refProducts.length === 0) {
    log(`No "${vendorFilter}" products found in CSV. Check the Vendor column.`);
    process.exit(0);
  }

  // Build global SKU map from CSV
  const skuMap = buildSkuMap(refProducts);
  log(`Built SKU map: ${skuMap.size} SKUs across all CSV products\n`);

  // Fetch Oil Slick products from Shopify
  log('Fetching Oil Slick vendor products from Shopify...');
  const shopifyProducts = await fetchOilSlickProducts();
  const totalVariants = shopifyProducts.reduce((s, p) => s + p.variants.length, 0);
  log(`Found ${shopifyProducts.length} products, ${totalVariants} variants on Shopify\n`);

  if (shopifyProducts.length === 0) {
    log('No Oil Slick products found on Shopify. Make sure products have vendor set to "Oil Slick".');
    process.exit(0);
  }

  // ---------------------------------------------------------------------------
  // PASS 1: Match by SKU globally — this identifies which Shopify products
  // correspond to which CSV products, regardless of product title differences.
  // ---------------------------------------------------------------------------
  const updates: PriceUpdate[] = [];
  const unmatchedVariants: { product: string; variant: string; sku: string | null }[] = [];

  // Track which Shopify products mapped to which CSV products (via SKU hits)
  const shopifyToRefProduct = new Map<string, RefProduct>();
  // Track which CSV variant SKUs have already been matched
  const matchedRefSkus = new Set<string>();

  log('--- Pass 1: SKU matching ---\n');

  for (const product of shopifyProducts) {
    for (const variant of product.variants) {
      const shopSku = (variant.sku || '').trim().toLowerCase();
      if (!shopSku) continue;

      const entry = skuMap.get(shopSku);
      if (!entry) continue;

      // Record which CSV product this Shopify product maps to
      if (!shopifyToRefProduct.has(product.id)) {
        shopifyToRefProduct.set(product.id, entry.refProduct);
        log(`Linked: "${product.title}" -> CSV "${entry.refProduct.title}" (via SKU:${variant.sku})`);
      }

      matchedRefSkus.add(shopSku);

      updates.push({
        shopifyVariantGid: variant.id,
        productTitle: product.title,
        variantTitle: variant.title,
        sku: variant.sku,
        currentPrice: variant.price,
        currentCompareAt: variant.compareAtPrice,
        newPrice: entry.refVariant.price,
        newCompareAt: entry.refVariant.compare_at_price,
        matchedBy: `SKU:${variant.sku}`,
      });
    }
  }

  log(`\nPass 1 result: ${updates.length} variants matched by SKU across ${shopifyToRefProduct.size} products\n`);

  // ---------------------------------------------------------------------------
  // PASS 2: For Shopify products already linked to a CSV product, try to match
  // remaining variants (without SKU matches) by variant title.
  // ---------------------------------------------------------------------------
  log('--- Pass 2: Title matching for remaining variants ---\n');

  const matchedVariantGids = new Set(updates.map(u => u.shopifyVariantGid));

  for (const product of shopifyProducts) {
    const refProduct = shopifyToRefProduct.get(product.id);
    if (!refProduct) continue;

    for (const variant of product.variants) {
      if (matchedVariantGids.has(variant.id)) continue; // already matched by SKU

      const refVariant = findRefVariantByTitle(variant, refProduct);
      if (refVariant) {
        updates.push({
          shopifyVariantGid: variant.id,
          productTitle: product.title,
          variantTitle: variant.title,
          sku: variant.sku,
          currentPrice: variant.price,
          currentCompareAt: variant.compareAtPrice,
          newPrice: refVariant.price,
          newCompareAt: refVariant.compare_at_price,
          matchedBy: `title:"${refVariant.title}"`,
        });
        matchedVariantGids.add(variant.id);
      } else {
        unmatchedVariants.push({
          product: product.title,
          variant: variant.title,
          sku: variant.sku,
        });
        log(`  WARNING: No variant match for "${product.title}" / "${variant.title}" (SKU: ${variant.sku || 'none'})`);
      }
    }
  }

  // Report Shopify products that had zero SKU matches (not in CSV at all)
  const unmatchedProducts = shopifyProducts
    .filter(p => !shopifyToRefProduct.has(p.id))
    .map(p => p.title);

  // Summary before applying
  const needsUpdate = updates.filter(u =>
    u.currentPrice !== u.newPrice || u.currentCompareAt !== u.newCompareAt
  );

  console.log('\n' + '-'.repeat(70));
  log(`Matched: ${updates.length} variants (${matchedRefSkus.size} by SKU, ${updates.length - matchedRefSkus.size} by title)`);
  log(`Need update: ${needsUpdate.length} variants`);
  log(`Already correct: ${updates.length - needsUpdate.length} variants`);
  log(`Unmatched variants: ${unmatchedVariants.length}`);
  log(`Shopify products not in CSV: ${unmatchedProducts.length}`);
  console.log('-'.repeat(70) + '\n');

  if (unmatchedVariants.length > 0) {
    log('Unmatched variants (linked product but no variant match):');
    for (const u of unmatchedVariants) {
      log(`  - ${u.product} / ${u.variant} (SKU: ${u.sku || 'none'})`);
    }
    console.log('');
  }

  if (unmatchedProducts.length > 0) {
    log(`${unmatchedProducts.length} Shopify products have no matching CSV product (no shared SKUs):`);
    for (const name of unmatchedProducts) {
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
  console.log(`  Total matched:      ${updates.length} (${matchedRefSkus.size} by SKU)`);
  console.log(`  Already correct:    ${skipped}`);
  console.log(`  ${dryRun ? 'Would update' : 'Updated'}:        ${success}`);
  console.log(`  Failed:             ${failed}`);
  console.log(`  Unmatched variants: ${unmatchedVariants.length}`);
  console.log(`  Products not in CSV: ${unmatchedProducts.length}`);
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
