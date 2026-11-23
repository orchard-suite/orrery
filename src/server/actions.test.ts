import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { checkAction } from '../shared/action-spec.ts'
import type { ActionRun, ActionView, Change } from '../shared/model.ts'
import type { PostureResponse } from '../shared/posture.ts'
import type { ActionBatchResponse, ActionBatchSummary, ActionBatchesResponse, ActionRunsResponse, ActionsLayout, ActionsResponse, BatchPreview, ChangesResponse, RunnerJob } from '../shared/api.ts'
import { reasonOf } from './approvals.ts'
import { applyCatalog } from './catalog.ts'
import { loadConfig } from './config.ts'
import { loadFixtureCatalog } from './fixtures/load.ts'
import { createHub, type Hub } from './hub.ts'
import { createLogger } from './log.ts'
import { NoticeForwarder, type NoticeEvent } from './notices.ts'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://orrery:orrery@localhost:5433/orrery'

let hub: Hub
let pusher = ''
let runner = ''
let reporter = ''
let approver = ''
let viewer = ''
let portal = ''
let hook: Server
let hookUrl = ''
let received: { headers: Record<string, string | string[] | undefined>; body: unknown }[] = []
let answer = 202
// A stand-in for the GitHub API: it starts run 42 on a dispatch and answers for it as `ghRun` says.
let github: Server
let githubUrl = ''
let dispatches: unknown[] = []
let ghDispatch = 200
let ghRun: { status: string; conclusion: string | null } = { status: 'queued', conclusion: null }

/** A signed-in person: the admin unless said otherwise. */
const as = (email: string, groups = 'User') => (path: string, init?: RequestInit): Promise<Response> => Promise.resolve(hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', 'x-forwarded-email': email, 'x-forwarded-groups': groups, ...init?.headers } }, { surface: 'session' }))
const session = as('local@example.org', 'Admin')
const ada = as('ada@example.org')
const bob = as('bob@example.org')
const cy = as('cy@example.org')
const machineAs = (bearer: string) => (path: string, init?: RequestInit): Promise<Response> => Promise.resolve(machine(path, init, bearer))
const machine = (path: string, init?: RequestInit, bearer = pusher) => hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}`, ...init?.headers } }, { surface: 'machine' })
const json = async <T = Record<string, unknown>>(r: Response): Promise<T> => (await r.json()) as T
const body = (v: unknown) => ({ body: JSON.stringify(v) })

const upgrade = (backend: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  title: 'Upgrade an ArgoCD application',
  description: 'Set an image to a new tag.',
  blueprint: 'argocd_app',
  inputs: {
    workload: { type: 'entity', blueprint: 'k8s_workload', required: true, where: { relation: 'namespace', target: '{{ entity.relations.namespace }}' } },
    image: { type: 'enum', required: true, values: '{{ inputs.workload.fields.images }}' },
    tag: { type: 'string', required: true },
    notify: { type: 'boolean', default: true },
  },
  backend,
  ...extra,
})

beforeAll(async () => {
  github = createServer((req, res) => {
    let text = ''
    req.on('data', (chunk: Buffer) => (text += chunk.toString()))
    req.on('end', () => {
      const send = (status: number, value?: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(value === undefined ? '' : JSON.stringify(value))
      const run = `${githubUrl}/repos/o/r/actions/runs/42`
      if (req.method === 'POST' && req.url === '/repos/o/r/actions/workflows/w.yml/dispatches') {
        dispatches.push(JSON.parse(text))
        return ghDispatch === 200 ? send(200, { workflow_run_id: 42, run_url: run, html_url: 'https://github.com/o/r/actions/runs/42' }) : send(ghDispatch)
      }
      if (req.url === '/repos/o/r/actions/runs/42') return send(200, { id: 42, ...ghRun })
      if (req.url === '/repos/o/r/actions/runs/42/jobs') return send(200, { jobs: [{ name: 'upgrade', conclusion: 'failure', check_run_url: `${githubUrl}/repos/o/r/check-runs/7` }] })
      if (req.url === '/repos/o/r/check-runs/7/annotations') return send(200, [{ annotation_level: 'failure', message: 'The job was not started because recent account payments have failed' }, { annotation_level: 'notice', message: 'a runner label moves' }])
      send(404)
    })
  })
  await new Promise<void>((r) => github.listen(0, '127.0.0.1', r))
  githubUrl = `http://127.0.0.1:${(github.address() as { port: number }).port}`
  const config = loadConfig({ DATABASE_URL, DATA_DIR: mkdtempSync(join(tmpdir(), 'orrery-')), AUTH_MODE: 'proxy', PUBLIC_URL: 'https://hub.example.org', GITHUB_API_URL: githubUrl })
  hub = await createHub(config, 'test', { reset: true })
  expect((await loadFixtureCatalog(hub)).errors).toEqual([])
  await hub.sources.save('k8s@home', { title: 'k8s', class: 'pusher', blueprints: ['*'], deleteGrant: [], cadence: '3m' })
  await hub.sources.save('lan-runner', { title: 'LAN runner', class: 'runner', blueprints: [], deleteGrant: [], cadence: '5m' })
  pusher = (await hub.sources.issueToken('source', 'k8s', { source: 'k8s@home' })).token
  runner = (await hub.sources.issueToken('source', 'runner', { source: 'lan-runner' })).token
  const admin = { admin: true, permissions: [] as never[], kind: 'user' as const, name: 'local', roles: [] }
  await hub.access.saveRole('operator', { title: 'Operator', permissions: ['actions.report'] }, admin)
  await hub.access.saveRole('lead', { title: 'Lead', permissions: ['actions.approve'] }, admin)
  await hub.access.saveRole('author', { title: 'Author', permissions: ['actions.manage'] }, admin)
  await hub.access.addUser('cy@example.org', ['author'], admin)
  reporter = (await hub.sources.issueToken('access', 'workflow', { role: 'operator' })).token
  approver = (await hub.sources.issueToken('access', 'lead', { role: 'lead' })).token
  viewer = (await hub.sources.issueToken('access', 'viewer', { role: 'viewer' })).token
  await hub.access.saveRole('portal', { title: 'Portal', permissions: ['actions.list'] }, admin)
  portal = (await hub.sources.issueToken('access', 'portal', { role: 'portal' })).token
  // The estate: a cluster, two namespaces, a workload in each, and an app deploying into one.
  await machine('/v1/ingest/entities/k8s_cluster/home', { method: 'PUT', ...body({ title: 'home' }) })
  await machine('/v1/ingest/entities/k8s_namespace/home%2Forrery', { method: 'PUT', ...body({ title: 'orrery', fields: { name: 'orrery' }, relations: { cluster: 'home' } }) })
  await machine('/v1/ingest/entities/k8s_namespace/home%2Fshop', { method: 'PUT', ...body({ title: 'shop', fields: { name: 'shop' }, relations: { cluster: 'home' } }) })
  await machine('/v1/ingest/entities/k8s_workload/home%2Forrery%2Forrery', { method: 'PUT', ...body({ title: 'orrery', fields: { name: 'orrery', kind: 'Deployment', images: ['registry.example.org/orrery:0.9.12', 'registry.example.org/orrery-runner:0.9.12'] }, relations: { namespace: 'home/orrery' } }) })
  await machine('/v1/ingest/entities/k8s_workload/home%2Fshop%2Fstorefront', { method: 'PUT', ...body({ title: 'storefront', fields: { name: 'storefront', kind: 'Deployment', images: ['storefront:1'] }, relations: { namespace: 'home/shop' } }) })
  await machine('/v1/ingest/entities/argocd_app/home%2Fargocd%2Forrery', { method: 'PUT', ...body({ title: 'orrery', fields: { path: 'kubernetes/workloads/orrery/envs/prod', sync_status: 'Synced', health_status: 'Healthy', health: 'green' }, relations: { cluster: 'home', namespace: 'home/orrery' } }) })
  // People, crews, and projects, so an action can name who may run it through the graph.
  const save = (id: string, spec: Record<string, unknown>) => session(`/v1/blueprints/${id}`, { method: 'PUT', ...body(spec) })
  await save('crew', { title: 'Crew', fields: {}, relations: {} })
  await save('project', { title: 'Project', fields: {}, relations: { crew: { target: 'crew' } } })
  await save('crew_member', { title: 'Crew member', fields: { email: { type: 'email' } }, relations: { crews: { target: 'crew', many: true } } })
  expect((await session('/v1/access/person', { method: 'PUT', ...body({ blueprint: 'crew_member', field: 'email' }) })).status).toBe(200)
  await machine('/v1/ingest/entities/crew/platform', { method: 'PUT', ...body({ title: 'Platform' }) })
  await machine('/v1/ingest/entities/crew/web', { method: 'PUT', ...body({ title: 'Web' }) })
  await machine('/v1/ingest/entities/project/orrery', { method: 'PUT', ...body({ title: 'Orrery', relations: { crew: 'platform' } }) })
  await machine('/v1/ingest/entities/crew_member/ada', { method: 'PUT', ...body({ title: 'Ada', fields: { email: 'ada@example.org' }, relations: { crews: ['platform'] } }) })
  await machine('/v1/ingest/entities/crew_member/bob', { method: 'PUT', ...body({ title: 'Bob', fields: { email: 'bob@example.org' }, relations: { crews: ['web'] } }) })
  hook = createServer((req, res) => {
    let text = ''
    req.on('data', (chunk: Buffer) => (text += chunk.toString()))
    req.on('end', () => {
      // Only a webhook's post is recorded. Anything else that finds the port, such as a local tool probing it, is turned away.
      if (req.method !== 'POST') return void res.writeHead(404).end()
      received.push({ headers: req.headers, body: JSON.parse(text) })
      res.writeHead(answer).end(answer >= 400 ? 'nope' : '')
    })
  })
  await new Promise<void>((r) => hook.listen(0, '127.0.0.1', r))
  hookUrl = `http://127.0.0.1:${(hook.address() as { port: number }).port}`
  await session('/v1/secrets/hook_token', { method: 'PUT', ...body({ value: 's3cret' }) })
})

afterAll(async () => {
  hook.close()
  github.close()
  await hub.close()
})

describe('defining actions', () => {
  it('validates the definition and records the change once', async () => {
    const bad = await session('/v1/actions/nope', { method: 'PUT', ...body({ title: 'x', blueprint: 'no_such', inputs: {}, backend: { type: 'webhook', url: 'http://x' } }) })
    expect(bad.status).toBe(400)
    const noValues = await session('/v1/actions/nope', { method: 'PUT', ...body({ title: 'x', inputs: { pick: { type: 'enum' } }, backend: { type: 'webhook', url: 'http://x' } }) })
    expect(noValues.status).toBe(400)
    expect((await json(noValues)).error).toContain('needs values')
    const noRunner = await session('/v1/actions/nope', { method: 'PUT', ...body({ title: 'x', inputs: {}, backend: { type: 'runner', runner: 'k8s@home', command: ['true'] } }) })
    expect((await json(noRunner)).error).toContain('not a runner source')
    const ok = await session('/v1/actions/upgrade_app', { method: 'PUT', ...body(upgrade({ type: 'webhook', url: `${hookUrl}/deploy`, secretRef: 'hook_token' })) })
    expect(ok.status).toBe(200)
    expect((await json<{ origin: { kind: string } }>(ok)).origin.kind).toBe('ui')
    await session('/v1/actions/upgrade_app', { method: 'PUT', ...body(upgrade({ type: 'webhook', url: `${hookUrl}/deploy`, secretRef: 'hook_token' })) })
    const changes = (await json<{ changes: Change[] }>(await session('/v1/changes?kind=action.changed'))).changes.filter((c) => c.detail.action === 'upgrade_app')
    expect(changes).toHaveLength(1)
    expect(changes[0]!.category).toBe('actions')
    expect((await machine('/v1/actions/x', { method: 'PUT', ...body(upgrade({ type: 'webhook', url: 'http://x' })) }, viewer)).status).toBe(403)
    // Who may run an action is an admin's to say, like who sees a blueprint.
    expect((await cy('/v1/actions/mine', { method: 'PUT', ...body({ title: 'x', inputs: {}, backend: { type: 'webhook', url: 'http://x' }, access: { everyone: true } }) })).status).toBe(403)
    expect((await cy('/v1/actions/mine', { method: 'PUT', ...body({ title: 'x', inputs: {}, backend: { type: 'webhook', url: 'http://x' } }) })).status).toBe(200)
    const badPath = await session('/v1/actions/nope', { method: 'PUT', ...body({ title: 'x', inputs: {}, backend: { type: 'webhook', url: 'http://x' }, access: { grants: [{ path: 'not a path', values: ['x'] }] } }) })
    expect(badPath.status).toBe(400)
  })
})

describe('running an action', () => {
  let run: ActionRun
  it('renders the form options the same way and hands the backend the payload', async () => {
    received = []
    const refused = await session('/v1/actions/upgrade_app/run', { method: 'POST', ...body({ entity: { blueprint: 'argocd_app', key: 'home/argocd/orrery' }, inputs: { workload: 'k8s_workload:home/shop/storefront', image: 'storefront:1', tag: '2' } }) })
    expect(refused.status).toBe(400)
    expect((await json(refused)).error).toContain('workload')
    const wrongImage = await session('/v1/actions/upgrade_app/run', { method: 'POST', ...body({ entity: { blueprint: 'argocd_app', key: 'home/argocd/orrery' }, inputs: { workload: 'k8s_workload:home/orrery/orrery', image: 'storefront:1', tag: '2' } }) })
    expect((await json(wrongImage)).error).toContain('expected one of registry.example.org/orrery:0.9.12')
    const missing = await session('/v1/actions/upgrade_app/run', { method: 'POST', ...body({ entity: { blueprint: 'argocd_app', key: 'home/argocd/orrery' }, inputs: { workload: 'k8s_workload:home/orrery/orrery', image: 'registry.example.org/orrery:0.9.12' } }) })
    expect((await json(missing)).error).toContain('"tag" is required')
    const res = await session('/v1/actions/upgrade_app/run', { method: 'POST', ...body({ entity: { blueprint: 'argocd_app', key: 'home/argocd/orrery' }, inputs: { workload: 'k8s_workload:home/orrery/orrery', image: 'registry.example.org/orrery:0.9.12', tag: '0.9.13' } }) })
    expect(res.status).toBe(201)
    run = await json<ActionRun>(res)
    expect(run.state).toBe('running')
    expect(run.inputs).toEqual({ workload: 'k8s_workload:home/orrery/orrery', image: 'registry.example.org/orrery:0.9.12', tag: '0.9.13', notify: true })
    expect(run.log.map((l) => l.message)).toEqual(['requested by local@example.org', 'webhook accepted (202)'])
    expect(received).toHaveLength(1)
    expect(received[0]!.headers.authorization).toBe('Bearer s3cret')
    const payload = received[0]!.body as { run: { id: string; url: string; at: string }; action: { id: string }; entity: { id: string; fields: { path: string }; relations: { namespace: string } }; inputs: { workload: { id: string; fields: { images: string[] } }; tag: string }; by: { name: string } }
    expect(payload.run).toEqual({ id: run.id, url: `https://hub.example.org/actions/runs/${run.id}`, at: run.createdAt })
    expect(payload.action.id).toBe('upgrade_app')
    expect(payload.entity.id).toBe('argocd_app:home/argocd/orrery')
    expect(payload.entity.fields.path).toBe('kubernetes/workloads/orrery/envs/prod')
    expect(payload.entity.relations.namespace).toBe('k8s_namespace:home/orrery')
    expect(payload.inputs.workload.id).toBe('k8s_workload:home/orrery/orrery')
    expect(payload.inputs.tag).toBe('0.9.13')
    expect(payload.by.name).toBe('local@example.org')
    const requested = (await json<{ changes: Change[] }>(await session('/v1/changes?kind=action.requested'))).changes
    expect(requested[0]).toMatchObject({ blueprint: 'argocd_app', key: 'home/argocd/orrery', actor: 'local@example.org', detail: { action: 'upgrade_app', run: run.id } })
  })
  it('takes the backend report and closes the run', async () => {
    expect((await machine(`/v1/action-runs/${run.id}/report`, { method: 'POST', ...body({ log: ['nope'] }) }, viewer)).status).toBe(403)
    const progress = await machine(`/v1/action-runs/${run.id}/report`, { method: 'POST', ...body({ label: 'committing', link: 'https://github.com/example/mono/actions/runs/1', log: ['checked out', 'tag set'] }) }, reporter)
    expect(progress.status).toBe(200)
    const done = await json<ActionRun>(await machine(`/v1/action-runs/${run.id}/report`, { method: 'POST', ...body({ state: 'succeeded', summary: 'orrery is at 0.9.13', log: ['pushed'] }) }, reporter))
    expect(done.state).toBe('succeeded')
    expect(done.label).toBe('committing')
    expect(done.link).toBe('https://github.com/example/mono/actions/runs/1')
    expect(done.finishedAt).not.toBeNull()
    expect(done.log.map((l) => l.message)).toEqual(['requested by local@example.org', 'webhook accepted (202)', 'checked out', 'tag set', 'pushed', 'succeeded: orrery is at 0.9.13'])
    expect((await machine(`/v1/action-runs/${run.id}/report`, { method: 'POST', ...body({ log: ['late'] }) }, reporter)).status).toBe(409)
    const finished = (await json<{ changes: Change[] }>(await session('/v1/changes?kind=action.finished&outcome=ok'))).changes
    expect(finished[0]).toMatchObject({ actorKind: 'token', actor: 'workflow', detail: { run: run.id, state: 'succeeded' } })
    const list = await json<{ runs: ActionRun[] }>(await session('/v1/action-runs?action=upgrade_app&entity=argocd_app:home/argocd/orrery'))
    expect(list.runs.map((r) => r.id)).toEqual([run.id])
  })
  it('logs each new state and summary a backend reports, once', async () => {
    const r = await json<ActionRun>(await session('/v1/actions/upgrade_app/run', { method: 'POST', ...body({ entity: { blueprint: 'argocd_app', key: 'home/argocd/orrery' }, inputs: { workload: 'k8s_workload:home/orrery/orrery', image: 'registry.example.org/orrery:0.9.12', tag: '0.9.14' } }) }))
    const report = (b: Record<string, unknown>) => machine(`/v1/action-runs/${r.id}/report`, { method: 'POST', ...body(b) }, reporter)
    await report({ state: 'running', summary: 'deploying forms 0.1.8' })
    await report({ state: 'running', summary: 'deploying forms 0.1.8' })
    await report({ summary: 'uploading the package' })
    const done = await json<ActionRun>(await report({ state: 'failed', summary: 'the deploy of forms 0.1.8 failed' }))
    expect(done.log.map((l) => l.message).slice(-3)).toEqual(['deploying forms 0.1.8', 'uploading the package', 'failed: the deploy of forms 0.1.8 failed'])
  })
  it('keeps the steps a backend names and the outputs it ends with', async () => {
    const start = (tag: string) => session('/v1/actions/upgrade_app/run', { method: 'POST', ...body({ entity: { blueprint: 'argocd_app', key: 'home/argocd/orrery' }, inputs: { workload: 'k8s_workload:home/orrery/orrery', image: 'registry.example.org/orrery:0.9.12', tag } }) })
    const r = await json<ActionRun>(await start('0.9.15'))
    expect(r.steps).toEqual([])
    expect(r.outputs).toEqual({})
    const report = (b: Record<string, unknown>) => machine(`/v1/action-runs/${r.id}/report`, { method: 'POST', ...body(b) }, reporter)
    // A step by the field, then the lines under it; a marker starts the next, and one for the step under way starts nothing.
    const json1 = JSON.stringify({ level: 'info', msg: 'looking at the app', step: 'Verify' })
    expect((await report({ log: ['warming up'] })).status).toBe(200)
    expect((await report({ step: 'Check out', log: ['cloned', '::step:: Check out', '::step:: Set the tag', 'tag set', '::output:: commit=abc123'] })).status).toBe(200)
    expect((await report({ step: 'Set the tag', outputs: { url: 'https://example.org/orrery', replicas: 3, healthy: true }, log: ['pushed', json1, 'seen at 0.9.15'] })).status).toBe(200)
    const seen = await json<ActionRun>(await session(`/v1/action-runs/${r.id}`))
    expect(seen.steps.map((s) => s.name)).toEqual(['Check out', 'Set the tag', 'Verify'])
    expect(seen.steps.every((s) => !Number.isNaN(Date.parse(s.at)))).toBe(true)
    expect(seen.log.slice(2).map((l) => [l.step ?? null, l.message])).toEqual([
      [null, 'warming up'],
      ['Check out', 'cloned'],
      ['Set the tag', 'tag set'],
      ['Set the tag', 'pushed'],
      ['Verify', json1],
      ['Verify', 'seen at 0.9.15'],
    ])
    expect(seen.outputs).toEqual({ commit: 'abc123', url: 'https://example.org/orrery', replicas: 3, healthy: true })
    // Null takes an output away, a later value replaces one, and the hub's own closing line is under no step.
    const done = await json<ActionRun>(await report({ state: 'succeeded', summary: 'orrery is at 0.9.15', outputs: { replicas: null, commit: 'def456' }, log: ['::output:: healthy=yes'] }))
    expect(done.outputs).toEqual({ commit: 'def456', url: 'https://example.org/orrery', healthy: 'yes' })
    expect(done.log.at(-1)).toMatchObject({ message: 'succeeded: orrery is at 0.9.15' })
    expect(done.log.at(-1)!.step).toBeUndefined()
    const listed = (await json<ActionRunsResponse>(await session('/v1/action-runs?action=upgrade_app&limit=500'))).runs.find((x) => x.id === r.id)!
    expect(listed.steps.map((s) => s.name)).toEqual(['Check out', 'Set the tag', 'Verify'])
    expect(listed.outputs).toEqual(done.outputs)
  })
  it('refuses a report past what a run may hold, and loses nothing a line said', async () => {
    const r = await json<ActionRun>(await session('/v1/actions/upgrade_app/run', { method: 'POST', ...body({ entity: { blueprint: 'argocd_app', key: 'home/argocd/orrery' }, inputs: { workload: 'k8s_workload:home/orrery/orrery', image: 'registry.example.org/orrery:0.9.12', tag: '0.9.16' } }) }))
    const report = (b: Record<string, unknown>) => machine(`/v1/action-runs/${r.id}/report`, { method: 'POST', ...body(b) }, reporter)
    const long = await report({ outputs: { note: 'x'.repeat(2001) } })
    expect(long.status).toBe(400)
    expect((await json(long)).error).toContain('at most 2000 characters')
    expect((await report({ outputs: { 'a name': 'x' } })).status).toBe(400)
    expect((await report({ outputs: { nested: { a: 1 } } })).status).toBe(400)
    expect((await report({ step: 'x'.repeat(81) })).status).toBe(400)
    expect((await report({ step: '   ' })).status).toBe(400)
    const many = Object.fromEntries(Array.from({ length: 49 }, (_, i) => [`k${i}`, i]))
    expect((await report({ outputs: many })).status).toBe(200)
    const over = await report({ outputs: { a: 1, b: 2 }, log: ['never kept'] })
    expect(over.status).toBe(400)
    expect((await json(over)).error).toContain('at most 50 outputs')
    // Replacing and removing make room; a marker past the cap, or one that breaks a rule, stays a line.
    expect((await report({ outputs: { k0: null, a: 1, b: 2 } })).status).toBe(200)
    const full = await json<ActionRun>(await report({ log: ['::output:: k1=again', '::output:: c=3', `::step:: ${'s'.repeat(81)}`] }))
    expect(Object.keys(full.outputs)).toHaveLength(50)
    expect(full.outputs.k1).toBe('again')
    expect(full.outputs.c).toBeUndefined()
    expect(full.log.slice(-2).map((l) => l.message)).toEqual(['::output:: c=3', `::step:: ${'s'.repeat(81)}`])
    expect(full.log.some((l) => l.message === 'never kept')).toBe(false)
    expect(full.steps).toEqual([])
    await report({ state: 'failed', summary: 'done with it' })
  })
  it('loses no line, step, or output when reports land at once', async () => {
    const r = await json<ActionRun>(await session('/v1/actions/upgrade_app/run', { method: 'POST', ...body({ entity: { blueprint: 'argocd_app', key: 'home/argocd/orrery' }, inputs: { workload: 'k8s_workload:home/orrery/orrery', image: 'registry.example.org/orrery:0.9.12', tag: '0.9.17' } }) }))
    const before = r.log.length
    const report = (b: Record<string, unknown>) => machine(`/v1/action-runs/${r.id}/report`, { method: 'POST', ...body(b) }, reporter)
    const sent = await Promise.all(Array.from({ length: 12 }, (_, i) => report({ step: `Step ${i % 3}`, outputs: { [`o${i}`]: i }, log: [`line ${i}a`, `line ${i}b`] })))
    expect(sent.map((s) => s.status)).toEqual(Array.from({ length: 12 }, () => 200))
    const seen = await json<ActionRun>(await session(`/v1/action-runs/${r.id}`))
    expect(seen.log).toHaveLength(before + 24)
    expect(Object.keys(seen.outputs)).toHaveLength(12)
    // Each line is under the step its own report named, and no step starts twice in a row.
    for (const line of seen.log.slice(before)) expect(line.step).toBe(`Step ${Number(/\d+/.exec(line.message)![0]) % 3}`)
    expect(seen.steps.every((s, i) => i === 0 || s.name !== seen.steps[i - 1]!.name)).toBe(true)
    const runs: string[] = []
    for (const line of seen.log.slice(before)) if (runs.at(-1) !== line.step) runs.push(line.step!)
    expect(seen.steps.map((s) => s.name)).toEqual(runs)
    await report({ state: 'succeeded' })
  })
  it('says when older runs match than a page holds', async () => {
    const all = await json<ActionRunsResponse>(await session('/v1/action-runs?action=upgrade_app&limit=500'))
    expect(all.runs.length).toBeGreaterThan(1)
    expect(all.more).toBe(false)
    const first = await json<ActionRunsResponse>(await session('/v1/action-runs?action=upgrade_app&limit=1'))
    expect(first.runs.map((r) => r.id)).toEqual([all.runs[0]!.id])
    expect(first.more).toBe(true)
    const exact = await json<ActionRunsResponse>(await session(`/v1/action-runs?action=upgrade_app&limit=${all.runs.length}`))
    expect(exact.more).toBe(false)
  })
  it('fails the run when the backend refuses it or its secret is missing', async () => {
    answer = 500
    const r = await json<ActionRun>(await session('/v1/actions/upgrade_app/run', { method: 'POST', ...body({ entity: { blueprint: 'argocd_app', key: 'home/argocd/orrery' }, inputs: { workload: 'k8s_workload:home/orrery/orrery', image: 'registry.example.org/orrery:0.9.12', tag: '1' } }) }))
    answer = 202
    expect(r.state).toBe('failed')
    expect(r.log.at(-1)!.message).toBe('webhook answered 500: nope')
    await session('/v1/actions/no_secret', { method: 'PUT', ...body({ title: 'x', inputs: {}, backend: { type: 'webhook', url: `${hookUrl}/x`, secretRef: 'absent' } }) })
    const r2 = await json<ActionRun>(await session('/v1/actions/no_secret/run', { method: 'POST', ...body({ inputs: {} }) }))
    expect(r2.state).toBe('failed')
    expect(r2.log.at(-1)!.message).toBe('secret "absent" is not set in the hub')
  })
  it('dispatches a github workflow as a workflow_dispatch', async () => {
    received = []
    await session('/v1/actions/gh', { method: 'PUT', ...body({ title: 'gh', inputs: { tag: { type: 'string', required: true } }, backend: { type: 'webhook', url: `${hookUrl}/repos/o/r/actions/workflows/w.yml/dispatches`, body: { ref: 'main', inputs: { run: '{{ run.id }}', tag: '{{ inputs.tag }}' } } } }) })
    const r = await json<ActionRun>(await session('/v1/actions/gh/run', { method: 'POST', ...body({ inputs: { tag: '1.2.3' } }) }))
    expect(r.state).toBe('running')
    expect(received[0]!.body).toEqual({ ref: 'main', inputs: { run: r.id, tag: '1.2.3' } })
  })
  it('refuses a sort that names no field, and keeps one that does', async () => {
    const bad = await session('/v1/actions/sorted', { method: 'PUT', ...body({ title: 'x', inputs: { w: { type: 'entity', blueprint: 'k8s_workload', sort: '-nope' } }, backend: { type: 'webhook', url: `${hookUrl}/x` } }) })
    expect((await json(bad)).error).toContain('sort names "nope"')
    const ok = await session('/v1/actions/sorted', { method: 'PUT', ...body({ title: 'x', inputs: { w: { type: 'entity', blueprint: 'k8s_workload', sort: '-created_at' }, t: { type: 'entity', blueprint: 'k8s_workload', sort: '-updatedAt' } }, backend: { type: 'webhook', url: `${hookUrl}/x` } }) })
    expect(ok.status).toBe(200)
    // The form reads the options through the search with that sort.
    const newest = await json<{ entities: { key: string }[] }>(await session('/v1/entities?blueprint=k8s_workload&sort=-updatedAt&limit=1'))
    expect(newest.entities).toHaveLength(1)
  })
  it('takes a list for an input marked many, one item checked at a time', async () => {
    received = []
    await session('/v1/actions/upgrade_many', { method: 'PUT', ...body({ ...upgrade({ type: 'webhook', url: `${hookUrl}/deploy` }), inputs: { workload: { type: 'entity', blueprint: 'k8s_workload', required: true, where: { relation: 'namespace', target: '{{ entity.relations.namespace }}' } }, images: { type: 'enum', many: true, required: true, values: '{{ inputs.workload.fields.images }}' }, overrides: { type: 'string', many: true }, tag: { type: 'string', required: true } } }) })
    const target = { entity: { blueprint: 'argocd_app', key: 'home/argocd/orrery' } }
    const notList = await session('/v1/actions/upgrade_many/run', { method: 'POST', ...body({ ...target, inputs: { workload: 'k8s_workload:home/orrery/orrery', images: 'registry.example.org/orrery:0.9.12', tag: '1' } }) })
    expect(notList.status).toBe(201)
    const bad = await session('/v1/actions/upgrade_many/run', { method: 'POST', ...body({ ...target, inputs: { workload: 'k8s_workload:home/orrery/orrery', images: ['registry.example.org/orrery:0.9.12', 'storefront:1'], tag: '1' } }) })
    expect((await json(bad)).error).toContain('expected one of')
    const none = await session('/v1/actions/upgrade_many/run', { method: 'POST', ...body({ ...target, inputs: { workload: 'k8s_workload:home/orrery/orrery', images: [], tag: '1' } }) })
    expect((await json(none)).error).toContain('"images" is required')
    received = []
    const r = await json<ActionRun>(await session('/v1/actions/upgrade_many/run', { method: 'POST', ...body({ ...target, inputs: { workload: 'k8s_workload:home/orrery/orrery', images: ['registry.example.org/orrery:0.9.12', 'registry.example.org/orrery-runner:0.9.12'], overrides: 'a:1\n\nb:2\n', tag: '0.9.13' } }) }))
    expect(r.state).toBe('running')
    expect(r.inputs.images).toEqual(['registry.example.org/orrery:0.9.12', 'registry.example.org/orrery-runner:0.9.12'])
    expect(r.inputs.overrides).toEqual(['a:1', 'b:2'])
    const payload = received[0]!.body as { inputs: { images: string[]; overrides: string[] } }
    expect(payload.inputs.images).toHaveLength(2)
    expect(payload.inputs.overrides).toEqual(['a:1', 'b:2'])
  })

  it('fills an entity input from its default on the entity, and takes a bare key', async () => {
    received = []
    await session('/v1/actions/from_entity', {
      method: 'PUT',
      ...body({
        title: 'From the entity',
        blueprint: 'argocd_app',
        inputs: {
          ns: { type: 'entity', blueprint: 'k8s_namespace', required: true, default: '{{ entity.relations.namespace }}' },
          first: { type: 'entity', blueprint: 'k8s_namespace', required: true, default: ['k8s_namespace:home/shop', 'k8s_namespace:home/orrery'] },
          workload: { type: 'entity', blueprint: 'k8s_workload', required: true },
        },
        backend: { type: 'webhook', url: `${hookUrl}/x` },
      }),
    })
    const target = { entity: { blueprint: 'argocd_app', key: 'home/argocd/orrery' } }
    const r = await json<ActionRun>(await session('/v1/actions/from_entity/run', { method: 'POST', ...body({ ...target, inputs: { workload: 'home/orrery/orrery' } }) }))
    expect(r.inputs).toEqual({ ns: 'k8s_namespace:home/orrery', first: 'k8s_namespace:home/shop', workload: 'k8s_workload:home/orrery/orrery' })
    const wrong = await session('/v1/actions/from_entity/run', { method: 'POST', ...body({ ...target, inputs: { workload: 'k8s_namespace:home/orrery' } }) })
    expect((await json(wrong)).error).toContain('expected a k8s_workload')
  })
})

