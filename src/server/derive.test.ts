import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { loadConfig } from './config.ts'
import { loadFixtureCatalog } from './fixtures/load.ts'
import { createHub, type Hub } from './hub.ts'
import { Deriver } from './derive.ts'
import type { EntitiesResponse, EntityPageResponse } from '../shared/api.ts'
import type { Entity } from '../shared/model.ts'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://orrery:orrery@localhost:5433/orrery'

let hub: Hub
let token = ''

const session = (path: string, init?: RequestInit) => hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', ...init?.headers } }, { surface: 'session' })
const machine = (path: string, init?: RequestInit) => hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...init?.headers } }, { surface: 'machine' })
const json = async <T = Record<string, unknown>>(r: Response): Promise<T> => (await r.json()) as T
const body = (v: unknown) => ({ body: JSON.stringify(v) })

interface Stored {
  fields: Record<string, unknown>
  relations: Record<string, { blueprint: string; key: string; title?: string }[]>
  level: string
  reasons: { text: string; from: string | null }[]
  reads: string[]
  derived_at: Date
}

const stored = async (blueprint: string, key: string): Promise<Stored | undefined> => (await hub.db.query<Stored>('SELECT fields, relations, level, reasons, reads, derived_at FROM derived WHERE blueprint = $1 AND key = $2', [blueprint, key])).rows[0]
const queued = async (): Promise<string[]> => (await hub.db.query<{ id: string }>(`SELECT blueprint || ':' || key AS id FROM derive_queue ORDER BY 1`)).rows.map((r) => r.id)
/** Drains until the queue is empty: each pass leaves what its own cascade queued for the next. */
async function settle(): Promise<void> {
  for (let i = 0; i < 6 && (await queued()).length; i++) await hub.deriver.drain()
  expect(await queued()).toEqual([])
}

async function snapshot(entities: unknown[], scope = 'home'): Promise<void> {
  const run = await json<{ id: string }>(await machine('/v1/ingest/runs', { method: 'POST', ...body({ mode: 'snapshot', scope }) }))
  expect([200, 207]).toContain((await machine(`/v1/ingest/runs/${run.id}/entities`, { method: 'PUT', ...body({ entities }) })).status)
  expect((await machine(`/v1/ingest/runs/${run.id}/commit`, { method: 'POST' })).status).toBe(200)
}

beforeAll(async () => {
  const config = loadConfig({ DATABASE_URL, DATA_DIR: mkdtempSync(join(tmpdir(), 'orrery-')), AUTH_MODE: 'none', DERIVE_INLINE_MAX: '3' })
  hub = await createHub(config, 'test', { reset: true })
  expect((await loadFixtureCatalog(hub)).errors).toEqual([])
  await hub.sources.save('k8s@home', { title: 'k8s home', class: 'pusher', blueprints: ['*'], deleteGrant: ['k8s_node'], cadence: '3m', grace: { runs: 2, duration: '0' } })
  token = (await hub.sources.issueToken('source', 'home pusher', { source: 'k8s@home' })).token
  await hub.deriver.backfill()
})

afterAll(async () => {
  await hub.close()
})

