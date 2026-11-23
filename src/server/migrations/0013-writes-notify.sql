-- What each source wrote is kept by every hub and stored at most once a minute a source. A hub that serves beside
-- another must say the same of a source, so a stored change is told to the others like a definition, and each reads
-- the ledger again.
DROP TRIGGER IF EXISTS definitions_changed ON source_writes;
CREATE TRIGGER definitions_changed AFTER INSERT OR UPDATE OR DELETE ON source_writes FOR EACH STATEMENT EXECUTE FUNCTION orrery_definitions_changed();
