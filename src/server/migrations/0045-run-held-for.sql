-- Whose approval a run waits for, set when it is asked: 'self' when the rule that let its asker in holds it for their own
-- approval alone, 'others' when someone else decides it, and null for a run that never waited or was asked before this.
ALTER TABLE action_runs ADD COLUMN IF NOT EXISTS held_for text;
