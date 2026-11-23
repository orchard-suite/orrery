// The atlas's own pieces, shared by the ground and the map: the shell every
// layer fills its window with, its corner key, its first-visit tour, the
// lens, the ranked list, the peek a click opens, the status shapes drawn in a
// picture, the sky band, the verdict, the way back up, the tuft of wheat, and
// the hover card. Every colour is a token: the
// atlas's own (`--color-atlas-*` in styles.css) or a status's. Nothing here
// moves on its own.

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { MenuItem, Popover } from './Popover.tsx'
import type { GroundLink } from '../../shared/ground.ts'
import type { CheckTally, MapThing } from '../../shared/map.ts'
import type { StatusLevel } from '../../shared/model.ts'
import type { FlowerShape } from '../atlas.ts'
import { counted } from '../ground.ts'
import { X } from 'lucide-react'
import { useEscape } from '../layers.ts'
import { href, navigate, type Route } from '../router.ts'
import { useShownHref } from '../trail.ts'
import { External, LEVEL_NAME, Link, useDesk } from './ui.tsx'

/** A status's colour in a picture. */
export const SIGNAL: Record<StatusLevel, string> = {
  green: 'var(--color-signal-green)',
  amber: 'var(--color-signal-amber)',
  red: 'var(--color-signal-red)',
  grey: 'var(--color-grey)',
}

/** A status drawn as its shape, never its colour alone: a green dot, an amber square, a red diamond, a grey ring. */
export function StatusShape({ level, x, y, r, edge, mono = false }: { level: StatusLevel; x: number; y: number; r: number; edge?: string; mono?: boolean }) {
  // `mono` draws the shape alone, as a white outline (healthy a small white dot), where a red or green fill would be read as something else on the picture.
  if (mono) {
    const line = { fill: 'none', stroke: 'var(--color-ink-50)', strokeWidth: Math.max(1, r * 0.3) }
    if (level === 'red') return <rect x={x - r * 0.7} y={y - r * 0.7} width={r * 1.4} height={r * 1.4} transform={`rotate(45 ${x} ${y})`} {...line} />
    if (level === 'amber') return <rect x={x - r * 0.72} y={y - r * 0.72} width={r * 1.44} height={r * 1.44} {...line} />
    if (level === 'grey') return <circle cx={x} cy={y} r={r * 0.7} fill="none" stroke="var(--color-ink-400)" strokeWidth={Math.max(1, r * 0.25)} />
    return <circle cx={x} cy={y} r={r * 0.38} fill="var(--color-ink-50)" />
  }
  const stroke = edge ? { stroke: edge, strokeWidth: Math.max(0.8, r * 0.25) } : {}
  if (level === 'red') return <rect x={x - r * 0.78} y={y - r * 0.78} width={r * 1.56} height={r * 1.56} rx={r * 0.15} transform={`rotate(45 ${x} ${y})`} fill={SIGNAL.red} {...stroke} />
  if (level === 'amber') return <rect x={x - r * 0.8} y={y - r * 0.8} width={r * 1.6} height={r * 1.6} rx={r * 0.15} fill={SIGNAL.amber} {...stroke} />
  if (level === 'grey') return <circle cx={x} cy={y} r={r * 0.78} fill="none" stroke={SIGNAL.grey} strokeWidth={Math.max(1.2, r * 0.32)} />
  return <circle cx={x} cy={y} r={r * 0.85} fill={SIGNAL.green} {...stroke} />
}

/** A status's shape the size of a letter, beside its words. */
export function ShapeIcon({ level, size = 10, className = '', mono = false }: { level: StatusLevel; size?: number; className?: string; mono?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" aria-hidden className={`inline-block shrink-0 ${className}`}>
      <StatusShape level={level} x={6} y={6} r={5} mono={mono} />
    </svg>
  )
}

/** How wide an element is drawn, kept as it changes. The ref is a callback, so it watches an element drawn after the first render too. */
export function useWidth<T extends Element>(): [(el: T | null) => void, number] {
  const [width, setWidth] = useState(0)
  const watch = useRef<ResizeObserver | null>(null)
  const ref = useCallback((el: T | null) => {
    watch.current?.disconnect()
    watch.current = null
    if (!el) return
    setWidth(el.getBoundingClientRect().width)
    watch.current = new ResizeObserver(([entry]) => entry && setWidth(entry.contentRect.width))
    watch.current.observe(el)
  }, [])
  return [ref, width]
}

/** A hover card: what a mark stands for, beside the pointer. A screen reader hears the mark's own name instead. */
export interface TipAt {
  x: number
  y: number
  body: ReactNode
  /** The address it was shown on. */
  on: string
}

/** A hover card belongs to the address it was shown on: a step to another (a double-click, a key, Back) leaves it behind, though the page that drew it stays. */
export const tipShown = (tip: TipAt | null, href: string): TipAt | null => (tip && tip.on === href ? tip : null)

export function useTip(): [TipAt | null, (e: { clientX: number; clientY: number }, body: ReactNode) => void, () => void] {
  const [tip, setTip] = useState<TipAt | null>(null)
  const href = useShownHref()
  return [tipShown(tip, href), (e, body) => setTip({ x: e.clientX, y: e.clientY, body, on: href }), () => setTip(null)]
}

