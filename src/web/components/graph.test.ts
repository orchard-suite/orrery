import { describe, expect, it } from 'vitest'
import { wheelZoom, ZOOM_STEP } from './graph.ts'

const wheel = (over: Partial<Parameters<typeof wheelZoom>[0]>) => ({ deltaY: 0, deltaMode: 0, ctrlKey: false, metaKey: false, ...over })

describe('a wheel event', () => {
  it('zooms one step for a mouse notch of 120 pixels, in when rolled up', () => {
    expect(wheelZoom(wheel({ deltaY: -120 }))).toBeCloseTo(ZOOM_STEP)
    expect(wheelZoom(wheel({ deltaY: 120 }))).toBeCloseTo(1 / ZOOM_STEP)
  })

  it('zooms no more than one step however fast the wheel spins', () => {
    expect(wheelZoom(wheel({ deltaY: 400 }))).toBeCloseTo(1 / ZOOM_STEP)
  })

  it('zooms one step for a wheel that counts in lines or pages', () => {
    expect(wheelZoom(wheel({ deltaY: 3, deltaMode: 1 }))).toBeCloseTo(1 / ZOOM_STEP)
    expect(wheelZoom(wheel({ deltaY: -1, deltaMode: 2 }))).toBeCloseTo(ZOOM_STEP)
  })

  it('zooms a little for a small trackpad scroll, and never pans', () => {
    const f = wheelZoom(wheel({ deltaY: -2 }))
    expect(f).toBeGreaterThan(1)
    expect(f).toBeLessThan(1.01)
  })

  it('does nothing sideways', () => {
    expect(wheelZoom(wheel({ deltaY: 0 }))).toBe(1)
  })

  it('zooms a pinch by its size, faster than a scroll', () => {
    expect(wheelZoom(wheel({ deltaY: -10, ctrlKey: true }))).toBeCloseTo(Math.exp(0.1))
  })

  it('zooms a mouse wheel with control held no more than one step', () => {
    expect(wheelZoom(wheel({ deltaY: 120, ctrlKey: true }))).toBeCloseTo(1 / ZOOM_STEP)
  })
})
