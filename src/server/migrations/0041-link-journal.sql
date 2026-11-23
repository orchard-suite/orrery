-- What a person owns is walked once and then moved in place (`ownership.ts`): every link that is added, dropped, or
-- moved, and every entity that comes, goes, or is deleted or brought back, is written here by the database itself,
-- whoever changed it. A hub reads what came after its last look and works out again only the entities named.
-- `xid` is the writing transaction: a hub reads every row of a transaction that may still have been open when it last
-- looked, so one that commits late is never passed over.
CREATE TABLE IF NOT EXISTS link_journal (
  seq BIGSERIAL PRIMARY KEY,
  xid XID8 NOT NULL DEFAULT pg_current_xact_id(),
  blueprint TEXT NOT NULL,
  key TEXT NOT NULL,
  relation TEXT,
  target_blueprint TEXT,
  target_key TEXT,
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS link_journal_xid ON link_journal (xid);
CREATE INDEX IF NOT EXISTS link_journal_at ON link_journal (at);

CREATE OR REPLACE FUNCTION orrery_links_added() RETURNS trigger AS $$
BEGIN
  INSERT INTO link_journal (blueprint, key, relation, target_blueprint, target_key)
    SELECT DISTINCT blueprint, key, relation, target_blueprint, target_key FROM added;
  RETURN NULL;
END
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION orrery_links_dropped() RETURNS trigger AS $$
BEGIN
  INSERT INTO link_journal (blueprint, key, relation, target_blueprint, target_key)
    SELECT DISTINCT blueprint, key, relation, target_blueprint, target_key FROM dropped;
  RETURN NULL;
END
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION orrery_links_moved() RETURNS trigger AS $$
BEGIN
  INSERT INTO link_journal (blueprint, key, relation, target_blueprint, target_key)
    SELECT blueprint, key, relation, target_blueprint, target_key FROM dropped
    UNION SELECT blueprint, key, relation, target_blueprint, target_key FROM added;
  RETURN NULL;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS links_added ON relations;
DROP TRIGGER IF EXISTS links_dropped ON relations;
DROP TRIGGER IF EXISTS links_moved ON relations;
CREATE TRIGGER links_added AFTER INSERT ON relations REFERENCING NEW TABLE AS added FOR EACH STATEMENT EXECUTE FUNCTION orrery_links_added();
CREATE TRIGGER links_dropped AFTER DELETE ON relations REFERENCING OLD TABLE AS dropped FOR EACH STATEMENT EXECUTE FUNCTION orrery_links_dropped();
CREATE TRIGGER links_moved AFTER UPDATE ON relations REFERENCING OLD TABLE AS dropped NEW TABLE AS added FOR EACH STATEMENT EXECUTE FUNCTION orrery_links_moved();

-- An entity is in a walk while it is not deleted: one that comes, goes, or crosses that line is written as itself. Row
-- by row, and only for those: an entity's row is wide, and a write that leaves its state alone fires nothing.
CREATE OR REPLACE FUNCTION orrery_entity_moved() RETURNS trigger AS $$
DECLARE
  e RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN e := OLD; ELSE e := NEW; END IF;
  INSERT INTO link_journal (blueprint, key) VALUES (e.blueprint, e.key);
  RETURN NULL;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS entity_came ON entities;
DROP TRIGGER IF EXISTS entity_went ON entities;
DROP TRIGGER IF EXISTS entity_crossed ON entities;
CREATE TRIGGER entity_came AFTER INSERT ON entities FOR EACH ROW EXECUTE FUNCTION orrery_entity_moved();
CREATE TRIGGER entity_went AFTER DELETE ON entities FOR EACH ROW EXECUTE FUNCTION orrery_entity_moved();
CREATE TRIGGER entity_crossed AFTER UPDATE OF state ON entities FOR EACH ROW WHEN ((OLD.state = 'deleted') <> (NEW.state = 'deleted')) EXECUTE FUNCTION orrery_entity_moved();
