// The estate as an orrery: the sun in the middle is everything, each area of
// the catalog is a sector around it, and each kind is a planet in its area,
// as big as how many there are and drawn in the shape and colour of its
// worst status. A sector is a button: choosing one opens its kinds by name
// below. Only the chosen area's failing kinds carry a number on the sky, the
// same number their rows carry in the list, so names never pile up; every
// planet says what it is on hover. When the reader owns
// things, their kinds glow and their areas carry an arc, in the one colour
// that means "yours". In zen mode every kind is a quiet dot and nothing on
// the sky speaks of status. A kind that has a ground carries a thin arc round its
// planet, as long as the share of its entities inside every budget, and is a
// link of its own: choosing it zooms the sky toward the planet once, then
// opens the ground.

import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { GroundCover } from '../../shared/ground.ts'
import type { StatusLevel } from '../../shared/model.ts'
import { coverText } from '../ground.ts'
import { numbered, type Area, type Kind } from '../now.ts'
import { Lamp, LEVEL_FILL, LEVEL_NAME } from './ui.tsx'
import { useZen } from '../zen.ts'

/** The picture's own units; text is sized from the width it is drawn at, so it reads the same on a phone and a desk. */
const S = 720
const C = S / 2
const INNER = 92
const OUTER = 292
const RINGS = [138, 196, 254]
const LABEL = 318

const FILL = LEVEL_FILL

const polar = (r: number, a: number) => ({ x: C + r * Math.cos(a), y: C + r * Math.sin(a) })

/** An annular sector from angle a0 to a1 between radii r0 and r1, as a path. */
function wedge(r0: number, r1: number, a0: number, a1: number): string {
  const p = [polar(r1, a0), polar(r1, a1), polar(r0, a1), polar(r0, a0)]
  const large = a1 - a0 > Math.PI ? 1 : 0
  return `M${p[0]!.x},${p[0]!.y} A${r1},${r1} 0 ${large} 1 ${p[1]!.x},${p[1]!.y} L${p[2]!.x},${p[2]!.y} A${r0},${r0} 0 ${large} 0 ${p[3]!.x},${p[3]!.y} Z`
}

/** A planet's radius: a log of the count, so 1 and 2,175 both show and neither swamps the sky. */
export const planetRadius = (count: number) => (count ? 3.5 + 3.4 * Math.log10(count + 1) : 3.5)

/** Where each kind of an area sits: biggest first, dealt round the three orbits, spread across the sector. */
export function placeKinds(kinds: Kind[], a0: number, a1: number): { kind: Kind; x: number; y: number; r: number }[] {
  const sorted = [...kinds].sort((a, b) => b.count - a.count)
  const rings = RINGS.map((_, k) => sorted.filter((_, i) => i % RINGS.length === k))
  const pad = Math.min(0.06, (a1 - a0) / 6)
  return rings.flatMap((list, k) =>
    list.map((kind, j) => {
      const a = a0 + pad + ((a1 - a0 - 2 * pad) * (j + 0.5 + (k % 2) * 0.25)) / (list.length + (k % 2) * 0.25)
      return { kind, ...polar(RINGS[k]!, a), r: planetRadius(kind.count) }
    }),
  )
}

/** How far a planet reaches from its centre: a diamond's corner is r times the root of two out. */
const reachOf = (r: number, level: StatusLevel) => r * (level === 'red' ? Math.SQRT2 : 1)

/** How far a glow spreads past the planet it lights. */
const GLOW = 8

/**
 * The light round a kind the reader owns: solid from the planet's edge and
 * fading to nothing. Every glow of an area is drawn before its planets, so
 * glows that meet blend into one and never cover a planet.
 */
