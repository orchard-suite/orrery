import { describe, expect, it } from 'vitest'
import { blueprintNamer, CHIP_TYPES, isSpread, mayChip, PERMISSION_FAMILIES, PERMISSION_IDS, retryWait, valueColor, type Blueprint } from './model.ts'

const bp = (id: string, title: string, group?: string): Pick<Blueprint, 'id' | 'title' | 'group'> => ({ id, title, ...(group ? { group } : {}) })

describe('the name a blueprint is shown by', () => {
  const visible = [bp('program_portfolio', 'Portfolio', 'Programs'), bp('art_portfolio', 'Portfolio', 'Art'), bp('finops_portfolio', 'portfolio ', 'Finance'), bp('team', 'Team', 'People')]
  const name = blueprintNamer(visible)

  it('is the title alone when no other blueprint the reader sees shares it', () => {
    expect(name(visible[3])).toBe('Team')
    expect(blueprintNamer([visible[0]!])(visible[0])).toBe('Portfolio')
  })

  it('carries the section beside a title that repeats, whatever its case and spacing', () => {
    expect(name(visible[0])).toBe('Portfolio · Programs')
    expect(name(visible[1])).toBe('Portfolio · Art')
    expect(name('finops_portfolio')).toBe('portfolio  · Finance')
  })

  it('falls back to the id when the section does not tell the two apart', () => {
    const same = blueprintNamer([bp('a_portfolio', 'Portfolio', 'Finance'), bp('b_portfolio', 'Portfolio', 'finance'), bp('c_portfolio', 'Portfolio')])
    expect(same('a_portfolio')).toBe('Portfolio · a_portfolio')
    expect(same('c_portfolio')).toBe('Portfolio · c_portfolio')
  })

  it('shows an id it does not hold as the id', () => {
    expect(name('gone')).toBe('gone')
    expect(name(undefined)).toBe('')
  })
})

describe('a value colour taken from its text', () => {
  it('never reads as a status', () => {
    const status = new Set(['red', 'orange', 'yellow', 'lime', 'green', 'brown'])
    for (const value of ['Synced', 'OutOfSync', 'Healthy', 'Go', 'TypeScript', 'backend', 'acme', 'platform']) expect(status.has(valueColor({ type: 'string' }, value))).toBe(false)
  })
})

describe('the wait between tries', () => {
  it('grows three times with each failed try, with up to a fifth more at random', () => {
    expect(retryWait(5000, 1, () => 0)).toBe(5000)
    expect(retryWait(5000, 2, () => 0)).toBe(15_000)
    expect(retryWait(5000, 3, () => 0)).toBe(45_000)
    expect(retryWait(5000, 1, () => 1)).toBe(6000)
  })
})

describe('the permission families', () => {
  it('hold every permission exactly once', () => {
    expect(PERMISSION_FAMILIES.flatMap((f) => f.permissions.map((p) => p.id)).sort()).toEqual([...PERMISSION_IDS].sort())
  })
})

describe('which fields may be chips', () => {
  it('lets text, an address, and a person be chips, and nothing that is always one or never one', () => {
    expect(CHIP_TYPES.filter(mayChip)).toEqual(['string', 'email', 'user'])
    for (const type of ['enum', 'boolean', 'array', 'number', 'datetime', 'url', 'markdown'] as const) expect(mayChip(type)).toBe(false)
  })

  it('counts a person field marked a chip under the grid', () => {
    expect(isSpread({ type: 'user', chip: true })).toBe(true)
    expect(isSpread({ type: 'user' })).toBe(false)
  })
})

describe('which fields are counted under a grid', () => {
  it('counts an enum, a boolean, a list, and a chip unless the field says otherwise', () => {
    expect(isSpread({ type: 'enum', values: ['a'] })).toBe(true)
    expect(isSpread({ type: 'boolean' })).toBe(true)
    expect(isSpread({ type: 'array' })).toBe(true)
    expect(isSpread({ type: 'string', chip: true })).toBe(true)
    expect(isSpread({ type: 'string' })).toBe(false)
  })

  it('keeps a chip without its count, counts plain text when asked, and never counts a kind it cannot', () => {
    expect(isSpread({ type: 'string', chip: true, spread: false })).toBe(false)
    expect(isSpread({ type: 'enum', values: ['a'], spread: false })).toBe(false)
    expect(isSpread({ type: 'string', spread: true })).toBe(true)
    expect(isSpread({ type: 'number', spread: true })).toBe(false)
  })
})
