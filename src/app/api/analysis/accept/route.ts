import { NextRequest, NextResponse } from 'next/server';
import { updateVariantPrice } from '@/lib/shopify';
import { createServerClient } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const { analysisId } = await req.json();

    if (!analysisId) {
      return NextResponse.json({ success: false, error: 'analysisId required' }, { status: 400 });
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

    if (!analysis.suggested_price) {
      return NextResponse.json({ success: false, error: 'No suggested price' }, { status: 400 });
    }

    if (analysis.applied) {
      return NextResponse.json({ success: false, error: 'Already applied' }, { status: 400 });
    }

    // Update price on Shopify
    await updateVariantPrice(analysis.variant_id, analysis.suggested_price);

    // Update local variant price
    await db.from('variants')
      .update({ price: analysis.suggested_price })
      .eq('id', analysis.variant_id);

    // Mark analysis as applied
    await db.from('analyses')
      .update({ applied: true, applied_at: new Date().toISOString() })
      .eq('id', analysisId);

    // Load product for activity log
    const { data: product } = await db
      .from('products')
      .select('title')
      .eq('id', analysis.product_id)
      .single();

    await db.from('activity_log').insert({
      message: `Price applied: ${product?.title || 'Unknown'} → $${analysis.suggested_price.toFixed(2)}`,
      type: 'success',
    });

    return NextResponse.json({ success: true });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Unknown error';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
