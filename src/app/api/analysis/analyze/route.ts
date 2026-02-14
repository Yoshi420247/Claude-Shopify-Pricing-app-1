import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@/lib/supabase';
import { runVolumeAwareAnalysis, saveAnalysis } from '@/lib/pricing-engine';
import type { Product, Variant, Settings } from '@/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 300; // 5 minutes - analysis involves multiple API calls

export async function POST(req: NextRequest) {
  try {
    const { productId, variantId, ai_unrestricted } = await req.json();

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

    // Load ALL variants for this product (needed for quantity group detection)
    const { data: allVariants, error: avErr } = await db
      .from('variants')
      .select('*')
      .eq('product_id', productId);
    if (avErr || !allVariants || allVariants.length === 0) {
      return NextResponse.json({ success: false, error: 'No variants found for product' }, { status: 404 });
    }

    // Load settings
    const { data: settingsRows } = await db.from('settings').select('*').limit(1);
    const settings = settingsRows?.[0] as Settings | undefined;
    if (!settings) {
      return NextResponse.json({ success: false, error: 'Settings not configured' }, { status: 400 });
    }

    // Override ai_unrestricted from client (stored in localStorage, may not be in DB)
    if (typeof ai_unrestricted === 'boolean') {
      settings.ai_unrestricted = ai_unrestricted;
    }

    // Run volume-aware analysis pipeline
    // If the product has quantity variants, this will:
    //   - AI-analyze only the base (lowest qty) variant
    //   - Derive all other quantity variants via power-law formula
    // If not, it runs normal AI analysis on the requested variant.
    const { results, quantityGroups } = await runVolumeAwareAnalysis(
      product as Product,
      allVariants as Variant[],
      variantId,
      settings,
    );

    // Save all results to database
    for (const r of results) {
      await saveAnalysis(r.productId, r.variantId, r.analysisResult, r.volumeMeta);
    }

    // Log activity
    const targetResult = results.find(r => r.variantId === variantId) || results[0];
    const targetVariant = allVariants.find((v: Variant) => v.id === variantId);
    const priceStr = targetResult.analysisResult.suggestedPrice
      ? `$${targetResult.analysisResult.suggestedPrice.toFixed(2)}`
      : 'N/A';
    const confidence = targetResult.analysisResult.confidence || 'unknown';

    if (quantityGroups) {
      const derivedCount = results.filter(r => r.volumeMeta.pricing_method === 'volume_formula').length;
      await db.from('activity_log').insert({
        message: `Analyzed: ${product.title} (${targetVariant?.title || 'Default'}) → ${priceStr} (${confidence}) + ${derivedCount} qty variants derived via volume formula`,
        type: targetResult.analysisResult.error ? 'error' : 'success',
      });
    } else {
      await db.from('activity_log').insert({
        message: `Analyzed: ${product.title} (${targetVariant?.title || 'Default'}) → ${priceStr} (${confidence})`,
        type: targetResult.analysisResult.error ? 'error' : 'success',
      });
    }

    // Return the saved analysis for the requested variant
    const { data: savedAnalysis } = await db
      .from('analyses')
      .select('*')
      .match({ product_id: productId, variant_id: variantId })
      .single();

    // Also return sibling analyses if quantity groups were detected
    let siblingAnalyses = null;
    if (quantityGroups && results.length > 1) {
      const siblingIds = results
        .filter(r => r.variantId !== variantId)
        .map(r => r.variantId);
      if (siblingIds.length > 0) {
        const { data: siblings } = await db
          .from('analyses')
          .select('*')
          .in('variant_id', siblingIds);
        siblingAnalyses = siblings;
      }
    }

    return NextResponse.json({
      success: true,
      analysis: savedAnalysis,
      siblingAnalyses,
      quantityGroupDetected: !!quantityGroups,
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Unknown error';
    console.error('Analysis error:', message);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
