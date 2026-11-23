// The estate model. The hub knows nothing about Azure, k8s, or offices: it
// knows blueprints, entities, relations, sources, and the layers a value can
// come from. Both the server and the web app import this file.

import { INPUT_KINDS, kindOf, type InputKindName, type InputRules } from './input-kinds.ts'
import type { OutputValue, RunLine, RunStep } from './run-marks.ts'

export const FIELD_TYPES = ['string', 'number', 'boolean', 'datetime', 'enum', 'url', 'markdown', 'object', 'array', 'email', 'user', 'healthcheck', 'secretRef', 'openapi', 'trend'] as const
export type FieldType = (typeof FIELD_TYPES)[number]

export const AGGREGATION_FNS = ['count', 'sum', 'min', 'max', 'avg', 'median', 'p90', 'checks'] as const

/** What another judge said of one of its rules on an entity: it passed, it failed, or it had no data to say. */
export const CHECK_STATES = ['pass', 'fail', 'unknown'] as const
export type CheckValue = (typeof CHECK_STATES)[number]

/**
 * What a `checks` aggregation holds: each of a judge's rules, by its id, with
 * what the records say of it. A record holds an object of rule id to state;
 * where several do, a failure wins, then no data. Anything that is not one of
 * the three states is no part of it. Null when no record says anything.
 */
export function checksOf(records: readonly unknown[]): Record<string, CheckValue> | null {
  const out: Record<string, CheckValue> = {}
  const rank = (s: CheckValue) => CHECK_STATES.indexOf(s)
  for (const value of records) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    for (const [rule, state] of Object.entries(value)) {
      if (!(CHECK_STATES as readonly unknown[]).includes(state)) continue
      const was = out[rule]
      if (!was || rank(state as CheckValue) > rank(was)) out[rule] = state as CheckValue
    }
  }
  return Object.keys(out).length ? out : null
}
export const AGGREGATION_PERIODS = { day: 86_400_000, week: 604_800_000, month: 2_592_000_000 } as const

export interface AggregationDef {
  /**
   * Relations to follow, one hop per dot. `<-relation` follows relations that
   * point at the entity, `<-blueprint:relation` only those from one blueprint:
   * `<-sw_service:team.<-sw_deployment:service` is every deployment of every service a team owns.
   */
  relation: string
  /** `checks` reads an object of rule id to `pass`, `fail`, or `unknown` on each related entity, and holds each rule's worst: what another judge said, for a scorecard to copy rule by rule. */
  fn: (typeof AGGREGATION_FNS)[number]
  /** Field on the related entity, required for everything but count. */
  field?: string
  /** Filter on the related entity, same DSL as entity search. */
  where?: Filter
  /**
   * Keep only related entities whose datetime `field` falls in the last `last`, e.g. `30d`.
   * `offset` moves the window back: `{ last: '30d', offset: '30d' }` is the thirty days before the last thirty, for a trend.
   */
  window?: { field: string; last: string; offset?: string }
  /** Turn a count or sum over the window into a rate: deployments per week. Needs `window`. */
  per?: keyof typeof AGGREGATION_PERIODS
}

/**
 * Shows a `number` as money. `currency` is an ISO 4217 code. With `minor`, the
 * stored number is a whole count of the currency's smallest unit (cents for
 * USD), so 123456 shows as $1,234.56. Only the display changes: the field
 * stays the stored number for sorting, filtering, aggregations, and
 * calculations, which is why money is kept in minor units and adds exactly.
 */
export interface CurrencyFormat {
  kind: 'currency'
  currency: string
  minor?: boolean
}

/**
 * A `trend` field's value: a short series over time, drawn as a small line in
 * a grid and as a chart when opened. `points` are oldest first. `step` holds
 * each value until the next point, for a level or a tier; without it the
 * points are joined. `from` and `to` bound the time axis, so a step held to
 * now is drawn to now. `min` and `max` bound the value axis; `labels` name a
 * value, by its number as text; `unit` follows a value. `link` is where the
 * full history is, and `link_title` its words. A source that keeps the
 * history sends the summary, and the hub keeps no history of it; a trend
 * field with `history` is the hub's own summary of a field it keeps the
 * history of (`TrendHistory`).
 */
export interface TrendValue {
  points: { at: string; value: number }[]
  step?: boolean
  from?: string
  to?: string
  min?: number
  max?: number
  labels?: Record<string, string>
  unit?: string
  link?: string
  link_title?: string
}

/** The most points a trend holds: a trend is a summary, and its full history belongs to the system that keeps it. */
export const TREND_POINTS = 400

/**
 * The history the hub keeps of a derived `number` or `enum` field: on each
 * lifecycle tick, a point for every entity whose value moved since its last
 * point. Points older than `keep` (a duration such as `730d`) go, all but the
 * newest of each entity, which says what the value was when the window opens.
 */
export interface FieldHistory {
  keep: string
}

/**
 * A `trend` field read from the history of another field of the same
 * blueprint, which must keep one: a point for each `every` over the `last`
 * (`1w` over `104w` is a weekly series of two years), each the value held at
 * the end of its span. The spans end on the grid `every` lays from the
 * epoch; the newest is the one under way and holds the value held now. An
 * enum is drawn as steps of its values' places, with the values as labels.
 * At most `TREND_POINTS` points.
 */
export interface TrendHistory {
  of: string
  every: string
  last: string
}

/** Whether a field's history setting reads another field's history, as a trend's does. */
export function isTrendHistory(history: FieldHistory | TrendHistory | undefined): history is TrendHistory {
  return !!history && 'of' in history
}

/** A field the hub computes rather than stores: a mirror, an aggregation, a calculation, or a trend read from history. */
export function isDerived(def: Pick<FieldDef, 'mirror' | 'aggregation' | 'calculation' | 'history' | 'derived'>): boolean {
  return !!(def.mirror || def.aggregation || def.calculation || isTrendHistory(def.history) || def.derived)
}

/** How a field's value is shown. Only a `number` has one. */
export type FieldFormat = CurrencyFormat

/**
 * The range an estate wants a `number` kept in: at most `max`, at least
 * `min`, or both. A value outside it is over its budget. Nothing is refused
 * for it: the ground view shows it, and counts the entity as outside its
 * budgets.
 */
export interface FieldBudget {
  max?: number
  min?: number
}

/** Whether a value is outside its budget. A value that is not a number is not judged. */
export function overBudget(value: unknown, budget: FieldBudget | undefined): boolean {
  if (!budget || typeof value !== 'number' || !Number.isFinite(value)) return false
  return (budget.max !== undefined && value > budget.max) || (budget.min !== undefined && value < budget.min)
}

export interface FieldDef {
  type: FieldType
  title?: string
  description?: string
  /** False locks the field: only sources write it, and nobody sets or changes it in the web app or through `/v1/entities`. Defaults to true. */
  overridable?: boolean
  /** Allowed values for `enum`. */
  values?: string[]
  default?: unknown
  /** Read through relations, one hop per dot, ending in a field: `system.owner`, `team.department.title`. Prefix a hop with `<-` for incoming. */
  mirror?: string
  aggregation?: AggregationDef
  /** For a `number`: how it is shown, such as money. The stored value is not changed. */
  format?: FieldFormat
  /** For a `number`: the range it should stay in (`FieldBudget`). */
  budget?: FieldBudget
  /** Show the value as a coloured chip in tables: for short values that repeat, like a language or a person. Only a kind in `CHIP_TYPES` takes it. */
  chip?: boolean
  /**
   * Whether a grid counts this field's values under it: the spread of
   * values, and the values a filter on it picks from. Unset, a field is
   * counted when it is an enum, a boolean, a list, or a chip (`isSpread`).
   * `false` keeps a chip's look and drops the count, for a column of many
   * values such as a version. Only a kind in `SPREAD_TYPES` takes it.
   */
  spread?: boolean
  /** The colour of each value's chip and its share of the column, by value; `true` and `false` for a boolean. A value left out takes one from `valueColor`. */
  colors?: Record<string, ValueColor>
  /**
   * For a `url`: the value is a list of links, each drawn as its own mark, such as the dashboards of a service.
   * For an `enum`: the value is a list of the allowed values, such as the skills a person holds. One value is still taken.
   */
  many?: boolean
  /**
   * A person's change to a pushed value stays when the source pushes a
   * different one. For a value that is an opinion, such as a repository's
   * main language. Left out, a person's change gives way when the pushed
   * value moves.
   */
  sticky?: boolean
  /** For a `url`: the icon from the set its links are drawn as, in place of the address. Left out, a link wears the logo of the site it points into when the hub knows the site; `false` always shows the address. */
  icon?: string | false
  /** An expression over the entity's own fields, its `key` and its `title`, e.g. `days_until(cert_expires)` or `ready / replicas * 100`. */
  calculation?: string
  /**
   * On a derived `number` or `enum`: the hub keeps the field's history
   * (`FieldHistory`). On a `trend`: the series read from another field's
   * history (`TrendHistory`).
   */
  history?: FieldHistory | TrendHistory
  /**
   * On a `number` or an `enum`: the hub exports the field's value of every
   * entity as the gauge `orrery.field.value`, labelled `blueprint`, `field`,
   * and `key`; an enum as its value's place in `values`.
   */
  metric?: boolean
  /**
   * For an `object`: give each of its properties a field of its own, so a
   * tag or a label can be a column, a filter, and what a relation rule
   * matches on. The hub makes the fields as it meets the properties, and
   * takes them away again when this is turned off.
   */
  pivot?: boolean
  /** Set by the hub on a field a pivot made: the field it was pivoted out of and the property it reads. Its `calculation` reads that property. */
  pivoted?: { field: string; key: string }
  /**
   * Set by the hub on a field a source brought in an offer: the source, and a
   * fingerprint of the definition it offered. That source's next offer replaces
   * the field while its definition still has that fingerprint, so a product
   * keeps its own rules current; once a person edits the field, their edit wins.
   * A `budget`, an `access` rule, and `adminEdit` are no part of the fingerprint,
   * and stay as the estate set them when the source's definition moves.
   */
  offered?: OfferMark
  /** Who may see this field. Left out, everyone who may see the blueprint sees it. Only an admin sets it. */
  access?: AccessRule
  /** Only an admin changes this field's value, in the web app or through the API. Only an admin sets it. */
  adminEdit?: boolean
  /**
   * On an aggregation that is a `number` or a `trend`: its result is a
   * summary, shown to everyone who may see the field, whether or not they
   * may see the entities it reads. They get the number, or the trend without
   * its link, and nothing of those entities: not that they are there, not how
   * the number is worked out. A field's own rule and its class still decide
   * who sees the field. Left out, the result is withheld from anyone who may
   * not see what it reads. Only an admin sets it.
   */
  summary?: boolean
  /** Set by the hub for a reader shown a summary and not what it reads: the field is derived, and how is not theirs to read. */
  derived?: boolean
  /** Set by the hub for a reader who is not an admin: someone may not see this field. The rule itself is an admin's to read. */
  restricted?: boolean
}