describe('derived state in the database', () => {
  it('leaves a push to the leader, which stores what each row read', async () => {
    await snapshot([
      { blueprint: 'k8s_cluster', key: 'home', title: 'home', fields: { version: 'v1.31.0' } },
      { blueprint: 'k8s_node', key: 'home/n1', title: 'n1', fields: { cpu: 8, memory_gb: 32, ready: true, health: 'green' }, relations: { cluster: 'home' } },
    ])
    // A run's writes are answered before anything is derived: the rows wait in the queue.
    expect(await stored('k8s_node', 'home/n1')).toBeUndefined()
    expect(await queued()).toEqual(expect.arrayContaining(['k8s_cluster:home', 'k8s_node:home/n1']))
    // A read meanwhile derives the row for itself.
    expect((await json<EntityPageResponse>(await session('/v1/entities/k8s_node/home%2Fn1'))).fields.cpu).toBe(8)
    await settle()
    const node = await stored('k8s_node', 'home/n1')
    expect(node!.fields.cpu).toBe(8)
    expect(node!.level).toBe('green')
    expect(node!.relations.cluster).toEqual([{ blueprint: 'k8s_cluster', key: 'home', title: 'home' }])
    expect(node!.reads).toContain('k8s_cluster:home')
  })

  it('reads an entity from its stored row, the same as the API shows it', async () => {
    const page = await json<EntityPageResponse>(await session('/v1/entities/k8s_node/home%2Fn1'))
    const row = (await stored('k8s_node', 'home/n1'))!
    expect(page.fields).toEqual(row.fields)
    expect(page.status.level).toBe(row.level)
    expect(page.relations).toEqual(row.relations)
  })

  it('writes only the time of a row derived the same as it is stored, and the whole of one that moved', async () => {
    const ref = { blueprint: 'k8s_node', key: 'home/n1' }
    await settle()
    const statements: string[] = []
    const tx = hub.db.tx.bind(hub.db)
    hub.db.tx = (<T,>(fn: Parameters<typeof tx<T>>[0]) =>
      tx<T>((client) => {
        const query = client.query.bind(client) as (text: string, params?: unknown[]) => Promise<unknown>
        return fn(new Proxy(client, { get: (c, name) => (name === 'query' ? (text: string, params?: unknown[]) => (statements.push(text), query(text, params)) : Reflect.get(c, name)) }))
      })) as typeof hub.db.tx
    try {
      const before = (await stored('k8s_node', 'home/n1'))!
      await hub.deriver.derive([ref], { consume: false })
      const again = (await stored('k8s_node', 'home/n1'))!
      // One statement for every row, in key order, so it takes its locks as every other derivation does.
      expect(statements.filter((s) => /^(INSERT INTO|UPDATE) derived\b/.test(s) || s.includes('FOR UPDATE'))).toEqual([expect.stringMatching(/^INSERT INTO derived/)])
      expect(new Date(again.derived_at).getTime()).toBeGreaterThan(new Date(before.derived_at).getTime())
      expect({ ...again, derived_at: null }).toEqual({ ...before, derived_at: null })
      statements.length = 0
      expect((await machine('/v1/ingest/entities/k8s_node/home%2Fn1', { method: 'PATCH', ...body({ fields: { cpu: 12 } }) })).status).toBe(200)
      await hub.deriver.derive([ref], { consume: false })
      expect(statements.some((s) => s.startsWith('INSERT INTO derived'))).toBe(true)
      expect((await stored('k8s_node', 'home/n1'))!.fields.cpu).toBe(12)
    } finally {
      hub.db.tx = tx
      await machine('/v1/ingest/entities/k8s_node/home%2Fn1', { method: 'PATCH', ...body({ fields: { cpu: 8 } }) })
      await settle()
    }
  })

  it('derives what is missing among the entities asked about alone, and leaves the rest of the blueprint to the leader', async () => {
    await snapshot([
      { blueprint: 'k8s_node', key: 'home/n8', title: 'n8', fields: { cpu: 2, memory_gb: 4, ready: true, health: 'green' }, relations: { cluster: 'home' } },
      { blueprint: 'k8s_node', key: 'home/n9', title: 'n9', fields: { cpu: 2, memory_gb: 4, ready: true, health: 'green' }, relations: { cluster: 'home' } },
    ], 'nodes-asked')
    expect(await stored('k8s_node', 'home/n9')).toBeUndefined()
    await hub.deriver.ensure('k8s_node', null, ['home/n9'])
    expect((await stored('k8s_node', 'home/n9'))!.fields.cpu).toBe(2)
    expect(await stored('k8s_node', 'home/n8')).toBeUndefined()
    for (const key of ['home%2Fn8', 'home%2Fn9']) expect((await machine(`/v1/ingest/entities/k8s_node/${key}`, { method: 'DELETE' })).status).toBe(200)
    await settle()
  })

  it('hydrates stored rows without their layers the same as a whole read, and derives one not yet stored', async () => {
    await snapshot([
      { blueprint: 'k8s_cluster', key: 'home', title: 'home', fields: { version: 'v1.31.0' } },
      { blueprint: 'k8s_node', key: 'home/n1', title: 'n1', fields: { cpu: 8, memory_gb: 32, ready: true, health: 'green' }, relations: { cluster: 'home' } },
      { blueprint: 'k8s_node', key: 'home/n2', title: 'n2', fields: { cpu: 4, memory_gb: 16, ready: false, health: 'red', health_reason: 'down' }, relations: { cluster: 'home' } },
    ])
    await settle()
    // A write the leader has not derived yet: its stored row is older than the entity, so it is derived for the read.
    expect((await machine('/v1/ingest/entities/k8s_node/home%2Fn2', { method: 'PATCH', ...body({ fields: { cpu: 6 } }) })).status).toBe(200)
    const refs = [{ blueprint: 'k8s_node', key: 'home/n1' }, { blueprint: 'k8s_node', key: 'home/n2' }, { blueprint: 'k8s_cluster', key: 'home' }, { blueprint: 'k8s_node', key: 'gone' }]
    const byId = (list: Entity[]) => Object.fromEntries(list.map((e) => [e.id, e]))
    const light = byId(await hub.reader.hydrated(refs))
    expect(light).toEqual(byId(await hub.reader.derive(await hub.reader.joinedFor(refs))))
    expect(Object.keys(light).sort()).toEqual(['k8s_cluster:home', 'k8s_node:home/n1', 'k8s_node:home/n2'])
    expect(light['k8s_node:home/n2']!.fields.cpu).toBe(6)
    expect(light['k8s_node:home/n2']!.status.level).toBe('red')
  })

  it('derives the readers of what changed: a retitled cluster shows its new title on its nodes', async () => {
    await snapshot([
      { blueprint: 'k8s_cluster', key: 'home', title: 'Lab', fields: { version: 'v1.31.0' } },
      { blueprint: 'k8s_node', key: 'home/n1', title: 'n1', fields: { cpu: 8, memory_gb: 32, ready: true, health: 'green' }, relations: { cluster: 'home' } },
    ])
    // The node reads the cluster's title: the leader derives it again though the node itself did not change.
    await settle()
    expect((await stored('k8s_node', 'home/n1'))!.relations.cluster?.[0]?.title).toBe('Lab')
    const grid = await json<EntitiesResponse>(await session('/v1/entities?blueprint=k8s_node&distribution=true'))
    expect(grid.entities[0]?.relations.cluster?.[0]?.title).toBe('Lab')
  })

  it('rolls a status up from stored rows and keeps where each reason came from', async () => {
    // The fixture's system rolls up everything that points at it through a `system` relation.
    await snapshot([{ blueprint: 'system', key: 'shop', title: 'Shop' }], 'systems')
    await snapshot([{ blueprint: 'k8s_namespace', key: 'home/shop', title: 'shop', relations: { cluster: 'home' } }], 'namespaces')
    await snapshot([{ blueprint: 'k8s_workload', key: 'home/shop/web', title: 'web', fields: { kind: 'Deployment', replicas: 3, ready: 0, health: 'red', health_reason: 'pods crashing' }, relations: { namespace: 'home/shop', system: 'shop' } }], 'workloads')
    await settle()
    const web = (await stored('k8s_workload', 'home/shop/web'))!
    expect(web.level).toBe('red')
    expect(web.reasons).toEqual([{ text: 'pods crashing', from: null }])
    // The workload changed and the system reads it: the system was derived after it.
    const system = (await stored('system', 'shop'))!
    expect(system.level).toBe('red')
    expect(system.reasons).toEqual([{ text: 'web: pods crashing', from: 'k8s_workload' }])
    expect(system.reads).toContain('k8s_workload:home/shop/web')
  })

  it('carries a status up through the leader when the request stored it but could not carry it up', async () => {
    // The request stores the workload's new status, then its next round fails, as a deadlock does under load.
    const derive = hub.deriver.derive.bind(hub.deriver)
    let inlineRounds = 0
    hub.deriver.derive = async (refs, opts) => {
      if (!opts.consume && ++inlineRounds === 2) throw new Error('deadlock detected')
      return derive(refs, opts)
    }
    try {
      expect((await machine('/v1/ingest/entities/k8s_workload/home%2Fshop%2Fweb', { method: 'PATCH', ...body({ fields: { ready: 3, health: 'green', health_reason: '' } }) })).status).toBe(200)
    } finally {
      hub.deriver.derive = derive
    }
    expect((await stored('k8s_workload', 'home/shop/web'))!.level).toBe('green')
    expect((await stored('system', 'shop'))!.level).toBe('red')
    // The leader finds the workload's row already as it should be; the system that reads it must still be derived again.
    await settle()
    expect((await stored('system', 'shop'))!.level).toBe('green')
  })

  it('a larger push waits for the leader, and the grid shows it once the drain lands', async () => {
    const nodes = ['n2', 'n3', 'n4', 'n5'].map((k) => ({ blueprint: 'k8s_node', key: `home/${k}`, title: k, fields: { cpu: 4, memory_gb: 16, ready: true, health: 'green' }, relations: { cluster: 'home' } }))
    await snapshot([{ blueprint: 'k8s_cluster', key: 'home', title: 'Lab', fields: { version: 'v1.31.0' } }, { blueprint: 'k8s_node', key: 'home/n1', title: 'n1', fields: { cpu: 8, memory_gb: 32, ready: true, health: 'green' }, relations: { cluster: 'home' } }, ...nodes])
    // Six entities is over the inline limit of three: the new ones have no stored row yet.
    expect(await stored('k8s_node', 'home/n5')).toBeUndefined()
    // A read meanwhile derives them for itself, and the answer is right.
    const before = await json<EntitiesResponse>(await session('/v1/entities?blueprint=k8s_node&distribution=true'))
    expect(before.total).toBe(5)
    await settle()
    expect((await stored('k8s_node', 'home/n5'))!.level).toBe('green')
  })

  it('forgets a deleted entity and derives what pointed at it', async () => {
    expect((await machine('/v1/ingest/entities/k8s_node/home%2Fn5', { method: 'DELETE' })).status).toBe(200)
    expect(await stored('k8s_node', 'home/n5')).toBeUndefined()
    // The cluster read the node through its status rollup: it is queued, and derived again by the drain.
    expect(await queued()).toContain('k8s_cluster:home')
    await settle()
    expect((await stored('k8s_cluster', 'home'))!.reads).not.toContain('k8s_node:home/n5')
  })

  const derivedAt = async (blueprint: string, key: string): Promise<number> => (await stored(blueprint, key))!.derived_at.getTime()

  it('leaves alone a row that only shows a changed entity by its title', async () => {
    const lab = (version: string) => [
      { blueprint: 'k8s_cluster', key: 'lab', title: 'lab', fields: { version } },
      { blueprint: 'k8s_node', key: 'lab/a', title: 'a', fields: { cpu: 8, memory_gb: 32, ready: true, health: 'green' }, relations: { cluster: 'lab' } },
    ]
    await snapshot(lab('v1.31.0'), 'lab')
    await settle()
    const before = await derivedAt('k8s_node', 'lab/a')
    // The cluster's stored row changes, and the node shows only the cluster's title, which is not in it.
    await snapshot(lab('v1.32.0'), 'lab')
    await settle()
    expect((await stored('k8s_cluster', 'lab'))!.fields.version).toBe('v1.32.0')
    expect(await derivedAt('k8s_node', 'lab/a')).toBe(before)
    // A person's edit, derived on the request, sends none back either.
    expect((await session('/v1/entities/k8s_cluster/lab', { method: 'PATCH', ...body({ fields: { notes: 'rack two' } }) })).status).toBe(200)
    await settle()
    expect(await derivedAt('k8s_node', 'lab/a')).toBe(before)
  })

  it('derives a reader again for the field it mirrors, and not for another', async () => {
    const catalog = (tier: string, description: string) => [
      { blueprint: 'environment', key: 'prod', title: 'prod', fields: { type: 'production' } },
      { blueprint: 'service', key: 'pay', title: 'Pay', fields: { tier, description } },
      { blueprint: 'workload', key: 'pay', title: 'pay in prod', relations: { service: 'pay', environment: 'prod' } },
    ]
    await snapshot(catalog('internal', 'Takes payments'), 'catalog')
    await hub.rules.settled()
    await settle()
    expect((await stored('workload', 'pay'))!.fields.tier).toBe('internal')
    const before = await derivedAt('workload', 'pay')
    await snapshot(catalog('internal', 'Takes card payments'), 'catalog')
    await settle()
    expect((await stored('service', 'pay'))!.fields.description).toBe('Takes card payments')
    expect(await derivedAt('workload', 'pay')).toBe(before)
    await snapshot(catalog('mission_critical', 'Takes card payments'), 'catalog')
    await settle()
    expect((await stored('workload', 'pay'))!.fields.tier).toBe('mission_critical')
  })

  it('derives a reader again when a path it follows gains an entity two hops away', async () => {
    const deployment = (key: string) => ({ blueprint: 'sw_deployment', key, title: key, fields: { status: 'failed', deployed_at: new Date().toISOString() }, relations: { app: 'pay' } })
    await snapshot([{ blueprint: 'argocd_app', key: 'pay', title: 'pay', fields: { sync_status: 'Synced', health_status: 'Healthy' }, relations: { workload: 'pay' } }], 'apps')
    await snapshot([deployment('pay-1')], 'deployments')
    await settle()
    const service = (await stored('service', 'pay'))!
    expect(service.fields.failed_deployments_30d).toBe(1)
    // The service reads the deployments at the end of the path, and the workload and the app it stepped through.
    expect(service.reads).toEqual(expect.arrayContaining(['sw_deployment:pay-1', 'argocd_app:pay', 'workload:pay']))
    // A new deployment names only the app. Nothing the workload or the service read of the app has changed but who points at it.
    await snapshot([deployment('pay-1'), deployment('pay-2')], 'deployments')
    await settle()
    expect((await stored('service', 'pay'))!.fields.failed_deployments_30d).toBe(2)
  })

  it('reads only the values a rollup names of what it reaches, and never from a stored row that is behind', async () => {
    const statements: string[] = []
    const query = hub.db.query.bind(hub.db)
    hub.db.query = ((text: string, params?: unknown[]) => (statements.push(text), query(text, params))) as typeof hub.db.query
    try {
      // A deployment that failed succeeds on a retry the leader has not derived yet: its stored row still says it failed.
      const run = await json<{ id: string }>(await machine('/v1/ingest/runs', { method: 'POST', ...body({ mode: 'incremental', scope: 'deployments' }) }))
      expect((await machine(`/v1/ingest/runs/${run.id}/entities`, { method: 'PUT', ...body({ entities: [{ blueprint: 'sw_deployment', key: 'pay-2', title: 'pay-2', fields: { status: 'succeeded', deployed_at: new Date().toISOString() }, relations: { app: 'pay' } }] }) })).status).toBe(200)
      expect((await machine(`/v1/ingest/runs/${run.id}/commit`, { method: 'POST' })).status).toBe(200)
      expect((await stored('sw_deployment', 'pay-2'))!.fields.status).toBe('failed')
      statements.length = 0
      await hub.deriver.derive([{ blueprint: 'service', key: 'pay' }], { consume: false })
      // The service counts what the deployment holds now, though its stored row is behind.
      expect((await stored('service', 'pay'))!.fields.failed_deployments_30d).toBe(1)
      // What a rollup reads of what it reaches is asked by name: the deployments' stored rows are never read whole.
      expect(statements.some((s) => s.includes('jsonb_object_agg(n, d.fields -> n)'))).toBe(true)
    } finally {
      hub.db.query = query
    }
    await settle()
    expect((await stored('service', 'pay'))!.fields.failed_deployments_30d).toBe(1)
  })

  it('derives a rollup again when an end two hops away changes and nothing else is written', async () => {
    expect((await stored('service', 'pay'))!.fields.failed_deployments_30d).toBe(1)
    const run = await json<{ id: string }>(await machine('/v1/ingest/runs', { method: 'POST', ...body({ mode: 'incremental', scope: 'deployments' }) }))
    expect((await machine(`/v1/ingest/runs/${run.id}/entities`, { method: 'PUT', ...body({ entities: [{ blueprint: 'sw_deployment', key: 'pay-2', title: 'pay-2', fields: { status: 'failed', deployed_at: new Date().toISOString() }, relations: { app: 'pay' } }] }) })).status).toBe(200)
    expect((await machine(`/v1/ingest/runs/${run.id}/commit`, { method: 'POST' })).status).toBe(200)
    expect(await queued()).toEqual(['sw_deployment:pay-2'])
    await settle()
    expect((await stored('service', 'pay'))!.fields.failed_deployments_30d).toBe(2)
  })

  it('derives again a row an earlier release derived another way', async () => {
    await hub.db.query(`UPDATE derived SET way = 1 WHERE blueprint = 'service' AND key = 'pay'`)
    await hub.deriver.reconcile()
    expect(await queued()).toEqual(['service:pay'])
    await settle()
    expect((await hub.db.query<{ way: number }>(`SELECT way FROM derived WHERE blueprint = 'service' AND key = 'pay'`)).rows[0]!.way).toBeGreaterThan(1)
  })

  it('derives again, as a hub takes the lead, every row an earlier release derived and nothing else', async () => {
    await settle()
    await hub.db.query(`UPDATE derived SET way = 1 WHERE blueprint = 'service' AND key = 'pay'`)
    // What a hub runs as it takes the lead, before any lifecycle tick.
    await hub.deriver.backfill()
    expect(await queued()).toEqual(['service:pay'])
    await settle()
    expect((await hub.db.query<{ n: string }>(`SELECT count(*)::text AS n FROM derived WHERE way = 1`)).rows[0]!.n).toBe('0')
    // Every row is current now: a second lead queues nothing.
    await hub.deriver.backfill()
    expect(await queued()).toEqual([])
  })

  const taken = async (blueprint: string, key: string): Promise<Date | null | undefined> => (await hub.db.query<{ taken_until: Date | null }>('SELECT taken_until FROM derive_queue WHERE blueprint = $1 AND key = $2', [blueprint, key])).rows[0]?.taken_until

  it('shares the queue between hubs that derive side by side: each entity is taken by one', async () => {
    const keys = Array.from({ length: 40 }, (_, i) => `shared-${String(i).padStart(2, '0')}`)
    await snapshot(keys.map((key) => ({ blueprint: 'k8s_cluster', key, title: key })), 'shared')
    const small = { DATABASE_URL, AUTH_MODE: 'none', DERIVE_BATCH: '5' }
    const [one, two] = await Promise.all([createHub(loadConfig({ ...small, DATA_DIR: mkdtempSync(join(tmpdir(), 'orrery-')) }), 'test'), createHub(loadConfig({ ...small, DATA_DIR: mkdtempSync(join(tmpdir(), 'orrery-')) }), 'test')])
    try {
      const waiting = (await queued()).length
      expect(waiting).toBeGreaterThanOrEqual(40)
      const [a, b] = await Promise.all([one.deriver.drain({ relink: false }), two.deriver.drain({ relink: false })])
      // Neither derived what the other took, and between them nothing is left.
      expect(a + b).toBe(waiting)
      expect(a).toBeGreaterThan(0)
      expect(b).toBeGreaterThan(0)
      expect(await queued()).toEqual([])
    } finally {
      await Promise.all([one.close(), two.close()])
    }
  })

  it('keeps on the queue an entity that changed while a hub was deriving it', async () => {
    const ref = { blueprint: 'k8s_cluster', key: 'shared-00' }
    await hub.deriver.enqueue(hub.db, [ref])
    // A hub takes it, and while it is still working a writer queues the entity again.
    await hub.db.query(`UPDATE derive_queue SET taken_until = now() + interval '2 minutes' WHERE blueprint = $1 AND key = $2`, [ref.blueprint, ref.key])
    await hub.deriver.enqueue(hub.db, [ref])
    expect(await queued()).toEqual(['k8s_cluster:shared-00', 'k8s_cluster:shared-00'])
    // The hub stores what it derived and removes the row it took. The new one stays: what the hub read is older than the change.
    await hub.deriver.derive([ref], { consume: true })
    expect(await queued()).toEqual(['k8s_cluster:shared-00'])
    expect(await taken(ref.blueprint, ref.key)).toBeNull()
    await settle()
  })

  it('never takes a waiting entity a writer queued again until the writer commits', async () => {
    const ref = { blueprint: 'k8s_cluster', key: 'shared-03' }
    await hub.deriver.enqueue(hub.db, [ref])
    let commit!: () => void
    const open = new Promise<void>((resolveOpen) => (commit = resolveOpen))
    let queuedIt!: () => void
    const inside = new Promise<void>((resolveInside) => (queuedIt = resolveInside))
    // A writer changes the entity and queues it in a transaction that is still open while the leader drains.
    const writer = hub.db.tx(async (client) => {
      await hub.deriver.enqueue(client, [ref])
      queuedIt()
      await open
    })
    await inside
    // The leader reads what the writer has not committed yet, so it must leave the entity for a later pass.
    await hub.deriver.drain({ relink: false })
    commit()
    await writer
    expect(await queued()).toEqual(['k8s_cluster:shared-03'])
    await settle()
  })

  it('takes again what a hub took and never finished, once its hold is past', async () => {
    const ref = { blueprint: 'k8s_cluster', key: 'shared-01' }
    await hub.deriver.enqueue(hub.db, [ref])
    await hub.db.query(`UPDATE derive_queue SET taken_until = now() + interval '2 minutes' WHERE blueprint = $1 AND key = $2`, [ref.blueprint, ref.key])
    expect(await hub.deriver.drain()).toBe(0)
    await hub.db.query(`UPDATE derive_queue SET taken_until = now() - interval '1 second' WHERE blueprint = $1 AND key = $2`, [ref.blueprint, ref.key])
    expect(await hub.deriver.drain()).toBe(1)
    expect(await queued()).toEqual([])
  })

  it('lets go of what it took when a pass fails, so the next pass takes it at once', async () => {
    const ref = { blueprint: 'k8s_cluster', key: 'shared-02' }
    await hub.deriver.enqueue(hub.db, [ref])
    const derive = hub.deriver.derive.bind(hub.deriver)
    hub.deriver.derive = async () => {
      throw new Error('could not resize shared memory segment')
    }
    try {
      await expect(hub.deriver.drain()).rejects.toThrow('shared memory')
    } finally {
      hub.deriver.derive = derive
    }
    expect(await taken(ref.blueprint, ref.key)).toBeNull()
    expect(await hub.deriver.drain()).toBe(1)
    expect(await queued()).toEqual([])
  })

  it('never lets a derivation from older inputs overwrite one from newer', async () => {
    await hub.db.query(`UPDATE derived SET fields = fields || '{"marker": "newer"}'::jsonb, derived_at = now() + interval '1 hour' WHERE blueprint = 'k8s_node' AND key = 'home/n1'`)
    await hub.deriver.derive([{ blueprint: 'k8s_node', key: 'home/n1' }], { consume: false })
    expect((await stored('k8s_node', 'home/n1'))!.fields.marker).toBe('newer')
    await hub.db.query(`UPDATE derived SET fields = fields - 'marker', derived_at = now() - interval '1 hour' WHERE blueprint = 'k8s_node' AND key = 'home/n1'`)
    await hub.deriver.derive([{ blueprint: 'k8s_node', key: 'home/n1' }], { consume: false })
    expect((await stored('k8s_node', 'home/n1'))!.fields.marker).toBeUndefined()
  })

  it('reconciles a row that went missing or fell behind its entity', async () => {
    await hub.db.query(`DELETE FROM derived WHERE blueprint = 'k8s_node' AND key = 'home/n2'`)
    await hub.db.query(`UPDATE derived SET derived_at = now() - interval '1 day' WHERE blueprint = 'k8s_node' AND key = 'home/n3'`)
    await hub.deriver.reconcile()
    expect(await queued()).toEqual(expect.arrayContaining(['k8s_node:home/n2', 'k8s_node:home/n3']))
    await settle()
    expect(await stored('k8s_node', 'home/n2')).toBeDefined()
  })

  const expiry = async (blueprint: string, key: string): Promise<Date | null> => (await hub.db.query<{ expires_at: Date | null }>('SELECT expires_at FROM derived WHERE blueprint = $1 AND key = $2', [blueprint, key])).rows[0]?.expires_at ?? null
  const REPO = { blueprint: 'repository', key: 'home/repo' }

  it('stores when a row that reads the time next changes, and derives it again then and not before', async () => {
    // The fixture's repository calculates days since its last push, so its row turns on the hour; a cluster reads no time.
    await snapshot([{ ...REPO, title: 'repo', fields: { last_push: new Date(Date.now() - 3 * 86_400_000).toISOString(), has_readme: true, has_ci: true } }], 'repos')
    await settle()
    const repo = REPO.key
    const next = await expiry('repository', repo)
    expect(next).not.toBeNull()
    expect(next!.getTime()).toBeGreaterThan(Date.now())
    expect(next!.getTime()).toBeLessThanOrEqual(Date.now() + 3_600_000)
    expect(next!.getTime() % 3_600_000).toBe(0)
    expect(await expiry('k8s_cluster', 'home')).toBeNull()
    // A hub's first standing pass derives every source's own record; after it, nothing has reached its moment: the clock queues nothing.
    await hub.deriver.standing()
    await settle()
    await hub.deriver.clock()
    expect(await queued()).toEqual([])
    // Derived again before then, the row reads the same, so nothing that reads it follows.
    expect((await hub.deriver.derive([{ blueprint: 'repository', key: repo }], { consume: false })).changed).toEqual([])
    // Once it has, the clock queues it, and the row derived again names its next moment.
    // Only the deriver writes a stored row, and its fingerprint with it: one changed behind its back is told by a fingerprint no derivation gives.
    await hub.db.query(`UPDATE derived SET expires_at = now() - interval '1 second', fingerprint = NULL WHERE blueprint = 'repository' AND key = $1`, [repo])
    await hub.deriver.clock()
    expect(await queued()).toEqual([`repository:${repo}`])
    await settle()
    expect((await expiry('repository', repo))!.getTime()).toBeGreaterThan(Date.now())
  })

  it('reads a row that reads the time as stored, never computing it for the read', async () => {
    const repo = REPO.key
    await hub.db.query(`UPDATE derived SET fields = jsonb_set(fields, '{freshness_days}', '4321'), fingerprint = NULL WHERE blueprint = 'repository' AND key = $1`, [repo])
    const grid = await json<EntitiesResponse>(await session('/v1/entities?blueprint=repository&limit=100&distribution=true'))
    expect(grid.entities.find((e) => e.key === repo)!.fields.freshness_days).toBe(4321)
    const page = await json<EntityPageResponse>(await session(`/v1/entities/repository/${encodeURIComponent(repo)}`))
    expect(page.fields.freshness_days).toBe(4321)
    // The leader puts it right.
    await hub.deriver.enqueue(hub.db, [{ blueprint: 'repository', key: repo }])
    await settle()
    expect((await stored('repository', repo))!.fields.freshness_days).not.toBe(4321)
  })

  it('queues a source\'s entities when its standing greys them or lets them go, and never for a failed run\'s new reason', async () => {
    await hub.deriver.standing()
    // A source failing run after run says something new each time; its entities read none of it.
    await hub.sources.touch('k8s@home', { run: new Date(), error: 'boom', status: 'red', reason: 'run 1 failed: boom' })
    await hub.deriver.standing()
    await hub.sources.touch('k8s@home', { run: new Date(), error: 'bang', status: 'red', reason: 'run 2 failed: bang' })
    await hub.deriver.standing()
    expect((await queued()).filter((id) => !id.startsWith('orrery_source:') && !id.startsWith('orrery_runner:'))).toEqual([])
    // Stale, it greys them.
    await hub.db.query(`UPDATE sources SET last_seen_at = now() - interval '1 hour', last_run_at = now() - interval '1 hour' WHERE id = 'k8s@home'`)
    await hub.sources.load()
    await hub.deriver.standing()
    expect(await queued()).toEqual(expect.arrayContaining(['k8s_cluster:home', 'k8s_node:home/n1']))
    await settle()
    expect((await stored('k8s_node', 'home/n1'))!.level).toBe('grey')
    // A push lets them go.
    await hub.sources.touch('k8s@home', { run: new Date(), seen: new Date(), error: null, status: 'green', reason: null })
    await hub.deriver.standing()
    expect(await queued()).toEqual(expect.arrayContaining(['k8s_node:home/n1']))
    await settle()
    expect((await stored('k8s_node', 'home/n1'))!.level).toBe('green')
  })

  it('derives a source\'s own record again whenever its standing moves, so its card never keeps its first status', async () => {
    await hub.sources.touch('k8s@home', { run: new Date(), seen: new Date(), error: null, status: 'green', reason: null })
    await hub.deriver.standing()
    await settle()
    expect((await stored('orrery_source', 'k8s@home'))!.level).toBe('green')
    await hub.sources.touch('k8s@home', { run: new Date(), error: 'boom', status: 'red', reason: 'run failed: boom' })
    await hub.deriver.standing()
    expect(await queued()).toContain('orrery_source:k8s@home')
    await settle()
    expect((await stored('orrery_source', 'k8s@home'))!.level).toBe('red')
    await hub.sources.touch('k8s@home', { run: new Date(), seen: new Date(), error: null, status: 'green', reason: null })
    await hub.deriver.standing()
    await settle()
    expect((await stored('orrery_source', 'k8s@home'))!.level).toBe('green')
  })

  it('derives every source\'s own record on a hub\'s first standing pass, so a record derived before the first push never stays grey', async () => {
    await hub.sources.save('quiet@home', { title: 'quiet', class: 'pusher', blueprints: ['k8s_node'], cadence: '3m', grace: { runs: 2, duration: '0' } })
    await hub.runs.syncSourceEntities('quiet@home')
    await settle()
    expect((await stored('orrery_source', 'quiet@home'))!.reasons.map((r) => r.text)).toContain('never reported')
    await hub.sources.touch('quiet@home', { run: new Date(), seen: new Date(), error: null, status: 'green', reason: null })
    // A hub that starts now finds the source green already: its standing never moves from here.
    const started = new Deriver({ db: hub.db, reader: hub.reader, blueprints: hub.blueprints, sources: hub.sources, rules: hub.rules, events: hub.events, load: hub.load, log: hub.log }, { batch: 100, budgetMs: 1000, inlineMax: 3 })
    await started.standing()
    expect(await queued()).toContain('orrery_source:quiet@home')
    await settle()
    expect((await stored('orrery_source', 'quiet@home'))!.level).toBe('green')
  })

  it('stores derivations that share new rows side by side without a deadlock', async () => {
    const keys = Array.from({ length: 40 }, (_, i) => `lockstep-${String(i).padStart(2, '0')}`)
    await snapshot(keys.map((key) => ({ blueprint: 'k8s_cluster', key, title: key })), 'lockstep')
    const refs = keys.map((key) => ({ blueprint: 'k8s_cluster', key }))
    // A large estate's planner walks the asked-for list instead of the table, so the rows come back in the order each
    // batch asked for them. This small one walks the table; a hub told to plan as the large one does shows it.
    const planned = `${DATABASE_URL}${DATABASE_URL.includes('?') ? '&' : '?'}options=${encodeURIComponent('-c enable_hashjoin=off -c enable_mergejoin=off -c enable_seqscan=off')}`
    const large = await createHub(loadConfig({ DATABASE_URL: planned, DATA_DIR: mkdtempSync(join(tmpdir(), 'orrery-')), AUTH_MODE: 'none' }), 'test')
    try {
      for (let i = 0; i < 40; i++) {
        // New rows, as a fresh push makes them, beside rows stored as they derive: each derivation inserts what the others
        // are inserting too, and touches what the others are writing.
        await large.db.query(`DELETE FROM derived WHERE blueprint = 'k8s_cluster' AND key = ANY($1::text[])`, [i % 2 ? keys : keys.filter(() => Math.random() < 0.5)])
        // Batches that share some rows and not others, as a request's own write and the leader's pass do.
        const some = () => refs.filter(() => Math.random() < 0.7)
        await Promise.all([some(), some(), some(), some()].map((batch) => large.deriver.derive(batch, { consume: false })))
      }
    } finally {
      await large.close()
    }
    // The leader takes up what the push queued and stores every row again.
    await settle()
  })

  it('backfill derives only what has no derived row', async () => {
    const before = (await stored('k8s_node', 'home/n2'))!.derived_at
    await hub.db.query(`DELETE FROM derived WHERE blueprint = 'k8s_node' AND key = 'home/n1'`)
    await hub.deriver.backfill()
    expect(await queued()).toEqual([])
    expect(await stored('k8s_node', 'home/n1')).toBeDefined()
    expect((await stored('k8s_node', 'home/n2'))!.derived_at).toEqual(before)
  })

  it('backfill finds nothing to do once every row is stored', async () => {
    await hub.deriver.backfill()
    expect(await queued()).toEqual([])
    const missing = await hub.db.query<{ n: string }>(`SELECT count(*)::text AS n FROM entities e WHERE e.state <> 'deleted' AND NOT EXISTS (SELECT 1 FROM derived d WHERE d.blueprint = e.blueprint AND d.key = e.key)`)
    expect(missing.rows[0]!.n).toBe('0')
  })

  it('derives nothing again when a blueprint is saved as it already stands', async () => {
    const { origin, updatedAt, ...spec } = hub.blueprints.get('k8s_node')!
    const rows = async () => (await hub.db.query<{ key: string; derived_at: Date }>(`SELECT key, derived_at FROM derived WHERE blueprint = 'k8s_node' ORDER BY key`)).rows
    const before = await rows()
    // More rows than a read derives for itself, so stale ones would go to the queue.
    expect(before.length).toBeGreaterThan(3)
    // A git source saves every blueprint it holds on each pass, changed or not.
    const saved = await hub.blueprints.save(structuredClone(spec), origin, 'test', (bp, field) => hub.entities.valuesOf(bp, field))
    expect(saved.updatedAt).toBe(updatedAt)
    expect((await json<EntitiesResponse>(await session('/v1/entities?blueprint=k8s_node'))).total).toBe(before.length)
    expect(await queued()).toEqual([])
    expect(await rows()).toEqual(before)
  })

  it('derives nothing again when a save changes only what derivation never reads, and all of it when a save changes what it reads', async () => {
    const { origin, updatedAt: _at, ...spec } = hub.blueprints.get('k8s_node')!
    const rows = async () => (await hub.db.query<{ key: string; derived_at: Date }>(`SELECT key, derived_at FROM derived WHERE blueprint = 'k8s_node' ORDER BY key`)).rows
    const save = (next: typeof spec) => hub.blueprints.save(next, origin, 'test', (bp, field) => hub.entities.valuesOf(bp, field))
    await settle()
    const before = await rows()
    const shaped = hub.blueprints.shapedAt('k8s_node')
    // A new description, a field's title and format, a relation's title: how the model reads, never what a row holds.
    const [name, def] = Object.entries(spec.fields).find(([, f]) => f.type === 'number')!
    const [rel, relDef] = Object.entries(spec.relations)[0]!
    const reworded = { ...spec, description: 'Reworded.', fields: { ...spec.fields, [name]: { ...def, title: 'Reworded', format: { kind: 'currency' as const, currency: 'USD' } } }, relations: { ...spec.relations, [rel]: { ...relDef, title: 'Reworded' } } }
    expect((await save(reworded)).updatedAt).not.toBe(_at)
    expect(hub.blueprints.shapedAt('k8s_node')).toBe(shaped)
    expect(await queued()).toEqual([])
    // Every stored row is still current: a grid reads them as they are, and derives none of them for the read.
    expect((await json<EntitiesResponse>(await session('/v1/entities?blueprint=k8s_node'))).total).toBe(before.length)
    expect(await queued()).toEqual([])
    expect(await rows()).toEqual(before)
    // Another hub reading the model from the database keeps the same moment.
    await hub.blueprints.load()
    expect(hub.blueprints.shapedAt('k8s_node')).toBe(shaped)
    // A calculation is what a row holds: every row of the blueprint is derived again.
    await save({ ...reworded, fields: { ...reworded.fields, doubled: { type: 'number', calculation: `${name} * 2` } } })
    expect(hub.blueprints.shapedAt('k8s_node')).toBeGreaterThan(shaped!)
    expect(await queued()).toEqual(expect.arrayContaining(before.map((r) => `k8s_node:${r.key}`)))
    await settle()
    const n1 = (await stored('k8s_node', 'home/n1'))!
    expect(n1.fields.doubled).toBe(Number(n1.fields[name]) * 2)
    await save(spec)
    await settle()
  })

  it('charges a batch to its blueprints by what their rows read, not by how many rows they are', async () => {
    const noted = new Map<string, { rows: number; ms: number }>()
    const load = (hub.deriver as unknown as { load: { note: (kind: string, name: string, add: { rows?: number; ms?: number }) => void } }).load
    const note = load.note
    load.note = (kind, name, add) => {
      if (kind !== 'derive' || add.ms === undefined) return
      const was = noted.get(name) ?? { rows: 0, ms: 0 }
      noted.set(name, { rows: was.rows + (add.rows ?? 0), ms: was.ms + add.ms })
    }
    try {
      const nodes = (await hub.db.query<{ blueprint: string; key: string }>(`SELECT blueprint, key FROM entities WHERE blueprint = 'k8s_node' AND state <> 'deleted'`)).rows
      // The cluster reads every node it holds; each node reads its cluster alone.
      await hub.deriver.derive([...nodes, { blueprint: 'k8s_cluster', key: 'home' }], { consume: false })
    } finally {
      load.note = note
    }
    const node = noted.get('k8s_node')!
    const cluster = noted.get('k8s_cluster')!
    expect(node.rows).toBeGreaterThan(cluster.rows)
    expect(cluster.ms / cluster.rows).toBeGreaterThan(node.ms / node.rows)
  })
})

