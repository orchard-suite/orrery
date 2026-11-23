// An action a person runs on themselves: on their own person entity alone,
// with where they call from read by the hub, never taken from the form.

import { mkdtempSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { checkAction } from '../shared/action-spec.ts'
import type { ActionTargetsResponse, WhoAmIResponse } from '../shared/api.ts'
import type { ActionRun, Entity } from '../shared/model.ts'
import { loadConfig } from './config.ts'
import { createHub, type Hub } from './hub.ts'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://orrery:orrery@localhost:5433/orrery'

let hub: Hub
let pusher = ''
let token = ''
let asker = ''
let hook: Server
let hookUrl = ''
let received: Record<string, unknown>[] = []

const as = (email: string, groups = 'User') => (path: string, init?: RequestInit): Promise<Response> => Promise.resolve(hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', 'x-forwarded-email': email, 'x-forwarded-groups': groups, ...init?.headers } }, { surface: 'session' }))
const admin = as('admin@example.org', 'Admin')
const ada = as('ada@example.org')
const bob = as('bob@example.org')
const cy = as('cy@example.org')
const machine = (path: string, init?: RequestInit, bearer = pusher) => hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}`, ...init?.headers } }, { surface: 'machine' })
const json = async <T = Record<string, unknown>>(r: Response): Promise<T> => (await r.json()) as T
const body = (v: unknown) => ({ body: JSON.stringify(v) })
const from = (address: string) => ({ 'x-real-ip': address })
const targets = async (who: typeof ada, action: string) => (await json<ActionTargetsResponse>(await who(`/v1/actions/${action}/targets`))).entities.map((e) => e.id).sort()
const actionsOn = async (who: typeof ada, id: string) => (await json<Entity>(await who(`/v1/entities/${id.replace(':', '/')}`))).actions ?? []
const last = () => received.at(-1) as { by: Record<string, unknown>; inputs: Record<string, unknown> }

beforeAll(async () => {
  const config = loadConfig({ DATABASE_URL, DATA_DIR: mkdtempSync(join(tmpdir(), 'orrery-')), AUTH_MODE: 'proxy', PUBLIC_URL: 'https://hub.example.org' })
  hub = await createHub(config, 'test', { reset: true })
  await hub.sources.save('people@hr', { title: 'people', class: 'pusher', blueprints: ['*'], deleteGrant: [], cadence: '3m' })
  pusher = (await hub.sources.issueToken('source', 'people', { source: 'people@hr' })).token
  const root = { admin: true, permissions: [] as never[], kind: 'user' as const, name: 'admin@example.org', roles: [] }
  await hub.access.saveRole('asker', { title: 'Asker', permissions: ['actions.ask'] }, root)
  token = (await hub.sources.issueToken('access', 'bot', { role: 'viewer' })).token
  asker = (await hub.sources.issueToken('access', 'portal', { role: 'asker' })).token
  const save = (id: string, spec: Record<string, unknown>) => admin(`/v1/blueprints/${id}`, { method: 'PUT', ...body(spec) })
  expect((await save('person', { title: 'Person', fields: { email: { type: 'email' } }, relations: {} })).status).toBe(200)
  expect((await save('laptop', { title: 'Laptop', fields: { owner_email: { type: 'email' } }, relations: { holder: { target: 'person' } } })).status).toBe(200)
  expect((await admin('/v1/access/person', { method: 'PUT', ...body({ blueprint: 'person', field: 'email' }) })).status).toBe(200)
  // Ada, Bob, and the admin each have a person entity; Cy signs in and has none.
  for (const [key, email] of [['ada', 'ada@example.org'], ['bob', 'bob@example.org'], ['root', 'admin@example.org']]) await machine(`/v1/ingest/entities/person/${key}`, { method: 'PUT', ...body({ title: key, fields: { email } }) })
  await machine('/v1/ingest/entities/laptop/l-ada', { method: 'PUT', ...body({ title: "Ada's laptop", fields: { owner_email: 'ada@example.org' }, relations: { holder: 'ada' } }) })
  await machine('/v1/ingest/entities/laptop/l-bob', { method: 'PUT', ...body({ title: "Bob's laptop", fields: { owner_email: 'bob@example.org' }, relations: { holder: 'bob' } }) })
  hook = createServer((req, res) => {
    let text = ''
    req.on('data', (chunk: Buffer) => (text += chunk.toString()))
    req.on('end', () => {
      if (req.method !== 'POST') return void res.writeHead(404).end()
      received.push(JSON.parse(text) as Record<string, unknown>)
      res.writeHead(202).end()
    })
  })
  await new Promise<void>((r) => hook.listen(0, '127.0.0.1', r))
  hookUrl = `http://127.0.0.1:${(hook.address() as { port: number }).port}`
  const define = async (id: string, spec: Record<string, unknown>) => {
    const res = await admin(`/v1/actions/${id}`, { method: 'PUT', ...body(spec) })
    expect(res.status, await res.clone().text()).toBe(200)
  }
  // Records where a person is, for a backend to allow later: only on their own person, prefilled with the address the hub read.
  await define('allow_my_network', { title: 'Allow my network', blueprint: 'person', self: true, access: { everyone: true }, inputs: { address: { type: 'string', required: true, default: '{{ by.address }}' } }, backend: { type: 'webhook', url: hookUrl } })
  // The same address read with no entity, for the callers a self action never takes.
  await define('note_address', { title: 'Note where I am', access: { everyone: true }, inputs: { address: { type: 'string', default: '{{ by.address }}' } }, backend: { type: 'webhook', url: hookUrl } })
  // A rule that lets a person act on their own person entity, and one that asks for what is theirs in any way.
  await define('describe_myself', { title: 'Describe myself', blueprint: 'person', access: { rules: [{ owns: ['self'] }] }, inputs: {}, backend: { type: 'webhook', url: hookUrl } })
  await define('anything_mine', { title: 'Anything of mine', blueprint: 'person', access: { rules: [{ owns: true }] }, inputs: {}, backend: { type: 'webhook', url: hookUrl } })
  // `@me` in an action's own filter and in a rule's: the caller's own entity as a relation's target, their address as a field's value.
  await define('reset_my_laptop', { title: 'Reset my laptop', blueprint: 'laptop', where: { relation: 'holder', target: '@me' }, access: { everyone: true }, inputs: {}, backend: { type: 'webhook', url: hookUrl } })
  await define('lock_my_laptop', { title: 'Lock my laptop', blueprint: 'laptop', access: { rules: [{ where: { field: 'owner_email', op: 'eq', value: '@me' } }] }, inputs: {}, backend: { type: 'webhook', url: hookUrl } })
})

