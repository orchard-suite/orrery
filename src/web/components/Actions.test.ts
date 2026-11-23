import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ActionRunsResponse, ActionsLayout, ActionsResponse, BlueprintsResponse, WhoAmIResponse } from '../../shared/api.ts'
import type { Home, ActionRun, ActionView, Blueprint, Entity, Permission, Pin } from '../../shared/model.ts'
import { keys } from '../api.ts'
import { Actions } from './Actions.tsx'
import { HomeActions } from './ActionStart.tsx'

const ME = 'approver@example.com'

const view = (id: string, extra: Partial<ActionView> = {}): ActionView => ({ id, title: id, inputs: {}, backend: { type: 'webhook', url: 'https://hooks.example.com/run' }, origin: { kind: 'ui' }, updatedAt: '2026-01-05T15:00:00Z', canRun: true, lastRun: null, iconShown: 'rocket', stats: { usualSeconds: null, meanSeconds: null, failedInARow: 0 }, ...extra })

let n = 0
const run = (action: string, extra: Partial<ActionRun> = {}): ActionRun => ({ id: `r${++n}`, action, entity: null, inputs: {}, by: 'user@example.com', state: 'succeeded', label: null, link: null, summary: null, log: [], steps: [], outputs: {}, claimedBy: null, decidedBy: null, decidedAt: null, tiers: [], revises: null, note: null, attempt: 1, retryAt: null, images: [], createdAt: '2026-01-05T15:00:00Z', startedAt: null, finishedAt: null, ...extra })
const waiting = (action: string, extra: Partial<ActionRun> = {}): ActionRun => run(action, { state: 'awaiting', canDecide: true, ...extra })

interface Seed {
  /** The actions as the hub sent them. A hub one release back sends less than an `ActionView`. */
  actions: object[]
  waiting?: ActionRun[]
  mine?: ActionRun[]
  layout?: ActionsLayout
  permissions?: Permission[]
  /** The person's pins as the hub answered them: null from a hub that keeps none, and left out while it has not answered. */
  pins?: Pin[] | null
  /** An admin is viewing the hub as this person. */
  viewing?: boolean
  /** The action whose own page is open, in place of the start page. */
  id?: string
  /** The entity whose page is open, in place of the Self-service pages: what it is home to is drawn. */
  on?: Pick<Entity, 'blueprint' | 'key' | 'id' | 'title' | 'actions'>
}

const squad: Blueprint = { id: 'squad', title: 'Squad', fields: {}, relations: {}, origin: { kind: 'ui' }, updatedAt: '' }
const home = (key: string, title: string, yours = false): Home => ({ id: `squad:${key}`, entity: { blueprint: 'squad', key }, title, icon: 'team', yours })

/** The start page as a signed-in person first sees it. */
function page({ actions, waiting: awaits = [], mine = [], layout = { order: [], closed: [] }, permissions = [], pins, viewing = false, id, on }: Seed): string {
  const client = new QueryClient()
  client.setQueryData(keys.whoami, { identity: { kind: 'user', name: ME, admin: false, roles: [], permissions, ...(viewing ? { viewAs: { by: 'admin@example.com' } } : {}) }, version: '0.0.0', telemetry: false } satisfies WhoAmIResponse)
  if (pins !== undefined) client.setQueryData(keys.pins, pins)
  client.setQueryData(keys.actions, { actions })
  client.setQueryData(keys.blueprints, { blueprints: [squad], counts: {}, held: {}, layout: { order: [], closed: [], blueprints: {}, hidden: [] }, adminOnly: [] } satisfies BlueprintsResponse)
  client.setQueryData([...keys.actions, 'layout'], layout)
  client.setQueryData(keys.actionRuns(new URLSearchParams({ state: 'awaiting', limit: '100', sets: 'apart' }).toString()), { runs: awaits, more: false } satisfies ActionRunsResponse)
  client.setQueryData(keys.actionRuns(new URLSearchParams({ limit: '50', by: ME, scheduled: 'false' }).toString()), { runs: mine, more: false } satisfies ActionRunsResponse)
  return renderToStaticMarkup(createElement(QueryClientProvider, { client }, on ? createElement(HomeActions, { entity: on as Entity }) : createElement(Actions, { id: id ?? null })))
}

