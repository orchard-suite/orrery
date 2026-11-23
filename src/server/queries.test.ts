import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { QueryAnswer, QueryAudiencesResponse, QueryResult, QuerySpec, SavedQueriesResponse, SavedQuery } from '../shared/api.ts'
import { loadConfig } from './config.ts'
import { loadFixtureCatalog } from './fixtures/load.ts'
import { createHub, type Hub } from './hub.ts'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://orrery:orrery@localhost:5433/orrery'

let hub: Hub
let pusher = ''

const as = (email: string, groups: string) => (path: string, init?: RequestInit) => Promise.resolve(hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', 'x-forwarded-email': email, 'x-forwarded-groups': groups, ...init?.headers } }, { surface: 'session' }))
const admin = as('ops@example.org', 'Admin')
const ada = as('ada@example.org', 'Admin')
const machine = (path: string, init?: RequestInit) => Promise.resolve(hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${pusher}`, ...init?.headers } }, { surface: 'machine' }))
const body = (v: unknown) => ({ body: JSON.stringify(v) })
const json = async <T>(r: Response): Promise<T> => (await r.json()) as T

/** The files of a zip, by name, each inflated. */
function unzip(bytes: Buffer): Map<string, string> {
  const out = new Map<string, string>()
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  let at = bytes.readUInt32LE(end + 16)
  for (let i = 0; i < bytes.readUInt16LE(end + 10); i++) {
    const size = bytes.readUInt32LE(at + 20)
    const nameLength = bytes.readUInt16LE(at + 28)
    const local = bytes.readUInt32LE(at + 42)
    const name = bytes.subarray(at + 46, at + 46 + nameLength).toString()
    const data = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28)
    out.set(name, inflateRawSync(bytes.subarray(data, data + size)).toString())
    at += 46 + nameLength + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32)
  }
  return out
}

beforeAll(async () => {
  hub = await createHub(loadConfig({ DATABASE_URL, DATA_DIR: mkdtempSync(join(tmpdir(), 'orrery-')), AUTH_MODE: 'proxy' }), 'test', { reset: true })
  expect((await loadFixtureCatalog(hub)).errors).toEqual([])
  await hub.sources.save('k8s@home', { title: 'k8s home', class: 'pusher', blueprints: ['*'], deleteGrant: [], cadence: '3m' })
  pusher = (await hub.sources.issueToken('source', 'home pusher', { source: 'k8s@home' })).token
  for (const c of ['home', 'lab']) expect((await machine(`/v1/ingest/entities/k8s_cluster/${c}`, { method: 'PUT', ...body({ title: c }) })).status).toBeLessThan(300)
  for (const [n, cpu, cluster] of [['n1', 4, 'home'], ['n2', 16, 'home'], ['n3', 32, 'lab']] as const) {
    expect((await machine(`/v1/ingest/entities/k8s_node/${cluster}%2F${n}`, { method: 'PUT', ...body({ title: n, fields: { cpu, ready: true, health: 'green' }, relations: { cluster } }) })).status).toBeLessThan(300)
  }
  await hub.deriver.backfill()
})

afterAll(async () => {
  await hub.close()
})

const spec: QuerySpec = {
  sources: [{ blueprint: 'k8s_node', clauses: [{ field: 'cpu', op: 'gt', value: '8' }] }, { blueprint: 'k8s_cluster', clauses: [] }],
  columns: ['$type', 'title', 'cpu', 'r:cluster', 'nothing_has_this'],
}

describe('a query', () => {
  it('reads every match of each blueprint into one table, a column shared by its id', async () => {
    const res = await admin('/v1/query', { method: 'POST', ...body(spec) })
    expect(res.status).toBe(200)
    const out = await json<QueryResult>(res)
    expect(out.columns.map((c) => c.title)).toEqual(['Type', 'Title', 'CPU cores', 'Cluster'])
    expect(out.counts).toEqual({ k8s_node: 2, k8s_cluster: 2 })
    expect(out.truncated).toBe(false)
    const byKey = Object.fromEntries(out.rows.map((r) => [r.key, r.values]))
    expect(byKey['home/n2']).toEqual(['Kubernetes node', 'n2', 16, ['home']])
    expect(byKey['lab/n3']).toEqual(['Kubernetes node', 'n3', 32, ['lab']])
    expect(byKey['home']).toEqual(['Kubernetes cluster', 'home', null, null])
    expect(byKey['home/n1']).toBeUndefined()
    expect(out.columns.find((c) => c.id === 'cpu')?.from).toEqual({ k8s_node: 'cpu' })
    expect(out.columns.find((c) => c.id === 'title')?.from).toEqual({ k8s_node: 'title', k8s_cluster: 'title' })
  })

  it('reads its own field from each blueprint in a column that names them, and says which', async () => {
    const res = await admin('/v1/query', {
      method: 'POST',
      ...body({ sources: spec.sources, columns: ['title', 'version', { id: 'size', title: 'Size', from: { k8s_node: 'cpu', k8s_cluster: 'nodes' } }, { id: 'gone', title: 'Gone', from: { k8s_node: 'no_such_field' } }] }),
    })
    expect(res.status).toBe(200)
    const out = await json<QueryResult>(res)
    expect(out.columns).toEqual([
      { id: 'title', title: 'Title', from: { k8s_node: 'title', k8s_cluster: 'title' } },
      { id: 'version', title: 'Kubelet version', from: { k8s_node: 'version', k8s_cluster: 'version' } },
      { id: 'size', title: 'Size', from: { k8s_node: 'cpu', k8s_cluster: 'nodes' } },
      { id: 'gone', title: 'Gone', from: {} },
    ])
    const byKey = Object.fromEntries(out.rows.map((r) => [r.key, r.values]))
    expect(byKey['lab/n3']).toEqual(['n3', null, 32, null])
    expect(byKey['home']).toEqual(['home', null, 2, null])
  })

  it('refuses a blueprint the hub does not know', async () => {
    const res = await admin('/v1/query', { method: 'POST', ...body({ sources: [{ blueprint: 'no_such', clauses: [] }], columns: [] }) })
    expect(res.status).toBe(404)
  })

  it('exports as a workbook: every row on one sheet, and a sheet for each blueprint', async () => {
    const res = await admin('/v1/query/export', { method: 'POST', ...body({ spec, title: 'Big nodes' }) })
    expect(res.headers.get('content-type')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="Big nodes.xlsx"')
    const files = unzip(Buffer.from(await res.arrayBuffer()))
    expect(files.get('xl/workbook.xml')).toContain('name="Big nodes"')
    expect(files.get('xl/workbook.xml')).toContain('name="Kubernetes node"')
    const all = files.get('xl/worksheets/sheet1.xml')!
    expect(all).toContain('<t xml:space="preserve">CPU cores</t>')
    expect(all).toContain('<v>32</v>')
    expect(all).toContain('<autoFilter ref="A1:D5"/>')
  })

  it('exports money as the amount a person reads, with a money format', async () => {
    const usd = { kind: 'currency', currency: 'USD', minor: true }
    expect((await admin('/v1/blueprints/invoice', { method: 'PUT', ...body({ title: 'Invoice', fields: { total_cents: { type: 'number', format: usd } }, relations: {} }) })).status).toBe(200)
    expect((await machine('/v1/ingest/entities/invoice/march', { method: 'PUT', ...body({ title: 'March', fields: { total_cents: 2470277 } }) })).status).toBeLessThan(300)
    const res = await admin('/v1/query/export', { method: 'POST', ...body({ spec: { sources: [{ blueprint: 'invoice', clauses: [] }], columns: ['title', 'total_cents'] }, title: 'Invoices' }) })
    const files = unzip(Buffer.from(await res.arrayBuffer()))
    expect(files.get('xl/styles.xml')).toContain('formatCode="&quot;$&quot;#,##0.00;-&quot;$&quot;#,##0.00"')
    expect(files.get('xl/worksheets/sheet1.xml')).toContain('<c r="B2" s="2"><v>24702.77</v></c>')
  })

  it('reads a field named as a column every entity has as the field, and the entity’s own under its $ name', async () => {
    expect((await admin('/v1/blueprints/ticket', { method: 'PUT', ...body({ title: 'Ticket', fields: { state: { type: 'enum', title: 'Ticket state', values: ['open', 'closed'] } }, relations: {} }) })).status).toBe(200)
    expect((await machine('/v1/ingest/entities/ticket/t1', { method: 'PUT', ...body({ title: 'T1', fields: { state: 'open' } }) })).status).toBeLessThan(300)
    const out = await json<QueryResult>(await admin('/v1/query', { method: 'POST', ...body({ sources: [{ blueprint: 'ticket', clauses: [] }, { blueprint: 'k8s_cluster', clauses: [] }], columns: ['title', 'state', '$state'] }) }))
    expect(out.columns.map((c) => c.title)).toEqual(['Title', 'Ticket state', 'State'])
    const byKey = Object.fromEntries(out.rows.map((r) => [r.key, r.values]))
    expect(byKey['t1']).toEqual(['T1', 'open', 'active'])
    expect(byKey['home']).toEqual(['home', 'active', 'active'])
  })
})

describe('a saved query', () => {
  let saved: SavedQuery
  it('is kept by whoever saved it, and run and exported by its id', async () => {
    const res = await admin('/v1/queries', { method: 'POST', ...body({ title: 'Big nodes', spec }) })
    expect(res.status).toBe(201)
    saved = await json<SavedQuery>(res)
    expect(saved).toMatchObject({ title: 'Big nodes', owner: 'ops@example.org', shared: false, mine: true })
    expect((await json<QueryResult>(await admin(`/v1/queries/${saved.id}/run`))).counts).toEqual({ k8s_node: 2, k8s_cluster: 2 })
    expect((await admin(`/v1/queries/${saved.id}/export`)).headers.get('content-disposition')).toContain('Big nodes.xlsx')
  })

  it('is no one else’s until it is shared, and then only whoever saved it changes it', async () => {
    const other = as('bob@example.org', 'User')
    const first = await other('/v1/queries')
    expect(first.status, await first.clone().text()).toBe(200)
    expect((await json<SavedQueriesResponse>(first)).queries).toEqual([])
    expect((await other(`/v1/queries/${saved.id}`)).status).toBe(404)
    await admin(`/v1/queries/${saved.id}`, { method: 'PUT', ...body({ title: 'Big nodes', shared: true, spec }) })
    const seen = (await json<SavedQueriesResponse>(await other('/v1/queries'))).queries
    expect(seen.map((q) => [q.id, q.mine])).toEqual([[saved.id, false]])
    expect((await other(`/v1/queries/${saved.id}`, { method: 'PUT', ...body({ title: 'Mine now', spec }) })).status).toBe(403)
    expect((await other(`/v1/queries/${saved.id}`, { method: 'DELETE' })).status).toBe(403)
    // An admin may change anyone's.
    expect((await ada(`/v1/queries/${saved.id}`, { method: 'PUT', ...body({ title: 'Renamed', shared: true, spec }) })).status).toBe(200)
    expect((await admin(`/v1/queries/${saved.id}`, { method: 'DELETE' })).status).toBe(204)
  })
})

describe('a query shared with an audience', () => {
  const bob = as('bob@example.org', 'User')
  const carol = as('carol@example.org', 'User')
  const dan = as('dan@example.org', 'User')
  beforeAll(async () => {
    await hub.visibility.setPolicy({ audiences: [{ id: 'readers', title: 'Readers', people: ['bob@example.org', 'carol@example.org'], grants: [], audiences: [] }, { id: 'others', title: 'Others', people: ['dan@example.org'], grants: [], audiences: [] }], classes: [], edits: [] }, null)
  })
  afterAll(async () => {
    await hub.visibility.setPolicy({ audiences: [], classes: [], edits: [] }, null)
  })

  it('lists only the audiences the caller is in', async () => {
    expect((await json<QueryAudiencesResponse>(await bob('/v1/queries/audiences'))).audiences).toEqual([{ id: 'readers', title: 'Readers', description: null }])
    expect((await json<QueryAudiencesResponse>(await admin('/v1/queries/audiences'))).audiences).toEqual([])
  })

  it('is shared only with an audience its owner is in, and seen only by its members', async () => {
    const refused = await bob('/v1/queries', { method: 'POST', ...body({ title: 'Theirs', audience: 'others', spec }) })
    expect(refused.status).toBe(403)
    expect((await admin('/v1/queries', { method: 'POST', ...body({ title: 'Not mine to share', audience: 'readers', spec }) })).status).toBe(403)
    const res = await bob('/v1/queries', { method: 'POST', ...body({ title: 'For readers', audience: 'readers', spec }) })
    expect(res.status).toBe(201)
    const saved = await json<SavedQuery>(res)
    expect(saved).toMatchObject({ shared: false, audience: { id: 'readers', title: 'Readers' }, mine: true })
    expect((await json<SavedQueriesResponse>(await carol('/v1/queries'))).queries.map((q) => [q.title, q.mine])).toEqual([['For readers', false]])
    expect((await carol(`/v1/queries/${saved.id}/run`)).status).toBe(200)
    expect((await json<SavedQueriesResponse>(await dan('/v1/queries'))).queries).toEqual([])
    expect((await dan(`/v1/queries/${saved.id}`)).status).toBe(404)
    // Shared with everyone, it names no audience.
    const opened = await json<SavedQuery>(await bob(`/v1/queries/${saved.id}`, { method: 'PUT', ...body({ title: 'For readers', shared: true, audience: 'readers', spec }) }))
    expect(opened).toMatchObject({ shared: true, audience: null })
    expect((await json<SavedQueriesResponse>(await dan('/v1/queries'))).queries.map((q) => q.title)).toEqual(['For readers'])
  })
})

describe('a query with a home', () => {
  const bob = as('bob@example.org', 'User')
  const eve = as('eve@example.org', 'User')
  const carol = as('carol@example.org', 'User')
  const put = (bp: string, key: string, v: unknown) => machine(`/v1/ingest/entities/${bp}/${key}`, { method: 'PUT', ...body(v) })
  // What an earlier test shared with everyone has no home; only the homed queries are this one's.
  const listed = async (who: typeof bob, home?: string) => (await json<SavedQueriesResponse>(await who(`/v1/queries${home ? `?home=${home}` : ''}`))).queries.filter((q) => q.home || q.title === 'Filed by Carol')
  beforeAll(async () => {
    for (const [id, bp] of [
      ['crew', { title: 'Crew', fields: {}, relations: {} }],
      ['crew_member', { title: 'Crew member', fields: { email: { type: 'email' } }, relations: { crews: { target: 'crew', many: true } } }],
      ['squad', { title: 'Squad', fields: {}, relations: { member_crew: { target: 'crew' } } }],
    ] as const)
      expect((await admin(`/v1/blueprints/${id}`, { method: 'PUT', ...body(bp) })).status).toBe(200)
    // Bob and Eve are on the web crew, which is a member of Core. Carol is on no crew. Edge has no members.
    expect((await put('crew', 'web', { title: 'Web' })).status).toBeLessThan(300)
    for (const who of ['bob', 'eve']) expect((await put('crew_member', who, { title: who, fields: { email: `${who}@example.org` }, relations: { crews: ['web'] } })).status).toBeLessThan(300)
    expect((await put('crew_member', 'carol', { title: 'carol', fields: { email: 'carol@example.org' } })).status).toBeLessThan(300)
    expect((await put('squad', 'core', { title: 'Core', relations: { member_crew: 'web' } })).status).toBeLessThan(300)
    expect((await put('squad', 'edge', { title: 'Edge' })).status).toBeLessThan(300)
    expect((await admin('/v1/access/person', { method: 'PUT', ...body({ blueprint: 'crew_member', field: 'email', owns: [{ as: 'member', path: 'crews.<-squad:member_crew' }] }) })).status).toBe(200)
  })
  afterAll(async () => {
    await admin('/v1/access/person', { method: 'PUT', ...body(null) })
  })

  let core: SavedQuery
  it('belongs to an entity the person saving sees, and opens to its people only as one of them says so', async () => {
    expect((await bob('/v1/queries', { method: 'POST', ...body({ title: 'Nowhere', home: 'squad:nope', spec }) })).status).toBe(400)
    expect((await carol('/v1/queries', { method: 'POST', ...body({ title: 'Not hers to share', home: 'squad:core', homeShared: true, spec }) })).status).toBe(403)
    const filed = await carol('/v1/queries', { method: 'POST', ...body({ title: 'Filed by Carol', home: 'squad:core', spec }) })
    expect(filed.status).toBe(201)
    expect(await json<SavedQuery>(filed)).toMatchObject({ home: { id: 'squad:core', title: 'Core', yours: false }, homeShared: false })
    const res = await bob('/v1/queries', { method: 'POST', ...body({ title: 'Core health', home: 'squad:core', homeShared: true, spec }) })
    expect(res.status).toBe(201)
    core = await json<SavedQuery>(res)
    expect(core).toMatchObject({ owner: 'bob@example.org', shared: false, audience: null, home: { id: 'squad:core', entity: { blueprint: 'squad', key: 'core' }, title: 'Core', yours: true }, homeShared: true })
  })

  it('is seen by the people who own its home, and by nobody else', async () => {
    expect((await listed(eve)).map((q) => [q.title, q.home?.title, q.mine])).toEqual([['Core health', 'Core', false]])
    expect((await eve(`/v1/queries/${core.id}/run`)).status).toBe(200)
    expect((await listed(carol)).map((q) => q.title)).toEqual(['Filed by Carol'])
    expect((await carol(`/v1/queries/${core.id}`)).status).toBe(404)
  })

  it('lists one home’s collection when asked for it', async () => {
    expect((await admin('/v1/queries', { method: 'POST', ...body({ title: 'Edge, by an admin', home: 'squad:edge', homeShared: true, spec }) })).status).toBe(201)
    expect((await listed(admin, 'squad:core')).map((q) => q.title)).toEqual([])
    expect((await listed(bob, 'squad:core')).map((q) => q.title)).toEqual(['Core health'])
    expect((await listed(admin, 'squad:edge')).map((q) => q.title)).toEqual(['Edge, by an admin'])
  })

  it('keeps its home when a save leaves it out, and opens to everyone instead of its people when shared with everyone', async () => {
    const kept = await json<SavedQuery>(await bob(`/v1/queries/${core.id}`, { method: 'PUT', ...body({ title: 'Core health', homeShared: true, spec }) }))
    expect(kept).toMatchObject({ home: { id: 'squad:core' }, homeShared: true })
    const opened = await json<SavedQuery>(await bob(`/v1/queries/${core.id}`, { method: 'PUT', ...body({ title: 'Core health', shared: true, homeShared: true, spec }) }))
    expect(opened).toMatchObject({ shared: true, home: { id: 'squad:core' }, homeShared: false })
    const off = await json<SavedQuery>(await bob(`/v1/queries/${core.id}`, { method: 'PUT', ...body({ title: 'Core health', home: null, homeShared: true, spec }) }))
    expect(off).toMatchObject({ home: null, homeShared: false })
  })
})

describe('a query read through relations', () => {
  const pat = as('pat@example.org', 'User')
  const sam = as('sam@example.org', 'User')
  const save = async (id: string, spec: Record<string, unknown>) => expect((await admin(`/v1/blueprints/${id}`, { method: 'PUT', ...body({ id, ...spec }) })).status).toBe(200)
  const create = async (blueprint: string, key: string, fields: Record<string, unknown> = {}, relations: Record<string, unknown> = {}) =>
    expect((await admin('/v1/entities', { method: 'POST', ...body({ blueprint, key, title: key, fields, relations }) })).status).toBe(201)
  const platform = { grants: [{ path: 'team', values: ['platform'] }] }
  beforeAll(async () => {
    await save('q_team', { title: 'Team', fields: {}, relations: {} })
    await save('q_person', { title: 'Person', fields: {}, relations: { team: { target: 'q_team', many: true } } })
    await save('q_site', { title: 'Site', fields: { region: { type: 'string', title: 'Region' }, budget: { type: 'number', title: 'Budget', access: platform } }, relations: {} })
    await save('q_vault', { title: 'Vault', fields: {}, relations: {}, access: platform })
    await save('q_rack', { title: 'Rack', fields: {}, relations: { site: { target: 'q_site', many: false, title: 'Stands in' }, vault: { target: 'q_vault', many: false, title: 'Keys in' } } })
    await save('q_server', { title: 'Server', fields: {}, relations: { rack: { target: 'q_rack', many: false, title: 'Racked in' } } })
    expect((await admin('/v1/access/person', { method: 'PUT', ...body({ blueprint: 'q_person' }) })).status).toBe(200)
    await create('q_team', 'platform')
    await create('q_team', 'sales')
    await create('q_person', 'pat@example.org', {}, { team: ['platform'] })
    await create('q_person', 'sam@example.org', {}, { team: ['sales'] })
    await create('q_site', 'dallas', { region: 'south', budget: 100 })
    await create('q_vault', 'cage-1')
    await create('q_rack', 'r1', {}, { site: 'dallas', vault: 'cage-1' })
    await create('q_server', 'srv1', {}, { rack: 'r1' })
    await create('q_server', 'srv2')
    await hub.deriver.backfill()
    await Promise.all([pat('/v1/whoami'), sam('/v1/whoami')])
  })

  const walk: QuerySpec = { sources: [{ blueprint: 'q_server', clauses: [] }], columns: ['title', 'r:rack.site@region', 'r:rack.site', 'r:rack.site@budget', 'r:rack.vault', 'r:rack.site@$status'] }

  it('reads a field two hops away, titled by each hop, as a list', async () => {
    const out = await json<QueryResult>(await admin('/v1/query', { method: 'POST', ...body(walk) }))
    expect(out.columns.map((c) => c.title)).toEqual(['Title', 'Racked in › Stands in › Region', 'Racked in › Stands in', 'Racked in › Stands in › Budget', 'Racked in › Keys in', 'Racked in › Stands in › Status'])
    const byKey = Object.fromEntries(out.rows.map((r) => [r.key, r.values]))
    expect(byKey['srv1']).toEqual(['srv1', ['south'], ['dallas'], [100], ['cage-1'], ['green']])
    expect(byKey['srv2']).toEqual(['srv2', null, null, null, null, null])
    expect(out.ms).toBeGreaterThanOrEqual(0)
  })

  it('reads only what the reader may see at the end of a path', async () => {
    const theirs = await json<QueryResult>(await pat('/v1/query', { method: 'POST', ...body(walk) }))
    expect(theirs.columns.map((c) => c.id)).toEqual(walk.columns)
    // A field the reader may not see is no column, and a hop to a blueprint they see none of fills nothing.
    const out = await json<QueryResult>(await sam('/v1/query', { method: 'POST', ...body(walk) }))
    expect(out.columns.map((c) => c.id)).toEqual(['title', 'r:rack.site@region', 'r:rack.site', 'r:rack.site@$status'])
    expect(out.rows.find((r) => r.key === 'srv1')?.values).toEqual(['srv1', ['south'], ['dallas'], ['green']])
    const named = await json<QueryResult>(await sam('/v1/query', { method: 'POST', ...body({ ...walk, columns: ['title', { id: 'money', title: 'Money', from: { q_server: 'r:rack.site@budget' } }, { id: 'keys', title: 'Keys', from: { q_server: 'r:rack.vault' } }] }) }))
    expect(named.columns.map((c) => [c.id, c.from])).toEqual([['title', { q_server: 'title' }], ['money', {}], ['keys', {}]])
    expect(named.rows.find((r) => r.key === 'srv1')?.values).toEqual(['srv1', null, null])
  })

  it('leaves out a blueprint the reader may not see, whether it is hidden or not there at all, and reads the rest', async () => {
    const both: QuerySpec = { sources: [{ blueprint: 'q_server', clauses: [] }, { blueprint: 'q_vault', clauses: [] }], columns: ['$type', 'title'] }
    const shared = await json<SavedQuery>(await pat('/v1/queries', { method: 'POST', ...body({ title: 'Servers and vaults', shared: true, spec: both }) }))
    expect((await json<QueryResult>(await pat(`/v1/queries/${shared.id}/run`))).counts).toEqual({ q_server: 2, q_vault: 1 })
    const res = await sam(`/v1/queries/${shared.id}/run`)
    expect(res.status).toBe(200)
    const theirs = await json<QueryResult>(res)
    expect(theirs.counts).toEqual({ q_server: 2 })
    expect(JSON.stringify(theirs)).not.toContain('q_vault')
    // Hidden or missing reads the same to them, so the answer says nothing of what exists.
    for (const blueprint of ['q_vault', 'no_such']) {
      const r = await sam('/v1/query', { method: 'POST', ...body({ sources: [{ blueprint, clauses: [] }], columns: [] }) })
      expect(r.status).toBe(200)
      expect((await json<QueryResult>(r)).rows).toEqual([])
    }
  })

  it('a hop in reads who points at the row', async () => {
    const out = await json<QueryResult>(await admin('/v1/query', { method: 'POST', ...body({ sources: [{ blueprint: 'q_site', clauses: [] }], columns: ['title', 'r:<-q_rack:site', 'r:<-q_rack:site.<-q_server:rack@title'] }) }))
    expect(out.columns.map((c) => c.title)).toEqual(['Title', 'Rack', 'Rack › Server › Title'])
    expect(out.rows[0]!.values).toEqual(['dallas', ['r1'], ['srv1']])
  })
})

describe('a query’s view', () => {
  const shown: QuerySpec = { ...spec, view: { where: [{ field: '$type', op: 'eq', value: 'Kubernetes cluster' }], sort: [{ column: 'title', desc: true }] } }

  it('is kept by the export: the rows it keeps, in its order', async () => {
    const res = await admin('/v1/query/export', { method: 'POST', ...body({ spec: shown, title: 'Clusters' }) })
    expect(res.status).toBe(200)
    const sheet = unzip(Buffer.from(await res.arrayBuffer())).get('xl/worksheets/sheet1.xml')!
    expect(sheet).not.toContain('>n2<')
    expect(sheet.indexOf('>lab<')).toBeGreaterThan(0)
    expect(sheet.indexOf('>lab<')).toBeLessThan(sheet.indexOf('>home<'))
  })

  it('shapes the answer for a caller that asks for it shaped: the rows it keeps, in its order, up to the limit', async () => {
    const whole = await json<QueryResult>(await admin('/v1/query', { method: 'POST', ...body(shown) }))
    expect(whole.rows).toHaveLength(4)
    const out = await json<QueryAnswer>(await admin('/v1/query?shaped=true', { method: 'POST', ...body(shown) }))
    expect(out.rows.map((r) => r.key)).toEqual(['lab', 'home'])
    expect(out).toMatchObject({ kept: 2, shown: 2, counts: whole.counts, truncated: false })
    const one = await json<QueryAnswer>(await admin('/v1/query?shaped=true&limit=1', { method: 'POST', ...body(shown) }))
    expect(one).toMatchObject({ kept: 2, shown: 1 })
    expect(one.rows.map((r) => r.key)).toEqual(['lab'])
  })

  it('shapes a saved query the same way, with its groups and totals', async () => {
    const big = { ...spec, view: { where: [{ field: 'cpu', op: 'gt' as const, value: '8' }], group: ['$type'], totals: { cpu: 'sum' as const } } }
    const saved = await json<SavedQuery>(await admin('/v1/queries', { method: 'POST', ...body({ title: 'Shaped', spec: big }) }))
    const out = await json<QueryAnswer>(await admin(`/v1/queries/${saved.id}/run?shaped=true`))
    expect(out.rows.map((r) => r.key).sort()).toEqual(['home/n2', 'lab/n3'])
    expect(out.groups).toEqual([{ column: '$type', value: 'Kubernetes node', count: 2, totals: { cpu: 48 } }])
    expect(out.totals).toEqual({ cpu: 48 })
    expect((await admin(`/v1/queries/${saved.id}`, { method: 'DELETE' })).status).toBe(204)
  })

  it('is refused when it names a total no column adds up to, or groups too deep', async () => {
    expect((await admin('/v1/query', { method: 'POST', ...body({ ...spec, view: { totals: { cpu: 'median' } } }) })).status).toBe(400)
    expect((await admin('/v1/query', { method: 'POST', ...body({ ...spec, view: { group: ['a', 'b', 'c', 'd'] } }) })).status).toBe(400)
  })

  it('is kept with a saved query, and its export keeps the same rows', async () => {
    const big = { ...spec, view: { where: [{ field: 'cpu', op: 'gt' as const, value: '20' }], group: ['$type'], totals: { cpu: 'sum' as const }, widths: { title: 240 } } }
    const saved = await json<SavedQuery>(await admin('/v1/queries', { method: 'POST', ...body({ title: 'Big', spec: big }) }))
    expect(saved.spec.view).toEqual(big.view)
    const sheet = unzip(Buffer.from(await (await admin(`/v1/queries/${saved.id}/export`)).arrayBuffer())).get('xl/worksheets/sheet1.xml')!
    expect(sheet).toContain('>n3<')
    expect(sheet).not.toContain('>n2<')
    expect((await admin(`/v1/queries/${saved.id}`, { method: 'DELETE' })).status).toBe(204)
  })
})
