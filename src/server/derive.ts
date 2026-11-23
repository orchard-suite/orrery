// Derived state kept in Postgres: every entity's derived fields, status,
// scorecard levels, and resolved relations, worked out when their inputs
// change and stored in `derived`, so a read is a lookup and a new hub has
// nothing to warm. Writers queue what they touched in `derive_queue`, in the
// transaction of the write; the leader drains the queue, derives, stores, and
// queues whatever read the parts of a row that changed. The compute itself is
// the reader's `derivation`; this file owns when it runs and what is kept of it.

import { createHash } from 'node:crypto'
import { ICON_NAMES, isPhoto } from '../shared/icons.ts'
import { searchTexts, stable } from '../shared/filter.ts'
import { entityId, SOURCE_STANDING, type Blueprint, type Entity, type EntityRef, type RelatedRef, type StatusLevel } from '../shared/model.ts'
import type { Blueprints } from './blueprints.ts'
import type pg from 'pg'
import type { Db } from './db.ts'
import type { EntityHead, EntityRow } from './entities.ts'
import type { Events } from './events.ts'
import type { Load } from './load.ts'
import type { Logger } from './log.ts'
import { timed } from './metrics.ts'
import { PART, type Reader } from './read.ts'
import type { Rules } from './rules.ts'
import type { Sources } from './sources.ts'
import { rollupSources } from './visibility.ts'
import { tally } from './writes.ts'

/** One stored reason: its text, and the blueprint a rollup took it from, null for the entity's own. */
export interface StoredReason {
  text: string
  from: string | null
}

/** The derived columns of one entity, as `derived` holds them. */
export interface DerivedRow {
  fields: Record<string, unknown>
  relations: Record<string, RelatedRef[]>
  icon: string | null
  level: StatusLevel
  reasons: StoredReason[]
  levels: Record<string, string[]> | null
  derived_at: string | Date
  /** When a value of the row next changes because time passes; null when none reads the time. */
  expires_at: string | Date | null
}

/** Per entity id, the ids whose change moves it. */
export type Reads = Map<string, Set<string>>

/** Where a statement runs: the pool, or a transaction's client. */
export type Runner = { query<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params?: unknown[]): Promise<pg.QueryResult<T>> }

/** What a writer tells the deriver, on its own transaction: what it touched, what it removed, and what to derive now. */
export interface Queue {
  enqueue(client: Runner, refs: Iterable<EntityRef>): Promise<void>
  enqueueBlueprints(client: Runner, blueprints: Iterable<string>): Promise<void>
  enqueueReaders(client: Runner, refs: Iterable<EntityRef>, before?: Date): Promise<number>
  forget(client: Runner, refs: EntityRef[]): Promise<void>
  /** Derives `refs` now when few, then what reads them; `titled` names the ones whose title or state moved, whose readers follow in any case. */
  inline(refs: EntityRef[], titled?: EntityRef[]): Promise<void>
}

/** A queue that keeps nothing: what a part of the hub has until the hub wires the deriver to it. */
export const NO_QUEUE: Queue = {
  enqueue: async () => undefined,
  enqueueBlueprints: async () => undefined,
  enqueueReaders: async () => 0,
  forget: async () => undefined,
  inline: async () => undefined,
}

const KNOWN_ICONS: ReadonlySet<string> = new Set(ICON_NAMES)

/** The picture an entity shows: its own icon when it is one of the set, a custom icon, or a person's photo, else its blueprint's. */
export function iconOf(stored: string | null, bp: Blueprint | undefined, icons: { has(name: string): boolean }): string | null {
  return stored !== null && (KNOWN_ICONS.has(stored) || icons.has(stored) || isPhoto(stored)) ? stored : (bp?.icon ?? null)
}

/** What draws an entity: the custom icons the hub holds, and what lays a person's picture over a person entity (`pictures.ts`). */
export interface Looks {
  has(name: string): boolean
  lay?(e: Entity): void
}

/** An entity from its row and its stored derived row, no computation. */
export function hydrate(row: EntityHead, d: DerivedRow, bp: Blueprint | undefined, icons: Looks, seen: Date | null): Entity {
  const entity: Entity = {
    id: `${row.blueprint}:${row.key}`,
    blueprint: row.blueprint,
    key: row.key,
    title: row.title,
    icon: iconOf(d.icon, bp, icons),
    state: row.state,
    hidden: row.hidden,
    fields: d.fields,
    relations: d.relations,
    owner: row.owner,
    scope: row.scope,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    lastSeenAt: seen?.toISOString() ?? null,
    missingSince: row.missing_since?.toISOString() ?? null,
    deletedAt: row.deleted_at?.toISOString() ?? null,
    status: { level: d.level, reasons: d.reasons.map((r) => r.text) },
    ...(d.levels ? { levels: d.levels } : {}),
  }
  const from = d.reasons.filter((r) => r.from !== null)
  if (from.length) rollupSources.set(entity, new Map(from.map((r) => [r.text, r.from!])))
  // A picture that came or went since the row was derived shows at once.
  icons.lay?.(entity)
  return entity
}

