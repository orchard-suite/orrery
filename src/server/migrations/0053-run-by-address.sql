-- Where the person who asked for a run called from, as the hub read it through the proxy header it trusts: set only on
-- a run a person asked for themselves, signed in, and read back into the run's scope as `by.address` when it is sent.
ALTER TABLE action_runs ADD COLUMN IF NOT EXISTS by_address text;
