// The read side: rows become entities with resolved fields, relations in both
// directions, derived fields, and status. Everything a view or an agent sees
// comes through here.

import { compare, fieldOf, matches, nextChange, parsePath, soonest, splitMirror, type Hop, usesIncoming } from '../shared/filter.ts'
import { AGGREGATION_PERIODS, checksOf, ICON_FIELD, isDerived, isTrendHistory, SOURCE_BLUEPRINT, SOURCE_STANDING, TITLE_FIELD, entityId, parseDuration, parseEntityId, type AggregationDef, type Blueprint, type Change, type Entity, type EntityDetail, type EntityRef, type EntityState, type EntityStatus, type FieldProvenance, type Filter, isSpread, SHARED_LIST_MAX, type Layer, type RelatedRef, type RelationEnd, type StatusLevel } from '../shared/model.ts'
import { listActivity } from './activity.ts'
import type { Blueprints } from './blueprints.ts'
import type { Db } from './db.ts'
import type { EntityHead, EntityRow, RelationRow } from './entities.ts'
import { createHash } from 'node:crypto'
import { isPhoto } from '../shared/icons.ts'
import { hydrate, iconOf, rawIcons, type DerivedRow, type Looks, type Reads, type StoredReason } from './derive.ts'
import { ALL, Query, type OrderValues } from './query.ts'
import type { Sources } from './sources.ts'
import { alertLevel, type Alerts } from './alerts.ts'
import { checkLevel, healthcheckSchema, type Checks } from './checks.ts'
import { compile, type Expr, readsClock } from '../shared/expr.ts'
import { seriesFor, spanEnd, trendOf, type HistoryPoint } from './history.ts'
import type { Alert, CheckResult, ColumnDistribution, Scorecard } from '../shared/api.ts'
import { partFilters, partsOf, reached, scoreEntity, scorecardUsesIncoming } from '../shared/scorecard.ts'
import { resolve, type Layers } from './values.ts'
import { rollupSources, type View } from './visibility.ts'

/** Higher wins. UI relations act as overrides; git always wins. */
const RELATION_LAYERS = ['inherited', 'rule', 'pushed', 'ui', 'git'] as const

/** In SQL, the layers that win over `r.layer`: every one above it, and every one over a layer the list does not name. */
export const ABOVE = `CASE r.layer ${RELATION_LAYERS.map((l, i) => `WHEN '${l}' THEN '{${RELATION_LAYERS.slice(i + 1).join(',')}}'::text[]`).join(' ')} ELSE '{${RELATION_LAYERS.join(',')}}'::text[] END`

export interface ListOptions {
  blueprint?: string
  states?: EntityState[]
  includeHidden?: boolean
  filter?: Filter
  limit?: number
  offset?: number
  /** Start right after the row with these order values, read from a cursor; `offset` is then not read. */
  after?: OrderValues | null
  /** `field` or `-field`. */
  sort?: string
  /** The person whose stars lead the order (`starredBy` in `query.ts`): a catalog reader, never a query. */
  starredBy?: string
  /** Only what `starredBy` starred. */
  starredOnly?: boolean
  /** Attach who points at each entity, keyed `blueprint.relation`. */
  incoming?: boolean
  /** With `incoming`: carry only the first `most` links of each relation and how many there are, but those named `whole`. */
  peek?: { most: number; whole: readonly string[] }
  /** Attach the layer that won for each field and relation, so a grid knows what a person may change and what one already did. */
  layers?: boolean
  /** Count how every matching row, not only the page, shares out each categorical column. */
  distribution?: boolean
  /** What the reader may see. Filtering, sorting, and counting see only that, so a withheld value never decides what comes back. */
  view?: View
}

/** A column shows its most common values one by one, and the rest together. */
const BUCKETS = 12

interface TargetInfo {
  title: string
  state: EntityState
  icon: string | null
}

type Signals = { results: Map<string, CheckResult[]>; alerts: Map<string, Alert[]> }

/** What a blueprint's derived fields and status rollup read from the graph. */
interface Plan {
  /** Every relation path a mirror, an aggregation, or the rollup follows. */
  paths: string[]
  /** Paths whose ends are filtered by who points at them. */
  incomingWhere: string[]
  /**
   * Per path read only for its ends' stored values, the names of the values
   * read: what an end of it is loaded with. A path read any other way (the
   * rollup, a filter on what an end reaches, a search) is not here, and its
   * ends are loaded whole.
   */
  narrow: Map<string, string[]>
}

/** The state of one materialize call: what is loaded, and what is already derived. */
interface Pass {
  /** The check results and alerts of what the pass has loaded, where it works out status from them. */
  signals: Signals | null
  /** Whether a neighbour a blueprint already keeps may stand in for reading it. A walk that relinks reads afresh. */
  borrow: boolean
  known: Map<string, Entity>
  /** Ids looked for and not found, so a pending target is asked for once. */
  absent: Set<string>
  incoming: Map<string, RelationEnd[]>
  /** Who points at an entity along one incoming hop alone, keyed by `alongKey`: a walk reads only the links it steps along, never every link into a busy entity. */
  along: Map<string, Inward[]>
  /** The entities at the end of each path, keyed by `endsKey`. */
  ends: Map<string, Entity[]>
  /** Ends loaded with only the values a path reads of them (`Plan.narrow`), by id, with the names each was loaded with; never in `known`, which holds whole entities. */
  narrow: Map<string, { entity: Entity; names: ReadonlySet<string> }>
  /** The entities each path stepped through on its way, and those it found there but did not take as present, keyed by `endsKey`: what it read without reaching. */
  through: Map<string, Entity[]>
  gathered: Set<string>
  computed: Set<string>
  /**
   * Entities loaded without their relations, in a walk that reads an
   * entity's relations only to step out along them; null when every entity
   * is loaded whole.
   */
  bare: Set<string> | null
  /** Whether what a walk reaches is read with its values; without them it is read as who it is alone, for a walk that asks only which entities a path reaches. */
  values: boolean
  /**
   * Whether a walk takes only active entities as there: one its source no
   * longer sees is neither an end nor stepped through, and is kept in
   * `through`, so whoever read it is derived again when it comes back. What
   * a derived value reads is walked so; who a grant reaches is not.
   */
  present: boolean
  /** The history points each trend read from history reads, keyed by `historyKey`; read before anything is computed. */
  history: Map<string, HistoryPoint[]>
  /** The time the pass reads as now: what every age, window, and trend in it is measured from. */
  now: number
  /** Per computed entity, the ids whose change moves it: path ends and what the paths stepped through, relation targets, and who points at it when a scorecard asks. */
  reads: Reads
  /** Per computed entity whose values read the time, the next moment one of them changes because time passed. */
  expires: Map<string, number>
  /** The model as it stood when the pass began: every blueprint's last change, as one string. */
  model: string
}

/** What a compute leaves of each base entity: the entity, what it read, and when its values next change on their own. */
export interface Derivation {
  entities: Entity[]
  reads: Reads
  expires: Map<string, number>
  /** Per base entity that a path of another blueprint steps through by who points at it: who that is, as one short string. */
  pointed: Map<string, string>
}

/**
 * The parts of a stored derived row a reader can depend on. A row that
 * changes sends back only the readers that read a part that moved: a field
 * by name, the status, the scorecard levels, the relations, the icon, and who
 * points at the entity. A title and a state are not in the row; whoever
 * changes one sends every reader back itself.
 */
export const PART = { field: (name: string) => `f:${name}`, status: 'status', levels: 'levels', relations: 'relations', icon: 'icon', pointed: 'pointed', any: '*' } as const

/** The parts a value read by name comes from. A name the hub keeps about every entity is a field too where a blueprint defines one. */
function partsOfField(field: string): string[] {
  const meta = (name: string) => (name === 'status' ? [PART.status] : name === 'icon' ? [PART.icon] : [])
  if (field.startsWith('$')) return meta(field.slice(1))
  if (field.startsWith('fields.')) return [PART.field(field.slice(7))]
  return [PART.field(field), ...meta(field)]
}

/** The parts a filter reads of the entity it is asked of. */
function partsOfFilter(f: Filter): string[] {
  if ('and' in f) return f.and.flatMap(partsOfFilter)
  if ('or' in f) return f.or.flatMap(partsOfFilter)
  if ('not' in f) return partsOfFilter(f.not)
  if ('field' in f) return partsOfField(f.field)
  if ('relation' in f) return [f.relation.startsWith('<-') ? PART.pointed : PART.relations]
  if ('scorecard' in f) return [PART.levels]
  if ('search' in f) return [PART.any]
  return []
}

/** Who points at an entity, as one short string that changes when any of them comes or goes. */
function pointers(ends: RelationEnd[]): string {
  const hash = createHash('sha1')
  for (const line of ends.map((i) => `${i.declaredOn}.${i.relation}>${entityId(i.target)}`).sort()) hash.update(line).update('\n')
  return hash.digest('base64')
}

/** Per blueprint and part of its stored rows, the blueprints that read it; and the blueprints that follow every change. */
interface Wanted {
  parts: Map<string, Map<string, Set<string>>>
  every: string[]
}

const endsKey = (e: Entity, path: string) => `${e.id}\n${path}`
/** One incoming hop as one key: the relation, and the one blueprint it is taken from or every one. */
const hopKey = (hop: Hop) => `${hop.from ?? '*'}:${hop.relation}`
const alongKey = (id: string, hop: Hop) => `${id}\n${hopKey(hop)}`
const historyKey = (e: Entity, field: string) => `${e.id}\n${field}`

/** The scorecards that score a blueprint, in the order their levels must be computed: one that reads another's level comes after it. */
export interface ScorecardSource {
  forBlueprint(blueprint: string): Scorecard[]
  /** When the scorecards scoring a blueprint last changed on this hub; null when never since it started. */
  changedAt(blueprint: string): number | null
  /** A number that changes whenever a scorecard does. */
  revision(): number
}

export const WORST: Record<StatusLevel, number> = { red: 3, amber: 2, grey: 1, green: 0 }

export function worst(levels: StatusLevel[]): StatusLevel {
  return levels.reduce<StatusLevel>((acc, l) => (WORST[l] > WORST[acc] ? l : acc), 'green')
}

/** One blueprint's entities, every one not deleted, in title order, with the rows they were read from. */
interface Estate {
  entities: Entity[]
  rows: Map<string, EntityRow>
}

/** How long a kept listing whose values read the clock is taken as current. */
export const CLOCK_MS = 60_000

/** The stored derived row beside an entity row, as one `entities JOIN derived` row reads. */
export type JoinedRow = EntityRow & { derived: DerivedRow | null }
/** An entity row's head with its stored derived row, as `HEADED` has it: what a current row is hydrated from, without its layers. */
export type HeadedRow = EntityHead & { derived: DerivedRow | null }
/** A link pointing in as a walk steps along it: the relation, the blueprint that declares it, and the entity it comes from. */
type Inward = Pick<RelationEnd, 'relation' | 'declaredOn' | 'target'>

/** A link pointing in, with the title and state of the entity it comes from. */
type IncomingRow = RelationRow & { title: string; state: EntityState; icon: string | null }

/** The columns of an entity row but its layers: who it is, its state, and its times. */
const HEAD = 'blueprint, key, title, state, owner, scope, hidden, created_at, updated_at, last_seen_at, missing_since, missing_runs, grace_until, deleted_at, blocked_until'

/** The columns of an entity row that hold its values, one a layer. */
const LAYERS = ['ui', 'pushed', 'override', 'git'] as const satisfies readonly (keyof Layers)[]

/** An entity row with its layers left empty, without the values that are most of its size. */
const WHO_ONLY = `${HEAD}, '{}'::jsonb AS ui, '{}'::jsonb AS pushed, '{}'::jsonb AS override, '{}'::jsonb AS git`

/** An entity row's head with its derived row, as `JOINED` has it: what a stored row is hydrated from. */
export const HEADED = `${HEAD.split(', ').map((c) => `e.${c}`).join(', ')}, CASE WHEN d.blueprint IS NULL THEN NULL ELSE jsonb_build_object('fields', d.fields, 'relations', d.relations, 'icon', d.icon, 'level', d.level, 'reasons', d.reasons, 'levels', d.levels, 'derived_at', d.derived_at) END AS derived`

/** `SELECT` of an entity row with its derived row as one JSON column, null where none is stored yet. */
export const JOINED = `e.*, CASE WHEN d.blueprint IS NULL THEN NULL ELSE jsonb_build_object('fields', d.fields, 'relations', d.relations, 'icon', d.icon, 'level', d.level, 'reasons', d.reasons, 'levels', d.levels, 'derived_at', d.derived_at) END AS derived`
export const JOIN = `FROM entities e LEFT JOIN derived d ON d.blueprint = e.blueprint AND d.key = e.key`

