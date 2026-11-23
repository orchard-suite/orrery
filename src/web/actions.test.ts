import { describe, expect, it } from 'vitest'
import type { Action, Home, ActionInputDef, ActionRun, Blueprint, Entity, Pin } from '../shared/model.ts'
import type { ServerEvent } from '../shared/api.ts'
import { actionsMoved, optionLine, ranInputs, walkSteps, failing, happened, homeOf, iconOf, movedPin, movedSection, reordered, outputsOf, pinnedOf, recent, sectionOf, sectionsOf, targetOf, usual, waitingWords, waits, type Shown } from './actions.ts'

const action = (extra: Partial<Shown> = {}): Shown => ({ id: 'restart', title: 'Restart', inputs: {}, backend: { type: 'webhook', url: 'https://hooks.example.com/restart' }, origin: { kind: 'ui' }, updatedAt: '2026-01-05T15:00:00Z', ...extra })

let n = 0
const run = (extra: Partial<ActionRun> = {}): ActionRun => ({ id: `r${++n}`, action: 'restart', entity: null, inputs: {}, by: 'user@example.com', state: 'succeeded', label: null, link: null, summary: null, log: [], steps: [], outputs: {}, claimedBy: null, decidedBy: null, decidedAt: null, tiers: [], revises: null, note: null, attempt: 1, retryAt: null, images: [], createdAt: '2026-01-05T15:00:00Z', startedAt: null, finishedAt: null, ...extra })

describe("an action's icon", () => {
  it('is the one the hub says to draw', () => {
    expect(iconOf(action({ icon: 'server', iconShown: 'argocd' }))).toBe('argocd')
  })

  it('is its own, then the rocket, from a hub that says none', () => {
    expect(iconOf(action({ icon: 'server' }))).toBe('server')
    expect(iconOf(action())).toBe('rocket')
  })
})

describe('what its runs say of an action', () => {
  it('says how long it usually takes once the hub knows', () => {
    expect(usual(action({ stats: { usualSeconds: 95, meanSeconds: null, failedInARow: 0 } }))).toBe('Usually takes 1m 35s')
    expect(usual(action({ stats: { usualSeconds: 0, meanSeconds: null, failedInARow: 0 } }))).toBe('Usually takes under a second')
    expect(usual(action({ stats: { usualSeconds: null, meanSeconds: null, failedInARow: 0 } }))).toBeNull()
  })

  it('says it is failing from three failures in a row', () => {
    expect(failing(action({ stats: { usualSeconds: null, meanSeconds: null, failedInARow: 2 } }))).toBeNull()
    expect(failing(action({ stats: { usualSeconds: null, meanSeconds: null, failedInARow: 4 } }))).toBe('Failed the last 4 runs')
  })

  it('says nothing from a hub that sends no stats', () => {
    expect(usual(action())).toBeNull()
    expect(failing(action())).toBeNull()
  })
})

describe("a run's target", () => {
  const entity = { blueprint: 'service', key: 'svc-17' }

  it('is named by its title', () => {
    expect(targetOf(run({ entity, entityTitle: 'Billing' }))).toBe('Billing')
  })

  it('is named by its key when it is gone, has no title, or the hub sends none', () => {
    expect(targetOf(run({ entity, entityTitle: null }))).toBe('svc-17')
    expect(targetOf(run({ entity, entityTitle: '' }))).toBe('svc-17')
    expect(targetOf(run({ entity }))).toBe('svc-17')
  })

  it('is nothing for a run on nothing', () => {
    expect(targetOf(run())).toBeNull()
  })
})

describe('what waits for the reader', () => {
  it('counts runs, change sets, schedules, or any of them together', () => {
    expect(waitingWords({ runs: 1, sets: 0, schedules: 0 })).toBe('1 run waits for you')
    expect(waitingWords({ runs: 3, sets: 0, schedules: 0 })).toBe('3 runs wait for you')
    expect(waitingWords({ runs: 0, sets: 0, schedules: 1 })).toBe('1 schedule waits for you')
    expect(waitingWords({ runs: 2, sets: 0, schedules: 1 })).toBe('2 runs and 1 schedule wait for you')
    expect(waitingWords({ runs: 0, sets: 1, schedules: 0 })).toBe('1 change set waits for you')
    expect(waitingWords({ runs: 2, sets: 1, schedules: 1 }, 'for your approval')).toBe('2 runs, 1 change set and 1 schedule wait for your approval')
  })
})

