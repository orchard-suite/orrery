import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as KeyEvent, type ReactNode, type SyntheticEvent } from 'react'
import { createPortal } from 'react-dom'
import { useEscape } from '../layers.ts'
import { useNarrow } from './ui.tsx'

const EDGE = 8
const stop = (event: SyntheticEvent) => event.stopPropagation()
/** The popovers open now, the newest last. Only the newest answers a press outside, so one opened from inside another closes first and alone. */
const open: object[] = []
const ITEMS = '[role^="menuitem"]:not(:disabled)'
const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'

/** Arrow keys walk the items of a list, round from the last to the first; Home and End go to either end. `items` picks them inside the element that has the key. */
export function walk(event: KeyEvent<HTMLElement>, items = 'button:not(:disabled), input'): void {
  const list = [...event.currentTarget.querySelectorAll<HTMLElement>(items)]
  const at = list.indexOf(document.activeElement as HTMLElement)
  const to = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: list.length - 1 }[event.key]
  if (to === undefined || !list.length) return
  event.preventDefault()
  list[(to + list.length) % list.length]?.focus()
}

/**
 * A floating panel tied to an element, drawn above the page so a table cell
 * that clips its content can still open one. `over` covers the anchor, for
 * changing a value where it stands; `below` hangs under it, for a menu.
 * Escape closes it, asking first while it is `unsaved`. A press anywhere
 * else calls `onOutside`, which an editor uses to keep what was typed. A popover opened from inside this one takes
 * both until it closes.
 *
 * Focus moves into it when it opens and, when it closes, back to what had it
 * before (or the anchor, when that is gone), unless the person has already
 * moved it somewhere else. A `menu` holds
 * `MenuItem`s, which the arrow keys walk; anything else is a dialog.
 *
 * On a phone it is a sheet at the bottom of the screen, where the thumb is,
 * named by its `label` and kept above the keyboard. A press on the dimmed
 * page above it is a press outside.
 */
