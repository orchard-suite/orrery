-- What each person starred: their favorite entities, across every blueprint, one row a star.
-- A star is a person's own way of finding things in the catalog: every catalog grid they read puts what they
-- starred first, and their favorites page lists it. A query and a report never read it.
-- A star to something they may no longer see is kept and not shown. It goes only when its entity is purged,
-- and moves with a blueprint that is renamed.
CREATE TABLE IF NOT EXISTS stars (
  person     text        NOT NULL,
  blueprint  text        NOT NULL,
  key        text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (person, blueprint, key)
);
-- A purge finds the stars of what they let go by the entity.
CREATE INDEX IF NOT EXISTS stars_entity ON stars (blueprint, key);