describe('the recent runs', () => {
  const on = (key: string) => ({ blueprint: 'service', key })

  it('keeps the newest of each action and target', () => {
    const runs = [run({ id: 'a', entity: on('one') }), run({ id: 'b', entity: on('one') }), run({ id: 'c', entity: on('two') }), run({ id: 'd', action: 'deploy', entity: on('one') }), run({ id: 'e' }), run({ id: 'f' })]
    expect(recent(runs).map((r) => r.id)).toEqual(['a', 'c', 'd', 'e'])
  })

  it('keeps five at most', () => {
    const runs = Array.from({ length: 9 }, (_, i) => run({ entity: on(`k${i}`) }))
    expect(recent(runs)).toHaveLength(5)
  })
})

describe('what a run waits on', () => {
  const caller: Action = action({ backend: { type: 'caller' } })
  const runner: Action = action({ backend: { type: 'runner', runner: 'runner-east', command: ['true'] } })

  it('is approval while it awaits one', () => {
    expect(waits(run({ state: 'awaiting' }), action(), 'user@example.com')).toBe('Waits for approval')
  })

  it('is the person who asked, for a run they start themselves', () => {
    expect(waits(run({ state: 'queued' }), caller, 'user@example.com')).toBe('Waits for you to start it')
    expect(waits(run({ state: 'queued' }), caller, 'approver@example.com')).toBe('Waits for whoever asked to start it')
  })

  it('is the runner it is queued for', () => {
    expect(waits(run({ state: 'queued' }), runner, 'user@example.com')).toBe('Queued for runner-east')
    expect(waits(run({ state: 'queued' }), undefined, 'user@example.com')).toBe('Queued')
  })

  it('is nothing once it runs or has ended', () => {
    expect(waits(run({ state: 'running' }), runner, 'user@example.com')).toBeNull()
    expect(waits(run({ state: 'succeeded' }), runner, 'user@example.com')).toBeNull()
    expect(waits(run({ state: 'failed' }), runner, 'user@example.com')).toBeNull()
  })
})

describe('what happened to a run', () => {
  const at = (m: number, s = 0) => `2026-01-05T15:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.000Z`
  const said = (r: ActionRun, a: Parameters<typeof happened>[1], now = Date.parse(at(30))) => happened(r, a, now).map((h) => [h.label, h.status, h.detail ?? '', h.under ?? false])

  it('says how long it waited for approval and in the queue, how long it ran, and each step it named', () => {
    const r = run({ state: 'failed', decidedAt: at(3), decidedBy: 'approver@example.com', startedAt: at(3, 12), finishedAt: at(4, 30), claimedBy: 'east', steps: [{ name: 'Stop', at: at(3, 13) }, { name: 'Verify', at: at(4) }] })
    expect(said(r, action({ approval: true }))).toEqual([
      ['Asked', 'done', 'by user@example.com', false],
      ['Waited 3m 0s for approval', 'done', 'Approved by approver@example.com', false],
      ['Queued 12s', 'done', 'Picked up by runner east', false],
      ['Ran for 1m 18s', 'done', '', false],
      ['Stop', 'done', '47s', true],
      ['Verify', 'failed', '30s', true],
      ['Failed', 'failed', '', false],
    ])
  })

  it('says what a run is waiting on, and for how long so far', () => {
    expect(said(run({ state: 'awaiting' }), action({ approval: true }), Date.parse(at(2)))).toEqual([
      ['Asked', 'done', 'by user@example.com', false],
      ['Waiting for approval', 'now', '2m 0s so far', false],
      ['Started', 'waiting', '', false],
      ['Finished', 'waiting', '', false],
    ])
    expect(said(run({ state: 'queued' }), action(), Date.parse(at(0, 12))).slice(1)).toEqual([
      ['Queued', 'now', 'Waiting to be picked up, 12s so far', false],
      ['Finished', 'waiting', '', false],
    ])
  })

  it('marks the step under way while it runs', () => {
    const r = run({ state: 'running', startedAt: at(0), steps: [{ name: 'Stop', at: at(0, 1) }, { name: 'Start', at: at(0, 5) }] })
    expect(said(r, action(), Date.parse(at(1))).slice(1)).toEqual([
      ['Started', 'done', '', false],
      ['Running', 'now', 'for 1m 0s', false],
      ['Stop', 'done', '4s', true],
      ['Start', 'now', '55s so far', true],
      ['Finished', 'waiting', '', false],
    ])
  })

  it('ends at whoever declined it or withdrew it, with nothing started', () => {
    const declined = run({ state: 'declined', decidedAt: at(5), decidedBy: 'approver@example.com', finishedAt: at(5) })
    expect(said(declined, action({ approval: true })).slice(1)).toEqual([
      ['Declined', 'failed', 'by approver@example.com, after 5m 0s', false],
      ['Started', 'skipped', 'Never started', false],
    ])
    const withdrawn = run({ state: 'cancelled', finishedAt: at(1), log: [{ at: at(1), message: 'withdrawn by user@example.com' }] })
    expect(said(withdrawn, action({ approval: true })).slice(1)).toEqual([
      ['Cancelled', 'failed', 'withdrawn by user@example.com', false],
      ['Started', 'skipped', 'Never started', false],
    ])
  })

  it('reads a run from a hub that names no steps and holds no outputs', () => {
    const { steps: _steps, outputs: _outputs, ...old } = run({ state: 'succeeded', startedAt: at(0), finishedAt: at(0, 9) })
    expect(said(old as ActionRun, action()).slice(1)).toEqual([
      ['Started', 'done', '', false],
      ['Ran for 9s', 'done', '', false],
      ['Succeeded', 'done', '', false],
    ])
    expect(outputsOf(old as ActionRun)).toEqual([])
    expect(outputsOf(run({ outputs: { url: 'https://example.org/a', replicas: 3, ready: true } }))).toEqual([['url', 'https://example.org/a'], ['replicas', '3'], ['ready', 'true']])
  })
})

