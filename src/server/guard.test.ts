import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import type { EntityPageResponse } from '../shared/api.ts'
import type { ActionRun } from '../shared/model.ts'
import { loadConfig } from './config.ts'
import { createHub, type Hub } from './hub.ts'

// Its own database: it sets who a signed-in person is, which every other test would then read.
const DATABASE_URL = (process.env.DATABASE_URL ?? 'postgres://orrery:orrery@localhost:5433/orrery') + '_guard'

let hub: Hub
let ownerToken = ''
let otherToken = ''

const as = (email: string, groups = 'User') => (path: string, init?: RequestInit) =>
  hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', 'x-forwarded-email': email, 'x-forwarded-groups': groups, ...init?.headers } }, { surface: 'session' })
const machine = (token: string) => (path: string, init?: RequestInit) =>
  hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...init?.headers } }, { surface: 'machine' })
const json = async <T = Record<string, unknown>>(r: Response): Promise<T> => (await r.json()) as T
const put = (v: unknown) => ({ method: 'PUT', body: JSON.stringify(v) })
const post = (v: unknown) => ({ method: 'POST', body: JSON.stringify(v) })
const patch = (v: unknown) => ({ method: 'PATCH', body: JSON.stringify(v) })

const admin = as('admin@example.com', 'Admin')
// On the desk team, which the gizmo app delegates assignment to.
const desk = as('desk@example.com')
// On no team.
const nobody = as('user@example.com')
const owner = () => machine(ownerToken)
const other = () => machine(otherToken)

beforeAll(async () => {
  const pg = await import('pg').then(({ default: m }) => new m.Client({ connectionString: DATABASE_URL.replace(/\/[^/]+$/, '/postgres') }))
  await pg.connect()
  await pg.query(`DROP DATABASE IF EXISTS ${DATABASE_URL.split('/').pop()}`)
  await pg.query(`CREATE DATABASE ${DATABASE_URL.split('/').pop()}`)
  await pg.end()
  hub = await createHub(loadConfig({ DATABASE_URL, DATA_DIR: mkdtempSync(join(tmpdir(), 'orrery-')), AUTH_MODE: 'proxy' }), 'test', { reset: true })

  const save = async (id: string, spec: Record<string, unknown>) => expect((await admin(`/v1/blueprints/${id}`, put({ id, ...spec }))).status).toBe(200)
  await save('team', { title: 'Team', fields: {}, relations: {} })
  await save('user', { title: 'Person', fields: {}, relations: { teams: { target: 'team', many: true } } })
  await save('gizmo', {
    title: 'Gizmo',
    fields: { size: { type: 'number' }, assign_teams: { type: 'array', adminEdit: true }, locked: { type: 'string', adminEdit: true } },
    relations: {},
  })
  await save('request', { title: 'Request', fields: { state: { type: 'string' }, reason: { type: 'string' }, by: { type: 'string' }, at: { type: 'datetime' } }, relations: { gizmo: { target: 'gizmo' } } })
  expect((await admin('/v1/access/person', put({ blueprint: 'user' }))).status).toBe(200)
  await admin('/v1/entities', post({ blueprint: 'team', key: 'desk', title: 'desk' }))
  await admin('/v1/entities', post({ blueprint: 'user', key: 'desk@example.com', title: 'desk@example.com', relations: { teams: ['desk'] } }))
  await admin('/v1/entities', post({ blueprint: 'user', key: 'user@example.com', title: 'user@example.com' }))

  for (const id of ['owner-src', 'other-src', 'requests-src']) {
    expect((await admin(`/v1/sources/${id}`, put({ title: id, class: 'pusher', blueprints: id === 'requests-src' ? ['request', 'gizmo'] : ['gizmo', 'user'] }))).status).toBe(200)
  }
  ownerToken = (await hub.sources.issueToken('source', 'owner', { source: 'owner-src' })).token
  otherToken = (await hub.sources.issueToken('source', 'other', { source: 'other-src' })).token

  // A delegated action: the desk team assigns on a gizmo only when the gizmo names the desk.
  expect(
    (
      await admin(
        '/v1/actions/assign_gizmo_desk',
        put({
          title: 'Assign a gizmo (desk)',
          blueprint: 'gizmo',
          where: { field: 'assign_teams', op: 'contains', value: 'desk' },
          inputs: { why: { type: 'string' } },
          backend: { type: 'record', source: 'requests-src', blueprint: 'request', key: '{{ run.id }}', title: 'for {{ entity.title }}', fields: { state: 'pending', reason: '{{ inputs.why }}', by: '{{ by.name }}', at: '{{ run.at }}' }, relations: { gizmo: '{{ entity.key }}' } },
          access: { grants: [{ path: 'teams', values: ['desk'] }] },
        }),
      )
    ).status,
  ).toBe(200)
  expect((await owner()('/v1/ingest/entities/gizmo/open', put({ title: 'open', fields: { size: 1, assign_teams: ['desk'] } }))).status).toBe(201)
  expect((await owner()('/v1/ingest/entities/gizmo/argo', put({ title: 'argo', fields: { size: 2, assign_teams: [] } }))).status).toBe(201)
})

