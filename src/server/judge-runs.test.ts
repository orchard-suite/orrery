import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sentIssue, type ChangeEvent, type ChangeRouted, type ChangeStatement } from '../shared/change.ts'
import type { ActionRun, Change } from '../shared/model.ts'
import { loadConfig } from './config.ts'
import { createHub, type Hub } from './hub.ts'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://orrery:orrery@localhost:5433/orrery'
const example = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'shared', 'change', 'examples', 'event-stated.json'), 'utf8')) as { digest: string; statement: ChangeStatement }
/** A statement every part of which has an effect, which a route of no one may pass. */
const { unknown: _parts, ...clean } = example.statement
const statement: ChangeStatement = clean
const JUDGE = { name: 'trellis', version: '7.0.0', pack: 'gate' }
const LATER = new Date(Date.now() + 3_600_000).toISOString()

let hub: Hub
const tokens: Record<string, string> = {}
/** What the fake judge answers next, and every statement it was asked. */
let reply: () => Response | Promise<Response> = () => Response.json({})
const asked: { url: string; body: { statement: ChangeStatement } }[] = []

const json = async <T = Record<string, unknown>>(r: Response): Promise<T> => (await r.json()) as T
const body = (v: unknown) => ({ body: JSON.stringify(v) })
const session = (path: string, init?: RequestInit) => Promise.resolve(hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', 'x-forwarded-email': 'admin@example.com', 'x-forwarded-groups': 'Admin', ...init?.headers } }, { surface: 'session' }))
const as = (who: string) => (path: string, init?: RequestInit) => Promise.resolve(hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens[who]}`, ...init?.headers } }, { surface: 'machine' }))
const ask = async (action: string, plan?: ChangeStatement) => {
  const r = await session(`/v1/actions/${action}/run`, { method: 'POST', ...body({ inputs: plan ? { plan } : {} }) })
  expect(r.status, JSON.stringify(await r.clone().json())).toBe(201)
  return json<ActionRun>(r)
}
const approve = (who: string, run: string, digest?: string) => as(who)(`/v1/action-runs/${run}/approve`, { method: 'POST', ...body(digest ? { digest } : {}) })
const runOf = async (id: string) => json<ActionRun>(await session(`/v1/action-runs/${id}`))
/** The judge's answer: its route, the reason it gives, and anything else it says. */
const answer = (route: Record<string, unknown>, more: Record<string, unknown> = {}) => () => Response.json({ judge: JUDGE, route, reasons: [{ effect: 0, rule: 'stops-in-place', proof: 'measured' }], ...more })
const toSec = { to: 'people', grants: [{ values: ['sec'] }], quorum: 1 }
const routedOf = async (run: string): Promise<ChangeRouted> => {
  const rows = (await json<{ changes: Change[] }>(await session('/v1/changes?kind=change.routed&limit=500'))).changes
  const event = rows.map((c) => c.detail as { run?: string; event: ChangeEvent }).find((d) => d.run === run)?.event
  if (event?.event !== 'change.routed') throw new Error(`no routed event for run ${run}`)
  return event
}

beforeAll(async () => {
  const config = loadConfig({ DATABASE_URL, DATA_DIR: mkdtempSync(join(tmpdir(), 'orrery-')), AUTH_MODE: 'proxy', PUBLIC_URL: 'https://hub.example.com', JUDGE_URL: 'http://judge.test/' })
  const judgeFetch: typeof fetch = async (url, init) => {
    asked.push({ url: String(url), body: JSON.parse(String(init?.body)) as { statement: ChangeStatement } })
    return reply()
  }
  hub = await createHub(config, '9.9.9', { reset: true, judgeFetch })
  const admin = { admin: true, permissions: [] as never[], kind: 'user' as const, name: 'local', roles: [] }
  await hub.access.saveRole('lead', { title: 'Lead', permissions: ['actions.approve'] }, admin)
  await hub.access.saveRole('reviewer', { title: 'Reviewer', permissions: [] }, admin)
  await hub.access.saveRole('operator', { title: 'Operator', permissions: ['actions.report'] }, admin)
  tokens.lead = (await hub.sources.issueToken('access', 'lead', { role: 'lead' })).token
  for (const name of ['sec', 'sec2']) tokens[name] = (await hub.sources.issueToken('access', name, { role: 'reviewer' })).token
  tokens.applier = (await hub.sources.issueToken('access', 'applier', { role: 'operator' })).token
  const put = (id: string, spec: Record<string, unknown>) => session(`/v1/actions/${id}`, { method: 'PUT', ...body({ title: id, backend: { type: 'caller' }, inputs: { plan: { type: 'change', required: true } }, judge: true, ...spec }) })
  // An action that asks no one itself, one that always waits for someone who holds actions.approve, and one a run may ask with no statement.
  expect((await put('open', {})).status).toBe(200)
  expect((await put('fixed', { approval: true })).status).toBe(200)
  expect((await put('optional', { inputs: { plan: { type: 'change' } } })).status).toBe(200)
})

afterAll(async () => {
  await hub.close()
})

beforeEach(() => {
  asked.length = 0
})

describe('an action that opts in to the judge', () => {
  it('needs a change input, and a tool never opts in', async () => {
    const r = await session('/v1/actions/no_change', { method: 'PUT', ...body({ title: 'x', backend: { type: 'caller' }, judge: true }) })
    expect(r.status).toBe(400)
    expect(JSON.stringify(await json(r))).toContain('judge: the judge routes a run by the change it states, so the action needs a change input')
  })

  it('sends the statement to the judge before the run is queued, and a route of no one queues it at once when the action asks no one', async () => {
    reply = answer({ to: 'no_one' })
    const r = await ask('open', statement)
    expect(asked).toEqual([{ url: 'http://judge.test/v1/judge', body: { statement } }])
    expect(r.state).toBe('queued')
    expect(r.routed).toEqual({ judge: JUDGE, route: { to: 'no_one' }, reasons: [{ effect: 0, rule: 'stops-in-place', proof: 'measured' }] })
    expect(r.routeAsks).toBeNull()
  })
})

describe('the judge only adds', () => {
  it('keeps a fixed approver when the judge says no one', async () => {
    reply = answer({ to: 'no_one' })
    const r = await ask('fixed', statement)
    expect(r.state).toBe('awaiting')
    expect(r.approvalsNeeded).toBe(1)
    // Someone outside the action's own approval cannot clear it, whatever the judge said.
    expect((await approve('sec', r.id)).status).toBe(403)
    const routed = await routedOf(r.id)
    expect(routed.judge).toEqual(JUDGE)
    expect(routed.route).toEqual({ to: 'people', grants: [{ values: ['lead'] }], quorum: 1 })
    expect(routed.reasons).toEqual([{ effect: 0, rule: 'stops-in-place', proof: 'measured' }, { rule: 'action-approval' }])
    expect(sentIssue(routed, statement)).toBeNull()
    expect((await json<ActionRun>(await approve('lead', r.id))).state).toBe('queued')
  })

  it('asks the route\'s people beside the action\'s own approvers, and both must say yes', async () => {
    reply = answer(toSec)
    const r = await ask('fixed', statement)
    expect(r).toMatchObject({ state: 'awaiting', approvalsNeeded: 1, routeAsks: { grants: [{ values: ['sec'] }], need: 1 } })
    const lead = await json<ActionRun>(await approve('lead', r.id))
    expect(lead.state).toBe('awaiting')
    expect(lead.approvedBy).toMatchObject([{ by: 'lead', for: ['action'] }])
    // The action's own approver is not one the route names, and their second yes adds nothing.
    expect((await approve('lead', r.id)).status).toBe(403)
    const done = await json<ActionRun>(await approve('sec', r.id))
    expect(done.state).toBe('queued')
    expect(done.approvedBy).toMatchObject([{ by: 'lead', for: ['action'] }, { by: 'sec', for: ['route'] }])
    const routed = await routedOf(r.id)
    expect(routed.route).toEqual({ to: 'people', grants: [{ values: ['sec'] }, { values: ['lead'] }], quorum: 1 })
    expect(sentIssue(routed, statement)).toBeNull()
  })

  it('holds a run only the route asks for for the people it names: not its asker, and no holder of actions.approve', async () => {
    reply = answer(toSec)
    const r = await ask('open', statement)
    expect(r).toMatchObject({ state: 'awaiting', approvalsNeeded: 0, heldFor: 'others' })
    const lead = await approve('lead', r.id)
    expect(lead.status).toBe(403)
    expect((await json<{ error: string }>(lead)).error).toBe('Only someone its route names decides what the route asks')
    expect((await session(`/v1/action-runs/${r.id}/approve`, { method: 'POST', ...body({}) })).status).toBe(403)
    expect((await json<ActionRun>(await approve('sec', r.id))).state).toBe('queued')
  })
})

describe('a route to people', () => {
  it('holds its own quorum on each run', async () => {
    reply = answer({ to: 'people', grants: [{ values: ['sec', 'sec2'] }], quorum: 2 })
    const two = await ask('open', statement)
    reply = answer(toSec)
    const one = await ask('open', statement)
    expect(two.routeAsks?.need).toBe(2)
    expect(one.routeAsks?.need).toBe(1)
    const first = await json<ActionRun>(await approve('sec', two.id))
    expect(first.state).toBe('awaiting')
    expect(first.log.at(-1)?.message).toContain('waiting for 1 more from the people its route names')
    expect((await json<ActionRun>(await approve('sec2', two.id))).state).toBe('queued')
    expect((await json<ActionRun>(await approve('sec', one.id))).state).toBe('queued')
  })

  it('is not started before its start, and says when it is due', async () => {
    reply = answer({ ...toSec, by: LATER, start: LATER })
    const r = await ask('open', statement)
    expect(r.routed?.route).toMatchObject({ to: 'people', by: LATER, start: LATER })
    const approved = await json<ActionRun>(await approve('sec', r.id))
    expect(approved.state).toBe('queued')
    expect(approved.retryAt).toBe(LATER)
    expect(approved.log.at(-1)?.message).toBe(`its route lets it start no earlier than ${LATER}: queued until then`)
    // Whoever does the work cannot start it early, and nothing hands it on before then.
    const early = await as('applier')(`/v1/action-runs/${r.id}/report`, { method: 'POST', ...body({ state: 'running' }) })
    expect(early.status).toBe(409)
    expect((await json<{ error: string }>(early)).error).toContain(`its route lets it start no earlier than ${LATER}`)
    await hub.actions.retryDue()
    expect((await runOf(r.id)).state).toBe('queued')
  })

  it('starts at once once approved when its start has passed', async () => {
    const past = new Date(Date.now() - 60_000).toISOString()
    reply = answer({ ...toSec, start: past })
    const r = await ask('open', statement)
    const approved = await json<ActionRun>(await approve('sec', r.id))
    expect(approved).toMatchObject({ state: 'queued', retryAt: null })
    expect((await as('applier')(`/v1/action-runs/${r.id}/report`, { method: 'POST', ...body({ state: 'running' }) })).status).toBe(200)
  })
})

describe('a draft', () => {
  it('is kept and shown, and never asks anyone', async () => {
    const draft = { pack: 'gate-next', route: toSec, reasons: [{ effect: 1, rule: 'grants-need-review', proof: 'claimed' }] }
    reply = answer({ to: 'no_one' }, { drafts: [draft] })
    const r = await ask('open', statement)
    expect(r.state).toBe('queued')
    expect(r.routeAsks).toBeNull()
    expect(r.routed?.drafts).toEqual([draft])
    expect((await routedOf(r.id)).drafts).toEqual([draft])
  })

  it('never lets a run go that its route holds', async () => {
    reply = answer(toSec, { drafts: [{ pack: 'gate-next', route: { to: 'no_one' } }] })
    const r = await ask('open', statement)
    expect(r.state).toBe('awaiting')
    expect(r.routeAsks).toEqual({ grants: [{ values: ['sec'] }], need: 1 })
  })
})

describe('the fences', () => {
  it('sends a run to people when the judge cannot be reached, with no judge on its route', async () => {
    reply = () => {
      throw new TypeError('fetch failed')
    }
    const r = await ask('open', statement)
    expect(r).toMatchObject({ state: 'awaiting', approvalsNeeded: 1, heldFor: 'others', routeAsks: null })
    const routed = await routedOf(r.id)
    expect(routed).not.toHaveProperty('judge')
    expect(routed.route).toEqual({ to: 'people', grants: [{ values: ['lead'] }], quorum: 1 })
    expect(routed.reasons).toEqual([{ fence: 'judge_down' }])
    expect(sentIssue(routed, statement)).toBeNull()
    expect((await json<ActionRun>(await approve('lead', r.id))).state).toBe('queued')
  })

  it('takes a refusal or a malformed answer as no answer', async () => {
    const answers = [
      () => Response.json({ error: 'bad_statement', reason: 'unknown kind' }, { status: 400 }),
      () => new Response('not json', { status: 200 }),
      answer({ to: 'no_one', grants: [{ values: ['sec'] }] }),
      answer({ to: 'people', quorum: 1 }),
      answer({ to: 'people', grants: [{ values: ['a=b'] }], quorum: 1 }),
      answer({ to: 'no_one' }, { reasons: [{ fence: 'asker' }] }),
      answer({ to: 'no_one' }, { reasons: [{ effect: 9, rule: 'x' }] }),
      () => Response.json({ route: { to: 'no_one' } }),
    ]
    for (const a of answers) {
      reply = a
      const r = await ask('open', statement)
      expect(r.state).toBe('awaiting')
      expect(r.routed).not.toHaveProperty('judge')
      expect(r.routed?.reasons).toEqual([{ fence: 'judge_down' }])
    }
  })

  it('refuses a route of no one for a change applied on the machine that asked', async () => {
    reply = answer({ to: 'no_one' })
    const r = await ask('open', { ...statement, applier: 'asker' })
    expect(r.state).toBe('awaiting')
    expect(r.routed?.judge).toEqual(JUDGE)
    expect(r.routed?.reasons).toContainEqual({ fence: 'asker' })
    expect(sentIssue(await routedOf(r.id), { ...statement, applier: 'asker' })).toBeNull()
  })

  it('refuses a route of no one for a part the writer could not name, or an effect with no proof', async () => {
    reply = answer({ to: 'no_one' })
    const parts = await ask('open', example.statement)
    expect(parts.state).toBe('awaiting')
    expect(parts.routed?.reasons).toContainEqual({ fence: 'unknown', part: 0 })
    reply = () => Response.json({ judge: JUDGE, route: { to: 'no_one' }, reasons: [{ effect: 1, proof: 'unknown' }] })
    const unproven = await ask('open', statement)
    expect(unproven.state).toBe('awaiting')
    expect(unproven.routed?.reasons).toContainEqual({ fence: 'unknown', effect: 1, proof: 'unknown' })
  })

  it('sends a run with no statement to people, without asking the judge', async () => {
    const r = await ask('optional')
    expect(asked).toEqual([])
    expect(r).toMatchObject({ state: 'awaiting', approvalsNeeded: 1, heldFor: 'others' })
    expect(r).not.toHaveProperty('routed')
  })
})

describe('an approval', () => {
  it('binds to the statement digest it was given for', async () => {
    reply = answer(toSec)
    const first = await ask('open', statement)
    const other = await ask('open', { ...statement, key: 'plan-8b1d' })
    // A different statement is a different run, with its own digest.
    expect(other.id).not.toBe(first.id)
    expect(other.statementDigest).not.toBe(first.statementDigest)
    const wrong = await approve('sec', first.id, other.statementDigest)
    expect(wrong.status).toBe(409)
    expect((await json<{ error: string }>(wrong)).error).toContain('a different statement is a different run')
    expect((await runOf(first.id)).approvedBy).toEqual([])
    const right = await json<ActionRun>(await approve('sec', first.id, first.statementDigest))
    expect(right.state).toBe('queued')
    expect(right.approvedBy).toMatchObject([{ by: 'sec', digest: first.statementDigest, for: ['route'] }])
  })
})

describe('a change set of judged runs', () => {
  it('asks each route of the people it names, as the set is decided', async () => {
    reply = answer(toSec)
    const created = await session('/v1/change-sets', { method: 'POST', ...body({ title: 'Two applies', items: [{ action: 'open', inputs: { plan: statement } }, { action: 'open', inputs: { plan: { ...statement, key: 'plan-9c2e' } } }] }) })
    expect(created.status).toBe(201)
    const set = (await json<{ id: string }>(created)).id
    expect(asked).toHaveLength(2)
    expect((await as('lead')(`/v1/change-sets/${set}/approve`, { method: 'POST', ...body({}) })).status).toBe(403)
    expect((await as('sec')(`/v1/change-sets/${set}/approve`, { method: 'POST', ...body({}) })).status).toBe(200)
    const runs = (await hub.db.query<{ state: string; route_asks: unknown }>('SELECT state, route_asks FROM action_runs WHERE change_set = $1', [set])).rows
    expect(runs.map((r) => r.state)).toEqual(['queued', 'queued'])
    expect(runs.map((r) => r.route_asks)).toEqual([{ grants: [{ values: ['sec'] }], need: 1 }, { grants: [{ values: ['sec'] }], need: 1 }])
  })
})
