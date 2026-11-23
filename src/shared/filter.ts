// The search filter and relation paths. The hub and the web app evaluate
// both through this file, so a rule scores the same wherever it is shown.

import { dayOf } from './day.ts'
import { ENTITY_STATES, FILTER_OPS, LEVEL_OPS, TITLE_FIELD, entityId, parseDuration, type Entity, type Filter, type RelatedRef } from './model.ts'

/** JSON with sorted keys, so equal values compare equal. */
export function stable(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    )
  }
  return value
}

/** One step along a relation: out through a relation the entity declares, or in through one that points at it. */
export interface Hop {
  incoming: boolean
  relation: string
  /** For an incoming hop, the only blueprint to take it from. Null takes every blueprint. */
  from: string | null
}

const NAME = /^[a-z][a-z0-9_]*$/

function parseHop(spec: string): Hop {
  const incoming = spec.startsWith('<-')
  const [a, b, ...rest] = (incoming ? spec.slice(2) : spec).split(':')
  const relation = b ?? a ?? ''
  const from = b === undefined ? null : (a ?? '')
  if (rest.length || !NAME.test(relation) || (from !== null && !NAME.test(from)) || (from !== null && !incoming)) {
    throw new Error(`bad relation "${spec}": use relation, <-relation, or <-blueprint:relation`)
  }
  return { incoming, relation, from }
}

/** Parses a relation path, one hop per dot: `team.department` or `<-sw_service:team.<-sw_deployment:service`. */
export function parsePath(path: string): Hop[] {
  return path.split('.').map(parseHop)
}

/** Splits a mirror into the relation path to follow and the field to read at its end. A bare path reads the title. */
export function splitMirror(spec: string): { path: string; field: string } {
  const dot = spec.lastIndexOf('.')
  if (dot <= 0 || spec.slice(dot + 1).startsWith('<-')) return { path: spec, field: TITLE_FIELD }
  return { path: spec.slice(0, dot), field: spec.slice(dot + 1) }
}

const META: Record<string, (e: Entity) => unknown> = {
  key: (e) => e.key,
  title: (e) => e.title,
  icon: (e) => e.icon,
  blueprint: (e) => e.blueprint,
  state: (e) => e.state,
  owner: (e) => e.owner,
  status: (e) => e.status.level,
  createdAt: (e) => e.createdAt,
  updatedAt: (e) => e.updatedAt,
  lastSeenAt: (e) => e.lastSeenAt,
}

/** What the hub keeps about every entity, by the bare name a filter may read it under. */
export const META_FIELDS: ReadonlySet<string> = new Set(Object.keys(META))

/**
 * A value by name. A field the blueprint defines always wins. What the hub
 * keeps about every entity (key, title, icon, blueprint, state, owner, status,
 * createdAt, updatedAt, lastSeenAt) answers to its bare name when no field
 * has it, and to `$name` always.
 */
export function fieldOf(e: Entity, field: string): unknown {
  if (field.startsWith('$')) return META[field.slice(1)]?.(e)
  if (field.startsWith('fields.')) return e.fields[field.slice(7)]
  if (field in e.fields) return e.fields[field]
  return META[field]?.(e)
}

/** The one way text is ordered, in the hub and in the web app: English, with digit runs read as numbers, so `0.9.10` follows `0.9.9`. Postgres orders the same under the `orrery_natural` collation. */
const COLLATOR = new Intl.Collator('en', { numeric: true })

/** Whether a value takes part in an order: a number, a string, or a boolean. A list, an object, and an unset value do not, and come last. */
export function orderable(value: unknown): value is number | string | boolean {
  return typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean'
}

/**
 * Orders two values: numbers by size, before text; text as a person reads
 * it; a boolean as the text `true` or `false`; anything else, an unset value
 * or a list or an object, last. The same order Postgres gives in
 * `query.ts`, so a grid sorted by the hub and a rule judged in the web app
 * agree.
 */
export function compare(a: unknown, b: unknown): number {
  if (a === b) return 0
  const ao = orderable(a)
  const bo = orderable(b)
  if (!ao || !bo) return ao ? -1 : bo ? 1 : 0
  const an = typeof a === 'number'
  const bn = typeof b === 'number'
  if (an && bn) return a - b
  if (an !== bn) return an ? -1 : 1
  return COLLATOR.compare(String(a), String(b))
}

