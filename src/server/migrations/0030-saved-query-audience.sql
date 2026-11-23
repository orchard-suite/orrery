-- A saved query shared with one audience of the access policy rather than everyone: whoever saved it is in it.
ALTER TABLE saved_queries ADD COLUMN IF NOT EXISTS audience text;
