-- The mark of what the activity log forwarder has sent is kept under the name of the service it sends to, Annals.
-- A hub that forwarded under the old name keeps its place, so nothing is sent twice from the start.
UPDATE settings SET key = 'annals.forwarded' WHERE key = 'ledger.forwarded' AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'annals.forwarded');
