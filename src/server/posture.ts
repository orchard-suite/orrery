// The security posture: who sees, changes, and runs what, worked out for
// every known person and token through the hub's own access evaluation
// (`Visibility`), the findings worth an admin's look, and a change to many
// rules at once with a preview of who gains and who loses before it saves.
// Nothing here decides access: it reads the rules and asks `Visibility`.

import { parsePath, stable } from '../shared/filter.ts'
import { ADMIN_ROLE, SELF_ROLE, actionTargets, entityId, isDerived, namesSelf, parseEntityId, type AccessGrant, type AccessRule, type Action, type ActionAccess, type ActionRule, type Blueprint, type BlueprintOrigin, type Identity, type Permission } from '../shared/model.ts'
import { actionGrants, audienceGrants, blueprintGrants, classFor, policyGrants, policyProblems, resolveRule, type AccessPolicy } from '../shared/policy.ts'
import { EDIT_AUTHORITIES, targetId, type EditAuthority, type EditBlueprint, type EditName, type EditsResponse, type StandingOverride, type AdminOnlyReason, type FieldCoverage, type PolicyPreview, type PostureAudience, type PostureChange, type PostureClass, type PostureFinding, type PostureHandmade, type PostureMapColumn, type PostureItem, type PosturePreview, type PosturePreviewItem, type PosturePrincipal, type PostureReach, type PostureResponse, type PostureReviewRow, type PostureTarget, type PostureTeam, type PostureWho } from '../shared/posture.ts'
import type { Access } from './access.ts'
import type { Actions } from './actions.ts'
import { identityOf } from './auth.ts'
import { isHubBlueprint } from './builtin.ts'
import type { Blueprints } from './blueprints.ts'
import type { Db } from './db.ts'
import { timed } from './metrics.ts'
import type { Sources } from './sources.ts'
import { adminOnlyBlueprints, summarises, type View, type Visibility } from './visibility.ts'

export interface PostureDeps {
  db: Db
  blueprints: Blueprints
  visibility: Visibility
  access: Access
  actions: Actions
  sources: Sources
}

/** A person or token with the identity the hub would give them. */
interface Judged {
  principal: PosturePrincipal
  identity: Identity
  view: View
}

/** The next definitions a change makes, and the targets it leaves alone. */
export interface PosturePlan {
  blueprints: Map<string, Blueprint>
  actions: Map<string, Action>
  refused: Map<string, string>
  /** The targets the change names, in order, with their titles. */
  targets: { target: PostureTarget; title: string }[]
}

/** Permissions that let a non-admin widen what they or others reach, with why. */
const WIDENING: Partial<Record<Permission, string>> = {
  'tokens.manage': 'can issue a machine access token, and a machine token reads everything',
  'actions.manage': "can change any action's filter, inputs, and backend, though not who may run it",
  'users.manage': 'can give people the roles they hold themselves',
  'sources.manage': 'can register sources and change what they may write',
  'access.values': 'can change the values access is decided from, such as who is on a team or which environment a resource is in, and so who sees and runs what',
}

/** An action nobody has asked for in this many days, and whose definition is older than that, is a finding. */
const UNUSED_DAYS = 90

/** How many standing overrides the page is given: the oldest. */
const OVERRIDES_SHOWN = 500

const daysSince = (iso: string): number => Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)

/** Where the review stamps are kept: by blueprint, when an admin last reviewed it, and which fields it held then. */
export const REVIEWS_KEY = 'access.reviews'

interface Stamp {
  at: string
  by: string
  fields: string[]
}

export class Posture {
  private readonly deps: PostureDeps

  constructor(deps: PostureDeps) {
    this.deps = deps
  }

  /** Every person the hub knows (signed in, added, or a person entity) and every machine access token, admins first. */
  async principals(): Promise<Judged[]> {
    const { access, visibility, sources } = this.deps
    const people = new Map<string, PosturePrincipal & { identity: Identity }>()
    for (const user of access.listUsers()) {
      const identity = identityOf(user, access)
      people.set(user.email, { kind: 'person', name: user.email, admin: user.admin, roles: user.roles, permissions: identity.permissions, signedIn: !!user.firstSeenAt, identity })
    }
    for (const address of await visibility.personAddresses()) {
      if (people.has(address)) continue
      const identity: Identity = { kind: 'user', name: address, admin: false, roles: [], permissions: [] }
      people.set(address, { kind: 'person', name: address, admin: false, roles: [], permissions: [], signedIn: false, identity })
    }
    const tokens = (await sources.listTokens()).filter((t) => t.kind === 'access')
    const out: Judged[] = []
    // Everyone is judged, so what every grant reads is worked out for all of them in a few queries, not a few each.
    await visibility.warm([...people.keys(), ...tokens.map((t) => t.name)])
    for (const { identity, ...principal } of people.values()) out.push({ principal, identity, view: await visibility.view(identity) })
    for (const t of tokens) {
      const roles = t.role ? [t.role] : []
      const identity: Identity = { kind: 'token', name: t.name, admin: t.role === ADMIN_ROLE, roles, permissions: access.permissionsOf(roles) }
      out.push({ principal: { kind: 'token', name: t.name, admin: identity.admin, roles, permissions: identity.permissions, signedIn: true }, identity, view: await visibility.view(identity) })
    }
    return out.sort((a, b) => Number(b.principal.admin) - Number(a.principal.admin) || a.principal.kind.localeCompare(b.principal.kind) || a.principal.name.localeCompare(b.principal.name))
  }

  /** The posture as one reader of the page gets it. Only where an action belongs is theirs: its home is read through their view. */
  snapshot(identity: Identity, view: View): Promise<PostureResponse> {
    return timed('posture', () => this.build(identity, view))
  }

  private async build(reader: Identity, readerView: View): Promise<PostureResponse> {
    const judged = await timed('posture.people', () => this.principals())
    const people = judged.filter((j) => j.principal.kind === 'person' && !j.principal.admin)
    const policy = this.deps.visibility.accessPolicy()
    const stamps = await this.stamps()
    const items: PostureItem[] = []
    for (const bp of this.model()) {
      items.push({
        target: { kind: 'blueprint', id: bp.id },
        title: bp.title,
        group: bp.group ?? null,
        origin: originLabel(bp.origin),
        open: !bp.access,
        grants: bp.access?.grants ?? [],
        audiences: bp.access?.audiences ?? [],
        class: null,
        setAside: false,
        coverage: null,
        adminEdit: !!bp.adminEdit,
        adminOnly: this.adminOnlyReason(bp.id),
        sensitive: [...blueprintNotes(bp, this.adminOnlyReason(bp.id)), ...ownersNote(bp, people.filter((j) => !j.view.seesBlueprint(bp.id) && (j.view.ownedOnly(bp.id)?.size ?? 0) > 0).length), ...subjectsNote(bp, people.filter((j) => !j.view.seesBlueprint(bp.id) && (j.view.aboutOnly(bp.id)?.size ?? 0) > 0).length)],
        people: people.filter((j) => j.view.seesBlueprint(bp.id)).length + this.adminCount(judged),
      })
      const stamp = stamps[bp.id]
      for (const [name, def] of Object.entries(bp.fields)) {
        // Every field is listed, an open one too, so it can be found and locked here.
        const decides = this.deps.visibility.decidesOn(bp.id).names.includes(name)
        const cls = classFor(policy, bp.id, name)
        const rule = cls ? { grants: [], audiences: cls.audiences } : def.access
        const coverage: FieldCoverage = cls ? 'classified' : def.access ? 'ruled' : stamp?.fields.includes(name) ? 'reviewed' : 'unreviewed'
        const summary = summarises(bp, def, (id) => this.deps.blueprints.get(id), this.model())
        const summaryOnly = summary ? people.filter((j) => j.view.seesBlueprint(bp.id) && j.view.summaries(bp.id).has(name)).length : 0
        items.push({
          target: { kind: 'field', blueprint: bp.id, field: name },
          title: `${bp.title}: ${def.title ?? name}`,
          group: bp.group ?? null,
          origin: originLabel(bp.origin),
          open: !rule,
          grants: rule?.grants ?? [],
          audiences: rule?.audiences ?? [],
          class: cls?.id ?? null,
          setAside: !!cls && !!def.access,
          coverage,
          adminEdit: !!def.adminEdit,
          adminOnly: null,
          sensitive: [...(decides ? ['access is decided from it, so only an admin or a holder of access.values changes it'] : []), ...(def.type === 'secretRef' ? ['holds a reference to a secret'] : []), ...(def.adminEdit ? ['only an admin changes it'] : []), ...(cls ? [`in the ${cls.title} class`] : def.access ? ['seen by some people only'] : []), ...(summary ? [SUMMARY_NOTE] : [])],
          people: people.filter((j) => j.view.seesBlueprint(bp.id) && !j.view.hiddenFields(bp.id).has(name)).length + this.adminCount(judged),
          field: { type: def.type, ...(summary ? { summary: true, summaryOnly } : {}) },
        })
      }
    }
    const { actions } = this.deps
    const [homes, usage] = await Promise.all([actions.homes(reader, readerView, actions.list().map((a) => a.home)), actions.usage(UNUSED_DAYS)])
    for (const a of actions.list()) {
      let runs = 0
      for (const j of people) if (await this.runs(j, a)) runs++
      const home = (a.home && homes.get(a.home)) || null
      const used = usage.get(a.id)
      items.push({
        target: { kind: 'action', id: a.id },
        title: a.title,
        group: a.group ?? null,
        origin: originLabel(a.origin),
        open: !!a.access?.everyone,
        grants: a.access?.grants ?? [],
        audiences: a.access?.audiences ?? [],
        class: null,
        setAside: false,
        coverage: null,
        adminEdit: false,
        adminOnly: null,
        sensitive: actionNotes(a),
        people: runs + this.adminCount(judged),
        action: {
          blueprints: actionTargets(a),
          backend: a.backend.type,
          approval: !!a.approval,
          where: a.where ?? null,
          rules: a.access?.rules ?? [],
          icon: actions.iconShown(a, home),
          home: home && { id: home.id, title: home.title },
          homePeople: !!a.access?.home,
          everyone: !!a.access?.everyone,
          lastRunAt: used?.lastRunAt ?? null,
          runs90: used?.recent ?? 0,
        },
      })
    }
    const audiences = await this.audiences(judged, items, policy)
    const classes = this.classes(policy)
    const coverage: Record<FieldCoverage, number> = { classified: 0, ruled: 0, reviewed: 0, unreviewed: 0 }
    for (const i of items) if (i.coverage) coverage[i.coverage]++
    return {
      person: this.deps.visibility.personSetting(),
      principals: judged.map((j) => j.principal),
      items,
      findings: await this.findings(judged, items, audiences, classes, usage),
      teams: await this.teams(judged, items),
      policy: this.deps.visibility.policyState(),
      audiences,
      classes,
      review: this.review(stamps),
      coverage,
      map: this.map(people, audiences, policy),
      handmade: await timed('posture.handmade', () => this.handmade()),
    }
  }

