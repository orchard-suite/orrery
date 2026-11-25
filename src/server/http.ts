import { serveStatic } from '@hono/node-server/serve-static'
import { readFileSync } from 'node:fs'
import { Hono, type Context, type MiddlewareHandler } from 'hono'
import { compress } from 'hono/compress'
import { HTTPException } from 'hono/http-exception'
import { matchedRoutes, routePath } from 'hono/route'
import { streamSSE } from 'hono/streaming'
import { stringify as toYaml } from 'yaml'
import { z } from 'zod'
import type { ChangeSetApproval, ChangeSetRequest, ChangeSetResponse, ChangeSetSummary, ChangeSetsResponse, ActionInsights, DatasetsResponse, ReportsResponse, ActionSchedule, MyApprovals, ScheduleHistory, ScheduleRequest, SchedulesResponse, QueryAnswer, QueryResult, QuerySpec, SaveQueryRequest, SavedQueriesResponse, QueryAudiencesResponse, SavedQuery, AccessSettingsResponse, ActionBatchResponse, ActionBatchSummary, ActionBatchesResponse, BatchAgainRequest, BatchApproval, BatchPreview, BulkEditResponse, StreamHello, IconsResponse, MyPerson, PicturesResponse, ActionReport, ActionSummariesResponse, ActionSummary, ActionRunsResponse, ActionTargetsResponse, ActionsLayout, ActionsResponse, ActionView, AssignedCheckView, BlueprintsResponse, ModelLayout, ModelPlacement, ChangesResponse, EntitiesResponse, LoadResponse, Budgets as BudgetSet, EntityPageResponse, FindingsResponse, GridLayout, GridLayoutPatch, MineResponse, NotGreenCounts, PinsResponse, StarResponse, StarsResponse, RolesResponse, RunActionRequest, ScorecardResults, SummaryResponse, UsersResponse, WallResponse, ProtectedResourceInfo, SignInInfo, WhoAmIResponse, MapIndexResponse, MapResponse, WalkResponse, GroundIndexResponse, GroundItemResponse, GroundResponse, PreviewsResponse, ReturnRunRequest, ToolCallRequest, ToolCallResponse, ToolCaller, ToolsResponse, StarterRunsRequest, StarterRunsResponse } from '../shared/api.ts'
import { WEEKDAYS } from '../shared/cadence.ts'
import { SCHEDULE_TELLS } from '../shared/schedule.ts'
import { CHART_TOTALS, clauseRelation, ENTITY_LINKS, QUERY_GROUPS_MAX, RELATION_MATCHES, type GridClause, QUERY_TOTALS, TARGET_PAGE_MAX, type QueryView } from '../shared/api.ts'
import { MAX_ICON_BYTES } from '../shared/icons.ts'
import { OUTPUT_IMAGE_MAX, OUTPUT_NAME, OUTPUT_VALUE_MAX, STEP_NAME_MAX, isImageOutput, outputFits } from '../shared/run-marks.ts'
import { modellingGuide } from './guide.ts'
import { importModel, listTemplates, readTemplate } from './catalog.ts'
import { isHubBlueprint, setHubAccess } from './builtin.ts'
import { ACTION_RUN_STATES, BATCH_MAX, CHANGE_SET_MAX, ENTITY_STATES, FILTER_OPS, MOST_PINS, isFinished, PERMISSIONS, PIN_KINDS, RESERVED_PREFIX, SOURCE_BLUEPRINT, blueprintNamer, can, entityId, parseEntityId, type AccessGrant, type AccessRule, type ActionOrigin, type ScorecardOrigin, type ActionRunState, type Blueprint, type BlueprintNamer, type BlueprintInput, type Entity, type EntityRef, type FieldDef, type Filter, type Finding, type Identity, type Permission, type Pin, type StatusLevel, type User } from '../shared/model.ts'
import { AccessError, type Access } from './access.ts'
import { ActionError, CLAIM_MAX, RUNNER_WIDTH_MAX, STARTER_SEEN_MAX, TOOL_WAIT_MS, type Actions, type Lent } from './actions.ts'
import { SignInAgain } from './behalf.ts'
import type { Batches } from './batches.ts'
import { ChangeSetRefused, type ChangeSets } from './change-sets.ts'
import { ScheduleError, type Schedules } from './schedules.ts'
import { ReportError, type Reports } from './reports.ts'
import { DatasetError, type Datasets } from './datasets.ts'
import { drawEdition } from '../shared/report-draw.ts'
import { LAYOUT_MAX } from '../shared/report.ts'
import { actionInsights } from './insights.ts'
import type { Approvals } from './approvals.ts'
import { QUERY_SOURCES_MAX, QueryError, type Queries, type ReadSource } from './queries.ts'
import { BATCH_ROW, actingAs, listActivity, record } from './activity.ts'
import { acting, actor, authenticate, guards, identityOf, requireReader, requireSource, viewingAs, type AppEnv, type Surface } from './auth.ts'
import type { Blueprints } from './blueprints.ts'
import { StandardError, type ColumnStandards } from './standard.ts'
import { ConventionError, type Conventions } from './conventions.ts'
import type { Config } from './config.ts'
import type { Db } from './db.ts'
import { blank, WriteError, type Entities, type EntityRow, type WriteInput } from './entities.ts'
import type { MineFillResponse, Scorecard } from '../shared/api.ts'
import type { Events } from './events.ts'
import type { Findings } from './findings.ts'
import type { GitSources } from './git.ts'
import { IconError, type Icons } from './icons.ts'
import { PictureError, type Pictures } from './pictures.ts'
import { alertmanagerSchema, type Alerts } from './alerts.ts'
import { MODEL_LAYOUT_GENERATION, placeAll } from './layout.ts'
import { resultSchema, type Checks } from './checks.ts'
import type { Scorecards } from './scorecards.ts'
import { partFilters, partsOf } from '../shared/scorecard.ts'
import { tiersSchema } from '../shared/action-spec.ts'
import type { Logger } from './log.ts'
import { createMcpHandler } from './mcp.ts'
import { AdminOnly, Hidden, ModelEdits, accessRuleSchema, grantSchema, handOverSchema, modelRefusal, shown, stableJson, type Caller } from './model-edit.ts'
import { Posture } from './posture.ts'
import type { EditsResponse, PolicyPreview, PostureChange, PosturePreview, PostureReach, PostureResponse, PostureTarget, PostureWho } from '../shared/posture.ts'
import { openapi } from './openapi.ts'
import { FilterError, readFilter } from '../shared/filter.ts'
import { CLOCK_MS, layersOf, peek, readsNow, type Reader } from './read.ts'
import { ALL, CursorError, type OrderValues } from './query.ts'
import { decodeCursor, encodeCursor, type CursorQuestion } from './cursor.ts'
import type { Rules } from './rules.ts'
import { RunError, type Runs } from './runs.ts'
import { SourceError, type Sources } from './sources.ts'
import type { IdTokenVerifier } from './signin.ts'
import { reachesOut, type Lists } from './lists.ts'
import type { View, Visibility } from './visibility.ts'
import { normalizePolicy, type AccessPolicy, type PolicyState } from '../shared/policy.ts'
import { tally, type Writes } from './writes.ts'
import { recordRefusal, recordRequest, timed, working } from './metrics.ts'
import { sendBrowser, sendUsage, telemetryOn, traced } from './telemetry.ts'
import { addressTrust, clientAddress } from './client-address.ts'
import type { Cardinality } from './cardinality.ts'
import { ANONYMOUS, routeName, starsLoad, type Load } from './load.ts'
import { OverBudget, type Budgets } from './budgets.ts'
import { Grounds } from './ground.ts'
import { Maps } from './map.ts'
import { previewsSchema, type Previews } from './previews.ts'
import type { Presence } from './presence.ts'
import { PinsFull, isPinKind, type Pins } from './pins.ts'
import type { Stars } from './stars.ts'
import { MOST_STEP_THINGS, WalkFull, type Walks } from './walks.ts'
import { PreferenceError, type Preferences } from './preferences.ts'
import { WelcomeError, type Welcome } from './welcome.ts'
import { isPreferenceName, type PreferenceValues } from '../shared/preferences.ts'
import { buildTour, type WelcomeDef, type WelcomeFound, type WelcomeResponse } from '../shared/welcome.ts'
import { ACTION_PINNED, ACTION_UNPINNED, BLUEPRINT_PINNED, BLUEPRINT_UNPINNED, ENTITY_STARRED, ENTITY_UNSTARRED, WALK_STEP_ADDED, WALK_STEP_REMOVED, BROWSER_EVENTS, BROWSER_MEASURES, TELEMETRY_LIMITS, type TelemetryBatch } from '../shared/usage.ts'

export interface HttpDeps {
  config: Config
  db: Db
  blueprints: Blueprints
  standards: ColumnStandards
  conventions: Conventions
  welcome: Welcome
  entities: Entities
  reader: Reader
  runs: Runs
  rules: Rules
  sources: Sources
  writes: Writes
  load: Load
  cardinality: Pick<Cardinality, 'read'>
  budgets: Budgets
  previews: Previews
  access: Access
  findings: Findings
  git: GitSources
  scorecards: Scorecards
  alerts: Alerts
  checks: Checks
  actions: Actions
  batches: Batches
  changeSets: ChangeSets
  queries: Queries
  schedules: Schedules
  reports: Reports
  datasets: Datasets
  approvals: Approvals
  events: Events
  visibility: Visibility
  lists: Lists
  icons: Icons
  pictures: Pictures
  presence: Presence
  pins: Pins
  stars: Stars
  walks: Walks
  preferences: Preferences
  log: Logger
  version: string
  webDir: string | null
  /** True once the hub is stopping: it still answers, but no longer asks for traffic. */
  draining: () => boolean
  /** Verifies the ID token the login proxy passes on. Set when `AUTH_ISSUER` is configured. */
  idTokens?: IdTokenVerifier
}

const writeInputSchema = z.object({
  blueprint: z.string().min(1),
  key: z.string().min(1),
  title: z.string().optional(),
  icon: z.string().optional(),
  fields: z.record(z.string(), z.unknown()).optional(),
  relations: z.record(z.string(), z.union([z.string(), z.array(z.string()), z.null()])).optional(),
  digest: z.string().min(1).max(128).optional(),
})
const batchSchema = z.object({ entities: z.array(writeInputSchema).max(1000), observedAt: z.string().optional() })
const runOpenSchema = z.object({ mode: z.enum(['snapshot', 'incremental']), scope: z.string().min(1), write: z.enum(['upsert', 'enrich']).default('upsert') })
const singleWriteSchema = writeInputSchema.omit({ blueprint: true, key: true, digest: true }).extend({ observedAt: z.string().optional(), mode: z.enum(['upsert', 'enrich']).default('upsert'), scope: z.string().optional() })
const uiPatchSchema = z.object({ fields: z.record(z.string(), z.unknown()).optional(), relations: z.record(z.string(), z.union([z.string(), z.array(z.string()), z.null()])).optional() })
const refSchema = z.object({ blueprint: z.string(), key: z.string() })
const targetShape = {
  entities: z.array(refSchema).min(1).max(2000).optional(),
  query: z.object({ blueprint: z.string().min(1), filter: z.custom<Filter>((v) => !!v && typeof v === 'object').optional(), states: z.array(z.enum(ENTITY_STATES)).optional(), hidden: z.boolean().optional(), except: z.array(refSchema).max(2000).optional() }).optional(),
}
const oneTarget = (t: { entities?: unknown; query?: unknown }) => !!t.entities !== !!t.query
/** A bulk change names its rows, or names the filter they match. */
const targetSchema = z.object(targetShape).refine(oneTarget, 'Name the rows in entities or the filter in query, not both')
const bulkSchema = uiPatchSchema.extend({ ...targetShape, hidden: z.boolean().optional() }).refine(oneTarget, 'Name the rows in entities or the filter in query, not both')
// One page of the target picker: one target by id, what was typed, and how many at most.
const targetPageSchema = z.object({ of: z.string().min(1).optional(), search: z.string().trim().max(200).optional().transform((v) => v || undefined), limit: z.coerce.number().int().min(1).max(TARGET_PAGE_MAX).default(TARGET_PAGE_MAX) })
/** How deep a relation's `where` nests inside another's. */
const CLAUSE_DEPTH = 3
/** One condition as the grid's filter bar and a query's sources keep it: a relation's may hold conditions on what it reaches, to `CLAUSE_DEPTH`. */
function clauseSchemaAt(depth: number): z.ZodType<GridClause, unknown> {
  const base = { field: z.string(), op: z.enum(FILTER_OPS), value: z.string(), not: z.boolean().optional() }
  if (depth >= CLAUSE_DEPTH) return z.object(base)
  return z.object({ ...base, where: z.array(clauseSchemaAt(depth + 1)).max(50).optional(), match: z.enum(RELATION_MATCHES).optional() }).refine((c) => !c.where || clauseRelation(c) !== null, 'Only a relation holds conditions on what it reaches')
}
const gridClauseSchema = clauseSchemaAt(1)
const gridSchema = z.object({
  columns: z.array(z.object({ id: z.string(), width: z.number().optional(), hidden: z.boolean().optional(), after: z.string().nullable().optional() })).optional(),
  arranged: z.literal('standard').optional(),
  filter: z.array(gridClauseSchema).max(50).optional(),
  sort: z.string().min(1).max(200).optional(),
})
const tokenSchema = z.object({ kind: z.enum(['source', 'access']), name: z.string().min(1), role: z.string().optional(), source: z.string().optional() })
const walkStepSchema = z.object({
  place: z.string().min(1).nullable(),
  ladder: z.string().min(1),
  from: z.number().int().min(0),
  scope: z.string().min(1).nullable(),
  things: z.array(z.string().min(1)).min(1).max(MOST_STEP_THINGS),
})
const pinsOrderSchema = z.object({ order: z.array(z.object({ kind: z.enum(PIN_KINDS), id: z.string().min(1) })).max(MOST_PINS) })
const entityRefSchema = z.object({ blueprint: z.string().min(1), key: z.string().min(1) })
const runActionSchema = z.object({
  entity: entityRefSchema.optional(),
  inputs: z.record(z.string(), z.unknown()).default({}),
  tiers: tiersSchema.optional(),
  revises: z.string().min(1).optional(),
  for: z.string().trim().min(1).max(320).optional(),
  approvers: z.array(grantSchema).min(1).max(20).optional(),
  requestedFor: z.string().trim().min(1).max(320).optional(),
}) satisfies z.ZodType<RunActionRequest, Omit<RunActionRequest, 'inputs'> & { inputs?: Record<string, unknown> }>
const returnRunSchema = z.object({ note: z.string().trim().min(1, 'Say what to change').max(4000) }) satisfies z.ZodType<ReturnRunRequest>
const toolCallerSchema = z.object({ person: z.string().trim().min(1).max(320), action: z.string().min(1), entity: entityRefSchema, run: z.string().min(1).optional() }) satisfies z.ZodType<ToolCaller>
const toolCallSchema = z.object({ entity: entityRefSchema.optional(), inputs: z.record(z.string(), z.unknown()).optional(), as: toolCallerSchema.optional() }) satisfies z.ZodType<ToolCallRequest>
/** The longest a runner may hold its ask for jobs open, in seconds. */
const JOBS_WAIT_MAX = 30
const starterRunsSchema = z.object({ seen: z.array(z.string().min(1)).max(STARTER_SEEN_MAX).optional() }) satisfies z.ZodType<StarterRunsRequest>
const reportSchema = z.object({
  state: z.enum(['running', 'succeeded', 'failed', 'unknown']).optional(),
  label: z.string().optional(),
  link: z.string().optional(),
  summary: z.string().optional(),
  log: z.array(z.string()).max(1000).optional(),
  step: z.string().trim().min(1, 'A step has a name').max(STEP_NAME_MAX, `A step's name holds at most ${STEP_NAME_MAX} characters`).optional(),
  outputs: z
    .record(
      z.string().regex(OUTPUT_NAME, 'An output is named in letters, digits, ".", "_", and "-", at most 64 of them'),
      z.union([z.string().refine(outputFits, `An output holds at most ${OUTPUT_VALUE_MAX} characters, or an image as a data address of at most ${OUTPUT_IMAGE_MAX / 1024} KB`), z.number(), z.boolean(), z.null()], 'An output is text, a number, true or false, or null to take it away'),
    )
    .optional(),
}) satisfies z.ZodType<ActionReport>
const policySchema = z.object({
  audiences: z.array(z.object({ id: z.string().min(1), title: z.string(), description: z.string().optional(), people: z.array(z.string()).default([]), grants: z.array(grantSchema).default([]), audiences: z.array(z.string()).default([]) })).max(200),
  classes: z.array(z.object({ id: z.string().min(1), title: z.string(), description: z.string().optional(), audiences: z.array(z.string()), match: z.array(z.string()).default([]), blueprints: z.array(z.string()).optional(), include: z.array(z.string()).default([]), exclude: z.array(z.object({ field: z.string(), reason: z.string() })).default([]), owned: z.object({ through: z.array(z.string().min(1)).default([]), roles: z.array(z.string().min(1)).default([]) }).optional() })).max(200),
  /** Left out by a page one release back, which knows none: the saved ones are then kept. */
  edits: z.array(z.object({ id: z.string().min(1), title: z.string(), description: z.string().optional(), blueprints: z.array(z.string()).default([]), fields: z.array(z.string()).default([]), relations: z.array(z.string()).default([]), audiences: z.array(z.string()).default([]), owned: z.object({ through: z.array(z.string().min(1)).default([]), roles: z.array(z.string().min(1)).default([]) }).optional() })).max(200).optional(),
}) satisfies z.ZodType<Omit<AccessPolicy, 'edits'> & { edits?: AccessPolicy['edits'] }, unknown>
const signalSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('event'), name: z.enum(BROWSER_EVENTS), props: z.record(z.string().regex(/^[a-zA-Z]{1,40}$/), z.string().max(TELEMETRY_LIMITS.propLength)).refine((p) => Object.keys(p).length <= TELEMETRY_LIMITS.props, `At most ${TELEMETRY_LIMITS.props} properties`).optional() }),
  z.object({ kind: z.literal('measure'), name: z.enum(BROWSER_MEASURES), page: z.string().regex(/^[A-Za-z -]{1,40}$/), value: z.number().min(0).max(3600) }),
  z.object({ kind: z.literal('error'), type: z.string().max(200), message: z.string().max(2000), stack: z.string().max(TELEMETRY_LIMITS.stack).optional(), page: z.string().max(100).optional() }),
])
const telemetrySchema = z.object({ session: z.string().min(1).max(64), signals: z.array(signalSchema).max(TELEMETRY_LIMITS.events) }) satisfies z.ZodType<TelemetryBatch>
/** How many ownership paths the person setting holds at most: a guard against a runaway list, well above what an estate's roles need. */
const OWNS_MOST = 60
const personSchema = z.object({ blueprint: z.string().min(1), field: z.string().min(1).optional(), owns: z.array(z.union([z.string().trim().min(1), z.object({ as: z.string().trim().min(1).max(40).optional(), path: z.string().trim().min(1) })])).max(OWNS_MOST).optional() }).nullable()
const postureTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('blueprint'), id: z.string().min(1) }),
  z.object({ kind: z.literal('field'), blueprint: z.string().min(1), field: z.string().min(1) }),
  z.object({ kind: z.literal('action'), id: z.string().min(1) }),
])
const postureChangeSchema = z
  .object({
    targets: z.array(postureTargetSchema).min(1).max(500),
    access: z.object({ op: z.enum(['set', 'add', 'remove', 'clear']), grants: z.array(grantSchema).max(50).optional(), everyone: z.boolean().optional(), audiences: z.array(z.string().min(1)).max(50).optional() }).optional(),
    adminEdit: z.boolean().optional(),
  })
  .refine((c) => c.access !== undefined || c.adminEdit !== undefined, 'Say what to change: access, the admin-only mark, or both') satisfies z.ZodType<PostureChange>

/** A target as a query names it: `blueprint:<id>`, `field:<blueprint>.<field>`, or `action:<id>`. */
function parseTarget(raw: string): PostureTarget | null {
  const [kind, ...rest] = raw.split(':')
  const id = rest.join(':')
  if (!id) return null
  if (kind === 'blueprint' || kind === 'action') return { kind, id }
  if (kind === 'field') {
    const dot = id.indexOf('.')
    return dot > 0 ? { kind, blueprint: id.slice(0, dot), field: id.slice(dot + 1) } : null
  }
  return null
}

/** Who the answers every reader is cut from are kept for: no person or token is named so. */
const EVERYONE = '\u0000everyone'
/** What those answers are built from: the whole estate, whoever reads it. */
const WHOLE = Object.freeze({})

/** The route a request will end at: the last one matched that names more than a wildcard, which is what a middleware is mounted on. */
function endRoute(c: Context<AppEnv>): string {
  const paths = matchedRoutes(c).map((r) => r.path)
  return paths.findLast((path) => !path.endsWith('*')) ?? paths.at(-1) ?? ''
}