afterAll(async () => {
  hook.close()
  await hub.close()
})

describe('where the caller is, in an action', () => {
  it('tells a signed-in person where the hub reads them calling from, to fill the form', async () => {
    expect((await json<WhoAmIResponse>(await ada('/v1/whoami', { headers: from('203.0.113.7') }))).address).toBe('203.0.113.7')
    // A header the hub does not trust is one a caller could forge: it is never read.
    expect((await json<WhoAmIResponse>(await ada('/v1/whoami', { headers: { 'x-forwarded-for': '198.51.100.4' } }))).address).toBeUndefined()
    // A machine is given none.
    expect((await json<WhoAmIResponse>(await machine('/v1/whoami', { headers: from('203.0.113.7') }, token))).address).toBeUndefined()
  })

  it('fills by.address on a run a person asks for themselves, read from the request', async () => {
    received = []
    const res = await ada('/v1/actions/allow_my_network/run', { method: 'POST', headers: from('203.0.113.7'), ...body({ entity: { blueprint: 'person', key: 'ada' }, inputs: {} }) })
    expect(res.status, await res.clone().text()).toBe(201)
    const run = await json<ActionRun>(res)
    expect(run).toMatchObject({ inputs: { address: '203.0.113.7' }, byAddress: '203.0.113.7' })
    expect(last().by).toEqual({ name: 'ada@example.org', address: '203.0.113.7' })
    expect(last().inputs).toEqual({ address: '203.0.113.7' })
  })

  it('keeps a value the person typed over it, and records that it differs from the address the hub read', async () => {
    received = []
    const run = await json<ActionRun>(await ada('/v1/actions/allow_my_network/run', { method: 'POST', headers: from('203.0.113.7'), ...body({ entity: { blueprint: 'person', key: 'ada' }, inputs: { address: '198.51.100.4' } }) }))
    expect(run.inputs).toEqual({ address: '198.51.100.4' })
    expect(run.byAddress).toBe('203.0.113.7')
    expect(run.log.map((l) => l.message)).toContain('input "address" differs from what the hub filled in for whoever asked: 203.0.113.7 filled in, 198.51.100.4 sent')
    // The backend reads both: what was typed, and where the hub read the person calling from.
    expect(last()).toMatchObject({ by: { address: '203.0.113.7' }, inputs: { address: '198.51.100.4' } })
    const changes = await json<{ changes: { detail: Record<string, unknown> }[] }>(await admin('/v1/changes?kind=action.requested'))
    expect(changes.changes.find((c) => c.detail.run === run.id)?.detail.differs).toEqual(['address'])
    // The same value as the hub read is no difference.
    const same = await json<ActionRun>(await ada('/v1/actions/allow_my_network/run', { method: 'POST', headers: from('203.0.113.7'), ...body({ entity: { blueprint: 'person', key: 'ada' }, inputs: { address: '203.0.113.7' } }) }))
    expect(same.log.some((l) => l.message.includes('differs'))).toBe(false)
  })

  it('gives no address to a machine, to a product asking for a person, or to a schedule', async () => {
    received = []
    const tokenRun = await json<ActionRun>(await machine('/v1/actions/note_address/run', { method: 'POST', headers: from('203.0.113.7'), ...body({ inputs: {} }) }, token))
    expect(tokenRun).toMatchObject({ inputs: { address: null }, byAddress: null })
    expect(last().by).toEqual({ name: 'bot' })
    const forAda = await machine('/v1/actions/note_address/run', { method: 'POST', headers: from('203.0.113.7'), ...body({ for: 'ada@example.org', inputs: {} }) }, asker)
    expect(forAda.status, await forAda.clone().text()).toBe(201)
    expect(await json<ActionRun>(forAda)).toMatchObject({ by: 'ada@example.org', byAddress: null, inputs: { address: null } })
    expect(last().by).toEqual({ name: 'ada@example.org' })
    // A schedule fires with nobody at a browser: the address reads nothing, whoever set it up and wherever from.
    const later = await ada('/v1/schedules', { method: 'POST', headers: from('203.0.113.7'), ...body({ action: 'note_address', title: 'Later', cadence: { every: 'once', on: new Date(Date.now() + 3_600_000).toISOString(), tz: 'UTC' } }) })
    expect(later.status, await later.clone().text()).toBe(201)
    const schedule = await json<{ id: string }>(later)
    await hub.db.query(`UPDATE action_schedules SET next_at = now() - interval '1 minute' WHERE id = $1`, [schedule.id])
    expect(await hub.schedules.due()).toBe(1)
    const fired = await hub.db.query<{ by_address: string | null; inputs: Record<string, unknown> }>('SELECT by_address, inputs FROM action_runs WHERE schedule = $1', [schedule.id])
    expect(fired.rows).toEqual([{ by_address: null, inputs: { address: null } }])
    expect(last().by).toEqual({ name: 'ada@example.org' })
  })
})