export function Tip({ tip }: { tip: TipAt | null }) {
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState<[number, number]>([0, 0])
  useEffect(() => {
    const el = ref.current
    if (el) setSize([el.offsetWidth, el.offsetHeight])
  }, [tip?.body])
  if (!tip) return null
  const x = tip.x + 16 + size[0] > innerWidth - 8 ? tip.x - size[0] - 16 : tip.x + 16
  const y = tip.y + 16 + size[1] > innerHeight - 8 ? tip.y - size[1] - 16 : tip.y + 16
  return (
    <div ref={ref} aria-hidden className="pointer-events-none fixed z-40 max-w-[340px] rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-[13px] leading-snug text-ink-200 elevate-pop" style={{ left: Math.max(8, x), top: Math.max(8, y) }}>
      {tip.body}
    </div>
  )
}

/** The title line of a hover card. */
export const TipTitle = ({ children }: { children: ReactNode }) => <div className="mb-0.5 text-[14px] font-medium break-words text-ink-50">{children}</div>

const pct = (a: number, n: number) => (n ? `${Math.round((a / n) * 100)}%` : '')

/** The words a band says. */
export interface BandWords {
  holding: string
  broken: string
  nodata: string
}

/**
 * The sky band: broken, then no data, then holding, in proportion, with the
 * counts under it. No data is hatched grey, never green, and never left out.
 */
export function SkyBand({ t, words, className = '' }: { t: CheckTally; words: BandWords; className?: string }) {
  const n = t.pass + t.fail + t.unknown
  const says = `${t.fail.toLocaleString('en-US')} ${words.broken}, ${t.unknown.toLocaleString('en-US')} ${words.nodata}, ${t.pass.toLocaleString('en-US')} ${words.holding}`
  return (
    <div className={className}>
      <div role="img" aria-label={n ? says : `Nothing to judge: no ${words.holding}, ${words.broken}, or ${words.nodata}`} className="flex h-3.5 gap-0.5 overflow-hidden rounded-full">
        {!n && <span className="h-full flex-1 rounded-full border border-dashed border-ink-600" />}
        {t.fail > 0 && <span className="h-full bg-signal-red" style={{ flex: t.fail }} />}
        {t.unknown > 0 && (
          <span
            className="h-full"
            style={{
              flex: t.unknown,
              background: 'repeating-linear-gradient(135deg, var(--color-grey) 0 3px, var(--color-ink-700) 3px 6px)',
            }}
          />
        )}
        {t.pass > 0 && <span className="h-full bg-signal-green" style={{ flex: t.pass }} />}
      </div>
      {n > 0 && (
        <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-ink-300">
          <span className="inline-flex items-center gap-1.5">
            <ShapeIcon level="red" size={14} />
            <b className="font-medium text-ink-50 tabular-nums">{t.fail.toLocaleString('en-US')}</b> {words.broken} <span className="text-ink-400">{pct(t.fail, n)}</span>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <ShapeIcon level="grey" size={14} />
            <b className="font-medium text-ink-50 tabular-nums">{t.unknown.toLocaleString('en-US')}</b> {words.nodata} <span className="text-ink-400">{pct(t.unknown, n)}</span>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <ShapeIcon level="green" size={14} />
            <b className="font-medium text-ink-50 tabular-nums">{t.pass.toLocaleString('en-US')}</b> {words.holding} <span className="text-ink-400">{pct(t.pass, n)}</span>
          </span>
        </p>
      )}
    </div>
  )
}

/** The verdict that opens a layer: a small line saying what it is, then how it is, in the serif voice. */
export function Verdict({ kicker, children }: { kicker: ReactNode; children: ReactNode }) {
  return (
    <header>
      <p className="text-[12px] font-medium tracking-[0.06em] text-ink-400 uppercase">{kicker}</p>
      <h1 className="mt-1.5 font-serif text-[34px] leading-[1.05] tracking-[-0.01em] text-balance break-words text-ink-50 md:text-[40px] desk:text-[30px] 2xl:desk:text-[34px]">{children}</h1>
    </header>
  )
}

/** A number in a verdict that is bad news. */
export const Alarm = ({ children }: { children: ReactNode }) => <span className="text-red">{children}</span>
/** The quieter half of a verdict. */
export const Quiet = ({ children }: { children: ReactNode }) => <span className="text-ink-300">{children}</span>

/** The way back up, from the sky to where the reader is. The last step is where they are. */
export function Crumbs({ steps }: { steps: { label: string; kind?: string; to?: Route }[] }) {
  return (
    <nav aria-label="Where you are" className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-1 text-[13px]">
      {steps.map((s, i) => (
        <span key={i} className="inline-flex min-w-0 items-center gap-1">
          {i > 0 && (
            <span aria-hidden className="text-ink-500">
              ›
            </span>
          )}
          {s.to && i < steps.length - 1 ? (
            <Link to={s.to} className="inline-flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-md px-1.5 break-words text-ink-300 md:min-h-8 hover:bg-ink-850 hover:text-ink-50">
              {s.kind && <span className="text-[12px] text-ink-300">{s.kind}</span>}
              {s.label}
            </Link>
          ) : (
            <span aria-current={i === steps.length - 1 ? 'page' : undefined} className="inline-flex min-h-11 items-center gap-1.5 px-1.5 font-medium md:min-h-8 break-words text-ink-50">
              {s.kind && <span className="text-[12px] font-normal text-ink-400">{s.kind}</span>}
              {s.label}
            </span>
          )}
        </span>
      ))}
    </nav>
  )
}

/** A link drawn in a picture: an SVG anchor that goes where `to` says without leaving the app. */
export function SvgLink({ to, label, children, className = '', onPointerMove, onPointerLeave, onFocus, onBlur }: { to: Route; label: string; children: ReactNode; className?: string; onPointerMove?: (e: React.PointerEvent) => void; onPointerLeave?: () => void; onFocus?: () => void; onBlur?: () => void }) {
  return (
    <a
      href={href(to)}
      aria-label={label}
      className={`cursor-pointer outline-none focus-visible:[&>*:first-child]:stroke-orbit ${className}`}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
        e.preventDefault()
        navigate(to)
      }}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
      onFocus={onFocus}
      onBlur={onBlur}
    >
      {children}
    </a>
  )
}

