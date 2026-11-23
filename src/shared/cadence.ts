// When a schedule fires: once at a moment, every hour at a minute, every few
// hours from a time, every day at a time, or on some days of the week at a
// time, in a time zone. A shape a person picks from
// a form rather than a cron line, read the same way in the browser and on the
// hub, and summed into how often it fires so its load can be known before it
// is approved.

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const
export type Weekday = (typeof WEEKDAYS)[number]

/** The steps "every few hours" takes: each divides a day, so it fires at the same times every day. */
export const HOUR_STEPS = [2, 3, 4, 6, 8, 12] as const

export type Cadence =
  /** Once, at `on`: a moment, as an ISO string. `tz` is where the person meant it, for its words. A run put off until then. */
  | { every: 'once'; on: string; tz: string }
  /** Every hour, at `minute` past. */
  | { every: 'hour'; minute: number; tz: string }
  /** Every `hours` hours, from `at`, as HH:MM in `tz`: the same times every day. */
  | { every: 'hours'; hours: number; at: string; tz: string }
  /** Every day at `at`, as HH:MM in `tz`. */
  | { every: 'day'; at: string; tz: string }
  /** On each of `days`, at `at`, as HH:MM in `tz`. */
  | { every: 'week'; days: Weekday[]; at: string; tz: string }

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/

/** A cadence that fires again and again: every one but `once`. */
export type Repeating = Exclude<Cadence, { every: 'once' }>

/** Whether a cadence fires once only. A schedule that fires once is a run put off, and asks nobody's approval. */
export const isOnce = (c: Cadence): c is Extract<Cadence, { every: 'once' }> => c.every === 'once'

/** Why a cadence cannot be used, or null when it can. */
export function cadenceProblem(c: Cadence): string | null {
  if (!validZone(c.tz)) return `"${c.tz}" is not a time zone`
  if (c.every === 'once') return Number.isNaN(Date.parse(c.on)) ? 'the moment is a date and time, such as 2026-11-16T08:00:00Z' : null
  if (c.every === 'hour') return Number.isInteger(c.minute) && c.minute >= 0 && c.minute <= 59 ? null : 'the minute is 0 to 59'
  if (!HHMM.test(c.at)) return 'the time is HH:MM, on a 24-hour clock'
  if (c.every === 'hours' && !(HOUR_STEPS as readonly number[]).includes(c.hours)) return `the hours between firings are one of ${HOUR_STEPS.join(', ')}`
  if (c.every === 'week' && (!c.days.length || c.days.some((d) => !WEEKDAYS.includes(d)))) return 'name at least one day of the week'
  return null
}

function validZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/** How many times it fires in a day, on average over a week. Once is no part of an average day. */
export function firesPerDay(c: Cadence): number {
  if (c.every === 'once') return 0
  if (c.every === 'hour') return 24
  if (c.every === 'hours') return 24 / c.hours
  if (c.every === 'day') return 1
  return new Set(c.days).size / 7
}

/** The shortest gap between two firings, in milliseconds: none for once. */
export function shortestGapMs(c: Cadence): number {
  if (c.every === 'once') return Number.POSITIVE_INFINITY
  if (c.every === 'hour') return 3_600_000
  if (c.every === 'hours') return c.hours * 3_600_000
  if (c.every === 'day') return 86_400_000
  const days = [...new Set(c.days)].map((d) => WEEKDAYS.indexOf(d)).sort((a, b) => a - b)
  if (days.length === 1) return 7 * 86_400_000
  const gaps = days.map((d, i) => ((days[(i + 1) % days.length]! - d + 7) % 7 || 7) * 86_400_000)
  return Math.min(...gaps)
}

/** The wall clock of a moment in a time zone. */
function wall(at: Date, tz: string): { y: number; m: number; d: number; h: number; min: number; wd: Weekday } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  )
  return { y: Number(parts.year), m: Number(parts.month), d: Number(parts.day), h: Number(parts.hour), min: Number(parts.minute), wd: String(parts.weekday).toLowerCase().slice(0, 3) as Weekday }
}

