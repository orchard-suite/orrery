-- The browser tabs that reported, by the session id the page names, and when one last did: what the hub counts as tabs
-- open today. Written at most once a minute a tab, and pruned to a day on the lifecycle tick.
CREATE TABLE IF NOT EXISTS browser_tabs (
  id TEXT PRIMARY KEY,
  seen_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS browser_tabs_seen ON browser_tabs (seen_at);
