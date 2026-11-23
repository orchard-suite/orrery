import { mkdtempSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { EntitiesResponse, EntityPageResponse, ModelLayout, ScorecardResults, ServerEvent } from '../shared/api.ts'
import { loadConfig } from './config.ts'
import { MODEL_LAYOUT_GENERATION } from './layout.ts'
import { loadFixtureCatalog } from './fixtures/load.ts'
import { createHub, type Hub } from './hub.ts'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://orrery:orrery@localhost:5433/orrery'

let hub: Hub
let token = ''
let runnerToken = ''
let alertToken = ''
let web: Server
let webPort = 0
let healthy = true

const session = (path: string, init?: RequestInit) => hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', ...init?.headers } }, { surface: 'session' })
const machine = (path: string, init?: RequestInit, bearer = token) => hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}`, ...init?.headers } }, { surface: 'machine' })
const json = async <T = Record<string, unknown>>(r: Response): Promise<T> => (await r.json()) as T
const body = (v: unknown) => ({ body: JSON.stringify(v) })

beforeAll(async () => {
  const config = loadConfig({ DATABASE_URL, DATA_DIR: mkdtempSync(join(tmpdir(), 'orrery-')), AUTH_MODE: 'none' })
  hub = await createHub(config, 'test', { reset: true })
  const report = await loadFixtureCatalog(hub)
  expect(report.errors).toEqual([])
  await hub.sources.save('k8s@home', { title: 'k8s', class: 'pusher', blueprints: ['*'], deleteGrant: [], cadence: '3m' })
  await hub.sources.save('lan-runner', { title: 'LAN runner', class: 'runner', description: 'home-lan', blueprints: [], deleteGrant: [], cadence: '5m' })
  await hub.sources.save('alertmanager', { title: 'Alertmanager', class: 'event', blueprints: [], deleteGrant: [], cadence: null })
  token = (await hub.sources.issueToken('source', 'k8s', { source: 'k8s@home' })).token
  runnerToken = (await hub.sources.issueToken('source', 'runner', { source: 'lan-runner' })).token
  alertToken = (await hub.sources.issueToken('source', 'am', { source: 'alertmanager' })).token
  web = createServer((req, res) => {
    if (req.headers.authorization !== 'Bearer s3cret') {
      res.writeHead(401).end('no')
      return
    }
    res.writeHead(healthy ? 200 : 503).end(healthy ? 'ok: orrery' : 'down')
  })
  await new Promise<void>((r) => web.listen(0, '127.0.0.1', r))
  webPort = (web.address() as { port: number }).port
  // A blueprint with a health check field, defined in the UI.
  expect((await session('/v1/blueprints/web_app', { method: 'PUT', ...body({ title: 'Web app', fields: { health: { type: 'healthcheck' }, uptime_pct: { type: 'number', calculation: 'ready / replicas * 100' }, ready: { type: 'number' }, replicas: { type: 'number' } }, relations: { system: { target: 'system' } } }) })).status).toBe(200)
})

afterAll(async () => {
  web.close()
  await hub.close()
})

describe('a sort', () => {
  it('reads the numbers in a text value as numbers, and keeps an unset value last either way', async () => {
    expect((await session('/v1/blueprints/release_tag', { method: 'PUT', ...body({ title: 'Release tag', fields: { tag: { type: 'string' } } }) })).status).toBe(200)
    for (const [key, tag] of [['a', '0.9.9'], ['b', '0.9.32'], ['c', null], ['d', '0.9.23'], ['e', '0.10.0']] as const) {
      expect((await machine(`/v1/ingest/entities/release_tag/${key}`, { method: 'PUT', ...body({ title: key, fields: { tag } }) })).status).toBe(201)
    }
    const order = async (sort: string) => (await json<EntitiesResponse>(await session(`/v1/entities?blueprint=release_tag&sort=${sort}`))).entities.map((e) => e.fields.tag ?? null)
    expect(await order('-tag')).toEqual(['0.10.0', '0.9.32', '0.9.23', '0.9.9', null])
    expect(await order('tag')).toEqual(['0.9.9', '0.9.23', '0.9.32', '0.10.0', null])
  })
})

describe('a money field', () => {
  const money = { type: 'number', format: { kind: 'currency', currency: 'USD', minor: true } }

  it('is kept when a pusher offers it, and a bad format is refused', async () => {
    const offered = await json<{ created: string[]; rejected: unknown[] }>(await machine('/v1/ingest/blueprints', { method: 'PUT', ...body({ blueprints: [{ id: 'ledger', title: 'Ledger', fields: { amount_cents: money, doubled: { type: 'number', calculation: 'amount_cents * 2', format: money.format } } }] }) }))
    expect(offered).toMatchObject({ created: ['ledger'], rejected: [] })
    const stored = await json<{ fields: Record<string, { format?: unknown }> }>(await session('/v1/blueprints/ledger'))
    expect(stored.fields.amount_cents?.format).toEqual({ kind: 'currency', currency: 'USD', minor: true })
    for (const format of [{ kind: 'currency', currency: 'dollars' }, { kind: 'percent' }]) {
      const bad = await session('/v1/blueprints/ledger_bad', { method: 'PUT', ...body({ title: 'Bad', fields: { amount_cents: { type: 'number', format } } }) })
      expect(bad.status).toBe(400)
    }
    const notNumber = await session('/v1/blueprints/ledger_bad', { method: 'PUT', ...body({ title: 'Bad', fields: { name: { type: 'string', format: money.format } } }) })
    expect(notNumber.status).toBe(400)
    expect((await json(notNumber)).error).toMatch(/only a number has a format/)
  })

  it('stores, sorts, filters, and sums the raw cents', async () => {
    const put = async (id: string, spec: unknown) => expect((await session(`/v1/blueprints/${id}`, { method: 'PUT', ...body(spec) })).status).toBe(200)
    await put('ledger_total', { title: 'Ledger total', fields: { total_cents: { type: 'number', format: money.format, aggregation: { relation: '<-ledger_line:owner', fn: 'sum', field: 'amount_cents' } } } })
    await put('ledger_line', { title: 'Ledger line', fields: { amount_cents: money, doubled: { type: 'number', calculation: 'amount_cents * 2', format: money.format } }, relations: { owner: { target: 'ledger_total' } } })
    expect((await machine('/v1/ingest/entities/ledger_total/all', { method: 'PUT', ...body({ title: 'All' }) })).status).toBe(201)
    for (const [key, cents] of [['a', 123456], ['b', 5], ['c', 99]] as const) {
      expect((await machine(`/v1/ingest/entities/ledger_line/${key}`, { method: 'PUT', ...body({ title: key, fields: { amount_cents: cents }, relations: { owner: 'ledger_total:all' } }) })).status).toBe(201)
    }
    const sorted = await json<EntitiesResponse>(await session('/v1/entities?blueprint=ledger_line&sort=-amount_cents'))
    expect(sorted.entities.map((e) => e.key)).toEqual(['a', 'c', 'b'])
    const filtered = await json<EntitiesResponse>(await session(`/v1/entities?blueprint=ledger_line&filter=${encodeURIComponent(JSON.stringify({ field: 'amount_cents', op: 'gt', value: 100 }))}`))
    expect(filtered.entities.map((e) => e.key)).toEqual(['a'])
    const one = await json<{ fields: Record<string, unknown> }>(await session('/v1/entities/ledger_line/a'))
    expect(one.fields).toMatchObject({ amount_cents: 123456, doubled: 246912 })
    const total = await json<{ fields: Record<string, unknown> }>(await session('/v1/entities/ledger_total/all'))
    expect(total.fields.total_cents).toBe(123560)
  })

  it('refuses a fraction of a cent and keeps a whole number', async () => {
    const half = await machine('/v1/ingest/entities/ledger_line/half', { method: 'PUT', ...body({ title: 'Half', fields: { amount_cents: 10.5 } }) })
    expect(half.status).toBe(422)
    expect(JSON.stringify(await half.json())).toMatch(/whole number of USD minor units/)
    expect((await machine('/v1/ingest/entities/ledger_line/whole', { method: 'PUT', ...body({ title: 'Whole', fields: { amount_cents: 11 } }) })).status).toBe(201)
  })
})

describe('calculation fields', () => {
  it('evaluates expressions over the entity and refuses writes to them', async () => {
    const put = await machine('/v1/ingest/entities/web_app/site', { method: 'PUT', ...body({ title: 'Site', fields: { ready: 1, replicas: 4 } }) })
    expect(put.status).toBe(201)
    const e = await json<{ fields: Record<string, unknown> }>(await session('/v1/entities/web_app/site'))
    expect(e.fields.uptime_pct).toBe(25)
    expect((await machine('/v1/ingest/entities/web_app/site', { method: 'PATCH', ...body({ fields: { uptime_pct: 99 } }) })).status).toBe(422)
    const bad = await session('/v1/blueprints/broken', { method: 'PUT', ...body({ title: 'Broken', fields: { x: { type: 'number', calculation: 'ready +' } } }) })
    expect(bad.status).toBe(400)
  })

  it('works a calculation out after the calculations it reads, whatever the field order', async () => {
    const fields = { grade: { type: 'string', calculation: "band == null ? null : band + '!'" }, band: { type: 'string', calculation: "score > 5 ? 'high' : 'low'" }, score: { type: 'number' } }
    expect((await session('/v1/blueprints/graded', { method: 'PUT', ...body({ title: 'Graded', fields }) })).status).toBe(200)
    expect((await machine('/v1/ingest/entities/graded/one', { method: 'PUT', ...body({ title: 'One', fields: { score: 9 } }) })).status).toBe(201)
    const e = await json<{ fields: Record<string, unknown> }>(await session('/v1/entities/graded/one'))
    expect(e.fields).toMatchObject({ band: 'high', grade: 'high!' })
  })
})

describe('health checks and runners', () => {
  it('runs hub checks with a secret, and a LAN runner pulls its checks and pushes results into a reachability matrix', async () => {
    await session('/v1/secrets/site-token', { method: 'PUT', ...body({ value: 's3cret' }) })
    const check = { url: `http://127.0.0.1:${webPort}/healthz`, expectBody: 'orrery', auth: { type: 'bearer', secretRef: 'site-token' }, runners: ['hub', 'lan-runner'] }
    expect((await machine('/v1/ingest/entities/web_app/site', { method: 'PATCH', ...body({ fields: { health: check } }) })).status).toBe(200)
    await hub.checks.runHub()
    let page = await json<EntityPageResponse>(await session('/v1/entities/web_app/site'))
    expect(page.checks[0]?.results.find((r) => r.runner === 'hub')).toMatchObject({ ok: true, status: 200 })
    expect(page.status.level).toBe('grey')
    expect(page.status.reasons[0]).toMatch(/no result from lan-runner/)
    // The runner pulls its checks with the secret opened, and reports.
    const pulled = await json<{ checks: { entity: { key: string }; secret?: string; check: { runners: string[] } }[] }>(await machine('/v1/ingest/runner/checks', {}, runnerToken))
    expect(pulled.checks).toHaveLength(1)
    expect(pulled.checks[0]?.secret).toBe('s3cret')
    await machine('/v1/ingest/runner/results', { method: 'POST', ...body({ results: [{ blueprint: 'web_app', key: 'site', field: 'health', ok: true, status: 200, latencyMs: 12 }] }) }, runnerToken)
    page = await json<EntityPageResponse>(await session('/v1/entities/web_app/site'))
    expect(page.status.level).toBe('green')
    expect(page.checks[0]?.results).toHaveLength(2)
    // The same result again says nothing new of the entity: it is kept as the latest, and nothing is derived for it.
    while (await hub.deriver.depth()) await hub.deriver.drain()
    await machine('/v1/ingest/runner/results', { method: 'POST', ...body({ results: [{ blueprint: 'web_app', key: 'site', field: 'health', ok: true, status: 200, latencyMs: 48 }] }) }, runnerToken)
    expect(await hub.deriver.depth()).toBe(0)
    expect((await json<EntityPageResponse>(await session('/v1/entities/web_app/site'))).checks[0]?.results.find((r) => r.runner === 'lan-runner')).toMatchObject({ latencyMs: 48 })
    // The site goes down: the hub runner sees it and the entity turns red.
    healthy = false
    await hub.checks.runHub()
    page = await json<EntityPageResponse>(await session('/v1/entities/web_app/site'))
    expect(page.status.level).toBe('red')
    expect(page.status.reasons.join(' ')).toMatch(/expected 2xx, got 503/)
    healthy = true
    // Secrets never appear on the read side.
    expect(JSON.stringify(page)).not.toContain('s3cret')
    expect((await machine('/v1/ingest/runner/checks')).status).toBe(403)
    // The runner is an entity on the wall.
    const runner = await json<{ fields: Record<string, unknown>; status: { level: string } }>(await session('/v1/entities/orrery_runner/lan-runner'))
    expect(runner.status.level).toBe('green')
  })
})

