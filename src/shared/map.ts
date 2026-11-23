// The map of one entity that holds others: a program and its services, the
// places they run in, and what else was deployed for it. Every check on the
// map, whatever asked for it, reaches the reader in one shape: a scorecard
// rule, a number's budget, and a guard each pass, fail, or have no data. So a
// reader weighs them together, and the map can stand in for a scorecard one
// rule at a time. Everything here is worked out from the entities a reader
// may see. The names here are plain ones; only the web app says them as a
// planet, its continents, and its gardens.

import type { Scorecard, ScorecardPart, ScorecardRule } from './api.ts'
import { groundFields, linksOf, type GroundLink } from './ground.ts'
import { matches } from './filter.ts'
import { overBudget, STATUS_LEVELS, type Blueprint, type Entity, type Filter, type MapDef, type StatusLevel } from './model.ts'
import { partFor, ruleOutcome } from './scorecard.ts'

/** The most entities a map reads of one blueprint. One that holds more says so in `truncated`. */
export const MAP_LIMIT = 2000

/** The most stops one person keeps on their walk through one map. */
export const MOST_STEPS = 40

export const CHECK_KINDS = ['scorecard', 'budget', 'guard'] as const
export type CheckKind = (typeof CHECK_KINDS)[number]

/** `unknown`: nothing the check reads has a value the reader may see. It is never counted as a pass or a fail. */
export type CheckState = 'pass' | 'fail' | 'unknown'

export interface MapCheck {
  kind: CheckKind
  /** The rule's id for a scorecard rule, the field's name for a budget or a guard. */
  id: string
  title: string
  /** For a scorecard rule: the scorecard and the level the rule sits at. */
  of: string | null
  state: CheckState
  /** The ladder it is a rung of: a scorecard's id, or `budget:<field>` and `guard:<field>`, each a ladder of one rung. */
  ladder: string
  /** Its rung on that ladder, from 0: a scorecard rule's level. */
  rung: number
  /** For a scorecard rule or a gap: the level it holds the thing below. */
  level?: string
  /** What to do about it, in one line: a gap's fix, or a rule's own. */
  fix?: string
  /** Where the record that names a gap says more. */
  link?: string
  /** A level its scorecard has records for falls short, and no record the reader may see says why. */
  unexplained?: true
}

/**
 * A ladder the checks of a map climb: a scorecard, its levels the rungs, or a
 * budget or a guard, a ladder of one rung. A thing stands on the highest rung
 * it holds with every rung below it held, so a ladder says how far each thing
 * got and what it takes to climb the rest.
 */
export interface MapLadder {
  id: string
  title: string
  /** The name of each rung, lowest first. */
  rungs: string[]
}

export interface MapThing {
  blueprint: string
  key: string
  title: string
  icon: string | null
  level: StatusLevel
  reasons: string[]
  /** The holder or the part it belongs to, by key. */
  part: string
  checks: MapCheck[]
  failing: number
  unknown: number
  /** The actions the reader may run on it, by id. */
  actions: string[]
  /** Its own addresses: each `url` field that holds one, by the field's title. */
  links: GroundLink[]
}

/** A plot where it is placed: what places it there, and how that is doing. */
export interface MapPlacing {
  place: string
  blueprint: string
  key: string
  title: string
  level: StatusLevel
}

export interface MapPlot extends MapThing {
  /** Where it is, worst first. Empty when nothing places it. */
  at: MapPlacing[]
}

export interface MapMember extends MapThing {
  place: string | null
  plot: string | null
}

export interface MapPlace {
  key: string
  title: string
  icon: string | null
  /** How many plots are placed here. */
  plots: number
  /** How many members sit here, in a plot or open. */
  members: number
  /** How many members sit here in no plot. */
  open: number
  /** Failing and no-data checks of the members here. */
  failing: number
  unknown: number
  /** The worst status of what is here: the placings and the members. */
  level: StatusLevel
}

export interface MapHolder {
  blueprint: string
  key: string
  title: string
  icon: string | null
  level: StatusLevel
}

export interface MapCounts {
  plots: number
  placed: number
  members: number
  open: number
  checks: number
  failing: number
  unknown: number
}