afterAll(async () => {
  await hub.close()
})

describe('a source writing what access is decided from', () => {
  it('may write it on an entity it owns', async () => {
    expect((await owner()('/v1/ingest/entities/gizmo/open', patch({ fields: { assign_teams: ['desk', 'ops'], locked: 'yes' } }))).status).toBe(200)
  })

  it('may not write it on an entity another source owns, in either mode', async () => {
    const delegation = await other()('/v1/ingest/entities/gizmo/argo', patch({ mode: 'enrich', fields: { assign_teams: ['desk'] } }))
    expect(delegation.status).toBe(422)
    expect((await json<{ errors: { reason: string }[] }>(delegation)).errors[0]!.reason).toMatch(/access is decided from "assign_teams"/)
    expect((await other()('/v1/ingest/entities/gizmo/argo', patch({ fields: { locked: 'mine' } }))).status).toBe(422)
    // A team membership read by a grant, on a person another source does not own.
    expect((await other()('/v1/ingest/entities/user/user%40example.com', patch({ mode: 'enrich', relations: { teams: ['desk'] } }))).status).toBe(422)
    const argo = await json<EntityPageResponse>(await admin('/v1/entities/gizmo/argo'))
    expect(argo.fields.assign_teams).toEqual([])
  })

  it('may still write anything else on it', async () => {
    expect((await other()('/v1/ingest/entities/gizmo/argo', patch({ mode: 'enrich', fields: { size: 3 } }))).status).toBe(200)
  })
})

describe('a delegated action', () => {
  it('runs on an entity its filter takes, for someone its grant names, and records the request', async () => {
    const writer = async () => (await json<{ sources: { id: string; status: string; lastSeenAt: string | null }[] }>(await admin('/v1/sources'))).sources.find((s) => s.id === 'requests-src')!
    // Its record source has no cadence: it waits for the first run, and is not grey for that.
    expect(await writer()).toMatchObject({ status: 'green', lastSeenAt: null })
    const r = await desk('/v1/actions/assign_gizmo_desk/run', post({ entity: { blueprint: 'gizmo', key: 'open' }, inputs: { why: 'a new starter' } }))
    expect(r.status).toBe(201)
    const run = await json<ActionRun>(r)
    expect(run.state).toBe('succeeded')
    const made = await json<EntityPageResponse>(await admin(`/v1/entities/request/${run.id}`))
    expect(made.title).toBe('for open')
    expect(made.fields).toMatchObject({ state: 'pending', reason: 'a new starter', by: 'desk@example.com' })
    expect(made.owner).toBe('requests-src')
    expect(Date.parse(String(made.fields.at))).toBeGreaterThan(Date.now() - 60_000)
    // The record is the source's own write, so the source was seen.
    expect(Date.parse((await writer()).lastSeenAt ?? '')).toBeGreaterThan(Date.now() - 60_000)
  })

  it('is refused on an entity its filter does not take, though the form was never offered it', async () => {
    const r = await desk('/v1/actions/assign_gizmo_desk/run', post({ entity: { blueprint: 'gizmo', key: 'argo' }, inputs: { why: 'let me in' } }))
    expect(r.status).toBe(400)
    expect((await json(r)).error).toMatch(/does not apply to it/)
  })

  it('is refused to someone its grant does not name', async () => {
    expect((await nobody('/v1/actions/assign_gizmo_desk/run', post({ entity: { blueprint: 'gizmo', key: 'open' } }))).status).toBe(403)
  })
})

