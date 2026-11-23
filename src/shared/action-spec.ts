// The shape of an action's definition, and every check on it that needs
// nothing but the definition and the blueprints. The hub refuses a save these
// fail; the web app's editor shows the same issues while the YAML is typed.

import { z } from 'zod'
import { whenReads } from './asked.ts'
import { compile } from './expr.ts'
import { fieldOf, parsePath, stable } from './filter.ts'
import { aKind, defIssues, INPUT_KINDS } from './input-kinds.ts'
import { editsList } from './list-change.ts'
import { REPORT_INPUTS, REPORT_VERBS, type ReportVerb } from './report.ts'
import { hasTemplate, pathsOf, render } from './template.ts'
import { ACTION_INPUT_TYPES, DATASET_TYPES, BATCH_MAX, QUORUM_MAX, SCHEDULE_MIN_MS, RETRY_BACKOFF_MAX_MS, RETRY_TRIES_MAX, actionTargets, entityId, FILTER_OPS, inputPicks, isDerived, parseDuration, parseEntityId, REPORT_BLUEPRINT, SHOW_MAX, TOOL_TIERS, type ActionInputDef, type Blueprint, type Entity, type FieldDef, type Filter } from './model.ts'

const NAME = /^[a-z][a-z0-9_]*$/
/** The name of one of a starter's job templates. */
const TEMPLATE = /^[a-z0-9][a-z0-9_-]*$/
/** What a field holds for a job template's name to be built from it: a part of a name, and never nothing. */
const TEMPLATE_PART = /^[a-z0-9_-]+$/
/** The one thing a job's `template` may read: a field of the entity the run is on. */
const TEMPLATE_READ = /^entity\.fields\.([^.]+)$/
const TEMPLATE_NAMED = 'a job template is named in lowercase letters, digits, - and _: it is one of the starter\'s own, never a path'
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
/** What a job is handed by the hub and its starter: an action's own `env` never names one. */
export const JOB_ENV_PREFIX = 'ORRERY_'
/** What the hub keeps about every entity, which a sort may name without a field. */
const HUB_FIELDS = new Set(['key', 'title', 'icon', 'blueprint', 'state', 'owner', 'status', 'createdAt', 'updatedAt', 'lastSeenAt'])
export const filterSchema: z.ZodType<Filter> = z.lazy(() => z.record(z.string(), z.unknown())) as unknown as z.ZodType<Filter>
/** One blueprint, or several, each named once. */
const blueprintsSchema = z.union([z.string().min(1), z.array(z.string().min(1)).min(1).refine((l) => new Set(l).size === l.length, 'name each blueprint once')])

const inputSchema = z.object({
  type: z.enum(ACTION_INPUT_TYPES),
  title: z.string().optional(),
  description: z.string().optional(),
  required: z.boolean().optional(),
  default: z.unknown().optional(),
  many: z.boolean().optional(),
  values: z.union([z.array(z.string()), z.string()]).optional(),
  display: z.enum(['list', 'buttons']).optional(),
  blueprint: blueprintsSchema.optional(),
  narrows: z.string().min(1).optional(),
  where: filterSchema.optional(),
  sort: z.string().regex(/^-?\$?[a-zA-Z][a-zA-Z0-9_]*$/).optional(),
  current: z.string().optional(),
  pattern: z.string().min(1).optional(),
  min: z.union([z.number(), z.string().min(1)]).optional(),
  max: z.union([z.number(), z.string().min(1)]).optional(),
  minLength: z.number().int().min(0).optional(),
  maxLength: z.number().int().min(0).optional(),
  hint: z.string().min(1).optional(),
  when: filterSchema.optional(),
  value: z.string().min(1).optional(),
  unique: z.object({ blueprint: z.string().min(1), field: z.string().min(1) }).optional(),
  show: z.array(z.string().min(1)).min(1).max(SHOW_MAX).optional(),
})

const backendSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('webhook'), url: z.string().min(1), method: z.enum(['GET', 'POST', 'PUT', 'DELETE']).optional(), query: z.record(z.string().min(1), z.string()).optional(), headers: z.record(z.string(), z.string()).optional(), secretRef: z.string().min(1).optional(), onBehalf: z.string().min(1).optional(), finish: z.enum(['answer', 'reveal']).optional(), timeout: z.string().optional(), body: z.unknown().optional() }),
  z.object({ type: z.literal('github_workflow'), owner: z.string().min(1), repo: z.string().min(1), workflow: z.string().min(1), ref: z.string().min(1).optional(), inputs: z.record(z.string(), z.string()).optional(), secretRef: z.string().min(1) }),
  z.object({ type: z.literal('runner'), runner: z.string().min(1), command: z.array(z.string()).min(1), env: z.record(z.string(), z.string()).optional(), timeout: z.string().optional() }),
  // Writes one entity of the catalog, as the named source, and succeeds the run: a request, a note, a decision recorded where people look.
  z.object({
    type: z.literal('record'),
    source: z.string().min(1),
    blueprint: z.string().min(1),
    key: z.string().min(1),
    mode: z.enum(['upsert', 'enrich']).optional(),
    title: z.string().optional(),
    fields: z.record(z.string(), z.unknown()).optional(),
    relations: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({ type: z.literal('caller'), timeout: z.string().optional() }),
  // One container for the run, started by a starter the estate runs from one of the starter's own templates.
  z.object({
    type: z.literal('job'),
    starter: z.string().min(1),
    template: z.string().min(1),
    image: z.string().min(1),
    command: z.array(z.string()).optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string().regex(ENV_NAME, 'an environment name is letters, digits, and _'), z.string()).optional(),
  }),
  z.object({ type: z.literal('decide'), verdict: z.enum(['approve', 'decline']), note: z.string().optional() }),
  z.object({ type: z.literal('schedule'), verb: z.enum(['pause', 'resume', 'run']) }),
  z.object({ type: z.literal('report'), verb: z.enum(REPORT_VERBS) }),
])

