import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ActionBatchSummary, ActionRunsResponse, ActionsResponse, ScheduleDay, WhoAmIResponse } from '../../shared/api.ts'
import type { ActionRun, ActionView } from '../../shared/model.ts'
import type { ChangeStatement } from '../../shared/change.ts'
import { keys } from '../api.ts'
import { ActionRunPage, RunsPanel } from './ActionRun.tsx'

const awaiting = (id: string, action: string): ActionRun => ({ id, action, entity: null, inputs: {}, by: 'user@example.com', state: 'awaiting', label: null, link: null, summary: null, log: [], steps: [], outputs: {}, claimedBy: null, decidedBy: null, decidedAt: null, tiers: [], revises: null, note: null, attempt: 1, retryAt: null, images: [], canDecide: true, createdAt: '2026-01-05T15:00:00Z', startedAt: null, finishedAt: null })

/** The runs panel as a signed-in person first sees it, with `waiting` awaiting their approval. `action` is the one action's page it sits on. */
function render(waiting: ActionRun[], action?: string): string {
  const client = new QueryClient()
  client.setQueryData(keys.whoami, { identity: { kind: 'user', name: 'approver@example.com', admin: false, roles: [], permissions: [] }, version: '0.0.0', telemetry: false, previews: [] } satisfies WhoAmIResponse)
  client.setQueryData(keys.actionRuns(new URLSearchParams({ state: 'awaiting', limit: '100', sets: 'apart' }).toString()), { runs: waiting, more: false } satisfies ActionRunsResponse)
  return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(RunsPanel, { action })))
}

/** The tab the panel shows as chosen. */
const chosen = (html: string): string | undefined => /id="(runs[^"]*)"[^>]*aria-selected="true"/.exec(html)?.[1]

describe('the tab the runs panel opens on', () => {
  it('is the approvals when a run waits for the person', () => {
    expect(chosen(render([awaiting('r1', 'deploy')]))).toBe('runs-approvals')
  })

  it('is their own runs when nothing waits', () => {
    expect(chosen(render([]))).toBe('runs-mine')
  })

  it("is their own runs on an action's page when only another action's run waits", () => {
    expect(chosen(render([awaiting('r1', 'deploy')], 'restart'))).toBe('runs-restart-mine')
  })

  it("is the approvals on the page of the action whose run waits", () => {
    expect(chosen(render([awaiting('r1', 'deploy')], 'deploy'))).toBe('runs-deploy-approvals')
  })
})

const ME = 'approver@example.com'
const view = (id: string, extra: Partial<ActionView> = {}): ActionView => ({ id, title: id, inputs: {}, backend: { type: 'webhook', url: 'https://hooks.example.com/run' }, origin: { kind: 'ui' }, updatedAt: '2026-01-05T15:00:00Z', canRun: true, lastRun: null, iconShown: 'rocket', stats: { usualSeconds: null, meanSeconds: null, failedInARow: 0 }, ...extra })
const mine = (id: string, extra: Partial<ActionRun> = {}): ActionRun => ({ ...awaiting(id, 'deploy'), by: ME, state: 'succeeded', canDecide: undefined, startedAt: '2026-01-05T15:00:01Z', finishedAt: '2026-01-05T15:00:09Z', ...extra })
const billing = { entity: { blueprint: 'service', key: 'svc-17' }, entityTitle: 'Billing' }

/** The person's own runs in the panel, with nothing waiting for them. `action` is the one action's page it sits on. */
function own(runs: ActionRun[], action?: string, batches: ActionBatchSummary[] = [], schedules: ScheduleDay[] = []): string {
  const client = new QueryClient()
  client.setQueryData(keys.whoami, { identity: { kind: 'user', name: ME, admin: false, roles: [], permissions: [] }, version: '0.0.0', telemetry: false } satisfies WhoAmIResponse)
  client.setQueryData(keys.actions, { actions: [view('deploy', { title: 'Deploy' }), view('apply', { title: 'Apply', backend: { type: 'caller' } }), view('patch', { title: 'Patch', backend: { type: 'runner', runner: 'runner-east', command: ['true'] } })] } satisfies ActionsResponse)
  client.setQueryData(keys.actionRuns(new URLSearchParams({ state: 'awaiting', limit: '100', sets: 'apart' }).toString()), { runs: [], more: false } satisfies ActionRunsResponse)
  const asked = new URLSearchParams({ limit: '50' })
  if (action) asked.set('action', action)
  asked.set('by', ME)
  asked.set('group', 'origin')
  asked.set('tz', Intl.DateTimeFormat().resolvedOptions().timeZone)
  client.setQueryData(keys.actionRuns(asked.toString()), { runs, more: false, batches, schedules } satisfies ActionRunsResponse)
  return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(RunsPanel, { action })))
}

