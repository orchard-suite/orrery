import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ChangesResponse, GroundIndexResponse, GroundItemResponse, GroundResponse, PreviewsResponse, TokenIssued, WhoAmIResponse } from '../shared/api.ts'
import { loadConfig } from './config.ts'
import { createHub, type Hub } from './hub.ts'

// Its own database: these tests sign people in and open a preview, which every other test would then read.
const DATABASE_URL = (process.env.DATABASE_URL ?? 'postgres://orrery:orrery@localhost:5433/orrery') + '_previews'

let hub: Hub

const as = (email: string, groups = 'User') => (path: string, init?: RequestInit) =>
  hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', 'x-forwarded-email': email, 'x-forwarded-groups': groups, ...init?.headers } }, { surface: 'session' })
const bearer = (token: string) => (path: string, init?: RequestInit) =>
  hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}`, ...init?.headers } }, { surface: 'machine' })
const json = async <T = Record<string, unknown>>(r: Response): Promise<T> => (await r.json()) as T
const put = (v: unknown) => ({ method: 'PUT', body: JSON.stringify(v) })
const post = (v: unknown) => ({ method: 'POST', body: JSON.stringify(v) })
const viewing = (email: string) => ({ headers: { 'x-orrery-view-as': email } })

const admin = as('admin@example.org', 'Admin')
const named = as('ada@example.org')
const outsider = as('bob@example.org')

const open = async (setting: { open: 'nobody' | 'people' | 'everyone'; people?: string[] }) => {
  const saved = await admin('/v1/access/previews', put({ garden: setting }))
  expect(saved.status).toBe(200)
  return (await json<PreviewsResponse>(saved)).previews.garden
}
const previewsOf = async (read: Promise<Response> | Response) => (await json<WhoAmIResponse>(await read)).previews
const changes = async () => (await json<ChangesResponse>(await admin('/v1/changes?kind=preview.changed'))).changes
const tools = async (call: ReturnType<typeof bearer>) => {
  const listed = await json<{ result: { tools: { name: string }[] } }>(await call('/mcp', post({ jsonrpc: '2.0', id: 1, method: 'tools/list' })))
  return listed.result.tools.map((t) => t.name)
}

const REPOSITORY = {
  id: 'repository',
  title: 'Repository',
  ground: { loop: 'pipeline_minutes', unwanted: 'lint_suppressions', guards: ['branch_protected'], foundations: ['runtime'], taughtBy: 'copied_from', template: { relation: 'template', version: 'template_version', current: 'version' } },
  fields: {
    pipeline_minutes: { type: 'number', title: 'Pipeline minutes', budget: { max: 10 } },
    lint_suppressions: { type: 'number', title: 'Lint suppressions', budget: { max: 20 }, access: { grants: [{ path: 'team', values: ['platform'] }] } },
    branch_protected: { type: 'boolean', title: 'Protected branch' },
    runtime: { type: 'string', title: 'Runtime' },
    template_version: { type: 'string' },
  },
  relations: { copied_from: { target: 'repository', many: true }, template: { target: 'template' } },
}

beforeAll(async () => {
  const pg = await import('pg').then(({ default: m }) => new m.Client({ connectionString: DATABASE_URL.replace(/\/[^/]+$/, '/postgres') }))
  await pg.connect()
  await pg.query(`DROP DATABASE IF EXISTS ${DATABASE_URL.split('/').pop()}`)
  await pg.query(`CREATE DATABASE ${DATABASE_URL.split('/').pop()}`)
  await pg.end()
  hub = await createHub(loadConfig({ DATABASE_URL, DATA_DIR: mkdtempSync(join(tmpdir(), 'orrery-')), AUTH_MODE: 'proxy' }), 'test', { reset: true })

  const save = async (spec: { id: string }) => expect((await admin(`/v1/blueprints/${spec.id}`, put(spec))).status).toBe(200)
  await save({ id: 'team', title: 'Team', fields: {}, relations: {} } as { id: string })
  await save({ id: 'user', title: 'Person', fields: {}, relations: { team: { target: 'team', many: true } } } as { id: string })
  await save({ id: 'template', title: 'Template', fields: { version: { type: 'string' } }, relations: {} } as { id: string })
  await save(REPOSITORY)
  expect((await admin('/v1/access/person', put({ blueprint: 'user' }))).status).toBe(200)
  const create = async (blueprint: string, key: string, fields: Record<string, unknown> = {}, relations: Record<string, unknown> = {}) =>
    expect((await admin('/v1/entities', post({ blueprint, key, title: key, fields, relations }))).status).toBe(201)
  await create('team', 'platform')
  await create('team', 'sales')
  await create('user', 'ada@example.org', {}, { team: ['platform'] })
  await create('user', 'bob@example.org', {}, { team: ['sales'] })
  await create('template', 'service-starter', { version: '3' })
  await create('repository', 'calm', { pipeline_minutes: 6, lint_suppressions: 2, branch_protected: true, runtime: 'node 24', template_version: '3' }, { template: 'service-starter' })
  await create('repository', 'slow', { pipeline_minutes: 19, lint_suppressions: 31, branch_protected: false, template_version: '2' }, { template: 'service-starter', copied_from: ['calm'] })
  await create('repository', 'copy', { pipeline_minutes: 4, lint_suppressions: 25 }, { copied_from: ['calm'] })
  await Promise.all([named('/v1/whoami'), outsider('/v1/whoami')])
})

afterAll(async () => {
  await hub.close()
})

describe('a preview', () => {
  it('is closed to everyone on a new hub, an admin too, and what it covers is not there', async () => {
    expect((await json<PreviewsResponse>(await admin('/v1/access/previews'))).previews).toEqual({ garden: { open: 'nobody', people: [] }, welcome: { open: 'nobody', people: [] } })
    expect(await previewsOf(admin('/v1/whoami'))).toEqual([])
    for (const path of ['/v1/ground', '/v1/ground/repository', '/v1/ground/repository/calm']) expect((await admin(path)).status).toBe(404)
  })

  it('is an admin’s alone to read and to set', async () => {
    expect((await named('/v1/access/previews')).status).toBe(403)
    expect((await named('/v1/access/previews', put({ garden: { open: 'everyone', people: [] } }))).status).toBe(403)
    expect((await admin('/v1/access/previews', put({ garden: { open: 'some', people: [] } }))).status).toBe(400)
    expect((await admin('/v1/access/previews', put({ meadow: { open: 'everyone' } }))).status).toBe(400)
    expect(await previewsOf(named('/v1/whoami'))).toEqual([])
  })

  it('opens to the people named, however their address is written, and to nobody else', async () => {
    expect(await open({ open: 'people', people: [' ADA@example.org ', 'ada@example.org'] })).toEqual({ open: 'people', people: ['ada@example.org'] })
    expect(await previewsOf(named('/v1/whoami'))).toEqual(['garden'])
    expect((await named('/v1/ground/repository')).status).toBe(200)
    expect(await previewsOf(outsider('/v1/whoami'))).toEqual([])
    expect((await outsider('/v1/ground/repository')).status).toBe(404)
    // An admin is in it only when named.
    expect(await previewsOf(admin('/v1/whoami'))).toEqual([])
    expect((await admin('/v1/ground')).status).toBe(404)
  })

  it('is the viewed person’s when an admin views as them', async () => {
    expect(await previewsOf(admin('/v1/whoami', viewing('ada@example.org')))).toEqual(['garden'])
    expect((await admin('/v1/ground/repository', viewing('ada@example.org'))).status).toBe(200)
    expect((await admin('/v1/ground/repository', viewing('bob@example.org'))).status).toBe(404)
  })

  it('follows a person to their own access token, and reaches no other token until it is open to everyone', async () => {
    const personal = bearer((await json<TokenIssued>(await named('/v1/me/tokens', post({ name: 'agent' })))).token)
    const theirs = bearer((await json<TokenIssued>(await outsider('/v1/me/tokens', post({ name: 'agent' })))).token)
    const machine = bearer((await json<TokenIssued>(await admin('/v1/tokens', post({ kind: 'access', name: 'reader', role: 'admin' })))).token)
    expect((await personal('/v1/ground/repository')).status).toBe(200)
    expect(await tools(personal)).toContain('get_ground')
    expect(await tools(personal)).toContain('get_map')
    expect((await theirs('/v1/ground/repository')).status).toBe(404)
    expect(await tools(theirs)).not.toContain('get_ground')
    expect(await tools(theirs)).not.toContain('get_map')
    expect((await machine('/v1/ground/repository')).status).toBe(404)
    expect(await tools(machine)).not.toContain('get_ground')

    await open({ open: 'everyone', people: ['ada@example.org'] })
    expect((await machine('/v1/ground/repository')).status).toBe(200)
    expect(await tools(machine)).toContain('get_ground')
    expect((await outsider('/v1/ground')).status).toBe(200)
    expect(await previewsOf(admin('/v1/whoami'))).toEqual(['garden'])
  })

  it('writes an activity row for each change, and none for a save that changed nothing', async () => {
    const before = await changes()
    await open({ open: 'everyone', people: ['ada@example.org'] })
    expect(await changes()).toHaveLength(before.length)
    await open({ open: 'people', people: ['ada@example.org', 'admin@example.org'] })
    const after = await changes()
    expect(after).toHaveLength(before.length + 1)
    expect(after[0]).toMatchObject({ actor: 'admin@example.org', detail: { before: { garden: { open: 'everyone' } }, after: { garden: { open: 'people', people: ['ada@example.org', 'admin@example.org'] } } } })
  })

  it('is read again from what is stored, as another hub reads it', async () => {
    await hub.db.query(`UPDATE settings SET value = $1 WHERE key = 'previews'`, [JSON.stringify({ garden: { open: 'people', people: ['bob@example.org'] } })])
    await hub.catchUp()
    expect(await previewsOf(outsider('/v1/whoami'))).toEqual(['garden'])
    expect(await previewsOf(named('/v1/whoami'))).toEqual([])
    await open({ open: 'people', people: ['ada@example.org', 'admin@example.org', 'bob@example.org'] })
  })
})

describe('the ground', () => {
  it('lists each blueprint that names one, with how much of it is inside its budgets', async () => {
    const { grounds } = await json<GroundIndexResponse>(await admin('/v1/ground'))
    expect(grounds).toEqual({ repository: { items: 3, measured: 3, inside: 1, share: 1 / 3 } })
  })

  it('reads a blueprint’s entities worst first, in plain words', async () => {
    const ground = await json<GroundResponse>(await admin('/v1/ground/repository'))
    expect(ground).toMatchObject({ blueprint: 'repository', title: 'Repository', total: 3, read: 3, plant: null })
    expect(ground.items.map((i) => [i.key, i.over, i.inside])).toEqual([['slow', 2, false], ['copy', 1, false], ['calm', 0, true]])
    expect(ground.rounds[0]).toMatchObject({ key: 'slow', why: ['Pipeline minutes is 19, over its budget of 10', 'Lint suppressions is 31, over its budget of 20'] })
    expect(ground.templates).toEqual([{ blueprint: 'template', key: 'service-starter', title: 'service-starter', current: '3', planted: 2, behind: 1 }])
    expect(ground.forecast.without).toEqual(['Pipeline minutes', 'Lint suppressions'])
    expect((await admin('/v1/ground/team')).status).toBe(404)
  })

  it('reads one entity: what it is built on, the limits it holds, and who copied from the same place', async () => {
    const bed = await json<GroundItemResponse>(await admin('/v1/ground/repository/slow'))
    expect(bed.item).toMatchObject({ key: 'slow', over: 2, template: { key: 'service-starter', version: '2', current: '3', behind: true } })
    expect(bed.foundations).toEqual([{ field: 'runtime', title: 'Runtime', value: null }])
    expect(bed.guards).toEqual([{ field: 'branch_protected', title: 'Protected branch', on: false }])
    expect(bed.taught).toEqual([{ source: { blueprint: 'repository', key: 'calm', title: 'calm', icon: null, level: expect.any(String) }, peers: [{ key: 'copy', title: 'copy', level: expect.any(String), unwanted: 25 }] }])
    expect((await admin('/v1/ground/repository/nothing')).status).toBe(404)
  })

  it('counts only what its reader may see: a number they may not see is not read', async () => {
    // Outside the platform team: the lint suppressions are not theirs to see.
    const theirs = await json<GroundResponse>(await outsider('/v1/ground/repository'))
    expect(theirs.fields.map((f) => f.field)).toEqual(['pipeline_minutes'])
    expect(theirs.items.map((i) => [i.key, i.over])).toEqual([['slow', 1], ['calm', 0], ['copy', 0]])
    expect(theirs.cover).toMatchObject({ measured: 3, inside: 2 })
    expect(JSON.stringify(theirs)).not.toMatch(/lint|Lint/)
    const inside = await json<GroundResponse>(await named('/v1/ground/repository'))
    expect(inside.fields.map((f) => f.field)).toEqual(['pipeline_minutes', 'lint_suppressions'])
  })

  it('answers an agent with the same ground', async () => {
    const personal = bearer((await json<TokenIssued>(await named('/v1/me/tokens', post({ name: 'gardener' })))).token)
    const call = async (args: Record<string, string>) => {
      const answer = await json<{ result: { content: { text: string }[] } }>(await personal('/mcp', post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_ground', arguments: args } })))
      return JSON.parse(answer.result.content[0]!.text) as Record<string, unknown>
    }
    expect(await call({})).toEqual({ grounds: { repository: { items: 3, measured: 3, inside: 1, share: 1 / 3 } } })
    expect(await call({ blueprint: 'repository' })).toMatchObject({ blueprint: 'repository', cover: { inside: 1 } })
    expect(await call({ blueprint: 'repository', key: 'slow' })).toMatchObject({ item: { key: 'slow' } })
    expect(await call({ blueprint: 'team' })).toEqual({ error: 'Blueprint "team" has no ground' })
  })
})

describe('a blueprint’s ground and budgets', () => {
  const refused = async (change: Record<string, unknown>) => {
    const r = await admin('/v1/blueprints/repository', put({ ...REPOSITORY, ...change }))
    expect(r.status).toBe(400)
    return (await json<{ error: string }>(r)).error
  }

  it('refuses a budget on anything but a number, an empty one, and one whose min is above its max', async () => {
    expect(await refused({ fields: { ...REPOSITORY.fields, runtime: { type: 'string', budget: { max: 1 } } } })).toMatch(/only a number has a budget/)
    expect(await refused({ fields: { ...REPOSITORY.fields, pipeline_minutes: { type: 'number', budget: {} } } })).toMatch(/needs a max, a min, or both/)
    expect(await refused({ fields: { ...REPOSITORY.fields, pipeline_minutes: { type: 'number', budget: { min: 5, max: 1 } } } })).toMatch(/min is at most its max/)
  })

  it('refuses a ground that names what is not there, or a field of the wrong kind', async () => {
    expect(await refused({ ground: { loop: 'nothing' } })).toMatch(/loop names "nothing", which is not a field/)
    expect(await refused({ ground: { loop: 'runtime' } })).toMatch(/loop reads a number field, and "runtime" is a string/)
    expect(await refused({ ground: { guards: ['runtime'] } })).toMatch(/guards reads a boolean field/)
    expect(await refused({ ground: { taughtBy: 'nothing' } })).toMatch(/taughtBy names "nothing", which is not a relation/)
    expect(await refused({ ground: { template: { relation: 'copied_from' } } })).toMatch(/holds many/)
    expect(await refused({ ground: { template: { relation: 'template', current: 'nothing' } } })).toMatch(/not a field of "template"/)
    expect(await refused({ ground: { meadow: 'x' } })).toBeTruthy()
  })

  it('keeps a ground whose field went later: the name is read as not set', async () => {
    const { runtime: _gone, ...fields } = REPOSITORY.fields
    expect((await admin('/v1/blueprints/repository', put({ ...REPOSITORY, fields }))).status).toBe(200)
    const bed = await json<GroundItemResponse>(await admin('/v1/ground/repository/calm'))
    expect(bed.foundations).toEqual([])
    expect((await admin('/v1/blueprints/repository', put(REPOSITORY))).status).toBe(200)
  })
})

describe('what a bed’s worked-out numbers read', () => {
  it('lists the things behind each aggregation, marked by whether it counted them, what set the number first', async () => {
    const save = async (spec: { id: string }) => expect((await admin(`/v1/blueprints/${spec.id}`, put(spec))).status).toBe(200)
    await save({ id: 'forge', title: 'Forge', ground: { guards: [] }, fields: { red: { type: 'number', title: 'Red pipelines', budget: { max: 0 }, aggregation: { relation: '<-pipe:forge', fn: 'count', where: { field: 'outcome', op: 'eq', value: 'red' } } }, slowest: { type: 'number', title: 'Slowest', budget: { max: 100 }, aggregation: { relation: '<-pipe:forge', fn: 'max', field: 'seconds', where: { field: 'outcome', op: 'neq', value: 'grey' } } } }, relations: {} } as { id: string })
    await save({ id: 'pipe', title: 'Pipe', fields: { outcome: { type: 'string' }, seconds: { type: 'number' }, run: { type: 'url', title: 'Last run' } }, relations: { forge: { target: 'forge' } } } as { id: string })
    const create = async (blueprint: string, key: string, fields: Record<string, unknown> = {}, relations: Record<string, unknown> = {}) =>
      expect((await admin('/v1/entities', post({ blueprint, key, title: key, fields, relations }))).status).toBe(201)
    await create('forge', 'comet')
    await create('pipe', 'build', { outcome: 'red', seconds: 57, run: 'https://ci.example.org/1930' }, { forge: 'comet' })
    await create('pipe', 'deploy', { outcome: 'green', seconds: 120 }, { forge: 'comet' })
    await create('pipe', 'old', { outcome: 'grey', seconds: 900 }, { forge: 'comet' })
    const bed = await json<GroundItemResponse>(await admin('/v1/ground/forge/comet'))
    expect(bed.item.measures.map((m) => [m.field, m.value, m.over])).toEqual([['red', 1, true], ['slowest', 120, true]])
    const [red, slowest] = bed.behind!
    expect(red).toMatchObject({ field: 'red', reached: 3, counted: 1 })
    expect(red!.rows.map((r) => [r.key, r.counted])).toEqual([['build', true], ['deploy', false], ['old', false]])
    expect(red!.rows[0]!.links).toEqual([{ title: 'Last run', url: 'https://ci.example.org/1930' }])
    expect(slowest).toMatchObject({ field: 'slowest', reached: 3, counted: 2 })
    expect(slowest!.rows.map((r) => [r.key, r.value, r.counted])).toEqual([['deploy', 120, true], ['build', 57, true], ['old', 900, false]])
    expect(bed.reads).toContain('pipe')
  })
})