/** Everything search may match on an entity, lowercased, for the trigram pre-filter: a superset of what any reader may see. */
function searchAll(e: Entity): string {
  return [e.key, e.title, ...Object.values(e.fields).flatMap(searchTexts)].join('\n').toLowerCase()
}

/** What a stored row is compared on: the whole of what a reader can see of it, and who points at the entity where a path asks. */
type Kept = Pick<DerivedRow, 'fields' | 'relations' | 'icon' | 'level' | 'reasons' | 'levels'> & { pointed: string | null }

/** The parts of a stored row that read differently now, as `PART` names them. */
function partsMoved(was: Kept, now: Kept): Set<string> {
  const out = new Set<string>()
  for (const name of new Set([...Object.keys(was.fields), ...Object.keys(now.fields)])) if (stable(was.fields[name] ?? null) !== stable(now.fields[name] ?? null)) out.add(PART.field(name))
  if (stable(was.relations) !== stable(now.relations)) out.add(PART.relations)
  if (was.icon !== now.icon) out.add(PART.icon)
  if (was.level !== now.level || stable(was.reasons) !== stable(now.reasons)) out.add(PART.status)
  if (stable(was.levels) !== stable(now.levels)) out.add(PART.levels)
  if (was.pointed !== now.pointed) out.add(PART.pointed)
  return out
}

/** An entity whose stored row changed, with the parts that moved; null when the row is gone, which moves every reader. */
export type Changed = EntityRef & { moved: ReadonlySet<string> | null }

/** Whether a change shows: one only to who points at the entity is in nothing a view reads. */
const shows = (c: Changed): boolean => c.moved === null || [...c.moved].some((part) => part !== PART.pointed)

/**
 * How rows are derived, counted up when a release derives them another way.
 * A row an earlier way derived is queued as a hub takes the lead and derived again in the background; the backstop catches any left.
 * 2: `reads` names what a path steps through, and `pointed` is kept.
 * 3: `fingerprint` is kept, and a row is told the same by it alone.
 * 4: a path reaches only active entities.
 */
const WAY = 4

/** What joins a row's `reads` into one text to hash: a character no id holds. */
const READS_SEP = '\u0001'

const md5 = (text: string): string => createHash('md5').update(text, 'utf8').digest('hex')

/** Everything a stored row holds, and the way it was derived, as one fingerprint: the same fingerprint is the same row. */
function fingerprintOf(stored: Kept, search: string, reads: string[], expiresAt: Date | null): string {
  return md5([stable(stored), search, reads.join(READS_SEP), expiresAt?.getTime() ?? '', WAY].join(PRINT_SEP))
}
/** What parts a fingerprint: a character no part holds. */
const PRINT_SEP = '\u0002'

/**
 * Queues the entities a select names (`blueprint`, `key`), on the caller's
 * transaction, and returns how many rows it added. One a hub has taken is
 * no longer waiting, so it is queued anew beside the taken row: the hub that
 * took it read what was there before, and the entity is derived again from
 * what is there now. `derive_queue` holds one waiting row an entity, and any
 * number taken.
 *
 * One that waits already is held with a shared lock until the caller
 * commits: a hub's take passes over a held row, so it never derives the
 * entity from before this transaction's change and then removes the only
 * row that says it changed. The lock is shared, so writers that touch the
 * same entity never wait on each other for it. A waiting row a hub takes
 * between the insert and the hold is no longer waiting, and is queued anew.
 *
 * New rows go in in key order: two transactions that queue some of the same
 * new entities then wait for each other in turn, where in any other order
 * each could hold what the other needs, which Postgres ends by failing one
 * of them.
 */
async function queueing(client: Runner, select: string, params: unknown[]): Promise<number> {
  const first = await client.query<{ added: number; blueprints: string[]; keys: string[] }>(
    `WITH w AS MATERIALIZED (${select}),
     added AS (INSERT INTO derive_queue (blueprint, key) SELECT w.blueprint, w.key FROM w ORDER BY w.blueprint, w.key ON CONFLICT DO NOTHING RETURNING blueprint, key),
     waiting AS (SELECT DISTINCT w.blueprint, w.key FROM w WHERE NOT EXISTS (SELECT 1 FROM added a WHERE a.blueprint = w.blueprint AND a.key = w.key))
     SELECT (SELECT count(*) FROM added)::int AS added,
            ARRAY(SELECT blueprint FROM waiting ORDER BY blueprint, key) AS blueprints,
            ARRAY(SELECT key FROM waiting ORDER BY blueprint, key) AS keys`,
    params,
  )
  const row = first.rows[0]!
  let added = row.added
  let left = row.blueprints.map((blueprint, i) => ({ blueprint, key: row.keys[i]! }))
  while (left.length) {
    const held = await client.query<{ blueprint: string; key: string }>(
      `SELECT blueprint, key FROM derive_queue WHERE (blueprint, key) IN (SELECT * FROM unnest($1::text[], $2::text[])) AND taken_until IS NULL ORDER BY blueprint, key FOR SHARE`,
      [left.map((r) => r.blueprint), left.map((r) => r.key)],
    )
    const kept = new Set(held.rows.map(entityId))
    left = left.filter((r) => !kept.has(entityId(r)))
    if (!left.length) break
    const again = await client.query<{ blueprint: string; key: string }>(
      `INSERT INTO derive_queue (blueprint, key) SELECT * FROM unnest($1::text[], $2::text[]) AS u(blueprint, key) ORDER BY 1, 2 ON CONFLICT DO NOTHING RETURNING blueprint, key`,
      [left.map((r) => r.blueprint), left.map((r) => r.key)],
    )
    added += again.rows.length
    const queued = new Set(again.rows.map(entityId))
    left = left.filter((r) => !queued.has(entityId(r)))
  }
  return added
}