describe('an action on the caller themselves', () => {
  it('runs only on their own person, and shows on no one else\'s page', async () => {
    expect(await targets(ada, 'allow_my_network')).toEqual(['person:ada'])
    expect(await targets(bob, 'allow_my_network')).toEqual(['person:bob'])
    expect(await actionsOn(ada, 'person:ada')).toContain('allow_my_network')
    expect(await actionsOn(ada, 'person:bob')).not.toContain('allow_my_network')
    // Asked for on someone else, it is refused as a run on nothing is.
    const other = await ada('/v1/actions/allow_my_network/run', { method: 'POST', headers: from('203.0.113.7'), ...body({ entity: { blueprint: 'person', key: 'bob' }, inputs: {} }) })
    expect(other.status).toBe(400)
    expect((await json<{ error: string }>(other)).error).toContain('cannot run on person:bob')
  })

  it('binds an admin too: they see it on their own person alone', async () => {
    expect(await targets(admin, 'allow_my_network')).toEqual(['person:root'])
    expect(await actionsOn(admin, 'person:root')).toContain('allow_my_network')
    expect(await actionsOn(admin, 'person:ada')).not.toContain('allow_my_network')
    expect((await admin('/v1/actions/allow_my_network/run', { method: 'POST', headers: from('203.0.113.7'), ...body({ entity: { blueprint: 'person', key: 'ada' }, inputs: {} }) })).status).toBe(400)
  })

  it('runs on nothing for someone the catalog holds no person for', async () => {
    expect(await targets(cy, 'allow_my_network')).toEqual([])
  })

  it('is refused on a blueprint that is not a person, and in a batch', () => {
    const base = { title: 'x', self: true, inputs: {}, backend: { type: 'webhook', url: 'https://hooks.example.org/x' } }
    expect(checkAction({ ...base, id: 'a', blueprint: 'laptop' }, undefined, 'person').issues.map((i) => i.message)).toContain("self: it runs on the caller's own person, so its blueprint is person, the one the estate says a person is")
    expect(checkAction({ ...base, id: 'b', blueprint: 'person' }, undefined, null).issues.map((i) => i.path.join('.'))).toEqual(['self'])
    expect(checkAction({ ...base, id: 'c', blueprint: 'person', batch: { max: 5 } }, undefined, 'person').issues.map((i) => i.path.join('.'))).toEqual(['batch'])
    expect(checkAction({ ...base, id: 'd', blueprint: 'person' }, undefined, 'person').issues).toEqual([])
  })
})