const grantSchema = z.object({ path: z.string().min(1).optional(), field: z.string().min(1).optional(), values: z.array(z.string()).min(1) })
/** What a person must be to an entity: theirs in any way, or by one of the roles of the person setting's `owns` paths. */
const ownsSchema = z.union([z.literal(true), z.array(z.string().min(1)).min(1)])
const ruleSchema = z.object({
  audiences: z.array(z.string().min(1)).optional(),
  grants: z.array(grantSchema).optional(),
  require: z.array(grantSchema).optional(),
  except: z.array(z.string().min(1)).optional(),
  owns: ownsSchema.optional(),
  where: filterSchema.optional(),
  approval: z.union([z.boolean(), z.literal('self')]).optional(),
})
/** Tool tiers, each named once. */
export const tiersSchema = z.array(z.enum(TOOL_TIERS)).refine((l) => new Set(l).size === l.length, 'name each tier once')

/** The most columns one dataset answers with. */
export const DATASET_COLUMNS_MAX = 60

export const actionSchema = z.object({
  id: z.string().regex(NAME, 'an action id is lowercase letters, digits, and _'),
  title: z.string().min(1),
  description: z.string().optional(),
  icon: z.string().optional(),
  group: z.string().optional(),
  /** The entity the action belongs to, as `blueprint:key`. */
  home: z.string().refine((id) => !!parseEntityId(id), 'a home is an entity id, as blueprint:key').optional(),
  blueprint: blueprintsSchema.optional(),
  where: filterSchema.optional(),
  /** true: it runs only on the caller's own person entity, for everyone, an admin too. */
  self: z.literal(true).optional(),
  inputs: z.record(z.string().regex(NAME), inputSchema).default({}),
  backend: backendSchema,
  approval: z.boolean().optional(),
  selfApproval: z.boolean().optional(),
  confirm: z.boolean().optional(),
  /** false: no form anywhere. Only a tool starts it, on the machine port; its runs and approvals show as any other's. */
  form: z.boolean().optional(),
  /** false: run only from what it runs on, never from a tile on the Self-service page. */
  listed: z.boolean().optional(),
  serial: z.array(z.string().regex(NAME)).optional(),
  /** The most runs of the action in flight at once, across every batch and single run: the rest wait their turn, oldest first. */
  concurrency: z.number().int().min(1).optional(),
  /** The longest a run may stay running, however often it is heard from. */
  ceiling: z.string().min(1).optional(),
  /** The fields of the entity it runs on that a run hands back to be written once it succeeds. */
  refreshes: z.array(z.string().min(1)).min(1).refine((l) => new Set(l).size === l.length, 'name each field once').optional(),
  /** The action may run on many entities at once, each its own run: at most `max` in one batch. */
  batch: z.object({ max: z.number().int().min(2).max(BATCH_MAX) }).optional(),
  /** A failed run is tried again, `tries` times in all, waiting `backoff` and then three times longer each time. */
  /** More than one person must approve before it starts. */
  quorum: z.object({ need: z.number().int().min(2).max(QUORUM_MAX) }).optional(),
  retry: z.object({ tries: z.number().int().min(2).max(RETRY_TRIES_MAX), backoff: z.string().min(1) }).optional(),
  /** People may schedule it, at most once every `min`, once a schedule is approved. */
  schedule: z.object({ min: z.string().min(1) }).optional(),
  /** The headings of the form, each over the inputs it names. */
  sections: z.array(z.object({ title: z.string().min(1), description: z.string().optional(), inputs: z.array(z.string().regex(NAME)) })).optional(),
  /** true: the form is walked one section at a time. */
  walk: z.boolean().optional(),
  access: z.object({ everyone: z.boolean().optional(), grants: z.array(grantSchema).optional(), audiences: z.array(z.string().min(1)).optional(), home: ownsSchema.optional(), rules: z.array(ruleSchema).optional(), tiers: tiersSchema.optional() }).optional(),
  /** Makes the action a tool: called by an agent, answered in the call. */
  tool: z.object({ tier: z.enum(TOOL_TIERS), from: z.string().refine((id) => !!parseEntityId(id), 'a tool is declared from an entity id, as blueprint:key').optional() }).optional(),
  /** Makes a read tool a published dataset: a table a saved query may read. */
  dataset: z
    .object({
      entity: z.string().refine((id) => !!parseEntityId(id), 'a dataset is called on an entity id, as blueprint:key').optional(),
      columns: z.array(z.object({ id: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/, 'a column id is letters, digits, and _'), title: z.string().min(1).optional(), type: z.enum(DATASET_TYPES).optional() })).min(1).max(DATASET_COLUMNS_MAX),
      fresh: z.string().min(1).optional(),
    })
    .optional(),
})
export type ActionSpec = z.infer<typeof actionSchema>

/** One thing wrong with a definition, at the path of the value it is about. */
export interface SpecIssue {
  path: (string | number)[]
  message: string
}

export type CheckedAction = { spec: ActionSpec; issues: [] } | { spec: null; issues: SpecIssue[] }