/** How long a hub holds the entities it took from the queue. One that stops mid-pass leaves them to be taken again after this. */
const TAKEN_SECONDS = 120

/** The readers of changed entities, each with the blueprints to take them from, null for every one: `$1` ids, `$2` blueprints as an array literal, `$3` the moment the change was read. */
const READERS = `FROM unnest($1::text[], $2::text[]) AS c(id, readers) JOIN derived d ON d.reads @> ARRAY[c.id] WHERE d.derived_at < $3 AND (c.readers IS NULL OR d.blueprint = ANY(c.readers::text[]))`

/** How many rounds of readers an inline derivation follows before leaving the rest to the leader. */
const INLINE_ROUNDS = 4

export interface DeriverConfig {
  batch: number
  budgetMs: number
  inlineMax: number
}

interface Deps {
  db: Db
  reader: Reader
  blueprints: Blueprints
  sources: Sources
  rules: Rules
  events: Events
  load: Pick<Load, 'note'>
  log: Logger
}

export class Deriver implements Queue {
  private readonly db: Db
  private readonly reader: Reader
  private readonly blueprints: Blueprints
  private readonly sources: Sources
  private readonly rules: Rules
  private readonly events: Events
  private readonly load: Pick<Load, 'note'>
  private readonly log: Logger
  private readonly config: DeriverConfig
  /** Each source's standing the last time its entities were derived for it. */
  private readonly standings = new Map<string, string>()
  /** Each source's own status and reason the last time its own entities, the source and its runner, were derived. */
  private readonly own = new Map<string, string>()
  /** One drain at a time; a tick that lands while one runs joins it. */
  private draining: Promise<number> | null = null
  /** The rows an earlier way derived that this hub queued as it took the lead, while some are left; `checked` is when it last looked. */
  private upgrading: { queued: number; started: number; checked: number } | null = null

  constructor(deps: Deps, config: DeriverConfig) {
    this.db = deps.db
    this.reader = deps.reader
    this.blueprints = deps.blueprints
    this.sources = deps.sources
    this.rules = deps.rules
    this.events = deps.events
    this.load = deps.load
    this.log = deps.log
    this.config = config
  }

  /** Queues entities to be derived, on the caller's transaction where it has one, so a committed write and its queue rows are one fact. */
  async enqueue(client: Runner, refs: Iterable<EntityRef>): Promise<void> {
    const list = [...new Map([...refs].map((r) => [entityId(r), r])).values()]
    if (!list.length) return
    await queueing(client, 'SELECT * FROM unnest($1::text[], $2::text[]) AS u(blueprint, key)', [list.map((r) => r.blueprint), list.map((r) => r.key)])
  }

  /** Queues every entity of these blueprints. */
  async enqueueBlueprints(client: Runner, blueprints: Iterable<string>): Promise<void> {
    const list = [...new Set(blueprints)]
    if (!list.length) return
    await queueing(client, `SELECT blueprint, key FROM entities WHERE blueprint = ANY($1) AND state <> 'deleted'`, [list])
  }

  /**
   * Queues everything that reads any of these entities: their title, their
   * values, their status. With `before`, only readers derived before that
   * moment: one derived since read the inputs as they now are.
   */
  async enqueueReaders(client: Runner, refs: Iterable<EntityRef>, before?: Date): Promise<number> {
    const ids = [...new Set([...refs].map(entityId))]
    if (!ids.length) return 0
    // One index lookup per id: `reads @> ARRAY[id]` walks the GIN index, where an overlap with a long array would scan the table.
    return queueing(client, `SELECT DISTINCT d.blueprint, d.key FROM unnest($1::text[]) AS c(id) JOIN derived d ON d.reads @> ARRAY[c.id] ${before ? 'WHERE d.derived_at < $2' : ''}`, before ? [ids, before] : [ids])
  }

  /** Forgets the derived rows of entities that are deleted or gone, and queues what read them. */
  async forget(client: Runner, refs: EntityRef[]): Promise<void> {
    if (!refs.length) return
    await client.query('DELETE FROM derived WHERE (blueprint, key) IN (SELECT * FROM unnest($1::text[], $2::text[]))', [refs.map((r) => r.blueprint), refs.map((r) => r.key)])
    await client.query('DELETE FROM derive_queue WHERE (blueprint, key) IN (SELECT * FROM unnest($1::text[], $2::text[]))', [refs.map((r) => r.blueprint), refs.map((r) => r.key)])
    await this.enqueueReaders(client, refs)
  }

