// A query's answer as it is shown: narrowed by conditions on its columns,
// ordered, grouped, and added up (`QueryView`). The page shapes the answer it
// holds with this, and the hub shapes an answer with the same code wherever it
// hands one on, so an export, a batch, and a schedule take the rows the person
// saw. What a column holds, and how its cells read, is worked out here too.

import { RUN_COLUMNS, RUNS_SOURCE, type GridClause, type QueryColumn, type QueryRow, type QuerySort, type QueryTotal, type QueryView } from './api.ts'
import { clauseValue } from './clauses.ts'
import { compare, holds, parsePath, stable } from './filter.ts'
import type { Blueprint, FieldDef, FieldFormat, FieldType } from './model.ts'

/** What a query reads of a blueprint to know its columns. */
export type Readable = Pick<Blueprint, 'id' | 'fields' | 'relations'>

/** What a column holds: a kind of field, or the entities a relation reaches, by title. Undefined where nothing says. */
export type ColumnKind = FieldType | 'relation' | undefined

/** A column every entity has: what it is called and what it holds. */
export interface MetaColumn {
  id: string
  title: string
  type: FieldType
}

/**
 * The columns every entity has. Each answers to its `$` name whatever the
 * blueprint defines; the title is a field every entity carries.
 */
export const META_COLUMNS: readonly MetaColumn[] = [
  { id: '$type', title: 'Type', type: 'enum' },
  { id: 'title', title: 'Title', type: 'string' },
  { id: '$key', title: 'Key', type: 'string' },
  { id: '$status', title: 'Status', type: 'enum' },
  { id: '$state', title: 'State', type: 'enum' },
  { id: '$owner', title: 'Source', type: 'enum' },
  { id: '$lastSeenAt', title: 'Last seen', type: 'datetime' },
  { id: '$updatedAt', title: 'Last update', type: 'datetime' },
]

/** The names some of those columns once went by without their `$`, which a saved query may still use. */
const BARE: ReadonlySet<string> = new Set(['key', 'state', 'lastSeenAt', 'updatedAt'])

/**
 * The column every entity has that an id names in a blueprint, or undefined
 * for a field or a relation. A field the blueprint defines wins a bare name,
 * as it does in a filter: `state` is an issue's own state where its blueprint
 * has one and the entity's elsewhere, while `$state` is always the entity's.
 */
export function metaIn(bp: Pick<Readable, 'fields'>, id: string): MetaColumn | undefined {
  if (BARE.has(id)) return bp.fields[id] ? undefined : META_COLUMNS.find((m) => m.id === `$${id}`)
  return META_COLUMNS.find((m) => m.id === id)
}

/**
 * A column read through relations: `r:<path>` is the entities at the end of
 * the path, by title, and `r:<path>@<field>` a field of theirs. A path is one
 * hop per dot, as `parsePath` reads it: `r:team` is a relation of the row's
 * own, `r:team.department@cost_center` the cost centre of its team's
 * department, and `r:<-sw_service:repository` the services pointing at it.
 */
export function pathColumn(id: string): { path: string; field: string | null } | null {
  if (!id.startsWith('r:')) return null
  const at = id.indexOf('@')
  return at < 0 ? { path: id.slice(2), field: null } : { path: id.slice(2, at), field: id.slice(at + 1) }
}

/** The blueprint at the end of a path from one, or undefined where a hop names no relation it has. */
export function pathEnd(from: Readable, path: string, blueprints: readonly Readable[]): Readable | undefined {
  let at: Readable | undefined = from
  for (const hop of parsePath(path)) {
    if (!at) return undefined
    if (hop.incoming) {
      const named: string | null = hop.from
      const source = named ? blueprints.find((b) => b.id === named) : blueprints.find((b) => b.relations[hop.relation]?.target === at!.id)
      at = source && source.relations[hop.relation]?.target === at.id ? source : undefined
    } else {
      const target: string | undefined = at.relations[hop.relation]?.target
      at = target ? blueprints.find((b) => b.id === target) : undefined
    }
  }
  return at
}

