-- The grant a run made as a person holds from the signed-in approval that started it, sealed with the hub's secret key:
-- what lets the hub ask the issuer for a fresh token in the approver's name when the run's turn comes, however long it
-- waits behind others of its action. Taken off the run as it is handed on, and dropped when it ends, so nothing later
-- (a retry, a schedule) can call as them. Null while it holds none.
ALTER TABLE action_runs ADD COLUMN IF NOT EXISTS behalf_grant text;
