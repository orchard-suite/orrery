// The load ledger: what costs the hub, by the hour. Deriving and grid shapes
// by blueprint, re-linking by relation, writes by source, and API calls by
// caller. A metric's labels
// are fixed sets, so these names never go out as metrics; they are kept in
// `load_hours`, which this module alone writes. Every hub on the database
// adds what it noted to the same rows, so the table is the whole hub's load,
// whichever process did the work.

import type { LoadDatabase, LoadStars, LoadDeriving, LoadGrids, LoadHour, LoadReading, LoadRelinking, LoadResponse, LoadRoute, LoadWriting } from '../shared/api.ts'
import type { Db } from './db.ts'
import type { Logger } from './log.ts'

/**
 * What is counted, and what each number means for it:
 * - `derive`, by blueprint: `rows` entities derived, `calls` those whose stored row changed, `extra` readers queued because of them.
 * - `shape`, by blueprint: `calls` grid shapes built, `rows` the rows they counted.
 * - `relink`, by relation (`relinkName`: the blueprint, the relation, and `rule` or `inherit`, tabs between): `calls` times
 *   a rule or an inherited relation was worked out, `rows` the entities it read to do so (those it links, and what their paths or matches reached), `extra` the links it added or dropped.
 * - `spread`, by blueprint: `calls` grid spreads counted, `extra` the columns they shared out. Its time is part of `shape`'s.
 * - `write`, by source: `calls` batches, `rows` entities received in full, `extra` entities that changed, `sighted` entities
 *   named by a sighting and taken as sent again, nothing of them read.
 * - `read`, by caller: `calls` API calls, `rows` bytes answered.
 * - `route`, by caller and route (`caller` and `METHOD /route`, a tab between): the same, for each route a caller called.
 * - `star`, by blueprint: `calls` grid reads put in their reader's stars order, `rows` the rows they marked starred,
 *   `ms` the time of the lookups that took (how many the reader starred there, and which of the page's rows).
 * - `db`, by the work that asked (a task's name, a request's `METHOD /route`, or `other`): `calls` statements sent,
 *   `rows` the rows they answered with or changed. Its time is the statements' own, sent side by side or not, so it is
 *   part of the other kinds' time and never added to it.
 * `ms` is the time spent, for every kind.
 */
export type LoadKind = 'derive' | 'shape' | 'spread' | 'relink' | 'write' | 'read' | 'route' | 'db' | 'star'

/** The name a `route` count is kept under. */
export const routeName = (caller: string, route: string): string => `${caller}\t${route}`

/** The name a `relink` count is kept under. */
export const relinkName = (blueprint: string, relation: string, by: LoadRelinking['by']): string => `${blueprint}\t${relation}\t${by}`

export interface LoadNote {
  calls?: number
  ms?: number
  rows?: number
  extra?: number
  sighted?: number
}

interface Sum {
  calls: number
  ms: number
  rows: number
  extra: number
  sighted: number
}

/** How long a hub may go on noting before what it noted is stored. Every request would otherwise be a write. */
const STORE_EVERY = 60_000
const HOUR_MS = 3_600_000
/** The longest window `read` answers for. */
export const LOAD_MAX_HOURS = 24 * 90
/** The caller a request is counted under when nobody signed in. */
export const ANONYMOUS = 'anonymous'

/** The kinds counted hour by hour, and where each goes in a `LoadHour`. */
const HOURLY = { derive: 'derive', shape: 'grids', relink: 'relink', write: 'write', read: 'read' } as const satisfies Partial<Record<LoadKind, keyof Omit<LoadHour, 'hour'>>>

/** A name is cut to this, so one caller cannot store an endless key. */
const NAME_MAX = 200

export class Load {
  /** What is noted but not yet stored, by hour, kind, and name. */
  private pending = new Map<string, Sum>()
  private timer: NodeJS.Timeout | null = null
  /** How many times this hub stored what it noted: what was pending before is in the table since. */
  flushes = 0

  private readonly db: Db
  private readonly log: Logger

  constructor(db: Db, log: Logger) {
    this.db = db
    this.log = log
  }

  /** Adds to what the hub has done this hour. A map update and nothing more: it never waits and never throws. */
  note(kind: LoadKind, name: string, add: LoadNote): void {
    const key = `${Math.floor(Date.now() / HOUR_MS)}\t${kind}\t${name.length > NAME_MAX ? name.slice(0, NAME_MAX) : name}`
    const sum = this.pending.get(key)
    if (sum) {
      sum.calls += add.calls ?? 0
      sum.ms += add.ms ?? 0
      sum.rows += add.rows ?? 0
      sum.extra += add.extra ?? 0
      sum.sighted += add.sighted ?? 0
    } else this.pending.set(key, { calls: add.calls ?? 0, ms: add.ms ?? 0, rows: add.rows ?? 0, extra: add.extra ?? 0, sighted: add.sighted ?? 0 })
    if (this.timer) return
    this.timer = setTimeout(() => void this.flush(), STORE_EVERY)
    this.timer.unref()
  }

