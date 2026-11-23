import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { LoadResponse } from '../shared/api.ts'
import { loadConfig } from './config.ts'
import { loadFixtureCatalog } from './fixtures/load.ts'
import { createHub, type Hub } from './hub.ts'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://orrery:orrery@localhost:5433/orrery'
const config = () => loadConfig({ DATABASE_URL, DATA_DIR: mkdtempSync(join(tmpdir(), 'orrery-')), AUTH_MODE: 'proxy' })

// Two hubs on one database, as one that serves and one that derives.
let hub: Hub
let other: Hub
let token = ''

const ADMIN = 'ops@example.org'
const as = (on: Hub, email: string, groups: string, path: string) => Promise.resolve(on.app.request(path, { headers: { 'x-forwarded-email': email, 'x-forwarded-groups': groups } }, { surface: 'session' }))
const admin = (path: string) => as(hub, ADMIN, 'Admin', path)
const machine = (path: string, init?: RequestInit) => Promise.resolve(hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...init?.headers } }, { surface: 'machine' }))
const body = (v: unknown) => ({ body: JSON.stringify(v) })
const load = async (): Promise<LoadResponse> => (await (await admin('/v1/load?hours=1')).json()) as LoadResponse

async function snapshot(entities: unknown[]): Promise<void> {
  const run = (await (await machine('/v1/ingest/runs', { method: 'POST', ...body({ mode: 'snapshot', scope: 'home' }) })).json()) as { id: string }
  expect([200, 207]).toContain((await machine(`/v1/ingest/runs/${run.id}/entities`, { method: 'PUT', ...body({ entities }) })).status)
  expect((await machine(`/v1/ingest/runs/${run.id}/commit`, { method: 'POST' })).status).toBe(200)
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6 && (await hub.deriver.depth()); i++) await hub.deriver.drain()
  expect(await hub.deriver.depth()).toBe(0)
}

const estate = (version: string) => [
  { blueprint: 'k8s_cluster', key: 'home', title: 'home', fields: { version } },
  { blueprint: 'system', key: 'shop', title: 'Shop' },
  { blueprint: 'k8s_namespace', key: 'home/shop', title: 'shop', relations: { cluster: 'home' } },
  { blueprint: 'k8s_workload', key: 'home/shop/web', title: 'web', fields: { kind: 'Deployment', health: version === 'v1.31.0' ? 'green' : 'red' }, relations: { namespace: 'home/shop', system: 'shop' } },
  { blueprint: 'k8s_node', key: 'home/n1', title: 'n1', fields: { cpu: 8, memory_gb: 32, ready: true, health: 'green' }, relations: { cluster: 'home' } },
  { blueprint: 'k8s_node', key: 'home/n2', title: 'n2', fields: { cpu: 8, memory_gb: 32, ready: true, health: 'green' }, relations: { cluster: 'home' } },
]

beforeAll(async () => {
  hub = await createHub(config(), 'test', { reset: true })
  expect((await loadFixtureCatalog(hub)).errors).toEqual([])
  await hub.sources.save('k8s@home', { title: 'k8s home', class: 'pusher', blueprints: ['*'], deleteGrant: [], cadence: '3m' })
  token = (await hub.sources.issueToken('source', 'home pusher', { source: 'k8s@home' })).token
  await hub.deriver.backfill()
  other = await createHub(config(), 'test')
})

afterAll(async () => {
  await other.close()
  await hub.close()
})

