// The ground: the entities of one blueprint, read for how each is doing
// against the numbers its estate set. A blueprint's `ground` names which of
// its fields mean what (`GroundDef`), and a number field's `budget` says the
// range it should stay in. Everything here is worked out from the entities a
// reader may see, so it holds nothing their view does not. The names here
// are plain ones: a caller reads "over", "inside", and "unwanted", whatever
// picture the web app draws of them.

import { compare, fieldOf } from './filter.ts'
import { isTrendHistory, overBudget, type AggregationDef, type Blueprint, type Entity, type FieldBudget, type RelatedRef, type StatusLevel } from './model.ts'

export const GROUND_ROLES = ['loop', 'friction', 'unwanted'] as const
export type GroundRole = (typeof GROUND_ROLES)[number]

/** How much of something there is, none to a lot: against its budget when it has an upper one, else against the most any entity has. */
export type Bucket = 0 | 1 | 2 | 3

const DAY = 86_400_000
/** The most entities one ground reads. A blueprint that holds more says how many it read. */
export const GROUND_LIMIT = 2000
/** How many entities the rounds name. */
export const ROUNDS = 10
/** The past a forecast fits its line to, and how far ahead it looks for a number to leave its budget. */
export const FORECAST_PAST_DAYS = 28
export const FORECAST_DAYS = 60
/** How far ahead the forecast reads dates. */
export const AHEAD_DAYS = 14
/** How many weeks the seasons go back. */
export const SEASON_WEEKS = 12

export interface GroundPoint {
  at: string
  value: number
}

/** A number the ground reads of every entity: the three named ones, then every other number that has a budget. */
export interface GroundField {
  field: string
  title: string
  role: GroundRole | null
  budget: FieldBudget | null
  /** The `trend` field that holds its past, when one does. */
  trend: string | null
}

export interface GroundMeasure {
  field: string
  title: string
  role: GroundRole | null
  value: number | null
  budget: FieldBudget | null
  over: boolean
  bucket: Bucket
  /** How far it moved over the last week, where its past is kept. */
  week: number | null
}

export interface GroundTemplateRef {
  blueprint: string
  key: string
  title: string
  /** The version the entity was started at. */
  version: string | null
  /** The version of the template now. */
  current: string | null
  behind: boolean
}

/** An address an entity holds of itself, such as a repository's page at its forge. */
export interface GroundLink {
  title: string
  url: string
}

