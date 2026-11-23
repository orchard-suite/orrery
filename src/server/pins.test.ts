import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { ActionSummariesResponse, ActionsResponse, ChangesResponse, PinsResponse, TokenIssued } from '../shared/api.ts'
import { MOST_PINS, type Pin } from '../shared/model.ts'
import { loadConfig } from './config.ts'
import { createHub, type Hub } from './hub.ts'

// Its own database: these tests sign people in and open actions to them, which every other test would then read.
const DATABASE_URL = (process.env.DATABASE_URL ?? 'postgres://orrery:orrery@localhost:5433/orrery') + '_pins'

let hub: Hub

const PERSON = 'user@example.com'
const OTHER = 'other@example.com'

const as = (email: string, groups = 'User') => (path: string, init?: RequestInit) =>
  hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', 'x-forwarded-email': email, 'x-forwarded-groups': groups, ...init?.headers } }, { surface: 'session' })
const bearer = (token: string) => (path: string, init?: RequestInit) => hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...init?.headers } }, { surface: 'machine' })
const json = async <T = Record<string, unknown>>(r: Response): Promise<T> => (await r.json()) as T
const put = (v?: unknown) => ({ method: 'PUT', ...(v === undefined ? {} : { body: JSON.stringify(v) }) })
const viewing = (email: string) => ({ headers: { 'x-orrery-view-as': email } })

const admin = as('admin@example.com', 'Admin')
const person = as(PERSON)
const other = as(OTHER)

type Caller = (path: string, init?: RequestInit) => Response | Promise<Response>
const pinned = async (who: Caller, init?: RequestInit) => (await json<PinsResponse>(await who('/v1/mine/pins', init))).pins.map((p) => p.id)
const pin = (who: Caller, id: string) => who(`/v1/mine/pins/action/${id}`, put())
const unpin = (who: Caller, id: string) => who(`/v1/mine/pins/action/${id}`, { method: 'DELETE' })
const kept = async (email: string) => (await hub.db.query<{ id: string }>('SELECT id FROM pins WHERE person = $1 ORDER BY position, created_at', [email])).rows.map((r) => r.id)
/** An action whoever asks does themselves, open to everyone unless `access` says otherwise. */
const action = async (id: string, access: Record<string, unknown> = { everyone: true }) => expect((await admin(`/v1/actions/${id}`, put({ title: id, inputs: {}, backend: { type: 'caller' }, access }))).status).toBe(200)

beforeAll(async () => {
  const pg = await import('pg').then(({ default: m }) => new m.Client({ connectionString: DATABASE_URL.replace(/\/[^/]+$/, '/postgres') }))
  await pg.connect()
  await pg.query(`DROP DATABASE IF EXISTS ${DATABASE_URL.split('/').pop()}`)
  await pg.query(`CREATE DATABASE ${DATABASE_URL.split('/').pop()}`)
  await pg.end()
  hub = await createHub(loadConfig({ DATABASE_URL, DATA_DIR: mkdtempSync(join(tmpdir(), 'orrery-')), AUTH_MODE: 'proxy' }), 'test', { reset: true })
  for (const id of ['restart', 'deploy', 'rotate', 'gated']) await action(id)
  // Everyone has signed in once.
  await Promise.all([person('/v1/whoami'), other('/v1/whoami')])
})

afterAll(async () => {
  await hub.close()
})

beforeEach(async () => {
  await hub.db.query('DELETE FROM pins')
})

