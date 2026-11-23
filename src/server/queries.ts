// Queries: the catalog read whole, on demand, across one or more blueprints.
// The grid reads a blueprint a page at a time as a person scrolls; a query
// reads every row that matches, of every blueprint it names, into one table
// with the columns the person picked, to look at, to export as a workbook, or
// to run an action on. A column may read a different field from each
// blueprint. A query is kept by name in its owner's library, may belong to one
// entity (its home, as an action's), and is shared with everyone, with one
// audience its owner is in, or with the people who own its home. Every row and every column is
// read through the reader's own view, so a shared query never shows anyone
// more than they may see.

import { randomBytes } from 'node:crypto'
import { RUN_COLUMNS, RUNS_SOURCE, type GridClause, type QueryAnswer, type QueryAnswerGroup, type QueryAudiencesResponse, type QueryColumn, type QueryColumnSpec, type QueryResult, type QueryRow, type QuerySpec, type QueryView, type SaveQueryRequest, type SavedQuery } from '../shared/api.ts'
import { columnFormat, columnKind, keptRows, labelOf, META_COLUMNS, metaIn, pathColumn, shape, viewProblem, type AnswerGroup } from '../shared/answer.ts'
import { sheetMoney } from '../shared/currency.ts'
import { matches, parsePath } from '../shared/filter.ts'
import { datasetOf, entityId, parseEntityId, type ActionRun, type Blueprint, type Entity, type EntityRef, type EntityState, type Filter, type Identity } from '../shared/model.ts'
import { audienceGrants } from '../shared/policy.ts'
import type { Actions } from './actions.ts'
import type { Blueprints } from './blueprints.ts'
import { DatasetError, type DatasetRead, type Datasets } from './datasets.ts'
import type { Db } from './db.ts'
import type { Logger } from './log.ts'
import type { Reader } from './read.ts'
import type { View, Visibility } from './visibility.ts'
import { text, workbook, type Sheet } from './xlsx.ts'
import { conditionsFilter, typesIn } from '../shared/clauses.ts'

/** The most blueprints one query reads. */
export const QUERY_SOURCES_MAX = 20
/** The most rows one answer holds, over every source. */
export const QUERY_ROWS_MAX = 50_000
/** How many rows are read at a time. */
const READ_PAGE = 1000
/** How many runs are read at a time. */
const RUN_PAGE = 2000

/** One source of a query as the hub reads it: its conditions already made one filter, and checked against the reader's view. */
export interface ReadSource {
  blueprint: string
  /** For the runs source alone: its conditions on the run columns. */
  runClauses?: GridClause[]
  filter?: Filter
  states?: EntityState[]
  hidden?: boolean
}

/**
 * A saved or sent query's sources as the hub reads them: each blueprint one
 * the reader sees some of, and each source's conditions one filter that reads
 * nothing they may not see. A blueprint the reader may not see is left out,
 * never marked, so a query shared with them reads what they may see of it;
 * only a reader who sees everything is told a blueprint is unknown, since
 * for them it is.
 */
export function sourcesOf(spec: QuerySpec, view: View, blueprints: Pick<Blueprints, 'get'>, log?: Pick<Logger, 'debug'>): ReadSource[] {
  return spec.sources.flatMap((s): ReadSource[] => {
    // Runs are filtered by their own columns, and each reader sees the runs the runs list shows them.
    if (s.blueprint === RUNS_SOURCE) return [{ blueprint: RUNS_SOURCE, runClauses: s.clauses.filter((c) => c.field) }]
    if (datasetOf(s.blueprint) !== null) {
      // A dataset's rows are read whole and its conditions judged on them here; whether the reader may read it is asked as it is read.
      const data = blueprints.get(s.blueprint)
      if (!data) {
        if (view.all) throw new QueryError(`Unknown dataset "${datasetOf(s.blueprint)}"`, 404)
        log?.debug('query source left out: no such dataset', { source: s.blueprint })
        return []
      }
      const filter = conditionsFilter(s.clauses, s.search, typesIn(data, (id) => blueprints.get(id)))
      return [{ blueprint: s.blueprint, ...(filter ? { filter } : {}) }]
    }
    if (!blueprints.get(s.blueprint) || !view.seesSome(s.blueprint)) {
      if (view.all) throw new QueryError(`Unknown blueprint "${s.blueprint}"`, 404)
      log?.debug('query source left out: not seen by the reader', { blueprint: s.blueprint })
      return []
    }
    log?.debug('query source read', { blueprint: s.blueprint })
    // A value is read as the field it tests holds it, along a relation's own conditions too.
    const bp = blueprints.get(s.blueprint)
    const filter = conditionsFilter(s.clauses, s.search, bp ? typesIn(bp, (id) => blueprints.get(id)) : undefined)
    const read = filter ? view.refusedQuery(s.blueprint, filter) : null
    if (read) throw new QueryError(`The filter reads "${read}", which you cannot see`, 403)
    return [{ blueprint: s.blueprint, ...(filter ? { filter } : {}), ...(s.states ? { states: s.states } : {}), ...(s.hidden ? { hidden: true } : {}) }]
  })
}

