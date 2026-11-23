import { describe, expect, it } from 'vitest'
import { servesOf, servesText } from './Sources.tsx'

describe("a runner's tool rule", () => {
  const form = { tiers: [], sources: '', blueprint: '', where: '' }

  it('is nothing while no tier is ticked', () => {
    expect(servesOf({ ...form, sources: 'desk', blueprint: 'repository' })).toBeNull()
    expect(servesText(undefined)).toBe('none')
  })

  it('holds the tiers least first, the sources that may put a tool on it, and where a tool is declared', () => {
    const rule = servesOf({ tiers: ['act', 'read'], sources: 'desk, ci ', blueprint: ' repository ', where: '{"relation": "program", "target": "program:shop"}' })
    expect(rule).toEqual({ tiers: ['read', 'act'], sources: ['desk', 'ci'], on: { blueprint: 'repository', where: { relation: 'program', target: 'program:shop' } } })
    expect(servesText(rule!)).toBe('read, act · put by desk, ci · declared from a repository that matches its filter')
    expect(servesOf({ ...form, tiers: ['read'] })).toEqual({ tiers: ['read'] })
  })

  it('refuses a filter that is not JSON, or one with no blueprint to read', () => {
    expect(() => servesOf({ ...form, tiers: ['read'], blueprint: 'repository', where: 'program = shop' })).toThrow(/not JSON/)
    expect(() => servesOf({ ...form, tiers: ['read'], where: '{}' })).toThrow(/needs the blueprint/)
  })
})