/** A heading in the side panel: two or three words, and nothing that explains. `children` are a control or a count on its right. */
export function PanelHead({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <h2 className="mt-7 mb-2 flex items-center justify-between gap-2 text-[12px] font-medium tracking-[0.06em] text-ink-300 uppercase">
      <span>{title}</span>
      {children && <span className="font-normal tracking-normal normal-case">{children}</span>}
    </h2>
  )
}

/**
 * A flower drawn from its shape: its rings, the ghost of each petal at the
 * top of its ladder (in gold where a walk grows it there), the petals, the
 * stubs of the ladders that read it not, and its heart. With `lens` on a
 * ladder, the other petals stand back. Colour is health alone: green at the
 * top, red stopped by a break, grey stopped by no data.
 */
export function FlowerArt({ shape, lens = null, className = '' }: { shape: FlowerShape; lens?: string | null; className?: string }) {
  const c = shape.size / 2
  const back = (ladder: string) => (lens && ladder !== lens ? 0.2 : 1)
  return (
    <svg width={shape.size} height={shape.size} viewBox={`0 0 ${shape.size} ${shape.size}`} aria-hidden className={`block shrink-0 ${className}`}>
      {shape.rings.map((r, i) => (
        <circle key={i} cx={c} cy={c} r={r} fill="none" stroke="var(--color-ink-700)" strokeWidth={i === shape.rings.length - 1 ? 1 : 0.6} strokeDasharray={i === shape.rings.length - 1 ? '2 3' : '1 3'} />
      ))}
      {shape.ghosts.map((g, i) =>
        g.grows ? (
          <path key={i} d={g.d} fill="var(--color-atlas-route)" fillOpacity={0.14} stroke="var(--color-atlas-route)" strokeWidth={1.3} strokeDasharray="3 2.5" opacity={back(g.ladder)} />
        ) : (
          <path key={i} d={g.d} fill="none" stroke="var(--color-ink-500)" strokeWidth={1} strokeDasharray="2 2.5" opacity={back(g.ladder)} />
        ),
      )}
      {shape.petals.map((p, i) => (
        <path
          key={i}
          d={p.d}
          fill={p.kind === 'top' ? 'var(--color-signal-green)' : p.kind === 'short' ? 'var(--color-signal-red)' : 'var(--color-atlas-ghost)'}
          fillOpacity={p.kind === 'top' ? 0.78 : p.kind === 'short' ? 0.9 : 0.3}
          stroke={p.kind === 'blind' ? 'var(--color-atlas-ghost)' : 'var(--color-ink-950)'}
          strokeOpacity={p.kind === 'blind' ? 0.9 : 0.35}
          strokeWidth={p.kind === 'blind' ? 1 : 0.6}
          strokeDasharray={p.kind === 'blind' ? '2 1.5' : undefined}
          opacity={back(p.ladder)}
        />
      ))}
      {shape.stubs.map((x, i) => (
        <line key={i} x1={x.x1} y1={x.y1} x2={x.x2} y2={x.y2} stroke="var(--color-ink-600)" strokeWidth={2} strokeLinecap="round" opacity={back(x.ladder)} />
      ))}
      <circle cx={c} cy={c} r={shape.heart} fill="var(--color-atlas-hedge)" opacity={0.85} />
    </svg>
  )
}

