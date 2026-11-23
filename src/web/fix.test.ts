import { describe, expect, it } from 'vitest'
import type { Blueprint } from '../shared/model.ts'
import { fixField, whyNotYours } from './fix.ts'

const bp = { fields: { description: { type: 'string' }, apis: { type: 'number', aggregation: { fn: 'count', path: '<-service' } } } } as unknown as Blueprint

describe('a rule one value would mend', () => {
  it('names the field a single test reads', () => {
    expect(fixField({ field: 'description', op: 'exists' }, bp)).toBe('description')
    expect(fixField({ not: { field: 'description', op: 'eq', value: '' } }, bp)).toBe('description')
  })

  it('names none for a derived value, a relation, several tests, or what is no field', () => {
    expect(fixField({ field: 'apis', op: 'gt', value: 0 }, bp)).toBeNull()
    expect(fixField({ relation: 'team' }, bp)).toBeNull()
    expect(fixField({ and: [{ field: 'description', op: 'exists' }] }, bp)).toBeNull()
    expect(fixField({ field: '$status', op: 'eq', value: 'green' }, bp)).toBeNull()
    expect(fixField({ field: 'description', op: 'exists' }, undefined)).toBeNull()
  })

  it('says why a value is not the reader\'s, and where it is changed', () => {
    expect(whyNotYours('Locked: only sources write this field', undefined, null)).toBe('Locked: only sources write this field')
    expect(whyNotYours('', { layer: 'git', source: 'catalog', file: 'services.yaml' }, 'x')).toBe('Set in git (services.yaml): change it there')
    expect(whyNotYours('', { layer: 'pushed', source: 'forge' }, 'x')).toBe('Comes from forge: change it there')
    expect(whyNotYours('', { layer: 'pushed', source: 'forge' }, '')).toBe('Not yours to change: its owner or an admin can')
    expect(whyNotYours('', undefined, null)).toBe('Not yours to change: its owner or an admin can')
  })
})