/** A datetime as the hub stores one: ISO 8601, date first. Anything else is not a datetime, here or in Postgres (`orrery_ts`). */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}/

/** How long ago a datetime value was, in milliseconds. Null when it is not a datetime. */
function age(value: unknown, now: number): number | null {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return null
  const t = Date.parse(value)
  return Number.isNaN(t) ? null : now - t
}

/**
 * The texts search reads in a value: a string as it is, a number or a
 * boolean as text, and inside a list or an object, each of those at any
 * depth. Nothing of an unset value. The same leaves Postgres reads in
 * `query.ts`.
 */
export function searchTexts(value: unknown): string[] {
  if (value === null || value === undefined) return []
  if (typeof value === 'string') return [value]
  if (typeof value === 'number' || typeof value === 'boolean') return [String(value)]
  if (Array.isArray(value)) return value.flatMap(searchTexts)
  if (typeof value === 'object') return Object.values(value as Record<string, unknown>).flatMap(searchTexts)
  return []
}

/**
 * The next moment after `now` at which `matches(e, f)` can change because
 * time passed: a `within` or `older` test crossing its span. Null when the
 * filter reads no time, or nothing of it lies ahead.
 */
export function nextChange(e: Entity, f: Filter, now: number): number | null {
  if ('and' in f) return soonest(f.and.map((x) => nextChange(e, x, now)))
  if ('or' in f) return soonest(f.or.map((x) => nextChange(e, x, now)))
  if ('not' in f) return nextChange(e, f.not, now)
  if (!('field' in f) || (f.op !== 'within' && f.op !== 'older')) return null
  const v = fieldOf(e, f.field)
  const span = duration(f.value)
  if (typeof v !== 'string' || span === null || !ISO_DATE.test(v)) return null
  const t = Date.parse(v)
  if (Number.isNaN(t)) return null
  // A time still ahead comes within reach as it arrives; one behind leaves the span the moment after it is a span old.
  return soonest([t, t + span + 1].filter((x) => x > now))
}

/** The earliest of these moments; null when there is none. */
export function soonest(times: readonly (number | null)[]): number | null {
  let out: number | null = null
  for (const t of times) if (t !== null && (out === null || t < out)) out = t
  return out
}

function duration(value: unknown): number | null {
  if (typeof value !== 'string') return null
  try {
    return parseDuration(value)
  } catch {
    return null
  }
}

/** Entities on the other end of a relation named in a filter. Incoming ones need `incomingRefs` on the entity. */
function relationTargets(e: Entity, spec: string): RelatedRef[] {
  if (!spec.startsWith('<-')) return e.relations[spec] ?? []
  const hop = parseHop(spec)
  return Object.entries(e.incomingRefs ?? {})
    .filter(([k]) => {
      const dot = k.indexOf('.')
      return k.slice(dot + 1) === hop.relation && (hop.from === null || k.slice(0, dot) === hop.from)
    })
    .flatMap(([, refs]) => refs)
}

/**
 * The filter with every blueprint it names by id (a target or `relatedTo` as
 * `blueprint:key`, and `<-blueprint:relation`) under the id `now` gives it:
 * a renamed blueprint's former id reaches the blueprint it became. The same
 * object when nothing moved.
 */
export function renamedIn(f: Filter, now: (blueprint: string) => string): Filter {
  const id = (ref: string): string => {
    const at = ref.indexOf(':')
    if (at <= 0) return ref
    const bp = ref.slice(0, at)
    const moved = now(bp)
    return moved === bp ? ref : `${moved}${ref.slice(at)}`
  }
  const each = (list: Filter[]): Filter[] => {
    const next = list.map((x) => renamedIn(x, now))
    return next.some((x, i) => x !== list[i]) ? next : list
  }
  if ('and' in f) {
    const and = each(f.and)
    return and === f.and ? f : { and }
  }
  if ('or' in f) {
    const or = each(f.or)
    return or === f.or ? f : { or }
  }
  if ('not' in f) {
    const not = renamedIn(f.not, now)
    return not === f.not ? f : { not }
  }
  if ('relatedTo' in f) {
    const relatedTo = id(f.relatedTo)
    return relatedTo === f.relatedTo ? f : { relatedTo }
  }
  if ('relation' in f) {
    const relation = f.relation.startsWith('<-') && f.relation.includes(':') ? `<-${id(f.relation.slice(2))}` : f.relation
    const target = f.target === undefined ? undefined : id(f.target)
    const where = f.where === undefined ? undefined : renamedIn(f.where, now)
    if (relation === f.relation && target === f.target && where === f.where) return f
    return { ...f, relation, ...(target === undefined ? {} : { target }), ...(where === undefined ? {} : { where }) }
  }
  return f
}

