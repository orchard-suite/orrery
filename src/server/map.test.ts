import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { MapIndexResponse, MapResponse, WalkResponse, WalkStepRequest } from '../shared/api.ts'
import { MOST_STEPS } from '../shared/map.ts'
import { loadConfig } from './config.ts'
import { createHub, type Hub } from './hub.ts'

// Its own database: these tests open the garden preview, which every other test would then read.
const DATABASE_URL = (process.env.DATABASE_URL ?? 'postgres://orrery:orrery@localhost:5433/orrery') + '_map'

let hub: Hub

const as = (email: string, groups = 'User') => (path: string, init?: RequestInit) =>
  hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', 'x-forwarded-email': email, 'x-forwarded-groups': groups, ...init?.headers } }, { surface: 'session' })
const json = async <T = Record<string, unknown>>(r: Response): Promise<T> => (await r.json()) as T
const put = (v: unknown) => ({ method: 'PUT', body: JSON.stringify(v) })
const post = (v: unknown) => ({ method: 'POST', body: JSON.stringify(v) })

const admin = as('admin@example.org', 'Admin')
const ada = as('ada@example.org')
const bob = as('bob@example.org')

const MAP = {
  parts: 'parent',
  places: 'environment',
  plots: { blueprint: 'service', holder: 'program', placedBy: { blueprint: 'running', plot: 'service', place: 'environment' } },
  members: [{ blueprint: 'database', holder: 'program', place: 'environment' }],
}

// A flag only the platform team may read, a plain word, and a list: what a map may and may not name as its primary and its sector.
const PROGRAM_FIELDS = { flagship: { type: 'boolean', title: 'Flagship', access: { grants: [{ path: 'team', values: ['platform'] }] } }, area: { type: 'string', title: 'Area' }, tags: { type: 'array', title: 'Tags' } }
const PROGRAM = { id: 'program', title: 'Program', map: MAP, fields: PROGRAM_FIELDS, relations: { parent: { target: 'program' }, team: { target: 'team' }, sponsors: { target: 'team', many: true } } }

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
  await save({ id: 'environment', title: 'Environment', fields: {}, relations: {} } as { id: string })
  await save({ id: 'program', title: 'Program', fields: PROGRAM_FIELDS, relations: { parent: { target: 'program' }, team: { target: 'team' }, sponsors: { target: 'team', many: true } } } as { id: string })
  await save({ id: 'service', title: 'Service', ground: { guards: ['has_tests'] }, fields: { has_tests: { type: 'boolean', title: 'Has tests' } }, relations: { program: { target: 'program' } } } as { id: string })
  await save({ id: 'running', title: 'Running service', fields: {}, relations: { service: { target: 'service' }, environment: { target: 'environment' } } } as { id: string })
  await save({
    id: 'database',
    title: 'Database',
    fields: { pid: { type: 'string', title: 'pid', access: { grants: [{ path: 'team', values: ['platform'] }] } }, console: { type: 'url', title: 'Console' }, note: { type: 'string', title: 'Note' } },
    relations: { program: { target: 'program' }, environment: { target: 'environment' }, team: { target: 'team' } },
  } as { id: string })
  await save(PROGRAM)
  expect((await admin('/v1/access/person', put({ blueprint: 'user' }))).status).toBe(200)
  expect((await admin('/v1/scorecards/accountable', put({ blueprint: 'database', title: 'Accountable', levels: [{ name: 'Bronze', rules: [{ id: 'tagged', title: 'Carries a pid', where: { field: 'pid', op: 'exists' } }] }] }))).status).toBe(200)
  const create = async (blueprint: string, key: string, fields: Record<string, unknown> = {}, relations: Record<string, unknown> = {}) =>
    expect((await admin('/v1/entities', post({ blueprint, key, title: key, fields, relations }))).status).toBe(201)
  await create('team', 'platform')
  await create('team', 'sales')
  await create('user', 'ada@example.org', {}, { team: ['platform'] })
  await create('user', 'bob@example.org', {}, { team: ['sales'] })
  for (const env of ['Prod', 'Test', 'Dev']) await create('environment', env)
  await create('program', 'comet', { flagship: true, area: 'retail' }, { team: 'platform' })
  await create('program', 'comet-cms', {}, { parent: 'comet' })
  await create('program', 'other')
  await create('service', 'players', { has_tests: true }, { program: 'comet' })
  await create('service', 'content', { has_tests: false }, { program: 'comet-cms' })
  await create('service', 'library', {}, { program: 'comet' })
  await create('service', 'elsewhere', {}, { program: 'other' })
  await create('running', 'players@Prod', {}, { service: 'players', environment: 'Prod' })
  await create('running', 'players@Test', {}, { service: 'players', environment: 'Test' })
  await create('running', 'content@Prod', {}, { service: 'content', environment: 'Prod' })
  await create('running', 'elsewhere@Dev', {}, { service: 'elsewhere', environment: 'Dev' })
  await create('database', 'orders-prod', { pid: '803', console: 'https://db.example.org/orders-prod', note: 'https://not-a-url-field.example.org' }, { program: 'comet', environment: 'Prod', team: 'platform' })
  // Run only on a service that has tests: the map says which of its things each reader may run it on.
  expect((await admin('/v1/actions/redeploy', put({ title: 'Redeploy', blueprint: 'service', where: { field: 'has_tests', op: 'eq', value: true }, backend: { type: 'webhook', url: 'https://hooks.example.org/redeploy' }, access: { everyone: true } }))).status).toBe(200)
  await Promise.all([ada('/v1/whoami'), bob('/v1/whoami')])
})