/**
 * The definition parsed, or what is wrong with it. With `blueprints`, every
 * blueprint the action names must be one of them, its home's included, and
 * the sort of an input that picks an entity must name a field of the
 * blueprint it picks from. The home's entity need not exist yet. `person` is
 * the blueprint the estate says a person is: null when it says none, which
 * refuses a person input, and left out when nobody asked.
 */
export function checkAction(input: unknown, blueprints?: Pick<Blueprint, 'id' | 'fields' | 'relations'>[], person?: string | null): CheckedAction {
  const parsed = actionSchema.safeParse(input)
  if (!parsed.success) return { spec: null, issues: parsed.error.issues.map((i) => ({ path: i.path.filter((p): p is string | number => typeof p !== 'symbol'), message: i.message })) }
  const spec = parsed.data
  const issues: SpecIssue[] = []
  const byId = blueprints && new Map(blueprints.map((b) => [b.id, b]))
  const targets = actionTargets(spec)
  if (byId) for (const b of targets) if (!byId.has(b)) issues.push({ path: ['blueprint'], message: `Unknown blueprint "${b}"` })
  const home = spec.home ? parseEntityId(spec.home) : null
  if (home && byId && !byId.has(home.blueprint)) issues.push({ path: ['home'], message: `home: unknown blueprint "${home.blueprint}"` })
  if (spec.access?.home && !spec.home) issues.push({ path: ['access', 'home'], message: 'access: home opens the action to the people who own its home, so the action needs a home' })
  if (spec.self) {
    if (person === null) issues.push({ path: ['self'], message: 'self: it runs on the caller\'s own person, and the estate says no blueprint is a person' })
    else if (person !== undefined && !targets.includes(person)) issues.push({ path: ['self'], message: `self: it runs on the caller's own person, so its blueprint is ${person}, the one the estate says a person is` })
    if (spec.batch) issues.push({ path: ['batch'], message: 'batch: a self action runs on one entity, the caller\'s own, so it is never asked for many' })
  }
  const declared = Object.keys(spec.inputs)
  /** What is wrong with an input that a `when` or a `value` of `name` reads, or null: it reads the inputs declared above it. */
  const misread = (name: string, what: 'when' | 'value', read: string): string | null => {
    if (read === name) return `${what} reads the input itself`
    if (!(read in spec.inputs)) return `${what} reads "${read}", which is not an input`
    if (declared.indexOf(read) > declared.indexOf(name)) return `${what} reads "${read}", which is declared after it: an input is ${what === 'when' ? 'asked by' : 'worked out from'} the inputs above it`
    return null
  }
  /** The inputs each input's `when` and `value` read, for the order its sections must keep. */
  const reads = new Map<string, { what: 'when' | 'value'; read: string }[]>()
  for (const [name, def] of Object.entries(spec.inputs)) {
    const at = (...rest: (string | number)[]) => ['inputs', name, ...rest]
    const kind = INPUT_KINDS[def.type]
    const read: { what: 'when' | 'value'; read: string }[] = []
    reads.set(name, read)
    if (def.when) {
      const tested = whenReads(def.when)
      const op = badOp(def.when)
      if (def.narrows) issues.push({ path: at('when'), message: `input "${name}": an input that narrows the target is asked before it, so it is always asked` })
      else if (tested.refused) issues.push({ path: at('when'), message: `input "${name}": ${tested.refused}` })
      else if (op) issues.push({ path: at('when'), message: `input "${name}": when tests "${op.field}" with "${op.op}", which is not a test` })
      else
        for (const field of tested.fields) {
          const wrong = misread(name, 'when', field)
          if (wrong) issues.push({ path: at('when'), message: `input "${name}": ${wrong}` })
          else read.push({ what: 'when', read: field })
        }
    }
    if (def.value !== undefined) {
      if (def.narrows) issues.push({ path: at('value'), message: `input "${name}": an input that narrows the target is filled from it, never worked out` })
      else if (kind.picks) issues.push({ path: at('value'), message: `input "${name}": ${aKind(def.type)} is picked, never worked out` })
      else {
        if (def.default !== undefined) issues.push({ path: at('default'), message: `input "${name}": a worked-out input is never asked, so it has no default` })
        if (def.required) issues.push({ path: at('required'), message: `input "${name}": a worked-out input is never asked, so it is never required: a rule on it refuses what it works out` })
        if (def.many) issues.push({ path: at('many'), message: `input "${name}": a worked-out input is one value` })
        try {
          for (const field of compile(def.value).reads) {
            const wrong = misread(name, 'value', field)
            if (wrong) issues.push({ path: at('value'), message: `input "${name}": ${wrong}` })
            else read.push({ what: 'value', read: field })
          }
        } catch (error) {
          issues.push({ path: at('value'), message: `input "${name}": value does not parse: ${error instanceof Error ? error.message : String(error)}` })
        }
      }
    }
    if (def.unique && kind.options.includes('unique') && byId) {
      const bp = byId.get(def.unique.blueprint)
      if (!bp) issues.push({ path: at('unique', 'blueprint'), message: `input "${name}": unknown blueprint "${def.unique.blueprint}"` })
      else if (def.unique.field !== 'key' && def.unique.field !== 'title' && !bp.fields[def.unique.field]) issues.push({ path: at('unique', 'field'), message: `input "${name}": ${bp.id} has no field "${def.unique.field}"` })
    }
    const picks = inputPicks(def, person)
    if (kind.person && person === null) issues.push({ path: at('type'), message: `input "${name}": a person input needs the estate to say who a person is, which an admin does on the Access page` })
    if (kind.picks === 'entity' && !kind.person && !picks.length) issues.push({ path: at('blueprint'), message: `input "${name}": an entity input names the blueprint to pick from` })
    if (kind.picks === 'entity' && byId) {
      const sortField = def.sort?.replace(/^-/, '')
      for (const b of picks) {
        const bp = byId.get(b)
        if (!bp) issues.push({ path: at('blueprint'), message: `input "${name}": unknown blueprint "${b}"` })
        else if (sortField && !sortField.startsWith('$') && !bp.fields[sortField] && !HUB_FIELDS.has(sortField)) issues.push({ path: at('sort'), message: `input "${name}": sort names "${sortField}", which ${bp.id} has no field for` })
      }
    }
    if (def.show && kind.options.includes('show')) {
      const among = byId ? picks.flatMap((b) => byId.get(b) ?? []) : []
      for (const [i, field] of def.show.entries()) {
        if (def.show.indexOf(field) < i) issues.push({ path: at('show', i), message: `input "${name}": show names "${field}" twice` })
        else if (among.length && !among.some((bp) => bp.fields[field])) issues.push({ path: at('show', i), message: `input "${name}": show names "${field}", which no blueprint it picks from has a field for` })
      }
    }
    if (kind.picks === 'values' && !def.values) issues.push({ path: at('values'), message: `input "${name}": an enum input needs values` })
    for (const issue of defIssues(def.type, def)) issues.push({ path: at(issue.at), message: `input "${name}": ${issue.message}` })
    if (def.narrows && kind.options.includes('narrows')) {
      if (!targets.length) issues.push({ path: at('narrows'), message: `input "${name}": only an action that runs on a blueprint has a target to narrow` })
      if (def.many) issues.push({ path: at('narrows'), message: `input "${name}": an input that narrows the target is one value` })
      for (const b of byId ? targets : []) {
        const bp = byId!.get(b)
        if (!bp) continue
        if (kind.picks === 'entity') {
          const rel = bp.relations[def.narrows]
          if (!rel) issues.push({ path: at('narrows'), message: `input "${name}": ${b} has no relation "${def.narrows}"` })
          else if ((!kind.person || person) && !picks.includes(rel.target)) issues.push({ path: at('narrows'), message: `input "${name}": ${b}.${def.narrows} points at ${rel.target}, which the input does not pick from` })
        } else if (!bp.fields[def.narrows] && !HUB_FIELDS.has(def.narrows)) issues.push({ path: at('narrows'), message: `input "${name}": ${b} has no field "${def.narrows}"` })
      }
    }
  }
  if (spec.walk && !spec.sections?.length) issues.push({ path: ['walk'], message: 'walk: a form is walked one section at a time, so the action needs sections' })
  if (spec.sections) {
    const seen = new Map<string, number>()
    for (const [s, section] of spec.sections.entries()) {
      if (!section.inputs.length) issues.push({ path: ['sections', s, 'inputs'], message: 'sections: a section holds at least one input' })
      for (const [i, name] of section.inputs.entries()) {
        const at = ['sections', s, 'inputs', i]
        const def = spec.inputs[name]
        if (!def) issues.push({ path: at, message: `sections: "${name}" is not an input` })
        else if (seen.get(name) === s) issues.push({ path: at, message: `sections: "${name}" is in the section twice` })
        else if (seen.has(name)) issues.push({ path: at, message: `sections: "${name}" is in two sections` })
        else if (def.narrows) issues.push({ path: at, message: `sections: "${name}" narrows what the action runs on, so it is asked with that, above every section` })
        else {
          // What the input reads is asked before it: above it in a section, or with what the action runs on.
          for (const { what, read } of reads.get(name) ?? []) if (!seen.has(read) && !spec.inputs[read]?.narrows) issues.push({ path: at, message: `sections: "${name}" comes before "${read}", which its ${what} reads` })
        }
        if (def && !seen.has(name)) seen.set(name, s)
      }
    }
  }
  const grantPaths: { path: (string | number)[]; grant: { path?: string } }[] = (spec.access?.grants ?? []).map((grant, i) => ({ path: ['access', 'grants', i, 'path'], grant }))
  for (const [r, rule] of (spec.access?.rules ?? []).entries()) {
    const at = (...rest: (string | number)[]) => ['access', 'rules', r, ...rest]
    if (!rule.audiences?.length && !rule.grants?.length && !rule.require?.length && !rule.owns && !rule.where) issues.push({ path: at(), message: 'access: a rule says who, what they are to the entity, or what the entity is; to open the action to everyone, use everyone' })
    if ((rule.owns || rule.where) && !targets.length) issues.push({ path: at(), message: 'access: a rule that reads the entity needs an action that runs on a blueprint' })
    for (const [i, grant] of (rule.grants ?? []).entries()) grantPaths.push({ path: at('grants', i, 'path'), grant })
    for (const [i, grant] of (rule.require ?? []).entries()) grantPaths.push({ path: at('require', i, 'path'), grant })
  }
  for (const { path, grant } of grantPaths) {
    try {
      if (grant.path) parsePath(grant.path)
    } catch (error) {
      issues.push({ path, message: `access: ${error instanceof Error ? error.message : String(error)}` })
    }
  }
  if (spec.selfApproval && !spec.approval && !(spec.access?.rules ?? []).some((r) => r.approval)) issues.push({ path: ['selfApproval'], message: 'selfApproval: the action never waits for approval, so there is nothing to approve' })
  if (spec.access?.tiers?.length && !targets.length) issues.push({ path: ['access', 'tiers'], message: 'access: tiers are held on an entity, so the action needs a blueprint' })
  if (spec.tool) {
    if (spec.backend.type !== 'runner') issues.push({ path: ['backend', 'type'], message: 'tool: a tool runs on a runner, which holds the identity it runs as' })
    // Who may call a tool is whoever holds its tier, so it takes no rule, no approval, and no form of its own.
    // A dataset is the one tool with access of its own: who may read it in a query, beside whoever holds its tier.
    for (const key of ['access', 'approval', 'selfApproval', 'confirm', 'sections', 'walk'] as const) if (spec[key] !== undefined && !(key === 'access' && spec.dataset)) issues.push({ path: [key], message: `tool: a tool has no ${key}; whoever holds its tier on the entity may call it` })
    if (spec.form) issues.push({ path: ['form'], message: 'tool: a tool has no form' })
    if (spec.serial && spec.tool.tier !== 'act') issues.push({ path: ['serial'], message: 'serial: only a tool that acts runs one at a time' })
  }
  if (spec.dataset) {
    const d = spec.dataset
    if (spec.tool?.tier !== 'read') issues.push({ path: ['dataset'], message: 'dataset: a dataset is a read tool; give the action tool: { tier: read }' })
    const on = d.entity ? parseEntityId(d.entity) : null
    if (targets.length && !on) issues.push({ path: ['dataset', 'entity'], message: `dataset: the tool runs on ${targets.join(', ')}, so the dataset names the entity it is called on, as blueprint:key` })
    if (on && !targets.includes(on.blueprint)) issues.push({ path: ['dataset', 'entity'], message: targets.length ? `dataset: the tool runs on ${targets.join(', ')}, not a ${on.blueprint}` : 'dataset: the tool runs on no blueprint, so the dataset names no entity' })
    const ids = d.columns.map((c) => c.id.toLowerCase())
    const twice = ids.find((id, i) => ids.indexOf(id) !== i)
    if (twice) issues.push({ path: ['dataset', 'columns'], message: `dataset: column "${twice}" is named twice` })
    for (const [name, def] of Object.entries(spec.inputs)) if (def.required && def.default === undefined) issues.push({ path: ['inputs', name], message: `dataset: a dataset is read with no inputs, so input "${name}" takes a default or is not required` })
    if (d.fresh !== undefined) {
      try {
        if (parseDuration(d.fresh) < 60_000) issues.push({ path: ['dataset', 'fresh'], message: 'dataset: an answer is kept for a minute at least' })
      } catch {
        issues.push({ path: ['dataset', 'fresh'], message: 'dataset: fresh is a duration, such as 15m or 1h' })
      }
    }
    if (spec.access?.rules?.length || spec.access?.tiers?.length) issues.push({ path: ['access'], message: 'dataset: who may read a dataset is everyone, grants, audiences, or its home; it takes no rules and lends no tiers' })
  }
  if (spec.batch) {
    if (!targets.length) issues.push({ path: ['batch'], message: 'batch: a batch runs on many entities, so the action needs a blueprint' })
    if (spec.tool) issues.push({ path: ['batch'], message: 'batch: a tool is called once, by an agent; it has no batch' })
    if (spec.form === false) issues.push({ path: ['batch'], message: 'batch: a batch is asked from the form, and this action has none' })
    for (const [name, why] of unbatchable(spec.inputs)) issues.push({ path: ['inputs', name], message: `batch: input "${name}" ${why}, so it cannot be asked once for many` })
  }
  if (spec.backend.type === 'webhook' && spec.backend.onBehalf) {
    // The person's token is at hand only in their own request, so nothing may hand the run on later. A run that waits for
    // approval is made as whoever approves it, from their approval's own request (`runsAs` in the hub's actions).
    const why = 'the call is made as a person, from their own request'
    if (spec.backend.secretRef) issues.push({ path: ['backend', 'secretRef'], message: `backend: ${why}, so it carries their token and no secret` })
    if (spec.retry) issues.push({ path: ['retry'], message: `retry: ${why}, so the hub cannot try it again later` })
    if (spec.tool) issues.push({ path: ['tool'], message: `tool: ${why}, and a tool is called by an agent` })
  }
  if (spec.backend.type === 'webhook' && spec.backend.finish === 'reveal') {
    // The answer is given to one person as they ask, so the run must be that person's own request and one of one.
    if (!spec.backend.onBehalf) issues.push({ path: ['backend', 'finish'], message: 'backend: an answer that is revealed goes to the person who asked, in their own request, so the call is made as them: name a delegate in onBehalf' })
    if (spec.batch) issues.push({ path: ['batch'], message: 'batch: an answer that is revealed is given once, to one request, so the action has no batch' })
    if (spec.approval || (spec.access?.rules ?? []).some((r) => r.approval)) issues.push({ path: ['approval'], message: 'approval: an answer that is revealed is given to the request that asks for the run, so the run cannot wait for approval' })
  }
  if (spec.backend.type === 'webhook' && spec.backend.method === 'GET' && spec.backend.body !== undefined) issues.push({ path: ['backend', 'body'], message: 'backend: a GET carries no body' })
  if (spec.quorum) {
    const waits = !!spec.approval || (spec.access?.rules ?? []).some((r) => r.approval === true)
    if (!waits) issues.push({ path: ['quorum'], message: 'quorum: nobody approves this action, so there is no one to ask for more than one yes; set approval: true, or a rule with approval: true' })
    if ((spec.access?.rules ?? []).some((r) => r.approval === 'self')) issues.push({ path: ['quorum'], message: 'quorum: a rule lets people approve their own run, which more than one yes cannot be asked of' })
    if (spec.tool) issues.push({ path: ['quorum'], message: 'quorum: a tool has no approval' })
  }
  if (spec.retry) {
    if (spec.backend.type === 'record' || spec.backend.type === 'caller' || spec.backend.type === 'decide' || spec.backend.type === 'schedule' || spec.backend.type === 'report') issues.push({ path: ['retry'], message: `retry: a ${spec.backend.type} backend is not handed the run again; only a runner, a job, a webhook, or a workflow is` })
    try {
      const ms = parseDuration(spec.retry.backoff)
      if (ms < 1000 || ms > RETRY_BACKOFF_MAX_MS) issues.push({ path: ['retry', 'backoff'], message: `retry: the backoff is at least 1s and at most ${RETRY_BACKOFF_MAX_MS / 60_000}m` })
    } catch (error) {
      issues.push({ path: ['retry', 'backoff'], message: `retry: ${error instanceof Error ? error.message : String(error)}` })
    }
  }
  if (spec.listed === false && !actionTargets(spec).length) issues.push({ path: ['listed'], message: 'listed: an action run only from what it runs on needs a blueprint' })
  if (spec.schedule) {
    if (spec.tool) issues.push({ path: ['schedule'], message: 'schedule: a tool is called by an agent when it needs it; it has no schedule' })
    if (spec.backend.type === 'caller') issues.push({ path: ['schedule'], message: 'schedule: a caller backend waits for a person to start it, so it cannot run on a schedule' })
    if (spec.form === false) issues.push({ path: ['schedule'], message: 'schedule: a schedule is set up from the form, and this action has none' })
    try {
      if (parseDuration(spec.schedule.min) < SCHEDULE_MIN_MS) issues.push({ path: ['schedule', 'min'], message: `schedule: the shortest gap is at least ${SCHEDULE_MIN_MS / 60_000} minutes` })
    } catch (error) {
      issues.push({ path: ['schedule', 'min'], message: `schedule: ${error instanceof Error ? error.message : String(error)}` })
    }
  }
  if (spec.serial) {
    if (spec.backend.type !== 'runner' && spec.backend.type !== 'caller' && spec.backend.type !== 'job') issues.push({ path: ['serial'], message: 'serial: only a runner, a job, or a caller backend runs one at a time, because the hub sees when they start' })
    for (const [i, name] of spec.serial.entries()) if (!spec.inputs[name]) issues.push({ path: ['serial', i], message: `serial: "${name}" is not an input` })
  }
  if (spec.concurrency !== undefined) {
    if (!(REPORTING as readonly string[]).includes(spec.backend.type)) issues.push({ path: ['concurrency'], message: `concurrency: a ${spec.backend.type} run is the hub's own and ends as it starts, so it never waits its turn; only a runner, a job, a webhook, a caller, or a workflow does` })
    else if (spec.backend.type === 'webhook' && spec.backend.finish === 'reveal') issues.push({ path: ['concurrency'], message: 'concurrency: a revealed answer is given only on the request that asks for the run, so the run cannot wait its turn' })
  }
  if (spec.backend.type === 'report') issues.push(...reportIssues(spec.backend.verb, spec))
  if (spec.refreshes) issues.push(...refreshIssues(spec, targets, byId))
  if (spec.ceiling !== undefined) {
    // A run's ceiling is for a run something outside the hub carries out and may go on reporting on.
    if (spec.backend.type === 'runner') issues.push({ path: ['ceiling'], message: 'ceiling: a runner ends its job at the backend\'s own timeout, so the action names no ceiling' })
    else if (!(REPORTING as readonly string[]).includes(spec.backend.type)) issues.push({ path: ['ceiling'], message: `ceiling: a ${spec.backend.type} run is the hub's own and ends as it starts; only a job, a webhook, a caller, or a workflow takes a ceiling` })
    try {
      if (!parseDuration(spec.ceiling)) issues.push({ path: ['ceiling'], message: 'ceiling: a ceiling of 0 would let nothing run: name how long, such as 12h' })
    } catch (error) {
      issues.push({ path: ['ceiling'], message: error instanceof Error ? error.message : String(error) })
    }
  }
  if (spec.backend.type === 'job') {
    for (const name of Object.keys(spec.backend.env ?? {})) if (name.startsWith(JOB_ENV_PREFIX)) issues.push({ path: ['backend', 'env', name], message: `backend: a name that starts with ${JOB_ENV_PREFIX} is what the hub and the starter hand the job, so the action sets none` })
    issues.push(...templateIssues(spec, spec.backend.template, targets, byId))
  }
  if ((spec.backend.type === 'runner' || spec.backend.type === 'caller' || spec.backend.type === 'webhook') && spec.backend.timeout) {
    try {
      if (!parseDuration(spec.backend.timeout)) issues.push({ path: ['backend', 'timeout'], message: 'backend: a timeout of 0 would wait for nothing: name how long, such as 15m' })
    } catch (error) {
      issues.push({ path: ['backend', 'timeout'], message: error instanceof Error ? error.message : String(error) })
    }
  }
  return issues.length ? { spec: null, issues } : { spec, issues: [] }
}

