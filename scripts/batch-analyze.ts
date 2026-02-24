#!/usr/bin/env npx tsx --tsconfig tsconfig.scripts.json
// =============================================================================
// Standalone Batch Price Analyzer — runs outside Vercel (no 300s timeout)
// Designed for GitHub Actions but can run locally too.
//
// VOLUME PRICING: For products with quantity-type variants, only the base
// (lowest qty) variant is AI-analyzed. All other quantity variants get their
// prices derived via the power-law volume discount formula.
//
// IMPROVEMENTS (v2):
//   - Auto-retry failed variants (--retry N) with exponential backoff
//   - Confidence-based filtering (--min-confidence low|medium|high)
//   - Price change sanity checks (--max-price-change N%)
//   - Before/after price change report saved to reports/
//   - ETA calculation in progress reporting
//   - Transient error detection with smart retry vs skip
//
// Usage:
//   npx tsx --tsconfig tsconfig.scripts.json scripts/batch-analyze.ts \
//     --vendor "Artist Name" --status active --concurrency 100
//
// Analyze a single product by Shopify ID (from the admin URL):
//   npx tsx --tsconfig tsconfig.scripts.json scripts/batch-analyze.ts \
//     --product-id 4480870645859
//
// Multiple products:
//   npx tsx --tsconfig tsconfig.scripts.json scripts/batch-analyze.ts \
//     --product-id 4480870645859,4480870645860,4480870645861
//
// Paste the full Shopify admin URL — the ID is extracted automatically:
//   npx tsx --tsconfig tsconfig.scripts.json scripts/batch-analyze.ts \
//     --product-id https://admin.shopify.com/store/myshop/products/4480870645859
//
// Or use the product handle (URL slug from storefront):
//   npx tsx --tsconfig tsconfig.scripts.json scripts/batch-analyze.ts \
//     --product-id 7ml-jar-black-clear
//
// Re-run failed products from a previous report:
//   npx tsx --tsconfig tsconfig.scripts.json scripts/batch-analyze.ts \
//     --failed-report reports/failed-products-2026-02-06.json
//
// Skip already-analyzed products (only process new/unanalyzed):
//   npx tsx --tsconfig tsconfig.scripts.json scripts/batch-analyze.ts --skip-analyzed
//
// Only apply prices with medium+ confidence, retry failures 3 times:
//   npx tsx --tsconfig tsconfig.scripts.json scripts/batch-analyze.ts \
//     --min-confidence medium --retry 3
//
// Flag price changes over 50% for review (dry-run mode):
//   npx tsx --tsconfig tsconfig.scripts.json scripts/batch-analyze.ts \
//     --max-price-change 50 --dry-run
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
import { getBatchCostTracker, resetBatchCostTracker } from '@/lib/cost-tracker';
import { getRoutingSummary, type RouterOptions } from '@/lib/model-router';
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
  retryCount: number;
}

interface PriceChange {
  productId: string;
  variantId: string;
  productTitle: string;
  variantTitle: string;
  previousPrice: number;
  newPrice: number;
  changePct: number;
  confidence: string;
  pricingMethod: 'ai' | 'volume_formula' | 'markup';
  flagged: boolean;
  flagReason: string | null;
}

type Confidence = 'low' | 'medium' | 'high';

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
  productIds: string[] | null;
  minConfidence: Confidence;
  maxRetries: number;
  maxPriceChangePct: number;
} {
  const args = process.argv.slice(2);
  const get = (flag: string): string | null => {
    const idx = args.indexOf(flag);
    return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : null;
  };
  const has = (flag: string): boolean => args.includes(flag);

  const rawSearch = get('--search-mode') || 'gemini';
  const searchMode: SearchMode = rawSearch === 'brave' ? 'brave' : rawSearch === 'amazon' ? 'amazon' : rawSearch === 'none' ? 'none' : rawSearch === 'openai' ? 'openai' : 'gemini';

  const rawMarkup = get('--markup');
  const markup = rawMarkup ? parseFloat(rawMarkup) : null;
  if (markup !== null && (isNaN(markup) || markup <= 0)) {
    console.error('ERROR: --markup must be a positive number (e.g. 3 for 3x cost)');
    process.exit(1);
  }

  const rawProvider = get('--provider') || 'openai';
  const provider: Provider = rawProvider === 'claude' ? 'claude' : rawProvider === 'gemini' ? 'gemini' : 'openai';

  // Parse --product-id: accepts numeric IDs, Shopify admin URLs, or handles (comma-separated)
  const rawProductId = get('--product-id');
  const productIds = rawProductId ? parseProductIdArg(rawProductId) : null;

  // Parse --min-confidence
  const rawConfidence = get('--min-confidence') || 'low';
  const minConfidence: Confidence = rawConfidence === 'high' ? 'high' : rawConfidence === 'medium' ? 'medium' : 'low';

  // Parse --retry (max retries for transient failures)
  const rawRetries = get('--retry') || '0';
  const maxRetries = Math.max(0, Math.min(5, parseInt(rawRetries, 10) || 0));

  // Parse --max-price-change (percentage)
  const rawMaxChange = get('--max-price-change') || '0';
  const maxPriceChangePct = Math.max(0, parseFloat(rawMaxChange) || 0);

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
    productIds,
    minConfidence,
    maxRetries,
    maxPriceChangePct,
  };
}