export interface MapView {
  holder: MapHolder
  /** Every ladder a check on the map climbs: the scorecards in their order, then the budgets and the guards. */
  ladders: MapLadder[]
  parts: MapHolder[]
  places: MapPlace[]
  plots: MapPlot[]
  members: MapMember[]
  counts: MapCounts
  /** The blueprints read only to `MAP_LIMIT`. */
  truncated: string[]
}

type ScorecardShape = Pick<Scorecard, 'id' | 'title' | 'blueprint' | 'blueprints' | 'where' | 'levels' | 'reasons'>

/** The records about each entity, by the entity's id, that a scorecard's reasons may read: what points at it, as the reader's view shows it. */
export type ReasonsAbout = ReadonlyMap<string, readonly Entity[]>

export interface MapInput {
  def: MapDef
  holder: Entity
  parts: Entity[]
  places: Entity[]
  plots: Entity[]
  /** What places the plots, as `def.plots.placedBy` names it. */
  placers: Entity[]
  /** Each member blueprint as the map names it, with its entities. */
  members: { spec: NonNullable<MapDef['members']>[number]; entities: Entity[] }[]
  /** Each blueprint as the reader's view shows it. */
  blueprints: ReadonlyMap<string, Blueprint>
  scorecards: readonly ScorecardShape[]
  /** What points at each thing, for the scorecards whose reasons read it. */
  reasons?: ReasonsAbout
  truncated: string[]
}

const RANK: Record<StatusLevel, number> = Object.fromEntries(STATUS_LEVELS.map((l, i) => [l, i])) as Record<StatusLevel, number>

/** The worse of two levels. Grey, no data, is worse than nothing only when nothing else is there. */
export function worse(a: StatusLevel, b: StatusLevel): StatusLevel {
  if (a === 'grey') return b
  if (b === 'grey') return a
  return RANK[a] <= RANK[b] ? a : b
}

/** The fields a filter reads, its relations left out. */
function fieldsIn(f: Filter): string[] {
  if ('and' in f) return f.and.flatMap(fieldsIn)
  if ('or' in f) return f.or.flatMap(fieldsIn)
  if ('not' in f) return fieldsIn(f.not)
  if ('field' in f) return [f.field]
  return []
}

const valued = (v: unknown) => v !== null && v !== undefined && v !== ''

/**
 * One rule's state on an entity, null when it does not apply: a judged rule
 * is what its judge said, and a rule that reads only fields with no value the
 * reader may see has no data.
 */
function ruleState(e: Entity, r: ScorecardRule): CheckState | null {
  if (r.judged) {
    const said = ruleOutcome(e, r)
    return said === undefined ? null : said === null ? 'unknown' : said ? 'pass' : 'fail'
  }
  if (matches(e, r.where)) return 'pass'
  const fields = fieldsIn(r.where)
  const reads = fields.length > 0 && !('relation' in r.where)
  return reads && fields.every((f) => !valued(e.fields[f])) ? 'unknown' : 'fail'
}

const text = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '')

/**
 * The checks of one scorecard on an entity. A level whose rules hold, or
 * have no data, is its rules. Where the scorecard says where its reasons
 * are, a level that falls short is the gaps its records name at that level,
 * one check each, carrying what to do: so one missing thing counts once, at
 * the level it holds the entity below. A level that falls short only
 * because a level under it did adds nothing, and one no record the reader
 * may see explains stays its rules, said to have no reason given.
 */