function groupSummary(g: AnswerGroup): QueryAnswerGroup {
  return { column: g.column, value: g.path.at(-1) === null ? null : labelOf(g.value), count: g.count, totals: g.totals, ...(g.groups ? { groups: g.groups.map(groupSummary) } : {}) }
}

export class QueryError extends Error {
  readonly status: 400 | 403 | 404 | 502
  constructor(message: string, status: 400 | 403 | 404 | 502 = 400) {
    super(message)
    this.status = status
  }
}

interface SavedRow {
  id: string
  title: string
  description: string | null
  owner: string
  shared: boolean
  audience: string | null
  home: string | null
  home_shared: boolean
  spec: QuerySpec
  created_at: Date
  updated_at: Date
}

export interface QueriesDeps {
  db: Db
  actions: Actions
  reader: Reader
  blueprints: Blueprints
  datasets: Datasets
  visibility: Pick<Visibility, 'accessPolicy' | 'grantsLetIn' | 'homeLetsIn' | 'view'>
  log: Logger
}

export class Queries {
  private readonly deps: QueriesDeps

  constructor(deps: QueriesDeps) {
    this.deps = deps
  }

  /** A query's sources as the hub reads them, through `sourcesOf`. */
  sources(spec: QuerySpec, view: View): ReadSource[] {
    return sourcesOf(spec, view, { get: (id) => this.kind(id) }, this.deps.log)
  }

  /** A blueprint, or a dataset read as one, by the id a source names; undefined when there is neither. */
  kind(id: string): Blueprint | undefined {
    if (datasetOf(id) === null) return this.deps.blueprints.get(id)
    return this.deps.datasets.blueprints().find((b) => b.id === id)
  }

  /** Every blueprint, and every dataset read as one: what a column's kind and format are worked out against. */
  private kinds(): Blueprint[] {
    return [...this.deps.blueprints.list(), ...this.deps.datasets.blueprints()]
  }

