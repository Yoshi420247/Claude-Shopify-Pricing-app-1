// Batch analysis API - queue products for background processing
// Works like a smart employee: groups similar products, shares research

import { NextResponse } from 'next/server';
import { createServerClient } from '@/lib/supabase';
import {
  createAnalysisJobs,
  getQueueStats,
  cleanupQueue,
} from '@/lib/batch-analyzer';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// POST: Create analysis jobs for products
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const {
      productIds, // array of product IDs or 'all'
      skipExisting = true,
      prioritizeActive = true,
      maxJobs = 500,
    } = body;

    const result = await createAnalysisJobs(
      productIds === 'all' ? 'all' : productIds,
      { skipExisting, prioritizeActive, maxJobs }
    );

    const stats = await getQueueStats();

    return NextResponse.json({
      success: true,
      jobsCreated: result.created,
      jobsSkipped: result.skipped,
      queueStats: stats,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown error';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

// GET: Get queue status
export async function GET() {
  try {
    const stats = await getQueueStats();

    // Also get recent activity
    const db = createServerClient();
    const { data: recentJobs } = await db
      .from('analysis_queue')
      .select('id, product_id, variant_id, status, error, completed_at')
      .order('completed_at', { ascending: false })
      .limit(10);

    return NextResponse.json({
      success: true,
      stats,
      recentJobs: recentJobs || [],
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown error';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

// DELETE: Clean up old jobs
export async function DELETE() {
  try {
    const removed = await cleanupQueue(24);
    return NextResponse.json({ success: true, removed });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown error';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
