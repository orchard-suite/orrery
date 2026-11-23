import { describe, expect, it } from 'vitest'
import { clauseFilter, clausesOf, fieldRenamed, filterOf, opposite, parseValue, sameClause, shareClause, typesIn, typesOf, withShare } from './clauses.ts'

describe('what was typed as the value of a condition', () => {
  it('is a number or a boolean when it looks like one, and the text otherwise', () => {
    expect(parseValue('5')).toBe(5)
    expect(parseValue(' 2.5 ')).toBe(2.5)
    expect(parseValue('true')).toBe(true)
    expect(parseValue('false')).toBe(false)
    expect(parseValue('prod')).toBe('prod')
    expect(parseValue('')).toBe('')
  })
})

describe('the conditions a filter holds', () => {
  it('is none for no filter', () => {
    expect(clausesOf(undefined)).toEqual([])
  })

  it('is one for a test, and one each for tests joined with and', () => {
    expect(clausesOf({ field: 'env', op: 'eq', value: 'prod' })).toEqual([{ field: 'env', op: 'eq', value: 'prod' }])
    expect(clausesOf({ and: [{ field: 'env', op: 'neq', value: 'dev' }, { field: 'count', op: 'gt', value: 2 }, { field: 'urgent', op: 'eq', value: true }, { field: 'note', op: 'exists' }] })).toEqual([
      { field: 'env', op: 'neq', value: 'dev' },
      { field: 'count', op: 'gt', value: '2' },
      { field: 'urgent', op: 'eq', value: 'true' },
      { field: 'note', op: 'exists', value: '' },
    ])
  })

  it('is not drawn for a filter the conditions cannot hold', () => {
    expect(clausesOf({ or: [{ field: 'env', op: 'eq', value: 'prod' }] })).toBeNull()
    expect(clausesOf({ not: { field: 'env', op: 'neq', value: 'prod' } })).toBeNull()
    expect(clausesOf({ and: [{ and: [{ field: 'env', op: 'eq', value: 'prod' }] }] })).toBeNull()
    expect(clausesOf({ field: 'env', op: 'in', value: ['dev', 'prod'] })).toBeNull()
    expect(clausesOf({ state: 'active' })).toBeNull()
    expect(clausesOf('env')).toBeNull()
    // A text that reads as a number would come back a number, so it stays as it was written.
    expect(clausesOf({ field: 'code', op: 'eq', value: '007' })).toBeNull()
  })
})

describe('a condition turned round', () => {
  it('leaves out what the test matches, and reads back as itself', () => {
    const clauses = [{ field: 'tags', op: 'contains', value: 'edge', not: true }, { field: 'note', op: 'exists', value: '', not: true }] as const
    expect(filterOf([...clauses])).toEqual({ and: [{ not: { field: 'tags', op: 'contains', value: 'edge' } }, { not: { field: 'note', op: 'exists' } }] })
    expect(clausesOf(filterOf([...clauses]))).toEqual(clauses)
  })

  it('reads a not over eq as neq', () => {
    expect(clausesOf({ not: { field: 'env', op: 'eq', value: 'prod' } })).toEqual([{ field: 'env', op: 'neq', value: 'prod' }])
  })

  it('turns round a relation that is set as one that is not', () => {
    expect(clauseFilter({ field: 'r:team', op: 'exists', value: '', not: true })).toEqual({ not: { relation: 'team' } })
  })
})

describe('the value a condition compares with', () => {
  const typeOf = typesOf({ code: { type: 'enum' }, size: { type: 'number' }, live: { type: 'boolean' } })

  it('stays text where the field holds text, however it looks', () => {
    expect(clauseFilter({ field: 'code', op: 'eq', value: '10' }, typeOf)).toEqual({ field: 'code', op: 'eq', value: '10' })
    expect(clauseFilter({ field: '$state', op: 'eq', value: 'true' }, typeOf)).toEqual({ field: '$state', op: 'eq', value: 'true' })
  })

  it('is a number or a boolean where the field holds one, or where nothing says', () => {
    expect(clauseFilter({ field: 'size', op: 'gt', value: '10' }, typeOf)).toEqual({ field: 'size', op: 'gt', value: 10 })
    expect(clauseFilter({ field: 'live', op: 'eq', value: 'true' }, typeOf)).toEqual({ field: 'live', op: 'eq', value: true })
    expect(clauseFilter({ field: 'unknown', op: 'eq', value: '3' }, typeOf)).toEqual({ field: 'unknown', op: 'eq', value: 3 })
  })
})

