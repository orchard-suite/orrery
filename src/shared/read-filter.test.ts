import { describe, expect, it } from 'vitest'
import { FilterError, forAsker, namesAsker, readFilter, typedFilter } from './filter.ts'
import type { Filter } from './model.ts'

describe('a filter as a caller sent it', () => {
  it('reads an empty object as no filter only where it is the whole filter', () => {
    expect(readFilter({})).toBeUndefined()
    expect(readFilter(null)).toBeUndefined()
  })

  it('refuses a condition that arrived empty, never answering without it', () => {
    expect(() => readFilter({ and: [{ search: 'a' }, {}] })).toThrow(/arrived empty/)
    expect(() => readFilter({ or: [{ search: 'a' }, { not: {} }] })).toThrow(/arrived empty/)
    expect(() => readFilter({ and: [] })).toThrow(/and holds no condition/)
  })

  it('reads a value written as text as its field\'s type', () => {
    const types: Record<string, string> = { prod: 'boolean', size: 'number', name: 'string' }
    const f = { and: [{ field: 'prod', op: 'eq', value: 'true' }, { field: 'size', op: 'in', value: ['3', '4'] }, { field: 'name', op: 'eq', value: '7' }, { field: 'size', op: 'eq', value: 'many' }] } satisfies Filter
    expect(typedFilter(f, (n) => types[n])).toEqual({ and: [{ field: 'prod', op: 'eq', value: true }, { field: 'size', op: 'in', value: [3, 4] }, { field: 'name', op: 'eq', value: '7' }, { field: 'size', op: 'eq', value: 'many' }] })
  })

  it('keeps every leaf it knows as it was sent', () => {
    const f = { and: [{ field: 'tier', op: 'eq', value: 'gold' }, { relation: '<-pod:namespace', where: { field: 'phase', op: 'exists' }, every: true }, { not: { relatedTo: 'team:a' } }, { scorecard: 'ready', op: 'gte', value: 'silver' }] }
    expect(readFilter(f)).toEqual(f)
  })

  it('names the part that is no filter', () => {
    expect(() => readFilter({ fild: 'tier' })).toThrow(FilterError)
    expect(() => readFilter({ field: 'tier' })).toThrow(/op must be one of/)
    expect(() => readFilter({ and: [{ relation: 7 }] })).toThrow(/relation must be text in \{"relation":7\}/)
    expect(() => readFilter('tier')).toThrow(/a filter is an object/)
  })
})

describe('a filter that names who asks', () => {
  const who = { address: 'ada@example.com', person: 'person:ada', times: { '@now': 'N', '@today': 'T', '@yesterday': 'Y', '@tomorrow': 'M' } }
  it('fills in their address, their entity, and their days', () => {
    const f = { and: [{ field: 'decided_by', op: 'eq', value: '@me' }, { field: 'decided_at', op: 'gte', value: '@today' }, { relation: 'approvers', target: '@me' }, { not: { relatedTo: '@me' } }, { field: 'by', op: 'in', value: ['@me', 'bob'] }] } as const
    expect(namesAsker(f as never)).toBe(true)
    expect(forAsker(f as never, who)).toEqual({ and: [{ field: 'decided_by', op: 'eq', value: 'ada@example.com' }, { field: 'decided_at', op: 'gte', value: 'T' }, { relation: 'approvers', target: 'person:ada' }, { not: { relatedTo: 'person:ada' } }, { field: 'by', op: 'in', value: ['ada@example.com', 'bob'] }] })
    expect(namesAsker({ search: 'me' })).toBe(false)
  })
  it('says so when the catalog holds no entity for them', () => {
    expect(() => forAsker({ relatedTo: '@me' }, { ...who, person: null })).toThrow(FilterError)
  })
})