describe("a person's pins", () => {
  const pin = (id: string): Pin => ({ kind: 'action', id })
  const pins = [pin('restart'), pin('deploy'), pin('rotate')]

  it('are the offered actions in the order of the pins, a pin to anything else passed over', () => {
    const offered = [{ id: 'deploy' }, { id: 'unpinned' }, { id: 'restart' }]
    expect(pinnedOf(pins, offered).map((a) => a.id)).toEqual(['restart', 'deploy'])
    expect(pinnedOf([], offered)).toEqual([])
  })

  it('move one place earlier or later', () => {
    expect(movedPin(pins, pin('deploy'), -1)).toEqual([pin('deploy'), pin('restart'), pin('rotate')])
    expect(movedPin(pins, pin('deploy'), 1)).toEqual([pin('restart'), pin('rotate'), pin('deploy')])
    expect(pins.map((p) => p.id)).toEqual(['restart', 'deploy', 'rotate'])
  })

  it('do not move past an end, or move what is not pinned', () => {
    expect(movedPin(pins, pin('restart'), -1)).toBeNull()
    expect(movedPin(pins, pin('rotate'), 1)).toBeNull()
    expect(movedPin(pins, pin('gone'), 1)).toBeNull()
  })

  it('of one kind put in order keep the other kinds after them, as the hub does', () => {
    const kept: Pin[] = [pin('restart'), { kind: 'blueprint', id: 'service' }, pin('deploy'), { kind: 'blueprint', id: 'storage' }]
    expect(reordered(kept, [{ kind: 'blueprint', id: 'storage' }, { kind: 'blueprint', id: 'service' }, { kind: 'blueprint', id: 'gone' }])).toEqual([{ kind: 'blueprint', id: 'storage' }, { kind: 'blueprint', id: 'service' }, pin('restart'), pin('deploy')])
  })
})

