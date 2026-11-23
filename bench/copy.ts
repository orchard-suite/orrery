// The floor benchmark: a copy of the database of a hub in use, read and derived
// the way its people use it. The copy is restored beside DATABASE_URL's
// database (`BENCH_COPY`, `orrery_copy` by default) and is never changed: each
// run clones it to `orrery_copy_bench` and works there. What is read comes
// from the copy's own load ledger: the grids that cost its hub most in the
// copy's last week, opened cold as an admin and as its busiest person who is
// not one. Then the ground view cold, where the copy names a ground or a map,
// and the entity most pointed at derived again alone. Names never reach the
// output: a grid is its rank.
//
//   LOG_LEVEL=error node bench/copy.ts
//
// The hub is started without its jobs, so nothing in the copy reaches out: no
// schedule fires, no check runs, no git source is pulled. Prints one JSON line
// last: the total time in milliseconds as `value`, each phase in `metrics`,
// and how old the copy is in `copyDays`.

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { loadConfig } from '../src/server/config.ts'
import { createHub } from '../src/server/hub.ts'
import type { MapIndexResponse } from '../src/shared/api.ts'

const BASE_URL = process.env.DATABASE_URL ?? 'postgres://orrery:orrery@localhost:5433/orrery'
const COPY = process.env.BENCH_COPY ?? 'orrery_copy'
const WORK = 'orrery_copy_bench'
/** How many of the costliest grids are opened. */
const GRIDS = 5

const DAY = 86_400_000

