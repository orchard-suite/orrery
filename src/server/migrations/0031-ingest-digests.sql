-- What each source last sent of an entity in full, as the digest it named it by, and when the hub took it. A later
-- batch may name the entity by that digest alone (a sighting): the hub takes it as sent again while the entity has not
-- changed since and its blueprint was not saved since, and asks for it in full otherwise.
CREATE TABLE IF NOT EXISTS ingest_digests (
  source TEXT NOT NULL,
  blueprint TEXT NOT NULL,
  key TEXT NOT NULL,
  digest TEXT NOT NULL,
  at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (source, blueprint, key),
  FOREIGN KEY (blueprint, key) REFERENCES entities (blueprint, key) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS ingest_digests_entity ON ingest_digests (blueprint, key);

-- Entities a batch named by a sighting, for the write kind: what a source sent without sending it.
ALTER TABLE load_hours ADD COLUMN IF NOT EXISTS sighted BIGINT NOT NULL DEFAULT 0;
