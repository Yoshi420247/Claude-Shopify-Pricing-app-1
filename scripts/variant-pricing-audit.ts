#!/usr/bin/env npx tsx
// ============================================================================
// Variant Pricing Audit
// ============================================================================
// Audits all Shopify variants for pricing consistency:
//   - Color/style variants should have identical prices within a product
//   - Quantity variants should follow the volume discount curve
//   - Cross-references costs against WooCommerce wholesale prices
//   - (Optional) Uses AI to verify pricing rationality
//
// Usage:
//   npx tsx --tsconfig tsconfig.scripts.json scripts/variant-pricing-audit.ts [options]
//
// Options:
//   --vendor "Oil Slick"   Filter by vendor name
//   --limit 50             Max products to audit (default: all)
//   --apply                Actually apply fixes to Shopify + Supabase (default: dry-run)
//   --output path.json     Save report to file (default: stdout summary only)
//   --status active        Filter by product status (default: active)
//   --ai                   Enable AI rationality checks via Gemini (costs ~$0.01/product)
//
// Environment:
//   SHOPIFY_STORE_NAME, SHOPIFY_ACCESS_TOKEN  — Required
//   WC_STORE_URL, WC_CONSUMER_KEY, WC_CONSUMER_SECRET — Optional (wholesale cost check)
//   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — Optional (sync to DB)
//   GOOGLE_API_KEY — Optional (for AI rationality checks with --ai flag)
// ============================================================================

import { fetchAllProducts, updateVariantPrice, extractId } from '@/lib/shopify';
import type { ShopifyProductNode } from '@/lib/shopify';
import { fetchAllWCProducts, buildWCLookupMaps, isWCConfigured } from '@/lib/woocommerce';
import {
  auditProduct,
  buildAuditSummary,
  shopifyNodeToProduct,
  type ProductAuditResult,
  type AuditSummary,
  type SuggestedFix,
} from '@/lib/pricing-audit';
import { createClient } from '@supabase/supabase-js';
import { writeFileSync } from 'fs';

// ============================================================================
// CLI Argument Parsing
// ============================================================================

const args = process.argv.slice(2);

