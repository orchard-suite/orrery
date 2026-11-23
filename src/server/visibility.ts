// Who sees what. A blueprint or a field may carry an access rule; a signed-in
// person sees it when a grant reads one of its values from their own person
// entity. An admin, a machine access token, and a source see everything. Every
// read that carries entity data passes through the `View` built here, and
// every change a person makes is checked against it.

import { timed } from './metrics.ts'
import { fieldOf, parsePath, scorecardsIn, splitMirror } from '../shared/filter.ts'
import { templateReads } from '../shared/action-spec.ts'
import { actionTargets, checksOf, addressKey, entityId, isDerived, ICON_FIELD, namesSelf, SELF_ROLE, TITLE_FIELD, inheritCases, inheritPaths, inputPicks, ownsPaths, type AccessGrant, type OwnsPath, type ActionRule, type RelationRule, type AccessRule, type Action, type ActionRun, type Blueprint, type Change, type Entity, type EntityDetail, type EntityRef, type FieldDef, type FieldProvenance, type Filter, type Finding, type Identity, type PersonSetting, type PersonShown, type RelatedRef, type RelationEnd } from '../shared/model.ts'
import type { Alert, AssignedCheckView, ColumnDistribution, Scorecard } from '../shared/api.ts'
import { actionGrants, actionGrantLists, audienceGrants, blueprintGrants, classFor, editCovers, editRulesFor, EMPTY_POLICY, ownedCounts, type EditRule, fieldRule, normalizePolicy, opensToOwners, policyGrants, policyProblems, resolveRule, withCurrentIds, type AccessPolicy, type ClassOwned, type PolicyState } from '../shared/policy.ts'
import { partFilters, partsOf } from '../shared/scorecard.ts'
import type { Blueprints } from './blueprints.ts'
import type { Db } from './db.ts'
import type { Events } from './events.ts'
import type { Logger } from './log.ts'
import { equal } from './values.ts'
import { Ownership } from './ownership.ts'
import type { Reader } from './read.ts'
import { parseWhere } from './rules.ts'

export const PERSON_KEY = 'access.person'
export const POLICY_KEY = 'access.policy'

/** What a person reads and may change. One is built per request, and cached per person until something it reads changes. */
/** A field a class opens to owners, and who the reader is for it: `ids` are the entities they own in a role the class counts; `through` the relations through which owning the target counts. */
export interface OpenedField {
  field: string
  ids: string[]
  through: string[]
}

export interface View {
  /** True for an admin, a machine token, a source, and a hub that signs nobody in: nothing is withheld. */
  readonly all: boolean
  readonly admin: boolean
  /** What this view was decided from: the same object until something that decides what the reader sees moves. */
  readonly basis: object
  /** Whether the reader sees every entity of a blueprint. */
  seesBlueprint(id: string): boolean
  /** The entities of a blueprint the reader sees only because its rule opens them to their owners, by id; null when they see all of it, or none. */
  ownedOnly(blueprint: string): ReadonlySet<string> | null
  /** The entities of a blueprint the reader sees only because its rule's `subjects` name something they see, by id; null when they see all of it, or its rule names no subjects. */
  aboutOnly(blueprint: string): ReadonlySet<string> | null
  /** The entities of a blueprint the reader sees one by one, as theirs or as about what they see, by id; null when they see all of it, or none that way. */
  oneByOne(blueprint: string): ReadonlySet<string> | null
  /** Whether the reader sees any of a blueprint: all of it, or the entities of it they see one by one. */
  seesSome(blueprint: string): boolean
  /** Whether the reader sees one entity: its whole blueprint, or it one by one. */
  seesEntity(ref: EntityRef): boolean
  /** Whether a rule the model already holds lets this reader in; no rule lets everyone in. */
  lets(rule: AccessRule | undefined): boolean
  /** Whether the reader may read the timeline of a blueprint's entities, as its `timeline` rule says; no rule, whoever sees the entity. */
  readsTimeline(blueprint: string): boolean
  /** The fields of a blueprint this reader may not see on every entity, derived fields that read them included. */
  hiddenFields(blueprint: string): ReadonlySet<string>
  /** Of those, the ones a class opens on the entities the reader owns: shown there, and blank everywhere else. */
  ownerOpened(blueprint: string): ReadonlySet<string>
  /** The fields of a blueprint the reader is shown only as a summary: an aggregation marked `summary` that reads what they may not see. Its number is theirs, and nothing of what it reads. */
  summaries(blueprint: string): ReadonlySet<string>
  /** Each opened field with how an entity is the reader's for it: the ids they own in a role the class counts, and the relations through which owning a target counts too. What a query tests per row in SQL. */
  openedTo(blueprint: string): OpenedField[]
  /** Drops entities of blueprints the reader may not see, and withholds what it may not read of the rest. */
  entities(list: Entity[]): Entity[]
  entity(e: Entity): Entity | null
  detail(d: EntityDetail): EntityDetail | null
  changes(rows: Change[]): Change[]
  findings(list: Finding[]): Finding[]
  alerts(list: Alert[]): Alert[]
  checks(list: AssignedCheckView[]): AssignedCheckView[]
  distribution(blueprint: string, d: Record<string, ColumnDistribution>): Record<string, ColumnDistribution>
  /** Null when the filter reads only what the reader may see on every entity; else what it reads that is withheld. For what is judged on every entity at once, such as a scorecard. */
  refusedFilter(blueprint: string | undefined, f: Filter): string | null
  /**
   * The same for a list the reader asks for, filtered and sorted on what the
   * view left of each row: a field opened on the rows they own may be read,
   * since it is blank on every other row by then.
   */
  refusedQuery(blueprint: string | undefined, f: Filter): string | null
  /** An action is seen when the reader may see every blueprint it runs on or picks from. */
  seesAction(a: Action): boolean
  /** A run is seen when the reader may see its action and the entity it ran on. */
  runs(list: ActionRun[]): ActionRun[]
}

/**
 * How a reader who does not see a whole blueprint sees some of it, for its
 * description: their own (`onlyYours`), what is about what they see
 * (`onlyAbout`), or both. Nothing for a blueprint they see whole.
 */
export function seenPartly(view: Pick<View, 'seesBlueprint' | 'aboutOnly'>, blueprint: Blueprint): { onlyYours?: true; onlyAbout?: true } {
  if (view.seesBlueprint(blueprint.id)) return {}
  const about = !!blueprint.access?.subjects?.length && (view.aboutOnly(blueprint.id)?.size ?? 0) > 0
  return { ...(blueprint.access?.owners || !about ? { onlyYours: true as const } : {}), ...(about ? { onlyAbout: true as const } : {}) }
}

/** Blueprints only an admin changes: the ones marked so, the person blueprint, and every blueprint a grant's path reads through, an action's grants included. */
export function adminOnlyBlueprints(blueprints: Blueprint[], person: PersonSetting | null, actions: Action[] = [], policy: AccessPolicy = EMPTY_POLICY): Set<string> {
  const byId = new Map(blueprints.map((b) => [b.id, b]))
  const out = new Set<string>(blueprints.filter((b) => b.adminEdit).map((b) => b.id))
  if (!person || !byId.has(person.blueprint)) return out
  out.add(person.blueprint)
  const paths = new Set<string>()
  for (const bp of blueprints) for (const g of blueprintGrants(bp)) if (g.path) paths.add(g.path)
  for (const a of actions) for (const g of actionGrantLists(a.access)) if (g.path) paths.add(g.path)
  for (const g of policyGrants(policy)) if (g.path) paths.add(g.path)
  // An inherited relation on a blueprint that decides access reads its own path, so that path decides access too.
  const walk = (from: string, path: string, seen: Set<string>): void => {
    let hops
    try {
      hops = parsePath(path)
    } catch {
      return
    }
    let at: Blueprint | undefined = byId.get(from)
    for (const hop of hops) {
      if (!at) return
      if (hop.incoming) {
        const declaring = hop.from ? [byId.get(hop.from)].filter((b): b is Blueprint => !!b) : blueprints.filter((b) => b.relations[hop.relation]?.target === at!.id)
        for (const d of declaring) {
          out.add(d.id)
          inherit(d, hop.relation, seen)
        }
        at = hop.from ? byId.get(hop.from) : undefined
      } else {
        const rel = at.relations[hop.relation]
        if (!rel) return
        inherit(at, hop.relation, seen)
        at = byId.get(rel.target)
      }
      if (at) out.add(at.id)
    }
  }
  const inherit = (bp: Blueprint, relation: string, seen: Set<string>): void => {
    const rel = bp.relations[relation]
    const key = `${bp.id}.${relation}`
    if (!rel?.inherit || seen.has(key)) return
    seen.add(key)
    for (const path of inheritPaths(rel)) walk(bp.id, path, seen)
  }
  for (const path of paths) walk(person.blueprint, path, new Set())
  return out
}

/**
 * The fields and relations, by blueprint, that decide who may do what: every
 * field marked only an admin changes, every relation or field a grant's path
 * reads, everything an action's filter and its rules' filters read on what it
 * runs on, and the paths of what a person owns once a rule asks for it, with
 * what fills each of those. A source that does not own an entity may not
 * write one of these on it, and a person changes one only as an admin or
 * with `access.values`. With `grants`, only what decides who a person is or
 * what a job runs as: the marked fields, what grants read, and the fields a
 * job action's template reads on what it runs on.
 */
export function accessNames(blueprints: Blueprint[], person: PersonSetting | null, actions: Action[] = [], policy: AccessPolicy = EMPTY_POLICY, relationRules: RelationRule[] = [], scope: 'all' | 'grants' = 'all'): Map<string, Set<string>> {
  const byId = new Map(blueprints.map((b) => [b.id, b]))
  const out = new Map<string, Set<string>>()
  const add = (bp: string, name: string) => {
    let names = out.get(bp)
    if (!names) out.set(bp, (names = new Set()))
    names.add(name)
  }
  for (const bp of blueprints) for (const [name, def] of Object.entries(bp.fields)) if (def.adminEdit) add(bp.id, name)
  // A job's template names what the job runs as, so what it reads on the entity decides that for whoever may run the action.
  for (const a of actions) if (a.backend.type === 'job') for (const name of templateReads(a.backend.template)) for (const target of actionTargets(a)) add(target, name)
  const grants: AccessGrant[] = []
  for (const bp of blueprints) grants.push(...blueprintGrants(bp))
  for (const a of actions) grants.push(...actionGrantLists(a.access))
  grants.push(...policyGrants(policy))
  if (person && byId.has(person.blueprint)) {
    for (const g of grants) {
      let at: Blueprint | undefined = byId.get(person.blueprint)
      let hops
      try {
        hops = g.path ? parsePath(g.path) : []
      } catch {
        continue
      }
      for (const hop of hops) {
        if (!at) break
        if (hop.incoming) {
          const declaring = hop.from ? [byId.get(hop.from)].filter((b): b is Blueprint => !!b) : blueprints.filter((b) => b.relations[hop.relation]?.target === at!.id)
          for (const d of declaring) add(d.id, hop.relation)
          at = hop.from ? byId.get(hop.from) : undefined
        } else if (at.relations[hop.relation]) {
          add(at.id, hop.relation)
          at = byId.get(at.relations[hop.relation]!.target)
        } else {
          add(at.id, hop.relation)
          at = undefined
        }
      }
      // A grant that reads a field at the end of its path compares that field.
      if (at && g.field) add(at.id, g.field)
    }
  }
  if (scope === 'grants') return out
  const reads = readsOf(blueprints, relationRules, add)
  for (const a of actions) {
    // What an action runs on, and what each rule asks of it, decide who runs it on what.
    const filters = [a.where, ...(a.access?.rules ?? []).map((r) => r.where)].filter((f): f is Filter => !!f)
    for (const target of actionTargets(a)) for (const f of filters) reads.filter(target, f)
  }
  // A class that opens its fields to owners reads the relations it opens them through, and what fills each one.
  for (const bp of blueprints) {
    for (const name of Object.keys(bp.fields)) {
      const c = classFor(policy, bp.id, name)
      if (opensToOwners(c)) for (const r of c.owned.through) if (bp.relations[r]) reads.path(bp.id, r)
    }
  }
  // What a person owns decides access once a rule or a class asks for it: the paths of the roles they name, every path for one that asks for any.
  const asked = joinAsked(ownsAsked(actions), classOwnsAsked(policy))
  if (person && byId.has(person.blueprint) && asked) for (const p of ownsPaths(person.owns)) if (asked === 'any' || (p.as && asked.has(p.as))) reads.path(person.blueprint, p.path)
  // A blueprint that opens its entities to their owners decides by the paths that reach it, and only those steps of them.
  if (person && byId.has(person.blueprint)) {
    for (const bp of blueprints) {
      const owners = bp.access?.owners
      if (owners) for (const path of ownerPathsTo(byId, person, bp, owners.roles)) reads.path(person.blueprint, path)
    }
    // An edit rule that lets owners in decides the same way: by the paths that reach each blueprint it names, and the relations it counts owning through.
    const every = [...new Set(ownsPaths(person.owns).flatMap((p) => (p.as ? [p.as] : [])))]
    for (const rule of policy.edits) {
      if (!rule.owned) continue
      const roles = rule.owned.roles.length ? rule.owned.roles : every
      for (const bp of blueprints) {
        if (!editCovers(rule, bp.id)) continue
        for (const path of ownerPathsTo(byId, person, bp, roles)) reads.path(person.blueprint, path)
        for (const rel of rule.owned.through) {
          const target = bp.relations[rel] && byId.get(bp.relations[rel].target)
          if (!target) continue
          reads.path(bp.id, rel)
          for (const path of ownerPathsTo(byId, person, target, roles)) reads.path(person.blueprint, path)
        }
      }
    }
  }
  return out
}

