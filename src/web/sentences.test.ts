import { describe, expect, it } from 'vitest'
import { blueprintNamer, type Blueprint } from '../shared/model.ts'
import { aggregationWords, fieldWords, kindWords, mirrorWords, nameFor, reachesFrom, reachOf } from './sentences.ts'

const bp = (id: string, title: string, rest: Partial<Blueprint> = {}): Blueprint => ({ id, title, fields: {}, relations: {}, origin: { kind: 'ui' }, ...rest }) as Blueprint
const pillar = bp('pillar', 'Pillar', { relations: { parent: { target: 'pillar', title: 'Part of' } } })
const service = bp('service', 'Service', { fields: { cost: { type: 'number', title: 'Cost' } }, relations: { pillars: { target: 'pillar', many: true, title: 'Pillars' }, repo: { target: 'repo' } } })
const repo = bp('repo', 'Repository', { fields: { url: { type: 'url', title: 'URL' } } })
const all = [pillar, service, repo]
const name = blueprintNamer(all)

describe('kindWords', () => {
  it('says a kind in words, and a list of one as several', () => {
    expect(kindWords({ type: 'number' })).toBe('a number')
    expect(kindWords({ type: 'enum', many: true })).toBe('several of a list')
    expect(kindWords({ type: 'url', many: true })).toBe('links')
  })
})

describe('reaches', () => {
  it('steps out through its own relations and in through every relation that points at it', () => {
    expect(reachesFrom(pillar, all, name).map((r) => r.path)).toEqual(['parent', '<-pillar:parent', '<-service:pillars'])
  })
  it('takes a bare incoming hop only when one blueprint has the relation', () => {
    expect(reachOf('<-pillars', pillar, all, name)?.to).toBe('service')
    expect(reachOf('<-parent', pillar, all, name)?.to).toBe('pillar')
    expect(reachOf('<-service:pillars.repo', pillar, all, name)).toBeNull()
    expect(reachOf('not a path!', pillar, all, name)).toBeNull()
  })
})

describe('aggregationWords', () => {
  it('says a count over one hop in words', () => {
    expect(aggregationWords({ fn: 'count', relation: '<-service:pillars' }, pillar, all, name)).toBe('the count of every Service that points at it as Pillars')
  })
  it('names the field it adds up, the window, and the rate', () => {
    expect(aggregationWords({ fn: 'sum', relation: '<-service:pillars', field: 'cost', window: { field: 'at', last: '30d' }, per: 'week' }, pillar, all, name)).toBe('the total Cost of every Service that points at it as Pillars, in the last 30d, per week')
  })
  it('says a longer path as itself', () => {
    expect(aggregationWords({ fn: 'count', relation: '<-service:pillars', where: { field: 'cost', op: 'gt', value: 10 } }, pillar, all, name)).toBe('the count of every Service that points at it as Pillars whose Cost is above 10')
    expect(aggregationWords({ fn: 'count', relation: '<-service:pillars', where: { or: [{ field: 'cost', op: 'gt', value: 10 }, { field: 'cost', op: 'lt', value: 1 }] } }, pillar, all, name)).toBe('the count of every Service that points at it as Pillars that meet a condition')
    expect(aggregationWords({ fn: 'count', relation: '<-service:pillars.repo' }, pillar, all, name)).toBe('the count of what <-service:pillars.repo reaches')
  })
})

describe('mirrorWords', () => {
  it('says a copy across one hop as the field on its target', () => {
    expect(mirrorWords('repo.url', service, all, name)).toBe('the URL on its Repository')
    expect(mirrorWords('repo', service, all, name)).toBe('the title on its Repository')
  })
  it('says anything else as the path', () => {
    expect(mirrorWords('<-service:pillars.cost', pillar, all, name)).toBe('copied from <-service:pillars.cost')
  })
})

describe('fieldWords', () => {
  it('reads a formula as worked out, and a typed field as its kind', () => {
    expect(fieldWords({ type: 'number', calculation: 'a + b' }, pillar, all, name)).toBe('a number, worked out')
    expect(fieldWords({ type: 'markdown' }, pillar, all, name)).toBe('markdown')
  })
})

describe('nameFor', () => {
  it('makes a name from words, kept apart from what is taken', () => {
    expect(nameFor('Time to restore (p50)', [])).toBe('time_to_restore_p50')
    expect(nameFor('Notes', ['notes', 'notes_2'])).toBe('notes_3')
    expect(nameFor('2nd owner', [])).toBe('nd_owner')
    expect(nameFor('  !! ', [])).toBe('')
  })
})