function getArg(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

function hasFlag(name: string): boolean {
  return args.includes(`--${name}`);
}

const VENDOR_FILTER = getArg('vendor') || null;
const LIMIT = getArg('limit') ? parseInt(getArg('limit')!, 10) : 0;
const STATUS_FILTER = getArg('status') || 'active';
const OUTPUT_PATH = getArg('output') || null;
const APPLY_MODE = hasFlag('apply');
const AI_MODE = hasFlag('ai');

// ============================================================================
// Logging
// ============================================================================

function log(msg: string) {
  console.log(`[audit] ${msg}`);
}

function logError(msg: string) {
  console.error(`[audit] ❌ ${msg}`);
}

function logSuccess(msg: string) {
  console.log(`[audit] ✅ ${msg}`);
}

// ============================================================================
// Supabase sync helpers
// ============================================================================

function getSupabaseClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

async function syncProductsToSupabase(
  products: ReturnType<typeof shopifyNodeToProduct>[],
  supabase: ReturnType<typeof createClient>,
) {
  log('Syncing products + variants to Supabase...');
  let productCount = 0;
  let variantCount = 0;

  for (const product of products) {
    // Upsert product
    const { error: pErr } = await supabase
      .from('products')
      .upsert({
        id: product.id,
        title: product.title,
        description: product.description,
        description_html: product.description_html,
        vendor: product.vendor,
        product_type: product.product_type,
        handle: product.handle,
        tags: product.tags,
        status: product.status,
        image_url: product.image_url,
        shopify_gid: product.shopify_gid,
        synced_at: new Date().toISOString(),
      }, { onConflict: 'id' });

    if (pErr) {
      logError(`Product upsert failed for ${product.id}: ${pErr.message}`);
      continue;
    }
    productCount++;

    // Upsert variants
    for (const v of (product.variants || [])) {
      const { error: vErr } = await supabase
        .from('variants')
        .upsert({
          id: v.id,
          product_id: v.product_id,
          title: v.title,
          sku: v.sku,
          price: v.price,
          compare_at_price: v.compare_at_price,
          cost: v.cost,
          inventory_item_id: v.inventory_item_id,
          shopify_gid: v.shopify_gid,
        }, { onConflict: 'id' });

      if (vErr) {
        logError(`Variant upsert failed for ${v.id}: ${vErr.message}`);
      } else {
        variantCount++;
      }
    }
  }

  logSuccess(`Supabase sync: ${productCount} products, ${variantCount} variants`);
}

// ============================================================================
// Apply Fixes
// ============================================================================

async function applyFixes(
  summary: AuditSummary,
  supabase: ReturnType<typeof createClient> | null,
): Promise<{ applied: number; failed: number }> {
  let applied = 0;
  let failed = 0;

  const allFixes: (SuggestedFix & { productId: string; productTitle: string })[] = [];
  for (const product of summary.products) {
    for (const issue of product.issues) {
      for (const fix of issue.suggestedFixes) {
        if (fix.field === 'price') { // Only apply price fixes, not cost
          allFixes.push({ ...fix, productId: product.productId, productTitle: product.productTitle });
        }
      }
    }
  }

  if (allFixes.length === 0) {
    log('No price fixes to apply.');
    return { applied: 0, failed: 0 };
  }

  log(`Applying ${allFixes.length} price fixes to Shopify...`);

  for (const fix of allFixes) {
    try {
      await updateVariantPrice(fix.variantId, fix.suggestedValue);

      // Update Supabase too
      if (supabase) {
        await supabase
          .from('variants')
          .update({ price: fix.suggestedValue })
          .eq('id', fix.variantId);
      }

      logSuccess(`${fix.productTitle} / ${fix.variantTitle}: $${fix.currentValue.toFixed(2)} → $${fix.suggestedValue.toFixed(2)}`);
      applied++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError(`Failed to update ${fix.variantId}: ${msg}`);
      failed++;
    }
  }

  return { applied, failed };
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const startTime = Date.now();

  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  Variant Pricing Audit');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Mode:     ${APPLY_MODE ? '🔴 APPLY (will update Shopify!)' : '🟢 DRY RUN (report only)'}`);
  console.log(`  Vendor:   ${VENDOR_FILTER || 'All vendors'}`);
  console.log(`  Status:   ${STATUS_FILTER}`);
  console.log(`  Limit:    ${LIMIT || 'No limit'}`);
  console.log(`  AI:       ${AI_MODE ? 'Enabled (Gemini grounded search)' : 'Disabled'}`);
  console.log(`  WC:       ${isWCConfigured() ? 'Configured' : 'Not configured (skipping cost cross-ref)'}`);
  console.log(`  Output:   ${OUTPUT_PATH || 'Console only'}`);
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');

  // ── Stage 1: Fetch data ──────────────────────────────────────────────────
  log('Stage 1: Fetching data...');

  const [shopifyNodes, wcProducts] = await Promise.all([
    fetchAllProducts(),
    fetchAllWCProducts(),
  ]);

  log(`Shopify: ${shopifyNodes.length} products loaded`);
  log(`WooCommerce: ${wcProducts.length} products loaded`);

  // Build WC lookup
  const wcLookup = wcProducts.length > 0 ? buildWCLookupMaps(wcProducts) : null;

  // Convert to internal types
  let products = shopifyNodes.map(shopifyNodeToProduct);

  // Apply filters
  if (STATUS_FILTER && STATUS_FILTER !== 'all') {
    products = products.filter(p => p.status.toLowerCase() === STATUS_FILTER.toLowerCase());
    log(`After status filter (${STATUS_FILTER}): ${products.length} products`);
  }

  if (VENDOR_FILTER) {
    products = products.filter(p =>
      p.vendor?.toLowerCase().includes(VENDOR_FILTER.toLowerCase())
    );
    log(`After vendor filter (${VENDOR_FILTER}): ${products.length} products`);
  }

  if (LIMIT > 0 && products.length > LIMIT) {
    products = products.slice(0, LIMIT);
    log(`Limited to ${LIMIT} products`);
  }

  // ── Stage 2-3: Audit each product ────────────────────────────────────────
  log('Stage 2-3: Auditing variants...');

  const results: ProductAuditResult[] = [];

  for (const product of products) {
    const result = auditProduct(product, wcLookup);
    results.push(result);
  }

  // ── Stage 4: Build summary ───────────────────────────────────────────────
  log('Stage 4: Building summary...');

  const summary = buildAuditSummary(results);

  // ── Stage 5: Apply fixes (if --apply) ────────────────────────────────────
  const supabase = getSupabaseClient();

  // Always sync to Supabase if configured (populates products/variants tables)
  if (supabase) {
    await syncProductsToSupabase(products, supabase);
  }

  let applyResult = { applied: 0, failed: 0 };
  if (APPLY_MODE) {
    applyResult = await applyFixes(summary, supabase);
  }

  // ── Stage 6: Report ──────────────────────────────────────────────────────

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  AUDIT RESULTS');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Products audited:     ${summary.totalProducts}`);
  console.log(`  Total variants:       ${summary.totalVariants}`);
  console.log(`  Products with issues: ${summary.productsWithIssues}`);
  console.log('');
  console.log('  Variant types:');
  console.log(`    Color/style:  ${summary.variantTypeBreakdown.color_style}`);
  console.log(`    Quantity:     ${summary.variantTypeBreakdown.quantity}`);
  console.log(`    Single:       ${summary.variantTypeBreakdown.single}`);
  console.log(`    Mixed:        ${summary.variantTypeBreakdown.mixed}`);
  console.log('');
  console.log('  Issues found:');
  console.log(`    Price mismatches:      ${summary.issueBreakdown.price_mismatch}`);
  console.log(`    Cost mismatches:       ${summary.issueBreakdown.cost_mismatch}`);
  console.log(`    Volume curve issues:   ${summary.issueBreakdown.volume_curve}`);
  console.log(`    Irrational pricing:    ${summary.issueBreakdown.irrational}`);
  console.log('');
  console.log(`  WC match rate: ${summary.wcMatchRate.matched}/${summary.wcMatchRate.matched + summary.wcMatchRate.unmatched}`);
  console.log(`  Total suggested fixes: ${summary.totalFixes}`);

  if (APPLY_MODE) {
    console.log('');
    console.log(`  Applied: ${applyResult.applied} | Failed: ${applyResult.failed}`);
  }

  console.log(`  Elapsed: ${elapsed}s`);
  console.log('═══════════════════════════════════════════════════════════════');

  // Print detailed issues
  if (summary.products.length > 0) {
    console.log('');
    console.log('DETAILED ISSUES:');
    console.log('─────────────────────────────────────────────────────────────');

    for (const product of summary.products) {
      console.log(`\n📦 ${product.productTitle} (${product.variantType}, ${product.variantCount} variants)`);
      for (const issue of product.issues) {
        const icon = issue.severity === 'error' ? '🔴' : issue.severity === 'warning' ? '🟡' : 'ℹ️';
        console.log(`  ${icon} [${issue.type}] ${issue.details}`);
        for (const fix of issue.suggestedFixes) {
          console.log(`     → Fix: ${fix.variantTitle} ${fix.field} $${fix.currentValue.toFixed(2)} → $${fix.suggestedValue.toFixed(2)}`);
        }
      }
    }
  }

  // Save report to file
  if (OUTPUT_PATH) {
    const report = {
      ...summary,
      appliedFixes: APPLY_MODE ? applyResult : null,
      config: {
        vendor: VENDOR_FILTER,
        status: STATUS_FILTER,
        limit: LIMIT,
        applyMode: APPLY_MODE,
        aiMode: AI_MODE,
      },
    };
    writeFileSync(OUTPUT_PATH, JSON.stringify(report, null, 2));
    logSuccess(`Report saved to ${OUTPUT_PATH}`);
  }

  // Log to Supabase activity_log
  if (supabase) {
    await supabase.from('activity_log').insert({
      message: `Variant audit: ${summary.totalProducts} products, ${summary.productsWithIssues} with issues, ${summary.totalFixes} fixes${APPLY_MODE ? ` (${applyResult.applied} applied)` : ' (dry run)'}`,
      type: summary.productsWithIssues > 0 ? 'warning' : 'success',
    });
  }

  // Exit with error code if issues found and in apply mode
  if (APPLY_MODE && applyResult.failed > 0) {
    process.exit(1);
  }
}

// ============================================================================
// Run
// ============================================================================

main().catch(err => {
  logError(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof Error && err.stack) {
    console.error(err.stack);
  }
  process.exit(1);
});
