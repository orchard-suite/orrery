// The MCP server: the same read surface as the REST API, shaped for agents.
// Stateless: each request gets a fresh server and transport, answers in plain
// JSON once its result is ready, and offers no standalone stream.

import { QUERY_SOURCES_MAX, QueryError, type Queries } from './queries.ts'
import type { Datasets } from './datasets.ts'
import { StreamableHTTPTransport } from '@hono/mcp'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Context } from 'hono'
import { z } from 'zod'
import { QUERY_GROUPS_MAX, QUERY_TOTALS, type Budgets as BudgetSet, type LoadResponse, type ReportEditionRead, type SummaryResponse } from '../shared/api.ts'
import { INPUT_KINDS, INPUT_RULES } from '../shared/input-kinds.ts'
import { runChanges } from '../shared/list-change.ts'
import { ENTITY_STATES, datasetOf, FILTER_OPS, actionTargets, blueprintNamer, can, entityId, inputPicks, isFinished, parseEntityId, REPORT_BLUEPRINT, type Action, type Entity, type EntityState, type Filter, type Identity, type Permission } from '../shared/model.ts'
import { listActivity, record } from './activity.ts'
import { MODEL_CHANGES, MODEL_KINDS, modelRefusal, type ModelEdits, type ModelKind } from './model-edit.ts'
import { namedBudgets } from './budgets.ts'
import { LOAD_MAX_HOURS } from './load.ts'
import { modellingGuide } from './guide.ts'
import type { AppEnv } from './auth.ts'
import type { Blueprints } from './blueprints.ts'
import type { Db } from './db.ts'
import type { Findings } from './findings.ts'
import type { Grounds } from './ground.ts'
import type { Maps } from './map.ts'
import type { Previews } from './previews.ts'
import type { Reader } from './read.ts'
import { CursorError, type OrderValues } from './query.ts'
import { decodeCursor, encodeCursor, type CursorQuestion } from './cursor.ts'
import type { Sources } from './sources.ts'
import type { Scorecards } from './scorecards.ts'
import { partFilters, partFor, partsOf, topOf } from '../shared/scorecard.ts'
import { ActionError, TOOL_WAIT_MS, madeAsPerson, type Actions } from './actions.ts'
import { ChangeSetRefused, type ChangeSets } from './change-sets.ts'
import { seenPartly, type View, type Visibility } from './visibility.ts'
import { sendUsage } from './telemetry.ts'
import { AGENT_TOOL_CALLED } from '../shared/usage.ts'
import { outputText } from '../shared/run-marks.ts'
import { askerTimes, askerValue, FilterError, forAsker, namesAsker, readFilter, typedFilter, type Asker } from '../shared/filter.ts'
import { dayOf } from '../shared/day.ts'
import type { Preferences } from './preferences.ts'
import { ReportError, type Reports } from './reports.ts'
import { headlineOf } from '../shared/report.ts'
import { recordAgentAnswer, recordAgentCall, recordRefusal } from './metrics.ts'
import { CARD_VALUE_CHARS, PAGE, PAGE_MAX, SHOWN_LINKS, WALK_NODES, SHOWN_VALUE_CHARS, bounded, card, firstSentence, incomingGroups, outgoingGroups, wordsFilter } from './cards.ts'

/** The most datasets one answer lists. */
const DATASETS_SHOWN = 50

interface McpDeps {
  datasets: Datasets
  blueprints: Blueprints
  reader: Reader
  findings: Findings
  sources: Sources
  db: Db
  scorecards: Scorecards
  actions: Actions
  changeSets: ChangeSets
  visibility: Visibility
  version: string
  summary: (view: View) => Promise<SummaryResponse>
  /** What cost the hub over the last hours, as the Load page reads it. */
  load: (hours: number) => Promise<LoadResponse>
  /** The budgets the hub holds, and the one way they are set. */
  budgets: { get: () => BudgetSet; set: (given: unknown) => Promise<BudgetSet> }
  grounds: Grounds
  maps: Maps
  previews: Previews
  queries: Queries
  reports: Reports
  preferences: Preferences
  /** Every change to the model: the same checks and side effects as the model page's own saves. */
  model: ModelEdits
}

const FILTER_DOC = `Filter object. Leaves: {field, op, value} with op in eq|neq|gt|gte|lt|lte|in|contains|prefix|exists|within|older, where within and older take a duration back from now such as "30d" against a datetime field; {relation, target} for an outgoing relation to an entity id or key, {relation} alone for any target, and "<-relation" or "<-blueprint:relation" for entities pointing at this one; {relation, where: <filter>} for an entity whose relation reaches one that meets where, a filter read on the entities it reaches with their own fields, and {relation, where, every: true} for one that reaches at least one and every one meets it (none of them: {not: {relation, where}}); {relatedTo: "blueprint:key"} for either direction; {scorecard, op, value} for the level reached on a scorecard, compared in its level order with op in eq|neq|gt|gte|lt|lte|in|exists and "none" below the first level (an entity outside the scorecard's scope matches none of these; exists asks whether it is in scope); {state: active|missing}; {search: "text"} for text found in the key, the title, or inside any field value the reader may see. Combine with {and: [...]}, {or: [...]}, {not: {...}}. Field names refer to entity fields; key, title, icon, blueprint, state, owner, status, createdAt, updatedAt, lastSeenAt also work, and with a $ prefix they always mean the entity itself rather than a field of that name. The hub knows who asks, so never look that up or ask for it: as a field's value "@me" is the person you answer for, as fields of type user hold them (requested_by, decided_by), and as a relation's target or relatedTo it is their own entity; "@today", "@yesterday", "@tomorrow", and "@now" as a datetime field's value are the moment that day began on their own clock, so today is {field, op: gte, value: "@today"} and yesterday is gte "@yesterday" with lt "@today". Write every value as text, true, false, and numbers too ("true", "3"): the hub reads it as the field's type.`

/** Every tool an agent can call, as the label its calls are counted under. A tool registered in `build` is named here too. */
/** Every kind of input an action takes, for an agent: read from the registry, so a new kind is described without a word here. */
const INPUT_KINDS_TEXT = Object.entries(INPUT_KINDS)
  .map(([name, kind]) => `${name} (${kind.description})`)
  .join('; ')

/**
 * What every agent is told as it connects: how to climb from broad to exact
 * without reading more than a question needs. Each tool's description says
 * its own part; this is the order.
 */
export const AGENT_INSTRUCTIONS = `Orrery answers in small pieces. Climb from broad to exact, and stop as soon as you can answer.
The hub already knows who you answer for, from their sign-in. When they say I, me, my, or mine, or today or yesterday, write "@me", "@today", or "@yesterday" as the value in a filter: the hub fills them in. A day is from its name to the next: yesterday is gte "@yesterday" and lt "@today", in a filter or in run_query's view. Never ask the person who they are. Every time in the catalog is UTC: before you say one, call who_am_i once for their time zone, and say it in that zone.
A person names things in their own words, never a blueprint, a field, or a filter. Work every tool argument out yourself from what Orrery answers; never ask the person for one. Ask the person only which thing they mean, when Orrery finds several.
1. Orient: estate_summary counts what exists and what is not green. describe_model with no blueprint lists the kinds of thing; with one, its fields and relations.
2. Find: search_entities with q, the person's own words for the thing. With no blueprint it searches every kind and says, as kinds, how many of each matched; then narrow with a blueprint, a filter, a sort, and the fields you need. Each hit is a card: its first small values, the names of the rest, and each relation as a count with its first links.
3. Read one: get_entity gives one thing's values and, for each way it is linked, how many and the first few.
4. Go deeper: an answer that leaves things out says so with more, the exact tool and arguments that read the rest. Call it, narrowed with fields, sort, and limit.
An answer of none is not yet an answer: when a search or a query matches nothing, it says which condition matched nothing alone and what that field holds. Mend the question and ask again before you tell the person there is none. Words a person uses for a thing, such as infrastructure, are usually in its title: search them with q or a search condition, not as a guessed field value.
5. Count, find the newest, the oldest, or the most, and group with run_query: it answers in one small table. Never page through everything to work an answer out yourself.
Health: get_status and list_findings count first; name a blueprint or a kind to list them.
Reports: a report is a kind of thing like any other (Report, with its editions as Report edition). get_report reads one: its newest edition, one by number, or two side by side. A report is made, changed, previewed, and published by running its actions (list_actions on the report); check_report_layout reads a layout and names every problem before you run an edit. A block shows a saved query as the query shapes it, so change a number or a chart by changing its query.
Datasets: list_datasets names the tables published from outside the catalog. Read one with run_query, as the source "$data:<id>", like a blueprint: its columns are its fields.
Change the model only when the person asks: read the part with get_model_definition, then change it on the hub with edit_model, delete_from_model, or rename_blueprint. A model change goes to the hub, never into a file.`

/**
 * What a call that names no thing is answered with. No read tool requires an
 * input: an agent host asks the person for a required input it cannot fill,
 * and a person knows no id or blueprint. The answer says how to find one.
 */