  /** What this hub noted of the hour now running and has not stored yet. */
  noted(kind: LoadKind, name: string): Readonly<Sum> | undefined {
    return this.pending.get(`${Math.floor(Date.now() / HOUR_MS)}\t${kind}\t${name.length > NAME_MAX ? name.slice(0, NAME_MAX) : name}`)
  }

  /** The store under way, if any: a flush answers only once it and its own store are done. */
  private storing: Promise<void> = Promise.resolve()

  /**
   * Stores everything noted and not yet stored, added to what every hub
   * stored before. One store runs at a time, so a flush asked while the timer's
   * store is under way waits for it: once it answers, the table holds all
   * this hub had noted.
   */
  flush(): Promise<void> {
    const run = this.storing.then(() => this.store())
    this.storing = run
    return run
  }

  private async store(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (!this.pending.size) return
    const taken = this.pending
    this.pending = new Map()
    const rows = [...taken].map(([key, sum]) => {
      const [hour, kind, ...name] = key.split('\t')
      return { hour: new Date(Number(hour) * HOUR_MS), kind: kind!, name: name.join('\t'), sum }
    })
    try {
      await this.db.query(
        `INSERT INTO load_hours (hour, kind, name, calls, ms, rows, extra, sighted)
         SELECT * FROM unnest($1::timestamptz[], $2::text[], $3::text[], $4::bigint[], $5::float8[], $6::bigint[], $7::bigint[], $8::bigint[])
         ON CONFLICT (hour, kind, name) DO UPDATE SET calls = load_hours.calls + EXCLUDED.calls, ms = load_hours.ms + EXCLUDED.ms, rows = load_hours.rows + EXCLUDED.rows, extra = load_hours.extra + EXCLUDED.extra, sighted = load_hours.sighted + EXCLUDED.sighted`,
        [rows.map((r) => r.hour), rows.map((r) => r.kind), rows.map((r) => r.name), rows.map((r) => Math.round(r.sum.calls)), rows.map((r) => r.sum.ms), rows.map((r) => Math.round(r.sum.rows)), rows.map((r) => Math.round(r.sum.extra)), rows.map((r) => Math.round(r.sum.sighted))],
      )
      this.flushes++
    } catch (error) {
      // Kept to be stored with the next try: the counts are added back to whatever was noted meanwhile.
      for (const [key, sum] of taken) {
        const now = this.pending.get(key)
        if (!now) this.pending.set(key, sum)
        else {
          now.calls += sum.calls
          now.ms += sum.ms
          now.rows += sum.rows
          now.extra += sum.extra
          now.sighted += sum.sighted
        }
      }
      this.log.warn('load ledger not stored; kept for the next try', { rows: rows.length, error })
    }
  }

  /** Lets go of the hours older than `days`. */
  async prune(days: number): Promise<void> {
    const gone = await this.db.query(`DELETE FROM load_hours WHERE hour < now() - make_interval(secs => $1)`, [days * 86_400])
    if (gone.rowCount) this.log.info('load ledger pruned', { rows: gone.rowCount, days })
  }