/**
 * Parse --product-id argument into an array of identifiers.
 * Accepts:
 *   - Numeric Shopify product ID: "4480870645859"
 *   - Comma-separated IDs: "4480870645859,4480870645860"
 *   - Full Shopify admin URL: "https://admin.shopify.com/store/myshop/products/4480870645859"
 *   - Product handle (URL slug): "7ml-jar-black-clear"
 *
 * Returns an array of strings — either numeric IDs or handles (resolved later).
 */
function parseProductIdArg(raw: string): string[] {
  return raw.split(',').map(part => {
    const trimmed = part.trim();
    // Extract numeric ID from Shopify admin URL
    const urlMatch = trimmed.match(/\/products\/(\d+)/);
    if (urlMatch) return urlMatch[1];
    // Already a number or a handle — pass through
    return trimmed;
  }).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Logging helpers
// ---------------------------------------------------------------------------
function log(msg: string) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] ${msg}`);
}

function logWarn(msg: string) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.warn(`[${ts}] WARN: ${msg}`);
}

function logError(msg: string) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.error(`[${ts}] ERROR: ${msg}`);
}

function logProgress(done: number, total: number, failed: number, applied: number, skippedConfidence: number, flaggedChanges: number, activeWorkers: number) {
  const pct = ((done / total) * 100).toFixed(1);
  const elapsed = ((Date.now() - globalStartTime) / 1000 / 60).toFixed(1);
  const rate = done > 0 ? (done / ((Date.now() - globalStartTime) / 1000 / 60)).toFixed(1) : '0';
  // ETA calculation
  const ratePerSec = done > 0 ? done / ((Date.now() - globalStartTime) / 1000) : 0;
  const remaining = total - done;
  const etaMin = ratePerSec > 0 ? (remaining / ratePerSec / 60).toFixed(1) : '?';
  // Running cost estimate
  const costSoFar = getBatchCostTracker().getSummary().totalCost;
  console.log(`\n${'='.repeat(78)}`);
  console.log(`  Progress: ${done}/${total} (${pct}%) | Failed: ${failed} | Applied: ${applied}`);
  console.log(`  Workers: ${activeWorkers} active | Rate: ${rate}/min | Elapsed: ${elapsed}min | ETA: ${etaMin}min`);
  if (skippedConfidence > 0 || flaggedChanges > 0) {
    console.log(`  Skipped (low conf): ${skippedConfidence} | Flagged (large change): ${flaggedChanges}`);
  }
  console.log(`  Running cost: $${costSoFar.toFixed(4)}`);
  console.log(`${'='.repeat(78)}\n`);
}

let globalStartTime = Date.now();

// ---------------------------------------------------------------------------
// Confidence level comparison
// ---------------------------------------------------------------------------
const CONFIDENCE_RANK: Record<string, number> = { low: 1, medium: 2, high: 3 };

function meetsConfidenceThreshold(confidence: string | undefined, minConfidence: Confidence): boolean {
  const rank = CONFIDENCE_RANK[confidence || 'low'] || 0;
  const minRank = CONFIDENCE_RANK[minConfidence] || 1;
  return rank >= minRank;
}

// ---------------------------------------------------------------------------
// Transient error detection — these are worth retrying
// ---------------------------------------------------------------------------
const TRANSIENT_PATTERNS = [
  'timeout',
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'socket hang up',
  'network error',
  'fetch failed',
  '429',         // rate limit
  'too many requests',
  'rate limit',
  'service unavailable',
  '503',
  '502',
  'bad gateway',
  'internal server error',
  '500',
  'ENOTFOUND',
  'EAI_AGAIN',
];

function isTransient(error: string): boolean {
  const lower = error.toLowerCase();
  return TRANSIENT_PATTERNS.some(p => lower.includes(p.toLowerCase()));
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
// Price change sanity check
// ---------------------------------------------------------------------------
function checkPriceChange(
  previousPrice: number,
  newPrice: number,
  maxChangePct: number,
): { flagged: boolean; changePct: number; reason: string | null } {
  if (previousPrice <= 0 || !maxChangePct) {
    return { flagged: false, changePct: 0, reason: null };
  }

  const changePct = Math.abs((newPrice - previousPrice) / previousPrice) * 100;

  if (changePct > maxChangePct) {
    const direction = newPrice > previousPrice ? 'increase' : 'decrease';
    return {
      flagged: true,
      changePct,
      reason: `Price ${direction} of ${changePct.toFixed(1)}% exceeds ${maxChangePct}% threshold ($${previousPrice.toFixed(2)} → $${newPrice.toFixed(2)})`,
    };
  }

  return { flagged: false, changePct, reason: null };
}

// ---------------------------------------------------------------------------
// Sleep helper for retry backoff
// ---------------------------------------------------------------------------
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
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
  opts: {
    dryRun: boolean; skipApply: boolean; searchMode: SearchMode; provider: Provider; fast: boolean;
    minConfidence: Confidence; maxRetries: number; maxPriceChangePct: number;
  },
): Promise<{ results: Array<{ variantId: string; success: boolean; applied: boolean; price: number | null; error: string | null; pricingMethod: 'ai' | 'volume_formula'; confidence: string; flagged: boolean; flagReason: string | null; previousPrice: number }> }> {
  const results: Array<{ variantId: string; success: boolean; applied: boolean; price: number | null; error: string | null; pricingMethod: 'ai' | 'volume_formula'; confidence: string; flagged: boolean; flagReason: string | null; previousPrice: number }> = [];

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
            results.push({ variantId: r.variantId, success: false, applied: false, price: null, error: r.analysisResult.error, pricingMethod: r.volumeMeta.pricing_method, confidence: 'low', flagged: false, flagReason: null, previousPrice: 0 });
            continue;
          }

          // Save analysis to DB
          await saveAnalysis(r.productId, r.variantId, r.analysisResult, r.volumeMeta);

          const price = r.analysisResult.suggestedPrice;
          const variant = productVariants.find(v => v.id === r.variantId);
          const method = r.volumeMeta.pricing_method;
          const confidence = r.analysisResult.confidence || 'medium';
          const prevPrice = variant?.price || 0;

          log(`  ${method === 'ai' ? 'AI' : 'FORMULA'}: ${variant?.title || 'Default'} → $${price?.toFixed(2) || 'none'} (conf: ${confidence})`);

          // Confidence check
          if (!meetsConfidenceThreshold(confidence, opts.minConfidence)) {
            logWarn(`  Skipping apply — confidence "${confidence}" below minimum "${opts.minConfidence}"`);
            results.push({ variantId: r.variantId, success: true, applied: false, price, error: null, pricingMethod: method, confidence, flagged: false, flagReason: `Below min confidence: ${confidence} < ${opts.minConfidence}`, previousPrice: prevPrice });
            continue;
          }

          // Price change sanity check
          let flagged = false;
          let flagReason: string | null = null;
          if (price && prevPrice > 0) {
            const check = checkPriceChange(prevPrice, price, opts.maxPriceChangePct);
            flagged = check.flagged;
            flagReason = check.reason;
            if (flagged) {
              logWarn(`  FLAGGED: ${flagReason}`);
            }
          }

          // Auto-apply (skip if flagged and not dry-run — let user review)
          if (price && price > 0 && !opts.dryRun && !opts.skipApply && !flagged) {
            try {
              await updateVariantPrice(r.variantId, price);
              await db.from('variants').update({ price }).eq('id', r.variantId);
              await db
                .from('analyses')
                .update({ applied: true, applied_at: new Date().toISOString(), previous_price: prevPrice })
                .match({ product_id: r.productId, variant_id: r.variantId });

              log(`  APPLIED (${r.variantId}): $${prevPrice.toFixed(2)} -> $${price.toFixed(2)}`);
              results.push({ variantId: r.variantId, success: true, applied: true, price, error: null, pricingMethod: method, confidence, flagged, flagReason, previousPrice: prevPrice });
            } catch (applyErr) {
              const msg = applyErr instanceof Error ? applyErr.message : 'Apply failed';
              logError(`  Apply failed: ${msg}`);
              results.push({ variantId: r.variantId, success: true, applied: false, price, error: `Apply failed: ${msg}`, pricingMethod: method, confidence, flagged, flagReason, previousPrice: prevPrice });
            }
          } else {
            if (opts.dryRun) {
              log(`  DRY RUN: Would apply $${price?.toFixed(2)}${flagged ? ' (FLAGGED — would skip)' : ''}`);
            } else if (flagged) {
              log(`  HELD: Price flagged for review, not applied`);
            }
            results.push({ variantId: r.variantId, success: true, applied: false, price, error: null, pricingMethod: method, confidence, flagged, flagReason, previousPrice: prevPrice });
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Unknown error';
        logError(`${label}: ${msg}`);
        // Mark all variants in this group as failed
        for (const qv of group.variants) {
          if (variantsToProcess.some(v => v.id === qv.variant.id) && !processedIds.has(qv.variant.id)) {
            processedIds.add(qv.variant.id);
            results.push({ variantId: qv.variant.id, success: false, applied: false, price: null, error: msg, pricingMethod: 'ai', confidence: 'low', flagged: false, flagReason: null, previousPrice: qv.variant.price || 0 });
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
// Process a single variant with retry logic
// ---------------------------------------------------------------------------
async function processSingleVariant(
  product: Product,
  variant: Variant,
  settings: Settings,
  db: ReturnType<typeof createClient>,
  opts: {
    dryRun: boolean; skipApply: boolean; searchMode: SearchMode; provider: Provider; fast: boolean;
    minConfidence: Confidence; maxRetries: number; maxPriceChangePct: number;
  },
): Promise<{ variantId: string; success: boolean; applied: boolean; price: number | null; error: string | null; confidence: string; flagged: boolean; flagReason: string | null; previousPrice: number }> {
  const label = `${product.title} / ${variant.title || 'Default'} (${variant.id})`;
  const prevPrice = variant.price || 0;
  let lastError = '';

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    if (attempt > 0) {
      const backoffMs = Math.min(1000 * Math.pow(2, attempt - 1), 16000);
      log(`  Retry ${attempt}/${opts.maxRetries} for ${label} (waiting ${backoffMs}ms)`);
      await sleep(backoffMs);
    }

    try {
      log(`Analyzing: ${label}${attempt > 0 ? ` (attempt ${attempt + 1})` : ''}`);
      const result = await runFullAnalysis(product, variant, settings, (step) => {
        log(`  ${step}`);
      }, opts.searchMode, opts.provider, opts.fast);

      // Accumulate cost into batch tracker
      if (result.costSummary) {
        const batchTracker = getBatchCostTracker();
        for (const entry of result.costSummary.entries) {
          batchTracker.add({
            step: entry.step,
            provider: entry.provider,
            model: entry.model,
            estimatedInputTokens: entry.estimatedInputTokens,
            estimatedOutputTokens: entry.estimatedOutputTokens,
            estimatedThinkingTokens: entry.estimatedThinkingTokens,
            searchCalls: entry.searchCalls,
            searchType: entry.searchType,
          });
        }
      }

      if (result.error) {
        lastError = result.error;

        // Check if this is a transient error worth retrying
        if (attempt < opts.maxRetries && isTransient(result.error) && !isFatal(result.error)) {
          logWarn(`Transient error for ${label}: ${result.error}`);
          continue; // retry
        }

        logError(`Analysis failed for ${label}: ${result.error}`);
        return { variantId: variant.id, success: false, applied: false, price: null, error: result.error, confidence: 'low', flagged: false, flagReason: null, previousPrice: prevPrice };
      }

      // Save analysis to DB
      await saveAnalysis(product.id, variant.id, result);

      const price = result.suggestedPrice;
      const confidence = result.confidence || 'medium';
      log(`  Suggested: $${price?.toFixed(2) || 'none'} (confidence: ${confidence}, deliberated: ${result.wasDeliberated})`);

      // Confidence check
      if (!meetsConfidenceThreshold(confidence, opts.minConfidence)) {
        logWarn(`  Skipping apply — confidence "${confidence}" below minimum "${opts.minConfidence}"`);
        return { variantId: variant.id, success: true, applied: false, price, error: null, confidence, flagged: false, flagReason: `Below min confidence: ${confidence} < ${opts.minConfidence}`, previousPrice: prevPrice };
      }

      // Price change sanity check
      let flagged = false;
      let flagReason: string | null = null;
      if (price && prevPrice > 0) {
        const check = checkPriceChange(prevPrice, price, opts.maxPriceChangePct);
        flagged = check.flagged;
        flagReason = check.reason;
        if (flagged) {
          logWarn(`  FLAGGED: ${flagReason}`);
        }
      }

      // Auto-apply (skip if flagged — let user review)
      if (price && price > 0 && !opts.dryRun && !opts.skipApply && !flagged) {
        try {
          await updateVariantPrice(variant.id, price);
          await db.from('variants').update({ price }).eq('id', variant.id);
          await db
            .from('analyses')
            .update({ applied: true, applied_at: new Date().toISOString(), previous_price: prevPrice })
            .match({ product_id: product.id, variant_id: variant.id });

          log(`  APPLIED (${variant.id}): $${prevPrice.toFixed(2)} -> $${price.toFixed(2)}`);
          return { variantId: variant.id, success: true, applied: true, price, error: null, confidence, flagged, flagReason, previousPrice: prevPrice };
        } catch (applyErr) {
          const msg = applyErr instanceof Error ? applyErr.message : 'Apply failed';
          logError(`  Apply failed: ${msg}`);
          return { variantId: variant.id, success: true, applied: false, price, error: `Apply failed: ${msg}`, confidence, flagged, flagReason, previousPrice: prevPrice };
        }
      }

      if (opts.dryRun) {
        log(`  DRY RUN: Would apply $${price?.toFixed(2)}${flagged ? ' (FLAGGED — would skip)' : ''}`);
      } else if (flagged) {
        log(`  HELD: Price flagged for review, not applied`);
      }

      return { variantId: variant.id, success: true, applied: false, price, error: null, confidence, flagged, flagReason, previousPrice: prevPrice };
    } catch (e) {
      lastError = e instanceof Error ? e.message : 'Unknown error';

      // Check if this is worth retrying
      if (attempt < opts.maxRetries && isTransient(lastError) && !isFatal(lastError)) {
        logWarn(`Transient error for ${label}: ${lastError}`);
        continue; // retry
      }

      logError(`${label}: ${lastError}`);
      return { variantId: variant.id, success: false, applied: false, price: null, error: lastError, confidence: 'low', flagged: false, flagReason: null, previousPrice: prevPrice };
    }
  }

  // All retries exhausted
  logError(`${label}: All ${opts.maxRetries} retries exhausted. Last error: ${lastError}`);
  return { variantId: variant.id, success: false, applied: false, price: null, error: `Retries exhausted: ${lastError}`, confidence: 'low', flagged: false, flagReason: null, previousPrice: prevPrice };
}

// ---------------------------------------------------------------------------
// Process a single variant with simple cost markup (no AI calls)
// ---------------------------------------------------------------------------
async function processVariantMarkup(
  product: Product,
  variant: Variant,
  multiplier: number,
  db: ReturnType<typeof createClient>,
  opts: { dryRun: boolean; skipApply: boolean; maxPriceChangePct: number },
): Promise<{ success: boolean; applied: boolean; price: number | null; error: string | null; confidence: string; flagged: boolean; flagReason: string | null; previousPrice: number }> {
  const label = `${product.title} / ${variant.title || 'Default'} (${variant.id})`;
  const prevPrice = variant.price || 0;

  if (variant.cost === null || variant.cost === undefined || variant.cost <= 0) {
    logError(`${label}: No cost data — cannot apply markup`);
    return { success: false, applied: false, price: null, error: 'No cost data on variant', confidence: 'high', flagged: false, flagReason: null, previousPrice: prevPrice };
  }

  const price = Math.round(variant.cost * multiplier * 100) / 100;
  log(`Markup: ${label} — cost $${variant.cost.toFixed(2)} × ${multiplier} = $${price.toFixed(2)}`);

  // Price change sanity check
  let flagged = false;
  let flagReason: string | null = null;
  if (prevPrice > 0) {
    const check = checkPriceChange(prevPrice, price, opts.maxPriceChangePct);
    flagged = check.flagged;
    flagReason = check.reason;
    if (flagged) {
      logWarn(`  FLAGGED: ${flagReason}`);
    }
  }

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

  // Apply price (skip if flagged)
  if (!opts.dryRun && !opts.skipApply && !flagged) {
    try {
      await updateVariantPrice(variant.id, price);
      await db.from('variants').update({ price }).eq('id', variant.id);
      await db
        .from('analyses')
        .update({ applied: true, applied_at: new Date().toISOString(), previous_price: prevPrice })
        .match({ product_id: product.id, variant_id: variant.id });

      log(`  APPLIED (${variant.id}): $${prevPrice.toFixed(2)} -> $${price.toFixed(2)}`);
      return { success: true, applied: true, price, error: null, confidence: 'high', flagged, flagReason, previousPrice: prevPrice };
    } catch (applyErr) {
      const msg = applyErr instanceof Error ? applyErr.message : 'Apply failed';
      logError(`  Apply failed: ${msg}`);
      return { success: true, applied: false, price, error: `Apply failed: ${msg}`, confidence: 'high', flagged, flagReason, previousPrice: prevPrice };
    }
  }

  if (opts.dryRun) {
    log(`  DRY RUN: Would apply $${price.toFixed(2)}${flagged ? ' (FLAGGED — would skip)' : ''}`);
  } else if (flagged) {
    log(`  HELD: Price flagged for review, not applied`);
  }

  return { success: true, applied: false, price, error: null, confidence: 'high', flagged, flagReason, previousPrice: prevPrice };
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
// Save price changes report (before/after comparison)
// ---------------------------------------------------------------------------
function savePriceChangesReport(priceChanges: PriceChange[], startTime: number) {
  if (priceChanges.length === 0) return null;

  const reportsDir = path.join(process.cwd(), 'reports');
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
  }

  const dateStr = new Date().toISOString().slice(0, 10);
  const timeStr = new Date().toISOString().slice(11, 19).replace(/:/g, '-');
  const reportPath = path.join(reportsDir, `price-changes-${dateStr}-${timeStr}.json`);

  // Calculate summary stats
  const applied = priceChanges.filter(c => !c.flagged);
  const flagged = priceChanges.filter(c => c.flagged);
  const increases = priceChanges.filter(c => c.newPrice > c.previousPrice);
  const decreases = priceChanges.filter(c => c.newPrice < c.previousPrice);
  const unchanged = priceChanges.filter(c => c.newPrice === c.previousPrice);

  const avgChangePct = priceChanges.length > 0
    ? priceChanges.reduce((sum, c) => sum + c.changePct, 0) / priceChanges.length
    : 0;

  const report = {
    generatedAt: new Date().toISOString(),
    summary: {
      totalChanges: priceChanges.length,
      applied: applied.length,
      flagged: flagged.length,
      increases: increases.length,
      decreases: decreases.length,
      unchanged: unchanged.length,
      avgChangePct: parseFloat(avgChangePct.toFixed(1)),
      elapsedMinutes: parseFloat(((Date.now() - startTime) / 1000 / 60).toFixed(1)),
    },
    // Flagged items (need manual review)
    flaggedForReview: flagged.map(c => ({
      product: c.productTitle,
      variant: c.variantTitle,
      variantId: c.variantId,
      previous: c.previousPrice,
      suggested: c.newPrice,
      changePct: c.changePct.toFixed(1) + '%',
      reason: c.flagReason,
      confidence: c.confidence,
    })),
    // All changes
    priceChanges: priceChanges.map(c => ({
      product: c.productTitle,
      variant: c.variantTitle,
      variantId: c.variantId,
      previous: c.previousPrice,
      new: c.newPrice,
      changePct: (c.changePct > 0 ? (c.newPrice > c.previousPrice ? '+' : '-') : '') + c.changePct.toFixed(1) + '%',
      confidence: c.confidence,
      method: c.pricingMethod,
      flagged: c.flagged,
    })),
  };

  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  log(`Price changes report saved: ${reportPath}`);

  // Print summary table
  console.log('\n' + '─'.repeat(78));
  console.log('  PRICE CHANGES SUMMARY');
  console.log('─'.repeat(78));
  console.log(`  Total: ${priceChanges.length} | Increases: ${increases.length} | Decreases: ${decreases.length} | Unchanged: ${unchanged.length}`);
  console.log(`  Avg change: ${avgChangePct.toFixed(1)}%`);
  if (flagged.length > 0) {
    console.log(`  FLAGGED FOR REVIEW: ${flagged.length} (see report for details)`);
    for (const f of flagged.slice(0, 10)) {
      console.log(`    - ${f.productTitle} / ${f.variantTitle}: $${f.previousPrice.toFixed(2)} → $${f.newPrice.toFixed(2)} (${f.changePct.toFixed(1)}%)`);
    }
    if (flagged.length > 10) {
      console.log(`    ... and ${flagged.length - 10} more (see full report)`);
    }
  }
  console.log('─'.repeat(78));

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

  // Reset batch cost tracker
  resetBatchCostTracker();

  // Model routing configuration
  const routerOpts: RouterOptions = {
    forcedProvider: opts.provider === 'openai' ? null : opts.provider,
    fast: opts.fast,
  };

  console.log('\n' + '='.repeat(78));
  console.log('  Oil Slick Pad — Batch Price Analyzer v2 (Volume-Aware)');
  console.log('='.repeat(78));
  console.log(`  Vendor filter:    ${opts.vendor || 'ALL'}`);
  console.log(`  Status filter:    ${opts.status}`);
  console.log(`  Concurrency:      ${opts.concurrency} workers`);
  console.log(`  Dry run:          ${opts.dryRun}`);
  console.log(`  Skip apply:       ${opts.skipApply}`);
  console.log(`  Skip analyzed:    ${opts.skipAnalyzed}`);
  console.log(`  Fast mode:        ${opts.fast ? 'YES (cheap models, no reflection/deliberation)' : 'no'}`);
  console.log(`  Search mode:      ${opts.searchMode}`);
  console.log(`  AI Provider:      ${opts.provider === 'openai' ? 'SMART ROUTING (multi-provider)' : opts.provider.toUpperCase()}`);
  console.log(`  Limit:            ${opts.limit || 'none'}`);
  console.log(`  Failed report:    ${opts.failedReport || 'none'}`);
  console.log(`  Product IDs:      ${opts.productIds ? opts.productIds.join(', ') : 'ALL (filtered by vendor/status)'}`);
  console.log(`  Markup:           ${opts.markup ? `${opts.markup}x cost (skip AI)` : 'none (use AI)'}`);
  console.log(`  Min confidence:   ${opts.minConfidence}${opts.minConfidence === 'low' ? ' (apply all)' : opts.minConfidence === 'medium' ? ' (skip low)' : ' (only high)'}`);
  console.log(`  Auto-retry:       ${opts.maxRetries > 0 ? `${opts.maxRetries} retries (exponential backoff)` : 'disabled'}`);
  console.log(`  Max price change: ${opts.maxPriceChangePct > 0 ? `${opts.maxPriceChangePct}% (flag larger changes)` : 'no limit'}`);
  console.log(`  Volume pricing:   ENABLED (qty variants auto-derived from base)`);
  console.log(`  Visual analysis:  ENABLED (Gemini 2.5 Flash for product images)`);
  console.log('─'.repeat(78));
  console.log(getRoutingSummary(routerOpts));
  console.log('='.repeat(78) + '\n');

  // Validate env vars
  const requiredEnv = [
    'NEXT_PUBLIC_SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'SHOPIFY_STORE_NAME',
    'SHOPIFY_ACCESS_TOKEN',
  ];
  // With smart routing, we need both OpenAI (for analysis) and Google (for search + vision)
  if (!opts.markup) {
    if (opts.provider === 'claude') {
      requiredEnv.push('ANTHROPIC_API_KEY');
    } else if (opts.provider === 'gemini') {
      requiredEnv.push('GOOGLE_API_KEY');
    } else {
      // Smart routing: OpenAI for reasoning, Gemini for search + visual
      requiredEnv.push('OPENAI_API_KEY');
      requiredEnv.push('GOOGLE_API_KEY');
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
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const db = createClient(
    supabaseUrl,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  // Pre-flight connectivity check with retry
  // Supabase free-tier projects can be paused and need time to wake up
  log(`Connecting to Supabase (${supabaseUrl.replace(/https?:\/\//, '').split('.')[0]})...`);

  let settingsRow = null;
  let settingsErr = null;
  const MAX_CONNECT_RETRIES = 4;
  for (let attempt = 0; attempt <= MAX_CONNECT_RETRIES; attempt++) {
    if (attempt > 0) {
      const backoffMs = Math.min(2000 * Math.pow(2, attempt - 1), 16000);
      logWarn(`Connection failed, retrying in ${backoffMs / 1000}s (attempt ${attempt + 1}/${MAX_CONNECT_RETRIES + 1})...`);
      await sleep(backoffMs);
    }

    const result = await db
      .from('settings')
      .select('*')
      .single();

    settingsRow = result.data;
    settingsErr = result.error;

    if (!settingsErr) {
      log('Supabase connection: OK');
      break;
    }

    // If error is not network-related, don't retry
    const errMsg = settingsErr.message || '';
    if (!errMsg.includes('fetch failed') && !errMsg.includes('ETIMEDOUT') && !errMsg.includes('ECONNREFUSED') && !errMsg.includes('ENOTFOUND')) {
      break;
    }
  }

  if (settingsErr || !settingsRow) {
    logError(`Failed to load settings: ${settingsErr?.message || 'No data returned'}`);
    if (settingsErr?.message?.includes('fetch failed')) {
      logError('');
      logError('This usually means one of:');
      logError('  1. Your Supabase project is PAUSED (free-tier auto-pauses after inactivity)');
      logError('     → Go to https://supabase.com/dashboard and unpause your project');
      logError('  2. NEXT_PUBLIC_SUPABASE_URL secret is wrong or expired');
      logError('  3. SUPABASE_SERVICE_ROLE_KEY secret is wrong or expired');
      logError('  4. Network connectivity issue from GitHub Actions runner');
      logError('');
      logError(`  Supabase URL: ${supabaseUrl}`);
    }
    process.exit(1);
  }

  const settings = settingsRow as Settings;
  // Force AI unlimited mode for GitHub Actions batch
  settings.ai_unrestricted = true;
  log('AI Unrestricted Mode: ENABLED');

  // Pre-flight check: verify volume pricing columns exist (migration 006)
  const { error: schemaCheck } = await db
    .from('analyses')
    .select('pricing_method')
    .limit(0);
  if (schemaCheck?.code === 'PGRST204') {
    log('WARNING: Volume pricing columns (pricing_method, volume_pricing) not found.');
    log('WARNING: Please apply migration 006_add_volume_pricing.sql to your Supabase database.');
    log('WARNING: Analysis will still be saved, but without volume pricing metadata.');
  }

  // Pre-flight: check Shopify connectivity (only if we'll be applying prices)
  if (!opts.dryRun && !opts.skipApply && !opts.markup) {
    const shopifyStore = process.env.SHOPIFY_STORE_NAME;
    log(`Checking Shopify connectivity (${shopifyStore})...`);
    try {
      const shopifyResp = await fetch(
        `https://${shopifyStore}.myshopify.com/admin/api/2024-01/shop.json`,
        { headers: { 'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN! } },
      );
      if (shopifyResp.ok) {
        log('Shopify connection: OK');
      } else {
        const body = await shopifyResp.text().catch(() => '');
        logWarn(`Shopify returned ${shopifyResp.status}: ${body.slice(0, 200)}`);
        logWarn('Price updates may fail. Continuing with analysis...');
      }
    } catch (shopifyErr) {
      const msg = shopifyErr instanceof Error ? shopifyErr.message : String(shopifyErr);
      logWarn(`Shopify connectivity check failed: ${msg}`);
      logWarn('Price updates may fail. Continuing with analysis...');
    }
  }

  // ---------------------------------------------------------------------------
  // Determine which variants to process
  // ---------------------------------------------------------------------------
  let toProcess: { product: Product; variant: Variant }[] = [];

  if (opts.productIds) {
    // --product-id mode: load specific products by numeric ID or handle
    log(`Loading ${opts.productIds.length} specific product(s)...`);

    // Separate numeric IDs from handles
    const numericIds: string[] = [];
    const handles: string[] = [];
    for (const id of opts.productIds) {
      if (/^\d+$/.test(id)) {
        numericIds.push(id);
      } else {
        handles.push(id);
      }
    }

    const allProducts: Product[] = [];

    // Load by numeric ID
    if (numericIds.length > 0) {
      const { data, error } = await db
        .from('products')
        .select('*, variants(*)')
        .in('id', numericIds);
      if (error) {
        logError(`Failed to load products by ID: ${error.message}`);
        process.exit(1);
      }
      if (data) allProducts.push(...(data as Product[]));
    }

    // Load by handle
    if (handles.length > 0) {
      const { data, error } = await db
        .from('products')
        .select('*, variants(*)')
        .in('handle', handles);
      if (error) {
        logError(`Failed to load products by handle: ${error.message}`);
        process.exit(1);
      }
      if (data) allProducts.push(...(data as Product[]));
    }

    if (allProducts.length === 0) {
      logError(`No products found matching: ${opts.productIds.join(', ')}`);
      logError('Make sure you have synced products from Shopify first (run a sync).');
      process.exit(1);
    }

    // Flatten to variant list — include ALL variants for each matched product
    for (const product of allProducts) {
      if (!product.variants || product.variants.length === 0) {
        log(`  WARNING: ${product.title} has no variants`);
        continue;
      }
      log(`  Found: ${product.title} (${product.variants.length} variants)`);
      for (const variant of product.variants) {
        toProcess.push({ product, variant });
      }
    }

    log(`Loaded ${allProducts.length} product(s), ${toProcess.length} variants total`);

  } else if (opts.failedReport) {
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
    message: `Batch started: ${toProcess.length} variants (${productGroups.size} products), ${opts.concurrency} workers, ${opts.provider.toUpperCase()}${opts.fast ? ' FAST' : ''}${opts.vendor ? ` (vendor: ${opts.vendor})` : ''}${opts.failedReport ? ' (retry mode)' : ''}${opts.skipAnalyzed ? ' (skip-analyzed)' : ''}${opts.markup ? ` (${opts.markup}x markup)` : ''}, min-conf=${opts.minConfidence}, retry=${opts.maxRetries}, volume-pricing ENABLED, auto-apply${opts.dryRun ? ' (DRY RUN)' : ''}`,
    type: 'info',
  });

  // ---------------------------------------------------------------------------
  // Process all products with streaming worker pool
  // ---------------------------------------------------------------------------
  let completed = 0;
  let failed = 0;
  let applied = 0;
  let volumeDerived = 0;
  let skippedConfidence = 0;
  let flaggedChanges = 0;
  let fatalError: string | null = null;
  let activeWorkers = 0;
  const failedProducts: FailedProduct[] = [];
  const priceChanges: PriceChange[] = [];
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
        confidence: 'low',
        flagged: false,
        flagReason: null,
        previousPrice: v.price || 0,
      }));
    }

    activeWorkers++;

    let taskResults: Array<{ variantId: string; success: boolean; applied: boolean; price: number | null; error: string | null; pricingMethod: 'ai' | 'volume_formula'; confidence: string; flagged: boolean; flagReason: string | null; previousPrice: number }>;

    if (opts.markup) {
      // Markup mode: process each variant individually (no volume logic)
      taskResults = [];
      for (const variant of variantsToProcess) {
        const r = await processVariantMarkup(product, variant, opts.markup!, db, {
          dryRun: opts.dryRun,
          skipApply: opts.skipApply,
          maxPriceChangePct: opts.maxPriceChangePct,
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
          minConfidence: opts.minConfidence,
          maxRetries: opts.maxRetries,
          maxPriceChangePct: opts.maxPriceChangePct,
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

        // Track confidence skips
        if (r.flagReason && r.flagReason.startsWith('Below min confidence')) {
          skippedConfidence++;
        }

        // Track flagged price changes
        if (r.flagged) {
          flaggedChanges++;
        }

        // Record price change for report
        if (r.price && r.price > 0) {
          const variant = variantsToProcess.find(v => v.id === r.variantId);
          const prevPrice = r.previousPrice || 0;
          const changePct = prevPrice > 0 ? Math.abs((r.price - prevPrice) / prevPrice) * 100 : 0;
          priceChanges.push({
            productId: product.id,
            variantId: r.variantId,
            productTitle: product.title,
            variantTitle: variant?.title || 'Default',
            previousPrice: prevPrice,
            newPrice: r.price,
            changePct,
            confidence: r.confidence,
            pricingMethod: r.pricingMethod,
            flagged: r.flagged,
            flagReason: r.flagReason,
          });
        }
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
          retryCount: 0,
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
      logProgress(total, toProcess.length, failed, applied, skippedConfidence, flaggedChanges, activeWorkers);
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

  // Get batch cost summary
  const batchCostTracker = getBatchCostTracker();
  const costSummary = batchCostTracker.getSummary();

  console.log('\n' + '='.repeat(78));
  console.log('  BATCH COMPLETE');
  console.log('='.repeat(78));
  console.log(`  Total:            ${toProcess.length}`);
  console.log(`  Completed:        ${completed}`);
  console.log(`  Failed:           ${failed}`);
  console.log(`  Applied:          ${applied}`);
  console.log(`  Vol. Derived:     ${volumeDerived} (formula-priced, no AI calls)`);
  console.log(`  Skipped (conf):   ${skippedConfidence} (below ${opts.minConfidence} confidence)`);
  console.log(`  Flagged (change): ${flaggedChanges} (exceeded ${opts.maxPriceChangePct || '∞'}% threshold)`);
  console.log(`  Concurrency:      ${opts.concurrency} workers`);
  console.log(`  Rate:             ${rate} products/min`);
  console.log(`  Elapsed:          ${elapsed} minutes`);
  if (opts.maxRetries > 0) {
    console.log(`  Retry policy:     ${opts.maxRetries} retries (exponential backoff)`);
  }
  if (fatalError) {
    console.log(`  FATAL:            ${fatalError}`);
  }
  console.log('='.repeat(78));
  console.log('');
  console.log(batchCostTracker.formatReport());
  console.log(`  Cost per product: $${completed > 0 ? (costSummary.totalCost / completed).toFixed(4) : '0.0000'}`);
  console.log(`  Legacy cost (GPT-5.2): $${costSummary.legacyCostEstimate.toFixed(4)}`);
  console.log(`  Savings: $${costSummary.savings.toFixed(4)} (${costSummary.savingsPercent.toFixed(0)}%)`);
  console.log('='.repeat(78) + '\n');

  // Save price changes report
  const priceReportPath = savePriceChangesReport(priceChanges, globalStartTime);

  // Save failed products report if there were failures
  let failedReportPath: string | null = null;
  if (failedProducts.length > 0) {
    failedReportPath = saveFailedReport(failedProducts, globalStartTime, toProcess.length, applied);
  } else {
    log('No failed products — all variants processed successfully!');
  }

  // Log final result to activity_log
  const costPerProduct = completed > 0 ? (costSummary.totalCost / completed).toFixed(4) : '0';
  await db.from('activity_log').insert({
    message: `Batch finished: ${completed} analyzed (${volumeDerived} vol-derived), ${failed} failed, ${applied} applied, ${skippedConfidence} skipped (conf), ${flaggedChanges} flagged in ${elapsed}min (${rate}/min). Est. cost: $${costSummary.totalCost.toFixed(2)} ($${costPerProduct}/product, saved ${costSummary.savingsPercent.toFixed(0)}% vs GPT-5.2)${fatalError ? ` (FATAL: ${fatalError})` : ''}${failedReportPath ? ` — failed: ${path.basename(failedReportPath)}` : ''}${priceReportPath ? ` — changes: ${path.basename(priceReportPath)}` : ''}`,
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
