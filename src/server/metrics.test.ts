import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { metrics } from '@opentelemetry/api'
import { MeterProvider, MetricReader } from '@opentelemetry/sdk-metrics'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadConfig } from './config.ts'
import { createHub, type Hub } from './hub.ts'
import { operationOf } from './metrics.ts'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://orrery:orrery@localhost:5433/orrery'

class Reader extends MetricReader {
  protected async onShutdown(): Promise<void> {}
  protected async onForceFlush(): Promise<void> {}
}

const reader = new Reader()
let hub: Hub

/** Every recorded histogram point of one metric, as its attributes and count. */
async function points(name: string): Promise<{ attributes: Record<string, unknown>; count: number }[]> {
  const { resourceMetrics } = await reader.collect()
  const metric = resourceMetrics.scopeMetrics.flatMap((s) => s.metrics).find((m) => m.descriptor.name === name)
  return (metric?.dataPoints ?? []).map((p) => ({ attributes: p.attributes, count: typeof p.value === 'object' && p.value !== null && 'count' in p.value ? p.value.count : 0 }))
}

beforeAll(async () => {
  // The meter is set before the hub is made, as main.ts does.
  metrics.setGlobalMeterProvider(new MeterProvider({ readers: [reader] }))
  hub = await createHub(loadConfig({ DATABASE_URL, DATA_DIR: mkdtempSync(join(tmpdir(), 'orrery-')), AUTH_MODE: 'none' }), 'test', { reset: true })
})

afterAll(async () => {
  await hub.close()
  metrics.disable()
})

