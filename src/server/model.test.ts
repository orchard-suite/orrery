import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import type { EntitiesResponse, EntityPageResponse, FindingsResponse, ImportReport, ModelTemplate, ScorecardResults } from '../shared/api.ts'
import type { Entity, Filter } from '../shared/model.ts'
import { loadConfig } from './config.ts'
import { createHub, type Hub } from './hub.ts'

// A model brought in through the import, on a hub that starts with nothing
// but what the Kubernetes pusher brings.

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://orrery:orrery@localhost:5433/orrery'

let hub: Hub
let token = ''
let other = ''

const session = (path: string, init?: RequestInit) => hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', ...init?.headers } }, { surface: 'session' })
const machine = (path: string, init?: RequestInit, bearer = token) => hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}`, ...init?.headers } }, { surface: 'machine' })
const json = async <T = Record<string, unknown>>(r: Response): Promise<T> => (await r.json()) as T
const body = (v: unknown) => ({ body: JSON.stringify(v) })
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString()

type Shape = { title?: string; fields?: Record<string, unknown>; relations?: Record<string, string | string[]> }
/** What a pusher writes. */
async function put(blueprint: string, key: string, entity: Shape, bearer = token): Promise<void> {
  const res = await machine(`/v1/ingest/entities/${blueprint}/${encodeURIComponent(key)}`, { method: 'PUT', ...body(entity) }, bearer)
  expect([200, 201], `${blueprint}:${key} ${await res.clone().text()}`).toContain(res.status)
}
/** What a person makes in the web app. */
async function make(blueprint: string, key: string, entity: Shape = {}): Promise<void> {
  const res = await session('/v1/entities', { method: 'POST', ...body({ blueprint, key, ...entity }) })
  expect(res.status, `${blueprint}:${key} ${await res.clone().text()}`).toBe(201)
  await hub.rules.settled()
}
/** What a person edits in the web app, once what inherits from it is linked again behind the answer. */
const edit = async (blueprint: string, key: string, patch: { fields?: Record<string, unknown>; relations?: Record<string, string | string[] | null> }) => {
  const res = await session(`/v1/entities/${blueprint}/${encodeURIComponent(key)}`, { method: 'PATCH', ...body(patch) })
  await hub.rules.settled()
  return res
}
const get = async (blueprint: string, key: string) => json<EntityPageResponse>(await session(`/v1/entities/${blueprint}/${encodeURIComponent(key)}`))
const search = async (blueprint: string, filter: Filter) => (await json<{ entities: Entity[] }>(await session(`/v1/entities?blueprint=${blueprint}&filter=${encodeURIComponent(JSON.stringify(filter))}`))).entities.map((e) => e.key).sort()
const bring = async (what: { template: string } | { yaml: string }) => {
  const res = await session('/v1/model/import', { method: 'POST', ...body(what) })
  expect(res.status, await res.clone().text()).toBe(200)
  await hub.rules.settled()
  return json<ImportReport>(res)
}
const MODEL = readFileSync(join(import.meta.dirname, 'fixtures/model.yaml'), 'utf8')
const keys = (refs: { key: string }[] | undefined) => (refs ?? []).map((r) => r.key)

beforeAll(async () => {
  const config = loadConfig({ DATABASE_URL, DATA_DIR: mkdtempSync(join(tmpdir(), 'orrery-')), AUTH_MODE: 'none' })
  hub = await createHub(config, 'test', { reset: true })
  await hub.sources.save('estate', { title: 'estate', class: 'pusher', blueprints: ['*'], deleteGrant: [], cadence: null })
  await hub.sources.save('second', { title: 'second', class: 'pusher', blueprints: ['*'], deleteGrant: [], cadence: null })
  token = (await hub.sources.issueToken('source', 'estate', { source: 'estate' })).token
  other = (await hub.sources.issueToken('source', 'second', { source: 'second' })).token
  const pusher = parse(readFileSync(join(import.meta.dirname, '../../cmd/pusher-k8s/blueprints.yaml'), 'utf8')) as { blueprints: unknown[] }
  expect((await machine('/v1/ingest/blueprints', { method: 'PUT', ...body(pusher) })).status).toBe(200)
})

afterAll(async () => {
  await hub.close()
})

describe('importing a model', () => {
  it('lists what the hub offers', async () => {
    const { templates } = await json<{ templates: ModelTemplate[] }>(await session('/v1/model/templates'))
    expect(templates.map((t) => t.id)).toEqual(['kubernetes'])
    expect(templates[0]?.blueprints).toEqual(expect.arrayContaining(['k8s_cluster', 'k8s_workload', 'argocd_app']))
  })

  it('creates what is missing, adds to what exists, and leaves everything editable', async () => {
    expect((await session('/v1/blueprints/sw_service', { method: 'PUT', ...body({ title: 'Service', fields: { cost_centre: { type: 'string' } } }) })).status).toBe(200)
    const report = await bring({ yaml: MODEL })
    expect(report.errors).toEqual([])
    expect(report.blueprints.created).toEqual(expect.arrayContaining(['organization', 'department', 'team', 'person', 'program', 'sw_environment', 'domain', 'repository', 'sw_workload', 'api']))
    expect(report.blueprints.extended).toEqual(['sw_service'])
    expect(report.scorecards.created.sort()).toEqual(['program_hygiene', 'service_hygiene'])
    expect(hub.blueprints.get('program')?.origin).toEqual({ kind: 'ui' })
    // The existing blueprint keeps what it had and gains what the model adds.
    expect(hub.blueprints.get('sw_service')).toMatchObject({ title: 'Service', fields: { cost_centre: { type: 'string' }, tier: { type: 'enum' } }, relations: { repository: { target: 'repository' }, team: { target: 'team', inherit: 'program.team' } } })
    expect((await session('/v1/blueprints/program', { method: 'PUT', ...body({ ...hub.blueprints.get('program'), title: 'Product' }) })).status).toBe(200)
  })

  it('changes nothing the second time', async () => {
    const again = await bring({ yaml: MODEL })
    expect(again.blueprints).toMatchObject({ created: [], extended: [] })
    expect(again.scorecards.created).toEqual([])
    expect(hub.blueprints.get('program')?.title).toBe('Product')
  })

  it('ties the Kubernetes pusher into the model, rollups included', async () => {
    const report = await bring({ template: 'kubernetes' })
    expect(report.errors).toEqual([])
    expect(report.blueprints.extended.sort()).toEqual(['argocd_app', 'k8s_cluster', 'k8s_namespace', 'k8s_workload', 'sw_service', 'sw_workload'])
    expect(report.rules.created.sort()).toEqual(['argocd_app.workload', 'k8s_workload.service'])
    expect(hub.blueprints.get('sw_workload')?.status?.relations).toEqual(['services', '<-argocd_app:workload'])
  })

  it('takes a model file and the entities in it', async () => {
    const yaml = `
blueprints:
  - id: database
    title: Database
    relations:
      domains: { target: domain, many: true }
entities:
  - { blueprint: domain, key: identity, title: Identity }
  - { blueprint: database, key: directory, title: Directory, relations: { domains: [identity] } }
