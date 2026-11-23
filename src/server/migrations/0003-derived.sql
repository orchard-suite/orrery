-- Derived state, worked out when inputs change and stored beside the raw layers, so a read is a lookup.
-- `fields` is Entity.fields as nobody's view: stored values resolved and derived values computed.
-- `relations` is the winning layer of each relation with the target's title; `relation_layers` is absent on purpose:
-- the layer a value won from is read from the row on the page that asks for it.
-- `reasons` carries where each rolled-up status reason came from, so a view can withhold it.
-- `reads` is every entity id whose change moves this row; `derived_at` is the start of the read it was derived from.
CREATE TABLE IF NOT EXISTS derived (
  blueprint TEXT NOT NULL,
  key TEXT NOT NULL,
  fields JSONB NOT NULL,
  relations JSONB NOT NULL,
  icon TEXT,
  level TEXT NOT NULL,
  reasons JSONB NOT NULL,
  levels JSONB,
  search_all TEXT NOT NULL,
  reads TEXT[] NOT NULL,
  derived_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (blueprint, key)
);
CREATE INDEX IF NOT EXISTS derived_reads ON derived USING GIN (reads);
CREATE INDEX IF NOT EXISTS derived_level ON derived (blueprint, level);

-- What waits to be derived. A writer puts a row here in the transaction of its write; the leader drains it.
CREATE TABLE IF NOT EXISTS derive_queue (
  blueprint TEXT NOT NULL,
  key TEXT NOT NULL,
  queued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (blueprint, key)
);
CREATE INDEX IF NOT EXISTS derive_queue_at ON derive_queue (queued_at);

-- Text orders the way a person reads it, digit runs as numbers: `pod-2` before `pod-10`. The same rules the web app
-- and the hub use in `compare` (Intl.Collator 'en', numeric), so Node and Postgres agree on an order.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_collation WHERE collname = 'orrery_natural') THEN
    CREATE COLLATION orrery_natural (provider = icu, locale = 'en-u-kn-true');
  END IF;
END $$;

-- A datetime value as a timestamp, or NULL where the text is not one: a filter never fails on a stray string.
CREATE OR REPLACE FUNCTION orrery_ts(value text) RETURNS timestamptz
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
BEGIN
  IF value !~ '^\d{4}-\d{2}-\d{2}' THEN RETURN NULL; END IF;
  RETURN value::timestamptz;
EXCEPTION WHEN others THEN
  RETURN NULL;
END $$;

-- Substring search is pre-filtered by trigram where the server offers the extension; without it the same
-- query runs unindexed, and the hub says so once at start.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_trgm') THEN
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'derived_search') THEN
      CREATE INDEX derived_search ON derived USING GIN (search_all gin_trgm_ops);
    END IF;
  END IF;
END $$;