  /** Every row the sources match, as the reader may see it, with the columns asked for. */
  async run(sources: readonly ReadSource[], columns: QuerySpec['columns'], view: View, identity?: Identity): Promise<QueryResult> {
    const started = Date.now()
    const bps = sources.filter((s) => s.blueprint !== RUNS_SOURCE).map((s) => this.blueprint(s.blueprint))
    const cols = this.columns(columns, bps, view, sources.some((s) => s.blueprint === RUNS_SOURCE))
    const rows: QueryRow[] = []
    const counts: Record<string, number> = {}
    let truncated = false
    for (const source of sources) {
      if (source.blueprint === RUNS_SOURCE) {
        if (!identity) throw new QueryError('Runs are read as someone: they show each person what they may see', 400)
        const read = await this.runRows(source.runClauses ?? [], cols, view, identity, QUERY_ROWS_MAX - rows.length)
        rows.push(...read.rows)
        counts[RUNS_SOURCE] = read.rows.length
        if (read.truncated) truncated = true
        continue
      }
      const dataset = datasetOf(source.blueprint)
      if (dataset !== null) {
        if (!identity) throw new QueryError('A dataset is read as someone: its tool runs as a call of theirs', 400)
        if (!(await this.deps.datasets.open(dataset, identity, view))) {
          this.deps.log.debug('query source left out: the dataset is not open to the reader', { dataset, by: identity.name })
          continue
        }
        let read: DatasetRead
        try {
          read = await this.deps.datasets.read(dataset, identity, view)
        } catch (error) {
          if (error instanceof DatasetError) throw new QueryError(error.message, error.status === 409 ? 400 : error.status)
          throw error
        }
        const data = bps.find((b) => b.id === source.blueprint)!
        const room = QUERY_ROWS_MAX - rows.length
        let matched = 0
        for (const [i, values] of read.rows.entries()) {
          const e = rowEntity(data, read, values, i)
          if (source.filter && !matches(e, source.filter)) continue
          matched++
          if (matched > room) {
            truncated = true
            continue
          }
          rows.push({ blueprint: data.id, key: e.key, values: cols.map((c) => { const id = c.from[data.id]; return id ? valueOf(e, id, data) : null }) })
        }
        counts[data.id] = matched
        if (read.truncated) truncated = true
        continue
      }
      const bp = bps.find((b) => b.id === this.deps.blueprints.resolve(source.blueprint))!
      let after = null
      let first = true
      for (;;) {
        const room = QUERY_ROWS_MAX - rows.length
        if (room <= 0) {
          truncated = true
          break
        }
        const page = await this.deps.reader.list({ blueprint: bp.id, filter: source.filter, states: source.states, includeHidden: !!source.hidden, sort: 'title', limit: Math.min(READ_PAGE, room), after, view })
        if (first) counts[bp.id] = (counts[bp.id] ?? 0) + page.total
        first = false
        const far = await this.reached(page.entities, cols.map((c) => c.from[bp.id]).filter((id): id is string => !!id && walked(id)), view)
        for (const e of page.entities) rows.push({ blueprint: e.blueprint, key: e.key, values: cols.map((c) => { const id = c.from[bp.id]; return id ? (walked(id) ? this.farValue(far, e, id) : valueOf(e, id, bp)) : null }) })
        if (!page.next || page.entities.length === 0) break
        after = page.next
      }
      if (truncated) break
    }
    const ms = Date.now() - started
    this.deps.log.info('query run', { sources: sources.map((s) => s.blueprint), columns: cols.length, rows: rows.length, truncated, ms })
    return { columns: cols, rows, counts, truncated, ms }
  }

  /**
   * The ends of every path these entities' columns walk, as the reader sees
   * them: by path, then by the starting entity's id. The ids are walked
   * first, then every end is read once from its stored row, so an end shows
   * its worked-out values and status, and passes through the view: an end
   * the reader may not see is left out, and a field they may not see on it
   * is withheld.
   */
  private async reached(entities: readonly Entity[], ids: readonly string[], view: View): Promise<Map<string, Map<string, Entity[]>>> {
    const paths = [...new Set(ids.map((id) => pathColumn(id)!.path))]
    const out = new Map<string, Map<string, Entity[]>>()
    if (!paths.length || !entities.length) return out
    const reach = await this.deps.reader.reachAll(entities.map((e) => ({ blueprint: e.blueprint, key: e.key })), paths)
    const wanted = new Map<string, EntityRef>()
    for (const byStart of reach.values()) for (const ends of byStart.values()) for (const id of ends) wanted.set(id, refOf(id))
    const ends = new Map<string, Entity>()
    for (const e of await this.deps.reader.hydrated([...wanted.values()])) {
      const seen = view.entity(e)
      if (seen) ends.set(seen.id, seen)
    }
    for (const [path, byStart] of reach) out.set(path, new Map([...byStart].map(([start, list]) => [start, list.map((id) => ends.get(id)).filter((e): e is Entity => !!e)])))
    return out
  }

  /** A path column's value for one entity: the titles at the end of its path, or a field of each end, as a list; null when it reaches nothing. */
  private farValue(far: Map<string, Map<string, Entity[]>>, e: Entity, id: string): unknown {
    const { path, field } = pathColumn(id)!
    const ends = far.get(path)?.get(entityId(e)) ?? []
    const values = ends.map((end) => {
      if (field === null) return end.title
      const bp = this.deps.blueprints.get(end.blueprint)
      return bp ? valueOf(end, field, bp) : null
    }).filter((v) => v !== null && v !== undefined)
    return values.length ? values : null
  }

