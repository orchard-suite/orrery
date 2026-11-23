// What a derived value reaches through a relation is only what is there: an
// entity its source no longer sees, or one that is gone, is never counted,
// mirrored, stepped through, or rolled up, and whatever read it is derived
// again when its state alone moves.

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { EntityPageResponse } from '../shared/api.ts'
import { loadConfig } from './config.ts'
import { createHub, type Hub } from './hub.ts'

// Its own database: the tests push snapshots that mark entities missing.
const DATABASE_URL = (process.env.DATABASE_URL ?? 'postgres://orrery:orrery@localhost:5433/orrery') + '_absent'

let hub: Hub
let token = ''

const session = (path: string, init?: RequestInit) => hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', ...init?.headers } }, { surface: 'session' })
const machine = (path: string, init?: RequestInit) => hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...init?.headers } }, { surface: 'machine' })
const body = (v: unknown) => ({ body: JSON.stringify(v) })

async function snapshot(scope: string, entities: unknown[]): Promise<void> {
  const run = (await (await machine('/v1/ingest/runs', { method: 'POST', ...body({ mode: 'snapshot', scope }) })).json()) as { id: string }
  expect([200, 207]).toContain((await machine(`/v1/ingest/runs/${run.id}/entities`, { method: 'PUT', ...body({ entities }) })).status)
  expect((await machine(`/v1/ingest/runs/${run.id}/commit`, { method: 'POST' })).status).toBe(200)
}

const queued = async (): Promise<number> => Number((await hub.db.query<{ n: string }>('SELECT count(*)::text AS n FROM derive_queue')).rows[0]!.n)
/** Drains the queue the way the leader does, until nothing waits. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8 && (await queued()); i++) await hub.deriver.drain()
  expect(await queued()).toBe(0)
}

/** What the server's stored row holds now: nothing about it is pushed again. */
const stored = async (key: string) => (await hub.db.query<{ fields: Record<string, unknown>; level: string }>('SELECT fields, level FROM derived WHERE blueprint = $1 AND key = $2', ['server', key])).rows[0]!
const page = async (key: string) => (await (await session(`/v1/entities/server/${key}`)).json()) as EntityPageResponse
const state = async (blueprint: string, key: string) => (await hub.db.query<{ state: string }>('SELECT state FROM entities WHERE blueprint = $1 AND key = $2', [blueprint, key])).rows[0]?.state

const site = (key: string, region: string) => ({ blueprint: 'site', key, title: key, fields: { region } })
const rack = (key: string, siteKey: string) => ({ blueprint: 'rack', key, title: key, relations: { site: siteKey } })
const server = (key: string, rackKey: string) => ({ blueprint: 'server', key, title: key, relations: { rack: rackKey } })
const rule = (key: string, serverKey: string, kind: string, health = 'green') => ({ blueprint: 'allow_rule', key, title: key, fields: { kind, health }, relations: { server: serverKey } })

// Rules that stay throughout, so what one snapshot drops is never a mass drop the hub holds back.
const steady = Array.from({ length: 20 }, (_, i) => rule(`steady-${i}`, 'db3', 'closed'))
const rules = (...list: unknown[]) => snapshot('rules', [...list, ...steady])

