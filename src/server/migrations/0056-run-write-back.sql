-- What a run's backend handed back to write on the entity it ran on (`::refresh::` lines of the fields its action
-- refreshes), held until the run ends: written once it succeeds, let go otherwise. And what was written back, field by
-- field with the value each held before, which the run's page shows. Null while nothing was.
ALTER TABLE action_runs ADD COLUMN IF NOT EXISTS refresh jsonb NOT NULL DEFAULT '{}';
ALTER TABLE action_runs ADD COLUMN IF NOT EXISTS wrote_back jsonb;
