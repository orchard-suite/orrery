import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { loadConfig } from './config.ts'
import { loadFixtureCatalog } from './fixtures/load.ts'
import { createHub, type Hub } from './hub.ts'
import { AGENT_TOOLS } from './mcp.ts'
import { ENTITY_LINKS, type EntitiesResponse, type EntityPageResponse, type SummaryResponse } from '../shared/api.ts'
import { SHOWN_LINKS, type Card, type LinkGroup } from './cards.ts'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://orrery:orrery@localhost:5433/orrery'

let hub: Hub
let token = ''
let enrichToken = ''

const session = (path: string, init?: RequestInit) => hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', ...init?.headers } }, { surface: 'session' })
const machine = (path: string, init?: RequestInit, bearer = token) => hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}`, ...init?.headers } }, { surface: 'machine' })
const json = async <T = Record<string, unknown>>(r: Response): Promise<T> => (await r.json()) as T
const body = (v: unknown) => ({ body: JSON.stringify(v) })

async function snapshot(entities: unknown[], scope = 'home', bearer = token): Promise<Record<string, unknown>> {
  const run = await json<{ id: string }>(await machine('/v1/ingest/runs', { method: 'POST', ...body({ mode: 'snapshot', scope }) }, bearer))
  const batch = await machine(`/v1/ingest/runs/${run.id}/entities`, { method: 'PUT', ...body({ entities }) }, bearer)
  expect([200, 207]).toContain(batch.status)
  const committed = await machine(`/v1/ingest/runs/${run.id}/commit`, { method: 'POST' }, bearer)
  expect(committed.status).toBe(200)
  return json(committed)
}

// A spy a failed test leaves behind would wrap the next test's: every one is let go after each test.
afterEach(() => {
  vi.restoreAllMocks()
})

beforeAll(async () => {
  const config = loadConfig({ DATABASE_URL, DATA_DIR: mkdtempSync(join(tmpdir(), 'orrery-')), AUTH_MODE: 'none' })
  hub = await createHub(config, 'test', { reset: true })
  const report = await loadFixtureCatalog(hub)
  expect(report.errors).toEqual([])
  await hub.sources.save('k8s@home', { title: 'k8s home', class: 'pusher', blueprints: ['k8s_cluster', 'k8s_node', 'k8s_namespace', 'k8s_workload', 'k8s_pod', 'k8s_service', 'k8s_ingress'], deleteGrant: ['k8s_workload'], cadence: '3m', grace: { runs: 2, duration: '0' } })
  await hub.sources.save('finops', { title: 'finops', class: 'pusher', blueprints: ['*'], deleteGrant: [], cadence: '26h' })
  token = (await hub.sources.issueToken('source', 'home pusher', { source: 'k8s@home' })).token
  enrichToken = (await hub.sources.issueToken('source', 'finops', { source: 'finops' })).token
})

afterAll(async () => {
  await hub.close()
})

describe('catalog', () => {
  it('loads a catalog as git-defined, beside the hub\'s own blueprints', async () => {
    const res = await json<{ blueprints: { id: string; origin: { kind: string } }[] }>(await session('/v1/blueprints'))
    const ids = res.blueprints.map((b) => b.id)
    expect(ids).toEqual(expect.arrayContaining(['orrery_source', 'orrery_runner', 'system', 'k8s_cluster', 'k8s_workload']))
    expect(res.blueprints.find((b) => b.id === 'orrery_source')?.origin.kind).toBe('hub')
    expect(res.blueprints.find((b) => b.id === 'system')?.origin.kind).toBe('git')
    expect(hub.rules.list().map((r) => r.id)).toContain('k8s_namespace.system')
  })

  it('records nothing in the activity log when git reads the same catalog again', async () => {
    const definitions = 'kind=blueprint.changed,rule.changed,scorecard.changed,alert_rule.changed,source.changed&limit=1000'
    const before = (await json<{ changes: unknown[] }>(await session(`/v1/changes?${definitions}`))).changes.length
    expect(before).toBeGreaterThan(10)
    expect((await loadFixtureCatalog(hub)).errors).toEqual([])
    expect((await json<{ changes: unknown[] }>(await session(`/v1/changes?${definitions}`))).changes.length).toBe(before)
  })

  it('refuses a UI edit of a git blueprint', async () => {
    const res = await session('/v1/blueprints/system', { method: 'PUT', ...body({ title: 'System', fields: {} }) })
    expect(res.status).toBe(400)
    expect((await json(res)).error).toMatch(/defined in git/)
  })
})

describe('answers on the wire', () => {
  it('gzips a large answer for a client that takes it, and never the event stream', async () => {
    const gzip = { headers: { 'accept-encoding': 'gzip' } }
    const blueprints = await session('/v1/blueprints', gzip)
    expect(blueprints.headers.get('content-encoding')).toBe('gzip')
    expect(await new Response(blueprints.body!.pipeThrough(new DecompressionStream('gzip'))).json()).toMatchObject({ blueprints: expect.any(Array) })
    expect((await session('/v1/blueprints')).headers.get('content-encoding')).toBeNull()
    const stream = await session('/v1/events', gzip)
    expect(stream.headers.get('content-type')).toMatch(/^text\/event-stream/)
    expect(stream.headers.get('content-encoding')).toBeNull()
    await stream.body?.cancel()
  })
})

describe('ingest and precedence', () => {
  it('needs a source token on the machine surface', async () => {
    expect((await hub.app.request('/v1/summary', {}, { surface: 'machine' })).status).toBe(400 + 1)
    expect((await machine('/v1/ingest/runs', { method: 'POST', ...body({ mode: 'snapshot', scope: 'x' }) }, 'orr_src_nope')).status).toBe(401)
  })

  it('creates entities from a snapshot and connects pending relations when the target arrives', async () => {
    await snapshot([
      { blueprint: 'k8s_workload', key: 'home/beacon/gateway', title: 'gateway', fields: { name: 'gateway', kind: 'Deployment', replicas: 2, ready: 2, health: 'green', labels: { 'app.kubernetes.io/part-of': 'beacon' } }, relations: { namespace: 'home/beacon' } },
      { blueprint: 'k8s_namespace', key: 'home/beacon', title: 'beacon', fields: { name: 'beacon' }, relations: { cluster: 'home' } },
    ])
    let detail = await json<{ outgoing: { relation: string; pending: boolean }[] }>(await session('/v1/entities/k8s_namespace/home%2Fbeacon'))
    expect(detail.outgoing).toEqual([expect.objectContaining({ relation: 'cluster', pending: true })])
    await snapshot([{ blueprint: 'k8s_cluster', key: 'home', title: 'home', fields: { version: 'v1.31.0' } }], 'home-cluster')
    detail = await json(await session('/v1/entities/k8s_namespace/home%2Fbeacon'))
    expect(detail.outgoing).toEqual([expect.objectContaining({ relation: 'cluster', pending: false })])
    const cluster = await json<{ fields: Record<string, unknown>; incoming: unknown[] }>(await session('/v1/entities/k8s_cluster/home'))
    expect(cluster.fields.namespaces).toBe(1)
    expect(cluster.incoming).toHaveLength(1)
  })

  it('counts the entities each source owns of each blueprint', async () => {
    const { counts, held } = await json<{ counts: Record<string, number>; held: Record<string, Record<string, number>> }>(await session('/v1/blueprints'))
    expect(held.k8s_workload).toEqual({ 'k8s@home': 1 })
    expect(counts.k8s_workload).toBe(1)
    expect(Object.keys(held.orrery_source ?? {})).toEqual(['hub'])
  })

  it('links a namespace to its system through the relation rule and rolls status up', async () => {
    const created = await session('/v1/entities', { method: 'POST', ...body({ blueprint: 'system', key: 'beacon', title: 'Beacon', fields: { tier: 'critical' } }) })
    expect(created.status).toBe(201)
    await hub.rules.evaluateAll()
    const ns = await json<{ relations: Record<string, { key: string }[]> }>(await session('/v1/entities/k8s_namespace/home%2Fbeacon'))
    expect(ns.relations.system).toEqual([{ blueprint: 'system', key: 'beacon', title: 'Beacon' }])
    const wl = await json<{ relations: Record<string, { key: string }[]> }>(await session('/v1/entities/k8s_workload/home%2Fbeacon%2Fgateway'))
    expect(wl.relations.system?.[0]?.key).toBe('beacon')
    const sys = await json<{ status: { level: string }; fields: Record<string, unknown> }>(await session('/v1/entities/system/beacon'))
    expect(sys.status.level).toBe('green')
    expect(sys.fields.workloads).toBe(1)
    // The workload turns red; the system follows.
    await snapshot([
      { blueprint: 'k8s_workload', key: 'home/beacon/gateway', title: 'gateway', fields: { name: 'gateway', kind: 'Deployment', replicas: 2, ready: 0, health: 'red', health_reason: '0/2 ready', labels: { 'app.kubernetes.io/part-of': 'beacon' } }, relations: { namespace: 'home/beacon' } },
      { blueprint: 'k8s_namespace', key: 'home/beacon', title: 'beacon', fields: { name: 'beacon' }, relations: { cluster: 'home' } },
    ])
    // The system reads the workload: it follows once the leader has derived what the run wrote.
    for (let i = 0; i < 6; i++) await hub.deriver.drain()
    const red = await json<{ status: { level: string; reasons: string[] } }>(await session('/v1/entities/system/beacon'))
    expect(red.status.level).toBe('red')
    expect(red.status.reasons[0]).toMatch(/0\/2 ready/)
    const wall = await json<{ groups: { blueprint: string; cells: { level: string }[] }[] }>(await session('/v1/wall'))
    expect(wall.groups.find((g) => g.blueprint === 'system')?.cells[0]?.level).toBe('red')
    // The summary counts what is not green per blueprint, and names the reds first.
    const summary = await json<SummaryResponse>(await session('/v1/summary'))
    expect(summary.blueprints.find((b) => b.id === 'system')?.notGreen.red).toBe(1)
    expect(summary.blueprints.find((b) => b.id === 'k8s_workload')?.notGreen.red).toBe(1)
    expect(summary.notGreen[0]?.level).toBe('red')
  })

  it('is idempotent: an unchanged push records nothing', async () => {
    const before = (await json<{ changes: unknown[] }>(await session('/v1/changes?blueprint=k8s_workload&key=home%2Fbeacon%2Fgateway'))).changes.length
    const run = await snapshot([
      { blueprint: 'k8s_workload', key: 'home/beacon/gateway', title: 'gateway', fields: { name: 'gateway', kind: 'Deployment', replicas: 2, ready: 0, health: 'red', health_reason: '0/2 ready', labels: { 'app.kubernetes.io/part-of': 'beacon' } }, relations: { namespace: 'home/beacon' } },
      { blueprint: 'k8s_namespace', key: 'home/beacon', title: 'beacon', fields: { name: 'beacon' }, relations: { cluster: 'home' } },
    ])
    expect((run.counts as { unchanged: number }).unchanged).toBe(2)
    const after = (await json<{ changes: unknown[] }>(await session('/v1/changes?blueprint=k8s_workload&key=home%2Fbeacon%2Fgateway'))).changes.length
    expect(after).toBe(before)
  })

  it('soft overrides follow the pushed value and clear when it moves', async () => {
    expect((await session('/v1/blueprints/azure_sql_database', { method: 'PUT', ...body({ title: 'Azure SQL Database', fields: { sku: { type: 'string' }, notes: { type: 'markdown' } } }) })).status).toBe(200)
    const push = (sku: string) => machine('/v1/ingest/entities/azure_sql_database/orders', { method: 'PATCH', ...body({ fields: { sku } }) }, enrichToken)
    expect((await push('S1')).status).toBe(201)
    const edit = await session('/v1/entities/azure_sql_database/orders', { method: 'PATCH', ...body({ fields: { sku: 'S1 (reserved)', notes: 'the orders db' } }) })
    expect(edit.status).toBe(200)
    let e = await json<{ fields: Record<string, unknown>; provenance: Record<string, { layer: string; replaced?: unknown }> }>(await session('/v1/entities/azure_sql_database/orders?provenance=true'))
    expect(e.fields.sku).toBe('S1 (reserved)')
    expect(e.provenance.sku).toMatchObject({ layer: 'override', replaced: 'S1' })
    expect(e.provenance.notes?.layer).toBe('ui')
    // Same pushed value: the override stays.
    await push('S1')
    e = await json(await session('/v1/entities/azure_sql_database/orders?provenance=true'))
    expect(e.fields.sku).toBe('S1 (reserved)')
    // Pushed value moves: the override clears and the timeline says so.
    await push('S2')
    e = await json(await session('/v1/entities/azure_sql_database/orders?provenance=true'))
    expect(e.fields.sku).toBe('S2')
    expect(e.provenance.sku?.layer).toBe('pushed')
    expect(e.fields.notes).toBe('the orders db')
    const cleared = await json<{ changes: { kind: string }[] }>(await session('/v1/changes?kind=override.cleared'))
    expect(cleared.changes.length).toBeGreaterThan(0)
    // Flipping back does not revive it.
    await push('S1')
    e = await json(await session('/v1/entities/azure_sql_database/orders?provenance=true'))
    expect(e.fields.sku).toBe('S1')
    const findings = await json<{ findings: { kind: string }[] }>(await session('/v1/findings'))
    expect(findings.findings.some((f) => f.kind === 'cleared_override')).toBe(true)
  })

  it('raises nothing when a source catches up to what a person set', async () => {
    const push = (sku: string) => machine('/v1/ingest/entities/azure_sql_database/invoices', { method: 'PATCH', ...body({ fields: { sku } }) }, enrichToken)
    expect((await push('P1')).status).toBe(201)
    expect((await session('/v1/entities/azure_sql_database/invoices', { method: 'PATCH', ...body({ fields: { sku: 'P2' } }) })).status).toBe(200)
    await push('P2')
    const e = await json<{ fields: Record<string, unknown> }>(await session('/v1/entities/azure_sql_database/invoices'))
    expect(e.fields.sku).toBe('P2')
    const { findings } = await json<{ findings: { kind: string; entity?: { key: string } }[] }>(await session('/v1/findings'))
    expect(findings.filter((f) => f.kind === 'cleared_override' && f.entity?.key === 'invoices')).toEqual([])
  })

  it('accepts keys with spaces and strips NUL from values', async () => {
    const res = await machine('/v1/ingest/entities/k8s_cluster/failure%20anomalies%20-%20x', { method: 'PUT', ...body({ title: 'odd\u0000name', fields: { version: 'x' } }) })
    expect(res.status).toBe(201)
    const e = await json<{ title: string }>(await session('/v1/entities/k8s_cluster/failure%20anomalies%20-%20x'))
    expect(e.title).toBe('oddname')
  })

  it('keeps one relation for a target named twice', async () => {
    const res = await machine('/v1/ingest/entities/k8s_workload/home%2Fbeacon%2Ftwice', { method: 'PUT', ...body({ title: 'twice', fields: { name: 'twice' }, relations: { namespace: 'home/beacon', node: ['home/n1', 'home/n1'] } }) })
    expect(res.status).toBe(201)
    const e = await json<{ outgoing: { relation: string }[] }>(await session('/v1/entities/k8s_workload/home%2Fbeacon%2Ftwice'))
    expect(e.outgoing.filter((o) => o.relation === 'node')).toHaveLength(1)
  })

  it('locks non-overridable fields and refuses unknown fields with a named reason', async () => {
    const locked = await session('/v1/entities/k8s_workload/home%2Fbeacon%2Fgateway', { method: 'PATCH', ...body({ fields: { health: 'green' } }) })
    expect(locked.status).toBe(403)
    const bad = await machine('/v1/ingest/entities/k8s_workload/home%2Fbeacon%2Fgateway', { method: 'PATCH', ...body({ fields: { colour: 'blue', replicas: 'two' } }) })
    expect(bad.status).toBe(422)
    const errors = (await json<{ errors: { field: string; reason: string }[] }>(bad)).errors
    expect(errors).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'colour' }), expect.objectContaining({ field: 'replicas', reason: expect.stringMatching(/number/) })]))
  })

  it('enrich adds fields but never creates and never keeps alive', async () => {
    const missing = await machine('/v1/ingest/entities/k8s_workload/home%2Fbeacon%2Fnope', { method: 'PATCH', ...body({ mode: 'enrich', fields: { notes: 'x' } }) }, enrichToken)
    expect(missing.status).toBe(422)
    const ok = await machine('/v1/ingest/entities/k8s_workload/home%2Fbeacon%2Fgateway', { method: 'PATCH', ...body({ mode: 'enrich', fields: { notes: 'costs $4/mo' } }) }, enrichToken)
    expect(ok.status).toBe(200)
    const e = await json<{ owner: string; provenance: Record<string, { source: string }> }>(await session('/v1/entities/k8s_workload/home%2Fbeacon%2Fgateway?provenance=true'))
    expect(e.owner).toBe('k8s@home')
    expect(e.provenance.notes?.source).toBe('finops')
  })

  it('ignores writes older than what it holds', async () => {
    await machine('/v1/ingest/entities/k8s_workload/home%2Fbeacon%2Fgateway', { method: 'PATCH', ...body({ fields: { ready: 2 }, observedAt: '2026-09-30T10:00:00Z' }) })
    await machine('/v1/ingest/entities/k8s_workload/home%2Fbeacon%2Fgateway', { method: 'PATCH', ...body({ fields: { ready: 1 }, observedAt: '2026-09-30T09:00:00Z' }) })
    const e = await json<{ fields: Record<string, unknown> }>(await session('/v1/entities/k8s_workload/home%2Fbeacon%2Fgateway'))
    expect(e.fields.ready).toBe(2)
  })
})

describe('lifecycle', () => {
  it('marks unseen entities missing and deletes them after grace, keeping UI values for a return', async () => {
    const worker = { blueprint: 'k8s_workload', key: 'home/beacon/worker', title: 'worker', fields: { name: 'worker', kind: 'Deployment', health: 'green' }, relations: { namespace: 'home/beacon' } }
    const rest = [
      { blueprint: 'k8s_namespace', key: 'home/beacon', title: 'beacon', fields: { name: 'beacon' }, relations: { cluster: 'home' } },
      ...['gateway', 'api', 'scheduler', 'mailer', 'indexer'].map((name) => ({ blueprint: 'k8s_workload', key: `home/beacon/${name}`, title: name, fields: { name, kind: 'Deployment', health: 'green' }, relations: { namespace: 'home/beacon' } })),
    ]
    await snapshot([worker, ...rest])
    await session('/v1/entities/k8s_workload/home%2Fbeacon%2Fworker', { method: 'PATCH', ...body({ fields: { notes: 'keep me' } }) })
    // One snapshot without it: missing (grace is 2 runs).
    await snapshot(rest)
    let e = await json<{ state: string; status: { level: string } }>(await session('/v1/entities/k8s_workload/home%2Fbeacon%2Fworker'))
    expect(e.state).toBe('missing')
    expect(e.status.level).toBe('grey')
    // Second: deleted.
    await snapshot(rest)
    expect((await session('/v1/entities/k8s_workload/home%2Fbeacon%2Fworker')).status).toBe(404)
    const tomb = await json<{ state: string }>(await session('/v1/entities/k8s_workload/home%2Fbeacon%2Fworker?deleted=true'))
    expect(tomb.state).toBe('deleted')
    // It comes back with its note.
    await snapshot([worker, ...rest])
    e = await json(await session('/v1/entities/k8s_workload/home%2Fbeacon%2Fworker'))
    expect(e.state).toBe('active')
    expect((e as unknown as { fields: Record<string, unknown> }).fields.notes).toBe('keep me')
  })

  it('shows a missing entity grey, never the health its source last said', async () => {
    const rest = [
      { blueprint: 'k8s_namespace', key: 'home/beacon', title: 'beacon', fields: { name: 'beacon' }, relations: { cluster: 'home' } },
      ...['gateway', 'api', 'scheduler', 'mailer', 'indexer'].map((name) => ({ blueprint: 'k8s_workload', key: `home/beacon/${name}`, title: name, fields: { name, kind: 'Deployment', health: 'green' }, relations: { namespace: 'home/beacon' } })),
    ]
    const gone = { blueprint: 'k8s_workload', key: 'home/beacon/retired', title: 'retired', fields: { name: 'retired', kind: 'Deployment', health: 'red', health_reason: 'no report for 15h' }, relations: { namespace: 'home/beacon' } }
    await snapshot([gone, ...rest])
    await snapshot(rest)
    const e = await json<{ state: string; status: { level: string; reasons: string[] } }>(await session('/v1/entities/k8s_workload/home%2Fbeacon%2Fretired'))
    expect(e.state).toBe('missing')
    expect(e.status.level).toBe('grey')
    expect(e.status.reasons).toEqual([expect.stringMatching(/^not seen since /)])
    await snapshot(rest)
  })

  it('holds a mass drop with extended grace, turns the source amber, and lets a person delete now', async () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ blueprint: 'k8s_pod', key: `home/beacon/pod-${i}`, title: `pod-${i}`, fields: { phase: 'Running', health: 'green' }, relations: { namespace: 'home/beacon' } }))
    await snapshot(many, 'pods')
    const run = await snapshot(many.slice(0, 2), 'pods')
    expect(run.massDrop).toBe(true)
    const src = await json<{ source: { status: string } }>(await session('/v1/sources/k8s@home'))
    expect(src.source.status).toBe('amber')
    const list = await json<{ total: number }>(await session('/v1/entities?blueprint=k8s_pod&state=missing'))
    expect(list.total).toBe(8)
    const findings = await json<{ findings: { kind: string; entities?: unknown[] }[] }>(await session('/v1/findings'))
    const drop = findings.findings.find((f) => f.kind === 'mass_drop')
    expect(drop?.entities).toHaveLength(8)
    const del = await session('/v1/findings/delete-now', { method: 'POST', ...body({ entities: drop?.entities }) })
    expect(del.status).toBe(200)
    expect((await json<{ total: number }>(await session('/v1/entities?blueprint=k8s_pod&state=missing'))).total).toBe(0)
    // A clean run clears amber.
    await snapshot(many.slice(0, 2), 'pods')
    expect((await json<{ source: { status: string } }>(await session('/v1/sources/k8s@home'))).source.status).toBe('green')
  })

  it('explicit deletes take effect now and block re-creation for a while', async () => {
    const res = await machine('/v1/ingest/entities/k8s_workload/home%2Fbeacon%2Fgateway', { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect((await session('/v1/entities/k8s_workload/home%2Fbeacon%2Fgateway')).status).toBe(404)
    const again = await machine('/v1/ingest/entities/k8s_workload/home%2Fbeacon%2Fgateway', { method: 'PUT', ...body({ title: 'gateway', fields: { name: 'gateway', kind: 'Deployment' } }) })
    expect(again.status).toBe(422)
    expect(JSON.stringify(await json(again))).toMatch(/blocked/)
    const noGrant = await machine('/v1/ingest/entities/k8s_namespace/home%2Fbeacon', { method: 'DELETE' })
    expect(noGrant.status).toBe(403)
  })

  it('a run that fails deletes nothing', async () => {
    const run = await json<{ id: string }>(await machine('/v1/ingest/runs', { method: 'POST', ...body({ mode: 'snapshot', scope: 'home' }) }))
    await machine(`/v1/ingest/runs/${run.id}/entities`, { method: 'PUT', ...body({ entities: [] }) })
    await machine(`/v1/ingest/runs/${run.id}/fail`, { method: 'POST', ...body({ reason: 'API timeout' }) })
    const ns = await json<{ state: string }>(await session('/v1/entities/k8s_namespace/home%2Fbeacon'))
    expect(ns.state).toBe('active')
    expect((await json<{ source: { status: string } }>(await session('/v1/sources/k8s@home'))).source.status).toBe('red')
  })
})

describe('ui entities and blueprints', () => {
  it('refuses to delete a pusher-owned entity from the UI but hides it', async () => {
    expect((await session('/v1/entities/k8s_namespace/home%2Fbeacon', { method: 'DELETE' })).status).toBe(403)
    expect((await session('/v1/entities/k8s_namespace/home%2Fbeacon/hidden', { method: 'PUT', ...body({ hidden: true }) })).status).toBe(200)
    expect((await json<{ total: number }>(await session('/v1/entities?blueprint=k8s_namespace'))).total).toBe(0)
    expect((await json<{ total: number }>(await session('/v1/entities?blueprint=k8s_namespace&hidden=true'))).total).toBe(1)
    await session('/v1/entities/k8s_namespace/home%2Fbeacon/hidden', { method: 'PUT', ...body({ hidden: false }) })
  })

  it('saves a UI blueprint, allows adding a field, refuses a type change that does not fit', async () => {
    const save = await session('/v1/blueprints/office', { method: 'PUT', ...body({ title: 'Office', fields: { address: { type: 'string' }, seats: { type: 'string' } } }) })
    expect(save.status).toBe(200)
    await session('/v1/entities', { method: 'POST', ...body({ blueprint: 'office', key: 'denver', title: 'Denver', fields: { seats: 'forty' } }) })
    const add = await session('/v1/blueprints/office', { method: 'PUT', ...body({ title: 'Office', fields: { address: { type: 'string' }, seats: { type: 'string' }, isp: { type: 'string' } } }) })
    expect(add.status).toBe(200)
    const change = await session('/v1/blueprints/office', { method: 'PUT', ...body({ title: 'Office', fields: { address: { type: 'string' }, seats: { type: 'number' } } }) })
    expect(change.status).toBe(400)
    expect((await json<{ offenders: { key: string; field: string }[] }>(change)).offenders).toEqual([expect.objectContaining({ key: 'denver', field: 'seats' })])
  })

  it('enforces the nesting guardrails', async () => {
    const many = await session('/v1/blueprints/rack', { method: 'PUT', ...body({ title: 'Rack', relations: { offices: { target: 'office', many: true, display: 'contain' } } }) })
    expect((await json(many)).error).toMatch(/to-one/)
    expect((await session('/v1/blueprints/rack', { method: 'PUT', ...body({ title: 'Rack', relations: { office: { target: 'office', display: 'contain' } } }) })).status).toBe(200)
    expect((await session('/v1/blueprints/host', { method: 'PUT', ...body({ title: 'Host', relations: { rack: { target: 'rack', display: 'contain' } } }) })).status).toBe(200)
    const deep = await session('/v1/blueprints/vm', { method: 'PUT', ...body({ title: 'VM', relations: { host: { target: 'host', display: 'contain' } } }) })
    expect((await json(deep)).error).toMatch(/levels deep/)
  })

  it('cuts each entity to the fields and relations asked for, keeping its shape, even for a field named as the hub names what it keeps', async () => {
    expect((await session('/v1/blueprints/gizmo', { method: 'PUT', ...body({ title: 'Gizmo', fields: { status: { type: 'string' }, size: { type: 'number' } }, relations: { system: { target: 'system' }, spare: { target: 'system' } } }) })).status).toBe(200)
    expect((await session('/v1/entities', { method: 'POST', ...body({ blueprint: 'gizmo', key: 'g1', title: 'G1', fields: { status: 'succeeded', size: 3 }, relations: { system: 'beacon', spare: 'beacon' } }) })).status).toBe(201)
    const one = async (query: string) => (await json<EntitiesResponse>(await session(`/v1/entities?blueprint=gizmo&${query}`))).entities[0]!
    const cut = await one('fields=status&relations=system')
    expect(cut).toMatchObject({ key: 'g1', title: 'G1', state: 'active', fields: { status: 'succeeded' }, relations: { system: [expect.objectContaining({ key: 'beacon' })] } })
    expect(cut.status.level).toBeDefined()
    expect(cut.fields).not.toHaveProperty('size')
    expect(cut.relations).not.toHaveProperty('spare')
    // Given empty, none; not given, all.
    const bare = await one('fields=&relations=')
    expect([bare.fields, bare.relations]).toEqual([{}, {}])
    const whole = await one('')
    expect(whole.fields).toMatchObject({ status: 'succeeded', size: 3 })
    expect(Object.keys(whole.relations).sort()).toEqual(['spare', 'system'])
  })

  it('pages after a cursor in every order a list takes, row for row as one page gives them', async () => {
    expect((await session('/v1/blueprints/crate', { method: 'PUT', ...body({ title: 'Crate', fields: { size: { type: 'number' }, label: { type: 'string' }, tag: { type: 'string' } }, relations: {} }) })).status).toBe(200)
    // Ties, a precise decimal, numbers too long for JSON, text in both cases, and nothing at all, so every part of the order is walked.
    const sizes = [3, 10, null, 2.5, 3, 0.30000000000000004, 7, null, 12345678901234567890, -1]
    const labels = ['b', 'a', null, 'B', 'b', 'a10', 'a9', null]
    for (let i = 0; i < 26; i++) {
      const size = sizes[i % sizes.length]
      const label = labels[i % labels.length]
      const fields = { ...(size === null ? {} : { size }), ...(label === null ? {} : { label }), ...(i % 3 ? { tag: `t${i % 3}` } : {}) }
      expect((await session('/v1/entities', { method: 'POST', ...body({ blueprint: 'crate', key: `c${String(i).padStart(2, '0')}`, title: i % 4 === 0 ? 'Same' : `Crate ${i % 7}`, fields }) })).status).toBe(201)
    }
    for (const order of ['', '&sort=size', '&sort=-size', '&sort=label', '&sort=-label', '&group=tag', '&group=tag&sort=-size', '&sort=-title']) {
      const whole = await json<EntitiesResponse>(await session(`/v1/entities?blueprint=crate&limit=100${order}`))
      expect(whole.next).toBeNull()
      const walked: string[] = []
      let after: string | null = null
      do {
        const page: EntitiesResponse = await json<EntitiesResponse>(await session(`/v1/entities?blueprint=crate&limit=4${order}${after ? `&after=${encodeURIComponent(after)}` : ''}`))
        walked.push(...page.entities.map((e) => e.key))
        after = page.next
      } while (after && walked.length < 100)
      expect([order, walked]).toEqual([order, whole.entities.map((e) => e.key)])
    }
    // A grid's kept list pages the same way.
    const first = await json<EntitiesResponse>(await session('/v1/entities?blueprint=crate&limit=10&group=tag&distribution=later'))
    const second = await json<EntitiesResponse>(await session(`/v1/entities?blueprint=crate&limit=10&group=tag&distribution=later&after=${encodeURIComponent(first.next!)}`))
    const byOffset = await json<EntitiesResponse>(await session('/v1/entities?blueprint=crate&limit=10&offset=10&group=tag&distribution=later'))
    expect(second.entities.map((e) => e.key)).toEqual(byOffset.entities.map((e) => e.key))
    // A cursor fits only the list it came from.
    expect((await session(`/v1/entities?blueprint=crate&limit=4&sort=size&after=${encodeURIComponent(first.next!)}`)).status).toBe(400)
    expect((await session(`/v1/entities?blueprint=crate&limit=4&after=not-a-cursor`)).status).toBe(400)
    expect((await session(`/v1/entities?blueprint=crate&limit=4&offset=4&after=${encodeURIComponent(first.next!)}`)).status).toBe(400)
  })

  it('answers a caller who already holds the answer with nothing, until something it reads moves', async () => {
    expect((await session('/v1/blueprints/shelf', { method: 'PUT', ...body({ title: 'Shelf', fields: { size: { type: 'number' } }, relations: {} }) })).status).toBe(200)
    expect((await session('/v1/blueprints/bin', { method: 'PUT', ...body({ title: 'Bin', fields: {}, relations: { shelf: { target: 'shelf' } } }) })).status).toBe(200)
    expect((await session('/v1/blueprints/loose', { method: 'PUT', ...body({ title: 'Loose', fields: {}, relations: {} }) })).status).toBe(200)
    expect((await session('/v1/entities', { method: 'POST', ...body({ blueprint: 'shelf', key: 's1', title: 'S1', fields: { size: 1 } }) })).status).toBe(201)
    const ask = (path: string, tag?: string | null) => session(path, tag ? { headers: { 'if-none-match': tag } } : {})
    const list = '/v1/entities?blueprint=shelf&fields=size'
    const first = await ask(list)
    const tag = first.headers.get('etag')
    expect(first.status).toBe(200)
    expect(first.headers.get('cache-control')).toBe('private, no-cache')
    const again = await ask(list, tag)
    expect([again.status, await again.text()]).toEqual([304, ''])
    // Another question is another answer.
    expect((await ask(`${list}&limit=1`, tag)).status).toBe(200)
    // A blueprint the list neither reads nor shows beside its rows moves: still the same answer.
    expect((await session('/v1/entities', { method: 'POST', ...body({ blueprint: 'loose', key: 'l1', title: 'L1' }) })).status).toBe(201)
    expect((await ask(list, tag)).status).toBe(304)
    // A blueprint whose rows point at it moves: the list may show who points, so it is answered again.
    expect((await session('/v1/entities', { method: 'POST', ...body({ blueprint: 'bin', key: 'b1', title: 'B1', relations: { shelf: 's1' } }) })).status).toBe(201)
    const moved = await ask(list, tag)
    expect(moved.status).toBe(200)
    const next = moved.headers.get('etag')
    expect(next).not.toBe(tag)
    // Its own rows move.
    expect((await session('/v1/entities/shelf/s1', { method: 'PATCH', ...body({ fields: { size: 2 } }) })).status).toBe(200)
    const changed = await ask(list, next)
    expect(changed.status).toBe(200)
    expect((await json<EntitiesResponse>(changed)).entities[0]!.fields.size).toBe(2)

    // A page built from the whole estate is named by the answer kept: the same answer, nothing sent.
    const front = await ask('/v1/summary')
    expect((await ask('/v1/summary', front.headers.get('etag'))).status).toBe(304)
    expect((await session('/v1/entities', { method: 'POST', ...body({ blueprint: 'shelf', key: 's2', title: 'S2' }) })).status).toBe(201)
    const after = await ask('/v1/summary', front.headers.get('etag'))
    expect(after.status).toBe(200)
    expect((await json<SummaryResponse>(after)).blueprints.find((b) => b.id === 'shelf')?.active).toBe(2)
  })

  it('searches with the filter DSL and exports UI data as YAML', async () => {
    const filter = encodeURIComponent(JSON.stringify({ and: [{ field: 'tier', op: 'eq', value: 'critical' }, { search: 'beacon' }] }))
    const hits = await json<{ entities: { key: string }[] }>(await session(`/v1/entities?blueprint=system&filter=${filter}&fields=tier`))
    expect(hits.entities.map((e) => e.key)).toEqual(['beacon'])
    const gt = encodeURIComponent(JSON.stringify({ and: [{ field: 'version', op: 'gt', value: 'v1' }, { field: 'version', op: 'lte', value: 'v2' }, { not: { field: 'version', op: 'lt', value: 'v1.31' } }] }))
    const sized = await json<{ entities: { key: string }[] }>(await session(`/v1/entities?blueprint=k8s_cluster&filter=${gt}`))
    expect(sized.entities.map((e) => e.key)).toEqual(['home'])
    const rel = encodeURIComponent(JSON.stringify({ relatedTo: 'system:beacon' }))
    const related = await json<{ entities: { key: string }[] }>(await session(`/v1/entities?filter=${rel}`))
    expect(related.entities.map((e) => e.key)).toContain('home/beacon')
    const yaml = await (await session('/v1/export?blueprint=system')).text()
    expect(yaml).toContain('key: beacon')
    expect(yaml).toContain('tier: critical')
  })
})

describe('agents', () => {
  it('serves the summary and MCP tools to an access token on the machine surface', async () => {
    const access = (await hub.sources.issueToken('access', 'agent', { role: 'viewer' })).token
    const summary = await json<{ blueprints: unknown[]; notGreen: unknown[] }>(await machine('/v1/summary', {}, access))
    expect(summary.blueprints.length).toBeGreaterThan(5)
    const rpc = (method: string, params: Record<string, unknown>, id = 1) =>
      machine('/mcp', { method: 'POST', headers: { accept: 'application/json, text/event-stream' }, ...body({ jsonrpc: '2.0', id, method, params }) }, access)
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } })
    expect(init.status).toBe(200)
    const tools = await parseRpc(await rpc('tools/list', {}, 2))
    // Every tool is one the call counter names, so its label stays a fixed set. The ground's and the map's tools are in a preview, open to nobody here.
    expect((tools.result as { tools: { name: string }[] }).tools.map((t) => t.name).sort()).toEqual(AGENT_TOOLS.filter((t) => t !== 'get_ground' && t !== 'get_map').sort())
    const call = await parseRpc(await rpc('tools/call', { name: 'get_entity', arguments: { id: 'system:beacon' } }, 3))
    const text = (call.result as { content: { text: string }[] }).content[0]!.text
    expect(JSON.parse(text).title).toBe('Beacon')
    // Writes are refused for a viewer.
    expect((await machine('/v1/entities', { method: 'POST', ...body({ blueprint: 'system', key: 'x' }) }, access)).status).toBe(403)
  })

  it('answers a thing many point at with how many, the first few, and the call that reads the rest', async () => {
    const pad = (i: number) => String(i).padStart(2, '0')
    const pods = Array.from({ length: 30 }, (_, i) => ({ blueprint: 'k8s_pod', key: `busy/ns/pod-${pad(i)}`, title: `pod-${pad(i)}`, fields: { phase: 'Running', health: 'green', ready: i < 10, restarts: i }, relations: { namespace: 'busy/ns' } }))
    await snapshot([{ blueprint: 'k8s_namespace', key: 'busy/ns', title: 'ns', fields: {} }, ...pods], 'busy')
    const access = (await hub.sources.issueToken('access', 'reading-agent', { role: 'viewer' })).token
    const call = async (name: string, args: Record<string, unknown>) => {
      const res = await parseRpc(await machine('/mcp', { method: 'POST', headers: { accept: 'application/json, text/event-stream' }, ...body({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }, access))
      const text = (res.result as { content: { text: string }[] }).content[0]!.text
      // Every answer goes into an agent's model: no spacing.
      expect(text).not.toContain('\n')
      return JSON.parse(text) as Record<string, unknown>
    }
    const ns = await call('get_entity', { id: 'k8s_namespace:busy/ns' })
    const group = (ns.incoming as LinkGroup[]).find((g) => g.blueprint === 'k8s_pod' && g.relation === 'namespace')!
    expect(group.count).toBe(30)
    expect(group.links.map((l) => l.title)).toEqual(Array.from({ length: SHOWN_LINKS }, (_, i) => `pod-${pad(i)}`))
    expect(group.more).toEqual({ tool: 'search_entities', args: { blueprint: 'k8s_pod', filter: { relation: 'namespace', target: 'k8s_namespace:busy/ns' }, sort: '-updatedAt' } })
    const rest = await call(group.more!.tool, { ...group.more!.args, limit: 100 })
    expect(rest.total).toBe(30)
    // A page is sorted as asked, holds the fields asked for, and shows each relation as a count with its first links.
    const page = await call('search_entities', { blueprint: 'k8s_pod', filter: { relation: 'namespace', target: 'k8s_namespace:busy/ns' }, sort: '-title', limit: 3, fields: ['phase'] })
    const cards = page.entities as Card[]
    expect(cards.map((c) => c.title)).toEqual(['pod-29', 'pod-28', 'pod-27'])
    expect(cards[0]!.fields).toEqual({ phase: 'Running' })
    expect(cards[0]!.relations.namespace).toEqual({ count: 1, ids: ['k8s_namespace:busy/ns'] })
    // A person's words, in any order, find things of every kind, and the answer says which kinds.
    // A search across every kind reads the stored rows: one blueprint's search derives what the push left, as the hub's next pass would.
    await call('search_entities', { q: 'busy', blueprint: 'k8s_namespace' })
    const found = await call('search_entities', { q: 'ns busy' })
    expect(found.kinds).toEqual({ k8s_namespace: 1, k8s_pod: 30 })
    const one = await call('search_entities', { q: 'pod-07 busy', fields: [] })
    expect((one.entities as Card[]).map((c) => c.id)).toEqual(['k8s_pod:busy/ns/pod-07'])
    // No read tool requires an input, so an agent's host never asks a person for an id or a blueprint: a call without one is told how to find it.
    const listed = await parseRpc(await machine('/mcp', { method: 'POST', headers: { accept: 'application/json, text/event-stream' }, ...body({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) }, access))
    const required = Object.fromEntries((listed.result as { tools: { name: string; inputSchema: { required?: string[] } }[] }).tools.map((t) => [t.name, t.inputSchema.required ?? []]))
    for (const tool of ['search_entities', 'run_query', 'get_entity', 'traverse', 'describe_model', 'estate_summary', 'get_status', 'list_findings']) expect(required[tool], tool).toEqual([])
    for (const tool of ['run_query', 'get_entity', 'traverse']) expect((await call(tool, {})).error, tool).toContain('search_entities with q')
    // A host that fills what it leaves blank with {} and [] asked for nothing there; a part that is no filter is named, never a crash.
    const blank = await call('run_query', { sources: [{ blueprint: 'k8s_pod', filter: { relation: 'namespace', target: 'k8s_namespace:busy/ns' } }, { blueprint: 'k8s_namespace', filter: {}, states: [] }], columns: ['title'], limit: 1, view: { sort: [{ column: 'title', desc: true }] } })
    expect(blank.counts).toMatchObject({ k8s_pod: 30 })
    // A condition that lost what it said on the way is refused: answering without it answers a wider question.
    expect((await call('run_query', { sources: [{ blueprint: 'k8s_pod', filter: { and: [{ relation: 'namespace', target: 'k8s_namespace:busy/ns' }, {}] } }] })).error).toContain('arrived empty')
    // A host may lose a condition whose value is not text, so an agent writes it as text, and the hub reads it as the field's type.
    expect((await call('search_entities', { blueprint: 'k8s_pod', q: 'busy', filter: { and: [{ field: 'ready', op: 'eq', value: 'true' }, { field: 'restarts', op: 'gte', value: '5' }] } })).total).toBe(5)
    expect((await call('search_entities', { blueprint: 'k8s_pod', q: 'busy', filter: {}, state: [] })).total).toBe(30)
    expect((await call('run_query', { sources: [{ blueprint: 'k8s_pod', filter: { fild: 'phase' } }] })).error).toContain('no leaf is named in {"fild":"phase"}')
    // People say a kind in the plural, and no thing holds that word: it names the kind.
    const named = await call('search_entities', { q: 'busy pods' })
    expect(named.kinds).toEqual({ k8s_pod: 30 })
    // A filter names who asks and their day, and the hub fills both in: the agent is never told either.
    const mine = await call('search_entities', { blueprint: 'k8s_pod', filter: { and: [{ field: '$owner', op: 'neq', value: '@me' }, { field: '$updatedAt', op: 'gte', value: '@today' }, { field: '$updatedAt', op: 'lt', value: '@tomorrow' }] }, limit: 1 })
    expect(mine.total).toBeGreaterThanOrEqual(30)
    expect((await call('search_entities', { blueprint: 'k8s_pod', filter: { field: '$updatedAt', op: 'lt', value: '@yesterday' } })).total).toBe(0)
    expect((await call('search_entities', { filter: { relatedTo: '@me' } })).error).toContain('the catalog holds none for you')
    // run_query's view says a day the same way, and a condition it cannot judge is refused, never passed over.
    const day = (op: string, value: string) => call('run_query', { sources: [{ blueprint: 'k8s_pod', filter: { relation: 'namespace', target: 'k8s_namespace:busy/ns' } }], columns: ['title', '$updatedAt'], limit: 1, view: { where: [{ field: '$updatedAt', op, value }] } })
    expect((await day('gte', '@today')).kept).toBe(30)
    expect((await day('lt', '@yesterday')).kept).toBe(0)
    expect((await day('gte', 'yesterday')).error).toContain('which is no time')
    expect((await call('run_query', { sources: [{ blueprint: 'k8s_pod' }], columns: ['title'], view: { where: [{ field: '$updatedAt', op: 'gte', value: '@today' }] } })).error).toContain('not a column of this answer')
    // An agent learns who it answers for and when their day began.
    const me = await call('who_am_i', {})
    expect(me).toMatchObject({ address: 'reading-agent', kind: 'token', timeZone: 'UTC' })
    expect(me.todayStartedAt).toBe(`${me.today as string}T00:00:00.000Z`)
    // A question that matched nothing says which condition matched nothing alone, and what that field holds.
    const none = await call('search_entities', { blueprint: 'k8s_pod', filter: { and: [{ relation: 'namespace', target: 'k8s_namespace:busy/ns' }, { field: 'phase', op: 'eq', value: 'Runing' }] } })
    expect(none.total).toBe(0)
    const guess = (none.conditions as { condition: unknown; alone: number; holds?: { value: string; count: number }[] }[])[1]!
    expect(guess.alone).toBe(0)
    expect(guess.holds!.map((h) => h.value)).toContain('Running')
    const asked = await call('run_query', { sources: [{ blueprint: 'k8s_pod', filter: { field: 'phase', op: 'eq', value: 'Runing' } }], columns: ['title'] })
    expect((asked.matchedNothing as { blueprint: string; conditions: { holds?: { value: string }[] }[] }[])[0]!.conditions[0]!.holds!.map((h) => h.value)).toContain('Running')
    // The entity's page is sent the first few of each kind that points at it, and how many there are.
    const shown = await json<EntityPageResponse>(await session('/v1/entities/k8s_namespace/busy%2Fns'))
    expect(shown.incoming.filter((e) => e.declaredOn === 'k8s_pod')).toHaveLength(ENTITY_LINKS)
    expect(shown.incomingCount?.['k8s_pod.namespace']).toBe(30)
  })

  it('lists the kinds of thing by name, and one kind in full when asked', async () => {
    const access = (await hub.sources.issueToken('access', 'model-agent', { role: 'viewer' })).token
    const call = async (args: Record<string, unknown>) => {
      const res = await parseRpc(await machine('/mcp', { method: 'POST', headers: { accept: 'application/json, text/event-stream' }, ...body({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'describe_model', arguments: args } }) }, access))
      return JSON.parse((res.result as { content: { text: string }[] }).content[0]!.text) as unknown
    }
    const kinds = (await call({})) as { id: string; fields?: unknown }[]
    expect(kinds.map((k) => k.id)).toContain('k8s_pod')
    expect(kinds.every((k) => k.fields === undefined)).toBe(true)
    const [pod] = (await call({ blueprint: 'k8s_pod' })) as { id: string; fields: Record<string, unknown> }[]
    expect(Object.keys(pod!.fields)).toContain('phase')
  })

  it('answers a tool call that takes longer than a second', async () => {
    const access = (await hub.sources.issueToken('access', 'slow-agent', { role: 'viewer' })).token
    const get = hub.reader.get.bind(hub.reader)
    const slow = vi.spyOn(hub.reader, 'get').mockImplementation(async (...args) => {
      await new Promise((resolve) => setTimeout(resolve, 1500))
      return get(...args)
    })
    try {
      const res = await machine('/mcp', { method: 'POST', headers: { accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' }, ...body({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_entity', arguments: { id: 'system:beacon' } } }) }, access)
      const call = await parseRpc(res)
      const text = (call.result as { content: { text: string }[] }).content[0]!.text
      expect(JSON.parse(text).title).toBe('Beacon')
    } finally {
      slow.mockRestore()
    }
  }, 10_000)

  it('offers no standalone stream and passes protocol errors through', async () => {
    const access = (await hub.sources.issueToken('access', 'stream-agent', { role: 'viewer' })).token
    const stream = await machine('/mcp', { method: 'GET', headers: { accept: 'text/event-stream' } }, access)
    expect(stream.status).toBe(405)
    const stale = await machine('/mcp', { method: 'POST', headers: { accept: 'application/json, text/event-stream', 'mcp-protocol-version': '1999-01-01' }, ...body({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) }, access)
    expect(stale.status).toBe(404)
    expect(await stale.text()).toContain('Unsupported protocol version')
  })
})

describe('the modelling guide', () => {
  it('is served as markdown and as an MCP tool', async () => {
    const access = (await hub.sources.issueToken('access', 'guide', { role: 'viewer' })).token
    const res = await machine('/v1/guide', {}, access)
    expect(res.headers.get('content-type')).toContain('text/markdown')
    expect(await res.text()).toContain('## What belongs in the catalog')
    const rpc = (method: string, params: Record<string, unknown>, id = 1) =>
      machine('/mcp', { method: 'POST', headers: { accept: 'application/json, text/event-stream' }, ...body({ jsonrpc: '2.0', id, method, params }) }, access)
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } })
    const call = await parseRpc(await rpc('tools/call', { name: 'modelling_guide', arguments: {} }, 2))
    expect((call.result as { content: { text: string }[] }).content[0]!.text).toContain('## Shared names')
  })
})

describe('run_query for an agent', () => {
  it('shapes the answer by its view: the rows its conditions keep, and the groups without their rows', async () => {
    const access = (await hub.sources.issueToken('access', 'query-agent', { role: 'viewer' })).token
    const rpc = (method: string, params: Record<string, unknown>, id = 1) =>
      machine('/mcp', { method: 'POST', headers: { accept: 'application/json, text/event-stream' }, ...body({ jsonrpc: '2.0', id, method, params }) }, access)
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } })
    const view = { where: [{ field: 'title', op: 'eq', value: 'Beacon' }], group: ['$type'], totals: { title: 'count' } }
    const call = await parseRpc(await rpc('tools/call', { name: 'run_query', arguments: { sources: [{ blueprint: 'system' }], columns: ['$type', 'title'], view } }, 2))
    const out = JSON.parse((call.result as { content: { text: string }[] }).content[0]!.text) as { kept: number; rows: { key: string }[]; groups: { value: string; count: number; totals: Record<string, number>; rows?: unknown }[]; totals: Record<string, number> }
    expect(out.kept).toBe(1)
    expect(out.rows.map((r) => r.key)).toEqual(['beacon'])
    expect(out.groups).toEqual([{ column: '$type', value: 'System', count: 1, totals: { title: 1 } }])
    expect(out.totals).toEqual({ title: 1 })
  })
})

describe('the spec an agent starts from', () => {
  it('names the host it was fetched from on the machine surface, and says where the token goes', async () => {
    const res = await hub.app.request('https://orrery-ingest.example.org/v1/openapi.json', { headers: { 'x-forwarded-proto': 'https' } }, { surface: 'machine' })
    expect(res.status).toBe(200)
    const spec = await json<{ servers: { url: string }[]; info: { description: string }; security: unknown[] }>(res)
    expect(spec.servers).toEqual([{ url: 'https://orrery-ingest.example.org' }])
    expect(spec.info.description).toContain('Authorization: Bearer')
    expect(spec.security).toEqual([{ bearerAuth: [] }])
  })

  it('names the browser URL on the session surface', async () => {
    const spec = await json<{ servers: { url: string }[] }>(await session('/v1/openapi.json'))
    expect(spec.servers).toEqual([{ url: 'http://localhost:8080' }])
  })

  it('sends a caller without a token, or landing on the root, to the spec', async () => {
    const refused = await hub.app.request('/v1/summary', {}, { surface: 'machine' })
    expect(refused.status).toBe(401)
    expect((await json<{ docs: string }>(refused)).docs).toBe('/v1/openapi.json')
    const root = await hub.app.request('/', {}, { surface: 'machine' })
    expect(root.status).toBe(302)
    expect(root.headers.get('location')).toBe('/v1/openapi.json')
    expect((await hub.app.request('/v1/openapi.json', {}, { surface: 'machine' })).status).toBe(200)
  })
})

describe('removing a source', () => {
  it('deletes its source entity on the next tick', async () => {
    await hub.sources.save('retired@lab', { title: 'retired', class: 'pusher', blueprints: ['k8s_cluster'], deleteGrant: [], cadence: '1h' })
    await hub.runs.syncSourceEntities('retired@lab')
    const state = async () => (await hub.db.query<{ state: string }>(`SELECT state FROM entities WHERE blueprint = 'orrery_source' AND key = 'retired@lab'`)).rows[0]?.state
    expect(await state()).toBe('active')

    expect((await session('/v1/sources/retired@lab', { method: 'DELETE' })).status).toBe(200)
    await hub.runs.tick(90, 30, 60)
    expect(await state()).toBe('deleted')
  })
})

describe('handing a source over', () => {
  it('gives another pusher the entities, fields, and relations, so its snapshots own them', async () => {
    const blueprints = ['k8s_cluster', 'k8s_namespace']
    await hub.sources.save('old@lab', { title: 'old', class: 'pusher', blueprints, deleteGrant: [], cadence: '1h' })
    await hub.sources.save('new@lab', { title: 'new', class: 'pusher', blueprints, deleteGrant: [], cadence: '1h' })
    await hub.sources.save('narrow@lab', { title: 'narrow', class: 'pusher', blueprints: ['k8s_cluster'], deleteGrant: [], cadence: '1h' })
    const oldToken = (await hub.sources.issueToken('source', 'old', { source: 'old@lab' })).token
    const newToken = (await hub.sources.issueToken('source', 'new', { source: 'new@lab' })).token
    await snapshot([
      { blueprint: 'k8s_cluster', key: 'handover', title: 'handover', fields: { version: '1.30' } },
      { blueprint: 'k8s_namespace', key: 'handover/a', title: 'a', fields: { name: 'a' }, relations: { cluster: 'handover' } },
    ], 'old', oldToken)

    expect((await session('/v1/sources/old@lab/hand-over', { method: 'POST', ...body({ to: 'narrow@lab' }) })).status).toBe(409)
    const handed = await session('/v1/sources/old@lab/hand-over', { method: 'POST', ...body({ to: 'new@lab', scope: 'new' }) })
    expect(await json(handed)).toEqual({ entities: 2, relations: 1 })
    const row = await hub.db.query<{ owner: string; scope: string; pushed: Record<string, { source: string }> }>(`SELECT owner, scope, pushed FROM entities WHERE blueprint = 'k8s_namespace' AND key = 'handover/a'`)
    expect(row.rows[0]).toMatchObject({ owner: 'new@lab', scope: 'new', pushed: { name: { source: 'new@lab' } } })
    expect((await session('/v1/sources/old@lab', { method: 'DELETE' })).status).toBe(200)

    // The receiver's snapshot in the new scope deletes what it no longer sees.
    await snapshot([{ blueprint: 'k8s_cluster', key: 'handover', title: 'handover', fields: { version: '1.30' } }], 'new', newToken)
    const after = await hub.db.query<{ state: string }>(`SELECT state FROM entities WHERE blueprint = 'k8s_namespace' AND key = 'handover/a'`)
    expect(after.rows[0]?.state).toBe('missing')
  })

  it('hands over only the blueprints named, and keeps the rest with the giver', async () => {
    const blueprints = ['k8s_cluster', 'k8s_namespace']
    await hub.sources.save('part@lab', { title: 'part', class: 'pusher', blueprints, deleteGrant: [], cadence: '1h' })
    await hub.sources.save('taker@lab', { title: 'taker', class: 'pusher', blueprints: ['k8s_namespace'], deleteGrant: [], cadence: '1h' })
    const token = (await hub.sources.issueToken('source', 'part', { source: 'part@lab' })).token
    await snapshot([
      { blueprint: 'k8s_cluster', key: 'partial', title: 'partial', fields: { version: '1.30' } },
      { blueprint: 'k8s_namespace', key: 'partial/a', title: 'a', fields: { name: 'a' }, relations: { cluster: 'partial' } },
    ], 'part', token)

    const handed = await session('/v1/sources/part@lab/hand-over', { method: 'POST', ...body({ to: 'taker@lab', scope: 'taken', blueprints: ['k8s_namespace'] }) })
    expect(await json(handed)).toEqual({ entities: 1, relations: 1 })
    const rows = await hub.db.query<{ blueprint: string; owner: string }>(`SELECT blueprint, owner FROM entities WHERE key IN ('partial', 'partial/a') ORDER BY blueprint`)
    expect(rows.rows).toEqual([{ blueprint: 'k8s_cluster', owner: 'part@lab' }, { blueprint: 'k8s_namespace', owner: 'taker@lab' }])
  })
})

describe('a pusher taking over what people made', () => {
  it('owns the named entities from then on, and keeps what people set on them', async () => {
    expect((await session('/v1/blueprints/gizmo', { method: 'PUT', ...body({ title: 'Gizmo', fields: { version: { type: 'string' } }, relations: {} }) })).status).toBe(200)
    await hub.sources.save('adopter@lab', { title: 'adopter', class: 'pusher', blueprints: ['gizmo'], deleteGrant: [], cadence: '1h' })
    expect((await session('/v1/entities', { method: 'POST', ...body({ blueprint: 'gizmo', key: 'typed', title: 'typed', fields: { version: '1.29' } }) })).status).toBe(201)
    expect((await session('/v1/sources/adopter@lab/adopt', { method: 'POST', ...body({ entities: [{ blueprint: 'k8s_namespace', key: 'x' }] }) })).status).toBe(409)
    expect((await session('/v1/sources/adopter@lab/adopt', { method: 'POST', ...body({ entities: [{ blueprint: 'gizmo', key: 'nowhere' }] }) })).status).toBe(404)
    const adopted = await session('/v1/sources/adopter@lab/adopt', { method: 'POST', ...body({ entities: [{ blueprint: 'gizmo', key: 'typed' }], scope: 'lab' }) })
    expect(await json(adopted)).toEqual({ entities: 1 })
    const row = await hub.db.query<{ owner: string; scope: string; ui: Record<string, { value: unknown }> }>(`SELECT owner, scope, ui FROM entities WHERE blueprint = 'gizmo' AND key = 'typed'`)
    expect(row.rows[0]).toMatchObject({ owner: 'adopter@lab', scope: 'lab', ui: { version: { value: '1.29' } } })
    // Owned by a source now, it is not the web app's to give again.
    expect((await session('/v1/sources/adopter@lab/adopt', { method: 'POST', ...body({ entities: [{ blueprint: 'gizmo', key: 'typed' }] }) })).status).toBe(409)
  })
})

describe('bad requests and failed runs', () => {
  it('answers a body that fails validation with 400, not 500', async () => {
    const res = await session('/v1/sources/k8s@home/hand-over', { method: 'POST', ...body({}) })
    expect(res.status).toBe(400)
    expect((await json<{ error: string }>(res)).error).toContain('to')
  })

  it('answers a repeated commit with the committed run, for a writer that timed out waiting for the first', async () => {
    const run = await json<{ id: string }>(await machine('/v1/ingest/runs', { method: 'POST', ...body({ mode: 'snapshot', scope: 'retry' }) }))
    expect((await machine(`/v1/ingest/runs/${run.id}/entities`, { method: 'PUT', ...body({ entities: [{ blueprint: 'k8s_cluster', key: 'retry-a', title: 'a' }] }) })).status).toBe(200)
    const first = await machine(`/v1/ingest/runs/${run.id}/commit`, { method: 'POST' })
    expect(first.status).toBe(200)
    const again = await machine(`/v1/ingest/runs/${run.id}/commit`, { method: 'POST' })
    expect(again.status).toBe(200)
    expect(await json(again)).toEqual(await json(first))
  })

  it('abandons an open snapshot when a newer one of the same scope opens, so neither marks the other missing', async () => {
    const scope = 'overlap'
    await snapshot([{ blueprint: 'k8s_cluster', key: 'overlap-a', title: 'a' }, { blueprint: 'k8s_cluster', key: 'overlap-b', title: 'b' }], scope)
    const first = await json<{ id: string }>(await machine('/v1/ingest/runs', { method: 'POST', ...body({ mode: 'snapshot', scope }) }))
    const second = await json<{ id: string }>(await machine('/v1/ingest/runs', { method: 'POST', ...body({ mode: 'snapshot', scope }) }))
    expect((await json<{ state: string }>(await machine(`/v1/ingest/runs/${first.id}`))).state).toBe('abandoned')
    // The older run can neither write nor commit: it is over.
    expect((await machine(`/v1/ingest/runs/${first.id}/entities`, { method: 'PUT', ...body({ entities: [{ blueprint: 'k8s_cluster', key: 'overlap-a', title: 'a' }] }) })).status).toBe(409)
    expect((await machine(`/v1/ingest/runs/${first.id}/commit`, { method: 'POST' })).status).toBe(409)
    // The newer one commits as the only snapshot of the scope.
    expect((await machine(`/v1/ingest/runs/${second.id}/entities`, { method: 'PUT', ...body({ entities: [{ blueprint: 'k8s_cluster', key: 'overlap-a', title: 'a' }, { blueprint: 'k8s_cluster', key: 'overlap-b', title: 'b' }] }) })).status).toBe(200)
    const committed = await json<{ counts: { missing: number } }>(await machine(`/v1/ingest/runs/${second.id}/commit`, { method: 'POST' }))
    expect(committed.counts.missing).toBe(0)
    const a = await json<{ state: string }>(await session('/v1/entities/k8s_cluster/overlap-a'))
    expect(a.state).toBe('active')
    // An incremental run beside a snapshot is left alone.
    const inc = await json<{ id: string }>(await machine('/v1/ingest/runs', { method: 'POST', ...body({ mode: 'incremental', scope }) }))
    const third = await json<{ id: string }>(await machine('/v1/ingest/runs', { method: 'POST', ...body({ mode: 'snapshot', scope }) }))
    expect((await json<{ state: string }>(await machine(`/v1/ingest/runs/${inc.id}`))).state).toBe('open')
    expect((await machine(`/v1/ingest/runs/${third.id}/fail`, { method: 'POST', ...body({ reason: 'done' }) })).status).toBe(200)
    expect((await machine(`/v1/ingest/runs/${inc.id}/fail`, { method: 'POST', ...body({ reason: 'done' }) })).status).toBe(200)
  })

  it('keeps an entity a snapshot wrote when a single patch lands before the commit', async () => {
    const scope = 'patched-mid-run'
    const run = await json<{ id: string }>(await machine('/v1/ingest/runs', { method: 'POST', ...body({ mode: 'snapshot', scope }) }))
    expect((await machine(`/v1/ingest/runs/${run.id}/entities`, { method: 'PUT', ...body({ entities: [{ blueprint: 'k8s_cluster', key: 'patched-a', title: 'a' }] }) })).status).toBe(200)
    expect((await machine('/v1/ingest/entities/k8s_cluster/patched-a', { method: 'PATCH', ...body({ title: 'a', fields: { version: '1.30' }, scope }) })).status).toBe(200)
    const committed = await json<{ counts: { missing: number } }>(await machine(`/v1/ingest/runs/${run.id}/commit`, { method: 'POST' }))
    expect(committed.counts.missing).toBe(0)
    expect((await json<{ state: string }>(await session('/v1/entities/k8s_cluster/patched-a'))).state).toBe('active')
  })

  it('does not report a run that failed as writes the blueprint refused', async () => {
    const run = await json<{ id: string }>(await machine('/v1/ingest/runs', { method: 'POST', ...body({ mode: 'snapshot', scope: 'failing' }) }))
    expect((await machine(`/v1/ingest/runs/${run.id}/fail`, { method: 'POST', ...body({ reason: 'connection refused' }) })).status).toBe(200)
    const findings = await json<{ findings: { kind: string; run?: string }[] }>(await session('/v1/findings'))
    expect(findings.findings.filter((f) => f.kind === 'schema_mismatch' && f.run === run.id)).toEqual([])
  })

  it('stops reporting refused writes once the next run of the same scope is clean', async () => {
    const refusedIn = async (scope: string) => {
      const { findings } = await json<{ findings: { kind: string; run?: string }[] }>(await session('/v1/findings'))
      const runs = await json<{ runs: { id: string; scope: string }[] }>(await session('/v1/runs?source=k8s%40home'))
      const ids = new Set(runs.runs.filter((r) => r.scope === scope).map((r) => r.id))
      return findings.filter((f) => f.kind === 'schema_mismatch' && f.run && ids.has(f.run)).length
    }
    const bad = await snapshot([{ blueprint: 'k8s_cluster', key: 'refusing', title: 'r', fields: { no_such_field: 1 } }], 'refusing')
    expect(bad.counts).toMatchObject({ rejected: 1 })
    expect(await refusedIn('refusing')).toBe(1)
    await snapshot([{ blueprint: 'k8s_cluster', key: 'refusing', title: 'r' }], 'refusing')
    expect(await refusedIn('refusing')).toBe(0)
  })
})

describe('doing only the work a push calls for', () => {
  const pod = (fields: Record<string, unknown> = {}) => ({ blueprint: 'k8s_pod', key: 'home/beacon/gateway-abc', title: 'gateway-abc', fields })
  const stored = async () => (await json<{ updatedAt: string; lastSeenAt: string; state: string; fields: Record<string, unknown> }>(await session('/v1/entities/k8s_pod/home%2Fbeacon%2Fgateway-abc')))

  it('takes one entity named twice in a batch, the second write over the first', async () => {
    const run = await snapshot([pod({ phase: 'Pending' }), pod({ phase: 'Running' })], 'quiet-pods')
    expect(run.counts).toMatchObject({ received: 2, created: 1, updated: 1 })
    expect((await stored()).fields.phase).toBe('Running')
  })

  it('marks an unchanged entity as seen without recording anything, so the next snapshot keeps it', async () => {
    const before = await stored()
    const changes = async () => (await json<{ changes: unknown[] }>(await session('/v1/changes?blueprint=k8s_pod&key=home%2Fbeacon%2Fgateway-abc'))).changes.length
    const recorded = await changes()
    const run = await snapshot([pod({ phase: 'Running' })], 'quiet-pods')
    expect(run.counts).toMatchObject({ unchanged: 1, updated: 0, missing: 0 })
    const after = await stored()
    expect(after.state).toBe('active')
    expect(after.updatedAt).toBe(before.updatedAt)
    expect(Date.parse(after.lastSeenAt)).toBeGreaterThan(Date.parse(before.lastSeenAt))
    expect(await changes()).toBe(recorded)
  })

  it('remembers when an unchanged value was last observed, and refuses an older one after it', async () => {
    const push = async (phase: string, observedAt: string) => {
      const run = await json<{ id: string }>(await machine('/v1/ingest/runs', { method: 'POST', ...body({ mode: 'incremental', scope: 'quiet-pods' }) }))
      await machine(`/v1/ingest/runs/${run.id}/entities`, { method: 'PUT', ...body({ entities: [pod({ phase })], observedAt }) })
      await machine(`/v1/ingest/runs/${run.id}/commit`, { method: 'POST' })
    }
    await push('Running', '2026-09-30T10:00:00Z')
    await push('Running', '2026-09-30T12:00:00Z')
    await push('Failed', '2026-09-30T11:00:00Z')
    expect((await stored()).fields.phase).toBe('Running')
  })

  it('re-links only the rules that read what a push moved', async () => {
    await hub.rules.evaluateAll()
    const evaluate = vi.spyOn(hub.rules, 'evaluate')
    const ran = () => evaluate.mock.calls.map(([rule]) => rule.id)
    await snapshot([pod({ phase: 'Running' })], 'quiet-pods')
    await hub.rules.settled()
    expect(ran()).toEqual([])
    // No rule reads a pod.
    await snapshot([pod({ phase: 'Succeeded' })], 'quiet-pods')
    await hub.rules.settled()
    expect(ran()).toEqual([])
    await snapshot([{ blueprint: 'k8s_namespace', key: 'home/quiet', title: 'quiet', fields: { name: 'quiet' }, relations: { cluster: 'home' } }], 'quiet')
    await hub.rules.settled()
    expect(ran()).toEqual(['k8s_namespace.system'])
    evaluate.mockRestore()
  })

  it('keeps what a rule matched on only from what it read: a side that moves while a pass runs is read again', async () => {
    const ns = (name: string) => snapshot([{ blueprint: 'k8s_namespace', key: 'home/racens', title: 'racens', fields: { name }, relations: { cluster: 'home' } }], 'race-ns')
    const app = () => snapshot([{ blueprint: 'k8s_workload', key: 'home/racens/app', title: 'app', fields: { name: 'app', kind: 'Deployment', labels: { 'app.kubernetes.io/part-of': 'racesys' } }, relations: { namespace: 'home/racens' } }], 'race-app')
    const system = async () => (await json<EntityPageResponse>(await session('/v1/entities/k8s_workload/home%2Fracens%2Fapp'))).relations?.system?.map((r) => r.key) ?? []
    const pass = async () => {
      for (let i = 0; i < 3; i++) {
        await hub.rules.evaluateMoved()
        await hub.rules.settled()
      }
    }
    await ns('first')
    await app()
    await pass()
    expect(await system()).toEqual([])
    // Both rules match on the system's key. The first one read the systems; then a system arrives, before the second is judged.
    const original = hub.rules.evaluate.bind(hub.rules)
    let arrived = false
    const evaluate = vi.spyOn(hub.rules, 'evaluate').mockImplementation(async (rule) => {
      const out = await original(rule)
      if (rule.id === 'k8s_namespace.system' && !arrived) {
        arrived = true
        const made = await session('/v1/entities', { method: 'POST', ...body({ blueprint: 'system', key: 'racesys', title: 'Race' }) })
        expect(made.status).toBe(201)
      }
      return out
    })
    await ns('second')
    hub.rules.touch(['system'])
    await pass()
    expect(arrived).toBe(true)
    evaluate.mockRestore()
    await pass()
    expect(await system()).toEqual(['racesys'])
  })

  it('evaluates a rule again only when what it matches on moved', async () => {
    const quiet = (fields: Record<string, unknown>) => snapshot([{ blueprint: 'k8s_namespace', key: 'home/quiet', title: 'quiet', fields: { name: 'quiet', ...fields }, relations: { cluster: 'home' } }], 'quiet')
    const system = async () => (await json<EntityPageResponse>(await session('/v1/entities/k8s_namespace/home%2Fquiet'))).relations?.system?.map((r) => r.key) ?? []
    await quiet({ labels: { tier: 'one' } })
    await hub.rules.settled()
    const evaluate = vi.spyOn(hub.rules, 'evaluate')
    const ran = () => evaluate.mock.calls.splice(0).map(([rule]) => rule.id)
    // The first pass after a rule was evaluated keeps what its sides held; from then on a value it does not match on moves nothing.
    await quiet({ labels: { tier: 'two' } })
    await hub.rules.settled()
    ran()
    await quiet({ labels: { tier: 'three' } })
    await hub.rules.settled()
    expect(ran()).toEqual([])
    expect(await system()).toEqual([])
    // What it matches on moves: it is evaluated, and links.
    await quiet({ labels: { tier: 'three' }, name: 'beacon' })
    await hub.rules.settled()
    expect(ran()).toContain('k8s_namespace.system')
    expect(await system()).toEqual(['beacon'])
    // And when it moves back, the link goes.
    await quiet({ labels: { tier: 'three' } })
    await hub.rules.settled()
    expect(ran()).toContain('k8s_namespace.system')
    expect(await system()).toEqual([])
    evaluate.mockRestore()
  })

  it('re-links on the lifecycle tick only what moved, and everything once the slow clock comes round', async () => {
    await hub.rules.evaluateAll()
    // The tick writes the sources as entities; a first one leaves nothing more to move.
    await hub.runs.tick(90, 30, 60)
    await hub.rules.settled()
    const evaluate = vi.spyOn(hub.rules, 'evaluate')
    await hub.runs.tick(90, 30, 60)
    await hub.rules.settled()
    expect(evaluate.mock.calls).toEqual([])
    await hub.runs.tick(90, 30, 1 / 60_000)
    await hub.rules.settled()
    expect(evaluate.mock.calls.map(([rule]) => rule.id).sort()).toEqual(hub.rules.list().map((rule) => rule.id).sort())
    expect(hub.rules.list().length).toBeGreaterThan(0)
    evaluate.mockRestore()
  })

  it('stores that a source and its token were used at most once a minute', async () => {
    const row = async () => (await hub.db.query<{ last_seen_at: Date; last_used_at: Date }>(`SELECT s.last_seen_at, t.last_used_at FROM sources s JOIN tokens t ON t.source = s.id WHERE s.id = 'k8s@home'`)).rows[0]!
    expect((await machine('/v1/ingest/heartbeat', { method: 'POST', ...body({}) })).status).toBe(200)
    const first = await row()
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect((await machine('/v1/ingest/heartbeat', { method: 'POST', ...body({}) })).status).toBe(200)
    expect(await row()).toEqual(first)
    // What the hub answers with is not held back.
    expect(Date.parse(hub.sources.get('k8s@home')!.lastSeenAt!)).toBeGreaterThan(first.last_seen_at.getTime())
  })
})

describe('relation rules', () => {
  it('links nothing where a rule on a single relation finds several targets, and links once only one is left', async () => {
    const repo = (key: string, url: string) => ({ blueprint: 'repository', key, title: key, fields: { url } })
    const app = (key: string, repo_url: string) => ({ blueprint: 'argocd_app', key, title: key, fields: { repo_url } })
    await snapshot([repo('twin-a', 'https://forge/twin'), repo('twin-b', 'https://forge/twin'), repo('single', 'https://forge/single')], 'rule-repos', enrichToken)
    await snapshot([app('deploys-twin', 'https://forge/twin'), app('deploys-single', 'https://forge/single')], 'rule-apps', enrichToken)
    await hub.rules.evaluateAll()
    const linked = async (key: string) => (await json<{ relations: Record<string, { key: string }[]> }>(await session(`/v1/entities/argocd_app/${key}`))).relations.repository?.map((r) => r.key) ?? []
    expect(await linked('deploys-single')).toEqual(['single'])
    expect(await linked('deploys-twin')).toEqual([])
    await snapshot([repo('twin-a', 'https://forge/twin'), repo('twin-b', 'https://forge/moved'), repo('single', 'https://forge/single')], 'rule-repos', enrichToken)
    await hub.rules.evaluateAll()
    expect(await linked('deploys-twin')).toEqual(['twin-a'])
  })

  it('takes the one target still seen when the others matching are missing', async () => {
    const repo = (key: string, url: string) => ({ blueprint: 'repository', key, title: key, fields: { url } })
    await snapshot([repo('moved-old', 'https://forge/moved-twin'), repo('moved-new', 'https://forge/moved-twin')], 'moved-repos', enrichToken)
    await snapshot([{ blueprint: 'argocd_app', key: 'deploys-moved', title: 'deploys-moved', fields: { repo_url: 'https://forge/moved-twin' } }], 'moved-apps', enrichToken)
    await hub.rules.evaluateAll()
    const linked = async () => (await json<{ relations: Record<string, { key: string }[]> }>(await session('/v1/entities/argocd_app/deploys-moved'))).relations.repository?.map((r) => r.key) ?? []
    expect(await linked()).toEqual([])
    // The source stops seeing one: it is missing until its grace runs out, and the one it still sees is linked.
    await snapshot([repo('moved-new', 'https://forge/moved-twin')], 'moved-repos', enrichToken)
    expect((await json<{ state: string }>(await session('/v1/entities/repository/moved-old'))).state).toBe('missing')
    await hub.rules.evaluateAll()
    expect(await linked()).toEqual(['moved-new'])
  })

  it('reads a list on the source side in order of preference for a relation that holds one target', async () => {
    const ns = (name: string) => ({ blueprint: 'k8s_namespace', key: `prefer/${name}`, title: name, fields: { name } })
    const ingress = (key: string, hosts: string[]) => ({ blueprint: 'k8s_ingress', key, title: key, fields: { hosts } })
    await snapshot([ns('prefer-specific'), ns('prefer-general')], 'prefer-namespaces', enrichToken)
    await snapshot([ingress('specific-first', ['prefer-specific', 'prefer-general']), ingress('general-first', ['prefer-general', 'prefer-specific'])], 'prefer-ingresses', enrichToken)
    const put = await session('/v1/rules/test.prefer', { method: 'PUT', ...body({ blueprint: 'k8s_ingress', relation: 'namespace', optional: true, match: { target: 'k8s_namespace', where: 'target.name == source.hosts' } }) })
    expect(put.status).toBe(200)
    const linked = async (key: string) => (await json<{ relations: Record<string, { key: string }[]> }>(await session(`/v1/entities/k8s_ingress/${key}`))).relations.namespace?.map((r) => r.key) ?? []
    expect(await linked('specific-first')).toEqual(['prefer/prefer-specific'])
    expect(await linked('general-first')).toEqual(['prefer/prefer-general'])
    expect((await session('/v1/rules/test.prefer', { method: 'DELETE' })).status).toBe(200)
  })
})

describe('removing a git source', () => {
  it('hands what it defined to the web app, where it becomes editable', async () => {
    expect(hub.blueprints.get('system')?.origin.kind).toBe('git')
    const removed = await session('/v1/sources/catalog', { method: 'DELETE' })
    expect(removed.status).toBe(200)
    expect((await json<{ handed: number }>(removed)).handed).toBeGreaterThan(5)
    expect(hub.blueprints.get('system')?.origin).toEqual({ kind: 'ui' })
    expect(hub.rules.list().find((r) => r.id === 'k8s_namespace.system')?.origin).toEqual({ kind: 'ui' })
    expect(hub.scorecards.get('system_readiness')?.origin).toEqual({ kind: 'ui' })
    expect((await session('/v1/blueprints/system', { method: 'PUT', ...body({ ...hub.blueprints.get('system'), title: 'Product' }) })).status).toBe(200)
    // What was typed and pushed on its entities is untouched.
    expect((await json<{ title: string }>(await session('/v1/entities/system/beacon'))).title).toBe('Beacon')
  })
})

// Last, so the entities it pushes reach no other test's counts.
describe('relation ends', () => {
  it('names the icon each end of a relation draws, its own before its blueprint\'s', async () => {
    await snapshot([{ blueprint: 'k8s_cluster', key: 'iconic', title: 'iconic', icon: 'kubernetes', fields: { version: 'v1.31.0' } }], 'iconic-cluster')
    await snapshot([{ blueprint: 'k8s_namespace', key: 'iconic/plain', title: 'plain', fields: { name: 'plain' }, relations: { cluster: 'iconic' } }], 'iconic-namespace')
    for (let i = 0; i < 6; i++) await hub.deriver.drain()
    const namespaceIcon = (await json<{ blueprints: { id: string; icon?: string }[] }>(await session('/v1/blueprints'))).blueprints.find((b) => b.id === 'k8s_namespace')?.icon
    const ns = await json<{ outgoing: { relation: string; targetIcon: string | null }[] }>(await session('/v1/entities/k8s_namespace/iconic%2Fplain'))
    expect(ns.outgoing).toEqual([expect.objectContaining({ relation: 'cluster', targetIcon: 'kubernetes' })])
    const cluster = await json<{ incoming: { targetIcon: string | null }[] }>(await session('/v1/entities/k8s_cluster/iconic'))
    expect(cluster.incoming).toEqual([expect.objectContaining({ targetIcon: namespaceIcon ?? null })])
  })
})

async function parseRpc(res: Response): Promise<{ result: unknown }> {
  const text = await res.text()
  const line = text.split('\n').find((l) => l.startsWith('data:'))
  return JSON.parse(line ? line.slice(5) : text) as { result: unknown }
}
