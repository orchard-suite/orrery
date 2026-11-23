// What the Load page says of the hub's load: which budget each name is held
// to and how close it is, and the signals worth a person's look, each with
// what is seen, why it costs, and what can be done. The hub's budget findings
// and the page both read the budgets and their advice from here, so the two
// always agree.

import type { Budget, BudgetKind, Budgets, LoadColumn, LoadHeldBlueprint, LoadResponse } from './api.ts'

/** The name a budget is kept under when it is for everything that has none of its own. */
export const EVERY = '*'
/** The hub's own sources: people's edits and what the hub writes itself. The budget for every source is for what pushes; these are held only to a budget of their own. */
const OWN_SOURCES: ReadonlySet<string> = new Set(['ui', 'hub'])
/** Past this share of its first threshold a name is near it. */
export const NEAR = 0.8

/** The budget a name is held to: its own, else the one for everything. */
export function budgetFor(budgets: Budgets, kind: BudgetKind, name: string): Budget | undefined {
  return budgets[kind][name] ?? (kind === 'changes' && OWN_SOURCES.has(name) ? undefined : budgets[kind][EVERY])
}

/** How a number stands against its budget: past its limit, past its warning, near the first of them, or inside. */
export type BudgetState = 'limit' | 'warn' | 'near' | 'ok'

export function budgetState(used: number, budget: Budget): BudgetState {
  if (budget.limit !== undefined && used >= budget.limit) return 'limit'
  if (budget.warn !== undefined && used >= budget.warn) return 'warn'
  return used >= NEAR * (budget.warn ?? budget.limit!) ? 'near' : 'ok'
}

/** What each kind of budget costs the hub, and what can be done when a name nears it. */
export const BUDGET_ADVICE: Record<BudgetKind, { why: string; fixes: string[] }> = {
  changes: {
    why: 'Every change is written, derived, and sent on to whatever reads it. Past its limit the hub refuses the source until the hour turns.',
    fixes: ['Find the value that moves on every run, such as a timestamp or a counter, and stop sending it.', 'Push less often, or split the source by scope.', 'If the changes are real, give the source a budget of its own.'],
  },
  calls: {
    why: 'Every call is answered from the database. Past its limit a token is refused until the hour turns; a person never is.',
    fixes: ['Page through a list once and keep it.', 'Follow the events stream for changes instead of asking again.', 'If the calls are needed, give the caller a budget of its own.'],
  },
  entities: {
    why: 'Every entity is derived, listed, and searched. Past its limit the blueprint takes no new one.',
    fixes: ['Let what happened expire by age.', 'Keep machine activity as counts on what it happened to.', 'Raise the budget if the blueprint should hold this many.'],
  },
  reads: {
    why: 'A row is derived again whenever anything it reads changes, so a rollup over many costs on every change beneath it. Nothing is refused for it.',
    fixes: ['Roll up in steps, each over fewer.', 'Read a count instead of the entities where a count will do.', 'Raise the budget if the rollup is worth it.'],
  },
}

/** The three things the hub spends its time on. */
export type LoadArea = 'in' | 'work' | 'out'
export const AREAS: Record<LoadArea, { title: string; about: string }> = {
  in: { title: 'Taking in', about: 'Sources writing' },
  work: { title: 'Working out', about: 'Deriving, grids, and links' },
  out: { title: 'Answering', about: 'API calls' },
}

/** How much a signal asks of a person: a budget passed or neared, or a pattern worth a look that no budget counts. */
export type SignalLevel = 'limit' | 'warn' | 'near' | 'watch'
export const LEVEL_ORDER: Record<SignalLevel, number> = { limit: 0, warn: 1, near: 2, watch: 3 }
/** How a signal's number reads. */
export type SignalUnit = 'count' | 'decimal' | 'percent' | 'bytes' | 'ms'

