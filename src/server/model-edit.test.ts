import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import type { Blueprint } from '../shared/model.ts'
import { loadConfig } from './config.ts'
import { createHub, type Hub } from './hub.ts'
import { definitionOf, mergePatch, type ModelFile, type ModelPart } from './model-edit.ts'

// Every change the model page makes has a twin over the API and one through an
// agent's tool, and all three land on the same definition: the page sends a
// blueprint whole with PUT, the API lays a patch over it with PATCH, and the
// agent's edit_model lays the same patch, as the person its token is.

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://orrery:orrery@localhost:5433/orrery'
const ADMIN = 'architect@example.org'
const PLAIN = 'reader@example.org'
const SHAPER = 'shaper@example.org'

let hub: Hub
let adminKey = ''
let plainKey = ''
let shaperKey = ''

const body = (v: unknown) => ({ body: JSON.stringify(v) })
const as = (email: string, groups: string, path: string, init?: RequestInit) => Promise.resolve(hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', 'x-forwarded-email': email, 'x-forwarded-groups': groups, ...init?.headers } }, { surface: 'session' }))
const page = (path: string, init?: RequestInit) => as(ADMIN, 'Admin', path, init)
const machine = (bearer: string, path: string, init?: RequestInit) => Promise.resolve(hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}`, ...init?.headers } }, { surface: 'machine' }))
const json = async <T = Record<string, unknown>>(r: Response): Promise<T> => (await r.json()) as T

/** Calls an agent's tool with a personal token; answers with what the tool said. */
async function tool<T = Record<string, unknown>>(bearer: string, name: string, args: Record<string, unknown>): Promise<T> {
  const res = await machine(bearer, '/mcp', { method: 'POST', headers: { accept: 'application/json, text/event-stream' }, ...body({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })
  expect(res.status).toBe(200)
  const answer = (await res.json()) as { result: { content: { text: string }[] } }
  return JSON.parse(answer.result.content[0]!.text) as T
}

/** A blueprint's definition, without its id, so three blueprints changed three ways compare. */
const definition = async (id: string) => {
  const { id: _id, ...rest } = definitionOf(await json<Blueprint>(await page(`/v1/blueprints/${id}`)))
  return rest
}

/** The model page's save: the blueprint as it stands, changed, sent whole. */
async function pageSaves(id: string, change: (spec: Record<string, unknown>) => Record<string, unknown>) {
  const spec = definitionOf(await json<Blueprint>(await page(`/v1/blueprints/${id}`))) as unknown as Record<string, unknown>
  return page(`/v1/blueprints/${id}`, { method: 'PUT', ...body(change(structuredClone(spec))) })
}

/** One change made three ways: the page on twin_page, PATCH on twin_api, and edit_model on twin_agent. All three must hold the same definition after. */
async function threeWays(edit: (spec: Record<string, unknown>) => Record<string, unknown>, patch: Record<string, unknown>) {
  const saved = await pageSaves('twin_page', edit)
  expect(saved.status, await saved.clone().text()).toBe(200)
  const patched = await machine(adminKey, '/v1/blueprints/twin_api', { method: 'PATCH', ...body(patch) })
  expect(patched.status, await patched.clone().text()).toBe(200)
  const told = await tool<ModelPart & { error?: string }>(adminKey, 'edit_model', { id: 'twin_agent', change: patch })
  expect(told.error).toBeUndefined()
  const want = await definition('twin_page')
  expect(await definition('twin_api')).toEqual(want)
  expect(await definition('twin_agent')).toEqual(want)
  return want
}

beforeAll(async () => {
  hub = await createHub(loadConfig({ DATABASE_URL, DATA_DIR: mkdtempSync(join(tmpdir(), 'orrery-')), AUTH_MODE: 'proxy' }), 'test', { reset: true })
  // Each person signs in once, so a personal token of theirs has someone to be.
  await page('/v1/whoami')
  await as(PLAIN, 'User', '/v1/whoami')
  await as(SHAPER, 'User', '/v1/whoami')
  expect((await page(`/v1/users/${SHAPER}/roles`, { method: 'PUT', ...body({ roles: ['architect'] }) })).status).toBe(200)
  adminKey = (await hub.sources.issueToken('personal', 'agent', { owner: ADMIN })).token
  plainKey = (await hub.sources.issueToken('personal', 'agent', { owner: PLAIN })).token
  shaperKey = (await hub.sources.issueToken('personal', 'agent', { owner: SHAPER })).token
  const start = { title: 'Twin', fields: { team_key: { type: 'string' }, size: { type: 'number' }, notes: { type: 'markdown' } } }
  for (const id of ['twin_target', 'twin_page', 'twin_api', 'twin_agent']) expect((await page(`/v1/blueprints/${id}`, { method: 'PUT', ...body(id === 'twin_target' ? { title: 'Target', fields: { name: { type: 'string' } } } : start) })).status).toBe(200)
})

afterAll(async () => {
  await hub.close()
})

describe('a change laid over a definition', () => {
  it('merges objects, removes what null names, and replaces lists whole', () => {
    expect(mergePatch({ a: 1, b: { c: 2, d: [1, 2] }, e: 3 }, { b: { d: [3], f: 4 }, e: null })).toEqual({ a: 1, b: { c: 2, d: [3], f: 4 } })
    expect(mergePatch(undefined, { a: { b: 1 } })).toEqual({ a: { b: 1 } })
  })
})

describe('every model page change has an API twin and an agent twin', () => {
  it('changes the title, description, icon, and group', async () => {
    const want = await threeWays((s) => ({ ...s, title: 'Twin service', description: 'One service', icon: 'server', group: 'Software' }), { title: 'Twin service', description: 'One service', icon: 'server', group: 'Software' })
    expect(want).toMatchObject({ title: 'Twin service', icon: 'server', group: 'Software' })
  })

  it('adds a field', async () => {
    const field = { type: 'string', title: 'Owner keys', description: 'Who owns it' }
    const want = await threeWays((s) => ({ ...s, fields: { ...(s.fields as object), owner_keys: field } }), { fields: { owner_keys: field } })
    expect(want.fields.owner_keys).toEqual(field)
  })

  it("changes a field's calculation, and takes a key out of a list in it", async () => {
    await threeWays((s) => ({ ...s, fields: { ...(s.fields as object), doubled: { type: 'boolean', calculation: "team_key == 'a' || team_key == 'b'" } } }), { fields: { doubled: { type: 'boolean', calculation: "team_key == 'a' || team_key == 'b'" } } })
    const want = await threeWays((s) => { (s.fields as Record<string, { calculation?: string }>).doubled!.calculation = "team_key == 'a'"; return s }, { fields: { doubled: { calculation: "team_key == 'a'" } } })
    expect(want.fields.doubled?.calculation).toBe("team_key == 'a'")
  })

  it("changes a field's type and title", async () => {
    const want = await threeWays((s) => { const f = s.fields as Record<string, Record<string, unknown>>; f.notes = { type: 'string', title: 'Note' }; return s }, { fields: { notes: { type: 'string', title: 'Note' } } })
    expect(want.fields.notes).toEqual({ type: 'string', title: 'Note' })
  })

  it("sets a field's access and lock, as an admin", async () => {
    const access = { grants: [{ values: ['ops'] }] }
    const want = await threeWays((s) => { const f = s.fields as Record<string, Record<string, unknown>>; f.team_key = { ...f.team_key, access, adminEdit: true }; return s }, { fields: { team_key: { access, adminEdit: true } } })
    expect(want.fields.team_key).toMatchObject({ access, adminEdit: true })
  })

  it('adds a relation, a mirror over it, and an aggregation back along it', async () => {
    const team = { target: 'twin_target', title: 'Team' }
    await threeWays((s) => ({ ...s, relations: { ...(s.relations as object), team } }), { relations: { team } })
    const mirror = { type: 'string', mirror: 'team.name' }
    const want = await threeWays((s) => ({ ...s, fields: { ...(s.fields as object), team_name: mirror } }), { fields: { team_name: mirror } })
    expect(want.relations.team).toMatchObject(team)
    expect(want.fields.team_name).toEqual(mirror)
  })

  it('changes a relation, then removes it and a field', async () => {
    await threeWays((s) => { (s.relations as Record<string, Record<string, unknown>>).team!.many = true; return s }, { relations: { team: { many: true } } })
    const want = await threeWays((s) => { const f = s.fields as Record<string, unknown>; delete f.team_name; delete f.owner_keys; delete (s.relations as Record<string, unknown>).team; return s }, { fields: { team_name: null, owner_keys: null }, relations: { team: null } })
    expect(want.relations.team).toBeUndefined()
    expect(want.fields.owner_keys).toBeUndefined()
  })

  it('sets how long its entities are kept', async () => {
    const lifecycle = { expire: { after: '30d' } }
    expect((await threeWays((s) => ({ ...s, lifecycle }), { lifecycle })).lifecycle).toEqual(lifecycle)
  })

  it('adds an aggregation on the target, the same each way', async () => {
    for (const [id, how] of [['twin_page', 'page'], ['twin_api', 'api'], ['twin_agent', 'agent']] as const) {
      const rel = { relations: { team: { target: 'twin_target' } } }
      const res = how === 'agent' ? await tool(adminKey, 'edit_model', { id, change: rel }) : await machine(adminKey, `/v1/blueprints/${id}`, { method: 'PATCH', ...body(rel) })
      expect('status' in res ? res.status : 200).toBe(200)
    }
    const count = (id: string) => ({ type: 'number', aggregation: { relation: `<-${id}:team`, fn: 'count' } })
    expect((await pageSaves('twin_target', (s) => ({ ...s, fields: { ...(s.fields as object), on_page: count('twin_page') } }))).status).toBe(200)
    expect((await machine(adminKey, '/v1/blueprints/twin_target', { method: 'PATCH', ...body({ fields: { on_api: count('twin_api') } }) })).status).toBe(200)
    expect((await tool<{ error?: string }>(adminKey, 'edit_model', { id: 'twin_target', change: { fields: { on_agent: count('twin_agent') } } })).error).toBeUndefined()
    const target = await definition('twin_target')
    expect(target.fields.on_page).toEqual(count('twin_page'))
    expect(target.fields.on_agent).toEqual(count('twin_agent'))
  })

  it('creates, changes, and removes a relation rule', async () => {
    const rule = (blueprint: string) => ({ blueprint, relation: 'team', match: { target: 'twin_target', where: 'source.team_key == target.name' } })
    expect((await page('/v1/rules/r_page', { method: 'PUT', ...body(rule('twin_page')) })).status).toBe(200)
    expect((await machine(adminKey, '/v1/rules/r_api', { method: 'PATCH', ...body(rule('twin_api')) })).status).toBe(200)
    expect((await tool<{ error?: string }>(adminKey, 'edit_model', { kind: 'rule', id: 'r_agent', change: rule('twin_agent') })).error).toBeUndefined()
    expect((await page('/v1/rules/r_page', { method: 'PUT', ...body({ ...rule('twin_page'), optional: true }) })).status).toBe(200)
    expect((await machine(adminKey, '/v1/rules/r_api', { method: 'PATCH', ...body({ optional: true }) })).status).toBe(200)
    expect((await tool<{ error?: string }>(adminKey, 'edit_model', { kind: 'rule', id: 'r_agent', change: { optional: true } })).error).toBeUndefined()
    const { rules } = await json<{ rules: { id: string; blueprint: string; optional?: boolean; match: unknown }[] }>(await page('/v1/rules'))
    const shape = (id: string) => { const { id: _i, blueprint: _b, origin: _o, ...r } = rules.find((x) => x.id === id)! as Record<string, unknown>; return r }
    expect(shape('r_api')).toEqual(shape('r_page'))
    expect(shape('r_agent')).toEqual(shape('r_page'))
    expect(shape('r_page')).toMatchObject({ optional: true })
    expect((await page('/v1/rules/r_page', { method: 'DELETE' })).status).toBe(200)
    expect((await machine(adminKey, '/v1/rules/r_api', { method: 'DELETE' })).status).toBe(200)
    expect(await tool(adminKey, 'delete_from_model', { kind: 'rule', id: 'r_agent' })).toEqual({ removed: { kind: 'rule', id: 'r_agent' } })
    expect((await json<{ rules: { id: string }[] }>(await page('/v1/rules'))).rules.map((r) => r.id)).not.toContain('r_agent')
    expect((await machine(adminKey, '/v1/rules/r_api', { method: 'DELETE' })).status).toBe(404)
  })

  it('creates and changes a scorecard and an alert rule', async () => {
    const card = (blueprint: string) => ({ title: 'Sized', blueprint, levels: [{ name: 'Bronze', rules: [{ id: 'sized', title: 'Has a size', where: { field: 'size', op: 'exists' } }] }] })
    expect((await page('/v1/scorecards/s_page', { method: 'PUT', ...body(card('twin_page')) })).status).toBe(200)
    expect((await tool<{ error?: string }>(adminKey, 'edit_model', { kind: 'scorecard', id: 's_agent', change: card('twin_agent') })).error).toBeUndefined()
    expect((await machine(adminKey, '/v1/scorecards/s_agent', { method: 'PATCH', ...body({ title: 'Sized well' }) })).status).toBe(200)
    expect((await tool<ModelPart>(adminKey, 'get_model_definition', { kind: 'scorecard', id: 's_agent' })).definition).toMatchObject({ title: 'Sized well', blueprint: 'twin_agent', levels: card('twin_agent').levels })
    const alert = { blueprint: 'twin_agent', where: 'alert.labels.service == target.key' }
    expect((await tool<{ error?: string }>(adminKey, 'edit_model', { kind: 'alert_rule', id: 'a_agent', change: alert })).error).toBeUndefined()
    expect((await machine(adminKey, '/v1/alert-rules/a_api', { method: 'PUT', ...body({ ...alert, blueprint: 'twin_api' }) })).status).toBe(200)
    const read = await tool<ModelPart & { on: { scorecards: string[]; alertRules: string[] } }>(adminKey, 'get_model_definition', { id: 'twin_agent' })
    expect(read.on).toMatchObject({ scorecards: ['s_agent'], alertRules: ['a_agent'] })
    expect(read.changeable).toBe(true)
  })

  it('renames and removes a blueprint the same each way', async () => {
    for (const id of ['gone_page', 'gone_agent']) expect((await page(`/v1/blueprints/${id}`, { method: 'PUT', ...body({ title: 'Gone' }) })).status).toBe(200)
    expect((await page('/v1/blueprints/gone_page/rename', { method: 'POST', ...body({ to: 'went_page' }) })).status).toBe(200)
    expect((await tool<ModelPart>(adminKey, 'rename_blueprint', { blueprint: 'gone_agent', to: 'went_agent' })).id).toBe('went_agent')
    expect((await page('/v1/blueprints/went_page', { method: 'DELETE' })).status).toBe(200)
    expect(await tool(adminKey, 'delete_from_model', { id: 'went_agent' })).toEqual({ removed: { kind: 'blueprint', id: 'went_agent' } })
    for (const id of ['went_page', 'went_agent']) expect((await page(`/v1/blueprints/${id}`)).status).toBe(404)
  })
})

describe('the same refusal on every door', () => {
  it("refuses a calculation that does not compile with the editor's words, and changes nothing", async () => {
    const before = await definition('twin_api')
    const bad = { fields: { doubled: { calculation: "team_key == (" } } }
    const viaPage = await pageSaves('twin_page', (s) => { (s.fields as Record<string, { calculation?: string }>).doubled!.calculation = "team_key == ("; return s })
    const viaApi = await machine(adminKey, '/v1/blueprints/twin_api', { method: 'PATCH', ...body(bad) })
    const viaAgent = await tool<{ error: string }>(adminKey, 'edit_model', { id: 'twin_api', change: bad })
    expect(viaPage.status).toBe(400)
    expect(viaApi.status).toBe(400)
    const said = (await json<{ error: string }>(viaApi)).error
    expect(said).toMatch(/^Field "doubled": bad calculation/)
    expect((await json<{ error: string }>(viaPage)).error).toBe(said)
    expect(viaAgent.error).toBe(said)
    expect(await definition('twin_api')).toEqual(before)
  })

  it('refuses a name a definition does not take, rather than dropping it', async () => {
    const before = await definition('twin_api')
    const typo = { fields: { doubled: { calcuation: "team_key == 'b'" } }, colour: 'red' }
    const api = await machine(adminKey, '/v1/blueprints/twin_api', { method: 'PATCH', ...body(typo) })
    expect(api.status).toBe(400)
    const said = (await json<{ error: string }>(api)).error
    expect(said).toMatch(/^"fields\.doubled\.calcuation", "colour" are not part of a blueprint's definition/)
    expect((await tool<{ error: string }>(adminKey, 'edit_model', { id: 'twin_api', change: typo })).error).toBe(said)
    expect((await tool<{ error: string }>(adminKey, 'edit_model', { kind: 'rule', id: 'r_typo', change: { blueprint: 'twin_api', relation: 'team', match: { target: 'twin_target', where: 'source.team_key == target.name' }, optinal: true } })).error).toMatch(/"optinal" is not part of a rule's definition/)
    expect(await definition('twin_api')).toEqual(before)
  })

  it('refuses a caller without model.edit, and records it', async () => {
    const before = await definition('twin_api')
    const api = await machine(plainKey, '/v1/blueprints/twin_api', { method: 'PATCH', ...body({ title: 'Mine now' }) })
    expect(api.status).toBe(403)
    expect((await json<{ error: string }>(api)).error).toMatch(/model\.edit/)
    for (const [name, args] of [['edit_model', { id: 'twin_api', change: { title: 'Mine now' } }], ['delete_from_model', { id: 'twin_api' }], ['rename_blueprint', { blueprint: 'twin_api', to: 'mine' }]] as const) {
      expect(await tool(plainKey, name, args)).toEqual({ error: 'This needs the "model.edit" permission' })
    }
    expect((await machine(plainKey, '/v1/rules/r_none', { method: 'PUT', ...body({}) })).status).toBe(403)
    expect(await definition('twin_api')).toEqual(before)
    const { changes } = await json<{ changes: { kind: string; actor: string; outcome: string; detail: { tool?: string } }[] }>(await page(`/v1/changes?actor=${PLAIN}&outcome=refused`))
    expect(changes.map((c) => c.detail.tool ?? 'api')).toEqual(expect.arrayContaining(['edit_model', 'delete_from_model', 'rename_blueprint', 'api']))
  })

  it("keeps an access rule an admin's, through the agent as through the API", async () => {
    const access = { field: { access: { grants: [{ values: ['everyone'] }] } } }
    const api = await machine(shaperKey, '/v1/blueprints/twin_api', { method: 'PATCH', ...body({ fields: { size: access.field } }) })
    expect(api.status).toBe(403)
    const said = (await json<{ error: string }>(api)).error
    expect((await tool<{ error: string }>(shaperKey, 'edit_model', { id: 'twin_api', change: { fields: { size: access.field } } })).error).toBe(said)
    // What they may change, they change: the admin's rule on team_key stays where it was.
    expect((await tool<{ error?: string }>(shaperKey, 'edit_model', { id: 'twin_api', change: { description: 'Shaped' } })).error).toBeUndefined()
    expect(await definition('twin_api')).toMatchObject({ description: 'Shaped', fields: { team_key: { access: { grants: [{ values: ['ops'] }] }, adminEdit: true } } })
  })

  it('records each change under the person the token is', async () => {
    const { changes } = await json<{ changes: { kind: string; actor: string; blueprint: string | null; outcome: string }[] }>(await page(`/v1/changes?actor=${SHAPER}&kind=blueprint.changed`))
    expect(changes.find((c) => c.blueprint === 'twin_api' && c.outcome === 'ok')).toBeTruthy()
    // A change an agent made says so: it came through the agent's door.
    const agent = await json<{ changes: { blueprint: string | null; detail: { door?: string } }[] }>(await page(`/v1/changes?actor=${ADMIN}&kind=blueprint.changed`))
    expect(agent.changes.find((c) => c.blueprint === 'twin_agent')?.detail.door).toBe('mcp')
    expect(agent.changes.find((c) => c.blueprint === 'twin_page')?.detail.door).toBeUndefined()
    const failed = await json<{ changes: { kind: string; outcome: string }[] }>(await page(`/v1/changes?actor=${SHAPER}&outcome=failed`))
    expect(failed.changes.some((c) => c.kind === 'blueprint.changed')).toBe(true)
  })
})

describe('the model, read back whole', () => {
  it('is the YAML the import takes, and holds every part', async () => {
    const res = await machine(adminKey, '/v1/model/export')
    expect(res.headers.get('content-type')).toMatch(/yaml/)
    const file = parse(await res.text()) as ModelFile
    const twin = file.blueprints.find((b) => b.id === 'twin_agent')!
    expect(twin).toEqual(definitionOf(await json<Blueprint>(await page('/v1/blueprints/twin_agent'))))
    expect(file.blueprints.some((b) => b.id.startsWith('orrery_'))).toBe(false)
    expect(file.scorecards.map((s) => s.id)).toContain('s_agent')
    expect(file.alertRules.map((r) => r.id)).toEqual(expect.arrayContaining(['a_agent', 'a_api']))
    expect(twin.fields.team_key?.access).toEqual({ grants: [{ values: ['ops'] }] })
  })

  it('keeps access rules from a reader who is not an admin, and narrows to one blueprint', async () => {
    const file = await json<ModelFile>(await machine(shaperKey, '/v1/model/export?blueprint=twin_agent&format=json'))
    expect(file.blueprints.map((b) => b.id)).toEqual(['twin_agent'])
    expect(file.blueprints[0]!.fields.team_key?.access).toBeUndefined()
    expect(file.scorecards.map((s) => s.id)).toEqual(['s_agent'])
  })

  it('imports as it was exported', async () => {
    expect((await page('/v1/blueprints/kept_out', { method: 'PUT', ...body({ title: 'Kept', description: 'A copy to compare', fields: { size: { type: 'number', title: 'Size' }, doubled: { type: 'number', calculation: 'size * 2' } } }) })).status).toBe(200)
    const yaml = (await (await machine(adminKey, '/v1/model/export?blueprint=kept_out')).text()).replaceAll('kept_out', 'kept_in')
    const report = await json<{ errors: string[]; blueprints: { created: string[] } }>(await page('/v1/model/import', { method: 'POST', ...body({ yaml }) }))
    expect(report.errors).toEqual([])
    expect(report.blueprints.created).toEqual(['kept_in'])
    expect(await definition('kept_in')).toEqual(await definition('kept_out'))
  })
})

describe('the published surface', () => {
  it('names every model route and tool', async () => {
    const spec = await json<{ paths: Record<string, Record<string, unknown>> }>(await machine(adminKey, '/v1/openapi.json'))
    for (const [path, methods] of Object.entries({ '/v1/blueprints/{id}': ['put', 'patch', 'delete'], '/v1/rules/{id}': ['put', 'patch', 'delete'], '/v1/scorecards/{id}': ['put', 'patch', 'delete'], '/v1/alert-rules/{id}': ['put', 'patch', 'delete'], '/v1/model/export': ['get'] })) {
      for (const m of methods) expect(spec.paths[path]?.[m], `${m} ${path}`).toBeTruthy()
    }
    const res = await machine(adminKey, '/mcp', { method: 'POST', headers: { accept: 'application/json, text/event-stream' }, ...body({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })
    const names = ((await res.json()) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name)
    expect(names).toEqual(expect.arrayContaining(['get_model_definition', 'edit_model', 'delete_from_model', 'rename_blueprint']))
  })
})
