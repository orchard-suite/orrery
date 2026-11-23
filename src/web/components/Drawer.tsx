// A panel that comes in from the right edge over the page, for a task that
// needs more room than a popover. It is a modal dialog: the page behind it
// is inert while it is open, Tab stays inside it, Escape closes it, and focus
// goes back to whatever opened it. On a phone it rises from the bottom
// instead, the full width, and stands on the keyboard when one is open.

import { X } from 'lucide-react'
import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useEscape } from '../layers.ts'
import { useKeyboardLift } from './Popover.tsx'
import { useNarrow } from './ui.tsx'

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * `children` fill the body, which scrolls; they lay out their own padding,
 * so a form can pin its buttons to the bottom. Focus starts on the first
 * thing in the body that takes it. Escape closes it, asking first while
 * it is `unsaved`. A `bare` drawer draws no header: its children bring
 * their own heading and close button, and `title` only names the dialog.
 */
export function Drawer({ title, subtitle, icon, onClose, unsaved = false, width = 520, bare = false, children }: { title: string; subtitle?: ReactNode; icon?: ReactNode; onClose: () => void; unsaved?: boolean; width?: number; bare?: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const sheet = useNarrow()
  const lift = useKeyboardLift(sheet)
  useEscape(onClose, unsaved)

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const root = document.getElementById('root')
    root?.setAttribute('inert', '')
    ;(body.current?.querySelector<HTMLElement>(FOCUSABLE) ?? ref.current)?.focus()
    return () => {
      root?.removeAttribute('inert')
      opener?.focus()
    }
  }, [])

  const keys = (event: KeyboardEvent) => {
    if (event.key !== 'Tab' || !ref.current) return
    const all = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)]
    if (!all.length) return
    const first = all[0]!
    const last = all.at(-1)!
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-40">
      <div className="absolute inset-0 bg-ink-950/60" aria-hidden />
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={bare ? undefined : titleId} aria-label={bare ? title : undefined} tabIndex={-1} onKeyDown={keys} className={`absolute flex max-w-full flex-col bg-ink-900 elevate-pop outline-none ${sheet ? 'inset-x-0 rounded-t-2xl border-t border-ink-600 pb-[env(safe-area-inset-bottom)]' : 'inset-y-0 right-0 border-l border-ink-700'}`} style={sheet ? { bottom: lift, maxHeight: `calc(100dvh - ${lift}px - 32px)` } : { width }}>
        {sheet && <div className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-ink-600" aria-hidden />}
        {!bare && (
          <header className={`flex items-start gap-3 border-b border-ink-700 ${sheet ? 'px-4 py-3' : 'px-5 py-4'}`}>
            {icon && <div className="mt-0.5 shrink-0">{icon}</div>}
            <div className="min-w-0 flex-1">
              <h2 id={titleId} className="text-lg font-semibold tracking-tight text-ink-100">
                {title}
              </h2>
              {subtitle && <div className="mt-0.5 text-sm text-ink-300">{subtitle}</div>}
            </div>
            <button type="button" onClick={onClose} aria-label="Close" title="Close (Esc)" className="rounded-sm p-1.5 text-ink-300 hover:bg-ink-800 hover:text-ink-100">
              <X className="size-4" />
            </button>
          </header>
        )}
        <div ref={body} className="min-h-0 flex-1 overflow-y-auto">
          {children}
        </div>
      </div>
    </div>,
    document.body,
  )
}
