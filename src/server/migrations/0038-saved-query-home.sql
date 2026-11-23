-- A saved query's home: the one entity of any blueprint it belongs to, as an action's home is, and whether it opens to
-- the people who own that entity.
ALTER TABLE saved_queries ADD COLUMN IF NOT EXISTS home text;
ALTER TABLE saved_queries ADD COLUMN IF NOT EXISTS home_shared boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS saved_queries_home ON saved_queries (home) WHERE home IS NOT NULL;
