import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { DatasetsResponse, QueryAnswer, QueryResult, SavedQuery } from '../shared/api.ts'
import { loadConfig } from './config.ts'
import { createHub, type Hub } from './hub.ts'
import { dataOfAnswer } from './reports.ts'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://orrery:orrery@localhost:5433/orrery'

let hub: Hub
let pusher = ''

const as = (email: string, groups = 'User') => (path: string, init?: RequestInit) => Promise.resolve(hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', 'x-forwarded-email': email, 'x-forwarded-groups': groups, ...init?.headers } }, { surface: 'session' }))
const ops = as('ops@example.org', 'Admin')
const ada = as('ada@example.org')
const machine = (path: string, init: RequestInit) => Promise.resolve(hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${pusher}`, ...init.headers } }, { surface: 'machine' }))
const put = (v: unknown) => ({ method: 'PUT', body: JSON.stringify(v) })
const post = (v: unknown) => ({ method: 'POST', body: JSON.stringify(v) })
const json = async <T>(r: Response): Promise<T> => (await r.json()) as T

const NIGHTS = [
  { pipeline: 'api', night: '2026-11-17T00:00:00Z', passed: '40', failed: 0, extra: 'dropped' },
  { pipeline: 'api', night: '2026-11-18T00:00:00Z', passed: 38, failed: 2 },
  { pipeline: 'ui', night: '2026-11-18T00:00:00Z', passed: 10, failed: 12 },
]

/** How many times the runner was asked for the table. */
let calls = 0

/** Waits for a request while playing the runner: a dataset's read waits on its tool. */
async function played<T>(request: Promise<T>): Promise<T> {
  let done = false
  void request.finally(() => (done = true)).catch(() => undefined)
  for (let i = 0; i < 300 && !done; i++) {
    for (const job of await hub.actions.claim('lake-runner')) {
      calls++
      await hub.actions.report(job.run, { state: 'succeeded', log: [JSON.stringify(NIGHTS)] }, { kind: 'runner', source: 'lake-runner' })
    }
    await new Promise((r) => setTimeout(r, 10))
  }
  return request
}

const dataset = (extra: Record<string, unknown> = {}) => ({
  title: 'Nightly runs',
  blueprint: 'store',
  inputs: {},
  backend: { type: 'runner', runner: 'lake-runner', command: ['nights'] },
  tool: { tier: 'read' },
  dataset: { entity: 'store:lake', columns: [{ id: 'pipeline', title: 'Pipeline' }, { id: 'night', type: 'datetime' }, { id: 'passed', title: 'Passed', type: 'number' }, { id: 'failed', title: 'Failed', type: 'number' }] },
  ...extra,
})

const spec = (view?: unknown) => ({ sources: [{ blueprint: '$data:nights', clauses: [] }], columns: [], ...(view ? { view } : {}) })

beforeAll(async () => {
  hub = await createHub(loadConfig({ DATABASE_URL, DATA_DIR: mkdtempSync(join(tmpdir(), 'orrery-')), AUTH_MODE: 'proxy', PUBLIC_URL: 'https://hub.example.org' }), 'test', { reset: true })
  await hub.sources.save('estate', { title: 'Estate', class: 'pusher', blueprints: ['*'], deleteGrant: [], cadence: '3m' })
  pusher = (await hub.sources.issueToken('source', 'estate', { source: 'estate' })).token
  await hub.sources.save('lake-runner', { title: 'Lake runner', class: 'runner', blueprints: [], deleteGrant: [], cadence: '5m', serves: { tiers: ['read'] } })
  expect((await ops('/v1/blueprints/store', put({ title: 'Store', fields: {}, relations: {} }))).status).toBe(200)
  await machine('/v1/ingest/entities/store/lake', put({ title: 'Quality lake' }))
  await hub.deriver.backfill()
  for (const who of [ada, ops]) await who('/v1/whoami')
  expect((await ops('/v1/actions/nights', put(dataset({ access: { everyone: true } })))).status).toBe(200)
  expect((await ops('/v1/actions/closed', put(dataset({ title: 'Closed runs' })))).status).toBe(200)
})

afterAll(async () => {
  await hub.close()
})

describe('a dataset', () => {
  it('is a read tool that names the entity it is called on and the columns it answers with', async () => {
    const acts = await ops('/v1/actions/wrong', put(dataset({ tool: { tier: 'act' } })))
    expect(acts.status).toBe(400)
    expect(await acts.text()).toContain('a dataset is a read tool')
    const nowhere = await ops('/v1/actions/wrong', put(dataset({ dataset: { columns: [{ id: 'a' }] } })))
    expect(await nowhere.text()).toContain('names the entity it is called on')
    const asks = await ops('/v1/actions/wrong', put(dataset({ inputs: { days: { type: 'number', required: true } } })))
    expect(await asks.text()).toContain('read with no inputs')
  })

  it('is listed only to whoever may read it', async () => {
    const mine = await json<DatasetsResponse>(await ada('/v1/datasets'))
    expect(mine.datasets.map((d) => d.id)).toEqual(['nights'])
    expect(mine.datasets[0]).toMatchObject({ title: 'Nightly runs', fresh: '15m', fetchedAt: null })
    expect((await json<DatasetsResponse>(await ops('/v1/datasets'))).datasets.map((d) => d.id)).toEqual(['closed', 'nights'])
  })

  it('answers a query with its rows, each value read as its column, and is not asked again while its answer is fresh', async () => {
    const before = calls
    const first = await json<QueryResult>(await played(ada('/v1/query', post(spec()))))
    expect(first.columns.map((c) => c.title)).toEqual(['Pipeline', 'night', 'Passed', 'Failed'])
    expect(first.rows.map((r) => r.values)).toEqual([['api', '2026-11-17T00:00:00Z', 40, 0], ['api', '2026-11-18T00:00:00Z', 38, 2], ['ui', '2026-11-18T00:00:00Z', 10, 12]])
    expect(calls).toBe(before + 1)
    const again = await json<QueryResult>(await ada('/v1/query', post(spec())))
    expect(again.rows).toHaveLength(3)
    expect(calls).toBe(before + 1)
    expect((await json<DatasetsResponse>(await ada('/v1/datasets'))).datasets[0]!.fetchedAt).not.toBeNull()
  })

  it('is filtered, grouped, and added up by a query as a blueprint is', async () => {
    const narrowed = await json<QueryResult>(await ada('/v1/query', post({ sources: [{ blueprint: '$data:nights', clauses: [{ field: 'failed', op: 'gt', value: '0' }] }], columns: ['pipeline', 'failed'] })))
    expect(narrowed.rows.map((r) => r.values)).toEqual([['api', 2], ['ui', 12]])
    const shaped = await json<QueryAnswer>(await ada('/v1/query?shaped=true', post(spec({ group: ['pipeline'], totals: { passed: 'sum' }, sort: [{ column: 'pipeline' }] }))))
    expect(shaped.groups?.map((g) => [g.value, g.count, g.totals.passed])).toEqual([['api', 2, 78], ['ui', 1, 10]])
    // A report takes that answer as the query shapes it: one row a group, with the totals as its numbers and its chart.
    const set = dataOfAnswer(shaped, { group: ['pipeline'], totals: { passed: 'sum' } })
    expect(set.columns.map((c) => c.id)).toEqual(['pipeline', 'rows', 'passed_sum'])
    expect(set.rows).toEqual([['api', 2, 78], ['ui', 1, 10]])
    expect(set.shape).toEqual({ totals: [{ name: 'passed', title: 'Passed', value: 88 }], chart: { x: 'pipeline', y: ['passed_sum'] } })
  })

  it('is left out of a shared query for a reader it is not open to, and refused when read by name', async () => {
    const saved = await json<SavedQuery>(await ops('/v1/queries', post({ title: 'Closed', shared: true, spec: { sources: [{ blueprint: '$data:closed', clauses: [] }], columns: [] } })))
    const theirs = await json<QueryResult>(await ada(`/v1/queries/${saved.id}/run`))
    expect(theirs.rows).toEqual([])
    expect((await ada('/v1/datasets/closed/refresh', post({}))).status).toBe(403)
  })

  it('is read again from its tool when asked afresh', async () => {
    const before = calls
    const res = await played(ada('/v1/datasets/nights/refresh', post({})))
    expect(res.status).toBe(200)
    expect(calls).toBe(before + 1)
  })
})
