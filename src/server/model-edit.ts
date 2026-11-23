// A person's change to the model. The model page, the API, and an agent's
// tools all change a blueprint, a relation rule, a scorecard, or an alert rule
// here, with the same checks and the same side effects: there is no second way
// in. Each store still decides what a definition may say; this decides who may
// say it, and what follows once it is said.

import { z } from 'zod'
import { RESERVED_PREFIX, blueprintNamer, type AccessRule, type Blueprint, type BlueprintInput, type ChangeKind, type FieldDef, type RelationRule, type ScorecardOrigin } from '../shared/model.ts'
import type { Scorecard } from '../shared/api.ts'
import { partsOf } from '../shared/scorecard.ts'
import { classFor } from '../shared/policy.ts'
import { alertRuleSchema, type Alerts } from './alerts.ts'
import { BlueprintError, blueprintSchema, type Blueprints } from './blueprints.ts'
import type { Entities } from './entities.ts'
import type { Events } from './events.ts'
import type { Logger } from './log.ts'
import { ruleSchema, type Rules } from './rules.ts'
import type { Runs } from './runs.ts'
import { ScorecardError, scorecardSchema, type Scorecards } from './scorecards.ts'
import type { Sources } from './sources.ts'
import { PolicyError, seenPartly, type View, type Visibility } from './visibility.ts'
import { DefinitionError } from './definition-error.ts'

export { DefinitionError }

/** The parts of the model a person changes, each by its id. */
export const MODEL_KINDS = ['blueprint', 'rule', 'scorecard', 'alert_rule'] as const
export type ModelKind = (typeof MODEL_KINDS)[number]

/** The activity a change to each part of the model is recorded as. */
export const MODEL_CHANGES: Record<ModelKind, ChangeKind> = { blueprint: 'blueprint.changed', rule: 'rule.changed', scorecard: 'scorecard.changed', alert_rule: 'alert_rule.changed' }

/** The model as `/v1/model/import` takes it: every part a person may change, as its definition. */
export interface ModelFile {
  blueprints: BlueprintInput[]
  relationRules: Omit<RelationRule, 'origin'>[]
  scorecards: Omit<Scorecard, 'origin' | 'updatedAt'>[]
  alertRules: { id: string; blueprint: string; where: string }[]
}

/** One part of the model as its caller may change it: the definition, who defines it, and whether a person may change it here. */
export interface ModelPart {
  kind: ModelKind
  id: string
  definition: Record<string, unknown>
  origin: { kind: string; source?: string; file?: string }
  /** False where git or the hub defines it: it is changed there, never here. */
  changeable: boolean
}

/** Something the caller may not see: it answers as if it were not there. */
export class Hidden extends Error {}
/** Something only an admin changes. */
export class AdminOnly extends Error {}

/**
 * Why a change to the model was turned down, as the caller is told it, or
 * null for an error that is not a refusal. `refusal` names the policy a
 * refusal on access counts under. The API and the agent's tools answer with
 * the same words.
 */
