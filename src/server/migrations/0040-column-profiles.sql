-- How each text field's values spread over its blueprint's rows, measured now and then by the leader: how many values,
-- how many different ones, and how many the twelve most common hold. The Load page reads it to say which columns
-- are worth a chip and which cost more than they show. One row a field; a blueprint is measured whole and replaced.
CREATE TABLE IF NOT EXISTS column_profiles (
  blueprint   text        NOT NULL,
  field       text        NOT NULL,
  rows        bigint      NOT NULL,
  values_held bigint      NOT NULL,
  different   bigint      NOT NULL,
  top_held    bigint      NOT NULL,
  measured_at timestamptz NOT NULL,
  PRIMARY KEY (blueprint, field)
);
