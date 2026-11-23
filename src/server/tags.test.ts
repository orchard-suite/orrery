import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadConfig } from './config.ts'
import { createHub, type Hub } from './hub.ts'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://orrery:orrery@localhost:5433/orrery'
const config = () => loadConfig({ DATABASE_URL, DATA_DIR: mkdtempSync(join(tmpdir(), 'orrery-')), AUTH_MODE: 'none' })

// Two hubs on one database, as a rollout runs them, hearing each other through the bridge.
let one: Hub
let two: Hub

const ask = (on: Hub, path: string, tag?: string | null) => Promise.resolve(on.app.request(path, { headers: { 'content-type': 'application/json', ...(tag ? { 'if-none-match': tag } : {}) } }, { surface: 'session' }))
const write = (on: Hub, method: string, path: string, body: unknown) => Promise.resolve(on.app.request(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, { surface: 'session' }))
const SHELVES = '/v1/entities?blueprint=shelf&limit=50'

/** Starts a hub as `main.ts` does: it hears the others, then shares its tags. */
async function started(fresh = false): Promise<Hub> {
  const hub = await createHub(config(), 'test', { reset: fresh })
  await hub.bridge.start()
  await hub.lists.start(hub.events)
  return hub
}

/** Waits until a hub has heard what the other said: an event crosses the bridge in a moment. */
async function heard(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 100 && !(await check()); i++) await new Promise((r) => setTimeout(r, 50))
  expect(await check()).toBe(true)
}

beforeAll(async () => {
  one = await started(true)
  for (const [id, spec] of [
    ['shelf', { title: 'Shelf', fields: { aisle: { type: 'number' } } }],
    ['crate', { title: 'Crate', fields: { size: { type: 'number' } }, relations: { shelf: { target: 'shelf' } } }],
  ] as const)
    expect((await write(one, 'PUT', `/v1/blueprints/${id}`, spec)).status).toBe(200)
  expect((await write(one, 'POST', '/v1/entities', { blueprint: 'shelf', key: 'top', title: 'Top', fields: { aisle: 1 } })).status).toBe(201)
  expect((await write(one, 'POST', '/v1/entities', { blueprint: 'crate', key: 'c1', title: 'C1', fields: { size: 1 }, relations: { shelf: 'top' } })).status).toBe(201)
  two = await started()
})

afterAll(async () => {
  await two?.close()
  await one.close()
})

describe('list tags', () => {
  it('names a list the same on every hub, so either answers the other’s tag as unchanged', async () => {
    await heard(async () => (await ask(one, SHELVES)).headers.get('etag') === (await ask(two, SHELVES)).headers.get('etag'))
    const tag = (await ask(one, SHELVES)).headers.get('etag')
    expect((await ask(two, SHELVES, tag)).status).toBe(304)
    expect((await ask(one, SHELVES, tag)).status).toBe(304)
  })

  it('leaves a list standing when only a value of what sits beside its rows moves, and moves it when a title does', async () => {
    const tag = (await ask(one, SHELVES)).headers.get('etag')
    expect((await write(one, 'PATCH', '/v1/entities/crate/c1', { fields: { size: 2 } })).status).toBe(200)
    await one.deriver.drain()
    expect((await ask(one, SHELVES, tag)).status).toBe(304)
    expect((await write(one, 'PATCH', '/v1/entities/crate/c1', { fields: { title: 'Crate one' } })).status).toBe(200)
    expect((await ask(one, SHELVES, tag)).status).toBe(200)
    // The other hub hears it, and names the list as moved too.
    await heard(async () => (await ask(two, SHELVES, tag)).status === 200)
  })

  it('answers no tag named before a hub started as unchanged, there or anywhere, then agrees again', async () => {
    const tag = (await ask(one, SHELVES)).headers.get('etag')
    expect((await ask(one, SHELVES, tag)).status).toBe(304)
    await two.lists.store()
    await two.close()
    two = await started()
    // What the new hub missed while it was away is older than its start: no tag named before it holds.
    expect((await ask(two, SHELVES, tag)).status).toBe(200)
    await heard(async () => (await ask(one, SHELVES, tag)).status === 200)
    const after = (await ask(two, SHELVES)).headers.get('etag')
    expect((await ask(one, SHELVES, after)).status).toBe(304)
  })
})
