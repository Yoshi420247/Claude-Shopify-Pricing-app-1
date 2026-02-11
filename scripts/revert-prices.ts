#!/usr/bin/env npx tsx --tsconfig tsconfig.scripts.json
// =============================================================================
// Revert Prices — restore prices from before batch runs
//
// Parses GitHub Actions logs (or local log files) to find "APPLIED" lines,
// extracts the old prices, and sets them back on Shopify + Supabase.
//
// Usage (with GitHub token — downloads logs automatically):
//   GITHUB_TOKEN=ghp_xxx npx tsx --tsconfig tsconfig.scripts.json scripts/revert-prices.ts \
//     --runs 3
//
// Usage (with local log files):
//   npx tsx --tsconfig tsconfig.scripts.json scripts/revert-prices.ts \
//     --log-file logs/run1.txt --log-file logs/run2.txt
//
// Dry run (show what would be reverted without changing anything):
//   npx tsx --tsconfig tsconfig.scripts.json scripts/revert-prices.ts \
//     --runs 3 --dry-run
//
// Environment variables required:
//   SHOPIFY_STORE_NAME, SHOPIFY_ACCESS_TOKEN,
//   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   GITHUB_TOKEN (only when using --runs to download logs)
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
  newPrice: number;
  runId?: string;
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------
function parseArgs(): {
  runs: number;
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
// Download logs from GitHub Actions
// ---------------------------------------------------------------------------
async function downloadRunLogs(repo: string, runId: string, token: string): Promise<string> {
  const url = `https://api.github.com/repos/${repo}/actions/runs/${runId}/logs`;
  log(`Downloading logs for run ${runId}...`);

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to download logs for run ${runId}: ${response.status} ${response.statusText}`);
  }

  // GitHub returns a zip file — we need to extract it
  const arrayBuffer = await response.arrayBuffer();
  const zipPath = `/tmp/gh-run-${runId}.zip`;
  const extractDir = `/tmp/gh-run-${runId}`;

  fs.writeFileSync(zipPath, Buffer.from(arrayBuffer));

  // Extract zip using unzip command
  const { execSync } = await import('child_process');
  try {
    execSync(`rm -rf ${extractDir} && mkdir -p ${extractDir} && unzip -o ${zipPath} -d ${extractDir}`, {
      stdio: 'pipe',
    });
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
  } catch { /* ignore cleanup errors */ }

  return allLogs;
}

async function getRecentRunIds(repo: string, count: number, token: string): Promise<string[]> {
  const url = `https://api.github.com/repos/${repo}/actions/workflows/batch-analyze.yml/runs?per_page=${count}&status=completed`;
  log(`Fetching last ${count} completed batch-analyze runs...`);

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch workflow runs: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  const runs = data.workflow_runs || [];
  const ids = runs.map((r: { id: number; created_at: string; conclusion: string }) => {
    log(`  Run #${r.id} — ${r.created_at} (${r.conclusion})`);
    return String(r.id);
  });

  return ids;
}

// ---------------------------------------------------------------------------
// Parse log content to extract price reverts
// ---------------------------------------------------------------------------
function parseLogContent(logContent: string, runId?: string): PriceRevert[] {
  const reverts: PriceRevert[] = [];
  const lines = logContent.split('\n');

  // Track the current variant context from "Analyzing:" lines
  let currentVariantId: string | null = null;
  let currentProductTitle: string | null = null;
  let currentVariantTitle: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Match "Analyzing: Product Title / Variant Title (variant-id)"
    // Log format: [timestamp] Analyzing: Product / Variant (id)
    // GitHub Actions may prepend timestamps like "2026-02-11T14:33:00.1234567Z"
    const analyzeMatch = line.match(/Analyzing:\s+(.+?)\s+\/\s+(.*?)\s+\((\d+)\)/);
    if (analyzeMatch) {
      currentProductTitle = analyzeMatch[1].trim();
      currentVariantTitle = analyzeMatch[2].trim() || 'Default';
      currentVariantId = analyzeMatch[3];
      continue;
    }

    // Match "APPLIED: $42.50 -> $49.99"
    const appliedMatch = line.match(/APPLIED:\s+\$(\d+\.?\d*)\s*->\s*\$(\d+\.?\d*)/);
    if (appliedMatch && currentVariantId) {
      const oldPrice = parseFloat(appliedMatch[1]);
      const newPrice = parseFloat(appliedMatch[2]);

      // Only add if prices are different (sanity check)
      if (oldPrice !== newPrice) {
        reverts.push({
          variantId: currentVariantId,
          productTitle: currentProductTitle || 'Unknown',
          variantTitle: currentVariantTitle || 'Default',
          oldPrice,
          newPrice,
          runId,
        });
      }

      // Reset context
      currentVariantId = null;
      currentProductTitle = null;
      currentVariantTitle = null;
    }

    // Also match "Markup: Product / Variant (id)" lines for markup mode
    const markupMatch = line.match(/Markup:\s+(.+?)\s+\/\s+(.*?)\s+\((\d+)\)/);
    if (markupMatch) {
      currentProductTitle = markupMatch[1].trim();
      currentVariantTitle = markupMatch[2].trim() || 'Default';
      currentVariantId = markupMatch[3];
      continue;
    }
  }

  return reverts;
}

