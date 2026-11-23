import { describe, expect, it } from 'vitest'
import type { Blueprint } from '../../shared/model.ts'
import type { AccessPolicy, EditRule } from '../../shared/policy.ts'
import type { EditBlueprint } from '../../shared/posture.ts'
import { narrowed, reachWords, ruleOpens, ruleWho, totals } from './security-edits.ts'

const bp = (id: string, counts: Partial<EditBlueprint['counts']>, names: string[] = []): EditBlueprint => ({
  id,
  title: id,
  group: null,
  entities: 1,
  counts: { rule: 0, holders: 0, admin: 0, source: 0, derived: 0, ...counts },
  names: names.map((name) => ({ name, title: name, kind: 'field', authority: 'holders', why: '', rules: [] })),
})

describe('the who edits tab', () => {
  it('adds every blueprint up', () => {
    expect(totals([bp('a', { rule: 2, source: 1 }), bp('b', { rule: 1, admin: 4 })])).toEqual({ rule: 3, holders: 0, admin: 4, source: 1, derived: 0 })
  })

  it('narrows by text, in a blueprint or a name, and by authority', () => {
    const list = [bp('service', { rule: 1 }, ['description']), bp('device', { source: 3 }, ['serial'])]
    expect(narrowed(list, 'serial', null).map((b) => b.id)).toEqual(['device'])
    expect(narrowed(list, 'SERV', null).map((b) => b.id)).toEqual(['service'])
    expect(narrowed(list, '', 'source').map((b) => b.id)).toEqual(['device'])
    expect(narrowed(list, 'description', 'source')).toEqual([])
  })

  const model = [
    {
      id: 'service',
      title: 'Service',
      fields: { description: { type: 'string' }, serial: { type: 'string', overridable: false }, count: { type: 'number', calculation: '1' }, pid: { type: 'string', adminEdit: true } },
      relations: { owner: { target: 'person' }, depends_on: { target: 'service', many: true } },
      decides: { all: false, names: ['owner'] },
    },
    { id: 'orrery_source', title: 'Source', fields: { description: { type: 'string' } }, relations: {} },
    { id: 'device', title: 'Device', fields: { description: { type: 'string' } }, relations: {} },
  ] as unknown as Blueprint[]

  it('says what a rule would open, and what it names that no rule opens', () => {
    const opens = ruleOpens({ blueprints: ['serv*', 'orrery_*'], fields: ['*'], relations: ['owner', 'depends_on'] }, model)
    expect(opens).toEqual([
      {
        blueprint: 'service',
        title: 'Service',
        fields: ['description', 'title', 'icon'],
        relations: ['depends_on'],
        never: [
          { name: 'serial', why: 'locked to its sources' },
          { name: 'count', why: 'the hub works it out' },
          { name: 'pid', why: 'an admin marked it' },
          { name: 'owner', why: 'access is decided from it' },
        ],
      },
    ])
  })

  it('says who a rule lets in', () => {
    const policy: AccessPolicy = { audiences: [{ id: 'desk', title: 'Desk', people: [], grants: [], audiences: [] }], classes: [], edits: [] }
    const rule: EditRule = { id: 'r', title: 'R', blueprints: ['service'], fields: ['description'], relations: [], audiences: ['desk'], owned: { through: ['program'], roles: ['owner'] } }
    expect(ruleWho(rule, policy)).toBe('the Desk audience, on every entity and the owners of the entity as owner, or of what it points at through program')
    expect(ruleWho({ ...rule, audiences: [], owned: { through: [], roles: [] } }, policy)).toBe('the owners of the entity')
  })

  it('says how a rule reaches a person', () => {
    expect(reachWords({ rule: 'r', how: 'audience', entities: 0, through: [], fields: [], relations: [] })).toBe('on every one')
    expect(reachWords({ rule: 'r', how: 'owner', entities: 3, through: ['program'], fields: [], relations: [] })).toBe('on 3 of their own, and on what points at theirs through program')
  })
})
