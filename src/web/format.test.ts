import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ago, day, humanTimes } from './format.ts'

describe('ago', () => {
  beforeEach(() => vi.useFakeTimers({ now: new Date('2026-11-05T12:00:00Z') }))
  afterEach(() => vi.useRealTimers())

  it('reads a past time as a span ago', () => {
    expect(ago('2026-11-05T11:55:00Z')).toBe('5m ago')
    expect(ago('2026-10-29T12:00:00Z')).toBe('7d ago')
  })

  it('reads a time still to come as a span ahead', () => {
    expect(ago('2026-11-12T08:03:00Z')).toBe('in 7d')
    expect(ago('2026-11-05T15:00:00Z')).toBe('in 3h')
  })

  it('reads the span from the clock it is given', () => {
    expect(ago('2026-11-05T11:59:00Z', Date.parse('2026-11-05T11:59:49Z'))).toBe('49s ago')
    expect(ago('2026-11-05T11:59:00Z', Date.parse('2026-11-05T11:59:57Z'))).toBe('57s ago')
  })

  it('reads a time under a minute ahead as now', () => {
    expect(ago('2026-11-05T12:00:30Z')).toBe('just now')
  })

  it('turns the times in a reason into spans', () => {
    expect(humanTimes('a client secret expires 2026-11-12T08:03:00Z')).toBe('a client secret expires in 7d')
  })
})

describe('day', () => {
  // Local noon, so the test reads the same in every time zone.
  beforeEach(() => vi.useFakeTimers({ now: new Date(2026, 10, 9, 12) }))
  afterEach(() => vi.useRealTimers())
  const at = (date: number, hour: number, month = 10, year = 2026) => new Date(year, month, date, hour).toISOString()

  it('names today and yesterday by their local midnight, not by 24 hours', () => {
    expect(day(at(9, 0))).toBe('Today')
    expect(day(at(8, 23))).toBe('Yesterday')
    expect(day(at(8, 0))).toBe('Yesterday')
  })

  it('names the rest of the week by weekday, and earlier days by date', () => {
    expect(day(at(4, 12))).toBe(new Date(2026, 10, 4).toLocaleDateString(undefined, { weekday: 'long' }))
    expect(day(at(2, 12))).toBe(
      new Date(2026, 10, 2).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
      }),
    )
    expect(day(at(30, 12, 11, 2025))).toBe(
      new Date(2025, 11, 30).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      }),
    )
  })
})
