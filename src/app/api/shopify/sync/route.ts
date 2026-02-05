import { fetchAllProducts, extractId } from '@/lib/shopify';
import { createServerClient } from '@/lib/supabase';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// Batch size for Supabase upserts
const BATCH_SIZE = 100;

export async function POST() {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      // Helper to send SSE events
      function send(data: Record<string, unknown>) {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          // Stream might be closed
        }
      }

      try {
        const db = createServerClient();

        send({ phase: 'fetching', message: 'Connecting to Shopify...' });

        const shopifyProducts = await fetchAllProducts((event) => {
          send(event);
        });

        if (shopifyProducts.length === 0) {
          send({
            phase: 'complete',
            success: true,
            productsCount: 0,
            variantsCount: 0,
            costsLoaded: 0,
            message: 'No products found. Check that your store has products and your API token has read_products scope.',
          });
          controller.close();
          return;
        }

        send({ phase: 'saving', message: `Processing ${shopifyProducts.length} products...` });

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

            if (cost !== null && !isNaN(cost)) costsLoaded++;

            variantRows.push({
              id: variantId,
              product_id: productId,
              title: v.title || null,
              sku: v.sku || null,
              price: parseFloat(v.price),
              compare_at_price: v.compareAtPrice ? parseFloat(v.compareAtPrice) : null,
              cost: cost !== null && !isNaN(cost) ? cost : null,
              inventory_item_id: inventoryItemId,
              shopify_gid: v.id,
            });
          }
        }

        send({ phase: 'saving', message: `Saving ${productRows.length} products and ${variantRows.length} variants to database...` });

        // Batch upsert products
        let productsUpserted = 0;
        const productErrors: string[] = [];
        for (let i = 0; i < productRows.length; i += BATCH_SIZE) {
          const batch = productRows.slice(i, i + BATCH_SIZE);
          const { error } = await db.from('products').upsert(batch, { onConflict: 'id' });
          if (error) {
            const msg = `Product batch ${Math.floor(i / BATCH_SIZE) + 1} failed: ${error.message}`;
            console.error(msg);
            productErrors.push(msg);
          } else {
            productsUpserted += batch.length;
          }

          // Progress update every 5 batches
          if ((i / BATCH_SIZE) % 5 === 4) {
            send({ phase: 'saving', message: `Saved ${productsUpserted} products...` });
          }
        }

        // Batch upsert variants
        let variantsUpserted = 0;
        const variantErrors: string[] = [];
        for (let i = 0; i < variantRows.length; i += BATCH_SIZE) {
          const batch = variantRows.slice(i, i + BATCH_SIZE);
          const { error } = await db.from('variants').upsert(batch, { onConflict: 'id' });
          if (error) {
            const msg = `Variant batch ${Math.floor(i / BATCH_SIZE) + 1} failed: ${error.message}`;
            console.error(msg);
            variantErrors.push(msg);
          } else {
            variantsUpserted += batch.length;
          }

          // Progress update every 5 batches
          if ((i / BATCH_SIZE) % 5 === 4) {
            send({ phase: 'saving', message: `Saved ${variantsUpserted} variants...` });
          }
        }

        // Log activity
        const allErrors = [...productErrors, ...variantErrors];
        await db.from('activity_log').insert({
          message: `Synced ${productsUpserted} products, ${variantsUpserted} variants (${costsLoaded} with costs)${allErrors.length > 0 ? ` — ${allErrors.length} batch errors` : ''}`,
          type: allErrors.length > 0 ? 'warning' : 'success',
        });

        send({
          phase: 'complete',
          success: true,
          productsCount: productsUpserted,
          variantsCount: variantsUpserted,
          costsLoaded,
          totalProducts: productRows.length,
          totalVariants: variantRows.length,
          errors: allErrors.length > 0 ? allErrors : undefined,
          message: allErrors.length > 0
            ? `Synced ${productsUpserted}/${productRows.length} products, ${variantsUpserted}/${variantRows.length} variants. ${allErrors.length} batch errors.`
            : `Synced ${productsUpserted} products, ${variantsUpserted} variants (${costsLoaded} with costs)`,
        });
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : 'Unknown error';
        console.error('Shopify sync error:', message);
        send({ phase: 'error', message, success: false });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}