/**
 * The roles actions ask a person to hold: on an entity, by a rule's `owns`,
 * or on the action's home, by `access.home`. `any` when one takes theirs in
 * any way, null when none asks.
 */
export function ownsAsked(actions: Action[]): Set<string> | 'any' | null {
  const roles = new Set<string>()
  for (const a of actions) {
    for (const owns of [a.home ? a.access?.home : undefined, ...(a.access?.rules ?? []).map((r) => r.owns)]) {
      if (owns === true) return 'any'
      for (const role of owns ?? []) roles.add(role)
    }
  }
  return roles.size ? roles : null
}

/** Every blueprint the person setting's ownership paths of these roles step through, the person blueprint included. */
function pathBlueprints(blueprints: Blueprint[], person: PersonSetting | null, roles: Set<string> | 'any' | null): Set<string> {
  const out = new Set<string>()
  if (!person || !roles) return out
  const byId = new Map(blueprints.map((b) => [b.id, b]))
  out.add(person.blueprint)
  for (const p of ownsPaths(person.owns)) {
    if (roles !== 'any' && !(p.as && roles.has(p.as))) continue
    let hops
    try {
      hops = parsePath(p.path)
    } catch {
      continue
    }
    let at: Blueprint[] = [byId.get(person.blueprint)].filter((b): b is Blueprint => !!b)
    for (const hop of hops) {
      const next: Blueprint[] = []
      for (const here of at) {
        if (hop.incoming) next.push(...(hop.from ? [byId.get(hop.from)].filter((b): b is Blueprint => !!b) : blueprints.filter((b) => b.relations[hop.relation]?.target === here.id)))
        else if (here.relations[hop.relation]) next.push(...[byId.get(here.relations[hop.relation]!.target)].filter((b): b is Blueprint => !!b))
      }
      at = [...new Set(next)]
      for (const b of at) out.add(b.id)
    }
  }
  return out
}

/** The roles classes ask an owner to hold: `any` when one counts every role, null when no class opens to owners. */
export function classOwnsAsked(policy: AccessPolicy): Set<string> | 'any' | null {
  const roles = new Set<string>()
  for (const c of policy.classes) {
    if (!c.owned) continue
    if (!c.owned.roles.length) return 'any'
    for (const role of c.owned.roles) roles.add(role)
  }
  return roles.size ? roles : null
}

/** The roles blueprints open their entities to, by their rule's `owners`; null when none does. */
export function blueprintOwnsAsked(blueprints: Blueprint[]): Set<string> | null {
  const roles = new Set<string>()
  for (const bp of blueprints) for (const role of bp.access?.owners?.roles ?? []) roles.add(role)
  return roles.size ? roles : null
}

/** Every role what a reader owns is worked out for: the ones a class opens fields by, and the ones a blueprint opens entities by. */
export function viewOwnsAsked(policy: AccessPolicy, blueprints: Blueprint[]): Set<string> | 'any' | null {
  return joinAsked(classOwnsAsked(policy), blueprintOwnsAsked(blueprints))
}

/**
 * The owns paths of these roles that can end on one blueprint, with their
 * last step pinned to it: `<-owner` becomes `<-m365_onedrive_site:owner`. A
 * blueprint that opens to owners guards only the steps that reach it, so the
 * same relation on every other blueprint stays open to edit.
 */
export function ownerPathsTo(blueprints: Map<string, Blueprint>, person: PersonSetting, target: Blueprint, roles: readonly string[]): string[] {
  const out: string[] = []
  for (const p of ownsPaths(person.owns)) {
    if (!p.as || !roles.includes(p.as)) continue
    let hops
    try {
      hops = parsePath(p.path)
    } catch {
      continue
    }
    const last = hops[hops.length - 1]!
    const before = hops.slice(0, -1)
    let at: Blueprint | undefined = blueprints.get(person.blueprint)
    for (const hop of before) at = !at ? undefined : hop.incoming ? (hop.from ? blueprints.get(hop.from) : undefined) : at.relations[hop.relation] ? blueprints.get(at.relations[hop.relation]!.target) : undefined
    const said = (hop: { incoming: boolean; from: string | null; relation: string }) => (hop.incoming ? `<-${hop.from ? `${hop.from}:` : ''}${hop.relation}` : hop.relation)
    if (last.incoming) {
      if (last.from && last.from !== target.id) continue
      const rel = target.relations[last.relation]
      if (!rel || (at && rel.target !== at.id)) continue
      out.push([...before.map(said), `<-${target.id}:${last.relation}`].join('.'))
    } else if (at && at.relations[last.relation]?.target === target.id) {
      out.push(p.path)
    }
  }
  return out
}

function joinAsked(a: Set<string> | 'any' | null, b: Set<string> | 'any' | null): Set<string> | 'any' | null {
  if (a === 'any' || b === 'any') return 'any'
  if (!a) return b
  if (!b) return a
  return new Set([...a, ...b])
}

/**
 * Walks what a filter or a path reads, calling `add` for every field and
 * relation by the blueprint that holds it. A relation reads what fills it: the
 * paths and conditions it inherits by, and the field a relation rule matches
 * on. A field reads what derives it: a mirror's or an aggregation's path and
 * the field at its end, and the fields a calculation names.
 */
function readsOf(blueprints: Blueprint[], relationRules: RelationRule[], add: (blueprint: string, name: string) => void) {
  const byId = new Map(blueprints.map((b) => [b.id, b]))
  const seen = new Set<string>()
  const once = (bp: string, name: string): boolean => {
    const k = `${bp}\n${name}`
    if (seen.has(k)) return false
    seen.add(k)
    add(bp, name)
    return true
  }
  const relation = (bp: Blueprint, name: string): void => {
    if (!once(bp.id, name)) return
    const def = bp.relations[name]
    if (!def) return
    for (const c of inheritCases(def)) {
      if (c.when) filter(bp.id, c.when)
      if (c.path) path(bp.id, c.path)
    }
    for (const r of relationRules) {
      if (r.blueprint !== bp.id || r.relation !== name) continue
      let side: string[]
      try {
        side = parseWhere(r.match.where).source
      } catch {
        continue
      }
      const head = side[0] === 'fields' ? side[1] : side[0]
      if (head && head !== 'key' && head !== 'state' && head !== 'owner') field(bp, head)
    }
  }
  const field = (bp: Blueprint, name: string): void => {
    // What the hub keeps about every entity, its key and state among them, nobody changes by hand; the title and icon a person may.
    const def = bp.fields[name]
    if (!def && name !== 'title' && name !== 'icon') return
    if (!once(bp.id, name) || !def) return
    if (def.mirror) {
      const m = splitMirror(def.mirror)
      for (const end of path(bp.id, m.path)) field(end, m.field)
    }
    if (def.aggregation) {
      const ends = path(bp.id, def.aggregation.relation)
      if (def.aggregation.field) for (const end of ends) field(end, def.aggregation.field)
    }
    if (def.calculation) for (const other of Object.keys(bp.fields)) if (other !== name && new RegExp(`\\b${other}\\b`).test(def.calculation)) field(bp, other)
  }
  /** Every relation a path steps along, and the blueprints it ends at. */
  const path = (from: string, text: string): Blueprint[] => {
    let hops
    try {
      hops = parsePath(text)
    } catch {
      return []
    }
    let at: Blueprint[] = [byId.get(from)].filter((b): b is Blueprint => !!b)
    for (const hop of hops) {
      const next: Blueprint[] = []
      for (const here of at) {
        if (hop.incoming) {
          const declaring = hop.from ? [byId.get(hop.from)].filter((b): b is Blueprint => !!b) : blueprints.filter((b) => b.relations[hop.relation]?.target === here.id)
          for (const d of declaring) {
            relation(d, hop.relation)
            next.push(d)
          }
        } else {
          relation(here, hop.relation)
          const target = here.relations[hop.relation] && byId.get(here.relations[hop.relation]!.target)
          if (target) next.push(target)
        }
      }
      at = [...new Set(next)]
    }
    return at
  }
  const filter = (bpId: string, f: Filter): void => {
    const bp = byId.get(bpId)
    if (!bp) return
    if ('and' in f) return f.and.forEach((x) => filter(bpId, x))
    if ('or' in f) return f.or.forEach((x) => filter(bpId, x))
    if ('not' in f) return filter(bpId, f.not)
    if ('field' in f) return field(bp, f.field.startsWith('fields.') ? f.field.slice(7) : f.field)
    if ('relation' in f) {
      const ends = path(bpId, f.relation)
      // What a relation's `where` reads, it reads on the blueprints the relation reaches.
      if (f.where) for (const end of ends) filter(end.id, f.where)
      return
    }
    // Related to an entity in either direction: every relation from it, and every one to it.
    if ('relatedTo' in f) {
      for (const name of Object.keys(bp.relations)) relation(bp, name)
      for (const other of blueprints) for (const [name, def] of Object.entries(other.relations)) if (def.target === bp.id) relation(other, name)
    }
  }
  return { filter, path }
}

/** The values a grant compares against, read once per person. */
type Reached = Map<string, Set<string>>

/** What a person owns, with how: `unset` when the model does not say, `unknown` when the address is no person it holds. */
export type Owned = Awaited<ReturnType<Visibility['owned']>>

/** How one identity may run one action: on everything it runs on, or by the rules that let them in, each judged on the entity. */
export interface ActionGate {
  open: boolean
  rules: ActionRule[]
}

const NONE: ReadonlySet<string> = new Set()
/** The fields every entity carries, which a rule may name like any other. */
const RESERVED_FIELDS = [TITLE_FIELD, ICON_FIELD]
const EMPTY_OPENED: ReadonlyMap<string, ClassOwned> = new Map()

const ALL_REASON = 'something you cannot see is not green'

/** What a reader owns, by entity id, with the roles each is theirs by; empty when they own nothing or the hub does not know. */
type Owns = ReadonlyMap<string, string[]>
const OWNS_NOTHING: Owns = new Map()

/** Of each blueprint whose rule names subjects and that a reader does not see whole, the ids of the entities about what they see. */
type Abouts = ReadonlyMap<string, ReadonlySet<string>>
const ABOUT_NOTHING: Abouts = new Map()

const sameAbouts = (a: Abouts, b: Abouts) => a.size === b.size && [...a].every(([bp, ids]) => {
  const other = b.get(bp)
  return !!other && other.size === ids.size && [...ids].every((id) => other.has(id))
})

/** The words of each calculation: a field name is word characters alone, so a calculation reads a field where one of its words is the name. */
const calculationWords = new Map<string, string[]>()

function wordsOf(calculation: string): string[] {
  let words = calculationWords.get(calculation)
  if (!words) calculationWords.set(calculation, (words = [...new Set(calculation.match(/\w+/g) ?? [])]))
  return words
}


function sameOwns(a: Owns, b: Owns): boolean {
  if (a.size !== b.size) return false
  for (const [id, roles] of a) {
    const other = b.get(id)
    if (!other || other.length !== roles.length || other.some((r, i) => r !== roles[i])) return false
  }
  return true
}

function sameReach(a: Reached, b: Reached): boolean {
  if (a.size !== b.size) return false
  for (const [k, values] of a) {
    const other = b.get(k)
    if (!other || other.size !== values.size || [...values].some((v) => !other.has(v))) return false
  }
  return true
}

/** What edit rules open to one person. One is built per request. */
export interface Editor {
  /** False when no rule could let this person change anything: nothing needs asking. */
  readonly any: boolean
  /**
   * The fields and relations the rules open to this person on one entity:
   * every name a rule opens to an audience they are in, and every name a rule
   * opens to owners where the entity, or what it points at through the rule's
   * relations, is theirs in a role the rule counts.
   */
  opens(e: Pick<Entity, 'id' | 'blueprint' | 'relations'>): EditOpened
  /** What the rules open to this person on a blueprint, rule by rule: on every entity of it as an audience, or on the ones that are theirs. */
  reach(blueprint: string): EditReach[]
  /** Whether a rule lets this person change one field or relation on at least one entity of a blueprint. */
  could(blueprint: string, name: string, kind: 'field' | 'relation'): boolean
}

/** One edit rule as it reaches one person on one blueprint. */
export interface EditReach {
  rule: string
  /** `audience`: on every entity. `owner`: on the entities that are theirs in a role the rule counts. */
  how: 'audience' | 'owner'
  /** For `owner`: how many entities of the blueprint are theirs that way. */
  entities: number
  /** For `owner`: the relations through which owning what an entity points at counts too, where they own something there; those entities are not counted. */
  through: string[]
  fields: string[]
  relations: string[]
}

export interface EditOpened {
  fields: ReadonlySet<string>
  relations: ReadonlySet<string>
  /** Whether an audience opens the name to them, so they change it as its steward: over what a source says too, which an owner alone never does. */
  steward: (name: string, kind: 'field' | 'relation') => boolean
}

const NOTHING_OPENED: EditOpened = { fields: NONE, relations: NONE, steward: () => false }
const NO_EDITOR: Editor = { any: false, opens: () => NOTHING_OPENED, reach: () => [], could: () => false }

/** A blueprint's names a rule may open, each with the rules that name it. */
interface Openable {
  fields: Map<string, EditRule[]>
  relations: Map<string, EditRule[]>
}

