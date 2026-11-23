import { describe, expect, it } from 'vitest'
import { batchAsked, batchSize, batchState, batchTook } from './BatchLine.tsx'

describe('a batch as one line', () => {
  it('shows one mark for the whole batch: running while any run is open, failed when any failed', () => {
    expect(batchState({ done: false, counts: { running: 2, succeeded: 5 } })).toBe('running')
    expect(batchState({ done: false, counts: { queued: 7 } })).toBe('queued')
    expect(batchState({ done: true, counts: { succeeded: 9, failed: 1 } })).toBe('failed')
    expect(batchState({ done: true, counts: { succeeded: 10 } })).toBe('succeeded')
    expect(batchState({ done: true, counts: { cancelled: 3 } })).toBe('cancelled')
  })

  it('counts its runs, says what was asked, and how long it took once over', () => {
    expect(batchSize({ counts: { succeeded: 35, failed: 2 } })).toBe(37)
    expect(batchAsked({ inputs: { command: 'ping', note: null, empty: '' } })).toBe('ping')
    expect(batchTook({ createdAt: '2026-01-05T15:00:00Z', endedAt: '2026-01-05T15:00:17Z' })).toBe('17s')
    expect(batchTook({ createdAt: '2026-01-05T15:00:00Z', endedAt: null })).toBeNull()
  })
})