/** The hatched fog and the soft blurs the atlas's weather is drawn with. One set a picture. */
export function WeatherDefs({ id }: { id: string }) {
  return (
    <>
      <filter id={`${id}-storm`} x="-30%" y="-30%" width="160%" height="160%">
        <feGaussianBlur stdDeviation="7" />
      </filter>
      <filter id={`${id}-soft`} x="-20%" y="-20%" width="140%" height="140%">
        <feGaussianBlur stdDeviation="3" />
      </filter>
      <pattern id={`${id}-fog`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(-40)">
        <rect width="6" height="6" fill="var(--color-atlas-fog)" opacity="0.16" />
        <rect width="6" height="2" fill="var(--color-atlas-fog)" opacity="0.6" />
      </pattern>
    </>
  )
}

/** The eye of a storm: its broken count in a ring as wide as its digits need, with three bands of cloud round it. */
export function StormEye({ x, y, n, r, size }: { x: number; y: number; n: number; r: number; size: number }) {
  return (
    <g pointerEvents="none">
      {[0, 1, 2].map((i) => {
        const rr = r + 7 + i * 6
        return <path key={i} d={`M${x + rr} ${y}A${rr} ${rr} 0 0 1 ${x - rr * 0.5} ${y + rr * 0.87}`} fill="none" stroke="var(--color-red)" strokeOpacity={0.55 - i * 0.15} strokeWidth={1.6} strokeLinecap="round" transform={`rotate(${i * 120 - 20} ${x} ${y})`} />
      })}
      <circle cx={x} cy={y} r={r} fill="var(--color-ink-950)" stroke="var(--color-red)" strokeWidth={2} />
      <text x={x} y={y + size * 0.36} textAnchor="middle" fontSize={size} fontWeight={600} fill="currentColor" className="text-ink-50">
        {n.toLocaleString('en-US')}
      </text>
    </g>
  )
}

/** How wide and tall an element is drawn, kept as it changes. */
export function useSize<T extends Element>(): [(el: T | null) => void, number, number] {
  const [size, setSize] = useState<[number, number]>([0, 0])
  const watch = useRef<ResizeObserver | null>(null)
  const ref = useCallback((el: T | null) => {
    watch.current?.disconnect()
    watch.current = null
    if (!el) return
    const box = el.getBoundingClientRect()
    setSize([box.width, box.height])
    watch.current = new ResizeObserver(([entry]) => entry && setSize([entry.contentRect.width, entry.contentRect.height]))
    watch.current.observe(el)
  }, [])
  return [ref, size[0], size[1]]
}

/** The pieces a name may be broken between: each ends at a dot, a hyphen, an underscore, or a space. */
export const namePieces = (name: string): string[] => name.match(/[^.\-_ ]+[.\-_ ]*|[.\-_ ]+/g) ?? [name]

/**
 * A thing's name as every bed, tile, and row of the atlas sets it: broken
 * only after a dot, a hyphen, an underscore, or a space, never inside a
 * word. A piece still wider than its line is cut short with an ellipsis, and
 * the whole name is its title, so nothing of it is lost.
 */
export function NameText({ name, after = '', className = '' }: { name: string; /** What follows the name on its last line, such as a colon: it never starts a line of its own. */ after?: string; className?: string }) {
  const pieces = namePieces(name)
  return (
    <span title={name} className={`min-w-0 ${className}`}>
      {pieces.map((piece, i) => (
        // Each piece keeps a line tall enough for its letters' tails, however tight the line it stands in.
        <span key={i} className="inline-block max-w-full truncate align-bottom leading-[1.3] whitespace-pre">
          {piece}
          {i === pieces.length - 1 ? after : ''}
        </span>
      ))}
    </span>
  )
}

/** A floating piece on the stage: translucent, quietly edged, never wider than its words. */
export const FLOAT = 'rounded-xl border border-ink-700/60 bg-ink-900/75 backdrop-blur-md'

/** One mark of a picture's key: the mark as the picture draws it, a word or two for the corner, and the sentence the full key says of it. */
export interface KeyMark {
  mark: ReactNode
  word: string
  says: string
}

/** One step of a first visit: the part of the layer it points at, and a sentence or two. */
export interface CoachStep {
  at: 'stage' | 'panel' | 'over'
  title: string
  says: string
}

const coachKey = (id: string) => `orrery.atlas.tour.${id}`

/** Whether this browser has seen a tour. Blocked storage reads as seen: a tour never nags a reader it cannot remember. */
function coached(id: string): boolean {
  try {
    return localStorage.getItem(coachKey(id)) !== null
  } catch {
    return true
  }
}

/**
 * The first visit to a level: a few short steps, each pointing at a part of
 * the layer, shown once a browser and never again unless asked for. `start`
 * replays it. It is skipped by its own button or Escape, and nothing in it
 * moves on its own.
 */
export function useCoach(id: string, steps: readonly CoachStep[], ready: boolean): { at: number | null; start: () => void; step: (to: number | null) => void } {
  const [at, setAt] = useState<number | null>(null)
  useEffect(() => {
    if (ready && steps.length && !coached(id)) setAt(0)
  }, [id, ready, steps.length])
  const step = (to: number | null) => {
    if (to === null || to >= steps.length) {
      try {
        localStorage.setItem(coachKey(id), '1')
      } catch {
        // Blocked storage: it is done for this page.
      }
      setAt(null)
    } else setAt(to)
  }
  return { at, start: () => setAt(0), step }
}

/** The card of one tour step, beside the part it points at, with that part ringed. */
function Coach({ steps, at, step, root }: { steps: readonly CoachStep[]; at: number; step: (to: number | null) => void; root: HTMLElement | null }) {
  useEscape(() => step(null))
  const card = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState<DOMRect | null>(null)
  const now = steps[at]!
  useEffect(() => {
    const measure = () => setBox(root?.querySelector(`[data-coach="${now.at}"]`)?.getBoundingClientRect() ?? null)
    measure()
    addEventListener('resize', measure)
    return () => removeEventListener('resize', measure)
  }, [now.at, root])
  useEffect(() => card.current?.focus({ preventScroll: true }), [at])
  // Beside the part where the window has the room, inside it where it has not; never off the window.
  const wide = Math.min(320, innerWidth - 24)
  const left = box ? Math.min(innerWidth - wide - 12, Math.max(12, now.at === 'panel' ? box.left - wide - 12 : box.left + 16)) : 12
  const top = box ? Math.min(innerHeight - 190, Math.max(12, now.at === 'over' ? box.bottom + 12 : box.top + Math.min(120, box.height / 3))) : 12
  return (
    <>
      {box && <div aria-hidden className="pointer-events-none fixed z-40 rounded-2xl border-2 border-orbit" style={{ left: box.left - 3, top: box.top - 3, width: box.width + 6, height: box.height + 6 }} />}
      <div ref={card} role="dialog" aria-label={`${now.title}. Step ${at + 1} of ${steps.length}`} tabIndex={-1} className="fixed z-50 rounded-xl border border-ink-600 bg-ink-900 p-4 elevate-pop outline-none" style={{ left, top, width: wide }}>
        <p className="text-[12px] text-ink-300">
          {at + 1} of {steps.length}
        </p>
        <h2 className="mt-0.5 text-[15px] font-medium text-ink-50">{now.title}</h2>
        <p className="mt-1 text-[13px] leading-snug text-ink-200">{now.says}</p>
        <div className="mt-3 flex items-center gap-2">
          <button type="button" className="btn btn-solid min-h-11 md:min-h-9" onClick={() => step(at + 1)}>
            {at + 1 < steps.length ? 'Next' : 'Done'}
          </button>
          {at > 0 && (
            <button type="button" className="btn btn-ghost min-h-11 md:min-h-9" onClick={() => step(at - 1)}>
              Back
            </button>
          )}
          {at + 1 < steps.length && (
            <button type="button" className="btn btn-ghost ml-auto min-h-11 md:min-h-9" onClick={() => step(null)}>
              Skip
            </button>
          )}
        </div>
      </div>
    </>
  )
}

/**
 * A picture's key: on a desk a quiet strip of its real marks, a word or two
 * each, and a "?" that opens the whole key, each mark with what it means, and
 * replays the tour. `marks` false leaves the strip out, so only the "?" is
 * drawn; a narrow desk does the same.
 */
function StageKey({ legend, marks, onTour }: { legend: readonly KeyMark[]; marks: boolean; onTour?: () => void }) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null)
  return (
    <div className={`flex max-w-full flex-wrap items-center gap-x-3 gap-y-1 px-2 py-1 text-[12px] text-ink-200 ${FLOAT}`}>
      {marks && (
        // On a desk too narrow to spare the room, the strip steps back and the "?" alone holds the key.
        <ul aria-label="Key" className="hidden flex-wrap items-center gap-x-3 gap-y-1 min-[1400px]:flex">
          {legend.map((k) => (
            <li key={k.word} className="inline-flex items-center gap-1.5 whitespace-nowrap">
              <span className="inline-flex min-w-[14px] justify-center">{k.mark}</span>
              {k.word}
            </li>
          ))}
        </ul>
      )}
      <button type="button" aria-haspopup="dialog" aria-expanded={!!anchor} aria-label="The key to this picture" onClick={(e) => setAnchor(anchor ? null : e.currentTarget)} className="inline-grid size-11 shrink-0 place-items-center rounded-full border border-ink-600 text-[13px] font-medium text-ink-100 hover:border-ink-400 md:size-7">
        ?
      </button>
      {anchor && (
        <Popover anchor={anchor} width={300} label="The key to this picture" onClose={() => setAnchor(null)} className="max-w-[340px] p-3">
          <ul className="space-y-2">
            {legend.map((k) => (
              <li key={k.word} className="flex items-start gap-2.5 text-[13px] leading-snug text-ink-200">
                <span className="mt-0.5 inline-flex min-w-[18px] shrink-0 justify-center">{k.mark}</span>
                <span>{k.says}</span>
              </li>
            ))}
          </ul>
          {onTour && (
            <button
              type="button"
              className="btn btn-ghost mt-3 min-h-11 md:min-h-9"
              onClick={() => {
                setAnchor(null)
                onTour()
              }}
            >
              Show me round
            </button>
          )}
        </Popover>
      )}
    </div>
  )
}

