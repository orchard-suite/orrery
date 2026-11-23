import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { compareReleases } from '../shared/preferences.ts'
import { laidOut, NOTES, unread, type ReleaseNote } from './whats-new.ts'

const version = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version
const note = (after: string): ReleaseNote => ({ after, title: after, text: '' })

describe('the release notes', () => {
  it('each name a release that already shipped, newest first', () => {
    for (const n of NOTES) {
      expect(n.after).toMatch(/^\d+\.\d+\.\d+$/)
      expect(compareReleases(n.after, version)).toBeLessThanOrEqual(0)
    }
    expect(NOTES.map((n) => n.after)).toEqual([...NOTES.map((n) => n.after)].sort((a, b) => compareReleases(b, a)))
  })

  it('shows what was written after the release a person last saw, and nothing before it', () => {
    const notes = [note('1.52.0'), note('1.51.0'), note('1.50.0')]
    // Seen 1.51.0: the note written while 1.51.0 was current shipped in 1.52.0, after it.
    expect(unread('1.51.0', notes).map((n) => n.after)).toEqual(['1.52.0', '1.51.0'])
    expect(unread('1.53.0', notes)).toEqual([])
    expect(unread('1.9.0', notes).map((n) => n.after)).toEqual(['1.52.0', '1.51.0', '1.50.0'])
  })

  it('shows none to a person who has seen no release: the tour is their start', () => {
    expect(unread(null, [note('1.50.0')])).toEqual([])
  })
})

describe('releases', () => {
  it('order by their numbers, not their text', () => {
    expect(compareReleases('1.10.0', '1.9.9')).toBeGreaterThan(0)
    expect(compareReleases('2.0.0', '2.0.0')).toBe(0)
    expect(compareReleases(null, '0.0.1')).toBeLessThan(0)
  })

  it('lays out the newest whole and the rest as titles', () => {
    const notes = ['1.55.0', '1.54.0', '1.53.0', '1.52.0', '1.51.0'].map(note)
    const { open, folded } = laidOut(notes, 3)
    expect(open.map((n) => n.after)).toEqual(['1.55.0', '1.54.0', '1.53.0'])
    expect(folded.map((n) => n.after)).toEqual(['1.52.0', '1.51.0'])
    expect(laidOut(notes.slice(0, 2), 3).folded).toEqual([])
  })
})
