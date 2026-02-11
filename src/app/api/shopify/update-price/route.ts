import { NextRequest, NextResponse } from 'next/server';
import { updateVariantPrice } from '@/lib/shopify';
import { createServerClient } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const { variantId, newPrice, productId } = await req.json();

    if (!variantId || !newPrice || newPrice <= 0) {
      return NextResponse.json({ success: false, error: 'Invalid parameters' }, { status: 400 });
    }

    const db = createServerClient();

    // Load current price before updating (for revert support)
    const { data: variant } = await db
      .from('variants')
      .select('price')
      .eq('id', variantId)
      .single();

    // Update price on Shopify
    await updateVariantPrice(variantId, newPrice);

    // Update local variant price in Supabase
    await db.from('variants').update({ price: newPrice }).eq('id', variantId);

    // Mark analysis as applied (save old price for revert support)
    if (productId) {
      await db.from('analyses')
        .update({ applied: true, applied_at: new Date().toISOString(), previous_price: variant?.price ?? null })
        .match({ product_id: productId, variant_id: variantId });
    }

    // Log activity
    await db.from('activity_log').insert({
      message: `Price updated: variant ${variantId} → $${newPrice.toFixed(2)}`,
      type: 'success',
    });

    return NextResponse.json({ success: true });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Unknown error';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