  /** Who sees each blueprint, by audience, and the people in none: counted for the people who are not admins, since an admin sees everything. */
  private map(people: Judged[], audiences: PostureAudience[], policy: AccessPolicy): PostureMapColumn[] {
    const model = this.model()
    const column = (audience: string | null, title: string, who: Judged[]): PostureMapColumn => ({
      audience,
      title,
      people: who.length,
      cells: Object.fromEntries(model.map((bp) => {
        const seers = who.filter((j) => j.view.seesBlueprint(bp.id))
        const hidden = new Set(seers.flatMap((j) => [...j.view.hiddenFields(bp.id)]))
        return [bp.id, { sees: seers.length, hidden: hidden.size }]
      })),
    })
    const inSome = new Set(audiences.flatMap((a) => a.members))
    return [
      ...policy.audiences.map((a) => column(a.id, a.title, people.filter((j) => audiences.find((x) => x.id === a.id)?.members.includes(j.principal.name)))),
      column(null, policy.audiences.length ? 'Everyone else' : 'Everyone', people.filter((j) => !inSome.has(j.principal.name))),
    ]
  }

  /** Every audience: who it lets in today, the addresses nobody answers to, and every rule and class that names it or an audience that holds it. */
  private async audiences(judged: Judged[], items: PostureItem[], policy: AccessPolicy): Promise<PostureAudience[]> {
    const known = new Set(judged.map((j) => j.principal.name.toLowerCase()))
    const out: PostureAudience[] = []
    for (const a of policy.audiences) {
      // An audience is in every audience that holds it, so a rule naming one of those lets it in too.
      const within = holders(policy, a.id)
      const grants = audienceGrants(policy, [a.id])
      const members: string[] = []
      for (const j of judged) if (grants.length && (await this.deps.visibility.grantsLetIn(j.principal.name, grants))) members.push(j.principal.name)
      out.push({
        id: a.id,
        title: a.title,
        ...(a.description ? { description: a.description } : {}),
        members,
        strangers: a.people.filter((p) => !known.has(p.toLowerCase())),
        targets: items.filter((i) => !i.class && i.audiences.some((x) => within.has(x))).map((i) => i.target),
        classes: policy.classes.filter((c) => c.audiences.some((x) => within.has(x))).map((c) => c.id),
        heldBy: policy.audiences.filter((o) => o.audiences.includes(a.id)).map((o) => o.id),
      })
    }
    return out
  }

  /** Every class, with every field it covers today and the rules of their own it sets aside. */
  private classes(policy: AccessPolicy): PostureClass[] {
    const out = new Map<string, PostureClass>(policy.classes.map((c) => [c.id, { id: c.id, title: c.title, ...(c.description ? { description: c.description } : {}), audiences: c.audiences, fields: [], setAside: [] }]))
    for (const bp of this.model()) {
      for (const [name, def] of Object.entries(bp.fields)) {
        const cls = classFor(policy, bp.id, name)
        if (!cls) continue
        out.get(cls.id)!.fields.push({ blueprint: bp.id, field: name })
        if (def.access) out.get(cls.id)!.setAside.push({ blueprint: bp.id, field: name })
      }
    }
    return [...out.values()]
  }

  /** Every blueprint for the review queue: the ones never reviewed or holding new fields first, newest first within each. */
  private review(stamps: Record<string, Stamp>): PostureReviewRow[] {
    const rows: PostureReviewRow[] = this.model().filter((bp) => !isHubBlueprint(bp.id)).map((bp) => {
      const stamp = stamps[bp.id]
      const names = Object.keys(bp.fields)
      return {
        blueprint: bp.id,
        title: bp.title,
        group: bp.group ?? null,
        createdAt: this.deps.blueprints.createdAt(bp.id),
        reviewedAt: stamp?.at ?? null,
        reviewedBy: stamp?.by ?? null,
        fields: names.length,
        newFields: stamp ? names.filter((n) => !stamp.fields.includes(n)) : names,
        open: !bp.access,
      }
    })
    const waiting = (r: PostureReviewRow) => !r.reviewedAt || r.newFields.length > 0
    return rows.sort((a, b) => Number(waiting(b)) - Number(waiting(a)) || (b.createdAt ?? '').localeCompare(a.createdAt ?? '') || a.title.localeCompare(b.title))
  }

  /** The review stamps, by the blueprint's id today. */
  async stamps(): Promise<Record<string, Stamp>> {
    const row = await this.deps.db.query<{ value: Record<string, Stamp> }>('SELECT value FROM settings WHERE key = $1', [REVIEWS_KEY])
    const out: Record<string, Stamp> = {}
    for (const [id, stamp] of Object.entries(row.rows[0]?.value ?? {})) out[this.deps.blueprints.resolve(id)] = stamp
    return out
  }