/**
 * One way a signed-in person qualifies. Starting from the person's own entity
 * (the hub's `person` setting says which), follow `path`, one relation hop
 * per dot like a mirror, and read `field` at its end, or the entity's key
 * when no field is named. The person qualifies when any value read is in
 * `values`. No path is the person themselves: `{ values: ['someone@example.org'] }`.
 * An incoming hop names the blueprint it comes from: `<-blueprint:relation`.
 */
export interface AccessGrant {
  path?: string
  field?: string
  values: string[]
}

/**
 * Who may see a blueprint or a field: anyone any grant lets in, and anyone in
 * a named audience (`src/shared/policy.ts`). An admin and a machine token see
 * everything. A rule with neither lets in admins alone. A blueprint's rule
 * may also open each entity to the people who own it (`owners`), and to the
 * people who may see what it is about (`subjects`).
 */
export interface AccessRule {
  grants: AccessGrant[]
  audiences?: string[]
  owners?: OwnerAccess
  /**
   * On a blueprint's rule: relations of the blueprint that name what each of
   * its entities is about, such as a finding's resource. Someone the rule
   * does not let in still sees an entity when they may see an entity it
   * names through one of these, and reads it as anyone the rule lets in
   * would. They never change what they read this way.
   */
  subjects?: string[]
}

/**
 * On a blueprint's rule: someone the rule does not let in still sees the
 * entities of it they own, by one of `roles` (the `as` of the person
 * setting's `owns`), and nothing else of the blueprint. Of each, they read
 * the fields `fields` names, or with `all` every field; a field's own rule
 * and its class still apply. They never change what they read this way.
 */
export interface OwnerAccess {
  roles: string[]
  fields: string[] | 'all'
}

/**
 * How the hub finds the entity that is a signed-in person: an entity of
 * `blueprint` whose key, or whose `field` when one is named, is the person's
 * sign-in address in lowercase. It also says what that person owns.
 */
export interface PersonSetting {
  blueprint: string
  field?: string
  /**
   * What a person owns: relation paths from their entity, each reaching
   * entities that are theirs. `teams.<-team` reaches everything a team of
   * theirs is named on; `<-person` reaches what names them. A path may say
   * how what it reaches is theirs, `{ as: qa, path: <-qa_owner }`, and one
   * thing can be theirs several ways. Unset, the hub does not know what is
   * anyone's, and says so.
   */
  owns?: (string | OwnsPath)[]
}

/** One way things are a person's: the path that reaches them, and what the person is to them, such as `owner`, `qa`, or `platform`. */
export interface OwnsPath {
  as?: string
  path: string
}

/** A person setting's `owns`, each as a path with its role. */
export function ownsPaths(owns: PersonSetting['owns']): OwnsPath[] {
  return (owns ?? []).map((o) => (typeof o === 'string' ? { path: o } : o))
}

/** How many fields one pivot makes at most. An object with a property per entity is not a set of columns. */
export const PIVOT_LIMIT = 100

/**
 * The colours a value can be shown in. Every chip, and every share of a
 * column's distribution, takes one of these, so a value looks the same
 * wherever it appears. `grey` is kept for no value and the rest.
 */
export const VALUE_COLORS = ['blue', 'turquoise', 'green', 'lime', 'yellow', 'orange', 'red', 'pink', 'purple', 'brown', 'grey'] as const
export type ValueColor = (typeof VALUE_COLORS)[number]

/** Values that name a colour, or a status level, wear it unless the field says otherwise. */
const NAMED: Record<string, ValueColor> = { amber: 'yellow', gray: 'grey', ...Object.fromEntries(VALUE_COLORS.map((c) => [c, c])) }
const CYCLE = VALUE_COLORS.filter((c) => c !== 'grey')
/** The colours a value is given from its text: none that reads as a status, so a plain value never looks like a warning. */
const HASHED: ValueColor[] = ['blue', 'turquoise', 'purple', 'pink']

/**
 * The colour a value is shown in. What the field declares wins. A value that
 * names a colour wears it. An enum value takes the colour at its place in
 * the list, so the first values never share one; a boolean is green when
 * true and grey when false; anything else takes a colour from its text, the
 * same one every time, and never one that reads as a status.
 */
export function valueColor(def: Pick<FieldDef, 'type' | 'values' | 'colors'> | undefined, value: string): ValueColor {
  const declared = def?.colors?.[value]
  if (declared) return declared
  const named = NAMED[value.toLowerCase()]
  if (named) return named
  if (def?.type === 'boolean') return value === 'true' ? 'green' : 'grey'
  const at = def?.type === 'enum' ? (def.values ?? []).indexOf(value) : -1
  if (at >= 0) return CYCLE[at % CYCLE.length]!
  let h = 0
  for (const ch of value) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return HASHED[h % HASHED.length]!
}

/** The kinds of field a person may show as chips: short text that may repeat. An enum, a boolean, and a list always are. */
export const CHIP_TYPES: readonly FieldType[] = ['string', 'email', 'user']

/** Whether a field of this kind may be marked a chip. */
export const mayChip = (type: FieldType): boolean => CHIP_TYPES.includes(type)

/** The kinds of field a grid may count under it: a chip's kinds, an enum, a boolean, and a list. */
export const SPREAD_TYPES: readonly FieldType[] = [...CHIP_TYPES, 'enum', 'boolean', 'array']

/** Whether a field of this kind may be counted under a grid. */
export const maySpread = (type: FieldType): boolean => SPREAD_TYPES.includes(type)

/**
 * Whether a grid counts this field's values under it. The one answer, on
 * either side: what the field says, else whether it is an enum, a boolean,
 * a list, or a chip.
 */
export function isSpread(def: FieldDef | undefined): boolean {
  if (!def || !maySpread(def.type)) return false
  return def.spread ?? (def.type === 'enum' || def.type === 'boolean' || def.type === 'array' || !!def.chip)
}

/**
 * The most values one row may hold in a column a grid shares out. A longer
 * list is a document, not a few kinds of value: counting it costs a step for
 * every value on every row, so a column that holds one is not counted.
 */
export const SHARED_LIST_MAX = 100

export interface RelationDef {
  target: string
  many?: boolean
  required?: boolean
  title?: string
  inverseTitle?: string
  description?: string
  /** `contain` says the child lives inside the target, as a node in its cluster. It counts toward the nesting depth limit. */
  display?: 'link' | 'contain'
  /**
   * Where the target comes from while nothing sets this relation on the
   * entity itself. A relation path, `program.team` or
   * `resource_group.environment`: set it high and everything beneath reads
   * it; set it on one entity and that wins there. Or ordered cases, read by
   * `inheritCases`: the first whose `when` the entity matches and that
   * reaches a target gives it.
   */
  inherit?: string | InheritCase[]
  /** Names this relation had before. A write that names one sets this relation, and saving the blueprint moves the links stored under it. */
  formerly?: string[]
}

/**
 * One way a relation inherits its target. `when` is a filter on the entity
 * itself, the same filter a search takes; left out, every entity matches.
 * `path` follows relations to the target, as a plain `inherit` does; `target`
 * names one entity of the relation's target blueprint by key, for a default
 * nothing above the entity holds. A case gives exactly one of the two.
 */
export interface InheritCase {
  when?: Filter
  path?: string
  target?: string
}

/** A relation's inherit as ordered cases: a plain path is the one case with no condition. */
export function inheritCases(def: Pick<RelationDef, 'inherit'>): InheritCase[] {
  if (def.inherit === undefined) return []
  return typeof def.inherit === 'string' ? [{ path: def.inherit }] : def.inherit
}

/** The relation paths a relation's inherit follows. */
export function inheritPaths(def: Pick<RelationDef, 'inherit'>): string[] {
  return inheritCases(def).flatMap((c) => (c.path ? [c.path] : []))
}

export interface GracePolicy {
  /** Committed snapshots the entity must be absent from. */
  runs?: number
  /** Minimum time absent, e.g. `24h`, `30m`, `0`. */
  duration?: string
}

export interface ExpirePolicy {
  /** How long an entity is kept, e.g. `180d`. */
  after: string
  /** The datetime field to count from. Without one, the time the hub first saw the entity. */
  field?: string
}

/** Who brought a definition in an offer, and the fingerprint of what they offered. */
export interface OfferMark {
  source: string
  hash: string
}

export interface StatusRollup {
  /** Relation paths whose ends feed this entity's status. `<-system` means entities that point at this one via `system`. */
  relations?: string[]
  /** An enum field (red, amber, green, grey) the entity reports its own status through. A string field `<field>_reason` beside it says why, when it is not green. */
  field?: string
  /** Set by the hub when a source's offer chose `field`; its fingerprint is the field's name. That source may move it while nobody else has. */
  offered?: OfferMark
}

/**
 * What the ground view reads of a blueprint: one plot for each entity, drawn
 * from the fields and relations named here. The hub ships the view and no
 * model for it, so every name is one the estate chose. A blueprint with a
 * `ground`, even an empty one, has a ground view; every `number` field with
 * a `budget` is shown on it either way. A name whose field or relation has
 * since gone is read as not set.
 */
