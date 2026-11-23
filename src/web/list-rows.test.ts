import { describe, expect, it } from 'vitest'
import { pasteRows, rowProblem, rowsValue, rowTexts, startList } from './list-rows.ts'

const today = '2026-11-20'

describe('the rows of a list', () => {
  it('shows a value a row, and nothing as one empty row to type in', () => {
    expect(rowTexts(['a', 2])).toEqual(['a', '2'])
    expect(rowTexts('a\nb')).toEqual(['a', 'b'])
    expect(rowTexts(undefined)).toEqual([''])
    expect(rowTexts([])).toEqual([''])
  })

  it('sends each row trimmed, drops an empty one, and sends nothing for none', () => {
    expect(rowsValue([' a ', '', '  ', 'b'])).toEqual(['a', 'b'])
    expect(rowsValue(['', ' '])).toBeUndefined()
  })
})

describe('a paste into a row', () => {
  it('is left to the box when it is one line', () => {
    expect(pasteRows(['a'], 0, 'https://x', 0, 0)).toBeNull()
    expect(pasteRows(['a'], 0, 'https://x\n', 0, 0)).toBeNull()
  })

  it('makes a row a line, in place of what was selected, and goes to the last', () => {
    expect(pasteRows(['first', 'keep me', 'last'], 1, 'one\r\n\n two \nthree', 5, 7)).toEqual({ texts: ['first', 'keep one', 'two', 'three', 'last'], focus: 3 })
    expect(pasteRows([''], 0, 'a\nb', null, null)).toEqual({ texts: ['a', 'b'], focus: 1 })
  })
})

describe('what a row says', () => {
  it('says nothing of an empty row, and what its kind and rules say of the rest', () => {
    expect(rowProblem({ type: 'url', many: true }, ['', 'nope'], 0, today)).toBeNull()
    expect(rowProblem({ type: 'url', many: true }, ['', 'nope'], 1, today)).toBe('Expected a URL')
    expect(rowProblem({ type: 'number', many: true, max: 5 }, ['9'], 0, today)).toBe('Expected 5 or less')
    expect(rowProblem({ type: 'string', many: true, pattern: '[a-z]+', hint: 'Lower case only' }, ['ABC'], 0, today)).toBe('Lower case only')
  })

  it('names the earlier row that holds the same value, as its kind stores it', () => {
    expect(rowProblem({ type: 'email', many: true }, ['a@example.org', 'b@example.org', 'a@EXAMPLE.org'], 2, today)).toBe('Already in the list, in row 1')
    expect(rowProblem({ type: 'email', many: true }, ['a@example.org', 'a@example.org'], 0, today)).toBeNull()
  })
})

describe('where a list starts', () => {
  const scope = { entity: { fields: { origins: ['https://a', 'https://b'], none: [] } } }
  it('starts from what the entity holds, unless the input names a default', () => {
    expect(startList({ type: 'url', many: true, current: '{{ entity.fields.origins }}' }, scope)).toEqual(['https://a', 'https://b'])
    expect(startList({ type: 'url', many: true, current: '{{ entity.fields.origins }}', default: '{{ entity.fields.none }}' }, scope)).toBeUndefined()
    expect(startList({ type: 'url', many: true, current: '{{ entity.fields.none }}' }, scope)).toBeUndefined()
    expect(startList({ type: 'url', many: true }, scope)).toBeUndefined()
  })
})
