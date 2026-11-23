// The posture benchmark: the security posture page of an estate shaped like a
// mid-sized organisation's. Some two hundred people, most never signed in, a
// dozen machine tokens, over a hundred blueprints with some two and a half
// thousand fields, audiences that name people and follow a path, a field
// class that also opens on what a person owns, and a few dozen actions with
// rules, some opened to what a person owns. Prints one JSON line last: the
// slowest read of the posture in milliseconds as `value`, and each read in
// `metrics`. It fails when a read is slower than `POSTURE_LIMIT_MS` (2000 by
// default), or a read after the first sends more than `POSTURE_STATEMENTS`
// statements (40): a page that judges everyone costs a few, not a few a person.
//
//   LOG_LEVEL=error node bench/posture.ts
//
// It uses its own database, `orrery_bench_posture` beside DATABASE_URL's, and empties it.

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { loadConfig } from '../src/server/config.ts'
import { createHub } from '../src/server/hub.ts'

const BASE_URL = process.env.DATABASE_URL ?? 'postgres://orrery:orrery@localhost:5433/orrery'
const PEOPLE = 220
const SIGNED_IN = 7
const TOKENS = 14
const TEAMS = 12
const PROGRAMS = 30
const KINDS = 130
const FIELDS = 18
const ACTIONS = 44
const READS = Number(process.env.BENCH_READS ?? 4)
const LIMIT_MS = Number(process.env.POSTURE_LIMIT_MS ?? 2000)
const STATEMENTS = Number(process.env.POSTURE_STATEMENTS ?? 40)

async function freshDatabase(): Promise<string> {
  const url = new URL(BASE_URL)
  const admin = new pg.Client({ connectionString: BASE_URL })
  await admin.connect()
  await admin.query('DROP DATABASE IF EXISTS orrery_bench_posture WITH (FORCE)')
  await admin.query('CREATE DATABASE orrery_bench_posture')
  await admin.end()
  url.pathname = '/orrery_bench_posture'
  return url.toString()
}