describe('alerts', () => {
  it('attaches alertmanager alerts to entities through alert rules and clears them on resolve', async () => {
    await machine('/v1/ingest/entities/k8s_namespace/home%2Fshop', { method: 'PUT', ...body({ title: 'shop', fields: { name: 'shop' } }) })
    const alert = { status: 'firing', labels: { alertname: 'KubePodCrashLooping', namespace: 'shop', severity: 'critical' }, annotations: { summary: 'storefront is crash looping' }, startsAt: new Date().toISOString(), fingerprint: 'f1' }
    const res = await machine('/v1/ingest/alerts/alertmanager', { method: 'POST', ...body({ alerts: [alert, { ...alert, fingerprint: 'f2', labels: { alertname: 'Orphan', namespace: 'nowhere' } }] }) }, alertToken)
    expect(await json(res)).toMatchObject({ firing: 2, matched: 1, unmatched: 1 })
    let ns = await json<EntityPageResponse>(await session('/v1/entities/k8s_namespace/home%2Fshop'))
    expect(ns.status.level).toBe('red')
    expect(ns.alerts).toHaveLength(1)
    expect(ns.status.reasons[0]).toMatch(/storefront is crash looping/)
    await machine('/v1/ingest/alerts/alertmanager', { method: 'POST', ...body({ alerts: [{ ...alert, status: 'resolved' }] }) }, alertToken)
    ns = await json<EntityPageResponse>(await session('/v1/entities/k8s_namespace/home%2Fshop'))
    expect(ns.status.level).toBe('green')
    expect((await machine('/v1/ingest/alerts/alertmanager', { method: 'POST', ...body({ alerts: [] }) })).status).toBe(403)
  })

  it('reads only the alerts and check results of what a write derives, however many the estate holds', async () => {
    const alert = { status: 'firing', labels: { alertname: 'KubePodCrashLooping', namespace: 'shop', severity: 'critical' }, annotations: { summary: 'storefront is crash looping' }, startsAt: new Date().toISOString(), fingerprint: 'f3' }
    await machine('/v1/ingest/alerts/alertmanager', { method: 'POST', ...body({ alerts: [alert] }) }, alertToken)
    expect((await hub.db.query('SELECT 1 FROM check_results')).rowCount).toBeGreaterThan(0)
    const query = vi.spyOn(hub.db, 'query')
    const signalsRead = async () => {
      let rows = 0
      for (const [i, call] of query.mock.calls.entries()) if (/FROM (alerts|check_results)\b/.test(String(call[0]))) rows += ((await query.mock.results[i]!.value) as { rowCount: number | null }).rowCount ?? 0
      query.mockClear()
      return rows
    }
    // An entity with no alert and no check: deriving it reads no alert and no result of any other.
    await machine('/v1/ingest/entities/k8s_namespace/home%2Fquiet', { method: 'PUT', ...body({ title: 'quiet', fields: { name: 'quiet' } }) })
    expect(await signalsRead()).toBe(0)
    // The one the alert is on reads its own, and still shows it.
    await machine('/v1/ingest/entities/k8s_namespace/home%2Fshop', { method: 'PUT', ...body({ title: 'shop again', fields: { name: 'shop' } }) })
    expect(await signalsRead()).toBe(1)
    query.mockRestore()
    const ns = await json<EntityPageResponse>(await session('/v1/entities/k8s_namespace/home%2Fshop'))
    expect(ns.status.level).toBe('red')
    expect(ns.alerts).toHaveLength(1)
    await machine('/v1/ingest/alerts/alertmanager', { method: 'POST', ...body({ alerts: [{ ...alert, status: 'resolved' }] }) }, alertToken)
  })
})

