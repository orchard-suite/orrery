-- The schema as it stood when the hub moved to numbered migrations. On a
-- hub that ran before then it changes nothing, since every statement is
-- written to be run again; it runs once, and is recorded like every other.
-- JSON, not JSONB: a blueprint keeps its fields and relations in the order they were written, and JSONB sorts keys.
CREATE TABLE IF NOT EXISTS blueprints (
  id TEXT PRIMARY KEY,
  spec JSON NOT NULL,
  origin JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS entities (
  blueprint TEXT NOT NULL,
  key TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'active',
  owner TEXT NOT NULL,
  scope TEXT,
  hidden BOOLEAN NOT NULL DEFAULT false,
  ui JSONB NOT NULL DEFAULT '{}',
  pushed JSONB NOT NULL DEFAULT '{}',
  override JSONB NOT NULL DEFAULT '{}',
  git JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ,
  last_run_id TEXT,
  missing_since TIMESTAMPTZ,
  missing_runs INTEGER NOT NULL DEFAULT 0,
  grace_until TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  blocked_until TIMESTAMPTZ,
  PRIMARY KEY (blueprint, key)
);
CREATE INDEX IF NOT EXISTS entities_owner_scope ON entities(owner, scope, state);
CREATE INDEX IF NOT EXISTS entities_state ON entities(state);
CREATE TABLE IF NOT EXISTS relations (
  blueprint TEXT NOT NULL,
  key TEXT NOT NULL,
  relation TEXT NOT NULL,
  layer TEXT NOT NULL,
  source TEXT NOT NULL,
  target_blueprint TEXT NOT NULL,
  target_key TEXT NOT NULL,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  file TEXT,
  PRIMARY KEY (blueprint, key, relation, layer, target_blueprint, target_key)
);
CREATE INDEX IF NOT EXISTS relations_target ON relations(target_blueprint, target_key);
CREATE INDEX IF NOT EXISTS relations_source ON relations(source);
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  spec JSONB NOT NULL,
  git_token TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ,
  last_run_at TIMESTAMPTZ,
  last_error TEXT,
  status TEXT NOT NULL DEFAULT 'grey',
  status_reason TEXT
);
CREATE TABLE IF NOT EXISTS tokens (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  role TEXT,
  source TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ
);
-- A personal token belongs to the person who made it, and acts as them.
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS owner TEXT;
CREATE INDEX IF NOT EXISTS tokens_owner ON tokens(owner);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  mode TEXT NOT NULL,
  write_mode TEXT NOT NULL DEFAULT 'upsert',
  scope TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open',
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  counts JSONB NOT NULL DEFAULT '{}',
  errors JSONB NOT NULL DEFAULT '[]',
  mass_drop BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS runs_source ON runs(source, started_at DESC);
