// A run lives by being heard from, and the `job` backend: one container for
// each run, claimed by a starter, with a credential good for that run alone.

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { StarterJob, StarterRunsResponse } from '../shared/api.ts'
import type { ActionRun } from '../shared/model.ts'
import { loadConfig } from './config.ts'
import { createHub, type Hub } from './hub.ts'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://orrery:orrery@localhost:5433/orrery'

let hub: Hub
let starter = ''
let other = ''
let reporter = ''

const as = (email: string, groups = 'User') => (path: string, init?: RequestInit): Promise<Response> => Promise.resolve(hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', 'x-forwarded-email': email, 'x-forwarded-groups': groups, ...init?.headers } }, { surface: 'session' }))
const session = as('local@example.org', 'Admin')
const ada = as('ada@example.org')
const bob = as('bob@example.org')
const machine = (path: string, init: RequestInit | undefined, bearer: string) => Promise.resolve(hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}`, ...init?.headers } }, { surface: 'machine' }))
const json = async <T = Record<string, unknown>>(r: Response): Promise<T> => (await r.json()) as T
const post = (v: unknown) => ({ method: 'POST', body: JSON.stringify(v) })
const put = (v: unknown) => ({ method: 'PUT', body: JSON.stringify(v) })
const run = async (id: string) => json<ActionRun>(await session(`/v1/action-runs/${id}`))
const messages = (r: ActionRun) => r.log.map((l) => l.message)

/** A job action: one container for each run, from the starter's `infra-apply` template. */
const apply = (extra: Record<string, unknown> = {}) => ({
  title: 'Apply a workspace',
  inputs: { workspace: { type: 'string', required: true }, tag: { type: 'string', default: '1.4.0' }, plan: { type: 'attachment' } },
  backend: { type: 'job', starter: 'jobs', template: 'infra-apply', image: 'registry.example.org/infra:{{ inputs.tag }}', command: ['infra', 'apply'], args: ['--workspace', '{{ inputs.workspace }}'], env: { WORKSPACE: '{{ inputs.workspace }}', ASKED_BY: '{{ by.name }}' } },
  access: { everyone: true },
  ...extra,
})
const define = async (id: string, spec: Record<string, unknown>) => expect((await session(`/v1/actions/${id}`, put(spec))).status).toBe(200)
const ask = async (who: typeof ada, action: string, inputs: Record<string, unknown> = { workspace: 'network' }) => json<ActionRun>(await who(`/v1/actions/${action}/run`, post({ inputs })))
const claim = async (bearer = starter) => (await json<{ starter: string; jobs: StarterJob[] }>(await machine('/v1/ingest/starter/jobs', undefined, bearer))).jobs
const held = async (seen?: string[]) => (await json<StarterRunsResponse>(await machine('/v1/ingest/starter/runs', post(seen ? { seen } : {}), starter))).runs
const says = (id: string, report: Record<string, unknown>, bearer = starter) => machine(`/v1/ingest/runner/jobs/${id}/report`, post(report), bearer)
const aged = (id: string, set: string) => hub.db.query(`UPDATE action_runs SET ${set} WHERE id = $1`, [id])

beforeAll(async () => {
  hub = await createHub(loadConfig({ DATABASE_URL, DATA_DIR: mkdtempSync(join(tmpdir(), 'orrery-')), AUTH_MODE: 'proxy', PUBLIC_URL: 'https://hub.example.org' }), 'test', { reset: true })
  await hub.sources.save('jobs', { title: 'Job starter', class: 'runner', blueprints: [], deleteGrant: [], cadence: '5m' })
  await hub.sources.save('lan-runner', { title: 'LAN runner', class: 'runner', blueprints: [], deleteGrant: [], cadence: '5m' })
  await hub.sources.save('k8s', { title: 'k8s', class: 'pusher', blueprints: ['*'], deleteGrant: [], cadence: '3m' })
  starter = (await hub.sources.issueToken('source', 'jobs', { source: 'jobs' })).token
  other = (await hub.sources.issueToken('source', 'runner', { source: 'lan-runner' })).token
  const admin = { admin: true, permissions: [] as never[], kind: 'user' as const, name: 'local', roles: [] }
  await hub.access.saveRole('operator', { title: 'Operator', permissions: ['actions.report'] }, admin)
  reporter = (await hub.sources.issueToken('access', 'workflow', { role: 'operator' })).token
})

afterAll(async () => {
  await hub.close()
})

describe('a run lives by being heard from', () => {
  const started = async (action: string) => {
    const r = await ask(ada, action, {})
    expect((await machine(`/v1/action-runs/${r.id}/report`, post({ state: 'running' }), reporter)).status).toBe(200)
    return r
  }

  it('gives up a run nothing was heard from for the hub\'s time, and keeps one that reports, however old', async () => {
    await define('long_work', { title: 'Long work', inputs: {}, backend: { type: 'caller' }, access: { everyone: true } })
    const silent = await started('long_work')
    const alive = await started('long_work')
    await aged(silent.id, `started_at = now() - interval '3 hours', heard_at = now() - interval '61 minutes'`)
    await aged(alive.id, `started_at = now() - interval '3 days', heard_at = now() - interval '59 minutes'`)
    expect(await hub.actions.expire()).toBe(1)
    const gone = await run(silent.id)
    expect(gone.state).toBe('unknown')
    expect(gone.log.at(-1)!.message).toMatch(/^not heard from for 60 minutes; given up\. It was handed on, so it may have done its work/)
    expect((await run(alive.id)).state).toBe('running')
    await machine(`/v1/action-runs/${alive.id}/report`, post({ state: 'succeeded' }), reporter)
  })

  it('takes a report that carries nothing as word that the run is alive, stored at most once a minute', async () => {
    const r = await started('long_work')
    await aged(r.id, `started_at = now() - interval '3 hours', heard_at = now() - interval '2 hours'`)
    // Nothing in it, and no body at all: each says only that the run is alive.
    expect((await machine(`/v1/action-runs/${r.id}/report`, post({}), reporter)).status).toBe(200)
    expect(await hub.actions.expire()).toBe(0)
    const heard = (await run(r.id)).heardAt!
    expect(Date.now() - Date.parse(heard)).toBeLessThan(60_000)
    expect((await machine(`/v1/action-runs/${r.id}/report`, { method: 'POST' }, reporter)).status).toBe(200)
    const after = await run(r.id)
    expect(after.heardAt).toBe(heard)
    expect(after.state).toBe('running')
    expect(messages(after)).toEqual(messages(await run(r.id)))
    await machine(`/v1/action-runs/${r.id}/report`, post({ state: 'succeeded' }), reporter)
  })

  it('ends a run at the ceiling its action names, however often it reports', async () => {
    await define('capped_work', { title: 'Capped work', inputs: {}, backend: { type: 'caller' }, ceiling: '2h', access: { everyone: true } })
    const r = await started('capped_work')
    await aged(r.id, `started_at = now() - interval '119 minutes', heard_at = now()`)
    expect(await hub.actions.expire()).toBe(0)
    await aged(r.id, `started_at = now() - interval '121 minutes', heard_at = now()`)
    expect(await hub.actions.expire()).toBe(1)
    const gone = await run(r.id)
    expect(gone.state).toBe('unknown')
    expect(gone.log.at(-1)!.message).toMatch(/^no result after 120 minutes; given up/)
  })

  it('lets a runner\'s job run to its own timeout while its runner is heard from, past the hub\'s time', async () => {
    await define('slow_job', { title: 'Slow job', inputs: {}, backend: { type: 'runner', runner: 'lan-runner', command: ['sleep', '3h'], timeout: '3h' }, access: { everyone: true } })
    const r = await ask(ada, 'slow_job', {})
    const { jobs } = await json<{ jobs: { run: string }[] }>(await machine('/v1/ingest/runner/jobs', undefined, other))
    expect(jobs.map((j) => j.run)).toEqual([r.id])
    // Ninety minutes in, its runner said a minute ago that it still holds the command.
    await aged(r.id, `started_at = now() - interval '90 minutes', heard_at = now() - interval '2 hours'`)
    expect((await says(r.id, {}, other)).status).toBe(200)
    expect(await hub.actions.expire()).toBe(0)
    // A runner that said nothing for the hub's time is gone, as before.
    await aged(r.id, `heard_at = now() - interval '61 minutes'`)
    expect(await hub.actions.expire()).toBe(1)
    expect((await run(r.id)).log.at(-1)!.message).toMatch(/^not heard from for 60 minutes; given up/)
  })

  it('refuses a ceiling where nothing outside the hub carries the run, and on a runner, which keeps its own timeout', async () => {
    const onRunner = await session('/v1/actions/nope', put({ title: 'x', inputs: {}, backend: { type: 'runner', runner: 'lan-runner', command: ['true'] }, ceiling: '2h' }))
    expect(onRunner.status).toBe(400)
    expect((await json(onRunner)).error).toContain('a runner ends its job at the backend\'s own timeout')
    const zero = await session('/v1/actions/nope', put({ title: 'x', inputs: {}, backend: { type: 'caller' }, ceiling: '0' }))
    expect((await json(zero)).error).toContain('a ceiling of 0 would let nothing run')
  })
})

describe('defining a job action', () => {
  it('needs a runner source as its starter, a template by name, and leaves the hub\'s own names alone', async () => {
    const pusher = await session('/v1/actions/nope', put(apply({ backend: { type: 'job', starter: 'k8s', template: 'infra-apply', image: 'x' } })))
    expect(pusher.status).toBe(400)
    expect((await json(pusher)).error).toContain('"k8s" is not a runner source')
    const path = await session('/v1/actions/nope', put(apply({ backend: { type: 'job', starter: 'jobs', template: '../etc/passwd', image: 'x' } })))
    expect((await json(path)).error).toContain('it is one of the starter\'s own, never a path')
    const env = await session('/v1/actions/nope', put(apply({ backend: { type: 'job', starter: 'jobs', template: 'infra-apply', image: 'x', env: { ORRERY_TOKEN: 'mine' } } })))
    expect((await json(env)).error).toContain('a name that starts with ORRERY_ is what the hub and the starter hand the job')
    const tool = await session('/v1/actions/nope', put({ ...apply(), access: undefined, tool: { tier: 'act' } }))
    expect((await json(tool)).error).toContain('a tool runs on a runner')
    await define('apply_workspace', apply())
  })
})

describe('a job run', () => {
  it('starts the moment it is approved, with nobody who asked awake, and is handed a credential for that run alone', async () => {
    await define('apply_approved', apply({ approval: true, ceiling: '12h' }))
    const asked = await ask(ada, 'apply_approved', { workspace: 'network', plan: 'x'.repeat(200_000) })
    expect(asked.state).toBe('awaiting')
    expect(await claim()).toEqual([])
    expect((await session(`/v1/action-runs/${asked.id}/approve`, post({}))).status).toBe(200)
    const queued = await run(asked.id)
    expect(queued.state).toBe('queued')
    expect(queued.log.at(-1)!.message).toBe('queued for starter jobs, which starts its job')
    // Another runner source claims nothing of it.
    expect(await claim(other)).toEqual([])
    const [job, ...rest] = await claim()
    expect(rest).toEqual([])
    expect(job).toMatchObject({ run: asked.id, action: 'apply_approved', try: 1, template: 'infra-apply', image: 'registry.example.org/infra:1.4.0', command: ['infra', 'apply'], args: ['--workspace', 'network'], env: { WORKSPACE: 'network', ASKED_BY: 'ada@example.org' }, ceilingMs: 12 * 3_600_000 })
    expect(job!.token).toMatch(/^orr_run_/)
    const going = await run(asked.id)
    expect(going).toMatchObject({ state: 'running', claimedBy: 'jobs' })
    expect(going.log.at(-1)!.message).toBe('claimed by starter jobs')
    expect(await claim()).toEqual([])
    // The hub keeps the credential's hash alone.
    const kept = (await hub.db.query<{ job_token: string }>('SELECT job_token FROM action_runs WHERE id = $1', [asked.id])).rows[0]!.job_token
    expect(kept).not.toContain(job!.token.slice(8))

    // The job says what it does on its own run: a step, lines, an output, its summary.
    const own = (path: string, init?: RequestInit) => machine(path, init, job!.token)
    expect((await own(`/v1/action-runs/${asked.id}/report`, post({ step: 'Plan', log: ['3 to change', '::output:: changes=3'], summary: '3 changes applied', link: 'https://ci.example.org/7' }))).status).toBe(200)
    const said = await run(asked.id)
    expect(said).toMatchObject({ state: 'running', summary: '3 changes applied', link: 'https://ci.example.org/7', outputs: { changes: '3' } })
    expect(said.steps.map((s) => s.name)).toEqual(['Plan'])
    // It reads its own run, whole: the inputs too long for an environment come this way.
    const read = await json<ActionRun>(await own(`/v1/action-runs/${asked.id}`))
    expect((read.inputs.plan as string).length).toBe(200_000)
    // It never says how the run ended: that is read from how its container ends.
    const ended = await own(`/v1/action-runs/${asked.id}/report`, post({ state: 'succeeded' }))
    expect(ended.status).toBe(400)
    expect((await json(ended)).error).toContain('A job says what it does, never how its run ended')

    // The credential reaches nothing else: no other run, no list, no entity, no agent door, and not the session port.
    const second = await ask(ada, 'apply_workspace')
    for (const [path, init] of [[`/v1/action-runs/${second.id}/report`, post({ log: ['x'] })], [`/v1/action-runs/${second.id}`, undefined], ['/v1/action-runs', undefined], ['/v1/entities', undefined], ['/v1/actions', undefined], [`/v1/action-runs/${asked.id}/withdraw`, post({})], [`/v1/action-runs/${asked.id}/approve`, post({})], ['/v1/ingest/starter/jobs', undefined], ['/mcp', post({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })]] as const) expect([path, (await own(path, init)).status]).toEqual([path, 401])
    expect((await hub.app.request(`/v1/action-runs/${asked.id}`, { headers: { authorization: `Bearer ${job!.token}` } }, { surface: 'session' })).status).toBe(401)

    // The starter is told what it holds, says the run is alive, and reports how the container ended.
    expect(await held()).toEqual([{ run: asked.id, try: 1, state: 'running', startedAt: going.startedAt, ceilingMs: 12 * 3_600_000, summary: '3 changes applied' }])
    expect((await says(asked.id, {})).status).toBe(200)
    expect((await says(asked.id, { state: 'succeeded' }, other)).status).toBe(403)
    expect((await says(asked.id, { state: 'succeeded', log: ['the job ended: exit 0'] })).status).toBe(200)
    const done = await run(asked.id)
    expect(done).toMatchObject({ state: 'succeeded', summary: '3 changes applied', outputs: { changes: '3' } })
    // The run ended, and its credential with it.
    expect((await own(`/v1/action-runs/${asked.id}`)).status).toBe(401)
    expect(await held()).toEqual([])
    expect((await held([asked.id])).map((r) => [r.run, r.state])).toEqual([[asked.id, 'succeeded']])
    await session(`/v1/action-runs/${second.id}/withdraw`, post({}))
  })

  it('is stopped by whoever asked, or an admin, and its starter is told to stop the job', async () => {
    const asked = await ask(ada, 'apply_workspace')
    const [job] = await claim()
    expect(job!.ceilingMs).toBe(7 * 86_400_000)
    expect((await json<ActionRun>(await ada(`/v1/action-runs/${asked.id}`))).canStop).toBe(true)
    expect((await json<ActionRun>(await bob(`/v1/action-runs/${asked.id}`))).canStop).toBe(false)
    expect((await bob(`/v1/action-runs/${asked.id}/withdraw`, post({}))).status).toBe(403)
    const stopped = await json<ActionRun>(await ada(`/v1/action-runs/${asked.id}/withdraw`, post({ reason: 'wrong workspace' })))
    expect(stopped.state).toBe('cancelled')
    expect(messages(stopped).slice(-2)).toEqual(['stopped by ada@example.org: wrong workspace', 'its job is stopped by starter jobs as it next asks how its runs stand'])
    expect((await held([asked.id])).map((r) => [r.run, r.state])).toEqual([[asked.id, 'cancelled']])
    expect((await machine(`/v1/action-runs/${asked.id}/report`, post({ log: ['still here'] }), job!.token)).status).toBe(401)
    expect((await says(asked.id, { state: 'failed' })).status).toBe(409)
    const cancelled = (await json<{ changes: { detail: Record<string, unknown> }[] }>(await session('/v1/changes?kind=action.cancelled'))).changes
    expect(cancelled.find((c) => c.detail.run === asked.id)?.detail).toMatchObject({ stopped: true, reason: 'stopped by ada@example.org: wrong workspace' })
    // A run of any other backend under way is not withdrawn: the hub can have nothing stopped.
    const caller = await ask(ada, 'long_work', {})
    await machine(`/v1/action-runs/${caller.id}/report`, post({ state: 'running' }), reporter)
    expect((await json<ActionRun>(await ada(`/v1/action-runs/${caller.id}`))).canStop).toBeUndefined()
    expect((await ada(`/v1/action-runs/${caller.id}/withdraw`, post({}))).status).toBe(409)
    await machine(`/v1/action-runs/${caller.id}/report`, post({ state: 'succeeded' }), reporter)
  })

  it('ends with its outcome unknown when its job is gone, said by its starter alone', async () => {
    const asked = await ask(ada, 'apply_workspace')
    const [job] = await claim()
    const notTheStarter = await machine(`/v1/action-runs/${asked.id}/report`, post({ state: 'unknown' }), reporter)
    expect(notTheStarter.status).toBe(400)
    expect((await says(asked.id, { state: 'unknown', summary: 'its job is gone: nothing in namespace jobs carries this run' })).status).toBe(200)
    const gone = await run(asked.id)
    expect(gone.state).toBe('unknown')
    expect(gone.log.at(-1)!.message).toBe('unknown: its job is gone: nothing in namespace jobs carries this run')
    expect((await machine(`/v1/action-runs/${asked.id}`, undefined, job!.token)).status).toBe(401)
  })

  it('is given up when its starter goes silent, keeps what its job still says, and takes the true end when the starter is back', async () => {
    const asked = await ask(ada, 'apply_workspace')
    const [job] = await claim()
    await aged(asked.id, `started_at = now() - interval '2 hours', heard_at = now() - interval '61 minutes'`)
    expect(await hub.actions.expire()).toBe(1)
    expect((await run(asked.id)).state).toBe('unknown')
    // The job is alive, and still says what it does.
    expect((await machine(`/v1/action-runs/${asked.id}/report`, post({ log: ['applying module network'] }), job!.token)).status).toBe(200)
    // The starter is back: it still finds the job, is told the run is unknown, and reports how the job ended.
    expect((await held([asked.id])).map((r) => [r.run, r.state])).toEqual([[asked.id, 'unknown']])
    expect((await says(asked.id, { state: 'succeeded' })).status).toBe(200)
    const settled = await run(asked.id)
    expect(settled.state).toBe('succeeded')
    expect(messages(settled)).toContain('applying module network')
    expect((await machine(`/v1/action-runs/${asked.id}`, undefined, job!.token)).status).toBe(401)
  })

  it('is given up a little past its ceiling, the time its starter has to stop the job', async () => {
    await define('apply_short', apply({ ceiling: '1h' }))
    const asked = await ask(ada, 'apply_short')
    await claim()
    await aged(asked.id, `started_at = now() - interval '64 minutes', heard_at = now()`)
    expect(await hub.actions.expire()).toBe(0)
    await aged(asked.id, `started_at = now() - interval '66 minutes', heard_at = now()`)
    expect(await hub.actions.expire()).toBe(1)
    expect((await run(asked.id)).log.at(-1)!.message).toMatch(/^no result after 65 minutes; given up/)
  })

  it('is tried again as a new job, with a new credential, when its action retries', async () => {
    await define('apply_retry', apply({ retry: { tries: 2, backoff: '1s' } }))
    const asked = await ask(ada, 'apply_retry')
    const [first] = await claim()
    expect((await says(asked.id, { state: 'failed', summary: 'exit 1' })).status).toBe(200)
    expect((await run(asked.id)).state).toBe('queued')
    expect((await machine(`/v1/action-runs/${asked.id}`, undefined, first!.token)).status).toBe(401)
    await aged(asked.id, `retry_at = now() - interval '1 second'`)
    await hub.actions.retryDue()
    const [second] = await claim()
    expect(second).toMatchObject({ run: asked.id, try: 2 })
    expect(second!.token).not.toBe(first!.token)
    expect((await machine(`/v1/action-runs/${asked.id}`, undefined, first!.token)).status).toBe(401)
    expect((await machine(`/v1/action-runs/${asked.id}`, undefined, second!.token)).status).toBe(200)
    expect((await held()).find((r) => r.run === asked.id)).toMatchObject({ try: 2, state: 'running' })
    expect((await says(asked.id, { state: 'failed', summary: 'exit 1' })).status).toBe(200)
    expect((await run(asked.id)).state).toBe('failed')
  })

  it('waits its turn in the hub when its action runs a few at a time', async () => {
    await define('apply_one', apply({ concurrency: 1 }))
    const first = await ask(ada, 'apply_one', { workspace: 'east' })
    const second = await ask(ada, 'apply_one', { workspace: 'west' })
    expect((await claim()).map((j) => j.run)).toEqual([first.id])
    expect(await claim()).toEqual([])
    expect((await says(first.id, { state: 'succeeded' })).status).toBe(200)
    expect((await claim()).map((j) => j.run)).toEqual([second.id])
    await says(second.id, { state: 'succeeded' })
  })

  it('fails a run whose image renders to nothing, before any job is started', async () => {
    await define('apply_blank', apply({ backend: { type: 'job', starter: 'jobs', template: 'infra-apply', image: '{{ inputs.tag }}' }, inputs: { tag: { type: 'string' } } }))
    const asked = await ask(ada, 'apply_blank', {})
    expect(await claim()).toEqual([])
    const failed = await run(asked.id)
    expect(failed.state).toBe('failed')
    expect(failed.log.at(-1)!.message).toBe('cannot render the job: its image renders to nothing')
  })
})

describe('a job whose template reads its entity', () => {
  let owner = ''
  let stranger = ''
  const admin = { admin: true, permissions: [] as never[], kind: 'user' as const, name: 'local', roles: [] }
  const reading = 'infra-apply-{{ entity.fields.infra_principal }}'
  const zoned = (extra: Record<string, unknown> = {}) => ({ title: 'Apply a workspace', blueprint: 'workspace', inputs: { reason: { type: 'string' } }, backend: { type: 'job', starter: 'jobs', template: reading, image: 'registry.example.org/infra:1' }, access: { everyone: true }, ...extra })
  const workspace = (principal: Record<string, unknown> = { overridable: false }) => ({ title: 'Workspace', fields: { infra_principal: { type: 'string', ...principal, access: { grants: [{ values: ['bob@example.org'] }] } }, team: { type: 'string' } }, relations: {} })
  const push = (bearer: string, key: string, fields: Record<string, unknown>, method = 'PUT') => machine(`/v1/ingest/entities/workspace/${key}`, { method, body: JSON.stringify(method === 'PUT' ? { title: key, fields } : { fields, mode: 'enrich' }) }, bearer)
  const on = (who: typeof ada, action: string, key: string, inputs: Record<string, unknown> = {}) => who(`/v1/actions/${action}/run`, post({ entity: { blueprint: 'workspace', key }, inputs }))
  const patch = (who: typeof ada, key: string, fields: Record<string, unknown>) => who(`/v1/entities/workspace/${key}`, { method: 'PATCH', body: JSON.stringify({ fields }) })
  const refused = async (id: string, spec: Record<string, unknown>) => {
    const res = await session(`/v1/actions/${id}`, put(spec))
    expect(res.status).toBeGreaterThanOrEqual(400)
    return String((await json(res)).error)
  }
  /** The template each run named was handed to the starter under, then every job ended. */
  const started = async () => {
    const jobs = await claim()
    for (const job of jobs) await says(job.run, { state: 'succeeded' })
    return Object.fromEntries(jobs.map((j) => [j.run, j.template]))
  }

  beforeAll(async () => {
    expect((await session('/v1/blueprints/workspace', put(workspace()))).status).toBe(200)
    await hub.sources.save('cmdb', { title: 'CMDB', class: 'pusher', blueprints: ['*'], deleteGrant: [], cadence: '1h' })
    owner = (await hub.sources.issueToken('source', 'k8s', { source: 'k8s' })).token
    stranger = (await hub.sources.issueToken('source', 'cmdb', { source: 'cmdb' })).token
    expect((await push(owner, 'network', { infra_principal: 'network-prod', team: 'net' })).status).toBe(201)
    expect((await push(owner, 'dns', { infra_principal: 'dns-nonprod' })).status).toBe(201)
    expect((await push(owner, 'bare', { team: 'none' })).status).toBe(201)
    expect((await push(owner, 'odd', { infra_principal: '../kube-system' })).status).toBe(201)
  })

  it('is refused a template that reads what a caller chooses, or a field that is not locked', async () => {
    expect(await refused('apply_zone', zoned({ inputs: { zone: { type: 'string' } }, backend: { ...zoned().backend, template: 'infra-apply-{{ inputs.zone }}' } }))).toContain('never "inputs.zone", which whoever asks chooses')
    expect(await refused('apply_zone', zoned({ backend: { ...zoned().backend, template: 'infra-apply-{{ by.name }}' } }))).toContain('never "by.name", which is whoever asks')
    expect(await refused('apply_zone', zoned({ backend: { ...zoned().backend, template: 'infra-apply-{{ entity.key }}' } }))).toContain('never "entity.key"')
    expect(await refused('apply_zone', zoned({ backend: { ...zoned().backend, template: 'infra-apply-{{ entity.fields.team }}' } }))).toContain('workspace.team, which is not locked')
    expect(await refused('apply_zone', zoned({ blueprint: undefined }))).toContain('needs one to read, so the action needs a blueprint')
    expect(await refused('apply_zone', zoned({ refreshes: ['infra_principal'] }))).toContain('no run writes it')
    await define('apply_zone', zoned())
    // From the save on, the hub holds the field as it holds every value access is decided from.
    expect((await json<{ decides?: { names: string[] } }>(await session('/v1/blueprints/workspace'))).decides?.names).toContain('infra_principal')
  })

  it('starts each run from the template its own entity names, whatever whoever asked sends or sees', async () => {
    // Ada may run it, and may not even read the field that names what it runs as.
    expect((await json<{ fields: Record<string, unknown> }>(await ada('/v1/entities/workspace/network'))).fields).not.toHaveProperty('infra_principal')
    const network = await json<ActionRun>(await on(ada, 'apply_zone', 'network', { reason: 'infra-apply-dns-nonprod' }))
    const dns = await json<ActionRun>(await on(ada, 'apply_zone', 'dns', { reason: 'network-prod' }))
    const sneaky = await on(ada, 'apply_zone', 'dns', { reason: 'x', infra_principal: 'network-prod', template: 'infra-apply-network-prod' })
    const templates = await started()
    expect(templates[network.id]).toBe('infra-apply-network-prod')
    expect(templates[dns.id]).toBe('infra-apply-dns-nonprod')
    // An input the action does not declare changes nothing, whether the hub drops it or refuses the request.
    if (sneaky.ok) expect(templates[(await json<ActionRun>(sneaky)).id]).toBe('infra-apply-dns-nonprod')
    else expect(sneaky.status).toBe(400)
    // The run's log names no template, so it tells nobody what the field holds.
    expect(messages(await run(network.id)).join('\n')).not.toContain('network-prod')
  })

  it('lets nobody who may run it change what its entity names: only the source that owns the entity does', async () => {
    await hub.access.saveRole('security', { title: 'Security contributor', permissions: ['entities.edit', 'access.values'] }, admin)
    await hub.access.setRoles('bob@example.org', ['security'], admin)
    // By hand: not a person who changes what access is decided from, and not an admin.
    expect((await patch(bob, 'dns', { infra_principal: 'network-prod' })).status).toBe(403)
    expect((await patch(session, 'dns', { infra_principal: 'network-prod' })).status).toBe(403)
    expect((await patch(bob, 'dns', { team: 'names' })).status).toBe(200)
    // A source that does not own the entity: refused, though it may write the blueprint and the rest of the entity.
    const foreign = await push(stranger, 'dns', { infra_principal: 'network-prod' }, 'PATCH')
    expect(foreign.status).toBe(422)
    expect(JSON.stringify(await json(foreign))).toContain('access is decided from \\"infra_principal\\"')
    expect((await push(stranger, 'dns', { team: 'cmdb' }, 'PATCH')).status).toBe(200)
    // An action: neither one that records the entity, nor one whose run hands the field back.
    expect(await refused('set_principal', { title: 'Set the principal', inputs: { key: { type: 'string', required: true }, principal: { type: 'string', required: true } }, backend: { type: 'record', source: 'k8s', blueprint: 'workspace', key: '{{ inputs.key }}', fields: { infra_principal: '{{ inputs.principal }}' } } })).toContain('access is decided from "infra_principal"')
    expect(await refused('learn_principal', { title: 'Learn the principal', blueprint: 'workspace', inputs: {}, backend: { type: 'caller' }, refreshes: ['infra_principal'] })).toContain('access is decided from "infra_principal"')
    const still = await json<ActionRun>(await on(ada, 'apply_zone', 'dns'))
    expect((await started())[still.id]).toBe('infra-apply-dns-nonprod')
    // The estate's own source moves it, and the next run follows the model.
    expect((await push(owner, 'dns', { infra_principal: 'dns-prod' })).status).toBe(200)
    const moved = await json<ActionRun>(await on(ada, 'apply_zone', 'dns'))
    expect((await started())[moved.id]).toBe('infra-apply-dns-prod')
    await hub.access.setRoles('bob@example.org', [], admin)
  })

  it('is refused while another action writes the field its template would read', async () => {
    expect((await session('/v1/blueprints/stack', put({ title: 'Stack', fields: { principal: { type: 'string', overridable: false }, seen: { type: 'string', overridable: false } }, relations: {} }))).status).toBe(200)
    await define('name_stack', { title: 'Name a stack', inputs: { key: { type: 'string', required: true }, principal: { type: 'string', required: true } }, backend: { type: 'record', source: 'k8s', blueprint: 'stack', key: '{{ inputs.key }}', fields: { principal: '{{ inputs.principal }}' } } })
    await define('see_stack', { title: 'See a stack', blueprint: 'stack', inputs: {}, backend: { type: 'caller' }, refreshes: ['seen'] })
    const stacked = (field: string) => zoned({ blueprint: 'stack', backend: { ...zoned().backend, template: `infra-apply-{{ entity.fields.${field} }}` } })
    expect(await refused('apply_stack', stacked('principal'))).toContain('it reads stack.principal, which the action "name_stack" writes, so whoever runs that one would choose what this job runs as')
    expect(await refused('apply_stack', stacked('seen'))).toContain('it reads stack.seen, which the action "see_stack" writes')
    expect((await session('/v1/actions/name_stack', { method: 'DELETE' })).status).toBeLessThan(300)
    await define('apply_stack', stacked('principal'))
  })

  it('refuses a run on an entity that names no template, alone or in a batch', async () => {
    const none = await on(ada, 'apply_zone', 'bare')
    expect(none.status).toBe(409)
    expect((await json(none)).error).toBe('Action "apply_zone" cannot run here: its template reads "infra_principal", which on this entity holds nothing a job template is named by: lowercase letters, digits, - and _')
    const odd = await on(ada, 'apply_zone', 'odd')
    expect(odd.status).toBe(409)
    expect(JSON.stringify(await json(odd))).not.toContain('kube-system')
    await define('apply_zones', zoned({ batch: { max: 10 } }))
    const three = { entities: ['network', 'bare', 'dns'].map((key) => ({ blueprint: 'workspace', key })), inputs: {} }
    // The preview says so before anything is asked, and the batch itself holds to it.
    const preview = await json<{ entities: number; refused: { key: string; reason: string }[] }>(await session('/v1/actions/apply_zones/batch/preview', post(three)))
    expect(preview.refused).toEqual([expect.objectContaining({ key: 'bare', reason: expect.stringContaining('It cannot run here: its template reads "infra_principal"') })])
    const batch = await json<{ id: string; asked: number; refused: number }>(await session('/v1/actions/apply_zones/batch', post(three)))
    expect(batch).toMatchObject({ asked: 2, refused: 1 })
    expect((await json<{ refusedItems: { key: string; reason: string }[] }>(await session(`/v1/action-batches/${batch.id}`))).refusedItems).toEqual([expect.objectContaining({ key: 'bare', reason: expect.stringContaining('holds nothing a job template is named by') })])
    expect(Object.values(await started()).sort()).toEqual(['infra-apply-dns-prod', 'infra-apply-network-prod'])
    expect(await claim()).toEqual([])
  })

  it('reads the entity as the job starts, and fails a run whose entity or field no longer names a template', async () => {
    await define('apply_zone_approved', zoned({ approval: true }))
    // Approved after its source moved the entity: it runs as the model says when it starts.
    const waited = await json<ActionRun>(await on(ada, 'apply_zone_approved', 'network'))
    expect(waited.state).toBe('awaiting')
    expect((await push(owner, 'network', { infra_principal: 'network-nonprod' })).status).toBe(200)
    expect((await session(`/v1/action-runs/${waited.id}/approve`, post({}))).status).toBe(200)
    expect((await started())[waited.id]).toBe('infra-apply-network-nonprod')
    // Approved after its source took the value away: nothing is started.
    const emptied = await json<ActionRun>(await on(ada, 'apply_zone_approved', 'network'))
    expect((await push(owner, 'network', { team: 'net' })).status).toBe(200)
    expect((await session(`/v1/action-runs/${emptied.id}/approve`, post({}))).status).toBe(200)
    expect(await claim()).toEqual([])
    const failed = await run(emptied.id)
    expect(failed.state).toBe('failed')
    expect(failed.log.at(-1)!.message).toBe('cannot render the job: its template reads "infra_principal", which on this entity holds nothing a job template is named by: lowercase letters, digits, - and _')
    expect((await push(owner, 'network', { infra_principal: 'network-prod', team: 'net' })).status).toBe(200)
    // The model unlocks the field after the action was saved: no run starts until it is locked again.
    const queued = await json<ActionRun>(await on(ada, 'apply_zone_approved', 'network'))
    expect((await session('/v1/blueprints/workspace', put(workspace({})))).status).toBe(200)
    const unlocked = await on(ada, 'apply_zone', 'network')
    expect(unlocked.status).toBe(409)
    expect((await json(unlocked)).error).toContain('workspace.infra_principal, which is not locked')
    expect((await session(`/v1/action-runs/${queued.id}/approve`, post({}))).status).toBe(200)
    expect(await claim()).toEqual([])
    expect((await run(queued.id)).log.at(-1)!.message).toContain('cannot render the job: its template reads workspace.infra_principal, which is not locked')
    // Unlocked or not, the hub holds it as what access is decided from: a source that does not own the entity is still refused.
    expect((await push(stranger, 'network', { infra_principal: 'dns-prod' }, 'PATCH')).status).toBe(422)
    expect((await session('/v1/blueprints/workspace', put(workspace()))).status).toBe(200)
    const again = await json<ActionRun>(await on(ada, 'apply_zone', 'network'))
    expect((await started())[again.id]).toBe('infra-apply-network-prod')
  })
})

describe('an agent that asks for a run and stops', () => {
  const rpc = async (method: string, params: Record<string, unknown>, id = 1) => {
    const res = await machine('/mcp', { method: 'POST', headers: { accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) }, reporter)
    const text = await res.text()
    const line = text.split('\n').find((l) => l.startsWith('data:'))
    const said = (JSON.parse(line ? line.slice(5) : text) as { result: { content?: { text: string }[] } }).result.content?.[0]?.text
    return (said ? JSON.parse(said) : {}) as Record<string, unknown>
  }

  it('is told it need not stay for a job, and reads the run later with everything it reported', async () => {
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } })
    const waits = await rpc('tools/call', { name: 'run_action', arguments: { action: 'apply_approved', inputs: { workspace: 'dns' } } }, 2)
    expect(waits.state).toBe('awaiting')
    expect(waits.next).toContain('You do not need to wait or stay connected: once approved it starts by itself, as a job of its own. Read its state, steps, log, outputs, and link at any time with get_action_run.')
    const queued = await rpc('tools/call', { name: 'run_action', arguments: { action: 'apply_workspace', inputs: { workspace: 'dns' } } }, 3)
    expect(queued.state).toBe('queued')
    expect(queued.next).toBe('You do not need to wait or stay connected: it goes on by itself, as a job of its own. Read its state, steps, log, outputs, and link at any time with get_action_run.')
    const mine = await rpc('tools/call', { name: 'run_action', arguments: { action: 'long_work', inputs: {} } }, 4)
    expect(mine.next).toContain('It waits for whoever asked to start it, do the work, and report')
    // Later, with nothing of the asker's held open in between: the job ran and reported.
    const [job] = (await claim()).filter((j) => j.run === queued.run)
    await machine(`/v1/action-runs/${String(queued.run)}/report`, post({ step: 'Apply', log: ['applied'], outputs: { changes: 2 }, summary: '2 changes applied', link: 'https://ci.example.org/9' }), job!.token)
    await says(String(queued.run), { state: 'succeeded' })
    const later = await rpc('tools/call', { name: 'get_action_run', arguments: { id: queued.run } }, 5)
    expect(later).toMatchObject({ state: 'succeeded', summary: '2 changes applied', link: 'https://ci.example.org/9', outputs: { changes: 2 }, steps: [{ name: 'Apply' }] })
    expect((later.log as { message: string }[]).map((l) => l.message)).toContain('applied')
    await session(`/v1/action-runs/${String(waits.run)}/withdraw`, post({}))
    await session(`/v1/action-runs/${String(mine.run)}/withdraw`, post({}))
  })
})
