import { randomUUID } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActionRun } from '../shared/model.ts'
import { Behalf, BehalfError, askingAs, parseDelegates } from './behalf.ts'
import { loadConfig } from './config.ts'
import { createHub, type Hub } from './hub.ts'
import { createLogger } from './log.ts'
import { SecretBox } from './secrets.ts'
import { idTokenVerifier } from './signin.ts'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://orrery:orrery@localhost:5433/orrery'
const ISSUER = 'https://login.example.com/tenant/v2.0'
const AUDIENCE = 'orrery-login-proxy'
const SCOPE = 'access_as_user'

let hub: Hub
let issuer: Server
let api: Server
let apiUrl: string
let sign: (claims: Record<string, unknown>) => Promise<string>
/** Signs as the issuer does for its own APIs: a token for the hub's audience that no key the issuer publishes verifies. */
let signLapsed: (claims: Record<string, unknown>) => Promise<string>
/** What the issuer was asked, and what the API was called with. */
const grants: URLSearchParams[] = []
const calls: { method: string; url: string; headers: IncomingHttpHeaders; body: string }[] = []
let apiAnswer = 200
/** A token the hub made for dev, as an agent holds one. */
let agentKey: string
let issuerRefuses = false
/** The issuer as it is once the approval's own access token has ended: it trades no assertion, and redeems only a grant it issued. */
let assertionsEnded = false
/** The issuer hands out access tokens that end at once, so none is kept for a later run. */
let shortLived = false
/** The issuer gives no grant that lasts. */
let noRefresh = false
/** While set, the API answers nothing until it resolves. */
let apiGate: Promise<void> | null = null
const kept: Record<string, string | undefined> = {}

const listen = (server: Server) => new Promise<string>((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(server.address() as { port: number }).port}`)))
const body = (v: unknown) => ({ body: JSON.stringify(v) })
const id = (email: string, roles = ['User']) => sign({ email, roles })
const access = (email: string, roles = ['User']) => sign({ email, roles, scp: SCOPE })
/** A signed-in request: the ID token, and the person's access token for the hub when the login proxy passes one. */
const session = async (email: string, path: string, init: RequestInit = {}, opts: { roles?: string[]; accessFor?: string | null; lapsed?: boolean } = {}) => {
  const theirs: Record<string, string> = opts.accessFor === null ? {} : { 'x-forwarded-access-token': opts.lapsed ? await signLapsed({ email, roles: opts.roles ?? ['User'], scp: SCOPE }) : await access(opts.accessFor ?? email, opts.roles) }
  return hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${await id(email, opts.roles)}`, ...theirs } }, { surface: 'session' })
}
const admin = (path: string, init?: RequestInit) => session('admin@example.org', path, init, { roles: ['Admin'] })
const unlock = (backend: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  title: 'Unlock an account',
  description: 'Unlocks a locked account.',
  blueprint: 'account',
  inputs: {},
  access: { everyone: true },
  backend: { type: 'webhook', url: `${apiUrl}/users/{{ entity.key }}/unlock`, onBehalf: 'ops', finish: 'answer', body: {}, ...backend },
  ...extra,
})
const run = async (res: Response): Promise<ActionRun> => (await res.json()) as ActionRun

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256')
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' }
  sign = (claims) => new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer(ISSUER).setAudience(AUDIENCE).setIssuedAt().setJti(randomUUID()).setExpirationTime('5m').sign(privateKey)
  const elsewhere = await generateKeyPair('RS256')
  signLapsed = (claims) => new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'k1', nonce: 'graph' }).setIssuer(ISSUER).setAudience(AUDIENCE).setIssuedAt().setJti(randomUUID()).setExpirationTime('5m').sign(elsewhere.privateKey)
  issuer = createServer((req, res) => {
    let text = ''
    req.on('data', (chunk: Buffer) => (text += chunk.toString()))
    req.on('end', () => {
      const asked = new URLSearchParams(text)
      grants.push(asked)
      const refreshing = asked.get('grant_type') === 'refresh_token'
      const who = refreshing ? (asked.get('refresh_token') ?? '').replace(/^refresh-\d+-/, '') : asked.get('assertion') ? assertionOf(asked) : ''
      const refused = issuerRefuses ? 'AADSTS65001: The user has not consented.\nTrace ID: 1' : !refreshing && assertionsEnded ? 'AADSTS500133: Assertion is not within its valid time range.\nTrace ID: 2' : refreshing && !who ? 'AADSTS9002313: Invalid request.' : null
      const scope = asked.get('scope') ?? ''
      const lasting = !noRefresh && (refreshing || scope.split(' ').includes('offline_access'))
      res.writeHead(refused ? 400 : 200, { 'content-type': 'application/json' }).end(JSON.stringify(refused ? { error: 'invalid_grant', error_description: refused } : { access_token: `for-${scope.replace(/ offline_access$/, '')}`, expires_in: shortLived ? 60 : 3600, ...(lasting ? { refresh_token: `refresh-${grants.length}-${who}` } : {}) }))
    })
  })
  api = createServer((req, res) => {
    let text = ''
    req.on('data', (chunk: Buffer) => (text += chunk.toString()))
    req.on('end', () => {
      calls.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: text })
      void (apiGate ?? Promise.resolve()).then(() => res.writeHead(apiAnswer).end(apiAnswer >= 400 ? '{"userRoles":"Support"}' : '{"unlocked":true}'))
    })
  })
  const issuerUrl = await listen(issuer)
  apiUrl = await listen(api)
  const dir = mkdtempSync(join(tmpdir(), 'orrery-'))
  writeFileSync(join(dir, 'token'), 'the-pods-projected-token\n')
  for (const [k, v] of Object.entries({ AZURE_TENANT_ID: 'tenant', AZURE_CLIENT_ID: 'hub-app', AZURE_FEDERATED_TOKEN_FILE: join(dir, 'token'), AZURE_AUTHORITY_HOST: issuerUrl })) {
    kept[k] = process.env[k]
    process.env[k] = v
  }
  const config = loadConfig({ DATABASE_URL, DATA_DIR: dir, AUTH_MODE: 'proxy', AUTH_ISSUER: ISSUER, AUTH_AUDIENCE: AUDIENCE, AUTH_API_SCOPE: SCOPE, AUTH_DELEGATES: JSON.stringify({ ops: { scope: 'api://ops/.default', urls: [`${apiUrl}/users/`] } }) })
  hub = await createHub(config, 'test', { reset: true, idTokens: idTokenVerifier(ISSUER, AUDIENCE, createLocalJWKSet({ keys: [jwk] }), SCOPE) })
  const made = await admin('/v1/blueprints/account', { method: 'PUT', ...body({ title: 'Account', fields: {}, relations: {} }) })
  expect(await made.text()).toContain('account')
  await hub.sources.save('seed@test', { title: 'seed', class: 'pusher', blueprints: ['*'], deleteGrant: [], cadence: '3m' })
  const pusher = (await hub.sources.issueToken('source', 'seed', { source: 'seed@test' })).token
  expect((await hub.app.request('/v1/ingest/entities/account/ada', { method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${pusher}` }, ...body({ title: 'Ada' }) }, { surface: 'machine' })).status).toBe(201)
  expect((await hub.app.request('/v1/ingest/entities/account/bob', { method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${pusher}` }, ...body({ title: 'Bob' }) }, { surface: 'machine' })).status).toBe(201)
  await session('dev@example.org', '/v1/whoami')
  expect((await admin('/v1/actions/unlock', { method: 'PUT', ...body(unlock()) })).status).toBe(200)
  // An action made as a person that waits for approval: dev and lead may run it anywhere, and outsider, who holds actions.approve, only on bob.
  const local = { admin: true, permissions: [] as never[], kind: 'user' as const, name: 'local', roles: [] }
  await hub.access.saveRole('lead', { title: 'Lead', permissions: ['actions.approve'] }, local)
  await hub.access.addUser('lead@example.org', ['lead'], local)
  await hub.access.addUser('outsider@example.org', ['lead'], local)
  expect((await admin('/v1/actions/gated', { method: 'PUT', ...body(unlock({}, { approval: true, batch: { max: 5 }, access: { rules: [{ grants: [{ values: ['dev@example.org', 'lead@example.org'] }] }, { grants: [{ values: ['outsider@example.org'] }], where: { field: '$key', op: 'eq', value: 'bob' } }] } })) })).status).toBe(200)
  agentKey = (await hub.sources.issueToken('personal', 'agent', { owner: 'dev@example.org' })).token
})

