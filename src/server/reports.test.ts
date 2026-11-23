import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ReportEditionRead, ReportPage, RunnerJob, SavedQuery } from '../shared/api.ts'
import { EDITION_BLUEPRINT, REPORT_BLUEPRINT, isFinished, type ActionRun, type Entity } from '../shared/model.ts'
import { loadConfig } from './config.ts'
import { createHub, type Hub } from './hub.ts'
import { createLogger } from './log.ts'
import { NoticeForwarder, type NoticeEvent } from './notices.ts'
import { summaryOf } from './reports.ts'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://orrery:orrery@localhost:5433/orrery'

let hub: Hub
let pusher = ''
let query: SavedQuery

const as = (email: string, groups = 'User') => (path: string, init?: RequestInit) => Promise.resolve(hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', 'x-forwarded-email': email, 'x-forwarded-groups': groups, ...init?.headers } }, { surface: 'session' }))
const ops = as('ops@example.org', 'Admin')
const ada = as('ada@example.org')
const bob = as('bob@example.org')
const machine = (path: string, init: RequestInit) => Promise.resolve(hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${pusher}`, ...init.headers } }, { surface: 'machine' }))
const put = (v: unknown) => ({ method: 'PUT', body: JSON.stringify(v) })
const post = (v: unknown) => ({ method: 'POST', body: JSON.stringify(v) })
const json = async <T>(r: Response): Promise<T> => (await r.json()) as T

const LAYOUT = (queryId: string) => `---
writer: write_prose
data:
  crew: { query: ${queryId} }
  counts: { tool: count_things }
---

# Weekly crew

A note that is always here.

\`\`\`stats
data: crew
items:
  - { name: members, title: Members, of: count, better: up }
  - { name: total, title: Things, of: sum, column: things }
\`\`\`

\`\`\`table
data: counts
limit: 5
\`\`\`

\`\`\`narrative
data: [crew, counts]
instruction: Say how the week went in two sentences.
\`\`\`
`

/** The writer and the data tool, as a runner answers them: the prose a model would write, and a table. */
const answering = (job: RunnerJob): string[] => (job.action === 'write_prose' ? ['The crew grew. Nothing broke.'] : [JSON.stringify([{ thing: 'a', things: 2 }, { thing: 'b', things: 5 }])])

/** Asks for a run, then plays the runner until the run ends: a publish waits on its tools. */
async function carried(who: ReturnType<typeof as>, action: string, entity: { blueprint: string; key: string } | null, inputs: Record<string, unknown> = {}): Promise<ActionRun> {
  const res = await who(`/v1/actions/${action}/run`, post({ ...(entity ? { entity } : {}), inputs }))
  expect(res.status, await res.clone().text()).toBeLessThan(300)
  const asked = await json<ActionRun>(res)
  for (let i = 0; i < 200; i++) {
    const run = (await hub.actions.getRun(asked.id))!
    if (isFinished(run.state)) return run
    for (const job of await hub.actions.claim('report-runner')) await hub.actions.report(job.run, { state: 'succeeded', log: answering(job) }, { kind: 'runner', source: 'report-runner' })
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(`run ${asked.id} did not end`)
}

const report = async (key: string): Promise<Entity> => (await hub.reader.get({ blueprint: REPORT_BLUEPRINT, key }, { includeDeleted: true }))!

beforeAll(async () => {
  hub = await createHub(loadConfig({ DATABASE_URL, DATA_DIR: mkdtempSync(join(tmpdir(), 'orrery-')), AUTH_MODE: 'proxy', PUBLIC_URL: 'https://hub.example.org' }), 'test', { reset: true })
  await hub.sources.save('estate', { title: 'Estate', class: 'pusher', blueprints: ['*'], deleteGrant: [], cadence: '3m' })
  pusher = (await hub.sources.issueToken('source', 'estate', { source: 'estate' })).token
  await hub.sources.save('report-runner', { title: 'Report runner', class: 'runner', blueprints: [], deleteGrant: [], cadence: '5m', serves: { tiers: ['read'] } })
  expect((await ops('/v1/blueprints/crew', put({ title: 'Crew', fields: {}, relations: {} }))).status).toBe(200)
  expect((await ops('/v1/blueprints/member', put({ title: 'Member', fields: { email: { type: 'email' }, things: { type: 'number' } }, relations: { crews: { target: 'crew', many: true } } }))).status).toBe(200)
  expect((await ops('/v1/access/person', put({ blueprint: 'member', field: 'email', owns: [{ as: 'member', path: 'crews' }] }))).status).toBe(200)
  await machine('/v1/ingest/entities/crew/builders', put({ title: 'Builders' }))
  for (const [who, things] of [['ada', 3], ['eve', 4]] as const) await machine(`/v1/ingest/entities/member/${who}`, put({ title: who, fields: { email: `${who}@example.org`, things }, relations: { crews: ['builders'] } }))
  await machine('/v1/ingest/entities/member/bob', put({ title: 'bob', fields: { email: 'bob@example.org', things: 1 }, relations: {} }))
  await hub.deriver.backfill()
  for (const who of [ada, bob, ops]) await who('/v1/whoami')
  // The estate's report actions: whoever may publish a report holds the read tier on it, which its writer and its data tool need.
  const actions: Record<string, unknown> = {
    new_report: { title: 'New report', access: { everyone: true }, inputs: { title: { type: 'string', required: true }, home: { type: 'entity', blueprint: 'crew', required: true }, layout: { type: 'markdown', required: true }, recipients: { type: 'email', many: true } }, backend: { type: 'report', verb: 'create' } },
    edit_report: { title: 'Edit report', blueprint: REPORT_BLUEPRINT, listed: false, access: { everyone: true }, inputs: { layout: { type: 'markdown', default: '{{ entity.fields.layout }}' }, version: { type: 'number' }, note: { type: 'string' } }, backend: { type: 'report', verb: 'edit' } },
    publish_report: { title: 'Publish report', blueprint: REPORT_BLUEPRINT, listed: false, schedule: { min: '1d' }, access: { everyone: true, tiers: ['read'] }, inputs: {}, backend: { type: 'report', verb: 'publish' } },
    preview_report: { title: 'Preview report', blueprint: REPORT_BLUEPRINT, listed: false, access: { everyone: true, tiers: ['read'] }, inputs: {}, backend: { type: 'report', verb: 'preview' } },
    report_recipients: { title: 'Change recipients', blueprint: REPORT_BLUEPRINT, listed: false, access: { everyone: true }, inputs: { recipients: { type: 'email', many: true, required: true } }, backend: { type: 'report', verb: 'recipients' } },
    remove_report: { title: 'Remove report', blueprint: REPORT_BLUEPRINT, listed: false, access: { everyone: true }, inputs: {}, backend: { type: 'report', verb: 'remove' } },
    write_prose: { title: 'Write prose', blueprint: REPORT_BLUEPRINT, inputs: { instruction: { type: 'text', required: true }, data: { type: 'attachment', required: true } }, backend: { type: 'runner', runner: 'report-runner', command: ['write', '{{ inputs.instruction }}'] }, tool: { tier: 'read' } },
    count_things: { title: 'Count things', blueprint: REPORT_BLUEPRINT, inputs: {}, backend: { type: 'runner', runner: 'report-runner', command: ['count'] }, tool: { tier: 'read' } },
  }
  for (const [id, spec] of Object.entries(actions)) {
    const res = await ops(`/v1/actions/${id}`, put(spec))
    expect(res.status, `${id}: ${await res.clone().text()}`).toBe(200)
  }
  query = await json<SavedQuery>(await ada('/v1/queries', post({ title: 'Members', spec: { sources: [{ blueprint: 'member', clauses: [] }], columns: ['title', 'things'] } })))
})

afterAll(async () => {
  await hub.close()
})

describe('an edition\'s one line', () => {
  it('is the first sentence a writer wrote, without the marks it may use', () => {
    const said = (text: string) => summaryOf({ title: 'T', number: 1, publishedAt: '2026-11-18T12:00:00Z', blocks: [{ kind: 'narrative', text }] })
    expect(said('## How the week went\n\nBoth **API** pipelines held, see [the runs](https://ci.example.org). More.\n\n- one')).toBe('Both API pipelines held, see the runs.')
    expect(said('- only a list\n- of things')).toBe('- only a list - of things')
  })
})

describe('a report backend', () => {
  it('is refused on an action that does not run on reports, or lacks the inputs its verb reads', async () => {
    const wrong = await ops('/v1/actions/bad_edit', put({ title: 'Bad', blueprint: 'crew', inputs: {}, backend: { type: 'report', verb: 'edit' } }))
    expect(wrong.status).toBe(400)
    const text = await wrong.text()
    expect(text).toContain(`the action's blueprint is ${REPORT_BLUEPRINT}`)
    expect(text).toContain('reads the input')
  })
})

describe('a report', () => {
  const key = 'weekly-crew'

  it('refuses a layout that does not read, naming each problem with its line, before anything runs', async () => {
    const res = await ada('/v1/actions/new_report/run', post({ inputs: { title: 'Weekly crew', home: 'crew:builders', layout: '```stats\ndata: nope\nitems: [{ name: n, of: count }]\n```\n```pie\n```' } }))
    expect(res.status).toBe(400)
    const body = await json<{ error: string; input: string }>(res)
    expect(body.input).toBe('layout')
    expect(body.error).toContain('line 1: stats reads data set "nope"')
    expect(body.error).toContain('line 5: unknown block "pie"')
    expect((await hub.db.query(`SELECT 1 FROM action_runs WHERE action = 'new_report'`)).rowCount).toBe(0)
  })

  it('is made by a run, owned by whoever ran it, at its first version, linked to its home', async () => {
    const run = await carried(ada, 'new_report', null, { title: 'Weekly crew', home: 'crew:builders', layout: LAYOUT(query.id), recipients: ['eve@example.org', 'nobody@example.org'] })
    expect(run.state, run.log.map((l) => l.message).join('\n')).toBe('succeeded')
    expect(run.summary).toBe(`created report ${key}`)
    const r = await report(key)
    expect(r.fields).toMatchObject({ owner: 'ada@example.org', version: 1, editions: 0, status: 'grey', writer: 'write_prose', data_sets: [`crew: query ${query.id}`, 'counts: tool count_things'] })
    expect(r.relations.home_crew?.map((x) => x.key)).toEqual(['builders'])
  })

  it('is changed only by its owner, those who own its home, or an admin', async () => {
    const refused = await carried(bob, 'edit_report', { blueprint: REPORT_BLUEPRINT, key }, { layout: LAYOUT(query.id).replace('Weekly crew', 'Bob was here'), note: 'mine now' })
    expect(refused.state).toBe('failed')
    expect(refused.log.at(-1)?.message).toContain('Only the owner')
    // Eve owns its home, the crew, and may change it.
    await as('eve@example.org')('/v1/whoami')
    const edited = await carried(as('eve@example.org'), 'edit_report', { blueprint: REPORT_BLUEPRINT, key }, { layout: LAYOUT(query.id).replace('# Weekly crew', '# Weekly crew, edited'), note: 'a better heading' })
    expect(edited.state).toBe('succeeded')
    expect((await report(key)).fields.version).toBe(2)
  })

  it('puts an older version back as the next version', async () => {
    const run = await carried(ada, 'edit_report', { blueprint: REPORT_BLUEPRINT, key }, { layout: '', version: 1 })
    expect(run.state, run.log.map((l) => l.message).join('\n')).toBe('succeeded')
    const r = await report(key)
    expect(r.fields.version).toBe(3)
    expect(r.fields.layout).toBe(LAYOUT(query.id))
    const page = await json<ReportPage>(await ada(`/v1/reports/${key}`))
    expect(page.versions.map((v) => [v.version, v.restoredFrom])).toEqual([[3, 1], [2, null], [1, null]])
  })

  it('previews from the newest data, keeping the drawing with the run and publishing nothing', async () => {
    const run = await carried(ada, 'preview_report', { blueprint: REPORT_BLUEPRINT, key })
    expect(run.state, run.log.map((l) => l.message).join('\n')).toBe('succeeded')
    expect(run.outputs).toMatchObject({ members: 3, total: 8 })
    expect(run.steps.map((s) => s.name)).toEqual(['Gather', 'Write', 'Draw'])
    expect(run.link).toBe(`https://hub.example.org/reports/${key}?preview=${run.id}`)
    const shown = await json<ReportEditionRead>(await bob(`/v1/reports/${key}/previews/${run.id}`))
    expect(shown.content.blocks.find((b) => b.kind === 'narrative')).toMatchObject({ text: 'The crew grew. Nothing broke.' })
    expect((await hub.db.query(`SELECT 1 FROM entities WHERE blueprint = $1`, [EDITION_BLUEPRINT])).rowCount).toBe(0)
    expect((await report(key)).fields.editions).toBe(0)
  })

  it('publishes an edition read as its owner, keeps it, and tells only the recipients who may see it', async () => {
    const run = await carried(bob, 'publish_report', { blueprint: REPORT_BLUEPRINT, key })
    expect(run.state).toBe('failed')
    // Its home opens to four people by name. One of them never signed in: the rule lets them in, so they are sent it; someone it names nowhere is not.
    expect((await ops('/v1/blueprints/crew', put({ title: 'Crew', fields: {}, relations: {}, access: { grants: [{ values: ['ada@example.org', 'bob@example.org', 'eve@example.org', 'zed@example.org'] }] } }))).status).toBe(200)
    expect((await carried(ada, 'report_recipients', { blueprint: REPORT_BLUEPRINT, key }, { recipients: ['eve@example.org', 'nobody@example.org', 'zed@example.org'] })).state).toBe('succeeded')
    expect(hub.access.find('zed@example.org')).toBeNull()
    const done = await carried(ada, 'publish_report', { blueprint: REPORT_BLUEPRINT, key })
    expect(done.state, done.log.map((l) => l.message).join('\n')).toBe('succeeded')
    expect(done.steps.map((s) => s.name)).toEqual(['Gather', 'Write', 'Draw', 'Publish', 'Deliver', 'Verify'])
    const edition = (await hub.reader.get({ blueprint: EDITION_BLUEPRINT, key: `${key}/0001` }))!
    expect(edition.fields).toMatchObject({ number: 1, summary: 'The crew grew.', headline: { members: 3, total: 8 }, layout_version: 3, started_by: 'ada@example.org', run: done.id })
    expect(edition.relations.report?.map((r) => r.key)).toEqual([key])
    expect((await report(key)).fields).toMatchObject({ editions: 1, status: 'green', headline: { members: 3, total: 8 } })
    const told = (await hub.db.query<{ detail: { to: string[]; edition: number } }>(`SELECT detail FROM changes WHERE kind = 'report.published'`)).rows
    expect(told.map((r) => r.detail)).toEqual([expect.objectContaining({ edition: 1, to: ['eve@example.org', 'zed@example.org'] })])
    const sent: NoticeEvent[] = []
    const forwarder = new NoticeForwarder({ db: hub.db, actions: hub.actions, batches: hub.batches, sets: hub.changeSets, schedules: hub.schedules, people: hub.people, reader: hub.reader, blueprints: hub.blueprints, mailOf: (r, n) => hub.reports.mailOf(r, n), log: createLogger('notices') }, { url: 'https://desk.example.org', token: 't', publicUrl: 'https://hub.example.org', remindHours: 0 }, async (_url, init) => {
      const event = JSON.parse(String(init?.body)) as NoticeEvent
      // A desk that takes no page refuses the first send: the notice alone follows.
      if (event.kind && event.page !== undefined && !sent.some((e) => e.page !== undefined)) {
        sent.push(event)
        return new Response('the body must be one event as JSON', { status: 400 })
      }
      if (event.kind) sent.push(event)
      return new Response(JSON.stringify({}), { status: 200 })
    })
    await forwarder.pass()
    const [published, plain] = sent.filter((e) => e.kind === 'report.published')
    expect(published).toMatchObject({ title: 'Weekly crew: edition 1', text: 'The crew grew.', to: [{ person: 'eve@example.org' }, { person: 'zed@example.org' }], weight: 'notify', entity: { blueprint: REPORT_BLUEPRINT, key } })
    // The letter is the edition itself, drawn for mail.
    expect(published!.page).toContain('<!doctype html>')
    expect(published!.page).toContain('The crew grew.')
    expect(published!.page).toContain('>Builders</p>')
    expect(plain).toEqual({ ...published, page: undefined })
    expect(published!.facts).toEqual([{ name: 'Members', value: '3' }, { name: 'Things', value: '8' }])
  })

  it('says what changed since the edition before', async () => {
    await machine('/v1/ingest/entities/member/zoe', put({ title: 'zoe', fields: { email: 'zoe@example.org', things: 2 }, relations: { crews: ['builders'] } }))
    await hub.deriver.backfill()
    expect((await carried(ada, 'publish_report', { blueprint: REPORT_BLUEPRINT, key })).state).toBe('succeeded')
    const two = await json<ReportEditionRead>(await ada(`/v1/reports/${key}/editions/2`))
    const stats = two.content.blocks.find((b) => b.kind === 'stats')
    expect(stats).toMatchObject({ items: [{ name: 'members', value: 4, was: 3 }, { name: 'total', value: 10, was: 8 }] })
    const page = await json<ReportPage>(await bob(`/v1/reports/${key}`))
    expect(page).toMatchObject({ canChange: false, editions: [{ number: 2 }, { number: 1 }] })
  })

  it('draws an edition as a page to forward, escaping everything it read', async () => {
    const res = await ada(`/v1/reports/${key}/editions/1/body`)
    expect(res.headers.get('content-type')).toContain('text/html')
    const html = await res.text()
    expect(html).toContain('<h1 style=')
    // Headed by its home, as its owner sees it.
    expect(html).toContain('>Builders</p>')
    expect(html).toContain('https://hub.example.org/reports/weekly-crew?edition=1')
    expect(html).not.toContain('<svg')
    expect(html).not.toContain('<script')
  })

  it('is handed over only to someone who signs in and can read everything it names, and takes its schedules with it', async () => {
    const entity = { blueprint: REPORT_BLUEPRINT, key }
    const eve = as('eve@example.org')
    // Nobody the hub has not seen sign in owns a report: its data could not be read as them.
    const stranger = await ada('/v1/actions/orrery_report_hand/run', post({ entity, inputs: { owner: 'zed@example.org' } }))
    expect(stranger.status).toBe(400)
    expect(await json<{ error: string; input: string }>(stranger)).toMatchObject({ input: 'owner' })
    await eve('/v1/whoami')
    // The report reads a saved query that is its owner's alone, so the next owner could not read it.
    const unread = await carried(ada, 'orrery_report_hand', entity, { owner: 'eve@example.org' })
    expect(unread.state).toBe('failed')
    expect(unread.log.at(-1)?.message).toContain('no saved query')
    expect((await report(key)).fields.owner).toBe('ada@example.org')
    expect((await ada(`/v1/queries/${query.id}`, put({ title: 'Members', shared: true, spec: query.spec }))).status).toBe(200)
    const scheduled = await ada('/v1/schedules', post({ action: 'orrery_report_publish', title: 'Weekly', inputs: {}, target: { entity }, cadence: { every: 'week', days: ['fri'], at: '08:00', tz: 'UTC' } }))
    expect(scheduled.status, await scheduled.clone().text()).toBeLessThan(300)
    const handed = await carried(ada, 'orrery_report_hand', entity, { owner: 'eve@example.org' })
    expect(handed.state, handed.log.map((l) => l.message).join('\n')).toBe('succeeded')
    expect(handed.summary).toBe(`report ${key} belongs to eve@example.org, with 1 schedule`)
    expect((await report(key)).fields.owner).toBe('eve@example.org')
    expect((await hub.db.query<{ owner: string }>(`SELECT owner FROM action_schedules WHERE action = 'orrery_report_publish'`)).rows.map((r) => r.owner)).toEqual(['eve@example.org'])
    // Ada still owns its home, so she may still change it, and hand it back.
    expect((await carried(ada, 'orrery_report_hand', entity, { owner: 'ada@example.org' })).state).toBe('succeeded')
  })

  it('previews with a tool\'s rows as the newest edition read them, and afresh when asked', async () => {
    const entity = { blueprint: REPORT_BLUEPRINT, key }
    const kept = await carried(ada, 'orrery_report_preview', entity)
    expect(kept.state, kept.log.map((l) => l.message).join('\n')).toBe('succeeded')
    const lines = kept.log.map((l) => l.message)
    expect(lines.some((l) => /^counts: 2 rows, as edition \d+ read them$/.test(l))).toBe(true)
    expect(lines.some((l) => /^crew: \d+ rows$/.test(l))).toBe(true)
    const fresh = await carried(ada, 'orrery_report_preview', entity, { fresh: true })
    expect(fresh.log.map((l) => l.message)).toContain('counts: 2 rows')
  })

  it('brings its own actions, which nobody else changes or removes', async () => {
    const mine = await ops('/v1/actions/orrery_report_publish', put({ title: 'Mine', blueprint: REPORT_BLUEPRINT, inputs: {}, backend: { type: 'report', verb: 'publish' } }))
    expect(mine.status).toBe(409)
    expect((await ops('/v1/actions/orrery_report_publish', { method: 'DELETE' })).status).toBe(409)
    expect((await ops('/v1/actions/orrery_anything', put({ title: 'Mine', inputs: {}, backend: { type: 'caller' } }))).status).toBe(409)
  })

  it('keeps nothing of its editions once it is removed', async () => {
    expect((await carried(ada, 'remove_report', { blueprint: REPORT_BLUEPRINT, key })).state).toBe('succeeded')
    expect((await report(key)).state).toBe('deleted')
    expect((await hub.db.query(`SELECT 1 FROM entities WHERE blueprint = $1 AND state <> 'deleted'`, [EDITION_BLUEPRINT])).rowCount).toBe(0)
    expect((await hub.db.query('SELECT 1 FROM report_editions')).rowCount).toBe(0)
    expect((await ada(`/v1/reports/${key}`)).status).toBe(404)
  })
})