describe('the self-service layout', () => {
  it('is one shared order and set of closed groups, kept by whoever may organize', async () => {
    expect((await json<{ order: string[]; closed: string[] }>(await session('/v1/actions/layout')))).toEqual({ order: [], closed: [] })
    expect((await machine('/v1/actions/layout', { method: 'PUT', ...body({ order: ['Orrery'] }) }, viewer)).status).toBe(403)
    expect((await json(await session('/v1/actions/layout', { method: 'PUT', ...body({ order: ['Orrery', 'Operations'] }) })))).toEqual({ order: ['Orrery', 'Operations'], closed: [] })
    // Each part is set on its own; the other stays.
    expect((await json(await session('/v1/actions/layout', { method: 'PUT', ...body({ closed: ['Operations'] }) })))).toEqual({ order: ['Orrery', 'Operations'], closed: ['Operations'] })
    expect((await json(await bob('/v1/actions/layout')))).toEqual({ order: ['Orrery', 'Operations'], closed: ['Operations'] })
    const arranged = (await json<{ changes: Change[] }>(await session('/v1/changes?kind=action.arranged'))).changes
    expect(arranged[0]).toMatchObject({ category: 'actions', detail: { closed: ['Operations'] } })
  })

  it('lets the section of what has no home and no group start closed, and never orders it', async () => {
    expect((await json(await session('/v1/actions/layout', { method: 'PUT', ...body({ closed: ['Operations', ''] }) })))).toEqual({ order: ['Orrery', 'Operations'], closed: ['Operations', ''] })
    expect((await session('/v1/actions/layout', { method: 'PUT', ...body({ order: ['Orrery', ''] }) })).status).toBe(400)
    expect((await json(await session('/v1/actions/layout', { method: 'PUT', ...body({ closed: ['Operations'] }) })))).toEqual({ order: ['Orrery', 'Operations'], closed: ['Operations'] })
  })
})

describe('who may run an action', () => {
  const run = (who: (p: string, i?: RequestInit) => Promise<Response>, id: string) => who(`/v1/actions/${id}/run`, { method: 'POST', ...body({ inputs: {} }) })
  const define = (id: string, access?: Record<string, unknown>) => session(`/v1/actions/${id}`, { method: 'PUT', ...body({ title: id, group: 'Orrery', inputs: {}, backend: { type: 'webhook', url: `${hookUrl}/x` }, ...(access ? { access } : {}) }) })
  it('is nobody but an admin until the action says who', async () => {
    await define('admins_only')
    expect((await run(session, 'admins_only')).status).toBe(201)
    expect((await run(ada, 'admins_only')).status).toBe(403)
    expect((await run(machineAs(viewer), 'admins_only')).status).toBe(403)
    const refused = (await json<{ changes: Change[] }>(await session('/v1/changes?kind=access.refused&actor=ada'))).changes
    expect(refused[0]).toMatchObject({ actor: 'ada@example.org', detail: { action: 'admins_only' } })
  })
  it('opens to everyone, to named people and tokens, and to people reached through the graph', async () => {
    await define('open', { everyone: true })
    expect((await run(bob, 'open')).status).toBe(201)
    expect((await run(machineAs(viewer), 'open')).status).toBe(201)
    await define('named', { grants: [{ values: ['bob@example.org', 'workflow'] }] })
    expect((await run(bob, 'named')).status).toBe(201)
    expect((await run(ada, 'named')).status).toBe(403)
    expect((await run(machineAs(reporter), 'named')).status).toBe(201)
    expect((await run(machineAs(viewer), 'named')).status).toBe(403)
    await define('crew', { grants: [{ path: 'crews', values: ['platform'] }] })
    expect((await run(ada, 'crew')).status).toBe(201)
    expect((await run(bob, 'crew')).status).toBe(403)
    await define('project', { grants: [{ path: 'crews.<-project:crew', values: ['orrery'] }] })
    expect((await run(ada, 'project')).status).toBe(201)
    expect((await run(bob, 'project')).status).toBe(403)
  })
  it('hides what a person may not run, and marks it for whoever may edit it', async () => {
    const ids = async (who: (p: string, i?: RequestInit) => Promise<Response>) => (await json<{ actions: { id: string; canRun: boolean }[] }>(await who('/v1/actions'))).actions.filter((a) => a.id.startsWith('admins_only') || ['open', 'named', 'crew', 'project'].includes(a.id)).map((a) => `${a.id}${a.canRun ? '' : '!'}`).sort()
    expect(await ids(bob)).toEqual(['named', 'open'])
    expect(await ids(ada)).toEqual(['crew', 'open', 'project'])
    expect(await ids(cy)).toEqual(['admins_only!', 'crew!', 'named!', 'open', 'project!'])
    expect(await ids(session)).toEqual(['admins_only', 'crew', 'named', 'open', 'project'])
    expect((await bob('/v1/actions/crew')).status).toBe(200)
    expect((await json<{ canRun: boolean }>(await bob('/v1/actions/crew'))).canRun).toBe(false)
  })
  it('keeps the access an admin set when anyone else saves the action, and lets only an admin change it', async () => {
    await define('declared', { grants: [{ values: ['bob@example.org'] }] })
    const spec = { title: 'declared again', group: 'Orrery', inputs: {}, backend: { type: 'webhook', url: `${hookUrl}/y` } }
    expect((await cy('/v1/actions/declared', { method: 'PUT', ...body(spec) })).status).toBe(200)
    const kept = await json<{ title: string; access: unknown }>(await session('/v1/actions/declared'))
    expect(kept).toMatchObject({ title: 'declared again', access: { grants: [{ values: ['bob@example.org'] }] } })
    expect((await run(bob, 'declared')).status).toBe(201)
    expect((await cy('/v1/actions/declared', { method: 'PUT', ...body({ ...spec, access: { everyone: true } }) })).status).toBe(403)
    expect((await cy('/v1/actions/declared', { method: 'PUT', ...body({ ...spec, access: kept.access }) })).status).toBe(200)
    expect((await cy('/v1/actions/fresh_one', { method: 'PUT', ...body(spec) })).status).toBe(200)
    expect((await run(bob, 'fresh_one')).status).toBe(403)
  })
  it('lists for a portal what one person may run, and nothing they may only edit', async () => {
    const forPerson = async (email: string) => (await json<{ actions: { id: string; canRun: boolean }[] }>(await machine(`/v1/actions?for=${encodeURIComponent(email)}`, undefined, portal))).actions.filter((a) => a.id.startsWith('admins_only') || ['open', 'named', 'crew', 'project'].includes(a.id)).map((a) => a.id).sort()
    expect(await forPerson('bob@example.org')).toEqual(['named', 'open'])
    expect(await forPerson('ada@example.org')).toEqual(['crew', 'open', 'project'])
    expect(await forPerson('cy@example.org')).toEqual(['open'])
    expect(await forPerson('nobody@example.org')).toEqual([])
    const open = (await json<{ actions: Record<string, unknown>[] }>(await machine('/v1/actions?for=bob%40example.org', undefined, portal))).actions.find((a) => a.id === 'open')!
    expect(Object.keys(open).sort()).toEqual(['group', 'iconShown', 'id', 'lastRun', 'pinned', 'title'])
    expect((await machine('/v1/actions?for=bob%40example.org', undefined, viewer)).status).toBe(403)
    expect((await bob('/v1/actions?for=ada%40example.org')).status).toBe(403)
    const refused = (await json<{ changes: Change[] }>(await session('/v1/changes?kind=access.refused&actor=bob'))).changes
    expect(refused[0]).toMatchObject({ actor: 'bob@example.org', detail: { listFor: 'ada@example.org', reason: 'missing actions.list' } })
  })
})

describe('approval', () => {
  it('holds the run until someone else approves, and declines', async () => {
    await session('/v1/actions/careful', { method: 'PUT', ...body({ title: 'x', inputs: {}, approval: true, backend: { type: 'webhook', url: `${hookUrl}/x` } }) })
    received = []
    const r = await json<ActionRun>(await session('/v1/actions/careful/run', { method: 'POST', ...body({ inputs: {} }) }))
    expect(r.state).toBe('awaiting')
    expect(received).toHaveLength(0)
    expect((await machine(`/v1/action-runs/${r.id}/report`, { method: 'POST', ...body({ log: ['x'] }) }, reporter)).status).toBe(409)
    expect((await session(`/v1/action-runs/${r.id}/approve`, { method: 'POST' })).status).toBe(403)
    const approved = await json<ActionRun>(await machine(`/v1/action-runs/${r.id}/approve`, { method: 'POST' }, approver))
    expect(approved.state).toBe('running')
    expect(received).toHaveLength(1)
    expect(approved.log.map((l) => l.message)).toEqual(['requested by local@example.org; waiting for approval', 'approved by lead', 'webhook accepted (202)'])
    expect(approved.decidedBy).toBe('lead')
    expect(approved.decidedAt).not.toBeNull()
    const r2 = await json<ActionRun>(await session('/v1/actions/careful/run', { method: 'POST', ...body({ inputs: {} }) }))
    const declined = await json<ActionRun>(await machine(`/v1/action-runs/${r2.id}/decline`, { method: 'POST', ...body({ reason: 'not now' }) }, approver))
    expect(declined.state).toBe('declined')
    expect(declined.log.at(-1)!.message).toBe('declined by lead: not now')
    expect(declined.decidedBy).toBe('lead')
    expect((await machine(`/v1/action-runs/${r2.id}/approve`, { method: 'POST' }, approver)).status).toBe(409)
  })

  it('lets the person who asked approve their own run only when the action says so', async () => {
    const put = (selfApproval: boolean) => session('/v1/actions/solo', { method: 'PUT', ...body({ title: 'Solo', inputs: {}, approval: true, selfApproval, backend: { type: 'caller' } }) })
    expect((await put(false)).status).toBe(200)
    const r = await json<ActionRun>(await session('/v1/actions/solo/run', { method: 'POST', ...body({ inputs: {} }) }))
    expect(r.canDecide).toBeFalsy()
    expect((await session(`/v1/action-runs/${r.id}/approve`, { method: 'POST' })).status).toBe(403)
    await put(true)
    const listed = (await json<{ runs: ActionRun[] }>(await session('/v1/action-runs?action=solo&state=awaiting'))).runs
    expect(listed.find((x) => x.id === r.id)?.canDecide).toBe(true)
    const approved = await json<ActionRun>(await session(`/v1/action-runs/${r.id}/approve`, { method: 'POST' }))
    expect(approved.state).toBe('queued')
    expect(approved.decidedBy).toBe('local@example.org')
    expect(approved.log.find((l) => l.message.startsWith('approved by'))!.message).toBe('approved by local@example.org, who asked for it')
    const rows = (await json<{ changes: Change[] }>(await session('/v1/changes?kind=action.approved'))).changes
    expect(rows[0]).toMatchObject({ detail: { run: r.id, selfApproved: true } })
    // Only someone who may approve at all approves their own run.
    await session('/v1/actions/solo', { method: 'PUT', ...body({ title: 'Solo', inputs: {}, approval: true, selfApproval: true, backend: { type: 'caller' }, access: { everyone: true } }) })
    const adas = await json<ActionRun>(await ada('/v1/actions/solo/run', { method: 'POST', ...body({ inputs: {} }) }))
    expect((await ada(`/v1/action-runs/${adas.id}/approve`, { method: 'POST' })).status).toBe(403)
    expect((await session('/v1/actions/solo_never', { method: 'PUT', ...body({ title: 'x', inputs: {}, selfApproval: true, backend: { type: 'caller' } }) })).status).toBe(400)
    await machine(`/v1/action-runs/${r.id}/report`, { method: 'POST', ...body({ state: 'failed' }) }, reporter)
  })
})

describe('an action with no form', () => {
  it('is started by its tool on the machine port, and by no browser or agent', async () => {
    const put = await session('/v1/actions/tool_only', { method: 'PUT', ...body({ title: 'Tool only', inputs: {}, form: false, backend: { type: 'caller' }, access: { everyone: true } }) })
    expect(put.status).toBe(200)
    expect((await session('/v1/actions/tool_only/run', { method: 'POST', ...body({ inputs: {} }) })).status).toBe(403)
    const listed = (await json<{ actions: { id: string; canRun: boolean }[] }>(await ada('/v1/actions'))).actions
    expect(listed.find((a) => a.id === 'tool_only')).toBeUndefined()
    const asAdmin = (await json<{ actions: { id: string; canRun: boolean }[] }>(await session('/v1/actions'))).actions
    expect(asAdmin.find((a) => a.id === 'tool_only')?.canRun).toBe(false)
    const run = await machine('/v1/actions/tool_only/run', { method: 'POST', ...body({ inputs: {} }) }, reporter)
    expect(run.status).toBe(201)
    const rows = (await json<{ changes: Change[] }>(await session('/v1/changes?kind=access.refused'))).changes
    expect(rows.some((r) => (r.detail as { action?: string }).action === 'tool_only')).toBe(true)
    await machine(`/v1/action-runs/${(await json<ActionRun>(run)).id}/report`, { method: 'POST', ...body({ state: 'succeeded' }) }, reporter)
  })
})

describe('an attachment', () => {
  const plan = '  # azurerm_api_management_subscription.app will be created\n  + resource "azurerm_api_management_subscription" "app" {\n      + display_name = "graft"\n    }\n'
  beforeAll(async () => {
    const put = await session('/v1/actions/apply_attached', { method: 'PUT', ...body({ title: 'Apply', inputs: { environment: { type: 'string', required: true }, plan: { type: 'attachment', title: 'The whole plan' } }, approval: true, backend: { type: 'caller' }, access: { everyone: true } }) })
    expect(put.status).toBe(200)
  })

  it('is kept on the run exactly as sent, and left out of lists, the activity log, and notices', async () => {
    const asked = await json<ActionRun>(await ada('/v1/actions/apply_attached/run', { method: 'POST', ...body({ inputs: { environment: 'prod', plan } }) }))
    expect(asked.state).toBe('awaiting')
    expect((await json<ActionRun>(await session(`/v1/action-runs/${asked.id}`))).inputs).toEqual({ environment: 'prod', plan })
    const listed = (await json<ActionRunsResponse>(await session('/v1/action-runs?action=apply_attached'))).runs.find((r) => r.id === asked.id)!
    expect(listed.inputs).toEqual({ environment: 'prod', plan: `attached: ${plan.length} characters` })
    const requested = (await json<{ changes: Change[] }>(await session('/v1/changes?kind=action.requested'))).changes.find((c) => (c.detail as { run?: string }).run === asked.id)!
    expect((requested.detail as { inputs: Record<string, unknown> }).inputs).toEqual({ environment: 'prod', plan: `attached: ${plan.length} characters` })
    const sent: NoticeEvent[] = []
    const dispatch: typeof fetch = async (url, init) => {
      if (String(url).endsWith('/v1/events')) sent.push(JSON.parse(String(init?.body)) as NoticeEvent)
      return new Response(JSON.stringify({ queued: 1, kinds: 1 }), { status: 202 })
    }
    await new NoticeForwarder({ db: hub.db, actions: hub.actions, batches: hub.batches, sets: hub.changeSets, schedules: hub.schedules, people: () => hub.people(), reader: hub.reader, blueprints: hub.blueprints, log: createLogger('notices-test') }, { url: 'http://dispatch.test/', token: 'tok', publicUrl: 'https://orrery.example.org/', remindHours: 0 }, dispatch).pass()
    const waiting = sent.find((e) => e.labels.action === 'apply_attached' && e.kind === 'action.awaiting_approval')!
    expect(waiting.facts).toContainEqual({ name: 'environment', value: 'prod' })
    expect(JSON.stringify(waiting)).not.toContain('azurerm_api_management_subscription')
  })

  it('refuses one past its most', async () => {
    const r = await ada('/v1/actions/apply_attached/run', { method: 'POST', ...body({ inputs: { environment: 'test', plan: 'x'.repeat(1_000_001) } }) })
    expect(r.status).toBe(400)
    expect(await json(r)).toMatchObject({ input: 'plan' })
  })
})