/**
 * The key `matches` finds, among the sets it is given, the entities that
 * meet a relation leaf's `where`: the ones a caller worked out for it, by
 * `whereSets` or the hub's own read.
 */
export function whereKey(where: Filter): string {
  return `where:${stable(where)}`
}

/** The `where` of every relation leaf of a filter that reads the entities it reaches, outermost first: not the ones inside those. */
export function neighbourWheres(f: Filter): Filter[] {
  if ('and' in f) return f.and.flatMap(neighbourWheres)
  if ('or' in f) return f.or.flatMap(neighbourWheres)
  if ('not' in f) return neighbourWheres(f.not)
  return 'relation' in f && f.where ? [f.where] : []
}

/**
 * The sets `matches` needs for the relation leaves of a filter that read the
 * entities they reach: for each `where`, the ids among `entities` that meet
 * it, the ones inside it worked out first. `entities` are what the reader
 * sees, as they see them: what they may not see never meets a `where`.
 */
export function whereSets(f: Filter, entities: readonly Entity[], related: Map<string, Set<string>> = NO_SETS, now = Date.now()): Map<string, Set<string>> {
  const sets = new Map(related)
  const add = (where: Filter): void => {
    const key = whereKey(where)
    if (sets.has(key)) return
    for (const inner of neighbourWheres(where)) add(inner)
    sets.set(key, new Set(entities.filter((e) => matches(e, where, sets, now)).map((e) => e.id)))
  }
  for (const where of neighbourWheres(f)) add(where)
  return sets
}

/** True when the filter asks who points at the entity, which needs `incomingRefs` attached before it is evaluated. */
export function usesIncoming(f: Filter): boolean {
  if ('and' in f) return f.and.some(usesIncoming)
  if ('or' in f) return f.or.some(usesIncoming)
  if ('not' in f) return usesIncoming(f.not)
  return 'relation' in f && f.relation.startsWith('<-')
}

const NO_SETS = new Map<string, Set<string>>()

/**
 * Compares the levels an entity reached on a scorecard, lowest first, with a
 * level name or `none`. Out of scope (`reached` undefined) matches nothing.
 * A name the entity did not reach sits above every level it did, so
 * `lt Gold` holds for an entity at Silver; a name the scorecard does not
 * have is refused where a filter is saved or searched with.
 */
function levelMatches(reached: string[] | undefined, op: (typeof LEVEL_OPS)[number], value: unknown): boolean {
  if (!reached) return false
  if (op === 'exists') return true
  const at = reached.length - 1
  const rank = (name: unknown): number | null => (name === NONE_LEVEL ? -1 : typeof name === 'string' && reached.includes(name) ? reached.indexOf(name) : null)
  const eq = (name: unknown) => (at < 0 ? name === NONE_LEVEL : reached[at] === name)
  const gte = (name: unknown) => rank(name) !== null
  const gt = (name: unknown) => {
    const r = rank(name)
    return r !== null && at > r
  }
  switch (op) {
    case 'eq':
      return eq(value)
    case 'neq':
      return !eq(value)
    case 'gte':
      return gte(value)
    case 'gt':
      return gt(value)
    case 'lt':
      return !gte(value)
    case 'lte':
      return !gt(value)
    case 'in':
      return Array.isArray(value) && value.some(eq)
  }
}

/** What a filter calls the level of an entity in scope that reached none. */
export const NONE_LEVEL = 'none'

