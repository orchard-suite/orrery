import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { categoryOf } from '../shared/model.ts'
import { actingAs, record } from './activity.ts'
import { loadConfig } from './config.ts'
import { createHub, type Hub } from './hub.ts'
import { changeRecord, clip, AnnalsForwarder, toEvent, type AnnalsEvent } from './annals.ts'
import { decidedEvent, endedEvent, routedEvent, statedEvent } from './change-events.ts'
import type { ChangeStatement } from '../shared/change.ts'
import { createLogger } from './log.ts'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://orrery:orrery@localhost:5433/orrery'

let hub: Hub
let posts: AnnalsEvent[][] = []
let answer: number
let refuse = new Set<string>()

/** A stand-in Annals: it keeps what it is sent and answers each event with a receipt. */
const annalsFetch: typeof fetch = async (_url, init) => {
  if (answer !== 200) return new Response('down', { status: answer })
  const events = JSON.parse(String(init?.body)) as AnnalsEvent[]
  posts.push(events)
  return Response.json({ results: events.map((e, index) => (refuse.has(e.action.verb) ? { index, status: 'refused', reason: 'bad_verb' } : { index, status: 'stored' })) })
}

const forwarder = () => new AnnalsForwarder(hub.db, { url: 'http://annals.test/', token: 't' }, createLogger('annals-test'), annalsFetch)
const sent = () => posts.flat()
/** Makes every row so far a minute and more old, as if the forwarder ran later. */
const settle = () => hub.db.query(`UPDATE changes SET logged_at = clock_timestamp() - interval '2 minutes'`)

beforeAll(async () => {
  const config = loadConfig({ DATABASE_URL, DATA_DIR: mkdtempSync(join(tmpdir(), 'orrery-')), AUTH_MODE: 'none' })
  hub = await createHub(config, 'test', { reset: true })
})

afterAll(async () => {
  await hub.close()
})

beforeEach(async () => {
  await hub.db.query('DELETE FROM changes')
  await hub.db.query(`DELETE FROM settings WHERE key = 'annals.forwarded'`)
  posts = []
  answer = 200
  refuse = new Set()
})

