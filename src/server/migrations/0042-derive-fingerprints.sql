-- What makes derived state cheap to keep current.
-- `blueprints.shape` is a fingerprint of the parts of a blueprint derivation reads, and `shaped_at` when it last
-- changed: a stored row is current for its blueprint's model once it was derived after `shaped_at`, so a save that
-- changes only what derivation never reads (a description, a format, a ground) leaves every row as it stands. A row
-- whose `shape` no longer matches its spec was saved by a hub that kept no shape, and is read as changed then.
-- `derived.fingerprint` is a fingerprint of everything a stored row holds: a row derived the same as it is stored is
-- told by it alone, and has only its `derived_at` moved. A row the release before writes keeps none, and is compared
-- and written in full.
-- A stored row that is derived the same is updated in place more often than it is rewritten: room is left on each
-- page for the new version of a row to stay beside the old one, so no index is written for it.
ALTER TABLE blueprints ADD COLUMN IF NOT EXISTS shape TEXT;
ALTER TABLE blueprints ADD COLUMN IF NOT EXISTS shaped_at TIMESTAMPTZ;
ALTER TABLE derived ADD COLUMN IF NOT EXISTS fingerprint TEXT;
ALTER TABLE derived SET (fillfactor = 80);
