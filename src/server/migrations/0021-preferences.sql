-- A person's preferences: one row a preference they set, theirs alone. What each name means and which values it takes
-- is `PREFERENCES` in src/shared/preferences.ts; a name nobody set reads as its fallback, so a new one needs no row.
CREATE TABLE IF NOT EXISTS person_preferences (
  person     text        NOT NULL,
  name       text        NOT NULL,
  value      jsonb       NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (person, name)
);
