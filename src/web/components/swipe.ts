// A sideways swipe on a touch screen. It leaves alone what the browser and
// the page already use a swipe for: a stroke that starts at either edge of
// the screen is the browser's back and forward, and one inside something that
// scrolls sideways is that thing's scroll.

import { useRef, type TouchEvent } from 'react'

/** How far a finger must travel sideways, in pixels, for a swipe. */
const FAR = 60
/** The strip at each edge of the screen that belongs to the browser. */
const EDGE = 24

/** True when `el`, or something it sits in below `root`, scrolls sideways. */
function scrollsSideways(el: Element | null, root: Element): boolean {
  for (let at = el; at && at !== root; at = at.parentElement) {
    const overflow = getComputedStyle(at).overflowX
    if ((overflow === 'auto' || overflow === 'scroll') && at.scrollWidth > at.clientWidth) return true
  }
  return false
}

/** The touch handlers to spread on an element: `onNext` for a swipe to the left, `onPrevious` for one to the right. */
export function useSwipe({ onNext, onPrevious }: { onNext?: () => void; onPrevious?: () => void }) {
  const start = useRef<{ x: number; y: number } | null>(null)
  return {
    onTouchStart: (event: TouchEvent<HTMLElement>) => {
      const t = event.touches[0]
      const ok = event.touches.length === 1 && t && t.clientX > EDGE && t.clientX < innerWidth - EDGE && !scrollsSideways(event.target as Element, event.currentTarget)
      start.current = ok ? { x: t.clientX, y: t.clientY } : null
    },
    onTouchEnd: (event: TouchEvent<HTMLElement>) => {
      const from = start.current
      const t = event.changedTouches[0]
      start.current = null
      if (!from || !t) return
      const dx = t.clientX - from.x
      const dy = t.clientY - from.y
      // Mostly sideways, or it was a scroll down the page.
      if (Math.abs(dx) < FAR || Math.abs(dx) < 2 * Math.abs(dy)) return
      if (dx < 0) onNext?.()
      else onPrevious?.()
    },
  }
}