export function modelRefusal(error: unknown): { status: 400 | 403 | 404 | 409; error: string; offenders?: BlueprintError['offenders']; refusal?: 'hidden_field' | 'hand_edit' } | null {
  if (error instanceof BlueprintError) return { status: 400, error: error.message, offenders: error.offenders }
  if (error instanceof Hidden) return { status: 404, error: error.message, refusal: 'hidden_field' }
  if (error instanceof AdminOnly) return { status: 403, error: error.message, refusal: 'hand_edit' }
  if (error instanceof PolicyError) return { status: 400, error: error.message }
  if (error instanceof ScorecardError) return { status: error.status, error: error.message }
  if (error instanceof DefinitionError) return { status: error.status, error: error.message }
  if (error instanceof z.ZodError) return { status: 400, error: error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') }
  return null
}

export const grantSchema = z.object({ path: z.string().min(1).optional(), field: z.string().min(1).optional(), values: z.array(z.string().min(1)).min(1) })
const ownersSchema = z.object({ roles: z.array(z.string().min(1)).min(1), fields: z.union([z.literal('all'), z.array(z.string().min(1))]) })
/** A timeline's rule names who reads it, by grants and audiences; owners and subjects open entities, not their history. */
export const timelineRuleSchema = z.object({ grants: z.array(grantSchema).default([]), audiences: z.array(z.string().min(1)).optional() }).strict()

export const accessRuleSchema = z.object({ grants: z.array(grantSchema).default([]), audiences: z.array(z.string().min(1)).optional(), owners: ownersSchema.optional(), subjects: z.array(z.string().min(1)).min(1).optional() }).refine((r) => r.grants.length > 0 || (r.audiences?.length ?? 0) > 0 || !!r.owners || !!r.subjects, 'A rule names a grant, an audience, owners, or subjects')

export const handOverSchema = z.object({ source: z.string().min(1), fields: z.array(z.string().min(1)).max(500).default([]), status: z.boolean().default(false) })

/**
 * A change laid over a definition, as JSON Merge Patch (RFC 7396) says: an
 * object merges into the object it names, null removes what it names, and
 * anything else, a list included, takes the place of what was there.
 */
export function mergePatch(target: unknown, patch: unknown): unknown {
  if (!isObject(patch)) return patch
  const out: Record<string, unknown> = isObject(target) ? { ...target } : {}
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k]
    else out[k] = mergePatch(out[k], v)
  }
  return out
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

export function stableJson(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : x))
}

/** A blueprint as a reader sees it: no field or relation they may not see, and no access rule, its timeline's included, unless they are an admin. */
export function shown(bp: Blueprint, view: View, visibility: Visibility): Blueprint {
  const decides = visibility.decidesOn(bp.id)
  const marked = decides.all || decides.names.length ? { decides } : {}
  if (view.all) return { ...bp, ...marked }
  // A field opened on what the reader owns is described: it shows on their own rows and is blank on the rest.
  const opened = view.ownerOpened(bp.id)
  const hidden = new Set([...view.hiddenFields(bp.id)].filter((k) => !opened.has(k)))
  const summaries = view.summaries(bp.id)
  const fields = Object.fromEntries(Object.entries(bp.fields).filter(([k]) => !hidden.has(k)).map(([k, f]) => [k, stripRule(summaries.has(k) ? asSummary(f) : f, !!visibility.fieldRule(bp.id, k, f.access))]))
  // A relation to a blueprint the reader may not see is not described: that it exists would tell them.
  const relations = Object.fromEntries(Object.entries(bp.relations).filter(([, r]) => view.seesSome(r.target)))
  const { access: _a, timeline: _t, ...rest } = bp
  return { ...rest, fields, relations, ...(bp.access ? { restricted: true } : {}), ...(view.readsTimeline(bp.id) ? {} : { noTimeline: true }), ...seenPartly(view, bp), ...(decides.all || decides.names.length ? { decides: { all: decides.all, names: decides.names.filter((n) => !hidden.has(n)) } } : {}) }
}

/** A summary's definition for a reader shown its number alone: derived, and not how. What it reads names a blueprint and fields they may not see. */
export function asSummary(f: FieldDef): FieldDef {
  const { aggregation: _a, summary: _s, ...rest } = f
  return { ...rest, derived: true }
}

function stripRule(f: FieldDef, restricted: boolean): FieldDef {
  const { access: _a, ...rest } = f
  return restricted ? { ...rest, restricted: true } : rest
}

/** What each part of the model's definition is read by, so a change can be told what it names that no definition holds. */
const DEFINITION_SCHEMAS: Record<ModelKind, z.ZodType> = { blueprint: blueprintSchema, rule: ruleSchema, scorecard: scorecardSchema, alert_rule: alertRuleSchema }

