// The model page's graph: the camera, the zoom tiers, and the edge colours.

import { useReactFlow, useStore, type ReactFlowProps } from '@xyflow/react'
import { useEffect, useMemo, useState, type RefObject } from 'react'

/** How long every camera move and every card move takes: none for a person who asks for less motion, read when the page loads. */
export const DURATION = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 400

const MIN_ZOOM = 0.1
const MAX_ZOOM = 4

/** One zoom step: the buttons, the + and - keys, and one mouse wheel notch. */
export const ZOOM_STEP = 1.25

/** How much a double-click on the empty canvas zooms in, around the spot. */
const DOUBLE_CLICK_ZOOM = 1.6

/** The pixels one mouse notch reports in Chromium, Safari, and Firefox in pixel mode. */
const NOTCH_PX = 120
/** Zoom per pixel of scroll: one notch is one step. */
const SCROLL_RATE = Math.log(ZOOM_STEP) / NOTCH_PX
/** Zoom per pixel of pinch delta. */
const PINCH_RATE = 0.01
/** The most one wheel event may zoom, in log scale: one step, however fast the wheel spins. */
const MAX_LOG_STEP = Math.log(ZOOM_STEP)
/** The share of the remaining zoom a glide covers each frame. */
const GLIDE_RATE = 0.3

/**
 * The zoom factor a wheel event asks for; 1 means none, above 1 zooms in.
 * The wheel never pans; a drag does that. Every vertical wheel event zooms by
 * its size, so a mouse notch, a trackpad swipe, and a pinch all glide the
 * same way the buttons do. A pinch arrives with the control key held and small
 * deltas, so it zooms faster per pixel. Sideways deltas do nothing. Mouse and
 * trackpad are not told apart: browsers send the same shape for both.
 */
export function wheelZoom(e: Pick<WheelEvent, 'deltaY' | 'deltaMode' | 'ctrlKey' | 'metaKey'>): number {
  if (!e.deltaY) return 1
  // Lines or pages come from a notched wheel: one full step per event.
  const log = e.deltaMode !== 0 ? -Math.sign(e.deltaY) * MAX_LOG_STEP : -e.deltaY * (e.ctrlKey || e.metaKey ? PINCH_RATE : SCROLL_RATE)
  return Math.exp(Math.max(-MAX_LOG_STEP, Math.min(MAX_LOG_STEP, log)))
}

const clampZoom = (z: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z))

/** What the page asks of the camera: a zoom by a factor (around a point on screen, or the middle), and the whole model. */
export interface Camera {
  zoomBy: (f: number, at?: { clientX: number; clientY: number }) => void
  fit: () => void
}

/**
 * The model page's camera. Every wheel event over the graph zooms toward the
 * pointer and glides there; steps that arrive mid-glide add to where it is
 * heading. A double-click on the empty canvas zooms in on the spot; F fits,
 * + and - zoom. `ref` is the element around the flow; its listeners take the
 * wheel before the flow sees it.
 */