  /**
   * An answer as its view shows it, for a caller that does not shape it itself: the rows the view keeps, the first
   * of them up to `limit`, the groups and the totals it asks for, and each column with how its numbers are shown.
   */
  shown(result: QueryResult, view: QueryView | undefined, limit: number): QueryAnswer {
    const bps = this.kinds()
    const shaped = shape(result.rows, view, result.columns, result.columns.map((c) => columnKind(c, bps)))
    // A column shown as money says so, so its stored minor units are read as the amounts they are.
    const columns = result.columns.map((c) => {
      const format = columnFormat(c, bps)
      return format ? { ...c, format } : c
    })
    return { counts: result.counts, columns, kept: shaped.rows.length, rows: shaped.rows.slice(0, limit), shown: Math.min(limit, shaped.rows.length), truncated: result.truncated, ...(shaped.groups ? { groups: shaped.groups.map(groupSummary) } : {}), ...(Object.keys(shaped.totals).length ? { totals: shaped.totals } : {}) }
  }

  /** What in a view a caller just sent cannot be judged against the answer, said so they mend it, or null (`viewProblem`). */
  problem(result: QueryResult, view: QueryView | undefined): string | null {
    const bps = this.kinds()
    return viewProblem(view, result.columns, result.columns.map((c) => columnKind(c, bps)))
  }

  /** The rows of an answer a query's view keeps, in its order: what an export, a batch, or a schedule takes. */
  kept(result: QueryResult, view: QueryView | undefined): QueryRow[] {
    if (!view?.where?.length && !view?.sort?.length) return result.rows
    const bps = this.kinds()
    return keptRows(result.rows, view, result.columns, result.columns.map((c) => columnKind(c, bps)))
  }

  /** The entities a saved or sent query's answer keeps through its view, of the blueprints asked: what a schedule on it runs on. */
  async keptRefs(spec: QuerySpec, view: View, identity: Identity | undefined, blueprints: ReadonlySet<string>): Promise<EntityRef[]> {
    const sources = this.sources(spec, view).filter((s) => blueprints.has(s.blueprint))
    if (!sources.length) return []
    const result = await this.run(sources, spec.columns, view, identity)
    return this.kept(result, spec.view).map((r) => ({ blueprint: r.blueprint, key: r.key }))
  }

  /** The answer as a workbook: one sheet of every row, and a sheet for each blueprint when it reads more than one. */
  async export(sources: readonly ReadSource[], columns: QuerySpec['columns'], view: View, title: string, identity?: Identity, shown?: QueryView): Promise<Buffer> {
    const result = await this.run(sources, columns, view, identity)
    const rows = this.kept(result, shown)
    const header = result.columns.map((c) => c.title)
    // A column shown as money is written as amounts in the currency's major unit, with Excel's money format, so the sheet adds what a person reads.
    const money = result.columns.map((c) => {
      const format = columnFormat(c, this.kinds())
      return format?.kind === 'currency' ? sheetMoney(format) : undefined
    })
    const formats = money.map((m) => m?.code)
    const valueOf = (v: unknown, i: number) => {
      const m = money[i]
      return m && typeof v === 'number' ? m.amount(v) : cellValue(v)
    }
    const sheetOf = (name: string, list: QueryRow[]): Sheet => ({ name, columns: header, formats, rows: list.map((r) => r.values.map(valueOf)) })
    const sheets: Sheet[] = [sheetOf(title, rows)]
    if (sources.length > 1) for (const s of sources) sheets.push(sheetOf(s.blueprint === RUNS_SOURCE ? 'Action runs' : this.blueprint(s.blueprint).title, rows.filter((r) => r.blueprint === s.blueprint)))
    return workbook(sheets)
  }

