import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SPOTS, TOUR_STEPS } from '../shared/welcome.ts'

const dir = new URL('.', import.meta.url).pathname
const sources = readdirSync(dir, { recursive: true, encoding: 'utf8' })
  .filter((f) => f.endsWith('.tsx') && !f.includes('.test.'))
  .map((f) => readFileSync(join(dir, f), 'utf8'))
  .join('\n')

describe('the places the tour points at', () => {
  it('are each marked somewhere in the web app', () => {
    const marked = new Set([...sources.matchAll(/spot\('([\w.]+)'\)/g)].map((m) => m[1]))
    expect(SPOTS.filter((name) => !marked.has(name))).toEqual([])
    expect([...marked].filter((name) => !(SPOTS as readonly string[]).includes(name!))).toEqual([])
  })

  it('are each pointed at by a step', () => {
    const pointed = new Set(Object.values(TOUR_STEPS).map((s) => s.spot))
    expect(SPOTS.filter((name) => !pointed.has(name))).toEqual([])
  })
})
