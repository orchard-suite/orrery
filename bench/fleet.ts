// The fleet benchmark: hubs as separate processes on one database, as a
// deployment scaled out runs them. Serving hubs take the pushes and the
// reads; worker hubs derive. It pushes an estate through the serving hubs in
// turn, times how long the workers take to derive it, and checks that every
// serving hub answers the same, that a change made through one shows through
// the others, that a preview opened on one is open on the others, and that a
// budget set on one is held by the others. Prints one JSON line last.
//
//   LOG_LEVEL=error FLEET_API=2 FLEET_WORKERS=4 BENCH_SCALE=3 node bench/fleet.ts
//
// It uses its own database, `orrery_fleet` beside DATABASE_URL's, and empties it.

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import pg from 'pg'
import { loadConfig } from '../src/server/config.ts'
import { loadFixtureCatalog } from '../src/server/fixtures/load.ts'
import { createHub } from '../src/server/hub.ts'
import { estate, type Push } from './estate.ts'

const BASE_URL = process.env.DATABASE_URL ?? 'postgres://orrery:orrery@localhost:5433/orrery'
const SCALE = Number(process.env.BENCH_SCALE ?? 1)
const SERVING = Number(process.env.FLEET_API ?? 2)
const WORKERS = Number(process.env.FLEET_WORKERS ?? 2)
const PORT = Number(process.env.FLEET_PORT ?? 28500)
/** How many readers ask at once while a push is derived. */
const READERS = Number(process.env.FLEET_READERS ?? 8)

const metrics: Record<string, number> = {}
const checks: Record<string, boolean> = {}

async function freshDatabase(): Promise<string> {
  const url = new URL(BASE_URL)
  const admin = new pg.Client({ connectionString: BASE_URL })
  await admin.connect()
  await admin.query('DROP DATABASE IF EXISTS orrery_fleet WITH (FORCE)')
  await admin.query('CREATE DATABASE orrery_fleet')
  await admin.end()
  url.pathname = '/orrery_fleet'
  return url.toString()
}

const percentile = (times: number[], p: number) => [...times].sort((a, b) => a - b)[Math.min(times.length - 1, Math.floor(times.length * p))] ?? 0

