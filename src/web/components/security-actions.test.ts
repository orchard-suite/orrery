import { describe, expect, it } from 'vitest'
import type { PostureItem, PostureResponse } from '../../shared/posture.ts'
import { NO_FILTER, actionRows, approvalOf, audiencesOf, backendWord, backendsOf, filtering, shownActions, teamsOf, type ActionFilter } from './security-actions.ts'

type Extra = Partial<Omit<PostureItem, 'action'>> & { action?: Partial<NonNullable<PostureItem['action']>> }

const item = (id: string, { action, ...extra }: Extra = {}): PostureItem => ({
  target: { kind: 'action', id },
  title: id,
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
  people: 1,
  ...extra,
  action: { blueprints: [], backend: 'webhook', approval: false, where: null, rules: [], icon: 'rocket', home: null, homePeople: false, everyone: !!extra.open, lastRunAt: null, runs90: 0, ...action },
})

const data = (items: PostureItem[], extra: Partial<PostureResponse> = {}): PostureResponse => ({
  person: null,
  principals: [],
  items,
  findings: [],
  teams: [],
  policy: { policy: { audiences: [{ id: 'ops', title: 'Operations', people: [], grants: [], audiences: [] }, { id: 'dev', title: 'Developers', people: [], grants: [], audiences: ['ops'] }], classes: [], edits: [] }, source: null },
  audiences: [],
  classes: [],
  review: [],
  coverage: { classified: 0, ruled: 0, reviewed: 0, unreviewed: 0 },
  map: [],
  handmade: [],
  ...extra,
})

const helpdesk = { path: 'team', values: ['Helpdesk'] }
const platform = { path: 'team', values: ['platform', 'Helpdesk'] }

const estate = data([
  item('restart', { title: 'Restart', grants: [helpdesk], action: { backend: 'runner', lastRunAt: '2026-01-05T15:00:00Z', runs90: 4, home: { id: 'squad:core', title: 'Core' }, homePeople: true } }),
  item('ping', { title: 'Ping', open: true }),
  item('deploy', { title: 'Deploy', audiences: ['ops'], action: { approval: true, backend: 'github_workflow', lastRunAt: '2025-06-01T15:00:00Z' } }),
  item('rotate', { title: 'Rotate a secret', action: { rules: [{ grants: [platform], approval: true }, { audiences: ['dev'], owns: true }] } }),
  item('locked', { title: 'Admins alone', action: { backend: 'caller' } }),
  { ...item('team'), target: { kind: 'blueprint', id: 'team' }, action: undefined },
])

const ids = (filter: Partial<ActionFilter>, runs: ReadonlySet<string> | null = null) => shownActions(estate, { ...NO_FILTER, ...filter }, runs).map((r) => r.id)

describe('the rows of the Actions tab', () => {
  it('are the actions alone, by title', () => {
    expect(actionRows(estate).map((r) => r.title)).toEqual(['Admins alone', 'Deploy', 'Ping', 'Restart', 'Rotate a secret'])
  })

  it('say who may run each, in the words of the page', () => {
    const who = (id: string) => actionRows(estate).find((r) => r.id === id)!.who
    expect(who('ping')).toEqual(['Everyone signed in'])
    expect(who('deploy')).toEqual(['Operations'])
    expect(who('restart')).toEqual(['team is Helpdesk', "Its home's people"])
    expect(who('rotate')).toEqual(['2 rules'])
    expect(who('locked')).toEqual(['Admins only'])
  })

  it('say when a run waits for approval: always, by a rule, or never', () => {
    const approval = (id: string) => actionRows(estate).find((r) => r.id === id)!.approval
    expect(approval('deploy')).toBe('Always')
    expect(approval('rotate')).toBe('By rule')
    expect(approval('ping')).toBe('None')
    expect(approvalOf(item('x', { action: { approval: true, rules: [{ approval: true }] } }))).toBe('always')
  })

  it('name the backend, the home, and the last run', () => {
    const row = actionRows(estate).find((r) => r.id === 'restart')!
    expect(row).toMatchObject({ backend: 'Runner', home: { id: 'squad:core', title: 'Core' }, lastRunAt: '2026-01-05T15:00:00Z', runs90: 4, icon: 'rocket', people: 1 })
    expect(actionRows(estate).find((r) => r.id === 'ping')).toMatchObject({ home: null, lastRunAt: null, runs90: 0 })
    expect(backendWord('github_workflow')).toBe('GitHub workflow')
    expect(backendWord('record')).toBe('Record an entity')
    expect(backendWord('caller')).toBe('Done by whoever asks')
    expect(backendWord('something_new')).toBe('something_new')
  })

  it('leave unsaid what a hub one release back does not send', () => {
    const old = item('old', { open: true })
    old.action = { blueprints: [], backend: 'webhook', approval: false, where: null, rules: [] }
    const [row] = actionRows(data([old]))
    expect(row).toMatchObject({ icon: 'rocket', home: null, who: ['Everyone signed in'], lastRunAt: undefined, runs90: undefined })
    // Nobody can say it never ran.
    expect(shownActions(data([old]), { ...NO_FILTER, neverRun: true }, null)).toEqual([])
    expect(shownActions(data([old]), { ...NO_FILTER, everyone: true }, null)).toHaveLength(1)
  })
})

