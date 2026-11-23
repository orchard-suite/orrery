import { describe, expect, it } from 'vitest'
import { addWords, allOpened, anyOpened, fillWords, opened, openedColumns, putBack } from './editable.ts'

describe('what an edit rule opens to the reader', () => {
  const mine = { editable: { fields: ['description', 'icon'], relations: ['depends_on'] } }

  it('reads a field and a relation apart', () => {
    expect(opened(mine, 'field', 'description')).toBe(true)
    expect(opened(mine, 'relation', 'description')).toBe(false)
    expect(opened(mine, 'relation', 'depends_on')).toBe(true)
    expect(opened({}, 'field', 'description')).toBe(false)
  })

  it('says whether anything is opened', () => {
    expect(anyOpened(mine)).toBe(true)
    expect(anyOpened({})).toBe(false)
    expect(anyOpened({ editable: { fields: [], relations: [] } })).toBe(false)
  })

  it('names the columns opened on any row', () => {
    expect([...openedColumns([mine, {}, { editable: { fields: ['notes'], relations: [] } }])].sort()).toEqual(['f:description', 'f:icon', 'f:notes', 'r:depends_on'])
  })

  it('says what an empty value is waiting for', () => {
    expect(addWords('Description')).toBe('Add a description')
    expect(addWords('Owner')).toBe('Add an owner')
    expect(addWords('Notes')).toBe('Add notes')
    expect(addWords('')).toBe('Add a value')
  })

  it('says how many of their own things wait for a value', () => {
    expect(fillWords(31, 'Description')).toBe('31 have no description')
    expect(fillWords(1, 'Runbook')).toBe('1 has no runbook')
  })

  it('builds the patch that puts a hand edit back', () => {
    expect(putBack({ fields: ['description'], was: { description: null }, wasRelations: { depends_on: ['service:api'], owner: [] } })).toEqual({ fields: { description: null }, relations: { depends_on: ['service:api'], owner: null } })
    expect(putBack({ fields: ['description'], was: { description: 'Old' } })).toEqual({ fields: { description: 'Old' } })
    expect(putBack({ fields: ['description'] })).toBeNull()
    expect(putBack({ was: {}, wasRelations: {} })).toBeNull()
  })

  it('says whether a whole patch is theirs to make', () => {
    expect(allOpened(mine, { fields: { description: 'x' }, relations: { depends_on: null } })).toBe(true)
    expect(allOpened(mine, { fields: { description: 'x', notes: 'y' } })).toBe(false)
  })
})
