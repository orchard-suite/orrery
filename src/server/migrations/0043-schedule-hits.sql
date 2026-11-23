-- What each schedule runs on, as entity references: what it was asked to run on, or what its filter or saved
-- query matched when it was last saved or fired. Its record in the catalog links to them.
ALTER TABLE action_schedules ADD COLUMN IF NOT EXISTS hits jsonb NOT NULL DEFAULT '[]';
-- A schedule on one entity, or on the entities picked, hits what it names.
UPDATE action_schedules SET hits = jsonb_build_array(target->'entity') WHERE target ? 'entity' AND hits = '[]';
UPDATE action_schedules SET hits = target->'entities' WHERE target ? 'entities' AND hits = '[]';
-- One on a filter or a saved query hit what its last firing ran on; one that never fired is worked out at its next save or firing.
UPDATE action_schedules s
   SET hits = coalesce((
     SELECT jsonb_agg(DISTINCT jsonb_build_object('blueprint', r.blueprint, 'key', r.key))
       FROM action_runs r
      WHERE r.schedule = s.id AND r.blueprint IS NOT NULL AND r.key IS NOT NULL
        AND ((s.last_batch IS NOT NULL AND r.batch = s.last_batch) OR r.id = s.last_run)
   ), '[]')
 WHERE (target ? 'matching' OR target ? 'query') AND hits = '[]';