/** How many editions get_report lists, and how many rows of each table it shows. */
const REPORT_EDITIONS_SHOWN = 12
const REPORT_TABLE_ROWS = 20

/** Two editions side by side, for an agent: their headline numbers, and how many rows each data set held. */
function compared(a: ReportEditionRead, b: ReportEditionRead): { editions: [number, number]; headline: { name: string; values: [number | null, number | null] }[]; data: { name: string; rows: [number | null, number | null] }[] } {
  const ha = headlineOf(a.content.blocks)
  const hb = headlineOf(b.content.blocks)
  const names = [...new Set([...Object.keys(ha), ...Object.keys(hb)])]
  const sets = [...new Set([...Object.keys(a.data), ...Object.keys(b.data)])]
  return { editions: [a.content.number, b.content.number], headline: names.map((name) => ({ name, values: [ha[name] ?? null, hb[name] ?? null] })), data: sets.map((name) => ({ name, rows: [a.data[name]?.total ?? null, b.data[name]?.total ?? null] })) }
}

/** How many refused items a refused change set names to an agent; the rest are counted. */
const SET_REFUSALS_SHOWN = 30

const FIND_FIRST = 'Never ask the person for this. Find the thing first: call search_entities with q, the distinctive words of what the person named, and no blueprint. Its answer lists matching things by id (blueprint:key) and, as kinds, how many of each blueprint matched.'

/** How many conditions of a question that matched nothing are each tried alone, and how many of a field's values are said. */
const WHY_CONDITIONS = 8
const WHY_VALUES = 12

/**
 * What a run not yet ended asks of the agent that asked for it: nothing, for every backend that holds the work
 * itself, so the agent may stop; for a caller backend, that whoever asked does the work.
 */
function goesOn(action: Pick<Action, 'backend'>, awaiting: boolean): string {
  if (action.backend.type === 'caller') return `${awaiting ? 'Once approved, it' : 'It'} waits for whoever asked to start it, do the work, and report: nothing else will, and one nobody starts is given up. Read it with get_action_run.`
  return `You do not need to wait or stay connected: ${awaiting ? 'once approved it starts by itself' : 'it goes on by itself'}${action.backend.type === 'job' ? ', as a job of its own' : ''}. Read its state, steps, log, outputs, and link at any time with get_action_run.`
}

export const AGENT_TOOLS = ['who_am_i', 'modelling_guide', 'describe_model', 'estate_summary', 'search_entities', 'run_query', 'get_entity', 'traverse', 'get_status', 'get_changes', 'get_scorecard', 'list_findings', 'list_actions', 'run_action', 'propose_changes', 'get_action_run', 'list_tools', 'call_tool', 'get_load', 'get_budgets', 'set_budgets', 'get_ground', 'get_map', 'get_model_definition', 'edit_model', 'delete_from_model', 'rename_blueprint', 'get_report', 'check_report_layout', 'list_datasets'] as const

export function createMcpHandler(deps: McpDeps): (c: Context<AppEnv>) => Promise<Response> {
  return async (c) => {
    // Nothing is ever pushed to a client between requests, so there is no stream to open.
    if (c.req.method === 'GET') return c.body(null, 405, { allow: 'POST' })
    // An agent with a person's token reads what that person reads, and nothing more.
    const server = build(deps, c.get('identity'), await deps.visibility.view(c.get('identity')))
    const transport = new StreamableHTTPTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    const called = await toolsCalled(c.req.raw)
    await server.connect(transport)
    try {
      const answer = (await transport.handleRequest(c)) ?? c.json({ error: 'No response' }, 500)
      const named = (tool: string) => ((AGENT_TOOLS as readonly string[]).includes(tool) ? tool : 'unknown')
      for (const { tool, args } of called) {
        recordAgentCall(named(tool))
        // What the agent sent, as it arrived: a host's own record of a call is not always what reached the hub.
        sendUsage(AGENT_TOOL_CALLED, c.get('identity'), { tool, args: String(bounded(args, AGENT_ARGS_CHARS)) })
      }
      // An answer to one call is that tool's: a batch's answer belongs to no one tool, and is not measured.
      if (called.length === 1) recordAgentAnswer(named(called[0]!.tool), (await answer.clone().arrayBuffer()).byteLength)
      return answer
    } finally {
      // The answer is complete once handleRequest returns: nothing streams after it.
      await server.close()
    }
  }
}

/** How much of a call's arguments, as JSON, the usage event that counts it keeps. */
const AGENT_ARGS_CHARS = 2000

/** The tools a JSON-RPC message, or a batch of them, calls, each with its arguments as JSON. Read from a copy, so the transport still reads the request whole. */
async function toolsCalled(req: Request): Promise<{ tool: string; args: string }[]> {
  if (req.method !== 'POST') return []
  try {
    const body: unknown = await req.clone().json()
    return (Array.isArray(body) ? body : [body]).flatMap((m: unknown) => {
      if (!m || typeof m !== 'object' || !('method' in m) || m.method !== 'tools/call' || !('params' in m)) return []
      const params = m.params
      return params && typeof params === 'object' && 'name' in params && typeof params.name === 'string' ? [{ tool: params.name, args: JSON.stringify('arguments' in params ? params.arguments : null) ?? 'null' }] : []
    })
  } catch {
    // A body that is not JSON calls no tool; the transport answers it.
    return []
  }
}

