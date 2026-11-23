-- Two findings read the activity log for one kind of row each: an override a source cleared, and a write that
-- overwrote another source's value. Both kinds are rare among millions of rows, and with no index each read walked
-- the whole table every time the findings were worked out: four seconds each on a log of 2.6 million rows. These
-- hold only the rows each finding reads.
CREATE INDEX IF NOT EXISTS changes_override_cleared ON changes (at DESC) WHERE kind = 'override.cleared';
CREATE INDEX IF NOT EXISTS changes_overwrote ON changes (at DESC) WHERE kind = 'entity.updated' AND detail ? 'overwrote';