/** The addresses an entity holds in its `url` fields, as the blueprint the reader sees names them. Only a web address is one. */
export function linksOf(bp: Blueprint | undefined, e: Pick<Entity, 'fields'>): GroundLink[] {
  if (!bp) return []
  const out: GroundLink[] = []
  for (const [name, def] of Object.entries(bp.fields)) {
    const value = e.fields[name]
    if (def.type === 'url' && typeof value === 'string' && /^https?:\/\//i.test(value)) out.push({ title: def.title ?? name, url: value })
  }
  return out
}

export interface GroundItem {
  key: string
  title: string
  icon: string | null
  level: StatusLevel
  reasons: string[]
  measures: GroundMeasure[]
  /** How many of its numbers are outside their budget. */
  over: number
  /** Whether every budgeted number it holds is inside its budget. Null when it holds none. */
  inside: boolean | null
  activity: number | null
  activityBucket: Bucket
  /** Changes to the platform land on this one first. */
  trial: boolean
  template: GroundTemplateRef | null
  taughtBy: RelatedRef[]
  /** The actions the reader may run on it, by id. */
  actions: string[]
  /** Its own addresses: each `url` field that holds one, by the field's title. */
  links: GroundLink[]
  /** How much worse its numbers got this week, as a share of their budgets. */
  worse: number
  /** Why it is worth a visit, in plain words. Empty when nothing is. */
  why: string[]
}

export interface GroundCover {
  items: number
  /** How many hold a budgeted number. */
  measured: number
  /** How many of those are inside every budget. */
  inside: number
  share: number | null
}

export interface GroundRound {
  key: string
  title: string
  level: StatusLevel
  why: string[]
}

export interface GroundTemplate {
  blueprint: string
  key: string
  title: string
  current: string | null
  /** How many entities were started from it. */
  planted: number
  /** How many of those are on an older version. */
  behind: number
}

export interface GroundCrossing {
  key: string
  title: string
  field: string
  measure: string
  value: number
  limit: number
  days: number
}

export interface GroundAhead {
  day: string
  field: string
  title: string
  items: { key: string; title: string }[]
}

export interface GroundSeason {
  /** The day the week ends. */
  week: string
  measured: number
  inside: number
  share: number | null
}

export interface Ground {
  fields: GroundField[]
  /** Worst first. */
  items: GroundItem[]
  cover: GroundCover
  rounds: GroundRound[]
  templates: GroundTemplate[]
  forecast: {
    crossings: GroundCrossing[]
    ahead: GroundAhead[]
    /** The budgeted numbers whose past is not kept, by title: the forecast and the seasons cannot read them. */
    without: string[]
  }
  seasons: GroundSeason[]
}

const LEVEL_ORDER: Record<StatusLevel, number> = { red: 0, amber: 1, green: 2, grey: 3 }

/** A number as a sentence says it: at most one decimal place. */
export function plain(n: number): string {
  return String(Number(n.toFixed(1)))
}

/** The numbers a blueprint's ground reads. A named field that is gone, or is not a number, is left out. */
export function groundFields(bp: Blueprint): GroundField[] {
  const out: GroundField[] = []
  const add = (field: string | undefined, role: GroundRole | null) => {
    const def = field ? bp.fields[field] : undefined
    if (!field || def?.type !== 'number' || out.some((f) => f.field === field)) return
    out.push({ field, title: def.title ?? field, role, budget: def.budget ?? null, trend: trendFieldOf(bp, field) })
  }
  for (const role of GROUND_ROLES) add(bp.ground?.[role], role)
  for (const [name, def] of Object.entries(bp.fields)) if (def.budget) add(name, null)
  return out
}

function trendFieldOf(bp: Blueprint, field: string): string | null {
  const named = bp.ground?.trends?.[field]
  if (named && bp.fields[named]?.type === 'trend') return named
  for (const [name, def] of Object.entries(bp.fields)) if (def.type === 'trend' && isTrendHistory(def.history) && def.history.of === field) return name
  return null
}

interface Past {
  at: number
  value: number
}

/** The points of a trend value, oldest first. Anything else holds none. */
function pastOf(value: unknown): Past[] {
  if (!value || typeof value !== 'object' || !('points' in value) || !Array.isArray(value.points)) return []
  const out: Past[] = []
  for (const p of value.points as unknown[]) {
    if (!p || typeof p !== 'object' || !('at' in p) || !('value' in p)) continue
    const at = typeof p.at === 'string' ? Date.parse(p.at) : NaN
    if (Number.isFinite(at) && typeof p.value === 'number' && Number.isFinite(p.value)) out.push({ at, value: p.value })
  }
  return out.sort((a, b) => a.at - b.at)
}

/** The value held at a moment: the last point at or before it. */
function heldAt(past: Past[], at: number): number | null {
  let held: number | null = null
  for (const p of past) {
    if (p.at > at) break
    held = p.value
  }
  return held
}

const numberOf = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const textOf = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : typeof value === 'number' ? String(value) : null)

export function bucketOf(value: number | null, budget: FieldBudget | null, largest: number): Bucket {
  if (value === null || value <= 0) return 0
  const top = budget?.max
  if (top !== undefined) return value > top ? 3 : value > top / 2 ? 2 : 1
  if (largest <= 0) return 0
  const share = value / largest
  return share > 2 / 3 ? 3 : share > 1 / 3 ? 2 : 1
}

