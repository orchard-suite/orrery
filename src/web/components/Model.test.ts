import { describe, expect, it } from 'vitest'
import type { Blueprint } from '../../shared/model.ts'
import { arrange, neighbours } from './Model.tsx'

const bp = (id: string, relations: Record<string, string> = {}): Blueprint => ({ id, title: id.toUpperCase(), fields: {}, relations: Object.fromEntries(Object.entries(relations).map(([k, target]) => [k, { target }])), origin: { kind: 'ui' }, updatedAt: '' })
const at = (...ids: string[]) => Object.fromEntries(ids.map((id, i) => [id, { x: i * 400, y: 0 }]))

describe('the lines on the model', () => {
  const all = [bp('pod', { workload: 'workload' }), bp('workload', { namespace: 'namespace' }), bp('namespace', { cluster: 'cluster' }), bp('cluster'), bp('team', { parent: 'team' })]

  it('bridges two shown blueprints that meet only through hidden ones, and names the way', () => {
    const shown = all.filter((b) => b.id === 'pod' || b.id === 'cluster')
    const { edges } = arrange(shown, all, at('pod', 'cluster'), new Set())
    expect(edges).toEqual([{ from: 'pod', to: 'cluster', title: 'via WORKLOAD, NAMESPACE', contain: false, bridge: true }])
  })

  it('draws no bridge where a relation already joins them', () => {
    const shown = all.filter((b) => b.id !== 'namespace')
    const { edges } = arrange(shown, all, at('pod', 'workload', 'cluster', 'team'), new Set())
    expect(edges.filter((e) => e.bridge)).toEqual([{ from: 'workload', to: 'cluster', title: 'via NAMESPACE', contain: false, bridge: true }])
  })

  it('keeps a relation from a blueprint to itself', () => {
    const { edges } = arrange([all[4]!], all, at('team'), new Set())
    expect(edges).toEqual([{ from: 'team', to: 'team', title: 'parent', contain: false, bridge: false }])
  })
})

describe('the card being edited', () => {
  it('lights what is one line away, either way, and nothing further', () => {
    const edges = [
      { from: 'pod', to: 'workload' },
      { from: 'workload', to: 'namespace' },
      { from: 'namespace', to: 'cluster' },
      { from: 'service', to: 'workload' },
    ]
    expect(neighbours('workload', edges)).toEqual(new Set(['workload', 'pod', 'namespace', 'service']))
  })
})
