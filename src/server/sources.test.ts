import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Change, Entity, Source } from '../shared/model.ts'
import { loadConfig } from './config.ts'
import { loadFixtureCatalog } from './fixtures/load.ts'
import { createHub, type Hub } from './hub.ts'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://orrery:orrery@localhost:5433/orrery'

let hub: Hub
let shop = ''
let other = ''
let manager = ''

const as = (email: string, groups = 'User') => (path: string, init?: RequestInit): Promise<Response> => Promise.resolve(hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', 'x-forwarded-email': email, 'x-forwarded-groups': groups, ...init?.headers } }, { surface: 'session' }))
const admin = as('local@example.org', 'Admin')
const machine = (bearer: string) => (path: string, init?: RequestInit) => Promise.resolve(hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}`, ...init?.headers } }, { surface: 'machine' }))
const json = async <T = Record<string, unknown>>(r: Response): Promise<T> => (await r.json()) as T
const body = (v: unknown) => ({ body: JSON.stringify(v) })
const spec = { title: 'Shop', class: 'pusher', blueprints: ['*'], deleteGrant: [], cadence: null }
const source = async (id: string) => (await json<{ source: Source }>(await admin(`/v1/sources/${id}`))).source
const changes = async (id: string) => (await json<{ changes: Change[] }>(await admin(`/v1/changes?kind=source.changed,access.refused&limit=50`))).changes.filter((ch) => ch.source === id || (ch.detail as { path?: string }).path?.includes(id))
const restored = async (key: string) => (await hub.db.query<{ detail: Record<string, unknown> }>(`SELECT detail FROM changes WHERE kind = 'entity.restored' AND blueprint = 'system' AND key = $1 ORDER BY at DESC LIMIT 1`, [key])).rows[0]?.detail
const action = { title: 'Build', backend: { type: 'webhook', url: 'https://hooks.example.org/build', method: 'POST' } }

beforeAll(async () => {
  const config = loadConfig({ DATABASE_URL, DATA_DIR: mkdtempSync(join(tmpdir(), 'orrery-')), AUTH_MODE: 'proxy' })
  hub = await createHub(config, 'test', { reset: true })
  expect((await loadFixtureCatalog(hub)).errors).toEqual([])
  await hub.sources.save('shop', spec)
  await hub.sources.save('other', { ...spec, title: 'Other' })
  shop = (await hub.sources.issueToken('source', 'shop', { source: 'shop' })).token
  other = (await hub.sources.issueToken('source', 'other', { source: 'other' })).token
  const by = { admin: true, permissions: [] as never[], kind: 'user' as const, name: 'local', roles: [] }
  await hub.access.saveRole('keeper', { title: 'Keeper', permissions: ['sources.manage'] }, by)
  manager = (await hub.sources.issueToken('access', 'keeper', { role: 'keeper' })).token
})

afterAll(async () => {
  await hub.close()
})

describe('what a source acts for', () => {
  it('is set and cleared by an admin, shape checked only, with an activity row each time', async () => {
    expect((await source('shop')).actsFor).toBeNull()
    const bad = await admin('/v1/sources/shop', { method: 'PUT', ...body({ ...spec, actsFor: 'no colon' }) })
    expect(bad.status).toBe(400)
    // The hub never asks whether the blueprint exists: what it means is the user's.
    const set = await admin('/v1/sources/shop', { method: 'PUT', ...body({ ...spec, actsFor: 'made_up:github/o/shop' }) })
    expect(set.status).toBe(200)
    expect((await json<Source>(set)).actsFor).toBe('made_up:github/o/shop')
    expect((await changes('shop')).find((ch) => ch.kind === 'source.changed')?.detail).toMatchObject({ actsFor: 'made_up:github/o/shop' })
    // A save that leaves it out keeps it, and changes nothing.
    const before = (await changes('shop')).length
    await admin('/v1/sources/shop', { method: 'PUT', ...body(spec) })
    expect((await source('shop')).actsFor).toBe('made_up:github/o/shop')
    expect((await changes('shop')).length).toBe(before)
    await admin('/v1/sources/shop', { method: 'PUT', ...body({ ...spec, actsFor: null }) })
    expect((await source('shop')).actsFor).toBeNull()
    expect((await changes('shop'))[0]!.detail).toMatchObject({ actsFor: null })
  })

  it('is refused to anyone but an admin, who may still save the rest', async () => {
    const keeper = machine(manager)
    const refused = await keeper('/v1/sources/shop', { method: 'PUT', ...body({ ...spec, actsFor: 'service:shop' }) })
    expect(refused.status).toBe(403)
    expect((await keeper('/v1/sources/shop', { method: 'PUT', ...body({ ...spec, actions: true }) })).status).toBe(403)
    const kept = await keeper('/v1/sources/shop', { method: 'PUT', ...body({ ...spec, description: 'The shop', actsFor: null, actions: false }) })
    expect(kept.status).toBe(200)
    expect((await source('shop')).description).toBe('The shop')
  })
})

describe('actions from a source', () => {
  it('are refused without the grant, and recorded', async () => {
    const r = await machine(shop)('/v1/actions/shop_build', { method: 'PUT', ...body(action) })
    expect(r.status).toBe(403)
    expect((await changes('shop_build')).find((ch) => ch.kind === 'access.refused')).toMatchObject({ outcome: 'refused', actorKind: 'source', source: 'shop' })
  })

  it('are the source own with the grant: origin, ledger, and nobody else may put or remove them', async () => {
    await admin('/v1/sources/shop', { method: 'PUT', ...body({ ...spec, actions: true }) })
    await admin('/v1/sources/other', { method: 'PUT', ...body({ ...spec, title: 'Other', actions: true }) })
    const put = await machine(shop)('/v1/actions/shop_build', { method: 'PUT', ...body(action) })
    expect(put.status).toBe(200)
    expect((await json(put)).origin).toEqual({ kind: 'source', source: 'shop' })
    expect((await json(await admin('/v1/actions/shop_build'))).origin).toEqual({ kind: 'source', source: 'shop' })
    expect((await source('shop')).writes.actions.map((a) => a.id)).toEqual(['shop_build'])
    // A source sets no access: that is an admin's.
    expect((await machine(shop)('/v1/actions/shop_build', { method: 'PUT', ...body({ ...action, access: { everyone: true } }) })).status).toBe(403)
    expect((await machine(other)('/v1/actions/shop_build', { method: 'PUT', ...body(action) })).status).toBe(409)
    expect((await machine(other)('/v1/actions/shop_build', { method: 'DELETE' })).status).toBe(403)
    // Its token still reads nothing else under /api.
    expect((await machine(shop)('/v1/actions')).status).toBe(403)
    expect((await machine(shop)('/v1/actions/layout', { method: 'PUT', ...body({ order: [] }) })).status).toBe(403)
    expect((await machine(shop)('/v1/actions/shop_build', { method: 'DELETE' })).status).toBe(200)
    expect((await admin('/v1/actions/shop_build')).status).toBe(404)
  })

  it('stop when an admin takes the grant away', async () => {
    await admin('/v1/sources/shop', { method: 'PUT', ...body({ ...spec, actions: false }) })
    expect((await machine(shop)('/v1/actions/shop_build', { method: 'PUT', ...body(action) })).status).toBe(403)
  })
})

describe('a link two sources write', () => {
  it('is kept once for each, read once, and leaves with the source that is removed', async () => {
    for (const id of ['left', 'right']) await hub.sources.save(id, { ...spec, title: id })
    const left = machine((await hub.sources.issueToken('source', 'left', { source: 'left' })).token)
    const right = machine((await hub.sources.issueToken('source', 'right', { source: 'right' })).token)
    const systems = async () => (await json<Entity>(await admin('/v1/entities/azure_resource_group/rg-shared'))).relations.system?.map((r) => r.key)
    expect((await left('/v1/ingest/entities/system/billing', { method: 'PUT', ...body({ title: 'Billing' }) })).ok).toBe(true)
    expect((await left('/v1/ingest/entities/azure_resource_group/rg-shared', { method: 'PUT', ...body({ title: 'rg-shared', relations: { system: 'billing' } }) })).ok).toBe(true)
    // The second source names the same link on an entity it does not own: its write lands, beside the first one's.
    expect((await right('/v1/ingest/entities/azure_resource_group/rg-shared', { method: 'PATCH', ...body({ relations: { system: 'billing' } }) })).ok).toBe(true)
    expect(await systems()).toEqual(['billing'])
    // Each source drops only its own copy: the link stays while the other still holds it.
    expect((await left('/v1/ingest/entities/azure_resource_group/rg-shared', { method: 'PATCH', ...body({ relations: { system: null } }) })).ok).toBe(true)
    expect(await systems()).toEqual(['billing'])
    // A source that is removed takes its links with it.
    expect((await admin('/v1/sources/right', { method: 'DELETE' })).status).toBe(200)
    expect(await systems()).toBeUndefined()
  })

  it('moves to the receiver on a hand-over, even where the receiver holds the same link', async () => {
    for (const id of ['giver', 'taker']) await hub.sources.save(id, { ...spec, title: id })
    const giver = machine((await hub.sources.issueToken('source', 'giver', { source: 'giver' })).token)
    const taker = machine((await hub.sources.issueToken('source', 'taker', { source: 'taker' })).token)
    expect((await giver('/v1/ingest/entities/system/ledger', { method: 'PUT', ...body({ title: 'Ledger' }) })).ok).toBe(true)
    expect((await giver('/v1/ingest/entities/azure_resource_group/rg-handed', { method: 'PUT', ...body({ title: 'rg-handed', relations: { system: 'ledger' } }) })).ok).toBe(true)
    expect((await taker('/v1/ingest/entities/azure_resource_group/rg-handed', { method: 'PATCH', ...body({ relations: { system: 'ledger' } }) })).ok).toBe(true)
    expect(await hub.sources.handOver('giver', 'taker')).toMatchObject({ entities: 2 })
    expect((await json<Entity>(await admin('/v1/entities/azure_resource_group/rg-handed'))).relations.system?.map((r) => r.key)).toEqual(['ledger'])
  })

  it('is people\'s to keep once its source hands its entities to them', async () => {
    await hub.sources.save('copier', { ...spec, title: 'copier' })
    const copier = machine((await hub.sources.issueToken('source', 'copier', { source: 'copier' })).token)
    expect((await copier('/v1/ingest/entities/system/payroll', { method: 'PUT', ...body({ title: 'Payroll' }) })).ok).toBe(true)
    expect((await copier('/v1/ingest/entities/azure_resource_group/rg-kept', { method: 'PUT', ...body({ title: 'rg-kept', fields: { location: 'eastus' }, relations: { system: 'payroll' } }) })).ok).toBe(true)
    const handed = await admin('/v1/sources/copier/hand-over', { method: 'POST', ...body({ to: 'ui' }) })
    expect(await json(handed)).toMatchObject({ entities: 2, relations: 1 })
    const kept = await json<Entity>(await admin('/v1/entities/azure_resource_group/rg-kept'))
    expect(kept.fields.location).toBe('eastus')
    const row = await hub.db.query<{ owner: string; ui: Record<string, { value: unknown }>; pushed: Record<string, unknown> }>(`SELECT owner, ui, pushed FROM entities WHERE blueprint = 'azure_resource_group' AND key = 'rg-kept'`)
    expect(row.rows[0]).toMatchObject({ owner: 'ui', ui: { location: { value: 'eastus' } }, pushed: {} })
    expect(kept.relations.system?.map((r) => r.key)).toEqual(['payroll'])
    // It owns nothing now, so it is removed and takes nothing with it.
    expect((await admin('/v1/sources/copier', { method: 'DELETE' })).status).toBe(200)
    const after = await json<Entity>(await admin('/v1/entities/azure_resource_group/rg-kept'))
    expect(after.state).toBe('active')
    expect(after.relations.system?.map((r) => r.key)).toEqual(['payroll'])
  })

  it('brings back what its source had stopped seeing when it hands its entities to people', async () => {
    await hub.sources.save('lister', { ...spec, title: 'lister' })
    const lister = machine((await hub.sources.issueToken('source', 'lister', { source: 'lister' })).token)
    const list = async (keys: string[]) => {
      const run = await json<{ id: string }>(await lister('/v1/ingest/runs', { method: 'POST', ...body({ mode: 'snapshot', scope: 'list' }) }))
      if (keys.length) expect((await lister(`/v1/ingest/runs/${run.id}/entities`, { method: 'PUT', ...body({ entities: keys.map((key) => ({ blueprint: 'system', key, title: key })) }) })).ok).toBe(true)
      return json<{ massDrop: boolean }>(await lister(`/v1/ingest/runs/${run.id}/commit`, { method: 'POST' }))
    }
    await list(['ledger-a', 'ledger-b', 'ledger-c'])
    // Its last run saw nothing of the list, as a source does once what it reads is gone.
    expect((await list([])).massDrop).toBe(true)
    expect((await json<Entity>(await admin('/v1/entities/system/ledger-a'))).state).toBe('missing')
    expect((await admin('/v1/sources/lister/hand-over', { method: 'POST', ...body({ to: 'ui' }) })).ok).toBe(true)
    const row = await hub.db.query<{ state: string; owner: string; grace_until: Date | null; missing_since: Date | null }>(`SELECT state, owner, grace_until, missing_since FROM entities WHERE blueprint = 'system' AND key LIKE 'ledger-%'`)
    expect(row.rows).toHaveLength(3)
    for (const r of row.rows) expect(r).toEqual({ state: 'active', owner: 'ui', grace_until: null, missing_since: null })
    expect(await restored('ledger-a')).toMatchObject({ previous: 'missing', handedFrom: 'lister' })
  })

  it('brings back a missing entity people keep on the next pass, and never deletes it', async () => {
    await hub.db.query(`UPDATE entities SET state = 'missing', missing_since = now() - interval '30 days', missing_runs = 9 WHERE blueprint = 'system' AND key = 'ledger-b'`)
    await hub.runs.tick(90, 30, 60)
    const row = await hub.db.query<{ state: string; missing_runs: number }>(`SELECT state, missing_runs FROM entities WHERE blueprint = 'system' AND key = 'ledger-b'`)
    expect(row.rows[0]).toEqual({ state: 'active', missing_runs: 0 })
    expect(await restored('ledger-b')).toMatchObject({ previous: 'missing', reason: 'kept by people' })
  })
})
