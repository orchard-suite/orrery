import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Alert, BlueprintsResponse, ChangesResponse, EntitiesResponse, EntityPageResponse, GridLayout, MineResponse, ScorecardResults, SummaryResponse, TokenIssued, WallResponse } from '../shared/api.ts'
import { loadConfig } from './config.ts'
import { createHub, type Hub } from './hub.ts'
import { adminOnlyBlueprints } from './visibility.ts'

// Its own database: these tests set who a signed-in person is, which every other test would then read.
const DATABASE_URL = (process.env.DATABASE_URL ?? 'postgres://orrery:orrery@localhost:5433/orrery') + '_visibility'

let hub: Hub

const as = (email: string, groups = 'User') => (path: string, init?: RequestInit) =>
  hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', 'x-forwarded-email': email, 'x-forwarded-groups': groups, ...init?.headers } }, { surface: 'session' })
const bearer = (token: string) => (path: string, init?: RequestInit) => hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...init?.headers } }, { surface: 'machine' })
const json = async <T = Record<string, unknown>>(r: Response): Promise<T> => (await r.json()) as T
const put = (v: unknown) => ({ method: 'PUT', body: JSON.stringify(v) })
const post = (v: unknown) => ({ method: 'POST', body: JSON.stringify(v) })
const patch = (v: unknown) => ({ method: 'PATCH', body: JSON.stringify(v) })

const admin = as('admin@example.org', 'Admin')
// In the platform team.
const insider = as('ada@example.org')
// In another team, and in no department with access.
const outsider = as('bob@example.org')
// Named on the restricted fields by address, in no team at all.
const named = as('cy@example.org')

beforeAll(async () => {
  const pg = await import('pg').then(({ default: m }) => new m.Client({ connectionString: DATABASE_URL.replace(/\/[^/]+$/, '/postgres') }))
  await pg.connect()
  await pg.query(`DROP DATABASE IF EXISTS ${DATABASE_URL.split('/').pop()}`)
  await pg.query(`CREATE DATABASE ${DATABASE_URL.split('/').pop()}`)
  await pg.end()
  hub = await createHub(loadConfig({ DATABASE_URL, DATA_DIR: mkdtempSync(join(tmpdir(), 'orrery-')), AUTH_MODE: 'proxy' }), 'test', { reset: true })

  const save = async (id: string, spec: Record<string, unknown>) => expect((await admin(`/v1/blueprints/${id}`, put({ id, ...spec }))).status).toBe(200)
  await save('department', { title: 'Department', fields: {}, relations: {} })
  await save('team', { title: 'Team', fields: {}, relations: { department: { target: 'department' } } })
  await save('user', {
    title: 'Person',
    fields: {
      job_title: { type: 'string' },
      home_phone: { type: 'string', access: { grants: [{ path: 'team', values: ['platform'] }, { path: 'department', values: ['hr'] }, { values: ['cy@example.org'] }] } },
      // Reads a withheld field, so it is withheld with it.
      phone_known: { type: 'boolean', calculation: 'home_phone != null' },
    },
    relations: { team: { target: 'team', many: true }, department: { target: 'department' } },
  })
  await save('subnet', { title: 'Subnet', fields: { cidr: { type: 'string' } }, relations: {}, access: { grants: [{ path: 'team', values: ['platform'] }] } })
  await save('workstation', { title: 'Workstation', fields: { serial: { type: 'string' } }, relations: { primary_user: { target: 'user' }, subnet: { target: 'subnet' } } })
  await save('badge', { title: 'Badge', fields: {}, relations: { holder: { target: 'user' } }, access: { grants: [{ values: ['ada@example.org'] }] } })
  expect((await admin('/v1/access/person', put({ blueprint: 'user' }))).status).toBe(200)

  const create = async (blueprint: string, key: string, fields: Record<string, unknown> = {}, relations: Record<string, unknown> = {}) =>
    expect((await admin('/v1/entities', post({ blueprint, key, title: key, fields, relations }))).status).toBe(201)
  await create('department', 'it')
  await create('department', 'hr')
  await create('team', 'platform', {}, { department: 'it' })
  await create('team', 'sales', {}, { department: 'it' })
  await create('user', 'ada@example.org', { job_title: 'Engineer', home_phone: '555-0100' }, { team: ['platform'], department: 'it' })
  await create('user', 'bob@example.org', { job_title: 'Seller', home_phone: '555-0101' }, { team: ['sales'], department: 'it' })
  await create('user', 'cy@example.org', { job_title: 'Director', home_phone: '555-0102' }, { department: 'it' })
  await create('subnet', 'core', { cidr: '10.0.0.0/24' })
  await create('workstation', 'pc-1', { serial: 'S1' }, { primary_user: 'bob@example.org', subnet: 'core' })
  await create('badge', 'b-1', {}, { holder: 'bob@example.org' })
})

afterAll(async () => {
  await hub.close()
})

const person = async (reader: (p: string) => Promise<Response> | Response, key: string) => (await reader(`/v1/entities/user/${encodeURIComponent(key)}?provenance=true`)).json() as Promise<EntityPageResponse>

describe('a grid\'s shared filter', () => {
  const grid = async (reader: (p: string) => Promise<Response> | Response) => json<GridLayout>(await reader('/v1/grid/user'))

  it('is kept beside the columns, and hides a condition on a field the reader may not see', async () => {
    const filter = [
      { field: 'job_title', op: 'neq', value: 'Seller' },
      { field: 'home_phone', op: 'eq', value: '555-0100' },
    ]
    expect((await admin('/v1/grid/user', put({ filter }))).status).toBe(200)
    // A change to the columns names no filter, so the filter stays.
    expect((await admin('/v1/grid/user', put({ columns: [{ id: 'f:job_title', hidden: true }] }))).status).toBe(200)
    expect(await grid(admin)).toEqual({ columns: [{ id: 'f:job_title', hidden: true }], filter })
    expect((await grid(insider)).filter).toEqual(filter)
    expect((await grid(outsider)).filter).toEqual([filter[0]])
  })

  it('is set only by someone who may arrange the views', async () => {
    expect((await outsider('/v1/grid/user', put({ filter: [] }))).status).toBe(403)
    expect((await grid(admin)).filter).toHaveLength(2)
    expect((await admin('/v1/grid/user', put({ filter: [] }))).status).toBe(200)
    expect((await grid(admin)).filter).toEqual([])
  })
})

describe('a grid\'s shared filter on a relation', () => {
  const grid = async (reader: (p: string) => Promise<Response> | Response) => json<GridLayout>(await reader('/v1/grid/workstation'))

  it('is kept as the column names it, and hidden from a reader who may not see the relation\'s target', async () => {
    const filter = [{ field: 'r:subnet', op: 'eq', value: 'core' }, { field: 'r:primary_user', op: 'exists', value: '' }]
    expect((await admin('/v1/grid/workstation', put({ filter }))).status).toBe(200)
    expect((await grid(insider)).filter).toEqual(filter)
    expect((await grid(outsider)).filter).toEqual([filter[1]])
    // What the outsider saves keeps the condition they were never shown.
    expect((await admin('/v1/grid/workstation', put({ filter: [] }))).status).toBe(200)
  })
})

describe('a search on a relation', () => {
  const keys = async (filter: unknown) => (await json<EntitiesResponse>(await admin(`/v1/entities?blueprint=user&filter=${encodeURIComponent(JSON.stringify(filter))}`))).entities.map((e) => e.key).sort()

  it('names its target by key or by title, and finds what does not point there with not', async () => {
    await admin('/v1/entities/team/platform', patch({ fields: { title: 'Platform Engineering' } }))
    expect(await keys({ relation: 'team', target: 'platform' })).toEqual(['ada@example.org'])
    expect(await keys({ relation: 'team', target: 'Platform Engineering' })).toEqual(['ada@example.org'])
    expect(await keys({ not: { relation: 'team', target: 'Platform Engineering' } })).toEqual(['bob@example.org', 'cy@example.org'])
  })
})

describe('a grid\'s shared sort', () => {
  const grid = async (reader: (p: string) => Promise<Response> | Response) => json<GridLayout>(await reader('/v1/grid/user'))

  it('is kept beside the columns, and left out for a reader who may not see its field', async () => {
    expect((await admin('/v1/grid/user', put({ sort: '-job_title' }))).status).toBe(200)
    expect((await admin('/v1/grid/user', put({ columns: [] }))).status).toBe(200)
    expect((await grid(outsider)).sort).toBe('-job_title')
    expect((await admin('/v1/grid/user', put({ sort: 'home_phone' }))).status).toBe(200)
    expect((await grid(insider)).sort).toBe('home_phone')
    expect(await grid(outsider)).not.toHaveProperty('sort')
  })

  it('is refused on a field the one who sets it may not see', async () => {
    await admin('/v1/roles/arranger', put({ title: 'Arranger', permissions: ['views.arrange'] }))
    await admin('/v1/users/bob%40example.org/roles', put({ roles: ['arranger'] }))
    expect((await outsider('/v1/grid/user', put({ sort: '-home_phone' }))).status).toBe(404)
    expect((await outsider('/v1/grid/user', put({ sort: 'job_title' }))).status).toBe(200)
    await admin('/v1/users/bob%40example.org/roles', put({ roles: [] }))
    expect((await grid(admin)).sort).toBe('job_title')
  })
})