function Glow({ id, x, y, r, level }: { id: string; x: number; y: number; r: number; level: StatusLevel }) {
  const reach = reachOf(r, level)
  const edge = reach / (reach + GLOW)
  return (
    <>
      <radialGradient id={id} gradientUnits="userSpaceOnUse" cx={x} cy={y} r={reach + GLOW}>
        <stop offset={0} stopColor="var(--color-orbit)" stopOpacity={0} />
        <stop offset={edge * 0.9} stopColor="var(--color-orbit)" stopOpacity={0} />
        <stop offset={edge} stopColor="var(--color-orbit)" stopOpacity={0.55} />
        <stop offset={1} stopColor="var(--color-orbit)" stopOpacity={0} />
      </radialGradient>
      <circle cx={x} cy={y} r={reach + GLOW} fill={`url(#${id})`} />
    </>
  )
}

/** A kind on the sky: the shape and colour of its worst status, or, `calm` in zen mode, a quiet dot that says nothing of it. */
function Planet({ x, y, r, level, empty, lit, calm }: { x: number; y: number; r: number; level: StatusLevel; empty: boolean; lit: boolean; calm: boolean }) {
  const ring = lit && <circle cx={x} cy={y} r={reachOf(r, level) + 5} fill="none" stroke="var(--color-ink-100)" strokeWidth={1.5} />
  if (calm && !empty) return <>{ring}<circle cx={x} cy={y} r={r} fill="var(--color-calm)" fillOpacity={0.7} /></>
  if (empty || level === 'grey') return <>{ring}<circle cx={x} cy={y} r={r} fill="none" stroke={empty ? 'var(--color-ink-500)' : FILL.grey} strokeWidth={1.5} /></>
  if (level === 'red') return <>{ring}<rect x={x - r} y={y - r} width={2 * r} height={2 * r} rx={1.5} transform={`rotate(45 ${x} ${y})`} fill={FILL.red} /></>
  if (level === 'amber') return <>{ring}<rect x={x - r * 0.9} y={y - r * 0.9} width={1.8 * r} height={1.8 * r} rx={1.5} fill={FILL.amber} /></>
  return <>{ring}<circle cx={x} cy={y} r={r} fill={FILL.green} fillOpacity={0.7} /></>
}

/** Where each area's sector starts and ends: as wide as a log of how many things it holds, so a big area has room and an empty one still shows. */
export function spans(areas: Area[]): { a0: number; a1: number }[] {
  const weight = areas.map((a) => Math.max(0.9, Math.log10(a.count + 1)))
  const sum = weight.reduce((x, y) => x + y, 0) || 1
  let at = -Math.PI / 2
  return weight.map((w) => {
    const a0 = at
    at += (2 * Math.PI * w) / sum
    return { a0, a1: at }
  })
}

/** How long the sky takes to close on a planet before its ground opens. It moves once and stops. */
const LAND_MS = 420
/** How many times its size the sky grows as it closes on a planet. */
const LAND_ZOOM = 5

/** A relation between two kinds. The sky bundles them into one arc for each pair of areas they join. */
export interface Link {
  from: string
  to: string
}

/**
 * How the sky is framed when drawn this many pixels wide: whether the area
 * names fit round its edge, the room left for them, and how many of the
 * picture's units make one pixel.
 */
function frame(width: number) {
  // Too narrow for the names round the edge, the sky draws only itself, and the areas are chips beneath it.
  const named = width >= NAMED
  // Room round the edge for the widest name, about LABEL_PX wide however small the sky is drawn.
  const margin = named ? Math.max(MARGIN, (LABEL_PX * S) / Math.max(width - 2 * LABEL_PX, 1)) : 12
  // How many of the picture's units make one pixel where it is drawn: text set in px stays that size.
  const px = (S + 2 * margin) / Math.max(width, 1)
  // Above and below, the names need only their few lines of room, not a side's width.
  const tall = named ? Math.max(12, LABEL + 62 * px - C) : 12
  return { named, margin, px, tall, height: (width * (S + 2 * tall)) / (S + 2 * margin) }
}

