#!/usr/bin/env npx tsx --tsconfig tsconfig.scripts.json
// =============================================================================
// Revert Prices — restore prices from before batch runs
//
// THREE MODES:
//
// 1. GITHUB RUNS MODE — downloads logs from recent GitHub Actions runs:
//   GITHUB_TOKEN=ghp_xxx npx tsx --tsconfig tsconfig.scripts.json scripts/revert-prices.ts \
//     --runs 3 --dry-run
//
// 2. DATABASE MODE — uses previous_price stored in analyses table (future runs only):
//   npx tsx --tsconfig tsconfig.scripts.json scripts/revert-prices.ts \
//     --since "2026-02-10" --dry-run
//
// 3. LOG FILE MODE — parses local log files with APPLIED lines:
//   npx tsx --tsconfig tsconfig.scripts.json scripts/revert-prices.ts \
//     --log-file logs/run1.txt --dry-run
//
// Always start with --dry-run to preview what will be reverted!
//
// Environment variables required:
//   SHOPIFY_STORE_NAME, SHOPIFY_ACCESS_TOKEN,
//   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   GITHUB_TOKEN (only when using --runs)
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
  runs: number;
  since: string | null;
  logFiles: string[];
  dryRun: boolean;
  repo: string;
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
    runs: parseInt(get('--runs') || '0', 10),
    since: get('--since'),
    logFiles: getAll('--log-file'),
    dryRun: has('--dry-run'),
    repo: get('--repo') || 'Yoshi420247/Claude-Shopify-Pricing-app-1',
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
// GitHub Actions log download
// ---------------------------------------------------------------------------
async function getRecentRunIds(repo: string, count: number, token: string): Promise<{ id: string; createdAt: string }[]> {
  const url = `https://api.github.com/repos/${repo}/actions/workflows/batch-analyze.yml/runs?per_page=${count}&status=completed`;
  log(`Fetching last ${count} completed batch-analyze runs...`);

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch workflow runs: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  const runs = data.workflow_runs || [];
  return runs.map((r: { id: number; created_at: string; conclusion: string }) => {
    log(`  Run #${r.id} — ${r.created_at} (${r.conclusion})`);
    return { id: String(r.id), createdAt: r.created_at };
  });
}

async function downloadRunLogs(repo: string, runId: string, token: string): Promise<string> {
  const url = `https://api.github.com/repos/${repo}/actions/runs/${runId}/logs`;
  log(`Downloading logs for run ${runId}...`);

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
  });

  if (!response.ok) {
    throw new Error(`Failed to download logs for run ${runId}: ${response.status} ${response.statusText}`);
  }

  // GitHub returns a zip file
  const arrayBuffer = await response.arrayBuffer();
  const zipPath = `/tmp/gh-run-${runId}.zip`;
  const extractDir = `/tmp/gh-run-${runId}`;

  fs.writeFileSync(zipPath, Buffer.from(arrayBuffer));

  const { execSync } = await import('child_process');
  try {
    execSync(`rm -rf ${extractDir} && mkdir -p ${extractDir} && unzip -o ${zipPath} -d ${extractDir}`, { stdio: 'pipe' });
  } catch {
    throw new Error(`Failed to extract logs zip for run ${runId}`);
  }

  // Concatenate all log files
  const logFiles = fs.readdirSync(extractDir).filter(f => f.endsWith('.txt'));
  let allLogs = '';
  for (const file of logFiles) {
    allLogs += fs.readFileSync(path.join(extractDir, file), 'utf8') + '\n';
  }

  // Cleanup
  try {
    fs.unlinkSync(zipPath);
    fs.rmSync(extractDir, { recursive: true });
  } catch { /* ignore */ }

  return allLogs;
}