/** What a piece of the page says, without its markup. */
const words = (html: string): string => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
/** What each section of the page is headed, in the order they are drawn. */
const headings = (html: string): string[] => (html.match(/<section\b.*?<\/section>/gs) ?? []).map((s) => words(/<h2[^>]*>.*?<\/h2>/s.exec(s)?.[0] ?? '')).filter((h) => h !== 'Recent' && h !== 'Runs')
/** The section of the page whose heading says `heading`. */
const under = (html: string, heading: string): string => (html.match(/<section\b.*?<\/section>/gs) ?? []).find((s) => words(/<h2[^>]*>.*?<\/h2>/s.exec(s)?.[0] ?? '').startsWith(heading)) ?? ''

/** The section of the page under a heading that holds `heading`, or nothing when there is none. */
const part = (html: string, heading: string): string => (html.match(/<section\b.*?<\/section>/gs) ?? []).find((s) => new RegExp(`<h2[^>]*>(?:(?!</h2>).)*${heading}`, 's').test(s)) ?? ''
/** Each row of a part. */
const rows = (html: string): string[] => html.match(/<li\b.*?<\/li>/gs) ?? []
/** The tile of the action with this title. */
const tile = (html: string, title: string): string => rows(html).find((r) => r.includes(`>${title}<`)) ?? ''

describe('an action run only from its rows', () => {
  const approve = view('approve', { title: 'Approve', blueprint: 'approval', listed: false })
  const restart = view('restart', { title: 'Restart app' })

  it('has no tile on the start page, even pinned, and no pin on its own page', () => {
    const html = page({ actions: [approve, restart], pins: [{ kind: 'action', id: 'approve' }] })
    expect(tile(html, 'Restart app')).not.toBe('')
    expect(tile(html, 'Approve')).toBe('')
    const own = (a: ActionView) => page({ actions: [{ ...a, canRun: false }], pins: [], id: a.id, permissions: ['actions.manage'] })
    expect(own(restart)).toMatch(/aria-label="Pin Restart app"/)
    expect(own(approve)).not.toMatch(/aria-label="Pin Approve"/)
  })

  it("has no tile on its home's page", () => {
    const at = home('core', 'Core')
    const html = page({ actions: [{ ...approve, home: at.id, homeShown: at }], on: { blueprint: 'squad', key: 'core', id: at.id, title: 'Core', actions: [] } })
    expect(tile(html, 'Approve')).toBe('')
  })
})

