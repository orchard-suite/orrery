// Who stands behind a blueprint, for its Sources tab: where it was defined,
// which sources added to its definition, and which fill it with entities.

import type { Blueprint, BlueprintOrigin, Source } from '../shared/model.ts'

/** A source that added to a blueprint's definition, and when it last did. */
export interface Shaper {
  id: string
  title: string
  at: string
}

/** A source that writes a blueprint's entities: how many it owns now, and when it last wrote one. */
export interface Filler {
  id: string
  title: string
  byHand: boolean
  holds: number
  wroteAt: string | null
}

export interface BlueprintSources {
  defined: string
  shapedBy: Shaper[]
  filledBy: Filler[]
}

const titleOf = (sources: Map<string, Source>, id: string) => sources.get(id)?.title ?? id

/** Where a blueprint's definition came from, said as a sentence. */
export function definedBy(origin: BlueprintOrigin, sources: Map<string, Source>): string {
  if (origin.kind === 'git') return `Defined in git, in ${origin.file} of ${titleOf(sources, origin.source)}.`
  if (origin.kind === 'source') return `Brought by ${titleOf(sources, origin.source)}, and changed here like any other.`
  if (origin.kind === 'hub') return 'Built into the hub.'
  return 'Made by hand in Orrery.'
}

/**
 * Who stands behind one blueprint. `held` is how many active entities each
 * source owns of it; a source that wrote some but owns none still fills it,
 * since it writes values on entities another source owns.
 */
export function sourcesOf(bp: Blueprint, list: Source[], held: Record<string, number> | undefined): BlueprintSources {
  const sources = new Map(list.map((s) => [s.id, s]))
  const shapedBy = list
    .flatMap((s) => s.writes.blueprints.filter((w) => w.id === bp.id).map((w) => ({ id: s.id, title: s.title, at: w.lastAt })))
    .sort((a, b) => b.at.localeCompare(a.at))
  const wrote = new Map(list.flatMap((s) => s.writes.entities.filter((w) => w.blueprint === bp.id).map((w) => [s.id, w.lastAt] as const)))
  const ids = new Set([...Object.keys(held ?? {}), ...wrote.keys()])
  const filledBy = [...ids]
    .map((id) => ({ id, title: titleOf(sources, id), byHand: sources.get(id)?.class === 'ui', holds: held?.[id] ?? 0, wroteAt: wrote.get(id) ?? null }))
    .sort((a, b) => b.holds - a.holds || (b.wroteAt ?? '').localeCompare(a.wroteAt ?? '') || a.title.localeCompare(b.title))
  return { defined: definedBy(bp.origin, sources), shapedBy, filledBy }
}
