// Cancel an active batch job
// Progress is preserved - completed items keep their analyses

import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const { batchId } = await req.json();

    if (!batchId) {
      return NextResponse.json({ success: false, error: 'batchId required' }, { status: 400 });
    }

    const db = createServerClient();

    const { data: batch, error } = await db
      .from('batch_jobs')
      .update({
        status: 'cancelled',
        completed_at: new Date().toISOString(),
      })
      .eq('id', batchId)
      .in('status', ['pending', 'running', 'paused'])
      .select()
      .single();

    if (error || !batch) {
      return NextResponse.json({ success: false, error: 'Batch not found or already finished' }, { status: 404 });
    }

    await db.from('activity_log').insert({
      message: `Batch cancelled: ${batch.completed} completed, ${batch.failed} failed out of ${batch.total_variants}`,
      type: 'warning',
    });

    return NextResponse.json({ success: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown error';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