  /** Marks blueprints reviewed as they stand: every field they hold now is no longer new. Returns the ids stamped. */
  async markReviewed(ids: string[], by: string): Promise<string[]> {
    const stamps = await this.stamps()
    const at = new Date().toISOString()
    const done: string[] = []
    for (const id of ids) {
      const bp = this.deps.blueprints.get(this.deps.blueprints.resolve(id))
      if (!bp || isHubBlueprint(bp.id)) continue
      stamps[bp.id] = { at, by, fields: Object.keys(bp.fields).sort() }
      done.push(bp.id)
    }
    if (done.length) await this.deps.db.query('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [REVIEWS_KEY, JSON.stringify(stamps)])
    return done
  }

  /**
   * Who gains and loses sight of what, blueprint, field, and action, were this
   * policy saved, judged for every known person with the same evaluation every
   * read uses. Nothing is saved.
   */
  async previewPolicy(next: AccessPolicy): Promise<PolicyPreview> {
    const problems = policyProblems(next)
    if (problems.length) return { problems, items: [], saved: false }
    const judged = (await this.principals()).filter((j) => j.principal.kind === 'person' && !j.principal.admin)
    const changes = new Map<string, { target: PostureTarget; title: string; gains: string[]; loses: string[] }>()
    const note = (target: PostureTarget, title: string, name: string, gained: boolean) => {
      const id = targetId(target)
      const row = changes.get(id) ?? { target, title, gains: [], loses: [] }
      ;(gained ? row.gains : row.loses).push(name)
      changes.set(id, row)
    }
    const model = this.model()
    for (const j of judged) {
      const after = await this.deps.visibility.viewWith(j.identity, next)
      for (const bp of model) {
        // Seeing some of a blueprint, as theirs or as about what they see, counts as seeing it: a rule that opens it so shows who gains that.
        const a = j.view.seesSome(bp.id)
        const b = after.seesSome(bp.id)
        if (a !== b) note({ kind: 'blueprint', id: bp.id }, bp.title, j.principal.name, b)
        const was = j.view.hiddenFields(bp.id)
        const now = after.hiddenFields(bp.id)
        for (const [name, def] of Object.entries(bp.fields)) {
          const fa = a && !was.has(name)
          const fb = b && !now.has(name)
          if (fa !== fb) note({ kind: 'field', blueprint: bp.id, field: name }, `${bp.title}: ${def.title ?? name}`, j.principal.name, fb)
        }
      }
      for (const act of this.deps.actions.list()) {
        if (!act.access?.audiences?.length || act.access.everyone) continue
        const a = await this.runs(j, act)
        const grants = actionGrants(next, act.access)
        const b = grants.length > 0 && (await this.deps.visibility.grantsLetIn(j.identity.name, grants)) && after.seesAction(act)
        if (a !== b) note({ kind: 'action', id: act.id }, act.title, j.principal.name, b)
      }
    }
    return { problems: [], items: [...changes.values()], saved: false }
  }

  /** Every value a rule grants to, with the people it lets in and what it opens, most reach first. */
  private async teams(judged: Judged[], items: PostureItem[]): Promise<PostureTeam[]> {
    const byId = new Map<string, PostureTeam>()
    for (const item of items) {
      for (const g of item.grants) {
        for (const value of g.values) {
          const grant: AccessGrant = { ...(g.path ? { path: g.path } : {}), ...(g.field ? { field: g.field } : {}), values: [value] }
          const id = `${g.path ?? ''}|${g.field ?? ''}|${value.toLowerCase()}`
          const team = byId.get(id) ?? { id, words: grantWords(grant), grant, members: [], targets: [] }
          if (!team.targets.some((t) => targetId(t) === targetId(item.target))) team.targets.push(item.target)
          byId.set(id, team)
        }
      }
    }
    const people = judged.filter((j) => j.principal.kind === 'person')
    for (const team of byId.values()) {
      for (const j of people) if (await this.deps.visibility.grantsLetIn(j.principal.name, [team.grant])) team.members.push(j.principal.name)
    }
    return [...byId.values()].sort((a, b) => b.targets.length - a.targets.length || a.words.localeCompare(b.words))
  }

  /** What one person or token may see, change, and run. */
  async reach(kind: 'person' | 'token', name: string): Promise<PostureReach | null> {
    const judged = (await this.principals()).find((j) => j.principal.kind === kind && j.principal.name === name.toLowerCase())
      ?? (await this.principals()).find((j) => j.principal.kind === kind && j.principal.name === name)
    if (!judged) return null
    const editor = judged.principal.kind === 'person' && !judged.principal.admin ? await this.deps.visibility.editorFor(judged.principal.name) : null
    const blueprints = this.model().map((bp) => {
      const sees = judged.view.seesBlueprint(bp.id)
      const hidden = [...judged.view.hiddenFields(bp.id)].sort()
      const changes = this.changesBlueprint(judged, bp.id)
      const opened = editor?.reach(bp.id) ?? []
      // What they could change but for an admin-only mark on the field, or because access is decided from it.
      const locked = changes && !judged.principal.admin ? Object.keys(bp.fields).filter((name) => !hidden.includes(name) && !this.changesName(judged, bp.id, name)) : []
      const summaries = [...judged.view.summaries(bp.id)].sort()
      return { id: bp.id, title: bp.title, sees, changes, hidden, ...(summaries.length ? { summaries } : {}), locked, ...(opened.length ? { opened } : {}) }
    })
    const actions = []
    for (const a of this.deps.actions.list()) {
      const runs = await this.runs(judged, a)
      actions.push({ id: a.id, title: a.title, runs, offered: runs && judged.view.seesAction(a), via: runs ? await this.via(judged, a.access, a.home, actionTargets(a)) : null })
    }
    return { principal: judged.principal, blueprints, actions }
  }

  /** Everyone who may see, change, or run one target, and through which grant. */
  async who(target: PostureTarget): Promise<PostureWho | null> {
    const judged = await this.principals()
    const rows: PostureWho['rows'] = []
    if (target.kind === 'action') {
      const a = this.deps.actions.get(target.id)
      if (!a) return null
      for (const j of judged) {
        const runs = await this.runs(j, a)
        rows.push({ principal: j.principal, sees: j.view.seesAction(a), changes: j.principal.admin || j.principal.permissions.includes('actions.manage'), runs, via: runs ? await this.via(j, a.access, a.home, actionTargets(a)) : null })
      }
      return { target, title: a.title, rows }
    }
    const bp = this.deps.blueprints.get(target.kind === 'field' ? target.blueprint : target.id)
    if (!bp) return null
    const def = target.kind === 'field' ? bp.fields[target.field] : undefined
    if (target.kind === 'field' && !def) return null
    for (const j of judged) {
      const seesBp = j.view.seesSome(bp.id)
      const sees = seesBp && (!def || !j.view.hiddenFields(bp.id).has((target as { field: string }).field))
      const asOwner = sees && !j.view.seesBlueprint(bp.id)
      // A field is also changed by whoever an edit rule lets in, on at least one entity.
      const ruled = sees && target.kind === 'field' && j.principal.kind === 'person' && !j.principal.admin && (await this.deps.visibility.editorFor(j.principal.name)).could(bp.id, target.field, 'field')
      const changes = (sees && this.changesBlueprint(j, bp.id) && (target.kind !== 'field' || this.changesName(j, bp.id, target.field))) || ruled
      const rule = def ? this.deps.visibility.fieldRule(bp.id, (target as { field: string }).field, def.access) : bp.access
      const summaryOnly = sees && !!def && j.view.summaries(bp.id).has((target as { field: string }).field)
      const via = asOwner ? 'their own, as owner' : sees ? await this.ruleVia(j, rule) : null
      rows.push({ principal: j.principal, sees, changes: ruled || (changes && !asOwner), runs: false, via: summaryOnly ? [via, SUMMARY_VIA].filter(Boolean).join('; ') : via, ...(summaryOnly ? { summaryOnly } : {}) })
    }
    const summary = !!def && summarises(bp, def, (id) => this.deps.blueprints.get(id), this.model())
    return { target, title: def ? `${bp.title}: ${def.title ?? (target as { field: string }).field}` : bp.title, ...(summary ? { summary } : {}), rows }
  }

  /** The next definitions one change makes. Nothing is saved. */
  plan(change: PostureChange): PosturePlan {
    const plan: PosturePlan = { blueprints: new Map(), actions: new Map(), refused: new Map(), targets: [] }
    const person = this.deps.visibility.personSetting()?.blueprint
    const refuse = (t: PostureTarget, why: string) => plan.refused.set(targetId(t), why)
    for (const t of change.targets) {
      if (t.kind === 'action') {
        const a = plan.actions.get(t.id) ?? this.deps.actions.get(t.id)
        plan.targets.push({ target: t, title: a?.title ?? t.id })
        if (!a) refuse(t, 'There is no such action')
        else if (a.origin.kind === 'git') refuse(t, `Defined in git (${a.origin.file}): change it there`)
        else if (change.adminEdit !== undefined) refuse(t, 'An action has no admin-only mark: who runs it is its access')
        else if ((change.access?.audiences ?? []).some((x) => !this.deps.visibility.accessPolicy().audiences.some((a) => a.id === x))) refuse(t, 'It names an audience that does not exist')
        else if (change.access) {
          const next = nextActionAccess(a.access, change.access)
          const bad = person ? badPath(this.deps.blueprints, person, next?.grants ?? []) : null
          if (bad) refuse(t, bad)
          else plan.actions.set(a.id, { ...a, access: next })
        }
        continue
      }
      const id = t.kind === 'field' ? t.blueprint : t.id
      const base = plan.blueprints.get(id) ?? this.deps.blueprints.get(id)
      const def = t.kind === 'field' ? base?.fields[t.field] : undefined
      plan.targets.push({ target: t, title: base ? (t.kind === 'field' ? `${base.title}: ${def?.title ?? t.field}` : base.title) : id })
      if (!base) {
        refuse(t, 'There is no such blueprint')
        continue
      }
      if (t.kind === 'field' && !def) {
        refuse(t, `${base.title} has no field "${t.field}"`)
        continue
      }
      if (isHubBlueprint(id)) {
        refuse(t, "One of the hub's own blueprints: share it from the Access page")
        continue
      }
      if (base.origin.kind === 'git') {
        refuse(t, `Defined in git (${base.origin.file}): change it there`)
        continue
      }
      // A field a class covers takes no rule of its own; taking one off is always allowed, since the class already decides.
      const cls = t.kind === 'field' && change.access && nextRule(def!.access, change.access) ? classFor(this.deps.visibility.accessPolicy(), id, t.field) : null
      if (cls) {
        refuse(t, `In the ${cls.title} class, which decides who sees it: change the class, or leave the field out of it`)
        continue
      }
      const unknown = (change.access?.audiences ?? []).filter((a) => !this.deps.visibility.accessPolicy().audiences.some((x) => x.id === a))
      if (unknown.length) {
        refuse(t, `There is no audience ${unknown.map((a) => `"${a}"`).join(', ')}`)
        continue
      }
      const rule = change.access ? nextRule(t.kind === 'field' ? def!.access : base.access, change.access) : undefined
      const bad = change.access && person ? badPath(this.deps.blueprints, person, rule?.grants ?? []) : null
      if (bad) {
        refuse(t, bad)
        continue
      }
      if (t.kind === 'field') {
        const nextDef = { ...def! }
        if (change.access) setRule(nextDef, rule)
        if (change.adminEdit !== undefined) setMark(nextDef, change.adminEdit)
        plan.blueprints.set(id, { ...base, fields: { ...base.fields, [t.field]: nextDef } })
      } else {
        const next = { ...base }
        if (change.access) setRule(next, rule)
        if (change.adminEdit !== undefined) setMark(next, change.adminEdit)
        plan.blueprints.set(id, next)
      }
    }
    return plan
  }

  /** Who gains and who loses, target by target, if the plan were saved. */
  async preview(plan: PosturePlan): Promise<PosturePreview> {
    const { visibility } = this.deps
    const judged = await this.principals()
    const person = visibility.personSetting()
    const before = this.model()
    const after = before.map((bp) => plan.blueprints.get(bp.id) ?? bp)
    const actionsAfter = this.deps.actions.list().map((a) => plan.actions.get(a.id) ?? a)
    const onlyBefore = adminOnlyBlueprints(before, person, this.deps.actions.list())
    const onlyAfter = adminOnlyBlueprints(after, person, actionsAfter)
    const items: PosturePreviewItem[] = []
    for (const { target, title } of plan.targets) {
      const refused = plan.refused.get(targetId(target)) ?? null
      const item: PosturePreviewItem = { target, title, refused, changed: false, gains: [], loses: [], gainsChange: [], losesChange: [] }
      items.push(item)
      if (refused) continue
      for (const j of judged) {
        const name = j.principal.name
        if (target.kind === 'action') {
          const was = this.deps.actions.get(target.id)!
          const next = plan.actions.get(target.id) ?? was
          const a = await this.runsWith(j, was.access, was)
          const b = await this.runsWith(j, next.access, next)
          if (b && !a) item.gains.push(name)
          if (a && !b) item.loses.push(name)
          continue
        }
        const id = target.kind === 'field' ? target.blueprint : target.id
        const wasBp = before.find((x) => x.id === id)!
        const nextBp = after.find((x) => x.id === id)!
        const wasDef = target.kind === 'field' ? wasBp.fields[target.field] : undefined
        const nextDef = target.kind === 'field' ? nextBp.fields[target.field] : undefined
        const fieldName = target.kind === 'field' ? target.field : ''
        const sees = async (bp: Blueprint, def: Blueprint['fields'][string] | undefined) => (await this.ruleAllows(j, bp.access)) && (!def || (await this.ruleAllows(j, this.deps.visibility.fieldRule(bp.id, fieldName, def.access))))
        const a = await sees(wasBp, wasDef)
        const b = await sees(nextBp, nextDef)
        if (b && !a) item.gains.push(name)
        if (a && !b) item.loses.push(name)
        const edits = j.principal.admin || j.principal.permissions.includes('entities.edit')
        const ca = edits && a && (j.principal.admin || (!onlyBefore.has(id) && !wasDef?.adminEdit))
        const cb = edits && b && (j.principal.admin || (!onlyAfter.has(id) && !nextDef?.adminEdit))
        if (cb && !ca) item.gainsChange.push(name)
        if (ca && !cb) item.losesChange.push(name)
      }
      item.changed = target.kind === 'action' ? stable(this.deps.actions.get(target.id)?.access) !== stable(plan.actions.get(target.id)?.access) : this.changedTarget(target, before, after)
    }
    return {
      items,
      adminOnly: { added: [...onlyAfter].filter((id) => !onlyBefore.has(id)).sort(), removed: [...onlyBefore].filter((id) => !onlyAfter.has(id)).sort() },
      saved: false,
    }
  }

  private changedTarget(t: PostureTarget, before: Blueprint[], after: Blueprint[]): boolean {
    const id = t.kind === 'field' ? t.blueprint : (t as { id: string }).id
    const a = before.find((x) => x.id === id)
    const b = after.find((x) => x.id === id)
    if (t.kind === 'field') return stable(pick(a?.fields[t.field])) !== stable(pick(b?.fields[t.field]))
    return stable(pick(a)) !== stable(pick(b))
  }

  /** Findings about the rules, worked out for today's people and tokens. */
  private async findings(judged: Judged[], items: PostureItem[], audiences: PostureAudience[], classes: PostureClass[], usage: Map<string, { lastRunAt: string; recent: number }>): Promise<PostureFinding[]> {
    const out: Omit<PostureFinding, 'family'>[] = []
    const policy = this.deps.visibility.accessPolicy()
    const { blueprints, visibility, actions, sources } = this.deps
    const person = visibility.personSetting()
    const people = judged.filter((j) => j.principal.kind === 'person' && !j.principal.admin)
    const model = this.model()
    const anyPath = model.some((bp) => blueprintGrants(bp).some((g) => g.path)) || actions.list().some((a) => a.access?.grants?.some((g) => g.path)) || policyGrants(policy).some((g) => g.path)
    if (!person && anyPath) {
      out.push({ id: 'no-person', severity: 'high', title: 'Rules follow paths, but nobody is a person entity', detail: 'A grant with a path starts from the signed-in person\'s own entity, and the hub has not been told which blueprint holds people. Every such grant lets nobody in until it is set on the Access page.', targets: [], who: [] })
    }
    const homes = await this.homesHeld(actions.list())
    // Owning a home lets nobody in until the model says what a person owns: one finding for every such action.
    const unowned = person?.owns?.length ? [] : actions.list().filter((a) => a.home && a.access?.home)
    if (unowned.length) out.push({ id: 'home-unowned', severity: 'medium', title: `${unowned.length === 1 ? 'An action is' : `${unowned.length} actions are`} open to their home's people, but the model does not say what a person owns`, detail: 'Who owns a home is read from the ownership paths of the person setting, and it has none. Until an admin sets them on the Access page, a home lets nobody in.', targets: unowned.map((a): PostureTarget => ({ kind: 'action', id: a.id })), who: [] })
    for (const a of actions.list()) {
      const t: PostureTarget = { kind: 'action', id: a.id }
      if (a.access?.everyone) out.push({ id: `everyone:${a.id}`, severity: 'medium', title: `${a.title} is open to everyone signed in`, detail: `Anyone who signs in may run it. Its ${backendWords(a.backend.type)}.`, targets: [t], who: [] })
      const runners: string[] = []
      const blind: string[] = []
      for (const j of people) {
        if (!(await this.runs(j, a))) continue
        runners.push(j.principal.name)
        if (!j.view.seesAction(a)) blind.push(j.principal.name)
      }
      if (!a.access?.everyone && people.length >= 4 && runners.length > people.length / 2) out.push({ id: `wide:${a.id}`, severity: 'low', title: `${a.title} is open to most people`, detail: `${runners.length} of ${people.length} people may run it. Check that every grant is meant.`, targets: [t], who: runners })
      if (a.home && !homes.has(a.home)) out.push({ id: `home-gone:${a.id}`, severity: 'low', title: `The home of ${a.title} is not in the catalog`, detail: `Its home is ${a.home}, and the catalog holds no such entity, so the action is listed under no home${a.access?.home ? ' and its home lets nobody in' : ''}. Name another home, or bring the entity back.`, targets: [t], who: [] })
      // The hub keeps no date an action was first made, so its age is read from when its definition last changed.
      const used = usage.get(a.id)
      if (!used?.recent && daysSince(a.updatedAt) > UNUSED_DAYS) {
        const idle = used ? `has not run in ${daysSince(used.lastRunAt)} days` : 'has never run'
        out.push({ id: `action-unused:${a.id}`, severity: 'low', title: `${a.title} ${idle}`, detail: `Nobody has asked for it in the last ${UNUSED_DAYS} days, and its definition has not changed in that time. An action nobody uses is still a way in: remove it, or keep it and know why.`, targets: [t], who: [] })
      }
      if (blind.length) out.push({ id: `blind:${a.id}`, severity: 'low', title: `Some who may run ${a.title} cannot see what it works on`, detail: 'Their grant lets them run it, but a blueprint it runs on or picks from is hidden from them, so it is never offered. Widen what they see, or narrow who runs it.', targets: [t], who: blind })
    }
    for (const [perm, why] of Object.entries(WIDENING) as [Permission, string][]) {
      const holders = judged.filter((j) => !j.principal.admin && j.principal.permissions.includes(perm)).map((j) => j.principal.name)
      if (holders.length) out.push({ id: `perm:${perm}`, severity: perm === 'tokens.manage' ? 'high' : 'medium', title: `${holders.length === 1 ? 'Someone who is not an admin holds' : `${holders.length} who are not admins hold`} ${perm}`, detail: `A holder ${why}.`, targets: [], who: holders })
    }
    const adminTokens = judged.filter((j) => j.principal.kind === 'token' && j.principal.admin).map((j) => j.principal.name)
    if (adminTokens.length) out.push({ id: 'admin-tokens', severity: 'medium', title: `${adminTokens.length === 1 ? 'An access token holds' : `${adminTokens.length} access tokens hold`} the admin role`, detail: 'An admin token may do everything an admin may, from anywhere it is kept. Give it a role with only what it needs.', targets: [], who: adminTokens })
    const definers = sources.list().filter((s) => s.actions).map((s) => s.id)
    if (definers.length) out.push({ id: 'source-actions', severity: 'low', title: `${definers.length === 1 ? 'A source defines' : `${definers.length} sources define`} actions`, detail: 'A source with the actions grant puts its own actions and their backends. Who may run them is still an admin\'s to set.', targets: [], who: definers })
    if (person) {
      for (const bp of model) {
        const rules = [{ rule: bp.access, t: { kind: 'blueprint', id: bp.id } as PostureTarget, of: '' }, { rule: bp.timeline, t: { kind: 'blueprint', id: bp.id } as PostureTarget, of: ':timeline' }, ...Object.entries(bp.fields).map(([name, def]) => ({ rule: def.access, t: { kind: 'field', blueprint: bp.id, field: name } as PostureTarget, of: '' }))]
        for (const { rule, t, of } of rules) {
          const bad = badPath(blueprints, person.blueprint, rule?.grants ?? [])
          if (bad) out.push({ id: `path:${targetId(t)}${of}`, severity: 'medium', title: of ? "A timeline's grant reads a path the model lacks" : 'A grant reads a path the model lacks', detail: `${bad}. The grant lets nobody in.`, targets: [t], who: [] })
        }
      }
      for (const a of actions.list()) {
        const bad = badPath(blueprints, person.blueprint, a.access?.grants ?? [])
        if (bad) out.push({ id: `path:action:${a.id}`, severity: 'medium', title: 'A grant reads a path the model lacks', detail: `${bad}. The grant lets nobody in.`, targets: [{ kind: 'action', id: a.id }], who: [] })
      }
      // Every blueprint a grant's path reads through is an admin's alone; one that is not would let people grant themselves access.
      const decides = adminOnlyBlueprints(model, person, actions.list())
      for (const id of decides) if (!visibility.isAdminOnly(id)) out.push({ id: `decides:${id}`, severity: 'high', title: `${blueprints.get(id)?.title ?? id} decides access, yet others can change it`, detail: 'A grant reads through it, so anyone who changes it could change who gets in. The hub should hold it as an admin\'s alone; report this.', targets: [{ kind: 'blueprint', id }], who: [] })
    }
    // The policy: audiences that let nobody in, addresses nobody answers to, classes that cover nothing, and rules a class sets aside.
    for (const a of audiences) {
      if (!a.members.length) out.push({ id: `audience-empty:${a.id}`, severity: 'medium', title: `The ${a.title} audience lets nobody in`, detail: 'No person or token the hub knows is in it today, so every rule and class that names it is an admin\'s alone.', targets: a.targets, who: [] })
      if (a.strangers.length) out.push({ id: `audience-strangers:${a.id}`, severity: 'low', title: `The ${a.title} audience names people the hub does not know`, detail: 'Nobody has signed in as them, and no person entity answers to them. They may have left: take them out, or check the address.', targets: [], who: a.strangers })
    }
    for (const a of policy.audiences) {
      const bad = person ? badPath(blueprints, person.blueprint, a.grants) : null
      if (bad) out.push({ id: `path:audience:${a.id}`, severity: 'medium', title: `The ${a.title} audience reads a path the model lacks`, detail: `${bad}. That grant lets nobody in.`, targets: [], who: [] })
    }
    for (const c of classes) {
      if (!c.fields.length) out.push({ id: `class-empty:${c.id}`, severity: 'low', title: `The ${c.title} class covers no field`, detail: 'Its patterns and fields match nothing in the model today. A blueprint that brings a matching field is covered the moment it arrives.', targets: [], who: [] })
      if (c.setAside.length) out.push({ id: `set-aside:${c.id}`, severity: 'low', title: `${c.setAside.length === 1 ? 'A field rule is' : `${c.setAside.length} field rules are`} set aside by the ${c.title} class`, detail: 'These fields carry a rule of their own, which the class overrides. Clear the rules so what you read is what applies.', targets: c.setAside.map((f): PostureTarget => ({ kind: 'field', blueprint: f.blueprint, field: f.field })), who: [] })
    }
    // A field rule that names exactly what its blueprint's does hides nothing more; it only makes the rules longer to read.
    const byTarget = new Map(items.map((i) => [targetId(i.target), i]))
    const repeats: PostureTarget[] = []
    const nobody: PostureTarget[] = []
    for (const bp of model) {
      if (!bp.access) continue
      const bpItem = byTarget.get(targetId({ kind: 'blueprint', id: bp.id }))!
      for (const [name, def] of Object.entries(bp.fields)) {
        const t: PostureTarget = { kind: 'field', blueprint: bp.id, field: name }
        const item = byTarget.get(targetId(t))!
        if (item.open) continue
        if (!item.class && def.access && stable(sortedRule(def.access)) === stable(sortedRule(bp.access))) repeats.push(t)
        // Seen only through both rules: when someone passes each, but nobody passes both, the field is an admin's alone.
        else if (item.people === this.adminCount(judged) && bpItem.people > this.adminCount(judged) && people.some((j) => j.view.lets(this.deps.visibility.fieldRule(bp.id, name, def.access)))) nobody.push(t)
      }
    }
    if (repeats.length) out.push({ id: 'repeats', severity: 'low', title: `${repeats.length === 1 ? 'A field rule repeats' : `${repeats.length} field rules repeat`} the rule of the blueprint it is on`, detail: 'A field is only ever seen by people who see its blueprint, so a rule naming the same people hides nothing more. Clear them, and the rules that do hide something stand out.', targets: repeats, who: [] })
    for (const t of nobody) out.push({ id: `nobody:${targetId(t)}`, severity: 'medium', title: `Nobody but an admin sees ${byTarget.get(targetId(t))!.title}`, detail: 'Some people pass the blueprint\'s rule and some pass the field\'s, but nobody passes both. A person must pass both to see it.', targets: [t, { kind: 'blueprint', id: (t as { blueprint: string }).blueprint }], who: [] })
    const order = { high: 0, medium: 1, low: 2 }
    return out.map((f) => ({ ...f, family: familyOf(f.id) })).sort((a, b) => order[a.severity] - order[b.severity] || a.family.localeCompare(b.family) || a.title.localeCompare(b.title))
  }

  /**
   * Every value set by hand on a field or relation access is decided from,
   * newest first. A blueprint only an admin changes is left out: nobody else
   * could have set one there.
   */
  private async handmade(): Promise<PostureHandmade[]> {
    type Layer = Record<string, { by?: string; at?: string }>
    // What access is decided from, by blueprint, read for every blueprint at once: one question for fields and one for relations.
    const fields: { blueprint: string; names: string[] }[] = []
    const relations: { blueprint: string; names: string[] }[] = []
    for (const bp of this.model()) {
      const decides = this.deps.visibility.decidesOn(bp.id)
      if (decides.all || !decides.names.length) continue
      const f = decides.names.filter((n) => n in bp.fields || n === 'title' || n === 'icon')
      const r = decides.names.filter((n) => n in bp.relations)
      if (f.length) fields.push({ blueprint: bp.id, names: f })
      if (r.length) relations.push({ blueprint: bp.id, names: r })
    }
    // Only what a person set reaches either index, so neither reads the rows a source alone wrote.
    const [byField, byRelation] = await Promise.all([
      fields.length
        ? this.deps.db.query<{ blueprint: string; key: string; title: string; ui: Layer; override: Layer; names: string[] }>(
            `SELECT e.blueprint, e.key, e.title, e.ui, e.override, w.names
             FROM jsonb_to_recordset($1::jsonb) AS w(blueprint text, names text[])
             JOIN entities e ON e.blueprint = w.blueprint
             WHERE (e.ui <> '{}'::jsonb OR e.override <> '{}'::jsonb) AND e.state <> 'deleted' AND (e.ui ?| w.names OR e.override ?| w.names)`,
            [JSON.stringify(fields)],
          )
        : null,
      relations.length
        ? this.deps.db.query<{ blueprint: string; key: string; title: string; relation: string; by: string; at: Date; over: boolean }>(
            `SELECT r.blueprint, r.key, e.title, r.relation, min(r.source) AS by, max(r.at) AS at,
               EXISTS (SELECT 1 FROM relations p WHERE p.blueprint = r.blueprint AND p.key = r.key AND p.relation = r.relation AND p.layer <> 'ui') AS over
             FROM jsonb_to_recordset($1::jsonb) AS w(blueprint text, names text[])
             JOIN relations r ON r.blueprint = w.blueprint AND r.layer = 'ui' AND r.relation = ANY(w.names)
             JOIN entities e ON e.blueprint = r.blueprint AND e.key = r.key
             WHERE e.state <> 'deleted'
             GROUP BY r.blueprint, r.key, e.title, r.relation`,
            [JSON.stringify(relations)],
          )
        : null,
    ])
    const out: PostureHandmade[] = []
    for (const r of byField?.rows ?? []) {
      for (const name of r.names) {
        const set = r.override[name] ?? r.ui[name]
        if (set) out.push({ entity: { blueprint: r.blueprint, key: r.key }, title: r.title, name, kind: 'field', over: !!r.override[name], by: set.by ?? null, at: set.at ?? null })
      }
    }
    for (const r of byRelation?.rows ?? []) out.push({ entity: { blueprint: r.blueprint, key: r.key }, title: r.title, name: r.relation, kind: 'relation', over: r.over, by: r.by, at: r.at.toISOString() })
    return out.sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''))
  }

  /** The homes these actions name that the catalog holds, by entity id. */
  private async homesHeld(actions: Action[]): Promise<Set<string>> {
    const refs = [...new Set(actions.flatMap((a) => (a.home ? [a.home] : [])))].flatMap((id) => parseEntityId(id) ?? [])
    if (!refs.length) return new Set()
    const rows = await this.deps.db.query<{ blueprint: string; key: string }>(`SELECT blueprint, key FROM entities WHERE (blueprint, key) IN (SELECT * FROM unnest($1::text[], $2::text[])) AND state <> 'deleted'`, [refs.map((r) => r.blueprint), refs.map((r) => r.key)])
    return new Set(rows.rows.map((r) => entityId(r)))
  }

  /**
   * Who changes what by hand: every blueprint's fields and relations with
   * the one authority over each, the hand values standing over what a source
   * says, and, for one person, what the edit rules open to them. It asks
   * `Visibility` what a rule may open and what is an admin's; nothing is
   * decided here.
   */
  async edits(person?: string): Promise<EditsResponse> {
    const { visibility, db } = this.deps
    const held = await db.query<{ blueprint: string; n: string }>(`SELECT blueprint, count(*) AS n FROM entities WHERE state = 'active' GROUP BY blueprint`)
    const entities = new Map(held.rows.map((r) => [r.blueprint, Number(r.n)]))
    const blueprints: EditBlueprint[] = []
    for (const bp of this.model()) {
      if (isHubBlueprint(bp.id)) continue
      const open = visibility.openable(bp.id)
      const only = this.adminOnlyReason(bp.id)
      const decided = new Set(visibility.decidesOn(bp.id).names)
      const adminWhy = (name: string, marked: boolean): string | null =>
        marked ? 'An admin marked it: only an admin changes it' : decided.has(name) ? 'Access is decided from it: an admin or a holder of access.values changes it' : only === 'marked' ? `An admin marked ${bp.title}: only an admin changes its entities` : only === 'person' ? `${bp.title} says who a person is: only an admin changes its entities` : only ? `Access is decided from ${bp.title}: only an admin changes its entities` : null
      const names: EditName[] = []
      for (const [name, def] of Object.entries(bp.fields)) {
        const rules = (open.fields.get(name) ?? []).map((r) => r.id)
        const admin = adminWhy(name, !!def.adminEdit)
        const [authority, why]: [EditAuthority, string] = isDerived(def)
          ? ['derived', 'Worked out by the hub from other values']
          : def.overridable === false
            ? ['source', 'Locked: only the sources that write it change it']
            : rules.length
              ? ['rule', only ? 'Open to whoever an edit rule lets in' : 'Open to whoever an edit rule lets in, and to a holder of entities.edit']
              : admin
                ? ['admin', admin]
                : ['holders', 'Open to a holder of entities.edit, over what a source says too']
        names.push({ name, title: def.title ?? name, kind: 'field', authority, why, rules })
      }
      for (const [name, def] of Object.entries(bp.relations)) {
        const rules = (open.relations.get(name) ?? []).map((r) => r.id)
        const admin = adminWhy(name, false)
        const [authority, why]: [EditAuthority, string] = rules.length ? ['rule', only ? 'Open to whoever an edit rule lets in' : 'Open to whoever an edit rule lets in, and to a holder of entities.edit'] : admin ? ['admin', admin] : ['holders', 'Open to a holder of entities.edit']
        names.push({ name, title: def.title ?? name, kind: 'relation', authority, why, rules })
      }
      const counts = Object.fromEntries(EDIT_AUTHORITIES.map((a) => [a, names.filter((n) => n.authority === a).length])) as Record<EditAuthority, number>
      blueprints.push({ id: bp.id, title: bp.title, group: bp.group ?? null, entities: entities.get(bp.id) ?? 0, counts, names })
    }
    const { overrides, total } = await this.overrides()
    const out: EditsResponse = { blueprints, overrides, overridesTotal: total }
    if (person) {
      const judged = (await this.principals()).find((j) => j.principal.kind === 'person' && j.principal.name === person.toLowerCase())
      const editor = judged && !judged.principal.admin ? await visibility.editorFor(judged.principal.name) : null
      out.person = {
        name: person.toLowerCase(),
        known: !!judged,
        admin: !!judged?.principal.admin,
        holds: !!judged && (judged.principal.admin || judged.principal.permissions.includes('entities.edit')),
        opened: editor ? blueprints.flatMap((bp) => editor.reach(bp.id).map((r) => ({ blueprint: bp.id, ...r }))) : [],
      }
    }
    return out
  }

  /** The hand values that stand over what a source says, oldest first: each stays wrong for as long as the source keeps saying the same. */
  private async overrides(): Promise<{ overrides: StandingOverride[]; total: number }> {
    const rows = await this.deps.db.query<{ blueprint: string; key: string; title: string; field: string; override: { value: unknown; basis: unknown; by: string; at: string }; pushed: { value: unknown; source: string } | null }>(
      `SELECT e.blueprint, e.key, e.title, o.key AS field, o.value AS override, e.pushed -> o.key AS pushed
         FROM entities e, jsonb_each(e.override) o
        WHERE e.state <> 'deleted' AND e.override <> '{}'::jsonb
        ORDER BY o.value ->> 'at'`,
    )
    // An override stands only while the source still says what it was set over.
    const standing = rows.rows.filter((r) => r.pushed && stable(r.pushed.value) === stable(r.override.basis))
    const overrides = standing.slice(0, OVERRIDES_SHOWN).map((r) => ({
      blueprint: r.blueprint,
      key: r.key,
      title: r.title,
      field: r.field,
      value: r.override.value,
      pushed: r.pushed!.value,
      source: r.pushed!.source,
      by: r.override.by,
      at: r.override.at,
      sticky: !!this.deps.blueprints.get(r.blueprint)?.fields[r.field]?.sticky,
    }))
    return { overrides, total: standing.length }
  }

  private model(): Blueprint[] {
    return [...this.deps.blueprints.list()].sort((a, b) => (a.group ?? '').localeCompare(b.group ?? '') || a.title.localeCompare(b.title))
  }

  private adminCount(judged: Judged[]): number {
    return judged.filter((j) => j.principal.kind === 'person' && j.principal.admin).length
  }

  private adminOnlyReason(id: string): AdminOnlyReason | null {
    if (!this.deps.visibility.isAdminOnly(id)) return null
    if (this.deps.blueprints.get(id)?.adminEdit) return 'marked'
    if (this.deps.visibility.personSetting()?.blueprint === id) return 'person'
    return 'decides access'
  }

  /** Whether a principal changes a blueprint's entities at all: a blueprint access is decided from takes a holder of access.values too, unless an admin marked it. */
  private changesBlueprint(j: Judged, id: string): boolean {
    if (j.principal.admin) return true
    if (!j.principal.permissions.includes('entities.edit') || !j.view.seesBlueprint(id)) return false
    return !this.deps.visibility.isAdminOnly(id) || (j.principal.permissions.includes('access.values') && !this.deps.blueprints.get(id)?.adminEdit)
  }

  /** Whether a principal who changes a blueprint's entities changes this field or relation by hand: one access is decided from takes an admin or a holder of access.values. */
  private changesName(j: Judged, blueprint: string, name: string): boolean {
    return this.deps.visibility.refusesHandEdit(j.identity, blueprint, [name]) === null
  }

  private async runs(j: Judged, a: Action): Promise<boolean> {
    return this.deps.visibility.mayRun(j.identity, a)
  }

  /** Whether an action with this access would let the principal run it on anything, the way `mayRun` judges a saved one. */
  private async runsWith(j: Judged, access: ActionAccess | undefined, a: Action): Promise<boolean> {
    if (j.identity.admin) return true
    if (access?.everyone) return true
    const policy = this.deps.visibility.accessPolicy()
    const grants = actionGrants(policy, access)
    let lets = (grants.length > 0 && (await this.deps.visibility.grantsLetIn(j.identity.name, grants))) || (await this.deps.visibility.homeLetsIn(j.identity, a.home, access?.home))
    for (const r of access?.rules ?? []) {
      if (lets) break
      if (r.except?.some((e) => e.toLowerCase() === j.identity.name.toLowerCase())) continue
      lets = await this.deps.visibility.ruleLetsIn(j.identity, r, actionTargets(a), policy)
    }
    return lets && j.view.seesAction(a)
  }

  private async ruleAllows(j: Judged, rule: AccessRule | undefined): Promise<boolean> {
    if (j.identity.admin || j.identity.kind !== 'user') return true
    const grants = resolveRule(this.deps.visibility.accessPolicy(), rule)
    return grants === null || this.deps.visibility.grantsLetIn(j.identity.name, grants)
  }

  private async via(j: Judged, access: ActionAccess | undefined, home: string | undefined, on: string[]): Promise<string> {
    if (j.identity.admin) return 'admin'
    if (access?.everyone) return 'everyone'
    const own = await this.letIn(j, access?.grants ?? [], access?.audiences ?? [])
    if (own) return own
    if (await this.deps.visibility.homeLetsIn(j.identity, home, access?.home)) return HOME_PEOPLE
    for (const r of access?.rules ?? []) {
      if (r.except?.some((e) => e.toLowerCase() === j.identity.name.toLowerCase())) continue
      if (!(await this.deps.visibility.ruleLetsIn(j.identity, r, on))) continue
      const who = r.audiences?.length || r.grants?.length ? await this.letIn(j, r.grants ?? [], r.audiences ?? []) : 'anyone signed in'
      const also = (r.require ?? []).map(grantWords)
      return `${[who ?? 'anyone signed in', ...also].join(' and ')}, on ${ruleWords(r)}`
    }
    return 'admin'
  }

  private async ruleVia(j: Judged, rule: AccessRule | undefined): Promise<string> {
    if (j.identity.admin) return 'admin'
    if (j.identity.kind !== 'user') return 'machine token'
    if (!rule) return 'open'
    return (await this.letIn(j, rule.grants, rule.audiences ?? [])) ?? 'open'
  }

  /** The audience or grant that lets the principal in, in words, audiences first; null when none does. */
  private async letIn(j: Judged, grants: AccessGrant[], audiences: string[]): Promise<string | null> {
    const policy = this.deps.visibility.accessPolicy()
    for (const id of audiences) {
      const inner = audienceGrants(policy, [id])
      if (inner.length && (await this.deps.visibility.grantsLetIn(j.identity.name, inner))) return `audience ${policy.audiences.find((a) => a.id === id)?.title ?? id}`
    }
    const i = await this.deps.visibility.grantLettingIn(j.identity.name, grants)
    return i >= 0 ? grantWords(grants[i]!) : null
  }
}

