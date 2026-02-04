import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const db = createServerClient();
    const { data, error } = await db.from('settings').select('*').limit(1).single();
    if (error) throw error;
    return NextResponse.json({ success: true, settings: data });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Unknown error';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const updates = await req.json();
    const db = createServerClient();

    // Get the existing settings ID
    const { data: existing } = await db.from('settings').select('id').limit(1).single();
    if (!existing) {
      return NextResponse.json({ success: false, error: 'No settings row found' }, { status: 404 });
    }

    const { error } = await db.from('settings').update(updates).eq('id', existing.id);
    if (error) throw error;

    return NextResponse.json({ success: true });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Unknown error';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
