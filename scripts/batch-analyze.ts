#!/usr/bin/env npx tsx --tsconfig tsconfig.scripts.json
// =============================================================================
// Standalone Batch Price Analyzer — runs outside Vercel (no 300s timeout)
// Designed for GitHub Actions but can run locally too.
//
// Usage:
//   npx tsx --tsconfig tsconfig.scripts.json scripts/batch-analyze.ts \
//     --vendor "Artist Name" --status active --concurrency 2
//
// Environment variables required:
//   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
//   OPENAI_API_KEY, BRAVE_API_KEY,
//   SHOPIFY_STORE_NAME, SHOPIFY_ACCESS_TOKEN
// =============================================================================

import { createClient } from '@supabase/supabase-js';
import { runFullAnalysis, saveAnalysis, type SearchMode } from '@/lib/pricing-engine';
import { updateVariantPrice } from '@/lib/shopify';
import type { Product, Variant, Settings } from '@/types';

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------
function parseArgs(): {
  vendor: string | null;
  status: string;
  concurrency: number;
  dryRun: boolean;
  skipApply: boolean;
  limit: number;
  searchMode: SearchMode;
} {
  const args = process.argv.slice(2);
  const get = (flag: string): string | null => {
    const idx = args.indexOf(flag);
    return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : null;
  };
  const has = (flag: string): boolean => args.includes(flag);

  const rawSearch = get('--search-mode') || 'openai';
  const searchMode: SearchMode = rawSearch === 'brave' ? 'brave' : rawSearch === 'none' ? 'none' : 'openai';

  return {
    vendor: get('--vendor'),
    status: get('--status') || 'active',
    concurrency: parseInt(get('--concurrency') || '2', 10),
    dryRun: has('--dry-run'),
    skipApply: has('--skip-apply'),
    limit: parseInt(get('--limit') || '0', 10),
    searchMode,
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

function logProgress(done: number, total: number, failed: number, applied: number) {
  const pct = ((done / total) * 100).toFixed(1);
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  Progress: ${done}/${total} (${pct}%) | Failed: ${failed} | Applied: ${applied}`);
  console.log(`${'='.repeat(60)}\n`);
}

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
// Process a single variant
// ---------------------------------------------------------------------------
async function processVariant(
  product: Product,
  variant: Variant,
  settings: Settings,
  db: ReturnType<typeof createClient>,
  opts: { dryRun: boolean; skipApply: boolean; searchMode: SearchMode },
): Promise<{ success: boolean; applied: boolean; price: number | null; error: string | null }> {
  const label = `${product.title} / ${variant.title || 'Default'} (${variant.id})`;

  try {
    log(`Analyzing: ${label}`);
    const result = await runFullAnalysis(product, variant, settings, (step) => {
      log(`  ${step}`);
    }, opts.searchMode);

    if (result.error) {
      logError(`Analysis failed for ${label}: ${result.error}`);
      return { success: false, applied: false, price: null, error: result.error };
    }

    // Save analysis to DB
    await saveAnalysis(product.id, variant.id, result);

    const price = result.suggestedPrice;
    log(`  Suggested: $${price?.toFixed(2) || 'none'} (confidence: ${result.confidence}, deliberated: ${result.wasDeliberated})`);

    // Auto-apply
    if (price && price > 0 && !opts.dryRun && !opts.skipApply) {
      try {
        await updateVariantPrice(variant.id, price);
        // Update local DB too
        await db.from('variants').update({ price }).eq('id', variant.id);
        await db
          .from('analyses')
          .update({ applied: true, applied_at: new Date().toISOString() })
          .match({ product_id: product.id, variant_id: variant.id });

        log(`  APPLIED: $${variant.price.toFixed(2)} -> $${price.toFixed(2)}`);
        return { success: true, applied: true, price, error: null };
      } catch (applyErr) {
        const msg = applyErr instanceof Error ? applyErr.message : 'Apply failed';
        logError(`  Apply failed: ${msg}`);
        return { success: true, applied: false, price, error: `Apply failed: ${msg}` };
      }
    }

    if (opts.dryRun) {
      log(`  DRY RUN: Would apply $${price?.toFixed(2)}`);
    }

    return { success: true, applied: false, price, error: null };
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    logError(`${label}: ${msg}`);
    return { success: false, applied: false, price: null, error: msg };
  }
}

// ---------------------------------------------------------------------------
// Worker pool — process N variants concurrently
// ---------------------------------------------------------------------------
async function runPool<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let nextIdx = 0;

  async function worker() {
    while (nextIdx < tasks.length) {
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
// Main
// ---------------------------------------------------------------------------
async function main() {
  const opts = parseArgs();

  console.log('\n' + '='.repeat(60));
  console.log('  Oil Slick Pad — Batch Price Analyzer');
  console.log('='.repeat(60));
  console.log(`  Vendor filter: ${opts.vendor || 'ALL'}`);
  console.log(`  Status filter: ${opts.status}`);
  console.log(`  Concurrency:   ${opts.concurrency}`);
  console.log(`  Dry run:       ${opts.dryRun}`);
  console.log(`  Skip apply:    ${opts.skipApply}`);
  console.log(`  Search mode:   ${opts.searchMode}`);
  console.log(`  Limit:         ${opts.limit || 'none'}`);
  console.log('='.repeat(60) + '\n');

  // Validate env vars
  const requiredEnv = [
    'NEXT_PUBLIC_SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'OPENAI_API_KEY',
    'SHOPIFY_STORE_NAME',
    'SHOPIFY_ACCESS_TOKEN',
  ];
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

  // Query products + variants
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
  const toProcess = opts.limit > 0 ? variantList.slice(0, opts.limit) : variantList;

  log(`Found ${allProducts.length} products, ${variantList.length} variants total`);
  log(`Processing ${toProcess.length} variants\n`);

  if (toProcess.length === 0) {
    log('Nothing to process. Exiting.');
    process.exit(0);
  }

  // Log to activity_log
  await db.from('activity_log').insert({
    message: `GitHub Actions batch started: ${toProcess.length} variants${opts.vendor ? ` (vendor: ${opts.vendor})` : ''}, AI unlimited, auto-apply${opts.dryRun ? ' (DRY RUN)' : ''}`,
    type: 'info',
  });

  // Process in small batches with concurrency
  let completed = 0;
  let failed = 0;
  let applied = 0;
  let fatalError: string | null = null;
  const batchSize = Math.max(opts.concurrency * 2, 4);
  const startTime = Date.now();

  for (let i = 0; i < toProcess.length; i += batchSize) {
    if (fatalError) {
      log(`FATAL ERROR detected — skipping remaining variants`);
      break;
    }

    const batch = toProcess.slice(i, i + batchSize);
    const tasks = batch.map(({ product, variant }) => () =>
      processVariant(product, variant, settings, db, {
        dryRun: opts.dryRun,
        skipApply: opts.skipApply,
        searchMode: opts.searchMode,
      }),
    );

    const results = await runPool(tasks, opts.concurrency);

    for (const result of results) {
      if (result.success) {
        completed++;
      } else {
        failed++;
        if (result.error && isFatal(result.error)) {
          fatalError = result.error;
          logError(`FATAL: ${fatalError}`);
        }
      }
      if (result.applied) applied++;
    }

    logProgress(completed + failed, toProcess.length, failed, applied);

    // Brief pause between batches to let rate limiters breathe
    if (i + batchSize < toProcess.length && !fatalError) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  // Summary
  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log('\n' + '='.repeat(60));
  console.log('  BATCH COMPLETE');
  console.log('='.repeat(60));
  console.log(`  Total:     ${toProcess.length}`);
  console.log(`  Completed: ${completed}`);
  console.log(`  Failed:    ${failed}`);
  console.log(`  Applied:   ${applied}`);
  console.log(`  Elapsed:   ${elapsed} minutes`);
  if (fatalError) {
    console.log(`  FATAL:     ${fatalError}`);
  }
  console.log('='.repeat(60) + '\n');

  // Log final result to activity_log
  await db.from('activity_log').insert({
    message: `GitHub Actions batch finished: ${completed} analyzed, ${failed} failed, ${applied} applied in ${elapsed}min${fatalError ? ` (FATAL: ${fatalError})` : ''}`,
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