/** Every scorecard a filter reads a level of. */
export function scorecardsIn(f: Filter): string[] {
  if ('and' in f) return f.and.flatMap(scorecardsIn)
  if ('or' in f) return f.or.flatMap(scorecardsIn)
  if ('not' in f) return scorecardsIn(f.not)
  if ('relation' in f) return f.where ? scorecardsIn(f.where) : []
  return 'scorecard' in f ? [f.scorecard] : []
}

/** Every scorecard leaf of a filter. */
export function levelLeaves(f: Filter): Extract<Filter, { scorecard: string }>[] {
  if ('and' in f) return f.and.flatMap(levelLeaves)
  if ('or' in f) return f.or.flatMap(levelLeaves)
  if ('not' in f) return levelLeaves(f.not)
  if ('relation' in f) return f.where ? levelLeaves(f.where) : []
  return 'scorecard' in f ? [f] : []
}

/**
 * Evaluates the search filter against one entity. `related` holds the
 * neighbour ids for each `relatedTo` in the filter, and, under `whereKey`, the
 * ids that meet each relation leaf's `where`: an entity's values are not on
 * the relations that reach it. A `where` with no set given meets nothing.
 */
export function matches(e: Entity, f: Filter, related: Map<string, Set<string>> = NO_SETS, now = Date.now()): boolean {
  if ('and' in f) return f.and.every((x) => matches(e, x, related, now))
  if ('or' in f) return f.or.some((x) => matches(e, x, related, now))
  if ('not' in f) return !matches(e, f.not, related, now)
  if ('state' in f) return e.state === f.state
  if ('search' in f) {
    // The key, the title, and the text of every field value the entity shows: a withheld field is not here to be found.
    const q = f.search.toLowerCase()
    return e.key.toLowerCase().includes(q) || e.title.toLowerCase().includes(q) || Object.values(e.fields).some((v) => searchTexts(v).some((t) => t.toLowerCase().includes(q)))
  }
  if ('relation' in f) {
    const targets = relationTargets(e, f.relation)
    if (f.where) {
      const meeting = related.get(whereKey(f.where))
      const meets = (t: RelatedRef) => meeting?.has(entityId(t)) ?? false
      return f.every ? targets.length > 0 && targets.every(meets) : targets.some(meets)
    }
    // A target is named by its id, its key, or, as a person picks it from a list, its title.
    return f.target === undefined ? targets.length > 0 : targets.some((t) => entityId(t) === f.target || t.key === f.target || t.title === f.target)
  }
  if ('relatedTo' in f) return related.get(f.relatedTo)?.has(e.id) ?? false
  if ('scorecard' in f) return levelMatches(e.levels?.[f.scorecard], f.op, f.value)
  return holds(fieldOf(e, f.field), f.op, f.value, now)
}

/** Whether one value passes one test of a field: what a field's leaf of a filter means, wherever the value came from. */
export function holds(v: unknown, op: (typeof FILTER_OPS)[number], value: unknown, now = Date.now()): boolean {
  const f = { op, value }
  const set = v !== null && v !== undefined
  // Only what takes part in an order compares: a list or an object is neither above nor below anything.
  const ordered = orderable(v) && orderable(f.value)
  switch (f.op) {
    case 'exists':
      return set
    case 'eq':
      return stable(v) === stable(f.value)
    case 'neq':
      return stable(v) !== stable(f.value)
    case 'gt':
      return ordered && compare(v, f.value) > 0
    case 'gte':
      return ordered && compare(v, f.value) >= 0
    case 'lt':
      return ordered && compare(v, f.value) < 0
    case 'lte':
      return ordered && compare(v, f.value) <= 0
    case 'in':
      return Array.isArray(f.value) && f.value.some((x) => stable(x) === stable(v))
    case 'contains':
      if (typeof v === 'string') return typeof f.value === 'string' && v.toLowerCase().includes(f.value.toLowerCase())
      if (Array.isArray(v)) return v.some((x) => stable(x) === stable(f.value))
      if (v && typeof v === 'object') return typeof f.value === 'string' && f.value in (v as object)
      return false
    case 'prefix':
      return typeof v === 'string' && typeof f.value === 'string' && v.startsWith(f.value)
    case 'within': {
      const ago = age(v, now)
      const span = duration(f.value)
      return ago !== null && span !== null && ago >= 0 && ago <= span
    }
    case 'older': {
      const ago = age(v, now)
      const span = duration(f.value)
      return ago !== null && span !== null && ago > span
    }
  }
}