/** A budget with only a lower end is one a falling number leaves. */
const fallingIsWorse = (budget: FieldBudget | null) => budget?.max === undefined && budget?.min !== undefined

function overWords(title: string, value: number, budget: FieldBudget): string {
  if (budget.max !== undefined && value > budget.max) return `${title} is ${plain(value)}, over its budget of ${plain(budget.max)}`
  return `${title} is ${plain(value)}, under its budget of ${plain(budget.min ?? 0)}`
}

export function coverOf(items: Pick<GroundItem, 'inside'>[]): GroundCover {
  const measured = items.filter((i) => i.inside !== null).length
  const inside = items.filter((i) => i.inside === true).length
  return { items: items.length, measured, inside, share: measured ? inside / measured : null }
}

export interface GroundInput {
  now: number
  /** The version each template is at now, by its entity id. */
  currents: ReadonlyMap<string, string | null>
}

/** The ground of a blueprint, from the entities a reader may see and the blueprint as that reader sees it. */
export function buildGround(bp: Blueprint, entities: Entity[], input: GroundInput): Ground {
  const def = bp.ground ?? {}
  const fields = groundFields(bp)
  const largest = new Map<string, number>()
  for (const f of fields) largest.set(f.field, Math.max(0, ...entities.map((e) => numberOf(e.fields[f.field]) ?? 0)))
  const activityField = def.activity && bp.fields[def.activity]?.type === 'number' ? def.activity : null
  const mostActive = activityField ? Math.max(0, ...entities.map((e) => numberOf(e.fields[activityField]) ?? 0)) : 0
  const weekAgo = input.now - 7 * DAY
  const pasts = new Map<string, Map<string, Past[]>>()

  const items = entities.map((e): GroundItem => {
    const mine = new Map<string, Past[]>()
    pasts.set(e.key, mine)
    const why: string[] = []
    let worse = 0
    const measures = fields.map((f): GroundMeasure => {
      const value = numberOf(e.fields[f.field])
      const past = f.trend ? pastOf(e.fields[f.trend]) : []
      if (past.length) mine.set(f.field, past)
      const before = heldAt(past, weekAgo)
      const week = value !== null && before !== null ? value - before : null
      const over = overBudget(value, f.budget ?? undefined)
      if (over && value !== null && f.budget) why.push(overWords(f.title, value, f.budget))
      if (week !== null && week !== 0) {
        const falling = fallingIsWorse(f.budget)
        const gotWorse = falling ? week < 0 : week > 0
        if (gotWorse) {
          worse += Math.abs(week) / Math.max(Math.abs(f.budget?.max ?? f.budget?.min ?? before ?? 1), 1)
          why.push(`${f.title} ${falling ? 'down' : 'up'} ${plain(Math.abs(week))} this week`)
        }
      }
      return { field: f.field, title: f.title, role: f.role, value, budget: f.budget, over, bucket: bucketOf(value, f.budget, largest.get(f.field) ?? 0), week }
    })
    const budgeted = measures.filter((m) => m.budget && m.value !== null)
    const over = measures.filter((m) => m.over).length
    const activity = activityField ? numberOf(e.fields[activityField]) : null
    return {
      key: e.key,
      title: e.title,
      icon: e.icon,
      level: e.status.level,
      reasons: e.status.reasons,
      measures,
      over,
      inside: budgeted.length ? over === 0 : null,
      activity,
      activityBucket: bucketOf(activity, null, mostActive),
      trial: !!def.trial && e.fields[def.trial] === true,
      template: templateOf(bp, e, input.currents),
      taughtBy: def.taughtBy ? (e.relations[def.taughtBy] ?? []) : [],
      actions: e.actions ?? [],
      links: linksOf(bp, e),
      worse,
      why,
    }
  })
  items.sort((a, b) => b.over - a.over || LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || b.worse - a.worse || a.title.localeCompare(b.title))

  const budgeted = fields.filter((f) => f.budget)
  return {
    fields,
    items,
    cover: coverOf(items),
    rounds: roundsOf(items),
    templates: templatesOf(items),
    forecast: {
      crossings: crossingsOf(items, budgeted, pasts, input.now),
      ahead: aheadOf(bp, entities, input.now),
      without: budgeted.filter((f) => !f.trend).map((f) => f.title),
    },
    seasons: seasonsOf(items, budgeted, pasts, input.now),
  }
}