/**
 * The fields of its entity a job's `template` reads, each once: none for a
 * fixed name. A template names what the job runs as, so these are held as
 * what access is decided from.
 */
export function templateReads(template: string): string[] {
  return [...new Set(pathsOf(template).flatMap((path) => TEMPLATE_READ.exec(path)?.[1] ?? []))]
}

/**
 * Why a field cannot name a job template, or null when it can. It is one
 * stored string or enum value that only a source writes: locked
 * (`overridable: false`), and never worked out from values someone else
 * may change.
 */
export function templateFieldIssue(def: FieldDef | undefined): string | null {
  if (!def) return 'is not a field of it'
  if (isDerived(def)) return `is worked out by the hub (${derivedKind(def)}), from values a template does not name: read a field a source writes`
  if ((def.type !== 'string' && def.type !== 'enum') || def.many) return `holds ${def.many ? 'a list' : `a ${def.type}`}: a template is named from one string or enum value`
  if (def.overridable !== false) return 'is not locked, so a person could change what the job runs as: set overridable: false on it, and only sources write it'
  return null
}

/**
 * The job template a run starts from: the action's own name, or the one its
 * `template` renders to over the entity the run is on. `fields` is the hub's
 * own read of that entity, never a caller's view of it. Refused when a field
 * it reads is no longer one a template may read, holds nothing, or holds
 * what no template is named by. A refusal never says the value.
 */