  /**
   * The columns, in the order asked, each with what fills it in each
   * blueprint read, and in the runs when they are read (`RUNS_SOURCE`). An id
   * names the field of that id in every blueprint that has it, titled by the
   * first; one no blueprint has, or the reader may see in none, is left out.
   * A column that names its fields keeps its own title, and reads, in each
   * blueprint, only what the reader may see.
   */
  columns(asked: QuerySpec['columns'], bps: readonly Blueprint[], view: View, runs = false): QueryColumn[] {
    const out: QueryColumn[] = []
    const ids = new Set<string>()
    for (const c of asked) {
      const id = typeof c === 'string' ? c : c.id
      if (ids.has(id)) continue
      ids.add(id)
      if (typeof c !== 'string') {
        out.push(this.named(c, bps, view, runs))
        continue
      }
      const run = runs ? RUN_COLUMNS.find((r) => r.id === c) : undefined
      if (run) {
        out.push({ ...run, from: { [RUNS_SOURCE]: c } })
        continue
      }
      const meta = META_COLUMNS.find((m) => m.id === c)
      if (meta) {
        out.push({ id: meta.id, title: meta.title, from: everyOne(bps, c, runs) })
        continue
      }
      const all = this.deps.blueprints.list()
      const having = bps.filter((bp) => readable(bp, c, view, all))
      if (having.length) out.push({ id: c, title: titleOf(having[0]!, c, all), from: Object.fromEntries(having.map((bp) => [bp.id, c])) })
    }
    if (out.length) return out
    // A query of datasets alone that asks for no column shows every column they name: a table's row has no title or status of its own.
    if (bps.length && !runs && bps.every((bp) => datasetOf(bp.id) !== null)) {
      const seen = new Set<string>()
      for (const bp of bps) for (const [id, field] of Object.entries(bp.fields)) if (!seen.has(id)) {
        seen.add(id)
        out.push({ id, title: field.title ?? id, from: Object.fromEntries(bps.filter((b) => b.fields[id]).map((b) => [b.id, id])) })
      }
      return out
    }
    return META_COLUMNS.slice(0, 4).map((m) => ({ id: m.id, title: m.title, from: everyOne(bps, m.id, runs) }))
  }

  /** A column that names its own field in each blueprint: the blueprints by their ids today, and each only where the reader may see it. The runs take one of their own columns, or one every row has. */
  private named(c: QueryColumnSpec, bps: readonly Blueprint[], view: View, runs: boolean): QueryColumn {
    const from: Record<string, string> = {}
    for (const [named, field] of Object.entries(c.from)) {
      if (named === RUNS_SOURCE) {
        if (runs && (RUN_COLUMNS.some((r) => r.id === field) || metaIn({ fields: {} }, field))) from[RUNS_SOURCE] = field
        continue
      }
      const bp = bps.find((b) => b.id === (datasetOf(named) === null ? this.deps.blueprints.resolve(named) : named))
      if (bp && readable(bp, field, view, this.deps.blueprints.list())) from[bp.id] = field
    }
    return { id: c.id, title: c.title, from }
  }

  /** The runs the reader may see that the conditions match, newest first, as rows. */
  private async runRows(clauses: readonly GridClause[], cols: QueryColumn[], view: View, identity: Identity, room: number): Promise<{ rows: QueryRow[]; truncated: boolean }> {
    const rows: QueryRow[] = []
    let before: string | null = null
    for (;;) {
      const page: ActionRun[] = await this.deps.actions.runsMatching(clauses, RUN_PAGE, before)
      const seen = await this.deps.actions.runsFor(identity, view, page)
      for (const r of seen) {
        if (rows.length >= room) return { rows, truncated: true }
        rows.push({ blueprint: RUNS_SOURCE, key: r.id, values: cols.map((c) => (c.from[RUNS_SOURCE] ? runValue(r, c.from[RUNS_SOURCE]!, this.deps.actions) : null)) })
      }
      if (page.length < RUN_PAGE) return { rows, truncated: false }
      before = page.at(-1)!.createdAt
    }
  }

  private blueprint(id: string): Blueprint {
    const bp = datasetOf(id) === null ? this.deps.blueprints.get(this.deps.blueprints.resolve(id)) : this.kind(id)
    if (!bp) throw new QueryError(`Unknown blueprint "${id}"`, 404)
    return bp
  }

  // Saved queries ------------------------------------------------------------

  /** The audiences of the access policy this person or token is in: the ones they may share with, and see what is shared with. */
  async audiences(identity: Identity): Promise<QueryAudiencesResponse['audiences']> {
    const policy = this.deps.visibility.accessPolicy()
    const out: QueryAudiencesResponse['audiences'] = []
    for (const a of policy.audiences) if (await this.inAudience(identity, a.id)) out.push({ id: a.id, title: a.title, description: a.description ?? null })
    return out
  }

  /** Whether the identity is in an audience, judged as every rule naming it is; an audience the policy no longer holds lets nobody in. */
  private async inAudience(identity: Identity, audience: string): Promise<boolean> {
    return this.deps.visibility.grantsLetIn(identity.name, audienceGrants(this.deps.visibility.accessPolicy(), [audience]))
  }

