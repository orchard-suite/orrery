-- A saved query: one or more blueprints, each with its conditions, and the columns to show. Whoever saved it changes it;
-- shared, everyone may run it, and each sees only what they may see.
CREATE TABLE IF NOT EXISTS saved_queries (
  id          text        PRIMARY KEY,
  title       text        NOT NULL,
  description text,
  owner       text        NOT NULL,
  shared      boolean     NOT NULL DEFAULT false,
  spec        jsonb       NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS saved_queries_owner ON saved_queries (owner);