describe('annals forwarding', () => {
  it('sends what people, tokens, and governance changes did, and leaves the inventory out', async () => {
    await actingAs({ kind: 'user', name: 'ada@example.org' }, async () => {
      await record(hub.db, 'action.requested', { blueprint: 'argocd_app', key: 'home/orrery' }, null, null, { action: 'deploy_orrery', run: 'r1', state: 'awaiting' })
      await record(hub.db, 'entity.updated', { blueprint: 'k8s_workload', key: 'home/x' }, null, null, { fields: ['owner'] })
    })
    await actingAs({ kind: 'user', name: 'bob@example.org' }, () => record(hub.db, 'action.approved', { blueprint: 'argocd_app', key: 'home/orrery' }, null, null, { action: 'deploy_orrery', run: 'r1', requestedBy: 'ada@example.org' }))
    await actingAs({ kind: 'token', name: 'beacon' }, () => record(hub.db, 'action.finished', null, null, null, { action: 'deploy_orrery', run: 'r1', state: 'failed', summary: 'the workflow\nfailed' }, new Date(), 'failed'))
    await actingAs({ kind: 'source', name: 'k8s@home' }, async () => {
      await record(hub.db, 'entity.updated', { blueprint: 'k8s_pod', key: 'p1' }, null, null, {})
      await record(hub.db, 'blueprint.changed', null, null, null, { blueprint: 'k8s_pod' })
    })
    await record(hub.db, 'run.committed', null, 'k8s@home', null, { run: 'x' })

    expect(await forwarder().pass()).toBe(5)
    const events = sent()
    expect(events.map((e) => e.action.verb)).toEqual(['action.requested', 'entity.updated', 'action.approved', 'action.finished', 'blueprint.changed'])
    const [requested, override, approved, finished, model] = events as [AnnalsEvent, AnnalsEvent, AnnalsEvent, AnnalsEvent, AnnalsEvent]
    expect(requested.actor).toEqual({ kind: 'person', id: 'ada@example.org', email: 'ada@example.org' })
    expect(requested.action.target).toEqual({ system: 'orrery', kind: 'argocd_app', id: 'home/orrery' })
    expect(requested.labels).toEqual({ category: 'actions', actor_kind: 'user', action: 'deploy_orrery' })
    expect(override.actor.id).toBe('ada@example.org')
    expect(approved.authority).toEqual({ approval: { required: true, by: 'bob@example.org', at: approved.at } })
    expect(finished.actor).toEqual({ kind: 'system', id: 'token:beacon' })
    expect(finished.action).toMatchObject({ outcome: 'failed', reason: 'the workflow failed', target: { kind: 'action_run', id: 'r1', title: 'deploy_orrery' } })
    expect(model.actor).toEqual({ kind: 'system', id: 'source:k8s@home' })
    expect(new Set(events.map((e) => e.event_key)).size).toBe(5)
  })

  it('posts a user that is not an address as a system, not a person', () => {
    const builtin = toEvent({ id: '9', at: new Date(0), kind: 'blueprint.changed', category: categoryOf('blueprint.changed'), outcome: 'ok', blueprint: 'sw_service', key: null, source: null, actor: 'builtin', actor_kind: 'user', detail: {} })
    expect(builtin.actor).toEqual({ kind: 'system', id: 'builtin' })
  })

  it('moves the mark only past rows a minute old, so a late commit is still sent', async () => {
    await actingAs({ kind: 'user', name: 'ada@example.org' }, () => record(hub.db, 'token.issued', null, null, null, { name: 'one' }))
    await forwarder().pass()
    await forwarder().pass()
    expect(sent().map((e) => e.event_key)).toHaveLength(2)
    expect(new Set(sent().map((e) => e.event_key)).size).toBe(1)

    await settle()
    posts = []
    await forwarder().pass()
    expect(sent()).toHaveLength(1)
    posts = []
    await actingAs({ kind: 'user', name: 'ada@example.org' }, () => record(hub.db, 'token.issued', null, null, null, { name: 'two' }))
    await forwarder().pass()
    expect(sent().map((e) => e.action.target.id)).toEqual(['two'])
  })

  it('moves the mark past rows it leaves out', async () => {
    for (let i = 0; i < 3; i++) await record(hub.db, 'run.committed', null, 'k8s@home', null, { run: `r${i}` })
    await settle()
    await forwarder().pass()
    const mark = await hub.db.query<{ value: { id: string } }>(`SELECT value FROM settings WHERE key = 'annals.forwarded'`)
    const newest = await hub.db.query<{ id: string }>('SELECT max(id) AS id FROM changes')
    expect(mark.rows[0]?.value.id).toBe(newest.rows[0]?.id)
    expect(sent()).toEqual([])
  })

  it('passes rows written before the log kept a clock time, by when they happened', async () => {
    // An hour ago by the database's clock, which decides what has settled; the test's own clock may differ from it.
    const hourAgo = (await hub.db.query<{ at: Date }>(`SELECT clock_timestamp() - interval '1 hour' AS at`)).rows[0]!.at
    await record(hub.db, 'run.committed', null, 'k8s@home', null, { run: 'old' }, hourAgo)
    await hub.db.query('UPDATE changes SET logged_at = NULL')
    await forwarder().pass()
    const mark = await hub.db.query<{ value: { id: string } }>(`SELECT value FROM settings WHERE key = 'annals.forwarded'`)
    const newest = await hub.db.query<{ id: string }>('SELECT max(id) AS id FROM changes')
    expect(mark.rows[0]?.value.id).toBe(newest.rows[0]?.id)
  })

  it('keeps the mark when Annals is down, and passes over an event it refused', async () => {
    await actingAs({ kind: 'user', name: 'ada@example.org' }, async () => {
      await record(hub.db, 'token.issued', null, null, null, { name: 'one' })
      await record(hub.db, 'secret.set', null, null, null, { name: 'github_token' })
    })
    await settle()
    answer = 503
    await expect(forwarder().pass()).rejects.toThrow(/503/)
    expect((await hub.db.query(`SELECT 1 FROM settings WHERE key = 'annals.forwarded'`)).rowCount).toBe(0)

    answer = 200
    refuse = new Set(['secret.set'])
    expect(await forwarder().pass()).toBe(1)
    posts = []
    expect(await forwarder().pass()).toBe(0)
    expect(sent()).toEqual([])
  })
})

