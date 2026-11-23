// How a scorecard scores one entity. The hub and the web app both score
// through this file, so a level reads the same wherever it is shown.

import type { Scorecard, ScorecardPart, ScorecardRow, ScorecardRule } from './api.ts'
import { NONE_LEVEL, matches, usesIncoming } from './filter.ts'
import type { Entity, Filter } from './model.ts'

/**
 * How one rule stands on an entity: true when it passes, false when it
 * fails, null when its judge had no data, and undefined when it does not
 * apply. A rule the hub judges always applies, and passes or fails.
 */
export function ruleOutcome(e: Entity, r: Pick<ScorecardRule, 'id' | 'where' | 'judged'>): boolean | null | undefined {
  if (!r.judged) return matches(e, r.where)
  const said = e.fields[r.judged.field]
  if (!said || typeof said !== 'object' || Array.isArray(said)) return undefined
  const state = (said as Record<string, unknown>)[r.judged.check ?? r.id]
  return state === 'pass' ? true : state === 'fail' ? false : state === 'unknown' ? null : undefined
}

/** The level name of an entity in scope that passes no level. */
export const NONE = NONE_LEVEL

type Shape = Pick<Scorecard, 'blueprint' | 'blueprints' | 'where' | 'levels' | 'reasons'>

/**
 * What the scorecard scores on each blueprint. A one-blueprint scorecard is
 * one part, exactly as written. One that names `blueprints` is a part per
 * blueprint: the shared levels with that blueprint's rules on each, and the
 * shared scope together with the blueprint's own.
 */
export function partsOf(sc: Shape): readonly ScorecardPart[] {
  let parts = PARTS.get(sc)
  if (!parts) PARTS.set(sc, (parts = partsOfNew(sc)))
  return parts
}

/**
 * The parts of each scorecard, worked out once: a scorecard is never changed
 * in place, only replaced, and its parts are asked for once an entity
 * scored, thousands of times a read.
 */
const PARTS = new WeakMap<Shape, readonly ScorecardPart[]>()

function partsOfNew(sc: Shape): ScorecardPart[] {
  if (!sc.blueprints) return sc.blueprint ? [{ blueprint: sc.blueprint, ...(sc.where ? { where: sc.where } : {}), levels: sc.levels, ...(sc.reasons ? { reasons: sc.reasons } : {}) }] : []
  return Object.entries(sc.blueprints).map(([blueprint, own]) => {
    const scopes = [sc.where, own.where].filter((f): f is NonNullable<typeof f> => !!f)
    const where = scopes.length > 1 ? { and: scopes } : scopes[0]
    const reasons = own.reasons ?? sc.reasons
    return { blueprint, ...(where ? { where } : {}), levels: sc.levels.map((l) => ({ name: l.name, rules: own.rules[l.name] ?? [] })), ...(reasons ? { reasons } : {}) }
  })
}

/** The part for one blueprint, when the scorecard scores it. */
export function partFor(sc: Shape, blueprint: string): ScorecardPart | undefined {
  return partsOf(sc).find((p) => p.blueprint === blueprint)
}

/** The blueprints a scorecard scores. */
export function blueprintsOf(sc: Shape): string[] {
  return partsOf(sc).map((p) => p.blueprint)
}

/** The highest level an entity of the part's blueprint can reach: the highest that has a rule for it. */
export function topOf(part: ScorecardPart): number {
  return part.levels.findLastIndex((l) => l.rules.length > 0)
}

/** Whether the scorecard scores the entity: it scores the entity's blueprint, and its scope there, when it has one, matches. */
export function inScope(sc: Shape, e: Entity): boolean {
  const part = partFor(sc, e.blueprint)
  return !!part && (!part.where || matches(e, part.where))
}

/**
 * Scores one entity: the highest level at which every rule there and below
 * that applies to it passes. A rule its judge had no data on holds it below,
 * as a failure does. Null when the entity is out of the scorecard's scope:
 * it has no level, and is counted nowhere. A rule that asks who points at
 * the entity needs `incomingRefs` on it.
 */
export function scoreEntity(sc: Shape, e: Entity): ScorecardRow | null {
  const part = partFor(sc, e.blueprint)
  if (!part || (part.where && !matches(e, part.where))) return null
  const rules: Record<string, boolean | null> = {}
  let level = -1
  let blocked = false
  part.levels.forEach((l, i) => {
    let all = true
    for (const r of l.rules) {
      const ok = ruleOutcome(e, r)
      if (ok === undefined) continue
      rules[r.id] = ok
      if (ok !== true) all = false
    }
    if (all && !blocked) level = i
    else blocked = true
  })
  // A level with no rule for this blueprint is passed on the way up, never stood on: nothing here was checked at it.
  level = Math.min(level, topOf(part))
  return { entity: { blueprint: e.blueprint, key: e.key }, title: e.title, level, levelName: level < 0 ? NONE : part.levels[level]!.name, rules }
}

/** The levels a row reached, lowest first: what an entity carries in `levels` for the scorecard. */
export function reached(sc: Shape, row: ScorecardRow): string[] {
  return sc.levels.slice(0, row.level + 1).map((l) => l.name)
}

/** True when the scorecard's scope or a rule asks who points at the entity. */
export function scorecardUsesIncoming(sc: Shape): boolean {
  return partsOf(sc).some(partUsesIncoming)
}

/** True when the part's scope or a rule asks who points at the entity. */
export function partUsesIncoming(part: ScorecardPart): boolean {
  return (!!part.where && usesIncoming(part.where)) || part.levels.some((l) => l.rules.some((r) => usesIncoming(r.where)))
}

/** Every filter a part reads: its scope and each rule. */
export function partFilters(part: ScorecardPart): Filter[] {
  return [...(part.where ? [part.where] : []), ...part.levels.flatMap((l) => l.rules.map((r) => r.where))]
}
