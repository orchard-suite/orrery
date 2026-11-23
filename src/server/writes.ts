// The write ledger: per source, what it has written and when it last did,
// by target. The entities it wrote by blueprint, the blueprints it offered,
// and the actions it put. A write is noted here where the hub accepts it,
// never when it is refused, and this module alone keeps the table.

import type { SourceWrites } from '../shared/model.ts'
import type { Db } from './db.ts'
import type { Logger } from './log.ts'

export type WriteKind = 'entity' | 'blueprint' | 'action' | 'scorecard'

interface Mark {
  count: number
  lastAt: Date
}

interface Row {
  source: string
  kind: WriteKind
  target: string
  count: string
  last_at: Date
}

/** How long a source may go on writing before what it wrote is stored. Every request would otherwise be a write. */
const STORE_EVERY = 60_000

const keyOf = (kind: WriteKind, target: string) => `${kind}\t${target}`
const split = (key: string): [WriteKind, string] => {
  const at = key.indexOf('\t')
  return [key.slice(0, at) as WriteKind, key.slice(at + 1)]
}

/**
 * What a hub answers with is what every hub has stored and what it has noted
 * itself since. What is stored trails a write by at most a minute per
 * source, and another hub reads it again as it is stored, so hubs that serve
 * side by side say the same of a source within that minute. `flush` stores
 * the rest when the hub stops.
 */
/** The setting that says the ledger was filled in from the change history. */
const FILLED = 'writes.filled'

export class Writes {
  private kept = new Map<string, Map<string, Mark>>()
  /** What is noted but not yet stored, by source. */
  private pending = new Map<string, Map<string, Mark>>()
  private readonly storedAt = new Map<string, number>()
  private readonly timers = new Map<string, NodeJS.Timeout>()

  private readonly db: Db
  private readonly log: Logger

  constructor(db: Db, log: Logger) {
    this.db = db
    this.log = log
  }

  /**
   * Reads the ledger. Once per hub, it first fills in what the change
   * history proves a source wrote before the ledger existed: the entities it
   * wrote, the blueprints it changed by offering them, and the actions and
   * scorecards it put. From then on every write is noted as it lands, so the history is
   * never read again; a ledger that already holds rows was filled by an
   * earlier start. A target the ledger holds is left as it is.
   */
  async load(): Promise<void> {
    if (!(await this.db.query(`SELECT 1 FROM settings WHERE key = '${FILLED}'`)).rowCount) {
      const held = (await this.db.query('SELECT 1 FROM source_writes LIMIT 1')).rowCount
      if (held) this.log.info('source write ledger not filled in from the change history', { reason: 'the ledger already holds writes' })
      else {
        const seeded = await this.db.query(
          `INSERT INTO source_writes (source, kind, target, count, last_at)
           SELECT c.source, w.kind, w.target, count(*), max(c.at)
           FROM changes c
           JOIN sources s ON s.id = c.source
           CROSS JOIN LATERAL (VALUES (
             CASE WHEN c.kind LIKE 'entity.%' THEN 'entity' WHEN c.kind = 'blueprint.changed' THEN 'blueprint' WHEN c.kind = 'action.changed' THEN 'action' WHEN c.kind = 'scorecard.changed' THEN 'scorecard' END,
             CASE WHEN c.kind = 'action.changed' THEN c.detail->>'action' WHEN c.kind = 'scorecard.changed' THEN c.detail->>'scorecard' ELSE c.blueprint END
           )) AS w(kind, target)
           WHERE c.outcome = 'ok' AND w.kind IS NOT NULL AND w.target IS NOT NULL
           GROUP BY c.source, w.kind, w.target
           ON CONFLICT (source, kind, target) DO NOTHING`,
        )
        this.log.info('source write ledger filled in from the change history', { rows: seeded.rowCount ?? 0 })
      }
      await this.db.query(`INSERT INTO settings (key, value) VALUES ('${FILLED}', 'true') ON CONFLICT (key) DO NOTHING`)
    }
    await this.read()
  }

  /** Reads what every hub has stored, and lays over it what this hub has noted and not yet stored. */
  async read(): Promise<void> {
    const rows = await this.db.query<Row>('SELECT * FROM source_writes')
    const kept = new Map<string, Map<string, Mark>>()
    for (const r of rows.rows) add(kept, r.source, keyOf(r.kind, r.target), Number(r.count), r.last_at)
    for (const [source, marks] of this.pending) for (const [key, mark] of marks) add(kept, source, key, mark.count, mark.lastAt)
    this.kept = kept
  }

