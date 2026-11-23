import { describe, expect, it } from 'vitest'
import { compact, expand, ROOM, squeeze, squeezed, unsqueezed, type Rect, type Size } from './layout.ts'

const box: Rect = { x: 0, y: 0, w: 600, h: 400 }
const right: Rect = { x: 616, y: 100, w: 240, h: 56 }
const below: Rect = { x: 100, y: 416, w: 240, h: 56 }
const corner: Rect = { x: 616, y: 416, w: 240, h: 56 }
const far: Rect = { x: 616, y: 900, w: 240, h: 56 }
const inside: Rect = { x: 24, y: 48, w: 240, h: 56 }
const rects = { box, right, below, corner, far, inside }
const closed: Record<string, Size> = { box: { w: 240, h: 56 } }

describe('compact', () => {
  it('moves what sits right of and below a shrunk box by the shrink, and nothing else', () => {
    const shown = compact(rects, closed)
    expect(shown.right).toEqual({ x: 616 - 360, y: 100 })
    expect(shown.below).toEqual({ x: 100, y: 416 - 344 })
    expect(shown.corner).toEqual({ x: 616, y: 416 })
    expect(shown.far).toEqual({ x: 616, y: 900 })
    expect(shown.inside).toEqual({ x: 24, y: 48 })
    expect(shown.box).toEqual({ x: 0, y: 0 })
  })

  it('accumulates over a chain of shrunk boxes', () => {
    const a: Rect = { x: 0, y: 0, w: 600, h: 100 }
    const b: Rect = { x: 616, y: 0, w: 600, h: 100 }
    const c: Rect = { x: 1232, y: 0, w: 240, h: 56 }
    const shown = compact({ a, b, c }, { a: { w: 240, h: 56 }, b: { w: 240, h: 56 } })
    expect(shown.b).toEqual({ x: 256, y: 0 })
    expect(shown.c).toEqual({ x: 1232 - 720, y: 0 })
  })

  it('pushes neighbours away from a grown card', () => {
    const a: Rect = { x: 0, y: 0, w: 260, h: 44 }
    const b: Rect = { x: 0, y: 60, w: 260, h: 44 }
    const shown = compact({ a, b }, { a: { w: 260, h: 300 } })
    expect(shown.b).toEqual({ x: 0, y: 60 + 256 })
  })

  it('changes nothing when every shown size matches', () => {
    expect(compact(rects, {})).toEqual(Object.fromEntries(Object.entries(rects).map(([id, r]) => [id, { x: r.x, y: r.y }])))
  })
})

describe('expand', () => {
  it('returns every card to its stored position from where compact shows it', () => {
    const shown = compact(rects, closed)
    for (const [id, r] of Object.entries(rects)) {
      expect(expand(id, shown[id]!, { w: r.w, h: r.h }, rects, closed)).toEqual({ x: r.x, y: r.y })
    }
  })

  it('round-trips a grid of cards past two shrunk boxes in both axes', () => {
    const all: Record<string, Rect> = { a: { x: 0, y: 0, w: 500, h: 300 }, b: { x: 520, y: 0, w: 500, h: 300 }, c: { x: 0, y: 320, w: 500, h: 300 } }
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) all[`n${i}${j}`] = { x: 1040 + i * 256, y: 640 + j * 72, w: 240, h: 56 }
    const shrunk = { a: { w: 240, h: 56 }, b: { w: 240, h: 56 }, c: { w: 240, h: 56 } }
    const shown = compact(all, shrunk)
    for (const [id, r] of Object.entries(all)) {
      expect(expand(id, shown[id]!, { w: r.w, h: r.h }, all, shrunk)).toEqual({ x: r.x, y: r.y })
    }
  })

  it('puts a card dropped beside a closed box beside the open one', () => {
    const dropped = expand('new', { x: 256, y: 10 }, { w: 240, h: 56 }, { box }, closed)
    expect(dropped).toEqual({ x: 616, y: 10 })
  })

  it('puts a card dropped under an open card under it when it closes', () => {
    const a: Rect = { x: 0, y: 0, w: 260, h: 44 }
    const grown = { a: { w: 260, h: 300 } }
    expect(expand('new', { x: 0, y: 320 }, { w: 260, h: 44 }, { a }, grown)).toEqual({ x: 0, y: 64 })
  })
})

describe('squeeze', () => {
  const card = (x: number, y: number): Rect => ({ x, y, w: 260, h: 44 })
  const team = card(4000, 0)
  const deployment = card(0, 3000)
  const between = [card(1000, 1000), card(2000, 2000), card(3000, 500)]

  it('closes the room hidden cards left between the shown ones, down to the room a layout keeps', () => {
    const s = squeeze([team, deployment], between)
    expect(squeezed(deployment, s)).toEqual({ x: 0, y: 44 + ROOM })
    expect(squeezed(team, s)).toEqual({ x: 260 + ROOM, y: 0 })
  })

  it('leaves a model with nothing hidden as stored', () => {
    const s = squeeze([team, deployment, ...between], [])
    expect(s).toEqual({ x: [], y: [] })
    expect(squeezed(team, s)).toEqual({ x: 4000, y: 0 })
  })

  it('keeps a gap no hidden card sits in', () => {
    const s = squeeze([card(0, 0), card(2000, 0), card(4000, 0)], [card(3000, 0)])
    expect(squeezed(card(2000, 0), s)).toEqual({ x: 2000, y: 0 })
    expect(squeezed(card(4000, 0), s)).toEqual({ x: 2260 + ROOM, y: 0 })
  })

  it('puts a dropped card back where it is stored', () => {
    const s = squeeze([team, deployment], between)
    for (const p of [team, deployment, { x: 300, y: 100 }, { x: 0, y: 0 }, { x: 5000, y: 4000 }]) expect(unsqueezed(squeezed(p, s), s)).toEqual({ x: p.x, y: p.y })
  })
})
