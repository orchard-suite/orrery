// What the ground pages say in words. The atlas reads with a garden's names:
// each is said here once, with the sentences every page shares, so a picture
// never says something its numbers do not. What a name stands for is said in
// each picture's key and in docs/ground.md, never as text on a page. A
// garden's word never reaches an address or the API.

import { plain, type GroundBehind, type GroundBehindRow, type GroundCover, type GroundCrossing, type GroundGuard, type GroundItem, type GroundMeasure, type LensTrend } from '../shared/ground.ts'
import { overBudget, type FieldBudget, type FieldDef, type GroundDef } from '../shared/model.ts'

/** The name of each part of a ground. */
export const WORDS = {
  sky: 'The ground',
  item: 'bed',
  rounds: 'The rounds',
  templates: 'Seeds and the greenhouse',
  template: 'Seed',
  trial: 'Under glass',
  forecast: 'The forecast',
  seasons: 'Seasons',
  fix: 'To fix',
  measures: 'Numbers',
  guards: 'Checks',
  foundations: 'Details',
  taught: 'The root line',
  hands: 'Hands',
  storm: 'in a storm',
  fog: 'in fog',
} as const

export type GroundWord = keyof typeof WORDS

/** The name of each part of a map. */
export const MAP_WORDS = {
  sky: 'Sky',
  planet: 'Planet',
  planets: 'planets',
  parts: 'Regions',
  place: 'Continent',
  plots: 'Gardens',
  plot: 'Garden',
  open: 'Open ground',
  /** One kind of thing on the open ground of one place: the unit open ground is counted and ranked in. */
  patch: 'patch',
  patches: 'patches',
  /** Everything tied to no place: the members on none, and each plot's own checks. */
  unplaced: 'The workshop',
  plant: 'plant',
  plants: 'plants',
  tend: 'Tend first',
  /** The climbs a person puts on their way through a continent or a garden, and the word for each. */
  walk: 'Your walk',
  climbs: 'The walk',
  stop: 'stop',
  /** How far a continent or a garden has grown, by the share of its checked things in full bloom: one word a stage. */
  growth: ['Bare', 'Sprouting', 'Budding', 'Blooming', 'Full bloom'],
  holding: 'holding',
  broken: 'broken',
  nodata: 'no data',
} as const

export type MapWords = typeof MAP_WORDS

/** How some entities moved on a lens since last week, in a few words. Empty when no past is kept: never "the same" for what is not known. */
export function trendText(t: LensTrend | null): string {
  if (!t) return ''
  if (!t.better && !t.worse) return 'same as last week'
  return [t.worse ? `${t.worse.toLocaleString('en-US')} worse` : '', t.better ? `${t.better.toLocaleString('en-US')} better` : ''].filter(Boolean).join(', ') + ' than last week'
}

/** A count of checks in a sentence: broken first, then those with no data. "No data" is never read as a pass. */
export function checksText(failing: number, unknown: number): string {
  if (!failing && !unknown) return 'Every check holds'
  return [failing ? `${failing.toLocaleString('en-US')} broken` : '', unknown ? `${unknown.toLocaleString('en-US')} with no data` : ''].filter(Boolean).join(', ')
}