/** A copy of an entity a reader may add to, carrying where its rolled-up reasons came from. */
function copyOf(e: Entity): Entity {
  const c = { ...e }
  const from = rollupSources.get(e)
  if (from) rollupSources.set(c, from)
  return c
}


/** One link by which an entity is about another: the entity, and the blueprint and id of what it names. */
export interface AboutLink {
  id: string
  targetBlueprint: string
  target: string
}

export class Reader {
  private readonly exprs = new Map<string, Expr>()
  private readonly calculationOrder = new WeakMap<Blueprint, [string, string][]>()
  /** Told of rows read with no derived row stored yet, so they are queued to be derived; set by the hub. */
  onUnderived: (refs: EntityRef[]) => void = () => undefined
  /** Asked, before a blueprint is listed from its stored rows, to derive what is missing or stale among them while that is few; set by the hub. */
  ensureDerived: (blueprint: string, staleBefore: Date | null, keys?: readonly string[]) => Promise<void> = async () => undefined
  /** When an entity was last seen, its scope's last snapshot counted; set by the hub. */
  seenAt: (row: EntityHead) => Date | null = (row) => row.last_seen_at
  private readonly query: Query
  private readonly plans = new Map<string, { at: string; plan: Plan }>()
  /** Per blueprint, the paths whose ends must be derived too, for the model as it stood when they were worked out. */
  private readonly deepPaths = new Map<string, { model: string; paths: Set<string> }>()
  private readonly paths = new Map<string, Hop[]>()
  private providers: { checks: Checks; alerts: Alerts } | null = null
  private scorecards: ScorecardSource = { forBlueprint: () => [], changedAt: () => null, revision: () => 0 }
  /** What `readsFor` and `modelStamp` answered, for the blueprints and scorecards as they stood at `at`. */
  private model: { at: string; reads: Map<string, ReadonlySet<string> | null>; stamp: string | null; wanted: Wanted | null } = { at: '', reads: new Map(), stamp: null, wanted: null }

  /** Scorecards give every entity the levels it reached; they are built after the reader, so they attach here. */
  attachScorecards(scorecards: ScorecardSource): void {
    this.scorecards = scorecards
  }

  /** Health checks and alerts feed status; they are built after the reader, so they attach here. */
  attach(providers: { checks: Checks; alerts: Alerts }): void {
    this.providers = providers
  }

  /**
   * A blueprint's calculations in the order they run: each after the
   * calculations it reads, otherwise in field order. A cycle runs in field
   * order, each field reading the others as they stand.
   */
  private calculations(bp: Blueprint): [string, string][] {
    let order = this.calculationOrder.get(bp)
    if (order) return order
    const calculated = new Map(Object.entries(bp.fields).flatMap(([name, def]) => (def.calculation ? [[name, def.calculation] as const] : [])))
    const done = new Set<string>()
    order = []
    const visit = (name: string): void => {
      if (done.has(name)) return
      done.add(name)
      const source = calculated.get(name)!
      let reads: ReadonlySet<string> = new Set()
      try {
        reads = this.expr(source).reads
      } catch {
        // It cannot compile, so it reads nothing and evaluates to null where it falls.
      }
      for (const read of reads) if (read !== name && calculated.has(read)) visit(read)
      order!.push([name, source])
    }
    for (const name of calculated.keys()) visit(name)
    this.calculationOrder.set(bp, order)
    return order
  }

  private expr(source: string): Expr {
    let e = this.exprs.get(source)
    if (!e) {
      e = compile(source)
      this.exprs.set(source, e)
    }
    return e
  }

  private readonly db: Db
  private readonly blueprints: Blueprints
  private readonly sources: Sources
  /** The custom icons the hub holds: a name among them is a picture too. */
  private readonly icons: { has(name: string): boolean; names(): string[] }
  /** People's pictures, laid over their person entities. The hub wires them. */
  pictures: { lay(e: Entity): void } | null = null
  /** What draws an entity, as `hydrate` takes it. */
  private readonly looks: Looks = { has: (name) => this.icons.has(name), lay: (e) => this.pictures?.lay(e) }

  constructor(db: Db, blueprints: Blueprints, sources: Sources, icons: { has(name: string): boolean; names(): string[] }) {
    this.db = db
    this.blueprints = blueprints
    this.sources = sources
    this.icons = icons
    this.query = new Query(db, blueprints, icons)
  }

  /** How many entities a question matches, as the reader sees them, with none of them read. */
  async count(opts: Pick<ListOptions, 'blueprint' | 'states' | 'filter' | 'view'>): Promise<number> {
    const sight = opts.view && !opts.view.all ? opts.view : ALL
    const blueprint = opts.blueprint ? this.blueprints.resolve(opts.blueprint) : undefined
    return (await this.query.rows({ blueprint, states: opts.states ?? ['active', 'missing'], includeHidden: false, filter: opts.filter }, sight, { limit: 0, offset: 0 })).total
  }

  /** The values one field of a blueprint holds, as the reader sees them, the most common first: what a condition on it could have asked for. */
  async valuesOf(blueprint: string, field: string, view: View | undefined, most: number): Promise<{ value: string; count: number }[]> {
    const sight = view && !view.all ? view : ALL
    const groups = await this.query.groups({ blueprint: this.blueprints.resolve(blueprint), states: ['active', 'missing'], includeHidden: false, group: field }, sight)
    return groups.sort((a, b) => b.count - a.count).slice(0, most).map((g) => ({ value: g.key, count: g.count }))
  }

  /** How many entities of each blueprint a question matches, as the reader sees them: where a search across every kind found things. */
  async kinds(opts: Pick<ListOptions, 'states' | 'filter' | 'view'>): Promise<Record<string, number>> {
    const sight = opts.view && !opts.view.all ? opts.view : ALL
    const groups = await this.query.groups({ states: opts.states ?? ['active', 'missing'], includeHidden: false, filter: opts.filter, group: '$blueprint' }, sight)
    return Object.fromEntries(groups.map((g) => [g.key, g.count]))
  }

  /**
   * The entities a question matches, one page of them in its order, from
   * their stored derived rows: the filter, the sort, and the distribution
   * are worked out by Postgres (`query.ts`), so the answer costs what the
   * page shows. The page is then hydrated and put through the reader's view.
   */
  async list(opts: ListOptions = {}): Promise<{ entities: Entity[]; total: number; next: OrderValues | null; distribution?: Record<string, ColumnDistribution> }> {
    const states = opts.states ?? ['active', 'missing']
    const blueprint = opts.blueprint ? this.blueprints.resolve(opts.blueprint) : undefined
    const view = opts.view && !opts.view.all ? opts.view : null
    const sight = view ?? ALL
    if (blueprint) await this.ensureDerived(blueprint, this.staleBefore(blueprint))
    const params = { blueprint, states, includeHidden: !!opts.includeHidden, filter: opts.filter, sort: opts.sort, ...(opts.starredBy ? { starredBy: opts.starredBy } : {}), ...(opts.starredOnly ? { starredOnly: true } : {}) }
    const { rows, total, next } = await this.query.rows(params, sight, { limit: opts.limit ?? 200, offset: opts.offset ?? 0, after: opts.after })
    let page = await this.derive(rows)
    if (opts.incoming || opts.layers) page = page.map(copyOf)
    if (opts.incoming) await this.attachIncoming(page, opts.peek)
    if (opts.layers) await this.attachLayers(page, await this.rowsFor(page))
    if (view) page = view.entities(page)
    const bp = opts.distribution && blueprint ? this.blueprints.get(blueprint) : undefined
    if (!bp) return { entities: page, total, next }
    const distribution = await this.query.distribution(params, sight)
    return { entities: page, total, next, distribution: view ? view.distribution(bp.id, distribution) : distribution }
  }

  /** The grid questions, answered in SQL: `query.ts`. */
  get sql(): Query {
    return this.query
  }

  /** The moment a stored row of this blueprint must be derived after to be current: the last change to what derivation reads of its model, or to its scorecards. Null when any row will do. */
  staleBefore(blueprint: string): Date | null {
    const stamps: number[] = []
    const model = this.blueprints.shapedAt(blueprint)
    if (model !== undefined) stamps.push(model)
    const scored = this.scorecards.changedAt(blueprint)
    if (scored !== null) stamps.push(scored)
    return stamps.length ? new Date(Math.max(...stamps)) : null
  }

  /**
   * The entities in `states` of one blueprint, or of every one, in blueprint
   * then title order, from their stored derived rows. A row nothing has
   * derived yet is derived here for this read alone and queued to be stored.
   */
  private async read(blueprint: string | undefined, states: EntityState[]): Promise<Estate> {
    const params: unknown[] = [states]
    if (blueprint) params.push(blueprint)
    const res = await this.db.query<JoinedRow>(`SELECT ${JOINED} ${JOIN} WHERE e.state = ANY($1) ${blueprint ? 'AND e.blueprint = $2' : ''} ORDER BY e.blueprint, e.title, e.key`, params)
    return { entities: await this.derive(res.rows), rows: new Map(res.rows.map((r) => [entityId(r), r])) }
  }

  /**
   * Joined rows as entities: one with a derived row is hydrated from it, and
   * the rest are derived here, in one pass, and queued so the next read finds
   * them stored.
   */
  /**
   * Rows as entities, in their order: a current one hydrated from its stored
   * row, and the rest derived here and queued. A row read without its layers
   * (`HEADED`) is read whole only when it must be derived: a list of
   * thousands costs what is stored, not what was pushed.
   */
  async derive(rows: (HeadedRow | JoinedRow)[]): Promise<Entity[]> {
    const stale = this.staleness()
    const cold = rows.filter(stale)
    const whole = cold.filter((r): r is JoinedRow => 'pushed' in r)
    const headed = cold.filter((r) => !('pushed' in r))
    const read = headed.length ? await this.joinedFor(headed) : []
    const derived = await this.materialize([...whole, ...read])
    const fresh = new Map(derived.map((e) => [e.id, e]))
    if (cold.length) this.onUnderived(cold.map((r) => ({ blueprint: r.blueprint, key: r.key })))
    const out: Entity[] = []
    for (const r of rows) {
      if (stale(r)) {
        // A row deleted between the list and its whole read is no longer there to show.
        const e = fresh.get(entityId(r))
        if (e) out.push(e)
        continue
      }
      const e = hydrate(r, r.derived!, this.blueprints.get(r.blueprint), this.looks, this.seenAt(r))
      this.live(e)
      out.push(e)
    }
    return out
  }

  /**
   * Whether a joined row's derived row may be used as it is. Cold when there
   * is none, when it was derived before the entity last changed, so a write
   * the leader has not reached yet still reads true, or when it was derived
   * before what derivation reads of the blueprint's model (`shapedAt`), or
   * its scorecards, last changed, so it is of another model. A value that reads
   * the time is never recomputed for a read: the row says when it next
   * changes, and the leader derives it again then.
   */
  private staleness(): (r: Pick<HeadedRow, 'blueprint' | 'updated_at'> & { derived: Pick<DerivedRow, 'derived_at'> | null }) => boolean {
    return (r) => {
      if (!r.derived) return true
      const at = new Date(r.derived.derived_at).getTime()
      if (at < r.updated_at.getTime()) return true
      const model = this.blueprints.shapedAt(r.blueprint)
      if (model !== undefined && at < model) return true
      const scored = this.scorecards.changedAt(r.blueprint)
      return scored !== null && at < scored
    }
  }

  /**
   * These entities, not deleted, as their stored rows say, in no order. The
   * layers are read only for a row whose derived row is not current, to
   * derive it: they are most of a row's size and a stored row needs none of
   * them, so a read of thousands costs what is shown, not what was pushed.
   */
  async hydrated(refs: EntityRef[]): Promise<Entity[]> {
    if (!refs.length) return []
    const rows = await this.headedFor(refs)
    const stale = this.staleness()
    const cold = rows.filter(stale)
    const out = cold.length ? await this.derive(await this.joinedFor(cold)) : []
    for (const r of rows) {
      if (stale(r)) continue
      const e = hydrate(r, r.derived!, this.blueprints.get(r.blueprint), this.looks, this.seenAt(r))
      this.live(e)
      out.push(e)
    }
    return out
  }

