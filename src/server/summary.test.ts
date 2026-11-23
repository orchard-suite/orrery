import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { BlueprintsResponse, EntitiesResponse, EntityPageResponse, ScorecardResults } from '../shared/api.ts'
import type { PostureReach, PostureResponse, PostureWho } from '../shared/posture.ts'
import { loadConfig } from './config.ts'
import { createHub, type Hub } from './hub.ts'

// Its own database: these tests set who a signed-in person is, which every other test would then read.
const DATABASE_URL = (process.env.DATABASE_URL ?? 'postgres://orrery:orrery@localhost:5433/orrery') + '_summary'

let hub: Hub

const as = (email: string, groups = 'User') => (path: string, init?: RequestInit) =>
  hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', 'x-forwarded-email': email, 'x-forwarded-groups': groups, ...init?.headers } }, { surface: 'session' })
const json = async <T = Record<string, unknown>>(r: Response): Promise<T> => (await r.json()) as T
const put = (v: unknown) => ({ method: 'PUT', body: JSON.stringify(v) })
const post = (v: unknown) => ({ method: 'POST', body: JSON.stringify(v) })

const admin = as('admin@example.org', 'Admin')
// In the platform team, which holds the flaws.
const insider = as('ada@example.org')
// In another team: sees the services, never a flaw.
const outsider = as('bob@example.org')

const LINK = 'https://flaws.example.org/s1'
const TREND = { points: [{ at: '2026-01-01T00:00:00.000Z', value: 1 }, { at: '2026-02-01T00:00:00.000Z', value: 3 }], step: true, link: LINK, link_title: 'Every flaw' }

const flawCount = { relation: '<-flaw:service', fn: 'count' }
/** The service blueprint, with `flaws` and `flaws_trend` marked or not. */
const service = (summary: boolean) => ({
  id: 'service',
  title: 'Service',
  relations: {},
  fields: {
    flaws: { type: 'number', aggregation: flawCount, ...(summary ? { summary: true } : {}) },
    worst: { type: 'number', aggregation: { relation: '<-flaw:service', fn: 'max', field: 'severity' }, ...(summary ? { summary: true } : {}) },
    flaws_trend: { type: 'trend', aggregation: { relation: '<-flaw:service', fn: 'max', field: 'trend' }, ...(summary ? { summary: true } : {}) },
    // Worked out from a summary, so shown with it and needing no mark.
    flaws_doubled: { type: 'number', calculation: 'flaws * 2', history: { keep: '30d' } },
    flaws_history: { type: 'trend', history: { of: 'flaws_doubled', every: '1d', last: '7d' } },
    // The same count, never marked.
    flaws_unmarked: { type: 'number', aggregation: flawCount },
    // Marked, and no summary: the largest of a text is a text of one flaw.
    loudest: { type: 'number', aggregation: { relation: '<-flaw:service', fn: 'max', field: 'note' }, ...(summary ? { summary: true } : {}) },
    // Marked, and still withheld by its own rule.
    flaws_ruled: { type: 'number', aggregation: flawCount, ...(summary ? { summary: true } : {}), access: { grants: [{ path: 'team', values: ['platform'] }] } },
    // Reads a trend summary, whose link it could carry out: withheld with what the trend reads.
    trend_copy: { type: 'string', calculation: 'flaws_trend' },
  },
})

const save = async (spec: { id: string } & Record<string, unknown>) => {
  const res = await admin(`/v1/blueprints/${spec.id}`, put(spec))
  expect(res.status, await res.clone().text()).toBe(200)
}
const fields = async (reader: typeof admin, key = 's1') => (await json<EntityPageResponse>(await reader(`/v1/entities/service/${key}?provenance=true`))).fields
const model = async (reader: typeof admin) => (await json<BlueprintsResponse>(await reader('/v1/blueprints'))).blueprints.find((b) => b.id === 'service')!
const filtered = (reader: typeof admin, filter: unknown, extra = '') => reader(`/v1/entities?blueprint=service&filter=${encodeURIComponent(JSON.stringify(filter))}${extra}`)

