// What the query page works out of a query, apart from drawing it: the
// columns as one shape whatever the hub was sent, what fills each column in a
// blueprint added later, the colour each blueprint is drawn in, the fields a
// column may read, and how the library is laid out. Pure, and tested alone.

import { QUERY_GROUPS_MAX, RUN_COLUMNS, RUNS_SOURCE, type ChartTotal, type GridClause, type QueryColumn, type QueryColumnSpec, type QueryRow, type QuerySpec, type QueryTotal, type QueryView, type SavedQuery } from '../shared/api.ts'
import { cells, groupId, keyOf, labelOf, META_COLUMNS, metaIn, rowMeets, spread, totalOf, type AnswerGroup, type ColumnKind, type Shaped } from '../shared/answer.ts'
import { opposite, sameClause, withShare } from '../shared/clauses.ts'
import type { Blueprint, ValueColor } from '../shared/model.ts'

/**
 * What a query reads: a blueprint, or the action runs. The runs are no
 * blueprint: they have no fields or relations of their own, only the columns
 * every row has and the run columns (`RUN_COLUMNS`).
 */
export type Readable = Pick<Blueprint, 'id' | 'title' | 'icon' | 'fields' | 'relations'>

/** The action runs as a query reads them. */
export const RUNS: Readable = { id: RUNS_SOURCE, title: 'Action runs', icon: 'history', fields: {}, relations: {} }

/** What a source names, as the page reads it: the runs, or the blueprint the hub holds. */
export const readableOf = (id: string, blueprints: readonly Blueprint[]): Readable | undefined => (id === RUNS_SOURCE ? RUNS : blueprints.find((b) => b.id === id))

/** Whether a column id is one every entity has, by its `$` name. */
export const isMeta = (id: string): boolean => META_COLUMNS.some((m) => m.id === id)

/** Whether a column id is the entity's key, which the page shows as an id. */
export const isKey = (id: string): boolean => id === '$key' || id === 'key'

/** The columns a new query starts with. */
export const START_COLUMNS = ['$type', 'title', '$status']

/**
 * The colours a query's blueprints are drawn in, by their place in it, so
 * every header and row says where it came from. Red and green are left out:
 * they read as a status.
 */
export const SOURCE_HUES: readonly ValueColor[] = ['blue', 'orange', 'purple', 'turquoise', 'pink', 'lime', 'yellow', 'brown']
export const hueOf = (index: number): ValueColor => SOURCE_HUES[index % SOURCE_HUES.length]!

/** Whether a blueprint has a column id: one every entity has, a field, or a relation as `r:<name>`. */
export function has(bp: Readable, id: string): boolean {
  if (metaIn(bp, id)) return true
  if (bp.id === RUNS_SOURCE) return RUN_COLUMNS.some((c) => c.id === id)
  return id.startsWith('r:') ? !!bp.relations[id.slice(2)] : !!bp.fields[id]
}

/** What a blueprint calls a column id. */
export function titleIn(bp: Readable, id: string): string {
  const meta = metaIn(bp, id) ?? (bp.id === RUNS_SOURCE ? RUN_COLUMNS.find((c) => c.id === id) : undefined)
  if (meta) return meta.title
  return id.startsWith('r:') ? (bp.relations[id.slice(2)]?.title ?? id.slice(2)) : (bp.fields[id]?.title ?? id)
}

/**
 * The columns as the page edits them: each names what fills it in each
 * blueprint read. A plain id is the field of that id in every blueprint that
 * has it, titled by the first; one none of them has is dropped, unless every
 * entity has it.
 */
export function editable(columns: QuerySpec['columns'], read: readonly Readable[]): QueryColumnSpec[] {
  const out: QueryColumnSpec[] = []
  for (const c of columns) {
    if (typeof c !== 'string') {
      out.push({ ...c, from: { ...c.from } })
      continue
    }
    const meta = META_COLUMNS.find((m) => m.id === c)
    const having = read.filter((bp) => has(bp, c))
    if (meta || having.length) out.push({ id: c, title: meta?.title ?? titleIn(having[0]!, c), from: Object.fromEntries(having.map((bp) => [bp.id, c])) })
  }
  return dedupe(out)
}

function dedupe(columns: QueryColumnSpec[]): QueryColumnSpec[] {
  const seen = new Set<string>()
  return columns.filter((c) => !seen.has(c.id) && seen.add(c.id))
}