describe('a restricted field', () => {
  it('is seen by a team, a department, and a person it names, and by an admin', async () => {
    expect((await person(insider, 'bob@example.org')).fields.home_phone).toBe('555-0101')
    expect((await person(named, 'bob@example.org')).fields.home_phone).toBe('555-0101')
    expect((await person(admin, 'bob@example.org')).fields.home_phone).toBe('555-0101')
  })

  it('is left out for everyone else, who still sees the person and the rest of them', async () => {
    const bob = await person(outsider, 'ada@example.org')
    expect(bob.fields.job_title).toBe('Engineer')
    expect(bob.fields).not.toHaveProperty('home_phone')
    expect(bob.fields).not.toHaveProperty('phone_known')
    // Nor is it said that something is kept from them.
    expect(bob).not.toHaveProperty('withheld')
    expect(bob.provenance).not.toHaveProperty('home_phone')
    const list = await json<EntitiesResponse>(await outsider('/v1/entities?blueprint=user&distribution=true'))
    expect(list.entities.map((e) => ('fields' in e ? e.fields : {})).every((f) => !('home_phone' in f))).toBe(true)
    expect(list.distribution ?? {}).not.toHaveProperty('f:home_phone')
  })

  it('cannot be found out by filtering, sorting, or picking it', async () => {
    const filter = encodeURIComponent(JSON.stringify({ field: 'home_phone', op: 'eq', value: '555-0100' }))
    expect((await outsider(`/v1/entities?blueprint=user&filter=${filter}`)).status).toBe(404)
    expect((await outsider('/v1/entities?blueprint=user&sort=home_phone')).status).toBe(404)
    const picked = await json<EntitiesResponse>(await outsider('/v1/entities?blueprint=user&fields=home_phone'))
    expect(picked.entities.length).toBeGreaterThan(0)
    expect(picked.entities.every((e) => !('home_phone' in e.fields))).toBe(true)
    // A free-text search reads every value it is allowed to and no other.
    const search = encodeURIComponent(JSON.stringify({ search: '555-0100' }))
    expect((await json<EntitiesResponse>(await outsider(`/v1/entities?blueprint=user&filter=${search}`))).total).toBe(0)
    expect((await json<EntitiesResponse>(await insider(`/v1/entities?blueprint=user&filter=${search}`))).total).toBe(1)
  })

  it('is left out of the blueprint a person who may not see it reads, rule and all', async () => {
    const outside = (await json<BlueprintsResponse>(await outsider('/v1/blueprints'))).blueprints.find((b) => b.id === 'user')!
    expect(outside.fields).not.toHaveProperty('home_phone')
    const inside = (await json<BlueprintsResponse>(await insider('/v1/blueprints'))).blueprints.find((b) => b.id === 'user')!
    expect(inside.fields.home_phone).toMatchObject({ type: 'string', restricted: true })
    expect(inside.fields.home_phone).not.toHaveProperty('access')
  })

  it('stays out of the activity log for those who may not see it', async () => {
    await admin('/v1/roles/auditor', put({ title: 'Auditor', permissions: ['audit.view'] }))
    await admin('/v1/users/bob%40example.org/roles', put({ roles: ['auditor'] }))
    const rows = (await json<ChangesResponse>(await outsider('/v1/changes?blueprint=subnet'))).changes
    expect(rows).toEqual([])
    await admin('/v1/users/bob%40example.org/roles', put({ roles: [] }))
  })
})

describe('a trend of a restricted field', () => {
  it('is withheld with the field it draws', async () => {
    const ada = { grants: [{ values: ['ada@example.org'] }] }
    expect((await admin('/v1/blueprints/meter', put({ id: 'meter', title: 'Meter', relations: {}, fields: { raw: { type: 'number' }, reading: { type: 'number', calculation: 'raw * 2', access: ada, history: { keep: '730d' } }, reading_trend: { type: 'trend', history: { of: 'reading', every: '1w', last: '104w' } } } }))).status).toBe(200)
    expect((await admin('/v1/entities', post({ blueprint: 'meter', key: 'm1', title: 'm1', fields: { raw: 7 } }))).status).toBe(201)
    const fields = async (reader: (p: string) => Promise<Response> | Response) => (await json<EntityPageResponse>(await reader('/v1/entities/meter/m1'))).fields
    expect(await fields(insider)).toHaveProperty('reading_trend')
    expect(await fields(outsider)).not.toHaveProperty('reading_trend')
    const outside = (await json<BlueprintsResponse>(await outsider('/v1/blueprints'))).blueprints.find((b) => b.id === 'meter')!
    expect(outside.fields).not.toHaveProperty('reading_trend')
  })
})

describe('a scorecard level that reads a restricted field', () => {
  it('is withheld from a filter, an entity, and an aggregation for a person who may not see the field', async () => {
    expect((await admin('/v1/scorecards/phone_listed', put({ blueprint: 'user', title: 'Phone listed', levels: [{ name: 'Listed', rules: [{ id: 'phone', title: 'Has a phone', where: { field: 'home_phone', op: 'exists' } }] }] }))).status).toBe(200)
    expect((await admin('/v1/blueprints/team', put({ id: 'team', title: 'Team', fields: { listed: { type: 'number', aggregation: { relation: '<-user:team', fn: 'count', where: { scorecard: 'phone_listed', op: 'eq', value: 'Listed' } } } }, relations: { department: { target: 'department' } } }))).status).toBe(200)
    const filter = encodeURIComponent(JSON.stringify({ scorecard: 'phone_listed', op: 'eq', value: 'Listed' }))
    expect((await json<EntitiesResponse>(await insider(`/v1/entities?blueprint=user&filter=${filter}`))).total).toBe(3)
    expect((await outsider(`/v1/entities?blueprint=user&filter=${filter}`)).status).toBe(404)
    expect((await person(insider, 'bob@example.org')).levels).toEqual({ phone_listed: ['Listed'] })
    expect((await person(outsider, 'bob@example.org')).levels).toEqual({})
    const team = async (reader: typeof admin) => json<EntityPageResponse>(await reader('/v1/entities/team/platform'))
    expect((await team(insider)).fields.listed).toBe(1)
    expect((await team(outsider)).fields).not.toHaveProperty('listed')
    await admin('/v1/blueprints/team', put({ id: 'team', title: 'Team', fields: {}, relations: { department: { target: 'department' } } }))
    await admin('/v1/scorecards/phone_listed', { method: 'DELETE' })
  })
})

describe('two blueprints whose roll-ups read each other', () => {
  it('still lists the model for a person', async () => {
    const save = async (id: string, spec: Record<string, unknown>) => expect((await admin(`/v1/blueprints/${id}`, put({ id, ...spec }))).status).toBe(200)
    await save('rack', { title: 'Rack', fields: { up: { type: 'boolean' }, hosts_on: { type: 'number', aggregation: { relation: '<-host:rack', fn: 'count', where: { field: 'on', op: 'eq', value: true } } } }, relations: {} })
    await save('host', { title: 'Host', fields: { on: { type: 'boolean' }, rack_up: { type: 'number', aggregation: { relation: 'rack', fn: 'count', where: { field: 'up', op: 'eq', value: true } } } }, relations: { rack: { target: 'rack' } } })
    for (const reader of [insider, outsider, named]) {
      const r = await reader('/v1/blueprints')
      expect(r.status).toBe(200)
      expect((await json<BlueprintsResponse>(r)).blueprints.map((b) => b.id)).toEqual(expect.arrayContaining(['rack', 'host']))
    }
    await admin('/v1/blueprints/host', { method: 'DELETE' })
    await admin('/v1/blueprints/rack', { method: 'DELETE' })
  })
})