beforeAll(async () => {
  const pg = await import('pg').then(({ default: m }) => new m.Client({ connectionString: DATABASE_URL.replace(/\/[^/]+$/, '/postgres') }))
  await pg.connect()
  await pg.query(`DROP DATABASE IF EXISTS ${DATABASE_URL.split('/').pop()}`)
  await pg.query(`CREATE DATABASE ${DATABASE_URL.split('/').pop()}`)
  await pg.end()
  hub = await createHub(loadConfig({ DATABASE_URL, DATA_DIR: mkdtempSync(join(tmpdir(), 'orrery-')), AUTH_MODE: 'proxy' }), 'test', { reset: true })

  await save({ id: 'team', title: 'Team', fields: {}, relations: {} })
  await save({ id: 'user', title: 'Person', fields: {}, relations: { team: { target: 'team', many: true } } })
  await save(service(false))
  await save({ id: 'flaw', title: 'Flaw', fields: { severity: { type: 'number' }, note: { type: 'string' }, trend: { type: 'trend' } }, relations: { service: { target: 'service' } }, access: { grants: [{ path: 'team', values: ['platform'] }] } })
  expect((await admin('/v1/access/person', put({ blueprint: 'user' }))).status).toBe(200)

  const create = async (blueprint: string, key: string, values: Record<string, unknown> = {}, relations: Record<string, unknown> = {}) =>
    expect((await admin('/v1/entities', post({ blueprint, key, title: key, fields: values, relations }))).status).toBe(201)
  await create('team', 'platform')
  await create('team', 'sales')
  await create('user', 'ada@example.org', {}, { team: ['platform'] })
  await create('user', 'bob@example.org', {}, { team: ['sales'] })
  await create('service', 's1')
  await create('service', 's2')
  await create('flaw', 'f1', { severity: 3, note: 'whispered', trend: TREND }, { service: 's1' })
  await create('flaw', 'f2', { severity: 1, note: 'quiet' }, { service: 's1' })
})

afterAll(async () => {
  await hub.close()
})

describe('an aggregation over what a reader may not see', () => {
  it('is withheld, with everything worked out from it, until it is marked a summary', async () => {
    expect(await fields(insider)).toMatchObject({ flaws: 2, worst: 3, flaws_doubled: 4, flaws_unmarked: 2 })
    const theirs = await fields(outsider)
    for (const name of ['flaws', 'worst', 'flaws_trend', 'flaws_doubled', 'flaws_history', 'flaws_unmarked', 'loudest', 'flaws_ruled', 'trend_copy']) expect(theirs).not.toHaveProperty(name)
    expect((await filtered(outsider, { field: 'flaws', op: 'gt', value: 0 })).status).toBe(404)
  })
})