afterAll(async () => {
  for (const [k, v] of Object.entries(kept)) if (v === undefined) delete process.env[k]
  else process.env[k] = v
  issuer.close()
  api.close()
  await hub.close()
})

beforeEach(() => {
  grants.length = 0
  calls.length = 0
  apiAnswer = 200
  issuerRefuses = false
  assertionsEnded = false
  shortLived = false
  noRefresh = false
  apiGate = null
})

const ask = (email: string, opts?: { accessFor?: string | null; lapsed?: boolean }, action = 'unlock') => session(email, `/v1/actions/${action}/run`, { method: 'POST', ...body({ entity: { blueprint: 'account', key: 'ada' }, inputs: {} }) }, opts)

describe('a webhook called as the person who asked', () => {
  it('trades their own token for the API\'s and ends the run on the answer', async () => {
    const done = await run(await ask('dev@example.org'))
    expect(done.state).toBe('succeeded')
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ method: 'POST', url: '/users/ada/unlock' })
    expect(calls[0]!.headers.authorization).toBe('Bearer for-api://ops/.default')
    const grant = grants.at(-1)!
    expect(grant.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer')
    expect(grant.get('requested_token_use')).toBe('on_behalf_of')
    expect(grant.get('client_id')).toBe('hub-app')
    expect(grant.get('client_assertion')).toBe('the-pods-projected-token')
    // The assertion is the person's access token for the hub, never their ID token.
    const claims = JSON.parse(Buffer.from(grant.get('assertion')!.split('.')[1]!, 'base64url').toString()) as { email: string; scp: string }
    expect(claims).toMatchObject({ email: 'dev@example.org', scp: SCOPE })
    expect(done.log.at(-1)!.message).toContain('webhook answered 200')
  })

  it('fails the run with what the API said when it refuses the person', async () => {
    apiAnswer = 403
    const done = await run(await ask('dev@example.org'))
    expect(done.state).toBe('failed')
    expect(done.log.at(-1)!.message).toContain('answered 403')
    expect(done.log.at(-1)!.message).toContain('Support')
  })

  it('calls nothing when the request carries no token of theirs', async () => {
    const done = await run(await ask('dev@example.org', { accessFor: null }))
    expect(done.state).toBe('failed')
    expect(done.log.at(-1)!.message).toContain('only their own signed-in request, or their own signed-in approval, can start it')
    expect(calls).toHaveLength(0)
    expect(grants).toHaveLength(0)
  })

  it('never uses a token that names someone else, and sends them to sign in again', async () => {
    const res = await ask('dev@example.org', { accessFor: 'admin@example.org' })
    expect(res.status).toBe(401)
    expect(((await res.json()) as { signIn?: string }).signIn).toBe('/oauth2/start')
    expect(calls).toHaveLength(0)
    expect(grants).toHaveLength(0)
  })

  it('says why when the issuer gives no token', async () => {
    issuerRefuses = true
    // Another person, so no token kept from an earlier run answers.
    const done = await run(await ask('other@example.org'))
    expect(done.state).toBe('failed')
    expect(done.log.at(-1)!.message).toContain('AADSTS65001')
    expect(done.log.at(-1)!.message).not.toContain('Trace ID')
    expect(calls).toHaveLength(0)
  })

  it('sends the token only where the delegate lists', async () => {
    expect((await admin('/v1/actions/elsewhere', { method: 'PUT', ...body(unlock({ url: `${apiUrl}/other/{{ entity.key }}` })) })).status).toBe(200)
    const done = await run(await ask('dev@example.org', undefined, 'elsewhere'))
    expect(done.state).toBe('failed')
    expect(done.log.at(-1)!.message).toContain('may not be called at')
    expect(calls).toHaveLength(0)
  })

  it('adds a rendered query to the URL, encoded, leaving out what nobody filled', async () => {
    const spec = unlock({ url: `${apiUrl}/users/{{ entity.key }}/properties`, method: 'PUT', query: { title: '{{ inputs.title }}', manager: '{{ inputs.manager }}' } }, { inputs: { title: { type: 'string' }, manager: { type: 'string' } } })
    expect((await admin('/v1/actions/props', { method: 'PUT', ...body(spec) })).status).toBe(200)
    const res = await session('dev@example.org', '/v1/actions/props/run', { method: 'POST', ...body({ entity: { blueprint: 'account', key: 'ada' }, inputs: { title: 'Lead & Owner #1' } }) })
    expect((await run(res)).state).toBe('succeeded')
    expect(calls[0]).toMatchObject({ method: 'PUT', url: '/users/ada/properties?title=Lead+%26+Owner+%231' })
  })

  it('takes a person\'s access token on the machine port the same way', async () => {
    const res = await hub.app.request('/v1/actions/unlock/run', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${await access('dev@example.org')}` }, ...body({ entity: { blueprint: 'account', key: 'ada' }, inputs: {} }) }, { surface: 'machine' })
    expect((await run(res)).state).toBe('succeeded')
    expect(calls).toHaveLength(1)
  })

  it('refuses a definition that would hand the run on later or with a secret', async () => {
    const saved = async (spec: Record<string, unknown>) => {
      const res = await admin('/v1/actions/bad', { method: 'PUT', ...body(spec) })
      return { status: res.status, text: await res.text() }
    }
    expect(await saved(unlock({ secretRef: 'x' }))).toMatchObject({ status: 400, text: expect.stringContaining('no secret') })
    expect(await saved(unlock({ finish: 'reveal', method: 'GET', body: undefined }, { approval: true }))).toMatchObject({ status: 400, text: expect.stringContaining('cannot wait for approval') })
    expect(await saved(unlock({}, { retry: { tries: 2, backoff: '10s' } }))).toMatchObject({ status: 400, text: expect.stringContaining('try it again later') })
  })

  it('gives a revealed answer to the request that asked, and keeps it nowhere', async () => {
    expect((await admin('/v1/actions/recover', { method: 'PUT', ...body(unlock({ method: 'GET', finish: 'reveal', body: undefined, url: `${apiUrl}/users/{{ entity.key }}/key` })) })).status).toBe(200)
    const done = await run(await session('dev@example.org', '/v1/actions/recover/run', { method: 'POST', ...body({ entity: { blueprint: 'account', key: 'ada' } }) }))
    expect(done.state).toBe('succeeded')
    expect(done.told).toBe('{"unlocked":true}')
    expect(calls.at(-1)).toMatchObject({ method: 'GET', url: '/users/ada/key', body: '' })
    expect(done.log.at(-1)!.message).toBe('webhook answered 200; the answer was given to dev@example.org and not kept')
    // Read again, the run has no answer, and nothing the hub stored holds it.
    const again = await run(await session('dev@example.org', `/v1/action-runs/${done.id}`))
    expect(again.told).toBeUndefined()
    const kept = await hub.db.query<{ n: number }>(`SELECT (SELECT count(*) FROM action_runs r WHERE r.id = $1 AND r::text LIKE '%unlocked%')::int + (SELECT count(*) FROM changes a WHERE a.detail->>'run' = $1 AND a::text LIKE '%unlocked%')::int AS n`, [done.id])
    expect(kept.rows[0]!.n).toBe(0)
  })

  it('refuses a revealed answer that would go to nobody', async () => {
    const saved = async (spec: Record<string, unknown>) => {
      const res = await admin('/v1/actions/bad', { method: 'PUT', ...body(spec) })
      return { status: res.status, text: await res.text() }
    }
    expect(await saved(unlock({ finish: 'reveal', onBehalf: undefined, secretRef: 'x' }))).toMatchObject({ status: 400, text: expect.stringContaining('made as them') })
    expect(await saved(unlock({ finish: 'reveal' }, { batch: { max: 5 } }))).toMatchObject({ status: 400, text: expect.stringContaining('no batch') })
    expect(await saved(unlock({ method: 'GET' }))).toMatchObject({ status: 400, text: expect.stringContaining('a GET carries no body') })
  })
})

/** Calls an agent tool with a token the hub made; answers with what the tool said. */
async function tool(bearer: string, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await hub.app.request('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${bearer}` }, ...body({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }, { surface: 'machine' })
  const said = (await res.json()) as { result: { content: { text: string }[] } }
  return JSON.parse(said.result.content[0]!.text) as Record<string, unknown>
}
const approve = (email: string, runId: string, opts?: { accessFor?: string | null; lapsed?: boolean }) => session(email, `/v1/action-runs/${runId}/approve`, { method: 'POST', ...body({}) }, opts)
const asked = async (): Promise<string> => {
  const said = await tool(agentKey, 'run_action', { action: 'gated', entity: 'account:ada' })
  expect(said.state).toBe('awaiting')
  return said.run as string
}
const assertionOf = (grant: URLSearchParams) => (JSON.parse(Buffer.from(grant.get('assertion')!.split('.')[1]!, 'base64url').toString()) as { email: string }).email

describe('a run made as a person that waits for approval', () => {
  it('is asked by an agent with a token the hub made, and waits with the link to approve it', async () => {
    const said = await tool(agentKey, 'run_action', { action: 'gated', entity: 'account:ada' })
    expect(said).toMatchObject({ state: 'awaiting', approve: `http://localhost:8080/actions/runs/${said.run as string}` })
    expect(said.next).toContain('runs as whoever approves it')
    expect((said.log as string[])[0]).toBe('requested by agent, the agent of dev@example.org; waiting for approval; it runs as whoever approves it')
    expect(calls).toHaveLength(0)
  })

  it('runs as the approver, from their own signed-in approval', async () => {
    const id = await asked()
    const res = await approve('lead@example.org', id)
    expect(res.status).toBe(200)
    const done = await run(res)
    expect(done).toMatchObject({ state: 'succeeded', by: 'dev@example.org', decidedBy: 'lead@example.org' })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.headers.authorization).toBe('Bearer for-api://ops/.default')
    expect(assertionOf(grants.at(-1)!)).toBe('lead@example.org')
    expect(done.log.map((l) => l.message)).toContain('approved by lead@example.org; it runs as lead@example.org, from their own signed-in approval')
    const row = await hub.db.query<{ detail: { runsAs?: string } }>(`SELECT detail FROM changes WHERE kind = 'action.approved' AND detail->>'run' = $1`, [id])
    expect(row.rows[0]!.detail.runsAs).toBe('lead@example.org')
  })

  it('refuses an approver who may not run it here themselves, and leaves it waiting', async () => {
    const id = await asked()
    const res = await approve('outsider@example.org', id)
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: string }).error).toBe('This run is made as whoever approves it, and only someone who may run "Unlock an account" here themselves approves it')
    expect(calls).toHaveLength(0)
    expect((await run(await approve('lead@example.org', id))).state).toBe('succeeded')
  })

  it('refuses an approval that carries no sign-in of the approver, and leaves it waiting', async () => {
    const id = await asked()
    const res = await approve('lead@example.org', id, { accessFor: null })
    expect(res.status).toBe(403)
    expect(await res.text()).toContain('approve it on the run\'s page')
    expect((await run(await session('lead@example.org', `/v1/action-runs/${id}`))).state).toBe('awaiting')
    expect(calls).toHaveLength(0)
    expect((await run(await approve('lead@example.org', id))).state).toBe('succeeded')
  })

  it('is never started by an approval made with a token the hub made, even the approver\'s own', async () => {
    const id = await asked()
    const leadKey = (await hub.sources.issueToken('personal', 'lead agent', { owner: 'lead@example.org' })).token
    const res = await hub.app.request(`/v1/action-runs/${id}/approve`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${leadKey}` }, ...body({}) }, { surface: 'machine' })
    expect(res.status).toBe(403)
    expect((await run(await session('lead@example.org', `/v1/action-runs/${id}`))).state).toBe('awaiting')
    expect(calls).toHaveLength(0)
  })

  it('runs every run of a batch as the approver, on one approval', async () => {
    const res = await hub.app.request('/v1/actions/gated/batch', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${agentKey}` }, ...body({ entities: [{ blueprint: 'account', key: 'ada' }, { blueprint: 'account', key: 'bob' }] }) }, { surface: 'machine' })
    expect(res.status).toBe(201)
    const batch = ((await res.json()) as { id: string }).id
    expect(calls).toHaveLength(0)
    expect(((await (await session('lead@example.org', `/v1/action-batches/${batch}`)).json()) as { canDecide: boolean }).canDecide).toBe(true)
    const approved = await session('lead@example.org', `/v1/action-batches/${batch}/approve`, { method: 'POST', ...body({}) })
    expect(await approved.json()).toEqual({ approved: 2, voted: 0, refused: [] })
    expect(calls.map((c) => c.url).sort()).toEqual(['/users/ada/unlock', '/users/bob/unlock'])
    expect(calls.every((c) => c.headers.authorization === 'Bearer for-api://ops/.default')).toBe(true)
    const runs = await hub.db.query<{ actor: string; decided_by: string; state: string; log: { message: string }[] }>('SELECT actor, decided_by, state, log FROM action_runs WHERE batch = $1', [batch])
    for (const r of runs.rows) {
      expect(r).toMatchObject({ actor: 'dev@example.org', decided_by: 'lead@example.org', state: 'succeeded' })
      expect(r.log.map((l) => l.message)).toContain('approved by lead@example.org; it runs as lead@example.org, from their own signed-in approval')
    }
  })
})

