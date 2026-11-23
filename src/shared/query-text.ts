// A query as text: the Text side of the query page's Simple / Text switch.
// A small pipe language read top to bottom, in the manner of Kusto:
//
//   from Repository
//     | where $status != "green" and days_idle > 90
//     | where r:team none (name == "Platform")
//     | states active, missing
//   from "Action runs"
//     | search "deploy"
//   columns title, $status as "Status", r:team.department@name,
//     col owner as "Owner" from (Repository = r:team, Service = r:team)
//   where language in ("Go", "C#")
//   sort by days_idle desc, title
//   group by language
//   total open_alerts sum, days_idle avg
//   chart sum open_alerts by language split by $type
//   widths title 320
//
// A blueprint is named by its title or its id; a field always by its id, so
// the text says exactly what it reads. `printQuery` writes any query, and
// `parseQuery` reads it back to the same query, once `normalizeQuery` has
// put it in the one form both share. Pure: the hub decides what a field id
// means, so an unknown one is not an error here; an unknown blueprint is.

import { CHART_TOTALS, QUERY_TOTALS, RELATION_MATCHES, type ChartTotal, type QueryChart, RUNS_SOURCE, type GridClause, type QueryColumnSpec, type QuerySort, type QuerySource, type QuerySpec, type QueryTotal, type QueryView, type RelationMatch } from './api.ts'
import { ENTITY_STATES, type EntityState } from './model.ts'
import { listOf } from './clauses.ts'

/** The blueprints the text may name, by title or id. */
export interface Names {
  blueprints: readonly { id: string; title: string }[]
}

/** Where reading the text stopped, and why: its line and column 1-based, and `at` the offset into the text. */
export interface QueryTextError {
  message: string
  line: number
  column: number
  at: number
}

/**
 * What a field or column id in the text is read against. `filter` is a
 * condition on a source: a field of its blueprint, or of what the relation
 * fields in `path` reach from it, in turn. `pick` is a column a source fills:
 * one of the blueprints' fields, relations, or the columns every entity has.
 * `column` is one of the query's own columns, which the view reads: `ids`
 * are those the text has named so far, empty where it names none, and
 * `blueprints` what the query reads.
 */
export type QueryScope = { kind: 'filter'; blueprints: string[]; path: string[] } | { kind: 'pick'; blueprints: string[] } | { kind: 'column'; ids: string[]; blueprints: string[] }

/**
 * What the text could go on with where it ends: a word the language keeps, a
 * symbol, a blueprint, a field or column in a scope, a value of one, or a
 * state. The editor offers these as the text is typed.
 */
export type QueryExpected =
  | { kind: 'keyword'; word: string }
  | { kind: 'symbol'; symbol: string }
  | { kind: 'blueprint' }
  | { kind: 'field'; scope: QueryScope }
  | { kind: 'value'; field: string; scope: QueryScope }

/** A name the text read, where it stands (`from` to `to`, offsets): a blueprint by its id, or a field or column in its scope. */
export type QueryMark = { kind: 'blueprint'; from: number; to: number; id: string } | { kind: 'field'; from: number; to: number; id: string; scope: QueryScope }


/** What the runs source is called in the text; `$runs` reads as it too. */
const RUNS_TITLE = 'Action runs'

/** The words the language keeps for itself: a field of one of these names is written in backticks. */
const RESERVED: ReadonlySet<string> = new Set(['from', 'where', 'columns', 'col', 'as', 'sort', 'by', 'group', 'total', 'chart', 'split', 'widths', 'and', 'not', 'has', 'in', 'contains', 'startswith', 'within', 'older', 'any', 'all', 'none', 'search', 'states', 'hidden', 'asc', 'desc', 'true', 'false', 'null'])

/** The words the language keeps for itself, for an editor to colour. */
export const QUERY_KEYWORDS: readonly string[] = [...RESERVED]

/** The comparisons written as symbols, longest first so `>=` is read before `>`. */
const SYMBOLS: readonly [string, GridClause['op']][] = [
  ['==', 'eq'],
  ['!=', 'neq'],
  ['>=', 'gte'],
  ['<=', 'lte'],
  ['>', 'gt'],
  ['<', 'lt'],
]
/** The comparisons written as words. */
const WORDS: readonly [string, GridClause['op']][] = [
  ['contains', 'contains'],
  ['startswith', 'prefix'],
  ['within', 'within'],
  ['older', 'older'],
]

