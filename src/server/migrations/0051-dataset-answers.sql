-- The last answer of each published dataset: the rows its tool gave, kept
-- until they are older than the dataset's `fresh`, so a query that reads one
-- does not start a runner's job each time it is asked.
CREATE TABLE IF NOT EXISTS dataset_answers (
  action text PRIMARY KEY,
  answer jsonb NOT NULL,
  run text,
  fetched_at timestamptz NOT NULL DEFAULT now()
);
