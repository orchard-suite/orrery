import { mkdtempSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { isFinished, type ActionRun, type ActionView } from '../shared/model.ts'
import { loadConfig } from './config.ts'
import { loadFixtureCatalog } from './fixtures/load.ts'
import { createHub, type Hub } from './hub.ts'
import { createLogger } from './log.ts'
import { NoticeForwarder, type NoticeEvent } from './notices.ts'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://orrery:orrery@localhost:5433/orrery'

let hub: Hub
const KEYS = ['w/one', 'w/two', 'w/three', 'w/four', 'w/five', 'w/six']
let pusher = ''
let approver = ''
let reporter = ''
let hook: Server
let hookUrl = ''
/** Every call the webhook took, with when it answered. */
let calls: { path: string; at: number }[] = []
/** How many calls of each path the webhook holds now, and the most it ever held at once. */
const flying = new Map<string, number>()
const peak = new Map<string, number>()
/** The calls to `/held/<status>` the webhook holds until the test lets them answer. */
const held: (() => void)[] = []

const session = (path: string, init?: RequestInit): Promise<Response> => Promise.resolve(hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', 'x-forwarded-email': 'local@example.org', 'x-forwarded-groups': 'Admin', ...init?.headers } }, { surface: 'session' }))
const machine = (path: string, init: RequestInit | undefined, bearer: string) => Promise.resolve(hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}`, ...init?.headers } }, { surface: 'machine' }))
const json = async <T>(r: Response): Promise<T> => (await r.json()) as T
const body = (v: unknown) => ({ body: JSON.stringify(v) })

/** A webhook at `/wait/<ms>/<status>` answers with that status after that long, having done its work. */
const define = (id: string, wait: number, status: number, extra: Record<string, unknown> = {}) =>
  session(`/v1/actions/${id}`, { method: 'PUT', ...body({ title: id, blueprint: 'k8s_workload', inputs: {}, batch: { max: 20 }, backend: { type: 'webhook', url: `${hookUrl}/wait/${wait}/${status}`, finish: 'answer', ...extra }, ...(extra.approval ? { approval: true } : {}) }) })
const runOn = async (id: string, key = 'w/one') => json<ActionRun>(await session(`/v1/actions/${id}/run`, { method: 'POST', ...body({ entity: { blueprint: 'k8s_workload', key }, inputs: {} }) }))
const read = async (id: string) => (await hub.actions.getRun(id))!
/** The run once it has ended, however long its backend takes. */
const ended = (id: string, within: number) => vi.waitFor(async () => {
  const r = await read(id)
  if (!isFinished(r.state)) throw new Error(`still ${r.state}`)
  return r
}, { timeout: within, interval: 200 })

beforeAll(async () => {
  hook = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      const m = /^\/(?:wait\/(\d+)|held)\/(\d+)$/.exec(req.url ?? '')
      if (!m) return void res.writeHead(404).end()
      const path = req.url!
      flying.set(path, (flying.get(path) ?? 0) + 1)
      peak.set(path, Math.max(peak.get(path) ?? 0, flying.get(path)!))
      const answer = () => {
        flying.set(path, flying.get(path)! - 1)
        calls.push({ path, at: Date.now() })
        res.writeHead(Number(m[2])).end(Number(m[2]) < 300 ? 'done' : 'gave up')
      }
      if (m[1] === undefined) held.push(answer)
      else setTimeout(answer, Number(m[1]))
    })
  })
  await new Promise<void>((r) => hook.listen(0, '127.0.0.1', r))
  hookUrl = `http://127.0.0.1:${(hook.address() as { port: number }).port}`
  const config = loadConfig({ DATABASE_URL, DATA_DIR: mkdtempSync(join(tmpdir(), 'orrery-')), AUTH_MODE: 'proxy', PUBLIC_URL: 'https://hub.example.org' })
  hub = await createHub(config, 'test', { reset: true })
  expect((await loadFixtureCatalog(hub)).errors).toEqual([])
  await hub.sources.save('k8s@home', { title: 'k8s', class: 'pusher', blueprints: ['*'], deleteGrant: [], cadence: '3m' })
  pusher = (await hub.sources.issueToken('source', 'k8s', { source: 'k8s@home' })).token
  const admin = { admin: true, permissions: [] as never[], kind: 'user' as const, name: 'local', roles: [] }
  await hub.access.saveRole('lead', { title: 'Lead', permissions: ['actions.approve'] }, admin)
  await hub.access.saveRole('operator', { title: 'Operator', permissions: ['actions.report'] }, admin)
  approver = (await hub.sources.issueToken('access', 'lead', { role: 'lead' })).token
  reporter = (await hub.sources.issueToken('access', 'workflow', { role: 'operator' })).token
  for (const key of KEYS) await machine(`/v1/ingest/entities/k8s_workload/${encodeURIComponent(key)}`, { method: 'PUT', ...body({ title: key, fields: { name: key } }) }, pusher)
})

