import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ChangeEvent, ChangeStatement } from '../shared/change.ts'
import type { ActionRun } from '../shared/model.ts'
import { loadConfig } from './config.ts'
import { DispatchChanges } from './dispatch-changes.ts'
import { createHub, type Hub } from './hub.ts'
import { createLogger } from './log.ts'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://orrery:orrery@localhost:5433/orrery'
const statement = (JSON.parse(readFileSync(join(import.meta.dirname, '..', 'shared', 'change', 'examples', 'event-stated.json'), 'utf8')) as { statement: ChangeStatement }).statement

let hub: Hub
const runs: ActionRun[] = []

const json = async <T = Record<string, unknown>>(r: Response): Promise<T> => (await r.json()) as T
const body = (v: unknown) => ({ body: JSON.stringify(v) })
const session = (path: string, init?: RequestInit) => Promise.resolve(hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', 'x-forwarded-email': 'admin@example.com', 'x-forwarded-groups': 'Admin', ...init?.headers } }, { surface: 'session' }))

/** A desk that answers each post as `answer` says, and keeps what it took. */
function desk(answer: (events: ChangeEvent[]) => Response) {
  const posts: ChangeEvent[][] = []
  const kept: ChangeEvent[] = []
  const post: typeof fetch = async (url, init) => {
    expect(String(url)).toBe('http://dispatch.example/v1/change-events')
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer desk-token')
    const { events } = JSON.parse(String(init?.body)) as { events: ChangeEvent[] }
    posts.push(events)
    const res = answer(events)
    if (res.status === 200) kept.push(...events)
    return res
  }
  return { posts, kept, forwarder: new DispatchChanges(hub.db, { url: 'http://dispatch.example/', token: 'desk-token' }, createLogger('dispatch-changes'), post) }
}
const ok = (events: ChangeEvent[]) => new Response(JSON.stringify({ kept: events.length }), { status: 200 })
/** Every row reads as settled, so a pass moves its mark past all of them. */
const settle = () => hub.db.query(`UPDATE changes SET logged_at = now() - interval '5 minutes', at = now() - interval '5 minutes'`)

beforeAll(async () => {
  const config = loadConfig({ DATABASE_URL, DATA_DIR: mkdtempSync(join(tmpdir(), 'orrery-')), AUTH_MODE: 'proxy', PUBLIC_URL: 'https://hub.example.com' })
  hub = await createHub(config, '9.9.9', { reset: true })
  expect((await session('/v1/actions/apply_now', { method: 'PUT', ...body({ title: 'Apply', backend: { type: 'caller' }, inputs: { plan: { type: 'change', required: true } } }) })).status).toBe(200)
  for (const key of ['plan-a', 'plan-b']) runs.push(await json<ActionRun>(await session('/v1/actions/apply_now/run', { method: 'POST', ...body({ inputs: { plan: { ...statement, key } } }) })))
})

afterAll(async () => {
  await hub.close()
})

describe('change events carried to the dispatch desk', () => {
  it('wait in the log while the desk does not take them, and go once it does', async () => {
    const missing = desk(() => new Response('404 page not found', { status: 404 }))
    await expect(missing.forwarder.pass()).rejects.toThrow('dispatch answered 404')
    // A 400 that names no event is no refusal of one: the events wait too.
    const unready = desk(() => new Response('{"error":"bad body"}', { status: 400 }))
    await expect(unready.forwarder.pass()).rejects.toThrow('named no event it refuses')
    await settle()
    await expect(missing.forwarder.pass()).rejects.toThrow()

    const ready = desk(ok)
    expect(await ready.forwarder.pass()).toBe(4)
    expect(ready.kept.map((e) => e.key)).toEqual(runs.flatMap((r) => [`${r.id}.stated`, `${r.id}.routed`]))
    expect(ready.kept[0]).toMatchObject({ event: 'change.stated', sender: 'orrery', statement: { key: 'plan-a' } })
    // Past the mark, nothing is sent again, by this forwarder or the next.
    expect(await ready.forwarder.pass()).toBe(0)
    const next = desk(ok)
    expect(await next.forwarder.pass()).toBe(0)
    expect(next.posts).toEqual([])
  })

  it('split a refused batch in halves, so only the event the desk cannot take is passed over', async () => {
    await hub.db.query(`DELETE FROM settings WHERE key = 'dispatch.change-events.forwarded'`)
    const bad = `${runs[1]!.id}.stated`
    const picky = desk((events) => {
      const index = events.findIndex((e) => e.key === bad)
      return index < 0 ? ok(events) : new Response(JSON.stringify({ error: 'refused', index }), { status: 400 })
    })
    expect(await picky.forwarder.pass()).toBe(3)
    expect(picky.kept.map((e) => e.key)).not.toContain(bad)
    expect(picky.posts.map((p) => p.length)).toEqual([4, 2, 2, 1, 1])
  })
})
