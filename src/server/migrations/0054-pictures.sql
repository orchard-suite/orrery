-- People's pictures, by the address they sign in with: the photo a source put for them (an identity provider's
-- profile photo), in two sizes, and the icon they picked for themselves in its place. A person entity the person
-- setting answers to that address shows the pick, else the photo. A row with neither is removed.
CREATE TABLE IF NOT EXISTS pictures (
  address    text        PRIMARY KEY,
  sha256     text,
  small      bytea,
  large      bytea,
  source     text,
  photo_at   timestamptz,
  pick       text,
  picked_at  timestamptz,
  CHECK ((sha256 IS NULL) = (small IS NULL) AND (sha256 IS NULL) = (large IS NULL) AND (sha256 IS NULL) = (source IS NULL))
);
-- A photo is served by its hash.
CREATE INDEX IF NOT EXISTS pictures_sha ON pictures (sha256) WHERE sha256 IS NOT NULL;

-- Every hub keeps who has a picture in memory, so a change on one is told to the others (`bridge.ts`).
DROP TRIGGER IF EXISTS definitions_changed ON pictures;
CREATE TRIGGER definitions_changed AFTER INSERT OR UPDATE OR DELETE ON pictures FOR EACH STATEMENT EXECUTE FUNCTION orrery_definitions_changed();
