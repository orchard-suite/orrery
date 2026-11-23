-- A schedule's own lines in the activity log, read for its history: a firing that asked nothing is only there.
CREATE INDEX IF NOT EXISTS changes_schedule ON changes ((detail->>'schedule'), at DESC) WHERE kind LIKE 'schedule.%';