// ---------------------------------------------------------------------------
// Deduplicate reverts — if a variant was changed in multiple runs,
// we want the OLDEST old price (the original before any batch runs)
// ---------------------------------------------------------------------------
function deduplicateReverts(reverts: PriceRevert[]): PriceRevert[] {
  // Group by variantId — keep the entry from the EARLIEST run
  // Since runs are in reverse chronological order (most recent first),
  // later entries in the array are from earlier runs and have the "more original" old price
  const variantMap = new Map<string, PriceRevert>();

  for (const revert of reverts) {
    // Always overwrite — later entries are from earlier runs = more original prices
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

    if (dryRun) {
      log(`${progress} DRY RUN: ${label} — would revert $${r.newPrice.toFixed(2)} -> $${r.oldPrice.toFixed(2)}`);
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

      log(`${progress} REVERTED: ${label} — $${r.newPrice.toFixed(2)} -> $${r.oldPrice.toFixed(2)}`);
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
      revertedFrom: r.newPrice,
      revertedTo: r.oldPrice,
      runId: r.runId,
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
  console.log(`  Mode:       ${opts.runs > 0 ? `Download last ${opts.runs} runs from GitHub` : 'Local log files'}`);
  console.log(`  Log files:  ${opts.logFiles.length > 0 ? opts.logFiles.join(', ') : 'none'}`);
  console.log(`  Dry run:    ${opts.dryRun}`);
  console.log(`  Repo:       ${opts.repo}`);
  console.log('='.repeat(70) + '\n');

  if (opts.runs === 0 && opts.logFiles.length === 0) {
    console.error('ERROR: Specify either --runs N (to download GitHub logs) or --log-file path (for local files)');
    console.error('  Example: npx tsx --tsconfig tsconfig.scripts.json scripts/revert-prices.ts --runs 3 --dry-run');
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

  // Collect all reverts from all log sources
  let allReverts: PriceRevert[] = [];

  // Download from GitHub Actions
  if (opts.runs > 0) {
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      console.error('ERROR: GITHUB_TOKEN env var required when using --runs');
      console.error('  Create a token at https://github.com/settings/tokens with "actions:read" scope');
      process.exit(1);
    }

    const runIds = await getRecentRunIds(opts.repo, opts.runs, token);
    if (runIds.length === 0) {
      console.error('ERROR: No completed batch-analyze runs found');
      process.exit(1);
    }

    // Download logs from most recent first
    for (const runId of runIds) {
      try {
        const logContent = await downloadRunLogs(opts.repo, runId, token);
        const reverts = parseLogContent(logContent, runId);
        log(`  Found ${reverts.length} applied price changes in run ${runId}`);
        allReverts.push(...reverts);
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Unknown error';
        logError(`Failed to process run ${runId}: ${msg}`);
      }
    }
  }

  // Parse local log files
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
    log('No price changes found in any logs. Nothing to revert.');
    return;
  }

  log(`\nTotal price changes found across all sources: ${allReverts.length}`);

  // Deduplicate — use the oldest old price per variant
  const deduplicated = deduplicateReverts(allReverts);
  log(`Unique variants to revert: ${deduplicated.length}`);

  if (deduplicated.length !== allReverts.length) {
    log(`  (${allReverts.length - deduplicated.length} duplicates removed — using earliest old price per variant)`);
  }

  console.log('\n' + '-'.repeat(70));
  log(opts.dryRun ? 'DRY RUN — showing what would be reverted:' : 'Applying price reverts...');
  console.log('-'.repeat(70) + '\n');

  // Apply reverts
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