/** Where the reader last pressed inside a layer of the atlas, and when: the next layer opens out from there. */
let pressed: { x: number; y: number; at: number } | null = null

/**
 * The shell of every layer of the atlas. On a desk it fills the window under
 * the way back up: the picture is the stage and takes all of it, and what
 * the layer says stands in a translucent panel along its right edge, which
 * scrolls inside itself, so the page never scrolls. `over` floats on the
 * stage's upper left: what changes the picture (a search, a lens). The
 * picture's key sits small in the stage's lower left (or lower right, with
 * `keyAt`), and on a stage that scrolls, or a narrow one, beside `over` as a
 * "?" alone. `peek` leads the panel while a thing is opened. `scrolls` lets a
 * stage whose picture is a list longer than the window scroll inside itself.
 * On a narrower or shorter window the parts stack, stage first, and the page
 * scrolls. `tray` docks along the bottom, under the stage. A layer reached by
 * a press on the layer above opens out from where the press was, once, and
 * not at all for a reader who asks for less motion. `tour` is the layer's
 * first visit: shown once, and again from the key.
 */
export function Shell({ crumbs, stage, over, panel, peek, tray, scrolls = false, legend, keyAt = 'left', tour }: { crumbs: ReactNode; stage: ReactNode; over?: ReactNode; panel: ReactNode; peek?: ReactNode; tray?: ReactNode; scrolls?: boolean; legend?: readonly KeyMark[]; keyAt?: 'left' | 'right'; tour?: { id: string; steps: readonly CoachStep[] } }) {
  const desk = useDesk()
  const root = useRef<HTMLDivElement>(null)
  const [origin, setOrigin] = useState<string | null>(null)
  useLayoutEffect(() => {
    const box = root.current?.querySelector('[data-coach="stage"]')?.getBoundingClientRect()
    if (pressed && box && Date.now() - pressed.at < 1500) setOrigin(`${pressed.x - box.left}px ${pressed.y - box.top}px`)
    pressed = null
  }, [])
  const coach = useCoach(tour?.id ?? '', tour?.steps ?? [], !!tour)
  const key = legend && <StageKey legend={legend} marks={desk && scrolls} onTour={tour ? coach.start : undefined} />
  return (
    <div ref={root} className="flex flex-col pt-3 pb-6 [--rail:340px] 2xl:[--rail:400px] desk:h-full desk:pb-4" onPointerDownCapture={(e) => (pressed = { x: e.clientX, y: e.clientY, at: Date.now() })}>
      <div className="shrink-0">{crumbs}</div>
      <div className="relative mt-2 flex min-h-0 flex-1 flex-col gap-5 desk:block desk:overflow-hidden desk:rounded-2xl desk:border desk:border-ink-800 desk:bg-[var(--color-atlas-space)]">
        {(over || key) && (
          <div data-coach="over" className="order-1 flex flex-wrap items-center gap-2 desk:absolute desk:top-3 desk:left-3 desk:z-10 desk:max-w-[calc(100%-var(--rail)-1.5rem)]">
            {over}
            {(!desk || scrolls) && key}
          </div>
        )}
        <div data-coach="stage" className={`relative order-2 min-w-0 desk:absolute desk:inset-y-0 desk:right-[var(--rail)] desk:left-0 ${origin ? 'atlas-arrive' : ''} ${scrolls ? 'desk:overflow-y-auto desk:px-3 desk:pb-3' : ''} ${scrolls ? 'desk:pt-16' : ''}`} style={origin ? { transformOrigin: origin } : undefined}>
          {stage}
        </div>
        {desk && !scrolls && legend && (
          <div className={`absolute bottom-3 z-10 max-w-[calc(100%-var(--rail)-1.5rem)] ${keyAt === 'left' ? 'left-3' : 'right-[calc(var(--rail)+0.75rem)]'}`}>
            <StageKey legend={legend} marks onTour={tour ? coach.start : undefined} />
          </div>
        )}
        <aside data-coach="panel" aria-label="What it says" className="order-3 min-w-0 desk:absolute desk:inset-y-3 desk:right-3 desk:w-[calc(var(--rail)-1.5rem)] desk:overflow-y-auto desk:rounded-xl desk:border desk:border-ink-700/60 desk:bg-ink-900/75 desk:px-4 desk:pt-4 desk:pb-6 desk:backdrop-blur-md">
          {peek}
          {panel}
        </aside>
      </div>
      {tray}
      {tour && coach.at !== null && <Coach steps={tour.steps} at={coach.at} step={coach.step} root={root.current} />}
    </div>
  )
}

