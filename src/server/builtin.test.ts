import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { isSpread, type Blueprint } from '../shared/model.ts'
import { loadConfig } from './config.ts'
import { createHub, type Hub } from './hub.ts'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://orrery:orrery@localhost:5433/orrery'
const config = loadConfig({ DATABASE_URL, DATA_DIR: mkdtempSync(join(tmpdir(), 'orrery-')), AUTH_MODE: 'none' })

let hub: Hub

const session = (path: string, init?: RequestInit) => hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', ...init?.headers } }, { surface: 'session' })
const machine = (path: string, bearer: string, init?: RequestInit) => hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}`, ...init?.headers } }, { surface: 'machine' })
const json = async <T = Record<string, unknown>>(r: Response): Promise<T> => (await r.json()) as T
const body = (v: unknown) => ({ body: JSON.stringify(v) })
const ids = async () => (await json<{ blueprints: Blueprint[] }>(await session('/v1/blueprints'))).blueprints.map((b) => b.id)

/** A second start of the hub on the same database. */
async function restart(): Promise<void> {
  await hub.close()
  hub = await createHub(config, 'test')
}

beforeAll(async () => {
  hub = await createHub(config, 'test', { reset: true })
})

afterAll(async () => {
  await hub.close()
})

describe('a fresh hub', () => {
  it('holds only its own blueprints', async () => {
    expect((await ids()).sort()).toEqual(['orrery_report', 'orrery_report_edition', 'orrery_runner', 'orrery_schedule', 'orrery_source'])
  })

  it('counts no source list of blueprints under the grid', async () => {
    const { blueprints } = await json<{ blueprints: Blueprint[] }>(await session('/v1/blueprints'))
    expect(isSpread(blueprints.find((b) => b.id === 'orrery_source')!.fields.blueprints)).toBe(false)
  })

  it('keeps the orrery_ prefix for itself', async () => {
    expect((await session('/v1/blueprints/orrery_thing', { method: 'PUT', ...body({ title: 'Thing' }) })).status).toBe(400)
    expect((await session('/v1/blueprints/orrery_source', { method: 'PUT', ...body({ title: 'Mine now' }) })).status).toBe(400)
    expect((await session('/v1/blueprints/orrery_source', { method: 'DELETE' })).status).toBe(400)
    expect(hub.blueprints.get('orrery_source')?.title).toBe('Source')
  })

  it('keeps a blueprint a person made across a restart, and never brings it back once deleted', async () => {
    const made = await session('/v1/blueprints/service', { method: 'PUT', ...body({ title: 'Service', fields: { cost_centre: { type: 'string' } } }) })
    expect(made.status).toBe(200)
    await restart()
    expect(Object.keys(hub.blueprints.get('service')?.fields ?? {})).toEqual(['cost_centre'])
    expect((await session('/v1/blueprints/service', { method: 'DELETE' })).status).toBe(200)
    await restart()
    expect(await ids()).not.toContain('service')
  })
})

describe('a pusher bringing its blueprints', () => {
  const offered = (parse(readFileSync(join(import.meta.dirname, '../../cmd/pusher-k8s/blueprints.yaml'), 'utf8')) as { blueprints: { id: string }[] }).blueprints
  const offer = (token: string, blueprints: unknown[]) => machine('/v1/ingest/blueprints', token, { method: 'PUT', ...body({ blueprints }) })

  it('creates what is missing, then adds only what an existing blueprint lacks', async () => {
    await hub.sources.save('k8s@lab', { title: 'k8s lab', class: 'pusher', blueprints: offered.map((b) => b.id), deleteGrant: [], cadence: '3m' })
    const token = (await hub.sources.issueToken('source', 'lab', { source: 'k8s@lab' })).token
    const first = await offer(token, offered)
    expect(first.status).toBe(200)
    expect((await json<{ created: string[] }>(first)).created.sort()).toEqual(offered.map((b) => b.id).sort())
    expect(hub.blueprints.get('k8s_pod')?.origin).toEqual({ kind: 'source', source: 'k8s@lab' })

    const mine = await session('/v1/blueprints/k8s_cluster', { method: 'PUT', ...body({ title: 'Cluster', fields: { region: { type: 'string' } } }) })
    expect(mine.status).toBe(200)
    // The edit dropped the pusher's fields. The next offer puts back what is missing and changes nothing that is there.
    const second = await json<{ created: string[]; extended: string[]; kept: string[] }>(await offer(token, offered))
    expect(second.created).toEqual([])
    expect(second.extended).toEqual(['k8s_cluster'])
    expect(second.kept).toHaveLength(offered.length - 1)
    expect(hub.blueprints.get('k8s_cluster')).toMatchObject({ title: 'Cluster', origin: { kind: 'ui' }, fields: { region: { type: 'string' }, version: { type: 'string' } } })
    const third = await json<{ extended: string[]; kept: string[] }>(await offer(token, offered))
    expect(third.extended).toEqual([])
    expect(third.kept).toHaveLength(offered.length)
  })

  it('adds the values an existing enum lacks, after its own, and keeps every value written', async () => {
    await hub.sources.save('kinds', { title: 'kinds', class: 'pusher', blueprints: ['gadget'], deleteGrant: [], cadence: null })
    const token = (await hub.sources.issueToken('source', 'kinds', { source: 'kinds' })).token
    const mine = await session('/v1/blueprints/gadget', { method: 'PUT', ...body({ title: 'Gadget', fields: { kind: { type: 'enum', values: ['rest', 'local'], chip: true } } }) })
    expect(mine.status).toBe(200)
    expect((await machine('/v1/ingest/entities/gadget/a', token, { method: 'PUT', ...body({ fields: { kind: 'local' } }) })).ok).toBe(true)
    const res = await json<{ extended: string[] }>(await offer(token, [{ id: 'gadget', title: 'Gadget', fields: { kind: { type: 'enum', values: ['rest', 'mcp'] } } }]))
    expect(res.extended).toEqual(['gadget'])
    expect(hub.blueprints.get('gadget')?.fields.kind).toEqual({ type: 'enum', values: ['rest', 'local', 'mcp'], chip: true })
    expect((await machine('/v1/ingest/entities/gadget/b', token, { method: 'PUT', ...body({ fields: { kind: 'mcp' } }) })).ok).toBe(true)
    const again = await json<{ extended: string[]; kept: string[] }>(await offer(token, [{ id: 'gadget', title: 'Gadget', fields: { kind: { type: 'enum', values: ['rest', 'mcp'] } } }]))
    expect(again).toMatchObject({ extended: [], kept: ['gadget'] })
  })

  it('refuses a blueprint the source is not registered for', async () => {
    await hub.sources.save('narrow', { title: 'narrow', class: 'pusher', blueprints: ['vm'], deleteGrant: [], cadence: null })
    const token = (await hub.sources.issueToken('source', 'narrow', { source: 'narrow' })).token
    const res = await offer(token, [{ id: 'vm', title: 'VM' }, { id: 'database', title: 'Database' }])
    expect(res.status).toBe(207)
    expect(await json(res)).toMatchObject({ created: ['vm'], rejected: [{ blueprint: 'database' }] })
    expect(hub.blueprints.get('database')).toBeUndefined()
  })
})

describe('version 1 of the API', () => {
  it('serves reads and pusher writes under /v1, and nothing under the unversioned paths', async () => {
    expect((await session('/v1/blueprints')).status).toBe(200)
    await hub.sources.save('v1-pusher', { title: 'v1', class: 'pusher', blueprints: ['widget'], deleteGrant: [], cadence: null })
    const token = (await hub.sources.issueToken('source', 'v1', { source: 'v1-pusher' })).token
    expect((await machine('/v1/ingest/blueprints', token, { method: 'PUT', ...body({ blueprints: [{ id: 'widget', title: 'Widget' }] }) })).status).toBe(200)
    expect((await machine('/v1/ingest/entities/widget/a', token, { method: 'PUT', ...body({ title: 'A' }) })).ok).toBe(true)
    expect((await session('/v1/entities/widget/a')).status).toBe(200)
    expect((await session('/v1/nothing-here')).status).toBe(404)
    expect((await machine('/ingest/heartbeat', token, { method: 'POST' })).status).toBe(404)
    expect((await machine('/api/blueprints', token)).status).toBe(404)
  })
})

describe('a hub upgraded from the built-in catalog', () => {
  it('hands the catalog to the web app and moves sources and runners to their reserved ids', async () => {
    const origin = JSON.stringify({ kind: 'git', source: 'builtin', file: 'core.yaml' })
    await hub.db.query(`INSERT INTO sources (id, spec) VALUES ('builtin', $1)`, [JSON.stringify({ title: 'Built-in catalog', class: 'git', blueprints: ['*'], deleteGrant: ['*'], cadence: null, git: { url: '/app/catalog', branch: 'local', glob: '**/*.yaml' } })])
    await hub.db.query(`INSERT INTO blueprints (id, spec, origin) VALUES ('source', $1, $3), ('system', $2, $3)`, [
      JSON.stringify({ id: 'source', title: 'Source', fields: { notes: { type: 'markdown' } }, relations: {} }),
      JSON.stringify({ id: 'system', title: 'System', fields: {}, relations: { fed_by: { target: 'source' } } }),
      origin,
    ])
    await hub.db.query(`INSERT INTO entities (blueprint, key, title, owner) VALUES ('source', 'legacy', 'Legacy pusher', 'hub')`)
    await restart()

    expect(hub.sources.get('builtin')).toBeUndefined()
    expect(hub.blueprints.get('source')).toBeUndefined()
    expect(hub.blueprints.get('system')).toMatchObject({ origin: { kind: 'ui' }, relations: { fed_by: { target: 'orrery_source' } } })
    const moved = await hub.db.query(`SELECT blueprint FROM entities WHERE key = 'legacy'`)
    expect(moved.rows).toEqual([{ blueprint: 'orrery_source' }])
    expect((await session('/v1/blueprints/system', { method: 'PUT', ...body({ title: 'Product' }) })).status).toBe(200)
  })
})