/** The one row a panel shows. */
const row = (html: string): string => /<li\b.*?<\/li>/s.exec(html)?.[0] ?? ''

describe('a batch in the runs panel', () => {
  const batch: ActionBatchSummary = { id: 'b1', action: 'patch', blueprint: 'service', inputs: { command: 'ping' }, by: ME, asked: 37, refused: 0, counts: { succeeded: 35, failed: 2 }, done: true, createdAt: '2026-01-05T16:00:00Z', stoppedAt: null, stoppedBy: null, endedAt: '2026-01-05T16:00:17Z', cover: { run: 'r9', name: 'screen' } }

  it('is one line where its runs would be many: what ran, on how many, how they stand, its picture, and how long it took', () => {
    const html = own([mine('r1')], undefined, [batch])
    const lines = html.match(/<li\b/g) ?? []
    expect(lines).toHaveLength(2)
    expect(html).toContain('Patch · ping')
    expect(html).toContain('batch of 37')
    expect(html).toContain('2 failed · 35 succeeded')
    expect(html).toContain('/v1/action-runs/r9/outputs/screen')
    expect(html).toContain('took 17s')
    // The batch was asked after the run, so it is listed first.
    expect(html.indexOf('batch of 37')).toBeLessThan(html.indexOf('/runs/r1'))
  })
})

describe('a schedule in the runs panel', () => {
  const day: ScheduleDay = { schedule: 's1', title: 'Hourly ping', when: 'every hour at :05 (UTC)', targetTitle: 'All screens', owner: ME, action: 'patch', blueprint: 'service', day: '2026-01-05', firstAt: '2026-01-05T06:05:00Z', lastAt: '2026-01-05T17:05:00Z', firings: 12, counts: { succeeded: 33, failed: 3 }, missed: 1, error: 'screen 4 is offline' }

  it('is one line a day where its firings would be many: which schedule, how often, how many times, how its runs stand, and why it failed', () => {
    const html = own([mine('r1')], undefined, [], [day])
    expect(html.match(/<li\b/g) ?? []).toHaveLength(2)
    expect(html).toContain('href="/actions/schedules/s1"')
    expect(html).toContain('Hourly ping')
    expect(html).toContain('Patch')
    expect(html).toContain('every hour at :05 (UTC)')
    expect(html).toContain('fired 12 times, 1 asked nothing · on All screens')
    expect(html).toContain('3 failed · 33 succeeded')
    expect(html).toContain('screen 4 is offline')
    expect(html).toContain('aria-label="Show its firings"')
    // Its last firing came after the run, so it is listed first.
    expect(html.indexOf('Hourly ping')).toBeLessThan(html.indexOf('/runs/r1'))
  })

  it('is named by its action once the schedule is gone, and opens nowhere', () => {
    const html = own([], undefined, [], [{ ...day, title: null, when: null, targetTitle: null, counts: { succeeded: 2 }, missed: 0, error: null }])
    expect(html).toContain('a removed schedule')
    expect(html).not.toContain('/actions/schedules/s1')
    expect(html).toMatch(/<span[^>]*>Patch<\/span>/)
    expect(html).not.toContain('asked nothing')
  })
})

