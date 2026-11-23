-- What a run asks for beyond its action, which run it asks again for, what whoever sent it back wrote, and when its
-- deciders were last reminded that it waits.
ALTER TABLE action_runs ADD COLUMN IF NOT EXISTS tiers       jsonb NOT NULL DEFAULT '[]';
ALTER TABLE action_runs ADD COLUMN IF NOT EXISTS revises     text;
ALTER TABLE action_runs ADD COLUMN IF NOT EXISTS note        text;
ALTER TABLE action_runs ADD COLUMN IF NOT EXISTS reminded_at timestamptz;