describe('a restricted blueprint', () => {
  it('is not there for a person outside its grants', async () => {
    expect((await json<BlueprintsResponse>(await outsider('/v1/blueprints'))).blueprints.map((b) => b.id)).not.toContain('subnet')
    expect((await outsider('/v1/entities?blueprint=subnet')).status).toBe(404)
    expect((await outsider('/v1/entities/subnet/core')).status).toBe(404)
    expect((await json<EntitiesResponse>(await outsider('/v1/entities'))).entities.map((e) => ('blueprint' in e ? e.blueprint : ''))).not.toContain('subnet')
  })

  it('is not there where an open entity points at it, nor where it points at an open entity', async () => {
    const pc = await json<EntityPageResponse>(await outsider('/v1/entities/workstation/pc-1'))
    expect(pc.outgoing.map((o) => o.relation)).not.toContain('subnet')
    expect(pc.relations).not.toHaveProperty('subnet')
    expect(JSON.stringify(pc)).not.toContain('restricted')
    const bob = await json<EntityPageResponse>(await outsider('/v1/entities/user/bob%40example.org'))
    expect(bob.incoming.map((i) => i.declaredOn)).not.toContain('badge')
    expect(bob.incoming.map((i) => i.declaredOn)).toContain('workstation')
    // Nor is the relation described on the blueprint, to a person or to an agent.
    const workstation = (await json<BlueprintsResponse>(await outsider('/v1/blueprints'))).blueprints.find((b) => b.id === 'workstation')!
    expect(workstation.relations).not.toHaveProperty('subnet')
    expect(workstation.relations).toHaveProperty('primary_user')
    // Nor in a grid block, with what points at each row.
    const block = await json<EntitiesResponse>(await outsider('/v1/entities?blueprint=user&incoming=true'))
    const row = block.entities.find((e) => 'key' in e && e.key === 'bob@example.org') as { incomingRefs?: Record<string, unknown>; incomingCount?: Record<string, unknown> } | undefined
    expect(Object.keys(row?.incomingRefs ?? {})).not.toContain('badge.holder')
    expect(Object.keys(row?.incomingCount ?? {})).not.toContain('badge.holder')
    // An open person it points at is shown and followed.
    expect(pc.relations.primary_user?.[0]).toMatchObject({ key: 'bob@example.org', title: 'bob@example.org' })
    const walked = await json<{ nodes: { blueprint: string }[] }>(await outsider('/v1/entities/workstation/pc-1/related?depth=2'))
    expect(walked.nodes.map((n) => n.blueprint)).not.toContain('subnet')
  })

  it('cannot be found out by filtering, grouping, or editing on the relation', async () => {
    const has = encodeURIComponent(JSON.stringify({ relation: 'subnet' }))
    expect((await outsider(`/v1/entities?blueprint=workstation&filter=${has}`)).status).toBe(404)
    const held = encodeURIComponent(JSON.stringify({ relation: '<-badge:holder' }))
    expect((await outsider(`/v1/entities?blueprint=user&filter=${held}`)).status).toBe(404)
    expect((await outsider('/v1/entities?blueprint=workstation&group=r:subnet')).status).toBe(404)
    expect((await insider(`/v1/entities?blueprint=workstation&filter=${has}`)).status).toBe(200)
  })

  it('is seen in full by the team it grants', async () => {
    expect((await json<EntityPageResponse>(await insider('/v1/entities/subnet/core'))).fields.cidr).toBe('10.0.0.0/24')
    expect((await json<EntityPageResponse>(await insider('/v1/entities/workstation/pc-1'))).relations.subnet?.[0]).toMatchObject({ key: 'core' })
    expect((await json<EntityPageResponse>(await insider('/v1/entities/user/bob%40example.org'))).incoming.map((i) => i.declaredOn)).toContain('badge')
  })

  it("is out of reach for an agent with a person's token, and in reach for a machine token", async () => {
    const { token } = await json<TokenIssued>(await outsider('/v1/me/tokens', post({ name: 'my agent' })))
    expect((await bearer(token)('/v1/entities/subnet/core')).status).toBe(404)
    expect((await person(bearer(token), 'ada@example.org')).fields).not.toHaveProperty('home_phone')
    const machine = (await hub.sources.issueToken('access', 'reader', { role: 'viewer' })).token
    expect((await bearer(machine)('/v1/entities/subnet/core')).status).toBe(200)
  })
})

describe('a blueprint whose timeline is kept to some', () => {
  const laptop = { title: 'Laptop', fields: { serial: { type: 'string' } }, relations: {}, timeline: { grants: [{ path: 'team', values: ['platform'] }] } }
  const page = async (reader: (p: string) => Promise<Response> | Response) => json<EntityPageResponse>(await reader('/v1/entities/laptop/lt-1'))
  const shownTo = async (reader: (p: string) => Promise<Response> | Response) => (await json<BlueprintsResponse>(await reader('/v1/blueprints'))).blueprints.find((b) => b.id === 'laptop')!

  beforeAll(async () => {
    expect((await admin('/v1/blueprints/laptop', put({ id: 'laptop', ...laptop }))).status).toBe(200)
    expect((await admin('/v1/entities', post({ blueprint: 'laptop', key: 'lt-1', title: 'lt-1', fields: { serial: 'L1' } }))).status).toBe(201)
    expect((await admin('/v1/entities/laptop/lt-1', patch({ fields: { serial: 'L2' } }))).status).toBe(200)
  })

  // Its grant reads the team, which makes the team an admin's alone while the rule stands.
  afterAll(async () => {
    const { timeline: _t, ...open } = laptop
    expect((await admin('/v1/blueprints/laptop', put({ id: 'laptop', ...open }))).status).toBe(200)
  })

  it('shows the entity to everyone and its timeline only to whom the rule lets in', async () => {
    const outside = await page(outsider)
    expect(outside.fields.serial).toBe('L2')
    expect(outside.changes).toEqual([])
    expect((await page(insider)).changes.length).toBeGreaterThan(0)
    expect((await page(admin)).changes.length).toBeGreaterThan(0)
  })

  it('tells a reader kept out only that there is no timeline, and never the rule', async () => {
    const outside = await shownTo(outsider)
    expect(outside.noTimeline).toBe(true)
    expect(outside).not.toHaveProperty('timeline')
    const inside = await shownTo(insider)
    expect(inside).not.toHaveProperty('noTimeline')
    expect(inside).not.toHaveProperty('timeline')
    expect((await shownTo(admin)).timeline).toEqual(laptop.timeline)
  })

  it('keeps the entity\'s rows out of the activity log for whoever the rule keeps out', async () => {
    const { token } = await json<TokenIssued>(await outsider('/v1/me/tokens', post({ name: 'timeline agent' })))
    const read = await bearer(token)('/v1/entities/laptop/lt-1')
    expect((await json<EntityPageResponse>(read)).changes).toEqual([])
  })

  it('names who reads it by grants and audiences alone', async () => {
    expect((await admin('/v1/blueprints/laptop', put({ id: 'laptop', ...laptop, timeline: { grants: [], owners: { roles: ['owner'], fields: 'all' } } }))).status).toBe(400)
    expect((await admin('/v1/blueprints/laptop', put({ id: 'laptop', ...laptop, timeline: { grants: [], audiences: ['nobody-here'] } }))).status).toBe(400)
  })
})

describe('an action on a restricted blueprint', () => {
  it('is not there, and cannot be run, for a person who may not see the blueprint', async () => {
    const res = await admin('/v1/actions/rotate', put({ title: 'Rotate', blueprint: 'subnet', inputs: {}, backend: { type: 'webhook', url: 'https://example.org/hook' } }))
    expect(res.status).toBe(200)
    expect((await json<{ actions: { id: string }[] }>(await outsider('/v1/actions'))).actions.map((a) => a.id)).not.toContain('rotate')
    expect((await outsider('/v1/actions/rotate')).status).toBe(404)
    expect((await insider('/v1/actions/rotate')).status).toBe(200)
    await admin('/v1/actions/rotate', { method: 'DELETE' })
  })

  it('refuses an entity input the person may not see, as if it did not exist', async () => {
    const hook = { type: 'webhook', url: 'https://example.org/hook' }
    expect((await admin('/v1/actions/attach', put({ title: 'Attach', blueprint: 'workstation', inputs: { net: { type: 'entity', blueprint: 'subnet', required: true } }, backend: hook, approval: true }))).status).toBe(200)
    await admin('/v1/roles/runner', put({ title: 'Runner', permissions: ['actions.run'] }))
    await admin('/v1/users/bob%40example.org/roles', put({ roles: ['runner'] }))
    const asked = await outsider('/v1/actions/attach/run', post({ entity: { blueprint: 'workstation', key: 'pc-1' }, inputs: { net: 'subnet:core' } }))
    expect(asked.status).toBe(404)
    await admin('/v1/users/bob%40example.org/roles', put({ roles: [] }))
    await admin('/v1/actions/attach', { method: 'DELETE' })
  })

  it("hands a job only the fields the person who asked for it may see", async () => {
    await hub.sources.save('jobs', { title: 'jobs', class: 'runner', blueprints: [], deleteGrant: [], cadence: null })
    const { token } = await hub.sources.issueToken('source', 'jobs', { source: 'jobs' })
    const job = { type: 'runner', runner: 'jobs', command: ['echo', '{{ entity.fields.home_phone }}'] }
    expect((await admin('/v1/actions/dial', put({ title: 'Dial', blueprint: 'user', inputs: {}, backend: job, access: { grants: [{ values: ['bob@example.org'] }] } }))).status).toBe(200)
    expect((await outsider('/v1/actions/dial/run', post({ entity: { blueprint: 'user', key: 'cy@example.org' } }))).status).toBe(201)
    const { jobs } = await json<{ jobs: { command: string[] }[] }>(await bearer(token)('/v1/ingest/runner/jobs'))
    expect(jobs[0]!.command).toEqual(['echo', ''])
    await admin('/v1/actions/dial', { method: 'DELETE' })
  })
})