function templateOf(bp: Blueprint, e: Entity, currents: ReadonlyMap<string, string | null>): GroundTemplateRef | null {
  const t = bp.ground?.template
  const ref = t ? e.relations[t.relation]?.[0] : undefined
  if (!t || !ref) return null
  const version = t.version ? textOf(e.fields[t.version]) : null
  const current = currents.get(`${ref.blueprint}:${ref.key}`) ?? null
  return { blueprint: ref.blueprint, key: ref.key, title: ref.title ?? ref.key, version, current, behind: version !== null && current !== null && version !== current }
}

/** Where to go first: what got worse this week, then what is furthest outside its budgets, then what is red. */
function roundsOf(items: GroundItem[]): GroundRound[] {
  return items
    .filter((i) => i.why.length > 0 || i.level === 'red' || i.level === 'amber')
    .sort((a, b) => b.worse - a.worse || b.over - a.over || LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || a.title.localeCompare(b.title))
    .slice(0, ROUNDS)
    .map((i) => ({ key: i.key, title: i.title, level: i.level, why: [...i.why, ...(i.level === 'red' || i.level === 'amber' ? i.reasons.map((r) => `Status is ${i.level}: ${r}`) : [])] }))
}

function templatesOf(items: GroundItem[]): GroundTemplate[] {
  const out = new Map<string, GroundTemplate>()
  for (const { template: t } of items) {
    if (!t) continue
    const id = `${t.blueprint}:${t.key}`
    let row = out.get(id)
    if (!row) out.set(id, (row = { blueprint: t.blueprint, key: t.key, title: t.title, current: t.current, planted: 0, behind: 0 }))
    row.planted++
    if (t.behind) row.behind++
  }
  return [...out.values()].sort((a, b) => b.planted - a.planted || a.title.localeCompare(b.title))
}

/** The slope of the least-squares line through the points, per day. Null under three points or when they share one moment. */
function slopePerDay(points: Past[]): number | null {
  if (points.length < 3) return null
  const n = points.length
  const mx = points.reduce((s, p) => s + p.at, 0) / n
  const my = points.reduce((s, p) => s + p.value, 0) / n
  let top = 0
  let bottom = 0
  for (const p of points) {
    top += (p.at - mx) * (p.value - my)
    bottom += (p.at - mx) ** 2
  }
  return bottom === 0 ? null : (top / bottom) * DAY
}

/** Each number still inside its budget that its last four weeks carry out of it within the forecast's reach, soonest first. */
function crossingsOf(items: GroundItem[], budgeted: GroundField[], pasts: Map<string, Map<string, Past[]>>, now: number): GroundCrossing[] {
  const out: GroundCrossing[] = []
  for (const item of items) {
    for (const f of budgeted) {
      const m = item.measures.find((x) => x.field === f.field)
      const past = pasts.get(item.key)?.get(f.field)
      if (!m || m.value === null || m.over || !past || !f.budget) continue
      const slope = slopePerDay([...past.filter((p) => p.at >= now - FORECAST_PAST_DAYS * DAY && p.at < now), { at: now, value: m.value }])
      if (slope === null) continue
      const limit = slope > 0 ? f.budget.max : slope < 0 ? f.budget.min : undefined
      if (limit === undefined) continue
      const days = Math.max(1, Math.ceil((limit - m.value) / slope))
      if (days <= FORECAST_DAYS) out.push({ key: item.key, title: item.title, field: f.field, measure: f.title, value: m.value, limit, days })
    }
  }
  return out.sort((a, b) => a.days - b.days || a.title.localeCompare(b.title))
}

