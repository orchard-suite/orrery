-- When a derived row's values next change because time passes: a trend's span ending, an entity leaving a window, an
-- age crossing its span, the hour for a calculation of the time. The leader derives the row again when that moment
-- arrives, and not before. Null: nothing in the row reads the time.
-- Rows already stored are given now, so the first pass after this step derives each once and it names its own moment;
-- the release before, writing beside this one, leaves the same for its rows to be taken up.
ALTER TABLE derived ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ DEFAULT now();
CREATE INDEX IF NOT EXISTS derived_expires ON derived (expires_at) WHERE expires_at IS NOT NULL;
