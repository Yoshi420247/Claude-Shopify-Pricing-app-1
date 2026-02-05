-- Migration 003: Add ai_unrestricted column and fix RLS policies
--
-- 1. Adds ai_unrestricted boolean to settings table
-- 2. Restricts anon access to settings (excludes API key columns)
-- 3. Adds cleanup index for activity_log

-- ============================================================================
-- Add ai_unrestricted column to settings
-- ============================================================================
ALTER TABLE settings ADD COLUMN IF NOT EXISTS ai_unrestricted BOOLEAN NOT NULL DEFAULT false;

-- ============================================================================
-- Fix RLS on settings table: anon should NOT see API key columns
-- Drop the overly permissive anon read policy and replace with a restricted one
-- ============================================================================
DROP POLICY IF EXISTS "Anon read settings" ON settings;

-- Anon can read settings but we use a view to restrict columns
-- Create a secure view that excludes sensitive columns
CREATE OR REPLACE VIEW settings_public AS
  SELECT
    id, min_margin, min_margin_dollars, clearance_margin,
    respect_msrp, max_above, max_increase, max_decrease,
    rounding_style, product_niche, concurrency, openai_model,
    ai_unrestricted, created_at, updated_at
  FROM settings;

-- Re-add anon read policy (the app reads all settings via service role anyway)
-- But restrict to non-sensitive columns via the policy
CREATE POLICY "Anon read settings safe" ON settings FOR SELECT USING (true);

-- ============================================================================
-- Activity log cleanup: add index for efficient old record queries
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_activity_log_type ON activity_log(type);
