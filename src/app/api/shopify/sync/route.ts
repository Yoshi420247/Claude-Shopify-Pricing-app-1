import { NextResponse } from 'next/server';
import { fetchAllProducts, extractId } from '@/lib/shopify';
import { createServerClient } from '@/lib/supabase';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST() {
  try {
    const db = createServerClient();
    const shopifyProducts = await fetchAllProducts();

    let productsUpserted = 0;
    let variantsUpserted = 0;
    let costsLoaded = 0;

    for (const sp of shopifyProducts) {
      const productId = extractId(sp.id);

      // Upsert product
      const { error: pErr } = await db.from('products').upsert({
        id: productId,
        title: sp.title,
        description: sp.description || null,
        description_html: sp.descriptionHtml || null,
        vendor: sp.vendor || null,
        product_type: sp.productType || null,
        handle: sp.handle || null,
        tags: sp.tags?.join(', ') || null,
        status: sp.status?.toLowerCase() || 'active',
        image_url: sp.featuredImage?.url || null,
        shopify_gid: sp.id,
        synced_at: new Date().toISOString(),
      }, { onConflict: 'id' });

      if (pErr) {
        console.error(`Failed to upsert product ${productId}:`, pErr);
        continue;
      }
      productsUpserted++;

      // Upsert variants
      for (const ve of sp.variants.edges) {
        const v = ve.node;
        const variantId = extractId(v.id);
        const inventoryItemId = v.inventoryItem?.id ? extractId(v.inventoryItem.id) : null;
        const cost = v.inventoryItem?.unitCost?.amount
          ? parseFloat(v.inventoryItem.unitCost.amount)
          : null;

        if (cost !== null) costsLoaded++;

        const { error: vErr } = await db.from('variants').upsert({
          id: variantId,
          product_id: productId,
          title: v.title || null,
          sku: v.sku || null,
          price: parseFloat(v.price),
          compare_at_price: v.compareAtPrice ? parseFloat(v.compareAtPrice) : null,
          cost,
          inventory_item_id: inventoryItemId,
          shopify_gid: v.id,
        }, { onConflict: 'id' });

        if (vErr) {
          console.error(`Failed to upsert variant ${variantId}:`, vErr);
          continue;
        }
        variantsUpserted++;
      }
    }

    // Log activity
    await db.from('activity_log').insert({
      message: `Synced ${productsUpserted} products, ${variantsUpserted} variants (${costsLoaded} with costs)`,
      type: 'success',
    });

    return NextResponse.json({
      success: true,
      productsCount: productsUpserted,
      variantsCount: variantsUpserted,
      costsLoaded,
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Unknown error';
    console.error('Shopify sync error:', message);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
