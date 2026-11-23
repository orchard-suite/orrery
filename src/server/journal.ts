// What the database wrote to `link_journal` since a reader last looked: every
// link added, dropped, or moved, and every entity that came, went, or crossed
// into or out of deleted. A reader keeps the oldest transaction that could
// still have been open at its last look and reads from there, so one that
// commits late is never passed over; reading a row twice must be harmless.

import type { Db } from './db.ts'

/** A reader that has not looked for this long works everything out afresh: the journal keeps an hour. */
export const STALE_MS = 30 * 60_000
/** How long the journal keeps what moved. */
export const JOURNAL_MS = 60 * 60_000

/** One row of the journal: a link that moved, or, with no relation, an entity that came, went, or crossed into or out of deleted. */
export interface Moved {
  seq: string
  blueprint: string
  key: string
  relation: string | null
  targetBlueprint: string | null
  targetKey: string | null
}

/** The oldest transaction that may still be open: what a reader keeps before it reads the database whole. */
export async function journalHorizon(db: Db): Promise<string> {
  const at = await db.query<{ xmin: string }>('SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS xmin')
  return at.rows[0]!.xmin
}

/** Every row from `horizon` on, and the horizon to read from next time. */
export async function journalSince(db: Db, horizon: string | null): Promise<{ horizon: string; moved: Moved[] }> {
  const rows = await db.query<{ xmin: string; seq: string | null; blueprint: string | null; key: string | null; relation: string | null; target_blueprint: string | null; target_key: string | null }>(
    `SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS xmin, j.seq::text AS seq, j.blueprint, j.key, j.relation, j.target_blueprint, j.target_key
     FROM (SELECT 1) AS one LEFT JOIN link_journal j ON j.xid >= $1::xid8`,
    [horizon ?? '0'],
  )
  const moved: Moved[] = []
  for (const r of rows.rows) if (r.seq !== null && r.blueprint !== null && r.key !== null) moved.push({ seq: r.seq, blueprint: r.blueprint, key: r.key, relation: r.relation, targetBlueprint: r.target_blueprint, targetKey: r.target_key })
  return { horizon: rows.rows[0]!.xmin, moved }
}
