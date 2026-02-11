// Bulk apply all unapplied suggestions from a completed batch
// Applies prices to Shopify for all variants that have suggestions but haven't been applied yet

import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@/lib/supabase';
import { updateVariantPrice } from '@/lib/shopify';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  try {
    const { batchId } = await req.json();

    if (!batchId) {
      return NextResponse.json({ success: false, error: 'batchId required' }, { status: 400 });
    }

    const db = createServerClient();

    // Load batch
    const { data: batch } = await db
      .from('batch_jobs')
      .select('*')
      .eq('id', batchId)
      .single();

    if (!batch) {
      return NextResponse.json({ success: false, error: 'Batch not found' }, { status: 404 });
    }

    // Get all variant IDs from this batch
    const variantIds = (batch.variant_ids as Array<{ variantId: string }>).map(v => v.variantId);

    // Find all unapplied analyses for these variants
    const { data: analyses } = await db
      .from('analyses')
      .select('id, variant_id, product_id, suggested_price, previous_price')
      .in('variant_id', variantIds)
      .eq('applied', false)
      .not('suggested_price', 'is', null)
      .is('error', null);

    if (!analyses || analyses.length === 0) {
      return NextResponse.json({
        success: true,
        applied: 0,
        message: 'No unapplied suggestions found',
      });
    }

    let applied = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const analysis of analyses) {
      try {
        // Load current variant price before updating (for revert support)
        const { data: variant } = await db
          .from('variants')
          .select('price')
          .eq('id', analysis.variant_id)
          .single();

        // Update price on Shopify
        await updateVariantPrice(analysis.variant_id, analysis.suggested_price);

        // Update local variant price
        await db.from('variants')
          .update({ price: analysis.suggested_price })
          .eq('id', analysis.variant_id);

        // Mark analysis as applied (save old price for revert support)
        await db.from('analyses')
          .update({ applied: true, applied_at: new Date().toISOString(), previous_price: variant?.price ?? null })
          .eq('id', analysis.id);

        applied++;
      } catch (e) {
        failed++;
        const msg = e instanceof Error ? e.message : 'Unknown error';
        errors.push(`${analysis.variant_id}: ${msg}`);
      }
    }

    // Update batch applied count
    await db
      .from('batch_jobs')
      .update({ applied: (batch.applied || 0) + applied })
      .eq('id', batchId);

    // Log activity
    await db.from('activity_log').insert({
      message: `Bulk applied ${applied} prices from batch${failed > 0 ? ` (${failed} failed)` : ''}`,
      type: applied > 0 ? 'success' : 'warning',
    });

    return NextResponse.json({
      success: true,
      applied,
      failed,
      errors: errors.slice(0, 5), // Return first 5 errors
      total: analyses.length,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown error';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
