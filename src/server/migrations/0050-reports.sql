-- Reports: every version of each report's layout, and what each edition keeps beside its record: the blocks it was
-- drawn from and the data sets it read. A preview's drawing is kept with its run, and let go with the run's pictures.
CREATE TABLE IF NOT EXISTS report_versions (
  report text NOT NULL,
  version integer NOT NULL,
  layout text NOT NULL,
  note text,
  by text NOT NULL,
  restored_from integer,
  at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (report, version)
);

CREATE TABLE IF NOT EXISTS report_editions (
  report text NOT NULL,
  number integer NOT NULL,
  content jsonb NOT NULL,
  data jsonb NOT NULL,
  published_at timestamptz NOT NULL,
  PRIMARY KEY (report, number)
);
CREATE INDEX IF NOT EXISTS report_editions_published ON report_editions (published_at);

CREATE TABLE IF NOT EXISTS report_previews (
  run text PRIMARY KEY,
  report text NOT NULL,
  content jsonb NOT NULL,
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS report_previews_created ON report_previews (created_at);