afterAll(async () => {
  hook.close()
  await hub.close()
})

describe('a webhook that answers slowly', () => {
  it('waits as long as its action says: past the half minute the hub used to wait, by default and with backend.timeout', async () => {
    expect((await define('slow_answer', 31_000, 200)).status).toBe(200)
    expect((await define('slow_named', 31_000, 200, { timeout: '2m' })).status).toBe(200)
    expect((await define('slow_short', 31_000, 200, { timeout: '30s' })).status).toBe(200)
    const asked = Date.now()
    const [run, named, short] = await Promise.all([runOn('slow_answer'), runOn('slow_named', 'w/two'), runOn('slow_short', 'w/three')])
    // The request that asked is answered long before the webhook is: the run says it waits.
    expect(Date.now() - asked).toBeLessThan(10_000)
    expect(run.state).toBe('running')
    expect(run.log.at(-1)!.message).toBe('waiting for webhook to answer, for up to 15 minutes')
    expect(named.log.at(-1)!.message).toBe('waiting for webhook to answer, for up to 2 minutes')
    const [done, namedDone, shortDone] = await Promise.all([ended(run.id, 45_000), ended(named.id, 45_000), ended(short.id, 45_000)])
    expect(done.state).toBe('succeeded')
    expect(done.log.at(-1)!.message).toBe('webhook answered 200: done')
    expect(Date.parse(done.finishedAt!) - Date.parse(done.startedAt!)).toBeGreaterThanOrEqual(30_000)
    expect(namedDone.state).toBe('succeeded')
    // Thirty seconds is too short for it: the hub stops waiting, and never calls it a failure.
    expect(shortDone.state).toBe('unknown')
    expect(shortDone.log.at(-1)!.message).toMatch(/^webhook did not answer within 30 seconds/)
  }, 60_000)

  it('hands every run of an approved batch on, and none of them fails behind the others', async () => {
    expect((await define('slow_batch', 3_000, 200, { approval: true })).status).toBe(200)
    const asked = await session('/v1/actions/slow_batch/batch', { method: 'POST', ...body({ entities: ['w/one', 'w/two', 'w/three'].map((key) => ({ blueprint: 'k8s_workload', key })), inputs: {} }) })
    expect(asked.status).toBe(201)
    const batch = (await json<{ id: string }>(asked)).id
    calls = []
    const approved = await machine(`/v1/action-batches/${batch}/approve`, { method: 'POST', ...body({}) }, approver)
    expect(await json(approved)).toEqual({ approved: 3, voted: 0, refused: [] })
    const ids = (await hub.db.query<{ id: string }>('SELECT id FROM action_runs WHERE batch = $1', [batch])).rows.map((r) => r.id)
    const runs = await Promise.all(ids.map((id) => ended(id, 20_000)))
    expect(runs.map((r) => r.state)).toEqual(['succeeded', 'succeeded', 'succeeded'])
    expect(calls).toHaveLength(3)
  }, 30_000)
})