export function jobTemplate(template: string, on: { blueprint: Pick<Blueprint, 'id' | 'fields'>; fields: Record<string, unknown> } | null): { name: string } | { refused: string } {
  const reads = templateReads(template)
  if (!reads.length) return { name: template }
  if (!on) return { refused: 'its template reads the entity the run is on, and the run is on none' }
  const held: Record<string, string> = {}
  for (const name of reads) {
    const issue = templateFieldIssue(on.blueprint.fields[name])
    if (issue) return { refused: `its template reads ${on.blueprint.id}.${name}, which ${issue}` }
    const value = on.fields[name]
    if (typeof value !== 'string' || !TEMPLATE_PART.test(value)) return { refused: `its template reads "${name}", which on this entity holds nothing a job template is named by: lowercase letters, digits, - and _` }
    held[name] = value
  }
  const name = String(render(template, { entity: { fields: held } }))
  return TEMPLATE.test(name) ? { name } : { refused: 'its template renders to no name of a job template: lowercase letters, digits, - and _, starting with a letter or a digit' }
}

/**
 * What a job's `template` asks of its action. A fixed name is only a name.
 * One that is rendered names what the job runs as from the entity the run is
 * on, so it reads nothing a caller chooses: only fields of that entity, each
 * one `templateFieldIssue` passes on every blueprint the action runs on, and
 * none the run itself writes back.
 */
