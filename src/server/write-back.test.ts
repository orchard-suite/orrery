import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { RunnerJob } from '../shared/api.ts'
import type { ActionRun, Change, Entity } from '../shared/model.ts'
import { loadConfig } from './config.ts'
import { createHub, type Hub } from './hub.ts'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://orrery:orrery@localhost:5433/orrery'

let hub: Hub
let apps = ''
let other = ''
let runner = ''

const session = (path: string, init?: RequestInit): Promise<Response> => Promise.resolve(hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', 'x-forwarded-email': 'local@example.org', 'x-forwarded-groups': 'Admin', ...init?.headers } }, { surface: 'session' }))
const machine = (path: string, init: RequestInit | undefined, bearer: string) => hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}`, ...init?.headers } }, { surface: 'machine' })
const json = async <T>(r: Response): Promise<T> => (await r.json()) as T
const body = (v: unknown) => ({ body: JSON.stringify(v) })
const put = (v: unknown) => ({ method: 'PUT', ...body(v) })
const post = (v: unknown) => ({ method: 'POST', ...body(v) })

/** An action that sets an app's allowed origins on a runner, and may write back what it set. */
const origins = (extra: Record<string, unknown> = {}) => ({
  title: 'Set allowed origins',
  description: 'Sets the web origins an app allows.',
  blueprint: 'web_app',
  where: { field: 'allowed_origins', op: 'exists' },
  inputs: { origins: { type: 'string', required: true } },
  access: { everyone: true },
  refreshes: ['allowed_origins', 'allow_credentials'],
  backend: { type: 'runner', runner: 'lan-runner', command: ['set-origins', '{{ inputs.origins }}'] },
  ...extra,
})

const app = async (key: string) => json<Entity>(await session(`/v1/entities/web_app/${key}`))
const run = async (id: string) => json<ActionRun>(await session(`/v1/action-runs/${id}`))
const ask = async (action: string, key: string) => {
  const res = await session(`/v1/actions/${action}/run`, post({ entity: { blueprint: 'web_app', key }, inputs: { origins: 'https://a.example.org' } }))
  expect(res.status).toBe(201)
  return (await json<ActionRun>(res)).id
}
/** The runner's side: claims the job and says what its command printed, then how it ended. */
const answer = async (id: string, lines: string[], state: 'succeeded' | 'failed') => {
  const { jobs } = await json<{ jobs: RunnerJob[] }>(await machine('/v1/ingest/runner/jobs', undefined, runner))
  expect(jobs.map((j) => j.run)).toEqual([id])
  expect((await machine(`/v1/ingest/runner/jobs/${id}/report`, post({ state: 'running', log: lines }), runner)).status).toBe(200)
  expect((await machine(`/v1/ingest/runner/jobs/${id}/report`, post({ state }), runner)).status).toBe(200)
  return run(id)
}

beforeAll(async () => {
  const config = loadConfig({ DATABASE_URL, DATA_DIR: mkdtempSync(join(tmpdir(), 'orrery-')), AUTH_MODE: 'proxy', PUBLIC_URL: 'https://hub.example.org' })
  hub = await createHub(config, 'test', { reset: true })
  await hub.sources.save('apps', { title: 'Apps', class: 'pusher', blueprints: ['web_app'], deleteGrant: [], cadence: '1h' })
  await hub.sources.save('other', { title: 'Other', class: 'pusher', blueprints: ['web_app'], deleteGrant: [], cadence: '1h' })
  await hub.sources.save('lan-runner', { title: 'LAN runner', class: 'runner', blueprints: [], deleteGrant: [], cadence: '5m' })
  apps = (await hub.sources.issueToken('source', 'apps', { source: 'apps' })).token
  other = (await hub.sources.issueToken('source', 'other', { source: 'other' })).token
  runner = (await hub.sources.issueToken('source', 'runner', { source: 'lan-runner' })).token
  expect(
    (
      await session(
        '/v1/blueprints/web_app',
        put({
          title: 'Web app',
          fields: {
            allowed_origins: { type: 'array' },
            allow_credentials: { type: 'boolean' },
            owner_team: { type: 'string' },
            open: { type: 'number', calculation: 'allow_credentials ? 1 : 0' },
          },
          relations: {},
        }),
      )
    ).status,
  ).toBe(200)
  for (const key of ['portal', 'shop']) expect((await machine(`/v1/ingest/entities/web_app/${key}`, put({ title: key, fields: { allowed_origins: ['https://old.example.org'], allow_credentials: false, owner_team: 'web' } }), apps)).status).toBeLessThan(300)
  expect((await session('/v1/actions/set_origins', put(origins()))).status).toBe(200)
})

afterAll(async () => {
  await hub.close()
})

describe('saving an action that refreshes', () => {
  it('refuses a name that is not a field, or one the hub works out', async () => {
    const unknown = await session('/v1/actions/bad_refresh', put(origins({ refreshes: ['allowed_origins', 'nope'] })))
    expect(unknown.status).toBe(400)
    expect(((await json<{ error: string }>(unknown)).error)).toContain('web_app has no field "nope"')
    const derived = await session('/v1/actions/bad_refresh', put(origins({ refreshes: ['open'] })))
    expect(derived.status).toBe(400)
    expect(((await json<{ error: string }>(derived)).error)).toContain('web_app.open is worked out by the hub (a calculation)')
  })

  it('refuses a backend that reports nothing back, and an action on no blueprint', async () => {
    const record = await session('/v1/actions/bad_refresh', put(origins({ backend: { type: 'record', source: 'apps', blueprint: 'web_app', key: 'x' } })))
    expect(((await json<{ error: string }>(record)).error)).toContain('a record backend reports nothing back')
    const answered = await session('/v1/actions/bad_refresh', put(origins({ backend: { type: 'webhook', url: 'https://hooks.example.org/x', finish: 'answer' } })))
    expect(((await json<{ error: string }>(answered)).error)).toContain('ends on its answer')
    const { blueprint: _b, where: _w, ...global } = origins()
    const nowhere = await session('/v1/actions/bad_refresh', put(global))
    expect(((await json<{ error: string }>(nowhere)).error)).toContain('the action needs a blueprint')
  })

  it('takes a caller backend', async () => {
    expect((await session('/v1/actions/caller_refresh', put(origins({ backend: { type: 'caller' } })))).status).toBe(200)
  })
})

describe('writing back what a run changed', () => {
  it('guards the field: a source that does not own the entity may not write it', async () => {
    const res = await machine('/v1/ingest/entities/web_app/portal', { method: 'PATCH', ...body({ fields: { allowed_origins: ['https://evil.example.org'] } }) }, other)
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect((await app('portal')).fields.allowed_origins).toEqual(['https://old.example.org'])
  })

  it('writes the named fields on its own entity as its owner once the run succeeds', async () => {
    const id = await ask('set_origins', 'portal')
    const done = await answer(id, ['::step:: Set', 'setting origins', '::refresh:: allowed_origins=["https://a.example.org","https://b.example.org"]', '::refresh:: allow_credentials=true', '::refresh:: owner_team="platform"', '::step:: Verify'], 'succeeded')
    expect(done.state).toBe('succeeded')
    expect(done.wroteBack).toEqual([
      { field: 'allowed_origins', was: ['https://old.example.org'], now: ['https://a.example.org', 'https://b.example.org'] },
      { field: 'allow_credentials', was: false, now: true },
    ])
    const messages = done.log.map((l) => l.message)
    expect(messages.some((m) => m.startsWith('not written back: "owner_team" is not a field this action refreshes'))).toBe(true)
    expect(messages).toContain('wrote back allowed_origins, allow_credentials on web_app:portal, as apps')
    expect(messages.some((m) => m.startsWith('::refresh::'))).toBe(false)
    const portal = await app('portal')
    expect(portal.fields.allowed_origins).toEqual(['https://a.example.org', 'https://b.example.org'])
    expect(portal.fields.allow_credentials).toBe(true)
    expect(portal.fields.owner_team).toBe('web')
    expect(portal.owner).toBe('apps')
    // Only the run's own entity moved.
    expect((await app('shop')).fields.allowed_origins).toEqual(['https://old.example.org'])
    const rows = (await json<{ changes: Change[] }>(await session('/v1/changes?kind=action.wrote_back'))).changes
    expect(rows[0]).toMatchObject({ kind: 'action.wrote_back', blueprint: 'web_app', key: 'portal', source: 'apps', detail: { run: id, action: 'set_origins', fields: done.wroteBack } })
  })

  it('lets the owning source write over it on its next push', async () => {
    expect((await machine('/v1/ingest/entities/web_app/portal', put({ title: 'portal', fields: { allowed_origins: ['https://pushed.example.org'], allow_credentials: false, owner_team: 'web' } }), apps)).status).toBeLessThan(300)
    expect((await app('portal')).fields.allowed_origins).toEqual(['https://pushed.example.org'])
  })

  it('writes nothing when the run fails', async () => {
    const id = await ask('set_origins', 'shop')
    const done = await answer(id, ['::refresh:: allowed_origins=["https://never.example.org"]'], 'failed')
    expect(done.state).toBe('failed')
    expect(done.wroteBack).toBeUndefined()
    expect(done.log.map((l) => l.message)).toContain('nothing written back: the run ended failed')
    expect((await app('shop')).fields.allowed_origins).toEqual(['https://old.example.org'])
  })

  it('refuses a value of the wrong type alone, and the run still succeeds', async () => {
    const id = await ask('set_origins', 'shop')
    const done = await answer(id, ['::refresh:: allowed_origins=https://not-a-list.example.org', '::refresh:: allow_credentials=true'], 'succeeded')
    expect(done.state).toBe('succeeded')
    expect(done.wroteBack).toEqual([{ field: 'allow_credentials', was: false, now: true }])
    expect(done.log.map((l) => l.message)).toEqual(expect.arrayContaining([expect.stringMatching(/^not written back: allowed_origins: expected an array/)]))
    const shop = await app('shop')
    expect(shop.fields.allowed_origins).toEqual(['https://old.example.org'])
    expect(shop.fields.allow_credentials).toBe(true)
  })

  it('reads the same line from a backend that reports for itself', async () => {
    const id = await ask('caller_refresh', 'shop')
    const reporter = (await hub.sources.issueToken('access', 'reporter', { role: 'admin' })).token
    expect((await machine(`/v1/action-runs/${id}/report`, post({ state: 'running', log: ['::refresh:: allowed_origins=["https://c.example.org"]'] }), reporter)).status).toBe(200)
    expect((await machine(`/v1/action-runs/${id}/report`, post({ state: 'succeeded' }), reporter)).status).toBe(200)
    expect((await run(id)).wroteBack).toEqual([{ field: 'allowed_origins', was: ['https://old.example.org'], now: ['https://c.example.org'] }])
  })
})
