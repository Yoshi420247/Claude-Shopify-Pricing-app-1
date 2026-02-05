// Persistent batch job management
// POST: Create a new batch job
// GET: Get active/recent batch jobs

import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

// POST: Create a new batch job from selected variant IDs
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      variantIds, // Array of { productId, variantId }
      chunkSize = 50,
      autoApply = false,
      aiUnrestricted = false,
      name = 'Batch Analysis',
    } = body;

    if (!variantIds || !Array.isArray(variantIds) || variantIds.length === 0) {
      return NextResponse.json(
        { success: false, error: 'variantIds array required' },
        { status: 400 }
      );
    }

    const db = createServerClient();

    // Cancel any existing running batches first
    await db
      .from('batch_jobs')
      .update({ status: 'cancelled', completed_at: new Date().toISOString() })
      .in('status', ['pending', 'running', 'paused']);

    // Create the batch job
    const { data: batch, error } = await db
      .from('batch_jobs')
      .insert({
        name,
        total_variants: variantIds.length,
        chunk_size: Math.min(Math.max(chunkSize, 10), 200),
        auto_apply: autoApply,
        ai_unrestricted: aiUnrestricted,
        variant_ids: variantIds,
        status: 'pending',
        completed: 0,
        failed: 0,
        applied: 0,
        current_chunk: 0,
      })
      .select()
      .single();

    if (error || !batch) {
      console.error('Failed to create batch job:', error);
      return NextResponse.json(
        { success: false, error: 'Failed to create batch job: ' + (error?.message || 'unknown') },
        { status: 500 }
      );
    }

    // Log activity
    await db.from('activity_log').insert({
      message: `Batch created: ${variantIds.length} variants, chunk size ${chunkSize}${autoApply ? ', auto-apply ON' : ''}${aiUnrestricted ? ', AI unlimited' : ''}`,
      type: 'info',
    });

    return NextResponse.json({
      success: true,
      batch: {
        id: batch.id,
        name: batch.name,
        totalVariants: batch.total_variants,
        chunkSize: batch.chunk_size,
        autoApply: batch.auto_apply,
        aiUnrestricted: batch.ai_unrestricted,
        completed: batch.completed,
        failed: batch.failed,
        applied: batch.applied,
        status: batch.status,
        currentChunk: batch.current_chunk,
        createdAt: batch.created_at,
      },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown error';
    console.error('Batch create error:', message);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

// GET: Get active or most recent batch job
export async function GET() {
  try {
    const db = createServerClient();

    // Get the most recent active batch, or last completed one
    const { data: activeBatch } = await db
      .from('batch_jobs')
      .select('*')
      .in('status', ['pending', 'running', 'paused'])
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (activeBatch) {
      return NextResponse.json({
        success: true,
        batch: formatBatch(activeBatch),
        hasActiveBatch: true,
      });
    }

    // No active batch - get most recent completed/cancelled one
    const { data: recentBatch } = await db
      .from('batch_jobs')
      .select('*')
      .in('status', ['completed', 'cancelled'])
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    return NextResponse.json({
      success: true,
      batch: recentBatch ? formatBatch(recentBatch) : null,
      hasActiveBatch: false,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown error';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

function formatBatch(b: Record<string, unknown>) {
  return {
    id: b.id,
    name: b.name,
    totalVariants: b.total_variants,
    chunkSize: b.chunk_size,
    autoApply: b.auto_apply,
    aiUnrestricted: b.ai_unrestricted,
    completed: b.completed,
    failed: b.failed,
    applied: b.applied,
    status: b.status,
    currentChunk: b.current_chunk,
    lastError: b.last_error,
    createdAt: b.created_at,
    startedAt: b.started_at,
    completedAt: b.completed_at,
    updatedAt: b.updated_at,
  };
}