/** A filter a caller sent that is no filter: the message names the part and what a leaf may be. */
export class FilterError extends Error {}

const LEAVES = 'a leaf is {field, op, value}, {relation, target?, where?}, {relatedTo}, {scorecard, op, value}, {state}, or {search}, combined with {and: [...]}, {or: [...]}, {not: {...}}'

/**
 * A filter as a caller sent it, checked: every part is a shape `matches`
 * reads, or `FilterError` names the part that is not. An empty object is no
 * filter where it is the whole filter: a caller that fills what it leaves
 * blank with `{}` asked for nothing there. Inside `and`, `or`, or `not` it is
 * a condition that lost what it said on the way, and is refused: answering
 * without it would answer a wider question than the one asked.
 */
export function readFilter(given: unknown): Filter | undefined {
  if (given !== null && typeof given === 'object' && !Array.isArray(given) && !Object.keys(given).length) return undefined
  return readPart(given)
}

function readPart(given: unknown): Filter | undefined {
  if (given === undefined || given === null) return undefined
  if (typeof given !== 'object' || Array.isArray(given)) throw new FilterError(`a filter is an object, not ${JSON.stringify(given)}: ${LEAVES}`)
  const f = given as Record<string, unknown>
  if (!Object.keys(f).length) throw new FilterError(`a condition arrived empty, as {}: what it said was lost on the way. Send it again, and write a value that is true, false, or a number as text, such as "true" or "3": ${LEAVES}`)
  const no = (why: string): never => {
    throw new FilterError(`${why} in ${JSON.stringify(given)}: ${LEAVES}`)
  }
  const text = (name: string): string => (typeof f[name] === 'string' && f[name] ? (f[name] as string) : no(`${name} must be text`))
  for (const all of ['and', 'or'] as const) {
    if (!(all in f)) continue
    if (!Array.isArray(f[all])) no(`${all} must be a list`)
    const parts = (f[all] as unknown[]).map(readPart).filter((x): x is Filter => x !== undefined)
    if (!parts.length) no(`${all} holds no condition`)
    return parts.length === 1 ? parts[0] : all === 'and' ? { and: parts } : { or: parts }
  }
  if ('not' in f) {
    const inner = readPart(f.not)
    return inner ? { not: inner } : no('not holds no condition')
  }
  if ('field' in f) {
    const op = (FILTER_OPS as readonly unknown[]).includes(f.op) ? (f.op as (typeof FILTER_OPS)[number]) : no(`op must be one of ${FILTER_OPS.join(', ')}`)
    return { field: text('field'), op, ...('value' in f ? { value: f.value } : {}) }
  }
  if ('relation' in f) {
    const where = 'where' in f ? readPart(f.where) : undefined
    if ('target' in f && f.target !== undefined && typeof f.target !== 'string') no('target must be text')
    return { relation: text('relation'), ...(typeof f.target === 'string' && f.target ? { target: f.target } : {}), ...(where ? { where } : {}), ...(f.every === true ? { every: true } : {}) }
  }
  if ('scorecard' in f) {
    const op = (LEVEL_OPS as readonly unknown[]).includes(f.op) ? (f.op as (typeof LEVEL_OPS)[number]) : no(`op must be one of ${LEVEL_OPS.join(', ')}`)
    return { scorecard: text('scorecard'), op, ...('value' in f ? { value: f.value as string | string[] } : {}) }
  }
  if ('relatedTo' in f) return { relatedTo: text('relatedTo') }
  if ('state' in f) return (ENTITY_STATES as readonly unknown[]).includes(f.state) ? { state: f.state as (typeof ENTITY_STATES)[number] } : no(`state must be one of ${ENTITY_STATES.join(', ')}`)
  if ('search' in f) return { search: text('search') }
  return no('no leaf is named')
}

