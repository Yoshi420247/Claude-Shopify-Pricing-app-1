import { NextRequest, NextResponse } from 'next/server';
import { updateVariantPrice } from '@/lib/shopify';
import { createServerClient } from '@/lib/supabase';
import { isValidPrice } from '@/lib/constants';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { analysisId } = body;

    if (!analysisId || typeof analysisId !== 'string') {
      return NextResponse.json({ success: false, error: 'analysisId (string) required' }, { status: 400 });
    }

    const db = createServerClient();

    // Load the analysis
    const { data: analysis, error: aErr } = await db
      .from('analyses')
      .select('*')
      .eq('id', analysisId)
      .single();

    if (aErr || !analysis) {
      return NextResponse.json({ success: false, error: 'Analysis not found' }, { status: 404 });
    }

    if (!analysis.suggested_price || !isValidPrice(analysis.suggested_price)) {
      return NextResponse.json({ success: false, error: 'No valid suggested price' }, { status: 400 });
    }

    if (analysis.applied) {
      return NextResponse.json({ success: false, error: 'Already applied' }, { status: 400 });
    }

    // Load current variant price before updating
    const { data: variant } = await db
      .from('variants')
      .select('price')
      .eq('id', analysis.variant_id)
      .single();

    const previousPrice = variant?.price ?? null;

    // Update price on Shopify first (external system of record)
    await updateVariantPrice(analysis.variant_id, analysis.suggested_price);

    // Update local variant price and mark analysis as applied atomically
    // If Shopify succeeded but DB fails, the price is still correct on Shopify
    const [variantUpdate, analysisUpdate] = await Promise.all([
      db.from('variants')
        .update({ price: analysis.suggested_price })
        .eq('id', analysis.variant_id),
      db.from('analyses')
        .update({
          applied: true,
          applied_at: new Date().toISOString(),
          previous_price: previousPrice,
        })
        .eq('id', analysisId)
        .eq('applied', false), // Optimistic lock: only update if still unapplied
    ]);

    if (variantUpdate.error) {
      console.error('Failed to update local variant price:', variantUpdate.error.message);
    }
    if (analysisUpdate.error) {
      console.error('Failed to mark analysis as applied:', analysisUpdate.error.message);
    }

    // Load product for activity log
    const { data: product } = await db
      .from('products')
      .select('title')
      .eq('id', analysis.product_id)
      .single();

    await db.from('activity_log').insert({
      message: `Price applied: ${product?.title || 'Unknown'} → $${analysis.suggested_price.toFixed(2)}${previousPrice ? ` (was $${previousPrice.toFixed(2)})` : ''}`,
      type: 'success',
    });

    return NextResponse.json({ success: true });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Unknown error';
    console.error('Accept analysis error:', message);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
