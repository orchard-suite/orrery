-- Which results of a schedule's firings its owner and the people it names hear of: only failures, unless they ask for more.
ALTER TABLE action_schedules ADD COLUMN IF NOT EXISTS tell text NOT NULL DEFAULT 'failed';
