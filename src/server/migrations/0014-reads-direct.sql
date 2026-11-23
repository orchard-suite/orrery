-- `derived_reads` answers "who reads this entity" a thousand ids to a statement. With GIN's pending list on, every one
-- of those lookups also walks every entry not yet merged into the index, which is thousands while hubs derive: a
-- push that asks for the readers of a batch then waits a second on it. Entries go straight into the index instead.
ALTER INDEX derived_reads SET (fastupdate = off);
SELECT gin_clean_pending_list('derived_reads');