/** How a person let in by owning an action's home is said to run it. */
const HOME_PEOPLE = "its home's people"
/** What the posture says of a field an aggregation's `summary` mark opens, and of a person who sees it that way. */
const SUMMARY_NOTE = 'a summary: its number is shown to people who may not see what it reads'
const SUMMARY_VIA = 'as a summary: the number alone, they may not see what it reads'

/** The words for many findings of one kind, by the kind their id starts with. */
const FAMILIES: Record<string, string> = {
  'no-person': 'Rules follow paths, but nobody is a person entity',
  everyone: 'Actions open to everyone signed in',
  wide: 'Actions open to most people',
  blind: 'Actions some who may run them cannot see',
  perm: 'Permissions that widen reach, held by people who are not admins',
  'admin-tokens': 'Access tokens that hold the admin role',
  'source-actions': 'Sources that define actions',
  path: 'Grants that read a path the model lacks',
  'home-unowned': 'Actions open to their home\'s people, while the model does not say what a person owns',
  'home-gone': 'Actions whose home is not in the catalog',
  'action-unused': 'Actions nobody has run in 90 days',
  decides: 'Blueprints that decide access, yet others can change',
  'audience-empty': 'Audiences that let nobody in',
  'audience-strangers': 'Audiences that name people the hub does not know',
  'class-empty': 'Classes that cover no field',
  'set-aside': 'Field rules a class sets aside',
  repeats: 'Field rules that repeat their blueprint\'s',
  nobody: 'Fields nobody but an admin sees, because nobody passes both rules',
}