describe('alert history', () => {
  it('keeps every alert an event source sends as an entity that outlives it', async () => {
    await session('/v1/blueprints/alert_record', {
      method: 'PUT',
      ...body({
        id: 'alert_record',
        title: 'Alert record',
        fields: { status: { type: 'enum', values: ['open', 'resolved'] }, severity: { type: 'enum', values: ['critical', 'high', 'medium', 'low'] }, health: { type: 'enum', values: ['red', 'amber', 'green', 'grey'] }, started_at: { type: 'datetime' }, resolved_at: { type: 'datetime' }, duration_hours: { type: 'number' }, summary: { type: 'markdown' } },
        relations: { namespace: { target: 'k8s_namespace' } },
        status: { field: 'health' },
      }),
    })
    expect((await session('/v1/sources/am-history', { method: 'PUT', ...body({ title: 'Kept', class: 'pusher', blueprints: ['alert_record'], history: { blueprint: 'alert_record' } }) })).status).toBe(400)
    expect((await session('/v1/sources/am-history', { method: 'PUT', ...body({ title: 'Kept', class: 'event', blueprints: [], history: { blueprint: 'alert_record' } }) })).status).toBe(400)
    await hub.sources.save('am-history', { title: 'Kept', class: 'event', blueprints: ['alert_record'], deleteGrant: [], cadence: null, history: { blueprint: 'alert_record', relation: 'namespace' } })
    const keptToken = (await hub.sources.issueToken('source', 'kept', { source: 'am-history' })).token
    await machine('/v1/ingest/entities/k8s_namespace/home%2Fkept', { method: 'PUT', ...body({ title: 'kept', fields: { name: 'kept' } }) })
    const startsAt = new Date(Date.now() - 2 * 3_600_000).toISOString()
    const alert = { status: 'firing', labels: { alertname: 'DiskFull', namespace: 'kept', severity: 'warning' }, annotations: { summary: 'disk is full' }, startsAt, fingerprint: 'h1' }
    expect(await json(await machine('/v1/ingest/alerts/alertmanager', { method: 'POST', ...body({ alerts: [alert] }) }, keptToken))).toMatchObject({ firing: 1, matched: 1, kept: 1 })
    let rec = await json<EntityPageResponse>(await session('/v1/entities/alert_record/am-history%2Fh1'))
    expect(rec.fields).toMatchObject({ status: 'open', severity: 'medium', health: 'amber', started_at: startsAt, summary: 'disk is full' })
    expect(rec.relations.namespace?.[0]?.key).toBe('home/kept')
    expect(rec.status.level).toBe('amber')
    const endsAt = new Date().toISOString()
    await machine('/v1/ingest/alerts/alertmanager', { method: 'POST', ...body({ alerts: [{ ...alert, status: 'resolved', endsAt }] }) }, keptToken)
    rec = await json<EntityPageResponse>(await session('/v1/entities/alert_record/am-history%2Fh1'))
    expect(rec.fields).toMatchObject({ status: 'resolved', health: 'green', resolved_at: endsAt, duration_hours: 2 })
    // The record still points at what it was raised on after the live alert is gone.
    expect(rec.relations.namespace?.[0]?.key).toBe('home/kept')
    expect((await json<{ alerts: unknown[] }>(await session('/v1/alerts'))).alerts.some((a) => (a as { fingerprint: string }).fingerprint === 'h1')).toBe(false)
  })
})

describe('scorecards', () => {
  it('scores entities by level, exposes the matrix and trend, and shows on the entity page', async () => {
    await session('/v1/entities', { method: 'POST', ...body({ blueprint: 'system', key: 'storefront', title: 'Storefront', fields: { description: 'The storefront', repo: 'https://example.org/storefront', owner: 'someone' } }) })
    await session('/v1/entities', { method: 'POST', ...body({ blueprint: 'system', key: 'bare', title: 'Bare' }) })
    await machine('/v1/ingest/entities/k8s_workload/home%2Fshop%2Fstorefront', { method: 'PUT', ...body({ title: 'storefront', fields: { name: 'storefront', kind: 'Deployment', health: 'green', labels: { 'app.kubernetes.io/part-of': 'storefront' } }, relations: { namespace: 'home/shop' } }) })
    await hub.rules.evaluateAll()
    const results = await json<ScorecardResults>(await session('/v1/scorecards/system_readiness/results'))
    const storefront = results.rows.find((r) => r.entity.key === 'storefront')
    expect(storefront?.levelName).toBe('Silver')
    expect(storefront?.rules.has_workloads).toBe(true)
    expect(results.rows.find((r) => r.entity.key === 'bare')?.levelName).toBe('none')
    await hub.scorecards.recordHistory()
    const trend = await json<{ series: Record<string, number[]> }>(await session('/v1/scorecards/system_readiness/trend?days=2'))
    expect(trend.series.Silver?.[1]).toBe(1)
    const page = await json<EntityPageResponse>(await session('/v1/entities/system/storefront'))
    expect(page.scorecards[0]).toMatchObject({ scorecard: 'system_readiness', levelName: 'Silver' })
    // Gold needs notes and docs; a UI edit gets there.
    await session('/v1/entities/system/storefront', { method: 'PATCH', ...body({ fields: { notes: 'Serves the store. Breaks checkout.', docs: 'https://example.org/docs' } }) })
    const after = await json<ScorecardResults>(await session('/v1/scorecards/system_readiness/results'))
    expect(after.rows.find((r) => r.entity.key === 'storefront')?.levelName).toBe('Gold')
    const git = await session('/v1/scorecards/system_readiness', { method: 'DELETE' })
    expect(git.status).toBe(400)
    expect((await json(git)).error).toMatch(/defined in git/)
  })
})

