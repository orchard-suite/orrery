// What the hub tells Application Insights about how it is used: a request
// span for each API call, with who made it, and the usage events named in
// `src/shared/usage.ts`. It is on when APPLICATIONINSIGHTS_CONNECTION_STRING
// is set and does nothing otherwise, so tests and local runs send nothing.
// What a person's browser saw is relayed here too: to Application Insights
// as page views, events, and exceptions; to the estate's Faro receiver, as
// `orrery-web`, when FARO_URL is set; and into the hub's own metrics, where
// a page's waits and views are counted whatever store is behind them.

import { hostname } from 'node:os'
import { context, createContextKey, logs, SpanKind, SpanStatusCode, trace, type Attributes, type Logger as OtelLogger, type Tracer } from '@opentelemetry/api'
import type { Context, Next } from 'hono'
import { routePath } from 'hono/route'
import { CHANGE_EVENTS, PAGE_VIEWED, SESSION_HEADER, TELEMETRY_LIMITS, type BrowserSignal, type EventSource } from '../shared/usage.ts'
import type { ActorKind, ChangeKind, Identity, Outcome } from '../shared/model.ts'
import { AppInsightsLogExporter, AppInsightsSpanExporter, Ingestion, parseConnectionString } from './appinsights.ts'
import type { AppEnv } from './auth.ts'
import type { Logger } from './log.ts'
import { fetchTimed, metricsOn, recordBatch, recordBrowserError, recordMeasure, recordUsage, recordView } from './metrics.ts'

let tracer: Tracer | null = null
let events: OtelLogger | null = null

/** The estate's Faro receiver, where a browser batch is relayed as `orrery-web`. Without the key, batches are taken and dropped. */
interface Faro {
  url: string
  key: string | null
  version: string
  log: Logger
}
let faro: Faro | null = null

/** Whether anything keeps what the web app reports: the page sends its views, waits, and errors only then. */
export function telemetryOn(): boolean {
  return events !== null || faro !== null || metricsOn()
}

/**
 * Starts sending to Application Insights when the connection string is set.
 * Call it before the hub is made, as `startMetrics` is.
 */
/** Sending telemetry: `flush` sends what waits now, and `shutdown` sends it and stops. */
export interface Telemetry {
  flush(): Promise<void>
  shutdown(): Promise<void>
}

export async function startTelemetry(log: Logger, version: string, env: Record<string, string | undefined> = process.env): Promise<Telemetry> {
  const faroUrl = env.FARO_URL?.trim()
  if (faroUrl) {
    faro = { url: faroUrl, key: env.FARO_API_KEY?.trim() || null, version, log }
    log.info('browser telemetry relayed to faro', { url: faroUrl, key: faro.key ? 'set' : 'missing: batches are dropped until it is' })
  } else log.info('browser telemetry not relayed to faro', { reason: 'FARO_URL not set' })
  const connection = env.APPLICATIONINSIGHTS_CONNECTION_STRING?.trim()
  if (!connection) {
    log.info('telemetry off', { reason: 'APPLICATIONINSIGHTS_CONNECTION_STRING not set' })
    return {
      flush: async () => undefined,
      shutdown: async () => {
        faro = null
      },
    }
  }
  const [{ TracerProvider, BatchSpanProcessor }, { LoggerProvider, BatchLogRecordProcessor }, { AsyncLocalStorageContextManager }, { resourceFromAttributes }] = await Promise.all([
    import('@opentelemetry/sdk-trace'),
    import('@opentelemetry/sdk-logs'),
    import('@opentelemetry/context-async-hooks'),
    import('@opentelemetry/resources'),
  ])
  const ingestion = new Ingestion(parseConnectionString(connection), log)
  const resource = resourceFromAttributes({ 'service.name': 'orrery', 'service.version': version, 'service.instance.id': hostname() })
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())
  const traces = new TracerProvider({ resource, spanProcessors: [new BatchSpanProcessor({ exporter: new AppInsightsSpanExporter(ingestion) })] })
  const records = new LoggerProvider({ resource, processors: [new BatchLogRecordProcessor({ exporter: new AppInsightsLogExporter(ingestion) })] })
  trace.setGlobalTracerProvider(traces)
  logs.setGlobalLoggerProvider(records)
  tracer = trace.getTracer('orrery', version)
  events = logs.getLogger('orrery', version)
  log.info('telemetry on', { endpoint: ingestion.destination.endpoint, version })
  return {
    flush: async () => {
      await Promise.all([traces.forceFlush(), records.forceFlush()])
    },
    shutdown: async () => {
      await Promise.all([traces.shutdown(), records.shutdown()])
      tracer = null
      events = null
      faro = null
    },
  }
}

