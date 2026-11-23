// A person's walk through a map, as a page reads it: which climbs are on it,
// what it grows, how far each stop has come, and what blooms when it is done.
// Pure: the map and the stops are given, and nothing here asks the hub.

import type { WalkStep, WalkStepRequest } from '../shared/api.ts'
import { inBloom, standingOf, type Lifts, type MapClimb, type MapLadder, type MapThing } from '../shared/map.ts'

/** The name a thing goes by in a stop: as a tick names it. */
const idOf = (t: Pick<MapThing, 'blueprint' | 'key'>) => `${t.blueprint}:${t.key}`

/** What every stop on a place grows: a thing it names, taken to the top of its ladder. With `also`, a climb not on the walk yet, as if it were. */
export function liftsOf<T extends Pick<MapThing, 'blueprint' | 'key'>>(steps: readonly WalkStep[], place: string | null, also: MapClimb<T> | null = null): Lifts<T> {
  const named = new Map<string, Set<string>>()
  for (const s of steps) if (s.place === place) for (const id of s.things) named.set(s.ladder, (named.get(s.ladder) ?? new Set()).add(id))
  const extra = also ? new Set(also.things.map(idOf)) : null
  return (thing, ladder) => !!named.get(ladder)?.has(idOf(thing)) || (!!extra && also!.ladder === ladder && extra.has(idOf(thing)))
}

/** The stop a climb makes on a place, kept to `scope` (a garden or a kind of open ground) or to the whole place. */
export const stepOf = <T extends Pick<MapThing, 'blueprint' | 'key'>>(climb: MapClimb<T>, place: string | null, scope: string | null): WalkStepRequest => ({ place, ladder: climb.ladder, from: climb.from, scope, things: climb.things.map(idOf) })

/** The stop on the walk that is this climb, kept to the same scope, or null when it is not on it. */
export const stopOn = (steps: readonly WalkStep[], climb: Pick<MapClimb<unknown>, 'ladder' | 'from'>, place: string | null, scope: string | null): WalkStep | null => steps.find((s) => s.place === place && s.ladder === climb.ladder && s.from === climb.from && s.scope === scope) ?? null

/** How far a stop has come: of the things it named that the reader still sees, how many stand at the top of its ladder now. Walked when all of them do. */
export function progressOf(step: WalkStep, things: ReadonlyMap<string, Pick<MapThing, 'checks'>>, ladder: MapLadder | undefined): { done: number; of: number; walked: boolean } {
  const here = step.things.flatMap((id) => things.get(id) ?? [])
  const done = ladder ? here.filter((t) => standingOf(t, ladder)?.stop === null).length : 0
  return { done, of: here.length, walked: here.length > 0 && done === here.length }
}

/** Says a climb in words: "Secure: Bronze to Gold", "Secure: below Bronze to Gold", or for a ladder of one rung, its name alone. */
export function climbText(climb: Pick<MapClimb<unknown>, 'from'>, ladder: MapLadder | undefined): string {
  if (!ladder) return 'A climb'
  if (ladder.rungs.length <= 1) return ladder.title
  const top = ladder.rungs.at(-1)!
  return `${ladder.title}: ${climb.from === 0 ? `below ${ladder.rungs[0]}` : ladder.rungs[climb.from - 1]} to ${top}`
}

/** The groups whose every checked thing is in full bloom under `lifts`, and was not without it: what a plan brings into bloom. */
export function bloomsWith<G extends { things: readonly T[] }, T extends Pick<MapThing, 'checks'>>(groups: readonly G[], ladders: readonly MapLadder[], before: Lifts<T>, after: Lifts<T>): G[] {
  const full = (g: G, lifts: Lifts<T>) => {
    const checked = g.things.filter((t) => t.checks.length > 0)
    return checked.length > 0 && checked.every((t) => inBloom(t, ladders, lifts))
  }
  return groups.filter((g) => !full(g, before) && full(g, after))
}
