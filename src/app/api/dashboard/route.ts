import { NextResponse } from 'next/server';
import { createServerClient } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const db = createServerClient();

    // Get settings for min_margin
    const { data: settings } = await db.from('settings').select('min_margin').limit(1).single();
    const minMargin = settings?.min_margin || 20;

    // Count products and variants
    const { count: totalProducts } = await db.from('products').select('*', { count: 'exact', head: true });
    const { count: totalVariants } = await db.from('variants').select('*', { count: 'exact', head: true });

    // Variants with cost data for margin calculation
    const { data: variantsWithCost } = await db
      .from('variants')
      .select('price, cost')
      .not('cost', 'is', null)
      .gt('cost', 0);

    let avgMargin: number | null = null;
    let negativeMargins = 0;
    let belowFloor = 0;
    if (variantsWithCost && variantsWithCost.length > 0) {
      let totalMargin = 0;
      for (const v of variantsWithCost) {
        const margin = ((v.price - v.cost) / v.price) * 100;
        totalMargin += margin;
        if (margin < 0) negativeMargins++;
        else if (margin < minMargin) belowFloor++;
      }
      avgMargin = totalMargin / variantsWithCost.length;
    }

    // Count variants missing costs
    const { count: missingCosts } = await db
      .from('variants')
      .select('*', { count: 'exact', head: true })
      .is('cost', null);

    // Count analyses
    const { count: analyzedCount } = await db
      .from('analyses')
      .select('*', { count: 'exact', head: true })
      .not('suggested_price', 'is', null)
      .is('error', null);

    const { count: pendingUpdates } = await db
      .from('analyses')
      .select('*', { count: 'exact', head: true })
      .not('suggested_price', 'is', null)
      .eq('applied', false)
      .is('error', null);

    // Recent activity
    const { data: activity } = await db
      .from('activity_log')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(20);

    return NextResponse.json({
      success: true,
      metrics: {
        totalProducts: totalProducts || 0,
        totalVariants: totalVariants || 0,
        avgMargin,
        analyzedCount: analyzedCount || 0,
        pendingUpdates: pendingUpdates || 0,
        negativeMargins,
        belowFloor,
        missingCosts: missingCosts || 0,
      },
      activity: activity || [],
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Unknown error';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
