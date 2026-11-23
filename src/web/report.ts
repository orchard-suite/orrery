// What the report pages work out: each headline number's trend across a
// report's editions, two editions side by side, when a report publishes next,
// a layout's blocks said in a line each, and what the form does to a draft.
// Pure, so it is tested alone; the components draw it.

import type { ReportEditionLine, ReportEditionRead, ReportLine, ReportStat } from '../shared/api.ts'
import { STATUS_LEVELS, type StatusLevel, type TrendValue } from '../shared/model.ts'
import { cellText, changeOf, headlineOf, nameOf, type DraftBlock, type EditionStat, type LayoutBlock, type LayoutDraft } from '../shared/report.ts'

/** Each headline number across the editions, oldest first: one point an edition that holds it. A number no edition holds has no trend. */
export function trendsOf(stats: readonly ReportStat[], editions: readonly ReportEditionLine[]): { stat: ReportStat; trend: TrendValue }[] {
  const oldest = [...editions].sort((a, b) => a.number - b.number)
  return stats.flatMap((stat) => {
    const points = oldest.flatMap((e) => (typeof e.headline[stat.name] === 'number' ? [{ at: e.publishedAt, value: e.headline[stat.name] as number }] : []))
    return points.length ? [{ stat, trend: { points, ...(stat.unit ? { unit: stat.unit } : {}) } }] : []
  })
}

/** One headline number in two editions, with how it moved from the older to the newer. */
export interface ComparedStat {
  name: string
  title: string
  older: number | null
  newer: number | null
  change: ReturnType<typeof changeOf>
  stat: Pick<EditionStat, 'unit' | 'decimals'>
}

/** One data set in two editions: the columns either holds, and each one's rows under them. */
export interface ComparedData {
  name: string
  columns: string[]
  older: { rows: string[][]; total: number; error?: string } | null
  newer: { rows: string[][]; total: number; error?: string } | null
}

/** The most rows of each data set a comparison shows. */
export const COMPARED_ROWS = 50

/** Two editions side by side, the older first whichever was named first. */
export function compareEditions(a: ReportEditionRead, b: ReportEditionRead): { older: number; newer: number; stats: ComparedStat[]; data: ComparedData[] } {
  const [older, newer] = a.content.number <= b.content.number ? [a, b] : [b, a]
  const titled = new Map<string, EditionStat>()
  for (const e of [older, newer]) for (const block of e.content.blocks) if (block.kind === 'stats') for (const i of block.items) titled.set(i.name, i)
  const ho = headlineOf(older.content.blocks)
  const hn = headlineOf(newer.content.blocks)
  const stats = [...titled.values()].map((i): ComparedStat => {
    const o = ho[i.name] ?? null
    const n = hn[i.name] ?? null
    return { name: i.name, title: i.title, older: o, newer: n, change: changeOf({ value: n, was: o, ...(i.better ? { better: i.better } : {}), ...(i.unit !== undefined ? { unit: i.unit } : {}), ...(i.decimals !== undefined ? { decimals: i.decimals } : {}) }), stat: { ...(i.unit !== undefined ? { unit: i.unit } : {}), ...(i.decimals !== undefined ? { decimals: i.decimals } : {}) } }
  })
  const names = [...new Set([...Object.keys(older.data), ...Object.keys(newer.data)])]
  const data = names.map((name): ComparedData => {
    const o = older.data[name]
    const n = newer.data[name]
    const columns = [...new Set([...(o?.columns ?? []), ...(n?.columns ?? [])].map((c) => c.title))]
    const side = (set: typeof o) => {
      if (!set) return null
      const at = columns.map((title) => set.columns.findIndex((c) => c.title === title))
      return { rows: set.rows.slice(0, COMPARED_ROWS).map((r) => at.map((i) => (i < 0 ? '' : cellText(r[i])))), total: set.total, ...(set.error ? { error: set.error } : {}) }
    }
    return { name, columns, older: side(o), newer: side(n) }
  })
  return { older: older.content.number, newer: newer.content.number, stats, data }
}

/** A report's status as the lamp draws it: grey for anything the lamp has no level for. */
const LEVELS: readonly string[] = STATUS_LEVELS
export const levelOf = (status: string): StatusLevel => (LEVELS.includes(status) ? (status as StatusLevel) : 'grey')

/** When a report publishes next, in words: its first schedule that fires, or what it waits for. */
export function nextOf(report: Pick<ReportLine, 'schedules'>): string {
  const live = report.schedules.find((s) => s.state === 'active')
  if (live) return live.when
  const waiting = report.schedules.find((s) => s.state === 'awaiting')
  if (waiting) return `${waiting.when}, waiting for approval`
  return report.schedules.length ? `${report.schedules[0]!.when}, paused` : 'No schedule'
}

/** One block, said in a line. */
export function blockLine(b: LayoutBlock): { kind: string; says: string } {
  const titled = (rest: string) => ('title' in b && b.title ? `${b.title}: ${rest}` : rest)
  switch (b.kind) {
    case 'heading':
      return { kind: 'Heading', says: b.text }
    case 'text':
      return { kind: 'Text', says: b.text.replace(/\s+/g, ' ') }
    case 'stats':
      return { kind: 'Numbers', says: titled(b.items.length ? b.items.map((i) => i.title ?? i.name).join(', ') : `what ${b.data} adds up`) }
    case 'chart':
      return { kind: 'Chart', says: titled(b.x || b.y.length ? `${b.y.join(', ') || 'first number'} by ${b.x ?? 'first column'}, from ${b.data}` : `as ${b.data} shows it`) }
    case 'table':
      return { kind: 'Table', says: titled(`${b.data}, ${b.limit} rows`) }
    case 'scorecard':
      return { kind: 'Scorecard', says: titled(`${b.data}, by ${b.label ?? 'first column'}${b.health ? `, marking ${Object.keys(b.health).join(', ')}` : ''}${b.trend ? `, ${b.trend.columns.length} trend bars` : ''}`) }
    case 'narrative':
      return { kind: 'Written', says: titled(b.instruction.replace(/\s+/g, ' ')) }
    case 'rest':
      return { kind: 'Written', says: titled('the rest of the summary above') }
  }
}

/** A name for a new data set, from a query's title, that the draft does not hold yet. */
export function freeName(title: string, taken: readonly string[]): string {
  const base = nameOf(title).slice(0, 40) || 'data'
  if (!taken.includes(base)) return base
  for (let n = 2; ; n++) if (!taken.includes(`${base}_${n}`)) return `${base}_${n}`
}

/** A draft with one data set gone, and every block that read only it: a block that reads several keeps the rest. */
export function withoutData(draft: LayoutDraft, name: string): LayoutDraft {
  const { [name]: _gone, ...data } = draft.data
  const blocks = draft.blocks.flatMap((b): DraftBlock[] => {
    if (b.kind === 'narrative') return b.data.includes(name) ? (b.data.length > 1 ? [{ ...b, data: b.data.filter((d) => d !== name) }] : []) : [b]
    return 'data' in b && b.data === name ? [] : [b]
  })
  return { ...draft, data, blocks }
}
