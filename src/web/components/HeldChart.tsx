import { useState, type KeyboardEvent, type PointerEvent } from 'react'
import type { Budget } from '../../shared/api.ts'
import { count, dayAhead, type HeldTrend } from '../../shared/load-signals.ts'

/** How far ahead the chart looks, unless the limit is reached a little later. */
const AHEAD = 180
const W = 600
const H = 160
const PAD = 6
/** A budget line is drawn only while it sits this close above what is drawn, so the line it guards stays readable. */
const ROOM = 3

/** How many days ahead the chart draws: half a year, or on to the day the limit is reached when that is within the forecast. */
const aheadOf = (t: HeldTrend) => Math.min(t.forecast.length, Math.max(AHEAD, t.passes.limit === null ? 0 : t.passes.limit + 14))

/**
 * What a blueprint held, day by day, and where it goes at this pace, against
 * its warning and its limit. One line: solid for what happened, dashed for the
 * forecast. A pointer or the arrow keys read any day.
 */
export function HeldChart({ trend, budget, label }: { trend: HeldTrend; budget?: Budget; label: string }) {
  const ahead = aheadOf(trend)
  const past = trend.history.length
  const values = [...trend.history, ...trend.forecast.slice(0, ahead)]
  const top = Math.max(1, ...values)
  const lines = [budget?.warn, budget?.limit].filter((n): n is number => n !== undefined && n <= top * ROOM)
  const max = Math.max(top, ...lines) * 1.05
  const x = (i: number) => PAD + (i / Math.max(1, values.length - 1)) * (W - 2 * PAD)
  const y = (n: number) => H - PAD - (n / max) * (H - 2 * PAD)
  const path = (from: number, to: number) => values.slice(from, to).map((n, i) => `${i ? 'L' : 'M'}${x(from + i).toFixed(1)},${y(n).toFixed(1)}`).join('')
  const today = past - 1
  const [at, setAt] = useState<number | null>(null)
  const day = (i: number) => dayAhead(i - today)
  const read = (i: number) => `${day(i)}: ${count(values[i]!)} ${i > today ? 'at this pace' : i === today ? 'now' : 'held'}`
  const pick = (e: PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect()
    const i = Math.round((((e.clientX - box.left) / box.width) * W - PAD) / ((W - 2 * PAD) / (values.length - 1)))
    setAt(Math.max(0, Math.min(values.length - 1, i)))
  }
  const key = (e: KeyboardEvent<SVGSVGElement>) => {
    const step = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : e.key === 'PageDown' ? 7 : e.key === 'PageUp' ? -7 : 0
    if (!step) return
    e.preventDefault()
    setAt((now) => Math.max(0, Math.min(values.length - 1, (now ?? today) + step)))
  }
  const forecastShown = trend.forecast.length > 0
  return (
    <figure className="space-y-1.5">
      <figcaption className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-[12px] text-ink-400">
        <span className="font-medium text-ink-200">{label}</span>
        <span className="tabular-nums text-ink-100" aria-live="polite">
          {read(at ?? today)}
        </span>
      </figcaption>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="block h-40 w-full cursor-crosshair rounded-md bg-ink-900"
        role="img"
        aria-label={`${label}. ${read(today)}.${forecastShown ? ` ${read(values.length - 1)}.` : ''} Arrow keys read each day.`}
        tabIndex={0}
        onPointerMove={pick}
        onPointerLeave={() => setAt(null)}
        onKeyDown={key}
        onBlur={() => setAt(null)}
      >
        {budget?.warn !== undefined && lines.includes(budget.warn) && <line x1={0} x2={W} y1={y(budget.warn)} y2={y(budget.warn)} stroke="var(--color-amber)" strokeWidth={1.5} strokeDasharray="2 4" vectorEffect="non-scaling-stroke" />}
        {budget?.limit !== undefined && lines.includes(budget.limit) && <line x1={0} x2={W} y1={y(budget.limit)} y2={y(budget.limit)} stroke="var(--color-red)" strokeWidth={1.5} strokeDasharray="2 4" vectorEffect="non-scaling-stroke" />}
        <line x1={x(today)} x2={x(today)} y1={0} y2={H} stroke="var(--color-ink-700)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        <path d={`${path(0, past)}L${x(today).toFixed(1)},${H - PAD}L${x(0).toFixed(1)},${H - PAD}Z`} fill="var(--color-orbit)" opacity={0.12} />
        <path d={path(0, past)} fill="none" stroke="var(--color-orbit)" strokeWidth={2} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        {forecastShown && <path d={path(today, values.length)} fill="none" stroke="var(--color-orbit)" strokeWidth={2} strokeDasharray="6 5" opacity={0.7} vectorEffect="non-scaling-stroke" />}
        {at !== null && <line x1={x(at)} x2={x(at)} y1={0} y2={H} stroke="var(--color-ink-300)" strokeWidth={1} vectorEffect="non-scaling-stroke" />}
      </svg>
      <div className="relative h-4 text-[11px] text-ink-400 tabular-nums" aria-hidden>
        <span className="absolute left-0">{day(0)}</span>
        <span className="absolute -translate-x-1/2" style={{ left: `${(x(today) / W) * 100}%` }}>
          Today
        </span>
        {forecastShown && <span className="absolute right-0">{day(values.length - 1)}</span>}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-ink-300">
        <li className="flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-4 bg-orbit" aria-hidden />
          Held
        </li>
        {forecastShown && (
          <li className="flex items-center gap-1.5">
            <span className="inline-block w-4 border-t-2 border-dashed border-orbit" aria-hidden />
            At the last four weeks’ pace
          </li>
        )}
        {budget?.warn !== undefined && (
          <li className="flex items-center gap-1.5">
            <span className="inline-block w-4 border-t-2 border-dotted border-amber" aria-hidden />
            Warns at {count(budget.warn)}
            {!lines.includes(budget.warn) && ', above the chart'}
          </li>
        )}
        {budget?.limit !== undefined && (
          <li className="flex items-center gap-1.5">
            <span className="inline-block w-4 border-t-2 border-dotted border-red" aria-hidden />
            Refuses at {count(budget.limit)}
            {!lines.includes(budget.limit) && ', above the chart'}
          </li>
        )}
      </ul>
    </figure>
  )
}

/** What a blueprint held over its history, as a line small enough for a table row. */
export function HeldSpark({ trend }: { trend: HeldTrend }) {
  const h = trend.history
  const max = Math.max(1, ...h)
  const min = Math.min(...h)
  const span = Math.max(1, max - min)
  const d = h.map((n, i) => `${i ? 'L' : 'M'}${((i / Math.max(1, h.length - 1)) * 96 + 2).toFixed(1)},${(22 - ((n - min) / span) * 20).toFixed(1)}`).join('')
  return (
    <svg viewBox="0 0 100 24" preserveAspectRatio="none" className="inline-block h-5 w-24 align-middle" aria-hidden>
      <path d={d} fill="none" stroke="var(--color-orbit)" strokeWidth={1.5} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}
