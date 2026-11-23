// What the Scorecards page reads from a scorecard's results: where its
// entities stand, how far up the ladder they are on the whole, how that has
// moved, and which single rule, fixed, would lift the most of them. Every
// number on the page is worked out here, from the rows the hub returns.

import type { Scorecard, ScorecardPart, ScorecardResults, ScorecardRow, ScorecardRule, ScorecardTrend } from '../shared/api.ts'
import { partsOf, topOf } from '../shared/scorecard.ts'
import { clausesOf } from '../shared/clauses.ts'
import type { Blueprint } from '../shared/model.ts'
import { sentence, valueShown } from './conditions.ts'

/** A rule as one blueprint holds it: a scorecard that scores several blueprints holds a rule per blueprint. */
export interface PlacedRule {
  rule: ScorecardRule
  blueprint: string
  /** The rule's level, 0 for the first. */
  level: number
}

/** One rule, and what it does to the entities it scores. */
export interface Lift extends PlacedRule {
  /** Entities of the rule's blueprint that it scores. */
  scored: number
  /** Of those, how many fail it. */
  failing: number
  /** Of those, how many fail nothing else at the level they stop at: fixed, they move up a level. */
  lifts: number
}

/** Every rule the scorecard holds, in level order, each with its blueprint. */
export function rulesOf(sc: Scorecard): PlacedRule[] {
  return partsOf(sc).flatMap((part) => part.levels.flatMap((l, level) => l.rules.map((rule) => ({ rule, blueprint: part.blueprint, level }))))
}

/** The highest level each blueprint can reach: a blueprint with no rule at the top levels stops below them. */
export function topsOf(sc: Scorecard): Map<string, number> {
  return new Map(partsOf(sc).map((p) => [p.blueprint, topOf(p)]))
}

/** Whether a rule holds a row below its level: it failed, or its judge had no data. A rule that does not apply holds nothing. */
export const holds = (row: ScorecardRow, rule: string): boolean => row.rules[rule] === false || row.rules[rule] === null

/** The level a row stops at: the lowest at which one of its rules fails or has no data. Null when nothing holds it. */
function stopsAt(row: ScorecardRow, rules: PlacedRule[]): number | null {
  let at: number | null = null
  for (const r of rules) if (r.blueprint === row.entity.blueprint && holds(row, r.rule.id) && (at === null || r.level < at)) at = r.level
  return at
}

/**
 * Each rule with how many fail it and how many it alone holds back, most
 * lifted first, then most failing. A row is held back by a rule when that
 * rule is the only one failing at the level the row stops at; a rule with
 * no data there holds it too, so fixing the failure alone lifts nothing.
 * A rule is scored on the rows it applies to.
 */
export function liftsOf(sc: Scorecard, rows: ScorecardRow[]): Lift[] {
  const rules = rulesOf(sc)
  const out = rules.map((r): Lift => ({
    ...r,
    scored: 0,
    failing: 0,
    lifts: 0,
  }))
  for (const row of rows) {
    const at = stopsAt(row, rules)
    let only: number | null = null
    let blockers = 0
    rules.forEach((r, i) => {
      if (r.blueprint !== row.entity.blueprint || !(r.rule.id in row.rules)) return
      out[i]!.scored++
      if (!holds(row, r.rule.id)) return
      if (r.level === at) blockers++
      if (row.rules[r.rule.id] !== false) return
      out[i]!.failing++
      if (r.level === at) only = i
    })
    if (blockers === 1 && only !== null) out[only]!.lifts++
  }
  return out.sort((a, b) => b.lifts - a.lifts || b.failing - a.failing)
}

/** Whether a row stands at the highest level its blueprint can reach. */
export function atTop(row: ScorecardRow, tops: Map<string, number>): boolean {
  return row.level >= (tops.get(row.entity.blueprint) ?? 0)
}

/** How far up the ladder a scorecard's entities stand, on the whole: 0 when none reaches a level, 1 when all stand at the top. The same measure as `standingByDay`. */
export function standing(sc: Scorecard, counts: number[]): number {
  const total = counts.reduce((a, b) => a + b, 0)
  return total ? counts.reduce((n, k, i) => n + k * i, 0) / (total * sc.levels.length) : 0
}

/** What the page says about one scorecard. */
export interface Reading {
  scored: number
  /** Entities with no level. */
  none: number
  /** Entities at the top their blueprint can reach. */
  top: number
  /** 0 to 1: see `standing`. */
  standing: number
  /** Counts at each level, no level first. */
  counts: number[]
}

export function readingOf(results: ScorecardResults): Reading {
  const sc = results.scorecard
  const tops = topsOf(sc)
  return {
    scored: results.rows.length,
    none: results.counts[0] ?? 0,
    top: results.rows.filter((r) => atTop(r, tops)).length,
    standing: standing(sc, results.counts),
    counts: results.counts,
  }
}

