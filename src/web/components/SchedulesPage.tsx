// The schedules page: an operations view for the people who own schedules.
// It says first how their schedules stand. Then each schedule is a lane on one
// clock, grouped by state, with every firing in the window as a mark: its
// height the runner time it took, its colour how it went, and the firings
// still to come drawn hollow. Under the lanes, the runner minutes the firings
// took, hour by hour. Beside them, an average day as a dial of the runner
// minutes the schedules ask in each hour, and the tally of the window. A lane
// opens its schedule, with every firing and each firing's runs (`ScheduleView.tsx`).

import { useMemo, useState, type CSSProperties } from 'react'
import type { ActionSchedule, ScheduleFiring } from '../../shared/api.ts'
import { isOnce } from '../../shared/cadence.ts'
import { useActions, useScheduleHistory, useSchedules, useWhoAmI } from '../api.ts'
import { navigate } from '../router.ts'
import { OUTCOME_WORD, howItWent, isBatch, standing, standingWords, whenOf, lanesOf, measuredByHour, minutesADay, outcomeOf, plannedDay, runnerTime, successRate, tally, totals, upcoming, type Outcome, type RunnerMinutes, type Tally } from '../schedules.ts'
import { useWidth } from './Atlas.tsx'
import { markPaint, ScheduleView, Swatch } from './ScheduleView.tsx'
import { Empty, ErrorNote, Kicker, Link, Panel } from './ui.tsx'
import { useVisit } from '../trail.ts'

const HOUR = 3_600_000

/** The windows the page reads back, and how far ahead each draws what is still to come. */
const WINDOWS = [
  { days: 1, label: 'Day', ahead: 6 * HOUR, word: 'today' },
  { days: 7, label: 'Week', ahead: 24 * HOUR, word: 'this week' },
  { days: 30, label: '30 days', ahead: 3 * 24 * HOUR, word: 'in 30 days' },
] as const
type Window = (typeof WINDOWS)[number]

/** A colour for each runner, none of them an outcome's or the clock's own blue; what runs on no runner is plain ink. */
const RUNNER_FILL = ['var(--color-ansi-cyan)', 'var(--color-ansi-magenta)', 'var(--color-ink-200)', 'var(--color-ansi-yellow-bright)', 'var(--color-ink-400)']
const NO_RUNNER = 'var(--color-ink-400)'
/** What ran on no runner is drawn as an outline, so it never reads as a runner of a quieter colour. */
const shade = (paint: Paint, runner: string | null): { fill: string; stroke?: string; strokeWidth?: number } => (runner === null ? { fill: 'none', stroke: NO_RUNNER, strokeWidth: 1.5 } : { fill: paint(runner) })
const swatch = (paint: Paint, runner: string | null): CSSProperties => (runner === null ? { boxShadow: `inset 0 0 0 1.5px ${NO_RUNNER}` } : { background: paint(runner) })

/** Each runner's colour, the same in the band and on the dial: the busiest runner the clearest, by what the schedules ask of each a day, then by name. */
type Paint = (runner: string | null) => string
function runnerPaint(list: ActionSchedule[]): Paint {
  const asked = new Map<string, number>()
  for (const s of list) if (s.load?.runner) asked.set(s.load.runner, (asked.get(s.load.runner) ?? 0) + (minutesADay(s) ?? 0))
  const names = [...asked].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([r]) => r)
  return (runner) => (runner === null ? NO_RUNNER : (RUNNER_FILL[Math.min(names.indexOf(runner), RUNNER_FILL.length - 1)] ?? NO_RUNNER))
}

const n = (x: number) => Math.round(x).toLocaleString('en-US')
const plural = (x: number, one: string, many = `${one}s`) => `${n(x)} ${x === 1 ? one : many}`
const clock = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })

export function SchedulesPage({ id }: { id: string | null }) {
  const me = useWhoAmI().data?.identity.name ?? ''
  const schedules = useSchedules()
  const all = schedules.data?.schedules ?? []
  const others = all.some((s) => s.owner !== me)
  const ownsAny = all.some((s) => s.owner === me)
  const [whose, setWhose] = useVisit<'mine' | 'all' | null>('schedules.whose', null)
  const scope = whose ?? (ownsAny || !others ? 'mine' : 'all')
  const list = scope === 'mine' ? all.filter((s) => s.owner === me) : all
  const [window, setWindow] = useVisit<Window>('schedules.window', WINDOWS[1])
  const history = useScheduleHistory(window.days)
  const shown = new Set(list.map((s) => s.id))
  const firings = (history.data?.firings ?? []).filter((f) => shown.has(f.schedule))
  const t = tally(list, firings)
  const opened = id ? all.find((s) => s.id === id) : undefined
  return (
    <div className="space-y-5 py-6">
      <div className="space-y-1">
        <Kicker>
          <Link to={{ page: 'actions', id: null }} className="hover:underline">
            Self-service
          </Link>
        </Kicker>
        <h1 className="page-title">Schedules</h1>
      </div>
      <ErrorNote error={schedules.error ?? history.error} />
      {schedules.data && !all.length ? (
        <Empty>
          No schedules yet. Set one up from an action's form, or from a batch run on a saved query. It runs as you, once someone who decides approvals approves it.
        </Empty>
      ) : (
        <>
          <Headline list={list} firings={firings} t={t} window={window} loaded={!!history.data} />
          <div className="flex flex-wrap items-center gap-2">
            <Choice label="Window" options={WINDOWS.map((w) => ({ value: w, label: w.label }))} value={window} onChange={setWindow} />
            {others && (
              <Choice
                label="Whose"
                options={[
                  { value: 'mine' as const, label: 'Yours' },
                  { value: 'all' as const, label: 'Everyone’s' },
                ]}
                value={scope}
                onChange={setWhose}
              />
            )}
          </div>
          <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_22rem]">
            <Lanes list={list} firings={firings} window={window} me={me} />
            <div className="grid gap-5 lg:grid-cols-2 xl:grid-cols-1">
              <DayDial list={list} paint={runnerPaint(list)} />
              <Ledger t={t} window={window} />
            </div>
          </div>
        </>
      )}
      {id && schedules.data && <ScheduleView id={id} s={opened ?? null} onClose={() => navigate({ page: 'action-schedules', id: null })} />}
    </div>
  )
}