describe('runs one at a time', () => {
  const ask = (who: typeof ada, inputs: Record<string, unknown>) => who('/v1/actions/apply_line/run', { method: 'POST', ...body({ inputs }) }).then((r) => json<ActionRun>(r))
  const approve = async (id: string) => json<ActionRun>(await machine(`/v1/action-runs/${id}/approve`, { method: 'POST' }, approver))
  const report = (id: string, state: string) => machine(`/v1/action-runs/${id}/report`, { method: 'POST', ...body({ state }) }, reporter)
  const run = (id: string) => session(`/v1/action-runs/${id}`).then((r) => json<ActionRun>(r))
  beforeAll(async () => {
    const put = await session('/v1/actions/apply_line', { method: 'PUT', ...body({ title: 'Apply', inputs: { environment: { type: 'string', required: true }, commit: { type: 'string' } }, approval: true, serial: ['environment'], backend: { type: 'caller' }, access: { everyone: true } }) })
    expect(put.status).toBe(200)
  })

  it('refuses serial on a backend whose start the hub does not see', async () => {
    const r = await session('/v1/actions/apply_hook', { method: 'PUT', ...body({ title: 'x', inputs: { environment: { type: 'string' } }, serial: ['environment', 'nope'], backend: { type: 'webhook', url: `${hookUrl}/x` } }) })
    expect(r.status).toBe(400)
    const text = await r.text()
    expect(text).toContain('only a runner, a job, or a caller backend')
    expect(text).toContain('\\"nope\\" is not an input')
  })

  it('waits, once approved, for whoever asked to start it, and takes their report', async () => {
    const r = await ask(ada, { environment: 'dev', commit: 'a1' })
    const approved = await approve(r.id)
    expect(approved.state).toBe('queued')
    expect(approved.log.at(-1)!.message).toBe('waiting for ada@example.org to start it')
    expect((await report(r.id, 'running')).status).toBe(200)
    expect((await run(r.id)).startedAt).not.toBeNull()
    expect((await report(r.id, 'succeeded')).status).toBe(200)
    expect((await run(r.id)).state).toBe('succeeded')
  })

  it('gives back the waiting run when asked again, and replaces it when asked for something newer', async () => {
    const first = await ask(ada, { environment: 'prod', commit: 'a1' })
    expect((await ask(ada, { environment: 'prod', commit: 'a1' })).id).toBe(first.id)
    const second = await ask(ada, { environment: 'prod', commit: 'b2' })
    expect(second.id).not.toBe(first.id)
    const replaced = await run(first.id)
    expect(replaced.state).toBe('cancelled')
    expect(replaced.finishedAt).not.toBeNull()
    expect(replaced.log.at(-1)!.message).toBe(`replaced by run ${second.id}, asked by ada@example.org`)
    const other = await ask(ada, { environment: 'test', commit: 'b2' })
    expect((await run(second.id)).state).toBe('awaiting')
    const cancelled = (await json<{ changes: Change[] }>(await session('/v1/changes?kind=action.cancelled'))).changes
    expect(cancelled[0]).toMatchObject({ actor: 'ada@example.org', detail: { run: first.id, requestedBy: 'ada@example.org' } })
    await approve(second.id)
    await approve(other.id)
    expect((await report(second.id, 'running')).status).toBe(200)
    // A newer request leaves the running one alone, and waits its turn behind it.
    const third = await ask(ada, { environment: 'prod', commit: 'c3' })
    expect((await run(second.id)).state).toBe('running')
    await approve(third.id)
    const blocked = await report(third.id, 'running')
    expect(blocked.status).toBe(409)
    expect(await blocked.text()).toContain(`run \\"${second.id}\\" of the same line is running`)
    expect((await run(third.id)).state).toBe('queued')
    expect((await report(other.id, 'running')).status).toBe(200)
    expect((await report(second.id, 'succeeded')).status).toBe(200)
    expect((await report(third.id, 'running')).status).toBe(200)
    await report(third.id, 'succeeded')
    await report(other.id, 'succeeded')
  })

  it('holds a start past its concurrency, whatever the inputs, until a run ends', async () => {
    expect((await session('/v1/actions/apply_capped', { method: 'PUT', ...body({ title: 'Apply', inputs: { environment: { type: 'string', required: true } }, concurrency: 1, backend: { type: 'caller' }, access: { everyone: true } }) })).status).toBe(200)
    const asked = (environment: string) => ada('/v1/actions/apply_capped/run', { method: 'POST', ...body({ inputs: { environment } }) }).then((r) => json<ActionRun>(r))
    const first = await asked('east')
    const second = await asked('west')
    expect((await report(first.id, 'running')).status).toBe(200)
    const blocked = await report(second.id, 'running')
    expect(blocked.status).toBe(409)
    expect(await blocked.text()).toContain('1 of its runs are in flight, the most it runs at once')
    // Neither is replaced: the second waits its turn.
    expect((await run(second.id)).state).toBe('queued')
    expect((await report(first.id, 'succeeded')).status).toBe(200)
    expect((await report(second.id, 'running')).status).toBe(200)
    expect((await report(second.id, 'succeeded')).status).toBe(200)
  })

  it('lets only the person who asked, or an admin, withdraw a run not started yet', async () => {
    const r = await ask(ada, { environment: 'stage', commit: 'a1' })
    expect((await bob(`/v1/action-runs/${r.id}/withdraw`, { method: 'POST', ...body({}) })).status).toBe(403)
    const gone = await json<ActionRun>(await ada(`/v1/action-runs/${r.id}/withdraw`, { method: 'POST', ...body({ reason: 'gave up waiting' }) }))
    expect(gone.state).toBe('cancelled')
    expect(gone.log.at(-1)!.message).toBe('withdrawn by ada@example.org: gave up waiting')
    expect((await ada(`/v1/action-runs/${r.id}/withdraw`, { method: 'POST', ...body({}) })).status).toBe(409)
    expect((await approve(r.id)).state).toBeUndefined()
    const admins = await ask(ada, { environment: 'stage', commit: 'b2' })
    expect((await session(`/v1/action-runs/${admins.id}/withdraw`, { method: 'POST', ...body({}) })).status).toBe(200)
  })

  it('cancels an approved run nobody starts', async () => {
    const r = await ask(ada, { environment: 'qa', commit: 'a1' })
    await approve(r.id)
    await hub.db.query(`UPDATE action_runs SET decided_at = now() - interval '2 hours' WHERE id = $1`, [r.id])
    expect(await hub.actions.expire()).toBe(1)
    const gone = await run(r.id)
    expect(gone.state).toBe('cancelled')
    expect(gone.log.at(-1)!.message).toBe('not started within 60 minutes of its approval; given up')
    expect((await report(r.id, 'running')).status).toBe(409)
  })

  it('keeps an approved run waiting its turn behind a long one of its line', async () => {
    const first = await ask(ada, { environment: 'uat', commit: 'a1' })
    await approve(first.id)
    expect((await report(first.id, 'running')).status).toBe(200)
    const next = await ask(ada, { environment: 'uat', commit: 'b2' })
    await approve(next.id)
    await hub.db.query(`UPDATE action_runs SET decided_at = now() - interval '2 hours', started_at = now() - interval '2 hours' WHERE id = ANY($1)`, [[first.id, next.id]])
    await hub.db.query(`UPDATE action_runs SET started_at = now() WHERE id = $1`, [first.id])
    expect(await hub.actions.expire()).toBe(0)
    expect((await run(next.id)).state).toBe('queued')
    expect((await report(first.id, 'succeeded')).status).toBe(200)
    expect(await hub.actions.expire()).toBe(0)
    expect((await report(next.id, 'running')).status).toBe(200)
    await report(next.id, 'succeeded')
  })
})

describe('signing a person in from an app', () => {
  it('says nothing on a hub that takes no person from an app', async () => {
    expect((await machine('/v1/sign-in', { headers: { authorization: '' } })).status).toBe(404)
  })
})

describe('finding runs', () => {
  it('lists the runs one person asked for, and gives each action its newest run', async () => {
    await session('/v1/actions/everyone_hook', { method: 'PUT', ...body({ title: 'Anyone', inputs: {}, confirm: true, backend: { type: 'webhook', url: `${hookUrl}/x` }, access: { everyone: true } }) })
    const mine = await json<ActionRun>(await ada('/v1/actions/everyone_hook/run', { method: 'POST', ...body({ inputs: {} }) }))
    const theirs = await json<ActionRun>(await bob('/v1/actions/everyone_hook/run', { method: 'POST', ...body({ inputs: {} }) }))
    const adas = (await json<{ runs: ActionRun[] }>(await ada('/v1/action-runs?action=everyone_hook&by=ada%40example.org'))).runs
    expect(adas.map((r) => r.id)).toEqual([mine.id])
    const listed = (await json<{ actions: { id: string; confirm?: boolean; lastRun: { id: string } | null }[] }>(await ada('/v1/actions'))).actions
    expect(listed.find((a) => a.id === 'everyone_hook')!.lastRun!.id).toBe(theirs.id)
    expect(listed.find((a) => a.id === 'everyone_hook')!.confirm).toBe(true)
    expect((await json<{ lastRun: { id: string } | null }>(await ada('/v1/actions/everyone_hook'))).lastRun!.id).toBe(theirs.id)
  })

  it('shows a person only the runs of actions they may run, and their own', async () => {
    const hook = (access?: Record<string, unknown>) => session('/v1/actions/narrow_hook', { method: 'PUT', ...body({ title: 'Narrow', inputs: {}, backend: { type: 'webhook', url: `${hookUrl}/x` }, ...(access ? { access } : {}) }) })
    await hook({ everyone: true })
    const adas = await json<ActionRun>(await ada('/v1/actions/narrow_hook/run', { method: 'POST', ...body({ inputs: {} }) }))
    const admins = await json<ActionRun>(await session('/v1/actions/narrow_hook/run', { method: 'POST', ...body({ inputs: {} }) }))
    await hook()
    const listed = async (who: typeof ada) => (await json<{ runs: ActionRun[] }>(await who('/v1/action-runs?action=narrow_hook'))).runs.map((r) => r.id)
    expect(await listed(ada)).toEqual([adas.id])
    expect(await listed(bob)).toEqual([])
    expect(await listed(session)).toEqual([admins.id, adas.id])
    expect((await bob(`/v1/action-runs/${admins.id}`)).status).toBe(404)
    expect((await ada(`/v1/action-runs/${adas.id}`)).status).toBe(200)
    await session('/v1/actions/narrow_hook', { method: 'DELETE' })
    expect(await listed(ada)).toEqual([])
    expect((await ada(`/v1/action-runs/${adas.id}`)).status).toBe(404)
    expect(await listed(session)).toEqual([admins.id, adas.id])
  })
})

describe('what the start page reads', () => {
  type Shown = { id: string; icon?: string; iconShown: string; stats: { usualSeconds: number | null; meanSeconds: number | null; failedInARow: number } }
  const kept: string[] = []
  const hooked = (id: string, extra: Record<string, unknown> = {}) => (kept.push(id), session(`/v1/actions/${id}`, { method: 'PUT', ...body({ title: id, inputs: {}, backend: { type: 'webhook', url: `${hookUrl}/x` }, access: { everyone: true }, ...extra }) }))
  // What these open to everyone is not left for the tests after them to find.
  afterAll(async () => {
    for (const id of kept) await session(`/v1/actions/${id}`, { method: 'DELETE' })
  })
  const shown = async (id: string, who = ada) => (await json<{ actions: Shown[] }>(await who('/v1/actions'))).actions.find((a) => a.id === id)!
  let made = 0
  /** A run that ended `minutesAgo`, after `seconds` of work; one in a state that never ends has no end. */
  const past = (action: string, state: string, minutesAgo: number, seconds: number | null = 1) =>
    hub.db.query(
      `INSERT INTO action_runs (id, action, actor, state, created_at, started_at, finished_at)
       VALUES ($1, $2, 'ada@example.org', $3, now() - make_interval(mins => $4), CASE WHEN $5::int IS NULL THEN NULL ELSE now() - make_interval(mins => $4) - make_interval(secs => $5::int) END, CASE WHEN $3 IN ('succeeded', 'failed', 'cancelled') THEN now() - make_interval(mins => $4) END)`,
      [`past-${++made}`, action, state, minutesAgo, seconds],
    )

  it('shows an action by its own icon, else by its one blueprint, else as a rocket', async () => {
    expect((await hooked('icon_own', { icon: 'wrench', blueprint: 'argocd_app' })).status).toBe(200)
    expect((await hooked('icon_one', { blueprint: 'argocd_app' })).status).toBe(200)
    expect((await hooked('icon_many', { blueprint: ['argocd_app', 'k8s_workload'] })).status).toBe(200)
    expect((await hooked('icon_none')).status).toBe(200)
    expect(await shown('icon_own')).toMatchObject({ icon: 'wrench', iconShown: 'wrench' })
    const one = await shown('icon_one')
    expect(one.iconShown).toBe('argocd')
    expect(one.icon).toBeUndefined()
    expect((await shown('icon_many')).iconShown).toBe('rocket')
    expect((await shown('icon_none')).iconShown).toBe('rocket')
    expect((await json<Shown>(await ada('/v1/actions/icon_one'))).iconShown).toBe('argocd')
    const forAda = (await json<{ actions: Shown[] }>(await machine('/v1/actions?for=ada%40example.org', undefined, portal))).actions
    expect(forAda.find((a) => a.id === 'icon_one')!.iconShown).toBe('argocd')
  })

  it('says how long an action usually takes, from its newest runs that worked', async () => {
    await hooked('timed')
    expect((await shown('timed')).stats).toEqual({ usualSeconds: null, meanSeconds: null, failedInARow: 0 })
    await past('timed', 'succeeded', 50, 10)
    await past('timed', 'succeeded', 49, 30)
    expect((await shown('timed')).stats.usualSeconds).toBeNull()
    await past('timed', 'succeeded', 48, 20)
    expect((await shown('timed')).stats.usualSeconds).toBe(20)
    expect((await json<Shown>(await ada('/v1/actions/timed'))).stats).toEqual({ usualSeconds: 20, meanSeconds: 20, failedInARow: 0 })
    // Twenty newer runs push the three before them out of the count; a failed run, and one never started, are not timed.
    for (let n = 0; n < 20; n++) await past('timed', 'succeeded', 40 - n, 100)
    await past('timed', 'failed', 60, 9000)
    await past('timed', 'succeeded', 19, null)
    expect((await shown('timed')).stats.usualSeconds).toBe(100)
    // What a run costs a batch counts the failed run too, and still not the one never started.
    expect((await shown('timed')).stats.meanSeconds).toBeCloseTo((10 + 30 + 20 + 20 * 100 + 9000) / 24)
  })

  it('counts the newest runs that failed in a row', async () => {
    await hooked('flaky')
    await past('flaky', 'failed', 40)
    await past('flaky', 'succeeded', 30)
    await past('flaky', 'failed', 20)
    await past('flaky', 'cancelled', 15)
    await past('flaky', 'failed', 10)
    await past('flaky', 'running', 5)
    expect((await shown('flaky')).stats.failedInARow).toBe(2)
    await past('flaky', 'succeeded', 1)
    expect((await shown('flaky')).stats.failedInARow).toBe(0)
    await hooked('broken')
    for (const ago of [3, 2, 1]) await past('broken', 'failed', ago)
    expect((await shown('broken')).stats).toEqual({ usualSeconds: null, meanSeconds: 1, failedInARow: 3 })
    expect((await shown('timed')).stats.failedInARow).toBe(0)
  })

  it('names the entity a run is on by its title, and never one the reader may not see', async () => {
    await hooked('titled', { blueprint: 'argocd_app' })
    const on = await json<ActionRun>(await ada('/v1/actions/titled/run', { method: 'POST', ...body({ entity: { blueprint: 'argocd_app', key: 'home/argocd/orrery' }, inputs: {} }) }))
    const runs = async (who: typeof ada, action: string) => (await json<{ runs: ActionRun[] }>(await who(`/v1/action-runs?action=${action}`))).runs
    expect((await runs(ada, 'titled')).find((r) => r.id === on.id)!.entityTitle).toBe('orrery')
    expect((await json<ActionRun>(await ada(`/v1/action-runs/${on.id}`))).entityTitle).toBe('orrery')
    // An entity that is gone has no title to give.
    await hub.db.query(`INSERT INTO action_runs (id, action, blueprint, key, actor, state) VALUES ('past-gone', 'titled', 'argocd_app', 'home/argocd/gone', 'ada@example.org', 'succeeded')`)
    expect((await runs(ada, 'titled')).find((r) => r.id === 'past-gone')!.entityTitle).toBeNull()
    // A run on nothing names nothing.
    await hooked('untitled')
    const free = await json<ActionRun>(await ada('/v1/actions/untitled/run', { method: 'POST', ...body({ inputs: {} }) }))
    expect((await runs(ada, 'untitled')).find((r) => r.id === free.id)!.entityTitle ?? null).toBeNull()
    // A blueprint only one person sees: the title of its entity reaches them and nobody else.
    expect((await session('/v1/blueprints/vault_item', { method: 'PUT', ...body({ title: 'Vault item', fields: {}, relations: {}, access: { grants: [{ values: ['bob@example.org'] }] } }) })).status).toBe(200)
    await machine('/v1/ingest/entities/vault_item/one', { method: 'PUT', ...body({ title: 'Sealed ledger' }) })
    await hooked('open_vault', { blueprint: 'vault_item' })
    const sealed = await json<ActionRun>(await bob('/v1/actions/open_vault/run', { method: 'POST', ...body({ entity: { blueprint: 'vault_item', key: 'one' }, inputs: {} }) }))
    expect((await runs(bob, 'open_vault')).find((r) => r.id === sealed.id)!.entityTitle).toBe('Sealed ledger')
    expect(JSON.stringify(await runs(ada, 'open_vault'))).not.toContain('Sealed ledger')
    expect(JSON.stringify((await json<{ runs: ActionRun[] }>(await ada('/v1/action-runs'))).runs)).not.toContain('Sealed ledger')
  })
})

describe('runner jobs', () => {
  it('queues the run, hands it to the runner rendered, and takes its report', async () => {
    await session('/v1/actions/restart', { method: 'PUT', ...body({ title: 'Restart', blueprint: 'k8s_workload', inputs: { why: { type: 'string' } }, backend: { type: 'runner', runner: 'lan-runner', command: ['kubectl', 'rollout', 'restart', 'deployment/{{ entity.fields.name }}'], env: { NAMESPACE: '{{ entity.relations.namespace }}', WHY: '{{ inputs.why }}' }, timeout: '5m' } }) })
    const r = await json<ActionRun>(await session('/v1/actions/restart/run', { method: 'POST', ...body({ entity: { blueprint: 'k8s_workload', key: 'home/orrery/orrery' }, inputs: { why: 'stuck' } }) }))
    expect(r.state).toBe('queued')
    expect((await machine('/v1/ingest/runner/jobs', {}, pusher)).status).toBe(403)
    const claimed = await json<{ jobs: RunnerJob[] }>(await machine('/v1/ingest/runner/jobs', {}, runner))
    expect(claimed.jobs).toEqual([{ run: r.id, action: 'restart', command: ['kubectl', 'rollout', 'restart', 'deployment/orrery'], env: { NAMESPACE: 'k8s_namespace:home/orrery', WHY: 'stuck' }, timeoutMs: 300_000 }])
    expect((await json<{ jobs: RunnerJob[] }>(await machine('/v1/ingest/runner/jobs', {}, runner))).jobs).toEqual([])
    const running = await json<ActionRun>(await session(`/v1/action-runs/${r.id}`))
    expect(running.state).toBe('running')
    expect(running.claimedBy).toBe('lan-runner')
    const other = (await hub.sources.save('other-runner', { title: 'other', class: 'runner', blueprints: [], deleteGrant: [], cadence: null }), (await hub.sources.issueToken('source', 'o', { source: 'other-runner' })).token)
    expect((await machine(`/v1/ingest/runner/jobs/${r.id}/report`, { method: 'POST', ...body({ log: ['x'] }) }, other)).status).toBe(403)
    const done = await json<ActionRun>(await machine(`/v1/ingest/runner/jobs/${r.id}/report`, { method: 'POST', ...body({ state: 'succeeded', log: ['::step:: Restart', 'deployment.apps/orrery restarted', '::step:: Verify', '::output:: ready=1/1', 'exit 0'] }) }, runner))
    expect(done.state).toBe('succeeded')
    expect(done.log.map((l) => l.message)).toEqual(['requested by local@example.org', 'queued for runner lan-runner', 'claimed by runner lan-runner', 'deployment.apps/orrery restarted', 'exit 0', 'succeeded'])
    expect(done.log.map((l) => l.step ?? null)).toEqual([null, null, null, 'Restart', 'Verify', null])
    expect(done.steps.map((s) => s.name)).toEqual(['Restart', 'Verify'])
    expect(done.outputs).toEqual({ ready: '1/1' })
    const finished = (await json<{ changes: Change[] }>(await session('/v1/changes?kind=action.finished'))).changes
    expect(finished[0]).toMatchObject({ actorKind: 'source', source: 'lan-runner', detail: { run: r.id } })
  })
  it('gives a list one argument per item', async () => {
    await session('/v1/actions/restart_many', { method: 'PUT', ...body({ title: 'Restart many', inputs: { workloads: { type: 'entity', blueprint: 'k8s_workload', many: true }, none: { type: 'entity', blueprint: 'k8s_workload', many: true } }, backend: { type: 'runner', runner: 'lan-runner', command: ['restart', '--note', 'n {{ inputs.workloads.key }}', '{{ inputs.none.key }}', '{{ inputs.workloads.key }}'] } }) })
    const r = await json<ActionRun>(await session('/v1/actions/restart_many/run', { method: 'POST', ...body({ inputs: { workloads: ['k8s_workload:home/orrery/orrery', 'k8s_workload:home/shop/storefront'], none: [] } }) }))
    const claimed = await json<{ jobs: RunnerJob[] }>(await machine('/v1/ingest/runner/jobs', {}, runner))
    expect(claimed.jobs.find((j) => j.run === r.id)?.command).toEqual(['restart', '--note', 'n ["home/orrery/orrery","home/shop/storefront"]', 'home/orrery/orrery', 'home/shop/storefront'])
    await machine(`/v1/ingest/runner/jobs/${r.id}/report`, { method: 'POST', ...body({ state: 'succeeded' }) }, runner)
    await session('/v1/actions/restart_many', { method: 'DELETE' })
  })
  it('gives up on a run nobody reports on', async () => {
    const r = await json<ActionRun>(await session('/v1/actions/restart/run', { method: 'POST', ...body({ entity: { blueprint: 'k8s_workload', key: 'home/orrery/orrery' }, inputs: {} }) }))
    await machine('/v1/ingest/runner/jobs', {}, runner)
    await hub.db.query(`UPDATE action_runs SET started_at = now() - interval '2 hours' WHERE id = $1`, [r.id])
    expect(await hub.actions.expire()).toBe(1)
    const gone = await json<ActionRun>(await session(`/v1/action-runs/${r.id}`))
    expect(gone.state).toBe('unknown')
    expect(gone.log.at(-1)!.message).toMatch(/^no result after 7 minutes; given up\. It was handed on, so it may have done its work/)
  })
})