function build(deps: McpDeps, identity: Identity, view: View): McpServer {
  const { blueprints, reader, findings, sources, db, scorecards, actions } = deps
  const server = new McpServer({ name: 'orrery', version: deps.version }, { instructions: AGENT_INSTRUCTIONS })
  // Every answer goes into the agent's model: no spacing, and nothing empty.
  const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] })
  /** A ground or a map without what it was read from: that tells a browser when to read it again, and an agent nothing. */
  const unread = <T extends { reads: string[] }>(answer: T | null): Omit<T, 'reads'> | null => {
    if (!answer) return null
    const { reads: _, ...rest } = answer
    return rest
  }
  /** The answer for a caller without the permission a tool needs, or null when it holds it. The refusal is recorded, as the API records one. */
  const refused = async (permission: Permission, tool: string) => {
    if (can(identity, permission)) return null
    await record(db, 'access.refused', null, null, null, { permission, method: 'POST', path: '/mcp', tool }, new Date(), 'refused')
    return text({ error: `This needs the "${permission}" permission` })
  }
  /** Who asks, worked out once a call and only for a filter that names them: their address, their own entity, and their days. */
  let asker: Promise<Asker> | null = null
  const whoAsks = (): Promise<Asker> =>
    (asker ??= (async () => {
      const ref = identity.kind === 'user' ? await deps.visibility.personOf(identity.name) : null
      const zone = (identity.kind === 'user' ? (await deps.preferences.of(identity.name)).timeZone : null) ?? 'UTC'
      return { address: identity.name, person: ref && view.seesEntity(ref) ? entityId(ref) : null, times: askerTimes(new Date(), zone) }
    })())
  /** A filter as a caller sent it, checked, each value read as its field's type on `blueprint`, with the asker filled in where it names them. */
  const filterOf = async (given: unknown, blueprint?: string): Promise<Filter | undefined> => {
    const read = readFilter(given)
    const fields = blueprint ? (datasetOf(blueprint) === null ? blueprints.get(blueprint) : deps.queries.kind(blueprint))?.fields : undefined
    const filter = read && fields ? typedFilter(read, (name) => fields[name]?.type) : read
    return filter && namesAsker(filter) ? forAsker(filter, await whoAsks()) : filter
  }

  /**
   * Why a question matched nothing, so an agent mends its own question
   * rather than telling a person there is none: each condition with how many
   * things it matches alone, and, for one on a field that matches none, the
   * values that field holds. A condition is often a guess at a value.
   */
  const whyNone = async (blueprint: string | undefined, filter: Filter | undefined, states: EntityState[] | undefined): Promise<{ none: string; conditions: { condition: Filter; alone: number; holds?: { value: string; count: number }[] }[] } | null> => {
    if (!filter) return null
    const parts = ('and' in filter ? filter.and : [filter]).slice(0, WHY_CONDITIONS)
    const conditions = await Promise.all(
      parts.map(async (condition) => {
        const alone = await reader.count({ blueprint, filter: condition, states, view })
        const holds = !alone && blueprint && 'field' in condition && condition.op !== 'exists' ? await reader.valuesOf(blueprint, condition.field, view, WHY_VALUES) : null
        return { condition, alone, ...(holds ? { holds: holds.map((h) => ({ value: String(bounded(h.value, CARD_VALUE_CHARS)), count: h.count })) } : {}) }
      }),
    )
    const dead = conditions.filter((c) => !c.alone).length
    return { none: dead ? `Nothing matched: ${dead} of the conditions match nothing alone. Each such condition on a field says what the field holds: change the value, or drop the condition and search the words with q instead.` : 'Each condition matches something alone, but nothing meets them all: loosen one.', conditions }
  }

  /** A thing as a list shows it, each relation's target read from its blueprint so a cut relation can say how to read the rest. */
  const cardOf = (e: Entity, fields?: string[]) => card(e, fields, (name) => blueprints.get(e.blueprint)?.relations[name]?.target)

  server.registerTool(
    'who_am_i',
    {
      description: "Who the person you answer for is, and the time. Not needed to filter: a filter says \"@me\" and \"@today\" and the hub fills them in. Call it only to tell the person who they are in the catalog or what the time is. address is how fields of type user name them (requested_by, decided_by, and the like): filter such a field with eq and this address. person is their own entity, when the catalog holds one: relations to a person point at it. now is the time in UTC, as every datetime in the catalog is. today is the date on the person's own clock, in timeZone, and todayStartedAt the moment that day began: for today, filter a datetime field with gte and todayStartedAt. Say times to the person in timeZone.",
      inputSchema: {},
    },
    async () => {
      const ref = identity.kind === 'user' ? await deps.visibility.personOf(identity.name) : null
      // A person's day is on their own clock: the zone a browser of theirs last said, and the hub's own until one has.
      const timeZone = (identity.kind === 'user' ? (await deps.preferences.of(identity.name)).timeZone : null) ?? 'UTC'
      const now = new Date()
      const day = dayOf(now, timeZone)
      return text({ address: identity.name, kind: identity.kind, ...(ref && view.seesEntity(ref) ? { person: entityId(ref) } : {}), now: now.toISOString(), timeZone, today: day.date, todayStartedAt: day.startedAt.toISOString() })
    },
  )

  server.registerTool(
    'modelling_guide',
    {
      description: 'The conventions this catalog follows, as markdown: which blueprints belong (inventory, records, history with a retention), the shared names, and the field contracts for pipelines, releases, deployments, images, vulnerabilities, subscriptions, and invoices. Read it before adding or changing a blueprint.',
      inputSchema: {},
    },
    async () => ({ content: [{ type: 'text' as const, text: await modellingGuide() }] }),
  )

  server.registerTool(
    'describe_model',
    {
      description: 'The estate model. With no blueprint: every kind of thing, as its id, title, group, and the first sentence of its description; read this to learn what kinds exist. With a blueprint: that kind in full, its description, fields (types and descriptions), and relations; read it before you filter or pick fields of that kind. A number field with format {kind: currency, currency, minor: true} stores money as a whole count of the currency\'s smallest unit (cents for USD): divide by 100 before saying an amount, and filter in the stored unit.',
      inputSchema: { blueprint: z.string().optional().describe('One blueprint id, or omit for the list of every kind') },
    },
    async ({ blueprint }) => {
      // Titles may repeat across sections; a repeated one says what it is shown as, beside its section.
      const named = blueprintNamer(blueprints.list().filter((bp) => view.seesSome(bp.id)))
      if (!blueprint) return text(blueprints.list().filter((bp) => view.seesSome(bp.id)).map((bp) => ({ id: bp.id, title: named(bp), group: bp.group, ...(bp.description ? { description: firstSentence(bp.description) } : {}) })))
      const list = [blueprints.get(blueprint)].filter(Boolean).filter((bp) => view.seesSome(bp!.id))
      if (!list.length) return text({ error: `no blueprint ${blueprint}` })
      return text(
        list.map((bp) => ({
          id: bp!.id,
          title: bp!.title,
          ...(named(bp!) !== bp!.title ? { shownAs: named(bp!), group: bp!.group } : {}),
          description: bp!.description,
          ...seenPartly(view, bp!),
          fields: Object.fromEntries(Object.entries(bp!.fields).filter(([k]) => !view.hiddenFields(bp!.id).has(k) || view.ownerOpened(bp!.id).has(k)).map(([k, f]) => [k, { type: f.type, title: f.title, description: f.description, values: f.values, mirror: f.mirror, aggregation: f.aggregation, calculation: f.calculation, format: f.format }])),
          relations: Object.fromEntries(Object.entries(bp!.relations).filter(([, r]) => view.seesSome(r.target)).map(([k, r]) => [k, { target: r.target, many: !!r.many, required: !!r.required, title: r.title, description: r.description }])),
        })),
      )
    },
  )

  server.registerTool(
    'estate_summary',
    { description: `The big picture, in counts: each blueprint with how many it holds and how many are red, amber, or grey (only those that hold something), the first ${PAGE} things that are not green, red first, stale sources, finding counts by kind, and when anything last changed. get_status lists what is not green of one blueprint.`, inputSchema: {} },
    async () => {
      const s = await deps.summary(view)
      const notGreen = s.blueprints.reduce((n, b) => n + b.notGreen.red + b.notGreen.amber + b.notGreen.grey, 0)
      return text({
        generatedAt: s.generatedAt,
        blueprints: s.blueprints.filter((b) => b.active || b.missing).map((b) => ({ id: b.id, title: b.title, active: b.active, ...(b.missing ? { missing: b.missing } : {}), ...(b.notGreen.red || b.notGreen.amber || b.notGreen.grey ? { notGreen: b.notGreen } : {}) })),
        notGreen: { count: notGreen, first: s.notGreen.slice(0, PAGE).map((c) => ({ id: entityId(c.entity), title: c.title, level: c.level, reasons: c.reasons })), ...(notGreen > PAGE ? { more: { tool: 'get_status', args: {} } } : {}) },
        staleSources: s.staleSources,
        findings: s.findings,
        alertsFiring: s.alertsFiring,
        lastChangeAt: s.lastChangeAt,
      })
    },
  )

  server.registerTool(
    'search_entities',
    {
      description: `Find entities, a page at a time: total says how many match. Start with q, the person's own words for the thing, and no blueprint: every word must hold of a thing, in any order, either found in its key, title, or values or naming its kind (approvals, services), plural or not, so use the distinctive words and leave out filler; the answer then says, as kinds, how many things of each blueprint matched, so you know which blueprint to narrow to. For an exact question give a filter. starred keeps only the person's favorites, the things they starred in the catalog. ${FILTER_DOC} Each hit is a card: its values in the order the blueprint declares them, each small enough to read at a glance (a bigger one is said, as cut, and get_entity shows it), as many as fit, with moreFields naming the rest, and each relation as a count with its first few ids. Pick fields to read exactly what you need. sort orders the page by a field, or by updatedAt, createdAt, lastSeenAt, title, or key, with a leading - for newest or largest first. Page with after: pass the next a page answered with. To count, find the newest or the most, or group, ask run_query instead of paging.`,
      inputSchema: {
        q: z.string().optional().describe("Words to find, such as a thing's name in the person's own words. Every word must match; it narrows the filter when both are given"),
        blueprint: z.string().optional().describe('A blueprint id, from describe_model or from kinds in an earlier answer. Never ask the person for it; omit it to search every kind'),
        filter: z.record(z.string(), z.unknown()).optional().describe('Work it out from describe_model; never ask the person for it'),
        fields: z.array(z.string()).optional().describe('Field names to include; omit for every small value'),
        sort: z.string().optional().describe('A field or updatedAt, createdAt, lastSeenAt, title, key; a leading - sorts descending'),
        state: z.array(z.enum(ENTITY_STATES)).optional(),
        limit: z.number().int().min(1).max(PAGE_MAX).default(PAGE),
        offset: z.number().int().min(0).default(0),
        after: z.string().optional().describe('The next a page answered with: the page after it'),
        starred: z.boolean().default(false).describe('Only what the person starred: their favorites, for "my favorites" or "the things I starred"'),
      },
    },
    async ({ q, blueprint, filter: given, fields, sort, state: states, limit, offset, after, starred }) => {
      // A person's favorites are theirs alone: a machine starred nothing.
      if (starred && identity.kind !== 'user') return text({ total: 0, entities: [], why: 'only a person stars things; this caller is not one' })
      const stars = starred ? { starredBy: identity.name, starredOnly: true } : {}
      if (blueprint && !view.seesSome(blueprint)) return text({ error: `no blueprint ${blueprint}` })
      const words = wordsFilter(q ?? '', blueprints.list().filter((bp) => view.seesSome(bp.id)))
      // An empty list of states is a blank a caller filled in, not a wish for nothing.
      const state = states?.length ? states : undefined
      let filter: Filter | undefined
      try {
        const asked = readFilter(given)
        filter = await filterOf(words.length ? { and: [...words, ...(asked ? [asked] : [])] } : asked, blueprint)
      } catch (error) {
        if (error instanceof FilterError) return text({ error: error.message })
        throw error
      }
      const refused = filter ? view.refusedQuery(blueprint, filter) : null
      if (refused) {
        recordRefusal('hidden_field')
        return text({ error: `the filter reads "${refused}", which you cannot see` })
      }
      const asked: CursorQuestion = { blueprint, filter, states: state, sort, ...stars }
      let from: OrderValues | null = null
      try {
        from = after ? decodeCursor(asked, after) : null
      } catch (error) {
        if (error instanceof CursorError) return text({ error: error.message })
        throw error
      }
      const result = await reader.list({ blueprint, filter, states: state, sort, limit, offset: from ? 0 : offset, after: from, view, ...stars })
      // A search across every kind says where it found things, so the next call can name a blueprint. Favorites are
      // few, and say their kinds on each card: they are counted by kind only as a search of everything is.
      const kinds = !starred && !blueprint && filter && !from && !offset ? await reader.kinds({ filter, states: state, view }) : null
      const why = !result.total && !from && !offset ? (starred ? { why: 'the person starred nothing that matches; ask without starred to search everything' } : await whyNone(blueprint, filter, state)) : null
      return text({ total: result.total, ...(why ?? {}), ...(kinds ? { kinds } : {}), next: result.next ? encodeCursor(asked, result.next) : null, entities: result.entities.map((e) => cardOf(e, fields)) })
    },
  )

  server.registerTool(
    'run_query',
    {
      description: `Not a first call: it needs blueprint ids, which search_entities with q gives as kinds. Reads every entity one or more blueprints match, as one table with the columns asked for: what search_entities pages through, at once, across blueprints. Each source is {blueprint, filter?, states?}; filter is a ${FILTER_DOC} A column is a field, a relation as r:<name>, or one every entity has: $type, title, $key, $status, $state, $owner, $lastSeenAt, $updatedAt (always the entity itself, never a field of the same name); one id across blueprints is one column. A column may read through relations: r:<path> is the titles at the end of a relation path (one hop per dot, <-relation or <-blueprint:relation for a hop in, as in r:team.department), and r:<path>@<field> a field or one of the columns above of the entities there (r:team.department@cost_center); each such cell is a list. A column may instead be {id, title, from}, where from names, by blueprint, the field or column that fills it there, so one column can read different fields of different blueprints; a blueprint it does not name leaves it empty. Each column in the answer says what fills it in each blueprint (from). view shapes the answer once read, over its columns across every source: where is conditions {field: <column id>, op, value: <text>, not?} a row must all meet (a list cell meets a test when one of its values does; "@me", "@today", and the other day names fill in as in a filter; a condition on a column must name one of columns), sort is [{column, desc?}], group is up to ${QUERY_GROUPS_MAX} column ids, totals is {<column id>: ${QUERY_TOTALS.join('|')}}. Answers counts per blueprint (as read, before the view), the columns, kept (the rows the view keeps), the first kept rows up to limit, and, when grouped, the groups with their value, count, totals, and the groups inside them.`,
      inputSchema: {
        sources: z
          .array(z.object({ blueprint: z.string(), filter: z.record(z.string(), z.unknown()).optional(), states: z.array(z.enum(ENTITY_STATES)).optional() }))
          .max(QUERY_SOURCES_MAX)
          .default([])
          .describe('The blueprints to read, each with its filter. Work them out yourself: find the thing with search_entities, read its links with get_entity, and take blueprint ids and field names from describe_model. Never ask the person for them'),
        columns: z.array(z.union([z.string(), z.object({ id: z.string().min(1), title: z.string().min(1), from: z.record(z.string(), z.string()) })])).default(['$type', 'title', '$status']),
        limit: z.number().int().min(1).max(2000).default(200),
        view: z
          .object({
            where: z.array(z.object({ field: z.string().min(1), op: z.enum(FILTER_OPS), value: z.string().default(''), not: z.boolean().optional() })).max(50).optional(),
            sort: z.array(z.object({ column: z.string().min(1), desc: z.boolean().optional() })).max(10).optional(),
            group: z.array(z.string().min(1)).max(QUERY_GROUPS_MAX).optional(),
            totals: z.record(z.string(), z.enum(QUERY_TOTALS)).optional(),
          })
          .optional(),
      },
    },
    async ({ sources: given, columns, limit, view: shown }) => {
      if (!given.length) return text({ error: `sources is empty: give at least one {blueprint, filter?}. ${FIND_FIRST}` })
      let sources: { blueprint: string; filter?: Filter; states?: (typeof given)[number]['states'] }[]
      try {
        sources = await Promise.all(
          given.map(async (s) => {
            const filter = await filterOf(s.filter, s.blueprint)
            // An empty list of states is a blank a caller filled in, not a wish for nothing.
            return { blueprint: s.blueprint, ...(filter ? { filter } : {}), ...(s.states?.length ? { states: s.states } : {}) }
          }),
        )
      } catch (error) {
        if (error instanceof FilterError) return text({ error: error.message })
        throw error
      }
      for (const s of sources) {
        // A dataset is a source by its own name: whether the caller may read it is asked as it is read, and one they may not is answered as none.
        if (datasetOf(s.blueprint) !== null) {
          if (!deps.queries.kind(s.blueprint)) return text({ error: `no dataset ${datasetOf(s.blueprint)}` })
          continue
        }
        if (!view.seesSome(s.blueprint)) return text({ error: `no blueprint ${s.blueprint}` })
        const refused = s.filter ? view.refusedQuery(s.blueprint, s.filter) : null
        if (refused) {
          recordRefusal('hidden_field')
          return text({ error: `the filter reads "${refused}", which you cannot see` })
        }
      }
      // A condition of the view says @me and @today as a filter does, and the hub fills them in the same.
      const who = shown?.where?.some((c) => namesAsker({ field: c.field, op: c.op, value: c.value })) ? await whoAsks() : null
      const shaped = who && shown ? { ...shown, where: shown.where!.map((c) => ({ ...c, value: String(askerValue(c.value, who)) })) } : shown
      let result
      try {
        result = await deps.queries.run(sources, columns, view, identity)
      } catch (error) {
        if (error instanceof QueryError) return text({ error: error.message })
        throw error
      }
      const problem = deps.queries.problem(result, shaped)
      if (problem) return text({ error: problem })
      const answer = deps.queries.shown(result, shaped, limit)
      // A source that matched nothing says why, so the agent mends its question.
      const empty = sources.filter((s) => s.filter && !answer.counts[blueprints.resolve(s.blueprint)])
      const why = await Promise.all(empty.slice(0, 2).map(async (s) => ({ blueprint: s.blueprint, ...(await whyNone(s.blueprint, s.filter, s.states))! })))
      return text(why.length ? { ...answer, matchedNothing: why } : answer)
    },
  )

  server.registerTool(
    'get_entity',
    {
      description: `One entity by id (blueprint:key): its values (a long one is cut and says how long), status, its last ten changes, and every way it is linked, out and in, each as a relation, the blueprint at the other end, how many, and the first ${SHOWN_LINKS}. A group that holds more names, as more, the search_entities call that pages through the rest. provenance adds where each value came from.`,
      inputSchema: { id: z.string().default('').describe('blueprint:key, as search_entities answers it. Never ask the person for it'), provenance: z.boolean().default(false) },
    },
    async ({ id, provenance }) => {
      const ref = parseEntityId(id)
      if (!ref) return text({ error: `id must be blueprint:key. ${FIND_FIRST}` })
      const read = await reader.get(ref, { most: SHOWN_LINKS })
      const e = read && view.detail(read)
      if (!e) return text({ error: `no entity ${id}` })
      return text({
        id: e.id,
        title: e.title,
        state: e.state,
        status: e.status.level,
        ...(e.status.reasons.length ? { reasons: e.status.reasons } : {}),
        fields: Object.fromEntries(Object.entries(e.fields).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => [k, bounded(v, SHOWN_VALUE_CHARS)])),
        owner: e.owner,
        lastSeenAt: e.lastSeenAt,
        outgoing: outgoingGroups(e, e.outgoing),
        incoming: incomingGroups(e, e.incoming, e.incomingCount ?? {}),
        changes: e.changes.slice(0, 10).map((ch) => ({ at: ch.at, kind: ch.kind, source: ch.source, detail: ch.detail })),
        ...(provenance ? { provenance: e.provenance } : {}),
      })
    },
  )

  server.registerTool(
    'traverse',
    {
      description: `Walk relations from an entity, depth steps out, in, or both: what it runs on, what runs on it, what it calls. Answers how many things it reached of each blueprint, and the first ${WALK_NODES} of them with the links between them, nearest first. When it reached more, narrow with blueprints, or page one way it is linked with the more get_entity gives.`,
      inputSchema: {
        id: z.string().default('').describe('blueprint:key, as search_entities answers it. Never ask the person for it'),
        direction: z.enum(['in', 'out', 'both']).default('both'),
        depth: z.number().int().min(1).max(4).default(1),
        blueprints: z.array(z.string()).optional().describe('Only follow into these blueprints'),
      },
    },
    async ({ id, direction, depth, blueprints: only }) => {
      const ref = parseEntityId(id)
      if (!ref) return text({ error: `id must be blueprint:key. ${FIND_FIRST}` })
      if (!view.seesEntity(ref)) return text({ error: `no entity ${id}` })
      const result = await reader.related(ref, direction, depth, only, (b) => view.seesBlueprint(b))
      const seen = view.entities(result.nodes)
      // Nearest first: a node in the order the walk reached it, the start before all.
      const order = new Map<string, number>([[entityId(ref), 0]])
      for (const e of result.edges) for (const end of [e.from, e.to]) if (!order.has(entityId(end))) order.set(entityId(end), order.size)
      const nodes = seen.sort((a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity)).slice(0, WALK_NODES)
      const shownIds = new Set(nodes.map((n) => n.id))
      const counts: Record<string, number> = {}
      for (const n of seen) if (n.id !== entityId(ref)) counts[n.blueprint] = (counts[n.blueprint] ?? 0) + 1
      return text({
        reached: seen.length - 1,
        counts,
        nodes: nodes.map((n) => ({ id: n.id, title: n.title, blueprint: n.blueprint, status: n.status.level, state: n.state })),
        edges: result.edges.filter((e) => shownIds.has(entityId(e.from)) && shownIds.has(entityId(e.to))).map((e) => `${entityId(e.from)} -${e.relation}-> ${entityId(e.to)}`),
        ...(seen.length > nodes.length ? { cut: `${seen.length - nodes.length} more not shown` } : {}),
      })
    },
  )

  server.registerTool(
    'get_status',
    {
      description: `Health. With no blueprint: how many things of each blueprint are red, amber, or grey, and every source that is not green with why, its last run, and the entity it acts for. With a blueprint: its things that are not green, with their reasons, a page of ${PAGE} at a time; page with after. A filter on $status in search_entities narrows to one level.`,
      inputSchema: { blueprint: z.string().optional(), limit: z.number().int().min(1).max(PAGE_MAX).default(PAGE), after: z.string().optional().describe('The next a page answered with: the page after it') },
    },
    async ({ blueprint, limit, after }) => {
      if (!blueprint) {
        const s = await deps.summary(view)
        return text({
          notGreen: s.blueprints.filter((b) => b.notGreen.red || b.notGreen.amber || b.notGreen.grey).map((b) => ({ blueprint: b.id, title: b.title, ...b.notGreen })),
          sources: sources.list().filter((x) => x.status !== 'green').map((x) => ({ id: x.id, status: x.status, reason: x.statusReason, lastRunAt: x.lastRunAt, cadence: x.cadence, actsFor: x.actsFor })),
        })
      }
      if (!view.seesSome(blueprint)) return text({ error: `no blueprint ${blueprint}` })
      const filter: Filter = { field: '$status', op: 'neq', value: 'green' }
      const asked: CursorQuestion = { blueprint, filter }
      let from: OrderValues | null = null
      try {
        from = after ? decodeCursor(asked, after) : null
      } catch (error) {
        if (error instanceof CursorError) return text({ error: error.message })
        throw error
      }
      const result = await reader.list({ blueprint, filter, limit, after: from, view })
      return text({ total: result.total, next: result.next ? encodeCursor(asked, result.next) : null, notGreen: result.entities.map((e) => ({ id: e.id, title: e.title, level: e.status.level, reasons: e.status.reasons })) })
    },
  )

  server.registerTool(
    'list_findings',
    {
      description: `Hygiene problems with the catalog itself: dangling relations, unconnected entities, unmatched rules, stale sources, mass drops, cleared overrides, field conflicts, schema mismatches. With no kind: how many of each kind, by level. With a kind: its findings, a page of ${PAGE} at a time; page with offset.`,
      inputSchema: { kind: z.string().optional(), limit: z.number().int().min(1).max(PAGE_MAX).default(PAGE), offset: z.number().int().min(0).default(0) },
    },
    async ({ kind, limit, offset }) => {
      const all = view.findings(await findings.list())
      if (!kind) {
        const kinds: Record<string, { count: number; levels: Record<string, number> }> = {}
        for (const f of all) {
          const k = (kinds[f.kind] ??= { count: 0, levels: {} })
          k.count++
          k.levels[f.level] = (k.levels[f.level] ?? 0) + 1
        }
        return text({ total: all.length, kinds })
      }
      const of = all.filter((f) => f.kind === kind)
      return text({
        total: of.length,
        findings: of.slice(offset, offset + limit).map((f) => ({ level: f.level, title: f.title, detail: bounded(f.detail, SHOWN_VALUE_CHARS), entity: f.entity ? entityId(f.entity) : undefined, source: f.source })),
        ...(offset + limit < of.length ? { more: { tool: 'list_findings', args: { kind, limit, offset: offset + limit } } } : {}),
      })
    },
  )

  server.registerTool(
    'get_changes',
    {
      description: 'The activity log: who changed what across the estate, the model, and access, newest first. Needs the audit.view permission.',
      inputSchema: {
        since: z.string().optional().describe('ISO time'),
        blueprint: z.string().optional(),
        key: z.string().optional(),
        kind: z.string().optional(),
        actorKind: z.string().optional().describe('Comma separated: user, token, source, hub'),
        category: z.string().optional().describe('Comma separated: estate, runs, model, layout, sources, secrets, access'),
        outcome: z.string().optional().describe('Comma separated: ok, refused, failed'),
        limit: z.number().int().min(1).max(500).default(50),
      },
    },
    async (q) => {
      return (await refused('audit.view', 'get_changes')) ?? text(view.changes(await listActivity(db, q, 500)).map((r) => ({ at: r.at, kind: r.kind, outcome: r.outcome, entity: r.blueprint && r.key ? `${r.blueprint}:${r.key}` : undefined, blueprint: r.key ? undefined : (r.blueprint ?? undefined), source: r.source, actor: r.actor, actorKind: r.actorKind, detail: r.detail })))
    },
  )

  server.registerTool(
    'get_scorecard',
    { description: `Scorecard results: how many entities reached each level, and the entities in the scorecard's scope with the level each reached, the rules it fails, and the rules its judge had no data on, a page of ${PAGE} at a time (page with offset); outOfScope counts those it does not score. Omit id to list scorecards.`, inputSchema: { id: z.string().optional(), failingOnly: z.boolean().default(false), limit: z.number().int().min(1).max(PAGE_MAX).default(PAGE), offset: z.number().int().min(0).default(0) } },
    async ({ id, failingOnly, limit, offset }) => {
      const readable = (scId: string) => {
        const sc = scorecards.get(scId)
        return !!sc && partsOf(sc).every((part) => view.seesBlueprint(part.blueprint) && partFilters(part).every((f) => !view.refusedFilter(part.blueprint, f)))
      }
      if (id && !readable(id)) return text({ error: `no scorecard ${id}` })
      if (!id) return text(scorecards.list().filter((s) => readable(s.id)).map((s) => ({ id: s.id, title: s.title, description: s.description, levels: s.levels.map((l) => l.name), blueprints: partsOf(s).map((p) => ({ blueprint: p.blueprint, ...(p.where ? { where: p.where } : {}), rules: p.levels.flatMap((l) => l.rules.map((r) => ({ id: r.id, title: r.title, level: l.name }))) })) })))
      const r = await scorecards.results(id)
      // Each blueprint has its own top: the highest level with a rule for it.
      const rows = failingOnly ? r.rows.filter((x) => x.level < topOf(partFor(r.scorecard, x.entity.blueprint)!)) : r.rows
      return text({ scorecard: r.scorecard.id, levels: ['none', ...r.scorecard.levels.map((l) => l.name)], counts: r.counts, outOfScope: r.outOfScope, total: rows.length, ...(offset + limit < rows.length ? { more: { tool: 'get_scorecard', args: { id, failingOnly, limit, offset: offset + limit } } } : {}), entities: rows.slice(offset, offset + limit).map((x) => ({ id: `${x.entity.blueprint}:${x.entity.key}`, title: x.title, level: x.levelName, failing: Object.entries(x.rules).filter(([, ok]) => ok === false).map(([k]) => k), noData: Object.entries(x.rules).filter(([, ok]) => ok === null).map(([k]) => k) })) })
    },
  )

  server.registerTool(
    'list_actions',
    {
      description: `Self-service actions you may run: what each does, the blueprints it runs on (omitted for a global action), and the inputs it takes, each with its type and its rules. The types: ${INPUT_KINDS_TEXT}. An input that says many takes a list. An entity or a person input takes an id blueprint:key of the blueprint it names, or a bare key when it names one; its where filter, rendered over the entity and the inputs above it, says which. A rule (${INPUT_RULES.join(', ')}) is what a value must keep: min and max bound a number, a date, or a date and time, and may read today, as today+30d; minLength and maxLength count characters, or what is picked of a list; hint says what a failed rule means. An input that says narrows is filled from the entity the action runs on. An input with a when is asked only when that filter matches the inputs above it, each read by its name, an entity as its id: send nothing for one that is not asked, and what is sent for it is dropped. An input that says workedOut is never sent: the hub works it out from the inputs above it, by its value expression. An input with unique is refused when an entity of that blueprint already holds the value in that field, whatever its case. A list input with current changes a list the entity holds: current is the template of what it holds now, such as {{ entity.fields.allowed_origins }}; send the whole list as it should be, every value once, read what it holds now with get_entity first, and a run that leaves it as it is is refused. sections says how the form groups the inputs, for a person to read. Give entity to list only the actions you may run on that one entity: who may run an action can depend on what you are to the entity and what it is. Without action, each action is listed by its id, title, description, the blueprints it runs on, its home (the entity it belongs to, when it has one you may see), and whether it waits for approval; give action to read that one in full, with its inputs, before you run it. pinned says the person you act as keeps it at the top of their own page.`,
      inputSchema: { blueprint: z.string().optional().describe('Only actions on this blueprint'), entity: z.string().optional().describe('blueprint:key: only actions you may run on this entity'), action: z.string().optional().describe('One action id: that action in full, with its inputs') },
    },
    async ({ blueprint, entity, action }) => {
      const ref = entity ? parseEntityId(entity) : null
      if (entity && !ref) return text({ error: 'entity must be blueprint:key' })
      // A person input names no blueprint of its own: the agent is told the one the estate says a person is.
      const people = deps.visibility.personSetting()?.blueprint
      const listed = (await actions.listFor(identity, view)).filter((a) => a.canRun && (!action || a.id === action) && (!blueprint || actionTargets(a).includes(blueprint)) && (!ref || actionTargets(a).includes(ref.blueprint)))
      // On one entity, a rule may hold the run for approval where the action itself does not.
      const on = ref ? await Promise.all(listed.map(async (a) => (await actions.targets(identity, view, a, [ref])).get(entityId(ref)))) : null
      const brief = (a: (typeof listed)[number], i: number) => ({ id: a.id, title: a.title, description: a.description, pinned: a.pinned, ...(a.homeShown ? { home: { id: a.homeShown.id, title: a.homeShown.title } } : {}), blueprints: actionTargets(a), approval: on ? on[i]!.approval : !!a.approval })
      if (!action) return text(listed.flatMap((a, i) => (on && !on[i] ? [] : [brief(a, i)])))
      if (!listed.length || (on && !on[0])) return text({ error: `no action ${action} you may run${ref ? ` on ${entity}` : ''}` })
      return text(listed.map((a, i) => ({ id: a.id, title: a.title, description: a.description, iconShown: a.iconShown, pinned: a.pinned, group: a.group, ...(a.homeShown ? { home: { id: a.homeShown.id, title: a.homeShown.title } } : {}), blueprints: actionTargets(a), where: a.where, ...(a.self ? { self: true } : {}), ...(a.sections ? { sections: a.sections } : {}), inputs: Object.fromEntries(Object.entries(a.inputs).map(([name, def]) => [name, { ...def, ...(INPUT_KINDS[def.type].person ? { blueprint: inputPicks(def, people)[0] } : {}), ...(def.value !== undefined ? { workedOut: true } : {}) }])), backend: a.backend.type, approval: on ? on[i]!.approval : !!a.approval }))[0])
    },
  )

  server.registerTool(
    'run_action',
    {
      description: 'Run a self-service action you are named on. Give the entity it runs on when the action has a blueprint, and every required input that is asked. What is sent for an input that is not asked, or for one the hub works out, is dropped. Answers the run with its id and state, and for an input that changes a list the entity holds, changes: what the run adds and removes against that list as it is now, and how many it keeps, to tell the person. From then on the hub holds the run: next says whether anything of yours must stay for it, and for all but a caller backend nothing must, so ask, tell the person, and stop. get_action_run reads its state, steps, log, outputs, and link at any time. A run that waits for approval answers approve, the link a person opens to review and approve it: give it to them. A refusal that is about one input names it as input.',
      inputSchema: { action: z.string(), entity: z.string().optional().describe('blueprint:key'), inputs: z.record(z.string(), z.unknown()).default({}) },
    },
    async ({ action, entity, inputs }) => {
      const ref = entity ? parseEntityId(entity) : undefined
      if (entity && !ref) return text({ error: 'entity must be blueprint:key' })
      const a = actions.get(action)
      if (!a || !view.seesAction(a) || (ref && !view.seesBlueprint(ref.blueprint))) return text({ error: `no action ${action}` })
      try {
        const run = await actions.request(action, { entity: ref ?? undefined, inputs }, identity, view)
        // A run that waits is decided by a person on its page: the agent hands them the link, and never decides it itself.
        const waits = run.state === 'awaiting' ? { approve: actions.runUrl(run.id), next: `It waits for approval. Give the person this link to review it: ${actions.runUrl(run.id)}${madeAsPerson(a) ? '. It runs as whoever approves it, signed in on that page, and only someone who may run it here themselves can approve it' : ''}. ${goesOn(a, true)}` } : isFinished(run.state) ? {} : { next: goesOn(a, false) }
        // What the run does to each list it edits, against the list kept as it was asked for: tell the person this.
        const changed = Object.entries(runChanges(a.inputs, run.inputs, run.current))
        const lists = changed.length ? { changes: Object.fromEntries(changed.map(([name, c]) => [name, { added: c.added, removed: c.removed, unchanged: c.unchanged.length }])) } : {}
        return text({ run: run.id, state: run.state, url: run.link, ...lists, ...waits, log: run.log.map((l) => l.message) })
      } catch (error) {
        if (error instanceof ActionError) return text(error.input === undefined ? { error: error.message } : { error: error.message, input: error.input })
        throw error
      }
    },
  )

  server.registerTool(
    'propose_changes',
    {
      description:
        'Ask for many action runs at once as one change set, for a person to approve with one decision. Each item names its action, the entity it runs on (blueprint:key) when the action has a blueprint, and its own inputs, as run_action takes them; items may mix actions, and run in the order given for each action. Give a short title and a note that says why, for whoever approves it. Every item is judged as run_action would judge it, and nothing is asked when any item would be refused: the answer then names each refused item by its index, with why and the input it is about; mend them and ask again. Answers the set with approve, the link a person opens to review every change and approve them all at once: give it to them. You never approve it yourself.',
      inputSchema: {
        title: z.string().optional(),
        note: z.string().optional(),
        items: z.array(z.object({ action: z.string(), entity: z.string().optional().describe('blueprint:key'), inputs: z.record(z.string(), z.unknown()).default({}) })).default([]),
      },
    },
    async ({ title, note, items }) => {
      if (!title?.trim()) return text({ error: 'title is a short name for the whole change, such as "Program members for the fall term": the approver reads it first' })
      if (!items.length) return text({ error: 'items is the list of changes: each {action, entity: "blueprint:key", inputs}. Find each action with list_actions and each entity with search_entities.' })
      const bad = items.flatMap((i, index) => (i.entity && !parseEntityId(i.entity) ? [{ index, action: i.action, error: 'entity must be blueprint:key' }] : []))
      if (bad.length) return text({ error: 'Some entities are not blueprint:key', items: bad.slice(0, SET_REFUSALS_SHOWN) })
      try {
        const set = await deps.changeSets.create({ title, ...(note?.trim() ? { note } : {}), items: items.map((i) => ({ action: i.action, ...(i.entity ? { entity: parseEntityId(i.entity)! } : {}), inputs: i.inputs })) }, identity, view, { via: 'form' })
        const asPerson = set.actions.some((a) => { const def = actions.get(a.id); return !!def && !!madeAsPerson(def) })
        return text({
          set: set.id,
          title: set.title,
          decision: set.decision,
          changes: set.size,
          actions: set.actions,
          approve: set.url,
          next: `It waits for approval. Give the person this link to review every change and approve them all at once: ${set.url}${asPerson ? '. Some of its changes run as whoever approves them, signed in on that page' : ''}. Each change is its own run: get_action_run lists them as they run.`,
        })
      } catch (error) {
        if (error instanceof ChangeSetRefused) return text({ error: error.message, items: error.items.slice(0, SET_REFUSALS_SHOWN).map((r) => ({ index: r.index, action: r.action, ...(r.entity ? { entity: `${r.entity.blueprint}:${r.entity.key}` } : {}), error: r.error, ...(r.input ? { input: r.input } : {}) })), ...(error.items.length > SET_REFUSALS_SHOWN ? { more: `${error.items.length - SET_REFUSALS_SHOWN} more items are refused; mend these and ask again to see the rest` } : {}) })
        if (error instanceof ActionError) return text(error.input === undefined ? { error: error.message } : { error: error.message, input: error.input })
        throw error
      }
    },
  )

  server.registerTool('get_action_run', { description: 'One action run: its state, what the backend reported, the steps it named, the outputs it ended with, its link, and the log, each line under its step. Read it at any time, however long after it was asked for: a run needs nobody connected to go on, and heardAt says when the hub last heard from one under way. Omit id to list the latest runs.', inputSchema: { id: z.string().optional(), action: z.string().optional(), limit: z.number().int().min(1).max(100).default(20) } }, async ({ id, action, limit }) => {
    const visible = (r: { action: string }) => { const a = actions.get(r.action); return !a || view.seesAction(a) }
    if (!id) return text(view.runs((await actions.listRuns({ action, limit })).runs).filter(visible).map((r) => ({ id: r.id, action: r.action, entity: r.entity ? `${r.entity.blueprint}:${r.entity.key}` : undefined, state: r.state, by: r.by, createdAt: r.createdAt, finishedAt: r.finishedAt, summary: r.summary })))
    const found = await actions.getRun(id)
    const run = found && view.runs([found]).length && visible(found) ? found : null
    return text(run ? { ...run, outputs: shownOutputs(run.outputs), entity: run.entity ? `${run.entity.blueprint}:${run.entity.key}` : null } : { error: `no run ${id}` })
  })

  server.registerTool(
    'get_report',
    {
      description: 'One report: what it is (owner, home, layout version, data sets, recipients), its editions newest first with what each said in a line and its headline numbers, and one edition read whole: its blocks, with each table cut to its first rows and a link to its data. Give edition for an older one, and compare for a second edition to read beside it: their headline numbers side by side, and how many rows each data set held. Give layout: true for the current layout and its versions.',
      inputSchema: { report: z.string().optional().describe('The report key, or orrery_report:key'), edition: z.number().int().min(1).optional(), compare: z.number().int().min(1).optional(), layout: z.boolean().optional() },
    },
    async ({ report, edition, compare, layout }) => {
      if (!report) return text({ error: `report is the key of a report. ${FIND_FIRST}` })
      const key = report.startsWith(`${REPORT_BLUEPRINT}:`) ? report.slice(REPORT_BLUEPRINT.length + 1) : report
      try {
        const page = await deps.reports.page(key, identity)
        const lines = page.editions.slice(0, REPORT_EDITIONS_SHOWN)
        const wanted = edition ?? page.editions[0]?.number
        const read = wanted ? await deps.reports.edition(key, wanted, identity) : null
        const other = compare ? await deps.reports.edition(key, compare, identity) : null
        const r = page.report
        const homes = Object.entries(r.relations).flatMap(([name, refs]) => (name.startsWith('home_') ? refs.map((ref) => `${ref.blueprint}:${ref.key}`) : []))
        return text({
          report: { id: r.id, title: r.title, owner: r.fields.owner ?? null, home: homes[0] ?? null, version: r.fields.version ?? null, dataSets: r.fields.data_sets ?? [], writer: r.fields.writer ?? null, recipients: r.fields.recipients ?? [], status: r.status, url: r.fields.url ?? null, canChange: page.canChange },
          editions: lines,
          ...(page.editions.length > lines.length ? { more: { editions: page.editions.length, how: 'get_report with edition: <number> reads any of them' } } : {}),
          ...(read ? { edition: { number: read.content.number, publishedAt: read.content.publishedAt, blocks: read.content.blocks.map((b) => (b.kind === 'table' || b.kind === 'scorecard' ? { ...b, rows: b.rows.slice(0, REPORT_TABLE_ROWS), ...('tones' in b && b.tones ? { tones: b.tones.slice(0, REPORT_TABLE_ROWS) } : {}), ...(b.rows.length > REPORT_TABLE_ROWS ? { cut: `${REPORT_TABLE_ROWS} of ${b.rows.length} rows shown; the data link has every row kept` } : {}) } : b)), data: `/v1/reports/${encodeURIComponent(key)}/editions/${read.content.number}/data` } } : { edition: null }),
          ...(read && other ? { compare: compared(read, other) } : {}),
          ...(layout ? { layout: r.fields.layout ?? null, versions: page.versions } : {}),
        })
      } catch (error) {
        if (error instanceof ReportError) return text({ error: error.message })
        throw error
      }
    },
  )

  server.registerTool(
    'check_report_layout',
    {
      description: 'Reads a report layout and names every problem with its line, as an edit would refuse it: the grammar, the blocks, and each data set\'s saved query or tool, judged as you. An empty answer means it reads. The grammar is in the modelling guide, under Reports.',
      inputSchema: { layout: z.string().optional() },
    },
    async ({ layout }) => {
      if (!layout) return text({ error: 'layout is the Markdown document to check: front matter naming data and writer, then headings, paragraphs, and fenced stats, chart, table, scorecard, and narrative blocks. A stats item, and a column under health in a table or a scorecard, takes good and bad: the two marks its number is judged by.' })
      return text({ issues: await deps.reports.problems(layout, identity) })
    },
  )

  server.registerTool(
    'list_datasets',
    {
      description: 'The published datasets you may read: tables from a store outside the catalog, such as a warehouse view, each with its columns and their types. Read one with run_query by naming it as a source, {blueprint: "$data:<id>"}, with its column ids as the columns; filter, group, and add it up as a blueprint. Its rows are kept for a while (fresh) and read again from its tool after.',
      inputSchema: {},
    },
    async () => {
      const all = await deps.datasets.list(identity, view)
      return text({ total: all.length, datasets: all.slice(0, DATASETS_SHOWN).map((d) => ({ id: d.id, source: `$data:${d.id}`, title: d.title, ...(d.description ? { description: d.description } : {}), columns: d.columns.map((c) => ({ id: c.id, type: c.type ?? 'string', ...(c.title ? { title: c.title } : {}) })), fresh: d.fresh, fetchedAt: d.fetchedAt })) })
    },
  )

  server.registerTool(
    'list_tools',
    {
      description: 'The tools you may call on an entity, or the tools of no entity when none is given. A tool reaches a live system with a key you never hold: its command runs on a runner the hub trusts, and its tier says how far it reaches (read looks, data reads what people stored, act changes something). Each tool lists the inputs it takes, as list_actions does. You are listed only what the entity lets you reach.',
      inputSchema: { entity: z.string().optional().describe('blueprint:key') },
    },
    async ({ entity }) => {
      const ref = entity ? parseEntityId(entity) : null
      if (entity && !ref) return text({ error: 'entity must be blueprint:key' })
      if (ref && !view.seesBlueprint(ref.blueprint)) return text([])
      return text(await actions.tools(identity, view, ref))
    },
  )

  server.registerTool(
    'call_tool',
    {
      description: 'Call a tool from list_tools and wait for what it says. Give the entity it is called on when the tool has one, and its inputs. Answers the run id, its state, the summary, the text the tool printed (truncated says it was cut), and its outputs. A state of queued or running means it had not ended when the wait ran out: read it later with get_action_run. Every call is in the activity log under your name.',
      inputSchema: { tool: z.string(), entity: z.string().optional().describe('blueprint:key'), inputs: z.record(z.string(), z.unknown()).default({}) },
    },
    async ({ tool, entity, inputs }) => {
      const ref = entity ? parseEntityId(entity) : undefined
      if (entity && !ref) return text({ error: 'entity must be blueprint:key' })
      const a = actions.get(tool)
      if (!a?.tool || !view.seesAction(a) || (ref && !view.seesBlueprint(ref.blueprint))) return text({ error: `no tool ${tool}` })
      try {
        const asked = await actions.call(tool, { ...(ref ? { entity: ref } : {}), inputs }, identity, view)
        const run = await actions.settled(asked.id, actions.waitOf(a, TOOL_WAIT_MS))
        return text({ run: run.id, state: run.state, summary: run.summary, ...actions.said(run), outputs: shownOutputs(run.outputs) })
      } catch (error) {
        if (error instanceof ActionError) return text(error.input === undefined ? { error: error.message } : { error: error.message, input: error.input })
        throw error
      }
    },
  )

  server.registerTool(
    'get_load',
    {
      description:
        'What costs the hub over the last hours, most time first: deriving by blueprint, grids opened, re-linking by relation (a relation rule or an inherited relation), writes by source, API calls by caller, what each kind of work asked of the database (database), and what the stars people keep cost each blueprint\'s grids with how many it holds (stars), beside the derive queue, what each blueprint holds, the budgets, what each source and caller used this hour and in its fullest hour, and the time of each hour (hourly). Read it before setting a budget. Needs the audit.view permission.',
      inputSchema: { hours: z.number().int().min(1).max(LOAD_MAX_HOURS).default(24) },
    },
    async ({ hours }) => (await refused('audit.view', 'get_load')) ?? text(await deps.load(hours)),
  )

  server.registerTool('get_budgets', { description: 'The budgets the hub holds its sources, callers, and blueprints to. Needs the audit.view permission.', inputSchema: {} }, async () => (await refused('audit.view', 'get_budgets')) ?? text(deps.budgets.get()))

  server.registerTool(
    'set_budgets',
    {
      description:
        'Set the budgets the hub holds. Send every budget of all four kinds each time: one left out is no longer held, so read get_budgets first and change what it answers. A budget is {warn, limit}, either or both: past warn the hub raises a finding, past limit it refuses. changes is entities a source changes in an hour, by source id; calls is API calls a token makes in an hour, by its name; entities is how many a blueprint holds, and reads is how many entities one of its rows reads on average, both by blueprint id. The name "*" is every one with no budget of its own. Set one only when the person asked for it, and take the number from get_load. Needs the budgets.set permission.',
      inputSchema: { changes: namedBudgets, calls: namedBudgets, entities: namedBudgets, reads: namedBudgets },
    },
    async (given) => {
      const no = await refused('budgets.set', 'set_budgets')
      if (no) return no
      const next = await deps.budgets.set(given)
      await record(db, 'budgets.changed', null, null, null, { budgets: next })
      return text(next)
    },
  )

  /**
   * A change to the model, made as the caller through the model page's own
   * code: needs model.edit, and a refusal is answered in the words the API
   * uses and recorded as the API records it.
   */
  const changing = async (tool: string, kind: ModelKind, id: string, change: () => Promise<unknown>) => {
    const no = await refused('model.edit', tool)
    if (no) return no
    try {
      return text(await change())
    } catch (error) {
      const why = modelRefusal(error)
      if (!why) throw error
      if (why.refusal) recordRefusal(why.refusal)
      await record(db, MODEL_CHANGES[kind], kind === 'blueprint' ? { blueprint: id } : null, null, null, { tool, id, status: why.status, error: why.error }, new Date(), 'failed')
      return text({ error: why.error, ...(why.offenders?.length ? { offenders: why.offenders.slice(0, PAGE) } : {}) })
    }
  }
  const caller = { name: identity.name, view }
  const kindArg = z.enum(MODEL_KINDS).default('blueprint').describe('blueprint (fields, relations, mirrors, aggregations, calculations, access, lifecycle, status, ground, map), rule (a relation rule: links two blueprints by matching values), scorecard, or alert_rule')
  /** One part of the model as an agent reads it, and for a blueprint the ids of the rules, scorecards, and alert rules on it. */
  const definitionOf = (kind: ModelKind, id: string) => {
    const part = deps.model.part(caller, kind, id)
    if (!part) return { error: `No ${kind.replace('_', ' ')} "${id}"; describe_model lists the blueprints` }
    if (kind !== 'blueprint') return part
    const on = deps.model.model(caller, part.id)
    return { ...part, on: { rules: on.relationRules.map((r) => r.id), scorecards: on.scorecards.map((s) => s.id), alertRules: on.alertRules.map((r) => r.id) } }
  }

  server.registerTool(
    'get_model_definition',
    {
      description:
        'One part of the model exactly as it is defined, as edit_model changes it: a blueprint with every field (type, title, description, values, calculation, mirror, aggregation, format, access, and the rest), every relation, and its settings; a relation rule; a scorecard; or an alert rule. origin says who defines it, and changeable is false where git or the hub does: such a part is changed there, never through edit_model. A blueprint also names, as on, the rules, scorecards, and alert rules on it. Read it before edit_model.',
      inputSchema: { kind: kindArg, id: z.string().optional().describe('The blueprint id, or the id of the rule, scorecard, or alert rule') },
    },
    async ({ kind, id }) => text(id ? definitionOf(kind, id) : { error: 'Name the part: describe_model lists every blueprint, and a blueprint\'s definition names the rules, scorecards, and alert rules on it' }),
  )

  server.registerTool(
    'edit_model',
    {
      description:
        'Change the model on the hub, as the model page does, with the same checks: add, change, or remove a blueprint\'s fields and relations (a calculation, a mirror, an aggregation, a type, a title, values, access, adminEdit, summary, and every other property), change its title, description, icon, group, or any other setting, and add or change a relation rule, a scorecard, or an alert rule. change is laid over the definition get_model_definition answers, as JSON Merge Patch: an object merges into what it names, null removes what it names, and anything else, a list included, replaces it whole. So {fields: {cost: {calculation: "a + b"}}} changes one field\'s calculation; {fields: {old: null}} removes a field; {fields: {owner_keys: {type: "string", title: "Owner keys"}}} adds one; {relations: {team: {target: "team"}}} adds a relation; {description: "..."} changes the blueprint\'s. A list is sent whole: to take one key out of a list in a calculation, send the calculation with it gone. An id that does not exist yet is created from change, which is then the whole definition. A change the hub refuses (a calculation that does not compile, a type the stored values do not fit, a rule only an admin sets) changes nothing and says why. The change is recorded under the person you answer for. Needs the model.edit permission.',
      inputSchema: {
        kind: kindArg,
        id: z.string().describe('The blueprint id, or the id of the rule, scorecard, or alert rule'),
        change: z.record(z.string(), z.unknown()).describe('What to change, laid over the current definition: null removes, an object merges, anything else replaces'),
      },
    },
    async ({ kind, id, change }) => changing('edit_model', kind, id, async () => (await deps.model.change(caller, kind, id, change), definitionOf(kind, id))),
  )

  server.registerTool(
    'delete_from_model',
    {
      description: 'Remove a whole blueprint, relation rule, scorecard, or alert rule from the model, as the model page does. A blueprint another blueprint\'s relation still targets is refused: change or remove that relation first. To remove one field or relation, use edit_model with it set to null. Needs the model.edit permission.',
      inputSchema: { kind: kindArg, id: z.string().describe('The blueprint id, or the id of the rule, scorecard, or alert rule') },
    },
    async ({ kind, id }) => changing('delete_from_model', kind, id, async () => (await deps.model.remove(caller, kind, id), { removed: { kind, id } })),
  )

  server.registerTool(
    'rename_blueprint',
    {
      description: 'Give a blueprint a new id. Its entities, relations, rules, scorecards, alert rules, and sources follow, and the old id keeps answering as the new one until it is forgotten. Needs the model.edit permission.',
      inputSchema: { blueprint: z.string(), to: z.string().describe('The new id: lower case letters, digits, and underscores') },
    },
    async ({ blueprint, to }) => changing('rename_blueprint', 'blueprint', blueprint, async () => (await deps.model.rename(caller, blueprint, to), definitionOf('blueprint', to))),
  )

  // The ground is a preview: an agent is given the tool only when its caller is in it.
  if (deps.previews.open('garden', identity)) {
    server.registerTool(
      'get_ground',
      {
        description:
          'How the entities of a blueprint are doing against the numbers their estate set. A blueprint names a ground by saying which of its fields is how long a round of work takes (loop), how often work gets stuck (friction), and how much of what should not be there it holds (unwanted); any number field may hold a budget, the range it should stay in. With no blueprint: every blueprint that has a ground, and the share of its entities inside every budget. With a blueprint: its entities worst first, each with its numbers and whether each is over its budget; cover (how many are inside every budget); rounds (where to go first, with why); templates (what entities were started from, and how many are on an older version); forecast (numbers heading out of their budget, and dates falling due); seasons (the share inside budget, week by week). With a key too: that entity, what it is built on, the limits it holds, and the entities that copied from the same place. Returns only what the caller may see.',
        inputSchema: { blueprint: z.string().optional().describe('The blueprint id. Left out, the answer lists every blueprint that has a ground.'), key: z.string().optional().describe('An entity key of that blueprint.') },
      },
      async ({ blueprint, key }) => {
        if (!blueprint) return text(unread(await deps.grounds.index(identity, view)))
        const id = blueprints.resolve(blueprint)
        if (key) return text(unread(await deps.grounds.item(identity, view, { blueprint: id, key })) ?? { error: `No entity "${key}" on the ground of "${blueprint}"` })
        return text(unread(await deps.grounds.of(identity, view, id)) ?? { error: `Blueprint "${blueprint}" has no ground` })
      },
    )
    server.registerTool(
      'get_map',
      {
        description:
          'The map of an entity that holds others, such as a program: its parts (the entities that name it as their parent), the places its things are in (such as environments), its plots (such as services) with each place they are in and how each is doing there, and its members (such as apps, databases, and storage), each in its place and in a plot or open. Every thing carries the actions the caller may run on it, and its checks in one shape: each scorecard rule that scores it, each budget on a number, and each guard, as pass, fail, or unknown when nothing it reads has a value. A blueprint names a map in its model; the map may also name a boolean field that marks its primary holders (primary) and a field or to-one relation that groups them (sector). With no blueprint: every entity a map can be drawn of, with how many plots and members its map holds, how their checks stand (checks, failing, unknown), whether it is primary, and its sector. With a blueprint and a key: that entity\'s map. Returns only what the caller may see.',
        inputSchema: { blueprint: z.string().optional().describe('The blueprint id of the holder, such as program. Left out, the answer lists every entity a map can be drawn of.'), key: z.string().optional().describe('The holder\'s key. Needed with a blueprint.') },
      },
      async ({ blueprint, key }) => {
        if (!blueprint) return text(unread(await deps.maps.index(identity, view)))
        if (!key) return text({ error: 'A map is of one entity: give its key with the blueprint' })
        return text(unread(await deps.maps.of(identity, view, { blueprint: blueprints.resolve(blueprint), key })) ?? { error: `No map of "${key}" in "${blueprint}"` })
      },
    )
  }

  return server
}

/** A run's outputs as an agent reads them: an image is said, not sent. */
function shownOutputs(outputs: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  return outputs && Object.fromEntries(Object.entries(outputs).map(([k, v]) => [k, typeof v === 'string' ? outputText(v) : v]))
}