  /**
   * The level each of these entities stands at, from its stored row, in one
   * narrow statement: null where the stored row is not current, for the
   * caller to read whole. Hidden and deleted ones are left out.
   */
  async levelsOf(refs: EntityRef[]): Promise<{ ref: EntityRef; state: 'active' | 'missing'; level: StatusLevel | null }[]> {
    if (!refs.length) return []
    const rows = await this.db.query<{ blueprint: string; key: string; state: 'active' | 'missing'; updated_at: Date; level: StatusLevel | null; derived: Pick<DerivedRow, 'derived_at'> | null }>(
      `SELECT e.blueprint, e.key, e.state, e.updated_at, d.level, CASE WHEN d.blueprint IS NULL THEN NULL ELSE jsonb_build_object('derived_at', d.derived_at) END AS derived ${JOIN} WHERE (e.blueprint, e.key) IN (SELECT * FROM unnest($1::text[], $2::text[])) AND e.state <> 'deleted' AND NOT e.hidden`,
      [refs.map((r) => r.blueprint), refs.map((r) => r.key)],
    )
    const stale = this.staleness()
    return rows.rows.map((r) => ({ ref: { blueprint: r.blueprint, key: r.key }, state: r.state, level: stale(r) ? null : r.level }))
  }

  /**
   * Rows with their derived rows, not deleted, by reference, with the layers
   * only of those whose derived row is not current: a current one is
   * hydrated from that row alone. The statement asks a little more than
   * `staleness` does, never less, so a row it leaves without layers is one
   * that is current.
   */
  private async neighboursFor(refs: EntityRef[]): Promise<(HeadedRow & Partial<Layers>)[]> {
    if (!refs.length) return []
    const kinds = [...new Set(refs.map((r) => r.blueprint))]
    const before = kinds.map((b) => this.staleBefore(b)?.toISOString() ?? null)
    const stale = `(d.blueprint IS NULL OR d.derived_at <= e.updated_at OR d.derived_at <= s.before)`
    const rows = await this.db.query<HeadedRow & Partial<Layers>>(
      `SELECT ${HEADED}, ${LAYERS.map((l) => `CASE WHEN ${stale} THEN e.${l} END AS ${l}`).join(', ')} ${JOIN}
       JOIN unnest($3::text[], $4::timestamptz[]) AS s(blueprint, before) ON s.blueprint = e.blueprint
       WHERE (e.blueprint, e.key) IN (SELECT * FROM unnest($1::text[], $2::text[])) AND e.state <> 'deleted'`,
      [refs.map((r) => r.blueprint), refs.map((r) => r.key), kinds, before],
    )
    return rows.rows
  }

  /** Heads of rows with their derived rows, not deleted, by reference: what a current row is hydrated from, without its layers. */
  private async headedFor(refs: EntityRef[]): Promise<HeadedRow[]> {
    if (!refs.length) return []
    const rows = await this.db.query<HeadedRow>(`SELECT ${HEADED} ${JOIN} WHERE (e.blueprint, e.key) IN (SELECT * FROM unnest($1::text[], $2::text[])) AND e.state <> 'deleted'`, [refs.map((r) => r.blueprint), refs.map((r) => r.key)])
    return rows.rows
  }

  /** Rows with their derived rows, not deleted, by reference. */
  async joinedFor(refs: EntityRef[]): Promise<JoinedRow[]> {
    if (!refs.length) return []
    const rows = await this.db.query<JoinedRow>(`SELECT ${JOINED} ${JOIN} WHERE (e.blueprint, e.key) IN (SELECT * FROM unnest($1::text[], $2::text[])) AND e.state <> 'deleted'`, [refs.map((r) => r.blueprint), refs.map((r) => r.key)])
    return rows.rows
  }

  /**
   * One entity with everything about it. With `most`, each relation pointing
   * in carries its first `most` links, in title order, and `incomingCount`
   * how many there are: a busy entity is pointed at by thousands.
   */
  async get(ref: EntityRef, opts: { includeDeleted?: boolean; most?: number } = {}): Promise<EntityDetail | null> {
    const rows = await this.db.query<JoinedRow>(`SELECT ${JOINED} ${JOIN} WHERE e.blueprint = $1 AND e.key = $2`, [this.blueprints.resolve(ref.blueprint), ref.key])
    const row = rows.rows[0]
    if (!row || (row.state === 'deleted' && !opts.includeDeleted)) return null
    // A tombstone is read as it stands, never stored.
    const [entity] = row.state === 'deleted' ? await this.materialize([row]) : await this.derive([row])
    if (!entity) return null
    const bp = this.blueprints.get(row.blueprint)
    const provenance: Record<string, FieldProvenance> = {}
    const layers = layersOf(row)
    for (const name of fieldNames(bp, layers)) {
      const r = resolve(name, layers, bp ? this.blueprints.fieldDef(bp, name) : undefined)
      if (r) provenance[name] = r.provenance
    }
    const outgoing = await this.outgoing([row])
    const peeked = opts.most === undefined ? null : await this.incomingPeek([ref], opts.most, [])
    const incoming = peeked ? (peeked.ends.get(entityId(ref)) ?? []) : await this.incoming(ref)
    entity.incomingRefs = refsOf(incoming)
    if (peeked) entity.incomingCount = peeked.counts.get(entityId(ref)) ?? {}
    const changes = await listActivity(this.db, { blueprint: ref.blueprint, key: ref.key, limit: 50 })
    return {
      ...entity,
      provenance,
      outgoing: outgoing.get(entityId(ref)) ?? [],
      incoming,
      changes,
    }
  }

  /** Walks relations from an entity. `blueprints` limits which nodes are followed and returned. */
  async related(ref: EntityRef, direction: 'in' | 'out' | 'both', depth: number, blueprints?: string[], sees: (blueprint: string) => boolean = () => true): Promise<{ nodes: Entity[]; edges: { from: EntityRef; to: EntityRef; relation: string; declaredOn: string }[] }> {
    const seen = new Map<string, EntityRef>([[entityId(ref), ref]])
    const edges: { from: EntityRef; to: EntityRef; relation: string; declaredOn: string }[] = []
    const edgeKeys = new Set<string>()
    let frontier: EntityRef[] = [ref]
    for (let level = 0; level < depth && frontier.length; level++) {
      const next: EntityRef[] = []
      const rows = await this.rowsFor(frontier)
      const out = direction === 'in' ? new Map<string, RelationEnd[]>() : await this.outgoing(rows)
      const into = direction === 'out' ? new Map<string, RelationEnd[]>() : await this.incomingFor(rows)
      for (const row of rows) {
        const from = { blueprint: row.blueprint, key: row.key }
        for (const end of out.get(entityId(from)) ?? []) {
          if (blueprints && !blueprints.includes(end.target.blueprint)) continue
          if (!sees(end.target.blueprint)) continue
          const k = `${entityId(from)}>${end.relation}>${entityId(end.target)}`
          if (!edgeKeys.has(k)) {
            edgeKeys.add(k)
            edges.push({ from, to: end.target, relation: end.relation, declaredOn: end.declaredOn })
          }
          if (!end.pending && !seen.has(entityId(end.target))) {
            seen.set(entityId(end.target), end.target)
            next.push(end.target)
          }
        }
        if (direction !== 'out') {
          for (const end of into.get(entityId(from)) ?? []) {
            if (blueprints && !blueprints.includes(end.target.blueprint)) continue
            if (!sees(end.target.blueprint)) continue
            const k = `${entityId(end.target)}>${end.relation}>${entityId(from)}`
            if (!edgeKeys.has(k)) {
              edgeKeys.add(k)
              edges.push({ from: end.target, to: from, relation: end.relation, declaredOn: end.declaredOn })
            }
            if (!seen.has(entityId(end.target))) {
              seen.set(entityId(end.target), end.target)
              next.push(end.target)
            }
          }
        }
      }
      frontier = next
    }
    const nodes = await this.derive(await this.joinedFor([...seen.values()]))
    return { nodes, edges }
  }

  /** Entities pointing at `ref`, through relations declared on their own blueprints. */
  async incoming(ref: EntityRef): Promise<RelationEnd[]> {
    return (await this.incomingFor([ref])).get(entityId(ref)) ?? []
  }

  /** Who points at each of `refs`, by entity id. Only the winning layer of each (entity, relation) counts. */
  async incomingFor(refs: EntityRef[]): Promise<Map<string, RelationEnd[]>> {
    const out = new Map<string, RelationEnd[]>(refs.map((r) => [entityId(r), []]))
    if (!refs.length) return out
    // A lower layer may still hold a target: an end is only real when no higher layer of the same relation is held. Asked of
    // each row as it is found, an index probe, never by reading every relation of everyone who points here.
    const hits = await this.db.query<IncomingRow>(
      `SELECT r.*, e.title, e.state, d.icon FROM relations r JOIN entities e ON e.blueprint = r.blueprint AND e.key = r.key
       LEFT JOIN derived d ON d.blueprint = r.blueprint AND d.key = r.key
       WHERE (r.target_blueprint, r.target_key) IN (SELECT * FROM unnest($1::text[], $2::text[])) AND e.state <> 'deleted'
         AND (r.blueprint, r.relation) IN (SELECT * FROM unnest($3::text[], $4::text[]))
         AND NOT EXISTS (SELECT 1 FROM relations w WHERE w.blueprint = r.blueprint AND w.key = r.key AND w.relation = r.relation AND w.layer = ANY(${ABOVE}))`,
      [refs.map((r) => r.blueprint), refs.map((r) => r.key), ...this.blueprints.definedRelations()],
    )
    return this.endsOf(hits.rows, out)
  }

  /**
   * Who points at each entity through the relations asked of it alone, by
   * entity id: one row a link, as the entity, the blueprint that declares the
   * relation, and its name. What else points at a busy entity is never read.
   */
  private async incomingAlong(cols: [string[], string[], string[], string[]], ordered: boolean): Promise<Map<string, Inward[]>> {
    // A walk steps to who points in and reads each of them itself: only which links there are is asked. A walk that
    // reads values takes a path's ends in the order every read of who points in gives them, by title; one that asks
    // only which entities a path reaches takes them in any order, and a link two layers hold counts once there too.
    const hits = await this.db.query<{ target_blueprint: string; target_key: string; blueprint: string; key: string; relation: string; title: string }>(
      `SELECT ${ordered ? 'DISTINCT ' : ''}r.target_blueprint, r.target_key, r.blueprint, r.key, r.relation, ${ordered ? 'e.title' : "'' AS title"} FROM unnest($1::text[], $2::text[], $3::text[], $4::text[]) AS a(target_blueprint, target_key, blueprint, relation)
       JOIN relations r ON r.target_blueprint = a.target_blueprint AND r.target_key = a.target_key AND r.blueprint = a.blueprint AND r.relation = a.relation
       JOIN entities e ON e.blueprint = r.blueprint AND e.key = r.key
       WHERE e.state <> 'deleted'
         AND NOT EXISTS (SELECT 1 FROM relations w WHERE w.blueprint = r.blueprint AND w.key = r.key AND w.relation = r.relation AND w.layer = ANY(${ABOVE}))`,
      cols,
    )
    const out = new Map<string, (Inward & { title: string })[]>()
    for (const r of hits.rows) {
      const to = `${r.target_blueprint}:${r.target_key}`
      let ends = out.get(to)
      if (!ends) out.set(to, (ends = []))
      ends.push({ relation: r.relation, declaredOn: r.blueprint, target: { blueprint: r.blueprint, key: r.key }, title: r.title })
    }
    // In the order every read of who points in gives them, so a path's first end is the same whichever read found it.
    if (ordered) for (const ends of out.values()) ends.sort((a, b) => a.relation.localeCompare(b.relation) || a.title.localeCompare(b.title))
    return out
  }

  /** Links found pointing in, as the ends each target is pointed at from, a link once however many layers hold it. */
  private endsOf(rows: IncomingRow[], out: Map<string, RelationEnd[]>): Map<string, RelationEnd[]> {
    const seen = new Set<string>()
    for (const r of rows) {
      const from = `${r.blueprint}:${r.key}`
      const to = `${r.target_blueprint}:${r.target_key}`
      const k = `${to}|${from}|${r.relation}`
      if (seen.has(k)) continue
      seen.add(k)
      const def = this.blueprints.get(r.blueprint)?.relations[r.relation]
      let ends = out.get(to)
      if (!ends) out.set(to, (ends = []))
      ends.push({
        relation: r.relation,
        declaredOn: r.blueprint,
        target: { blueprint: r.blueprint, key: r.key },
        targetTitle: r.title,
        targetIcon: r.icon,
        pending: false,
        dangling: r.state !== 'active',
        title: def?.inverseTitle ?? `${def?.title ?? r.relation} (incoming)`,
        display: def?.display ?? 'link',
        layer: r.layer as Layer,
      })
    }
    for (const ends of out.values()) ends.sort((a, b) => a.relation.localeCompare(b.relation) || (a.targetTitle ?? '').localeCompare(b.targetTitle ?? ''))
    return out
  }