function familyOf(id: string): string {
  return FAMILIES[id.split(':')[0]!] ?? id.split(':')[0]!
}

/** A rule with its grants' values and its audiences in order, to compare two rules by what they say. */
function sortedRule(rule: AccessRule): unknown {
  return { grants: [...rule.grants].map((g) => ({ ...g, values: [...g.values].map((v) => v.toLowerCase()).sort() })).sort((a, b) => stable(a).localeCompare(stable(b))), audiences: [...(rule.audiences ?? [])].sort() }
}

/** A grant in words: its path and the values it takes. */
export function grantWords(g: AccessGrant): string {
  const from = g.path ? `${g.path}${g.field ? `.${g.field}` : ''}` : g.field ? g.field : 'address'
  return `${from} is ${g.values.join(' or ')}`
}

function originLabel(o: BlueprintOrigin | Action['origin']): string {
  if (o.kind === 'git') return `git ${o.file}`
  if (o.kind === 'source') return `source ${o.source}`
  return o.kind === 'hub' ? 'hub' : 'web app'
}

function blueprintNotes(bp: Blueprint, adminOnly: AdminOnlyReason | null): string[] {
  const out: string[] = []
  if (adminOnly === 'decides access') out.push('access is decided from it')
  if (adminOnly === 'person') out.push('it holds the people')
  if (bp.adminEdit) out.push('only an admin changes it')
  if (bp.access) out.push('seen by some people only')
  if (bp.timeline) out.push('its timeline is read by some people only')
  if (Object.values(bp.fields).some((f) => f.type === 'secretRef')) out.push('holds references to secrets')
  return out
}

