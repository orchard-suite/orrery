-- The next round of a run is the run that revises it: found by this index, which holds only the runs that revise another.
CREATE INDEX IF NOT EXISTS action_runs_revises ON action_runs (revises) WHERE revises IS NOT NULL;
