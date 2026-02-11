-- Add previous_price column to analyses table for price revert support
-- Stores the variant's price BEFORE a new price was applied

ALTER TABLE analyses ADD COLUMN IF NOT EXISTS previous_price NUMERIC;

COMMENT ON COLUMN analyses.previous_price IS 'Price of the variant before this analysis was applied. Used for price reverts.';
