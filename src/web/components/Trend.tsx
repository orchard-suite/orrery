import { useState, type MouseEvent } from 'react'
import type { TrendValue } from '../../shared/model.ts'
import { Popover } from './Popover.tsx'
import { External } from './ui.tsx'

/** Whether a value is a trend a field may hold. The hub checks every write; this only guards what is drawn. */
export function isTrend(v: unknown): v is TrendValue {
  return !!v && typeof v === 'object' && Array.isArray((v as TrendValue).points)
}

interface Frame {
  from: number
  to: number
  min: number
  max: number
}

function frameOf(t: TrendValue): Frame {
  const times = t.points.map((p) => Date.parse(p.at))
  const values = t.points.map((p) => p.value)
  const from = t.from ? Date.parse(t.from) : Math.min(...times)
  const to = t.to ? Date.parse(t.to) : Math.max(...times)
  const min = t.min ?? Math.min(...values)
  const max = t.max ?? Math.max(...values)
  return { from, to: to > from ? to : from + 1, min, max: max > min ? max : min + 1 }
}

/** The line's path in a box of w by h: steps held to `to` for a step trend, joined points otherwise. A point before `from` starts at `from`. */
function pathOf(t: TrendValue, f: Frame, w: number, h: number, pad: number): string {
  const x = (at: number) => pad + ((Math.max(at, f.from) - f.from) / (f.to - f.from)) * (w - 2 * pad)
  const y = (v: number) => pad + (1 - (v - f.min) / (f.max - f.min)) * (h - 2 * pad)
  let d = ''
  t.points.forEach((p, i) => {
    const px = x(Date.parse(p.at))
    const py = y(p.value)
    if (i === 0) d += `M${px.toFixed(1)},${py.toFixed(1)}`
    else if (t.step) d += `H${px.toFixed(1)}V${py.toFixed(1)}`
    else d += `L${px.toFixed(1)},${py.toFixed(1)}`
  })
  if (t.step && t.points.length) d += `H${x(f.to).toFixed(1)}`
  return d
}

/** Where the line ends: the last value, at `to` for a step trend, so a trend of one point still shows. */
function endOf(t: TrendValue, f: Frame, w: number, h: number, pad: number): { cx: number; cy: number } | null {
  const last = t.points.at(-1)
  if (!last) return null
  const at = t.step ? f.to : Date.parse(last.at)
  return { cx: pad + ((Math.max(at, f.from) - f.from) / (f.to - f.from)) * (w - 2 * pad), cy: pad + (1 - (last.value - f.min) / (f.max - f.min)) * (h - 2 * pad) }
}

const label = (t: TrendValue, v: number) => t.labels?.[String(v)] ?? `${Number.isInteger(v) ? v : v.toFixed(1)}${t.unit ?? ''}`
const day = (ms: number) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })

/** What the trend says in words: where it began and where it is now, for a reader and for a screen reader. */
export function trendSummary(t: TrendValue): string {
  if (!t.points.length) return 'No points yet'
  const first = t.points[0]!
  const last = t.points.at(-1)!
  const since = day(Date.parse(first.at))
  return t.points.length === 1 ? `${label(t, last.value)} since ${since}` : `${label(t, first.value)} to ${label(t, last.value)} since ${since}`
}

function End({ at, r }: { at: { cx: number; cy: number } | null; r: number }) {
  return at ? <circle cx={at.cx} cy={at.cy} r={r} fill="var(--color-orbit)" /> : null
}

/** A small line for a grid cell. A press opens the chart. */
export function TrendCell({ value }: { value: TrendValue }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const f = frameOf(value)
  const w = 96
  const h = 22
  const open = (ev: MouseEvent<HTMLButtonElement>) => {
    ev.stopPropagation()
    setAnchor(ev.currentTarget)
  }
  return (
    <>
      <button type="button" onClick={open} className="inline-flex items-center rounded-sm px-0.5 hover:bg-ink-700" title={trendSummary(value)} aria-label={`Trend: ${trendSummary(value)}. Open the chart`}>
        <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden className="block overflow-visible">
          {value.points.length > 0 && <path d={pathOf(value, f, w, h, 2)} fill="none" stroke="var(--color-orbit)" strokeWidth={1.5} strokeLinejoin="round" />}
          <End at={endOf(value, f, w, h, 2)} r={2} />
        </svg>
      </button>
      {anchor && (
        <Popover anchor={anchor} width={460} onClose={() => setAnchor(null)} label="Trend">
          <div className="p-3" onClick={(ev) => ev.stopPropagation()}>
            <TrendChart value={value} />
          </div>
        </Popover>
      )}
    </>
  )
}

/** The chart: the line on labelled axes, what it says in words, and the link to where its full history is. */
export function TrendChart({ value }: { value: TrendValue }) {
  const f = frameOf(value)
  const w = 440
  const h = 150
  const left = 64
  const bottom = 20
  const pad = 6
  const ticks = value.labels ? Object.keys(value.labels).map(Number).filter((n) => n >= f.min && n <= f.max).sort((a, b) => a - b) : [f.min, (f.min + f.max) / 2, f.max]
  const y = (v: number) => pad + (1 - (v - f.min) / (f.max - f.min)) * (h - bottom - 2 * pad)
  return (
    <figure className="flex flex-col gap-2">
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full" role="img" aria-label={trendSummary(value)}>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={left} x2={w} y1={y(v)} y2={y(v)} stroke="var(--color-ink-700)" />
            <text x={left - 8} y={y(v) + 4} textAnchor="end" className="fill-ink-400 font-mono text-[10px]">
              {label(value, v)}
            </text>
          </g>
        ))}
        <text x={left} y={h - 4} className="fill-ink-400 font-mono text-[10px]">
          {day(f.from)}
        </text>
        <text x={w} y={h - 4} textAnchor="end" className="fill-ink-400 font-mono text-[10px]">
          {day(f.to)}
        </text>
        <g transform={`translate(${left},0)`}>
          {value.points.length > 0 && <path d={pathOf(value, f, w - left, h - bottom, pad)} fill="none" stroke="var(--color-orbit)" strokeWidth={2} strokeLinejoin="round" />}
          <End at={endOf(value, f, w - left, h - bottom, pad)} r={3} />
        </g>
      </svg>
      <figcaption className="flex items-center justify-between gap-3 text-[13px] text-ink-300">
        <span>{trendSummary(value)}</span>
        {value.link && (
          <External href={value.link} className="shrink-0 text-orbit hover:underline">
            {value.link_title ?? 'Full history'}
          </External>
        )}
      </figcaption>
    </figure>
  )
}