// Normal form -----------------------------------------------------------------

/**
 * The one form a query is printed from and read back as. A condition with no
 * field is dropped; `exists` keeps no value; a relation condition that tests
 * what it reaches (`where` or `match`) has both, `match` any when unsaid, and
 * is `exists` with no value; a `not` or `hidden` or `desc` that is false is
 * left out; and a view, or a part of one, that holds nothing is left out.
 */
export function normalizeQuery(spec: QuerySpec): QuerySpec {
  const sources = spec.sources.map((s): QuerySource => ({
    blueprint: s.blueprint,
    clauses: normalClauses(s.clauses),
    ...(s.search !== undefined ? { search: s.search } : {}),
    ...(s.states !== undefined ? { states: [...s.states] } : {}),
    ...(s.hidden ? { hidden: true } : {}),
  }))
  const columns = spec.columns.map((c) => (typeof c === 'string' ? c : { id: c.id, title: c.title, from: { ...c.from } }))
  const view = normalView(spec.view)
  return { sources, columns, ...(view ? { view } : {}) }
}

function normalClauses(clauses: readonly GridClause[]): GridClause[] {
  return clauses.filter((c) => c.field).map(normalClause)
}

function normalClause(c: GridClause): GridClause {
  if (c.where !== undefined || c.match !== undefined) return { field: c.field, op: 'exists', value: '', ...(c.not ? { not: true } : {}), where: normalClauses(c.where ?? []), match: c.match ?? 'any' }
  return { field: c.field, op: c.op, value: c.op === 'exists' ? '' : c.value, ...(c.not ? { not: true } : {}) }
}

function normalView(view: QueryView | undefined): QueryView | undefined {
  if (!view) return undefined
  const out: QueryView = {}
  const where = normalClauses(view.where ?? [])
  if (where.length) out.where = where
  if (view.sort?.length) out.sort = view.sort.map((s): QuerySort => ({ column: s.column, ...(s.desc ? { desc: true } : {}) }))
  if (view.group?.length) out.group = [...view.group]
  if (view.totals && Object.keys(view.totals).length) out.totals = { ...view.totals }
  if (view.widths && Object.keys(view.widths).length) out.widths = { ...view.widths }
  const chart = normalChart(view.chart)
  if (chart) out.chart = chart
  return Object.keys(out).length ? out : undefined
}

/** A chart as the text says it: a total over a column only where the total reads one, and nothing where nothing was picked. */
function normalChart(c: QueryChart | undefined): QueryChart | undefined {
  if (!c) return undefined
  const out: QueryChart = {}
  if (c.total) out.total = c.total
  if (c.total && c.total !== 'count' && c.column) out.column = c.column
  if (c.by) out.by = c.by
  if (c.split !== undefined) out.split = c.split
  return Object.keys(out).length ? out : undefined
}

// Printing --------------------------------------------------------------------

/** Where an identifier written bare ends, from `at`: as the reader reads one. */
function identEnd(text: string, at: number): number {
  if (!/[A-Za-z_$]/.test(text[at] ?? '')) return at
  let i = at + 1
  for (;;) {
    const ch = text[i] ?? ''
    if (/[A-Za-z0-9_$:.@-]/.test(ch)) i++
    else if (ch === '<' && text[i + 1] === '-' && (text[i - 1] === ':' || text[i - 1] === '.')) i += 2
    else return i
  }
}

