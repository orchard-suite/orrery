// The day a person means by "today": theirs, in their own time zone.

/** True when `tz` is a time zone this runtime knows, such as America/Chicago. */
export function knownZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/** The clock in `tz` at `at`, as the whole numbers of a date and a time. */
function wall(at: Date, tz: string): { y: number; m: number; d: number; h: number; min: number; s: number } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(at).map((p) => [p.type, Number(p.value)]))
  return { y: parts.year!, m: parts.month!, d: parts.day!, h: parts.hour!, min: parts.minute!, s: parts.second! }
}

/**
 * The day `at` falls on in `tz`: its date there, and the moment it began. The
 * moment is found from the zone's offset at `at` and checked against the
 * offset at the answer, so a day a clock change falls in still starts at its
 * own midnight.
 */
export function dayOf(at: Date, tz: string): { date: string; startedAt: Date } {
  const offset = (when: Date): number => {
    const w = wall(when, tz)
    return Date.UTC(w.y, w.m - 1, w.d, w.h, w.min, w.s) - Math.floor(when.getTime() / 1000) * 1000
  }
  const w = wall(at, tz)
  const midnight = Date.UTC(w.y, w.m - 1, w.d)
  let started = new Date(midnight - offset(at))
  started = new Date(midnight - offset(started))
  const pad = (n: number) => String(n).padStart(2, '0')
  return { date: `${w.y}-${pad(w.m)}-${pad(w.d)}`, startedAt: started }
}