export interface GroundDef {
  /** A `number` field: how long one round of work takes, such as the minutes from a push to its result. */
  loop?: string
  /** A `number` field: how often work on it gets stuck, as a source counts it. */
  friction?: string
  /** A `number` field: how much of what should not be there it holds, such as suppressed warnings. */
  unwanted?: string
  /** A `number` field: how much it is used, such as its deploys in a month. */
  activity?: string
  /** Fields that say what it is built on, such as a runtime and a base image, the deepest first. */
  foundations?: string[]
  /** `boolean` fields, each a limit that holds or does not, such as a protected branch. */
  guards?: string[]
  /** A relation to what its patterns were copied from. Every entity that shares a target is shown beside it. */
  taughtBy?: string
  /** What it was started from: a to-one relation to its template, the field here holding the version it started at, and the field on the template holding the version current now. `action` is the action that starts a new one. */
  template?: { relation: string; version?: string; current?: string; action?: string }
  /** A `boolean` field: changes to the platform land on this one first. */
  trial?: string
  /** `datetime` fields the forecast reads: what ends or falls due, such as a waiver. */
  ahead?: string[]
  /** The `trend` field that holds a number's past, by the number's name, where no trend already reads that number's history. */
  trends?: Record<string, string>
}

/**
 * What the map of one of a blueprint's entities reads: the entity holds plots and the things around them, and each sits
 * in places. A program holds its services, which run in environments, and the apps, databases, and storage deployed for it.
 */
export interface MapDef {
  /** A to-one relation of the blueprint to itself. An entity that names the holder through it is a part of the holder: what it holds is on the same map, under its name. */
  parts?: string
  /** The blueprint whose entities are the places, such as environments. */
  places: string
  /**
   * The plots: entities of `blueprint` that name the holder through `holder`. A plot is in each place that an entity of
   * `placedBy.blueprint` names through `placedBy.place` while it names the plot through `placedBy.plot`, such as a running service.
   */
  plots: { blueprint: string; holder: string; placedBy?: { blueprint: string; plot: string; place: string } }
  /** What else the holder holds: entities of `blueprint` that name the holder through `holder`, a place through `place`, and a plot through `plot`. One that names no plot lies open in its place. */
  members?: { blueprint: string; holder: string; place?: string; plot?: string }[]
  /** A boolean field of the blueprint: a holder on which it is true is one of the few the estate puts first, drawn large and named wherever every holder is shown at once. */
  primary?: string
  /** A field of the blueprint, or a to-one relation of it: the holders that share its value (or name the same entity) are shown together wherever every holder is shown at once. */
  sector?: string
}

/** Where a rule or scorecard came from: authored in the web app, or owned by a git source. */
export type DefinitionOrigin = { kind: 'ui' } | { kind: 'git'; source: string; file: string }

/** An action may also be put by a source that holds the `actions` grant, as an app declares the self-service it offers. */
/** An action is made by hand, declared in git, put by a source, or one of the hub's own (`HUB_ACTIONS` in `builtin.ts`), which nobody else changes. */
export type ActionOrigin = DefinitionOrigin | { kind: 'source'; source: string } | { kind: 'hub' }

/** A scorecard may also be put by a source that holds the `scorecards` grant, as a judge publishes its own: it is that source's to change. */
export type ScorecardOrigin = DefinitionOrigin | { kind: 'source'; source: string }

/** A blueprint may also be brought by a source, editable from then on, or be one of the hub's own. */
export type BlueprintOrigin = DefinitionOrigin | { kind: 'source'; source: string } | { kind: 'hub' }

/** Blueprint ids under this prefix belong to the hub; nothing else may define one. */
export const RESERVED_PREFIX = 'orrery_'
/** The hub keeps one entity of this blueprint per registered source. */
export const SOURCE_BLUEPRINT = 'orrery_source'
/** The hub keeps one entity of this blueprint per runner source. */
export const RUNNER_BLUEPRINT = 'orrery_runner'
/** The blueprints whose entities carry what a source says of itself, laid over as they are read: all a `sources` event moves. */
export const SOURCE_STANDING: readonly string[] = [SOURCE_BLUEPRINT, RUNNER_BLUEPRINT]
/** The hub keeps one entity of this blueprint per action schedule that runs, waits, or is paused. */
export const SCHEDULE_BLUEPRINT = 'orrery_schedule'
/** The hub keeps one entity of this blueprint per report a team defined. */
export const REPORT_BLUEPRINT = 'orrery_report'
/** The hub keeps one entity of this blueprint per published edition of a report, for as long as editions are kept. */
export const EDITION_BLUEPRINT = 'orrery_report_edition'

/** What a blueprint is called on screen, read from the blueprints the reader sees. */
export type BlueprintNamer = (blueprint: Pick<Blueprint, 'id' | 'title' | 'group'> | string | undefined) => string

/**
 * The name a blueprint is shown by. Titles may repeat on purpose: an estate can
 * hold several blueprints titled "Portfolio", kept apart by their catalog
 * section. A title no other blueprint in `visible` shares is shown alone; a
 * repeated one is shown with its section, as "Portfolio · Finance", or with its
 * id when the section does not tell it apart. An id the list does not hold is
 * shown as itself.
 */
export function blueprintNamer(visible: readonly Pick<Blueprint, 'id' | 'title' | 'group'>[]): BlueprintNamer {
  const fold = (text: string) => text.trim().toLowerCase()
  const byId = new Map(visible.map((b) => [b.id, b]))
  const sharing = new Map<string, Pick<Blueprint, 'id' | 'title' | 'group'>[]>()
  for (const b of visible) sharing.set(fold(b.title), [...(sharing.get(fold(b.title)) ?? []), b])
  return (blueprint) => {
    if (blueprint === undefined) return ''
    const b = typeof blueprint === 'string' ? byId.get(blueprint) : blueprint
    if (!b) return typeof blueprint === 'string' ? blueprint : ''
    const others = (sharing.get(fold(b.title)) ?? []).filter((o) => o.id !== b.id)
    if (!others.length) return b.title
    const section = b.group?.trim()
    const apart = section && !others.some((o) => o.group?.trim().toLowerCase() === section.toLowerCase())
    return `${b.title} · ${apart ? section : b.id}`
  }
}

/** A git or hub definition cannot be edited or removed in the web app. */
export function isLocked(origin: BlueprintOrigin): boolean {
  return origin.kind === 'git' || origin.kind === 'hub'
}

export interface Blueprint {
  id: string
  title: string
  description?: string
  /** A name from the icon set in `icons.ts`, shown for every entity that has no icon of its own. An unknown name shows a box. */
  icon?: string
  /** A heading the blueprint is listed under in the catalog and model sidebars. The hub's group order decides which heading comes first. */
  group?: string
  /** Show every entity of this blueprint on the wall, reduced to one colour. */
  wall?: boolean
  /** Its entities may be connected to nothing, such as a mailing list nobody owns: one that is raises no finding. */
  standalone?: boolean
  /** `grace` is how long an entity a snapshot stopped mentioning is kept. `expire` removes entities by age, for things that happened rather than things that exist. */
  /** `keepDeleted`: how long a deleted entity is kept for a return, e.g. `1d`; without it, the hub's `TOMBSTONE_DAYS`. */
  lifecycle?: { grace?: GracePolicy; expire?: ExpirePolicy; keepDeleted?: string }
  status?: StatusRollup
  /** What the ground view reads of the blueprint (`GroundDef`). Left out, it has no ground view. */
  ground?: GroundDef
  /** What the map of one of its entities reads (`MapDef`). Left out, its entities have no map. */
  map?: MapDef
  fields: Record<string, FieldDef>
  relations: Record<string, RelationDef>
  /** Who may see the blueprint and its entities. Left out, everyone. Only an admin sets it. */
  access?: AccessRule
  /**
   * Who may read the timeline of its entities: the changes the hub recorded
   * on each, who made them, and what they replaced. Left out, whoever sees
   * the entity. Its grants and audiences decide alone; a rule with neither
   * lets in admins alone. Only an admin sets it.
   */
  timeline?: AccessRule
  /** Only an admin changes the blueprint, its entities, or its values. Only an admin sets it. */
  adminEdit?: boolean
  /** Ids this blueprint was known by before a rename. A read, a write, or an offer that names one reaches this blueprint, and a catalog file that renames one of its own blueprints names the old id here. */
  formerly?: string[]
  /** Set by the hub for a reader who is not an admin: not everyone may see this blueprint. */
  restricted?: boolean
  /** Set by the hub for a reader who may not read the timeline of its entities. */
  noTimeline?: boolean
  /** Set by the hub for a reader who sees only their own entities of this blueprint, as its rule opens them to owners. */
  onlyYours?: boolean
  /** Set by the hub for a reader who sees only the entities of this blueprint about what they may see, as its rule's `subjects` opens them. */
  onlyAbout?: boolean
  /**
   * Set by the hub: the fields and relations access is decided from, which
   * only an admin, a holder of `access.values`, git, or the source that owns
   * an entity changes. The whole blueprint when it holds the people or a
   * grant reads through it.
   */
  decides?: { all: boolean; names: string[] }
  origin: BlueprintOrigin
  updatedAt: string
}

/** What a writer sends or a catalog file declares: the blueprint without the hub's bookkeeping. */
export type BlueprintInput = Omit<Blueprint, 'origin' | 'updatedAt'>

export const ENTITY_STATES = ['active', 'missing', 'deleted'] as const
export type EntityState = (typeof ENTITY_STATES)[number]

/** Where a value came from, lowest precedence first. */
export const LAYERS = ['default', 'inherited', 'ui', 'rule', 'pushed', 'override', 'git'] as const
export type Layer = (typeof LAYERS)[number]

export const STATUS_LEVELS = ['red', 'amber', 'green', 'grey'] as const
export type StatusLevel = (typeof STATUS_LEVELS)[number]

export interface EntityRef {
  blueprint: string
  key: string
}

export function entityId(ref: EntityRef): string {
  return `${ref.blueprint}:${ref.key}`
}

export function parseEntityId(id: string): EntityRef | null {
  const i = id.indexOf(':')
  if (i <= 0 || i === id.length - 1) return null
  return { blueprint: id.slice(0, i), key: id.slice(i + 1) }
}

/**
 * The id an entity input of `blueprint` holds for a value: an id
 * (`blueprint:key`) as it is; a bare key, holding no colon, as the key of
 * that blueprint; an entity or a list of them, its first. Anything else is
 * passed on as it is, for the check to refuse with its reason.
 */
export function entityIdFor(value: unknown, blueprint: string): string | null {
  const first: unknown = Array.isArray(value) ? value[0] : value
  if (first && typeof first === 'object' && 'id' in first) return entityIdFor((first as { id: unknown }).id, blueprint)
  if (typeof first !== 'string' || first === '') return null
  if (parseEntityId(first)?.blueprint === blueprint || first.includes(':')) return first
  return `${blueprint}:${first}`
}

