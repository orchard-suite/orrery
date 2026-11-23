-- A batch is one action asked for on many entities at once: the question that picked them, what was asked, and who asked.
-- Each entity still gets its own run, which names its batch, so each is recorded, refused, and retried on its own.
CREATE TABLE IF NOT EXISTS action_batches (
  id          text        PRIMARY KEY,
  action      text        NOT NULL,
  blueprint   text        NOT NULL,
  -- The question that picked the entities, as the grid asked it: the filter, the states, and the rows left out.
  query       jsonb       NOT NULL DEFAULT '{}',
  inputs      jsonb       NOT NULL DEFAULT '{}',
  actor       text        NOT NULL,
  -- How many runs it asked for, and how many it could not: an entity the rules refused, or one gone by the time it was asked.
  asked       integer     NOT NULL DEFAULT 0,
  refused     jsonb       NOT NULL DEFAULT '[]',
  created_at  timestamptz NOT NULL DEFAULT now(),
  stopped_at  timestamptz,
  stopped_by  text,
  -- When its last run ended and that was told: once, by the leader.
  ended_at    timestamptz
);
CREATE INDEX IF NOT EXISTS action_batches_created ON action_batches(created_at DESC);
CREATE INDEX IF NOT EXISTS action_batches_open ON action_batches(created_at) WHERE ended_at IS NULL;
ALTER TABLE action_runs ADD COLUMN IF NOT EXISTS batch text;
CREATE INDEX IF NOT EXISTS action_runs_batch ON action_runs(batch) WHERE batch IS NOT NULL;