describe('the sections of the start page', () => {
  const home = (key: string, title: string, yours = false): Home => ({ id: `squad:${key}`, entity: { blueprint: 'squad', key }, title, icon: 'team', yours })
  const core = home('core', 'Core', true)
  const edge = home('edge', 'Edge')
  const apps = home('apps', 'Apps', true)
  const all = [action({ id: 'a', group: 'Deploys' }), action({ id: 'b', homeShown: edge }), action({ id: 'c' }), action({ id: 'd', homeShown: core, group: 'Deploys' }), action({ id: 'e', group: 'Apps' }), action({ id: 'f', homeShown: apps })]
  const keys = (order: string[]) => sectionsOf(all, order).map((s) => s.key)

  it('are a home before a group, and a group only for an action with no home to show', () => {
    expect(sectionOf(action({ homeShown: core, group: 'Deploys' }))).toBe('squad:core')
    expect(sectionOf(action({ home: 'squad:gone', homeShown: null, group: 'Deploys' }))).toBe('Deploys')
    expect(sectionOf(action())).toBe('')
    expect(homeOf(action({ homeShown: core }))).toBe(core)
    // A hub one release back says nothing of a home.
    expect(homeOf(action({ home: 'squad:core' }))).toBeNull()
  })

  it("put the reader's own homes first, then the other homes, then the groups, then the rest", () => {
    expect(keys([])).toEqual(['squad:apps', 'squad:core', 'squad:edge', 'Apps', 'Deploys', ''])
    expect(sectionsOf(all, [])[1]).toEqual({ key: 'squad:core', home: core })
    expect(sectionsOf(all, [])[3]).toEqual({ key: 'Apps', home: null })
  })

  it("follow the shared order, the reader's own homes still first and the rest still last", () => {
    expect(keys(['Deploys', 'squad:core', 'squad:edge', 'squad:apps'])).toEqual(['squad:core', 'squad:apps', 'Deploys', 'squad:edge', 'Apps', ''])
  })

  it("move one place among the reader's own or among the others, and save the order everyone shares", () => {
    const order = ['Deploys', 'squad:core', 'squad:edge', 'squad:apps']
    const sections = sectionsOf(all, order)
    // The shared order never holds the lift that puts one reader's own homes first.
    expect(movedSection(sections, order, 'squad:apps', -1)).toEqual(['Deploys', 'squad:apps', 'squad:core', 'squad:edge', 'Apps'])
    expect(movedSection(sections, order, 'Deploys', 1)).toEqual(['squad:core', 'squad:edge', 'Deploys', 'squad:apps', 'Apps'])
    expect(movedSection(sections, order, 'Apps', -1)).toEqual(['Deploys', 'squad:core', 'Apps', 'squad:edge', 'squad:apps'])
  })

  it('do not move past an end of their own kind, and the last section never moves', () => {
    const sections = sectionsOf(all, [])
    expect(movedSection(sections, [], 'squad:apps', -1)).toBeNull()
    expect(movedSection(sections, [], 'squad:core', 1)).toBeNull()
    expect(movedSection(sections, [], 'squad:edge', -1)).toBeNull()
    expect(movedSection(sections, [], 'Deploys', 1)).toBeNull()
    expect(movedSection(sections, [], '', -1)).toBeNull()
    expect(movedSection(sections, [], 'nothing', 1)).toBeNull()
  })
})

describe('when the actions are read again', () => {
  const home: Home = { id: 'squad:core', entity: { blueprint: 'squad', key: 'core' }, title: 'Core', icon: 'team', yours: false }
  const held = { actions: [action({ homeShown: home }), action({ id: 'plain' })], reads: ['member', 'crew'] }
  const old = { actions: held.actions }
  const moved = (event: ServerEvent, of: NonNullable<Parameters<typeof actionsMoved>[1]> = held) => actionsMoved(event, of)

  it('never is while the page holds none', () => {
    expect(actionsMoved({ type: 'estate' }, undefined)).toBe(false)
    expect(actionsMoved({ type: 'entity', blueprint: 'squad', key: 'core' }, undefined)).toBe(false)
  })

  it('is when a home itself changes, and not for its neighbour', () => {
    expect(moved({ type: 'entity', blueprint: 'squad', key: 'core' })).toBe(true)
    expect(moved({ type: 'entity', blueprint: 'squad', key: 'edge' })).toBe(false)
    expect(moved({ type: 'entity', blueprint: 'squad', key: 'core' }, old)).toBe(true)
  })

  it('is when the title of a home\'s blueprint lands, and not for its other rows', () => {
    expect(moved({ type: 'derived', blueprints: ['squad'], titled: ['squad'] })).toBe(true)
    expect(moved({ type: 'derived', blueprints: ['squad'], titled: [] })).toBe(false)
    expect(moved({ type: 'derived', blueprints: ['app'], titled: ['app'] })).toBe(false)
  })

  it('is when the estate moves a home\'s blueprint, or does not say what it moved', () => {
    expect(moved({ type: 'estate', blueprints: ['squad'] })).toBe(true)
    expect(moved({ type: 'estate', blueprints: ['app'] })).toBe(false)
    expect(moved({ type: 'estate' })).toBe(true)
    expect(moved({ type: 'estate' }, { actions: [action()], reads: [] })).toBe(false)
  })

  it('is when a blueprint that what the reader owns is read from moves', () => {
    expect(moved({ type: 'entity', blueprint: 'member', key: 'user@example.com' })).toBe(true)
    expect(moved({ type: 'derived', blueprints: ['crew'], titled: [] })).toBe(true)
    expect(moved({ type: 'estate', blueprints: ['app', 'crew'] })).toBe(true)
    expect(moved({ type: 'estate' }, { actions: [action()], reads: ['member'] })).toBe(true)
  })

  it('follows homes alone against a hub that names no ownership', () => {
    expect(moved({ type: 'entity', blueprint: 'member', key: 'user@example.com' }, old)).toBe(false)
    expect(moved({ type: 'derived', blueprints: ['crew'], titled: [] }, old)).toBe(false)
  })

  it('is for nothing else', () => {
    for (const type of ['blueprints', 'icons', 'sources', 'access', 'actions'] as const) expect(moved({ type })).toBe(false)
    expect(moved({ type: 'action_run', id: 'r1' })).toBe(false)
  })
})

