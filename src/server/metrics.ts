// The hub's metrics, sent over OTLP when OTEL_EXPORTER_OTLP_ENDPOINT is set,
// and the field gauge to Application Insights as custom metrics when
// APPLICATIONINSIGHTS_CONNECTION_STRING is. Without either the global meter is
// a no-op, so tests and local runs record nothing. Names follow OpenTelemetry's semantic conventions where one exists
// and `orrery.<what>` where none does. Every label is a fixed set of values:
// a route pattern, a table, a task name, never an entity or a person.

import { AsyncLocalStorage } from 'node:async_hooks'
import { hostname } from 'node:os'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { metrics, type Counter, type Histogram } from '@opentelemetry/api'
import type { ViewOptions } from '@opentelemetry/sdk-metrics'
import type pg from 'pg'
import { Agent, fetch as patientFetch } from 'undici'
import type { BrowserMeasure, EventSource } from '../shared/usage.ts'
import type { Logger } from './log.ts'
import type { Surface } from './auth.ts'

/** How a request's sign-in ended: let in, refused as unknown, or a token whose person has gone. */
export type AuthOutcome = 'ok' | 'refused' | 'revoked'

/** Why the hub turned a request down on policy. A fixed list: the reason is a label. */
export const REFUSALS = ['permission', 'view_as', 'action_rule', 'hidden_field', 'hand_edit', 'foreign_write', 'blueprint_not_offered', 'over_budget'] as const
export type Refusal = (typeof REFUSALS)[number]

/** Who the hub calls out to, as the label an outbound call is timed under: never a host, which a webhook or a check could make anything. */
export type Peer = 'github' | 'webhook' | 'check' | 'issuer' | 'dispatch' | 'annals' | 'faro'

/** What a browser batch came to: relayed to the collector, dropped for want of a key, or failed on the way. */
export type BatchOutcome = 'relayed' | 'dropped' | 'failed'

/** What a timed piece of hub work is called on the dashboard. */
export type Task =
  | 'rules.relink'
  | 'rules.evaluate'
  | 'rules.inherit'
  | 'lifecycle.tick'
  | 'listing.build'
  | 'memo.build'
  | 'findings'
  | 'snapshot.commit'
  | 'entities.write'
  | 'git.refresh'
  | 'annals.forward'
  | 'notices.forward'
  | 'posture'
  | 'posture.people'
  | 'posture.handmade'
  | 'hub.catch_up'
  | 'hub.reload'
  | 'derive.drain'
  | 'derive.inline'
  | 'derive.backfill'
  | 'derive.reconcile'
  | 'derive.clock'
  | 'map.build'
  | 'map.index'
  | 'columns.measure'
  | 'ownership.walk'
  | 'ownership.look'
  | 'visibility.about'
  | 'stars.read'

interface Instruments {
  request: Histogram
  client: Histogram
  query: Histogram
  task: Histogram
  kept: Counter
  annals: Counter
  auth: Counter
  refusals: Counter
  usage: Counter
  agent: Counter
  answer: Histogram
  views: Counter
  browserErrors: Counter
  batches: Counter
  wait: Histogram
  shift: Histogram
  actionRuns: Counter
  actionDuration: Histogram
}