  /** Whether the identity may open a saved query: theirs, shared with everyone, with an audience they are in, or with the people of a home they own, or any to an admin when asked by id. */
  private async opens(row: SavedRow, identity: Identity, byId: boolean): Promise<boolean> {
    if (row.owner === identity.name || row.shared || (byId && identity.admin)) return true
    if (row.audience !== null && (await this.inAudience(identity, row.audience))) return true
    return row.home_shared && row.home !== null && this.deps.visibility.homeLetsIn(identity, row.home, true)
  }

  /**
   * The reader's own queries, and every one shared with them: with everyone,
   * with an audience they are in, or with the people of a home they own,
   * newest change first. Given a home, only the queries that belong to it.
   */
  async list(identity: Identity, home?: string): Promise<SavedQuery[]> {
    const rows = await this.deps.db.query<SavedRow>('SELECT * FROM saved_queries WHERE (owner = $1 OR shared OR audience IS NOT NULL OR home_shared) AND ($2::text IS NULL OR home = $2) ORDER BY updated_at DESC', [identity.name, home ?? null])
    const opened = new Map<string, boolean>()
    const kept: SavedRow[] = []
    for (const r of rows.rows) {
      const why = r.owner === identity.name || r.shared ? null : `${r.audience ?? ''}\u0000${r.home_shared ? (r.home ?? '') : ''}`
      if (why !== null && !opened.has(why)) opened.set(why, await this.opens(r, identity, false))
      if (why === null || opened.get(why)) kept.push(r)
    }
    return this.toSaved(kept, identity)
  }

  async get(id: string, identity: Identity): Promise<SavedQuery> {
    const row = (await this.deps.db.query<SavedRow>('SELECT * FROM saved_queries WHERE id = $1', [id])).rows[0]
    if (!row || !(await this.opens(row, identity, true))) throw new QueryError(`Unknown query "${id}"`, 404)
    return (await this.toSaved([row], identity))[0]!
  }

  /**
   * Saves a new query as the reader's, or changes one: only whoever saved it,
   * or an admin, changes it. Shared with everyone, it names no audience and
   * opens to nobody by its home. An audience it newly names must be one the
   * person saving is in. A home must be an entity they see, and it opens to
   * the people who own it only as someone who owns it, or an admin, says so.
   */
  async save(id: string | null, input: SaveQueryRequest, identity: Identity): Promise<SavedQuery> {
    const shared = !!input.shared
    const audience = shared ? null : (input.audience ?? null)
    const row = id ? (await this.deps.db.query<SavedRow>('SELECT * FROM saved_queries WHERE id = $1', [id])).rows[0] : undefined
    if (id && (!row || !(await this.opens(row, identity, true)))) throw new QueryError(`Unknown query "${id}"`, 404)
    if (row && row.owner !== identity.name && !identity.admin) throw new QueryError('Only whoever saved a query, or an admin, changes it', 403)
    if (audience !== null && audience !== row?.audience) {
      if (!this.deps.visibility.accessPolicy().audiences.some((a) => a.id === audience)) throw new QueryError(`Unknown audience "${audience}"`, 400)
      if (!(await this.inAudience(identity, audience))) {
        this.deps.log.info('query not shared: not in the audience', { id, by: identity.name, audience })
        throw new QueryError('You can share a query only with an audience you are in', 403)
      }
    }
    // A home left out is kept as it is, so a reader who was not shown it never takes it off.
    const home = input.home === undefined ? (row?.home ?? null) : input.home
    if (home !== null && home !== row?.home) {
      const ref = parseEntityId(home)
      const view = await this.deps.visibility.view(identity)
      const seen = ref && view.seesBlueprint(ref.blueprint) ? view.entities(await this.deps.reader.hydrated([ref])) : []
      if (!seen.length) {
        this.deps.log.info('query not homed: no such entity in sight', { id, by: identity.name, home })
        throw new QueryError(`Unknown home "${home}"`, 400)
      }
    }
    const homeShared = !shared && audience === null && home !== null && !!input.homeShared
    if (homeShared && !(row?.home_shared && row.home === home) && !identity.admin && !(await this.deps.visibility.homeLetsIn(identity, home!, true))) {
      this.deps.log.info('query not shared: does not own the home', { id, by: identity.name, home })
      throw new QueryError('You can share a query with the people of its home only when you are one of them', 403)
    }
    const values = [input.title, input.description ?? null, shared, audience, home, homeShared, JSON.stringify(input.spec)]
    const told = { by: identity.name, shared, audience, home, homeShared, sources: input.spec.sources.length }
    if (id) {
      await this.deps.db.query('UPDATE saved_queries SET title = $2, description = $3, shared = $4, audience = $5, home = $6, home_shared = $7, spec = $8, updated_at = now() WHERE id = $1', [id, ...values])
      this.deps.log.info('query saved', { id, ...told })
      return this.get(id, identity)
    }
    const fresh = randomBytes(6).toString('hex')
    await this.deps.db.query('INSERT INTO saved_queries (id, title, description, shared, audience, home, home_shared, spec, owner) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)', [fresh, ...values, identity.name])
    this.deps.log.info('query saved', { id: fresh, ...told, created: true })
    return this.get(fresh, identity)
  }

