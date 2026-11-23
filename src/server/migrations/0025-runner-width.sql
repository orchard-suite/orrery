-- A runner's width: how many jobs it runs at once, as it last said when it asked for work. A batch's time is worked out from it.
ALTER TABLE sources ADD COLUMN IF NOT EXISTS width int;