export interface LoadSignal {
  level: SignalLevel
  area: LoadArea
  /** What it is about: a source by id, a caller by name, a blueprint by id, or the derive queue. */
  subject: { kind: 'source' | 'caller' | 'blueprint' | 'queue'; id: string }
  /** The check, said in a few words. */
  title: string
  value: number
  unit: SignalUnit
  /** The budget the value is held to, for a budget's signal; with `kind` so a person may set one of its own. */
  budget?: { kind: BudgetKind; held: Budget }
  seen: string
  why: string
  fixes: string[]
  /** The subject's time in its area over the window, which orders signals of one level. */
  ms: number
  /** For what a blueprint holds: how it moved, and where it goes at this pace. */
  trend?: HeldTrend
}

/** The thresholds of the signals no budget counts. Each is a pattern seen to cost a hub, set where it costs enough to be worth a look. */
const UNCHANGED = { received: 10_000, changedShare: 0.02, timeShare: 0.1 }
const CHURN = { changed: 1_000, changedShare: 0.9 }
const HEAVY = { perCall: 200 * 1024, bytes: 100 * 1024 ** 2 }
const SLOW = { ms: 2_000, calls: 50 }
const FANOUT = { perChange: 3, changed: 100 }
const COSTLY = { msPerRow: 20, timeShare: 0.03 }
const REBUILT = { builds: 100, timeShare: 0.3 }
const BACKLOG = { depth: 1_000, seconds: 300 }

export const count = (n: number): string => Math.round(n).toLocaleString('en-US')

export function bytes(n: number): string {
  if (n < 1024) return `${count(n)} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} kB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(1)} GB`
}