  /**
   * A small write is derived on the request before it answers, and so is
   * what read it, round by round while each round stays small, so a hand
   * edit shows in every grid at once, on the row and on what rolls it up.
   * The queue rows stay: the leader derives them again from the latest
   * inputs, and `derived_at` keeps the older of the two from winning. Each
   * round's readers are queued before they are derived: the leader finds
   * the rows this request stored already as they should be, so it cascades
   * nothing from them, and a round cut short (too large, past the last
   * round, or failed) would otherwise leave its readers behind for good.
   */
  async inline(refs: EntityRef[], titled: EntityRef[] = []): Promise<void> {
    if (!refs.length || refs.length > this.config.inlineMax) return
    try {
      await timed('derive.inline', async () => {
        const done = new Set<string>()
        let round = refs
        // What a retitled or new entity's readers show of it is not in its own derived row, so every one follows whether or not the row changed.
        let moved: Changed[] = titled.map((r) => ({ blueprint: r.blueprint, key: r.key, moved: null }))
        for (let i = 0; i < INLINE_ROUNDS && round.length && round.length <= this.config.inlineMax; i++) {
          for (const r of round) done.add(entityId(r))
          const { changed, started } = await this.derive(round, { consume: false })
          const whole = new Set(moved.map(entityId))
          moved = [...moved, ...changed.filter((c) => !whole.has(entityId(c)))]
          const asked = this.asked(moved)
          if (!asked.ids.length) break
          const readers = await this.db.query<{ blueprint: string; key: string }>(`SELECT DISTINCT d.blueprint, d.key ${READERS}`, [asked.ids, asked.readers, started])
          round = readers.rows.filter((r) => !done.has(entityId(r)))
          await this.enqueue(this.db, round)
          // One statement finds the readers of everything that moved, so they are shared out by how many rows of each blueprint moved.
          const by = tally(moved.map((c) => c.blueprint))
          for (const [blueprint, n] of by) this.load.note('derive', blueprint, { extra: (round.length * n) / moved.length })
          moved = []
        }
      })
    } catch (error) {
      this.log.warn('inline derivation failed; the leader derives it', { error, entities: refs.length })
    }
  }

  /** Lets go of the queue rows taken for `refs`, so the next pass, here or on another hub, takes them at once and not when the hold runs out. */
  private async release(refs: EntityRef[]): Promise<void> {
    await this.db.query('UPDATE derive_queue SET taken_until = NULL WHERE (blueprint, key) IN (SELECT * FROM unnest($1::text[], $2::text[])) AND taken_until IS NOT NULL', [refs.map((r) => r.blueprint), refs.map((r) => r.key)]).catch(() => undefined)
  }

  /**
   * What to ask the stored rows' `reads` for: each changed entity with the
   * blueprints that read a part of it that moved. One no blueprint reads
   * that way is left out, and costs no lookup.
   */
  private asked(changed: Changed[]): { ids: string[]; readers: (string | null)[] } {
    const ids: string[] = []
    const readers: (string | null)[] = []
    for (const c of changed) {
      const from = c.moved === null ? null : this.reader.readersOf(c.blueprint, c.moved)
      if (from && !from.length) continue
      ids.push(entityId(c))
      readers.push(from ? `{${from.join(',')}}` : null)
    }
    return { ids, readers }
  }

  /** Queues what reads a part of these entities' stored rows that moved, of the readers derived before `before`. */
  private async cascade(client: Runner, changed: Changed[], before: Date): Promise<number> {
    const asked = this.asked(changed)
    if (!asked.ids.length) return 0
    return queueing(client, `SELECT DISTINCT d.blueprint, d.key ${READERS}`, [asked.ids, asked.readers, before])
  }

  /**
   * Derives these entities from the current state and stores them. Returns
   * the ones whose stored row changed, each with the parts that moved. With
   * `consume`, the queue rows taken for them are removed in the same
   * transaction as the upsert, so a crash between loses nothing.
   */
  async derive(refs: EntityRef[], opts: { consume: boolean }): Promise<{ changed: Changed[]; started: Date }> {
    if (!refs.length) return { changed: [], started: new Date() }
    const began = performance.now()
    const { weight, ...out } = await this.deriveNow(refs, opts)
    // A batch is timed whole, and its time shared out by what each blueprint's rows read: a row reads its neighbours and
    // the ends of its paths, which is most of what deriving it costs, so a plain row is not charged for a rollup beside it.
    const ms = performance.now() - began
    let total = 0
    for (const w of weight.values()) total += w
    for (const [blueprint, n] of tally(refs.map((r) => r.blueprint))) this.load.note('derive', blueprint, { rows: n, ms: total ? (ms * (weight.get(blueprint) ?? 0)) / total : 0 })
    for (const [blueprint, n] of tally(out.changed.map((r) => r.blueprint))) this.load.note('derive', blueprint, { calls: n })
    return out
  }

