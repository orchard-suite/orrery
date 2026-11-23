import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadConfig } from './config.ts'
import { createHub, type Hub } from './hub.ts'
import { Jobs } from './jobs.ts'
import { Leadership } from './leader.ts'
import { createLogger } from './log.ts'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://orrery:orrery@localhost:5433/orrery'
const config = () => loadConfig({ DATABASE_URL, DATA_DIR: mkdtempSync(join(tmpdir(), 'orrery-')), AUTH_MODE: 'none' })

// Two hubs on one database, as during a rollout: the old one still serving, the new one beside it.
let old: Hub
let next: Hub

beforeAll(async () => {
  old = await createHub(config(), '1.0.0', { reset: true })
  next = await createHub(config(), '1.1.0')
})

afterAll(async () => {
  await old.close()
  await next.close()
})

const session = (hub: Hub, path: string) => hub.app.request(path, {}, { surface: 'session' })

describe('a hub beside another, as in a rollout', () => {
  it('sees what the other hub changed once it catches up', async () => {
    await old.blueprints.save({ id: 'rollout_gizmo', title: 'Gizmo', fields: { size: { type: 'number' } } }, { kind: 'ui' }, 'test', async () => [])
    expect(next.blueprints.get('rollout_gizmo')).toBeUndefined()
    await next.catchUp()
    expect(next.blueprints.get('rollout_gizmo')?.title).toBe('Gizmo')
  })

  it('is ready as soon as it listens: derived state lives in the database, not in a warm-up', async () => {
    expect((await session(old, '/readyz')).status).toBe(200)
    expect((await session(old, '/healthz')).status).toBe(200)
  })

  it('stops asking for traffic as it drains, and keeps answering', async () => {
    expect((await session(next, '/readyz')).status).toBe(200)
    old.drain()
    expect((await session(old, '/readyz')).status).toBe(503)
    expect((await session(old, '/healthz')).status).toBe(200)
    expect((await session(old, '/v1/blueprints')).status).toBe(200)
  })

  it('opens the event stream with its version, and ends it as it stops', async () => {
    const res = await session(next, '/v1/events')
    const reader = res.body!.getReader()
    const first = new TextDecoder().decode((await reader.read()).value)
    expect(first).toContain('event: hello')
    expect(first).toContain('"version":"1.1.0"')
    next.events.end()
    let done = false
    for (let i = 0; i < 10 && !done; i++) done = (await reader.read()).done
    expect(done).toBe(true)
  })
})

describe('the leader lock', () => {
  it('lets one hub lead, and passes to the next when it lets go', async () => {
    const led: string[] = []
    const first = new Leadership({ url: DATABASE_URL }, createLogger('leader'), 50)
    const second = new Leadership({ url: DATABASE_URL }, createLogger('leader'), 50)
    first.start({ lead: async () => void led.push('first'), follow: async () => void led.push('first follows') })
    for (let i = 0; i < 100 && !first.isLeader; i++) await sleep(10)
    second.start({ lead: async () => void led.push('second'), follow: async () => void led.push('second follows') })
    await sleep(300)
    expect(first.isLeader).toBe(true)
    expect(second.isLeader).toBe(false)
    await first.stop()
    for (let i = 0; i < 100 && !second.isLeader; i++) await sleep(10)
    expect(second.isLeader).toBe(true)
    await second.stop()
    expect(led).toEqual(['first', 'first follows', 'second', 'second follows'])
  })
})

