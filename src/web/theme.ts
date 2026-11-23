import { useSyncExternalStore } from 'react'

/** The two looks of the app. Dark is the default; light swaps the colour tokens in `styles.css` through `data-theme` on the root. */
export type Theme = 'dark' | 'light'

const KEY = 'orrery.theme'
const listeners = new Set<() => void>()

function read(): Theme {
  return typeof localStorage !== 'undefined' && localStorage.getItem(KEY) === 'light' ? 'light' : 'dark'
}

export function setTheme(theme: Theme): void {
  localStorage.setItem(KEY, theme)
  document.documentElement.dataset.theme = theme
  for (const fn of listeners) fn()
}

/** The theme this browser keeps. It is a device preference, so it is never shared. */
export function useTheme(): Theme {
  return useSyncExternalStore((fn) => (listeners.add(fn), () => listeners.delete(fn)), read, read)
}