  /** Notes accepted writes: each target with how many writes it took. */
  async note(source: string, kind: WriteKind, targets: Map<string, number>, at: Date = new Date()): Promise<void> {
    if (!targets.size) return
    for (const [target, n] of targets) {
      add(this.kept, source, keyOf(kind, target), n, at)
      add(this.pending, source, keyOf(kind, target), n, at)
    }
    const wait = STORE_EVERY - (Date.now() - (this.storedAt.get(source) ?? 0))
    if (wait <= 0) return this.store(source)
    if (this.timers.has(source)) return
    const timer = setTimeout(() => void this.store(source), wait)
    timer.unref()
    this.timers.set(source, timer)
  }

  of(source: string): SourceWrites {
    const out: SourceWrites = { entities: [], blueprints: [], actions: [], scorecards: [] }
    for (const [key, mark] of this.kept.get(source) ?? []) {
      const [kind, target] = split(key)
      const lastAt = mark.lastAt.toISOString()
      if (kind === 'entity') out.entities.push({ blueprint: target, count: mark.count, lastAt })
      else if (kind === 'blueprint') out.blueprints.push({ id: target, lastAt })
      else if (kind === 'scorecard') out.scorecards.push({ id: target, lastAt })
      else out.actions.push({ id: target, lastAt })
    }
    const byName = (a: string, b: string) => a.localeCompare(b)
    out.entities.sort((a, b) => byName(a.blueprint, b.blueprint))
    out.blueprints.sort((a, b) => byName(a.id, b.id))
    out.actions.sort((a, b) => byName(a.id, b.id))
    out.scorecards.sort((a, b) => byName(a.id, b.id))
    return out
  }

  /** A removed source's ledger goes with it. */
  async forget(source: string): Promise<void> {
    clearTimeout(this.timers.get(source))
    this.timers.delete(source)
    this.pending.delete(source)
    this.kept.delete(source)
    this.storedAt.delete(source)
    await this.db.query('DELETE FROM source_writes WHERE source = $1', [source])
  }

  /** Stores everything noted and not yet stored. */
  async flush(): Promise<void> {
    await Promise.all([...this.pending.keys()].map((source) => this.store(source)))
  }

  private async store(source: string): Promise<void> {
    clearTimeout(this.timers.get(source))
    this.timers.delete(source)
    this.storedAt.set(source, Date.now())
    const marks = this.pending.get(source)
    if (!marks?.size) return
    this.pending.delete(source)
    const rows = [...marks].map(([key, mark]) => ({ key: split(key), mark }))
    try {
      await this.db.query(
        `INSERT INTO source_writes (source, kind, target, count, last_at)
         SELECT $1, kind, target, count, last_at FROM unnest($2::text[], $3::text[], $4::bigint[], $5::timestamptz[]) AS w(kind, target, count, last_at)
         ON CONFLICT (source, kind, target) DO UPDATE SET count = source_writes.count + EXCLUDED.count, last_at = GREATEST(source_writes.last_at, EXCLUDED.last_at)`,
        [source, rows.map((r) => r.key[0]), rows.map((r) => r.key[1]), rows.map((r) => r.mark.count), rows.map((r) => r.mark.lastAt)],
      )
    } catch (error) {
      // Kept to be stored with the next write: what the hub answers with is still right.
      for (const { key, mark } of rows) add(this.pending, source, keyOf(...key), mark.count, mark.lastAt)
      this.log.warn('source write ledger not stored; kept for the next try', { source, error })
    }
  }
}

function add(into: Map<string, Map<string, Mark>>, source: string, key: string, count: number, at: Date): void {
  let marks = into.get(source)
  if (!marks) into.set(source, (marks = new Map()))
  const mark = marks.get(key)
  if (!mark) marks.set(key, { count, lastAt: at })
  else {
    mark.count += count
    if (at > mark.lastAt) mark.lastAt = at
  }
}

/** Counts each target once per time it is named. */
export function tally(targets: Iterable<string>): Map<string, number> {
  const out = new Map<string, number>()
  for (const t of targets) out.set(t, (out.get(t) ?? 0) + 1)
  return out
}