  async remove(id: string, identity: Identity): Promise<void> {
    const held = await this.get(id, identity)
    if (!held.mine) throw new QueryError('Only whoever saved a query, or an admin, removes it', 403)
    await this.deps.db.query('DELETE FROM saved_queries WHERE id = $1', [id])
    this.deps.log.info('query removed', { id, by: identity.name })
  }

  /** Saved queries as one reader gets them, their homes read in one batch through the reader's view. */
  private async toSaved(rows: readonly SavedRow[], identity: Identity): Promise<SavedQuery[]> {
    const homed = rows.some((r) => r.home !== null)
    const homes = homed ? await this.deps.actions.homes(identity, await this.deps.visibility.view(identity), rows.map((r) => r.home)) : new Map()
    const audiences = this.deps.visibility.accessPolicy().audiences
    return rows.map((r) => {
      const audience = r.audience === null ? null : { id: r.audience, title: audiences.find((a) => a.id === r.audience)?.title ?? r.audience }
      const home = (r.home !== null && homes.get(r.home)) || null
      return { id: r.id, title: r.title, description: r.description, owner: r.owner, shared: r.shared, audience, home, homeShared: r.home_shared, spec: r.spec, createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(), mine: r.owner === identity.name || !!identity.admin }
    })
  }
}

/** One row of a dataset as the entity the column and filter code reads: its columns as fields, its first column as its title, its place as its key. */
function rowEntity(bp: Blueprint, read: DatasetRead, values: readonly unknown[], i: number): Entity {
  const fields = Object.fromEntries(read.columns.map((c, k) => [c.id, values[k] ?? null]))
  const first = values[0]
  const key = String(i + 1)
  return { id: `${bp.id}:${key}`, blueprint: bp.id, key, title: first === null || first === undefined ? key : String(first), fields, relations: {}, state: 'active', status: { level: 'grey', reasons: [] }, owner: null, lastSeenAt: null, updatedAt: read.fetchedAt } as unknown as Entity
}

/** A column every row has, filled from each blueprint read, and from the runs when they are read. */
function everyOne(bps: readonly Blueprint[], id: string, runs: boolean): Record<string, string> {
  return Object.fromEntries([...bps.map((bp) => [bp.id, id]), ...(runs ? [[RUNS_SOURCE, id]] : [])])
}

/** Whether a column id is read through relations rather than from the row's own entity: a path of more than one hop, a hop in, or a field at the end. A relation of the row's own is read off the row. */
function walked(id: string): boolean {
  const path = pathColumn(id)
  return !!path && (path.field !== null || path.path.includes('.') || path.path.startsWith('<-'))
}

/** An entity id as a reference. */
function refOf(id: string): EntityRef {
  const at = id.indexOf(':')
  return { blueprint: id.slice(0, at), key: id.slice(at + 1) }
}

/** The blueprints a path steps through, each with the title of the hop into it; null where a hop names no relation, or a path that does not parse. */
function hopsOf(bp: Blueprint, path: string, blueprints: readonly Blueprint[]): { bp: Blueprint; title: string }[] | null {
  let hops
  try {
    hops = parsePath(path)
  } catch {
    return null
  }
  const out: { bp: Blueprint; title: string }[] = []
  let at = bp
  for (const hop of hops) {
    if (hop.incoming) {
      const source = hop.from ? blueprints.find((b) => b.id === hop.from) : blueprints.find((b) => b.relations[hop.relation]?.target === at.id)
      if (!source || source.relations[hop.relation]?.target !== at.id) return null
      out.push({ bp: source, title: source.title })
      at = source
    } else {
      const rel = at.relations[hop.relation]
      const target = rel && blueprints.find((b) => b.id === rel.target)
      if (!rel || !target) return null
      out.push({ bp: target, title: rel.title ?? hop.relation })
      at = target
    }
  }
  return out
}