afterAll(async () => {
  await hub.close()
})

describe('a map', () => {
  it('names only relations of the blueprints it reads them as', async () => {
    const bad = await admin('/v1/blueprints/program', put({ ...PROGRAM, map: { ...MAP, plots: { ...MAP.plots, holder: 'environment' } } }))
    expect(bad.status).toBe(400)
    expect((await json<{ error: string }>(bad)).error).toMatch(/not a relation of "service"/)
    const wrong = await admin('/v1/blueprints/program', put({ ...PROGRAM, map: { ...MAP, members: [{ blueprint: 'database', holder: 'environment' }] } }))
    expect(wrong.status).toBe(400)
  })

  it('is not there outside the garden preview', async () => {
    for (const path of ['/v1/map', '/v1/map/program/comet']) expect((await ada(path)).status).toBe(404)
    expect((await admin('/v1/access/previews', put({ garden: { open: 'people', people: ['ada@example.org'] } }))).status).toBe(200)
    expect((await ada('/v1/map')).status).toBe(200)
    expect((await bob('/v1/map/program/comet')).status).toBe(404)
  })

  it('lists each holder that is no part of another', async () => {
    const index = await json<MapIndexResponse>(await ada('/v1/map'))
    expect(index.holders.map((h) => h.key)).toEqual(['comet', 'other'])
  })

  it('says how much the map of each holder holds, counting what names one of its parts', async () => {
    const index = await json<MapIndexResponse>(await ada('/v1/map'))
    expect(index.holders.map((h) => [h.key, h.plots, h.members])).toEqual([
      ['comet', 3, 1],
      ['other', 1, 0],
    ])
  })

  it('adds up how the checks of each holder\'s map stand, its parts\' things with it', async () => {
    const index = await json<MapIndexResponse>(await ada('/v1/map'))
    expect(index.holders.map((h) => [h.key, h.checks, h.failing, h.unknown])).toEqual([
      ['comet', 4, 1, 1],
      ['other', 1, 0, 1],
    ])
  })

  it('names on each thing the actions its reader may run on it', async () => {
    const map = await json<MapResponse>(await ada('/v1/map/program/comet'))
    expect(map.plots.find((p) => p.key === 'players')!.actions).toEqual(['redeploy'])
    expect(map.plots.find((p) => p.key === 'content')!.actions).toEqual([])
    expect(map.members[0]!.actions).toEqual([])
  })

  it('reads a holder and its parts as one map, its plots where they run, and its members on their places', async () => {
    const map = await json<MapResponse>(await ada('/v1/map/program/comet'))
    expect(map.parts.map((p) => p.key)).toEqual(['comet-cms'])
    expect(map.plots.map((p) => p.key).sort()).toEqual(['content', 'library', 'players'])
    expect(map.places.map((p) => [p.key, p.plots, p.members])).toEqual([
      ['Prod', 2, 1],
      ['Test', 1, 0],
    ])
    expect(map.counts).toMatchObject({ plots: 3, placed: 2, members: 1, open: 1 })
    const content = map.plots.find((p) => p.key === 'content')!
    expect(content.part).toBe('comet-cms')
    expect(content.checks).toEqual([{ kind: 'guard', id: 'has_tests', title: 'Has tests', of: null, state: 'fail', ladder: 'guard:has_tests', rung: 0 }])
    expect(map.members[0]!.checks).toEqual([{ kind: 'scorecard', id: 'tagged', title: 'Carries a pid', of: 'Accountable, Bronze', state: 'pass', ladder: 'accountable', rung: 0, level: 'Bronze' }])
    expect(map.ladders).toEqual([
      { id: 'accountable', title: 'Accountable', rungs: ['Bronze'] },
      { id: 'guard:has_tests', title: 'Has tests', rungs: ['Has tests'] },
    ])
  })

  it('reads a field a person may not see as no data, never as a pass or a fail', async () => {
    expect((await admin('/v1/access/previews', put({ garden: { open: 'everyone', people: [] } }))).status).toBe(200)
    const map = await json<MapResponse>(await bob('/v1/map/program/comet'))
    expect(map.members[0]!.checks.map((c) => c.state)).toEqual(['unknown'])
  })

  it('names on each thing the addresses its url fields hold, and nothing of a field that is no url', async () => {
    const map = await json<MapResponse>(await ada('/v1/map/program/comet'))
    expect(map.members[0]!.links).toEqual([{ title: 'Console', url: 'https://db.example.org/orders-prod' }])
    expect(map.plots.every((p) => p.links.length === 0)).toBe(true)
  })

  it('says which holders are the reader\'s own only once the estate says what a person owns', async () => {
    const before = await json<MapIndexResponse>(await ada('/v1/map'))
    expect(before.owned).toBe(false)
    expect(before.holders.every((h) => !h.yours)).toBe(true)
    expect((await admin('/v1/access/person', put({ blueprint: 'user', owns: ['team.<-team'] }))).status).toBe(200)
    const ada1 = await json<MapIndexResponse>(await ada('/v1/map'))
    expect(ada1.owned).toBe(true)
    // What is the reader's own moves with who they are and the teams they are on.
    expect(ada1.reads).toEqual(expect.arrayContaining(['user', 'team']))
    expect(ada1.holders.map((h) => [h.key, h.yours])).toEqual([
      ['comet', true],
      ['other', false],
    ])
    // Bob is on another team: the same holders, none of them his.
    const bob1 = await json<MapIndexResponse>(await bob('/v1/map'))
    expect(bob1.owned).toBe(true)
    expect(bob1.holders.some((h) => h.yours)).toBe(false)
    expect((await admin('/v1/access/person', put({ blueprint: 'user' }))).status).toBe(200)
  })

  it('names as its primary only a boolean field, and as its sector only one value or a relation to one entity', async () => {
    const save = (map: Record<string, unknown>) => admin('/v1/blueprints/program', put({ ...PROGRAM, map: { ...MAP, ...map } }))
    const refused = async (map: Record<string, unknown>, why: RegExp) => {
      const res = await save(map)
      expect(res.status).toBe(400)
      expect((await json<{ error: string }>(res)).error).toMatch(why)
    }
    await refused({ primary: 'area' }, /not a boolean field of "program"/)
    await refused({ primary: 'nothing' }, /not a boolean field of "program"/)
    await refused({ sector: 'nothing' }, /not a field or a relation of "program"/)
    await refused({ sector: 'tags' }, /it is a array field/)
    await refused({ sector: 'sponsors' }, /holds many/)
    expect((await save({ primary: 'flagship', sector: 'team' })).status).toBe(200)
  })

  it('says which holders are primary and what sector each is in, and neither where the map names none', async () => {
    const index = await json<MapIndexResponse>(await ada('/v1/map'))
    expect(index.holders.map((h) => [h.key, h.primary, h.sector])).toEqual([
      ['comet', true, 'platform'],
      ['other', false, null],
    ])
    // A sector may be a plain field: its value is the sector.
    expect((await admin('/v1/blueprints/program', put({ ...PROGRAM, map: { ...MAP, sector: 'area' } }))).status).toBe(200)
    const byField = await json<MapIndexResponse>(await ada('/v1/map'))
    expect(byField.holders.map((h) => [h.key, h.primary, h.sector])).toEqual([
      ['comet', false, 'retail'],
      ['other', false, null],
    ])
  })

  it('reads a primary field the reader may not see as not primary, never as hidden', async () => {
    expect((await admin('/v1/blueprints/program', put({ ...PROGRAM, map: { ...MAP, primary: 'flagship', sector: 'team' } }))).status).toBe(200)
    // Bob is not on the platform team: the flag is not his to read, the team's name is.
    const bobs = await json<MapIndexResponse>(await bob('/v1/map'))
    expect(bobs.holders.map((h) => [h.key, h.primary, h.sector])).toEqual([
      ['comet', false, 'platform'],
      ['other', false, null],
    ])
    expect((await admin('/v1/blueprints/program', put(PROGRAM))).status).toBe(200)
    const plain = await json<MapIndexResponse>(await ada('/v1/map'))
    expect(plain.holders.every((h) => !h.primary && h.sector === null)).toBe(true)
  })

  it('names the blueprints it reads, and is kept while nothing it reads moves', async () => {
    const map = await json<MapResponse>(await ada('/v1/map/program/comet'))
    expect([...map.reads].sort()).toEqual(['database', 'environment', 'program', 'running', 'service'])
    expect([...(await json<MapIndexResponse>(await ada('/v1/map'))).reads].sort()).toEqual(['database', 'program', 'service'])
    const reads = vi.spyOn(hub.reader, 'list')
    try {
      // A source reporting, and a blueprint the map does not read moving, leave it as it is.
      hub.events.emit({ type: 'sources' })
      hub.events.emit({ type: 'entity', blueprint: 'team', key: 'sales', values: true })
      await ada('/v1/map/program/comet')
      expect(reads).not.toHaveBeenCalled()
      hub.events.emit({ type: 'entity', blueprint: 'database', key: 'orders-prod', values: true })
      await ada('/v1/map/program/comet')
      expect(reads).toHaveBeenCalled()
    } finally {
      reads.mockRestore()
    }
  })

  it('is no map of an entity whose blueprint names none', async () => {
    expect((await ada('/v1/map/service/players')).status).toBe(404)
    expect((await ada('/v1/map/program/nowhere')).status).toBe(404)
  })
})

