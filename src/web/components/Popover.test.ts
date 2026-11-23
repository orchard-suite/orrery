import { describe, expect, it } from 'vitest'
import { sheetParts } from './Popover.tsx'

describe('sheetParts', () => {
  it('gives the spacing to what the sheet holds and keeps the rest on the frame', () => {
    expect(sheetParts('max-h-[85vh] w-[460px] space-y-3 overflow-y-auto p-4')).toEqual({ frame: 'max-h-[85vh] w-[460px] overflow-y-auto', body: 'space-y-3 p-4' })
    expect(sheetParts('py-1')).toEqual({ frame: '', body: 'py-1' })
  })
  it('leaves a class that only starts like spacing on the frame', () => {
    expect(sheetParts('pointer-events-auto grid-cols-6')).toEqual({ frame: 'pointer-events-auto grid-cols-6', body: '' })
  })
})