describe('a github workflow run', () => {
  const start = async () => {
    await session('/v1/actions/gh_watch', { method: 'PUT', ...body({ title: 'gh', inputs: {}, backend: { type: 'github_workflow', owner: 'o', repo: 'r', workflow: 'w.yml', inputs: { run: '{{ run.id }}' }, secretRef: 'hook_token' } }) })
    return json<ActionRun>(await session('/v1/actions/gh_watch/run', { method: 'POST', ...body({ inputs: {} }) }))
  }
  it('asks GitHub for the run it starts and links to it', async () => {
    ghDispatch = 200
    dispatches = []
    const r = await start()
    expect(dispatches[0]).toEqual({ ref: 'main', inputs: { run: r.id }, return_run_details: true })
    expect(r.state).toBe('running')
    expect(r.link).toBe('https://github.com/o/r/actions/runs/42')
    expect(r.log.at(-1)!.message).toBe('workflow w.yml started run 42')
  })
  it('leaves a run GitHub is still working on, and fails one whose job never started, with why', async () => {
    ghDispatch = 200
    const r = await start()
    ghRun = { status: 'queued', conclusion: null }
    await hub.actions.watch()
    expect((await json<ActionRun>(await session(`/v1/action-runs/${r.id}`))).state).toBe('running')
    ghRun = { status: 'completed', conclusion: 'failure' }
    expect(await hub.actions.watch()).toBeGreaterThanOrEqual(1)
    const done = await json<ActionRun>(await session(`/v1/action-runs/${r.id}`))
    expect(done.state).toBe('failed')
    expect(done.finishedAt).not.toBeNull()
    expect(done.log.slice(-2).map((l) => l.message)).toEqual(['workflow run ended failure without reporting', 'job upgrade: The job was not started because recent account payments have failed'])
  })
  it('keeps a long workflow GitHub says is still going, and gives up one GitHub can no longer be asked about', async () => {
    ghDispatch = 200
    const r = await start()
    ghRun = { status: 'in_progress', conclusion: null }
    await hub.db.query(`UPDATE action_runs SET started_at = now() - interval '5 hours', heard_at = now() - interval '2 hours' WHERE id = $1`, [r.id])
    await hub.actions.watch()
    expect(await hub.actions.expire()).toBe(0)
    expect((await json<ActionRun>(await session(`/v1/action-runs/${r.id}`))).state).toBe('running')
    // Nothing watched it for the hub's time: it is silent, and given up.
    await hub.db.query(`UPDATE action_runs SET heard_at = now() - interval '2 hours' WHERE id = $1`, [r.id])
    expect(await hub.actions.expire()).toBe(1)
    expect((await json<ActionRun>(await session(`/v1/action-runs/${r.id}`))).log.at(-1)!.message).toMatch(/^not heard from for 60 minutes; given up/)
  })
  it('leaves a run its workflow reported on alone', async () => {
    ghDispatch = 200
    const r = await start()
    await machine(`/v1/action-runs/${r.id}/report`, { method: 'POST', ...body({ state: 'succeeded', summary: 'set' }) }, reporter)
    ghRun = { status: 'completed', conclusion: 'success' }
    await hub.actions.watch()
    const done = await json<ActionRun>(await session(`/v1/action-runs/${r.id}`))
    expect(done.state).toBe('succeeded')
    expect(done.log.at(-1)!.message).toBe('succeeded: set')
  })
  it('falls back to waiting for a report when GitHub names no run', async () => {
    ghDispatch = 204
    const r = await start()
    expect(r.state).toBe('running')
    expect(r.link).toBe('https://github.com/o/r/actions/workflows/w.yml')
    expect(r.log.at(-1)!.message).toBe('workflow w.yml accepted (204)')
    ghRun = { status: 'completed', conclusion: 'failure' }
    await hub.actions.watch()
    expect((await json<ActionRun>(await session(`/v1/action-runs/${r.id}`))).state).toBe('running')
  })
})

describe('actions in a catalog', () => {
  it('loads them from git, locks them, and removes them when the file stops declaring them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orrery-actions-'))
    const source = await hub.sources.save('ops-catalog', { title: 'Ops', class: 'git', blueprints: ['*'], deleteGrant: ['*'], cadence: null, git: { url: 'https://example.org/ops.git', branch: 'main', glob: '**/*.yaml' } })
    writeFileSync(join(dir, 'actions.yaml'), `actions:\n  - id: from_git\n    title: From git\n    blueprint: k8s_workload\n    inputs: {}\n    backend: { type: webhook, url: ${hookUrl}/git }\n`)
    const report = await applyCatalog(hub, source, dir, '**/*.yaml')
    expect(report.errors).toEqual([])
    expect(report.actions).toBe(1)
    const a = await json<{ origin: { kind: string; file: string } }>(await session('/v1/actions/from_git'))
    expect(a.origin).toEqual({ kind: 'git', source: 'ops-catalog', file: 'actions.yaml' })
    expect((await session('/v1/actions/from_git', { method: 'PUT', ...body({ title: 'mine', inputs: {}, backend: { type: 'webhook', url: 'http://x' } }) })).status).toBe(409)
    expect((await session('/v1/actions/from_git', { method: 'DELETE' })).status).toBe(409)
    writeFileSync(join(dir, 'actions.yaml'), 'actions: []\n')
    await applyCatalog(hub, source, dir, '**/*.yaml')
    expect((await session('/v1/actions/from_git')).status).toBe(404)
  })
})

describe('actions over mcp', () => {
  it('lists, runs, and reads back a run', async () => {
    const rpc = async (method: string, params: Record<string, unknown>, bearer: string, id = 1) => {
      const res = await machine('/mcp', { method: 'POST', headers: { accept: 'application/json, text/event-stream' }, ...body({ jsonrpc: '2.0', id, method, params }) }, bearer)
      const text = await res.text()
      const line = text.split('\n').find((l) => l.startsWith('data:'))
      return JSON.parse(line ? line.slice(5) : text) as { result: { content: { text: string }[] } }
    }
    const content = (r: { result: { content: { text: string }[] } }) => JSON.parse(r.result.content[0]!.text) as Record<string, unknown>
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } }, reporter)
    const before = content(await rpc('tools/call', { name: 'list_actions', arguments: { blueprint: 'argocd_app' } }, reporter, 2)) as unknown as { id: string }[]
    expect(before).toEqual([])
    const notNamed = content(await rpc('tools/call', { name: 'run_action', arguments: { action: 'upgrade_app', entity: 'argocd_app:home/argocd/orrery', inputs: {} } }, viewer, 3))
    expect(notNamed.error).toContain('not open to you')
    await session('/v1/actions/upgrade_app', { method: 'PUT', ...body({ ...upgrade({ type: 'webhook', url: `${hookUrl}/deploy`, secretRef: 'hook_token' }), access: { grants: [{ values: ['workflow'] }] } }) })
    received = []
    const listed = content(await rpc('tools/call', { name: 'list_actions', arguments: { blueprint: 'argocd_app' } }, reporter, 6)) as unknown as { id: string; inputs?: unknown }[]
    expect(listed.map((a) => a.id)).toEqual(['upgrade_app'])
    // The list names each action briefly; one is read in full, with its inputs, before it is run.
    expect(listed[0]!.inputs).toBeUndefined()
    const full = content(await rpc('tools/call', { name: 'list_actions', arguments: { action: 'upgrade_app' } }, reporter, 7)) as unknown as { inputs: Record<string, unknown> }
    expect(Object.keys(full.inputs)).toEqual(['workload', 'image', 'tag', 'notify'])
    const ran = content(await rpc('tools/call', { name: 'run_action', arguments: { action: 'upgrade_app', entity: 'argocd_app:home/argocd/orrery', inputs: { workload: 'k8s_workload:home/orrery/orrery', image: 'registry.example.org/orrery:0.9.12', tag: '0.9.14' } } }, reporter, 4))
    expect(ran.state).toBe('running')
    expect((received[0]!.body as { by: { name: string } }).by.name).toBe('workflow')
    const back = content(await rpc('tools/call', { name: 'get_action_run', arguments: { id: ran.run } }, reporter, 5))
    expect(back.entity).toBe('argocd_app:home/argocd/orrery')
    expect(back.state).toBe('running')
  })
})

describe('who may run an action on which entity', () => {
  type Targets = { entities: { id: string }[]; approval: string[] }
  const restart = {
    title: 'Restart a service',
    blueprint: ['svc_app', 'svc_vm'],
    inputs: { environment: { type: 'entity', blueprint: 'env', narrows: 'env', required: true } },
    access: {
      rules: [
        { owns: ['developer'] },
        { owns: ['qa'], where: { relation: 'env', target: 'env:test' } },
        { owns: ['qa'], where: { relation: 'env', target: 'env:prod' }, approval: true },
      ],
    },
  }
  const targets = async (who: (p: string, i?: RequestInit) => Promise<Response>, narrow?: Record<string, string>) => {
    const t = await json<Targets>(await who(`/v1/actions/restart/targets${narrow ? `?narrow=${encodeURIComponent(JSON.stringify(narrow))}` : ''}`))
    return { ids: t.entities.map((e) => e.id).sort(), approval: t.approval.sort() }
  }
  const run = (who: (p: string, i?: RequestInit) => Promise<Response>, blueprint: string, key: string, inputs: Record<string, unknown> = {}) => who('/v1/actions/restart/run', { method: 'POST', ...body({ entity: { blueprint, key }, inputs }) })

  beforeAll(async () => {
    const save = (id: string, spec: Record<string, unknown>) => session(`/v1/blueprints/${id}`, { method: 'PUT', ...body(spec) })
    expect((await save('env', { title: 'Environment', fields: {}, relations: {} })).status).toBe(200)
    expect((await save('program', { title: 'Program', fields: {}, relations: { dev_team: { target: 'crew' }, qa_team: { target: 'crew' } } })).status).toBe(200)
    expect((await save('svc_app', { title: 'App service', fields: { azure_id: { type: 'string', overridable: false } }, relations: { program: { target: 'program' }, env: { target: 'env' } } })).status).toBe(200)
    expect((await save('svc_vm', { title: 'Virtual machine', fields: {}, relations: { program: { target: 'program' }, env: { target: 'env' } } })).status).toBe(200)
    const owns = [
      { as: 'developer', path: 'crews.<-program:dev_team.<-svc_app:program' },
      { as: 'developer', path: 'crews.<-program:dev_team.<-svc_vm:program' },
      { as: 'qa', path: 'crews.<-program:qa_team.<-svc_app:program' },
    ]
    expect((await session('/v1/access/person', { method: 'PUT', ...body({ blueprint: 'crew_member', field: 'email', owns }) })).status).toBe(200)
    for (const env of ['test', 'prod']) await machine(`/v1/ingest/entities/env/${env}`, { method: 'PUT', ...body({ title: env }) })
    // Ada's crew builds Ember; Bob's crew tests it, and builds Delta.
    await machine('/v1/ingest/entities/program/ember', { method: 'PUT', ...body({ title: 'Ember', relations: { dev_team: 'platform', qa_team: 'web' } }) })
    await machine('/v1/ingest/entities/program/delta', { method: 'PUT', ...body({ title: 'Delta', relations: { dev_team: 'web' } }) })
    const app = (key: string, program: string | null, env: string) => machine(`/v1/ingest/entities/svc_app/${key}`, { method: 'PUT', ...body({ title: key, fields: { azure_id: `/sites/${key}` }, relations: { ...(program ? { program } : {}), env } }) })
    await app('ember-api-prod', 'ember', 'prod')
    await app('ember-api-test', 'ember', 'test')
    await app('delta-api-prod', 'delta', 'prod')
    await machine('/v1/ingest/entities/svc_vm/ember-jump', { method: 'PUT', ...body({ title: 'ember-jump', relations: { program: 'ember', env: 'prod' } }) })
    await machine('/v1/ingest/entities/svc_vm/dc01', { method: 'PUT', ...body({ title: 'dc01', relations: { env: 'prod' } }) })
    expect((await session('/v1/actions/restart', { method: 'PUT', ...body({ ...restart, backend: { type: 'webhook', url: `${hookUrl}/restart` } }) })).status).toBe(200)
  })

  it('offers each person only what they are to it, and holds production for approval', async () => {
    expect(await targets(ada)).toEqual({ ids: ['svc_app:ember-api-prod', 'svc_app:ember-api-test', 'svc_vm:ember-jump'], approval: [] })
    // Bob builds Delta and tests Ember, so he restarts Delta anywhere, Ember in test, and Ember in production only once approved. Nobody's program owns the domain controller.
    expect(await targets(bob)).toEqual({ ids: ['svc_app:delta-api-prod', 'svc_app:ember-api-prod', 'svc_app:ember-api-test'], approval: ['svc_app:ember-api-prod'] })
    expect((await targets(ada, { environment: 'env:test' })).ids).toEqual(['svc_app:ember-api-test'])
    expect((await targets(session)).ids).toEqual(['svc_app:delta-api-prod', 'svc_app:ember-api-prod', 'svc_app:ember-api-test', 'svc_vm:dc01', 'svc_vm:ember-jump'])
    expect((await targets(cy)).ids).toEqual([])
  })

  it('offers an action whose rules ask what a person owns only to someone who owns something it runs on', async () => {
    const runs = async (who: (p: string, i?: RequestInit) => Promise<Response>) => {
      const listed = await json<{ id: string; canRun: boolean }[] | { actions: { id: string; canRun: boolean }[] }>(await who('/v1/actions'))
      return (Array.isArray(listed) ? listed : listed.actions).find((a) => a.id === 'restart')?.canRun ?? false
    }
    expect(await runs(ada)).toBe(true)
    expect(await runs(bob)).toBe(true)
    // Cy signs in but owns nothing the action runs on: no rule names a team, and owning is what each asks.
    expect(await runs(cy)).toBe(false)
  })

  it('answers one page of the pick, searched by the hub, the same as the whole list cut', async () => {
    type Page = Targets & { total: number }
    const page = async (who: (p: string, i?: RequestInit) => Promise<Response>, action: string, query: string) => {
      const t = await json<Page>(await who(`/v1/actions/${action}/targets?${query}`))
      return { ids: t.entities.map((e) => e.id), approval: t.approval.sort(), total: t.total }
    }
    // Owning decides what Bob may run it on, so the page is cut from his whole list.
    expect(await page(bob, 'restart', 'q=ember-api')).toEqual({ ids: ['svc_app:ember-api-prod', 'svc_app:ember-api-test'], approval: ['svc_app:ember-api-prod'], total: 2 })
    expect(await page(bob, 'restart', 'of=svc_app:ember-api-prod')).toEqual({ ids: ['svc_app:ember-api-prod'], approval: ['svc_app:ember-api-prod'], total: 1 })
    expect(await page(bob, 'restart', 'of=svc_vm:ember-jump')).toEqual({ ids: [], approval: [], total: 0 })
    // Rules that name teams and filters are asked of the database: a page, a search, one by id, and approval where each rule says.
    const byTeam = {
      ...restart,
      access: {
        rules: [
          { grants: [{ path: 'crews', values: ['web'] }], where: { relation: 'env', target: 'env:test' } },
          { grants: [{ path: 'crews', values: ['web'] }], where: { relation: 'env', target: 'env:prod' }, approval: true },
        ],
      },
      backend: { type: 'webhook', url: `${hookUrl}/restart` },
    }
    expect((await session('/v1/actions/restart_by_team', { method: 'PUT', ...body(byTeam) })).status).toBe(200)
    const all = await json<Targets>(await bob('/v1/actions/restart_by_team/targets'))
    expect(all.entities.map((e) => e.id).sort()).toEqual(['svc_app:delta-api-prod', 'svc_app:ember-api-prod', 'svc_app:ember-api-test', 'svc_vm:dc01', 'svc_vm:ember-jump'])
    const first = await page(bob, 'restart_by_team', 'limit=2')
    expect(first.ids).toEqual(['svc_vm:dc01', 'svc_app:delta-api-prod'])
    expect(first.total).toBe(5)
    expect(first.approval).toEqual(['svc_app:delta-api-prod', 'svc_vm:dc01'])
    expect(await page(bob, 'restart_by_team', 'q=test')).toEqual({ ids: ['svc_app:ember-api-test'], approval: [], total: 1 })
    expect(await page(bob, 'restart_by_team', `q=jump&narrow=${encodeURIComponent(JSON.stringify({ environment: 'env:prod' }))}`)).toEqual({ ids: ['svc_vm:ember-jump'], approval: ['svc_vm:ember-jump'], total: 1 })
    expect(await page(bob, 'restart_by_team', 'of=svc_vm:dc01')).toEqual({ ids: ['svc_vm:dc01'], approval: ['svc_vm:dc01'], total: 1 })
    expect(await page(ada, 'restart_by_team', 'q=ember')).toEqual({ ids: [], approval: [], total: 0 })
    expect((await session('/v1/actions/restart_by_team', { method: 'DELETE' })).status).toBeLessThan(300)
  })

  it('refuses a run on what no rule takes, the same way as one on nothing, and records it', async () => {
    const r = await run(bob, 'svc_vm', 'ember-jump')
    expect(r.status).toBe(400)
    expect((await json(r)).error).toMatch(/does not exist, or the action does not apply to it/)
    const refused = (await json<{ changes: Change[] }>(await session('/v1/changes?kind=access.refused&actor=bob'))).changes
    expect(refused[0]).toMatchObject({ actor: 'bob@example.org', detail: { action: 'restart', reason: 'no rule lets them run it on this' } })
  })

  it('fills the narrowing input from the target, refuses one that disagrees, and waits where a rule says', async () => {
    const asked = await json<ActionRun>(await run(bob, 'svc_app', 'ember-api-test'))
    expect(asked).toMatchObject({ state: 'running', inputs: { environment: 'env:test' } })
    expect((await run(bob, 'svc_app', 'ember-api-test', { environment: 'env:prod' })).status).toBe(400)
    expect((await json<ActionRun>(await run(bob, 'svc_app', 'ember-api-prod'))).state).toBe('awaiting')
  })

  it('is approved by someone a rule lets run it there without approval, and by nobody else', async () => {
    const asked = await json<ActionRun>(await run(bob, 'svc_app', 'ember-api-prod'))
    expect(asked.state).toBe('awaiting')
    const awaiting = async (who: (p: string, i?: RequestInit) => Promise<Response>) => (await json<{ runs: ActionRun[] }>(await who('/v1/action-runs?state=awaiting'))).runs.find((r) => r.id === asked.id)
    // Ada builds Ember, so she restarts it herself and vouches for Bob. Bob may not approve his own; Cy owns nothing.
    expect((await awaiting(ada))?.canDecide).toBe(true)
    expect((await awaiting(bob))?.canDecide).toBe(false)
    expect((await awaiting(cy))?.canDecide).toBe(false)
    expect((await bob(`/v1/action-runs/${asked.id}/approve`, { method: 'POST' })).status).toBe(403)
    expect((await cy(`/v1/action-runs/${asked.id}/approve`, { method: 'POST' })).status).toBe(403)
    expect((await cy(`/v1/action-runs/${asked.id}/decline`, { method: 'POST' })).status).toBe(403)
    const approved = await json<ActionRun>(await ada(`/v1/action-runs/${asked.id}/approve`, { method: 'POST' }))
    expect(approved).toMatchObject({ state: 'running', decidedBy: 'ada@example.org' })
  })

  it('tells dispatch what came of a run, as events about what it ran on', async () => {
    const sent: { url: string; auth: string; body: NoticeEvent }[] = []
    const declared: { method: string; auth: string; kinds: { kind: string; weight: string }[] }[] = []
    const dispatch: typeof fetch = async (url, init) => {
      if (String(url) === 'http://dispatch.test/v1/kinds') {
        declared.push({ method: String(init?.method), auth: String((init?.headers as Record<string, string>).authorization), kinds: (JSON.parse(String(init?.body)) as { kinds: { kind: string; weight: string }[] }).kinds })
        return new Response(JSON.stringify({ kinds: 7 }), { status: 200 })
      }
      sent.push({ url: String(url), auth: String((init?.headers as Record<string, string>).authorization), body: JSON.parse(String(init?.body)) as NoticeEvent })
      return new Response(JSON.stringify({ queued: 1, repeat: false }), { status: 202 })
    }
    const notices = new NoticeForwarder({ db: hub.db, actions: hub.actions, batches: hub.batches, sets: hub.changeSets, schedules: hub.schedules, people: () => hub.people(), reader: hub.reader, blueprints: hub.blueprints, log: createLogger('notices-test') }, { url: 'http://dispatch.test/', token: 'tok', publicUrl: 'https://orrery.example.org/', remindHours: 0 }, dispatch)
    await notices.pass()
    expect(sent.every((s) => s.url === 'http://dispatch.test/v1/events' && s.auth === 'Bearer tok')).toBe(true)
    // It declares every kind it sends, once, so people can choose how they hear of each.
    expect(declared).toHaveLength(1)
    expect(declared[0]).toMatchObject({ method: 'PUT', auth: 'Bearer tok' })
    const names = declared[0]!.kinds.map((k) => k.kind)
    expect(sent.every((s) => names.includes(s.body.kind))).toBe(true)
    expect(declared[0]!.kinds.find((k) => k.kind === 'action.awaiting_approval')?.weight).toBe('notify')
    // Every event carries its kind's declared weight: what worked only lands in a list, what failed reaches people.
    const weights = new Map(declared[0]!.kinds.map((k) => [k.kind, k.weight]))
    expect(sent.every((s) => s.body.weight === weights.get(s.body.kind))).toBe(true)
    expect([weights.get('action.succeeded'), weights.get('action.failed'), weights.get('action.batch_succeeded'), weights.get('action.batch_failed')]).toEqual(['notice', 'notify', 'notice', 'notify'])
    const restarts = sent.map((s) => s.body).filter((e) => e.labels.action === 'restart')
    const waiting = restarts.find((e) => e.kind === 'action.awaiting_approval')!
    expect(waiting).toMatchObject({
      title: 'Restart a service on ember-api-prod waits for approval',
      entity: { blueprint: 'svc_app', key: 'ember-api-prod', title: 'ember-api-prod' },
      labels: { action: 'restart', blueprint: 'svc_app', environment: 'env:prod' },
    })
    expect(waiting.facts).toEqual(expect.arrayContaining([{ name: 'Action', value: 'Restart a service' }, { name: 'App service', value: 'ember-api-prod' }, { name: 'Asked by', value: 'bob@example.org' }, { name: 'environment', value: 'prod' }]))
    expect(waiting.links[0]!.url).toMatch(/^https:\/\/orrery\.example\.org\/actions\/runs\/[0-9a-f]+$/)
    const runId = waiting.links[0]!.url.split('/').pop()
    expect(waiting.actions).toEqual([
      { title: 'Approve', path: `/v1/action-runs/${runId}/approve`, style: 'positive', done: 'approved' },
      { title: 'Decline', path: `/v1/action-runs/${runId}/decline`, style: 'destructive', done: 'declined' },
    ])
    expect(sent.filter((s) => s.body.kind !== 'action.awaiting_approval').every((s) => s.body.actions === undefined)).toBe(true)
    const approval = restarts.find((e) => e.kind === 'action.approved')!
    expect(approval.title).toBe('ada@example.org approved Restart a service on ember-api-prod')
    expect(approval.facts).toContainEqual({ name: 'Decided by', value: 'ada@example.org' })
    // A run that ended with outputs tells them beside what was asked.
    const ended = sent.map((s) => s.body).find((e) => e.kind === 'action.succeeded' && e.text === 'orrery is at 0.9.15')!
    expect(ended.facts).toEqual(expect.arrayContaining([{ name: 'commit', value: 'def456' }, { name: 'healthy', value: 'yes' }]))
    // A run nobody had to approve is told as asked for. The rows have not settled, so the mark stays below them,
    // yet a second pass tells none of them again; a hub that takes the lead tells them once more, as the same keys.
    expect(sent.some((s) => s.body.kind === 'action.requested' && s.body.title === 'bob@example.org ran Restart a service on ember-api-test')).toBe(true)
    const keys = sent.map((s) => s.body.key)
    sent.length = 0
    await notices.pass()
    expect(sent).toEqual([])
    expect(declared).toHaveLength(1)
    const leader = new NoticeForwarder({ db: hub.db, actions: hub.actions, batches: hub.batches, sets: hub.changeSets, schedules: hub.schedules, people: () => hub.people(), reader: hub.reader, blueprints: hub.blueprints, log: createLogger('notices-test') }, { url: 'http://dispatch.test/', token: 'tok', publicUrl: 'https://orrery.example.org/', remindHours: 0 }, dispatch)
    await leader.pass()
    // It tells again only what is above the settled mark, and on a slow machine some rows settled meanwhile: never a key that is new, never one twice.
    const again = sent.map((s) => s.body.key)
    expect(again.length).toBeGreaterThan(0)
    expect(new Set(again).size).toBe(again.length)
    expect(again.every((k) => keys.includes(k))).toBe(true)
  })

  it('marks the rows and the entity page with what the reader may run there', async () => {
    const rows = await json<{ entities: { key: string; actions?: string[] }[] }>(await bob('/v1/entities?blueprint=svc_app&distribution=true'))
    expect(Object.fromEntries(rows.entities.map((e) => [e.key, e.actions]))).toEqual({ 'delta-api-prod': ['restart'], 'ember-api-prod': ['restart'], 'ember-api-test': ['restart'] })
    expect((await json<{ actions: string[] }>(await bob('/v1/entities/svc_app/ember-api-test'))).actions).toEqual(['restart'])
    expect((await json<{ actions: string[] }>(await cy('/v1/entities/svc_app/ember-api-prod'))).actions ?? []).toEqual([])
  })

  it('marks each block of rows on its own the same as the whole list says', async () => {
    for (const who of [ada, bob, cy, session]) {
      const whole = (await targets(who)).ids
      const marked: string[] = []
      for (const blueprint of ['svc_app', 'svc_vm']) {
        for (let offset = 0; ; offset++) {
          const block = await json<{ entities: { id: string; actions?: string[] }[] }>(await who(`/v1/entities?blueprint=${blueprint}&distribution=later&sort=title&limit=1&offset=${offset}`))
          if (!block.entities.length) break
          for (const e of block.entities) if (e.actions?.includes('restart')) marked.push(e.id)
        }
      }
      expect(marked.sort()).toEqual(whole)
    }
  })

  it('guards what the rules read, so only an admin or a holder of access.values changes it by hand', async () => {
    const admin = { admin: true, permissions: [] as never[], kind: 'user' as const, name: 'local', roles: [] }
    await hub.access.saveRole('editor', { title: 'Editor', permissions: ['entities.edit'] }, admin)
    await hub.access.saveRole('security', { title: 'Security contributor', permissions: ['entities.edit', 'access.values'] }, admin)
    await hub.access.setRoles('bob@example.org', ['editor'], admin)
    const decides = (await json<{ decides?: { names: string[] } }>(await session('/v1/blueprints/svc_app'))).decides
    expect(decides?.names).toEqual(expect.arrayContaining(['env', 'program']))
    expect((await json<{ decides?: { names: string[] } }>(await session('/v1/blueprints/program'))).decides?.names).toEqual(expect.arrayContaining(['dev_team', 'qa_team']))
    const patch = (who: (p: string, i?: RequestInit) => Promise<Response>, path: string, change: Record<string, unknown>) => who(path, { method: 'PATCH', ...body(change) })
    // Moving production into test would let QA restart it; making his crew Ember's builders would let him restart all of it.
    expect((await patch(bob, '/v1/entities/svc_app/ember-api-prod', { relations: { env: 'test' } })).status).toBe(403)
    expect((await patch(bob, '/v1/entities/program/ember', { relations: { dev_team: 'web' } })).status).toBe(403)
    expect((await patch(bob, '/v1/entities/svc_app/ember-api-prod', { fields: { title: 'Ember API' } })).status).toBe(200)
    // The resource id the backend acts on is locked to its source, for everyone.
    expect((await patch(session, '/v1/entities/svc_app/ember-api-prod', { fields: { azure_id: '/sites/other' } })).status).toBe(403)
    await hub.access.setRoles('bob@example.org', ['security'], admin)
    expect((await patch(bob, '/v1/entities/svc_app/ember-api-prod', { relations: { env: 'test' } })).status).toBe(200)
    const handmade = (await json<PostureResponse>(await session('/v1/posture'))).handmade
    expect(handmade).toContainEqual(expect.objectContaining({ entity: { blueprint: 'svc_app', key: 'ember-api-prod' }, name: 'env', kind: 'relation', over: true, by: 'bob@example.org' }))
    expect((await patch(bob, '/v1/entities/svc_app/ember-api-prod', { relations: { env: null } })).status).toBe(200)
    expect((await json<PostureResponse>(await session('/v1/posture'))).handmade.some((h) => h.entity.key === 'ember-api-prod')).toBe(false)
    await hub.access.setRoles('bob@example.org', [], admin)
  })

  it('refuses a definition whose rules or narrowing cannot hold', async () => {
    const put = (spec: Record<string, unknown>) => session('/v1/actions/broken', { method: 'PUT', ...body({ title: 'Broken', inputs: {}, backend: { type: 'webhook', url: `${hookUrl}/x` }, ...spec }) })
    expect((await put({ access: { rules: [{ owns: true }] } })).status).toBe(400)
    expect((await put({ blueprint: 'svc_app', access: { rules: [{}] } })).status).toBe(400)
    expect((await put({ blueprint: ['svc_app', 'svc_vm'], inputs: { environment: { type: 'entity', blueprint: 'crew', narrows: 'env' } } })).status).toBe(400)
    expect((await put({ blueprint: 'svc_app', inputs: { environment: { type: 'entity', blueprint: 'env', narrows: 'nowhere' } } })).status).toBe(400)
    expect((await put({ blueprint: 'svc_app', access: { rules: [{ audiences: ['no_such_audience'] }] } })).status).toBe(400)
  })
})

