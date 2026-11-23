import { mkdtempSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ActionRunsResponse, ChangeSetApproval, ChangeSetRefusal, ChangeSetResponse, ChangeSetSummary, ChangeSetsResponse } from '../shared/api.ts'
import { isFinished, type ActionRun } from '../shared/model.ts'
import { loadConfig } from './config.ts'
import { loadFixtureCatalog } from './fixtures/load.ts'
import { createHub, type Hub } from './hub.ts'
import { createLogger } from './log.ts'
import { NoticeForwarder, type NoticeEvent } from './notices.ts'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://orrery:orrery@localhost:5433/orrery'

let hub: Hub
let hook: Server
let hookUrl = ''
let pusher = ''
let adaKey = ''
/** Every call the webhook took, in the order it took them, with what it was sent. */
const calls: { path: string; body: Record<string, string>; at: number }[] = []
/** How many calls of each path the webhook holds now, and the most it ever held at once. */
const flying = new Map<string, number>()
const peak = new Map<string, number>()

const as = (email: string, groups = 'User') => (path: string, init?: RequestInit): Promise<Response> => Promise.resolve(hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', 'x-forwarded-email': email, 'x-forwarded-groups': groups, ...init?.headers } }, { surface: 'session' }))
const admin = as('local@example.org', 'Admin')
const ada = as('ada@example.org')
const lead = as('lead@example.org')
const bob = as('bob@example.org')
const json = async <T>(r: Response): Promise<T> => (await r.json()) as T
const body = (v: unknown) => ({ body: JSON.stringify(v) })
const on = (key: string) => ({ blueprint: 'k8s_workload', key })

/** An action whose webhook, at `/<id>/<ms>/<status>`, answers with that status after that long. */
const define = (id: string, inputs: Record<string, unknown>, wait: number, status = 200, extra: Record<string, unknown> = {}) =>
  admin(`/v1/actions/${id}`, { method: 'PUT', ...body({ title: id, blueprint: 'k8s_workload', inputs, approval: true, access: { everyone: true }, backend: { type: 'webhook', url: `${hookUrl}/${id}/${wait}/${status}`, finish: 'answer', body: { key: '{{ entity.key }}', ...Object.fromEntries(Object.keys(inputs).map((n) => [n, `{{ inputs.${n} }}`])) } }, ...extra }) })
const ask = (who: typeof ada, items: unknown[], title = 'Program members for the fall term') => who('/v1/change-sets', { method: 'POST', ...body({ title, note: 'The roster the leads sent on Monday.', items }) })
const runsOf = async (set: string) => (await hub.db.query<{ id: string; action: string; key: string; state: string; actor: string; decided_by: string | null }>('SELECT id, action, key, state, actor, decided_by FROM action_runs WHERE change_set = $1 ORDER BY set_index', [set])).rows
const ended = (set: string, within: number) =>
  vi.waitFor(async () => {
    const runs = await runsOf(set)
    if (!runs.every((r) => isFinished(r.state as ActionRun['state']))) throw new Error(`still ${runs.map((r) => r.state).join(', ')}`)
    return runs
  }, { timeout: within, interval: 200 })

beforeAll(async () => {
  hook = createServer((req, res) => {
    let text = ''
    req.on('data', (chunk: Buffer) => (text += chunk.toString()))
    req.on('end', () => {
      const m = /^\/(\w+)\/(\d+)\/(\d+)$/.exec(req.url ?? '')
      if (!m) return void res.writeHead(404).end()
      const path = m[1]!
      calls.push({ path, body: JSON.parse(text || '{}') as Record<string, string>, at: Date.now() })
      flying.set(path, (flying.get(path) ?? 0) + 1)
      peak.set(path, Math.max(peak.get(path) ?? 0, flying.get(path)!))
      setTimeout(() => {
        flying.set(path, flying.get(path)! - 1)
        res.writeHead(Number(m[3])).end(Number(m[3]) < 300 ? 'done' : 'gave up')
      }, Number(m[2]))
    })
  })
  await new Promise<void>((r) => hook.listen(0, '127.0.0.1', r))
  hookUrl = `http://127.0.0.1:${(hook.address() as { port: number }).port}`
  const config = loadConfig({ DATABASE_URL, DATA_DIR: mkdtempSync(join(tmpdir(), 'orrery-')), AUTH_MODE: 'proxy', PUBLIC_URL: 'https://hub.example.org' })
  hub = await createHub(config, 'test', { reset: true })
  expect((await loadFixtureCatalog(hub)).errors).toEqual([])
  await hub.sources.save('k8s@home', { title: 'k8s', class: 'pusher', blueprints: ['*'], deleteGrant: [], cadence: '3m' })
  pusher = (await hub.sources.issueToken('source', 'k8s', { source: 'k8s@home' })).token
  for (const key of ['w/one', 'w/two', 'w/three', 'w/four']) await hub.app.request(`/v1/ingest/entities/k8s_workload/${encodeURIComponent(key)}`, { method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${pusher}` }, ...body({ title: key, fields: { name: key } }) }, { surface: 'machine' })
  const local = { admin: true, permissions: [] as never[], kind: 'user' as const, name: 'local', roles: [] }
  await hub.access.saveRole('lead', { title: 'Lead', permissions: ['actions.approve'] }, local)
  await hub.access.addUser('lead@example.org', ['lead'], local)
  for (const who of [ada, bob]) await who('/v1/whoami')
  adaKey = (await hub.sources.issueToken('personal', 'agent', { owner: 'ada@example.org' })).token
  // One at a time, and slower than the hub holds a hand-off, so the next run of it must wait its turn.
  expect((await define('add_to_program', { program: { type: 'string', required: true } }, 2_500, 200, { concurrency: 1 })).status).toBe(200)
  expect((await define('set_function', { function: { type: 'enum', values: ['QA', 'Dev'], required: true } }, 0)).status).toBe(200)
  expect((await define('flaky', {}, 0, 500)).status).toBe(200)
})

afterAll(async () => {
  hook.close()
  await hub.close()
})

describe('a change set of two actions, each run with its own inputs', () => {
  let set: ChangeSetSummary

  it('is asked as one set, each run waiting for its decision', async () => {
    const res = await ask(ada, [
      { action: 'add_to_program', entity: on('w/one'), inputs: { program: '803' } },
      { action: 'add_to_program', entity: on('w/two'), inputs: { program: '987' } },
      { action: 'set_function', entity: on('w/three'), inputs: { function: 'QA' } },
      { action: 'add_to_program', entity: on('w/three'), inputs: { program: '412' } },
    ])
    expect(res.status).toBe(201)
    set = await json<ChangeSetSummary>(res)
    expect(set).toMatchObject({ by: 'ada@example.org', decision: 'pending', size: 4, counts: { awaiting: 4 }, done: false, url: `https://hub.example.org/actions/sets/${set.id}` })
    expect(set.actions).toEqual([{ id: 'add_to_program', title: 'add_to_program', runs: 3 }, { id: 'set_function', title: 'set_function', runs: 1 }])
    expect((await runsOf(set.id)).map((r) => [r.action, r.key, r.state])).toEqual([
      ['add_to_program', 'w/one', 'awaiting'],
      ['add_to_program', 'w/two', 'awaiting'],
      ['set_function', 'w/three', 'awaiting'],
      ['add_to_program', 'w/three', 'awaiting'],
    ])
    expect(calls).toHaveLength(0)
  })

  it('is one approval for the approver, and none of its runs is one of its own', async () => {
    const waiting = await json<ChangeSetsResponse>(await lead('/v1/change-sets?waiting=true'))
    expect(waiting.sets.map((s) => s.id)).toEqual([set.id])
    const runs = await json<ActionRunsResponse>(await lead('/v1/action-runs?state=awaiting&sets=apart'))
    expect(runs.runs).toHaveLength(0)
    // Its asker does not approve their own, so it does not wait for them.
    expect((await json<ChangeSetsResponse>(await ada('/v1/change-sets?waiting=true'))).sets).toHaveLength(0)
    const page = await json<ChangeSetResponse>(await lead(`/v1/change-sets/${set.id}`))
    expect(page).toMatchObject({ canDecide: true, canWithdraw: false, canRetry: false, note: 'The roster the leads sent on Monday.' })
    expect(page.items.map((i) => [i.index, i.action, i.entityTitle, i.inputs])).toEqual([
      [0, 'add_to_program', 'w/one', { program: '803' }],
      [1, 'add_to_program', 'w/two', { program: '987' }],
      [2, 'set_function', 'w/three', { function: 'QA' }],
      [3, 'add_to_program', 'w/three', { program: '412' }],
    ])
    // A run of it is never decided alone, and its page links its set.
    const one = await lead(`/v1/action-runs/${page.items[0]!.run}/approve`, { method: 'POST', ...body({}) })
    expect(one.status).toBe(409)
    expect(await one.text()).toContain(`/actions/sets/${set.id}`)
    expect((await json<ActionRun>(await lead(`/v1/action-runs/${page.items[0]!.run}`))).changeSet).toBe(set.id)
  })

  it('tells the desk of the set once, for the approvers when no rule names one, and of none of its runs', async () => {
    const sent: NoticeEvent[] = []
    const dispatch = async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/v1/events')) sent.push(JSON.parse(String(init!.body)) as NoticeEvent)
      return new Response(JSON.stringify({}), { status: 200 })
    }
    await new NoticeForwarder({ db: hub.db, actions: hub.actions, batches: hub.batches, sets: hub.changeSets, schedules: hub.schedules, people: () => hub.people(), reader: hub.reader, blueprints: hub.blueprints, log: createLogger('notices-test') }, { url: 'http://dispatch.test/', token: 'tok', publicUrl: 'https://hub.example.org/', remindHours: 0, approvers: 'approvers' }, dispatch).pass()
    const ours = sent.filter((e) => e.labels.set === set.id || e.links.some((l) => l.url.includes(set.id)))
    expect(ours.map((e) => e.kind)).toEqual(['action.set_awaiting_approval'])
    expect(ours[0]!.to).toEqual([{ group: 'approvers' }])
    expect(ours[0]!.actions?.map((a) => a.path)).toEqual([`/v1/change-sets/${set.id}/approve`, `/v1/change-sets/${set.id}/reject`])
    expect(sent.some((e) => e.kind === 'action.awaiting_approval')).toBe(false)
  })

  it('is refused to its asker, who may not approve their own', async () => {
    const res = await ada(`/v1/change-sets/${set.id}/approve`, { method: 'POST', ...body({}) })
    expect(res.status).toBe(403)
    expect((await runsOf(set.id)).every((r) => r.state === 'awaiting')).toBe(true)
  })

  it('runs every run on one approval, as decided by the approver, one of an action at a time, in the set\'s order', async () => {
    const res = await lead(`/v1/change-sets/${set.id}/approve`, { method: 'POST', ...body({ note: 'Checked against the roster.' }) })
    expect(res.status).toBe(200)
    const approved = await json<ChangeSetApproval>(res)
    expect(approved).toMatchObject({ approved: 4, voted: 0, set: { decision: 'approved', decidedBy: 'lead@example.org' } })
    const runs = await ended(set.id, 20_000)
    expect(runs.map((r) => [r.state, r.actor, r.decided_by])).toEqual(Array(4).fill(['succeeded', 'ada@example.org', 'lead@example.org']))
    expect(peak.get('add_to_program')).toBe(1)
    expect(calls.filter((c) => c.path === 'add_to_program').map((c) => [c.body.key, c.body.program])).toEqual([['w/one', '803'], ['w/two', '987'], ['w/three', '412']])
    expect(calls.find((c) => c.path === 'set_function')!.body).toEqual({ key: 'w/three', function: 'QA' })
    await hub.changeSets.ended()
    const page = await json<ChangeSetResponse>(await ada(`/v1/change-sets/${set.id}`))
    expect(page).toMatchObject({ decision: 'approved', done: true, counts: { succeeded: 4 }, canRetry: false, decisionNote: 'Checked against the roster.' })
    const rows = await hub.db.query<{ kind: string }>(`SELECT kind FROM changes WHERE detail->>'set' = $1 AND kind LIKE 'action.set%' ORDER BY id`, [set.id])
    expect(rows.rows.map((r) => r.kind)).toEqual(['action.set_requested', 'action.set_approved', 'action.set_finished'])
  })

  it('shows as one line in the runs list, holding none of its runs', async () => {
    const list = await json<ActionRunsResponse>(await ada('/v1/action-runs?group=batch'))
    expect(list.sets?.map((s) => s.id)).toContain(set.id)
    expect(list.runs.some((r) => r.changeSet === set.id)).toBe(false)
  })
})

