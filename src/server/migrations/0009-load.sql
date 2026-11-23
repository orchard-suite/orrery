-- What costs the hub, by the hour: deriving and grid shapes by blueprint, writes by source, and API calls by caller.
-- Each hub adds what it noted to the hour's row at most once a minute, and the rows are pruned on the lifecycle tick.
-- What `calls`, `rows`, and `extra` count depends on the kind.
CREATE TABLE IF NOT EXISTS load_hours (
  hour TIMESTAMPTZ NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  calls BIGINT NOT NULL DEFAULT 0,
  ms DOUBLE PRECISION NOT NULL DEFAULT 0,
  rows BIGINT NOT NULL DEFAULT 0,
  extra BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (hour, kind, name)
);