function actionNotes(a: Action): string[] {
  const out = [backendWords(a.backend.type)]
  if (a.access?.everyone) out.push('open to everyone signed in')
  if (a.home && a.access?.home) out.push(a.access.home === true ? "open to its home's people" : `open to its home's people who are ${a.access.home.join(' or ')} of it`)
  if (a.where && (delegated(a) || a.access?.everyone)) out.push('runs only on what its filter takes')
  if (a.self) out.push("runs only on each person's own entity")
  if (a.access?.rules?.length) out.push(`${a.access.rules.length === 1 ? 'a rule decides' : `${a.access.rules.length} rules decide`} who runs it on what`)
  if (!a.access?.everyone && !delegated(a)) out.push("an admin's alone")
  if (a.approval) out.push('waits for approval')
  return out
}

/** What a rule takes of an action's entities, in words. */
function ruleWords(r: ActionRule): string {
  const roles = r.owns === true ? [] : (r.owns ?? []).filter((o) => o !== SELF_ROLE)
  const what = r.owns === true ? 'what is theirs' : r.owns ? [...(namesSelf(r) ? ['their own person entity'] : []), ...(roles.length ? [`what they are ${roles.join(' or ')} of`] : [])].join(' and ') : 'everything'
  return `${what}${r.where ? ' that its filter takes' : ''}${r.approval ? ', with approval' : ''}`
}