/** The moment a wall clock time in a time zone falls at: found from the zone's offset at that time, checked once more across a shift. */
function moment(y: number, m: number, d: number, h: number, min: number, tz: string): Date {
  const guess = Date.UTC(y, m - 1, d, h, min)
  const offset = (t: number) => {
    const w = wall(new Date(t), tz)
    return Date.UTC(w.y, w.m - 1, w.d, w.h, w.min) - t
  }
  const first = guess - offset(guess)
  return new Date(guess - offset(first))
}

/** The times of day it fires, as [hour, minute], earliest first. */
function timesOfDay(c: Exclude<Repeating, { every: 'hour' }>): [number, number][] {
  const [hh, mm] = c.at.split(':').map(Number) as [number, number]
  if (c.every !== 'hours') return [[hh, mm]]
  return Array.from({ length: 24 / c.hours }, (_, k) => (hh + k * c.hours) % 24)
    .sort((a, b) => a - b)
    .map((h) => [h, mm])
}

/** The first firing strictly after `after`, or null when there is none: once, after its moment. */
export function nextFiring(c: Cadence, after: Date): Date | null {
  if (c.every === 'once') {
    const on = new Date(c.on)
    return on.getTime() > after.getTime() ? on : null
  }
  const start = new Date(Math.floor(after.getTime() / 60_000) * 60_000 + 60_000)
  if (c.every === 'hour') {
    const w = wall(start, c.tz)
    let at = moment(w.y, w.m, w.d, w.h, c.minute, c.tz)
    if (at.getTime() < start.getTime()) at = new Date(at.getTime() + 3_600_000)
    return at
  }
  const times = timesOfDay(c)
  for (let i = 0; i < 8; i++) {
    const day = new Date(start.getTime() + i * 86_400_000)
    const w = wall(day, c.tz)
    if (c.every === 'week' && !c.days.includes(w.wd)) continue
    for (const [hh, mm] of times) {
      const at = moment(w.y, w.m, w.d, hh, mm, c.tz)
      if (at.getTime() >= start.getTime()) return at
    }
  }
  throw new Error('No firing within a week: the cadence names no day')
}

const DAY_WORD: Record<Weekday, string> = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' }

/** A time of day on a 12-hour clock, as the app says every other time: 6:00 AM, 2:05 PM. */
function clock(h: number, m: number): string {
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`
}

/** The cadence in words: "every day at 6:00 AM (America/Chicago)", "every 6 hours, at 2:05 AM, 8:05 AM, 2:05 PM, 8:05 PM (UTC)", or "once, on Mon, Nov 16, 2026 at 2:00 AM (America/Chicago)". */
export function cadenceWords(c: Cadence): string {
  if (c.every === 'once') {
    const w = wall(new Date(c.on), c.tz)
    const day = new Intl.DateTimeFormat('en-US', { timeZone: c.tz, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(c.on))
    return `once, on ${day} at ${clock(w.h, w.min)} (${c.tz})`
  }
  if (c.every === 'hour') return `every hour at ${String(c.minute).padStart(2, '0')} past (${c.tz})`
  if (c.every === 'hours') return `every ${c.hours} hours, at ${timesOfDay(c).map(([h, m]) => clock(h, m)).join(', ')} (${c.tz})`
  const [h, m] = c.at.split(':').map(Number) as [number, number]
  if (c.every === 'day') return `every day at ${clock(h, m)} (${c.tz})`
  const days = WEEKDAYS.filter((d) => c.days.includes(d))
  const named = days.length === 5 && !days.includes('sat') && !days.includes('sun') ? 'weekdays' : days.map((d) => DAY_WORD[d]).join(', ')
  return `${named} at ${clock(h, m)} (${c.tz})`
}

/** How many times it fires in each hour of the day, in UTC, on an average day: a week of firings from `from`, over seven. */
export function firingsByHour(c: Cadence, from: Date): number[] {
  const hours = Array.from({ length: 24 }, () => 0)
  const end = from.getTime() + 7 * 86_400_000
  for (let at = nextFiring(c, from); at && at.getTime() <= end; at = nextFiring(c, at)) hours[at.getUTCHours()]! += 1
  return hours.map((n) => n / 7)
}
