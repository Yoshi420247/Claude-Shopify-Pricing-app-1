import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@/lib/supabase';
import { runFullAnalysis, saveAnalysis } from '@/lib/pricing-engine';
import type { Product, Variant, Settings } from '@/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 300; // 5 minutes - analysis involves multiple API calls

export async function POST(req: NextRequest) {
  try {
    const { productId, variantId } = await req.json();

    if (!productId || !variantId) {
      return NextResponse.json({ success: false, error: 'productId and variantId required' }, { status: 400 });
    }

    const db = createServerClient();

    // Load product
    const { data: product, error: pErr } = await db
      .from('products')
      .select('*')
      .eq('id', productId)
      .single();
    if (pErr || !product) {
      return NextResponse.json({ success: false, error: 'Product not found' }, { status: 404 });
    }

    // Load variant
    const { data: variant, error: vErr } = await db
      .from('variants')
      .select('*')
      .eq('id', variantId)
      .single();
    if (vErr || !variant) {
      return NextResponse.json({ success: false, error: 'Variant not found' }, { status: 404 });
    }

    // Load settings
    const { data: settingsRows } = await db.from('settings').select('*').limit(1);
    const settings = settingsRows?.[0] as Settings | undefined;
    if (!settings) {
      return NextResponse.json({ success: false, error: 'Settings not configured' }, { status: 400 });
    }

    // Run full analysis pipeline
    const result = await runFullAnalysis(
      product as Product,
      variant as Variant,
      settings
    );

    // Save to database
    await saveAnalysis(productId, variantId, result);

    // Log activity
    const priceStr = result.suggestedPrice ? `$${result.suggestedPrice.toFixed(2)}` : 'N/A';
    const confidence = result.confidence || 'unknown';
    await db.from('activity_log').insert({
      message: `Analyzed: ${product.title} (${variant.title || 'Default'}) → ${priceStr} (${confidence})`,
      type: result.error ? 'error' : 'success',
    });

    // Return the saved analysis
    const { data: savedAnalysis } = await db
      .from('analyses')
      .select('*')
      .match({ product_id: productId, variant_id: variantId })
      .single();

    return NextResponse.json({ success: true, analysis: savedAnalysis });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Unknown error';
    console.error('Analysis error:', message);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