describe('a change set of runs made as a person', () => {
  it('runs every run as the approver, on one signed-in approval, and on none without it', async () => {
    const said = await tool(agentKey, 'propose_changes', { title: 'Unlock both', note: 'They asked on the desk', items: [{ action: 'gated', entity: 'account:ada' }, { action: 'unlock', entity: 'account:bob' }] })
    expect(said).toMatchObject({ decision: 'pending', changes: 2 })
    expect(said.next).toContain('run as whoever approves them')
    const set = said.set as string
    expect(calls).toHaveLength(0)
    const unsigned = await session('lead@example.org', `/v1/change-sets/${set}/approve`, { method: 'POST', ...body({}) }, { accessFor: null })
    expect(unsigned.status).toBe(403)
    expect(await unsigned.text()).toContain('approve it on its page')
    expect(calls).toHaveLength(0)
    const approved = await session('lead@example.org', `/v1/change-sets/${set}/approve`, { method: 'POST', ...body({}) })
    expect(approved.status).toBe(200)
    expect(await approved.json()).toMatchObject({ approved: 2, voted: 0 })
    expect(calls.map((c) => c.url).sort()).toEqual(['/users/ada/unlock', '/users/bob/unlock'])
    expect(calls.every((c) => c.headers.authorization === 'Bearer for-api://ops/.default')).toBe(true)
    expect(grants.every((g) => assertionOf(g) === 'lead@example.org')).toBe(true)
    const runs = await hub.db.query<{ actor: string; decided_by: string; state: string }>('SELECT actor, decided_by, state FROM action_runs WHERE change_set = $1 ORDER BY set_index', [set])
    expect(runs.rows).toEqual([
      { actor: 'dev@example.org', decided_by: 'lead@example.org', state: 'succeeded' },
      { actor: 'dev@example.org', decided_by: 'lead@example.org', state: 'succeeded' },
    ])
  })
})

