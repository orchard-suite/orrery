import { describe, expect, it, vi } from 'vitest'
import { compile } from './expr.ts'

describe('expressions', () => {
  const f = { replicas: 3, ready: 2, name: 'api', tags: { env: 'prod' }, expires: new Date(Date.now() + 20 * 86_400_000).toISOString(), list: [1, 2] }
  const ev = (src: string) => compile(src).evaluate(f)
  it('does arithmetic and comparisons', () => {
    expect(ev('ready / replicas * 100')).toBeCloseTo(66.67, 1)
    expect(ev('ready < replicas')).toBe(true)
    expect(ev('replicas - ready == 1 && name == "api"')).toBe(true)
    expect(ev("tags['env'] == 'prod' ? 'critical' : 'standard'")).toBe('critical')
    expect(ev('fields.tags.env')).toBe('prod')
  })
  it('has date and shape helpers', () => {
    expect(ev('days_until(expires) > 14')).toBe(true)
    expect(ev('len(list) + len(name)')).toBe(5)
    expect(ev('coalesce(missing, ready)')).toBe(2)
    expect(ev('empty(missing) && !empty(name)')).toBe(true)
    expect(ev('round(ready / replicas, 2)')).toBe(0.67)
  })
  it('reads hours and the time of day in a zone', () => {
    vi.useFakeTimers()
    // A Monday, 15:30 UTC: 09:30 in Chicago.
    vi.setSystemTime(new Date('2026-11-09T15:30:00Z'))
    try {
      expect(compile('hours_since(at)').evaluate({ at: '2026-11-09T12:00:00Z' })).toBe(3)
      expect(compile('hours_since(at)').evaluate({ at: 'not a date' })).toBeNull()
      expect(compile("hour_now('America/Chicago')").evaluate({})).toBe(9)
      expect(compile('hour_now()').evaluate({})).toBe(15)
      expect(compile("hour_now('Nowhere/Else')").evaluate({})).toBe(15)
      expect(compile("weekday_now('America/Chicago')").evaluate({})).toBe(1)
      vi.setSystemTime(new Date('2026-11-09T03:00:00Z'))
      expect(compile("weekday_now('America/Chicago')").evaluate({})).toBe(7)
    } finally {
      vi.useRealTimers()
    }
  })
  it('joins values into one list', () => {
    expect(ev("list(list, name, missing, '', 2)")).toEqual([1, 2, 'api'])
    expect(ev("lower(list('A@x.com', name))")).toEqual(['a@x.com', 'api'])
    expect(ev('list(missing)')).toEqual([])
  })
  it('cuts a path back to what holds it', () => {
    expect(compile("before_last(key, '/')").evaluate({ key: 'azuredevops/team/project/repo' })).toBe('azuredevops/team/project')
    expect(compile("list(key, before_last(key, '/'))").evaluate({ key: 'forge/acme/beacon' })).toEqual(['forge/acme/beacon', 'forge/acme'])
    expect(compile("before_last(key, '/')").evaluate({ key: 'standalone' })).toBe('standalone')
    expect(ev("before_last(missing, '/')")).toBe(null)
  })
  it('refuses bad syntax and unknown functions', () => {
    expect(() => compile('ready +')).toThrow()
    expect(() => compile('exec("rm")')).toThrow(/unknown function/)
    expect(() => compile('a b')).toThrow()
  })
  it('treats missing values as null without throwing', () => {
    expect(ev('nope.deeper + 1')).toBeNull()
    expect(ev('missing > 3')).toBe(false)
  })
})