`
    expect(await bring({ yaml })).toMatchObject({ blueprints: { created: ['database'] }, entities: { created: 2, kept: 0 }, errors: [] })
    expect(await bring({ yaml })).toMatchObject({ blueprints: { created: [], kept: ['database'] }, entities: { created: 0, kept: 2 } })
    expect((await session('/v1/model/import', { method: 'POST', ...body({ yaml: 'blueprints: [' }) })).status).toBe(400)
  })
})

describe('ownership and environment', () => {
  it('are inherited until something sets them', async () => {
    await make('organization', 'acme', { title: 'Acme' })
    await make('department', 'engineering', { title: 'Engineering', relations: { organization: 'acme' } })
    await make('team', 'platform', { title: 'Platform', relations: { department: 'engineering' } })
    await make('team', 'identity', { title: 'Identity', relations: { department: 'engineering', parent: 'platform' } })
    await make('person', 'ada', { title: 'Ada', relations: { teams: ['platform', 'identity'] } })
    await make('program', 'ember', { title: 'Ember', relations: { team: 'platform' } })
    await put('repository', 'gitlab/acme/ember', { title: 'ember', fields: { name: 'ember', language: 'C#' } })
    await make('sw_service', 'directory-api', { title: 'Directory API', relations: { program: 'ember', repository: 'gitlab/acme/ember' } })
    await make('sw_service', 'directory-analyzer', { title: 'Directory analyzer', relations: { program: 'ember', repository: 'gitlab/acme/ember' } })
    await make('sw_workload', 'directory', { title: 'Directory', relations: { program: 'ember', services: ['directory-api', 'directory-analyzer'], domains: ['identity'] } })
    await make('api', 'directory', { title: 'Directory API', relations: { service: 'directory-api' } })

    const api = await get('sw_service', 'directory-api')
    expect(keys(api.relations.team)).toEqual(['platform'])
    expect(api.outgoing.find((o) => o.relation === 'team')?.layer).toBe('inherited')
    expect(api.fields).toMatchObject({ language: 'C#', workloads: 1, apis: 1 })
    expect(keys((await get('sw_workload', 'directory')).relations.team)).toEqual(['platform'])
    // The API reads its team through the service, which reads it from the program: two inherited steps.
    expect(keys((await get('api', 'directory')).relations.team)).toEqual(['platform'])
    // What a team owns counts whether it was set or inherited.
    expect((await get('team', 'platform')).fields).toMatchObject({ programs: 1, workloads: 1, services: 2, members: 1, sub_teams: 1 })
    expect(await search('sw_service', { relation: 'team', target: 'team:platform' })).toEqual(['directory-analyzer', 'directory-api'])
  })

  it('give way to a team set on one entity, and come back when it is cleared', async () => {
    expect((await edit('sw_service', 'directory-analyzer', { relations: { team: 'identity' } })).status).toBe(200)
    const analyzer = await get('sw_service', 'directory-analyzer')
    expect(keys(analyzer.relations.team)).toEqual(['identity'])
    expect(analyzer.outgoing.find((o) => o.relation === 'team')?.layer).toBe('ui')
    expect((await get('team', 'platform')).fields.services).toBe(1)
    expect((await get('team', 'identity')).fields.services).toBe(1)
    await edit('sw_service', 'directory-analyzer', { relations: { team: null } })
    expect(keys((await get('sw_service', 'directory-analyzer')).relations.team)).toEqual(['platform'])
    // Moving the program moves everything that inherits from it.
    await edit('program', 'ember', { relations: { team: 'identity' } })
    expect(keys((await get('api', 'directory')).relations.team)).toEqual(['identity'])
    await edit('program', 'ember', { relations: { team: 'platform' } })
  })

  it('show in a kept grid each time they move, not only the first', async () => {
    const teams = async () => {
      await hub.rules.settled()
      const grid = await json<{ entities: Entity[] }>(await session('/v1/entities?blueprint=sw_service&distribution=true&limit=100'))
      return keys(grid.entities.find((e) => e.key === 'directory-api')?.relations.team)
    }
    expect(await teams()).toEqual(['platform'])
    for (const team of ['identity', 'platform', 'identity', 'platform']) {
      await edit('program', 'ember', { relations: { team } })
      expect(await teams()).toEqual([team])
    }
  })

  it('come from where a thing runs: the cluster, or one namespace inside it', async () => {
    await make('sw_environment', 'production', { title: 'Production', fields: { type: 'production' } })
    await make('sw_environment', 'test', { title: 'Test', fields: { type: 'pre_production' } })
    await put('k8s_cluster', 'home', { title: 'home' })
    await put('k8s_namespace', 'home/ember', { title: 'ember', fields: { name: 'ember' }, relations: { cluster: 'home' } })
    await put('k8s_namespace', 'home/ember-test', { title: 'ember-test', fields: { name: 'ember-test' }, relations: { cluster: 'home' } })
    await put('k8s_workload', 'home/ember/api', { title: 'api', fields: { name: 'api', kind: 'Deployment', health: 'green', labels: { 'app.kubernetes.io/name': 'directory-api' } }, relations: { namespace: 'home/ember' } })
    await put('k8s_workload', 'home/ember-test/api', { title: 'api', fields: { name: 'api', kind: 'Deployment', health: 'red', health_reason: '0/1 ready', labels: { 'app.kubernetes.io/name': 'directory-api' } }, relations: { namespace: 'home/ember-test' } })
    await edit('k8s_cluster', 'home', { relations: { environment: 'production' } })
    await edit('k8s_namespace', 'home/ember-test', { relations: { environment: 'test' } })
    await hub.rules.evaluateAll()

    expect(keys((await get('k8s_namespace', 'home/ember')).relations.environment)).toEqual(['production'])
    expect(keys((await get('k8s_workload', 'home/ember/api')).relations.environment)).toEqual(['production'])
    expect(keys((await get('k8s_workload', 'home/ember-test/api')).relations.environment)).toEqual(['test'])
    // The label found the service, the service gave the Deployment its team, and the Deployment gave the service its status.
    const running = await get('k8s_workload', 'home/ember/api')
    expect(keys(running.relations.service)).toEqual(['directory-api'])
    expect(keys(running.relations.team)).toEqual(['platform'])
    const service = await get('sw_service', 'directory-api')
    expect(service.fields.runs_on).toBe(2)
    expect(service.status).toMatchObject({ level: 'red', reasons: ['api: 0/1 ready'] })
    expect((await get('sw_workload', 'directory')).status.level).toBe('red')
    expect((await get('program', 'ember')).status.level).toBe('red')
    expect(await search('k8s_workload', { relation: 'environment', target: 'sw_environment:production' })).toEqual(['home/ember/api'])
  })
})

describe('an inherited relation with cases', () => {
  // A gadget's team comes from its program when it is backend, is identity when it is frontend, and platform otherwise.
  const gadget = {
    title: 'Gadget',
    fields: { kind: { type: 'enum', values: ['backend', 'frontend', 'other'] } },
    relations: {
      program: { target: 'program' },
      team: {
        target: 'team',
        inherit: [
          { when: { field: 'kind', op: 'eq', value: 'backend' }, path: 'program.team' },
          { when: { field: 'kind', op: 'eq', value: 'frontend' }, target: 'identity' },
          { target: 'platform' },
        ],
      },
    },
  }
  const team = async (key: string) => keys((await get('gadget', key)).relations.team)

  it('gives each entity the first case it matches that reaches a target', async () => {
    expect((await session('/v1/blueprints/gadget', { method: 'PUT', ...body(gadget) })).status).toBe(200)
    await make('program', 'billing', { title: 'Billing', relations: { team: 'identity' } })
    await make('program', 'orphan', { title: 'Orphan' })
    await make('gadget', 'ledger', { fields: { kind: 'backend' }, relations: { program: 'billing' } })
    await make('gadget', 'stray', { fields: { kind: 'backend' }, relations: { program: 'orphan' } })
    await make('gadget', 'portal', { fields: { kind: 'frontend' }, relations: { program: 'orphan' } })
    await make('gadget', 'docs', { fields: { kind: 'other' } })
    await hub.rules.settled()

    expect(await team('ledger')).toEqual(['identity'])
    // Its program has no team, so the backend case reaches nothing and the last case gives it one.
    expect(await team('stray')).toEqual(['platform'])
    expect(await team('portal')).toEqual(['identity'])
    expect(await team('docs')).toEqual(['platform'])
    expect((await get('gadget', 'ledger')).outgoing.find((o) => o.relation === 'team')?.layer).toBe('inherited')
  })

  it('moves an entity to another case when a person changes the value a case reads', async () => {
    expect((await edit('gadget', 'portal', { fields: { kind: 'backend' } })).status).toBe(200)
    expect(await team('portal')).toEqual(['platform'])
    expect((await edit('gadget', 'portal', { relations: { program: 'billing' } })).status).toBe(200)
    expect(await team('portal')).toEqual(['identity'])
  })

  it('gives way to a team set on the entity, and follows the program when it moves', async () => {
    expect((await edit('gadget', 'ledger', { relations: { team: 'platform' } })).status).toBe(200)
    expect((await get('gadget', 'ledger')).outgoing.find((o) => o.relation === 'team')?.layer).toBe('ui')
    expect(await team('ledger')).toEqual(['platform'])
    await edit('gadget', 'ledger', { relations: { team: null } })
    expect(await team('ledger')).toEqual(['identity'])
    await edit('program', 'orphan', { relations: { team: 'identity' } })
    expect(await team('stray')).toEqual(['identity'])
  })

  it('answers a save before what inherits from it is linked again', async () => {
    // The pass is held open: a save that waited on it would never answer.
    let release = () => {}
    const held = new Promise<void>((resolveHeld) => (release = resolveHeld))
    const passes = hub.rules as unknown as { inherit: (...args: unknown[]) => Promise<boolean> }
    const inherit = passes.inherit.bind(hub.rules)
    const spy = vi.spyOn(passes, 'inherit').mockImplementation(async (...args) => {
      await held
      return inherit(...args)
    })
    try {
      const save = Promise.resolve(session('/v1/entities/gadget/stray', { method: 'PATCH', ...body({ relations: { program: 'billing' } }) }))
      const first = await Promise.race([save.then(() => 'answered'), new Promise((resolveLate) => setTimeout(() => resolveLate('waiting'), 2000))])
      expect(first).toBe('answered')
      expect((await save).status).toBe(200)
    } finally {
      release()
      spy.mockRestore()
    }
    await hub.rules.settled()
    expect(await team('stray')).toEqual(['identity'])
  })

  it('follows a link a relation rule makes once the rule is saved', async () => {
    // A widget finds its gadget by name, and takes its team from that gadget.
    const widget = { title: 'Widget', fields: { gadget_name: { type: 'string' } }, relations: { gadget: { target: 'gadget' }, team: { target: 'team', inherit: 'gadget.team' } } }
    expect((await session('/v1/blueprints/widget', { method: 'PUT', ...body(widget) })).status).toBe(200)
    await make('widget', 'w1', { fields: { gadget_name: 'ledger' } })
    expect(keys((await get('widget', 'w1')).relations.team)).toEqual([])
    expect((await session('/v1/rules/widget.gadget', { method: 'PUT', ...body({ blueprint: 'widget', relation: 'gadget', match: { target: 'gadget', where: 'target.key == source.gadget_name' } }) })).status).toBe(200)
    await hub.rules.settled()
    expect(keys((await get('widget', 'w1')).relations.team)).toEqual(['identity'])
    expect((await session('/v1/rules/widget.gadget', { method: 'DELETE' })).status).toBe(200)
    await hub.rules.settled()
    expect(keys((await get('widget', 'w1')).relations.team)).toEqual([])
  })

  it('is refused when a case cannot be read where relations are inherited', async () => {
    const refusedWith = async (inherit: unknown, reason: RegExp) => {
      const res = await session('/v1/blueprints/gadget', { method: 'PUT', ...body({ ...gadget, relations: { ...gadget.relations, team: { target: 'team', inherit } } }) })
      expect(res.status, await res.clone().text()).toBe(400)
      expect((await json<{ error: string }>(res)).error).toMatch(reason)
    }
    await refusedWith([{ path: 'program.team', target: 'platform' }], /a path or a target, not both/)
    await refusedWith([{ when: { field: 'kind', op: 'eq', value: 'backend' } }], /a path or a target, not both/)
    await refusedWith([{ when: { scorecard: 'service_hygiene', op: 'gte', value: 'Bronze' }, target: 'platform' }], /reads a scorecard level/)
    await refusedWith([{ when: { relation: '<-sw_service:program' }, target: 'platform' }], /asks who points at the entity/)
    await refusedWith([{ path: 'program' }], /inherit ends at program, but the relation targets team/)
  })
})

describe('scorecards and filters', () => {
  it('score an inherited owner like a set one', async () => {
    const results = await json<ScorecardResults>(await session('/v1/scorecards/service_hygiene/results'))
    expect(results.rows.find((r) => r.entity.key === 'directory-api')?.rules).toMatchObject({ has_repository: true, has_description: false, has_program: true, has_team: true })
    const programs = await json<ScorecardResults>(await session('/v1/scorecards/program_hygiene/results'))
    expect(programs.rows.find((r) => r.entity.key === 'ember')?.rules).toMatchObject({ has_team: true, has_services: true, has_workloads: true })
  })

  it('ask whether a relation is set in either direction, and compare a datetime with a time back from now', async () => {
    await put('repository', 'gitlab/acme/old', { title: 'old', fields: { name: 'old', last_push: daysAgo(40) } })
    await put('repository', 'gitlab/acme/ember', { title: 'ember', fields: { name: 'ember', language: 'C#', last_push: daysAgo(10) } })
    expect(await search('repository', { relation: '<-sw_service:repository' })).toEqual(['gitlab/acme/ember'])
    expect(await search('sw_service', { relation: '<-sw_workload:services', target: 'sw_workload:directory' })).toEqual(['directory-analyzer', 'directory-api'])
    expect(await search('repository', { field: 'last_push', op: 'within', value: '30d' })).toEqual(['gitlab/acme/ember'])
    expect(await search('repository', { field: 'last_push', op: 'older', value: '30d' })).toEqual(['gitlab/acme/old'])
  })

  it('read a field before what the hub keeps under the same name', async () => {
    expect((await session('/v1/blueprints/asset', { method: 'PUT', ...body({ title: 'Asset', fields: { owner: { type: 'string' }, state: { type: 'string' } } }) })).status).toBe(200)
    await make('asset', 'laptop', { fields: { owner: 'ada', state: 'in repair' } })
    await make('asset', 'spare')
    expect(await search('asset', { field: 'owner', op: 'exists' })).toEqual(['laptop'])
    expect(await search('asset', { field: '$owner', op: 'eq', value: 'ui' })).toEqual(['laptop', 'spare'])
    expect(await search('asset', { field: '$state', op: 'eq', value: 'active' })).toEqual(['laptop', 'spare'])
  })
})

describe('things that happened', () => {
  const deployment = (id: string, status: string, days: number) => ({ blueprint: 'sw_deployment', key: `home/argocd/directory/${id}`, title: `directory #${id}`, fields: { status, deployed_at: daysAgo(days) }, relations: { app: 'home/argocd/directory' } })

  it('are counted over a window, as a rate, and through several hops', async () => {
    await put('argocd_app', 'home/argocd/directory', { title: 'directory', fields: { health: 'green', sync_status: 'Synced' }, relations: { namespace: 'home/ember' } })
    const run = await json<{ id: string }>(await machine('/v1/ingest/runs', { method: 'POST', ...body({ mode: 'incremental', scope: 'home/deployments' }) }))
    const sent = await machine(`/v1/ingest/runs/${run.id}/entities`, { method: 'PUT', ...body({ entities: [deployment('1', 'succeeded', 2), deployment('2', 'succeeded', 10), deployment('3', 'failed', 5), deployment('4', 'succeeded', 60), deployment('5', 'succeeded', 200)] }) })
    expect(sent.status).toBe(200)
    // The one already past the blueprint's 180 days is not brought in.
    expect(await json(await machine(`/v1/ingest/runs/${run.id}/commit`, { method: 'POST' }))).toMatchObject({ counts: { created: 4, unchanged: 1, rejected: 0, missing: 0 } })
    expect((await session('/v1/entities/sw_deployment/home%2Fargocd%2Fdirectory%2F5')).status).toBe(404)
    // The commit answers before the re-link; the links it brings land when that pass finishes.
    await hub.rules.settled()

    const app = await get('argocd_app', 'home/argocd/directory')
    // The application is named after the workload, so it found it, and it reads its environment from its namespace.
    expect(keys(app.relations.workload)).toEqual(['directory'])
    expect(keys(app.relations.environment)).toEqual(['production'])
    expect(app.fields).toMatchObject({ deployments_30d: 2, failed_deployments_30d: 1, deployments_per_week: 0.23, change_failure_rate: 33 })
    expect((await get('sw_workload', 'directory')).fields).toMatchObject({ sync_status: 'Synced', deployments_30d: 2, failed_deployments_30d: 1, deployments_per_week: 0.23, change_failure_rate: 33, last_deployed_at: app.fields.last_deployed_at })
  })

  it('leave by age, with a tombstone, and are not brought back', async () => {
    const aged = { title: 'directory #4', fields: { status: 'succeeded', deployed_at: daysAgo(181) }, relations: { app: 'home/argocd/directory' } }
    await put('sw_deployment', 'home/argocd/directory/4', aged)
    expect(await hub.runs.expireAged()).toBe(1)
    expect((await session('/v1/entities/sw_deployment/home%2Fargocd%2Fdirectory%2F4')).status).toBe(404)
    expect((await hub.db.query<{ state: string }>(`SELECT state FROM entities WHERE blueprint = 'sw_deployment' AND key = 'home/argocd/directory/4'`)).rows).toEqual([{ state: 'deleted' }])
    await put('sw_deployment', 'home/argocd/directory/4', aged)
    expect((await session('/v1/entities/sw_deployment/home%2Fargocd%2Fdirectory%2F4')).status).toBe(404)
    expect(await hub.runs.expireAged()).toBe(0)
  })

  it('say how they came and left by the day, and when the ones held now expire', async () => {
    const held = await hub.runs.held(90)
    const deploys = held.blueprints.find((b) => b.id === 'sw_deployment')!
    expect(deploys.came).toHaveLength(90)
    // Four came today, and the one past its age left today.
    expect(deploys.came.at(-1)).toBe(4)
    expect(deploys.left.at(-1)).toBe(1)
    expect(deploys.came.slice(0, -1).every((n) => n === 0)).toBe(true)
    // Deployed 2, 5, and 10 days ago, each lives 180 days from then.
    expect(deploys.expire?.afterDays).toBe(180)
    expect([178, 175, 170].map((d) => deploys.expire!.ahead[d])).toEqual([1, 1, 1])
    expect(deploys.expire!.ahead.reduce((n, v) => n + v, 0)).toBe(3)
    // Nothing is said of what is held without expiry ahead, and the history is never longer than tombstones are kept.
    expect(held.blueprints.find((b) => b.id === 'argocd_app')?.expire).toBeUndefined()
    expect((await hub.runs.held(30)).blueprints.find((b) => b.id === 'sw_deployment')!.came).toHaveLength(30)
  })
})

