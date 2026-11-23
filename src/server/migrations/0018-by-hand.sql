-- The posture lists every value a person set by hand on what access is decided from. Such values are few among
-- every row a source wrote, and with nothing naming them the list read every row of each blueprint it asked about.
-- These indexes hold only the entities a person changed and the relations a person set.
CREATE INDEX IF NOT EXISTS entities_by_hand ON entities (blueprint) WHERE ui <> '{}'::jsonb OR override <> '{}'::jsonb;
CREATE INDEX IF NOT EXISTS relations_by_hand ON relations (blueprint, relation) WHERE layer = 'ui';
