import { describe, expect, it } from 'vitest'
import { placeNote } from './Tour.tsx'

const view = { width: 1440, height: 900 }
const card = { width: 360, height: 200 }

describe('where the tour puts its note', () => {
  it('puts it to the right of a place with room there', () => {
    expect(placeNote({ top: 0, left: 0, width: 272, height: 900 }, card, view)).toEqual({ top: 16, left: 286 })
  })

  it('puts it under a place that fills the width, and over one at the foot of the window', () => {
    expect(placeNote({ top: 100, left: 300, width: 1100, height: 120 }, card, view)).toEqual({ top: 234, left: 300 })
    expect(placeNote({ top: 650, left: 300, width: 1100, height: 240 }, card, view)).toEqual({ top: 436, left: 300 })
  })

  it('puts it at the foot of the window over a place that fills it, and in the middle when it points at nothing', () => {
    expect(placeNote({ top: 6, left: 6, width: 1428, height: 888 }, card, view)).toEqual({ top: 676, left: 540 })
    expect(placeNote(null, card, view)).toEqual({ top: 350, left: 540 })
  })
})
