// The welcome tour's overlay: it dims the page, leaves a hole over the place
// a step points at, and puts a note beside it. It is a modal dialog: the page
// behind it is inert while it is open (it is shown, not used), Tab stays in
// the note, the arrow keys step, and Escape leaves. A step opens its page
// first; a place this screen does not draw skips the step, in the direction
// the person was going. Nothing in it moves on its own: it is measured again
// only when the page scrolls or resizes.

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useEscape } from '../layers.ts'
import type { TourStep, TourStepId } from '../../shared/welcome.ts'
import { href, navigate } from '../router.ts'
import { findSpot } from '../spots.ts'
import { Markdown } from './Markdown.tsx'
import { useNarrow } from './ui.tsx'

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
/** How long a step waits for its page to draw the place it points at. */
const WAIT_MS = 4000
/** The room left round the place a step points at, and between it and the note. */
const PAD = 6
const GAP = 14
const CARD_WIDTH = 360

type Box = { top: number; left: number; width: number; height: number }

/** How a tour ended: run to its last step, or left on one. */
export type TourEnd = { how: 'finished' | 'left'; at: TourStepId }

export function Tour({ steps, onEnd }: { steps: TourStep[]; onEnd: (end: TourEnd) => void }) {
  const [index, setIndex] = useState(0)
  const [going, setGoing] = useState<1 | -1>(1)
  // The place on screen the step points at, measured; null for a step that points at none. Undefined while it is sought.
  const [box, setBox] = useState<Box | null | undefined>(undefined)
  const step = steps[index]
  const end = useRef(onEnd)
  end.current = onEnd

  const go = useCallback(
    (to: number, way: 1 | -1) => {
      if (to >= steps.length) return end.current({ how: 'finished', at: steps.at(-1)!.id })
      setGoing(way)
      setBox(undefined)
      setIndex(Math.max(0, to))
    },
    [steps],
  )

  // Opens the step's page, then finds the place it points at.
  useEffect(() => {
    if (!step) return
    if (href(step.to) !== location.pathname) navigate(step.to)
    if (!step.spot) {
      setBox(null)
      return
    }
    const name = step.spot
    const started = Date.now()
    let el: HTMLElement | null = null
    const seek = window.setInterval(() => {
      el = findSpot(name)
      if (el) {
        window.clearInterval(seek)
        el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
        setBox(measure(el))
        return
      }
      if (Date.now() - started < WAIT_MS) return
      window.clearInterval(seek)
      // This screen does not draw it: on a phone there is no rail. The step is passed over the way the person was going.
      if (going === -1 && index === 0) setBox(null)
      else go(index + going, going)
    }, 100)
    const again = () => el && setBox(measure(el))
    window.addEventListener('resize', again)
    window.addEventListener('scroll', again, true)
    return () => {
      window.clearInterval(seek)
      window.removeEventListener('resize', again)
      window.removeEventListener('scroll', again, true)
    }
  }, [step, index, going, go])

  if (!step) return null
  const last = index === steps.length - 1
  return (
    <Overlay box={box} label={`Step ${index + 1} of ${steps.length}`} title={step.title} onLeave={() => end.current({ how: 'left', at: step.id })} onKey={(key) => (key === 'next' ? go(index + 1, 1) : index > 0 && go(index - 1, -1))}>
      <Markdown text={step.text} />
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button type="button" className="mr-auto text-[13px] font-medium text-ink-400 underline decoration-ink-600 underline-offset-4 hover:text-ink-200" onClick={() => end.current({ how: 'left', at: step.id })}>
          Leave the tour
        </button>
        <button type="button" className="btn btn-ghost" disabled={index === 0} onClick={() => go(index - 1, -1)}>
          Back
        </button>
        <button type="button" data-first className="btn btn-solid" onClick={() => go(index + 1, 1)}>
          {last ? 'Finish' : 'Next'}
        </button>
      </div>
    </Overlay>
  )
}

/** Where an element sits on screen, cut to the window, with room round it. */
function measure(el: HTMLElement): Box {
  const r = el.getBoundingClientRect()
  const top = Math.max(PAD, r.top - PAD)
  const left = Math.max(PAD, r.left - PAD)
  const bottom = Math.min(innerHeight - PAD, r.bottom + PAD)
  const right = Math.min(innerWidth - PAD, r.right + PAD)
  return { top, left, width: Math.max(0, right - left), height: Math.max(0, bottom - top) }
}

