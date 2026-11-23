// Sends the hub's spans, log records, and field gauge to Application
// Insights' ingestion API, as the envelopes it keeps in `requests`,
// `pageViews`, `customEvents`, `exceptions`, and `customMetrics`. A server
// span is a request; a log record named `Page Viewed` is a page view; one
// carrying an exception is an exception; any other named log record is a
// custom event; a gauge point of a metric the exporter is told to send is a
// custom metric. Nothing else is sent: the hub's own log lines go to stdout.

import { randomBytes } from 'node:crypto'
import { SpanKind, type Attributes, type AttributeValue, type HrTime } from '@opentelemetry/api'
import { ExportResultCode, type ExportResult } from '@opentelemetry/core'
import type { LogRecordExporter, ReadableLogRecord } from '@opentelemetry/sdk-logs'
import type { PushMetricExporter, ResourceMetrics } from '@opentelemetry/sdk-metrics'
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace'
import type { Resource } from '@opentelemetry/resources'
import { PAGE_VIEWED } from '../shared/usage.ts'
import type { Logger } from './log.ts'

/** Where a connection string says to send, and as which resource. */
export interface Destination {
  instrumentationKey: string
  /** The ingestion host, ending in a slash. */
  endpoint: string
}

/** Reads an Application Insights connection string, or says why it cannot. */
export function parseConnectionString(text: string): Destination {
  const parts = new Map(
    text
      .split(';')
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => {
        const at = p.indexOf('=')
        return [p.slice(0, at).trim().toLowerCase(), p.slice(at + 1).trim()] as const
      }),
  )
  const instrumentationKey = parts.get('instrumentationkey')
  if (!instrumentationKey) throw new Error('The connection string names no InstrumentationKey')
  const endpoint = parts.get('ingestionendpoint') ?? 'https://dc.services.visualstudio.com/'
  return { instrumentationKey, endpoint: endpoint.endsWith('/') ? endpoint : `${endpoint}/` }
}

/** One telemetry item as the ingestion API takes it. */
export interface Envelope {
  name: string
  time: string
  iKey: string
  tags: Record<string, string>
  data: { baseType: string; baseData: Record<string, unknown> }
}

/** Attributes read into an envelope's tags or fields, and so not repeated as its properties. */
const CONSUMED = new Set([
  'enduser.id',
  'session.id',
  'client.address',
  'operation.name',
  'http.route',
  'http.request.method',
  'http.response.status_code',
  'url.path',
  'exception.type',
  'exception.message',
  'exception.stacktrace',
])
const MAX_PROPERTY = 8192

/** Splits attributes into the properties and measurements an item carries: a number is measured, everything else is told. */
function described(attributes: Attributes): { properties: Record<string, string>; measurements: Record<string, number> } {
  const properties: Record<string, string> = {}
  const measurements: Record<string, number> = {}
  for (const [key, value] of Object.entries(attributes)) {
    if (CONSUMED.has(key) || value === undefined || value === null) continue
    if (typeof value === 'number') measurements[key] = value
    else properties[key.slice(0, 150)] = text(value).slice(0, MAX_PROPERTY)
  }
  return { properties, measurements }
}

function text(value: AttributeValue): string {
  return Array.isArray(value) ? value.join(', ') : String(value)
}

function iso(time: HrTime): string {
  return new Date(time[0] * 1000 + time[1] / 1e6).toISOString()
}

/** A span's length as the ingestion API writes one: `d.hh:mm:ss.fff`. */
export function timespan(time: HrTime): string {
  const ms = Math.round(time[0] * 1000 + time[1] / 1e6)
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  const days = Math.floor(ms / 86_400_000)
  const clock = `${pad(Math.floor(ms / 3_600_000) % 24)}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}.${pad(ms % 1000, 3)}`
  return days ? `${days}.${clock}` : clock
}

