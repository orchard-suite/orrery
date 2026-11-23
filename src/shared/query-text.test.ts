import { describe, expect, it } from 'vitest'
import { QUERY_TOTALS, RUNS_SOURCE, type QuerySpec } from './api.ts'
import { normalizeQuery, parseQuery, printQuery, readQuery, type Names, type QueryExpected } from './query-text.ts'

const names: Names = {
  blueprints: [
    { id: 'sw_repository', title: 'Repository' },
    { id: 'sw_service', title: 'Service' },
    { id: 'sw_container_image', title: 'Container image' },
    // Two blueprints share a title: each is named by its id.
    { id: 'k8s_service', title: 'Workload' },
    { id: 'az_service', title: 'workload' },
    { id: 'team', title: 'Team' },
  ],
}

const rich: QuerySpec = {
  sources: [
    {
      blueprint: 'sw_repository',
      clauses: [
        { field: '$status', op: 'neq', value: 'green' },
        { field: 'days_idle', op: 'gt', value: '90' },
        { field: 'description', op: 'contains', value: 'demo "x"\n\\', not: true },
        { field: 'r:team', op: 'exists', value: '', match: 'none', where: [{ field: 'name', op: 'eq', value: 'Platform' }, { field: 'r:department', op: 'exists', value: '', match: 'all', where: [{ field: 'cost', op: 'gte', value: '1.50' }] }] },
        { field: 'last_push', op: 'within', value: '30d' },
        { field: 'stars', op: 'lte', value: '-5' },
        { field: 'name', op: 'prefix', value: 'az-' },
        { field: 'pipelines', op: 'lt', value: '3' },
        { field: 'size', op: 'gte', value: '10' },
        { field: 'created', op: 'older', value: '2y' },
        { field: 'archived', op: 'eq', value: 'false' },
        { field: 'r:program', op: 'exists', value: '' },
        { field: 'r:domains', op: 'exists', value: '', not: true },
        { field: 'language', op: 'in', value: '["Go","C#",3,true,null]' },
        { field: 'odd', op: 'in', value: 'Go, C#' },
        { field: 'count', op: 'eq', value: '007' },
        { field: 'r:team', op: 'exists', value: '', match: 'any', where: [], not: true },
      ],
      states: ['active', 'missing', 'deleted'],
      hidden: true,
    },
    { blueprint: 'sw_service', clauses: [], search: 'beacon "admin"' },
    { blueprint: 'k8s_service', clauses: [], states: [] },
    { blueprint: 'sw_container_image', clauses: [{ field: 'odd field', op: 'eq', value: 'x' }, { field: 'from', op: 'eq', value: 'a`b\\c' }] },
    { blueprint: RUNS_SOURCE, clauses: [{ field: 'run:state', op: 'eq', value: 'failed' }] },
  ],
  columns: [
    '$type',
    'title',
    'r:team.department@name',
    'r:<-sw_service:repository',
    { id: '$status', title: 'Status', from: { sw_repository: '$status', sw_service: '$status', k8s_service: '$status', sw_container_image: '$status', [RUNS_SOURCE]: '$status' } },
    { id: 'owner', title: 'Owner "of it"', from: { sw_repository: 'r:team', sw_service: 'r:team' } },
    { id: 'empty', title: 'Nothing', from: {} },
    'run:seconds',
  ],
  view: {
    where: [{ field: 'language', op: 'in', value: '["Go","C#"]' }, { field: 'owner', op: 'exists', value: '', not: true }],
    sort: [{ column: 'days_idle', desc: true }, { column: 'title' }],
    group: ['language', 'owner'],
    totals: { open_alerts: 'sum', days_idle: 'avg', title: 'count' },
    widths: { title: 320, language: 120 },
  },
}

const read = (text: string): QuerySpec => {
  const r = parseQuery(text, names)
  if ('error' in r) throw new Error(`${r.error.line}:${r.error.column} ${r.error.message}`)
  return r.spec
}

