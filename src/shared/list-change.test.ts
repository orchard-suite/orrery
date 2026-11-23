import { describe, expect, it } from 'vitest'
import { changeLines, changes, editsList, heldList, listChange, runChanges } from './list-change.ts'
import type { ActionInputDef } from './model.ts'

describe('which inputs change a list the entity holds', () => {
  it('is a list of a kind that does not pick, with a current', () => {
    expect(editsList({ type: 'url', many: true, current: '{{ entity.fields.origins }}' })).toBe(true)
    expect(editsList({ type: 'url', many: true })).toBe(false)
    expect(editsList({ type: 'url', current: '{{ entity.fields.origins }}' })).toBe(false)
    // An entity input's current marks the option in use; it changes no list.
    expect(editsList({ type: 'entity', many: true, current: '{{ entity.fields.images }}' })).toBe(false)
    expect(editsList(undefined)).toBe(false)
  })
})

describe('the list a current renders to', () => {
  it('reads a list, text a value a line, one value, and nothing', () => {
    expect(heldList({ type: 'string' }, ['a', 'b'])).toEqual(['a', 'b'])
    expect(heldList({ type: 'string' }, 'a\n\n b \n')).toEqual(['a', 'b'])
    expect(heldList({ type: 'string' }, 'one')).toEqual(['one'])
    expect(heldList({ type: 'string' }, null)).toEqual([])
    expect(heldList({ type: 'string' }, ['a', null, ''])).toEqual(['a'])
  })

  it('stores each value as its kind does, and keeps one the kind does not take as it is', () => {
    expect(heldList({ type: 'number' }, ['1', 2, 'x'])).toEqual([1, 2, 'x'])
    expect(heldList({ type: 'email' }, ['Ada@Example.ORG'])).toEqual(['Ada@example.org'])
  })
})

describe('a list against the one held', () => {
  it('says what it adds, removes, and keeps, each once', () => {
    expect(listChange(['a', 'b', 'c'], ['b', 'd', 'a', 'd'])).toEqual({ added: ['d'], removed: ['c'], unchanged: ['b', 'a'] })
  })

  it('reads as a set: neither order nor a repeat is a change', () => {
    const c = listChange(['a', 'b'], ['b', 'a', 'a'])
    expect(changes(c)).toBe(false)
    expect(changes(listChange([], []))).toBe(false)
    expect(changes(listChange(['a'], []))).toBe(true)
  })

  it('tells a number from the same digits as text', () => {
    expect(listChange([1], ['1'])).toEqual({ added: ['1'], removed: [1], unchanged: [] })
  })

  it('reads the change of each input a run keeps a list for, and nothing else', () => {
    const defs: Record<string, ActionInputDef> = { origins: { type: 'url', many: true, current: '{{ x }}' }, tags: { type: 'string', many: true } }
    expect(runChanges(defs, { origins: ['https://b'], tags: ['x'] }, { origins: ['https://a'], tags: ['y'] })).toEqual({ origins: { added: ['https://b'], removed: ['https://a'], unchanged: [] } })
    expect(runChanges(defs, { origins: null }, { origins: ['https://a'] })).toEqual({ origins: { added: [], removed: ['https://a'], unchanged: [] } })
    expect(runChanges(defs, { origins: [] }, undefined)).toEqual({})
  })

  it('says a change in words', () => {
    expect(changeLines('Origins', listChange(['a', 'b'], ['b', 'c']))).toEqual(['Origins adds: c', 'Origins removes: a'])
    expect(changeLines('Origins', listChange(['a'], ['a', 'b']))).toEqual(['Origins adds: b'])
    expect(changeLines('Origins', listChange(['a'], ['a']))).toEqual(['Origins: changes nothing'])
  })
})
