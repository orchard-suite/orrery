import { describe, expect, it } from 'vitest'
import { draftSections, placed, renamedIn, sectionOfInput, sectionShifted, shifted, without } from './builder.ts'

const sections = () => [
  { title: 'First', description: 'Start here', inputs: ['a', 'b'] },
  { title: 'Second', inputs: ['c'] },
]

describe("an action's sections, as its builder reads them", () => {
  it('reads what the definition holds, and nothing for a definition with none', () => {
    expect(draftSections(sections())).toEqual(sections())
    expect(draftSections(undefined)).toEqual([])
    expect(draftSections('First')).toEqual([])
  })

  it('reads a section written badly as one with what it has, so it can be put right', () => {
    expect(draftSections([{ title: 'First' }, 'Second', { title: 'Third', inputs: 'a' }])).toEqual([{ title: 'First', inputs: [] }, { inputs: [] }, { title: 'Third', inputs: [] }])
  })

  it('says which section holds an input', () => {
    expect(sectionOfInput(sections(), 'c')).toBe(1)
    expect(sectionOfInput(sections(), 'd')).toBeNull()
  })
})

describe('moving an input between sections', () => {
  it('puts it last in the section it moves to, and takes it out of the one it was in', () => {
    expect(placed(sections(), 'a', 1)).toEqual([{ title: 'First', description: 'Start here', inputs: ['b'] }, { title: 'Second', inputs: ['c', 'a'] }])
    expect(placed(sections(), 'd', 0)[0]!.inputs).toEqual(['a', 'b', 'd'])
  })

  it('takes it out of every section when it moves to none', () => {
    expect(placed(sections(), 'c', null)).toEqual([{ title: 'First', description: 'Start here', inputs: ['a', 'b'] }, { title: 'Second', inputs: [] }])
  })

  it('moves it up or down inside its section, and no further than its ends', () => {
    expect(shifted(sections(), 0, 'a', 1)![0]!.inputs).toEqual(['b', 'a'])
    expect(shifted(sections(), 0, 'b', -1)![0]!.inputs).toEqual(['b', 'a'])
    expect(shifted(sections(), 0, 'a', -1)).toBeNull()
    expect(shifted(sections(), 0, 'b', 1)).toBeNull()
    expect(shifted(sections(), 1, 'a', 1)).toBeNull()
  })
})

describe('moving a section', () => {
  it('moves it up or down, and no further than the ends', () => {
    expect(sectionShifted(sections(), 0, 1)!.map((s) => s.title)).toEqual(['Second', 'First'])
    expect(sectionShifted(sections(), 1, -1)!.map((s) => s.title)).toEqual(['Second', 'First'])
    expect(sectionShifted(sections(), 0, -1)).toBeNull()
    expect(sectionShifted(sections(), 1, 1)).toBeNull()
  })
})

describe('an input renamed or removed', () => {
  it('keeps its place in its section under its new name', () => {
    expect(renamedIn(sections(), 'a', 'first')[0]!.inputs).toEqual(['first', 'b'])
  })

  it('leaves its section when it is removed', () => {
    expect(without(sections(), 'c')).toEqual([{ title: 'First', description: 'Start here', inputs: ['a', 'b'] }, { title: 'Second', inputs: [] }])
  })
})
