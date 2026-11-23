-- When the hub last heard from a run under way: a report from its backend, one that carries nothing included, or word
-- from whatever watches its job. A run is given up once it has gone unheard from for the hub's time, counted from here,
-- or from its start while it is null. Stored at most once a minute for a report that says nothing else.
ALTER TABLE action_runs ADD COLUMN IF NOT EXISTS heard_at timestamptz;
-- The hash of the credential a job run's own container reports with: made as its starter claims the run, good for that
-- run alone, and dropped when the run ends or is put back to be tried again. Null for every other run.
ALTER TABLE action_runs ADD COLUMN IF NOT EXISTS job_token text;
CREATE UNIQUE INDEX IF NOT EXISTS action_runs_job_token ON action_runs (job_token) WHERE job_token IS NOT NULL;
