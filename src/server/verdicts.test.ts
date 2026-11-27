import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ChangeObserved, ChangeStatement } from '../shared/change.ts'
import { SAFE_PATH_BLUEPRINT, type ActionRun, type Change, type Entity, type EntityDetail } from '../shared/model.ts'
import { AnnalsForwarder, type AnnalsEvent } from './annals.ts'
import { loadConfig } from './config.ts'
import { createHub, type Hub } from './hub.ts'
import { createLogger } from './log.ts'
import { pathSteps, standing, stepped } from './safe-paths.ts'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://orrery:orrery@localhost:5433/orrery'
const EXAMPLES = join(import.meta.dirname, '..', 'shared', 'change', 'examples')
const statement = (JSON.parse(readFileSync(join(EXAMPLES, 'event-stated.json'), 'utf8')) as { statement: ChangeStatement }).statement
const example = JSON.parse(readFileSync(join(EXAMPLES, 'event-observed.json'), 'utf8')) as ChangeObserved

let hub: Hub
let watch = ''
let other = ''
let run: ActionRun

const json = async <T = Record<string, unknown>>(r: Response): Promise<T> => (await r.json()) as T
const body = (v: unknown) => ({ body: JSON.stringify(v) })
const session = (path: string, init?: RequestInit) => Promise.resolve(hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', 'x-forwarded-email': 'admin@example.com', 'x-forwarded-groups': 'Admin', ...init?.headers } }, { surface: 'session' }))
const machine = (bearer: string) => (path: string, init?: RequestInit) => Promise.resolve(hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}`, ...init?.headers } }, { surface: 'machine' }))
const post = (bearer: string, events: unknown[]) => machine(bearer)('/v1/ingest/change-events', { method: 'POST', ...body({ events }) })

/** A verdict on the run's change, keyed `key`, closing its window at `to`, with these sights. */
const verdict = (key: string, to: string, sights: ChangeObserved['sights']): ChangeObserved => ({
  ...example,
  key,
  at: to,
  from: '2026-11-26T20:00:00Z',
  to,
  of: { sender: 'orrery', key: `${run.id}.stated` },
  digest: run.statementDigest!,
  sights,
  incidents: [],
})
const swap = (verdict: 'clean' | 'harm' | 'blind', kind = 'stops') => ({ kind, subject: { blueprint: 'workload', key: 'acme-api-prod' }, path: 'swap', verdict })
const safePath = async (key: string): Promise<EntityDetail | null> => {
  const r = await session(`/v1/entities/${SAFE_PATH_BLUEPRINT}/${encodeURIComponent(key)}`)
  return r.status === 200 ? json<EntityDetail>(r) : null
}

beforeAll(async () => {
  const config = loadConfig({ DATABASE_URL, DATA_DIR: mkdtempSync(join(tmpdir(), 'orrery-')), AUTH_MODE: 'proxy', PUBLIC_URL: 'https://hub.example.com' })
  hub = await createHub(config, '9.9.9', { reset: true })
  expect((await session('/v1/blueprints/workload', { method: 'PUT', ...body({ title: 'Workload', fields: {} }) })).status).toBeLessThan(300)
  expect((await session('/v1/sources/cluster', { method: 'PUT', ...body({ title: 'Cluster', class: 'pusher', blueprints: ['workload'] }) })).status).toBe(200)
  const cluster = (await hub.sources.issueToken('source', 'cluster', { source: 'cluster' })).token
  expect((await machine(cluster)('/v1/ingest/entities/workload/acme-api-prod', { method: 'PUT', ...body({ title: 'Acme API' }) })).status).toBe(201)
  expect((await session('/v1/sources/dispatch', { method: 'PUT', ...body({ title: 'The desk', class: 'event', blueprints: [], watches: true }) })).status).toBe(200)
  expect((await session('/v1/sources/other', { method: 'PUT', ...body({ title: 'Another', class: 'event', blueprints: [] }) })).status).toBe(200)
  watch = (await hub.sources.issueToken('source', 'desk', { source: 'dispatch' })).token
  other = (await hub.sources.issueToken('source', 'other', { source: 'other' })).token
  expect((await session('/v1/actions/apply_now', { method: 'PUT', ...body({ title: 'Apply', backend: { type: 'caller' }, inputs: { plan: { type: 'change', required: true } } }) })).status).toBe(200)
  run = await json<ActionRun>(await session('/v1/actions/apply_now/run', { method: 'POST', ...body({ inputs: { plan: statement } }) }))
  expect(run.statementDigest).toMatch(/^sha256:/)
})

afterAll(async () => {
  await hub.close()
})

describe('what a verdict says of safe paths', () => {
  it('proves a path the change went through cleanly, fails one it hurt, and says nothing of in-place, blind, or an exposure', () => {
    expect(pathSteps({ sights: [swap('clean'), { ...swap('clean'), path: 'in-place' }, { ...swap('blind'), path: 'rolling' }, { ...swap('clean', 'opens'), path: 'blue-green' }] })).toEqual([{ subject: { blueprint: 'workload', key: 'acme-api-prod' }, path: 'swap', outcome: 'proven' }])
    expect(pathSteps({ sights: [swap('harm', 'cuts'), swap('clean')] })).toEqual([{ subject: { blueprint: 'workload', key: 'acme-api-prod' }, path: 'swap', outcome: 'failed' }])
    // A kind the estate adds is a disruption: the watch watches nothing else.
    expect(pathSteps({ sights: [swap('clean', 'halts')] })).toHaveLength(1)
  })

  it('moves each day only forward, and stands green only while proven after the last harm', () => {
    const none = { proven_at: null, proven_run: null, failed_at: null, failed_run: null }
    const proven = stepped(none, 'proven', '2026-11-27T10:00:00Z', 'r1')
    expect(proven).toEqual({ ...none, proven_at: '2026-11-27T10:00:00Z', proven_run: 'r1' })
    expect(stepped(proven, 'proven', '2026-11-27T09:00:00Z', 'r0')).toBe(proven)
    expect(standing(proven).status).toBe('green')
    const failed = stepped(proven, 'failed', '2026-11-27T11:00:00Z', 'r2')
    expect(standing(failed)).toEqual({ status: 'red', reason: 'it did harm after it was last proven' })
    expect(standing(stepped(failed, 'proven', '2026-11-27T12:00:00Z', 'r3')).status).toBe('green')
  })
})

describe("the watch's verdicts, posted to the hub", () => {
  it('are refused to a source no admin let post them', async () => {
    const r = await post(other, [verdict('v-0', '2026-11-26T21:00:00Z', [swap('clean')])])
    expect(r.status).toBe(403)
    // The grant is an admin's alone to give.
    expect((await session('/v1/sources/other', { method: 'PUT', ...body({ title: 'Another', class: 'event', blueprints: [], watches: true }), headers: { 'x-forwarded-groups': '' } })).status).toBe(403)
  })

  it('are refused whole, naming the first event the hub cannot take', async () => {
    const good = verdict('v-good', '2026-11-26T21:00:00Z', [swap('clean')])
    const cases: [unknown, RegExp][] = [
      [{ ...good, note: 'x' }, /^events\[1\]: note is not part of a change event$/],
      [{ ...good, event: 'change.ended' }, /^events\[1\]: event must be change\.observed/],
      [{ ...good, of: { sender: 'orrery', key: 'nothing.stated' } }, /^events\[1\]: of\.key nothing\.stated names no change this hub stated$/],
      [{ ...good, of: { sender: 'muster', key: `${run.id}.stated` } }, /^events\[1\]: of\.sender is muster/],
      [{ ...good, digest: `sha256:${'0'.repeat(64)}` }, /^events\[1\]: digest is sha256:0+, the change/],
    ]
    for (const [bad, error] of cases) {
      const r = await post(watch, [good, bad])
      expect(r.status).toBe(400)
      const answer = await json<{ error: string; index: number }>(r)
      expect(answer.index).toBe(1)
      expect(answer.error).toMatch(error)
    }
    // None of a refused batch is kept, the good event either.
    expect(await safePath('workload/acme-api-prod/swap')).toBeNull()
    expect((await post(watch, [])).status).toBe(400)
  })

  it('prove a safe path, kept once for each sender and key, as the source that posted them', async () => {
    const first = verdict('v-1', '2026-11-26T21:00:00Z', [swap('clean'), { ...swap('harm'), path: 'in-place' }, { ...swap('clean'), subject: { blueprint: 'workload', key: 'acme-gone' } }])
    const r = await post(watch, [{ ...first, sender: 'someone-else' }])
    expect(r.status).toBe(200)
    expect(await json(r)).toEqual({ kept: 1, duplicate: 0 })
    const path = await safePath('workload/acme-api-prod/swap')
    expect(path).toMatchObject({ title: 'swap on Acme API', owner: 'hub', fields: { path: 'swap', subject_blueprint: 'workload', subject_key: 'acme-api-prod', proven_run: run.id, status: 'green' } })
    expect(Date.parse(String(path!.fields.proven_at))).toBe(Date.parse('2026-11-26T21:00:00Z'))
    expect(path!.fields.failed_at ?? null).toBeNull()
    // Neither in-place nor a thing the catalog does not hold makes a safe path.
    expect(await safePath('workload/acme-api-prod/in-place')).toBeNull()
    expect(await safePath('workload/acme-gone/swap')).toBeNull()

    // The thing's page links to it, and the hub keeps the verdict with the run, under the source's own name.
    const thing = await json<EntityDetail>(await session('/v1/entities/workload/acme-api-prod'))
    expect(thing.incoming.map((e) => `${e.declaredOn}.${e.relation}`)).toContain(`${SAFE_PATH_BLUEPRINT}.of_workload`)
    const kept = (await json<{ changes: Change[] }>(await session('/v1/changes?kind=change.observed'))).changes
    expect(kept).toHaveLength(1)
    expect(kept[0]).toMatchObject({ source: 'dispatch', blueprint: null, detail: { run: run.id, event: { key: 'v-1', sender: 'dispatch' } } })

    expect(await json(await post(watch, [first, first]))).toEqual({ kept: 0, duplicate: 2 })
    expect((await json<{ changes: Change[] }>(await session('/v1/changes?kind=change.observed'))).changes).toHaveLength(1)
  })

  it('move the day a path failed on harm, and nothing on a blind sight or an earlier window', async () => {
    expect(await json(await post(watch, [verdict('v-2', '2026-11-26T22:00:00Z', [swap('blind')])]))).toEqual({ kept: 1, duplicate: 0 })
    expect(Date.parse(String((await safePath('workload/acme-api-prod/swap'))!.fields.proven_at))).toBe(Date.parse('2026-11-26T21:00:00Z'))
    expect(await json(await post(watch, [verdict('v-3', '2026-11-26T23:00:00Z', [swap('harm')])]))).toEqual({ kept: 1, duplicate: 0 })
    const failed = await safePath('workload/acme-api-prod/swap')
    expect(failed!.fields).toMatchObject({ failed_run: run.id, status: 'red' })
    expect(Date.parse(String(failed!.fields.failed_at))).toBe(Date.parse('2026-11-26T23:00:00Z'))
    expect(await json(await post(watch, [verdict('v-4', '2026-11-26T20:30:00Z', [swap('clean')])]))).toEqual({ kept: 1, duplicate: 0 })
    expect((await safePath('workload/acme-api-prod/swap'))!.fields.status).toBe('red')
    const list = await json<{ entities: Entity[] }>(await session(`/v1/entities?blueprint=${SAFE_PATH_BLUEPRINT}&filter=${encodeURIComponent(JSON.stringify({ relation: 'of_workload', target: 'workload:acme-api-prod' }))}`))
    expect(list.entities.map((e) => e.key)).toEqual(['workload/acme-api-prod/swap'])
  })

  it('never reach Annals from the hub: the watch sends its own', async () => {
    const sent: AnnalsEvent[] = []
    const forwarder = new AnnalsForwarder(hub.db, { url: 'http://annals.example', token: 't' }, createLogger('annals'), async (_url, init) => {
      const events = JSON.parse(String(init?.body)) as AnnalsEvent[]
      sent.push(...events)
      return new Response(JSON.stringify({ results: events.map((_, index) => ({ index, status: 'stored' })) }), { status: 200 })
    })
    await forwarder.pass()
    expect(sent.some((e) => e.event_key === `${run.id}.stated`)).toBe(true)
    expect(sent.some((e) => e.action.verb === 'change.observed')).toBe(false)
  })
})
