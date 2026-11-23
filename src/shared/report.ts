// A report's layout, and what one edition of it holds. The layout is a short
// Markdown document: front matter that names the report's data sets and the
// tool that writes its prose, then headings, plain paragraphs, and fenced
// blocks (`stats`, `chart`, `table`, `narrative`), each a small YAML map.
// Nobody writes HTML: the hub draws every edition from what this file works
// out (`report-draw.ts`). Numbers come from data sets alone; only a narrative
// block's prose comes from a model, written on a runner.
//
// `parseLayout` reads a layout and names every problem in one pass, each with
// its line, so whoever wrote it mends it from the message. `buildContent`
// turns a layout and the data sets one run gathered into the blocks an
// edition keeps: everything drawing needs, so an edition reads the same for
// as long as it is kept, whatever the data does after.

import { LineCounter, parseDocument, isMap, isScalar, stringify, type YAMLMap } from 'yaml'

/** An id of a data set, a stat, or a column a layout names. */
const NAME = /^[a-z][a-z0-9_]*$/

/** Where a data set's rows come from: a saved query, read as the report's owner, or a runner tool's answer, called as them. */
export type DataSetDef = { query: string } | { tool: string; entity?: string; inputs?: Record<string, unknown> }

export const STAT_OF = ['count', 'sum', 'avg', 'min', 'max', 'first', 'last'] as const
export type StatOf = (typeof STAT_OF)[number]

/** One number of a `stats` block. Its `name` is the headline number every edition keeps under it. */
export interface StatItem {
  name: string
  title?: string
  /** How the rows become one number: how many there are, or the sum, mean, least, most, first, or last of a column. */
  of: StatOf
  column?: string
  /** Written after the number, such as `%` or ` ms`. */
  unit?: string
  /** Places after the point. Left out: none for a whole number, else up to two. */
  decimals?: number
  /** Which way is better, so a change since the last edition reads as good or bad. Left out, a change is only a change. */
  better?: 'up' | 'down'
  /** The marks the number is judged by, so it reads as on track, to watch, or off track. Both or neither. */
  good?: number
  bad?: number
}

export const TONES = ['good', 'warn', 'bad'] as const
/** Where a number stands against the marks its layout sets. */
export type Tone = (typeof TONES)[number]

/** The two marks a number is judged by. Higher is better where `good` is the larger, lower where it is the smaller. */
export interface Health {
  good: number
  bad: number
}

/** A number against its marks: good at or past `good`, bad short of `bad`, and to watch between them. A number that is missing is not judged. */
export function toneOf(value: number | null, health: Health): Tone | null {
  if (value === null) return null
  const up = health.good > health.bad
  if (up ? value >= health.good : value <= health.good) return 'good'
  if (up ? value < health.bad : value > health.bad) return 'bad'
  return 'warn'
}

/** The worst of some tones, or null when none was judged. */
export function worstOf(tones: readonly (Tone | null | undefined)[]): Tone | null {
  return tones.includes('bad') ? 'bad' : tones.includes('warn') ? 'warn' : tones.includes('good') ? 'good' : null
}

/** The bars a scorecard draws beside each row: one a column, oldest first, each judged by the same marks when it names them. */
export interface TrendDef {
  columns: string[]
  title?: string
  good?: number
  bad?: number
}

export const CHART_TYPES = ['trend', 'bars', 'delta'] as const
export type ChartType = (typeof CHART_TYPES)[number]

/** One block of a layout, with the line it starts on. */
export type LayoutBlock = { line: number } & (
  | { kind: 'heading'; level: 1 | 2 | 3; text: string }
  | { kind: 'text'; text: string }
  /** With no `items`, it shows the numbers its data set brings: a saved query's own totals, or how many rows it holds. */
  | { kind: 'stats'; data: string; title?: string; items: StatItem[] }
  /** `trend`: a line for each `y` column along `x`, in the rows' order. `bars`: one bar a row, `x` its label. `delta`: each row's `y` beside the last edition's, matched by `x`. */
  /** What it leaves out it takes from its data set: a saved query's own chart, else bars of the first number column by the first column. */
  | { kind: 'chart'; type?: ChartType; data: string; title?: string; x?: string; y: string[] }
  /** `health` judges a column's numbers by two marks, and each is marked so. */
  | { kind: 'table'; data: string; title?: string; columns?: string[]; limit: number; health?: Record<string, Health> }
  /** One row a thing: its name (`label`, else the first column), a mark for the worst of its judged numbers, its numbers, and its trend as small bars. */
  | { kind: 'scorecard'; data: string; title?: string; label?: string; columns?: string[]; limit: number; health?: Record<string, Health>; trend?: TrendDef }
  | { kind: 'narrative'; data: string[]; title?: string; instruction: string }
  /** Where the narrative before it goes on: that one then stands as its first paragraph alone, the lead, and the rest of its prose is drawn here. */
  | { kind: 'rest'; title?: string }
)

export interface ReportLayout {
  /** The runner tool that writes the prose of every narrative block. */
  writer?: string
  /** How many days each edition covers, its publish day the last: the header says the range. */
  covers?: number
  data: Record<string, DataSetDef>
  blocks: LayoutBlock[]
}

export interface LayoutIssue {
  line: number
  message: string
}

/** The blocks a layout may hold. */
export const BLOCK_KINDS = ['stats', 'chart', 'table', 'scorecard', 'narrative'] as const
/** The most rows a table block shows. */
export const TABLE_ROWS_MAX = 200
export const TABLE_ROWS_DEFAULT = 20
/** The most bars a scorecard's trend draws beside a row. */
export const TREND_BARS_MAX = 12
/** The most days an edition may say it covers. */
export const COVERS_MAX = 3660
/** The longest layout the hub keeps. */
export const LAYOUT_MAX = 50_000
/** The most data sets one report reads. */
export const DATA_SETS_MAX = 12