/** What the named dates say falls due in the days ahead, a row for each day and field. */
function aheadOf(bp: Blueprint, entities: Entity[], now: number): GroundAhead[] {
  const out = new Map<string, GroundAhead>()
  for (const field of bp.ground?.ahead ?? []) {
    const def = bp.fields[field]
    if (def?.type !== 'datetime') continue
    for (const e of entities) {
      const value = e.fields[field]
      const at = typeof value === 'string' ? Date.parse(value) : NaN
      if (!Number.isFinite(at) || at < now || at > now + AHEAD_DAYS * DAY) continue
      const day = new Date(at).toISOString().slice(0, 10)
      const id = `${day}\0${field}`
      let row = out.get(id)
      if (!row) out.set(id, (row = { day, field, title: def.title ?? field, items: [] }))
      row.items.push({ key: e.key, title: e.title })
    }
  }
  return [...out.values()].sort((a, b) => a.day.localeCompare(b.day) || a.title.localeCompare(b.title))
}

/** The share inside every budget at the end of each of the last weeks, from the pasts kept. Empty when no budgeted number keeps one. */
function seasonsOf(items: GroundItem[], budgeted: GroundField[], pasts: Map<string, Map<string, Past[]>>, now: number): GroundSeason[] {
  const kept = budgeted.filter((f) => f.trend)
  if (!kept.length) return []
  const out: GroundSeason[] = []
  for (let back = SEASON_WEEKS - 1; back >= 0; back--) {
    const at = now - back * 7 * DAY
    let measured = 0
    let inside = 0
    for (const item of items) {
      let known = false
      let over = false
      for (const f of kept) {
        const past = pasts.get(item.key)?.get(f.field)
        const value = back === 0 ? (item.measures.find((m) => m.field === f.field)?.value ?? null) : past ? heldAt(past, at) : null
        if (value === null) continue
        known = true
        if (overBudget(value, f.budget ?? undefined)) over = true
      }
      if (!known) continue
      measured++
      if (!over) inside++
    }
    out.push({ week: new Date(at).toISOString().slice(0, 10), measured, inside, share: measured ? inside / measured : null })
  }
  return out
}

/** The most things a number's receipt names; the rest are only counted. */
export const BEHIND_SHOWN = 50

/** One thing a worked-out number read: whether it counted, and what it holds that the number read. */
export interface GroundBehindRow {
  blueprint: string
  key: string
  title: string
  icon: string | null
  level: StatusLevel
  reasons: string[]
  /** The value of the field the number reads on it; null for a count, or where it holds none. */
  value: number | string | boolean | null
  /** Whether the number read it: it meets the number's condition and falls in its window. Null when the window cannot be read. */
  counted: boolean | null
  links: GroundLink[]
}

/** What a number worked out from related things read, as the reader may see it: the receipt behind the number. */
export interface GroundBehind {
  field: string
  /** How many things the number's path reaches that the reader sees. */
  reached: number
  /** How many of them it read. Null when that cannot be said. */
  counted: number | null
  /** The first `BEHIND_SHOWN`: what it read first, the ones that set the number at the top, then the rest, worst first. */
  rows: GroundBehindRow[]
}

const SETS_TOP: Partial<Record<AggregationDef['fn'], 1 | -1>> = { min: 1, max: -1, sum: -1, avg: -1, median: -1, p90: -1 }

/**
 * The receipt behind an aggregation: every thing it reached, each marked by
 * `reads` (the hub's own test of what the aggregation reads, or null when it
 * cannot be told), ordered so what set the number comes first.
 */
