import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadConfig } from './config.ts'
import { createHub, type Hub } from './hub.ts'

// How long what is gone stays: tombstones by blueprint, what a source pushed
// from an entity it deleted, and the run history.

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://orrery:orrery@localhost:5433/orrery'

let hub: Hub
let token = ''

const session = (path: string, init?: RequestInit) => hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', ...init?.headers } }, { surface: 'session' })
const machine = (path: string, init?: RequestInit) => hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...init?.headers } }, { surface: 'machine' })
const body = (v: unknown) => ({ body: JSON.stringify(v) })
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000)

async function put(blueprint: string, key: string, relations: Record<string, string> = {}): Promise<void> {
  const res = await machine(`/v1/ingest/entities/${blueprint}/${key}`, { method: 'PUT', ...body({ title: key, relations }) })
  expect([200, 201], await res.clone().text()).toContain(res.status)
}
/** Deletes entities as a committed snapshot would, then dates the tombstones `days` back. */
async function deleteDaysAgo(refs: { blueprint: string; key: string }[], days: number): Promise<void> {
  await hub.entities.tombstone(refs, 'estate', null, {}, false)
  for (const r of refs) await hub.db.query('UPDATE entities SET deleted_at = $3 WHERE blueprint = $1 AND key = $2', [r.blueprint, r.key, daysAgo(days)])
}
const state = async (blueprint: string, key: string) => (await hub.db.query<{ state: string }>('SELECT state FROM entities WHERE blueprint = $1 AND key = $2', [blueprint, key])).rows[0]?.state ?? 'purged'
const links = async (blueprint: string, key: string) => (await hub.db.query<{ layer: string }>('SELECT layer FROM relations WHERE blueprint = $1 AND key = $2', [blueprint, key])).rows.map((r) => r.layer)

beforeAll(async () => {
  hub = await createHub(loadConfig({ DATABASE_URL, DATA_DIR: mkdtempSync(join(tmpdir(), 'orrery-')), AUTH_MODE: 'none' }), 'test', { reset: true })
  await hub.sources.save('estate', { title: 'estate', class: 'pusher', blueprints: ['*'], deleteGrant: [], cadence: null })
  token = (await hub.sources.issueToken('source', 'estate', { source: 'estate' })).token
  expect((await session('/v1/blueprints/shelf', { method: 'PUT', ...body({ title: 'Shelf', fields: {}, relations: {} }) })).status).toBe(200)
  expect((await session('/v1/blueprints/pod', { method: 'PUT', ...body({ title: 'Pod', lifecycle: { keepDeleted: '1d' }, fields: {}, relations: { shelf: { target: 'shelf' } } }) })).status).toBe(200)
})

afterAll(async () => {
  await hub.close()
})

describe('keeping what was deleted', () => {
  it('refuses a keep time that is not a duration', async () => {
    const res = await session('/v1/blueprints/pod', { method: 'PUT', ...body({ title: 'Pod', lifecycle: { keepDeleted: 'a while' }, fields: {}, relations: {} }) })
    expect(res.status).toBe(400)
  })

  it('purges a tombstone after its own blueprint says, and others after the hub default', async () => {
    await put('shelf', 'old-shelf')
    await put('pod', 'old-pod')
    await put('pod', 'new-pod')
    await deleteDaysAgo([{ blueprint: 'shelf', key: 'old-shelf' }, { blueprint: 'pod', key: 'old-pod' }], 2)
    await deleteDaysAgo([{ blueprint: 'pod', key: 'new-pod' }], 0)
    await hub.runs.purge(90)
    expect(await state('pod', 'old-pod')).toBe('purged')
    expect(await state('pod', 'new-pod')).toBe('deleted')
    expect(await state('shelf', 'old-shelf')).toBe('deleted')
  })

  it('drops what a source pushed from an entity it deleted, and keeps what a person set', async () => {
    await put('shelf', 'top')
    await put('pod', 'gone', { shelf: 'top' })
    expect((await session('/v1/entities/pod/gone', { method: 'PATCH', ...body({ relations: { shelf: 'top' } }) })).status).toBe(200)
    expect((await links('pod', 'gone')).sort()).toEqual(['pushed', 'ui'])
    await deleteDaysAgo([{ blueprint: 'pod', key: 'gone' }], 0)
    await hub.runs.purge(90)
    expect(await state('pod', 'gone')).toBe('deleted')
    expect(await links('pod', 'gone')).toEqual(['ui'])
    // The source brings it back with its relation.
    await put('pod', 'gone', { shelf: 'top' })
    expect((await links('pod', 'gone')).sort()).toEqual(['pushed', 'ui'])
  })
})

