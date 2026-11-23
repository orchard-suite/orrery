-- The lifecycle tick asks every five minutes which tombstones are old enough to remove, and which still hold
-- pushed relations. Both read every tombstone's whole row to learn its age and its key: thousands of pages for an
-- answer that is nearly always none. This index holds only the tombstones, by age, with their keys, so both are
-- answered from it.
CREATE INDEX IF NOT EXISTS entities_tombstones ON entities (deleted_at) INCLUDE (blueprint, key) WHERE state = 'deleted';