describe('the blueprints access is decided from', () => {
  it('are the person blueprint, every blueprint a grant reads through, and any marked so', () => {
    const ids = hub.visibility.adminOnlyIds()
    expect(ids).toEqual(expect.arrayContaining(['user', 'team', 'department']))
    expect(ids).not.toContain('workstation')
    expect(adminOnlyBlueprints([{ id: 'x', title: 'X', fields: {}, relations: {}, adminEdit: true, origin: { kind: 'ui' }, updatedAt: '' }], null)).toEqual(new Set(['x']))
  })

  it('take no change from anyone but an admin, an architect included', async () => {
    await admin('/v1/users/bob%40example.org/roles', put({ roles: ['architect'] }))
    // Joining a team would hand out what the team sees.
    expect((await outsider('/v1/entities/user/bob%40example.org', patch({ relations: { team: ['platform'] } }))).status).toBe(403)
    expect((await outsider('/v1/entities', post({ blueprint: 'team', key: 'mine', title: 'Mine' }))).status).toBe(403)
    expect((await outsider('/v1/blueprints/team', put({ id: 'team', title: 'Team', fields: {}, relations: { department: { target: 'department' } } }))).status).toBe(403)
    expect((await outsider('/v1/blueprints/team/rename', post({ to: 'squad' }))).status).toBe(403)
    // An open blueprint is theirs to edit as before.
    expect((await outsider('/v1/entities/workstation/pc-1', patch({ fields: { serial: 'S2' } }))).status).toBe(200)
    // A relation to a blueprint they may not see is not there for them: clearing it would tell them it was.
    expect((await outsider('/v1/entities/workstation/pc-1', patch({ relations: { subnet: null } }))).status).toBe(404)
    expect((await admin('/v1/entities/user/bob%40example.org', patch({ fields: { job_title: 'Account lead' } }))).status).toBe(200)
  })

  it('keep their rules when an architect saves a blueprint, and refuse a rule they send', async () => {
    const bp = (await json<BlueprintsResponse>(await outsider('/v1/blueprints'))).blueprints.find((b) => b.id === 'workstation')!
    const { origin: _o, updatedAt: _u, ...spec } = bp
    expect((await outsider('/v1/blueprints/workstation', put({ ...spec, description: 'A computer' }))).status).toBe(200)
    // The relation they were never shown is kept as it was.
    expect(hub.blueprints.get('workstation')?.relations.subnet).toMatchObject({ target: 'subnet' })
    expect((await outsider('/v1/blueprints/workstation', put({ ...spec, access: { grants: [{ values: ['bob@example.org'] }] } }))).status).toBe(403)
    const user = (await json<BlueprintsResponse>(await outsider('/v1/blueprints'))).blueprints.find((b) => b.id === 'user')!
    expect(user.fields).not.toHaveProperty('home_phone')
    await admin('/v1/users/bob%40example.org/roles', put({ roles: [] }))
  })

  it('come and go with the grants that read them', async () => {
    await admin('/v1/blueprints/subnet', put({ id: 'subnet', title: 'Subnet', fields: { cidr: { type: 'string' } }, relations: {}, access: { grants: [{ values: ['ada@example.org'] }] } }))
    await admin('/v1/blueprints/user', put({ id: 'user', title: 'Person', fields: { job_title: { type: 'string' } }, relations: { team: { target: 'team', many: true }, department: { target: 'department' } } }))
    expect(hub.visibility.adminOnlyIds()).toEqual(['user'])
    expect((await outsider('/v1/entities/subnet/core')).status).toBe(404)
    expect((await insider('/v1/entities/subnet/core')).status).toBe(200)
  })
})

describe("a person's own tokens", () => {
  it('are made, rotated, and revoked by the person, and act as them', async () => {
    const made = await json<TokenIssued>(await insider('/v1/me/tokens', post({ name: 'laptop agent' })))
    expect(made.kind).toBe('personal')
    expect((await json<{ identity: { name: string; kind: string } }>(await bearer(made.token)('/v1/whoami'))).identity).toMatchObject({ kind: 'user', name: 'ada@example.org' })
    const rotated = await json<TokenIssued>(await insider(`/v1/me/tokens/${made.id}/rotate`, { method: 'POST' }))
    expect((await bearer(made.token)('/v1/whoami')).status).toBe(401)
    expect((await bearer(rotated.token)('/v1/whoami')).status).toBe(200)
    // Another person's token is not theirs to touch.
    expect((await outsider(`/v1/me/tokens/${made.id}`, { method: 'DELETE' })).status).toBe(404)
    expect((await insider(`/v1/me/tokens/${made.id}`, { method: 'DELETE' })).status).toBe(200)
    expect((await bearer(rotated.token)('/v1/whoami')).status).toBe(401)
  })

  it("cannot make more tokens, and leave the agent's work under the person's name", async () => {
    const { token } = await json<TokenIssued>(await insider('/v1/me/tokens', post({ name: 'agent' })))
    expect((await bearer(token)('/v1/me/tokens', post({ name: 'another' }))).status).toBe(403)
    await admin('/v1/users/ada%40example.org/roles', put({ roles: ['contributor'] }))
    expect((await bearer(token)('/v1/entities/workstation/pc-1', patch({ fields: { serial: 'S3' } }))).status).toBe(200)
    const rows = (await json<ChangesResponse>(await admin('/v1/changes?blueprint=workstation&kind=entity.updated'))).changes
    expect(rows[0]).toMatchObject({ actor: 'ada@example.org', actorKind: 'user' })
  })

  it('go with their person', async () => {
    const { token } = await json<TokenIssued>(await insider('/v1/me/tokens', post({ name: 'kept' })))
    await admin('/v1/users/ada%40example.org', { method: 'DELETE' })
    expect((await bearer(token)('/v1/whoami')).status).toBe(401)
  })
})

describe("the hub's own blueprints", () => {
  const listed = async (reader: (p: string) => Promise<Response> | Response) => (await json<BlueprintsResponse>(await reader('/v1/blueprints'))).blueprints.map((b) => b.id)

  it('are seen by admins only until an admin shares them', async () => {
    expect(await listed(admin)).toEqual(expect.arrayContaining(['orrery_source', 'orrery_runner']))
    expect(await listed(insider)).not.toContain('orrery_source')
    expect(await listed(insider)).not.toContain('orrery_runner')
    expect((await insider('/v1/entities?blueprint=orrery_source')).status).not.toBe(200)
  })

  it('are left off the wall for a reader who may not see them', async () => {
    const sourcesOn = async (reader: (p: string) => Promise<Response> | Response) => (await json<WallResponse>(await reader('/v1/wall'))).sources.map((s) => s.id)
    expect((await sourcesOn(admin)).length).toBeGreaterThan(0)
    expect(await sourcesOn(insider)).toEqual([])
  })

  it('are shared with a team by an admin, and by nobody else', async () => {
    const share = { access: { grants: [{ path: 'team', values: ['platform'] }] } }
    expect((await insider('/v1/access/hub-blueprints/orrery_source', put(share))).status).toBe(403)
    expect((await admin('/v1/access/hub-blueprints/subnet', put(share))).status).toBe(404)
    expect((await admin('/v1/access/hub-blueprints/orrery_source', put(share))).status).toBe(200)
    expect(await listed(insider)).toContain('orrery_source')
    expect(await listed(outsider)).not.toContain('orrery_source')
    expect(await listed(insider)).not.toContain('orrery_runner')
    // The rest of the blueprint stays the hub's.
    expect((await admin('/v1/blueprints/orrery_source', put({ title: 'Mine now', fields: {}, relations: {} }))).status).toBe(400)
  })

  it('keep what an admin gave across a restart, and go back to admins only when it is cleared', async () => {
    await hub.close()
    hub = await createHub(loadConfig({ DATABASE_URL, DATA_DIR: mkdtempSync(join(tmpdir(), 'orrery-')), AUTH_MODE: 'proxy' }), 'test')
    expect(await listed(insider)).toContain('orrery_source')
    expect((await admin('/v1/access/hub-blueprints/orrery_source', put({ access: null }))).status).toBe(200)
    expect(await listed(insider)).not.toContain('orrery_source')
  })
})