  private async deriveNow(refs: EntityRef[], opts: { consume: boolean }): Promise<{ changed: Changed[]; started: Date; weight: Map<string, number> }> {
    // The moment the inputs are read from, on the hub's clock, the one `blueprints.updatedAt` is on too.
    const started = new Date()
    const rows = await this.reader.rowsFor(refs)
    const alive = new Set(rows.map(entityId))
    // A ref with no live row: deleted since it was queued, or never there. Its queue row goes, and so does its derived row.
    const gone = refs.filter((r) => !alive.has(entityId(r)))
    const { entities, reads, expires, pointed } = await this.reader.derivation(rows)
    // What each blueprint's rows cost to derive, as what they read: one for the row, and one for each entity it read.
    const weight = new Map<string, number>()
    for (const e of entities) weight.set(e.blueprint, (weight.get(e.blueprint) ?? 0) + 1 + (reads.get(e.id)?.size ?? 0))
    for (const r of gone) weight.set(r.blueprint, (weight.get(r.blueprint) ?? 0) + 1)
    return this.db.tx(async (client) => {
      // What each row holds now is told from what it held by one fingerprint, read narrow: a row derived the same moves
      // only its time, and only a row that reads differently is read whole, to say which of its parts moved.
      // A row an earlier way derived keeps no fingerprint it can be told by, and is compared whole.
      const prior = await client.query<{ blueprint: string; key: string; fingerprint: string | null }>(
        'SELECT blueprint, key, CASE WHEN way = $3 THEN fingerprint END AS fingerprint FROM derived WHERE (blueprint, key) IN (SELECT * FROM unnest($1::text[], $2::text[]))',
        [rows.map((r) => r.blueprint), rows.map((r) => r.key), WAY],
      )
      const printed = new Map(prior.rows.map((p) => [`${p.blueprint}:${p.key}`, p.fingerprint]))
      const derived = entities.map((e) => {
        const from = rollupSources.get(e)
        const stored: Kept = {
          fields: e.fields,
          relations: e.relations,
          icon: rawIcons.get(e) ?? null,
          level: e.status.level,
          reasons: e.status.reasons.map((text) => ({ text, from: from?.get(text) ?? null })),
          levels: e.levels ?? null,
          pointed: pointed.get(e.id) ?? null,
        }
        const next = expires.get(e.id)
        const expiresAt = next === undefined ? null : new Date(next)
        const search = searchAll(e)
        const readList = [...(reads.get(e.id) ?? [])]
        return { e, stored, search, readList, expiresAt, print: fingerprintOf(stored, search, readList, expiresAt) }
      })
      const other = derived.filter((d) => printed.get(d.e.id) !== d.print)
      // A row that is new moves nothing: whoever read this entity before computed it from the same rows. Only a stored
      // row that now reads differently sends readers back to the queue, and only those that read a part that moved.
      const before = new Map<string, Kept>()
      const was = other.filter((d) => printed.has(d.e.id))
      if (was.length) {
        const kept = await client.query<Kept & { blueprint: string; key: string }>(
          'SELECT blueprint, key, fields, relations, icon, level, reasons, levels, pointed FROM derived WHERE (blueprint, key) IN (SELECT * FROM unnest($1::text[], $2::text[]))',
          [was.map((d) => d.e.blueprint), was.map((d) => d.e.key)],
        )
        for (const k of kept.rows) before.set(`${k.blueprint}:${k.key}`, k)
      }
      const changed: Changed[] = []
      for (const d of other) {
        const prev = before.get(d.e.id)
        const moved = prev ? partsMoved(prev, d.stored) : null
        if (moved?.size) changed.push({ blueprint: d.e.blueprint, key: d.e.key, moved })
      }
      if (derived.length) {
        const cols = { blueprint: [] as string[], key: [] as string[], fields: [] as string[], relations: [] as string[], icon: [] as (string | null)[], level: [] as string[], reasons: [] as string[], levels: [] as (string | null)[], search: [] as string[], reads: [] as string[], expires: [] as (Date | null)[], pointed: [] as (string | null)[], print: [] as string[] }
        for (const { e, stored, search, readList, expiresAt, print } of derived) {
          cols.blueprint.push(e.blueprint)
          cols.key.push(e.key)
          cols.fields.push(JSON.stringify(stored.fields))
          cols.relations.push(JSON.stringify(stored.relations))
          cols.icon.push(stored.icon)
          cols.level.push(stored.level)
          cols.reasons.push(JSON.stringify(stored.reasons))
          cols.levels.push(stored.levels ? JSON.stringify(stored.levels) : null)
          cols.search.push(search)
          cols.reads.push(JSON.stringify(readList))
          cols.expires.push(expiresAt)
          cols.pointed.push(stored.pointed)
          cols.print.push(print)
        }
        // A derivation from older inputs never overwrites one from newer inputs: the start of its read decides. Every row
        // goes in one statement, in key order, so two derivations that share rows take their locks in the same order and
        // wait instead of deadlocking. A row whose fingerprint stands keeps every value it holds and has only its time
        // moved, in place, so no index is written for it; it is written in full only if it went meanwhile.
        const SAME = 'derived.way = EXCLUDED.way AND derived.fingerprint = EXCLUDED.fingerprint'
        const kept = ['fields', 'relations', 'icon', 'level', 'reasons', 'levels', 'search_all', 'reads', 'expires_at', 'pointed', 'way'].map((c) => `${c} = CASE WHEN ${SAME} THEN derived.${c} ELSE EXCLUDED.${c} END`)
        await client.query(
          `INSERT INTO derived (blueprint, key, fields, relations, icon, level, reasons, levels, search_all, reads, derived_at, expires_at, pointed, way, fingerprint)
           SELECT v.blueprint, v.key, v.fields::jsonb, v.relations::jsonb, v.icon, v.level, v.reasons::jsonb, v.levels::jsonb, v.search_all, ARRAY(SELECT jsonb_array_elements_text(v.reads::jsonb)), $11, v.expires_at, v.pointed, $14, v.fingerprint
           FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::text[], $12::timestamptz[], $13::text[], $15::text[]) AS v(blueprint, key, fields, relations, icon, level, reasons, levels, search_all, reads, expires_at, pointed, fingerprint)
           ORDER BY v.blueprint, v.key
           ON CONFLICT (blueprint, key) DO UPDATE SET ${kept.join(', ')}, fingerprint = EXCLUDED.fingerprint, derived_at = EXCLUDED.derived_at
           WHERE derived.derived_at < EXCLUDED.derived_at`,
          [cols.blueprint, cols.key, cols.fields, cols.relations, cols.icon, cols.level, cols.reasons, cols.levels, cols.search, cols.reads, started, cols.expires, cols.pointed, WAY, cols.print],
        )
      }
      if (gone.length) {
        await client.query('DELETE FROM derived WHERE (blueprint, key) IN (SELECT * FROM unnest($1::text[], $2::text[]))', [gone.map((r) => r.blueprint), gone.map((r) => r.key)])
        changed.push(...gone.map((r) => ({ blueprint: r.blueprint, key: r.key, moved: null })))
      }
      // Only the taken rows go: an entity queued again while it was being derived has a waiting row too, which stays.
      if (opts.consume) await client.query('DELETE FROM derive_queue WHERE (blueprint, key) IN (SELECT * FROM unnest($1::text[], $2::text[])) AND taken_until IS NOT NULL', [refs.map((r) => r.blueprint), refs.map((r) => r.key)])
      return { changed, started, weight }
    })
  }

