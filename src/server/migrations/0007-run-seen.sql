-- What a snapshot run saw, one row a batch. Its commit marks missing what no row names, and removes the rows.
CREATE TABLE IF NOT EXISTS run_seen (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  blueprints TEXT[] NOT NULL,
  keys TEXT[] NOT NULL
);
CREATE INDEX IF NOT EXISTS run_seen_run ON run_seen (run_id);

-- When the last snapshot of a source's scope committed. Every entity it left active was seen then, so a snapshot
-- writes that once here and not on each entity.
CREATE TABLE IF NOT EXISTS scope_seen (
  source TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  seen_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (source, scope)
);