describe('a scorecard scope', () => {
  const card = (where?: unknown) => ({ blueprint: 'system', title: 'Critical ready', ...(where ? { where } : {}), levels: [{ name: 'Bronze', rules: [{ id: 'has_docs', title: 'Has docs', where: { field: 'docs', op: 'exists' } }] }] })
  const results = async (id: string) => json<ScorecardResults>(await session(`/v1/scorecards/${id}/results`))

  it('scores only what the scope matches, and counts nothing else', async () => {
    await session('/v1/entities', { method: 'POST', ...body({ blueprint: 'system', key: 'crit-docs', title: 'Crit docs', fields: { tier: 'critical', docs: 'https://example.org/d' } }) })
    await session('/v1/entities', { method: 'POST', ...body({ blueprint: 'system', key: 'crit-bare', title: 'Crit bare', fields: { tier: 'critical' } }) })
    await session('/v1/entities', { method: 'POST', ...body({ blueprint: 'system', key: 'exp-bare', title: 'Exp bare', fields: { tier: 'experimental' } }) })
    expect((await session('/v1/scorecards/critical_ready', { method: 'PUT', ...body(card({ field: 'tier', op: 'eq', value: 'critical' })) })).status).toBe(200)
    expect((await session('/v1/scorecards/everything_ready', { method: 'PUT', ...body(card()) })).status).toBe(200)

    const scoped = await results('critical_ready')
    const all = await results('everything_ready')
    expect(scoped.rows.map((r) => r.entity.key).sort()).toEqual(['crit-bare', 'crit-docs'])
    expect(scoped.counts).toEqual([1, 1])
    // Every system the scope leaves out is counted as out of scope and nowhere else.
    expect(scoped.outOfScope).toBe(all.rows.length - 2)
    // Without a scope, the experimental system is scored and fails, as before.
    expect(all.outOfScope).toBe(0)
    expect(all.rows.find((r) => r.entity.key === 'exp-bare')?.levelName).toBe('none')
    expect(all.counts.reduce((a, b) => a + b, 0)).toBe(all.rows.length)

    const page = async (key: string) => (await json<EntityPageResponse>(await session(`/v1/entities/system/${key}`))).scorecards.map((s) => s.scorecard)
    expect(await page('crit-bare')).toEqual(expect.arrayContaining(['critical_ready', 'everything_ready']))
    // Out of scope: no level on the entity page at all.
    expect(await page('exp-bare')).not.toContain('critical_ready')
    expect(await page('exp-bare')).toContain('everything_ready')
  })

  it('stops counting an entity in the trend once it leaves the scope', async () => {
    await hub.scorecards.recordHistory()
    let trend = await json<{ series: Record<string, number[]> }>(await session('/v1/scorecards/critical_ready/trend?days=1'))
    expect(trend.series.none?.[0]).toBe(1)
    await session('/v1/entities/system/crit-bare', { method: 'PATCH', ...body({ fields: { tier: 'standard' } }) })
    expect((await results('critical_ready')).rows.map((r) => r.entity.key)).toEqual(['crit-docs'])
    await hub.scorecards.recordHistory()
    trend = await json<{ series: Record<string, number[]> }>(await session('/v1/scorecards/critical_ready/trend?days=1'))
    expect(trend.series.none?.[0]).toBe(0)
    expect(trend.series.Bronze?.[0]).toBe(1)
  })

  it('takes a history point from the stored rows, and builds no entity for it', async () => {
    await session('/v1/entities', { method: 'POST', ...body({ blueprint: 'system', key: 'crit-new', title: 'Crit new', fields: { tier: 'critical', docs: 'https://example.org/n' } }) })
    const listed = vi.spyOn(hub.reader, 'list')
    try {
      expect(await hub.scorecards.recordHistory()).toBeGreaterThan(0)
      expect(listed).not.toHaveBeenCalled()
      // Nothing moved since: a second pass writes no point.
      expect(await hub.scorecards.recordHistory()).toBe(0)
    } finally {
      listed.mockRestore()
    }
    const trend = await json<{ series: Record<string, number[]> }>(await session('/v1/scorecards/critical_ready/trend?days=1'))
    expect(trend.series.Bronze?.[0]).toBe(2)
    expect(trend.series.none?.[0]).toBe(0)
  })
})

describe('a trend field', () => {
  const put = (path: string, v: unknown) => session(path, { method: 'PUT', ...body(v) })
  const make = (blueprint: string, key: string, fields: Record<string, unknown> = {}, relations: Record<string, unknown> = {}) => session('/v1/entities', { method: 'POST', ...body({ blueprint, key, title: key, fields, relations }) })

  it('is checked on write, and reaches the thing it is about through an aggregation filtered to one pack', async () => {
    expect((await put('/v1/blueprints/trend_thing', { title: 'Thing', fields: {}, relations: {} })).status).toBe(200)
    expect((await put('/v1/blueprints/trend_verdict', { title: 'Verdict', fields: { pack: { type: 'string' }, trend: { type: 'trend' } }, relations: { thing: { target: 'trend_thing' } } })).status).toBe(200)
    const saved = await put('/v1/blueprints/trend_thing', { title: 'Thing', fields: {
      secure_trend: { type: 'trend', aggregation: { relation: '<-trend_verdict:thing', fn: 'max', field: 'trend', where: { field: 'pack', op: 'eq', value: 'secure' } } },
    }, relations: {} })
    expect(saved.status, await saved.clone().text()).toBe(200)
    await make('trend_thing', 'acct')
    const secure = { points: [{ at: '2026-10-01T00:00:00Z', value: 3 }, { at: '2026-11-02T00:00:00Z', value: 2 }], step: true, min: 0, max: 3, link: 'https://trellis.example.org/?open=s%3Astorage%7Cacct' }
    expect((await make('trend_verdict', 'secure/acct', { pack: 'secure', trend: secure }, { thing: 'acct' })).status).toBe(201)
    expect((await make('trend_verdict', 'governed/acct', { pack: 'governed', trend: { points: [{ at: '2026-10-01T00:00:00Z', value: 1 }] } }, { thing: 'acct' })).status).toBe(201)
    const bad = await make('trend_verdict', 'bad/acct', { pack: 'secure', trend: [3, 2, 1] }, { thing: 'acct' })
    expect(bad.status).toBe(400)
    expect((await json(bad)).error).toMatch(/trend/)
    expect((await json<EntityPageResponse>(await session('/v1/entities/trend_thing/acct'))).fields.secure_trend).toEqual(secure)
  })
})