describe('a sign-in whose token for the hub has lapsed', () => {
  // A login proxy that refreshes a session may pass, beside a good ID token, an access token that no longer verifies.
  const refused = async (res: Response) => {
    expect(res.status).toBe(401)
    return (await res.json()) as { error: string; signIn?: string }
  }

  it('sends the approver of a change set to sign in again, and approves nothing until they do', async () => {
    const said = await tool(agentKey, 'propose_changes', { title: 'Unlock both again', note: 'Asked twice', items: [{ action: 'gated', entity: 'account:ada' }, { action: 'unlock', entity: 'account:bob' }] })
    const set = said.set as string
    const lapsed = await refused(await session('lead@example.org', `/v1/change-sets/${set}/approve`, { method: 'POST', ...body({}) }, { lapsed: true }))
    expect(lapsed).toEqual({ error: 'Approving this change set needs your own sign-in, and the one your browser holds has lapsed: sign in again, then do it once more', signIn: '/oauth2/start' })
    expect(calls).toHaveLength(0)
    const runs = await hub.db.query<{ state: string }>('SELECT state FROM action_runs WHERE change_set = $1', [set])
    expect(runs.rows.every((r) => r.state === 'awaiting')).toBe(true)
    const approved = await session('lead@example.org', `/v1/change-sets/${set}/approve`, { method: 'POST', ...body({}) })
    expect(await approved.json()).toMatchObject({ approved: 2, voted: 0 })
  })

  it('sends the approver of one run to sign in again, and leaves it waiting', async () => {
    const id = await asked()
    expect((await refused(await approve('lead@example.org', id, { lapsed: true }))).signIn).toBe('/oauth2/start')
    expect((await run(await session('lead@example.org', `/v1/action-runs/${id}`))).state).toBe('awaiting')
    expect(calls).toHaveLength(0)
    expect((await run(await approve('lead@example.org', id))).state).toBe('succeeded')
  })

  it('sends a person asking for a run made as them to sign in again, and starts none', async () => {
    const before = await hub.db.query<{ n: string }>(`SELECT count(*)::text AS n FROM action_runs WHERE action = 'unlock'`)
    expect((await refused(await ask('dev@example.org', { lapsed: true }))).error).toBe('Running this needs your own sign-in, and the one your browser holds has lapsed: sign in again, then do it once more')
    const after = await hub.db.query<{ n: string }>(`SELECT count(*)::text AS n FROM action_runs WHERE action = 'unlock'`)
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n)
    expect(calls).toHaveLength(0)
  })

  it('still answers what needs no token of theirs', async () => {
    expect((await session('dev@example.org', '/v1/whoami', {}, { lapsed: true })).status).toBe(200)
  })
})