/** Every path a change sets, other than to remove it, that the definition read from it does not hold. */
export function unknownPaths(patch: unknown, read: unknown, at = ''): string[] {
  if (!isObject(patch)) return []
  if (!isObject(read)) return at ? [] : Object.keys(patch)
  return Object.entries(patch).flatMap(([k, v]) => {
    const path = at ? `${at}.${k}` : k
    if (v === null) return []
    if (!(k in read) || read[k] === undefined) return [path]
    return unknownPaths(v, read[k], path)
  })
}

/** A blueprint as it is defined: what a save takes, without where it came from or what a reader is told beside it. */
export function definitionOf(bp: Blueprint): BlueprintInput {
  const { origin: _o, updatedAt: _u, restricted: _r, onlyYours: _y, onlyAbout: _b, decides: _d, ...spec } = bp
  return { ...spec, fields: Object.fromEntries(Object.entries(spec.fields).map(([name, f]) => { const { restricted: _fr, derived: _fd, ...def } = f; return [name, def] })) }
}

const ruleDefinition = ({ origin: _o, ...rule }: RelationRule): Omit<RelationRule, 'origin'> => rule
const scorecardDefinition = ({ origin: _o, updatedAt: _u, ...card }: Scorecard): Omit<Scorecard, 'origin' | 'updatedAt'> => card

interface ModelEditDeps {
  blueprints: Blueprints
  rules: Rules
  scorecards: Scorecards
  alerts: Alerts
  sources: Sources
  entities: Entities
  runs: Runs
  events: Events
  visibility: Visibility
  log: Logger
}

/** Who changes the model: their name, as the activity log names them, and what they see. */
export interface Caller {
  name: string
  view: View
}

export class ModelEdits {
  private readonly deps: ModelEditDeps
  constructor(deps: ModelEditDeps) {
    this.deps = deps
  }

  /** A blueprint the caller may not see answers as if it did not exist. */
  seen(view: View, blueprint: string): void {
    if (!view.seesBlueprint(blueprint)) throw new Hidden(`Unknown blueprint "${blueprint}"`)
  }

  /** Every grant a person sets is checked from the person blueprint, so a rule that could let nobody in is refused where it is made. */
  checkGrants(spec: Partial<BlueprintInput>, id: string | null, access?: AccessRule): void {
    const { blueprints, visibility } = this.deps
    const person = visibility.personSetting()?.blueprint
    if (!person) return
    const saving = id ? ({ ...spec, id } as BlueprintInput) : undefined
    const rules: { rule: AccessRule | undefined; what: string }[] = [
      { rule: access ?? spec.access, what: 'Access' },
      { rule: spec.timeline, what: 'Timeline' },
      ...Object.entries(spec.fields ?? {}).map(([name, def]) => ({ rule: def?.access, what: `Field "${name}": access` })),
    ]
    for (const { rule, what } of rules) for (const g of rule?.grants ?? []) if (g.path) blueprints.checkGrantPath(person, g.path, `${what} (from ${person})`, saving)
  }

  /** Every audience a rule names exists, and a field a class covers takes no rule of its own: change the class, or leave the field out of it. */
  checkPolicyRefs(spec: Partial<BlueprintInput>, id: string | null, access?: { audiences?: string[] }): void {
    const policy = this.deps.visibility.accessPolicy()
    const known = new Set(policy.audiences.map((a) => a.id))
    const rules: { audiences?: string[] }[] = [access ?? spec.access ?? {}, spec.timeline ?? {}, ...Object.values(spec.fields ?? {}).map((def) => def?.access ?? {})]
    for (const r of rules) for (const a of r.audiences ?? []) if (!known.has(a)) throw new PolicyError(`There is no audience "${a}"`)
    if (!id) return
    const existing = this.deps.blueprints.get(id)
    for (const [name, def] of Object.entries(spec.fields ?? {})) {
      const cls = classFor(policy, id, name)
      // Taking a rule off a classified field is always allowed: the class decides either way.
      if (!cls || !def?.access || stableJson(def.access) === stableJson(existing?.fields[name]?.access ?? null)) continue
      throw new PolicyError(`Field "${name}" is in the ${cls.title} class, which decides who sees it: change the class, or leave the field out of it`)
    }
  }