/** One row of a ranked list: what it is, how it stands in a few plain words, and how much is broken, for its bar. */
export interface RankRow {
  id: string
  title: string
  /** How it stands, after its name: "58 broken of 203". */
  says: string
  /** How much is broken: the length of its red bar, against the most in the list. */
  broken: number
  /** Opens its peek, or lights it: a row is a button. `to` makes it a link to another layer instead. */
  onPick?: () => void
  to?: Route
  picked?: boolean
  /** Told as the pointer or focus comes and goes, to light its mark on the picture. */
  onPoint?: (on: boolean) => void
  /** A small mark before its name, and a control after it (a tick box, a pin). */
  mark?: ReactNode
  after?: ReactNode
}

/**
 * The one ranked list every panel has: plain rows, each a name and how it
 * stands in the same few words, over one red bar on the list's own scale.
 * Past `first` rows the rest fold behind "Show more", inside the panel's own
 * scroll.
 */
export function Ranked({ label, rows, first }: { label: string; rows: readonly RankRow[]; first?: number }) {
  const [all, setAll] = useState(false)
  const most = Math.max(1, ...rows.map((r) => r.broken))
  const shown = first && !all ? rows.slice(0, first) : rows
  const look = (r: RankRow) => `block min-h-11 min-w-0 flex-1 rounded-lg px-2 py-1.5 text-left hover:bg-ink-850 md:min-h-9 ${r.picked ? 'bg-ink-850 ring-1 ring-orbit' : ''}`
  const body = (r: RankRow) => (
    <>
      <span className="flex items-start gap-1.5 text-[13px] leading-snug">
        {r.mark && <span className="mt-[3px] inline-flex shrink-0">{r.mark}</span>}
        <span className="min-w-0">
          <NameText name={r.title} className="font-medium text-ink-50" />
          <span className="text-ink-300"> · {r.says}</span>
        </span>
      </span>
      <span aria-hidden className="mt-1 block h-1 rounded-full bg-ink-800">
        <i className="block h-full rounded-full bg-signal-red" style={{ width: `${(r.broken / most) * 100}%` }} />
      </span>
    </>
  )
  return (
    <>
      <ol aria-label={label} className="space-y-0.5">
        {shown.map((r) => (
          <li key={r.id} className="flex items-start gap-1" onPointerEnter={() => r.onPoint?.(true)} onPointerLeave={() => r.onPoint?.(false)} onFocus={() => r.onPoint?.(true)} onBlur={() => r.onPoint?.(false)}>
            {r.to ? (
              <Link to={r.to} className={look(r)}>
                {body(r)}
              </Link>
            ) : (
              <button type="button" aria-pressed={r.picked} onClick={r.onPick} className={look(r)}>
                {body(r)}
              </button>
            )}
            {r.after}
          </li>
        ))}
      </ol>
      {first !== undefined && rows.length > first && (
        <button type="button" aria-expanded={all} className="btn btn-ghost mt-1.5 min-h-11 md:min-h-8" onClick={() => setAll(!all)}>
          {all ? 'Show fewer' : `Show ${(rows.length - first).toLocaleString('en-US')} more`}
        </button>
      )}
    </>
  )
}

/** One thing a lens may ask of a picture: a ladder, with how often its checks are broken and how often they have no data. */
export interface LensOption {
  id: string
  title: string
  broken: number
  nodata: number
}

/**
 * The lens: the one control that makes a picture ask one question. "Every
 * check" first, then each ladder by name, the most broken first. It floats on
 * the stage's upper left on every layer that has one.
 */