export function createApp(deps: HttpDeps): Hono<AppEnv> {
  const { config, db, blueprints, standards, conventions, entities, reader, runs, rules, sources, writes, access, findings, git, scorecards, alerts, checks, actions, batches, changeSets, queries, schedules, reports, datasets, approvals, events, visibility, lists, icons, pictures, pins, stars, walks, log } = deps
  const app = new Hono<AppEnv>()
  const modelEdits = new ModelEdits({ blueprints, rules, scorecards, alerts, sources, entities, runs, events, visibility, log })

  const trust = addressTrust(config)
  log.info(trust.header ? 'caller addresses read from a trusted proxy header' : 'no proxy header is trusted: no caller has an address', { header: trust.header, hops: trust.hops })
  app.use('*', async (c, next) => {
    const started = performance.now()
    c.set('address', clientAddress((name) => c.req.header(name), trust))
    try {
      // The route a request ends at is matched before it runs: every statement it sends is counted under it.
      await working(`${c.req.method} ${endRoute(c)}`, () => traced(c, next))
    } finally {
      recordRequest((performance.now() - started) / 1000, { surface: c.env.surface, route: routePath(c), method: c.req.method, status: c.res.status })
    }
  })

  app.use('*', async (c, next) => {
    await next()
    // A route that says how long its answer keeps, as an icon does, is taken at its word.
    if (c.res.headers.has('cache-control')) return
    const immutable = c.req.path.startsWith('/assets/') && c.res.status === 200
    c.res.headers.set('cache-control', immutable ? 'private, max-age=31536000, immutable' : 'private, no-store')
  })
  // A whole-estate answer is a megabyte of JSON: it travels gzipped. The event stream is never held back to compress.
  app.use('*', compress())

  app.onError((error, c) => {
    // An action's error that is about one input names it, so a form shows it there.
    if (error instanceof QueryError || error instanceof ScheduleError) return c.json({ error: error.message }, error.status)
    if (error instanceof DatasetError) return c.json({ error: error.message }, error.status)
    if (error instanceof ReportError) return c.json(error.input === undefined ? { error: error.message } : { error: error.message, input: error.input }, error.status)
    if (error instanceof ChangeSetRefused) return c.json({ error: error.message, items: error.items }, error.status)
    // What a fresh sign-in would let through says where one starts, so the page sends the person there and back.
    if (error instanceof SignInAgain) return c.json({ error: error.message, signIn: config.AUTH_SIGN_IN_PATH }, 401)
    if (error instanceof ActionError) return c.json(error.input === undefined ? { error: error.message } : { error: error.message, input: error.input }, error.status)
    if (error instanceof WriteError || error instanceof RunError || error instanceof SourceError || error instanceof AccessError || error instanceof IconError || error instanceof PictureError || error instanceof PinsFull || error instanceof WalkFull || error instanceof PreferenceError || error instanceof WelcomeError) return c.json({ error: error.message }, error.status)
    if (error instanceof OverBudget) {
      recordRefusal('over_budget')
      if (error.retryAfterSeconds !== null) c.header('Retry-After', String(error.retryAfterSeconds))
      return c.json({ error: error.message }, 429)
    }
    // A change to the model turned down, in the words an agent's tool answers with too.
    const refused = modelRefusal(error)
    if (refused) {
      if (refused.refusal) recordRefusal(refused.refusal)
      return c.json({ error: refused.error, ...(refused.offenders ? { offenders: refused.offenders } : {}) }, refused.status)
    }
    if (error instanceof CursorError) return c.json({ error: error.message }, 400)
    if (error instanceof StandardError) return c.json({ error: error.message }, 409)
    if (error instanceof ConventionError) return c.json({ error: error.message }, 409)
    if (error instanceof SyntaxError) return c.json({ error: `Bad JSON: ${error.message}` }, 400)
    // A library's own HTTP error already carries the response it means, such as an MCP protocol error.
    if (error instanceof HTTPException) {
      log.warn('request refused', { method: c.req.method, path: c.req.path, status: error.status })
      return error.getResponse()
    }
    log.error('request failed', { method: c.req.method, path: c.req.path, error })
    return c.json({ error: error.message }, 500)
  })

  // Alive: the process answers. Ready: it takes traffic, which it stops doing as it drains to stop. Nothing to warm: derived state is in the database.
  app.get('/healthz', (c) => c.json({ ok: true, version: deps.version }))
  app.get('/readyz', (c) => (deps.draining() ? c.json({ ok: false, draining: true, version: deps.version }, 503) : c.json({ ok: true, version: deps.version })))
  // A token only works on the machine surface, so the spec served there names
  // the host it was fetched from; the session surface names the browser URL.
  app.get('/v1/openapi.json', (c) => c.json(openapi(c.env.surface === 'machine' ? origin(c) : config.PUBLIC_URL, deps.version)))

  // How a tool signs a person in to call this surface as them: the issuer and the scope to ask it for. Nothing secret: an app reads it before it has a token.
  const signIn = (c: Context<AppEnv>): SignInInfo | null =>
    c.env.surface === 'machine' && config.AUTH_API_SCOPE && config.AUTH_ISSUER && config.AUTH_AUDIENCE ? { issuer: config.AUTH_ISSUER, scope: `${config.AUTH_AUDIENCE}/${config.AUTH_API_SCOPE}` } : null
  const noSignIn = { error: 'This hub takes no person signed in by an app here' }
  app.get('/v1/sign-in', (c) => {
    const info = signIn(c)
    return info ? c.json(info) : c.json(noSignIn, 404)
  })
  // The same for an MCP client, in the shape it reads (RFC 9728): the agent tools are the resource, signed in to as the person.
  const resourceMetadata = `/.well-known/oauth-protected-resource/mcp`
  for (const path of ['/.well-known/oauth-protected-resource', resourceMetadata]) {
    app.get(path, (c) => {
      const info = signIn(c)
      if (!info) return c.json(noSignIn, 404)
      return c.json({ resource: `${origin(c)}/mcp`, authorization_servers: [info.issuer.replace(/\/$/, '')], scopes_supported: [info.scope], bearer_methods_supported: ['header'] } satisfies ProtectedResourceInfo)
    })
  }
  // An MCP client refused at /mcp is told where that is, so it can sign the person in and try again.
  app.use('/mcp', async (c, next) => {
    await next()
    const info = c.res.status === 401 ? signIn(c) : null
    if (!info) return
    c.res = new Response(c.res.body, c.res)
    c.res.headers.set('www-authenticate', `Bearer resource_metadata="${origin(c)}${resourceMetadata}", scope="${info.scope}"`)
  })

  const auth = authenticate(config, sources, access, log, deps.idTokens, (token) => actions.runOfToken(token))
  const { allow, ingest } = guards(db, log)
  const paths = ['/v1/*', '/mcp']
  // Every API call is counted under whoever made it, with its time and the bytes it answered with. A source's pushes
  // are counted where they are written, a stream stays open, and a page's telemetry is not a read: none is counted here.
  const uncounted = (path: string) => path.startsWith('/v1/ingest/') || path === '/v1/events' || path === '/v1/telemetry'
  const counted: MiddlewareHandler<AppEnv> = async (c, next) => {
    if (uncounted(c.req.path)) return next()
    const began = performance.now()
    try {
      await next()
    } finally {
      // Set once the caller is known: a call refused before that is nobody's. While an admin views as someone, the admin is calling.
      const id = c.get('identity') as Identity | undefined
      const caller = id ? (id.viewAs?.by ?? (id.kind === 'source' ? (id.source ?? id.name) : id.name)) : ANONYMOUS
      const route = routeName(caller, `${c.req.method} ${routePath(c)}`)
      const ms = performance.now() - began
      deps.load.note('read', caller, { calls: 1, ms })
      deps.load.note('route', route, { calls: 1, ms })
      const body = c.res.body
      if (body) {
        // The bytes are counted as they leave, so an answer is never read twice or held to be measured.
        let bytes = 0
        const counter = new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, out) {
            bytes += chunk.byteLength
            out.enqueue(chunk)
          },
          flush() {
            deps.load.note('read', caller, { rows: bytes })
            deps.load.note('route', route, { rows: bytes })
          },
        })
        c.res = new Response(body.pipeThrough(counter), c.res)
      }
    }
  }
  for (const path of paths) app.use(path, counted)
  for (const path of paths) app.use(path, auth)
  // The read API is every /v1 route but the ingest routes, which belong to
  // sources and runners.
  const readApi = (mw: MiddlewareHandler<AppEnv>): MiddlewareHandler<AppEnv> => (c, next) => (c.req.path.startsWith('/v1/ingest/') ? next() : mw(c, next))
  // Only the API can be viewed as someone else: the machine routes and the agents' tools are never theirs.
  app.use('/v1/*', readApi(viewingAs(db, access, log)))
  for (const path of paths) app.use(path, acting)
  // A token past its budget of calls for the hour is refused here, before any work is done for it. A person never is:
  // the web app must stay usable, and the pages a budget is read and set on answer whoever asks.
  const unheld = (path: string) => uncounted(path) || path === '/v1/load' || path === '/v1/budgets' || path === '/v1/whoami'
  const held: MiddlewareHandler<AppEnv> = async (c, next) => {
    const id = c.get('identity') as Identity | undefined
    if (id?.kind === 'token' && !unheld(c.req.path)) deps.budgets.hold('calls', id.name)
    return next()
  }
  for (const path of paths) app.use(path, held)
  app.use('/v1/*', readApi(requireReader))
  app.use('/mcp', requireReader)

  /** What this caller may see. A person sees what the access rules let them; an admin and a machine token see everything. */
  const viewOf = (c: Context<AppEnv>): Promise<View> => visibility.view(c.get('identity'))
  /**
   * A filter or a sort that reads what the caller may not see is refused: what it returns would tell them the value.
   * A field opened on the rows the caller owns may be read: the rows are filtered and sorted as the view left them, blank on every other row.
   */
  const refuseFilter = (view: View, blueprint: string | undefined, filter: Filter | undefined, sort: string | undefined) => {
    const read = filter ? view.refusedQuery(blueprint, filter) : null
    if (read) throw new Hidden(`The filter reads "${read}", which you cannot see`)
    const by = sort?.replace(/^-/, '')
    if (by && blueprint && view.refusedQuery(blueprint, { field: by, op: 'exists' })) throw new Hidden(`You cannot sort by "${by}"`)
  }
  const gridOf = async (blueprint: string): Promise<GridLayout> => {
    const row = await db.query<{ layout: GridLayoutPatch }>('SELECT layout FROM grid_layouts WHERE blueprint = $1', [blueprint])
    return { columns: [], ...row.rows[0]?.layout }
  }
  /**
   * True for a condition of a grid's shared filter the caller may not see: a field they may not see, or a
   * relation to a blueprint they may not see. A relation is named as the grid names its column, `r:<relation>`.
   */
  const unseen = (view: View, blueprint: string, field: string) => {
    const relation = clauseRelation({ field })
    if (relation === null) return view.refusedQuery(blueprint, { field, op: 'exists' }) !== null
    const target = blueprints.get(blueprint)?.relations[relation]?.target
    return !target || !view.seesBlueprint(target)
  }
  /** A grid's shared layout without the conditions the caller may not see, which name a field and a value kept in it, and without a sort on such a field. */
  const gridSeen = (view: View, blueprint: string, { filter, sort, ...layout }: GridLayout): GridLayout => ({
    ...layout,
    ...(filter ? { filter: filter.filter((clause) => !unseen(view, blueprint, clause.field)) } : {}),
    ...(sort && !unseen(view, blueprint, sort.replace(/^-/, '')) ? { sort } : {}),
  })
  /** A blueprint the caller may not see answers as if it did not exist. */
  const seen = (view: View, blueprint: string) => {
    if (!view.seesBlueprint(blueprint)) throw new Hidden(`Unknown blueprint "${blueprint}"`)
  }
  /** The same for a read that goes through the reader's view row by row, so a blueprint they see only their own entities of answers with those. */
  const seenSome = (view: View, blueprint: string) => {
    if (!view.seesSome(blueprint)) throw new Hidden(`Unknown blueprint "${blueprint}"`)
  }
  /**
   * A change to what access is decided from is refused to anyone but an
   * admin or a holder of `access.values`, and one to a blueprint or field an
   * admin marked to anyone but an admin. So is a change a person could not
   * see the result of.
   */
  const mayChange = async (c: Context<AppEnv>, refs: EntityRef[], patch?: { fields?: Record<string, unknown>; relations?: Record<string, unknown> }, guarded = true) => {
    const view = await viewOf(c)
    for (const ref of refs) {
      seen(view, ref.blueprint)
      const bp = blueprints.get(ref.blueprint)
      if (view.admin) continue
      const hidden = view.hiddenFields(ref.blueprint)
      for (const name of Object.keys(patch?.fields ?? {})) if (hidden.has(name)) throw new Hidden(`Blueprint "${ref.blueprint}" has no field "${name}"`)
      const refused = guarded ? visibility.refusesHandEdit(c.get('identity'), ref.blueprint, [...Object.keys(patch?.fields ?? {}), ...Object.keys(patch?.relations ?? {})]) : null
      if (refused) {
        log.info('hand edit refused: access is decided from it', { actor: c.get('identity').name, blueprint: ref.blueprint, reason: refused })
        throw new AdminOnly(refused)
      }
      // A relation to a blueprint the reader may not see is not there for them, so neither setting nor clearing it is theirs.
      for (const name of Object.keys(patch?.relations ?? {})) {
        const target = bp?.relations[name]?.target
        if (target && !view.seesBlueprint(target)) throw new Hidden(`Blueprint "${ref.blueprint}" has no relation "${name}"`)
      }
    }
  }

  const ref = (c: { req: { param: (n: string) => string } }): EntityRef => ({ blueprint: blueprints.resolve(c.req.param('blueprint')), key: c.req.param('key') })
  /**
   * How a person may change these values on each entity. Whoever holds
   * `entities.edit` changes what the guards on hand edits leave them. Anyone
   * else, and a holder where a guard stops them, changes an entity only
   * where an edit rule opens every name of the change to them on it: as its
   * steward where an audience lets them in, else as its owner, who never
   * writes over what a source says. An entity nothing lets them change is
   * answered in `refused`, with why.
   */
  const editing = async (c: Context<AppEnv>, refs: EntityRef[], patch: { fields?: Record<string, unknown>; relations?: Record<string, unknown> }): Promise<{ authored: (ref: EntityRef) => ReadonlySet<string>; refused: BulkEditResponse['refused'] }> => {
    await mayChange(c, refs, patch, false)
    const id = c.get('identity')
    const none: ReadonlySet<string> = new Set()
    const authored = new Map<string, ReadonlySet<string>>()
    const refused: BulkEditResponse['refused'] = []
    const out = { authored: (r: EntityRef) => authored.get(entityId(r)) ?? none, refused }
    if (id.admin) return out
    const fields = Object.keys(patch.fields ?? {})
    const relations = Object.keys(patch.relations ?? {})
    const holds = can(id, 'entities.edit')
    const ruled: { ref: EntityRef; why: string | null }[] = []
    for (const r of refs) {
      const why = visibility.refusesHandEdit(id, r.blueprint, [...fields, ...relations])
      if (!holds || why) ruled.push({ ref: r, why })
    }
    if (!ruled.length) return out
    const editor = await visibility.editor(id)
    const read = editor.any ? new Map((await reader.hydrated(ruled.map((r) => r.ref))).map((e) => [e.id, e])) : new Map<string, Entity>()
    for (const { ref: r, why } of ruled) {
      const e = read.get(entityId(r))
      const open = e ? editor.opens(e) : null
      const closed = [...fields.filter((n) => !open?.fields.has(n)), ...relations.filter((n) => !open?.relations.has(n))]
      if (!open || closed.length) {
        const reason = why ?? `Nothing lets you change ${closed.map((n) => `"${n}"`).join(', ')} here: it needs the "entities.edit" permission, or an edit rule that opens it to you`
        log.info('hand edit refused: no permission and no edit rule opens it', { actor: id.name, ...r, names: closed, reason })
        refused.push({ ...r, reason })
        continue
      }
      authored.set(entityId(r), new Set(fields.filter((n) => !open.steward(n, 'field'))))
      log.info('hand edit let in by an edit rule', { actor: id.name, ...r, fields, relations, asOwner: [...authored.get(entityId(r))!] })
    }
    return out
  }
  const parseFilter = (text: string | undefined): Filter | undefined => {
    if (!text) return undefined
    try {
      return readFilter(JSON.parse(text))
    } catch (error) {
      if (error instanceof FilterError) throw new WriteError(error.message)
      throw error
    }
  }
  /**
   * Names an answer by its tag, and says whether the caller already holds
   * it: then it is answered with nothing. The browser keeps the answer and
   * asks with its tag every time; an agent or a pusher may do the same.
   */
  const unchanged = (c: Context<AppEnv>, tag: string): boolean => {
    const etag = `"${tag}"`
    c.header('etag', etag)
    c.header('cache-control', 'private, no-cache')
    return etagMatches(c.req.header('if-none-match'), etag)
  }
  /** The names a `fields` or `relations` parameter asks for: null when it is not given, none when it is given empty. */
  const named = (given: string | undefined): string[] | null => (given === undefined ? null : given.split(',').filter(Boolean))
  /** An entity cut to the fields and relations asked for. It keeps its shape and everything else it carries. */
  const pick = (e: Entity, fields: string[] | null, relations: string[] | null): Entity => ({
    ...e,
    ...(fields ? { fields: Object.fromEntries(fields.filter((f) => f in e.fields).map((f) => [f, e.fields[f]])) } : {}),
    ...(relations ? { relations: Object.fromEntries(relations.filter((r) => r in e.relations).map((r) => [r, e.relations[r]!])) } : {}),
  })

  /** The fields of type `user` on one blueprint, or on every one: what the people beside a row are read from. */
  const personFields = (blueprint: string | undefined): string[] =>
    (blueprint ? [blueprints.get(blueprints.resolve(blueprint))] : blueprints.list()).flatMap((bp) => Object.entries(bp?.fields ?? {}).flatMap(([name, def]) => (def.type === 'user' ? [name] : [])))

  // Read API -----------------------------------------------------------------

  // An admin starts viewing as a person here, so the log says when. The web app then sends the person's address with every request.
  app.post('/v1/view-as', async (c) => {
    const real = c.get('identity')
    const { email } = z.object({ email: z.string().trim().min(1) }).parse(await c.req.json())
    if (!real.admin || real.kind !== 'user' || real.token) {
      await record(db, 'access.refused', null, null, null, { viewAs: email, reason: 'not an admin', method: c.req.method, path: c.req.path }, new Date(), 'refused')
      log.warn('view as refused', { actor: real.name, viewAs: email, reason: 'not an admin' })
      return c.json({ error: 'Only an admin can view the hub as someone else' }, 403)
    }
    const user = access.find(email)
    if (!user) {
      await record(db, 'access.refused', null, null, null, { viewAs: email, reason: 'unknown person', method: c.req.method, path: c.req.path }, new Date(), 'refused')
      log.warn('view as refused', { actor: real.name, viewAs: email, reason: 'unknown person' })
      return c.json({ error: `Nobody called "${email}" is here` }, 404)
    }
    await record(db, 'access.viewed', null, null, null, { viewed: user.email, admin: user.admin, roles: user.roles })
    log.info('viewing as', { actor: real.name, viewing: user.email, admin: user.admin, roles: user.roles })
    return c.json({ email: user.email, admin: user.admin })
  })
  app.get('/v1/guide', async (c) => c.body(await modellingGuide(), 200, { 'content-type': 'text/markdown; charset=utf-8' }))
  const notifications = config.DISPATCH_PUBLIC_URL ? `${config.DISPATCH_PUBLIC_URL.replace(/\/+$/, '')}/me` : undefined
  app.get('/v1/whoami', async (c) => c.json({ identity: c.get('identity'), ...(c.get('identity').kind === 'user' ? { person: await myPerson(c, c.get('identity').name) } : {}), ...(ownAddress(c) ? { address: ownAddress(c) } : {}), version: deps.version, web: config.PUBLIC_URL.replace(/\/+$/, ''), telemetry: telemetryOn(), previews: deps.previews.openTo(c.get('identity')), ...(notifications ? { notifications } : {}) } satisfies WhoAmIResponse))
  // What a signed-in person's browser saw, relayed as theirs: the page never holds the telemetry key or says who it is.
  app.post('/v1/telemetry', async (c) => {
    const id = c.get('identity')
    if (c.env.surface !== 'session' || id.kind !== 'user' || id.token) return c.json({ error: "Telemetry comes from a signed-in person's browser" }, 403)
    const body = await c.req.text()
    if (body.length > TELEMETRY_LIMITS.bytes) return c.json({ error: `A batch holds at most ${TELEMETRY_LIMITS.bytes} bytes` }, 413)
    const batch = telemetrySchema.parse(JSON.parse(body))
    await deps.presence.tab(batch.session.slice(0, 64))
    sendBrowser(id.viewAs?.by ?? id.name, batch.session, batch.signals, c.get('address'))
    return c.body(null, 204)
  })
  app.get('/v1/blueprints', async (c) => {
    const view = await viewOf(c)
    const rows = await db.query<{ blueprint: string; owner: string; n: string }>(`SELECT blueprint, owner, count(*)::text AS n FROM entities WHERE state = 'active' AND hidden = false GROUP BY blueprint, owner ORDER BY count(*) DESC, owner`)
    const list = blueprints.list().filter((bp) => view.seesSome(bp.id)).map((bp) => shown(bp, view, visibility))
    const counts: Record<string, number> = {}
    const held: Record<string, Record<string, number>> = {}
    for (const r of rows.rows.filter((r) => view.seesBlueprint(r.blueprint))) {
      counts[r.blueprint] = (counts[r.blueprint] ?? 0) + Number(r.n)
      ;(held[r.blueprint] ??= {})[r.owner] = Number(r.n)
    }
    // A blueprint seen only as an owner counts the reader's own, never the rest, and says nothing of who holds the rest.
    for (const bp of list)
      if (bp.onlyYours || bp.onlyAbout) {
        counts[bp.id] = view.oneByOne(bp.id)?.size ?? 0
        delete held[bp.id]
      }
    return c.json({ blueprints: list, counts, held, layout: blueprints.layout(), adminOnly: visibility.adminOnlyIds().filter((id) => view.seesBlueprint(id)) } satisfies BlueprintsResponse)
  })
  app.get('/v1/blueprints/:id', async (c) => {
    const view = await viewOf(c)
    const bp = blueprints.get(c.req.param('id'))
    return bp && view.seesSome(bp.id) ? c.json(shown(bp, view, visibility)) : c.json({ error: 'Unknown blueprint' }, 404)
  })

  /** Marks what the person starred among entities a grid block or an entity page answers with, in one read. Answers how many it marked. */
  const annotateStars = async (who: string | undefined, page: Entity[]): Promise<number> => {
    if (!who || !page.length) return 0
    const starred = await timed('stars.read', () => stars.among(who, page))
    for (const e of page) if (starred.has(e.id)) e.starred = true
    return starred.size
  }

  /** What a person may ask a list for: which rows, how ordered, how grouped. Checked against what they may see before anything is read. */
  const listQuery = async (c: Context<AppEnv>, q: { blueprint?: string; state?: string; hidden?: string; filter?: string; sort?: string; group?: string }) => {
    const states = q.state ? q.state.split(',').filter((s): s is Entity['state'] => (ENTITY_STATES as readonly string[]).includes(s)) : undefined
    const view = await viewOf(c)
    if (q.blueprint) seenSome(view, q.blueprint)
    const filter = parseFilter(q.filter)
    refuseFilter(view, q.blueprint, filter, q.sort)
    if (q.group && q.blueprint) refuseFilter(view, q.blueprint, q.group.startsWith('r:') ? { relation: q.group.slice(2) } : undefined, q.group.startsWith('r:') ? undefined : q.group)
    if (filter) {
      try {
        scorecards.checkLevels(filter, 'filter')
      } catch (error) {
        throw new WriteError(error instanceof Error ? error.message : String(error))
      }
    }
    return { view, states, filter }
  }
  /** Who a listing is kept for: what a person sees is their own, and an admin viewing as someone sees what they see. */
  const listedFor = (c: Context<AppEnv>, view: View) => (view.all ? '*' : c.get('identity').name)

  app.get('/v1/entities', async (c) => {
    const q = c.req.query()
    const limit = Math.min(Number(q.limit ?? 200) || 200, 2000)
    const offset = Math.max(0, Number(q.offset ?? 0) || 0)
    const { view, states, filter } = await listQuery(c, q)
    // A person's stars lead the order of every catalog grid they read; `starred=true` lists only them. A machine has
    // none, and a grid where the person holds none is ordered, and read, as it was before stars.
    const person = personAsking(c)
    const lookups = performance.now()
    const held = person ? await timed('stars.read', () => stars.held(person, q.blueprint)) : null
    const starredOnly = q.starred === 'true'
    const starredBy = person && held && (held.count > 0 || starredOnly) ? person : undefined
    /** Marks the starred rows of a page, and notes on the load ledger what a grid's stars cost, the count above included. */
    const starsOn = async (page: Entity[]) => {
      if (!starredBy || !held?.count) return
      const marked = await annotateStars(starredBy, page)
      if (q.blueprint && blueprints.get(q.blueprint)) deps.load.note('star', q.blueprint, { calls: 1, rows: marked, ms: performance.now() - lookups })
    }
    // A page starts at an offset or after a cursor: a cursor reads none of the rows before it, however deep it is.
    const asked: CursorQuestion = { blueprint: q.blueprint, states, includeHidden: q.hidden === 'true', filter, sort: q.sort, group: q.group || undefined, ...(starredBy ? { starredBy } : {}), ...(starredOnly ? { starredOnly } : {}) }
    if (q.after && offset) throw new WriteError('ask with offset or after, not both')
    const after = q.after ? decodeCursor(asked, q.after) : null
    const cursor = (values: OrderValues | null) => (values ? encodeCursor(asked, values) : null)
    // Named before a row is read: a caller whose copy no blueprint the list reads has moved since is answered with nothing.
    const known = q.blueprint ? reader.known(q.blueprint) : null
    // `incoming=true` names everyone who points at each row; a number names that many under each relation, and counts the rest.
    const most = Number(q.incoming)
    const incoming = q.incoming === 'true' || most > 0
    const reads = known && !(filter && reachesOut(filter)) ? lists.listReads(known, incoming) : null
    const clock = filter && readsNow(filter) ? `\0${Math.floor(Date.now() / CLOCK_MS)}` : ''
    // The reader's stars name the tag too: a star moves the order, so an answer from before it is not this one.
    const starState = held ? `\0${held.stamp}` : ''
    if (unchanged(c, lists.tag(`entities\0${c.get('identity').name}\0${lists.basisOf(view)}\0${new URL(c.req.url).search}${clock}${starState}`, reads))) return c.body(null, 304)
    const fields = named(q.fields)
    const relations = named(q.relations)
    // A grid scrolling one blueprint reads blocks of one kept listing: the rows are filtered, sorted, grouped, and counted once.
    // `distribution=later` reads rows of that listing without waiting for how its columns share out, and `only` reads that alone.
    const shares = q.distribution === 'true' || q.distribution === 'only'
    // Only the stars a grid shapes a listing of: a list of nothing but them is the person's own, and is read whole each time.
    if (q.blueprint && !starredOnly && (shares || q.distribution === 'later' || q.group)) {
      const question = { blueprint: q.blueprint, states, includeHidden: q.hidden === 'true', filter, sort: q.sort, group: q.group || undefined, ...(starredBy ? { starredBy } : {}) }
      // Rows asked without the counts are read beside the listing's count, never after it: a listing built cold costs the slower
      // of the two. A caller who waits for the counts waits for the slowest part anyway, so its rows do not compete with them.
      const read = () => (q.distribution === 'only' ? Promise.resolve({ entities: [], next: null }) : lists.block(question, view, offset, limit, after))
      const [listing, block] = shares ? await lists.get(question, view, listedFor(c, view)).then(async (l) => [l, await read()] as const) : await Promise.all([lists.get(question, view, listedFor(c, view)), read()])
      // A listing given while its next builds is a moment behind the tag named above: the answer carries none, so the next question is answered afresh.
      if (lists.behind(listing)) c.header('etag', undefined)
      const page = await reader.dress(block.entities, { incoming, layers: q.layers === 'true', view, ...(most > 0 ? { peek: { most, whole: reader.peekWhole(q.blueprint, view) } } : {}) })
      await actions.annotate(c.get('identity'), view, page)
      await visibility.annotateEdits(c.get('identity'), view, page)
      await visibility.annotatePeople(view, page)
      await starsOn(page)
      if (most > 0) peek(page, most, reader.wholeIncoming(q.blueprint))
      return c.json({
        entities: page.map((e) => pick(e, fields, relations)),
        total: listing.total,
        limit,
        offset,
        next: cursor(block.next),
        version: listing.version,
        ...(offset === 0 ? { reads: listing.reads } : {}),
        ...(shares ? { distribution: view.distribution(q.blueprint, await listing.distribution) } : {}),
        ...(listing.groups ? { groups: listing.groups } : {}),
      } as EntitiesResponse)
    }
    // A list of one blueprint reads only the links it shows of each relation pointing in; one across blueprints reads them all.
    const peeked = most > 0 && q.blueprint ? { peek: { most, whole: reader.peekWhole(q.blueprint, view) } } : {}
    // What is asked is all that is read, beside the person fields the people a row names are drawn from; `pick` cuts those.
    const only = fields || relations ? { fields: fields ? [...new Set([...fields, ...personFields(q.blueprint)])] : null, relations } : undefined
    const { entities: list, total, next, distribution } = await reader.list({ blueprint: q.blueprint, states, includeHidden: q.hidden === 'true', filter, limit, offset, after, sort: q.sort, ...(starredBy ? { starredBy } : {}), ...(starredOnly ? { starredOnly } : {}), incoming, ...peeked, layers: q.layers === 'true', distribution: q.distribution === 'true', view, ...(only ? { only } : {}) })
    if (most > 0) peek(list, most, q.blueprint ? reader.wholeIncoming(q.blueprint) : new Set())
    await visibility.annotatePeople(view, list)
    await starsOn(list)
    return c.json({ entities: list.map((e) => pick(e, fields, relations)), total, limit, offset, next: cursor(next), ...(distribution ? { distribution } : {}) } as EntitiesResponse)
  })

  /** Every row a filter matches, as references only: what a bulk change reaches when everything is ticked. */
  app.get('/v1/entities/refs', async (c) => {
    const q = c.req.query()
    if (!q.blueprint) throw new WriteError('blueprint is required')
    const { view, states, filter } = await listQuery(c, q)
    const question = { blueprint: q.blueprint, states, includeHidden: q.hidden === 'true', filter }
    const listing = await lists.get(question, view, listedFor(c, view))
    const rows = await reader.sql.refs(lists.params(question), view.all ? ALL : view)
    return c.json({ refs: rows.map((e) => ({ blueprint: e.blueprint, key: e.key })), owners: [...new Set(rows.map((e) => e.owner))], hidden: rows.every((e) => e.hidden), version: listing.version })
  })

  /** What a person owns, worked out once per person until something it is read from moves. */
  const ownedBy = (who: string) => visibility.ownedKept(who)
  app.get('/v1/entities/:blueprint/:key', async (c) => {
    const view = await viewOf(c)
    const read = await reader.get(ref(c), { includeDeleted: c.req.query('deleted') === 'true', most: ENTITY_LINKS })
    const detail = read && view.detail(read)
    if (!detail) return c.json({ error: 'Unknown entity' }, 404)
    const owned = await ownedBy(c.get('identity').name)
    const runnable = { ...detail }
    await actions.annotate(c.get('identity'), view, [runnable])
    await visibility.annotateEdits(c.get('identity'), view, [runnable])
    await visibility.annotatePeople(view, [runnable])
    await annotateStars(personAsking(c) ?? undefined, [runnable])
    const page: EntityPageResponse = { ...detail, actions: runnable.actions ?? [], ...(runnable.editable ? { editable: runnable.editable } : {}), ...(runnable.people ? { people: runnable.people } : {}), ...(runnable.starred ? { starred: true } : {}), yours: owned.state === 'known' && owned.ids.has(detail.id), yoursAs: owned.state === 'known' ? (owned.ids.get(detail.id) ?? []) : [], checks: view.checks(await checksFor(detail)), alerts: (await alerts.byEntity([detail])).get(detail.id) ?? [], scorecards: view.all ? scorecards.forEntity(detail) : scorecards.forEntity(detail).filter((s) => scorecardSeen(view, s.scorecard)) }
    if (c.req.query('provenance') === 'true') return c.json(page)
    const { provenance: _p, ...rest } = page
    return c.json(rest)
  })
  const checksFor = async (e: { id: string; title: string; blueprint: string; key: string }): Promise<AssignedCheckView[]> => {
    const assigned = await checks.all(false, e)
    if (!assigned.length) return []
    const results = (await checks.results([e])).get(e.id) ?? []
    return assigned.map((a) => ({ entity: a.entity, title: e.title, field: a.field, check: a.check, results: results.filter((r) => r.field === a.field) }))
  }

  app.get('/v1/entities/:blueprint/:key/related', async (c) => {
    const direction = (c.req.query('direction') ?? 'both') as 'in' | 'out' | 'both'
    const depth = Math.min(Number(c.req.query('depth') ?? 1) || 1, 4)
    const only = c.req.query('blueprints')?.split(',').filter(Boolean)
    const view = await viewOf(c)
    const exists = await reader.get(ref(c))
    if (!exists || !view.seesEntity(exists)) return c.json({ error: 'Unknown entity' }, 404)
    // A walk does not pass through what the reader may not see, so nothing beyond it is reached either.
    const result = await reader.related(ref(c), direction, depth, only, (id) => view.seesBlueprint(id))
    return c.json({ root: ref(c), nodes: view.entities(result.nodes), edges: result.edges })
  })

  // The wall and the summary read the whole estate: each is built once per reader and kept until the hub changes.
  // What every reader's wall and summary are cut from, built once for them all.
  const wallRows = () => lists.recent('wall', EVERYONE, WHOLE, () => wallOfEstate(reader, blueprints), { ages: false, reads: (rows) => rows.keys() })
  const counts = () => lists.recent('counts', EVERYONE, WHOLE, () => estateCounts(db))
  app.get('/v1/wall', async (c) => {
    const view = await viewOf(c)
    const answer = await lists.recent('wall', listedFor(c, view), view.basis, async () => wall(await wallRows(), blueprints, sources, view))
    return unchanged(c, lists.tagOf(`wall\0${listedFor(c, view)}`, answer)) ? c.body(null, 304) : c.json(answer)
  })
  app.get('/v1/summary', async (c) => {
    const view = await viewOf(c)
    const answer = await lists.recent('summary', listedFor(c, view), view.basis, async () => summary(reader, blueprints, sources, findings, alerts, view, await counts()))
    return unchanged(c, lists.tagOf(`summary\0${listedFor(c, view)}`, answer)) ? c.body(null, 304) : c.json(answer)
  })
  app.get('/v1/mine', async (c) => {
    const view = await viewOf(c)
    const who = c.get('identity').name
    // Kept while nothing of theirs moves, and nothing that decides what is theirs: never rebuilt for a move elsewhere.
    // A page that marks what is the reader's from the alerts, findings, and scorecards themselves needs only what is not green, and
    // a person may own thousands of green things: those are counted and never read.
    const green = c.req.query('green') !== 'false'
    // One kind of theirs, green ones too, read when a person opens it: the front page never reads every green thing.
    const kind = c.req.query('blueprint')
    const what = kind ? `mine.kind\0${kind}` : green ? 'mine' : 'mine.unwell'
    const mine = await lists.recent(what, who, view.basis, async () => yours(reader, view, await ownedBy(who), { green, ...(kind ? { kind } : {}) }), { ages: false, reads: (m) => [...visibility.ownedReads(), ...Object.keys(m.blueprints)] })
    if (unchanged(c, lists.tagOf(`${what}\0${who}\0${green}`, mine))) return c.body(null, 304)
    return c.json(mine)
  })

  // What the caller could fill in on their own things: the empty values of the fields an edit rule opens to them as an owner.
  app.get('/v1/mine/fill', async (c) => {
    const id = c.get('identity')
    const none: MineFillResponse = { fill: [] }
    const editor = id.admin ? null : await visibility.editor(id)
    if (!editor?.any) return c.json(none)
    const owned = await ownedBy(id.name)
    if (owned.state !== 'known') return c.json(none)
    const view = await viewOf(c)
    const refs = new Map<string, EntityRef[]>()
    for (const owner of owned.ids.keys()) {
      const at = parseEntityId(owner)
      if (!at) continue
      const list = refs.get(at.blueprint) ?? []
      if (list.length < FILL_READS) list.push(at)
      refs.set(at.blueprint, list)
    }
    const fill: MineFillResponse['fill'] = []
    for (const [blueprint, list] of refs) {
      const bp = blueprints.get(blueprint)
      if (!bp || !view.seesSome(blueprint) || !editor.reach(blueprint).some((r) => r.how === 'owner' && r.fields.length)) continue
      const hidden = view.hiddenFields(blueprint)
      const empty = new Map<string, number>()
      for (const e of view.entities(await reader.hydrated(list))) {
        for (const name of editor.opens(e).fields) {
          if (!bp.fields[name] || hidden.has(name) || !blank(e.fields[name])) continue
          empty.set(name, (empty.get(name) ?? 0) + 1)
        }
      }
      for (const [field, count] of empty) fill.push({ blueprint, field, title: bp.fields[field]!.title ?? field, count })
    }
    fill.sort((a, b) => b.count - a.count || a.blueprint.localeCompare(b.blueprint) || a.field.localeCompare(b.field))
    return c.json({ fill } satisfies MineFillResponse)
  })

  // A person's pins: theirs alone to keep, so no permission opens them and no activity row is written. A personal token is
  // the person; a machine keeps none. An admin viewing as someone reads that person's pins and, as with every write, changes none.
  /** The person a request is theirs: a signed-in person, or a personal token. A machine keeps no pins, stars, or preferences. */
  const personAsking = (c: Context<AppEnv>) => {
    const id = c.get('identity')
    return id.kind === 'user' ? id.name : null
  }
  /** Who a person is in the estate, as they see it: their entity's name and the picture it shows, their photo, and their pick. */
  const myPerson = async (c: Context<AppEnv>, address: string): Promise<MyPerson> => {
    const ref = await visibility.personOf(address)
    const own = pictures.ofAddress(address)
    if (!ref || !(await viewOf(c)).seesEntity(ref)) return { entity: null, title: null, icon: own.pick ?? own.photo, ...own }
    const head = (await reader.headsOf([ref])).get(entityId(ref))
    return { entity: ref, title: head?.title ?? null, icon: own.pick ?? own.photo ?? head?.icon ?? null, ...own }
  }
  const noPins = (c: Context<AppEnv>) => {
    recordRefusal('permission')
    log.info('pins refused: not a person', { actor: c.get('identity').name, kind: c.get('identity').kind, method: c.req.method })
    return c.json({ error: 'Pins are for a person: a machine keeps none' }, 403)
  }
  /** The ids of the actions the caller is offered today: those they see and may run, and for a holder of `actions.manage` the rest. */
  const offeredActions = async (c: Context<AppEnv>) => new Set((await actions.offered(c.get('identity'), await viewOf(c))).map((o) => o.action.id))
  /** Whether a pin names what the caller may use today: an action offered to them, or a blueprint they see some of. */
  const pinUsable = async (c: Context<AppEnv>, held: readonly Pin[]): Promise<(p: Pin) => boolean> => {
    const offered = held.some((p) => p.kind === 'action') ? await offeredActions(c) : new Set<string>()
    const view = held.some((p) => p.kind === 'blueprint') ? await viewOf(c) : null
    return (p) => (p.kind === 'action' ? offered.has(p.id) : !!blueprints.get(p.id) && !!view?.seesSome(p.id))
  }
  /** A person's pins to what they may use today. The others are kept and show again when what they point at is theirs again. */
  const pinsShown = async (c: Context<AppEnv>, who: string): Promise<PinsResponse> => {
    const held = await pins.of(who)
    const usable = await pinUsable(c, held)
    return { pins: held.filter(usable) }
  }
  /** The usage event a pin or an unpin sends, by its kind. */
  const pinEvent = (pin: Pin, on: boolean, by: Identity): [string, Identity, Record<string, string>] => (pin.kind === 'action' ? [on ? ACTION_PINNED : ACTION_UNPINNED, by, { action: pin.id }] : [on ? BLUEPRINT_PINNED : BLUEPRINT_UNPINNED, by, { blueprint: pin.id }])
  const pinNamed = (c: Context<AppEnv>): Pin | null => {
    const kind = c.req.param('kind')
    return isPinKind(kind) ? { kind, id: c.req.param('id')! } : null
  }
  // The approvals that wait for the caller in the estate's approvals blueprint, of every system that writes there.
  app.get('/v1/mine/approvals', async (c) => c.json((await approvals.waitingFor(c.get('identity'), await viewOf(c))) satisfies MyApprovals))
  // The picture a person shows everyone in place of their photo, or null for their photo again: theirs alone to pick.
  app.put('/v1/mine/picture', async (c) => {
    const who = personAsking(c)
    if (!who) {
      recordRefusal('permission')
      log.info('picture refused: not a person', { actor: c.get('identity').name, kind: c.get('identity').kind })
      return c.json({ error: 'Only a person picks their picture' }, 403)
    }
    const { icon } = z.object({ icon: z.string().min(1).nullable() }).parse(await c.req.json())
    await pictures.pick(who, icon)
    return c.json(await myPerson(c, who))
  })
  app.get('/v1/mine/pins', async (c) => {
    const who = personAsking(c)
    return who ? c.json(await pinsShown(c, who)) : noPins(c)
  })
  app.put('/v1/mine/pins', async (c) => {
    const who = personAsking(c)
    if (!who) return noPins(c)
    await pins.order(who, pinsOrderSchema.parse(await c.req.json()).order)
    return c.json(await pinsShown(c, who))
  })
  app.put('/v1/mine/pins/:kind/:id', async (c) => {
    const who = personAsking(c)
    if (!who) return noPins(c)
    const pin = pinNamed(c)
    if (!pin) return c.json({ error: `Nothing of kind "${c.req.param('kind')}" can be pinned` }, 404)
    if (!(await pinUsable(c, [pin]))(pin)) throw new Hidden(`Unknown ${pin.kind} "${pin.id}"`)
    if (await pins.add(who, pin)) sendUsage(...pinEvent(pin, true, c.get('identity')))
    return c.json(await pinsShown(c, who))
  })
  app.delete('/v1/mine/pins/:kind/:id', async (c) => {
    const who = personAsking(c)
    if (!who) return noPins(c)
    const pin = pinNamed(c)
    if (!pin) return c.json({ error: `Nothing of kind "${c.req.param('kind')}" can be pinned` }, 404)
    if (await pins.remove(who, pin)) sendUsage(...pinEvent(pin, false, c.get('identity')))
    return c.json(await pinsShown(c, who))
  })

  // A person's stars: theirs alone, as their pins are, so no permission opens them and no activity row is written. They
  // lead every catalog grid the person reads and fill their favorites page; a query and a report never read them.
  const noStars = (c: Context<AppEnv>) => {
    recordRefusal('permission')
    log.info('stars refused: not a person', { actor: c.get('identity').name, kind: c.get('identity').kind, method: c.req.method })
    return c.json({ error: 'Stars are for a person: a machine keeps none' }, 403)
  }
  /** What a person starred that they may see today, newest first. The rest are kept, never shown or counted, and show again when they may. */
  const starsSeen = async (who: string, view: View): Promise<Entity[]> => {
    const held = await stars.of(who)
    const shown = view.all ? await reader.hydrated(held) : view.entities(await reader.hydrated(held.filter((r) => view.seesSome(r.blueprint))))
    const order = new Map(held.map((r, i) => [`${r.blueprint}:${r.key}`, i]))
    return shown.sort((a, b) => order.get(a.id)! - order.get(b.id)!)
  }
  app.get('/v1/mine/stars', async (c) => {
    const who = personAsking(c)
    if (!who) return noStars(c)
    const seen = await starsSeen(who, await viewOf(c))
    return c.json({ stars: seen.map((e) => ({ blueprint: e.blueprint, key: e.key })) } satisfies StarsResponse)
  })
  // The favorites page: one table of everything the person starred and may see, every blueprint's fields and relations
  // a column, read through their view as any table of the catalog is. Their stars only pick the rows: the query code
  // that reads them is given each blueprint's keys, and knows nothing of stars.
  app.get('/v1/mine/stars/table', async (c) => {
    const who = personAsking(c)
    if (!who) return noStars(c)
    const view = await viewOf(c)
    const seen = await starsSeen(who, view)
    const byKind = Map.groupBy(seen, (e) => e.blueprint)
    const sources = [...byKind].map(([blueprint, list]) => ({ blueprint, filter: { field: '$key', op: 'in' as const, value: list.map((e) => e.key) }, states: [...ENTITY_STATES] }))
    const kinds = [...byKind.keys()].flatMap((id) => blueprints.get(id) ?? [])
    const columns = [...new Set(['$type', 'title', ...kinds.flatMap((bp) => [...Object.keys(bp.fields).filter((f) => f !== 'title' && f !== 'icon'), ...Object.keys(bp.relations).map((r) => `r:${r}`)]), '$status', '$state', '$updatedAt'])]
    return c.json(await queries.run(sources, columns, view, c.get('identity')))
  })
  app.put('/v1/mine/stars/:blueprint/:key', async (c) => {
    const who = personAsking(c)
    if (!who) return noStars(c)
    const at = ref(c)
    const view = await viewOf(c)
    const exists = await reader.get(at, { includeDeleted: true })
    if (!exists || !view.seesEntity(exists)) throw new Hidden(`Unknown entity "${at.blueprint}:${at.key}"`)
    if (await stars.add(who, at)) {
      sendUsage(ENTITY_STARRED, c.get('identity'), { blueprint: at.blueprint })
      log.info('entity starred', { person: who, blueprint: at.blueprint })
    }
    return c.json({ starred: true } satisfies StarResponse)
  })
  app.delete('/v1/mine/stars/:blueprint/:key', async (c) => {
    const who = personAsking(c)
    if (!who) return noStars(c)
    const at = ref(c)
    if (await stars.remove(who, at)) {
      sendUsage(ENTITY_UNSTARRED, c.get('identity'), { blueprint: at.blueprint })
      log.info('entity unstarred', { person: who, blueprint: at.blueprint })
    }
    return c.json({ starred: false } satisfies StarResponse)
  })

  // A person's preferences: theirs alone, as their pins are, so no permission opens them and no activity row is written.
  // Each name and the values it takes are in src/shared/preferences.ts. An admin viewing as someone reads theirs and sets none.
  const noPreferences = (c: Context<AppEnv>) => {
    recordRefusal('permission')
    log.info('preferences refused: not a person', { actor: c.get('identity').name, kind: c.get('identity').kind, method: c.req.method })
    return c.json({ error: 'Preferences are for a person: a machine keeps none' }, 403)
  }
  app.get('/v1/mine/preferences', async (c) => {
    const who = personAsking(c)
    return who ? c.json({ preferences: await deps.preferences.of(who) } satisfies { preferences: PreferenceValues }) : noPreferences(c)
  })
  app.put('/v1/mine/preferences/:name', async (c) => {
    const who = personAsking(c)
    if (!who) return noPreferences(c)
    const name = c.req.param('name')
    if (!isPreferenceName(name)) return c.json({ error: `No preference is named "${name}"` }, 404)
    const body = z.object({ value: z.unknown() }).parse(await c.req.json())
    await deps.preferences.set(who, name, body.value)
    return c.json({ preferences: await deps.preferences.of(who) } satisfies { preferences: PreferenceValues })
  })

  // The welcome tour is a preview: to a caller it is not open to, it is not there.
  const inWelcome = async (c: Context<AppEnv>, next: () => Promise<void>) => {
    const identity = c.get('identity')
    if (!deps.previews.open('welcome', identity)) {
      log.debug('welcome tour not shown: the caller is outside its preview', { actor: identity.name })
      return c.json({ error: 'Not found' }, 404)
    }
    return next()
  }
  app.use('/v1/welcome', inWelcome)
  app.use('/v1/access/welcome', inWelcome)
  /** The estate's picks as this reader sees them. A pick they may not see, or none, falls back to the first of its kind they may. */
  const welcomeFound = async (c: Context<AppEnv>, def: WelcomeDef): Promise<WelcomeFound> => {
    const view = await viewOf(c)
    const hidden = new Set(blueprints.layout().hidden)
    const seen = blueprints.list().filter((bp) => view.seesBlueprint(bp.id) && !bp.id.startsWith(RESERVED_PREFIX))
    const picked = seen.find((bp) => bp.id === def.blueprint)
    const bp = picked ?? seen.find((b) => !hidden.has(b.id)) ?? null
    const read = picked && def.example ? await reader.get({ blueprint: picked.id, key: def.example }) : null
    const example = read && view.entity(read)
    const offered = await actions.offered(c.get('identity'), view)
    // The tour shows the self-service page, where the hub's own actions are no tile: each is offered where its thing is shown.
    const runs = offered.filter((o) => o.canRun && o.action.origin.kind !== 'hub')
    const action = (def.actions ?? []).map((id) => runs.find((o) => o.action.id === id)).find((o) => !!o) ?? runs[0] ?? null
    log.debug('welcome tour built', { actor: c.get('identity').name, blueprint: bp?.id ?? null, picked: !!picked, example: !!example, action: action?.action.id ?? null })
    return { blueprint: bp && { id: bp.id, title: bp.title }, example: example ? { key: example.key, title: example.title } : null, action: action && { id: action.action.id, title: action.action.title } }
  }
  app.get('/v1/welcome', async (c) => {
    const def = deps.welcome.get()
    return c.json(buildTour(def, await welcomeFound(c, def)) satisfies WelcomeResponse)
  })
  /**
   * Marks each item that touches something the reader owns, so a page never
   * holds everything they own to work it out. Nothing is marked when the hub
   * does not know what they own.
   */
  const markYours = async <T extends object>(c: Context<AppEnv>, items: T[], refs: (item: T) => (EntityRef | null | undefined)[]): Promise<(T & { yours?: boolean })[]> => {
    const owned = await ownedBy(c.get('identity').name)
    if (owned.state !== 'known') return items
    return items.map((item) => ({ ...item, yours: refs(item).some((r) => !!r && owned.ids.has(entityId(r))) }))
  }
  app.get('/v1/findings', async (c) => {
    const view = await viewOf(c)
    const who = c.get('identity').name
    const [found, owned] = await Promise.all([findings.list(), ownedBy(who)])
    if (unchanged(c, lists.tagOf(`findings\0${who}\0${lists.numberOf(view.basis)}\0${lists.numberOf(owned)}`, found))) return c.body(null, 304)
    return c.json({ findings: await markYours(c, view.findings(found), (f) => [f.entity, f.target, ...(f.entities ?? [])]) } satisfies FindingsResponse)
  })

  // What costs the hub: it names every caller, as the activity log does, so it takes the same permission.
  const loadOver = async (hours: number): Promise<LoadResponse> => {
    const { sinceAt, ...read } = await deps.load.read(hours)
    const [use, columns, held, kept] = await Promise.all([deps.budgets.use(sinceAt), deps.cardinality.read(), deps.runs.held(deps.config.TOMBSTONE_DAYS), stars.kept()])
    return { ...read, stars: starsLoad(read.stars, kept), budgets: deps.budgets.get(), use, columns, held }
  }
  // Every budget is sent each time: one left out is one no longer held.
  const setBudgets = async (given: unknown): Promise<BudgetSet> => {
    const next = await deps.budgets.save(given)
    deps.lists.moved(null)
    return next
  }
  app.get('/v1/load', allow('audit.view'), async (c) => c.json(await loadOver(Number(c.req.query('hours') ?? 24))))
  app.get('/v1/budgets', allow('audit.view'), (c) => c.json(deps.budgets.get() satisfies BudgetSet))
  app.put('/v1/budgets', allow('budgets.set', 'budgets.changed'), async (c) => {
    const next = await setBudgets(await c.req.json())
    c.set('audit', { budgets: next })
    return c.json(next)
  })

  app.get('/v1/changes', allow('audit.view'), async (c) => {
    const limit = Math.min(Number(c.req.query('limit') ?? 100) || 100, 1000)
    const view = await viewOf(c)
    const changes = view.changes(await listActivity(db, { ...c.req.query(), limit }))
    const page = { changes, nextSince: changes[0]?.at ?? null, nextBefore: changes.length === limit ? changes.at(-1)!.id : null }
    if (c.req.query('fold') !== 'batches') return c.json(page satisfies ChangesResponse)
    // A folded log names each batch by the row that asked it, and says how the batch stands now.
    const ids = changes.flatMap((ch) => (ch.kind === BATCH_ROW && typeof ch.detail.batch === 'string' ? [ch.detail.batch] : []))
    return c.json({ ...page, batches: await batches.summaries(ids, c.get('identity'), view) } satisfies ChangesResponse)
  })

  /** A scorecard is seen with its blueprint, and only when no rule reads what the reader may not see: a pass or a fail would tell them the value. */
  const scorecardSeen = (view: View, id: string): boolean => {
    const sc = scorecards.get(id)
    if (!sc) return false
    if (view.all) return true
    return partsOf(sc).every((part) => view.seesBlueprint(part.blueprint) && partFilters(part).every((f) => !view.refusedFilter(part.blueprint, f)))
  }
  app.get('/v1/scorecards', async (c) => {
    const view = await viewOf(c)
    return c.json({ scorecards: scorecards.list().filter((s) => scorecardSeen(view, s.id)) })
  })
  app.get('/v1/scorecards/:id/results', async (c) => {
    const view = await viewOf(c)
    if (!scorecardSeen(view, c.req.param('id'))) return c.json({ error: 'Unknown scorecard' }, 404)
    const results = await scorecards.results(c.req.param('id'))
    return c.json({ ...results, rows: await markYours(c, results.rows, (r) => [r.entity]) } satisfies ScorecardResults)
  })
  app.get('/v1/scorecards/:id/trend', async (c) => {
    const view = await viewOf(c)
    if (!scorecardSeen(view, c.req.param('id'))) return c.json({ error: 'Unknown scorecard' }, 404)
    return c.json(await scorecards.trend(c.req.param('id'), Math.min(Number(c.req.query('days') ?? 30) || 30, 365)))
  })
  app.get('/v1/alerts', async (c) => c.json({ alerts: await markYours(c, (await viewOf(c)).alerts(await alerts.list()), (a) => [a.entity]) }))
  app.get('/v1/alert-rules', async (c) => {
    const view = await viewOf(c)
    return c.json({ rules: alerts.listRules().filter((r) => view.seesBlueprint(r.blueprint)) })
  })
  app.get('/v1/checks', async (c) => {
    const all = await checks.all()
    const results = await checks.results()
    const titles = new Map((await reader.rowsFor(all.map((a) => a.entity))).map((r) => [`${r.blueprint}:${r.key}`, r.title]))
    const view = await viewOf(c)
    return c.json({ checks: view.checks(all.map((a) => ({ entity: a.entity, title: titles.get(entityId(a.entity)) ?? a.entity.key, field: a.field, check: a.check, results: (results.get(entityId(a.entity)) ?? []).filter((r) => r.field === a.field) })) satisfies AssignedCheckView[]) })
  })
  // A blueprint without a position gets one here, once, so every reader sees the same arrangement. A hidden one is
  // placed too, so a reader may show it for themselves. A layout an older generation placed is laid out again, whole, once.
  // A reader is answered only the blueprints they may see.
  const modelLayoutFor = (layout: ModelLayout, view: View): ModelLayout => ({
    ...layout,
    positions: Object.fromEntries(Object.entries(layout.positions).filter(([id]) => view.seesBlueprint(id))),
    hidden: layout.hidden.filter((id) => view.seesBlueprint(id)),
  })
  app.get('/v1/model/layout', async (c) => {
    const row = await db.query<{ value: ModelLayout }>(`SELECT value FROM settings WHERE key = 'model.layout'`)
    const stored: ModelLayout = row.rows[0]?.value ?? { positions: {}, hidden: [] }
    const stale = Object.keys(stored.positions).length > 0 && stored.generation !== MODEL_LAYOUT_GENERATION
    if (stale) log.info('model layout is from an older generation; laying it out again', { stored: stored.generation ?? null, current: MODEL_LAYOUT_GENERATION })
    const cur: ModelLayout = stale ? { ...stored, positions: {} } : stored
    const view = await viewOf(c)
    const placed = await placeAll(blueprints.list().filter((bp) => view.seesBlueprint(bp.id)), cur.hidden, cur.positions, log)
    if (!Object.keys(placed).length && !stale) return c.json(modelLayoutFor(cur, view))
    const next: ModelLayout = { ...cur, positions: { ...cur.positions, ...placed }, generation: MODEL_LAYOUT_GENERATION }
    await db.query(`INSERT INTO settings (key, value) VALUES ('model.layout', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(next)])
    return c.json(modelLayoutFor(next, view))
  })
  app.get('/v1/sources', (c) => c.json({ sources: sources.list() }))
  app.get('/v1/sources/:id', async (c) => {
    const s = sources.get(c.req.param('id'))
    if (!s) return c.json({ error: 'Unknown source' }, 404)
    return c.json({ source: s, runs: await runs.listForSource(s.id) })
  })
  app.get('/v1/runs', async (c) => c.json({ runs: await runs.listRecent() }))
  app.get('/v1/rules', async (c) => {
    const view = await viewOf(c)
    return c.json({ rules: rules.list().filter((r) => view.seesBlueprint(r.blueprint) && view.seesBlueprint(r.match.target)) })
  })
  app.get('/v1/grid/:blueprint', async (c) => {
    const view = await viewOf(c)
    seenSome(view, c.req.param('blueprint'))
    return c.json(gridSeen(view, c.req.param('blueprint'), await gridOf(c.req.param('blueprint'))))
  })
  app.get('/v1/grid-standard', (c) => c.json(standards.get()))
  app.get('/v1/conventions', (c) => c.json(conventions.get()))

  app.get('/v1/export', async (c) => {
    const q = c.req.query()
    const view = await viewOf(c)
    if (q.blueprint) seen(view, q.blueprint)
    const params: unknown[] = []
    const where: string[] = [`state <> 'deleted'`]
    if (q.blueprint) {
      params.push(q.blueprint)
      where.push(`blueprint = $${params.length}`)
    }
    if (q.key) {
      params.push(q.key)
      where.push(`key = $${params.length}`)
    }
    const rows = await db.query<EntityRow>(`SELECT * FROM entities WHERE ${where.join(' AND ')} ORDER BY blueprint, key`, params)
    const out: unknown[] = []
    for (const row of rows.rows) {
      if (!view.seesBlueprint(row.blueprint)) continue
      const hidden = view.hiddenFields(row.blueprint)
      const layers = layersOf(row)
      const authored = row.owner === 'ui' || Object.keys(layers.ui).length || Object.keys(layers.override).length
      if (q.scope !== 'all' && !authored) continue
      const fields: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(layers.ui)) fields[k] = v.value
      for (const [k, v] of Object.entries(layers.override)) fields[k] = v.value
      if (q.scope === 'all') for (const [k, v] of Object.entries(layers.pushed)) fields[k] ??= v.value
      const rels = await db.query<{ relation: string; target_blueprint: string; target_key: string }>(`SELECT relation, target_blueprint, target_key FROM relations WHERE blueprint = $1 AND key = $2 AND layer = 'ui'`, [row.blueprint, row.key])
      const relations: Record<string, string[]> = {}
      for (const r of rels.rows) relations[r.relation] = [...(relations[r.relation] ?? []), `${r.target_blueprint}:${r.target_key}`]
      for (const name of hidden) delete fields[name]
      for (const name of Object.keys(relations)) {
        const target = blueprints.get(row.blueprint)?.relations[name]?.target
        if (target && !view.seesBlueprint(target)) delete relations[name]
      }
      const { title, icon, ...rest } = fields
      out.push({ blueprint: row.blueprint, key: row.key, title: title ?? row.title, ...(icon ? { icon } : {}), fields: rest, ...(Object.keys(relations).length ? { relations } : {}) })
    }
    c.header('content-type', 'application/yaml; charset=utf-8')
    c.header('content-disposition', `attachment; filename="orrery-${q.blueprint ?? 'export'}.yaml"`)
    return c.body(toYaml({ entities: out }))
  })

  app.get('/v1/events', async (c) => {
    const identity = c.get('identity')
    return streamSSE(c, async (stream) => {
      let id = 0
      const unsubscribe = events.subscribe((event) => {
        void (async () => {
          // The model changes what a person may see, so it is asked again for every event, not once for the stream.
          if (event.type === 'entity' && !(await visibility.view(identity)).seesEntity(event)) return
          await stream.writeSSE({ event: event.type, data: JSON.stringify(event), id: String(id++) })
        })()
      })
      const keepAlive = setInterval(() => void stream.writeSSE({ event: 'ping', data: '' }), 25_000)
      let stopEnd = () => {}
      stream.onAbort(() => {
        unsubscribe()
        stopEnd()
        clearInterval(keepAlive)
      })
      // The hub's version first, so a browser that reconnects after a release knows it is talking to a new hub.
      const hello: StreamHello = { version: deps.version }
      await stream.writeSSE({ event: 'hello', data: JSON.stringify(hello) })
      await new Promise<void>((resolveWait) => {
        stream.onAbort(resolveWait)
        stopEnd = events.onEnd(resolveWait)
      })
      unsubscribe()
      stopEnd()
      clearInterval(keepAlive)
    })
  })

  // Entities -------------------------------------------------------------------

  const edit = (kind: 'entity.created' | 'entity.updated' | 'entity.deleted' | 'entity.hidden') => allow('entities.edit', kind, { deep: true })
  /** The entity as the caller now sees it. */
  const answer = async (c: Context<AppEnv>, at: EntityRef) => {
    const read = await reader.get(at)
    return read && (await viewOf(c)).detail(read)
  }
  app.post('/v1/entities', edit('entity.created'), async (c) => {
    const input = writeInputSchema.parse(await c.req.json())
    await mayChange(c, [input], input)
    await entities.createFromUi(input, actor(c))
    runs.relink()
    return c.json(await answer(c, input), 201)
  })
  app.patch('/v1/entities/:blueprint/:key', allow(null, 'entity.updated', { deep: true }), async (c) => {
    const patch = uiPatchSchema.parse(await c.req.json())
    const how = await editing(c, [ref(c)], patch)
    if (how.refused.length) throw new AdminOnly(how.refused[0]!.reason)
    await entities.editFromUi(ref(c), patch, actor(c), how.authored(ref(c)))
    // What everything beneath it inherits is linked again after the answer, never before it.
    runs.relink()
    return c.json(await answer(c, ref(c)))
  })
  /** The rows a bulk change reaches: those named, or every row a filter matches but the ones left out. */
  const reached = async (c: Context<AppEnv>, input: z.infer<typeof targetSchema>): Promise<EntityRef[]> => {
    if (input.entities) return input.entities
    const q = input.query!
    const { view, states, filter } = await listQuery(c, { blueprint: q.blueprint, state: q.states?.join(','), filter: q.filter ? JSON.stringify(q.filter) : undefined, hidden: q.hidden ? 'true' : undefined })
    const rows = await reader.sql.refs(lists.params({ blueprint: q.blueprint, states, includeHidden: q.hidden, filter }), view.all ? ALL : view)
    const except = new Set((q.except ?? []).map(entityId))
    const refs = rows.filter((e) => !except.has(entityId(e))).map((e) => ({ blueprint: e.blueprint, key: e.key }))
    log.info('bulk change reaches every matching row', { blueprint: q.blueprint, rows: refs.length, leftOut: except.size })
    return refs
  }
  app.post('/v1/entities/bulk', allow(null, 'entity.updated', { deep: true }), async (c) => {
    const { entities: named, query, ...change } = bulkSchema.parse(await c.req.json())
    // Hiding an entity is no value of it: no edit rule opens that.
    if (change.hidden !== undefined && !can(c.get('identity'), 'entities.edit')) throw new AdminOnly(`Hiding an entity needs the "entities.edit" permission`)
    const refs = await reached(c, { entities: named, query })
    if (!refs.length) return c.json({ changed: 0, refused: [] })
    const how = await editing(c, refs, change)
    const turned = new Set(how.refused.map(entityId))
    const result = await entities.editManyFromUi(refs.filter((r) => !turned.has(entityId(r))), change, actor(c), how.authored)
    runs.relink()
    return c.json({ changed: result.changed, refused: [...how.refused, ...result.refused] } satisfies BulkEditResponse)
  })
  /** Deletes many rows a person made here at once: those named, or every one a filter matches. A row a source owns is refused, never deleted. */
  app.post('/v1/entities/delete', edit('entity.deleted'), async (c) => {
    const refs = await reached(c, targetSchema.parse(await c.req.json()))
    await mayChange(c, refs)
    const refused: BulkEditResponse['refused'] = []
    let deleted = 0
    for (const ref of refs) {
      try {
        await entities.deleteFromUi(ref, actor(c))
        deleted++
      } catch (error) {
        if (!(error instanceof WriteError)) throw error
        refused.push({ ...ref, reason: error.message })
      }
    }
    return c.json({ changed: deleted, refused } satisfies BulkEditResponse)
  })
  app.delete('/v1/entities/:blueprint/:key', edit('entity.deleted'), async (c) => {
    await mayChange(c, [ref(c)])
    await entities.deleteFromUi(ref(c), actor(c))
    return c.json({ ok: true })
  })
  app.put('/v1/entities/:blueprint/:key/hidden', edit('entity.hidden'), async (c) => {
    const { hidden } = z.object({ hidden: z.boolean() }).parse(await c.req.json())
    await mayChange(c, [ref(c)])
    await entities.setHidden(ref(c), hidden, actor(c))
    return c.json(await answer(c, ref(c)))
  })
  app.post('/v1/entities/:blueprint/:key/cleanup', edit('entity.updated'), async (c) => {
    await mayChange(c, [ref(c)])
    return c.json(await entities.cleanupShadowed(ref(c), actor(c)))
  })
  app.post('/v1/findings/delete-now', edit('entity.deleted'), async (c) => {
    const { entities: refs } = z.object({ entities: z.array(z.object({ blueprint: z.string(), key: z.string() })).min(1).max(5000) }).parse(await c.req.json())
    await mayChange(c, refs)
    await entities.tombstone(refs, 'ui', actor(c), { reason: 'delete now from a mass-drop finding' }, false)
    return c.json({ deleted: refs.length })
  })

  // Views ----------------------------------------------------------------------

  app.put('/v1/grid/:blueprint', allow('views.arrange', 'grid.arranged'), async (c) => {
    const blueprint = c.req.param('blueprint')
    const view = await viewOf(c)
    seen(view, blueprint)
    const patch = gridSchema.parse(await c.req.json())
    const hidden = patch.filter?.find((clause) => unseen(view, blueprint, clause.field))
    if (hidden) throw new Hidden(`The filter reads "${hidden.field}", which you cannot see`)
    refuseFilter(view, blueprint, undefined, patch.sort)
    const kept = await gridOf(blueprint)
    // The caller was never shown the conditions on fields they may not see, so a filter they save keeps them.
    const layout: GridLayout = { ...kept, ...patch, ...(patch.filter ? { filter: [...patch.filter, ...(kept.filter ?? []).filter((clause) => unseen(view, blueprint, clause.field))] } : {}) }
    await db.query('INSERT INTO grid_layouts (blueprint, layout) VALUES ($1, $2) ON CONFLICT (blueprint) DO UPDATE SET layout = EXCLUDED.layout', [blueprint, JSON.stringify(layout)])
    c.set('audit', { ...(patch.columns ? { columns: patch.columns.length, hidden: patch.columns.filter((col) => col.hidden).map((col) => col.id) } : {}), ...(patch.filter ? { filter: patch.filter } : {}), ...(patch.sort ? { sort: patch.sort } : {}) })
    return c.json(gridSeen(view, blueprint, layout))
  })
  // The column standard every grid opens with. A git source that declares it owns it.
  app.put('/v1/grid-standard', allow('views.arrange', 'grid.standard', { deep: true }), async (c) => {
    const saved = await standards.set(await c.req.json())
    events.emit({ type: 'blueprints' })
    return c.json(saved)
  })
  // The relations every blueprint of some groups names, each a finding where one falls short. A git source that declares them owns them.
  app.put('/v1/conventions', allow('model.edit', 'model.conventions', { deep: true }), async (c) => {
    const saved = await conventions.set(await c.req.json())
    events.emit({ type: 'blueprints' })
    return c.json(saved)
  })
  // The order of the groups and of the blueprints inside them, which groups start closed, and which blueprints are hidden, is one shared view of the catalog, the same for everyone.
  app.put('/v1/catalog/layout', allow('catalog.organize', 'catalog.ordered', { deep: true }), async (c) => {
    const names = z.array(z.string().min(1)).max(500)
    const patch = z.object({ order: names.optional(), closed: names.optional(), blueprints: z.record(z.string(), names).optional(), hidden: names.optional() }).parse(await c.req.json())
    // A person orders one group at a time, so the groups the patch does not name keep their order.
    const saved = await blueprints.setLayout({ ...patch, ...(patch.blueprints ? { blueprints: { ...blueprints.layout().blueprints, ...patch.blueprints } } : {}) }, null)
    events.emit({ type: 'blueprints' })
    return c.json(saved)
  })

  // Model ----------------------------------------------------------------------

  // Every change to the model goes through `modelEdits`: the model page, these routes, and an agent's tools alike.
  const model = (kind: 'blueprint.changed' | 'rule.changed' | 'scorecard.changed' | 'alert_rule.changed') => allow('model.edit', kind, { deep: true })
  const caller = async (c: Context<AppEnv>): Promise<Caller> => ({ name: actor(c), view: await viewOf(c) })
  const patchOf = async (c: Context<AppEnv>) => z.record(z.string(), z.unknown()).parse(await c.req.json())
  app.get('/v1/model/export', async (c) => {
    const file = modelEdits.model(await caller(c), c.req.query('blueprint') || undefined)
    log.info('model exported', { actor: actor(c), blueprint: c.req.query('blueprint') ?? null, blueprints: file.blueprints.length, rules: file.relationRules.length, scorecards: file.scorecards.length, alertRules: file.alertRules.length })
    if (c.req.query('format') === 'json') return c.json(file)
    c.header('content-type', 'application/yaml; charset=utf-8')
    c.header('content-disposition', `attachment; filename="orrery-model${c.req.query('blueprint') ? `-${c.req.query('blueprint')}` : ''}.yaml"`)
    return c.body(toYaml(file))
  })
  app.put('/v1/blueprints/:id', model('blueprint.changed'), async (c) => c.json(await modelEdits.save(await caller(c), 'blueprint', c.req.param('id'), (await c.req.json()) as Record<string, unknown>)))
  app.patch('/v1/blueprints/:id', model('blueprint.changed'), async (c) => c.json(await modelEdits.change(await caller(c), 'blueprint', c.req.param('id'), await patchOf(c))))
  app.post('/v1/blueprints/:id/rename', model('blueprint.changed'), async (c) => {
    const { to } = z.object({ to: z.string().min(1) }).parse(await c.req.json())
    return c.json(await modelEdits.rename(await caller(c), c.req.param('id'), to))
  })
  app.post('/v1/blueprints/:id/hand-over', model('blueprint.changed'), async (c) => c.json(await modelEdits.handOver(await caller(c), c.req.param('id'), handOverSchema.parse(await c.req.json()))))
  app.delete('/v1/blueprints/:id/formerly/:name', model('blueprint.changed'), async (c) => c.json(await modelEdits.forget(await caller(c), c.req.param('id'), c.req.param('name'))))
  app.get('/v1/model/templates', allow('model.edit'), async (c) => c.json({ templates: await listTemplates() }))
  app.post('/v1/model/import', allow('model.edit', 'model.imported'), async (c) => {
    const body = z.object({ template: z.string().optional(), yaml: z.string().optional() }).parse(await c.req.json())
    const text = body.template ? await readTemplate(body.template) : body.yaml
    if (!text) return c.json({ error: body.template ? `Unknown template "${body.template}"` : 'Send a template id or the YAML of a model' }, 400)
    if (!(await viewOf(c)).admin && (/^\s*(access|adminEdit)\s*:/m.test(text) || /\bsummary\s*:\s*true\b/.test(text))) throw new AdminOnly('Only an admin imports a model that sets who may see or change something')
    let report
    try {
      report = await importModel({ blueprints, entities, reader, rules, scorecards, alerts, actions, log }, text, actor(c), (await viewOf(c)).admin)
    } catch (error) {
      return c.json({ error: `That file does not parse: ${error instanceof Error ? error.message : String(error)}` }, 400)
    }
    events.emit({ type: 'blueprints' })
    events.emit({ type: 'estate' })
    c.set('audit', { template: body.template, blueprints: report.blueprints.created.length + report.blueprints.extended.length, rules: report.rules.created.length, scorecards: report.scorecards.created.length, actions: report.actions.created.length, entities: report.entities.created, errors: report.errors.length })
    return c.json(report)
  })
  app.delete('/v1/blueprints/:id', model('blueprint.changed'), async (c) => {
    await modelEdits.remove(await caller(c), 'blueprint', c.req.param('id'))
    return c.json({ ok: true })
  })
  app.put('/v1/rules/:id', model('rule.changed'), async (c) => c.json(await modelEdits.save(await caller(c), 'rule', c.req.param('id'), (await c.req.json()) as Record<string, unknown>)))
  app.patch('/v1/rules/:id', model('rule.changed'), async (c) => c.json(await modelEdits.change(await caller(c), 'rule', c.req.param('id'), await patchOf(c))))
  app.delete('/v1/rules/:id', model('rule.changed'), async (c) => {
    await modelEdits.remove(await caller(c), 'rule', c.req.param('id'))
    return c.json({ ok: true })
  })
  // Where a reader's own view of the model would place its cards, worked out and never saved: `rearrange` lays out what
  // they show from scratch, else each blueprint missing from `positions` is placed beside its neighbours. Anyone may ask;
  // only the blueprints the reader sees are placed or answered.
  app.post('/v1/model/layout/place', async (c) => {
    const ask = z.object({ hidden: z.array(z.string()), positions: z.record(z.string(), z.object({ x: z.number(), y: z.number() })).optional(), rearrange: z.boolean().optional() }).parse(await c.req.json())
    const view = await viewOf(c)
    const seen = blueprints.list().filter((bp) => view.seesBlueprint(bp.id))
    const given = Object.fromEntries(Object.entries(ask.positions ?? {}).filter(([id]) => view.seesBlueprint(id)))
    const placed = await placeAll(seen, ask.hidden, ask.rearrange ? {} : given, log)
    return c.json({ positions: Object.fromEntries(Object.entries(placed).map(([id, p]) => [id, { x: Math.round(p.x), y: Math.round(p.y) }])) } satisfies ModelPlacement)
  })
  // The model layout is one shared view of the data model, the same for everyone.
  app.put('/v1/model/layout', allow('model.edit', 'model.arranged'), async (c) => {
    // `rearrange` forgets every placement and lays out what is shown, alone; each hidden blueprint then sits beside its neighbours.
    // What the saver may not see is kept as it was: hidden where it was hidden, and where it stood.
    const patch = z.object({ positions: z.record(z.string(), z.object({ x: z.number(), y: z.number() }).nullable()).optional(), hidden: z.array(z.string()).optional(), rearrange: z.boolean().optional() }).parse(await c.req.json())
    const view = await viewOf(c)
    const row = await db.query<{ value: ModelLayout }>(`SELECT value FROM settings WHERE key = 'model.layout'`)
    const cur: ModelLayout = row.rows[0]?.value ?? { positions: {}, hidden: [] }
    const hidden = patch.hidden ? [...new Set([...patch.hidden.filter((id) => view.seesBlueprint(id)), ...cur.hidden.filter((id) => !view.seesBlueprint(id))])] : cur.hidden
    const positions = patch.rearrange ? await placeAll(blueprints.list(), hidden, {}, log) : { ...cur.positions }
    for (const [id, p] of Object.entries(patch.rearrange ? {} : (patch.positions ?? {}))) {
      if (!view.seesBlueprint(id)) continue
      if (p === null) delete positions[id]
      else positions[id] = { x: Math.round(p.x), y: Math.round(p.y) }
    }
    const next: ModelLayout = { positions, hidden, generation: MODEL_LAYOUT_GENERATION }
    await db.query(`INSERT INTO settings (key, value) VALUES ('model.layout', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(next)])
    events.emit({ type: 'blueprints' })
    log.info(patch.rearrange ? 'model rearranged' : 'model layout saved', { placed: Object.keys(positions).length, hidden: hidden.length })
    c.set('audit', patch.rearrange ? { rearranged: Object.keys(positions).length } : { moved: Object.keys(patch.positions ?? {}), ...(patch.hidden ? { hidden: patch.hidden } : {}) })
    return c.json(modelLayoutFor(next, view))
  })
  // A source that holds the `scorecards` grant puts and removes the scorecards it owns, and nothing else of the model: a judge publishing its own rules.
  const scorecardWriter = (): MiddlewareHandler<AppEnv> => {
    const asPerson = model('scorecard.changed')
    const asSource = allow(null, 'scorecard.changed', { deep: true })
    return (c, next) => {
      const id = c.get('identity')
      return id.kind === 'source' && sources.get(id.source!)?.scorecards ? asSource(c, next) : asPerson(c, next)
    }
  }
  const scorecardOrigin = (c: Context<AppEnv>): ScorecardOrigin => {
    const id = c.get('identity')
    return id.kind === 'source' ? { kind: 'source', source: id.source! } : { kind: 'ui' }
  }
  app.put('/v1/scorecards/:id', scorecardWriter(), async (c) => {
    const origin = scorecardOrigin(c)
    const saved = (await modelEdits.save(await caller(c), 'scorecard', c.req.param('id'), (await c.req.json()) as Record<string, unknown>, origin)) as Scorecard
    if (origin.kind === 'source') await writes.note(origin.source, 'scorecard', tally([saved.id]))
    return c.json(saved)
  })
  app.patch('/v1/scorecards/:id', model('scorecard.changed'), async (c) => c.json(await modelEdits.change(await caller(c), 'scorecard', c.req.param('id'), await patchOf(c))))
  app.delete('/v1/scorecards/:id', scorecardWriter(), async (c) => {
    await modelEdits.remove(await caller(c), 'scorecard', c.req.param('id'), scorecardOrigin(c))
    return c.json({ ok: true })
  })
  app.put('/v1/alert-rules/:id', model('alert_rule.changed'), async (c) => c.json(await modelEdits.save(await caller(c), 'alert_rule', c.req.param('id'), (await c.req.json()) as Record<string, unknown>)))
  app.patch('/v1/alert-rules/:id', model('alert_rule.changed'), async (c) => c.json(await modelEdits.change(await caller(c), 'alert_rule', c.req.param('id'), await patchOf(c))))
  app.delete('/v1/alert-rules/:id', model('alert_rule.changed'), async (c) => {
    await modelEdits.remove(await caller(c), 'alert_rule', c.req.param('id'))
    return c.json({ ok: true })
  })


  // Self-service actions -----------------------------------------------------------

  // An action on, or picking from, a blueprint a person may not see is not there for them; its templates would read what they cannot.
  /** Refuses anyone but a machine access token that holds the permission: only a product, never a person, speaks for someone else. */
  const machineHolds = async (c: Context<AppEnv>, permission: Permission) => {
    const id = c.get('identity')
    if (id.kind === 'token' && can(id, permission)) return
    await record(db, 'access.refused', null, null, null, { permission, method: c.req.method, path: c.req.path, reason: id.kind === 'token' ? 'permission not held' : 'not a machine access token' }, new Date(), 'refused')
    log.warn('refused: speaking for a person needs a machine access token that holds the permission', { actor: id.name, kind: id.kind, permission, path: c.req.path })
    throw new ActionError(`This needs a machine access token with the "${permission}" permission: ${PERMISSIONS[permission].toLowerCase()}`, 403)
  }
  /**
   * The person a product speaks for, as the hub knows them, and what they
   * see. An admin's override stays at the hub: spoken for, an admin is judged
   * by the rules like anyone else. With `meet`, someone the hub has never met
   * is added with no role, so they are judged as a person from their first
   * request; without it they are nobody here.
   */
  const standIn = async (given: string, meet: boolean): Promise<{ person: Identity; view: View }> => {
    const known = access.find(given)
    // Someone the hub has not met is judged as who they are: a person with no role, whom a rule may still name by address. Reading adds nobody.
    const stranger = (): User => ({ email: access.address(given), admin: false, roles: [], firstSeenAt: null, lastSeenAt: null })
    if (!known && meet) log.info('person met through a product that asks for them; added with no role', { person: given })
    const user = known ?? (meet ? await access.addUser(given, [], { admin: false, permissions: [] }) : stranger())
    const person = identityOf({ ...user, admin: false }, access)
    return { person, view: await visibility.view(person) }
  }
  /** Runs `fn` as the person a product speaks for, so every row it writes is theirs; each such row names the product that carried it. */
  const spokenFor = <T>(person: Identity, fn: () => Promise<T>): Promise<T> => actingAs({ kind: 'user', name: person.name }, fn)
  const seenAction = async (c: Context<AppEnv>, id: string) => {
    const a = actions.get(id)
    if (!a || !(await viewOf(c)).seesAction(a)) throw new Hidden(`Unknown action "${id}"`)
    return a
  }
  const seenRun = async (c: Context<AppEnv>, id: string) => {
    const run = await actions.getRun(id)
    const [shown] = run ? await actions.runsFor(c.get('identity'), await viewOf(c), [run]) : []
    if (!shown) throw new Hidden(`Unknown run "${id}"`)
    return shown
  }
  app.get('/v1/actions', async (c) => {
    const person = c.req.query('for')?.trim()
    if (!person) {
      const reader = c.get('identity')
      // What a person owns decides which homes are theirs and whom a rule's `owns` lets in, so the list moves with what that is read from.
      const asksOwner = actions.list().some((a) => a.home || a.access?.rules?.some((r) => r.owns))
      const reads = reader.kind === 'user' && asksOwner ? [...visibility.ownedReads()].sort() : []
      const view = await viewOf(c)
      // The blueprint a person input picks from, to a reader who may see it.
      const people = visibility.personSetting()?.blueprint
      return c.json({ actions: await actions.listFor(reader, view), reads, person: people && view.seesBlueprint(people) ? people : null } satisfies ActionsResponse)
    }
    // A portal asks what one person may run. It reads only that list, as them, and changes nothing.
    const caller = c.get('identity')
    if (!can(caller, 'actions.list')) {
      await record(db, 'access.refused', null, null, null, { listFor: person, reason: 'missing actions.list', method: c.req.method, path: c.req.path }, new Date(), 'refused')
      log.warn('action list for a person refused', { actor: caller.name, person, reason: 'missing actions.list' })
      return c.json({ error: 'Listing actions for someone else needs actions.list' }, 403)
    }
    const user = access.find(person)
    if (!user) return c.json({ actions: [] } satisfies ActionSummariesResponse)
    const identity = identityOf(user, access)
    const listed = await actions.listFor(identity, await visibility.view(identity))
    log.debug('actions listed for a person', { actor: caller.name, person: user.email, actions: listed.length })
    const summaries: ActionSummary[] = listed.filter((a) => a.canRun).map(({ id, title, description, icon, iconShown, group, blueprint, approval, lastRun, pinned, homeShown }) => ({ id, title, description, icon, iconShown, group, blueprint, approval, lastRun, pinned, ...(homeShown ? { home: { id: homeShown.id, title: homeShown.title } } : {}) }))
    return c.json({ actions: summaries } satisfies ActionSummariesResponse)
  })
  // The order of the self-service sections and which start closed is one shared view, the same for everyone. A section is a
  // home, named by its entity id, or a group, named by its name. A home of a blueprint the reader may not see is left out of
  // what they read, and kept where it was when they save.
  const layoutStored = async (): Promise<ActionsLayout> => (await db.query<{ value: ActionsLayout }>(`SELECT value FROM settings WHERE key = 'actions.layout'`)).rows[0]?.value ?? { order: [], closed: [] }
  const sectionSeen = (view: View, name: string): boolean => {
    const home = parseEntityId(name)
    return !home || !blueprints.get(home.blueprint) || view.seesBlueprint(home.blueprint)
  }
  const layoutFor = (view: View, layout: ActionsLayout): ActionsLayout => ({ order: layout.order.filter((n) => sectionSeen(view, n)), closed: layout.closed.filter((n) => sectionSeen(view, n)) })
  app.get('/v1/actions/layout', async (c) => c.json(layoutFor(await viewOf(c), await layoutStored())))
  app.put('/v1/actions/layout', allow('catalog.organize', 'action.arranged'), async (c) => {
    // The section of what has no home and no group is named by the empty name. It is always last, so it may start closed and is never ordered.
    const patch = z.object({ order: z.array(z.string().min(1)).max(200).optional(), closed: z.array(z.string()).max(200).optional() }).parse(await c.req.json())
    const view = await viewOf(c)
    const stored = await layoutStored()
    const merged = (sent: string[] | undefined, was: string[]) => (sent ? [...sent, ...was.filter((n) => !sectionSeen(view, n) && !sent.includes(n))] : was)
    const next: ActionsLayout = { order: merged(patch.order, stored.order), closed: merged(patch.closed, stored.closed) }
    await db.query(`INSERT INTO settings (key, value) VALUES ('actions.layout', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(next)])
    events.emit({ type: 'actions' })
    const shown = layoutFor(view, next)
    c.set('audit', { order: shown.order, closed: shown.closed })
    return c.json(shown)
  })
  app.get('/v1/actions/:id', async (c) => {
    const a = await seenAction(c, c.req.param('id'))
    return c.json((await actions.shown(a, c.get('identity'), await viewOf(c), await visibility.mayRun(c.get('identity'), a))) satisfies ActionView)
  })
  // A source that holds the `actions` grant holds `actions.manage` for these two routes alone; its put is its own, by origin.
  const originOf = (c: Context<AppEnv>): ActionOrigin => {
    const id = c.get('identity')
    return id.kind === 'source' ? { kind: 'source', source: id.source! } : { kind: 'ui' }
  }
  app.put('/v1/actions/:id', allow('actions.manage', 'action.changed', { deep: true }), async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>
    const view = await viewOf(c)
    const origin = originOf(c)
    // Who may run an action is decided the way who sees a blueprint is, and only an admin sets either.
    // Its home may open it to the home's people, so the home is an admin's to set too.
    // Anyone else's save, such as a product declaring its own actions, keeps the access and the home an admin set.
    const existing = actions.get(c.req.param('id'))
    if (!view.admin || origin.kind === 'source') {
      if (body.access !== undefined && stableJson(body.access) !== stableJson(existing?.access ?? null)) throw new AdminOnly('Only an admin sets who may run an action')
      if (existing?.access) body.access = existing.access
      else delete body.access
      if (body.home !== undefined && body.home !== (existing?.home ?? null)) throw new AdminOnly('Only an admin sets the home of an action')
      if (existing?.home) body.home = existing.home
      else delete body.home
    } else {
      const home = typeof body.home === 'string' ? parseEntityId(body.home) : null
      if (home && blueprints.get(home.blueprint)) seen(view, home.blueprint)
    }
    if (body.access) {
      const access = body.access as { grants?: AccessGrant[]; audiences?: string[]; rules?: { grants?: AccessGrant[]; require?: AccessGrant[]; audiences?: string[] }[] }
      for (const part of [access, ...(Array.isArray(access.rules) ? access.rules : [])]) {
        modelEdits.checkGrants({}, null, { grants: [...(part.grants ?? []), ...('require' in part ? (part.require ?? []) : [])] })
        modelEdits.checkPolicyRefs({}, null, part)
      }
    }
    if (existing) await seenAction(c, c.req.param('id'))
    const named = [body.blueprint, ...Object.values((body.inputs ?? {}) as Record<string, { blueprint?: unknown; unique?: { blueprint?: unknown } }>).flatMap((i) => [i?.blueprint, i?.unique?.blueprint])].flatMap((b) => (Array.isArray(b) ? b : [b])).filter((b): b is string => typeof b === 'string')
    for (const b of named) seen(view, b)
    const saved = await actions.save({ ...body, id: c.req.param('id') }, origin, view.admin)
    if (origin.kind === 'source') await writes.note(origin.source, 'action', tally([saved.id]))
    return c.json(saved)
  })
  app.delete('/v1/actions/:id', allow('actions.manage', 'action.changed', { deep: true }), async (c) => {
    await seenAction(c, c.req.param('id'))
    await actions.remove(c.req.param('id'), originOf(c))
    return c.json({ ok: true })
  })
  // What the target picker offers: what this person may run the action on, narrowed by the inputs asked before it.
  app.get('/v1/actions/:id/targets', async (c) => {
    const a = await seenAction(c, c.req.param('id'))
    const narrow = z.record(z.string(), z.unknown()).parse(JSON.parse(c.req.query('narrow') ?? '{}'))
    const page = targetPageSchema.parse({ of: c.req.query('of'), search: c.req.query('q'), limit: c.req.query('limit') })
    // A page is asked for by naming one target, a text, or a limit; without any, the whole list, as a product reads it.
    const paged = page.of !== undefined || page.search !== undefined || c.req.query('limit') !== undefined
    const listFor = (identity: Identity, view: View) => (paged ? actions.targetPage(identity, view, a, narrow, page) : actions.targetList(identity, view, a, narrow))
    const person = c.req.query('for')?.trim()
    if (!person) return c.json((await listFor(c.get('identity'), await viewOf(c))) satisfies ActionTargetsResponse)
    // A product asks what one person may run the action on. It reads only that list, as them, and changes nothing: someone the hub has never met is judged by the rules that name them, and is not added.
    await machineHolds(c, 'actions.list')
    const them = await standIn(person, false)
    if (!them.view.seesAction(a)) return c.json({ entities: [], approval: [] } satisfies ActionTargetsResponse)
    log.debug('action targets listed for a person', { actor: actor(c), action: a.id })
    return c.json((await listFor(them.person, them.view)) satisfies ActionTargetsResponse)
  })
  // A product that names a run's approvers checks, as the hub judges it now, whether grants let one person in: a decider, before it acts on their decision.
  app.post('/v1/access/lets-in', async (c) => {
    await machineHolds(c, 'actions.ask')
    const { address, grants } = z.object({ address: z.string().trim().min(1).max(320), grants: z.array(grantSchema).min(1).max(20) }).parse(await c.req.json())
    const letsIn = await visibility.grantsLetIn(address, grants)
    log.info(letsIn ? 'grants let the person in' : 'grants do not let the person in', { actor: actor(c), grants: grants.length })
    return c.json({ letsIn })
  })
  // No permission gates a run: the action itself names who may run it, and the check inside records a refusal.
  app.post('/v1/actions/:id/run', allow(null, 'action.requested', { deep: true }), async (c) => {
    const action = await seenAction(c, c.req.param('id'))
    const { for: person, ...body } = runActionSchema.parse(await c.req.json())
    if (person && body.requestedFor) return c.json({ error: 'name for, to ask as the person, or requestedFor, to ask as yourself for them: not both' }, 400)
    // Who decides a run is named only by a product that asks for someone else; a person never picks who approves their own.
    if (body.approvers && !person && !body.requestedFor) return c.json({ error: 'approvers are named only by a product that asks for a person, with for or requestedFor' }, 400)
    if (body.requestedFor) {
      // A product that asks as itself for a person: its own access lets it run the action, and the person is kept on the run as data alone.
      await machineHolds(c, 'actions.ask')
      const requestedFor = access.address(body.requestedFor)
      log.info('action asked by a product for a person', { actor: actor(c), action: action.id, approvers: body.approvers?.length ?? 0 })
      return c.json(await actions.request(action.id, { ...body, requestedFor }, c.get('identity'), await viewOf(c), { via: 'tool' }), 201)
    }
    if (person) {
      // A product that takes a person's request asks as them: the hub judges it by that person's rules, and the row says who carried it.
      await machineHolds(c, 'actions.ask')
      const them = await standIn(person, true)
      if (!them.view.seesAction(action)) throw new Hidden(`Unknown action "${action.id}"`)
      return c.json(await spokenFor(them.person, () => actions.request(action.id, body, them.person, them.view, { via: 'tool', through: actor(c) })), 201)
    }
    // A browser is a form; a token on the machine port is a tool. Where the caller is goes with a run only a person asks for themselves.
    const address = ownAddress(c)
    return c.json(await actions.request(action.id, body, c.get('identity'), await viewOf(c), { via: c.env.surface === 'machine' ? 'tool' : 'form', ...(address ? { address } : {}) }), 201)
  })
  // Queries: the catalog read whole across blueprints, each source through the reader's own view, as one table to look at, export, or act on.
  // How the answer is shown once read: conditions on its columns, the order, the groups, the totals, and the widths. Any column id may be named; one the answer does not hold is passed over.
  const queryViewSchema = z.object({
    where: z.array(z.object({ field: z.string().min(1).max(200), op: z.enum(FILTER_OPS), value: z.string().max(500), not: z.boolean().optional() })).max(50).optional(),
    sort: z.array(z.object({ column: z.string().min(1).max(200), desc: z.boolean().optional() })).max(10).optional(),
    group: z.array(z.string().min(1).max(200)).max(QUERY_GROUPS_MAX).optional(),
    totals: z.record(z.string().min(1).max(200), z.enum(QUERY_TOTALS)).optional(),
    widths: z.record(z.string().min(1).max(200), z.number().int().positive().max(4000)).optional(),
    chart: z.object({ by: z.string().min(1).max(200).optional(), total: z.enum(CHART_TOTALS).optional(), column: z.string().min(1).max(200).optional(), split: z.string().min(1).max(200).nullable().optional() }).optional(),
  }) satisfies z.ZodType<QueryView, unknown>
  const queryColumnSchema = z.object({ id: z.string().min(1).max(200), title: z.string().trim().min(1).max(200), from: z.record(z.string().min(1), z.string().min(1).max(200)) })
  const querySchema = z.object({
    sources: z.array(z.object({ blueprint: z.string().min(1), clauses: z.array(gridClauseSchema).max(50).default([]), search: z.string().max(200).optional(), states: z.array(z.enum(ENTITY_STATES)).optional(), hidden: z.boolean().optional() })).min(1).max(QUERY_SOURCES_MAX),
    columns: z.array(z.union([z.string().min(1).max(200), queryColumnSchema])).max(200).default([]),
    view: queryViewSchema.optional(),
  }) satisfies z.ZodType<QuerySpec, unknown>
  const saveQuerySchema = z.object({ title: z.string().trim().min(1).max(120), description: z.string().max(2000).nullish(), shared: z.boolean().optional(), audience: z.string().min(1).max(64).nullish(), home: z.string().min(3).max(512).nullable().optional(), homeShared: z.boolean().optional(), spec: querySchema }) satisfies z.ZodType<SaveQueryRequest, unknown>
  /** A query's sources as the hub reads them: each blueprint one the reader sees some of, and each filter one that reads nothing they may not see. */
  const readSources = (view: View, spec: QuerySpec): ReadSource[] => {
    const sources = queries.sources(spec, view)
    for (const s of sources) {
      if (!s.filter) continue
      try {
        scorecards.checkLevels(s.filter, 'filter')
      } catch (error) {
        throw new WriteError(error instanceof Error ? error.message : String(error))
      }
    }
    return sources
  }
  const xlsx = (c: Context<AppEnv>, bytes: Buffer, title: string) => {
    const name = `${title.replace(/[^\w .-]+/g, ' ').trim().slice(0, 80) || 'query'}.xlsx`
    return c.body(new Uint8Array(bytes), 200, { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'content-disposition': `attachment; filename="${name}"` })
  }
  // `shaped=true` answers as the query's view shows it (the rows it keeps, in its order, up to `limit`, with its groups and
  // totals), for a caller that does not shape the answer itself. Without it the answer is every row read, for the page to shape.
  const shapedAsked = (c: Context<AppEnv>) => c.req.query('shaped') === 'true'
  const shownLimit = (c: Context<AppEnv>) => Math.min(Math.max(Math.trunc(Number(c.req.query('limit'))) || 200, 1), 2000)
  app.post('/v1/query', async (c) => {
    const spec = querySchema.parse(await c.req.json())
    const view = await viewOf(c)
    const result = await queries.run(readSources(view, spec), spec.columns, view, c.get('identity'))
    if (!shapedAsked(c)) return c.json(result satisfies QueryResult)
    const problem = queries.problem(result, spec.view)
    return problem ? c.json({ error: problem }, 400) : c.json(queries.shown(result, spec.view, shownLimit(c)) satisfies QueryAnswer)
  })
  app.post('/v1/query/export', async (c) => {
    const body = z.object({ spec: querySchema, title: z.string().max(120).optional() }).parse(await c.req.json())
    const view = await viewOf(c)
    const title = body.title?.trim() || 'Query'
    return xlsx(c, await queries.export(readSources(view, body.spec), body.spec.columns, view, title, c.get('identity'), body.spec.view), title)
  })
  app.get('/v1/queries', async (c) => c.json({ queries: await queries.list(c.get('identity'), c.req.query('home') || undefined) } satisfies SavedQueriesResponse))
  app.get('/v1/queries/audiences', async (c) => c.json({ audiences: await queries.audiences(c.get('identity')) } satisfies QueryAudiencesResponse))
  app.post('/v1/queries', async (c) => c.json((await queries.save(null, saveQuerySchema.parse(await c.req.json()), c.get('identity'))) satisfies SavedQuery, 201))
  app.get('/v1/queries/:id', async (c) => c.json((await queries.get(c.req.param('id'), c.get('identity'))) satisfies SavedQuery))
  app.put('/v1/queries/:id', async (c) => c.json((await queries.save(c.req.param('id'), saveQuerySchema.parse(await c.req.json()), c.get('identity'))) satisfies SavedQuery))
  app.delete('/v1/queries/:id', async (c) => {
    await queries.remove(c.req.param('id'), c.get('identity'))
    return c.body(null, 204)
  })
  // A saved query runs and exports by its id, so an agent or a link reaches it without sending the query.
  app.get('/v1/queries/:id/run', async (c) => {
    const saved = await queries.get(c.req.param('id'), c.get('identity'))
    const view = await viewOf(c)
    const result = await queries.run(readSources(view, saved.spec), saved.spec.columns, view, c.get('identity'))
    return shapedAsked(c) ? c.json(queries.shown(result, saved.spec.view, shownLimit(c)) satisfies QueryAnswer) : c.json(result satisfies QueryResult)
  })
  app.get('/v1/queries/:id/export', async (c) => {
    const saved = await queries.get(c.req.param('id'), c.get('identity'))
    const view = await viewOf(c)
    return xlsx(c, await queries.export(readSources(view, saved.spec), saved.spec.columns, view, saved.title, c.get('identity'), saved.spec.view), saved.title)
  })
  // What self-service was used for, and what it cost each runner: who ran what is the activity log's to show, so it needs audit.view.
  app.get('/v1/action-insights', allow('audit.view'), async (c) => c.json((await actionInsights(db, actions, Math.min(Math.max(Math.trunc(Number(c.req.query('days'))) || 30, 1), 365))) satisfies ActionInsights))
  // Schedules: an action asked on a cadence as its owner, once someone who decides approvals approves it, or once at a moment, as a run put off.
  const cadenceSchema = z.discriminatedUnion('every', [
    z.object({ every: z.literal('once'), on: z.string().min(1), tz: z.string().min(1) }),
    z.object({ every: z.literal('hour'), minute: z.number().int().min(0).max(59), tz: z.string().min(1) }),
    z.object({ every: z.literal('hours'), hours: z.number().int(), at: z.string(), tz: z.string().min(1) }),
    z.object({ every: z.literal('day'), at: z.string(), tz: z.string().min(1) }),
    z.object({ every: z.literal('week'), days: z.array(z.enum(WEEKDAYS)).min(1).max(7), at: z.string(), tz: z.string().min(1) }),
  ])
  const scheduleSchema = z.object({
    action: z.string().min(1),
    title: z.string().trim().min(1).max(120),
    target: z.object({ entity: refSchema.optional(), entities: targetShape.entities, matching: targetShape.query, query: z.string().min(1).optional() }).default({}),
    inputs: z.record(z.string(), z.unknown()).default({}),
    cadence: cadenceSchema,
    deliver: z.array(z.string().email()).max(20).optional(),
    tell: z.enum(SCHEDULE_TELLS).optional(),
  }) satisfies z.ZodType<ScheduleRequest, unknown>
  // Reports: every change is a run of an action with the report backend; these read, each through the reader's view of the report.
  const editionNumber = (c: Context<AppEnv>) => {
    const n = Number(c.req.param('number'))
    if (!Number.isInteger(n) || n < 1) throw new ReportError('An edition is a number from 1', 400)
    return n
  }
  app.post('/v1/reports/check', async (c) => {
    const body = z.object({ layout: z.string().max(LAYOUT_MAX * 2) }).safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json({ error: 'Send { layout }' }, 400)
    return c.json({ issues: await reports.problems(body.data.layout, c.get('identity')) })
  })
  // The datasets the caller may read in a query, and one read again from its tool whatever is kept.
  app.get('/v1/datasets', async (c) => c.json({ datasets: await datasets.list(c.get('identity'), await viewOf(c)) } satisfies DatasetsResponse))
  app.post('/v1/datasets/:id/refresh', allow(null, 'action.requested', { deep: true }), async (c) => {
    const read = await datasets.read(c.req.param('id'), c.get('identity'), await viewOf(c), true)
    return c.json({ fetchedAt: read.fetchedAt, rows: read.rows.length })
  })
  app.get('/v1/reports', async (c) => c.json((await reports.list(c.get('identity'), c.req.query('home') || undefined)) satisfies ReportsResponse))
  app.get('/v1/reports/:key', async (c) => c.json(await reports.page(c.req.param('key'), c.get('identity'))))
  app.get('/v1/reports/:key/versions/:version', async (c) => c.json({ layout: await reports.version(c.req.param('key'), Number(c.req.param('version')), c.get('identity')) }))
  app.get('/v1/reports/:key/editions/:number', async (c) => c.json(await reports.edition(c.req.param('key'), editionNumber(c), c.get('identity'))))
  app.get('/v1/reports/:key/editions/:number/body', async (c) => {
    const key = c.req.param('key')
    const number = editionNumber(c)
    const { content } = await reports.edition(key, number, c.get('identity'))
    const profile = c.req.query('profile') === 'web' ? 'web' : 'email'
    // A body is the hub's own markup: every value in it is escaped, and it runs nothing.
    return c.body(drawEdition(content, profile, reports.pageUrl(key, number)), 200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:", 'cache-control': 'private, max-age=86400, immutable' })
  })
  app.get('/v1/reports/:key/editions/:number/data', async (c) => {
    const key = c.req.param('key')
    const number = editionNumber(c)
    const { data } = await reports.edition(key, number, c.get('identity'))
    return c.body(JSON.stringify(data, null, 2), 200, { 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="${key}-${number}.json"` })
  })
  app.get('/v1/reports/:key/previews/:run', async (c) => c.json(await reports.preview(c.req.param('key'), c.req.param('run'), c.get('identity'))))
  app.get('/v1/schedules', async (c) => c.json({ schedules: await schedules.list(c.get('identity')) } satisfies SchedulesResponse))
  app.post('/v1/schedules', async (c) => c.json((await schedules.request(scheduleSchema.parse(await c.req.json()), c.get('identity'))) satisfies ActionSchedule, 201))
  // Before `:id`, which would take `history` for a schedule's id.
  app.get('/v1/schedules/history', async (c) => c.json((await schedules.history(c.get('identity'), { days: Number(c.req.query('days')), ...(c.req.query('schedule') ? { schedule: c.req.query('schedule') } : {}) })) satisfies ScheduleHistory))
  app.get('/v1/schedules/awaiting', async (c) => c.json({ schedules: await schedules.awaiting(c.get('identity')) } satisfies SchedulesResponse))
  app.get('/v1/schedules/:id', async (c) => c.json((await schedules.get(c.req.param('id'), c.get('identity'))) satisfies ActionSchedule))
  app.put('/v1/schedules/:id', async (c) => c.json((await schedules.change(c.req.param('id'), scheduleSchema.parse(await c.req.json()), c.get('identity'))) satisfies ActionSchedule))
  app.delete('/v1/schedules/:id', async (c) => {
    await schedules.remove(c.req.param('id'), c.get('identity'))
    return c.body(null, 204)
  })
  const noteOf = async (c: Context<AppEnv>) => z.object({ reason: z.string().max(2000).optional() }).safeParse(await c.req.json().catch(() => ({}))).data?.reason
  app.post('/v1/schedules/:id/approve', async (c) => c.json((await schedules.decide(c.req.param('id'), true, c.get('identity'), await noteOf(c))) satisfies ActionSchedule))
  app.post('/v1/schedules/:id/decline', async (c) => c.json((await schedules.decide(c.req.param('id'), false, c.get('identity'), await noteOf(c))) satisfies ActionSchedule))
  app.post('/v1/schedules/:id/pause', async (c) => c.json((await schedules.pause(c.req.param('id'), true, c.get('identity'))) satisfies ActionSchedule))
  app.post('/v1/schedules/:id/resume', async (c) => c.json((await schedules.pause(c.req.param('id'), false, c.get('identity'))) satisfies ActionSchedule))
  app.post('/v1/schedules/:id/run', async (c) => c.json((await schedules.runNow(c.req.param('id'), c.get('identity'))) satisfies ActionSchedule))
  // Batches: one action on many entities at once, each its own run. The question a grid asked is read with the reader's own view.
  const manySchema = z.object({ ...targetShape, inputs: z.record(z.string(), z.unknown()).default({}) }).refine(oneTarget, 'Name the entities, or the question that picks them, not both')
  const matchedBy = async (c: Context<AppEnv>, input: z.infer<typeof manySchema>): Promise<EntityRef[] | null> => (input.query ? reached(c, { query: input.query }) : null)
  app.post('/v1/actions/:id/batch/preview', async (c) => {
    const action = await seenAction(c, c.req.param('id'))
    const body = manySchema.parse(await c.req.json())
    return c.json((await batches.preview(action.id, body, await matchedBy(c, body), c.get('identity'), await viewOf(c))) satisfies BatchPreview)
  })
  // No permission gates a batch: the action names who may run it, and each run is judged as one alone.
  app.post('/v1/actions/:id/batch', allow(null), async (c) => {
    const action = await seenAction(c, c.req.param('id'))
    const body = manySchema.parse(await c.req.json())
    return c.json((await batches.start(action.id, body, await matchedBy(c, body), c.get('identity'), await viewOf(c))) satisfies ActionBatchSummary, 201)
  })
  app.get('/v1/action-batches', async (c) => c.json({ batches: await batches.list(c.get('identity'), await viewOf(c), { ...(c.req.query('action') ? { action: c.req.query('action') } : {}) }) } satisfies ActionBatchesResponse))
  app.get('/v1/action-batches/:id', async (c) => c.json((await batches.get(c.req.param('id'), c.get('identity'), await viewOf(c))) satisfies ActionBatchResponse))
  // One approval of a batch approves each of its waiting runs as one alone would be, by `mayDecide` on each.
  app.post('/v1/action-batches/:id/approve', allow(null, 'action.approved', { deep: true }), async (c) => {
    const { note } = z.object({ note: z.string().max(4000).optional() }).safeParse(await c.req.json().catch(() => ({}))).data ?? {}
    return c.json((await batches.approve(c.req.param('id'), c.get('identity'), await viewOf(c), note)) satisfies BatchApproval)
  })
  app.post('/v1/action-batches/:id/stop', async (c) => c.json((await batches.stop(c.req.param('id'), c.get('identity'))) satisfies ActionBatchSummary))
  const againSchema = z.object({ entities: z.array(refSchema).min(1).max(BATCH_MAX).optional(), states: z.array(z.enum(ACTION_RUN_STATES)).min(1).optional() }).refine((r) => !!r.entities !== !!r.states, 'Name the entities, or the states whose runs to ask again, not both') satisfies z.ZodType<BatchAgainRequest>
  app.post('/v1/action-batches/:id/again', async (c) => c.json(await batches.again(c.req.param('id'), againSchema.parse(await c.req.json()), c.get('identity'), await viewOf(c))))
  // Change sets: many runs, each with its own action, entity, and inputs, asked together for one decision.
  const changeSetSchema = z.object({
    title: z.string().trim().min(1).max(200),
    note: z.string().max(4000).optional(),
    items: z.array(z.object({ action: z.string().min(1).max(200), entity: refSchema.optional(), inputs: z.record(z.string(), z.unknown()).default({}) })).min(1).max(CHANGE_SET_MAX),
    for: z.string().trim().min(1).max(320).optional(),
  }) satisfies z.ZodType<ChangeSetRequest, unknown>
  // No permission gates a set: each item's action names who may run it, and each is judged as a run alone; the activity rows are written inside.
  app.post('/v1/change-sets', allow(null, 'action.set_requested', { deep: true }), async (c) => {
    const { for: person, ...body } = changeSetSchema.parse(await c.req.json())
    if (person) {
      // A product that takes a person's request asks as them, as it does for one run.
      await machineHolds(c, 'actions.ask')
      const them = await standIn(person, true)
      return c.json((await spokenFor(them.person, () => changeSets.create(body, them.person, them.view, { via: 'tool', through: actor(c) }))) satisfies ChangeSetSummary, 201)
    }
    return c.json((await changeSets.create(body, c.get('identity'), await viewOf(c), { via: c.env.surface === 'machine' ? 'tool' : 'form' })) satisfies ChangeSetSummary, 201)
  })
  app.get('/v1/change-sets', async (c) => {
    const q = c.req.query()
    const since = q.since && !Number.isNaN(Date.parse(q.since)) ? new Date(q.since) : undefined
    return c.json({ sets: await changeSets.list(c.get('identity'), await viewOf(c), { ...(q.by ? { by: q.by } : {}), ...(q.waiting === 'true' ? { waiting: true } : {}), ...(since ? { since } : {}), ...(q.limit ? { limit: Number(q.limit) || undefined } : {}) }) } satisfies ChangeSetsResponse)
  })
  app.get('/v1/change-sets/:id', async (c) => c.json((await changeSets.get(c.req.param('id'), c.get('identity'), await viewOf(c))) satisfies ChangeSetResponse))
  // One approval approves every run of a set, each as it would be approved alone, once the caller may decide every one.
  app.post('/v1/change-sets/:id/approve', allow(null, 'action.set_approved', { deep: true }), async (c) => {
    const { note } = z.object({ note: z.string().max(4000).optional() }).safeParse(await c.req.json().catch(() => ({}))).data ?? {}
    return c.json((await changeSets.approve(c.req.param('id'), c.get('identity'), await viewOf(c), note)) satisfies ChangeSetApproval)
  })
  app.post('/v1/change-sets/:id/reject', allow(null, 'action.set_rejected', { deep: true }), async (c) => {
    const { reason } = z.object({ reason: z.string().max(4000).optional() }).safeParse(await c.req.json().catch(() => ({}))).data ?? {}
    return c.json((await changeSets.reject(c.req.param('id'), c.get('identity'), await viewOf(c), reason)) satisfies ChangeSetSummary)
  })
  app.post('/v1/change-sets/:id/withdraw', allow(null, 'action.set_withdrawn', { deep: true }), async (c) => {
    const { reason } = z.object({ reason: z.string().max(500).optional() }).safeParse(await c.req.json().catch(() => ({}))).data ?? {}
    return c.json((await changeSets.withdraw(c.req.param('id'), c.get('identity'), reason)) satisfies ChangeSetSummary)
  })
  // The items that failed, asked again as a new set for approval.
  app.post('/v1/change-sets/:id/retry', allow(null, 'action.set_requested', { deep: true }), async (c) => c.json((await changeSets.retry(c.req.param('id'), c.get('identity'), await viewOf(c), { via: c.env.surface === 'machine' ? 'tool' : 'form' })) satisfies ChangeSetSummary, 201))
  // An image a run reported, as an image: a grid of many runs shows each one without carrying them all in one answer.
  app.get('/v1/action-runs/:id/outputs/:name', async (c) => {
    const run = await seenRun(c, c.req.param('id'))
    const value = run.images.includes(c.req.param('name')) ? await actions.image(run.id, c.req.param('name')) : null
    if (!value || !isImageOutput(value)) return c.json({ error: 'No image of that name on the run' }, 404)
    const comma = value.indexOf(',')
    return c.body(Buffer.from(value.slice(comma + 1), 'base64'), 200, { 'content-type': value.slice(5, value.indexOf(';')), 'cache-control': isFinished(run.state) ? 'private, max-age=86400, immutable' : 'private, no-cache' })
  })
  app.get('/v1/action-runs', async (c) => {
    const q = c.req.query()
    const view = await viewOf(c)
    const entity = q.entity ? (parseEntityId(q.entity) ?? undefined) : undefined
    if (entity) seen(view, entity.blueprint)
    // A list that groups batches lists the runs asked alone, and each batch asked over the same span as one line.
    // One that groups by origin also folds what each schedule fired into one line a schedule a day; one that names a schedule lists its firings over a span.
    const group = entity ? undefined : q.group === 'batch' || q.group === 'origin' ? q.group : undefined
    const instant = (v: string | undefined) => (v && !Number.isNaN(Date.parse(v)) ? new Date(v) : undefined)
    const schedule = group && q.schedule ? { schedule: q.schedule, from: instant(q.from), to: instant(q.to) } : undefined
    const { runs, more } = await actions.listRuns({ action: q.action, state: q.state, by: q.by, entity, limit: Number(q.limit) || undefined, tools: q.tools === 'true', byHand: q.scheduled === 'false', ...(group ? { alone: schedule ? 'batch' : group } : {}), ...(q.sets === 'apart' ? { sets: 'apart' as const } : {}), ...schedule })
    const shown = await actions.runsFor(c.get('identity'), view, runs)
    if (!group) return c.json({ runs: shown, more } satisfies ActionRunsResponse)
    // The span ends where the page of runs does, so the next page of runs brings the batches beside it.
    const since = more && runs.length ? new Date(runs.at(-1)!.createdAt) : undefined
    const states = q.state ? (q.state.split(',').filter((s): s is ActionRunState => (ACTION_RUN_STATES as readonly string[]).includes(s))) : undefined
    const narrowed = { ...(q.action ? { action: q.action } : {}), ...(q.by ? { by: q.by } : {}), ...(states ? { states } : {}) }
    if (schedule) {
      const listed = await batches.list(c.get('identity'), view, { ...narrowed, schedule: schedule.schedule, limit: Number(q.limit) || undefined, ...(schedule.from ? { since: schedule.from } : {}), ...(schedule.to ? { until: schedule.to } : {}) })
      return c.json({ runs: shown, more, batches: listed } satisfies ActionRunsResponse)
    }
    const listed = await batches.list(c.get('identity'), view, { ...narrowed, ...(since ? { since } : {}), ...(group === 'origin' ? { schedule: null } : {}) })
    // A change set is one line; a list of one action's runs, or of one state, shows the sets that hold such a run.
    const sets = (await changeSets.list(c.get('identity'), view, { ...(q.by ? { by: q.by } : {}), ...(since ? { since } : {}) })).filter((s) => (!q.action || s.actions.some((a) => a.id === q.action)) && (!states || states.some((st) => (s.counts[st] ?? 0) > 0)))
    if (group === 'batch') return c.json({ runs: shown, more, batches: listed, sets } satisfies ActionRunsResponse)
    const days = await schedules.days(c.get('identity'), view, { ...narrowed, tz: q.tz ?? 'UTC', ...(since ? { since } : {}) })
    return c.json({ runs: shown, more, batches: listed, sets, schedules: days } satisfies ActionRunsResponse)
  })
  app.get('/v1/action-runs/:id', async (c) => c.json(await seenRun(c, c.req.param('id'))))
  // Who decides a run is the run's to say (`mayDecide` in actions.ts): a holder of actions.approve, or someone a rule trusts there without approval.
  app.post('/v1/action-runs/:id/approve', allow(null, 'action.approved', { deep: true }), async (c) => {
    await seenRun(c, c.req.param('id'))
    const { note } = z.object({ note: z.string().max(4000).optional() }).safeParse(await c.req.json().catch(() => ({}))).data ?? {}
    return c.json(await actions.approve(c.req.param('id'), c.get('identity'), await viewOf(c), note))
  })
  app.post('/v1/action-runs/:id/decline', allow(null, 'action.declined', { deep: true }), async (c) => {
    await seenRun(c, c.req.param('id'))
    const { reason } = z.object({ reason: z.string().max(4000).optional() }).safeParse(await c.req.json().catch(() => ({}))).data ?? {}
    return c.json(await actions.decline(c.req.param('id'), c.get('identity'), reason, await viewOf(c)))
  })
  // Whoever may approve a run may send it back to its asker with a note, to be asked again.
  app.post('/v1/action-runs/:id/return', allow(null, 'action.returned', { deep: true }), async (c) => {
    await seenRun(c, c.req.param('id'))
    const { note } = returnRunSchema.parse(await c.req.json())
    return c.json(await actions.sendBack(c.req.param('id'), c.get('identity'), note, await viewOf(c)))
  })
  // The person who asked, or an admin, withdraws a run not started yet, or stops a job's run under way; the activity row is the cancel, written inside.
  app.post('/v1/action-runs/:id/withdraw', allow(null, 'action.cancelled', { deep: true }), async (c) => {
    await seenRun(c, c.req.param('id'))
    const { reason } = z.object({ reason: z.string().max(500).optional() }).safeParse(await c.req.json().catch(() => ({}))).data ?? {}
    return c.json(await actions.withdraw(c.req.param('id'), c.get('identity'), reason))
  })
  // A workflow or a webhook target speaks for a run with an access token, and a job's own container with the credential
  // made for its run; the activity row is the finish, written inside.
  app.post('/v1/action-runs/:id/report', allow('actions.report', 'action.finished', { deep: true }), async (c) => {
    const id = c.get('identity')
    return c.json(await actions.report(c.req.param('id'), reportSchema.parse(await c.req.json().catch(() => ({}))), id.kind === 'run' ? { kind: 'job', run: id.run! } : { kind: 'caller', name: actor(c) }))
  })

  // Tools: the door ---------------------------------------------------------------

  // No permission opens a tool: whoever holds its tier on the entity may call it, and the check inside records a refusal.
  // A product that works a person's request reaches as that person, with what that request holds and no more.
  const lentOf = async (c: Context<AppEnv>, as: ToolCaller | undefined): Promise<Lent | undefined> => {
    if (!as) return undefined
    await machineHolds(c, 'tools.lend')
    return { ...(await standIn(as.person, false)), as, lender: c.get('identity') }
  }
  app.get('/v1/tools', async (c) => {
    const q = z.object({ entity: z.string().optional(), for: z.string().optional(), action: z.string().optional(), run: z.string().optional() }).parse(c.req.query())
    const entity = q.entity ? parseEntityId(q.entity) : null
    if (q.entity && !entity) return c.json({ error: 'entity is <blueprint>:<key>' }, 400)
    if (q.for && !(q.action && entity)) return c.json({ error: 'A listing for a person names the action they asked for and the entity they asked for it on' }, 400)
    const lent = q.for ? await lentOf(c, { person: q.for, action: q.action!, entity: entity!, ...(q.run ? { run: q.run } : {}) }) : undefined
    const view = await viewOf(c)
    if (entity) seen(lent?.view ?? view, entity.blueprint)
    return c.json({ tools: await actions.tools(c.get('identity'), view, entity, lent) } satisfies ToolsResponse)
  })
  app.post('/v1/tools/:id/call', allow(null, 'action.requested', { deep: true }), async (c) => {
    const body = toolCallSchema.parse(await c.req.json())
    const lent = await lentOf(c, body.as)
    const view = await viewOf(c)
    const action = actions.get(c.req.param('id'))
    if (!action || !(lent?.view ?? view).seesAction(action)) throw new Hidden(`Unknown tool "${c.req.param('id')}"`)
    const call = () => actions.call(action.id, body, c.get('identity'), view, lent)
    const asked = await (lent ? spokenFor(lent.person, call) : call())
    // The caller is an agent in the middle of its work: it gets the answer on this call, not a run to poll.
    const run = await actions.settled(asked.id, actions.waitOf(action, TOOL_WAIT_MS), c.req.raw.signal)
    return c.json({ run: run.id, state: run.state, summary: run.summary, ...actions.said(run), outputs: run.outputs } satisfies ToolCallResponse, 201)
  })

  // Sources, secrets, tokens ------------------------------------------------------

  app.post('/v1/sources/:id/refresh', allow('sources.refresh', 'source.refreshed'), async (c) => {
    const report = await git.refresh(c.req.param('id'), `ui:${actor(c)}`)
    c.set('audit', { source: c.req.param('id'), errors: report.errors.length })
    return c.json(report)
  })
  const manageSources = allow('sources.manage', 'source.changed', { deep: true })
  app.put('/v1/sources/:id', manageSources, async (c) => {
    const { gitToken, ...spec } = (await c.req.json()) as Record<string, unknown> & { gitToken?: string | null }
    // What a source acts for, whether it may define actions or put scorecards, and which tools a runner serves are set by admins alone; anyone else's save keeps them.
    const existing = sources.get(c.req.param('id'))
    if (!c.get('identity').admin) {
      if ('serves' in spec && stableJson(spec.serves ?? null) !== stableJson(existing?.serves ?? null)) throw new AdminOnly('Only an admin says which tools a runner serves')
      if ('actsFor' in spec && (spec.actsFor ?? null) !== (existing?.actsFor ?? null)) throw new AdminOnly('Only an admin sets what a source acts for')
      if ('actions' in spec && Boolean(spec.actions) !== (existing?.actions ?? false)) throw new AdminOnly('Only an admin lets a source define actions')
      if ('scorecards' in spec && Boolean(spec.scorecards) !== (existing?.scorecards ?? false)) throw new AdminOnly('Only an admin lets a source put scorecards')
    }
    const saved = await sources.save(c.req.param('id'), spec, gitToken)
    await runs.syncSourceEntities(saved.id)
    events.emit({ type: 'sources' })
    if (saved.class === 'git') void git.refresh(saved.id, 'registered').catch(() => undefined)
    return c.json(saved)
  })
  app.post('/v1/sources/:id/hand-over', manageSources, async (c) => {
    const { to, scope, blueprints: only } = z
      .object({ to: z.string().min(1), scope: z.string().min(1).optional(), blueprints: z.array(z.string().min(1)).min(1).max(200).optional() })
      .parse(await c.req.json())
    // Handed to the web app, the entities are people's to keep; to a pusher, that pusher's.
    const counts = to === 'ui' ? await sources.release(c.req.param('id'), actor(c), only) : await sources.handOver(c.req.param('id'), to, scope, only)
    events.emit({ type: 'sources' })
    events.emit({ type: 'estate' })
    return c.json(counts)
  })
  /** A pusher takes over entities a person made, named one by one, so its writes land on them. */
  app.post('/v1/sources/:id/adopt', manageSources, async (c) => {
    const { entities: refs, scope } = z
      .object({ entities: z.array(z.object({ blueprint: z.string().min(1), key: z.string().min(1) })).min(1).max(1000), scope: z.string().min(1).optional() })
      .parse(await c.req.json())
    const counts = await sources.adopt(c.req.param('id'), refs, scope)
    events.emit({ type: 'sources' })
    events.emit({ type: 'estate', blueprints: [...new Set(refs.map((r) => r.blueprint))] })
    return c.json(counts)
  })
  app.delete('/v1/sources/:id', manageSources, async (c) => {
    const released = await blueprints.releaseLayout(c.req.param('id'))
    const { handed, unlinked } = await sources.remove(c.req.param('id'))
    // A git source's definitions are the web app's now; every cache that holds an origin reads them again.
    if (handed || released) {
      await Promise.all([blueprints.load(), rules.load(), scorecards.load(), alerts.load(), actions.load()])
      events.emit({ type: 'blueprints' })
      events.emit({ type: 'actions' })
    }
    if (unlinked.length) events.emit({ type: 'estate', blueprints: unlinked })
    events.emit({ type: 'sources' })
    return c.json({ ok: true, handed })
  })
  // Custom icons ------------------------------------------------------------------

  // A source puts an icon, such as a repository's logo; a person or an access token needs to be one that edits entities.
  const iconWriter = allow('entities.edit', 'icon.changed', { deep: true })
  app.put('/v1/icons/:name', (c, next) => (c.get('identity').kind === 'source' ? ingest(c, next) : iconWriter(c, next)), async (c) => {
    const id = c.get('identity')
    const type = (c.req.header('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
    if (Number(c.req.header('content-length') ?? 0) > MAX_ICON_BYTES) throw new IconError(413, `An icon is at most ${MAX_ICON_BYTES / 1024} KiB`)
    const data = new Uint8Array(await c.req.arrayBuffer())
    const { icon } = await icons.put(c.req.param('name'), type, data, id.kind === 'source' ? id.source! : 'ui')
    if (id.kind === 'source') await sources.touch(id.source!, { seen: new Date() })
    return c.json({ name: icon.name, type: icon.type, sha256: icon.sha256, size: icon.size })
  })
  app.get('/v1/icons', (c) => c.json({ icons: icons.list() } satisfies IconsResponse))
  app.get('/v1/icons/:name', async (c) => {
    const image = await icons.image(c.req.param('name'), c.req.query('theme') === 'light' ? 'light' : 'dark')
    if (!image) return c.json({ error: `No icon file is called "${c.req.param('name')}"` }, 404)
    const etag = `"${image.sha256}"`
    const headers: Record<string, string> = { etag, 'cache-control': 'private, max-age=300', 'x-content-type-options': 'nosniff' }
    if (image.type === 'image/svg+xml') headers['content-security-policy'] = "default-src 'none'; style-src 'unsafe-inline'"
    if (etagMatches(c.req.header('if-none-match'), etag)) return c.body(null, 304, headers)
    return c.body(image.data, 200, { ...headers, 'content-type': image.type })
  })
  // A photo is named by its bytes, so its address never serves anything else and is kept for good.
  app.get('/v1/photos/:sha/:size', async (c) => {
    const size = c.req.param('size')
    if (size !== 'small' && size !== 'large') return c.json({ error: 'A photo is small or large' }, 404)
    const data = await pictures.image(c.req.param('sha'), size)
    if (!data) return c.json({ error: 'No photo has that name' }, 404)
    return c.body(data as Uint8Array<ArrayBuffer>, 200, { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' })
  })
  app.delete('/v1/icons/:name', allow(null, 'icon.removed', { deep: true }), async (c) => {
    if (!c.get('identity').admin) throw new AdminOnly('Only an admin removes a custom icon')
    await icons.remove(c.req.param('name'))
    return c.json({ ok: true })
  })

  app.get('/v1/secrets', allow('secrets.manage'), async (c) => c.json({ secrets: await checks.listSecrets() }))
  app.put('/v1/secrets/:name', allow('secrets.manage', 'secret.changed'), async (c) => {
    const { value } = z.object({ value: z.string().min(1) }).parse(await c.req.json())
    await checks.setSecret(c.req.param('name'), value)
    return c.json({ ok: true })
  })
  app.delete('/v1/secrets/:name', allow('secrets.manage', 'secret.changed'), async (c) => {
    await checks.deleteSecret(c.req.param('name'))
    c.set('audit', { removed: true })
    return c.json({ ok: true })
  })
  /** A personal token acts as its person, but it never makes or changes tokens: a stolen one cannot outlive its revocation. */
  const noPersonalToken = (c: Context<AppEnv>) => {
    if (c.get('identity').token) throw new AdminOnly('A personal token cannot issue, rotate, or revoke tokens; sign in to do that')
  }
  app.get('/v1/tokens', allow('tokens.manage'), async (c) => c.json({ tokens: await sources.listTokens() }))
  app.post('/v1/tokens', allow('tokens.manage', 'token.issued'), async (c) => {
    noPersonalToken(c)
    const body = tokenSchema.parse(await c.req.json())
    if (body.kind === 'access') {
      const role = body.role ? access.role(body.role) : undefined
      if (!role) return c.json({ error: body.role ? `Unknown role "${body.role}"` : 'An access token needs a role' }, 400)
      access.requireHeld(c.get('identity'), role.permissions, `A token bound to role "${role.id}"`)
    }
    const issued = await sources.issueToken(body.kind, body.name, { role: body.kind === 'access' ? body.role : undefined, source: body.source })
    c.set('audit', { token: issued.id, name: body.name, kind: body.kind, role: body.kind === 'access' ? body.role : undefined, source: body.kind === 'source' ? body.source : undefined })
    return c.json(issued, 201)
  })
  app.delete('/v1/tokens/:id', allow('tokens.manage', 'token.revoked'), async (c) => {
    noPersonalToken(c)
    const revoked = await sources.revokeToken(c.req.param('id'))
    c.set('audit', { name: revoked.name, kind: revoked.kind })
    return c.json({ ok: true })
  })

  // A person's own tokens: an agent holding one acts as the person, sees what they see, and its activity is theirs.
  const mine = (c: Context<AppEnv>) => {
    const id = c.get('identity')
    if (id.kind !== 'user' || (config.AUTH_MODE === 'none' && id.name === 'local')) throw new AdminOnly('Personal tokens are for a person who signs in')
    return id.name
  }
  app.get('/v1/me/tokens', async (c) => c.json({ tokens: await sources.listTokens(mine(c)) }))
  app.post('/v1/me/tokens', async (c) => {
    const owner = mine(c)
    noPersonalToken(c)
    const { name } = z.object({ name: z.string().trim().min(1).max(80) }).parse(await c.req.json())
    const issued = await sources.issueToken('personal', name, { owner })
    await record(db, 'token.issued', null, null, null, { token: issued.id, name, kind: 'personal' })
    return c.json(issued, 201)
  })
  app.post('/v1/me/tokens/:id/rotate', async (c) => {
    const owner = mine(c)
    noPersonalToken(c)
    const issued = await sources.rotateToken(c.req.param('id'), owner)
    await record(db, 'token.rotated', null, null, null, { token: issued.id, name: issued.name, kind: 'personal' })
    return c.json(issued)
  })
  app.delete('/v1/me/tokens/:id', async (c) => {
    const owner = mine(c)
    noPersonalToken(c)
    const revoked = await sources.revokeToken(c.req.param('id'), owner)
    await record(db, 'token.revoked', null, null, null, { token: c.req.param('id'), name: revoked.name, kind: 'personal' })
    return c.json({ ok: true })
  })

  // Access rules: who a signed-in person is in the estate, and what that lets them see. An admin's alone.
  const onlyAdmin = (c: Context<AppEnv>) => {
    if (!c.get('identity').admin) throw new AdminOnly('Only an admin decides who sees what')
  }
  const accessSettings = async (): Promise<AccessSettingsResponse> => ({ person: visibility.personSetting(), adminOnly: visibility.adminOnlyIds() })
  app.get('/v1/access', async (c) => c.json(await accessSettings()))
  app.put('/v1/access/person', async (c) => {
    onlyAdmin(c)
    const next = personSchema.parse(await c.req.json())
    const before = visibility.personSetting()
    try {
      await visibility.setPerson(next)
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400)
    }
    await record(db, 'access.changed', null, null, null, { before, after: next })
    await pictures.personMoved(before, next)
    events.emit({ type: 'blueprints' })
    return c.json(await accessSettings())
  })
  // The blueprint the hub keeps its own approvals in, as records beside every other system's: an admin's to name.
  app.get('/v1/access/approvals', (c) => c.json({ approvals: approvals.setting() }))
  app.put('/v1/access/approvals', async (c) => {
    onlyAdmin(c)
    const next = z.object({ blueprint: z.string().min(1) }).nullable().parse(await c.req.json())
    const before = approvals.setting()
    try {
      await approvals.set(next)
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400)
    }
    await record(db, 'access.changed', null, null, null, { approvals: { before, after: next } })
    return c.json({ approvals: approvals.setting() })
  })
  // Previews: the views held back until an admin opens them, to the people named and then to everyone.
  app.get('/v1/access/previews', (c) => {
    onlyAdmin(c)
    return c.json({ previews: deps.previews.get() } satisfies PreviewsResponse)
  })
  app.put('/v1/access/previews', async (c) => {
    onlyAdmin(c)
    const given = previewsSchema.parse(await c.req.json())
    // A person is named by the address they sign in with, whichever of its aliases was typed.
    const asked = Object.fromEntries(Object.entries(given).map(([name, setting]) => [name, { ...setting, people: setting.people.map((p) => access.address(p)) }]))
    const before = deps.previews.get()
    if (stableJson(before) === stableJson(previewsSchema.parse(asked))) {
      log.info('previews saved as they were; nothing changed', { actor: c.get('identity').name })
      return c.json({ previews: before } satisfies PreviewsResponse)
    }
    const after = await deps.previews.save(asked)
    await record(db, 'preview.changed', null, null, null, { before, after })
    log.info('previews changed', { actor: c.get('identity').name, before, after })
    // What a caller is shown moved: every open page asks who it is again, and every kept answer is built again.
    events.emit({ type: 'access' })
    return c.json({ previews: after } satisfies PreviewsResponse)
  })
  // What the estate sets of the tour: an admin's, or a git source's while it declares it under config.welcome.
  app.get('/v1/access/welcome', (c) => {
    onlyAdmin(c)
    return c.json({ welcome: deps.welcome.get() } satisfies { welcome: WelcomeDef })
  })
  app.put('/v1/access/welcome', async (c) => {
    onlyAdmin(c)
    const saved = await deps.welcome.set(await c.req.json(), c.get('identity').name)
    return c.json({ welcome: saved } satisfies { welcome: WelcomeDef })
  })
  /** The hub's own blueprints are locked, except who sees them. Admins only until an admin shares one; no grants puts it back. */
  app.put('/v1/access/hub-blueprints/:id', async (c) => {
    onlyAdmin(c)
    const id = c.req.param('id')
    if (!isHubBlueprint(id)) return c.json({ error: `"${id}" is not one of the hub's own blueprints` }, 404)
    const { access: rule } = z.object({ access: accessRuleSchema.nullable() }).parse(await c.req.json())
    const before = blueprints.get(id)?.access ?? null
    modelEdits.checkGrants({}, id, rule ?? undefined)
    await setHubAccess(db, blueprints, entities, id, rule, log)
    const after = blueprints.get(id)?.access ?? null
    if (stableJson(before) !== stableJson(after)) {
      await record(db, 'access.changed', { blueprint: id }, null, null, { before, after })
      visibility.refresh()
      events.emit({ type: 'blueprints' })
    }
    return c.json(blueprints.get(id))
  })

  // Security posture: who sees, changes, and runs what, judged for every person and token, and a change to many rules at once. An admin's alone.
  const posture = new Posture({ db, blueprints, visibility, access, actions, sources })
  app.get('/v1/posture', allow('posture.read'), async (c) => c.json((await posture.snapshot(c.get('identity'), await viewOf(c))) satisfies PostureResponse))
  /** The audiences and field classes, as saved, and the git source that declares them, if one does. */
  app.get('/v1/posture/policy', allow('posture.read'), (c) => c.json(visibility.policyState() satisfies PolicyState))
  /** A new policy: who gains and who loses sight of what, and saved when body.save is true. An admin's alone, and refused while git declares it. */
  app.post('/v1/posture/policy', async (c) => {
    onlyAdmin(c)
    const { policy: sent, save } = z.object({ policy: policySchema, save: z.boolean().default(false) }).parse(await c.req.json())
    const next = normalizePolicy({ ...sent, edits: sent.edits ?? visibility.policyState().policy.edits })
    const preview = await posture.previewPolicy(next)
    if (!save || preview.problems.length) return c.json(preview satisfies PolicyPreview)
    const person = visibility.personSetting()?.blueprint
    if (person) for (const a of next.audiences) for (const g of a.grants) if (g.path) blueprints.checkGrantPath(person, g.path, `Audience "${a.id}" (from ${person})`)
    const before = visibility.policyState().policy
    if (await visibility.setPolicy(next, null)) {
      events.emit({ type: 'blueprints' })
      await record(db, 'access.changed', null, null, null, { policy: true, before, after: visibility.policyState().policy, gains: preview.items.reduce((n, i) => n + i.gains.length, 0), loses: preview.items.reduce((n, i) => n + i.loses.length, 0) })
    }
    return c.json({ ...preview, saved: true } satisfies PolicyPreview)
  })
  /** Marks blueprints reviewed as they stand, so their fields leave the review queue. An admin's alone. */
  app.post('/v1/posture/review', async (c) => {
    onlyAdmin(c)
    const { blueprints: ids } = z.object({ blueprints: z.array(z.string().min(1)).min(1).max(1000) }).parse(await c.req.json())
    const done = await posture.markReviewed(ids, c.get('identity').name)
    if (done.length) await record(db, 'access.reviewed', done.length === 1 ? { blueprint: done[0]! } : null, null, null, { blueprints: done })
    log.info('blueprints reviewed for access', { blueprints: done.length })
    return c.json({ reviewed: done })
  })
  app.get('/v1/posture/reach', allow('posture.read'), async (c) => {
    const { kind, name } = z.object({ kind: z.enum(['person', 'token']), name: z.string().trim().min(1) }).parse(c.req.query())
    const reach = await posture.reach(kind, name)
    return reach ? c.json(reach satisfies PostureReach) : c.json({ error: `Nobody called "${name}" is here` }, 404)
  })
  app.get('/v1/posture/who', allow('posture.read'), async (c) => {
    const target = parseTarget(z.object({ target: z.string().min(1) }).parse(c.req.query()).target)
    const who = target ? await posture.who(target) : null
    return who ? c.json(who satisfies PostureWho) : c.json({ error: 'There is no such blueprint, field, or action' }, 404)
  })
  /** Who changes what by hand, blueprint by blueprint, with the standing overrides; with `person`, what the edit rules open to them. */
  app.get('/v1/posture/edits', allow('posture.read'), async (c) => {
    const { person } = z.object({ person: z.string().trim().min(1).optional() }).parse(c.req.query())
    return c.json((await posture.edits(person)) satisfies EditsResponse)
  })
  app.post('/v1/posture/change', async (c) => {
    onlyAdmin(c)
    const { change, save } = z.object({ change: postureChangeSchema, save: z.boolean().default(false) }).parse(await c.req.json())
    const plan = posture.plan(change)
    const preview = await posture.preview(plan)
    if (!save) return c.json(preview satisfies PosturePreview)
    // Each blueprint and action is saved the way its own editor saves it, so every check that guards a save guards this one.
    for (const bp of plan.blueprints.values()) {
      const { origin: _o, updatedAt: _u, restricted: _r, ...spec } = bp
      const fields = Object.fromEntries(Object.entries(spec.fields).map(([name, def]) => {
        const { restricted: _fr, ...rest } = def
        return [name, rest]
      }))
      modelEdits.checkGrants({ ...spec, fields }, bp.id)
      await blueprints.save({ ...spec, fields }, { kind: 'ui' }, actor(c), (id, field) => entities.valuesOf(id, field))
    }
    for (const a of plan.actions.values()) {
      if (a.access) modelEdits.checkGrants({}, null, a.access as AccessRule)
      const { origin, updatedAt: _u, ...spec } = a
      await actions.save(spec, origin, true)
    }
    if (plan.blueprints.size) await blueprints.syncPivots()
    visibility.refresh()
    events.emit({ type: 'blueprints' })
    if (plan.blueprints.size) runs.relink()
    for (const item of preview.items) {
      if (!item.changed || item.refused) continue
      const ref = item.target.kind === 'action' ? null : { blueprint: item.target.kind === 'field' ? item.target.blueprint : item.target.id }
      await record(db, 'access.changed', ref, null, null, { posture: true, target: item.target, gains: item.gains, loses: item.loses, gainsChange: item.gainsChange, losesChange: item.losesChange })
    }
    log.info('posture change saved', { targets: change.targets.length, blueprints: plan.blueprints.size, actions: plan.actions.size, refused: plan.refused.size })
    return c.json({ ...preview, saved: true } satisfies PosturePreview)
  })

  // People and roles ---------------------------------------------------------------

  app.get('/v1/roles', (c) => c.json({ roles: access.listRoles() } satisfies RolesResponse))
  const manageUsers = (kind: 'role.changed' | 'user.changed' | 'user.removed') => allow('users.manage', kind, { deep: true })
  app.put('/v1/roles/:id', manageUsers('role.changed'), async (c) => c.json(await access.saveRole(c.req.param('id'), await c.req.json(), c.get('identity'))))
  app.delete('/v1/roles/:id', manageUsers('role.changed'), async (c) => {
    await access.removeRole(c.req.param('id'), c.get('identity'))
    return c.json({ ok: true })
  })
  app.get('/v1/users', allow('users.manage'), async (c) => {
    const users = access.listUsers()
    return c.json({ users, people: await visibility.peopleShown(await viewOf(c), users.map((u) => u.email)) } satisfies UsersResponse)
  })
  app.post('/v1/users', manageUsers('user.changed'), async (c) => {
    const { email, roles } = z.object({ email: z.string().min(3), roles: z.array(z.string()).default([]) }).parse(await c.req.json())
    return c.json(await access.addUser(email, roles, c.get('identity')), 201)
  })
  app.put('/v1/users/:email/roles', manageUsers('user.changed'), async (c) => {
    const { roles } = z.object({ roles: z.array(z.string()) }).parse(await c.req.json())
    return c.json(await access.setRoles(c.req.param('email'), roles, c.get('identity')))
  })
  app.delete('/v1/users/:email', manageUsers('user.removed'), async (c) => {
    await access.removeUser(c.req.param('email'), c.get('identity'))
    await sources.revokeOwnedBy(access.address(c.req.param('email')))
    return c.json({ ok: true })
  })

  // Ingest -------------------------------------------------------------------------

  app.use('/v1/ingest/*', requireSource, ingest)
  const sourceOf = (c: { get: (k: 'identity') => { source?: string } }) => sources.require(c.get('identity').source!)

  // A source past its budget of changes for the hour is refused before it sends more: at the start of a run, at each
  // batch, and at each single write. What it sent and the hub took stays; a run it cannot finish is left to be abandoned.
  const heldSource = (c: { get: (k: 'identity') => { source?: string } }) => {
    const source = sourceOf(c)
    deps.budgets.hold('changes', source.id)
    return source
  }
  // People's photos: a source puts each person's, in two sizes, by the address they sign in with, and keeps them in step.
  const photoSchema = z.object({ small: z.string().min(1), large: z.string().min(1) })
  app.get('/v1/ingest/pictures', (c) => c.json({ pictures: pictures.photosOf(sourceOf(c).id) } satisfies PicturesResponse))
  app.put('/v1/ingest/pictures/:address', async (c) => {
    const source = heldSource(c)
    const body = photoSchema.parse(await c.req.json())
    const bytes = (b64: string) => new Uint8Array(Buffer.from(b64, 'base64'))
    const put = await pictures.put(c.req.param('address'), bytes(body.small), bytes(body.large), source.id)
    await sources.touch(source.id, { seen: new Date() })
    return c.json({ address: put.address, sha256: put.sha256 })
  })
  app.delete('/v1/ingest/pictures/:address', async (c) => {
    await pictures.remove(c.req.param('address'), sourceOf(c).id)
    return c.json({ ok: true })
  })
  app.post('/v1/ingest/runs', async (c) => {
    heldSource(c)
    const body = runOpenSchema.parse(await c.req.json())
    // `sightings` tells a sender this hub takes an entity named by its digest alone; one that is not told sends in full.
    return c.json({ ...(await runs.open(sourceOf(c), body.mode, body.scope, body.write)), sightings: true }, 201)
  })
  app.put('/v1/ingest/runs/:id/entities', async (c) => {
    const body = batchSchema.parse(await c.req.json())
    const result = await runs.writeBatch(c.req.param('id'), heldSource(c), body.entities as WriteInput[], body.observedAt)
    return c.json(result, result.rejected.length ? 207 : 200)
  })
  app.post('/v1/ingest/runs/:id/commit', async (c) => c.json(await runs.commit(c.req.param('id'), sourceOf(c))))
  app.post('/v1/ingest/runs/:id/fail', async (c) => {
    const { reason } = z.object({ reason: z.string().min(1) }).parse(await c.req.json())
    return c.json(await runs.fail(c.req.param('id'), sourceOf(c), reason))
  })
  app.get('/v1/ingest/runs/:id', async (c) => {
    const run = await runs.get(c.req.param('id'))
    return run ? c.json(run) : c.json({ error: 'Unknown run' }, 404)
  })

  const single = (replace: boolean) => async (c: Context<AppEnv, '/v1/ingest/entities/:blueprint/:key'>) => {
    const source = heldSource(c)
    const body = singleWriteSchema.parse(await c.req.json())
    const result = await entities.write({ ...ref(c), title: body.title, icon: body.icon, fields: body.fields, relations: body.relations }, { source, layer: source.class === 'git' ? 'git' : 'pushed', mode: body.mode, replace, observedAt: body.observedAt, scope: body.scope })
    await sources.touch(source.id, { seen: new Date() })
    if (result.outcome === 'rejected') return c.json({ error: 'rejected', errors: result.errors }, 422)
    return c.json({ outcome: result.outcome }, result.outcome === 'created' ? 201 : 200)
  }
  app.put('/v1/ingest/entities/:blueprint/:key', single(true))
  app.patch('/v1/ingest/entities/:blueprint/:key', single(false))
  app.delete('/v1/ingest/entities/:blueprint/:key', async (c) => {
    await entities.explicitDelete(ref(c), sourceOf(c))
    return c.json({ ok: true })
  })
  // A pusher brings the blueprints it writes: missing ones are created, existing ones gain the fields they lack, and only for blueprints the source is registered for.
  app.put('/v1/ingest/blueprints', async (c) => {
    const source = sourceOf(c)
    const { blueprints: offered } = z.object({ blueprints: z.array(z.record(z.string(), z.unknown())).max(200) }).parse(await c.req.json())
    const mine = offered.filter((b) => entities.allowed(source, String(b.id ?? '')))
    const refused = offered.filter((b) => !mine.includes(b)).map((b) => ({ blueprint: String(b.id ?? ''), reason: `source "${source.id}" may not write blueprint "${String(b.id ?? '')}"` }))
    for (const r of refused) {
      recordRefusal('blueprint_not_offered')
      log.warn('offered blueprint refused', { ...r, source: source.id })
    }
    const result = await blueprints.offer(mine, { kind: 'source', source: source.id }, source.id, (bp, field) => entities.valuesOf(bp, field))
    await writes.note(source.id, 'blueprint', tally([...result.created, ...result.extended, ...result.kept]))
    await sources.touch(source.id, { seen: new Date() })
    if (result.created.length || result.extended.length) events.emit({ type: 'blueprints', offered: [...result.created, ...result.extended] })
    const rejected = [...refused, ...result.rejected]
    return c.json({ created: result.created, extended: result.extended, kept: result.kept, rejected }, rejected.length ? 207 : 200)
  })
  app.post('/v1/ingest/heartbeat', async (c) => {
    const source = sourceOf(c)
    await sources.touch(source.id, { seen: new Date() })
    const meta = z.object({ version: z.string().optional(), segment: z.string().optional() }).safeParse(await c.req.json().catch(() => ({})))
    if (meta.success && (meta.data.version || meta.data.segment)) {
      await db.query(`INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = settings.value || EXCLUDED.value`, [`runner:${source.id}`, JSON.stringify(meta.data)])
    }
    if (source.class === 'runner') await runs.syncSourceEntities(source.id)
    return c.json({ ok: true, source: source.id })
  })
  app.get('/v1/ingest/runner/checks', async (c) => {
    const source = sourceOf(c)
    if (source.class !== 'runner') return c.json({ error: 'This needs a runner source' }, 403)
    await sources.touch(source.id, { seen: new Date() })
    return c.json({ runner: source.id, checks: await checks.forRunner(source.id) })
  })
  app.post('/v1/ingest/runner/results', async (c) => {
    const source = sourceOf(c)
    if (source.class !== 'runner') return c.json({ error: 'This needs a runner source' }, 403)
    const { results } = resultSchema.parse(await c.req.json())
    const n = await checks.record(source.id, results)
    await sources.touch(source.id, { seen: new Date(), run: new Date(), error: null, status: 'green', reason: null })
    await runs.syncSourceEntities(source.id)
    return c.json({ recorded: n })
  })
  app.get('/v1/ingest/runner/jobs', async (c) => {
    const source = sourceOf(c)
    if (source.class !== 'runner') return c.json({ error: 'This needs a runner source' }, 403)
    // A runner that says how many jobs it runs at once is the width a batch's time is worked out from.
    const width = Math.trunc(Number(c.req.query('width')))
    await sources.touch(source.id, { seen: new Date(), ...(width >= 1 && width <= RUNNER_WIDTH_MAX ? { width } : {}) })
    // A runner that says how long it will wait is handed a job as it is asked for, not on its next pass.
    const wait = Math.min(Math.max(Number(c.req.query('wait')) || 0, 0), JOBS_WAIT_MAX)
    // A runner that says how many it has room for is handed no more: a job handed over has started.
    const max = Math.min(Math.max(Math.trunc(Number(c.req.query('max'))) || CLAIM_MAX, 1), CLAIM_MAX)
    return c.json({ runner: source.id, jobs: await actions.claimWithin(source.id, wait * 1000, c.req.raw.signal, max) })
  })
  app.post('/v1/ingest/runner/jobs/:id/report', async (c) => {
    const source = sourceOf(c)
    if (source.class !== 'runner') return c.json({ error: 'This needs a runner source' }, 403)
    await sources.touch(source.id, { seen: new Date() })
    return c.json(await actions.report(c.req.param('id'), reportSchema.parse(await c.req.json()), { kind: 'runner', source: source.id }))
  })
  // A starter is a runner source that starts one container for each job run: it claims the runs that name it, asks how
  // the runs it claimed stand, and reports on them where a runner reports on its jobs.
  app.get('/v1/ingest/starter/jobs', async (c) => {
    const source = sourceOf(c)
    if (source.class !== 'runner') return c.json({ error: 'This needs a runner source' }, 403)
    await sources.touch(source.id, { seen: new Date() })
    const wait = Math.min(Math.max(Number(c.req.query('wait')) || 0, 0), JOBS_WAIT_MAX)
    const max = Math.min(Math.max(Math.trunc(Number(c.req.query('max'))) || CLAIM_MAX, 1), CLAIM_MAX)
    return c.json({ starter: source.id, jobs: await actions.claimJobsWithin(source.id, wait * 1000, c.req.raw.signal, max) })
  })
  app.post('/v1/ingest/starter/runs', async (c) => {
    const source = sourceOf(c)
    if (source.class !== 'runner') return c.json({ error: 'This needs a runner source' }, 403)
    await sources.touch(source.id, { seen: new Date() })
    const { seen } = starterRunsSchema.parse(await c.req.json().catch(() => ({})))
    return c.json({ starter: source.id, runs: await actions.heldBy(source.id, seen ?? []) } satisfies StarterRunsResponse)
  })
  app.post('/v1/ingest/alerts/alertmanager', async (c) => {
    const source = sourceOf(c)
    if (source.class !== 'event') return c.json({ error: 'This needs an event source' }, 403)
    const payload = alertmanagerSchema.parse(await c.req.json())
    const counts = await alerts.ingest(source, payload)
    await sources.touch(source.id, { seen: new Date(), run: new Date(), error: null, status: 'green', reason: null })
    log.info('alertmanager webhook', { source: source.id, ...counts })
    return c.json(counts)
  })
  app.post('/v1/ingest/sources/:id/refresh', async (c) => {
    const source = sourceOf(c)
    if (source.id !== c.req.param('id')) return c.json({ error: 'A source may only refresh itself' }, 403)
    return c.json(await git.refresh(source.id, 'webhook'))
  })

  // Ground --------------------------------------------------------------------------

  const grounds = new Grounds({ blueprints, reader, lists, actions, shown: (bp, view) => shown(bp, view, visibility) })
  /** The ground is a preview: to a caller it is not open to, it is not there. */
  const inGarden = async (c: Context<AppEnv>, next: () => Promise<void>) => {
    const identity = c.get('identity')
    if (!deps.previews.open('garden', identity)) {
      log.debug('ground not shown: the caller is outside its preview', { actor: identity.name })
      return c.json({ error: 'Not found' }, 404)
    }
    log.debug('ground shown: the caller is in its preview', { actor: identity.name })
    return next()
  }
  app.use('/v1/ground', inGarden)
  app.use('/v1/ground/*', inGarden)
  app.get('/v1/ground', async (c) => c.json((await grounds.index(c.get('identity'), await viewOf(c))) satisfies GroundIndexResponse))
  app.get('/v1/ground/:blueprint', async (c) => {
    const ground = await grounds.of(c.get('identity'), await viewOf(c), c.req.param('blueprint'))
    if (!ground) return c.json({ error: `Blueprint "${c.req.param('blueprint')}" has no ground` }, 404)
    return c.json(ground satisfies GroundResponse)
  })
  app.get('/v1/ground/:blueprint/:key', async (c) => {
    const item = await grounds.item(c.get('identity'), await viewOf(c), ref(c))
    if (!item) return c.json({ error: 'Unknown entity' }, 404)
    return c.json(item satisfies GroundItemResponse)
  })
  // A map is part of the same preview: the planet the ground's gardens grow on.
  const maps = new Maps({ blueprints, reader, lists, scorecards, actions, log, owned: (who) => visibility.ownedKept(who), ownedReads: () => visibility.ownedReads(), shown: (bp, view) => shown(bp, view, visibility) })
  app.use('/v1/map', inGarden)
  app.use('/v1/map/*', inGarden)
  app.get('/v1/map', async (c) => c.json((await maps.index(c.get('identity'), await viewOf(c))) satisfies MapIndexResponse))
  app.get('/v1/map/:blueprint/:key', async (c) => {
    const map = await maps.of(c.get('identity'), await viewOf(c), ref(c))
    if (!map) return c.json({ error: 'No map of this entity' }, 404)
    return c.json(map satisfies MapResponse)
  })
  // A person's walk through a map: theirs alone, as their pins are, so no permission opens it and no activity row is
  // written. It lives in the garden preview with the map. A stop names ids only; the map, read through the caller's
  // view, is what shows any of them, so a stop never says more than the reader may see.
  app.use('/v1/mine/walk/*', inGarden)
  const walker = (c: Context<AppEnv>) => {
    const who = personAsking(c)
    if (who) return who
    recordRefusal('permission')
    log.info('walk refused: not a person', { actor: c.get('identity').name, kind: c.get('identity').kind, method: c.req.method })
    return null
  }
  const noWalk = (c: Context<AppEnv>) => c.json({ error: 'A walk is for a person: a machine keeps none' }, 403)
  /** The map a walk is through: a blueprint that names one and that the caller sees. */
  const walkMap = async (c: Context<AppEnv>, map: EntityRef): Promise<EntityRef | null> => {
    const bp = blueprints.get(map.blueprint)
    return bp?.map && (await viewOf(c)).seesBlueprint(bp.id) ? map : null
  }
  app.get('/v1/mine/walk/:blueprint/:key', async (c) => {
    const who = walker(c)
    if (!who) return noWalk(c)
    const map = await walkMap(c, ref(c))
    if (!map) return c.json({ error: 'No map of this entity' }, 404)
    return c.json({ steps: await walks.of(who, map) } satisfies WalkResponse)
  })
  app.post('/v1/mine/walk/:blueprint/:key', async (c) => {
    const who = walker(c)
    if (!who) return noWalk(c)
    const map = await walkMap(c, ref(c))
    if (!map) return c.json({ error: 'No map of this entity' }, 404)
    const step = walkStepSchema.parse(await c.req.json())
    if (await walks.add(who, map, step)) sendUsage(WALK_STEP_ADDED, c.get('identity'), { ladder: step.ladder })
    return c.json({ steps: await walks.of(who, map) } satisfies WalkResponse)
  })
  app.delete('/v1/mine/walk/:blueprint/:key/:id', async (c) => {
    const who = walker(c)
    if (!who) return noWalk(c)
    const map = await walkMap(c, ref(c))
    if (!map) return c.json({ error: 'No map of this entity' }, 404)
    if (await walks.remove(who, map, c.req.param('id'))) sendUsage(WALK_STEP_REMOVED, c.get('identity'), {})
    return c.json({ steps: await walks.of(who, map) } satisfies WalkResponse)
  })

  // MCP ----------------------------------------------------------------------------

  const mcp = createMcpHandler({ model: modelEdits, queries, datasets, blueprints, reader, findings, sources, db, scorecards, actions, changeSets, visibility, reports, version: deps.version, summary: async (view) => summary(reader, blueprints, sources, findings, alerts, view, await counts()), load: loadOver, budgets: { get: () => deps.budgets.get(), set: setBudgets }, grounds, maps, previews: deps.previews, preferences: deps.preferences })
  app.all('/mcp', (c) => mcp(c))

  // The machine surface has no web app: a token cannot sign a person in. A
  // caller that lands on its root is sent to the spec that explains the API.
  app.get('/', (c, next) => (c.env.surface === 'machine' ? c.redirect('/v1/openapi.json') : next()))

  // Web app ----------------------------------------------------------------------

  if (deps.webDir) {
    const index = readFileSync(`${deps.webDir}/index.html`, 'utf8')
    const assets = serveStatic({ root: deps.webDir, rewriteRequestPath: (p) => p })
    app.use('/*', (c, next) => (servesWebApp(c.env.surface, c.req.path) ? assets(c, next) : next()))
    app.get('*', (c) => (answersWithPage(c.env.surface, c.req.path) ? c.html(index) : c.json({ error: 'Not found' }, 404)))
  }

  return app
}

/**
 * Whether a path the API does not answer gets the web app. The machine
 * surface has none, and the API, the ingest routes, and the well-known
 * discovery paths answer JSON on either surface: an MCP client reads a page
 * there as an answer and stops.
 */
export function servesWebApp(surface: Surface, path: string): boolean {
  if (surface === 'machine') return false
  return !['/v1/', '/.well-known/'].some((prefix) => path.startsWith(prefix))
}

/**
 * Whether a path no file answers gets the app's page, for the app to route.
 * A built file that is not here is a 404, never the page: a browser holding
 * another release's page asks for files this one lacks, and must see it fail.
 */
export function answersWithPage(surface: Surface, path: string): boolean {
  return servesWebApp(surface, path) && !path.startsWith('/assets/')
}

/** Whether an If-None-Match header names this tag, weak or strong, or any. */
function etagMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false
  return header.split(',').some((tag) => {
    const t = tag.trim()
    return t === '*' || t.replace(/^W\//, '') === etag
  })
}

/** The origin the caller used, as the ingress forwarded it. */
/**
 * Where the caller is, only when they are a person who signed in and calls
 * for themselves: from the browser, on the session port, with no token and
 * not viewing as someone else. Every other caller is given none, so nothing
 * a schedule, a batch, a product, or a token asks for carries an address.
 */
function ownAddress(c: Context<AppEnv>): string | undefined {
  const id = c.get('identity')
  return c.env.surface === 'session' && id?.kind === 'user' && !id.token && !id.viewAs ? c.get('address') : undefined
}

function origin(c: Context<AppEnv>): string {
  const url = new URL(c.req.url)
  const proto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim() || url.protocol.replace(':', '')
  const host = c.req.header('x-forwarded-host')?.split(',')[0]?.trim() || c.req.header('host') || url.host
  return `${proto}://${host}`
}

/** Names blueprints the way the web app does, among the ones this reader sees. */
export function namedFor(blueprints: Blueprints, view: View): BlueprintNamer {
  return blueprintNamer(blueprints.list().filter((b) => view.seesSome(b.id)))
}

/** The rows of every blueprint shown on the wall, as everyone sees them: read once for every reader, who each get a cut. */
async function wallOfEstate(reader: Reader, blueprints: Blueprints): Promise<Map<string, Entity[]>> {
  const shown = blueprints.list().filter((bp) => bp.wall)
  const read = await Promise.all(shown.map(async (bp) => [bp.id, (await reader.list({ blueprint: bp.id, limit: 5000 })).entities] as const))
  return new Map(read)
}

/** The wall as one reader sees it: the blueprints they may see, each row through their view. */
function wall(estate: Map<string, Entity[]>, blueprints: Blueprints, sources: Sources, view: View): WallResponse {
  const groups: WallResponse['groups'] = []
  const named = namedFor(blueprints, view)
  for (const bp of blueprints.list()) {
    const rows = estate.get(bp.id)
    if (!rows || !view.seesBlueprint(bp.id)) continue
    const entities = view.all ? rows : view.entities(rows)
    groups.push({ blueprint: bp.id, title: named(bp), cells: entities.map((e) => ({ entity: { blueprint: e.blueprint, key: e.key }, title: e.title, level: e.status.level, reasons: e.status.reasons })) })
  }
  // Sources are entities of a blueprint like any other: a reader who may not see it is shown none.
  return { groups, sources: view.seesBlueprint(SOURCE_BLUEPRINT) ? sources.list() : [] }
}

export async function summary(reader: Reader, blueprints: Blueprints, sources: Sources, findings: Findings, alerts: Alerts, view: View, estate: EstateCounts): Promise<SummaryResponse> {
  // The findings and the alerts are each an answer of their own that waits on nothing here, so both are asked for
  // beside the reader's cut of the estate rather than after it.
  const [cut, found, firing] = await Promise.all([summaryOfEstate(reader, blueprints, view, estate), findings.list(), alerts.list()])
  return {
    generatedAt: new Date().toISOString(),
    ...cut,
    staleSources: sources
      .list()
      .filter((s) => s.status !== 'green')
      .map((s) => ({ id: s.id, status: s.status, reason: s.statusReason })),
    findings: counted(view.findings(found)),
    alertsFiring: view.alerts(firing).length,
  }
}

/** How many there are and how many are not green, by blueprint, and the worst of each: the same for every reader, so counted once. */
export interface EstateCounts {
  byBlueprint: Map<string, { active: number; missing: number }>
  notGreen: Map<string, NotGreenCounts>
  /** Each blueprint's hundred worst, with `place` their order among every blueprint's, worst first. */
  worst: { blueprint: string; key: string; place: number }[]
  lastChangeAt: string | null
}

/**
 * Counted in Postgres from the stored rows, so the summary costs what is not
 * green, never the estate. A level is the same whoever reads it, so every
 * reader's summary is cut from this: the hundred worst any reader is shown
 * are among the hundred worst of each blueprint they see.
 */
export async function estateCounts(db: Db): Promise<EstateCounts> {
  const notGreenWhere = `FROM derived d JOIN entities e ON e.blueprint = d.blueprint AND e.key = d.key WHERE d.level <> 'green' AND e.state IN ('active','missing') AND NOT e.hidden`
  const severity = `CASE d.level WHEN 'red' THEN 0 WHEN 'amber' THEN 1 ELSE 2 END`
  const [counts, tally, worst, last] = await Promise.all([
    db.query<{ blueprint: string; state: string; n: string }>(`SELECT blueprint, state, count(*)::text AS n FROM entities WHERE state IN ('active','missing') AND hidden = false GROUP BY blueprint, state`),
    db.query<{ blueprint: string; level: 'red' | 'amber' | 'grey'; n: string }>(`SELECT e.blueprint, d.level, count(*)::text AS n ${notGreenWhere} GROUP BY 1, 2`),
    db.query<{ blueprint: string; key: string; place: string }>(
      `SELECT blueprint, key, place::text FROM (SELECT e.blueprint, e.key, row_number() OVER (PARTITION BY e.blueprint ORDER BY ${severity}, e.title, e.key) AS within, row_number() OVER (ORDER BY ${severity}, e.blueprint, e.title, e.key) AS place ${notGreenWhere}) w WHERE within <= 100`,
    ),
    db.query<{ at: Date }>('SELECT at FROM changes ORDER BY at DESC LIMIT 1'),
  ])
  const byBlueprint = new Map<string, { active: number; missing: number }>()
  for (const r of counts.rows) {
    const cur = byBlueprint.get(r.blueprint) ?? { active: 0, missing: 0 }
    if (r.state === 'active') cur.active = Number(r.n)
    else cur.missing = Number(r.n)
    byBlueprint.set(r.blueprint, cur)
  }
  const notGreen = new Map<string, NotGreenCounts>()
  for (const r of tally.rows) {
    const n = notGreen.get(r.blueprint) ?? { red: 0, amber: 0, grey: 0 }
    n[r.level] = Number(r.n)
    notGreen.set(r.blueprint, n)
  }
  return { byBlueprint, notGreen, worst: worst.rows.map((r) => ({ blueprint: r.blueprint, key: r.key, place: Number(r.place) })), lastChangeAt: last.rows[0]?.at.toISOString() ?? null }
}

/**
 * One reader's cut of the estate's counts: only what they may see at all, and
 * the hundred worst named, through their view, which withholds a reason fed by
 * something they may not see. A blueprint they see only as an owner counts
 * their own, as its listing does: its rows are read by level alone, and only
 * the ones not green, or whose stored row is not current, are read whole.
 */
async function summaryOfEstate(reader: Reader, blueprints: Blueprints, view: View, estate: EstateCounts): Promise<Pick<SummaryResponse, 'blueprints' | 'notGreen' | 'lastChangeAt'>> {
  const seen = blueprints.list().filter((bp) => view.seesBlueprint(bp.id))
  const sees = new Set(seen.map((bp) => bp.id))
  const ownOnly = view.all ? [] : blueprints.list().filter((bp) => !sees.has(bp.id) && (view.oneByOne(bp.id)?.size ?? 0) > 0)
  const ownRefs = ownOnly.flatMap((bp) => [...view.oneByOne(bp.id)!].map(parseEntityId).filter((r): r is EntityRef => !!r))
  // Every blueprint's count of what is not green, and the worst first: a red past the hundredth is still named.
  const picked = estate.worst.filter((w) => sees.has(w.blueprint)).sort((a, b) => a.place - b.place).slice(0, 100)
  const place = new Map(picked.map((w) => [`${w.blueprint}:${w.key}`, w.place]))
  const severity = { red: 0, amber: 1, grey: 2, green: 3 }
  const levels = await reader.levelsOf(ownRefs)
  const [named100, ownRead] = await Promise.all([reader.hydrated(picked), reader.hydrated(levels.filter((l) => l.level !== 'green').map((l) => l.ref))])
  const ownLevel = new Map(levels.map((l) => [entityId(l.ref), l.level]))
  for (const e of ownRead) ownLevel.set(e.id, e.status.level)
  const owned = new Map<string, { active: number; missing: number; notGreen: NotGreenCounts }>()
  for (const l of levels) {
    const b = owned.get(l.ref.blueprint) ?? { active: 0, missing: 0, notGreen: { red: 0, amber: 0, grey: 0 } }
    b[l.state]++
    const level = ownLevel.get(entityId(l.ref)) ?? 'grey'
    if (level !== 'green') b.notGreen[level]++
    owned.set(l.ref.blueprint, b)
  }
  const notGreen = view
    .entities([...named100, ...ownRead].filter((e) => e.status.level !== 'green'))
    .sort((a, b) => severity[a.status.level] - severity[b.status.level] || (place.get(a.id) ?? Infinity) - (place.get(b.id) ?? Infinity) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id))
    .slice(0, 100)
  const named = namedFor(blueprints, view)
  const none = { active: 0, missing: 0, notGreen: { red: 0, amber: 0, grey: 0 } }
  return {
    blueprints: [
      ...seen.map((bp) => ({ id: bp.id, title: named(bp), description: bp.description, ...(estate.byBlueprint.get(bp.id) ?? { active: 0, missing: 0 }), notGreen: estate.notGreen.get(bp.id) ?? { red: 0, amber: 0, grey: 0 } })),
      ...ownOnly.map((bp) => ({ id: bp.id, title: named(bp), description: bp.description, ...(owned.get(bp.id) ?? none) })),
    ],
    notGreen: notGreen.map((e) => ({ entity: { blueprint: e.blueprint, key: e.key }, title: e.title, level: e.status.level, reasons: e.status.reasons })),
    lastChangeAt: estate.lastChangeAt,
  }
}