/**
 * The columns once a blueprint joins: each column it has no say in yet reads
 * the id the other blueprints read there, most named first, where the new
 * blueprint has it. Nothing else changes.
 */
export function joined(columns: readonly QueryColumnSpec[], bp: Readable): QueryColumnSpec[] {
  return columns.map((c) => {
    if (c.from[bp.id] !== undefined) return c
    const counts = new Map<string, number>()
    for (const id of Object.values(c.from)) counts.set(id, (counts.get(id) ?? 0) + 1)
    const pick = [...counts].sort((a, b) => b[1] - a[1]).find(([id]) => has(bp, id))?.[0] ?? (counts.size === 0 && has(bp, c.id) ? c.id : undefined)
    return pick ? { ...c, from: { ...c.from, [bp.id]: pick } } : c
  })
}

/** The columns once a blueprint leaves: it fills none of them. */
export function left(columns: readonly QueryColumnSpec[], blueprint: string): QueryColumnSpec[] {
  return columns.map((c) => {
    if (c.from[blueprint] === undefined) return c
    const { [blueprint]: _gone, ...rest } = c.from
    return { ...c, from: rest }
  })
}

/** A new column that reads one id from every blueprint read that has it, under an id no other column holds. */
export function columnFor(id: string, read: readonly Readable[], taken: readonly QueryColumnSpec[]): QueryColumnSpec {
  const having = read.filter((bp) => has(bp, id))
  const ids = new Set(taken.map((c) => c.id))
  let key = id
  for (let n = 2; ids.has(key); n++) key = `${id}~${n}`
  return { id: key, title: having[0] ? titleIn(having[0], id) : id, from: Object.fromEntries(having.map((bp) => [bp.id, id])) }
}

/** One thing a column may read in a blueprint. */
export interface Choice {
  id: string
  title: string
  /** What kind it is: every entity, a field's type, or a relation. */
  kind: string
  group: 'Every entity' | 'Fields' | 'Relations' | 'Run'
}

/** What a column may read in a blueprint: the columns every entity has, then its fields and relations by title. */
export function choicesIn(bp: Readable): Choice[] {
  const byTitle = (a: Choice, b: Choice) => a.title.localeCompare(b.title)
  return [
    ...META_COLUMNS.map((m) => ({ id: m.id, title: m.title, kind: 'every entity', group: 'Every entity' as const })),
    ...(bp.id === RUNS_SOURCE ? RUN_COLUMNS.map((c) => ({ ...c, kind: 'run', group: 'Run' as const })) : []),
    ...Object.entries(bp.fields)
      .map(([id, def]) => ({ id, title: def.title ?? id, kind: def.type, group: 'Fields' as const }))
      .sort(byTitle),
    ...Object.entries(bp.relations)
      .map(([id, def]) => ({ id: `r:${id}`, title: def.title ?? id, kind: 'relation', group: 'Relations' as const }))
      .sort(byTitle),
  ]
}

/** What a column might be added for: each id some blueprint read has and no column reads yet, those every blueprint has first. */
export function addable(read: readonly Readable[], columns: readonly QueryColumnSpec[]): { id: string; title: string; in: string[] }[] {
  const used = new Set(columns.flatMap((c) => Object.values(c.from)))
  const found = new Map<string, { id: string; title: string; in: string[] }>()
  for (const bp of read) {
    for (const choice of choicesIn(bp)) {
      if (used.has(choice.id)) continue
      const known = found.get(choice.id)
      if (known) known.in.push(bp.id)
      else found.set(choice.id, { id: choice.id, title: choice.title, in: [bp.id] })
    }
  }
  return [...found.values()].sort((a, b) => b.in.length - a.in.length || a.title.localeCompare(b.title))
}

/** Whether every field a column reads is a number, so its cells line up on the right. */
export function numeric(column: Pick<QueryColumn, 'from'>, read: readonly Readable[]): boolean {
  const ids = Object.entries(column.from)
  return ids.length > 0 && ids.every(([bp, id]) => read.find((b) => b.id === bp)?.fields[id]?.type === 'number')
}

/** Who may open a saved query. */
export type Sharing = 'private' | 'audience' | 'home' | 'everyone'
export const sharingOf = (q: { shared: boolean; audience: unknown; homeShared: boolean }): Sharing => (q.shared ? 'everyone' : q.audience ? 'audience' : q.homeShared ? 'home' : 'private')