/** The tags every item carries: which service sent it, and who and what it was for. */
function tagsOf(resource: Resource, attributes: Attributes, operation: { id?: string; parent?: string }): Record<string, string> {
  const r = resource.attributes
  const tags: Record<string, string> = {
    'ai.cloud.role': String(r['service.name'] ?? 'orrery'),
    'ai.internal.sdkVersion': `orrery:${String(r['service.version'] ?? '0')}`,
  }
  if (r['service.instance.id']) tags['ai.cloud.roleInstance'] = String(r['service.instance.id'])
  if (r['service.version']) tags['ai.application.ver'] = String(r['service.version'])
  if (operation.id) tags['ai.operation.id'] = operation.id
  if (operation.parent) tags['ai.operation.parentId'] = operation.parent
  // People are known by their sign-in address, so the address is both who signed in and who the user is.
  const person = attributes['enduser.id']
  if (person) {
    tags['ai.user.authUserId'] = String(person)
    tags['ai.user.id'] = String(person)
  }
  if (attributes['session.id']) tags['ai.session.id'] = String(attributes['session.id'])
  // Where the caller is. Without an address of the caller's own, none: the ingestion API would otherwise place everything where the hub runs.
  tags['ai.location.ip'] = attributes['client.address'] ? String(attributes['client.address']) : '0.0.0.0'
  if (attributes['operation.name']) tags['ai.operation.name'] = String(attributes['operation.name'])
  return tags
}

/** A server span as a request, or null for any other span. */
export function requestOf(span: ReadableSpan, iKey: string): Envelope | null {
  if (span.kind !== SpanKind.SERVER) return null
  const a = span.attributes
  const status = Number(a['http.response.status_code'] ?? 0)
  const context = span.spanContext()
  const tags = tagsOf(span.resource, a, { id: context.traceId, parent: span.parentSpanContext?.spanId })
  tags['ai.operation.name'] = span.name
  return {
    name: 'Microsoft.ApplicationInsights.Request',
    time: iso(span.startTime),
    iKey,
    tags,
    data: {
      baseType: 'RequestData',
      baseData: { ver: 2, id: context.spanId, name: span.name, duration: timespan(span.duration), responseCode: String(status), success: status > 0 && status < 400, url: a['url.path'] ? String(a['url.path']) : undefined, ...described(a) },
    },
  }
}

/** A log record as a page view, an exception, or a custom event; null for a record with no name and no exception. */
export function itemOf(log: ReadableLogRecord, iKey: string): Envelope | null {
  const a = log.attributes
  const tags = tagsOf(log.resource, a, { id: log.spanContext?.traceId, parent: log.spanContext?.spanId })
  const time = iso(log.hrTime)
  const { properties, measurements } = described(a)
  if (a['exception.type'] || a['exception.message']) {
    const stack = a['exception.stacktrace'] ? String(a['exception.stacktrace']) : undefined
    const exception = { typeName: String(a['exception.type'] ?? 'Error'), message: String(a['exception.message'] ?? ''), hasFullStack: Boolean(stack), stack }
    return { name: 'Microsoft.ApplicationInsights.Exception', time, iKey, tags, data: { baseType: 'ExceptionData', baseData: { ver: 2, exceptions: [exception], severityLevel: 3, properties, measurements } } }
  }
  if (!log.eventName) return null
  if (log.eventName === PAGE_VIEWED) {
    const name = properties.page ?? 'Page'
    return { name: 'Microsoft.ApplicationInsights.PageView', time, iKey, tags, data: { baseType: 'PageViewData', baseData: { ver: 2, id: randomBytes(8).toString('hex'), name, url: a['url.path'] ? String(a['url.path']) : undefined, properties, measurements } } }
  }
  return { name: 'Microsoft.ApplicationInsights.Event', time, iKey, tags, data: { baseType: 'EventData', baseData: { ver: 2, name: log.eventName, properties, measurements } } }
}

/** Posts envelopes to the ingestion API. A refused or failed post is logged and dropped: telemetry never holds the hub up. */
export class Ingestion {
  readonly destination: Destination
  private readonly url: string
  private readonly log: Logger
  private readonly post: typeof fetch