  /**
   * Sets `incomingRefs` on every entity that does not carry it yet. With
   * `peek`, each relation pointing in carries its first `most` links and
   * `incomingCount` how many there are, but for the relations named `whole`,
   * which carry every link: a row of a grid shows a few of who points at it,
   * and a busy entity is pointed at by thousands.
   */
  async attachIncoming(entities: Entity[], peek?: { most: number; whole: readonly string[] }): Promise<void> {
    const bare = entities.filter((e) => !e.incomingRefs)
    if (!peek) {
      const ends = await this.incomingFor(bare)
      for (const e of bare) e.incomingRefs = refsOf(ends.get(e.id) ?? [])
      return
    }
    const { ends, counts } = await this.incomingPeek(bare, peek.most, peek.whole)
    for (const e of bare) {
      e.incomingRefs = refsOf(ends.get(e.id) ?? [])
      e.incomingCount = counts.get(e.id) ?? {}
    }
  }

  /**
   * The first `most` links of each relation pointing at each of `refs`, in
   * title order, and how many each relation holds, by entity id: every link
   * of a relation named in `whole` (`blueprint.relation`). Every link is
   * judged and counted in the statement, and only what is shown leaves it.
   */
  private async incomingPeek(refs: EntityRef[], most: number, whole: readonly string[]): Promise<{ ends: Map<string, RelationEnd[]>; counts: Map<string, Record<string, number>> }> {
    const ends = new Map<string, RelationEnd[]>(refs.map((r) => [entityId(r), []]))
    const counts = new Map<string, Record<string, number>>()
    if (!refs.length) return { ends, counts }
    const hits = await this.db.query<IncomingRow & { total: number }>(
      `WITH hits AS (
         SELECT DISTINCT ON (r.target_blueprint, r.target_key, r.blueprint, r.key, r.relation) r.*, e.title, e.state
         FROM relations r JOIN entities e ON e.blueprint = r.blueprint AND e.key = r.key
         WHERE (r.target_blueprint, r.target_key) IN (SELECT * FROM unnest($1::text[], $2::text[])) AND e.state <> 'deleted'
           AND (r.blueprint, r.relation) IN (SELECT * FROM unnest($3::text[], $4::text[]))
           AND NOT EXISTS (SELECT 1 FROM relations w WHERE w.blueprint = r.blueprint AND w.key = r.key AND w.relation = r.relation AND w.layer = ANY(${ABOVE}))
       ), ranked AS (
         SELECT h.*, row_number() OVER (PARTITION BY h.target_blueprint, h.target_key, h.blueprint, h.relation ORDER BY h.title COLLATE orrery_natural, h.key) AS n,
           (count(*) OVER (PARTITION BY h.target_blueprint, h.target_key, h.blueprint, h.relation))::int AS total
         FROM hits h
       )
       SELECT k.*, d.icon FROM ranked k LEFT JOIN derived d ON d.blueprint = k.blueprint AND d.key = k.key
       WHERE k.n <= $5 OR (k.blueprint || '.' || k.relation) = ANY($6::text[])`,
      [refs.map((r) => r.blueprint), refs.map((r) => r.key), ...this.blueprints.definedRelations(), most, whole],
    )
    for (const r of hits.rows) {
      const id = `${r.target_blueprint}:${r.target_key}`
      let of = counts.get(id)
      if (!of) counts.set(id, (of = {}))
      of[`${r.blueprint}.${r.relation}`] = r.total
    }
    return { ends: this.endsOf(hits.rows, ends), counts }
  }

  /** Sets `layers` and `relationLayers` on each entity from the row it was read from. */
  private async attachLayers(entities: Entity[], rows: EntityRow[]): Promise<void> {
    const wanted = new Set(entities.map((e) => e.id))
    const mine = rows.filter((r) => wanted.has(`${r.blueprint}:${r.key}`))
    const byId = new Map(mine.map((r) => [`${r.blueprint}:${r.key}`, r]))
    const outgoing = await this.outgoing(mine)
    for (const e of entities) {
      const row = byId.get(e.id)
      if (!row) continue
      const bp = this.blueprints.get(e.blueprint)
      const layers = layersOf(row)
      e.layers = {}
      for (const name of fieldNames(bp, layers)) {
        const won = resolve(name, layers, bp ? this.blueprints.fieldDef(bp, name) : undefined)
        if (won) e.layers[name] = won.provenance.layer
      }
      e.relationLayers = Object.fromEntries((outgoing.get(e.id) ?? []).map((end) => [end.relation, end.layer]))
    }
  }

  /**
   * One block of an already filtered and sorted list, made ready to show: a
   * copy of each entity, with who points at it and the layer each value won
   * from when asked. The list itself is left as it was, so a kept listing is
   * never changed by the block cut from it.
   */
  async dress(list: Entity[], opts: { incoming?: boolean; layers?: boolean; view?: View; peek?: { most: number; whole: readonly string[] } }): Promise<Entity[]> {
    let page = list.map(copyOf)
    if (opts.incoming) {
      for (const e of page) {
        delete e.incomingRefs
        delete e.incomingCount
      }
      await this.attachIncoming(page, opts.peek)
    }
    if (opts.layers) await this.attachLayers(page, await this.rowsFor(page))
    if (opts.view && !opts.view.all) page = opts.view.entities(page)
    return page
  }

  async rowsFor(refs: EntityRef[], values = true): Promise<EntityRow[]> {
    if (!refs.length) return []
    const rows = await this.db.query<EntityRow>(`SELECT ${values ? '*' : WHO_ONLY} FROM entities WHERE (blueprint, key) IN (SELECT * FROM unnest($1::text[], $2::text[])) AND state <> 'deleted'`, [refs.map((r) => r.blueprint), refs.map((r) => r.key)])
    return rows.rows
  }

  /** The title of each entity that is still there, by id, in one statement. One that is gone has no entry. The caller's view decides which of them it may name. */
  async titlesOf(refs: EntityRef[]): Promise<Map<string, string>> {
    const out = new Map<string, string>()
    if (!refs.length) return out
    const rows = await this.db.query<{ blueprint: string; key: string; title: string }>(`SELECT blueprint, key, title FROM entities WHERE (blueprint, key) IN (SELECT * FROM unnest($1::text[], $2::text[])) AND state <> 'deleted'`, [refs.map((r) => r.blueprint), refs.map((r) => r.key)])
    for (const r of rows.rows) out.set(entityId(r), r.title)
    return out
  }

  /** Resolved outgoing relations per entity id, following layer precedence. */
  async outgoing(rows: EntityRef[]): Promise<Map<string, RelationEnd[]>> {
    const out = new Map<string, RelationEnd[]>()
    if (!rows.length) return out
    const rels = await this.db.query<RelationRow>(
      `SELECT * FROM relations WHERE (blueprint, key) IN (SELECT * FROM unnest($1::text[], $2::text[])) AND (blueprint, relation) IN (SELECT * FROM unnest($3::text[], $4::text[]))`,
      [rows.map((r) => r.blueprint), rows.map((r) => r.key), ...this.blueprints.definedRelations()],
    )
    const grouped = new Map<string, RelationRow[]>()
    for (const r of rels.rows) {
      const k = `${r.blueprint}:${r.key}|${r.relation}`
      grouped.set(k, [...(grouped.get(k) ?? []), r])
    }
    const targets = new Map<string, EntityRef>()
    const winners = new Map<string, RelationRow[]>()
    for (const [k, group] of grouped) {
      const layer = winningLayer(group.map((g) => g.layer))
      // Two sources may hold the same link at one layer; it is one end.
      const rowsAtTop = [...new Map(group.filter((g) => g.layer === layer).map((g) => [`${g.target_blueprint}:${g.target_key}`, g])).values()]
      winners.set(k, rowsAtTop)
      for (const r of rowsAtTop) targets.set(`${r.target_blueprint}:${r.target_key}`, { blueprint: r.target_blueprint, key: r.target_key })
    }
    const info = await this.targetInfo([...targets.values()])
    for (const [k, group] of winners) {
      const first = group[0]!
      const id = `${first.blueprint}:${first.key}`
      const bp = this.blueprints.get(first.blueprint)
      const def = bp?.relations[first.relation]
      for (const r of group) {
        const tid = `${r.target_blueprint}:${r.target_key}`
        const t = info.get(tid)
        out.set(id, [
          ...(out.get(id) ?? []),
          {
            relation: r.relation,
            declaredOn: r.blueprint,
            target: { blueprint: r.target_blueprint, key: r.target_key },
            targetTitle: t?.title ?? null,
            targetIcon: t?.icon ?? null,
            pending: !t,
            dangling: !!t && t.state !== 'active',
            title: def?.title ?? r.relation,
            display: def?.display ?? 'link',
            layer: r.layer as Layer,
          },
        ])
      }
      void k
    }
    return out
  }

  /** The title and the picture of each entity still there, by id, in one statement, as a row beside another draws them. The caller's view decides which it may name. */
  async headsOf(refs: EntityRef[]): Promise<Map<string, { title: string; icon: string | null }>> {
    const out = new Map<string, { title: string; icon: string | null }>()
    for (const [id, t] of await this.targetInfo(refs)) if (t.state !== 'deleted') out.set(id, { title: t.title, icon: iconOf(t.icon, this.blueprints.get(id.slice(0, id.indexOf(':'))), this.looks) })
    return out
  }

  private async targetInfo(refs: EntityRef[]): Promise<Map<string, TargetInfo>> {
    const map = new Map<string, TargetInfo>()
    if (!refs.length) return map
    const rows = await this.db.query<{ blueprint: string; key: string; title: string; state: EntityState; icon: string | null }>(`SELECT e.blueprint, e.key, e.title, e.state, d.icon FROM entities e LEFT JOIN derived d ON d.blueprint = e.blueprint AND d.key = e.key WHERE (e.blueprint, e.key) IN (SELECT * FROM unnest($1::text[], $2::text[]))`, [
      refs.map((r) => r.blueprint),
      refs.map((r) => r.key),
    ])
    for (const r of rows.rows) map.set(`${r.blueprint}:${r.key}`, { title: r.title, state: r.state, icon: r.icon })
    return map
  }

  /**
   * A blueprint's active and missing entities, hidden ones too, with their
   * stored values alone: no relations, derived fields, or status beyond their
   * own. What a relation rule reads when it matches on a stored value.
   */
  async stored(blueprint: string): Promise<Entity[]> {
    const res = await this.db.query<EntityRow>(`SELECT * FROM entities WHERE blueprint = $1 AND state IN ('active', 'missing') ORDER BY title, key`, [blueprint])
    return res.rows.map((row) => this.shallow(row, [], null))
  }

  /**
   * Rows to entities: fields, relations, derived fields, status. Derived
   * fields read other entities' derived fields, so everything a path reaches
   * is loaded first, then computed in dependency order.
   */
  async materialize(rows: EntityRow[]): Promise<Entity[]> {
    return (await this.compute_(rows)).entities
  }

  /**
   * `materialize`, with what each base entity read, and when its values
   * next change on their own: what the deriver stores, so a change to any
   * of the first re-derives the entity, and the second does too as it comes.
   */
  async derivation(rows: EntityRow[]): Promise<Derivation> {
    return this.compute_(rows)
  }

  private async compute_(rows: EntityRow[]): Promise<Derivation> {
    const reads: Reads = new Map()
    const expires = new Map<string, number>()
    const pointed = new Map<string, string>()
    if (!rows.length) return { entities: [], reads, expires, pointed }
    const signals: Signals | null = this.providers ? { results: new Map(), alerts: new Map() } : null
    const pass: Pass = { signals, borrow: true, known: new Map(), absent: new Set(), incoming: new Map(), along: new Map(), ends: new Map(), narrow: new Map(), through: new Map(), gathered: new Set(), computed: new Set(), bare: null, values: true, present: true, history: new Map(), now: Date.now(), reads, expires, model: this.modelStamp() }
    const base = await this.load(pass, rows)
    await this.gather(pass, base)
    await this.readHistory(pass)
    for (const e of base) this.compute(pass, e)
    // Who points at an entity is in no stored value, so where a path of another blueprint steps through it that way, it is kept beside the row.
    const watched = base.filter((e) => this.wanted().parts.get(e.blueprint)?.has(PART.pointed))
    await this.needIncoming(pass, watched)
    for (const e of watched) pointed.set(e.id, pointers(pass.incoming.get(e.id) ?? []))
    return { entities: base, reads, expires, pointed }
  }

  /** The entities at the end of a relation path from each of `refs`, by the starting entity's id. */
  async follow(refs: EntityRef[], path: string): Promise<Map<string, Entity[]>> {
    return (await this.followAll(refs, [path])).get(path)!
  }

  /**
   * `follow` for several paths at once, by path. They walk side by side in
   * one pass, so what two paths share (who points at a team every path
   * starts from, an entity two of them reach) is read once. What a path
   * reaches carries its fields, not its relations.
   */
  async followAll(refs: EntityRef[], paths: string[]): Promise<Map<string, Map<string, Entity[]>>> {
    return this.walkFrom(refs, paths, true)
  }

