import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { BlueprintsResponse, ChangesResponse, EntityPageResponse, ModelLayout, ModelPlacement, QueryResult, TokenIssued, WhoAmIResponse } from '../shared/api.ts'
import { loadConfig } from './config.ts'
import { createHub, type Hub } from './hub.ts'

// Its own database: these tests set who a signed-in person is, which every other test would then read.
const DATABASE_URL = (process.env.DATABASE_URL ?? 'postgres://orrery:orrery@localhost:5433/orrery') + '_viewas'

let hub: Hub

const VIEW_AS = 'x-orrery-view-as'
const as = (email: string, groups = 'User') => (path: string, init?: RequestInit) =>
  hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', 'x-forwarded-email': email, 'x-forwarded-groups': groups, ...init?.headers } }, { surface: 'session' })
const bearer = (token: string) => (path: string, init?: RequestInit) => hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...init?.headers } }, { surface: 'machine' })
const json = async <T = Record<string, unknown>>(r: Response): Promise<T> => (await r.json()) as T
const put = (v: unknown) => ({ method: 'PUT', body: JSON.stringify(v) })
const post = (v: unknown) => ({ method: 'POST', body: JSON.stringify(v) })
const viewing = (email: string) => ({ headers: { [VIEW_AS]: email } })

const admin = as('admin@example.org', 'Admin')
const otherAdmin = as('boss@example.org', 'Admin')
// In the platform team, which the restricted blueprint and field name.
const insider = as('ada@example.org')
// In another team: sees neither.
const outsider = as('bob@example.org')

const titles = async (read: Promise<Response> | Response) => (await json<BlueprintsResponse>(await read)).blueprints.map((b) => b.id).sort()
const activity = async (query: string) => (await json<ChangesResponse>(await admin(`/v1/changes?${query}`))).changes

beforeAll(async () => {
  const pg = await import('pg').then(({ default: m }) => new m.Client({ connectionString: DATABASE_URL.replace(/\/[^/]+$/, '/postgres') }))
  await pg.connect()
  await pg.query(`DROP DATABASE IF EXISTS ${DATABASE_URL.split('/').pop()}`)
  await pg.query(`CREATE DATABASE ${DATABASE_URL.split('/').pop()}`)
  await pg.end()
  hub = await createHub(loadConfig({ DATABASE_URL, DATA_DIR: mkdtempSync(join(tmpdir(), 'orrery-')), AUTH_MODE: 'proxy' }), 'test', { reset: true })

  const save = async (id: string, spec: Record<string, unknown>) => expect((await admin(`/v1/blueprints/${id}`, put({ id, ...spec }))).status).toBe(200)
  await save('team', { title: 'Team', fields: {}, relations: {} })
  await save('user', {
    title: 'Person',
    fields: { job_title: { type: 'string' }, home_phone: { type: 'string', access: { grants: [{ path: 'team', values: ['platform'] }] } } },
    relations: { team: { target: 'team', many: true } },
  })
  await save('subnet', { title: 'Subnet', fields: { cidr: { type: 'string' } }, relations: {}, access: { grants: [{ path: 'team', values: ['platform'] }] } })
  expect((await admin('/v1/access/person', put({ blueprint: 'user' }))).status).toBe(200)
  const create = async (blueprint: string, key: string, fields: Record<string, unknown> = {}, relations: Record<string, unknown> = {}) =>
    expect((await admin('/v1/entities', { method: 'POST', body: JSON.stringify({ blueprint, key, title: key, fields, relations }) })).status).toBe(201)
  await create('team', 'platform')
  await create('team', 'sales')
  await create('user', 'ada@example.org', { job_title: 'Engineer', home_phone: '555-0100' }, { team: ['platform'] })
  await create('user', 'bob@example.org', { job_title: 'Seller', home_phone: '555-0101' }, { team: ['sales'] })
  await create('subnet', 'core', { cidr: '10.0.0.0/24' })
  // Everyone has signed in once, and the other admin is known.
  await Promise.all([insider('/v1/whoami'), outsider('/v1/whoami'), otherAdmin('/v1/whoami')])
})

afterAll(async () => {
  await hub.close()
})

