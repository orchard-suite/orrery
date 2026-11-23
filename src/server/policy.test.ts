import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ChangesResponse, TokenIssued } from '../shared/api.ts'
import type { Blueprint, Entity } from '../shared/model.ts'
import type { AccessPolicy, PolicyState } from '../shared/policy.ts'
import type { PolicyPreview, PosturePreview, PostureResponse } from '../shared/posture.ts'
import { applyCatalog } from './catalog.ts'
import { loadConfig } from './config.ts'
import { createHub, type Hub } from './hub.ts'

// Its own database: these tests set who a signed-in person is and the hub's audiences, which every other test would then read.
const DATABASE_URL = (process.env.DATABASE_URL ?? 'postgres://orrery:orrery@localhost:5433/orrery') + '_policy'

let hub: Hub

const as = (email: string, groups = 'User') => (path: string, init?: RequestInit) =>
  hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', 'x-forwarded-email': email, 'x-forwarded-groups': groups, ...init?.headers } }, { surface: 'session' })
const machine = (path: string, bearer: string, init?: RequestInit) => hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}`, ...init?.headers } }, { surface: 'machine' })
const json = async <T = Record<string, unknown>>(r: Response): Promise<T> => (await r.json()) as T
const put = (v: unknown) => ({ method: 'PUT', body: JSON.stringify(v) })
const post = (v: unknown) => ({ method: 'POST', body: JSON.stringify(v) })

const admin = as('admin@example.org', 'Admin')
// On the platform team, and named in the cost audience.
const lead = as('lead@example.org')
// Named in IT operations, not on the platform team.
const boss = as('boss@example.org')
// Named in the cost audience alone.
const finance = as('finance@example.org')
// On the platform team only, joined later.
const hire = as('hire@example.org')

const POLICY: AccessPolicy = {
  audiences: [
    { id: 'platform', title: 'Platform', people: [], grants: [{ path: 'team', values: ['platform'] }], audiences: [] },
    { id: 'ops', title: 'IT operations', people: ['boss@example.org', 'lead@example.org'], grants: [], audiences: ['platform'] },
    { id: 'cost', title: 'Cost', people: ['lead@example.org', 'boss@example.org', 'finance@example.org'], grants: [], audiences: [] },
  ],
  classes: [{ id: 'cost', title: 'Cost', audiences: ['cost'], match: ['cost_*'], include: ['project.budget'], exclude: [] }],
  edits: [],
}

const fieldsOf = async (reader: typeof admin, blueprint: string, key: string) => {
  const r = await reader(`/v1/entities/${blueprint}/${encodeURIComponent(key)}`)
  return r.status === 200 ? (await json<Entity>(r)).fields : null
}
const snapshot = async () => json<PostureResponse>(await admin('/v1/posture'))
const savePolicy = async (policy: AccessPolicy, save = true) => {
  const r = await admin('/v1/posture/policy', post({ policy, save }))
  expect(r.status).toBe(200)
  return json<PolicyPreview>(r)
}

beforeAll(async () => {
  const pg = await import('pg').then(({ default: m }) => new m.Client({ connectionString: DATABASE_URL.replace(/\/[^/]+$/, '/postgres') }))
  await pg.connect()
  await pg.query(`DROP DATABASE IF EXISTS ${DATABASE_URL.split('/').pop()}`)
  await pg.query(`CREATE DATABASE ${DATABASE_URL.split('/').pop()}`)
  await pg.end()
  hub = await createHub(loadConfig({ DATABASE_URL, DATA_DIR: mkdtempSync(join(tmpdir(), 'orrery-')), AUTH_MODE: 'proxy' }), 'test', { reset: true })

  const save = async (id: string, spec: Record<string, unknown>) => expect((await admin(`/v1/blueprints/${id}`, put({ id, ...spec }))).status).toBe(200)
  await save('team', { title: 'Team', fields: {}, relations: {} })
  await save('user', { title: 'Person', fields: {}, relations: { team: { target: 'team', many: true } } })
  await save('vm', { title: 'VM', fields: { name: { type: 'string' }, cost_month_cents: { type: 'number', access: { grants: [{ values: ['lead@example.org'] }] } } }, relations: {} })
  await save('project', { title: 'Project', fields: { budget: { type: 'number' }, owner: { type: 'string' } }, relations: {} })
  expect((await admin('/v1/access/person', put({ blueprint: 'user' }))).status).toBe(200)
  const create = async (blueprint: string, key: string, fields: Record<string, unknown> = {}, relations: Record<string, unknown> = {}) =>
    expect((await admin('/v1/entities', post({ blueprint, key, title: key, fields, relations }))).status).toBe(201)
  await create('team', 'platform')
  await create('user', 'lead@example.org', {}, { team: ['platform'] })
  await create('user', 'boss@example.org')
  await create('user', 'finance@example.org')
  await create('user', 'hire@example.org', {}, { team: ['platform'] })
  await create('vm', 'web', { name: 'web', cost_month_cents: 1200 })
  await create('project', 'apollo', { budget: 5000, owner: 'lead' })
  for (const reader of [lead, boss, finance, hire]) await reader('/v1/whoami')
})

afterAll(async () => {
  await hub.close()
})

describe('audiences and field classes', () => {
  it('preview who gains and loses before anything is saved', async () => {
    const preview = await savePolicy(POLICY, false)
    expect(preview.saved).toBe(false)
    const cost = preview.items.find((i) => i.target.kind === 'field' && i.target.field === 'cost_month_cents')
    // The class replaces the field's own rule: the cost audience gains it, and the platform hire never had it.
    expect(cost?.gains.sort()).toEqual(['boss@example.org', 'finance@example.org'])
    const budget = preview.items.find((i) => i.target.kind === 'field' && i.target.field === 'budget')
    expect(budget?.loses.sort()).toEqual(['hire@example.org'])
    expect(await fieldsOf(hire, 'project', 'apollo')).toHaveProperty('budget', 5000)
  })

  it('refuse a policy that names an audience that does not exist', async () => {
    const preview = await savePolicy({ audiences: [], classes: [{ id: 'cost', title: 'Cost', audiences: ['money'], match: ['cost_*'], include: [], exclude: [] }], edits: [] })
    expect(preview.saved).toBe(false)
    expect(preview.problems).toEqual(['Class "cost" names an audience that does not exist: "money"'])
  })

  it('hide a class\'s fields on every blueprint from everyone outside its audiences', async () => {
    expect((await savePolicy(POLICY)).saved).toBe(true)
    expect(await fieldsOf(finance, 'vm', 'web')).toMatchObject({ name: 'web', cost_month_cents: 1200 })
    expect(await fieldsOf(hire, 'vm', 'web')).not.toHaveProperty('cost_month_cents')
    expect(await fieldsOf(hire, 'project', 'apollo')).not.toHaveProperty('budget')
    expect(await fieldsOf(boss, 'project', 'apollo')).toHaveProperty('budget', 5000)
    const [row] = (await json<ChangesResponse>(await admin('/v1/changes?kind=access.changed&limit=1'))).changes
    expect(row).toMatchObject({ actor: 'admin@example.org', detail: { policy: true } })
  })

  it('cover a blueprint that arrives after the class, from its first read', async () => {
    expect((await admin('/v1/blueprints/disk', put({ id: 'disk', title: 'Disk', fields: { cost_last_month_cents: { type: 'number' } }, relations: {} }))).status).toBe(200)
    expect((await admin('/v1/entities', post({ blueprint: 'disk', key: 'd1', title: 'd1', fields: { cost_last_month_cents: 300 } }))).status).toBe(201)
    expect(await fieldsOf(hire, 'disk', 'd1')).not.toHaveProperty('cost_last_month_cents')
    expect(await fieldsOf(finance, 'disk', 'd1')).toHaveProperty('cost_last_month_cents', 300)
    // A reader who is not an admin is told the field is restricted, never by what.
    const disk = await json<Blueprint>(await finance('/v1/blueprints/disk'))
    expect(disk.fields.cost_last_month_cents).toMatchObject({ restricted: true })
    expect(disk.fields.cost_last_month_cents).not.toHaveProperty('access')
  })

  it('let an audience\'s members in through a rule that names it, nested audiences too', async () => {
    expect((await admin('/v1/blueprints/vm', put({ ...(await json<Blueprint>(await admin('/v1/blueprints/vm'))), access: { grants: [], audiences: ['ops'] } }))).status).toBe(200)
    expect(await fieldsOf(boss, 'vm', 'web')).not.toBeNull()
    // The hire is in IT operations through the platform team, which it holds.
    expect(await fieldsOf(hire, 'vm', 'web')).not.toBeNull()
    expect(await fieldsOf(finance, 'vm', 'web')).toBeNull()
    const who = await json<{ rows: { principal: { name: string }; via: string | null }[] }>(await admin('/v1/posture/who?target=blueprint:vm'))
    expect(who.rows.find((r) => r.principal.name === 'boss@example.org')?.via).toBe('audience IT operations')
  })

  it('refuse a rule written by hand on a field a class covers', async () => {
    const vm = await json<Blueprint>(await admin('/v1/blueprints/vm'))
    const r = await admin('/v1/blueprints/vm', put({ ...vm, fields: { ...vm.fields, cost_month_cents: { type: 'number', access: { grants: [{ values: ['hire@example.org'] }] } } } }))
    expect(r.status).toBe(400)
    expect((await json(r)).error).toMatch(/in the Cost class/)
    // A save that leaves the old rule as it was still goes through.
    expect((await admin('/v1/blueprints/vm', put({ ...vm, description: 'Virtual machines' }))).status).toBe(200)
    const change = await json<PosturePreview>(await admin('/v1/posture/change', post({ change: { targets: [{ kind: 'field', blueprint: 'vm', field: 'cost_month_cents' }], access: { op: 'set', grants: [{ values: ['hire@example.org'] }] } } })))
    expect(change.items[0]?.refused).toMatch(/In the Cost class/)
  })

  it('show in the posture whom each audience lets in, what each class covers, and the rules a class sets aside', async () => {
    const p = await snapshot()
    expect(p.policy.source).toBeNull()
    expect(p.audiences.find((a) => a.id === 'ops')?.members.sort()).toEqual(['boss@example.org', 'hire@example.org', 'lead@example.org'])
    // A rule naming IT operations lets the platform audience in too.
    expect(p.audiences.find((a) => a.id === 'platform')?.targets).toContainEqual({ kind: 'blueprint', id: 'vm' })
    expect(p.classes.find((c) => c.id === 'cost')?.fields).toEqual(expect.arrayContaining([{ blueprint: 'vm', field: 'cost_month_cents' }, { blueprint: 'disk', field: 'cost_last_month_cents' }, { blueprint: 'project', field: 'budget' }]))
    expect(p.findings.find((f) => f.id === 'set-aside:cost')?.targets).toEqual([{ kind: 'field', blueprint: 'vm', field: 'cost_month_cents' }])
    const field = p.items.find((i) => i.target.kind === 'field' && i.target.blueprint === 'vm' && i.target.field === 'cost_month_cents')
    expect(field).toMatchObject({ class: 'cost', setAside: true, coverage: 'classified', audiences: ['cost'] })
  })

  it('let a rule a class sets aside be taken off, by a change or by a save', async () => {
    expect((await admin('/v1/blueprints/lab', put({ id: 'lab', title: 'Lab', fields: { cost_a_cents: { type: 'number', access: { grants: [{ values: ['lead@example.org'] }] } } }, relations: {} }))).status).toBe(400)
    const vm = await json<Blueprint>(await admin('/v1/blueprints/vm'))
    const { access: _gone, ...bare } = vm.fields.cost_month_cents!
    expect((await admin('/v1/blueprints/vm', put({ ...vm, fields: { ...vm.fields, cost_month_cents: bare } }))).status).toBe(200)
    expect((await json<Blueprint>(await admin('/v1/blueprints/vm'))).fields.cost_month_cents).not.toHaveProperty('access')
    expect((await admin('/v1/blueprints/disk', put({ ...(await json<Blueprint>(await admin('/v1/blueprints/disk'))) }))).status).toBe(200)
    const cleared = await json<PosturePreview>(await admin('/v1/posture/change', post({ change: { targets: [{ kind: 'field', blueprint: 'disk', field: 'cost_last_month_cents' }], access: { op: 'clear' } } })))
    expect(cleared.items[0]?.refused).toBeNull()
  })

  it('follow a renamed blueprint a class names by its old id', async () => {
    expect((await admin('/v1/blueprints/project/rename', post({ to: 'programme' }))).status).toBe(200)
    expect(await fieldsOf(hire, 'programme', 'apollo')).not.toHaveProperty('budget')
    expect(await fieldsOf(finance, 'programme', 'apollo')).toHaveProperty('budget', 5000)
  })
})

describe('a class opened to owners', () => {
  // The setting: a person owns the programs they are assigned to. A server links to its program.
  // The owner on program alpha sees cost on alpha's servers only; on beta's it is blank, and a sort, a filter, and a count read it so.
  const owner = as('owner@example.org')
  const OWNED: AccessPolicy = { ...POLICY, classes: [{ ...POLICY.classes[0]!, match: ['cost_*', '*_cents'], owned: { through: ['program'], roles: ['program'] } }] }

  beforeAll(async () => {
    const save = async (id: string, spec: Record<string, unknown>) => expect((await admin(`/v1/blueprints/${id}`, put({ id, ...spec }))).status).toBe(200)
    await save('prog', { title: 'Program', fields: { latest_cost_cents: { type: 'number' } }, relations: {} })
    const user = await json<Blueprint>(await admin('/v1/blueprints/user'))
    await save('user', { ...user, relations: { ...user.relations, programs: { target: 'prog', many: true } } })
    await save('server', { title: 'Server', fields: { name: { type: 'string' }, cost_monthly_cents: { type: 'number' } }, relations: { program: { target: 'prog' } } })
    const create = async (blueprint: string, key: string, fields: Record<string, unknown> = {}, relations: Record<string, unknown> = {}) =>
      expect((await admin('/v1/entities', post({ blueprint, key, title: key, fields, relations }))).status).toBe(201)
    await create('prog', 'alpha', { latest_cost_cents: 900 })
    await create('prog', 'beta', { latest_cost_cents: 400 })
    await create('user', 'owner@example.org', {}, { programs: ['alpha'] })
    await create('server', 'a1', { name: 'a1', cost_monthly_cents: 300 }, { program: 'alpha' })
    await create('server', 'a2', { name: 'a2', cost_monthly_cents: 600 }, { program: 'alpha' })
    await create('server', 'b1', { name: 'b1', cost_monthly_cents: 400 }, { program: 'beta' })
    await owner('/v1/whoami')
    expect((await admin('/v1/access/person', put({ blueprint: 'user', owns: [{ as: 'program', path: 'programs' }] }))).status).toBe(200)
  })

  afterAll(async () => {
    expect((await admin('/v1/access/person', put({ blueprint: 'user' }))).status).toBe(200)
    await savePolicy(POLICY)
  })

  it('hides the class from the owner everywhere until the class opens to owners', async () => {
    await savePolicy({ ...OWNED, classes: [{ ...OWNED.classes[0]!, owned: undefined }] })
    expect(await fieldsOf(owner, 'server', 'a1')).not.toHaveProperty('cost_monthly_cents')
  })

  it('shows the class on what the owner owns, and through the relations the class names', async () => {
    expect((await savePolicy(OWNED)).saved).toBe(true)
    expect(await fieldsOf(owner, 'server', 'a1')).toHaveProperty('cost_monthly_cents', 300)
    expect(await fieldsOf(owner, 'prog', 'alpha')).toHaveProperty('latest_cost_cents', 900)
    expect(await fieldsOf(owner, 'server', 'b1')).not.toHaveProperty('cost_monthly_cents')
    expect(await fieldsOf(owner, 'prog', 'beta')).not.toHaveProperty('latest_cost_cents')
    // Someone who owns nothing sees nothing more, and the cost audience still sees it all.
    expect(await fieldsOf(hire, 'server', 'a1')).not.toHaveProperty('cost_monthly_cents')
    expect(await fieldsOf(finance, 'server', 'b1')).toHaveProperty('cost_monthly_cents', 400)
  })

  it('sorts, filters, and counts on what the owner sees, blank on the rest', async () => {
    const sorted = await json<{ entities: Entity[] }>(await owner('/v1/entities?blueprint=server&sort=-cost_monthly_cents&distribution=true'))
    expect(sorted.entities.map((e) => [e.key, e.fields.cost_monthly_cents ?? null])).toEqual([['a2', 600], ['a1', 300], ['b1', null]])
    const filter = encodeURIComponent(JSON.stringify({ field: 'cost_monthly_cents', op: 'gt', value: 350 }))
    const filtered = await json<{ entities: Entity[]; total: number }>(await owner(`/v1/entities?blueprint=server&filter=${filter}`))
    // b1 costs 400, but the owner may not read it, so the filter does not find it.
    expect(filtered.entities.map((e) => e.key)).toEqual(['a2'])
    const grid = await json<{ entities: Entity[]; total: number; distribution: Record<string, unknown> }>(await owner(`/v1/entities?blueprint=server&distribution=true&sort=-cost_monthly_cents&filter=${filter}`))
    expect(grid.total).toBe(1)
    expect(grid.entities.map((e) => e.key)).toEqual(['a2'])
    // The blueprint names the field, marked restricted, so the grid can show it.
    expect((await json<Blueprint>(await owner('/v1/blueprints/server'))).fields.cost_monthly_cents).toMatchObject({ restricted: true })
  })

  it('works out what everyone owns together when everyone is judged, not once for each person', async () => {
    for (let i = 0; i < 30; i++) {
      expect((await admin('/v1/entities', post({ blueprint: 'user', key: `crowd${i}@example.org`, title: `crowd${i}`, fields: {}, relations: { programs: [i % 2 ? 'alpha' : 'beta'] } }))).status).toBe(201)
    }
    const walked = vi.spyOn(hub.reader, 'followAll')
    try {
      expect((await admin('/v1/posture')).status).toBe(200)
      expect(walked.mock.calls.length).toBeLessThan(10)
    } finally {
      walked.mockRestore()
    }
    // What was worked out together is what each person gets alone.
    expect(await fieldsOf(owner, 'server', 'a1')).toHaveProperty('cost_monthly_cents', 300)
    expect(await fieldsOf(owner, 'server', 'b1')).not.toHaveProperty('cost_monthly_cents')
    expect(await fieldsOf(as('crowd0@example.org'), 'server', 'b1')).toHaveProperty('cost_monthly_cents', 400)
    expect(await fieldsOf(as('crowd0@example.org'), 'server', 'a1')).not.toHaveProperty('cost_monthly_cents')
  })

  it('follows what the owner owns as it changes', async () => {
    const u = await json<Entity>(await admin('/v1/entities/user/owner@example.org'))
    expect(u).toBeTruthy()
    expect((await admin('/v1/entities/user/owner@example.org', { method: 'PATCH', body: JSON.stringify({ relations: { programs: ['beta'] } }) })).status).toBe(200)
    expect(await fieldsOf(owner, 'server', 'a1')).not.toHaveProperty('cost_monthly_cents')
    expect(await fieldsOf(owner, 'server', 'b1')).toHaveProperty('cost_monthly_cents', 400)
    const sorted = await json<{ entities: Entity[] }>(await owner('/v1/entities?blueprint=server&sort=-cost_monthly_cents'))
    expect(sorted.entities.map((e) => e.key)).toEqual(['b1', 'a1', 'a2'])
  })

  it('counts only a role the class names', async () => {
    expect((await savePolicy({ ...OWNED, classes: [{ ...OWNED.classes[0]!, owned: { through: ['program'], roles: ['qa'] } }] })).saved).toBe(true)
    expect(await fieldsOf(owner, 'server', 'b1')).not.toHaveProperty('cost_monthly_cents')
  })

  it('leaves the owner unable to change what they only read', async () => {
    await savePolicy(OWNED)
    expect((await owner('/v1/entities/server/b1', { method: 'PATCH', body: JSON.stringify({ fields: { cost_monthly_cents: 1 } }) })).status).toBeGreaterThanOrEqual(400)
  })

  it('refuses a class that opens through more than one hop', async () => {
    const preview = await savePolicy({ ...POLICY, classes: [{ ...POLICY.classes[0]!, owned: { through: ['program.parent'], roles: [] } }] })
    expect(preview.problems[0]).toMatch(/is not one relation/)
  })
})

describe('the review queue', () => {
  it('lists every blueprint nobody reviewed, and a field that came after the last review', async () => {
    let p = await snapshot()
    expect(p.review.find((r) => r.blueprint === 'disk')).toMatchObject({ reviewedAt: null, newFields: ['cost_last_month_cents'] })
    expect(p.review.find((r) => r.blueprint === 'disk')?.createdAt).toBeTruthy()
    expect(p.coverage.unreviewed).toBeGreaterThan(0)
    const r = await admin('/v1/posture/review', post({ blueprints: ['disk', 'vm'] }))
    expect(await json(r)).toEqual({ reviewed: ['disk', 'vm'] })
    p = await snapshot()
    expect(p.review.find((r) => r.blueprint === 'disk')).toMatchObject({ reviewedBy: 'admin@example.org', newFields: [] })
    expect(p.items.find((i) => i.target.kind === 'field' && i.target.blueprint === 'vm' && i.target.field === 'name')?.coverage).toBe('reviewed')
    const disk = await json<Blueprint>(await admin('/v1/blueprints/disk'))
    expect((await admin('/v1/blueprints/disk', put({ ...disk, fields: { ...disk.fields, size_gb: { type: 'number' } } }))).status).toBe(200)
    p = await snapshot()
    expect(p.review.find((r) => r.blueprint === 'disk')?.newFields).toEqual(['size_gb'])
    expect(p.review[0]?.newFields.length).toBeGreaterThan(0)
    const [row] = (await json<ChangesResponse>(await admin('/v1/changes?kind=access.reviewed&limit=1'))).changes
    expect(row).toMatchObject({ detail: { blueprints: ['disk', 'vm'] } })
  })

  it('is an admin\'s to mark', async () => {
    expect((await lead('/v1/posture/review', post({ blueprints: ['disk'] }))).status).toBe(403)
  })
})

describe('the posture.read permission', () => {
  it('reads the posture and the policy, and changes neither', async () => {
    expect((await admin('/v1/roles/auditor', put({ title: 'Auditor', permissions: ['posture.read'] }))).status).toBe(200)
    const { token } = await json<TokenIssued>(await admin('/v1/tokens', post({ kind: 'access', name: 'trellis', role: 'auditor' })))
    expect((await machine('/v1/posture', token)).status).toBe(200)
    expect((await json<PolicyState>(await machine('/v1/posture/policy', token))).policy.audiences.map((a) => a.id)).toEqual(['platform', 'ops', 'cost'])
    expect((await machine('/v1/posture/policy', token, post({ policy: POLICY, save: true }))).status).toBe(403)
    expect((await lead('/v1/posture')).status).toBe(403)
  })
})

describe('findings about the rules', () => {
  it('name an audience that lets nobody in, and a field nobody passes both rules for', async () => {
    await savePolicy({ ...POLICY, audiences: [...POLICY.audiences, { id: 'empty', title: 'Nobody yet', people: ['gone@example.org'], grants: [], audiences: [] }] })
    expect((await admin('/v1/blueprints/ticket', put({ id: 'ticket', title: 'Ticket', fields: { note: { type: 'string', access: { grants: [{ values: ['finance@example.org'] }] } } }, relations: {}, access: { grants: [{ values: ['boss@example.org'] }] } }))).status).toBe(200)
    const p = await snapshot()
    expect(p.findings.find((f) => f.id === 'audience-empty:empty')).toMatchObject({ severity: 'medium', family: 'Audiences that let nobody in' })
    expect(p.findings.find((f) => f.id === 'audience-strangers:empty')?.who).toEqual(['gone@example.org'])
    expect(p.findings.find((f) => f.id === 'nobody:field:ticket.note')).toBeTruthy()
  })

  it('gather the field rules that only repeat their blueprint\'s into one', async () => {
    expect((await admin('/v1/blueprints/ledger', put({ id: 'ledger', title: 'Ledger', fields: { a: { type: 'string', access: { grants: [], audiences: ['ops'] } }, b: { type: 'string', access: { grants: [], audiences: ['ops'] } } }, relations: {}, access: { grants: [], audiences: ['ops'] } }))).status).toBe(200)
    const p = await snapshot()
    expect(p.findings.find((f) => f.id === 'repeats')?.targets).toEqual(expect.arrayContaining([{ kind: 'field', blueprint: 'ledger', field: 'a' }, { kind: 'field', blueprint: 'ledger', field: 'b' }]))
  })
})

describe('a policy declared in git', () => {
  it('belongs to git while it is declared, and stays as it was when git lets go', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orrery-policy-'))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'access.yaml'), `config:\n  access:\n    audiences:\n      - id: cost\n        title: Cost\n        people: [finance@example.org]\n    classes:\n      - id: cost\n        title: Cost\n        audiences: [cost]\n        match: ['cost_*']\n`)
    const source = await hub.sources.save('policy', { title: 'Policy', class: 'git', blueprints: ['*'], deleteGrant: [], cadence: null, git: { url: 'https://example.org/policy.git', branch: 'main', glob: '**/*.yaml' } })
    expect((await applyCatalog(hub, source, dir, '**/*.yaml')).errors).toEqual([])
    expect(hub.visibility.policyState().source).toBe('policy')
    expect(await fieldsOf(lead, 'disk', 'd1')).not.toHaveProperty('cost_last_month_cents')
    const locked = await admin('/v1/posture/policy', post({ policy: POLICY, save: true }))
    expect(locked.status).toBe(400)
    expect((await json(locked)).error).toMatch(/declared in git/)
    writeFileSync(join(dir, 'access.yaml'), 'config: {}\n')
    await applyCatalog(hub, source, dir, '**/*.yaml')
    // Letting go keeps every rule it held: nothing opens because git stopped declaring it.
    expect(hub.visibility.policyState()).toMatchObject({ source: null, policy: { classes: [{ id: 'cost' }] } })
    expect(await fieldsOf(lead, 'disk', 'd1')).not.toHaveProperty('cost_last_month_cents')
    expect((await savePolicy(POLICY)).saved).toBe(true)
  })
})

describe('judging everyone at once', () => {
  it('reads people through an address field the same as one by one', async () => {
    expect((await admin('/v1/blueprints/staff', put({ id: 'staff', title: 'Staff', fields: { address: { type: 'string' } }, relations: { team: { target: 'team', many: true } } }))).status).toBe(200)
    expect((await admin('/v1/entities', post({ blueprint: 'staff', key: 's1', title: 'Finance', fields: { address: 'Finance@example.org' }, relations: { team: ['platform'] } }))).status).toBe(201)
    expect((await admin('/v1/entities', post({ blueprint: 'staff', key: 's2', title: 'Hire', fields: { address: 'hire@example.org' } }))).status).toBe(201)
    expect((await admin('/v1/access/person', put({ blueprint: 'staff', field: 'address' }))).status).toBe(200)
    const p = await snapshot()
    // The platform audience grants by team: through the staff entities now, finance is on the platform team and the hire is not.
    expect(p.audiences.find((a) => a.id === 'platform')?.members).toContain('finance@example.org')
    expect(p.audiences.find((a) => a.id === 'platform')?.members).not.toContain('hire@example.org')
    const who = await json<{ rows: { principal: { name: string }; sees: boolean }[] }>(await admin('/v1/posture/who?target=blueprint:vm'))
    expect(who.rows.find((r) => r.principal.name === 'finance@example.org')?.sees).toBe(true)
    expect((await admin('/v1/access/person', put({ blueprint: 'user' }))).status).toBe(200)
  })
})

describe('an action granted through an audience', () => {
  it('is judged as delegated, the same as one granted by hand', async () => {
    expect((await admin('/v1/actions/restart_vm', put({ title: 'Restart a VM', blueprint: 'vm', where: { field: 'name', op: 'eq', value: 'web' }, inputs: {}, backend: { type: 'webhook', url: 'https://hooks.example.org/restart' }, access: { audiences: ['ops'] } }))).status).toBe(200)
    const p = await snapshot()
    // What its filter reads is guarded as soon as the action is delegated, so no finding asks for a mark.
    expect(p.findings.find((f) => f.id === 'filter:restart_vm')).toBeUndefined()
    expect(p.items.find((i) => i.target.kind === 'field' && i.target.blueprint === 'vm' && i.target.field === 'name')?.sensitive).toContain('access is decided from it, so only an admin or a holder of access.values changes it')
    expect(p.items.find((i) => i.target.kind === 'action' && i.target.id === 'restart_vm')?.sensitive).not.toContain("an admin's alone")
  })
})

describe('an action filtered on what nobody can change', () => {
  it('guards nothing a person could change', async () => {
    expect((await admin('/v1/actions/restart_web', put({ title: 'Restart web', blueprint: 'vm', where: { field: 'key', op: 'eq', value: 'web' }, inputs: {}, backend: { type: 'webhook', url: 'https://hooks.example.org/restart' }, access: { audiences: ['ops'] } }))).status).toBe(200)
    expect((await json<{ decides?: { names: string[] } }>(await admin('/v1/blueprints/vm'))).decides?.names ?? []).not.toContain('key')
  })
})