describe('a scorecard level in filters and aggregations', () => {
  const put = (path: string, v: unknown) => session(path, { method: 'PUT', ...body(v) })
  const page = async (bp: string, key: string) => json<EntityPageResponse>(await session(`/v1/entities/${bp}/${key}`))
  const keysOf = async (bp: string, filter: unknown) => (await json<EntitiesResponse>(await session(`/v1/entities?blueprint=${bp}&filter=${encodeURIComponent(JSON.stringify(filter))}`))).entities.map((e) => e.key).sort()

  it('lets a program count what it owns at Silver or above, through a relation path', async () => {
    expect((await put('/v1/blueprints/estate_program', { title: 'Program', fields: {
      at_silver: { type: 'number', aggregation: { relation: '<-store:program', fn: 'count', where: { scorecard: 'store_secure', op: 'gte', value: 'Silver' } } },
      scored: { type: 'number', aggregation: { relation: '<-store:program', fn: 'count', where: { scorecard: 'store_secure', op: 'exists' } } },
    }, relations: {} })).status).toBe(400)
    // The blueprint names a scorecard that does not exist yet, so it is refused; create it in order.
    expect((await put('/v1/blueprints/estate_program', { title: 'Program', fields: {}, relations: {} })).status).toBe(200)
    expect((await put('/v1/blueprints/store', { title: 'Store', fields: { env: { type: 'string' }, tls: { type: 'string' }, private: { type: 'boolean' } }, relations: { program: { target: 'estate_program' } } })).status).toBe(200)
    expect((await put('/v1/scorecards/store_secure', { blueprint: 'store', title: 'Secure', where: { field: 'env', op: 'eq', value: 'Prod' }, levels: [
      { name: 'Bronze', rules: [{ id: 'tls', title: 'TLS', where: { field: 'tls', op: 'exists' } }] },
      { name: 'Silver', rules: [{ id: 'private', title: 'Private', where: { field: 'private', op: 'eq', value: true } }] },
    ] })).status).toBe(200)
    const aggregations = { title: 'Program', fields: {
      at_silver: { type: 'number', aggregation: { relation: '<-store:program', fn: 'count', where: { scorecard: 'store_secure', op: 'gte', value: 'Silver' } } },
      scored: { type: 'number', aggregation: { relation: '<-store:program', fn: 'count', where: { scorecard: 'store_secure', op: 'exists' } } },
    }, relations: {} }
    const saved = await put('/v1/blueprints/estate_program', aggregations)
    expect(saved.status, await saved.clone().text()).toBe(200)
    const make = (blueprint: string, key: string, fields: Record<string, unknown> = {}, relations: Record<string, unknown> = {}) => session('/v1/entities', { method: 'POST', ...body({ blueprint, key, title: key, fields, relations }) })
    await make('estate_program', 'erm')
    await make('store', 'prod-silver', { env: 'Prod', tls: '1.2', private: true }, { program: 'erm' })
    await make('store', 'prod-bronze', { env: 'Prod', tls: '1.2', private: false }, { program: 'erm' })
    await make('store', 'prod-none', { env: 'Prod' }, { program: 'erm' })
    // A test store that would pass every rule is out of scope: no level, so it counts toward neither.
    await make('store', 'test-all', { env: 'Test', tls: '1.2', private: true }, { program: 'erm' })

    expect((await page('estate_program', 'erm')).fields).toMatchObject({ at_silver: 1, scored: 3 })
    expect((await page('store', 'prod-silver')).levels).toEqual({ store_secure: ['Bronze', 'Silver'] })
    expect((await page('store', 'test-all')).levels).toEqual({})
    expect(await keysOf('store', { scorecard: 'store_secure', op: 'lt', value: 'Silver' })).toEqual(['prod-bronze', 'prod-none'])
    // A change on a store moves the program's count at its next read.
    await session('/v1/entities/store/prod-bronze', { method: 'PATCH', ...body({ fields: { private: true } }) })
    expect((await page('estate_program', 'erm')).fields).toMatchObject({ at_silver: 2, scored: 3 })
  })

  it('refuses a scorecard or a level that does not exist', async () => {
    const bad = await session(`/v1/entities?blueprint=store&filter=${encodeURIComponent(JSON.stringify({ scorecard: 'store_secure', op: 'gte', value: 'Platinum' }))}`)
    expect(bad.status).toBe(400)
    expect((await json(bad)).error).toMatch(/no level "Platinum"; its levels are none, Bronze, Silver/)
    const unknown = await session(`/v1/entities?blueprint=store&filter=${encodeURIComponent(JSON.stringify({ scorecard: 'nope', op: 'exists' }))}`)
    expect((await json(unknown)).error).toMatch(/no scorecard "nope"/)
  })

  it('lets one scorecard build on another, and refuses a loop on the scorecard and the blueprint side', async () => {
    const card = (id: string, where: unknown) => put(`/v1/scorecards/${id}`, { blueprint: 'store', title: id, levels: [{ name: 'Ok', rules: [{ id: 'r', title: 'r', where }] }] })
    expect((await card('store_ready', { scorecard: 'store_secure', op: 'gte', value: 'Bronze' })).status).toBe(200)
    expect((await page('store', 'prod-bronze')).levels).toMatchObject({ store_ready: ['Ok'] })
    expect((await page('store', 'prod-none')).levels).toMatchObject({ store_ready: [] })
    // Out of store_secure's scope, so store_ready's rule fails there.
    expect((await page('store', 'test-all')).levels).toEqual({ store_ready: [] })

    const loop = await put('/v1/scorecards/store_secure', { blueprint: 'store', title: 'Secure', levels: [{ name: 'Bronze', rules: [{ id: 'tls', title: 'TLS', where: { scorecard: 'store_ready', op: 'eq', value: 'Ok' } }] }] })
    expect(loop.status).toBe(400)
    expect((await json(loop)).error).toMatch(/would read its own level: scorecard store_secure → scorecard store_ready → scorecard store_secure/)
    const self = await card('store_self', { scorecard: 'store_self', op: 'exists' })
    expect((await json(self)).error).toMatch(/would read its own level: scorecard store_self → scorecard store_self/)
    // Through a field: a scorecard reads a count of what reached its own level.
    expect((await put('/v1/blueprints/store', { title: 'Store', fields: { env: { type: 'string' }, tls: { type: 'string' }, private: { type: 'boolean' }, ready_peers: { type: 'number', aggregation: { relation: 'program.<-store:program', fn: 'count', where: { scorecard: 'store_ready', op: 'eq', value: 'Ok' } } } }, relations: { program: { target: 'estate_program' } } })).status).toBe(200)
    const viaField = await card('store_ready', { field: 'ready_peers', op: 'gt', value: 0 })
    expect((await json(viaField)).error).toMatch(/scorecard store_ready → field store.ready_peers → scorecard store_ready/)
    // The blueprint side: a scorecard reads a field, and the field is changed to read that scorecard's level.
    expect((await put('/v1/blueprints/store', { title: 'Store', fields: { env: { type: 'string' }, tls: { type: 'string' }, private: { type: 'boolean' }, peers: { type: 'number' } }, relations: { program: { target: 'estate_program' } } })).status).toBe(200)
    expect((await card('store_peered', { field: 'peers', op: 'gt', value: 0 })).status).toBe(200)
    const field = await put('/v1/blueprints/store', { title: 'Store', fields: { env: { type: 'string' }, tls: { type: 'string' }, private: { type: 'boolean' }, peers: { type: 'number', aggregation: { relation: 'program.<-store:program', fn: 'count', where: { scorecard: 'store_peered', op: 'exists' } } } }, relations: { program: { target: 'estate_program' } } })
    expect(field.status).toBe(400)
    expect((await json(field)).error).toMatch(/would read its own level: .*scorecard store_peered/)
    // A rule may only read a level its own blueprint has.
    const elsewhere = await put('/v1/scorecards/system_on_store', { blueprint: 'system', title: 'x', levels: [{ name: 'Ok', rules: [{ id: 'r', title: 'r', where: { scorecard: 'store_secure', op: 'exists' } }] }] })
    expect((await json(elsewhere)).error).toMatch(/does not score system/)
  })
})

