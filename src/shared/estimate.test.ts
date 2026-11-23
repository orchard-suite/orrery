import { describe, expect, it } from 'vitest'
import { PACE_ENOUGH, estimate, roughly } from './estimate.ts'

describe('how long a batch takes', () => {
  it('reads the action history and the runner width before the batch has a pace', () => {
    expect(estimate({ left: 8282, meanSeconds: 3, width: 10 })).toEqual({ seconds: 2485, basis: 'history' })
    // The last few runs still take a whole run each.
    expect(estimate({ left: 4, meanSeconds: 3, width: 10 })).toEqual({ seconds: 3, basis: 'history' })
    // A backend handed every run at once takes one run's time.
    expect(estimate({ left: 500, meanSeconds: 12, width: 'all' })).toEqual({ seconds: 12, basis: 'history' })
  })

  it('says nothing without a history or a width', () => {
    expect(estimate({ left: 10, meanSeconds: null, width: 10 })).toBeNull()
    expect(estimate({ left: 10, meanSeconds: 3, width: null })).toBeNull()
  })

  it('follows the batch own pace once enough runs have ended', () => {
    expect(estimate({ left: 1000, meanSeconds: 3, width: 10, pace: { ended: PACE_ENOUGH, seconds: 60 } })).toEqual({ seconds: 3000, basis: 'pace' })
    // Too few ended: the history still says.
    expect(estimate({ left: 1000, meanSeconds: 3, width: 10, pace: { ended: PACE_ENOUGH - 1, seconds: 60 } })?.basis).toBe('history')
  })

  it('says a time the way a person does', () => {
    expect(roughly(40)).toBe('under a minute')
    expect(roughly(25 * 60)).toBe('about 25 min')
    expect(roughly(2 * 3600 + 10 * 60)).toBe('about 2 h 10 min')
    expect(roughly(3 * 3600)).toBe('about 3 h')
  })
})
