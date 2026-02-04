import { NextResponse } from 'next/server';
import { fetchAllProducts, extractId } from '@/lib/shopify';
import { createServerClient } from '@/lib/supabase';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// Batch size for Supabase upserts
const BATCH_SIZE = 100;

export async function POST() {
  try {
    const db = createServerClient();

    console.log('Starting Shopify sync...');
    const shopifyProducts = await fetchAllProducts();
    console.log(`Fetched ${shopifyProducts.length} products from Shopify`);

    if (shopifyProducts.length === 0) {
      return NextResponse.json({
        success: true,
        productsCount: 0,
        variantsCount: 0,
        costsLoaded: 0,
        debug: 'No products returned from Shopify API. Check: 1) Store has products, 2) API token has read_products scope, 3) Products are not all archived/draft',
      });
    }

    // Prepare all products and variants for batch upsert
    const productRows: Array<{
      id: string;
      title: string;
      description: string | null;
      description_html: string | null;
      vendor: string | null;
      product_type: string | null;
      handle: string | null;
      tags: string | null;
      status: string;
      image_url: string | null;
      shopify_gid: string;
      synced_at: string;
    }> = [];

    const variantRows: Array<{
      id: string;
      product_id: string;
      title: string | null;
      sku: string | null;
      price: number;
      compare_at_price: number | null;
      cost: number | null;
      inventory_item_id: string | null;
      shopify_gid: string;
    }> = [];

    let costsLoaded = 0;

    for (const sp of shopifyProducts) {
      const productId = extractId(sp.id);

      productRows.push({
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
      });

      for (const ve of sp.variants.edges) {
        const v = ve.node;
        const variantId = extractId(v.id);
        const inventoryItemId = v.inventoryItem?.id ? extractId(v.inventoryItem.id) : null;
        const cost = v.inventoryItem?.unitCost?.amount
          ? parseFloat(v.inventoryItem.unitCost.amount)
          : null;

        if (cost !== null) costsLoaded++;

        variantRows.push({
          id: variantId,
          product_id: productId,
          title: v.title || null,
          sku: v.sku || null,
          price: parseFloat(v.price),
          compare_at_price: v.compareAtPrice ? parseFloat(v.compareAtPrice) : null,
          cost,
          inventory_item_id: inventoryItemId,
          shopify_gid: v.id,
        });
      }
    }

    console.log(`Prepared ${productRows.length} products and ${variantRows.length} variants for upsert`);

    // Batch upsert products
    let productsUpserted = 0;
    for (let i = 0; i < productRows.length; i += BATCH_SIZE) {
      const batch = productRows.slice(i, i + BATCH_SIZE);
      const { error } = await db.from('products').upsert(batch, { onConflict: 'id' });
      if (error) {
        console.error(`Failed to upsert product batch ${i / BATCH_SIZE + 1}:`, error.message);
      } else {
        productsUpserted += batch.length;
      }
    }
    console.log(`Upserted ${productsUpserted} products`);

    // Batch upsert variants
    let variantsUpserted = 0;
    for (let i = 0; i < variantRows.length; i += BATCH_SIZE) {
      const batch = variantRows.slice(i, i + BATCH_SIZE);
      const { error } = await db.from('variants').upsert(batch, { onConflict: 'id' });
      if (error) {
        console.error(`Failed to upsert variant batch ${i / BATCH_SIZE + 1}:`, error.message);
      } else {
        variantsUpserted += batch.length;
      }
    }
    console.log(`Upserted ${variantsUpserted} variants`);

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
