// Process the next chunk of a batch job with CONCURRENT analysis
// Called repeatedly by the client to process one chunk at a time
// Each chunk: analyze N variants concurrently (default 3), save results, optionally auto-apply
// All progress is persisted to DB so it survives page refreshes
// Rate limiting is handled by the individual API clients (openai, brave, shopify)

import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@/lib/supabase';
import { runFullAnalysis, saveAnalysis } from '@/lib/pricing-engine';
import { updateVariantPrice } from '@/lib/shopify';
import type { Product, Variant, Settings } from '@/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 300; // 5 minutes per chunk

interface VariantRef {
  productId: string;
  variantId: string;
}

interface ChunkResult {
  variantId: string;
  status: 'completed' | 'failed' | 'applied';
  suggestedPrice?: number;
  error?: string;
}

// Process a single variant (analysis + optional auto-apply)
async function processOneVariant(
  ref: VariantRef,
  productMap: Map<string, Product>,
  variantMap: Map<string, Variant>,
  settings: Settings,
  autoApply: boolean,
  db: ReturnType<typeof createServerClient>,
): Promise<{ result: ChunkResult; completed: boolean; applied: boolean }> {
  const product = productMap.get(ref.productId);
  const variant = variantMap.get(ref.variantId);

  if (!product || !variant) {
    return {
      result: { variantId: ref.variantId, status: 'failed', error: 'Product or variant not found' },
      completed: false,
      applied: false,
    };
  }

  try {
    const analysisResult = await runFullAnalysis(product, variant, settings);

    if (analysisResult.error) {
      return {
        result: { variantId: ref.variantId, status: 'failed', error: analysisResult.error },
        completed: false,
        applied: false,
      };
    }

    // Save analysis to DB
    await saveAnalysis(product.id, variant.id, analysisResult);

    // Auto-apply if enabled and we have a suggested price
    if (autoApply && analysisResult.suggestedPrice && analysisResult.suggestedPrice > 0) {
      try {
        await updateVariantPrice(variant.id, analysisResult.suggestedPrice);
        await db.from('variants').update({ price: analysisResult.suggestedPrice }).eq('id', variant.id);
        await db
          .from('analyses')
          .update({ applied: true, applied_at: new Date().toISOString() })
          .match({ product_id: product.id, variant_id: variant.id });

        return {
          result: { variantId: ref.variantId, status: 'applied', suggestedPrice: analysisResult.suggestedPrice },
          completed: true,
          applied: true,
        };
      } catch (applyErr) {
        const applyMsg = applyErr instanceof Error ? applyErr.message : 'Apply failed';
        return {
          result: {
            variantId: ref.variantId,
            status: 'completed',
            suggestedPrice: analysisResult.suggestedPrice || undefined,
            error: `Analysis OK, apply failed: ${applyMsg}`,
          },
          completed: true,
          applied: false,
        };
      }
    }

    return {
      result: { variantId: ref.variantId, status: 'completed', suggestedPrice: analysisResult.suggestedPrice || undefined },
      completed: true,
      applied: false,
    };
  } catch (e) {
    const errorMsg = e instanceof Error ? e.message : 'Unknown error';
    return {
      result: { variantId: ref.variantId, status: 'failed', error: errorMsg },
      completed: false,
      applied: false,
    };
  }
}

// Run tasks with a concurrency limit (semaphore pattern)
async function runWithConcurrency<T>(
  tasks: (() => Promise<T>)[],
  limit: number,
  onItemDone?: (result: T, index: number) => void,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < tasks.length) {
      const idx = nextIndex++;
      try {
        results[idx] = await tasks[idx]();
      } catch (e) {
        // Should not happen since tasks handle their own errors, but just in case
        results[idx] = { error: e instanceof Error ? e.message : 'Worker error' } as T;
      }
      onItemDone?.(results[idx], idx);
    }
  }

  // Launch `limit` workers that pull from the task queue
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
  await Promise.all(workers);

  return results;
}

