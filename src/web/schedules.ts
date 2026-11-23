// What the Schedules page works out of the schedules and their firings: how a
// firing went, the lanes by state, the tally over a window, the firings still
// to come, and the runner minutes by hour, measured and planned. Pure, and
// tested alone; the components only draw it.

import type { ActionSchedule, ScheduleDay, ScheduleFiring, ScheduleState } from '../shared/api.ts'
import type { ActionRunState } from '../shared/model.ts'
import { nextFiring, type Cadence } from '../shared/cadence.ts'

const HOUR = 3_600_000

/** How a firing went, in one word the page colours: every run succeeded, some or most failed, some still open, every one stopped, or it asked nothing. */
export type Outcome = 'ok' | 'some' | 'most' | 'open' | 'stopped' | 'error'

export function outcomeOf(f: ScheduleFiring): Outcome {
  if (f.error) return 'error'
  if (f.open) return 'open'
  if (f.failed && f.failed * 2 >= f.runs) return 'most'
  if (f.failed) return 'some'
  if (!f.succeeded) return 'stopped'
  return 'ok'
}

export const OUTCOME_WORD: Record<Outcome, string> = { ok: 'every run succeeded', some: 'some runs failed', most: 'half or more failed', open: 'still running', stopped: 'stopped before it ran', error: 'asked nothing' }
export const OUTCOME_FILL: Record<Outcome, string> = { ok: 'var(--color-green)', some: 'var(--color-amber)', most: 'var(--color-red)', open: 'var(--color-orbit)', stopped: 'var(--color-ink-500)', error: 'var(--color-red)' }
/** A firing that asked nothing took no runner time: it is drawn hollow, in its colour, so it never reads as one that ran and failed. */
export const HOLLOW: ReadonlySet<Outcome> = new Set(['error'])

/** A schedule asks one run each time, or a batch: on the entities picked, on what a filter matches, or on what a saved query matches. */
export const isBatch = (s: Pick<ActionSchedule, 'target'>): boolean => !!(s.target.query || s.target.entities || s.target.matching)

/** Why a schedule stands where it does, said for its owner: who paused or declined it, or that the hub stopped it and why. Null when nothing is to be said. */
export function standing(s: Pick<ActionSchedule, 'state' | 'note' | 'decidedBy'>): string | null {
  if (s.state === 'declined') return `Declined${s.decidedBy ? ` by ${s.decidedBy}` : ''}${s.note ? `: ${s.note}` : '.'}`
  if (!s.note) return null
  if (s.state === 'paused') return /^paused by /.test(s.note) ? `${s.note[0]!.toUpperCase()}${s.note.slice(1)}.` : `The hub paused it: ${s.note}.`
  return `${s.note[0]!.toUpperCase()}${s.note.slice(1)}${/[.!?]$/.test(s.note) ? '' : '.'}`
}

/** The order of the lanes, and what each is called. */
export const LANES: { state: ScheduleState; title: string }[] = [
  { state: 'awaiting', title: 'Waiting for approval' },
  { state: 'active', title: 'Active' },
  { state: 'paused', title: 'Paused' },
  { state: 'declined', title: 'Declined' },
  { state: 'done', title: 'Fired once' },
]

/** The schedules in lanes by state, in `LANES` order, leaving out an empty one. A running lane puts the next to fire first; the rest put the newest change first. */
export function lanesOf(schedules: ActionSchedule[]): { state: ScheduleState; title: string; schedules: ActionSchedule[] }[] {
  return LANES.map((l) => ({
    ...l,
    schedules: schedules.filter((s) => s.state === l.state).sort((a, b) => (l.state === 'active' ? (a.nextAt ?? '').localeCompare(b.nextAt ?? '') : b.updatedAt.localeCompare(a.updatedAt)) || a.title.localeCompare(b.title)),
  })).filter((l) => l.schedules.length)
}

export interface Tally {
  schedules: number
  states: Record<ScheduleState, number>
  firings: number
  /** Firings that asked nothing. */
  errors: number
  runs: number
  succeeded: number
  failed: number
  open: number
  seconds: number
  /** The same, for the schedules that run one at a time and those that run a batch. */
  single: { schedules: number; firings: number; runs: number; seconds: number }
  batch: { schedules: number; firings: number; runs: number; seconds: number }
}