describe('a tile on the start page', () => {
  const restart = view('restart', { title: 'Restart app', description: 'Restarts the app and waits for it to answer.', iconShown: 'argocd' })

  it('runs the action, and keeps its description for a hover and a screen reader', () => {
    const t = tile(page({ actions: [restart] satisfies ActionsResponse['actions'] }), 'Restart app')
    expect(t).toMatch(/<button[^>]*aria-haspopup="dialog"/)
    expect(t).toContain('<span class="sr-only">Run </span>Restart app<')
    expect(t).toContain('/icons/argocd.svg')
    expect(t).toMatch(/<button[^>]*title="Restarts the app and waits for it to answer\."/)
    const described = /<button[^>]*aria-describedby="([^"]+)"/.exec(t)?.[1]
    expect(described).toBeTruthy()
    expect(t).toContain(`id="${described}" class="sr-only">Restarts the app and waits for it to answer.<`)
  })

  it('links to the page of the action', () => {
    const t = tile(page({ actions: [restart] }), 'Restart app')
    expect(t).toMatch(/<a href="\/actions\/restart"[^>]*aria-label="Details of Restart app"/)
  })

  it('says in words that it needs approval and that it is failing', () => {
    const quiet = tile(page({ actions: [restart] }), 'Restart app')
    expect(quiet).not.toContain('Needs approval')
    expect(quiet).not.toContain('Failed the last')
    const marked = tile(page({ actions: [view('restart', { title: 'Restart app', approval: true, stats: { usualSeconds: 4, meanSeconds: null, failedInARow: 3 } })] }), 'Restart app')
    expect(marked).toContain('Needs approval')
    expect(marked).toContain('Failed the last 3 runs')
  })

  it('is a link alone for someone who may change it and not run it', () => {
    const t = tile(page({ actions: [view('restart', { title: 'Restart app', canRun: false })], permissions: ['actions.manage'] }), 'Restart app')
    expect(t).not.toContain('<button')
    expect(t).toContain('href="/actions/restart"')
    expect(t).toContain('You may edit it, not run it')
  })

  it('draws against a hub that sends no icon to show and no stats', () => {
    const { iconShown: _i, stats: _s, ...old } = restart
    const t = tile(page({ actions: [old] }), 'Restart app')
    expect(t).toContain('lucide-rocket')
    expect(t).not.toContain('Failed the last')
  })
})

describe('the sections of the start page', () => {
  it('follow the shared order, with what has no group last', () => {
    const html = page({ actions: [view('a', { group: 'Apps' }), view('b', { group: 'Deploys' }), view('c')], layout: { order: ['Deploys'], closed: [] } })
    const at = ['Deploys', 'Apps', 'Everything else'].map((g) => html.indexOf(`${g}<span`))
    expect(at.every((i) => i > 0)).toBe(true)
    expect([...at].sort((x, y) => x - y)).toEqual(at)
  })

  it('offer one search, reached with the slash key', () => {
    expect(page({ actions: [view('a')] })).toMatch(/<input[^>]*type="search"[^>]*aria-keyshortcuts="\/"/)
  })
})

describe('an action with a home', () => {
  const actions = [
    view('grant', { title: 'Grant access', group: 'Access', home: 'squad:core', homeShown: home('core', 'Core', true) }),
    view('rotate', { title: 'Rotate keys', home: 'squad:core', homeShown: home('core', 'Core', true) }),
    view('page', { title: 'Page on call', home: 'squad:edge', homeShown: home('edge', 'Edge') }),
    view('deploy', { title: 'Deploy', group: 'Deploys' }),
    view('note', { title: 'Leave a note' }),
  ]

  it("sits under its home: the reader's own first, then the other homes, the groups, and the rest", () => {
    const heads = headings(page({ actions, pins: null }))
    expect(heads).toEqual(['Your squad: Core · 2', 'Edge · 1', 'Deploys · 1', 'Everything else · 1'])
  })

  it('is listed under the home alone, whatever group it names', () => {
    const html = page({ actions, pins: null })
    expect(rows(under(html, 'Your squad: Core')).map((r) => words(r))).toEqual([expect.stringContaining('Grant access'), expect.stringContaining('Rotate keys')])
    expect(headings(html)).not.toContain('Access · 1')
  })

  it("heads its section with the home's icon and title, as a link to the home's page", () => {
    const section = under(page({ actions, pins: null }), 'Your squad: Core')
    const heading = /<h2[^>]*>.*?<\/h2>/s.exec(section)?.[0] ?? ''
    expect(heading).toMatch(/<a href="\/entities\/squad\/core"[^>]*>(?:(?!<\/a>).)*Core/s)
    expect(heading).toContain('lucide-users')
    // The fold is a button of its own, named for the section it folds.
    const fold = /<button[^>]*aria-expanded="true"[^>]*>/.exec(heading)?.[0] ?? ''
    const named = /aria-labelledby="([^"]+)"/.exec(fold)?.[1]
    expect(named).toBeTruthy()
    expect(words(new RegExp(`<span id="${named}"[^>]*>.*?</a>`, 's').exec(heading)?.[0] ?? '')).toBe('Your squad: Core')
  })

  it('keeps the shared order and what starts closed, by the id of the home', () => {
    const html = page({ actions, pins: null, layout: { order: ['Deploys', 'squad:edge'], closed: ['squad:edge'] } })
    expect(headings(html)).toEqual(['Your squad: Core · 2', 'Deploys · 1', 'Edge · 1', 'Everything else · 1'])
    expect(under(html, 'Edge')).toMatch(/<button[^>]*aria-expanded="false"/)
    expect(under(html, 'Edge')).toMatch(/<ul[^>]*hidden=""/)
  })

  it('falls back to its group where the reader may not see the home, or the hub says nothing of one', () => {
    const html = page({ actions: [view('grant', { title: 'Grant access', group: 'Access', homeShown: null }), view('rotate', { title: 'Rotate keys', group: 'Access', home: 'squad:core' })], pins: null })
    expect(headings(html)).toEqual(['Access · 2'])
  })

  it("says on its own page where its home is, and that the home's people run it", () => {
    const html = page({ actions: [view('grant', { title: 'Grant access', canRun: false, home: 'squad:core', homeShown: home('core', 'Core'), access: { home: ['lead'] } })], pins: null, id: 'grant', permissions: ['actions.manage'] })
    expect(html).toMatch(/<a href="\/entities\/squad\/core"[^>]*>(?:(?!<\/a>).)*Core/s)
    expect(words(html)).toContain('the people who own its home as lead')
    expect(words(html)).not.toContain('Only an admin runs this action')
  })
})