function templateIssues(spec: ActionSpec, template: string, targets: string[], byId: Map<string, Pick<Blueprint, 'id' | 'fields' | 'relations'>> | undefined): SpecIssue[] {
  const at = ['backend', 'template']
  if (!hasTemplate(template)) return TEMPLATE.test(template) ? [] : [{ path: at, message: TEMPLATE_NAMED }]
  const issues: SpecIssue[] = []
  for (const path of pathsOf(template)) {
    if (TEMPLATE_READ.test(path)) continue
    const whose = path === 'inputs' || path.startsWith('inputs.') ? ', which whoever asks chooses' : path === 'by' || path.startsWith('by.') ? ', which is whoever asks' : ''
    issues.push({ path: at, message: `backend: a template names what the job runs as, so it reads only a field of the entity the run is on, as {{ entity.fields.<name> }}: never "${path}"${whose}` })
  }
  if (issues.length) return issues
  const reads = templateReads(template)
  if (!TEMPLATE.test(String(render(template, { entity: { fields: Object.fromEntries(reads.map((name) => [name, 'a'])) } })))) issues.push({ path: at, message: `backend: ${TEMPLATE_NAMED}` })
  if (!targets.length) issues.push({ path: at, message: 'backend: a template that reads the entity needs one to read, so the action needs a blueprint' })
  for (const name of reads) {
    for (const b of byId ? targets : []) {
      const bp = byId!.get(b)
      if (!bp) continue
      const def = bp.fields[name]
      const issue = templateFieldIssue(def)
      if (issue) issues.push({ path: at, message: `backend: the template reads ${b}.${name}, which ${issue}` })
      else for (const value of def!.type === 'enum' ? (def!.values ?? []) : []) if (!TEMPLATE_PART.test(value)) issues.push({ path: at, message: `backend: the template reads ${b}.${name}, whose value "${value}" no job template is named by: lowercase letters, digits, - and _` })
    }
    const i = spec.refreshes?.indexOf(name) ?? -1
    if (i >= 0) issues.push({ path: ['refreshes', i], message: `refreshes: the job's template reads "${name}", so it says what the job runs as, and no run writes it` })
  }
  return issues
}