describe('an action with a home', () => {
  const hooked = (id: string, extra: Record<string, unknown> = {}, who = session) => who(`/v1/actions/${id}`, { method: 'PUT', ...body({ title: `Action ${id}`, inputs: {}, backend: { type: 'webhook', url: `${hookUrl}/home` }, ...extra }) })
  const listed = async (who: (p: string, i?: RequestInit) => Promise<Response>, id: string) => (await json<{ actions: ActionView[] }>(await who('/v1/actions'))).actions.find((a) => a.id === id)
  const run = (who: (p: string, i?: RequestInit) => Promise<Response>, id: string) => who(`/v1/actions/${id}/run`, { method: 'POST', ...body({ inputs: {} }) })
  const dee = as('dee@example.org')
  const before = [
    { as: 'developer', path: 'crews.<-program:dev_team.<-svc_app:program' },
    { as: 'developer', path: 'crews.<-program:dev_team.<-svc_vm:program' },
    { as: 'qa', path: 'crews.<-program:qa_team.<-svc_app:program' },
  ]
  const owns = [...before, { as: 'lead', path: 'crews.<-squad:lead_crew' }, { as: 'member', path: 'crews.<-squad:member_crew' }]
  const person = (paths: unknown[]) => session('/v1/access/person', { method: 'PUT', ...body({ blueprint: 'crew_member', field: 'email', ...(paths.length ? { owns: paths } : {}) }) })
  const squad = (key: string, title: string, relations: Record<string, string>) => machine(`/v1/ingest/entities/squad/${key}`, { method: 'PUT', ...body({ title, relations }) })

  beforeAll(async () => {
    expect((await session('/v1/blueprints/squad', { method: 'PUT', ...body({ title: 'Squad', icon: 'team', fields: {}, relations: { lead_crew: { target: 'crew' }, member_crew: { target: 'crew' } } }) })).status).toBe(200)
    // Ada's crew leads Core, and Bob's crew is a member of it. Bob's crew leads Edge. Cy and Dee are no person the estate holds.
    expect((await squad('core', 'Core', { lead_crew: 'platform', member_crew: 'web' })).status).toBeLessThan(300)
    expect((await squad('edge', 'Edge', { lead_crew: 'web' })).status).toBeLessThan(300)
  })

  it('checks that a home is an entity id of a blueprint the model holds, and that access by home has one', () => {
    const spec = (extra: Record<string, unknown>) => ({ id: 'x', title: 'X', inputs: {}, backend: { type: 'caller' }, ...extra })
    const blueprints = [{ id: 'squad', fields: {}, relations: {} }]
    const messages = (extra: Record<string, unknown>) => checkAction(spec(extra), blueprints).issues.map((i) => `${i.path.join('.')}: ${i.message}`)
    expect(messages({ home: 'squad' })).toEqual(['home: a home is an entity id, as blueprint:key'])
    expect(messages({ home: 'nope:core' })).toEqual(['home: home: unknown blueprint "nope"'])
    expect(messages({ access: { home: true } })).toEqual(['access.home: access: home opens the action to the people who own its home, so the action needs a home'])
    expect(messages({ home: 'squad:core', access: { home: [] } })).toHaveLength(1)
    // The entity itself need not exist yet, and the roles are names like a rule's.
    expect(messages({ home: 'squad:not-yet', access: { home: ['lead'] } })).toEqual([])
    expect(checkAction(spec({ home: 'nope:core' })).issues).toEqual([])
  })

  it('guards the path a home\'s people are read through, once an action asks for it', async () => {
    expect((await person(owns)).status).toBe(200)
    const decides = async () => (await json<{ decides?: { names: string[] } }>(await session('/v1/blueprints/squad'))).decides?.names ?? []
    expect(await decides()).toEqual([])
    expect((await hooked('core_tool', { home: 'squad:core', access: { home: ['lead'] } })).status).toBe(200)
    expect(await decides()).toEqual(['lead_crew'])
    const admin = { admin: true, permissions: [] as never[], kind: 'user' as const, name: 'local', roles: [] }
    await hub.access.setRoles('bob@example.org', ['editor'], admin)
    // Making his own crew the lead of Core would let Bob run what is open to its leads.
    const patch = (relations: Record<string, unknown>) => bob('/v1/entities/squad/core', { method: 'PATCH', ...body({ relations }) })
    expect((await patch({ lead_crew: 'web' })).status).toBe(403)
    expect((await patch({ member_crew: 'platform' })).status).toBe(200)
    await squad('core', 'Core', { lead_crew: 'platform', member_crew: 'web' })
    expect((await patch({ member_crew: null })).status).toBe(200)
    await hub.access.setRoles('bob@example.org', [], admin)
    // Open to the home's people in any way, every path that reaches a squad is read.
    expect((await hooked('core_tool', { home: 'squad:core', access: { home: true } })).status).toBe(200)
    expect((await decides()).sort()).toEqual(['lead_crew', 'member_crew'])
  })

  it('lets in whoever owns the home, by any path or by a named role, and nobody else', async () => {
    // Open to anyone who owns Core: Ada leads it and Bob is a member.
    expect((await listed(ada, 'core_tool'))?.canRun).toBe(true)
    expect((await listed(bob, 'core_tool'))?.canRun).toBe(true)
    expect(await listed(dee, 'core_tool')).toBeUndefined()
    // Cy writes actions, so the list shows it, but owns nothing.
    expect((await listed(cy, 'core_tool'))?.canRun).toBe(false)
    expect((await listed(session, 'core_tool'))?.canRun).toBe(true)
    expect((await json<ActionRun>(await run(bob, 'core_tool'))).state).toBe('running')
    // Open to its leads alone.
    expect((await hooked('core_tool', { home: 'squad:core', access: { home: ['lead'] } })).status).toBe(200)
    expect((await listed(ada, 'core_tool'))?.canRun).toBe(true)
    expect(await listed(bob, 'core_tool')).toBeUndefined()
    expect((await run(bob, 'core_tool')).status).toBe(403)
    expect((await run(dee, 'core_tool')).status).toBe(403)
    expect((await json<ActionRun>(await run(ada, 'core_tool'))).state).toBe('running')
    // A home alone opens nothing: it says where the action belongs.
    expect((await hooked('edge_tool', { home: 'squad:edge' })).status).toBe(200)
    expect(await listed(bob, 'edge_tool')).toBeUndefined()
  })

  it('follows what a person owns as it moves', async () => {
    expect((await squad('core', 'Core', { lead_crew: 'web', member_crew: 'web' })).status).toBeLessThan(300)
    expect(await listed(ada, 'core_tool')).toBeUndefined()
    expect((await listed(bob, 'core_tool'))?.canRun).toBe(true)
    expect((await squad('core', 'Core', { lead_crew: 'platform', member_crew: 'web' })).status).toBeLessThan(300)
    expect((await listed(ada, 'core_tool'))?.canRun).toBe(true)
    expect(await listed(bob, 'core_tool')).toBeUndefined()
  })

  it('names the blueprints what a person owns is read from, so a page knows when to read the actions again', async () => {
    const reads = async (who: (p: string, i?: RequestInit) => Promise<Response>) => (await json<ActionsResponse>(await who('/v1/actions'))).reads
    // Every blueprint an ownership path steps through, the person blueprint included.
    expect(await reads(ada)).toEqual(expect.arrayContaining(['crew', 'crew_member', 'squad', 'program']))
    expect(await reads(ada)).toEqual([...(await reads(ada))!].sort())
    // A machine owns nothing, so nothing of the estate moves its list this way.
    expect(await reads(machineAs(reporter))).toEqual([])
  })

  it('keeps a home and who it opens to an admin\'s to set', async () => {
    const saved = () => hub.actions.get('core_tool')!
    // Cy holds actions.manage: a save of the rest keeps the home, and one that moves it is refused.
    expect((await hooked('core_tool', { description: 'For Core.' }, cy)).status).toBe(200)
    expect(saved()).toMatchObject({ description: 'For Core.', home: 'squad:core', access: { home: ['lead'] } })
    expect((await hooked('core_tool', { home: 'squad:core', access: { home: ['lead'] }, description: 'Still Core.' }, cy)).status).toBe(200)
    expect((await hooked('core_tool', { home: 'squad:edge' }, cy)).status).toBe(403)
    expect((await hooked('core_tool', { home: 'squad:core', access: { home: true } }, cy)).status).toBe(403)
    expect((await hooked('cy_tool', { home: 'squad:edge' }, cy)).status).toBe(403)
    expect(saved()).toMatchObject({ home: 'squad:core', access: { home: ['lead'] } })
    // An admin takes the home off by leaving it out.
    expect((await hooked('edge_tool')).status).toBe(200)
    expect(hub.actions.get('edge_tool')!.home).toBeUndefined()
    expect((await hooked('edge_tool', { home: 'squad:edge' })).status).toBe(200)
    expect((await hooked('edge_tool', { home: 'no_such:edge' })).status).toBe(400)
  })

  it('shows the home as the reader sees it, and draws the action with the home\'s icon', async () => {
    const mine = await listed(ada, 'core_tool')
    expect(mine).toMatchObject({ home: 'squad:core', homeShown: { id: 'squad:core', entity: { blueprint: 'squad', key: 'core' }, title: 'Core', icon: 'team', yours: true }, iconShown: 'team' })
    // The admin is no person the estate holds, so Core is not theirs. Bob leads Edge.
    expect((await listed(session, 'core_tool'))?.homeShown).toMatchObject({ title: 'Core', yours: false })
    expect((await json<ActionView>(await session('/v1/actions/core_tool'))).homeShown).toMatchObject({ id: 'squad:core', yours: false })
    expect((await json<ActionView>(await ada('/v1/actions/core_tool'))).homeShown).toMatchObject({ id: 'squad:core', yours: true })
    expect((await listed(session, 'edge_tool'))?.homeShown).toMatchObject({ id: 'squad:edge', title: 'Edge', yours: false })
    // Its own icon first, then its home's, then the one blueprint it runs on.
    expect((await hooked('icon_home_own', { icon: 'wrench', home: 'squad:core', blueprint: 'argocd_app' })).status).toBe(200)
    expect((await hooked('icon_home', { home: 'squad:core', blueprint: 'argocd_app' })).status).toBe(200)
    expect((await listed(session, 'icon_home_own'))?.iconShown).toBe('wrench')
    expect((await listed(session, 'icon_home'))?.iconShown).toBe('team')
    await machine('/v1/ingest/entities/squad/core', { method: 'PUT', ...body({ title: 'Core', icon: 'star', relations: { lead_crew: 'platform', member_crew: 'web' } }) })
    expect(await listed(session, 'icon_home')).toMatchObject({ iconShown: 'star', homeShown: { icon: 'star' } })
    // A home that is not there reads as none, and the definition still names it for whoever wrote it.
    expect((await hooked('lost_tool', { home: 'squad:gone', blueprint: 'argocd_app', access: { everyone: true } })).status).toBe(200)
    expect(await listed(session, 'lost_tool')).toMatchObject({ home: 'squad:gone', homeShown: null, iconShown: 'argocd' })
    // An action with no home says so.
    expect((await listed(session, 'restart'))?.homeShown).toBeNull()
  })

  it('never names a home to a reader who may not see it', async () => {
    const squadSpec = { title: 'Squad', icon: 'team', fields: {}, relations: { lead_crew: { target: 'crew' }, member_crew: { target: 'crew' } } }
    expect((await session('/v1/blueprints/squad', { method: 'PUT', ...body({ ...squadSpec, access: { grants: [{ values: ['bob@example.org'] }] } }) })).status).toBe(200)
    // Ada still runs it, because she leads Core, but the list does not say where it belongs.
    const hidden = await listed(ada, 'core_tool')
    expect(hidden).toMatchObject({ canRun: true, homeShown: null, iconShown: 'rocket' })
    expect(hidden?.home).toBeUndefined()
    expect(JSON.stringify(hidden)).not.toContain('squad:core')
    const one = await json<ActionView>(await ada('/v1/actions/core_tool'))
    expect(one.homeShown).toBeNull()
    expect(one.home).toBeUndefined()
    expect((await listed(session, 'core_tool'))?.homeShown).toMatchObject({ id: 'squad:core' })
    // The shared layout orders the sections, a home's by its id: hers leaves out the homes she may not see, and her save keeps them.
    const layout = async (who: (p: string, i?: RequestInit) => Promise<Response>, patch?: Partial<ActionsLayout>) => json<ActionsLayout>(await who('/v1/actions/layout', patch ? { method: 'PUT', ...body(patch) } : undefined))
    const was = await layout(session)
    await layout(session, { order: ['squad:core', 'Orrery'], closed: ['squad:edge'] })
    expect(await layout(ada)).toEqual({ order: ['Orrery'], closed: [] })
    expect(await layout(bob)).toEqual({ order: ['squad:core', 'Orrery'], closed: ['squad:edge'] })
    const admin = { admin: true, permissions: [] as never[], kind: 'user' as const, name: 'local', roles: [] }
    await hub.access.saveRole('organizer', { title: 'Organizer', permissions: ['catalog.organize'] }, admin)
    await hub.access.setRoles('ada@example.org', ['organizer'], admin)
    expect(await layout(ada, { order: ['Operations', 'Orrery'], closed: ['Operations'] })).toEqual({ order: ['Operations', 'Orrery'], closed: ['Operations'] })
    expect(await layout(session)).toEqual({ order: ['Operations', 'Orrery', 'squad:core'], closed: ['Operations', 'squad:edge'] })
    await hub.access.setRoles('ada@example.org', [], admin)
    await layout(session, was)
    expect((await session('/v1/blueprints/squad', { method: 'PUT', ...body(squadSpec) })).status).toBe(200)
    expect((await listed(ada, 'core_tool'))?.homeShown).toMatchObject({ id: 'squad:core', yours: true })
  })

  it('carries the home to a portal and to an agent as its id and title', async () => {
    const forAda = (await json<{ actions: Record<string, unknown>[] }>(await machine('/v1/actions?for=ada%40example.org', undefined, portal))).actions
    expect(forAda.find((a) => a.id === 'core_tool')).toMatchObject({ home: { id: 'squad:core', title: 'Core' }, iconShown: 'star' })
    expect(forAda.find((a) => a.id === 'lost_tool')).not.toHaveProperty('home')
    const rpc = async (method: string, params: Record<string, unknown>, id: number) => {
      const res = await machine('/mcp', { method: 'POST', headers: { accept: 'application/json, text/event-stream' }, ...body({ jsonrpc: '2.0', id, method, params }) }, reporter)
      const text = await res.text()
      const line = text.split('\n').find((l) => l.startsWith('data:'))
      return JSON.parse(line ? line.slice(5) : text) as { result: { content: { text: string }[] } }
    }
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } }, 1)
    expect((await hooked('core_tool', { home: 'squad:core', access: { home: ['lead'], grants: [{ values: ['workflow'] }] } })).status).toBe(200)
    const tools = JSON.parse((await rpc('tools/call', { name: 'list_actions', arguments: {} }, 2)).result.content[0]!.text) as { id: string; home?: { id: string; title: string } }[]
    expect(tools.find((a) => a.id === 'core_tool')?.home).toEqual({ id: 'squad:core', title: 'Core' })
    expect((await hooked('core_tool', { home: 'squad:core', access: { home: ['lead'] } })).status).toBe(200)
  })

  it('says in the posture who runs it as its home\'s people, and finds a home that is gone', async () => {
    const who = await json<{ rows: { principal: { name: string }; runs: boolean; via: string }[] }>(await session('/v1/posture/who?target=action:core_tool'))
    const row = (name: string) => who.rows.find((r) => r.principal.name === name)
    expect(row('ada@example.org')).toMatchObject({ runs: true, via: "its home's people" })
    expect(row('bob@example.org')).toMatchObject({ runs: false })
    const posture = await json<PostureResponse>(await session('/v1/posture'))
    expect(posture.items.find((i) => i.target.kind === 'action' && i.target.id === 'core_tool')).toMatchObject({ open: false })
    const gone = posture.findings.find((f) => f.id === 'home-gone:lost_tool')
    expect(gone).toMatchObject({ family: 'Actions whose home is not in the catalog', severity: 'low', targets: [{ kind: 'action', id: 'lost_tool' }] })
    expect(posture.findings.some((f) => f.id === 'home-gone:core_tool')).toBe(false)
    expect(posture.findings.some((f) => f.id.startsWith('home-unowned'))).toBe(false)
    // Taking the grants off through the posture leaves who its home opens it to.
    const change = { targets: [{ kind: 'action', id: 'core_tool' }], access: { op: 'add', grants: [{ values: ['workflow'] }] } }
    expect((await session('/v1/posture/change', { method: 'POST', ...body({ change, save: true }) })).status).toBe(200)
    expect(hub.actions.get('core_tool')).toMatchObject({ home: 'squad:core', access: { home: ['lead'], grants: [{ values: ['workflow'] }] } })
    expect((await session('/v1/posture/change', { method: 'POST', ...body({ change: { ...change, access: { ...change.access, op: 'remove' } }, save: true }) })).status).toBe(200)
    expect(hub.actions.get('core_tool')).toMatchObject({ home: 'squad:core', access: { home: ['lead'] } })
  })

  it('lets nobody in by the home while the model does not say what a person owns, and finds it', async () => {
    // Nothing else may ask for ownership here: the rules of the restart action do, so it goes first.
    expect((await session('/v1/actions/restart', { method: 'DELETE' })).status).toBeLessThan(300)
    expect((await person([])).status).toBe(200)
    expect(await listed(ada, 'core_tool')).toBeUndefined()
    expect((await run(ada, 'core_tool')).status).toBe(403)
    expect((await listed(session, 'core_tool'))?.canRun).toBe(true)
    const findings = (await json<PostureResponse>(await session('/v1/posture'))).findings
    expect(findings.find((f) => f.id === 'home-unowned')).toMatchObject({ severity: 'medium', targets: [{ kind: 'action', id: 'core_tool' }] })
    expect((await person(owns)).status).toBe(200)
    expect((await listed(ada, 'core_tool'))?.canRun).toBe(true)
  })
})

