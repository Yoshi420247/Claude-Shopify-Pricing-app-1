#!/usr/bin/env npx tsx --tsconfig tsconfig.scripts.json
// =============================================================================
// Standalone Batch Price Analyzer — runs outside Vercel (no 300s timeout)
// Designed for GitHub Actions but can run locally too.
//
// VOLUME PRICING: For products with quantity-type variants, only the base
// (lowest qty) variant is AI-analyzed. All other quantity variants get their
// prices derived via the power-law volume discount formula.
//
// Usage:
//   npx tsx --tsconfig tsconfig.scripts.json scripts/batch-analyze.ts \
//     --vendor "Artist Name" --status active --concurrency 100
//
// Re-run failed products from a previous report:
//   npx tsx --tsconfig tsconfig.scripts.json scripts/batch-analyze.ts \
//     --failed-report reports/failed-products-2026-02-06.json
//
// Skip already-analyzed products (only process new/unanalyzed):
//   npx tsx --tsconfig tsconfig.scripts.json scripts/batch-analyze.ts --skip-analyzed
//
// Environment variables required:
//   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
//   OPENAI_API_KEY, BRAVE_API_KEY,
//   SHOPIFY_STORE_NAME, SHOPIFY_ACCESS_TOKEN
// =============================================================================

import { createClient } from '@supabase/supabase-js';
import { runVolumeAwareAnalysis, saveAnalysis, type SearchMode, type Provider } from '@/lib/pricing-engine';
import { runFullAnalysis } from '@/lib/pricing-engine';
import { updateVariantPrice } from '@/lib/shopify';
import { detectQuantityVariantGroups } from '@/lib/volume-pricing';
import type { Product, Variant, Settings } from '@/types';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface FailedProduct {
  productId: string;
  variantId: string;
  productTitle: string;
  variantTitle: string;
  error: string;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------
function parseArgs(): {
  vendor: string | null;
  status: string;
  concurrency: number;
  dryRun: boolean;
  skipApply: boolean;
  skipAnalyzed: boolean;
  fast: boolean;
  limit: number;
  searchMode: SearchMode;
  provider: Provider;
  failedReport: string | null;
  markup: number | null;
} {
  const args = process.argv.slice(2);
  const get = (flag: string): string | null => {
    const idx = args.indexOf(flag);
    return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : null;
  };
  const has = (flag: string): boolean => args.includes(flag);

  const rawSearch = get('--search-mode') || 'openai';
  const searchMode: SearchMode = rawSearch === 'brave' ? 'brave' : rawSearch === 'amazon' ? 'amazon' : rawSearch === 'none' ? 'none' : 'openai';

  const rawMarkup = get('--markup');
  const markup = rawMarkup ? parseFloat(rawMarkup) : null;
  if (markup !== null && (isNaN(markup) || markup <= 0)) {
    console.error('ERROR: --markup must be a positive number (e.g. 3 for 3x cost)');
    process.exit(1);
  }

  const rawProvider = get('--provider') || 'openai';
  const provider: Provider = rawProvider === 'claude' ? 'claude' : 'openai';

  return {
    vendor: get('--vendor'),
    status: get('--status') || 'active',
    concurrency: parseInt(get('--concurrency') || '100', 10),
    dryRun: has('--dry-run'),
    skipApply: has('--skip-apply'),
    skipAnalyzed: has('--skip-analyzed'),
    fast: has('--fast'),
    limit: parseInt(get('--limit') || '0', 10),
    searchMode,
    provider,
    failedReport: get('--failed-report'),
    markup,
  };
}

// ---------------------------------------------------------------------------
// Logging helpers
// ---------------------------------------------------------------------------
function log(msg: string) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] ${msg}`);
}

function logError(msg: string) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.error(`[${ts}] ERROR: ${msg}`);
}

function logProgress(done: number, total: number, failed: number, applied: number, activeWorkers: number) {
  const pct = ((done / total) * 100).toFixed(1);
  const elapsed = ((Date.now() - globalStartTime) / 1000 / 60).toFixed(1);
  const rate = done > 0 ? (done / ((Date.now() - globalStartTime) / 1000 / 60)).toFixed(1) : '0';
  console.log(`\n${'='.repeat(70)}`);
  console.log(`  Progress: ${done}/${total} (${pct}%) | Failed: ${failed} | Applied: ${applied}`);
  console.log(`  Workers: ${activeWorkers} active | Rate: ${rate} products/min | Elapsed: ${elapsed}min`);
  console.log(`${'='.repeat(70)}\n`);
}

let globalStartTime = Date.now();

// ---------------------------------------------------------------------------
// Fatal error patterns — stop the entire batch
// ---------------------------------------------------------------------------
const FATAL_PATTERNS = [
  'exceeded your current quota',
  'insufficient_quota',
  'billing',
  'account deactivated',
  'invalid_api_key',
  'Incorrect API key',
];

function isFatal(error: string): boolean {
  const lower = error.toLowerCase();
  return FATAL_PATTERNS.some(p => lower.includes(p.toLowerCase()));
}

// ---------------------------------------------------------------------------
// Process a product using volume-aware analysis
// For products with quantity variants: AI-analyze only the base (lowest qty)
// variant, then derive all other quantity variant prices formulaically.
// For products without quantity variants: analyze each variant individually.
// ---------------------------------------------------------------------------
async function processProductVolumeAware(
  product: Product,
  productVariants: Variant[],
  variantsToProcess: Variant[],
  settings: Settings,
  db: ReturnType<typeof createClient>,
  opts: { dryRun: boolean; skipApply: boolean; searchMode: SearchMode; provider: Provider; fast: boolean },
): Promise<{ results: Array<{ variantId: string; success: boolean; applied: boolean; price: number | null; error: string | null; pricingMethod: 'ai' | 'volume_formula' }> }> {
  const results: Array<{ variantId: string; success: boolean; applied: boolean; price: number | null; error: string | null; pricingMethod: 'ai' | 'volume_formula' }> = [];

  // Detect quantity variant groups for this product
  const qtyGroups = detectQuantityVariantGroups(productVariants);

  if (qtyGroups) {
    // Product has quantity variants — use volume-aware analysis
    // Track which variants in variantsToProcess are part of a qty group
    const processedIds = new Set<string>();

    for (const group of qtyGroups) {
      // Check if any variant in this group is in our variantsToProcess list
      const groupVariantIds = new Set(group.variants.map(qv => qv.variant.id));
      const hasVariantToProcess = variantsToProcess.some(v => groupVariantIds.has(v.id));
      if (!hasVariantToProcess) continue;

      // Use the base variant as the target for volume-aware analysis
      const baseVariantId = group.baseVariant.variant.id;
      const label = `${product.title} / qty group [${group.variants.map(qv => qv.quantity).join(', ')}]`;

      try {
        log(`Volume pricing: ${label} — AI-analyzing base (qty ${group.baseVariant.quantity}), deriving ${group.variants.length - 1} tiers`);

        const { results: analysisResults } = await runVolumeAwareAnalysis(
          product,
          productVariants,
          baseVariantId,
          settings,
          {
            onProgress: (step) => log(`  ${step}`),
            searchMode: opts.searchMode,
            provider: opts.provider,
            fast: opts.fast,
          },
        );

        for (const r of analysisResults) {
          // Only process variants that are in our variantsToProcess list
          if (!variantsToProcess.some(v => v.id === r.variantId)) continue;
          processedIds.add(r.variantId);

          if (r.analysisResult.error) {
            results.push({ variantId: r.variantId, success: false, applied: false, price: null, error: r.analysisResult.error, pricingMethod: r.volumeMeta.pricing_method });
            continue;
          }

          // Save analysis to DB
          await saveAnalysis(r.productId, r.variantId, r.analysisResult, r.volumeMeta);

          const price = r.analysisResult.suggestedPrice;
          const variant = productVariants.find(v => v.id === r.variantId);
          const method = r.volumeMeta.pricing_method;

          log(`  ${method === 'ai' ? 'AI' : 'FORMULA'}: ${variant?.title || 'Default'} → $${price?.toFixed(2) || 'none'}`);

          // Auto-apply
          if (price && price > 0 && !opts.dryRun && !opts.skipApply) {
            try {
              await updateVariantPrice(r.variantId, price);
              await db.from('variants').update({ price }).eq('id', r.variantId);
              await db
                .from('analyses')
                .update({ applied: true, applied_at: new Date().toISOString(), previous_price: variant?.price || 0 })
                .match({ product_id: r.productId, variant_id: r.variantId });

              log(`  APPLIED (${r.variantId}): $${variant?.price.toFixed(2)} -> $${price.toFixed(2)}`);
              results.push({ variantId: r.variantId, success: true, applied: true, price, error: null, pricingMethod: method });
            } catch (applyErr) {
              const msg = applyErr instanceof Error ? applyErr.message : 'Apply failed';
              logError(`  Apply failed: ${msg}`);
              results.push({ variantId: r.variantId, success: true, applied: false, price, error: `Apply failed: ${msg}`, pricingMethod: method });
            }
          } else {
            if (opts.dryRun) {
              log(`  DRY RUN: Would apply $${price?.toFixed(2)}`);
            }
            results.push({ variantId: r.variantId, success: true, applied: false, price, error: null, pricingMethod: method });
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Unknown error';
        logError(`${label}: ${msg}`);
        // Mark all variants in this group as failed
        for (const qv of group.variants) {
          if (variantsToProcess.some(v => v.id === qv.variant.id) && !processedIds.has(qv.variant.id)) {
            processedIds.add(qv.variant.id);
            results.push({ variantId: qv.variant.id, success: false, applied: false, price: null, error: msg, pricingMethod: 'ai' });
          }
        }
      }
    }

    // Process any remaining variants that weren't part of a quantity group
    for (const variant of variantsToProcess) {
      if (processedIds.has(variant.id)) continue;
      const r = await processSingleVariant(product, variant, settings, db, opts);
      results.push({ ...r, pricingMethod: 'ai' });
    }
  } else {
    // No quantity variants — process each variant individually (original behavior)
    for (const variant of variantsToProcess) {
      const r = await processSingleVariant(product, variant, settings, db, opts);
      results.push({ ...r, pricingMethod: 'ai' });
    }
  }

  return { results };
}

// ---------------------------------------------------------------------------
// Process a single variant (non-volume, original behavior)
// ---------------------------------------------------------------------------
async function processSingleVariant(
  product: Product,
  variant: Variant,
  settings: Settings,
  db: ReturnType<typeof createClient>,
  opts: { dryRun: boolean; skipApply: boolean; searchMode: SearchMode; provider: Provider; fast: boolean },
): Promise<{ variantId: string; success: boolean; applied: boolean; price: number | null; error: string | null }> {
  const label = `${product.title} / ${variant.title || 'Default'} (${variant.id})`;

  try {
    log(`Analyzing: ${label}`);
    const result = await runFullAnalysis(product, variant, settings, (step) => {
      log(`  ${step}`);
    }, opts.searchMode, opts.provider, opts.fast);

    if (result.error) {
      logError(`Analysis failed for ${label}: ${result.error}`);
      return { variantId: variant.id, success: false, applied: false, price: null, error: result.error };
    }

    // Save analysis to DB
    await saveAnalysis(product.id, variant.id, result);

    const price = result.suggestedPrice;
    log(`  Suggested: $${price?.toFixed(2) || 'none'} (confidence: ${result.confidence}, deliberated: ${result.wasDeliberated})`);

    // Auto-apply
    if (price && price > 0 && !opts.dryRun && !opts.skipApply) {
      try {
        await updateVariantPrice(variant.id, price);
        await db.from('variants').update({ price }).eq('id', variant.id);
        await db
          .from('analyses')
          .update({ applied: true, applied_at: new Date().toISOString(), previous_price: variant.price })
          .match({ product_id: product.id, variant_id: variant.id });

        log(`  APPLIED (${variant.id}): $${variant.price.toFixed(2)} -> $${price.toFixed(2)}`);
        return { variantId: variant.id, success: true, applied: true, price, error: null };
      } catch (applyErr) {
        const msg = applyErr instanceof Error ? applyErr.message : 'Apply failed';
        logError(`  Apply failed: ${msg}`);
        return { variantId: variant.id, success: true, applied: false, price, error: `Apply failed: ${msg}` };
      }
    }

    if (opts.dryRun) {
      log(`  DRY RUN: Would apply $${price?.toFixed(2)}`);
    }

    return { variantId: variant.id, success: true, applied: false, price, error: null };
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    logError(`${label}: ${msg}`);
    return { variantId: variant.id, success: false, applied: false, price: null, error: msg };
  }
}

// ---------------------------------------------------------------------------
// Process a single variant with simple cost markup (no AI calls)
// ---------------------------------------------------------------------------
async function processVariantMarkup(
  product: Product,
  variant: Variant,
  multiplier: number,
  db: ReturnType<typeof createClient>,
  opts: { dryRun: boolean; skipApply: boolean },
): Promise<{ success: boolean; applied: boolean; price: number | null; error: string | null }> {
  const label = `${product.title} / ${variant.title || 'Default'} (${variant.id})`;

  if (variant.cost === null || variant.cost === undefined || variant.cost <= 0) {
    logError(`${label}: No cost data — cannot apply markup`);
    return { success: false, applied: false, price: null, error: 'No cost data on variant' };
  }

  const price = Math.round(variant.cost * multiplier * 100) / 100;
  log(`Markup: ${label} — cost $${variant.cost.toFixed(2)} × ${multiplier} = $${price.toFixed(2)}`);

  // Save analysis record so --skip-analyzed works on future runs
  try {
    await db.from('analyses').upsert({
      product_id: product.id,
      variant_id: variant.id,
      suggested_price: price,
      confidence: 'high',
      confidence_reason: `Simple ${multiplier}x cost markup`,
      summary: `Price set to ${multiplier}x cost ($${variant.cost.toFixed(2)} × ${multiplier} = $${price.toFixed(2)}). No AI analysis performed.`,
      reasoning: [`Cost: $${variant.cost.toFixed(2)}`, `Multiplier: ${multiplier}x`, `Result: $${price.toFixed(2)}`],
      market_position: null,
      price_floor: variant.cost,
      price_ceiling: variant.compare_at_price || null,
      product_identity: null,
      competitor_analysis: null,
      search_queries: [],
      was_deliberated: false,
      was_reflection_retried: false,
      applied: false,
      error: null,
      analyzed_at: new Date().toISOString(),
    }, { onConflict: 'variant_id' });
  } catch (dbErr) {
    const msg = dbErr instanceof Error ? dbErr.message : 'DB save failed';
    logError(`${label}: Failed to save analysis: ${msg}`);
  }

  // Apply price
  if (!opts.dryRun && !opts.skipApply) {
    try {
      await updateVariantPrice(variant.id, price);
      await db.from('variants').update({ price }).eq('id', variant.id);
      await db
        .from('analyses')
        .update({ applied: true, applied_at: new Date().toISOString(), previous_price: variant.price })
        .match({ product_id: product.id, variant_id: variant.id });

      log(`  APPLIED (${variant.id}): $${variant.price.toFixed(2)} -> $${price.toFixed(2)}`);
      return { success: true, applied: true, price, error: null };
    } catch (applyErr) {
      const msg = applyErr instanceof Error ? applyErr.message : 'Apply failed';
      logError(`  Apply failed: ${msg}`);
      return { success: true, applied: false, price, error: `Apply failed: ${msg}` };
    }
  }

  if (opts.dryRun) {
    log(`  DRY RUN: Would apply $${price.toFixed(2)}`);
  }

  return { success: true, applied: false, price, error: null };
}

// ---------------------------------------------------------------------------
// Worker pool — process N tasks concurrently (streaming, no batch chunks)
// ---------------------------------------------------------------------------
async function runPool<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number,
  onFatalCheck?: () => boolean,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let nextIdx = 0;

  async function worker() {
    while (nextIdx < tasks.length) {
      // Check for fatal error before picking up next task
      if (onFatalCheck?.()) break;
      const idx = nextIdx++;
      results[idx] = await tasks[idx]();
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, tasks.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Save failed products report
// ---------------------------------------------------------------------------
function saveFailedReport(failedProducts: FailedProduct[], startTime: number, totalProducts: number, applied: number) {
  const reportsDir = path.join(process.cwd(), 'reports');
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
  }

  const dateStr = new Date().toISOString().slice(0, 10);
  const timeStr = new Date().toISOString().slice(11, 19).replace(/:/g, '-');
  const reportPath = path.join(reportsDir, `failed-products-${dateStr}-${timeStr}.json`);

  const report = {
    generatedAt: new Date().toISOString(),
    summary: {
      totalProducts,
      totalFailed: failedProducts.length,
      totalApplied: applied,
      elapsedMinutes: parseFloat(((Date.now() - startTime) / 1000 / 60).toFixed(1)),
    },
    // Variant IDs for easy re-running
    failedVariantIds: failedProducts.map(f => f.variantId),
    // Full details
    failedProducts,
  };

  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  log(`Failed products report saved: ${reportPath}`);
  log(`  ${failedProducts.length} failed products can be re-run with:`);
  log(`  npx tsx --tsconfig tsconfig.scripts.json scripts/batch-analyze.ts --failed-report ${reportPath}`);

  return reportPath;
}

// ---------------------------------------------------------------------------
// Load failed products from a previous report for re-running
// ---------------------------------------------------------------------------
function loadFailedReport(reportPath: string): { productId: string; variantId: string }[] {
  const raw = fs.readFileSync(reportPath, 'utf8');
  const report = JSON.parse(raw);
  return (report.failedProducts || []).map((f: FailedProduct) => ({
    productId: f.productId,
    variantId: f.variantId,
  }));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const opts = parseArgs();
  globalStartTime = Date.now();

  console.log('\n' + '='.repeat(70));
  console.log('  Oil Slick Pad — Batch Price Analyzer (Volume-Aware)');
  console.log('='.repeat(70));
  console.log(`  Vendor filter:  ${opts.vendor || 'ALL'}`);
  console.log(`  Status filter:  ${opts.status}`);
  console.log(`  Concurrency:    ${opts.concurrency} workers`);
  console.log(`  Dry run:        ${opts.dryRun}`);
  console.log(`  Skip apply:     ${opts.skipApply}`);
  console.log(`  Skip analyzed:  ${opts.skipAnalyzed}`);
  console.log(`  Fast mode:      ${opts.fast ? 'YES (cheap models, no reflection/deliberation)' : 'no'}`);
  console.log(`  Search mode:    ${opts.searchMode}`);
  console.log(`  AI Provider:    ${opts.provider.toUpperCase()}`);
  console.log(`  Limit:          ${opts.limit || 'none'}`);
  console.log(`  Failed report:  ${opts.failedReport || 'none'}`);
  console.log(`  Markup:         ${opts.markup ? `${opts.markup}x cost (skip AI)` : 'none (use AI)'}`);
  console.log(`  Volume pricing: ENABLED (qty variants auto-derived from base)`);
  console.log('='.repeat(70) + '\n');

  // Validate env vars
  const requiredEnv = [
    'NEXT_PUBLIC_SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'SHOPIFY_STORE_NAME',
    'SHOPIFY_ACCESS_TOKEN',
  ];
  // Only require API keys when NOT using pure markup mode
  if (!opts.markup) {
    if (opts.provider === 'claude') {
      requiredEnv.push('ANTHROPIC_API_KEY');
    } else {
      requiredEnv.push('OPENAI_API_KEY');
    }
  }
  // Only require BRAVE_API_KEY when using brave search mode
  if (opts.searchMode === 'brave') {
    requiredEnv.push('BRAVE_API_KEY');
  }
  const missing = requiredEnv.filter(k => !process.env[k]);
  if (missing.length > 0) {
    logError(`Missing environment variables: ${missing.join(', ')}`);
    process.exit(1);
  }

  // Connect to Supabase
  const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  // Load settings
  const { data: settingsRow, error: settingsErr } = await db
    .from('settings')
    .select('*')
    .single();

  if (settingsErr) {
    logError(`Failed to load settings: ${settingsErr.message}`);
    process.exit(1);
  }

  const settings = settingsRow as Settings;
  // Force AI unlimited mode for GitHub Actions batch
  settings.ai_unrestricted = true;
  log('AI Unrestricted Mode: ENABLED');

  // ---------------------------------------------------------------------------
  // Determine which variants to process
  // ---------------------------------------------------------------------------
  let toProcess: { product: Product; variant: Variant }[] = [];

  if (opts.failedReport) {
    // Re-run mode: load failed products from report
    log(`Loading failed products from report: ${opts.failedReport}`);
    const failedEntries = loadFailedReport(opts.failedReport);
    log(`Found ${failedEntries.length} failed products to retry`);

    // Load the specific products and variants from DB
    const variantIds = failedEntries.map(f => f.variantId);
    const productIds = [...new Set(failedEntries.map(f => f.productId))];

    const { data: products } = await db
      .from('products')
      .select('*, variants(*)')
      .in('id', productIds);

    if (products) {
      const variantIdSet = new Set(variantIds);
      for (const product of products as Product[]) {
        if (!product.variants) continue;
        for (const variant of product.variants) {
          if (variantIdSet.has(variant.id)) {
            toProcess.push({ product, variant });
          }
        }
      }
    }

    log(`Loaded ${toProcess.length} variants for retry`);
  } else {
    // Normal mode: query products + variants
    log('Loading products from database...');

    let query = db
      .from('products')
      .select('*, variants(*)')
      .order('title');

    if (opts.vendor) {
      query = query.ilike('vendor', opts.vendor);
    }
    if (opts.status !== 'all') {
      query = query.eq('status', opts.status);
    }

    // Supabase default limit is 1000, paginate if needed
    const allProducts: Product[] = [];
    let page = 0;
    const pageSize = 500;

    while (true) {
      const { data, error } = await query.range(page * pageSize, (page + 1) * pageSize - 1);
      if (error) {
        logError(`Failed to load products: ${error.message}`);
        process.exit(1);
      }
      if (!data || data.length === 0) break;
      allProducts.push(...(data as Product[]));
      if (data.length < pageSize) break;
      page++;
    }

    // Flatten to variant list
    const variantList: { product: Product; variant: Variant }[] = [];
    for (const product of allProducts) {
      if (!product.variants || product.variants.length === 0) continue;
      for (const variant of product.variants) {
        variantList.push({ product, variant });
      }
    }

    // Apply limit if set
    toProcess = opts.limit > 0 ? variantList.slice(0, opts.limit) : variantList;

    log(`Found ${allProducts.length} products, ${variantList.length} variants total`);
  }

  // ---------------------------------------------------------------------------
  // Skip already-analyzed variants (query analyses table for successful ones)
  // ---------------------------------------------------------------------------
  if (opts.skipAnalyzed && toProcess.length > 0) {
    log('Checking for already-analyzed variants...');

    // Query all successful analyses (no error, has a suggested price)
    const analyzedVariantIds = new Set<string>();
    let aPage = 0;
    const aPageSize = 1000;

    while (true) {
      const { data: analyses, error: aErr } = await db
        .from('analyses')
        .select('variant_id')
        .not('suggested_price', 'is', null)
        .is('error', null)
        .range(aPage * aPageSize, (aPage + 1) * aPageSize - 1);

      if (aErr) {
        logError(`Failed to query analyses: ${aErr.message}`);
        break;
      }
      if (!analyses || analyses.length === 0) break;

      for (const a of analyses) {
        analyzedVariantIds.add(a.variant_id);
      }

      if (analyses.length < aPageSize) break;
      aPage++;
    }

    const beforeCount = toProcess.length;
    toProcess = toProcess.filter(({ variant }) => !analyzedVariantIds.has(variant.id));
    const skipped = beforeCount - toProcess.length;

    log(`Skipped ${skipped} already-analyzed variants (${analyzedVariantIds.size} total in DB)`);
    log(`Remaining: ${toProcess.length} variants to process`);
  }

  log(`Processing ${toProcess.length} variants with ${opts.concurrency} concurrent workers\n`);

  if (toProcess.length === 0) {
    log('Nothing to process. Exiting.');
    process.exit(0);
  }

  // ---------------------------------------------------------------------------
  // Group variants by product for volume-aware processing
  // ---------------------------------------------------------------------------
  const productGroups = new Map<string, { product: Product; variants: Variant[] }>();
  for (const { product, variant } of toProcess) {
    const existing = productGroups.get(product.id);
    if (existing) {
      existing.variants.push(variant);
    } else {
      productGroups.set(product.id, { product, variants: [variant] });
    }
  }

  log(`Grouped into ${productGroups.size} products for volume-aware processing`);

  // Log to activity_log
  await db.from('activity_log').insert({
    message: `Batch started: ${toProcess.length} variants (${productGroups.size} products), ${opts.concurrency} workers, ${opts.provider.toUpperCase()}${opts.fast ? ' FAST' : ''}${opts.vendor ? ` (vendor: ${opts.vendor})` : ''}${opts.failedReport ? ' (retry mode)' : ''}${opts.skipAnalyzed ? ' (skip-analyzed)' : ''}${opts.markup ? ` (${opts.markup}x markup)` : ''}, volume-pricing ENABLED, auto-apply${opts.dryRun ? ' (DRY RUN)' : ''}`,
    type: 'info',
  });

  // ---------------------------------------------------------------------------
  // Process all products with streaming worker pool
  // ---------------------------------------------------------------------------
  let completed = 0;
  let failed = 0;
  let applied = 0;
  let volumeDerived = 0;
  let fatalError: string | null = null;
  let activeWorkers = 0;
  const failedProducts: FailedProduct[] = [];
  const progressInterval = Math.max(1, Math.floor(toProcess.length / 20)); // Report ~20 times

  // Create tasks per product group (not per variant) for volume-aware processing
  const productEntries = [...productGroups.values()];

  const tasks = productEntries.map(({ product, variants: variantsToProcess }) => async () => {
    if (fatalError) {
      return variantsToProcess.map(v => ({
        variantId: v.id,
        success: false,
        applied: false,
        price: null,
        error: 'Skipped (fatal error)',
        pricingMethod: 'ai' as const,
      }));
    }

    activeWorkers++;

    let taskResults: Array<{ variantId: string; success: boolean; applied: boolean; price: number | null; error: string | null; pricingMethod: 'ai' | 'volume_formula' }>;

    if (opts.markup) {
      // Markup mode: process each variant individually (no volume logic)
      taskResults = [];
      for (const variant of variantsToProcess) {
        const r = await processVariantMarkup(product, variant, opts.markup!, db, {
          dryRun: opts.dryRun,
          skipApply: opts.skipApply,
        });
        taskResults.push({ variantId: variant.id, ...r, pricingMethod: 'ai' });
      }
    } else {
      // AI mode: use volume-aware analysis
      // Need all product variants (not just the ones to process) for quantity detection
      const allProductVariants = product.variants || variantsToProcess;
      const { results } = await processProductVolumeAware(
        product, allProductVariants, variantsToProcess, settings, db, {
          dryRun: opts.dryRun,
          skipApply: opts.skipApply,
          searchMode: opts.searchMode,
          provider: opts.provider,
          fast: opts.fast,
        },
      );
      taskResults = results;
    }

    activeWorkers--;

    // Update counters
    for (const r of taskResults) {
      if (r.success) {
        completed++;
        if (r.pricingMethod === 'volume_formula') volumeDerived++;
      } else {
        failed++;
        const variant = variantsToProcess.find(v => v.id === r.variantId);
        failedProducts.push({
          productId: product.id,
          variantId: r.variantId,
          productTitle: product.title,
          variantTitle: variant?.title || 'Default',
          error: r.error || 'Unknown error',
          timestamp: new Date().toISOString(),
        });
      }
      if (r.applied) applied++;

      // Check for fatal errors
      if (r.error && isFatal(r.error)) {
        fatalError = r.error;
        logError(`FATAL: ${fatalError}`);
      }
    }

    // Periodic progress reporting
    const total = completed + failed;
    if (total % progressInterval === 0 || total === toProcess.length) {
      logProgress(total, toProcess.length, failed, applied, activeWorkers);
    }

    return taskResults;
  });

  await runPool(tasks, opts.concurrency, () => !!fatalError);

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------
  const elapsed = ((Date.now() - globalStartTime) / 1000 / 60).toFixed(1);
  const rate = (completed + failed) > 0
    ? ((completed + failed) / ((Date.now() - globalStartTime) / 1000 / 60)).toFixed(1)
    : '0';

  console.log('\n' + '='.repeat(70));
  console.log('  BATCH COMPLETE');
  console.log('='.repeat(70));
  console.log(`  Total:       ${toProcess.length}`);
  console.log(`  Completed:   ${completed}`);
  console.log(`  Failed:      ${failed}`);
  console.log(`  Applied:     ${applied}`);
  console.log(`  Vol. Derived:${volumeDerived} (formula-priced, no AI calls)`);
  console.log(`  Concurrency: ${opts.concurrency} workers`);
  console.log(`  Rate:        ${rate} products/min`);
  console.log(`  Elapsed:     ${elapsed} minutes`);
  if (fatalError) {
    console.log(`  FATAL:       ${fatalError}`);
  }
  console.log('='.repeat(70) + '\n');

  // Save failed products report if there were failures
  let reportPath: string | null = null;
  if (failedProducts.length > 0) {
    reportPath = saveFailedReport(failedProducts, globalStartTime, toProcess.length, applied);
  } else {
    log('No failed products — all variants processed successfully!');
  }

  // Log final result to activity_log
  await db.from('activity_log').insert({
    message: `Batch finished: ${completed} analyzed (${volumeDerived} volume-derived), ${failed} failed, ${applied} applied in ${elapsed}min (${rate}/min, ${opts.concurrency} workers)${fatalError ? ` (FATAL: ${fatalError})` : ''}${reportPath ? ` — failed report: ${path.basename(reportPath)}` : ''}`,
    type: fatalError ? 'error' : 'success',
  });

  // Exit with error code if fatal
  if (fatalError) {
    process.exit(1);
  }

  process.exit(0);
}

main().catch(e => {
  logError(`Unhandled error: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
