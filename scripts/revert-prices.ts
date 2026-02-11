#!/usr/bin/env npx tsx --tsconfig tsconfig.scripts.json
// =============================================================================
// Revert Prices — restore prices from before batch runs
//
// TWO MODES:
//
// 1. DATABASE MODE (recommended) — uses previous_price stored in analyses table:
//   npx tsx --tsconfig tsconfig.scripts.json scripts/revert-prices.ts \
//     --since "2026-02-10" --dry-run
//
// 2. LOG FILE MODE — parses local log files with APPLIED lines:
//   npx tsx --tsconfig tsconfig.scripts.json scripts/revert-prices.ts \
//     --log-file logs/run1.txt --dry-run
//
// Always start with --dry-run to preview what will be reverted!
//
// Environment variables required:
//   SHOPIFY_STORE_NAME, SHOPIFY_ACCESS_TOKEN,
//   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// =============================================================================

import { createClient } from '@supabase/supabase-js';
import { updateVariantPrice } from '@/lib/shopify';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface PriceRevert {
  variantId: string;
  productTitle: string;
  variantTitle: string;
  oldPrice: number;
  currentPrice: number;
  source: string;
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------
function parseArgs(): {
  since: string | null;
  logFiles: string[];
  dryRun: boolean;
} {
  const args = process.argv.slice(2);
  const get = (flag: string): string | null => {
    const idx = args.indexOf(flag);
    return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : null;
  };
  const has = (flag: string): boolean => args.includes(flag);
  const getAll = (flag: string): string[] => {
    const results: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === flag && i + 1 < args.length) {
        results.push(args[i + 1]);
      }
    }
    return results;
  };

  return {
    since: get('--since'),
    logFiles: getAll('--log-file'),
    dryRun: has('--dry-run'),
  };
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
// DATABASE MODE — query analyses with previous_price
// ---------------------------------------------------------------------------
async function getRevertFromDatabase(
  db: ReturnType<typeof createClient>,
  since: string,
): Promise<PriceRevert[]> {
  log(`Querying analyses applied since ${since} with stored previous_price...`);

  const { data: analyses, error } = await db
    .from('analyses')
    .select('variant_id, previous_price, suggested_price, applied_at, product_id')
    .eq('applied', true)
    .not('previous_price', 'is', null)
    .gte('applied_at', since);

  if (error) {
    throw new Error(`Database query failed: ${error.message}`);
  }

  if (!analyses || analyses.length === 0) {
    log('No analyses found with stored previous_price since that date.');
    return [];
  }

  log(`Found ${analyses.length} analyses with previous_price in database.`);

  // Load product and variant info for display
  const variantIds = analyses.map(a => a.variant_id);
  const productIds = [...new Set(analyses.map(a => a.product_id))];

  const [{ data: variants }, { data: products }] = await Promise.all([
    db.from('variants').select('id, title, price').in('id', variantIds),
    db.from('products').select('id, title').in('id', productIds),
  ]);

  const variantMap = new Map((variants || []).map(v => [v.id, v]));
  const productMap = new Map((products || []).map(p => [p.id, p]));

  return analyses.map(a => ({
    variantId: a.variant_id,
    productTitle: productMap.get(a.product_id)?.title || 'Unknown',
    variantTitle: variantMap.get(a.variant_id)?.title || 'Default',
    oldPrice: a.previous_price,
    currentPrice: variantMap.get(a.variant_id)?.price || a.suggested_price,
    source: `db (applied_at: ${a.applied_at})`,
  }));
}