describe('an aggregation marked a summary', () => {
  beforeAll(async () => {
    await save(service(true))
    expect((await admin('/v1/scorecards/tidy', put({ blueprint: 'service', title: 'Tidy', levels: [{ name: 'Tidy', rules: [{ id: 'none', title: 'Has no flaw', where: { field: 'flaws', op: 'eq', value: 0 } }] }] }))).status).toBe(200)
    expect((await admin('/v1/scorecards/unmarked', put({ blueprint: 'service', title: 'Unmarked', levels: [{ name: 'Tidy', rules: [{ id: 'none', title: 'Has no flaw', where: { field: 'flaws_unmarked', op: 'eq', value: 0 } }] }] }))).status).toBe(200)
  })

  it('shows its number to a reader who may not see what it reads, and what is worked out from it', async () => {
    const theirs = await fields(outsider)
    expect(theirs).toMatchObject({ flaws: 2, worst: 3, flaws_doubled: 4 })
    expect(theirs).toHaveProperty('flaws_history')
    expect((await fields(outsider, 's2')).flaws).toBe(0)
  })

  it('leaves an unmarked one hidden, and one its own rule withholds', async () => {
    const theirs = await fields(outsider)
    expect(theirs).not.toHaveProperty('flaws_unmarked')
    expect(theirs).not.toHaveProperty('flaws_ruled')
    expect(await fields(insider)).toMatchObject({ flaws_unmarked: 2, flaws_ruled: 2 })
  })

  it('opens nothing where the result is not a number or a trend', async () => {
    expect(await fields(outsider)).not.toHaveProperty('loudest')
    expect((await admin('/v1/blueprints/service', put({ ...service(true), fields: { ...service(true).fields, said: { type: 'string', aggregation: { relation: '<-flaw:service', fn: 'max', field: 'note' }, summary: true } } }))).status).toBe(400)
    expect((await admin('/v1/blueprints/service', put({ ...service(true), fields: { ...service(true).fields, doubled: { type: 'number', calculation: 'flaws * 2', summary: true } } }))).status).toBe(400)
  })

  it('gives a trend without the link to its history, and lets nothing else read the trend', async () => {
    expect((await fields(admin)).flaws_trend).toMatchObject({ link: LINK })
    expect((await fields(insider)).flaws_trend).toMatchObject({ link: LINK })
    const trend = (await fields(outsider)).flaws_trend as Record<string, unknown>
    expect(trend.points).toEqual(TREND.points)
    expect(trend).not.toHaveProperty('link')
    expect(trend).not.toHaveProperty('link_title')
    expect(await fields(outsider)).not.toHaveProperty('trend_copy')
    expect((await filtered(outsider, { field: 'flaws_trend', op: 'exists' })).status).toBe(404)
    expect((await outsider('/v1/entities?blueprint=service&sort=flaws_trend')).status).toBe(404)
    expect((await json<EntitiesResponse>(await filtered(outsider, { search: 'flaws.example.org' }))).total).toBe(0)
    expect((await json<EntitiesResponse>(await filtered(insider, { search: 'flaws.example.org' }))).total).toBe(1)
  })

  it('answers a question about the number, and none about what it reads', async () => {
    const hit = await json<EntitiesResponse>(await filtered(outsider, { field: 'flaws', op: 'gt', value: 0 }))
    expect(hit.entities.map((e) => e.key)).toEqual(['s1'])
    expect(hit.entities[0]!.fields.flaws_trend).not.toHaveProperty('link')
    expect((await outsider('/v1/entities?blueprint=service&sort=flaws')).status).toBe(200)
    // The rows themselves, a relation to them, and a condition on them stay closed.
    expect((await outsider('/v1/entities?blueprint=flaw')).status).toBe(404)
    expect((await outsider('/v1/entities/flaw/f1')).status).toBe(404)
    expect((await filtered(outsider, { relation: '<-flaw:service', op: 'exists' })).status).toBe(404)
    expect((await filtered(outsider, { relation: '<-flaw:service', where: { field: 'severity', op: 'gt', value: 2 } })).status).toBe(404)
    expect((await json<EntitiesResponse>(await filtered(outsider, { search: 'whispered' }))).total).toBe(0)
    const page = await json<EntityPageResponse>(await outsider('/v1/entities/service/s1?provenance=true'))
    expect(JSON.stringify(page)).not.toContain('f1')
    expect(JSON.stringify(page)).not.toContain('whispered')
    expect(page.incoming).toEqual([])
    const listed = await json<EntitiesResponse>(await outsider('/v1/entities?blueprint=service&incoming=true'))
    expect(JSON.stringify(listed)).not.toContain('flaw.service')
  })

  it('fills a query column with the number, and none with what it reads', async () => {
    const ask = (reader: typeof admin) => reader('/v1/query', post({ sources: [{ blueprint: 'service', clauses: [] }], columns: ['title', 'flaws', 'flaws_trend', 'flaws_unmarked', 'r:<-flaw:service', 'r:<-flaw:service@note'] }))
    const ours = JSON.stringify(await json(await ask(insider)))
    expect(ours).toContain(LINK)
    expect(ours).toContain('whispered')
    const res = await ask(outsider)
    expect(res.status).toBe(200)
    const theirs = JSON.stringify(await json(res))
    expect(theirs).toContain('"values":["s1",2,')
    for (const closed of [LINK, 'whispered', 'f1', 'flaws_unmarked', '<-flaw']) expect(theirs).not.toContain(closed)
  })

  it('says it is derived, and not from what, to a reader of the summary alone', async () => {
    const theirs = await model(outsider)
    expect(theirs.fields.flaws).toEqual({ type: 'number', derived: true })
    expect(JSON.stringify(theirs)).not.toContain('<-flaw')
    expect(JSON.stringify(theirs)).not.toContain('severity')
    expect((await model(insider)).fields.flaws).toMatchObject({ aggregation: flawCount, summary: true })
    expect((await json<BlueprintsResponse>(await outsider('/v1/blueprints'))).blueprints.map((b) => b.id)).not.toContain('flaw')
  })

  it('opens a scorecard level that reads it, and not one that reads an unmarked count', async () => {
    const page = await json<EntityPageResponse>(await outsider('/v1/entities/service/s2'))
    expect(page.levels).toEqual({ tidy: ['Tidy'] })
    expect((await json<ScorecardResults>(await outsider('/v1/scorecards/tidy/results'))).rows.length).toBe(2)
    expect((await outsider('/v1/scorecards/unmarked/results')).status).toBe(404)
  })

  it('is kept as it was when a reader of the summary alone saves the blueprint, and is an admin\'s alone to set', async () => {
    await admin('/v1/users/bob%40example.org/roles', put({ roles: ['architect'] }))
    const { origin: _o, updatedAt: _u, ...spec } = await model(outsider)
    const res = await outsider('/v1/blueprints/service', put({ ...spec, description: 'Something that runs' }))
    expect(res.status).toBe(200)
    // The answer to their own save is what they may read, too.
    expect((await json<{ fields: Record<string, unknown> }>(res)).fields.flaws).toEqual({ type: 'number', derived: true })
    expect(hub.blueprints.get('service')?.fields.flaws).toMatchObject({ aggregation: flawCount, summary: true })
    expect(hub.blueprints.get('service')?.fields.flaws_unmarked).toMatchObject({ aggregation: flawCount })
    expect((await outsider('/v1/blueprints/service', put({ ...spec, fields: { ...spec.fields, mine: { type: 'number', aggregation: flawCount, summary: true } } }))).status).toBe(403)
    expect((await outsider('/v1/model/import', post({ yaml: 'blueprints:\n  - id: service\n    title: Service\n    fields:\n      sneaked: { type: number, aggregation: { relation: "<-flaw:service", fn: count }, summary: true }\n' }))).status).toBe(403)
    await admin('/v1/users/bob%40example.org/roles', put({ roles: [] }))
  })

  it('is named in the posture, with who sees the field by it alone', async () => {
    const posture = await json<PostureResponse>(await admin('/v1/posture'))
    const item = (field: string) => posture.items.find((i) => i.target.kind === 'field' && i.target.blueprint === 'service' && i.target.field === field)!
    expect(item('flaws').field).toEqual({ type: 'number', summary: true, summaryOnly: 1 })
    expect(item('flaws').sensitive.join()).toContain('a summary')
    expect(item('flaws_unmarked').field).toEqual({ type: 'number' })
    // The mark that does not hold opens nothing, and is not called a summary.
    expect(item('loudest').field).toEqual({ type: 'number' })
    expect(item('flaws').people).toBe(item('flaws_unmarked').people + 1)
    const who = await json<PostureWho>(await admin('/v1/posture/who?target=field:service.flaws'))
    expect(who.summary).toBe(true)
    const row = (name: string) => who.rows.find((r) => r.principal.name === name)!
    expect(row('bob@example.org')).toMatchObject({ sees: true, summaryOnly: true })
    expect(row('bob@example.org').via).toContain('as a summary')
    expect(row('ada@example.org').sees).toBe(true)
    expect(row('ada@example.org')).not.toHaveProperty('summaryOnly')
    const unmarked = await json<PostureWho>(await admin('/v1/posture/who?target=field:service.flaws_unmarked'))
    expect(unmarked).not.toHaveProperty('summary')
    expect(unmarked.rows.find((r) => r.principal.name === 'bob@example.org')!.sees).toBe(false)
    const reach = await json<PostureReach>(await admin('/v1/posture/reach?kind=person&name=bob@example.org'))
    expect(reach.blueprints.find((b) => b.id === 'service')!.summaries).toEqual(['flaws', 'flaws_trend', 'worst'])
    expect(reach.blueprints.find((b) => b.id === 'flaw')!.sees).toBe(false)
  })
})
