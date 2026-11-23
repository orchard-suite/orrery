import { describe, expect, it } from 'vitest'
import { cameFrom, folded, listed, MOST_STEPS, upFrom, movedTo, named, placeOf, pushed, replaced, type Step, type Trail } from './trail.ts'

const step = (id: string, href = `/${id}`, start = false): Step => ({ id, href, name: null, start })
const walk = (...ids: string[]): Trail => ids.reduce<Trail>((t, id) => pushed(t, step(id)), { steps: [], at: -1 })

describe('a visit', () => {
  it('goes after the step shown', () => {
    const t = walk('now', 'actions', 'schedules')
    expect(t.steps.map((s) => s.id)).toEqual(['now', 'actions', 'schedules'])
    expect(t.at).toBe(2)
  })

  it('drops the steps ahead after going back, as the browser does', () => {
    const back = movedTo(walk('now', 'actions', 'schedules'), 'now')!
    const t = pushed(back, step('reports'))
    expect(t.steps.map((s) => s.id)).toEqual(['now', 'reports'])
    expect(t.at).toBe(1)
  })

  it('lets go of the oldest steps past the most a tab keeps', () => {
    const t = walk(...Array.from({ length: MOST_STEPS + 5 }, (_, i) => `s${i}`))
    expect(t.steps).toHaveLength(MOST_STEPS)
    expect(t.steps[0]!.id).toBe('s5')
    expect(t.at).toBe(MOST_STEPS - 1)
  })

  it('takes the place of the step shown when it replaces it, so Back skips it', () => {
    const t = replaced(walk('list', 'record-1'), step('record-2'))
    expect(t.steps.map((s) => s.id)).toEqual(['list', 'record-2'])
    expect(t.at).toBe(1)
  })
})

describe('a move along the trail', () => {
  it('stands on the step the browser entry carries, and keeps every step', () => {
    const t = movedTo(walk('now', 'actions', 'schedules'), 'actions')!
    expect(t.at).toBe(1)
    expect(t.steps).toHaveLength(3)
  })

  it('knows nothing of an entry no step carries', () => {
    expect(movedTo(walk('now'), 'elsewhere')).toBeNull()
  })
})

describe('the breadcrumb', () => {
  it('names the places that led here, each with how far back it lies', () => {
    const t = walk('now', 'actions', 'schedules', 'batch')
    expect(cameFrom(t, 4).map((c) => [c.step.id, c.back])).toEqual([
      ['now', 3],
      ['actions', 2],
      ['schedules', 1],
    ])
  })

  it('shows the latest few and folds the rest', () => {
    const t = walk('a', 'b', 'c', 'd', 'e', 'f')
    expect(cameFrom(t, 2).map((c) => c.step.id)).toEqual(['d', 'e'])
    expect(folded(t, 2)).toBe(3)
    expect(folded(t, 10)).toBe(0)
  })

  it('counts two steps on one address, a link down the page among them, as one place', () => {
    const t = ['/now', '/batch', '/batch#main', '/run'].reduce<Trail>((acc, href, i) => pushed(acc, step(`s${i}`, href)), { steps: [], at: -1 })
    expect(cameFrom(t, 4).map((c) => [c.step.href, c.back])).toEqual([
      ['/now', 3],
      ['/batch#main', 1],
    ])
  })

  it('names nothing before the first step', () => {
    expect(cameFrom(walk('now'), 4)).toEqual([])
  })
})

describe('a step', () => {
  it('takes the name its page says it shows', () => {
    const t = named(walk('now', 'batch'), 'batch', 'ping on 3 things')
    expect(t.steps[1]!.name).toBe('ping on 3 things')
    expect(t.steps[0]!.name).toBeNull()
  })

  it('is one place however far down it looked', () => {
    expect(placeOf('/entities/service/web#spec:GET /x')).toBe('/entities/service/web')
    expect(placeOf('/actions?x=1')).toBe('/actions?x=1')
  })
})

describe('the whole trail', () => {
  it('lists every place newest first, a place visited twice in a row once', () => {
    const t = ['/now', '/repo', '/repo', '/actions'].reduce<Trail>((acc, href, i) => pushed(acc, step(`s${i}`, href)), { steps: [], at: -1 })
    expect(listed(t)).toEqual([3, 2, 0])
  })

  it('always lists the step shown, and the steps ahead of it', () => {
    const t = movedTo(walk('a', 'b', 'c'), 'a')!
    expect(listed(t)).toEqual([2, 1, 0])
  })
})

describe('a path', () => {
  const from = (...visits: [string, boolean][]): Trail => visits.reduce<Trail>((t, [id, start]) => pushed(t, step(id, `/${id}`, start)), { steps: [], at: -1 })

  it('starts the breadcrumb at the last step the main menu went to', () => {
    const t = from(['map', true], ['ground', true], ['scorecards', true], ['actions', true], ['schedules', false], ['batch', false])
    expect(cameFrom(t, 4).map((c) => [c.step.id, c.back])).toEqual([
      ['actions', 2],
      ['schedules', 1],
    ])
  })

  it('shows nothing before a page the main menu just went to', () => {
    expect(cameFrom(from(['map', true], ['ground', true], ['actions', true]), 4)).toEqual([])
  })

  it('folds only what is on the path', () => {
    const t = from(['now', true], ['a', true], ['b', false], ['c', false], ['d', false])
    expect(cameFrom(t, 2).map((c) => c.step.id)).toEqual(['b', 'c'])
    expect(folded(t, 2)).toBe(1)
  })

  it('shows the path of a step Back returned to', () => {
    const t = movedTo(from(['actions', true], ['schedules', false], ['reports', true]), 'schedules')!
    expect(cameFrom(t, 4).map((c) => c.step.id)).toEqual(['actions'])
  })

  it('keeps a step that starts a path when one stands in its place', () => {
    expect(replaced(from(['list', true]), step('next')).steps[0]!.start).toBe(false)
  })
})

describe('Back', () => {
  const from = (...visits: [string, boolean][]): Trail => visits.reduce<Trail>((t, [id, start]) => pushed(t, step(id, `/${id}`, start)), { steps: [], at: -1 })

  it('goes up the path to the place before this one', () => {
    const up = upFrom(from(['actions', true], ['schedules', false], ['batch', false]))
    expect([up?.step.id, up?.back]).toEqual(['schedules', 1])
  })

  it('goes nowhere where the path starts, whatever the history holds before it', () => {
    expect(upFrom(from(['random', true], ['now', true]))).toBeNull()
  })

  it('steps over a place the path stood on twice in a row', () => {
    const t = ['/actions', '/batch', '/batch#main'].reduce<Trail>((acc, href, i) => pushed(acc, step(`s${i}`, href, i === 0)), { steps: [], at: -1 })
    expect([upFrom(t)?.step.id, upFrom(t)?.back]).toEqual(['s0', 2])
  })
})