/** The buckets of a run's time: a ping takes seconds, a reboot followed to its end takes minutes. */
const RUN_SECONDS = [1, 2, 5, 10, 30, 60, 120, 300, 600, 1800, 3600]
const SECONDS = [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60]
/** The buckets of a person's wait: the standard's objective, 1 s, and its limit, 4 s, are edges, so both read straight off the dashboard. */
const WAIT_SECONDS = [0.05, 0.1, 0.25, 0.5, 1, 2, 4, 8, 16]
const ANSWER_BYTES = [1_000, 4_000, 16_000, 32_000, 64_000, 128_000, 256_000, 1_000_000, 4_000_000]
/** A query slower than this writes a warning, so one slow statement is found by name. */
const SLOW_QUERY_MS = 1000
/** The tables a query is counted against; anything else is `other`, so a label never grows. */
const TABLES = new Set(['blueprints', 'entities', 'relations', 'derived', 'derive_queue', 'sources', 'tokens', 'runs', 'changes', 'relation_rules', 'grid_layouts', 'settings', 'scorecards', 'scorecard_history', 'field_history', 'secrets', 'check_results', 'alerts', 'alert_rules', 'users', 'roles', 'actions', 'action_runs'])
const VERBS = new Set(['select', 'insert', 'update', 'delete', 'with', 'begin', 'commit', 'rollback', 'truncate', 'create', 'alter'])

let made: Instruments | null = null

/** The instruments, made from the global meter the first time anything records. */
function instruments(): Instruments {
  if (made) return made
  const meter = metrics.getMeter('orrery')
  made = {
    request: meter.createHistogram('http.server.request.duration', { unit: 's', description: 'How long the hub took to answer a request, by surface, route pattern, method, and status.', advice: { explicitBucketBoundaries: SECONDS } }),
    query: meter.createHistogram('db.client.operation.duration', { unit: 's', description: 'How long one Postgres statement took, by verb and the first table it names.', advice: { explicitBucketBoundaries: SECONDS } }),
    task: meter.createHistogram('orrery.task.duration', { unit: 's', description: 'How long a piece of hub work took: a re-link pass, a listing, findings, a commit, by task and outcome.', advice: { explicitBucketBoundaries: SECONDS } }),
    kept: meter.createCounter('orrery.kept.lookups', { description: 'Questions asked of the kept answers, by kind and whether one was kept.' }),
    annals: meter.createCounter('orrery.annals.events', { description: 'Activity rows sent to Annals, by what it answered: stored, duplicate, refused, error, or failed when the post itself failed.' }),
    client: meter.createHistogram('http.client.request.duration', { unit: 's', description: 'How long a call the hub made took, by who it called and the status it answered.', advice: { explicitBucketBoundaries: SECONDS } }),
    auth: meter.createCounter('orrery.auth', { description: 'How each request signed in, by surface and outcome: let in, refused as unknown or not signed in, or a token whose person is no longer here.' }),
    refusals: meter.createCounter('orrery.refusals', { description: 'Requests the hub turned down on policy, by reason: a permission not held, a hidden field read, a hand edit of what access is decided from, a write a source does not own.' }),
    usage: meter.createCounter('orrery.usage.events', { description: 'Usage events, by name and the side that sent them: what people and agents did on purpose.' }),
    agent: meter.createCounter('orrery.agent.calls', { description: 'MCP tool calls, by tool.' }),
    answer: meter.createHistogram('orrery.agent.answer.size', { unit: 'By', description: 'How big an MCP tool call\'s answer was, by tool: every answer an agent reads goes into its model.', advice: { explicitBucketBoundaries: ANSWER_BYTES } }),
    views: meter.createCounter('orrery.browser.views', { description: 'Pages opened in the web app, by page.' }),
    browserErrors: meter.createCounter('orrery.browser.errors', { description: 'Errors a page did not catch.' }),
    batches: meter.createCounter('orrery.browser.batches', { description: 'Browser telemetry batches, by what became of them: relayed to the collector, dropped for want of a key, or failed.' }),
    wait: meter.createHistogram('orrery.browser.wait', { unit: 's', description: "How long a person waited, by page and measure: `wait` from what they did until the answer was on screen, `ready` to the first useful screen, and the web vitals `lcp` and `inp`.", advice: { explicitBucketBoundaries: WAIT_SECONDS } }),
    actionRuns: meter.createCounter('orrery.action.runs', { description: 'Action runs that ended, by action, what asked them (alone, a batch, or a schedule), and how they ended.' }),
    actionDuration: meter.createHistogram('orrery.action.run.duration', { unit: 's', description: 'How long an action run took, started to finished, by action and what asked it.', advice: { explicitBucketBoundaries: RUN_SECONDS } }),
    shift: meter.createHistogram('orrery.browser.shift', { description: 'Cumulative layout shift of a page, by page.', advice: { explicitBucketBoundaries: [0.01, 0.05, 0.1, 0.25, 0.5, 1] } }),
  }
  return made
}