/** How many of one kind of the reader's own things `/v1/mine?blueprint=` reads whole, worst first. */
export const MINE_KIND_MAX = 200

/**
 * What is the reader's own: only their own things are read, and each goes
 * through the reader's view, so a thing they may not see is never counted.
 * `green: false` leaves the green ones out of `things`; `kind` reads only that
 * blueprint's, green ones too, at most `MINE_KIND_MAX` of them whole.
 */
export async function yours(reader: Reader, view: View, owned: Awaited<ReturnType<Visibility['owned']>>, opts: { green?: boolean; kind?: string } = {}): Promise<MineResponse> {
  const green = opts.green ?? true
  if (owned.state !== 'known') return { seesAll: view.all, state: owned.state, person: null, things: [], count: 0, blueprints: {} }
  // Only the rows that are theirs are read, never the rest of the lists they sit in; each goes through the reader's
  // view, which drops a blueprint they may not see and withholds what they may not read of the rest.
  const refs = [...owned.ids.keys()].map(parseEntityId).filter((r): r is EntityRef => !!r && (!opts.kind || r.blueprint === opts.kind) && view.seesEntity(r))
  const severity = { red: 0, amber: 1, grey: 2, green: 3 }
  // Every one is counted by the level its stored row holds; only what is shown is read whole, and one whose stored row is not current is read to learn its level.
  const levels = await reader.levelsOf(refs)
  const wanted = levels.filter((l) => l.level === null || green || l.level !== 'green')
  // One kind may hold thousands of a person's things: the worst are read whole, the rest only counted.
  const toRead = opts.kind ? wanted.sort((a, b) => (a.level === null ? -1 : severity[a.level]) - (b.level === null ? -1 : severity[b.level])).slice(0, MINE_KIND_MAX) : wanted
  const read = (await reader.hydrated(toRead.map((l) => l.ref))).filter((e) => !e.hidden)
  // Ties on level and title fall to the blueprint and then the key, so the order is the same however the reads arrive.
  const theirs = view.entities(read).sort((a, b) => severity[a.status.level] - severity[b.status.level] || a.title.localeCompare(b.title) || a.blueprint.localeCompare(b.blueprint) || a.key.localeCompare(b.key))
  const blueprints: MineResponse['blueprints'] = {}
  const tally = (ref: EntityRef, level: StatusLevel) => {
    const b = (blueprints[ref.blueprint] ??= { count: 0, notGreen: { red: 0, amber: 0, grey: 0 }, as: {} })
    b.count++
    if (level !== 'green') b.notGreen[level]++
    const as = (b.as ??= {})
    for (const role of owned.ids.get(entityId(ref)) ?? []) as[role] = (as[role] ?? 0) + 1
  }
  for (const e of theirs) tally(e, e.status.level)
  const readIds = new Set(read.map((e) => e.id))
  for (const l of levels) if (l.level !== null && !readIds.has(entityId(l.ref))) tally(l.ref, l.level)
  const shown = green ? theirs : theirs.filter((e) => e.status.level !== 'green')
  // Only the person's title is shown: their own stored row alone, not with its relations and history.
  const [self] = view.seesBlueprint(owned.person.blueprint) ? await reader.hydrated([owned.person]) : []
  const me = self && view.entity(self)
  return {
    seesAll: view.all,
    state: 'known',
    person: me ? { entity: owned.person, title: me.title } : null,
    things: shown.map((e) => ({ entity: { blueprint: e.blueprint, key: e.key }, title: e.title, level: e.status.level, reasons: e.status.reasons, as: owned.ids.get(e.id) ?? [] })),
    count: Object.values(blueprints).reduce((n, b) => n + b.count, 0),
    blueprints,
  }
}

function counted(list: Finding[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const f of list) out[f.kind] = (out[f.kind] ?? 0) + 1
  return out
}

/** How many of a person's own entities of one blueprint are read to count what they could fill in. */
const FILL_READS = 2000



export { entityId }
