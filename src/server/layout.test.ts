import { describe, expect, it } from 'vitest'
import { MODEL_H, MODEL_W, type Rect } from '../shared/layout.ts'
import { layout, placeAll, placeModel } from './layout.ts'
import type { Blueprint } from '../shared/model.ts'

const card = (id: string) => ({ id, w: MODEL_W, h: MODEL_H })
const apart = (a: Rect, b: Rect) => a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y

describe('layout', () => {
  it('puts a chain in tiers, left to right, what nothing points at first', async () => {
    const r = await layout([card('a'), card('b'), card('c')], [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }])
    expect(r.get('a')!.x + MODEL_W).toBeLessThanOrEqual(r.get('b')!.x)
    expect(r.get('b')!.x + MODEL_W).toBeLessThanOrEqual(r.get('c')!.x)
  })

  it('packs islands without overlap', async () => {
    const nodes = Array.from({ length: 12 }, (_, i) => card(`n${i}`))
    const r = await layout(nodes, [])
    const rects = [...r.values()]
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) expect(apart(rects[i]!, rects[j]!)).toBe(true)
    const w = Math.max(...rects.map((x) => x.x + x.w))
    const h = Math.max(...rects.map((x) => x.y + x.h))
    expect(w / h).toBeLessThan(6)
  })

  it('drops an edge to itself and a repeated edge', async () => {
    const r = await layout([card('a'), card('b')], [{ from: 'a', to: 'a' }, { from: 'a', to: 'b' }, { from: 'a', to: 'b' }])
    expect(r.get('a')!.x).toBeLessThan(r.get('b')!.x)
  })
})

const bp = (id: string, relations: Record<string, string> = {}): Blueprint => ({ id, title: id, fields: {}, relations: Object.fromEntries(Object.entries(relations).map(([k, target]) => [k, { target }])), origin: { kind: 'ui' }, updatedAt: '' })

describe('placeModel', () => {
  it('lays the whole model out, left to right, when nothing is stored', async () => {
    const placed = await placeModel([bp('svc', { repo: 'repo' }), bp('repo'), bp('team')], {})
    expect(Object.keys(placed).sort()).toEqual(['repo', 'svc', 'team'])
    expect(placed.svc!.x + MODEL_W).toBeLessThan(placed.repo!.x)
  })

  it('places a newcomer beside what it relates to and leaves the rest alone', async () => {
    const stored = { repo: { x: 500, y: 100 } }
    const placed = await placeModel([bp('svc', { repo: 'repo' }), bp('repo')], stored)
    expect(Object.keys(placed)).toEqual(['svc'])
    expect(placed.svc!.x).toBeLessThan(500)
    expect(placed.svc!.y).toBe(100)
  })

  it('returns nothing when everything has a position', async () => {
    expect(await placeModel([bp('repo')], { repo: { x: 0, y: 0 } })).toEqual({})
  })
})

describe('placeAll', () => {
  it('lays out what is shown alone, then sets each hidden blueprint beside its neighbours', async () => {
    const placed = await placeAll([bp('svc', { repo: 'repo' }), bp('repo'), bp('lib', { repo: 'repo' })], ['lib'], {})
    expect(Object.keys(placed).sort()).toEqual(['lib', 'repo', 'svc'])
    expect(placed.lib!.x + MODEL_W).toBeLessThan(placed.repo!.x)
    expect(Math.abs(placed.lib!.x - placed.svc!.x) >= MODEL_W || Math.abs(placed.lib!.y - placed.svc!.y) >= MODEL_H).toBe(true)
  })
})