/** A related entity as a list names it: the ref, and its title once the entity exists. */
export interface RelatedRef extends EntityRef {
  title?: string
  /** The picture a reference to a person draws, laid on where a grid block or an entity page is read. */
  icon?: string | null
}

export interface RelationEnd {
  /** Relation name as declared on the owning blueprint. */
  relation: string
  /** The blueprint that declares the relation. */
  declaredOn: string
  target: EntityRef
  targetTitle: string | null
  /** The icon the target draws: its own, else its blueprint's. Null while the target has no derived row. */
  targetIcon: string | null
  /** Target does not exist yet. */
  pending: boolean
  /** Target is missing or deleted. */
  dangling: boolean
  title: string
  display: 'link' | 'contain'
  /** The layer that won for this relation on the declaring entity. */
  layer: Layer
}

export interface FieldProvenance {
  layer: Layer
  source: string | null
  at: string | null
  /** The value the active layer replaced, when a lower layer holds one. */
  replaced?: unknown
  /** The soft override, when one is stored. */
  override?: { value: unknown; basis: unknown; by: string; at: string }
  /** Git-set fields are locked in the UI and link to their file. */
  file?: string
  locked: boolean
}

export interface EntityStatus {
  level: StatusLevel
  reasons: string[]
}

/** A person a `user` value names, as the reader may see them. */
export interface PersonShown extends EntityRef {
  title: string
  /** The picture they show: their pick, their photo, or their entity's icon. */
  icon: string | null
}

/** The one form a `user` value is looked up by: trimmed and lowercase, the way the hub keeps a sign-in address. */
export function addressKey(value: string): string {
  return value.trim().toLowerCase()
}

export interface Entity extends EntityRef {
  id: string
  title: string
  /** The icon shown for the entity: its own when a source, git, or a person set one from the icon set, else its blueprint's. A person entity shows its person's pick or photo before any of those (`picture`). */
  icon: string | null
  /** On a person entity, why `icon` is not its own: the person picked it for themselves, or it is their photo. Only they change it then. */
  picture?: 'photo' | 'picked'
  state: EntityState
  /** Kept out of every view unless the view asks for hidden entities. */
  hidden: boolean
  fields: Record<string, unknown>
  relations: Record<string, RelatedRef[]>
  /** Owning source: the writer that created it and the only one that can delete it. */
  owner: string
  scope: string | null
  createdAt: string
  updatedAt: string
  lastSeenAt: string | null
  missingSince: string | null
  deletedAt: string | null
  status: EntityStatus
  /** Entities pointing here, keyed `blueprint.relation`. Present when the list asked for it. */
  incomingRefs?: Record<string, RelatedRef[]>
  /** How many point here under each key of `incomingRefs`, when the list asked for only the first few of each. */
  incomingCount?: Record<string, number>
  /** The layer that won for each field, `title` and `icon` included. Present when the list asked for it. */
  layers?: Record<string, Layer>
  /** The layer that won for each relation that is set. Present when the list asked for it. */
  relationLayers?: Record<string, Layer>
  /** The actions the reader may run on this entity, by id. Present where a grid block or an entity page is read. */
  actions?: string[]
  /**
   * The fields and relations an edit rule opens to the reader on this entity,
   * `title` and `icon` among the fields: theirs to change though they hold no
   * `entities.edit`, or where a guard keeps a holder off. A field a source or
   * git says is left out for whoever is let in only as its owner. Present
   * where a grid block or an entity page is read, and only when not empty.
   */
  editable?: { fields: string[]; relations: string[] }
  /**
   * The person each `user` value names, by `addressKey` of the value: the
   * entity the person setting says has that address, under its title, when
   * the reader may see it. Present where a grid block or an entity page is
   * read, and only when not empty.
   */
  people?: Record<string, PersonShown>
  /**
   * Whether the reader starred this entity: one of their favorites, which
   * every catalog grid they read puts first. Present where a grid block or an
   * entity page is read for a person, and only when true. A query never reads
   * it.
   */
  starred?: true
  /**
   * For each scorecard that has the entity in scope, the levels it reached,
   * lowest first; empty when it reached none. A scorecard that leaves it out
   * of scope is not here. Present when a scorecard covers the blueprint.
   */
  levels?: Record<string, string[]>
}

export interface EntityDetail extends Entity {
  provenance: Record<string, FieldProvenance>
  outgoing: RelationEnd[]
  incoming: RelationEnd[]
  changes: Change[]
}

export const SOURCE_CLASSES = ['pusher', 'event', 'git', 'ui', 'runner', 'hub'] as const
export type SourceClass = (typeof SOURCE_CLASSES)[number]

export interface GitSourceConfig {
  url: string
  branch: string
  /** Glob under the repo root, e.g. `catalog/**\/*.yaml`. */
  glob: string
  /** Set when a token or private key is stored for this repo. It never leaves the hub. */
  hasToken: boolean
  /** How the hub authenticates: a static token, or a GitHub App whose installation token is minted on every pull. */
  auth?: { type: 'token' } | { type: 'github-app'; appId: string; installationId: string }
  webUrl?: string
}

/**
 * Where an event source keeps a record of each alert after it resolves. The
 * hub writes one entity per alert into `blueprint`, keyed `<source>/<fingerprint>`,
 * with these fields when the blueprint has them: `summary`, `status` (open,
 * resolved), `severity` (critical, high, medium, low), `health` (red, amber,
 * green), `source` (alertmanager), `rule`, `started_at`, `resolved_at`,
 * `duration_hours`, `labels`. When the alert matched an entity through an
 * alert rule, the relation named `relation` points at it, if the blueprint
 * has one targeting that entity's blueprint.
 */
export interface AlertHistory {
  blueprint: string
  relation?: string
}

export interface Source {
  id: string
  title: string
  class: SourceClass
  description?: string
  /** Blueprints this source may write. `*` for all. */
  blueprints: string[]
  /** Blueprints this source may explicitly delete. Empty for none, `*` for all. */
  deleteGrant: string[]
  /** Expected time between runs or heartbeats, e.g. `3m`, `26h`. Staleness is judged against it. */
  cadence: string | null
  grace?: GracePolicy
  git?: GitSourceConfig
  /** For an event source: the blueprint every alert it sends is also kept in, as an entity that outlives the alert. */
  history?: AlertHistory
  /** The entity this source speaks for, `<blueprint>:<key>`, such as the service whose token it is. Set by an admin; the hub checks its shape only. */
  actsFor: string | null
  /** The source may define self-service actions with its token. Set by an admin. */
  actions: boolean
  /** The source may put and remove its own scorecards with its token, as a judge publishes its rules. Set by an admin. */
  scorecards: boolean
  /** For a runner: the tools it lends its identity to. Set by an admin. Without it, the runner runs no tool. */
  serves?: RunnerServes
  /** For a runner: how many jobs it runs at once, as it last said when it asked for work. */
  width?: number
  /** What the source has written, as the hub saw it accept each write. */
  writes: SourceWrites
  createdAt: string
  lastSeenAt: string | null
  lastRunAt: string | null
  lastError: string | null
  status: StatusLevel
  statusReason: string | null
}

/**
 * How far a tool reaches, least first: `read` looks at how a thing is set up
 * and how it runs, `data` reads what it holds, `act` changes it.
 */
export const TOOL_TIERS = ['read', 'data', 'act'] as const
export type ToolTier = (typeof TOOL_TIERS)[number]

/**
 * What a runner lends its identity to. A runner runs a tool's command with
 * everything the runner holds, so this is the rule for who may borrow that:
 * the tiers a tool on it may have, the sources that may put a tool on it
 * with their own token (none: only an admin's save and a git file do), and
 * the entities a tool on it may be declared from, such as the repositories
 * of one program. A tool of no entity runs only on a runner with no `on`.
 */
export interface RunnerServes {
  tiers: ToolTier[]
  sources?: string[]
  on?: { blueprint: string; where?: Filter }
}

/** The shape of `actsFor`: a blueprint id, a colon, and a key. */
export const ACTS_FOR = /^[a-z][a-z0-9_]*:.+$/

/** Per target, how often and when a source last wrote it: the entities by blueprint, the blueprints it offered, the actions it put. */
export interface SourceWrites {
  entities: { blueprint: string; count: number; lastAt: string }[]
  blueprints: { id: string; lastAt: string }[]
  actions: { id: string; lastAt: string }[]
  scorecards: { id: string; lastAt: string }[]
}

export const RUN_STATES = ['open', 'committed', 'abandoned', 'failed'] as const
export type RunState = (typeof RUN_STATES)[number]

export interface RunError {
  blueprint?: string
  key?: string
  field?: string
  reason: string
}

export interface Run {
  id: string
  source: string
  mode: 'snapshot' | 'incremental'
  scope: string
  state: RunState
  startedAt: string
  finishedAt: string | null
  /** `received` counts what was sent in full, and `sighted` what was named by a sighting and taken; both are in `unchanged` when nothing moved. */
  counts: { received: number; created: number; updated: number; unchanged: number; rejected: number; missing: number; deleted: number; sighted: number }
  errors: RunError[]
  massDrop: boolean
}

/** Everything the activity log records, by what happened. The part before the dot is what it happened to. */
export const CHANGE_KINDS = [
  'entity.created',
  'entity.updated',
  'entity.missing',
  'entity.deleted',
  'entity.restored',
  'entity.hidden',
  'override.cleared',
  'run.committed',
  'run.failed',
  'run.mass_drop',
  'blueprint.changed',
  'rule.changed',
  'scorecard.changed',
  'alert_rule.changed',
  'model.imported',
  'model.arranged',
  'catalog.ordered',
  'catalog.folded',
  'catalog.hidden',
  'grid.arranged',
  'grid.standard',
  'model.conventions',
  'canvas.arranged',
  'source.changed',
  'source.refreshed',
  'secret.changed',
  'token.issued',
  'token.revoked',
  'token.rotated',
  'access.changed',
  'access.reviewed',
  'preview.changed',
  'user.enrolled',
  'user.changed',
  'user.removed',
  'role.changed',
  'access.refused',
  'access.viewed',
  'ingest.failed',
  'action.changed',
  'action.requested',
  'action.approved',
  'action.declined',
  'action.returned',
  'action.cancelled',
  'action.finished',
  'action.retried',
  'action.wrote_back',
  'schedule.requested',
  'schedule.approved',
  'schedule.declined',
  'schedule.changed',
  'schedule.paused',
  'schedule.removed',
  'schedule.fired',
  'action.voted',
  'action.batched',
  'action.batch_stopped',
  'action.batch_finished',
  'action.set_requested',
  'action.set_approved',
  'action.set_rejected',
  'action.set_withdrawn',
  'action.set_finished',
  'action.arranged',
  'icon.changed',
  'icon.removed',
  'picture.changed',
  'picture.removed',
  'picture.picked',
  'budgets.changed',
  'welcome.changed',
  'report.created',
  'report.changed',
  'report.removed',
  'report.published',
] as const
export type ChangeKind = (typeof CHANGE_KINDS)[number]