describe('one scorecard over several blueprints', () => {
  const put = (path: string, v: unknown) => session(path, { method: 'PUT', ...body(v) })
  const make = (blueprint: string, key: string, fields: Record<string, unknown> = {}) => session('/v1/entities', { method: 'POST', ...body({ blueprint, key, title: key, fields }) })
  const secure = {
    title: 'Secure',
    where: { field: 'env', op: 'eq', value: 'Prod' },
    levels: [{ name: 'Bronze' }, { name: 'Silver' }, { name: 'Gold' }],
    blueprints: {
      vault: { rules: { Bronze: [{ id: 'rbac', title: 'RBAC', where: { field: 'rbac', op: 'eq', value: true } }], Silver: [{ id: 'purge', title: 'Purge protection', where: { field: 'purge', op: 'eq', value: true } }] } },
      bucket: {
        where: { field: 'kind', op: 'neq', value: 'logs' },
        rules: { Bronze: [{ id: 'tls', title: 'TLS 1.2', where: { field: 'tls', op: 'exists' } }], Silver: [{ id: 'private', title: 'Private', where: { field: 'private', op: 'eq', value: true } }], Gold: [{ id: 'grs', title: 'GRS', where: { field: 'grs', op: 'eq', value: true } }] },
      },
    },
  }

  it('scores each blueprint by its own rules on the same levels, and its own scope on top of the shared one', async () => {
    expect((await put('/v1/blueprints/vault', { title: 'Vault', fields: { env: { type: 'string' }, rbac: { type: 'boolean' }, purge: { type: 'boolean' } }, relations: {} })).status).toBe(200)
    expect((await put('/v1/blueprints/bucket', { title: 'Bucket', fields: { env: { type: 'string' }, kind: { type: 'string' }, tls: { type: 'string' }, private: { type: 'boolean' }, grs: { type: 'boolean' } }, relations: {} })).status).toBe(200)
    const saved = await put('/v1/scorecards/secure', secure)
    expect(saved.status, await saved.clone().text()).toBe(200)
    await make('vault', 'v-silver', { env: 'Prod', rbac: true, purge: true })
    await make('vault', 'v-none', { env: 'Prod', rbac: false })
    await make('vault', 'v-test', { env: 'Test', rbac: true, purge: true })
    await make('bucket', 'b-gold', { env: 'Prod', kind: 'data', tls: '1.2', private: true, grs: true })
    await make('bucket', 'b-bronze', { env: 'Prod', kind: 'data', tls: '1.2' })
    await make('bucket', 'b-logs', { env: 'Prod', kind: 'logs', tls: '1.2', private: true, grs: true })

    const r = await json<ScorecardResults>(await session('/v1/scorecards/secure/results'))
    const level = Object.fromEntries(r.rows.map((x) => [x.entity.key, x.levelName]))
    // A vault has no Gold rule, so Silver is the highest it can stand on: a level with nothing checked is never reached.
    expect(level).toEqual({ 'v-silver': 'Silver', 'v-none': 'none', 'b-gold': 'Gold', 'b-bronze': 'Bronze' })
    expect(r.counts).toEqual([1, 1, 1, 1])
    // The test vault is out of the shared scope; the logs bucket out of the bucket's own.
    expect(r.outOfScope).toBe(2)
    expect(r.rows.find((x) => x.entity.key === 'v-silver')?.rules).toEqual({ rbac: true, purge: true })
    expect(r.rows.find((x) => x.entity.key === 'b-bronze')?.rules).toEqual({ tls: true, private: false, grs: false })

    // A level means the same on both blueprints, so one filter reads both.
    const silverUp = encodeURIComponent(JSON.stringify({ scorecard: 'secure', op: 'gte', value: 'Silver' }))
    const keysOf = async (bp: string) => (await json<EntitiesResponse>(await session(`/v1/entities?blueprint=${bp}&filter=${silverUp}`))).entities.map((e) => e.key).sort()
    expect(await keysOf('vault')).toEqual(['v-silver'])
    expect(await keysOf('bucket')).toEqual(['b-gold'])
    const page = await json<EntityPageResponse>(await session('/v1/entities/bucket/b-gold'))
    expect(page.scorecards).toEqual([{ scorecard: 'secure', title: 'Secure', level: 2, levelName: 'Gold', levels: ['Bronze', 'Silver', 'Gold'] }])
    expect((await json<EntityPageResponse>(await session('/v1/entities/bucket/b-logs'))).scorecards).toEqual([])
  })

  it('is refused when it names a blueprint, a level, or a field that does not exist', async () => {
    const error = async (spec: unknown) => (await json(await put('/v1/scorecards/secure_bad', spec))).error as string
    expect(await error({ ...secure, blueprints: { ...secure.blueprints, nope: { rules: { Bronze: [{ id: 'x', title: 'x', where: { field: 'x', op: 'exists' } }] } } } })).toMatch(/Unknown blueprint "nope"/)
    expect(await error({ ...secure, blueprints: { vault: { rules: { Platinum: [{ id: 'x', title: 'x', where: { field: 'rbac', op: 'exists' } }] } } } })).toMatch(/rules for level "Platinum", which the scorecard does not have; its levels are Bronze, Silver, Gold/)
    expect(await error({ ...secure, blueprints: { vault: { rules: { Bronze: [{ id: 'x', title: 'x', where: { field: 'tls', op: 'exists' } }] } } } })).toMatch(/On vault, a rule reads "tls", which blueprint "vault" does not have/)
    expect(await error({ ...secure, blueprints: { vault: { where: { field: 'kind', op: 'exists' }, rules: { Bronze: [{ id: 'x', title: 'x', where: { field: 'rbac', op: 'exists' } }] } } } })).toMatch(/On vault, a rule reads "kind"/)
    expect(await error({ ...secure, blueprint: 'vault' })).toMatch(/give either blueprint, with rules on each level, or blueprints/)
    expect(await error({ ...secure, levels: [{ name: 'Bronze', rules: [{ id: 'x', title: 'x', where: { field: 'rbac', op: 'exists' } }] }] })).toMatch(/a level holds only its name/)
    expect(await error({ ...secure, levels: [{ name: 'Bronze' }, { name: 'Bronze' }] })).toMatch(/level "Bronze" appears twice/)
    expect(await error({ ...secure, levels: [{ name: 'none' }] })).toMatch(/"none" is what an entity that reaches no level is called/)
  })

  it('leaves a one-blueprint scorecard exactly as it was: stored, listed, and scored', async () => {
    const one = { blueprint: 'vault', title: 'Vault basics', levels: [{ name: 'Bronze', rules: [{ id: 'rbac', title: 'RBAC', where: { field: 'rbac', op: 'eq', value: true } }] }, { name: 'Silver', rules: [{ id: 'purge', title: 'Purge', where: { field: 'purge', op: 'eq', value: true } }] }] }
    expect((await put('/v1/scorecards/vault_basics', one)).status).toBe(200)
    const stored = await hub.db.query<{ spec: unknown }>(`SELECT spec FROM scorecards WHERE id = 'vault_basics'`)
    expect(stored.rows[0]?.spec).toEqual({ ...one, id: 'vault_basics' })
    const listed = (await json<{ scorecards: Record<string, unknown>[] }>(await session('/v1/scorecards'))).scorecards.find((s) => s.id === 'vault_basics')
    expect(listed).toMatchObject({ ...one, id: 'vault_basics', origin: { kind: 'ui' } })
    expect(listed).not.toHaveProperty('blueprints')
    const r = await json<ScorecardResults>(await session('/v1/scorecards/vault_basics/results'))
    expect(Object.fromEntries(r.rows.map((x) => [x.entity.key, x.levelName]))).toEqual({ 'v-silver': 'Silver', 'v-none': 'none', 'v-test': 'Silver' })
    expect(r.counts).toEqual([1, 0, 2])
    expect(r.outOfScope).toBe(0)
  })

  it('follows a renamed blueprint', async () => {
    expect((await session('/v1/blueprints/vault/rename', { method: 'POST', ...body({ to: 'key_vault' }) })).status).toBe(200)
    expect(Object.keys(hub.scorecards.get('secure')?.blueprints ?? {}).sort()).toEqual(['bucket', 'key_vault'])
    expect(hub.scorecards.get('vault_basics')?.blueprint).toBe('key_vault')
    const r = await json<ScorecardResults>(await session('/v1/scorecards/secure/results'))
    expect(r.rows.find((x) => x.entity.key === 'v-silver')).toMatchObject({ entity: { blueprint: 'key_vault' }, levelName: 'Silver' })
  })
})