async function main(): Promise<void> {
  const database = await freshDatabase()
  const dataDir = mkdtempSync(join(tmpdir(), 'orrery-fleet-'))
  // The model, a source, and its token are put in place by a hub in this process, which then lets go.
  const setup = await createHub(loadConfig({ DATABASE_URL: database, DATA_DIR: dataDir, AUTH_MODE: 'none' }), 'fleet')
  const report = await loadFixtureCatalog(setup)
  if (report.errors.length) throw new Error(`catalog: ${JSON.stringify(report.errors)}`)
  await setup.rules.settled()
  await setup.sources.save('bench', { title: 'bench', class: 'pusher', blueprints: ['*'], deleteGrant: [], cadence: null })
  const pusher = (await setup.sources.issueToken('source', 'bench', { source: 'bench' })).token
  const reader = (await setup.sources.issueToken('access', 'reader', { role: 'viewer' })).token
  await setup.deriver.backfill()
  await setup.close()

  const db = new pg.Pool({ connectionString: database, max: 2 })
  const hubs: { role: string; port: number; child: ChildProcess }[] = []
  const start = (role: 'api' | 'worker', index: number) => {
    const port = PORT + hubs.length * 2
    const child = spawn(process.execPath, [resolve(import.meta.dirname, '../src/server/main.ts')], {
      env: { ...process.env, DATABASE_URL: database, DATA_DIR: dataDir, AUTH_MODE: 'none', ROLE: role, PORT: String(port), INGEST_PORT: String(port + 1), LOG_LEVEL: process.env.LOG_LEVEL ?? 'error', GIT_POLL_MINUTES: '20000', DRAIN_SECONDS: '0', STOP_SECONDS: '2', OTEL_SDK_DISABLED: 'true', HOSTNAME: `${role}-${index}` },
      stdio: ['ignore', 'inherit', 'inherit'],
    })
    hubs.push({ role, port, child })
  }
  for (let i = 0; i < SERVING; i++) start('api', i)
  for (let i = 0; i < WORKERS; i++) start('worker', i)
  const serving = hubs.filter((h) => h.role === 'api')
  const stop = async () => {
    for (const h of hubs) h.child.kill('SIGTERM')
    await Promise.all(hubs.map((h) => new Promise((done) => h.child.once('exit', done))))
    await db.end()
  }

  try {
    for (const h of hubs) {
      for (let i = 0; ; i++) {
        const ok = await fetch(`http://127.0.0.1:${h.port}/readyz`).then((r) => r.ok, () => false)
        if (ok) break
        if (i > 150) throw new Error(`hub on ${h.port} did not start`)
        await sleep(200)
      }
    }
    let turn = 0
    /** The next serving hub, in turn, as a load balancer hands requests out. */
    const next = () => serving[turn++ % serving.length]!
    const machine = async (hub: { port: number }, path: string, init: RequestInit, token = pusher): Promise<Response> => fetch(`http://127.0.0.1:${hub.port + 1}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` } })
    const session = async (hub: { port: number }, path: string, init?: RequestInit): Promise<Response> => fetch(`http://127.0.0.1:${hub.port}${path}`, { ...init, headers: { 'content-type': 'application/json' } })
    const must = async (res: Response): Promise<unknown> => {
      const text = await res.text()
      if (!res.ok) throw new Error(`${res.url}: ${res.status} ${text.slice(0, 300)}`)
      return JSON.parse(text)
    }
    // One run opened on one hub, its batches sent to each hub in turn, and committed on another.
    const snapshot = async (list: Push[]) => {
      const run = (await must(await machine(next(), '/v1/ingest/runs', { method: 'POST', body: JSON.stringify({ mode: 'snapshot', scope: 'bench' }) }))) as { id: string }
      for (let i = 0; i < list.length; i += 1000) {
        const res = (await must(await machine(next(), `/v1/ingest/runs/${run.id}/entities`, { method: 'PUT', body: JSON.stringify({ entities: list.slice(i, i + 1000) }) }))) as { rejected: unknown[] }
        if (res.rejected.length) throw new Error(`rejected: ${JSON.stringify(res.rejected.slice(0, 3))}`)
      }
      await must(await machine(next(), `/v1/ingest/runs/${run.id}/commit`, { method: 'POST' }))
    }
    const depth = async () => Number((await db.query<{ n: string }>('SELECT count(*)::text AS n FROM derive_queue')).rows[0]!.n)
    const underived = async () => Number((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM entities e WHERE e.state <> 'deleted' AND NOT EXISTS (SELECT 1 FROM derived d WHERE d.blueprint = e.blueprint AND d.key = e.key AND d.derived_at >= e.updated_at)`)).rows[0]!.n)
    /** Waits until nothing waits to be derived and every entity has a row as new as itself. */
    const settled = async () => {
      for (;;) {
        if ((await depth()) === 0 && (await underived()) === 0) return
        await sleep(100)
      }
    }
    const time = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
      const began = performance.now()
      const out = await run()
      metrics[name] = Math.round(performance.now() - began)
      return out
    }

    // How many of the hubs' statements wait on a lock, looked at ten times a second: writers and deriving hubs must not queue behind each other.
    let waiting = 0
    let looks = 0
    let watching = true
    const watch = (async () => {
      while (watching) {
        const res = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND state = 'active'`)
        waiting += Number(res.rows[0]!.n)
        looks++
        await sleep(100)
      }
    })()
    const all = estate(SCALE)
    metrics.entities = all.length
    // The workers derive the estate between them while it is still being pushed, and finish after.
    const began = performance.now()
    await time('push.first', () => snapshot(all))
    await time('derive.first', settled)
    metrics['first.whole'] = Math.round(performance.now() - began)

    // Every serving hub answers the same for a grid and for the summary.
    const grid = (bp: string) => `/v1/entities?blueprint=${bp}&state=active,missing&sort=title&distribution=true&limit=100`
    // A grid's `version` counts what one hub has seen move, so it is each hub's own; everything else must match.
    const answer = async (h: { port: number }, bp: string) => JSON.stringify({ ...((await must(await session(h, grid(bp)))) as object), version: 0 })
    const answers = await Promise.all(serving.map((h) => answer(h, 'k8s_workload')))
    checks.sameGrid = answers.every((a) => a === answers[0])
    // A summary is kept by each hub and given while its next one is worked out, so the hubs agree a moment after the estate rests.
    await time('summary.agreed', async () => {
      for (;;) {
        const totals = await Promise.all(serving.map(async (h) => JSON.stringify(await must(await session(h, '/v1/summary')))))
        if (totals.every((t) => t === totals[0])) return
        await sleep(100)
      }
    })
    checks.sameSummary = true

    // A person's edit through one hub shows through every other, and its grid is read again there.
    const workload = all.find((e) => e.blueprint === 'k8s_workload')!
    const path = `/v1/entities/${workload.blueprint}/${encodeURIComponent(workload.key)}`
    const before = await Promise.all(serving.map(async (h) => ((await must(await session(h, grid('k8s_workload')))) as { version?: number }).version))
    await must(await session(serving[0]!, path, { method: 'PATCH', body: JSON.stringify({ fields: { notes: 'edited through the first hub' } }) }))
    await time('edit.seen', async () => {
      for (;;) {
        const seen = await Promise.all(serving.map(async (h) => ((await must(await session(h, path))) as { fields: { notes?: string } }).fields.notes))
        if (seen.every((n) => n === 'edited through the first hub')) return
        await sleep(10)
      }
    })
    await time('edit.grids', async () => {
      for (;;) {
        const after = await Promise.all(serving.map(async (h) => ((await must(await session(h, grid('k8s_workload')))) as { version?: number }).version))
        if (after.every((v, i) => v !== before[i])) return
        await sleep(10)
      }
    })
    checks.editSeenEverywhere = true

    // A working day's push, derived by the workers while readers ask every serving hub.
    const moved = all.map((e, i) => (i % 100 === 1 && e.blueprint === 'k8s_pod' ? { ...e, fields: { ...e.fields, restarts: Number(e.fields.restarts) + 1 } } : i % 100 === 2 ? { ...e, title: `${e.title} (moved)` } : e))
    let reading = true
    const times: number[] = []
    let failed = 0
    const readers = Array.from({ length: READERS }, async (_, i) => {
      const grids = ['k8s_pod', 'k8s_workload', 'service', 'sw_deployment']
      for (let n = 0; reading; n++) {
        const began = performance.now()
        const res = await session(serving[(i + n) % serving.length]!, `/v1/entities?blueprint=${grids[(i + n) % grids.length]}&state=active,missing&sort=title&limit=100&offset=${(n % 5) * 100}`)
        await res.arrayBuffer()
        if (!res.ok) failed++
        times.push(performance.now() - began)
      }
    })
    const again_ = performance.now()
    await time('push.again', () => snapshot(moved))
    await time('derive.again', settled)
    metrics['again.whole'] = Math.round(performance.now() - again_)
    reading = false
    watching = false
    await Promise.all([...readers, watch])
    metrics['lock.waits'] = waiting
    metrics['lock.looks'] = looks
    metrics['read.calls'] = times.length
    metrics['read.p50'] = Math.round(percentile(times, 0.5))
    metrics['read.p95'] = Math.round(percentile(times, 0.95))
    metrics['read.max'] = Math.round(Math.max(...times))
    checks.readsAnswered = failed === 0 && times.length > 0

    // After all of it the hubs still agree.
    const again = await Promise.all(serving.map((h) => answer(h, 'k8s_pod')))
    checks.sameGridAfter = again.every((a) => a === again[0])

    // What a source wrote is stored by the hub that took it at most once a minute, and the others read it then: the status wall agrees within that.
    await time('wall.agreed', async () => {
      for (;;) {
        const walls = await Promise.all(serving.map(async (h) => JSON.stringify(await must(await session(h, '/v1/wall')))))
        if (walls.every((w) => w === walls[0])) return
        await sleep(500)
      }
    })
    checks.sameWall = true

    // A preview opened through one hub is open on every hub.
    await must(await session(serving[0]!, '/v1/access/previews', { method: 'PUT', body: JSON.stringify({ garden: { open: 'everyone', people: [] } }) }))
    await time('preview.open', async () => {
      for (;;) {
        const open = await Promise.all(serving.map(async (h) => ((await must(await session(h, '/v1/whoami'))) as { previews: string[] }).previews.includes('garden')))
        if (open.every(Boolean)) return
        await sleep(100)
      }
    })
    checks.previewOpenEverywhere = true

    // A budget set through one hub is held by every hub: the token is refused on each once it is past its calls.
    await must(await session(serving[0]!, '/v1/budgets', { method: 'PUT', body: JSON.stringify({ calls: { reader: { limit: 5 } } }) }))
    await time('budget.held', async () => {
      for (;;) {
        const statuses = await Promise.all(serving.map(async (h) => (await machine(h, '/v1/blueprints/system', {}, reader)).status))
        if (statuses.every((s) => s === 429)) return
        await sleep(100)
      }
    })
    checks.budgetHeldEverywhere = true
  } finally {
    await stop()
  }
  const line = JSON.stringify({ value: (metrics['first.whole'] ?? 0) + (metrics['again.whole'] ?? 0), serving: SERVING, workers: WORKERS, checks, metrics })
  await new Promise((done) => process.stdout.write(`${line}\n`, done))
  if (Object.values(checks).some((ok) => !ok)) process.exit(1)
}

await main()
process.exit(0)