  /**
   * Before a blueprint is listed from its stored rows: derives now what has
   * no row, or a row older than `staleBefore`, while those are few enough
   * for a request. More than that is left to the leader, and the list shows
   * the rows as they stand until it lands.
   */
  async ensure(blueprint: string, staleBefore: Date | null, keys?: readonly string[]): Promise<void> {
    // Asked about some entities, only theirs are looked at: a page of a grid, not the whole blueprint.
    const values: unknown[] = [blueprint, this.config.inlineMax + 1]
    const stale = staleBefore ? ` OR d.derived_at < $${values.push(staleBefore)}` : ''
    const only = keys ? ` AND e.key = ANY($${values.push(keys)}::text[])` : ''
    const cold = await this.db.query<{ blueprint: string; key: string }>(
      `SELECT e.blueprint, e.key FROM entities e LEFT JOIN derived d ON d.blueprint = e.blueprint AND d.key = e.key
       WHERE e.blueprint = $1${only} AND e.state <> 'deleted' AND (d.blueprint IS NULL${stale}) LIMIT $2`,
      values,
    )
    if (!cold.rows.length) return
    if (cold.rows.length > this.config.inlineMax) {
      // Too many for a request: queued for the leader, and the list shows what is stored meanwhile.
      await this.enqueue(this.db, cold.rows)
      return
    }
    await this.inline(cold.rows)
  }

  /** How many entities wait to be derived. */
  async depth(): Promise<number> {
    return Number((await this.db.query<{ n: string }>('SELECT count(*)::text AS n FROM derive_queue')).rows[0]!.n)
  }

  /**
   * One hub's pass, beside any other hub's: takes queued entities in batches, derives and stores
   * them, queues whatever read a part of them that changed, and tells the hub what
   * moved. Only rows queued before the pass began are taken: a row this pass
   * derived is removed from the queue as it is stored, so one its cascade
   * queues again is new, and waits for the next pass. Stops when nothing
   * older is left or the budget is spent.
   */
  drain(opts: { budgetMs?: number; relink?: boolean } = {}): Promise<number> {
    if (this.draining) return this.draining
    this.draining = timed('derive.drain', () => this.drainOnce(opts.budgetMs ?? this.config.budgetMs, opts.relink ?? true)).finally(() => {
      this.draining = null
    })
    return this.draining
  }

