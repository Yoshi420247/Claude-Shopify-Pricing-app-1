import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

// Known settings fields that exist in database
const KNOWN_FIELDS = [
  'min_margin',
  'min_margin_dollars',
  'clearance_margin',
  'respect_msrp',
  'max_above',
  'max_increase',
  'max_decrease',
  'rounding_style',
  'product_niche',
  'concurrency',
  'openai_model',
  'ai_unrestricted', // New field - may not exist in older databases
];

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

// Validation ranges for numeric settings
const SETTINGS_RANGES: Record<string, { min: number; max: number }> = {
  min_margin: { min: 0, max: 80 },
  min_margin_dollars: { min: 0, max: 100 },
  clearance_margin: { min: 0, max: 50 },
  max_above: { min: 0, max: 50 },
  max_increase: { min: 1, max: 100 },
  max_decrease: { min: 1, max: 100 },
  concurrency: { min: 1, max: 10 },
};

const VALID_ROUNDING_STYLES = ['psychological', 'clean', 'none'];

export async function PUT(req: NextRequest) {
  try {
    const updates = await req.json();
    const db = createServerClient();

    // Get the existing settings ID
    const { data: existing } = await db.from('settings').select('id').limit(1).single();
    if (!existing) {
      return NextResponse.json({ success: false, error: 'No settings row found' }, { status: 404 });
    }

    // Filter to only known fields and validate values
    const filteredUpdates: Record<string, unknown> = {};
    const validationErrors: string[] = [];

    for (const key of Object.keys(updates)) {
      if (!KNOWN_FIELDS.includes(key)) continue;

      const value = updates[key];

      // Validate numeric ranges
      if (key in SETTINGS_RANGES && typeof value === 'number') {
        const range = SETTINGS_RANGES[key];
        if (value < range.min || value > range.max) {
          validationErrors.push(`${key} must be between ${range.min} and ${range.max}`);
          continue;
        }
      }

      // Validate rounding_style enum
      if (key === 'rounding_style' && typeof value === 'string') {
        if (!VALID_ROUNDING_STYLES.includes(value)) {
          validationErrors.push(`rounding_style must be one of: ${VALID_ROUNDING_STYLES.join(', ')}`);
          continue;
        }
      }

      // Validate boolean fields
      if ((key === 'respect_msrp' || key === 'ai_unrestricted') && typeof value !== 'boolean') {
        validationErrors.push(`${key} must be a boolean`);
        continue;
      }

      filteredUpdates[key] = value;
    }

    if (validationErrors.length > 0) {
      return NextResponse.json({
        success: false,
        error: `Validation failed: ${validationErrors.join('; ')}`,
      }, { status: 400 });
    }

    // Try to save all fields first
    let { error } = await db.from('settings').update(filteredUpdates).eq('id', existing.id);
    let aiUnrestrictedSkipped = false;

    // If it fails (possibly due to missing ai_unrestricted column), try without it
    if (error && filteredUpdates.ai_unrestricted !== undefined) {
      console.warn('Settings save failed, retrying without ai_unrestricted:', error.message);
      aiUnrestrictedSkipped = true;
      delete filteredUpdates.ai_unrestricted;
      const retry = await db.from('settings').update(filteredUpdates).eq('id', existing.id);
      error = retry.error;
    }

    if (error) throw error;

    // Return success with warning if ai_unrestricted was skipped
    if (aiUnrestrictedSkipped) {
      return NextResponse.json({
        success: true,
        warning: 'ai_unrestricted_not_saved',
        message: 'Settings saved, but AI Unrestricted Mode requires adding the column to your database. Run: ALTER TABLE settings ADD COLUMN ai_unrestricted BOOLEAN DEFAULT false;'
      });
    }

    return NextResponse.json({ success: true });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Unknown error';
    console.error('Settings save error:', message);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