export class Visibility {
  /** What edit rules may open on each blueprint, worked out when first asked and until the model or the policy moves. */
  private openableBy = new Map<string, Openable>()
  private readonly cache = new Map<string, Promise<Reached>>()
  /** What each reader reached last, kept as the same object while it does not change, so their kept pages stand when it is worked out again. */
  private readonly lastReach = new Map<string, Reached>()
  /** What every person owns, walked once and moved in place as links move. */
  private readonly ownership: Ownership
  /** The person entity each sign-in address is, null for none: read again when an entity of the person blueprint moves. */
  private readonly people = new Map<string, Promise<EntityRef | null>>()
  /** What each reader owns by the roles a class asks for, kept beside the whole answer it was cut from. */
  private readonly ownsCut = new WeakMap<ReadonlyMap<string, string[]>, Map<string, Map<string, string[]>>>()
  /** The blueprints the ownership paths a class asks for walk through. */
  private ownsReads = new Set<string>()
  /** Every blueprint any owns path steps through, the person blueprint included: what every person's own things are worked out from. */
  private ownedReadsAll: ReadonlySet<string> = new Set<string>()
  /** The last answer for each reader, kept as the same object while it does not change. */
  private readonly lastOwns = new Map<string, Owns>()
  /** What each reader sees one by one as about what they see. Read again when an entity of a blueprint that names subjects moves, or anything that decides what they see. */
  private readonly aboutsCache = new Map<string, Promise<Abouts>>()
  /** The last answer for each reader, kept as the same object while it does not change. */
  private readonly lastAbouts = new Map<string, Abouts>()
  /** The blueprints whose rule names subjects: an entity of one moving moves what is about what a reader sees. */
  private aboutReads = new Set<string>()
  /** One basis per reach, owned set, and set of what is about what they see, so a kept page is rebuilt when any moves. */
  private readonly bases = new WeakMap<Reached, WeakMap<Owns, WeakMap<Abouts, object>>>()
  private person: PersonSetting | null = null
  private policy: PolicyState = { policy: EMPTY_POLICY, source: null }
  /** The policy as it reads today: a blueprint it names by a former id read as the one it has now. */
  private effective: AccessPolicy = EMPTY_POLICY
  private adminOnly = new Set<string>()
  private decides = new Map<string, Set<string>>()
  /** What decides who a person is: the marked fields and what grants read. A `record` backend never writes one. */
  private decidesWho = new Map<string, Set<string>>()
  /** The actions, whose grants are read like the model's. Attached once they exist. */
  private actions: { list(): Action[] } = { list: () => [] }
  /** The relation rules, whose matched fields fill a relation access may be decided from. Attached once they exist. */
  private relationRules: { list(): RelationRule[] } = { list: () => [] }
  /** The scorecards a filter may read a level of. Attached once they exist. */
  private cards: { get(id: string): Scorecard | undefined } = { get: () => undefined }

  private readonly db: Db
  private readonly blueprints: Blueprints
  private readonly reader: Reader
  private readonly log: Logger

  constructor(db: Db, blueprints: Blueprints, reader: Reader, events: Events, log: Logger) {
    this.db = db
    this.blueprints = blueprints
    this.reader = reader
    this.log = log
    this.ownership = new Ownership(db, blueprints, log)
    events.subscribe((event) => {
      // What a reader owns moves in place with the links its paths walk through (`ownership.ts`); a model change walks it afresh.
      // A write of values alone, and a derived row landing, move no link and no entity's state.
      if (event.type === 'blueprints' && !event.offered) this.ownership.forget()
      if ((event.type === 'entity' && !event.values) || event.type === 'estate') this.ownership.moved()
      // Who a sign-in address is moves with the person blueprint's entities, values and all.
      if ((event.type === 'entity' && event.blueprint === this.person?.blueprint) || (event.type === 'estate' && (!event.blueprints || (!!this.person && event.blueprints.includes(this.person.blueprint)))) || event.type === 'blueprints') this.people.clear()
      if ((event.type === 'entity' && this.ownsReads.has(event.blueprint)) || (event.type === 'estate' && (!event.blueprints || event.blueprints.some((b) => this.ownsReads.has(b)))) || event.type === 'blueprints' || event.type === 'access') this.aboutsCache.clear()
      // What is about what a reader sees moves with the entities that name subjects.
      if ((event.type === 'entity' && this.aboutReads.has(event.blueprint)) || (event.type === 'estate' && (!event.blueprints || event.blueprints.some((b) => this.aboutReads.has(b))))) this.aboutsCache.clear()
      // What a person may see turns on their own entity and the entities its paths reach; anything else leaves it as it was.
      if (event.type === 'entity' && !this.adminOnly.has(event.blueprint)) return
      if (event.type === 'estate' && event.blueprints && !event.blueprints.some((b) => this.adminOnly.has(b))) return
      if (event.type === 'sources' || event.type === 'action_run' || event.type === 'icons') return
      if (event.type === 'blueprints' || event.type === 'actions') this.refresh()
      this.cache.clear()
      this.aboutsCache.clear()
    })
  }

  async load(): Promise<void> {
    const row = await this.db.query<{ value: PersonSetting }>('SELECT value FROM settings WHERE key = $1', [PERSON_KEY])
    this.person = row.rows[0]?.value ?? null
    const policy = await this.db.query<{ value: PolicyState }>('SELECT value FROM settings WHERE key = $1', [POLICY_KEY])
    const held = policy.rows[0]?.value
    this.policy = held ? { policy: normalizePolicy(held.policy), source: held.source ?? null } : { policy: EMPTY_POLICY, source: null }
    this.refresh()
  }

  /** The audiences and field classes, and the git source that declares them, if one does. */
  policyState(): PolicyState {
    return this.policy
  }

  /** The policy every rule is judged by: as saved, with renamed blueprints read by their ids today. */
  accessPolicy(): AccessPolicy {
    return this.effective
  }