/** Who acted: a person in the web app, an agent or script with an access token, a source writing to the hub, or the hub itself. */
export const ACTOR_KINDS = ['user', 'token', 'source', 'hub'] as const
export type ActorKind = (typeof ACTOR_KINDS)[number]

/** What an action touched, coarser than its kind: the filter a reader narrows the activity log by. */
export const ACTIVITY_CATEGORIES = ['estate', 'runs', 'model', 'layout', 'sources', 'secrets', 'access', 'actions'] as const
export type ActivityCategory = (typeof ACTIVITY_CATEGORIES)[number]

const CATEGORY_OF: Record<string, ActivityCategory> = {
  entity: 'estate',
  override: 'estate',
  run: 'runs',
  ingest: 'runs',
  blueprint: 'model',
  rule: 'model',
  scorecard: 'model',
  alert_rule: 'model',
  model: 'model',
  catalog: 'layout',
  grid: 'layout',
  canvas: 'layout',
  source: 'sources',
  secret: 'secrets',
  token: 'access',
  user: 'access',
  role: 'access',
  access: 'access',
  preview: 'access',
  action: 'actions',
  icon: 'model',
  picture: 'estate',
  budgets: 'sources',
  welcome: 'layout',
  report: 'actions',
}

export function categoryOf(kind: string): ActivityCategory {
  return CATEGORY_OF[kind.split('.')[0]!] ?? 'estate'
}

/** `refused` is an action the actor lacked the permission for; `failed` is one the hub turned down or could not finish. */
export const OUTCOMES = ['ok', 'refused', 'failed'] as const
export type Outcome = (typeof OUTCOMES)[number]

export interface Change {
  id: number
  at: string
  kind: ChangeKind
  category: ActivityCategory
  outcome: Outcome
  blueprint: string | null
  key: string | null
  source: string | null
  actor: string | null
  actorKind: ActorKind
  detail: Record<string, unknown>
}

export const FINDING_KINDS = ['dangling_relation', 'no_relations', 'unmatched_rule', 'stale_source', 'mass_drop', 'cleared_override', 'field_conflict', 'schema_mismatch', 'missing_required_relation', 'broken_path', 'unmet_convention', 'over_budget'] as const
export type FindingKind = (typeof FINDING_KINDS)[number]

export interface Finding {
  kind: FindingKind
  level: StatusLevel
  title: string
  detail: string
  entity?: EntityRef
  /** The entity a relation points at, for a dangling relation. */
  target?: EntityRef
  /** The field the finding is about. */
  field?: string
  /** The blueprint the finding is about, when it names no one entity. */
  blueprint?: string
  source?: string
  run?: string
  /** Entities a Contributor may delete now, for mass drops. */
  entities?: EntityRef[]
  /** Whether it touches something the reader owns. Left out when the hub does not know what they own. */
  yours?: boolean
}

export interface RelationRule {
  id: string
  blueprint: string
  relation: string
  match: { target: string; where: string }
  /** An entity the rule finds no target for is no finding: most of them are expected not to match, such as workloads running images from outside the registry. */
  optional?: boolean
  origin: DefinitionOrigin
}

export const FILTER_OPS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'contains', 'prefix', 'exists', 'within', 'older'] as const

/** How a filter compares a scorecard level. Levels compare in the scorecard's own order, `none` below the first. */
export const LEVEL_OPS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'exists'] as const

/**
 * The search filter. Small on purpose so agents can predict it. `within` and
 * `older` compare a datetime field with a duration back from now: within the
 * last `30d`, older than `90d`. A relation without a target asks whether any
 * is set; `<-relation` or `<-blueprint:relation` asks who points at the entity.
 * `{ scorecard, op, value }` asks for the level the entity reached on a
 * scorecard, in that scorecard's order: `{ scorecard: secure, op: gte, value:
 * Silver }`. An entity outside the scorecard's scope has no level and matches
 * no level condition, `neq` and `lt` included; `exists` asks whether it is in
 * scope. `{ search }` reads the key, the title, and the text inside each
 * field value the reader may see, at any depth, never a field name. `gt`,
 * `gte`, `lt`, and `lte` order as `compare` in filter.ts does: numbers by
 * size before text, text as a person reads it, and a list or an object
 * compares with nothing.
 */
export type Filter =
  | { and: Filter[] }
  | { or: Filter[] }
  | { not: Filter }
  | { field: string; op: (typeof FILTER_OPS)[number]; value?: unknown }
  /**
   * A relation of the entity's own, or who points at it (`<-rel`,
   * `<-blueprint:rel`): set at all, set to one `target`, or, with `where`,
   * reaching an entity that meets `where`, a filter read on the entities it
   * reaches. With `every`, it reaches at least one and every one meets it.
   * None that meet it is the leaf turned round with `not`.
   */
  | { relation: string; target?: string; where?: Filter; every?: boolean }
  | { scorecard: string; op: (typeof LEVEL_OPS)[number]; value?: string | string[] }
  | { relatedTo: string }
  | { state: EntityState }
  | { search: string }

/**
 * What a person or an access token may do beyond reading. Reading is open to
 * everyone who is signed in. The list is fixed: each one guards a set of
 * routes. Roles, which the hub's users define, bundle them.
 */
export const PERMISSIONS = {
  'entities.edit': 'Create, edit, hide, and delete entities',
  'views.arrange': 'Arrange the catalog columns and set the filter a catalog grid opens with',
  'catalog.organize': 'Order the categories blueprints are listed under and the blueprints inside them, hide blueprints from the catalog list, and order the self-service groups and set which start closed',
  'model.edit': 'Change blueprints, relation rules, scorecards, and alert rules, and import models',
  'sources.refresh': 'Ask a git source to read its repository again',
  'sources.manage': 'Register, change, and remove sources',
  'secrets.manage': 'Set and remove the secrets health checks use',
  'tokens.manage': 'Issue and revoke tokens',
  'budgets.set': 'Set the budgets sources, callers, and blueprints are held to',
  'users.manage': 'Define roles and give them to people',
  'audit.view': 'Read the activity log',
  'posture.read': 'Read the security posture: the audiences, the field classes, and who sees, changes, and runs what',
  'access.values': 'Change the values access is decided from: who belongs to a team, what a person owns, the fields an action rule reads such as an environment',
  'actions.report': 'Report on action runs, for the workflows and runners that do the work',
  'actions.approve': 'Approve or decline any run that waits for approval',
  'actions.manage': 'Define and remove self-service actions',
  'actions.list': 'List the actions a named person may run, for a portal that shows each person their own',
  'actions.ask': 'Ask for an action in a named person\'s name, for a product that takes a signed-in person\'s request and has the hub judge it as theirs',
  'tools.lend': 'Call a tool in a named person\'s name, with the tiers one of their runs was granted, for a product whose agent works that person\'s request',
  'tools.read': 'Call any tool of the read tier, for an assistant that only looks',
} as const
export type Permission = keyof typeof PERMISSIONS
export const PERMISSION_IDS = Object.keys(PERMISSIONS) as Permission[]

/**
 * The permissions by what they reach, each with a name short enough for a
 * column head. Every permission is in exactly one family; the full sentence
 * is still `PERMISSIONS`.
 */
export const PERMISSION_FAMILIES: readonly { id: string; title: string; permissions: readonly { id: Permission; short: string }[] }[] = [
  { id: 'catalog', title: 'Catalog', permissions: [{ id: 'entities.edit', short: 'Edit entities' }, { id: 'views.arrange', short: 'Arrange views' }, { id: 'catalog.organize', short: 'Organize catalog' }] },
  { id: 'model', title: 'Model', permissions: [{ id: 'model.edit', short: 'Change the model' }] },
  { id: 'sources', title: 'Sources', permissions: [{ id: 'sources.refresh', short: 'Refresh git' }, { id: 'sources.manage', short: 'Manage sources' }, { id: 'secrets.manage', short: 'Check secrets' }, { id: 'budgets.set', short: 'Set budgets' }] },
  { id: 'access', title: 'Access', permissions: [{ id: 'users.manage', short: 'People and roles' }, { id: 'tokens.manage', short: 'Tokens' }, { id: 'access.values', short: 'Access values' }, { id: 'audit.view', short: 'Activity log' }, { id: 'posture.read', short: 'Security posture' }] },
  { id: 'actions', title: 'Self-service', permissions: [{ id: 'actions.manage', short: 'Define actions' }, { id: 'actions.approve', short: 'Approve runs' }, { id: 'actions.report', short: 'Report on runs' }] },
  { id: 'behalf', title: 'For others', permissions: [{ id: 'actions.list', short: 'List their actions' }, { id: 'actions.ask', short: 'Ask in their name' }, { id: 'tools.lend', short: 'Lend tools' }, { id: 'tools.read', short: 'Read-tier tools' }] },
]

/** The role a person holds on their own person entity, for an edit rule that lets a person describe themselves, or an action rule that lets them act on themselves. No ownership path gives it. */
export const SELF_ROLE = 'self'

/** Whether an action rule lets a person in on their own person entity: only one that names the `self` role does, never `owns: true`. */
export function namesSelf(rule: Pick<ActionRule, 'owns'>): boolean {
  return Array.isArray(rule.owns) && rule.owns.includes(SELF_ROLE)
}

/** The one role the hub defines. It holds every permission, is locked, and reaches a person only through the login proxy. */
export const ADMIN_ROLE = 'admin'

/** A named bundle of permissions, given to people and bound to access tokens. */
export interface RoleDef {
  id: string
  title: string
  description?: string
  permissions: Permission[]
  /** True for the hub's own admin role, which cannot be changed. */
  locked?: boolean
}