/** A fresh clone of the copy, and when the copy was taken (its comment, set as it is restored). */
async function clone(): Promise<{ url: string; takenAt: Date | null }> {
  const admin = new pg.Client({ connectionString: BASE_URL })
  await admin.connect()
  try {
    const found = await admin.query<{ taken: string | null }>(`SELECT shobj_description(oid, 'pg_database') AS taken FROM pg_database WHERE datname = $1`, [COPY])
    if (!found.rowCount) throw new Error(`no copy: restore one into the database "${COPY}" first`)
    await admin.query(`DROP DATABASE IF EXISTS ${WORK} WITH (FORCE)`)
    // A clone is a file copy: no one may be connected to the copy while it is made.
    await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`, [COPY])
    await admin.query(`CREATE DATABASE ${WORK} TEMPLATE ${COPY}`)
    const taken = /taken (\S+)/.exec(found.rows[0]!.taken ?? '')?.[1]
    const url = new URL(BASE_URL)
    url.pathname = `/${WORK}`
    return { url: url.toString(), takenAt: taken ? new Date(taken) : null }
  } finally {
    await admin.end()
  }
}

const metrics: Record<string, number> = {}

async function time<T>(name: string, run: () => Promise<T>): Promise<T> {
  const started = performance.now()
  const result = await run()
  metrics[name] = Math.round((metrics[name] ?? 0) + performance.now() - started)
  return result
}

async function main(): Promise<void> {
  const { url, takenAt } = await clone()
  const copyDays = takenAt ? Math.floor((Date.now() - takenAt.getTime()) / DAY) : -1
  if (copyDays < 0) console.error(`the copy says nothing of when it was taken; comment it: COMMENT ON DATABASE ${COPY} IS 'taken <ISO date>'`)

  const config = loadConfig({ DATABASE_URL: url, DATA_DIR: mkdtempSync(join(tmpdir(), 'orrery-copy-')), AUTH_MODE: 'proxy' })
  const hub = await time('hub.start', () => createHub(config, 'bench'))

  // What the copy's hub spent its last week on, from its own ledger.
  const week = `hour >= (SELECT max(hour) FROM load_hours) - interval '7 days'`
  const grids = (await hub.db.query<{ name: string }>(`SELECT name FROM load_hours WHERE kind = 'shape' AND ${week} GROUP BY name ORDER BY sum(ms) DESC LIMIT ${GRIDS}`)).rows.map((r) => r.name).filter((id) => hub.blueprints.get(id))
  const person = (
    await hub.db.query<{ email: string }>(
      `SELECT u.email FROM load_hours l JOIN users u ON lower(u.email) = lower(l.name) WHERE l.kind = 'read' AND NOT u.admin AND ${week.replace('hour', 'l.hour')} GROUP BY u.email ORDER BY sum(l.calls) DESC LIMIT 1`,
    )
  ).rows[0]?.email
  if (!grids.length) throw new Error('the copy holds no grid load to read: its ledger is empty')

  const ask = async (who: { email: string; groups: string }, path: string): Promise<unknown> => {
    const res = await hub.app.request(path, { headers: { 'x-forwarded-email': who.email, 'x-forwarded-groups': who.groups } }, { surface: 'session' })
    const text = await res.text()
    if (!res.ok) throw new Error(`${path.split('?')[0]}: ${res.status} ${text.slice(0, 200)}`)
    return JSON.parse(text)
  }
  const admin = { email: 'bench-admin@example.org', groups: config.ROLE_GROUP_ADMIN }
  const reader = person ? { email: person, groups: config.ROLE_GROUP_USER } : null
  const grid = (bp: string, extra = '') => `/v1/entities?blueprint=${encodeURIComponent(bp)}&state=active,missing&sort=title&incoming=3&layers=true&distribution=true&limit=100&offset=0${extra}`

  // Each grid opened cold, as the web app opens it, then scrolled.
  for (const [i, bp] of grids.entries()) {
    hub.lists.changed()
    await time(`grid.${i + 1}.open`, () => ask(admin, grid(bp)))
    await time(`grid.${i + 1}.scroll`, () => ask(admin, grid(bp).replace('offset=0', 'offset=1000')))
    if (reader) {
      hub.lists.changed()
      await time(`grid.${i + 1}.person`, () => ask(reader, grid(bp)))
    }
  }
  const first = (await ask(admin, grid(grids[0]!))) as { entities: { key: string }[] }
  const key = first.entities[0]?.key
  if (key) await time('entity.page', () => ask(admin, `/v1/entities/${encodeURIComponent(grids[0]!)}/${encodeURIComponent(key)}`))
  for (const q of ['a', 'ab', 'abc']) await time('search.all', () => ask(admin, `/v1/entities?limit=100&fields=icon&filter=${encodeURIComponent(JSON.stringify({ search: q }))}`))
  await time('estate.summary', () => ask(admin, '/v1/summary'))
  await time('estate.findings', () => ask(admin, '/v1/findings'))
  if (reader) {
    await time('person.summary', () => ask(reader, '/v1/summary'))
    await time('person.mine', () => ask(reader, '/v1/mine?green=false'))
  }
  await time('security.posture', () => ask(admin, '/v1/posture'))

  // The ground view, cold, as the web app opens it: every ground's cover and the map index side by side, then the
  // largest map. The clone is the bench's own, so the preview is opened to everyone in it.
  const grounded = hub.blueprints.list().some((bp) => bp.ground || bp.map)
  if (grounded) {
    const res = await hub.app.request('/v1/access/previews', { method: 'PUT', headers: { 'content-type': 'application/json', 'x-forwarded-email': admin.email, 'x-forwarded-groups': admin.groups }, body: JSON.stringify({ garden: { open: 'everyone', people: [] } }) }, { surface: 'session' })
    if (!res.ok) throw new Error(`the garden preview did not open: ${res.status}`)
    const view = async (who: { email: string; groups: string }) => Promise.all([ask(who, '/v1/ground'), ask(who, '/v1/map')])
    hub.lists.changed()
    const [, index] = (await time('ground.view', () => view(admin))) as [unknown, MapIndexResponse]
    if (reader) {
      hub.lists.changed()
      await time('ground.view.person', () => view(reader))
    }
    const largest = [...index.holders].sort((a, b) => b.members + b.plots - (a.members + a.plots))[0]
    if (largest) {
      hub.lists.changed()
      await time('ground.map', () => ask(admin, `/v1/map/${encodeURIComponent(largest.blueprint)}/${encodeURIComponent(largest.key)}`))
    }
  }

  // The entity most pointed at, derived again alone: what one change near it costs every time.
  const busiest = (await hub.db.query<{ blueprint: string; key: string }>(`SELECT target_blueprint AS blueprint, target_key AS key FROM relations GROUP BY 1, 2 ORDER BY count(*) DESC LIMIT 1`)).rows[0]
  if (busiest) {
    await time('derive.busy', async () => {
      await hub.deriver.enqueue(hub.db, [busiest])
      while (await hub.deriver.depth()) await hub.deriver.drain()
    })
  }

  // Every entity derived again, as after a change to the model that every blueprint reads.
  await time('derive.all', async () => {
    await hub.deriver.enqueueBlueprints(hub.db, hub.blueprints.list().map((bp) => bp.id))
    while (await hub.deriver.depth()) await hub.deriver.drain()
  })

  const entities = Number((await hub.db.query<{ n: string }>(`SELECT count(*)::text AS n FROM entities WHERE state IN ('active', 'missing')`)).rows[0]!.n)
  await hub.close()
  const value = Object.values(metrics).reduce((a, b) => a + b, 0)
  console.log(JSON.stringify({ value, copyDays, metrics: { ...metrics, entities, grids: grids.length, person: reader ? 1 : 0 } }))
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
