// The access policy: named audiences (who) and field classes (what kind of
// data). A rule names audiences instead of writing grants out by hand, and a
// field a class matches takes the class's rule wherever it appears, so one
// change reaches every blueprint and a new blueprint is covered the moment
// it arrives. Both the server and the web app resolve rules through here.

import { RESERVED_PREFIX, type AccessGrant, type AccessRule, type ActionAccess, type Blueprint } from './model.ts'

/**
 * A named set of people. Anyone named in `people`, let in by one of
 * `grants`, or in one of `audiences` is in it. Name people one by one unless
 * everyone a grant reaches, now and later, belongs.
 */
export interface Audience {
  id: string
  title: string
  description?: string
  /** Sign-in addresses, or a machine token's name. Matched without case. */
  people: string[]
  grants: AccessGrant[]
  /** Other audiences whose members are in this one. */
  audiences: string[]
}

/** A field a class leaves alone, and why. */
export interface ClassExclusion {
  /** `blueprint.field`. */
  field: string
  reason: string
}

/**
 * Who else sees a class's fields: whoever owns the entity they sit on. An
 * entity is the reader's when the person setting's `owns` paths reach it, or
 * reach what one of `through` points at, such as its `program`. Only paths
 * whose role is in `roles` count; empty, every role does. The fields stay
 * hidden on every other entity, so a filter, a sort, a count, or an export
 * reads them as blank there.
 */
export interface ClassOwned {
  /** Relations from the entity, one hop each, whose targets the reader owning opens the entity: `program`. */
  through: string[]
  /** The roles from the person setting's `owns` paths that count, such as `program`; empty, any. */
  roles: string[]
}

/**
 * A kind of sensitive field, such as cost. Every field it matches is seen by
 * its audiences alone, on every blueprint, and a rule written on such a field
 * by hand is refused. With `owned`, the owners of an entity see them on that
 * entity too.
 */
export interface FieldClass {
  id: string
  title: string
  description?: string
  audiences: string[]
  /** Field-name patterns, `*` for any run of characters, matched without case: `cost_*`, `*_cents`. */
  match: string[]
  /** Blueprint-id patterns that narrow `match`; empty or left out, every blueprint. */
  blueprints?: string[]
  /** Fields in the class whatever their name: `blueprint.field`. */
  include: string[]
  exclude: ClassExclusion[]
  /** Also open on the entities the reader owns. */
  owned?: ClassOwned
}

/**
 * Who may change which values by hand without holding `entities.edit`: the
 * fields and relations it names, on the blueprints it names, are open to its
 * audiences on every entity, and, with `owned`, to whoever owns the entity.
 * A rule opens nothing else, so a blueprint no rule names stays as it was.
 * It never opens a derived or locked value, one set in git, or one access is
 * decided from, and whoever it lets in only as an owner writes where no
 * source says a value, or where the field is sticky.
 */
export interface EditRule {
  id: string
  title: string
  description?: string
  /** Blueprint-id patterns, `*` for any run of characters: `sw_service`, `it_*`. */
  blueprints: string[]
  /** Field-name patterns, `title` and `icon` among them: `description`, `*`. */
  fields: string[]
  /** Relation-name patterns: `depends_on`. */
  relations: string[]
  /** Whoever is in one of these may change the values on every entity. */
  audiences: string[]
  /** Also whoever owns the entity, the way a class's `owned` says who does. */
  owned?: ClassOwned
}

export interface AccessPolicy {
  audiences: Audience[]
  classes: FieldClass[]
  edits: EditRule[]
}

/** The policy as the hub holds it: what it says, and the git source that declares it, while one does. */
export interface PolicyState {
  policy: AccessPolicy
  /** The git source that owns the policy, or null when it is changed in the hub. */
  source: string | null
}

export const EMPTY_POLICY: AccessPolicy = { audiences: [], classes: [], edits: [] }

export const POLICY_ID = /^[a-z][a-z0-9_-]{0,63}$/

