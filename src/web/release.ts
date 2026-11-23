// Which release of the hub this page was built for, and a newer one when the
// event stream finds the hub now serving another.

import { useSyncExternalStore } from 'react'

/** The release this page's code was built from. */
export const BUILT = import.meta.env.VITE_ORRERY_VERSION

let newer: string | null = null
const listeners = new Set<() => void>()

/** Notes the release the hub serving the event stream reports. */
export function noteServed(version: string, built = BUILT): void {
  const next = version === built ? null : version
  if (next === newer) return
  newer = next
  for (const listener of listeners) listener()
}

/** The release the hub now serves when it is not the one this page runs, else null. */
export function newRelease(): string | null {
  return newer
}

export function useNewRelease(): string | null {
  return useSyncExternalStore((listener) => (listeners.add(listener), () => listeners.delete(listener)), newRelease, () => null)
}