describe('the condition a share of a column stands for', () => {
  it('keeps the rows holding the value, or with not, the rest', () => {
    expect(shareClause('f:connection', 'enum', 'online', false)).toEqual({ field: 'connection', op: 'eq', value: 'online' })
    expect(shareClause('f:connection', 'enum', 'online', true)).toEqual({ field: 'connection', op: 'neq', value: 'online' })
  })

  it('asks a list whether it contains the value', () => {
    expect(shareClause('f:tags', 'array', 'edge', false)).toEqual({ field: 'tags', op: 'contains', value: 'edge' })
    expect(shareClause('f:tags', 'array', 'edge', true)).toEqual({ field: 'tags', op: 'contains', value: 'edge', not: true })
  })

  it('asks after the rows with no value whether the column is set', () => {
    expect(shareClause('f:os', 'enum', null, false)).toEqual({ field: 'os', op: 'exists', value: '', not: true })
    expect(shareClause('f:os', 'enum', null, true)).toEqual({ field: 'os', op: 'exists', value: '' })
  })

  it('names what the hub keeps under a $, and a relation as its column', () => {
    expect(shareClause('state', undefined, 'missing', false)).toEqual({ field: '$state', op: 'eq', value: 'missing' })
    expect(shareClause('r:program', undefined, 'program:smc', false)).toEqual({ field: 'r:program', op: 'eq', value: 'program:smc' })
    expect(shareClause('title', undefined, 'x', false)).toBeNull()
  })
})

describe('the conditions after a share is picked', () => {
  const online = { field: 'connection', op: 'eq', value: 'online' } as const

  it('adds it, and takes it away when picked again', () => {
    expect(withShare([], online)).toEqual([online])
    expect(withShare([online], online)).toEqual([])
  })

  it('replaces its opposite', () => {
    expect(withShare([{ field: 'connection', op: 'neq', value: 'online' }], online)).toEqual([online])
  })

  it('replaces another value a field holding one must equal, and keeps the rest', () => {
    const env = { field: 'env', op: 'eq', value: 'prod' } as const
    expect(withShare([env, { field: 'connection', op: 'eq', value: 'offline' }], online)).toEqual([env, online])
  })

  it('keeps every value left out, and every target a relation must point at', () => {
    const notOffline = { field: 'connection', op: 'neq', value: 'offline' } as const
    expect(withShare([notOffline], { field: 'connection', op: 'neq', value: 'idle' })).toEqual([notOffline, { field: 'connection', op: 'neq', value: 'idle' }])
    const smc = { field: 'r:program', op: 'eq', value: 'program:smc' } as const
    expect(withShare([smc], { field: 'r:program', op: 'eq', value: 'program:tv' })).toEqual([smc, { field: 'r:program', op: 'eq', value: 'program:tv' }])
  })
})

describe('the filter conditions stand for', () => {
  it('is nothing for none, the test for one, and all of them for more', () => {
    expect(filterOf([])).toBeUndefined()
    expect(filterOf([{ field: 'env', op: 'eq', value: 'prod' }])).toEqual({ field: 'env', op: 'eq', value: 'prod' })
    expect(filterOf([{ field: 'count', op: 'gt', value: '2' }, { field: 'note', op: 'exists', value: 'left over' }])).toEqual({ and: [{ field: 'count', op: 'gt', value: 2 }, { field: 'note', op: 'exists' }] })
  })

  it('read a list to be among as its items, text kept as text, and a value not written as a list as a list of one', () => {
    const types = typesOf({ connection: { type: 'enum' }, count: { type: 'number' } })
    expect(filterOf([{ field: 'connection', op: 'in', value: '["offline","never_connected"]' }], types)).toEqual({ field: 'connection', op: 'in', value: ['offline', 'never_connected'] })
    expect(filterOf([{ field: 'connection', op: 'in', value: '007' }], types)).toEqual({ field: 'connection', op: 'in', value: ['007'] })
    expect(filterOf([{ field: 'count', op: 'in', value: '[1,2]' }], types)).toEqual({ field: 'count', op: 'in', value: [1, 2] })
    expect(filterOf([{ field: 'count', op: 'in', value: '3' }], types)).toEqual({ field: 'count', op: 'in', value: [3] })
  })

  it('reads back as the conditions it was made from', () => {
    const clauses = [{ field: 'env', op: 'eq', value: 'prod' }, { field: 'urgent', op: 'eq', value: 'true' }, { field: 'note', op: 'exists', value: '' }] as const
    expect(clausesOf(filterOf([...clauses]))).toEqual(clauses)
  })
})