/** Reads a layout, naming every problem with its line. The layout is null when there is any. */
export function parseLayout(text: string): { layout: ReportLayout | null; issues: LayoutIssue[] } {
  const issues: LayoutIssue[] = []
  const say = (line: number, message: string) => issues.push({ line, message })
  if (text.length > LAYOUT_MAX) return { layout: null, issues: [{ line: 1, message: `a layout is at most ${LAYOUT_MAX.toLocaleString('en-US')} characters` }] }
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  let at = 0
  const layout: ReportLayout = { data: {}, blocks: [] }
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---')
    if (end < 0) say(1, 'the front matter opened on line 1 is never closed with ---')
    else {
      readFront(lines.slice(1, end), 2, layout, say)
      at = end + 1
    }
  }
  let para: { line: number; text: string[] } | null = null
  const flush = () => {
    if (para) layout.blocks.push({ kind: 'text', line: para.line, text: para.text.join('\n').trim() })
    para = null
  }
  while (at < lines.length) {
    const line = lines[at]!
    const n = at + 1
    const fence = /^(`{3,}|~{3,})\s*(\S*)\s*$/.exec(line)
    if (fence) {
      flush()
      const close = lines.findIndex((l, i) => i > at && l.trim() === fence[1])
      if (close < 0) {
        say(n, `the block opened here is never closed with ${fence[1]}`)
        break
      }
      readBlock(fence[2]!, lines.slice(at + 1, close), n, layout, say)
      at = close + 1
      continue
    }
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
    if (heading) {
      flush()
      if (heading[1]!.length > 3) say(n, 'a heading is #, ##, or ###')
      layout.blocks.push({ kind: 'heading', line: n, level: Math.min(3, heading[1]!.length) as 1 | 2 | 3, text: heading[2]! })
    } else if (!line.trim()) flush()
    else {
      para ??= { line: n, text: [] }
      para.text.push(line)
    }
    at++
  }
  flush()
  // What the blocks name must be declared, and each headline number named once.
  const names = new Set(Object.keys(layout.data))
  const stats = new Map<string, number>()
  let narrative = false
  // The narrative a `rest` block would go on from, until one takes it.
  let open = false
  for (const b of layout.blocks) {
    if (b.kind === 'rest') {
      if (!open) say(b.line, 'narrative block: rest goes on from the narrative block before it, and only one may')
      open = false
    }
    if (b.kind === 'narrative') open = true
    const reads = b.kind === 'narrative' ? b.data : b.kind === 'stats' || b.kind === 'chart' || b.kind === 'table' || b.kind === 'scorecard' ? [b.data] : []
    for (const d of reads) if (!names.has(d)) say(b.line, `${b.kind} reads data set "${d}", which the front matter does not declare${names.size ? `: it declares ${[...names].join(', ')}` : ''}`)
    if (b.kind === 'stats' && !b.items.length) {
      // Its numbers are named after its data set, so two of them on one data set would name each twice.
      if (stats.has(`${b.data}_`)) say(b.line, `two stats blocks show the numbers of data set "${b.data}": the other is on line ${stats.get(`${b.data}_`)}`)
      else stats.set(`${b.data}_`, b.line)
    }
    if (b.kind === 'stats')
      for (const item of b.items) {
        if (stats.has(item.name)) say(b.line, `stat "${item.name}" is named twice: once on line ${stats.get(item.name)}`)
        else stats.set(item.name, b.line)
      }
    if (b.kind === 'narrative') narrative = true
  }
  if (narrative && !layout.writer) say(1, 'a narrative block needs a writer: name the runner tool that writes prose in the front matter, as writer')
  if (!layout.blocks.some((b) => b.kind !== 'heading' && b.kind !== 'text' && b.kind !== 'rest')) say(1, `a layout holds at least one block: ${BLOCK_KINDS.join(', ')}`)
  return issues.length ? { layout: null, issues: issues.sort((a, b) => a.line - b.line) } : { layout, issues }
}

/** A block as a form holds it: without the line a layout's text gives it. */
export type DraftBlock = LayoutBlock extends infer B ? (B extends unknown ? Omit<B, 'line'> : never) : never

/** A layout as a form holds it, before it is text. */
export interface LayoutDraft {
  writer?: string
  covers?: number
  data: Record<string, DataSetDef>
  blocks: DraftBlock[]
}

/**
 * A layout as the text `parseLayout` reads back the same: the one way a form
 * writes one, so what a person builds and what an agent writes are the same
 * document.
 */
export function printLayout(draft: LayoutDraft): string {
  const yaml = (v: unknown) => stringify(v, { lineWidth: 0 }).trimEnd()
  const out: string[] = []
  const front = { ...(draft.writer ? { writer: draft.writer } : {}), ...(draft.covers ? { covers: draft.covers } : {}), ...(Object.keys(draft.data).length ? { data: draft.data } : {}) }
  if (Object.keys(front).length) out.push(`---\n${yaml(front)}\n---`)
  const titled = (b: { title?: string }) => (b.title ? { title: b.title } : {})
  for (const b of draft.blocks) {
    if (b.kind === 'heading') out.push(`${'#'.repeat(b.level)} ${b.text}`)
    else if (b.kind === 'text') out.push(b.text)
    else if (b.kind === 'stats') out.push(`\`\`\`stats\n${yaml({ data: b.data, ...titled(b), ...(b.items.length ? { items: b.items } : {}) })}\n\`\`\``)
    else if (b.kind === 'chart') out.push(`\`\`\`chart\n${yaml({ ...(b.type ? { type: b.type } : {}), data: b.data, ...titled(b), ...(b.x ? { x: b.x } : {}), ...(b.y.length ? { y: b.y.length === 1 ? b.y[0] : b.y } : {}) })}\n\`\`\``)
    else if (b.kind === 'table') out.push(`\`\`\`table\n${yaml({ data: b.data, ...titled(b), ...(b.columns ? { columns: b.columns } : {}), ...(b.limit !== TABLE_ROWS_DEFAULT ? { limit: b.limit } : {}), ...(b.health ? { health: b.health } : {}) })}\n\`\`\``)
    else if (b.kind === 'scorecard') out.push(`\`\`\`scorecard\n${yaml({ data: b.data, ...titled(b), ...(b.label ? { label: b.label } : {}), ...(b.columns ? { columns: b.columns } : {}), ...(b.limit !== TABLE_ROWS_DEFAULT ? { limit: b.limit } : {}), ...(b.health ? { health: b.health } : {}), ...(b.trend ? { trend: b.trend } : {}) })}\n\`\`\``)
    else if (b.kind === 'rest') out.push(`\`\`\`narrative\n${yaml({ rest: true, ...titled(b) })}\n\`\`\``)
    else out.push(`\`\`\`narrative\n${yaml({ data: b.data.length === 1 ? b.data[0] : b.data, ...titled(b), instruction: b.instruction })}\n\`\`\``)
  }
  return `${out.join('\n\n')}\n`
}