export function behindOf(field: string, agg: AggregationDef, related: Entity[], reads: ((e: Entity) => boolean) | null, bpOf: (id: string) => Blueprint | undefined): GroundBehind {
  const rows = related.map((e): GroundBehindRow => {
    const raw = agg.field ? fieldOf(e, agg.field) : null
    const value = typeof raw === 'number' || typeof raw === 'string' || typeof raw === 'boolean' ? raw : null
    return { blueprint: e.blueprint, key: e.key, title: e.title, icon: e.icon ?? null, level: e.status.level, reasons: e.status.reasons, value, counted: reads ? reads(e) : null, links: linksOf(bpOf(e.blueprint), e) }
  })
  const top = SETS_TOP[agg.fn]
  const rank = (r: GroundBehindRow) => (r.counted === false ? 1 : 0)
  rows.sort((a, b) => rank(a) - rank(b) || (top && a.value !== null && b.value !== null ? top * compare(a.value, b.value) : (a.value === null ? 1 : 0) - (b.value === null ? 1 : 0)) || LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || a.title.localeCompare(b.title))
  return { field, reached: rows.length, counted: reads ? rows.filter((r) => r.counted).length : null, rows: rows.slice(0, BEHIND_SHOWN) }
}

export interface GroundFoundation {
  field: string
  title: string
  value: string | null
}

export interface GroundGuard {
  field: string
  title: string
  /** Null when nothing says. */
  on: boolean | null
}

export interface GroundPeer {
  key: string
  title: string
  level: StatusLevel
  unwanted: number | null
}

/** What one entity is built on, deepest first, as the blueprint names it. */
export function foundationsOf(bp: Blueprint, e: Entity): GroundFoundation[] {
  return (bp.ground?.foundations ?? []).flatMap((field) => {
    const def = bp.fields[field]
    if (!def) return []
    const value = e.fields[field]
    const text = Array.isArray(value) ? value.map((v) => textOf(v)).filter((v) => v !== null).join(', ') || null : typeof value === 'boolean' ? (value ? 'Yes' : 'No') : textOf(value)
    return [{ field, title: def.title ?? field, value: text }]
  })
}

/** The limits an entity holds or does not, as the blueprint names them. */
export function guardsOf(bp: Blueprint, e: Entity): GroundGuard[] {
  return (bp.ground?.guards ?? []).flatMap((field) => {
    const def = bp.fields[field]
    if (def?.type !== 'boolean') return []
    const value = e.fields[field]
    return [{ field, title: def.title ?? field, on: typeof value === 'boolean' ? value : null }]
  })
}

/** The other entities of a ground that copied from the same place. */
export function peersOf(items: GroundItem[], source: RelatedRef, but: string): GroundPeer[] {
  return items
    .filter((i) => i.key !== but && i.taughtBy.some((t) => t.blueprint === source.blueprint && t.key === source.key))
    .map((i) => ({ key: i.key, title: i.title, level: i.level, unwanted: i.measures.find((m) => m.role === 'unwanted')?.value ?? null }))
}

/** The past kept of each number of one entity, oldest first. */
export function pastsOf(bp: Blueprint, e: Entity): Record<string, GroundPoint[]> {
  const out: Record<string, GroundPoint[]> = {}
  for (const f of groundFields(bp)) {
    const past = f.trend ? pastOf(e.fields[f.trend]) : []
    if (past.length) out[f.field] = past.map((p) => ({ at: new Date(p.at).toISOString(), value: p.value }))
  }
  return out
}

/** The named dates one entity holds that are still ahead, soonest first. */
export function datesAhead(bp: Blueprint, e: Entity, now: number): { field: string; title: string; at: string }[] {
  return (bp.ground?.ahead ?? [])
    .flatMap((field) => {
      const def = bp.fields[field]
      const value = e.fields[field]
      const at = def?.type === 'datetime' && typeof value === 'string' ? Date.parse(value) : NaN
      return Number.isFinite(at) && at >= now ? [{ field, title: def?.title ?? field, at: new Date(at).toISOString() }] : []
    })
    .sort((a, b) => a.at.localeCompare(b.at))
}