  /** One part of the model as the caller may see it, or null when there is none they may see. */
  part(caller: Caller, kind: ModelKind, id: string): ModelPart | null {
    const { blueprints, rules, scorecards, alerts, visibility } = this.deps
    const { view } = caller
    const changeable = (origin: { kind: string }) => origin.kind !== 'git' && origin.kind !== 'hub'
    if (kind === 'blueprint') {
      const bp = blueprints.get(blueprints.resolve(id))
      if (!bp || !view.seesSome(bp.id)) return null
      return { kind, id: bp.id, definition: { ...definitionOf(shown(bp, view, visibility)) }, origin: bp.origin, changeable: changeable(bp.origin) }
    }
    if (kind === 'rule') {
      const rule = rules.list().find((r) => r.id === id)
      if (!rule || !view.seesBlueprint(rule.blueprint) || !view.seesBlueprint(rule.match.target)) return null
      return { kind, id, definition: { ...ruleDefinition(rule) }, origin: rule.origin, changeable: changeable(rule.origin) }
    }
    if (kind === 'scorecard') {
      const card = scorecards.get(id)
      if (!card || partsOf(card).some((p) => !view.seesBlueprint(p.blueprint))) return null
      return { kind, id, definition: { ...scorecardDefinition(card) }, origin: card.origin, changeable: changeable(card.origin) && card.origin.kind !== 'source' }
    }
    const rule = alerts.listRules().find((r) => r.id === id)
    if (!rule || !view.seesBlueprint(rule.blueprint)) return null
    return { kind, id, definition: { id: rule.id, blueprint: rule.blueprint, where: rule.where }, origin: rule.origin, changeable: changeable(rule.origin) }
  }

  /** The model as the caller sees it, in the form the import takes. One blueprint names it and every rule, scorecard, and alert rule on it. */
  model(caller: Caller, blueprint?: string): ModelFile {
    const { blueprints, rules, scorecards, alerts, visibility } = this.deps
    const { view } = caller
    const one = blueprint ? blueprints.resolve(blueprint) : null
    if (one) this.seen(view, one)
    const on = (...ids: string[]) => !one || ids.includes(one)
    return {
      blueprints: blueprints
        .list()
        .filter((bp) => !bp.id.startsWith(RESERVED_PREFIX) && view.seesSome(bp.id) && on(bp.id))
        .map((bp) => definitionOf(shown(bp, view, visibility))),
      relationRules: rules
        .list()
        .filter((r) => view.seesBlueprint(r.blueprint) && view.seesBlueprint(r.match.target) && on(r.blueprint))
        .map(ruleDefinition),
      scorecards: scorecards
        .list()
        .filter((s) => partsOf(s).every((p) => view.seesBlueprint(p.blueprint)) && on(...partsOf(s).map((p) => p.blueprint)))
        .map(scorecardDefinition),
      alertRules: alerts
        .listRules()
        .filter((r) => view.seesBlueprint(r.blueprint) && on(r.blueprint))
        .map((r) => ({ id: r.id, blueprint: r.blueprint, where: r.where })),
    }
  }

  /** Saves a part of the model whole, as the editor sends it. A new id creates it. `origin` is a scorecard's, when a source with the grant puts its own. */
  async save(caller: Caller, kind: ModelKind, id: string, body: Record<string, unknown>, origin: ScorecardOrigin = { kind: 'ui' }): Promise<unknown> {
    if (kind === 'blueprint') return this.saveBlueprint(caller, id, body)
    if (kind === 'rule') return this.saveRule(caller, id, body)
    if (kind === 'scorecard') return this.saveScorecard(caller, id, body, origin)
    return this.saveAlertRule(caller, id, body)
  }