describe('background jobs', () => {
  it('runs each pass once at a time, and stops only once the running pass is done', async () => {
    const jobs = new Jobs(createLogger('jobs'))
    let running = 0
    let most = 0
    let finished = 0
    jobs.add('slow', 10, async () => {
      running++
      most = Math.max(most, running)
      await sleep(100)
      running--
      finished++
    })
    jobs.start()
    await sleep(50)
    await jobs.stop()
    expect(most).toBe(1)
    expect(finished).toBe(1)
    expect(running).toBe(0)
  })

  it('runs the first passes one after another, in the order the jobs were added', async () => {
    const jobs = new Jobs(createLogger('jobs'))
    const order: string[] = []
    for (const name of ['git', 'checks', 'lifecycle']) {
      jobs.add(name, 10_000, async () => {
        order.push(`${name} starts`)
        await sleep(30)
        order.push(`${name} ends`)
      })
    }
    jobs.start()
    await sleep(150)
    await jobs.stop()
    expect(order).toEqual(['git starts', 'git ends', 'checks starts', 'checks ends', 'lifecycle starts', 'lifecycle ends'])
  })

  it('leaves the first passes still waiting their turn once stopped', async () => {
    const jobs = new Jobs(createLogger('jobs'))
    const ran: string[] = []
    jobs.add('slow', 10_000, async () => {
      ran.push('slow')
      await sleep(100)
    })
    jobs.add('after', 10_000, async () => void ran.push('after'))
    jobs.start()
    await sleep(20)
    await jobs.stop()
    await sleep(120)
    expect(ran).toEqual(['slow'])
  })
})

describe('hubs that serve side by side for good, an API hub and a worker', () => {
  const until = async (what: () => boolean): Promise<void> => {
    for (let i = 0; i < 100 && !what(); i++) await sleep(20)
    expect(what()).toBe(true)
  }

  it('reads again what the other hub changed, as soon as it changed', async () => {
    await old.bridge.start()
    await next.bridge.start()
    await old.blueprints.save({ id: 'rollout_widget', title: 'Widget', fields: {} }, { kind: 'ui' }, 'test', async () => [])
    await until(() => next.blueprints.get('rollout_widget')?.title === 'Widget')
    await next.sources.save('rollout-pusher', { title: 'Rollout pusher', class: 'pusher', blueprints: ['rollout_widget'], deleteGrant: [], cadence: null })
    await until(() => old.sources.get('rollout-pusher') !== undefined)
  })

  it('hears the events the other hub emits, after it has read again what changed before them', async () => {
    const heard: string[] = []
    const stop = next.events.subscribe((event) => {
      if (event.type === 'estate') heard.push(`${event.blueprints?.join(',')} widget2:${next.blueprints.get('rollout_widget2') !== undefined}`)
    })
    const echoed: string[] = []
    const stopOwn = old.events.onHeard((event) => echoed.push(event.type))
    await old.blueprints.save({ id: 'rollout_widget2', title: 'Widget 2', fields: {} }, { kind: 'ui' }, 'test', async () => [])
    old.events.emit({ type: 'estate', blueprints: ['rollout_widget2'] })
    await until(() => heard.length === 1)
    expect(heard).toEqual(['rollout_widget2 widget2:true'])
    expect(echoed).toEqual([])
    stop()
    stopOwn()
  })

  it('says when a snapshot the other hub committed last saw an entity', async () => {
    const token = (await old.sources.issueToken('source', 'rollout pusher', { source: 'rollout-pusher' })).token
    const machine = (path: string, init: RequestInit) => old.app.request(path, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` } }, { surface: 'machine' })
    const run = (await (await machine('/v1/ingest/runs', { method: 'POST', body: JSON.stringify({ mode: 'snapshot', scope: 'bench' }) })).json()) as { id: string }
    expect((await machine(`/v1/ingest/runs/${run.id}/entities`, { method: 'PUT', body: JSON.stringify({ entities: [{ blueprint: 'rollout_widget', key: 'w1', title: 'W1' }] }) })).status).toBe(200)
    expect((await machine(`/v1/ingest/runs/${run.id}/commit`, { method: 'POST' })).status).toBe(200)
    const seen = async (hub: Hub) => ((await (await session(hub, '/v1/entities/rollout_widget/w1')).json()) as { lastSeenAt: string }).lastSeenAt
    const committed = await seen(old)
    for (let i = 0; i < 100 && (await seen(next)) !== committed; i++) await sleep(20)
    expect(await seen(next)).toBe(committed)
  })

  it('says the same of what a source wrote, once the hub that took the writes has stored them', async () => {
    const wrote = (hub: Hub) => hub.writes.of('rollout-pusher').entities.find((e) => e.blueprint === 'rollout_widget')
    expect(wrote(old)?.count).toBe(1)
    await old.writes.flush()
    await until(() => wrote(next)?.count === 1)
    expect(wrote(next)).toEqual(wrote(old))
  })
})