describe('an admin viewing as someone', () => {
  it('sees the blueprints and fields that person sees, and no others', async () => {
    expect(await titles(admin('/v1/blueprints'))).toEqual(expect.arrayContaining(['subnet', 'team', 'user']))
    expect(await titles(admin('/v1/blueprints', viewing('bob@example.org')))).toEqual(await titles(outsider('/v1/blueprints')))
    expect(await titles(admin('/v1/blueprints', viewing('bob@example.org')))).not.toContain('subnet')
    expect(await titles(admin('/v1/blueprints', viewing('ada@example.org')))).toContain('subnet')

    const phone = async (viewer: Promise<Response> | Response) => (await json<EntityPageResponse>(await viewer)).fields.home_phone
    expect(await phone(admin('/v1/entities/user/ada@example.org', viewing('bob@example.org')))).toBeUndefined()
    expect(await phone(admin('/v1/entities/user/ada@example.org', viewing('ada@example.org')))).toBe('555-0100')
    expect(await phone(admin('/v1/entities/user/ada@example.org'))).toBe('555-0100')
    expect((await admin('/v1/entities/subnet/core', viewing('bob@example.org'))).status).toBe(404)
    expect((await admin('/v1/entities/subnet/core', viewing('ada@example.org'))).status).toBe(200)
  })

  it('is that person to the UI: their roles, their permissions, and who is really calling', async () => {
    await admin('/v1/users/ada%40example.org/roles', put({ roles: ['viewer'] }))
    const me = await json<WhoAmIResponse>(await admin('/v1/whoami', viewing('ada@example.org')))
    expect(me.identity).toMatchObject({ kind: 'user', name: 'ada@example.org', admin: false, roles: ['viewer'], viewAs: { by: 'admin@example.org' } })
    expect(me.identity.permissions).toEqual(hub.access.permissionsOf(['viewer']))
    expect((await json<WhoAmIResponse>(await admin('/v1/whoami'))).identity.viewAs).toBeUndefined()
    await admin('/v1/users/ada%40example.org/roles', put({ roles: [] }))
  })

  it('sees everything when the person is an admin too', async () => {
    const me = await json<WhoAmIResponse>(await admin('/v1/whoami', viewing('boss@example.org')))
    expect(me.identity).toMatchObject({ name: 'boss@example.org', admin: true, viewAs: { by: 'admin@example.org' } })
    expect(await titles(admin('/v1/blueprints', viewing('boss@example.org')))).toContain('subnet')
  })

  it('answers an address however it is written, and an unknown person with a 404 that is recorded', async () => {
    expect((await admin('/v1/whoami', viewing('  BOB@example.org '))).status).toBe(200)
    const unknown = await admin('/v1/whoami', viewing('nobody@example.org'))
    expect(unknown.status).toBe(404)
    expect((await json(unknown)).error).toMatch(/nobody@example\.org/)
    expect((await activity('kind=access.refused&outcome=refused')).filter((c) => c.detail.reason === 'unknown person')[0]).toMatchObject({ actor: 'admin@example.org', detail: { viewAs: 'nobody@example.org' } })
  })

  it('reads and changes nothing as them: a write is refused and nothing is written', async () => {
    const before = await json<EntityPageResponse>(await admin('/v1/entities/user/bob@example.org'))
    for (const [path, init] of [
      ['/v1/entities/user/bob@example.org', { method: 'PATCH', body: JSON.stringify({ fields: { job_title: 'Chief' } }) }],
      ['/v1/entities', post({ blueprint: 'team', key: 'new', title: 'New' })],
      ['/v1/blueprints/team', put({ id: 'team', title: 'Renamed', fields: {}, relations: {} })],
      ['/v1/me/tokens', post({ name: 'sneaky' })],
    ] as const) {
      const refused = await admin(path, { ...init, ...viewing('bob@example.org') })
      expect(refused.status, path).toBe(403)
      expect((await json(refused)).error).toMatch(/read-only|tokens/i)
    }
    expect((await admin('/v1/me/tokens', viewing('bob@example.org'))).status).toBe(403)
    const after = await json<EntityPageResponse>(await admin('/v1/entities/user/bob@example.org'))
    expect(after.fields).toEqual(before.fields)
    expect((await admin('/v1/entities/team/new')).status).toBe(404)
    expect((await json<BlueprintsResponse>(await admin('/v1/blueprints'))).blueprints.find((b) => b.id === 'team')?.title).toBe('Team')
    expect((await json<{ tokens: unknown[] }>(await bobTokens())).tokens).toEqual([])
    const rows = await activity('outcome=refused')
    expect(rows.filter((c) => c.detail.reason === 'a change while viewing as someone else').map((c) => c.actor)).toEqual(Array(4).fill('admin@example.org'))
    expect(rows.filter((c) => c.detail.reason === 'own tokens while viewing as someone else')).toHaveLength(1)
  })

  it('runs a query as them: it only reads, so it is let through and answers what they see', async () => {
    const spec = { sources: [{ blueprint: 'user', clauses: [] }, { blueprint: 'subnet', clauses: [] }], columns: ['title', 'home_phone'] }
    const asBob = await admin('/v1/query', { ...post({ sources: [{ blueprint: 'user', clauses: [] }], columns: ['title', 'home_phone'] }), ...viewing('bob@example.org') })
    expect(asBob.status).toBe(200)
    const bob = await json<QueryResult>(asBob)
    // A field they may not see is no column of theirs.
    expect(bob.columns.map((c) => c.id)).toEqual(['title'])
    expect(bob.rows.map((r) => r.values)).toEqual([['ada@example.org'], ['bob@example.org']])
    // A blueprint they may not see is left out of what they read, never refused.
    expect((await json<QueryResult>(await admin('/v1/query', { ...post(spec), ...viewing('bob@example.org') }))).counts).toEqual({ user: 2 })
    const ada = await json<QueryResult>(await admin('/v1/query', { ...post(spec), ...viewing('ada@example.org') }))
    expect(ada.counts).toEqual({ user: 2, subnet: 1 })
    expect(ada.rows.find((r) => r.key === 'ada@example.org')?.values).toEqual(['ada@example.org', '555-0100'])
    const exported = await admin('/v1/query/export', { ...post({ spec: { sources: [{ blueprint: 'user', clauses: [] }], columns: ['title'] } }), ...viewing('bob@example.org') })
    expect(exported.status).toBe(200)
    expect((await admin('/v1/queries', { ...post({ title: 'Theirs', spec }), ...viewing('bob@example.org') })).status).toBe(403)
  })

  it('previews a batch as them, since a preview only reads, and still refuses to run it', async () => {
    expect((await admin('/v1/actions/wave', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Wave', blueprint: 'user', batch: { max: 5 }, inputs: {}, backend: { type: 'caller' }, access: { everyone: true } }) })).status).toBe(200)
    const ask = { entities: [{ blueprint: 'user', key: 'ada@example.org' }, { blueprint: 'user', key: 'bob@example.org' }], inputs: {} }
    const preview = await admin('/v1/actions/wave/batch/preview', { ...post(ask), ...viewing('bob@example.org') })
    expect(preview.status).toBe(200)
    expect((await json<{ total: number }>(preview)).total).toBe(2)
    expect((await admin('/v1/actions/wave/batch', { ...post(ask), ...viewing('bob@example.org') })).status).toBe(403)
    await admin('/v1/actions/wave', { method: 'DELETE' })
  })

  it("records one row when the view starts, in the admin's name", async () => {
    const started = await admin('/v1/view-as', post({ email: 'Bob@example.org' }))
    expect(started.status).toBe(200)
    expect(await json(started)).toEqual({ email: 'bob@example.org', admin: false })
    const rows = await activity('kind=access.viewed')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ actor: 'admin@example.org', actorKind: 'user', outcome: 'ok', detail: { viewed: 'bob@example.org' } })
    // Reading as them writes nothing more.
    await admin('/v1/blueprints', viewing('bob@example.org'))
    expect(await activity('kind=access.viewed')).toHaveLength(1)
  })

  it('does not follow an unknown person into the log as the person', async () => {
    expect((await admin('/v1/view-as', post({ email: 'nobody@example.org' }))).status).toBe(404)
    expect((await activity('kind=access.viewed')).map((c) => c.detail.viewed)).toEqual(['bob@example.org'])
  })

  it('carries the address on the live stream, so a change to what they cannot see never reaches the view', async () => {
    const response = await admin(`/v1/events?view_as=${encodeURIComponent('bob@example.org')}`)
    expect(response.status).toBe(200)
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    // Let the stream subscribe before anything is emitted.
    await new Promise((r) => setTimeout(r, 50))
    hub.events.emit({ type: 'entity', blueprint: 'subnet', key: 'core' })
    hub.events.emit({ type: 'entity', blueprint: 'team', key: 'sales' })
    let seen = ''
    const deadline = Date.now() + 3000
    while (!seen.includes('"team"') && Date.now() < deadline) {
      const chunk = await Promise.race([reader.read(), new Promise<{ value: undefined }>((r) => setTimeout(() => r({ value: undefined }), 500))])
      if (chunk.value) seen += decoder.decode(chunk.value)
    }
    await reader.cancel()
    expect(seen).toContain('"blueprint":"team"')
    expect(seen).not.toContain('"blueprint":"subnet"')
  })
})

describe('who may view as someone', () => {
  it('is an admin and nobody else: a person who is not one is refused and it is recorded', async () => {
    const refused = await insider('/v1/whoami', viewing('bob@example.org'))
    expect(refused.status).toBe(403)
    expect((await json(refused)).error).toMatch(/admin/i)
    expect((await insider('/v1/view-as', post({ email: 'bob@example.org' }))).status).toBe(403)
    const rows = (await activity('kind=access.refused&outcome=refused')).filter((c) => c.actor === 'ada@example.org' && c.detail.reason === 'not an admin')
    expect(rows.length).toBeGreaterThanOrEqual(2)
    // The person still reads their own view as before.
    expect((await json<WhoAmIResponse>(await insider('/v1/whoami'))).identity.name).toBe('ada@example.org')
  })

  it('is never a token: an access token on the machine port is refused, and so is a personal token of an admin', async () => {
    const { token } = await json<TokenIssued>(await admin('/v1/tokens', post({ kind: 'access', name: 'reader', role: 'admin' })))
    const machine = await bearer(token)('/v1/whoami', viewing('bob@example.org'))
    expect(machine.status).toBe(403)
    const personal = await json<TokenIssued>(await admin('/v1/me/tokens', post({ name: 'agent' })))
    const viaToken = await as('admin@example.org', 'Admin')('/v1/whoami', { headers: { authorization: `Bearer ${personal.token}`, [VIEW_AS]: 'bob@example.org' } })
    expect(viaToken.status).toBe(403)
    expect((await json(viaToken)).error).toMatch(/not a token/i)
    // Without the header both work as they always did.
    expect((await bearer(token)('/v1/whoami')).status).toBe(200)
  })

  it('is not read on the machine port even from a session-looking caller', async () => {
    const machineWithHeaders = await hub.app.request('/v1/whoami', { headers: { 'x-forwarded-email': 'admin@example.org', 'x-forwarded-groups': 'Admin', [VIEW_AS]: 'bob@example.org' } }, { surface: 'machine' })
    expect(machineWithHeaders.status).toBe(401)
  })
})

const bobTokens = () => outsider('/v1/me/tokens')

describe('an access grant', () => {
  it('is refused when its path names a relation the person blueprint does not have', async () => {
    const spec = (path: string) => put({ id: 'subnet', title: 'Subnet', fields: { cidr: { type: 'string' } }, relations: {}, access: { grants: [{ path, values: ['platform'] }] } })
    const wrong = await admin('/v1/blueprints/subnet', spec('teams'))
    expect(wrong.status).toBe(400)
    expect((await json<{ error: string }>(wrong)).error).toContain('has no relation "teams"')
    expect((await admin('/v1/blueprints/subnet', spec('team'))).status).toBe(200)
  })

  it('on a field is checked the same way', async () => {
    const r = await admin('/v1/blueprints/subnet', put({ id: 'subnet', title: 'Subnet', fields: { cidr: { type: 'string', access: { grants: [{ path: 'squad', values: ['platform'] }] } } }, relations: {}, access: { grants: [{ path: 'team', values: ['platform'] }] } }))
    expect(r.status).toBe(400)
    expect((await json<{ error: string }>(r)).error).toContain('Field "cidr"')
  })
})

describe('the shared model layout', () => {
  it('answers only the blueprints a reader sees, and a save keeps what the saver does not see', async () => {
    expect((await admin('/v1/model/layout', put({ hidden: ['subnet', 'team'] }))).status).toBe(200)
    const theirs = await json<ModelLayout>(await outsider('/v1/model/layout'))
    expect(theirs.hidden).toEqual(['team'])
    expect(theirs.positions.subnet).toBeUndefined()
    expect(theirs.positions.team).toBeDefined()
    await admin('/v1/users/bob%40example.org/roles', put({ roles: ['architect'] }))
    try {
      expect((await json<ModelLayout>(await outsider('/v1/model/layout', put({ hidden: [] })))).hidden).toEqual([])
      expect((await json<ModelLayout>(await admin('/v1/model/layout'))).hidden).toEqual(['subnet'])
    } finally {
      await admin('/v1/users/bob%40example.org/roles', put({ roles: [] }))
    }
  })

  it('places a reader\'s own view for anyone, viewing as them too, and saves nothing', async () => {
    const before = await json<ModelLayout>(await admin('/v1/model/layout'))
    const laid = await json<ModelPlacement>(await outsider('/v1/model/layout/place', post({ hidden: [], rearrange: true })))
    expect(laid.positions.team).toBeDefined()
    expect(laid.positions.subnet).toBeUndefined()
    const { team: _gone, ...rest } = laid.positions
    expect(Object.keys((await json<ModelPlacement>(await outsider('/v1/model/layout/place', post({ hidden: [], positions: rest })))).positions)).toEqual(['team'])
    expect((await admin('/v1/model/layout/place', { ...post({ hidden: [], rearrange: true }), ...viewing('bob@example.org') })).status).toBe(200)
    expect(await json<ModelLayout>(await admin('/v1/model/layout'))).toEqual(before)
  })
})