describe('a rolled-up reason', () => {
  it('is withheld when it came from a blueprint the reader may not see, in a grid block and in a list', async () => {
    const save = async (id: string, spec: Record<string, unknown>) => expect((await admin(`/v1/blueprints/${id}`, put({ id, ...spec }))).status).toBe(200)
    await save('closet', { title: 'Closet', fields: { health: { type: 'enum', values: ['red', 'amber', 'green', 'grey'] }, health_reason: { type: 'string' } }, relations: {}, status: { field: 'health' }, access: { grants: [{ path: 'team', values: ['platform'] }] } })
    await save('desk', { title: 'Desk', fields: {}, relations: { closet: { target: 'closet' } }, status: { relations: ['closet'] } })
    expect((await admin('/v1/entities', post({ blueprint: 'closet', key: 'c1', title: 'c1', fields: { health: 'red', health_reason: 'flooded' } }))).status).toBe(201)
    expect((await admin('/v1/entities', post({ blueprint: 'desk', key: 'd1', title: 'd1', relations: { closet: 'c1' } }))).status).toBe(201)
    // The last reads who points at each row, so the rows are copied before the reader's view is put on them.
    const pointedAt = encodeURIComponent(JSON.stringify({ or: [{ relation: '<-closet' }, { search: 'd1' }] }))
    for (const query of ['distribution=true&incoming=true', 'incoming=true&layers=true', `filter=${pointedAt}`]) {
      const reasons = async (reader: (p: string) => Promise<Response> | Response) => (await json<EntitiesResponse>(await reader(`/v1/entities?blueprint=desk&${query}&limit=100`))).entities.find((e) => e.key === 'd1')!.status.reasons
      expect(await reasons(admin)).toEqual(['c1: flooded'])
      expect(await reasons(outsider)).toEqual(['something you cannot see is not green'])
    }
  })

  it('is withheld when a status field gave it and the reader may not read that field', async () => {
    const save = async (id: string, spec: Record<string, unknown>) => expect((await admin(`/v1/blueprints/${id}`, put({ id, ...spec }))).status).toBe(200)
    const platform = { grants: [{ path: 'team', values: ['platform'] }] }
    await save('badge', { title: 'Badge', fields: { health: { type: 'enum', values: ['red', 'amber', 'green', 'grey'], access: platform }, health_reason: { type: 'string', access: platform } }, relations: {}, status: { field: 'health' } })
    expect((await admin('/v1/entities', post({ blueprint: 'badge', key: 'b1', title: 'b1', fields: { health: 'red', health_reason: 'at risk' } }))).status).toBe(201)
    const reasons = async (reader: (p: string) => Promise<Response> | Response) => (await json<EntityPageResponse>(await reader('/v1/entities/badge/b1'))).status.reasons
    expect(await reasons(insider)).toEqual(['at risk'])
    expect(await reasons(outsider)).toEqual(['something you cannot see is not green'])
    const listed = (await json<EntitiesResponse>(await outsider('/v1/entities?blueprint=badge'))).entities.find((e) => e.key === 'b1')!
    expect(listed.status.reasons).toEqual(['something you cannot see is not green'])
  })

  it('is withheld on the front page too, and a blueprint the reader may not see is neither named nor counted', async () => {
    const front = async (reader: (p: string) => Promise<Response> | Response) => json<SummaryResponse>(await reader('/v1/summary'))
    expect((await front(admin)).blueprints.find((b) => b.id === 'closet')?.notGreen.red).toBe(1)
    const theirs = await front(outsider)
    expect(theirs.blueprints.some((b) => b.id === 'closet')).toBe(false)
    expect(theirs.notGreen.some((n) => n.entity.blueprint === 'closet')).toBe(false)
    // A level is the same whoever reads it, so the desk counts red for them too; only the reason behind it is withheld.
    expect(theirs.blueprints.find((b) => b.id === 'desk')?.notGreen.red).toBe(1)
    expect(JSON.stringify(theirs)).not.toContain('flooded')
  })

})

describe('what a person owns', () => {
  const mine = async (reader: (p: string) => Promise<Response> | Response) => json<MineResponse>(await reader('/v1/mine'))

  it('is unknown until the model says, then reaches what names the person, and never what they may not see', async () => {
    expect(await mine(outsider)).toMatchObject({ state: 'unset', seesAll: false, things: [] })
    // A path the person blueprint does not have could never reach anything.
    expect((await admin('/v1/access/person', put({ blueprint: 'user', owns: ['nowhere'] }))).status).toBe(400)
    // An estate names a path for each role it counts, so the setting holds many; a runaway list is still refused.
    const roles = (n: number) => Array.from({ length: n }, (_, i) => ({ as: `role_${i}`, path: '<-primary_user' }))
    expect((await admin('/v1/access/person', put({ blueprint: 'user', owns: roles(60) }))).status).toBe(200)
    expect((await admin('/v1/access/person', put({ blueprint: 'user', owns: roles(61) }))).status).toBe(400)
    expect((await admin('/v1/access/person', put({ blueprint: 'user', owns: ['<-primary_user'] }))).status).toBe(200)
    // A badge is theirs too, but only the platform team sees badges.
    const save = async (id: string, spec: Record<string, unknown>) => expect((await admin(`/v1/blueprints/${id}`, put({ id, ...spec }))).status).toBe(200)
    await save('badge', { title: 'Badge', fields: {}, relations: { primary_user: { target: 'user' } }, access: { grants: [{ path: 'team', values: ['platform'] }] } })
    expect((await admin('/v1/entities', post({ blueprint: 'badge', key: 'b-bob', title: 'b-bob', relations: { primary_user: 'bob@example.org' } }))).status).toBe(201)

    const bob = await mine(outsider)
    expect(bob).toMatchObject({ state: 'known', seesAll: false, person: { entity: { blueprint: 'user', key: 'bob@example.org' } } })
    expect(bob.things.map((t) => t.entity.key)).toEqual(['pc-1'])
    // Each thing is put through the reader's view: a field they may not read is not on it.
    expect(bob.things[0]).toMatchObject({ entity: { blueprint: 'workstation', key: 'pc-1' }, title: 'pc-1' })
    expect(Object.keys(bob.blueprints)).toEqual(['workstation'])
    expect(JSON.stringify(bob)).not.toContain('b-bob')
    expect((await mine(insider)).things).toEqual([])
    expect(await mine(as('dan@example.org'))).toMatchObject({ state: 'unknown', things: [] })
    expect((await mine(admin)).seesAll).toBe(true)

    expect((await json<EntityPageResponse>(await outsider('/v1/entities/workstation/pc-1'))).yours).toBe(true)
    expect((await json<EntityPageResponse>(await insider('/v1/entities/workstation/pc-1'))).yours).toBe(false)
    expect((await admin('/v1/access/person', put({ blueprint: 'user' }))).status).toBe(200)
    expect((await mine(outsider)).state).toBe('unset')
  })

  it('counts what of theirs is green from its stored row, and reads whole only what is not', async () => {
    const save = async (id: string, spec: Record<string, unknown>) => expect((await admin(`/v1/blueprints/${id}`, put({ id, ...spec }))).status).toBe(200)
    await save('lamp', { title: 'Lamp', fields: { health: { type: 'enum', values: ['red', 'amber', 'green', 'grey'] } }, relations: { primary_user: { target: 'user' } }, status: { field: 'health' } })
    for (const [key, health] of [['lit', 'green'], ['out', 'red']]) expect((await admin('/v1/entities', post({ blueprint: 'lamp', key, title: key, fields: { health }, relations: { primary_user: 'bob@example.org' } }))).status).toBe(201)
    expect((await admin('/v1/access/person', put({ blueprint: 'user', owns: ['<-primary_user'] }))).status).toBe(200)
    const read = vi.spyOn(hub.reader, 'hydrated')
    try {
      // Asked first, so nothing kept for the whole answer stands in for it.
      const slim = await json<MineResponse>(await outsider('/v1/mine?green=false'))
      const slimRead = read.mock.calls.flatMap(([refs]) => refs.map((r) => r.key))
      const whole = await mine(outsider)
      expect(whole.things.find((t) => t.entity.key === 'lit')?.level).toBe('green')
      expect(slim.count).toBe(whole.count)
      expect(slim.blueprints).toEqual(whole.blueprints)
      expect(slim.things).toEqual(whole.things.filter((t) => t.level !== 'green'))
      expect(slim.things.map((t) => t.entity.key)).toContain('out')
      expect(slimRead).toContain('out')
      expect(slimRead).not.toContain('lit')
    } finally {
      read.mockRestore()
      await admin('/v1/blueprints/lamp', { method: 'DELETE' })
      expect((await admin('/v1/access/person', put({ blueprint: 'user' }))).status).toBe(200)
    }
  })

  it('marks the alerts and scorecard rows that touch what is theirs, so a page needs only what of theirs is not green', async () => {
    expect((await admin('/v1/access/person', put({ blueprint: 'user', owns: ['<-primary_user'] }))).status).toBe(200)
    const whole = await mine(outsider)
    expect(whole.count).toBe(whole.things.length)
    const slim = await json<MineResponse>(await outsider('/v1/mine?green=false'))
    expect(slim.count).toBe(whole.count)
    expect(slim.things).toEqual(whole.things.filter((t) => t.level !== 'green'))

    await hub.db.query(`INSERT INTO alerts (fingerprint, source, status, labels, annotations, blueprint, key) VALUES ('on-pc', 'am', 'firing', '{}', '{}', 'workstation', 'pc-1'), ('loose', 'am', 'firing', '{}', '{}', NULL, NULL)`)
    const marks = async (reader: (p: string) => Promise<Response> | Response) => Object.fromEntries((await json<{ alerts: Alert[] }>(await reader('/v1/alerts'))).alerts.map((a) => [a.fingerprint, a.yours]))
    expect((await marks(outsider))['on-pc']).toBe(true)
    expect(await marks(insider)).toMatchObject({ 'on-pc': false })
    expect((await marks(admin))['on-pc']).toBeUndefined()

    expect((await admin('/v1/scorecards/serial_known', put({ blueprint: 'workstation', title: 'Serial known', levels: [{ name: 'Known', rules: [{ id: 'serial', title: 'Has a serial', where: { field: 'serial', op: 'exists' } }] }] }))).status).toBe(200)
    const rows = async (reader: (p: string) => Promise<Response> | Response) => (await json<ScorecardResults>(await reader('/v1/scorecards/serial_known/results'))).rows.find((r) => r.entity.key === 'pc-1')?.yours
    expect(await rows(outsider)).toBe(true)
    expect(await rows(insider)).toBe(false)

    // A reader the hub knows nothing of is never told something is theirs, nor that it is not.
    expect((await admin('/v1/access/person', put({ blueprint: 'user' }))).status).toBe(200)
    expect((await marks(outsider))['on-pc']).toBeUndefined()
    await admin('/v1/scorecards/serial_known', { method: 'DELETE' })
    await hub.db.query(`DELETE FROM alerts WHERE fingerprint IN ('on-pc', 'loose')`)
  })

  it('keeps what is theirs while only what is not theirs moves, and reads only their own rows to build it', async () => {
    expect((await admin('/v1/access/person', put({ blueprint: 'user', owns: ['<-primary_user'] }))).status).toBe(200)
    expect((await admin('/v1/blueprints/lamp', put({ id: 'lamp', title: 'Lamp', fields: {}, relations: {} }))).status).toBe(200)
    expect((await mine(outsider)).things.map((t) => t.entity.key)).toEqual(['pc-1'])
    const lists = vi.spyOn(hub.reader, 'list')
    const rows = vi.spyOn(hub.reader, 'hydrated')
    try {
      // Nothing of theirs, and nothing their things are reached through.
      expect((await admin('/v1/entities', post({ blueprint: 'lamp', key: 'l1', title: 'l1' }))).status).toBe(201)
      expect((await mine(outsider)).things.map((t) => t.entity.key)).toEqual(['pc-1'])
      expect(rows).not.toHaveBeenCalled()
      // Something of theirs moves: built again, from their own rows alone.
      expect((await admin('/v1/entities/workstation/pc-1', { method: 'PATCH', body: JSON.stringify({ fields: { title: 'pc-1 renamed' } }) })).status).toBe(200)
      expect((await mine(outsider)).things.map((t) => t.title)).toEqual(['pc-1 renamed'])
      expect(rows.mock.calls.map(([refs]) => refs.map((r) => r.key))).toContainEqual(['pc-1'])
      expect(lists.mock.calls.filter(([o]) => o?.blueprint === 'workstation')).toEqual([])
    } finally {
      lists.mockRestore()
      rows.mockRestore()
      await admin('/v1/entities/workstation/pc-1', { method: 'PATCH', body: JSON.stringify({ fields: { title: null } }) })
      await admin('/v1/blueprints/lamp', { method: 'DELETE' })
      expect((await admin('/v1/access/person', put({ blueprint: 'user' }))).status).toBe(200)
    }
  })

  it('counts the estate once for every reader, and cuts each reader their own summary from it', async () => {
    const counted: string[] = []
    const query = hub.db.query.bind(hub.db)
    hub.db.query = ((...args: Parameters<typeof query>) => (counted.push(String(args[0])), query(...args))) as typeof hub.db.query
    try {
      // Something moves, so every summary is built again.
      expect((await admin('/v1/entities', post({ blueprint: 'workstation', key: 'pc-count', title: 'pc-count' }))).status).toBe(201)
      const [theirs, ours] = await Promise.all([json<SummaryResponse>(await outsider('/v1/summary')), json<SummaryResponse>(await insider('/v1/summary'))])
      expect(theirs.blueprints.find((b) => b.id === 'workstation')?.active).toBe(ours.blueprints.find((b) => b.id === 'workstation')?.active)
    } finally {
      hub.db.query = query
      await admin('/v1/entities/workstation/pc-count', { method: 'DELETE' })
    }
    expect(counted.filter((sql) => sql.includes('GROUP BY blueprint, state')).length).toBe(1)
  })

  it('says how each thing is theirs, every way a path reached it', async () => {
    const owns = [{ as: 'user', path: '<-primary_user' }, { as: 'owner', path: '<-primary_user' }, 'team']
    expect((await admin('/v1/access/person', put({ blueprint: 'user', owns }))).status).toBe(200)
    expect((await json<{ person: { owns: unknown } }>(await admin('/v1/access'))).person.owns).toEqual(owns)
    const bob = await mine(outsider)
    expect(bob.things.find((t) => t.entity.key === 'pc-1')?.as).toEqual(['user', 'owner'])
    // A plain path reaches its things with no role.
    expect(bob.things.filter((t) => t.entity.blueprint === 'team').every((t) => t.as.length === 0)).toBe(true)
    expect((await json<EntityPageResponse>(await outsider('/v1/entities/workstation/pc-1'))).yoursAs).toEqual(['user', 'owner'])
    expect((await json<EntityPageResponse>(await insider('/v1/entities/workstation/pc-1'))).yoursAs).toEqual([])
    expect((await admin('/v1/access/person', put({ blueprint: 'user', owns: [{ as: 'qa', path: 'nowhere' }] }))).status).toBe(400)
    expect((await admin('/v1/access/person', put({ blueprint: 'user' }))).status).toBe(200)
  })
})

