import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ActionInsights, ActionRunsResponse, ActionSchedule, MyApprovals, QueryResult, ChangesResponse, RunnerJob, SavedQuery, ScheduleHistory, SchedulesResponse } from '../shared/api.ts'
import type { ActionRun } from '../shared/model.ts'
import { loadConfig } from './config.ts'
import { loadFixtureCatalog } from './fixtures/load.ts'
import { createHub, type Hub } from './hub.ts'
import { ensureHubBlueprints } from './builtin.ts'
import { Approvals } from './approvals.ts'
import { record } from './activity.ts'
import { createLogger } from './log.ts'
import { NoticeForwarder, type NoticeEvent } from './notices.ts'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://orrery:orrery@localhost:5433/orrery'

let hub: Hub
let pusher = ''
let runner = ''

const as = (email: string, groups: string) => (path: string, init?: RequestInit) => Promise.resolve(hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', 'x-forwarded-email': email, 'x-forwarded-groups': groups, ...init?.headers } }, { surface: 'session' }))
const ops = as('ops@example.org', 'Admin')
const dev = as('dev@example.org', 'User')
const machine = (bearer: string) => (path: string, init?: RequestInit) => Promise.resolve(hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}`, ...init?.headers } }, { surface: 'machine' }))
const body = (v: unknown) => ({ body: JSON.stringify(v) })
const json = async <T>(r: Response): Promise<T> => (await r.json()) as T
const daily = { every: 'day', at: '06:00', tz: 'America/Chicago' }

beforeAll(async () => {
  hub = await createHub(loadConfig({ DATABASE_URL, DATA_DIR: mkdtempSync(join(tmpdir(), 'orrery-')), AUTH_MODE: 'proxy' }), 'test', { reset: true })
  expect((await loadFixtureCatalog(hub)).errors).toEqual([])
  await hub.sources.save('k8s@home', { title: 'k8s home', class: 'pusher', blueprints: ['*'], deleteGrant: [], cadence: '3m' })
  await hub.sources.save('lan-runner', { title: 'LAN runner', class: 'runner', blueprints: [], deleteGrant: [], cadence: '5m' })
  pusher = (await hub.sources.issueToken('source', 'home pusher', { source: 'k8s@home' })).token
  runner = (await hub.sources.issueToken('source', 'runner', { source: 'lan-runner' })).token
  await machine(pusher)('/v1/ingest/entities/k8s_cluster/home', { method: 'PUT', ...body({ title: 'home' }) })
  for (const n of ['n1', 'n2', 'n3']) await machine(pusher)(`/v1/ingest/entities/k8s_node/home%2F${n}`, { method: 'PUT', ...body({ title: n, fields: { cpu: 8, health: 'green' }, relations: { cluster: 'home' } }) })
  await hub.deriver.backfill()
  // Everyone may run it; it may be scheduled at most daily.
  const ping = { title: 'Ping', blueprint: 'k8s_node', batch: { max: 50 }, schedule: { min: '1d' }, access: { everyone: true }, inputs: { command: { type: 'enum', values: ['ping'], required: true } }, backend: { type: 'runner', runner: 'lan-runner', command: ['ping', '{{ entity.key }}'] } }
  expect((await ops('/v1/actions/ping_nodes', { method: 'PUT', ...body(ping) })).status).toBe(200)
  // Both people are enrolled before anyone decides anything.
  await dev('/v1/whoami')
})

afterAll(async () => {
  await hub.close()
})

describe('a schedule', () => {
  let query: SavedQuery
  let schedule: ActionSchedule

  it('is refused for an action that allows none, or tighter than the action allows', async () => {
    expect((await ops('/v1/actions/once', { method: 'PUT', ...body({ title: 'Once', inputs: {}, access: { everyone: true }, backend: { type: 'runner', runner: 'lan-runner', command: ['x'] } }) })).status).toBe(200)
    const none = await dev('/v1/schedules', { method: 'POST', ...body({ action: 'once', title: 'x', cadence: daily }) })
    expect(none.status).toBe(403)
    const hourly = await dev('/v1/schedules', { method: 'POST', ...body({ action: 'ping_nodes', title: 'x', inputs: { command: 'ping' }, target: { entity: { blueprint: 'k8s_node', key: 'home/n1' } }, cadence: { every: 'hour', minute: 0, tz: 'UTC' } }) })
    expect((await json<{ error: string }>(hourly)).error).toContain('at most once every 1d')
    const twiceADay = await dev('/v1/schedules', { method: 'POST', ...body({ action: 'ping_nodes', title: 'x', inputs: { command: 'ping' }, target: { entity: { blueprint: 'k8s_node', key: 'home/n1' } }, cadence: { every: 'hours', hours: 12, at: '06:00', tz: 'UTC' } }) })
    expect((await json<{ error: string }>(twiceADay)).error).toContain('at most once every 1d')
  })

  it('tells every page when one is asked for, so what waits is counted again', async () => {
    const heard: string[] = []
    const stop = hub.events.subscribe((event) => void heard.push(event.type))
    const s = await json<ActionSchedule>(await dev('/v1/schedules', { method: 'POST', ...body({ action: 'ping_nodes', title: 'Told', inputs: { command: 'ping' }, target: { entity: { blueprint: 'k8s_node', key: 'home/n1' } }, cadence: daily }) }))
    expect(heard).toContain('schedules')
    heard.length = 0
    expect((await dev(`/v1/schedules/${s.id}`, { method: 'DELETE' })).status).toBeLessThan(300)
    expect(heard).toContain('schedules')
    stop()
  })

  it('runs on the rows a saved query’s view keeps, when it narrows the answer by its columns', async () => {
    const narrowed = await json<SavedQuery>(await dev('/v1/queries', { method: 'POST', ...body({ title: 'Not n2', spec: { sources: [{ blueprint: 'k8s_node', clauses: [] }], columns: ['title'], view: { where: [{ field: 'title', op: 'neq', value: 'n2' }] } } }) }))
    const res = await dev('/v1/schedules', { method: 'POST', ...body({ action: 'ping_nodes', title: 'Narrowed', inputs: { command: 'ping' }, target: { query: narrowed.id }, cadence: daily }) })
    expect(res.status).toBe(201)
    const s = await json<ActionSchedule>(res)
    expect(s.load).toMatchObject({ runs: 2 })
    expect((await dev(`/v1/schedules/${s.id}`, { method: 'DELETE' })).status).toBeLessThan(300)
    expect((await dev(`/v1/queries/${narrowed.id}`, { method: 'DELETE' })).status).toBe(204)
  })

  it('waits for approval, and says the load it adds before anyone approves it', async () => {
    query = await json<SavedQuery>(await dev('/v1/queries', { method: 'POST', ...body({ title: 'All nodes', spec: { sources: [{ blueprint: 'k8s_node', clauses: [] }], columns: ['title'] } }) }))
    const res = await dev('/v1/schedules', { method: 'POST', ...body({ action: 'ping_nodes', title: 'Morning ping', inputs: { command: 'ping' }, target: { query: query.id }, cadence: daily, deliver: ['lead@example.org'] }) })
    expect(res.status).toBe(201)
    schedule = await json<ActionSchedule>(res)
    expect(schedule).toMatchObject({ state: 'awaiting', owner: 'dev@example.org', when: 'every day at 6:00 AM (America/Chicago)', targetTitle: 'All nodes', nextAt: null, canDecide: false, mine: true })
    expect(schedule.load).toMatchObject({ runs: 3, perDay: 1, runner: 'lan-runner' })
    // Someone who decides sees it waiting; its owner may not decide it.
    expect((await json<SchedulesResponse>(await ops('/v1/schedules/awaiting'))).schedules.map((s) => s.id)).toEqual([schedule.id])
    expect((await dev(`/v1/schedules/${schedule.id}/approve`, { method: 'POST' })).status).toBe(403)
    expect((await dev(`/v1/schedules/${schedule.id}/run`, { method: 'POST' })).status).toBe(409)
    expect(await hub.schedules.due()).toBe(0)
  })

  it('fires once approved, as its owner, as one batch on every row its saved query matches', async () => {
    const approved = await json<ActionSchedule>(await ops(`/v1/schedules/${schedule.id}/approve`, { method: 'POST' }))
    expect(approved).toMatchObject({ state: 'active', decidedBy: 'ops@example.org' })
    expect(Date.parse(approved.nextAt!)).toBeGreaterThan(Date.now())
    // Its time comes.
    await hub.db.query(`UPDATE action_schedules SET next_at = now() - interval '1 minute' WHERE id = $1`, [schedule.id])
    expect(await hub.schedules.due()).toBe(1)
    const fired = await json<ActionSchedule>(await dev(`/v1/schedules/${schedule.id}`))
    expect(fired.lastBatch).not.toBeNull()
    expect(Date.parse(fired.nextAt!)).toBeGreaterThan(Date.now())
    const runs = await hub.db.query<{ actor: string; schedule: string; batch: string }>(`SELECT actor, schedule, batch FROM action_runs WHERE action = 'ping_nodes'`)
    expect(runs.rows).toHaveLength(3)
    expect(runs.rows.every((r) => r.actor === 'dev@example.org' && r.schedule === schedule.id && r.batch === fired.lastBatch)).toBe(true)
    const told = (await json<ChangesResponse>(await ops('/v1/changes?kind=schedule.fired'))).changes
    expect(told[0]).toMatchObject({ actor: 'dev@example.org', detail: { schedule: schedule.id, runs: 3, batch: fired.lastBatch } })
    // It is not due again until its next time.
    expect(await hub.schedules.due()).toBe(0)
  })

  it('asks for approval again when it is changed, and fires now when asked', async () => {
    const changed = await json<ActionSchedule>(await dev(`/v1/schedules/${schedule.id}`, { method: 'PUT', ...body({ action: 'ping_nodes', title: 'Morning ping', inputs: { command: 'ping' }, target: { query: query.id }, cadence: { every: 'week', days: ['mon'], at: '07:00', tz: 'UTC' } }) }))
    expect(changed).toMatchObject({ state: 'awaiting', decidedBy: null, nextAt: null })
    await ops(`/v1/schedules/${schedule.id}/approve`, { method: 'POST' })
    await json(await dev(`/v1/schedules/${schedule.id}/run`, { method: 'POST' }))
    expect((await hub.db.query(`SELECT 1 FROM action_runs WHERE action = 'ping_nodes'`)).rowCount).toBe(6)
  })

  it('pauses itself when its owner may no longer run the action, and says why', async () => {
    expect((await ops('/v1/actions/ping_nodes', { method: 'PUT', ...body({ title: 'Ping', blueprint: 'k8s_node', batch: { max: 50 }, schedule: { min: '1d' }, inputs: { command: { type: 'enum', values: ['ping'], required: true } }, backend: { type: 'runner', runner: 'lan-runner', command: ['ping', '{{ entity.key }}'] } }) })).status).toBe(200)
    await hub.db.query(`UPDATE action_schedules SET next_at = now() - interval '1 minute' WHERE id = $1`, [schedule.id])
    await hub.schedules.due()
    expect(await json<ActionSchedule>(await dev(`/v1/schedules/${schedule.id}`))).toMatchObject({ state: 'paused', note: 'dev@example.org may no longer run the action' })
  })

  it('is left out of the runs its owner asked by hand', async () => {
    const asked = await json<ActionRun>(await dev('/v1/actions/once/run', { method: 'POST', ...body({ inputs: {} }) }))
    const mine = await json<{ runs: ActionRun[] }>(await dev('/v1/action-runs?by=dev@example.org&limit=500'))
    expect(mine.runs.some((r) => r.schedule === schedule.id)).toBe(true)
    const byHand = await json<{ runs: ActionRun[] }>(await dev('/v1/action-runs?by=dev@example.org&limit=500&scheduled=false'))
    expect(byHand.runs.map((r) => r.id)).toContain(asked.id)
    expect(byHand.runs.some((r) => r.schedule)).toBe(false)
    // The insights below count every run; this one was only asked to be listed.
    await hub.db.query('DELETE FROM action_runs WHERE id = $1', [asked.id])
  })

  it('reads its history: each batch as one firing, and a firing that asked nothing, to its owner alone', async () => {
    await record(hub.db, 'schedule.fired', null, null, 'dev@example.org', { schedule: schedule.id, action: 'ping_nodes', runs: 0, reason: 'the runner was gone' }, new Date(), 'failed')
    const seen = await json<ScheduleHistory>(await dev('/v1/schedules/history?days=7'))
    const mine = seen.firings.filter((f) => f.schedule === schedule.id)
    expect(mine).toHaveLength(3)
    expect(mine.filter((f) => f.batch)).toEqual([expect.objectContaining({ runs: 3, open: 3, succeeded: 0, failed: 0, run: null }), expect.objectContaining({ runs: 3, open: 3 })])
    expect(mine.at(-1)).toMatchObject({ runs: 0, run: null, batch: null, error: 'the runner was gone' })
    expect(mine.map((f) => f.at)).toEqual(mine.map((f) => f.at).sort())
    // One schedule alone reads the same; someone who neither owns nor decides it sees none of it.
    expect((await json<ScheduleHistory>(await dev(`/v1/schedules/history?schedule=${schedule.id}`))).firings).toHaveLength(3)
    const other = as('other@example.org', 'User')
    expect((await json<ScheduleHistory>(await other('/v1/schedules/history'))).firings).toEqual([])
    expect((await other(`/v1/schedules/history?schedule=${schedule.id}`)).status).toBe(404)
  })
})

describe('the runs list, grouped by where each run came from', () => {
  let s: ActionSchedule
  beforeAll(async () => {
    s = (await json<SchedulesResponse>(await dev('/v1/schedules'))).schedules.find((x) => x.title === 'Morning ping')!
  })

  it('folds what a schedule fired into one line a day, apart from what a person asked by hand', async () => {
    const tz = 'America/Chicago'
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
    const listed = await json<ActionRunsResponse>(await dev(`/v1/action-runs?by=dev%40example.org&group=origin&tz=${encodeURIComponent(tz)}`))
    expect(listed.runs.filter((r) => r.action === 'ping_nodes')).toEqual([])
    expect(listed.batches!.filter((b) => b.action === 'ping_nodes')).toEqual([])
    const line = listed.schedules!.find((l) => l.schedule === s.id)!
    expect(line).toMatchObject({ title: 'Morning ping', owner: 'dev@example.org', action: 'ping_nodes', day, firings: 3, missed: 1, counts: { queued: 6 }, error: 'the runner was gone', targetTitle: 'All nodes', when: 'Monday at 7:00 AM (UTC)' })
    // Grouped by batch alone, as a page one release back asks, the schedule's batches are lines of their own.
    expect((await json<ActionRunsResponse>(await dev('/v1/action-runs?by=dev%40example.org&group=batch'))).batches!.filter((b) => b.action === 'ping_nodes')).toHaveLength(2)
    // A state no run of it is in leaves its line out; failed keeps it for the firing that asked nothing.
    expect((await json<ActionRunsResponse>(await dev(`/v1/action-runs?group=origin&state=succeeded`))).schedules).toEqual([])
    expect((await json<ActionRunsResponse>(await dev(`/v1/action-runs?group=origin&state=failed`))).schedules!.map((l) => l.schedule)).toEqual([s.id])
  })

  it('opens a day to its firings, each batch one line', async () => {
    const from = new Date(Date.now() - 3_600_000).toISOString()
    const to = new Date(Date.now() + 60_000).toISOString()
    const opened = await json<ActionRunsResponse>(await dev(`/v1/action-runs?group=origin&schedule=${s.id}&from=${from}&to=${to}`))
    expect(opened.runs).toEqual([])
    expect(opened.batches!.map((b) => b.counts)).toEqual([{ queued: 3 }, { queued: 3 }])
    expect(opened.schedules).toBeUndefined()
    // A span that holds none of it lists nothing.
    expect((await json<ActionRunsResponse>(await dev(`/v1/action-runs?group=origin&schedule=${s.id}&to=${from}`))).batches).toEqual([])
  })

  it('shows a schedule to someone who may neither see it nor run its action not at all', async () => {
    const other = as('other@example.org', 'User')
    expect((await json<ActionRunsResponse>(await other('/v1/action-runs?group=origin'))).schedules).toEqual([])
    // Someone who sees everything sees it, and what it runs on.
    expect((await json<ActionRunsResponse>(await ops('/v1/action-runs?group=origin'))).schedules!.find((l) => l.schedule === s.id)).toMatchObject({ targetTitle: 'All nodes', firings: 3 })
  })
})

describe('what self-service is used for', () => {
  it('counts each action, who ran it, its batches, and each runner by hour of the day', async () => {
    const jobs = (await json<{ jobs: RunnerJob[] }>(await machine(runner)('/v1/ingest/runner/jobs?max=50&width=4'))).jobs
    for (const j of jobs) await machine(runner)(`/v1/ingest/runner/jobs/${j.run}/report`, { method: 'POST', ...body({ state: 'succeeded' }) })
    expect((await dev('/v1/action-insights')).status).toBe(403)
    const seen = await json<ActionInsights>(await ops('/v1/action-insights?days=7'))
    const ping = seen.actions.find((a) => a.action === 'ping_nodes')!
    expect(ping).toMatchObject({ runs: 6, people: 1, batched: 6, scheduled: 6 })
    // Every time is a number, never the text Postgres keeps an exact decimal as.
    expect(typeof ping.meanSeconds).toBe('number')
    expect(typeof ping.p95Seconds).toBe('number')
    expect(typeof seen.batches[0]!.meanSeconds).toBe('number')
    expect(seen.runners.find((r) => r.runner === 'lan-runner')!.waitSeconds.some((w) => typeof w === 'number')).toBe(true)
    expect(seen.actions.find((a) => a.action === 'once')).toMatchObject({ runs: 0, lastRunAt: null })
    expect(seen.people).toEqual([{ person: 'dev@example.org', runs: 6, actions: 1, batches: 2 }])
    expect(seen.batches).toEqual([expect.objectContaining({ action: 'ping_nodes', batches: 2, meanSize: 3, largest: 3, scheduled: 2 })])
    const lan = seen.runners.find((r) => r.runner === 'lan-runner')!
    expect(lan.width).toBe(4)
    expect(lan.busySeconds).toHaveLength(24)
    expect(lan.runs.reduce((a, b) => a + b, 0)).toBeGreaterThan(0)
  })

  it('reads each runner now: waiting, running, and its width', async () => {
    expect(await hub.actions.runnerReadings()).toEqual([{ runner: 'lan-runner', queued: 0, running: 0, width: 4 }])
  })
})

describe('the hub’s approvals as records', () => {
  const record = async (key: string) => (await hub.reader.get({ blueprint: 'approval', key }))!
  const runOn = async (who: typeof ops, action: string, key: string) => json<ActionRun>(await who(`/v1/actions/${action}/run`, { method: 'POST', ...body({ entity: { blueprint: 'approval', key }, inputs: {} }) }))
  let waiting: ActionRun

  beforeAll(async () => {
    expect((await ops('/v1/blueprints/person', { method: 'PUT', ...body({ title: 'Person', fields: { email: { type: 'email' } } }) })).status).toBeLessThan(300)
    expect((await ops('/v1/access/person', { method: 'PUT', ...body({ blueprint: 'person', field: 'email' }) })).status).toBe(200)
    for (const who of ['dev', 'ops']) await machine(pusher)(`/v1/ingest/entities/person/${who}`, { method: 'PUT', ...body({ title: who, fields: { email: `${who}@example.org` } }) })
    const approval = { title: 'Approval', fields: { decision: { type: 'enum', values: ['pending', 'approved', 'declined', 'expired'] }, source: { type: 'string' }, kind: { type: 'string' }, requested_by: { type: 'string' }, decided_by: { type: 'string' }, url: { type: 'url' } }, relations: { requester: { target: 'person' }, approvers: { target: 'person', many: true } } }
    expect((await ops('/v1/blueprints/approval', { method: 'PUT', ...body(approval) })).status).toBeLessThan(300)
    expect((await dev('/v1/access/approvals', { method: 'PUT', ...body({ blueprint: 'approval' }) })).status).toBe(403)
    expect((await ops('/v1/access/approvals', { method: 'PUT', ...body({ blueprint: 'approval' }) })).status).toBe(200)
    expect((await ops('/v1/actions/needs_ok', { method: 'PUT', ...body({ title: 'Needs OK', inputs: {}, approval: true, access: { everyone: true }, backend: { type: 'runner', runner: 'lan-runner', command: ['x'] } }) })).status).toBe(200)
    for (const [id, verdict] of [['approve_it', 'approve'], ['decline_it', 'decline']] as const) expect((await ops(`/v1/actions/${id}`, { method: 'PUT', ...body({ title: id, blueprint: 'approval', inputs: {}, access: { everyone: true }, backend: { type: 'decide', verdict } }) })).status).toBe(200)
    waiting = await json<ActionRun>(await dev('/v1/actions/needs_ok/run', { method: 'POST', ...body({ inputs: {} }) }))
    expect(waiting.state).toBe('awaiting')
  })

  it('writes a run that waits as a pending record, linked to who asked, from a hub that did not take the setting', async () => {
    // The hub that leads the background work never saw the setting saved: it reads it, and who may write, again.
    const leader = new Approvals({ db: hub.db, blueprints: hub.blueprints, entities: hub.entities, reader: hub.reader, sources: hub.sources, actions: hub.actions, schedules: hub.schedules, sets: hub.changeSets, people: () => hub.people(), viewOf: (identity) => hub.visibility.view(identity), person: () => hub.visibility.personSetting(), publicUrl: 'https://hub.example.org', log: createLogger('approvals-test') })
    expect(await leader.pass()).toBeGreaterThanOrEqual(1)
    const rec = await record(`orrery/run/${waiting.id}`)
    expect(rec.owner).toBe('hub')
    expect(rec.fields).toMatchObject({ decision: 'pending', source: 'orrery', kind: 'action run', requested_by: 'dev@example.org' })
    expect(rec.relations.requester?.map((r) => r.key)).toEqual(['dev'])
  })

  it('counts for each person the records that wait for them to decide', async () => {
    const rec = await record(`orrery/run/${waiting.id}`)
    expect(rec.relations.approvers?.map((r) => r.key)).toContain('ops')
    expect(await json<MyApprovals>(await ops('/v1/mine/approvals'))).toEqual({ blueprint: 'approval', waiting: 1 })
    expect(await json<MyApprovals>(await dev('/v1/mine/approvals'))).toEqual({ blueprint: 'approval', waiting: 0 })
  })

  it('refuses a decision its maker may not make, and saying why', async () => {
    const mine = await runOn(dev, 'approve_it', `orrery/run/${waiting.id}`)
    const ended = await json<ActionRun>(await ops(`/v1/action-runs/${mine.id}`))
    expect(ended.state).toBe('failed')
    expect((await json<ActionRun>(await ops(`/v1/action-runs/${waiting.id}`))).state).toBe('awaiting')
  })

  it('approves the run from its record, and the record says so', async () => {
    const decided = await runOn(ops, 'approve_it', `orrery/run/${waiting.id}`)
    expect((await json<ActionRun>(await ops(`/v1/action-runs/${decided.id}`))).state).toBe('succeeded')
    expect((await json<ActionRun>(await ops(`/v1/action-runs/${waiting.id}`))).decidedBy).toBe('ops@example.org')
    await hub.approvals.pass()
    expect((await record(`orrery/run/${waiting.id}`)).fields).toMatchObject({ decision: 'approved', decided_by: 'ops@example.org' })
  })

  it('names only its asker as the approver of a run held for their own approval, and lets nobody else decide it from its record', async () => {
    expect((await ops('/v1/actions/own_ok', { method: 'PUT', ...body({ title: 'Own OK', blueprint: 'k8s_node', inputs: {}, access: { rules: [{ where: { field: 'health', op: 'eq', value: 'green' }, approval: 'self' }] }, backend: { type: 'runner', runner: 'lan-runner', command: ['x'] } }) })).status).toBe(200)
    const own = await json<ActionRun>(await dev('/v1/actions/own_ok/run', { method: 'POST', ...body({ entity: { blueprint: 'k8s_node', key: 'home/n2' }, inputs: {} }) }))
    expect(own).toMatchObject({ state: 'awaiting', heldFor: 'self' })
    await hub.approvals.pass()
    expect((await record(`orrery/run/${own.id}`)).relations.approvers?.map((r) => r.key)).toEqual(['dev'])
    // The admin sees the record and may not decide it: the decide action fails, and the run still waits.
    const refused = await runOn(ops, 'approve_it', `orrery/run/${own.id}`)
    expect((await json<ActionRun>(await ops(`/v1/action-runs/${refused.id}`))).state).toBe('failed')
    expect((await json<ActionRun>(await ops(`/v1/action-runs/${own.id}`))).state).toBe('awaiting')
    await runOn(dev, 'approve_it', `orrery/run/${own.id}`)
    expect((await json<ActionRun>(await ops(`/v1/action-runs/${own.id}`))).decidedBy).toBe('dev@example.org')
    await hub.approvals.pass()
    expect((await record(`orrery/run/${own.id}`)).fields).toMatchObject({ decision: 'approved', decided_by: 'dev@example.org' })
  })

  it('links the entity a run acts on through the relation that reaches its blueprint', async () => {
    expect((await ops('/v1/blueprints/approval', { method: 'PUT', ...body({ title: 'Approval', fields: { decision: { type: 'enum', values: ['pending', 'approved', 'declined', 'expired'] }, source: { type: 'string' }, kind: { type: 'string' }, requested_by: { type: 'string' }, decided_by: { type: 'string' }, url: { type: 'url' } }, relations: { requester: { target: 'person' }, approvers: { target: 'person', many: true }, node: { target: 'k8s_node' } } }) })).status).toBeLessThan(300)
    expect((await ops('/v1/actions/node_ok', { method: 'PUT', ...body({ title: 'Node OK', blueprint: 'k8s_node', inputs: {}, approval: true, access: { everyone: true }, backend: { type: 'runner', runner: 'lan-runner', command: ['x'] } }) })).status).toBe(200)
    const run = await json<ActionRun>(await dev('/v1/actions/node_ok/run', { method: 'POST', ...body({ entity: { blueprint: 'k8s_node', key: 'home/n1' }, inputs: {} }) }))
    expect(run.state).toBe('awaiting')
    await hub.approvals.pass()
    expect((await record(`orrery/run/${run.id}`)).relations.node?.map((r) => r.key)).toEqual(['home/n1'])
  })

  it('links no one for a requester who has no record', async () => {
    // People keyed by their address: the run's maker is linked only when a record holds that address as its key.
    expect((await ops('/v1/access/person', { method: 'PUT', ...body({ blueprint: 'person' }) })).status).toBe(200)
    try {
      await machine(pusher)('/v1/ingest/entities/person/ops@example.org', { method: 'PUT', ...body({ title: 'ops' }) })
      const run = await json<ActionRun>(await dev('/v1/actions/needs_ok/run', { method: 'POST', ...body({ inputs: {} }) }))
      await hub.approvals.pass()
      const rec = await record(`orrery/run/${run.id}`)
      expect(rec.relations.requester ?? []).toEqual([])
      expect(rec.relations.approvers?.map((r) => r.key)).toContain('ops@example.org')
    } finally {
      expect((await ops('/v1/access/person', { method: 'PUT', ...body({ blueprint: 'person', field: 'email' }) })).status).toBe(200)
    }
  })

  it('keeps every round of one ask as one record, showing its newest round, and decides that round from it', async () => {
    const first = await json<ActionRun>(await dev('/v1/actions/needs_ok/run', { method: 'POST', ...body({ inputs: {} }) }))
    await hub.approvals.pass()
    expect((await record(`orrery/run/${first.id}`)).title).toBe('Needs OK')
    // Sent back, then asked again as its next round; that round is revised while it waits.
    await ops(`/v1/action-runs/${first.id}/return`, { method: 'POST', ...body({ note: 'Say which node.' }) })
    const second = await json<ActionRun>(await dev('/v1/actions/needs_ok/run', { method: 'POST', ...body({ inputs: {}, revises: first.id }) }))
    const third = await json<ActionRun>(await dev('/v1/actions/needs_ok/run', { method: 'POST', ...body({ inputs: {}, revises: second.id }) }))
    expect((await json<ActionRun>(await ops(`/v1/action-runs/${second.id}`))).state).toBe('cancelled')
    await hub.approvals.pass()
    const rec = await record(`orrery/run/${first.id}`)
    expect(rec.title).toBe('Needs OK (round 3)')
    expect(rec.fields.decision).toBe('pending')
    expect(String(rec.fields.url)).toMatch(new RegExp(`/actions/runs/${third.id}$`))
    expect(rec.relations.approvers?.map((r) => r.key)).toContain('ops')
    // No round after the first is a record of its own.
    for (const later of [second.id, third.id]) expect(await hub.reader.get({ blueprint: 'approval', key: `orrery/run/${later}` })).toBeNull()
    // Deciding the record decides the newest round.
    await runOn(ops, 'approve_it', `orrery/run/${first.id}`)
    expect((await json<ActionRun>(await ops(`/v1/action-runs/${third.id}`))).decidedBy).toBe('ops@example.org')
    await hub.approvals.pass()
    expect((await record(`orrery/run/${first.id}`)).fields).toMatchObject({ decision: 'approved', decided_by: 'ops@example.org' })
  })

  it('writes a schedule that waits, and declines it from its record', async () => {
    expect((await ops('/v1/actions/ping_nodes', { method: 'PUT', ...body({ title: 'Ping', blueprint: 'k8s_node', batch: { max: 50 }, schedule: { min: '1d' }, access: { everyone: true }, inputs: { command: { type: 'enum', values: ['ping'], required: true } }, backend: { type: 'runner', runner: 'lan-runner', command: ['ping', '{{ entity.key }}'] } }) })).status).toBe(200)
    const s = await json<ActionSchedule>(await dev('/v1/schedules', { method: 'POST', ...body({ action: 'ping_nodes', title: 'Nightly', inputs: { command: 'ping' }, target: { entity: { blueprint: 'k8s_node', key: 'home/n1' } }, cadence: daily }) }))
    await hub.approvals.pass()
    expect((await record(`orrery/schedule/${s.id}`)).fields).toMatchObject({ decision: 'pending', kind: 'schedule' })
    await runOn(ops, 'decline_it', `orrery/schedule/${s.id}`)
    expect((await json<ActionSchedule>(await ops(`/v1/schedules/${s.id}`))).state).toBe('declined')
    await hub.approvals.pass()
    expect((await record(`orrery/schedule/${s.id}`)).fields.decision).toBe('declined')
  })
})

describe('runs in a query', () => {
  const ask = (who: typeof ops, clauses: { field: string; op: string; value: string }[]) => who('/v1/query', { method: 'POST', ...body({ sources: [{ blueprint: '$runs', clauses }], columns: ['title', 'run:action', 'run:by', 'run:state', 'run:seconds'] }) })

  it('reads the runs that match, as one table, with the run columns asked for', async () => {
    const res = await ask(ops, [{ field: 'run:action', op: 'eq', value: 'Ping' }, { field: 'run:createdAt', op: 'within', value: '1d' }])
    expect(res.status).toBe(200)
    const out = await json<QueryResult>(res)
    expect(out.columns.map((c) => c.title)).toEqual(['Title', 'Action', 'Asked by', 'State', 'Seconds'])
    expect(out.rows.length).toBeGreaterThanOrEqual(6)
    expect(out.rows.every((r) => r.blueprint === '$runs' && r.values[1] === 'Ping' && r.values[2] === 'dev@example.org')).toBe(true)
    expect(out.counts.$runs).toBe(out.rows.length)
  })

  it('shows each person only the runs they may see', async () => {
    // An action nobody but an admin may run: its runs are not dev's to see.
    expect((await ops('/v1/actions/ops_only', { method: 'PUT', ...body({ title: 'Ops only', inputs: {}, backend: { type: 'runner', runner: 'lan-runner', command: ['x'] } }) })).status).toBe(200)
    await ops('/v1/actions/ops_only/run', { method: 'POST', ...body({ inputs: {} }) })
    expect((await json<QueryResult>(await ask(dev, [{ field: 'run:action', op: 'eq', value: 'ops_only' }]))).rows).toEqual([])
    expect((await json<QueryResult>(await ask(ops, [{ field: 'run:action', op: 'eq', value: 'ops_only' }]))).rows).toHaveLength(1)
  })

  it('refuses a test runs do not hold', async () => {
    expect((await ask(ops, [{ field: 'run:nothing', op: 'eq', value: 'x' }])).status).toBe(400)
  })
})

describe('an action on entities opened to their owners', () => {
  // A blueprint only ops sees whole; each record opens to the people it names as approvers.
  beforeAll(async () => {
    const inbox = { title: 'Inbox', fields: { note: { type: 'string' } }, relations: { approvers: { target: 'person', many: true } }, access: { grants: [{ values: ['ops@example.org'] }], owners: { roles: ['approver'], fields: 'all' } } }
    expect((await ops('/v1/blueprints/inbox', { method: 'PUT', ...body(inbox) })).status).toBeLessThan(300)
    expect((await ops('/v1/access/person', { method: 'PUT', ...body({ blueprint: 'person', field: 'email', owns: [{ as: 'approver', path: '<-inbox:approvers' }] }) })).status).toBe(200)
    await machine(pusher)('/v1/ingest/entities/inbox/theirs', { method: 'PUT', ...body({ title: 'Theirs', relations: { approvers: ['dev'] } }) })
    await machine(pusher)('/v1/ingest/entities/inbox/others', { method: 'PUT', ...body({ title: 'Others', relations: { approvers: ['ops'] } }) })
    expect((await ops('/v1/actions/inbox_ok', { method: 'PUT', ...body({ title: 'OK', blueprint: 'inbox', inputs: {}, access: { rules: [{ owns: ['approver'] }] }, backend: { type: 'runner', runner: 'lan-runner', command: ['ok', '{{ entity.key }}'] } }) })).status).toBe(200)
  })

  it('is offered to an owner who sees only their own, and runs only on theirs', async () => {
    const listed = await json<{ actions: { id: string; canRun: boolean }[] }>(await dev('/v1/actions'))
    expect(listed.actions.find((a) => a.id === 'inbox_ok')?.canRun).toBe(true)
    const page = await json<{ entity?: { actions?: string[] }; actions?: string[] }>(await dev('/v1/entities/inbox/theirs'))
    expect((page.entity ?? page).actions).toContain('inbox_ok')
    const ran = await dev('/v1/actions/inbox_ok/run', { method: 'POST', ...body({ entity: { blueprint: 'inbox', key: 'theirs' }, inputs: {} }) })
    expect(ran.status, await ran.clone().text()).toBe(201)
    expect((await dev('/v1/actions/inbox_ok/run', { method: 'POST', ...body({ entity: { blueprint: 'inbox', key: 'others' }, inputs: {} }) })).status).toBeGreaterThanOrEqual(400)
  })
})

describe('a run put off, and a schedule on the rows picked', () => {
  const soon = () => new Date(Date.now() + 2 * 3_600_000).toISOString()
  const due = (id: string) => hub.db.query(`UPDATE action_schedules SET next_at = now() - interval '1 minute' WHERE id = $1`, [id])
  beforeAll(async () => {
    // A batch action that does not repeat on a schedule: it may still be put off.
    const restart = { title: 'Restart', blueprint: 'k8s_node', batch: { max: 50 }, access: { everyone: true }, inputs: {}, backend: { type: 'runner', runner: 'lan-runner', command: ['restart', '{{ entity.key }}'] } }
    expect((await ops('/v1/actions/restart_nodes', { method: 'PUT', ...body(restart) })).status).toBe(200)
  })

  it('fires once at its moment without asking anyone, then is done', async () => {
    const res = await dev('/v1/schedules', { method: 'POST', ...body({ action: 'restart_nodes', title: 'Restart n1 later', target: { entity: { blueprint: 'k8s_node', key: 'home/n1' } }, cadence: { every: 'once', on: soon(), tz: 'America/Chicago' } }) })
    expect(res.status, await res.clone().text()).toBe(201)
    const s = await json<ActionSchedule>(res)
    expect(s).toMatchObject({ state: 'active', decidedBy: null })
    expect(s.when).toMatch(/^once, on /)
    expect(Date.parse(s.nextAt!)).toBeGreaterThan(Date.now())
    // Nobody who decides is asked.
    expect((await json<SchedulesResponse>(await ops('/v1/schedules/awaiting'))).schedules.map((x) => x.id)).not.toContain(s.id)
    expect(await hub.schedules.due()).toBe(0)
    await due(s.id)
    expect(await hub.schedules.due()).toBe(1)
    const fired = await json<ActionSchedule>(await dev(`/v1/schedules/${s.id}`))
    expect(fired).toMatchObject({ state: 'done', nextAt: null })
    expect(fired.lastRun).not.toBeNull()
    expect(await hub.schedules.due()).toBe(0)
    // Run again, now, from where it rests.
    expect((await dev(`/v1/schedules/${s.id}/run`, { method: 'POST' })).status).toBe(200)
  })

  it('may repeat only on an action that allows schedules, and is never put off into the past', async () => {
    const repeat = await dev('/v1/schedules', { method: 'POST', ...body({ action: 'restart_nodes', title: 'x', target: { entity: { blueprint: 'k8s_node', key: 'home/n1' } }, cadence: daily }) })
    expect((await json<{ error: string }>(repeat)).error).toContain('does not repeat on a schedule')
    const past = await dev('/v1/schedules', { method: 'POST', ...body({ action: 'restart_nodes', title: 'x', target: { entity: { blueprint: 'k8s_node', key: 'home/n1' } }, cadence: { every: 'once', on: new Date(Date.now() - 60_000).toISOString(), tz: 'UTC' } }) })
    expect((await json<{ error: string }>(past)).error).toContain('still to come')
  })

  it('runs on the entities picked, each time the same, as one batch', async () => {
    const picked = [{ blueprint: 'k8s_node', key: 'home/n1' }, { blueprint: 'k8s_node', key: 'home/n3' }]
    const s = await json<ActionSchedule>(await dev('/v1/schedules', { method: 'POST', ...body({ action: 'restart_nodes', title: 'Restart two', target: { entities: picked }, cadence: { every: 'once', on: soon(), tz: 'UTC' } }) }))
    expect(s).toMatchObject({ targetTitle: 'n1 and n3', load: { runs: 2 } })
    await due(s.id)
    await hub.schedules.due()
    const fired = await json<ActionSchedule>(await dev(`/v1/schedules/${s.id}`))
    const runs = await hub.db.query<{ key: string }>('SELECT key FROM action_runs WHERE batch = $1 ORDER BY key', [fired.lastBatch])
    expect(runs.rows.map((r) => r.key)).toEqual(['home/n1', 'home/n3'])
  })

  it('runs on every row a grid’s filter matches when it fires, but those left out', async () => {
    const matching = { blueprint: 'k8s_node', states: ['active'], except: [{ blueprint: 'k8s_node', key: 'home/n2' }] }
    const s = await json<ActionSchedule>(await dev('/v1/schedules', { method: 'POST', ...body({ action: 'restart_nodes', title: 'Restart all but n2', target: { matching }, cadence: { every: 'once', on: soon(), tz: 'UTC' } }) }))
    expect(s.load?.runs).toBe(2)
    expect(s.targetTitle).toContain('its filter matches')
    await due(s.id)
    await hub.schedules.due()
    const fired = await json<ActionSchedule>(await dev(`/v1/schedules/${s.id}`))
    const runs = await hub.db.query<{ key: string }>('SELECT key FROM action_runs WHERE batch = $1 ORDER BY key', [fired.lastBatch])
    expect(runs.rows.map((r) => r.key)).toEqual(['home/n1', 'home/n3'])
  })

  it('names one target at most', async () => {
    const both = await dev('/v1/schedules', { method: 'POST', ...body({ action: 'restart_nodes', title: 'x', target: { entity: { blueprint: 'k8s_node', key: 'home/n1' }, entities: [{ blueprint: 'k8s_node', key: 'home/n2' }] }, cadence: { every: 'once', on: soon(), tz: 'UTC' } }) })
    expect((await json<{ error: string }>(both)).error).toContain('one of them')
  })
})

describe('the hub’s schedules as records', () => {
  const rec = (id: string) => hub.reader.get({ blueprint: 'orrery_schedule', key: id })
  const runOn = async (who: typeof ops, action: string, id: string) => json<ActionRun>(await who(`/v1/actions/${action}/run`, { method: 'POST', ...body({ entity: { blueprint: 'orrery_schedule', key: id }, inputs: {} }) }))
  const ended = async (run: ActionRun) => json<ActionRun>(await ops(`/v1/action-runs/${run.id}`))
  let s: ActionSchedule

  beforeAll(async () => {
    expect((await ops('/v1/actions/ping_nodes', { method: 'PUT', ...body({ title: 'Ping', blueprint: 'k8s_node', batch: { max: 50 }, schedule: { min: '1d' }, access: { everyone: true }, inputs: { command: { type: 'enum', values: ['ping'], required: true } }, backend: { type: 'runner', runner: 'lan-runner', command: ['ping', '{{ entity.key }}'] } }) })).status).toBe(200)
    for (const verb of ['pause', 'resume', 'run'] as const) expect((await ops(`/v1/actions/schedule_${verb}`, { method: 'PUT', ...body({ title: verb, blueprint: 'orrery_schedule', batch: { max: 50 }, inputs: {}, access: { everyone: true }, backend: { type: 'schedule', verb } }) })).status).toBe(200)
    s = await json<ActionSchedule>(await dev('/v1/schedules', { method: 'POST', ...body({ action: 'ping_nodes', title: 'Nightly n1', inputs: { command: 'ping' }, target: { entity: { blueprint: 'k8s_node', key: 'home/n1' } }, cadence: daily }) }))
  })

  it('keeps one that waits as a grey record, written as the hub', async () => {
    await hub.scheduleRecords.pass()
    const r = (await rec(s.id))!
    expect(r.owner).toBe('hub')
    expect(r.title).toBe('Nightly n1')
    expect(r.fields).toMatchObject({ action: 'ping_nodes', owner: 'dev@example.org', state: 'awaiting', status: 'grey', repeats: true, target: 'n1', runs_count: 1, firings_per_day: 1 })
    expect(String(r.fields.url)).toMatch(new RegExp(`/actions/schedules/${s.id}$`))
  })

  it('turns green once approved, and red when every run of its last firing failed', async () => {
    await ops(`/v1/schedules/${s.id}/approve`, { method: 'POST' })
    await hub.scheduleRecords.pass()
    expect((await rec(s.id))!.fields).toMatchObject({ state: 'active', status: 'green', decided_by: 'ops@example.org' })
    await hub.db.query(`UPDATE action_schedules SET next_at = now() - interval '1 minute' WHERE id = $1`, [s.id])
    await hub.schedules.due()
    await hub.scheduleRecords.pass()
    expect((await rec(s.id))!.fields).toMatchObject({ last_result: 'running', status: 'green' })
    await hub.db.query(`UPDATE action_runs SET state = 'failed', finished_at = now() WHERE schedule = $1`, [s.id])
    await hub.scheduleRecords.pass()
    expect((await rec(s.id))!.fields).toMatchObject({ last_result: 'failed', status: 'red' })
  })

  it('pauses, resumes, and fires from its record, as whoever ran the action', async () => {
    // The hub's blueprints are an admin's until one opens them: nobody else sees a schedule's record to act on it.
    const refused = await as('other@example.org', 'User')('/v1/actions/schedule_pause/run', { method: 'POST', ...body({ entity: { blueprint: 'orrery_schedule', key: s.id }, inputs: {} }) })
    expect(refused.status).toBeGreaterThanOrEqual(400)
    expect((await json<ActionSchedule>(await ops(`/v1/schedules/${s.id}`))).state).toBe('active')
    expect((await ended(await runOn(ops, 'schedule_pause', s.id))).state).toBe('succeeded')
    expect((await json<ActionSchedule>(await ops(`/v1/schedules/${s.id}`))).state).toBe('paused')
    await hub.scheduleRecords.pass()
    expect((await rec(s.id))!.fields).toMatchObject({ state: 'paused', status: 'grey', note: 'paused by ops@example.org', next_at: null })
    expect((await ended(await runOn(ops, 'schedule_resume', s.id))).state).toBe('succeeded')
    const before = (await hub.db.query(`SELECT 1 FROM action_runs WHERE schedule = $1`, [s.id])).rowCount
    expect((await ended(await runOn(ops, 'schedule_run', s.id))).state).toBe('succeeded')
    expect((await hub.db.query(`SELECT 1 FROM action_runs WHERE schedule = $1`, [s.id])).rowCount).toBe(before! + 1)
    await hub.scheduleRecords.pass()
    expect((await rec(s.id))!.fields).toMatchObject({ state: 'active', last_result: 'running' })
  })

  it('refuses a schedule action on anything but one of the hub’s schedules', async () => {
    expect((await ops('/v1/actions/schedule_pause_node', { method: 'PUT', ...body({ title: 'x', blueprint: 'k8s_node', inputs: {}, access: { everyone: true }, backend: { type: 'schedule', verb: 'pause' } }) })).status).toBe(200)
    const run = await json<ActionRun>(await ops('/v1/actions/schedule_pause_node/run', { method: 'POST', ...body({ entity: { blueprint: 'k8s_node', key: 'home/n1' }, inputs: {} }) }))
    expect(await ended(run)).toMatchObject({ state: 'failed' })
  })

  it('drops the record of one declined or removed, and holds only the schedules still a job', async () => {
    const declined = await json<ActionSchedule>(await dev('/v1/schedules', { method: 'POST', ...body({ action: 'ping_nodes', title: 'Declined', inputs: { command: 'ping' }, target: { entity: { blueprint: 'k8s_node', key: 'home/n2' } }, cadence: daily }) }))
    await hub.scheduleRecords.pass()
    expect((await rec(declined.id))?.state).toBe('active')
    await ops(`/v1/schedules/${declined.id}/decline`, { method: 'POST' })
    expect((await dev(`/v1/schedules/${s.id}`, { method: 'DELETE' })).status).toBeLessThan(300)
    await hub.scheduleRecords.pass()
    const stateOf = async (id: string) => (await hub.db.query<{ state: string }>(`SELECT state FROM entities WHERE blueprint = 'orrery_schedule' AND key = $1`, [id])).rows[0]?.state
    expect(await stateOf(declined.id)).toBe('deleted')
    expect(await stateOf(s.id)).toBe('deleted')
    const live = new Set((await hub.schedules.live()).map((x) => x.id))
    const held = await hub.db.query<{ key: string }>(`SELECT key FROM entities WHERE blueprint = 'orrery_schedule' AND state <> 'deleted'`)
    expect(new Set(held.rows.map((r) => r.key))).toEqual(live)
  })
})

describe('a schedule shown to whoever sees what it runs on', () => {
  const viewer = as('viewer@example.org', 'User')
  const rec = (id: string) => hub.reader.get({ blueprint: 'orrery_schedule', key: id })
  const linked = async (id: string, relation: string) => ((await rec(id))?.relations[relation] ?? []).map((r) => `${r.blueprint}:${r.key}`).sort()
  const share = async (access: unknown) => ops('/v1/access/hub-blueprints/orrery_schedule', { method: 'PUT', ...body({ access }) })
  const nodes = ['n1', 'n2'].map((n) => ({ blueprint: 'k8s_node', key: `home/${n}` }))
  let picked: ActionSchedule
  let matching: ActionSchedule
  let locked: ActionSchedule

  beforeAll(async () => {
    // A kind only its keeper sees, and an action anyone may run on it.
    expect((await ops('/v1/blueprints/locker', { method: 'PUT', ...body({ id: 'locker', title: 'Locker', fields: {}, relations: {}, access: { grants: [{ values: ['ops@example.org'] }] } }) })).status).toBe(200)
    const l1 = await ops('/v1/entities', { method: 'POST', ...body({ blueprint: 'locker', key: 'l1', title: 'l1' }) })
    expect([l1.status, l1.status === 201 ? '' : await l1.text()]).toEqual([201, ''])
    const made = await ops('/v1/actions/check_locker', { method: 'PUT', ...body({ title: 'Check locker', blueprint: 'locker', schedule: { min: '1d' }, access: { everyone: true }, inputs: {}, backend: { type: 'runner', runner: 'lan-runner', command: ['check'] } }) })
    expect([made.status, made.status === 200 ? '' : await made.text()]).toEqual([200, ''])
    picked = await json<ActionSchedule>(await dev('/v1/schedules', { method: 'POST', ...body({ action: 'ping_nodes', title: 'Two nodes', inputs: { command: 'ping' }, target: { entities: nodes }, cadence: daily }) }))
    matching = await json<ActionSchedule>(await dev('/v1/schedules', { method: 'POST', ...body({ action: 'ping_nodes', title: 'Every node', inputs: { command: 'ping' }, target: { matching: { blueprint: 'k8s_node' } }, cadence: daily }) }))
    locked = await json<ActionSchedule>(await ops('/v1/schedules', { method: 'POST', ...body({ action: 'check_locker', title: 'Locker check', inputs: {}, target: { entity: { blueprint: 'locker', key: 'l1' } }, cadence: daily }) }))
    await viewer('/v1/whoami')
    await hub.scheduleRecords.pass()
  })

  afterAll(async () => {
    expect((await share(null)).status).toBe(200)
    for (const [who, s] of [[dev, picked], [dev, matching], [ops, locked]] as const) await who(`/v1/schedules/${s.id}`, { method: 'DELETE' })
  })

  it('links to every kind of thing an action runs on', () => {
    const relations = hub.blueprints.get('orrery_schedule')!.relations
    expect(relations.on_k8s_node).toMatchObject({ target: 'k8s_node', many: true, title: 'Runs on', inverseTitle: 'Schedules' })
    expect(relations.on_locker).toMatchObject({ target: 'locker' })
  })

  it('links each record to what it runs on: what it names, or what its filter matched when it was saved', async () => {
    expect(await linked(picked.id, 'on_k8s_node')).toEqual(['k8s_node:home/n1', 'k8s_node:home/n2'])
    expect(await linked(matching.id, 'on_k8s_node')).toEqual(['k8s_node:home/n1', 'k8s_node:home/n2', 'k8s_node:home/n3'])
    expect(await linked(locked.id, 'on_locker')).toEqual(['locker:l1'])
  })

  it('keeps the links a hub holds when it starts before it reads its actions', async () => {
    const before = hub.blueprints.get('orrery_schedule')!.relations
    await ensureHubBlueprints(hub.db, hub.blueprints, hub.entities)
    expect(hub.blueprints.get('orrery_schedule')!.relations).toEqual(before)
  })

  it('stays an admin’s until opened, then shows each one to whoever sees what it runs on, and nothing else', async () => {
    expect((await viewer(`/v1/entities/orrery_schedule/${picked.id}`)).status).toBe(404)
    // The hub names the relations: whatever the admin sent, every one the blueprint has.
    expect((await share({ grants: [], subjects: ['on_k8s_node'] })).status).toBe(200)
    expect(hub.blueprints.get('orrery_schedule')!.access?.subjects?.sort()).toEqual(Object.keys(hub.blueprints.get('orrery_schedule')!.relations).sort())
    expect((await viewer(`/v1/entities/orrery_schedule/${picked.id}`)).status).toBe(200)
    expect((await viewer(`/v1/entities/orrery_schedule/${matching.id}`)).status).toBe(200)
    expect((await viewer(`/v1/entities/orrery_schedule/${locked.id}`)).status).toBe(404)
    const listed = await json<{ entities: { key: string }[] }>(await viewer('/v1/entities?blueprint=orrery_schedule'))
    const keys = listed.entities.map((e) => e.key)
    expect(keys).toEqual(expect.arrayContaining([picked.id, matching.id]))
    expect(keys).not.toContain(locked.id)
    // The page of a node lists the schedules that run on it.
    const page = await json<{ incoming: { target: { blueprint: string; key: string } }[] }>(await viewer(`/v1/entities/k8s_node/${encodeURIComponent('home/n1')}`))
    expect(page.incoming.filter((i) => i.target.blueprint === 'orrery_schedule').map((i) => i.target.key)).toEqual(expect.arrayContaining([picked.id, matching.id]))
  })

  it('follows what its last firing ran on', async () => {
    await ops(`/v1/schedules/${matching.id}/approve`, { method: 'POST' })
    await hub.db.query(`UPDATE entities SET state = 'deleted' WHERE blueprint = 'k8s_node' AND key = 'home/n3'`)
    await hub.db.query(`UPDATE action_schedules SET next_at = now() - interval '1 minute' WHERE id = $1`, [matching.id])
    expect(await hub.schedules.due()).toBeGreaterThanOrEqual(1)
    await hub.db.query(`UPDATE entities SET state = 'active' WHERE blueprint = 'k8s_node' AND key = 'home/n3'`)
    await hub.scheduleRecords.pass()
    expect(await linked(matching.id, 'on_k8s_node')).toEqual(['k8s_node:home/n1', 'k8s_node:home/n2'])
  })

  it('never keeps a blueprint from being removed, and lets go of its link to it', async () => {
    expect((await ops('/v1/blueprints/locker', { method: 'DELETE' })).status).toBe(200)
    const after = hub.blueprints.get('orrery_schedule')!
    expect(after.relations.on_locker).toBeUndefined()
    expect(after.access?.subjects).not.toContain('on_locker')
    await hub.scheduleRecords.pass()
    expect(hub.blueprints.get('orrery_schedule')!.relations.on_locker).toBeUndefined()
  })
})

describe('what a schedule tells its people', () => {
  let s: ActionSchedule
  let tellRunner = ''
  const nodes = ['n1', 'n2', 'n3'].map((n) => ({ blueprint: 'k8s_node', key: `home/${n}` }))
  const request = (over: Record<string, unknown> = {}) => ({ action: 'ping_told', title: 'Night ping', inputs: { command: 'ping' }, target: { entities: nodes }, cadence: daily, deliver: ['lead@example.org'], ...over })
  /** Every event one pass of a new forwarder sends: rows have not settled, so each new forwarder tells them all again, as the schedule now says. */
  const told = async (): Promise<NoticeEvent[]> => {
    const sent: NoticeEvent[] = []
    const dispatch: typeof fetch = async (url, init) => {
      if (String(url).endsWith('/v1/events')) sent.push(JSON.parse(String(init?.body)) as NoticeEvent)
      return new Response(JSON.stringify({ queued: 1 }), { status: 202 })
    }
    await new NoticeForwarder({ db: hub.db, actions: hub.actions, batches: hub.batches, sets: hub.changeSets, schedules: hub.schedules, people: () => hub.people(), reader: hub.reader, blueprints: hub.blueprints, log: createLogger('notices-test') }, { url: 'http://dispatch.test/', token: 'tok', publicUrl: 'https://orrery.example.org/', remindHours: 0 }, dispatch).pass()
    return sent.filter((e) => e.labels.schedule === s.id)
  }

  beforeAll(async () => {
    await hub.sources.save('tell-runner', { title: 'Tell runner', class: 'runner', blueprints: [], deleteGrant: [], cadence: '5m' })
    tellRunner = (await hub.sources.issueToken('source', 'tell runner', { source: 'tell-runner' })).token
    const ping = { title: 'Ping told', blueprint: 'k8s_node', batch: { max: 50 }, schedule: { min: '1d' }, access: { everyone: true }, inputs: { command: { type: 'enum', values: ['ping'], required: true } }, backend: { type: 'runner', runner: 'tell-runner', command: ['ping', '{{ entity.key }}'] } }
    expect((await ops('/v1/actions/ping_told', { method: 'PUT', ...body(ping) })).status).toBe(200)
  })

  it('tells only failures unless its owner asks for more', async () => {
    s = await json<ActionSchedule>(await dev('/v1/schedules', { method: 'POST', ...body(request()) }))
    expect(s.tell).toBe('failed')
    await ops(`/v1/schedules/${s.id}/approve`, { method: 'POST' })
  })

  it('keeps its approval when only its name or who hears of what changes', async () => {
    const renamed = await json<ActionSchedule>(await dev(`/v1/schedules/${s.id}`, { method: 'PUT', ...body(request({ title: 'Nightly ping', tell: 'anyFailed', deliver: [] })) }))
    expect(renamed).toMatchObject({ state: 'active', decidedBy: 'ops@example.org', title: 'Nightly ping', tell: 'anyFailed', deliver: [] })
    const changes = (await json<ChangesResponse>(await ops('/v1/changes?kind=schedule.changed'))).changes.filter((c) => (c.detail as { schedule: string }).schedule === s.id)
    expect(changes).toHaveLength(1)
    expect(changes[0]!.detail).toMatchObject({ fires: 'same', tell: 'anyFailed' })
    // Saved as it was, it writes nothing.
    await dev(`/v1/schedules/${s.id}`, { method: 'PUT', ...body(request({ title: 'Nightly ping', tell: 'anyFailed', deliver: [] })) })
    expect((await json<ChangesResponse>(await ops('/v1/changes?kind=schedule.changed'))).changes.filter((c) => (c.detail as { schedule: string }).schedule === s.id)).toHaveLength(1)
    // Nobody is asked to decide a change that fires the same.
    expect((await told()).filter((e) => e.kind === 'schedule.awaiting_approval')).toEqual([])
    s = await json<ActionSchedule>(await dev(`/v1/schedules/${s.id}`, { method: 'PUT', ...body(request()) }))
    expect(s).toMatchObject({ state: 'active', tell: 'failed' })
  })

  it('tells a batch where one of many failed only to a schedule that asks for anything failing', async () => {
    await hub.db.query(`UPDATE action_schedules SET next_at = now() - interval '1 minute' WHERE id = $1`, [s.id])
    expect(await hub.schedules.due()).toBe(1)
    const jobs = (await json<{ jobs: RunnerJob[] }>(await machine(tellRunner)('/v1/ingest/runner/jobs?max=50'))).jobs
    expect(jobs).toHaveLength(3)
    for (const j of jobs) await machine(tellRunner)(`/v1/ingest/runner/jobs/${j.run}/report`, { method: 'POST', ...body({ state: j.command[1] === 'home/n2' ? 'failed' : 'succeeded' }) })
    await hub.batches.ended()
    const quiet = (await told()).find((e) => e.kind === 'action.batch_failed')!
    expect(quiet).toMatchObject({ weight: 'notify', severity: 'warning' })
    expect(quiet.to).toBeUndefined()
    await dev(`/v1/schedules/${s.id}`, { method: 'PUT', ...body(request({ tell: 'anyFailed' })) })
    expect((await told()).find((e) => e.kind === 'action.batch_failed')!.to).toEqual([{ person: 'dev@example.org' }, { person: 'lead@example.org' }])
  })

  it('tells a firing that asked nothing whatever it asks', async () => {
    await dev(`/v1/schedules/${s.id}`, { method: 'PUT', ...body(request({ tell: 'failed' })) })
    await record(hub.db, 'schedule.fired', null, null, 'dev@example.org', { schedule: s.id, action: 'ping_told', runs: 0, reason: 'the runner is gone' }, new Date(), 'failed')
    const failed = (await told()).find((e) => e.kind === 'schedule.failed')!
    expect(failed).toMatchObject({ title: 'Your schedule could not run: Night ping', text: 'the runner is gone', weight: 'notify', severity: 'warning', to: [{ person: 'dev@example.org' }, { person: 'lead@example.org' }] })
    // A firing that asked what it should is no event of its own.
    expect((await told()).filter((e) => e.kind === 'schedule.failed')).toHaveLength(1)
  })
})
