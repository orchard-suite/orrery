-- The person a product asked a run for, by sign-in address, when the product asked as itself: kept as data on the run,
-- never its asker. Null for every other run.
ALTER TABLE action_runs ADD COLUMN IF NOT EXISTS requested_for text;