  /**
   * Lays a change over a part of the model as it is stored and saves the
   * result through `save`, so it is checked and followed as the editor's own
   * save is. A part that does not exist yet is created from the change.
   */
  async change(caller: Caller, kind: ModelKind, id: string, patch: Record<string, unknown>): Promise<unknown> {
    const merged = mergePatch(this.stored(kind, id) ?? {}, patch) as Record<string, unknown>
    // A name a definition does not take is refused, never dropped: a misspelt option would otherwise change nothing and say so nowhere.
    const read = DEFINITION_SCHEMAS[kind].safeParse({ ...merged, id })
    if (read.success) {
      const unknown = unknownPaths(patch, read.data)
      if (unknown.length) throw new DefinitionError(`${unknown.map((p) => `"${p}"`).join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not part of a ${kind.replace('_', ' ')}'s definition; get_model_definition shows what it holds`)
    }
    this.deps.log.info('model change laid over its definition', { kind, id, actor: caller.name, created: !this.stored(kind, id), keys: Object.keys(patch) })
    return this.save(caller, kind, id, merged)
  }

  /** Removes a part of the model. */
  async remove(caller: Caller, kind: ModelKind, id: string, origin: ScorecardOrigin = { kind: 'ui' }): Promise<void> {
    const { blueprints, rules, scorecards, alerts, events, runs } = this.deps
    const { view } = caller
    if (kind === 'blueprint') {
      this.guardWhole(view, id)
      await blueprints.remove(id, caller.name)
      events.emit({ type: 'blueprints' })
      return
    }
    if (kind === 'rule') {
      const was = rules.list().find((r) => r.id === id)
      if (!was) throw new DefinitionError(`Unknown rule "${id}"`, 404)
      this.guardRule(view, [was.blueprint])
      await rules.remove(id)
      runs.relink()
      return
    }
    if (kind === 'scorecard') {
      const was = scorecards.get(id)
      // A scorecard on a blueprint the caller may not see answers as if it were not there.
      if (was) for (const part of partsOf(was)) if (!view.seesBlueprint(part.blueprint)) throw new ScorecardError(404, `Unknown scorecard "${id}"`)
      await scorecards.remove(id, origin)
      return
    }
    const was = alerts.listRules().find((r) => r.id === id)
    if (!was || !view.seesBlueprint(was.blueprint)) throw new DefinitionError(`Unknown alert rule "${id}"`, 404)
    await alerts.removeRule(id)
  }

  /** Renames a blueprint and everything that names it. */
  async rename(caller: Caller, id: string, to: string): Promise<Blueprint> {
    const { blueprints, rules, scorecards, alerts, sources, events } = this.deps
    this.guardWhole(caller.view, id)
    const renamed = await blueprints.rename(id, to, caller.name)
    // Rules, scorecards, alert rules, and sources name blueprints too, and were rewritten with it.
    await Promise.all([rules.load(), scorecards.load(), alerts.load(), sources.load()])
    events.emit({ type: 'blueprints' })
    events.emit({ type: 'estate' })
    return renamed
  }

  /** Forgets a name a blueprint was known by, so another blueprint may take it. */
  async forget(caller: Caller, id: string, name: string): Promise<Blueprint> {
    this.guardWhole(caller.view, id)
    const kept = await this.deps.blueprints.forget(id, name, caller.name)
    this.deps.events.emit({ type: 'blueprints' })
    return kept
  }

  /** Gives a source the definitions of fields it did not bring, so its next offer keeps them current. An admin's alone: it decides whose rules a blueprint follows. */
  async handOver(caller: Caller, id: string, body: z.input<typeof handOverSchema>): Promise<Blueprint> {
    if (!caller.view.admin) throw new AdminOnly('Only an admin hands a definition to a source')
    const { blueprints, sources, events } = this.deps
    const handed = await blueprints.handOver(id, handOverSchema.parse(body), (source) => !!sources.get(source), caller.name)
    events.emit({ type: 'blueprints' })
    return handed
  }