  /**
   * The links by which entities of `blueprint` name, through one of
   * `relations`, an entity of a blueprint in `blueprints` or one of `ids`:
   * what is about something a reader sees, with what it is about, so one read
   * serves many readers. Only ids are read.
   */
  async aboutLinks(blueprint: string, relations: string[], blueprints: string[], ids: string[]): Promise<AboutLink[]> {
    if (!relations.length || (!blueprints.length && !ids.length)) return []
    const rows = await this.db.query<AboutLink>(
      `SELECT DISTINCT r.blueprint || ':' || r.key AS id, r.target_blueprint AS "targetBlueprint", r.target_blueprint || ':' || r.target_key AS target
       FROM relations r JOIN entities e ON e.blueprint = r.blueprint AND e.key = r.key
       WHERE r.blueprint = $1 AND r.relation = ANY($2::text[]) AND e.state <> 'deleted'
         AND (r.target_blueprint = ANY($3::text[]) OR (r.target_blueprint || ':' || r.target_key) = ANY($4::text[]))`,
      [blueprint, relations, blueprints, ids],
    )
    return rows.rows
  }

  /**
   * The ids at the end of each path from each of `refs`, by path and then by
   * the starting entity's id. It reads no entity's values, only that it is
   * there and how it relates: what a person owns is thousands of entities,
   * and only who they are is asked.
   */
  async reachAll(refs: EntityRef[], paths: string[], opts: { present?: boolean } = {}): Promise<Map<string, Map<string, string[]>>> {
    const walked = await this.walkFrom(refs, paths, false, opts.present ?? false)
    return new Map([...walked].map(([path, byStart]) => [path, new Map([...byStart].map(([id, ends]) => [id, ends.map((e) => e.id)]))]))
  }

  private async walkFrom(refs: EntityRef[], paths: string[], values: boolean, present = false): Promise<Map<string, Map<string, Entity[]>>> {
    const pass: Pass = { signals: null, borrow: false, known: new Map(), absent: new Set(), incoming: new Map(), along: new Map(), ends: new Map(), narrow: new Map(), through: new Map(), gathered: new Set(), computed: new Set(), bare: new Set(), values, present, history: new Map(), now: Date.now(), reads: new Map(), expires: new Map(), model: this.modelStamp() }
    const loaded = await this.load(pass, await this.rowsFor(refs))
    const unique = [...new Set(paths)]
    await this.walk(pass, unique.flatMap((path) => loaded.map((entity) => ({ entity, path }))))
    return new Map(unique.map((path) => [path, new Map(loaded.map((e) => [e.id, pass.ends.get(endsKey(e, path)) ?? []]))]))
  }

  private async load(pass: Pass, rows: EntityRow[]): Promise<Entity[]> {
    const outgoing = pass.bare ? new Map<string, RelationEnd[]>() : await this.outgoing(rows)
    if (pass.signals) await this.signal(pass.signals, rows)
    return rows.map((row) => {
      const e = this.shallow(row, outgoing.get(`${row.blueprint}:${row.key}`) ?? [], pass.signals)
      pass.known.set(e.id, e)
      pass.bare?.add(e.id)
      return e
    })
  }

  /** Reads the check results and firing alerts of these rows into the pass: only theirs, so a pass costs what it works out and not what the estate holds. */
  private async signal(signals: Signals, rows: EntityRow[]): Promise<void> {
    if (!this.providers || !rows.length) return
    const checked = rows.filter((r) => Object.values(this.blueprints.get(r.blueprint)?.fields ?? {}).some((f) => f.type === 'healthcheck'))
    const [results, alerts] = await Promise.all([checked.length ? this.providers.checks.results(checked) : null, this.providers.alerts.byEntity(rows)])
    for (const [id, list] of results ?? []) signals.results.set(id, list)
    for (const [id, list] of alerts) signals.alerts.set(id, list)
  }

  /** Reads the relations of the bare entities among these, before a walk steps out along them. */
  private async relate(pass: Pass, entities: Entity[]): Promise<void> {
    const bare = pass.bare
    if (!bare) return
    const todo = [...new Map(entities.filter((e) => bare.has(e.id)).map((e) => [e.id, e])).values()]
    if (!todo.length) return
    const outgoing = await this.outgoing(todo)
    for (const e of todo) {
      bare.delete(e.id)
      for (const end of outgoing.get(e.id) ?? []) (e.relations[end.relation] ??= []).push(named(end))
    }
  }

  private async need(pass: Pass, refs: EntityRef[]): Promise<void> {
    const missing = new Map<string, EntityRef>()
    for (const r of refs) {
      const id = entityId(r)
      if (!pass.known.has(id) && !pass.absent.has(id)) missing.set(id, r)
    }
    if (!missing.size) return
    // A walk that borrows nothing reads only the stored rows: the derived rows beside them are the largest part of a read, and unused.
    if (!pass.borrow) {
      await this.load(pass, await this.rowsFor([...missing.values()], pass.values))
      for (const id of missing.keys()) if (!pass.known.has(id)) pass.absent.add(id)
      return
    }
    // A neighbour whose derived row is stored and current is complete, derived fields and all: it is borrowed, not read
    // and derived again. So its layers are read only where it must be derived, in the same statement.
    const rows = await this.neighboursFor([...missing.values()])
    const stale = this.staleness()
    const cold: EntityRow[] = []
    const unread: EntityRef[] = []
    for (const row of rows) {
      if (!stale(row)) {
        const e = hydrate(row, row.derived!, this.blueprints.get(row.blueprint), this.looks, this.seenAt(row))
        this.live(e)
        pass.known.set(e.id, e)
        pass.gathered.add(e.id)
        pass.computed.add(e.id)
      } else if (row.pushed) cold.push(row as EntityRow)
      else unread.push(row)
    }
    await this.load(pass, [...cold, ...(await this.rowsFor(unread))])
    for (const id of missing.keys()) if (!pass.known.has(id)) pass.absent.add(id)
  }

