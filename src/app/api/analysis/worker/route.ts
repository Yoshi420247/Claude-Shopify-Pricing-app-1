// Background worker for processing analysis queue
// Processes jobs in batches, shares research across similar products

import { NextResponse } from 'next/server';
import { createServerClient } from '@/lib/supabase';
import { getNextJobBatch, updateJobStatus, getQueueStats } from '@/lib/batch-analyzer';
import { runFullAnalysis, saveAnalysis } from '@/lib/pricing-engine';
import { searchCompetitors } from '@/lib/competitors';
import type { Product, Variant, Settings, ProductIdentity } from '@/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 300; // 5 minutes

// Shared research cache for the current batch
interface GroupResearch {
  competitorData: Awaited<ReturnType<typeof searchCompetitors>>;
  timestamp: number;
}

// POST: Process next batch of jobs
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const maxJobsPerRun = body.maxJobs || 20;
    const shareResearch = body.shareResearch !== false;

    const db = createServerClient();

    // Get settings
    const { data: settingsRow } = await db.from('settings').select('*').single();
    const settings = (settingsRow as Settings) || {
      min_margin: 30,
      min_margin_dollars: 5,
      max_above: 20,
      max_increase: 30,
      max_decrease: 20,
      rounding_style: 'x.99',
      respect_msrp: true,
      openai_model: 'gpt-5.2',
      product_niche: 'smoke shop, heady glass, dab tools',
    };

    const results: Array<{
      jobId: string;
      variantId: string;
      status: 'completed' | 'failed';
      suggestedPrice?: number;
      error?: string;
    }> = [];

    let processedCount = 0;
    const groupResearchCache = new Map<string, GroupResearch>();

    while (processedCount < maxJobsPerRun) {
      // Get next batch (grouped by category)
      const batch = await getNextJobBatch(Math.min(10, maxJobsPerRun - processedCount));
      if (!batch) break;

      console.log(`Processing batch of ${batch.jobs.length} jobs for group: ${batch.groupKey}`);

      // Load products and variants for this batch
      const variantIds = batch.jobs.map(j => j.variantId);
      const productIds = [...new Set(batch.jobs.map(j => j.productId))];

      const { data: products } = await db
        .from('products')
        .select('*')
        .in('id', productIds);

      const { data: variants } = await db
        .from('variants')
        .select('*')
        .in('id', variantIds);

      if (!products || !variants) {
        for (const job of batch.jobs) {
          await updateJobStatus(job.id, 'failed', 'Failed to load product data');
          results.push({ jobId: job.id, variantId: job.variantId, status: 'failed', error: 'Failed to load data' });
        }
        processedCount += batch.jobs.length;
        continue;
      }

      const productMap = new Map(products.map(p => [p.id, p as Product]));
      const variantMap = new Map(variants.map(v => [v.id, v as Variant]));

      // Try to get or create shared research for this group
      let sharedResearch: GroupResearch | null = null;
      if (shareResearch) {
        sharedResearch = groupResearchCache.get(batch.groupKey) || null;

        if (!sharedResearch) {
          // Check database for recent research
          const { data: existingResearch } = await db
            .from('group_research')
            .select('*')
            .eq('group_key', batch.groupKey)
            .gt('expires_at', new Date().toISOString())
            .single();

          if (existingResearch) {
            console.log(`Using existing research for group: ${batch.groupKey}`);
            sharedResearch = {
              competitorData: {
                competitors: existingResearch.competitor_prices || [],
                rawResults: [],
                excluded: [],
                queries: existingResearch.search_queries || [],
              },
              timestamp: new Date(existingResearch.created_at).getTime(),
            };
          }
        }
      }

      // Process each job in the batch
      for (const job of batch.jobs) {
        const product = productMap.get(job.productId);
        const variant = variantMap.get(job.variantId);

        if (!product || !variant) {
          await updateJobStatus(job.id, 'failed', 'Product or variant not found');
          results.push({ jobId: job.id, variantId: job.variantId, status: 'failed', error: 'Not found' });
          processedCount++;
          continue;
        }

        try {
          // Run analysis (will use shared research if available via pricing engine)
          const result = await runFullAnalysis(product, variant, settings);

          if (result.error) {
            await updateJobStatus(job.id, 'failed', result.error);
            results.push({ jobId: job.id, variantId: job.variantId, status: 'failed', error: result.error });
          } else {
            // Save analysis result
            await saveAnalysis(product.id, variant.id, result);
            await updateJobStatus(job.id, 'completed');
            results.push({
              jobId: job.id,
              variantId: job.variantId,
              status: 'completed',
              suggestedPrice: result.suggestedPrice || undefined,
            });

            // Cache research for this group if we did fresh research
            if (!sharedResearch && result.competitorAnalysis && result.searchQueries.length > 0) {
              const research: GroupResearch = {
                competitorData: {
                  competitors: result.competitorAnalysis.kept?.map(k => ({
                    source: k.source,
                    url: k.url,
                    title: '',
                    price: k.price,
                    extractionMethod: 'ai-analysis',
                    isKnownRetailer: false,
                    inStock: true,
                  })) || [],
                  rawResults: [],
                  excluded: [],
                  queries: result.searchQueries,
                },
                timestamp: Date.now(),
              };
              groupResearchCache.set(batch.groupKey, research);

              // Also save to database for future batches
              await db.from('group_research').upsert({
                group_key: batch.groupKey,
                vendor: product.vendor,
                product_type: product.product_type,
                competitor_prices: research.competitorData.competitors,
                search_queries: result.searchQueries,
                created_at: new Date().toISOString(),
                expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
              }, { onConflict: 'group_key' });
            }
          }
        } catch (e) {
          const errorMsg = e instanceof Error ? e.message : 'Unknown error';
          await updateJobStatus(job.id, 'failed', errorMsg);
          results.push({ jobId: job.id, variantId: job.variantId, status: 'failed', error: errorMsg });
        }

        processedCount++;
      }
    }

    const stats = await getQueueStats();

    return NextResponse.json({
      success: true,
      processed: processedCount,
      results,
      queueStats: stats,
      hasMoreJobs: stats.pending > 0,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown error';
    console.error('Worker error:', message);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

// GET: Get worker status and queue stats
export async function GET() {
  try {
    const stats = await getQueueStats();
    return NextResponse.json({ success: true, stats });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown error';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