/**
 * A filter with each value a caller wrote as text read as its field's type
 * where the field holds true or false, or a number: "true" is true and "3" is
 * 3. An agent's host may lose a condition whose value is not text, so an agent
 * writes every value as text. `typeOf` says a field's type on the blueprint
 * the filter reads; a relation's `where` reads another blueprint, and is left
 * as it was.
 */
export function typedFilter(f: Filter, typeOf: (field: string) => string | undefined): Filter {
  const one = (type: string | undefined, v: unknown): unknown => {
    if (typeof v !== 'string') return v
    if (type === 'boolean' && (v === 'true' || v === 'false')) return v === 'true'
    if (type === 'number' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
    return v
  }
  if ('and' in f) return { and: f.and.map((x) => typedFilter(x, typeOf)) }
  if ('or' in f) return { or: f.or.map((x) => typedFilter(x, typeOf)) }
  if ('not' in f) return { not: typedFilter(f.not, typeOf) }
  if ('field' in f && 'value' in f) {
    const type = typeOf(f.field)
    return { ...f, value: Array.isArray(f.value) ? f.value.map((v) => one(type, v)) : one(type, f.value) }
  }
  return f
}

/**
 * Who asks, as a filter may name them: a caller is known from their sign-in,
 * so a filter says `@me` and a day's name, and never an address or a time
 * the caller had to be told first.
 */
export interface Asker {
  /** How fields that hold a user name them. */
  address: string
  /** Their own entity, as `blueprint:key`, when the catalog holds one. */
  person: string | null
  /** The moments `@now`, `@today`, `@yesterday`, and `@tomorrow` stand for, as ISO times: each day's start on the asker's own clock. */
  times: Readonly<Record<(typeof ASKER_TIMES)[number], string>>
}

export const ASKER_TIMES = ['@now', '@today', '@yesterday', '@tomorrow'] as const
const ME = '@me'

/** The moments the day names stand for at `now`, each day's start on the clock of `zone`. */
export function askerTimes(now: Date, zone: string): Asker['times'] {
  const today = dayOf(now, zone).startedAt
  const start = (at: number) => dayOf(new Date(at), zone).startedAt.toISOString()
  return { '@now': now.toISOString(), '@today': today.toISOString(), '@yesterday': start(today.getTime() - 1), '@tomorrow': start(today.getTime() + 36 * 3_600_000) }
}

/** True when a filter names the asker or a day of theirs, so who asks must be worked out before it is read. */
export function namesAsker(f: Filter): boolean {
  const text = JSON.stringify(f)
  return text.includes(`"${ME}"`) || ASKER_TIMES.some((t) => text.includes(`"${t}"`))
}

/** A value with the asker filled in: `@me` is their address, and `@today` and the other day names the moment that day began for them. Any other value is itself. */
export function askerValue(v: unknown, who: Asker): unknown {
  if (v === ME) return who.address
  if (typeof v === 'string' && (ASKER_TIMES as readonly string[]).includes(v)) return who.times[v as (typeof ASKER_TIMES)[number]]
  return Array.isArray(v) ? v.map((x) => askerValue(x, who)) : v
}

/**
 * The filter with the asker filled in: `@me` as a field's value is their
 * address, and as a relation's target or `relatedTo` their own entity;
 * `@today` and the other day names are the moment that day began for them.
 */
export function forAsker(f: Filter, who: Asker): Filter {
  const entity = (): string => who.person ?? fail('@me names your own entity, and the catalog holds none for you: filter a field that holds your address instead')
  const fail = (why: string): never => {
    throw new FilterError(why)
  }
  const value = (v: unknown): unknown => askerValue(v, who)
  if ('and' in f) return { and: f.and.map((x) => forAsker(x, who)) }
  if ('or' in f) return { or: f.or.map((x) => forAsker(x, who)) }
  if ('not' in f) return { not: forAsker(f.not, who) }
  if ('field' in f) return 'value' in f ? { ...f, value: value(f.value) } : f
  if ('relation' in f) return { ...f, ...(f.target === ME ? { target: entity() } : {}), ...(f.where ? { where: forAsker(f.where, who) } : {}) }
  if ('relatedTo' in f) return f.relatedTo === ME ? { relatedTo: entity() } : f
  return f
}