  /**
   * Loads the ends a path reads only stored values of with those values
   * alone: who each is, its state and status, and the named fields of its
   * stored row, never its relations or the rest of its fields. One whose
   * stored row is not current, or that is loaded whole already, is read
   * whole by `need`, so a value is never read from a row that is behind.
   */
  private async needNarrow(pass: Pass, asked: { ref: EntityRef; names: string[] }[]): Promise<void> {
    const names = new Map<string, { ref: EntityRef; names: Set<string> }>()
    for (const { ref, names: n } of asked) {
      const id = entityId(ref)
      if (pass.known.has(id) || pass.absent.has(id)) continue
      const had = pass.narrow.get(id)
      if (had && n.every((x) => had.names.has(x))) continue
      const want = names.get(id) ?? { ref, names: new Set(had?.names ?? []) }
      for (const x of n) want.names.add(x)
      names.set(id, want)
    }
    if (!names.size) return
    const wanted = [...names.values()]
    const all = [...new Set(wanted.flatMap((w) => [...w.names]))]
    const kinds = [...new Set(wanted.map((w) => w.ref.blueprint))]
    const rows = await this.db.query<EntityHead & { derived_at: Date | null; icon: string | null; level: StatusLevel | null; reasons: StoredReason[] | null; picked: Record<string, unknown> | null; before: Date | null }>(
      `SELECT ${HEAD.split(', ').map((c) => `e.${c}`).join(', ')}, d.derived_at, d.icon, d.level, d.reasons, s.before,
              (SELECT jsonb_object_agg(n, d.fields -> n) FROM unnest($3::text[]) AS n WHERE d.fields ? n) AS picked
       ${JOIN} LEFT JOIN unnest($4::text[], $5::timestamptz[]) AS s(blueprint, before) ON s.blueprint = e.blueprint
       WHERE (e.blueprint, e.key) IN (SELECT * FROM unnest($1::text[], $2::text[])) AND e.state <> 'deleted'`,
      [wanted.map((w) => w.ref.blueprint), wanted.map((w) => w.ref.key), all, kinds, kinds.map((b) => this.staleBefore(b)?.toISOString() ?? null)],
    )
    const whole: EntityRef[] = []
    const found = new Set<string>()
    for (const row of rows.rows) {
      const id = entityId(row)
      found.add(id)
      const at = row.derived_at?.getTime()
      if (at === undefined || at <= row.updated_at.getTime() || (row.before && at <= row.before.getTime())) {
        whole.push(row)
        continue
      }
      const asked = names.get(id)!.names
      const fields: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(row.picked ?? {})) if (asked.has(k)) fields[k] = v
      const e = hydrate(row, { fields, relations: {}, icon: row.icon, level: row.level ?? 'grey', reasons: row.reasons ?? [], levels: null, derived_at: row.derived_at!, expires_at: null }, this.blueprints.get(row.blueprint), this.looks, this.seenAt(row))
      this.live(e)
      pass.narrow.set(id, { entity: e, names: asked })
    }
    for (const id of names.keys()) if (!found.has(id)) pass.absent.add(id)
    await this.need(pass, whole)
  }

  /**
   * Who points at each entity along each incoming hop asked of it, in one
   * statement, read only where neither that nor every link into the entity
   * is read yet: the links of each hop's relation, from the one blueprint it
   * names or every blueprint that defines it.
   */
  private async needAlong(pass: Pass, asked: { e: Entity; hop: Hop }[]): Promise<void> {
    const wanted = new Map<string, { e: Entity; hop: Hop }>()
    for (const a of asked) {
      const k = alongKey(a.e.id, a.hop)
      if (!pass.incoming.has(a.e.id) && !pass.along.has(k)) wanted.set(k, a)
    }
    if (!wanted.size) return
    // The blueprints each hop takes its links from: the one it names, or every one that defines its relation.
    const from = new Map<string, string[]>()
    const takers = (hop: Hop): string[] => {
      let ids = from.get(hopKey(hop))
      if (!ids) from.set(hopKey(hop), (ids = this.blueprints.list().filter((bp) => !!bp.relations[hop.relation] && (!hop.from || bp.id === hop.from)).map((bp) => bp.id)))
      return ids
    }
    const cols: [string[], string[], string[], string[]] = [[], [], [], []]
    const pairs = new Set<string>()
    for (const { e, hop } of wanted.values()) {
      pass.along.set(alongKey(e.id, hop), [])
      for (const bp of takers(hop)) {
        const pair = `${e.id}\n${bp}\n${hop.relation}`
        if (pairs.has(pair)) continue
        pairs.add(pair)
        cols[0].push(e.blueprint)
        cols[1].push(e.key)
        cols[2].push(bp)
        cols[3].push(hop.relation)
      }
    }
    if (!cols[0].length) return
    const found = await this.incomingAlong(cols, pass.values)
    // Each link found goes to every hop asked of its entity that steps along it.
    for (const { e, hop } of wanted.values()) {
      const ends = found.get(e.id)
      if (ends) pass.along.set(alongKey(e.id, hop), ends.filter((i) => i.relation === hop.relation && (!hop.from || i.declaredOn === hop.from)))
    }
  }

  /** Who points at `e` along one incoming hop: from every link into it where those are read, else from the hop's own read. */
  private along(pass: Pass, e: Entity, hop: Hop): Inward[] {
    const all = pass.incoming.get(e.id)
    if (all) return all.filter((i) => i.relation === hop.relation && (!hop.from || i.declaredOn === hop.from))
    return pass.along.get(alongKey(e.id, hop)) ?? []
  }

  private async needIncoming(pass: Pass, entities: Entity[]): Promise<void> {
    const missing = entities.filter((e) => !pass.incoming.has(e.id))
    if (!missing.length) return
    for (const [id, ends] of await this.incomingFor(missing)) pass.incoming.set(id, ends)
  }

  private hops(path: string): Hop[] {
    let hops = this.paths.get(path)
    if (!hops) {
      try {
        hops = parsePath(path)
      } catch {
        hops = []
      }
      this.paths.set(path, hops)
    }
    return hops
  }

  /**
   * The keys of `incomingRefs` a scorecard rule on `blueprint` reads whole,
   * by asking whether one named entity points here. A view that sends only
   * the first few of who points at a row sends these in full, so the rule
   * reads the same wherever it is checked.
   */
  wholeIncoming(blueprint: string): Set<string> {
    const out = new Set<string>()
    for (const sc of this.scorecards.forBlueprint(blueprint)) {
      for (const part of partsOf(sc)) {
        if (part.blueprint !== blueprint) continue
        for (const leaf of partFilters(part).flatMap(pointedFrom)) {
          const [hop] = this.hops(leaf.relation)
          if (!hop) continue
          for (const other of this.blueprints.list()) if (other.relations[hop.relation]?.target === blueprint && (!hop.from || hop.from === other.id)) out.add(`${other.id}.${hop.relation}`)
        }
      }
    }
    return out
  }

  /**
   * The incoming relations a grid of `blueprint` carries whole for one
   * reader: those a scorecard asks who points by name (`wholeIncoming`), and
   * those from a blueprint the reader sees one entity at a time, whose links
   * the view keeps one by one and counts by what is left.
   */
  peekWhole(asked: string, view: View | undefined): string[] {
    const blueprint = this.blueprints.resolve(asked)
    const out = this.wholeIncoming(blueprint)
    if (view && !view.all) {
      for (const bp of this.blueprints.list()) {
        if (view.seesBlueprint(bp.id) || !view.oneByOne(bp.id)) continue
        for (const [name, def] of Object.entries(bp.relations)) if (def.target === blueprint) out.add(`${bp.id}.${name}`)
      }
    }
    return [...out]
  }

  /** The blueprints whose grid rows show an entity of `id` beside them: those with a relation to it, and those it has a relation to. */
  beside(id: string): string[] {
    const out = new Set<string>()
    for (const def of Object.values(this.blueprints.get(id)?.relations ?? {})) out.add(def.target)
    for (const other of this.blueprints.list()) if (Object.values(other.relations).some((r) => r.target === id)) out.add(other.id)
    return [...out]
  }

  /** The id a blueprint goes by now, or null when the model holds none by that name. */
  known(id: string): string | null {
    const now = this.blueprints.resolve(id)
    return this.blueprints.get(now) ? now : null
  }

  /**
   * Every blueprint whose values can move a list of `id`: its own, and
   * everything its derived fields, status, and scorecards read. What a grid
   * shows beside a row of another blueprint is only its title, which changes
   * with a title event, not with this. Null when that cannot be told, so the
   * list is read again on any change.
   */
  readsFor(id: string): ReadonlySet<string> | null {
    const kept = this.standing().reads
    let reads = kept.get(id)
    if (reads === undefined) kept.set(id, (reads = this.reach(id)))
    return reads
  }

  /** What is kept of the model, started again when a blueprint, the layout, or a scorecard has changed since. */
  private standing(): Reader['model'] {
    const at = `${this.blueprints.revision()}:${this.scorecards.revision()}`
    if (this.model.at !== at) this.model = { at, reads: new Map(), stamp: null, wanted: null }
    return this.model
  }

  private reach(id: string): Set<string> | null {
    const out = new Set<string>()
    const all = this.blueprints.list()
    const visit = (bpId: string): boolean => {
      if (out.has(bpId)) return true
      out.add(bpId)
      const bp = this.blueprints.get(bpId)
      if (!bp) return true
      // A scorecard that asks who points at an entity reads every blueprint with a relation to it.
      if (this.scorecards.forBlueprint(bpId).some(scorecardUsesIncoming)) {
        for (const other of all) if (Object.values(other.relations).some((r) => r.target === bpId)) out.add(other.id)
      }
      for (const path of this.plan(bp).paths) {
        let at = new Set([bpId])
        const hops = this.hops(path)
        if (!hops.length) return false
        for (const hop of hops) {
          at = this.step(at, hop)
          for (const b of at) if (!visit(b)) return false
        }
      }
      return true
    }
    if (!visit(id)) return null
    return out
  }

  /** The blueprints one hop leads to from any of `at`. */
  private step(at: ReadonlySet<string>, hop: Hop): Set<string> {
    const next = new Set<string>()
    for (const other of this.blueprints.list()) {
      const def = other.relations[hop.relation]
      if (!def) continue
      if (hop.incoming) {
        if (at.has(def.target) && (!hop.from || hop.from === other.id)) next.add(other.id)
      } else if (at.has(other.id)) next.add(def.target)
    }
    return next
  }

  /**
   * The parts of other blueprints' stored rows the derived fields and status
   * of `id` read, by blueprint: the field a mirror shows, the fields an
   * aggregation and its `where` read, the status a rollup takes, and from
   * what a longer path steps through, where it steps next. Null when a path
   * cannot be read, so the blueprint follows every change.
   */
  private needs(bp: Blueprint): Map<string, Set<string>> | null {
    const out = new Map<string, Set<string>>()
    const uses: { path: string; parts: string[] }[] = (bp.status?.relations ?? []).map((path) => ({ path, parts: [PART.status] }))
    for (const def of Object.values(bp.fields)) {
      if (def.mirror) {
        const { path, field } = splitMirror(def.mirror)
        uses.push({ path, parts: partsOfField(field) })
      } else if (def.aggregation) {
        const { relation, field, where, window } = def.aggregation
        uses.push({ path: relation, parts: [...(field ? partsOfField(field) : []), ...(window ? partsOfField(window.field) : []), ...(where ? partsOfFilter(where) : [])] })
      }
    }
    for (const use of uses) {
      const hops = this.hops(use.path)
      if (!hops.length) return null
      let at: Set<string> = new Set([bp.id])
      for (const [i, hop] of hops.entries()) {
        at = this.step(at, hop)
        const after = hops[i + 1]
        // At the end, what the field reads. On the way, what decides where the path goes next: the entity's relations, or who points at it.
        const parts = after ? [after.incoming ? PART.pointed : PART.relations] : use.parts
        for (const b of at) {
          let set = out.get(b)
          if (!set) out.set(b, (set = new Set()))
          for (const part of parts) set.add(part)
        }
      }
    }
    return out
  }

  /** `needs` of every blueprint, turned around: per blueprint and part, the blueprints that read it. */
  private wanted(): Wanted {
    const kept = this.standing()
    if (kept.wanted) return kept.wanted
    const wanted: Wanted = { parts: new Map(), every: [] }
    for (const bp of this.blueprints.list()) {
      const needs = this.needs(bp)
      if (!needs) {
        wanted.every.push(bp.id)
        continue
      }
      for (const [read, parts] of needs) {
        let by = wanted.parts.get(read)
        if (!by) wanted.parts.set(read, (by = new Map()))
        for (const part of parts) {
          const readers = by.get(part)
          if (readers) readers.add(bp.id)
          else by.set(part, new Set([bp.id]))
        }
      }
    }
    return (kept.wanted = wanted)
  }

  /**
   * The blueprints whose entities must be derived again when these parts of
   * a stored row of `blueprint` moved. One that only shows the entity beside
   * its own rows, by title, is not among them: nothing it shows is in the row.
   */
  readersOf(blueprint: string, moved: ReadonlySet<string>): string[] {
    const { parts, every } = this.wanted()
    const out = new Set(every)
    const by = parts.get(blueprint)
    if (by) for (const [part, readers] of by) if (part === PART.any || moved.has(part)) for (const r of readers) out.add(r)
    return [...out]
  }

  private plan(bp: Blueprint): Plan {
    const cached = this.plans.get(bp.id)
    if (cached?.at === bp.updatedAt) return cached.plan
    const paths = new Set<string>(bp.status?.relations ?? [])
    const incomingWhere = new Set<string>()
    for (const def of Object.values(bp.fields)) {
      if (def.mirror) paths.add(splitMirror(def.mirror).path)
      else if (def.aggregation) {
        paths.add(def.aggregation.relation)
        if (def.aggregation.where && usesIncoming(def.aggregation.where)) incomingWhere.add(def.aggregation.relation)
      }
    }
    // What each path reads of its ends: null once one use of it needs them whole.
    const reads = new Map<string, Set<string> | null>()
    const want = (path: string, names: string[] | null) => {
      const had = reads.get(path)
      if (had === null) return
      if (names === null) return void reads.set(path, null)
      reads.set(path, new Set([...(had ?? []), ...names]))
    }
    for (const path of bp.status?.relations ?? []) want(path, null)
    for (const path of incomingWhere) want(path, null)
    for (const def of Object.values(bp.fields)) {
      if (def.mirror) {
        const { path, field } = splitMirror(def.mirror)
        want(path, [field])
      } else if (def.aggregation) {
        const { relation, field, where, window } = def.aggregation
        const named = where ? valueNames(where) : []
        want(relation, named === null ? null : [...(field ? [field] : []), ...(window ? [window.field] : []), ...named])
      }
    }
    const narrow = new Map<string, string[]>()
    for (const [path, names] of reads) if (names) narrow.set(path, [...names].map((n) => (n.startsWith('fields.') ? n.slice(7) : n)).filter((n) => !n.startsWith('$')))
    const plan = { paths: [...paths], incomingWhere: [...incomingWhere], narrow }
    this.plans.set(bp.id, { at: bp.updatedAt, plan })
    return plan
  }

  /**
   * The paths of a blueprint whose ends must be derived before its own
   * derived fields and status are: every status path, and any path a mirror
   * or an aggregation reads a derived value, a level, or the whole entity
   * through. A path read only for a count or a stored value is not deep.
   */
  private deep(bp: Blueprint, model: string): Set<string> {
    // What is deep reads other blueprints' fields too, so the answer holds only for the model as a whole as it stood.
    const hit = this.deepPaths.get(bp.id)
    if (hit && hit.model === model) return hit.paths
    const out = new Set<string>(bp.status?.relations ?? [])
    for (const def of Object.values(bp.fields)) {
      if (def.mirror) {
        const { path, field } = splitMirror(def.mirror)
        if (!this.storedAt(bp.id, path, [field])) out.add(path)
      } else if (def.aggregation) {
        const { relation, field, where, window } = def.aggregation
        const read = [...(field ? [field] : []), ...(window ? [window.field] : [])]
        if (!this.storedAt(bp.id, relation, read) || (where && !storedOnly(where, (f) => this.storedAt(bp.id, relation, [f])))) out.add(relation)
      }
    }
    this.deepPaths.set(bp.id, { model, paths: out })
    return out
  }

  /** The model as it stands, as one string: every blueprint's last change. */
  private modelStamp(): string {
    const kept = this.standing()
    return (kept.stamp ??= this.blueprints.list().map((b) => `${b.id}@${b.updatedAt}`).join('\n'))
  }

  /** Whether each of `fields` is a stored value on every blueprint `path` can end at from `from`. False when that cannot be told. */
  private storedAt(from: string, path: string, fields: string[]): boolean {
    const hops = this.hops(path)
    if (!hops.length) return false
    let at = new Set([from])
    for (const hop of hops) at = this.step(at, hop)
    for (const id of at) {
      const bp = this.blueprints.get(id)
      for (const f of fields) {
        const def = bp?.fields[f.startsWith('fields.') ? f.slice(7) : f]
        if (def && isDerived(def)) return false
      }
    }
    return true
  }

  /** Follows every path from every start, one hop at a time for all of them at once, so a hop costs a few queries however many entities take it. */
  private async walk(pass: Pass, starts: { entity: Entity; path: string; narrow?: string[] | null }[]): Promise<void> {
    const walkers = starts.map((s) => ({ key: endsKey(s.entity, s.path), hops: this.hops(s.path), at: [s.entity], through: [] as Entity[], narrow: s.narrow ?? null }))
    for (const w of walkers) if (!w.hops.length) w.at = []
    for (let depth = 0; ; depth++) {
      const live = walkers.filter((w) => w.hops.length > depth)
      if (!live.length) break
      // Each incoming hop reads only the links it steps along: one statement for every entity and hop of this step.
      await this.needAlong(pass, live.flatMap((w) => (w.hops[depth]!.incoming ? w.at.map((e) => ({ e, hop: w.hops[depth]! })) : [])))
      await this.relate(pass, live.filter((w) => !w.hops[depth]!.incoming).flatMap((w) => w.at))
      const next = live.map((w) => {
        const hop = w.hops[depth]!
        const refs = new Map<string, EntityRef>()
        for (const e of w.at) {
          const targets = hop.incoming ? this.along(pass, e, hop).map((i) => i.target) : (e.relations[hop.relation] ?? [])
          for (const t of targets) refs.set(entityId(t), t)
        }
        return [...refs.values()]
      })
      // A path's last hop, where it reads only stored values of its ends, loads only those; every other step loads whole.
      const last = (w: (typeof live)[number]) => !!w.narrow && w.hops.length === depth + 1
      await this.need(pass, live.flatMap((w, i) => (last(w) ? [] : next[i]!)))
      const narrowed = live.flatMap((w, i) => (last(w) ? next[i]!.map((ref) => ({ ref, names: w.narrow! })) : []))
      await this.needNarrow(pass, narrowed)
      live.forEach((w, i) => {
        const found = next[i]!.map((r) => pass.known.get(entityId(r)) ?? (last(w) ? pass.narrow.get(entityId(r))?.entity : undefined)).filter((x): x is Entity => !!x)
        w.at = pass.present ? found.filter((e) => e.state === 'active') : found
        if (w.at.length < found.length) w.through.push(...found.filter((e) => e.state !== 'active'))
        if (w.hops.length > depth + 1) w.through.push(...w.at)
      })
    }
    for (const w of walkers) {
      pass.ends.set(w.key, w.at)
      if (w.through.length) pass.through.set(w.key, w.through)
    }
  }

  /** Reads the history points every trend read from history needs, for every entity the pass will compute: one query per blueprint and field. */
  private async readHistory(pass: Pass): Promise<void> {
    const byBlueprint = new Map<string, Entity[]>()
    for (const e of pass.known.values()) {
      if (pass.computed.has(e.id)) continue
      let list = byBlueprint.get(e.blueprint)
      if (!list) byBlueprint.set(e.blueprint, (list = []))
      list.push(e)
    }
    for (const [id, entities] of byBlueprint) {
      const bp = this.blueprints.get(id)
      if (!bp) continue
      for (const [name, def] of Object.entries(bp.fields)) {
        if (!isTrendHistory(def.history)) continue
        const series = await seriesFor(this.db, id, def.history.of, entities.map((e) => e.key), new Date(pass.now - parseDuration(def.history.last)))
        for (const e of entities) pass.history.set(historyKey(e, name), series.get(e.key) ?? [])
      }
    }
  }

  /** Loads everything the derived fields of `entities` read, and everything those read in turn. */
  private async gather(pass: Pass, entities: Entity[]): Promise<void> {
    const todo = entities.filter((e) => !pass.gathered.has(e.id))
    if (!todo.length) return
    const starts: { entity: Entity; path: string; deep: boolean; narrow: string[] | null }[] = []
    const filtered: string[] = []
    const scoredByIncoming: Entity[] = []
    for (const e of todo) {
      pass.gathered.add(e.id)
      if (this.scorecards.forBlueprint(e.blueprint).some(scorecardUsesIncoming)) scoredByIncoming.push(e)
      const bp = this.blueprints.get(e.blueprint)
      if (!bp) continue
      const plan = this.plan(bp)
      for (const path of plan.paths) {
        const deep = this.deep(bp, pass.model).has(path)
        starts.push({ entity: e, path, deep, narrow: deep || !pass.values || !pass.borrow ? null : (plan.narrow.get(path) ?? null) })
      }
      for (const path of plan.incomingWhere) filtered.push(endsKey(e, path))
    }
    await this.needIncoming(pass, scoredByIncoming)
    if (!starts.length) return
    await this.walk(pass, starts)
    const asked = filtered.flatMap((k) => pass.ends.get(k) ?? [])
    if (asked.length) {
      await this.needIncoming(pass, asked)
      for (const e of asked) e.incomingRefs ??= refsOf(pass.incoming.get(e.id) ?? [])
    }
    // Only an end whose own derived values are read is derived in turn: one only counted, or read for a stored value, stays as it was read.
    const reached = new Map<string, Entity>()
    for (const s of starts) if (s.deep) for (const e of pass.ends.get(endsKey(s.entity, s.path)) ?? []) reached.set(e.id, e)
    await this.gather(pass, [...reached.values()])
  }

  /** Mirrors, aggregations, calculations, and the status rollup of one entity, after those of everything it reads. */
  private compute(pass: Pass, e: Entity): void {
    // An entity met again further down its own chain is read as it stands: that is what ends a cycle.
    if (pass.computed.has(e.id)) return
    pass.computed.add(e.id)
    const bp = this.blueprints.get(e.blueprint)
    if (!bp) return
    const at = (path: string): Entity[] => pass.ends.get(endsKey(e, path)) ?? []
    // What this entity read: every end of every path and what the path stepped through, its relation targets (title
    // and state are embedded, pending or not), and who points at it when a scorecard asks. A change to any of these
    // derives it again, when it is to a part this blueprint reads.
    const read = new Set<string>()
    for (const path of this.plan(bp).paths) for (const n of [...at(path), ...(pass.through.get(endsKey(e, path)) ?? [])]) read.add(n.id)
    for (const targets of Object.values(e.relations)) for (const t of targets) read.add(entityId(t))
    if (this.scorecards.forBlueprint(e.blueprint).some(scorecardUsesIncoming)) for (const i of pass.incoming.get(e.id) ?? []) read.add(entityId(i.target))
    read.delete(e.id)
    pass.reads.set(e.id, read)
    for (const path of this.deep(bp, pass.model)) for (const n of at(path)) this.compute(pass, n)
    // When a value of this entity next changes because time passes: the end of a trend's span, an entity entering or
    // leaving a window, an age crossing a span, the hour for a calculation of the time. The earliest is kept with the row.
    const soon: (number | null)[] = []
    // A trend read from history reads only stored points, so it comes first and anything after may read it.
    for (const [name, def] of Object.entries(bp.fields)) {
      if (!isTrendHistory(def.history)) continue
      const of = bp.fields[def.history.of]
      const points = pass.history.get(historyKey(e, name))
      e.fields[name] = of && points ? trendOf(points, of, def.history, pass.now) : null
      soon.push(spanEnd(pass.now, parseDuration(def.history.every)))
    }
    for (const [name, def] of Object.entries(bp.fields)) {
      if (def.mirror) {
        const { path, field } = splitMirror(def.mirror)
        const [first] = at(path)
        e.fields[name] = (first && fieldOf(first, field)) ?? null
      } else if (def.aggregation) {
        const related = at(def.aggregation.relation)
        e.fields[name] = aggregate(def.aggregation, related, pass.now)
        soon.push(aggregateNext(def.aggregation, related, pass.now))
      }
    }
    // One scope for every calculation on the entity, reading its fields as they stand, so a calculation sees the ones it reads.
    const scope: Record<string, unknown> = new Proxy(e.fields, { get: (fields, name) => (name === 'key' ? e.key : name === 'title' ? e.title : fields[name as string]), has: (fields, name) => name === 'key' || name === 'title' || name in fields })
    for (const [name, calculation] of this.calculations(bp)) {
      try {
        e.fields[name] = this.expr(calculation).evaluate(scope)
      } catch {
        e.fields[name] = null
      }
      if (readsClock(calculation)) soon.push(hourEnd(pass.now))
    }
    for (const sc of this.scorecards.forBlueprint(e.blueprint)) for (const part of partsOf(sc)) for (const f of partFilters(part)) soon.push(nextChange(e, f, pass.now))
    const next = soonest(soon)
    if (next !== null) pass.expires.set(e.id, next)
    // A status field the entity calculates is known only now: it joins the status the entity reported before.
    const statusDef = bp.status?.field ? bp.fields[bp.status.field] : undefined
    if (statusDef && isDerived(statusDef)) {
      const said = fieldStatus(e, bp.status!.field!)
      if (said) e.status = { level: worst([e.status.level, said.level]), reasons: [...e.status.reasons, ...said.reasons] }
    }
    this.level(pass, e)
    if (bp.status?.relations?.length) {
      const related = new Map<string, Entity>()
      for (const path of bp.status.relations) for (const n of at(path)) related.set(n.id, n)
      related.delete(e.id)
      if (related.size) {
        const all = [...related.values()]
        const bad = all.filter((r) => r.status.level !== 'green')
        const from = new Map(rollupSources.get(e) ?? [])
        const added = bad.map((r) => {
          const reason = `${r.title}: ${r.status.reasons[0] ?? r.status.level}`
          // What fed a reason is remembered, so a reader who may not see where it came from is not told; a reason the related entity itself inherited keeps its origin.
          from.set(reason, rollupSources.get(r)?.get(r.status.reasons[0] ?? '') ?? r.blueprint)
          return reason
        })
        rollupSources.set(e, from)
        e.status = { level: worst([...all.map((r) => r.status.level), e.status.level]), reasons: [...e.status.reasons, ...added] }
      }
    }
  }

  /**
   * The levels the entity reached on each scorecard that has it in scope,
   * after its own derived fields and before anything that aggregates over it
   * reads them. Scorecards come in an order where one that reads another's
   * level follows it, so the level it reads is already here.
   */
  private level(pass: Pass, e: Entity): void {
    const cards = this.scorecards.forBlueprint(e.blueprint)
    if (!cards.length) return
    const levels: Record<string, string[]> = {}
    e.levels = levels
    // A rule that asks who points at the entity reads it from the pass; the entity itself only carries incomingRefs when its reader asked.
    const subject = cards.some(scorecardUsesIncoming) ? { ...e, incomingRefs: refsOf(pass.incoming.get(e.id) ?? []) } : e
    for (const sc of cards) {
      const row = scoreEntity(sc, subject)
      if (row) levels[sc.id] = reached(sc, row)
    }
  }

  /** Fields, relations, and own status, without looking at neighbours. */
  private shallow(row: EntityRow, ends: RelationEnd[], signals: Signals | null): Entity {
    const bp = this.blueprints.get(row.blueprint)
    const layers = layersOf(row)
    const fields: Record<string, unknown> = {}
    for (const name of fieldNames(bp, layers)) {
      if (name === TITLE_FIELD || name === ICON_FIELD) continue
      const def = bp ? this.blueprints.fieldDef(bp, name) : undefined
      if (!def && bp) continue // removed from the blueprint: kept in the row, hidden from views
      // Every field the blueprint defines is present, null when unset, so a field name never falls through to what the hub keeps about the entity.
      fields[name] = resolve(name, layers, def)?.value ?? null
    }
    const relations: Record<string, RelatedRef[]> = {}
    for (const end of ends) (relations[end.relation] ??= []).push(named(end))
    // A photo is only ever laid on by its person's picture: one written as a value names nobody's, and is no icon.
    const written = resolve(ICON_FIELD, layers, bp ? this.blueprints.fieldDef(bp, ICON_FIELD) : undefined)?.value
    const icon = isPhoto(typeof written === 'string' ? written : null) ? undefined : written
    const entity: Entity = {
      id: `${row.blueprint}:${row.key}`,
      blueprint: row.blueprint,
      key: row.key,
      title: row.title,
      icon: iconOf(typeof icon === 'string' ? icon : null, bp, this.icons),
      state: row.state,
      hidden: row.hidden,
      fields,
      relations,
      owner: row.owner,
      scope: row.scope,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      lastSeenAt: this.seenAt(row)?.toISOString() ?? null,
      missingSince: row.missing_since?.toISOString() ?? null,
      deletedAt: row.deleted_at?.toISOString() ?? null,
      status: { level: 'green', reasons: [] },
    }
    // A person entity stores its person's pick or photo as its icon, so whatever shows it beside another draws it too.
    this.pictures?.lay(entity)
    if (entity.picture) rawIcons.set(entity, entity.icon!)
    else if (typeof icon === 'string') rawIcons.set(entity, icon)
    this.live(entity)
    entity.status = this.ownStatus(entity, bp, signals)
    return entity
  }

  /**
   * What the hub knows live about its own source and runner entities, laid
   * over the stored fields: status, last run, last seen, last error. These
   * are facts about the source, kept in `sources` at most once a minute,
   * never written to the entity, so a run writes nothing and the entity's
   * row never churns. The deriver reads the same overlay, so the level
   * follows the status; a flip queues the entities (`standing` in derive.ts).
   */
  private live(e: Entity): void {
    if (!SOURCE_STANDING.includes(e.blueprint)) return
    const s = this.sources.get(e.key)
    if (!s) return
    e.fields = { ...e.fields, status: s.status, status_reason: s.statusReason, last_seen_at: s.lastSeenAt }
    if (e.blueprint === SOURCE_BLUEPRINT) e.fields = { ...e.fields, last_run_at: s.lastRunAt, last_error: s.lastError }
  }

  /**
   * Worst of: checks, attached alerts, own freshness (stale or missing is
   * grey, never green), a self-reported status field. A missing entity's
   * status field is what its source said before it stopped seeing it, so
   * only its absence counts.
   */
  private ownStatus(e: Entity, bp: Blueprint | undefined, signals: Signals | null): EntityStatus {
    const reasons: string[] = []
    let level: StatusLevel = 'green'
    if (e.state === 'missing') {
      level = 'grey'
      reasons.push(`not seen since ${e.missingSince ?? e.lastSeenAt ?? 'unknown'}`)
    }
    const greyed = this.sources.greys(e.owner)
    if (greyed !== null) {
      level = 'grey'
      reasons.push(`source ${e.owner} is ${greyed}`)
    }
    if (bp?.status?.field && e.state !== 'missing') {
      const said = fieldStatus(e, bp.status.field)
      if (said) {
        level = worst([level, said.level])
        reasons.push(...said.reasons)
      }
    }
    if (signals && bp) {
      const checks = Object.entries(bp.fields)
        .filter(([, f]) => f.type === 'healthcheck')
        .map(([field]) => ({ field, check: healthcheckSchema.safeParse(e.fields[field]) }))
        .filter((c) => c.check.success)
        .map((c) => ({ field: c.field, check: c.check.data! }))
      if (checks.length) {
        const c = checkLevel(checks, signals.results.get(e.id) ?? [])
        level = worst([level, c.level])
        reasons.push(...c.reasons)
      }
      const a = alertLevel(signals.alerts.get(e.id) ?? [])
      if (a.level !== 'green') {
        level = worst([level, a.level])
        reasons.push(...a.reasons)
      }
    }
    return { level, reasons }
  }

  private async relatedSets(filter: Filter): Promise<Map<string, Set<string>>> {
    const sets = new Map<string, Set<string>>()
    const walk = async (f: Filter): Promise<void> => {
      if ('and' in f) for (const x of f.and) await walk(x)
      else if ('or' in f) for (const x of f.or) await walk(x)
      else if ('not' in f) await walk(f.not)
      else if ('relatedTo' in f && !sets.has(f.relatedTo)) {
        const ref = parseEntityId(f.relatedTo)
        const set = new Set<string>()
        if (ref) {
          const rows = await this.db.query<{ blueprint: string; key: string }>(
            `WITH defined AS (SELECT * FROM unnest($3::text[], $4::text[]) AS d(blueprint, relation))
             SELECT blueprint, key FROM relations WHERE target_blueprint = $1 AND target_key = $2 AND (blueprint, relation) IN (SELECT * FROM defined)
             UNION SELECT target_blueprint, target_key FROM relations WHERE blueprint = $1 AND key = $2 AND (blueprint, relation) IN (SELECT * FROM defined)`,
            [ref.blueprint, ref.key, ...this.blueprints.definedRelations()],
          )
          for (const r of rows.rows) set.add(`${r.blueprint}:${r.key}`)
        }
        sets.set(f.relatedTo, set)
      }
    }
    await walk(filter)
    return sets
  }
}