/** A layout read from text, as a form holds it. */
export function draftOf(layout: ReportLayout): LayoutDraft {
  return { ...(layout.writer ? { writer: layout.writer } : {}), ...(layout.covers ? { covers: layout.covers } : {}), data: layout.data, blocks: layout.blocks.map(({ line: _line, ...b }) => b as DraftBlock) }
}

type Say = (line: number, message: string) => void

/**
 * A YAML map read with its lines, or null after saying why it is not one.
 * `named` reads a value that names something (a query id, a tool, an entity)
 * as it was written: YAML would read an id such as `5e3412` as a number, or
 * `0123` as 123, and the name would be lost.
 */
function yamlMap(body: string[], first: number, what: string, say: Say): { map: Record<string, unknown>; lineOf: (key: string) => number; named: (path: readonly string[]) => string | undefined } | null {
  const counter = new LineCounter()
  const doc = parseDocument(body.join('\n'), { lineCounter: counter })
  if (doc.errors.length) {
    for (const e of doc.errors) say(first + (e.linePos?.[0]?.line ?? 1) - 1, `${what}: ${e.message.split('\n')[0]}`)
    return null
  }
  if (doc.contents !== null && !isMap(doc.contents)) {
    say(first, `${what} is a map of names and values`)
    return null
  }
  const lineOfKey = new Map<string, number>()
  for (const pair of (doc.contents as YAMLMap | null)?.items ?? []) {
    if (isScalar(pair.key) && pair.key.range) lineOfKey.set(String(pair.key.value), first + counter.linePos(pair.key.range[0]).line - 1)
  }
  const named = (path: readonly string[]): string | undefined => {
    const node = doc.getIn(path, true)
    if (isScalar(node) && typeof node.value === 'number' && typeof node.source === 'string') return text(node.source)
    return text(isScalar(node) ? node.value : node)
  }
  return { map: (doc.toJS() ?? {}) as Record<string, unknown>, lineOf: (key) => lineOfKey.get(key) ?? first, named }
}

/** Says each key a map holds that it may not, and says so as unknown, never passes over one. */
function onlyKeys(map: Record<string, unknown>, allowed: readonly string[], what: string, line: (key: string) => number, say: Say): void {
  for (const key of Object.keys(map)) if (!allowed.includes(key)) say(line(key), `${what}: unknown "${key}"; it takes ${allowed.join(', ')}`)
}

const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : undefined)

function readFront(body: string[], first: number, layout: ReportLayout, say: Say): void {
  const read = yamlMap(body, first, 'front matter', say)
  if (!read) return
  const { map, lineOf, named } = read
  onlyKeys(map, ['writer', 'covers', 'data'], 'front matter', lineOf, say)
  if (map.covers !== undefined) {
    if (typeof map.covers !== 'number' || !Number.isInteger(map.covers) || map.covers < 1 || map.covers > COVERS_MAX) say(lineOf('covers'), `covers is how many days each edition covers, a whole number from 1 to ${COVERS_MAX.toLocaleString('en-US')}`)
    else layout.covers = map.covers
  }
  if (map.writer !== undefined) {
    const writer = named(['writer'])
    if (!writer) say(lineOf('writer'), 'writer names a runner tool by its action id')
    else layout.writer = writer
  }
  const data = map.data
  if (data === undefined || data === null) return
  if (typeof data !== 'object' || Array.isArray(data)) {
    say(lineOf('data'), 'data is a map of data sets by name')
    return
  }
  const entries = Object.entries(data as Record<string, unknown>)
  if (entries.length > DATA_SETS_MAX) say(lineOf('data'), `a report reads at most ${DATA_SETS_MAX} data sets`)
  // The line of each data set is where its name stands under data.
  const lineOfSet = (name: string) => {
    const i = body.findIndex((l) => new RegExp(`^\\s+${name}\\s*:`).test(l))
    return i < 0 ? lineOf('data') : first + i
  }
  for (const [name, def] of entries) {
    const line = lineOfSet(name)
    if (!NAME.test(name)) say(line, `data set "${name}": a name is lowercase letters, digits, and _`)
    if (!def || typeof def !== 'object' || Array.isArray(def)) {
      say(line, `data set "${name}" names a query or a tool`)
      continue
    }
    const d = def as Record<string, unknown>
    onlyKeys(d, ['query', 'tool', 'entity', 'inputs'], `data set "${name}"`, () => line, say)
    const query = named(['data', name, 'query'])
    const tool = named(['data', name, 'tool'])
    if (!!query === !!tool) say(line, `data set "${name}" names one query or one tool`)
    else if (query) {
      if (d.entity !== undefined || d.inputs !== undefined) say(line, `data set "${name}": a query takes no entity or inputs; its view is saved with it`)
      layout.data[name] = { query }
    } else {
      const entity = named(['data', name, 'entity'])
      if (d.entity !== undefined && (!entity || !/^[^:]+:.+$/.test(entity))) say(line, `data set "${name}": entity is blueprint:key`)
      if (d.inputs !== undefined && (!d.inputs || typeof d.inputs !== 'object' || Array.isArray(d.inputs))) say(line, `data set "${name}": inputs is a map of the tool's inputs`)
      layout.data[name] = { tool: tool!, ...(entity ? { entity } : {}), ...(d.inputs && typeof d.inputs === 'object' ? { inputs: d.inputs as Record<string, unknown> } : {}) }
    }
  }
}

