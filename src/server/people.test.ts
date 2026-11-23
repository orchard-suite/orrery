import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { UsersResponse, WhoAmIResponse } from '../shared/api.ts'
import { loadConfig } from './config.ts'
import { createHub, type Hub } from './hub.ts'

// Its own database: this hub is configured with a mail alias, and people move between rows at start.
const DATABASE_URL = (process.env.DATABASE_URL ?? 'postgres://orrery:orrery@localhost:5433/orrery') + '_people'

let hub: Hub

const as = (email: string, groups: string) => (path: string, init?: RequestInit) =>
  hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', 'x-forwarded-email': email, 'x-forwarded-groups': groups, ...init?.headers } }, { surface: 'session' })
const json = async <T = Record<string, unknown>>(r: Response): Promise<T> => (await r.json()) as T
const config = () => loadConfig({ DATABASE_URL, DATA_DIR: mkdtempSync(join(tmpdir(), 'orrery-')), AUTH_MODE: 'proxy', EMAIL_DOMAIN_ALIASES: 'mail.example.org=example.org' })

beforeAll(async () => {
  const admin = await import('pg').then(({ default: pg }) => new pg.Client({ connectionString: DATABASE_URL.replace(/\/[^/]+$/, '/postgres') }))
  await admin.connect()
  await admin.query(`DROP DATABASE IF EXISTS ${DATABASE_URL.split('/').pop()}`)
  await admin.query(`CREATE DATABASE ${DATABASE_URL.split('/').pop()}`)
  await admin.end()
  hub = await createHub(config(), 'test', { reset: true })
})

afterAll(async () => {
  await hub.close()
})

describe('a person known by an alias', () => {
  it('is kept under the sign-in address whichever one sign-in gives', async () => {
    const admin = as('Boss@mail.example.org', 'Admin')
    const me = await json<WhoAmIResponse>(await admin('/v1/whoami'))
    expect(me.identity.name).toBe('boss@example.org')
    await as('boss@example.org', 'Admin')('/v1/whoami')
    expect(hub.access.listUsers().map((u) => u.email)).toEqual(['boss@example.org'])
  })
})

describe('adding a person before they sign in', () => {
  const admin = as('boss@example.org', 'Admin')

  it('keeps them with their roles and no sign-in', async () => {
    const res = await admin('/v1/users', { method: 'POST', body: JSON.stringify({ email: 'Peer@mail.example.org', roles: ['viewer'] }) })
    expect(res.status).toBe(201)
    const added = (await json<UsersResponse>(await admin('/v1/users'))).users.find((u) => u.email === 'peer@example.org')
    expect(added).toMatchObject({ roles: ['viewer'], firstSeenAt: null, lastSeenAt: null, admin: false })
    expect((await admin('/v1/users', { method: 'POST', body: JSON.stringify({ email: 'peer@example.org', roles: [] }) })).status).toBe(409)
    expect((await admin('/v1/users', { method: 'POST', body: JSON.stringify({ email: 'not an address', roles: [] }) })).status).toBe(400)
    expect((await admin('/v1/users', { method: 'POST', body: JSON.stringify({ email: 'x@example.org', roles: ['admin'] }) })).status).toBe(400)
  })

  it('gives them those roles the first time they sign in', async () => {
    const me = await json<WhoAmIResponse>(await as('peer@mail.example.org', 'User')('/v1/whoami'))
    expect(me.identity).toMatchObject({ name: 'peer@example.org', roles: ['viewer'] })
    const peer = hub.access.listUsers().find((u) => u.email === 'peer@example.org')
    expect(peer?.firstSeenAt).not.toBeNull()
  })

  it('is refused to someone who cannot give roles', async () => {
    expect((await as('peer@example.org', 'User')('/v1/users', { method: 'POST', body: JSON.stringify({ email: 'z@example.org', roles: [] }) })).status).toBe(403)
  })
})

describe('people kept under an alias before it was configured', () => {
  it('move to their sign-in address at start, keeping their roles', async () => {
    await hub.db.query(`INSERT INTO users (email, admin, roles, first_seen_at, last_seen_at) VALUES ('old@mail.example.org', false, '["contributor"]', now(), now())`)
    await hub.db.query(`INSERT INTO users (email, admin, roles, first_seen_at, last_seen_at) VALUES ('old@example.org', false, '["viewer"]', now() - interval '1 day', now() - interval '1 day')`)
    await hub.close()
    hub = await createHub(config(), 'test')
    const emails = hub.access.listUsers().map((u) => u.email)
    expect(emails).not.toContain('old@mail.example.org')
    expect(hub.access.listUsers().find((u) => u.email === 'old@example.org')?.roles.sort()).toEqual(['contributor', 'viewer'])
  })
})
