import { describe, expect, it } from 'vitest'
import { audienceGrants, classFor, fieldRule, policyProblems, resolveRule, withCurrentIds, type AccessPolicy } from './policy.ts'

const policy: AccessPolicy = {
  audiences: [
    { id: 'platform', title: 'Platform', people: [], grants: [{ path: 'department', values: ['platform'] }], audiences: [] },
    { id: 'ops', title: 'IT operations', people: ['Lead@Example.org', 'boss@example.org'], grants: [], audiences: ['platform'] },
    { id: 'cost', title: 'Cost', people: ['lead@example.org', 'finance@example.org'], grants: [], audiences: [] },
  ],
  classes: [
    { id: 'cost', title: 'Cost', audiences: ['cost'], match: ['cost_*', '*_cents'], include: ['project.budget'], exclude: [{ field: 'invoice.tax_cents', reason: 'public by law' }] },
    { id: 'contact', title: 'Contact', audiences: ['ops'], match: ['*email*'], blueprints: ['person'], include: [], exclude: [] },
  ],
  edits: [],
}

describe('an audience', () => {
  it('holds its people as one grant, then its grants, then the audiences it holds', () => {
    expect(audienceGrants(policy, ['ops'])).toEqual([{ values: ['boss@example.org', 'lead@example.org'] }, { path: 'department', values: ['platform'] }])
  })

  it('lets nobody in when it does not exist, and walks a loop once', () => {
    expect(audienceGrants(policy, ['nobody'])).toEqual([])
    const loop: AccessPolicy = { audiences: [{ id: 'a', title: 'A', people: ['x@example.org'], grants: [], audiences: ['b'] }, { id: 'b', title: 'B', people: [], grants: [], audiences: ['a'] }], classes: [], edits: [] }
    expect(audienceGrants(loop, ['a'])).toEqual([{ values: ['x@example.org'] }])
    expect(policyProblems(loop)).toContain('Audiences hold each other in a loop: a → b → a')
  })

  it('is expanded inside a rule, and no rule is open', () => {
    expect(resolveRule(policy, undefined)).toBeNull()
    expect(resolveRule(policy, { grants: [{ path: 'team', values: ['desk'] }], audiences: ['cost'] })).toEqual([{ path: 'team', values: ['desk'] }, { values: ['finance@example.org', 'lead@example.org'] }])
    // A rule naming an audience nobody is in is still a rule: admins alone.
    expect(resolveRule(policy, { grants: [], audiences: ['nobody'] })).toEqual([])
  })
})

describe('a field class', () => {
  it('matches by pattern on any blueprint, by name, and never on the hub\'s own', () => {
    expect(classFor(policy, 'azure_vm', 'cost_month_to_date_cents')?.id).toBe('cost')
    expect(classFor(policy, 'invoice', 'TOTAL_CENTS')?.id).toBe('cost')
    expect(classFor(policy, 'project', 'budget')?.id).toBe('cost')
    expect(classFor(policy, 'azure_vm', 'name')).toBeNull()
    expect(classFor(policy, 'orrery_source', 'cost_cents')).toBeNull()
  })

  it('leaves out an excluded field, and narrows to the blueprints it names', () => {
    expect(classFor(policy, 'invoice', 'tax_cents')).toBeNull()
    expect(classFor(policy, 'person', 'manager_email')?.id).toBe('contact')
    expect(classFor(policy, 'repository', 'last_committer_email')).toBeNull()
  })

  it('decides the field\'s rule over the field\'s own', () => {
    expect(fieldRule(policy, 'azure_vm', 'cost_cents', { grants: [{ values: ['someone@example.org'] }] })).toEqual({ grants: [], audiences: ['cost'] })
    expect(fieldRule(policy, 'azure_vm', 'name', { grants: [{ values: ['someone@example.org'] }] })).toEqual({ grants: [{ values: ['someone@example.org'] }] })
  })

  it('follows a renamed blueprint it names', () => {
    const renamed = withCurrentIds(policy, (id) => (id === 'project' ? 'program' : id === 'person' ? 'user' : id))
    expect(classFor(renamed, 'program', 'budget')?.id).toBe('cost')
    expect(classFor(renamed, 'user', 'email')?.id).toBe('contact')
  })

  it('must name an audience that exists, and a field it can match', () => {
    const bad: AccessPolicy = { audiences: [], classes: [{ id: 'cost', title: 'Cost', audiences: ['money'], match: [], include: ['nodot'], exclude: [{ field: 'a.b', reason: ' ' }] }], edits: [] }
    expect(policyProblems(bad)).toEqual([
      'Class "cost" names an audience that does not exist: "money"',
      'Class "cost": "nodot" is not blueprint.field',
      'Class "cost": leaving out a.b needs a reason',
    ])
    expect(policyProblems({ audiences: policy.audiences, classes: [{ id: 'empty', title: 'Empty', audiences: ['ops'], match: [], include: [], exclude: [] }], edits: [] })).toEqual(['Class "empty" matches no field: give it a pattern or a field'])
    expect(policyProblems(policy)).toEqual([])
  })
})