/** The backends that report how a run went through the hub's report, where a `::refresh::` line is read. */
const REPORTING = ['runner', 'job', 'webhook', 'caller', 'github_workflow'] as const

/**
 * What `refreshes` asks of its action: a backend that reports back, and fields
 * every blueprint it runs on has, each one a value is stored for, never one
 * the hub works out.
 */
function refreshIssues(spec: ActionSpec, targets: string[], byId: Map<string, Pick<Blueprint, 'id' | 'fields' | 'relations'>> | undefined): SpecIssue[] {
  const issues: SpecIssue[] = []
  const backend = spec.backend
  if (!(REPORTING as readonly string[]).includes(backend.type)) issues.push({ path: ['refreshes'], message: `refreshes: a ${backend.type} backend reports nothing back, so nothing hands values back to write; only a runner, a job, a webhook, a caller, or a workflow does` })
  else if (backend.type === 'webhook' && backend.finish) issues.push({ path: ['refreshes'], message: `refreshes: a webhook that ends on its answer (finish: ${backend.finish}) reports nothing after, so nothing hands values back to write` })
  if (!targets.length) issues.push({ path: ['refreshes'], message: 'refreshes: a run writes back on the entity it ran on, so the action needs a blueprint' })
  for (const [i, name] of spec.refreshes!.entries()) {
    for (const b of byId ? targets : []) {
      const def = byId!.get(b)?.fields[name]
      if (!byId!.has(b)) continue
      if (!def) issues.push({ path: ['refreshes', i], message: `refreshes: ${b} has no field "${name}"` })
      else if (isDerived(def)) issues.push({ path: ['refreshes', i], message: `refreshes: ${b}.${name} is worked out by the hub (${derivedKind(def)}), so nothing writes it` })
    }
  }
  return issues
}

