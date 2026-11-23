// One thing and its neighbours, one step out, in a ring around it: a graph
// small enough to read on a phone. A neighbour is a button; picking one is the
// caller's to answer, usually by putting it in the middle.

import type { ReactNode } from 'react'
import type { StatusLevel } from '../../shared/model.ts'
import { Lamp } from './ui.tsx'

export interface OrbitNode {
  id: string
  title: string
  icon: ReactNode
  /** What joins it to the middle, said when it is focused: the relation's name. */
  caption: string
  /** `out` when the middle points at it, `in` when it points at the middle. */
  direction: 'out' | 'in'
  level?: StatusLevel
  onPick: () => void
}

/** The most neighbours the ring holds; the rest are counted beneath it. */
const RING = 8
/** How far the ring stands from the middle, in hundredths of the picture. */
const RADIUS = 37

export function Orbit({ title, icon, level, nodes }: { title: string; icon: ReactNode; level?: StatusLevel; nodes: OrbitNode[] }) {
  const shown = nodes.slice(0, RING)
  const more = nodes.length - shown.length
  // The first neighbour stands at the top, the rest round clockwise.
  const at = (i: number) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * i) / Math.max(shown.length, 1)
    return { x: 50 + RADIUS * Math.cos(angle), y: 50 + RADIUS * Math.sin(angle) }
  }
  return (
    <>
    <div role="group" aria-label={`What ${title} is joined to`} className="relative mx-auto aspect-square w-full max-w-[380px]">
      <svg viewBox="0 0 100 100" className="absolute inset-0 size-full" aria-hidden>
        <circle cx="50" cy="50" r={RADIUS} fill="none" stroke="var(--color-line)" strokeWidth="0.3" strokeDasharray="1 1.5" />
        {shown.map((n, i) => {
          const p = at(i)
          return <line key={n.id} x1="50" y1="50" x2={p.x} y2={p.y} stroke="var(--color-line)" strokeWidth="0.4" strokeDasharray={n.direction === 'in' ? '1.2 1' : undefined} />
        })}
      </svg>
      <div className="absolute top-1/2 left-1/2 flex w-32 -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-1.5 text-center">
        <span className="relative grid size-16 place-items-center rounded-2xl border border-orbit/50 bg-ink-850 text-ink-100 elevate-pop">
          {icon}
        </span>
        {/* The middle's status beside its name, clear of every spoke. */}
        <span className="flex items-center gap-1.5 rounded-md bg-ink-900/90 px-1.5 text-sm font-semibold text-ink-100">
          {level && <Lamp level={level} calm />}
          <span className="line-clamp-2">{title}</span>
        </span>
      </div>
      {shown.map((n, i) => {
        const p = at(i)
        return (
          <button key={n.id} type="button" onClick={n.onPick} aria-label={`${n.title}: ${n.caption}${n.direction === 'in' ? ', pointing here' : ''}`} className="absolute flex w-[84px] -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-1 rounded-lg p-1 text-center" style={{ left: `${p.x}%`, top: `${p.y}%` }}>
            <span className="relative grid size-11 place-items-center rounded-xl border border-ink-600 bg-ink-850 text-ink-200">
              {n.icon}
              {n.level && <Lamp level={n.level} className="absolute -top-1 -right-1" calm />}
            </span>
            <span className="rounded-md bg-ink-900/90 px-1 text-[12px] leading-tight font-medium break-words text-ink-200">{n.title}</span>
          </button>
        )
      })}
    </div>
    {more > 0 && <p className="mt-1 text-center text-[13px] text-ink-400">and {more} more in Connections</p>}
    </>
  )
}