function readBlock(kind: string, body: string[], line: number, layout: ReportLayout, say: Say): void {
  if (!(BLOCK_KINDS as readonly string[]).includes(kind)) {
    say(line, kind ? `unknown block "${kind}": a block is ${BLOCK_KINDS.join(', ')}` : `a block names its kind after the fence: ${BLOCK_KINDS.join(', ')}`)
    return
  }
  const read = yamlMap(body, line + 1, `${kind} block`, say)
  if (!read) return
  const { map, lineOf } = read
  const title = text(map.title)
  const data = text(map.data)
  const where = (key: string) => lineOf(key)
  if (kind === 'stats') {
    onlyKeys(map, ['data', 'title', 'items'], 'stats block', where, say)
    if (!data) say(line, 'stats block: data names the data set it counts')
    const raw = map.items
    if (raw !== undefined && (!Array.isArray(raw) || !raw.length)) {
      say(where('items'), 'stats block: items is a list of the numbers it shows; leave it out to show the numbers its data set brings')
      return
    }
    const items: StatItem[] = []
    for (const [i, entry] of ((raw as unknown[] | undefined) ?? []).entries()) {
      const what = `stats item ${i + 1}`
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        say(where('items'), `${what} is a map: name, of, column`)
        continue
      }
      const e = entry as Record<string, unknown>
      onlyKeys(e, ['name', 'title', 'of', 'column', 'unit', 'decimals', 'better', 'good', 'bad'], what, () => where('items'), say)
      const name = text(e.name)
      const of = text(e.of)
      const column = text(e.column)
      if (!name || !NAME.test(name)) say(where('items'), `${what}: name is lowercase letters, digits, and _, the headline number's id`)
      if (!of || !(STAT_OF as readonly string[]).includes(of)) say(where('items'), `${what}: of is one of ${STAT_OF.join(', ')}`)
      else if (of !== 'count' && !column) say(where('items'), `${what}: ${of} reads a column; name it`)
      if (e.decimals !== undefined && !(Number.isInteger(e.decimals) && (e.decimals as number) >= 0 && (e.decimals as number) <= 4)) say(where('items'), `${what}: decimals is 0 to 4`)
      if (e.better !== undefined && e.better !== 'up' && e.better !== 'down') say(where('items'), `${what}: better is up or down`)
      const marks = readMarks(e, what, where('items'), say)
      if (name && of) items.push({ ...(marks ?? {}), name, of: of as StatOf, ...(text(e.title) ? { title: text(e.title)! } : {}), ...(column ? { column } : {}), ...(typeof e.unit === 'string' ? { unit: e.unit } : {}), ...(typeof e.decimals === 'number' ? { decimals: e.decimals } : {}), ...(e.better === 'up' || e.better === 'down' ? { better: e.better } : {}) })
    }
    if (data) layout.blocks.push({ kind: 'stats', line, data, items, ...(title ? { title } : {}) })
    return
  }
  if (kind === 'chart') {
    onlyKeys(map, ['type', 'data', 'title', 'x', 'y'], 'chart block', where, say)
    const type = text(map.type)
    const x = text(map.x)
    const y = Array.isArray(map.y) ? map.y.map(text).filter((v): v is string => !!v) : text(map.y) ? [text(map.y)!] : []
    const typed = type !== undefined && (CHART_TYPES as readonly string[]).includes(type)
    if (map.type !== undefined && !typed) say(where('type'), `chart block: type is one of ${CHART_TYPES.join(', ')}`)
    if (!data) say(line, 'chart block: data names the data set it draws')
    if (map.x !== undefined && !x) say(where('x'), 'chart block: x names the column along the bottom, or each bar\'s label')
    if (map.y !== undefined && !y.length) say(where('y'), 'chart block: y names the number column it draws')
    else if (typed && type !== 'trend' && y.length > 1) say(where('y'), `chart block: a ${type} chart draws one column`)
    if (data) layout.blocks.push({ kind: 'chart', line, data, y, ...(typed ? { type: type as ChartType } : {}), ...(x ? { x } : {}), ...(title ? { title } : {}) })
    return
  }
  if (kind === 'table' || kind === 'scorecard') {
    const what = `${kind} block`
    onlyKeys(map, kind === 'table' ? ['data', 'title', 'columns', 'limit', 'health'] : ['data', 'title', 'label', 'columns', 'limit', 'health', 'trend'], what, where, say)
    if (!data) say(line, `${what}: data names the data set it lists`)
    const columns = map.columns === undefined ? undefined : Array.isArray(map.columns) ? map.columns.map(text).filter((v): v is string => !!v) : null
    if (columns === null || (columns && !columns.length)) say(where('columns'), `${what}: columns is a list of column names`)
    const limit = map.limit === undefined ? TABLE_ROWS_DEFAULT : map.limit
    if (!(Number.isInteger(limit) && (limit as number) >= 1 && (limit as number) <= TABLE_ROWS_MAX)) say(where('limit'), `${what}: limit is 1 to ${TABLE_ROWS_MAX}`)
    const health = readHealth(map.health, what, where('health'), say)
    const shared = { line, limit: limit as number, ...(columns ? { columns } : {}), ...(title ? { title } : {}), ...(health ? { health } : {}) }
    if (kind === 'table') {
      if (data) layout.blocks.push({ kind: 'table', data, ...shared })
      return
    }
    const label = text(map.label)
    if (map.label !== undefined && !label) say(where('label'), 'scorecard block: label names the column each row is named by')
    const trend = readTrend(map.trend, where('trend'), say)
    if (data) layout.blocks.push({ kind: 'scorecard', data, ...shared, ...(label ? { label } : {}), ...(trend ? { trend } : {}) })
    return
  }
  if (map.rest !== undefined) {
    onlyKeys(map, ['rest', 'title'], 'narrative block that goes on', where, say)
    if (map.rest !== true) say(where('rest'), 'narrative block: rest is true, on a block that goes on from the narrative before it')
    else layout.blocks.push({ kind: 'rest', line, ...(title ? { title } : {}) })
    return
  }
  onlyKeys(map, ['data', 'title', 'instruction'], 'narrative block', where, say)
  const sets = Array.isArray(map.data) ? map.data.map(text).filter((v): v is string => !!v) : data ? [data] : []
  const instruction = text(map.instruction)
  if (!sets.length) say(line, 'narrative block: data names the data sets its prose is written from')
  if (!instruction) say(line, 'narrative block: instruction says what the prose should say')
  if (sets.length && instruction) layout.blocks.push({ kind: 'narrative', line, data: sets, instruction, ...(title ? { title } : {}) })
}

/** The marks a map sets, `good` and `bad` together, or null where it sets none or says them wrongly. */
function readMarks(e: Record<string, unknown>, what: string, line: number, say: Say): Health | null {
  if (e.good === undefined && e.bad === undefined) return null
  if (typeof e.good !== 'number' || typeof e.bad !== 'number' || !Number.isFinite(e.good) || !Number.isFinite(e.bad)) say(line, `${what}: good and bad are two numbers, set together`)
  else if (e.good === e.bad) say(line, `${what}: good and bad differ; higher is better where good is the larger`)
  else return { good: e.good, bad: e.bad }
  return null
}