describe('an import on a large estate', () => {
  it('answers once the model is saved, and re-links after', async () => {
    let release = () => {}
    const blocked = new Promise<void>((resolve) => (release = resolve))
    const real = hub.rules.evaluate.bind(hub.rules)
    hub.rules.evaluate = async (rule) => (await blocked, real(rule))
    try {
      const res = await Promise.race([
        session('/v1/model/import', { method: 'POST', ...body({ yaml: 'relationRules:\n  - { id: slow.rule, blueprint: service, relation: repository, optional: true, match: { target: repository, where: "target.key == source.path" } }\n' }) }),
        new Promise<'waited'>((resolve) => setTimeout(() => resolve('waited'), 1000)),
      ])
      expect(res).not.toBe('waited')
      expect((res as Response).status).toBe(200)
    } finally {
      release()
      await hub.rules.settled()
      hub.rules.evaluate = real
    }
  })
})

describe('a person known by several addresses', () => {
  it('is found by a relation rule through any one of them', async () => {
    await bring({
      yaml: `
blueprints:
  - id: staff
    title: Staff
    fields:
      emails: { type: array }
  - id: change
    title: Change
    fields:
      author: { type: string }
      reviewers: { type: array }
    relations:
      by: { target: staff, many: false }
      reviewed_by: { target: staff, many: true }
relationRules:
  - { id: change.by, blueprint: change, relation: by, match: { target: staff, where: "target.emails == source.author" } }
  - { id: change.reviewed_by, blueprint: change, relation: reviewed_by, match: { target: staff, where: "target.emails == source.reviewers" } }
`,
    })
    await put('staff', 'ann@example.org', { title: 'Ann', fields: { emails: ['ann@example.org', 'ann@example.com'] } })
    await put('staff', 'bob@example.org', { title: 'Bob', fields: { emails: ['bob@example.org'] } })
    await put('change', 'c1', { fields: { author: 'ann@example.com', reviewers: ['bob@example.org', 'ann@example.org', 'nobody@example.org'] } })
    await put('change', 'c2', { fields: { author: 'stranger@example.org' } })
    await hub.rules.evaluateAll()
    const c1 = await get('change', 'c1')
    expect(c1.relations.by?.map((r) => r.key)).toEqual(['ann@example.org'])
    expect(c1.relations.reviewed_by?.map((r) => r.key).sort()).toEqual(['ann@example.org', 'bob@example.org'])
    expect((await get('change', 'c2')).relations.by ?? []).toEqual([])
  })

  it('is found by a name or address kept beside the ones a pusher writes, through a calculated list', async () => {
    await bring({
      yaml: `
blueprints:
  - id: member
    title: Member
    fields:
      emails: { type: array }
      git_identities: { type: array }
      identities: { type: array, calculation: "lower(list(emails, git_identities))" }
  - id: commit
    title: Commit
    fields:
      author: { type: string }
      author_email: { type: string }
      author_ids: { type: array, calculation: "lower(list(author_email, author))" }
    relations:
      by: { target: member, many: false }
relationRules:
  - { id: commit.by, blueprint: commit, relation: by, optional: true, match: { target: member, where: "target.identities == source.author_ids" } }
`,
    })
    await put('member', 'ann@example.org', { title: 'Ann', fields: { emails: ['ann@example.org'], git_identities: ['Ann-Home', 'ann@personal.example'] } })
    await put('commit', 'by-name', { fields: { author: 'ann-home', author_email: 'noreply@example.net' } })
    await put('commit', 'by-address', { fields: { author: 'whoever', author_email: 'ANN@personal.example' } })
    await put('commit', 'bot', { fields: { author: 'release-bot', author_email: 'bot@example.net' } })
    await hub.rules.evaluateAll()
    expect((await get('commit', 'by-name')).relations.by?.map((r) => r.key)).toEqual(['ann@example.org'])
    expect((await get('commit', 'by-address')).relations.by?.map((r) => r.key)).toEqual(['ann@example.org'])
    expect((await get('commit', 'bot')).relations.by ?? []).toEqual([])
  })
})

