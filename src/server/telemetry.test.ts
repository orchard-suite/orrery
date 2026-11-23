import { mkdtempSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { ActionRun } from '../shared/model.ts'
import type { WhoAmIResponse } from '../shared/api.ts'
import { actingAs, record } from './activity.ts'
import { parseConnectionString, timespan, type Envelope } from './appinsights.ts'
import { loadConfig } from './config.ts'
import { createHub, type Hub } from './hub.ts'
import { createLogger } from './log.ts'
import { faroPayload, startTelemetry, type Telemetry } from './telemetry.ts'

// Its own database: these tests sign people in and count every event the hub sends.
const DATABASE_URL = (process.env.DATABASE_URL ?? 'postgres://orrery:orrery@localhost:5433/orrery') + '_telemetry'
const KEY = '00000000-0000-0000-0000-00000000c0de'

let hub: Hub
let telemetry: Telemetry
let ingestion: Server
let sent: Envelope[] = []
let faroBatches: { key: string | undefined; body: Record<string, unknown> }[] = []
let pusher = ''
let agent = ''

const as = (email: string, groups = 'User') => (path: string, init?: RequestInit) =>
  hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', 'x-forwarded-email': email, 'x-forwarded-groups': groups, 'x-orrery-session': 'tab-1', ...init?.headers } }, { surface: 'session' })
const machine = (token: string) => (path: string, init?: RequestInit) => hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...init?.headers } }, { surface: 'machine' })
const admin = as('admin@example.org', 'Admin')
const ada = as('ada@example.org')
const post = (v: unknown) => ({ method: 'POST', body: JSON.stringify(v) })
const put = (v: unknown) => ({ method: 'PUT', body: JSON.stringify(v) })

/** Everything the hub has sent by now. */
async function received(): Promise<Envelope[]> {
  await telemetry.flush()
  return sent
}
const events = (all: Envelope[], name: string) => all.filter((e) => e.data.baseType === 'EventData' && e.data.baseData.name === name)
const props = (e: Envelope) => e.data.baseData.properties as Record<string, string>

beforeAll(async () => {
  ingestion = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => (body += chunk.toString()))
    req.on('end', () => {
      if (req.url === '/v2.1/track') sent.push(...(JSON.parse(body) as Envelope[]))
      if (req.url === '/collect') faroBatches.push({ key: req.headers['x-api-key'] as string | undefined, body: JSON.parse(body) as Record<string, unknown> })
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"itemsReceived":1,"itemsAccepted":1,"errors":[]}')
    })
  })
  await new Promise<void>((done) => ingestion.listen(0, '127.0.0.1', done))
  const port = (ingestion.address() as AddressInfo).port
  // Started before the hub is made, as main.ts does.
  telemetry = await startTelemetry(createLogger('test'), 'test', { APPLICATIONINSIGHTS_CONNECTION_STRING: `InstrumentationKey=${KEY};IngestionEndpoint=http://127.0.0.1:${port}/`, FARO_URL: `http://127.0.0.1:${port}/collect`, FARO_API_KEY: 'faro-key' })

  const pg = await import('pg').then(({ default: m }) => new m.Client({ connectionString: DATABASE_URL.replace(/\/[^/]+$/, '/postgres') }))
  await pg.connect()
  await pg.query(`DROP DATABASE IF EXISTS ${DATABASE_URL.split('/').pop()}`)
  await pg.query(`CREATE DATABASE ${DATABASE_URL.split('/').pop()}`)
  await pg.end()
  hub = await createHub(loadConfig({ DATABASE_URL, DATA_DIR: mkdtempSync(join(tmpdir(), 'orrery-')), AUTH_MODE: 'proxy' }), 'test', { reset: true })

  expect((await admin('/v1/blueprints/gizmo', put({ id: 'gizmo', title: 'Gizmo', fields: { size: { type: 'number' } }, relations: {} }))).status).toBe(200)
  expect((await admin('/v1/blueprints/request', put({ id: 'request', title: 'Request', fields: { reason: { type: 'string' } }, relations: {} }))).status).toBe(200)
  expect((await admin('/v1/sources/gizmo-src', put({ title: 'gizmo-src', class: 'pusher', blueprints: ['gizmo', 'request'] }))).status).toBe(200)
  pusher = (await hub.sources.issueToken('source', 'gizmos', { source: 'gizmo-src' })).token
  agent = (await hub.sources.issueToken('access', 'agent', { role: 'viewer' })).token
  expect(
    (
      await admin(
        '/v1/actions/ask',
        put({ title: 'Ask', inputs: { why: { type: 'string' } }, backend: { type: 'record', source: 'gizmo-src', blueprint: 'request', key: '{{ run.id }}', fields: { reason: '{{ inputs.why }}' } }, access: { everyone: true } }),
      )
    ).status,
  ).toBe(200)
  await ada('/v1/whoami')
})

