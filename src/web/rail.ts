import { useState, useSyncExternalStore } from 'react'
import type { Route } from './router.ts'

/**
 * Whether the rail along the left of a desk is folded to its icons. A
 * person folds it for every page, and it stays as they left it in this
 * browser, like the theme. The model page brings its own blueprint list, so
 * the rail folds each time a person arrives there; opening it there lasts
 * only that visit and never changes their choice for the other pages.
 */
const KEY = 'orrery.rail'
const listeners = new Set<() => void>()

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === 'folded'
  } catch {
    return false
  }
}

let folded = typeof localStorage !== 'undefined' && read()

function choose(on: boolean): void {
  try {
    if (on) localStorage.setItem(KEY, 'folded')
    else localStorage.removeItem(KEY)
  } catch {
    // A browser that keeps nothing still folds for this page.
  }
  folded = on
  for (const fn of listeners) fn()
}

/** Whether the rail is folded on this page, and how to fold or open it. */
export function useRail(page: Route['page']): [boolean, (folded: boolean) => void] {
  const chosen = useSyncExternalStore((fn) => (listeners.add(fn), () => listeners.delete(fn)), () => folded, () => folded)
  const model = page === 'model'
  const [visit, setVisit] = useState(true)
  const [onModel, setOnModel] = useState(model)
  // Arriving at the model folds the rail again, whatever the last visit did.
  if (onModel !== model) {
    setOnModel(model)
    if (model) setVisit(true)
  }
  return model ? [visit, setVisit] : [chosen, choose]
}
