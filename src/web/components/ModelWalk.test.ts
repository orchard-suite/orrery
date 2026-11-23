import { describe, expect, it } from 'vitest'
import type { Blueprint } from '../../shared/model.ts'
import { joinsOf } from './ModelWalk.tsx'

const bp = (id: string, relations: Blueprint['relations'] = {}): Blueprint => ({ id, title: id.toUpperCase(), fields: {}, relations, origin: { kind: 'ui' }, updatedAt: '' })

describe('what a blueprint is joined to on a phone', () => {
  const all = [
    bp('service', { repo: { target: 'repository', title: 'Homed in' }, team: { target: 'team' } }),
    bp('repository'),
    bp('team', { parent: { target: 'team' } }),
    bp('workload', { service: { target: 'service', inverseTitle: 'Runs as', many: true } }),
  ]

  it('names what it points at and what points at it, each by the title read from that end', () => {
    expect(joinsOf(all[0]!, all)).toEqual([
      { name: 'repo', title: 'Homed in', other: 'repository', direction: 'out', many: false },
      { name: 'team', title: 'team', other: 'team', direction: 'out', many: false },
      { name: 'service', title: 'Runs as', other: 'workload', direction: 'in', many: true },
    ])
  })

  it('keeps a relation to itself both ways', () => {
    expect(joinsOf(all[2]!, all).filter((j) => j.other === 'team').map((j) => j.direction)).toEqual(['out', 'in'])
  })
})