  constructor(destination: Destination, log: Logger, post: typeof fetch = fetch) {
    this.destination = destination
    this.url = `${destination.endpoint}v2.1/track`
    this.log = log
    this.post = post
  }

  send(items: Envelope[], done: (result: ExportResult) => void): void {
    if (!items.length) return done({ code: ExportResultCode.SUCCESS })
    this.post(this.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(items), signal: AbortSignal.timeout(15_000) })
      .then(async (res) => {
        if (res.ok) {
          // A partial answer lists the items it turned away, each with its reason.
          if (res.status === 206) this.log.warn('application insights accepted part of a batch', { sent: items.length, answer: (await res.text()).slice(0, 2000) })
          else this.log.debug('application insights batch sent', { sent: items.length })
          return done({ code: ExportResultCode.SUCCESS })
        }
        this.log.warn('application insights refused a batch', { sent: items.length, status: res.status, answer: (await res.text()).slice(0, 2000) })
        done({ code: ExportResultCode.FAILED })
      })
      .catch((error: unknown) => {
        this.log.warn('application insights batch failed', { sent: items.length, error })
        done({ code: ExportResultCode.FAILED, error: error instanceof Error ? error : new Error(String(error)) })
      })
  }
}

export class AppInsightsSpanExporter implements SpanExporter {
  private readonly ingestion: Ingestion
  constructor(ingestion: Ingestion) {
    this.ingestion = ingestion
  }
  export(spans: ReadableSpan[], done: (result: ExportResult) => void): void {
    const key = this.ingestion.destination.instrumentationKey
    this.ingestion.send(spans.flatMap((s) => requestOf(s, key) ?? []), done)
  }
  async shutdown(): Promise<void> {}
  async forceFlush(): Promise<void> {}
}

/**
 * The gauge points of the metrics named in `only` as custom metrics, one
 * item a point, each attribute a dimension. Nothing else a collection holds
 * is sent: Application Insights bills a custom metric by what it receives.
 */
export function metricItemsOf(collected: ResourceMetrics, iKey: string, only: ReadonlySet<string>): Envelope[] {
  const tags = tagsOf(collected.resource, {}, {})
  return collected.scopeMetrics.flatMap((scope) =>
    scope.metrics
      .filter((m) => only.has(m.descriptor.name))
      .flatMap((m) =>
        m.dataPoints.flatMap((p) => {
          if (typeof p.value !== 'number') return []
          return [
            {
              name: 'Microsoft.ApplicationInsights.Metric',
              time: iso(p.endTime),
              iKey,
              tags,
              data: { baseType: 'MetricData', baseData: { ver: 2, metrics: [{ name: m.descriptor.name, kind: 0, value: p.value, count: 1 }], properties: described(p.attributes).properties } },
            },
          ]
        }),
      ),
  )
}

export class AppInsightsMetricExporter implements PushMetricExporter {
  private readonly ingestion: Ingestion
  private readonly only: ReadonlySet<string>
  constructor(ingestion: Ingestion, only: ReadonlySet<string>) {
    this.ingestion = ingestion
    this.only = only
  }
  export(collected: ResourceMetrics, done: (result: ExportResult) => void): void {
    this.ingestion.send(metricItemsOf(collected, this.ingestion.destination.instrumentationKey, this.only), done)
  }
  async shutdown(): Promise<void> {}
  async forceFlush(): Promise<void> {}
}

export class AppInsightsLogExporter implements LogRecordExporter {
  private readonly ingestion: Ingestion
  constructor(ingestion: Ingestion) {
    this.ingestion = ingestion
  }
  export(logs: ReadableLogRecord[], done: (result: ExportResult) => void): void {
    const key = this.ingestion.destination.instrumentationKey
    this.ingestion.send(logs.flatMap((l) => itemOf(l, key) ?? []), done)
  }
  async shutdown(): Promise<void> {}
  async forceFlush(): Promise<void> {}
}