describe('an action on an approval', () => {
  it("picks the approval's own entity by default, and nothing else", async () => {
    expect(
      (
        await admin(
          '/v1/actions/approve_request',
          put({
            title: 'Approve',
            blueprint: 'request',
            where: { field: 'state', op: 'eq', value: 'pending' },
            inputs: { gizmo: { type: 'entity', blueprint: 'gizmo', required: true, default: '{{ entity.relations.gizmo }}', where: { relatedTo: '{{ entity.id }}' } } },
            backend: { type: 'record', source: 'requests-src', blueprint: 'request', key: '{{ entity.key }}', mode: 'enrich', fields: { state: 'approved', reason: 'granted {{ inputs.gizmo.title }}' } },
          }),
        )
      ).status,
    ).toBe(200)
    const asked = await json<ActionRun>(await desk('/v1/actions/assign_gizmo_desk/run', post({ entity: { blueprint: 'gizmo', key: 'open' }, inputs: { why: 'again' } })))
    const elsewhere = await admin('/v1/actions/approve_request/run', post({ entity: { blueprint: 'request', key: asked.id }, inputs: { gizmo: 'gizmo:argo' } }))
    expect(elsewhere.status).toBe(400)
    const res = await admin('/v1/actions/approve_request/run', post({ entity: { blueprint: 'request', key: asked.id } }))
    const run = await json<ActionRun>(res)
    expect([res.status, run.state, JSON.stringify(run)]).toEqual([201, 'succeeded', expect.anything()])
    const closed = await json<EntityPageResponse>(await admin(`/v1/entities/request/${asked.id}`))
    expect(closed.fields).toMatchObject({ state: 'approved', reason: 'granted open' })
    expect((await admin('/v1/actions/approve_request/run', post({ entity: { blueprint: 'request', key: asked.id } }))).status).toBe(400)
  })
})

describe('the record backend', () => {
  it('is refused when it would write what access is decided from', async () => {
    const r = await admin('/v1/actions/self_grant', put({ title: 'Self grant', backend: { type: 'record', source: 'owner-src', blueprint: 'gizmo', key: 'x', fields: { assign_teams: ['desk'] } } }))
    expect(r.status).toBe(403)
    expect((await json(r)).error).toMatch(/assign_teams/)
  })

  it('needs a source that pushes and is registered for the blueprint', async () => {
    expect((await admin('/v1/actions/bad_src', put({ title: 'Bad', backend: { type: 'record', source: 'nope', blueprint: 'request', key: 'x' } }))).status).toBe(400)
    expect((await admin('/v1/actions/bad_bp', put({ title: 'Bad', backend: { type: 'record', source: 'owner-src', blueprint: 'request', key: 'x' } }))).status).toBe(400)
  })

  it('in enrich mode fails a run on an entity that does not exist, and writes nothing', async () => {
    expect((await admin('/v1/actions/close_request', put({ title: 'Close', inputs: { id: { type: 'string', required: true } }, backend: { type: 'record', source: 'requests-src', blueprint: 'request', key: '{{ inputs.id }}', mode: 'enrich', fields: { state: 'approved' } } }))).status).toBe(200)
    const run = await json<ActionRun>(await admin('/v1/actions/close_request/run', post({ inputs: { id: 'missing' } })))
    expect(run.state).toBe('failed')
    expect((await admin('/v1/entities/request/missing')).status).toBe(404)
  })
})

describe("the Entra pusher's blueprints", () => {
  const file = (name: string) => parse(readFileSync(join(import.meta.dirname, '../../cmd/pusher-entra', name), 'utf8')) as { blueprints: Record<string, unknown>[] }

  it('are taken as offered, and the link to a person only where the hub keeps one', async () => {
    expect((await admin('/v1/sources/entra', put({ title: 'entra', class: 'pusher', blueprints: ['*'] }))).status).toBe(200)
    const entra = machine((await hub.sources.issueToken('source', 'entra', { source: 'entra' })).token)
    const offered = await entra('/v1/ingest/blueprints', put(file('blueprints.yaml')))
    expect(offered.status).toBe(200)
    expect((await json<{ created: string[] }>(offered)).created.sort()).toEqual(['entra_app', 'entra_app_role_assignment', 'entra_group', 'entra_user', 'it_approval'])
    expect(hub.blueprints.get('it_approval')?.lifecycle?.expire).toEqual({ after: '365d', field: 'decided_at' })
    expect((await entra('/v1/ingest/blueprints', put(file('person.yaml')))).status).toBe(207)
    await admin('/v1/blueprints/person', put({ id: 'person', title: 'Person', fields: { email: { type: 'string' } }, relations: {} }))
    const linked = await entra('/v1/ingest/blueprints', put(file('person.yaml')))
    expect(linked.status).toBe(200)
    expect(hub.blueprints.get('entra_user')?.relations.person?.target).toBe('person')
  })
})