  /** Blueprint ids with those that read fewer others first: derived in this order, a later one borrows what the earlier stored and is not derived twice. */
  private order(): string[] {
    return this.blueprints
      .list()
      .map((bp) => ({ id: bp.id, reads: this.reader.readsFor(bp.id)?.size ?? Infinity }))
      .sort((a, b) => a.reads - b.reads || a.id.localeCompare(b.id))
      .map((b) => b.id)
  }

  private async drainOnce(budgetMs: number, relink: boolean): Promise<number> {
    const began = Date.now()
    // Kept as text: a Date drops the microseconds, and a row queued in the same millisecond would read as newer than the pass.
    const since = (await this.db.query<{ now: string }>('SELECT now()::text AS now')).rows[0]!.now
    const order = this.order()
    let derived = 0
    let cascaded = 0
    let touched = false
    for (;;) {
      // Taken for a while, so the hubs that derive side by side each take their own: one that another holds is passed over.
      const taken = await this.db.query<{ blueprint: string; key: string }>(
        `UPDATE derive_queue q SET taken_until = now() + make_interval(secs => $4)
         FROM (SELECT ctid FROM derive_queue WHERE queued_at <= $2::timestamptz AND (taken_until IS NULL OR taken_until < now())
               ORDER BY array_position($3::text[], blueprint) NULLS LAST, queued_at LIMIT $1 FOR UPDATE SKIP LOCKED) t
         WHERE q.ctid = t.ctid RETURNING q.blueprint, q.key`,
        [this.config.batch, since, order, TAKEN_SECONDS],
      )
      if (!taken.rows.length) break
      const { changed, started } = await this.derive(taken.rows, { consume: true }).catch(async (error: unknown) => {
        await this.release(taken.rows)
        throw error
      })
      derived += taken.rows.length
      if (changed.length) {
        // Only readers derived before this read need deriving again; one derived since has seen the inputs as they are.
        // Queued a blueprint at a time, so the readers are counted under the blueprint whose rows sent them back.
        await this.db.tx(async (client) => {
          for (const blueprint of new Set(changed.map((r) => r.blueprint))) {
            const queued = await this.cascade(client, changed.filter((r) => r.blueprint === blueprint), started)
            if (queued) this.load.note('derive', blueprint, { extra: queued })
            cascaded += queued
          }
        })
      }
      const blueprints = [...new Set(changed.filter(shows).map((r) => r.blueprint))]
      if (blueprints.length) {
        // What shows a row beside another reads its status and icon of the stored row: a field moving there moves only its own lists.
        const titled = [...new Set(changed.filter((r) => r.moved === null || r.moved.has(PART.status) || r.moved.has(PART.icon)).map((r) => r.blueprint))]
        this.events.emit({ type: 'derived', blueprints, titled })
        // A rule that matches on a derived value reads rows that have landed. The leader links; a hub that only derives beside it tells it through the event.
        if (relink) this.rules.touch(blueprints, true)
        touched = true
      }
      if (Date.now() - began > budgetMs) break
    }
    if (derived) this.log.info('derive pass', { derived, cascaded, ms: Date.now() - began })
    if (touched && relink) void this.rules.evaluateMoved().catch(() => undefined)
    await this.upgraded()
    return derived
  }

  /** How often a hub that queued the rows an earlier way derived looks whether any is left. */
  private static readonly UPGRADE_CHECK_MS = 10_000

  /** Says once that every row an earlier way derived is derived again, whichever hubs derived them. */
  private async upgraded(): Promise<void> {
    const up = this.upgrading
    if (!up || Date.now() - up.checked < Deriver.UPGRADE_CHECK_MS) return
    up.checked = Date.now()
    const left = await this.db.query(`SELECT 1 FROM derived d JOIN entities e ON e.blueprint = d.blueprint AND e.key = d.key WHERE d.way < $1 AND e.state <> 'deleted' LIMIT 1`, [WAY])
    if (left.rowCount) return
    this.upgrading = null
    this.log.info('re-derive done: every row an earlier version derived is derived again', { rederived: up.queued, way: WAY, ms: Date.now() - up.started })
  }

  /**
   * Queues every entity that has no derived row, and drains until the queue is empty: all of them for the first lead
   * after the table arrives, and on a later lead only the few a run wrote while no hub led. Then queues every row an
   * earlier way derived and leaves them to the passes every deriving hub runs, a batch at a time: a stored row is
   * still read meanwhile, so nothing waits for them, and the hub says when the last is derived again.
   */
  async backfill(): Promise<void> {
    await timed('derive.backfill', async () => {
      const queued = await this.db.query(`INSERT INTO derive_queue (blueprint, key) SELECT e.blueprint, e.key FROM entities e WHERE e.state <> 'deleted' AND NOT EXISTS (SELECT 1 FROM derived d WHERE d.blueprint = e.blueprint AND d.key = e.key) ORDER BY e.blueprint, e.key ON CONFLICT DO NOTHING`)
      if (!queued.rowCount) this.log.info('derived state complete: nothing to backfill, every entity has a derived row or waits on the queue')
      else {
        this.log.info('backfill started: the entities with no derived row queued', { queued: queued.rowCount })
        const started = Date.now()
        while ((await this.depth()) > 0) await this.drain({ budgetMs: Infinity, relink: false })
        void this.rules.evaluateMoved().catch(() => undefined)
        this.log.info('backfill done', { ms: Date.now() - started })
      }
      await this.upgrade()
    })
  }

