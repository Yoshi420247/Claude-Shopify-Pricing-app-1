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
// Matching logic — matches Shopify variants to CSV reference data
// ---------------------------------------------------------------------------

function normalizeStr(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
}

function findRefProduct(shopifyProduct: ShopifyProduct, refProducts: RefProduct[]): RefProduct | null {
  const shopTitle = normalizeStr(shopifyProduct.title);

  // Try exact normalized title match first
  for (const ref of refProducts) {
    if (normalizeStr(ref.title) === shopTitle) return ref;
  }

  // Try checking if shop title contains ALL words from ref title (including
  // short words like "3oz", "5ml" which are critical size identifiers).
  // This prevents "5 oz Glass Jar" from matching "3oz Glass Jar".
  for (const ref of refProducts) {
    const refWords = normalizeStr(ref.title).split(' ').filter(Boolean);
    if (refWords.length > 0 && refWords.every(w => shopTitle.includes(w))) return ref;
  }

  // Score-based match: require ALL numeric/size tokens to match exactly,
  // plus a high percentage of other words.
  let bestMatch: RefProduct | null = null;
  let bestScore = 0;

  for (const ref of refProducts) {
    const refWords = normalizeStr(ref.title).split(' ').filter(Boolean);
    const shopWords = shopTitle.split(' ').filter(Boolean);

    // Extract size/number tokens (e.g. "3oz", "5ml", "7ml", "116mm")
    const refSizeTokens = refWords.filter(w => /^\d/.test(w));
    const shopSizeTokens = shopWords.filter(w => /^\d/.test(w));

    // ALL size tokens from the ref must appear in the shop title
    const allSizesMatch = refSizeTokens.every(st => shopSizeTokens.includes(st));
    if (!allSizesMatch) continue;

    // Count how many ref words appear in shop title
    const matched = refWords.filter(w => shopTitle.includes(w)).length;
    const score = matched / refWords.length;

    // Require at least 70% word match
    if (score >= 0.7 && score > bestScore) {
      bestScore = score;
      bestMatch = ref;
    }
  }

  return bestMatch;
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

  // 2. Match by exact normalized variant title
  for (const ref of refProduct.variants) {
    if (normalizeStr(ref.title) === shopVTitle) {
      return ref;
    }
  }

  // 3. Match by variant title containment
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

  // Fetch Oil Slick products from Shopify
  log('Fetching Oil Slick vendor products from Shopify...');
  const shopifyProducts = await fetchOilSlickProducts();
  const totalVariants = shopifyProducts.reduce((s, p) => s + p.variants.length, 0);
  log(`Found ${shopifyProducts.length} products, ${totalVariants} variants on Shopify\n`);

  if (shopifyProducts.length === 0) {
    log('No Oil Slick products found on Shopify. Make sure products have vendor set to "Oil Slick".');
    process.exit(0);
  }

  // Match and build update list
  const updates: PriceUpdate[] = [];
  const unmatched: { product: string; variant: string; sku: string | null }[] = [];
  const unmatchedProducts: string[] = [];

  for (const product of shopifyProducts) {
    const refProduct = findRefProduct(product, refProducts);
    if (!refProduct) {
      unmatchedProducts.push(product.title);
      log(`WARNING: No matching CSV product for Shopify product "${product.title}"`);
      continue;
    }

    log(`Matched: "${product.title}" -> CSV "${refProduct.title}"`);

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
        sku: variant.sku,
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
    log('Unmatched variants (on Shopify but no CSV match):');
    for (const u of unmatched) {
      log(`  - ${u.product} / ${u.variant} (SKU: ${u.sku || 'none'})`);
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
  console.log(`  Total matched:      ${updates.length}`);
  console.log(`  Already correct:    ${skipped}`);
  console.log(`  ${dryRun ? 'Would update' : 'Updated'}:        ${success}`);
  console.log(`  Failed:             ${failed}`);
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
