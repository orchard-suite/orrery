// Escape closes the newest thing a person opened: a popover, a drawer, a
// dialog, the palette, the tour, or a panel beside the page. Each one holds a
// place with `useEscape` while it is open. One listener on the document hears
// Escape wherever focus is, on the page behind included, and closes only the
// newest. A control that spends Escape on itself first (an open list, a field
// that clears) stops the event or prevents its default, and nothing closes. A
// form with changes it has not saved asks before Escape lets them go.

import { useEffect, useRef } from 'react'

/** The places open now, the newest last. */
export class Layers {
  private open: (() => void)[] = []

  /** Holds a place on top; the answer gives it back. */
  add(close: () => void): () => void {
    const me = () => close()
    this.open.push(me)
    return () => {
      const at = this.open.indexOf(me)
      if (at >= 0) this.open.splice(at, 1)
    }
  }

  /** Closes the newest place, and says whether there was one. */
  escape(): boolean {
    const top = this.open.at(-1)
    top?.()
    return !!top
  }
}

const layers = new Layers()
let listening = false

function heard(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return
  // Prevented, so a native dialog does not cancel itself as well.
  if (layers.escape()) event.preventDefault()
}

/** What a person is asked before Escape lets go of a form they changed. */
export const DISCARD = 'Discard the changes you have not saved?'

/**
 * Escape anywhere calls `onClose`, unless something opened after this is
 * still open. While `unsaved`, it asks first, and a person who says no keeps
 * what they typed.
 */
export function useEscape(onClose: () => void, unsaved = false): void {
  const close = useRef(onClose)
  close.current = onClose
  const holds = useRef(unsaved)
  holds.current = unsaved
  useEffect(() => {
    if (!listening) {
      document.addEventListener('keydown', heard)
      listening = true
    }
    return layers.add(() => {
      if (!holds.current || confirm(DISCARD)) close.current()
    })
  }, [])
}

/** Whether `value` differs from what it was when the component first drew: a form's unsaved changes. */
export function useChanged(value: unknown): boolean {
  const first = useRef<string | null>(null)
  const now = JSON.stringify(value)
  first.current ??= now
  return now !== first.current
}