describe('model layout and catalog columns', () => {
  it('stores the shared model layout, and hands a blueprint back to automatic placement on null', async () => {
    const put = (v: unknown) => session('/v1/model/layout', { method: 'PUT', ...body(v) })
    expect(await json(await put({ positions: { service: { x: 100.4, y: 50 } }, hidden: ['workload'] }))).toEqual({ positions: { service: { x: 100, y: 50 } }, hidden: ['workload'], generation: MODEL_LAYOUT_GENERATION })
    expect(await json(await put({ positions: { service: null } }))).toEqual({ positions: {}, hidden: ['workload'], generation: MODEL_LAYOUT_GENERATION })
    // A read places every blueprint without a position, once, a hidden one too, so a reader may show it for themselves.
    const placed = await json<ModelLayout>(await session('/v1/model/layout'))
    expect(placed.hidden).toEqual(['workload'])
    expect(placed.positions.service).toBeDefined()
    expect(placed.positions.workload).toBeDefined()
    expect(Object.keys(placed.positions).length).toBeGreaterThan(5)
    expect(await json<ModelLayout>(await session('/v1/model/layout'))).toEqual(placed)
    const viewer = (await hub.sources.issueToken('access', 'viewer', { role: 'viewer' })).token
    expect((await machine('/v1/model/layout', { method: 'PUT', ...body({ hidden: [] }) }, viewer)).status).toBe(403)
    // A layout an older generation placed is laid out again, once, and keeps what was hidden.
    await hub.db.query(`UPDATE settings SET value = (value::jsonb - 'generation')::json WHERE key = 'model.layout'`)
    const redone = await json<ModelLayout>(await session('/v1/model/layout'))
    expect(redone.generation).toBe(placed.generation)
    expect(redone.hidden).toEqual(['workload'])
    expect(Object.keys(redone.positions).sort()).toEqual(Object.keys(placed.positions).sort())
  })

  it('rearranges what is shown from scratch, forgetting hand placements, and sets each hidden one beside its neighbours', async () => {
    const put = (v: unknown) => session('/v1/model/layout', { method: 'PUT', ...body(v) })
    await session('/v1/model/layout')
    const shown = ['service', 'repository']
    const hidden = hub.blueprints.list().map((b) => b.id).filter((id) => !shown.includes(id))
    await put({ positions: { service: { x: 9000, y: 9000 } }, hidden })
    const laid = await json<ModelLayout>(await put({ rearrange: true }))
    expect(Object.keys(laid.positions).sort()).toEqual(hub.blueprints.list().map((b) => b.id).sort())
    expect(laid.hidden).toEqual(hidden)
    // Two related cards are laid out side by side, a tier apart, not where the whole model put them.
    const gap = Math.abs(laid.positions.service!.x - laid.positions.repository!.x) + Math.abs(laid.positions.service!.y - laid.positions.repository!.y)
    expect(gap).toBeLessThan(1000)
    expect(await json<ModelLayout>(await session('/v1/model/layout'))).toEqual(laid)
    // A hidden blueprint shown again keeps the place it was given, and nothing moves.
    const back = await json<ModelLayout>(await (await put({ hidden: hidden.filter((id) => id !== 'workload') }), session('/v1/model/layout')))
    expect(back.positions).toEqual(laid.positions)
  })


  it('lists who points at each entity when asked, and follows blueprint-qualified incoming relations', async () => {
    await machine('/v1/ingest/entities/repository/github%2Fexample%2Fstorefront', { method: 'PUT', ...body({ title: 'storefront', fields: { name: 'storefront', url: 'https://github.com/example/storefront', last_push: new Date(Date.now() - 3 * 86_400_000).toISOString() } }) })
    await machine('/v1/ingest/entities/argocd_app/home%2Fargocd%2Fstorefront', { method: 'PUT', ...body({ title: 'storefront', fields: { repo_url: 'https://github.com/example/storefront', sync_status: 'OutOfSync', health_status: 'Healthy', health: 'amber' } }) })
    // A service and a workload keyed by the name link themselves to the repository and to what hosts them.
    await session('/v1/entities', { method: 'POST', ...body({ blueprint: 'service', key: 'storefront', title: 'Storefront' }) })
    await session('/v1/entities', { method: 'POST', ...body({ blueprint: 'workload', key: 'storefront', title: 'Storefront', relations: { environment: 'production' } }) })
    await hub.rules.evaluateAll()
    type Listed = { entities: { key: string; fields: Record<string, unknown>; incomingRefs?: Record<string, { key: string }[]> }[] }
    const repo = (await json<Listed>(await session('/v1/entities?blueprint=repository&incoming=true'))).entities.find((e) => e.key === 'github/example/storefront')
    expect(repo?.incomingRefs?.['argocd_app.repository']).toEqual([{ blueprint: 'argocd_app', key: 'home/argocd/storefront', title: 'storefront' }])
    expect(repo?.incomingRefs?.['service.repository']).toEqual([{ blueprint: 'service', key: 'storefront', title: 'Storefront' }])
    const workload = (await json<Listed>(await session('/v1/entities?blueprint=workload&incoming=true'))).entities.find((e) => e.key === 'storefront')
    expect(workload?.incomingRefs?.['k8s_workload.workload']?.[0]?.key).toBe('home/shop/storefront')
    expect(workload?.fields).toMatchObject({ sync_status: 'OutOfSync', cluster_workloads: 1 })
    const svc = (await json<Listed>(await session('/v1/entities?blueprint=service'))).entities.find((e) => e.key === 'storefront')
    expect(svc?.fields).toMatchObject({ workloads: 1, freshness_days: 3 })
  })
})

describe('who points at a grid row', () => {
  it('names the first few under each relation and counts them all, but in full where a scorecard rule names one', async () => {
    const put = (path: string, v: unknown) => session(path, { method: 'PUT', ...body(v) })
    expect((await put('/v1/blueprints/shelf', { id: 'shelf', title: 'Shelf', fields: {}, relations: {} })).status).toBe(200)
    expect((await put('/v1/blueprints/book', { id: 'book', title: 'Book', fields: {}, relations: { shelf: { target: 'shelf' } } })).status).toBe(200)
    expect((await put('/v1/blueprints/lamp', { id: 'lamp', title: 'Lamp', fields: {}, relations: { shelf: { target: 'shelf' } } })).status).toBe(200)
    await session('/v1/entities', { method: 'POST', ...body({ blueprint: 'shelf', key: 's1', title: 's1' }) })
    for (const n of [1, 2, 3, 4, 5]) await session('/v1/entities', { method: 'POST', ...body({ blueprint: 'book', key: `b${n}`, title: `b${n}`, relations: { shelf: 's1' } }) })
    for (const n of [1, 2, 3]) await session('/v1/entities', { method: 'POST', ...body({ blueprint: 'lamp', key: `l${n}`, title: `l${n}`, relations: { shelf: 's1' } }) })
    type Row = { key: string; incomingRefs?: Record<string, { key: string }[]>; incomingCount?: Record<string, number> }
    const row = async (incoming: string) => (await json<{ entities: Row[] }>(await session(`/v1/entities?blueprint=shelf&distribution=true&incoming=${incoming}`))).entities.find((e) => e.key === 's1')!
    const all = await row('true')
    expect(all.incomingRefs?.['book.shelf']).toHaveLength(5)
    expect(all.incomingCount).toBeUndefined()
    // Only what is shown leaves the database: every link is counted there, and none is read whole to be cut here.
    const whole = vi.spyOn(hub.reader, 'incomingFor')
    const few = await row('2')
    expect(whole).not.toHaveBeenCalled()
    whole.mockRestore()
    expect(few.incomingRefs?.['book.shelf']?.map((r) => r.key)).toEqual(['b1', 'b2'])
    expect(few.incomingCount).toEqual({ 'book.shelf': 5, 'lamp.shelf': 3 })
    // A rule that asks whether one book points here reads every book, so a grid's rule cell answers as the hub does.
    expect((await put('/v1/scorecards/shelf_ready', { id: 'shelf_ready', blueprint: 'shelf', title: 'Ready', levels: [{ name: 'Bronze', rules: [{ id: 'b5', title: 'Holds b5', where: { relation: '<-book:shelf', target: 'book:b5' } }] }] })).status).toBe(200)
    const kept = await row('2')
    expect(kept.incomingRefs?.['book.shelf']).toHaveLength(5)
    expect(kept.incomingRefs?.['lamp.shelf']).toHaveLength(2)
  })
})

describe('an older catalog', () => {
  it('still loads a blueprint that says how a canvas showed it, and drops the setting', async () => {
    expect((await session('/v1/blueprints/old_thing', { method: 'PUT', ...body({ title: 'Old thing', canvas: { default: 'hidden' } }) })).status).toBe(200)
    expect(await json<Record<string, unknown>>(await session('/v1/blueprints/old_thing'))).not.toHaveProperty('canvas')
  })
})

