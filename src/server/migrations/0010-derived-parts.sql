-- A stored row sends back only the readers that read a part of it that moved, so two things are kept beside it.
-- `pointed` is who points at the entity, as one short string, where a path of another blueprint steps through it
-- that way: it is in no stored value, and its change sends those readers back. Null where no path asks.
-- `way` is how the row was derived, counted up when a release derives rows another way; the backstop derives again
-- every row an earlier way left. Rows already stored, and rows the release before writes beside this one, are way 1.
ALTER TABLE derived ADD COLUMN IF NOT EXISTS pointed TEXT;
ALTER TABLE derived ADD COLUMN IF NOT EXISTS way SMALLINT NOT NULL DEFAULT 1;