/** A field or column id as the text writes it: bare when it reads back bare, else in backticks. */
export function ident(id: string): string {
  if (id && identEnd(id, 0) === id.length && !RESERVED.has(id)) return id
  return '`' + id.replace(/[\\`]/g, (ch) => '\\' + ch) + '`'
}

/** A blueprint as the text names it: its title when that names it alone, else its id. */
export function blueprintName(id: string, names: Names): string {
  if (id === RUNS_SOURCE) return JSON.stringify(RUNS_TITLE)
  const bp = names.blueprints.find((b) => b.id === id)
  const title = bp?.title
  const alone = title !== undefined && title.toLowerCase() !== RUNS_TITLE.toLowerCase() && title !== RUNS_SOURCE && names.blueprints.filter((b) => b.title.toLowerCase() === title.toLowerCase() || b.id === title).length === 1
  const name = alone ? title : id
  return identEnd(name, 0) === name.length && name && !RESERVED.has(name) ? name : JSON.stringify(name)
}

/** A condition's value as the text writes it: a number, a boolean, or a span bare when that is what it reads as, else quoted. */
function value(v: string, op: GridClause['op']): string {
  if (/^-?\d+(\.\d+)?$/.test(v) || v === 'true' || v === 'false') return v
  if ((op === 'within' || op === 'older') && /^\d+(\.\d+)?[A-Za-z]+$/.test(v)) return v
  return JSON.stringify(v)
}

/** The items of an `in` condition's value, when it is a list written exactly as JSON writes one. */
function clauseText(c: GridClause): string {
  const not = c.not ? 'not ' : ''
  if (c.where !== undefined || c.match !== undefined) return `${not}${ident(c.field)} ${c.match ?? 'any'} (${(c.where ?? []).map(clauseText).join(' and ')})`
  if (c.op === 'exists') return `${not}has ${ident(c.field)}`
  if (c.op === 'in') {
    const items = listOf(c.value)
    return `${not}${ident(c.field)} in ${items ? `(${items.map((x) => JSON.stringify(x)).join(', ')})` : JSON.stringify(c.value)}`
  }
  const symbol = SYMBOLS.find(([, op]) => op === c.op)?.[0] ?? WORDS.find(([, op]) => op === c.op)![0]
  return `${not}${ident(c.field)} ${symbol} ${value(c.value, c.op)}`
}

/** A source's conditions as `| where` lines: plain ones joined by `and`, each that tests what a relation reaches on a line of its own, in their order. */
function whereLines(clauses: readonly GridClause[]): string[] {
  const lines: string[] = []
  let run: string[] = []
  for (const c of clauses) {
    if (c.where !== undefined || c.match !== undefined) {
      if (run.length) lines.push(run.join(' and '))
      run = []
      lines.push(clauseText(c))
    } else run.push(clauseText(c))
  }
  if (run.length) lines.push(run.join(' and '))
  return lines
}

/** Items after a keyword, wrapped where a line grows long. */
function listed(head: string, items: readonly string[]): string {
  let out = head
  let line = head.length
  items.forEach((item, i) => {
    const piece = (i ? ', ' : ' ') + item
    if (i && line + piece.length > 88) {
      out += ',\n  ' + item
      line = 2 + item.length
    } else {
      out += piece
      line += piece.length
    }
  })
  return out
}

/** Writes a query as text. */
export function printQuery(spec: QuerySpec, names: Names): string {
  const q = normalizeQuery(spec)
  const out: string[] = []
  for (const s of q.sources) {
    out.push(`from ${blueprintName(s.blueprint, names)}`)
    for (const line of whereLines(s.clauses)) out.push(`  | where ${line}`)
    if (s.search !== undefined) out.push(`  | search ${JSON.stringify(s.search)}`)
    if (s.states !== undefined) out.push(`  | states ${s.states.length ? s.states.join(', ') : '()'}`)
    if (s.hidden) out.push('  | hidden')
  }
  const sourceIds = q.sources.map((s) => s.blueprint)
  if (q.columns.length) {
    out.push(
      listed(
        'columns',
        q.columns.map((c) => {
          if (typeof c === 'string') return ident(c)
          const entries = Object.entries(c.from)
          const everywhere = new Set(sourceIds)
          const short = entries.length === everywhere.size && entries.every(([bp, id]) => everywhere.has(bp) && id === c.id)
          if (short) return `${ident(c.id)} as ${JSON.stringify(c.title)}`
          return `col ${ident(c.id)} as ${JSON.stringify(c.title)} from (${entries.map(([bp, id]) => `${blueprintName(bp, names)} = ${ident(id)}`).join(', ')})`
        }),
      ),
    )
  }
  const v = q.view
  if (v?.where) out.push(`where ${v.where.map(clauseText).join(' and ')}`)
  if (v?.sort) out.push(listed('sort by', v.sort.map((s) => `${ident(s.column)}${s.desc ? ' desc' : ''}`)))
  if (v?.group) out.push(listed('group by', v.group.map(ident)))
  if (v?.totals) out.push(listed('total', Object.entries(v.totals).map(([c, t]) => `${ident(c)} ${t}`)))
  if (v?.chart) out.push(chartText(v.chart))
  if (v?.widths) out.push(listed('widths', Object.entries(v.widths).map(([c, w]) => `${ident(c)} ${w}`)))
  return out.join('\n') + (out.length ? '\n' : '')
}

function chartText(c: QueryChart): string {
  const parts = ['chart']
  if (c.total) parts.push(c.total === 'count' || !c.column ? c.total : `${c.total} ${ident(c.column)}`)
  if (c.by) parts.push(`by ${ident(c.by)}`)
  if (c.split !== undefined) parts.push(c.split === null ? 'split none' : `split by ${ident(c.split)}`)
  return parts.join(' ')
}

// Reading ---------------------------------------------------------------------

class Stop extends Error {
  readonly at: number
  constructor(message: string, at: number) {
    super(message)
    this.at = at
  }
}

class Reader {
  private readonly text: string
  pos = 0
  /** What the text could go on with where it ends, noted by each read that reached the end. */
  readonly expected: QueryExpected[] = []
  /** Every name read, where it stands. */
  readonly marks: QueryMark[] = []
  constructor(text: string) {
    this.text = text
  }

  /** Notes what could come next, when the reading stands at the end of the text. */
  hope(e: QueryExpected): void {
    this.skip()
    if (this.pos >= this.text.length) this.expected.push(e)
  }

  /** Steps over spaces, line ends, and `//` comments. */
  skip(): void {
    for (;;) {
      const ch = this.text[this.pos]
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') this.pos++
      else if (ch === '/' && this.text[this.pos + 1] === '/') while (this.pos < this.text.length && this.text[this.pos] !== '\n') this.pos++
      else return
    }
  }

  done(): boolean {
    this.skip()
    return this.pos >= this.text.length
  }

  /** What stands next, for an error: a word, a symbol, or the end. */
  next(): string {
    this.skip()
    if (this.pos >= this.text.length) return 'the end'
    let end = identEnd(this.text, this.pos)
    if (end === this.pos) while (end < this.text.length && /[A-Za-z0-9_.+:-]/.test(this.text[end]!)) end++
    const piece = end > this.pos ? this.text.slice(this.pos, end) : this.text[this.pos]!
    return `"${piece.length > 24 ? piece.slice(0, 24) + '…' : piece}"`
  }

  fail(expected: string, at = (this.skip(), this.pos)): never {
    this.pos = at
    throw new Stop(`Expected ${expected}, found ${this.next()}`, at)
  }

  /** The bare word next, if it is this keyword: consumed. */
  word(k: string): boolean {
    this.hope({ kind: 'keyword', word: k })
    if (this.text[this.pos] === '`') return false
    const end = identEnd(this.text, this.pos)
    if (this.text.slice(this.pos, end) !== k) return false
    this.pos = end
    return true
  }

  /** The character next, after any space. */
  peekChar(): string {
    this.skip()
    return this.text[this.pos] ?? ''
  }

  /** The bare word next, unconsumed. */
  peekWord(): string {
    this.skip()
    return this.text[this.pos] === '`' ? '' : this.text.slice(this.pos, identEnd(this.text, this.pos))
  }

  symbol(s: string): boolean {
    this.hope({ kind: 'symbol', symbol: s })
    if (!this.text.startsWith(s, this.pos)) return false
    this.pos += s.length
    return true
  }

  expect(s: string, what = `"${s}"`): void {
    if (!this.symbol(s)) this.fail(what)
  }

  expectWord(k: string): void {
    if (!this.word(k)) this.fail(`"${k}"`)
  }

  /** A field or column id, bare or in backticks, marked where it stands when a scope says what it is read against. */
  ident(what = 'a field', scope?: QueryScope): string {
    this.skip()
    if (scope) this.hope({ kind: 'field', scope })
    const start = this.pos
    const id = this.identAt(start, what)
    if (scope) this.marks.push({ kind: 'field', from: start, to: this.pos, id, scope })
    return id
  }

  private identAt(start: number, what: string): string {
    if (this.text[start] === '`') {
      let out = ''
      let i = start + 1
      for (;;) {
        const ch = this.text[i]
        if (ch === undefined) throw new Stop('This name in backticks never ends: add the closing `', start)
        if (ch === '`') break
        if (ch === '\\' && (this.text[i + 1] === '`' || this.text[i + 1] === '\\')) {
          out += this.text[i + 1]
          i += 2
        } else {
          out += ch
          i++
        }
      }
      this.pos = i + 1
      return out
    }
    const end = identEnd(this.text, start)
    const id = this.text.slice(start, end)
    if (!id || RESERVED.has(id)) this.fail(what, start)
    this.pos = end
    return id
  }

  /** A double-quoted text, with JSON's escapes. */
  string(what = 'a text in double quotes'): string {
    this.skip()
    const start = this.pos
    if (this.text[start] !== '"') this.fail(what)
    let i = start + 1
    for (;;) {
      const ch = this.text[i]
      if (ch === undefined || ch === '\n') throw new Stop('This text never ends: add the closing "', start)
      if (ch === '"') break
      i += ch === '\\' ? 2 : 1
    }
    try {
      const out = JSON.parse(this.text.slice(start, i + 1)) as string
      this.pos = i + 1
      return out
    } catch {
      throw new Stop('This text holds an escape that is not one: use \\" \\\\ \\n \\t or \\uXXXX', start)
    }
  }

  /** A value written bare: a number, a boolean, or a span such as 30d. */
  bare(): string {
    this.skip()
    const start = this.pos
    while (/[A-Za-z0-9_.+:-]/.test(this.text[this.pos] ?? '')) this.pos++
    if (this.pos === start) this.fail('a value: a number, true or false, or a text in double quotes')
    return this.text.slice(start, this.pos)
  }

  /** The value a condition on a field tests against. */
  value(field: string, scope: QueryScope): string {
    this.hope({ kind: 'value', field, scope })
    return this.text[this.pos] === '"' ? this.string() : this.bare()
  }

  /** A whole number. */
  number(): number {
    const start = (this.skip(), this.pos)
    const raw = this.bare()
    if (!/^\d+$/.test(raw)) this.fail('a whole number of pixels', start)
    return Number(raw)
  }

  /** A blueprint's name, bare or in double quotes, and the blueprint it stands for, marked where it stands. */
  blueprint(names: Names): string {
    const named = this.name()
    const id = resolve(named, names)
    this.marks.push({ kind: 'blueprint', from: named.at, to: this.pos, id })
    return id
  }

  private name(): { name: string; at: number } {
    this.hope({ kind: 'blueprint' })
    const at = this.pos
    if (this.text[at] === '"') return { name: this.string('a blueprint'), at }
    const end = identEnd(this.text, at)
    const name = this.text.slice(at, end)
    if (!name || RESERVED.has(name)) this.fail('a blueprint, by its title or id', at)
    this.pos = end
    return { name, at }
  }
}

/** The blueprint a name in the text stands for. */
function resolve({ name, at }: { name: string; at: number }, names: Names): string {
  if (name === RUNS_SOURCE || name.toLowerCase() === RUNS_TITLE.toLowerCase()) return RUNS_SOURCE
  if (names.blueprints.some((b) => b.id === name)) return name
  const titled = names.blueprints.filter((b) => b.title.toLowerCase() === name.toLowerCase())
  if (titled.length === 1) return titled[0]!.id
  if (titled.length > 1) throw new Stop(`"${name}" is the title of ${titled.length} blueprints: name one by its id (${titled.map((b) => b.id).join(', ')})`, at)
  throw new Stop(`There is no blueprint "${name}"`, at)
}

/** Conditions joined by `and`, on fields read against a scope. */
function conditions(r: Reader, scope: QueryScope): GridClause[] {
  const out = [condition(r, scope)]
  while (r.word('and')) out.push(condition(r, scope))
  return out
}

/** Where the conditions inside a relation's brackets are read: on what it reaches. */
function inside(scope: QueryScope, field: string): QueryScope {
  return scope.kind === 'filter' ? { ...scope, path: [...scope.path, field] } : scope
}

function condition(r: Reader, scope: QueryScope): GridClause {
  const not = r.word('not')
  const turned = not ? { not: true as const } : {}
  if (r.word('has')) return { field: r.ident('a field', scope), op: 'exists', value: '', ...turned }
  const field = r.ident('a condition: a field and a test, such as days_idle > 90', scope)
  for (const [symbol, op] of SYMBOLS) if (r.symbol(symbol)) return { field, op, value: r.value(field, scope), ...turned }
  for (const [word, op] of WORDS) if (r.word(word)) return { field, op, value: r.value(field, scope), ...turned }
  if (r.word('in')) {
    if (!r.symbol('(')) return { field, op: 'in', value: r.string('a list in brackets, such as ("Go", "C#")'), ...turned }
    const items: (string | number | boolean | null)[] = []
    if (!r.symbol(')')) {
      do {
        r.hope({ kind: 'value', field, scope })
        const quoted = r.peekChar() === '"'
        const at = r.pos
        const raw = quoted ? r.string() : r.bare()
        if (quoted) items.push(raw)
        else if (raw === 'true' || raw === 'false') items.push(raw === 'true')
        else if (raw === 'null') items.push(null)
        else if (Number.isFinite(Number(raw)) && raw.trim() !== '') items.push(Number(raw))
        else r.fail('a number, true, false, null, or a text in double quotes', at)
      } while (r.symbol(','))
      r.expect(')', '"," or ")"')
    }
    return { field, op: 'in', value: JSON.stringify(items), ...turned }
  }
  const match = RELATION_MATCHES.find((m) => r.word(m))
  if (match) {
    r.expect('(', '"(" and the conditions what it reaches must meet')
    const where = r.symbol(')') ? [] : conditions(r, inside(scope, field))
    if (where.length && !r.symbol(')')) r.fail('"and" or ")"')
    return { field, op: 'exists', value: '', ...turned, where, match: match as RelationMatch }
  }
  return r.fail('a test: ==, !=, >, >=, <, <=, contains, startswith, in, within, older, or any, all, none and conditions in brackets')
}

/** One of a fixed set of words, noted as what could come next. */
function oneOf<T extends string>(r: Reader, words: readonly T[], what: string): T {
  for (const w of words) r.hope({ kind: 'keyword', word: w })
  r.skip()
  const at = r.pos
  const w = r.peekWord()
  if (!(words as readonly string[]).includes(w)) r.fail(what, at)
  r.word(w)
  return w as T
}

/** A query read from text: the query, or where and why it could not be, with every name read and what could come where the text ends. */
export interface QueryReading {
  result: { spec: QuerySpec } | { error: QueryTextError }
  /** Every blueprint, field, and column named, where it stands, as far as the reading got. */
  marks: QueryMark[]
  /** What the text could go on with where it ends; read the text up to a point to learn what fits there. */
  expected: QueryExpected[]
}

/** Reads a query from text, or says where and why it could not. */
export function parseQuery(text: string, names: Names): { spec: QuerySpec } | { error: QueryTextError } {
  return readQuery(text, names).result
}

/** Reads a query from text, noting every name it read and what could come where the text ends. */
export function readQuery(text: string, names: Names): QueryReading {
  const r = new Reader(text)
  const done = (result: QueryReading['result']): QueryReading => ({ result, marks: r.marks, expected: r.expected })
  try {
    const sources: QuerySource[] = []
    while (r.word('from')) {
      const source: QuerySource = { blueprint: r.blueprint(names), clauses: [] }
      const scope: QueryScope = { kind: 'filter', blueprints: [source.blueprint], path: [] }
      while (r.symbol('|')) {
        if (r.word('where')) source.clauses.push(...conditions(r, scope))
        else if (r.word('search')) source.search = r.string('the text to search for, in double quotes')
        else if (r.word('states')) {
          const states: EntityState[] = []
          if (r.symbol('(')) r.expect(')', '")": an empty list of states is written ()')
          else
            do states.push(oneOf(r, ENTITY_STATES, `a state: ${ENTITY_STATES.join(', ')}`))
            while (r.symbol(','))
          source.states = states
        } else if (r.word('hidden')) source.hidden = true
        else r.fail('where, search, states, or hidden after "|"')
      }
      sources.push(source)
    }
    const read = sources.map((s) => s.blueprint)
    const columns: QuerySpec['columns'] = []
    if (r.word('columns')) {
      do {
        if (r.word('col')) {
          const id = r.ident('the column\'s id')
          r.expectWord('as')
          const title = r.string('the column\'s title in double quotes')
          r.expectWord('from')
          r.expect('(', '"(" and what fills the column in each blueprint')
          const from: Record<string, string> = {}
          if (!r.symbol(')')) {
            do {
              const bp = r.blueprint(names)
              r.expect('=', '"=" and the field that fills the column there')
              from[bp] = r.ident('a field', { kind: 'pick', blueprints: [bp] })
            } while (r.symbol(','))
            r.expect(')', '"," or ")"')
          }
          columns.push({ id, title, from } satisfies QueryColumnSpec)
        } else {
          const id = r.ident('a column: a field, a relation path, or col', { kind: 'pick', blueprints: read })
          if (r.word('as')) columns.push({ id, title: r.string('the column\'s title in double quotes'), from: Object.fromEntries(sources.map((s) => [s.blueprint, id])) })
          else columns.push(id)
        }
      } while (r.symbol(','))
    }
    const own: QueryScope = { kind: 'column', ids: columns.map((c) => (typeof c === 'string' ? c : c.id)), blueprints: read }
    const view: QueryView = {}
    for (;;) {
      if (r.word('where')) view.where = [...(view.where ?? []), ...conditions(r, own)]
      else if (r.word('sort')) {
        r.expectWord('by')
        const sort = view.sort ?? []
        do {
          const column = r.ident('a column to sort by', own)
          if (r.word('desc')) sort.push({ column, desc: true })
          else {
            r.word('asc')
            sort.push({ column })
          }
        } while (r.symbol(','))
        view.sort = sort
      } else if (r.word('group')) {
        r.expectWord('by')
        const group = view.group ?? []
        do group.push(r.ident('a column to group by', own))
        while (r.symbol(','))
        view.group = group
      } else if (r.word('total')) {
        const totals: Record<string, QueryTotal> = view.totals ?? {}
        do {
          const column = r.ident('a column to add up', own)
          totals[column] = oneOf(r, QUERY_TOTALS, `how it adds up: ${QUERY_TOTALS.join(', ')}`)
        } while (r.symbol(','))
        view.totals = totals
      } else if (r.word('chart')) {
        const chart: QueryChart = {}
        for (const w of [...CHART_TOTALS, 'by', 'split']) r.hope({ kind: 'keyword', word: w })
        r.skip()
        const at = r.pos
        const t = r.peekWord()
        if ((CHART_TOTALS as readonly string[]).includes(t)) {
          r.word(t)
          chart.total = t as ChartTotal
          if (t !== 'count') chart.column = r.ident('a number column to add up', own)
        } else if (t !== 'by' && t !== 'split') r.fail(`how long a bar is (${CHART_TOTALS.join(', ')}), by, or split`, at)
        if (r.word('by')) chart.by = r.ident('a column to draw a bar for each value of', own)
        if (r.word('split')) {
          if (r.word('none')) chart.split = null
          else {
            r.expectWord('by')
            chart.split = r.ident('a column to split each bar by', own)
          }
        }
        view.chart = chart
      } else if (r.word('widths')) {
        const widths: Record<string, number> = view.widths ?? {}
        do {
          const column = r.ident('a column', own)
          widths[column] = r.number()
        } while (r.symbol(','))
        view.widths = widths
      } else break
    }
    if (!r.done()) r.fail(sources.length || columns.length ? 'from, columns, where, sort by, group by, total, chart, or widths' : 'from and a blueprint')
    const spec: QuerySpec = { sources, columns }
    if (Object.keys(view).length) spec.view = view
    return done({ spec: normalizeQuery(spec) })
  } catch (e) {
    if (!(e instanceof Stop)) throw e
    let line = 1
    let start = 0
    for (let i = 0; i < e.at && i < text.length; i++)
      if (text[i] === '\n') {
        line++
        start = i + 1
      }
    return done({ error: { message: e.message, line, column: e.at - start + 1, at: e.at } })
  }
}
