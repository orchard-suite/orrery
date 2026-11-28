-- The agent that asked for a run with its person's token (ORY-2002): the run is its person's (actor), and the agent
-- asked it. Null for a run a person asked themselves.
ALTER TABLE action_runs ADD COLUMN IF NOT EXISTS agent TEXT;
