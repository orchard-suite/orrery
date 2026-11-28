import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ChangeStatement } from '../shared/change.ts'
import type { ActionRun, Change } from '../shared/model.ts'
import { toEvent } from './annals.ts'
import { loadConfig } from './config.ts'
import { createHub, type Hub } from './hub.ts'

// ORY-2002: a personal token is its person's agent. It asks for them and never decides; whether the person decides what
// their agent asks, as someone who did not ask, is the deployment's.

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://orrery:orrery@localhost:5433/orrery'
const example = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'shared', 'change', 'examples', 'event-stated.json'), 'utf8')) as { statement: ChangeStatement }
const { unknown: _parts, ...statement } = example.statement
const OWNER = 'ada@example.com'
const OTHER = 'grace@example.com'

const json = async <T = Record<string, unknown>>(r: Response): Promise<T> => (await r.json()) as T
const body = (v: unknown) => ({ body: JSON.stringify(v) })

/** A hub with the deployment's choice, an approver token, an action that waits for approval, and one the judge routes to the owner. */
async function start(personDecides: boolean) {
  const config = loadConfig({ DATABASE_URL, DATA_DIR: mkdtempSync(join(tmpdir(), 'orrery-')), AUTH_MODE: 'proxy', PUBLIC_URL: 'https://hub.example.com', JUDGE_URL: 'http://judge.test/', JUDGE_TOKEN: 'judge-token', AGENT_PERSON_DECIDES: String(personDecides) })
  const judgeFetch: typeof fetch = async () => Response.json({ judge: { name: 'trellis', version: '7.0.0', pack: 'gate' }, route: { to: 'people', grants: [{ values: [OWNER] }], quorum: 1 }, reasons: [{ effect: 0, rule: 'stops-in-place', proof: 'measured' }] })
  const hub = await createHub(config, '9.9.9', { reset: true, judgeFetch })
  const session = (who: string) => (path: string, init?: RequestInit) => Promise.resolve(hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', 'x-forwarded-email': who, 'x-forwarded-groups': 'Admin', ...init?.headers } }, { surface: 'session' }))
  const admin = { admin: true, permissions: [] as never[], kind: 'user' as const, name: 'local', roles: [] }
  await hub.access.saveRole('lead', { title: 'Lead', permissions: ['actions.approve'] }, admin)
  const lead = (await hub.sources.issueToken('access', 'lead', { role: 'lead' })).token
  // The owner signs in once, then makes a key for their agent.
  expect((await session(OWNER)('/v1/me/tokens')).status).toBe(200)
  expect((await session(OTHER)('/v1/me/tokens')).status).toBe(200)
  const made = await session(OWNER)('/v1/me/tokens', { method: 'POST', ...body({ name: 'agent-laptop' }) })
  expect(made.status).toBe(201)
  const key = (await json<{ token: string }>(made)).token
  const machine = (token: string) => (path: string, init?: RequestInit) => Promise.resolve(hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...init?.headers } }, { surface: 'machine' }))
  const owner = session(OWNER)
  expect((await owner('/v1/actions/fixed', { method: 'PUT', ...body({ title: 'Fixed', backend: { type: 'caller' }, inputs: {}, approval: true, access: { everyone: true } }) })).status).toBe(200)
  expect((await owner('/v1/actions/routed', { method: 'PUT', ...body({ title: 'Routed', backend: { type: 'caller' }, inputs: { plan: { type: 'change', required: true } }, judge: true, access: { everyone: true } }) })).status).toBe(200)
  const agent = machine(key)
  const ask = async (action: string, inputs: Record<string, unknown> = {}) => {
    const r = await agent(`/v1/actions/${action}/run`, { method: 'POST', ...body({ inputs }) })
    expect(r.status, JSON.stringify(await r.clone().json())).toBe(201)
    return json<ActionRun>(r)
  }
  const approve = (as: (path: string, init?: RequestInit) => Promise<Response>, run: string) => as(`/v1/action-runs/${run}/approve`, { method: 'POST', ...body({}) })
  return { hub, owner, other: session(OTHER), agent, lead: machine(lead), ask, approve }
}

