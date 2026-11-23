import { describe, expect, it } from 'vitest'
import { isTrend, trendSummary } from './Trend.tsx'

describe('a trend in words', () => {
  it('names where it began and where it is, by label when it has them', () => {
    const t = { points: [{ at: '2026-10-01T12:00:00Z', value: 3 }, { at: '2026-11-03T12:00:00Z', value: 2 }], step: true, labels: { '2': 'Silver', '3': 'Gold' } }
    expect(trendSummary(t)).toMatch(/^Gold to Silver since Oct 1$/)
  })

  it('reads a value with its unit, and an empty one as nothing yet', () => {
    expect(trendSummary({ points: [{ at: '2026-11-01T12:00:00Z', value: 62.5 }, { at: '2026-11-02T12:00:00Z', value: 64 }], unit: '%' })).toMatch(/^62.5% to 64% since/)
    expect(trendSummary({ points: [] })).toBe('No points yet')
  })

  it('tells a trend from anything else', () => {
    expect(isTrend({ points: [] })).toBe(true)
    expect(isTrend([1, 2])).toBe(false)
    expect(isTrend(null)).toBe(false)
  })
})