export async function POST(req: NextRequest) {
  try {
    const { batchId } = await req.json();

    if (!batchId) {
      return NextResponse.json({ success: false, error: 'batchId required' }, { status: 400 });
    }

    const db = createServerClient();

    // Load batch job
    const { data: batch, error: batchErr } = await db
      .from('batch_jobs')
      .select('*')
      .eq('id', batchId)
      .single();

    if (batchErr || !batch) {
      return NextResponse.json({ success: false, error: 'Batch not found' }, { status: 404 });
    }

    // Check if batch is still active
    if (batch.status === 'cancelled' || batch.status === 'completed') {
      return NextResponse.json({
        success: true,
        done: true,
        reason: batch.status,
        batch: formatBatch(batch),
      });
    }

    // Mark as running
    if (batch.status === 'pending' || batch.status === 'paused') {
      await db
        .from('batch_jobs')
        .update({ status: 'running', started_at: batch.started_at || new Date().toISOString() })
        .eq('id', batchId);
    }

    // Load settings
    const { data: settingsRow } = await db.from('settings').select('*').single();
    const settings = (settingsRow as Settings) || {
      min_margin: 30,
      min_margin_dollars: 5,
      max_above: 20,
      max_increase: 30,
      max_decrease: 20,
      rounding_style: 'psychological',
      respect_msrp: true,
      openai_model: 'gpt-5.2',
      product_niche: 'smoke shop, heady glass, dab tools',
    };

    // Override AI unrestricted from batch settings
    if (batch.ai_unrestricted) {
      settings.ai_unrestricted = true;
    }

    // Calculate which variants to process in this chunk
    const allVariants: VariantRef[] = batch.variant_ids || [];
    const processed = (batch.completed || 0) + (batch.failed || 0);
    const chunkSize = batch.chunk_size || 50;
    const chunk = allVariants.slice(processed, processed + chunkSize);

    if (chunk.length === 0) {
      // All done
      await db
        .from('batch_jobs')
        .update({ status: 'completed', completed_at: new Date().toISOString() })
        .eq('id', batchId);

      const { data: finalBatch } = await db.from('batch_jobs').select('*').eq('id', batchId).single();

      await db.from('activity_log').insert({
        message: `Batch completed: ${batch.completed} analyzed, ${batch.failed} failed${batch.auto_apply ? `, ${batch.applied} applied` : ''}`,
        type: 'success',
      });

      return NextResponse.json({
        success: true,
        done: true,
        reason: 'completed',
        batch: formatBatch(finalBatch || batch),
      });
    }

    // Load all products and variants needed for this chunk
    const productIds = [...new Set(chunk.map(v => v.productId))];
    const variantIds = chunk.map(v => v.variantId);

    const [{ data: products }, { data: variants }] = await Promise.all([
      db.from('products').select('*').in('id', productIds),
      db.from('variants').select('*').in('id', variantIds),
    ]);

    const productMap = new Map((products || []).map(p => [p.id, p as Product]));
    const variantMap = new Map((variants || []).map(v => [v.id, v as Variant]));

    // Concurrency: use settings.concurrency (1-10, default 3)
    // Brave is the bottleneck at 0.5 req/sec (15/min) — rate limiter queues naturally
    // OpenAI at 5 req/sec handles 3-5 concurrent streams easily
    // Higher concurrency = more overlap between slow Brave waits and OpenAI calls
    const concurrency = Math.min(Math.max(settings.concurrency || 3, 1), 10);

    let chunkCompleted = 0;
    let chunkFailed = 0;
    let chunkApplied = 0;
    const chunkResults: ChunkResult[] = [];
    let cancelled = false;

    // Check for cancellation periodically (every 5 completed items, not every item)
    let itemsSinceCheck = 0;
    const CANCEL_CHECK_INTERVAL = 5;

    // Build task array for concurrent execution
    const tasks = chunk.map((ref) => async () => {
      // Check cancellation before starting a new analysis
      if (cancelled) {
        return {
          result: { variantId: ref.variantId, status: 'failed' as const, error: 'Batch cancelled' },
          completed: false,
          applied: false,
        };
      }

      return processOneVariant(ref, productMap, variantMap, settings, batch.auto_apply, db);
    });

    // Process chunk with concurrency limit
    const outcomes = await runWithConcurrency(tasks, concurrency, (outcome, _idx) => {
      if (!outcome || cancelled) return;

      const { result, completed, applied } = outcome;
      chunkResults.push(result);

      if (result.status === 'failed' && result.error !== 'Batch cancelled') {
        chunkFailed++;
      } else if (completed) {
        chunkCompleted++;
      }
      if (applied) {
        chunkApplied++;
      }

      itemsSinceCheck++;

      // Periodically update progress in DB (crash-safe) and check cancellation
      if (itemsSinceCheck >= CANCEL_CHECK_INTERVAL) {
        itemsSinceCheck = 0;

        // Fire-and-forget progress update (don't await to avoid blocking concurrent work)
        void (async () => {
          try {
            await db.from('batch_jobs')
              .update({
                completed: (batch.completed || 0) + chunkCompleted,
                failed: (batch.failed || 0) + chunkFailed,
                applied: (batch.applied || 0) + chunkApplied,
                current_chunk: (batch.current_chunk || 0) + 1,
                last_error: result.error || batch.last_error,
              })
              .eq('id', batchId);

            // Also check cancellation
            const { data: statusCheck } = await db
              .from('batch_jobs')
              .select('status')
              .eq('id', batchId)
              .single();

            if (statusCheck?.status === 'cancelled') {
              cancelled = true;
            }
          } catch {
            /* ignore progress update failures */
          }
        })();
      }
    });

    // Ensure we captured any results from the last few items
    // (the onItemDone callback above may have missed some due to concurrency timing)
    for (const outcome of outcomes) {
      if (outcome && !chunkResults.some(r => r.variantId === outcome.result.variantId)) {
        const { result, completed, applied } = outcome;
        chunkResults.push(result);
        if (result.status === 'failed' && result.error !== 'Batch cancelled') {
          chunkFailed++;
        } else if (completed) {
          chunkCompleted++;
        }
        if (applied) {
          chunkApplied++;
        }
      }
    }

    // Final update for this chunk
    const newCompleted = (batch.completed || 0) + chunkCompleted;
    const newFailed = (batch.failed || 0) + chunkFailed;
    const newApplied = (batch.applied || 0) + chunkApplied;
    const totalProcessed = newCompleted + newFailed;
    const isDone = totalProcessed >= batch.total_variants;

    await db
      .from('batch_jobs')
      .update({
        completed: newCompleted,
        failed: newFailed,
        applied: newApplied,
        current_chunk: (batch.current_chunk || 0) + 1,
        status: isDone ? 'completed' : 'running',
        completed_at: isDone ? new Date().toISOString() : null,
      })
      .eq('id', batchId);

    if (isDone) {
      await db.from('activity_log').insert({
        message: `Batch completed: ${newCompleted} analyzed, ${newFailed} failed${batch.auto_apply ? `, ${newApplied} auto-applied` : ''}`,
        type: 'success',
      });
    }

    // Reload batch for response
    const { data: updatedBatch } = await db.from('batch_jobs').select('*').eq('id', batchId).single();

    return NextResponse.json({
      success: true,
      done: isDone,
      concurrency,
      chunkResults,
      chunkCompleted,
      chunkFailed,
      chunkApplied,
      batch: formatBatch(updatedBatch || batch),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown error';
    console.error('Batch process error:', message);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

function formatBatch(b: Record<string, unknown>) {
  return {
    id: b.id,
    name: b.name,
    totalVariants: b.total_variants,
    chunkSize: b.chunk_size,
    autoApply: b.auto_apply,
    aiUnrestricted: b.ai_unrestricted,
    completed: b.completed,
    failed: b.failed,
    applied: b.applied,
    status: b.status,
    currentChunk: b.current_chunk,
    lastError: b.last_error,
    createdAt: b.created_at,
    startedAt: b.started_at,
    completedAt: b.completed_at,
  };
}