  /** What a change is laid over: the part's definition as the hub holds it, or null when it holds none. */
  private stored(kind: ModelKind, id: string): Record<string, unknown> | null {
    const { blueprints, rules, scorecards, alerts } = this.deps
    if (kind === 'blueprint') {
      const bp = blueprints.get(id)
      return bp ? { ...definitionOf(bp) } : null
    }
    if (kind === 'rule') {
      const rule = rules.list().find((r) => r.id === id)
      return rule ? { ...ruleDefinition(rule) } : null
    }
    if (kind === 'scorecard') {
      const card = scorecards.get(id)
      return card ? { ...scorecardDefinition(card) } : null
    }
    const rule = alerts.listRules().find((r) => r.id === id)
    return rule ? { id: rule.id, blueprint: rule.blueprint, where: rule.where } : null
  }

  private async saveBlueprint(caller: Caller, id: string, sent: Record<string, unknown>): Promise<Blueprint> {
    const { blueprints, entities, events, runs, visibility } = this.deps
    const body = this.guardModel(caller.view, id, sent)
    const saved = await blueprints.save({ ...body, id }, { kind: 'ui' }, caller.name, (bp, field) => entities.valuesOf(bp, field))
    // A pivot turned on or off shows its fields in the answer, not at the next tick.
    await blueprints.syncPivots()
    events.emit({ type: 'blueprints' })
    runs.relink()
    return shown(blueprints.get(saved.id) ?? saved, caller.view, visibility)
  }

  private async saveRule(caller: Caller, id: string, body: Record<string, unknown>): Promise<RelationRule> {
    const { rules, runs } = this.deps
    const was = rules.list().find((r) => r.id === id)
    this.guardRule(caller.view, [String(body.blueprint ?? ''), was?.blueprint])
    const saved = await rules.save({ ...body, id }, { kind: 'ui' })
    await rules.evaluate(saved)
    // What inherits through what the rule links is linked again after the answer.
    runs.relink()
    return saved
  }

  private async saveScorecard(caller: Caller, id: string, body: Record<string, unknown>, origin: ScorecardOrigin): Promise<Scorecard> {
    const { view } = caller
    const parsed = scorecardSchema.safeParse(body)
    // A scorecard a person may not read is not one they may write either: its passes would tell them what they cannot see.
    // One that does not parse is refused by the save with the reason; there is nothing to check yet.
    if (parsed.success) {
      for (const part of partsOf(parsed.data)) {
        this.seen(view, part.blueprint)
        if (part.where && view.refusedFilter(part.blueprint, part.where)) throw new Hidden(`The scope reads "${view.refusedFilter(part.blueprint, part.where)}", which you cannot see`)
        for (const l of part.levels) for (const r of l.rules) if (view.refusedFilter(part.blueprint, r.where)) throw new Hidden(`A rule reads "${view.refusedFilter(part.blueprint, r.where)}", which you cannot see`)
      }
    }
    return this.deps.scorecards.save({ ...body, id }, origin)
  }

  private async saveAlertRule(caller: Caller, id: string, body: Record<string, unknown>) {
    const was = this.deps.alerts.listRules().find((r) => r.id === id)
    for (const blueprint of [String(body.blueprint ?? ''), was?.blueprint]) if (blueprint) this.seen(caller.view, blueprint)
    return this.deps.alerts.saveRule({ ...body, id }, { kind: 'ui' })
  }