async function main(): Promise<void> {
  const config = loadConfig({ DATABASE_URL: await freshDatabase(), DATA_DIR: mkdtempSync(join(tmpdir(), 'orrery-bench-')), AUTH_MODE: 'proxy' })
  const hub = await createHub(config, 'bench', { reset: true })
  const call = async (path: string, init?: RequestInit, email = 'admin@example.org', groups = 'Admin'): Promise<unknown> => {
    const res = await hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', 'x-forwarded-email': email, 'x-forwarded-groups': groups } }, { surface: 'session' })
    const text = await res.text()
    if (!res.ok) throw new Error(`${path}: ${res.status} ${text.slice(0, 300)}`)
    return text ? JSON.parse(text) : null
  }
  const put = (path: string, body: unknown) => call(path, { method: 'PUT', body: JSON.stringify(body) })
  const post = (path: string, body: unknown) => call(path, { method: 'POST', body: JSON.stringify(body) })

  await put('/v1/blueprints/team', { title: 'Team', fields: {}, relations: {} })
  // A program names its owner, and a person the programs they are on: the program comes first, its owner once people exist.
  await put('/v1/blueprints/program', { title: 'Program', fields: {}, relations: {} })
  await put('/v1/blueprints/person', { title: 'Person', fields: { department: { type: 'string' }, phone: { type: 'string' } }, relations: { teams: { target: 'team', many: true }, programs: { target: 'program', many: true } } })
  await put('/v1/blueprints/program', { title: 'Program', fields: {}, relations: { owner: { target: 'person' } } })
  await put('/v1/access/person', { blueprint: 'person', owns: [{ as: 'owner', path: '<-owner' }, { as: 'program', path: 'programs' }, { as: 'team', path: 'teams' }] })
  await post('/v1/posture/policy', {
    save: true,
    policy: {
      audiences: [
        { id: 'aud_0', title: 'Platform', people: ['p0@example.org'], grants: [{ path: 'teams', values: ['team-0', 'team-1', 'team-2'] }, { field: 'department', values: ['d1', 'd2'] }], audiences: [] },
        { id: 'aud_1', title: 'Operations', people: ['p1@example.org', 'p2@example.org', 'p3@example.org'], grants: [], audiences: ['aud_2'] },
        { id: 'aud_2', title: 'Cost', people: ['p4@example.org', 'p5@example.org', 'p6@example.org', 'p7@example.org'], grants: [], audiences: [] },
        { id: 'aud_3', title: 'Systems', people: [], grants: [{ path: 'teams', values: ['team-3'] }], audiences: ['aud_0'] },
        { id: 'aud_4', title: 'Risk', people: Array.from({ length: 9 }, (_, i) => `p${10 + i}@example.org`), grants: [], audiences: [] },
        { id: 'aud_5', title: 'Security', people: ['p20@example.org', 'p21@example.org', 'p22@example.org'], grants: [], audiences: [] },
      ],
      classes: [
        { id: 'cost', title: 'Cost', audiences: ['aud_2'], match: ['cost_*', '*_cents', '*_spend', 'budget_*'], include: [], exclude: [], owned: { through: ['program'], roles: ['program'] } },
        { id: 'secrets', title: 'Secrets', audiences: ['aud_5'], match: ['secret_*', '*_key', '*_token', '*_password'], include: [], exclude: [] },
      ],
    },
  })
  for (let k = 0; k < KINDS; k++) {
    const fields: Record<string, unknown> = {}
    for (let f = 0; f < FIELDS; f++) {
      const name = f === 0 ? 'cost_month' : f === 1 ? 'secret_note' : `field_${f}`
      fields[name] = { type: 'string', ...(f === 2 && k % 10 === 0 ? { access: { audiences: [`aud_${k % 6}`] } } : {}) }
    }
    await put(`/v1/blueprints/kind_${k}`, { title: `Kind ${k}`, group: `Group ${k % 8}`, fields, relations: { program: { target: 'program' } }, ...(k % 3 === 0 ? { access: { audiences: [`aud_${k % 6}`] } } : {}) })
  }

  const entities: unknown[] = []
  for (let t = 0; t < TEAMS; t++) entities.push({ blueprint: 'team', key: `team-${t}`, title: `Team ${t}` })
  for (let p = 0; p < PEOPLE; p++) entities.push({ blueprint: 'person', key: `p${p}@example.org`, title: `Person ${p}`, fields: { department: `d${p % 5}` }, relations: { teams: [`team-${p % TEAMS}`], programs: [`program-${p % PROGRAMS}`] } })
  for (let g = 0; g < PROGRAMS; g++) entities.push({ blueprint: 'program', key: `program-${g}`, title: `Program ${g}`, relations: { owner: `p${g}@example.org` } })
  for (let k = 0; k < KINDS; k++) for (let i = 0; i < 20; i++) entities.push({ blueprint: `kind_${k}`, key: `k${k}-${i}`, title: `Kind ${k} ${i}`, fields: { cost_month: i }, relations: { program: `program-${i % PROGRAMS}` } })
  await hub.sources.save('bench', { title: 'bench', class: 'pusher', blueprints: ['*'], deleteGrant: [], cadence: null })
  const source = (await hub.sources.issueToken('source', 'bench', { source: 'bench' })).token
  const machine = async (path: string, body: unknown, method = 'POST') => {
    const res = await hub.app.request(path, { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json', authorization: `Bearer ${source}` } }, { surface: 'machine' })
    if (!res.ok) throw new Error(`${path}: ${res.status} ${(await res.text()).slice(0, 300)}`)
    return (await res.json()) as { id: string }
  }
  const run = await machine('/v1/ingest/runs', { mode: 'snapshot', scope: 'bench' })
  for (let i = 0; i < entities.length; i += 1000) await machine(`/v1/ingest/runs/${run.id}/entities`, { entities: entities.slice(i, i + 1000) }, 'PUT')
  await machine(`/v1/ingest/runs/${run.id}/commit`, {})
  await hub.rules.settled()

  for (let a = 0; a < ACTIONS; a++) {
    await put(`/v1/actions/act_${a}`, {
      title: `Action ${a}`,
      blueprint: `kind_${a % KINDS}`,
      where: { field: 'field_3', op: 'exists' },
      inputs: {},
      backend: { type: 'webhook', url: 'https://hooks.example.org/run' },
      access: { audiences: [`aud_${a % 6}`], rules: [{ owns: ['program'] }, { audiences: [`aud_${(a + 1) % 6}`], where: { field: 'field_4', op: 'exists' } }] },
    })
  }
  for (let p = 0; p < SIGNED_IN; p++) await call('/v1/whoami', {}, `p${p}@example.org`, 'User')
  for (let t = 0; t < TOKENS; t++) await hub.sources.issueToken('access', `reader-${t}`, { role: 'Viewer' })

  const metrics: Record<string, number> = {}
  let slowest = 0
  // Every statement a read sends: a page that judges everyone should cost a few, not a few per person.
  let statements = 0
  const query = hub.db.query.bind(hub.db)
  const kinds = new Map<string, number>()
  hub.db.query = ((...args: Parameters<typeof query>) => {
    statements++
    const sql = String(args[0]).replace(/\s+/g, ' ').slice(0, 110)
    kinds.set(sql, (kinds.get(sql) ?? 0) + 1)
    return query(...args)
  }) as typeof hub.db.query
  for (let i = 0; i < READS; i++) {
    statements = 0
    const started = performance.now()
    const answer = (await call('/v1/posture')) as { principals: unknown[]; items: unknown[] }
    const ms = Math.round(performance.now() - started)
    metrics[`read.${i + 1}`] = ms
    metrics[`statements.${i + 1}`] = statements
    slowest = Math.max(slowest, ms)
    if (i === 0) {
      metrics.principals = answer.principals.length
      metrics.items = answer.items.length
    }
  }
  if (process.env.BENCH_SQL) for (const [sql, n] of [...kinds].sort((a, b) => b[1] - a[1])) console.error(n, sql)
  await hub.close()
  console.log(JSON.stringify({ value: slowest, metrics }))
  const chatty = Object.entries(metrics).filter(([k, n]) => k.startsWith('statements.') && k !== 'statements.1' && n > STATEMENTS)
  if (slowest > LIMIT_MS || chatty.length) {
    console.error(`posture too slow: ${slowest} ms (limit ${LIMIT_MS}), ${chatty.map(([k, n]) => `${k}=${n}`).join(' ') || 'statements within limit'} (limit ${STATEMENTS})`)
    process.exitCode = 1
  }
}

await main()
