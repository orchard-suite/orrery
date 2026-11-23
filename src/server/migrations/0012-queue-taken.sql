-- Hubs that derive side by side each take their own entities from the queue: a hub marks what it took until a moment,
-- and the others pass it over until then. A hub that stops mid-pass leaves them to be taken again once that moment
-- is past. Null: the entity waits.
-- An entity has one waiting row and any number taken: a writer that changes an entity a hub is deriving queues it
-- anew beside the taken row, and never touches that row, so a writer and a deriving hub never wait on each other.
-- The release before this one takes without marking and removes by entity, and derives beside this one as before:
-- an entity both took is derived twice and stored once.
ALTER TABLE derive_queue ADD COLUMN IF NOT EXISTS taken_until TIMESTAMPTZ;
ALTER TABLE derive_queue DROP CONSTRAINT IF EXISTS derive_queue_pkey;
CREATE UNIQUE INDEX IF NOT EXISTS derive_queue_waiting ON derive_queue (blueprint, key) WHERE taken_until IS NULL;
CREATE INDEX IF NOT EXISTS derive_queue_taken ON derive_queue (blueprint, key) WHERE taken_until IS NOT NULL;
