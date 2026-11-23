import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { BulkEditResponse, ChangesResponse, EntityPageResponse } from '../shared/api.ts'
import type { Blueprint } from '../shared/model.ts'
import type { AccessPolicy } from '../shared/policy.ts'
import type { PolicyPreview } from '../shared/posture.ts'
import { loadConfig } from './config.ts'
import { createHub, type Hub } from './hub.ts'

// Its own database: these tests set who a person is, what they own, and the hub's edit rules.
const DATABASE_URL = (process.env.DATABASE_URL ?? 'postgres://orrery:orrery@localhost:5433/orrery') + '_edits'

let hub: Hub
let token = ''

const as = (email: string, groups = 'User') => (path: string, init?: RequestInit) =>
  hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', 'x-forwarded-email': email, 'x-forwarded-groups': groups, ...init?.headers } }, { surface: 'session' })
const json = async <T = Record<string, unknown>>(r: Response): Promise<T> => (await r.json()) as T
const put = (v: unknown) => ({ method: 'PUT', body: JSON.stringify(v) })
const post = (v: unknown) => ({ method: 'POST', body: JSON.stringify(v) })
const patch = (v: unknown) => ({ method: 'PATCH', body: JSON.stringify(v) })
const push = (key: string, fields: Record<string, unknown>) => hub.app.request(`/v1/ingest/entities/service/${key}`, { method: 'PATCH', body: JSON.stringify({ fields }), headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` } }, { surface: 'machine' })

const admin = as('admin@example.org', 'Admin')
// Owns the service `web`, and holds no role.
const owner = as('owner@example.org')
// On the team that `web` belongs to: theirs as `team`, a role the rule does not count.
const mate = as('mate@example.org')
// Owns nothing; named in the desk audience.
const desk = as('desk@example.org')
// Owns nothing, in no audience, and holds `entities.edit`.
const contributor = as('contributor@example.org')
// Owns nothing and holds nothing.
const stranger = as('stranger@example.org')

const POLICY: AccessPolicy = {
  audiences: [{ id: 'desk', title: 'Desk', people: ['desk@example.org'], grants: [], audiences: [] }],
  classes: [],
  edits: [
    { id: 'service-notes', title: 'Service notes', blueprints: ['service'], fields: ['description', 'language', 'name', 'icon'], relations: ['owner', 'depends_on'], audiences: [], owned: { through: [], roles: ['owner'] } },
    { id: 'desk', title: 'Desk corrections', blueprints: ['serv*'], fields: ['name'], relations: [], audiences: ['desk'] },
    { id: 'self', title: 'About me', blueprints: ['user'], fields: ['bio'], relations: [], audiences: [], owned: { through: [], roles: ['self'] } },
  ],
}

const page = async (reader: typeof admin, blueprint: string, key: string) => json<EntityPageResponse>(await reader(`/v1/entities/${blueprint}/${encodeURIComponent(key)}`))

beforeAll(async () => {
  const pg = await import('pg').then(({ default: m }) => new m.Client({ connectionString: DATABASE_URL.replace(/\/[^/]+$/, '/postgres') }))
  await pg.connect()
  await pg.query(`DROP DATABASE IF EXISTS ${DATABASE_URL.split('/').pop()}`)
  await pg.query(`CREATE DATABASE ${DATABASE_URL.split('/').pop()}`)
  await pg.end()
  hub = await createHub(loadConfig({ DATABASE_URL, DATA_DIR: mkdtempSync(join(tmpdir(), 'orrery-')), AUTH_MODE: 'proxy' }), 'test', { reset: true })

  const save = async (id: string, spec: Record<string, unknown>) => expect((await admin(`/v1/blueprints/${id}`, put({ id, ...spec }))).status).toBe(200)
  await save('team', { title: 'Team', fields: {}, relations: {} })
  await save('user', { title: 'Person', fields: { bio: { type: 'string' }, job: { type: 'string' } }, relations: { team: { target: 'team', many: true } } })
  await save('service', {
    title: 'Service',
    fields: { description: { type: 'string' }, notes: { type: 'markdown' }, name: { type: 'string' }, language: { type: 'string', sticky: true }, serial: { type: 'string', overridable: false } },
    relations: { owner: { target: 'user' }, team: { target: 'team' }, depends_on: { target: 'service', many: true } },
  })
  expect((await admin('/v1/access/person', put({ blueprint: 'user', owns: [{ as: 'owner', path: '<-owner' }, { as: 'team', path: 'team.<-team' }] }))).status).toBe(200)
  const create = async (blueprint: string, key: string, fields: Record<string, unknown> = {}, relations: Record<string, unknown> = {}) =>
    expect((await admin('/v1/entities', post({ blueprint, key, title: key, fields, relations }))).status).toBe(201)
  await create('team', 'platform')
  for (const who of ['owner', 'desk', 'contributor', 'stranger']) await create('user', `${who}@example.org`)
  await create('user', 'mate@example.org', {}, { team: ['platform'] })
  await hub.sources.save('forge', { title: 'Forge', class: 'pusher', blueprints: ['service'], deleteGrant: [], cadence: '1h' })
  token = (await hub.sources.issueToken('source', 'forge', { source: 'forge' })).token
  expect((await push('web', { name: 'web', language: 'go' })).status).toBe(201)
  expect((await push('api', { name: 'api' })).status).toBe(201)
  expect((await admin('/v1/entities/service/web', patch({ relations: { owner: 'owner@example.org', team: 'platform' } }))).status).toBe(200)
  for (const reader of [owner, mate, desk, contributor, stranger]) await reader('/v1/whoami')
  expect((await admin('/v1/users/contributor@example.org/roles', put({ roles: ['contributor'] }))).status).toBe(200)
  const saved = await json<PolicyPreview>(await admin('/v1/posture/policy', post({ policy: POLICY, save: true })))
  expect(saved.problems).toEqual([])
  expect(saved.saved).toBe(true)
})

afterAll(async () => {
  await hub.close()
})

describe('edit rules', () => {
  it('let an owner who holds no role write a field the rule names, on what they own', async () => {
    expect((await owner('/v1/entities/service/web', patch({ fields: { description: 'The storefront' } }))).status).toBe(200)
    expect((await page(admin, 'service', 'web')).fields.description).toBe('The storefront')
  })

  it('refuse the same change on what they do not own, and to someone who owns it in a role the rule does not count', async () => {
    const turned = await owner('/v1/entities/service/api', patch({ fields: { description: 'Not mine' } }))
    expect(turned.status).toBe(403)
    expect((await json<{ error: string }>(turned)).error).toContain('entities.edit')
    expect((await mate('/v1/entities/service/web', patch({ fields: { description: 'From the team' } }))).status).toBe(403)
    expect((await stranger('/v1/entities/service/web', patch({ fields: { description: 'From nobody' } }))).status).toBe(403)
  })

  it('open nothing the rule does not name, and never a locked field', async () => {
    expect((await owner('/v1/entities/service/web', patch({ fields: { notes: 'mine?' } }))).status).toBe(403)
    expect((await owner('/v1/entities/service/web', patch({ fields: { description: 'x', notes: 'mine?' } }))).status).toBe(403)
    expect((await owner('/v1/entities/service/web', patch({ fields: { serial: '1' } }))).status).toBe(403)
  })

  it('never let an owner write over what a source says, unless the field is sticky', async () => {
    const turned = await owner('/v1/entities/service/web', patch({ fields: { name: 'Web shop' } }))
    expect(turned.status).toBe(403)
    expect((await json<{ error: string }>(turned)).error).toBe('"name" comes from forge: change it there')
    expect((await owner('/v1/entities/service/web', patch({ fields: { language: 'rust' } }))).status).toBe(200)
    expect((await page(admin, 'service', 'web')).fields).toMatchObject({ name: 'web', language: 'rust' })
  })

  it('let an audience correct a pushed value on every entity, as an override that gives way', async () => {
    expect((await desk('/v1/entities/service/api', patch({ fields: { name: 'API' } }))).status).toBe(200)
    expect((await page(admin, 'service', 'api')).fields.name).toBe('API')
    expect((await desk('/v1/entities/service/api', patch({ fields: { description: 'no' } }))).status).toBe(403)
    expect((await push('api', { name: 'api-v2' })).status).toBe(200)
    expect((await page(admin, 'service', 'api')).fields.name).toBe('api-v2')
  })

  it('guard the relation owners are let in through: no rule opens it, and only an admin changes it', async () => {
    const { blueprints } = await json<{ blueprints: Blueprint[] }>(await admin('/v1/blueprints'))
    expect(blueprints.find((b) => b.id === 'service')?.decides?.names).toContain('owner')
    expect((await owner('/v1/entities/service/web', patch({ relations: { owner: 'stranger@example.org' } }))).status).toBe(403)
    expect((await contributor('/v1/entities/service/api', patch({ relations: { owner: 'contributor@example.org' } }))).status).toBe(403)
    expect((await owner('/v1/entities/service/web', patch({ relations: { depends_on: ['api'] } }))).status).toBe(200)
  })

  it('leave a holder of entities.edit as they were', async () => {
    expect((await contributor('/v1/entities/service/api', patch({ fields: { notes: 'Checked' } }))).status).toBe(200)
    expect((await contributor('/v1/entities/user/stranger@example.org', patch({ fields: { job: 'x' } }))).status).toBe(403)
  })

  it('let a person describe themselves on a blueprint only an admin changes, and nobody else', async () => {
    expect((await stranger('/v1/entities/user/stranger@example.org', patch({ fields: { bio: 'Hello' } }))).status).toBe(200)
    expect((await stranger('/v1/entities/user/owner@example.org', patch({ fields: { bio: 'Hello' } }))).status).toBe(403)
    expect((await stranger('/v1/entities/user/stranger@example.org', patch({ fields: { job: 'Boss' } }))).status).toBe(403)
    expect((await contributor('/v1/entities/user/contributor@example.org', patch({ fields: { bio: 'Me' } }))).status).toBe(200)
  })

  it('tell each reader what is theirs to change, less what a source says', async () => {
    const mine = await page(owner, 'service', 'web')
    expect(mine.editable?.fields.sort()).toEqual(['description', 'icon', 'language'])
    expect(mine.editable?.relations).toEqual(['depends_on'])
    expect((await page(owner, 'service', 'api')).editable).toBeUndefined()
    expect((await page(desk, 'service', 'web')).editable).toEqual({ fields: ['name'], relations: [] })
    expect((await page(stranger, 'service', 'web')).editable).toBeUndefined()
    expect((await page(admin, 'service', 'web')).editable).toBeUndefined()
    const grid = await json<{ entities: EntityPageResponse[] }>(await owner('/v1/entities?blueprint=service&layers=true&distribution=later'))
    expect(grid.entities.find((e) => e.key === 'web')?.editable?.fields.sort()).toEqual(['description', 'icon', 'language'])
    expect(grid.entities.find((e) => e.key === 'api')?.editable).toBeUndefined()
  })

  it('change many at once where the rule lets them, and name the rest', async () => {
    const result = await json<BulkEditResponse>(await owner('/v1/entities/bulk', post({ entities: [{ blueprint: 'service', key: 'web' }, { blueprint: 'service', key: 'api' }], fields: { description: 'Both' } })))
    expect(result.changed).toBe(1)
    expect(result.refused.map((r) => r.key)).toEqual(['api'])
    expect((await owner('/v1/entities/bulk', post({ entities: [{ blueprint: 'service', key: 'web' }], hidden: true }))).status).toBe(403)
  })

  it('keep the value a hand edit replaced, so it can be put back', async () => {
    const { changes } = await json<ChangesResponse>(await admin('/v1/changes?blueprint=service&key=web'))
    const last = changes.find((c) => c.kind === 'entity.updated' && (c.detail.fields as string[]).includes('description'))
    expect(last?.detail.was).toEqual({ description: 'The storefront' })
    expect(last?.actor).toBe('owner@example.org')
  })

  it('drop a source link to nothing with a hand edit of its relation, and keep one to what exists', async () => {
    const write = (relations: Record<string, unknown>) =>
      hub.app.request('/v1/ingest/entities/service/api', { method: 'PATCH', body: JSON.stringify({ relations }), headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` } }, { surface: 'machine' })
    expect((await write({ team: 'ghost', depends_on: ['web'] })).status).toBe(200)
    const links = async () => (await page(admin, 'service', 'api')).outgoing.map((o) => `${o.relation}:${o.target.key}:${o.layer}${o.dangling || o.pending ? ':nowhere' : ''}`).sort()
    expect(await links()).toEqual(['depends_on:web:pushed', 'team:ghost:pushed:nowhere'])
    expect((await admin('/v1/entities/service/api', patch({ relations: { team: null, depends_on: null } }))).status).toBe(200)
    expect(await links()).toEqual(['depends_on:web:pushed'])
    const { changes } = await json<ChangesResponse>(await admin('/v1/changes?blueprint=service&key=api'))
    expect(changes.find((c) => c.kind === 'entity.updated' && c.detail.dangling)?.detail.dangling).toEqual({ team: ['team:ghost'] })
  })

  it('count what an owner could fill in on their own things', async () => {
    expect((await owner('/v1/entities/service/web', patch({ fields: { description: null } }))).status).toBe(200)
    expect(await json(await owner('/v1/mine/fill'))).toEqual({ fill: [{ blueprint: 'service', field: 'description', title: 'description', count: 1 }] })
    expect(await json(await stranger('/v1/mine/fill'))).toEqual({ fill: [] })
    expect(await json(await admin('/v1/mine/fill'))).toEqual({ fill: [] })
    expect((await owner('/v1/entities/service/web', patch({ fields: { description: 'The storefront' } }))).status).toBe(200)
  })

  it('refuse a rule that opens nothing or lets nobody in', async () => {
    const bad = await json<PolicyPreview>(await admin('/v1/posture/policy', post({ policy: { ...POLICY, edits: [{ id: 'empty', title: 'Empty', blueprints: [], fields: [], relations: [], audiences: [] }] }, save: true })))
    expect(bad.saved).toBe(false)
    expect(bad.problems.join(' ')).toContain('names no blueprint')
    expect(bad.problems.join(' ')).toContain('lets nobody in')
  })

  it('keep the saved rules when a page that knows none saves the audiences', async () => {
    const { edits: _e, ...old } = POLICY
    expect((await json<PolicyPreview>(await admin('/v1/posture/policy', post({ policy: old, save: true })))).problems).toEqual([])
    expect((await owner('/v1/entities/service/web', patch({ fields: { description: 'Still mine' } }))).status).toBe(200)
  })
})