describe('a change set with an item that would be refused', () => {
  it('asks none of them, naming each refused item and the input it is about', async () => {
    const before = (await hub.db.query<{ n: number }>('SELECT count(*)::int AS n FROM action_runs')).rows[0]!.n
    const res = await ask(ada, [
      { action: 'add_to_program', entity: on('w/one'), inputs: { program: '803' } },
      { action: 'set_function', entity: on('w/two'), inputs: { function: 'Nope' } },
      { action: 'add_to_program', entity: on('w/gone'), inputs: { program: '1' } },
      { action: 'no_such_action', entity: on('w/one'), inputs: {} },
    ])
    expect(res.status).toBe(400)
    const said = await json<{ error: string; items: ChangeSetRefusal[] }>(res)
    expect(said.error).toMatch(/^3 of its 4 changes would be refused, so none is asked/)
    expect(said.items.map((i) => [i.index, i.action, i.input ?? null])).toEqual([
      [1, 'set_function', 'function'],
      [2, 'add_to_program', null],
      [3, 'no_such_action', null],
    ])
    expect((await hub.db.query<{ n: number }>('SELECT count(*)::int AS n FROM action_runs')).rows[0]!.n).toBe(before)
  })
})

describe('deciding a change set otherwise', () => {
  const two = () => ask(ada, [
    { action: 'set_function', entity: on('w/one'), inputs: { function: 'Dev' } },
    { action: 'set_function', entity: on('w/two'), inputs: { function: 'QA' } },
  ], 'Functions')

  it('rejects every run when it is rejected', async () => {
    const set = await json<ChangeSetSummary>(await two())
    const res = await lead(`/v1/change-sets/${set.id}/reject`, { method: 'POST', ...body({ reason: 'Wrong roster' }) })
    expect(res.status).toBe(200)
    expect(await json<ChangeSetSummary>(res)).toMatchObject({ decision: 'rejected', decidedBy: 'lead@example.org', decisionNote: 'Wrong roster' })
    expect((await runsOf(set.id)).map((r) => r.state)).toEqual(['declined', 'declined'])
    expect((await lead(`/v1/change-sets/${set.id}/approve`, { method: 'POST', ...body({}) })).status).toBe(409)
  })

  it('is withdrawn by whoever asked, and by nobody else, before it is decided', async () => {
    const set = await json<ChangeSetSummary>(await two())
    expect((await bob(`/v1/change-sets/${set.id}/withdraw`, { method: 'POST', ...body({}) })).status).toBe(404)
    // A run of it is withdrawn only with its set.
    expect((await ada(`/v1/action-runs/${(await runsOf(set.id))[0]!.id}/withdraw`, { method: 'POST', ...body({}) })).status).toBe(409)
    const res = await ada(`/v1/change-sets/${set.id}/withdraw`, { method: 'POST', ...body({ reason: 'Asked too soon' }) })
    expect(res.status).toBe(200)
    expect(await json<ChangeSetSummary>(res)).toMatchObject({ decision: 'withdrawn', decidedBy: 'ada@example.org' })
    expect((await runsOf(set.id)).map((r) => r.state)).toEqual(['cancelled', 'cancelled'])
    expect((await lead(`/v1/change-sets/${set.id}/approve`, { method: 'POST', ...body({}) })).status).toBe(409)
    expect((await ada(`/v1/change-sets/${set.id}/withdraw`, { method: 'POST', ...body({}) })).status).toBe(409)
  })
})

