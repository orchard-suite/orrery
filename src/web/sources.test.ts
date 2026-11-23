import { describe, expect, it } from 'vitest'
import type { TokenSummary } from '../shared/api.ts'
import type { Source } from '../shared/model.ts'
import { keysOf, looseKeys, needsKey, ownedByHub, shelves } from './sources.ts'

const src = (id: string, cls: Source['class'], title = id) => ({ id, title, class: cls }) as Source
const key = (name: string, kind: TokenSummary['kind'], bound: { source?: string; role?: string; owner?: string } = {}): TokenSummary => ({ id: name, name, kind, role: bound.role ?? null, source: bound.source ?? null, owner: bound.owner ?? null, createdAt: '', lastUsedAt: null })

const sources = [src('ui', 'ui', 'Web app'), src('dns', 'runner', 'DNS runner'), src('fw', 'pusher', 'beacon-firewall'), src('azure', 'pusher', 'Azure'), src('cat', 'git')]
const tokens = [key('fw c11s job', 'source', { source: 'fw' }), key('fw second', 'source', { source: 'fw' }), key('dns-runner', 'source', { source: 'dns' }), key('fw-read', 'access', { role: 'viewer' }), key('laptop', 'personal', { owner: 'a@example.com' })]

describe('the source list', () => {
  it('groups by class, pushers and runners first, each by title, with its key count', () => {
    const { groups, loose } = shelves(sources, tokens, '')
    expect(groups.map((g) => g.class)).toEqual(['pusher', 'runner', 'git', 'ui'])
    expect(groups[0]!.sources.map((s) => [s.source.id, s.keys])).toEqual([['azure', 0], ['fw', 2]])
    expect(loose).toBe(2)
  })

  it('finds a source by a key that writes as it, and counts the loose keys a search finds', () => {
    const { groups, loose } = shelves(sources, tokens, 'C11S')
    expect(groups.flatMap((g) => g.sources)).toEqual([{ source: sources[2], keys: 2, found: 'fw c11s job' }])
    expect(loose).toBe(0)
    expect(shelves(sources, tokens, 'viewer').loose).toBe(1)
  })

  it('needs every word, in any order', () => {
    expect(shelves(sources, tokens, 'runner dns').groups.flatMap((g) => g.sources.map((s) => s.source.id))).toEqual(['dns'])
    expect(shelves(sources, tokens, 'runner azure').groups).toEqual([])
  })
})

describe('keys', () => {
  it('splits keys that write as a source from those no source holds', () => {
    expect(keysOf(tokens, 'fw').map((t) => t.name)).toEqual(['fw c11s job', 'fw second'])
    expect(looseKeys(tokens).map((t) => t.kind)).toEqual(['access', 'personal'])
  })

  it('gives no key to what the hub keeps itself', () => {
    expect(ownedByHub(src('ui', 'ui'))).toBe(true)
    expect(ownedByHub(src('fw', 'pusher'))).toBe(false)
  })

  it('wants a key from what signs in, and not from a git source the hub pulls', () => {
    expect(['pusher', 'runner', 'event', 'git'].map((c) => needsKey(src('x', c as Source['class'])))).toEqual([true, true, true, false])
  })
})
