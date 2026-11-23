-- The history the hub keeps of a field marked `history`: a point for an
-- entity only when its value moved since its last point, kept for the
-- field's `keep`.
CREATE TABLE IF NOT EXISTS field_history (
  blueprint TEXT NOT NULL,
  key TEXT NOT NULL,
  field TEXT NOT NULL,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  value JSONB,
  PRIMARY KEY (blueprint, field, key, at)
);
