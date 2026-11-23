import { describe, expect, it } from 'vitest'
import { tipShown, type TipAt } from './Atlas.tsx'

describe('the hover card', () => {
  const tip: TipAt = { x: 10, y: 20, body: 'Ember Web App API', on: '/map/app?at=prod' }

  it('shows on the address it was shown on', () => {
    expect(tipShown(tip, '/map/app?at=prod')).toBe(tip)
  })

  it('is left behind when the page steps to another address', () => {
    expect(tipShown(tip, '/map/app?at=prod&plot=ember-api')).toBeNull()
  })
})
