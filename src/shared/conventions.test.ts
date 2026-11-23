import { describe, expect, it } from 'vitest'
import { unmetConventions, type RelationConvention } from './conventions.ts'
import type { Blueprint } from './model.ts'

const platform: RelationConvention = { id: 'platform', groups: ['Cloud', 'Identity'], relations: ['platform_team', 'platform_owner'] }
const pair = { platform_team: { target: 'team' }, platform_owner: { target: 'person' } }
const bp = (id: string, group: string | undefined, relations: Blueprint['relations'] = {}): Pick<Blueprint, 'id' | 'group' | 'relations'> => ({ id, ...(group ? { group } : {}), relations })

describe('relation conventions', () => {
  it('names each blueprint of a held group that lacks a relation, with what it lacks', () => {
    const unmet = unmetConventions([platform], [bp('aws_account', 'Cloud'), bp('azure_storage', 'Cloud', pair), bp('entra_user', 'Identity', { platform_team: { target: 'team' } })])
    expect(unmet.map((u) => [u.blueprint, u.missing])).toEqual([
      ['aws_account', ['platform_team', 'platform_owner']],
      ['entra_user', ['platform_owner']],
    ])
  })

  it('holds no blueprint outside its groups, none with no group, and none of the hub own', () => {
    expect(unmetConventions([platform], [bp('team', 'Organization'), bp('note', undefined), bp('orrery_source', 'Cloud')])).toEqual([])
  })

  it('reads every convention on its own', () => {
    const steward: RelationConvention = { id: 'steward', groups: ['Identity'], relations: ['team'] }
    const unmet = unmetConventions([platform, steward], [bp('entra_user', 'Identity', pair)])
    expect(unmet.map((u) => [u.convention.id, u.blueprint, u.missing])).toEqual([['steward', 'entra_user', ['team']]])
  })
})
