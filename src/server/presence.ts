// Who was here in the last day: the people the hub let in and the browser tabs
// that reported. Kept in Postgres, so every hub reports the same count and a
// restart forgets nothing. A person's last visit is `users.last_seen_at`,
// which `access.ts` keeps; a tab's is a row here.

import type { Db } from './db.ts'
import type { Logger } from './log.ts'

const DAY_MS = 86_400_000
/** A tab is written at most once in this long, however often it reports. */
const WRITE_EVERY_MS = 60_000

export interface Present {
  people: number
  tabs: number
}

export class Presence {
  private readonly db: Db
  private readonly log: Logger
  /** When this hub last wrote each tab, so a tab costs one write a minute. */
  private readonly written = new Map<string, number>()

  constructor(db: Db, log: Logger) {
    this.db = db
    this.log = log
  }

  /** Notes that a browser tab reported now. */
  async tab(id: string): Promise<void> {
    const now = Date.now()
    if (now - (this.written.get(id) ?? 0) < WRITE_EVERY_MS) return
    this.written.set(id, now)
    await this.db.query('INSERT INTO browser_tabs (id, seen_at) VALUES ($1, now()) ON CONFLICT (id) DO UPDATE SET seen_at = EXCLUDED.seen_at', [id])
  }

  /** How many people and tabs were seen in the last day. */
  async count(): Promise<Present> {
    const res = await this.db.query<{ people: string; tabs: string }>(
      `SELECT (SELECT count(*) FROM users WHERE last_seen_at > now() - interval '1 day')::text AS people,
              (SELECT count(*) FROM browser_tabs WHERE seen_at > now() - interval '1 day')::text AS tabs`,
    )
    const row = res.rows[0]
    return { people: Number(row?.people ?? 0), tabs: Number(row?.tabs ?? 0) }
  }

  /** Lets go of the tabs not seen for a day, here and in what this hub remembers writing. */
  async prune(): Promise<void> {
    const gone = await this.db.query("DELETE FROM browser_tabs WHERE seen_at < now() - interval '1 day'")
    const cutoff = Date.now() - DAY_MS
    for (const [id, at] of this.written) if (at < cutoff) this.written.delete(id)
    if (gone.rowCount) this.log.info('browser tabs pruned', { count: gone.rowCount })
  }
}