describe('an alert matched to nothing', () => {
  it('is seen only by a reader who sees everything, since its labels may name anything', async () => {
    await hub.sources.save('alertmanager', { title: 'Alertmanager', class: 'event', blueprints: [], deleteGrant: [], cadence: null })
    const token = (await hub.sources.issueToken('source', 'am', { source: 'alertmanager' })).token
    const alert = { status: 'firing', labels: { alertname: 'HostDown', instance: 'secret-host' }, annotations: {}, startsAt: new Date().toISOString(), fingerprint: 'u1' }
    expect((await bearer(token)('/v1/ingest/alerts/alertmanager', post({ alerts: [alert] }))).status).toBe(200)
    const fingerprints = async (reader: (p: string) => Promise<Response> | Response) => (await json<{ alerts: { fingerprint: string }[] }>(await reader('/v1/alerts'))).alerts.map((a) => a.fingerprint)
    expect(await fingerprints(admin)).toContain('u1')
    expect(await fingerprints(outsider)).not.toContain('u1')
  })
})

describe('what a person may see, kept', () => {
  const ada = { kind: 'user' as const, name: 'ada@example.org', admin: false, roles: [], permissions: [] }

  it('is kept while only what decides nobody\'s access moves', async () => {
    const before = (await hub.visibility.view(ada)).basis
    hub.events.emit({ type: 'estate', blueprints: ['workstation'] })
    hub.events.emit({ type: 'entity', blueprint: 'workstation', key: 'pc-1' })
    hub.events.emit({ type: 'action_run', id: 'r1' })
    expect((await hub.visibility.view(ada)).basis).toBe(before)
  })

  it('reaches the same entities without their values as with them', async () => {
    const people = ['ada@example.org', 'bob@example.org', 'cy@example.org'].map((key) => ({ blueprint: 'user', key }))
    const paths = ['team', 'team.department', '<-primary_user', '<-primary_user.subnet', '<-holder', '<-team:department']
    const whole = await hub.reader.followAll(people, paths)
    const reached = await hub.reader.reachAll(people, paths)
    for (const path of paths) for (const [id, ends] of whole.get(path)!) expect(reached.get(path)!.get(id)).toEqual(ends.map((e) => e.id))
    expect(reached.get('<-primary_user.subnet')!.get('user:bob@example.org')).toEqual(['subnet:core'])
  })

  it('keeps the same basis when it is worked out again to the same answer, and a new one when the answer moves', async () => {
    const before = (await hub.visibility.view(ada)).basis
    hub.events.emit({ type: 'estate' })
    hub.events.emit({ type: 'derived', blueprints: ['user'], titled: ['user'] })
    expect((await hub.visibility.view(ada)).basis).toBe(before)
    expect((await admin('/v1/entities/user/ada%40example.org', patch({ relations: { team: ['platform', 'sales'] } }))).status).toBe(200)
    const moved = (await hub.visibility.view(ada)).basis
    expect(moved).not.toBe(before)
    expect((await admin('/v1/entities/user/ada%40example.org', patch({ relations: { team: ['platform'] } }))).status).toBe(200)
    expect((await hub.visibility.view(ada)).basis).not.toBe(moved)
  })
})