let exporting = false
/** The release running, as the label every request is timed under, so a board compares one release's routes with the one before. */
let release = 'unknown'

/** Whether metrics leave the hub over OTLP: the web app reports its waits only when something keeps them. */
export function metricsOn(): boolean {
  return exporting
}

/** The gauge of the fields marked `metric`, the one metric Application Insights is sent. */
export const FIELD_GAUGE = 'orrery.field.value'

/**
 * The SDK keeps 2,000 series an instrument and folds the rest into one
 * overflow series. The field gauge has a series for every entity of a field
 * an architect marked, so it is held to no such count.
 */
export const METER_VIEWS: ViewOptions[] = [{ instrumentName: FIELD_GAUGE, aggregationCardinalityLimit: Number.POSITIVE_INFINITY }]

/**
 * Starts the OTLP exporter when OTEL_EXPORTER_OTLP_ENDPOINT is set, and the
 * Application Insights one, for the field gauge alone, when
 * APPLICATIONINSIGHTS_CONNECTION_STRING is. Call it before the hub is made,
 * so every instrument comes from the exporting meter.
 */
export async function startMetrics(log: Logger, version: string, env: Record<string, string | undefined> = process.env): Promise<{ flush(): Promise<void>; shutdown(): Promise<void> }> {
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT ?? env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT
  const connection = env.APPLICATIONINSIGHTS_CONNECTION_STRING?.trim()
  if (!endpoint && !connection) {
    log.info('metrics off', { reason: 'neither OTEL_EXPORTER_OTLP_ENDPOINT nor APPLICATIONINSIGHTS_CONNECTION_STRING is set' })
    return { flush: async () => undefined, shutdown: async () => undefined }
  }
  const { MeterProvider, PeriodicExportingMetricReader } = await import('@opentelemetry/sdk-metrics')
  const { detectResources, envDetector, resourceFromAttributes } = await import('@opentelemetry/resources')
  const resource = resourceFromAttributes({ 'service.name': 'orrery', 'service.version': version, 'service.instance.id': hostname() }).merge(detectResources({ detectors: [envDetector] }))
  const readers: InstanceType<typeof PeriodicExportingMetricReader>[] = []
  if (endpoint) {
    const { OTLPMetricExporter } = await import('@opentelemetry/exporter-metrics-otlp-http')
    readers.push(new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter(), exportIntervalMillis: 30_000 }))
    exporting = true
    log.info('metrics on over otlp', { endpoint, service: env.OTEL_SERVICE_NAME ?? 'orrery', version })
  } else log.info('metrics not sent over otlp', { reason: 'OTEL_EXPORTER_OTLP_ENDPOINT not set' })
  if (connection) {
    const { AppInsightsMetricExporter, Ingestion, parseConnectionString } = await import('./appinsights.ts')
    const ingestion = new Ingestion(parseConnectionString(connection), log)
    readers.push(new PeriodicExportingMetricReader({ exporter: new AppInsightsMetricExporter(ingestion, new Set([FIELD_GAUGE])), exportIntervalMillis: 60_000 }))
    log.info('field gauge on to application insights', { endpoint: ingestion.destination.endpoint, metric: FIELD_GAUGE })
  } else log.info('field gauge not sent to application insights', { reason: 'APPLICATIONINSIGHTS_CONNECTION_STRING not set' })
  const provider = new MeterProvider({ resource, readers, views: METER_VIEWS })
  metrics.setGlobalMeterProvider(provider)
  return { flush: () => provider.forceFlush(), shutdown: () => provider.shutdown() }
}