describe('several pushers on one blueprint', () => {
  it('each bring their fields, and the hub says when one writes what another wrote', async () => {
    const offer = await machine('/v1/ingest/blueprints', { method: 'PUT', ...body({ blueprints: [{ id: 'api', title: 'API', fields: { gateway: { type: 'string' }, kind: { type: 'string' } } }] }) }, other)
    expect(await json(offer)).toMatchObject({ created: [], extended: ['api'], rejected: [] })
    // The new field is there. The one that existed kept its own definition.
    expect(hub.blueprints.get('api')?.fields).toMatchObject({ gateway: { type: 'string' }, kind: { type: 'enum' } })

    await put('api', 'payments', { title: 'Payments', fields: { version: '1.0', gateway: 'edge' } })
    await put('api', 'payments', { title: 'Payments', fields: { version: '1.0', gateway: 'edge' } })
    const clean = await json<FindingsResponse>(await session('/v1/findings'))
    expect(clean.findings.filter((f) => f.kind === 'field_conflict')).toEqual([])
    await machine('/v1/ingest/entities/api/payments', { method: 'PATCH', ...body({ fields: { version: '2.0' } }) }, other)
    expect((await get('api', 'payments')).fields.version).toBe('2.0')
    const { findings } = await json<FindingsResponse>(await session('/v1/findings'))
    expect(findings.filter((f) => f.kind === 'field_conflict')).toEqual([expect.objectContaining({ title: 'api:payments.version: second overwrote estate', source: 'second' })])
  })

  it('holds an API specification, and refuses what is not one', async () => {
    const spec = { openapi: '3.1.0', info: { title: 'Payments', version: '2.0' }, paths: { '/charges': { get: {}, post: {} } } }
    expect((await edit('api', 'payments', { fields: { spec } })).status).toBe(200)
    expect((await get('api', 'payments')).fields.spec).toEqual(spec)
    expect((await edit('api', 'payments', { fields: { spec: { hello: 'world' } } })).status).toBe(400)
  })
})

