import { NextRequest, NextResponse } from 'next/server';
import { updateVariantPrice } from '@/lib/shopify';
import { createServerClient } from '@/lib/supabase';
import { isValidPrice } from '@/lib/constants';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { variantId, newPrice, productId } = body;

    // Validate inputs
    if (!variantId || typeof variantId !== 'string') {
      return NextResponse.json({ success: false, error: 'variantId (string) required' }, { status: 400 });
    }
    if (!isValidPrice(newPrice)) {
      return NextResponse.json({
        success: false,
        error: `Invalid price: ${newPrice}. Must be a number between $1 and $2000.`,
      }, { status: 400 });
    }

    const db = createServerClient();

    // Load current price before updating (for revert support)
    const { data: variant } = await db
      .from('variants')
      .select('price')
      .eq('id', variantId)
      .single();

    if (!variant) {
      return NextResponse.json({ success: false, error: 'Variant not found in database' }, { status: 404 });
    }

    const previousPrice = variant.price;

    // Update price on Shopify first (external system of record)
    await updateVariantPrice(variantId, newPrice);

    // Update local state in parallel
    const updates = [
      db.from('variants').update({ price: newPrice }).eq('id', variantId),
    ];

    if (productId && typeof productId === 'string') {
      updates.push(
        db.from('analyses')
          .update({
            applied: true,
            applied_at: new Date().toISOString(),
            previous_price: previousPrice,
          })
          .match({ product_id: productId, variant_id: variantId })
          .eq('applied', false) as ReturnType<ReturnType<typeof db.from>['update']> // Optimistic lock
      );
    }

    await Promise.all(updates);

    // Log activity
    await db.from('activity_log').insert({
      message: `Price updated: variant ${variantId} $${previousPrice.toFixed(2)} → $${newPrice.toFixed(2)}`,
      type: 'success',
    });

    return NextResponse.json({ success: true, previousPrice });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Unknown error';
    console.error('Update price error:', message);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