/** A length of work: milliseconds while it is short, seconds with a decimal under a minute, then minutes, hours, and days. */
export function took(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  const m = Math.floor(ms / 60_000)
  if (m < 60) return `${m}m ${Math.round((ms % 60_000) / 1000)}s`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`
}

export function said(value: number, unit: SignalUnit): string {
  if (unit === 'percent') return `${(value * 100).toFixed(value < 0.1 ? 1 : 0)}%`
  if (unit === 'bytes') return bytes(value)
  if (unit === 'ms') return took(value)
  if (unit === 'decimal') return value.toFixed(1)
  return count(value)
}

const total = <T>(rows: T[], ms: (row: T) => number) => rows.reduce((n, r) => n + ms(r), 0)

/** The time each area took over the window. */
export function areaTimes(load: Pick<LoadResponse, 'writing' | 'deriving' | 'grids' | 'relinking' | 'reading'>): Record<LoadArea, number> {
  return { in: total(load.writing, (r) => r.ms), work: total(load.deriving, (r) => r.ms) + total(load.grids, (r) => r.ms) + total(load.relinking, (r) => r.ms), out: total(load.reading, (r) => r.ms) }
}

const DAY_MS = 86_400_000
/** The full days, before today, whose pace a forecast follows. */
export const PACE_DAYS = 28
/** Fewer full days than this say too little of a pace to forecast. */
const PACE_MIN_DAYS = 7
/** How far ahead a forecast goes. */
export const FORECAST_DAYS = 365
/** The day a person reads first in a forecast. */
export const MONTH_DAYS = 30

/** What a blueprint held, day by day, and where it goes if the pace of the last weeks holds. */
export interface HeldTrend {
  /** What it held at the end of each day, oldest first; the last is now. */
  history: number[]
  /** How much it grew each week over the pace's days, after what left. Null when there are too few days to say. */
  perWeek: number | null
  /** What it holds at the end of each day ahead, tomorrow first, `FORECAST_DAYS` long; empty when there is no pace. */
  forecast: number[]
  /** Where expiry levels it at this pace: a day's arrivals times the days each lives. Null when nothing expires. */
  levels: number | null
  /** Days from today until it reaches its warning and its limit at this pace, when it is under them now and does so within the forecast. */
  passes: { warn: number | null; limit: number | null }
}

/**
 * What a blueprint held each day is what it holds now, less what came since,
 * plus what left since. Ahead, a blueprint whose entities expire gains what
 * came each day of the pace and loses what expiry takes: what it holds now on
 * the day each expires, then each day's arrivals once they are as old. One
 * that does not expire moves by what came less what left, each day.
 */
export function heldTrend(moved: LoadHeldBlueprint, now: number, budget?: Budget): HeldTrend {
  const days = moved.came.length
  const history = new Array<number>(days).fill(0)
  history[days - 1] = now
  for (let i = days - 1; i > 0; i--) history[i - 1] = Math.max(0, history[i]! - moved.came[i]! + moved.left[i]!)
  // Today is not over, so the pace reads the full days before it.
  const pace = Math.min(PACE_DAYS, days - 1)
  const empty: HeldTrend = { history, perWeek: null, forecast: [], levels: null, passes: { warn: null, limit: null } }
  if (pace < PACE_MIN_DAYS) return empty
  const sum = (list: number[]) => list.slice(days - 1 - pace, days - 1).reduce((n, v) => n + v, 0)
  const came = sum(moved.came) / pace
  const net = (history[days - 2]! - history[days - 2 - pace]!) / pace
  const expire = moved.expire
  const forecast: number[] = []
  let gone = expire?.ahead[0] ?? 0
  for (let d = 1; d <= FORECAST_DAYS; d++) {
    if (expire) {
      gone += expire.ahead[d] ?? 0
      const aged = Math.max(0, d - expire.afterDays)
      forecast.push(Math.max(0, Math.round(now + came * (d - aged) - gone)))
    } else forecast.push(Math.max(0, Math.round(now + net * d)))
  }
  const passing = (at: number | undefined) => {
    if (at === undefined || now >= at) return null
    const d = forecast.findIndex((n) => n >= at)
    return d < 0 ? null : d + 1
  }
  return { history, perWeek: net * 7, forecast, levels: expire ? Math.round(came * expire.afterDays) : null, passes: { warn: passing(budget?.warn), limit: passing(budget?.limit) } }
}

/** A day a number of days from today, as a person reads it. */
export function dayAhead(days: number, today = Math.floor(Date.now() / DAY_MS)): string {
  return new Date((today + days) * DAY_MS).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: days > 300 ? 'numeric' : undefined, timeZone: 'UTC' })
}

/** The trend said in a few sentences: how fast it grew, where it is in a month, and where it goes. */
export function trendSaid(t: HeldTrend, budget?: Budget): string {
  if (t.perWeek === null) return ''
  const week = Math.round(t.perWeek)
  const out = [week === 0 ? 'It held steady over the last four weeks.' : `It ${week > 0 ? 'gained' : 'lost'} ${count(Math.abs(week))} a week over the last four weeks.`]
  out.push(`At that pace it holds about ${count(t.forecast[MONTH_DAYS - 1] ?? 0)} in a month.`)
  if (t.passes.limit !== null) out.push(`It reaches its limit of ${count(budget!.limit!)} around ${dayAhead(t.passes.limit)}, and is refused new ones from then.`)
  else if (t.passes.warn !== null) out.push(`It passes its warning of ${count(budget!.warn!)} around ${dayAhead(t.passes.warn)}.`)
  if (t.levels !== null) out.push(`Expiry levels it near ${count(t.levels)}${budget?.limit !== undefined ? `, ${t.levels >= budget.limit ? 'past' : 'under'} its limit` : ''}.`)
  else if (week > 0) out.push('Nothing expires it, so it keeps growing.')
  return out.join(' ')
}

/** Every signal in a window of load, worst first, then by time. `name` says a blueprint's id as a person reads it, and `field` a field's. */
export function loadSignals(load: LoadResponse, name: (blueprint: string) => string = (id) => id, field: (blueprint: string, field: string) => string = (_, f) => f): LoadSignal[] {
  const out: LoadSignal[] = []
  const areas = areaTimes(load)
  const share = (ms: number, area: LoadArea) => (areas[area] ? ms / areas[area] : 0)
  const held = (kind: BudgetKind, id: string, used: number, ms: number, area: LoadArea, subject: LoadSignal['subject'], title: string, seen: string, unit: SignalUnit = 'count') => {
    const budget = budgetFor(load.budgets, kind, id)
    if (!budget) return
    const state = budgetState(used, budget)
    if (state === 'ok') return
    out.push({ level: state, area, subject, title, value: used, unit, budget: { kind, held: budget }, seen, ...BUDGET_ADVICE[kind], ms })
  }

  for (const r of load.writing) {
    const subject = { kind: 'source', id: r.source } as const
    const peak = load.use.changes[r.source]?.peak ?? 0
    held('changes', r.source, peak, r.ms, 'in', subject, 'Changes in an hour', `${r.source} changed ${count(peak)} entities in its fullest hour.`)
    const changed = r.received ? r.changed / r.received : 0
    if (r.received >= UNCHANGED.received && changed < UNCHANGED.changedShare && share(r.ms, 'in') >= UNCHANGED.timeShare)
      out.push({
        level: 'watch', area: 'in', subject, title: 'Sends what did not change', value: changed, unit: 'percent', ms: r.ms,
        seen: `${r.source} sent ${count(r.received)} entities and ${said(changed, 'percent')} of them changed. It takes ${said(share(r.ms, 'in'), 'percent')} of the time spent taking in.`,
        why: 'An entity sent in full is checked field by field against what is stored, even when nothing in it moved.',
        fixes: ['Name what did not change by a sighting: its digest alone, which the hub takes without reading the entity. The Go SDK does it on its own.', 'Push less often where nothing needs to be fresh.'],
      })
    if (r.changed >= CHURN.changed && changed >= CHURN.changedShare)
      out.push({
        level: 'watch', area: 'in', subject, title: 'Changes all it sends', value: changed, unit: 'percent', ms: r.ms,
        seen: `${r.source} changed ${said(changed, 'percent')} of the ${count(r.received)} entities it sent.`,
        why: 'When nearly everything changes on every run, a value is usually moving that nobody reads.',
        fixes: ['Find the value that moves on every run, such as a timestamp or a counter, and stop sending it.', 'Push less often.'],
      })
  }

  for (const r of load.reading) {
    const subject = { kind: 'caller', id: r.caller } as const
    const peak = load.use.calls[r.caller]?.peak ?? 0
    held('calls', r.caller, peak, r.ms, 'out', subject, 'Calls in an hour', `${r.caller} made ${count(peak)} calls in its fullest hour.`)
    const per = r.calls ? r.bytes / r.calls : 0
    if (per >= HEAVY.perCall && r.bytes >= HEAVY.bytes)
      out.push({
        level: 'watch', area: 'out', subject, title: 'Heavy answers', value: per, unit: 'bytes', ms: r.ms,
        seen: `${r.caller} was answered ${bytes(r.bytes)} in ${count(r.calls)} calls: ${bytes(per)} a call.`,
        why: 'A big answer costs the hub time to read, shape, and send.',
        fixes: ['Ask only for the fields it needs.', 'Filter on the hub instead of after the answer.', 'Keep what it read and follow the events stream for changes.'],
      })
  }
  const callerMs = new Map(load.reading.map((r) => [r.caller, r.ms]))
  for (const r of load.routes) {
    const avg = r.calls ? r.ms / r.calls : 0
    if (avg >= SLOW.ms && r.calls >= SLOW.calls)
      out.push({
        level: 'watch', area: 'out', subject: { kind: 'caller', id: r.caller }, title: `Slow calls to ${r.route}`, value: avg, unit: 'ms', ms: callerMs.get(r.caller) ?? r.ms,
        seen: `${r.route} took ${took(avg)} on average, ${count(r.calls)} times, ${took(r.ms)} in all.`,
        why: 'A slow call holds a connection while it runs, and whoever asked waits.',
        fixes: ['See what the route does on each call, and ask for less.', 'Send many changes in one call instead of one call each.'],
      })
  }

  const now = new Map(load.blueprints.map((b) => [b.id, b]))
  const derives = new Map(load.deriving.map((r) => [r.blueprint, r]))
  const grids = new Map(load.grids.map((r) => [r.blueprint, r]))
  const moved = new Map((load.held?.blueprints ?? []).map((b) => [b.id, b]))
  for (const b of load.blueprints) {
    const subject = { kind: 'blueprint', id: b.id } as const
    const ms = (derives.get(b.id)?.ms ?? 0) + (grids.get(b.id)?.ms ?? 0)
    const budget = budgetFor(load.budgets, 'entities', b.id)
    const trend = moved.has(b.id) ? heldTrend(moved.get(b.id)!, b.entities, budget) : undefined
    const seen = `${name(b.id)} holds ${count(b.entities)} entities.${trend ? ` ${trendSaid(trend, budget)}` : ''}`.trim()
    const before = out.length
    held('entities', b.id, b.entities, ms, 'work', subject, 'Entities held', seen)
    if (out.length > before) out[out.length - 1]!.trend = trend
    // Inside its budget now, but at this pace past it within a month: said before it happens.
    else if (budget && trend && [trend.passes.warn, trend.passes.limit].some((d) => d !== null && d <= MONTH_DAYS))
      out.push({ level: 'near', area: 'work', subject, title: 'Entities held in a month', value: b.entities, unit: 'count', budget: { kind: 'entities', held: budget }, seen, ...BUDGET_ADVICE.entities, ms, trend })
    held('reads', b.id, b.reads, ms, 'work', subject, 'Reads per row', `One ${name(b.id)} reads ${said(b.reads, 'decimal')} entities on average.`, 'decimal')
  }
  for (const r of load.deriving) {
    const subject = { kind: 'blueprint', id: r.blueprint } as const
    const ms = r.ms + (grids.get(r.blueprint)?.ms ?? 0)
    const fan = r.changed ? r.cascaded / r.changed : 0
    if (fan >= FANOUT.perChange && r.changed >= FANOUT.changed)
      out.push({
        level: 'watch', area: 'work', subject, title: 'Readers per change', value: fan, unit: 'decimal', ms,
        seen: `Each ${name(r.blueprint)} that changed sent ${said(fan, 'decimal')} readers back to be derived, ${count(r.cascaded)} in all.`,
        why: 'One change ripples into many derives, and each of them may ripple again.',
        fixes: ['Find what moves on it on every push and stop it moving.', 'Have its readers read a part of it that changes less.'],
      })
    const per = r.derived ? r.ms / r.derived : 0
    if (per >= COSTLY.msPerRow && share(r.ms, 'work') >= COSTLY.timeShare)
      out.push({
        level: 'watch', area: 'work', subject, title: 'Costly rows', value: per, unit: 'ms', ms,
        seen: `Deriving one ${name(r.blueprint)} takes ${took(per)}${now.get(r.blueprint) ? `, and one reads ${said(now.get(r.blueprint)!.reads, 'decimal')} entities` : ''}.`,
        why: 'A row walks every path its mirrors, aggregations, and rollup follow, each time it is derived.',
        fixes: ['Cut the paths it follows, or how far they go.', 'Roll up in steps, each over fewer.'],
      })
  }
  const gridTime = total(load.grids, (r) => r.ms)
  for (const g of load.grids) {
    if (g.builds >= REBUILT.builds && gridTime && g.ms / gridTime >= REBUILT.timeShare)
      out.push({
        level: 'watch', area: 'work', subject: { kind: 'blueprint', id: g.blueprint }, title: 'Grid built again often', value: g.builds, unit: 'count', ms: g.ms + (derives.get(g.blueprint)?.ms ?? 0),
        seen: `The ${name(g.blueprint)} grid was built ${count(g.builds)} times, ${took(g.ms / g.builds)} each.`,
        why: 'A grid is built again whenever what it reads moves, and a big one costs on each build.',
        fixes: ['Stop what moves on every push from moving.', 'Share out fewer columns in the grid.'],
      })
  }

  for (const c of load.columns) {
    if (columnFit(c) !== 'costly') continue
    out.push({
      level: 'watch', area: 'work', subject: { kind: 'blueprint', id: c.blueprint }, title: `Counting ${field(c.blueprint, c.field)} shows little`, value: shownShare(c), unit: 'percent', ms: (grids.get(c.blueprint)?.ms ?? 0) + (derives.get(c.blueprint)?.ms ?? 0),
      seen: `${field(c.blueprint, c.field)} on ${name(c.blueprint)} holds ${count(c.different)} different values in ${count(c.values)} rows. The spread under the grid draws ${said(shownShare(c), 'percent')} of them; the rest is "other".`,
      why: 'Every grid build counts each different value of every counted column. One whose values rarely repeat costs the most to count, and its spread is slivers.',
      fixes: ['Turn off "Count under the grid" on the field, on the grid’s column menu or the model page. How its values look stays as it is.', 'A filter on it then takes a typed value instead of a pick from the counted ones.'],
    })
  }

  const oldest = load.queue.oldestSeconds ?? 0
  if (load.queue.depth >= BACKLOG.depth || oldest >= BACKLOG.seconds)
    out.push({
      level: 'warn', area: 'work', subject: { kind: 'queue', id: 'derive' }, title: 'Derive backlog', value: load.queue.depth, unit: 'count', ms: areas.work,
      seen: `${count(load.queue.depth)} entities wait to be derived; the oldest has waited ${took(oldest * 1000)}.`,
      why: 'Derived fields, status, and relations are behind what was pushed until the queue drains.',
      fixes: ['Run another hub with the worker role.', 'Find the blueprint that derives most and cut what it reads.'],
    })

  return out.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || b.ms - a.ms)
}

/** The signals of one subject: one row on the page, at the level of its worst. */
export interface SignalGroup {
  key: string
  subject: LoadSignal['subject']
  area: LoadArea
  level: SignalLevel
  signals: LoadSignal[]
}

/**
 * What a column's spread says of counting it under the grid, for a field a grid may count (`SPREAD_TYPES`). How
 * its values look, a chip or not, has no part in it: only the count costs.
 * - `costly`: counted over many values that rarely repeat. Every grid build counts each one, and the spread draws
 *   slivers.
 * - `candidate`: not counted, though its few values repeat across many rows, which its spread would show at a glance.
 * - `fine`: either way is right.
 */
export type ColumnFit = 'costly' | 'candidate' | 'fine'

/** Past this many different values, where the spread's widest buckets hold under this share, the count shows little. */
const SLIVERS = { different: 100, shown: 0.25 }
/** Up to this many different values, each held this many times on average over at least this many values, a column is a count waiting. */
const REPEATS = { different: 60, each: 5, values: 20 }

/** The share of a column's values its spread draws as buckets of their own; the rest is "other". */
export const shownShare = (c: Pick<LoadColumn, 'values' | 'top'>): number => (c.values ? c.top / c.values : 0)
/** How many rows hold each value, on average. */
export const repeatsOf = (c: Pick<LoadColumn, 'values' | 'different'>): number => (c.different ? c.values / c.different : 0)

export function columnFit(c: LoadColumn): ColumnFit {
  if (c.spread && c.different > SLIVERS.different && shownShare(c) < SLIVERS.shown) return 'costly'
  if (c.spread) return 'fine'
  return c.different >= 2 && c.different <= REPEATS.different && c.values >= REPEATS.values && repeatsOf(c) >= REPEATS.each ? 'candidate' : 'fine'
}

/** What each fit says, in a few words. */
export const FIT_SAID: Record<ColumnFit, string> = { costly: 'Costs more than it shows', candidate: 'Could be counted', fine: '' }

/** Columns worst fit first: counts that cost, then counts waiting, each by how many values they hold. */
export function byFit(columns: LoadColumn[]): LoadColumn[] {
  const order: Record<ColumnFit, number> = { costly: 0, candidate: 1, fine: 2 }
  return [...columns].sort((a, b) => order[columnFit(a)] - order[columnFit(b)] || b.values - a.values || a.blueprint.localeCompare(b.blueprint) || a.field.localeCompare(b.field))
}

/** Signals gathered by what they are about, worst first, then by time. */
export function bySubject(signals: LoadSignal[]): SignalGroup[] {
  const groups = new Map<string, SignalGroup>()
  for (const s of signals) {
    const key = `${s.subject.kind}:${s.subject.id}`
    const group = groups.get(key)
    if (!group) groups.set(key, { key, subject: s.subject, area: s.area, level: s.level, signals: [s] })
    else {
      group.signals.push(s)
      if (LEVEL_ORDER[s.level] < LEVEL_ORDER[group.level]) group.level = s.level
    }
  }
  const time = (g: SignalGroup) => Math.max(...g.signals.map((s) => s.ms))
  return [...groups.values()].sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || time(b) - time(a))
}