/**
 * Reports every entity's value of every field marked `metric` at each
 * collection, labelled by blueprint, field, and key: the one metric whose
 * labels name entities, so only a field an architect marks is exported.
 * `read` is one pass over what the read side keeps.
 */
export function observeFields(read: () => Promise<{ blueprint: string; field: string; key: string; value: number }[]>, log: Logger): void {
  metrics
    .getMeter('orrery')
    .createObservableGauge(FIELD_GAUGE, { description: "A field marked metric: its value on one entity, a number as it is and an enum as its value's place among the field's values." })
    .addCallback(async (r) => {
      try {
        for (const p of await read()) r.observe(p.value, { blueprint: p.blueprint, field: p.field, key: p.key })
      } catch (error) {
        log.warn('field gauge not read', { error })
      }
    })
}

/** Reports the release, the connection pool, and the Node process at each export. */
export function observeProcess(pool: pg.Pool, version: string): void {
  const meter = metrics.getMeter('orrery')
  const loop = monitorEventLoopDelay({ resolution: 10 })
  loop.enable()
  meter.createObservableGauge('orrery.build_info', { description: 'Always 1; the version label is the release running now.' }).addCallback((r) => r.observe(1, { version }))
  meter.createObservableGauge('db.client.connection.count', { description: 'Postgres connections the hub holds, by state.' }).addCallback((r) => {
    r.observe(pool.idleCount, { 'db.client.connection.state': 'idle' })
    r.observe(pool.totalCount - pool.idleCount, { 'db.client.connection.state': 'used' })
  })
  meter.createObservableGauge('db.client.connection.pending_requests', { description: 'Queries waiting for a free Postgres connection.' }).addCallback((r) => r.observe(pool.waitingCount))
  meter.createObservableGauge('nodejs.eventloop.delay.p99', { unit: 's', description: 'How late the event loop ran its timers since the last export, 99th percentile. High means the hub was busy computing.' }).addCallback((r) => {
    r.observe(loop.percentile(99) / 1e9)
  })
  meter.createObservableGauge('nodejs.eventloop.delay.max', { unit: 's', description: 'The longest the event loop was held since the last export.' }).addCallback((r) => {
    r.observe(loop.max / 1e9)
    loop.reset()
  })
  meter.createObservableGauge('process.memory.usage', { unit: 'By', description: 'Memory the hub holds, by kind: rss, heap used, heap total, external.' }).addCallback((r) => {
    const m = process.memoryUsage()
    r.observe(m.rss, { 'process.memory.kind': 'rss' })
    r.observe(m.heapUsed, { 'process.memory.kind': 'heap_used' })
    r.observe(m.heapTotal, { 'process.memory.kind': 'heap_total' })
    r.observe(m.external, { 'process.memory.kind': 'external' })
  })
  meter.createObservableCounter('process.cpu.time', { unit: 's', description: 'CPU time the hub used, by user and system.' }).addCallback((r) => {
    const cpu = process.cpuUsage()
    r.observe(cpu.user / 1e6, { 'process.cpu.state': 'user' })
    r.observe(cpu.system / 1e6, { 'process.cpu.state': 'system' })
  })
}

export function recordRequest(seconds: number, attrs: { surface: string; route: string; method: string; status: number }): void {
  instruments().request.record(seconds, { 'orrery.surface': attrs.surface, 'http.route': attrs.route, 'http.request.method': attrs.method, 'http.response.status_code': attrs.status, 'orrery.version': release })
}

/**
 * Starts every usage event's count, every refusal reason's, and every agent
 * tool's at zero, so what never happens is a series at zero on the board,
 * not a name missing from it: that is how the board lists what nobody uses.
 */