const error = (text: string) => {
  const r = parseQuery(text, names)
  if (!('error' in r)) throw new Error('read without an error')
  return r.error
}

describe('printQuery and parseQuery', () => {
  it('read back every part of a rich query as it was', () => {
    expect(read(printQuery(rich, names))).toEqual(rich)
  })

  it('print a query a person can read', () => {
    const text = printQuery(rich, names)
    expect(text).toContain('from Repository\n  | where $status != "green" and days_idle > 90 and not description contains "demo \\"x\\"\\n\\\\"')
    expect(text).toContain('  | where r:team none (name == "Platform" and r:department all (cost >= 1.50))')
    expect(text).toContain('language in ("Go", "C#", 3, true, null)')
    expect(text).toContain('odd in "Go, C#"')
    expect(text).toContain('count == 007')
    expect(text).toContain('last_push within 30d')
    expect(text).toContain('name startswith "az-"')
    expect(text).toContain('has r:program')
    expect(text).toContain('not has r:domains')
    expect(text).toContain('from k8s_service\n  | states ()')
    expect(text).toContain('from "Container image"\n  | where `odd field` == "x" and `from` == "a`b\\\\c"')
    expect(text).toContain('from "Action runs"')
    expect(text).toContain('$status as "Status"')
    expect(text).toContain('col owner as "Owner \\"of it\\"" from (Repository = r:team, Service = r:team)')
    expect(text).toContain('r:<-sw_service:repository')
    expect(text).toContain('sort by days_idle desc, title\ngroup by language, owner\ntotal open_alerts sum, days_idle avg, title count\nwidths title 320, language 120')
  })

  it('read a blueprint by its title in any case, or by its id, and the runs as $runs', () => {
    const spec = read('from repository\nfrom sw_service\nfrom $runs\nfrom "action runs"\nfrom az_service')
    expect(spec.sources.map((s) => s.blueprint)).toEqual(['sw_repository', 'sw_service', RUNS_SOURCE, RUNS_SOURCE, 'az_service'])
  })

  it('read several where lines of a source and of the view as one list each, in order, and asc as the default order', () => {
    const spec = read('from Repository | where a == 1 | where b == 2 and c == "x"\nwhere d == 1\nwhere e == 2\nsort by a asc')
    expect(spec.sources[0]!.clauses.map((c) => c.field)).toEqual(['a', 'b', 'c'])
    expect(spec.view).toEqual({ where: [{ field: 'd', op: 'eq', value: '1' }, { field: 'e', op: 'eq', value: '2' }], sort: [{ column: 'a' }] })
  })

  it('read and print a chart: how long a bar is, what each bar is, and what splits it', () => {
    const view = (text: string) => read(`from Repository\n${text}`).view
    expect(view('chart sum open_alerts by language split by $type')).toEqual({ chart: { total: 'sum', column: 'open_alerts', by: 'language', split: '$type' } })
    expect(view('chart count by language split none')).toEqual({ chart: { total: 'count', by: 'language', split: null } })
    expect(view('chart by language')).toEqual({ chart: { by: 'language' } })
    for (const chart of [{ total: 'max', column: 'days_idle', split: null }, { by: 'team', split: 'language' }] as const) {
      const q: QuerySpec = { sources: [{ blueprint: 'sw_repository', clauses: [] }], columns: [], view: { chart } }
      expect(read(printQuery(q, names))).toEqual(q)
    }
    expect(error('from Repository\nchart filled title')).toMatchObject({ line: 2, column: 7 })
  })

  it('skip comments', () => {
    expect(read('// every repository\nfrom Repository // the forge\n')).toEqual({ sources: [{ blueprint: 'sw_repository', clauses: [] }], columns: [] })
  })

  it('read nothing as a query of nothing, and print one as nothing', () => {
    expect(read('')).toEqual({ sources: [], columns: [] })
    expect(printQuery({ sources: [], columns: [] }, names)).toBe('')
  })

  it('normalize what the text cannot say twice', () => {
    expect(
      normalizeQuery({
        sources: [{ blueprint: 'team', clauses: [{ field: '', op: 'eq', value: 'x' }, { field: 'a', op: 'exists', value: 'left', not: false }, { field: 'r:b', op: 'eq', value: 'x', where: [] }, { field: 'r:c', op: 'eq', value: 'x', match: 'all' }], hidden: false }],
        columns: [],
        view: { where: [], sort: [{ column: 'a', desc: false }], group: [], totals: {}, widths: {} },
      }),
    ).toEqual({
      sources: [{ blueprint: 'team', clauses: [{ field: 'a', op: 'exists', value: '' }, { field: 'r:b', op: 'exists', value: '', where: [], match: 'any' }, { field: 'r:c', op: 'exists', value: '', where: [], match: 'all' }] }],
      columns: [],
      view: { sort: [{ column: 'a' }] },
    })
  })

  it('name a blueprint by its id where its title is shared or unknown', () => {
    const text = printQuery({ sources: [{ blueprint: 'k8s_service', clauses: [] }, { blueprint: 'gone', clauses: [] }], columns: [] }, names)
    expect(text).toBe('from k8s_service\nfrom gone\n')
  })
})