/** The person a call is made for: an admin viewing as someone is still the admin. Null for a token, a source, or nobody. */
function personOf(identity: Identity | undefined): string | null {
  if (identity?.kind !== 'user') return null
  return identity.viewAs?.by ?? identity.name
}

/** Requests not worth sending: the event stream, which stays open for a tab's life, the browser's own telemetry, the pictures every page loads, and the web app's own files. */
function quiet(path: string): boolean {
  return path === '/v1/events' || path === '/v1/telemetry' || path.startsWith('/v1/icons/') || !(path.startsWith('/v1/') || path === '/mcp')
}

/**
 * What a request tells everything sent inside it: the browser tab's visit,
 * the address it came from, and its route. Read when something is sent, since
 * the route is the handler's that is running then.
 */
const REQUEST = createContextKey('orrery.request')
type Facts = () => Attributes

function requestFacts(): Attributes {
  const facts = context.active().getValue(REQUEST) as Facts | undefined
  return facts ? facts() : {}
}

/** Runs a request inside its span, so whatever it sends is part of it, and sends the span when it is answered. */
export async function traced(c: Context<AppEnv>, next: Next): Promise<void> {
  if (!tracer || quiet(c.req.path)) return next()
  const session = c.req.header(SESSION_HEADER)?.slice(0, 64)
  // Where the caller is, as the trusted proxy header says: only ever a place on the map, never who someone is.
  const address = c.get('address')
  const caller: Attributes = { ...(session ? { 'session.id': session } : {}), ...(address ? { 'client.address': address } : {}) }
  const facts: Facts = () => ({ 'operation.name': `${c.req.method} ${routePath(c)}`, ...caller })
  const span = tracer.startSpan(`${c.req.method} ${c.req.path}`, { kind: SpanKind.SERVER, attributes: { 'http.request.method': c.req.method, 'url.path': c.req.path, 'orrery.surface': c.env.surface, ...caller } })
  const inside = trace.setSpan(context.active(), span).setValue(REQUEST, facts)
  try {
    await context.with(inside, next)
  } finally {
    const route = routePath(c)
    span.updateName(`${c.req.method} ${route}`)
    span.setAttribute('http.route', route)
    const status = c.res.status
    const identity = c.get('identity') as Identity | undefined
    const person = personOf(identity)
    span.setAttributes({
      'http.response.status_code': status,
      ...(identity ? { 'orrery.actor_kind': identity.kind } : {}),
      ...(person ? { 'enduser.id': person } : identity && identity.kind !== 'anonymous' ? { initiatedBy: identity.source ?? identity.name } : {}),
      ...(identity?.viewAs ? { 'orrery.viewing_as': identity.name } : {}),
    })
    if (status >= 500) {
      span.setStatus({ code: SpanStatusCode.ERROR })
      const error = c.error
      if (error) context.with(inside, () => sendException(error, person))
    }
    span.end()
  }
}

/**
 * Sends one usage event, with what the request it is sent in tells. It never
 * throws: what the hub was doing goes on whether or not telemetry can be sent.
 */
function send(name: string, attributes: Attributes, source: EventSource): void {
  recordUsage(name, source)
  emit(name, attributes, source)
}

