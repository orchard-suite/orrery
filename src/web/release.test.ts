import { describe, expect, it } from 'vitest'
import { BUILT, newRelease, noteServed } from './release.ts'

describe('the release the page runs', () => {
  it('is the one in package.json', async () => {
    const { version } = (await import('../../package.json', { with: { type: 'json' } })).default
    expect(BUILT).toBe(version)
  })

  it('names a newer release once the hub serves one, and nothing while it serves the page build', () => {
    noteServed('1.0.0', '1.0.0')
    expect(newRelease()).toBeNull()
    noteServed('1.1.0', '1.0.0')
    expect(newRelease()).toBe('1.1.0')
    noteServed('1.0.0', '1.0.0')
    expect(newRelease()).toBeNull()
  })
})