describe('a change set that ended with failures', () => {
  it('asks again for the failed items alone, as a new set for approval', async () => {
    const set = await json<ChangeSetSummary>(await ask(ada, [
      { action: 'set_function', entity: on('w/one'), inputs: { function: 'QA' } },
      { action: 'flaky', entity: on('w/two'), inputs: {} },
    ], 'Mixed'))
    expect((await lead(`/v1/change-sets/${set.id}/approve`, { method: 'POST', ...body({}) })).status).toBe(200)
    expect((await ended(set.id, 10_000)).map((r) => r.state)).toEqual(['succeeded', 'failed'])
    const page = await json<ChangeSetResponse>(await ada(`/v1/change-sets/${set.id}`))
    expect(page).toMatchObject({ done: true, canRetry: true, counts: { succeeded: 1, failed: 1 } })
    expect((await json<ChangeSetResponse>(await bob(`/v1/change-sets/${set.id}`))).canRetry).toBe(false)
    const res = await ada(`/v1/change-sets/${set.id}/retry`, { method: 'POST', ...body({}) })
    expect(res.status).toBe(201)
    const again = await json<ChangeSetSummary>(res)
    expect(again).toMatchObject({ title: 'Retry: Mixed', retries: set.id, decision: 'pending', size: 1, actions: [{ id: 'flaky', runs: 1 }] })
  })
})

