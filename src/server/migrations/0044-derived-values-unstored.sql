-- A field the hub computes (a mirror, an aggregation, a calculation, a trend read from history) has no stored value:
-- a value kept from before the field was computed is dropped from every layer, so nothing shows or carries it.
WITH computed AS (
  SELECT b.id, array_agg(f.key) AS names
    FROM blueprints b, jsonb_each(coalesce(b.spec::jsonb->'fields', '{}'::jsonb)) f
   WHERE jsonb_typeof(f.value) = 'object'
     AND (coalesce(f.value->>'mirror', '') <> ''
       OR jsonb_typeof(f.value->'aggregation') = 'object'
       OR coalesce(f.value->>'calculation', '') <> ''
       OR coalesce(f.value->>'derived', 'false') NOT IN ('false', '')
       OR f.value->'history' ? 'of')
   GROUP BY b.id
)
UPDATE entities e
   SET ui = e.ui - c.names, pushed = e.pushed - c.names, override = e.override - c.names, git = e.git - c.names
  FROM computed c
 WHERE e.blueprint = c.id
   AND (e.ui ?| c.names OR e.pushed ?| c.names OR e.override ?| c.names OR e.git ?| c.names);
