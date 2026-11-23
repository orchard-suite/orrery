// The places on the page the welcome tour points at. A component marks one
// with `spot`, and the tour finds it by that mark: `SPOTS` in
// src/shared/welcome.ts is the one list of names, and a test holds every
// name to a mark here in the web app.

import type { SpotName } from '../shared/welcome.ts'

export const SPOT_ATTRIBUTE = 'data-spot'

/** Marks an element as a place the tour points at. */
export const spot = (name: SpotName) => ({ [SPOT_ATTRIBUTE]: name })

/** The element drawn for a spot that a person can see now, or null. One the screen does not draw, such as the rail on a phone, is none. */
export function findSpot(name: SpotName): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>(`[${SPOT_ATTRIBUTE}="${name}"]`)) {
    const box = el.getBoundingClientRect()
    if (box.width > 0 && box.height > 0) return el
  }
  return null
}