describe('a walk', () => {
  const stop = (over: Partial<WalkStepRequest> = {}): WalkStepRequest => ({ place: 'Prod', ladder: 'guard:has_tests', from: 0, scope: null, things: ['service:content'], ...over })
  const steps = async (who: typeof ada) => (await json<WalkResponse>(await who('/v1/mine/walk/program/comet'))).steps

  it('keeps a person\'s stops on a map for them alone, the same climb once', async () => {
    expect(await steps(ada)).toEqual([])
    const added = await json<WalkResponse>(await ada('/v1/mine/walk/program/comet', post(stop())))
    expect(added.steps.map((s) => [s.place, s.ladder, s.from, s.scope, s.things])).toEqual([['Prod', 'guard:has_tests', 0, null, ['service:content']]])
    // The same climb again keeps its stop and takes the things it names now.
    await ada('/v1/mine/walk/program/comet', post(stop({ things: ['service:content', 'service:library'] })))
    expect((await steps(ada)).map((s) => s.things)).toEqual([['service:content', 'service:library']])
    // Kept to one garden it is another stop.
    await ada('/v1/mine/walk/program/comet', post(stop({ scope: 'plot:content' })))
    expect(await steps(ada)).toHaveLength(2)
    expect(await steps(bob)).toEqual([])
  })

  it('takes a stop off, and only the person\'s own', async () => {
    const [first] = await steps(ada)
    expect((await json<WalkResponse>(await bob(`/v1/mine/walk/program/comet/${first!.id}`, { method: 'DELETE' }))).steps).toEqual([])
    expect(await steps(ada)).toHaveLength(2)
    const left = await json<WalkResponse>(await ada(`/v1/mine/walk/program/comet/${first!.id}`, { method: 'DELETE' }))
    expect(left.steps.map((s) => s.scope)).toEqual(['plot:content'])
  })

  it('keeps at most so many stops on one map', async () => {
    for (let from = 1; from < MOST_STEPS; from++) expect((await ada('/v1/mine/walk/program/comet', post(stop({ from })))).status).toBe(200)
    const full = await ada('/v1/mine/walk/program/comet', post(stop({ from: MOST_STEPS })))
    expect(full.status).toBe(409)
    expect(await steps(ada)).toHaveLength(MOST_STEPS)
  })

  it('refuses a stop that names nothing, and a map that is none', async () => {
    expect((await ada('/v1/mine/walk/program/comet', post(stop({ things: [] })))).status).toBe(400)
    expect((await ada('/v1/mine/walk/service/players')).status).toBe(404)
  })

  it('changes nothing while an admin views as the person, and is not there outside the garden preview', async () => {
    const viewing = { headers: { 'x-orrery-view-as': 'ada@example.org' } }
    expect((await admin('/v1/mine/walk/program/comet', { ...post(stop({ from: 99 })), ...viewing })).status).toBe(403)
    expect(await steps(ada)).toHaveLength(MOST_STEPS)
    expect((await admin('/v1/access/previews', put({ garden: { open: 'people', people: ['ada@example.org'] } }))).status).toBe(200)
    expect((await bob('/v1/mine/walk/program/comet')).status).toBe(404)
    expect((await admin('/v1/access/previews', put({ garden: { open: 'everyone', people: [] } }))).status).toBe(200)
  })
})

