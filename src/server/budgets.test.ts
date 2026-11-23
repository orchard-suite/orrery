import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Budgets, ChangesResponse, FindingsResponse, LoadResponse } from '../shared/api.ts'
import { loadConfig } from './config.ts'
import { loadFixtureCatalog } from './fixtures/load.ts'
import { createHub, type Hub } from './hub.ts'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://orrery:orrery@localhost:5433/orrery'

let hub: Hub
let pusher = ''
let reader = ''

const ADMIN = 'ops@example.org'
const as = (email: string, groups: string, path: string, init?: RequestInit) => Promise.resolve(hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', 'x-forwarded-email': email, 'x-forwarded-groups': groups, ...init?.headers } }, { surface: 'session' }))
const admin = (path: string, init?: RequestInit) => as(ADMIN, 'Admin', path, init)
const machine = (bearer: string, path: string, init?: RequestInit) => Promise.resolve(hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}`, ...init?.headers } }, { surface: 'machine' }))
const body = (v: unknown) => ({ body: JSON.stringify(v) })
const set = (budgets: Partial<Budgets>) => admin('/v1/budgets', { method: 'PUT', ...body(budgets) })
const overBudget = async () => ((await (await admin('/v1/findings')).json()) as FindingsResponse).findings.filter((f) => f.kind === 'over_budget')
const node = (key: string, cpu = 8) => ({ blueprint: 'k8s_node', key: `home/${key}`, title: key, fields: { cpu, memory_gb: 32, ready: true, health: 'green' }, relations: { cluster: 'home' } })

/** Calls an agent tool with a token; answers with the whole JSON-RPC message. */
async function call(bearer: string, name: string, args: Record<string, unknown>): Promise<{ result?: { content: { text: string }[]; isError?: boolean }; error?: { message: string } }> {
  const res = await machine(bearer, '/mcp', { method: 'POST', headers: { accept: 'application/json, text/event-stream' }, ...body({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })
  return (await res.json()) as Awaited<ReturnType<typeof call>>
}

/** Calls an agent tool with a token; answers with what the tool said. */
async function tool(bearer: string, name: string, args: Record<string, unknown>): Promise<unknown> {
  return JSON.parse((await call(bearer, name, args)).result!.content[0]!.text)
}

/** Opens a snapshot, sends the entities, and commits; answers with the status of each step that was reached. */
async function snapshot(entities: unknown[]): Promise<{ open: number; batch?: number; rejected?: { reason: string }[] }> {
  const opened = await machine(pusher, '/v1/ingest/runs', { method: 'POST', ...body({ mode: 'snapshot', scope: 'home' }) })
  if (opened.status !== 201) return { open: opened.status }
  const run = (await opened.json()) as { id: string }
  const batch = await machine(pusher, `/v1/ingest/runs/${run.id}/entities`, { method: 'PUT', ...body({ entities }) })
  const result = (await batch.json()) as { rejected?: { reason: string }[] }
  expect((await machine(pusher, `/v1/ingest/runs/${run.id}/commit`, { method: 'POST' })).status).toBe(200)
  return { open: opened.status, batch: batch.status, rejected: result.rejected }
}

beforeAll(async () => {
  hub = await createHub(loadConfig({ DATABASE_URL, DATA_DIR: mkdtempSync(join(tmpdir(), 'orrery-')), AUTH_MODE: 'proxy' }), 'test', { reset: true })
  expect((await loadFixtureCatalog(hub)).errors).toEqual([])
  await hub.sources.save('k8s@home', { title: 'k8s home', class: 'pusher', blueprints: ['*'], deleteGrant: [], cadence: '3m' })
  pusher = (await hub.sources.issueToken('source', 'home pusher', { source: 'k8s@home' })).token
  reader = (await hub.sources.issueToken('access', 'report', { role: 'viewer' })).token
  await hub.deriver.backfill()
})

afterAll(async () => {
  await hub.close()
})

describe('budgets', () => {
  it('holds none until one is set, and takes only one that reads', async () => {
    expect(await (await admin('/v1/budgets')).json()).toEqual({ changes: {}, calls: {}, entities: {}, reads: {} })
    expect((await set({ changes: { 'k8s@home': { warn: 9, limit: 3 } } })).status).toBe(400)
    expect((await set({ changes: { 'k8s@home': {} } })).status).toBe(400)
    expect((await as('dev@example.org', 'User', '/v1/budgets', { method: 'PUT', ...body({}) })).status).toBe(403)
    expect(await overBudget()).toEqual([])
  })

  it('raises a finding for a source past its warning and still takes its writes', async () => {
    expect((await set({ changes: { '*': { warn: 2, limit: 5 } } })).status).toBe(200)
    expect(await snapshot([{ blueprint: 'k8s_cluster', key: 'home', title: 'home' }, node('n1'), node('n2')])).toMatchObject({ open: 201, batch: 200 })
    const findings = await overBudget()
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ level: 'amber', source: 'k8s@home', title: 'Source k8s@home changed 3 entities in an hour; its budget is 2' })
    const load = (await (await admin('/v1/load?hours=1')).json()) as LoadResponse
    expect(load.budgets.changes['*']).toEqual({ warn: 2, limit: 5 })
    expect(load.use.changes['k8s@home']).toEqual({ now: 3, peak: 3 })
  })

  it('refuses a source past its limit until the hour turns, and says why', async () => {
    expect(await snapshot([{ blueprint: 'k8s_cluster', key: 'home', title: 'home' }, node('n1', 16), node('n2', 16)])).toMatchObject({ open: 201, batch: 200 })
    const refused = await machine(pusher, '/v1/ingest/runs', { method: 'POST', ...body({ mode: 'snapshot', scope: 'home' }) })
    expect(refused.status).toBe(429)
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(((await refused.json()) as { error: string }).error).toContain('Source "k8s@home" changed 5 entities this hour; its budget is 5')
    expect((await machine(pusher, '/v1/ingest/entities/k8s_node/home%2Fn1', { method: 'PATCH', ...body({ fields: { cpu: 4 } }) })).status).toBe(429)
    expect((await overBudget())[0]).toMatchObject({ level: 'red', source: 'k8s@home' })
    // Its own budget wins over the one for every source.
    expect((await set({ changes: { '*': { warn: 2, limit: 5 }, 'k8s@home': { limit: 1000 } } })).status).toBe(200)
    expect((await machine(pusher, '/v1/ingest/entities/k8s_node/home%2Fn1', { method: 'PATCH', ...body({ fields: { cpu: 4 } }) })).status).toBe(200)
    expect(await overBudget()).toEqual([])
  })

  it('refuses a new entity of a blueprint that holds its limit, and still takes changes to what it holds', async () => {
    expect((await set({ entities: { k8s_node: { limit: 2 } } })).status).toBe(200)
    const sent = await snapshot([{ blueprint: 'k8s_cluster', key: 'home', title: 'home' }, node('n1', 2), node('n2'), node('n3')])
    expect(sent.batch).toBe(207)
    expect(sent.rejected).toHaveLength(1)
    expect(sent.rejected![0]!.reason).toContain('blueprint "k8s_node" holds 2 entities; its budget is 2')
    expect((await hub.db.query(`SELECT 1 FROM entities WHERE blueprint = 'k8s_node'`)).rowCount).toBe(2)
    expect((await hub.db.query<{ cpu: number }>(`SELECT (pushed->'cpu'->>'value')::int AS cpu FROM entities WHERE key = 'home/n1'`)).rows[0]!.cpu).toBe(2)
    expect((await admin('/v1/entities', { method: 'POST', ...body({ blueprint: 'k8s_node', key: 'home/by-hand', title: 'by hand' }) })).status).toBe(409)
    expect((await overBudget())[0]).toMatchObject({ level: 'red', blueprint: 'k8s_node' })
  })

  it('refuses a token past its calls for the hour, and never a person', async () => {
    expect((await set({ calls: { '*': { limit: 2 } } })).status).toBe(200)
    expect((await machine(reader, '/v1/blueprints')).status).toBe(200)
    expect((await machine(reader, '/v1/blueprints')).status).toBe(200)
    const refused = await machine(reader, '/v1/blueprints')
    expect(refused.status).toBe(429)
    expect(((await refused.json()) as { error: string }).error).toContain('"report" made 2 API calls this hour; its budget is 2')
    // What says who it is, what it used, and what it is held to still answers it.
    expect((await machine(reader, '/v1/whoami')).status).toBe(200)
    for (let i = 0; i < 4; i++) expect((await admin('/v1/blueprints')).status).toBe(200)
    expect((await set({})).status).toBe(200)
    expect((await machine(reader, '/v1/blueprints')).status).toBe(200)
  })

  it('reads the load and reads and sets the budgets as agent tools, by permission', async () => {
    const ops = (await hub.sources.issueToken('access', 'ops-agent', { role: 'admin' })).token
    const held = { changes: { '*': { warn: 2000 } }, calls: { report: { warn: 50, limit: 500 } }, entities: {}, reads: {} }
    expect(await tool(reader, 'get_load', {})).toEqual({ error: 'This needs the "audit.view" permission' })
    expect(await tool(reader, 'set_budgets', held)).toEqual({ error: 'This needs the "budgets.set" permission' })
    expect(await tool(ops, 'set_budgets', held)).toEqual(held)
    expect(await tool(ops, 'get_budgets', {})).toEqual(held)
    expect(await (await admin('/v1/budgets')).json()).toEqual(held)
    const load = (await tool(ops, 'get_load', { hours: 1 })) as LoadResponse
    expect(load.budgets).toEqual(held)
    expect(load.use.calls.report).toMatchObject({ now: expect.any(Number) })
    // A set that leaves a kind out, or holds a budget that does not read, changes nothing.
    expect(JSON.stringify(await call(ops, 'set_budgets', { changes: {}, calls: {}, entities: {} }))).toContain('reads')
    expect(JSON.stringify(await call(ops, 'set_budgets', { ...held, calls: { report: { warn: 9, limit: 3 } } }))).toContain('warn must not be above limit')
    expect(await tool(ops, 'get_budgets', {})).toEqual(held)
    // The log names the agent that set them, and the one that was refused.
    const { changes } = (await (await admin('/v1/changes?limit=50')).json()) as ChangesResponse
    expect(changes.find((c) => c.kind === 'budgets.changed')).toMatchObject({ actor: 'ops-agent', outcome: 'ok', detail: { budgets: held } })
    expect(changes.find((c) => c.kind === 'access.refused' && c.detail.tool === 'set_budgets')).toMatchObject({ actor: 'report', outcome: 'refused', detail: { permission: 'budgets.set' } })
    expect(await tool(ops, 'set_budgets', { changes: {}, calls: {}, entities: {}, reads: {} })).toEqual({ changes: {}, calls: {}, entities: {}, reads: {} })
  })
})