/**
 * What a person is asked before a saved query is removed: whose it is, when it
 * is not theirs, and everyone else it goes from, since a removal cannot be
 * undone and takes it from every library and page that shows it.
 */
export function removeQuestion(q: Pick<SavedQuery, 'title' | 'owner' | 'shared' | 'audience' | 'home' | 'homeShared'>, me: string): string {
  const whose = q.owner === me ? '' : ` It is ${shortName(q.owner)}'s.`
  const home = q.home ? ` It also leaves the page of ${q.home.title}.` : ''
  const who = q.shared ? ' Everyone can open it, so it goes from every library.' : q.audience ? ` ${q.audience.title} can open it, so it goes from their libraries too.` : q.homeShared ? ` The people of ${q.home?.title ?? 'its home'} can open it, so it goes from their libraries too.` : ''
  return `Remove the saved query "${q.title}"?${whose}${who}${home} This cannot be undone.`
}

/** One shelf of the library: a heading and the queries under it. */
export interface Shelf {
  id: string
  title: string
  queries: SavedQuery[]
}

/**
 * The library a person sees: each home's collection, whoever saved its
 * queries (the homes the reader owns first, then the rest by name), then
 * what they saved that has no home, then what others shared with an
 * audience they are in, each audience its own shelf, then what others shared
 * with everyone. An admin may change anyone's query, but only what they
 * saved is theirs here. A shelf with nothing on it is left out.
 */
export function library(queries: readonly SavedQuery[], me: string, find = ''): Shelf[] {
  const words = find.toLowerCase().split(/\s+/).filter(Boolean)
  const shown = queries.filter((q) => words.every((w) => `${q.title} ${q.owner} ${q.audience?.title ?? ''} ${q.home?.title ?? ''}`.toLowerCase().includes(w)))
  const byTitle = (a: SavedQuery, b: SavedQuery) => a.title.localeCompare(b.title)
  const homes = new Map<string, Shelf & { yours: boolean }>()
  for (const q of shown.filter((x) => x.home)) {
    const h = q.home!
    const shelf = homes.get(h.id) ?? { id: `home:${h.id}`, title: h.title, queries: [], yours: h.yours }
    shelf.queries.push(q)
    homes.set(h.id, shelf)
  }
  const loose = shown.filter((q) => !q.home)
  const theirs = loose.filter((q) => q.owner !== me)
  const audiences = new Map<string, Shelf>()
  for (const q of theirs.filter((x) => !x.shared && x.audience)) {
    const a = q.audience!
    const shelf = audiences.get(a.id) ?? { id: `audience:${a.id}`, title: `Shared with ${a.title}`, queries: [] }
    shelf.queries.push(q)
    audiences.set(a.id, shelf)
  }
  const shelves: Shelf[] = [
    ...[...homes.values()].sort((a, b) => Number(b.yours) - Number(a.yours) || a.title.localeCompare(b.title)).map(({ yours: _yours, ...s }) => ({ ...s, queries: s.queries.sort(byTitle) })),
    { id: 'yours', title: 'Your library', queries: loose.filter((q) => q.owner === me).sort(byTitle) },
    ...[...audiences.values()].sort((a, b) => a.title.localeCompare(b.title)).map((s) => ({ ...s, queries: s.queries.sort(byTitle) })),
    { id: 'everyone', title: 'Shared with everyone', queries: theirs.filter((q) => q.shared).sort(byTitle) },
  ]
  return shelves.filter((s) => s.queries.length)
}

/** The name a person goes by in the library: the part of their address before the @. */
export const shortName = (address: string): string => address.split('@')[0] || address

/** One line the answer's grid draws: a group's heading, a row, or a row opened to show the rest of what it holds. */
export type Line = { kind: 'group'; group: AnswerGroup; depth: number; folded: boolean } | { kind: 'row'; row: QueryRow; depth: number; open: boolean } | { kind: 'detail'; row: QueryRow; depth: number }

/** A row's name among every row of an answer. */
export const rowId = (row: Pick<QueryRow, 'blueprint' | 'key'>): string => `${row.blueprint}:${row.key}`

