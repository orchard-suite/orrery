import { useSyncExternalStore } from 'react'

/**
 * Zen mode: the estate to enjoy, without the alarm. The whole app takes
 * quiet colours (`data-zen` in `styles.css`); where a person browses (the
 * rail, the grid, search, an entity) the status lamps and words go; and Now
 * speaks of the estate, not of what fails. The pages made to show health
 * (the wall, scorecards, sources, security) still show it, in the
 * quiet colours. It is a device preference, like the theme, so it is never
 * shared.
 */
const KEY = 'orrery.zen'
const listeners = new Set<() => void>()

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === 'on'
  } catch {
    return false
  }
}

export function setZen(on: boolean): void {
  try {
    if (on) localStorage.setItem(KEY, 'on')
    else localStorage.removeItem(KEY)
  } catch {
    // A browser that keeps nothing still switches for this page.
  }
  zen = on
  mark()
  for (const fn of listeners) fn()
}

let zen = typeof localStorage !== 'undefined' && read()

/** `data-zen` on the root swaps the colour tokens in `styles.css` for their quiet ones. */
function mark(): void {
  if (typeof document === 'undefined') return
  if (zen) document.documentElement.dataset.zen = ''
  else delete document.documentElement.dataset.zen
}
mark()

/** Whether this browser is in zen mode. */
export function useZen(): boolean {
  return useSyncExternalStore((fn) => (listeners.add(fn), () => listeners.delete(fn)), () => zen, () => zen)
}
