-- Migration 004: Persistent batch jobs
-- Tracks batch runs so progress survives page refreshes
-- Each batch stores its configuration (auto-apply, AI unlimited mode, chunk size)

CREATE TABLE IF NOT EXISTS batch_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Batch configuration
  name TEXT NOT NULL DEFAULT 'Batch Analysis',
  total_variants INTEGER NOT NULL DEFAULT 0,
  chunk_size INTEGER NOT NULL DEFAULT 50,
  auto_apply BOOLEAN NOT NULL DEFAULT false,
  ai_unrestricted BOOLEAN NOT NULL DEFAULT false,

  -- Progress tracking
  completed INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  applied INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'paused', 'completed', 'cancelled')),
  current_chunk INTEGER NOT NULL DEFAULT 0,

  -- Variant tracking (stored as JSONB array of {productId, variantId} objects)
  variant_ids JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Results log
  last_error TEXT,

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_batch_jobs_status ON batch_jobs(status);
CREATE INDEX IF NOT EXISTS idx_batch_jobs_created ON batch_jobs(created_at DESC);

-- Trigger to auto-update updated_at
CREATE OR REPLACE FUNCTION update_batch_jobs_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER batch_jobs_updated_at
  BEFORE UPDATE ON batch_jobs
  FOR EACH ROW
  EXECUTE FUNCTION update_batch_jobs_updated_at();

-- RLS
ALTER TABLE batch_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for batch_jobs" ON batch_jobs FOR ALL USING (true) WITH CHECK (true);