/** What one blueprint fills a column with, by the id it reads there. */
export function kindIn(bp: Readable, id: string, blueprints: readonly Readable[]): ColumnKind {
  const meta = metaIn(bp, id)
  if (meta) return meta.type
  if (bp.id === RUNS_SOURCE) return RUN_COLUMNS.find((c) => c.id === id)?.type ?? (RUN_COLUMNS.some((c) => c.id === id) ? 'string' : undefined)
  const path = pathColumn(id)
  if (!path) return bp.fields[id]?.type
  if (path.field === null) return 'relation'
  const end = pathEnd(bp, path.path, blueprints)
  return end ? (metaIn(end, path.field)?.type ?? end.fields[path.field]?.type) : undefined
}

/** The definition of the field one blueprint fills a column with, at the end of a path where the column reads through relations; undefined for a column every entity has, a relation's titles, or what nothing defines. */
export function defIn(bp: Readable, id: string, blueprints: readonly Readable[]): FieldDef | undefined {
  if (metaIn(bp, id) || bp.id === RUNS_SOURCE) return undefined
  const path = pathColumn(id)
  if (!path) return bp.fields[id]
  if (path.field === null) return undefined
  const end = pathEnd(bp, path.path, blueprints)
  return end && !metaIn(end, path.field) ? end.fields[path.field] : undefined
}

/**
 * How a column's numbers are shown, such as money: the format every
 * blueprint that fills it gives its field, when they all give the same one.
 * Undefined when one gives none or they differ, so a cell is never shown as
 * money it is not. Only the showing changes: a cell, a condition, and a total
 * keep the stored number.
 */
export function columnFormat(column: Pick<QueryColumn, 'from'>, blueprints: readonly Readable[]): FieldFormat | undefined {
  let format: FieldFormat | undefined
  let first = true
  for (const [bp, id] of Object.entries(column.from)) {
    const readable = blueprints.find((b) => b.id === bp)
    const def = readable ? defIn(readable, id, blueprints) : undefined
    const own = def?.type === 'number' ? def.format : undefined
    if (!own || (!first && stable(own) !== stable(format))) return undefined
    format = own
    first = false
  }
  return format
}

/** What a column holds across the blueprints that fill it: their one kind when they agree, text when they do not. */
export function columnKind(column: Pick<QueryColumn, 'from'>, blueprints: readonly Readable[]): ColumnKind {
  const kinds = new Set<ColumnKind>()
  for (const [bp, id] of Object.entries(column.from)) {
    const readable = bp === RUNS_SOURCE ? { id: RUNS_SOURCE, fields: {}, relations: {} } : blueprints.find((b) => b.id === bp)
    if (readable) kinds.add(kindIn(readable, id, blueprints))
  }
  kinds.delete(undefined)
  return kinds.size === 1 ? [...kinds][0] : kinds.size ? 'string' : undefined
}

/** Whether a column's cells line up on the right: it holds numbers. */
export const numeric = (kind: ColumnKind): boolean => kind === 'number'

/** The values a cell holds: none for an empty one, each of a list, or the one. */
export function cells(value: unknown): unknown[] {
  if (value === null || value === undefined || value === '') return []
  return Array.isArray(value) ? value.filter((v) => v !== null && v !== undefined && v !== '') : [value]
}

