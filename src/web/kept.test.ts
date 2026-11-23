import { describe, expect, it } from 'vitest'
import { recall, remember, type Shelf } from './kept.ts'

function shelf(): Shelf & { size: () => number } {
  const held = new Map<string, string>()
  return { getItem: (k) => held.get(k) ?? null, setItem: (k, v) => void held.set(k, v), removeItem: (k) => void held.delete(k), size: () => held.size }
}

describe('the answers a browser keeps for the front page', () => {
  it('gives an answer back to the person it was given to', () => {
    const store = shelf()
    remember('summary', 'a@example.com', { blueprints: 3 }, store)
    expect(recall('summary', 'a@example.com', store)).toEqual({ blueprints: 3 })
    expect(recall('mine', 'a@example.com', store)).toBeUndefined()
  })

  it('never paints with answers of a shape the page no longer reads, and lets go of them', () => {
    const store = shelf()
    store.setItem('orrery.kept', JSON.stringify({ who: 'a@example.com', at: 1, answers: { mine: { things: [] } } }))
    expect(recall('mine', 'a@example.com', store)).toBeUndefined()
    expect(store.size()).toBe(0)
  })

  it("never gives one person another person's answer", () => {
    const store = shelf()
    remember('summary', 'a@example.com', { blueprints: 3 }, store)
    expect(recall('summary', 'b@example.com', store)).toBeUndefined()
  })

  it("lets go of the last person's answers when another signs in", () => {
    const store = shelf()
    remember('summary', 'a@example.com', { blueprints: 3 }, store)
    remember('mine', 'b@example.com', { state: 'known' }, store)
    expect(recall('summary', 'a@example.com', store)).toBeUndefined()
    expect(recall('summary', 'b@example.com', store)).toBeUndefined()
    expect(recall('mine', 'b@example.com', store)).toEqual({ state: 'known' })
  })

  it('keeps several answers for one person side by side', () => {
    const store = shelf()
    remember('summary', 'a@example.com', 1, store)
    remember('mine', 'a@example.com', 2, store)
    expect(recall('summary', 'a@example.com', store)).toBe(1)
    expect(recall('mine', 'a@example.com', store)).toBe(2)
  })

  it('shows nothing from storage it cannot read, and keeps nothing where it cannot write', () => {
    const broken: Shelf = {
      getItem: () => 'not json',
      setItem: () => {
        throw new Error('quota')
      },
      removeItem: () => undefined,
    }
    expect(recall('summary', 'a@example.com', broken)).toBeUndefined()
    expect(() => remember('summary', 'a@example.com', 1, broken)).not.toThrow()
    expect(recall('summary', 'a@example.com', null)).toBeUndefined()
    expect(() => remember('summary', 'a@example.com', 1, null)).not.toThrow()
  })
})
