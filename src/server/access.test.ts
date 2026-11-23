import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { BlueprintsResponse, ChangesResponse, RolesResponse, UsersResponse, WhoAmIResponse } from '../shared/api.ts'
import { applyCatalog } from './catalog.ts'
import { loadConfig } from './config.ts'
import { createHub, type Hub } from './hub.ts'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://orrery:orrery@localhost:5433/orrery'

let hub: Hub

/** A request the login proxy lets through for a person, with the claims it read from their sign-in. */
const as = (email: string, groups: string) => (path: string, init?: RequestInit) =>
  hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', 'x-forwarded-email': email, 'x-forwarded-groups': groups, ...init?.headers } }, { surface: 'session' })
const admin = as('admin@example.com', 'Admin')
const dev = as('dev@example.com', 'User')
const machine = (path: string, bearer: string, init?: RequestInit) => hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}`, ...init?.headers } }, { surface: 'machine' })
const json = async <T = Record<string, unknown>>(r: Response): Promise<T> => (await r.json()) as T
const body = (v: unknown) => ({ body: JSON.stringify(v) })
const put = (v: unknown) => ({ method: 'PUT', ...body(v) })
const activity = async (query: string) => (await json<ChangesResponse>(await admin(`/v1/changes?${query}`))).changes
const headings = async () => [...new Set((await json<BlueprintsResponse>(await admin('/v1/blueprints'))).blueprints.map((b) => b.group))]

beforeAll(async () => {
  const config = loadConfig({ DATABASE_URL, DATA_DIR: mkdtempSync(join(tmpdir(), 'orrery-')), AUTH_MODE: 'proxy' })
  hub = await createHub(config, 'test', { reset: true })
})

afterAll(async () => {
  await hub.close()
})

describe('signing in', () => {
  it('refuses a person the login proxy gave neither claim', async () => {
    expect((await as('stranger@example.com', 'Sales')('/v1/whoami')).status).toBe(403)
    expect(hub.access.listUsers()).toEqual([])
  })

  it('enrolls a person once, who then reads everything and changes nothing', async () => {
    await Promise.all([dev('/v1/whoami'), dev('/v1/blueprints'), dev('/v1/sources')])
    const me = await json<WhoAmIResponse>(await dev('/v1/whoami'))
    expect(me.identity).toMatchObject({ kind: 'user', name: 'dev@example.com', admin: false, roles: [], permissions: [] })
    expect(me.web).toBe('http://localhost:8080')
    expect(hub.access.listUsers().map((u) => u.email)).toEqual(['dev@example.com'])
    const refused = await dev('/v1/entities', { method: 'POST', ...body({ blueprint: 'service', key: 'x', title: 'X' }) })
    expect(refused.status).toBe(403)
    expect((await json(refused)).error).toMatch(/entities\.edit/)
    expect((await dev('/v1/users')).status).toBe(403)
    expect((await dev('/v1/changes')).status).toBe(403)
  })

  it('gives an admin every permission, and records who enrolled and what was refused', async () => {
    const me = await json<WhoAmIResponse>(await admin('/v1/whoami'))
    expect(me.identity.admin).toBe(true)
    expect((await json<UsersResponse>(await admin('/v1/users'))).users.map((u) => [u.email, u.admin])).toEqual([['admin@example.com', true], ['dev@example.com', false]])
    expect((await activity('kind=user.enrolled')).map((c) => c.actor).sort()).toEqual(['admin@example.com', 'dev@example.com'])
    const refusals = await activity('outcome=refused')
    expect(refusals.map((c) => [c.kind, c.actor, c.detail.permission]).sort()).toEqual([
      ['access.refused', 'dev@example.com', 'audit.view'],
      ['access.refused', 'dev@example.com', 'entities.edit'],
      ['access.refused', 'dev@example.com', 'users.manage'],
    ])
  })
})

describe('roles', () => {
  it('start with the starters and the hub\'s own admin, which is locked', async () => {
    const { roles } = await json<RolesResponse>(await dev('/v1/roles'))
    expect(roles.map((r) => r.id)).toEqual(['admin', 'architect', 'contributor', 'viewer'])
    expect((await admin('/v1/roles/admin', put({ title: 'Root', permissions: [] }))).status).toBe(400)
  })

  it('give a person exactly what they bundle, at once', async () => {
    expect((await admin('/v1/roles/catalog-moderator', put({ title: 'Catalog moderator', permissions: ['catalog.organize'] }))).status).toBe(200)
    expect((await admin('/v1/users/dev%40example.com/roles', put({ roles: ['catalog-moderator'] }))).status).toBe(200)
    expect((await json<WhoAmIResponse>(await dev('/v1/whoami'))).identity.permissions).toEqual(['catalog.organize'])
    expect((await dev('/v1/catalog/layout', put({ order: ['Orrery'] }))).status).toBe(200)
    expect((await dev('/v1/entities', { method: 'POST', ...body({ blueprint: 'service', key: 'x', title: 'X' }) })).status).toBe(403)
    // The admin role reaches a person through sign-in only.
    expect((await admin('/v1/users/dev%40example.com/roles', put({ roles: ['admin'] }))).status).toBe(400)
  })

  it('let nobody hand out what they do not hold', async () => {
    await admin('/v1/roles/people', put({ title: 'People', permissions: ['users.manage', 'tokens.manage'] }))
    await admin('/v1/users/dev%40example.com/roles', put({ roles: ['catalog-moderator', 'people'] }))
    expect((await dev('/v1/roles/people', put({ title: 'People', permissions: ['users.manage', 'tokens.manage', 'secrets.manage'] }))).status).toBe(403)
    expect((await dev('/v1/users/dev%40example.com/roles', put({ roles: ['catalog-moderator', 'people', 'architect'] }))).status).toBe(403)
    expect((await dev('/v1/tokens', { method: 'POST', ...body({ kind: 'access', name: 'root', role: 'admin' }) })).status).toBe(403)
    const issued = await dev('/v1/tokens', { method: 'POST', ...body({ kind: 'access', name: 'reader', role: 'viewer' }) })
    expect(issued.status).toBe(201)
    const { token } = await json<{ token: string }>(issued)
    expect((await machine('/v1/summary', token)).status).toBe(200)
    expect((await machine('/v1/catalog/layout', token, put({ order: [] }))).status).toBe(403)
  })

  it('are kept while a token is bound to them, and taken from people when removed', async () => {
    expect((await admin('/v1/roles/viewer', { method: 'DELETE' })).status).toBe(409)
    expect((await admin('/v1/roles/people', { method: 'DELETE' })).status).toBe(200)
    expect(hub.access.listUsers().find((u) => u.email === 'dev@example.com')?.roles).toEqual(['catalog-moderator'])
    expect((await dev('/v1/users')).status).toBe(403)
  })
})

describe('the order of the groups', () => {
  it('puts the groups it names first, the rest by name, and blueprints with no group last', async () => {
    for (const [id, group] of [['zebra', 'Zoo'], ['shelf', 'Catalog'], ['apple', 'Fruit'], ['loose', undefined]] as const) {
      expect((await admin(`/v1/blueprints/${id}`, put({ title: id, group, fields: {}, relations: {} }))).status).toBe(200)
    }
    expect((await dev('/v1/catalog/layout', put({ order: [] }))).status).toBe(200)
    expect(await headings()).toEqual(['Catalog', 'Fruit', 'Orrery', 'Zoo', undefined])
    expect(await json(await dev('/v1/catalog/layout', put({ order: ['Zoo', 'Catalog'] })))).toEqual({ order: ['Zoo', 'Catalog'], closed: [], blueprints: {}, hidden: [] })
    expect(await headings()).toEqual(['Zoo', 'Catalog', 'Fruit', 'Orrery', undefined])
    const [last] = await activity('kind=catalog.ordered&limit=1')
    expect(last).toMatchObject({ actor: 'dev@example.com', actorKind: 'user', category: 'layout', detail: { order: ['Zoo', 'Catalog'] } })
  })

  it('keeps which groups start closed beside it, and changes one without the other', async () => {
    expect(await json(await dev('/v1/catalog/layout', put({ closed: ['Orrery', 'Fruit'] })))).toMatchObject({ order: ['Zoo', 'Catalog'], closed: ['Fruit', 'Orrery'] })
    expect(await json(await dev('/v1/catalog/layout', put({ order: ['Catalog'] })))).toMatchObject({ order: ['Catalog'], closed: ['Fruit', 'Orrery'] })
    expect(await json(await dev('/v1/catalog/layout', put({ closed: ['Orrery'] })))).toMatchObject({ order: ['Catalog'], closed: ['Orrery'] })
    const [folded] = await activity('kind=catalog.folded&limit=1')
    expect(folded).toMatchObject({ actor: 'dev@example.com', category: 'layout', detail: { closed: [], opened: ['Fruit'] } })
    const viewer = as('viewer@example.com', 'User')
    expect((await viewer('/v1/catalog/layout', put({ closed: [] }))).status).toBe(403)
    expect((await json<BlueprintsResponse>(await viewer('/v1/blueprints'))).layout.closed).toEqual(['Orrery'])
  })

  it('belongs to git while a git source declares it, and to people again when it stops', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orrery-layout-'))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'config.yaml'), 'config:\n  catalog:\n    groupOrder: [Fruit, Zoo]\n    closedGroups: [Zoo]\n    blueprintOrder:\n      Zoo: [zebra]\n    hiddenBlueprints: [apple]\n')
    const source = await hub.sources.save('layout', { title: 'Layout', class: 'git', blueprints: ['*'], deleteGrant: [], cadence: null, git: { url: 'https://example.org/layout.git', branch: 'main', glob: '**/*.yaml' } })
    expect((await applyCatalog(hub, source, dir, '**/*.yaml')).errors).toEqual([])
    expect((await json<BlueprintsResponse>(await dev('/v1/blueprints'))).layout).toEqual({ order: ['Fruit', 'Zoo'], closed: ['Zoo'], blueprints: { Zoo: ['zebra'] }, hidden: ['apple'], source: 'layout' })
    const locked = await dev('/v1/catalog/layout', put({ hidden: [] }))
    expect(locked.status).toBe(400)
    expect((await json(locked)).error).toMatch(/declared in git/)
    writeFileSync(join(dir, 'config.yaml'), 'config: {}\n')
    await applyCatalog(hub, source, dir, '**/*.yaml')
    expect(hub.blueprints.layout()).toEqual({ order: ['Fruit', 'Zoo'], closed: ['Zoo'], blueprints: { Zoo: ['zebra'] }, hidden: ['apple'] })
    expect((await dev('/v1/catalog/layout', put({ order: ['Zoo'] }))).status).toBe(200)
  })
})

describe('the blueprints inside a group', () => {
  const zoo = async () => (await json<BlueprintsResponse>(await dev('/v1/blueprints'))).blueprints.filter((b) => b.group === 'Zoo').map((b) => b.id)
  const make = async (id: string) => expect((await admin(`/v1/blueprints/${id}`, put({ title: id, group: 'Zoo', fields: {}, relations: {} }))).status).toBe(200)

  it('come in the order the layout names, and a new one lands at the bottom by title', async () => {
    await make('ant')
    await make('lion')
    expect(await json(await dev('/v1/catalog/layout', put({ blueprints: { Zoo: [] }, hidden: [] })))).toMatchObject({ blueprints: {}, hidden: [] })
    expect(await zoo()).toEqual(['ant', 'lion', 'zebra'])
    expect((await json<{ blueprints: unknown }>(await dev('/v1/catalog/layout', put({ blueprints: { Zoo: ['zebra', 'ant'] } })))).blueprints).toEqual({ Zoo: ['zebra', 'ant'] })
    expect(await zoo()).toEqual(['zebra', 'ant', 'lion'])
    await make('bear')
    expect(await zoo()).toEqual(['zebra', 'ant', 'bear', 'lion'])
    const [last] = await activity('kind=catalog.ordered&limit=1')
    expect(last).toMatchObject({ actor: 'dev@example.com', category: 'layout', detail: { blueprints: { Zoo: { order: ['zebra', 'ant'], before: [] } } } })
    // Ordering one group leaves the others as they were.
    expect((await json<{ blueprints: unknown }>(await dev('/v1/catalog/layout', put({ blueprints: { Fruit: ['apple'] } })))).blueprints).toEqual({ Fruit: ['apple'], Zoo: ['zebra', 'ant'] })
  })

  it('are hidden for everyone by whoever may organize the catalog, and stay in the list the hub answers with', async () => {
    expect(await json(await dev('/v1/catalog/layout', put({ hidden: ['lion', 'bear'] })))).toMatchObject({ hidden: ['bear', 'lion'], blueprints: { Zoo: ['zebra', 'ant'] } })
    expect(await json(await dev('/v1/catalog/layout', put({ hidden: ['lion'] })))).toMatchObject({ hidden: ['lion'] })
    const [hid] = await activity('kind=catalog.hidden&limit=1')
    expect(hid).toMatchObject({ actor: 'dev@example.com', category: 'layout', detail: { hidden: [], shown: ['bear'] } })
    const viewer = as('viewer@example.com', 'User')
    expect((await viewer('/v1/catalog/layout', put({ hidden: [] }))).status).toBe(403)
    expect((await json<BlueprintsResponse>(await viewer('/v1/blueprints'))).layout.hidden).toEqual(['lion'])
    expect(await zoo()).toEqual(['zebra', 'ant', 'bear', 'lion'])
  })

  it('keep their place and stay hidden through a rename, and leave the layout when removed', async () => {
    expect((await admin('/v1/blueprints/lion/rename', { method: 'POST', ...body({ to: 'tiger' }) })).status).toBe(200)
    expect((await admin('/v1/blueprints/ant/rename', { method: 'POST', ...body({ to: 'ape' }) })).status).toBe(200)
    expect(hub.blueprints.layout()).toMatchObject({ blueprints: { Fruit: ['apple'], Zoo: ['zebra', 'ape'] }, hidden: ['tiger'] })
    expect((await admin('/v1/blueprints/tiger', { method: 'DELETE' })).status).toBe(200)
    expect((await admin('/v1/blueprints/ape', { method: 'DELETE' })).status).toBe(200)
    expect(hub.blueprints.layout()).toMatchObject({ blueprints: { Fruit: ['apple'], Zoo: ['zebra'] }, hidden: [] })
    await hub.blueprints.load()
    expect(hub.blueprints.layout()).toMatchObject({ blueprints: { Fruit: ['apple'], Zoo: ['zebra'] }, hidden: [] })
  })
})

describe('a locked field', () => {
  it('is written by a source and by nobody else, an admin included', async () => {
    expect((await admin('/v1/blueprints/meter', put({ title: 'Meter', fields: { reading: { type: 'number', overridable: false }, notes: { type: 'string' } }, relations: {} }))).status).toBe(200)
    const created = await admin('/v1/entities', { method: 'POST', ...body({ blueprint: 'meter', key: 'm1', title: 'M1', fields: { reading: 5 } }) })
    expect(created.status).toBe(403)
    expect((await json(created)).error).toMatch(/"reading" is locked/)
    // The refused create left nothing behind; one without the locked field goes through.
    expect((await admin('/v1/entities', { method: 'POST', ...body({ blueprint: 'meter', key: 'm1', title: 'M1', fields: { notes: 'in the hall' } }) })).status).toBe(201)
    expect((await admin('/v1/entities/meter/m1', { method: 'PATCH', ...body({ fields: { reading: 5 } }) })).status).toBe(403)
    await hub.sources.save('meters', { title: 'meters', class: 'pusher', blueprints: ['meter'], deleteGrant: [], cadence: null })
    const { token } = await hub.sources.issueToken('source', 'meters', { source: 'meters' })
    expect((await machine('/v1/ingest/entities/meter/m1', token, { method: 'PATCH', ...body({ fields: { reading: 7 } }) })).status).toBe(200)
    expect((await json<{ fields: Record<string, unknown> }>(await admin('/v1/entities/meter/m1'))).fields).toMatchObject({ reading: 7, notes: 'in the hall' })
    expect((await admin('/v1/entities/meter/m1', { method: 'PATCH', ...body({ fields: { reading: 9 } }) })).status).toBe(403)
  })
})

describe('the activity log', () => {
  it('tells people from sources, so machine traffic can be hidden', async () => {
    expect((await admin('/v1/blueprints/service', put({ title: 'Service', fields: {}, relations: {} }))).status).toBe(200)
    await hub.sources.save('pusher', { title: 'pusher', class: 'pusher', blueprints: ['service'], deleteGrant: [], cadence: null })
    const { token } = await hub.sources.issueToken('source', 'pusher', { source: 'pusher' })
    expect((await machine('/v1/ingest/entities/service/pushed', token, put({ title: 'Pushed' }))).status).toBe(201)
    await admin('/v1/roles/editor', put({ title: 'Editor', permissions: ['entities.edit'] }))
    await admin('/v1/users/dev%40example.com/roles', put({ roles: ['editor'] }))
    expect((await dev('/v1/entities/service/pushed', { method: 'PATCH', ...body({ fields: { title: 'Renamed' } }) })).status).toBe(200)
    const forEntity = 'blueprint=service&key=pushed'
    expect((await activity(forEntity)).map((c) => [c.kind, c.actorKind, c.actor ?? c.source])).toEqual([
      ['entity.updated', 'user', 'dev@example.com'],
      ['entity.created', 'source', 'pusher'],
    ])
    expect((await activity(`${forEntity}&actorKind=user,token`)).map((c) => c.kind)).toEqual(['entity.updated'])
    expect((await activity(`${forEntity}&actorKind=source`)).map((c) => c.kind)).toEqual(['entity.created'])
    expect(await activity(`${forEntity}&actorKind=-`)).toEqual([])
  })

  it('records a write the hub turned down, from a person and from a source', async () => {
    expect((await admin('/v1/blueprints/orrery_mine', put({ title: 'Mine', fields: {}, relations: {} }))).status).toBe(400)
    const [failed] = await activity('kind=blueprint.changed&outcome=failed&limit=1')
    expect(failed).toMatchObject({ actor: 'admin@example.com', blueprint: 'orrery_mine', outcome: 'failed', detail: { status: 400 } })
    const { token } = await hub.sources.issueToken('source', 'pusher', { source: 'pusher' })
    expect((await machine('/v1/ingest/entities/repository/nope', token, put({ title: 'Nope' }))).status).toBeGreaterThanOrEqual(400)
    const [turnedDown] = await activity('kind=ingest.failed&limit=1')
    expect(turnedDown).toMatchObject({ source: 'pusher', actorKind: 'source', category: 'runs', outcome: 'failed' })
  })

  it('says a secret was set and who set it, never what it holds', async () => {
    expect((await admin('/v1/secrets/probe-key', put({ value: 'hunter2-not-in-the-log' }))).status).toBe(200)
    const [row] = await activity('category=secrets&limit=1')
    expect(row).toMatchObject({ kind: 'secret.changed', actor: 'admin@example.com', detail: { name: 'probe-key' } })
    expect(JSON.stringify(await activity('limit=1000'))).not.toContain('hunter2')
  })

  it('leaves out what a second save did not change', async () => {
    const before = (await activity('kind=blueprint.changed,rule.changed,scorecard.changed')).length
    const bp = hub.blueprints.get('zebra')!
    await admin('/v1/blueprints/zebra', put(bp))
    await admin('/v1/blueprints/zebra', put({ ...bp, description: 'Striped' }))
    expect((await activity('kind=blueprint.changed,rule.changed,scorecard.changed')).length).toBe(before + 1)
  })

  it('is kept for the retention and no longer', async () => {
    await hub.db.query(`INSERT INTO changes (at, kind, category, actor_kind, detail) VALUES (now() - interval '91 days', 'entity.updated', 'estate', 'hub', '{"old":true}')`)
    expect(await activity('until=' + encodeURIComponent(new Date(Date.now() - 90 * 86_400_000).toISOString()))).toHaveLength(1)
    await hub.tick()
    expect(await activity('until=' + encodeURIComponent(new Date(Date.now() - 90 * 86_400_000).toISOString()))).toHaveLength(0)
    expect((await activity('limit=5')).length).toBe(5)
  })
})
