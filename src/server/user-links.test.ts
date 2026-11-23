import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { EntitiesResponse, EntityPageResponse } from '../shared/api.ts'
import { loadConfig } from './config.ts'
import { createHub, type Hub } from './hub.ts'

// Its own database: these tests set who a person is and who may see the people.
const DATABASE_URL = (process.env.DATABASE_URL ?? 'postgres://orrery:orrery@localhost:5433/orrery') + '_user_links'

let hub: Hub

const as = (email: string, groups = 'User') => (path: string, init?: RequestInit) =>
  hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', 'x-forwarded-email': email, 'x-forwarded-groups': groups, ...init?.headers } }, { surface: 'session' })
const json = async <T>(r: Response): Promise<T> => (await r.json()) as T
const put = (v: unknown) => ({ method: 'PUT', body: JSON.stringify(v) })
const post = (v: unknown) => ({ method: 'POST', body: JSON.stringify(v) })

const admin = as('admin@example.org', 'Admin')
// A person the person blueprint's rule lets in.
const ada = as('ada@example.org')
// A person who sees the tickets and none of the people.
const stranger = as('stranger@example.org')

const grid = async (reader: typeof admin) => json<EntitiesResponse>(await reader('/v1/entities?blueprint=ticket&distribution=later'))
const page = async (reader: typeof admin, key: string) => json<EntityPageResponse>(await reader(`/v1/entities/ticket/${key}`))

beforeAll(async () => {
  const pg = await import('pg').then(({ default: m }) => new m.Client({ connectionString: DATABASE_URL.replace(/\/[^/]+$/, '/postgres') }))
  await pg.connect()
  await pg.query(`DROP DATABASE IF EXISTS ${DATABASE_URL.split('/').pop()}`)
  await pg.query(`CREATE DATABASE ${DATABASE_URL.split('/').pop()}`)
  await pg.end()
  hub = await createHub(loadConfig({ DATABASE_URL, DATA_DIR: mkdtempSync(join(tmpdir(), 'orrery-')), AUTH_MODE: 'proxy' }), 'test', { reset: true })

  const save = async (id: string, spec: Record<string, unknown>) => expect((await admin(`/v1/blueprints/${id}`, put({ id, ...spec }))).status).toBe(200)
  await save('person', { title: 'Person', fields: { email: { type: 'string' } }, relations: {}, access: { grants: [{ values: ['ada@example.org'] }] } })
  await save('ticket', { title: 'Ticket', fields: { requested_by: { type: 'user' }, note: { type: 'string' } }, relations: {} })
  expect((await admin('/v1/access/person', put({ blueprint: 'person', field: 'email' }))).status).toBe(200)
  const create = async (blueprint: string, key: string, title: string, fields: Record<string, unknown>) => expect((await admin('/v1/entities', post({ blueprint, key, title, fields }))).status).toBe(201)
  await create('person', 'ada', 'Ada Lovelace', { email: 'Ada@Example.org' })
  // Held inside a longer value: found the way a sign-in finds it.
  await create('person', 'grace', 'Grace Hopper', { email: 'Grace Hopper <grace@example.org>' })
  await create('ticket', 'asked', 'Asked by Ada', { requested_by: ' ada@example.org ', note: 'ada@example.org' })
  await create('ticket', 'grace', 'Asked by Grace', { requested_by: 'grace@example.org' })
  await create('ticket', 'outsider', 'Asked from outside', { requested_by: 'nobody@example.org' })
})

afterAll(async () => {
  await hub.close()
})

describe('a user value', () => {
  it('names the person it is, on a grid block, under their title', async () => {
    const rows = new Map((await grid(admin)).entities.map((e) => [e.key, e]))
    expect(rows.get('asked')?.people).toEqual({ 'ada@example.org': { blueprint: 'person', key: 'ada', title: 'Ada Lovelace', icon: null } })
    expect(rows.get('grace')?.people).toEqual({ 'grace@example.org': { blueprint: 'person', key: 'grace', title: 'Grace Hopper', icon: null } })
  })

  it('names nobody for an address that is no one here, or for a field that is not a user', async () => {
    const rows = new Map((await grid(admin)).entities.map((e) => [e.key, e]))
    expect(rows.get('outsider')?.people).toBeUndefined()
    // The note holds Ada's address too, but it is text: only the user field asks.
    expect(Object.keys(rows.get('asked')?.people ?? {})).toEqual(['ada@example.org'])
  })

  it('names the person on the entity page', async () => {
    expect((await page(ada, 'asked')).people).toEqual({ 'ada@example.org': { blueprint: 'person', key: 'ada', title: 'Ada Lovelace', icon: null } })
  })

  it('names nobody to a reader who may not see the people', async () => {
    expect((await grid(stranger)).entities.find((e) => e.key === 'asked')?.people).toBeUndefined()
    expect((await page(stranger, 'asked')).people).toBeUndefined()
    // The value itself is still theirs to read.
    expect((await page(stranger, 'asked')).fields.requested_by).toBe(' ada@example.org ')
  })

  it('follows the person when their address moves', async () => {
    expect((await admin('/v1/entities/person/grace', { method: 'PATCH', body: JSON.stringify({ fields: { email: 'hopper@example.org' } }) })).status).toBe(200)
    expect((await page(admin, 'grace')).people).toBeUndefined()
  })
})