describe('a change set of runs made as a person that wait their turn', () => {
  const items = (n: number) => Array.from({ length: n }, (_, i) => ({ action: 'paced', entity: `account:${i % 2 ? 'bob' : 'ada'}`, inputs: { n: String(i + 1) } }))
  const states = async (set: string) => (await hub.db.query<{ state: string; decided_by: string; behalf_grant: string | null }>('SELECT state, decided_by, behalf_grant FROM action_runs WHERE change_set = $1 ORDER BY set_index', [set])).rows
  /** Proposes the set as dev's agent, approves it as lead with the API holding its first answer, then ends the approval's own token before the rest start. */
  const approvedThenEnded = async (n: number): Promise<string> => {
    const said = await tool(agentKey, 'propose_changes', { title: 'Unlock in turn', items: items(n) })
    expect(said).toMatchObject({ decision: 'pending', changes: n })
    const set = said.set as string
    let open!: () => void
    apiGate = new Promise((r) => (open = r))
    const approved = await session('lead@example.org', `/v1/change-sets/${set}/approve`, { method: 'POST', ...body({}) })
    expect(approved.status, await approved.clone().text()).toBe(200)
    // The first holds its turn; the rest wait it, past the approval.
    const queued = (await states(set)).filter((r) => r.state === 'queued')
    expect(queued).toHaveLength(n - 1)
    // Each holds the grant lead's approval left it, sealed, never as the issuer gave it.
    if (!noRefresh) expect(queued.every((r) => !!r.behalf_grant && !r.behalf_grant.includes('lead@example.org'))).toBe(true)
    assertionsEnded = true
    open()
    apiGate = null
    return set
  }

  beforeAll(async () => {
    expect((await admin('/v1/actions/paced', { method: 'PUT', ...body(unlock({}, { approval: true, concurrency: 1, inputs: { n: { type: 'string' } }, access: { grants: [{ values: ['dev@example.org', 'lead@example.org'] }] } })) })).status).toBe(200)
  })

  it('runs every item as the approver, though the approval\'s token ended before the later ones started', async () => {
    shortLived = true
    const set = await approvedThenEnded(4)
    await vi.waitFor(async () => {
      await hub.actions.turns()
      expect((await states(set)).map((r) => r.state)).toEqual(['succeeded', 'succeeded', 'succeeded', 'succeeded'])
    }, { timeout: 15_000, interval: 100 })
    expect((await states(set)).every((r) => r.decided_by === 'lead@example.org' && r.behalf_grant === null)).toBe(true)
    expect(calls).toHaveLength(4)
    expect(calls.every((c) => c.headers.authorization === 'Bearer for-api://ops/.default')).toBe(true)
    // The later runs asked for their tokens with the grant lead's approval left them, and with nothing else.
    const redeemed = grants.filter((g) => g.get('grant_type') === 'refresh_token')
    expect(redeemed.length).toBeGreaterThanOrEqual(3)
    expect(redeemed.every((g) => /^refresh-\d+-lead@example\.org$/.test(g.get('refresh_token') ?? '') && g.get('scope') === 'api://ops/.default')).toBe(true)
  })

  it('asks again for the items that failed, and runs them as whoever approves the new set', async () => {
    noRefresh = true
    shortLived = true
    const set = await approvedThenEnded(3)
    await vi.waitFor(async () => {
      await hub.actions.turns()
      expect((await states(set)).map((r) => r.state)).toEqual(['succeeded', 'failed', 'failed'])
    }, { timeout: 15_000, interval: 100 })
    const failed = await hub.db.query<{ log: { message: string }[] }>(`SELECT log FROM action_runs WHERE change_set = $1 AND state = 'failed'`, [set])
    for (const r of failed.rows) expect(r.log.at(-1)!.message).toMatch(/AADSTS500133|own signed-in request, or their own signed-in approval/)
    assertionsEnded = false
    noRefresh = false
    const shown = (await (await session('dev@example.org', `/v1/change-sets/${set}`)).json()) as { canRetry: boolean }
    expect(shown.canRetry).toBe(true)
    const again = await hub.app.request(`/v1/change-sets/${set}/retry`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${agentKey}` }, ...body({}) }, { surface: 'machine' })
    expect(again.status).toBe(201)
    const retry = ((await again.json()) as { id: string }).id
    expect((await states(retry)).map((r) => r.state)).toEqual(['awaiting', 'awaiting'])
    calls.length = 0
    const approved = await session('lead@example.org', `/v1/change-sets/${retry}/approve`, { method: 'POST', ...body({}) })
    expect(approved.status).toBe(200)
    await vi.waitFor(async () => {
      await hub.actions.turns()
      expect((await states(retry)).map((r) => r.state)).toEqual(['succeeded', 'succeeded'])
    }, { timeout: 15_000, interval: 100 })
    expect((await states(retry)).every((r) => r.decided_by === 'lead@example.org')).toBe(true)
    expect(calls).toHaveLength(2)
  })
})

describe('a run made as a person that nobody but its asker could approve', () => {
  // Only the admin may run it, so nobody else may approve it into running as them: lead holds actions.approve but may not run it.
  const solo = (extra: Record<string, unknown> = {}) => unlock({}, { approval: true, batch: { max: 5 }, access: { grants: [{ values: ['admin@example.org'] }] }, ...extra })
  let adminKey: string

  beforeAll(async () => {
    expect((await admin('/v1/actions/solo', { method: 'PUT', ...body(solo()) })).status).toBe(200)
    adminKey = (await hub.sources.issueToken('personal', 'admin agent', { owner: 'admin@example.org' })).token
  })

  it('is refused as it is asked, saying what would let someone approve it', async () => {
    const said = await tool(adminKey, 'run_action', { action: 'solo', entity: 'account:ada' })
    expect(JSON.stringify(said)).toContain('This run would wait for an approval nobody can give. Nobody but you could approve it')
    expect(JSON.stringify(said)).toContain('selfApproval')
    expect((await hub.db.query(`SELECT 1 FROM action_runs WHERE action = 'solo'`)).rowCount).toBe(0)
  })

  it('turns down every run of a batch nobody could approve, and asks none', async () => {
    const res = await hub.app.request('/v1/actions/solo/batch', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${adminKey}` }, ...body({ entities: [{ blueprint: 'account', key: 'ada' }, { blueprint: 'account', key: 'bob' }] }) }, { surface: 'machine' })
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('an approval nobody can give')
    expect((await hub.db.query(`SELECT 1 FROM action_runs WHERE action = 'solo'`)).rowCount).toBe(0)
  })

  it('lets its asker approve it, signed in, once the action lets them approve their own, and runs it as them', async () => {
    expect((await admin('/v1/actions/solo', { method: 'PUT', ...body(solo({ selfApproval: true })) })).status).toBe(200)
    const res = await hub.app.request('/v1/actions/solo/batch', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${adminKey}` }, ...body({ entities: [{ blueprint: 'account', key: 'ada' }, { blueprint: 'account', key: 'bob' }] }) }, { surface: 'machine' })
    expect(res.status).toBe(201)
    const batch = ((await res.json()) as { id: string }).id
    expect(calls).toHaveLength(0)
    expect(((await (await admin(`/v1/action-batches/${batch}`)).json()) as { canDecide: boolean }).canDecide).toBe(true)
    const approved = await session('admin@example.org', `/v1/action-batches/${batch}/approve`, { method: 'POST', ...body({}) }, { roles: ['Admin'] })
    expect(await approved.json()).toEqual({ approved: 2, voted: 0, refused: [] })
    expect(calls.map((c) => c.url).sort()).toEqual(['/users/ada/unlock', '/users/bob/unlock'])
    expect(grants.length).toBeGreaterThan(0)
    expect(grants.every((g) => assertionOf(g) === 'admin@example.org')).toBe(true)
    const runs = await hub.db.query<{ actor: string; decided_by: string; state: string }>('SELECT actor, decided_by, state FROM action_runs WHERE batch = $1', [batch])
    for (const r of runs.rows) expect(r).toMatchObject({ actor: 'admin@example.org', decided_by: 'admin@example.org', state: 'succeeded' })
  })
})

describe('an approval record of a run made as a person', () => {
  const recordOf = async (run: string) => (await hub.reader.get({ blueprint: 'approval', key: `orrery/run/${run}` }))!
  const decideFrom = (email: string, run: string, opts?: { accessFor?: string | null; roles?: string[] }) => session(email, '/v1/actions/approve_record/run', { method: 'POST', ...body({ entity: { blueprint: 'approval', key: `orrery/run/${run}` }, inputs: {} }) }, opts)

  beforeAll(async () => {
    expect((await admin('/v1/blueprints/person', { method: 'PUT', ...body({ title: 'Person', fields: { email: { type: 'email' } }, relations: {} }) })).status).toBeLessThan(300)
    expect((await admin('/v1/access/person', { method: 'PUT', ...body({ blueprint: 'person', field: 'email' }) })).status).toBe(200)
    const pusher = (await hub.sources.issueToken('source', 'people', { source: 'seed@test' })).token
    for (const who of ['admin', 'lead', 'dev']) await hub.app.request(`/v1/ingest/entities/person/${who}`, { method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${pusher}` }, ...body({ title: who, fields: { email: `${who}@example.org` } }) }, { surface: 'machine' })
    const approval = { title: 'Approval', fields: { decision: { type: 'enum', values: ['pending', 'approved', 'declined', 'expired'] }, requested_by: { type: 'string' }, decided_by: { type: 'string' } }, relations: { requester: { target: 'person' }, approvers: { target: 'person', many: true } } }
    expect((await admin('/v1/blueprints/approval', { method: 'PUT', ...body(approval) })).status).toBeLessThan(300)
    expect((await admin('/v1/access/approvals', { method: 'PUT', ...body({ blueprint: 'approval' }) })).status).toBe(200)
    expect((await admin('/v1/actions/approve_record', { method: 'PUT', ...body({ title: 'Approve', blueprint: 'approval', inputs: {}, access: { everyone: true }, backend: { type: 'decide', verdict: 'approve' } }) })).status).toBe(200)
  })

  it('names who may approve it, and judges them again when the action changes', async () => {
    const id = await asked()
    await hub.approvals.pass()
    expect((await recordOf(id)).relations.approvers?.map((r) => r.key).sort()).toEqual(['admin', 'lead'])
    // lead may no longer run it, so may no longer approve it into running as them.
    expect((await admin('/v1/actions/gated', { method: 'PUT', ...body(unlock({}, { approval: true, batch: { max: 5 }, access: { grants: [{ values: ['dev@example.org'] }] } })) })).status).toBe(200)
    await hub.approvals.pass()
    expect((await recordOf(id)).relations.approvers?.map((r) => r.key)).toEqual(['admin'])
    expect((await admin('/v1/actions/gated', { method: 'PUT', ...body(unlock({}, { approval: true, batch: { max: 5 }, access: { rules: [{ grants: [{ values: ['dev@example.org', 'lead@example.org'] }] }, { grants: [{ values: ['outsider@example.org'] }], where: { field: '$key', op: 'eq', value: 'bob' } }] } })) })).status).toBe(200)
    await hub.approvals.pass()
    expect((await recordOf(id)).relations.approvers?.map((r) => r.key).sort()).toEqual(['admin', 'lead'])
  })

  it('is approved from its row as the person who pressed Approve, signed in, and runs as them', async () => {
    const id = await asked()
    await hub.approvals.pass()
    const decided = await run(await decideFrom('lead@example.org', id))
    expect(decided.state).toBe('succeeded')
    const done = await run(await session('lead@example.org', `/v1/action-runs/${id}`))
    expect(done).toMatchObject({ state: 'succeeded', by: 'dev@example.org', decidedBy: 'lead@example.org' })
    expect(calls).toHaveLength(1)
    const row = await hub.db.query<{ detail: { runsAs?: string } }>(`SELECT detail FROM changes WHERE kind = 'action.approved' AND detail->>'run' = $1`, [id])
    expect(row.rows[0]!.detail.runsAs).toBe('lead@example.org')
  })

  it('says where to approve it when the press carries no sign-in of theirs, and leaves it waiting', async () => {
    const id = await asked()
    await hub.approvals.pass()
    const decided = await run(await decideFrom('lead@example.org', id, { accessFor: null }))
    expect(decided.state).toBe('failed')
    expect(decided.log.at(-1)!.message).toContain(`approve it on the run's page, http://localhost:8080/actions/runs/${id}`)
    expect((await run(await session('lead@example.org', `/v1/action-runs/${id}`))).state).toBe('awaiting')
    expect(calls).toHaveLength(0)
  })
})