/**
 * How `entities` share out each column that holds a few kinds of value: the
 * categorical fields, every relation, the state, and the source. A row with
 * many values counts once under each. A column where a row holds more than
 * `SHARED_LIST_MAX` values is left out.
 */
export function distribute(bp: Blueprint, entities: Entity[]): Record<string, ColumnDistribution> {
  const columns: Record<string, (e: Entity) => { value: string; label: string }[]> = {
    state: (e) => [{ value: e.state, label: e.state }],
    owner: (e) => [{ value: e.owner, label: e.owner }],
    status: (e) => [{ value: e.status.level, label: e.status.level }],
  }
  for (const [name, def] of Object.entries(bp.fields)) {
    if (!isSpread(def)) continue
    columns[`f:${name}`] = (e) => {
      const v = e.fields[name]
      const list = Array.isArray(v) ? v : v === null || v === undefined || v === '' ? [] : [v]
      return list.filter((x) => typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean').map((x) => ({ value: String(x), label: typeof x === 'boolean' ? (x ? 'yes' : 'no') : String(x) }))
    }
  }
  for (const name of Object.keys(bp.relations)) columns[`r:${name}`] = (e) => (e.relations[name] ?? []).map((t) => ({ value: entityId(t), label: t.title ?? t.key }))
  // What a row holds in a column before it is read as values: the list whose length decides whether the column is counted.
  const held = (e: Entity, id: string): unknown => (id.startsWith('f:') ? e.fields[id.slice(2)] : id.startsWith('r:') ? e.relations[id.slice(2)] : undefined)
  const long = (v: unknown) => Array.isArray(v) && v.length > SHARED_LIST_MAX
  const out: Record<string, ColumnDistribution> = {}
  for (const [id, valuesOf] of Object.entries(columns)) {
    if (entities.some((e) => long(held(e, id)))) continue
    const counts = new Map<string, { label: string; count: number }>()
    let none = 0
    for (const e of entities) {
      const values = valuesOf(e)
      if (!values.length) none++
      for (const { value, label } of new Map(values.map((v) => [v.value, v])).values()) {
        const bucket = counts.get(value)
        if (bucket) bucket.count++
        else counts.set(value, { label, count: 1 })
      }
    }
    // Values as common as each other make the cut in the order of their labels' bytes, as the database cuts them; what is kept is shown in a person's order.
    const bytes = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b))
    const ranked = [...counts.entries()].map(([value, b]) => ({ value: value as string | null, ...b })).sort((a, b) => b.count - a.count || bytes(a.label, b.label) || bytes(a.value!, b.value!))
    const buckets = ranked.slice(0, BUCKETS).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    if (none) buckets.push({ value: null, label: 'No value', count: none })
    out[id] = { buckets, other: ranked.slice(BUCKETS).reduce((n, b) => n + b.count, 0) }
  }
  return out
}

