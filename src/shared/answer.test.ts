import { describe, expect, it } from 'vitest'
import type { QueryColumn, QueryRow } from './api.ts'
import { cellMeets, columnFormat, columnKind, kindIn, keptRows, metaIn, pathColumn, pathEnd, shape, spread, viewProblem, type ColumnKind, type Readable } from './answer.ts'

const team: Readable = { id: 'team', fields: { name: { type: 'string' } }, relations: { department: { target: 'department', many: false } } }
const department: Readable = { id: 'department', fields: { cost: { type: 'number' } }, relations: {} }
const service: Readable = { id: 'service', fields: { alerts: { type: 'number' }, tags: { type: 'array' } }, relations: { team: { target: 'team', many: false } } }
const repo: Readable = { id: 'repo', fields: { alerts: { type: 'number' } }, relations: { team: { target: 'team', many: false } } }
const all = [team, department, service, repo]

const columns: QueryColumn[] = [
  { id: 'title', title: 'Title', from: { service: 'title', repo: 'title' } },
  { id: 'alerts', title: 'Alerts', from: { service: 'alerts', repo: 'alerts' } },
  { id: 'team', title: 'Team', from: { service: 'r:team', repo: 'r:team' } },
  { id: 'tags', title: 'Tags', from: { service: 'tags' } },
]
const kinds: ColumnKind[] = columns.map((c) => columnKind(c, all))
const row = (key: string, values: unknown[], blueprint = 'service'): QueryRow => ({ blueprint, key, values })
const rows: QueryRow[] = [
  row('a', ['api', 4, ['core'], ['web', 'edge']]),
  row('b', ['batch', null, ['core'], null]),
  row('c', ['cron', 9, null, ['edge']]),
  row('d', ['db', 1, ['data'], null], 'repo'),
]
const keys = (list: readonly QueryRow[]) => list.map((r) => r.key)

describe('a path column', () => {
  it('names a path, and a field at its end', () => {
    expect(pathColumn('r:team')).toEqual({ path: 'team', field: null })
    expect(pathColumn('r:team.department@cost')).toEqual({ path: 'team.department', field: 'cost' })
    expect(pathColumn('alerts')).toBeNull()
  })

  it('ends at the blueprint its hops reach, out and in', () => {
    expect(pathEnd(service, 'team.department', all)?.id).toBe('department')
    expect(pathEnd(team, '<-service:team', all)?.id).toBe('service')
    expect(pathEnd(team, '<-repo:team', all)?.id).toBe('repo')
    expect(pathEnd(service, 'nothing', all)).toBeUndefined()
    expect(pathEnd(department, '<-service:team', all)).toBeUndefined()
  })

  it('holds what its end holds', () => {
    expect(kindIn(service, 'r:team.department@cost', all)).toBe('number')
    expect(kindIn(service, 'r:team.department', all)).toBe('relation')
    expect(kindIn(service, 'r:team@$status', all)).toBe('enum')
    expect(kinds).toEqual(['string', 'number', 'relation', 'array'])
  })
})

describe('a condition on a column', () => {
  it('reads a list cell by any of its values, and none of them turned round', () => {
    expect(cellMeets(['web', 'edge'], { field: 'tags', op: 'eq', value: 'edge' }, 'array')).toBe(true)
    expect(cellMeets(['web', 'edge'], { field: 'tags', op: 'neq', value: 'edge' }, 'array')).toBe(false)
    expect(cellMeets(['web'], { field: 'tags', op: 'contains', value: 'web' }, 'array')).toBe(true)
    expect(cellMeets(['web'], { field: 'tags', op: 'eq', value: 'edge', not: true }, 'array')).toBe(true)
  })

  it('asks whether a cell holds anything', () => {
    expect(cellMeets(null, { field: 'x', op: 'exists', value: '' }, 'string')).toBe(false)
    expect(cellMeets([], { field: 'x', op: 'exists', value: '' }, 'array')).toBe(false)
    expect(cellMeets(null, { field: 'x', op: 'exists', value: '', not: true }, 'string')).toBe(true)
    expect(cellMeets(0, { field: 'x', op: 'exists', value: '' }, 'number')).toBe(true)
  })

  it('compares numbers as numbers and text as text', () => {
    expect(cellMeets(9, { field: 'alerts', op: 'gt', value: '4' }, 'number')).toBe(true)
    expect(cellMeets('10', { field: 'v', op: 'eq', value: '10' }, 'string')).toBe(true)
  })

  it('keeps the rows meeting every condition, across sources, and passes over a column the answer lacks', () => {
    expect(keys(keptRows(rows, { where: [{ field: 'alerts', op: 'gte', value: '1' }] }, columns, kinds))).toEqual(['a', 'c', 'd'])
    expect(keys(keptRows(rows, { where: [{ field: 'team', op: 'eq', value: 'core' }, { field: 'alerts', op: 'exists', value: '', not: true }] }, columns, kinds))).toEqual(['b'])
    expect(keys(keptRows(rows, { where: [{ field: 'gone', op: 'eq', value: 'x' }] }, columns, kinds))).toEqual(['a', 'b', 'c', 'd'])
  })
})