export function useCamera(ref: RefObject<HTMLElement | null>): Camera {
  const flow = useReactFlow()
  const camera = useMemo<Camera>(() => {
    let glide: { target: number; x: number; y: number } | null = null
    const pane = () => ref.current?.querySelector('.react-flow__renderer')?.getBoundingClientRect()
    const zoomAt = (x: number, y: number, k: number) => {
      const v = flow.getViewport()
      const next = clampZoom(v.zoom * k)
      void flow.setViewport({ x: x - ((x - v.x) * next) / v.zoom, y: y - ((y - v.y) * next) / v.zoom, zoom: next })
    }
    const frame = () => {
      if (!glide) return
      const rest = glide.target / flow.getViewport().zoom
      if (Math.abs(Math.log(rest)) < 0.002) {
        const g = glide
        glide = null
        return zoomAt(g.x, g.y, rest)
      }
      zoomAt(glide.x, glide.y, rest ** GLIDE_RATE)
      requestAnimationFrame(frame)
    }
    return {
      zoomBy: (f, at) => {
        const box = pane()
        if (!box) return
        const x = at ? at.clientX - box.left : box.width / 2
        const y = at ? at.clientY - box.top : box.height / 2
        const target = clampZoom((glide?.target ?? flow.getViewport().zoom) * f)
        if (!DURATION) return zoomAt(x, y, target / flow.getViewport().zoom)
        const running = glide !== null
        glide = { target, x, y }
        if (!running) requestAnimationFrame(frame)
      },
      fit: () => void flow.fitView({ padding: 0.15, duration: DURATION }),
    }
  }, [ref, flow])
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onPane = (e: Event) => e.target instanceof Element && !!e.target.closest('.react-flow__renderer') && !e.target.closest('.nowheel')
    const onWheel = (e: WheelEvent) => {
      if (!onPane(e)) return
      e.preventDefault()
      e.stopPropagation()
      const f = wheelZoom(e)
      if (f !== 1) camera.zoomBy(f, e)
    }
    const onDoubleClick = (e: MouseEvent) => {
      if (e.target instanceof Element && e.target.classList.contains('react-flow__pane')) camera.zoomBy(DOUBLE_CLICK_ZOOM, e)
    }
    const onKey = (e: KeyboardEvent) => {
      const t = e.target
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (t instanceof HTMLElement && (t.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(t.tagName))) return
      if (document.querySelector('[role="dialog"], [role="menu"]')) return
      if (e.key === 'f' || e.key === 'F') camera.fit()
      else if (e.key === '+' || e.key === '=') camera.zoomBy(ZOOM_STEP)
      else if (e.key === '-' || e.key === '_') camera.zoomBy(1 / ZOOM_STEP)
      else return
      e.preventDefault()
    }
    el.addEventListener('wheel', onWheel, { capture: true, passive: false })
    el.addEventListener('dblclick', onDoubleClick)
    window.addEventListener('keydown', onKey)
    return () => {
      el.removeEventListener('wheel', onWheel, { capture: true })
      el.removeEventListener('dblclick', onDoubleClick)
      window.removeEventListener('keydown', onKey)
    }
  }, [ref, camera])
  return camera
}

/**
 * Flies the camera to a node. The flight waits a beat, so a side panel the
 * same click opens has taken its room and the node lands in the middle of
 * what is left. A second call before the first leaves replaces it.
 */
export function useFlyTo(): (id: string) => void {
  const flow = useReactFlow()
  const [flight, setFlight] = useState<{ id: string } | null>(null)
  useEffect(() => {
    if (!flight) return
    const t = setTimeout(() => void flow.fitView({ nodes: [{ id: flight.id }], duration: DURATION, maxZoom: 1, padding: 0.5 }), 60)
    return () => clearTimeout(t)
  }, [flight, flow])
  return (id) => setFlight({ id })
}

/**
 * The React Flow props for the camera. The wheel is the camera's own (`useCamera`).
 * A drag on the empty canvas pans, and so does one with Space held or the
 * middle button; Shift and a drag draws a box round the cards to pick; a drag
 * on a card moves it. A touch pinch is React Flow's.
 */
export function cameraProps(): Pick<ReactFlowProps, 'panOnScroll' | 'zoomOnScroll' | 'zoomOnPinch' | 'zoomOnDoubleClick' | 'panOnDrag' | 'selectionOnDrag' | 'selectionKeyCode' | 'panActivationKeyCode' | 'zoomActivationKeyCode' | 'minZoom' | 'maxZoom' | 'nodeDragThreshold' | 'paneClickDistance' | 'fitViewOptions' | 'proOptions'> {
  return {
    panOnScroll: false,
    zoomOnScroll: false,
    zoomOnPinch: true,
    zoomOnDoubleClick: false,
    panOnDrag: [0, 1, 2],
    selectionOnDrag: false,
    selectionKeyCode: 'Shift',
    panActivationKeyCode: 'Space',
    zoomActivationKeyCode: null,
    minZoom: MIN_ZOOM,
    maxZoom: MAX_ZOOM,
    nodeDragThreshold: 4,
    paneClickDistance: 4,
    fitViewOptions: { padding: 0.1, duration: DURATION },
    proOptions: { hideAttribution: true },
  }
}

/** How much of a card is drawn. Far: a dot. Mid: icon and title. Near: everything. */
export type Tier = 'far' | 'mid' | 'near'

export const tierOf = (zoom: number): Tier => (zoom < 0.35 ? 'far' : zoom < 0.75 ? 'mid' : 'near')

/** The tier for the current zoom. Re-renders only when the tier changes, not on every pan. */
export function useTier(): Tier {
  return useStore((s) => tierOf(s.transform[2]))
}

/** Edge colours: the line, the lit line, and the arrowhead each takes. */
export const LINE = 'var(--color-line)'
export const LINE_LIT = 'var(--color-orbit)'
