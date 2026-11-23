import { describe, expect, it } from 'vitest'
import type { Blueprint } from '../../shared/model.ts'
import { toDraft, toSpec } from './BlueprintEditor.tsx'

describe('the blueprint editor', () => {
  it('saves back the parts of a blueprint its form does not edit', () => {
    const bp: Blueprint = {
      id: 'program',
      title: 'Program',
      origin: { kind: 'ui' },
      updatedAt: '',
      fields: {},
      relations: { parent: { target: 'program' } },
      ground: { guards: [] },
      map: { parts: 'parent', places: 'environment', plots: { blueprint: 'service', holder: 'program' }, members: [{ blueprint: 'database', holder: 'program', place: 'environment' }] },
    }
    const spec = toSpec(toDraft(bp))
    expect(spec.map).toEqual(bp.map)
    expect(spec.ground).toEqual(bp.ground)
  })
})