describe("a person's pins", () => {
  it('are kept in the order they were pinned, and pinning twice changes nothing', async () => {
    expect(await pinned(person)).toEqual([])
    expect((await pin(person, 'restart')).status).toBe(200)
    expect((await pin(person, 'deploy')).status).toBe(200)
    expect((await pin(person, 'restart')).status).toBe(200)
    expect(await pinned(person)).toEqual(['restart', 'deploy'])
    expect((await json<PinsResponse>(await person('/v1/mine/pins'))).pins[0]).toEqual({ kind: 'action', id: 'restart' } satisfies Pin)
    expect(await kept(PERSON)).toEqual(['restart', 'deploy'])
  })

  it('are theirs alone', async () => {
    await pin(person, 'restart')
    await pin(other, 'deploy')
    expect(await pinned(person)).toEqual(['restart'])
    expect(await pinned(other)).toEqual(['deploy'])
  })

  it('are let go one at a time, and letting go of what is not pinned changes nothing', async () => {
    await pin(person, 'restart')
    await pin(person, 'deploy')
    expect((await unpin(person, 'restart')).status).toBe(200)
    expect((await unpin(person, 'restart')).status).toBe(200)
    expect(await pinned(person)).toEqual(['deploy'])
  })

  it('are put in a new order, the ones not named keeping theirs after the rest', async () => {
    for (const id of ['restart', 'deploy', 'rotate', 'gated']) await pin(person, id)
    const res = await person('/v1/mine/pins', put({ order: [{ kind: 'action', id: 'rotate' }, { kind: 'action', id: 'restart' }, { kind: 'action', id: 'never_pinned' }] }))
    expect(res.status).toBe(200)
    expect((await json<PinsResponse>(res)).pins.map((p) => p.id)).toEqual(['rotate', 'restart', 'deploy', 'gated'])
    expect(await pinned(person)).toEqual(['rotate', 'restart', 'deploy', 'gated'])
    // One pinned after a new order goes last.
    await unpin(person, 'deploy')
    await pin(person, 'deploy')
    expect(await pinned(person)).toEqual(['rotate', 'restart', 'gated', 'deploy'])
  })

  it(`stop at ${MOST_PINS}`, async () => {
    await hub.db.query(`INSERT INTO pins (person, kind, id, position) SELECT $1, 'action', 'gone_' || n, n FROM generate_series(1, $2::int) AS n`, [PERSON, MOST_PINS - 1])
    expect((await pin(person, 'restart')).status).toBe(200)
    const full = await pin(person, 'deploy')
    expect(full.status).toBe(409)
    expect((await json<{ error: string }>(full)).error).toContain(String(MOST_PINS))
    // What is already pinned is still answered as pinned.
    expect((await pin(person, 'restart')).status).toBe(200)
    expect((await kept(PERSON)).length).toBe(MOST_PINS)
  })

  it('take only an action the person is shown, and only a kind the hub pins', async () => {
    expect((await pin(person, 'no_such_action')).status).toBe(404)
    // A blueprint is a kind the hub pins, but there is no blueprint by that name.
    expect((await person('/v1/mine/pins/blueprint/restart', put())).status).toBe(404)
    expect((await person('/v1/mine/pins/report/restart', put())).status).toBe(404)
    expect((await person('/v1/mine/pins', put({ order: [{ kind: 'report', id: 'restart' }] }))).status).toBe(400)
    expect(await kept(PERSON)).toEqual([])
  })

  it('write no activity', async () => {
    const rows = async () => (await json<ChangesResponse>(await admin('/v1/changes?limit=200'))).changes.length
    const before = await rows()
    await pin(person, 'restart')
    await person('/v1/mine/pins', put({ order: [{ kind: 'action', id: 'restart' }] }))
    await unpin(person, 'restart')
    expect(await rows()).toBe(before)
  })
})

describe('a pin to an action the person may no longer use', () => {
  it('is kept and not shown, and shows again when the action is theirs again', async () => {
    await pin(person, 'gated')
    await pin(person, 'restart')
    expect(await pinned(person)).toEqual(['gated', 'restart'])
    // An admin closes the action to everyone but admins.
    await action('gated', {})
    expect(await pinned(person)).toEqual(['restart'])
    expect(await kept(PERSON)).toEqual(['gated', 'restart'])
    expect((await pin(person, 'gated')).status).toBe(404)
    await action('gated')
    expect(await pinned(person)).toEqual(['gated', 'restart'])
  })

  it('is kept while the action is gone', async () => {
    await action('passing')
    await pin(person, 'passing')
    expect((await admin('/v1/actions/passing', { method: 'DELETE' })).status).toBe(200)
    expect(await pinned(person)).toEqual([])
    expect(await kept(PERSON)).toEqual(['passing'])
    await action('passing')
    expect(await pinned(person)).toEqual(['passing'])
    await admin('/v1/actions/passing', { method: 'DELETE' })
  })
})