/** The widest the sky may be drawn in a box this size, so all of it, chips included, stays inside: named round its edge when that fits at all. */
function fitWidth(box: number, high: number): number {
  const fits = (w: number) => {
    const f = frame(w)
    return f.height + (f.named ? 0 : CHIPS) <= high
  }
  // The widest that fits between lo and hi, where height only grows with width.
  const widest = (lo: number, hi: number) => {
    if (fits(hi)) return hi
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2
      if (fits(mid)) lo = mid
      else hi = mid
    }
    return Math.floor(lo)
  }
  // Named and unnamed are two ranges: the names take room, so the narrowest named sky is taller than the widest bare one.
  if (box >= NAMED && fits(NAMED)) return widest(NAMED, box)
  return widest(0, Math.min(box, NAMED - 1))
}

export function Sky({ areas, total, level, selected, onSelect, lit, links = [], whole = true, yours = null, fit = false, ground, onLand }: { areas: Area[]; total: number; level: StatusLevel; /** How many of each kind are the reader's own, when the hub knows. */ yours?: Record<string, { count: number; notGreen: { red: number } }> | null; /** Whether the reader sees the whole estate, or only what is shared with them. */ whole?: boolean; selected: string | null; onSelect: (area: string) => void; lit: string | null; links?: Link[]; /** Whether the sky fills the height of its box too, drawn as big as fits and centred, rather than the box's width alone. */ fit?: boolean; /** The kinds that have a ground, each with how much of it is inside its budgets. */ ground?: Record<string, GroundCover>; /** Opens the ground of a kind, once the sky has closed on its planet. */ onLand?: (kind: string) => void }) {
  const box = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(S)
  // The planet the sky is closing on, once chosen: the sky grows toward it one time, then its ground opens.
  const [landing, setLanding] = useState<{ kind: string; x: number; y: number } | null>(null)
  const landed = useRef(onLand)
  landed.current = onLand
  useEffect(() => {
    if (!landing) return
    const timer = setTimeout(() => landed.current?.(landing.kind), LAND_MS)
    return () => clearTimeout(timer)
  }, [landing])
  const land = (p: { kind: Kind; x: number; y: number }) => {
    // No movement for a reader who asked for none: the ground opens at once.
    if (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches) return onLand?.(p.kind.id)
    setLanding({ kind: p.kind.id, x: p.x, y: p.y })
  }
  // The chosen area's chip scrolls into view in its row, so the row never hides what the sky shows.
  const chip = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const el = chip.current
    const row = el?.parentElement
    // Centred in its row, so the chips either side show it is one of several.
    if (el && row) row.scrollLeft = Math.max(0, el.offsetLeft - row.offsetLeft - (row.clientWidth - el.offsetWidth) / 2)
  }, [selected, width])
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const watch = new ResizeObserver(() => setWidth(fit && el.clientHeight ? fitWidth(el.clientWidth, el.clientHeight) : el.clientWidth || S))
    watch.observe(el)
    return () => watch.disconnect()
  }, [fit])
  const { named, margin, px, tall } = frame(width)
  const arcs = spans(areas)
  const chosen = areas.find((a) => a.name === selected)
  // Where each area's name stands: at the middle of its sector, pushed apart from its neighbours until a name's lines never meet the next one's.
  // A name beside the sky needs its height of room; one above or below it, its width.
  const sep = (a: number) => ((Math.abs(Math.cos(a)) > 0.5 ? 3 * 17 + 34 : LABEL_PX + 16) * px) / LABEL
  const at = arcs.map(({ a0, a1 }) => (a0 + a1) / 2)
  for (let pass = 0; pass < 60; pass++) {
    for (let i = 0; i < at.length && at.length > 1; i++) {
      const j = (i + 1) % at.length
      const gap = (((at[j]! - at[i]!) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
      const need = Math.max(sep(at[i]!), sep(at[j]!))
      if (gap >= need) continue
      at[i] = at[i]! - (need - gap) / 2
      at[j] = at[j]! + (need - gap) / 2
    }
  }
  const glowId = `glow${useId().replace(/[^a-zA-Z0-9]/g, '')}`
  // Zen mode draws the sky still: every kind a quiet dot, and no word, number, or ring of what fails.
  const zen = useZen()
  const shape = (l: StatusLevel): StatusLevel => (zen ? 'green' : l)
  const says = (l: StatusLevel) => (zen ? '' : `, ${LEVEL_NAME[l]}`)
  const placedBy = new Map(areas.flatMap((area, i) => placeKinds(area.kinds, arcs[i]!.a0, arcs[i]!.a1).map((p) => [p.kind.id, p] as const)))
  // Whether a point, with room round it, lies within the sector of the area a kind belongs to.
  const sectorOf = new Map(areas.flatMap((a, i) => a.kinds.map((k) => [k.id, arcs[i]!] as const)))
  const inside = (kind: string, at: { x: number; y: number }, room: number) => {
    const span = sectorOf.get(kind)
    if (!span) return true
    const r = Math.hypot(at.x - C, at.y - C)
    const slack = Math.asin(Math.min(1, room / Math.max(r, 1)))
    let a = Math.atan2(at.y - C, at.x - C)
    while (a < span.a0) a += 2 * Math.PI
    return a - slack >= span.a0 && a + slack <= span.a1
  }
  // The chosen area's failing kinds, numbered as its list numbers them.
  const marked = chosen && !zen ? numbered(chosen).map((k) => placedBy.get(k.id)!).filter(Boolean) : []
  const keys = (event: KeyboardEvent, area: string) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onSelect(area)
    }
  }
  return (
    <div ref={box} className={`${fit ? 'flex h-full w-full flex-col items-center justify-center' : 'w-full'} ${landing ? 'overflow-hidden' : ''}`}>
      <svg
        style={{
          ...(fit ? { width } : {}),
          ...(landing ? { transform: `scale(${LAND_ZOOM})`, transformOrigin: `${(100 * (landing.x + margin)) / (S + 2 * margin)}% ${(100 * (landing.y + tall)) / (S + 2 * tall)}%`, opacity: 0, transition: `transform ${LAND_MS}ms cubic-bezier(0.5, 0, 0.9, 0.4), opacity ${LAND_MS}ms ease-in` } : {}),
        }}
        viewBox={`${-margin} ${-tall} ${S + 2 * margin} ${S + 2 * tall}`} className={`block h-auto ${fit ? 'shrink-0' : 'w-full'}`} role="group" aria-label={`${whole ? 'The estate' : 'What you can see'}: ${total.toLocaleString('en-US')} things in ${areas.length} areas. Choose an area to list its kinds.`}>
        <circle cx={C} cy={C} r={OUTER} fill="none" stroke="var(--color-grid)" strokeWidth={1} />
        {RINGS.map((r) => (
          <circle key={r} cx={C} cy={C} r={r} fill="none" stroke="var(--color-grid)" strokeWidth={1} strokeDasharray="2 5" />
        ))}
        {/* How the chosen area joins the others: one arc to each area it shares relations with, as thick as how many. */}
        {(() => {
          const from = areas.findIndex((x) => x.name === selected)
          if (from < 0) return null
          const areaOf = new Map(areas.flatMap((x, i) => x.kinds.map((k) => [k.id, i] as const)))
          const toward = new Map<number, number>()
          for (const l of links) {
            const a = areaOf.get(l.from)
            const b = areaOf.get(l.to)
            if (a === undefined || b === undefined || a === b) continue
            const other = a === from ? b : b === from ? a : -1
            if (other >= 0) toward.set(other, (toward.get(other) ?? 0) + 1)
          }
          const litArea = lit ? areaOf.get(lit) : undefined
          const p0 = polar(RINGS[1]!, at[from]!)
          return [...toward].map(([to, n]) => {
            const p1 = polar(RINGS[1]!, at[to]!)
            const cx = C + ((p0.x + p1.x) / 2 - C) * 0.15
            const cy = C + ((p0.y + p1.y) / 2 - C) * 0.15
            const on = litArea === to
            return <path key={to} d={`M${p0.x},${p0.y} Q${cx},${cy} ${p1.x},${p1.y}`} fill="none" stroke={on ? 'var(--color-orbit)' : 'var(--color-ink-500)'} strokeOpacity={on ? 0.95 : 0.55} strokeWidth={(1.5 + Math.log2(n)) * 2} strokeLinecap="round" pointerEvents="none"><title>{`${n} ${n === 1 ? 'relation' : 'relations'} between ${areas[from]!.name} and ${areas[to]!.name}`}</title></path>
          })
        })()}
        {areas.map((area, i) => {
          const { a0, a1 } = arcs[i]!
          const mid = at[i]!
          const on = area.name === selected
          const label = polar(LABEL + (Math.abs(Math.sin(mid)) > 0.9 ? 6 : 0), mid)
          const anchor = Math.cos(mid) > 0.25 ? 'start' : Math.cos(mid) < -0.25 ? 'end' : 'middle'
          const below = Math.sin(mid) > 0.25
          const bad = area.notGreen.red + area.notGreen.amber
          const placed = area.kinds.map((k) => placedBy.get(k.id)!)
          const theirs = area.kinds.reduce((n, k) => n + (yours?.[k.id]?.count ?? 0), 0)
          return (
            <g key={area.name} role="button" tabIndex={0} aria-pressed={on} aria-label={`${area.name}: ${area.count.toLocaleString('en-US')} things in ${area.kinds.length} kinds${says(area.level)}${theirs ? `, ${theirs.toLocaleString('en-US')} yours` : ''}`} onClick={() => onSelect(area.name)} onKeyDown={(e) => keys(e, area.name)} className="cursor-pointer outline-none [&:focus-visible>path:first-child]:stroke-orbit">
              <path d={wedge(INNER, OUTER, a0 + 0.008, a1 - 0.008)} fill={on ? 'var(--color-ink-800)' : 'transparent'} stroke={on ? 'var(--color-ink-600)' : 'transparent'} strokeWidth={1.5} className="transition-colors hover:fill-[var(--color-ink-850)]" />
              {theirs > 0 && <path d={`M${polar(OUTER, a0 + 0.02).x},${polar(OUTER, a0 + 0.02).y} A${OUTER},${OUTER} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${polar(OUTER, a1 - 0.02).x},${polar(OUTER, a1 - 0.02).y}`} fill="none" stroke="var(--color-orbit)" strokeWidth={5} strokeLinecap="round" pointerEvents="none" />}
              <line x1={polar(INNER, a0).x} y1={polar(INNER, a0).y} x2={polar(OUTER, a0).x} y2={polar(OUTER, a0).y} stroke="var(--color-grid)" strokeWidth={1} />
              <g pointerEvents="none">
                {placed.map((p, j) => yours?.[p.kind.id] && <Glow key={p.kind.id} id={`${glowId}-${i}-${j}`} x={p.x} y={p.y} r={p.r} level={shape(p.kind.level)} />)}
              </g>
              {placed.map((p) => (
                <g key={p.kind.id}>
                  <title>{`${p.kind.title}: ${p.kind.count.toLocaleString('en-US')}${says(p.kind.level)}${yours?.[p.kind.id] ? `, ${yours[p.kind.id]!.count.toLocaleString('en-US')} yours` : ''}`}</title>
                  <Planet x={p.x} y={p.y} r={p.r} level={shape(p.kind.level)} empty={!p.kind.count} lit={lit === p.kind.id} calm={zen} />
                </g>
              ))}
              {named && (
                <>
              {(() => {
                // A two-word name too wide for one line takes two; the count and what needs a look follow, a line each.
                const lines = area.name.length > 11 && area.name.includes(' ') ? area.name.split(/ (.*)/s).filter(Boolean) : [area.name]
                const issue = zen ? '' : area.notGreen.red ? `${area.notGreen.red} failing` : area.notGreen.amber ? `${area.notGreen.amber} to look at` : ''
                const rows = lines.length + 1 + (issue ? 1 : 0)
                const top = below ? label.y + 12 * px : Math.sin(mid) < -0.25 ? label.y - (rows - 1) * 17 * px : label.y - ((rows - 1) * 17 * px) / 2
                return (
                  <text x={label.x} y={top} textAnchor={anchor} fontSize={12 * px} fill="var(--color-ink-400)">
                    {lines.map((l, j) => (
                      <tspan key={l} x={label.x} dy={j === 0 ? 0 : 17 * px} fontSize={13 * px} fontWeight={600} fill={on ? 'var(--color-ink-50)' : 'var(--color-ink-200)'}>
                        {l}
                      </tspan>
                    ))}
                    <tspan x={label.x} dy={17 * px}>
                      {area.count.toLocaleString('en-US')}
                      {theirs > 0 && (
                        <tspan fill="var(--color-orbit)" fontWeight={600}>
                          {theirs === area.count ? ' · all yours' : ` · ${theirs.toLocaleString('en-US')} yours`}
                        </tspan>
                      )}
                    </tspan>
                    {issue && (
                      <tspan x={label.x} dy={17 * px} fill={area.notGreen.red ? 'var(--color-red)' : 'var(--color-amber)'}>
                        {issue}
                      </tspan>
                    )}
                  </text>
                )
              })()}
                </>
              )}
            </g>
          )
        })}
        {/* The chosen area's failing kinds carry a number on the sky, and their rows the same number in the list, so no name ever sits on the plot. */}
        {marked.map((p, n) => {
          // Clear of the planet's widest point (a diamond's corner reaches r times the root of two), straight out from the sun so it stays in
          // its own sector; turned a little either way when that spot would touch another planet.
          const d = p.r * Math.SQRT2 + 12 * px
          const base = Math.atan2(p.y - C, p.x - C)
          const spot = [0, 0.45, -0.45, 0.9, -0.9]
            .map((turn) => ({ x: p.x + d * Math.cos(base + turn), y: p.y + d * Math.sin(base + turn) }))
            .find((at) => inside(p.kind.id, at, 10 * px) && [...placedBy.values()].every((q) => q === p || Math.hypot(q.x - at.x, q.y - at.y) > q.r * Math.SQRT2 + 10 * px)) ?? { x: p.x + d * Math.cos(base), y: p.y + d * Math.sin(base) }
          const { x, y } = spot
          const red = p.kind.level === 'red'
          return (
            <g key={`mark:${p.kind.id}`} pointerEvents="none">
              <circle cx={x} cy={y} r={9 * px} fill="var(--color-ink-900)" stroke={red ? 'var(--color-red)' : 'var(--color-ink-400)'} strokeWidth={1.5} />
              <text x={x} y={y + 4 * px} textAnchor="middle" fontSize={12 * px} fontWeight={600} fill={red ? 'var(--color-red)' : 'var(--color-ink-100)'}>
                {n + 1}
              </text>
            </g>
          )
        })}
        {/* A kind with a ground is a link of its own, drawn over its sector: the arc round it is the share of its entities inside every budget. */}
        {ground && onLand && [...placedBy.values()].filter((p) => ground[p.kind.id]).map((p) => {
          const g = ground[p.kind.id]!
          const r = reachOf(p.r, shape(p.kind.level)) + 4.5
          const share = g.share ?? 0
          // From the top, clockwise; a full ring is two half arcs, since an arc cannot end where it starts.
          const end = { x: p.x + r * Math.sin(2 * Math.PI * share), y: p.y - r * Math.cos(2 * Math.PI * share) }
          const arc = share >= 0.999 ? `M${p.x},${p.y - r} A${r},${r} 0 1 1 ${p.x},${p.y + r} A${r},${r} 0 1 1 ${p.x},${p.y - r}` : `M${p.x},${p.y - r} A${r},${r} 0 ${share > 0.5 ? 1 : 0} 1 ${end.x},${end.y}`
          const says = `Ground of ${p.kind.title}: ${coverText(g)}`
          return (
            <g
              key={`ground:${p.kind.id}`}
              role="link"
              tabIndex={0}
              aria-label={says}
              onClick={() => land(p)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' && e.key !== ' ') return
                e.preventDefault()
                land(p)
              }}
              className="cursor-pointer outline-none [&:focus-visible>circle:first-of-type]:stroke-orbit [&:hover>circle:first-of-type]:stroke-ink-300"
            >
              <title>{says}</title>
              {/* Big enough to press: at least 24 pixels across however small the planet is. */}
              <circle cx={p.x} cy={p.y} r={Math.max(r + 3, 12 * px)} fill="transparent" stroke="transparent" strokeWidth={1.5} />
              <circle cx={p.x} cy={p.y} r={r} fill="none" stroke="var(--color-ink-500)" strokeWidth={1.5} strokeDasharray={g.share === null ? '2 3' : undefined} />
              {share > 0 && <path d={arc} fill="none" stroke="var(--color-signal-green)" strokeWidth={3} strokeLinecap="round" />}
            </g>
          )
        })}
        <circle cx={C} cy={C} r={INNER - 18} fill="var(--color-ink-900)" stroke={zen ? 'var(--color-ink-600)' : FILL[level]} strokeOpacity={0.6} strokeWidth={1.5} />
        <text x={C} y={C + 2 * px} textAnchor="middle" fontSize={26 * px} className="font-serif" fill="var(--color-ink-50)">
          {total.toLocaleString('en-US')}
        </text>
        <text x={C} y={C + 24 * px} textAnchor="middle" fontSize={12 * px} fill="var(--color-ink-400)">
          things
        </text>
      </svg>
      {!named && chosen && (
        // With no names round the edge, the chosen area is named above its chips, so the sky is never a bare chart.
        <p className="mt-3 flex flex-wrap items-baseline justify-center gap-x-2 text-[14px]">
          <span className="font-semibold text-ink-50">{chosen.name}</span>
          <span className="text-ink-300 tabular-nums">{chosen.count.toLocaleString('en-US')}</span>
          {(() => {
            const theirs = chosen.kinds.reduce((n, k) => n + (yours?.[k.id]?.count ?? 0), 0)
            return theirs > 0 ? <span className="font-medium text-orbit tabular-nums">{theirs.toLocaleString('en-US')} yours</span> : null
          })()}
          {!zen && chosen.notGreen.red > 0 && <span className="text-red">{chosen.notGreen.red} failing</span>}
          {!zen && !chosen.notGreen.red && chosen.notGreen.amber > 0 && <span className="text-amber">{chosen.notGreen.amber} to look at</span>}
        </p>
      )}
      {!named && (
        <div role="group" aria-label="Areas" className="-mx-4 mt-1.5 flex gap-1.5 self-stretch overflow-x-auto px-4 pb-1 md:mx-0 md:px-0 [mask-image:linear-gradient(to_right,transparent,black_1rem,black_calc(100%-2rem),transparent)] snap-x *:snap-center *:shrink-0">
          {areas.map((area) => (
            <button key={area.name} ref={area.name === selected ? chip : undefined} type="button" aria-pressed={area.name === selected} onClick={() => onSelect(area.name)} className={`inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 text-[13px] ${area.name === selected ? 'border-ink-400 bg-ink-800 text-ink-50' : 'border-ink-700 text-ink-300'}`}>
              {area.level !== 'green' && <Lamp level={area.level} calm />}
              {area.name}
              <span className="text-[12px] text-ink-400 tabular-nums">{area.count.toLocaleString('en-US')}</span>
              {area.kinds.some((k) => yours?.[k.id]) && <span className="size-2 rounded-full border-2 border-orbit" role="img" aria-label="yours" />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** Room around the sky for the area names, at least. */
const MARGIN = 150
/** The narrowest, in pixels, the sky is drawn with the area names round its edge. */
const NAMED = 480
/** How tall, in pixels, the chosen area's line and its chips run when the sky is too narrow for names. */
const CHIPS = 96
/** How wide, in pixels on screen, the widest line of an area's name and counts runs. */
const LABEL_PX = 96