describe('event targets', () => {
  const row = (kind: string, detail: Record<string, unknown>, extra: Partial<{ blueprint: string; source: string; outcome: 'ok' | 'failed' | 'refused' }> = {}) =>
    toEvent({ id: '1', at: new Date(0), kind, category: categoryOf(kind), outcome: extra.outcome ?? 'ok', blueprint: extra.blueprint ?? null, key: null, source: extra.source ?? null, actor: 'ada@example.org', actor_kind: 'user', detail })
  it('names what each kind of row is about', () => {
    expect(row('role.changed', { role: 'portal' }).action.target).toEqual({ system: 'orrery', kind: 'role', id: 'portal' })
    expect(row('token.revoked', { token: 'abc', name: 'myapps' }).action.target).toMatchObject({ kind: 'token', id: 'myapps' })
    expect(row('secret.set', { name: 'github_token' }).action.target).toMatchObject({ kind: 'secret', id: 'github_token' })
    expect(row('source.changed', { created: true }, { source: 'k8s@home' }).action.target).toMatchObject({ kind: 'source', id: 'k8s@home' })
    expect(row('blueprint.changed', {}, { blueprint: 'k8s_pod' }).action.target).toMatchObject({ kind: 'blueprint', id: 'k8s_pod' })
    expect(row('action.changed', { action: 'deploy' }).action.target).toMatchObject({ kind: 'action', id: 'deploy' })
    expect(row('access.refused', { viewAs: 'bob@example.org', reason: 'not an admin' }, { outcome: 'refused' }).action).toMatchObject({ target: { kind: 'access', id: 'bob@example.org' }, reason: 'not an admin' })
  })
  it('says what a backend answered when a run failed without a reason', () => {
    expect(row('action.finished', { action: 'build', run: 'r9', state: 'failed', status: 400 }, { outcome: 'failed' }).action).toMatchObject({ reason: 'answered 400', target: { kind: 'action_run', id: 'r9', title: 'build' } })
  })
  it('names the product that carried a person\'s request as the one that acted, for them', () => {
    expect(row('action.requested', { action: 'app_show', run: 'r1', tool: 'read', via: 'desk' }).actor).toEqual({ kind: 'system', id: 'token:desk', on_behalf_of: 'ada@example.org' })
    expect(row('action.requested', { action: 'app_show', run: 'r1', tool: 'read' }).actor).toEqual({ kind: 'person', id: 'ada@example.org', email: 'ada@example.org' })
  })
  it('counts a run sent back as a person\'s decision', () => {
    for (const kind of ['action.approved', 'action.declined', 'action.returned']) expect(row(kind, { action: 'lane', run: 'r2' }).authority).toEqual({ approval: { required: true, by: 'ada@example.org', at: new Date(0).toISOString() } })
    expect(row('action.requested', { action: 'lane', run: 'r2' }).authority).toBeUndefined()
  })
})

describe('clip', () => {
  it('keeps one line within the byte limit without cutting a character', () => {
    expect(clip('a\nb\r\nc', 512)).toBe('a b c')
    const long = clip('é'.repeat(400), 512)
    expect(new TextEncoder().encode(long).length).toBeLessThanOrEqual(512)
    expect(long).toBe('é'.repeat(256))
  })
})