function scorecardChecks(e: Entity, sc: ScorecardShape, part: ScorecardPart, about: readonly Entity[]): MapCheck[] {
  const out: MapCheck[] = []
  const rule = (r: ScorecardRule, level: string, rung: number, state: CheckState, unexplained = false): MapCheck => ({ kind: 'scorecard', id: r.id, title: r.title ?? r.id, of: `${sc.title}, ${level}`, state, ladder: sc.id, rung, level, ...(r.fix ? { fix: r.fix } : {}), ...(unexplained ? { unexplained: true as const } : {}) })
  const why = part.reasons
  const names = part.levels.map((l) => l.name.toLowerCase())
  const records = why ? about.filter((r) => r.blueprint === why.from && (!why.where || matches(r, why.where))) : []
  let under = false
  part.levels.forEach((level, rung) => {
    const states = level.rules.flatMap((r) => {
      const s = ruleState(e, r)
      return s ? [[r, s] as const] : []
    })
    const short = states.some(([, s]) => s === 'fail')
    if (!why || !short) {
      for (const [r, s] of states) out.push(rule(r, level.name, rung, s))
      under ||= short
      return
    }
    for (const [r, s] of states) if (s !== 'fail') out.push(rule(r, level.name, rung, s))
    // A record naming no level the scorecard has counts at the first level that falls short.
    const gaps = records.filter((r) => {
      const at = names.indexOf(text(r.fields[why.level]).toLowerCase())
      return at === rung || (at < 0 && !under)
    })
    for (const g of gaps) {
      const says = text(g.fields[why.says]) || g.title
      const fix = why.fix ? text(g.fields[why.fix]) : ''
      const link = why.link ? text(g.fields[why.link]) : ''
      out.push({ kind: 'scorecard', id: `${sc.id}:${says}`, title: says, of: `${sc.title}, ${level.name}`, state: 'fail', ladder: sc.id, rung, level: level.name, ...(fix ? { fix } : {}), ...(link ? { link } : {}) })
    }
    if (!gaps.length && !under) for (const [r, s] of states) if (s === 'fail') out.push(rule(r, level.name, rung, s, true))
    under = true
  })
  return out
}

/** Every check on an entity, in one shape: each scorecard rule that scores it, or the gaps behind one, each budget on a number, and each guard. */
export function checksOf(e: Entity, bp: Blueprint | undefined, scorecards: readonly ScorecardShape[], reasons?: ReasonsAbout): MapCheck[] {
  const out: MapCheck[] = []
  for (const sc of scorecards) {
    const part = partFor(sc, e.blueprint)
    if (!part || (part.where && !matches(e, part.where))) continue
    out.push(...scorecardChecks(e, sc, part, reasons?.get(e.id) ?? []))
  }
  if (!bp) return out
  for (const f of groundFields(bp)) {
    if (!f.budget) continue
    const v = e.fields[f.field]
    out.push({ kind: 'budget', id: f.field, title: f.title, of: null, state: typeof v === 'number' ? (overBudget(v, f.budget) ? 'fail' : 'pass') : 'unknown', ladder: `budget:${f.field}`, rung: 0 })
  }
  for (const g of bp.ground?.guards ?? []) {
    const def = bp.fields[g]
    if (!def) continue
    const v = e.fields[g]
    out.push({ kind: 'guard', id: g, title: def.title ?? g, of: null, state: typeof v === 'boolean' ? (v ? 'pass' : 'fail') : 'unknown', ladder: `guard:${g}`, rung: 0 })
  }
  return out
}

/** The key of the one entity a to-one relation names, when it names one. */
function one(e: Entity, relation: string | undefined): string | null {
  if (!relation) return null
  return e.relations[relation]?.[0]?.key ?? null
}

/** Worst first: by status, then the most broken checks, then the most with no data. What to tend first leads. */
const byWorst = <T extends { level: StatusLevel; title: string; failing?: number; unknown?: number }>(a: T, b: T) =>
  RANK[a.level] - RANK[b.level] || (b.failing ?? 0) - (a.failing ?? 0) || (b.unknown ?? 0) - (a.unknown ?? 0) || a.title.localeCompare(b.title)

