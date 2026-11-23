import { describe, expect, it } from 'vitest'
import { withSpread, withType } from './FieldForm.tsx'

describe('changing a field’s kind', () => {
  it('keeps the chip mark on a kind that may be a chip, and drops it on one that may not', () => {
    expect(withType({ type: 'string', chip: true }, 'user')).toEqual({ type: 'user', chip: true })
    expect(withType({ type: 'user', chip: true }, 'email')).toEqual({ type: 'email', chip: true })
    expect(withType({ type: 'user', chip: true }, 'number')).toEqual({ type: 'number' })
    expect(withType({ type: 'string', chip: true }, 'enum')).toEqual({ type: 'enum' })
  })
})

describe('counting a field under the grid', () => {
  it('marks only what differs from the kind’s own way', () => {
    // A chip is counted by default: turning the count off marks it, and on again clears the mark.
    expect(withSpread({ type: 'string', chip: true }, false)).toEqual({ type: 'string', chip: true, spread: false })
    expect(withSpread({ type: 'string', chip: true, spread: false }, true)).toEqual({ type: 'string', chip: true })
    // Plain text is not counted by default: counting it marks it.
    expect(withSpread({ type: 'string' }, true)).toEqual({ type: 'string', spread: true })
    expect(withSpread({ type: 'string', spread: true }, false)).toEqual({ type: 'string' })
  })

  it('keeps the count mark across kinds that may be counted, and drops it on one that may not', () => {
    expect(withType({ type: 'string', chip: true, spread: false }, 'enum')).toEqual({ type: 'enum', spread: false })
    expect(withType({ type: 'string', spread: true }, 'number')).toEqual({ type: 'number' })
  })
})
