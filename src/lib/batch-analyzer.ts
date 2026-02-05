// Smart batch analysis system - works like a skilled employee
// Groups similar products, shares research, processes efficiently

import { createServerClient } from './supabase';
import type { Product, Variant, Settings } from '@/types';

interface ProductGroup {
  key: string; // vendor:productType combination
  vendor: string | null;
  productType: string | null;
  products: Array<{ product: Product; variants: Variant[] }>;
  sharedResearch: SharedResearch | null;
}

interface SharedResearch {
  competitorPrices: Array<{
    source: string;
    url: string;
    minPrice: number;
    maxPrice: number;
    avgPrice: number;
  }>;
  marketInsights: {
    priceRange: { low: number; high: number };
    medianPrice: number;
    typicalMargin: number;
  } | null;
  searchQueries: string[];
  timestamp: number;
}

interface AnalysisJob {
  id: string;
  productId: string;
  variantId: string;
  groupKey: string;
  priority: number; // Higher = more important
  status: 'pending' | 'processing' | 'completed' | 'failed';
  attempts: number;
  error?: string;
  createdAt: Date;
}

// Group products intelligently for batch processing
export function groupProductsForAnalysis(
  products: Product[],
  variants: Variant[]
): ProductGroup[] {
  const variantsByProduct = new Map<string, Variant[]>();
  for (const v of variants) {
    const existing = variantsByProduct.get(v.product_id) || [];
    existing.push(v);
    variantsByProduct.set(v.product_id, existing);
  }

  const groups = new Map<string, ProductGroup>();

  for (const product of products) {
    const productVariants = variantsByProduct.get(product.id) || [];
    if (productVariants.length === 0) continue;

    // Create group key from vendor + product type
    const vendor = product.vendor?.toLowerCase().trim() || 'unknown';
    const type = product.product_type?.toLowerCase().trim() || 'unknown';
    const key = `${vendor}:${type}`;

    if (!groups.has(key)) {
      groups.set(key, {
        key,
        vendor: product.vendor,
        productType: product.product_type,
        products: [],
        sharedResearch: null,
      });
    }

    groups.get(key)!.products.push({
      product,
      variants: productVariants,
    });
  }

  // Sort groups by size (larger groups first - more efficient)
  return [...groups.values()].sort((a, b) => b.products.length - a.products.length);
}

// Calculate priority for a variant (higher = analyze first)
export function calculatePriority(product: Product, variant: Variant, existingAnalysis: boolean): number {
  let priority = 50; // Base priority

  // Higher priority for products without analysis
  if (!existingAnalysis) priority += 30;

  // Higher priority for active products
  if (product.status === 'active') priority += 20;

  // Higher priority for higher-priced items (more revenue impact)
  if (variant.price > 100) priority += 15;
  else if (variant.price > 50) priority += 10;
  else if (variant.price > 20) priority += 5;

  // Lower priority if recently analyzed (would need analysis timestamp)
  // Higher priority for negative margin
  if (variant.cost && variant.price < variant.cost) priority += 25;

  // Lower priority for draft products
  if (product.status === 'draft') priority -= 10;

  return priority;
}

