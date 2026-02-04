-- Oil Slick Pad Pricing Suite — Supabase Schema
-- Run this in your Supabase SQL Editor to set up the database

-- ============================================================================
-- SETTINGS
-- ============================================================================
CREATE TABLE IF NOT EXISTS settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shopify_store TEXT NOT NULL DEFAULT 'oil-slick-pad',
  shopify_token TEXT,
  openai_key TEXT,
  openai_model TEXT NOT NULL DEFAULT 'gpt-5.2',
  brave_key TEXT,
  min_margin NUMERIC NOT NULL DEFAULT 20,
  min_margin_dollars NUMERIC NOT NULL DEFAULT 3,
  clearance_margin NUMERIC NOT NULL DEFAULT 5,
  respect_msrp BOOLEAN NOT NULL DEFAULT true,
  max_above NUMERIC NOT NULL DEFAULT 5,
  max_increase NUMERIC NOT NULL DEFAULT 10,
  max_decrease NUMERIC NOT NULL DEFAULT 15,
  rounding_style TEXT NOT NULL DEFAULT 'psychological',
  product_niche TEXT DEFAULT 'heady glass, dab tools, concentrate accessories',
  concurrency INTEGER NOT NULL DEFAULT 20,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Insert default settings row
INSERT INTO settings (shopify_store) VALUES ('oil-slick-pad')
ON CONFLICT DO NOTHING;

-- ============================================================================
-- PRODUCTS (synced from Shopify)
-- ============================================================================
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  description_html TEXT,
  vendor TEXT,
  product_type TEXT,
  handle TEXT,
  tags TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  image_url TEXT,
  shopify_gid TEXT,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_products_vendor ON products(vendor);
CREATE INDEX IF NOT EXISTS idx_products_product_type ON products(product_type);
CREATE INDEX IF NOT EXISTS idx_products_status ON products(status);

-- ============================================================================
-- VARIANTS (each product can have multiple variants with different prices)
-- ============================================================================
CREATE TABLE IF NOT EXISTS variants (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  title TEXT,
  sku TEXT,
  price NUMERIC NOT NULL DEFAULT 0,
  compare_at_price NUMERIC,
  cost NUMERIC,
  inventory_item_id TEXT,
  shopify_gid TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_variants_product_id ON variants(product_id);
CREATE INDEX IF NOT EXISTS idx_variants_sku ON variants(sku);

-- ============================================================================
-- ANALYSES (AI pricing analysis results — one per variant)
-- ============================================================================
CREATE TABLE IF NOT EXISTS analyses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  variant_id TEXT NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
  suggested_price NUMERIC,
  confidence TEXT CHECK (confidence IN ('high', 'medium', 'low')),
  confidence_reason TEXT,
  summary TEXT,
  reasoning JSONB,
  market_position TEXT,
  price_floor NUMERIC,
  price_ceiling NUMERIC,
  product_identity JSONB,
  competitor_analysis JSONB,
  search_queries JSONB,
  was_deliberated BOOLEAN NOT NULL DEFAULT false,
  was_reflection_retried BOOLEAN NOT NULL DEFAULT false,
  applied BOOLEAN NOT NULL DEFAULT false,
  applied_at TIMESTAMPTZ,
  error TEXT,
  analyzed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_analyses_product_id ON analyses(product_id);
CREATE INDEX IF NOT EXISTS idx_analyses_variant_id ON analyses(variant_id);
CREATE INDEX IF NOT EXISTS idx_analyses_applied ON analyses(applied);
CREATE INDEX IF NOT EXISTS idx_analyses_confidence ON analyses(confidence);
CREATE UNIQUE INDEX IF NOT EXISTS idx_analyses_variant_unique ON analyses(variant_id);

-- ============================================================================
-- ACTIVITY LOG
-- ============================================================================
CREATE TABLE IF NOT EXISTS activity_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'info',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_activity_log_created ON activity_log(created_at DESC);

-- ============================================================================
-- UPDATED_AT TRIGGER
-- ============================================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_settings_updated_at
  BEFORE UPDATE ON settings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_products_updated_at
  BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_variants_updated_at
  BEFORE UPDATE ON variants
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- Row Level Security (RLS) — disabled for service role access
-- Enable these if you add user authentication later
-- ============================================================================
ALTER TABLE settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE variants ENABLE ROW LEVEL SECURITY;
ALTER TABLE analyses ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_log ENABLE ROW LEVEL SECURITY;

-- Allow service role full access
CREATE POLICY "Service role full access" ON settings FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON products FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON variants FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON analyses FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON activity_log FOR ALL USING (true) WITH CHECK (true);

-- Allow anon key read access for the frontend
CREATE POLICY "Anon read settings" ON settings FOR SELECT USING (true);
CREATE POLICY "Anon read products" ON products FOR SELECT USING (true);
CREATE POLICY "Anon read variants" ON variants FOR SELECT USING (true);
CREATE POLICY "Anon read analyses" ON analyses FOR SELECT USING (true);
CREATE POLICY "Anon read activity" ON activity_log FOR SELECT USING (true);