// ---------------------------------------------------------------------------
// DATABASE MODE — query analyses with previous_price
// ---------------------------------------------------------------------------
async function getRevertFromDatabase(
  db: ReturnType<typeof createClient>,
  since: string,
): Promise<PriceRevert[]> {
  log(`Querying analyses applied since ${since} with stored previous_price...`);

  // Try querying with previous_price — column may not exist yet
  const { data: analyses, error } = await db
    .from('analyses')
    .select('variant_id, previous_price, suggested_price, applied_at, product_id')
    .eq('applied', true)
    .not('previous_price', 'is', null)
    .gte('applied_at', since);

  if (error) {
    if (error.message.includes('previous_price') && error.message.includes('does not exist')) {
      log('WARNING: previous_price column does not exist yet.');
      log('Run this SQL in Supabase: ALTER TABLE analyses ADD COLUMN IF NOT EXISTS previous_price NUMERIC;');
      log('For now, use --runs mode to download and parse GitHub Actions logs instead.');
      return [];
    }
    throw new Error(`Database query failed: ${error.message}`);
  }

  if (!analyses || analyses.length === 0) {
    log('No analyses found with stored previous_price since that date.');
    log('If the batch runs happened before this feature was deployed, use --runs mode instead.');
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
// LOG PARSING — handles both old and new APPLIED formats
//
// With 100 concurrent workers, log lines are interleaved. Strategy:
//
// NEW FORMAT (reliable): "APPLIED (variant_id): $old -> $new"
//   → variant_id is in the line itself, no context needed
//
// OLD FORMAT (needs matching): "APPLIED: $old -> $new"
//   → We cross-reference with DB: query all applied analyses to build
//     a map of variant_id → suggested_price. Then match each APPLIED
//     line's new_price to a variant_id from the DB.
// ---------------------------------------------------------------------------
async function parseLogContentWithDb(
  logContent: string,
  source: string,
  db: ReturnType<typeof createClient>,
): Promise<PriceRevert[]> {
  const reverts: PriceRevert[] = [];
  const lines = logContent.split('\n');

  // First pass: collect all new-format APPLIED lines (reliable)
  // and all old-format APPLIED lines (need matching)
  interface OldFormatLine {
    oldPrice: number;
    newPrice: number;
    lineNum: number;
  }
  const oldFormatLines: OldFormatLine[] = [];

  // Also build a map of variant context from Analyzing: lines
  // Map from line number → variant info
  const analyzeLines: { lineNum: number; variantId: string; productTitle: string; variantTitle: string }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Match "Analyzing: Product Title / Variant Title (variant-id)"
    const analyzeMatch = line.match(/Analyzing:\s+(.+?)\s+\/\s+(.*?)\s+\((\d+)\)/);
    if (analyzeMatch) {
      analyzeLines.push({
        lineNum: i,
        productTitle: analyzeMatch[1].trim(),
        variantTitle: analyzeMatch[2].trim() || 'Default',
        variantId: analyzeMatch[3],
      });
      continue;
    }

    // Match "Markup: Product / Variant (id)" lines
    const markupMatch = line.match(/Markup:\s+(.+?)\s+\/\s+(.*?)\s+\((\d+)\)/);
    if (markupMatch) {
      analyzeLines.push({
        lineNum: i,
        productTitle: markupMatch[1].trim(),
        variantTitle: markupMatch[2].trim() || 'Default',
        variantId: markupMatch[3],
      });
      continue;
    }

    // NEW FORMAT: "APPLIED (variant_id): $old -> $new" — reliable, variant ID in line
    const newFormatMatch = line.match(/APPLIED\s+\((\d+)\):\s+\$(\d+\.?\d*)\s*->\s*\$(\d+\.?\d*)/);
    if (newFormatMatch) {
      // Find nearest preceding Analyzing: line for product/variant titles
      const nearest = findNearestAnalyzeLine(analyzeLines, i, newFormatMatch[1]);
      reverts.push({
        variantId: newFormatMatch[1],
        productTitle: nearest?.productTitle || 'Unknown',
        variantTitle: nearest?.variantTitle || 'Default',
        oldPrice: parseFloat(newFormatMatch[2]),
        currentPrice: parseFloat(newFormatMatch[3]),
        source,
      });
      continue;
    }

    // OLD FORMAT: "APPLIED: $old -> $new" — no variant ID, need matching
    const oldFormatMatch = line.match(/APPLIED:\s+\$(\d+\.?\d*)\s*->\s*\$(\d+\.?\d*)/);
    if (oldFormatMatch) {
      oldFormatLines.push({
        oldPrice: parseFloat(oldFormatMatch[1]),
        newPrice: parseFloat(oldFormatMatch[2]),
        lineNum: i,
      });
    }
  }

  // If we have old-format lines, match them using the DB
  if (oldFormatLines.length > 0) {
    log(`  Found ${oldFormatLines.length} old-format APPLIED lines — matching via database...`);

    // Query all applied analyses to build suggested_price → variant_id mapping
    const { data: analyses } = await db
      .from('analyses')
      .select('variant_id, suggested_price, product_id')
      .eq('applied', true)
      .not('suggested_price', 'is', null);

    if (analyses && analyses.length > 0) {
      // Build a map: suggested_price → list of analyses with that price
      const priceToAnalyses = new Map<string, typeof analyses>();
      for (const a of analyses) {
        const key = Number(a.suggested_price).toFixed(2);
        if (!priceToAnalyses.has(key)) priceToAnalyses.set(key, []);
        priceToAnalyses.get(key)!.push(a);
      }

      // Load product/variant info
      const allVariantIds = analyses.map(a => a.variant_id);
      const allProductIds = [...new Set(analyses.map(a => a.product_id))];
      const [{ data: variants }, { data: products }] = await Promise.all([
        db.from('variants').select('id, title').in('id', allVariantIds),
        db.from('products').select('id, title').in('id', allProductIds),
      ]);
      const variantMap = new Map((variants || []).map(v => [v.id, v]));
      const productMap = new Map((products || []).map(p => [p.id, p]));

      // Track which variant_ids we've already matched
      const matchedVariantIds = new Set<string>();

      for (const applied of oldFormatLines) {
        const key = applied.newPrice.toFixed(2);
        const candidates = priceToAnalyses.get(key) || [];

        // Filter out already-matched candidates
        const unmatched = candidates.filter(c => !matchedVariantIds.has(c.variant_id));

        if (unmatched.length === 1) {
          // Unique match — confident
          const a = unmatched[0];
          matchedVariantIds.add(a.variant_id);
          reverts.push({
            variantId: a.variant_id,
            productTitle: productMap.get(a.product_id)?.title || 'Unknown',
            variantTitle: variantMap.get(a.variant_id)?.title || 'Default',
            oldPrice: applied.oldPrice,
            currentPrice: applied.newPrice,
            source,
          });
        } else if (unmatched.length > 1) {
          // Multiple analyses with same suggested_price — try matching by nearest Analyzing: line
          const nearestAnalyze = findNearestAnalyzeLineByLineNum(analyzeLines, applied.lineNum);
          if (nearestAnalyze) {
            const matchByVariant = unmatched.find(c => c.variant_id === nearestAnalyze.variantId);
            if (matchByVariant) {
              matchedVariantIds.add(matchByVariant.variant_id);
              reverts.push({
                variantId: matchByVariant.variant_id,
                productTitle: nearestAnalyze.productTitle,
                variantTitle: nearestAnalyze.variantTitle,
                oldPrice: applied.oldPrice,
                currentPrice: applied.newPrice,
                source,
              });
              continue;
            }
          }
          // Can't disambiguate — skip with warning
          log(`  WARNING: ${unmatched.length} variants have suggested_price=$${key}, skipping ambiguous match`);
        } else {
          log(`  WARNING: No DB match for APPLIED $${applied.oldPrice.toFixed(2)} -> $${key}`);
        }
      }
    } else {
      log('  WARNING: No applied analyses found in DB to match old-format APPLIED lines');
    }
  }

  return reverts;
}

function findNearestAnalyzeLine(
  analyzeLines: { lineNum: number; variantId: string; productTitle: string; variantTitle: string }[],
  appliedLineNum: number,
  targetVariantId: string,
): { productTitle: string; variantTitle: string } | null {
  // Find the Analyzing: line for this specific variant ID
  for (let i = analyzeLines.length - 1; i >= 0; i--) {
    if (analyzeLines[i].variantId === targetVariantId && analyzeLines[i].lineNum < appliedLineNum) {
      return analyzeLines[i];
    }
  }
  return null;
}

function findNearestAnalyzeLineByLineNum(
  analyzeLines: { lineNum: number; variantId: string; productTitle: string; variantTitle: string }[],
  appliedLineNum: number,
): { variantId: string; productTitle: string; variantTitle: string } | null {
  // Find the closest preceding Analyzing: line
  let closest = null;
  for (const a of analyzeLines) {
    if (a.lineNum < appliedLineNum) {
      closest = a;
    }
  }
  return closest;
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
        .update({ applied: false, applied_at: null })
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
  if (opts.runs > 0) {
    console.log(`  Mode:       GitHub Actions (last ${opts.runs} runs)`);
  } else if (opts.since) {
    console.log(`  Mode:       Database (since ${opts.since})`);
  } else {
    console.log(`  Mode:       Log files`);
  }
  console.log(`  Log files:  ${opts.logFiles.length > 0 ? opts.logFiles.join(', ') : 'none'}`);
  console.log(`  Dry run:    ${opts.dryRun}`);
  console.log(`  Repo:       ${opts.repo}`);
  console.log('='.repeat(70) + '\n');

  if (opts.runs === 0 && !opts.since && opts.logFiles.length === 0) {
    console.error('ERROR: Specify one of:');
    console.error('  --runs N       Download and parse last N GitHub Actions batch runs');
    console.error('  --since DATE   Revert from DB (requires previous_price column)');
    console.error('  --log-file F   Parse a local log file');
    console.error('');
    console.error('Examples:');
    console.error('  scripts/revert-prices.ts --runs 3 --dry-run');
    console.error('  scripts/revert-prices.ts --since "2026-02-10" --dry-run');
    console.error('  scripts/revert-prices.ts --log-file run-log.txt --dry-run');
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

  // GITHUB RUNS MODE — download logs from GitHub Actions
  if (opts.runs > 0) {
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      console.error('ERROR: GITHUB_TOKEN env var required when using --runs');
      console.error('  In GitHub Actions, this is available automatically.');
      console.error('  Locally, create a token at https://github.com/settings/tokens with "actions:read" scope');
      process.exit(1);
    }

    const runs = await getRecentRunIds(opts.repo, opts.runs, token);
    if (runs.length === 0) {
      console.error('ERROR: No completed batch-analyze runs found');
      process.exit(1);
    }

    // Download logs — most recent first, so the final dedup keeps earliest old price
    for (const run of runs) {
      try {
        const logContent = await downloadRunLogs(opts.repo, run.id, token);
        const reverts = await parseLogContentWithDb(logContent, `run:${run.id}`, db);
        log(`  Found ${reverts.length} applied price changes in run ${run.id}`);
        allReverts.push(...reverts);
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Unknown error';
        logError(`Failed to process run ${run.id}: ${msg}`);
      }
    }
  }

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
    const reverts = await parseLogContentWithDb(content, `file:${path.basename(logFile)}`, db);
    log(`Found ${reverts.length} applied price changes in ${logFile}`);
    allReverts.push(...reverts);
  }

  if (allReverts.length === 0) {
    log('No price changes found. Nothing to revert.');
    return;
  }

  log(`\nTotal price changes found: ${allReverts.length}`);

  // Deduplicate
  const deduplicated = deduplicateReverts(allReverts);
  log(`Unique variants to revert: ${deduplicated.length}`);

  if (deduplicated.length !== allReverts.length) {
    log(`  (${allReverts.length - deduplicated.length} duplicates removed — using earliest old price per variant)`);
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