describe('a blueprint opened to its owners', () => {
  const platform = [{ path: 'team', values: ['platform'] }]
  const save = async (id: string, spec: Record<string, unknown>) => expect((await admin(`/v1/blueprints/${id}`, put({ id, ...spec }))).status).toBe(200)
  const drive = (fields: string[] | 'all') => ({
    title: 'Drive',
    fields: { url: { type: 'url' }, quota: { type: 'number' }, secret_note: { type: 'string' }, price: { type: 'number', access: { grants: platform } } },
    relations: { holder: { target: 'user' }, watcher: { target: 'user' }, subnet: { target: 'subnet' } },
    access: { grants: platform, owners: { roles: ['owner'], fields } },
  })
  const page = async (reader: (p: string) => Promise<Response> | Response, key: string) => reader(`/v1/entities/drive/${key}`)

  beforeAll(async () => {
    expect((await admin('/v1/access/person', put({ blueprint: 'user', owns: [{ as: 'owner', path: '<-holder' }, { as: 'watcher', path: '<-watcher' }] }))).status).toBe(200)
    await save('drive', drive(['url', 'quota', 'price']))
    // The same relation on an open blueprint, which opening drives must leave free to edit.
    await save('locker', { title: 'Locker', fields: {}, relations: { holder: { target: 'user' } } })
    const create = async (key: string, relations: Record<string, unknown>) =>
      expect((await admin('/v1/entities', post({ blueprint: 'drive', key, title: key, fields: { url: `https://drive.example.org/${key}`, quota: 5, secret_note: 'kept', price: 9 }, relations }))).status).toBe(201)
    await create('d-bob', { holder: 'bob@example.org', subnet: 'core' })
    await create('d-ada', { holder: 'ada@example.org' })
    await create('d-watched', { watcher: 'bob@example.org' })
  })

  afterAll(async () => {
    expect((await admin('/v1/access/person', put({ blueprint: 'user' }))).status).toBe(200)
  })

  it('shows an owner their own entity with only the fields it names, and a field rule still holds', async () => {
    const r = await page(outsider, 'd-bob')
    expect(r.status).toBe(200)
    const mine = await json<EntityPageResponse>(r)
    expect(mine.fields).toMatchObject({ url: 'https://drive.example.org/d-bob', quota: 5 })
    expect(mine.fields).not.toHaveProperty('secret_note')
    expect(mine.fields).not.toHaveProperty('price')
    // It points at a subnet they may not see: that link is not there for them.
    expect(mine.relations).not.toHaveProperty('subnet')
    expect(mine.outgoing.map((o) => o.target.blueprint)).not.toContain('subnet')
  })

  it('shows nothing of what they do not own, or own only by a role the rule does not count', async () => {
    expect((await page(outsider, 'd-ada')).status).toBe(404)
    expect((await page(outsider, 'd-watched')).status).toBe(404)
    const list = await json<EntitiesResponse>(await outsider('/v1/entities?blueprint=drive&distribution=true'))
    expect(list.entities.map((e) => e.key)).toEqual(['d-bob'])
    expect(list.total).toBe(1)
    const search = encodeURIComponent(JSON.stringify({ search: 'd-' }))
    const found = await json<EntitiesResponse>(await outsider(`/v1/entities?filter=${search}`))
    expect(found.entities.filter((e) => e.blueprint === 'drive').map((e) => e.key)).toEqual(['d-bob'])
  })

  it('lists the blueprint as only theirs, counting their own and naming only the fields they read', async () => {
    const all = await json<BlueprintsResponse>(await outsider('/v1/blueprints'))
    const bp = all.blueprints.find((b) => b.id === 'drive')!
    expect(bp.onlyYours).toBe(true)
    expect(Object.keys(bp.fields).sort()).toEqual(['quota', 'url'])
    expect(all.counts.drive).toBe(1)
    // Someone who owns none is not told it is there.
    expect((await json<BlueprintsResponse>(await named('/v1/blueprints'))).blueprints.map((b) => b.id)).not.toContain('drive')
    // The team the rule lets in sees all of it, as before.
    const inside = (await json<BlueprintsResponse>(await insider('/v1/blueprints'))).blueprints.find((b) => b.id === 'drive')!
    expect(inside.onlyYours).toBeUndefined()
    expect((await json<EntitiesResponse>(await insider('/v1/entities?blueprint=drive'))).total).toBe(3)
  })

  it('counts their own on the front page as the listing does, and reads one kind of theirs whole, green ones too', async () => {
    const summary = await json<SummaryResponse>(await outsider('/v1/summary'))
    expect(summary.blueprints.find((b) => b.id === 'drive')).toMatchObject({ active: 1, missing: 0 })
    expect(summary.blueprints.find((b) => b.id === 'drive')!.active).toBe((await json<BlueprintsResponse>(await outsider('/v1/blueprints'))).counts.drive)
    // Someone who owns none is not told it is there.
    expect((await json<SummaryResponse>(await named('/v1/summary'))).blueprints.map((b) => b.id)).not.toContain('drive')
    const kind = await json<MineResponse>(await outsider('/v1/mine?blueprint=drive'))
    expect(kind.things.map((t) => t.entity.key)).toEqual(['d-bob'])
    expect(kind.blueprints.drive).toMatchObject({ count: 1, as: { owner: 1 } })
    expect(Object.keys(kind.blueprints)).toEqual(['drive'])
  })

  it('puts it on their own page and their person, and on nobody else’s person for them', async () => {
    expect((await json<MineResponse>(await outsider('/v1/mine'))).things.map((t) => t.entity.key)).toContain('d-bob')
    const self = await json<EntityPageResponse>(await outsider(`/v1/entities/user/${encodeURIComponent('bob@example.org')}`))
    expect(self.incoming.filter((i) => i.target.blueprint === 'drive').map((i) => i.target.key)).toEqual(['d-bob'])
    const other = await json<EntityPageResponse>(await outsider(`/v1/entities/user/${encodeURIComponent('ada@example.org')}`))
    expect(other.incoming.filter((i) => i.target.blueprint === 'drive')).toEqual([])
  })

  it('counts in a grid row only the links they see, of a blueprint they see one by one', async () => {
    type Row = { key: string; incomingRefs?: Record<string, { key: string }[]>; incomingCount?: Record<string, number> }
    const block = await json<{ entities: Row[] }>(await outsider('/v1/entities?blueprint=user&distribution=true&incoming=1'))
    const bob = block.entities.find((e) => e.key === 'bob@example.org')!
    expect(bob.incomingRefs?.['drive.holder']?.map((r) => r.key)).toEqual(['d-bob'])
    expect(bob.incomingCount?.['drive.holder']).toBe(1)
    // What watches them is a drive they do not own: neither it nor how many there are reaches them.
    expect(bob.incomingRefs).not.toHaveProperty('drive.watcher')
    expect(bob.incomingCount).not.toHaveProperty('drive.watcher')
  })

  it('never lets an owner change what they read this way', async () => {
    await admin('/v1/roles/editor', put({ title: 'Editor', permissions: ['entities.edit'] }))
    await admin('/v1/users/bob%40example.org/roles', put({ roles: ['editor'] }))
    expect((await outsider('/v1/entities/drive/d-bob', patch({ fields: { quota: 50 } }))).status).not.toBe(200)
    expect((await json<EntityPageResponse>(await insider('/v1/entities/drive/d-bob'))).fields.quota).toBe(5)
    await admin('/v1/users/bob%40example.org/roles', put({ roles: [] }))
  })

  it('guards only the steps of what is theirs that reach the blueprint', async () => {
    const decides = async (id: string) => (await json<{ decides?: { names: string[] } }>(await admin(`/v1/blueprints/${id}`))).decides?.names ?? []
    expect(await decides('drive')).toContain('holder')
    expect(await decides('locker')).not.toContain('holder')
  })

  it('shows every field no rule keeps from them when the rule says all', async () => {
    await save('drive', drive('all'))
    const mine = await json<EntityPageResponse>(await page(outsider, 'd-bob'))
    expect(mine.fields).toMatchObject({ secret_note: 'kept', quota: 5 })
    expect(mine.fields).not.toHaveProperty('price')
    await save('drive', drive(['url', 'quota', 'price']))
  })

  it('refuses a field list naming a field the blueprint does not have, and owners on a field', async () => {
    expect((await admin('/v1/blueprints/drive', put({ id: 'drive', ...drive(['nope']) }))).status).toBe(400)
    const spec = drive(['url'])
    expect((await admin('/v1/blueprints/drive', put({ id: 'drive', ...spec, fields: { ...spec.fields, quota: { type: 'number', access: { grants: platform, owners: { roles: ['owner'], fields: 'all' } } } } }))).status).toBe(400)
  })
})

