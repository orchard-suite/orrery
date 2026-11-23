-- When each blueprint's lists last moved, by the time of the event that said so, and under '* everything' when
-- everything did: what a list's tag names its state by. Every hub stores what it heard, the latest time winning, so
-- every hub names the same state the same way, and a hub that starts reads them.
CREATE TABLE IF NOT EXISTS list_stamps (
  name TEXT PRIMARY KEY,
  at BIGINT NOT NULL
);