/** Whether an action's access names anyone: a grant, an audience, a rule, or its home's people. */
function delegated(a: Action): boolean {
  return !!(a.access?.grants?.length || a.access?.audiences?.length || a.access?.rules?.length || (a.home && a.access?.home))
}

function backendWords(type: string): string {
  switch (type) {
    case 'runner':
      return 'backend is a runner job, outside the hub'
    case 'job':
      return 'backend is a container started for each run, outside the hub'
    case 'webhook':
      return 'backend is a webhook, outside the hub'
    case 'github_workflow':
      return 'backend is a GitHub workflow, outside the hub'
    default:
      return `backend is ${type}`
  }
}


/** The first grant whose path names a relation the model lacks, in words, or null. */
function badPath(blueprints: Blueprints, person: string, grants: AccessGrant[]): string | null {
  for (const g of grants) {
    if (!g.path) continue
    try {
      parsePath(g.path)
      blueprints.checkGrantPath(person, g.path, `The path "${g.path}"`)
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }
  return null
}

const sameGrant = (a: AccessGrant, b: AccessGrant) => (a.path ?? '') === (b.path ?? '') && (a.field ?? '') === (b.field ?? '')

/** The grants after one change, merged by path and field so values are never listed twice. */
function nextGrants(was: AccessGrant[], op: 'set' | 'add' | 'remove', grants: AccessGrant[]): AccessGrant[] {
  const clean = (list: AccessGrant[]) => list.map((g) => ({ ...(g.path ? { path: g.path } : {}), ...(g.field ? { field: g.field } : {}), values: [...new Set(g.values.map((v) => v.trim()).filter(Boolean))] })).filter((g) => g.values.length)
  if (op === 'set') return merge(clean(grants))
  if (op === 'add') return merge([...was, ...clean(grants)])
  const drop = clean(grants)
  return was
    .map((g) => {
      const match = drop.filter((d) => sameGrant(d, g))
      if (!match.length) return g
      const gone = new Set(match.flatMap((d) => d.values.map((v) => v.toLowerCase())))
      return { ...g, values: g.values.filter((v) => !gone.has(v.toLowerCase())) }
    })
    .filter((g) => g.values.length)
}

function merge(list: AccessGrant[]): AccessGrant[] {
  const out: AccessGrant[] = []
  for (const g of list) {
    const at = out.find((x) => sameGrant(x, g))
    if (at) at.values = [...new Set([...at.values, ...g.values])]
    else out.push({ ...g, values: [...g.values] })
  }
  return out
}

/** The audiences after one change, the way `nextGrants` changes the grants. */
function nextAudiences(was: string[], op: 'set' | 'add' | 'remove', ids: string[]): string[] {
  if (op === 'set') return [...new Set(ids)]
  if (op === 'add') return [...new Set([...was, ...ids])]
  return was.filter((a) => !ids.includes(a))
}

/** What a blueprint's rule opens to the people who own its entities, in words, with how many of them see some today. */
function subjectsNote(bp: Blueprint, seeing: number): string[] {
  const subjects = bp.access?.subjects
  if (!subjects?.length) return []
  return [`Whoever sees what one is about, through ${subjects.join(', ')}, sees it (${seeing} ${seeing === 1 ? 'person' : 'people'} today)`]
}

function ownersNote(bp: Blueprint, seeing: number): string[] {
  const owners = bp.access?.owners
  if (!owners) return []
  const fields = owners.fields === 'all' ? 'every field no rule or class keeps from them' : owners.fields.length ? owners.fields.join(', ') : 'no field'
  return [`Owners by ${owners.roles.join(', ')} see their own (${seeing} ${seeing === 1 ? 'person' : 'people'} today), with ${fields}`]
}

function nextRule(was: AccessRule | undefined, change: NonNullable<PostureChange['access']>): AccessRule | undefined {
  if (change.op === 'clear') return undefined
  const grants = nextGrants(was?.grants ?? [], change.op, change.grants ?? [])
  const audiences = nextAudiences(was?.audiences ?? [], change.op, change.audiences ?? [])
  // A change to who sees all of it leaves who sees their own, and who sees what is about what they see, as it was.
  const owners = was?.owners
  const subjects = was?.subjects
  return grants.length || audiences.length || owners || subjects ? { grants, ...(audiences.length ? { audiences } : {}), ...(owners ? { owners } : {}), ...(subjects ? { subjects } : {}) } : undefined
}

function nextActionAccess(was: ActionAccess | undefined, change: NonNullable<PostureChange['access']>): ActionAccess | undefined {
  if (change.op === 'clear') return change.everyone ? { everyone: true } : undefined
  const grants = nextGrants(was?.grants ?? [], change.op, change.grants ?? [])
  const audiences = nextAudiences(was?.audiences ?? [], change.op, change.audiences ?? [])
  const everyone = change.everyone ?? !!was?.everyone
  // A change to who runs it everywhere leaves the rules for who runs it on what, and whether its home's people run it, as they were.
  const rules = was?.rules ?? []
  const home = was?.home
  if (!grants.length && !audiences.length && !everyone && !rules.length && !home) return undefined
  return { ...(everyone ? { everyone: true } : {}), ...(grants.length ? { grants } : {}), ...(audiences.length ? { audiences } : {}), ...(home ? { home } : {}), ...(rules.length ? { rules } : {}) }
}

/** Every audience that holds this one, through any depth, and the audience itself. */
function holders(policy: AccessPolicy, id: string): Set<string> {
  const out = new Set<string>([id])
  for (let grew = true; grew; ) {
    grew = false
    for (const a of policy.audiences) {
      if (out.has(a.id) || !a.audiences.some((x) => out.has(x))) continue
      out.add(a.id)
      grew = true
    }
  }
  return out
}

function setRule<T extends { access?: AccessRule }>(target: T, rule: AccessRule | undefined): void {
  if (rule) target.access = rule
  else delete target.access
}

function setMark<T extends { adminEdit?: boolean }>(target: T, on: boolean): void {
  if (on) target.adminEdit = true
  else delete target.adminEdit
}

function pick(x: { access?: unknown; adminEdit?: unknown } | undefined): unknown {
  return { access: x?.access ?? null, adminEdit: !!x?.adminEdit }
}

