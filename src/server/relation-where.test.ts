// Conditions on what a relation reaches, through the API: a query's source
// and the grid read them, the hub refuses one that reads what the reader may
// not see, and the places that judge a filter without the values of what it
// reaches (a scorecard, an aggregation, a case of an inherited relation)
// refuse to hold one.

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { GridClause, QueryResult } from '../shared/api.ts'
import { loadConfig } from './config.ts'
import { createHub, type Hub } from './hub.ts'

// Its own database: these tests set who a signed-in person is.
const DATABASE_URL = (process.env.DATABASE_URL ?? 'postgres://orrery:orrery@localhost:5433/orrery') + '_relwhere'

let hub: Hub

const as = (email: string, groups = 'User') => (path: string, init?: RequestInit) =>
  hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', 'x-forwarded-email': email, 'x-forwarded-groups': groups, ...init?.headers } }, { surface: 'session' })
const admin = as('admin@example.org', 'Admin')
// In sales: the repository's secret field is withheld from them.
const seller = as('bob@example.org')
const put = (v: unknown) => ({ method: 'PUT', body: JSON.stringify(v) })
const post = (v: unknown) => ({ method: 'POST', body: JSON.stringify(v) })

const idle: GridClause = { field: 'days_idle', op: 'gt', value: '90' }
const reaching = (match: GridClause['match'], where: GridClause[] = [idle]): GridClause => ({ field: 'r:repo', op: 'exists', value: '', match, where })
const query = (clauses: GridClause[]) => post({ sources: [{ blueprint: 'service', clauses }], columns: ['title'] })
const titles = async (r: Response) => {
  expect(r.status).toBe(200)
  return ((await r.json()) as QueryResult).rows.map((row) => row.values[0]).sort()
}

beforeAll(async () => {
  const pg = await import('pg').then(({ default: m }) => new m.Client({ connectionString: DATABASE_URL.replace(/\/[^/]+$/, '/postgres') }))
  await pg.connect()
  await pg.query(`DROP DATABASE IF EXISTS ${DATABASE_URL.split('/').pop()}`)
  await pg.query(`CREATE DATABASE ${DATABASE_URL.split('/').pop()}`)
  await pg.end()
  hub = await createHub(loadConfig({ DATABASE_URL, DATA_DIR: mkdtempSync(join(tmpdir(), 'orrery-')), AUTH_MODE: 'proxy' }), 'test', { reset: true })

  const save = async (id: string, spec: Record<string, unknown>) => expect((await admin(`/v1/blueprints/${id}`, put({ id, ...spec }))).status).toBe(200)
  await save('team', { title: 'Team', fields: {}, relations: {} })
  await save('user', { title: 'Person', fields: {}, relations: { team: { target: 'team', many: true } } })
  expect((await admin('/v1/access/person', put({ blueprint: 'user' }))).status).toBe(200)
  await save('repo', { title: 'Repository', fields: { days_idle: { type: 'number' }, secret: { type: 'string', access: { grants: [{ path: 'team', values: ['platform'] }] } } }, relations: {} })
  await save('service', { title: 'Service', fields: {}, relations: { repo: { target: 'repo', many: true } } })
  const create = async (blueprint: string, key: string, fields: Record<string, unknown> = {}, relations: Record<string, unknown> = {}) =>
    expect((await admin('/v1/entities', post({ blueprint, key, title: key, fields, relations }))).status).toBe(201)
  await create('team', 'sales')
  await create('user', 'bob@example.org', {}, { team: ['sales'] })
  await create('repo', 'idle', { days_idle: 400, secret: 'x' })
  await create('repo', 'busy', { days_idle: 2 })
  await create('service', 'on-both', {}, { repo: ['idle', 'busy'] })
  await create('service', 'on-idle', {}, { repo: ['idle'] })
  await create('service', 'on-none')
  await seller('/v1/whoami')
})

afterAll(async () => {
  await hub.close()
})

describe('a query source that tests what a relation reaches', () => {
  it('keeps any, every, and none, as the conditions on the reached entities say', async () => {
    expect(await titles(await admin('/v1/query', query([reaching('any')])))).toEqual(['on-both', 'on-idle'])
    expect(await titles(await admin('/v1/query', query([reaching('all')])))).toEqual(['on-idle'])
    expect(await titles(await admin('/v1/query', query([reaching('none')])))).toEqual(['on-none'])
    expect(await titles(await admin('/v1/query', query([reaching('none', [])])))).toEqual(['on-none'])
    expect(await titles(await seller('/v1/query', query([reaching('any')])))).toEqual(['on-both', 'on-idle'])
  })

  it('refuses one that reads a field the reader may not see on what it reaches', async () => {
    const asks = query([reaching('any', [{ field: 'secret', op: 'exists', value: '' }])])
    expect((await seller('/v1/query', asks)).status).toBe(403)
    expect(await titles(await admin('/v1/query', asks))).toEqual(['on-both', 'on-idle'])
  })

  it('takes conditions on what it reaches only on a relation', async () => {
    expect((await admin('/v1/query', query([{ field: 'title', op: 'exists', value: '', where: [idle] }]))).status).toBe(400)
  })
})

describe('where a filter is judged without the values of what it reaches', () => {
  it('refuses a scorecard rule that reads them', async () => {
    const res = await admin('/v1/scorecards/idle', put({ blueprint: 'service', title: 'Idle', levels: [{ name: 'Bronze', rules: [{ id: 'busy', title: 'Busy', where: { relation: 'repo', where: { field: 'days_idle', op: 'lt', value: 30 } } }] }] }))
    expect(res.status).toBe(400)
    expect(JSON.stringify(await res.json())).toContain('what a relation reaches')
  })

  it('refuses an aggregation whose where reads them', async () => {
    const res = await admin('/v1/blueprints/service', put({ id: 'service', title: 'Service', fields: { idle_repos: { type: 'number', aggregation: { relation: 'repo', fn: 'count', where: { relation: 'team', where: { and: [] } } } } }, relations: { repo: { target: 'repo', many: true } } }))
    expect(res.status).toBe(400)
  })
})
