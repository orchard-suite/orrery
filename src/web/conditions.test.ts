import { describe, expect, it } from 'vitest'
import type { Blueprint } from '../shared/model.ts'
import { conditionFields, hintFor, opsFor, reachOf, sentence, testOf, testsOf, testWords, valueShown } from './conditions.ts'

describe('the tests a condition offers', () => {
  it('turns round the tests that have a turned-round form', () => {
    expect(testsOf(['eq', 'contains', 'exists'])).toEqual([{ op: 'eq' }, { op: 'contains' }, { op: 'contains', not: true }, { op: 'exists' }, { op: 'exists', not: true }])
  })

  it('offers each kind of field the tests that read it', () => {
    expect(opsFor('enum', false, true)).toEqual(['eq', 'neq', 'exists'])
    expect(opsFor('array', false, true)).toEqual(['contains', 'exists'])
    expect(opsFor('datetime', false, false)[0]).toBe('within')
    expect(opsFor('string', false, false)[0]).toBe('contains')
    expect(opsFor('string', false, true)).toEqual(['eq', 'neq', 'exists'])
    expect(opsFor(undefined, true, true)).toEqual(['eq', 'neq', 'exists'])
  })
})

describe('a condition in words', () => {
  it('reads as a sentence', () => {
    expect(sentence({ field: 'connection', op: 'eq', value: 'online' }, 'Connection', 'online')).toBe('Connection is online')
    expect(sentence({ field: 'os', op: 'exists', value: '', not: true }, 'OS', '')).toBe('OS is empty')
  })

  it('says a list includes a value', () => {
    expect(testWords({ op: 'contains', not: true }, 'array')).toBe('does not include')
    expect(testWords({ op: 'contains' }, 'string')).toBe('contains')
  })
})

describe('a condition on what a relation reaches', () => {
  const at = '2026-01-01T00:00:00.000Z'
  const bp = (id: string, title: string, extra: Partial<Blueprint> = {}): Blueprint => ({ id, title, origin: { kind: 'ui' }, updatedAt: at, fields: {}, relations: {}, ...extra })
  const team = bp('team', 'Team')
  const repo = bp('repo', 'Repository', { fields: { days_idle: { type: 'number', title: 'Days idle' }, language: { type: 'enum', values: ['Go', 'C#'] } }, relations: { team: { target: 'team', title: 'Owned by' } } })
  const service = bp('service', 'Service', { relations: { repo: { target: 'repo', title: 'Homed in', many: true } } })
  const all = [team, repo, service]
  const fields = conditionFields(service, all, (b) => b.title)
  const homedIn = fields.find((f) => f.id === 'r:repo')!

  it('says what a relation reaches, and the fields there, to two hops', () => {
    expect(homedIn.reaches?.title).toBe('Repository')
    expect(homedIn.reaches?.fields.map((f) => f.id)).toEqual(['$status', 'days_idle', 'language', 'r:team'])
    expect(homedIn.reaches?.fields.find((f) => f.id === 'language')?.choices?.map((c) => c.value)).toEqual(['Go', 'C#'])
    expect(homedIn.reaches?.fields.find((f) => f.id === 'r:team')?.reaches?.title).toBe('Team')
    expect(reachOf(service, 'r:<-nobody:x', all, (b) => b.title)).toBeUndefined()
  })

  it('offers any, every, and none of them beside the relation\'s own tests', () => {
    expect(testsOf(opsFor(undefined, true, true), homedIn.reaches).filter((t) => t.match).map((t) => t.match)).toEqual(['any', 'all', 'none'])
    expect(testsOf(opsFor(undefined, true, true)).some((t) => t.match)).toBe(false)
    expect(testOf({ field: 'r:repo', op: 'exists', value: '', where: [] })).toEqual({ op: 'exists', match: 'any' })
  })

  it('reads as a sentence', () => {
    const where = [{ field: 'days_idle', op: 'gt' as const, value: '90' }, { field: 'r:team', op: 'exists' as const, value: '', match: 'none' as const, where: [] }]
    expect(sentence({ field: 'r:repo', op: 'exists', value: '', match: 'any', where }, 'Homed in', '', undefined, homedIn.reaches)).toBe('Homed in: any Repository where Days idle is above 90 and Owned by: no Team')
    expect(sentence({ field: 'r:team', op: 'exists', value: '', match: 'none', where: [] }, 'Owned by', '', undefined, { title: 'Team', fields: [] })).toBe('Owned by: no Team')
    expect(sentence({ field: 'r:repo', op: 'exists', value: '', match: 'all', where: where.slice(0, 1) }, 'Homed in', '', undefined, homedIn.reaches)).toBe('Homed in: every Repository where Days idle is above 90')
  })
})

describe('a condition on money', () => {
  const usd = { kind: 'currency', currency: 'USD', minor: true } as const
  it('says and takes its value as an amount, while it keeps the stored number', () => {
    expect(valueShown({ op: 'gt', value: '2470277' }, usd, 'said')).toBe('$24,702.77')
    expect(valueShown({ op: 'gt', value: '2470277' }, usd)).toBe('24702.77')
    expect(valueShown({ op: 'gt', value: '2470277' }, undefined)).toBe('2470277')
    expect(valueShown({ op: 'exists', value: '' }, usd)).toBe('')
    expect(hintFor({ op: 'gt' }, 'number', usd)).toBe('An amount in USD, such as 1,250.00')
  })
})