describe('a filter after a field it tests is renamed', () => {
  it('tests the new name wherever it tested the old one, at any depth', () => {
    expect(fieldRenamed({ and: [{ field: 'env', op: 'eq', value: 'prod' }, { or: [{ not: { field: 'env', op: 'exists' } }, { field: 'size', op: 'gt', value: 2 }] }] }, 'env', 'stage')).toEqual({ and: [{ field: 'stage', op: 'eq', value: 'prod' }, { or: [{ not: { field: 'stage', op: 'exists' } }, { field: 'size', op: 'gt', value: 2 }] }] })
  })

  it('is left as it was when it does not test the field', () => {
    const filter = { field: 'size', op: 'gt', value: 2 }
    expect(fieldRenamed(filter, 'env', 'stage')).toBe(filter)
    expect(fieldRenamed('not a filter', 'env', 'stage')).toBe('not a filter')
  })
})

describe('a condition on what a relation reaches', () => {
  const where = [{ field: 'days', op: 'gt' as const, value: '90' }]
  it('stands for a relation leaf with a where, read with the reached blueprint\'s types', () => {
    const typeOf = typesIn({ fields: {}, relations: { repo: { target: 'repo', many: true } } }, (id) => (id === 'repo' ? { id, fields: { days: { type: 'number' }, name: { type: 'string' } }, relations: {} } : undefined))
    expect(clauseFilter({ field: 'r:repo', op: 'exists', value: '', match: 'any', where: [...where, { field: 'name', op: 'eq', value: '10' }] }, typeOf)).toEqual({
      relation: 'repo',
      where: { and: [{ field: 'days', op: 'gt', value: 90 }, { field: 'name', op: 'eq', value: '10' }] },
    })
  })

  it('asks every one for all, and turns the leaf round for none', () => {
    expect(clauseFilter({ field: 'r:repo', op: 'exists', value: '', match: 'all', where })).toEqual({ relation: 'repo', where: { field: 'days', op: 'gt', value: 90 }, every: true })
    expect(clauseFilter({ field: 'r:repo', op: 'exists', value: '', match: 'none', where })).toEqual({ not: { relation: 'repo', where: { field: 'days', op: 'gt', value: 90 } } })
    expect(clauseFilter({ field: 'r:repo', op: 'exists', value: '', match: 'none', where: [] })).toEqual({ not: { relation: 'repo', where: { and: [] } } })
  })

  it('comes back as the condition it was made from', () => {
    for (const c of [
      { field: 'r:repo', op: 'exists' as const, value: '', match: 'any' as const, where },
      { field: 'r:repo', op: 'exists' as const, value: '', match: 'all' as const, where },
      { field: 'r:repo', op: 'exists' as const, value: '', match: 'none' as const, where },
      { field: 'r:repo', op: 'exists' as const, value: '', match: 'all' as const, where, not: true },
      { field: 'r:<-sw_service:repository', op: 'exists' as const, value: '', match: 'any' as const, where: [{ field: 'r:team', op: 'exists' as const, value: '', match: 'none' as const, where: [] }] },
    ]) {
      expect(clausesOf(clauseFilter(c))).toEqual([c])
    }
  })

  it('turns round between any and none, and turns all round', () => {
    const any = { field: 'r:repo', op: 'exists' as const, value: '', match: 'any' as const, where }
    expect(opposite(any)).toEqual({ ...any, match: 'none' })
    expect(opposite({ ...any, match: 'all' })).toEqual({ ...any, match: 'all', not: true })
  })

  it('is the same condition only with the same match and where', () => {
    const any = { field: 'r:repo', op: 'exists' as const, value: '', match: 'any' as const, where }
    expect(sameClause(any, { ...any })).toBe(true)
    expect(sameClause(any, { ...any, match: 'none' })).toBe(false)
    expect(sameClause(any, { ...any, where: [] })).toBe(false)
  })

  it('gives back the conditions on a relation a filter holds', () => {
    expect(clausesOf({ relation: 'team' })).toEqual([{ field: 'r:team', op: 'exists', value: '' }])
    expect(clausesOf({ not: { relation: 'team', target: 'team:a' } })).toEqual([{ field: 'r:team', op: 'neq', value: 'team:a' }])
  })
})
