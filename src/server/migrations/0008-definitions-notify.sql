-- Hubs that serve one database side by side each keep the definitions in memory. A change to a table one of them
-- loads from is told to the others on the `orrery_definitions` channel, as "<application_name> <table>", so each reads
-- it again (`bridge.ts`). The name is the pool's, so a hub knows its own changes.
CREATE OR REPLACE FUNCTION orrery_definitions_changed() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('orrery_definitions', current_setting('application_name', true) || ' ' || TG_TABLE_NAME);
  RETURN NULL;
END
$$ LANGUAGE plpgsql;

DO $$
DECLARE
  name TEXT;
BEGIN
  FOREACH name IN ARRAY ARRAY['blueprints', 'relation_rules', 'scorecards', 'alert_rules', 'actions', 'icons', 'roles', 'sources', 'scope_seen'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS definitions_changed ON %I', name);
    EXECUTE format('CREATE TRIGGER definitions_changed AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH STATEMENT EXECUTE FUNCTION orrery_definitions_changed()', name);
  END LOOP;
END
$$;

-- A person's last visit is stored every minute and is no definition: only who they are and what they may do is.
DROP TRIGGER IF EXISTS definitions_changed ON users;
DROP TRIGGER IF EXISTS definitions_updated ON users;
CREATE TRIGGER definitions_changed AFTER INSERT OR DELETE ON users FOR EACH STATEMENT EXECUTE FUNCTION orrery_definitions_changed();
CREATE TRIGGER definitions_updated AFTER UPDATE ON users FOR EACH ROW WHEN (OLD.admin IS DISTINCT FROM NEW.admin OR OLD.roles IS DISTINCT FROM NEW.roles) EXECUTE FUNCTION orrery_definitions_changed();

-- Settings hold definitions beside marks a forwarder moves every few seconds; only a value that changed is told, and
-- never a mark.
DROP TRIGGER IF EXISTS definitions_changed ON settings;
DROP TRIGGER IF EXISTS definitions_updated ON settings;
DROP TRIGGER IF EXISTS definitions_removed ON settings;
CREATE TRIGGER definitions_changed AFTER INSERT ON settings FOR EACH ROW WHEN (NEW.key NOT LIKE '%.forwarded' AND NEW.key NOT LIKE 'runner:%') EXECUTE FUNCTION orrery_definitions_changed();
CREATE TRIGGER definitions_updated AFTER UPDATE ON settings FOR EACH ROW WHEN (OLD.value IS DISTINCT FROM NEW.value AND NEW.key NOT LIKE '%.forwarded' AND NEW.key NOT LIKE 'runner:%') EXECUTE FUNCTION orrery_definitions_changed();
CREATE TRIGGER definitions_removed AFTER DELETE ON settings FOR EACH ROW WHEN (OLD.key NOT LIKE '%.forwarded' AND OLD.key NOT LIKE 'runner:%') EXECUTE FUNCTION orrery_definitions_changed();

-- contract: drops the run that last saw an entity. The release before this one neither reads nor writes it: what a
-- run saw is in run_seen.
ALTER TABLE entities DROP COLUMN IF EXISTS last_run_id;