/** Sends one usage event to Application Insights alone, already counted. */
function emit(name: string, attributes: Attributes, source: EventSource): void {
  if (!events) return
  try {
    events.emit({ eventName: name, attributes: { ...requestFacts(), ...attributes, source } })
  } catch {
    // An event that cannot be sent is dropped; the activity log still holds the change.
  }
}

function sendException(error: Error, person: string | null): void {
  if (!events) return
  try {
    events.emit({ attributes: { ...requestFacts(), 'exception.type': error.name, 'exception.message': error.message, 'exception.stacktrace': error.stack?.slice(0, TELEMETRY_LIMITS.stack) ?? '', source: 'api', ...(person ? { 'enduser.id': person, initiatedBy: person } : {}) } })
  } catch {
    // As for an event: dropped.
  }
}

/** One activity row, as `activity.ts` writes it. */
export interface ChangeRow {
  kind: string
  outcome: Outcome
  actorKind: ActorKind
  actor: string | null
  blueprint: string | null
  key: string | null
  source: string | null
  detail: Record<string, unknown>
}

/** Details an event never carries: an action run's inputs are what a person typed, and stay in the activity log. */
const UNSENT = new Set(['inputs'])

/** The properties a change event sets itself. A detail of the same name is sent as `detail.<name>`, so neither hides the other. */
const OWN = new Set(['initiatedBy', 'actorKind', 'outcome', 'blueprint', 'key', 'writtenAs', 'source', 'enduser.id', 'session.id', 'client.address', 'operation.name'])

/** A detail as an event's property: a short value as it is, anything bigger as JSON, and nothing too big to read. */
function propertiesOf(detail: Record<string, unknown>): Attributes {
  const out: Attributes = {}
  for (const [name, value] of Object.entries(detail)) {
    if (UNSENT.has(name) || value === null || value === undefined) continue
    const key = OWN.has(name) ? `detail.${name}` : name
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') out[key] = value
    else if (Array.isArray(value) && value.every((v) => typeof v === 'string')) out[key] = value.join(', ')
    else {
      const json = JSON.stringify(value)
      if (json.length <= 8000) out[key] = json
    }
  }
  return out
}

/**
 * Sends the activity rows a person or an access token wrote as the usage
 * events `CHANGE_EVENTS` names. A finished action run is sent whoever wrote
 * it, failed or not, on behalf of the person who asked for it.
 */
export function sendChanges(rows: ChangeRow[]): void {
  for (const row of rows) {
    const name = CHANGE_EVENTS[row.kind as ChangeKind] ?? null
    if (!name) continue
    const finished = row.kind === 'action.finished'
    if (!finished && (row.outcome !== 'ok' || (row.actorKind !== 'user' && row.actorKind !== 'token'))) continue
    const initiatedBy = finished ? String(row.detail.requestedBy ?? row.actor ?? '') : (row.actor ?? '')
    send(
      name,
      {
        ...propertiesOf(row.detail),
        initiatedBy,
        actorKind: row.actorKind,
        outcome: row.outcome,
        ...(row.actorKind === 'user' && row.actor ? { 'enduser.id': row.actor } : {}),
        ...(row.blueprint ? { blueprint: row.blueprint } : {}),
        ...(row.key ? { key: row.key } : {}),
        ...(row.source ? { writtenAs: row.source } : {}),
      },
      'api',
    )
  }
}

/** Sends an event the hub raises itself, made by the caller of the request it runs in. */
export function sendUsage(name: string, identity: Identity, properties: Record<string, string>): void {
  const person = personOf(identity)
  send(name, { ...properties, initiatedBy: person ?? identity.source ?? identity.name, actorKind: identity.kind, ...(person ? { 'enduser.id': person } : {}) }, 'api')
}

/**
 * Takes what a person's browser saw, as theirs, from where they are: the
 * hub, never the page, says who they are. It counts the views, waits, and
 * errors in the hub's metrics, sends them to Application Insights, and
 * relays the batch to the Faro receiver.
 */