export function LensPicker({ options, picked, onPick }: { options: readonly LensOption[]; picked: string | null; onPick: (id: string | null) => void }) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null)
  const now = options.find((o) => o.id === picked)
  const pick = (id: string | null) => {
    onPick(id)
    setAnchor(null)
  }
  const sorted = [...options].sort((a, b) => b.broken - a.broken || b.nodata - a.nodata || a.title.localeCompare(b.title))
  return (
    <div className={`flex flex-wrap items-center gap-2 px-2.5 py-1.5 ${FLOAT}`}>
      <span id="atlas-lens" className="text-[13px] text-ink-300">
        Lens
      </span>
      <button type="button" aria-haspopup="menu" aria-expanded={!!anchor} aria-labelledby="atlas-lens atlas-lens-now" onClick={(e) => setAnchor(anchor ? null : e.currentTarget)} className={`inline-flex min-h-11 max-w-full min-w-0 items-center gap-2 rounded-full border px-3 text-[13px] md:min-h-9 ${now ? 'border-red-dim bg-ink-950 text-ink-50' : 'border-ink-700 bg-ink-900 text-ink-100 hover:border-ink-500'}`}>
        <span id="atlas-lens-now" className="min-w-0 text-left break-words">
          {now ? now.title : 'Every check'}
        </span>
        {now && <span className="text-red tabular-nums">{now.broken.toLocaleString('en-US')}</span>}
        <svg width={12} height={12} viewBox="0 0 24 24" aria-hidden className="shrink-0 text-ink-300">
          <path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {now && (
        <button type="button" className="btn btn-ghost min-h-11 md:min-h-9" onClick={() => onPick(null)}>
          Every check
        </button>
      )}
      {anchor && (
        <Popover anchor={anchor} width={340} menu label="Lens" onClose={() => setAnchor(null)} className="max-h-[60vh] overflow-y-auto p-1">
          <MenuItem check="radio" active={!picked} onClick={() => pick(null)}>
            Every check
          </MenuItem>
          {sorted.map((o) => (
            <MenuItem key={o.id} check="radio" active={picked === o.id} onClick={() => pick(o.id)}>
              <span className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 py-0.5">
                <span className="min-w-0 text-[13px] leading-snug break-words text-ink-100">{o.title}</span>
                <span className={`text-[13px] tabular-nums ${o.broken ? 'text-red' : 'text-ink-300'}`}>{o.broken ? `${o.broken.toLocaleString('en-US')} broken` : o.nodata ? `${o.nodata.toLocaleString('en-US')} no data` : 'holding'}</span>
              </span>
            </MenuItem>
          ))}
        </Popover>
      )}
    </div>
  )
}


/**
 * The peek: one thing opened where the reader stands, at the head of the
 * panel. It says what the thing is, how it is, and why; `children` hold its
 * numbers or its checks. It names the way to its own page in the catalog,
 * the way deeper into the atlas where there is one (`open`), and its own
 * addresses, each by its field's name and the site it leads to. `tick` is
 * there only for a thing the reader may run an action on. Escape closes it.
 */
export function PeekCard({ kicker, title, level, reasons = [], children, entity, open, links = [], tick, onClose }: { kicker: string; title: string; level?: StatusLevel; reasons?: string[]; children?: ReactNode; entity?: { blueprint: string; key: string }; open?: { to: Route; label: string }; links?: GroundLink[]; tick?: { on: boolean; set: (on: boolean) => void; label: string }; onClose: () => void }) {
  useEscape(onClose)
  const ref = useRef<HTMLElement>(null)
  // Opened from a row far down the panel, or under the picture on a phone: it comes into view, and focus goes to it.
  useEffect(() => {
    ref.current?.scrollIntoView({ block: 'nearest' })
    ref.current?.focus({ preventScroll: true })
  }, [title, kicker])
  const site = (url: string) => {
    try {
      return new URL(url).host
    } catch {
      return url
    }
  }
  return (
    <section ref={ref} tabIndex={-1} aria-label={`${title}, opened`} className="mb-5 rounded-xl border border-orbit/60 bg-ink-900 p-3.5 outline-none">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-[12px] text-ink-300">{kicker}</p>
          <h2 className="text-[16px] leading-snug font-medium text-ink-50">
            <NameText name={title} />
          </h2>
        </div>
        <button type="button" onClick={onClose} className="btn btn-ghost min-h-11 min-w-11 shrink-0 px-2 md:min-h-8 md:min-w-8" aria-label={`Close ${title}`}>
          <X aria-hidden className="size-3.5" />
        </button>
      </div>
      {level && (
        <p className="mt-1.5 flex items-start gap-1.5 text-[13px] leading-snug text-ink-200">
          <ShapeIcon level={level} size={12} className="mt-[3px]" />
          <span className="min-w-0 break-words">
            Status {LEVEL_NAME[level].toLowerCase()}
            {reasons.length > 0 && <span className="text-ink-300">: {reasons.join('. ')}</span>}
          </span>
        </p>
      )}
      {children}
      <ul className="mt-3 space-y-1 text-[13px]">
        {open && (
          <li>
            <Link to={open.to} className="btn btn-solid min-h-11 md:min-h-9">
              {open.label}
            </Link>
          </li>
        )}
        {entity && (
          <li>
            <Link to={{ page: 'entity', blueprint: entity.blueprint, key: entity.key }} className="inline-flex min-h-11 items-center text-ink-100 underline underline-offset-4 md:min-h-7">
              Its page in the catalog
            </Link>
          </li>
        )}
        {links.map((l) => (
          <li key={`${l.title}:${l.url}`}>
            <External href={l.url} className="inline-flex min-h-11 items-center break-all text-ink-100 underline md:min-h-7">
              {l.title}: {site(l.url)}
            </External>
          </li>
        ))}
      </ul>
      {tick && (
        <label className="mt-2 flex min-h-11 items-center gap-2 border-t border-ink-800 pt-2 text-[13px] text-ink-200 md:min-h-9">
          <input type="checkbox" className="size-4" checked={tick.on} onChange={(e) => tick.set(e.target.checked)} />
          {tick.label}
        </label>
      )}
    </section>
  )
}

