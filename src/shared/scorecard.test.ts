import { describe, expect, it } from 'vitest'
import type { Scorecard } from './api.ts'
import { matches } from './filter.ts'
import type { Entity, Filter } from './model.ts'
import { reached, scoreEntity } from './scorecard.ts'

const card: Scorecard = {
  id: 'secure',
  blueprint: 'storage',
  title: 'Secure',
  where: { field: 'env', op: 'eq', value: 'Prod' },
  levels: [
    { name: 'Bronze', rules: [{ id: 'tls', title: 'TLS', where: { field: 'tls', op: 'exists' } }] },
    { name: 'Silver', rules: [{ id: 'private', title: 'Private', where: { field: 'private', op: 'eq', value: true } }] },
    { name: 'Gold', rules: [{ id: 'grs', title: 'GRS', where: { field: 'grs', op: 'eq', value: true } }] },
  ],
  origin: { kind: 'ui' },
  updatedAt: '2026-01-01T00:00:00.000Z',
}

const entity = (key: string, fields: Record<string, unknown>): Entity => {
  const e: Entity = { id: `storage:${key}`, blueprint: 'storage', key, title: key, icon: null, state: 'active', hidden: false, fields, relations: {}, owner: 'x', scope: null, createdAt: '', updatedAt: '', lastSeenAt: null, missingSince: null, deletedAt: null, status: { level: 'green', reasons: [] } }
  const row = scoreEntity(card, e)
  e.levels = row ? { secure: reached(card, row) } : {}
  return e
}

const none = entity('none', { env: 'Prod' })
const bronze = entity('bronze', { env: 'Prod', tls: '1.2' })
const silver = entity('silver', { env: 'Prod', tls: '1.2', private: true })
// Gold passes, Silver fails: a level is reached only with every level below it.
const gap = entity('gap', { env: 'Prod', tls: '1.2', grs: true })
const gold = entity('gold', { env: 'Prod', tls: '1.2', private: true, grs: true })
const test = entity('test', { env: 'Test', tls: '1.2', private: true, grs: true })
const all = [none, bronze, silver, gap, gold, test]
const keys = (f: Filter) => all.filter((e) => matches(e, f)).map((e) => e.key)

describe('a scorecard level in a filter', () => {
  it('records the levels reached, lowest first, and nothing for an entity out of scope', () => {
    expect(gold.levels).toEqual({ secure: ['Bronze', 'Silver', 'Gold'] })
    expect(gap.levels).toEqual({ secure: ['Bronze'] })
    expect(none.levels).toEqual({ secure: [] })
    expect(test.levels).toEqual({})
  })

  it('compares levels in the scorecard order, not by name', () => {
    expect(keys({ scorecard: 'secure', op: 'gte', value: 'Silver' })).toEqual(['silver', 'gold'])
    expect(keys({ scorecard: 'secure', op: 'gt', value: 'Bronze' })).toEqual(['silver', 'gold'])
    expect(keys({ scorecard: 'secure', op: 'lt', value: 'Silver' })).toEqual(['none', 'bronze', 'gap'])
    expect(keys({ scorecard: 'secure', op: 'lte', value: 'Bronze' })).toEqual(['none', 'bronze', 'gap'])
    expect(keys({ scorecard: 'secure', op: 'eq', value: 'Bronze' })).toEqual(['bronze', 'gap'])
    expect(keys({ scorecard: 'secure', op: 'in', value: ['Silver', 'Gold'] })).toEqual(['silver', 'gold'])
  })

  it('calls an entity in scope that reached nothing none, below every level', () => {
    expect(keys({ scorecard: 'secure', op: 'eq', value: 'none' })).toEqual(['none'])
    expect(keys({ scorecard: 'secure', op: 'gte', value: 'none' })).toEqual(['none', 'bronze', 'silver', 'gap', 'gold'])
    expect(keys({ scorecard: 'secure', op: 'gt', value: 'none' })).toEqual(['bronze', 'silver', 'gap', 'gold'])
  })

  it('matches no level condition on an entity out of scope, and exists asks whether it is in scope', () => {
    for (const op of ['eq', 'neq', 'gt', 'gte', 'lt', 'lte'] as const) expect(matches(test, { scorecard: 'secure', op, value: 'Silver' })).toBe(false)
    expect(keys({ scorecard: 'secure', op: 'exists' })).toEqual(['none', 'bronze', 'silver', 'gap', 'gold'])
    expect(keys({ not: { scorecard: 'secure', op: 'exists' } })).toEqual(['test'])
  })

  it('reads nothing on an entity that carries no levels', () => {
    const bare = { ...gold, levels: undefined }
    expect(matches(bare, { scorecard: 'secure', op: 'exists' })).toBe(false)
  })
})