/** A block's `health`: the marks of each column it names. */
function readHealth(raw: unknown, what: string, line: number, say: Say): Record<string, Health> | null {
  if (raw === undefined) return null
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Object.keys(raw).length) {
    say(line, `${what}: health is a map of columns, each with good and bad`)
    return null
  }
  const out: Record<string, Health> = {}
  for (const [column, entry] of Object.entries(raw as Record<string, unknown>)) {
    const about = `${what}: health of "${column}"`
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      say(line, `${about} is a map: good, bad`)
      continue
    }
    onlyKeys(entry as Record<string, unknown>, ['good', 'bad'], about, () => line, say)
    const marks = readMarks(entry as Record<string, unknown>, about, line, say)
    if (marks) out[column] = marks
    else if ((entry as Record<string, unknown>).good === undefined && (entry as Record<string, unknown>).bad === undefined) say(line, `${about} sets good and bad`)
  }
  return Object.keys(out).length ? out : null
}

/** A scorecard's `trend`: the columns its bars are drawn from, oldest first. */
function readTrend(raw: unknown, line: number, say: Say): TrendDef | null {
  if (raw === undefined) return null
  const what = 'scorecard block: trend'
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    say(line, `${what} is a map: columns, title, good, bad`)
    return null
  }
  const t = raw as Record<string, unknown>
  onlyKeys(t, ['columns', 'title', 'good', 'bad'], what, () => line, say)
  const columns = Array.isArray(t.columns) ? t.columns.map(text).filter((v): v is string => !!v) : []
  if (!columns.length) say(line, `${what}: columns is a list of number columns, oldest first`)
  else if (columns.length > TREND_BARS_MAX) say(line, `${what} draws at most ${TREND_BARS_MAX} bars`)
  const marks = readMarks(t, what, line, say)
  const title = text(t.title)
  return columns.length ? { columns, ...(title ? { title } : {}), ...(marks ?? {}) } : null
}

// What a report run asks -----------------------------------------------------

/** What a run of an action with the `report` backend asks of the hub. Its inputs, each by its fixed name, are checked by the action's own kinds first. */
export const REPORT_VERBS = ['create', 'edit', 'recipients', 'hand', 'remove', 'publish', 'preview'] as const
export type ReportVerb = (typeof REPORT_VERBS)[number]

/** The inputs each verb reads, by name, and whether it needs them. */
export const REPORT_INPUTS: Record<ReportVerb, { name: string; required: boolean; kinds: string[] }[]> = {
  create: [
    { name: 'title', required: true, kinds: ['string', 'text'] },
    { name: 'home', required: true, kinds: ['entity', 'string'] },
    { name: 'layout', required: true, kinds: ['markdown', 'text', 'attachment'] },
    { name: 'recipients', required: false, kinds: ['email'] },
    { name: 'note', required: false, kinds: ['string', 'text', 'markdown'] },
  ],
  edit: [
    { name: 'layout', required: false, kinds: ['markdown', 'text', 'attachment'] },
    { name: 'version', required: false, kinds: ['number'] },
    { name: 'note', required: false, kinds: ['string', 'text', 'markdown'] },
  ],
  recipients: [{ name: 'recipients', required: true, kinds: ['email'] }],
  hand: [{ name: 'owner', required: true, kinds: ['email'] }],
  remove: [],
  publish: [],
  preview: [{ name: 'fresh', required: false, kinds: ['boolean'] }],
}

// What a run gathers ---------------------------------------------------------

export interface DataColumn {
  id: string
  title: string
  /** How its numbers are said, where its source says: a unit after each, and how many places. */
  unit?: string
  decimals?: number
}

/** The rows of one data set as one run read them: what an edition keeps of it. */
export interface DataSet {
  columns: DataColumn[]
  rows: unknown[][]
  /** How many rows it had before any were left out. */
  total: number
  /** More rows than an edition keeps; the first are kept. */
  truncated: boolean
  /** Why it holds nothing, when it could not be read. */
  error?: string
  /** What its source already worked out of it: a saved query's totals and chart. */
  shape?: DataShape
}

/** What a data set's source says of it beyond its rows, so a block that says nothing of its own shows it as its source does. */
export interface DataShape {
  /** One number over every row, such as a saved query's total of a column. */
  totals?: { name: string; title: string; value: number | null }[]
  chart?: { type?: ChartType; x: string; y: string[] }
}

/** A name a headline number may take, from any text. */
export function nameOf(text: string): string {
  const name = text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  return /^[a-z]/.test(name) ? name : `n_${name}`
}

/** The numbers a stats block shows: its own items, or what its data set brings, else how many rows it holds. */
export function statsOf(block: Extract<LayoutBlock, { kind: 'stats' }>, set: DataSet): { item: StatItem; value: number | null; gap?: string }[] {
  if (block.items.length) return block.items.map((item) => ({ item, ...statOf(item, set) }))
  if (set.error) return [{ item: { name: `${block.data}_rows`, title: 'Rows', of: 'count' }, value: null, gap: set.error }]
  const totals = set.shape?.totals ?? []
  if (!totals.length) return [{ item: { name: `${block.data}_rows`, title: 'Rows', of: 'count' }, value: set.total }]
  return totals.map((t) => ({ item: { name: `${block.data}_${nameOf(t.name)}`, title: t.title, of: 'first' as const }, value: t.value }))
}

/** What a chart block draws: its own type and columns, else its data set's chart, else bars of the first number column by the first column. */
export function chartOf(block: Extract<LayoutBlock, { kind: 'chart' }>, set: DataSet): { type: ChartType; x: string; y: string[] } | { gap: string } {
  const hint = set.shape?.chart
  const type = block.type ?? hint?.type ?? 'bars'
  const x = block.x ?? hint?.x ?? set.columns[0]?.id
  if (x === undefined) return { gap: 'no column to draw' }
  const xi = columnIndex(set, x)
  const numbers = set.columns.filter((_c, i) => i !== xi && set.rows.some((r) => typeof r[i] === 'number')).map((c) => c.id)
  const y = (block.y.length ? block.y : hint?.y?.length ? hint.y : numbers).slice(0, type === 'trend' ? 4 : 1)
  return y.length ? { type, x, y } : { gap: 'no number column to draw' }
}

/** The most rows of one data set an edition keeps. */
export const DATA_ROWS_MAX = 5_000