describe('the kinds of input', () => {
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
  const put = (inputs: Record<string, unknown>) => session('/v1/actions/kinds', { method: 'PUT', ...body({ title: 'Every kind', inputs, backend: { type: 'caller' }, access: { everyone: true } }) })
  const run = (inputs: Record<string, unknown>, who = session) => who('/v1/actions/kinds/run', { method: 'POST', ...body({ inputs }) })
  /** A run that is refused answers 400 with the error and the input it is about. */
  const refused = async (inputs: Record<string, unknown>) => {
    const res = await run(inputs)
    expect(res.status, JSON.stringify(inputs)).toBe(400)
    return json<{ error: string; input?: string }>(res)
  }
  const stored = async (inputs: Record<string, unknown>) => {
    const res = await run(inputs)
    expect(res.status, JSON.stringify(inputs)).toBe(201)
    return (await json<ActionRun>(res)).inputs
  }

  it('keeps what each kind checked, and refuses what it does not take, naming the input', async () => {
    const saved = await put({
      notes: { type: 'text' },
      on: { type: 'date' },
      at: { type: 'datetime' },
      mail: { type: 'email' },
      copies: { type: 'email', many: true },
      size: { type: 'enum', values: ['small', 'large'], display: 'buttons' },
    })
    expect(saved.status).toBe(200)
    expect(await stored({ notes: 'one\ntwo', on: ' 2026-03-10 ', at: '2026-03-10T09:30:00-05:00', mail: ' Reader@Example.ORG ', copies: 'a@example.org\nb@example.org', size: 'large' })).toEqual({
      notes: 'one\ntwo',
      on: '2026-03-10',
      at: '2026-03-10T14:30:00.000Z',
      mail: 'Reader@example.org',
      copies: ['a@example.org', 'b@example.org'],
      size: 'large',
    })
    expect(await stored({})).toEqual({ notes: null, on: null, at: null, mail: null, copies: [], size: null })
    expect(await refused({ notes: 3 })).toEqual({ error: 'Input "notes": expected text', input: 'notes' })
    expect(await refused({ on: '10/03/2026' })).toEqual({ error: 'Input "on": expected a date, as YYYY-MM-DD', input: 'on' })
    expect(await refused({ on: '2026-02-30' })).toMatchObject({ input: 'on' })
    expect(await refused({ at: '2026-03-10T09:30' })).toEqual({ error: 'Input "at": expected a date and time with an offset, as 2026-03-10T14:30:00Z', input: 'at' })
    expect(await refused({ mail: 'reader at example.org' })).toEqual({ error: 'Input "mail": expected an email address', input: 'mail' })
    expect(await refused({ copies: ['a@example.org', 'nobody'] })).toEqual({ error: 'Input "copies": expected an email address', input: 'copies' })
    expect(await refused({ size: 'medium' })).toEqual({ error: 'Input "size": expected one of small, large', input: 'size' })
  })

  it('holds a value to its rules, and says the hint where one is written', async () => {
    const saved = await put({
      ticket: { type: 'string', required: true, pattern: '[A-Z]+-\\d+', maxLength: 10, hint: 'Give the ticket, such as OPS-12' },
      why: { type: 'text', minLength: 5 },
      count: { type: 'number', min: 1, max: 5 },
      due: { type: 'date', min: 'today', max: 'today+30d' },
      at: { type: 'datetime', min: '2026-01-01T00:00:00Z' },
      sizes: { type: 'enum', many: true, values: ['s', 'm', 'l'], minLength: 1, maxLength: 2 },
    })
    expect(saved.status).toBe(200)
    expect(await stored({ ticket: 'OPS-12', why: 'because', count: '5', due: day(30), at: '2026-01-01T00:00:00Z', sizes: ['s', 'l'] })).toMatchObject({ ticket: 'OPS-12', count: 5, due: day(30), sizes: ['s', 'l'] })
    expect(await refused({})).toEqual({ error: 'Input "ticket" is required', input: 'ticket' })
    expect(await refused({ ticket: 'ops 12' })).toEqual({ error: 'Input "ticket": Give the ticket, such as OPS-12', input: 'ticket' })
    expect(await refused({ ticket: 'OPERATIONS-12' })).toEqual({ error: 'Input "ticket": Give the ticket, such as OPS-12', input: 'ticket' })
    expect(await refused({ ticket: 'OPS-12', why: 'no' })).toEqual({ error: 'Input "why": expected at least 5 characters', input: 'why' })
    expect(await refused({ ticket: 'OPS-12', count: 6 })).toEqual({ error: 'Input "count": expected 5 or less', input: 'count' })
    expect(await refused({ ticket: 'OPS-12', due: day(-1) })).toEqual({ error: `Input "due": expected ${day(0)} or later`, input: 'due' })
    expect(await refused({ ticket: 'OPS-12', due: day(31) })).toEqual({ error: `Input "due": expected ${day(30)} or earlier`, input: 'due' })
    expect(await refused({ ticket: 'OPS-12', at: '2025-12-31T23:59:59Z' })).toMatchObject({ input: 'at' })
    expect(await refused({ ticket: 'OPS-12', sizes: ['s', 'm', 'l'] })).toEqual({ error: 'Input "sizes": expected at most 2 picked', input: 'sizes' })
  })

  it('refuses a definition whose rules do not fit its kinds', async () => {
    const bad = async (inputs: Record<string, unknown>) => {
      const res = await put(inputs)
      expect(res.status).toBe(400)
      return (await json<{ error: string }>(res)).error
    }
    expect(await bad({ n: { type: 'number', pattern: '\\d+' } })).toContain('inputs.n.pattern: input "n": a number input takes no pattern')
    expect(await bad({ s: { type: 'string', pattern: '(a+)+' } })).toContain('a repeat inside a repeat')
    expect(await bad({ d: { type: 'date', min: 'today+1y', max: 'today' } })).toContain('inputs.d.min: input "d": min is past max')
    expect(await bad({ t: { type: 'text', many: true } })).toContain('a text input is one value')
  })

  it('picks a person from the blueprint the estate says a person is, as an entity input does', async () => {
    const saved = await put({ lead: { type: 'person', required: true }, helpers: { type: 'person', many: true, maxLength: 1, where: { relation: 'crews', target: 'crew:web' } } })
    expect(saved.status).toBe(200)
    expect((await json<ActionsResponse>(await session('/v1/actions'))).person).toBe('crew_member')
    expect(await stored({ lead: 'ada', helpers: ['crew_member:bob'] })).toEqual({ lead: 'crew_member:ada', helpers: ['crew_member:bob'] })
    expect(await refused({ lead: 'crew:platform' })).toEqual({ error: 'Input "lead": expected a crew_member', input: 'lead' })
    expect(await refused({ lead: 'nobody' })).toEqual({ error: 'Input "lead": crew_member:nobody does not exist, or is not one the action offers here', input: 'lead' })
    expect(await refused({ lead: 'ada', helpers: ['ada'] })).toMatchObject({ input: 'helpers' })
  })

  it('names the kinds to an agent, and the input a refused run is about', async () => {
    const rpc = async (method: string, params: Record<string, unknown>, id = 1) => {
      const res = await machine('/mcp', { method: 'POST', headers: { accept: 'application/json, text/event-stream' }, ...body({ jsonrpc: '2.0', id, method, params }) }, reporter)
      const text = await res.text()
      const line = text.split('\n').find((l) => l.startsWith('data:'))
      return JSON.parse(line ? line.slice(5) : text) as { result: { content: { text: string }[]; tools?: { name: string; description: string }[] } }
    }
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } })
    const tools = (await rpc('tools/list', {}, 2)).result.tools!
    const described = tools.find((t) => t.name === 'list_actions')!.description
    for (const kind of ['text', 'date', 'datetime', 'email', 'person', 'pattern', 'minLength', 'hint']) expect(described, kind).toContain(kind)
    const read = JSON.parse((await rpc('tools/call', { name: 'list_actions', arguments: { action: 'kinds' } }, 3)).result.content[0]!.text) as { id: string; inputs: Record<string, { type: string; blueprint?: string; maxLength?: number }> }
    expect(read.inputs).toMatchObject({ lead: { type: 'person', blueprint: 'crew_member' }, helpers: { type: 'person', blueprint: 'crew_member', maxLength: 1 } })
    const ran = JSON.parse((await rpc('tools/call', { name: 'run_action', arguments: { action: 'kinds', inputs: { lead: 'nobody' } } }, 4)).result.content[0]!.text) as { error: string; input?: string }
    expect(ran).toEqual({ error: 'Input "lead": crew_member:nobody does not exist, or is not one the action offers here', input: 'lead' })
  })

  it('refuses a person input while the estate does not say who a person is', async () => {
    // Nothing may ask for ownership once nobody is a person: the home's action does, so it goes first.
    expect((await session('/v1/actions/core_tool', { method: 'DELETE' })).status).toBeLessThan(300)
    const cleared = await session('/v1/access/person', { method: 'PUT', ...body(null) })
    expect(cleared.status, await cleared.clone().text()).toBe(200)
    expect((await json<ActionsResponse>(await session('/v1/actions'))).person).toBeNull()
    expect(await refused({ lead: 'ada' })).toEqual({ error: 'Input "lead": the estate no longer says who a person is, so there is nobody to pick', input: 'lead' })
    const res = await put({ lead: { type: 'person' } })
    expect(res.status).toBe(400)
    expect((await json<{ error: string }>(res)).error).toContain('input "lead": a person input needs the estate to say who a person is, which an admin does on the Access page')
  })
})

describe('a form that asks by what was given', () => {
  const put = (inputs: Record<string, unknown>, more: Record<string, unknown> = {}) => session('/v1/actions/asks', { method: 'PUT', ...body({ title: 'Ask by what was given', inputs, backend: { type: 'caller' }, access: { everyone: true }, ...more }) })
  const run = (inputs: Record<string, unknown>, who = session) => who('/v1/actions/asks/run', { method: 'POST', ...body({ inputs }) })
  const refused = async (inputs: Record<string, unknown>) => {
    const res = await run(inputs)
    expect(res.status, JSON.stringify(inputs)).toBe(400)
    return json<{ error: string; input?: string }>(res)
  }
  const stored = async (inputs: Record<string, unknown>) => {
    const res = await run(inputs)
    expect(res.status, JSON.stringify(inputs)).toBe(201)
    return (await json<ActionRun>(res)).inputs
  }
  const bad = async (inputs: Record<string, unknown>, more: Record<string, unknown> = {}) => {
    const res = await put(inputs, more)
    expect(res.status).toBe(400)
    return (await json<{ error: string }>(res)).error
  }
  afterAll(async () => {
    await session('/v1/actions/asks', { method: 'DELETE' })
  })

  it('asks an input only when its when matches the inputs above it, and keeps nothing for one it did not ask', async () => {
    const saved = await put({
      env: { type: 'enum', values: ['dev', 'prod'], required: true },
      reason: { type: 'string', required: true, minLength: 5, when: { field: 'env', op: 'eq', value: 'prod' } },
      ticket: { type: 'string', pattern: '[A-Z]+-\\d+', when: { field: 'reason', op: 'exists' } },
      watchers: { type: 'email', many: true, when: { field: 'env', op: 'eq', value: 'prod' } },
    })
    expect(saved.status, await saved.clone().text()).toBe(200)
    // Not asked: a required input passes, and nothing is kept of what was sent for it, however wrong.
    expect(await stored({ env: 'dev' })).toEqual({ env: 'dev', reason: null, ticket: null, watchers: [] })
    expect(await stored({ env: 'dev', reason: 'no', ticket: 'not a ticket', watchers: ['nobody'] })).toEqual({ env: 'dev', reason: null, ticket: null, watchers: [] })
    // Asked: it is required and checked as any other.
    expect(await refused({ env: 'prod' })).toEqual({ error: 'Input "reason" is required', input: 'reason' })
    expect(await refused({ env: 'prod', reason: 'no' })).toMatchObject({ input: 'reason' })
    expect(await refused({ env: 'prod', reason: 'the disk is full', ticket: 'nope' })).toMatchObject({ input: 'ticket' })
    expect(await stored({ env: 'prod', reason: 'the disk is full', ticket: 'OPS-12', watchers: 'a@example.org' })).toEqual({ env: 'prod', reason: 'the disk is full', ticket: 'OPS-12', watchers: ['a@example.org'] })
  })

  it('works a value out from the inputs above it, whatever was sent for it, and holds it to its rules', async () => {
    const saved = await put({
      name: { type: 'string', required: true },
      env: { type: 'enum', values: ['dev', 'prod'], default: 'dev' },
      slug: { type: 'string', value: "lower(name) + '-' + env", pattern: '[a-z0-9-]+', hint: 'The name gives a slug of small letters, digits, and dashes' },
      long: { type: 'boolean', value: 'len(name) > 5' },
      note: { type: 'string', value: "'for ' + slug", when: { field: 'env', op: 'eq', value: 'prod' } },
    })
    expect(saved.status, await saved.clone().text()).toBe(200)
    expect(await stored({ name: 'Billing' })).toEqual({ name: 'Billing', env: 'dev', slug: 'billing-dev', long: true, note: null })
    expect(await stored({ name: 'Pay', env: 'prod', slug: 'mine', long: true, note: 'mine' })).toEqual({ name: 'Pay', env: 'prod', slug: 'pay-prod', long: false, note: 'for pay-prod' })
    // What it works out breaks its rule: said plainly, at the input.
    expect(await refused({ name: 'Pay roll' })).toEqual({ error: 'Input "slug": The name gives a slug of small letters, digits, and dashes', input: 'slug' })
  })

  it('refuses a value an active entity already holds, whatever the reader sees and whatever its case', async () => {
    expect((await session('/v1/blueprints/vault_item', { method: 'PUT', ...body({ title: 'Vault item', fields: { code: { type: 'string' }, shelf: { type: 'number' } }, relations: {}, access: { grants: [{ values: ['bob@example.org'] }] } }) })).status).toBe(200)
    await machine('/v1/ingest/entities/vault_item/ledger-1', { method: 'PUT', ...body({ title: 'Sealed Ledger', fields: { code: 'LX-40', shelf: 7 } }) })
    await machine('/v1/ingest/entities/vault_item/ledger-10', { method: 'PUT', ...body({ title: 'Sealed Ledger, second copy', fields: { code: 'LX-400', shelf: 70 } }) })
    const saved = await put({
      key: { type: 'string', unique: { blueprint: 'vault_item', field: 'key' } },
      title: { type: 'string', title: 'Name', unique: { blueprint: 'vault_item', field: 'title' } },
      code: { type: 'string', unique: { blueprint: 'vault_item', field: 'code' }, hint: 'That code is on a shelf already' },
      shelf: { type: 'number', unique: { blueprint: 'vault_item', field: 'shelf' } },
      made: { type: 'string', value: "'lx-' + shelf", unique: { blueprint: 'vault_item', field: 'code' } },
    })
    expect(saved.status, await saved.clone().text()).toBe(200)
    expect(await refused({ key: 'ledger-1' })).toEqual({ error: 'Input "key": key is already taken', input: 'key' })
    expect(await refused({ key: 'LEDGER-1' })).toMatchObject({ input: 'key' })
    expect(await refused({ title: 'sealed ledger' })).toEqual({ error: 'Input "title": Name is already taken', input: 'title' })
    expect(await refused({ code: 'lx-40' })).toEqual({ error: 'Input "code": That code is on a shelf already', input: 'code' })
    expect(await refused({ shelf: 7 })).toEqual({ error: 'Input "shelf": shelf is already taken', input: 'shelf' })
    // A value worked out is held unique the same way.
    expect(await refused({ shelf: 40 })).toEqual({ error: 'Input "made": made is already taken', input: 'made' })
    // Part of a value another holds is free, and so is one that only looks like it.
    expect(await stored({ key: 'ledger', title: 'Sealed', code: 'LX-4', shelf: 8 })).toMatchObject({ key: 'ledger', title: 'Sealed', code: 'LX-4', shelf: 8, made: 'lx-8' })
    // The check is the hub's own: someone who may not see the blueprint is refused the same, and told no more.
    const res = await run({ code: 'LX-40' }, ada)
    expect(res.status).toBe(400)
    expect(await json(res)).toEqual({ error: 'Input "code": That code is on a shelf already', input: 'code' })
    // An entity its source no longer sees holds nothing.
    expect(await refused({ code: 'lx-400' })).toMatchObject({ input: 'code' })
    await hub.db.query(`UPDATE entities SET state = 'missing', missing_since = now() WHERE blueprint = 'vault_item' AND key = 'ledger-10'`)
    expect(await stored({ code: 'lx-400' })).toMatchObject({ code: 'lx-400' })
  })

  it('refuses a definition that cannot hold', async () => {
    expect(await bad({ reason: { type: 'string', when: { field: 'env', op: 'eq', value: 'prod' } }, env: { type: 'string' } })).toContain('when reads "env", which is declared after it')
    expect(await bad({ name: { type: 'string' }, slug: { type: 'string', value: 'lower(name', required: true } })).toContain('a worked-out input is never asked')
    expect(await bad({ name: { type: 'string', unique: { blueprint: 'no_such', field: 'key' } } })).toContain('unknown blueprint "no_such"')
    expect(await bad({ name: { type: 'string', unique: { blueprint: 'vault_item', field: 'colour' } } })).toContain('vault_item has no field "colour"')
    expect(await bad({ pick: { type: 'entity', blueprint: 'vault_item', show: ['colour'] } })).toContain('show names "colour"')
    expect(await bad({ name: { type: 'string' } }, { walk: true })).toContain('the action needs sections')
    expect(await bad({ name: { type: 'string' } }, { sections: [{ title: 'One', inputs: ['nope'] }] })).toContain('"nope" is not an input')
    // Whoever saves it must see the blueprint a value is held unique in, as with any blueprint it names.
    const hidden = await cy('/v1/actions/asks_hidden', { method: 'PUT', ...body({ title: 'Hidden', inputs: { name: { type: 'string', unique: { blueprint: 'vault_item', field: 'key' } } }, backend: { type: 'caller' } }) })
    expect(hidden.status).toBe(404)
    expect((await json<{ error: string }>(hidden)).error).toContain('vault_item')
    expect(hub.actions.get('asks_hidden')).toBeUndefined()
    const kept = await put({ name: { type: 'string', required: true }, why: { type: 'text' } }, { walk: true, sections: [{ title: 'What', description: 'Name it', inputs: ['name'] }, { title: 'Why', inputs: ['why'] }] })
    expect(kept.status, await kept.clone().text()).toBe(200)
    const listed = (await json<ActionsResponse>(await session('/v1/actions'))).actions.find((a) => a.id === 'asks')!
    expect(listed.walk).toBe(true)
    expect(listed.sections).toEqual([{ title: 'What', description: 'Name it', inputs: ['name'] }, { title: 'Why', inputs: ['why'] }])
  })

  it('carries the fields shown under an option as the reader may read them', async () => {
    expect((await session('/v1/blueprints/locker', { method: 'PUT', ...body({ title: 'Locker', fields: { floor: { type: 'string' }, code: { type: 'string', access: { grants: [{ values: ['bob@example.org'] }] } } }, relations: {} }) })).status).toBe(200)
    await machine('/v1/ingest/entities/locker/a1', { method: 'PUT', ...body({ title: 'Locker A1', fields: { floor: 'Second', code: '4411' } }) })
    const saved = await put({ locker: { type: 'entity', blueprint: 'locker', show: ['floor', 'code'] } })
    expect(saved.status, await saved.clone().text()).toBe(200)
    expect((await json<ActionsResponse>(await ada('/v1/actions'))).actions.find((a) => a.id === 'asks')!.inputs.locker!.show).toEqual(['floor', 'code'])
    // The options the form reads are the entities as each reader sees them: a field they may not read is not there to show.
    const options = async (who: typeof ada) => (await json<{ entities: { key: string; fields: Record<string, unknown> }[] }>(await who('/v1/entities?blueprint=locker'))).entities.find((e) => e.key === 'a1')!.fields
    expect(await options(bob)).toMatchObject({ floor: 'Second', code: '4411' })
    expect(await options(ada)).toMatchObject({ floor: 'Second' })
    expect(JSON.stringify(await options(ada))).not.toContain('4411')
  })

  it("names the entities a run's inputs picked by their titles, and never one the reader may not see", async () => {
    const saved = await put({ locker: { type: 'entity', blueprint: 'locker' }, crews: { type: 'entity', blueprint: 'crew', many: true }, note: { type: 'string' } })
    expect(saved.status, await saved.clone().text()).toBe(200)
    const ran = await json<ActionRun>(await run({ locker: 'a1', crews: ['platform', 'web'], note: 'crew:web' }, ada))
    expect(ran.inputs).toMatchObject({ locker: 'locker:a1', crews: ['crew:platform', 'crew:web'] })
    expect((await json<ActionRun>(await ada(`/v1/action-runs/${ran.id}`))).inputTitles).toEqual({ 'locker:a1': 'Locker A1', 'crew:platform': 'Platform', 'crew:web': 'Web' })
    expect((await json<{ runs: ActionRun[] }>(await ada('/v1/action-runs?action=asks'))).runs.find((r) => r.id === ran.id)!.inputTitles).toMatchObject({ 'locker:a1': 'Locker A1' })
    // The blueprint closes to everyone but one person: its titles reach nobody else, in a run they could see before.
    expect((await session('/v1/blueprints/crew', { method: 'PUT', ...body({ title: 'Crew', fields: {}, relations: {}, access: { grants: [{ values: ['bob@example.org'] }] } }) })).status).toBe(200)
    await hub.db.query(`INSERT INTO action_runs (id, action, inputs, actor, state) VALUES ('past-picked', 'asks', $1, 'ada@example.org', 'succeeded')`, [JSON.stringify({ locker: 'locker:a1', crews: ['crew:platform'], note: null })])
    // The action no longer picks from it, so they still see the run: what it once picked there stays a bare id.
    await put({ locker: { type: 'entity', blueprint: 'locker' }, crews: { type: 'entity', blueprint: 'locker', many: true }, note: { type: 'string' } })
    const seen = (await json<{ runs: ActionRun[] }>(await ada('/v1/action-runs?action=asks'))).runs.find((r) => r.id === 'past-picked')!
    expect(seen.inputTitles).toEqual({ 'locker:a1': 'Locker A1' })
    expect((await json<{ runs: ActionRun[] }>(await bob('/v1/action-runs?action=asks'))).runs.find((r) => r.id === 'past-picked')!.inputTitles).toEqual({ 'locker:a1': 'Locker A1', 'crew:platform': 'Platform' })
    await hub.db.query(`DELETE FROM action_runs WHERE id = 'past-picked'`)
    expect((await session('/v1/blueprints/crew', { method: 'PUT', ...body({ title: 'Crew', fields: {}, relations: {} }) })).status).toBe(200)
  })

  it('tells an agent which inputs are asked when, and which are worked out', async () => {
    const rpc = async (method: string, params: Record<string, unknown>, id = 1) => {
      const res = await machine('/mcp', { method: 'POST', headers: { accept: 'application/json, text/event-stream' }, ...body({ jsonrpc: '2.0', id, method, params }) }, reporter)
      const text = await res.text()
      const line = text.split('\n').find((l) => l.startsWith('data:'))
      return JSON.parse(line ? line.slice(5) : text) as { result: { content: { text: string }[]; tools?: { name: string; description: string }[] } }
    }
    const saved = await put({
      env: { type: 'enum', values: ['dev', 'prod'], required: true },
      reason: { type: 'string', required: true, when: { field: 'env', op: 'eq', value: 'prod' } },
      slug: { type: 'string', value: "'run-' + env", unique: { blueprint: 'locker', field: 'key' } },
    })
    expect(saved.status, await saved.clone().text()).toBe(200)
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } })
    const tools = (await rpc('tools/list', {}, 2)).result.tools!
    const described = tools.find((t) => t.name === 'list_actions')!.description
    for (const word of ['when', 'workedOut', 'unique', 'sections']) expect(described, word).toContain(word)
    const { inputs } = JSON.parse((await rpc('tools/call', { name: 'list_actions', arguments: { action: 'asks' } }, 3)).result.content[0]!.text) as { id: string; inputs: Record<string, Record<string, unknown>> }
    expect(inputs.reason).toMatchObject({ required: true, when: { field: 'env', op: 'eq', value: 'prod' } })
    expect(inputs.slug).toMatchObject({ workedOut: true, value: "'run-' + env", unique: { blueprint: 'locker', field: 'key' } })
    expect(inputs.env!.workedOut).toBeUndefined()
    // A value sent for an input that is not asked, or for one that is worked out, is dropped without a word.
    const ran = JSON.parse((await rpc('tools/call', { name: 'run_action', arguments: { action: 'asks', inputs: { env: 'dev', reason: 'left over', slug: 'mine' } } }, 4)).result.content[0]!.text) as { run: string }
    expect((await json<ActionRun>(await session(`/v1/action-runs/${ran.run}`))).inputs).toEqual({ env: 'dev', reason: null, slug: 'run-dev' })
    const refusal = JSON.parse((await rpc('tools/call', { name: 'run_action', arguments: { action: 'asks', inputs: { env: 'prod' } } }, 5)).result.content[0]!.text) as { error: string; input?: string }
    expect(refusal).toEqual({ error: 'Input "reason" is required', input: 'reason' })
  })
})

