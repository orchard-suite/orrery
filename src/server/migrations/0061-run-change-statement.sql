-- A run that carries a change statement keeps the statement's digest, taken when it was asked, and when its
-- change.ended event was written, so it is written once whatever ends the run.
ALTER TABLE action_runs ADD COLUMN IF NOT EXISTS statement_digest TEXT;
ALTER TABLE action_runs ADD COLUMN IF NOT EXISTS change_ended_at TIMESTAMPTZ;