/** Everything the page counts, over the schedules shown and their firings. */
export function tally(schedules: ActionSchedule[], firings: ScheduleFiring[]): Tally {
  const kind = new Map(schedules.map((s) => [s.id, isBatch(s) ? ('batch' as const) : ('single' as const)]))
  const t: Tally = { schedules: schedules.length, states: { awaiting: 0, active: 0, paused: 0, declined: 0, done: 0 }, firings: 0, errors: 0, runs: 0, succeeded: 0, failed: 0, open: 0, seconds: 0, single: { schedules: 0, firings: 0, runs: 0, seconds: 0 }, batch: { schedules: 0, firings: 0, runs: 0, seconds: 0 } }
  for (const s of schedules) {
    t.states[s.state] += 1
    t[kind.get(s.id)!].schedules += 1
  }
  for (const f of firings) {
    const k = kind.get(f.schedule)
    if (!k) continue
    t.firings += 1
    if (f.error) t.errors += 1
    t.runs += f.runs
    t.succeeded += f.succeeded
    t.failed += f.failed
    t.open += f.open
    t.seconds += f.seconds
    t[k].firings += 1
    t[k].runs += f.runs
    t[k].seconds += f.seconds
  }
  return t
}

/** The share of finished runs that succeeded, or null before any finished. */
export function successRate(t: Pick<Tally, 'succeeded' | 'failed'>): number | null {
  const done = t.succeeded + t.failed
  return done ? t.succeeded / done : null
}

/** When an approved schedule fires between `from` and `to`, or would once approved: none for one paused or declined. */
export function upcoming(s: Pick<ActionSchedule, 'state' | 'cadence'>, from: number, to: number): number[] {
  if (s.state !== 'active' && s.state !== 'awaiting') return []
  const out: number[] = []
  for (let at = nextFiring(s.cadence, new Date(from)); at && at.getTime() < to && out.length < 500; at = nextFiring(s.cadence, at)) out.push(at.getTime())
  return out
}

/** A runner's runner minutes, by bucket. `null` names the runs that ran on no runner: a webhook, a workflow, or whoever asked. */
export interface RunnerMinutes {
  runner: string | null
  minutes: number[]
}

/** The runner time each firing took, by the hour it fired in, from `from` for `hours` hours, by runner, the busiest runner first. */
export function measuredByHour(schedules: ActionSchedule[], firings: ScheduleFiring[], from: number, hours: number): RunnerMinutes[] {
  const runnerOf = new Map(schedules.map((s) => [s.id, s.load?.runner ?? null]))
  const out = new Map<string | null, number[]>()
  for (const f of firings) {
    if (!runnerOf.has(f.schedule) || !f.seconds) continue
    const i = Math.floor((Date.parse(f.at) - from) / HOUR)
    if (i < 0 || i >= hours) continue
    const runner = runnerOf.get(f.schedule) ?? null
    const row = out.get(runner) ?? Array<number>(hours).fill(0)
    row[i]! += f.seconds / 60
    out.set(runner, row)
  }
  return byBusiest(out)
}

/**
 * The runner minutes the schedules ask on an average day, by the hour of the
 * reader's day, by runner, the busiest first: each schedule's planned load,
 * kept by the hub in UTC hours, turned by `offsetHours` from UTC. A schedule
 * whose load is not known yet adds nothing.
 */
export function plannedDay(schedules: ActionSchedule[], offsetHours: number): RunnerMinutes[] {
  const out = new Map<string | null, number[]>()
  for (const s of schedules) {
    if (!s.load || s.load.runnerSeconds === null) continue
    const row = out.get(s.load.runner) ?? Array<number>(24).fill(0)
    s.load.hours.forEach((seconds, utc) => (row[(((utc + offsetHours) % 24) + 24) % 24]! += seconds / 60))
    out.set(s.load.runner, row)
  }
  return byBusiest(out)
}

function byBusiest(rows: Map<string | null, number[]>): RunnerMinutes[] {
  const sum = (m: number[]) => m.reduce((a, b) => a + b, 0)
  return [...rows].map(([runner, minutes]) => ({ runner, minutes })).sort((a, b) => sum(b.minutes) - sum(a.minutes) || (a.runner ?? '~').localeCompare(b.runner ?? '~'))
}

/** The runner minutes a schedule asks a day, or null while how long its runs take is not known. */
export function minutesADay(s: Pick<ActionSchedule, 'load'>): number | null {
  return s.load && s.load.runnerSeconds !== null ? (s.load.runnerSeconds * s.load.perDay) / 60 : null
}

/** Each hour's total across runners. */
export function totals(rows: RunnerMinutes[], length: number): number[] {
  const out = Array<number>(length).fill(0)
  for (const r of rows) r.minutes.forEach((m, i) => (out[i]! += m))
  return out
}

/** Runner time said for a person: 40 s, 12 min, 3.4 h. */
export function runnerTime(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)} s`
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`
  return `${(seconds / 3600).toFixed(seconds < 36_000 ? 1 : 0)} h`
}

