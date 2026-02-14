-- ============================================================================
-- Migration: Add volume pricing columns to analyses table
-- ============================================================================
-- Supports the new volume discount pricing engine. When a product has
-- quantity-type variants, only the base (lowest qty) variant is AI-analyzed.
-- All other variants get their price derived via a power-law formula.
--
-- pricing_method: 'ai' (default) or 'volume_formula'
-- volume_pricing: JSONB with formula parameters and derived values
-- ============================================================================

ALTER TABLE analyses
  ADD COLUMN IF NOT EXISTS pricing_method TEXT DEFAULT 'ai',
  ADD COLUMN IF NOT EXISTS volume_pricing JSONB DEFAULT NULL;

-- Add a comment for documentation
COMMENT ON COLUMN analyses.pricing_method IS 'How the price was determined: ai (full AI pipeline) or volume_formula (derived from base variant via power-law curve)';
COMMENT ON COLUMN analyses.volume_pricing IS 'Volume pricing metadata when pricing_method=volume_formula. Contains base_variant_id, base_price, base_qty, variant_qty, exponent, raw_price, per_unit, discount_from_base_percent, premium_multiplier.';