describe('the load ledger', () => {
  it('counts a snapshot under its source: what it sent, and what of it changed', async () => {
    await snapshot(estate('v1.31.0'))
    await settle()
    await snapshot(estate('v1.32.0'))
    const mine = (await load()).writing.find((w) => w.source === 'k8s@home')
    expect(mine).toMatchObject({ source: 'k8s@home', batches: 2, received: 12, changed: 8 })
    expect(mine!.ms).toBeGreaterThanOrEqual(0)
  })

  it('counts a derive under its blueprint, with the readers a changed row sent back', async () => {
    await settle()
    const { deriving, queue, blueprints } = await load()
    const cluster = deriving.find((d) => d.blueprint === 'k8s_cluster')!
    // The cluster was derived for each push; the second changed its stored row. Its nodes show only its title, so none follows.
    expect(cluster.derived).toBeGreaterThanOrEqual(2)
    expect(cluster.changed).toBe(1)
    expect(cluster.cascaded).toBe(0)
    // The workload's status changed, and the system rolls it up.
    const workload = deriving.find((d) => d.blueprint === 'k8s_workload')!
    expect(workload.changed).toBe(1)
    expect(workload.cascaded).toBe(1)
    const node = deriving.find((d) => d.blueprint === 'k8s_node')!
    // Each node was derived once, when it was new.
    expect(node.derived).toBe(2)
    expect(node.cascaded).toBe(0)
    expect(queue).toEqual({ depth: 0, oldestSeconds: null })
    expect(blueprints.find((b) => b.id === 'k8s_node')).toMatchObject({ entities: 2 })
    expect(blueprints.find((b) => b.id === 'k8s_node')!.reads).toBeGreaterThanOrEqual(1)
  })

  it('counts a grid shape under its blueprint, once however often it is asked', async () => {
    expect((await admin('/v1/entities?blueprint=k8s_node&distribution=true')).status).toBe(200)
    expect((await admin('/v1/entities?blueprint=k8s_node&distribution=true')).status).toBe(200)
    const grid = (await load()).grids.find((g) => g.blueprint === 'k8s_node')!
    expect(grid).toMatchObject({ builds: 1, rows: 2 })
    // The spread of values is timed on its own, as a part of the build: the hub's own columns and the cluster relation.
    expect(grid.spreadColumns).toBeGreaterThanOrEqual(4)
    expect(grid.spreadMs).toBeGreaterThan(0)
    expect(grid.spreadMs).toBeLessThanOrEqual(grid.ms)
  })

  it('measures how each field that may be a chip spreads, again only once the measure is old, and says whether it is a chip', async () => {
    await hub.cardinality.measure()
    const version = () => load().then((l) => l.columns.find((c) => c.blueprint === 'k8s_cluster' && c.field === 'version'))
    expect(await version()).toMatchObject({ chip: false, rows: 1, values: 1, different: 1, top: 1 })
    // Every field a grid may count: an enum and a list too, each value of a list counted; never a number.
    const columns = (await load()).columns
    expect(columns.find((c) => c.blueprint === 'k8s_workload' && c.field === 'kind')).toMatchObject({ spread: true, values: 1, different: 1 })
    expect(columns.find((c) => c.blueprint === 'k8s_node' && c.field === 'cpu')).toBeUndefined()
    // A person field may be a chip, so it is measured too.
    expect((await load()).columns.find((c) => c.blueprint === 'system' && c.field === 'owner')).toMatchObject({ chip: false })
    const measured = (await version())!.measuredAt
    const withImages = estate('v1.32.0').map((e) => (e.blueprint === 'k8s_workload' ? { ...e, fields: { ...e.fields, images: ['web:1', 'sidecar:1'] } } : e))
    await snapshot([...withImages, { blueprint: 'k8s_cluster', key: 'away', title: 'away', fields: { version: 'v1.32.0' } }])
    await settle()
    await hub.cardinality.measure()
    expect((await version())!.measuredAt).toBe(measured)
    await hub.cardinality.measure(0)
    expect(await version()).toMatchObject({ rows: 2, values: 2, different: 1, top: 2 })
    // A list counts each of its values, as the spread does.
    expect((await load()).columns.find((c) => c.blueprint === 'k8s_workload' && c.field === 'images')).toMatchObject({ rows: 1, values: 2, different: 2 })
    // Every other hub reads the same measure.
    const seen = ((await (await as(other, ADMIN, 'Admin', '/v1/load?hours=1')).json()) as LoadResponse).columns
    expect(seen.find((c) => c.blueprint === 'k8s_cluster' && c.field === 'version')).toMatchObject({ rows: 2 })
  })

  it('counts a call under its caller, with the bytes answered, and never a stream or a push', async () => {
    const before = (await load()).reading.find((r) => r.caller === ADMIN)!
    const answer = await (await admin('/v1/blueprints')).text()
    const after = (await load()).reading
    const mine = after.find((r) => r.caller === ADMIN)!
    // The call, and the reading of the ledger before it.
    expect(mine.calls).toBe(before.calls + 2)
    expect(mine.bytes).toBeGreaterThanOrEqual(before.bytes + answer.length)
    expect(after.find((r) => r.caller === 'home pusher' || r.caller === 'k8s@home')).toBeUndefined()
    expect((await Promise.resolve(hub.app.request('/v1/blueprints', {}, { surface: 'machine' }))).status).toBe(401)
    expect((await load()).reading.find((r) => r.caller === 'anonymous')).toMatchObject({ calls: 1 })
  })

  it('splits a caller’s calls by the route each took, named as the hub names its routes', async () => {
    const route = (r: LoadResponse, name: string) => r.routes.find((x) => x.caller === ADMIN && x.route === name)
    const before = await load()
    const answer = await (await admin('/v1/entities/widget/nothing-here')).text()
    await admin('/v1/blueprints')
    const after = await load()
    expect(route(after, 'GET /v1/entities/:blueprint/:key')!.calls).toBe((route(before, 'GET /v1/entities/:blueprint/:key')?.calls ?? 0) + 1)
    expect(route(after, 'GET /v1/entities/:blueprint/:key')!.bytes).toBeGreaterThanOrEqual((route(before, 'GET /v1/entities/:blueprint/:key')?.bytes ?? 0) + answer.length)
    expect(route(after, 'GET /v1/blueprints')!.calls).toBe((route(before, 'GET /v1/blueprints')?.calls ?? 0) + 1)
    // Every call a caller made is in one route of theirs.
    const calls = after.routes.filter((r) => r.caller === ADMIN).reduce((n, r) => n + r.calls, 0)
    expect(calls).toBe(after.reading.find((r) => r.caller === ADMIN)!.calls)
  })

  it('counts every statement under the work that asked for it: a request by its route, a task by its name', async () => {
    const work = (r: LoadResponse, name: string) => r.database!.find((x) => x.work === name)
    const before = await load()
    await admin('/v1/entities/widget/nothing-here')
    await snapshot(estate('v1.33.0'))
    await settle()
    const after = await load()
    const route = work(after, 'GET /v1/entities/:blueprint/:key')!
    expect(route.statements).toBeGreaterThan(work(before, 'GET /v1/entities/:blueprint/:key')?.statements ?? 0)
    // A task inside a request takes its own statements: deriving is never counted under the push that queued it.
    const derive = work(after, 'derive.drain')!
    expect(derive.statements).toBeGreaterThan(work(before, 'derive.drain')?.statements ?? 0)
    expect(derive.rows).toBeGreaterThan(work(before, 'derive.drain')?.rows ?? 0)
    expect(derive.ms).toBeGreaterThan(0)
    // The statements of a route never named are nobody's: no name is made up from an address.
    expect(after.database!.some((x) => x.work.includes('nothing-here'))).toBe(false)
    // A statement no work asked for is told apart by what it does.
    await hub.db.query('SELECT value FROM settings WHERE key = $1', ['nothing-here'])
    const nobodys = (r: LoadResponse) => work(r, 'other select settings')?.statements ?? 0
    expect(nobodys(await load())).toBeGreaterThan(nobodys(after))
  })

  it('counts a re-link under each relation it works out: a rule, and a relation that inherits', async () => {
    const post = (path: string, v: unknown) => Promise.resolve(hub.app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-email': ADMIN, 'x-forwarded-groups': 'Admin' }, ...body(v) }, { surface: 'session' }))
    const model = 'blueprints:\n  - id: probe\n    title: Probe\n    relations:\n      node: { target: k8s_node }\n      cluster: { target: k8s_cluster, inherit: node.cluster }\n'
    expect((await post('/v1/model/import', { yaml: model })).status).toBe(200)
    expect((await post('/v1/entities', { blueprint: 'probe', key: 'p1', title: 'P1', relations: { node: 'home/n1' } })).status).toBe(201)
    await hub.rules.evaluateAll()
    const { relinking, hourly } = await load()
    // The rule reads every namespace and every system; it matches none of them, so it changes nothing.
    expect(relinking.find((r) => r.blueprint === 'k8s_namespace' && r.relation === 'system')).toMatchObject({ by: 'rule', changed: 0 })
    expect(relinking.find((r) => r.relation === 'system')!.read).toBeGreaterThanOrEqual(2)
    // The probe reads its node's cluster and takes it: one probe, one cluster reached, one link added.
    const inherited = relinking.find((r) => r.blueprint === 'probe' && r.relation === 'cluster')!
    expect(inherited).toMatchObject({ by: 'inherit', changed: 1 })
    expect(inherited.passes).toBeGreaterThanOrEqual(1)
    expect(inherited.read).toBeGreaterThanOrEqual(2)
    expect(hourly.at(-1)!.relink).toBeGreaterThan(0)
  })

  it('answers every hour of the window, each kind’s time in it adding up to the window’s', async () => {
    await hub.db.query(`INSERT INTO load_hours (hour, kind, name, calls, ms) VALUES (date_trunc('hour', now()) - interval '1 hour', 'read', 'an hour ago', 1, 500)`)
    const window = await load()
    expect(window.hourly).toHaveLength(2)
    expect(window.hourly.map((h) => h.hour)).toEqual([window.since, new Date(Date.parse(window.since) + 3_600_000).toISOString()])
    expect(window.hourly[0]!.read).toBe(500)
    const sum = (key: 'derive' | 'grids' | 'relink' | 'write' | 'read') => window.hourly.reduce((n, h) => n + h[key], 0)
    // Each hour is rounded on its own, and so is each name: the two may part by half a millisecond for each.
    const within = (key: 'derive' | 'grids' | 'relink' | 'write' | 'read', rows: { ms: number }[]) => expect(Math.abs(sum(key) - rows.reduce((n, r) => n + r.ms, 0))).toBeLessThanOrEqual((window.hourly.length + rows.length) / 2)
    within('read', window.reading)
    within('write', window.writing)
    within('derive', window.deriving)
    within('grids', window.grids)
    within('relink', window.relinking)
  })

  it('adds up what two hubs on one database noted', async () => {
    const calls = async () => Number((await hub.db.query<{ n: string }>(`SELECT coalesce(sum(calls), 0)::text AS n FROM load_hours WHERE kind = 'read' AND name = $1`, [ADMIN])).rows[0]!.n)
    await hub.load.flush()
    await other.load.flush()
    const before = await calls()
    await admin('/v1/blueprints')
    await as(other, ADMIN, 'Admin', '/v1/blueprints')
    await as(other, ADMIN, 'Admin', '/v1/blueprints')
    await hub.load.flush()
    await other.load.flush()
    expect(await calls()).toBe(before + 3)
    // And each hub answers with the whole of it.
    const seen = ((await (await as(other, ADMIN, 'Admin', '/v1/load?hours=1')).json()) as LoadResponse).reading.find((r) => r.caller === ADMIN)!
    expect(seen.calls).toBeGreaterThanOrEqual(before + 3)
  })

  it('lets go of the hours older than it keeps', async () => {
    await hub.db.query(`INSERT INTO load_hours (hour, kind, name, calls) VALUES (date_trunc('hour', now()) - interval '20 days', 'read', 'long ago', 1)`)
    await hub.load.prune(14)
    expect((await hub.db.query(`SELECT 1 FROM load_hours WHERE name = 'long ago'`)).rowCount).toBe(0)
    expect((await hub.db.query(`SELECT 1 FROM load_hours WHERE name = $1`, [ADMIN])).rowCount).toBeGreaterThan(0)
  })

  it('stores everything noted before a flush answers, even while another store is under way', async () => {
    const hour = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000)
    await hub.db.query(`INSERT INTO load_hours (hour, kind, name, calls, ms, rows, extra, sighted) VALUES ($1, 'write', 'held', 0, 0, 0, 0, 0) ON CONFLICT DO NOTHING`, [hour])
    // Another transaction holds the row, so the first store waits on it.
    let locked!: () => void
    let release!: () => void
    const isLocked = new Promise<void>((r) => (locked = r))
    const held = new Promise<void>((r) => (release = r))
    const holder = hub.db.tx(async (c) => {
      await c.query(`SELECT 1 FROM load_hours WHERE hour = $1 AND kind = 'write' AND name = 'held' FOR UPDATE`, [hour])
      locked()
      await held
    })
    await isLocked
    hub.load.note('write', 'held', { calls: 1, extra: 3 })
    const first = hub.load.flush()
    let answered = false
    const second = hub.load.flush().then(() => (answered = true))
    await new Promise((r) => setTimeout(r, 100))
    const early = answered
    release()
    await Promise.all([holder, first, second])
    expect(early).toBe(false)
    const row = await hub.db.query<{ extra: string }>(`SELECT extra::text AS extra FROM load_hours WHERE hour = $1 AND kind = 'write' AND name = 'held'`, [hour])
    expect(row.rows[0]?.extra).toBe('3')
  })

  it('is refused to a person who does not hold the permission', async () => {
    const res = await as(hub, 'reader@example.org', 'User', '/v1/load')
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: string }).error).toContain('audit.view')
  })
})
