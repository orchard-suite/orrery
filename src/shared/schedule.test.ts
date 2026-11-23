import { describe, expect, it } from 'vitest'
import { firesTheSame, worthTelling } from './schedule.ts'

describe('worthTelling', () => {
  it('tells a run that worked only when the schedule asks for every result', () => {
    expect(worthTelling('failed', { succeeded: 1 })).toBe(false)
    expect(worthTelling('anyFailed', { succeeded: 1 })).toBe(false)
    expect(worthTelling('every', { succeeded: 1 })).toBe(true)
  })

  it('tells a run that failed whatever the schedule asks', () => {
    for (const tell of ['failed', 'anyFailed', 'every'] as const) expect(worthTelling(tell, { failed: 1 })).toBe(true)
  })

  it('tells a batch with one failure among many only when anything failing is asked', () => {
    const counts = { succeeded: 19, failed: 1 }
    expect(worthTelling('failed', counts)).toBe(false)
    expect(worthTelling('anyFailed', counts)).toBe(true)
  })

  it('tells a batch where nothing worked as a failure', () => {
    expect(worthTelling('failed', { failed: 18, cancelled: 2 })).toBe(true)
  })

  it('tells nothing of a batch that only ended other ways', () => {
    expect(worthTelling('failed', { cancelled: 3 })).toBe(false)
    expect(worthTelling('anyFailed', { declined: 1 })).toBe(false)
  })
})

describe('firesTheSame', () => {
  const base = { action: 'ping', target: { entity: { blueprint: 'site', key: 'a' } }, inputs: { depth: 2 }, cadence: { every: 'hour' as const, minute: 5, tz: 'UTC' } }

  it('holds whatever order the keys came in', () => {
    expect(firesTheSame(base, { ...base, cadence: { tz: 'UTC', minute: 5, every: 'hour' } })).toBe(true)
  })

  it('moves with the target, the inputs, or the cadence', () => {
    expect(firesTheSame(base, { ...base, target: { entity: { blueprint: 'site', key: 'b' } } })).toBe(false)
    expect(firesTheSame(base, { ...base, inputs: { depth: 3 } })).toBe(false)
    expect(firesTheSame(base, { ...base, cadence: { ...base.cadence, minute: 6 } })).toBe(false)
  })
})
