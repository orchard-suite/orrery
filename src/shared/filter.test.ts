import { describe, expect, it } from 'vitest'
import { matches, neighbourWheres, renamedIn, whereKey, whereSets } from './filter.ts'
import type { Entity, Filter } from './model.ts'

const now = (id: string) => (id === 'gizmo' ? 'shop_gizmo' : id)

describe('renamedIn', () => {
  it('moves every entity id and incoming hop that names a former blueprint', () => {
    const f: Filter = { and: [{ relation: 'gizmo', target: 'gizmo:one' }, { or: [{ relatedTo: 'gizmo:two' }, { not: { relation: '<-gizmo:part' } }] }] }
    expect(renamedIn(f, now)).toEqual({ and: [{ relation: 'gizmo', target: 'shop_gizmo:one' }, { or: [{ relatedTo: 'shop_gizmo:two' }, { not: { relation: '<-shop_gizmo:part' } }] }] })
  })

  it('leaves a bare key, a title, and a field alone, and gives back the same filter when nothing moved', () => {
    const f: Filter = { and: [{ relation: 'gizmo', target: 'one' }, { relation: '<-part' }, { field: 'gizmo', op: 'eq', value: 'gizmo:one' }, { relation: 'gizmo', target: 'part:one' }] }
    expect(renamedIn(f, now)).toBe(f)
  })
})

describe('a relation leaf that reads what it reaches', () => {
  const at = '2026-01-01T00:00:00.000Z'
  const entity = (blueprint: string, key: string, fields: Record<string, unknown> = {}, relations: Entity['relations'] = {}): Entity => ({
    blueprint,
    key,
    id: `${blueprint}:${key}`,
    title: key,
    icon: null,
    state: 'active',
    hidden: false,
    fields,
    relations,
    owner: 'test',
    scope: null,
    createdAt: at,
    updatedAt: at,
    lastSeenAt: null,
    missingSince: null,
    deletedAt: null,
    status: { level: 'green', reasons: [] },
  })
  const ref = (key: string) => ({ blueprint: 'repo', key, title: key })
  const repos = [entity('repo', 'idle', { days: 400 }), entity('repo', 'busy', { days: 2 }), entity('repo', 'old', { days: 120 })]
  const both = entity('service', 'both', {}, { repo: [ref('idle'), ref('busy')] })
  const idleOnly = entity('service', 'idle-only', {}, { repo: [ref('idle'), ref('old')] })
  const none = entity('service', 'none', {})
  const idle: Filter = { field: 'days', op: 'gt', value: 90 }
  const sets = whereSets({ relation: 'repo', where: idle }, repos)
  const kept = (f: Filter) => [both, idleOnly, none].filter((e) => matches(e, f, whereSets(f, repos))).map((e) => e.key)

  it('works out the entities that meet each where, under its key', () => {
    expect([...sets.get(whereKey(idle))!].sort()).toEqual(['repo:idle', 'repo:old'])
  })

  it('keeps a row when any of what it reaches meets the where', () => {
    expect(kept({ relation: 'repo', where: idle })).toEqual(['both', 'idle-only'])
  })

  it('keeps a row when it reaches at least one and every one meets the where', () => {
    expect(kept({ relation: 'repo', where: idle, every: true })).toEqual(['idle-only'])
  })

  it('keeps a row when none it reaches meets the where, turned round', () => {
    expect(kept({ not: { relation: 'repo', where: idle } })).toEqual(['none'])
  })

  it('meets nothing when no set is given for the where', () => {
    expect(matches(both, { relation: 'repo', where: idle })).toBe(false)
  })

  it('works out a where inside a where first', () => {
    const deep = entity('team', 't', {}, { service: [{ blueprint: 'service', key: 'idle-only', title: 'idle-only' }] })
    const f: Filter = { relation: 'service', where: { relation: 'repo', where: idle, every: true } }
    expect(matches(deep, f, whereSets(f, [...repos, both, idleOnly, none]))).toBe(true)
  })

  it('renames a blueprint inside the where', () => {
    const f: Filter = { relation: 'repo', where: { relation: '<-gizmo:part' } }
    expect(renamedIn(f, now)).toEqual({ relation: 'repo', where: { relation: '<-shop_gizmo:part' } })
  })

  it('finds only the outermost wheres', () => {
    const inner: Filter = { relation: 'b', where: idle }
    expect(neighbourWheres({ and: [{ relation: 'a', where: inner }, { not: { relation: 'c', where: idle } }] })).toEqual([inner, idle])
  })
})