/**
 * The moments a run may be put off to, offered as one tap each, in the
 * reader's own time: in an hour, tonight at ten while that is still to come,
 * tomorrow at six in the morning, and the coming Monday at six when that is
 * not tomorrow. `now` is the reader's clock.
 */
export function laterChoices(now: Date): { label: string; at: Date }[] {
  const at = (days: number, hour: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, hour, 0, 0, 0)
  const hour = new Date(Math.ceil((now.getTime() + 3_600_000) / 300_000) * 300_000)
  const out = [{ label: 'In an hour', at: hour }]
  const tonight = at(0, 22)
  if (tonight.getTime() - now.getTime() > 3_600_000) out.push({ label: 'Tonight at 10 PM', at: tonight })
  out.push({ label: 'Tomorrow at 6 AM', at: at(1, 6) })
  const toMonday = (8 - now.getDay()) % 7 || 7
  if (toMonday > 1) out.push({ label: 'Monday at 6 AM', at: at(toMonday, 6) })
  return out
}

/** A once cadence at a moment, in the reader's zone. */
export const onceAt = (at: Date, tz: string): Cadence => ({ every: 'once', on: at.toISOString(), tz })

/** A moment as a `datetime-local` input holds it, in the reader's own time: 2026-11-16T06:00. */
export function localInput(at: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}T${p(at.getHours())}:${p(at.getMinutes())}`
}

/** What a `datetime-local` input holds, as a moment in the reader's own time; null when it holds none. */
export function fromLocalInput(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value)
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])) : null
}

/** How many schedules stand in each state, in words, in the lanes' order: "3 active, 2 paused, 1 waiting for approval". `short` says "waiting". */
export function standingWords(states: Tally['states'], short = false): string[] {
  const said: [ScheduleState, string][] = [
    ['active', 'active'],
    ['paused', 'paused'],
    ['awaiting', short ? 'waiting' : 'waiting for approval'],
    ['declined', 'declined'],
    ['done', 'fired once'],
  ]
  return said.filter(([state]) => states[state]).map(([state, word]) => `${states[state].toLocaleString('en-US')} ${word}`)
}

/**
 * How the firings in a window went, in one sentence: which schedules had
 * runs fail (a warning), that nothing fired, that what fired is still
 * running, or that every firing that finished succeeded. `word` names the
 * window: "this week".
 */
export function howItWent(firings: ScheduleFiring[], word: string): { text: string; warn: boolean } {
  const hurt = new Set(firings.filter((f) => f.failed || f.error).map((f) => f.schedule)).size
  if (hurt) return { text: `${hurt.toLocaleString('en-US')} ${hurt === 1 ? 'schedule' : 'schedules'} had runs fail ${word}.`, warn: true }
  if (!firings.length) return { text: `Nothing fired ${word}.`, warn: false }
  const open = firings.filter((f) => f.open).length
  const finished = firings.filter((f) => !f.open && f.succeeded).length
  if (!finished && open) return { text: `${open.toLocaleString('en-US')} ${open === 1 ? 'firing' : 'firings'} ${word} still running.`, warn: false }
  return { text: open ? `Every firing that finished ${word} succeeded; ${open.toLocaleString('en-US')} still running.` : `Every firing ${word} succeeded.`, warn: false }
}

/** When a schedule fires, in words: its cadence, or for one that fired once, when it did. */
export function whenOf(s: Pick<ActionSchedule, 'state' | 'cadence' | 'when' | 'lastAt'>): string {
  if (s.state === 'done' && s.cadence.every === 'once' && s.lastAt) return `fired once, ${new Date(s.lastAt).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
  return s.when
}

/**
 * A schedule's day in the runs list as one state: still going while any run
 * is open, failed when a run failed or a firing asked nothing, else how its
 * runs ended.
 */
export function dayState(d: Pick<ScheduleDay, 'counts' | 'missed'>): ActionRunState {
  const c = d.counts
  if (c.running) return 'running'
  if (c.awaiting) return 'awaiting'
  if (c.queued) return 'queued'
  if (c.failed || d.missed) return 'failed'
  if (c.unknown) return 'unknown'
  if (c.succeeded) return 'succeeded'
  if (c.returned) return 'returned'
  return 'cancelled'
}

/** The instants a local day (`YYYY-MM-DD`) starts and ends on the reader's own clock. */
export function daySpan(day: string): { from: Date; to: Date } {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number]
  return { from: new Date(y, m - 1, d), to: new Date(y, m - 1, d + 1) }
}