/** The lines a shaped answer draws, top to bottom: each group's heading, then what it holds unless it is folded, and an opened row followed by its detail. */
export function answerLines(shaped: Shaped, folded: ReadonlySet<string>, open: ReadonlySet<string>): Line[] {
  const out: Line[] = []
  const rows = (list: readonly QueryRow[], depth: number) => {
    for (const row of list) {
      const opened = open.has(rowId(row))
      out.push({ kind: 'row', row, depth, open: opened })
      if (opened) out.push({ kind: 'detail', row, depth })
    }
  }
  const groups = (list: readonly AnswerGroup[], depth: number) => {
    for (const group of list) {
      const shut = folded.has(groupId(group.path))
      out.push({ kind: 'group', group, depth, folded: shut })
      if (shut) continue
      if (group.groups) groups(group.groups, depth + 1)
      else rows(group.rows, depth + 1)
    }
  }
  if (shaped.groups) groups(shaped.groups, 0)
  else rows(shaped.rows, 0)
  return out
}

/** The rows a column's values are counted over: those that meet every condition but the column's own, so picking one of its values leaves the others to pick. */
export function rowsBeside(rows: readonly QueryRow[], where: readonly GridClause[], column: string, columns: readonly QueryColumn[], kinds: readonly ColumnKind[], now = Date.now()): readonly QueryRow[] {
  const others = where.filter((c) => c.field !== column)
  return others.length ? rows.filter((r) => rowMeets(r, others, columns, kinds, now)) : rows
}

/** What a condition compares a value as: the text the hub reads back as the same value. */
export function clauseText(value: unknown): string {
  return typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value)
}

/**
 * The conditions after a value of a column is picked: keep the rows holding
 * it, or, `not`, leave them out. The rows with no value are picked as the
 * column not being set. Picking the same again takes it away.
 */
export function pickValue(where: readonly GridClause[], column: string, value: unknown, not: boolean): GridClause[] {
  const set: GridClause = value === null || value === undefined ? { field: column, op: 'exists', value: '', not: true } : { field: column, op: 'eq', value: clauseText(value) }
  return withShare(where, not ? opposite(set) : set)
}

/** The conditions with a column held between two bounds, either left open; what bounded the column before goes. */
export function between(where: readonly GridClause[], column: string, min: string | null, max: string | null): GridClause[] {
  const rest = where.filter((c) => !(c.field === column && (c.op === 'gte' || c.op === 'lte' || c.op === 'gt' || c.op === 'lt') && !c.not))
  return [...rest, ...(min !== null && min !== '' ? [{ field: column, op: 'gte' as const, value: min }] : []), ...(max !== null && max !== '' ? [{ field: column, op: 'lte' as const, value: max }] : [])]
}

/** Whether a condition keeps the rows holding one value of a column, the way `pickValue` makes it. */
export function picks(where: readonly GridClause[], column: string, value: unknown): 'kept' | 'left out' | null {
  const set: GridClause = value === null || value === undefined ? { field: column, op: 'exists', value: '', not: true } : { field: column, op: 'eq', value: clauseText(value) }
  if (where.some((c) => sameClause(c, set))) return 'kept'
  return where.some((c) => sameClause(c, opposite(set))) ? 'left out' : null
}

/** A cell as text, the way the grid writes it and a copy takes it. */
export function cellText(value: unknown): string {
  return labelOf(value)
}

/** How wide each column is drawn, unless a person set it: wide enough for its header and its longest value among the first rows, within bounds the room sets. A longer value wraps. */
export function widthsOf(columns: readonly QueryColumn[], rows: readonly QueryRow[], room: number, set: Readonly<Record<string, number>> = {}): number[] {
  const sample = rows.slice(0, 400)
  return columns.map((c, i) => {
    if (set[c.id]) return set[c.id]!
    const longest = Math.max(c.title.length + 4, ...sample.map((r) => cellText(r.values[i]).length))
    const most = Math.min(c.id === 'title' || isKey(c.id) ? 360 : 280, Math.round(room * (c.id === 'title' ? (room < 640 ? 0.5 : 0.4) : 0.45)))
    return Math.min(most, Math.max(96, Math.round(longest * 7.4) + 28))
  })
}

/** The view with one column's order set: the column alone, low to high or high to low; or none. */
export function sortedBy(view: QueryView | undefined, column: string, desc: boolean | null): QueryView {
  const { sort: _was, ...rest } = view ?? {}
  return desc === null ? rest : { ...rest, sort: [{ column, desc }] }
}

/** The view grouped by one more column, or by one fewer. */
export function groupedBy(view: QueryView | undefined, column: string, on: boolean): QueryView {
  const was = view?.group ?? []
  const group = on ? [...was.filter((g) => g !== column), column].slice(-QUERY_GROUPS_MAX) : was.filter((g) => g !== column)
  const { group: _g, ...rest } = view ?? {}
  return group.length ? { ...rest, group } : rest
}