/** A person the login proxy has let in at least once. */
export interface User {
  email: string
  /** What the login proxy says of them: an admin holds every permission. */
  admin: boolean
  /** Roles given in the hub. An id no role answers to grants nothing. */
  roles: string[]
  /** Null for a person added here who has not signed in yet. */
  firstSeenAt: string | null
  lastSeenAt: string | null
}

export interface Identity {
  /**
   * A person signed in, or calling with a personal token, is a `user`; a machine access token is a `token`. A `run`
   * is one run's own job, calling with the credential made for that run: it reports on that run, reads it, and
   * reaches nothing else.
   */
  kind: 'user' | 'token' | 'source' | 'run' | 'anonymous'
  name: string
  admin: boolean
  roles: string[]
  permissions: Permission[]
  /** Set for source tokens. */
  source?: string
  /** Set for a run's own credential: the one run it speaks for. */
  run?: string
  /** The personal token a person is calling with. A personal token cannot make tokens. */
  token?: string
  /** Set while an admin views the hub as this person: the identity is theirs, and this names the admin who is really calling. */
  viewAs?: { by: string }
}

export function can(identity: Pick<Identity, 'admin' | 'permissions'> | undefined | null, permission: Permission): boolean {
  return !!identity && (identity.admin || identity.permissions.includes(permission))
}

export const DEFAULT_GRACE: Required<GracePolicy> = { runs: 2, duration: '24h' }
export const MASS_DROP_THRESHOLD = 0.3
export const DELETE_BLOCK_WINDOW = '1h'
export const TOMBSTONE_RETENTION = '90d'

/** Parses `30m`, `24h`, `7d`, `0`, `90s` into milliseconds. */
export function parseDuration(text: string): number {
  const trimmed = text.trim()
  if (trimmed === '0') return 0
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)$/.exec(trimmed)
  if (!m) throw new Error(`Bad duration "${text}": use 90s, 30m, 24h, 7d, 2w, or 0`)
  const n = Number(m[1])
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[m[2] as 'ms' | 's' | 'm' | 'h' | 'd' | 'w']
  return n * unit
}

// Self-service actions ---------------------------------------------------------

/** The kinds of input a person fills in before an action runs: every kind in the registry of `input-kinds.ts`, in its order. */
export type ActionInputType = InputKindName
export const ACTION_INPUT_TYPES = Object.keys(INPUT_KINDS) as [ActionInputType, ...ActionInputType[]]

/**
 * One input of an action's form. A string in `default`, `values`, or any
 * string inside `where` may hold `{{ path }}` over the run's scope, so an
 * input can depend on the entity the action runs on and on the inputs
 * above it: `values: "{{ inputs.workload.fields.images }}"`. Which options
 * and rules a kind takes is the registry's to say.
 */
export interface ActionInputDef extends InputRules {
  type: ActionInputType
  title?: string
  description?: string
  required?: boolean
  default?: unknown
  /** The value is a list: several entities or enum values picked, or for any other kind that takes one, a row per value. */
  many?: boolean
  /** For an `enum`: the allowed values, or a template that renders to a list of them. */
  values?: string[] | string
  /** For an `enum`: how the values are offered. `list` is a menu, or checkboxes for several; `buttons` lays every value out as a button. Left out, `list`. */
  display?: 'list' | 'buttons'
  /** For an `entity`: the blueprint to pick from, or several. A `person` names none: it picks from the blueprint the person setting names. */
  blueprint?: string | string[]
  /**
   * The input narrows the entity the action runs on: it names a relation of
   * the target, for an input that picks an entity, or a field, for any other. It is asked
   * before the target, whose options are then the ones it points at or holds.
   * Run from an entity, the input is filled from it.
   */
  narrows?: string
  /** For an input that picks an entity: only entities this filter matches may be picked. */
  where?: Filter
  /** For an input that picks an entity: the order the options are offered in, `field` or `-field` as the search sorts, such as `-pushed_at` for newest first. Left out, by title. */
  sort?: string
  /**
   * What the entity holds now, as a template. For an input that picks an
   * entity: its value, or values, name the option in use now, by id, key, or
   * title, so the form can mark it: `"{{ entity.fields.images }}"` marks the
   * version a workload runs. For a list of a kind that does not pick: the list
   * the input changes, such as `"{{ entity.fields.allowed_origins }}"`. The
   * form starts from it without a `default` and is confirmed against it, the
   * hub keeps it on the run as it rendered when the run was asked for
   * (`current` on the run, `run.current.<input>` in the scope), and refuses a
   * run that changes nothing (`src/shared/list-change.ts`).
   */
  current?: string
  /**
   * The input is asked only when this filter matches the inputs above it:
   * each of them is a field by its own name, holding the checked value given
   * (an entity picked reads as its id), or nothing when it was empty or not
   * asked itself. An input not asked is not required, not checked, and
   * stored empty; a value sent for it is dropped.
   */
  when?: Filter
  /**
   * The input is worked out, never asked: an expression in the calculation
   * language over the inputs above it, by name. The hub works it out at every
   * request and takes no value for it from whoever asks.
   */
  value?: string
  /** For a value of text or a number: no active entity of this blueprint may already hold it in this field (`key`, `title`, or a field of the blueprint). Text is compared without regard to case. */
  unique?: InputUnique
  /** For an input that picks an entity: fields of each option shown under its title, at most four. A field the reader may not see is left out. */
  show?: string[]
}

/** Where a `unique` input's value must not be held yet. */
export interface InputUnique {
  blueprint: string
  field: string
}

/** The most fields an input shows under each option. */
export const SHOW_MAX = 4

/** One titled group of an action's inputs, in the form's order. */
export interface ActionSection {
  title: string
  description?: string
  inputs: string[]
}

/**
 * Who does the work. The hub never runs a command: it renders a payload and
 * hands it over. Every string in a backend is rendered over the run's scope.
 */
export type ActionBackend =
  /**
   * Decides the hub's own approval an entity of the approvals blueprint
   * stands for (Access, approvals): approves or declines the run or schedule
   * its key names, as the person who ran the action, judged as their own
   * decision would be. `note` is rendered and given as why.
   */
  | { type: 'decide'; verdict: 'approve' | 'decline'; note?: string }
  /**
   * Pauses, resumes, or fires now the action schedule an entity of the hub's
   * schedule blueprint stands for, as the person who ran the action, judged
   * as their own change on the Schedules page would be.
   */
  | { type: 'schedule'; verb: 'pause' | 'resume' | 'run' }
  /**
   * Makes, changes, publishes, or previews one of the hub's reports, as the
   * person who ran the action, judged as theirs: the report's owner, someone
   * who owns its home, or an admin. `create` runs on nothing and makes a
   * report owned by whoever asked; every other verb runs on a report. Each
   * reads its inputs by fixed names (`REPORT_INPUTS` in `reports.ts`).
   * `publish` keeps the next edition and sends it; `preview` draws it from
   * the newest data and keeps it with the run alone.
   */
  | { type: 'report'; verb: 'create' | 'edit' | 'recipients' | 'hand' | 'remove' | 'publish' | 'preview' }
  /**
   * Sends the rendered `body`, or the run payload when there is none. `secretRef` names a hub secret sent as a bearer
   * token. `onBehalf` names a delegate the hub is set up with instead: the call then carries a token the issuer made
   * for that API in a person's name, so the API decides and logs as it would for them. Such a run
   * starts only from a person's own signed-in request and runs as them: the asker's, or, for a run that waits for
   * approval, the approval that starts it, so it runs as that approver. `finish: answer` ends the run on the answer: a 2xx
   * succeeds it, for an API that does the work before it answers and reports nothing after. `finish: reveal` ends it
   * the same way for an answer that is a secret: the answer goes to the person who asked, on the answer to their
   * own request, and is never kept. `query` is rendered and added to the URL, each value encoded; one that renders
   * to nothing is left out. A `GET` carries no body. `timeout` is how long the hub waits for the answer (15m when
   * left out, never past how long a run may go unheard from); a call that gets none in time ends the run as `unknown`.
   */
  | { type: 'webhook'; url: string; method?: 'GET' | 'POST' | 'PUT' | 'DELETE'; query?: Record<string, string>; headers?: Record<string, string>; secretRef?: string; onBehalf?: string; finish?: 'answer' | 'reveal'; timeout?: string; body?: unknown }
  /** A `workflow_dispatch` on GitHub, with `inputs` rendered. `secretRef` names a hub secret holding a token with Actions write on the repository. */
  | { type: 'github_workflow'; owner: string; repo: string; workflow: string; ref?: string; inputs?: Record<string, string>; secretRef: string }
  /** A job the runner source named claims and executes: `command` is argv, `timeout` a duration such as `10m`. */
  | { type: 'runner'; runner: string; command: string[]; env?: Record<string, string>; timeout?: string }
  /**
   * Writes one entity of the catalog as the named `source`, which must be registered for `blueprint`, and
   * succeeds the run. `key`, `title`, and every field and relation are rendered. `enrich` writes only an entity
   * that exists. It never writes what access is decided from.
   */
  | { type: 'record'; source: string; blueprint: string; key: string; mode?: 'upsert' | 'enrich'; title?: string; fields?: Record<string, unknown>; relations?: Record<string, unknown> }
  /**
   * The person or tool that asked carries the run out itself, and reports
   * into it: the hub hands nothing off. Approved, the run waits for them to
   * start it; one nobody starts within the hub's timeout is cancelled. Once
   * started it is given up when it is not heard from for `timeout`, such as
   * `6h`, or for the hub's own when it names none.
   */
  | { type: 'caller'; timeout?: string }
  /**
   * One container for the run, started on the estate's own platform by the
   * `starter`: a runner source the estate runs, which claims the run the
   * moment it is approved, starts the job, says while it runs that it does,
   * and reports how its container ended. Nothing of whoever asked has to be
   * awake. `template` names one of the starter's own job templates: where the
   * job runs and as what is the estate's to say there, never the action's.
   * It is a fixed name, or one the entity the run is on gives from fields
   * that are locked (`jobTemplate` in `action-spec.ts`), so nobody who may
   * run the action chooses it.
   * `image`, `command`, `args`, and `env` are rendered, and the starter
   * refuses an image its template does not allow. The job is handed a
   * credential good for its own run alone.
   */
  | { type: 'job'; starter: string; template: string; image: string; command?: string[]; args?: string[]; env?: Record<string, string> }

