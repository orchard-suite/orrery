import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ChangeEvent, ChangeStatement } from '../shared/change.ts'
import type { ActionRun, Change } from '../shared/model.ts'
import { AnnalsForwarder, type AnnalsEvent } from './annals.ts'
import { loadConfig } from './config.ts'
import { createHub, type Hub } from './hub.ts'
import { createLogger } from './log.ts'
import { NoticeForwarder, type NoticeEvent } from './notices.ts'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://orrery:orrery@localhost:5433/orrery'
const example = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'shared', 'change', 'examples', 'event-stated.json'), 'utf8')) as { digest: string; statement: ChangeStatement }
const statement = example.statement

let hub: Hub
let approver = ''
let reporter = ''

const json = async <T = Record<string, unknown>>(r: Response): Promise<T> => (await r.json()) as T
const body = (v: unknown) => ({ body: JSON.stringify(v) })
const session = (path: string, init?: RequestInit) => Promise.resolve(hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', 'x-forwarded-email': 'admin@example.com', 'x-forwarded-groups': 'Admin', ...init?.headers } }, { surface: 'session' }))
const machine = (bearer: string) => (path: string, init?: RequestInit) => Promise.resolve(hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}`, ...init?.headers } }, { surface: 'machine' }))
const ask = async (action: string, inputs: Record<string, unknown>) => json<ActionRun>(await session(`/v1/actions/${action}/run`, { method: 'POST', ...body({ inputs }) }))
const report = (id: string, report: Record<string, unknown>) => machine(reporter)(`/v1/action-runs/${id}/report`, { method: 'POST', ...body(report) })
/** The change events of one run, in the order they were written. */
const eventsOf = async (run: string): Promise<ChangeEvent[]> => {
  const rows = (await json<{ changes: Change[] }>(await session('/v1/changes?kind=change.stated,change.routed,change.decided,change.ended&limit=500'))).changes
  return rows
    .filter((c) => (c.detail as { run?: string }).run === run)
    .reverse()
    .map((c) => (c.detail as { event: ChangeEvent }).event)
}

beforeAll(async () => {
  const config = loadConfig({ DATABASE_URL, DATA_DIR: mkdtempSync(join(tmpdir(), 'orrery-')), AUTH_MODE: 'proxy', PUBLIC_URL: 'https://hub.example.com' })
  hub = await createHub(config, '9.9.9', { reset: true })
  const admin = { admin: true, permissions: [] as never[], kind: 'user' as const, name: 'local', roles: [] }
  await hub.access.saveRole('lead', { title: 'Lead', permissions: ['actions.approve'] }, admin)
  await hub.access.saveRole('operator', { title: 'Operator', permissions: ['actions.report'] }, admin)
  approver = (await hub.sources.issueToken('access', 'lead', { role: 'lead' })).token
  reporter = (await hub.sources.issueToken('access', 'applier', { role: 'operator' })).token
  const put = (id: string, spec: Record<string, unknown>) => session(`/v1/actions/${id}`, { method: 'PUT', ...body({ title: id, backend: { type: 'caller' }, ...spec }) })
  expect((await put('apply_change', { inputs: { plan: { type: 'change', title: 'The change', required: true } }, approval: true })).status).toBe(200)
  expect((await put('apply_now', { inputs: { plan: { type: 'change', required: true } } })).status).toBe(200)
  expect((await put('plain', { inputs: { environment: { type: 'string' } } })).status).toBe(200)
})

afterAll(async () => {
  await hub.close()
})

describe('a run that states a change', () => {
  it('is refused a statement the contract refuses, naming the input', async () => {
    const r = await session('/v1/actions/apply_change/run', { method: 'POST', ...body({ inputs: { plan: { ...statement, applier: 'laptop' } } }) })
    expect(r.status).toBe(400)
    expect(await json(r)).toMatchObject({ input: 'plan', error: 'Input "plan": applier must be one of hub, asker' })
    // What Annals would refuse downstream is refused here, as the platform kit's validator refuses it.
    const named = await session('/v1/actions/apply_change/run', { method: 'POST', ...body({ inputs: { plan: { ...statement, things: [{ blueprint: 'workload', key: 'owner-user@example.com' }] } } }) })
    expect(named.status).toBe(400)
    expect(await json(named)).toMatchObject({ input: 'plan', error: 'Input "plan": things[0].key holds an email address; a person is named only as the actor' })
  })

  it('keeps the statement and its digest, and is stated, routed to who it waits on, decided, and ended', async () => {
    const r = await ask('apply_change', { plan: JSON.stringify(statement) })
    expect(r.state).toBe('awaiting')
    expect(r.inputs.plan).toEqual(statement)
    expect(r.statementDigest).toBe(example.digest)
    const [stated, routed, ...rest] = await eventsOf(r.id)
    expect(rest).toEqual([])
    expect(stated).toEqual({ event: 'change.stated', sender: 'orrery', key: `${r.id}.stated`, at: expect.any(String), digest: example.digest, statement })
    expect(routed).toMatchObject({ event: 'change.routed', key: `${r.id}.routed`, of: { sender: 'orrery', key: `${r.id}.stated` }, digest: example.digest, judge: { name: 'orrery', version: '9.9.9', pack: 'action.apply_change' }, reasons: [{ rule: 'action-approval' }] })
    if (routed?.event !== 'change.routed' || routed.route.to !== 'people') throw new Error('expected a route to people')
    expect(routed.route.quorum).toBe(1)
    // The approver token may decide it; whoever asked may not.
    expect(routed.route.grants).toEqual([{ values: ['lead'] }])

    const approved = await json<ActionRun>(await machine(approver)(`/v1/action-runs/${r.id}/approve`, { method: 'POST' }))
    expect(approved.state).toBe('queued')
    expect((await report(r.id, { state: 'running' })).status).toBe(200)
    expect((await report(r.id, { state: 'succeeded', outputs: { statement_check: 'matched' } })).status).toBe(200)
    const events = await eventsOf(r.id)
    expect(events.map((e) => e.key)).toEqual([`${r.id}.stated`, `${r.id}.routed`, `${r.id}.decided.1`, `${r.id}.ended`])
    expect(events[2]).toMatchObject({ event: 'change.decided', by: { kind: 'person', id: 'lead' }, answer: 'yes', of: { key: `${r.id}.stated` } })
    expect(events[3]).toMatchObject({ event: 'change.ended', outcome: 'ok', check: 'matched', digest: example.digest })
    expect(events[3]).not.toHaveProperty('differs')
  })

  it('is decided no and ended refused when declined', async () => {
    const r = await ask('apply_change', { plan: statement })
    await machine(approver)(`/v1/action-runs/${r.id}/decline`, { method: 'POST', ...body({ reason: 'not today' }) })
    const events = await eventsOf(r.id)
    expect(events.map((e) => e.event)).toEqual(['change.stated', 'change.routed', 'change.decided', 'change.ended'])
    expect(events[2]).toMatchObject({ key: `${r.id}.decided.1`, answer: 'no' })
    expect(events[3]).toMatchObject({ outcome: 'refused', check: 'unchecked' })
    const ended = (await json<{ changes: Change[] }>(await session('/v1/changes?kind=change.ended'))).changes.find((c) => (c.detail as { run?: string }).run === r.id)!
    expect(ended).toMatchObject({ outcome: 'failed', category: 'actions', detail: { reason: 'declined', state: 'declined' } })
  })

  it('goes to no one when it waits for nobody, and ends refused when the applier finds the statement differed', async () => {
    const r = await ask('apply_now', { plan: statement })
    expect(r.state).toBe('queued')
    expect((await eventsOf(r.id))[1]).toMatchObject({ route: { to: 'no_one' } })
    await report(r.id, { state: 'running' })
    await report(r.id, { state: 'failed', outputs: { statement_check: 'differed', statement_differs: 'artifact,effects' } })
    const ended = (await eventsOf(r.id)).at(-1)
    expect(ended).toMatchObject({ event: 'change.ended', outcome: 'refused', check: 'differed', differs: ['artifact', 'effects'] })
  })

  it('ends once, whatever ends its run', async () => {
    const r = await ask('apply_now', { plan: statement })
    await session(`/v1/action-runs/${r.id}/withdraw`, { method: 'POST', ...body({}) })
    expect((await eventsOf(r.id)).filter((e) => e.event === 'change.ended')).toMatchObject([{ outcome: 'refused', check: 'unchecked' }])
  })
})

describe('a change set whose runs state changes', () => {
  it('states and routes each run as the set is asked, and decides each with the set', async () => {
    const other = { ...statement, key: 'plan-8b1d' }
    const asked = await session('/v1/change-sets', { method: 'POST', ...body({ title: 'Two applies', items: [{ action: 'apply_change', inputs: { plan: statement } }, { action: 'apply_change', inputs: { plan: other } }] }) })
    expect(asked.status).toBe(201)
    const set = (await json<{ id: string }>(asked)).id
    const runs = (await hub.db.query<{ id: string; statement_digest: string }>('SELECT id, statement_digest FROM action_runs WHERE change_set = $1 ORDER BY set_index', [set])).rows
    expect(runs.map((r) => r.statement_digest)).toEqual([example.digest, expect.stringMatching(/^sha256:[0-9a-f]{64}$/)])
    expect(runs[1]!.statement_digest).not.toBe(example.digest)
    for (const run of runs) expect((await eventsOf(run.id)).map((e) => e.event)).toEqual(['change.stated', 'change.routed'])
    expect((await eventsOf(runs[0]!.id))[1]).toMatchObject({ route: { to: 'people', grants: [{ values: ['lead'] }], quorum: 1 } })
    expect((await machine(approver)(`/v1/change-sets/${set}/approve`, { method: 'POST', ...body({}) })).status).toBe(200)
    for (const run of runs) expect((await eventsOf(run.id)).map((e) => e.key)).toEqual([`${run.id}.stated`, `${run.id}.routed`, `${run.id}.decided.1`])
  })
})

describe('a run that states nothing', () => {
  it('writes no change event, and drops a statement its action does not ask for', async () => {
    const r = await ask('plain', { environment: 'prod', statement })
    expect(r.inputs).toEqual({ environment: 'prod' })
    expect(r).not.toHaveProperty('statementDigest')
    await report(r.id, { state: 'succeeded' })
    expect(await eventsOf(r.id)).toEqual([])
  })
})

describe('the change events, carried on', () => {
  it('go to Annals keyed by the run, and the waiting run is asked with its statement in words', async () => {
    const r = await ask('apply_change', { plan: statement })
    const posted: AnnalsEvent[] = []
    const annals = new AnnalsForwarder(hub.db, { url: 'http://annals.test', token: 't' }, createLogger('annals-test'), async (_url, init) => {
      const events = JSON.parse(String(init?.body)) as AnnalsEvent[]
      posted.push(...events)
      return Response.json({ results: events.map((_e, index) => ({ index, status: 'stored' })) })
    })
    await annals.pass()
    const mine = posted.filter((e) => e.event_key.startsWith(`${r.id}.`))
    expect(mine.map((e) => e.event_key)).toEqual([`${r.id}.stated`, `${r.id}.routed`])
    expect(mine[0]).toMatchObject({ actor: { kind: 'agent', id: 'agent-1', on_behalf_of: 'user@example.com' }, items: [{ system: 'catalog', kind: 'workload', id: 'acme-api-prod' }], change: { after_hash: example.digest } })
    expect(mine[1]).toMatchObject({ cause: `${r.id}.stated`, cause_source: 'orrery', labels: { route: 'people', quorum: '1', judge: 'orrery', pack: 'action.apply_change' } })

    const sent: NoticeEvent[] = []
    const desk = new NoticeForwarder({ db: hub.db, actions: hub.actions, batches: hub.batches, sets: hub.changeSets, schedules: hub.schedules, people: () => hub.people(), reader: hub.reader, blueprints: hub.blueprints, log: createLogger('notices-test') }, { url: 'http://dispatch.test', token: 'tok', publicUrl: 'https://hub.example.com', remindHours: 0 }, async (url, init) => {
      if (String(url).endsWith('/v1/events')) sent.push(JSON.parse(String(init?.body)) as NoticeEvent)
      return new Response(JSON.stringify({}), { status: 202 })
    })
    await desk.pass()
    const waiting = sent.find((e) => e.kind === 'action.awaiting_approval' && e.links[0]?.url.endsWith(r.id))!
    expect(waiting.text).toContain('- stops workload acme-api-prod (2), in-place; the old artifact puts it back')
    expect(waiting.text).toContain('Parts with no effect named:')
    expect(waiting.facts).toContainEqual({ name: 'Runs on', value: 'a job the hub starts' })
    expect(JSON.stringify(waiting.facts)).not.toContain('"digest"')
  })

  it('leave a change that ran to its change events: the notices make no change on the desk', async () => {
    const ran = await ask('apply_now', { plan: statement })
    await report(ran.id, { state: 'running' })
    await report(ran.id, { state: 'succeeded', outputs: { statement_check: 'matched' } })
    const paths: string[] = []
    const desk = new NoticeForwarder({ db: hub.db, actions: hub.actions, batches: hub.batches, sets: hub.changeSets, schedules: hub.schedules, people: () => hub.people(), reader: hub.reader, blueprints: hub.blueprints, log: createLogger('notices-test') }, { url: 'http://dispatch.test', token: 'tok', publicUrl: 'https://hub.example.com', remindHours: 0 }, async (url) => {
      paths.push(new URL(String(url)).pathname)
      return new Response('{}', { status: 202 })
    })
    await desk.pass()
    expect(paths).toContain('/v1/events')
    expect([...new Set(paths)].sort()).toEqual(['/v1/events', '/v1/kinds'])
  })
})