/**
 * Keeps the first `most` under each key of every entity's `incomingRefs`
 * and counts them all in `incomingCount`, but for the keys in `whole`. The
 * entities are the list's own copies.
 */
export function peek(entities: Entity[], most: number, whole: ReadonlySet<string>): void {
  for (const e of entities) {
    if (!e.incomingRefs) continue
    // Read peeked, the counts came with the links; read whole, they are the links.
    e.incomingCount ??= Object.fromEntries(Object.entries(e.incomingRefs).map(([k, refs]) => [k, refs.length]))
    e.incomingRefs = Object.fromEntries(Object.entries(e.incomingRefs).map(([k, refs]) => [k, whole.has(k) ? refs : refs.slice(0, most)]))
  }
}

/** The leaves of a filter that ask whether one named entity points here. */
function pointedFrom(f: Filter): { relation: string }[] {
  if ('and' in f) return f.and.flatMap(pointedFrom)
  if ('or' in f) return f.or.flatMap(pointedFrom)
  if ('not' in f) return pointedFrom(f.not)
  return 'relation' in f && f.relation.startsWith('<-') && f.target !== undefined ? [f] : []
}

export function layersOf(row: EntityRow): Layers {
  return { ui: row.ui, pushed: row.pushed, override: row.override, git: row.git }
}

function fieldNames(bp: Blueprint | undefined, layers: Layers): string[] {
  const names = new Set<string>([TITLE_FIELD, ICON_FIELD, ...Object.keys(bp?.fields ?? {})])
  for (const layer of Object.values(layers)) for (const k of Object.keys(layer)) names.add(k)
  return [...names]
}

/** The status an entity reports through a field of its own, with the reason beside it when it is not green. Null when the field holds no level. */
function fieldStatus(e: Entity, field: string): EntityStatus | null {
  const v = e.fields[field]
  if (typeof v !== 'string' || !(v in WORST)) return null
  const why = e.fields[`${field}_reason`]
  return { level: v as StatusLevel, reasons: v !== 'green' && typeof why === 'string' ? [why] : [] }
}

function winningLayer(layers: string[]): string {
  return layers.reduce((best, l) => (RELATION_LAYERS.indexOf(l as (typeof RELATION_LAYERS)[number]) > RELATION_LAYERS.indexOf(best as (typeof RELATION_LAYERS)[number]) ? l : best))
}

/** Who points at an entity, keyed `blueprint.relation`. */
function refsOf(ends: RelationEnd[]): Record<string, RelatedRef[]> {
  const out: Record<string, RelatedRef[]> = {}
  for (const end of ends) (out[`${end.declaredOn}.${end.relation}`] ??= []).push(named(end))
  return out
}

/** The entity at the other end of a relation, with its title when it exists. */
function named(end: RelationEnd): RelatedRef {
  return end.targetTitle === null ? end.target : { ...end.target, title: end.targetTitle }
}

/**
 * The next moment after `now` at which `aggregate` over these entities can
 * change because time passed: an entity entering or leaving the window, or
 * its `where` crossing a span. Null when it reads no time, or nothing lies
 * ahead.
 */
export function aggregateNext(agg: AggregationDef, related: Entity[], now: number): number | null {
  const soon: (number | null)[] = []
  if (agg.where) for (const i of related) soon.push(nextChange(i, agg.where, now))
  if (agg.window) {
    let span: number
    let back: number
    try {
      span = parseDuration(agg.window.last)
      back = agg.window.offset ? parseDuration(agg.window.offset) : 0
    } catch {
      return soonest(soon)
    }
    for (const i of related) {
      const v = fieldOf(i, agg.window.field)
      const at = typeof v === 'string' ? Date.parse(v) : NaN
      if (Number.isNaN(at)) continue
      // In the window from `at + back` until a span later; out the moment after.
      soon.push(...[at + back, at + back + span + 1].filter((t) => t > now))
    }
  }
  return soonest(soon)
}

const HOUR = 3_600_000

/** When a calculation of the time (days since, hours since, the hour now) is read again: on the hour, the grain its functions move at. */
function hourEnd(now: number): number {
  return (Math.floor(now / HOUR) + 1) * HOUR
}

/**
 * Which related entities an aggregation reads: those that meet its `where`
 * and fall in its window. The value and every account of what made it ask
 * this, so the two never disagree. Null when the window cannot be read.
 */
export function aggregates(agg: AggregationDef, now = Date.now()): ((e: Entity) => boolean) | null {
  const where = agg.where
  if (!agg.window) return where ? (e) => matches(e, where) : () => true
  const { field, last, offset } = agg.window
  let span: number
  let back: number
  try {
    span = parseDuration(last)
    back = offset ? parseDuration(offset) : 0
  } catch {
    return null
  }
  // The window is [now - back - span, now - back]: the same edges as `within` when there is no offset.
  const end = now - back
  return (e) => {
    if (where && !matches(e, where)) return false
    const v = fieldOf(e, field)
    const at = typeof v === 'string' ? Date.parse(v) : NaN
    return !Number.isNaN(at) && at <= end && at >= end - span
  }
}

export function aggregate(agg: AggregationDef, related: Entity[], now = Date.now()): unknown {
  const reads = aggregates(agg, now)
  if (!reads) return null
  const items = related.filter(reads)
  const span = agg.window ? parseDuration(agg.window.last) : null
  const values = agg.field ? items.map((i) => fieldOf(i, agg.field!)).filter((v) => v !== null && v !== undefined) : []
  const nums = values.filter((v): v is number => typeof v === 'number').sort((a, b) => a - b)
  const sum = nums.reduce((a, b) => a + b, 0)
  let value: unknown
  switch (agg.fn) {
    case 'count':
      value = items.length
      break
    case 'sum':
      value = nums.length ? sum : null
      break
    case 'avg':
      value = nums.length ? sum / nums.length : null
      break
    case 'median':
      value = nums.length ? (nums.length % 2 ? nums[(nums.length - 1) / 2]! : (nums[nums.length / 2 - 1]! + nums[nums.length / 2]!) / 2) : null
      break
    // Nearest rank: the smallest value at or above nine tenths of the values.
    case 'p90':
      value = nums.length ? nums[Math.ceil(nums.length * 0.9) - 1]! : null
      break
    // Smallest and largest hold for anything that orders, so the latest datetime works as well as the largest number.
    case 'min':
      value = values.length ? values.reduce((a, b) => (compare(b, a) < 0 ? b : a)) : null
      break
    case 'max':
      value = values.length ? values.reduce((a, b) => (compare(b, a) > 0 ? b : a)) : null
      break
    case 'checks':
      value = checksOf(values)
      break
  }
  if (agg.per && span && typeof value === 'number') value = Math.round((value / (span / AGGREGATION_PERIODS[agg.per])) * 100) / 100
  return value
}

/**
 * The values a filter reads of an entity, by name, or null when it reads
 * more than its own values and head: what it reaches, a scorecard, or a
 * search over every value.
 */
export function valueNames(f: Filter): string[] | null {
  if ('and' in f || 'or' in f) {
    const parts = ('and' in f ? f.and : f.or).map(valueNames)
    return parts.some((p) => p === null) ? null : parts.flat() as string[]
  }
  if ('not' in f) return valueNames(f.not)
  if ('field' in f) return [f.field]
  if ('state' in f) return []
  return null
}

/** Whether a filter compares a value with the time now. */
export function readsNow(f: Filter): boolean {
  if ('and' in f) return f.and.some(readsNow)
  if ('or' in f) return f.or.some(readsNow)
  if ('not' in f) return readsNow(f.not)
  return 'field' in f && (f.op === 'within' || f.op === 'older')
}

/** Whether a filter reads only what is stored on the entity itself: stored fields, its own relations, its state. */
function storedOnly(f: Filter, stored: (field: string) => boolean): boolean {
  if ('and' in f) return f.and.every((x) => storedOnly(x, stored))
  if ('or' in f) return f.or.every((x) => storedOnly(x, stored))
  if ('not' in f) return storedOnly(f.not, stored)
  if ('field' in f) return stored(f.field)
  // A relation's own targets are stored on the entity; the values of what it reaches are not.
  return ('relation' in f && !f.where) || 'state' in f
}
