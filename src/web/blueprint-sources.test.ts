import { describe, expect, it } from 'vitest'
import type { Blueprint, Source, SourceWrites } from '../shared/model.ts'
import { sourcesOf } from './blueprint-sources.ts'

const bp = (origin: Blueprint['origin'] = { kind: 'ui' }): Blueprint => ({ id: 'environment', title: 'Environment', fields: {}, relations: {}, origin }) as Blueprint
const source = (id: string, title: string, writes: Partial<SourceWrites> = {}, cls: Source['class'] = 'pusher'): Source =>
  ({ id, title, class: cls, writes: { entities: [], blueprints: [], actions: [], scorecards: [], ...writes } }) as Source

describe("a blueprint's sources", () => {
  it('says a blueprint made in the pages was made by hand', () => {
    expect(sourcesOf(bp(), [], undefined).defined).toBe('Made by hand in Orrery.')
  })

  it('names the source that brought it and the git file that defines it', () => {
    const azure = source('azure', 'Azure')
    expect(sourcesOf(bp({ kind: 'source', source: 'azure' }), [azure], undefined).defined).toBe('Brought by Azure, and changed here like any other.')
    expect(sourcesOf(bp({ kind: 'git', source: 'catalog', file: 'model/env.yaml' }), [], undefined).defined).toBe('Defined in git, in model/env.yaml of catalog.')
  })

  it('lists every source that added to its definition, newest first', () => {
    const list = [
      source('azure', 'Azure', { blueprints: [{ id: 'environment', lastAt: '2026-11-01T00:00:00Z' }, { id: 'other', lastAt: '2026-11-19T00:00:00Z' }] }),
      source('k8s', 'Kubernetes', { blueprints: [{ id: 'environment', lastAt: '2026-11-10T00:00:00Z' }] }),
    ]
    expect(sourcesOf(bp(), list, undefined).shapedBy.map((s) => s.id)).toEqual(['k8s', 'azure'])
  })

  it('lists who fills it, the biggest holder first, with a writer that owns none', () => {
    const list = [
      source('ui', 'Web app', { entities: [{ blueprint: 'environment', count: 8, lastAt: '2026-10-01T00:00:00Z' }] }, 'ui'),
      source('tagger', 'Tagger', { entities: [{ blueprint: 'environment', count: 40, lastAt: '2026-11-19T00:00:00Z' }] }),
    ]
    expect(sourcesOf(bp(), list, { ui: 8 }).filledBy).toEqual([
      { id: 'ui', title: 'Web app', byHand: true, holds: 8, wroteAt: '2026-10-01T00:00:00Z' },
      { id: 'tagger', title: 'Tagger', byHand: false, holds: 0, wroteAt: '2026-11-19T00:00:00Z' },
    ])
  })
})
