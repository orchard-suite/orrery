// A person's preferences: what the hub keeps for one person because it is
// theirs on every device, not this browser's. Each one is named here and
// nowhere else; the hub refuses a name this registry does not hold and a
// value its `read` does not take. What is about one screen or one device (the
// theme, a panel's width) stays in that browser, and what a page is doing
// right now is kept nowhere.

import { knownZone } from './day.ts'

/** One preference: what it is for, the value a person who never set it has, and how a stored or sent value is read. */
interface PreferenceDef<T> {
  description: string
  fallback: T
  /** The value, or undefined when it is not one this preference takes. */
  read: (value: unknown) => T | undefined
}

/** A release as the hub names it: `1.50.0`. */
const RELEASE = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/

const welcomed: PreferenceDef<number> = {
  description: 'The version of the welcome tour the person last finished or skipped. A tour whose version is higher is shown to them again.',
  fallback: 0,
  read: (v) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 1_000_000 ? v : undefined),
}

const release: PreferenceDef<string | null> = {
  description: 'The release of the hub whose notes the person last saw. Null until they first finish the tour or close the notes.',
  fallback: null,
  read: (v) => (v === null || (typeof v === 'string' && RELEASE.test(v)) ? v : undefined),
}

const timeZone: PreferenceDef<string | null> = {
  description: "The time zone of the person's own clock, such as America/Chicago, as the browser they last used says it. What speaks for them where no browser is, such as an agent, reads their day from it. Null until a browser of theirs has said.",
  fallback: null,
  read: (v) => (v === null || (typeof v === 'string' && v.length <= 64 && knownZone(v)) ? v : undefined),
}

export const PREFERENCES = { welcomed, release, timeZone } as const

export type PreferenceName = keyof typeof PREFERENCES
export const PREFERENCE_NAMES = Object.keys(PREFERENCES) as PreferenceName[]
export type PreferenceValues = { [K in PreferenceName]: (typeof PREFERENCES)[K]['fallback'] }

export const isPreferenceName = (name: string): name is PreferenceName => Object.hasOwn(PREFERENCES, name)

/** Every preference of a person from what is stored, each stored value that no longer reads taking its fallback. */
export function preferencesOf(stored: Record<string, unknown>): PreferenceValues {
  const values: Record<string, unknown> = {}
  for (const name of PREFERENCE_NAMES) {
    const def: PreferenceDef<unknown> = PREFERENCES[name]
    values[name] = name in stored ? (def.read(stored[name]) ?? def.fallback) : def.fallback
  }
  return values as PreferenceValues
}

/** Orders two releases: negative when `a` came first. A name that is not a release orders before every release. */
export function compareReleases(a: string | null, b: string | null): number {
  const parts = (v: string | null) => (v && RELEASE.test(v) ? v.split('.').map(Number) : null)
  const x = parts(a)
  const y = parts(b)
  if (!x || !y) return (x ? 1 : 0) - (y ? 1 : 0)
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!
  return 0
}
