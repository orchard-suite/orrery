-- concurrently: the activity log is written by nearly every change, so this index is built without holding a write.
-- The activity log read by kind, newest first: a kind with few rows, such as a run's change events, is found from
-- its own rows rather than by walking the whole log back.
CREATE INDEX CONCURRENTLY IF NOT EXISTS changes_kind ON changes (kind, id DESC);
