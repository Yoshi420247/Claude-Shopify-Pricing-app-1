// Process the next chunk of a batch job
// Called repeatedly by the client to process one chunk at a time
// Each chunk: analyze N variants, save results, optionally auto-apply
// All progress is persisted to DB so it survives page refreshes

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

    // Process each variant in the chunk sequentially (to avoid overwhelming APIs)
    let chunkCompleted = 0;
    let chunkFailed = 0;
    let chunkApplied = 0;
    const chunkResults: Array<{
      variantId: string;
      status: 'completed' | 'failed' | 'applied';
      suggestedPrice?: number;
      error?: string;
    }> = [];

    for (const ref of chunk) {
      // Re-check batch status (user might have cancelled mid-chunk)
      const { data: currentBatch } = await db
        .from('batch_jobs')
        .select('status')
        .eq('id', batchId)
        .single();

      if (currentBatch?.status === 'cancelled') {
        break;
      }

      const product = productMap.get(ref.productId);
      const variant = variantMap.get(ref.variantId);

      if (!product || !variant) {
        chunkFailed++;
        chunkResults.push({ variantId: ref.variantId, status: 'failed', error: 'Product or variant not found' });
        continue;
      }

      try {
        // Run analysis
        const result = await runFullAnalysis(product, variant, settings);

        if (result.error) {
          chunkFailed++;
          chunkResults.push({ variantId: ref.variantId, status: 'failed', error: result.error });
        } else {
          // Save analysis
          await saveAnalysis(product.id, variant.id, result);
          chunkCompleted++;

          // Auto-apply if enabled and we have a suggested price
          if (batch.auto_apply && result.suggestedPrice && result.suggestedPrice > 0) {
            try {
              await updateVariantPrice(variant.id, result.suggestedPrice);
              await db.from('variants').update({ price: result.suggestedPrice }).eq('id', variant.id);

              // Mark analysis as applied
              await db
                .from('analyses')
                .update({ applied: true, applied_at: new Date().toISOString() })
                .match({ product_id: product.id, variant_id: variant.id });

              chunkApplied++;
              chunkResults.push({
                variantId: ref.variantId,
                status: 'applied',
                suggestedPrice: result.suggestedPrice,
              });
            } catch (applyErr) {
              // Analysis succeeded but apply failed - still count as completed
              const applyMsg = applyErr instanceof Error ? applyErr.message : 'Apply failed';
              chunkResults.push({
                variantId: ref.variantId,
                status: 'completed',
                suggestedPrice: result.suggestedPrice || undefined,
                error: `Analysis OK, apply failed: ${applyMsg}`,
              });
            }
          } else {
            chunkResults.push({
              variantId: ref.variantId,
              status: 'completed',
              suggestedPrice: result.suggestedPrice || undefined,
            });
          }
        }
      } catch (e) {
        const errorMsg = e instanceof Error ? e.message : 'Unknown error';
        chunkFailed++;
        chunkResults.push({ variantId: ref.variantId, status: 'failed', error: errorMsg });
      }

      // Update progress in DB after each item (crash-safe)
      await db
        .from('batch_jobs')
        .update({
          completed: (batch.completed || 0) + chunkCompleted,
          failed: (batch.failed || 0) + chunkFailed,
          applied: (batch.applied || 0) + chunkApplied,
          current_chunk: batch.current_chunk + 1,
          last_error: chunkResults[chunkResults.length - 1]?.error || batch.last_error,
        })
        .eq('id', batchId);
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
