// The scale benchmark: an estate of tens of thousands of entities across the
// test catalog's blueprints, pushed, linked, and read through the API the way
// the web app and agents read it. Prints one JSON line last: the total time in
// milliseconds as `value`, and each phase in `metrics`.
//
//   LOG_LEVEL=error node bench/scale.ts
//
// It uses its own database, `orrery_bench` beside DATABASE_URL's, and empties it.
// With BENCH_PG_CONTAINER naming the Docker container Postgres runs in, the
// CPU it spends is counted beside the hub's: `cpu.total` in the metrics.

import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { loadConfig } from '../src/server/config.ts'
import { loadFixtureCatalog } from '../src/server/fixtures/load.ts'
import { createHub, type Hub } from '../src/server/hub.ts'
import { estate, type Push } from './estate.ts'

const BASE_URL = process.env.DATABASE_URL ?? 'postgres://orrery:orrery@localhost:5433/orrery'
const SCALE = Number(process.env.BENCH_SCALE ?? 1)

async function freshDatabase(): Promise<string> {
  const url = new URL(BASE_URL)
  const admin = new pg.Client({ connectionString: BASE_URL })
  await admin.connect()
  await admin.query('DROP DATABASE IF EXISTS orrery_bench WITH (FORCE)')
  await admin.query('CREATE DATABASE orrery_bench')
  await admin.end()
  url.pathname = '/orrery_bench'
  return url.toString()
}

/** The CPU the database's container has spent, in microseconds; zero when no container is named. */
function databaseCpu(): number {
  const container = process.env.BENCH_PG_CONTAINER
  if (!container) return 0
  const stat = execFileSync('docker', ['exec', container, 'cat', '/sys/fs/cgroup/cpu.stat'], { encoding: 'utf8' })
  return Number(/usage_usec (\d+)/.exec(stat)?.[1] ?? 0)
}

const metrics: Record<string, number> = {}
const bytes: Record<string, number> = {}

async function time<T>(name: string, run: () => Promise<T>): Promise<T> {
  const started = performance.now()
  const result = await run()
  metrics[name] = Math.round((metrics[name] ?? 0) + performance.now() - started)
  return result
}