/** A pattern with `*` as a regular expression over the whole name, without case. */
export function globRegExp(pattern: string): RegExp {
  const body = pattern
    .trim()
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${body}$`, 'i')
}

const globCache = new Map<string, RegExp>()
function globMatch(pattern: string, name: string): boolean {
  let re = globCache.get(pattern)
  if (!re) globCache.set(pattern, (re = globRegExp(pattern)))
  return re.test(name)
}

/**
 * Every grant the named audiences hold, their nested audiences included: the
 * people as one grant with no path, then each grant. An unknown audience lets
 * nobody in, and a loop is walked once.
 */
export function audienceGrants(policy: AccessPolicy, ids: readonly string[]): AccessGrant[] {
  const byId = new Map(policy.audiences.map((a) => [a.id, a]))
  const people = new Set<string>()
  const grants: AccessGrant[] = []
  const seen = new Set<string>()
  const walk = (id: string) => {
    if (seen.has(id)) return
    seen.add(id)
    const a = byId.get(id)
    if (!a) return
    for (const p of a.people) people.add(p.trim().toLowerCase())
    grants.push(...a.grants)
    for (const inner of a.audiences) walk(inner)
  }
  for (const id of ids) walk(id)
  return people.size ? [{ values: [...people].sort() }, ...grants] : grants
}

/** The grants a rule lets in by, its audiences expanded; null when there is no rule, which is open. */
export function resolveRule(policy: AccessPolicy, rule: Pick<AccessRule, 'grants' | 'audiences'> | undefined): AccessGrant[] | null {
  if (!rule) return null
  return [...(rule.grants ?? []), ...audienceGrants(policy, rule.audiences ?? [])]
}

/** The grants an action's access lets run by, its audiences expanded. */
export function actionGrants(policy: AccessPolicy, access: ActionAccess | undefined): AccessGrant[] {
  return [...(access?.grants ?? []), ...audienceGrants(policy, access?.audiences ?? [])]
}

/** Every grant an action's access names: its own and each rule's, audiences left as they are. For what a grant's path reads, not for who it lets in. */
export function actionGrantLists(access: ActionAccess | undefined): AccessGrant[] {
  return [...(access?.grants ?? []), ...(access?.rules ?? []).flatMap((r) => [...(r.grants ?? []), ...(r.require ?? [])])]
}

/** Whether a rule says anything at all: a grant, an audience, or owners. */
export function hasRule(rule: Pick<AccessRule, 'grants' | 'audiences' | 'owners'> | undefined): boolean {
  return !!rule && ((rule.grants?.length ?? 0) > 0 || (rule.audiences?.length ?? 0) > 0 || !!rule.owners)
}

/**
 * The class a field belongs to, or null. An exclusion wins, then an explicit
 * member, then the first class whose patterns match; the hub's own
 * blueprints are never classed.
 */
export function classFor(policy: AccessPolicy, blueprint: string, field: string): FieldClass | null {
  if (blueprint.startsWith(RESERVED_PREFIX)) return null
  const ref = `${blueprint}.${field}`
  for (const c of policy.classes) if (c.include.includes(ref) && !c.exclude.some((x) => x.field === ref)) return c
  for (const c of policy.classes) {
    if (c.exclude.some((x) => x.field === ref)) continue
    if (c.blueprints?.length && !c.blueprints.some((p) => globMatch(p, blueprint))) continue
    if (c.match.some((p) => globMatch(p, field))) return c
  }
  return null
}

/** Whether an edit rule names a blueprint; the hub's own blueprints are named by none. */
export function editCovers(rule: EditRule, blueprint: string): boolean {
  return !blueprint.startsWith(RESERVED_PREFIX) && rule.blueprints.some((p) => globMatch(p, blueprint))
}

/** The edit rules that name one field or relation of a blueprint. */
export function editRulesFor(policy: AccessPolicy, blueprint: string, name: string, kind: 'field' | 'relation'): EditRule[] {
  return policy.edits.filter((r) => editCovers(r, blueprint) && (kind === 'field' ? r.fields : r.relations).some((p) => globMatch(p, name)))
}

/** Whether one of the roles a person owns something by is one a rule's `owned` counts: any, when it names none. */
export function ownedCounts(how: ClassOwned, roles: readonly string[] | undefined): boolean {
  return !!roles && (!how.roles.length || roles.some((r) => how.roles.includes(r)))
}

/** The rule that decides who sees a field: its class's when it has one, else its own. */
export function fieldRule(policy: AccessPolicy, blueprint: string, field: string, own: AccessRule | undefined): AccessRule | undefined {
  const c = classFor(policy, blueprint, field)
  return c ? { grants: [], audiences: c.audiences } : own
}

/** Every grant any audience holds, for working out once what each grant reads from a person. */
/** Every grant a blueprint's own rules write out: who sees it, who reads its timeline, and who sees each field. */
export function blueprintGrants(bp: Pick<Blueprint, 'access' | 'timeline' | 'fields'>): AccessGrant[] {
  return [...(bp.access?.grants ?? []), ...(bp.timeline?.grants ?? []), ...Object.values(bp.fields).flatMap((def) => def.access?.grants ?? [])]
}

export function policyGrants(policy: AccessPolicy): AccessGrant[] {
  return audienceGrants(policy, policy.audiences.map((a) => a.id))
}

/** What is wrong with a policy, in words; empty when nothing is. */
export function policyProblems(policy: AccessPolicy): string[] {
  const out: string[] = []
  const ids = new Set<string>()
  for (const a of policy.audiences) {
    if (!POLICY_ID.test(a.id)) out.push(`Audience "${a.id}": an id is lowercase letters, digits, - and _, starting with a letter`)
    if (ids.has(a.id)) out.push(`Audience "${a.id}" is defined twice`)
    ids.add(a.id)
    if (!a.title.trim()) out.push(`Audience "${a.id}" needs a title`)
  }
  for (const a of policy.audiences) {
    for (const inner of a.audiences) if (!ids.has(inner)) out.push(`Audience "${a.id}" names an audience that does not exist: "${inner}"`)
    for (const [i, g] of a.grants.entries()) if (!g.values.length) out.push(`Audience "${a.id}": grant ${i + 1} names no values`)
  }
  const byId = new Map(policy.audiences.map((a) => [a.id, a]))
  const loops = (id: string, path: string[]): string | null => {
    if (path.includes(id)) return [...path, id].join(' → ')
    for (const inner of byId.get(id)?.audiences ?? []) {
      const hit = loops(inner, [...path, id])
      if (hit) return hit
    }
    return null
  }
  for (const a of policy.audiences) {
    const hit = loops(a.id, [])
    if (hit) {
      out.push(`Audiences hold each other in a loop: ${hit}`)
      break
    }
  }
  const classIds = new Set<string>()
  for (const c of policy.classes) {
    if (!POLICY_ID.test(c.id)) out.push(`Class "${c.id}": an id is lowercase letters, digits, - and _, starting with a letter`)
    if (classIds.has(c.id)) out.push(`Class "${c.id}" is defined twice`)
    classIds.add(c.id)
    if (!c.title.trim()) out.push(`Class "${c.id}" needs a title`)
    if (!c.audiences.length) out.push(`Class "${c.id}" names no audience, so nobody but an admin would see its fields`)
    for (const id of c.audiences) if (!ids.has(id)) out.push(`Class "${c.id}" names an audience that does not exist: "${id}"`)
    if (!c.match.length && !c.include.length) out.push(`Class "${c.id}" matches no field: give it a pattern or a field`)
    for (const f of [...c.include, ...c.exclude.map((x) => x.field)]) if (!/^[^.\s]+\.[^.\s]+$/.test(f)) out.push(`Class "${c.id}": "${f}" is not blueprint.field`)
    for (const x of c.exclude) if (!x.reason.trim()) out.push(`Class "${c.id}": leaving out ${x.field} needs a reason`)
    for (const r of c.owned?.through ?? []) if (!/^[^.\s<:]+$/.test(r)) out.push(`Class "${c.id}": "${r}" is not one relation: an owner opens an entity through a relation of its own, one hop`)
  }
  const editIds = new Set<string>()
  for (const r of policy.edits) {
    if (!POLICY_ID.test(r.id)) out.push(`Edit rule "${r.id}": an id is lowercase letters, digits, - and _, starting with a letter`)
    if (editIds.has(r.id)) out.push(`Edit rule "${r.id}" is defined twice`)
    editIds.add(r.id)
    if (!r.title.trim()) out.push(`Edit rule "${r.id}" needs a title`)
    if (!r.blueprints.length) out.push(`Edit rule "${r.id}" names no blueprint: an edit rule opens only the blueprints it names`)
    if (!r.fields.length && !r.relations.length) out.push(`Edit rule "${r.id}" opens nothing: give it a field or a relation`)
    if (!r.audiences.length && !r.owned) out.push(`Edit rule "${r.id}" lets nobody in: give it an audience, or open it to owners`)
    for (const id of r.audiences) if (!ids.has(id)) out.push(`Edit rule "${r.id}" names an audience that does not exist: "${id}"`)
    for (const rel of r.owned?.through ?? []) if (!/^[^.\s<:]+$/.test(rel)) out.push(`Edit rule "${r.id}": "${rel}" is not one relation: an owner opens an entity through a relation of its own, one hop`)
  }
  return out
}

/** A policy with every list present and every name trimmed, from what a person or a file sent. */
export function normalizePolicy(p: { audiences?: Partial<Audience>[]; classes?: Partial<FieldClass>[]; edits?: Partial<EditRule>[] }): AccessPolicy {
  const names = (l: unknown): string[] => (Array.isArray(l) ? [...new Set(l.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean))] : [])
  return {
    audiences: (p.audiences ?? []).map((a) => ({
      id: String(a.id ?? '').trim(),
      title: String(a.title ?? '').trim(),
      ...(a.description?.trim() ? { description: a.description.trim() } : {}),
      people: names(a.people).map((x) => x.toLowerCase()),
      grants: (a.grants ?? []).map((g) => ({ ...(g.path ? { path: g.path.trim() } : {}), ...(g.field ? { field: g.field.trim() } : {}), values: names(g.values) })),
      audiences: names(a.audiences),
    })),
    classes: (p.classes ?? []).map((c) => ({
      id: String(c.id ?? '').trim(),
      title: String(c.title ?? '').trim(),
      ...(c.description?.trim() ? { description: c.description.trim() } : {}),
      audiences: names(c.audiences),
      match: names(c.match),
      ...(names(c.blueprints).length ? { blueprints: names(c.blueprints) } : {}),
      include: names(c.include),
      exclude: (c.exclude ?? []).map((x) => ({ field: String(x.field ?? '').trim(), reason: String(x.reason ?? '').trim() })),
      ...(c.owned ? { owned: { through: names(c.owned.through), roles: names(c.owned.roles) } } : {}),
    })),
    edits: (p.edits ?? []).map((r) => ({
      id: String(r.id ?? '').trim(),
      title: String(r.title ?? '').trim(),
      ...(r.description?.trim() ? { description: r.description.trim() } : {}),
      blueprints: names(r.blueprints),
      fields: names(r.fields),
      relations: names(r.relations),
      audiences: names(r.audiences),
      ...(r.owned ? { owned: { through: names(r.owned.through), roles: names(r.owned.roles) } } : {}),
    })),
  }
}

/** Whether a class opens its fields to the owners of an entity. */
export function opensToOwners(c: FieldClass | null): c is FieldClass & { owned: ClassOwned } {
  return !!c?.owned
}

/** The policy with every blueprint it names by an id it was known by before a rename read as the id it has now. */
export function withCurrentIds(policy: AccessPolicy, resolve: (id: string) => string): AccessPolicy {
  const ref = (r: string) => {
    const at = r.indexOf('.')
    return at > 0 ? `${resolve(r.slice(0, at))}${r.slice(at)}` : r
  }
  return {
    audiences: policy.audiences,
    classes: policy.classes.map((c) => ({
      ...c,
      include: c.include.map(ref),
      exclude: c.exclude.map((x) => ({ ...x, field: ref(x.field) })),
      ...(c.blueprints ? { blueprints: c.blueprints.map((p) => (p.includes('*') ? p : resolve(p))) } : {}),
    })),
    edits: policy.edits.map((r) => ({ ...r, blueprints: r.blueprints.map((p) => (p.includes('*') ? p : resolve(p))) })),
  }
}