/** A count with its noun: "1 thing", "3 things". */
export function counted(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`
}

/** How much of a ground is inside its budgets, as a sentence. */
export function coverText(g: GroundCover): string {
  if (g.share === null) return `${g.items.toLocaleString('en-US')} with no budget to hold`
  return `${g.inside.toLocaleString('en-US')} of ${g.measured.toLocaleString('en-US')} inside every budget`
}

/** A budget in words: "at most 15", "at least 80", "3 to 15". */
export function budgetText(budget: FieldBudget | null): string {
  if (!budget || (budget.max === undefined && budget.min === undefined)) return 'no budget'
  if (budget.max !== undefined && budget.min !== undefined) return `${plain(budget.min)} to ${plain(budget.max)}`
  return budget.max !== undefined ? `at most ${plain(budget.max)}` : `at least ${plain(budget.min ?? 0)}`
}

/** Where a number stands against its budget, in a word or two. */
export function standing(m: Pick<GroundMeasure, 'value' | 'budget' | 'over'>): string {
  if (m.value === null) return 'not known'
  if (!m.budget) return 'no budget'
  return m.over ? 'outside its budget' : 'inside its budget'
}

/** One number as a sentence part: "Pipeline minutes 19, outside its budget of at most 15". */
export function measureText(m: GroundMeasure): string {
  if (m.value === null) return `${m.title} not known`
  return m.budget ? `${m.title} ${plain(m.value)}, ${standing(m)} of ${budgetText(m.budget)}` : `${m.title} ${plain(m.value)}`
}

/** How far a number moved this week: "up 4 this week". Empty when its past is not kept or it did not move. */
export function weekText(m: Pick<GroundMeasure, 'week'>): string {
  if (m.week === null || m.week === 0) return ''
  return `${m.week > 0 ? 'up' : 'down'} ${plain(Math.abs(m.week))} this week`
}

/**
 * One thing to fix on a bed. A number outside its budget that counts or
 * reads related things names those things, so the fix is each of them: one
 * that breaks several numbers is one fix. A number with nothing behind it to
 * name, a fence that does not hold, and a reason for the entity's own status
 * that no named thing already gives are each a fix of their own.
 */
export type ToFix =
  | { kind: 'thing'; row: GroundBehindRow; breaks: GroundMeasure[] }
  | { kind: 'measure'; measure: GroundMeasure }
  | { kind: 'guard'; guard: GroundGuard }
  | { kind: 'status'; reason: string }

/**
 * The things a number outside its budget is broken by: what it counted, when
 * it is a count over its most; what it read whose own value is past its most,
 * for a highest or a lowest. None when it is under its least, which no one
 * thing causes.
 */
function culprits(m: GroundMeasure, behind: GroundBehind | undefined, fn: string): GroundBehindRow[] {
  const max = m.budget?.max
  if (!behind || max === undefined || m.value === null || m.value <= max) return []
  const read = behind.rows.filter((r) => r.counted !== false)
  if (fn === 'count') return read
  return read.filter((r) => overBudget(r.value, { max }))
}

/** What to fix on one bed, the things that break the most numbers first. */
export function toFix(item: Pick<GroundItem, 'measures' | 'reasons' | 'level'>, guards: readonly GroundGuard[], behind: ReadonlyMap<string, GroundBehind>, fnOf: (field: string) => string): ToFix[] {
  const things = new Map<string, Extract<ToFix, { kind: 'thing' }>>()
  const measures: ToFix[] = []
  for (const m of item.measures.filter((x) => x.over)) {
    const named = culprits(m, behind.get(m.field), fnOf(m.field))
    if (!named.length) measures.push({ kind: 'measure', measure: m })
    for (const row of named) {
      const id = `${row.blueprint}:${row.key}`
      const had = things.get(id)
      if (had) had.breaks.push(m)
      else things.set(id, { kind: 'thing', row, breaks: [m] })
    }
  }
  // A grey entity is not judged: its reasons say why, and are nothing to fix.
  const judged = item.level === 'red' || item.level === 'amber' ? item.reasons : []
  const reached = [...behind.values()].flatMap((b) => b.rows)
  const status: ToFix[] = []
  for (const reason of judged) {
    if ([...things.values()].some((t) => t.row.reasons.includes(reason))) continue
    // A reason one of the things it reached gives is that thing's to fix, though it breaks no number.
    const giver = reached.find((r) => r.reasons.includes(reason))
    const id = giver && `${giver.blueprint}:${giver.key}`
    if (giver && id && !things.has(id)) things.set(id, { kind: 'thing', row: giver, breaks: [] })
    else if (!giver) status.push({ kind: 'status', reason })
  }
  return [
    ...[...things.values()].sort((a, b) => b.breaks.length - a.breaks.length || a.row.title.localeCompare(b.row.title)),
    ...measures,
    ...guards.filter((g) => g.on === false).map((guard): ToFix => ({ kind: 'guard', guard })),
    ...status,
  ]
}

/**
 * A related thing's name as it reads beside the entity it belongs to: what
 * follows the entity's own name and a separator, so "cloud/finops / Pipeline"
 * reads "Pipeline" on finops. The whole name where it does not hold it.
 */
export function nameBeside(title: string, owner: string): string {
  for (const sep of [' / ', '/']) {
    const at = title.lastIndexOf(`${owner}${sep}`)
    const rest = at < 0 ? '' : title.slice(at + owner.length + sep.length)
    if (rest) return rest
  }
  return title
}

/** How many things to fix, as the line under a bed's name. */
export function fixText(fixes: readonly ToFix[]): string {
  if (!fixes.length) return 'Nothing to fix.'
  return `${fixes.length} ${fixes.length === 1 ? 'thing' : 'things'} to fix.`
}

/** What a number should be, from its budget: "should be 0", "should be at most 15". Empty with no budget. */
export function goalText(budget: FieldBudget | null): string {
  if (!budget || (budget.max === undefined && budget.min === undefined)) return ''
  if (budget.max !== undefined && budget.min !== undefined) return budget.max === budget.min ? `should be ${plain(budget.max)}` : `should be ${plain(budget.min)} to ${plain(budget.max)}`
  if (budget.max === 0) return 'should be 0'
  return budget.max !== undefined ? `should be at most ${plain(budget.max)}` : `should be at least ${plain(budget.min ?? 0)}`
}

/** The fold under a number that opens what it was worked out from: "Show the 1 pipeline", "Show the 3 pipelines". Empty when a count counted none. */
export function foldText(b: Pick<GroundBehind, 'reached' | 'counted'>, fn: string, noun: string): string {
  const shown = fn === 'count' && b.counted !== null ? b.counted : b.reached
  return shown ? `Show the ${counted(shown, noun)}` : ''
}

/** Why a thing is on the list, by the number it puts out of line: "Why Red pipelines is 1." */
export function breaksText(m: Pick<GroundMeasure, 'title' | 'value'>): string {
  return `Why ${m.title} is ${m.value === null ? 'not known' : plain(m.value)}.`
}

/** A check's answer in a word. */
export function checkText(on: boolean | null): string {
  return on === null ? 'Unknown' : on ? 'Yes' : 'No'
}

/** What one line under a number shows on its right: the value the number read of it, or nothing for a count. */
export function valueText(row: Pick<GroundBehindRow, 'value' | 'counted'>, fn: string): string {
  if (fn === 'count' || row.counted === false || row.value === null) return ''
  return typeof row.value === 'number' ? plain(row.value) : String(row.value)
}

/**
 * What the titles of a receipt's lines share at their start, cut back to the
 * last separator (" / " or "/"), so each line can show only what tells it
 * apart. Empty unless there are two or more and what is left of each is not.
 */
export function sharedStart(titles: readonly string[]): string {
  if (titles.length < 2) return ''
  let common = titles[0]!
  for (const t of titles) while (!t.startsWith(common)) common = common.slice(0, -1)
  const cut = Math.max(common.lastIndexOf(' / ') + 3, common.lastIndexOf('/') + 1)
  const start = cut > 0 ? common.slice(0, cut) : ''
  return start && titles.every((t) => t.length > start.length) ? start : ''
}

/** Everything a picture of one entity shows, as the sentence a screen reader says. */
export function itemText(item: GroundItem, status: string): string {
  const parts = [`${item.title}: ${status}`, ...item.measures.map(measureText)]
  if (item.trial) parts.push('on trial')
  if (item.template) parts.push(item.template.behind ? `started from ${item.template.title} at ${item.template.version}, now at ${item.template.current}` : `started from ${item.template.title}`)
  return `${parts.join('. ')}.`
}

/** A count of days as a person says it: "3 days", "about 2 weeks". */
export function spanText(days: number): string {
  if (days === 1) return '1 day'
  if (days < 14) return `${days} days`
  return `about ${Math.round(days / 7)} weeks`
}

/** A number on its way out of its budget: "Pipeline minutes is 13 and reaches its budget of 15 in about 2 weeks". One already there is said so. */
export function crossingText(c: GroundCrossing): string {
  if (c.value === c.limit) return `${c.measure} is ${plain(c.value)}, right at its budget, and on its way out`
  return `${c.measure} is ${plain(c.value)} and reaches its budget of ${plain(c.limit)} in ${spanText(c.days)}`
}

/** The day a date falls due, from the day the hub named. */
export function dueDay(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' })
}

/** The actions that may run on every one of the entities, of those the reader may run at all, in the order given. */
export function sharedActions(items: Pick<GroundItem, 'actions'>[], runnable: string[]): string[] {
  if (!items.length) return []
  return runnable.filter((id) => items.every((i) => i.actions.includes(id)))
}

/** A share as a whole percent. */
export function percent(share: number): string {
  return `${Math.round(share * 100)}%`
}

/** A field's budget with one side typed again: empty takes the side away, and a half-typed number changes nothing yet. */
export function withBudget(def: FieldDef, side: keyof FieldBudget, text: string): FieldDef {
  const typed = text.trim()
  const n = Number(typed)
  if (typed && !Number.isFinite(n)) return def
  const { budget: was, ...rest } = def
  const { [side]: _drop, ...kept } = was ?? {}
  const budget: FieldBudget = typed ? { ...kept, [side]: n } : kept
  return budget.max === undefined && budget.min === undefined ? rest : { ...rest, budget }
}

/** A ground as it is saved: only the parts that name something. Nothing named is no ground at all. */
export function tidyGround(ground: GroundDef): GroundDef | undefined {
  const named = (value: unknown): boolean => (Array.isArray(value) ? value.length > 0 : typeof value === 'object' && value !== null ? Object.keys(value).length > 0 : value !== undefined && value !== '')
  const template = ground.template?.relation ? (Object.fromEntries(Object.entries(ground.template).filter(([, v]) => named(v))) as GroundDef['template']) : undefined
  const tidy = Object.fromEntries(Object.entries({ ...ground, template }).filter(([, v]) => named(v))) as GroundDef
  return Object.keys(tidy).length ? tidy : undefined
}
