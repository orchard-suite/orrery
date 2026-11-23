-- How many people must approve a run before it starts, and who has so far. A run needs one unless its action asks for more
-- (`quorum`); it is fixed when the run is asked, so changing the action never moves a run already waiting.
ALTER TABLE action_runs ADD COLUMN IF NOT EXISTS approvals_needed integer NOT NULL DEFAULT 1;
ALTER TABLE action_runs ADD COLUMN IF NOT EXISTS approved_by jsonb NOT NULL DEFAULT '[]';
