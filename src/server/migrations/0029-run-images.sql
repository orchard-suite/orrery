-- A run's pictures, kept apart from the run: a list of runs or a batch's grid reads each run's outputs, and a screenshot in
-- them made a batch of thousands read hundreds of megabytes each time. The run keeps the names; a picture is read alone.
CREATE TABLE IF NOT EXISTS action_run_images (
  run        text        NOT NULL,
  name       text        NOT NULL,
  data       text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run, name)
);
CREATE INDEX IF NOT EXISTS action_run_images_created ON action_run_images (created_at);
ALTER TABLE action_runs ADD COLUMN IF NOT EXISTS images text[] NOT NULL DEFAULT '{}';
-- The pictures runs already hold move out of their outputs.
INSERT INTO action_run_images (run, name, data, created_at)
  SELECT r.id, o.key, o.value #>> '{}', coalesce(r.finished_at, r.created_at)
  FROM action_runs r CROSS JOIN LATERAL jsonb_each(r.outputs) o
  WHERE jsonb_typeof(o.value) = 'string' AND o.value #>> '{}' LIKE 'data:image/%'
ON CONFLICT DO NOTHING;
UPDATE action_runs r SET
  images = ARRAY(SELECT o.key FROM jsonb_each(r.outputs) o WHERE jsonb_typeof(o.value) = 'string' AND o.value #>> '{}' LIKE 'data:image/%' ORDER BY o.key),
  outputs = r.outputs - ARRAY(SELECT o.key FROM jsonb_each(r.outputs) o WHERE jsonb_typeof(o.value) = 'string' AND o.value #>> '{}' LIKE 'data:image/%')
WHERE r.outputs::text LIKE '%data:image/%';
-- A list of the oldest runs reads this, and the retention pass deletes by it.
CREATE INDEX IF NOT EXISTS action_runs_created ON action_runs (created_at);