/** The standing on each kept day, as the share of the ladder the day's entities climbed; null on a day nothing was kept. */
export function standingByDay(trend: ScorecardTrend): (number | null)[] {
  const steps = trend.levels.length - 1
  return trend.days.map((_, i) => {
    const total = trend.levels.reduce((n, l) => n + (trend.series[l]?.[i] ?? 0), 0)
    if (!total || !steps) return null
    return trend.levels.reduce((n, l, li) => n + (trend.series[l]?.[i] ?? 0) * li, 0) / (total * steps)
  })
}

/** How the standing moved from the first kept day to the last, and over how many days. Null with fewer than two kept days. */
export function movement(byDay: (number | null)[]): { change: number; days: number } | null {
  const kept = byDay.flatMap((v, i) => (v === null ? [] : [i]))
  if (kept.length < 2) return null
  return {
    change: byDay[kept.at(-1)!]! - byDay[kept[0]!]!,
    days: kept.at(-1)! - kept[0]!,
  }
}

/** One rule as a fix across the kinds that hold it: the same title at the same level, its lifts added up. */
export interface LiftGroup {
  title: string
  level: number
  lifts: number
  failing: number
  /** Each kind's share, most lifted first. */
  parts: Lift[]
}

/** The fixes that lift anything, one per rule however many kinds hold it, most lifted first. */
export function groupLifts(lifts: Lift[]): LiftGroup[] {
  const groups = new Map<string, LiftGroup>()
  for (const l of lifts) {
    if (!l.lifts) continue
    const key = `${l.level}\u0000${l.rule.title}`
    const g = groups.get(key) ?? { title: l.rule.title, level: l.level, lifts: 0, failing: 0, parts: [] }
    g.lifts += l.lifts
    g.failing += l.failing
    g.parts.push(l)
    groups.set(key, g)
  }
  return [...groups.values()].map((g) => ({ ...g, parts: g.parts.sort((a, b) => b.lifts - a.lifts) })).sort((a, b) => b.lifts - a.lifts)
}

/** Whose rows the page reads: the reader's own, or everything they may see. */
export type Lens = 'yours' | 'wide'

/**
 * The lens the page reads through. A reader the hub marked as owning any
 * scored row opens on their own, as the front page does; one who owns none
 * has only the wide lens. A lens asked for wins where the reader has it.
 */
export function lensOf(results: Pick<ScorecardResults, 'rows'>[], asked: Lens | undefined): { lens: Lens; owns: boolean } {
  const owns = results.some((r) => r.rows.some((row) => !!row.yours))
  return { lens: owns ? (asked ?? 'yours') : 'wide', owns }
}

/** A scorecard's results narrowed to the rows the reader owns, counted again. What the scope leaves out is not known by owner, so none is counted. */
export function yoursOf(results: ScorecardResults): ScorecardResults {
  const rows = results.rows.filter((r) => !!r.yours)
  const counts = [-1, ...results.scorecard.levels.map((_, i) => i)].map((level) => rows.filter((r) => r.level === level).length)
  return { ...results, rows, counts, outOfScope: 0 }
}

/**
 * Whether the page says what to do next. A fix is advice only to someone
 * who can make it: a reader looking at their own, or one who sees the whole
 * estate and answers for it. To anyone else the page says how things stand.
 */
export function advises(lens: Lens, seesAll: boolean): boolean {
  return lens === 'yours' || seesAll
}

/** Whether a part's scope is only that its judge answered: every rule is judged from one field, and the scope asks that the field is set. */
function judgedOnly(part: ScorecardPart): boolean {
  const rules = part.levels.flatMap((l) => l.rules)
  const field = rules[0]?.judged?.field
  const w = part.where
  return !!field && rules.every((r) => r.judged?.field === field) && !!w && 'field' in w && w.field === field && w.op === 'exists'
}

/**
 * A scorecard's scope in words. A scope that only asks that the judge
 * answered is said once as that; any other is each condition said as a
 * sentence by the field's own title, with the kind it holds on where the
 * card scores several. A scope no condition can say is shown as written.
 */
export function scopeWords(parts: readonly ScorecardPart[], blueprints: readonly Blueprint[], name: (id: string) => string): string {
  const scoped = parts.filter((p) => p.where)
  if (scoped.length && scoped.every(judgedOnly)) return 'Scored where its judge answered'
  const said = scoped.map((p) => {
    const fields = blueprints.find((b) => b.id === p.blueprint)?.fields ?? {}
    const words = judgedOnly(p)
      ? 'where its judge answered'
      : (clausesOf(p.where)
          ?.map((c) => sentence(c, fields[c.field]?.title ?? c.field, valueShown(c, undefined, 'said'), fields[c.field]?.type))
          .join(' and ') ?? JSON.stringify(p.where))
    return parts.length > 1 ? `${name(p.blueprint)}: ${words}` : words
  })
  return `Scope: ${said.join(' · ')}`
}