describe('an action that runs a few at a time', () => {
  /** An action that runs `concurrency` at a time, its webhook answering after `wait` ms, or when the test lets it when `wait` is 'held'. */
  const capped = (id: string, wait: number | 'held', concurrency: number) =>
    session(`/v1/actions/${id}`, { method: 'PUT', ...body({ title: id, blueprint: 'k8s_workload', inputs: {}, batch: { max: 20 }, approval: true, concurrency, backend: { type: 'webhook', url: wait === 'held' ? `${hookUrl}/held/200` : `${hookUrl}/wait/${wait}/200`, finish: 'answer' } }) })
  const runsOf = async (action: string) => (await hub.db.query<{ id: string }>('SELECT id FROM action_runs WHERE action = $1 ORDER BY created_at, id', [action])).rows.map((r) => r.id)

  it('never has two in flight across batches approved at once, and every run succeeds', async () => {
    // Slower than a hand-off waits, so each run is in flight behind whatever handed it on.
    expect((await capped('one_at_a_time', 2_200, 1)).status).toBe(200)
    const batches: string[] = []
    for (const keys of [KEYS.slice(0, 2), KEYS.slice(2, 4), KEYS.slice(4)]) {
      const asked = await session('/v1/actions/one_at_a_time/batch', { method: 'POST', ...body({ entities: keys.map((key) => ({ blueprint: 'k8s_workload', key })), inputs: {} }) })
      expect(asked.status).toBe(201)
      batches.push((await json<{ id: string }>(asked)).id)
    }
    const approved = await Promise.all(batches.map(async (b) => json<{ approved: number }>(await machine(`/v1/action-batches/${b}/approve`, { method: 'POST', ...body({}) }, approver))))
    expect(approved.map((a) => a.approved)).toEqual([2, 2, 2])
    const ids = await runsOf('one_at_a_time')
    expect(ids).toHaveLength(6)
    const waiting = await Promise.all(ids.map(read))
    expect(waiting.filter((r) => r.state === 'running')).toHaveLength(1)
    expect(waiting.filter((r) => r.state === 'queued').every((r) => r.log.some((l) => l.message.startsWith('waits its turn: ')))).toBe(true)
    const runs = await Promise.all(ids.map((id) => ended(id, 40_000)))
    expect(runs.map((r) => r.state)).toEqual(Array(6).fill('succeeded'))
    expect(peak.get('/wait/2200/200')).toBe(1)
    // Each started only once the one before it had ended.
    const spans = runs.map((r) => [Date.parse(r.startedAt!), Date.parse(r.finishedAt!)] as const).sort((a, b) => a[0] - b[0])
    for (let i = 1; i < spans.length; i++) expect(spans[i]![0]).toBeGreaterThanOrEqual(spans[i - 1]![1])
  }, 60_000)

  it('holds a single run behind a batch, and runs as many at once as it allows', async () => {
    // Each call is held until the test lets it answer, so how many run at once is never a matter of how fast the machine is.
    expect((await capped('two_at_a_time', 'held', 2)).status).toBe(200)
    const asked = await session('/v1/actions/two_at_a_time/batch', { method: 'POST', ...body({ entities: KEYS.slice(0, 4).map((key) => ({ blueprint: 'k8s_workload', key })), inputs: {} }) })
    const batch = (await json<{ id: string }>(asked)).id
    expect((await json<{ approved: number }>(await machine(`/v1/action-batches/${batch}/approve`, { method: 'POST', ...body({}) }, approver))).approved).toBe(4)
    const alone = await runOn('two_at_a_time', 'w/five')
    expect((await machine(`/v1/action-runs/${alone.id}/approve`, { method: 'POST', ...body({}) }, approver)).status).toBe(200)
    // Two are in flight, and while both are held no third starts.
    await vi.waitFor(() => expect(flying.get('/held/200')).toBe(2), { timeout: 30_000, interval: 50 })
    const letGo = setInterval(() => held.splice(0).forEach((answer) => answer()), 50)
    const ids = await runsOf('two_at_a_time')
    const runs = await Promise.all(ids.map((id) => ended(id, 30_000)))
    clearInterval(letGo)
    expect(runs.map((r) => r.state)).toEqual(Array(5).fill('succeeded'))
    expect(peak.get('/held/200')).toBe(2)
  }, 45_000)

  it('is refused where a run could never wait its turn', async () => {
    const refused = async (backend: Record<string, unknown>) => {
      const r = await session('/v1/actions/no_turns', { method: 'PUT', ...body({ title: 'x', blueprint: 'k8s_workload', inputs: {}, concurrency: 1, backend }) })
      expect(r.status).toBe(400)
      return JSON.stringify(await r.json())
    }
    expect(await refused({ type: 'webhook', url: `${hookUrl}/wait/0/200`, finish: 'reveal' })).toMatch(/concurrency: a revealed answer/)
    expect(await refused({ type: 'decide', verdict: 'approve' })).toMatch(/concurrency: a decide run is the hub's own/)
    const zero = await session('/v1/actions/no_turns', { method: 'PUT', ...body({ title: 'x', blueprint: 'k8s_workload', inputs: {}, concurrency: 0, backend: { type: 'caller' } }) })
    expect(zero.status).toBe(400)
  })
})

describe('a webhook the hub stops waiting for', () => {
  it('ends with its outcome unknown, never as failed or unreachable, and is not tried again', async () => {
    expect((await define('past_time', 3_000, 200, { timeout: '1s' })).status).toBe(200)
    await session('/v1/actions/past_time', { method: 'PUT', ...body({ title: 'past_time', blueprint: 'k8s_workload', inputs: {}, retry: { tries: 3, backoff: '1s' }, backend: { type: 'webhook', url: `${hookUrl}/wait/3000/200`, finish: 'answer', timeout: '1s' } }) })
    const run = await runOn('past_time')
    expect(run.state).toBe('unknown')
    expect(run.attempt).toBe(1)
    const said = run.log.at(-1)!.message
    expect(said).toMatch(/^webhook did not answer within 1 second\. It was handed on, so it may have done its work/)
    expect(said).not.toMatch(/could not be reached/)
    // It is no failure the action is counted by.
    const shown = await json<ActionView>(await session('/v1/actions/past_time'))
    expect(shown.stats?.failedInARow).toBe(0)
    // Its backend may still say how it ended.
    const settled = await machine(`/v1/action-runs/${run.id}/report`, { method: 'POST', ...body({ state: 'succeeded', summary: 'it landed' }) }, reporter)
    expect(settled.status).toBe(200)
    expect((await read(run.id)).state).toBe('succeeded')
  }, 15_000)

  it('ends with its outcome unknown when something in front of the webhook gives up on it', async () => {
    expect((await define('gateway', 0, 504)).status).toBe(200)
    const run = await runOn('gateway')
    expect(run.state).toBe('unknown')
    expect(run.log.at(-1)!.message).toMatch(/^webhook answered 504: gave up: something in front of it stopped waiting\./)
    // Whoever asked hears it may not have worked: never that it worked, and never that it failed.
    const sent: NoticeEvent[] = []
    const dispatch: typeof fetch = async (url, init) => {
      if (String(url).endsWith('/v1/events')) sent.push(JSON.parse(String(init?.body)) as NoticeEvent)
      return new Response(JSON.stringify({ queued: 1, kinds: 1 }), { status: 202 })
    }
    await new NoticeForwarder({ db: hub.db, actions: hub.actions, batches: hub.batches, sets: hub.changeSets, schedules: hub.schedules, people: () => hub.people(), reader: hub.reader, blueprints: hub.blueprints, log: createLogger('notices-test') }, { url: 'http://dispatch.test/', token: 'tok', publicUrl: 'https://orrery.example.org/', remindHours: 0 }, dispatch).pass()
    const ends = sent.filter((e) => e.labels.action === 'gateway' && e.kind !== 'action.requested')
    expect(ends).toHaveLength(1)
    expect(ends[0]).toMatchObject({ kind: 'action.unknown', title: 'gateway on w/one may not have worked', weight: 'notify', severity: 'warning' })
  })

  it('still fails a run whose webhook could not be reached at all', async () => {
    const closed = createServer()
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r))
    const port = (closed.address() as { port: number }).port
    await new Promise<void>((r) => closed.close(() => r()))
    await session('/v1/actions/nowhere', { method: 'PUT', ...body({ title: 'nowhere', blueprint: 'k8s_workload', inputs: {}, backend: { type: 'webhook', url: `http://127.0.0.1:${port}/x`, finish: 'answer' } }) })
    const run = await runOn('nowhere')
    expect(run.state).toBe('failed')
    expect(run.log.at(-1)!.message).toMatch(/^webhook could not be reached: fetch failed \(connect ECONNREFUSED/)
  })
})
