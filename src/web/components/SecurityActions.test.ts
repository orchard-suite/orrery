import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { PostureItem, PosturePrincipal, PostureReach, PostureResponse, PostureWho } from '../../shared/posture.ts'
import { NO_FILTER, type ActionFilter } from './security-actions.ts'
import { SecurityActions } from './SecurityActions.tsx'

const PERSON = 'user@example.com'

const principal = (name: string, extra: Partial<PosturePrincipal> = {}): PosturePrincipal => ({ kind: 'person', name, admin: false, roles: [], permissions: [], signedIn: true, ...extra })

const action = (id: string, title: string, extra: Partial<Omit<PostureItem, 'action'>> = {}, more: Partial<NonNullable<PostureItem['action']>> = {}): PostureItem => ({
  target: { kind: 'action', id },
  title,
  group: null,
  origin: 'made here',
  open: false,
  grants: [],
  audiences: [],
  class: null,
  setAside: false,
  coverage: null,
  adminEdit: false,
  adminOnly: null,
  sensitive: [],
  people: 2,
  ...extra,
  action: { blueprints: [], backend: 'webhook', approval: false, where: null, rules: [], icon: 'rocket', home: null, homePeople: false, everyone: !!extra.open, lastRunAt: null, runs90: 0, ...more },
})

const posture = (items: PostureItem[]): PostureResponse => ({
  person: null,
  principals: [principal(PERSON), principal('admin@example.com', { admin: true })],
  items,
  findings: [],
  teams: [],
  policy: { policy: { audiences: [{ id: 'ops', title: 'Operations', people: [], grants: [], audiences: [] }], classes: [], edits: [] }, source: null },
  audiences: [],
  classes: [],
  review: [],
  coverage: { classified: 0, ruled: 0, reviewed: 0, unreviewed: 0 },
  map: [],
  handmade: [],
})

const estate = posture([
  action('restart', 'Restart', { grants: [{ path: 'team', values: ['Helpdesk'] }], people: 7 }, { backend: 'runner', home: { id: 'squad:core', title: 'Core' }, homePeople: true, lastRunAt: new Date(Date.now() - 3 * 86_400_000).toISOString(), runs90: 4, rules: [{ owns: true, approval: true }] }),
  action('ping', 'Ping', { open: true }),
  action('deploy', 'Deploy', { audiences: ['ops'] }, { approval: true, backend: 'github_workflow' }),
])

interface Seed {
  data?: PostureResponse
  filter?: Partial<ActionFilter>
  open?: string | null
  /** What the hub said the picked person may run. Left out while it has not answered. */
  reach?: string[]
  /** Who the hub said the open action lets in. Left out while it has not answered. */
  who?: PostureWho['rows']
}

function tab({ data = estate, filter = {}, open = null, reach, who }: Seed = {}): string {
  const client = new QueryClient()
  if (reach) client.setQueryData(['posture', 'reach', 'person', PERSON], { principal: principal(PERSON), blueprints: [], actions: reach.map((id) => ({ id, title: id, runs: true, offered: true, via: null })) } satisfies PostureReach)
  if (who && open) client.setQueryData(['posture', 'who', `action:${open}`], { target: { kind: 'action', id: open }, title: 'Restart', rows: who } satisfies PostureWho)
  return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(SecurityActions, { data, filter: { ...NO_FILTER, ...filter }, onFilter: () => {}, open, onOpen: () => {} })))
}