/** The rows a runner tool answered with: a JSON list of objects, or `{ columns, rows }`, or `{ rows: [objects] }`. */
export function tableOf(answer: string): DataSet {
  let parsed: unknown
  try {
    parsed = JSON.parse(answer)
  } catch {
    return gap('the tool did not answer with JSON')
  }
  const list = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' && Array.isArray((parsed as { rows?: unknown }).rows) ? (parsed as { rows: unknown[] }).rows : null
  const named = parsed && typeof parsed === 'object' && Array.isArray((parsed as { columns?: unknown }).columns) ? (parsed as { columns: unknown[] }).columns.map(columnOf) : null
  if (!list) return gap('the tool answered JSON that is not a list of rows')
  if (named) {
    if (named.some((c) => c === null) || list.some((r) => !Array.isArray(r))) return gap('the tool named columns, so each row is a list of values')
    return capped(named as DataColumn[], list as unknown[][])
  }
  if (list.some((r) => !r || typeof r !== 'object' || Array.isArray(r))) return gap('each row the tool answered is an object of column values')
  const ids: string[] = []
  for (const r of list as Record<string, unknown>[]) for (const k of Object.keys(r)) if (!ids.includes(k)) ids.push(k)
  return capped(ids.map((id) => ({ id, title: id })), (list as Record<string, unknown>[]).map((r) => ids.map((id) => r[id] ?? null)))
}

/** A column as a tool names it: its id alone, or its id with the title and the unit and places its numbers are said with. */
function columnOf(c: unknown): DataColumn | null {
  if (typeof c === 'string') return c ? { id: c, title: c } : null
  if (!c || typeof c !== 'object') return null
  const { id, title, unit, decimals } = c as Record<string, unknown>
  if (typeof id !== 'string' || !id) return null
  return { id, title: typeof title === 'string' && title.trim() ? title.trim().slice(0, 80) : id, ...(typeof unit === 'string' && unit ? { unit: unit.slice(0, 12) } : {}), ...(typeof decimals === 'number' && Number.isInteger(decimals) && decimals >= 0 && decimals <= 6 ? { decimals } : {}) }
}

/** A cell as its column says a number: with the column's unit and places where it names either, else as `cellText` says any value. */
export function cellOf(v: unknown, column: DataColumn | undefined): string {
  return typeof v === 'number' && Number.isFinite(v) && column && (column.unit !== undefined || column.decimals !== undefined) ? formatNumber(v, column.decimals, column.unit) : cellText(v)
}

/** A data set of these rows, the first `DATA_ROWS_MAX` kept. */
export function capped(columns: DataColumn[], rows: unknown[][], total = rows.length): DataSet {
  return { columns, rows: rows.slice(0, DATA_ROWS_MAX), total, truncated: rows.length > DATA_ROWS_MAX || total > rows.length }
}

/** A data set that could not be read, saying why. */
export function gap(error: string): DataSet {
  return { columns: [], rows: [], total: 0, truncated: false, error }
}

/** The index of a column by its id, or by its title without regard to case; -1 when it has none. */
export function columnIndex(set: DataSet, name: string): number {
  const byId = set.columns.findIndex((c) => c.id === name)
  if (byId >= 0) return byId
  const lower = name.toLowerCase()
  return set.columns.findIndex((c) => c.title.toLowerCase() === lower)
}

/** A cell as a number, or null when it is not one. */
export function numberOf(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v)
  if (typeof v === 'boolean') return v ? 1 : 0
  return null
}

/** A cell as text a person reads. */
export function cellText(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (Array.isArray(v)) return v.map(cellText).join(', ')
  if (typeof v === 'object') return JSON.stringify(v)
  // A number that is not whole is said to two places: a mean of a column is no place for fourteen digits.
  if (typeof v === 'number' && !Number.isInteger(v)) return String(Math.round(v * 100) / 100)
  return String(v)
}

/** One stat's number over a data set, or null with why. */
export function statOf(item: StatItem, set: DataSet): { value: number | null; gap?: string } {
  if (set.error) return { value: null, gap: set.error }
  if (item.of === 'count') return { value: set.total }
  const i = columnIndex(set, item.column!)
  if (i < 0) return { value: null, gap: `no column "${item.column}"` }
  const values = set.rows.map((r) => numberOf(r[i])).filter((v): v is number => v !== null)
  if (!values.length) return { value: null }
  switch (item.of) {
    case 'sum': return { value: values.reduce((a, b) => a + b, 0) }
    case 'avg': return { value: values.reduce((a, b) => a + b, 0) / values.length }
    case 'min': return { value: Math.min(...values) }
    case 'max': return { value: Math.max(...values) }
    case 'first': return { value: values[0]! }
    case 'last': return { value: values[values.length - 1]! }
  }
}

// What an edition keeps --------------------------------------------------------

export interface EditionStat {
  name: string
  title: string
  value: number | null
  /** The same number in the edition before, when there was one. */
  was: number | null
  unit?: string
  decimals?: number
  better?: 'up' | 'down'
  /** Where the number stands against its marks, when its layout set them. */
  tone?: Tone
}

/** One cell of a scorecard's row, and where it stands when its column is judged. */
export interface ScoreCell {
  text: string
  tone?: Tone
}

/** One row of a scorecard. `tone` is the worst of its judged cells, or null when none was. */
export interface ScoreRow {
  label: string
  tone: Tone | null
  cells: ScoreCell[]
  trend?: { label: string; value: number | null; tone?: Tone }[]
}

export interface ChartPoint {
  label: string
  value: number | null
  /** For a delta: the same label's value in the edition before. */
  was?: number | null
}

/** A block as an edition keeps it: everything drawing needs, and nothing it must read again. `gap` says why a block holds nothing. */
export type EditionBlock =
  | { kind: 'heading'; level: 1 | 2 | 3; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'stats'; title?: string; items: EditionStat[]; gap?: string }
  | { kind: 'chart'; type: ChartType; title?: string; x: string; series: { name: string; points: ChartPoint[] }[]; gap?: string }
  /** `tones` lies over `rows`, cell for cell, when the layout judged a column. */
  | { kind: 'table'; title?: string; columns: string[]; rows: string[][]; tones?: (Tone | null)[][]; total: number; gap?: string }
  | { kind: 'scorecard'; title?: string; label: string; columns: string[]; trend?: string; rows: ScoreRow[]; total: number; gap?: string }
  /** `lead` marks the one paragraph that stands before the rest of its prose, which a later block draws. */
  | { kind: 'narrative'; title?: string; text: string | null; gap?: string; lead?: boolean }