describe('change records', () => {
  const statement = (JSON.parse(readFileSync(join(import.meta.dirname, '..', 'shared', 'change', 'examples', 'event-stated.json'), 'utf8')) as { statement: ChangeStatement }).statement
  const digest = 'sha256:631648276c5b93648131ddef01fe2882376e690c04284e39cb0a66c048381181'
  const at = new Date('2026-11-26T20:01:04Z')
  const target = { system: 'orrery', kind: 'change', id: 'r1.stated' }

  it('send a stated change with its actor, things, effects, and digest', () => {
    const e = changeRecord(statedEvent('r1', statement, digest, at))
    expect(e).toEqual({
      at: '2026-11-26T20:01:04.000Z',
      source: 'orrery',
      event_key: 'r1.stated',
      actor: { kind: 'agent', id: 'agent-1', on_behalf_of: 'user@example.com' },
      action: { verb: 'change.stated', target, outcome: 'ok' },
      items: [{ system: 'catalog', kind: 'workload', id: 'acme-api-prod' }],
      effects: [
        { kind: 'stops', subject: { blueprint: 'workload', key: 'acme-api-prod' }, path: 'in-place', size: 2, undo: 'yes', claim: 'writer' },
        { kind: 'grants', subject: { blueprint: 'workload', key: 'acme-api-prod' }, path: 'in-place', size: 1, undo: 'yes', claim: 'writer' },
      ],
      change: { after_hash: digest },
      labels: { applier: 'hub', writer: 'infra' },
    })
    expect(e.cause).toBeUndefined()
  })

  it('send the route, each answer, and the end as caused by the stated change', () => {
    const routed = changeRecord(routedEvent({ id: 'r1', action: 'apply' }, digest, at, '2.2.0', [{ values: ['user@example.com'] }], 1))
    expect(routed).toMatchObject({ event_key: 'r1.routed', actor: { kind: 'system', id: 'orrery' }, action: { verb: 'change.routed', target, outcome: 'ok' }, cause: 'r1.stated', cause_source: 'orrery', change: { after_hash: digest }, labels: { route: 'people', quorum: '1', judge: 'orrery', pack: 'action.apply' } })
    expect(changeRecord(routedEvent({ id: 'r1', action: 'apply' }, digest, at, '2.2.0', null, 1)).labels).toEqual({ route: 'no_one', quorum: '0', judge: 'orrery', pack: 'action.apply' })
    const decided = changeRecord(decidedEvent('r1', digest, at, 2, 'user@example.com', 'no'))
    expect(decided).toMatchObject({ event_key: 'r1.decided.2', actor: { kind: 'person', id: 'user@example.com', email: 'user@example.com' }, action: { verb: 'change.decided', target, outcome: 'ok' }, cause: 'r1.stated', labels: { answer: 'no' } })
    expect(decided.items).toBeUndefined()
    const ended = changeRecord(endedEvent('r1', digest, at, 'ok', 'matched', []))
    expect(ended).toMatchObject({ event_key: 'r1.ended', actor: { kind: 'system', id: 'orrery' }, action: { verb: 'change.ended', target, outcome: 'ok' }, cause: 'r1.stated', labels: { check: 'matched' } })
    expect(ended.action.reason).toBeUndefined()
    const refused = changeRecord(endedEvent('r1', digest, at, 'refused', 'differed', ['artifact', 'effects']), 'the applier refused it')
    expect(refused.action).toEqual({ verb: 'change.ended', target, outcome: 'refused', reason: 'the applier refused it; it differed in artifact, effects' })
    expect(refused.labels).toEqual({ check: 'differed' })
  })

  it('are read from the activity rows that carry them', () => {
    const event = endedEvent('r1', digest, at, 'failed', 'unchecked', [])
    const e = toEvent({ id: '7', at, kind: 'change.ended', category: categoryOf('change.ended'), outcome: 'failed', blueprint: null, key: null, source: null, actor: null, actor_kind: 'hub', detail: { action: 'apply', run: 'r1', reason: 'the run failed', event } })
    expect(categoryOf('change.ended')).toBe('actions')
    expect(e).toMatchObject({ event_key: 'r1.ended', action: { outcome: 'failed', reason: 'the run failed' } })
  })
})