describe('the filters of the Actions tab', () => {
  it('show every action when none is set', () => {
    expect(filtering(NO_FILTER)).toBe(false)
    expect(ids({})).toHaveLength(5)
  })

  it('keep what one person may run, once the hub has said', () => {
    expect(filtering({ ...NO_FILTER, person: 'person:user@example.com' })).toBe(true)
    expect(ids({ person: 'person:user@example.com' }, new Set(['ping', 'restart']))).toEqual(['ping', 'restart'])
    expect(ids({ person: 'person:user@example.com' }, null)).toEqual([])
  })

  it('keep what a grant naming a team opens, in a rule too, whatever the case', () => {
    expect(teamsOf(estate)).toEqual([
      { id: 'team||helpdesk', words: 'team is Helpdesk' },
      { id: 'team||platform', words: 'team is platform' },
    ])
    expect(ids({ team: 'team||helpdesk' })).toEqual(['restart', 'rotate'])
    expect(ids({ team: 'team||platform' })).toEqual(['rotate'])
  })

  it('keep what names an audience, in a rule too, or through an audience that holds it', () => {
    expect(audiencesOf(estate)).toEqual([{ id: 'dev', title: 'Developers' }, { id: 'ops', title: 'Operations' }])
    expect(ids({ audience: 'ops' })).toEqual(['deploy'])
    expect(ids({ audience: 'dev' })).toEqual(['rotate'])
    const nested = data(estate.items, { audiences: [{ id: 'dev', title: 'Developers', members: [], strangers: [], targets: [{ kind: 'action', id: 'deploy' }], classes: [], heldBy: ['ops'] }] })
    expect(shownActions(nested, { ...NO_FILTER, audience: 'dev' }, null).map((r) => r.id)).toEqual(['deploy', 'rotate'])
  })

  it('keep one backend', () => {
    expect(backendsOf(estate)).toEqual([
      { id: 'caller', word: 'Done by whoever asks' },
      { id: 'github_workflow', word: 'GitHub workflow' },
      { id: 'runner', word: 'Runner' },
      { id: 'webhook', word: 'Webhook' },
    ])
    expect(ids({ backend: 'webhook' })).toEqual(['ping', 'rotate'])
  })

  it('keep what is open to everyone, what never waits for approval, and what never ran', () => {
    expect(ids({ everyone: true })).toEqual(['ping'])
    expect(ids({ noApproval: true })).toEqual(['locked', 'ping', 'restart'])
    expect(ids({ neverRun: true })).toEqual(['locked', 'ping', 'rotate'])
  })

  it('hold together', () => {
    expect(ids({ noApproval: true, neverRun: true, backend: 'webhook' })).toEqual(['ping'])
    expect(ids({ team: 'team||helpdesk', audience: 'dev', person: 'token:deployer' }, new Set(['rotate', 'ping']))).toEqual(['rotate'])
    expect(ids({ everyone: true, backend: 'runner' })).toEqual([])
  })
})