export function sendBrowser(person: string, session: string, signals: BrowserSignal[], address?: string): void {
  for (const s of signals) {
    if (s.kind === 'measure') recordMeasure(s.name, s.page, s.value)
    else if (s.kind === 'error') recordBrowserError()
    else {
      recordUsage(s.name, 'web')
      if (s.name === PAGE_VIEWED) recordView(s.props?.page ?? 'unknown')
    }
  }
  if (faro) void relayFaro(faro, person, session, signals)
  if (!events) return
  const who = { 'enduser.id': person, initiatedBy: person, 'session.id': session.slice(0, 64), ...(address ? { 'client.address': address } : {}) }
  for (const s of signals) {
    if (s.kind === 'measure') continue
    if (s.kind === 'error') {
      try {
        events.emit({ attributes: { 'exception.type': s.type, 'exception.message': s.message, 'exception.stacktrace': s.stack ?? '', ...(s.page ? { page: s.page } : {}), source: 'web', ...who } })
      } catch {
        // Dropped, as an event is.
      }
      continue
    }
    const props = s.props ?? {}
    emit(s.name, { ...props, ...(s.name === PAGE_VIEWED && props.path ? { 'url.path': props.path } : {}), ...who }, 'web')
  }
}

/** A web vital is reported to Faro in milliseconds, as the Faro SDK reports it; a wait of the hub's own is named for its unit. */
function faroMeasurement(s: Extract<BrowserSignal, { kind: 'measure' }>, timestamp: string): Record<string, unknown> {
  const context = { page: s.page }
  if (s.name === 'cls') return { type: 'web-vitals', values: { cls: s.value }, context, timestamp }
  if (s.name === 'lcp' || s.name === 'inp') return { type: 'web-vitals', values: { [s.name]: Math.round(s.value * 1000) }, context, timestamp }
  return { type: s.name, values: { [`${s.name}_ms`]: Math.round(s.value * 1000) }, context, timestamp }
}

/** The batch as the Faro receiver takes one: the shape the Faro web SDK posts, with the hub as the SDK and the person from the hub's sign-in. */
export function faroPayload(version: string, person: string, session: string, signals: BrowserSignal[], now = new Date()): Record<string, unknown> {
  const timestamp = now.toISOString()
  const view = signals.find((s) => s.kind === 'event' && s.name === PAGE_VIEWED)
  const path = view?.kind === 'event' ? view.props?.path : undefined
  return {
    meta: {
      sdk: { name: 'orrery', version },
      app: { name: 'orrery-web', version },
      session: { id: session.slice(0, 64) },
      user: { email: person },
      ...(path ? { page: { url: path } } : {}),
    },
    events: signals.flatMap((s) => (s.kind === 'event' ? [{ name: s.name, domain: 'browser', attributes: s.props ?? {}, timestamp }] : [])),
    measurements: signals.flatMap((s) => (s.kind === 'measure' ? [faroMeasurement(s, timestamp)] : [])),
    exceptions: signals.flatMap((s) => (s.kind === 'error' ? [{ type: s.type, value: s.message, timestamp, stacktrace: { frames: [] }, context: { ...(s.page ? { page: s.page } : {}), ...(s.stack ? { stack: s.stack } : {}) } }] : [])),
    logs: [],
  }
}

/** Posts one batch to the Faro receiver. Without the key it is dropped and counted; a failure is logged and counted, and never reaches the page. */
async function relayFaro(to: Faro, person: string, session: string, signals: BrowserSignal[]): Promise<void> {
  if (!to.key) {
    recordBatch('dropped')
    return
  }
  try {
    const res = await fetchTimed('faro', to.url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': to.key }, body: JSON.stringify(faroPayload(to.version, person, session, signals)), signal: AbortSignal.timeout(5_000) })
    if (res.ok) recordBatch('relayed')
    else {
      recordBatch('failed')
      to.log.warn('faro refused a browser batch', { status: res.status })
    }
  } catch (error) {
    recordBatch('failed')
    to.log.warn('faro not reached', { error })
  }
}
