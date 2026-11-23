import { describe, expect, it } from 'vitest'
import type { Entity, RelationEnd } from '../shared/model.ts'
import { CARD_FIELDS_CHARS, CARD_LINKS, CARD_VALUE_CHARS, SHOWN_LINKS, bounded, card, firstSentence, stem, wordsFilter, incomingGroups, outgoingGroups } from './cards.ts'

const entity = (over: Partial<Entity> = {}): Entity => ({
  id: 'team:platform',
  blueprint: 'team',
  key: 'platform',
  title: 'Platform',
  icon: null,
  state: 'active',
  hidden: false,
  fields: {},
  relations: {},
  owner: 'git',
  scope: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  lastSeenAt: null,
  missingSince: null,
  deletedAt: null,
  status: { level: 'green', reasons: [] },
  ...over,
})

const end = (declaredOn: string, relation: string, key: string): RelationEnd => ({
  relation,
  declaredOn,
  target: { blueprint: declaredOn, key },
  targetTitle: key,
  targetIcon: null,
  pending: false,
  dangling: false,
  title: relation,
  display: 'link',
  layer: 'pushed',
})

describe('a value as an answer shows it', () => {
  it('shows a small value as it is and says a big one', () => {
    expect(bounded('short', 10)).toBe('short')
    expect(bounded(42, 1)).toBe(42)
    expect(bounded('x'.repeat(20), 10)).toBe(`${'x'.repeat(10)}… (cut: 20 characters)`)
    expect(bounded(Array.from({ length: 50 }, (_, i) => i), 20)).toEqual({ cut: 'a list of 50' })
    expect(bounded({ a: 'x'.repeat(30) }, 20)).toEqual({ cut: 'an object of 1 keys, 38 characters' })
  })

  it('takes a description to its first sentence', () => {
    expect(firstSentence('A team. It owns things.')).toBe('A team.')
    expect(firstSentence('No stop at all')).toBe('No stop at all')
    expect(firstSentence('Version 1.2 ships. Next')).toBe('Version 1.2 ships.')
  })
})

describe("a person's words", () => {
  it('finds a plural by its stem and takes a kind\'s name for the kind', () => {
    expect(['approvals', 'policies', 'boxes', 'api', 'status'].map(stem)).toEqual(['approval', 'polic', 'box', 'api', 'statu'])
    expect(wordsFilter('Infrastructure approvals', [{ id: 'it_approval', title: 'Approval' }, { id: 'sw_service', title: 'Service' }])).toEqual([{ search: 'infrastructure' }, { or: [{ search: 'approval' }, { field: '$blueprint', op: 'in', value: ['it_approval'] }] }])
  })
})

describe('a card', () => {
  it('holds the small values, says the big ones, and leaves out what is empty', () => {
    const c = card(entity({ fields: { lead: 'Ada', notes: null, spec: 'y'.repeat(CARD_VALUE_CHARS + 1) } }))
    expect(c.fields.lead).toBe('Ada')
    expect('notes' in c.fields).toBe(false)
    expect(c.fields.spec).toMatch(/cut: 201 characters/)
  })

  it('holds as many values as fit, in the order they are declared, and names the rest', () => {
    const fields = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`f${String(i).padStart(2, '0')}`, 'v'.repeat(40)]))
    const c = card(entity({ fields }))
    expect(JSON.stringify(c.fields).length).toBeLessThanOrEqual(CARD_FIELDS_CHARS + 40)
    expect(Object.keys(c.fields)[0]).toBe('f00')
    expect([...Object.keys(c.fields), ...c.moreFields!]).toEqual(Object.keys(fields))
  })

  it('holds only the fields asked for', () => {
    expect(card(entity({ fields: { lead: 'Ada', size: 4 } }), ['size']).fields).toEqual({ size: 4 })
  })

  it('counts each relation and cuts a long one with the search that reads it all', () => {
    const members = Array.from({ length: 12 }, (_, i) => ({ blueprint: 'person', key: `p${i}` }))
    const c = card(entity({ relations: { members, lead: [{ blueprint: 'person', key: 'ada' }] } }), undefined, (r) => (r === 'members' ? 'person' : undefined))
    expect(c.relations.lead).toEqual({ count: 1, ids: ['person:ada'] })
    expect(c.relations.members!.count).toBe(12)
    expect(c.relations.members!.ids).toHaveLength(CARD_LINKS)
    expect(c.relations.members!.more).toEqual({ tool: 'search_entities', args: { blueprint: 'person', filter: { relation: '<-team:members', target: 'team:platform' } } })
  })
})

describe('links on one thing', () => {
  it('groups what it points at by relation, each cut with how to read the rest', () => {
    const ends = Array.from({ length: SHOWN_LINKS + 2 }, (_, i) => end('person', 'members', `p${i}`))
    const [g] = outgoingGroups({ blueprint: 'team', key: 'platform' }, ends)
    expect(g!.count).toBe(SHOWN_LINKS + 2)
    expect(g!.links).toHaveLength(SHOWN_LINKS)
    expect(g!.more?.args).toEqual({ blueprint: 'person', filter: { relation: '<-team:members', target: 'team:platform' } })
  })

  it('counts what points at it from the hub, not from the few it was sent', () => {
    const groups = incomingGroups({ blueprint: 'team', key: 'platform' }, [end('service', 'team', 'a'), end('service', 'team', 'b'), end('person', 'team', 'ada')], { 'service.team': 4000, 'person.team': 1 })
    expect(groups.map((g) => [g.blueprint, g.count, g.links.length, !!g.more])).toEqual([
      ['service', 4000, 2, true],
      ['person', 1, 1, false],
    ])
  })
})