beforeEach(async () => {
  await telemetry.flush()
  sent = []
})

afterAll(async () => {
  await hub.close()
  await telemetry.shutdown()
  await new Promise((done) => ingestion.close(done))
})

describe('the connection string and the ingestion format', () => {
  it('reads the key and the endpoint, ending the endpoint in a slash', () => {
    expect(parseConnectionString('InstrumentationKey=abc;IngestionEndpoint=https://centralus-0.in.applicationinsights.azure.com;LiveEndpoint=https://x/')).toEqual({ instrumentationKey: 'abc', endpoint: 'https://centralus-0.in.applicationinsights.azure.com/' })
    expect(() => parseConnectionString('IngestionEndpoint=https://x/')).toThrow(/InstrumentationKey/)
  })

  it('writes a length as the ingestion API reads one', () => {
    expect(timespan([0, 123_000_000])).toBe('00:00:00.123')
    expect(timespan([90_061, 5_000_000])).toBe('1.01:01:01.005')
  })
})

describe('telemetry', () => {
  it('tells the web app it is on', async () => {
    expect((await (await ada('/v1/whoami')).json() as WhoAmIResponse).telemetry).toBe(true)
  })

  it("sends a person's request under its route, as theirs, from where they are, and the change it made as an event inside it", async () => {
    const res = await admin('/v1/entities', { ...post({ blueprint: 'gizmo', key: 'g1', title: 'One', fields: { size: 1 } }), headers: { 'x-real-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.1, 10.0.0.1' } })
    expect(res.status).toBe(201)
    const all = await received()
    const request = all.find((e) => e.data.baseType === 'RequestData' && e.data.baseData.name === 'POST /v1/entities')!
    expect(request.iKey).toBe(KEY)
    expect(request.data.baseData).toMatchObject({ responseCode: '201', success: true, url: '/v1/entities' })
    const who = { 'ai.user.authUserId': 'admin@example.org', 'ai.user.id': 'admin@example.org', 'ai.session.id': 'tab-1', 'ai.location.ip': '203.0.113.7', 'ai.operation.name': 'POST /v1/entities' }
    expect(request.tags).toMatchObject({ ...who, 'ai.cloud.role': 'orrery' })
    const [created] = events(all, 'Entity Created')
    expect(props(created!)).toMatchObject({ initiatedBy: 'admin@example.org', source: 'api', blueprint: 'gizmo', key: 'g1', actorKind: 'user' })
    // The event is part of the visit, the place, and the request it was made in.
    expect(created!.tags).toMatchObject({ ...who, 'ai.operation.id': request.tags['ai.operation.id'] })
    expect(props(created!)['client.address']).toBeUndefined()
  })

  it('reads the address only from the header the hub trusts, and takes nothing that is not an address', async () => {
    // x-forwarded-for is not the trusted header here: what a caller wrote in it places them nowhere.
    await admin('/v1/whoami', { headers: { 'x-forwarded-for': '198.51.100.1, 10.0.0.1' } })
    await admin('/v1/whoami', { headers: { 'x-real-ip': 'not-an-address' } })
    const [first, second] = (await received()).filter((e) => e.data.baseData.name === 'GET /v1/whoami')
    expect(first!.tags['ai.location.ip']).toBe('0.0.0.0')
    expect(second!.tags['ai.location.ip']).toBe('0.0.0.0')
  })

  it("sends nothing for the pictures, the event stream, or the web app's files", async () => {
    await ada('/v1/icons/nothing')
    await ada('/assets/app.js')
    expect((await received()).filter((e) => e.data.baseType === 'RequestData')).toEqual([])
  })

  it("sends a pusher's request, but not what its writes did to the estate", async () => {
    expect((await machine(pusher)('/v1/ingest/entities/gizmo/g2', put({ title: 'Two', fields: { size: 2 } }))).status).toBe(201)
    const all = await received()
    const request = all.find((e) => e.data.baseData.name === 'PUT /v1/ingest/entities/:blueprint/:key')!
    expect(props(request)).toMatchObject({ initiatedBy: 'gizmo-src', 'orrery.actor_kind': 'source', 'orrery.surface': 'machine' })
    expect(request.tags['ai.user.authUserId']).toBeUndefined()
    // No address of its own: placed nowhere, not where the hub runs.
    expect(request.tags['ai.location.ip']).toBe('0.0.0.0')
    expect(all.filter((e) => e.data.baseType === 'EventData')).toEqual([])
  })

  it('sends a change only once its transaction commits, and never one that rolls back', async () => {
    await actingAs({ kind: 'user', name: 'ada@example.org' }, () => hub.db.tx(async (client) => {
      await record(client, 'grid.arranged', { blueprint: 'gizmo' }, null, null, {})
      expect(sent).toEqual([])
    }))
    await actingAs({ kind: 'user', name: 'ada@example.org' }, () =>
      hub.db.tx(async (client) => {
        await record(client, 'model.arranged', null, null, null, {})
        throw new Error('changed my mind')
      }).catch(() => undefined),
    )
    const all = await received()
    expect(events(all, 'Grid Arranged')).toHaveLength(1)
    expect(events(all, 'Model Arranged')).toEqual([])
  })

  it("keeps a detail named as one of the event's own properties, under its own name, and says what the change was written as", async () => {
    await actingAs({ kind: 'user', name: 'ada@example.org' }, () => hub.db.tx((client) => record(client, 'grid.arranged', { blueprint: 'gizmo' }, 'ui', null, { source: 'git-a', key: 'columns' })))
    const [arranged] = events(await received(), 'Grid Arranged')
    expect(props(arranged!)).toMatchObject({ source: 'api', blueprint: 'gizmo', 'detail.source': 'git-a', 'detail.key': 'columns', writtenAs: 'ui' })
  })

  it('sends a self-service run from its request to its end, as the person who asked, without what they typed', async () => {
    const res = await ada('/v1/actions/ask/run', post({ inputs: { why: 'a private reason' } }))
    expect(res.status).toBe(201)
    const run = (await res.json()) as ActionRun
    const all = await received()
    const [requested] = events(all, 'Action Run Requested')
    expect(props(requested!)).toMatchObject({ initiatedBy: 'ada@example.org', action: 'ask', run: run.id })
    expect(props(requested!).inputs).toBeUndefined()
    const [finished] = events(all, 'Action Run Finished')
    expect(props(finished!)).toMatchObject({ initiatedBy: 'ada@example.org', requestedBy: 'ada@example.org', action: 'ask', backend: 'record', state: 'succeeded' })
    expect(typeof (finished!.data.baseData.measurements as Record<string, number>).seconds).toBe('number')
    expect(JSON.stringify(all)).not.toContain('a private reason')
  })

  it("sends an agent's tool call by the tool's name, with what it sent", async () => {
    const res = await machine(agent)('/mcp', { method: 'POST', headers: { accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'estate_summary', arguments: { blueprint: 'service' } } }) })
    expect(res.status).toBe(200)
    const [called] = events(await received(), 'Agent Tool Called')
    expect(props(called!)).toMatchObject({ tool: 'estate_summary', args: '{"blueprint":"service"}', initiatedBy: 'agent', actorKind: 'token' })
  })
})