  /**
   * Replaces the policy. `source` is the git source that declares it, or null
   * for a change made in the hub; a change in the hub is refused while a git
   * source owns it. Returns false when nothing changed.
   */
  async setPolicy(next: AccessPolicy, source: string | null): Promise<boolean> {
    const policy = normalizePolicy(next)
    const problems = policyProblems(policy)
    if (problems.length) throw new PolicyError(problems.join('; '))
    if (source === null && this.policy.source) throw new PolicyError(`The audiences and classes are declared in git by source "${this.policy.source}": change them there`)
    const state: PolicyState = { policy, source }
    if (equal(state, this.policy)) return false
    await this.db.query('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [POLICY_KEY, JSON.stringify(state)])
    this.policy = state
    this.refresh()
    this.log.info('access policy changed', { source, audiences: policy.audiences.length, classes: policy.classes.length })
    return true
  }

  /**
   * A git source stops declaring the policy. The policy stays as it was and
   * is changed in the hub from now on: letting go never opens what it guards.
   */
  async releasePolicy(source: string): Promise<boolean> {
    if (this.policy.source !== source) return false
    const state: PolicyState = { policy: this.policy.policy, source: null }
    await this.db.query('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [POLICY_KEY, JSON.stringify(state)])
    this.policy = state
    this.log.info('access policy released: git no longer declares it, so it is changed in the hub', { source })
    return true
  }

  /** The rule that decides who sees a field: its class's when one matches, else its own. */
  fieldRule(blueprint: string, field: string, own: AccessRule | undefined, policy: AccessPolicy = this.effective): AccessRule | undefined {
    return fieldRule(policy, blueprint, field, own)
  }

  /** Called after the model or the actions change, so the set of blueprints that decide access follows them. */
  refresh(): void {
    this.effective = withCurrentIds(this.policy.policy, (id) => this.blueprints.resolve(id))
    this.adminOnly = adminOnlyBlueprints(this.blueprints.list(), this.person, this.actions.list(), this.effective)
    this.decides = accessNames(this.blueprints.list(), this.person, this.actions.list(), this.effective, this.relationRules.list())
    this.decidesWho = accessNames(this.blueprints.list(), this.person, this.actions.list(), this.effective, [], 'grants')
    this.ownsReads = pathBlueprints(this.blueprints.list(), this.person, viewOwnsAsked(this.effective, this.blueprints.list()))
    this.ownedReadsAll = pathBlueprints(this.blueprints.list(), this.person, 'any')
    this.aboutReads = new Set(this.blueprints.list().filter((bp) => bp.access?.subjects?.length).map((bp) => bp.id))
    this.openableBy = new Map()
    this.cache.clear()
    this.people.clear()
    this.ownership.setPaths(ownsPaths(this.person?.owns))
  }

  /** The relation rules fill relations as people do; what they match on decides access when the relation does. Read from here on. */
  attachRules(rules: { list(): RelationRule[] }): void {
    this.relationRules = rules
    this.refresh()
  }

  /** The actions' grants decide who runs them the way the model's decide who sees what; they are read from here on. */
  attach(actions: { list(): Action[] }): void {
    this.actions = actions
    this.refresh()
  }

  /** What a person owns, by every path of the setting's `owns`, as it is kept (`ownership.ts`). */
  async ownedKept(who: string): Promise<Owned> {
    const key = who.toLowerCase()
    return (await this.ownedMany([key])).get(key)!
  }

  /**
   * Whether a person owns a home (an action's, or a saved query's) the way it
   * asks: in any way for `true`, or by one of the roles it names, as an
   * action's `access.home` does. Nobody does while the model does not say
   * what a person owns, or holds no entity for them.
   */
  async homeLetsIn(identity: Pick<Identity, 'kind' | 'name'>, home: string | undefined, asked: true | string[] | undefined): Promise<boolean> {
    if (!home || !asked || identity.kind !== 'user') return false
    const owned = await this.ownedKept(identity.name)
    const roles = owned.state === 'known' ? owned.ids.get(home) : undefined
    const lets = !!roles && (asked === true || asked.some((r) => roles.includes(r)))
    if (lets) this.log.debug('open to a person by its home', { user: identity.name, home, as: roles })
    else this.log.debug('not open to a person by its home', { user: identity.name, home, owned: owned.state, as: roles ?? null, asked })
    return lets
  }

  /**
   * Whether an identity may run an action on anything. An admin always may;
   * `everyone` lets anyone signed in; else a grant must let them in, read
   * from their person entity for a person, or by name for a machine token,
   * or they own the action's home the way `access.home` asks, or a rule
   * must let them in, on whatever of its entities the rule then takes.
   * Without `access`, nobody but an admin.
   */
  async mayRun(identity: Identity, action: Action): Promise<boolean> {
    const gate = await this.gate(identity, action)
    return gate.open || gate.rules.length > 0
  }

  /**
   * How an identity may run an action: `open` on everything it runs on, or
   * through the rules whose who-part lets them in, each still to be judged
   * on the entity. A rule naming neither audiences nor grants lets in anyone
   * signed in; one whose audiences reach nobody lets in nobody. Owning the
   * action's home, where `access.home` asks for it, opens it like a grant.
   */
  async gate(identity: Identity, action: Action): Promise<ActionGate> {
    if (identity.admin || action.access?.everyone) return { open: true, rules: [] }
    const own = actionGrants(this.effective, action.access)
    const rules = action.access?.rules ?? []
    const all = [...own, ...rules.flatMap((r) => [...actionGrants(this.effective, r), ...(r.require ?? [])])]
    const reached = all.length ? await this.reach(identity.name) : new Map<string, Set<string>>()
    if (own.length && grantsAllow(reached, own)) return { open: true, rules: [] }
    if (await this.homeLetsIn(identity, action.home, action.access?.home)) return { open: true, rules: [] }
    // A rule that names a person under `except` never lets them in; the other rules still judge them.
    const me = identity.name.toLowerCase()
    const passed = rules.filter((r) => !r.except?.some((e) => e.toLowerCase() === me) && ruleLets(reached, this.effective, r))
    const owning = passed.some((r) => r.owns) ? await this.ownsOn(identity, actionTargets(action), passed.some(namesSelf)) : null
    return { open: false, rules: passed.filter((r) => !r.owns || ownsMeets(owning, r.owns)) }
  }

  /**
   * The roles a person owns anything by among these blueprints, or null when
   * they own nothing there. A rule's `owns` takes only what the person owns,
   * so a rule that asks for it lets in only someone who owns something of
   * what the action runs on, the way `targets` then judges each entity. With
   * `self` asked, their own person entity, where it is of these blueprints,
   * is theirs as `self`, whether or not the setting says what a person owns.
   */
  private async ownsOn(identity: Pick<Identity, 'kind' | 'name'>, blueprints: string[], self = false): Promise<Owning | null> {
    if (identity.kind !== 'user' || !blueprints.length) return null
    const owned = await this.ownedKept(identity.name)
    const roles = new Set<string>()
    let byPath = false
    if (owned.state === 'known') {
      for (const [id, as] of owned.ids) {
        if (!blueprints.some((b) => id.startsWith(`${b}:`))) continue
        byPath = true
        for (const r of as) roles.add(r)
      }
    }
    if (self) {
      const me = await this.personOf(identity.name)
      if (me && blueprints.includes(me.blueprint)) roles.add(SELF_ROLE)
    }
    const any = byPath || roles.has(SELF_ROLE)
    this.log.debug(any ? 'person owns something an action runs on' : 'person owns nothing an action runs on', { user: identity.name, blueprints, owned: owned.state, roles: [...roles] })
    return any ? { roles, byPath } : null
  }

  /**
   * What edit rules may open on a blueprint, whoever asks: every field and
   * relation a rule names, less what no rule ever opens. A derived value and
   * a locked one are a source's or the hub's; one an admin marked is an
   * admin's; and what access is decided from is never opened, or a rule
   * could let a person change who they are.
   */
  openable(blueprint: string): Openable {
    let hit = this.openableBy.get(blueprint)
    if (hit) return hit
    hit = { fields: new Map(), relations: new Map() }
    const bp = this.blueprints.get(blueprint)
    const decided = this.decides.get(blueprint)
    if (bp && this.effective.edits.length) {
      for (const [name, def] of [...Object.entries(bp.fields), ...RESERVED_FIELDS.filter((n) => !bp.fields[n]).map((n): [string, FieldDef] => [n, { type: 'string' }])]) {
        if (isDerived(def) || def.overridable === false || def.adminEdit || decided?.has(name)) continue
        const rules = editRulesFor(this.effective, blueprint, name, 'field')
        if (rules.length) hit.fields.set(name, rules)
      }
      for (const name of Object.keys(bp.relations)) {
        if (decided?.has(name)) continue
        const rules = editRulesFor(this.effective, blueprint, name, 'relation')
        if (rules.length) hit.relations.set(name, rules)
      }
    }
    this.openableBy.set(blueprint, hit)
    return hit
  }

  /**
   * What edit rules open to one identity. Only a person is let in by one,
   * and never while an admin views the hub as them: that view is read-only.
   * Their own person entity is theirs in the role `self`, for a rule that
   * lets a person describe themselves; it is theirs in no other way.
   */
  async editor(identity: Pick<Identity, 'kind' | 'name' | 'viewAs'>): Promise<Editor> {
    const rules = this.effective.edits
    if (!rules.length || identity.kind !== 'user' || identity.viewAs) return NO_EDITOR
    return this.editorFor(identity.name)
  }

  /** The same for a person by address, whoever asks: for the posture, which judges everyone. */
  async editorFor(address: string): Promise<Editor> {
    const rules = this.effective.edits
    if (!rules.length) return NO_EDITOR
    const reached = rules.some((r) => r.audiences.length) ? await this.reach(address) : new Map<string, Set<string>>()
    const inAudience = new Set(rules.filter((r) => r.audiences.length && grantsAllow(reached, audienceGrants(this.effective, r.audiences))).map((r) => r.id))
    const owned = rules.some((r) => r.owned) ? await this.ownedKept(address) : null
    const owns: Owns = owned?.state === 'known' ? owned.ids : OWNS_NOTHING
    // Their own person entity is theirs as `self` whether or not the setting says what a person owns.
    const me = owned?.state === 'known' ? owned.person : owned ? await this.personOf(address) : null
    const self = me ? entityId(me) : null
    if (!inAudience.size && !owns.size && !self) return NO_EDITOR
    const rolesOf = (id: string): string[] | undefined => (id === self ? [...(owns.get(id) ?? []), SELF_ROLE] : owns.get(id))
    const lets = (rule: EditRule, e: Pick<Entity, 'id' | 'relations'>): 'audience' | 'owner' | null => {
      if (inAudience.has(rule.id)) return 'audience'
      const how = rule.owned
      if (!how) return null
      const ids = [e.id, ...how.through.flatMap((r) => (e.relations[r] ?? []).map((t) => entityId(t)))]
      return ids.some((id) => ownedCounts(how, rolesOf(id))) ? 'owner' : null
    }
    /** How many entities of a blueprint are theirs in a role the rule counts, their own person entity included. */
    const ownedOf = (blueprint: string, how: ClassOwned): number => {
      let n = self?.startsWith(`${blueprint}:`) && !owns.has(self) && ownedCounts(how, [SELF_ROLE]) ? 1 : 0
      for (const [id, roles] of owns) if (id.startsWith(`${blueprint}:`) && ownedCounts(how, id === self ? [...roles, SELF_ROLE] : roles)) n++
      return n
    }
    const reach = (blueprint: string): EditReach[] => {
      const open = this.openable(blueprint)
      const bp = this.blueprints.get(blueprint)
      const out = new Map<EditRule, EditReach>()
      const at = (rule: EditRule): EditReach | null => {
        let row = out.get(rule)
        if (row) return row
        if (inAudience.has(rule.id)) row = { rule: rule.id, how: 'audience', entities: 0, through: [], fields: [], relations: [] }
        else if (rule.owned) {
          const how = rule.owned
          const entities = ownedOf(blueprint, how)
          const through = how.through.filter((r) => bp?.relations[r] && ownedOf(bp.relations[r].target, how) > 0)
          if (entities || through.length) row = { rule: rule.id, how: 'owner', entities, through, fields: [], relations: [] }
        }
        if (row) out.set(rule, row)
        return row ?? null
      }
      for (const [name, named] of open.fields) for (const r of named) at(r)?.fields.push(name)
      for (const [name, named] of open.relations) for (const r of named) at(r)?.relations.push(name)
      return [...out.values()]
    }
    return {
      any: true,
      opens: (e) => {
        const open = this.openable(e.blueprint)
        if (!open.fields.size && !open.relations.size) return NOTHING_OPENED
        const by = new Map<EditRule, 'audience' | 'owner' | null>()
        const how = (rule: EditRule) => {
          if (!by.has(rule)) by.set(rule, lets(rule, e))
          return by.get(rule)!
        }
        const fields = new Set<string>()
        const relations = new Set<string>()
        for (const [name, named] of open.fields) if (named.some((r) => how(r))) fields.add(name)
        for (const [name, named] of open.relations) if (named.some((r) => how(r))) relations.add(name)
        if (!fields.size && !relations.size) return NOTHING_OPENED
        return { fields, relations, steward: (name, kind) => ((kind === 'field' ? open.fields : open.relations).get(name) ?? []).some((r) => how(r) === 'audience') }
      },
      reach,
      could: (blueprint, name, kind) => reach(blueprint).some((r) => (kind === 'field' ? r.fields : r.relations).includes(name) && (r.how === 'audience' || r.entities > 0 || r.through.length > 0)),
    }
  }

  /**
   * Sets `editable` on each entity an edit rule opens something on to this
   * reader. Where the entity says which layer won each value (`layers`, or a
   * page's `provenance`), a field git sets is left out, and so is one a
   * source says for a reader let in only as the owner, unless it is sticky;
   * the write itself decides again. A field the view withholds is never
   * named. The entities are the caller's own copies.
   */
  async annotateEdits(identity: Pick<Identity, 'kind' | 'name' | 'viewAs' | 'admin'>, view: View, list: (Entity & { provenance?: Record<string, FieldProvenance> })[]): Promise<void> {
    if (identity.admin || !list.length) return
    const editor = await this.editor(identity)
    if (!editor.any) return
    for (const e of list) {
      const open = editor.opens(e)
      if (!open.fields.size && !open.relations.size) continue
      const bp = this.blueprints.get(e.blueprint)
      const hidden = view.hiddenFields(e.blueprint)
      const fields = [...open.fields].filter((name) => {
        // A field the reader may not see is not named to them, and no change to it is taken.
        if (hidden.has(name)) return false
        const layer = e.provenance ? e.provenance[name]?.layer : e.layers?.[name]
        if (layer === 'git') return false
        if (layer !== 'pushed' && layer !== 'override') return true
        if (open.steward(name, 'field') || bp?.fields[name]?.sticky) return true
        const value = name === TITLE_FIELD ? e.title : name === ICON_FIELD ? e.icon : e.fields[name]
        return value === null || value === undefined || value === '' || (Array.isArray(value) && !value.length)
      })
      const relations = [...open.relations].filter((name) => (e.relationLayers?.[name] ?? null) !== 'git')
      if (fields.length || relations.length) e.editable = { fields, relations }
    }
  }

  /**
   * Why a person may not change these values by hand, or null when they may.
   * An admin may change anything. A blueprint or field an admin marked is an
   * admin's alone. What access is decided from is also changed by a holder of
   * `access.values`.
   */
  refusesHandEdit(identity: Pick<Identity, 'admin' | 'permissions'>, blueprint: string, names: Iterable<string>): string | null {
    if (identity.admin) return null
    const bp = this.blueprints.get(blueprint)
    if (bp?.adminEdit) return `Only an admin changes ${bp.title}`
    const list = [...names]
    for (const name of list) if (bp?.fields[name]?.adminEdit) return `Only an admin changes "${name}"`
    if (identity.permissions.includes('access.values')) return null
    if (this.adminOnly.has(blueprint)) return `Access is decided from ${bp?.title ?? blueprint}, so only an admin or a holder of access.values changes it`
    const decided = this.decides.get(blueprint)
    for (const name of list) if (decided?.has(name)) return `Access is decided from "${name}", so only an admin or a holder of access.values changes it`
    return null
  }

  /**
   * Why a `record` backend or a run's `refreshes` may not write these names
   * on this blueprint, whoever owns the entity: who a person is, or what a
   * job runs as, is decided from them. What an
   * action's filter or rule reads it writes as its source, the way a pusher
   * writes one: only on an entity that source owns.
   */
  refusesRecordWrite(blueprint: string, names: Iterable<string>): string | null {
    if (this.adminOnly.has(blueprint)) return `access to the hub is decided from ${blueprint}, so only the source that owns this entity or an admin changes it`
    const decided = this.decidesWho.get(blueprint)
    for (const name of names) if (decided?.has(name)) return `access is decided from "${name}", so only the source that owns this entity or an admin changes it`
    return null
  }

  /** What access is decided from on a blueprint: the whole of it, or these names. */
  decidesOn(blueprint: string): { all: boolean; names: string[] } {
    return { all: this.adminOnly.has(blueprint), names: [...(this.decides.get(blueprint) ?? [])].sort() }
  }

  /** A filter reads levels through the scorecards; they are built after visibility, so they attach here. */
  attachScorecards(cards: Visibility['cards']): void {
    this.cards = cards
  }

  scorecard(id: string): ReturnType<Visibility['cards']['get']> {
    return this.cards.get(id)
  }

  personSetting(): PersonSetting | null {
    return this.person
  }

  async setPerson(next: PersonSetting | null): Promise<void> {
    if (next && !this.blueprints.get(next.blueprint)) throw new Error(`Unknown blueprint "${next.blueprint}"`)
    if (next?.field && !this.blueprints.get(next.blueprint)!.fields[next.field]) throw new Error(`Blueprint "${next.blueprint}" has no field "${next.field}"`)
    for (const { path } of ownsPaths(next?.owns)) this.blueprints.checkGrantPath(next!.blueprint, path, `What a person owns ("${path}")`)
    if (next?.owns && !next.owns.length) delete next.owns
    if (next) await this.db.query('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [PERSON_KEY, JSON.stringify(next)])
    else await this.db.query('DELETE FROM settings WHERE key = $1', [PERSON_KEY])
    this.person = next
    this.refresh()
    this.log.info('person entity setting changed', { person: next })
  }

  /** Blueprints only an admin changes, by id. */
  adminOnlyIds(): string[] {
    return [...this.adminOnly].sort()
  }

  isAdminOnly(blueprint: string): boolean {
    return this.adminOnly.has(blueprint)
  }

  /**
   * Why a source may not make this write to an entity it does not own, or
   * null when it may: an entity of a blueprint access is decided from, or a
   * field or relation access is decided from (`accessNames`).
   */
  refusesForeignWrite(blueprint: string, names: Iterable<string>): string | null {
    if (this.adminOnly.has(blueprint)) return `access to the hub is decided from ${blueprint}, so only the source that owns this entity or an admin changes it`
    const decided = this.decides.get(blueprint)
    if (!decided) return null
    for (const name of names) if (decided.has(name)) return `access is decided from "${name}", so only the source that owns this entity or an admin changes it`
    return null
  }

  async view(identity: Identity): Promise<View> {
    // A person, signed in or with their own token, is the only caller anything is withheld from.
    if (identity.admin || identity.kind !== 'user') return new Everything(this, identity.admin || identity.kind !== 'user')
    const reached = await this.reach(identity.name)
    const owns = await this.ownsFor(identity.name, this.effective)
    const abouts = await this.aboutsFor(identity.name, reached, this.effective, owns)
    return new Restricted(this, reached, this.effective, owns, abouts, this.basisOf(reached, owns, abouts))
  }

  /** What a reader sees one by one as about what they see, kept per reader like what they own. */
  private aboutsFor(address: string, reached: Reached, policy: AccessPolicy, owns: Owns): Promise<Abouts> {
    if (!this.aboutReads.size) return Promise.resolve(ABOUT_NOTHING)
    const key = address.toLowerCase()
    let hit = this.aboutsCache.get(key)
    if (!hit) {
      hit = this.aboutOf(new Restricted(this, reached, policy, owns, ABOUT_NOTHING, {})).then((now) => this.keptAbouts(key, now)).catch((error: unknown) => {
        this.aboutsCache.delete(key)
        throw error
      })
      this.aboutsCache.set(key, hit)
    }
    return hit
  }

  /**
   * Of each blueprint whose rule names subjects and that this reader does not
   * see whole, the entities that name, through one of those relations,
   * something the reader sees: a whole blueprint, an entity of theirs, or one
   * itself about what they see. A subject that is itself about something is
   * read after it; where they name each other, what is known so far.
   */
  private async aboutOf(probe: Restricted): Promise<Abouts> {
    return (await this.aboutMany([probe]))[0]!
  }

  /**
   * `aboutOf` for many readers at once, in the order of `probes`. Each reader
   * reads their blueprints in their own order, and the readers at the same
   * step of the same blueprint share one read of its links.
   */
  private async aboutMany(probes: Restricted[]): Promise<Abouts[]> {
    const targetsOf = (bp: Blueprint) => [...new Set(bp.access!.subjects!.flatMap((r) => (bp.relations[r] ? [bp.relations[r]!.target] : [])))]
    const plans = probes.map((probe) => {
      const named = this.blueprints.list().filter((bp) => bp.access?.subjects?.length && !probe.seesBlueprint(bp.id))
      const ids = new Set(named.map((bp) => bp.id))
      // Those whose subjects are themselves about something go last.
      const order = [...named].sort((a, b) => Number(targetsOf(a).some((t) => ids.has(t))) - Number(targetsOf(b).some((t) => ids.has(t))))
      return { probe, order, out: new Map<string, ReadonlySet<string>>() }
    })
    const steps = Math.max(0, ...plans.map((p) => p.order.length))
    for (let step = 0; step < steps; step++) {
      const byBlueprint = new Map<string, typeof plans>()
      for (const plan of plans) {
        const bp = plan.order[step]
        if (bp) byBlueprint.set(bp.id, [...(byBlueprint.get(bp.id) ?? []), plan])
      }
      for (const [id, group] of byBlueprint) {
        const bp = this.blueprints.get(id)!
        const relations = bp.access!.subjects!.filter((r) => bp.relations[r])
        const targets = targetsOf(bp)
        const asks = group.map((plan) => ({
          plan,
          whole: new Set(targets.filter((t) => plan.probe.seesBlueprint(t))),
          one: new Set(targets.flatMap((t) => [...(plan.probe.ownedOnly(t) ?? []), ...(plan.out.get(t) ?? [])])),
        }))
        const links = await timed('visibility.about', () =>
          this.reader.aboutLinks(bp.id, relations, [...new Set(asks.flatMap((a) => [...a.whole]))], [...new Set(asks.flatMap((a) => [...a.one]))]),
        )
        for (const { plan, whole, one } of asks) {
          const found = new Set(links.filter((l) => whole.has(l.targetBlueprint) || one.has(l.target)).map((l) => l.id))
          if (found.size) plan.out.set(bp.id, found)
        }
      }
    }
    return plans.map((plan) => (plan.out.size ? plan.out : ABOUT_NOTHING))
  }

  /** What is about what a reader sees as it is kept: the same object while it is the same, so their kept pages stand. */
  private keptAbouts(key: string, now: Abouts): Abouts {
    const last = this.lastAbouts.get(key)
    if (last && sameAbouts(last, now)) return last
    this.lastAbouts.set(key, now)
    this.log.debug('what is about what a reader sees moved; their pages are built again', { user: key, blueprints: now.size })
    return now
  }

  /** What a reader owns, read only when a class opens its fields to owners or a blueprint its entities. */
  private async ownsFor(address: string, policy: AccessPolicy): Promise<Owns> {
    const asked = viewOwnsAsked(policy, this.blueprints.list())
    if (!asked) return OWNS_NOTHING
    const key = address.toLowerCase()
    const o = await this.owned(key, asked)
    return this.keptOwns(key, o.state === 'known' ? o.ids : null)
  }

  /** What a reader owns as it is kept: the same object while it is the same, so what is kept for them is not built again on every push. */
  private keptOwns(key: string, ids: ReadonlyMap<string, string[]> | null): Owns {
    const now = ids?.size ? ids : OWNS_NOTHING
    const last = this.lastOwns.get(key)
    if (last && sameOwns(last, now)) return last
    this.lastOwns.set(key, now)
    this.log.debug('what a reader owns moved; their pages are built again', { user: key, owned: now.size })
    return now
  }

  private basisOf(reached: Reached, owns: Owns, abouts: Abouts): object {
    let byOwns = this.bases.get(reached)
    if (!byOwns) this.bases.set(reached, (byOwns = new WeakMap()))
    let byAbouts = byOwns.get(owns)
    if (!byAbouts) byOwns.set(owns, (byAbouts = new WeakMap()))
    let basis = byAbouts.get(abouts)
    if (!basis) byAbouts.set(abouts, (basis = {}))
    return basis
  }

  /** What a person would see were this policy saved, for a preview; nothing is cached. */
  async viewWith(identity: Identity, policy: AccessPolicy): Promise<View> {
    if (identity.admin || identity.kind !== 'user') return new Everything(this, identity.admin || identity.kind !== 'user')
    const current = withCurrentIds(policy, (id) => this.blueprints.resolve(id))
    const reached = await this.reachFor(identity.name.toLowerCase(), policyGrants(current))
    const owns = await this.ownsFor(identity.name, current)
    const abouts = this.aboutReads.size ? await this.aboutOf(new Restricted(this, reached, current, owns, ABOUT_NOTHING, {})) : ABOUT_NOTHING
    return new Restricted(this, reached, current, owns, abouts, {})
  }

  /**
   * Works out at once what every grant reads and what each person owns for
   * many people, a few queries in all rather than a few per person, and keeps
   * each answer the way `view` keeps one. For a page that judges everyone,
   * such as the posture.
   */
  async warm(addresses: string[]): Promise<void> {
    const all = [...new Set(addresses.map((a) => a.toLowerCase()))]
    const todo = all.filter((a) => !this.cache.has(a))
    // What a person owns is read only when a class or a blueprint opens to owners, and is dropped more often than what they reach.
    const asked = viewOwnsAsked(this.effective, this.blueprints.list())
    const ownsAsked = asked ? this.ownsPathsFor(asked) : []
    // What each owns by every path, which the gate reads for an action's home and a rule's `owns`, is walked for all of them at once.
    const owning = await this.ownedMany(all)
    if (ownsAsked.length) for (const address of all) {
      const o = owning.get(address)
      this.keptOwns(address, o?.state === 'known' ? this.cut(o.ids, asked) : null)
    }
    if (!todo.length) return this.warmAbouts(all)
    const refs = await this.personRefs(todo)
    const refsOf = (list: string[]) => [...new Map(list.flatMap((a) => (refs.has(a) ? [refs.get(a)!] : [])).map((r) => [entityId(r), r])).values()]
    if (todo.length) {
      const grants = this.grants()
      const keyed = new Map<string, AccessGrant>()
      for (const g of grants) if (!keyed.has(grantKey(g))) keyed.set(grantKey(g), g)
      const found = refsOf(todo)
      const ends = new Map<string, Map<string, Entity[]>>()
      if (found.length) {
        const selves = new Map((await this.reader.materialize(await this.reader.rowsFor(found))).map((e) => [entityId(e), [e]]))
        const walked = await this.reader.followAll(found, [...keyed.values()].flatMap((g) => (g.path ? [g.path] : [])))
        for (const [k, g] of keyed) ends.set(k, g.path ? walked.get(g.path)! : selves)
      }
      for (const address of todo) {
        const me = refs.get(address) ?? null
        const reached: Reached = new Map()
        for (const [k, g] of keyed) reached.set(k, valuesFor(address, g, me ? (ends.get(k)?.get(entityId(me)) ?? []) : []))
        this.cache.set(address, Promise.resolve(this.keptReach(address, reached)))
      }
    }
    this.log.info('access worked out for many people at once', { people: todo.length, owners: ownsAsked.length ? all.length : 0, found: refs.size })
    await this.warmAbouts(all)
  }

  /** What is about what each reader sees, for many readers at once, kept the way `view` keeps one. */
  private async warmAbouts(addresses: string[]): Promise<void> {
    if (!this.aboutReads.size) return
    const todo = addresses.filter((a) => !this.aboutsCache.has(a))
    if (!todo.length) return
    const probes = await Promise.all(todo.map(async (a) => new Restricted(this, await this.reach(a), this.effective, await this.ownsFor(a, this.effective), ABOUT_NOTHING, {})))
    const found = this.aboutMany(probes)
    todo.forEach((a, i) => {
      const hit = found.then((all) => this.keptAbouts(a, all[i]!))
      hit.catch(() => this.aboutsCache.delete(a))
      this.aboutsCache.set(a, hit)
    })
    await found
  }

  /** The values every grant in the model reads, starting from this person's own entity. */
  private reach(address: string): Promise<Reached> {
    let hit = this.cache.get(address)
    if (!hit) {
      hit = this.compute(address).catch((error: unknown) => {
        this.cache.delete(address)
        throw error
      })
      this.cache.set(address, hit)
    }
    return hit
  }

  private compute(address: string): Promise<Reached> {
    return this.computeFor(address, this.grants(), true).then((reached) => this.keptReach(address, reached))
  }

  /** What a reader reached as it is kept: the same object while it is the same, so a derive pass that clears the cache rebuilds none of their pages. */
  private keptReach(address: string, reached: Reached): Reached {
    const key = address.toLowerCase()
    const last = this.lastReach.get(key)
    if (last && sameReach(last, reached)) return last
    this.lastReach.set(key, reached)
    if (last) this.log.info('what a reader may see moved; their pages are built again', { user: address, grants: reached.size })
    return reached
  }

  /**
   * Whether these grants would let a person or a token in, judged the way
   * every rule in the model is: from the address's own person entity. For a
   * rule or an action's access that is not saved yet, such as a change an
   * admin previews; what the model already holds is read through `view` and
   * `mayRun`.
   */
  async grantsLetIn(address: string, grants: AccessGrant[]): Promise<boolean> {
    if (!grants.length) return false
    return grantsAllow(await this.reachFor(address.toLowerCase(), grants), grants)
  }

  /** Whether a rule lets the identity in on an action that runs on these blueprints, judged under `policy`: the way `gate` judges each rule, before its entity. */
  async ruleLetsIn(identity: Pick<Identity, 'kind' | 'name'>, rule: ActionRule, on: string[], policy: AccessPolicy = this.effective): Promise<boolean> {
    const grants = [...actionGrants(policy, rule), ...(rule.require ?? [])]
    if (!ruleLets(grants.length ? await this.reachFor(identity.name.toLowerCase(), grants) : new Map(), policy, rule)) return false
    return !rule.owns || ownsMeets(await this.ownsOn(identity, on, namesSelf(rule)), rule.owns)
  }

  /** The first of these grants that lets the address in, by index, or -1. */
  async grantLettingIn(address: string, grants: AccessGrant[]): Promise<number> {
    if (!grants.length) return -1
    const reached = await this.reachFor(address.toLowerCase(), grants)
    return grants.findIndex((g) => grantsAllow(reached, [g]))
  }

  /** What the address reaches for these grants: what is kept for it, and only what is not kept read afresh. */
  private async reachFor(address: string, grants: AccessGrant[]): Promise<Reached> {
    const kept = await this.reach(address)
    const missing = grants.filter((g) => !kept.has(grantKey(g)))
    if (!missing.length) return kept
    return new Map([...kept, ...(await this.computeFor(address, missing, false))])
  }

  private async computeFor(address: string, grants: AccessGrant[], logged: boolean): Promise<Reached> {
    const reached: Reached = new Map()
    const me = await this.personRef(address)
    const walked = me ? await this.reader.followAll([me], grants.flatMap((g) => (g.path ? [g.path] : []))) : null
    const self = me && grants.some((g) => !g.path) ? await this.reader.materialize(await this.reader.rowsFor([me])) : []
    for (const g of grants) {
      const k = grantKey(g)
      if (reached.has(k)) continue
      const ends = me ? (g.path ? (walked!.get(g.path)!.get(entityId(me)) ?? []) : self) : []
      reached.set(k, valuesFor(address, g, ends))
    }
    if (logged) this.log.info('access worked out for a person', { user: address, person: me ? entityId(me) : null, grants: grants.length })
    return reached
  }

  /** The sign-in addresses the person blueprint holds, lowercase: each entity's key, or its address field when the setting names one. */
  async personAddresses(): Promise<string[]> {
    const p = this.person
    if (!p) return []
    const { entities } = await this.reader.list({ blueprint: p.blueprint, includeHidden: true, limit: 10_000 })
    const out = new Set<string>()
    for (const e of entities) {
      const v = p.field ? fieldOf(e, p.field) : e.key
      for (const x of Array.isArray(v) ? v : [v]) if (typeof x === 'string' && x.includes('@')) out.add(x.toLowerCase())
    }
    return [...out].sort()
  }

  /**
   * The person entity each address is, read together: by key in one read, or
   * through the address field over the person list. An address the field
   * holds on more than one entity, or holds only as part of a longer value,
   * is looked up alone, the way `personRef` looks it up.
   */
  /** The entity that is this person, by their address, when the estate holds one. */
  async personOf(address: string): Promise<EntityRef | null> {
    const key = address.toLowerCase()
    return (await this.peopleKept([key])).get(key) ?? null
  }

  /** The person entity of each address, as kept: the ones not kept are read together. */
  private async peopleKept(addresses: string[]): Promise<Map<string, EntityRef>> {
    const missing = addresses.filter((a) => !this.people.has(a))
    if (missing.length) {
      const read = this.personRefs(missing)
      for (const a of missing) {
        const one = read.then((refs) => refs.get(a) ?? null)
        // A failed read is read again by the next ask.
        one.catch(() => this.people.get(a) === one && this.people.delete(a))
        this.people.set(a, one)
      }
    }
    const out = new Map<string, EntityRef>()
    for (const a of addresses) {
      const ref = await this.people.get(a)!
      if (ref) out.set(a, ref)
    }
    return out
  }

  private async personRefs(addresses: string[]): Promise<Map<string, EntityRef>> {
    const p = this.person
    const out = new Map<string, EntityRef>()
    if (!p) return out
    if (!p.field) {
      for (const row of await this.reader.rowsFor(addresses.map((key) => ({ blueprint: p.blueprint, key })))) out.set(row.key, { blueprint: p.blueprint, key: row.key })
      return out
    }
    const { entities } = await this.reader.list({ blueprint: p.blueprint, includeHidden: true, limit: 100_000 })
    const holders = new Map<string, EntityRef[]>()
    for (const e of entities) {
      const v = fieldOf(e, p.field)
      for (const x of Array.isArray(v) ? v : [v]) if (typeof x === 'string') holders.set(x.toLowerCase(), [...(holders.get(x.toLowerCase()) ?? []), { blueprint: e.blueprint, key: e.key }])
    }
    for (const address of addresses) {
      const hit = holders.get(address)
      if (hit?.length === 1) {
        out.set(address, hit[0]!)
        continue
      }
      // Read as `personRef` reads it, over the list already in hand: the first, in list order, whose text holds the address or whose list names it.
      const found = entities.filter((e) => answersTo(fieldOf(e, p.field!), address))
      if (found.length > 1) this.log.warn('more than one person entity answers to a sign-in address; access reads the first', { user: address, blueprint: p.blueprint, field: p.field })
      if (found[0]) out.set(address, { blueprint: found[0].blueprint, key: found[0].key })
    }
    return out
  }

  /**
   * Puts on each entity the person each of its `user` values names, by the
   * address in lowercase, so a view can link to them. Only a person entity
   * the reader may see is named, under its title; an address that is nobody
   * here, or someone they may not see, is left as the text it is. Run after
   * the view, so a value it withheld names nobody.
   */
  /** The person entity each address is, under its title and picture, by lowercase address: only those the reader may see. */
  async peopleShown(view: View, addresses: string[]): Promise<Record<string, PersonShown>> {
    const p = this.person
    if (!p || !addresses.length || !view.seesSome(p.blueprint)) return {}
    const seen = [...(await this.peopleKept([...new Set(addresses.map(addressKey))]))].filter(([, ref]) => view.seesEntity(ref))
    const heads = await this.reader.headsOf(seen.map(([, ref]) => ref))
    return Object.fromEntries(seen.flatMap(([address, ref]) => {
      const head = heads.get(entityId(ref))
      return head ? [[address, { ...ref, title: head.title, icon: head.icon }]] : []
    }))
  }

  async annotatePeople(view: View, list: Entity[]): Promise<void> {
    const p = this.person
    if (!p || !list.length || !view.seesSome(p.blueprint)) return
    const named = new Map<Entity, string[]>()
    // The people each row links to, whose pictures its relations draw.
    const linked = new Map<string, EntityRef>()
    for (const e of list) {
      const fields = this.blueprints.get(e.blueprint)?.fields ?? {}
      const addresses = Object.entries(fields).flatMap(([name, def]) => (def.type === 'user' ? addressesIn(e.fields[name]) : []))
      if (addresses.length) named.set(e, addresses)
      for (const refs of [...Object.values(e.relations), ...Object.values(e.incomingRefs ?? {})]) for (const r of refs) if (r.blueprint === p.blueprint && view.seesEntity(r)) linked.set(entityId(r), r)
    }
    if (!named.size && !linked.size) return
    const refs = await this.peopleKept([...new Set([...named.values()].flat())])
    const seen = [...refs].filter(([, ref]) => view.seesEntity(ref))
    if (!seen.length && !linked.size) return
    const heads = await this.reader.headsOf([...seen.map(([, ref]) => ref), ...linked.values()])
    const shown = new Map<string, PersonShown>()
    for (const [address, ref] of seen) {
      const head = heads.get(entityId(ref))
      if (head) shown.set(address, { ...ref, title: head.title, icon: head.icon })
    }
    for (const [e, addresses] of named) {
      const people = Object.fromEntries(addresses.flatMap((a) => (shown.has(a) ? [[a, shown.get(a)!]] : [])))
      if (Object.keys(people).length) e.people = people
    }
    if (!linked.size) return
    const pictured = (refs: RelatedRef[]) => refs.map((r) => (r.blueprint === p.blueprint && heads.has(entityId(r)) ? { ...r, icon: heads.get(entityId(r))!.icon } : r))
    for (const e of list) {
      e.relations = Object.fromEntries(Object.entries(e.relations).map(([k, refs]) => [k, pictured(refs)]))
      if (e.incomingRefs) e.incomingRefs = Object.fromEntries(Object.entries(e.incomingRefs).map(([k, refs]) => [k, pictured(refs)]))
    }
  }

  /**
   * What a person owns: every entity a path of the setting's `owns` reaches
   * from their entity, by id, with the roles of every path that reached it.
   * `unset` when the model does not say what a person owns; `unknown` when
   * the address is no person it holds.
   */
  async owned(address: string, roles: Set<string> | 'any' | null = 'any'): Promise<{ state: 'unset' } | { state: 'unknown' } | { state: 'known'; person: EntityRef; ids: ReadonlyMap<string, string[]> }> {
    if (!this.ownsPathsFor(roles).length) return { state: 'unset' }
    const whole = (await this.ownedMany([address])).get(address.toLowerCase())!
    if (whole.state !== 'known' || roles === 'any') return whole
    return { state: 'known', person: whole.person, ids: this.cut(whole.ids, roles!) }
  }

  /** What a person owns by the roles asked alone, kept beside the whole answer while it stands. */
  private cut(ids: ReadonlyMap<string, string[]>, roles: Set<string> | 'any' | null): ReadonlyMap<string, string[]> {
    if (roles === 'any') return ids
    const key = roles ? [...roles].sort().join('\n') : ''
    let kept = this.ownsCut.get(ids)
    if (!kept) this.ownsCut.set(ids, (kept = new Map()))
    let out = kept.get(key)
    if (!out) {
      out = new Map()
      for (const [id, as] of ids) {
        const mine = roles ? as.filter((r) => roles.has(r)) : []
        if (mine.length) out.set(id, mine)
      }
      kept.set(key, out)
    }
    return out
  }

  /**
   * `owned` by every path for many people at once, by lowercase address:
   * their entities read together and every path walked once from all of
   * them, rather than a few queries a person.
   */
  async ownedMany(addresses: string[]): Promise<Map<string, Owned>> {
    const keys = [...new Set(addresses.map((a) => a.toLowerCase()))]
    const paths = this.ownsPathsFor('any')
    if (!paths.length) return new Map(keys.map((k) => [k, { state: 'unset' }]))
    const refs = await this.peopleKept(keys)
    const found = [...new Map([...refs.values()].map((r) => [entityId(r), r])).values()]
    const owned = await this.ownership.of(found)
    const out = new Map<string, Owned>()
    for (const key of keys) {
      const me = refs.get(key)
      out.set(key, me ? { state: 'known', person: me, ids: owned.get(entityId(me))! } : { state: 'unknown' })
    }
    return out
  }

  /** The paths of the setting's `owns` that carry one of these roles, or all of them. */
  private ownsPathsFor(roles: Set<string> | 'any' | null): OwnsPath[] {
    return ownsPaths(this.person?.owns).filter((p) => roles === 'any' || (!!roles && !!p.as && roles.has(p.as)))
  }

  /** The one entity that is this person, read alone: the first whose address field holds the address, or whose text or list names it. */
  private async personRef(address: string): Promise<EntityRef | null> {
    const p = this.person
    if (!p) return null
    if (!p.field) return (await this.reader.rowsFor([{ blueprint: p.blueprint, key: address }])).length ? { blueprint: p.blueprint, key: address } : null
    const { entities } = await this.reader.list({ blueprint: p.blueprint, includeHidden: true, limit: 2, filter: { or: [{ field: p.field, op: 'eq', value: address }, { field: p.field, op: 'contains', value: address }] } })
    if (entities.length > 1) this.log.warn('more than one person entity answers to a sign-in address; access reads the first', { user: address, blueprint: p.blueprint, field: p.field })
    const e = entities[0]
    return e ? { blueprint: e.blueprint, key: e.key } : null
  }

  private grants(): AccessGrant[] {
    const out: AccessGrant[] = []
    for (const bp of this.blueprints.list()) out.push(...blueprintGrants(bp))
    for (const a of this.actions.list()) out.push(...actionGrantLists(a.access))
    out.push(...policyGrants(this.effective))
    return out
  }

  blueprintsModel(): Blueprints {
    return this.blueprints
  }

  /** The blueprints `owned` reads: what a person owns stands while none of them moves. */
  ownedReads(): ReadonlySet<string> {
    return this.ownedReadsAll
  }

  /** What each field's rule resolves to, by policy: kept while the model holds the same blueprints. */
  private readonly fieldGrantsKept = new WeakMap<AccessPolicy, { model: Blueprint[]; grants: FieldGrants }>()

  /**
   * Every field's rule as the grants it lets in by, null where the field is
   * open: its class's rule when a class takes it, else its own. The same for
   * every reader of one policy and model, so worked out once for them all.
   */
  fieldGrants(policy: AccessPolicy): FieldGrants {
    const model = this.blueprints.list()
    const kept = this.fieldGrantsKept.get(policy)
    if (kept && kept.model.length === model.length && kept.model.every((bp, i) => bp === model[i])) return kept.grants
    const grants: FieldGrants = new Map(model.map((bp) => [bp.id, Object.entries(bp.fields).map(([name, def]) => [name, resolveRule(policy, fieldRule(policy, bp.id, name, def.access))] as const)]))
    this.fieldGrantsKept.set(policy, { model, grants })
    return grants
  }
}

/** Each blueprint's fields, each with the grants that let a reader see it, null when anyone may. */
type FieldGrants = ReadonlyMap<string, readonly (readonly [string, AccessGrant[] | null])[]>

/** A policy that cannot be saved: an unknown audience, a loop, a class with no audience, or one owned by git. */
export class PolicyError extends Error {}

/** The values one grant reads for an address: the address itself for a grant with no path or field, and what it reads at the ends of its path. */
function valuesFor(address: string, g: AccessGrant, ends: Entity[]): Set<string> {
  const values = new Set<string>()
  if (!g.path && !g.field) values.add(address)
  for (const e of ends) {
    for (const v of g.field ? [fieldOf(e, g.field)] : [e.key, e.title]) {
      for (const x of Array.isArray(v) ? v : [v]) if (typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean') values.add(String(x).toLowerCase())
    }
  }
  return values
}

function grantKey(g: AccessGrant): string {
  return `${g.path ?? ''}|${g.field ?? ''}`
}

/** Whether any grant lets the person in, given what every grant reached from their entity. */
function grantsAllow(reached: Reached, grants: AccessGrant[]): boolean {
  return grants.some((g) => {
    const got = reached.get(grantKey(g))
    return !!got && g.values.some((x) => got.has(x.toLowerCase()))
  })
}

/**
 * Whether a rule's who-part lets a person in: any of its audiences and grants (anyone signed in when it names
 * neither), and every grant it requires.
 */
/** Whether what a person owns, by role, meets a rule's `owns`: anything for `true`, or one of the roles it names. */
/** Whether what a person owns meets a rule's `owns`. `true` is theirs by any ownership path; `self` counts only where a rule names it. */
function ownsMeets(owning: Owning | null, owns: true | string[]): boolean {
  return !!owning && (owns === true ? owning.byPath : owns.some((r) => owning.roles.has(r)))
}

/** What a person owns among the blueprints an action runs on: the roles, and whether any of it is theirs by an ownership path rather than as `self` alone. */
interface Owning {
  roles: Set<string>
  byPath: boolean
}

function ruleLets(reached: Reached, policy: AccessPolicy, r: ActionRule): boolean {
  const who = r.audiences?.length || r.grants?.length ? grantsAllow(reached, actionGrants(policy, r)) : true
  return who && (r.require ?? []).every((g) => grantsAllow(reached, [g]))
}

/** Nothing withheld. */
/** The basis of every view that withholds nothing. */
const UNRESTRICTED = Object.freeze({})

class Everything implements View {
  readonly all = true
  readonly admin: boolean
  readonly basis = UNRESTRICTED
  constructor(_v: Visibility, admin: boolean) {
    this.admin = admin
  }
  seesBlueprint(): boolean {
    return true
  }
  ownedOnly(): null {
    return null
  }
  aboutOnly(): null {
    return null
  }
  oneByOne(): null {
    return null
  }
  seesSome(): boolean {
    return true
  }
  seesEntity(): boolean {
    return true
  }
  lets(): boolean {
    return true
  }
  readsTimeline(): boolean {
    return true
  }
  hiddenFields(): ReadonlySet<string> {
    return new Set()
  }
  ownerOpened(): ReadonlySet<string> {
    return NONE
  }
  summaries(): ReadonlySet<string> {
    return NONE
  }
  openedTo(): OpenedField[] {
    return []
  }
  entities(list: Entity[]): Entity[] {
    return list
  }
  entity(e: Entity): Entity {
    return e
  }
  detail(d: EntityDetail): EntityDetail {
    return d
  }
  changes(rows: Change[]): Change[] {
    return rows
  }
  findings(list: Finding[]): Finding[] {
    return list
  }
  alerts(list: Alert[]): Alert[] {
    return list
  }
  checks(list: AssignedCheckView[]): AssignedCheckView[] {
    return list
  }
  distribution(_b: string, d: Record<string, ColumnDistribution>): Record<string, ColumnDistribution> {
    return d
  }
  refusedFilter(): null {
    return null
  }
  refusedQuery(): null {
    return null
  }
  seesAction(): boolean {
    return true
  }
  runs(list: ActionRun[]): ActionRun[] {
    return list
  }
}

/** A person: what no grant lets them see is left out. */
class Restricted implements View {
  readonly all = false
  readonly admin = false
  /** What each blueprint withholds; null until first asked, then filled for every blueprint at once. */
  private hidden: Map<string, Set<string>> | null = null
  /** What each blueprint shows only as a summary; filled with `hidden`. */
  private summarised = new Map<string, Set<string>>()
  /** Of that, what a blueprint seen only as an owner withholds because its rule does not name it: no class opens it again. */
  private unlisted = new Map<string, Set<string>>()
  /** Of what each blueprint withholds, what a class opens on the entities the reader owns, and how. */
  private opened: Map<string, Map<string, ClassOwned>> | null = null
  private readonly visible = new Map<string, boolean>()
  /** Of each blueprint opened to owners and not otherwise seen, the ids of the reader's own; filled when first asked. */
  private readonly theirs = new Map<string, ReadonlySet<string> | null>()
  private readonly v: Visibility
  private readonly reached: Reached
  private readonly policy: AccessPolicy
  private readonly owns: Owns
  private readonly abouts: Abouts
  readonly basis: object

  constructor(v: Visibility, reached: Reached, policy: AccessPolicy, owns: Owns, abouts: Abouts, basis: object) {
    this.v = v
    this.reached = reached
    this.policy = policy
    this.owns = owns
    this.abouts = abouts
    this.basis = basis
  }

  lets(rule: AccessRule | undefined): boolean {
    const grants = resolveRule(this.policy, rule)
    return grants === null || grantsAllow(this.reached, grants)
  }

  readsTimeline(blueprint: string): boolean {
    const rule = this.bp(blueprint)?.timeline
    return !rule || this.lets(rule)
  }

  private bp(id: string): Blueprint | undefined {
    return this.v.blueprintsModel().get(id)
  }

  seesBlueprint(id: string): boolean {
    let seen = this.visible.get(id)
    if (seen === undefined) {
      seen = this.lets(this.bp(id)?.access)
      this.visible.set(id, seen)
    }
    return seen
  }

  ownedOnly(blueprint: string): ReadonlySet<string> | null {
    if (this.theirs.has(blueprint)) return this.theirs.get(blueprint)!
    const owners = this.seesBlueprint(blueprint) ? undefined : this.bp(blueprint)?.access?.owners
    let ids: Set<string> | null = null
    if (owners) {
      const prefix = `${blueprint}:`
      ids = new Set([...this.owns].filter(([id, roles]) => id.startsWith(prefix) && roles.some((r) => owners.roles.includes(r))).map(([id]) => id))
    }
    this.theirs.set(blueprint, ids)
    return ids
  }

  aboutOnly(blueprint: string): ReadonlySet<string> | null {
    return this.seesBlueprint(blueprint) ? null : (this.abouts.get(blueprint) ?? null)
  }

  oneByOne(blueprint: string): ReadonlySet<string> | null {
    const owned = this.ownedOnly(blueprint)
    const about = this.aboutOnly(blueprint)
    if (!owned?.size) return about?.size ? about : owned
    if (!about?.size) return owned
    return new Set([...owned, ...about])
  }

  seesSome(blueprint: string): boolean {
    return this.seesBlueprint(blueprint) || (this.ownedOnly(blueprint)?.size ?? 0) > 0 || (this.aboutOnly(blueprint)?.size ?? 0) > 0
  }

  seesEntity(ref: EntityRef): boolean {
    if (this.seesBlueprint(ref.blueprint)) return true
    const id = entityId(ref)
    return (this.ownedOnly(ref.blueprint)?.has(id) ?? false) || (this.aboutOnly(ref.blueprint)?.has(id) ?? false)
  }

  hiddenFields(blueprint: string): ReadonlySet<string> {
    if (!this.hidden) this.solve()
    return this.hidden!.get(blueprint) ?? NONE
  }

  ownerOpened(blueprint: string): ReadonlySet<string> {
    return new Set(this.openedOn(blueprint).keys())
  }

  summaries(blueprint: string): ReadonlySet<string> {
    if (!this.hidden) this.solve()
    return this.summarised.get(blueprint) ?? NONE
  }

  /** The summaries of a blueprint that are neither a plain number nor checks: a trend. Its value carries more than it shows, so nothing else may read it: no filter, no sort, no search, and no other derived field. */
  private sealed(blueprint: string): string[] {
    const bp = this.bp(blueprint)
    // A number and checks are all a reader is shown of them, so a filter on them answers nothing more; a trend carries more than its points.
    return [...(this.summarised.get(blueprint) ?? NONE)].filter((name) => bp?.fields[name]?.type !== 'number' && bp?.fields[name]?.aggregation?.fn !== 'checks')
  }

  openedTo(blueprint: string): OpenedField[] {
    const out: OpenedField[] = []
    for (const [field, how] of this.openedOn(blueprint)) {
      const ids = [...this.owns].filter(([, roles]) => !how.roles.length || roles.some((r) => how.roles.includes(r))).map(([id]) => id)
      out.push({ field, ids, through: how.through })
    }
    return out
  }

  private openedOn(blueprint: string): ReadonlyMap<string, ClassOwned> {
    if (!this.opened) {
      this.opened = new Map()
      for (const bp of this.v.blueprintsModel().list()) {
        const out = new Map<string, ClassOwned>()
        const hiddenHere = this.hiddenFields(bp.id)
        const unlisted = this.unlisted.get(bp.id)
        for (const name of hiddenHere) {
          if (unlisted?.has(name)) continue
          const c = classFor(this.policy, bp.id, name)
          if (opensToOwners(c)) out.set(name, c.owned)
        }
        if (out.size) this.opened.set(bp.id, out)
      }
    }
    return this.opened.get(blueprint) ?? EMPTY_OPENED
  }

  /**
   * What this reader may not see on one entity: what the blueprint withholds,
   * less what a class opens to them because they own the entity, or own what
   * it points at through the class's relations. What is theirs is judged
   * only through blueprints they may see, so a key they are not shown never
   * decides it.
   */
  hiddenOn(e: Entity): ReadonlySet<string> {
    const hidden = this.hiddenFields(e.blueprint)
    const opened = this.openedOn(e.blueprint)
    if (!opened.size || !this.owns.size) return hidden
    let out: Set<string> | null = null
    for (const [name, how] of opened) {
      if (!this.ownsEntity(e, how)) continue
      out ??= new Set(hidden)
      out.delete(name)
    }
    return out ?? hidden
  }

  private ownsEntity(e: Entity, how: ClassOwned): boolean {
    const ids = [e.id, ...how.through.flatMap((r) => (e.relations[r] ?? []).filter((t) => this.seesBlueprint(t.blueprint)).map((t) => entityId(t)))]
    return ids.some((id) => {
      const roles = this.owns.get(id)
      return !!roles && (!how.roles.length || roles.some((r) => how.roles.includes(r)))
    })
  }

  /**
   * Fields withheld by their own rule, and every derived field that reads one,
   * through any path, worked out for the whole model at once. Derived fields
   * read each other across blueprints, in cycles too, so start from the
   * fields a rule withholds and go round until nothing more is withheld. A
   * check made while going round reads the sets as they stand, which only
   * grow, so the answer is the same whatever order the model is walked in.
   *
   * An aggregation marked `summary` is the one derived field that reads what
   * is withheld and is still shown: it joins the summaries instead, and those
   * only grow too.
   */
  private solve(): void {
    const model = this.v.blueprintsModel().list()
    const hidden = new Map<string, Set<string>>()
    const rules = this.v.fieldGrants(this.policy)
    for (const bp of model) hidden.set(bp.id, new Set((rules.get(bp.id) ?? []).filter(([, grants]) => grants !== null && !grantsAllow(this.reached, grants)).map(([name]) => name)))
    // A blueprint the reader sees only as an owner shows them the fields its rule names, and no other.
    this.unlisted = new Map()
    for (const bp of model) {
      const listed = this.seesBlueprint(bp.id) ? undefined : bp.access?.owners?.fields
      if (!Array.isArray(listed)) continue
      const out = new Set(Object.keys(bp.fields).filter((name) => !listed.includes(name)))
      this.unlisted.set(bp.id, out)
      for (const name of out) hidden.get(bp.id)!.add(name)
    }
    this.hidden = hidden
    const summarised = new Map<string, Set<string>>(model.map((bp) => [bp.id, new Set()]))
    this.summarised = summarised
    const all = this.v.blueprintsModel()
    for (let changed = true; changed; ) {
      changed = false
      for (const bp of model) {
        const out = hidden.get(bp.id)!
        const shown = summarised.get(bp.id)!
        for (const [name, def] of Object.entries(bp.fields)) {
          if (out.has(name) || shown.has(name)) continue
          if (this.readsWithheld(bp, def, out)) out.add(name)
          else if (summarises(bp, def, (id) => all.get(id), model) && this.aggregationWithheld(bp, def.aggregation!)) shown.add(name)
          else continue
          changed = true
        }
      }
    }
  }

  private readsWithheld(bp: Blueprint, def: FieldDef, own: ReadonlySet<string>): boolean {
    if (def.pivoted && own.has(def.pivoted.field)) return true
    if (def.history && 'of' in def.history && own.has(def.history.of)) return true
    if (def.calculation) {
      const sealed = this.sealed(bp.id)
      if (wordsOf(def.calculation).some((w) => own.has(w) || sealed.includes(w))) return true
    }
    if (def.mirror) {
      const { path, field } = splitMirror(def.mirror)
      const end = this.through(bp, path)
      if (end === null) return true
      if (end && (this.hiddenFields(end.id).has(field) || this.sealed(end.id).includes(field))) return true
    }
    // A summary is shown whatever it reads: that is what the mark says.
    if (def.aggregation && !summarises(bp, def, (id) => this.bp(id), this.v.blueprintsModel().list())) return this.aggregationWithheld(bp, def.aggregation)
    return false
  }

  /** Whether an aggregation reads something the reader may not see: a blueprint on its path, or a field of the entities at its end. */
  private aggregationWithheld(bp: Blueprint, agg: NonNullable<FieldDef['aggregation']>): boolean {
    const end = this.through(bp, agg.relation)
    if (end === null) return true
    if (!end && agg.where && scorecardsIn(agg.where).some((id) => this.refusedFilter(undefined, { scorecard: id, op: 'exists' }))) return true
    if (end) {
      const theirs = this.hiddenFields(end.id)
      const sealed = this.sealed(end.id)
      const closed = (name: string) => theirs.has(name) || sealed.includes(name)
      if (agg.field && closed(agg.field)) return true
      if (agg.window && closed(agg.window.field)) return true
      if (agg.where && fieldsIn(agg.where).some(closed)) return true
      if (agg.where && this.refusedFilter(end.id, agg.where)) return true
    }
    return false
  }

  /** The blueprint at the end of a path; null when it passes through one the reader may not see, undefined when the end is not known. */
  private through(from: Blueprint, path: string): Blueprint | null | undefined {
    let hops
    try {
      hops = parsePath(path)
    } catch {
      return undefined
    }
    let at: Blueprint | undefined = from
    for (const hop of hops) {
      if (!at) return undefined
      if (hop.incoming) {
        const declaring = hop.from ? [this.bp(hop.from)].filter((b): b is Blueprint => !!b) : this.v.blueprintsModel().list().filter((b) => b.relations[hop.relation]?.target === at!.id)
        if (declaring.some((d) => !this.seesBlueprint(d.id))) return null
        at = hop.from ? this.bp(hop.from) : undefined
      } else {
        const rel: Blueprint['relations'][string] | undefined = at.relations[hop.relation]
        if (!rel) return undefined
        if (!this.seesBlueprint(rel.target)) return null
        at = this.bp(rel.target)
      }
    }
    return at
  }

  /**
   * A link to an entity the reader may not see is left out, and so is the
   * relation that holds it: its name, its count, and that it is there at all
   * would tell them what they may not see. A relation targets one blueprint,
   * so a relation is kept whole or dropped whole.
   */
  private refs<T>(map: Record<string, T>, keep: (key: string) => boolean): Record<string, T> {
    return Object.fromEntries(Object.entries(map).filter(([k]) => keep(k)))
  }

  /**
   * The links of a relation as the reader sees them: all of them when they
   * see the blueprint at the far end, only the ones they see one by one when
   * it opens to them as an owner or as about what they see, and none
   * otherwise. A relation left with no link is dropped.
   */
  private links(map: Record<string, RelatedRef[]>, far: (key: string) => string | undefined): Record<string, RelatedRef[]> {
    const out: Record<string, RelatedRef[]> = {}
    for (const [k, list] of Object.entries(map)) {
      const bp = far(k)
      if (!bp || this.seesBlueprint(bp)) out[k] = list
      else if (this.oneByOne(bp)) {
        const mine = list.filter((r) => this.seesEntity(r))
        if (mine.length) out[k] = mine
      }
    }
    return out
  }

  /** True when the reader sees the blueprint an incoming key (`blueprint.relation`) is declared on. */
  private seesIncoming(key: string): boolean {
    return this.seesBlueprint(key.slice(0, key.indexOf('.')))
  }

  entity(e: Entity): Entity | null {
    if (!this.seesEntity(e)) return null
    const hidden = this.hiddenOn(e)
    const fields = Object.fromEntries(Object.entries(e.fields).filter(([k]) => !hidden.has(k)))
    // A summary is its number alone: a trend loses its link, and anything else is not a summary and is left out.
    for (const name of this.summaries(e.blueprint)) {
      if (!(name in fields)) continue
      const value = summaryValue(fields[name], this.bp(e.blueprint)?.fields[name]?.aggregation?.fn === 'checks')
      if (value === undefined) delete fields[name]
      else fields[name] = value
    }
    const relations = this.links(e.relations, (k) => this.bp(e.blueprint)?.relations[k]?.target)
    const incomingRefs = e.incomingRefs ? this.links(e.incomingRefs, (k) => k.slice(0, k.indexOf('.'))) : undefined
    // A count of links to what opens to the reader only as theirs counts their own alone.
    const counted = (k: string) => (this.seesIncoming(k) ? e.incomingCount![k]! : incomingRefs?.[k]?.length)
    return {
      ...e,
      fields,
      relations,
      ...(e.relationLayers ? { relationLayers: this.refs(e.relationLayers, (k) => k in relations) } : {}),
      ...(incomingRefs ? { incomingRefs } : {}),
      ...(e.incomingCount ? { incomingCount: Object.fromEntries(Object.keys(e.incomingCount).flatMap((k) => (counted(k) ? [[k, counted(k)!]] : []))) } : {}),
      ...(e.layers ? { layers: Object.fromEntries(Object.entries(e.layers).filter(([k]) => !hidden.has(k))) } : {}),
      ...(e.levels ? { levels: Object.fromEntries(Object.entries(e.levels).filter(([id]) => !this.levelWithheld(id, new Set()))) } : {}),
      status: { level: e.status.level, reasons: this.reasons(e, hidden) },
    }
  }

  /**
   * Status reasons name what fed them: a related entity the reader may not
   * see, a check on a field they may not read, or the reason a status field
   * gives when the reader may not read the field or its reason, is not named.
   */
  private reasons(e: Entity, hidden: ReadonlySet<string>): string[] {
    const from = rollupSources.get(e)
    const statusField = this.bp(e.blueprint)?.status?.field
    const fieldReason = statusField && (hidden.has(statusField) || hidden.has(`${statusField}_reason`)) ? e.fields[`${statusField}_reason`] : undefined
    const out: string[] = []
    let withheld = false
    for (const r of e.status.reasons) {
      const bp = from?.get(r)
      if ((bp && !this.seesBlueprint(bp)) || r === fieldReason || [...hidden].some((f) => r.startsWith(`${f}:`) || r.startsWith(`${f} from `))) withheld = true
      else out.push(r)
    }
    if (withheld) out.push(ALL_REASON)
    return out
  }

  entities(list: Entity[]): Entity[] {
    return list.map((e) => this.entity(e)).filter((e): e is Entity => !!e)
  }

  detail(d: EntityDetail): EntityDetail | null {
    const e = this.entity(d)
    if (!e) return null
    const hidden = this.hiddenOn(d)
    const provenance: Record<string, FieldProvenance> = Object.fromEntries(Object.entries(d.provenance).filter(([k]) => !hidden.has(k)))
    return { ...d, ...e, provenance, outgoing: this.ends(d.outgoing), incoming: this.ends(d.incoming), changes: this.changes(d.changes) }
  }

  /** An end the reader may not see is left out, never named. */
  private ends(ends: RelationEnd[]): RelationEnd[] {
    return ends.filter((end) => this.seesEntity(end.target))
  }

  changes(rows: Change[]): Change[] {
    return rows.filter((r) => {
      if (r.blueprint && !(r.key ? this.seesEntity({ blueprint: r.blueprint, key: r.key }) : this.seesBlueprint(r.blueprint))) return false
      // What happened to one entity is its timeline, which its blueprint may keep to fewer people than see the entity.
      if (r.blueprint && r.key && !this.readsTimeline(r.blueprint)) return false
      const field = typeof r.detail.field === 'string' ? r.detail.field : null
      return !(r.blueprint && field && this.hiddenFields(r.blueprint).has(field))
    }).map((r) => {
      // A hand edit keeps the values it replaced; one of a field the reader may not see is not theirs to read.
      const was = r.detail.was
      if (!r.blueprint || !was || typeof was !== 'object') return r
      const hidden = this.hiddenFields(r.blueprint)
      const kept = Object.fromEntries(Object.entries(was as Record<string, unknown>).filter(([name]) => !hidden.has(name)))
      return Object.keys(kept).length === Object.keys(was).length ? r : { ...r, detail: { ...r.detail, was: kept } }
    })
  }

  findings(list: Finding[]): Finding[] {
    return list
      .filter((f) => (!f.entity || this.seesEntity(f.entity)) && (!f.target || this.seesEntity(f.target)) && (!f.blueprint || (f.entity ? this.seesEntity(f.entity) : this.seesBlueprint(f.blueprint))))
      .filter((f) => {
        const bp = f.entity?.blueprint ?? f.blueprint
        return !(bp && f.field && this.hiddenFields(bp).has(f.field))
      })
      .map((f) => (f.entities ? { ...f, entities: f.entities.filter((r) => this.seesEntity(r)) } : f))
      .filter((f) => !f.entities || f.entities.length > 0)
  }

  /** An alert matched to nothing may name anything in its labels, so only a reader who sees everything sees it. */
  alerts(list: Alert[]): Alert[] {
    return list.filter((a) => !!a.entity && this.seesEntity(a.entity))
  }

  checks(list: AssignedCheckView[]): AssignedCheckView[] {
    return list.filter((c) => this.seesBlueprint(c.entity.blueprint) && !this.hiddenFields(c.entity.blueprint).has(c.field))
  }

  /** Counted over the rows as the view left them, so a field opened on the reader's own rows counts those alone. */
  distribution(blueprint: string, d: Record<string, ColumnDistribution>): Record<string, ColumnDistribution> {
    const hidden = this.hiddenFields(blueprint)
    const opened = this.openedOn(blueprint)
    const bp = this.bp(blueprint)
    return Object.fromEntries(
      Object.entries(d).filter(([k]) => {
        if (k.startsWith('f:') && this.sealed(blueprint).includes(k.slice(2))) return false
        if (k.startsWith('f:')) return !hidden.has(k.slice(2)) || opened.has(k.slice(2))
        if (k.startsWith('r:')) {
          const target = bp?.relations[k.slice(2)]?.target
          return !target || this.seesBlueprint(target)
        }
        return true
      }),
    )
  }

  /**
   * Whether the reader sees an action: some of each blueprint it runs on,
   * such as the entities a rule opens to them as their owners, and every
   * blueprint its inputs pick from. Which entities it runs on for them is the
   * view's to say, entity by entity.
   */
  seesAction(a: Action): boolean {
    const runsOn = actionTargets(a)
    return runsOn.every((b) => this.seesSome(b)) && actionBlueprints(a, this.v.personSetting()?.blueprint).every((b) => runsOn.includes(b) || this.seesBlueprint(b))
  }

  runs(list: ActionRun[]): ActionRun[] {
    return list.filter((r) => !r.entity || this.seesEntity(r.entity))
  }

  refusedFilter(blueprint: string | undefined, f: Filter): string | null {
    return this.refused(blueprint, f, false)
  }

  refusedQuery(blueprint: string | undefined, f: Filter): string | null {
    return this.refused(blueprint, f, true)
  }

  private refused(blueprint: string | undefined, f: Filter, perRow: boolean): string | null {
    if ('and' in f) return f.and.map((x) => this.refused(blueprint, x, perRow)).find((x) => x) ?? null
    if ('or' in f) return f.or.map((x) => this.refused(blueprint, x, perRow)).find((x) => x) ?? null
    if ('not' in f) return this.refused(blueprint, f.not, perRow)
    if ('relatedTo' in f) {
      const at = f.relatedTo.indexOf(':')
      return at > 0 && !this.seesEntity({ blueprint: f.relatedTo.slice(0, at), key: f.relatedTo.slice(at + 1) }) ? f.relatedTo : null
    }
    if ('relation' in f) {
      const target = f.target ? (f.target.includes(':') ? f.target.slice(0, f.target.indexOf(':')) : undefined) : undefined
      if (target && !this.seesBlueprint(target)) return f.target!
      // A relation to, or from, a blueprint the reader may not see is not there for them: asking whether it is set would tell them.
      const from = blueprint ? this.bp(blueprint) : undefined
      if (from && this.through(from, f.relation) === null) return f.relation
      if (!f.where) return null
      // What it reaches is read for its values: each blueprint it may reach must be one the reader sees, and the filter on them one that reads nothing they may not see.
      for (const end of this.reachable(blueprint, f.relation)) {
        if (!this.seesBlueprint(end)) return f.relation
        const refused = this.refused(end, f.where, perRow)
        if (refused) return refused
      }
      return null
    }
    if ('scorecard' in f) return this.levelWithheld(f.scorecard, new Set()) ? `scorecard ${f.scorecard}` : null
    if ('field' in f && blueprint) {
      const name = f.field.startsWith('fields.') ? f.field.slice(7) : f.field
      if (this.hiddenFields(blueprint).has(name)) return perRow && this.openedOn(blueprint).has(name) ? null : f.field
      // A summary that is a number, or checks, may be asked about: the answer is what they are shown. A trend is shown and never judged.
      return this.sealed(blueprint).includes(name) ? f.field : null
    }
    return null
  }

  /**
   * The blueprints a relation of a filter may reach, by id: from one
   * blueprint, or, with none named, from any that has it. Coming in, the
   * blueprints that declare it.
   */
  private reachable(blueprint: string | undefined, relation: string): string[] {
    let hops
    try {
      hops = parsePath(relation)
    } catch {
      return []
    }
    if (hops.length !== 1) return []
    const hop = hops[0]!
    const all = this.v.blueprintsModel().list()
    const from = blueprint ? all.filter((b) => b.id === blueprint) : all
    if (!hop.incoming) return [...new Set(from.map((b) => b.relations[hop.relation]?.target).filter((t): t is string => !!t))]
    if (hop.from) return [hop.from]
    return [...new Set(all.filter((d) => from.some((b) => d.relations[hop.relation]?.target === b.id)).map((d) => d.id))]
  }

  /** A level is withheld when the scorecard is unknown, or reads a blueprint or a field the reader may not see: the level would tell them the value. */
  private levelWithheld(id: string, seen: Set<string>): boolean {
    const sc = this.v.scorecard(id)
    if (!sc) return true
    if (seen.has(id)) return false
    seen.add(id)
    // A level means the same on every blueprint the scorecard scores, so it is withheld when any of them reads what the reader may not see.
    return partsOf(sc).some((part) => !this.seesBlueprint(part.blueprint) || partFilters(part).some((f) => this.refusedFilter(part.blueprint, f) !== null))
  }
}

/**
 * Whether a field's `summary` mark holds: an aggregation whose result can
 * only be a number, a trend, or checks. A count always is a number, and
 * checks always hold each rule's state and nothing else. Any other function
 * returns what the field it reads holds, so that field must be known, and be
 * a number for a number or a trend for a trend. A mark that does not hold
 * opens nothing.
 */
export function summarises(bp: Blueprint, def: FieldDef, blueprint: (id: string) => Blueprint | undefined, all: Blueprint[]): boolean {
  const agg = def.aggregation
  if (!def.summary || !agg) return false
  if (agg.fn === 'checks') return def.type === 'object'
  if (def.type !== 'number' && def.type !== 'trend') return false
  if (agg.fn === 'count') return def.type === 'number'
  if (!agg.field) return false
  let hops
  try {
    hops = parsePath(agg.relation)
  } catch {
    return false
  }
  let ends: Blueprint[] = [bp]
  for (const hop of hops) {
    ends = ends.flatMap((at) => {
      if (!hop.incoming) return [at.relations[hop.relation] && blueprint(at.relations[hop.relation]!.target)].filter((b): b is Blueprint => !!b)
      return hop.from ? [blueprint(hop.from)].filter((b): b is Blueprint => !!b) : all.filter((b) => b.relations[hop.relation]?.target === at.id)
    })
  }
  return ends.length > 0 && ends.every((end) => end.fields[agg.field!]?.type === def.type)
}

/** A summary's value as a reader of the summary alone gets it: a number as it is, a trend without the link to its history, checks as each rule's state, and nothing else. */
function summaryValue(value: unknown, checks: boolean): unknown {
  if (value === null || typeof value === 'number') return value
  if (checks) return checksOf([value]) ?? undefined
  if (value && typeof value === 'object' && Array.isArray((value as { points?: unknown }).points)) {
    const { link: _l, link_title: _t, ...rest } = value as Record<string, unknown>
    return rest
  }
  return undefined
}

/** Every blueprint an action reads: what it runs on, and what its inputs pick from. */
function actionBlueprints(a: Action, person: string | null | undefined): string[] {
  return [...actionTargets(a), ...Object.values(a.inputs).flatMap((def) => inputPicks(def, person))]
}

/** The field names a filter reads. */
export function fieldsIn(f: Filter): string[] {
  if ('and' in f) return f.and.flatMap(fieldsIn)
  if ('or' in f) return f.or.flatMap(fieldsIn)
  if ('not' in f) return fieldsIn(f.not)
  if ('field' in f) return [f.field.startsWith('fields.') ? f.field.slice(7) : f.field]
  return []
}

/**
 * Which blueprint each status reason a rollup added came from, so a reader
 * who may not see that blueprint is not told what is wrong there. The reader
 * fills it as it computes; nothing else writes it.
 */
export const rollupSources = new WeakMap<Entity, Map<string, string>>()

/** Whether an address field's value names this lowercase address: text that holds it, or a list with it as an item. */
function answersTo(value: unknown, address: string): boolean {
  if (typeof value === 'string') return value.toLowerCase().includes(address)
  return Array.isArray(value) && value.some((x) => x === address)
}

/** The addresses a `user` value holds, in lowercase: one, or each of a list. */
function addressesIn(value: unknown): string[] {
  return (Array.isArray(value) ? value : [value]).flatMap((x) => (typeof x === 'string' && x.trim() ? [addressKey(x)] : []))
}