describe('who pins', () => {
  it('is a person, signed in or calling with their own token', async () => {
    const issued = await json<TokenIssued>(await person('/v1/me/tokens', { method: 'POST', body: JSON.stringify({ name: 'agent' }) }))
    const agent = bearer(issued.token)
    await pin(person, 'restart')
    expect(await pinned(agent)).toEqual(['restart'])
    expect((await pin(agent, 'deploy')).status).toBe(200)
    expect(await pinned(person)).toEqual(['restart', 'deploy'])
  })

  it('is never a machine', async () => {
    await hub.access.saveRole('reader', { title: 'Reader', permissions: ['actions.list'] }, { admin: true, permissions: [] })
    const machine = bearer((await hub.sources.issueToken('access', 'machine', { role: 'reader' })).token)
    expect((await machine('/v1/mine/pins')).status).toBe(403)
    expect((await pin(machine, 'restart')).status).toBe(403)
    expect((await unpin(machine, 'restart')).status).toBe(403)
    expect((await machine('/v1/mine/pins', put({ order: [] }))).status).toBe(403)
    await hub.sources.save('pusher', { title: 'Pusher', class: 'pusher', blueprints: [], deleteGrant: [], cadence: null })
    const source = bearer((await hub.sources.issueToken('source', 'pusher', { source: 'pusher' })).token)
    expect((await source('/v1/mine/pins')).status).toBe(403)
    expect((await pin(source, 'restart')).status).toBe(403)
    expect((await hub.db.query('SELECT 1 FROM pins')).rowCount).toBe(0)
  })

  it('is never an admin viewing as them: the pins are read and not changed', async () => {
    await pin(person, 'restart')
    await pin(admin, 'deploy')
    expect(await pinned(admin, viewing(PERSON))).toEqual(['restart'])
    expect((await admin('/v1/mine/pins/action/deploy', { ...put(), ...viewing(PERSON) })).status).toBe(403)
    expect((await admin('/v1/mine/pins/action/restart', { method: 'DELETE', ...viewing(PERSON) })).status).toBe(403)
    expect((await admin('/v1/mine/pins', { ...put({ order: [] }), ...viewing(PERSON) })).status).toBe(403)
    expect(await kept(PERSON)).toEqual(['restart'])
    expect(await pinned(admin)).toEqual(['deploy'])
  })
})

describe('an action as a person gets it', () => {
  it('says whether they pinned it', async () => {
    await pin(person, 'restart')
    const listed = (await json<ActionsResponse>(await person('/v1/actions'))).actions
    expect(listed.find((a) => a.id === 'restart')?.pinned).toBe(true)
    expect(listed.find((a) => a.id === 'deploy')?.pinned).toBe(false)
    expect((await json<ActionsResponse>(await other('/v1/actions'))).actions.find((a) => a.id === 'restart')?.pinned).toBe(false)
    expect((await json<{ pinned?: boolean }>(await person('/v1/actions/restart'))).pinned).toBe(true)
  })

  it('says it to a portal that asks for them, and to their agent', async () => {
    await pin(person, 'restart')
    await hub.access.saveRole('portal', { title: 'Portal', permissions: ['actions.list'] }, { admin: true, permissions: [] })
    const portal = bearer((await hub.sources.issueToken('access', 'portal', { role: 'portal' })).token)
    const forPerson = (await json<ActionSummariesResponse>(await portal(`/v1/actions?for=${encodeURIComponent(PERSON)}`))).actions
    expect(forPerson.find((a) => a.id === 'restart')?.pinned).toBe(true)
    expect(forPerson.find((a) => a.id === 'deploy')?.pinned).toBe(false)
    // A machine has no pins of its own: its list says nothing of them.
    expect((await json<ActionsResponse>(await portal('/v1/actions'))).actions.every((a) => a.pinned === undefined)).toBe(true)

    const issued = await json<TokenIssued>(await person('/v1/me/tokens', { method: 'POST', body: JSON.stringify({ name: 'mcp' }) }))
    const rpc = async (method: string, params: Record<string, unknown>, id = 1) => {
      const res = await bearer(issued.token)('/mcp', { method: 'POST', headers: { accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) })
      const text = await res.text()
      const line = text.split('\n').find((l) => l.startsWith('data:'))
      return JSON.parse(line ? line.slice(5) : text) as { result: { content: { text: string }[] } }
    }
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } })
    const listed = JSON.parse((await rpc('tools/call', { name: 'list_actions', arguments: {} }, 2)).result.content[0]!.text) as { id: string; pinned?: boolean }[]
    expect(listed.find((a) => a.id === 'restart')).toMatchObject({ pinned: true })
    expect(listed.find((a) => a.id === 'deploy')).toMatchObject({ pinned: false })
    // Read in full, an action also names its picture.
    const full = JSON.parse((await rpc('tools/call', { name: 'list_actions', arguments: { action: 'restart' } }, 3)).result.content[0]!.text) as { pinned?: boolean; iconShown?: string }
    expect(full).toMatchObject({ pinned: true, iconShown: 'rocket' })
  })
})