/**
 * The checks of some things, said in a peek. First what to fix: each broken
 * check by name, with what to do under it where it says, the level it holds
 * the thing below, and where its record says more; over several things, how
 * many it is broken on. Then those with no data, then how many hold. The
 * most broken lead, those that say what to do first, in the order the levels
 * climb, and a long list ends in a count of the rest. `only` keeps to one
 * ladder.
 */
export function PeekChecks({ things, only = null, most = 8 }: { things: readonly Pick<MapThing, 'checks'>[]; only?: string | null; most?: number }) {
  // One row a rule, or a gap, on its rung of its ladder: the same title on two ladders is two checks.
  const by = new Map<string, { key: string; title: string; fix?: string; level?: string; link?: string; unexplained?: true; at: number; fail: number; unknown: number; pass: number }>()
  for (const t of things)
    for (const c of t.checks) {
      if (only && c.ladder !== only) continue
      const key = `${c.ladder}\n${c.rung}\n${c.id}`
      const row = by.get(key) ?? { key, title: c.title, fix: c.fix, level: c.level, link: c.link, unexplained: c.unexplained, at: by.size, fail: 0, unknown: 0, pass: 0 }
      row[c.state]++
      by.set(key, row)
    }
  const rows = [...by.values()]
  if (!rows.length) return <p className="mt-2 text-[13px] text-ink-300">Nothing checks it yet.</p>
  // What says what to do leads what does not.
  const broken = rows.filter((r) => r.fail > 0).sort((a, b) => b.fail - a.fail || Number(!a.fix) - Number(!b.fix) || a.at - b.at)
  const blind = rows.filter((r) => !r.fail && r.unknown > 0).sort((a, b) => b.unknown - a.unknown || a.title.localeCompare(b.title))
  const holding = rows.reduce((n, r) => n + r.pass, 0)
  const several = things.length > 1
  const host = (url: string) => {
    try {
      return new URL(url).host.split('.')[0]!
    } catch {
      return null
    }
  }
  return (
    <div className="mt-2.5 space-y-2">
      {broken.length > 0 && (
        <div>
          <p className="text-[12px] font-medium text-red">To fix: {broken.length.toLocaleString('en-US')}</p>
          <ul className="mt-1 space-y-1.5">
            {broken.slice(0, most).map((r) => (
              <li key={r.key} className="flex items-start gap-1.5 text-[13px] leading-snug">
                <ShapeIcon level="red" size={11} className="mt-[3px]" />
                <span className="min-w-0 flex-1 break-words">
                  <span className="text-ink-100">{r.title}</span>
                  {r.level && <span className="ml-1.5 text-[12px] whitespace-nowrap text-ink-400">for {r.level}</span>}
                  {r.fix ? <span className="block text-ink-300">{r.fix}</span> : r.unexplained ? <span className="block text-ink-400">No reason given</span> : null}
                  {r.link && host(r.link) && (
                    <External href={r.link} className="inline-flex min-h-11 items-center text-[12px] text-ink-300 underline underline-offset-4 hover:text-ink-100 md:min-h-6">
                      Open in {host(r.link)}
                    </External>
                  )}
                </span>
                {several && <span className="text-red tabular-nums">{r.fail.toLocaleString('en-US')}</span>}
              </li>
            ))}
            {broken.length > most && <li className="text-[12px] text-ink-300">and {(broken.length - most).toLocaleString('en-US')} more</li>}
          </ul>
        </div>
      )}
      {blind.length > 0 && (
        <div>
          <p className="text-[12px] font-medium text-ink-300">No data, so not judged: {counted(blind.length, 'check')}</p>
          <ul className="mt-1 space-y-0.5">
            {blind.slice(0, most).map((r) => (
              <li key={r.key} className="flex items-start gap-1.5 text-[13px] leading-snug">
                <ShapeIcon level="grey" size={11} className="mt-[3px]" />
                <span className="min-w-0 flex-1 break-words text-ink-100">{r.title}</span>
                {several && <span className="text-ink-300 tabular-nums">{r.unknown.toLocaleString('en-US')}</span>}
              </li>
            ))}
            {blind.length > most && <li className="text-[12px] text-ink-300">and {counted(blind.length - most, 'more check')}</li>}
          </ul>
        </div>
      )}
      <p className="flex items-center gap-1.5 text-[13px] text-ink-300">
        <ShapeIcon level="green" size={11} />
        {holding ? `${holding.toLocaleString('en-US')} holding` : 'None holding'}
      </p>
    </div>
  )
}

/** How some checks stand, in one form everywhere: "22 broken of 52", "8 no data of 8", "52 holding of 52". */
export function ofText(t: CheckTally): string {
  const all = t.pass + t.fail + t.unknown
  if (!all) return 'nothing checks it'
  if (t.fail) return `${t.fail.toLocaleString('en-US')} broken of ${all.toLocaleString('en-US')}`
  if (t.unknown) return `${t.unknown.toLocaleString('en-US')} no data of ${all.toLocaleString('en-US')}`
  return `${t.pass.toLocaleString('en-US')} holding of ${all.toLocaleString('en-US')}`
}

/** The status checks give: red where any is broken, grey where any has no data and none is broken, green where all hold. */
export const checksLevel = (t: CheckTally): StatusLevel => (t.fail ? 'red' : t.unknown || !t.pass ? 'grey' : 'green')

/** How wide a line of text is drawn, measured on a canvas where there is one. */
let ruler: CanvasRenderingContext2D | null | undefined
export function textWidth(text: string, size: number, weight = 500): number {
  if (ruler === undefined) ruler = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d')
  if (!ruler) return text.length * size * 0.58
  ruler.font = `${weight} ${size}px 'Geist Variable', ui-sans-serif, system-ui, sans-serif`
  return ruler.measureText(text).width
}