// Create analysis jobs for a batch of products
export async function createAnalysisJobs(
  productIds: string[] | 'all',
  options: {
    skipExisting?: boolean;
    prioritizeActive?: boolean;
    maxJobs?: number;
  } = {}
): Promise<{ created: number; skipped: number }> {
  const db = createServerClient();

  // Load products and variants
  let productsQuery = db.from('products').select('*');
  if (productIds !== 'all') {
    productsQuery = productsQuery.in('id', productIds);
  }
  const { data: products } = await productsQuery;

  const { data: variants } = await db.from('variants').select('*');

  if (!products || !variants) {
    return { created: 0, skipped: 0 };
  }

  // Get existing analyses if skipping
  let analyzedVariantIds = new Set<string>();
  if (options.skipExisting) {
    const { data: analyses } = await db.from('analyses').select('variant_id');
    analyzedVariantIds = new Set((analyses || []).map(a => a.variant_id));
  }

  // Group products
  const groups = groupProductsForAnalysis(products as Product[], variants as Variant[]);

  // Create jobs
  const jobs: Omit<AnalysisJob, 'id' | 'createdAt'>[] = [];
  let skipped = 0;

  for (const group of groups) {
    for (const { product, variants: productVariants } of group.products) {
      for (const variant of productVariants) {
        const hasAnalysis = analyzedVariantIds.has(variant.id);

        if (options.skipExisting && hasAnalysis) {
          skipped++;
          continue;
        }

        const priority = calculatePriority(product, variant, hasAnalysis);

        jobs.push({
          productId: product.id,
          variantId: variant.id,
          groupKey: group.key,
          priority,
          status: 'pending',
          attempts: 0,
        });

        if (options.maxJobs && jobs.length >= options.maxJobs) {
          break;
        }
      }
      if (options.maxJobs && jobs.length >= options.maxJobs) break;
    }
    if (options.maxJobs && jobs.length >= options.maxJobs) break;
  }

  // Sort by priority
  jobs.sort((a, b) => b.priority - a.priority);

  // Insert jobs into queue
  if (jobs.length > 0) {
    const { error } = await db.from('analysis_queue').insert(
      jobs.map(j => ({
        product_id: j.productId,
        variant_id: j.variantId,
        group_key: j.groupKey,
        priority: j.priority,
        status: j.status,
        attempts: j.attempts,
      }))
    );

    if (error) {
      console.error('Failed to create analysis jobs:', error);
      return { created: 0, skipped };
    }
  }

  return { created: jobs.length, skipped };
}

// Get next batch of jobs to process (grouped by category for shared research)
export async function getNextJobBatch(batchSize = 10): Promise<{
  groupKey: string;
  jobs: Array<{ id: string; productId: string; variantId: string }>;
} | null> {
  const db = createServerClient();

  // Get highest priority pending job to determine which group to process
  const { data: topJob } = await db
    .from('analysis_queue')
    .select('group_key')
    .eq('status', 'pending')
    .order('priority', { ascending: false })
    .limit(1)
    .single();

  if (!topJob) return null;

  // Get batch of jobs from the same group
  const { data: jobs } = await db
    .from('analysis_queue')
    .select('id, product_id, variant_id')
    .eq('status', 'pending')
    .eq('group_key', topJob.group_key)
    .order('priority', { ascending: false })
    .limit(batchSize);

  if (!jobs || jobs.length === 0) return null;

  // Mark as processing
  await db
    .from('analysis_queue')
    .update({ status: 'processing', started_at: new Date().toISOString() })
    .in('id', jobs.map(j => j.id));

  return {
    groupKey: topJob.group_key,
    jobs: jobs.map(j => ({
      id: j.id,
      productId: j.product_id,
      variantId: j.variant_id,
    })),
  };
}

// Mark job as completed or failed
export async function updateJobStatus(
  jobId: string,
  status: 'completed' | 'failed',
  error?: string
): Promise<void> {
  const db = createServerClient();
  await db
    .from('analysis_queue')
    .update({
      status,
      error,
      completed_at: new Date().toISOString(),
    })
    .eq('id', jobId);
}

// Get queue stats
export async function getQueueStats(): Promise<{
  pending: number;
  processing: number;
  completed: number;
  failed: number;
  byGroup: Array<{ group: string; count: number }>;
}> {
  const db = createServerClient();

  const { data: stats } = await db
    .from('analysis_queue')
    .select('status, group_key');

  if (!stats) {
    return { pending: 0, processing: 0, completed: 0, failed: 0, byGroup: [] };
  }

  const counts = { pending: 0, processing: 0, completed: 0, failed: 0 };
  const groupCounts = new Map<string, number>();

  for (const s of stats) {
    counts[s.status as keyof typeof counts]++;
    if (s.status === 'pending') {
      groupCounts.set(s.group_key, (groupCounts.get(s.group_key) || 0) + 1);
    }
  }

  return {
    ...counts,
    byGroup: [...groupCounts.entries()]
      .map(([group, count]) => ({ group, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10),
  };
}

// Clear completed jobs older than X hours
export async function cleanupQueue(hoursOld = 24): Promise<number> {
  const db = createServerClient();
  const cutoff = new Date(Date.now() - hoursOld * 60 * 60 * 1000).toISOString();

  const { data } = await db
    .from('analysis_queue')
    .delete()
    .in('status', ['completed', 'failed'])
    .lt('completed_at', cutoff)
    .select('id');

  return data?.length || 0;
}
