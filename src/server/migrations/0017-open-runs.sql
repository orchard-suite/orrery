-- Every snapshot that opens asks whether an older one of its source and scope is still open, and the lifecycle tick
-- asks which runs have been open too long. A handful of runs are open at once among every run kept, and with
-- nothing naming them both questions read them all. This index holds only the open runs.
CREATE INDEX IF NOT EXISTS runs_open ON runs (source, scope) WHERE state = 'open';
