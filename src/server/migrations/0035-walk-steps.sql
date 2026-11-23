-- The stops a person put on their walk through a map: one row a stop, theirs alone. A stop is a climb on one place of
-- one map (a ladder, the rung it starts from, and what it is kept to, a garden or a kind), with the things it named then.
CREATE TABLE IF NOT EXISTS walk_steps (
  id               text        PRIMARY KEY,
  person           text        NOT NULL,
  holder_blueprint text        NOT NULL,
  holder_key       text        NOT NULL,
  place            text,
  ladder           text        NOT NULL,
  from_rung        integer     NOT NULL,
  scope            text,
  things           text[]      NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS walk_steps_one ON walk_steps (person, holder_blueprint, holder_key, coalesce(place, E'\x01'), ladder, from_rung, coalesce(scope, E'\x01'));
