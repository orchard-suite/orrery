-- A change set is many runs asked together for one decision: each item its own action, entity, and inputs, and the set
-- one title and the reason behind it. Each item is still its own run, which names its set and its place in it, so each is
-- recorded, run, and retried on its own; the set is what the approver reads and decides.
CREATE TABLE IF NOT EXISTS change_sets (
  id            text        PRIMARY KEY,
  title         text        NOT NULL,
  note          text,
  actor         text        NOT NULL,
  -- The product that asked in the person's name, when one did.
  through       text,
  -- The set whose failed items this one asks again for.
  retries       text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- How it was decided as a whole: approved, rejected, or withdrawn; null while it waits.
  decision      text,
  decided_by    text,
  decided_at    timestamptz,
  decision_note text,
  -- When its deciders were told again that it still waits: once.
  reminded_at   timestamptz,
  -- When its last run ended and that was told: once, by the leader.
  ended_at      timestamptz
);
CREATE INDEX IF NOT EXISTS change_sets_created ON change_sets (created_at DESC);
CREATE INDEX IF NOT EXISTS change_sets_open ON change_sets (created_at) WHERE ended_at IS NULL;
ALTER TABLE action_runs ADD COLUMN IF NOT EXISTS change_set text;
-- An item's place in its set: runs of one action wait their turn in this order.
ALTER TABLE action_runs ADD COLUMN IF NOT EXISTS set_index integer;
CREATE INDEX IF NOT EXISTS action_runs_change_set ON action_runs (change_set, set_index) WHERE change_set IS NOT NULL;