describe("the actions on their home's page", () => {
  const core = { blueprint: 'squad', key: 'core', id: 'squad:core', title: 'Core', actions: ['rotate'] }
  const actions = [
    view('rotate', { title: 'Rotate keys', blueprint: 'squad', home: 'squad:core', homeShown: home('core', 'Core', true) }),
    view('grant', { title: 'Grant access', canRun: false, home: 'squad:core', homeShown: home('core', 'Core', true) }),
    view('sync', { title: 'Sync', form: false, home: 'squad:core', homeShown: home('core', 'Core', true) }),
    view('page', { title: 'Page on call', home: 'squad:edge', homeShown: home('edge', 'Edge') }),
    view('deploy', { title: 'Deploy' }),
  ]

  it('are small tiles under a heading, one for each action it is home to that has a form', () => {
    const html = page({ actions, pins: [], on: core, permissions: ['actions.manage'] })
    expect(html).toMatch(/<h2[^>]*>Actions<\/h2>/)
    expect(rows(html)).toHaveLength(2)
    expect(tile(html, 'Grant access')).toContain('href="/actions/grant"')
    expect(tile(html, 'Rotate keys')).toMatch(/<button[^>]*aria-haspopup="dialog"/)
    expect(html).not.toContain('Page on call')
    expect(html).not.toContain('Sync')
  })

  it('are not drawn on the page of an entity that is home to none', () => {
    expect(page({ actions, pins: [], on: { ...core, key: 'ops', id: 'squad:ops', title: 'Ops' } })).toBe('')
    expect(page({ actions: [], pins: [], on: core })).toBe('')
  })
})