/** What kind of field the hub works out, in a word. */
function derivedKind(def: FieldDef): string {
  if (def.calculation) return 'a calculation'
  if (def.mirror) return 'a mirror'
  if (def.aggregation) return 'an aggregation'
  return 'derived'
}

/** What a `report` backend asks of its action: what it runs on, and its inputs by their fixed names and kinds. */
function reportIssues(verb: ReportVerb, spec: ActionSpec): SpecIssue[] {
  const issues: SpecIssue[] = []
  const on = actionTargets(spec)
  if (verb === 'create' && on.length) issues.push({ path: ['blueprint'], message: 'backend: a report is created from nothing, so the action runs on no blueprint' })
  if (verb !== 'create' && (on.length !== 1 || on[0] !== REPORT_BLUEPRINT)) issues.push({ path: ['blueprint'], message: `backend: a report ${verb} runs on a report, so the action's blueprint is ${REPORT_BLUEPRINT}` })
  for (const want of REPORT_INPUTS[verb]) {
    const def = spec.inputs[want.name]
    if (!def) {
      if (want.required) issues.push({ path: ['inputs'], message: `backend: a report ${verb} reads the input "${want.name}" (${want.kinds.join(' or ')})` })
    } else if (!want.kinds.includes(def.type)) issues.push({ path: ['inputs', want.name, 'type'], message: `backend: a report ${verb} reads "${want.name}" as ${want.kinds.join(' or ')}, not ${def.type}` })
    else if (want.name === 'recipients' && !def.many) issues.push({ path: ['inputs', want.name, 'many'], message: 'backend: recipients is a list of addresses, so the input takes many' })
  }
  if (verb === 'edit' && !spec.inputs.layout && !spec.inputs.version) issues.push({ path: ['inputs'], message: 'backend: a report edit reads the input "layout" (markdown), or "version" (number) to put an older one back' })
  if (spec.schedule && verb !== 'publish') issues.push({ path: ['schedule'], message: `schedule: only a report publish runs on a schedule, not a ${verb}` })
  if (spec.serial) issues.push({ path: ['serial'], message: 'serial: a report run is the hub\'s own; the hub numbers editions one at a time already' })
  return issues
}

/** The first test of a `when` whose op the filter language does not have, or null. */
function badOp(f: Filter): { field: string; op: string } | null {
  if ('and' in f) return f.and.map(badOp).find((bad) => bad) ?? null
  if ('or' in f) return f.or.map(badOp).find((bad) => bad) ?? null
  if ('not' in f) return badOp(f.not)
  if ('field' in f && !(FILTER_OPS as readonly string[]).includes(f.op)) return { field: f.field, op: String(f.op) }
  return null
}

/**
 * Why each input a batch cannot ask once for many cannot, by name: one that
 * reads the entity a run is on, or an input that narrows it, which is each
 * entity's own. An input that narrows the target is not one of them: a batch
 * fills it from each entity, as a run alone does.
 */
export function unbatchable(inputs: Record<string, ActionInputDef>): Map<string, string> {
  const narrowing = Object.keys(inputs).filter((n) => inputs[n]!.narrows)
  const out = new Map<string, string>()
  for (const [name, { when, value, ...def }] of Object.entries(inputs)) {
    if (def.narrows) continue
    if (editsList(def)) {
      out.set(name, 'changes a list each entity holds for itself')
      continue
    }
    const said = JSON.stringify(def)
    if (/\{\{[^}]*\bentity\b/.test(said)) {
      out.set(name, 'reads the entity it runs on')
      continue
    }
    const reads = new Set(narrowing.filter((n) => new RegExp(`\\{\\{[^}]*\\binputs\\.${n}\\b`).test(said)))
    if (when) for (const f of whenReads(when).fields) reads.add(f)
    if (typeof value === 'string') {
      try {
        for (const f of compile(value).reads) reads.add(f)
      } catch {
        // A value that does not parse is refused where the definition is checked.
      }
    }
    const each = narrowing.find((n) => reads.has(n))
    if (each) out.set(name, `reads "${each}", which each entity fills for itself`)
  }
  return out
}

/** The value an input that narrows the target takes from an entity: the id it points at, for an input that picks an entity, or the field's value. */
export function narrowValue(e: Entity, def: ActionInputDef): unknown {
  if (INPUT_KINDS[def.type].picks !== 'entity') return fieldOf(e, def.narrows!) ?? null
  const to = e.relations[def.narrows!]?.[0]
  return to ? entityId(to) : null
}

/** Whether an entity holds the value an input that narrows the target was given. */
export function narrowedBy(e: Entity, def: ActionInputDef, value: unknown): boolean {
  return stable(narrowValue(e, def)) === stable(value)
}