describe('a batch', () => {
  // Three workloads, each a kiosk to ping; one of them a person may see but no rule lets them run it on.
  const define = (extra: Record<string, unknown> = {}) =>
    session('/v1/actions/ping_many', { method: 'PUT', ...body({ title: 'Ping', blueprint: 'k8s_workload', batch: { max: 3 }, inputs: { command: { type: 'enum', values: ['ping', 'reboot'], required: true } }, backend: { type: 'runner', runner: 'lan-runner', command: ['ping', '{{ inputs.command }}', '{{ entity.key }}'] }, ...extra }) })
  const kiosks = ['k1', 'k2', 'k3', 'k4']
  beforeAll(async () => {
    for (const k of kiosks) await machine(`/v1/ingest/entities/k8s_workload/kiosk%2F${k}`, { method: 'PUT', ...body({ title: `Kiosk ${k}`, fields: { name: k, kind: 'Deployment', schedule: 'kiosk' }, relations: { namespace: 'home/shop' } }) })
    expect((await define()).status).toBe(200)
  })
  const kioskQuery = { blueprint: 'k8s_workload', filter: { field: 'schedule', op: 'eq', value: 'kiosk' } }
  /** Takes every job the runner is handed now, and reports each as it says. */
  const drain = async (outcome: (job: RunnerJob) => Record<string, unknown> = () => ({ state: 'succeeded' })) => {
    const jobs = (await json<{ jobs: RunnerJob[] }>(await machine('/v1/ingest/runner/jobs?max=50', {}, runner))).jobs
    for (const j of jobs) await machine(`/v1/ingest/runner/jobs/${j.run}/report`, { method: 'POST', ...body(outcome(j)) }, runner)
    return jobs
  }

  it('is defined only on an action that runs on a blueprint and has a form', async () => {
    const off = await session('/v1/actions/nope', { method: 'PUT', ...body({ title: 'x', batch: { max: 5 }, inputs: {}, backend: { type: 'webhook', url: 'http://x' } }) })
    expect((await json(off)).error).toContain('batch: a batch runs on many entities')
    const big = await session('/v1/actions/nope', { method: 'PUT', ...body({ title: 'x', blueprint: 'k8s_workload', batch: { max: 60_000 }, inputs: {}, backend: { type: 'webhook', url: 'http://x' } }) })
    expect(big.status).toBe(400)
    await session('/v1/actions/ping_one', { method: 'PUT', ...body({ title: 'Ping one', blueprint: 'k8s_workload', inputs: {}, backend: { type: 'runner', runner: 'lan-runner', command: ['ping'] } }) })
    const one = await session('/v1/actions/ping_one/batch/preview', { method: 'POST', ...body({ query: kioskQuery, inputs: {} }) })
    expect((await json(one)).error).toContain('does not run on many at once')
    await session('/v1/actions/ping_one', { method: 'DELETE' })
  })

  it('says what it would run on before anything is asked, and refuses past its most', async () => {
    const over = await session('/v1/actions/ping_many/batch/preview', { method: 'POST', ...body({ query: kioskQuery, inputs: { command: 'ping' } }) })
    expect(over.status).toBe(400)
    expect((await json(over)).error).toContain('holds at most 3')
    const preview = await json<BatchPreview>(await session('/v1/actions/ping_many/batch/preview', { method: 'POST', ...body({ query: { ...kioskQuery, except: [{ blueprint: 'k8s_workload', key: 'kiosk/k4' }] }, inputs: { command: 'ping' } }) }))
    expect(preview).toMatchObject({ total: 3, max: 3, approval: 0, refused: [] })
    expect(preview.entities.map((e) => e.title)).toEqual(['Kiosk k1', 'Kiosk k2', 'Kiosk k3'])
    expect(await hub.db.query(`SELECT 1 FROM action_runs WHERE action = 'ping_many'`).then((r) => r.rowCount)).toBe(0)
  })

  it('names what it may not run on, and refuses a person the action does not name', async () => {
    await define({ access: { rules: [{ grants: [{ values: ['ada@example.org'] }], where: { field: 'name', op: 'in', value: ['k1', 'k2'] } }] } })
    const named = await json<BatchPreview>(await ada('/v1/actions/ping_many/batch/preview', { method: 'POST', ...body({ entities: [{ blueprint: 'k8s_workload', key: 'kiosk/k1' }, { blueprint: 'k8s_workload', key: 'kiosk/k3' }, { blueprint: 'k8s_workload', key: 'kiosk/gone' }], inputs: { command: 'ping' } }) }))
    expect(named.entities.map((e) => e.key)).toEqual(['kiosk/k1'])
    expect(named.refused.map((r) => [r.key, r.reason])).toEqual([
      ['kiosk/k3', 'No rule lets you run it on this'],
      ['kiosk/gone', 'It does not exist, or the action does not apply to it'],
    ])
    expect((await bob('/v1/actions/ping_many/batch/preview', { method: 'POST', ...body({ entities: [{ blueprint: 'k8s_workload', key: 'kiosk/k1' }], inputs: { command: 'ping' } }) })).status).toBe(403)
    await define()
  })

  let batch: ActionBatchSummary
  it('asks one run on each entity, each checked as one alone, and records the batch once', async () => {
    const bad = await session('/v1/actions/ping_many/batch', { method: 'POST', ...body({ query: { ...kioskQuery, except: [{ blueprint: 'k8s_workload', key: 'kiosk/k4' }] }, inputs: { command: 'format' } }) })
    expect(bad.status).toBe(400)
    expect((await json(bad)).input).toBe('command')
    const res = await session('/v1/actions/ping_many/batch', { method: 'POST', ...body({ query: { ...kioskQuery, except: [{ blueprint: 'k8s_workload', key: 'kiosk/k4' }] }, inputs: { command: 'ping' } }) })
    expect(res.status).toBe(201)
    batch = await json<ActionBatchSummary>(res)
    expect(batch).toMatchObject({ action: 'ping_many', asked: 3, refused: 0, counts: { queued: 3 }, done: false, inputs: { command: 'ping' } })
    const runs = (await json<ActionRunsResponse>(await session('/v1/action-runs?action=ping_many'))).runs
    expect(runs).toHaveLength(3)
    expect(runs.every((r) => r.batch === batch.id && r.state === 'queued' && r.inputs.command === 'ping')).toBe(true)
    const asked = (await json<{ changes: Change[] }>(await session('/v1/changes?kind=action.batched'))).changes
    expect(asked[0]).toMatchObject({ actor: 'local@example.org', category: 'actions', detail: { action: 'ping_many', batch: batch.id, runs: 3 } })
    // No row for each run asked: the batch is the record of asking.
    expect((await json<{ changes: Change[] }>(await session('/v1/changes?kind=action.requested'))).changes.filter((c) => (c.detail as { batch?: string }).batch === batch.id)).toEqual([])
  })

  it('hands a runner a run asked for alone before any run of a batch', async () => {
    const alone = await json<ActionRun>(await session('/v1/actions/ping_many/run', { method: 'POST', ...body({ entity: { blueprint: 'k8s_workload', key: 'kiosk/k4' }, inputs: { command: 'ping' } }) }))
    const first = await json<{ jobs: RunnerJob[] }>(await machine('/v1/ingest/runner/jobs?max=1', {}, runner))
    expect(first.jobs.map((j) => j.run)).toEqual([alone.id])
    expect(first.jobs[0]!.command).toEqual(['ping', 'ping', 'kiosk/k4'])
    await machine(`/v1/ingest/runner/jobs/${alone.id}/report`, { method: 'POST', ...body({ state: 'succeeded' }) }, runner)
  })

  it('shows each entity with its newest run, an image by name only, and the image itself apart', async () => {
    const shot = `data:image/jpeg;base64,${Buffer.from('a jpeg').toString('base64')}`
    await drain((j) => (j.command[2] === 'kiosk/k2' ? { state: 'failed', summary: 'offline' } : { state: 'succeeded', log: ['::output:: memory_used=40%', `::output:: screen=${shot}`] }))
    const page = await json<ActionBatchResponse>(await session(`/v1/action-batches/${batch.id}`))
    expect(page.counts).toEqual({ succeeded: 2, failed: 1 })
    expect(page.done).toBe(true)
    expect(page.canAct).toBe(true)
    expect(page.items.map((i) => [i.title, i.state, i.runs])).toEqual([['Kiosk k1', 'succeeded', 1], ['Kiosk k2', 'failed', 1], ['Kiosk k3', 'succeeded', 1]])
    const k1 = page.items[0]!
    expect(k1.outputs).toEqual({ memory_used: '40%' })
    expect(k1.images).toEqual(['screen'])
    expect(JSON.stringify(page)).not.toContain('base64')
    const img = await session(`/v1/action-runs/${k1.run}/outputs/screen`)
    expect(img.headers.get('content-type')).toBe('image/jpeg')
    expect(Buffer.from(await img.arrayBuffer()).toString()).toBe('a jpeg')
    expect((await session(`/v1/action-runs/${k1.run}/outputs/memory_used`)).status).toBe(404)
  })

  it('tells the desk once when it is asked and once when it ends, never of each run', async () => {
    expect(await hub.batches.ended()).toEqual([batch.id])
    expect(await hub.batches.ended()).toEqual([])
    const sent: NoticeEvent[] = []
    const dispatch: typeof fetch = async (url, init) => {
      if (String(url).endsWith('/v1/events')) sent.push(JSON.parse(String(init?.body)) as NoticeEvent)
      return new Response(JSON.stringify({ queued: 1 }), { status: 202 })
    }
    await new NoticeForwarder({ db: hub.db, actions: hub.actions, batches: hub.batches, sets: hub.changeSets, schedules: hub.schedules, people: () => hub.people(), reader: hub.reader, blueprints: hub.blueprints, log: createLogger('notices-test') }, { url: 'http://dispatch.test/', token: 'tok', publicUrl: 'https://orrery.example.org/', remindHours: 0 }, dispatch).pass()
    const mine = sent.filter((e) => e.labels.action === 'ping_many')
    expect(mine.filter((e) => e.labels.batch === batch.id).map((e) => e.kind).sort()).toEqual(['action.batch_failed', 'action.batched'])
    const ended = mine.find((e) => e.kind === 'action.batch_failed' && e.labels.batch === batch.id)!
    expect(ended).toMatchObject({ title: 'Ping on 3 things: 1 failed', severity: 'warning', to: [{ person: 'local@example.org' }] })
    expect(ended.links[0]!.url).toBe(`https://orrery.example.org/actions/batches/${batch.id}`)
    // The run asked for alone is told as before; none of the batch's three is.
    expect(mine.filter((e) => e.kind === 'action.succeeded' || e.kind === 'action.failed')).toHaveLength(1)
  })

  it('asks again on the entities that failed, in the same batch, and opens it again', async () => {
    const again = await json<{ asked: number }>(await session(`/v1/action-batches/${batch.id}/again`, { method: 'POST', ...body({ states: ['failed'] }) }))
    expect(again.asked).toBe(1)
    const jobs = await drain()
    expect(jobs.map((j) => j.command[2])).toEqual(['kiosk/k2'])
    const page = await json<ActionBatchResponse>(await session(`/v1/action-batches/${batch.id}`))
    expect(page.items.find((i) => i.key === 'kiosk/k2')).toMatchObject({ state: 'succeeded', runs: 2 })
    expect(page.counts).toEqual({ succeeded: 3 })
    expect(page.asked).toBe(4)
    expect(await hub.batches.ended()).toEqual([batch.id])
  })

  it('stops: what has not started is cancelled, and only who asked or an admin may', async () => {
    const b = await json<ActionBatchSummary>(await session('/v1/actions/ping_many/batch', { method: 'POST', ...body({ entities: [{ blueprint: 'k8s_workload', key: 'kiosk/k1' }, { blueprint: 'k8s_workload', key: 'kiosk/k2' }], inputs: { command: 'reboot' } }) }))
    await json(await machine('/v1/ingest/runner/jobs?max=1', {}, runner))
    expect((await ada(`/v1/action-batches/${b.id}/stop`, { method: 'POST' })).status).toBe(404)
    const stopped = await json<ActionBatchSummary>(await session(`/v1/action-batches/${b.id}/stop`, { method: 'POST' }))
    expect(stopped).toMatchObject({ counts: { running: 1, cancelled: 1 }, stoppedBy: 'local@example.org', done: false })
    expect((await json<{ jobs: RunnerJob[] }>(await machine('/v1/ingest/runner/jobs', {}, runner))).jobs).toEqual([])
    const listed = (await json<ActionBatchesResponse>(await session('/v1/action-batches?action=ping_many'))).batches.map((x) => x.id)
    expect(listed).toEqual([b.id, batch.id])
    expect((await json<ActionBatchesResponse>(await bob('/v1/action-batches'))).batches).toEqual([])
    const running = (await json<ActionRunsResponse>(await session(`/v1/action-runs?action=ping_many&state=running`))).runs[0]!
    await machine(`/v1/ingest/runner/jobs/${running.id}/report`, { method: 'POST', ...body({ state: 'succeeded' }) }, runner)
  })

  it('refuses to save an input that reads the entity, or what narrows it, since one answer cannot hold for each', async () => {
    const reads = await define({ inputs: { image: { type: 'enum', values: '{{ entity.fields.images }}' } } })
    expect(reads.status).toBe(400)
    expect((await json(reads)).error).toContain('input "image" reads the entity it runs on, so it cannot be asked once for many')
    const asks = await define({ inputs: { kind: { type: 'enum', values: ['Deployment'], narrows: 'kind' }, note: { type: 'string', when: { field: 'kind', op: 'eq', value: 'Deployment' } } } })
    expect((await json(asks)).error).toContain('input "note" reads "kind", which each entity fills for itself')
    const says = await define({ inputs: { kind: { type: 'enum', values: ['Deployment'], narrows: 'kind' }, note: { type: 'string', description: 'For {{ inputs.kind }}' } } })
    expect((await json(says)).error).toContain('input "note" reads "kind"')
    // An input that narrows the target may itself say what the entity holds: it is filled from each one, never asked.
    expect((await define({ inputs: { kind: { type: 'enum', values: ['Deployment'], narrows: 'kind', description: 'Now {{ entity.fields.kind }}' } } })).status).toBe(200)
    await define()
  })

  it('fills what narrows the target from each entity, and names an entity whose own value is refused', async () => {
    const defined = await session('/v1/actions/restart_many', { method: 'PUT', ...body({ title: 'Restart', blueprint: 'k8s_workload', batch: { max: 10 }, inputs: { kind: { type: 'enum', title: 'Kind', values: ['Deployment', 'StatefulSet'], narrows: 'kind', required: true }, reason: { type: 'string' } }, backend: { type: 'runner', runner: 'lan-runner', command: ['restart', '{{ inputs.kind }}', '{{ entity.key }}'] } }) })
    expect(defined.status).toBe(200)
    for (const [key, kind] of [['tier/s1', 'StatefulSet'], ['tier/d1', 'DaemonSet'], ['tier/x1', null]] as const) await machine(`/v1/ingest/entities/k8s_workload/${encodeURIComponent(key)}`, { method: 'PUT', ...body({ title: `Tier ${key}`, fields: { name: key, ...(kind ? { kind } : {}) }, relations: { namespace: 'home/shop' } }) })
    const entities = ['kiosk/k1', 'tier/s1', 'tier/d1', 'tier/x1'].map((key) => ({ blueprint: 'k8s_workload', key }))
    // What was sent for an input that narrows is dropped: each entity fills its own.
    const inputs = { kind: 'Deployment', reason: 'patch' }
    const preview = await json<BatchPreview>(await session('/v1/actions/restart_many/batch/preview', { method: 'POST', ...body({ entities, inputs }) }))
    expect(preview.entities.map((e) => e.key).sort()).toEqual(['kiosk/k1', 'tier/s1'])
    expect(Object.fromEntries(preview.refused.map((r) => [r.key, r.reason]))).toEqual({ 'tier/d1': expect.stringContaining('Input "kind"'), 'tier/x1': 'Input "kind" is required' })
    const b = await json<ActionBatchSummary>(await session('/v1/actions/restart_many/batch', { method: 'POST', ...body({ entities, inputs }) }))
    expect(b).toMatchObject({ asked: 2, refused: 2, inputs: { reason: 'patch' } })
    const runs = (await hub.db.query<{ key: string; inputs: Record<string, unknown> }>('SELECT key, inputs FROM action_runs WHERE batch = $1', [b.id])).rows
    expect(Object.fromEntries(runs.map((r) => [r.key, r.inputs]))).toEqual({ 'kiosk/k1': { kind: 'Deployment', reason: 'patch' }, 'tier/s1': { kind: 'StatefulSet', reason: 'patch' } })
    // None of them may run: the batch is refused whole, with why.
    const none = await session('/v1/actions/restart_many/batch', { method: 'POST', ...body({ entities: entities.slice(2), inputs }) })
    expect(none.status).toBe(400)
    expect((await json(none)).error).toContain('It may run on none of the 2 picked')
    await session(`/v1/action-batches/${b.id}/stop`, { method: 'POST' })
  })
})

describe('a run that retries', () => {
  const define = (id: string, backend: Record<string, unknown>, retry: Record<string, unknown> = { tries: 3, backoff: '1s' }) =>
    session(`/v1/actions/${id}`, { method: 'PUT', ...body({ title: id, inputs: {}, backend, retry }) })
  const jobs = async () => (await json<{ jobs: RunnerJob[] }>(await machine('/v1/ingest/runner/jobs?max=50', {}, runner))).jobs.filter((j) => j.action.startsWith('retry_'))
  const report = (run: string, r: Record<string, unknown>) => machine(`/v1/ingest/runner/jobs/${run}/report`, { method: 'POST', ...body(r) }, runner)
  const ask = async (id: string) => json<ActionRun>(await session(`/v1/actions/${id}/run`, { method: 'POST', ...body({ inputs: {} }) }))
  const read = async (id: string) => json<ActionRun>(await session(`/v1/action-runs/${id}`))
  /** Makes every waiting try due now, as the clock would. */
  const due = async () => {
    await hub.db.query(`UPDATE action_runs SET retry_at = now() - interval '1 second' WHERE retry_at IS NOT NULL`)
    return hub.actions.retryDue()
  }

  it('is defined only for a backend the hub hands the run to, with a sane wait', async () => {
    const caller = await define('retry_caller', { type: 'caller' })
    expect((await json(caller)).error).toContain('retry: a caller backend is not handed the run again')
    const slow = await define('retry_slow', { type: 'runner', runner: 'lan-runner', command: ['x'] }, { tries: 3, backoff: '1h' })
    expect((await json(slow)).error).toContain('retry: the backoff is at least 1s and at most 10m')
    const many = await define('retry_many', { type: 'runner', runner: 'lan-runner', command: ['x'] }, { tries: 9, backoff: '5s' })
    expect(many.status).toBe(400)
  })

  it('tries a failed run again in the same run, after its wait, and keeps what each try said', async () => {
    expect((await define('retry_ping', { type: 'runner', runner: 'lan-runner', command: ['ping'] })).status).toBe(200)
    const run = await ask('retry_ping')
    const [first] = await jobs()
    expect(first!.run).toBe(run.id)
    await report(run.id, { state: 'failed', summary: 'sign-in timed out', log: ['::output:: status=failed'] })
    const waiting = await read(run.id)
    expect(waiting).toMatchObject({ state: 'queued', attempt: 2, claimedBy: null, outputs: {}, finishedAt: null })
    expect(waiting.retryAt).not.toBeNull()
    expect(waiting.log.map((l) => l.message)).toContainEqual(expect.stringMatching(/^try 1 of 3 failed: sign-in timed out; trying again in \ds$/))
    // Not handed over before its wait is up.
    expect(await jobs()).toEqual([])
    expect(await due()).toBe(1)
    const [second] = await jobs()
    expect(second!.run).toBe(run.id)
    await report(run.id, { state: 'succeeded', log: ['::output:: status=online'] })
    expect(await read(run.id)).toMatchObject({ state: 'succeeded', attempt: 2, retryAt: null, outputs: { status: 'online' } })
    const retried = (await json<{ changes: Change[] }>(await session('/v1/changes?kind=action.retried'))).changes
    expect(retried.find((c) => (c.detail as { run: string }).run === run.id)).toMatchObject({ detail: { action: 'retry_ping', failed: 1, next: 2, reason: 'sign-in timed out' } })
    // One finish for the run, not one for each try.
    const finished = (await json<{ changes: Change[] }>(await session('/v1/changes?kind=action.finished'))).changes.filter((c) => (c.detail as { run: string }).run === run.id)
    expect(finished).toHaveLength(1)
  })

  it('never tries again a failure its backend calls final, nor past its tries', async () => {
    const final = await ask('retry_ping')
    await jobs()
    await report(final.id, { log: ['the player is offline', '::final::'] })
    await report(final.id, { state: 'failed', summary: 'offline' })
    const ended = await read(final.id)
    expect(ended).toMatchObject({ state: 'failed', attempt: 1 })
    expect(ended.log.map((l) => l.message)).not.toContain('::final::')

    const spent = await ask('retry_ping')
    for (const attempt of [1, 2, 3]) {
      const [job] = await jobs()
      expect(job!.run).toBe(spent.id)
      await report(spent.id, { state: 'failed', summary: `try ${attempt}` })
      if (attempt < 3) await due()
    }
    expect(await read(spent.id)).toMatchObject({ state: 'failed', attempt: 3, retryAt: null })
  })

  it('stops waiting when the run is cancelled', async () => {
    const run = await ask('retry_ping')
    await jobs()
    await report(run.id, { state: 'failed', summary: 'blip' })
    expect((await session(`/v1/action-runs/${run.id}/withdraw`, { method: 'POST', ...body({}) })).status).toBe(200)
    expect(await due()).toBe(0)
    expect((await read(run.id)).state).toBe('cancelled')
  })

  it('posts a webhook again after a passing error, never after a refusal', async () => {
    expect((await define('retry_hook', { type: 'webhook', url: `${hookUrl}/retry` })).status).toBe(200)
    answer = 503
    const passing = await ask('retry_hook')
    expect(await read(passing.id)).toMatchObject({ state: 'queued', attempt: 2 })
    answer = 202
    received = []
    expect(await due()).toBe(1)
    expect(received).toHaveLength(1)
    expect(await read(passing.id)).toMatchObject({ state: 'running', attempt: 2 })

    answer = 400
    const refused = await ask('retry_hook')
    expect(await read(refused.id)).toMatchObject({ state: 'failed', attempt: 1 })
    answer = 202
  })
})