// ---------------------------------------------------------------------------
// LOG FILE MODE — parse local log files
// New format: APPLIED (variant_id): $old -> $new
// Old format: APPLIED: $old -> $new (needs context from Analyzing: line)
// ---------------------------------------------------------------------------
function parseLogContent(logContent: string, source: string): PriceRevert[] {
  const reverts: PriceRevert[] = [];
  const lines = logContent.split('\n');

  // Track context from "Analyzing:" lines for old format
  let currentVariantId: string | null = null;
  let currentProductTitle: string | null = null;
  let currentVariantTitle: string | null = null;

  for (const line of lines) {
    // Match "Analyzing: Product Title / Variant Title (variant-id)"
    const analyzeMatch = line.match(/Analyzing:\s+(.+?)\s+\/\s+(.*?)\s+\((\d+)\)/);
    if (analyzeMatch) {
      currentProductTitle = analyzeMatch[1].trim();
      currentVariantTitle = analyzeMatch[2].trim() || 'Default';
      currentVariantId = analyzeMatch[3];
      continue;
    }

    // Match "Markup: Product / Variant (id)" lines
    const markupMatch = line.match(/Markup:\s+(.+?)\s+\/\s+(.*?)\s+\((\d+)\)/);
    if (markupMatch) {
      currentProductTitle = markupMatch[1].trim();
      currentVariantTitle = markupMatch[2].trim() || 'Default';
      currentVariantId = markupMatch[3];
      continue;
    }

    // NEW FORMAT: "APPLIED (variant_id): $old -> $new"
    const newFormatMatch = line.match(/APPLIED\s+\((\d+)\):\s+\$(\d+\.?\d*)\s*->\s*\$(\d+\.?\d*)/);
    if (newFormatMatch) {
      reverts.push({
        variantId: newFormatMatch[1],
        productTitle: currentProductTitle || 'Unknown',
        variantTitle: currentVariantTitle || 'Default',
        oldPrice: parseFloat(newFormatMatch[2]),
        currentPrice: parseFloat(newFormatMatch[3]),
        source,
      });
      currentVariantId = null;
      currentProductTitle = null;
      currentVariantTitle = null;
      continue;
    }

    // OLD FORMAT: "APPLIED: $old -> $new" (relies on preceding Analyzing: line)
    const oldFormatMatch = line.match(/APPLIED:\s+\$(\d+\.?\d*)\s*->\s*\$(\d+\.?\d*)/);
    if (oldFormatMatch && currentVariantId) {
      reverts.push({
        variantId: currentVariantId,
        productTitle: currentProductTitle || 'Unknown',
        variantTitle: currentVariantTitle || 'Default',
        oldPrice: parseFloat(oldFormatMatch[1]),
        currentPrice: parseFloat(oldFormatMatch[2]),
        source,
      });
      currentVariantId = null;
      currentProductTitle = null;
      currentVariantTitle = null;
    }
  }

  return reverts;
}

// ---------------------------------------------------------------------------
// Deduplicate — if a variant appears multiple times, keep the earliest old price
// ---------------------------------------------------------------------------
function deduplicateReverts(reverts: PriceRevert[]): PriceRevert[] {
  const variantMap = new Map<string, PriceRevert>();
  for (const revert of reverts) {
    // Later entries overwrite — they're from earlier runs with more original prices
    variantMap.set(revert.variantId, revert);
  }
  return Array.from(variantMap.values());
}

// ---------------------------------------------------------------------------
// Apply reverts
// ---------------------------------------------------------------------------
async function applyReverts(
  reverts: PriceRevert[],
  db: ReturnType<typeof createClient>,
  dryRun: boolean,
): Promise<{ success: number; failed: number }> {
  let success = 0;
  let failed = 0;

  for (let i = 0; i < reverts.length; i++) {
    const r = reverts[i];
    const label = `${r.productTitle} / ${r.variantTitle} (${r.variantId})`;
    const progress = `[${i + 1}/${reverts.length}]`;

    if (r.oldPrice === r.currentPrice) {
      log(`${progress} SKIP (already at old price): ${label} — $${r.oldPrice.toFixed(2)}`);
      success++;
      continue;
    }

    if (dryRun) {
      log(`${progress} DRY RUN: ${label} — $${r.currentPrice.toFixed(2)} -> $${r.oldPrice.toFixed(2)}`);
      success++;
      continue;
    }

    try {
      // Update Shopify
      await updateVariantPrice(r.variantId, r.oldPrice);

      // Update Supabase variants table
      await db.from('variants').update({ price: r.oldPrice }).eq('id', r.variantId);

      // Mark analysis as unapplied so it can be re-done
      await db
        .from('analyses')
        .update({ applied: false, applied_at: null, previous_price: null })
        .eq('variant_id', r.variantId);

      log(`${progress} REVERTED: ${label} — $${r.currentPrice.toFixed(2)} -> $${r.oldPrice.toFixed(2)}`);
      success++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown error';
      logError(`${progress} Failed to revert ${label}: ${msg}`);
      failed++;
    }
  }

  return { success, failed };
}

