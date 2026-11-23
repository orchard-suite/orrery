-- The findings ask which runs of the last week dropped most of their scope at once. Almost no run ever does, and
-- with nothing naming those that did, the answer reads every run of the week to find them. This index holds only
-- those runs, newest first.
CREATE INDEX IF NOT EXISTS runs_mass_drops ON runs (started_at DESC) WHERE mass_drop;