/** How one entity stands on a lens: outside the budget it asks about, inside it, or with no number to judge. */
export type LensState = 'over' | 'inside' | 'none'

/** The measures a lens reads of an entity: the one budgeted number it names, or every budgeted number for the lens of any. */
const lensMeasures = (item: Pick<GroundItem, 'measures'>, field: string | null) => item.measures.filter((m) => m.budget && (field === null || m.field === field))

/** Where an entity stands on a lens. `field` null is the lens of any broken budget. No number is never read as inside. */
export function lensState(item: Pick<GroundItem, 'measures'>, field: string | null): LensState {
  const known = lensMeasures(item, field).filter((m) => m.value !== null)
  if (!known.length) return 'none'
  return known.some((m) => m.over) ? 'over' : 'inside'
}

/** How a set of entities moved on a lens since last week, among those whose past is kept: how many came inside, went outside, and stayed. */
export interface LensTrend {
  better: number
  worse: number
  same: number
}

/**
 * How some entities moved on a lens over the last week: one that was outside
 * and is inside got better, one that was inside and is outside got worse.
 * Only an entity whose number keeps a past is counted; null when none does,
 * so a ground with no past says nothing rather than "the same".
 */
export function lensTrend(items: readonly Pick<GroundItem, 'measures'>[], field: string | null): LensTrend | null {
  const out: LensTrend = { better: 0, worse: 0, same: 0 }
  let known = 0
  for (const item of items) {
    const past = lensMeasures(item, field).filter((m) => m.value !== null && m.week !== null)
    if (!past.length) continue
    known++
    const now = past.some((m) => m.over)
    const before = past.some((m) => overBudget(m.value! - m.week!, m.budget ?? undefined))
    if (now === before) out.same++
    else if (now) out.worse++
    else out.better++
  }
  return known ? out : null
}

/** How far outside its budget a number is, as a share of the budget's own size, so numbers of different kinds rank together. */
function excess(m: GroundMeasure): number {
  if (!m.over || m.value === null || !m.budget) return 0
  const edge = m.budget.max !== undefined && m.value > m.budget.max ? m.budget.max : (m.budget.min ?? 0)
  return Math.abs(m.value - edge) / Math.max(Math.abs(edge), 1)
}

/** What a lens says of a ground: how many stand each way on it, how that moved, and where to go first for it. */
export interface GroundLens {
  field: string | null
  over: number
  inside: number
  none: number
  trend: LensTrend | null
  /** The entities outside it, the ones that got worse this week first, then the furthest outside: the route. */
  rounds: GroundRound[]
}

export function lensOf(items: readonly GroundItem[], field: string | null): GroundLens {
  const states = items.map((i) => lensState(i, field))
  const count = (s: LensState) => states.filter((x) => x === s).length
  const moved = (i: GroundItem) => lensMeasures(i, field).reduce((n, m) => n + (m.over && m.week !== null && (fallingIsWorse(m.budget) ? m.week < 0 : m.week > 0) ? Math.abs(m.week) : 0), 0)
  const far = (i: GroundItem) => lensMeasures(i, field).reduce((n, m) => n + excess(m), 0)
  const rounds = items
    .filter((_, k) => states[k] === 'over')
    .sort((a, b) => moved(b) - moved(a) || far(b) - far(a) || a.title.localeCompare(b.title))
    .slice(0, ROUNDS)
    .map((i) => ({
      key: i.key,
      title: i.title,
      level: i.level,
      why: lensMeasures(i, field)
        .filter((m) => m.over && m.value !== null && m.budget)
        .map((m) => overWords(m.title, m.value!, m.budget!)),
    }))
  return { field, over: count('over'), inside: count('inside'), none: count('none'), trend: lensTrend(items, field), rounds }
}