// ---------------------------------------------------------------------------
// Save revert report
// ---------------------------------------------------------------------------
function saveRevertReport(reverts: PriceRevert[], result: { success: number; failed: number }, dryRun: boolean) {
  const reportsDir = path.join(process.cwd(), 'reports');
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
  }

  const dateStr = new Date().toISOString().slice(0, 10);
  const timeStr = new Date().toISOString().slice(11, 19).replace(/:/g, '-');
  const prefix = dryRun ? 'revert-preview' : 'revert-applied';
  const reportPath = path.join(reportsDir, `${prefix}-${dateStr}-${timeStr}.json`);

  const report = {
    generatedAt: new Date().toISOString(),
    dryRun,
    summary: {
      totalVariants: reverts.length,
      success: result.success,
      failed: result.failed,
    },
    reverts: reverts.map(r => ({
      variantId: r.variantId,
      productTitle: r.productTitle,
      variantTitle: r.variantTitle,
      revertedFrom: r.currentPrice,
      revertedTo: r.oldPrice,
      source: r.source,
    })),
  };

  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  log(`Revert report saved: ${reportPath}`);
  return reportPath;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const opts = parseArgs();

  console.log('\n' + '='.repeat(70));
  console.log('  Oil Slick Pad — Price Revert Tool');
  console.log('='.repeat(70));
  console.log(`  Mode:       ${opts.since ? `Database (since ${opts.since})` : 'Log files'}`);
  console.log(`  Log files:  ${opts.logFiles.length > 0 ? opts.logFiles.join(', ') : 'none'}`);
  console.log(`  Dry run:    ${opts.dryRun}`);
  console.log('='.repeat(70) + '\n');

  if (!opts.since && opts.logFiles.length === 0) {
    console.error('ERROR: Specify either --since DATE (to revert from database) or --log-file path (for local log files)');
    console.error('');
    console.error('Examples:');
    console.error('  # Revert all prices applied since Feb 10 (uses previous_price stored in DB):');
    console.error('  npx tsx --tsconfig tsconfig.scripts.json scripts/revert-prices.ts --since "2026-02-10" --dry-run');
    console.error('');
    console.error('  # Revert using downloaded log files:');
    console.error('  npx tsx --tsconfig tsconfig.scripts.json scripts/revert-prices.ts --log-file run-log.txt --dry-run');
    process.exit(1);
  }

  // Validate env vars
  const requiredEnv = [
    'NEXT_PUBLIC_SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'SHOPIFY_STORE_NAME',
    'SHOPIFY_ACCESS_TOKEN',
  ];
  for (const key of requiredEnv) {
    if (!process.env[key]) {
      console.error(`ERROR: Missing required env var: ${key}`);
      process.exit(1);
    }
  }

  // Initialize Supabase
  const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  let allReverts: PriceRevert[] = [];

  // DATABASE MODE
  if (opts.since) {
    const dbReverts = await getRevertFromDatabase(db, opts.since);
    allReverts.push(...dbReverts);
  }

  // LOG FILE MODE
  for (const logFile of opts.logFiles) {
    if (!fs.existsSync(logFile)) {
      logError(`Log file not found: ${logFile}`);
      continue;
    }
    const content = fs.readFileSync(logFile, 'utf8');
    const reverts = parseLogContent(content, `file:${path.basename(logFile)}`);
    log(`Found ${reverts.length} applied price changes in ${logFile}`);
    allReverts.push(...reverts);
  }

  if (allReverts.length === 0) {
    log('No price changes found. Nothing to revert.');
    if (opts.since) {
      log('Note: --since mode requires that previous_price was stored when prices were applied.');
      log('If the batch run predates this feature, use --log-file mode with downloaded GitHub Actions logs instead.');
    }
    return;
  }

  log(`\nTotal price changes found: ${allReverts.length}`);

  // Deduplicate
  const deduplicated = deduplicateReverts(allReverts);
  log(`Unique variants to revert: ${deduplicated.length}`);

  if (deduplicated.length !== allReverts.length) {
    log(`  (${allReverts.length - deduplicated.length} duplicates removed)`);
  }

  console.log('\n' + '-'.repeat(70));
  log(opts.dryRun ? 'DRY RUN — showing what would be reverted:' : 'Applying price reverts...');
  console.log('-'.repeat(70) + '\n');

  const result = await applyReverts(deduplicated, db, opts.dryRun);

  // Summary
  console.log('\n' + '='.repeat(70));
  console.log(`  Revert ${opts.dryRun ? 'Preview' : 'Complete'}`);
  console.log(`  Success: ${result.success} | Failed: ${result.failed}`);
  console.log('='.repeat(70) + '\n');

  // Save report
  saveRevertReport(deduplicated, result, opts.dryRun);

  if (opts.dryRun && result.success > 0) {
    log('To actually apply the reverts, run again without --dry-run');
  }

  // Log to activity_log
  if (!opts.dryRun && result.success > 0) {
    await db.from('activity_log').insert({
      message: `Price revert: ${result.success} variants reverted to previous prices (${result.failed} failed)`,
      type: 'info',
    });
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
