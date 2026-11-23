-- For each input of a run that edits a list the entity holds (`current` on a list input), that list as the hub rendered
-- it when the run was asked for, by input name: what the run's change is read against, and what its backend is handed as
-- `run.current`. Null for a run with no such input.
ALTER TABLE action_runs ADD COLUMN IF NOT EXISTS current jsonb;