describe('parseQuery errors', () => {
  it('name an unknown blueprint where it stands', () => {
    expect(error('from Repository\nfrom Nope')).toEqual({ message: 'There is no blueprint "Nope"', line: 2, column: 6, at: 21 })
  })

  it('name a title two blueprints share', () => {
    expect(error('from Workload')).toMatchObject({ message: expect.stringContaining('k8s_service, az_service'), line: 1, column: 6 })
  })

  it('say what was expected after a field', () => {
    expect(error('from Repository\n  | where days_idle ~ 3')).toMatchObject({ message: expect.stringMatching(/^Expected a test: ==/), line: 2, column: 21 })
  })

  it('say what was expected after a bar', () => {
    expect(error('from Repository | sort title')).toMatchObject({ message: 'Expected where, search, states, or hidden after "|", found "sort"', line: 1, column: 19 })
  })

  it('find a text that never ends', () => {
    expect(error('from Repository | where a == "open')).toMatchObject({ message: expect.stringContaining('never ends'), line: 1, column: 30 })
  })

  it('find an escape that is not one', () => {
    expect(error('from Repository | search "a\\qb"')).toMatchObject({ message: expect.stringContaining('escape'), line: 1, column: 26 })
  })

  it('find a backtick name that never ends', () => {
    expect(error('columns `odd')).toMatchObject({ message: expect.stringContaining('backticks'), line: 1, column: 9 })
  })

  it('refuse a state that is not one', () => {
    expect(error('from Repository | states active, gone')).toMatchObject({ message: 'Expected a state: active, missing, deleted, found "gone"', line: 1, column: 34 })
  })

  it('refuse a total that is not one', () => {
    expect(error('total a median')).toMatchObject({ message: expect.stringContaining('how it adds up: count, filled'), line: 1, column: 9 })
  })

  it('refuse a width that is not a whole number', () => {
    expect(error('widths title 3.5')).toMatchObject({ message: 'Expected a whole number of pixels, found "3.5"', line: 1, column: 14 })
  })

  it('refuse a list item that is not a value', () => {
    expect(error('where a in (Go)')).toMatchObject({ message: expect.stringContaining('a number, true, false, null'), line: 1, column: 13 })
  })

  it('refuse an unclosed relation test', () => {
    expect(error('where r:team any (a == 1')).toMatchObject({ message: 'Expected "and" or ")", found the end', line: 1, column: 25 })
  })

  it('refuse a reserved word as a field', () => {
    expect(error('where and == 1')).toMatchObject({ message: expect.stringMatching(/^Expected a condition/), line: 1, column: 7 })
  })

  it('refuse what follows a finished query', () => {
    expect(error('from Repository\ncolumns title\nfrom Service')).toMatchObject({ message: 'Expected from, columns, where, sort by, group by, total, chart, or widths, found "from"', line: 3, column: 1 })
  })

  it('ask for a blueprint first in text that names none', () => {
    expect(error('repositories please')).toMatchObject({ message: 'Expected from and a blueprint, found "repositories"', line: 1, column: 1 })
  })

  it('ask for "as" and a title on a named column', () => {
    expect(error('columns col owner "Owner"')).toMatchObject({ message: 'Expected "as", found """', line: 1, column: 19 })
  })
})