describe('what is worked out from the model', () => {
  it('is kept while the model stands, and worked out again when a blueprint changes', async () => {
    const first = hub.reader.readsFor('system')
    expect(hub.reader.readsFor('system')).toBe(first)
    expect((await session('/v1/blueprints/shelf', { method: 'PUT', ...body({ title: 'Shelf', fields: {}, relations: {} }) })).status).toBe(200)
    const again = hub.reader.readsFor('system')
    expect(again).not.toBe(first)
    expect([...(again ?? [])].sort()).toEqual([...(first ?? [])].sort())
  })
})

// Last in the file: what it pushes is left as it is.
describe('who points at an entity', () => {
  it('names who points at an entity by the layer that wins, never by a lower one it overrides', async () => {
    await snapshot([
      { blueprint: 'system', key: 'pushed-to', title: 'pushed-to' },
      { blueprint: 'system', key: 'moved-to', title: 'moved-to' },
      { blueprint: 'k8s_namespace', key: 'home/layers', title: 'layers', relations: { cluster: 'home', system: 'pushed-to' } },
    ], 'layers')
    const moved = await session('/v1/entities/k8s_namespace/home%2Flayers', { method: 'PATCH', ...body({ relations: { system: 'moved-to' } }) })
    expect(moved.status).toBe(200)
    const ends = await hub.reader.incomingFor([{ blueprint: 'system', key: 'pushed-to' }, { blueprint: 'system', key: 'moved-to' }])
    expect(ends.get('system:pushed-to')!.map((e) => e.target.key)).toEqual([])
    expect(ends.get('system:moved-to')!.map((e) => [e.target.key, e.layer])).toEqual([['home/layers', 'ui']])
  })

  it('reads only the links a path steps along, never every link into the entity it steps from', async () => {
    // The cluster counts its nodes and its namespaces; links into it through any other relation are none of its business.
    const reads = vi.spyOn(hub.reader, 'incomingFor')
    try {
      await hub.deriver.enqueue(hub.db, [{ blueprint: 'k8s_cluster', key: 'home' }])
      await hub.deriver.drain()
      expect(reads.mock.calls.filter(([refs]) => refs.some((r) => r.blueprint === 'k8s_cluster' && r.key === 'home'))).toEqual([])
    } finally {
      reads.mockRestore()
    }
    expect((await stored('k8s_cluster', 'home'))!.fields).toMatchObject({ nodes: expect.any(Number), namespaces: expect.any(Number) })
  })
})
