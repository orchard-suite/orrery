import { describe, expect, it } from 'vitest'
import type { WalkStep } from '../shared/api.ts'
import { climbsOf, type MapCheck, type MapLadder } from '../shared/map.ts'
import { bloomsWith, climbText, liftsOf, progressOf, stepOf, stopOn } from './walk.ts'

const secure: MapLadder = { id: 'secure', title: 'Secure', rungs: ['Bronze', 'Silver', 'Gold'] }
const tested: MapLadder = { id: 'guard:tests', title: 'Has tests', rungs: ['Has tests'] }
const on = (states: MapCheck['state'][]): MapCheck[] => states.map((state, rung) => ({ kind: 'scorecard', id: `s${rung}`, title: 'r', of: null, state, ladder: 'secure', rung }))
const thing = (key: string, states: MapCheck['state'][]) => ({ blueprint: 'db', key, checks: on(states) })
const a = thing('a', ['pass', 'fail', 'fail'])
const b = thing('b', ['pass', 'fail', 'fail'])
const c = thing('c', ['pass', 'pass', 'pass'])
const climb = climbsOf([a, b, c], [secure])[0]!
const step = (over: Partial<WalkStep> = {}): WalkStep => ({ id: '1', ...stepOf(climb, 'Prod', null), addedAt: '2026-11-15T00:00:00Z', ...over })

describe('a walk', () => {
  it('names a climb as a stop by its things, and finds it again on the same place and scope alone', () => {
    expect(stepOf(climb, 'Prod', 'kind:db')).toEqual({ place: 'Prod', ladder: 'secure', from: 1, scope: 'kind:db', things: ['db:a', 'db:b'] })
    expect(stopOn([step()], climb, 'Prod', null)?.id).toBe('1')
    expect(stopOn([step()], climb, 'Test', null)).toBeNull()
    expect(stopOn([step()], climb, 'Prod', 'kind:db')).toBeNull()
  })

  it('grows what a stop on this place names, on its ladder alone, and a climb asked about as if it were on the walk', () => {
    const lifts = liftsOf([step({ things: ['db:a'] })], 'Prod')
    expect(lifts(a, 'secure')).toBe(true)
    expect(lifts(b, 'secure')).toBe(false)
    expect(lifts(a, 'guard:tests')).toBe(false)
    expect(liftsOf([step()], 'Test')(a, 'secure')).toBe(false)
    expect(liftsOf([], 'Prod', climb)(b, 'secure')).toBe(true)
  })

  it('counts a stop walked once every thing it named that is still seen stands at the top', () => {
    const now = new Map([
      ['db:a', thing('a', ['pass', 'pass', 'pass'])],
      ['db:b', b],
    ])
    expect(progressOf(step(), now, secure)).toEqual({ done: 1, of: 2, walked: false })
    expect(progressOf(step(), new Map([['db:a', thing('a', ['pass', 'pass', 'pass'])]]), secure)).toEqual({ done: 1, of: 1, walked: true })
    expect(progressOf(step(), new Map(), secure)).toEqual({ done: 0, of: 0, walked: false })
  })

  it('says a climb from where it stands to the top, and a ladder of one rung by its name', () => {
    expect(climbText({ from: 1 }, secure)).toBe('Secure: Bronze to Gold')
    expect(climbText({ from: 0 }, secure)).toBe('Secure: below Bronze to Gold')
    expect(climbText({ from: 0 }, tested)).toBe('Has tests')
  })

  it('names the groups a plan brings into full bloom, and none it was in already', () => {
    const groups = [{ id: 'short', things: [a, b] }, { id: 'full', things: [c] }, { id: 'none', things: [{ blueprint: 'db', key: 'n', checks: [] }] }]
    expect(bloomsWith(groups, [secure], () => false, () => true).map((g) => g.id)).toEqual(['short'])
    expect(bloomsWith(groups, [secure], () => false, liftsOf<(typeof groups)[number]['things'][number]>([step({ things: ['db:a'] })], 'Prod')).map((g) => g.id)).toEqual([])
  })
})
