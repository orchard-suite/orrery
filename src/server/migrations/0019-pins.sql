-- What a person pinned to the top of their own pages: one row a pin, theirs alone, in the order `position` says.
-- A pin names what it points at and nothing more, so one to something gone or closed to them is kept and not shown.
CREATE TABLE IF NOT EXISTS pins (
  person     text        NOT NULL,
  kind       text        NOT NULL,
  id         text        NOT NULL,
  position   integer     NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (person, kind, id)
);
