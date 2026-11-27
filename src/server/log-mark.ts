// Where a forwarder of the activity log stands: the id of the last row it has
// passed, kept in the settings under its own name. A pass reads every row
// after its mark, and moves the mark only past rows logged more than a
// minute ago, so a row whose transaction commits late is still read.

import type { Db } from './db.ts'

/** A row logged this recently may sit behind one whose transaction has not committed. */
export const SETTLE_SECONDS = 60

/** The id of the last row the forwarder named `key` has passed; '0' before its first pass. */
export async function markOf(db: Db, key: string): Promise<string> {
  const row = await db.query<{ value: { id: string } }>(`SELECT value FROM settings WHERE key = $1`, [key])
  return row.rows[0]?.value.id ?? '0'
}

/** The newest row logged long enough ago that nothing before it can still commit, or null when there is none. */
export async function settledCeiling(db: Db): Promise<string | null> {
  const settled = await db.query<{ id: string | null }>(`SELECT max(id) AS id FROM changes WHERE coalesce(logged_at, at) < clock_timestamp() - make_interval(secs => $1)`, [SETTLE_SECONDS])
  return settled.rows[0]?.id ?? null
}

/** Moves the forwarder's mark to the ceiling when that is past it. Whether it moved. */
export async function moveMark(db: Db, key: string, mark: string, ceiling: string | null): Promise<boolean> {
  if (!ceiling || BigInt(ceiling) <= BigInt(mark)) return false
  await db.query(`INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, JSON.stringify({ id: ceiling })])
  return true
}