/** Whether the reader may read a field, or a column every entity has, on a blueprint: on some of its entities, as theirs where a class opens it so. */
function fieldReadable(bp: Blueprint, id: string, view: View): boolean {
  if (metaIn(bp, id)) return true
  return !!bp.fields[id] && (!view.hiddenFields(bp.id).has(id) || view.ownerOpened(bp.id).has(id))
}

/**
 * Whether the reader may read a column id on a blueprint: a column every
 * entity has, a field they may see on some of it, or a path of relations
 * whose every hop reaches a blueprint they see some of, and whose field at
 * the end they may see there.
 */
function readable(bp: Blueprint, id: string, view: View, blueprints: readonly Blueprint[]): boolean {
  const path = pathColumn(id)
  if (!path) return fieldReadable(bp, id, view)
  const hops = hopsOf(bp, path.path, blueprints)
  if (!hops?.length || !hops.every((h) => view.seesSome(h.bp.id))) return false
  return path.field === null || fieldReadable(hops.at(-1)!.bp, path.field, view)
}

/** What a blueprint calls a column id: its field's title, or for a path the title of each hop and of the field at its end, joined by ›; else the id. */
function titleOf(bp: Blueprint, id: string, blueprints: readonly Blueprint[]): string {
  const meta = metaIn(bp, id)
  if (meta) return meta.title
  const path = pathColumn(id)
  if (!path) return bp.fields[id]?.title ?? id
  const hops = hopsOf(bp, path.path, blueprints)
  if (!hops) return id.slice(2)
  const parts = hops.map((h) => h.title)
  if (path.field !== null) {
    const end = hops.at(-1)!.bp
    parts.push(metaIn(end, path.field)?.title ?? end.fields[path.field]?.title ?? path.field)
  }
  return parts.join(' › ')
}

/** One column's value for one entity: a column every entity has, a field, or the titles a relation points at. */
function valueOf(e: Entity, id: string, bp: Blueprint): unknown {
  switch (metaIn(bp, id)?.id) {
    case '$type':
      return bp.title
    case 'title':
      return e.title
    case '$key':
      return e.key
    case '$status':
      return e.status.level
    case '$state':
      return e.state
    case '$owner':
      return e.owner
    case '$lastSeenAt':
      return e.lastSeenAt
    case '$updatedAt':
      return e.updatedAt
  }
  if (id.startsWith('r:')) {
    const refs = e.relations[id.slice(2)]
    return refs?.length ? refs.map((r) => r.title ?? r.key) : null
  }
  return e.fields[id] ?? null
}

/** A value as a workbook cell holds it: numbers and booleans as they are, lists joined, anything else as text. */
function cellValue(v: unknown): unknown {
  return typeof v === 'number' || typeof v === 'boolean' || v === null || v === undefined ? v : text(v)
}

/** One column's value for one run: the columns every row has, read as a run's, and the run's own. */
function runValue(r: ActionRun, id: string, actions: Actions): unknown {
  const seconds = r.startedAt && r.finishedAt ? Math.round((Date.parse(r.finishedAt) - Date.parse(r.startedAt)) / 1000) : null
  const action = actions.get(r.action)?.title ?? r.action
  switch (metaIn({ fields: {} }, id)?.id ?? id) {
    case '$type':
      return 'Action run'
    case 'title':
      return `${action}${r.entityTitle ? ` on ${r.entityTitle}` : r.entity ? ` on ${r.entity.key}` : ''}`
    case '$key':
      return r.id
    case '$status':
    case '$state':
    case 'run:state':
      return r.state
    case '$owner':
    case 'run:by':
      return r.by
    case '$updatedAt':
    case 'run:finishedAt':
      return r.finishedAt
    case 'run:action':
      return action
    case 'run:entity':
      return r.entityTitle ?? r.entity?.key ?? null
    case 'run:createdAt':
      return r.createdAt
    case 'run:startedAt':
      return r.startedAt
    case 'run:seconds':
      return seconds
    case 'run:attempt':
      return r.attempt
    case 'run:batch':
      return r.batch ?? null
    case 'run:schedule':
      return r.schedule ?? null
    case 'run:decidedBy':
      return r.decidedBy
    case 'run:summary':
      return r.summary
  }
  return null
}