/** A value as one line of text, the way a share of a column and a group name it. */
export function textOf(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (value && typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/** What a group or a share of a column is keyed by: its one value, every value of a list together, or null for none. */
export function keyOf(value: unknown): string | null {
  const all = cells(value)
  if (!all.length) return null
  return all.length === 1 ? stable(all[0]) : stable([...all].map(stable).sort())
}

/** The text a key is shown as. */
export function labelOf(value: unknown): string {
  return cells(value).map(textOf).join(', ')
}

/**
 * Whether a cell meets one condition. A cell that holds several values meets
 * a test when one of them does (`neq` and a test turned round: when none
 * does), and `exists` asks whether it holds any. What a test means is the
 * filter's own (`holds`), so a column's condition reads as a field's does.
 */
export function cellMeets(value: unknown, clause: Pick<GridClause, 'op' | 'value' | 'not' | 'field'>, kind: ColumnKind, now = Date.now()): boolean {
  const all = cells(value)
  if (clause.op === 'exists') return all.length > 0 !== !!clause.not
  const wanted = clauseValue(clause, () => (kind === 'relation' ? 'string' : kind))
  if (clause.op === 'neq') return !all.some((v) => holds(v, 'eq', wanted, now)) !== !!clause.not
  const met = clause.op === 'contains' && Array.isArray(value) ? all.some((v) => holds(v, 'eq', wanted, now) || holds(v, 'contains', wanted, now)) : all.some((v) => holds(v, clause.op, wanted, now))
  return met !== !!clause.not
}

/** Whether a row meets every condition of a view, each on the column it names. A condition on a column the answer does not hold is met. */
export function rowMeets(row: QueryRow, where: readonly GridClause[], columns: readonly QueryColumn[], kinds: readonly ColumnKind[], now = Date.now()): boolean {
  return where.every((c) => {
    const i = columns.findIndex((col) => col.id === c.field)
    return i < 0 || cellMeets(row.values[i], c, kinds[i], now)
  })
}

/** How two cells order: by `compare`, the one order, on their first values; an empty cell after every other, either way round. */
function cellOrder(a: unknown, b: unknown, desc: boolean): number {
  const x = cells(a)
  const y = cells(b)
  if (!x.length || !y.length) return x.length === y.length ? 0 : x.length ? -1 : 1
  const by = compare(x[0], y[0]) || x.length - y.length
  return desc ? -by : by
}

/** The rows in a view's order: by each column in turn, then as they came. */
export function sortRows(rows: readonly QueryRow[], sort: readonly QuerySort[], columns: readonly QueryColumn[]): QueryRow[] {
  const by = sort.map((s) => ({ i: columns.findIndex((c) => c.id === s.column), desc: !!s.desc })).filter((s) => s.i >= 0)
  if (!by.length) return [...rows]
  return rows
    .map((row, at) => ({ row, at }))
    .sort((a, b) => {
      for (const s of by) {
        const d = cellOrder(a.row.values[s.i], b.row.values[s.i], s.desc)
        if (d) return d
      }
      return a.at - b.at
    })
    .map((x) => x.row)
}

/** What a column adds up to over some rows; null when it has nothing to add up. */
export function totalOf(values: readonly unknown[], total: QueryTotal): number | string | null {
  const all = values.flatMap(cells)
  switch (total) {
    case 'count':
      return values.length
    case 'filled':
      return values.filter((v) => cells(v).length > 0).length
    case 'distinct':
      return new Set(all.map(stable)).size
    case 'sum':
    case 'avg': {
      const nums = all.filter((v): v is number => typeof v === 'number')
      if (!nums.length) return null
      const sum = nums.reduce((s, n) => s + n, 0)
      return total === 'sum' ? sum : sum / nums.length
    }
    case 'min':
    case 'max': {
      if (!all.length) return null
      const sorted = [...all].sort(compare)
      const v = total === 'min' ? sorted[0] : sorted.at(-1)
      return typeof v === 'number' || typeof v === 'string' ? v : textOf(v)
    }
  }
}

/** The ways a column of this kind adds up. */
export function totalsFor(kind: ColumnKind): QueryTotal[] {
  if (kind === 'number') return ['sum', 'avg', 'min', 'max', 'filled', 'distinct', 'count']
  if (kind === 'datetime') return ['min', 'max', 'filled', 'distinct', 'count']
  return ['filled', 'distinct', 'count']
}

/** One group of a grouped answer: the value it holds, how many rows, what each column adds up to, and the groups inside it or its rows. */
export interface AnswerGroup {
  /** The keys of this group and every group round it, outermost first: names it among all the groups. */
  path: (string | null)[]
  column: string
  value: unknown
  count: number
  /** By column id, for the columns the view adds up. */
  totals: Record<string, number | string | null>
  groups: AnswerGroup[] | null
  rows: QueryRow[]
}

/** A group's name among all the groups. */
export const groupId = (path: readonly (string | null)[]): string => JSON.stringify(path)

/** The totals a view asks for over some rows. */
function totalsOver(rows: readonly QueryRow[], totals: Readonly<Record<string, QueryTotal>>, columns: readonly QueryColumn[]): Record<string, number | string | null> {
  const out: Record<string, number | string | null> = {}
  for (const [column, total] of Object.entries(totals)) {
    const i = columns.findIndex((c) => c.id === column)
    if (i >= 0) out[column] = totalOf(rows.map((r) => r.values[i]), total)
  }
  return out
}

function groupRows(rows: readonly QueryRow[], by: readonly string[], columns: readonly QueryColumn[], totals: Readonly<Record<string, QueryTotal>>, sort: readonly QuerySort[], outer: (string | null)[]): AnswerGroup[] {
  const [column, ...rest] = by as [string, ...string[]]
  const i = columns.findIndex((c) => c.id === column)
  const buckets = new Map<string | null, { value: unknown; rows: QueryRow[] }>()
  for (const row of rows) {
    const key = keyOf(row.values[i])
    const bucket = buckets.get(key) ?? { value: row.values[i], rows: [] }
    bucket.rows.push(row)
    buckets.set(key, bucket)
  }
  const order = sort.map((s) => ({ column: s.column, at: columns.findIndex((c) => c.id === s.column), desc: !!s.desc })).filter((s) => s.at >= 0)
  const list = [...buckets].map(([key, b]) => {
    const sums = totalsOver(b.rows, totals, columns)
    return { key, value: b.value, rows: b.rows, totals: sums, order: order.map((s) => (s.column === column ? b.value : s.column in sums ? sums[s.column] : leading(b.rows, s.at, s.desc))) }
  })
  // The group with no value comes last. Otherwise groups follow the view's sort: by the group's own value on its column, and on any other by what the group adds up to there, or its leading row where the view adds nothing up. Biggest first after that.
  list.sort((a, b) => {
    if ((a.key === null) !== (b.key === null)) return a.key === null ? 1 : -1
    for (const [n, s] of order.entries()) {
      const d = cellOrder(a.order[n], b.order[n], s.desc)
      if (d) return d
    }
    return b.rows.length - a.rows.length || cellOrder(a.value, b.value, false)
  })
  return list.map((g) => {
    const path = [...outer, g.key]
    return { path, column, value: g.rows[0]!.values[i], count: g.rows.length, totals: g.totals, groups: rest.length ? groupRows(g.rows, rest, columns, totals, sort, path) : null, rows: g.rows }
  })
}

/** The cell a group leads with in one column's order: its first row, were its rows sorted by that column alone. */
function leading(rows: readonly QueryRow[], at: number, desc: boolean): unknown {
  return rows.reduce<unknown>((best, r) => (cellOrder(r.values[at], best, desc) < 0 ? r.values[at] : best), rows[0]!.values[at])
}

/**
 * What in a view cannot be judged against an answer's columns, said so it can
 * be mended, or null. A condition, a sort, a group, or a total on a column the
 * answer does not hold would be passed over, and a condition that orders a
 * time or a number against a value that is neither would keep or drop every
 * row: both answer a question nobody asked.
 */
export function viewProblem(view: QueryView | undefined, columns: readonly QueryColumn[], kinds: readonly ColumnKind[]): string | null {
  if (!view) return null
  const at = (id: string) => columns.findIndex((c) => c.id === id)
  const named = [...(view.where ?? []).map((c) => c.field), ...(view.sort ?? []).map((s) => s.column), ...(view.group ?? []), ...Object.keys(view.totals ?? {})]
  const missing = named.find((id) => at(id) < 0)
  if (missing !== undefined) return `the view names "${missing}", which is not a column of this answer: add it to columns (the columns are ${columns.map((c) => c.id).join(', ')})`
  for (const c of view.where ?? []) {
    const kind = kinds[at(c.field)]
    if (!ORDERED_OPS.has(c.op)) continue
    if (kind === 'datetime' && Number.isNaN(Date.parse(c.value))) return `the condition on "${c.field}" compares a time with "${c.value}", which is no time: write a date or an ISO time`
    if (kind === 'number' && !Number.isFinite(Number(c.value))) return `the condition on "${c.field}" compares a number with "${c.value}", which is no number`
  }
  return null
}

const ORDERED_OPS: ReadonlySet<string> = new Set(['gt', 'gte', 'lt', 'lte'])

/** An answer as a view shows it: the rows it keeps, in order; the groups, when it groups; and what each column adds up to over every row kept. */
export interface Shaped {
  rows: QueryRow[]
  groups: AnswerGroup[] | null
  totals: Record<string, number | string | null>
}

/** The rows of an answer a view keeps, in its order: what the hub hands on, and the page shows. */
export function keptRows(rows: readonly QueryRow[], view: QueryView | undefined, columns: readonly QueryColumn[], kinds: readonly ColumnKind[], now = Date.now()): QueryRow[] {
  const where = view?.where ?? []
  const kept = where.length ? rows.filter((r) => rowMeets(r, where, columns, kinds, now)) : rows
  return sortRows(kept, view?.sort ?? [], columns)
}

/** An answer shaped by a view: narrowed, ordered, grouped, and added up. */
export function shape(rows: readonly QueryRow[], view: QueryView | undefined, columns: readonly QueryColumn[], kinds: readonly ColumnKind[], now = Date.now()): Shaped {
  const kept = keptRows(rows, view, columns, kinds, now)
  const by = (view?.group ?? []).filter((g) => columns.some((c) => c.id === g))
  const totals = view?.totals ?? {}
  return { rows: kept, groups: by.length ? groupRows(kept, by, columns, totals, view?.sort ?? [], []) : null, totals: totalsOver(kept, totals, columns) }
}

/** How a column's values share out among some rows: the most common first. */
export interface Spread {
  buckets: { key: string | null; value: unknown; label: string; count: number }[]
  /** Rows whose value is not among the buckets. */
  other: number
  /** For numbers and times: the lowest and highest, and how many rows fall in each of `BINS` equal steps between them. */
  range: { min: number; max: number; bins: number[] } | null
}

/** How many steps a range is drawn in. */
export const BINS = 16

/** What a number or a time compares as on a range: the number, or the moment. */
function point(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string') {
    const t = Date.parse(v)
    return Number.isNaN(t) ? null : t
  }
  return null
}

/** How one column's values share out among the rows: each value of a list counts once for its row, and the rows with none are a bucket of their own. */
export function spread(rows: readonly QueryRow[], index: number, kind: ColumnKind, limit = 8): Spread {
  const counts = new Map<string | null, { value: unknown; count: number }>()
  for (const row of rows) {
    const all = cells(row.values[index])
    if (!all.length) {
      const none = counts.get(null) ?? { value: null, count: 0 }
      none.count++
      counts.set(null, none)
    }
    for (const v of new Map(all.map((x) => [stable(x), x])).values()) {
      const key = stable(v)
      const seen = counts.get(key) ?? { value: v, count: 0 }
      seen.count++
      counts.set(key, seen)
    }
  }
  const sorted = [...counts].sort(([ka, a], [kb, b]) => b.count - a.count || (ka === null ? 1 : kb === null ? -1 : compare(a.value, b.value)))
  const shown = sorted.slice(0, limit)
  const buckets = shown.map(([key, b]) => ({ key, value: b.value, label: key === null ? 'No value' : textOf(b.value), count: b.count }))
  let range: Spread['range'] = null
  if (kind === 'number' || kind === 'datetime') {
    const points = rows.flatMap((r) => cells(r.values[index]).map(point)).filter((p): p is number => p !== null)
    if (points.length) {
      const min = Math.min(...points)
      const max = Math.max(...points)
      const bins = new Array<number>(BINS).fill(0)
      for (const p of points) bins[max === min ? 0 : Math.min(BINS - 1, Math.floor(((p - min) / (max - min)) * BINS))]!++
      range = { min, max, bins }
    }
  }
  return { buckets, other: sorted.slice(limit).reduce((s, [, b]) => s + b.count, 0), range }
}