describe('a view sent to be judged', () => {
  it('is refused where it names no column, or orders a time or a number against what is neither', () => {
    const when: QueryColumn[] = [...columns, { id: 'decided', title: 'Decided', from: { service: '$updatedAt' } }]
    const at = when.map((c) => columnKind(c, all))
    expect(viewProblem({ where: [{ field: 'alerts', op: 'gte', value: '3' }], sort: [{ column: 'title' }] }, when, at)).toBeNull()
    expect(viewProblem({ where: [{ field: 'decided', op: 'gte', value: '2026-11-16T06:00:00.000Z' }] }, when, at)).toBeNull()
    expect(viewProblem({ where: [{ field: 'decided', op: 'gte', value: '@yesterday' }] }, when, at)).toMatch(/no time/)
    expect(viewProblem({ where: [{ field: 'alerts', op: 'lt', value: 'many' }] }, when, at)).toMatch(/no number/)
    expect(viewProblem({ where: [{ field: 'owner', op: 'eq', value: 'x' }] }, when, at)).toMatch(/"owner", which is not a column/)
    expect(viewProblem({ group: ['nope'] }, when, at)).toMatch(/"nope"/)
  })
})

describe('the order', () => {
  it('puts an empty cell last, either way round, and keeps ties as they came', () => {
    expect(keys(keptRows(rows, { sort: [{ column: 'alerts' }] }, columns, kinds))).toEqual(['d', 'a', 'c', 'b'])
    expect(keys(keptRows(rows, { sort: [{ column: 'alerts', desc: true }] }, columns, kinds))).toEqual(['c', 'a', 'd', 'b'])
    expect(keys(keptRows(rows, { sort: [{ column: 'team' }, { column: 'title', desc: true }] }, columns, kinds))).toEqual(['b', 'a', 'd', 'c'])
  })
})

describe('groups', () => {
  it('nest two deep, add up each, and put the group with no value last', () => {
    const out = shape(rows, { group: ['team', 'title'], totals: { alerts: 'sum', title: 'count' } }, columns, kinds)
    expect(out.groups!.map((g) => [g.path, g.count, g.totals])).toEqual([
      [['"core"'], 2, { alerts: 4, title: 2 }],
      [['"data"'], 1, { alerts: 1, title: 1 }],
      [[null], 1, { alerts: 9, title: 1 }],
    ])
    expect(out.groups![0]!.groups!.map((g) => [g.path, g.count])).toEqual([
      [['"core"', '"api"'], 1],
      [['"core"', '"batch"'], 1],
    ])
    expect(out.totals).toEqual({ alerts: 14, title: 4 })
  })

  it('follow the column’s own order when the view sorts by it', () => {
    const out = shape(rows, { group: ['team'], sort: [{ column: 'team', desc: true }] }, columns, kinds)
    expect(out.groups!.map((g) => g.path[0])).toEqual(['"data"', '"core"', null])
  })

  it('follow what each adds up to on another column the view sorts by, its rows in that order inside', () => {
    const more = [...rows, row('e', ['edge', 2, ['data'], null]), row('f', ['feed', 3, ['data'], null])]
    const out = shape(more, { group: ['team'], sort: [{ column: 'alerts', desc: true }], totals: { alerts: 'sum' } }, columns, kinds)
    expect(out.groups!.map((g) => [g.path[0], g.totals.alerts])).toEqual([['"data"', 6], ['"core"', 4], [null, 9]])
    expect(keys(out.groups![0]!.rows)).toEqual(['f', 'e', 'd'])
    const up = shape(more, { group: ['team'], sort: [{ column: 'alerts' }], totals: { alerts: 'sum' } }, columns, kinds)
    expect(up.groups!.map((g) => g.path[0])).toEqual(['"core"', '"data"', null])
  })

  it('follow their leading row on a sorted column the view adds nothing up on', () => {
    const more = [...rows, row('e', ['edge', 2, ['data'], null]), row('f', ['feed', 3, ['data'], null])]
    const out = shape(more, { group: ['team'], sort: [{ column: 'alerts', desc: true }] }, columns, kinds)
    expect(out.groups!.map((g) => g.path[0])).toEqual(['"core"', '"data"', null])
    const up = shape(more, { group: ['team'], sort: [{ column: 'alerts' }] }, columns, kinds)
    expect(up.groups!.map((g) => g.path[0])).toEqual(['"data"', '"core"', null])
  })
})