describe('an agent', () => {
  const tool = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const res = await hub.app.request('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${adaKey}` }, ...body({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }, { surface: 'machine' })
    const said = (await res.json()) as { result: { content: { text: string }[] } }
    return JSON.parse(said.result.content[0]!.text) as Record<string, unknown>
  }

  it('proposes a change set and is given the link to approve it', async () => {
    const said = await tool('propose_changes', { title: 'From the agent', note: 'Asked in chat', items: [{ action: 'set_function', entity: 'k8s_workload:w/one', inputs: { function: 'Dev' } }, { action: 'add_to_program', entity: 'k8s_workload:w/two', inputs: { program: '9' } }] })
    expect(said).toMatchObject({ decision: 'pending', changes: 2, approve: `https://hub.example.org/actions/sets/${said.set as string}` })
    expect(said.next).toContain(said.approve as string)
    const row = await hub.db.query<{ actor: string; through: string | null }>('SELECT actor, through FROM change_sets WHERE id = $1', [said.set])
    expect(row.rows[0]).toEqual({ actor: 'ada@example.org', through: null })
  })

  it('is told each item that would be refused, by its index', async () => {
    const said = await tool('propose_changes', { title: 'Bad', items: [{ action: 'set_function', entity: 'k8s_workload:w/one', inputs: { function: 'Nope' } }] })
    expect(said.items).toEqual([{ index: 0, action: 'set_function', entity: 'k8s_workload:w/one', error: expect.any(String), input: 'function' }])
  })
})