export interface EditionContent {
  title: string
  number: number
  publishedAt: string
  /** The title of the report's home, as its owner sees it. */
  home?: string
  /** The time zone its date is said in: the schedule's that fired it, else its owner's. */
  zone?: string
  /** How many days it covers, its publish day the last. */
  covers?: number
  blocks: EditionBlock[]
}

/** What the edition before this one kept, for a change since then. */
export interface Before {
  headline: Record<string, number | null>
  data: Record<string, DataSet>
}

/** The headline numbers of a layout over these data sets, by stat name. */
export function headlineOf(blocks: readonly EditionBlock[]): Record<string, number | null> {
  return Object.fromEntries(blocks.flatMap((b) => (b.kind === 'stats' ? b.items.map((i) => [i.name, i.value]) : [])))
}

/** The prose each narrative block was given, by its index among the layout's blocks; a block given none says why. */
export type Prose = Map<number, { text: string } | { gap: string }>

/**
 * The blocks an edition keeps, from a layout, the data sets one run read,
 * the prose written for its narrative blocks, and the edition before it.
 */
export function buildContent(layout: ReportLayout, data: Record<string, DataSet>, prose: Prose, before: Before | null, head: Pick<EditionContent, 'title' | 'number' | 'publishedAt' | 'home' | 'zone'>): EditionContent {
  const blocks = layout.blocks.map((b, index): EditionBlock => {
    switch (b.kind) {
      case 'heading':
        return { kind: 'heading', level: b.level, text: b.text }
      case 'text':
        return { kind: 'text', text: b.text }
      case 'stats': {
        const set = data[b.data] ?? gap('not read')
        const worked = statsOf(b, set)
        const items = worked.map(({ item, value }): EditionStat => ({ name: item.name, title: item.title ?? item.name, value, was: before?.headline[item.name] ?? null, ...(item.unit !== undefined ? { unit: item.unit } : {}), ...(item.decimals !== undefined ? { decimals: item.decimals } : {}), ...(item.better ? { better: item.better } : {}), ...toned(item.good !== undefined && item.bad !== undefined ? toneOf(value, { good: item.good, bad: item.bad }) : null) }))
        const missing = worked.map((w) => w.gap).find((g) => g)
        return { kind: 'stats', items, ...(b.title ? { title: b.title } : {}), ...(missing ? { gap: missing } : {}) }
      }
      case 'chart': {
        const set = data[b.data] ?? gap('not read')
        const title = b.title ? { title: b.title } : {}
        if (set.error) return { kind: 'chart', type: b.type ?? 'bars', x: b.x ?? '', series: [], gap: set.error, ...title }
        const drawn = chartOf(b, set)
        if ('gap' in drawn) return { kind: 'chart', type: b.type ?? 'bars', x: b.x ?? '', series: [], gap: drawn.gap, ...title }
        const xi = columnIndex(set, drawn.x)
        const missing = [drawn.x, ...drawn.y].find((c) => columnIndex(set, c) < 0)
        if (missing) return { kind: 'chart', type: drawn.type, x: drawn.x, series: [], gap: `no column "${missing}"`, ...title }
        const series = drawn.y.map((y) => {
          const yi = columnIndex(set, y)
          const points: ChartPoint[] = set.rows.slice(0, TABLE_ROWS_MAX).map((r) => ({ label: cellText(r[xi]), value: numberOf(r[yi]) }))
          if (drawn.type === 'delta') {
            const prev = before?.data[b.data]
            const pxi = prev ? columnIndex(prev, drawn.x) : -1
            const pyi = prev ? columnIndex(prev, y) : -1
            const was = new Map(pxi >= 0 && pyi >= 0 ? prev!.rows.map((r) => [cellText(r[pxi]), numberOf(r[pyi])]) : [])
            for (const p of points) p.was = was.get(p.label) ?? null
          }
          return { name: set.columns[yi]!.title, points }
        })
        return { kind: 'chart', type: drawn.type, x: set.columns[xi]!.title, series, ...title }
      }
      case 'table': {
        const set = data[b.data] ?? gap('not read')
        const title = b.title ? { title: b.title } : {}
        if (set.error) return { kind: 'table', columns: [], rows: [], total: 0, gap: set.error, ...title }
        const wanted = b.columns ?? set.columns.map((c) => c.id)
        const missing = wanted.find((c) => columnIndex(set, c) < 0)
        if (missing) return { kind: 'table', columns: [], rows: [], total: set.total, gap: `no column "${missing}"`, ...title }
        const idx = wanted.map((c) => columnIndex(set, c))
        const marks = marksOf(b.health, set, idx)
        if ('gap' in marks) return { kind: 'table', columns: [], rows: [], total: set.total, gap: marks.gap, ...title }
        const rows = set.rows.slice(0, b.limit)
        return { kind: 'table', columns: idx.map((i) => set.columns[i]!.title), rows: rows.map((r) => idx.map((i) => cellOf(r[i], set.columns[i]))), ...(b.health ? { tones: rows.map((r) => idx.map((i, k) => (marks.by[k] ? toneOf(numberOf(r[i]), marks.by[k]) : null))) } : {}), total: set.total, ...title }
      }
      case 'scorecard': {
        const set = data[b.data] ?? gap('not read')
        const title = b.title ? { title: b.title } : {}
        const empty = (why: string): EditionBlock => ({ kind: 'scorecard', label: '', columns: [], rows: [], total: set.error ? 0 : set.total, gap: why, ...title })
        if (set.error) return empty(set.error)
        if (!set.columns.length) return empty('no columns')
        const bars = b.trend?.columns ?? []
        const missing = [...(b.label ? [b.label] : []), ...(b.columns ?? []), ...bars].find((c) => columnIndex(set, c) < 0)
        if (missing) return empty(`no column "${missing}"`)
        const li = b.label ? columnIndex(set, b.label) : 0
        const ti = bars.map((c) => columnIndex(set, c))
        const idx = b.columns ? b.columns.map((c) => columnIndex(set, c)) : set.columns.map((_c, i) => i).filter((i) => i !== li && !ti.includes(i))
        // A scorecard judges a row by every column its health names, shown or not: one it does not show marks the row and colours no cell.
        const unknown = Object.keys(b.health ?? {}).find((c) => columnIndex(set, c) < 0)
        if (unknown) return empty(`no column "${unknown}"`)
        const shownHealth = Object.fromEntries(Object.entries(b.health ?? {}).filter(([c]) => idx.includes(columnIndex(set, c))))
        const unseen = Object.entries(b.health ?? {}).filter(([c]) => !idx.includes(columnIndex(set, c))).map(([c, marks]) => ({ at: columnIndex(set, c), marks }))
        const marks = marksOf(shownHealth, set, idx)
        if ('gap' in marks) return empty(marks.gap)
        const judged = b.trend && b.trend.good !== undefined && b.trend.bad !== undefined ? { good: b.trend.good, bad: b.trend.bad } : null
        const rows = set.rows.slice(0, b.limit).map((r): ScoreRow => {
          const cells = idx.map((i, k): ScoreCell => ({ text: cellOf(r[i], set.columns[i]), ...toned(marks.by[k] ? toneOf(numberOf(r[i]), marks.by[k]) : null) }))
          const trend = ti.map((i) => ({ label: set.columns[i]!.title, value: numberOf(r[i]), ...toned(judged ? toneOf(numberOf(r[i]), judged) : null) }))
          return { label: cellText(r[li]), tone: worstOf([...cells.map((c) => c.tone), ...unseen.map((u) => toneOf(numberOf(r[u.at]), u.marks))]), cells, ...(trend.length ? { trend } : {}) }
        })
        return { kind: 'scorecard', label: set.columns[li]!.title, columns: idx.map((i) => set.columns[i]!.title), ...(ti.length ? { trend: b.trend?.title ?? 'Trend' } : {}), rows, total: set.total, ...title }
      }
      case 'narrative': {
        const written = prose.get(index)
        const title = b.title ? { title: b.title } : {}
        if (!written || !('text' in written)) return { kind: 'narrative', text: null, gap: written?.gap ?? 'no prose was written', ...title }
        // A block that goes on from this one leaves it its first paragraph alone, as the lead.
        return goesOn(layout.blocks, index) ? { kind: 'narrative', text: leadOf(written.text).lead, lead: true, ...title } : { kind: 'narrative', text: written.text, ...title }
      }
      case 'rest': {
        const from = layout.blocks.slice(0, index).findLastIndex((x) => x.kind === 'narrative')
        const written = prose.get(from)
        // Where its narrative has no prose, that block says why: this one says nothing twice.
        return { kind: 'narrative', text: written && 'text' in written ? leadOf(written.text).rest : '', ...(b.title ? { title: b.title } : {}) }
      }
    }
  })
  return { ...head, ...(layout.covers ? { covers: layout.covers } : {}), blocks }
}

