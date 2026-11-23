-- The activity of one batch is read on its own when a person opens the batch in the log, so it is found by the batch it names.
CREATE INDEX IF NOT EXISTS changes_batch ON changes ((detail->>'batch')) WHERE detail->>'batch' IS NOT NULL;
-- A list of runs that folds batches reads the runs asked alone.
CREATE INDEX IF NOT EXISTS action_runs_alone ON action_runs (created_at DESC) WHERE batch IS NULL;