describe('the approvals band', () => {
  const actions = [view('deploy', { title: 'Deploy' })]
  const on = (key: string, title: string | null): Partial<ActionRun> => ({ entity: { blueprint: 'service', key }, entityTitle: title })

  it('is not drawn when nothing waits', () => {
    expect(page({ actions })).not.toContain('for you</h2>')
  })

  it('counts what waits and shows the first three, each to approve or decline', () => {
    const band = part(page({ actions, waiting: [waiting('deploy', on('svc-1', 'Billing')), waiting('deploy', on('svc-2', 'Ledger')), waiting('deploy', on('svc-3', 'Mail')), waiting('deploy', on('svc-4', 'Search'))] }), '4 runs wait for you')
    expect(rows(band)).toHaveLength(3)
    expect(rows(band)[0]).toContain('Deploy')
    expect(rows(band)[0]).toContain('Billing')
    expect(rows(band)[0]).toContain('user@example.com')
    expect(rows(band)[0]).toContain('Approve<span class="sr-only"> Deploy on Billing, asked by user@example.com</span>')
    expect(rows(band)[0]).toContain('Decline<span class="sr-only"> Deploy on Billing, asked by user@example.com</span>')
    expect(band).not.toContain('Search')
    expect(band).toMatch(/<button[^>]*>See all/)
  })

  it('says one run waits, and names a target by its key when the hub sends no title', () => {
    const band = part(page({ actions, waiting: [waiting('deploy', { entity: { blueprint: 'service', key: 'svc-1' } })] }), '1 run waits for you')
    expect(rows(band)).toHaveLength(1)
    expect(rows(band)[0]).toContain('svc-1')
  })
})

describe('the recent runs on the start page', () => {
  const actions = [view('deploy', { title: 'Deploy' }), view('restart', { title: 'Restart app' }), view('locked', { title: 'Rotate keys', canRun: false })]
  const on = (key: string, title: string): Partial<ActionRun> => ({ entity: { blueprint: 'service', key }, entityTitle: title, by: ME })

  it('are one of each action and target, each to run again', () => {
    const recent = part(page({ actions, mine: [run('deploy', on('svc-1', 'Billing')), run('deploy', on('svc-1', 'Billing')), run('restart', { by: ME, state: 'failed' }), run('gone', { by: ME })] }), 'Recent')
    expect(rows(recent)).toHaveLength(2)
    expect(rows(recent)[0]).toContain('Deploy')
    expect(rows(recent)[0]).toContain('Billing')
    expect(rows(recent)[0]).not.toContain('svc-1')
    expect(rows(recent)[0]).toContain('<span class="sr-only">succeeded</span>')
    expect(rows(recent)[0]).toContain('Again<span class="sr-only">: Deploy on Billing</span>')
    expect(rows(recent)[1]).toContain('<span class="sr-only">failed</span>')
    expect(rows(recent)[1]).toContain('Again<span class="sr-only">: Restart app</span>')
  })

  it('are five at most', () => {
    const mine = Array.from({ length: 8 }, (_, i) => run('deploy', on(`svc-${i}`, `Service ${i}`)))
    expect(rows(part(page({ actions, mine }), 'Recent'))).toHaveLength(5)
  })

  it('offer no second run of what the person may not run', () => {
    const recent = part(page({ actions, mine: [run('locked', { by: ME })], permissions: ['actions.manage'] }), 'Recent')
    expect(rows(recent)).toHaveLength(1)
    expect(recent).not.toContain('Again')
  })

  it('say where they will show while there are none', () => {
    expect(part(page({ actions }), 'Recent')).toContain('What you run shows here.')
  })
})