describe("the browser's telemetry", () => {
  it('relays page views, events, and errors as the signed-in person, whatever the page says', async () => {
    const batch = {
      session: 'tab-9',
      signals: [
        { kind: 'event', name: 'Page Viewed', props: { page: 'Catalog', path: '/inventory/gizmo', blueprint: 'gizmo' } },
        { kind: 'event', name: 'Action Form Opened', props: { action: 'ask', initiatedBy: 'someone@else.org' } },
        { kind: 'error', type: 'TypeError', message: 'x is undefined', stack: 'TypeError: x is undefined\n    at grid', page: '/inventory' },
      ],
    }
    expect((await ada('/v1/telemetry', { ...post(batch), headers: { 'x-real-ip': '203.0.113.9' } })).status).toBe(204)
    const all = await received()
    const view = all.find((e) => e.data.baseType === 'PageViewData')!
    expect(view.data.baseData).toMatchObject({ name: 'Catalog', url: '/inventory/gizmo' })
    expect(props(view)).toMatchObject({ blueprint: 'gizmo', source: 'web' })
    expect(view.tags).toMatchObject({ 'ai.user.authUserId': 'ada@example.org', 'ai.session.id': 'tab-9', 'ai.location.ip': '203.0.113.9' })
    expect(props(events(all, 'Action Form Opened')[0]!)).toMatchObject({ action: 'ask', initiatedBy: 'ada@example.org' })
    const error = all.find((e) => e.data.baseType === 'ExceptionData')!
    expect(error.data.baseData.exceptions).toEqual([{ typeName: 'TypeError', message: 'x is undefined', hasFullStack: true, stack: 'TypeError: x is undefined\n    at grid' }])
    // The relay is not itself a request worth sending.
    expect(all.filter((e) => e.data.baseType === 'RequestData')).toEqual([])
  })

  it('relays the batch to the Faro receiver as orrery-web, with the person the hub signed in and the key the page never holds', async () => {
    faroBatches = []
    const batch = {
      session: 'tab-faro',
      signals: [
        { kind: 'event', name: 'Page Viewed', props: { page: 'Findings', path: '/findings' } },
        { kind: 'measure', name: 'wait', page: 'Findings', value: 0.25 },
        { kind: 'measure', name: 'lcp', page: 'Findings', value: 1.5 },
        { kind: 'error', type: 'TypeError', message: 'y is undefined', page: '/findings' },
      ],
    }
    expect((await ada('/v1/telemetry', post(batch))).status).toBe(204)
    for (let i = 0; i < 50 && faroBatches.length === 0; i++) await new Promise((r) => setTimeout(r, 20))
    expect(faroBatches).toHaveLength(1)
    expect(faroBatches[0]!.key).toBe('faro-key')
    expect(faroBatches[0]!.body).toMatchObject({
      meta: { app: { name: 'orrery-web', version: 'test' }, session: { id: 'tab-faro' }, user: { email: 'ada@example.org' }, page: { url: '/findings' } },
      events: [{ name: 'Page Viewed', domain: 'browser', attributes: { page: 'Findings', path: '/findings' } }],
      measurements: [
        { type: 'wait', values: { wait_ms: 250 }, context: { page: 'Findings' } },
        { type: 'web-vitals', values: { lcp: 1500 }, context: { page: 'Findings' } },
      ],
      exceptions: [{ type: 'TypeError', value: 'y is undefined', context: { page: '/findings' } }],
    })
    // The payload names the person only as the hub knows them, whatever the page said.
    expect(JSON.stringify(faroPayload('v', 'who@example.org', 's', [{ kind: 'event', name: 'Action Form Opened', props: { initiatedBy: 'someone@else.org' } }]))).not.toContain('"user":{"email":"someone')
  })

  it('refuses a token, a name the page may not send, and a batch too big to take', async () => {
    expect((await machine(agent)('/v1/telemetry', post({ session: 's', signals: [] }))).status).toBe(403)
    expect((await ada('/v1/telemetry', post({ session: 's', signals: [{ kind: 'event', name: 'Entity Deleted' }] }))).status).toBe(400)
    expect((await ada('/v1/telemetry', post({ session: 's', signals: [{ kind: 'error', type: 'E', message: 'x'.repeat(300_000) }] }))).status).toBe(413)
    expect((await received()).filter((e) => e.data.baseType !== 'RequestData')).toEqual([])
  })
})
