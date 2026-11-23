import { describe, expect, it } from 'vitest'
import type { ActionSchedule, ScheduleFiring } from '../shared/api.ts'
import { dayState, daySpan, howItWent, standingWords, whenOf, fromLocalInput, laterChoices, localInput, lanesOf, standing, measuredByHour, minutesADay, outcomeOf, plannedDay, runnerTime, successRate, tally, upcoming } from './schedules.ts'

const HOUR = 3_600_000
const sched = (id: string, over: Partial<ActionSchedule> = {}): ActionSchedule =>
  ({ id, action: 'ping', title: id, owner: 'a@example.org', target: {}, targetTitle: null, inputs: {}, cadence: { every: 'hour', minute: 5, tz: 'UTC' }, when: '', deliver: [], tell: 'failed', state: 'active', load: null, decidedBy: null, decidedAt: null, note: null, nextAt: null, lastAt: null, lastRun: null, lastBatch: null, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', mine: true, canDecide: false, ...over }) as ActionSchedule
const firing = (schedule: string, at: string, over: Partial<ScheduleFiring> = {}): ScheduleFiring => ({ schedule, at, run: 'r', batch: null, runs: 1, succeeded: 1, failed: 0, open: 0, stopped: 0, seconds: 60, startedAt: at, endedAt: at, error: null, ...over })

describe('how a firing went', () => {
  it('says it asked nothing, is still open, failed mostly or partly, stopped, or succeeded, in that order', () => {
    expect(outcomeOf(firing('a', '', { error: 'gone', runs: 0, succeeded: 0 }))).toBe('error')
    expect(outcomeOf(firing('a', '', { runs: 4, open: 1, failed: 3, succeeded: 0 }))).toBe('open')
    expect(outcomeOf(firing('a', '', { runs: 4, failed: 2, succeeded: 2 }))).toBe('most')
    expect(outcomeOf(firing('a', '', { runs: 4, failed: 1, succeeded: 3 }))).toBe('some')
    expect(outcomeOf(firing('a', '', { runs: 1, succeeded: 0, stopped: 1 }))).toBe('stopped')
    expect(outcomeOf(firing('a', ''))).toBe('ok')
  })
})

describe('the lanes', () => {
  it('go waiting, running, paused, declined, leave out an empty one, and put the next to fire first', () => {
    const lanes = lanesOf([sched('late', { nextAt: '2026-11-15T10:00:00Z' }), sched('paused', { state: 'paused' }), sched('soon', { nextAt: '2026-11-15T08:00:00Z' }), sched('asks', { state: 'awaiting' })])
    expect(lanes.map((l) => [l.state, l.schedules.map((s) => s.id)])).toEqual([
      ['awaiting', ['asks']],
      ['active', ['soon', 'late']],
      ['paused', ['paused']],
    ])
  })
})

describe('why a schedule stands where it does', () => {
  it('names who paused or declined it, and says when the hub stopped it', () => {
    expect(standing({ state: 'paused', note: 'paused by a@example.org', decidedBy: 'b@example.org' })).toBe('Paused by a@example.org.')
    expect(standing({ state: 'paused', note: 'a@example.org may no longer run the action', decidedBy: 'b@example.org' })).toBe('The hub paused it: a@example.org may no longer run the action.')
    expect(standing({ state: 'declined', note: 'Fix the leak.', decidedBy: 'b@example.org' })).toBe('Declined by b@example.org: Fix the leak.')
    expect(standing({ state: 'active', note: 'the last firing failed: boom', decidedBy: 'b@example.org' })).toBe('The last firing failed: boom.')
    expect(standing({ state: 'active', note: null, decidedBy: null })).toBeNull()
  })
})

describe('the tally', () => {
  it('counts states, runs, outcomes, and runner time, apart for single runs and batches, and only the schedules shown', () => {
    const s = [sched('one'), sched('many', { target: { query: 'q' }, state: 'paused' })]
    const t = tally(s, [firing('one', 'a'), firing('one', 'b', { error: 'x', runs: 0, succeeded: 0, seconds: 0 }), firing('many', 'c', { runs: 10, succeeded: 7, failed: 2, open: 1, seconds: 600 }), firing('gone', 'd')])
    expect(t).toMatchObject({ schedules: 2, states: { active: 1, paused: 1, awaiting: 0, declined: 0 }, firings: 3, errors: 1, runs: 11, succeeded: 8, failed: 2, open: 1, seconds: 660 })
    expect(t.single).toEqual({ schedules: 1, firings: 2, runs: 1, seconds: 60 })
    expect(t.batch).toEqual({ schedules: 1, firings: 1, runs: 10, seconds: 600 })
    expect(successRate(t)).toBe(0.8)
    expect(successRate({ succeeded: 0, failed: 0 })).toBeNull()
  })
})

describe('what is still to come', () => {
  it('lists the firings of an approved or waiting schedule in the window, and none of a paused one', () => {
    const from = Date.parse('2026-11-15T10:30:00Z')
    expect(upcoming(sched('a'), from, from + 3 * HOUR).map((t) => new Date(t).toISOString())).toEqual(['2026-11-15T11:05:00.000Z', '2026-11-15T12:05:00.000Z', '2026-11-15T13:05:00.000Z'])
    expect(upcoming(sched('w', { state: 'awaiting' }), from, from + HOUR)).toHaveLength(1)
    expect(upcoming(sched('p', { state: 'paused' }), from, from + 3 * HOUR)).toEqual([])
  })
})

describe('runner minutes', () => {
  const load = (runner: string | null, hours: number[], runnerSeconds: number | null = 60) => ({ runs: 1, runnerSeconds, estimate: null, perDay: 1, hours, runner })
  it('measures what each firing took by the hour it fired in, by runner, the busiest first', () => {
    const s = [sched('a', { load: load('small', []) }), sched('b', { load: load('big', []) })]
    const from = Date.parse('2026-11-15T00:00:00Z')
    const rows = measuredByHour(s, [firing('a', '2026-11-15T01:10:00Z', { seconds: 120 }), firing('b', '2026-11-15T01:50:00Z', { seconds: 600 }), firing('b', '2026-11-16T05:00:00Z', { seconds: 60 })], from, 3)
    expect(rows).toEqual([
      { runner: 'big', minutes: [0, 10, 0] },
      { runner: 'small', minutes: [0, 2, 0] },
    ])
  })
  it('plans an average day in the reader’s hours, and leaves out a load not known yet', () => {
    const hours = Array<number>(24).fill(0)
    hours[8] = 600
    const rows = plannedDay([sched('a', { load: load('lg', hours) }), sched('b', { load: load('lg', hours, null) })], -6)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.minutes[2]).toBe(10)
    expect(minutesADay({ load: { ...load('lg', hours, 120), perDay: 24 } })).toBe(48)
    expect(minutesADay({ load: null })).toBeNull()
  })
  it('says runner time in seconds, minutes, or hours', () => {
    expect([runnerTime(40), runnerTime(720), runnerTime(12_240), runnerTime(200_000)]).toEqual(['40 s', '12 min', '3.4 h', '56 h'])
  })
})

describe('putting a run off', () => {
  it('offers an hour from now, tonight while it is still ahead, tomorrow morning, and Monday when that is not tomorrow', () => {
    // A Saturday at 13:10 in the reader's own time.
    const sat = new Date(2026, 10, 14, 13, 10)
    expect(laterChoices(sat).map((c) => [c.label, localInput(c.at)])).toEqual([
      ['In an hour', '2026-11-14T14:10'],
      ['Tonight at 10 PM', '2026-11-14T22:00'],
      ['Tomorrow at 6 AM', '2026-11-15T06:00'],
      ['Monday at 6 AM', '2026-11-16T06:00'],
    ])
    // Late on a Sunday: tonight is gone, and Monday is tomorrow.
    expect(laterChoices(new Date(2026, 10, 15, 21, 30)).map((c) => c.label)).toEqual(['In an hour', 'Tomorrow at 6 AM'])
  })

  it('reads a moment back from the input that shows it', () => {
    const at = new Date(2026, 10, 16, 6, 0)
    expect(fromLocalInput(localInput(at))?.getTime()).toBe(at.getTime())
    expect(fromLocalInput('')).toBeNull()
  })
})

describe('the words over the lanes', () => {
  it('counts the states in the lanes’ order, leaving out what none stand in', () => {
    expect(standingWords({ active: 3, paused: 0, awaiting: 1, declined: 0, done: 2 })).toEqual(['3 active', '1 waiting for approval', '2 fired once'])
    expect(standingWords({ active: 0, paused: 0, awaiting: 1, declined: 0, done: 0 }, true)).toEqual(['1 waiting'])
  })

  it('says a failure first, then that nothing fired, that what fired still runs, or that it all succeeded', () => {
    expect(howItWent([firing('a', 'x', { failed: 1, succeeded: 0 })], 'this week')).toEqual({ text: '1 schedule had runs fail this week.', warn: true })
    expect(howItWent([], 'today').text).toBe('Nothing fired today.')
    expect(howItWent([firing('a', 'x', { open: 3, succeeded: 0, runs: 3 })], 'today').text).toBe('1 firing today still running.')
    expect(howItWent([firing('a', 'x'), firing('a', 'y', { open: 1, succeeded: 0 })], 'today').text).toBe('Every firing that finished today succeeded; 1 still running.')
    expect(howItWent([firing('a', 'x')], 'today').text).toBe('Every firing today succeeded.')
  })

  it('says when one that fired once fired, and the cadence of any other', () => {
    const once = sched('o', { state: 'done', cadence: { every: 'once', on: '2026-11-16T12:00:00Z', tz: 'UTC' }, when: 'once, on …', lastAt: '2026-11-15T20:05:00Z' })
    expect(whenOf(once)).toMatch(/^fired once, /)
    expect(whenOf({ ...once, state: 'active' })).toBe('once, on …')
  })
})

describe('a schedule\'s day in the runs list', () => {
  it('is going while a run is open, failed when a run failed or a firing asked nothing, else how it ended', () => {
    expect(dayState({ counts: { succeeded: 5, running: 1, failed: 1 }, missed: 0 })).toBe('running')
    expect(dayState({ counts: { succeeded: 5, queued: 3 }, missed: 0 })).toBe('queued')
    expect(dayState({ counts: { succeeded: 5, failed: 1 }, missed: 0 })).toBe('failed')
    expect(dayState({ counts: { succeeded: 5 }, missed: 1 })).toBe('failed')
    expect(dayState({ counts: {}, missed: 2 })).toBe('failed')
    expect(dayState({ counts: { succeeded: 5, cancelled: 1 }, missed: 0 })).toBe('succeeded')
    expect(dayState({ counts: { declined: 1 }, missed: 0 })).toBe('cancelled')
  })

  it('spans the reader\'s own day, midnight to midnight, across a month\'s end', () => {
    const { from, to } = daySpan('2026-10-31')
    expect([from.getFullYear(), from.getMonth(), from.getDate(), from.getHours()]).toEqual([2026, 9, 31, 0])
    expect([to.getFullYear(), to.getMonth(), to.getDate(), to.getHours()]).toEqual([2026, 10, 1, 0])
  })
})