describe('renaming a blueprint', () => {
  it('takes its entities, what people typed, and everything that names it', async () => {
    const system = { title: 'System', wall: true, status: { relations: ['<-k8s_namespace:system'] }, fields: { notes: { type: 'markdown' }, namespaces: { type: 'number', aggregation: { relation: '<-k8s_namespace:system', fn: 'count' } } }, relations: { hall: { target: 'hall' } } }
    const ns = hub.blueprints.get('k8s_namespace')!
    expect((await session('/v1/blueprints/hall', { method: 'PUT', ...body({ title: 'Hall' }) })).status).toBe(200)
    expect((await session('/v1/blueprints/system', { method: 'PUT', ...body({ title: 'System' }) })).status).toBe(200)
    expect((await session('/v1/blueprints/k8s_namespace', { method: 'PUT', ...body({ ...ns, relations: { ...ns.relations, system: { target: 'system' } } }) })).status).toBe(200)
    expect((await session('/v1/blueprints/system', { method: 'PUT', ...body(system) })).status).toBe(200)
    expect((await session('/v1/blueprints/hall', { method: 'PUT', ...body({ title: 'Hall', fields: { systems: { type: 'number', aggregation: { relation: '<-system:hall', fn: 'count' } } } }) })).status).toBe(200)
    await session('/v1/rules/k8s_namespace.system', { method: 'PUT', ...body({ blueprint: 'k8s_namespace', relation: 'system', match: { target: 'system', where: 'target.key == source.name' } }) })
    await session('/v1/scorecards/system_notes', { method: 'PUT', ...body({ blueprint: 'system', title: 'Notes', levels: [{ name: 'Noted', rules: [{ id: 'has_notes', title: 'Has notes', where: { field: 'notes', op: 'exists' } }] }] }) })
    await make('hall', 'main', { title: 'Main hall' })
    await make('system', 'ember', { title: 'Ember', fields: { notes: 'Typed by a person.' }, relations: { hall: 'main' } })
    await hub.rules.evaluateAll()
    expect((await get('system', 'ember')).fields.namespaces).toBe(1)

    // A blueprint named sw_workload exists already, so the hub refuses rather than merge two things.
    expect((await session('/v1/blueprints/system/rename', { method: 'POST', ...body({ to: 'sw_workload' }) })).status).toBe(400)
    expect((await session('/v1/blueprints/k8s_cluster/rename', { method: 'POST', ...body({ to: 'orrery_cluster' }) })).status).toBe(400)
    const renamed = await session('/v1/blueprints/system/rename', { method: 'POST', ...body({ to: 'product' }) })
    expect(renamed.status).toBe(200)

    expect(hub.blueprints.list().map((b) => b.id)).not.toContain('system')
    expect(hub.blueprints.get('system')?.id).toBe('product')
    expect(hub.blueprints.get('product')?.formerly).toEqual(['system'])
    const moved = await get('product', 'ember')
    expect(moved.fields).toMatchObject({ notes: 'Typed by a person.', namespaces: 1 })
    expect(keys(moved.relations.hall)).toEqual(['main'])
    expect(moved.changes.some((c) => c.kind === 'entity.created')).toBe(true)
    expect(keys((await get('k8s_namespace', 'home/ember')).relations.system)).toEqual(['ember'])
    expect(hub.blueprints.get('k8s_namespace')?.relations.system?.target).toBe('product')
    expect(hub.blueprints.get('hall')?.fields.systems?.aggregation?.relation).toBe('<-product:hall')
    expect((await get('hall', 'main')).fields.systems).toBe(1)
    expect(hub.rules.list().find((r) => r.id === 'k8s_namespace.system')?.match.target).toBe('product')
    expect((await json<ScorecardResults>(await session('/v1/scorecards/system_notes/results'))).rows).toEqual([expect.objectContaining({ levelName: 'Noted' })])
    expect((await json<FindingsResponse>(await session('/v1/findings'))).findings.filter((f) => f.kind === 'broken_path')).toEqual([])
  })
})