/** A choice of one among a few, as pressed buttons. */
function Choice<T>({ label, options, value, onChange }: { label: string; options: { value: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div role="group" aria-label={label} className="flex rounded-md border border-ink-700 p-0.5">
      {options.map((o) => (
        <button key={o.label} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)} className={`rounded px-2.5 py-1 text-[13px] ${o.value === value ? 'bg-ink-700 text-ink-50' : 'text-ink-300 hover:text-ink-100'}`}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** How the schedules stand, in two sentences: by state, then what went wrong in the window and what fires next. */
function Headline({ list, firings, t, window, loaded }: { list: ActionSchedule[]; firings: ScheduleFiring[]; t: Tally; window: Window; loaded: boolean }) {
  const parts = standingWords(t.states)
  const went = howItWent(firings, window.word)
  const next = list.filter((s) => s.state === 'active' && s.nextAt).sort((a, b) => a.nextAt!.localeCompare(b.nextAt!))[0]
  return (
    <div className="space-y-1">
      <p className="font-serif text-[26px] leading-tight text-ink-100 md:text-[30px]">{parts.length ? `${parts.join(', ')}.` : 'None here.'}</p>
      {loaded && (
        <p className="text-[14px] text-ink-300">
          <span className={went.warn ? 'text-amber' : undefined}>{went.text} </span>
          {next && (
            <>
              Next: <span className="text-ink-100">{next.title}</span> at {clock(Date.parse(next.nextAt!))}.
            </>
          )}
        </p>
      )}
    </div>
  )
}

/** Each schedule a lane on one clock, grouped by state, with the runner minutes under them and the time across the bottom. */
function Lanes({ list, firings, window, me }: { list: ActionSchedule[]; firings: ScheduleFiring[]; window: Window; me: string }) {
  // The clock reads the time each time what it draws is read again.
  const now = useMemo(() => Date.now(), [firings])
  const from = now - window.days * 24 * HOUR
  const to = now + window.ahead
  const x = (ms: number) => ((ms - from) / (to - from)) * 100
  const bySchedule = useMemo(() => {
    const out = new Map<string, ScheduleFiring[]>()
    for (const f of firings) out.set(f.schedule, [...(out.get(f.schedule) ?? []), f])
    return out
  }, [firings])
  const actions = useActions().data?.actions ?? []
  return (
    <Panel className="px-4 py-4 md:px-5">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h2 className="text-base font-semibold text-ink-100">Every firing</h2>
        <Key />
      </div>
      <p className="mt-1 text-[12px] text-ink-400">One mark a firing: taller took more runner time. Past now, what is still to come. Hover a mark for its numbers, or open a schedule for each firing’s runs.</p>
      <div className="mt-2">
        <Axis from={from} to={to} now={now} x={x} days={window.days} />
        {lanesOf(list).map((lane) => (
          <section key={lane.state} aria-label={lane.title}>
            <h3 className="pt-4 pb-1 text-[12px] font-medium text-ink-300">
              {lane.title} <span className="text-ink-400">· {n(lane.schedules.length)}</span>
            </h3>
            <ul className="divide-y divide-ink-800 border-y border-ink-800">
              {lane.schedules.map((s) => (
                <li key={s.id}>
                  <Lane s={s} actionTitle={actions.find((a) => a.id === s.action)?.title ?? s.action} firings={bySchedule.get(s.id) ?? []} from={from} to={to} now={now} x={x} me={me} />
                </li>
              ))}
            </ul>
          </section>
        ))}
        <LoadLane list={list} firings={firings} from={from} to={to} now={now} x={x} paint={runnerPaint(list)} />
        <Axis from={from} to={to} now={now} x={x} days={window.days} />
      </div>
    </Panel>
  )
}

/** The colours a mark takes, said once beside the lanes. */
function Key() {
  const shown: Outcome[] = ['ok', 'some', 'most', 'open', 'error']
  return (
    <ul className="flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-ink-300" aria-label="What a mark’s colour means">
      {shown.map((o) => (
        <li key={o} className="flex items-center gap-1.5">
          <Swatch o={o} />
          {OUTCOME_WORD[o]}
        </li>
      ))}
    </ul>
  )
}

const LANE_GRID = 'grid gap-x-4 gap-y-1 md:grid-cols-[17rem_minmax(0,1fr)]'
const TRACK = 44

/** One schedule's lane: what it is on the left, and its firings on the clock. */
function Lane({ s, actionTitle, firings, from, to, now, x, me }: { s: ActionSchedule; actionTitle: string; firings: ScheduleFiring[]; from: number; to: number; now: number; x: (ms: number) => number; me: string }) {
  const inWindow = firings.filter((f) => Date.parse(f.at) >= from)
  const top = Math.max(1, ...inWindow.map((f) => f.seconds))
  const ahead = upcoming(s, now, to)
  const minutes = minutesADay(s)
  const height = (f: ScheduleFiring) => (f.error ? 14 : Math.max(8, Math.sqrt(f.seconds / top) * (TRACK - 8)))
  // A mark takes most of the room between two firings, so an hourly schedule reads as marks, not as one block.
  const gap = gapOf([...inWindow.map((f) => Date.parse(f.at)), ...ahead])
  const width = `${Math.min(0.35, Math.max(0.06, gap === null ? 0.35 : ((gap * 0.55) / (to - from)) * 100))}%`
  const dense = gap !== null && (gap / (to - from)) * 100 < 1
  // A firing that went wrong is drawn last, so a run of good ones never hides it.
  const order = [...inWindow].sort((a, b) => Number(outcomeOf(a) !== 'ok') - Number(outcomeOf(b) !== 'ok'))
  const bad = inWindow.filter((f) => f.failed || f.error).length
  return (
    <Link to={{ page: 'action-schedules', id: s.id }} className={`${LANE_GRID} group py-2 hover:bg-ink-850/60`} label={`Open ${s.title}`}>
      <div className="min-w-0">
        <div className="text-[14px] font-medium break-words text-ink-50 group-hover:underline">{s.title}</div>
        <div className="text-[12px] text-ink-400">
          {actionTitle}
          {s.targetTitle ? ` on ${s.targetTitle}` : ''} · {whenOf(s).replace(/ \([^)]*\)$/, '')}
        </div>
        <div className="text-[12px] text-ink-400">
          {isBatch(s) ? `batch of about ${n(s.load?.runs ?? 0)}` : 'one run'}
          {isOnce(s.cadence) ? (s.load?.runnerSeconds != null ? ` · ${runnerTime(s.load.runnerSeconds)} of runner time` : '') : minutes !== null ? ` · ${runnerTime(minutes * 60)} a day` : ' · load not known yet'}
          {s.load?.runner ? (
            <>
              {' on '}
              <span className="whitespace-nowrap">{s.load.runner}</span>
            </>
          ) : null}
          {s.owner !== me ? ` · ${s.owner}` : ''}
        </div>
        {standing(s) && <div className="text-[12px] text-amber">{standing(s)}</div>}
      </div>
      <svg className="block h-11 w-full self-center overflow-visible" role="img" aria-label={`${plural(inWindow.length, 'firing')} in the window${bad ? `, ${n(bad)} with failures` : ''}${ahead.length ? `, ${n(ahead.length)} still to come` : ''}`}>
        <line x1={`${x(now)}%`} x2={`${x(now)}%`} y1={0} y2={TRACK} stroke="var(--color-orbit)" strokeOpacity={0.6} />
        {order.map((f) => (
          <rect key={`${f.at}${f.batch ?? f.run ?? ''}`} x={`${x(Date.parse(f.at))}%`} y={TRACK - 2 - height(f)} width={f.error ? 4 : width} height={height(f)} rx={1} {...markPaint(outcomeOf(f))}>
            <title>{`${new Date(f.at).toLocaleString()} · ${f.error ? `asked nothing: ${f.error}` : `${plural(f.runs, 'run')}${f.failed ? `, ${n(f.failed)} failed` : ''}${f.open ? `, ${n(f.open)} still open` : ''} · ${runnerTime(f.seconds)}`}`}</title>
          </rect>
        ))}
        {(dense ? ahead.slice(0, 1) : ahead).map((at) => (
          <rect key={at} x={`${x(at)}%`} y={TRACK - 22} width={3} height={20} rx={1} fill="none" stroke={s.state === 'awaiting' ? 'var(--color-amber)' : 'var(--color-ink-400)'} strokeDasharray={s.state === 'awaiting' ? '3 2' : undefined}>
            <title>{`${s.state === 'awaiting' ? 'Would fire' : 'Fires'} ${new Date(at).toLocaleString()}`}</title>
          </rect>
        ))}
        {dense && ahead.length > 1 && (
          <line x1={`${x(ahead[1]!)}%`} x2={`${x(ahead.at(-1)!)}%`} y1={TRACK - 12} y2={TRACK - 12} stroke="var(--color-ink-500)" strokeDasharray="1 5" strokeLinecap="round">
            <title>{`Then ${s.when}: ${plural(ahead.length - 1, 'more firing')} before the edge`}</title>
          </line>
        )}
        {!inWindow.length && !ahead.length && (
          <text x="0" y={TRACK / 2 + 4} fill="var(--color-ink-400)" fontSize={12}>
            {s.state === 'declined' ? 'Declined: it never fires.' : s.state === 'paused' ? 'Paused: nothing in this window.' : 'Nothing in this window.'}
          </text>
        )}
      </svg>
    </Link>
  )
}

/** The shortest time between two of these moments, or null for fewer than two. */
function gapOf(times: number[]): number | null {
  const sorted = [...times].sort((a, b) => a - b)
  let gap: number | null = null
  for (let i = 1; i < sorted.length; i++) {
    const d = sorted[i]! - sorted[i - 1]!
    if (d > 0 && (gap === null || d < gap)) gap = d
  }
  return gap
}

/** The runner minutes the firings took, by the hour they fired in, stacked by runner; what is still to come drawn faint, as planned. */
function LoadLane({ list, firings, from, to, now, x, paint: fill }: { list: ActionSchedule[]; firings: ScheduleFiring[]; from: number; to: number; now: number; x: (ms: number) => number; paint: Paint }) {
  const start = Math.floor(from / HOUR) * HOUR
  const hours = Math.ceil((to - start) / HOUR)
  const measured = measuredByHour(list, firings, start, hours)
  const offset = -new Date().getTimezoneOffset() / 60
  const planned = plannedDay(list.filter((s) => s.state === 'active'), offset)
  const runners = [...new Set([...measured, ...planned].map((r) => r.runner))]
  const firstAhead = Math.ceil((now - start) / HOUR)
  const localHour = (i: number) => new Date(start + i * HOUR).getHours()
  // Past hours are what ran; hours ahead are what the approved schedules ask on an average day.
  const rows: RunnerMinutes[] = runners.map((runner) => {
    const m = measured.find((r) => r.runner === runner)?.minutes ?? Array<number>(hours).fill(0)
    const p = planned.find((r) => r.runner === runner)?.minutes
    return { runner, minutes: m.map((v, i) => (i >= firstAhead ? (p?.[localHour(i)] ?? 0) : v)) }
  })
  const sums = totals(rows, hours)
  const peak = Math.max(...sums, 0)
  const H = 64
  const scale = (v: number) => (peak ? Math.sqrt(v / peak) * (H - 4) : 0)
  const width = Math.max(100 / hours, 0.15)
  return (
    <div className={`${LANE_GRID} border-b border-ink-800 pt-5 pb-2`}>
      <div className="min-w-0">
        <div className="text-[14px] font-medium text-ink-50">Runner minutes</div>
        <div className="text-[12px] text-ink-400">{peak ? `Busiest hour: ${runnerTime(peak * 60)} of runner time, its runs side by side. Past now: what running schedules ask.` : 'Nothing ran on a runner in this window.'}</div>
        <ul className="mt-1 flex flex-wrap gap-x-3 text-[12px] text-ink-300">
          {runners.map((r) => (
            <li key={r ?? ''} className="flex items-center gap-1.5">
              <span aria-hidden className="inline-block size-2 rounded-sm" style={swatch(fill, r)} />
              <span className={r ? 'font-mono text-[12px]' : ''}>{r ?? 'no runner'}</span>
            </li>
          ))}
        </ul>
      </div>
      <svg className="block w-full self-end overflow-visible" height={H} role="img" aria-label={`Runner minutes by hour; the busiest hour took ${runnerTime(peak * 60)}`}>
        <line x1={`${x(now)}%`} x2={`${x(now)}%`} y1={0} y2={H} stroke="var(--color-orbit)" strokeOpacity={0.6} />
        {Array.from({ length: hours }, (_, i) => {
          let y = H
          return rows.map((r) => {
            const v = r.minutes[i] ?? 0
            if (!v) return null
            const h = (scale(sums[i]!) * v) / sums[i]!
            y -= h
            return (
              <rect key={`${i}-${r.runner ?? ''}`} x={`${x(start + i * HOUR)}%`} y={y} width={`${width}%`} height={h} {...shade(fill, r.runner)} fillOpacity={i >= firstAhead ? 0.35 : 0.9}>
                <title>{`${new Date(start + i * HOUR).toLocaleString(undefined, { weekday: 'short', hour: 'numeric' })} · ${r.runner ?? 'no runner'} · ${runnerTime(v * 60)}${i >= firstAhead ? ' planned' : ''}`}</title>
              </rect>
            )
          })
        })}
      </svg>
    </div>
  )
}

/** The time under the lanes: hours for a day, days for a week, weeks for a month, and now. */
function Axis({ from, to, now, x, days }: { from: number; to: number; now: number; x: (ms: number) => number; days: number }) {
  const ticks: { at: number; label: string }[] = []
  const first = new Date(from)
  first.setMinutes(0, 0, 0)
  if (days === 1) {
    first.setHours(Math.ceil(first.getHours() / 3) * 3)
    for (let at = first.getTime(); at < to; at += 3 * HOUR) ticks.push({ at, label: new Date(at).toLocaleTimeString(undefined, { hour: 'numeric' }) })
  } else {
    first.setHours(24, 0, 0, 0)
    const step = days > 7 ? 7 : 1
    for (let d = new Date(first); d.getTime() < to; d.setDate(d.getDate() + step)) ticks.push({ at: d.getTime(), label: step === 1 ? d.toLocaleDateString(undefined, { weekday: 'short' }) : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) })
  }
  // A label is kept only where it has room: clear of the one before it, of "now", and of the edge.
  const [ref, width] = useWidth<HTMLDivElement>()
  const px = (at: number) => (x(at) / 100) * width
  const room = (label: string) => label.length * 7 + 12
  const nowAt = px(now)
  let edge = -Infinity
  const kept = ticks.filter((tk) => {
    const left = px(tk.at)
    const right = left + room(tk.label)
    if (left < edge || right > width || (right > nowAt - 4 && left < nowAt + room('now'))) return false
    edge = right
    return true
  })
  return (
    <div className={LANE_GRID} aria-hidden>
      <div className="hidden md:block" />
      <div ref={ref} className="relative h-6 text-[12px] text-ink-400">
        {width > 0 &&
          kept.map((tk) => (
            <span key={tk.at} className="absolute top-1 border-l border-ink-700 pl-1 leading-none whitespace-nowrap" style={{ left: `${x(tk.at)}%` }}>
              {tk.label}
            </span>
          ))}
        <span className="absolute top-1 border-l border-orbit pl-1 leading-none whitespace-nowrap text-orbit" style={{ left: `${x(now)}%` }}>
          now
        </span>
      </div>
    </div>
  )
}

/** An average day as a dial: the runner minutes the approved schedules ask in each hour of the reader's day, by runner, and what the ones waiting would add. */
function DayDial({ list, paint }: { list: ActionSchedule[]; paint: Paint }) {
  const offset = -new Date().getTimezoneOffset() / 60
  const active = plannedDay(list.filter((s) => s.state === 'active'), offset)
  const waiting = totals(plannedDay(list.filter((s) => s.state === 'awaiting'), offset), 24)
  const sums = totals(active, 24)
  const peak = Math.max(...sums, ...waiting, 0)
  const day = sums.reduce((a, b) => a + b, 0)
  const adds = waiting.reduce((a, b) => a + b, 0)
  const busiest = sums.indexOf(Math.max(...sums))
  const R0 = 120
  const R1 = 230
  const ang = (h: number) => (h / 24) * 2 * Math.PI - Math.PI / 2
  const pt = (h: number, r: number) => `${Math.cos(ang(h)) * r} ${Math.sin(ang(h)) * r}`
  const radius = (v: number) => (peak ? R0 + Math.sqrt(v / peak) * (R1 - R0) : R0)
  const wedge = (h: number, r0: number, r1: number) => `M ${pt(h + 0.08, r0)} L ${pt(h + 0.08, r1)} A ${r1} ${r1} 0 0 1 ${pt(h + 0.92, r1)} L ${pt(h + 0.92, r0)} A ${r0} ${r0} 0 0 0 ${pt(h + 0.08, r0)} Z`
  const hourName = (h: number) => new Date(2000, 0, 1, h).toLocaleTimeString(undefined, { hour: 'numeric' })
  const nowAt = new Date()
  const hand = nowAt.getHours() + nowAt.getMinutes() / 60
  return (
    <Panel className="px-4 py-4 md:px-5">
      <h2 className="text-base font-semibold text-ink-100">An average day</h2>
      <p className="mt-1 text-[12px] text-ink-400">The runner minutes your running schedules ask in each hour of your day. Dashed: what the ones waiting would add.</p>
      <svg viewBox="-300 -300 600 600" className="mx-auto mt-2 block w-full max-w-[22rem]" role="img" aria-label={`Runner minutes by hour of an average day: ${runnerTime(day * 60)} in all${day ? `, busiest at ${hourName(busiest)}` : ''}`}>
        <circle r={R0} fill="none" stroke="var(--color-grid)" />
        <circle r={R1} fill="none" stroke="var(--color-grid)" strokeDasharray="2 6" />
        {Array.from({ length: 24 }, (_, h) => (
          <line key={h} x1={Math.cos(ang(h)) * (R0 - 8)} y1={Math.sin(ang(h)) * (R0 - 8)} x2={Math.cos(ang(h)) * R0} y2={Math.sin(ang(h)) * R0} stroke="var(--color-line)" />
        ))}
        {sums.map((sum, h) => {
          if (!sum) return null
          let r = R0
          return active.map((row, i) => {
            const v = row.minutes[h] ?? 0
            if (!v) return null
            const r1 = r + ((radius(sum) - R0) * v) / sum
            const path = wedge(h, r, r1)
            r = r1
            return (
              <path key={`${h}-${row.runner ?? ''}`} d={path} {...shade(paint, row.runner)}>
                <title>{`${hourName(h)} · ${row.runner ?? 'no runner'} · ${runnerTime(v * 60)}`}</title>
              </path>
            )
          })
        })}
        {waiting.map((v, h) =>
          v ? (
            <path key={`w${h}`} d={wedge(h, R0, radius(sums[h]! + v))} fill="none" stroke="var(--color-amber)" strokeDasharray="4 3">
              <title>{`${hourName(h)} · waiting for approval would add ${runnerTime(v * 60)}`}</title>
            </path>
          ) : null,
        )}
        {[0, 6, 12, 18].filter((h) => Math.min(Math.abs(h - hand), 24 - Math.abs(h - hand)) > 1.5).map((h) => {
          const r = R1 + 38
          return (
            <text key={h} x={Math.cos(ang(h)) * r} y={Math.sin(ang(h)) * r} textAnchor="middle" dominantBaseline="middle" fill="var(--color-ink-400)" fontSize={26}>
              {h === 0 ? 'midnight' : h === 12 ? 'noon' : hourName(h)}
            </text>
          )
        })}
        <line x1={Math.cos(ang(hand)) * (R0 - 22)} y1={Math.sin(ang(hand)) * (R0 - 22)} x2={Math.cos(ang(hand)) * (R1 + 16)} y2={Math.sin(ang(hand)) * (R1 + 16)} stroke="var(--color-orbit)" strokeWidth={2}>
          <title>now</title>
        </line>
        <text x={Math.cos(ang(hand)) * (R1 + 38)} y={Math.sin(ang(hand)) * (R1 + 38)} textAnchor="middle" dominantBaseline="middle" fill="var(--color-orbit)" fontSize={24}>
          now
        </text>
        <text y={-34} textAnchor="middle" fill="var(--color-ink-50)" fontSize={52} fontFamily="var(--font-serif)">
          {runnerTime(day * 60)}
        </text>
        <text y={40} textAnchor="middle" fill="var(--color-ink-400)" fontSize={26}>
          a day
        </text>
      </svg>
      <ul className="mt-3 space-y-1 text-[13px]">
        {active.map((row, i) => (
          <li key={row.runner ?? ''} className="flex items-center gap-2">
            <span aria-hidden className="inline-block size-2.5 rounded-sm" style={swatch(paint, row.runner)} />
            <span className={row.runner ? 'font-mono text-[12px] text-ink-200' : 'text-ink-200'}>{row.runner ?? 'no runner'}</span>
            <span className="ml-auto text-ink-300">{runnerTime(row.minutes.reduce((a, b) => a + b, 0) * 60)} a day</span>
          </li>
        ))}
        {!active.length && <li className="text-ink-400">No running schedule asks a runner yet.</li>}
        {adds > 0 && <li className="text-amber">Waiting for approval would add {runnerTime(adds * 60)} a day.</li>}
      </ul>
      {day > 0 && (
        <details className="mt-2 text-[12px] text-ink-300">
          <summary className="cursor-pointer text-ink-300 hover:text-ink-100">Every hour, as a table</summary>
          <table className="mt-2 w-full">
            <thead>
              <tr className="text-left text-ink-400">
                <th className="font-medium">Hour</th>
                <th className="text-right font-medium">Runner time</th>
                {adds > 0 && <th className="text-right font-medium">Waiting would add</th>}
              </tr>
            </thead>
            <tbody>
              {sums.map((v, h) => (
                <tr key={h}>
                  <td>{hourName(h)}</td>
                  <td className="text-right">{v ? runnerTime(v * 60) : '·'}</td>
                  {adds > 0 && <td className="text-right">{waiting[h] ? runnerTime(waiting[h]! * 60) : '·'}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </Panel>
  )
}

/** The window's tally, said as a ledger: firings, runs, how they went, runner time, and the single schedules against the batches. */
function Ledger({ t, window }: { t: Tally; window: Window }) {
  const rate = successRate(t)
  const most = Math.max(t.single.seconds, t.batch.seconds, 1)
  const rows: [string, string, string?][] = [
    ['Schedules', n(t.schedules), standingWords(t.states, true).join(' · ')],
    ['Firings', n(t.firings), t.errors ? `${n(t.errors)} asked nothing` : undefined],
    ['Runs', n(t.runs), t.open ? `${n(t.open)} still open` : undefined],
    ['Succeeded', rate === null ? '—' : `${(rate * 100).toFixed(rate > 0.999 || rate < 0.001 ? 0 : 1)}%`, `${n(t.succeeded)} runs`],
    ['Failed', n(t.failed), t.failed ? undefined : 'none'],
    ['Runner time', runnerTime(t.seconds)],
  ]
  return (
    <Panel className="px-4 py-4 md:px-5">
      <h2 className="text-base font-semibold text-ink-100">
        {window.word[0]!.toUpperCase() + window.word.slice(1)}
      </h2>
      <dl className="mt-2 divide-y divide-ink-800">
        {rows.map(([k, v, note]) => (
          <div key={k} className="flex items-baseline gap-3 py-1.5">
            <dt className="text-[13px] text-ink-300">{k}</dt>
            <dd className={`ml-auto text-right text-[15px] font-medium ${k === 'Failed' && t.failed ? 'text-amber' : 'text-ink-50'}`}>
              {v}
              {note && <span className="block text-[12px] font-normal text-ink-400">{note}</span>}
            </dd>
          </div>
        ))}
      </dl>
      <h3 className="mt-4 text-[12px] font-medium text-ink-300">Single runs and batches</h3>
      <ul className="mt-1 space-y-2">
        {(
          [
            ['One run each time', t.single],
            ['A batch each time', t.batch],
          ] as const
        ).map(([label, k]) => (
          <li key={label} className="text-[13px]">
            <div className="flex items-baseline gap-2">
              <span className="text-ink-200">{label}</span>
              <span className="ml-auto text-ink-300">{plural(k.schedules, 'schedule')}</span>
            </div>
            <div className="mt-1 h-1.5 rounded-full bg-ink-800">
              <div className="h-full rounded-full bg-orbit" style={{ width: `${(k.seconds / most) * 100}%` }} />
            </div>
            <div className="mt-0.5 text-[12px] text-ink-400">
              {plural(k.firings, 'firing')} · {plural(k.runs, 'run')} · {runnerTime(k.seconds)}
            </div>
          </li>
        ))}
      </ul>
    </Panel>
  )
}