describe('the self role in an action rule', () => {
  it('lets a person in on their own person entity alone', async () => {
    expect(await targets(ada, 'describe_myself')).toEqual(['person:ada'])
    expect(await targets(bob, 'describe_myself')).toEqual(['person:bob'])
    expect(await actionsOn(ada, 'person:bob')).not.toContain('describe_myself')
    const listed = await json<{ actions: { id: string; canRun: boolean }[] }>(await cy('/v1/actions'))
    expect(listed.actions.find((a) => a.id === 'describe_myself')?.canRun ?? false).toBe(false)
  })

  it('is no part of what is theirs in any way: only a rule that names it counts it', async () => {
    expect(await targets(ada, 'anything_mine')).toEqual([])
  })
})

describe('@me in an action\'s filters', () => {
  it("reads the caller's own entity as a relation's target in the action's filter, for an admin too", async () => {
    expect(await targets(ada, 'reset_my_laptop')).toEqual(['laptop:l-ada'])
    expect(await targets(bob, 'reset_my_laptop')).toEqual(['laptop:l-bob'])
    expect(await targets(admin, 'reset_my_laptop')).toEqual([])
    expect(await targets(cy, 'reset_my_laptop')).toEqual([])
    expect(await actionsOn(ada, 'laptop:l-ada')).toContain('reset_my_laptop')
    expect((await ada('/v1/actions/reset_my_laptop/run', { method: 'POST', ...body({ entity: { blueprint: 'laptop', key: 'l-bob' }, inputs: {} }) })).status).toBe(400)
    expect((await ada('/v1/actions/reset_my_laptop/run', { method: 'POST', ...body({ entity: { blueprint: 'laptop', key: 'l-ada' }, inputs: {} }) })).status).toBe(201)
  })

  it("reads the caller's address as a field's value in a rule's filter", async () => {
    expect(await targets(ada, 'lock_my_laptop')).toEqual(['laptop:l-ada'])
    expect(await targets(bob, 'lock_my_laptop')).toEqual(['laptop:l-bob'])
  })
})