export function buildMap(input: MapInput): MapView {
  const { def, holder, parts, blueprints, scorecards, reasons } = input
  const owners = new Set([holder.key, ...parts.map((p) => p.key)])
  const thing = (e: Entity, holderRelation: string): MapThing => {
    const checks = checksOf(e, blueprints.get(e.blueprint), scorecards, reasons)
    const named = one(e, holderRelation)
    return {
      blueprint: e.blueprint,
      key: e.key,
      title: e.title,
      icon: e.icon,
      level: e.status.level,
      reasons: e.status.reasons,
      part: named && owners.has(named) ? named : holder.key,
      checks,
      failing: checks.filter((c) => c.state === 'fail').length,
      unknown: checks.filter((c) => c.state === 'unknown').length,
      actions: e.actions ?? [],
      links: linksOf(blueprints.get(e.blueprint), e),
    }
  }
  const placeOf = new Map(input.places.map((p) => [p.key, p]))
  const plotKeys = new Set(input.plots.map((p) => p.key))
  const by = def.plots.placedBy
  const at = new Map<string, MapPlacing[]>()
  for (const e of by ? input.placers : []) {
    const plot = one(e, by!.plot)
    const place = one(e, by!.place)
    if (!plot || !place || !plotKeys.has(plot) || !placeOf.has(place)) continue
    const list = at.get(plot) ?? []
    list.push({ place, blueprint: e.blueprint, key: e.key, title: e.title, level: e.status.level })
    at.set(plot, list)
  }
  const plots: MapPlot[] = input.plots.map((e) => ({ ...thing(e, def.plots.holder), at: (at.get(e.key) ?? []).sort(byWorst) })).sort(byWorst)
  const members: MapMember[] = input.members
    .flatMap(({ spec, entities }) =>
      entities.map((e) => {
        const place = one(e, spec.place)
        const plot = one(e, spec.plot)
        return { ...thing(e, spec.holder), place: place && placeOf.has(place) ? place : null, plot: plot && plotKeys.has(plot) ? plot : null }
      }),
    )
    .sort(byWorst)
  const places: MapPlace[] = []
  for (const p of input.places) {
    const placings = plots.flatMap((plot) => plot.at.filter((a) => a.place === p.key))
    const here = members.filter((m) => m.place === p.key)
    if (!placings.length && !here.length) continue
    places.push({
      key: p.key,
      title: p.title,
      icon: p.icon,
      plots: plots.filter((plot) => plot.at.some((a) => a.place === p.key)).length,
      members: here.length,
      open: here.filter((m) => !m.plot).length,
      failing: here.reduce((n, m) => n + m.failing, 0),
      unknown: here.reduce((n, m) => n + m.unknown, 0),
      level: [...placings.map((a) => a.level), ...here.map((m) => m.level)].reduce<StatusLevel>(worse, 'grey'),
    })
  }
  places.sort((a, b) => b.plots - a.plots || b.members - a.members || a.title.localeCompare(b.title))
  const all = [...plots, ...members]
  const holderOf = (e: Entity): MapHolder => ({ blueprint: e.blueprint, key: e.key, title: e.title, icon: e.icon, level: e.status.level })
  return {
    holder: holderOf(holder),
    ladders: laddersOf(all, scorecards),
    parts: parts.map(holderOf).sort((a, b) => a.title.localeCompare(b.title)),
    places,
    plots,
    members,
    counts: {
      plots: plots.length,
      placed: plots.filter((p) => p.at.length > 0).length,
      members: members.length,
      open: members.filter((m) => !m.plot).length,
      checks: all.reduce((n, t) => n + t.checks.length, 0),
      failing: all.reduce((n, t) => n + t.failing, 0),
      unknown: all.reduce((n, t) => n + t.unknown, 0),
    },
    truncated: input.truncated,
  }
}

/** How a set of checks stands: how many hold, how many are broken, and how many have no data. */
export interface CheckTally {
  pass: number
  fail: number
  unknown: number
}

/** The checks of some things, counted by state. With `ladder`, only the checks on that ladder: one lens. */
export function tally(things: readonly Pick<MapThing, 'checks'>[], ladder: string | null = null): CheckTally {
  const out: CheckTally = { pass: 0, fail: 0, unknown: 0 }
  for (const t of things) for (const c of t.checks) if (ladder === null || c.ladder === ladder) out[c.state]++
  return out
}

/** One ladder across some things: how many of its checks hold, break, and have no data, and which things it breaks on. */
export interface MapFront extends CheckTally {
  ladder: string
  title: string
  /** The things it is broken on, as `blueprint:key`. */
  broken: string[]
}

/** Every ladder across some things, the most broken first, then the most with no data. What breaks most leads. */
export function fronts(things: readonly Pick<MapThing, 'blueprint' | 'key' | 'checks'>[], ladders: readonly MapLadder[]): MapFront[] {
  const titles = new Map(ladders.map((l) => [l.id, l.title]))
  const by = new Map<string, MapFront>()
  for (const t of things)
    for (const c of t.checks) {
      const f = by.get(c.ladder) ?? { ladder: c.ladder, title: titles.get(c.ladder) ?? c.title, pass: 0, fail: 0, unknown: 0, broken: [] }
      f[c.state]++
      if (c.state === 'fail' && !f.broken.includes(`${t.blueprint}:${t.key}`)) f.broken.push(`${t.blueprint}:${t.key}`)
      by.set(c.ladder, f)
    }
  return [...by.values()].sort((a, b) => b.fail - a.fail || b.unknown - a.unknown || a.title.localeCompare(b.title))
}

