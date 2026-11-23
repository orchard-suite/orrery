import { describe, expect, it } from 'vitest'
import { emptyLayers, resolve, validateValue } from './values.ts'

describe('an openapi value', () => {
  const def = { type: 'openapi' } as const

  it('is a document or a link to one', () => {
    expect(validateValue(def, { openapi: '3.1.0', info: { title: 'A', version: '1' }, paths: {} })).toBeNull()
    expect(validateValue(def, { swagger: '2.0' })).toBeNull()
    expect(validateValue(def, 'https://github.com/acme/hub/blob/HEAD/openapi.json')).toBeNull()
  })

  it('is refused as anything else', () => {
    expect(validateValue(def, 'openapi.json')).toMatch(/neither/)
    expect(validateValue(def, { info: {} })).toMatch(/OpenAPI or Swagger/)
    expect(validateValue(def, [])).toMatch(/OpenAPI or Swagger/)
  })
})

describe('a trend value', () => {
  const def = { type: 'trend' } as const

  it('is a short series of points over time, with how to draw it', () => {
    expect(validateValue(def, { points: [] })).toBeNull()
    expect(validateValue(def, { points: [{ at: '2026-11-01T00:00:00Z', value: 3 }, { at: '2026-11-04T00:00:00Z', value: 2 }], step: true, min: 0, max: 3, labels: { '0': 'None', '3': 'gold' }, from: '2026-08-08T00:00:00Z', to: '2026-11-06T00:00:00Z', link: 'https://trellis.example.org/?open=s', link_title: 'Open in Trellis' })).toBeNull()
  })

  it('is refused when a point or a setting is not what it says', () => {
    expect(validateValue(def, [1, 2, 3])).toMatch(/trend/)
    expect(validateValue(def, { points: [{ at: 'yesterday', value: 1 }] })).toMatch(/points\.0\.at/)
    expect(validateValue(def, { points: [{ at: '2026-11-01T00:00:00Z', value: 'gold' }] })).toMatch(/points\.0\.value/)
    expect(validateValue(def, { points: [], link: 'not a link' })).toMatch(/link/)
    expect(validateValue(def, { points: [], colour: 'red' })).toMatch(/trend/)
  })

  it('holds a summary, not a history', () => {
    const points = Array.from({ length: 401 }, (_, i) => ({ at: new Date(Date.UTC(2026, 0, 1) + i * 864e5).toISOString(), value: i }))
    expect(validateValue(def, { points })).toMatch(/at most 400/)
  })
})

describe('a computed field', () => {
  const at = '2026-11-01T00:00:00Z'
  const layers = () => {
    const l = emptyLayers()
    l.pushed.departed_at = { value: '2026-06-04T00:00:00Z', source: 'old-source', at }
    l.ui.departed_at = { value: '2026-06-05T00:00:00Z', by: 'user@example.com', at }
    return l
  }

  it('has no stored winner, so a value kept from before it was a mirror neither shows nor names a source', () => {
    expect(resolve('departed_at', layers(), { type: 'datetime', mirror: '<-termination:person.departed_at' })).toBeNull()
    expect(resolve('departed_at', layers(), { type: 'number', aggregation: { relation: '<-termination:person', fn: 'count' } })).toBeNull()
    expect(resolve('departed_at', layers(), { type: 'datetime', calculation: 'now()' })).toBeNull()
  })

  it('leaves a stored field to its layers', () => {
    expect(resolve('departed_at', layers(), { type: 'datetime' })?.provenance).toMatchObject({ layer: 'pushed', source: 'old-source' })
  })
})
