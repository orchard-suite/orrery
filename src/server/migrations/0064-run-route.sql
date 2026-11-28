-- A run of an action the judge routes keeps its route as its change.routed event says it (the judge, the route, the
-- reasons, and the drafts), and what the route asks beside the action's own approval (route_asks): the grants it names and how many
-- of them must agree. A run whose action asks no one itself waits for none of its own approvals (approvals_needed 0).
ALTER TABLE action_runs ADD COLUMN IF NOT EXISTS routed JSONB;
ALTER TABLE action_runs ADD COLUMN IF NOT EXISTS route_asks JSONB;