describe('an agent with its person\'s key, where the person decides what it asks', () => {
  let h: Awaited<ReturnType<typeof start>>
  beforeAll(async () => {
    h = await start(true)
  })
  afterAll(async () => {
    await h.hub.close()
  })

  it('asks as itself for its person, and the run and its row name it', async () => {
    const run = await h.ask('fixed')
    expect(run).toMatchObject({ state: 'awaiting', by: OWNER, agent: 'agent-laptop' })
    expect(run.log[0]!.message).toContain('requested by agent-laptop, the agent of ada@example.com')
    const rows = (await json<{ changes: Change[] }>(await h.owner('/v1/changes?kind=action.requested&limit=50'))).changes
    const row = rows.find((c) => (c.detail as { run?: string }).run === run.id)!
    expect(row.actor).toBe(OWNER)
    expect(row.detail).toMatchObject({ agent: 'agent-laptop' })
  })

  it('never decides a run, and its person decides it signed in', async () => {
    const run = await h.ask('fixed')
    const refused = await h.approve(h.agent, run.id)
    expect(refused.status).toBe(403)
    expect(JSON.stringify(await json(refused))).toContain('An agent never decides a run')
    const done = await h.approve(h.owner, run.id)
    expect(done.status, JSON.stringify(await done.clone().json())).toBe(200)
    expect((await json<ActionRun>(done)).state).toBe('queued')
    const rows = (await json<{ changes: Change[] }>(await h.owner('/v1/changes?kind=action.approved&limit=50'))).changes
    expect(rows.find((c) => (c.detail as { run?: string }).run === run.id)?.detail).toMatchObject({ requestedBy: OWNER, requestedByAgent: 'agent-laptop', selfApproved: false })
  })

  it('lets its person give what the judge\'s route asks, where the route names them', async () => {
    const run = await h.ask('routed', { plan: statement })
    expect(run).toMatchObject({ state: 'awaiting', agent: 'agent-laptop', routeAsks: { grants: [{ values: [OWNER] }], need: 1 } })
    expect((await h.approve(h.agent, run.id)).status).toBe(403)
    const done = await h.approve(h.owner, run.id)
    expect(done.status, JSON.stringify(await done.clone().json())).toBe(200)
    expect((await json<ActionRun>(done)).state).toBe('queued')
  })

  it('tells its person a run their route names them for waits for them', async () => {
    const run = await h.ask('routed', { plan: statement })
    expect(await h.hub.actions.deciders(await json<ActionRun>(await h.owner(`/v1/action-runs/${run.id}`)))).toEqual([OWNER])
  })

  it('is told it is an agent, on the agent door and on the API', async () => {
    const res = await h.agent('/mcp', { method: 'POST', headers: { accept: 'application/json, text/event-stream' }, ...body({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'who_am_i', arguments: {} } }) })
    const sent = await res.text()
    const line = sent.split('\n').find((l) => l.startsWith('data:'))
    const rpc = JSON.parse(line ? line.slice(5) : sent) as { result: { content: { text: string }[] } }
    expect(JSON.parse(rpc.result.content[0]!.text)).toMatchObject({ address: OWNER, kind: 'user', agent: 'agent-laptop' })
    expect((await json<{ identity: { agent?: string } }>(await h.agent('/v1/whoami'))).identity.agent).toBe('agent-laptop')
  })

  it('is the actor Annals records, for its person', async () => {
    const event = toEvent({ id: '1', at: new Date(), kind: 'action.requested', category: 'runs', outcome: 'ok', blueprint: null, key: null, source: null, actor: OWNER, actor_kind: 'user', detail: { action: 'fixed', run: 'r1', agent: 'agent-laptop' } })
    expect(event.actor).toEqual({ kind: 'agent', id: 'agent-laptop', on_behalf_of: OWNER })
  })
})

describe('an agent with its person\'s key, where someone else decides what it asks', () => {
  let h: Awaited<ReturnType<typeof start>>
  beforeAll(async () => {
    h = await start(false)
  })
  afterAll(async () => {
    await h.hub.close()
  })

  it('is one asker with its person: they do not decide it, and someone else does', async () => {
    const run = await h.ask('fixed')
    const own = await h.approve(h.owner, run.id)
    expect(own.status).toBe(403)
    expect(JSON.stringify(await json(own))).toContain('someone other than the person who asked')
    expect((await h.approve(h.agent, run.id)).status).toBe(403)
    const done = await h.approve(h.other, run.id)
    expect(done.status, JSON.stringify(await done.clone().json())).toBe(200)
    expect((await json<ActionRun>(done)).state).toBe('queued')
  })

  it('keeps its person from what the judge\'s route asks, and tells them nothing of it', async () => {
    const run = await h.ask('routed', { plan: statement })
    const own = await h.approve(h.owner, run.id)
    expect(own.status).toBe(403)
    expect(JSON.stringify(await json(own))).toContain('never decides what its route asks')
    expect(await h.hub.actions.deciders(await json<ActionRun>(await h.owner(`/v1/action-runs/${run.id}`)))).toEqual([])
  })
})
