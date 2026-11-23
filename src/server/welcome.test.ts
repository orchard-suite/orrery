import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ChangesResponse, TokenIssued } from '../shared/api.ts'
import type { PreferenceValues } from '../shared/preferences.ts'
import type { WelcomeDef, WelcomeResponse } from '../shared/welcome.ts'
import { applyCatalog } from './catalog.ts'
import { loadConfig } from './config.ts'
import { createHub, type Hub } from './hub.ts'

// Its own database: these tests open a preview and set a tour, which every other test would then read.
const DATABASE_URL = (process.env.DATABASE_URL ?? 'postgres://orrery:orrery@localhost:5433/orrery') + '_welcome'

let hub: Hub

const as = (email: string, groups = 'User') => (path: string, init?: RequestInit) =>
  hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', 'x-forwarded-email': email, 'x-forwarded-groups': groups, ...init?.headers } }, { surface: 'session' })
const bearer = (token: string) => (path: string, init?: RequestInit) => hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...init?.headers } }, { surface: 'machine' })
const json = async <T = Record<string, unknown>>(r: Response): Promise<T> => (await r.json()) as T
const put = (v: unknown) => ({ method: 'PUT', body: JSON.stringify(v) })
const post = (v: unknown) => ({ method: 'POST', body: JSON.stringify(v) })

const admin = as('admin@example.org', 'Admin')
const ada = as('ada@example.org')
const bob = as('bob@example.org')

const tour = async (who = ada) => json<WelcomeResponse>(await who('/v1/welcome'))
const ids = (t: WelcomeResponse) => t.steps.map((s) => s.id)
const prefs = async (who = ada, init?: RequestInit) => (await json<{ preferences: PreferenceValues }>(await who('/v1/mine/preferences', init))).preferences
const setTour = async (def: Partial<WelcomeDef>) => {
  const saved = await admin('/v1/access/welcome', put(def))
  expect(saved.status).toBe(200)
  return (await json<{ welcome: WelcomeDef }>(saved)).welcome
}

beforeAll(async () => {
  const pg = await import('pg').then(({ default: m }) => new m.Client({ connectionString: DATABASE_URL.replace(/\/[^/]+$/, '/postgres') }))
  await pg.connect()
  await pg.query(`DROP DATABASE IF EXISTS ${DATABASE_URL.split('/').pop()}`)
  await pg.query(`CREATE DATABASE ${DATABASE_URL.split('/').pop()}`)
  await pg.end()
  hub = await createHub(loadConfig({ DATABASE_URL, DATA_DIR: mkdtempSync(join(tmpdir(), 'orrery-')), AUTH_MODE: 'proxy' }), 'test', { reset: true })
  await Promise.all([ada('/v1/whoami'), bob('/v1/whoami')])
})

afterAll(async () => {
  await hub.close()
})

describe('a person’s preferences', () => {
  it('read as their fallbacks until set, and keep what is set for that person alone', async () => {
    expect(await prefs()).toEqual({ welcomed: 0, release: null, timeZone: null })
    const set = await ada('/v1/mine/preferences/release', put({ value: '1.50.0' }))
    expect(set.status).toBe(200)
    expect((await json<{ preferences: PreferenceValues }>(set)).preferences).toEqual({ welcomed: 0, release: '1.50.0', timeZone: null })
    expect(await prefs()).toEqual({ welcomed: 0, release: '1.50.0', timeZone: null })
    expect(await prefs(bob)).toEqual({ welcomed: 0, release: null, timeZone: null })
  })

  it('refuse a name the registry does not hold and a value the preference does not take', async () => {
    expect((await ada('/v1/mine/preferences/theme', put({ value: 'dark' }))).status).toBe(404)
    expect((await ada('/v1/mine/preferences/release', put({ value: 'latest' }))).status).toBe(400)
    expect((await ada('/v1/mine/preferences/welcomed', put({ value: -1 }))).status).toBe(400)
    expect((await ada('/v1/mine/preferences/timeZone', put({ value: 'Mars/Olympus' }))).status).toBe(400)
    expect(await prefs()).toEqual({ welcomed: 0, release: '1.50.0', timeZone: null })
  })

  it('write no activity row', async () => {
    const count = async () => (await json<ChangesResponse>(await admin('/v1/changes?limit=200'))).changes.length
    const before = await count()
    await ada('/v1/mine/preferences/welcomed', put({ value: 2 }))
    expect(await count()).toBe(before)
  })

  it('are a person’s: a personal token is the person, and a machine token keeps none', async () => {
    const personal = bearer((await json<TokenIssued>(await ada('/v1/me/tokens', post({ name: 'agent' })))).token)
    expect((await json<{ preferences: PreferenceValues }>(await personal('/v1/mine/preferences'))).preferences.release).toBe('1.50.0')
    const machine = bearer((await json<TokenIssued>(await admin('/v1/tokens', post({ kind: 'access', name: 'portal', role: 'admin' })))).token)
    expect((await machine('/v1/mine/preferences')).status).toBe(403)
    expect((await machine('/v1/mine/preferences/welcomed', put({ value: 1 }))).status).toBe(403)
  })

  it('read as the person an admin views as, and set none of theirs', async () => {
    const viewing = { headers: { 'x-orrery-view-as': 'ada@example.org' } }
    expect(await prefs(admin, viewing)).toEqual({ welcomed: 2, release: '1.50.0', timeZone: null })
    expect((await admin('/v1/mine/preferences/welcomed', { ...put({ value: 9 }), ...viewing })).status).toBe(403)
    expect(await prefs()).toEqual({ welcomed: 2, release: '1.50.0', timeZone: null })
  })
})

