-- Analysis job queue for batch processing
-- Allows efficient parallel analysis with progress tracking

CREATE TABLE IF NOT EXISTS analysis_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  variant_id TEXT NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
  group_key TEXT NOT NULL, -- vendor:productType for grouping
  priority INTEGER NOT NULL DEFAULT 50,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

-- Indexes for efficient job fetching
CREATE INDEX IF NOT EXISTS idx_queue_status_priority ON analysis_queue(status, priority DESC);
CREATE INDEX IF NOT EXISTS idx_queue_group ON analysis_queue(group_key, status);
CREATE INDEX IF NOT EXISTS idx_queue_variant ON analysis_queue(variant_id);

-- Search cache for persisting competitor research
CREATE TABLE IF NOT EXISTS search_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_type TEXT NOT NULL,
  vendor TEXT NOT NULL DEFAULT '',
  results JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(product_type, vendor)
);

CREATE INDEX IF NOT EXISTS idx_search_cache_lookup ON search_cache(product_type, vendor);

-- Shared research results for product groups
CREATE TABLE IF NOT EXISTS group_research (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_key TEXT NOT NULL UNIQUE,
  vendor TEXT,
  product_type TEXT,
  competitor_prices JSONB,
  market_insights JSONB,
  search_queries TEXT[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours')
);

CREATE INDEX IF NOT EXISTS idx_group_research_key ON group_research(group_key);
CREATE INDEX IF NOT EXISTS idx_group_research_expires ON group_research(expires_at);

-- Allow anon access (for Vercel serverless)
ALTER TABLE analysis_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE search_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE group_research ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all for analysis_queue" ON analysis_queue FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for search_cache" ON search_cache FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for group_research" ON group_research FOR ALL USING (true) WITH CHECK (true);