describe('the delegates a hub is set up with', () => {
  it('reads them, and refuses one that is not https', () => {
    expect(parseDelegates(undefined)).toEqual({})
    expect(parseDelegates('{"ops":{"scope":"s","urls":["https://ops.example.org/"]}}')).toEqual({ ops: { scope: 's', urls: ['https://ops.example.org/'] } })
    expect(() => parseDelegates('{"ops":{"scope":"s","urls":["http://ops.example.org/"]}}')).toThrow(/https/)
    expect(() => parseDelegates('nope')).toThrow(/JSON/)
  })

  it('keeps a token for the same person and asks again for another', async () => {
    let asked = 0
    const dir = mkdtempSync(join(tmpdir(), 'orrery-'))
    writeFileSync(join(dir, 'token'), 't')
    const behalf = new Behalf({ ops: { scope: 's', urls: ['https://ops.example.org/'] } }, { tenantId: 't', clientId: 'c', tokenFile: join(dir, 'token'), authorityHost: 'https://login.example.com/' }, boxIn(dir), async () => new Response(JSON.stringify({ access_token: `t${++asked}`, expires_in: 3600 })))
    const url = 'https://ops.example.org/x'
    expect(await askingAs('a@example.org', 'tok-a', () => behalf.tokenFor('ops', 'a@example.org', url))).toBe('t1')
    expect(await askingAs('A@example.org', 'tok-a', () => behalf.tokenFor('ops', 'a@example.org', url))).toBe('t1')
    expect(await askingAs('b@example.org', 'tok-b', () => behalf.tokenFor('ops', 'b@example.org', url))).toBe('t2')
    await expect(askingAs('b@example.org', 'tok-b', () => behalf.tokenFor('ops', 'a@example.org', url))).rejects.toBeInstanceOf(BehalfError)
    await expect(behalf.tokenFor('ops', 'a@example.org', url)).rejects.toThrow(/own signed-in request, or their own signed-in approval/)
    await expect(askingAs('a@example.org', 'tok-a', () => behalf.tokenFor('nope', 'a@example.org', url))).rejects.toThrow(/not set up/)
  })

  it('keeps a grant from a signed-in approval, and asks with it outside any request, for that person alone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orrery-'))
    writeFileSync(join(dir, 'token'), 't')
    let clock = 0
    const asked: URLSearchParams[] = []
    const behalf = new Behalf({ ops: { scope: 's', urls: ['https://ops.example.org/'] } }, { tenantId: 't', clientId: 'c', tokenFile: join(dir, 'token'), authorityHost: 'https://login.example.com/' }, boxIn(dir), async (_url, init) => {
      const form = new URLSearchParams(String(init.body))
      asked.push(form)
      return new Response(JSON.stringify({ access_token: `t${asked.length}`, expires_in: 120, ...(form.get('scope')?.includes('offline_access') || form.get('grant_type') === 'refresh_token' ? { refresh_token: `refresh-${asked.length}` } : {}) }))
    }, () => clock)
    const url = 'https://ops.example.org/x'
    await expect(behalf.hold('ops', 'a@example.org')).rejects.toThrow(/own signed-in approval/)
    const held = (await askingAs('a@example.org', 'tok-a', () => behalf.hold('ops', 'a@example.org')))!
    expect(asked[0]!.get('scope')).toBe('s offline_access')
    // A '-' is never in the box's base64, so this cannot match by chance.
    expect(held).not.toContain('refresh-1')
    // The same request holds the same grant for every run it approves.
    expect(await askingAs('a@example.org', 'tok-a', () => behalf.hold('ops', 'a@example.org'))).toBe(held)
    expect(asked).toHaveLength(1)
    // Long after the approval, with no request under way and the first token ended, the grant asks for a fresh one.
    clock = 10 * 60_000
    expect(await behalf.tokenFor('ops', 'a@example.org', url, held)).toBe('t2')
    expect(Object.fromEntries(asked[1]!)).toEqual(({ grant_type: 'refresh_token', refresh_token: 'refresh-1', scope: 's', client_id: 'c', client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer', client_assertion: 't' }))
    await expect(behalf.tokenFor('ops', 'b@example.org', url, held)).rejects.toThrow(/a@example.org's/)
    await expect(behalf.tokenFor('ops', 'a@example.org', 'https://elsewhere.example.org/x', held)).rejects.toThrow(/may not be called at/)
    await expect(behalf.tokenFor('ops', 'a@example.org', url, 'not-sealed')).rejects.toThrow(/cannot be read/)
  })
})

function boxIn(dir: string): SecretBox {
  return SecretBox.load(undefined, dir, createLogger('test'))
}