/** The view with a column adding up one way, or not at all. */
export function totalled(view: QueryView | undefined, column: string, total: QueryTotal | null): QueryView {
  const { [column]: _was, ...others } = view?.totals ?? {}
  const totals = total ? { ...others, [column]: total } : others
  const { totals: _t, ...rest } = view ?? {}
  return Object.keys(totals).length ? { ...rest, totals } : rest
}

/** The view once a column is gone: nothing in it names the column any more. */
export function withoutColumn(view: QueryView | undefined, column: string): QueryView | undefined {
  if (!view) return view
  const out: QueryView = {}
  const where = view.where?.filter((c) => c.field !== column)
  const sort = view.sort?.filter((s) => s.column !== column)
  const group = view.group?.filter((g) => g !== column)
  const { [column]: _t, ...totals } = view.totals ?? {}
  const { [column]: _w, ...widths } = view.widths ?? {}
  if (where?.length) out.where = where
  if (sort?.length) out.sort = sort
  if (group?.length) out.group = group
  if (Object.keys(totals).length) out.totals = totals
  if (Object.keys(widths).length) out.widths = widths
  return Object.keys(out).length ? out : undefined
}

/** What a total is called. */
export const TOTAL_WORDS: Readonly<Record<QueryTotal, string>> = { count: 'Rows', filled: 'Rows with a value', distinct: 'Different values', sum: 'Sum', avg: 'Average', min: 'Lowest', max: 'Highest' }

/** Splitting the chart's bars by this column splits them by the blueprint each row came from, whether or not the answer shows it. */
export const BY_BLUEPRINT = '$type'

/** What the chart draws, every part decided: a bar per value of `by`, as long as `total` over `column` (none when it counts rows), split by `split`. */
export interface ChartPlan {
  by: string
  total: ChartTotal
  column: string | null
  split: string | null
}

const STACKS: ReadonlySet<ChartTotal> = new Set(['count', 'sum'])

/**
 * The chart a query's view asks for, with what it leaves out worked out from
 * the rest of the view: bars for the first group, else for the first column
 * that shares out among a few values; as long as the first number the view
 * adds up (a sum, a mean, a highest, or a lowest), else the rows; split by the
 * second group, else by blueprint where it reads several. Only a count or a
 * sum is split, since only they add up along a bar.
 */
export function chartPlan(view: QueryView | undefined, columns: readonly QueryColumn[], kinds: readonly ColumnKind[], rows: readonly QueryRow[], sources: number): ChartPlan {
  const at = (id: string | undefined | null) => (id ? columns.findIndex((c) => c.id === id) : -1)
  const asked = view?.chart
  const shares = (i: number) => kinds[i] !== 'number' && kinds[i] !== 'datetime'
  const by =
    [asked?.by, view?.group?.[0]].find((id) => at(id) >= 0) ??
    columns.find((c, i) => c.id !== 'title' && !isKey(c.id) && c.id !== '$type' && shares(i) && spread(rows, i, kinds[i], 25).buckets.length >= 3)?.id ??
    columns.find((c) => c.id === '$type')?.id ??
    columns[0]?.id ??
    ''
  const numeric = (id: string | undefined | null) => kinds[at(id)] === 'number'
  let total: ChartTotal = 'count'
  let column: string | null = null
  if (asked?.total && (asked.total === 'count' || numeric(asked.column))) {
    total = asked.total
    column = asked.total === 'count' ? null : asked.column!
  } else if (!asked?.total) {
    const first = Object.entries(view?.totals ?? {}).find(([c, t]) => t !== 'count' && t !== 'filled' && t !== 'distinct' && numeric(c))
    if (first) [column, total] = [first[0], first[1] as ChartTotal]
  }
  const valid = (id: string | undefined | null) => !!id && id !== by && (id === BY_BLUEPRINT || at(id) >= 0)
  const split = !STACKS.has(total) || asked?.split === null ? null : valid(asked?.split) ? asked!.split! : asked?.split === undefined && valid(view?.group?.[1]) ? view!.group![1]! : sources > 1 && by !== BY_BLUEPRINT ? BY_BLUEPRINT : null
  return { by, total, column, split }
}

