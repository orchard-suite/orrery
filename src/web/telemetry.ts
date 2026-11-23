// What the page tells the hub about how it is used, when the hub says
// telemetry is on: the pages a person opens, the events in
// `src/shared/usage.ts` only the page sees, how long they waited (from what
// they did until the answer was on screen, the time to the first useful
// screen, and the web vitals), and errors the page did not catch.
// It posts them to the hub, which says who sent them and sends them on. It
// is the one request that does not go through `call`: the last batch leaves
// as the tab closes, by beacon, and a sign-in that has ended must not reload
// the page for it.

import { onCLS, onINP, onLCP, type Metric } from 'web-vitals'
import { PAGE_VIEWED, TELEMETRY_LIMITS, type BrowserEvent, type BrowserMeasure, type BrowserSignal, type TelemetryBatch } from '../shared/usage.ts'
import type { Route } from './router.ts'

const ENDPOINT = '/v1/telemetry'
const EVERY_MS = 10_000

/** Errors the browser raises that are not the page's and break nothing: a resize the layout settled a frame later. */
const HARMLESS = [/^ResizeObserver loop/]

/** The name a page is reported under, by route. */
export const PAGES: Record<Route['page'], string> = {
  now: 'Home',
  wall: 'Wall',
  favorites: 'Favorites',
  query: 'Query',
  'action-schedules': 'Schedules',
  'action-insights': 'Action Insights',
  reports: 'Reports',
  report: 'Report',
  inventory: 'Catalog',
  entity: 'Entity',
  activity: 'Activity',
  load: 'Load',
  access: 'Access',
  security: 'Security',
  sources: 'Sources',
  model: 'Model',
  scorecards: 'Scorecards',
  actions: 'Self-service',
  'action-run': 'Action Run',
  'action-batch': 'Action Batch',
  'action-set': 'Change Set',
  search: 'Search',
  ground: 'Ground',
  map: 'Map',
}

let on = false
let queue: BrowserSignal[] = []
/** The page open now, as the waits measured on it are named. */
let page = 'Home'

/** This tab's visit: random, and kept for as long as the tab is open. */
export const session: string = (() => {
  const key = 'orrery.session'
  try {
    const kept = sessionStorage.getItem(key)
    if (kept) return kept
    const made = crypto.randomUUID()
    sessionStorage.setItem(key, made)
    return made
  } catch {
    return crypto.randomUUID()
  }
})()

/** Sends what is queued. As the tab hides, by beacon, which outlives the page. */
function flush(leaving = false): void {
  while (queue.length) {
    const batch: TelemetryBatch = { session, signals: queue.splice(0, TELEMETRY_LIMITS.events) }
    const body = JSON.stringify(batch)
    if (leaving && navigator.sendBeacon?.(ENDPOINT, new Blob([body], { type: 'application/json' }))) continue
    void fetch(ENDPOINT, { method: 'POST', body, headers: { 'content-type': 'application/json' }, keepalive: true, redirect: 'manual' }).catch(() => undefined)
  }
}

function push(signal: BrowserSignal): void {
  if (!on) return
  queue.push(signal)
  if (queue.length >= TELEMETRY_LIMITS.events) flush()
}

/** Starts sending, once, when the hub says it sends telemetry. */
export function startTelemetry(): void {
  if (on) return
  on = true
  setInterval(() => flush(), EVERY_MS)
  addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush(true)
  })
  addEventListener('pagehide', () => flush(true))
  const vital = (m: Metric) => measure(m.name.toLowerCase() as BrowserMeasure, m.name === 'CLS' ? m.value : m.value / 1000)
  onLCP(vital)
  onINP(vital)
  onCLS(vital)
  addEventListener('error', (e) => {
    if (HARMLESS.some((h) => h.test(String(e.message)))) return
    push({ kind: 'error', type: e.error instanceof Error ? e.error.name : 'Error', message: String(e.message).slice(0, 2000), stack: e.error instanceof Error ? e.error.stack?.slice(0, TELEMETRY_LIMITS.stack) : undefined, page: location.pathname.slice(0, 100) })
  })
  addEventListener('unhandledrejection', (e) => {
    const reason: unknown = e.reason
    push({ kind: 'error', type: reason instanceof Error ? reason.name : 'UnhandledRejection', message: (reason instanceof Error ? reason.message : String(reason)).slice(0, 2000), stack: reason instanceof Error ? reason.stack?.slice(0, TELEMETRY_LIMITS.stack) : undefined, page: location.pathname.slice(0, 100) })
  })
}

/** Reports one usage event. Each value is cut to the length the hub takes. */
export function track(name: BrowserEvent, props: Record<string, string> = {}): void {
  push({ kind: 'event', name, props: Object.fromEntries(Object.entries(props).map(([k, v]) => [k, v.slice(0, TELEMETRY_LIMITS.propLength)])) })
}

/** Reports how a page felt: a wait in seconds, or a layout shift, on the page open now. */
export function measure(name: BrowserMeasure, value: number): void {
  if (!Number.isFinite(value) || value < 0) return
  push({ kind: 'measure', name, page, value })
}

/**
 * Times a request from when it was asked until its answer is on screen: the
 * fetch, the parse, and the frame after, which is when the person sees it.
 */
export function timeWait<T>(work: Promise<T>): Promise<T> {
  if (!on) return work
  const started = performance.now()
  return work.finally(() => {
    requestAnimationFrame(() => measure('wait', (performance.now() - started) / 1000))
  })
}

/** Reports the first useful screen: how long after the tab opened the page painted with the person known. Once per tab. */
let ready = false
export function trackReady(): void {
  if (ready) return
  ready = true
  requestAnimationFrame(() => measure('ready', performance.now() / 1000))
}

/** Reports a page opened: its name, the path, and the blueprint it shows, if any. */
export function trackPage(route: Route): void {
  page = PAGES[route.page]
  const props: Record<string, string> = { page, path: location.pathname }
  if ('blueprint' in route && route.blueprint) props.blueprint = route.blueprint
  track(PAGE_VIEWED, props)
}
