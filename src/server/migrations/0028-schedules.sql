-- A schedule: an action asked again and again on a cadence, as the person who set it up, once someone approved it.
-- What it runs on is one entity, a saved query, or nothing; the load it adds is kept with it so it can be judged first.
CREATE TABLE IF NOT EXISTS action_schedules (
  id           text        PRIMARY KEY,
  action       text        NOT NULL,
  title        text        NOT NULL,
  owner        text        NOT NULL,
  target       jsonb       NOT NULL DEFAULT '{}',
  inputs       jsonb       NOT NULL DEFAULT '{}',
  cadence      jsonb       NOT NULL,
  deliver      jsonb       NOT NULL DEFAULT '[]',
  state        text        NOT NULL,
  load         jsonb,
  decided_by   text,
  decided_at   timestamptz,
  note         text,
  next_at      timestamptz,
  last_at      timestamptz,
  last_run     text,
  last_batch   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS action_schedules_due ON action_schedules (next_at) WHERE state = 'active';
-- A run or a batch a schedule asked names it, so what each schedule costs is read from what it ran.
ALTER TABLE action_runs ADD COLUMN IF NOT EXISTS schedule text;
ALTER TABLE action_batches ADD COLUMN IF NOT EXISTS schedule text;
CREATE INDEX IF NOT EXISTS action_runs_schedule ON action_runs (schedule) WHERE schedule IS NOT NULL;