describe('a blueprint with derived fields', () => {
  const save = (fields: Record<string, unknown>, extra: Record<string, unknown> = {}) => session('/v1/blueprints/probe', { method: 'PUT', ...body({ title: 'Probe', fields, relations: { team: { target: 'team' } }, ...extra }) })
  const refused = async (res: Response, reason: RegExp) => {
    expect(res.status).toBe(400)
    expect((await json<{ error: string }>(res)).error).toMatch(reason)
  }

  it('reports its status through a field it calculates', async () => {
    const health = { type: 'enum', values: ['red', 'amber', 'green', 'grey'], calculation: "last == 'failed' ? 'red' : 'green'" }
    const why = { type: 'string', calculation: "last == 'failed' ? 'its last run failed' : null" }
    expect((await session('/v1/blueprints/gauge', { method: 'PUT', ...body({ title: 'Gauge', fields: { last: { type: 'string' }, health, health_reason: why }, relations: {}, status: { field: 'health' } }) })).status).toBe(200)
    await make('gauge', 'broken', { fields: { last: 'failed' } })
    await make('gauge', 'fine', { fields: { last: 'success' } })
    expect((await get('gauge', 'broken')).status).toEqual({ level: 'red', reasons: ['its last run failed'] })
    expect((await get('gauge', 'fine')).status.level).toBe('green')
    const listed = await json<{ entities: Entity[] }>(await session('/v1/entities?blueprint=gauge'))
    expect(listed.entities.find((e) => e.key === 'broken')?.status.level).toBe('red')
  })

  it('turns a status that reads the clock without anything moving', async () => {
    const health = { type: 'enum', values: ['red', 'amber', 'green', 'grey'], calculation: "hours_since(last_ok) > 2 ? 'red' : 'green'" }
    expect((await session('/v1/blueprints/ticker', { method: 'PUT', ...body({ title: 'Ticker', fields: { last_ok: { type: 'datetime' }, health }, relations: {}, status: { field: 'health' } }) })).status).toBe(200)
    const soon = new Date(Date.now() - 90 * 60_000).toISOString()
    await make('ticker', 'late', { fields: { last_ok: soon } })
    const level = async () => (await json<{ entities: Entity[] }>(await session('/v1/entities?blueprint=ticker'))).entities.find((e) => e.key === 'late')?.status.level
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      expect(await level()).toBe('green')
      // Two hours on, nothing has moved. A read shows the stored row as it is; the row named the hour it turns, and
      // when that arrives the leader derives it again.
      vi.setSystemTime(Date.now() + 2 * 3600 * 1000)
      expect(await level()).toBe('green')
      await hub.db.query(`UPDATE derived SET expires_at = now() - interval '1 second' WHERE blueprint = 'ticker'`)
      await hub.deriver.clock()
      await hub.deriver.drain()
      expect(await level()).toBe('red')
    } finally {
      vi.useRealTimers()
    }
  })

  it('is refused when a path leaves the model or a window makes no sense', async () => {
    await refused(await save({ x: { type: 'string', mirror: 'nope.title' } }), /"probe" has no relation "nope"/)
    await refused(await save({ x: { type: 'string', mirror: 'team.nope.title' } }), /"team" has no relation "nope"/)
    await refused(await save({ x: { type: 'number', aggregation: { relation: '<-sw_service:nope', fn: 'count' } } }), /"sw_service" has no relation "nope"/)
    await refused(await save({ x: { type: 'number', aggregation: { relation: '<-sw_service:team', fn: 'count' } } }), /points at team, not probe/)
    await refused(await save({ x: { type: 'number', aggregation: { relation: 'team', fn: 'count', per: 'week' } } }), /needs a window/)
    await refused(await save({ at: { type: 'string' } }, { lifecycle: { expire: { after: '30d', field: 'at' } } }), /not a datetime field/)
    await refused(await save({}, { relations: { team: { target: 'team', inherit: 'nope.team' } } }), /"probe" has no relation "nope"/)
    await refused(await save({}, { relations: { team: { target: 'team' }, lead: { target: 'person', inherit: 'team.department' } } }), /inherit ends at department, but the relation targets person/)
    expect((await save({ x: { type: 'string', mirror: 'team.department.organization.title' } }, { relations: { team: { target: 'team' }, lead: { target: 'person', inherit: 'team.lead' } } })).status).toBe(200)
  })

  it('is reported when a change elsewhere breaks a path it reads', async () => {
    const team = hub.blueprints.get('team')!
    const { lead: _lead, ...rest } = team.relations
    expect((await session('/v1/blueprints/team', { method: 'PUT', ...body({ ...team, relations: rest }) })).status).toBe(200)
    const { findings } = await json<FindingsResponse>(await session('/v1/findings'))
    expect(findings.filter((f) => f.kind === 'broken_path')).toEqual([expect.objectContaining({ title: 'Blueprint probe reads a path that does not exist', detail: expect.stringContaining('"team" has no relation "lead"') })])
  })

  it('still saves an edit of something else while a path it reads is broken', async () => {
    const put = (id: string, bp: unknown) => session(`/v1/blueprints/${id}`, { method: 'PUT', ...body(bp) })
    const team = hub.blueprints.get('team')!
    expect((await put('team', { ...team, relations: { ...team.relations, coach: { target: 'person' } } })).status).toBe(200)
    const probe = hub.blueprints.get('probe')!
    expect((await put('probe', { ...probe, fields: { ...probe.fields, coach: { type: 'string', mirror: 'team.coach.title' } } })).status).toBe(200)
    expect((await put('team', team)).status).toBe(200)

    const broken = hub.blueprints.get('probe')!
    expect((await put('probe', { ...broken, group: 'Elsewhere' })).status).toBe(200)
    expect(hub.blueprints.get('probe')?.group).toBe('Elsewhere')
    await refused(await put('probe', { ...broken, fields: { ...broken.fields, again: { type: 'string', mirror: 'team.coach.title' } } }), /"team" has no relation "coach"/)
    await refused(await put('probe', { ...broken, relations: {} }), /"probe" has no relation "team"/)
  })
})

describe('a pivoted object', () => {
  const blueprint = async () => json<{ fields: Record<string, { type: string; title?: string; calculation?: string; pivot?: boolean; pivoted?: { field: string; key: string } }>; relations: Record<string, unknown> }>(await session('/v1/blueprints/cloud_db'))
  const save = (bp: unknown) => session('/v1/blueprints/cloud_db', { method: 'PUT', ...body(bp) })

  it('gives each property a field of its own, read like any other', async () => {
    expect((await save({ title: 'Cloud database', fields: { sku: { type: 'string' }, tags: { type: 'object' } }, relations: {} })).status).toBe(200)
    await put('cloud_db', 'orders', { title: 'orders', fields: { sku: 'S1', tags: { pid: '987', Tier: 'Data', 'Project Name': 'Audit Tool', meta: { owner: 'ops' } } } })
    await put('cloud_db', 'carts', { title: 'carts', fields: { sku: 'S0', tags: { pid: '426', tier: 'web' } } })
    const before = await blueprint()
    expect(Object.keys(before.fields)).toEqual(['sku', 'tags'])
    const saved = await json<Awaited<ReturnType<typeof blueprint>>>(await save({ ...before, fields: { ...before.fields, tags: { type: 'object', pivot: true } } }))
    // Two properties that differ only by case each get a field; the name says where it came from.
    expect(Object.keys(saved.fields)).toEqual(['sku', 'tags', 'tags_project_name', 'tags_tier', 'tags_meta', 'tags_pid', 'tags_tier_2'])
    expect(saved.fields.tags_pid).toEqual({ type: 'string', title: 'pid', description: 'The "pid" property of tags.', calculation: 'tags["pid"]', pivoted: { field: 'tags', key: 'pid' } })
    expect(saved.fields.tags_meta!.type).toBe('object')
    expect((await get('cloud_db', 'orders')).fields).toMatchObject({ tags_pid: '987', tags_tier: 'Data', tags_tier_2: null, tags_project_name: 'Audit Tool', tags_meta: { owner: 'ops' } })
    expect(await search('cloud_db', { field: 'tags_pid', op: 'eq', value: '426' })).toEqual(['carts'])
    // A person changes the tag where a source wrote it, not the column made from it.
    expect((await edit('cloud_db', 'orders', { fields: { tags_pid: '1' } })).status).toBe(403)
  })

  it('makes a field for a property a source brings later, and keeps what an architect called it', async () => {
    const bp = await blueprint()
    expect((await save({ ...bp, fields: { ...bp.fields, tags_pid: { ...bp.fields.tags_pid, title: 'Project id' } } })).status).toBe(200)
    await put('cloud_db', 'carts', { title: 'carts', fields: { sku: 'S0', tags: { pid: '426', tier: 'web', CostCenter: 3301 } } })
    await hub.tick()
    const after = await blueprint()
    expect(after.fields.tags_costcenter).toMatchObject({ type: 'number', title: 'CostCenter' })
    expect(after.fields.tags_pid!.title).toBe('Project id')
    expect((await get('cloud_db', 'carts')).fields.tags_costcenter).toBe(3301)
  })

  it('is what a relation rule matches a permanent id on', async () => {
    expect((await session('/v1/blueprints/program', { method: 'PUT', ...body({ title: 'Program', fields: { pid: { type: 'string' } }, relations: {} }) })).status).toBe(200)
    await make('program', 'audit', { title: 'Audit Tool', fields: { pid: '987' } })
    const bp = await blueprint()
    expect((await save({ ...bp, relations: { program: { target: 'program', many: false } } })).status).toBe(200)
    expect((await session('/v1/rules/cloud_db.program', { method: 'PUT', ...body({ blueprint: 'cloud_db', relation: 'program', match: { target: 'program', where: 'target.pid == source.tags_pid' } }) })).status).toBe(200)
    // An optional rule links what it can and raises nothing for the rest.
    const unmatched = async () => (await json<{ findings: { kind: string; detail: string }[] }>(await session('/v1/findings'))).findings.filter((f) => f.kind === 'unmatched_rule' && f.detail.includes('cloud_db.program'))
    expect((await unmatched()).length).toBeGreaterThan(0)
    expect((await session('/v1/rules/cloud_db.program', { method: 'PUT', ...body({ blueprint: 'cloud_db', relation: 'program', optional: true, match: { target: 'program', where: 'target.pid == source.tags_pid' } }) })).status).toBe(200)
    expect(await unmatched()).toEqual([])
    expect(keys((await get('cloud_db', 'orders')).relations.program)).toEqual(['audit'])
    expect((await get('cloud_db', 'carts')).relations.program ?? []).toEqual([])
  })

  it('pivots a property that is itself an object, and takes every made field away when the pivot is turned off', async () => {
    const bp = await blueprint()
    const nested = await json<Awaited<ReturnType<typeof blueprint>>>(await save({ ...bp, fields: { ...bp.fields, tags_meta: { ...bp.fields.tags_meta, pivot: true } } }))
    expect(nested.fields.tags_meta_owner).toMatchObject({ calculation: 'tags_meta["owner"]', pivoted: { field: 'tags_meta', key: 'owner' } })
    expect((await get('cloud_db', 'orders')).fields.tags_meta_owner).toBe('ops')
    const off = await json<Awaited<ReturnType<typeof blueprint>>>(await save({ ...nested, fields: { ...nested.fields, tags: { type: 'object' } } }))
    expect(Object.keys(off.fields)).toEqual(['sku', 'tags'])
    expect((await get('cloud_db', 'orders')).fields.tags).toMatchObject({ pid: '987' })
  })

  it('derives again a row worked out in the same moment its blueprint changed', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() })
    try {
      await hub.deriver.derive([{ blueprint: 'cloud_db', key: 'orders' }], { consume: false })
      const bp = await blueprint()
      expect((await save({ ...bp, fields: { ...bp.fields, sku_code: { type: 'string', calculation: 'sku' } } })).status).toBe(200)
      expect((await get('cloud_db', 'orders')).fields.sku_code).toBe('S1')
    } finally {
      vi.useRealTimers()
    }
  })

  it('is refused on a field that is not an object', async () => {
    const bp = await blueprint()
    const res = await save({ ...bp, fields: { ...bp.fields, sku: { type: 'string', pivot: true } } })
    expect(res.status).toBe(400)
    expect((await json(res)).error).toMatch(/only an object can be pivoted/)
  })
})