CREATE INDEX IF NOT EXISTS runs_started ON runs(started_at DESC);
CREATE TABLE IF NOT EXISTS changes (
  id BIGSERIAL PRIMARY KEY,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind TEXT NOT NULL,
  blueprint TEXT,
  key TEXT,
  source TEXT,
  actor TEXT,
  detail JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS changes_at ON changes(at DESC);
CREATE INDEX IF NOT EXISTS changes_entity ON changes(blueprint, key, at DESC);
ALTER TABLE changes ADD COLUMN IF NOT EXISTS category TEXT;
ALTER TABLE changes ADD COLUMN IF NOT EXISTS outcome TEXT NOT NULL DEFAULT 'ok';
ALTER TABLE changes ADD COLUMN IF NOT EXISTS actor_kind TEXT;
-- When the row was written, by the clock, whatever at says: the Annals forwarder
-- passes a row once it is a minute old, so a late commit is not skipped. The
-- column is added empty and the default set apart, so no existing row is
-- rewritten: a rewrite of a large log holds the table past a start's patience.
ALTER TABLE changes ADD COLUMN IF NOT EXISTS logged_at TIMESTAMPTZ;
ALTER TABLE changes ALTER COLUMN logged_at SET DEFAULT clock_timestamp();
ALTER TABLE changes ALTER COLUMN logged_at DROP NOT NULL;
UPDATE changes SET
  category = CASE split_part(kind, '.', 1) WHEN 'run' THEN 'runs' WHEN 'blueprint' THEN 'model' WHEN 'source' THEN 'sources' ELSE 'estate' END,
  actor_kind = CASE WHEN source IS NOT NULL AND source <> 'ui' THEN 'source' WHEN actor IS NOT NULL OR source = 'ui' THEN 'user' ELSE 'hub' END
  WHERE category IS NULL;
CREATE INDEX IF NOT EXISTS changes_actor_kind ON changes(actor_kind, id DESC);
DO $$ BEGIN
  IF (SELECT data_type FROM information_schema.columns WHERE table_name = 'blueprints' AND column_name = 'spec') = 'jsonb' THEN
    ALTER TABLE blueprints ALTER COLUMN spec TYPE JSON USING spec::json;
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS users (
  email TEXT PRIMARY KEY,
  admin BOOLEAN NOT NULL DEFAULT false,
  roles JSONB NOT NULL DEFAULT '[]',
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- A person added before they first sign in has no sign-in yet.
ALTER TABLE users ALTER COLUMN first_seen_at DROP NOT NULL;
ALTER TABLE users ALTER COLUMN last_seen_at DROP NOT NULL;
ALTER TABLE users ALTER COLUMN first_seen_at DROP DEFAULT;
ALTER TABLE users ALTER COLUMN last_seen_at DROP DEFAULT;
CREATE TABLE IF NOT EXISTS roles (
  id TEXT PRIMARY KEY,
  spec JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS relation_rules (
  id TEXT PRIMARY KEY,
  blueprint TEXT NOT NULL,
  relation TEXT NOT NULL,
  target TEXT NOT NULL,
  where_expr TEXT NOT NULL,
  origin JSONB NOT NULL
);
ALTER TABLE relation_rules ADD COLUMN IF NOT EXISTS optional BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS grid_layouts (
  blueprint TEXT PRIMARY KEY,
  layout JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS scorecards (
  id TEXT PRIMARY KEY,
  spec JSONB NOT NULL,
  origin JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS scorecard_history (
  scorecard TEXT NOT NULL,
  blueprint TEXT NOT NULL,
  key TEXT NOT NULL,
  level TEXT NOT NULL,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (scorecard, blueprint, key, at)
);
CREATE INDEX IF NOT EXISTS scorecard_history_at ON scorecard_history(scorecard, at DESC);
CREATE TABLE IF NOT EXISTS secrets (
  name TEXT PRIMARY KEY,
  sealed TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS check_results (
  blueprint TEXT NOT NULL,
  key TEXT NOT NULL,
  field TEXT NOT NULL,
  runner TEXT NOT NULL,
  ok BOOLEAN NOT NULL,
  status INTEGER,
  latency_ms INTEGER,
  error TEXT,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (blueprint, key, field, runner)
);
CREATE TABLE IF NOT EXISTS alerts (
  fingerprint TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  labels JSONB NOT NULL,
  annotations JSONB NOT NULL,
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  blueprint TEXT,
  key TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS alerts_entity ON alerts(blueprint, key);
CREATE TABLE IF NOT EXISTS alert_rules (
  id TEXT PRIMARY KEY,
  blueprint TEXT NOT NULL,
  where_expr TEXT NOT NULL,
  origin JSONB NOT NULL
);
DROP TABLE IF EXISTS canvas_positions, canvases;
DELETE FROM settings WHERE key = 'previews';
UPDATE settings SET key = 'catalog.layout' WHERE key = 'catalog.groupOrder';
CREATE TABLE IF NOT EXISTS actions (
  id TEXT PRIMARY KEY,
  spec JSON NOT NULL,
  origin JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS action_runs (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  blueprint TEXT,
  key TEXT,
  inputs JSONB NOT NULL DEFAULT '{}',
  actor TEXT NOT NULL,
  state TEXT NOT NULL,
  label TEXT,
  link TEXT,
  summary TEXT,
  log JSONB NOT NULL DEFAULT '[]',
  claimed_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS action_runs_action ON action_runs(action, created_at DESC);
CREATE INDEX IF NOT EXISTS action_runs_state ON action_runs(state);
ALTER TABLE action_runs ADD COLUMN IF NOT EXISTS decided_by TEXT;
ALTER TABLE action_runs ADD COLUMN IF NOT EXISTS decided_at TIMESTAMPTZ;
ALTER TABLE action_runs ADD COLUMN IF NOT EXISTS watch_url TEXT;
-- When a blueprint first appeared. One that predates the column takes its first entity's, else its last save. The activity log is not read: it is too large to scan while the schema holds its locks.
ALTER TABLE blueprints ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;
ALTER TABLE blueprints ALTER COLUMN created_at SET DEFAULT now();
UPDATE blueprints b SET created_at = LEAST(COALESCE((SELECT min(created_at) FROM entities e WHERE e.blueprint = b.id), b.updated_at), b.updated_at) WHERE b.created_at IS NULL;
CREATE TABLE IF NOT EXISTS source_writes (
  source TEXT NOT NULL,
  kind TEXT NOT NULL,
  target TEXT NOT NULL,
  count BIGINT NOT NULL,
  last_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (source, kind, target)
);
CREATE TABLE IF NOT EXISTS icons (
  name TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  data BYTEA NOT NULL,
  sha256 TEXT NOT NULL,
  owner TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
