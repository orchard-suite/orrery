-- concurrently: the activity log is written by nearly every change, so this index is built without holding a write.
-- The watch's verdict on a change is kept once for each sender and the sender's key for it, however often it is sent.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS changes_observed ON changes (source, (detail->'event'->>'key')) WHERE kind = 'change.observed';
