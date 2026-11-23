import { describe, expect, it } from 'vitest'
import { freshSignIn, signInAgain, signedOut, type Page } from './session.ts'

function page(now: number, kept = new Map<string, string>()) {
  let reloads = 0
  const went: string[] = []
  const at: Page = { now, here: '/actions/sets/f289e68da814?tab=runs', reload: () => void reloads++, assign: (url) => void went.push(url), storage: { getItem: (k) => kept.get(k) ?? null, setItem: (k, v) => void kept.set(k, v) } }
  return { at, kept, reloads: () => reloads, went }
}

describe('a sign-in that ended', () => {
  it('is read from a redirect or a 401 and from nothing else', () => {
    expect(signedOut({ type: 'opaqueredirect', status: 0 })).toBe(true)
    expect(signedOut({ type: 'basic', status: 401 })).toBe(true)
    expect(signedOut({ type: 'basic', status: 403 })).toBe(false)
    expect(signedOut({ type: 'basic', status: 500 })).toBe(false)
    expect(signedOut({ type: 'basic', status: 200 })).toBe(false)
  })

  it('reloads the page once, and not again when that did not help', () => {
    const first = page(1_000_000)
    expect(signInAgain(first.at)).toBe(true)
    expect(first.reloads()).toBe(1)

    const stillOut = page(1_005_000, first.kept)
    expect(signInAgain(stillOut.at)).toBe(false)
    expect(stillOut.reloads()).toBe(0)
  })

  it('reloads again when the last reload was long ago', () => {
    const first = page(1_000_000)
    signInAgain(first.at)
    const later = page(1_000_000 + 3_600_000, first.kept)
    expect(signInAgain(later.at)).toBe(true)
    expect(later.reloads()).toBe(1)
  })
})

describe('a sign-in that lapsed for one thing the person did', () => {
  it('goes through the login proxy\'s fresh sign-in and back to the same page, not a reload', () => {
    const first = page(1_000_000)
    expect(signInAgain(first.at, '/oauth2/start')).toBe(true)
    expect(first.went).toEqual(['/oauth2/start?rd=%2Factions%2Fsets%2Ff289e68da814%3Ftab%3Druns'])
    expect(first.reloads()).toBe(0)
  })

  it('does not go round again when a fresh sign-in a moment ago did not help', () => {
    const first = page(1_000_000)
    signInAgain(first.at, '/oauth2/start')
    const again = page(1_010_000, first.kept)
    expect(signInAgain(again.at, '/oauth2/start')).toBe(false)
    expect(again.went).toEqual([])
  })

  it('leaves for no address off this host', () => {
    expect(freshSignIn('https://elsewhere.example/start', '/')).toBeNull()
    expect(freshSignIn('//elsewhere.example/start', '/')).toBeNull()
    expect(freshSignIn('/sso/start?prompt=none', '/x')).toBe('/sso/start?prompt=none&rd=%2Fx')
    const odd = page(1_000_000)
    signInAgain(odd.at, '//elsewhere.example')
    expect(odd.reloads()).toBe(1)
  })
})