export function seedCounts(names: { event: string; source: EventSource }[], tools: readonly string[]): void {
  for (const n of names) instruments().usage.add(0, { 'orrery.event': n.event, 'orrery.source': n.source })
  for (const reason of REFUSALS) instruments().refusals.add(0, { 'orrery.reason': reason })
  for (const tool of tools) instruments().agent.add(0, { 'orrery.tool': tool })
}

/** Counts how a request signed in. */
export function recordAuth(surface: Surface, outcome: AuthOutcome): void {
  instruments().auth.add(1, { 'orrery.surface': surface, 'orrery.outcome': outcome })
}

/** Counts a request the hub turned down on policy. */
export function recordRefusal(reason: Refusal): void {
  instruments().refusals.add(1, { 'orrery.reason': reason })
}

/** Counts a usage event by its name: the names are the fixed list in `src/shared/usage.ts`. */
export function recordUsage(event: string, source: EventSource): void {
  instruments().usage.add(1, { 'orrery.event': event, 'orrery.source': source })
}

/** Counts an agent's tool call by the tool: one of the hub's own, or `unknown` for a name the caller made up. */
export function recordAgentCall(tool: string): void {
  instruments().agent.add(1, { 'orrery.tool': tool })
}

/** How big the answer to one agent's tool call was, by the tool as `recordAgentCall` names it. */
export function recordAgentAnswer(tool: string, bytes: number): void {
  instruments().answer.record(bytes, { 'orrery.tool': tool })
}

/** Counts a page a person opened, by the page's name, one of the web app's fixed list. */
export function recordView(page: string): void {
  instruments().views.add(1, { 'orrery.page': page })
}

/** Counts an error a page did not catch. */
export function recordBrowserError(): void {
  instruments().browserErrors.add(1)
}

/** Counts what became of a browser batch. */
export function recordBatch(outcome: BatchOutcome): void {
  instruments().batches.add(1, { 'orrery.outcome': outcome })
}

/** Records how a page felt: a wait in seconds under its measure, or a layout shift. */
export function recordMeasure(measure: BrowserMeasure, page: string, value: number): void {
  if (measure === 'cls') instruments().shift.record(value, { 'orrery.page': page })
  else instruments().wait.record(value, { 'orrery.page': page, 'orrery.measure': measure })
}

/**
 * The client a call that may wait long for its answer goes through: it sets
 * no limit of its own on the answer or its body, so the caller's signal alone
 * ends the call, and it probes the connection while it waits, so nothing on
 * the way drops it as idle. Node's own fetch ends any answer after five
 * minutes whatever the signal says, and takes no client of another release
 * of undici, so such a call goes through this release's own fetch.
 */
const PATIENT = new Agent({ headersTimeout: 0, bodyTimeout: 0, connect: { keepAlive: true, keepAliveInitialDelay: 30_000 } })

/** What a patient call sends. */
export interface PatientInit {
  method: string
  headers: Record<string, string>
  body?: string
  signal: AbortSignal
}

/** What a call is answered, read the same from either client. */
export interface Answer {
  ok: boolean
  status: number
  text(): Promise<string>
  json(): Promise<unknown>
}

/** Times a call out under who was called and what they answered. A call that never answers is counted with status 0. */
async function timedCall<T extends { status: number }>(peer: Peer, call: () => Promise<T>): Promise<T> {
  const started = performance.now()
  let status = 0
  try {
    const res = await call()
    status = res.status
    return res
  } finally {
    instruments().client.record((performance.now() - started) / 1000, { 'orrery.peer': peer, 'http.response.status_code': status })
  }
}

/** Calls out, timed. */
export function fetchTimed(peer: Peer, input: string | URL, init?: RequestInit): Promise<Response> {
  return timedCall(peer, () => fetch(input, init))
}

/** Calls out, timed, and waits for the answer as long as `init.signal` lets it. */
export function fetchPatient(peer: Peer, url: string, init: PatientInit): Promise<Answer> {
  return timedCall(peer, () => patientFetch(url, { ...init, dispatcher: PATIENT }))
}