  /**
   * The model decides who sees what and who changes what, so the parts of it
   * that do are an admin's alone: a blueprint only an admin changes, and the
   * access rules and admin locks on any blueprint or field. Anyone else's
   * save keeps them as they are, and a save that would change them is refused.
   */
  private guardModel(view: View, id: string, body: Record<string, unknown>): Record<string, unknown> {
    const { blueprints, visibility } = this.deps
    const existing = blueprints.get(id)
    if (existing) this.seen(view, id)
    if (view.admin) {
      if (body.access !== undefined) accessRuleSchema.parse(body.access)
      if (body.timeline !== undefined && body.timeline !== null) timelineRuleSchema.parse(body.timeline)
      for (const def of Object.values((body.fields ?? {}) as Record<string, { access?: unknown }>)) if (def?.access !== undefined) accessRuleSchema.parse(def.access)
      this.checkGrants(body as Partial<BlueprintInput>, id)
      this.checkPolicyRefs(body as Partial<BlueprintInput>, id)
      return body
    }
    if (existing && visibility.isAdminOnly(id)) throw new AdminOnly(`Only an admin changes the ${existing.title} blueprint: access to the hub is decided from it`)
    // A person who is not an admin never reads a rule or a lock, so what they send back leaves them as they were. Sending a different one is refused.
    const keep = <T extends { access?: unknown; timeline?: unknown; adminEdit?: unknown; summary?: unknown }>(sent: Record<string, unknown>, was: T | undefined, what: string): Record<string, unknown> => {
      for (const k of ['access', 'timeline', 'adminEdit', 'summary'] as const) {
        if (k in sent && sent[k] !== undefined && stableJson(sent[k]) !== stableJson(was?.[k] ?? null)) throw new AdminOnly(`Only an admin sets who may see or change ${what}`)
      }
      const { access: _a, timeline: _t, adminEdit: _e, summary: _s, restricted: _r, noTimeline: _n, derived: _d, ...rest } = sent
      return { ...rest, ...(was?.access ? { access: was.access } : {}), ...(was?.timeline ? { timeline: was.timeline } : {}), ...(was?.adminEdit ? { adminEdit: was.adminEdit } : {}), ...(was?.summary ? { summary: was.summary } : {}) }
    }
    const sentFields = (body.fields ?? {}) as Record<string, Record<string, unknown>>
    const hidden = view.hiddenFields(id)
    const fields: Record<string, unknown> = {}
    for (const [name, def] of Object.entries(sentFields)) {
      if (hidden.has(name)) continue
      fields[name] = keep(def, existing?.fields[name], `"${name}"`)
    }
    // A field this person may not see is not theirs to remove, retype, or relock: it stays as it is. So does a summary: they were shown its number, never how it is worked out.
    for (const name of [...hidden, ...view.summaries(id)]) if (existing?.fields[name]) fields[name] = existing.fields[name]
    const kept = keep(body, existing, `the ${existing?.title ?? id} blueprint`)
    if (body.relations === undefined) return { ...kept, fields }
    // So is a relation to a blueprint they may not see: they were never told it is there.
    const relations: Record<string, unknown> = {}
    for (const [name, def] of Object.entries(body.relations as Record<string, { target?: string }>)) if (!def?.target || view.seesBlueprint(def.target)) relations[name] = def
    for (const [name, def] of Object.entries(existing?.relations ?? {})) if (!view.seesBlueprint(def.target)) relations[name] = def
    return { ...kept, fields, relations }
  }

  /** Renaming or removing a blueprint takes its access rules with it, so it is an admin's alone when it has any. */
  private guardWhole(view: View, id: string): void {
    const { blueprints, visibility } = this.deps
    this.seen(view, id)
    if (view.admin) return
    const bp = blueprints.get(id)
    if (visibility.isAdminOnly(id) || bp?.access || bp?.timeline || Object.entries(bp?.fields ?? {}).some(([name, f]) => f.adminEdit || visibility.fieldRule(id, name, f.access))) {
      const named = blueprintNamer(blueprints.list().filter((b) => view.seesSome(b.id)))
      throw new AdminOnly(`Only an admin renames or removes the ${named(bp ?? id)} blueprint: it decides who sees or changes something`)
    }
  }

  /** A relation rule writes relations: on a blueprint only an admin changes, only an admin keeps one. */
  private guardRule(view: View, blueprintIds: (string | undefined)[]): void {
    for (const id of blueprintIds) {
      if (!id) continue
      this.seen(view, id)
      if (!view.admin && this.deps.visibility.isAdminOnly(id)) throw new AdminOnly(`Only an admin keeps a relation rule on ${this.deps.blueprints.get(id)?.title ?? id}: access to the hub is decided from it`)
    }
  }
}
