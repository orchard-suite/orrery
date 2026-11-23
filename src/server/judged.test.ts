import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { EntityPageResponse, Scorecard, ScorecardResults } from '../shared/api.ts'
import type { Source } from '../shared/model.ts'
import { loadConfig } from './config.ts'
import { createHub, type Hub } from './hub.ts'

// Its own database: these tests set who a signed-in person is, which every other test would then read.
const DATABASE_URL = (process.env.DATABASE_URL ?? 'postgres://orrery:orrery@localhost:5433/orrery') + '_judged'

let hub: Hub
let judge = ''
let rival = ''

const as = (email: string, groups = 'User') => (path: string, init?: RequestInit) =>
  hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', 'x-forwarded-email': email, 'x-forwarded-groups': groups, ...init?.headers } }, { surface: 'session' })
const machine = (bearer: () => string) => (path: string, init?: RequestInit) => hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer()}`, ...init?.headers } }, { surface: 'machine' })
const json = async <T = Record<string, unknown>>(r: Response): Promise<T> => (await r.json()) as T
const put = (v: unknown) => ({ method: 'PUT', body: JSON.stringify(v) })
const post = (v: unknown) => ({ method: 'POST', body: JSON.stringify(v) })

const admin = as('admin@example.org', 'Admin')
// In the platform team, which sees the verdicts.
const insider = as('ada@example.org')
// In another team: sees the services, never a verdict.
const outsider = as('bob@example.org')
const asJudge = machine(() => judge)
const asRival = machine(() => rival)

/** A scorecard as a judge puts it: each rule copied from what it said, by the rule's own id. */
const card = (title = 'Recoverable') => ({
  title,
  levels: [{ name: 'Bronze' }, { name: 'Silver' }],
  blueprints: {
    service: {
      where: { field: 'said', op: 'exists' },
      rules: {
        Bronze: [
          { id: 'backed_up', title: 'Has a backup', judged: { field: 'said', check: 'vm.backed-up' }, fix: 'Add it to a backup policy' },
          { id: 'tagged', title: 'Has a criticality', judged: { field: 'said', check: 'tagged' } },
        ],
        Silver: [{ id: 'recent', title: 'Backed up in the last day', judged: { field: 'said', check: 'recent' } }],
      },
    },
  },
})

const save = async (spec: { id: string } & Record<string, unknown>) => {
  const res = await admin(`/v1/blueprints/${spec.id}`, put(spec))
  expect(res.status, await res.clone().text()).toBe(200)
}
const fields = async (reader: typeof admin, key: string) => (await json<EntityPageResponse>(await reader(`/v1/entities/service/${key}`))).fields
const rows = async (reader: typeof admin, id = 'recoverable') => {
  const r = await reader(`/v1/scorecards/${id}/results`)
  expect(r.status, await r.clone().text()).toBe(200)
  return Object.fromEntries((await json<ScorecardResults>(r)).rows.map((x) => [x.entity.key, x]))
}

beforeAll(async () => {
  const pg = await import('pg').then(({ default: m }) => new m.Client({ connectionString: DATABASE_URL.replace(/\/[^/]+$/, '/postgres') }))
  await pg.connect()
  await pg.query(`DROP DATABASE IF EXISTS ${DATABASE_URL.split('/').pop()}`)
  await pg.query(`CREATE DATABASE ${DATABASE_URL.split('/').pop()}`)
  await pg.end()
  hub = await createHub(loadConfig({ DATABASE_URL, DATA_DIR: mkdtempSync(join(tmpdir(), 'orrery-')), AUTH_MODE: 'proxy' }), 'test', { reset: true })

  await save({ id: 'team', title: 'Team', fields: {}, relations: {} })
  await save({ id: 'user', title: 'Person', fields: {}, relations: { team: { target: 'team', many: true } } })
  await save({
    id: 'service',
    title: 'Service',
    relations: {},
    fields: { said: { type: 'object', summary: true, aggregation: { relation: '<-verdict:service', fn: 'checks', field: 'checks', where: { field: 'pack', op: 'eq', value: 'recoverable' } } } },
  })
  await save({ id: 'verdict', title: 'Verdict', fields: { pack: { type: 'string' }, checks: { type: 'object' } }, relations: { service: { target: 'service' } }, access: { grants: [{ path: 'team', values: ['platform'] }] } })
  expect((await admin('/v1/access/person', put({ blueprint: 'user' }))).status).toBe(200)

  const create = async (blueprint: string, key: string, values: Record<string, unknown> = {}, relations: Record<string, unknown> = {}) =>
    expect((await admin('/v1/entities', post({ blueprint, key, title: key, fields: values, relations }))).status).toBe(201)
  await create('team', 'platform')
  await create('team', 'sales')
  await create('user', 'ada@example.org', {}, { team: ['platform'] })
  await create('user', 'bob@example.org', {}, { team: ['sales'] })
  for (const key of ['bronze', 'silver', 'unknown', 'na', 'unjudged']) await create('service', key)
  // At Bronze: Silver's rule failed.
  await create('verdict', 'v-bronze', { pack: 'recoverable', checks: { 'vm.backed-up': 'pass', tagged: 'pass', recent: 'fail' } }, { service: 'bronze' })
  // At the top; another pack's failure on the same service is no part of this one.
  await create('verdict', 'v-silver', { pack: 'recoverable', checks: { 'vm.backed-up': 'pass', tagged: 'pass', recent: 'pass' } }, { service: 'silver' })
  await create('verdict', 'v-silver-other', { pack: 'secure', checks: { 'vm.backed-up': 'fail' } }, { service: 'silver' })
  // No data on one Bronze rule holds it below Bronze; anything that is not a state is dropped.
  await create('verdict', 'v-unknown', { pack: 'recoverable', checks: { 'vm.backed-up': 'pass', tagged: 'unknown', recent: 'pass', noise: 'maybe' } }, { service: 'unknown' })
  // The backup rules do not apply to it: it stands on what does.
  await create('verdict', 'v-na', { pack: 'recoverable', checks: { tagged: 'pass' } }, { service: 'na' })

  await hub.sources.save('judge', { title: 'Judge', class: 'pusher', blueprints: ['verdict'] })
  await hub.sources.save('rival', { title: 'Rival', class: 'pusher', blueprints: ['verdict'] })
  judge = (await hub.sources.issueToken('source', 'judge', { source: 'judge' })).token
  rival = (await hub.sources.issueToken('source', 'rival', { source: 'rival' })).token
})

afterAll(async () => {
  await hub.close()
})

describe('a checks aggregation', () => {
  it('holds each rule of the records it reads, a failure over no data over a pass, and drops what is not a state', async () => {
    expect(await fields(admin, 'bronze')).toMatchObject({ said: { 'vm.backed-up': 'pass', tagged: 'pass', recent: 'fail' } })
    expect((await fields(admin, 'unknown')).said).toEqual({ 'vm.backed-up': 'pass', tagged: 'unknown', recent: 'pass' })
    expect((await fields(admin, 'unjudged')).said).toBeNull()
  })

  it('is shown as a summary to a reader who may not see the records, and as nothing more', async () => {
    expect((await fields(outsider, 'unknown')).said).toEqual({ 'vm.backed-up': 'pass', tagged: 'unknown', recent: 'pass' })
    expect((await json<{ total: number }>(await outsider('/v1/entities?blueprint=verdict'))).total ?? 0).toBe(0)
  })

  it('is refused on a field that is not an object', async () => {
    const res = await admin('/v1/blueprints/service', put({ id: 'service', title: 'Service', relations: {}, fields: { said: { type: 'number', aggregation: { relation: '<-verdict:service', fn: 'checks', field: 'checks' } } } }))
    expect(res.status).toBe(400)
    expect(await res.text()).toMatch(/object/)
  })
})

describe('a scorecard a judge puts', () => {
  it('is refused until an admin grants the source scorecards', async () => {
    expect((await asJudge('/v1/scorecards/recoverable', put(card()))).status).toBe(403)
    const keeper = as('keeper@example.org', 'Admin')
    expect((await keeper('/v1/sources/judge', put({ title: 'Judge', class: 'pusher', blueprints: ['verdict'], scorecards: true }))).status).toBe(200)
    expect(hub.sources.get('judge')?.scorecards).toBe(true)
  })

  it("is the source's own, and lists in what it wrote", async () => {
    const res = await asJudge('/v1/scorecards/recoverable', put(card()))
    expect(res.status, await res.clone().text()).toBe(200)
    expect((await json<Scorecard>(res)).origin).toEqual({ kind: 'source', source: 'judge' })
    await hub.writes.flush()
    expect((await json<{ source: Source }>(await admin('/v1/sources/judge'))).source.writes.scorecards.map((s) => s.id)).toEqual(['recoverable'])
  })

  it('scores each rule as the judge said it, holds an entity below a level for no data, and leaves out a rule that does not apply', async () => {
    const by = await rows(admin)
    expect(by.bronze).toMatchObject({ levelName: 'Bronze', rules: { backed_up: true, tagged: true, recent: false } })
    expect(by.silver).toMatchObject({ levelName: 'Silver', rules: { backed_up: true, tagged: true, recent: true } })
    expect(by.unknown).toMatchObject({ level: -1, rules: { backed_up: true, tagged: null, recent: true } })
    expect(by.na!.rules).toEqual({ tagged: true })
    expect(by.na!.levelName).toBe('Silver')
    // Nothing the judge said of it: out of scope.
    expect(by.unjudged).toBeUndefined()
  })

  it('reads the same to a reader who sees the services and not the verdicts', async () => {
    expect(await rows(outsider)).toEqual(await rows(insider))
  })

  it('is kept from a person, and from another source', async () => {
    const edit = await admin('/v1/scorecards/recoverable', put(card('Mine now')))
    expect(edit.status).toBe(400)
    expect((await json<{ error: string }>(edit)).error).toMatch(/put by source "judge"/)
    expect((await admin('/v1/scorecards/recoverable', { method: 'DELETE' })).status).toBe(200)
    expect((await asJudge('/v1/scorecards/recoverable', put(card()))).status).toBe(200)
    expect((await as('keeper@example.org', 'Admin')('/v1/sources/rival', put({ title: 'Rival', class: 'pusher', blueprints: ['verdict'], scorecards: true }))).status).toBe(200)
    expect((await asRival('/v1/scorecards/recoverable', put(card('Ours')))).status).toBe(400)
    expect((await asRival('/v1/scorecards/recoverable', { method: 'DELETE' })).status).toBe(400)
    expect((await asJudge('/v1/scorecards/recoverable', { method: 'DELETE' })).status).toBe(200)
  })

  it('takes over a scorecard people made, so its history goes on', async () => {
    expect((await admin('/v1/scorecards/tidy', put({ ...card('Tidy') }))).status).toBe(200)
    const res = await asJudge('/v1/scorecards/tidy', put(card('Tidy')))
    expect(res.status).toBe(200)
    expect((await json<Scorecard>(res)).origin).toEqual({ kind: 'source', source: 'judge' })
  })

  it('gives nothing else of the model to the source', async () => {
    expect((await asJudge('/v1/blueprints/service', put({ id: 'service', title: 'Mine', relations: {}, fields: {} }))).status).toBe(403)
    expect((await asJudge('/v1/scorecards/tidy', put({ ...card('Tidy'), levels: [{ name: 'Bronze' }] }))).status).toBe(400)
  })
})