describe('a blueprint opened to whoever sees what it is about', () => {
  const platform = [{ path: 'team', values: ['platform'] }]
  const save = async (id: string, spec: Record<string, unknown>) => expect((await admin(`/v1/blueprints/${id}`, put({ id, ...spec }))).status).toBe(200)
  const notice = { title: 'Notice', fields: { detail: { type: 'string' } }, relations: { workstation: { target: 'workstation' }, subnet: { target: 'subnet' }, vault: { target: 'vault' }, department: { target: 'department' } }, access: { grants: [], subjects: ['workstation', 'subnet', 'vault'] } }
  const create = async (blueprint: string, key: string, relations: Record<string, unknown>) =>
    expect((await admin('/v1/entities', post({ blueprint, key, title: key, fields: blueprint === 'notice' ? { detail: `about ${key}` } : {}, relations }))).status).toBe(201)
  const page = async (reader: (p: string) => Promise<Response> | Response, key: string) => reader(`/v1/entities/notice/${key}`)
  const keys = async (reader: (p: string) => Promise<Response> | Response) => (await json<EntitiesResponse>(await reader('/v1/entities?blueprint=notice'))).entities.map((e) => e.key).sort()

  beforeAll(async () => {
    expect((await admin('/v1/access/person', put({ blueprint: 'user', owns: [{ as: 'owner', path: '<-holder' }] }))).status).toBe(200)
    await save('vault', { title: 'Vault', fields: {}, relations: { holder: { target: 'user' } }, access: { grants: platform, owners: { roles: ['owner'], fields: 'all' } } })
    await save('notice', notice)
    await create('vault', 'v-bob', { holder: 'bob@example.org' })
    await create('vault', 'v-cy', { holder: 'cy@example.org' })
    // About a workstation everyone sees, a subnet only the platform team sees, a vault each of its holders sees, and a department: not a subject.
    await create('notice', 'n-pc', { workstation: 'pc-1' })
    await create('notice', 'n-subnet', { subnet: 'core' })
    await create('notice', 'n-vault-bob', { vault: 'v-bob' })
    await create('notice', 'n-vault-cy', { vault: 'v-cy' })
    await create('notice', 'n-department', { department: 'it' })
  })

  afterAll(async () => {
    expect((await admin('/v1/access/person', put({ blueprint: 'user' }))).status).toBe(200)
  })

  it('shows a reader what is about something they see, and nothing else of it', async () => {
    expect((await page(outsider, 'n-pc')).status).toBe(200)
    expect((await json<EntityPageResponse>(await page(outsider, 'n-pc'))).fields).toMatchObject({ detail: 'about n-pc' })
    expect((await page(outsider, 'n-subnet')).status).toBe(404)
    // A relation the rule does not name opens nothing, though they see the department.
    expect((await page(outsider, 'n-department')).status).toBe(404)
    expect(await keys(outsider)).toEqual(['n-pc', 'n-vault-bob'])
    // The platform team sees every subnet and every vault whole.
    expect(await keys(insider)).toEqual(['n-pc', 'n-subnet', 'n-vault-bob', 'n-vault-cy'])
  })

  it('opens what is about an entity they see only as its owner, and only that one', async () => {
    expect((await page(outsider, 'n-vault-bob')).status).toBe(200)
    expect((await page(outsider, 'n-vault-cy')).status).toBe(404)
    expect((await page(named, 'n-vault-cy')).status).toBe(200)
  })

  it('finds it in search and counts it, and lists the blueprint as only what is about what they see', async () => {
    const found = await json<EntitiesResponse>(await outsider(`/v1/entities?filter=${encodeURIComponent(JSON.stringify({ search: 'n-' }))}`))
    expect(found.entities.filter((e) => e.blueprint === 'notice').map((e) => e.key).sort()).toEqual(['n-pc', 'n-vault-bob'])
    expect((await json<EntitiesResponse>(await outsider('/v1/entities?blueprint=notice'))).total).toBe(2)
    const all = await json<BlueprintsResponse>(await outsider('/v1/blueprints'))
    const bp = all.blueprints.find((b) => b.id === 'notice')!
    expect(bp.onlyAbout).toBe(true)
    expect(bp.onlyYours).toBeUndefined()
    expect(all.counts.notice).toBe(2)
    const summary = await json<SummaryResponse>(await outsider('/v1/summary'))
    expect(summary.blueprints.find((b) => b.id === 'notice')).toMatchObject({ active: 2 })
  })

  it('shows it on the page of what it is about', async () => {
    const pc = await json<EntityPageResponse>(await outsider('/v1/entities/workstation/pc-1'))
    expect(pc.incoming.filter((i) => i.target.blueprint === 'notice').map((i) => i.target.key)).toEqual(['n-pc'])
  })

  it('never lets them change what they read this way', async () => {
    await admin('/v1/roles/editor', put({ title: 'Editor', permissions: ['entities.edit'] }))
    await admin('/v1/users/bob%40example.org/roles', put({ roles: ['editor'] }))
    expect((await outsider('/v1/entities/notice/n-pc', patch({ fields: { detail: 'changed' } }))).status).not.toBe(200)
    expect((await json<EntityPageResponse>(await admin('/v1/entities/notice/n-pc'))).fields.detail).toBe('about n-pc')
    await admin('/v1/users/bob%40example.org/roles', put({ roles: [] }))
  })

  it('follows a new record about what they see, and one that moves away', async () => {
    await create('notice', 'n-pc-2', { workstation: 'pc-1' })
    expect(await keys(outsider)).toEqual(['n-pc', 'n-pc-2', 'n-vault-bob'])
    expect((await admin('/v1/entities/notice/n-pc-2', patch({ relations: { workstation: null, subnet: 'core' } }))).status).toBe(200)
    expect(await keys(outsider)).toEqual(['n-pc', 'n-vault-bob'])
  })

  it('works out what is about what each reader sees for many readers in one read, as each alone gets it', async () => {
    // Saving the blueprint drops what was worked out, so the next look is cold.
    await save('notice', notice)
    const reads = vi.spyOn(hub.reader, 'aboutLinks')
    await hub.visibility.warm(['ada@example.org', 'bob@example.org', 'cy@example.org'])
    expect(reads.mock.calls.filter(([blueprint]) => blueprint === 'notice')).toHaveLength(1)
    reads.mockRestore()
    expect(await keys(outsider)).toEqual(['n-pc', 'n-vault-bob'])
    expect(await keys(named)).toEqual(['n-pc', 'n-vault-cy'])
    expect(await keys(insider)).toEqual(['n-pc', 'n-pc-2', 'n-subnet', 'n-vault-bob', 'n-vault-cy'])
  })

  it('refuses a subject that is not a relation of the blueprint, and subjects on a field', async () => {
    expect((await admin('/v1/blueprints/notice', put({ id: 'notice', ...notice, access: { grants: [], subjects: ['nope'] } }))).status).toBe(400)
    expect((await admin('/v1/blueprints/notice', put({ id: 'notice', ...notice, fields: { detail: { type: 'string', access: { grants: [], subjects: ['workstation'] } } } }))).status).toBe(400)
  })
})

describe('a list that names its fields and relations', () => {
  /** What the page statement of `fn`'s list read of each row: the names of its stored fields and relations. */
  const pageRead = async (fn: () => Promise<unknown>): Promise<{ fields: string[]; relations: string[] }[]> => {
    const seen: { fields: string[]; relations: string[] }[] = []
    const query = hub.db.query.bind(hub.db)
    const spy = vi.spyOn(hub.db, 'query').mockImplementation(async (text: string, params?: unknown[]) => {
      const res = await query(text, params)
      if (text.includes('p.order_values')) for (const r of res.rows as { derived: { fields: object; relations: object } | null }[]) if (r.derived) seen.push({ fields: Object.keys(r.derived.fields).sort(), relations: Object.keys(r.derived.relations).sort() })
      return res
    })
    try {
      await fn()
    } finally {
      spy.mockRestore()
    }
    return seen
  }
  /** An answer's rows cut to the names asked, as the hub has always cut them. */
  const cut = (list: EntitiesResponse['entities'], fields: string[], relations: string[]) =>
    list.map((e) => ({ ...e, fields: Object.fromEntries(fields.filter((f) => f in e.fields).map((f) => [f, e.fields[f]])), relations: Object.fromEntries(relations.filter((r) => r in e.relations).map((r) => [r, e.relations[r]!])) }))
  const list = async (reader: (p: string) => Promise<Response> | Response, ask = '') => (await json<EntitiesResponse>(await reader(`/v1/entities?blueprint=user${ask}`))).entities

  it('reads only those of each row for a reader who sees everything, and answers as before', async () => {
    const whole = await list(admin)
    let named: EntitiesResponse['entities'] = []
    const read = await pageRead(async () => {
      named = await list(admin, '&fields=job_title&relations=team')
    })
    expect(read.length).toBe(3)
    for (const r of read) {
      expect(r.fields).toEqual(['job_title'])
      expect(r.relations.every((n) => n === 'team')).toBe(true)
    }
    expect(named).toEqual(cut(whole, ['job_title'], ['team']))
  })

  it('reads a row whole for a reader a view cuts, and still withholds what they may not see', async () => {
    const whole = await list(outsider)
    let named: EntitiesResponse['entities'] = []
    const read = await pageRead(async () => {
      named = await list(outsider, '&fields=job_title,home_phone&relations=')
    })
    // The view reads values of its own to decide what to withhold, so the statement reads what it always did: no relation was asked, and each is read.
    expect(read.length).toBeGreaterThan(0)
    expect(read.every((r) => r.relations.includes('department'))).toBe(true)
    expect(named.find((e) => e.key === 'ada@example.org')?.fields).not.toHaveProperty('home_phone')
    expect(named).toEqual(cut(whole, ['job_title', 'home_phone'], []))
  })
})