describe('metrics', () => {
  it('names a statement by its verb and first table, and nothing else', () => {
    expect(operationOf('SELECT * FROM entities WHERE blueprint = $1')).toEqual({ verb: 'select', table: 'entities' })
    expect(operationOf('  insert into runs (id) values ($1)')).toEqual({ verb: 'insert', table: 'runs' })
    expect(operationOf('UPDATE relations r SET source = $2 FROM entities e')).toEqual({ verb: 'update', table: 'relations' })
    expect(operationOf('BEGIN')).toEqual({ verb: 'begin', table: 'none' })
    expect(operationOf('SELECT 1 FROM pg_stat_activity')).toEqual({ verb: 'select', table: 'other' })
  })

  it('times the statements of pool queries and of transactions', async () => {
    await hub.db.query('SELECT count(*) FROM entities')
    await hub.db.tx((client) => client.query('SELECT count(*) FROM relations'))
    const queries = await points('db.client.operation.duration')
    const counted = (verb: string, table: string) => queries.find((p) => p.attributes['db.operation.name'] === verb && p.attributes['db.collection.name'] === table)?.count ?? 0
    expect(counted('select', 'entities')).toBeGreaterThan(0)
    expect(counted('select', 'relations')).toBeGreaterThan(0)
    expect(counted('begin', 'none')).toBeGreaterThan(0)
  })

  it('times a request under its route pattern, never the path it was asked on', async () => {
    const res = await hub.app.request('/v1/entities/service/nothing-here', {}, { surface: 'session' })
    expect(res.status).toBe(404)
    const requests = await points('http.server.request.duration')
    const hit = requests.find((p) => p.attributes['http.route'] === '/v1/entities/:blueprint/:key' && p.attributes['http.response.status_code'] === 404)
    expect(hit?.attributes['orrery.surface']).toBe('session')
    expect(requests.some((p) => String(p.attributes['http.route']).includes('nothing-here'))).toBe(false)
  })

  it('times the hub work a grid asks for, and counts whether its answer was kept', async () => {
    const grid = () => hub.app.request('/v1/entities?blueprint=service&limit=10&distribution=true', {}, { surface: 'session' })
    expect((await grid()).status).toBe(200)
    expect((await grid()).status).toBe(200)
    const tasks = await points('orrery.task.duration')
    expect(tasks.some((p) => p.attributes['orrery.task'] === 'listing.build' && p.attributes['orrery.outcome'] === 'ok')).toBe(true)
    const { resourceMetrics } = await reader.collect()
    const kept = resourceMetrics.scopeMetrics.flatMap((s) => s.metrics).find((m) => m.descriptor.name === 'orrery.kept.lookups')
    const results = new Set(kept?.dataPoints.filter((p) => p.attributes['orrery.kept'] === 'listing').map((p) => p.attributes['orrery.result']))
    expect(results).toEqual(new Set(['hit', 'miss']))
  })

  /** Every counter point of one metric, as its attributes and value. */
  const counts = async (name: string): Promise<{ attributes: Record<string, unknown>; value: number }[]> => {
    const { resourceMetrics } = await reader.collect()
    const metric = resourceMetrics.scopeMetrics.flatMap((s) => s.metrics).find((m) => m.descriptor.name === name)
    return (metric?.dataPoints ?? []).map((p) => ({ attributes: p.attributes, value: typeof p.value === 'number' ? p.value : 0 }))
  }

  it('counts how each request signed in, by surface and outcome', async () => {
    expect((await hub.app.request('/v1/whoami', { headers: { authorization: 'Bearer not-a-token' } }, { surface: 'machine' })).status).toBe(401)
    expect((await hub.app.request('/v1/whoami', {}, { surface: 'machine' })).status).toBe(401)
    expect((await hub.app.request('/v1/whoami', {}, { surface: 'session' })).status).toBe(200)
    const auth = await counts('orrery.auth')
    const of = (surface: string, outcome: string) => auth.find((p) => p.attributes['orrery.surface'] === surface && p.attributes['orrery.outcome'] === outcome)?.value ?? 0
    expect(of('machine', 'refused')).toBeGreaterThanOrEqual(2)
    expect(of('session', 'ok')).toBeGreaterThanOrEqual(1)
  })

  it('counts a refusal by its reason: a filter that reads what the caller may not see', async () => {
    // The local admin sees everything; a filter on a field no blueprint has is still answered. A hidden read is refused under its reason.
    const token = (await hub.sources.issueToken('access', 'reader', { role: 'viewer' })).token
    const res = await hub.app.request('/v1/blueprints/zzz', { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' }, { surface: 'machine' })
    expect(res.status).toBe(403)
    const refusals = await counts('orrery.refusals')
    expect(refusals.find((p) => p.attributes['orrery.reason'] === 'permission')?.value ?? 0).toBeGreaterThanOrEqual(1)
  })

  it('counts an agent tool call under a tool the hub has, and starts every tool and refusal reason at zero', async () => {
    const token = (await hub.sources.issueToken('access', 'agent-metrics', { role: 'viewer' })).token
    const call = (name: string) => hub.app.request('/mcp', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } }) }, { surface: 'machine' })
    await call('estate_summary')
    await call('a-name-the-caller-made-up')
    const agent = await counts('orrery.agent.calls')
    const of = (tool: string) => agent.find((p) => p.attributes['orrery.tool'] === tool)?.value
    expect(of('estate_summary')).toBe(1)
    expect(of('unknown')).toBe(1)
    expect(of('a-name-the-caller-made-up')).toBeUndefined()
    expect(of('run_action')).toBe(0)
    expect((await counts('orrery.refusals')).find((p) => p.attributes['orrery.reason'] === 'blueprint_not_offered')?.value).toBe(0)
  })

  it("counts a page's views, waits, and errors as the browser reports them, and who is active", async () => {
    const batch = {
      session: 'tab-metrics',
      signals: [
        { kind: 'event', name: 'Page Viewed', props: { page: 'Catalog', path: '/inventory/service' } },
        { kind: 'measure', name: 'wait', page: 'Catalog', value: 0.42 },
        { kind: 'measure', name: 'lcp', page: 'Catalog', value: 1.2 },
        { kind: 'measure', name: 'cls', page: 'Catalog', value: 0.03 },
        { kind: 'error', type: 'TypeError', message: 'x is undefined' },
      ],
    }
    // Who is present is read from the database: the person a sign-in enrolled, and the tab that reported.
    await hub.access.seen('person@example.com', false)
    expect((await hub.app.request('/v1/telemetry', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(batch) }, { surface: 'session' })).status).toBe(204)
    expect((await counts('orrery.browser.views')).find((p) => p.attributes['orrery.page'] === 'Catalog')?.value).toBe(1)
    const waits = await points('orrery.browser.wait')
    expect(waits.find((p) => p.attributes['orrery.page'] === 'Catalog' && p.attributes['orrery.measure'] === 'wait')?.count).toBe(1)
    expect(waits.find((p) => p.attributes['orrery.measure'] === 'lcp')?.count).toBe(1)
    expect((await points('orrery.browser.shift')).find((p) => p.attributes['orrery.page'] === 'Catalog')?.count).toBe(1)
    expect((await counts('orrery.browser.errors'))[0]?.value).toBe(1)
    const { resourceMetrics } = await reader.collect()
    const gauge = (name: string) => resourceMetrics.scopeMetrics.flatMap((s) => s.metrics).find((m) => m.descriptor.name === name)?.dataPoints[0]?.value
    expect(gauge('orrery.browser.sessions')).toBe(1)
    expect(gauge('orrery.people')).toBe(1)
    expect(typeof gauge('orrery.queue.depth')).toBe('number')
    // Every usage event is a series from the start, at zero until it happens, so the board can list what nobody uses.
    const usage = await counts('orrery.usage.events')
    expect(usage.find((p) => p.attributes['orrery.event'] === 'Entity Deleted')?.value).toBe(0)
    expect(usage.find((p) => p.attributes['orrery.event'] === 'Page Viewed' && p.attributes['orrery.source'] === 'web')?.value).toBe(1)
    // A request is timed under the release, so a board compares one release's routes with the one before.
    expect((await points('http.server.request.duration')).every((p) => p.attributes['orrery.version'] === 'test')).toBe(true)
    // A page name the web app does not have, or a wait no page takes, is refused.
    expect((await hub.app.request('/v1/telemetry', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: 's', signals: [{ kind: 'measure', name: 'wait', page: 'x'.repeat(50), value: 1 }] }) }, { surface: 'session' })).status).toBe(400)
  })
})