describe('the welcome tour', () => {
  it('is not there to a caller outside its preview', async () => {
    for (const path of ['/v1/welcome', '/v1/access/welcome']) expect((await admin(path)).status).toBe(404)
    expect((await admin('/v1/access/previews', put({ welcome: { open: 'people', people: ['ada@example.org', 'admin@example.org'] } }))).status).toBe(200)
    expect((await ada('/v1/welcome')).status).toBe(200)
    expect((await bob('/v1/welcome')).status).toBe(404)
  })

  it('on a hub with nothing modelled leaves out every step that shows the catalog or an action', async () => {
    const t = await tour()
    expect(t.version).toBe(1)
    expect(ids(t)).toEqual(['hello', 'nav', 'verdict', 'sky', 'needs', 'find', 'selfservice', 'account', 'done'])
    expect(t.steps[0]).toMatchObject({ to: { page: 'now' }, spot: null, title: 'Welcome to Orrery' })
  })

  it('opens the first catalog the reader sees, and the first action they may run, when the estate picks none', async () => {
    const save = async (spec: Record<string, unknown>) => expect((await admin(`/v1/blueprints/${String(spec.id)}`, put(spec))).status).toBe(200)
    await save({ id: 'vault', title: 'Vault', fields: {}, relations: {}, access: { grants: [{ values: ['bob@example.org'] }] } })
    await save({ id: 'service', title: 'Service', fields: {}, relations: {} })
    expect((await admin('/v1/entities', post({ blueprint: 'service', key: 'checkout', title: 'Checkout' }))).status).toBe(201)
    expect((await admin('/v1/entities', post({ blueprint: 'vault', key: 'keys', title: 'Keys' }))).status).toBe(201)
    expect((await admin('/v1/actions/restart', put({ title: 'Restart a service', inputs: {}, backend: { type: 'caller' }, access: { everyone: true } }))).status).toBe(200)
    const t = await tour()
    expect(ids(t)).toEqual(['hello', 'nav', 'verdict', 'sky', 'needs', 'find', 'grid', 'kinds', 'selfservice', 'action', 'account', 'done'])
    expect(t.steps.find((s) => s.id === 'grid')).toMatchObject({ to: { page: 'inventory', blueprint: 'service' }, spot: 'catalog.grid' })
    expect(t.steps.find((s) => s.id === 'grid')?.text).toContain('every Service')
    expect(t.steps.find((s) => s.id === 'action')).toMatchObject({ to: { page: 'actions', id: 'restart' } })
    expect(t.steps.find((s) => s.id === 'action')?.text).toContain('Restart a service')
  })

  it('shows the estate’s picks and words, and never one the reader may not see', async () => {
    const saved = await setTour({ version: 2, blueprint: 'vault', example: 'keys', steps: { hello: { title: 'Welcome to the platform' }, needs: { shown: false } } })
    expect(saved).toEqual({ version: 2, blueprint: 'vault', example: 'keys', steps: { hello: { title: 'Welcome to the platform' }, needs: { shown: false } } })
    // Ada may not see the vault: her tour opens the catalog she does see, and shows no entity of the vault.
    const theirs = await tour()
    expect(theirs.version).toBe(2)
    expect(theirs.steps[0]?.title).toBe('Welcome to the platform')
    expect(ids(theirs)).not.toContain('needs')
    expect(ids(theirs)).not.toContain('entity')
    expect(theirs.steps.find((s) => s.id === 'grid')?.to).toEqual({ page: 'inventory', blueprint: 'service' })
    expect(JSON.stringify(theirs)).not.toMatch(/vault|Keys/)

    await setTour({ version: 2, blueprint: 'service', example: 'checkout', steps: { grid: { text: 'Every {{ blueprint }} the platform runs.' } } })
    const t = await tour()
    expect(t.steps.find((s) => s.id === 'grid')?.text).toBe('Every Service the platform runs.')
    expect(t.steps.find((s) => s.id === 'entity')).toMatchObject({ to: { page: 'entity', blueprint: 'service', key: 'checkout' } })
    expect(t.steps.find((s) => s.id === 'entity')?.text).toContain('Checkout')
  })

  it('is an admin’s to set, checked, and each change is an activity row', async () => {
    expect((await ada('/v1/access/welcome', put({ version: 3 }))).status).toBe(403)
    expect((await admin('/v1/access/welcome', put({ version: 3, steps: { nowhere: { title: 'x' } } }))).status).toBe(400)
    expect((await admin('/v1/access/welcome', put({ version: 0 }))).status).toBe(400)
    const before = (await json<ChangesResponse>(await admin('/v1/changes?kind=welcome.changed'))).changes.length
    await setTour({ version: 2, blueprint: 'service', example: 'checkout', steps: { grid: { text: 'Every {{ blueprint }} the platform runs.' } } })
    expect((await json<ChangesResponse>(await admin('/v1/changes?kind=welcome.changed'))).changes.length).toBe(before)
    await setTour({ version: 3 })
    expect((await json<ChangesResponse>(await admin('/v1/changes?kind=welcome.changed'))).changes.length).toBe(before + 1)
  })

  it('is owned by a git source while it declares it, and left to an admin when it stops', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orrery-welcome-'))
    const source = await hub.sources.save('estate', { title: 'Estate', class: 'git', blueprints: ['*'], deleteGrant: [], cadence: null, git: { url: 'https://example.org/estate.git', branch: 'main', glob: '**/*.yaml' } })
    writeFileSync(join(dir, 'welcome.yaml'), 'config:\n  welcome:\n    version: 4\n    blueprint: service\n    actions: [restart]\n')
    expect((await applyCatalog(hub, source, dir, '**/*.yaml')).errors).toEqual([])
    expect((await json<{ welcome: WelcomeDef }>(await admin('/v1/access/welcome'))).welcome).toEqual({ version: 4, blueprint: 'service', actions: ['restart'], source: 'estate' })
    expect((await admin('/v1/access/welcome', put({ version: 5 }))).status).toBe(409)
    expect((await tour()).version).toBe(4)

    writeFileSync(join(dir, 'welcome.yaml'), 'config:\n  welcome:\n    version: 4\n    steps: { nowhere: {} }\n')
    expect((await applyCatalog(hub, source, dir, '**/*.yaml')).errors.map((e) => e.reason)).toEqual([expect.stringContaining('config.welcome')])

    writeFileSync(join(dir, 'welcome.yaml'), 'entities: []\n')
    expect((await applyCatalog(hub, source, dir, '**/*.yaml')).errors).toEqual([])
    expect((await json<{ welcome: WelcomeDef }>(await admin('/v1/access/welcome'))).welcome).toEqual({ version: 4, blueprint: 'service', actions: ['restart'] })
    await setTour({ version: 5 })
  })

  it('shows each reader the first action they may run of those the estate ranks, and tells one who may run none how they get one', async () => {
    const action = async (id: string, spec: Record<string, unknown>) => expect((await admin(`/v1/actions/${id}`, put({ inputs: {}, backend: { type: 'caller' }, ...spec }))).status).toBe(200)
    const step = async (who: typeof ada, id: string) => (await tour(who)).steps.find((s) => s.id === id)
    expect((await admin('/v1/access/previews', put({ welcome: { open: 'people', people: ['ada@example.org', 'bob@example.org', 'admin@example.org'] } }))).status).toBe(200)
    await action('purge', { title: 'Purge a cache', access: { grants: [{ values: ['bob@example.org'] }] } })
    expect(await setTour({ version: 5, actions: ['purge', 'restart', 'purge'], steps: { hello: { empty: 'not a step that has these' } } })).toEqual({ version: 5, actions: ['purge', 'restart'] })
    expect((await step(bob, 'action'))?.to).toEqual({ page: 'actions', id: 'purge' })
    expect((await step(ada, 'action'))?.to).toEqual({ page: 'actions', id: 'restart' })
    expect((await step(ada, 'selfservice'))?.text).toContain('Pick an action')

    // A page one release back sends the one action it knows, and it goes first.
    expect((await json<{ welcome: WelcomeDef }>(await admin('/v1/access/welcome', put({ version: 5, action: 'restart', actions: ['purge'] })))).welcome).toEqual({ version: 5, actions: ['restart', 'purge'] })

    // Ada may run nothing now: no action is shown her, and Self-service tells her how she gets one.
    await action('restart', { title: 'Restart a service', access: {} })
    expect(ids(await tour())).not.toContain('action')
    expect((await step(ada, 'selfservice'))?.text).toContain('You have no actions yet')
    expect((await step(bob, 'selfservice'))?.text).toContain('Pick an action')
    await setTour({ version: 5, steps: { selfservice: { empty: 'Ask the platform team in #platform for access.' } } })
    expect((await step(ada, 'selfservice'))?.text).toBe('Ask the platform team in #platform for access.')
    await action('restart', { title: 'Restart a service', access: { everyone: true } })
  })

  it('is read again by another hub on the same database', async () => {
    await hub.db.query(`UPDATE settings SET value = $1 WHERE key = 'welcome'`, [JSON.stringify({ version: 7 })])
    await hub.welcome.load()
    expect((await tour()).version).toBe(7)
  })
})