export function Popover({ anchor, place = 'below', width = 0, onClose, onOutside = onClose, unsaved = false, menu = false, label, className = '', children }: { anchor: HTMLElement; place?: 'over' | 'below'; width?: number; onClose: () => void; onOutside?: () => void; unsaved?: boolean; menu?: boolean; label?: string; className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState<{ left: number; top: number; minWidth: number } | null>(null)
  const sheet = useNarrow()
  const lift = useKeyboardLift(sheet)
  const handlers = useRef({ onClose, onOutside })
  // What had focus as the popover opened: read once, while drawing, before anything inside takes it.
  const [opener] = useState(() => (document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null))
  handlers.current = { onClose, onOutside }
  useEscape(onClose, unsaved)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el || sheet) return
    const fit = () => {
      if (!anchor.isConnected) return handlers.current.onClose()
      const a = anchor.getBoundingClientRect()
      // No wider than the window, so a popover sized for a desk still fits a phone.
      const minWidth = Math.min(Math.max(place === 'over' ? a.width : 0, width), innerWidth - 2 * EDGE)
      const w = Math.max(el.offsetWidth, minWidth)
      const h = el.offsetHeight
      let top = place === 'over' ? a.top : a.bottom + 4
      if (top + h > innerHeight - EDGE) top = place === 'over' ? innerHeight - EDGE - h : a.top - 4 - h
      setBox({ left: Math.max(EDGE, Math.min(a.left, innerWidth - EDGE - w)), top: Math.max(EDGE, top), minWidth })
    }
    fit()
    const grown = new ResizeObserver(fit)
    grown.observe(el)
    addEventListener('resize', fit)
    addEventListener('scroll', fit, true)
    return () => {
      grown.disconnect()
      removeEventListener('resize', fit)
      removeEventListener('scroll', fit, true)
    }
  }, [anchor, place, width, sheet])

  useEffect(() => {
    const me = {}
    open.push(me)
    const top = () => open.at(-1) === me
    const down = (event: MouseEvent) => {
      if (top() && !ref.current?.contains(event.target as Node)) handlers.current.onOutside()
    }
    document.addEventListener('mousedown', down, true)
    // A field inside that asks for focus has it already; otherwise the first thing that takes focus gets it.
    const el = ref.current
    if (el && !el.contains(document.activeElement)) (el.querySelector<HTMLElement>(menu ? ITEMS : FOCUSABLE) ?? el).focus({ preventScroll: true })
    return () => {
      open.splice(open.indexOf(me), 1)
      document.removeEventListener('mousedown', down, true)
      // Focus left with the popover: it goes back to what opened it.
      const lost = document.activeElement === document.body || !!el?.contains(document.activeElement)
      if (lost) (opener?.isConnected ? opener : anchor).focus({ preventScroll: true })
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Events bubble through a portal to the element that opened it; they stop here so that element does not act on them twice. Escape goes on to the document, which closes the newest thing open.
  const events = { onClick: stop, onMouseDown: stop, onKeyDown: (event: KeyEvent<HTMLDivElement>) => (event.key !== 'Escape' && stop(event), menu && walk(event, ITEMS)) }
  if (sheet) {
    const { frame, body } = sheetParts(className)
    return createPortal(
      <div className="fixed inset-0 z-50">
        <div className="absolute inset-0 bg-ink-950/60" aria-hidden />
        <div ref={ref} role={menu ? 'menu' : 'dialog'} aria-label={label} tabIndex={-1} data-sheet style={{ bottom: lift, maxHeight: `calc(100dvh - ${lift}px - 48px)` }} className={`${frame} absolute inset-x-0 w-auto! max-w-none! overflow-y-auto rounded-t-2xl border-t border-ink-600 bg-ink-850 pb-[max(env(safe-area-inset-bottom),12px)] outline-none elevate-pop`} {...events}>
          <div className="sticky top-0 z-10 bg-ink-850 pt-2 pb-1" aria-hidden>
            <div className="mx-auto h-1 w-10 rounded-full bg-ink-600" />
            {label && <div className="truncate px-4 pt-2 text-[13px] font-medium text-ink-400">{label}</div>}
          </div>
          <div className={body}>{children}</div>
        </div>
      </div>,
      document.body,
    )
  }
  return createPortal(
    <div ref={ref} role={menu ? 'menu' : 'dialog'} aria-label={label} tabIndex={-1} style={{ position: 'fixed', left: box?.left ?? 0, top: box?.top ?? 0, minWidth: box?.minWidth, opacity: box ? 1 : 0 }} className={`z-50 max-w-[calc(100vw-16px)] rounded-md border border-ink-600 bg-ink-850 outline-none elevate-pop ${className}`} {...events}>
      {children}
    </div>,
    document.body,
  )
}

/**
 * How far the on-screen keyboard reaches up from the bottom of the window, so
 * a sheet stands on it instead of under it. Zero with no keyboard, or `on` false.
 */
export function useKeyboardLift(on: boolean): number {
  const [lift, setLift] = useState(0)
  useEffect(() => {
    const vv = window.visualViewport
    if (!on || !vv) return
    const fit = () => setLift(Math.max(0, Math.round(innerHeight - vv.height - vv.offsetTop)))
    fit()
    vv.addEventListener('resize', fit)
    vv.addEventListener('scroll', fit)
    return () => {
      vv.removeEventListener('resize', fit)
      vv.removeEventListener('scroll', fit)
    }
  }, [on])
  return lift
}

/** One row of a menu. `check` makes it a choice that is `active` when chosen: one of many, or one of a set. */
export function MenuItem({ children, onClick, active, check, danger, disabled, title, autoFocus }: { children: ReactNode; onClick: () => void; active?: boolean; check?: 'radio' | 'checkbox'; danger?: boolean; disabled?: boolean; title?: string; autoFocus?: boolean }) {
  return (
    <button type="button" role={check ? `menuitem${check}` : 'menuitem'} aria-checked={check ? !!active : undefined} autoFocus={autoFocus} disabled={disabled} title={title} onClick={onClick} className={`flex w-full items-center gap-2 px-3 py-1 text-left text-sm focus-visible:-outline-offset-2 enabled:hover:bg-ink-700 enabled:focus-visible:bg-ink-700 disabled:text-ink-500 ${active ? 'bg-ink-800' : ''} ${danger ? 'text-red' : ''}`}>
      {children}
    </button>
  )
}

/** Spacing a popover's classes give what it holds: on a sheet it goes round what it holds, under the handle and the label, so they line up with it. */
const SPACING = /^(p|px|py|pt|pb|pl|pr|ps|pe|space-x|space-y|gap|gap-x|gap-y)-/

/** A popover's classes as a sheet takes them: the frame keeps everything else, the body takes the spacing. */
export function sheetParts(className: string): { frame: string; body: string } {
  const words = className.split(/\s+/).filter(Boolean)
  return { frame: words.filter((w) => !SPACING.test(w)).join(' '), body: words.filter((w) => SPACING.test(w)).join(' ') }
}