describe('how long a batch takes', () => {
  const kiosks = [1, 2, 3, 4].map((k) => ({ blueprint: 'k8s_workload', key: `kiosk/k${k}` }))
  const preview = async () => json<BatchPreview>(await session('/v1/actions/eta_ping/batch/preview', { method: 'POST', ...body({ entities: kiosks, inputs: {} }) }))
  beforeAll(async () => {
    expect((await session('/v1/actions/eta_ping', { method: 'PUT', ...body({ title: 'Ping', blueprint: 'k8s_workload', batch: { max: 50 }, inputs: {}, backend: { type: 'runner', runner: 'lan-runner', command: ['ping', '{{ entity.key }}'] } }) })).status).toBe(200)
  })

  it('keeps the width a runner says when it asks for work', async () => {
    await json(await machine('/v1/ingest/runner/jobs?max=1&width=2', {}, runner))
    expect(hub.sources.get('lan-runner')?.width).toBe(2)
    // A width out of bounds is not kept.
    await json(await machine('/v1/ingest/runner/jobs?max=1&width=0', {}, runner))
    expect(hub.sources.get('lan-runner')?.width).toBe(2)
  })

  it('has no estimate until the action has run often enough', async () => {
    expect((await preview()).estimate).toBeNull()
  })

  it('works one out from the mean time of the action runs, failed ones too, and the runner width', async () => {
    for (const state of ['succeeded', 'failed', 'succeeded']) {
      const run = await json<ActionRun>(await session('/v1/actions/eta_ping/run', { method: 'POST', ...body({ entity: kiosks[0], inputs: {} }) }))
      await hub.db.query(`UPDATE action_runs SET state = $2, started_at = now() - interval '20 seconds', finished_at = now() - interval '10 seconds' WHERE id = $1`, [run.id, state])
    }
    const p = await preview()
    expect(p.estimate).toEqual({ seconds: Math.round(Math.max(1, (4 + p.ahead) / 2) * 10), basis: 'history' })
  })

  it('reads the time of runs with the same inputs, so a ping is not timed as a reboot', async () => {
    expect((await session('/v1/actions/eta_cmd', { method: 'PUT', ...body({ title: 'Command', blueprint: 'k8s_workload', batch: { max: 50 }, inputs: { command: { type: 'enum', values: ['ping', 'reboot'], required: true } }, backend: { type: 'runner', runner: 'lan-runner', command: ['x', '{{ inputs.command }}'] } }) })).status).toBe(200)
    for (const [command, seconds] of [['ping', 10], ['ping', 10], ['ping', 10], ['reboot', 600], ['reboot', 600], ['reboot', 600]] as const) {
      const run = await json<ActionRun>(await session('/v1/actions/eta_cmd/run', { method: 'POST', ...body({ entity: kiosks[0], inputs: { command } }) }))
      await hub.db.query(`UPDATE action_runs SET state = 'succeeded', started_at = now() - make_interval(secs => $2), finished_at = now() WHERE id = $1`, [run.id, seconds])
    }
    const ping = await json<BatchPreview>(await session('/v1/actions/eta_cmd/batch/preview', { method: 'POST', ...body({ entities: kiosks, inputs: { command: 'ping' } }) }))
    expect(ping.estimate).toEqual({ seconds: Math.round(Math.max(1, (4 + ping.ahead) / 2) * 10), basis: 'history' })
    const reboot = await json<BatchPreview>(await session('/v1/actions/eta_cmd/batch/preview', { method: 'POST', ...body({ entities: kiosks, inputs: { command: 'reboot' } }) }))
    expect(reboot.estimate).toEqual({ seconds: Math.round(Math.max(1, (4 + reboot.ahead) / 2) * 600), basis: 'history' })
  })

  it('says how long a running batch has left, and nothing once it is over', async () => {
    const b = await json<ActionBatchSummary>(await session('/v1/actions/eta_ping/batch', { method: 'POST', ...body({ entities: kiosks, inputs: {} }) }))
    const page = await json<ActionBatchResponse>(await session(`/v1/action-batches/${b.id}`))
    expect(page.left?.basis).toBe('history')
    expect(page.left!.seconds).toBeGreaterThanOrEqual(20)
    await hub.db.query(`UPDATE action_runs SET state = 'succeeded', started_at = now(), finished_at = now() WHERE batch = $1`, [b.id])
    expect((await json<ActionBatchResponse>(await session(`/v1/action-batches/${b.id}`))).left).toBeNull()
  })
})

describe('a batch in a list of many', () => {
  const kiosks = [1, 2, 3].map((k) => ({ blueprint: 'k8s_workload', key: `kiosk/k${k}` }))
  let batch: ActionBatchSummary
  let alone: ActionRun
  beforeAll(async () => {
    expect((await session('/v1/actions/fold_ping', { method: 'PUT', ...body({ title: 'Ping', blueprint: 'k8s_workload', batch: { max: 10 }, inputs: { command: { type: 'enum', values: ['ping'], required: true } }, backend: { type: 'runner', runner: 'lan-runner', command: ['ping', '{{ entity.key }}'] } }) })).status).toBe(200)
    alone = await json<ActionRun>(await session('/v1/actions/fold_ping/run', { method: 'POST', ...body({ entity: kiosks[0], inputs: { command: 'ping' } }) }))
    batch = await json<ActionBatchSummary>(await session('/v1/actions/fold_ping/batch', { method: 'POST', ...body({ entities: kiosks, inputs: { command: 'ping' } }) }))
    const shot = `data:image/png;base64,${Buffer.from('a png').toString('base64')}`
    const jobs = (await json<{ jobs: RunnerJob[] }>(await machine('/v1/ingest/runner/jobs?max=50', {}, runner))).jobs.filter((j) => j.action === 'fold_ping')
    for (const j of jobs) await machine(`/v1/ingest/runner/jobs/${j.run}/report`, { method: 'POST', ...body(j.command[1] === 'kiosk/k2' && j.run !== alone.id ? { state: 'failed', summary: 'offline' } : { state: 'succeeded', log: [`::output:: screen=${shot}`] }) }, runner)
  })

  it('lists a batch as one line beside the runs asked alone', async () => {
    const listed = await json<ActionRunsResponse>(await session('/v1/action-runs?action=fold_ping&group=batch'))
    expect(listed.runs.map((r) => r.id)).toEqual([alone.id])
    expect(listed.batches!.map((b) => b.id)).toEqual([batch.id])
    const b = listed.batches![0]!
    expect(b.counts).toEqual({ succeeded: 2, failed: 1 })
    expect(b.done).toBe(true)
    expect(b.endedAt).not.toBeNull()
    expect(b.cover).toMatchObject({ name: 'screen' })
    // Without the grouping every run is a line, as before.
    expect((await json<ActionRunsResponse>(await session('/v1/action-runs?action=fold_ping'))).runs).toHaveLength(4)
    // A batch with no run in the state asked for is not listed.
    expect((await json<ActionRunsResponse>(await session('/v1/action-runs?action=fold_ping&group=batch&state=running'))).batches).toEqual([])
  })

  it('folds a batch into the row that asked it in the activity log, and opens it alone', async () => {
    const res = await session('/v1/changes?fold=batches&limit=1000')
    const folded = await json<ChangesResponse>(res)
    expect(res.status, JSON.stringify(folded)).toBe(200)
    const of = (c: Change) => (c.detail as { batch?: string }).batch === batch.id
    expect(folded.changes.filter(of).map((c) => c.kind)).toEqual(['action.batched'])
    expect(folded.batches?.[batch.id]).toMatchObject({ id: batch.id, counts: { succeeded: 2, failed: 1 } })
    // The run asked alone still has its own row.
    expect(folded.changes.some((c) => c.kind === 'action.finished' && (c.detail as { run?: string }).run === alone.id)).toBe(true)
    const opened = await json<ChangesResponse>(await session(`/v1/changes?batch=${batch.id}`))
    expect(opened.changes.every(of)).toBe(true)
    expect(opened.changes.filter((c) => c.kind === 'action.finished')).toHaveLength(3)
  })
})

describe('keeping runs', () => {
  const shot = `data:image/png;base64,${Buffer.from('a picture').toString('base64')}`
  let run: ActionRun
  beforeAll(async () => {
    expect((await session('/v1/actions/keep_ping', { method: 'PUT', ...body({ title: 'Keep', inputs: {}, backend: { type: 'runner', runner: 'lan-runner', command: ['ping'] } }) })).status).toBe(200)
    run = await json<ActionRun>(await session('/v1/actions/keep_ping/run', { method: 'POST', ...body({ inputs: {} }) }))
    const jobs = (await json<{ jobs: RunnerJob[] }>(await machine('/v1/ingest/runner/jobs?max=50', {}, runner))).jobs
    for (const j of jobs) await machine(`/v1/ingest/runner/jobs/${j.run}/report`, { method: 'POST', ...body(j.run === run.id ? { state: 'succeeded', log: ['::output:: status=online', `::output:: screen=${shot}`] } : { state: 'succeeded' }) }, runner)
  })

  it('keeps a picture apart from the run, which names it, and reads it alone', async () => {
    const got = await json<ActionRun>(await session(`/v1/action-runs/${run.id}`))
    expect(got.outputs).toEqual({ status: 'online' })
    expect(got.images).toEqual(['screen'])
    const img = await session(`/v1/action-runs/${run.id}/outputs/screen`)
    expect(img.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await img.arrayBuffer()).toString()).toBe('a picture')
    // The row a list reads holds no picture.
    const row = await hub.db.query<{ outputs: string }>('SELECT outputs::text FROM action_runs WHERE id = $1', [run.id])
    expect(row.rows[0]!.outputs).not.toContain('data:image')
  })

  it('lets go of pictures past keeping, then of runs past keeping', async () => {
    await hub.db.query(`UPDATE action_run_images SET created_at = now() - interval '40 days' WHERE run = $1`, [run.id])
    expect((await hub.actions.prune(365, 30)).images).toBeGreaterThanOrEqual(1)
    expect((await json<ActionRun>(await session(`/v1/action-runs/${run.id}`))).images).toEqual([])
    expect((await session(`/v1/action-runs/${run.id}/outputs/screen`)).status).toBe(404)
    await hub.db.query(`UPDATE action_runs SET created_at = now() - interval '400 days' WHERE id = $1`, [run.id])
    expect((await hub.actions.prune(365, 30)).runs).toBeGreaterThanOrEqual(1)
    expect((await session(`/v1/action-runs/${run.id}`)).status).toBe(404)
  })
})

describe('more than one approval', () => {
  // Two people who may approve, and one who asked. `lead` and `second` hold actions.approve; the admin session asks.
  let second = ''
  beforeAll(async () => {
    const admin = { admin: true, permissions: [] as never[], kind: 'user' as const, name: 'local', roles: [] }
    await hub.access.saveRole('second_lead', { title: 'Second lead', permissions: ['actions.approve'] }, admin)
    second = (await hub.sources.issueToken('access', 'second', { role: 'second_lead' })).token
  })
  const define = (extra: Record<string, unknown> = {}) =>
    session('/v1/actions/two_keys', { method: 'PUT', ...body({ title: 'Two keys', inputs: {}, approval: true, quorum: { need: 2 }, backend: { type: 'runner', runner: 'lan-runner', command: ['go'] }, ...extra }) })
  const ask = async () => json<ActionRun>(await session('/v1/actions/two_keys/run', { method: 'POST', ...body({ inputs: {} }) }))
  const approve = (token: string, id: string) => machine(`/v1/action-runs/${id}/approve`, { method: 'POST' }, token)

  it('is refused where nobody approves, or a rule lets people approve their own', async () => {
    const none = await define({ approval: undefined })
    expect((await json(none)).error).toContain('nobody approves this action')
    const own = await define({ access: { rules: [{ grants: [{ values: ['ada@example.org'] }], approval: 'self' }] } })
    expect((await json(own)).error).toContain('approve their own run')
    expect((await define({ quorum: { need: 1 } })).status).toBe(400)
    expect((await define()).status).toBe(200)
  })

  it('waits for two different people, and says who has approved and who is left', async () => {
    const r = await ask()
    expect(r).toMatchObject({ state: 'awaiting', approvalsNeeded: 2, approvedBy: [] })
    const first = await json<ActionRun>(await approve(approver, r.id))
    expect(first.state).toBe('awaiting')
    expect(first.approvedBy!.map((a) => a.by)).toEqual(['lead'])
    expect(first.log.at(-1)!.message).toBe('approved by lead; 1 of 2, waiting for 1 more')
    expect(first.decidedBy).toBeNull()
    // Nothing started: a runner is handed no job yet.
    expect((await json<{ jobs: RunnerJob[] }>(await machine('/v1/ingest/runner/jobs?max=50', {}, runner))).jobs.filter((j) => j.run === r.id)).toEqual([])
    const done = await json<ActionRun>(await approve(second, r.id))
    expect(done.state).toBe('queued')
    expect(done.decidedBy).toBe('second')
    expect(done.approvedBy!.map((a) => a.by)).toEqual(['lead', 'second'])
    expect(done.log.map((l) => l.message)).toContain('approved by second; 2 of 2, with lead')
    const jobs = (await json<{ jobs: RunnerJob[] }>(await machine('/v1/ingest/runner/jobs?max=50', {}, runner))).jobs
    expect(jobs.filter((j) => j.run === r.id)).toHaveLength(1)
    await machine(`/v1/ingest/runner/jobs/${r.id}/report`, { method: 'POST', ...body({ state: 'succeeded' }) }, runner)
  })

  it('counts one person once, and shows them nothing more to decide', async () => {
    const r = await ask()
    await approve(approver, r.id)
    const again = await approve(approver, r.id)
    expect(again.status).toBe(403)
    expect((await json(again)).error).toContain('already approved')
    const seen = await json<ActionRun>(await machine(`/v1/action-runs/${r.id}`, {}, approver))
    expect(seen.canDecide).toBe(false)
    expect((await json<ActionRun>(await machine(`/v1/action-runs/${r.id}`, {}, second))).canDecide).toBe(true)
    expect((await json<ActionRun>(await session(`/v1/action-runs/${r.id}`))).state).toBe('awaiting')
    await session(`/v1/action-runs/${r.id}/withdraw`, { method: 'POST' })
  })

  it('ends at once when anyone declines, even after one approval', async () => {
    const r = await ask()
    await approve(approver, r.id)
    const declined = await json<ActionRun>(await machine(`/v1/action-runs/${r.id}/decline`, { method: 'POST', ...body({ reason: 'no' }) }, second))
    expect(declined.state).toBe('declined')
    expect((await approve(second, r.id)).status).toBe(409)
  })

  it('starts exactly once when two people approve at the same moment', async () => {
    const r = await ask()
    const both = await Promise.all([approve(approver, r.id), approve(second, r.id)])
    expect(both.map((x) => x.status)).toEqual([200, 200])
    const run = await json<ActionRun>(await session(`/v1/action-runs/${r.id}`))
    expect(run.state).toBe('queued')
    expect(run.approvedBy!.map((a) => a.by).sort()).toEqual(['lead', 'second'])
    const jobs = (await json<{ jobs: RunnerJob[] }>(await machine('/v1/ingest/runner/jobs?max=50', {}, runner))).jobs.filter((j) => j.run === r.id)
    expect(jobs).toHaveLength(1)
    await machine(`/v1/ingest/runner/jobs/${r.id}/report`, { method: 'POST', ...body({ state: 'succeeded' }) }, runner)
  })

  it('fixes the count when the run is asked, so changing the action moves no run already waiting', async () => {
    const r = await ask()
    await define({ quorum: { need: 3 } })
    expect((await json<ActionRun>(await session(`/v1/action-runs/${r.id}`))).approvalsNeeded).toBe(2)
    await approve(approver, r.id)
    expect((await json<ActionRun>(await approve(second, r.id))).state).toBe('queued')
    await machine('/v1/ingest/runner/jobs?max=50', {}, runner)
    await machine(`/v1/ingest/runner/jobs/${r.id}/report`, { method: 'POST', ...body({ state: 'succeeded' }) }, runner)
    await define()
  })

  it('tells the activity log once for each approval given, and the desk of the last', async () => {
    const r = await ask()
    await approve(approver, r.id)
    await approve(second, r.id)
    const kinds = (await json<{ changes: Change[] }>(await session('/v1/changes?limit=200'))).changes.filter((c) => (c.detail as { run?: string }).run === r.id).map((c) => c.kind).sort()
    expect(kinds).toEqual(['action.approved', 'action.requested', 'action.voted'])
    await machine('/v1/ingest/runner/jobs?max=50', {}, runner)
    await machine(`/v1/ingest/runner/jobs/${r.id}/report`, { method: 'POST', ...body({ state: 'succeeded' }) }, runner)
  })

  it('asks a batch of many the same count for each run', async () => {
    await session('/v1/actions/two_keys_many', { method: 'PUT', ...body({ title: 'Two keys many', blueprint: 'k8s_workload', batch: { max: 5 }, inputs: {}, approval: true, quorum: { need: 2 }, backend: { type: 'runner', runner: 'lan-runner', command: ['go', '{{ entity.key }}'] } }) })
    const b = await json<{ id: string }>(await session('/v1/actions/two_keys_many/batch', { method: 'POST', ...body({ entities: [{ blueprint: 'k8s_workload', key: 'home/orrery/orrery' }, { blueprint: 'k8s_workload', key: 'home/shop/storefront' }], inputs: {} }) }))
    const runs = (await json<{ runs: ActionRun[] }>(await session('/v1/action-runs?action=two_keys_many&limit=10'))).runs.filter((r) => r.batch === b.id)
    expect(runs).toHaveLength(2)
    expect(runs.every((r) => r.state === 'awaiting' && r.approvalsNeeded === 2)).toBe(true)
    for (const r of runs) await session(`/v1/action-runs/${r.id}/withdraw`, { method: 'POST' })
  })
})

describe('an action that changes a list the entity holds', () => {
  const origins = ['https://a.example.org', 'https://b.example.org', 'https://c.example.org']
  const ask = (inputs: Record<string, unknown>) => session('/v1/actions/set_origins/run', { method: 'POST', ...body({ entity: { blueprint: 'web_app', key: 'shop' }, inputs }) })
  beforeAll(async () => {
    expect((await session('/v1/blueprints/web_app', { method: 'PUT', ...body({ title: 'Web app', fields: { origins: { type: 'array' } }, relations: {} }) })).status).toBe(200)
    await machine('/v1/ingest/entities/web_app/shop', { method: 'PUT', ...body({ title: 'Shop', fields: { origins } }) })
    const saved = await session('/v1/actions/set_origins', {
      method: 'PUT',
      ...body({
        title: 'Set allowed origins',
        blueprint: 'web_app',
        approval: true,
        inputs: { origins: { type: 'url', title: 'Allowed origins', many: true, current: '{{ entity.fields.origins }}' } },
        backend: { type: 'runner', runner: 'lan-runner', command: ['/set-origins', '--want={{ inputs.origins }}', '--had={{ run.current.origins }}', '{{ inputs.origins }}'] },
      }),
    })
    expect(saved.status).toBe(200)
  })

  it('refuses a run that leaves the list as it is, in any order, and asks nobody', async () => {
    const same = await ask({ origins: [origins[2], origins[0], origins[1]] })
    expect(same.status).toBe(400)
    expect(await json(same)).toEqual({ error: 'Input "origins": this is the list as it is now, so nothing would change', input: 'origins' })
    const twice = await ask({ origins: [origins[0], origins[0], 'https://d.example.org'] })
    expect(await json(twice)).toMatchObject({ error: 'Input "origins": expected each value once: https://a.example.org is in the list twice', input: 'origins' })
    expect((await json<ActionRunsResponse>(await session('/v1/action-runs?action=set_origins'))).runs).toEqual([])
  })

  it('keeps the list as it was asked, through a later change, to the runner and the approver', async () => {
    const want = [origins[0], origins[1], 'https://d.example.org']
    const r = await json<ActionRun>(await ask({ origins: want }))
    expect(r.state).toBe('awaiting')
    expect(r.current).toEqual({ origins })
    // The entity moves while the run waits: the run keeps what it was asked against.
    await machine('/v1/ingest/entities/web_app/shop', { method: 'PUT', ...body({ title: 'Shop', fields: { origins: [...origins, 'https://e.example.org'] } }) })
    expect((await json<ActionRun>(await session(`/v1/action-runs/${r.id}`))).current).toEqual({ origins })
    expect(reasonOf(hub.actions.get('set_origins')!.inputs, r)).toBe('Allowed origins adds: https://d.example.org\nAllowed origins removes: https://c.example.org')
    expect((await json<ActionRun>(await machine(`/v1/action-runs/${r.id}/approve`, { method: 'POST' }, approver))).state).toBe('queued')
    const job = (await json<{ jobs: RunnerJob[] }>(await machine('/v1/ingest/runner/jobs', {}, runner))).jobs.find((j) => j.run === r.id)
    // A list inside other text is one argument of JSON; a list that is the whole argument is an argument a value.
    expect(job?.command).toEqual(['/set-origins', `--want=${JSON.stringify(want)}`, `--had=${JSON.stringify(origins)}`, ...want])
    await machine(`/v1/ingest/runner/jobs/${r.id}/report`, { method: 'POST', ...body({ state: 'succeeded' }) }, runner)
  })

  it('tells an agent what its run adds and removes', async () => {
    await session('/v1/actions/set_origins', { method: 'PUT', ...body({ ...hub.actions.get('set_origins')!, access: { grants: [{ values: ['workflow'] }] } }) })
    const rpc = async (method: string, params: Record<string, unknown>, id: number) => {
      const res = await machine('/mcp', { method: 'POST', headers: { accept: 'application/json, text/event-stream' }, ...body({ jsonrpc: '2.0', id, method, params }) }, reporter)
      const text = await res.text()
      const line = text.split('\n').find((l) => l.startsWith('data:'))
      return JSON.parse(JSON.parse(line ? line.slice(5) : text).result.content[0].text) as Record<string, unknown>
    }
    await machine('/mcp', { method: 'POST', headers: { accept: 'application/json, text/event-stream' }, ...body({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } }) }, reporter)
    const full = (await rpc('tools/call', { name: 'list_actions', arguments: { action: 'set_origins' } }, 2)) as { inputs: Record<string, { current?: string }> }
    expect(full.inputs.origins!.current).toBe('{{ entity.fields.origins }}')
    const ran = await rpc('tools/call', { name: 'run_action', arguments: { action: 'set_origins', entity: 'web_app:shop', inputs: { origins: [origins[0], 'https://f.example.org'] } } }, 3)
    expect(ran.state).toBe('awaiting')
    expect(ran.changes).toEqual({ origins: { added: ['https://f.example.org'], removed: [origins[1], origins[2], 'https://e.example.org'], unchanged: 1 } })
    const same = await rpc('tools/call', { name: 'run_action', arguments: { action: 'set_origins', entity: 'web_app:shop', inputs: { origins: [...origins, 'https://e.example.org'] } } }, 4)
    expect(same).toEqual({ error: 'Input "origins": this is the list as it is now, so nothing would change', input: 'origins' })
  })
})