describe('a scorecard whose reasons are records about each thing', () => {
  beforeAll(async () => {
    const platform = [{ path: 'team', values: ['platform'] }]
    expect((await admin('/v1/blueprints/flaw', put({ id: 'flaw', title: 'Flaw', fields: { pack: { type: 'string' }, tier: { type: 'string' }, detail: { type: 'string' }, fix: { type: 'string' } }, relations: { database: { target: 'database' } }, access: { grants: platform } }))).status).toBe(200)
    const grade = (n: number) => ({ field: 'grade', op: 'gte', value: n })
    expect((await admin('/v1/blueprints/database', put({ id: 'database', title: 'Database', fields: { pid: { type: 'string', title: 'pid', access: { grants: platform } }, console: { type: 'url', title: 'Console' }, note: { type: 'string', title: 'Note' }, grade: { type: 'number', title: 'Grade' } }, relations: { program: { target: 'program' }, environment: { target: 'environment' }, team: { target: 'team' } } }))).status).toBe(200)
    const card = { blueprint: 'database', title: 'Graded', where: { field: 'grade', op: 'exists' }, levels: [{ name: 'Bronze', rules: [{ id: 'bronze', title: 'Graded Bronze or better', where: grade(1) }] }, { name: 'Silver', rules: [{ id: 'silver', title: 'Graded Silver', where: grade(2) }] }], reasons: { from: 'flaw', where: { field: 'pack', op: 'eq', value: 'graded' }, level: 'tier', says: 'detail', fix: 'fix' } }
    expect((await admin('/v1/scorecards/graded', put({ ...card, reasons: { ...card.reasons, says: 'nope' } }))).status).toBe(400)
    expect((await admin('/v1/scorecards/graded', put(card))).status).toBe(200)
    const create = async (blueprint: string, key: string, fields: Record<string, unknown>, relations: Record<string, unknown>) => expect((await admin('/v1/entities', post({ blueprint, key, title: key, fields, relations }))).status).toBe(201)
    await create('program', 'solo', {}, {})
    await create('database', 'solo-db', { grade: 1 }, { program: 'solo', environment: 'Prod' })
    await create('flaw', 'solo-backups', { pack: 'graded', tier: 'silver', detail: 'no backups', fix: 'Turn on backups' }, { database: 'solo-db' })
  })

  it('names what is missing and what to do, once, for a reader who sees the records', async () => {
    const map = await json<MapResponse>(await ada('/v1/map/program/solo'))
    const failing = map.members[0]!.checks.filter((c) => c.state === 'fail')
    expect(failing.map((c) => [c.title, c.level, c.fix])).toEqual([['no backups', 'Silver', 'Turn on backups']])
    expect(map.counts.failing).toBe(1)
  })

  it('keeps the rule, with no reason given, for a reader who may not see them', async () => {
    const map = await json<MapResponse>(await bob('/v1/map/program/solo'))
    const failing = map.members[0]!.checks.filter((c) => c.state === 'fail')
    expect(failing.map((c) => [c.id, c.unexplained])).toEqual([['silver', true]])
  })
})