  /**
   * The load of the last `hours`, each kind summed by name with the most
   * time first, beside what the database holds now: the entities of each
   * blueprint, how many entities one of its rows reads, and the derive queue.
   * What this hub noted is stored first; another hub's last minute may still
   * be on its way.
   */
  async read(hours: number): Promise<Omit<LoadResponse, 'budgets' | 'use' | 'columns' | 'stars'> & { sinceAt: Date; stars: StarReads[] }> {
    await this.flush()
    const window = Math.max(1, Math.min(Math.floor(hours) || 1, LOAD_MAX_HOURS))
    // Whole hours are kept, so the window opens on the hour: it holds the hour now running and `window` before it.
    const since = new Date((Math.floor(Date.now() / HOUR_MS) - window) * HOUR_MS)
    const [sums, byHour, counts, reads, queue] = await Promise.all([
      this.db.query<{ kind: LoadKind; name: string; calls: string; ms: number; rows: string; extra: string; sighted: string }>(
        'SELECT kind, name, sum(calls)::text AS calls, sum(ms)::float8 AS ms, sum(rows)::text AS rows, sum(extra)::text AS extra, sum(sighted)::text AS sighted FROM load_hours WHERE hour >= $1 GROUP BY kind, name ORDER BY sum(ms) DESC, name',
        [since],
      ),
      this.db.query<{ hour: Date; kind: keyof typeof HOURLY; ms: number }>(`SELECT hour, kind, sum(ms)::float8 AS ms FROM load_hours WHERE hour >= $1 AND kind IN ('derive', 'shape', 'relink', 'write', 'read') GROUP BY hour, kind`, [since]),
      this.db.query<{ blueprint: string; n: string }>(`SELECT blueprint, count(*)::text AS n FROM entities WHERE state IN ('active', 'missing') GROUP BY blueprint`),
      this.db.query<{ blueprint: string; reads: number }>('SELECT blueprint, avg(cardinality(reads))::float8 AS reads FROM derived GROUP BY blueprint'),
      this.db.query<{ depth: string; oldest: number | null }>('SELECT count(*)::text AS depth, extract(epoch FROM now() - min(queued_at))::float8 AS oldest FROM derive_queue'),
    ])
    const deriving: LoadDeriving[] = []
    const grids: LoadGrids[] = []
    const relinking: LoadRelinking[] = []
    const writing: LoadWriting[] = []
    const reading: LoadReading[] = []
    const routes: LoadRoute[] = []
    const database: LoadDatabase[] = []
    const stars: StarReads[] = []
    const spreads = new Map<string, { ms: number; columns: number }>()
    for (const r of sums.rows) {
      const ms = Math.round(r.ms)
      if (r.kind === 'derive') deriving.push({ blueprint: r.name, derived: Number(r.rows), changed: Number(r.calls), cascaded: Number(r.extra), ms })
      else if (r.kind === 'shape') grids.push({ blueprint: r.name, builds: Number(r.calls), rows: Number(r.rows), ms, spreadMs: 0, spreadColumns: 0 })
      else if (r.kind === 'relink') {
        const [blueprint = '', relation = '', by] = r.name.split('\t')
        relinking.push({ blueprint, relation, by: by === 'rule' ? 'rule' : 'inherit', passes: Number(r.calls), read: Number(r.rows), changed: Number(r.extra), ms })
      }
      else if (r.kind === 'spread') spreads.set(r.name, { ms, columns: Number(r.extra) })
      else if (r.kind === 'write') writing.push({ source: r.name, batches: Number(r.calls), received: Number(r.rows), changed: Number(r.extra), sighted: Number(r.sighted), ms })
      else if (r.kind === 'read') reading.push({ caller: r.name, calls: Number(r.calls), bytes: Number(r.rows), ms })
      else if (r.kind === 'route') {
        const tab = r.name.lastIndexOf('\t')
        routes.push({ caller: r.name.slice(0, tab), route: r.name.slice(tab + 1), calls: Number(r.calls), bytes: Number(r.rows), ms })
      } else if (r.kind === 'db') database.push({ work: r.name, statements: Number(r.calls), rows: Number(r.rows), ms })
      else if (r.kind === 'star') stars.push({ blueprint: r.name, reads: Number(r.calls), marked: Number(r.rows), ms })
    }
    for (const g of grids) {
      const spread = spreads.get(g.blueprint)
      if (spread) Object.assign(g, { spreadMs: Math.min(spread.ms, g.ms), spreadColumns: spread.columns })
    }
    const hourly: LoadHour[] = []
    const at = new Map<number, LoadHour>()
    for (let h = since.getTime(); h <= Date.now(); h += HOUR_MS) {
      const hour: LoadHour = { hour: new Date(h).toISOString(), derive: 0, grids: 0, relink: 0, write: 0, read: 0 }
      hourly.push(hour)
      at.set(h, hour)
    }
    for (const r of byHour.rows) {
      const hour = at.get(r.hour.getTime())
      if (hour) hour[HOURLY[r.kind]] = Math.round(r.ms)
    }
    const readsOf = new Map(reads.rows.map((r) => [r.blueprint, r.reads]))
    return {
      hours: window,
      sinceAt: since,
      since: since.toISOString(),
      queue: { depth: Number(queue.rows[0]?.depth ?? 0), oldestSeconds: queue.rows[0]?.oldest === null || queue.rows[0]?.oldest === undefined ? null : Math.max(0, Math.round(queue.rows[0].oldest)) },
      blueprints: counts.rows.map((r) => ({ id: r.blueprint, entities: Number(r.n), reads: Math.round((readsOf.get(r.blueprint) ?? 0) * 10) / 10 })).sort((a, b) => b.entities - a.entities || a.id.localeCompare(b.id)),
      deriving,
      grids,
      relinking,
      writing,
      reading,
      routes,
      database,
      stars,
      hourly,
    }
  }
}

/** What the ledger counted of stars over a window, by blueprint. */
export type StarReads = Pick<LoadStars, 'blueprint' | 'reads' | 'marked' | 'ms'>

/**
 * Every blueprint that holds stars now or had a grid ordered by them in the
 * window, with both: what they cost, the most time first, then the most held.
 */
export function starsLoad(reads: readonly StarReads[], kept: ReadonlyMap<string, { stars: number; people: number }>): LoadStars[] {
  const by = new Map<string, LoadStars>()
  for (const r of reads) by.set(r.blueprint, { ...r, stars: 0, people: 0 })
  for (const [blueprint, k] of kept) by.set(blueprint, { ...(by.get(blueprint) ?? { blueprint, reads: 0, marked: 0, ms: 0 }), stars: k.stars, people: k.people })
  return [...by.values()].sort((a, b) => b.ms - a.ms || b.stars - a.stars || a.blueprint.localeCompare(b.blueprint))
}

/** A ledger that keeps nothing: what a part of the hub has until the hub wires the ledger to it. */
export const NO_LOAD: Pick<Load, 'note'> = { note: () => undefined }