describe('a value a person knows better', () => {
  const save = (fields: Record<string, unknown>) => session('/v1/blueprints/codebase', { method: 'PUT', ...body({ title: 'Codebase', fields, relations: {} }) })

  it('gives way when the source pushes a different one, unless the field is sticky', async () => {
    const language = { type: 'enum', values: ['C#', 'Python', 'Go'] }
    expect((await save({ language, guess: language, dashboards: { type: 'url', many: true } })).status).toBe(200)
    await put('codebase', 'mixed', { title: 'mixed', fields: { language: 'C#', guess: 'C#' } })
    expect((await edit('codebase', 'mixed', { fields: { language: 'Python', guess: 'Python' } })).status).toBe(200)
    expect((await save({ language: { ...language, sticky: true }, guess: language, dashboards: { type: 'url', many: true } })).status).toBe(200)
    await put('codebase', 'mixed', { title: 'mixed', fields: { language: 'Go', guess: 'Go' } })
    const after = await get('codebase', 'mixed')
    expect(after.fields).toMatchObject({ language: 'Python', guess: 'Go' })
    // Cleared by the person, the pushed value is back.
    expect((await edit('codebase', 'mixed', { fields: { language: null } })).status).toBe(200)
    expect((await get('codebase', 'mixed')).fields.language).toBe('Go')
  })

  it('holds a list of links in one field, from a source or a person', async () => {
    await put('codebase', 'mixed', { title: 'mixed', fields: { language: 'Go', guess: 'Go', dashboards: ['https://grafana.example.org/d/1', 'https://example.org/board'] } })
    expect((await get('codebase', 'mixed')).fields.dashboards).toEqual(['https://grafana.example.org/d/1', 'https://example.org/board'])
    expect((await edit('codebase', 'mixed', { fields: { dashboards: ['https://example.org/one'] } })).status).toBe(200)
    const bad = await edit('codebase', 'mixed', { fields: { dashboards: ['https://example.org/one', 'not a link'] } })
    expect(bad.status).toBe(400)
    expect((await json(bad)).error).toMatch(/"not a link" is not a URL/)
    const refused = await save({ language: { type: 'string', many: true } })
    expect(refused.status).toBe(400)
    expect((await json(refused)).error).toMatch(/only a url or an enum holds a list/)
  })

  it('holds several of an enum field\'s values at once and counts each', async () => {
    const skills = { type: 'enum', values: ['C#', 'Python', 'Kubernetes'], many: true }
    const language = { type: 'enum', values: ['C#', 'Python', 'Go'] }
    expect((await save({ language: { ...language, sticky: true }, guess: language, dashboards: { type: 'url', many: true }, skills })).status).toBe(200)
    await put('codebase', 'mixed', { title: 'mixed', fields: { skills: ['C#', 'Kubernetes'] } })
    await put('codebase', 'other', { title: 'other', fields: { skills: ['Python', 'C#'] } })
    expect((await get('codebase', 'mixed')).fields.skills).toEqual(['C#', 'Kubernetes'])
    expect((await edit('codebase', 'mixed', { fields: { skills: ['Python'] } })).status).toBe(200)
    const bad = await edit('codebase', 'mixed', { fields: { skills: ['Python', 'Cobol'] } })
    expect(bad.status).toBe(400)
    expect((await json(bad)).error).toMatch(/"Cobol" is not one of/)
    // The grid filter and the distribution see a list value as each of its members.
    const found = await json<EntitiesResponse>(await session(`/v1/entities?blueprint=codebase&filter=${encodeURIComponent(JSON.stringify({ field: 'skills', op: 'contains', value: 'C#' }))}&distribution=true`))
    expect(found.entities.map((e) => e.key)).toEqual(['other'])
    expect(found.distribution?.['f:skills']?.buckets).toEqual([{ value: 'C#', label: 'C#', count: 1 }, { value: 'Python', label: 'Python', count: 1 }])
  })
})

describe('a relation taken off its blueprint', () => {
  const crate = (withBin: boolean) => ({ title: 'Crate', fields: {}, relations: withBin ? { bin: { target: 'bin' } } : {} })
  const findingsFor = async (key: string) => (await json<FindingsResponse>(await session('/v1/findings'))).findings.filter((f) => f.entity?.blueprint === 'crate' && f.entity.key === key).map((f) => f.kind)

  it('is read nowhere, and comes back with its links when it is put back', async () => {
    expect((await session('/v1/blueprints/bin', { method: 'PUT', ...body({ title: 'Bin', fields: {}, relations: {} }) })).status).toBe(200)
    expect((await session('/v1/blueprints/crate', { method: 'PUT', ...body(crate(true)) })).status).toBe(200)
    await make('bin', 'full')
    await make('bin', 'scrapped')
    await make('crate', 'kept', { relations: { bin: 'full' } })
    await make('crate', 'stale', { relations: { bin: 'scrapped' } })
    expect((await session('/v1/entities/bin/scrapped', { method: 'DELETE' })).status).toBe(200)
    expect(await findingsFor('stale')).toContain('dangling_relation')

    expect((await session('/v1/blueprints/crate', { method: 'PUT', ...body(crate(false)) })).status).toBe(200)
    const kept = await get('crate', 'kept')
    expect(kept.relations.bin).toBeUndefined()
    expect(kept.outgoing).toEqual([])
    expect((await get('bin', 'full')).incoming.filter((i) => i.declaredOn === 'crate')).toEqual([])
    expect(await search('crate', { relatedTo: 'bin:full' })).toEqual([])
    expect(await findingsFor('stale')).not.toContain('dangling_relation')
    expect(await findingsFor('kept')).toContain('no_relations')

    expect((await session('/v1/blueprints/crate', { method: 'PUT', ...body(crate(true)) })).status).toBe(200)
    expect(keys((await get('crate', 'kept')).relations.bin)).toEqual(['full'])
    expect(await findingsFor('kept')).not.toContain('no_relations')
  })
})