/**
 * Who may run an action. An admin always may. `everyone` opens it to anyone
 * signed in. Otherwise the grants decide, the same grants that decide who
 * sees a blueprint: a path from the person's own entity, a field read at its
 * end, and the values that let them in; a grant with no path names people
 * by their sign-in address, or a machine token by its name. `home` opens it
 * to the people who own the action's home. Without `access`, only an admin
 * runs it.
 */
export interface ActionAccess {
  everyone?: boolean
  grants?: AccessGrant[]
  /** Named audiences that may run it, besides the grants. */
  audiences?: string[]
  /**
   * Whoever owns the action's `home` may run it, on everything it runs on:
   * `true` for theirs in any way, or the roles of the person setting's `owns`
   * paths, such as `owner`. It needs a `home`.
   */
  home?: true | string[]
  /** Who may run it on which entity: each rule lets in on the entities it takes. Any rule that lets a person in on an entity is enough. */
  rules?: ActionRule[]
  /**
   * The tool tiers that come with the action: whoever may ask for it on an
   * entity holds these tiers there, whether or not their run would wait for
   * approval. A run may ask for more, and then waits for someone who holds them.
   */
  tiers?: ToolTier[]
}

/**
 * One way a person may run an action on its entities. Every part it gives
 * must hold. `audiences` and `grants` say who the person is, as the action's
 * own do; given neither, anyone signed in. `require` narrows that: every
 * grant in it must let the person in too, such as a program's team and one
 * of the teams that do the work. `owns` says what they must be to
 * the entity: `true` for theirs in any way, or the roles of the person
 * setting's `owns` paths, such as `owner` or `qa`, or `self` for their own
 * person entity, which counts only for a rule that names it; a rule that asks it
 * lets in only someone who owns something the action runs on. `where` is what the entity
 * must be, such as in production. `approval` holds the run when this rule is
 * the best one that lets them in: `true` for someone else to approve, `'self'`
 * for the person to approve themselves, once they have read what they asked
 * for. A rule with no approval beats one with `'self'`, which beats `true`.
 */
export interface ActionRule {
  audiences?: string[]
  grants?: AccessGrant[]
  /** Grants the person must also meet, every one, besides `audiences` and `grants`. */
  require?: AccessGrant[]
  /** People, by sign-in address, this rule never lets in, whatever else it says: a team but for one of its members. Another rule may still let them in. */
  except?: string[]
  owns?: true | string[]
  where?: Filter
  approval?: boolean | 'self'
}

/** What an action's tool is: its tier, and the entity it was declared from, as `blueprint:key`, such as the repository whose file holds it. */
export interface ActionTool {
  tier: ToolTier
  from?: string
}

/** The kinds of value a dataset's column holds. */
export const DATASET_TYPES = ['string', 'number', 'boolean', 'datetime'] as const

/** One column a dataset answers with. A value is read as its type; `string` when none is given. */
export interface DatasetColumn {
  id: string
  title?: string
  type?: (typeof DATASET_TYPES)[number]
}

/** What makes a read tool a dataset: the columns it answers with, the entity it is called on, and how long an answer is kept. */
export interface ActionDataset {
  /** The entity the tool is called on, as blueprint:key, when the tool runs on a blueprint: the catalog's record of what the dataset reads. */
  entity?: string
  columns: DatasetColumn[]
  /** How long an answer is kept before the tool is called again, such as `15m`. Left out: `DATASET_FRESH`. */
  fresh?: string
}

/** How long a dataset's answer is kept when it does not say. */
export const DATASET_FRESH = '15m'

/** What a query's source is named when it reads a dataset: this, then the dataset's action id. */
export const DATASET_PREFIX = '$data:'

/** The action id of the dataset a query source names, or null when it names a blueprint. */
export function datasetOf(source: string): string | null {
  return source.startsWith(DATASET_PREFIX) ? source.slice(DATASET_PREFIX.length) : null
}

/**
 * A dataset as the query code reads a blueprint: its columns as fields, no
 * relations. So a column is picked, typed, filtered, and added up exactly as
 * a field is, by the same code.
 */
export function datasetBlueprint(d: { id: string; title: string; description?: string | null; icon?: string | null; columns: readonly DatasetColumn[] }): Blueprint {
  return { id: `${DATASET_PREFIX}${d.id}`, title: d.title, ...(d.description ? { description: d.description } : {}), icon: d.icon ?? 'database', fields: Object.fromEntries(d.columns.map((c) => [c.id, { type: c.type ?? 'string', title: c.title ?? c.id }])), relations: {} } as Blueprint
}

/** The blueprints an action runs on: none for one that runs anywhere. */
export function actionTargets(a: Pick<Action, 'blueprint'>): string[] {
  return a.blueprint === undefined ? [] : Array.isArray(a.blueprint) ? a.blueprint : [a.blueprint]
}

/** The blueprints an entity input names. */
export function inputBlueprints(def: Pick<ActionInputDef, 'blueprint'>): string[] {
  return def.blueprint === undefined ? [] : Array.isArray(def.blueprint) ? def.blueprint : [def.blueprint]
}

/**
 * The blueprints an input picks entities from: the ones it names, or for a
 * kind that picks a person, the one the person setting names, given as
 * `person`. None for a kind that picks no entity, and none for a person
 * while the estate has not said who a person is.
 */
export function inputPicks(def: Pick<ActionInputDef, 'type' | 'blueprint'>, person: string | null | undefined): string[] {
  const kind = kindOf(def.type)
  if (kind.picks !== 'entity') return []
  return kind.person ? (person ? [person] : []) : inputBlueprints(def)
}

/** The inputs that narrow an action's target, in their order: the form asks them before the target. */
export function narrowingInputs(a: Pick<Action, 'inputs'>): string[] {
  return Object.keys(a.inputs).filter((name) => a.inputs[name]!.narrows)
}

/**
 * A self-service action: a form a person fills, and a backend that does the
 * work. With a `blueprint`, or several, the action runs on one entity of
 * them, and `where` narrows which; without one it is a global action.
 */
export interface Action {
  id: string
  title: string
  description?: string
  /** A name from the icon set. */
  icon?: string
  /** A heading the action is listed under: a project, a team's concern, whatever the estate calls it. */
  group?: string
  /**
   * The entity the action belongs to, as `blueprint:key`: one of any
   * blueprint, such as the program or the team it serves. The action is
   * listed under it, in place of its `group`. Only an admin sets it.
   */
  home?: string
  blueprint?: string | string[]
  /** What it runs on must meet this. `@me` and the day names are read for whoever asks, as in any filter. It binds everyone, an admin too. */
  where?: Filter
  /**
   * True: it runs only on the caller's own person, the entity the person
   * setting finds for whoever signs in, and on nothing for anyone who has
   * none. It binds everyone, an admin too, as `where` does. Who may run it
   * there is still its `access`.
   */
  self?: true
  inputs: Record<string, ActionInputDef>
  backend: ActionBackend
  /** The run waits until someone other than the requester approves it. */
  approval?: boolean
  /**
   * The person who asked may approve their own run, when they may approve it
   * at all. The run still says who asked and who approved. For an estate with
   * one approver; turn it off once there is a second.
   */
  selfApproval?: boolean
  /** The form shows the person everything they filled in, to check, before the run is asked for. For an action that is hard to undo. */
  confirm?: boolean
  /** false: no form anywhere. Only a tool starts it, on the machine port; its runs and approvals show as any other's. */
  form?: boolean
  /**
   * false: run only from what it runs on: a row of its blueprint, an entity's
   * page, or a tick of several. It has no tile on the Self-service page or on
   * its home's page, and cannot be pinned. It needs a blueprint.
   */
  listed?: boolean
  /**
   * Runs on the same entity with the same values of these inputs are one
   * line: a newer request cancels one still waiting for approval, asking
   * again for exactly what still waits gives back the waiting run, and only
   * one of the line runs at a time. An empty list makes the entity alone the
   * line. Only for a runner or a caller backend, whose start the hub sees.
   */
  serial?: string[]
  /**
   * The most runs of the action in flight at once, on any entity, across
   * every batch and single run. The rest stay `queued`, oldest first (a run
   * asked for alone before a run of a batch), and start as earlier ones end.
   * Nothing is replaced or dropped. Only for a backend whose end the hub
   * sees: a runner, a job, a webhook, a caller, or a workflow.
   */
  concurrency?: number
  /**
   * The longest a run may stay running, however often it is heard from, as
   * a duration such as `12h`. A run lives by being heard from: it is given
   * up once it has been silent for the hub's time, whatever this says. Left
   * out, a job's run is ended after `JOB_CEILING` and any other has none. A
   * runner's job is ended by its runner at its own `timeout`, so it takes
   * none.
   */
  ceiling?: string
  /**
   * The fields of the entity it runs on that a run may write back once it
   * succeeds: what the run changed in the world, so the catalog shows it before
   * the source that reads it comes round again. The backend hands each back on
   * a `::refresh:: <field>=<json>` line; the hub writes it as the entity's
   * owning source, which the next write of that source replaces as usual.
   */
  refreshes?: string[]
  /**
   * More than one person must approve before the run starts: `need` of them, each a different person the action lets decide
   * it. Left out, one approval is enough. A decline from anyone ends the run at once. It is a policy object, not a bare number,
   * so a rule such as "one from each of these teams" can be added beside `need` without moving what exists.
   */
  quorum?: { need: number }
  /**
   * The action may run on many entities at once: a person picks them from a
   * grid, sees every one before anything is sent, and each gets its own run,
   * judged by the same rules as a run asked for alone. `max` is the most one
   * batch holds, `BATCH_MAX` at most.
   */
  batch?: { max: number }
  /**
   * A run that fails is tried again, in the same run, up to `tries` times in
   * all: after `backoff`, then three times that, and so on, each with up to a
   * fifth more at random so many retries do not land at once. A failure the
   * backend calls final (a `::final::` line) is the answer and is never tried
   * again, and neither is one the hub decides itself: a run that timed out
   * may still be going, and one that cannot be rendered never will be. Only
   * for a backend the hub can hand the run to again: a runner, a webhook, or
   * a workflow.
   */
  retry?: ActionRetry
  /**
   * People may schedule the action: ask it again and again on a cadence, as
   * themselves, once someone who decides approvals approves the schedule. `min`
   * is the shortest gap between two firings a schedule of it may ask for.
   */
  schedule?: { min: string }
  /** The form's headings: each names the inputs under it. An input no section names goes under a last one with no heading. */
  sections?: ActionSection[]
  /** The form asks one section at a time, as steps. It needs `sections`. */
  walk?: boolean
  access?: ActionAccess
  /**
   * Makes the action a tool: a command an agent calls and gets the answer
   * from in the same call. It has no form, no approval, and no access of its
   * own: whoever holds its tier on the entity may call it. Runner backend only.
   */
  tool?: ActionTool
  /**
   * Makes a read tool a published dataset: a table a saved query may read
   * beside the catalog. The tool is called with no inputs and answers its
   * rows as JSON; `access` says who may read it, as on any action, beside
   * whoever holds its tier.
   */
  dataset?: ActionDataset
  origin: ActionOrigin
  updatedAt: string
}