describe('what the text could go on with', () => {
  const next = (text: string): QueryExpected[] => readQuery(text, names).expected
  const words = (text: string) => next(text).flatMap((e) => (e.kind === 'keyword' ? [e.word] : []))

  it('is from and a blueprint at the start, then a blueprint', () => {
    expect(words('')).toContain('from')
    expect(next('from ')).toEqual([{ kind: 'blueprint' }])
  })

  it('is a field of the source under where, and of what a relation reaches inside its brackets', () => {
    expect(next('from Repository\n  | where ')).toContainEqual({ kind: 'field', scope: { kind: 'filter', blueprints: ['sw_repository'], path: [] } })
    expect(next('from Repository | where r:team any (')).toContainEqual({ kind: 'field', scope: { kind: 'filter', blueprints: ['sw_repository'], path: ['r:team'] } })
  })

  it('is a test after a field, and a value of that field after the test', () => {
    const after = next('from Repository | where language ')
    expect(after).toContainEqual({ kind: 'symbol', symbol: '==' })
    expect(after).toContainEqual({ kind: 'keyword', word: 'in' })
    expect(after).toContainEqual({ kind: 'keyword', word: 'any' })
    expect(next('from Repository | where language == ')).toEqual([{ kind: 'value', field: 'language', scope: { kind: 'filter', blueprints: ['sw_repository'], path: [] } }])
    expect(next('from Repository | where language in ("Go", ')).toContainEqual({ kind: 'value', field: 'language', scope: { kind: 'filter', blueprints: ['sw_repository'], path: [] } })
  })

  it('is a column of every source under columns, and one of the query’s own columns in the view', () => {
    expect(next('from Repository\nfrom Service\ncolumns ')).toContainEqual({ kind: 'field', scope: { kind: 'pick', blueprints: ['sw_repository', 'sw_service'] } })
    expect(next('from Repository\ncolumns title, days_idle\nsort by ')).toContainEqual({ kind: 'field', scope: { kind: 'column', ids: ['title', 'days_idle'], blueprints: ['sw_repository'] } })
    expect(words('from Repository\ncolumns title, days_idle\ntotal days_idle ')).toEqual([...QUERY_TOTALS])
  })

  it('is the next part of the query after a whole clause', () => {
    expect(words('from Repository\n')).toEqual(expect.arrayContaining(['from', 'columns', 'where', 'sort', 'group', 'total', 'chart', 'widths']))
    expect(next('from Repository\n')).toContainEqual({ kind: 'symbol', symbol: '|' })
  })

  it('is nothing where the text broke before its end', () => {
    expect(next('from Nope | where ')).toEqual([])
  })
})

describe('the names the text read', () => {
  it('are marked where they stand, each field with what it is read against', () => {
    const text = 'from Repository | where days_idle > 90\ncolumns title\nsort by title'
    expect(readQuery(text, names).marks).toEqual([
      { kind: 'blueprint', from: 5, to: 15, id: 'sw_repository' },
      { kind: 'field', from: 24, to: 33, id: 'days_idle', scope: { kind: 'filter', blueprints: ['sw_repository'], path: [] } },
      { kind: 'field', from: 47, to: 52, id: 'title', scope: { kind: 'pick', blueprints: ['sw_repository'] } },
      { kind: 'field', from: 61, to: 66, id: 'title', scope: { kind: 'column', ids: ['title'], blueprints: ['sw_repository'] } },
    ])
  })
})