describe('a blueprint whose entities stand alone', () => {
  const lonely = async () => (await json<FindingsResponse>(await session('/v1/findings'))).findings.filter((f) => f.kind === 'no_relations' && f.entity?.blueprint === 'leaflet').map((f) => f.entity?.key)

  it('raises no finding for an entity connected to nothing, until it stops standing alone', async () => {
    expect((await session('/v1/blueprints/leaflet', { method: 'PUT', ...body({ title: 'Leaflet', fields: {}, relations: {} }) })).status).toBe(200)
    await make('leaflet', 'flyer')
    expect(await lonely()).toEqual(['flyer'])
    expect((await session('/v1/blueprints/leaflet', { method: 'PUT', ...body({ title: 'Leaflet', standalone: true, fields: {}, relations: {} }) })).status).toBe(200)
    expect(await lonely()).toEqual([])
    expect((await json<{ standalone?: boolean }>(await session('/v1/blueprints/leaflet'))).standalone).toBe(true)
    expect((await session('/v1/blueprints/leaflet', { method: 'PUT', ...body({ title: 'Leaflet', fields: {}, relations: {} }) })).status).toBe(200)
    expect(await lonely()).toEqual(['flyer'])
  })
})

describe('an event that points at something since removed', () => {
  const dangling = async (key: string) => (await json<FindingsResponse>(await session('/v1/findings'))).findings.filter((f) => f.kind === 'dangling_relation' && f.entity?.blueprint === 'launch' && f.entity.key === key).length

  it('is history, not a broken link, when its blueprint expires by age', async () => {
    expect((await session('/v1/blueprints/rocket', { method: 'PUT', ...body({ title: 'Rocket', fields: {}, relations: {} }) })).status).toBe(200)
    const launch = (expire: boolean) => ({ title: 'Launch', fields: { at: { type: 'datetime' } }, relations: { rocket: { target: 'rocket' } }, ...(expire ? { lifecycle: { expire: { after: '180d', field: 'at' } } } : {}) })
    expect((await session('/v1/blueprints/launch', { method: 'PUT', ...body(launch(false)) })).status).toBe(200)
    await make('rocket', 'retired')
    await make('launch', 'first', { fields: { at: daysAgo(1) }, relations: { rocket: 'retired' } })
    expect((await session('/v1/entities/rocket/retired', { method: 'DELETE' })).status).toBe(200)
    expect(await dangling('first')).toBe(1)
    expect((await session('/v1/blueprints/launch', { method: 'PUT', ...body(launch(true)) })).status).toBe(200)
    expect(await dangling('first')).toBe(0)
  })
})

describe('an inherited relation that reads no value', () => {
  it('is filled again when a link moves, and left alone when only a value does', async () => {
    const save = (id: string, def: unknown) => session(`/v1/blueprints/${id}`, { method: 'PUT', ...body(def) })
    expect((await save('depot', { title: 'Depot', fields: {}, relations: {} })).status).toBe(200)
    expect((await save('shelf', { title: 'Shelf', fields: {}, relations: { depot: { target: 'depot' } } })).status).toBe(200)
    expect((await save('crate', { title: 'Crate', fields: { colour: { type: 'string' } }, relations: { shelf: { target: 'shelf' }, depot: { target: 'depot', inherit: 'shelf.depot' } } })).status).toBe(200)
    await make('depot', 'north')
    await make('depot', 'south')
    await put('shelf', 'a', { title: 'A', relations: { depot: 'north' } })
    await put('crate', 'one', { title: 'One', fields: { colour: 'red' }, relations: { shelf: 'a' } })
    await hub.rules.evaluateAll()
    expect(keys((await get('crate', 'one')).relations.depot)).toEqual(['north'])

    const pass = async () => {
      await hub.rules.evaluateMoved()
      await hub.rules.settled()
    }
    // The links the first pass made are themselves a move, which the pass after it takes.
    await pass()
    const query = vi.spyOn(hub.db, 'query')
    // Each time an inherited relation is filled it reads the links it holds, under its own name.
    const filled = () => query.mock.calls.filter(([sql]) => typeof sql === 'string' && sql.includes('FROM relations WHERE layer = $1 AND source = $2')).map(([, params]) => String((params as unknown[])[1]))
    await put('crate', 'one', { title: 'One', fields: { colour: 'blue' }, relations: { shelf: 'a' } })
    await pass()
    expect((await get('crate', 'one')).fields.colour).toBe('blue')
    expect(filled()).not.toContain('inherit:crate.depot')
    await put('shelf', 'a', { title: 'A', relations: { depot: 'south' } })
    await pass()
    expect(filled()).toContain('inherit:crate.depot')
    expect(keys((await get('crate', 'one')).relations.depot)).toEqual(['south'])
    query.mockRestore()
  })

  it('is worked out again only for the entities a move reaches', async () => {
    await put('shelf', 'b', { title: 'B', relations: { depot: 'north' } })
    await put('crate', 'two', { title: 'Two', relations: { shelf: 'a' } })
    await put('crate', 'three', { title: 'Three', relations: { shelf: 'b' } })
    const pass = async () => {
      await hub.rules.evaluateMoved()
      await hub.rules.settled()
      await hub.rules.evaluateMoved()
      await hub.rules.settled()
    }
    await pass()
    const depots = async () => Object.fromEntries(await Promise.all(['one', 'two', 'three', 'four'].map(async (key) => [key, keys((await get('crate', key)).relations?.depot)])))
    expect(await depots()).toMatchObject({ one: ['south'], two: ['south'], three: ['north'] })

    const passes = hub.rules as unknown as { inherit: (...args: unknown[]) => Promise<boolean> }
    const spy = vi.spyOn(passes, 'inherit')
    /** The crates each fill of the relation was asked for since the last look: null is every crate. */
    const asked = () => {
      const all = spy.mock.calls.filter(([blueprint, relation]) => blueprint === 'crate' && relation === 'depot').map(([, , , only]) => only as string[] | null)
      spy.mockClear()
      return all
    }
    // A link on the path moves: only the crates that read through it are worked out.
    await put('shelf', 'a', { title: 'A', relations: { depot: 'north' } })
    await pass()
    const moved = asked()
    expect(moved.length).toBeGreaterThan(0)
    for (const only of moved) expect(only).not.toBeNull()
    expect(moved.flat()).toEqual(expect.arrayContaining(['one', 'two']))
    expect(moved.flat()).not.toContain('three')
    expect(await depots()).toMatchObject({ one: ['north'], two: ['north'], three: ['north'] })

    // A crate that comes is worked out alone.
    await put('crate', 'four', { title: 'Four', relations: { shelf: 'b' } })
    await pass()
    expect(new Set(asked().flat())).toEqual(new Set(['four']))
    expect((await depots()).four).toEqual(['north'])

    // A hand's link wins over the inherited one, and its going gives the inherited one back.
    expect((await edit('crate', 'three', { relations: { depot: 'south' } })).status).toBe(200)
    await pass()
    expect(new Set(asked().flat())).toEqual(new Set(['three']))
    expect((await depots()).three).toEqual(['south'])
    expect((await edit('crate', 'three', { relations: { depot: null } })).status).toBe(200)
    await pass()
    expect((await depots()).three).toEqual(['north'])

    // What the path ends at goes: whoever read through it loses the link.
    await hub.entities.tombstone([{ blueprint: 'shelf', key: 'b' }], 'estate', null, { reason: 'test' }, false)
    await pass()
    expect(asked().flat()).not.toContain('one')
    expect(await depots()).toMatchObject({ one: ['north'], three: [], four: [] })

    // Nothing moved: nothing is asked for. And a pass over everything agrees with what the moves left.
    await pass()
    expect(asked()).toEqual([])
    const before = await depots()
    await hub.rules.evaluateAll()
    expect(await depots()).toEqual(before)
    spy.mockRestore()
  })
})