/** Whether a `rest` block goes on from the narrative at `index`: the next narrative or rest after it is a rest. */
function goesOn(blocks: readonly LayoutBlock[], index: number): boolean {
  return blocks.slice(index + 1).find((x) => x.kind === 'narrative' || x.kind === 'rest')?.kind === 'rest'
}

/** Written prose as its lead, the first paragraph, and the rest. */
export function leadOf(text: string): { lead: string; rest: string } {
  const trimmed = text.replace(/\r\n?/g, '\n').trim()
  const cut = /\n\s*\n/.exec(trimmed)
  return cut ? { lead: trimmed.slice(0, cut.index).trim(), rest: trimmed.slice(cut.index + cut[0].length).trim() } : { lead: trimmed, rest: '' }
}

const toned = (tone: Tone | null): { tone?: Tone } => (tone ? { tone } : {})

/** The marks of each shown column, by its place, or why a `health` names a column that is not shown. */
function marksOf(health: Record<string, Health> | undefined, set: DataSet, shown: readonly number[]): { by: (Health | undefined)[] } | { gap: string } {
  const by: (Health | undefined)[] = shown.map(() => undefined)
  for (const [column, marks] of Object.entries(health ?? {})) {
    const at = shown.indexOf(columnIndex(set, column))
    if (at < 0) return { gap: `health names "${column}", a column it does not show` }
    by[at] = marks
  }
  return { by }
}

/** The most characters of data a narrative's writer is given. */
export const WRITER_DATA_MAX = 60_000
/** The most rows of each data set a narrative's writer is given. */
const WRITER_ROWS = 200

/**
 * What a narrative's writer is given as its data: each data set it names, as
 * a list of rows by column title, the first rows of each while the whole
 * stays within `WRITER_DATA_MAX`. The headline numbers ride along, so the
 * prose can say them without working them out again.
 */
export function writerData(sets: readonly string[], data: Record<string, DataSet>, headline: Record<string, number | null>): string {
  let rows = WRITER_ROWS
  for (;;) {
    const out = {
      headline,
      data: Object.fromEntries(sets.map((name) => {
        const set = data[name]
        if (!set || set.error) return [name, { error: set?.error ?? 'not read' }]
        return [name, { total: set.total, rows: set.rows.slice(0, rows).map((r) => Object.fromEntries(set.columns.map((c, i) => [c.title, r[i] ?? null]))) }]
      })),
    }
    const text = JSON.stringify(out)
    if (text.length <= WRITER_DATA_MAX || rows <= 1) return text.slice(0, WRITER_DATA_MAX)
    rows = Math.floor(rows / 2)
  }
}

/** A number as a person reads it in a report: grouped, with the places its stat asks for, or up to two. */
export function formatNumber(value: number | null, decimals?: number, unit?: string): string {
  if (value === null) return '–'
  const places = decimals ?? (Number.isInteger(value) ? 0 : 2)
  return `${value.toLocaleString('en-US', { minimumFractionDigits: decimals ?? 0, maximumFractionDigits: places })}${unit ?? ''}`
}

/** A change since the edition before, said with its sign, and whether it is good, bad, or neither. */
export function changeOf(stat: Pick<EditionStat, 'value' | 'was' | 'better' | 'decimals' | 'unit'>): { text: string; tone: 'good' | 'bad' | 'flat' } | null {
  if (stat.value === null || stat.was === null) return null
  const d = stat.value - stat.was
  if (d === 0) return { text: 'no change', tone: 'flat' }
  const tone = !stat.better ? 'flat' : (d > 0) === (stat.better === 'up') ? 'good' : 'bad'
  return { text: `${d > 0 ? '▲' : '▼'} ${formatNumber(Math.abs(d), stat.decimals, stat.unit)}`, tone }
}
