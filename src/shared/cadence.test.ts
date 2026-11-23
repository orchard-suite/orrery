import { describe, expect, it } from 'vitest'
import { cadenceProblem, cadenceWords, firesPerDay, firingsByHour, nextFiring, shortestGapMs } from './cadence.ts'

describe('when a schedule fires', () => {
  it('fires every day at a wall clock time in its time zone, across a daylight shift', () => {
    const c = { every: 'day' as const, at: '06:00', tz: 'America/Chicago' }
    // Before the shift, 06:00 in Chicago is 12:00 UTC.
    expect(nextFiring(c, new Date('2026-03-06T13:00:00Z'))!.toISOString()).toBe('2026-03-07T12:00:00.000Z')
    // The clocks go forward at 02:00 on 8 March: that morning's 06:00 is 11:00 UTC.
    expect(nextFiring(c, new Date('2026-03-07T13:00:00Z'))!.toISOString()).toBe('2026-03-08T11:00:00.000Z')
  })

  it('fires every hour at its minute, and never at the moment asked from', () => {
    const c = { every: 'hour' as const, minute: 15, tz: 'UTC' }
    expect(nextFiring(c, new Date('2026-01-05T10:10:00Z'))!.toISOString()).toBe('2026-01-05T10:15:00.000Z')
    expect(nextFiring(c, new Date('2026-01-05T10:15:00Z'))!.toISOString()).toBe('2026-01-05T11:15:00.000Z')
  })

  it('fires on the days of the week it names', () => {
    const c = { every: 'week' as const, days: ['mon' as const, 'thu' as const], at: '08:30', tz: 'UTC' }
    // 2026-01-06 is a Tuesday.
    expect(nextFiring(c, new Date('2026-01-06T09:00:00Z'))!.toISOString()).toBe('2026-01-08T08:30:00.000Z')
    expect(shortestGapMs(c)).toBe(3 * 86_400_000)
    expect(firesPerDay(c)).toBeCloseTo(2 / 7)
  })

  it('says what is wrong with one it cannot use, and reads itself in words', () => {
    expect(cadenceProblem({ every: 'day', at: '25:00', tz: 'UTC' })).toContain('HH:MM')
    expect(cadenceProblem({ every: 'day', at: '06:00', tz: 'Mars/Base' })).toContain('time zone')
    expect(cadenceProblem({ every: 'week', days: [], at: '06:00', tz: 'UTC' })).toContain('day')
    expect(cadenceWords({ every: 'week', days: ['mon', 'tue', 'wed', 'thu', 'fri'], at: '06:00', tz: 'America/Chicago' })).toBe('weekdays at 6:00 AM (America/Chicago)')
  })
})

describe('once', () => {
  it('fires at its moment and never again, and is no part of an average day', () => {
    const c = { every: 'once' as const, on: '2026-11-16T08:00:00.000Z', tz: 'America/Chicago' }
    expect(nextFiring(c, new Date('2026-11-15T20:00:00Z'))!.toISOString()).toBe('2026-11-16T08:00:00.000Z')
    expect(nextFiring(c, new Date('2026-11-16T08:00:00Z'))).toBeNull()
    expect(firesPerDay(c)).toBe(0)
    expect(shortestGapMs(c)).toBe(Number.POSITIVE_INFINITY)
    // It lands in the hour of an average week it fires in.
    expect(firingsByHour(c, new Date('2026-11-15T20:00:00Z'))[8]).toBeCloseTo(1 / 7)
  })

  it('reads itself in words in the zone it was meant in, and says when its moment is no moment', () => {
    expect(cadenceWords({ every: 'once', on: '2026-11-16T08:00:00.000Z', tz: 'America/Chicago' })).toBe('once, on Mon, Nov 16, 2026 at 2:00 AM (America/Chicago)')
    expect(cadenceProblem({ every: 'once', on: 'tomorrow', tz: 'UTC' })).toContain('date and time')
  })
})

describe('every few hours', () => {
  it('fires at the same times every day, from the time it names, wrapping past midnight', () => {
    const c = { every: 'hours' as const, hours: 6, at: '02:05', tz: 'UTC' }
    expect(nextFiring(c, new Date('2026-01-05T09:00:00Z'))!.toISOString()).toBe('2026-01-05T14:05:00.000Z')
    expect(nextFiring(c, new Date('2026-01-05T20:05:00Z'))!.toISOString()).toBe('2026-01-06T02:05:00.000Z')
    expect(firesPerDay(c)).toBe(4)
    expect(shortestGapMs(c)).toBe(6 * 3_600_000)
    expect(cadenceWords({ ...c, at: '20:05' })).toBe('every 6 hours, at 2:05 AM, 8:05 AM, 2:05 PM, 8:05 PM (UTC)')
  })

  it('keeps its wall clock times across a daylight shift', () => {
    const c = { every: 'hours' as const, hours: 12, at: '06:00', tz: 'America/Chicago' }
    // 18:00 in Chicago on 7 March is 00:00 UTC on the 8th; the clocks go forward that night, so 06:00 is 11:00 UTC.
    expect(nextFiring(c, new Date('2026-03-08T00:00:00Z'))!.toISOString()).toBe('2026-03-08T11:00:00.000Z')
  })

  it('takes only a step that divides a day', () => {
    expect(cadenceProblem({ every: 'hours', hours: 5, at: '00:00', tz: 'UTC' })).toContain('2, 3, 4, 6, 8, 12')
    expect(cadenceProblem({ every: 'hours', hours: 4, at: '00:00', tz: 'UTC' })).toBeNull()
  })
})

describe('when in the day a schedule fires', () => {
  it('counts its firings in each hour of an average day, in UTC', () => {
    const daily = firingsByHour({ every: 'day', at: '06:00', tz: 'UTC' }, new Date('2026-01-05T00:00:00Z'))
    expect(daily[6]).toBe(1)
    expect(daily.reduce((a, b) => a + b, 0)).toBe(1)
    expect(firingsByHour({ every: 'hour', minute: 0, tz: 'UTC' }, new Date('2026-01-05T00:30:00Z')).every((n) => n === 1)).toBe(true)
  })
})