describe('the run history', () => {
  it('removes finished runs past the keep time, and never an open one', async () => {
    const run = (id: string, state: string, days: number) => hub.db.query(`INSERT INTO runs (id, source, mode, scope, state, started_at) VALUES ($1, 'estate', 'snapshot', 'x', $2, $3)`, [id, state, daysAgo(days)])
    await run('old-done', 'committed', 40)
    await run('old-open', 'open', 40)
    await run('new-done', 'committed', 5)
    expect(await hub.runs.pruneRuns(30)).toBe(1)
    const left = (await hub.db.query<{ id: string }>(`SELECT id FROM runs WHERE id LIKE 'old-%' OR id LIKE 'new-%' ORDER BY id`)).rows.map((r) => r.id)
    expect(left).toEqual(['new-done', 'old-open'])
  })
})

describe('what a snapshot costs', () => {
  const snapshot = async (keys: string[], scope = 'racks'): Promise<void> => {
    const run = (await (await machine('/v1/ingest/runs', { method: 'POST', ...body({ mode: 'snapshot', scope }) })).json()) as { id: string }
    for (const key of keys) expect((await machine(`/v1/ingest/runs/${run.id}/entities`, { method: 'PUT', ...body({ entities: [{ blueprint: 'shelf', key, title: key }], observedAt: new Date().toISOString() }) })).status).toBe(200)
    expect((await machine(`/v1/ingest/runs/${run.id}/commit`, { method: 'POST' })).status).toBe(200)
  }
  const seen = async (key: string) => ((await (await session(`/v1/entities/shelf/${key}`)).json()) as { lastSeenAt: string | null; state: string })

  it('marks missing only what no batch of the run named, and keeps nothing of the run after', async () => {
    await snapshot(['a', 'b', 'c'])
    await snapshot(['a', 'b'])
    expect(await state('shelf', 'a')).toBe('active')
    expect(await state('shelf', 'b')).toBe('active')
    expect(await state('shelf', 'c')).toBe('missing')
    expect((await hub.db.query('SELECT 1 FROM run_seen')).rowCount).toBe(0)
  })

  it('leaves an entity that was already missing as it was, so its stored state stays current', async () => {
    const changed = async () => (await hub.db.query<{ updated_at: Date }>(`SELECT updated_at FROM entities WHERE blueprint = 'shelf' AND key = 'c'`)).rows[0]!.updated_at.getTime()
    const before = await changed()
    await snapshot(['a', 'b'])
    expect(await state('shelf', 'c')).toBe('missing')
    expect(await changed()).toBe(before)
  })

  it('writes nothing on an entity a snapshot leaves as it was', async () => {
    const version = async () => (await hub.db.query<{ v: string }>(`SELECT xmin::text AS v FROM entities WHERE blueprint = 'shelf' AND key = 'a'`)).rows[0]!.v
    const before = await version()
    await snapshot(['a', 'b'])
    expect(await version()).toBe(before)
  })

  it('says an entity the last snapshot left active was seen then, and one it missed was seen the run before', async () => {
    const before = await seen('c')
    await new Promise((r) => setTimeout(r, 20))
    await snapshot(['a', 'b'])
    const committed = (await hub.db.query<{ seen_at: Date }>(`SELECT seen_at FROM scope_seen WHERE source = 'estate' AND scope = 'racks'`)).rows[0]!.seen_at.toISOString()
    expect((await seen('a')).lastSeenAt).toBe(committed)
    expect((await seen('c')).lastSeenAt).toBe(before.lastSeenAt)
    expect(Date.parse(before.lastSeenAt!)).toBeLessThan(Date.parse(committed))
    // A grid sorts and filters on the same moment the entity shows.
    const listed = (await (await session(`/v1/entities?blueprint=shelf&filter=${encodeURIComponent(JSON.stringify({ field: 'lastSeenAt', op: 'gte', value: committed }))}`)).json()) as { entities: { key: string }[] }
    expect(listed.entities.map((e) => e.key).sort()).toEqual(['a', 'b'])
  })
})