  /** Queues every stored row an earlier way derived, of an entity still there; one this way derived is left alone. */
  private async upgrade(): Promise<void> {
    const started = Date.now()
    const queued = await this.db.query(
      `INSERT INTO derive_queue (blueprint, key)
       SELECT d.blueprint, d.key FROM derived d JOIN entities e ON e.blueprint = d.blueprint AND e.key = d.key
       WHERE d.way < $1 AND e.state <> 'deleted' ORDER BY d.blueprint, d.key ON CONFLICT DO NOTHING`,
      [WAY],
    )
    if (!queued.rowCount) {
      this.log.info('derived state current: every stored row was derived this way', { way: WAY })
      return
    }
    this.upgrading = { queued: queued.rowCount, started, checked: 0 }
    this.log.info('re-derive started: the rows an earlier version derived queued', { queued: queued.rowCount, way: WAY })
  }

  /** The backstop on the lifecycle tick: queues what has no derived row, an older one than its entity, or one derived an earlier way, and forgets rows of entities that are gone. */
  async reconcile(): Promise<void> {
    await timed('derive.reconcile', async () => {
      const stale = await this.db.query(
        `INSERT INTO derive_queue (blueprint, key)
         SELECT e.blueprint, e.key FROM entities e LEFT JOIN derived d ON d.blueprint = e.blueprint AND d.key = e.key
         WHERE e.state <> 'deleted' AND (d.blueprint IS NULL OR d.derived_at < e.updated_at OR d.way < $1)
         ORDER BY e.blueprint, e.key ON CONFLICT DO NOTHING`,
        [WAY],
      )
      const gone = await this.db.query<{ blueprint: string; key: string }>(
        `DELETE FROM derived d WHERE NOT EXISTS (SELECT 1 FROM entities e WHERE e.blueprint = d.blueprint AND e.key = d.key AND e.state <> 'deleted') RETURNING blueprint, key`,
      )
      if (gone.rows.length) await this.db.tx((client) => this.enqueueReaders(client, gone.rows))
      if (stale.rowCount || gone.rows.length) this.log.info('derived state reconciled', { queued: stale.rowCount ?? 0, forgotten: gone.rows.length })
    })
  }

  /**
   * Derives again every stored row whose values have reached the moment
   * they said they would change: a trend's span ending, an entity leaving
   * a window, an age crossing its span, the hour for a calculation of the
   * time. Each row names that moment as it is derived, so nothing else is
   * touched for the clock.
   */
  async clock(): Promise<void> {
    await timed('derive.clock', async () => {
      const res = await this.db.query(`INSERT INTO derive_queue (blueprint, key) SELECT blueprint, key FROM derived WHERE expires_at <= now() ORDER BY blueprint, key ON CONFLICT DO NOTHING`)
      if (res.rowCount) this.log.info('clock: rows whose values reached their next change queued', { entities: res.rowCount })
      await this.standing()
    })
  }

  /**
   * A source whose standing flipped, grey on time or live again on a push, has its entities derived again: their status
   * reads it. Only what their status reads counts (`greys`), so a source failing run after run, each with a new reason,
   * derives none of them again. The source's own entities, its source and runner records, show its whole standing, level
   * and reason, so they are derived again whenever either moves, and on a hub's first pass: what was stored before it
   * started may be from another standing, and one that never moves again would keep it. That is one row a source and runner.
   */
  async standing(): Promise<void> {
    const flipped: string[] = []
    const moved: string[] = []
    for (const s of this.sources.list()) {
      const now = this.sources.greys(s.id) ?? ''
      const last = this.standings.get(s.id)
      this.standings.set(s.id, now)
      if (last !== undefined && last !== now) flipped.push(s.id)
      const said = this.sources.standing(s.id)
      const mine = said ? `${said.status}:${said.statusReason ?? ''}` : ''
      const before = this.own.get(s.id)
      this.own.set(s.id, mine)
      if (before !== mine) moved.push(s.id)
    }
    if (flipped.length) {
      const entities = await queueing(this.db, `SELECT blueprint, key FROM entities WHERE owner = ANY($1) AND state <> 'deleted'`, [flipped])
      this.log.info('source standing flipped: its entities queued', { sources: flipped, entities })
    }
    if (moved.length) {
      const entities = await queueing(this.db, `SELECT blueprint, key FROM entities WHERE blueprint = ANY($1) AND key = ANY($2) AND state <> 'deleted'`, [SOURCE_STANDING, moved])
      this.log.info('source standing moved: its own records queued', { sources: moved, entities })
    }
  }
}

/**
 * The icon value an entity carries before the fallback to its blueprint's,
 * set by the reader as it builds the entity. It is what is stored, so a
 * custom icon that comes or goes changes the picture at hydrate with no
 * re-derive.
 */
export const rawIcons = new WeakMap<Entity, string>()