describe('editing in place', () => {
  type Detail = { icon: string | null; fields: Record<string, unknown>; provenance: Record<string, { layer: string }> }
  const widget = async (key: string) => json<Detail>(await session(`/v1/entities/widget/${key}?provenance=true`))
  const push = (key: string, extra: Record<string, unknown> = {}) => machine(`/v1/ingest/entities/widget/${key}`, { method: 'PUT', ...body({ title: key.toUpperCase(), ...extra }) })
  const edit = (key: string, fields: Record<string, unknown>) => session(`/v1/entities/widget/${key}`, { method: 'PATCH', ...body({ fields }) })

  it('shows the blueprint icon until a source or a person gives an entity its own', async () => {
    expect((await session('/v1/blueprints/widget', { method: 'PUT', ...body({ title: 'Widget', icon: 'cube', fields: { size: { type: 'enum', values: ['s', 'm', 'l'] }, cost: { type: 'number', overridable: false } } }) })).status).toBe(200)
    expect((await push('a')).status).toBe(201)
    let a = await widget('a')
    expect(a.icon).toBe('cube')
    expect(a.provenance.icon?.layer).toBe('default')
    // A person picks one. No source pushes an icon, so it is a value of theirs and a later push leaves it alone.
    expect((await edit('a', { icon: 'database' })).status).toBe(200)
    expect((await push('a')).status).toBe(200)
    a = await widget('a')
    expect(a.icon).toBe('database')
    expect(a.provenance.icon?.layer).toBe('ui')
    expect(a.fields).not.toHaveProperty('icon')
    // A pushed icon wins over the blueprint's; a person's change to it is an override, and clearing that goes back to the push.
    expect((await push('b', { icon: 'azure_functions' })).status).toBe(201)
    expect((await widget('b')).provenance.icon?.layer).toBe('pushed')
    await edit('b', { icon: 'rocket' })
    let b = await widget('b')
    expect(b.icon).toBe('rocket')
    expect(b.provenance.icon?.layer).toBe('override')
    await edit('b', { icon: null })
    b = await widget('b')
    expect(b.icon).toBe('azure_functions')
    await edit('a', { icon: null })
    expect((await widget('a')).icon).toBe('cube')
    // The name is the hub's, like title.
    const taken = await session('/v1/blueprints/widget_two', { method: 'PUT', ...body({ title: 'Widget two', fields: { icon: { type: 'string' } } }) })
    expect(taken.status).toBe(400)
    expect((await json(taken)).error).toMatch(/reserved/)
  })

  it('takes a field named icon out of a blueprint stored before the name was reserved', async () => {
    const stored = { id: 'legacy_area', title: 'Legacy area', icon: 'map', fields: { icon: { type: 'string' }, notes: { type: 'markdown' } }, relations: {} }
    await hub.db.query(`INSERT INTO blueprints (id, spec, origin) VALUES ('legacy_area', $1, '{"kind":"ui"}')`, [JSON.stringify(stored)])
    await hub.blueprints.load()
    expect(Object.keys(hub.blueprints.get('legacy_area')?.fields ?? {})).toEqual(['notes'])
    // What its pusher still sends under the old field is no icon the hub knows, so the blueprint's shows.
    expect((await machine('/v1/ingest/entities/legacy_area/den', { method: 'PUT', ...body({ title: 'Den', fields: { icon: 'mdi:sofa' } }) })).status).toBe(201)
    expect((await json<{ icon: string }>(await session('/v1/entities/legacy_area/den'))).icon).toBe('map')
    // And the blueprint can be added to again.
    const offer = await json<{ extended: string[]; rejected: unknown[] }>(await machine('/v1/ingest/blueprints', { method: 'PUT', ...body({ blueprints: [{ id: 'legacy_area', title: 'Legacy area', fields: { hass_icon: { type: 'string' } } }] }) }))
    expect(offer).toMatchObject({ extended: ['legacy_area'], rejected: [] })
  })

  it('makes nothing when a new entity carries a value the blueprint refuses', async () => {
    const refused = await session('/v1/entities', { method: 'POST', ...body({ blueprint: 'widget', key: 'c', title: 'C', fields: { cost: 5 } }) })
    expect(refused.status).toBe(403)
    expect((await session('/v1/entities/widget/c')).status).toBe(404)
  })

  it('tells a grid which layer won, and makes one edit to many entities', async () => {
    const refs = [{ blueprint: 'widget', key: 'a' }, { blueprint: 'widget', key: 'b' }]
    const bulk = async (change: Record<string, unknown>) => json<{ changed: number; refused: { key: string; reason: string }[] }>(await session('/v1/entities/bulk', { method: 'POST', ...body({ entities: refs, ...change }) }))
    expect(await bulk({ fields: { size: 'm', icon: 'rocket' } })).toEqual({ changed: 2, refused: [] })
    type Row = { key: string; icon: string; hidden: boolean; fields: Record<string, unknown>; layers?: Record<string, string> }
    const list = async (query: string) => (await json<{ entities: Row[] }>(await session(`/v1/entities?blueprint=widget&${query}`))).entities
    const rows = await list('layers=true')
    expect(rows.map((r) => r.fields.size)).toEqual(['m', 'm'])
    expect(rows.find((r) => r.key === 'a')?.layers).toMatchObject({ title: 'pushed', size: 'ui', icon: 'ui' })
    expect(rows.find((r) => r.key === 'b')?.layers).toMatchObject({ icon: 'override' })
    expect((await list(''))[0]).not.toHaveProperty('layers')
    // One refusal does not stop the rest, and each is named.
    const refused = await bulk({ fields: { cost: 5 } })
    expect(refused.changed).toBe(0)
    expect(refused.refused.map((r) => r.reason)).toEqual([expect.stringMatching(/is locked/), expect.stringMatching(/is locked/)])
    // Hidden entities leave every view until it asks for them, and come back.
    expect((await bulk({ hidden: true })).changed).toBe(2)
    expect(await list('')).toEqual([])
    expect((await list('hidden=true')).map((r) => r.hidden)).toEqual([true, true])
    expect((await bulk({ hidden: false })).changed).toBe(2)
    expect((await list('')).map((r) => r.hidden)).toEqual([false, false])
  })

  it('keeps the fields of a blueprint in the order they were written, after a reload', async () => {
    const fields = { zone: { type: 'string' }, at: { type: 'datetime' }, environment: { type: 'enum', values: ['prod'], colors: { prod: 'red' } }, id_hint: { type: 'string' } }
    expect((await session('/v1/blueprints/ordered', { method: 'PUT', ...body({ title: 'Ordered', fields }) })).status).toBe(200)
    await hub.blueprints.load()
    expect(Object.keys(hub.blueprints.get('ordered')!.fields)).toEqual(['zone', 'at', 'environment', 'id_hint'])
    expect(hub.blueprints.get('ordered')!.fields.environment!.colors).toEqual({ prod: 'red' })
  })

  it('counts how every matching row shares out a column, past the page it sends', async () => {
    await session('/v1/entities/widget/b', { method: 'PATCH', ...body({ fields: { size: null } }) })
    const res = await json<EntitiesResponse>(await session('/v1/entities?blueprint=widget&limit=1&distribution=true'))
    expect(res.entities).toHaveLength(1)
    expect(res.distribution?.['f:size']).toEqual({ buckets: [{ value: 'm', label: 'm', count: 1 }, { value: null, label: 'No value', count: 1 }], other: 0 })
    expect(res.distribution?.state).toEqual({ buckets: [{ value: 'active', label: 'active', count: 2 }], other: 0 })
    // Status counts by level, for the grid's status picker, and a pick of levels filters on it.
    expect(res.distribution?.status).toEqual({ buckets: [{ value: 'green', label: 'green', count: 2 }], other: 0 })
    const picked = async (levels: string[]) => (await json<EntitiesResponse>(await session(`/v1/entities?blueprint=widget&filter=${encodeURIComponent(JSON.stringify({ field: '$status', op: 'in', value: levels }))}`))).total
    expect(await picked(['red', 'amber'])).toBe(0)
    expect(await picked(['green', 'grey'])).toBe(2)
    // A number is not a few kinds of value, and a grid that does not ask gets no counts.
    expect(res.distribution).not.toHaveProperty('f:cost')
    expect(await json(await session('/v1/entities?blueprint=widget'))).not.toHaveProperty('distribution')
  })
})
