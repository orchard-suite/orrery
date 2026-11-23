-- What a backend said of a run beyond its lines: the values it ended with, by name, and the steps it named, in order.
-- Both columns default to empty, so a hub of the release before, whose insert names its own columns, goes on writing runs.
ALTER TABLE action_runs ADD COLUMN IF NOT EXISTS outputs jsonb NOT NULL DEFAULT '{}';
ALTER TABLE action_runs ADD COLUMN IF NOT EXISTS steps   jsonb NOT NULL DEFAULT '[]';