describe('a run in the runs panel', () => {
  it('is one line when it worked: its state in words, what ran, and on what by title', () => {
    const r = row(own([mine('r1', { ...billing, summary: 'Synced 4 resources', label: 'done' })]))
    expect(r).toContain('<span class="sr-only">succeeded</span>')
    expect(r).toContain('Deploy')
    expect(r).toContain('Billing')
    expect(r).not.toContain('svc-17')
    expect(r).not.toContain('Synced 4 resources')
    expect(r).not.toContain('took')
  })

  it('names the target by its key when the hub sends no title', () => {
    expect(row(own([mine('r1', { entity: billing.entity })]))).toContain('svc-17')
  })

  it('says why on a second line when it failed', () => {
    expect(row(own([mine('r1', { state: 'failed', summary: 'The pod never became ready' })]))).toContain('The pod never became ready')
    expect(row(own([mine('r2', { state: 'failed', label: 'exit 2' })]))).toContain('exit 2')
  })

  it('says on whom it waits on a second line', () => {
    const waits = { startedAt: null, finishedAt: null }
    expect(row(own([mine('r1', { ...waits, state: 'awaiting' })]))).toContain('Waits for approval')
    expect(row(own([mine('r2', { ...waits, state: 'queued', action: 'apply' })]))).toContain('Waits for you to start it')
    expect(row(own([mine('r3', { ...waits, state: 'queued', action: 'patch' })]))).toContain('Queued for runner-east')
  })

  it('says what to change on a second line when it was sent back', () => {
    const r = row(own([mine('r1', { state: 'returned', note: 'Say which page is slow', summary: null })]))
    expect(r).toContain('<span class="sr-only">sent back</span>')
    expect(r).toContain('Say which page is slow')
  })

  it("leads with the target on an action's own page", () => {
    const r = row(own([mine('r1', billing)], 'deploy'))
    expect(r).toMatch(/<a href="\/actions\/runs\/r1"[^>]*>Billing<\/a>/)
    expect(r).not.toContain('Deploy')
  })
})

