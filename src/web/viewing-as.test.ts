import { afterEach, describe, expect, it } from 'vitest'
import { asViewed, viewingAs } from './api.ts'

describe('viewing as another person, away from a browser', () => {
  const held = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')
  afterEach(() => {
    if (held) Object.defineProperty(globalThis, 'sessionStorage', held)
  })

  it('views as no one where there is no session storage, as on the server or in an older Node', () => {
    if (held) Reflect.deleteProperty(globalThis, 'sessionStorage')
    expect(typeof sessionStorage).toBe('undefined')
    expect(viewingAs()).toBeNull()
    expect(asViewed('/v1/action-runs/r1/outputs/screen')).toBe('/v1/action-runs/r1/outputs/screen')
  })
})