async function main(): Promise<void> {
  const config = loadConfig({ DATABASE_URL: await freshDatabase(), DATA_DIR: mkdtempSync(join(tmpdir(), 'orrery-bench-')), AUTH_MODE: 'none' })
  let hub: Hub = await createHub(config, 'bench')
  const report = await loadFixtureCatalog(hub)
  if (report.errors.length) throw new Error(`catalog: ${JSON.stringify(report.errors)}`)
  await hub.rules.settled()
  await hub.sources.save('bench', { title: 'bench', class: 'pusher', blueprints: ['*'], deleteGrant: [], cadence: null })
  const token = (await hub.sources.issueToken('source', 'bench', { source: 'bench' })).token

  const session = async (path: string, init?: RequestInit): Promise<unknown> => {
    const res = await hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', ...init?.headers } }, { surface: 'session' })
    const text = await res.text()
    if (!res.ok) throw new Error(`${path}: ${res.status} ${text.slice(0, 300)}`)
    const group = path.split('?')[0]!.split('/').slice(0, 3).join('/')
    bytes[group] = (bytes[group] ?? 0) + text.length
    return JSON.parse(text)
  }
  const machine = async (path: string, init: RequestInit): Promise<unknown> => {
    const res = await hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` } }, { surface: 'machine' })
    const text = await res.text()
    if (!res.ok) throw new Error(`${path}: ${res.status} ${text.slice(0, 300)}`)
    return JSON.parse(text)
  }
  const snapshot = async (list: Push[]) => {
    const run = (await machine('/v1/ingest/runs', { method: 'POST', body: JSON.stringify({ mode: 'snapshot', scope: 'bench' }) })) as { id: string }
    for (let i = 0; i < list.length; i += 1000) {
      const res = (await machine(`/v1/ingest/runs/${run.id}/entities`, { method: 'PUT', body: JSON.stringify({ entities: list.slice(i, i + 1000) }) })) as { rejected: unknown[] }
      if (res.rejected.length) throw new Error(`rejected: ${JSON.stringify(res.rejected.slice(0, 3))}`)
    }
    await machine(`/v1/ingest/runs/${run.id}/commit`, { method: 'POST' })
  }

  const all = estate(SCALE)
  const hubCpu = process.cpuUsage()
  const dbCpu = databaseCpu()
  // Store: the first push creates everything; the hub links it after the commit answers.
  await time('push.first', () => snapshot(all))
  await time('link.first', () => hub.rules.settled())
  // Deriving and storing the whole estate once: what the leader does after the first push, and never again for what did not move.
  const settle = async () => {
    while (await hub.deriver.depth()) await hub.deriver.drain()
  }
  await time('derive.first', () => hub.deriver.backfill())
  // A push of the same estate with one in a hundred values moved costs what moved.
  const moved = all.map((e, i) => (i % 100 ? e : { ...e, title: `${e.title} (moved)` }))
  await time('push.again', () => snapshot(moved))
  await time('link.again', () => hub.rules.settled())
  await time('derive.again', settle)
  // A burst: 2,500 pods change at once, and the queue is drained to empty.
  const burst = moved.map((e, i) => (e.blueprint === 'k8s_pod' && i % 5 === 0 ? { ...e, title: `${e.title} (burst)` } : e))
  await time('burst.drain', async () => {
    await snapshot(burst)
    await settle()
  })
  // A working day: one in a hundred entities says something new of itself, and no title moves.
  const said: Record<string, (f: Record<string, unknown>) => Record<string, unknown>> = {
    k8s_pod: (f) => ({ restarts: Number(f.restarts) + 1 }),
    k8s_workload: () => ({ ready: 0, health: 'red', health_reason: 'no replica ready' }),
    k8s_node: () => ({ memory_gb: 128 }),
    sw_deployment: (f) => ({ status: f.status === 'failed' ? 'succeeded' : 'failed' }),
    repository: () => ({ last_push: new Date(Date.UTC(2026, 9, 2)).toISOString(), health: 'red' }),
    argocd_app: () => ({ sync_status: 'OutOfSync', health: 'amber' }),
    k8s_namespace: () => ({ phase: 'Terminating' }),
  }
  const valued = burst.map((e, i) => (i % 100 === 1 && said[e.blueprint] ? { ...e, fields: { ...e.fields, ...said[e.blueprint]!(e.fields) } } : e))
  await time('values.drain', async () => {
    await snapshot(valued)
    await settle()
  })

  const grids = ['k8s_pod', 'k8s_workload', 'sw_deployment', 'k8s_service', 'service', 'repository', 'workload', 'system']
  const grid = (bp: string, offset: number, extra = '') => `/v1/entities?blueprint=${bp}&state=active,missing&sort=title&incoming=true&layers=true&distribution=true&limit=100&offset=${offset}${extra}`
  // Query: a grid opened cold, scrolled, sorted another way, and filtered.
  for (const bp of grids) {
    hub.lists.changed()
    await time('grid.open', () => session(grid(bp, 0)))
    await time('grid.scroll', async () => {
      for (const offset of [100, 1000, 5000]) await session(grid(bp, offset))
    })
  }
  for (const bp of ['k8s_pod', 'k8s_workload', 'service']) {
    await time('grid.sort', () => session(`/v1/entities?blueprint=${bp}&state=active,missing&sort=-title&incoming=true&layers=true&distribution=true&limit=100&offset=0`))
    await time('grid.filter', () => session(grid(bp, 0, `&filter=${encodeURIComponent(JSON.stringify({ search: '12' }))}`)))
  }
  // Search across every blueprint, and a relation picker, as a person types.
  for (const q of ['r', 're', 'repo-1', 'repo-12', 'svc-29']) await time('search.all', () => session(`/v1/entities?limit=100&fields=icon&filter=${encodeURIComponent(JSON.stringify({ search: q }))}`))
  for (const q of ['', 's', 'svc', 'svc-1']) await time('search.picker', () => session(`/v1/entities?blueprint=k8s_service&limit=40&fields=icon${q ? `&filter=${encodeURIComponent(JSON.stringify({ search: q }))}` : ''}`))
  // Relate: one entity's page, and a walk two hops out.
  const pages = [...all.filter((e) => e.blueprint === 'system').slice(0, 5), ...all.filter((e) => e.blueprint === 'k8s_workload').slice(0, 5), ...all.filter((e) => e.blueprint === 'service').slice(0, 5), ...all.filter((e) => e.blueprint === 'k8s_cluster').slice(0, 3)]
  for (const e of pages) await time('entity.page', () => session(`/v1/entities/${e.blueprint}/${encodeURIComponent(e.key)}?provenance=true`))
  for (const e of pages.slice(0, 8)) await time('entity.related', () => session(`/v1/entities/${e.blueprint}/${encodeURIComponent(e.key)}/related?depth=2`))
  // The pages built from the whole estate.
  hub.lists.changed()
  await time('estate.summary', () => session('/v1/summary'))
  // A hub that starts fresh, as after a deploy or a crash, reads the stored rows: the first summary costs no derivation.
  await hub.close()
  hub = await createHub(config, 'bench')
  await time('restart.summary', () => session('/v1/summary'))
  hub.lists.changed()
  await time('estate.wall', () => session('/v1/wall'))
  await time('estate.findings', () => session('/v1/findings'))
  // A person edits one value; the grid that shows it is read again.
  const w = all.find((e) => e.blueprint === 'k8s_workload')!
  await time('edit.value', () => session(`/v1/entities/${w.blueprint}/${encodeURIComponent(w.key)}`, { method: 'PATCH', body: JSON.stringify({ fields: { notes: 'edited' } }) }))
  await time('edit.regrid', () => session(grid('k8s_workload', 0)))
  await time('edit.link', () => hub.rules.settled())

  const total = Object.values(metrics).reduce((a, b) => a + b, 0)
  const spent = process.cpuUsage(hubCpu)
  const cpu = { 'cpu.hub': Math.round((spent.user + spent.system) / 1000), 'cpu.database': Math.round((databaseCpu() - dbCpu) / 1000) }
  await hub.close()
  const line = JSON.stringify({ value: total, metrics: { ...metrics, ...cpu, 'cpu.total': cpu['cpu.hub'] + cpu['cpu.database'], entities: all.length, ...Object.fromEntries(Object.entries(bytes).map(([k, v]) => [`bytes${k.replaceAll('/', '.')}`, v])) } })
  // A pipe is written to asynchronously: exit only once the line is out.
  await new Promise((done) => process.stdout.write(`${line}\n`, done))
}

await main()
process.exit(0)
