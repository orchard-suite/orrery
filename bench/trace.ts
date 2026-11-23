// Times each statement behind the slow reads, against the database the scale benchmark left (`orrery_bench`).
//
//   BENCH_SCALE=7 node bench/scale.ts && node bench/trace.ts
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../src/server/config.ts'
import { createHub } from '../src/server/hub.ts'

const url = new URL(process.env.DATABASE_URL ?? 'postgres://orrery:orrery@localhost:5433/orrery')
url.pathname = '/orrery_bench'
const hub = await createHub(loadConfig({ DATABASE_URL: url.toString(), DATA_DIR: mkdtempSync(join(tmpdir(), 'orrery-trace-')), AUTH_MODE: 'none' }), 'trace')
let explained = false
let seen: { ms: number; text: string; rows: number }[] = []
const query = hub.db.pool.query.bind(hub.db.pool) as (...args: unknown[]) => Promise<{ rowCount: number | null }>
;(hub.db.pool as unknown as { query: unknown }).query = async (...args: unknown[]) => {
  const started = performance.now()
  const res = await query(...args)
  if (process.env.EXPLAIN && String((args[0] as { text?: string }).text ?? args[0]).startsWith('WITH r AS MATERIALIZED') && !explained) {
    explained = true
    const a = args[0] as { text: string; values: unknown[] } | string
    const plan = await query(`EXPLAIN (ANALYZE, BUFFERS OFF, COSTS OFF) ${typeof a === 'string' ? a : a.text}`, typeof a === 'string' ? (args[1] as unknown[]) : a.values)
    console.log((plan as unknown as { rows: { 'QUERY PLAN': string }[] }).rows.map((r) => r['QUERY PLAN'].slice(0, 160)).join('\n'))
  }
  seen.push({ ms: performance.now() - started, text: String(typeof args[0] === 'string' ? args[0] : (args[0] as { text: string }).text).replace(/\s+/g, ' '), rows: res.rowCount ?? 0 })
  return res
}
const call = async (name: string, path: string, init?: RequestInit) => {
  seen = []
  const started = performance.now()
  const res = await hub.app.request(path, { ...init, headers: { 'content-type': 'application/json' } }, { surface: 'session' })
  const size = (await res.text()).length
  const total = performance.now() - started
  const db = seen.reduce((a, s) => a + s.ms, 0)
  console.log(`\n== ${name}: ${total.toFixed(0)} ms, status ${res.status}, ${size} bytes, ${seen.length} statements, ${db.toFixed(0)} ms in the database (statements overlap)`)
  for (const s of [...seen].sort((a, b) => b.ms - a.ms).slice(0, Number(process.env.TOP ?? 4))) console.log(`${s.ms.toFixed(0).padStart(6)} ms ${String(s.rows).padStart(7)} rows  ${s.text.slice(0, Number(process.env.WIDTH ?? 330))}`)
}
const grid = (bp: string, sort: string) => `/v1/entities?blueprint=${bp}&state=active,missing&sort=${sort}&incoming=true&layers=true&distribution=true&limit=100&offset=0`
hub.lists.changed()
await call('summary', '/v1/summary')
hub.lists.changed()
await call('grid open k8s_pod', grid('k8s_pod', 'title'))
await call('grid sort k8s_pod', grid('k8s_pod', '-title'))
await call('grid open k8s_workload', grid('k8s_workload', 'title'))
const first = (await hub.db.query<{ key: string }>(`SELECT key FROM entities WHERE blueprint = 'k8s_workload' ORDER BY key LIMIT 1`)).rows[0]!.key
await call('edit', `/v1/entities/k8s_workload/${encodeURIComponent(first)}`, { method: 'PATCH', body: JSON.stringify({ fields: { notes: `edited ${Date.now()}` } }) })
await call('grid after edit k8s_workload', grid('k8s_workload', 'title'))
await hub.close()
process.exit(0)