/** Reports who is active and how deep the derive queue is at each export, and names the release every request is timed under. */
export function observeHub(reads: { queued(): Promise<number>; present(): Promise<{ people: number; tabs: number }> }, version: string, log: Logger): void {
  release = version
  const meter = metrics.getMeter('orrery')
  // Read from the database, so every hub reports the whole day, however recently it started.
  const tabs = meter.createObservableGauge('orrery.browser.sessions', { description: 'Browser tabs that reported in the last day.' })
  const people = meter.createObservableGauge('orrery.people', { description: 'People who made a request in the last day.' })
  meter.addBatchObservableCallback(async (r) => {
    try {
      const present = await reads.present()
      r.observe(people, present.people)
      r.observe(tabs, present.tabs)
    } catch (error) {
      log.warn('who is present not read', { error })
    }
  }, [people, tabs])
  meter.createObservableGauge('orrery.queue.depth', { description: 'Entities waiting to be derived.' }).addCallback(async (r) => {
    try {
      r.observe(await reads.queued(), { 'orrery.queue': 'derive' })
    } catch (error) {
      log.warn('queue depth not read', { error })
    }
  })
}

/** Counts one question asked of the kept answers in lists.ts: kept, read afresh, or answered by the last one while the next builds. */
export function recordKept(kind: 'listing' | 'memo', result: 'hit' | 'miss' | 'stale'): void {
  instruments().kept.add(1, { 'orrery.kept': kind, 'orrery.result': result })
}

/** Counts activity rows Annals answered for, by its answer. */
export function recordAnnals(outcome: string, n: number): void {
  instruments().annals.add(n, { 'orrery.outcome': outcome })
}

/** The work under way: the innermost task, or the route a request took where no task is. */
const work = new AsyncLocalStorage<string>()

/** The work under way now, if any. */
export function currentWork(): string | undefined {
  return work.getStore()
}

/** Runs `fn` as the work `name`, so every statement it sends is counted under that name. A task inside it takes its statements for itself. */
export function working<T>(name: string, fn: () => T): T {
  return work.run(name, fn)
}

/** What a statement is counted under when no work was under way as it was sent, before its verb and table. */
export const NO_WORK = 'other'

/** Runs `fn` and records how long it took under `task`, failed or not. */
export async function timed<T>(task: Task, fn: () => Promise<T>): Promise<T> {
  const started = performance.now()
  let outcome = 'error'
  try {
    const out = await work.run(task, fn)
    outcome = 'ok'
    return out
  } finally {
    instruments().task.record((performance.now() - started) / 1000, { 'orrery.task': task, 'orrery.outcome': outcome })
  }
}

/** The verb and the first table a statement names, as the labels it is counted under. */
export function operationOf(text: string): { verb: string; table: string } {
  const first = /^\s*([a-z]+)/i.exec(text)?.[1]?.toLowerCase() ?? 'other'
  const verb = VERBS.has(first) ? first : 'other'
  const named = /\b(?:from|into|update|join|table(?: if not exists)?)\s+([a-z_]+)/i.exec(text)?.[1]?.toLowerCase()
  const table = named === undefined ? 'none' : TABLES.has(named) ? named : 'other'
  return { verb, table }
}

/** The SQL a `query` call runs, whether it was passed as text or as a config object. */
function textOf(config: unknown): string {
  if (typeof config === 'string') return config
  if (config && typeof config === 'object' && 'text' in config && typeof config.text === 'string') return config.text
  return ''
}

type QueryResultCallback = (error: Error | null, result?: pg.QueryResult) => void

/**
 * Times every statement a pooled connection runs: `pool.query`, a
 * transaction's `client.query`, all of them. Wrapped once per connection,
 * when the pool opens it. `spent` is told each one with the work it was
 * sent for: a name from a fixed set, kept out of the metric's labels.
 */