beforeAll(async () => {
  const pg = await import('pg').then(({ default: m }) => new m.Client({ connectionString: DATABASE_URL.replace(/\/[^/]+$/, '/postgres') }))
  await pg.connect()
  await pg.query(`DROP DATABASE IF EXISTS ${DATABASE_URL.split('/').pop()}`)
  await pg.query(`CREATE DATABASE ${DATABASE_URL.split('/').pop()}`)
  await pg.end()
  hub = await createHub(loadConfig({ DATABASE_URL, DATA_DIR: mkdtempSync(join(tmpdir(), 'orrery-')), AUTH_MODE: 'none' }), 'test', { reset: true })
  const save = async (id: string, spec: Record<string, unknown>) => expect((await session(`/v1/blueprints/${id}`, { method: 'PUT', ...body({ id, ...spec }) })).status).toBe(200)
  await save('site', { title: 'Site', fields: { region: { type: 'string' } }, relations: {} })
  await save('rack', { title: 'Rack', fields: {}, relations: { site: { target: 'site' } } })
  await save('server', {
    title: 'Server',
    status: { relations: ['<-allow_rule:server'] },
    fields: {
      open_rules: { type: 'number', aggregation: { relation: '<-allow_rule:server', fn: 'count', where: { field: 'kind', op: 'eq', value: 'open' } } },
      open: { type: 'boolean', calculation: 'open_rules > 0' },
      region: { type: 'string', mirror: 'rack.site.region' },
    },
    relations: { rack: { target: 'rack' } },
  })
  await save('allow_rule', { title: 'Allow rule', status: { field: 'health' }, fields: { kind: { type: 'string' }, health: { type: 'enum', values: ['green', 'amber', 'red', 'grey'] } }, relations: { server: { target: 'server' } } })
  await hub.sources.save('cloud', { title: 'cloud', class: 'pusher', blueprints: ['*'], deleteGrant: [], cadence: null, grace: { runs: 2, duration: '0' } })
  token = (await hub.sources.issueToken('source', 'cloud pusher', { source: 'cloud' })).token
  await snapshot('places', [site('east', 'us-east'), site('west', 'us-west'), rack('r1', 'east'), rack('r2', 'west'), server('db1', 'r1'), server('db2', 'r1'), server('db3', 'r2')])
  await rules(rule('a', 'db1', 'open'), rule('b', 'db1', 'open'), rule('c', 'db2', 'open'), rule('d', 'db3', 'closed', 'red'))
  await settle()
})

afterAll(async () => {
  await hub.close()
})

describe('what a derived value reaches through a relation', () => {
  it('counts only the related entities its source still sees, with a where', async () => {
    expect((await stored('db1')).fields).toMatchObject({ open_rules: 2, open: true })
    expect((await stored('db2')).fields).toMatchObject({ open_rules: 1, open: true })
    // The cloud deleted rule c: the next snapshot of the rules no longer names it.
    await rules(rule('a', 'db1', 'open'), rule('b', 'db1', 'open'), rule('d', 'db3', 'closed', 'red'))
    expect(await state('allow_rule', 'c')).toBe('missing')
    // The server was not pushed again, and its stored row moves anyway.
    await settle()
    expect((await stored('db2')).fields).toMatchObject({ open_rules: 0, open: false })
    expect((await page('db2')).fields).toMatchObject({ open_rules: 0, open: false })
    expect((await stored('db1')).fields).toMatchObject({ open_rules: 2, open: true })
  })

  it('counts a related entity again when its source sees it again, and not once it is deleted', async () => {
    await rules(rule('a', 'db1', 'open'), rule('b', 'db1', 'open'), rule('c', 'db2', 'open'), rule('d', 'db3', 'closed', 'red'))
    expect(await state('allow_rule', 'c')).toBe('active')
    await settle()
    expect((await stored('db2')).fields).toMatchObject({ open_rules: 1, open: true })
    // Snapshots without it: missing, then past its grace and deleted.
    for (let i = 0; i < 4 && (await state('allow_rule', 'b')) !== 'deleted'; i++) await rules(rule('a', 'db1', 'open'), rule('d', 'db3', 'closed', 'red'))
    expect(await state('allow_rule', 'b')).toBe('deleted')
    await settle()
    expect((await stored('db1')).fields).toMatchObject({ open_rules: 1, open: true })
    expect((await stored('db2')).fields).toMatchObject({ open_rules: 0, open: false })
  })

  it('mirrors nothing through a related entity that is missing, and its value again when it is back', async () => {
    expect((await stored('db1')).fields.region).toBe('us-east')
    // The rack the server sits in goes missing: the mirror steps through it to the site, and stops there.
    await snapshot('places', [site('east', 'us-east'), site('west', 'us-west'), rack('r2', 'west'), server('db1', 'r1'), server('db2', 'r1'), server('db3', 'r2')])
    expect(await state('rack', 'r1')).toBe('missing')
    await settle()
    expect((await stored('db1')).fields.region).toBeNull()
    await snapshot('places', [site('east', 'us-east'), site('west', 'us-west'), rack('r1', 'east'), rack('r2', 'west'), server('db1', 'r1'), server('db2', 'r1'), server('db3', 'r2')])
    await settle()
    expect((await stored('db1')).fields.region).toBe('us-east')
  })

  it('rolls up no status from a related entity that is missing', async () => {
    expect((await stored('db3')).level).toBe('red')
    await rules(rule('a', 'db1', 'open'))
    expect(await state('allow_rule', 'd')).toBe('missing')
    await settle()
    expect((await stored('db3')).level).toBe('green')
    expect((await page('db3')).status.level).toBe('green')
  })
})