describe('a pin', () => {
  const actions = [view('deploy', { title: 'Deploy' }), view('restart', { title: 'Restart app' }), view('rotate', { title: 'Rotate keys', canRun: false })]
  const pin = (id: string): Pin => ({ kind: 'action', id })
  /** The star of the action with this title: the button that pins it or lets it go. */
  const star = (html: string, title: string): string => (html.match(/<button\b[^>]*>/g) ?? []).find((b) => b.includes(`aria-label="Pin ${title}"`) || b.includes(`aria-label="Unpin ${title}"`)) ?? ''
  const stars = (html: string): string[] => (html.match(/<button\b[^>]*>/g) ?? []).filter((b) => /aria-label="(Pin|Unpin) /.test(b))

  it('is a star on every tile, pressed on what is pinned', () => {
    const all = part(page({ actions, pins: [pin('restart')], permissions: ['actions.manage'] }), 'Everything else')
    expect(star(tile(all, 'Deploy'), 'Deploy')).toContain('aria-pressed="false"')
    expect(star(tile(all, 'Deploy'), 'Deploy')).toContain('aria-label="Pin Deploy"')
    expect(star(tile(all, 'Restart app'), 'Restart app')).toContain('aria-pressed="true"')
    expect(star(tile(all, 'Restart app'), 'Restart app')).toContain('aria-label="Unpin Restart app"')
    // What a person may only edit is theirs to pin too.
    expect(star(tile(all, 'Rotate keys'), 'Rotate keys')).toContain('aria-label="Pin Rotate keys"')
  })

  it('is a star on the page of the action', () => {
    // The page of one the reader may not run: a form to run reads the address, which no test has.
    expect(star(page({ actions, pins: [], id: 'rotate' }), 'Rotate keys')).toContain('aria-pressed="false"')
    expect(star(page({ actions, pins: [pin('rotate')], id: 'rotate' }), 'Rotate keys')).toContain('aria-pressed="true"')
  })

  it('puts the action in Pinned, in the order of the pins, each to move earlier or later', () => {
    const pinned = part(page({ actions, pins: [pin('restart'), pin('gone'), pin('deploy'), pin('rotate')], permissions: ['actions.manage'] }), 'Pinned')
    const tiles = rows(pinned)
    expect(tiles).toHaveLength(3)
    expect(tiles[0]).toContain('<span class="sr-only">Run </span>Restart app<')
    expect(tiles[1]).toContain('<span class="sr-only">Run </span>Deploy<')
    expect(tiles[2]).toContain('href="/actions/rotate"')
    const control = (row: string, name: string) => (row.match(/<button\b[^>]*>/g) ?? []).find((b) => b.includes(`aria-label="${name}"`)) ?? ''
    expect(control(tiles[0]!, 'Move Restart app earlier')).toContain('aria-disabled="true"')
    expect(control(tiles[0]!, 'Move Restart app later')).toBeTruthy()
    expect(control(tiles[0]!, 'Move Restart app later')).not.toContain('aria-disabled')
    expect(control(tiles[1]!, 'Move Deploy earlier')).not.toContain('aria-disabled')
    expect(control(tiles[2]!, 'Move Rotate keys later')).toContain('aria-disabled="true"')
    expect(star(tiles[1]!, 'Deploy')).toContain('aria-pressed="true"')
  })

  it('has nothing to move while it is the only one', () => {
    const pinned = part(page({ actions, pins: [pin('deploy')] }), 'Pinned')
    expect(rows(pinned)).toHaveLength(1)
    expect(pinned).not.toContain('earlier')
  })

  it('says how to pin while there are none', () => {
    const pinned = part(page({ actions, pins: [] }), 'Pinned')
    expect(pinned).toContain('Star an action to keep it here.')
    expect(rows(pinned)).toHaveLength(0)
  })

  it('is read and not changed while viewing as someone', () => {
    const html = page({ actions, pins: [pin('restart'), pin('deploy')], viewing: true })
    expect(stars(html)).toHaveLength(0)
    const pinned = part(html, 'Pinned')
    expect(rows(pinned)).toHaveLength(2)
    expect(rows(pinned)[0]).toContain('Restart app')
    expect(pinned).not.toContain('earlier')
    expect(stars(page({ actions, pins: [pin('rotate')], viewing: true, id: 'rotate' }))).toHaveLength(0)
  })

  it('is not offered by a hub that keeps none, and nothing on the page says so', () => {
    const html = page({ actions, pins: null })
    expect(stars(html)).toHaveLength(0)
    expect(part(html, 'Pinned')).toBe('')
    expect(part(html, 'Recent')).toContain('What you run shows here.')
    expect(html).not.toContain('role="alert"')
    expect(stars(page({ actions, pins: null, id: 'rotate' }))).toHaveLength(0)
  })
})