describe('the approvals inbox', () => {
  const machine = (path: string, init?: RequestInit) => hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${pusher}`, ...init?.headers } }, { surface: 'machine' })
  const record = (key: string) => hub.reader.get({ blueprint: 'approval', key })

  beforeAll(async () => {
    expect((await admin('/v1/blueprints/person', { method: 'PUT', ...body({ title: 'Person', fields: { email: { type: 'email' } } }) })).status).toBeLessThan(300)
    expect((await admin('/v1/access/person', { method: 'PUT', ...body({ blueprint: 'person', field: 'email' }) })).status).toBe(200)
    for (const who of ['ada', 'lead']) await machine(`/v1/ingest/entities/person/${who}`, { method: 'PUT', ...body({ title: who, fields: { email: `${who}@example.org` } }) })
    const approval = { title: 'Approval', fields: { decision: { type: 'enum', values: ['pending', 'approved', 'declined', 'expired'] }, source: { type: 'string' }, kind: { type: 'string' }, requested_by: { type: 'string' }, decided_by: { type: 'string' }, url: { type: 'url' } }, relations: { requester: { target: 'person' }, approvers: { target: 'person', many: true } } }
    expect((await admin('/v1/blueprints/approval', { method: 'PUT', ...body(approval) })).status).toBeLessThan(300)
    expect((await admin('/v1/access/approvals', { method: 'PUT', ...body({ blueprint: 'approval' }) })).status).toBe(200)
    expect((await admin('/v1/actions/approve_it', { method: 'PUT', ...body({ title: 'Approve it', blueprint: 'approval', inputs: {}, access: { everyone: true }, backend: { type: 'decide', verdict: 'approve' } }) })).status).toBe(200)
  })

  it('holds one record for the set, none for its runs, and approves every run from it', async () => {
    const set = await json<ChangeSetSummary>(await ask(ada, [
      { action: 'set_function', entity: on('w/one'), inputs: { function: 'QA' } },
      { action: 'set_function', entity: on('w/two'), inputs: { function: 'Dev' } },
    ], 'From the inbox'))
    await hub.approvals.pass()
    const rec = await record(`orrery/set/${set.id}`)
    expect(rec?.fields).toMatchObject({ decision: 'pending', source: 'orrery', kind: 'change set', requested_by: 'ada@example.org', url: set.url })
    expect(rec?.relations.approvers?.map((r) => r.key)).toContain('lead')
    for (const run of await runsOf(set.id)) expect(await record(`orrery/run/${run.id}`)).toBeNull()
    const decided = await json<ActionRun>(await lead('/v1/actions/approve_it/run', { method: 'POST', ...body({ entity: { blueprint: 'approval', key: `orrery/set/${set.id}` }, inputs: {} }) }))
    expect((await hub.actions.getRun(decided.id))?.state).toBe('succeeded')
    expect((await ended(set.id, 10_000)).map((r) => [r.state, r.decided_by])).toEqual([['succeeded', 'lead@example.org'], ['succeeded', 'lead@example.org']])
    await hub.approvals.pass()
    expect((await record(`orrery/set/${set.id}`))?.fields).toMatchObject({ decision: 'approved', decided_by: 'lead@example.org' })
  })
})