const words = (html: string): string => html.replace(/<[^>]*>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim()
/** The table's rows, each as the words it says. */
const rows = (html: string): string[] => (/<tbody[^>]*>(.*)<\/tbody>/s.exec(html)?.[1]?.match(/<tr\b.*?<\/tr>/gs) ?? []).map(words)

describe('the Actions tab of the Security page', () => {
  it('draws one row an action, by title, with where it belongs, who may run it, and when it last ran', () => {
    const html = tab()
    expect(rows(html)).toEqual([
      'Deploy deploy None Operations 2 Always GitHub workflow Never',
      'Ping ping None Everyone signed in 2 None Webhook Never',
      "Restart restart Core team is Helpdesk Its home's people 1 rule 7 By rule Runner 3d ago 4 in 90 days",
    ])
    expect(words(html)).toContain('3 of 3 actions')
  })

  it('links a row to its action and to its home', () => {
    const html = tab()
    expect(html).toContain('href="/actions/restart"')
    expect(html).toContain('href="/entities/squad/core"')
  })

  it('opens a row from a real button that says what it opens, and names the panel it opens', () => {
    const shut = tab()
    expect(shut).toMatch(/<button type="button" aria-expanded="false" aria-controls="security-action-restart" aria-label="Who may run Restart"/)
    expect(shut).not.toContain('role="region"')
    const html = tab({ open: 'restart', who: [{ principal: principal(PERSON), sees: true, changes: false, runs: true, via: 'team is Helpdesk' }, { principal: principal('other@example.com'), sees: true, changes: false, runs: false, via: null }] })
    expect(html).toMatch(/aria-expanded="true" aria-controls="security-action-restart"/)
    const panel = /<div id="security-action-restart" role="region" aria-label="Who may run Restart">.*?<\/table>/s.exec(html)?.[0] ?? ''
    expect(words(panel)).toContain('Restart : 1 of 2 may run it.')
    // Those it lets in, one by one, each with what lets them in; nobody it keeps out.
    expect(words(panel)).toContain(`${PERSON} No team is Helpdesk`)
    expect(panel).not.toContain('other@example.com')
  })

  it('waits for the hub to say who an open action lets in', () => {
    expect(words(tab({ open: 'restart' }))).toContain('Working it out…')
  })

  it('offers every filter with a name, and the teams, audiences, and backends the actions use', () => {
    const html = tab()
    for (const label of ['A person or token', 'Team', 'Audience', 'Backend', 'Open to everyone', 'No approval', 'Never run']) expect(words(html)).toContain(label)
    const options = (html.match(/<option[^>]*>.*?<\/option>/gs) ?? []).map(words)
    expect(options).toEqual(['Any team', 'team is Helpdesk', 'Any audience', 'Operations', 'Any backend', 'GitHub workflow', 'Runner', 'Webhook'])
    expect(html).not.toContain('Clear filters')
  })

  it('keeps the rows the filters leave, counts them, and offers to clear', () => {
    const html = tab({ filter: { neverRun: true, noApproval: true } })
    expect(rows(html)).toEqual(['Ping ping None Everyone signed in 2 None Webhook Never'])
    expect(words(html)).toContain('1 of 3 actions')
    expect(html).toContain('Clear filters')
  })

  it('keeps what a picked person may run, once the hub has said', () => {
    const waiting = tab({ filter: { person: `person:${PERSON}` } })
    expect(rows(waiting)).toEqual([])
    expect(words(waiting)).toContain('Working out what they may run…')
    expect(waiting).not.toContain('No action matches.')
    const html = tab({ filter: { person: `person:${PERSON}` }, reach: ['restart'] })
    expect(rows(html).map((r) => r.split(' ')[0])).toEqual(['Restart'])
    expect(words(html)).toContain('1 of 3 actions')
  })

  it('says so when no action matches', () => {
    const html = tab({ filter: { everyone: true, backend: 'runner' } })
    expect(rows(html)).toEqual([])
    expect(words(html)).toContain('No action matches.')
    expect(words(html)).toContain('0 of 3 actions')
  })

  it('says so when the hub has no action', () => {
    expect(words(tab({ data: posture([]) }))).toBe('This hub has no actions yet.')
  })

  it('reads a hub one release back, which says less of an action', () => {
    const old = action('old', 'Old', { open: true })
    old.action = { blueprints: [], backend: 'webhook', approval: false, where: null, rules: [] }
    expect(rows(tab({ data: posture([old]) }))).toEqual(['Old old None Everyone signed in 2 None Webhook Not known'])
  })
})