/** One thing to do across some things: a broken check that says what fixes it, and the things it holds back. */
export interface MapFix {
  title: string
  fix: string
  level: string | null
  things: MapThing[]
}

/** Every broken check that says what fixes it, across some things, the one that holds back the most things first. `ladder` keeps to one ladder. */
export function fixesOf(things: readonly MapThing[], ladder: string | null = null): MapFix[] {
  const by = new Map<string, MapFix>()
  for (const t of things)
    for (const c of t.checks) {
      if (c.state !== 'fail' || !c.fix || (ladder !== null && c.ladder !== ladder)) continue
      const k = `${c.title}\0${c.fix}`
      const f = by.get(k) ?? { title: c.title, fix: c.fix, level: c.level ?? null, things: [] }
      if (!f.things.includes(t)) f.things.push(t)
      by.set(k, f)
    }
  return [...by.values()].sort((a, b) => b.things.length - a.things.length || a.title.localeCompare(b.title))
}

/** A plot with everything planted in it, wherever it runs, and how all of it stands. */
export interface MapTend extends CheckTally {
  plot: MapPlot
  /** Its members, on every place. */
  members: MapMember[]
}

/**
 * Where tending pays off first: the plots with the most broken checks, their
 * own and those of everything planted in them, summed over every place they
 * run in. A plot's own checks count once, however many places it runs in.
 * A plot with nothing broken is not on it.
 */
export function tendFirst(map: Pick<MapView, 'plots' | 'members'>, n: number, ladder: string | null = null): MapTend[] {
  const inPlot = new Map<string, MapMember[]>()
  for (const m of map.members) if (m.plot) inPlot.set(m.plot, [...(inPlot.get(m.plot) ?? []), m])
  return map.plots
    .map((plot) => {
      const members = inPlot.get(plot.key) ?? []
      return { plot, members, ...tally([plot, ...members], ladder) }
    })
    .filter((t) => t.fail > 0)
    .sort((a, b) => b.fail - a.fail || b.unknown - a.unknown || a.plot.title.localeCompare(b.plot.title))
    .slice(0, n)
}

/**
 * How a map's checks stand place by place, each check counted once: the
 * members on each place, in the map's order of places, and last, as place
 * `null`, everything tied to no place: the members on none, and every plot's
 * own checks, which are the plot's wherever it runs and so on no one place.
 * The parts add up to the whole map.
 */
export function byPlace(map: Pick<MapView, 'places' | 'plots' | 'members'>, ladder: string | null = null): { place: string | null; t: CheckTally }[] {
  const on = map.places.map((p) => ({ place: p.key as string | null, t: tally(map.members.filter((m) => m.place === p.key), ladder) }))
  return [...on, { place: null, t: tally([...map.plots, ...map.members.filter((m) => m.place === null)], ladder) }]
}

/** The ladders some things climb, in the order their checks name them: each scorecard as its levels, each budget and guard as a ladder of one rung. */
function laddersOf(things: readonly Pick<MapThing, 'checks'>[], scorecards: readonly ScorecardShape[]): MapLadder[] {
  const used = new Map<string, string>()
  for (const t of things) for (const c of t.checks) if (!used.has(c.ladder)) used.set(c.ladder, c.title)
  const cards: MapLadder[] = scorecards.filter((sc) => used.has(sc.id)).map((sc) => ({ id: sc.id, title: sc.title, rungs: sc.levels.map((l) => l.name) }))
  const lone: MapLadder[] = [...used.entries()]
    .filter(([id]) => id.startsWith('budget:') || id.startsWith('guard:'))
    .map(([id, title]) => ({ id, title, rungs: [title] }))
    .sort((a, b) => Number(a.id.startsWith('guard:')) - Number(b.id.startsWith('guard:')) || a.title.localeCompare(b.title))
  return [...cards, ...lone]
}

// The ladders -----------------------------------------------------------------------

/** How far one thing got on one ladder: the rungs it holds, every one below held too, and what stops it at the next. */
export interface Standing {
  /** How many rungs it holds, from the bottom: `of` is the top. */
  reached: number
  of: number
  /** What stops it at the rung above: a broken check, or one with no data. Null at the top. */
  stop: 'fail' | 'unknown' | null
}

