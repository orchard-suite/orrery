import type { TokenSummary } from '../shared/api.ts'
import type { Source, SourceClass } from '../shared/model.ts'

/** The order the source list groups by: the classes people register first, then what the hub keeps itself. */
const CLASS_ORDER: SourceClass[] = ['pusher', 'runner', 'event', 'git', 'hub', 'ui']

/** A source the hub keeps itself (the web app, the hub) has no key to give and no definition to change. */
export const ownedByHub = (source: Pick<Source, 'class'>): boolean => source.class === 'ui' || source.class === 'hub'

/** A source that cannot sign in without a key: one that pushes, runs checks, or takes webhooks. The hub pulls a git source, which needs a key only to ask for a pull. */
export const needsKey = (source: Pick<Source, 'class'>): boolean => source.class === 'pusher' || source.class === 'runner' || source.class === 'event'

/** The keys that write as one source. */
export const keysOf = (tokens: TokenSummary[], source: string): TokenSummary[] => tokens.filter((t) => t.kind === 'source' && t.source === source)

/** The keys no source holds: access keys, bound to a role, and personal keys, which act as their person. */
export const looseKeys = (tokens: TokenSummary[]): TokenSummary[] => tokens.filter((t) => t.kind !== 'source')

export interface SourceGroup {
  class: SourceClass
  /** `found` is the key a search found the source by, when the source itself did not hold the words. */
  sources: { source: Source; keys: number; found?: string }[]
}

export interface Shelves {
  groups: SourceGroup[]
  /** How many keys no source holds match the search: all of them with no search. */
  loose: number
}

const words = (q: string): string[] => q.toLowerCase().split(/\s+/).filter(Boolean)
const holds = (text: string, w: string[]): boolean => w.every((x) => text.includes(x))

/**
 * The source list, grouped by class, each with how many keys write as it. A search keeps a
 * source whose id, title, or class holds every word, or one of whose keys' names does, so a
 * key is found through the source it writes as. It counts the loose keys the same way.
 */
export function shelves(sources: Source[], tokens: TokenSummary[], q: string): Shelves {
  const w = words(q)
  const kept = sources.flatMap((source) => {
    const keys = keysOf(tokens, source.id)
    if (!w.length || holds(`${source.id} ${source.title} ${source.class}`.toLowerCase(), w)) return [{ source, keys }]
    const found = keys.find((k) => holds(k.name.toLowerCase(), w))
    return found ? [{ source, keys, found: found.name }] : []
  })
  const title = (s: Source) => (s.title || s.id).toLowerCase()
  const groups = CLASS_ORDER.map((c) => ({
    class: c,
    sources: kept
      .filter((x) => x.source.class === c)
      .sort((a, b) => title(a.source).localeCompare(title(b.source)))
      .map(({ source, keys, ...rest }) => ({ source, keys: keys.length, ...rest })),
  })).filter((g) => g.sources.length > 0)
  const loose = looseKeys(tokens).filter((t) => !w.length || holds(`${t.name} ${t.role ?? ''} ${t.owner ?? ''}`.toLowerCase(), w)).length
  return { groups, loose }
}
