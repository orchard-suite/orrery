-- Who a product named to decide a run it asked for a person: grants judged on the decider's own person entity, as a
-- rule's are. Null when nobody was named, and then the action's rules say who decides.
ALTER TABLE action_runs ADD COLUMN IF NOT EXISTS approvers jsonb;