export type { BatchWidth } from './estimate.ts'

/** The most entities one batch of an action may hold, whatever the action says. */
export const BATCH_MAX = 50_000
/** The most people one quorum asks for. */
export const QUORUM_MAX = 5
/** How many of a batch's entities, and of those it would skip, a preview names; it counts all of them. */
export const PREVIEW_LISTED = 500
/** The most runs one change set holds: each is judged, listed, and approved one by one, so a set stays what a person reads through. */
export const CHANGE_SET_MAX = 500

/** How an action's failed runs are tried again: `tries` in all, the first wait `backoff` (a duration, such as 5s). */
export interface ActionRetry {
  tries: number
  backoff: string
}

/** The shortest gap between two firings any schedule may ask for, whatever its action says. */
export const SCHEDULE_MIN_MS = 60 * 60_000

/** The most tries a run gets, whatever its action says. */
export const RETRY_TRIES_MAX = 5
/** The longest first wait an action may ask for between tries. */
export const RETRY_BACKOFF_MAX_MS = 10 * 60_000

/** How long a run waits after its `failed`th failed try: `backoffMs`, three times longer after each try, and up to a fifth more at random. */
export function retryWait(backoffMs: number, failed: number, random: () => number = Math.random): number {
  const base = backoffMs * 3 ** (failed - 1)
  return Math.round(base + random() * (base / 5))
}

/** What an action's runs say of it, over all of them: a fact of the action that names no entity. */
export interface ActionStats {
  /** The median time, started to finished, of its newest runs that worked. Null until three of them have. */
  usualSeconds: number | null
  /** The mean time, started to finished, of its newest runs that ended, failed ones too: what each run of a batch costs when none of its runs had the batch's inputs. Null until three have. */
  meanSeconds: number | null
  /** How many of its newest runs that ended in success or failure failed, one after another. */
  failedInARow: number
}

/** The icon of an action that has none of its own and no one blueprint to borrow from. */
export const ACTION_ICON = 'rocket'

/** The home of an action or a saved query, the one entity it belongs to, as one reader sees it. */
export interface Home {
  /** The home's entity id, `blueprint:key`. */
  id: string
  entity: EntityRef
  title: string
  /** The home's icon: its own, else its blueprint's. */
  icon: string | null
  /** Whether the reader owns the home, in any way the person setting's `owns` paths say. */
  yours: boolean
}

/** An action as a reader gets it: with whether they may run it. */
export interface ActionView extends Action {
  canRun: boolean
  /** The newest run the reader may see, or null when there is none. */
  lastRun: { id: string; state: ActionRunState; at: string } | null
  /** The icon to draw it with: its own, else its home's, else its one blueprint's, else `ACTION_ICON`. `icon` stays what its definition says. */
  iconShown: string
  stats: ActionStats
  /**
   * Its home as the reader sees it, or null when it has none, the home is
   * gone, or the reader may not see it. `home` stays what its definition
   * says, and is left out for a reader who may not see the home's blueprint.
   */
  homeShown?: Home | null
  /** Whether the reader pinned it. Only a person pins, so it is absent for a machine. */
  pinned?: boolean
}

/** What a person may pin to the top of their own pages: an action on the self-service page, a blueprint on the catalog's list. */
export const PIN_KINDS = ['action', 'blueprint'] as const
export type PinKind = (typeof PIN_KINDS)[number]

/** One thing a person pinned: the id of something of that kind. */
export interface Pin {
  kind: PinKind
  id: string
}

/** The most pins of one kind one person keeps: pins are a shelf drawn whole. */
export const MOST_PINS = 50

export type ActionInput = Omit<Action, 'origin' | 'updatedAt'>

/**
 * `awaiting` waits for approval; `queued` waits for whoever starts it (its
 * runner, or the person who asked); `cancelled` never started: withdrawn,
 * replaced by a newer request, or left unstarted too long; `returned` was
 * sent back with a note by whoever could have approved it, for the asker to
 * ask again; `unknown` was handed to its backend, and the hub stopped
 * waiting before it heard how it ended: it is no failure, it is never tried
 * again, and its backend may still report how it ended. The rest are what the
 * backend reported.
 */
/** How long a job's run may stay running when its action names no `ceiling`. */
export const JOB_CEILING = '7d'

export const ACTION_RUN_STATES = ['awaiting', 'queued', 'running', 'succeeded', 'failed', 'unknown', 'declined', 'cancelled', 'returned'] as const
export type ActionRunState = (typeof ACTION_RUN_STATES)[number]

export function isFinished(state: ActionRunState): boolean {
  return state === 'succeeded' || state === 'failed' || state === 'unknown' || state === 'declined' || state === 'cancelled' || state === 'returned'
}

/** One time an action was asked for, and what came of it. */
/** Whose approval a run waits for: its asker's alone, or someone else's. */
export type HeldFor = 'self' | 'others'

export interface ActionRun {
  id: string
  action: string
  entity: EntityRef | null
  /** The title of the entity it is on, as the hub reads it now. Null when that entity is gone. */
  entityTitle?: string | null
  inputs: Record<string, unknown>
  /** The titles of the entities its inputs name, by entity id, as the reader may read them now. One the reader may not see, or that is gone, is absent. */
  inputTitles?: Record<string, string>
  /**
   * For each input that edits a list the entity holds (`current` on a list),
   * that list as the hub rendered it when the run was asked for, by input
   * name: what the run's change is read against, kept as it was whatever the
   * entity holds later. Absent when the action has no such input; a hub one
   * release back sends none.
   */
  current?: Record<string, unknown[]>
  /** Who asked. */
  by: string
  state: ActionRunState
  /** What the backend says it is doing, in its own words. */
  label: string | null
  /** Where to watch it: a workflow run, a pipeline, a ticket. */
  link: string | null
  summary: string | null
  /** Each line under the step that was under way when it came. A line of the hub's own carries none. */
  log: RunLine[]
  /** The steps the backend named, in the order they started. */
  steps: RunStep[]
  /** The values the backend chose to report, by name. Whoever may see the run sees them. */
  outputs: Record<string, OutputValue>
  /** The runner that took the job. */
  claimedBy: string | null
  /** Who approved or declined it, and when. Null until someone does. */
  decidedBy: string | null
  decidedAt: string | null
  /** On a run awaiting approval: whether the reader may approve or decline it. */
  canDecide?: boolean
  /** The tool tiers the run asked for, beyond what its action carries. Approving it grants them to the run. */
  tiers: ToolTier[]
  /** The run this one asks again for, after that one was sent back. */
  revises: string | null
  /** How many people must approve it before it starts: one unless its action has a `quorum`. A hub one release back sends none, which reads as one. */
  approvalsNeeded?: number
  /** Who has approved it so far, in order, while it waits for the rest. */
  approvedBy?: { by: string; at: string }[]
  /** The batch it was asked in, when it was one of many asked at once. */
  batch?: string | null
  /** The change set it was asked in, which is decided as one; a hub one release back sends none. */
  changeSet?: string | null
  /** The try under way, or the last one, counting from 1. A run is only tried again when its action has a `retry`. */
  attempt: number
  /** The schedule that asked for it, when one did. */
  schedule?: string | null
  /**
   * What the hub wrote back on the entity once the run succeeded, field by field, with the value each held before:
   * only the fields its action `refreshes`, and only those the reader may see. Absent while nothing was written back;
   * a hub one release back sends none.
   */
  wroteBack?: WroteBack[]
  /** When the hub last heard from it: its start, a report from its backend, or word from whatever watches its job. A run not heard from for the hub's time is given up. A hub one release back sends none. */
  heardAt?: string | null
  /** On a run under way: whether the reader may stop it. Only a run whose job the hub can have stopped is. A hub one release back sends none. */
  canStop?: boolean
  /** The names of the pictures it reported, each read alone at `/v1/action-runs/{id}/outputs/{name}`; `outputs` holds the rest. */
  images: string[]
  /** While a failed try waits to be tried again: when the next try is due. */
  retryAt: string | null
  /** What whoever decided it wrote: why they approved or declined it, or what to change when they sent it back. */
  note: string | null
  /**
   * Whose approval it waits for, from the moment it is asked: `self` when the rule that let its asker in holds it for
   * their own approval alone, `others` when someone else decides it. Null for a run that never waited, or one asked
   * before the hub kept it; a hub one release back sends none.
   */
  heldFor?: HeldFor | null
  /** Who the product that asked for it named to decide it, as grants: only someone they let in decides it. Null when it named nobody. */
  approvers?: AccessGrant[] | null
  /** The person a product asked it for, when the product asked as itself: data on the run, never its asker or a decider. A hub one release back sends none. */
  requestedFor?: string | null
  /**
   * Where the person who asked called from, as the hub read it from the request through the proxy header it trusts:
   * only on a run a person asked for themselves, signed in. A schedule's, a batch's, a product's, and a token's run hold none.
   */
  byAddress?: string | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  /**
   * What the backend answered, for a webhook that ends on `finish: reveal`: only on the answer to the request
   * that started the run. The hub keeps it nowhere, so no later read of the run has it.
   */
  told?: string
}

/** One field a run wrote back on the entity it ran on: what it held before, and what the run handed back. */
export interface WroteBack {
  field: string
  was: unknown
  now: unknown
}

/** Reserved field carried by every blueprint. */
export const TITLE_FIELD = 'title'
/** Reserved field carried by every blueprint: the entity's own icon. The blueprint's icon is its default. */
export const ICON_FIELD = 'icon'