describe('a spread', () => {
  it('counts each value once a row, the rows with none apart, the most common first and none after its equals', () => {
    const s = spread(rows, 3, 'array')
    expect(s.buckets.map((b) => [b.label, b.count])).toEqual([
      ['edge', 2],
      ['No value', 2],
      ['web', 1],
    ])
    expect(spread(rows, 3, 'array', 1).other).toBe(3)
  })

  it('lays numbers on a range', () => {
    const s = spread(rows, 1, 'number')
    expect(s.range).toMatchObject({ min: 1, max: 9 })
    expect(s.range!.bins.reduce((a, b) => a + b, 0)).toBe(3)
    expect(s.range!.bins[0]).toBe(1)
    expect(s.range!.bins.at(-1)).toBe(1)
    expect(spread(rows, 0, 'string').range).toBeNull()
  })
})

describe('a column shown as money', () => {
  const usd = { kind: 'currency', currency: 'USD', minor: true } as const
  const eur = { kind: 'currency', currency: 'EUR', minor: true } as const
  const app: Readable = { id: 'app', fields: { cost: { type: 'number', format: usd }, plain: { type: 'number' } }, relations: { team: { target: 'budget', many: false } } }
  const db: Readable = { id: 'db', fields: { cents: { type: 'number', format: usd }, euros: { type: 'number', format: eur } }, relations: {} }
  const budget: Readable = { id: 'budget', fields: { spend: { type: 'number', format: usd } }, relations: {} }
  const blueprints = [app, db, budget]

  it('is shown as money when every blueprint that fills it shows its field the same way, whatever the field is called', () => {
    expect(columnFormat({ from: { app: 'cost', db: 'cents' } }, blueprints)).toEqual(usd)
  })

  it('is not, when one blueprint fills it with a plain number or another currency', () => {
    expect(columnFormat({ from: { app: 'plain', db: 'cents' } }, blueprints)).toBeUndefined()
    expect(columnFormat({ from: { app: 'cost', db: 'euros' } }, blueprints)).toBeUndefined()
    expect(columnFormat({ from: { app: 'title' } }, blueprints)).toBeUndefined()
  })

  it('reads the field at the end of a path', () => {
    expect(columnFormat({ from: { app: 'r:team@spend' } }, blueprints)).toEqual(usd)
    expect(columnFormat({ from: { app: 'r:team' } }, blueprints)).toBeUndefined()
  })
})

describe('a column every entity has', () => {
  const issue: Readable = { id: 'issue', fields: { state: { type: 'enum', values: ['open', 'closed'] } }, relations: {} }

  it('answers to its $ name whatever the blueprint defines', () => {
    expect(metaIn(issue, '$state')?.title).toBe('State')
    expect(kindIn(issue, '$updatedAt', [issue])).toBe('datetime')
  })

  it('gives way to a field of its bare name, and answers to that name where no field has it', () => {
    expect(metaIn(issue, 'state')).toBeUndefined()
    expect(metaIn(team, 'state')?.id).toBe('$state')
    expect(metaIn(team, 'status')).toBeUndefined()
  })
})