/** Where the note goes beside a box: to its right, under it, over it, or to its left, whichever has room; else at the foot of the window. */
export function placeNote(box: Box | null, card: { width: number; height: number }, view: { width: number; height: number }): CSSProperties {
  const clampX = (x: number) => Math.min(Math.max(16, x), view.width - card.width - 16)
  const clampY = (y: number) => Math.min(Math.max(16, y), view.height - card.height - 16)
  if (!box) return { top: clampY((view.height - card.height) / 2), left: clampX((view.width - card.width) / 2) }
  if (box.left + box.width + GAP + card.width + 16 <= view.width) return { top: clampY(box.top), left: box.left + box.width + GAP }
  if (box.top + box.height + GAP + card.height + 16 <= view.height) return { top: box.top + box.height + GAP, left: clampX(box.left) }
  if (box.top - GAP - card.height >= 16) return { top: box.top - GAP - card.height, left: clampX(box.left) }
  if (box.left - GAP - card.width >= 16) return { top: clampY(box.top), left: box.left - GAP - card.width }
  return { top: view.height - card.height - 24, left: clampX((view.width - card.width) / 2) }
}

/**
 * The dimmed page, the hole over `box`, and the note. `box` undefined is a
 * step still being sought: the page stays dimmed and the note waits. Also
 * the frame of the release notes, which point at nothing.
 */
export function Overlay({ box, label, title, onLeave, onKey, children }: { box: Box | null | undefined; label?: string; title: string; onLeave: () => void; onKey?: (key: 'next' | 'back') => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const sheet = useNarrow()
  const [card, setCard] = useState({ width: CARD_WIDTH, height: 200 })
  const leave = useRef(onLeave)
  leave.current = onLeave
  useEscape(() => leave.current())

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const root = document.getElementById('root')
    root?.setAttribute('inert', '')
    return () => {
      root?.removeAttribute('inert')
      opener?.focus()
    }
  }, [])
  // Each new note takes focus on its first button, so a screen reader reads it and Enter steps on.
  useEffect(() => {
    if (box === undefined) return
    ;(ref.current?.querySelector<HTMLElement>('[data-first]') ?? ref.current)?.focus()
  }, [box, title])
  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect()
    if (r && (Math.abs(r.width - card.width) > 1 || Math.abs(r.height - card.height) > 1)) setCard({ width: r.width, height: r.height })
  })

  const keys = (event: KeyboardEvent) => {
    if (onKey && (event.key === 'ArrowRight' || event.key === 'ArrowLeft') && !(event.target instanceof HTMLInputElement)) {
      event.preventDefault()
      onKey(event.key === 'ArrowRight' ? 'next' : 'back')
      return
    }
    if (event.key !== 'Tab' || !ref.current) return
    const all = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)]
    if (!all.length) return
    const first = all[0]!
    const final = all.at(-1)!
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      final.focus()
    } else if (!event.shiftKey && document.activeElement === final) {
      event.preventDefault()
      first.focus()
    }
  }

  const place = sheet ? {} : placeNote(box ?? null, card, { width: innerWidth, height: innerHeight })
  // A sheet sits at the foot of a phone, unless what it points at is down there: then it sits at the top.
  const high = sheet && !!box && box.top + box.height / 2 > innerHeight / 2
  return createPortal(
    <div className="fixed inset-0 z-50">
      {/* The page is shown, not used: a click anywhere outside the note does nothing. */}
      <div className={`absolute inset-0 ${box ? '' : 'bg-ink-950/70'}`} aria-hidden />
      {box && <div aria-hidden className="pointer-events-none absolute rounded-xl ring-2 ring-orbit" style={{ top: box.top, left: box.left, width: box.width, height: box.height, boxShadow: '0 0 0 100vmax color-mix(in oklab, var(--color-ink-950) 70%, transparent)' }} />}
      {box !== undefined && (
        <div
          ref={ref}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          tabIndex={-1}
          onKeyDown={keys}
          className={`absolute border border-ink-600 bg-ink-900 p-4 elevate-pop outline-none ${sheet ? `inset-x-3 rounded-2xl ${high ? 'top-[calc(12px+env(safe-area-inset-top))]' : 'bottom-[calc(var(--tab-gap,12px)+env(safe-area-inset-bottom))]'}` : 'rounded-xl'}`}
          style={sheet ? undefined : { ...place, width: CARD_WIDTH }}
        >
          {label && <p className="label">{label}</p>}
          <h2 id={titleId} className="mt-1 text-lg font-semibold tracking-tight text-ink-50">
            {title}
          </h2>
          <div className="mt-2">{children}</div>
        </div>
      )}
    </div>,
    document.body,
  )
}