describe("a run's page", () => {
  const page = (run: ActionRun, inputs: ActionView['inputs'] = {}): string => {
    const client = new QueryClient()
    client.setQueryData(keys.whoami, { identity: { kind: 'user', name: ME, admin: false, roles: [], permissions: [] }, version: '0.0.0', telemetry: false } satisfies WhoAmIResponse)
    client.setQueryData(keys.actions, { actions: [view('deploy', { title: 'Deploy', inputs })] } satisfies ActionsResponse)
    client.setQueryData(keys.actionRun(run.id), run)
    return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(ActionRunPage, { id: run.id })))
  }
  const shown = (run: ActionRun): string => /<h1\b.*?<\/h1>/s.exec(page(run))?.[0] ?? ''

  it('is headed by the action and the title of what it ran on, with the key beside it', () => {
    const h = shown(mine('r1', billing))
    expect(h).toMatch(/<a href="\/entities\/service\/svc-17"[^>]*>Billing<\/a>/)
    expect(h).toContain('svc-17</span>')
  })

  it('is headed by the key alone when the hub sends no title', () => {
    const h = shown(mine('r1', { entity: billing.entity }))
    expect(h).toMatch(/<a href="\/entities\/service\/svc-17"[^>]*>svc-17<\/a>/)
    expect(h).not.toContain('svc-17</span>')
  })

  it('shows each input it was given as its kind reads', () => {
    const inputs: ActionView['inputs'] = { note: { type: 'text', title: 'Note' }, due: { type: 'datetime', title: 'Due' }, lead: { type: 'person', title: 'Lead' }, loud: { type: 'boolean', title: 'Loud' }, sizes: { type: 'enum', many: true, values: ['s', 'm'], title: 'Sizes' }, why: { type: 'string', title: 'Why' } }
    const html = page(mine('r1', { inputs: { note: 'first line\nsecond line', due: '2026-03-10T14:30:00.000Z', lead: 'human:u1', loud: true, sizes: ['s', 'm'], why: null, old: 'kept' } }), inputs)
    /** The value beside a label in the inputs panel. */
    const given = (label: string): string => new RegExp(`<dt[^>]*>${label}</dt>(<dd\\b.*?</dd>)`, 's').exec(html)?.[1] ?? ''
    // Long text keeps its lines and reads as words, not as code.
    expect(given('Note')).toContain('whitespace-pre-wrap')
    expect(given('Note')).toContain('first line\nsecond line')
    expect(given('Note')).not.toContain('font-mono')
    // A moment is read on the reader's own clock, with the instant behind it.
    expect(given('Due')).toMatch(/<time dateTime="2026-03-10T14:30:00.000Z" title="2026-03-10T14:30:00.000Z">[^<]*2026[^<]*<\/time>/)
    expect(given('Lead')).toContain('font-mono')
    expect(given('Lead')).toContain('human:u1')
    expect(given('Loud')).toContain('>Yes<')
    expect(given('Sizes')).toContain('>s, m<')
    expect(given('Why')).toContain('Not given')
    // An input the action no longer asks is still shown, under its name.
    expect(given('old')).toContain('>kept<')
  })

  it('shows the change a run states in place of its JSON, above the decision it asks for', () => {
    const statement: ChangeStatement = {
      key: 'plan-7f3a2c',
      writer: { name: 'infra', version: '3.1.0' },
      actor: { kind: 'agent', id: 'agent-1', on_behalf_of: 'user@example.com' },
      things: [{ blueprint: 'workload', key: 'acme-api-prod' }],
      artifact: { kind: 'plan', digest: `sha256:${'9'.repeat(64)}` },
      applier: 'hub',
      effects: [{ kind: 'stops', subject: { blueprint: 'workload', key: 'acme-api-prod' }, path: 'in-place', size: 2, undo: 'no', claim: { from: 'writer', rule: 'app-settings-restart' } }],
      unknown: [{ part: 'site_config.cors', why: 'unread' }],
    }
    const inputs: ActionView['inputs'] = { plan: { type: 'change', title: 'The change' }, env: { type: 'string', title: 'Environment' } }
    const html = page(mine('r1', { state: 'awaiting', inputs: { plan: statement, env: 'prod' }, statementDigest: `sha256:${'6'.repeat(64)}` }), inputs)
    expect(html).toContain('What you are asked to approve')
    expect(html).toContain('a job the hub starts')
    expect(html).toContain('agent agent-1, for user@example.com')
    expect(html).toMatch(/<td[^>]*>stops<\/td><td[^>]*>workload acme-api-prod<\/td><td[^>]*>in-place<\/td><td[^>]*>2<\/td><td[^>]*>No<\/td>/)
    expect(html).toContain('app-settings-restart')
    expect(html).toContain('site_config.cors')
    expect(html).toContain('which the writer could not read')
    expect(html).toContain(`sha256:${'6'.repeat(64)}`)
    expect(html).not.toContain('&quot;applier&quot;')
    // The other inputs are listed as ever, and the statement is not one of them.
    expect(html).toMatch(/<dt[^>]*>Environment<\/dt>/)
    expect(html).not.toMatch(/<dt[^>]*>The change<\/dt>/)
  })

  it('leaves out an input the form did not ask for that run, and shows a worked-out value like any other', () => {
    const inputs: ActionView['inputs'] = { env: { type: 'enum', values: ['dev', 'prod'], title: 'Environment' }, reason: { type: 'string', title: 'Reason', when: { field: 'env', op: 'eq', value: 'prod' } }, slug: { type: 'string', title: 'Slug', value: "'run-' + env" } }
    const html = page(mine('r1', { inputs: { env: 'dev', reason: null, slug: 'run-dev' } }), inputs)
    expect(html).toContain('>Environment</dt>')
    expect(html).not.toContain('>Reason</dt>')
    expect(html).toMatch(/<dt[^>]*>Slug<\/dt><dd[^>]*>run-dev<\/dd>/)
    expect(page(mine('r1', { inputs: { env: 'prod', reason: null, slug: 'run-prod' } }), inputs)).toMatch(/<dt[^>]*>Reason<\/dt><dd[^>]*>Not given<\/dd>/)
  })

  it('names an entity it was given by its title where the hub sends one, with its id beside it', () => {
    const inputs: ActionView['inputs'] = { lead: { type: 'person', title: 'Lead' }, crews: { type: 'entity', blueprint: 'crew', many: true, title: 'Crews' } }
    const html = page(mine('r1', { inputs: { lead: 'human:u1', crews: ['crew:web', 'crew:core'] }, inputTitles: { 'human:u1': 'A user', 'crew:web': 'Web' } }), inputs)
    const given = (label: string): string => new RegExp(`<dt[^>]*>${label}</dt>(<dd\\b.*?</dd>)`, 's').exec(html)?.[1] ?? ''
    expect(given('Lead')).toMatch(/A user.*<span class="[^"]*font-mono[^"]*">human:u1<\/span>/s)
    expect(given('Crews')).toMatch(/Web.*crew:web/s)
    // The hub sent no title for one the reader may not see: its id stands alone.
    expect(given('Crews')).toMatch(/<div[^>]*><span class="[^"]*font-mono[^"]*">crew:core<\/span><\/div>/)
  })

  it('lists the inputs in the order the form asked', () => {
    const inputs: ActionView['inputs'] = { zone: { type: 'string', title: 'Zone' }, app: { type: 'string', title: 'App' }, size: { type: 'string', title: 'Size' } }
    const html = page(mine('r1', { inputs: { old: 'kept', app: 'a', size: 's', zone: 'z' } }), inputs)
    const labels = [...html.matchAll(/<dt[^>]*>(Zone|App|Size|old)<\/dt>/g)].map((m) => m[1])
    expect(labels).toEqual(['Zone', 'App', 'Size', 'old'])
  })

  const at = (s: number) => `2026-01-05T15:00:${String(s).padStart(2, '0')}.000Z`
  const ESC = '\u001b'
  /** A run that named three steps and failed in the last, with a value it ended with and a link. */
  const failed = mine('r7', {
    state: 'failed',
    createdAt: at(0),
    startedAt: at(12),
    finishedAt: at(50),
    claimedBy: 'east',
    steps: [{ name: 'Stop', at: at(13) }, { name: 'Start', at: at(20) }, { name: 'Verify', at: at(30) }],
    outputs: { url: 'https://example.org/deploys/7', replicas: 3 },
    log: [
      { at: at(12), message: 'claimed by runner east' },
      { at: at(13), message: 'stopping the old one', step: 'Stop' },
      { at: at(14), message: `${ESC}[32mstopped${ESC}[0m`, step: 'Stop' },
      { at: at(20), message: 'starting the new one', step: 'Start' },
      { at: at(30), message: `${ESC}[1;31mnot ready${ESC}[0m after 20s${ESC}[K`, step: 'Verify' },
      { at: at(50), message: '{"level":"ERROR","msg":"The app never answered","step":"Verify","tries":4}', step: 'Verify' },
      { at: at(50), message: 'failed: exit 1' },
    ],
  })
  /** A step's heading in the log. */
  const heading = (html: string, name: string): string => new RegExp(`<summary\\b(?:(?!</summary>).)*?>${name}<.*?</summary>`, 's').exec(html)?.[0] ?? ''

  it('shows what the run ended with above its log, a link where a value is one, each with a copy', () => {
    const html = page(failed)
    const result = /<section\b(?:(?!<\/section>).)*>Result<.*?<\/section>/s.exec(html)?.[0] ?? ''
    expect(result).toContain('<dt')
    expect(result).toMatch(/<a href="https:\/\/example\.org\/deploys\/7"[^>]*>https:\/\/example\.org\/deploys\/7<\/a>/)
    expect(result).toContain('>3<')
    expect(result).toContain('Copy<span class="sr-only"> url</span>')
    expect(result).toContain('Copy<span class="sr-only"> replicas</span>')
    expect(html.indexOf('>Result<')).toBeLessThan(html.indexOf('aria-label="Run log"'))
  })

  it('puts the log under the steps the backend named, each with its lines and how long it took', () => {
    const html = page(failed)
    expect(heading(html, 'Stop')).toContain('2 lines')
    expect(heading(html, 'Stop')).toContain('7s')
    expect(heading(html, 'Stop')).toContain('<span class="sr-only">done</span>')
    expect(heading(html, 'Verify')).toContain('20s')
    expect(heading(html, 'Verify')).toContain('<span class="sr-only">failed</span>')
    // The step it failed in is open; the ones that went well are closed, and draw no lines until opened.
    expect(html).toMatch(/<details open=""[^>]*>\s*<summary\b(?:(?!<\/summary>).)*>Verify</s)
    expect(html).toContain('The app never answered · tries: 4')
    expect(html).not.toContain('stopping the old one')
    expect(html).not.toContain('starting the new one')
    // A line under no step has no heading, and every line says how long after the start it came.
    expect(html).toContain('claimed by runner east')
    expect(html).toMatch(/<time[^>]*>\+0:18<\/time>/)
    expect(html).toMatch(/<time[^>]*>\+0:38<\/time>/)
  })

  it("draws a line's colours in the theme's own and leaves no escape on the page", () => {
    const html = page(failed)
    expect(html).toMatch(/<span class="[^"]*\btext-red\b[^"]*\bfont-semibold\b[^"]*">not ready<\/span> after 20s/)
    expect(html).not.toContain(ESC)
    const one = page(mine('r8', { ...failed, id: 'r8', state: 'succeeded', steps: [{ name: 'Stop', at: at(13) }], log: failed.log.slice(0, 3) }))
    // The only step is open.
    expect(one).toMatch(/<span class="[^"]*\btext-green\b[^"]*">stopped<\/span>/)
  })

  it('says what happened with how long each part took, and marks the step it failed in', () => {
    const html = page(failed)
    const happened = /<ol\b[^>]*aria-label="What happened"[^>]*>.*?<\/ol>/s.exec(html)?.[0] ?? ''
    expect(happened).toContain('Queued 12s')
    expect(happened).toContain('Picked up by runner east')
    expect(happened).toContain('Ran for 38s')
    expect(happened).toMatch(/Verify<span class="sr-only">, failed<\/span>/)
    expect(happened).toMatch(/Stop<span class="sr-only">, done<\/span>/)
    expect(happened).toContain('Failed')
  })

  it('offers whoever may decide it three answers, and sending it back needs a note', () => {
    const html = page({ ...awaiting('r1', 'deploy'), by: 'user@example.com', tiers: ['act'] })
    expect(html).toContain('This run waits for your approval.')
    expect(html).toMatch(/Approving it grants its tools.*?>act</s)
    const buttons = [...html.matchAll(/<button\b[^>]*>(?:<[^>]+>)*([^<]+)/g)].map((m) => [m[1], / disabled=""/.test(m[0])])
    expect(buttons).toEqual(expect.arrayContaining([['Approve', false], ['Send back', true], ['Decline', false]]))
    expect(page({ ...awaiting('r2', 'deploy'), canDecide: false })).not.toContain('Send back')
  })

  it('shows the note of a run sent back, and the run a new one asks again for', () => {
    const back = page(mine('r1', { state: 'returned', decidedBy: 'approver2@example.com', note: 'Say which page is slow' }))
    expect(back).toContain('Sent back by approver2@example.com')
    expect(back).toContain('Say which page is slow')
    expect(back).toContain('Run sent back')
    expect(page(mine('r2', { state: 'queued', revises: 'r1', finishedAt: null }))).toMatch(/Asks again for <a href="\/actions\/runs\/r1"[^>]*>a run sent back<\/a>/)
  })

  it('draws the run of a hub that names no steps and holds no outputs', () => {
    const { steps: _steps, outputs: _outputs, ...old } = mine('r9', { startedAt: at(1), finishedAt: at(9), createdAt: at(0), log: [{ at: at(1), message: 'started' }, { at: at(9), message: 'succeeded: done' }] })
    const html = page(old as ActionRun)
    expect(html).not.toContain('>Result<')
    expect(html).not.toContain('<summary')
    expect(html).toContain('succeeded: done')
    expect(html).toMatch(/<time[^>]*>\+0:08<\/time>/)
    expect(html).toContain('Ran for 8s')
  })
})