/**
 * Where one thing stands on one ladder, or null where the ladder reads it not
 * at all. A rung holds when every check on it holds; it stops the climb when
 * one breaks, or, with none broken, when one has no data. A rung the ladder
 * asks nothing of this thing on holds.
 */
export function standingOf(thing: Pick<MapThing, 'checks'>, ladder: MapLadder): Standing | null {
  const on = thing.checks.filter((c) => c.ladder === ladder.id)
  if (!on.length) return null
  const of = ladder.rungs.length
  for (let rung = 0; rung < of; rung++) {
    const here = on.filter((c) => c.rung === rung)
    if (here.some((c) => c.state === 'fail')) return { reached: rung, of, stop: 'fail' }
    if (here.some((c) => c.state === 'unknown')) return { reached: rung, of, stop: 'unknown' }
  }
  return { reached: of, of, stop: null }
}

/** The broken checks one thing has on one ladder: what climbing it to the top mends. */
export const brokenOn = (thing: Pick<MapThing, 'checks'>, ladder: string): number => thing.checks.filter((c) => c.ladder === ladder && c.state === 'fail').length

/** One climb: the things that stand on the same rung of one ladder, each stopped there by a broken check. Taking them to the top mends `mends`. */
export interface MapClimb<T> {
  ladder: string
  /** The rung they stand on: 0 is below the first. */
  from: number
  things: T[]
  mends: number
}

/**
 * Every climb among some things, the one that mends the most first, then the
 * lowest rung, then the ladder's order. A thing stopped by no data is in no
 * climb: what it needs is its data, not a fix.
 */
export function climbsOf<T extends Pick<MapThing, 'checks'>>(things: readonly T[], ladders: readonly MapLadder[]): MapClimb<T>[] {
  const out: MapClimb<T>[] = []
  ladders.forEach((ladder) => {
    const by = new Map<number, T[]>()
    for (const t of things) {
      const s = standingOf(t, ladder)
      if (s?.stop === 'fail') by.set(s.reached, [...(by.get(s.reached) ?? []), t])
    }
    for (const [from, list] of by) out.push({ ladder: ladder.id, from, things: list, mends: list.reduce((n, t) => n + brokenOn(t, ladder.id), 0) })
  })
  const order = new Map(ladders.map((l, i) => [l.id, i]))
  return out.sort((a, b) => b.mends - a.mends || a.from - b.from || order.get(a.ladder)! - order.get(b.ladder)!)
}

/** Says whether a thing is to be taken to the top of a ladder: a walk's plan. */
export type Lifts<T> = (thing: T, ladder: string) => boolean

/** How many of some things' broken checks a plan mends: every broken check on a ladder each is taken to the top of. */
export function mendedBy<T extends Pick<MapThing, 'checks'>>(things: readonly T[], lifts: Lifts<T>): number {
  let n = 0
  for (const t of things) for (const c of t.checks) if (c.state === 'fail' && lifts(t, c.ladder)) n++
  return n
}

/** Whether a thing is in full bloom: at the top of every ladder that reads it, or taken there by a plan. A rung with no data keeps it from bloom. */
export function inBloom<T extends Pick<MapThing, 'checks'>>(thing: T, ladders: readonly MapLadder[], lifts: Lifts<T> = () => false): boolean {
  if (!thing.checks.length) return false
  return ladders.every((l) => {
    const s = standingOf(thing, l)
    return !s || s.stop === null || (s.stop === 'fail' && !thing.checks.some((c) => c.ladder === l.id && c.state === 'unknown') && lifts(thing, l.id))
  })
}

/** The share of things in full bloom at which each stage of growth begins, after the first. */
export const GROWTH = [0.25, 0.5, 0.75, 1] as const

/** How some things have grown: how many are in full bloom of how many are checked at all, and the stage that makes, from 0 to `GROWTH.length`. */
export function growthOf<T extends Pick<MapThing, 'checks'>>(things: readonly T[], ladders: readonly MapLadder[], lifts: Lifts<T> = () => false): { full: number; checked: number; stage: number } {
  const checked = things.filter((t) => t.checks.length > 0)
  const full = checked.filter((t) => inBloom(t, ladders, lifts)).length
  const share = checked.length ? full / checked.length : 0
  return { full, checked: checked.length, stage: GROWTH.filter((g) => share >= g).length }
}
