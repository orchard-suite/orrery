import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Source } from '../shared/model.ts'
import { loadConfig } from './config.ts'
import { createHub, type Hub } from './hub.ts'
import { createLogger } from './log.ts'
import { Writes } from './writes.ts'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://orrery:orrery@localhost:5433/orrery'

let hub: Hub
let token = ''

const admin = (path: string, init?: RequestInit) => Promise.resolve(hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', 'x-forwarded-email': 'local@example.org', 'x-forwarded-groups': 'Admin', ...init?.headers } }, { surface: 'session' }))
const push = (path: string, init?: RequestInit) => Promise.resolve(hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...init?.headers } }, { surface: 'machine' }))
const body = (v: unknown) => ({ body: JSON.stringify(v) })
const writesOf = async (id: string) => ((await (await admin(`/v1/sources/${id}`)).json()) as { source: Source }).source.writes
const listed = async (id: string) => ((await (await admin('/v1/sources')).json()) as { sources: Source[] }).sources.find((s) => s.id === id)!.writes

beforeAll(async () => {
  const config = loadConfig({ DATABASE_URL, DATA_DIR: mkdtempSync(join(tmpdir(), 'orrery-')), AUTH_MODE: 'proxy' })
  hub = await createHub(config, 'test', { reset: true })
  await hub.sources.save('shop', { title: 'Shop', class: 'pusher', blueprints: ['app', 'host'], deleteGrant: [], cadence: null })
  token = (await hub.sources.issueToken('source', 'shop', { source: 'shop' })).token
})

afterAll(async () => {
  await hub.close()
})

describe('what a source wrote', () => {
  it('starts empty', async () => {
    expect(await writesOf('shop')).toEqual({ entities: [], blueprints: [], actions: [], scorecards: [] })
  })

  it('keeps each blueprint it offered and the hub took, changed or not, and none it refused', async () => {
    const offer = { blueprints: [{ id: 'app', title: 'App', fields: {} }, { id: 'host', title: 'Host', fields: {} }, { id: 'secret_thing', title: 'Not mine', fields: {} }] }
    expect((await push('/v1/ingest/blueprints', { method: 'PUT', ...body(offer) })).status).toBe(207)
    await push('/v1/ingest/blueprints', { method: 'PUT', ...body({ blueprints: [{ id: 'app', title: 'App', fields: {} }] }) })
    expect((await writesOf('shop')).blueprints.map((b) => b.id)).toEqual(['app', 'host'])
  })

  it('counts every accepted entity write by blueprint, single or in a run, and no refused one', async () => {
    await push('/v1/ingest/entities/app/a', { method: 'PUT', ...body({ title: 'A' }) })
    await push('/v1/ingest/entities/app/a', { method: 'PATCH', ...body({ title: 'A' }) })
    const run = (await (await push('/v1/ingest/runs', { method: 'POST', ...body({ mode: 'snapshot', scope: 'all' }) })).json()) as { id: string }
    const batch = await push(`/v1/ingest/runs/${run.id}/entities`, { method: 'PUT', ...body({ entities: [{ blueprint: 'host', key: 'h1' }, { blueprint: 'host', key: 'h2' }, { blueprint: 'app', key: 'b' }, { blueprint: 'nope', key: 'x' }] }) })
    expect(batch.status).toBe(207)
    expect((await push('/v1/ingest/entities/nope/x', { method: 'PUT', ...body({}) })).status).not.toBe(200)
    const w = await writesOf('shop')
    expect(w.entities.map(({ blueprint, count }) => ({ blueprint, count }))).toEqual([
      { blueprint: 'app', count: 3 },
      { blueprint: 'host', count: 2 },
    ])
    expect(Date.parse(w.entities[0]!.lastAt)).toBeGreaterThan(Date.now() - 60_000)
    expect(await listed('shop')).toEqual(w)
  })

  it('is stored, and read back by a hub that starts again', async () => {
    await hub.writes.flush()
    const fresh = new Writes(hub.db, createLogger('writes'))
    await fresh.load()
    expect(fresh.of('shop')).toEqual(await writesOf('shop'))
  })

  it('is filled in from the change history of what a source did before the ledger', async () => {
    // A hub from before the ledger: nothing in it, and never filled.
    await hub.db.query(`DELETE FROM source_writes`)
    await hub.db.query(`DELETE FROM settings WHERE key = 'writes.filled'`)
    await hub.sources.save('old', { title: 'Old', class: 'pusher', blueprints: ['*'], deleteGrant: [], cadence: null })
    const at = new Date('2026-01-02T03:04:05Z')
    await hub.db.query(
      `INSERT INTO changes (at, kind, blueprint, key, source, detail, outcome) VALUES
       ($1, 'entity.created', 'host', 'a', 'old', '{}', 'ok'),
       ($1, 'entity.updated', 'host', 'a', 'old', '{}', 'ok'),
       ($1, 'blueprint.changed', 'host', NULL, 'old', '{}', 'ok'),
       ($1, 'action.changed', NULL, NULL, 'old', '{"action":"reboot"}', 'ok'),
       ($1, 'scorecard.changed', NULL, NULL, 'old', '{"scorecard":"secure"}', 'ok'),
       ($1, 'entity.created', 'host', 'b', 'old', '{}', 'refused'),
       ($1, 'entity.created', 'host', 'c', 'nobody', '{}', 'ok')`,
      [at],
    )
    const fresh = new Writes(hub.db, createLogger('writes'))
    await fresh.load()
    const lastAt = at.toISOString()
    expect(fresh.of('old')).toEqual({ entities: [{ blueprint: 'host', count: 2, lastAt }], blueprints: [{ id: 'host', lastAt }], actions: [{ id: 'reboot', lastAt }], scorecards: [{ id: 'secure', lastAt }] })
    expect(fresh.of('nobody')).toEqual({ entities: [], blueprints: [], actions: [], scorecards: [] })
    // Filled once: what the history holds later is not read again, since every write since is noted as it lands.
    await hub.db.query(`INSERT INTO changes (at, kind, blueprint, key, source, detail, outcome) VALUES ($1, 'entity.updated', 'host', 'a', 'old', '{}', 'ok')`, [at])
    await fresh.load()
    expect(fresh.of('old').entities).toEqual([{ blueprint: 'host', count: 2, lastAt }])
  })

  it('is not filled in from the history when it already holds writes', async () => {
    await hub.db.query(`DELETE FROM settings WHERE key = 'writes.filled'`)
    await hub.db.query(`INSERT INTO changes (at, kind, blueprint, key, source, detail, outcome) VALUES (now(), 'entity.created', 'app', 'late', 'old', '{}', 'ok')`)
    const fresh = new Writes(hub.db, createLogger('writes'))
    await fresh.load()
    expect(fresh.of('old').entities.map((e) => e.blueprint)).toEqual(['host'])
    expect((await hub.db.query(`SELECT 1 FROM settings WHERE key = 'writes.filled'`)).rowCount).toBe(1)
  })

  it('goes with its source', async () => {
    await hub.sources.save('gone', { title: 'Gone', class: 'pusher', blueprints: ['*'], deleteGrant: [], cadence: null })
    await hub.writes.note('gone', 'action', new Map([['x', 1]]))
    await hub.writes.flush()
    expect((await writesOf('gone')).actions).toHaveLength(1)
    expect((await admin('/v1/sources/gone', { method: 'DELETE' })).status).toBe(200)
    const left = await hub.db.query(`SELECT 1 FROM source_writes WHERE source = 'gone'`)
    expect(left.rowCount).toBe(0)
  })
})
