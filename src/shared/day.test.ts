import { describe, expect, it } from 'vitest'
import { dayOf, knownZone } from './day.ts'

describe("a person's day", () => {
  it('starts at their own midnight, not the hub\'s', () => {
    const d = dayOf(new Date('2026-11-16T20:07:40Z'), 'America/Chicago')
    expect(d.date).toBe('2026-11-16')
    expect(d.startedAt.toISOString()).toBe('2026-11-16T06:00:00.000Z')
    // Early in the UTC day it is still yesterday there.
    expect(dayOf(new Date('2026-11-17T03:00:00Z'), 'America/Chicago').date).toBe('2026-11-16')
    expect(dayOf(new Date('2026-11-16T20:07:40Z'), 'UTC').startedAt.toISOString()).toBe('2026-11-16T00:00:00.000Z')
  })

  it('starts a day the clocks change in at its own midnight', () => {
    // The clocks went back at 2 AM on November 1: midnight was still on summer time.
    expect(dayOf(new Date('2026-11-01T18:00:00Z'), 'America/Chicago').startedAt.toISOString()).toBe('2026-11-01T05:00:00.000Z')
    expect(dayOf(new Date('2026-03-08T18:00:00Z'), 'America/Chicago').startedAt.toISOString()).toBe('2026-03-08T06:00:00.000Z')
  })

  it('knows a zone from a name that is none', () => {
    expect(knownZone('America/Chicago')).toBe(true)
    expect(knownZone('Mars/Olympus')).toBe(false)
  })
})
