import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ActionRun, Change, Source } from '../shared/model.ts'
import type { ActionRunsResponse, RunnerJob, ToolCallResponse, ToolsResponse, WhoAmIResponse } from '../shared/api.ts'
import { loadConfig } from './config.ts'
import { createHub, type Hub } from './hub.ts'
import { createLogger } from './log.ts'
import { NoticeForwarder, type NoticeEvent } from './notices.ts'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://orrery:orrery@localhost:5433/orrery'

let hub: Hub
let pusher = ''
/** The product that takes people's requests and works them: it asks and reaches in their names. */
let desk = ''
/** An assistant that only looks. */
let assistant = ''
/** A product's token with no say over anyone else's name. */
let plain = ''
/** The source the desk declares tools with. */
let declarer = ''
const runners: Record<string, string> = {}

type Caller = (path: string, init?: RequestInit) => Promise<Response>
const as = (email: string, groups = 'User'): Caller => (path, init) => Promise.resolve(hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', 'x-forwarded-email': email, 'x-forwarded-groups': groups, ...init?.headers } }, { surface: 'session' }))
const session = as('local@example.org', 'Admin')
const ada = as('ada@example.org')
const bob = as('bob@example.org')
const dee = as('dee@example.org')
const eve = as('eve@example.org')
const machine = (path: string, init: RequestInit | undefined, bearer: string) => Promise.resolve(hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}`, ...init?.headers } }, { surface: 'machine' }))
const machineAs = (bearer: () => string): Caller => (path, init) => machine(path, init, bearer())
const json = async <T = Record<string, unknown>>(r: Response): Promise<T> => (await r.json()) as T
const body = (v: unknown) => ({ body: JSON.stringify(v) })
const post = (v: unknown = {}) => ({ method: 'POST', ...body(v) })
const put = (v: unknown) => ({ method: 'PUT', ...body(v) })

const api = { blueprint: 'repo', key: 'acme-api' }
const web = { blueprint: 'repo', key: 'acme-web' }
const acme = { blueprint: 'repo', where: { relation: 'program', target: 'program:acme' } }

/** A tool that looks at one app of a repository's program. */
const show = (extra: Record<string, unknown> = {}) => ({
  title: 'Show an app',
  description: 'How one app is set up.',
  blueprint: 'repo',
  inputs: { app: { type: 'string', required: true } },
  backend: { type: 'runner', runner: 'acme-reader', command: ['az', 'webapp', 'show', '--name', '{{ inputs.app }}'], timeout: '30s' },
  tool: { tier: 'read', from: 'repo:acme-api' },
  ...extra,
})

/** A lane: an action with no form that a product asks for in a person's name, started and ended by that product. */
const lane = (title: string, access: Record<string, unknown>, backend: Record<string, unknown> = { type: 'caller' }) => ({ title, blueprint: 'repo', form: false, inputs: { request: { type: 'string', required: true } }, backend, access })

/** Takes the runner's side of a call: claims what waits for it, on a held line, and says what each job printed. */
const answer = async (runner: string, lines: string[], state: 'succeeded' | 'failed' = 'succeeded') => {
  const { jobs } = await json<{ jobs: RunnerJob[] }>(await machine('/v1/ingest/runner/jobs?wait=5', {}, runners[runner]!))
  for (const j of jobs) await machine(`/v1/ingest/runner/jobs/${j.run}/report`, post({ state, log: lines }), runners[runner]!)
  return jobs
}
const call = (who: Caller, tool: string, sent: Record<string, unknown>) => who(`/v1/tools/${tool}/call`, post(sent))
const ask = (who: Caller, action: string, sent: Record<string, unknown>) => who(`/v1/actions/${action}/run`, post(sent))
const changes = async (query: string) => (await json<{ changes: Change[] }>(await session(`/v1/changes?${query}`))).changes
const listed = async (who: Caller, query: string) => (await json<ToolsResponse>(await who(`/v1/tools?${query}`))).tools.map((t) => t.id).sort()

beforeAll(async () => {
  const config = loadConfig({ DATABASE_URL, DATA_DIR: mkdtempSync(join(tmpdir(), 'orrery-')), AUTH_MODE: 'proxy', PUBLIC_URL: 'https://hub.example.org', DISPATCH_PUBLIC_URL: 'https://desk.example.org/' })
  hub = await createHub(config, 'test', { reset: true })
  const admin = { admin: true, permissions: [] as never[], kind: 'user' as const, name: 'local', roles: [] }
  await hub.sources.save('estate', { title: 'Estate', class: 'pusher', blueprints: ['*'], deleteGrant: [], cadence: '3m' })
  pusher = (await hub.sources.issueToken('source', 'estate', { source: 'estate' })).token
  await hub.sources.save('desk-tools', { title: 'Desk tools', class: 'pusher', blueprints: [], deleteGrant: [], cadence: null, actions: true })
  declarer = (await hub.sources.issueToken('source', 'desk-tools', { source: 'desk-tools' })).token
  // One runner per key: a reader and an operator for the acme program, a reader that serves tools of no entity, and a runner that lends itself to nothing.
  const runner = async (id: string, serves?: Record<string, unknown>) => {
    await hub.sources.save(id, { title: id, class: 'runner', blueprints: [], deleteGrant: [], cadence: '5m', ...(serves ? { serves } : {}) })
    runners[id] = (await hub.sources.issueToken('source', id, { source: id })).token
  }
  await runner('acme-reader', { tiers: ['read'], sources: ['desk-tools'], on: acme })
  await runner('acme-operator', { tiers: ['act'], on: acme })
  await runner('estate-reader', { tiers: ['read'] })
  await runner('plain-runner')
  await hub.access.saveRole('desk', { title: 'Desk', permissions: ['actions.ask', 'tools.lend', 'actions.report', 'actions.list'] }, admin)
  await hub.access.saveRole('looker', { title: 'Looker', permissions: ['tools.read'] }, admin)
  await hub.access.saveRole('reporter', { title: 'Reporter', permissions: ['actions.report'] }, admin)
  desk = (await hub.sources.issueToken('access', 'desk', { role: 'desk' })).token
  assistant = (await hub.sources.issueToken('access', 'assistant', { role: 'looker' })).token
  plain = (await hub.sources.issueToken('access', 'plain', { role: 'reporter' })).token
  const save = (id: string, spec: Record<string, unknown>) => session(`/v1/blueprints/${id}`, put(spec))
  expect((await save('crew', { title: 'Crew', fields: {}, relations: {} })).status).toBe(200)
  expect((await save('crew_member', { title: 'Crew member', fields: { email: { type: 'email' } }, relations: { crews: { target: 'crew', many: true } } })).status).toBe(200)
  expect((await save('program', { title: 'Program', fields: {}, relations: {} })).status).toBe(200)
  expect((await save('repo', { title: 'Repository', fields: {}, relations: { program: { target: 'program' }, developers: { target: 'crew' }, stakeholders: { target: 'crew' }, architects: { target: 'crew' } } })).status).toBe(200)
  const owns = [
    { as: 'developer', path: 'crews.<-repo:developers' },
    { as: 'stakeholder', path: 'crews.<-repo:stakeholders' },
    { as: 'architect', path: 'crews.<-repo:architects' },
  ]
  expect((await session('/v1/access/person', put({ blueprint: 'crew_member', field: 'email', owns }))).status).toBe(200)
  const entity = (blueprint: string, key: string, spec: Record<string, unknown>) => machine(`/v1/ingest/entities/${blueprint}/${key}`, put({ title: key, ...spec }), pusher)
  for (const crew of ['builders', 'business', 'architects']) await entity('crew', crew, {})
  for (const program of ['acme', 'zed']) await entity('program', program, {})
  // Ada and Eve build acme's repositories, Bob asks for things of its API, and Dee is its architect. Bob's crew builds the other program.
  await entity('repo', 'acme-api', { relations: { program: 'acme', developers: 'builders', stakeholders: 'business', architects: 'architects' } })
  await entity('repo', 'acme-web', { relations: { program: 'acme', developers: 'builders' } })
  await entity('repo', 'zed-api', { relations: { program: 'zed', developers: 'business' } })
  for (const [who, crew] of [['ada', 'builders'], ['eve', 'builders'], ['bob', 'business'], ['dee', 'architects']] as const) await entity('crew_member', who, { fields: { email: `${who}@example.org` }, relations: { crews: [crew] } })
  // Everyone has signed in once, so the hub knows them.
  for (const who of [ada, bob, dee, eve]) expect((await who('/v1/whoami')).status).toBe(200)
  // The lanes. A developer's own request runs at once and reads; a stakeholder's waits for a developer; the architect's lane reads and acts.
  const lanes = {
    lane_developer: lane('Ask as a developer', { rules: [{ owns: ['developer'] }, { owns: ['architect'] }], tiers: ['read'] }, { type: 'caller', timeout: '30m' }),
    lane_stakeholder: lane('Ask as a stakeholder', { rules: [{ owns: ['stakeholder'], approval: true }, { owns: ['developer'] }, { owns: ['architect'] }] }),
    lane_architect: lane('Ask as an architect', { rules: [{ owns: ['architect'] }], tiers: ['read', 'act'] }),
    lane_careful: lane('Ask and look again', { rules: [{ owns: ['developer'], approval: 'self' }] }),
    lane_lonely: lane('Ask with nobody to decide', { rules: [{ owns: ['stakeholder'], approval: true }] }),
    lane_named: lane('Ask as someone named', { rules: [{ grants: [{ values: ['newcomer@example.org'] }], approval: true }] }),
    lane_but_one: lane('Ask as a developer, but for one', { rules: [{ owns: ['developer'], except: ['Eve@example.org'] }] }),
    lane_both: lane('Ask as a builder among the crews', { rules: [{ grants: [{ path: 'crews', values: ['builders', 'architects'] }], require: [{ path: 'crews', values: ['builders'] }] }] }),
    lane_required: lane('Ask as a builder', { rules: [{ require: [{ path: 'crews', values: ['builders'] }] }] }),
    // A program's lane the desk asks as itself, for anyone it vouches for: no person is let in.
    lane_program: lane('Ask for the program', { grants: [{ values: ['desk'] }] }),
  }
  for (const [id, spec] of Object.entries(lanes)) expect((await session(`/v1/actions/${id}`, put(spec))).status).toBe(200)
})

afterAll(async () => {
  await hub.close()
})

describe('what a runner serves', () => {
  it('is set by an admin alone, kept by a save that leaves it out, and cleared by null', async () => {
    const admin = { admin: true, permissions: [] as never[], kind: 'user' as const, name: 'local', roles: [] }
    await hub.access.saveRole('keeper', { title: 'Keeper', permissions: ['sources.manage'] }, admin)
    await hub.access.addUser('kit@example.org', ['keeper'], admin)
    const kit = as('kit@example.org')
    const spec = { title: 'Spare', class: 'runner', blueprints: [], deleteGrant: [], cadence: null }
    expect((await kit('/v1/sources/spare', put({ ...spec, serves: { tiers: ['act'] } }))).status).toBe(403)
    expect((await session('/v1/sources/spare', put({ ...spec, serves: { tiers: ['read'] } }))).status).toBe(200)
    // Someone who keeps sources may save one, and what it serves stays as the admin set it.
    expect((await json<Source>(await kit('/v1/sources/spare', put({ ...spec, title: 'Spare runner' })))).serves).toEqual({ tiers: ['read'] })
    expect((await kit('/v1/sources/spare', put({ ...spec, serves: null }))).status).toBe(403)
    expect((await json<Source>(await session('/v1/sources/spare', put({ ...spec, serves: null })))).serves).toBeUndefined()
  })

  it('is a runner\'s rule and names a tier', async () => {
    const spec = { title: 'Wrong', blueprints: [], deleteGrant: [], cadence: null }
    expect((await session('/v1/sources/wrong', put({ ...spec, class: 'pusher', serves: { tiers: ['read'] } }))).status).toBe(400)
    expect((await session('/v1/sources/wrong', put({ ...spec, class: 'runner', serves: { tiers: [] } }))).status).toBe(400)
  })
})

describe('defining a tool', () => {
  const save = (who: Caller, id: string, spec: Record<string, unknown>) => who(`/v1/actions/${id}`, put(spec))
  const declares = machineAs(() => declarer)

  it('needs a runner that serves its tier, from where the runner serves', async () => {
    const refused = async (spec: Record<string, unknown>, why: RegExp) => {
      const r = await save(session, 'broken', spec)
      expect(r.status).toBe(403)
      expect((await json(r)).error).toMatch(why)
    }
    await refused(show({ backend: { type: 'runner', runner: 'plain-runner', command: ['true'] } }), /serves no tools/)
    await refused(show({ tool: { tier: 'act', from: 'repo:acme-api' } }), /does not serve the act tier/)
    await refused(show({ tool: { tier: 'read' } }), /does not say where it was declared/)
    await refused(show({ tool: { tier: 'read', from: 'program:acme' } }), /declared from a repo, not from program:acme/)
  })

  it('takes no rule, approval, or form of its own, and runs only on a runner', async () => {
    for (const extra of [{ access: { everyone: true } }, { approval: true }, { form: true }, { backend: { type: 'caller' } }, { serial: ['app'] }]) expect((await save(session, 'broken', show(extra))).status).toBe(400)
  })

  it('is defined by an admin, or by a source its runner names, and by nobody else', async () => {
    const admin = { admin: true, permissions: [] as never[], kind: 'user' as const, name: 'local', roles: [] }
    await hub.access.saveRole('author', { title: 'Author', permissions: ['actions.manage'] }, admin)
    await hub.access.addUser('cy@example.org', ['author'], admin)
    const cy = as('cy@example.org')
    expect((await save(cy, 'app_show', show())).status).toBe(403)
    expect((await save(declares, 'app_show', show())).status).toBe(200)
    // The operator names no source, so only an admin puts a tool on it.
    const restart = show({ title: 'Restart an app', backend: { type: 'runner', runner: 'acme-operator', command: ['az', 'webapp', 'restart', '--name', '{{ inputs.app }}'], timeout: '30s' }, tool: { tier: 'act', from: 'repo:acme-api' }, serial: ['app'] })
    expect((await save(declares, 'app_restart', restart)).status).toBe(403)
    expect((await save(session, 'app_restart', restart)).status).toBe(200)
    // Someone who may change actions may not change a tool either: its command runs with the runner's key.
    expect((await save(cy, 'app_restart', { ...restart, title: 'Mine now' })).status).toBe(403)
    expect((await save(session, 'estate_health', { title: 'Estate health', inputs: {}, backend: { type: 'runner', runner: 'estate-reader', command: ['health'], timeout: '30s' }, tool: { tier: 'read' } })).status).toBe(200)
  })
})

describe('the door', () => {
  it('lists a tool to whoever holds its tier on the entity', async () => {
    // Ada's lane reads; Bob's carries nothing; Dee's reads and acts; an assistant that only looks reads everywhere.
    expect(await listed(ada, 'entity=repo:acme-api')).toEqual(['app_show'])
    expect(await listed(bob, 'entity=repo:acme-api')).toEqual([])
    expect(await listed(dee, 'entity=repo:acme-api')).toEqual(['app_restart', 'app_show'])
    expect(await listed(dee, 'entity=repo:acme-web')).toEqual([])
    expect(await listed(machineAs(() => assistant), 'entity=repo:acme-api')).toEqual(['app_show'])
    expect(await listed(session, 'entity=repo:acme-api')).toEqual(['app_restart', 'app_show'])
    // A tool of no entity is an admin's and a looker's.
    expect(await listed(machineAs(() => assistant), '')).toEqual(['estate_health'])
    expect(await listed(ada, '')).toEqual([])
    expect((await session('/v1/tools?entity=nope')).status).toBe(400)
  })

  it('runs the tool on its runner and answers what it printed, on the one call', async () => {
    const asked = call(ada, 'app_show', { entity: api, inputs: { app: 'acme-api-prod' } })
    const jobs = await answer('acme-reader', ['{ "state": "Running" }', '::output:: state=Running', 'exit 0'])
    expect(jobs.map((j) => j.command)).toEqual([['az', 'webapp', 'show', '--name', 'acme-api-prod']])
    const r = await asked
    expect(r.status).toBe(201)
    const said = await json<ToolCallResponse>(r)
    expect(said).toMatchObject({ state: 'succeeded', text: '{ "state": "Running" }\nexit 0', truncated: false, outputs: { state: 'Running' } })
    const [row] = await changes('kind=action.requested&actor=ada')
    expect(row).toMatchObject({ actor: 'ada@example.org', detail: { action: 'app_show', run: said.run, tool: 'read' } })
    expect(row!.detail.via).toBeUndefined()
    // A tool's run is a row like any other, and stays out of the lists people read unless asked for.
    const runs = async (query: string) => (await json<ActionRunsResponse>(await session(`/v1/action-runs?${query}`))).runs.map((x) => x.id)
    expect(await runs('limit=200')).not.toContain(said.run)
    expect(await runs('limit=200&tools=true')).toContain(said.run)
    expect(await runs('action=app_show')).toContain(said.run)
  })

  it('refuses whoever does not hold the tier, and records it', async () => {
    const r = await call(bob, 'app_show', { entity: api, inputs: { app: 'x' } })
    expect(r.status).toBe(403)
    expect((await json(r)).error).toMatch(/needs the read tier on repo:acme-api, which you do not hold/)
    expect((await changes('kind=access.refused&actor=bob'))[0]).toMatchObject({ actor: 'bob@example.org', outcome: 'refused', detail: { action: 'app_show', reason: 'no read tier held' } })
    // Reading is not acting: Ada's lane carries no act tier, and a looker never acts.
    expect((await call(ada, 'app_restart', { entity: api, inputs: { app: 'x' } })).status).toBe(403)
    expect((await call(machineAs(() => assistant), 'app_restart', { entity: api, inputs: { app: 'x' } })).status).toBe(403)
    expect((await call(ada, 'estate_health', {})).status).toBe(403)
  })

  it('is the only way to a tool, and no way to a plain action', async () => {
    const run = await ask(session, 'app_show', { entity: api, inputs: { app: 'x' } })
    expect(run.status).toBe(400)
    expect((await json(run)).error).toMatch(/is a tool: it is called through \/v1\/tools\/app_show\/call/)
    const plainly = await call(ada, 'lane_developer', { entity: api, inputs: { request: 'x' } })
    expect(plainly.status).toBe(400)
    expect((await json(plainly)).error).toMatch(/is not a tool/)
    expect((await call(ada, 'app_show', { inputs: { app: 'x' } })).status).toBe(400)
    expect((await call(ada, 'no_such_tool', { entity: api })).status).toBe(404)
  })

  it('stops running a tool once its runner no longer serves where it was declared', async () => {
    expect((await session('/v1/actions/zed_show', put(show({ tool: { tier: 'read', from: 'repo:zed-api' } })))).status).toBe(200)
    expect(await listed(session, 'entity=repo:acme-api')).not.toContain('zed_show')
    const r = await call(session, 'zed_show', { entity: api, inputs: { app: 'x' } })
    expect(r.status).toBe(409)
    expect((await json(r)).error).toMatch(/does not serve tools declared from repo:zed-api/)
    await session('/v1/actions/zed_show', { method: 'DELETE' })
  })

  it('gives up a call no runner took while its caller waited', async () => {
    expect((await session('/v1/actions/quick_show', put(show({ backend: { type: 'runner', runner: 'acme-reader', command: ['true'], timeout: '1s' } })))).status).toBe(200)
    const said = await json<ToolCallResponse>(await call(ada, 'quick_show', { entity: api, inputs: { app: 'x' } }))
    expect(said).toMatchObject({ state: 'cancelled', text: '' })
    expect((await json<ActionRun>(await session(`/v1/action-runs/${said.run}`))).log.at(-1)!.message).toMatch(/no runner took it while its caller waited/)
    await session('/v1/actions/quick_show', { method: 'DELETE' })
  })

  it('holds no more of what a tool printed than a run carries, and answers no more than a call carries', async () => {
    const asked = call(ada, 'app_show', { entity: api, inputs: { app: 'loud' } })
    await answer('acme-reader', Array.from({ length: 6 }, (_, i) => String(i).repeat(60_000)))
    const said = await json<ToolCallResponse>(await asked)
    expect(said.truncated).toBe(true)
    expect(said.text.length).toBe(64 * 1024)
    const held = (await json<ActionRun>(await session(`/v1/action-runs/${said.run}`))).log.map((l) => l.message)
    expect(held.filter((m) => m.length === 60_000)).toHaveLength(4)
    expect(held).toContain('output cut: the tool printed more than its run holds')
  })

  it('lets a looker call a tool of no entity', async () => {
    const asked = call(machineAs(() => assistant), 'estate_health', {})
    await answer('estate-reader', ['all green'])
    expect(await json<ToolCallResponse>(await asked)).toMatchObject({ state: 'succeeded', text: 'all green' })
  })
})

describe('asking in a person\'s name', () => {
  const asDesk = machineAs(() => desk)

  it('is judged as that person, and the row says who carried it', async () => {
    const r = await ask(asDesk, 'lane_stakeholder', { entity: api, inputs: { request: 'add a filter' }, for: 'bob@example.org' })
    expect(r.status).toBe(201)
    const run = await json<ActionRun>(r)
    expect(run).toMatchObject({ state: 'awaiting', by: 'bob@example.org', tiers: [], revises: null, note: null })
    expect(run.log[0]!.message).toBe('requested by bob@example.org through desk; waiting for approval')
    expect((await changes('kind=action.requested&actor=bob'))[0]).toMatchObject({ actor: 'bob@example.org', actorKind: 'user', detail: { run: run.id, via: 'desk', state: 'awaiting' } })
    // Bob asks only where a rule takes him, whoever carries the request.
    expect((await ask(asDesk, 'lane_stakeholder', { entity: web, inputs: { request: 'x' }, for: 'bob@example.org' })).status).toBe(400)
    expect((await changes('kind=access.refused&actor=bob'))[0]).toMatchObject({ detail: { action: 'lane_stakeholder', reason: 'no rule lets them run it on this', via: 'desk' } })
    await session(`/v1/action-runs/${run.id}/withdraw`, post())
  })

  it('is a product\'s to do, with the permission, and never a person\'s', async () => {
    const sent = { entity: api, inputs: { request: 'x' }, for: 'bob@example.org' }
    expect((await ask(session, 'lane_stakeholder', sent)).status).toBe(403)
    expect((await ask(machineAs(() => plain), 'lane_stakeholder', sent)).status).toBe(403)
    expect((await changes('kind=access.refused'))[0]).toMatchObject({ detail: { permission: 'actions.ask', reason: 'permission not held' } })
  })

  it('reads where a person may ask, by the rules alone', async () => {
    type Targets = { entities: { id: string }[]; approval: string[] }
    const where = async (action: string, person: string, who: Caller = asDesk) => who(`/v1/actions/${action}/targets?for=${encodeURIComponent(person)}`)
    const bob = await json<Targets>(await where('lane_stakeholder', 'bob@example.org'))
    // Bob asks as a stakeholder of acme's API, where his plan waits, and as a developer of the other program's.
    expect(bob.entities.map((e) => e.id)).toEqual(['repo:acme-api', 'repo:zed-api'])
    expect(bob.approval).toEqual(['repo:acme-api'])
    // The admin is judged by the rules like anyone else, and a stranger holds nothing and is not added.
    expect((await json<Targets>(await where('lane_stakeholder', 'local@example.org'))).entities).toEqual([])
    expect(await json<Targets>(await where('lane_stakeholder', 'nobody-yet@example.org'))).toEqual({ entities: [], approval: [] })
    expect(hub.access.find('nobody-yet@example.org')).toBeNull()
    // Someone a rule names by address holds the lane before they ever sign in, and reading still adds nobody.
    const newcomer = await json<Targets>(await where('lane_named', 'newcomer@example.org'))
    expect(newcomer.entities.map((e) => e.id)).toContain('repo:acme-api')
    expect(newcomer.approval).toContain('repo:acme-api')
    expect(hub.access.find('newcomer@example.org')).toBeNull()
    // A rule lets a crew in but for one of its members: Ada and Eve both build acme's API, and the rule leaves Eve out.
    expect((await json<Targets>(await where('lane_but_one', 'ada@example.org'))).entities.map((e) => e.id)).toContain('repo:acme-api')
    expect((await json<Targets>(await where('lane_but_one', 'eve@example.org'))).entities).toEqual([])
    // A rule's grants let in either crew, and what it requires narrows that to the builders: Ada is in, Dee the architect is not.
    expect((await json<Targets>(await where('lane_both', 'ada@example.org'))).entities.map((e) => e.id)).toContain('repo:acme-api')
    expect((await json<Targets>(await where('lane_both', 'dee@example.org'))).entities).toEqual([])
    // A rule that only requires lets in whoever meets every requirement, and nobody else.
    expect((await json<Targets>(await where('lane_required', 'eve@example.org'))).entities.map((e) => e.id)).toContain('repo:acme-api')
    expect((await json<Targets>(await where('lane_required', 'bob@example.org'))).entities).toEqual([])
    expect((await where('lane_stakeholder', 'bob@example.org', session)).status).toBe(403)
    expect((await where('lane_stakeholder', 'bob@example.org', machineAs(() => plain))).status).toBe(403)
  })

  it('never borrows an admin\'s override, and meets a stranger as nobody yet', async () => {
    // The admin signs in and may run anything; asked for by a product, they are a person the rules do not name.
    expect((await ask(asDesk, 'lane_developer', { entity: api, inputs: { request: 'x' }, for: 'local@example.org' })).status).toBeGreaterThanOrEqual(400)
    expect(hub.access.find('stranger@example.org')).toBeNull()
    expect((await ask(asDesk, 'lane_developer', { entity: api, inputs: { request: 'x' }, for: 'stranger@example.org' })).status).toBeGreaterThanOrEqual(400)
    expect(hub.access.find('stranger@example.org')).toMatchObject({ roles: [] })
  })
})

describe('a run that asks for tiers', () => {
  const tiered = async () => json<ActionRun>(await ask(machineAs(() => desk), 'lane_developer', { entity: api, inputs: { request: 'restart it' }, for: 'ada@example.org', tiers: ['read', 'act'] }))

  it('waits for someone who holds them, whatever the rule says', async () => {
    // Ada's own request runs at once, and the tier her lane carries is not an ask.
    const plainly = await json<ActionRun>(await machine('/v1/actions/lane_developer/run', post({ entity: api, inputs: { request: 'fix a typo' }, for: 'ada@example.org', tiers: ['read'] }), desk))
    expect(plainly).toMatchObject({ state: 'queued', tiers: [] })
    await session(`/v1/action-runs/${plainly.id}/withdraw`, post())
    const run = await tiered()
    expect(run).toMatchObject({ state: 'awaiting', tiers: ['act'] })
    expect((await changes('kind=action.requested&actor=ada'))[0]).toMatchObject({ detail: { run: run.id, tiers: ['act'] } })
    // Eve builds it too and could vouch for Ada, but nobody grants what they do not hold. Ada does not decide her own.
    const eves = await eve(`/v1/action-runs/${run.id}/approve`, post())
    expect(eves.status).toBe(403)
    expect((await json(eves)).error).toMatch(/asks for the act tool tier, which only someone who holds it here grants/)
    expect((await ada(`/v1/action-runs/${run.id}/approve`, post())).status).toBe(403)
    const approved = await json<ActionRun>(await dee(`/v1/action-runs/${run.id}/approve`, post()))
    expect(approved).toMatchObject({ state: 'queued', decidedBy: 'dee@example.org', tiers: ['act'] })
    expect((await changes('kind=action.approved'))[0]).toMatchObject({ actor: 'dee@example.org', detail: { run: run.id, tiers: ['act'], requestedBy: 'ada@example.org' } })
    await session(`/v1/action-runs/${run.id}/withdraw`, post())
  })

  it('is refused on an action that runs on nothing', async () => {
    await session('/v1/actions/anywhere', put({ title: 'Anywhere', form: false, inputs: {}, backend: { type: 'caller' }, access: { everyone: true } }))
    expect((await ask(machineAs(() => desk), 'anywhere', { inputs: {}, tiers: ['act'], for: 'ada@example.org' })).status).toBe(400)
    await session('/v1/actions/anywhere', { method: 'DELETE' })
  })
})

describe('a rule that says self', () => {
  it('makes the run wait, and lets whoever asked decide it', async () => {
    const run = await json<ActionRun>(await ask(machineAs(() => desk), 'lane_careful', { entity: api, inputs: { request: 'rename a field' }, for: 'ada@example.org' }))
    expect(run.state).toBe('awaiting')
    const mine = (await json<ActionRunsResponse>(await ada('/v1/action-runs?state=awaiting'))).runs.find((r) => r.id === run.id)
    expect(mine?.canDecide).toBe(true)
    const approved = await json<ActionRun>(await ada(`/v1/action-runs/${run.id}/approve`, post()))
    expect(approved).toMatchObject({ state: 'queued', decidedBy: 'ada@example.org' })
    expect((await changes('kind=action.approved'))[0]).toMatchObject({ detail: { run: run.id, selfApproved: true } })
    await session(`/v1/action-runs/${run.id}/withdraw`, post())
  })

  it('holds the run for its asker alone: nobody else the rule lets in, no approver, and no admin decides it', async () => {
    const run = await json<ActionRun>(await ask(machineAs(() => desk), 'lane_careful', { entity: api, inputs: { request: 'a plan for ada' }, for: 'ada@example.org' }))
    expect(run).toMatchObject({ state: 'awaiting', heldFor: 'self' })
    // Eve is a developer of the same repository, under the same rule: she sees the run, and may not decide it.
    expect((await json<ActionRun>(await eve(`/v1/action-runs/${run.id}`))).canDecide).toBe(false)
    for (const [who, path] of [
      [eve, 'approve'],
      [eve, 'decline'],
      [eve, 'return'],
      [session, 'approve'],
    ] as const) {
      const r = await who(`/v1/action-runs/${run.id}/${path}`, post(path === 'return' ? { note: 'not yours' } : {}))
      expect(r.status).toBe(403)
      expect((await json(r)).error).toMatch(/holds this run for the approval of the person who asked/)
    }
    expect(await hub.actions.deciders(await hub.actions.getRun(run.id).then((r) => r!))).toEqual(['ada@example.org'])
    const approved = await json<ActionRun>(await ada(`/v1/action-runs/${run.id}/approve`, post({ note: 'Read it; go ahead.' })))
    expect(approved).toMatchObject({ state: 'queued', decidedBy: 'ada@example.org', note: 'Read it; go ahead.' })
    expect(approved.log.map((l) => l.message)).toContain('approved by ada@example.org, who asked for it: Read it; go ahead.')
    await session(`/v1/action-runs/${run.id}/withdraw`, post())
  })

  it('keeps why a run was declined on the run, for its asker and the approvals inbox', async () => {
    const run = await json<ActionRun>(await ask(machineAs(() => desk), 'lane_careful', { entity: api, inputs: { request: 'a plan ada declines' }, for: 'ada@example.org' }))
    const declined = await json<ActionRun>(await ada(`/v1/action-runs/${run.id}/decline`, post({ reason: 'Not this quarter.' })))
    expect(declined).toMatchObject({ state: 'declined', decidedBy: 'ada@example.org', note: 'Not this quarter.' })
  })

  it('waits for whoever holds a tier it asks for, and then not for its asker alone', async () => {
    const run = await json<ActionRun>(await ask(machineAs(() => desk), 'lane_careful', { entity: api, inputs: { request: 'a plan that reads' }, for: 'ada@example.org', tiers: ['act'] }))
    expect(run).toMatchObject({ state: 'awaiting', heldFor: 'others' })
    expect((await ada(`/v1/action-runs/${run.id}/approve`, post())).status).toBe(403)
    // Nobody holds the act tier there by this lane's rule, so an admin, who holds every tier, grants it.
    expect((await json<ActionRun>(await session(`/v1/action-runs/${run.id}/approve`, post()))).state).toBe('queued')
    await session(`/v1/action-runs/${run.id}/withdraw`, post())
  })
})

describe('approvers a product names', () => {
  const asDesk = machineAs(() => desk)
  const architects = [{ path: 'crews', values: ['architects'] }]

  it('are the only people who decide the run: not its asker, not whoever the rules trust, not an admin', async () => {
    const run = await json<ActionRun>(await ask(asDesk, 'lane_stakeholder', { entity: api, inputs: { request: 'a plan for bob' }, for: 'bob@example.org', approvers: architects }))
    expect(run).toMatchObject({ state: 'awaiting', heldFor: 'others', approvers: architects })
    // Eve may run the stakeholder lane without approval, so the rules alone would let her decide it; the named approvers do not.
    expect((await json<ActionRun>(await eve(`/v1/action-runs/${run.id}`))).canDecide).toBe(false)
    for (const [who, why] of [
      [bob, /person who asked for this run never decides it/],
      [eve, /Only someone the run names as an approver decides it/],
      [session, /Only someone the run names as an approver decides it/],
    ] as const) {
      const r = await who(`/v1/action-runs/${run.id}/approve`, post())
      expect(r.status).toBe(403)
      expect((await json(r)).error).toMatch(why)
    }
    expect(await hub.actions.deciders((await hub.actions.getRun(run.id))!)).toEqual(['dee@example.org'])
    const approved = await json<ActionRun>(await dee(`/v1/action-runs/${run.id}/approve`, post({ note: 'Plan reads right.' })))
    expect(approved).toMatchObject({ state: 'queued', decidedBy: 'dee@example.org', note: 'Plan reads right.' })
    await session(`/v1/action-runs/${run.id}/withdraw`, post())
  })

  it('take the place of a rule that says self, so the asker never decides', async () => {
    const run = await json<ActionRun>(await ask(asDesk, 'lane_careful', { entity: api, inputs: { request: 'ada asks, architects decide' }, for: 'ada@example.org', approvers: architects }))
    expect(run).toMatchObject({ state: 'awaiting', heldFor: 'others' })
    expect((await ada(`/v1/action-runs/${run.id}/decline`, post({ reason: 'mine' }))).status).toBe(403)
    expect((await json<ActionRun>(await dee(`/v1/action-runs/${run.id}/decline`, post({ reason: 'Not this way.' })))).state).toBe('declined')
  })

  it('can be checked by the product against one person, as the hub judges them now', async () => {
    const check = async (who: Caller, address: string) => who('/v1/access/lets-in', post({ address, grants: architects }))
    expect(await json(await check(asDesk, 'dee@example.org'))).toEqual({ letsIn: true })
    expect(await json(await check(asDesk, 'Eve@example.org'))).toEqual({ letsIn: false })
    expect((await check(ada, 'dee@example.org')).status).toBe(403)
  })

  it('are named only by a product asking for someone else', async () => {
    const r = await ask(ada, 'lane_careful', { entity: api, inputs: { request: 'my own approvers' }, approvers: [{ values: ['ada@example.org'] }] })
    expect(r.status).toBe(400)
    expect((await json(r)).error).toMatch(/approvers are named only by a product that asks for a person/)
  })
})

describe('a run a product asks as itself for a person', () => {
  const asDesk = machineAs(() => desk)
  const architects = [{ path: 'crews', values: ['architects'] }]
  const lent = (person: string, run?: string) => ({ person, action: 'lane_program', entity: api, ...(run ? { run } : {}) })

  it('is the product\'s run, keeps the person as data, and needs nothing of them', async () => {
    // Fay has never signed in, holds no role, and sees nothing; no rule of the lane names her.
    const run = await json<ActionRun>(await ask(asDesk, 'lane_program', { entity: api, inputs: { request: 'the form loses my answers' }, requestedFor: 'Fay@Example.org', approvers: architects }))
    expect(run).toMatchObject({ state: 'awaiting', by: 'desk', requestedFor: 'fay@example.org', heldFor: 'others', approvers: architects })
    expect(hub.access.find('fay@example.org')).toBeNull()
    expect((await changes('kind=action.requested&actor=desk'))[0]).toMatchObject({ actor: 'desk', detail: { run: run.id, requestedFor: 'fay@example.org', state: 'awaiting' } })
    // Dee may not run the lane, but the approvers name her, so she alone decides it.
    expect(await hub.actions.deciders((await hub.actions.getRun(run.id))!)).toEqual(['dee@example.org'])
    // Eve neither runs the lane nor decides the run, so to her it is not there.
    expect((await eve(`/v1/action-runs/${run.id}/approve`, post())).status).toBe(404)
    expect(await json<ActionRun>(await dee(`/v1/action-runs/${run.id}/approve`, post({ note: 'Fix it.' })))).toMatchObject({ state: 'queued', decidedBy: 'dee@example.org', note: 'Fix it.' })
    await asDesk(`/v1/action-runs/${run.id}/report`, post({ state: 'succeeded' }))
  })

  it('is never decided by the person it is for, whatever the approvers say', async () => {
    const run = await json<ActionRun>(await ask(asDesk, 'lane_program', { entity: api, inputs: { request: 'dee asks through the desk' }, requestedFor: 'dee@example.org', approvers: architects }))
    const held = (await hub.actions.getRun(run.id))!
    expect(await hub.actions.deciders(held)).toEqual([])
    const asDee = { kind: 'user' as const, name: 'dee@example.org', admin: false, roles: [], permissions: [] }
    expect(await hub.actions.mayDecide(asDee, undefined, held)).toBe(false)
    // She may not run the lane and does not decide the run, so to her it is not there.
    expect((await dee(`/v1/action-runs/${run.id}/approve`, post())).status).toBe(404)
    await session(`/v1/action-runs/${run.id}/withdraw`, post())
  })

  it('waits only when it names approvers or the rule says so', async () => {
    const run = await json<ActionRun>(await ask(asDesk, 'lane_program', { entity: api, inputs: { request: 'a developer ships it' }, requestedFor: 'ada@example.org' }))
    expect(run).toMatchObject({ state: 'queued', by: 'desk', requestedFor: 'ada@example.org', heldFor: null })
    await asDesk(`/v1/action-runs/${run.id}/report`, post({ state: 'succeeded' }))
  })

  it('is asked only by a product the action lets in, with actions.ask, and never with for', async () => {
    const sent = { entity: api, inputs: { request: 'x' }, requestedFor: 'fay@example.org', approvers: architects }
    expect((await ask(machineAs(() => plain), 'lane_program', sent)).status).toBe(403)
    expect((await ask(asDesk, 'lane_stakeholder', sent)).status).toBe(403)
    const both = await ask(asDesk, 'lane_program', { ...sent, for: 'ada@example.org' })
    expect(both.status).toBe(400)
    expect((await json(both)).error).toMatch(/not both/)
  })

  it('lends the tiers its approver granted to the person it is for, while it is under way', async () => {
    const run = await json<ActionRun>(await ask(asDesk, 'lane_program', { entity: api, inputs: { request: 'read the app' }, requestedFor: 'fay@example.org', approvers: architects, tiers: ['read'] }))
    const show = (granted: boolean) => call(asDesk, 'app_show', { entity: api, inputs: { app: 'acme-api' }, as: lent('fay@example.org', granted ? run.id : undefined) })
    // The lane carries no tier, and asked for is not granted.
    expect((await show(true)).status).toBe(403)
    await dee(`/v1/action-runs/${run.id}/approve`, post())
    expect((await show(false)).status).toBe(403)
    // Another person's request is granted nothing by it.
    expect((await call(asDesk, 'app_show', { entity: api, inputs: { app: 'x' }, as: lent('bob@example.org', run.id) })).status).toBe(403)
    const asked = show(true)
    await answer('acme-reader', ['shown'])
    expect(await json<ToolCallResponse>(await asked)).toMatchObject({ state: 'succeeded', text: 'shown' })
    await asDesk(`/v1/action-runs/${run.id}/report`, post({ state: 'succeeded' }))
    expect((await show(true)).status).toBe(403)
  })
})

describe('a rule that waits for someone else', () => {
  it('is decided by whoever runs it there without approval, and never by someone a self rule lets in', async () => {
    // Ada's request in the careful lane is held for her alone; in the stakeholder lane, Bob's waits for a developer, and Bob may not decide it.
    const run = await json<ActionRun>(await ask(machineAs(() => desk), 'lane_stakeholder', { entity: api, inputs: { request: 'a report for bob' }, for: 'bob@example.org' }))
    expect(run).toMatchObject({ state: 'awaiting', heldFor: 'others' })
    expect((await bob(`/v1/action-runs/${run.id}/approve`, post())).status).toBe(403)
    expect((await json<ActionRun>(await eve(`/v1/action-runs/${run.id}/approve`, post()))).decidedBy).toBe('eve@example.org')
    await session(`/v1/action-runs/${run.id}/withdraw`, post())
  })
})

describe('sending a run back', () => {
  const asDesk = machineAs(() => desk)
  const asked = async (request: string, extra: Record<string, unknown> = {}) => ask(asDesk, 'lane_stakeholder', { entity: api, inputs: { request }, for: 'bob@example.org', ...extra })

  it('ends it with a note, and the asker asks again with a run that revises it', async () => {
    const first = await json<ActionRun>(await asked('make it faster'))
    expect((await ada(`/v1/action-runs/${first.id}/return`, post({ note: ' ' }))).status).toBe(400)
    expect((await bob(`/v1/action-runs/${first.id}/return`, post({ note: 'no' }))).status).toBe(403)
    const back = await json<ActionRun>(await ada(`/v1/action-runs/${first.id}/return`, post({ note: 'Which page is slow?' })))
    expect(back).toMatchObject({ state: 'returned', decidedBy: 'ada@example.org', note: 'Which page is slow?' })
    expect(back.finishedAt).not.toBeNull()
    expect(back.log.at(-1)!.message).toBe('sent back by ada@example.org: Which page is slow?')
    expect((await changes('kind=action.returned'))[0]).toMatchObject({ actor: 'ada@example.org', detail: { run: first.id, requestedBy: 'bob@example.org', note: 'Which page is slow?' } })
    // A run sent back is over: nobody decides it again.
    expect((await ada(`/v1/action-runs/${first.id}/approve`, post())).status).toBe(409)
    const second = await json<ActionRun>(await asked('make the orders page faster', { revises: first.id }))
    expect(second).toMatchObject({ state: 'awaiting', revises: first.id })
    expect((await changes('kind=action.requested&actor=bob'))[0]).toMatchObject({ detail: { run: second.id, revises: first.id } })
    // Only whoever asked for a run revises it, of the same action on the same entity.
    expect((await ask(asDesk, 'lane_stakeholder', { entity: api, inputs: { request: 'mine now' }, for: 'ada@example.org', revises: first.id })).status).toBe(400)
    expect((await asked('nothing', { revises: 'nope' })).status).toBe(400)
    await session(`/v1/action-runs/${second.id}/withdraw`, post())
  })

  it('takes a round that revises a run still waiting, which it supersedes, and refuses one that revises a decided run', async () => {
    const first = await json<ActionRun>(await asked('a report for the board'))
    expect(first.state).toBe('awaiting')
    const second = await json<ActionRun>(await asked('a report for the board, by quarter', { revises: first.id }))
    expect(second).toMatchObject({ state: 'awaiting', revises: first.id })
    const superseded = await json<ActionRun>(await session(`/v1/action-runs/${first.id}`))
    expect(superseded.state).toBe('cancelled')
    expect(superseded.decidedBy).toBeNull()
    expect(superseded.log.at(-1)!.message).toBe(`superseded by run ${second.id}, its next round, asked by bob@example.org`)
    expect((await changes('kind=action.cancelled'))[0]).toMatchObject({ detail: { run: first.id, reason: `superseded by run ${second.id}, its next round, asked by bob@example.org` } })
    expect((await hub.actions.roundsOf(first.id))).toMatchObject({ first: first.id, ids: [first.id, second.id], latest: { id: second.id } })
    // A run decided, or one that ended, is not revised: its round is over.
    await json<ActionRun>(await ada(`/v1/action-runs/${second.id}/approve`, post()))
    expect((await asked('by month instead', { revises: second.id })).status).toBe(409)
    expect((await asked('by week instead', { revises: first.id })).status).toBe(409)
  })
})

describe('a tool lent to a person\'s request', () => {
  const asDesk = machineAs(() => desk)
  const lent = (action: string, person = 'ada@example.org', run?: string) => ({ person, action, entity: api, ...(run ? { run } : {}) })

  it('reaches as that person, with the tiers of the lane they asked in', async () => {
    const asked = call(asDesk, 'app_show', { entity: api, inputs: { app: 'acme-api-test' }, as: lent('lane_developer') })
    await answer('acme-reader', ['ok'])
    const said = await json<ToolCallResponse>(await asked)
    expect(said).toMatchObject({ state: 'succeeded', text: 'ok' })
    expect((await changes('kind=action.requested&actor=ada'))[0]).toMatchObject({ actor: 'ada@example.org', actorKind: 'user', detail: { run: said.run, tool: 'read', via: 'desk' } })
    expect(await listed(asDesk, 'entity=repo:acme-api&for=ada@example.org&action=lane_developer')).toEqual(['app_show'])
  })

  it('stays in its lane: a tier the person holds through another action is not lent', async () => {
    // Ada may ask in the stakeholder lane too, and that lane carries nothing. Bob's lane carries nothing either.
    for (const as of [lent('lane_stakeholder'), lent('lane_stakeholder', 'bob@example.org')]) {
      const r = await call(asDesk, 'app_show', { entity: api, inputs: { app: 'x' }, as })
      expect(r.status).toBe(403)
      expect((await json(r)).error).toMatch(/needs the read tier on repo:acme-api, which this request was not granted/)
    }
    expect((await changes('kind=access.refused&actor=bob'))[0]).toMatchObject({ actor: 'bob@example.org', detail: { action: 'app_show', reason: 'no read tier held', via: 'desk' } })
    expect(await listed(asDesk, 'entity=repo:acme-api&for=ada@example.org&action=lane_stakeholder')).toEqual([])
  })

  it('reaches only the entity the request is on', async () => {
    const r = await call(asDesk, 'app_show', { entity: web, inputs: { app: 'x' }, as: lent('lane_developer') })
    expect(r.status).toBe(403)
    expect((await json(r)).error).toMatch(/called on the entity the request is on, and nowhere else/)
    expect((await call(asDesk, 'estate_health', { as: lent('lane_developer') })).status).toBe(403)
  })

  it('is a product\'s to do, with the permission, for a person the hub knows', async () => {
    const sent = { entity: api, inputs: { app: 'x' }, as: lent('lane_developer') }
    expect((await call(session, 'app_show', sent)).status).toBe(403)
    expect((await call(machineAs(() => assistant), 'app_show', sent)).status).toBe(403)
    // Someone the hub has not met is judged like anyone: no rule of this lane names them, so they hold no tier, and they are not added.
    expect((await call(asDesk, 'app_show', { ...sent, as: lent('lane_developer', 'nobody@example.org') })).status).toBe(403)
    expect(hub.access.find('nobody@example.org')).toBeNull()
    expect((await asDesk('/v1/tools?entity=repo:acme-api&for=ada@example.org')).status).toBe(400)
  })

  it('acts only while a run that was granted the act tier is under way', async () => {
    const run = await json<ActionRun>(await ask(asDesk, 'lane_developer', { entity: api, inputs: { request: 'restart the worker' }, for: 'ada@example.org', tiers: ['act'] }))
    const restart = () => call(asDesk, 'app_restart', { entity: api, inputs: { app: 'acme-worker' }, as: lent('lane_developer', 'ada@example.org', run.id) })
    // Asked for is not granted.
    expect((await restart()).status).toBe(403)
    await dee(`/v1/action-runs/${run.id}/approve`, post())
    expect(await listed(asDesk, `entity=repo:acme-api&for=ada@example.org&action=lane_developer&run=${run.id}`)).toEqual(['app_restart', 'app_show'])
    const asked = restart()
    await answer('acme-operator', ['restarted'])
    expect(await json<ToolCallResponse>(await asked)).toMatchObject({ state: 'succeeded', text: 'restarted' })
    // A run of someone else's, or of another lane, grants this request nothing.
    expect((await call(asDesk, 'app_restart', { entity: api, inputs: { app: 'x' }, as: lent('lane_developer', 'eve@example.org', run.id) })).status).toBe(403)
    // The product ends the run when its work is done, and the grant ends with it.
    expect((await asDesk(`/v1/action-runs/${run.id}/report`, post({ state: 'succeeded', summary: 'done' }))).status).toBe(200)
    expect((await restart()).status).toBe(403)
  })

  it('asks for a plain action as the person, once the request may act', async () => {
    expect((await session('/v1/actions/cache_clear', put({ title: 'Clear a cache', blueprint: 'repo', inputs: {}, backend: { type: 'runner', runner: 'plain-runner', command: ['clear'], timeout: '30s' }, access: { rules: [{ owns: ['developer'] }] } }))).status).toBe(200)
    const run = await json<ActionRun>(await ask(asDesk, 'lane_developer', { entity: api, inputs: { request: 'clear the cache' }, for: 'ada@example.org', tiers: ['act'] }))
    const clear = (granted: boolean) => call(asDesk, 'cache_clear', { entity: api, as: lent('lane_developer', 'ada@example.org', granted ? run.id : undefined) })
    const refused = await clear(false)
    expect(refused.status).toBe(403)
    expect((await json(refused)).error).toMatch(/was not granted the act tier/)
    await dee(`/v1/action-runs/${run.id}/approve`, post())
    const asked = clear(true)
    await answer('plain-runner', ['cleared'])
    const said = await json<ToolCallResponse>(await asked)
    expect(said).toMatchObject({ state: 'succeeded', text: 'cleared' })
    expect(await json<ActionRun>(await session(`/v1/action-runs/${said.run}`))).toMatchObject({ action: 'cache_clear', by: 'ada@example.org' })
    await asDesk(`/v1/action-runs/${run.id}/report`, post({ state: 'succeeded' }))
  })
})

describe('a runner\'s claim', () => {
  it('is handed no more jobs than it has room for', async () => {
    expect((await session('/v1/actions/sweep', put({ title: 'Sweep', inputs: { n: { type: 'string' } }, backend: { type: 'runner', runner: 'plain-runner', command: ['sweep', '{{ inputs.n }}'], timeout: '30s' } }))).status).toBe(200)
    for (const n of ['1', '2', '3']) expect((await ask(session, 'sweep', { inputs: { n } })).status).toBe(201)
    const claim = async (query: string) => (await json<{ jobs: RunnerJob[] }>(await machine(`/v1/ingest/runner/jobs${query}`, {}, runners['plain-runner']!))).jobs
    const first = await claim('?max=2')
    expect(first.map((j) => j.command[1])).toEqual(['1', '2'])
    const rest = await claim('?max=2')
    expect(rest.map((j) => j.command[1])).toEqual(['3'])
    for (const j of [...first, ...rest]) await machine(`/v1/ingest/runner/jobs/${j.run}/report`, post({ state: 'succeeded' }), runners['plain-runner']!)
  })

  it('is held open until there is a job, and no longer than asked', async () => {
    const started = Date.now()
    expect((await json<{ jobs: RunnerJob[] }>(await machine('/v1/ingest/runner/jobs?wait=1', {}, runners['plain-runner']!))).jobs).toEqual([])
    expect(Date.now() - started).toBeGreaterThanOrEqual(900)
    const held = machine('/v1/ingest/runner/jobs?wait=20', {}, runners['plain-runner']!)
    const asked = await json<ActionRun>(await ask(session, 'sweep', { inputs: { n: '4' } }))
    const { jobs } = await json<{ jobs: RunnerJob[] }>(await held)
    expect(jobs.map((j) => j.run)).toEqual([asked.id])
    expect(Date.now() - started).toBeLessThan(10_000)
    await machine(`/v1/ingest/runner/jobs/${asked.id}/report`, post({ state: 'succeeded' }), runners['plain-runner']!)
  })
})

describe('a run its caller started', () => {
  it('is given up once it is not heard from for the time its action allows', async () => {
    const asDesk = machineAs(() => desk)
    const run = await json<ActionRun>(await ask(asDesk, 'lane_developer', { entity: web, inputs: { request: 'a long build' }, for: 'ada@example.org' }))
    expect((await json<ActionRun>(await asDesk(`/v1/action-runs/${run.id}/report`, post({ state: 'running' })))).state).toBe('running')
    await hub.db.query(`UPDATE action_runs SET started_at = now() - interval '20 minutes', heard_at = now() - interval '20 minutes' WHERE id = $1`, [run.id])
    await hub.actions.expire()
    expect((await json<ActionRun>(await session(`/v1/action-runs/${run.id}`))).state).toBe('running')
    // It started long ago and was heard from a minute ago: it lives by being heard from, not by a clock from its start.
    await hub.db.query(`UPDATE action_runs SET started_at = now() - interval '5 hours', heard_at = now() - interval '1 minute' WHERE id = $1`, [run.id])
    await hub.actions.expire()
    expect((await json<ActionRun>(await session(`/v1/action-runs/${run.id}`))).state).toBe('running')
    await hub.db.query(`UPDATE action_runs SET heard_at = now() - interval '31 minutes' WHERE id = $1`, [run.id])
    await hub.actions.expire()
    const gone = await json<ActionRun>(await session(`/v1/action-runs/${run.id}`))
    expect(gone.state).toBe('unknown')
    expect(gone.log.at(-1)!.message).toMatch(/^not heard from for 30 minutes; given up\. It was handed on, so it may have done its work/)
  })
})

describe('who is told of a run', () => {
  const asDesk = machineAs(() => desk)
  const sent: NoticeEvent[] = []
  const dispatch: typeof fetch = async (url, init) => {
    if (String(url).endsWith('/v1/kinds')) return new Response(JSON.stringify({ kinds: 7 }), { status: 200 })
    sent.push(JSON.parse(String(init?.body)) as NoticeEvent)
    return new Response(JSON.stringify({ queued: 1, repeat: false }), { status: 202 })
  }
  const forwarder = (remindHours: number, approvers?: string) =>
    new NoticeForwarder({ db: hub.db, actions: hub.actions, batches: hub.batches, sets: hub.changeSets, schedules: hub.schedules, people: () => hub.people(), reader: hub.reader, blueprints: hub.blueprints, log: createLogger('notices-test') }, { url: 'http://dispatch.test/', token: 'tok', publicUrl: 'https://hub.example.org/', remindHours, ...(approvers ? { approvers } : {}) }, dispatch)
  const about = (run: string) => sent.filter((e) => e.links[0]!.url.endsWith(`/${run}`))
  const people = (e: NoticeEvent | undefined) => (e?.to ?? []).map((t) => ('person' in t ? t.person : `group:${'group' in t ? t.group : ''}`)).sort()

  it('tells a waiting run to the people a rule lets decide it, and what became of it to whoever asked', async () => {
    const waiting = await json<ActionRun>(await ask(asDesk, 'lane_stakeholder', { entity: api, inputs: { request: 'a new report' }, for: 'bob@example.org' }))
    const returned = await json<ActionRun>(await ask(asDesk, 'lane_lonely', { entity: api, inputs: { request: 'nobody home' }, for: 'bob@example.org' }))
    const tiered = await json<ActionRun>(await ask(asDesk, 'lane_developer', { entity: api, inputs: { request: 'act on it' }, for: 'ada@example.org', tiers: ['act'] }))
    const own = await json<ActionRun>(await ask(asDesk, 'lane_careful', { entity: api, inputs: { request: 'my own' }, for: 'ada@example.org' }))
    const quick = await json<ActionRun>(await ask(asDesk, 'lane_lonely', { entity: api, inputs: { request: 'decided at once' }, for: 'bob@example.org' }))
    await session(`/v1/action-runs/${quick.id}/decline`, post({ reason: 'no' }))
    const notices = forwarder(0, 'approvers')
    await notices.pass()
    await session(`/v1/action-runs/${returned.id}/return`, post({ note: 'Say more.' }))
    await ada(`/v1/action-runs/${own.id}/approve`, post())
    await notices.pass()
    const of = (run: ActionRun, kind: string) => about(run.id).find((e) => e.kind === kind)
    // Ada, Eve, and Dee may each run the stakeholder lane there without approval; Bob, who asked, is not one of them.
    expect(people(of(waiting, 'action.awaiting_approval'))).toEqual(['ada@example.org', 'dee@example.org', 'eve@example.org'])
    // Only Dee holds the act tier there, so only Dee is asked to grant it.
    expect(people(of(tiered, 'action.awaiting_approval'))).toEqual(['dee@example.org'])
    // No rule names a decider of the lonely lane, so it goes to the group the hub was told of.
    expect(people(of(returned, 'action.awaiting_approval'))).toEqual(['group:approvers'])
    expect(of(returned, 'action.returned')).toMatchObject({ title: 'local@example.org sent Ask with nobody to decide on acme-api back', text: 'Note: Say more.', to: [{ person: 'bob@example.org' }] })
    // Under a rule that says self the asker is a decider, and is not told what they did themselves.
    expect(people(of(own, 'action.awaiting_approval'))).toEqual(['ada@example.org'])
    expect(of(own, 'action.approved')).toBeDefined()
    expect(of(own, 'action.approved')!.to).toBeUndefined()
    // A run decided before anyone was told that it waits bothers no group.
    expect(of(quick, 'action.awaiting_approval')).toBeDefined()
    expect(of(quick, 'action.awaiting_approval')!.to).toBeUndefined()
    // A tool's run is told to nobody.
    expect(sent.some((e) => e.labels.action === 'app_show' || e.labels.action === 'app_restart')).toBe(false)
    for (const run of [waiting, tiered, own]) await session(`/v1/action-runs/${run.id}/withdraw`, post())
  })

  it('tells a run a product asked for a person to its approvers, and never to that person', async () => {
    sent.length = 0
    const architects = [{ path: 'crews', values: ['architects'] }]
    const run = await json<ActionRun>(await ask(asDesk, 'lane_program', { entity: api, inputs: { request: 'a plan for fay' }, requestedFor: 'fay@example.org', approvers: architects }))
    const notices = forwarder(0, 'approvers')
    await notices.pass()
    await dee(`/v1/action-runs/${run.id}/decline`, post({ reason: 'Not now.' }))
    await notices.pass()
    const waits = about(run.id).find((e) => e.kind === 'action.awaiting_approval')
    expect(people(waits)).toEqual(['dee@example.org'])
    expect(waits!.facts).toContainEqual({ name: 'Asked for', value: 'fay@example.org' })
    const declined = about(run.id).find((e) => e.kind === 'action.declined')
    expect(declined).toBeDefined()
    expect(declined!.to).toBeUndefined()
    expect(about(run.id).flatMap((e) => e.to ?? []).some((t) => 'person' in t && t.person === 'fay@example.org')).toBe(false)
  })

  it('tells nobody by name when no rule names anyone and the hub has no group', async () => {
    sent.length = 0
    const run = await json<ActionRun>(await ask(asDesk, 'lane_lonely', { entity: api, inputs: { request: 'still nobody' }, for: 'bob@example.org' }))
    await forwarder(0).pass()
    const waits = about(run.id).find((e) => e.kind === 'action.awaiting_approval')
    expect(waits).toBeDefined()
    expect(waits!.to).toBeUndefined()
    await session(`/v1/action-runs/${run.id}/withdraw`, post())
  })

  it('tells the deciders of a run that waits too long once more, and only once', async () => {
    const run = await json<ActionRun>(await ask(asDesk, 'lane_stakeholder', { entity: api, inputs: { request: 'a forgotten one' }, for: 'bob@example.org' }))
    const notices = forwarder(24)
    await notices.pass()
    sent.length = 0
    await hub.db.query(`UPDATE action_runs SET created_at = now() - interval '25 hours' WHERE id = $1`, [run.id])
    await notices.pass()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ kind: 'action.awaiting_approval', key: `remind:${run.id}`, title: 'Ask as a stakeholder on acme-api still waits for approval' })
    expect(people(sent[0])).toEqual(['ada@example.org', 'dee@example.org', 'eve@example.org'])
    sent.length = 0
    await notices.pass()
    await forwarder(24).pass()
    expect(sent.filter((e) => e.key.startsWith('remind:'))).toEqual([])
    await session(`/v1/action-runs/${run.id}/withdraw`, post())
  })
})

describe('tools over mcp', () => {
  it('lists and calls a tool as whoever holds the token', async () => {
    const rpc = async (method: string, params: Record<string, unknown>, id: number) => {
      const res = await machine('/mcp', { method: 'POST', headers: { accept: 'application/json, text/event-stream' }, ...body({ jsonrpc: '2.0', id, method, params }) }, assistant)
      const text = await res.text()
      const line = text.split('\n').find((l) => l.startsWith('data:'))
      return JSON.parse(line ? line.slice(5) : text) as { result: { content: { text: string }[] } }
    }
    const content = <T>(r: { result: { content: { text: string }[] } }) => JSON.parse(r.result.content[0]!.text) as T
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } }, 1)
    const tools = content<{ id: string; tier: string; inputs: Record<string, unknown> }[]>(await rpc('tools/call', { name: 'list_tools', arguments: { entity: 'repo:acme-api' } }, 2))
    expect(tools.map((t) => [t.id, t.tier, Object.keys(t.inputs)])).toEqual([['app_show', 'read', ['app']]])
    const asked = rpc('tools/call', { name: 'call_tool', arguments: { tool: 'app_show', entity: 'repo:acme-api', inputs: { app: 'acme-api-prod' } } }, 3)
    await answer('acme-reader', ['looked'])
    expect(content<ToolCallResponse>(await asked)).toMatchObject({ state: 'succeeded', text: 'looked', truncated: false })
    expect(content<{ error: string }>(await rpc('tools/call', { name: 'call_tool', arguments: { tool: 'app_restart', entity: 'repo:acme-api', inputs: { app: 'x' } } }, 4)).error).toMatch(/needs the act tier/)
    expect(content<{ error: string }>(await rpc('tools/call', { name: 'call_tool', arguments: { tool: 'lane_developer', entity: 'repo:acme-api' } }, 5)).error).toBe('no tool lane_developer')
  })
})

describe('where a person sets how they are told', () => {
  it('is the desk the hub was told of', async () => {
    expect((await json<WhoAmIResponse>(await ada('/v1/whoami'))).notifications).toBe('https://desk.example.org/me')
  })
})
