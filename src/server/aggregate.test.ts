import { describe, expect, it } from 'vitest'
import type { Entity } from '../shared/model.ts'
import { nextChange } from '../shared/filter.ts'
import { spanEnd } from './history.ts'
import { aggregate, aggregateNext } from './read.ts'

const DAY = 86_400_000
const now = Date.parse('2026-11-07T12:00:00Z')
const deployment = (daysAgo: number, hours: number): Entity =>
  ({ blueprint: 'sw_deployment', key: `d${daysAgo}`, title: `d${daysAgo}`, fields: { finished_at: new Date(now - daysAgo * DAY).toISOString(), lead_time_hours: hours }, relations: {} }) as unknown as Entity

const all = [deployment(1, 1), deployment(5, 2), deployment(20, 3), deployment(29, 4), deployment(31, 10), deployment(45, 20), deployment(70, 30)]

describe('aggregate', () => {
  it('counts the window before the last one when the window has an offset', () => {
    expect(aggregate({ relation: 'x', fn: 'count', window: { field: 'finished_at', last: '30d' } }, all, now)).toBe(4)
    expect(aggregate({ relation: 'x', fn: 'count', window: { field: 'finished_at', last: '30d', offset: '30d' } }, all, now)).toBe(2)
    expect(aggregate({ relation: 'x', fn: 'median', field: 'lead_time_hours', window: { field: 'finished_at', last: '30d', offset: '30d' } }, all, now)).toBe(15)
  })

  it('turns an offset window into a rate over its own span', () => {
    expect(aggregate({ relation: 'x', fn: 'count', window: { field: 'finished_at', last: '30d', offset: '30d' }, per: 'week' }, all, now)).toBe(0.47)
  })

  it('takes the ninetieth percentile by nearest rank', () => {
    expect(aggregate({ relation: 'x', fn: 'p90', field: 'lead_time_hours' }, all, now)).toBe(30)
    const ten = Array.from({ length: 10 }, (_, i) => deployment(i, i + 1))
    expect(aggregate({ relation: 'x', fn: 'p90', field: 'lead_time_hours' }, ten, now)).toBe(9)
    expect(aggregate({ relation: 'x', fn: 'p90', field: 'lead_time_hours' }, [], now)).toBe(null)
  })
})

describe('when a value that reads the time next changes', () => {
  it('names the moment an entity leaves or enters a window', () => {
    // In the last 30 days: 1, 5, 20, and 29 days ago. The 29-day-old one leaves the moment after it is 30 days old.
    expect(aggregateNext({ relation: 'x', fn: 'count', window: { field: 'finished_at', last: '30d' } }, all, now)).toBe(now + DAY + 1)
    // Moved back 30 days, the window takes the 29-day-old one in a day, before anything in it leaves.
    expect(aggregateNext({ relation: 'x', fn: 'count', window: { field: 'finished_at', last: '30d', offset: '30d' } }, all, now)).toBe(now + DAY)
    expect(aggregateNext({ relation: 'x', fn: 'count' }, all, now)).toBeNull()
    expect(aggregateNext({ relation: 'x', fn: 'count', window: { field: 'finished_at', last: '30d' } }, [], now)).toBeNull()
    // A `where` that reads the time names its crossing too: the 5-day-old one stops being within a week in two days.
    expect(aggregateNext({ relation: 'x', fn: 'count', where: { field: 'finished_at', op: 'within', value: '7d' } }, all, now)).toBe(now + 2 * DAY + 1)
  })

  it('names the moment a within or older test crosses its span', () => {
    const e = deployment(5, 1)
    expect(nextChange(e, { field: 'finished_at', op: 'within', value: '7d' }, now)).toBe(now + 2 * DAY + 1)
    // Already older than two days: nothing ahead changes that.
    expect(nextChange(e, { field: 'finished_at', op: 'older', value: '2d' }, now)).toBeNull()
    expect(nextChange(e, { and: [{ field: 'finished_at', op: 'older', value: '10d' }, { field: 'lead_time_hours', op: 'gt', value: 0 }] }, now)).toBe(now + 5 * DAY + 1)
    expect(nextChange(e, { field: 'lead_time_hours', op: 'gt', value: 0 }, now)).toBeNull()
  })

  it('ends a span on the grid its length lays from the epoch', () => {
    expect(spanEnd(now, DAY)).toBe(Date.parse('2026-11-08T00:00:00Z'))
    expect(spanEnd(Date.parse('2026-11-08T00:00:00Z'), DAY)).toBe(Date.parse('2026-11-09T00:00:00Z'))
    expect(new Date(spanEnd(now, 7 * DAY)).getUTCDay()).toBe(4)
  })
})