/** One bar of the chart: a value of the column it is drawn by, its length, and the parts it is split into, in the chart's order of parts. */
export interface Bar {
  key: string | null
  value: unknown
  label: string
  amount: number
  parts: { key: string; amount: number }[]
  /** The blueprint every row of the bar came from, when they all came from one. */
  blueprint: string | null
}

/** The chart's bars, longest first and the rows with no value last, at most `limit` of them; how many more there are; what every row adds up to; and the parts in order, largest first, each with a label. */
export interface Chart {
  bars: Bar[]
  more: number
  whole: number
  parts: { key: string; label: string }[]
}

/** The bars a plan draws over the rows a view keeps. A row holding several values of `by` stands in each of their bars. */
export function chartBars(rows: readonly QueryRow[], columns: readonly QueryColumn[], plan: ChartPlan, limit = 24): Chart {
  const at = (id: string | null) => (id ? columns.findIndex((c) => c.id === id) : -1)
  const byAt = at(plan.by)
  const valueAt = at(plan.column)
  const splitAt = plan.split === BY_BLUEPRINT ? -1 : at(plan.split)
  const amount = (list: readonly QueryRow[]): number => {
    if (plan.total === 'count') return list.length
    const t = totalOf(list.map((r) => r.values[valueAt]), plan.total)
    return typeof t === 'number' ? t : 0
  }
  const partOf = (r: QueryRow): { key: string; label: string } => {
    if (plan.split === BY_BLUEPRINT) return { key: r.blueprint, label: r.blueprint }
    const v = r.values[splitAt]
    return { key: keyOf(v) ?? '', label: cells(v).length ? labelOf(v) : 'No value' }
  }
  const held = new Map<string | null, { value: unknown; rows: QueryRow[] }>()
  for (const r of rows) {
    const all = byAt < 0 ? [] : cells(r.values[byAt])
    for (const v of all.length ? all : [null]) {
      const key = v === null ? null : keyOf(v)
      const bar = held.get(key) ?? { value: v, rows: [] }
      bar.rows.push(r)
      held.set(key, bar)
    }
  }
  const labels = new Map<string, string>()
  const partTotals = new Map<string, QueryRow[]>()
  if (plan.split) for (const r of rows) {
    const p = partOf(r)
    labels.set(p.key, p.label)
    partTotals.set(p.key, [...(partTotals.get(p.key) ?? []), r])
  }
  const parts = [...partTotals.entries()].map(([key, list]) => ({ key, amount: amount(list) })).sort((a, b) => b.amount - a.amount || a.key.localeCompare(b.key)).map(({ key }) => ({ key, label: labels.get(key) ?? key }))
  const bars: Bar[] = [...held.entries()].map(([key, { value, rows: list }]) => {
    const byPart = new Map<string, QueryRow[]>()
    if (plan.split) for (const r of list) byPart.set(partOf(r).key, [...(byPart.get(partOf(r).key) ?? []), r])
    const from = new Set(list.map((r) => r.blueprint))
    return { key, value, label: key === null ? 'No value' : labelOf(value), amount: amount(list), parts: parts.filter((p) => byPart.has(p.key)).map((p) => ({ key: p.key, amount: amount(byPart.get(p.key)!) })), blueprint: from.size === 1 ? [...from][0]! : null }
  })
  bars.sort((a, b) => (a.key === null ? 1 : 0) - (b.key === null ? 1 : 0) || b.amount - a.amount || a.label.localeCompare(b.label))
  return { bars: bars.slice(0, limit), more: Math.max(0, bars.length - limit), whole: amount(rows), parts }
}

/**
 * A query as one reader is shown it: without the blueprints they may not see,
 * which are left out, never named. A change they make keeps those sources as
 * they were, in their places, so it never takes from the query what its
 * owner put there. Until the reader's blueprints are known, nothing is left out.
 */
export function seenSources<D extends Pick<QuerySpec, 'sources'>>(draft: D, sees: ((blueprint: string) => boolean) | null): { shown: D; back: (next: D) => D } {
  if (!sees) return { shown: draft, back: (next) => next }
  const seen = (s: QuerySpec['sources'][number]) => s.blueprint === RUNS_SOURCE || sees(s.blueprint)
  const hidden = draft.sources.filter((s) => !seen(s))
  if (!hidden.length) return { shown: draft, back: (next) => next }
  return { shown: { ...draft, sources: draft.sources.filter(seen) }, back: (next) => ({ ...next, sources: [...next.sources, ...hidden.filter((h) => !next.sources.some((s) => s.blueprint === h.blueprint))] }) }
}
