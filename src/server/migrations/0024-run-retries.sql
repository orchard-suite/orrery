-- A run of an action with a retry is tried again in the same run: the try under way, whether its backend called this try's
-- failure final, and when the next try is due while it waits.
ALTER TABLE action_runs ADD COLUMN IF NOT EXISTS attempt  int NOT NULL DEFAULT 1;
ALTER TABLE action_runs ADD COLUMN IF NOT EXISTS final    boolean NOT NULL DEFAULT false;
ALTER TABLE action_runs ADD COLUMN IF NOT EXISTS retry_at timestamptz;
CREATE INDEX IF NOT EXISTS action_runs_retry_at ON action_runs (retry_at) WHERE retry_at IS NOT NULL;