export function timeQueries(pool: pg.Pool, log: Logger, spent?: (work: string, ms: number, rows: number) => void): void {
  pool.on('connect', (client) => {
    const query = client.query.bind(client) as (...args: unknown[]) => unknown
    const wrapped = (...args: unknown[]): unknown => {
      const text = textOf(args[0])
      const started = performance.now()
      // Read as the statement is sent: its answer comes back outside the work that asked.
      const under = work.getStore()
      const done = (failed: boolean, rows?: number | null) => {
        const ms = performance.now() - started
        const { verb, table } = operationOf(text)
        // A statement no work asked for is told apart by what it does: a verb and a table, both fixed sets.
        spent?.(under ?? `${NO_WORK} ${verb} ${table}`, ms, rows ?? 0)
        instruments().query.record(ms / 1000, { 'db.operation.name': verb, 'db.collection.name': table, 'orrery.outcome': failed ? 'error' : 'ok' })
        if (ms >= SLOW_QUERY_MS) log.warn('slow query', { verb, table, ms: Math.round(ms), rows: rows ?? null, sql: text.replace(/\s+/g, ' ').slice(0, 240) })
      }
      // pg's pool answers `pool.query` through the callback form; every other caller awaits the promise form.
      const last = args[args.length - 1]
      if (typeof last === 'function') {
        const callback = last as QueryResultCallback
        return query(...args.slice(0, -1), ((error, result) => {
          done(Boolean(error), result?.rowCount)
          callback(error, result)
        }) satisfies QueryResultCallback)
      }
      const out = query(...args)
      if (out instanceof Promise) out.then((result: pg.QueryResult | undefined) => done(false, result?.rowCount), () => done(true))
      return out
    }
    client.query = wrapped as typeof client.query
  })
}

/** What asked a run: a person or agent alone, a batch, or a schedule. A fixed set, so it is a label. */
export type RunOrigin = 'alone' | 'batch' | 'schedule'

/** Counts a run that ended, and times it when it started. The action is a label: the actions an estate defines are a set it keeps. */
export function recordActionRun(run: { action: string; origin: RunOrigin; outcome: string; seconds: number | null }): void {
  instruments().actionRuns.add(1, { 'orrery.action': run.action, 'orrery.origin': run.origin, 'orrery.outcome': run.outcome })
  if (run.seconds !== null) instruments().actionDuration.record(run.seconds, { 'orrery.action': run.action, 'orrery.origin': run.origin })
}

/** One runner now: its runs waiting, its runs going, and how many it runs at once. */
export interface RunnerReading {
  runner: string
  queued: number
  running: number
  width: number | null
}

/**
 * Reports each runner's queue, what it is running, and its width at each
 * export, read from the database: how far behind the runners are, and how
 * full, to size what runs them.
 */
export function observeRunners(read: () => Promise<RunnerReading[]>, log: Logger): void {
  const meter = metrics.getMeter('orrery')
  const queued = meter.createObservableGauge('orrery.runner.queued', { description: 'Action runs waiting for a runner, by runner: runs asked alone and of batches, and retries whose wait is over.' })
  const running = meter.createObservableGauge('orrery.runner.running', { description: 'Action runs a runner is running now, by runner.' })
  const width = meter.createObservableGauge('orrery.runner.width', { description: 'How many runs a runner runs at once, as it last said, by runner.' })
  meter.addBatchObservableCallback(
    async (r) => {
      try {
        for (const x of await read()) {
          r.observe(queued, x.queued, { 'orrery.runner': x.runner })
          r.observe(running, x.running, { 'orrery.runner': x.runner })
          if (x.width !== null) r.observe(width, x.width, { 'orrery.runner': x.runner })
        }
      } catch (error) {
        log.warn('runner gauges not read', { error })
      }
    },
    [queued, running, width],
  )
}
