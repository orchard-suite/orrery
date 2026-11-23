-- A relation belongs to the source that wrote it: a writer reads, keeps, and drops only its own rows at its layer. The
-- key now says so, so two sources that name the same link at the same layer each keep a row, where the second write
-- used to fail on the first one's. Readers take a link once however many sources hold it.
-- contract: drops the old key, which nothing reads: no statement names it in ON CONFLICT, and the release before writes
-- the same rows under the wider key.
ALTER TABLE relations DROP CONSTRAINT IF EXISTS relations_pkey;
ALTER TABLE relations ADD CONSTRAINT relations_pkey PRIMARY KEY (blueprint, key, relation, layer, source, target_blueprint, target_key);