describe('the steps of a walked form', () => {
  const inputs: Record<string, ActionInputDef> = Object.fromEntries(['name', 'env', 'reason', 'note', 'extra'].map((n) => [n, { type: 'string' }]))
  const sections = [{ title: 'What', description: 'Name it', inputs: ['name', 'env'] }, { title: 'Why', inputs: ['reason'] }, { title: 'Notes', inputs: ['note'] }]

  it('is one step a section that holds an asked input, then one for what no section names', () => {
    expect(walkSteps({ inputs, sections }, ['name', 'env', 'reason', 'note', 'extra'], null)).toEqual([
      { key: 'section:0', title: 'What', description: 'Name it', inputs: ['name', 'env'], target: false },
      { key: 'section:1', title: 'Why', inputs: ['reason'], target: false },
      { key: 'section:2', title: 'Notes', inputs: ['note'], target: false },
      { key: 'rest', title: 'Everything else', inputs: ['extra'], target: false },
    ])
  })

  it('skips a section that holds no asked input, and keeps the key of every other', () => {
    expect(walkSteps({ inputs, sections }, ['name', 'env', 'note'], null).map((s) => s.key)).toEqual(['section:0', 'section:2'])
    expect(walkSteps({ inputs, sections }, [], null)).toEqual([])
  })

  it('starts with what the action runs on when the form asks for it', () => {
    const steps = walkSteps({ inputs, sections }, ['reason'], 'What it runs on')
    expect(steps.map((s) => [s.key, s.title, s.target])).toEqual([['target', 'What it runs on', true], ['section:1', 'Why', false]])
  })
})

describe('the fields shown under an option', () => {
  const blueprint = { fields: { floor: { type: 'string', title: 'Floor' }, seats: { type: 'number' }, tags: { type: 'string' } } } as unknown as Blueprint
  const entity = { fields: { floor: 'Second', seats: 4, tags: ['a', 'b'], empty: '' } } as unknown as Entity

  it('is each field the entity holds, named as the blueprint names it, in the order asked', () => {
    expect(optionLine(entity, ['seats', 'floor', 'tags'], blueprint)).toBe('seats: 4 · Floor: Second · tags: a, b')
  })

  it('leaves out a field the reader was not given, and is nothing when none is left', () => {
    expect(optionLine(entity, ['code', 'floor', 'empty'], blueprint)).toBe('Floor: Second')
    expect(optionLine(entity, ['code'], blueprint)).toBeUndefined()
    expect(optionLine(entity, undefined, blueprint)).toBeUndefined()
  })
})

describe("the inputs a run's page lists", () => {
  const inputs: Record<string, ActionInputDef> = {
    env: { type: 'enum', values: ['dev', 'prod'] },
    reason: { type: 'string', when: { field: 'env', op: 'eq', value: 'prod' } },
    slug: { type: 'string', value: "'run-' + env" },
  }

  it('leaves out an input the form did not ask, and keeps a worked-out value as it was stored', () => {
    expect(ranInputs(inputs, { slug: 'run-dev', reason: null, env: 'dev' })).toEqual([['env', 'dev'], ['slug', 'run-dev']])
    expect(ranInputs(inputs, { env: 'prod', reason: null, slug: 'as-it-was' })).toEqual([['env', 'prod'], ['reason', null], ['slug', 'as-it-was']])
  })

  it('lists what the action no longer defines last, and everything when the action is gone', () => {
    expect(ranInputs(inputs, { old: 'x', env: 'dev', reason: null, slug: 's' })).toEqual([['env', 'dev'], ['slug', 's'], ['old', 'x']])
    expect(ranInputs(undefined, { b: 1, a: 2 })).toEqual([['b', 1], ['a', 2]])
  })
})
