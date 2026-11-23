import { describe, expect, it } from 'vitest'
import { RUNS_SOURCE, type GridClause, type QueryColumn, type QueryRow, type SavedQuery } from '../shared/api.ts'
import { groupId, shape, type ColumnKind } from '../shared/answer.ts'
import type { Blueprint } from '../shared/model.ts'
import { addable, answerLines, BY_BLUEPRINT, chartBars, chartPlan, seenSources, between, choicesIn, columnFor, editable, groupedBy, hueOf, joined, left, library, numeric, picks, pickValue, removeQuestion, rowsBeside, RUNS, sharingOf, sortedBy, START_COLUMNS, totalled, withoutColumn } from './query.ts'

const bp = (id: string, fields: Record<string, { type: string; title?: string }>, relations: Record<string, { target: string; title?: string }> = {}): Blueprint =>
  ({ id, title: id, fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, { ...v }])), relations: Object.fromEntries(Object.entries(relations).map(([k, v]) => [k, { many: false, ...v }])) }) as unknown as Blueprint

const service = bp('service', { language: { type: 'enum' }, dependabot_high: { type: 'number', title: 'Dependabot high' }, last_changed_by: { type: 'string', title: 'Last changed by' } }, { team: { target: 'team', title: 'Owned by' } })
const repo = bp('repository', { language: { type: 'enum' }, dependabot_high: { type: 'number', title: 'Dependency alerts high' }, last_committer: { type: 'string' } })

describe('the columns a page edits', () => {
  it('turns a plain id into the field of that id in every blueprint that has it, titled by the first', () => {
    expect(editable(['title', 'dependabot_high', 'r:team', 'nothing'], [service, repo])).toEqual([
      { id: 'title', title: 'Title', from: { service: 'title', repository: 'title' } },
      { id: 'dependabot_high', title: 'Dependabot high', from: { service: 'dependabot_high', repository: 'dependabot_high' } },
      { id: 'r:team', title: 'Owned by', from: { service: 'r:team' } },
    ])
  })

  it('keeps the columns every entity has before any blueprint is read, and fills them as one joins', () => {
    const start = editable(START_COLUMNS, [])
    expect(start.map((c) => [c.id, c.from])).toEqual([['$type', {}], ['title', {}], ['$status', {}]])
    expect(joined(start, service).map((c) => c.from)).toEqual([{ service: '$type' }, { service: 'title' }, { service: '$status' }])
  })

  it('fills a column for a blueprint that joins with what the others read there, where it has it', () => {
    const named = [{ id: 'who', title: 'Last change by', from: { service: 'last_changed_by' } }, { id: 'lang', title: 'Language', from: { service: 'language' } }]
    expect(joined(named, repo)).toEqual([named[0], { id: 'lang', title: 'Language', from: { service: 'language', repository: 'language' } }])
    expect(left(joined(named, repo), 'service')).toEqual([{ id: 'who', title: 'Last change by', from: {} }, { id: 'lang', title: 'Language', from: { repository: 'language' } }])
  })

  it('keeps a named column as sent, one column an id', () => {
    const named = { id: 'who', title: 'Who', from: { service: 'last_changed_by', repository: 'last_committer' } }
    expect(editable([named, named, 'title'], [service, repo])).toEqual([named, { id: 'title', title: 'Title', from: { service: 'title', repository: 'title' } }])
  })

  it('adds a column under an id no other column holds', () => {
    const one = columnFor('language', [service, repo], [])
    expect(one).toEqual({ id: 'language', title: 'language', from: { service: 'language', repository: 'language' } })
    expect(columnFor('language', [service, repo], [one]).id).toBe('language~2')
  })

  it('offers what no column reads yet, what every blueprint has first', () => {
    const offered = addable([service, repo], editable(['title', 'language'], [service, repo]))
    expect(offered[0]).toMatchObject({ in: ['service', 'repository'] })
    expect(offered.map((o) => o.id)).not.toContain('language')
    expect(offered.find((o) => o.id === 'last_committer')).toEqual({ id: 'last_committer', title: 'last_committer', in: ['repository'] })
  })

  it('reads the action runs as their own columns and the ones every row has', () => {
    const cols = joined(editable(['title', 'language'], [service]), RUNS)
    expect(cols.map((c) => c.from)).toEqual([{ service: 'title', $runs: 'title' }, { service: 'language' }])
    expect(columnFor('run:seconds', [service, RUNS], cols)).toEqual({ id: 'run:seconds', title: 'Seconds', from: { $runs: 'run:seconds' } })
    expect(choicesIn(RUNS).filter((c) => c.group === 'Run').map((c) => c.id)).toContain('run:action')
  })

  it('lists what a column may read in a blueprint, grouped', () => {
    const choices = choicesIn(service)
    expect(choices.slice(0, 2).map((c) => c.group)).toEqual(['Every entity', 'Every entity'])
    expect(choices.find((c) => c.id === 'r:team')).toEqual({ id: 'r:team', title: 'Owned by', kind: 'relation', group: 'Relations' })
  })

  it('lines a column up on the right only when every field it reads is a number', () => {
    expect(numeric({ from: { service: 'dependabot_high', repository: 'dependabot_high' } }, [service, repo])).toBe(true)
    expect(numeric({ from: { service: 'dependabot_high', repository: 'language' } }, [service, repo])).toBe(false)
    expect(numeric({ from: {} }, [service, repo])).toBe(false)
  })

  it('draws each blueprint in its own colour, never red or green', () => {
    const hues = Array.from({ length: 20 }, (_, i) => hueOf(i))
    expect(hues).not.toContain('red')
    expect(hues).not.toContain('green')
    expect(new Set(hues.slice(0, 8)).size).toBe(8)
  })
})

describe('the library', () => {
  const q = (id: string, owner: string, shared: boolean, audience: string | null = null, home: { title: string; yours?: boolean; shared?: boolean } | null = null): SavedQuery => ({
    id,
    title: id,
    description: null,
    owner,
    shared,
    audience: audience ? { id: audience, title: audience.toUpperCase() } : null,
    home: home ? { id: `program:${home.title}`, entity: { blueprint: 'program', key: home.title }, title: home.title, icon: null, yours: !!home.yours } : null,
    homeShared: !!home?.shared,
    spec: { sources: [], columns: [] },
    createdAt: '',
    updatedAt: '',
    mine: false,
  })

  it('shelves what I saved, then each audience, then everyone, leaving out an empty shelf', () => {
    const shelves = library([q('b-mine', 'me@x', true), q('a-mine', 'me@x', false), q('ops', 'ann@x', false, 'ops'), q('all', 'bo@x', true), q('dev', 'cy@x', false, 'dev')], 'me@x')
    expect(shelves.map((s) => [s.title, s.queries.map((x) => x.id)])).toEqual([
      ['Your library', ['a-mine', 'b-mine']],
      ['Shared with DEV', ['dev']],
      ['Shared with OPS', ['ops']],
      ['Shared with everyone', ['all']],
    ])
    expect(library([q('all', 'bo@x', true)], 'me@x').map((s) => s.id)).toEqual(['everyone'])
  })

  it('shelves each home’s collection first, whoever saved it, the homes the reader owns before the rest', () => {
    const shelves = library([q('mine', 'me@x', false), q('comet-cost', 'ann@x', false, null, { title: 'Comet', shared: true }), q('comet-mine', 'me@x', false, null, { title: 'Comet' }), q('ember', 'bo@x', true, null, { title: 'Ember', yours: true }), q('all', 'bo@x', true)], 'me@x')
    expect(shelves.map((s) => [s.id, s.title, s.queries.map((x) => x.id)])).toEqual([
      ['home:program:Ember', 'Ember', ['ember']],
      ['home:program:Comet', 'Comet', ['comet-cost', 'comet-mine']],
      ['yours', 'Your library', ['mine']],
      ['everyone', 'Shared with everyone', ['all']],
    ])
    expect(library([q('comet', 'ann@x', false, null, { title: 'Comet' })], 'me@x', 'comet').map((s) => s.title)).toEqual(['Comet'])
  })

  it('finds by title, owner, or audience', () => {
    expect(library([q('pods', 'ann@x', true), q('nodes', 'bo@x', true)], 'me@x', 'ann').flatMap((s) => s.queries.map((x) => x.id))).toEqual(['pods'])
  })

  it('asks before a removal, naming whose it is and everyone else it goes from', () => {
    expect(removeQuestion(q('Mine', 'me@x', false), 'me@x')).toBe('Remove the saved query "Mine"? This cannot be undone.')
    expect(removeQuestion(q('All', 'me@x', true), 'me@x')).toBe('Remove the saved query "All"? Everyone can open it, so it goes from every library. This cannot be undone.')
    expect(removeQuestion(q('Ops', 'ann@x', false, 'ops'), 'me@x')).toBe('Remove the saved query "Ops"? It is ann\'s. OPS can open it, so it goes from their libraries too. This cannot be undone.')
    expect(removeQuestion(q('CM', 'me@x', false, null, { title: 'Comet 2', shared: true }), 'me@x')).toBe('Remove the saved query "CM"? The people of Comet 2 can open it, so it goes from their libraries too. It also leaves the page of Comet 2. This cannot be undone.')
  })

  it('says who may open one', () => {
    expect([sharingOf(q('a', 'me', false)), sharingOf(q('b', 'me', false, 'ops')), sharingOf(q('d', 'me', false, null, { title: 'Comet', shared: true })), sharingOf(q('c', 'me', true))]).toEqual(['private', 'audience', 'home', 'everyone'])
  })
})

describe('the answer the grid draws', () => {
  const columns: QueryColumn[] = [
    { id: 'title', title: 'Title', from: { service: 'title' } },
    { id: 'language', title: 'Language', from: { service: 'language' } },
    { id: 'alerts', title: 'Alerts', from: { service: 'dependabot_high' } },
  ]
  const kinds: ColumnKind[] = ['string', 'enum', 'number']
  const row = (key: string, language: string | null, alerts: number | null): QueryRow => ({ blueprint: 'service', key, values: [key, language, alerts] })
  const rows = [row('a', 'Go', 3), row('b', 'Go', 1), row('c', 'C#', null), row('d', null, 7)]

  it('draws each group, then what it holds unless it is folded, and an opened row then its detail', () => {
    const shaped = shape(rows, { group: ['language'] }, columns, kinds)
    const go = groupId(shaped.groups![0]!.path)
    const lines = answerLines(shaped, new Set([go]), new Set(['service:c']))
    expect(lines.map((l) => (l.kind === 'group' ? `g:${l.group.count}${l.folded ? ' folded' : ''}` : `${l.kind}:${l.row.key}`))).toEqual(['g:2 folded', 'g:1', 'row:c', 'detail:c', 'g:1', 'row:d'])
  })

  it('counts a column over the rows every other condition keeps', () => {
    const where: GridClause[] = [{ field: 'language', op: 'eq', value: 'Go' }, { field: 'alerts', op: 'gte', value: '2' }]
    expect(rowsBeside(rows, where, 'language', columns, kinds).map((r) => r.key)).toEqual(['a', 'd'])
  })

  it('picks a value, leaves it out, and takes it back', () => {
    const kept = pickValue([], 'language', 'Go', false)
    expect(kept).toEqual([{ field: 'language', op: 'eq', value: 'Go' }])
    expect(picks(kept, 'language', 'Go')).toBe('kept')
    expect(pickValue(kept, 'language', 'Go', false)).toEqual([])
    const out = pickValue(kept, 'language', 'Go', true)
    expect(picks(out, 'language', 'Go')).toBe('left out')
    expect(out).toHaveLength(1)
    expect(pickValue([], 'language', null, false)).toEqual([{ field: 'language', op: 'exists', value: '', not: true }])
  })

  it('holds a column between bounds, and lets go of what bounded it before', () => {
    const once = between([{ field: 'language', op: 'eq', value: 'Go' }], 'alerts', '2', null)
    expect(between(once, 'alerts', '1', '5')).toEqual([{ field: 'language', op: 'eq', value: 'Go' }, { field: 'alerts', op: 'gte', value: '1' }, { field: 'alerts', op: 'lte', value: '5' }])
  })

  it('orders, groups, and adds up a view, and forgets a column that goes', () => {
    let view = sortedBy(undefined, 'alerts', true)
    expect(view).toEqual({ sort: [{ column: 'alerts', desc: true }] })
    view = groupedBy(view, 'language', true)
    view = totalled(view, 'alerts', 'sum')
    view = { ...view, widths: { alerts: 140 }, where: [{ field: 'alerts', op: 'gt', value: '0' }] }
    expect(groupedBy(view, 'language', false).group).toBeUndefined()
    expect(totalled(view, 'alerts', null).totals).toBeUndefined()
    expect(sortedBy(view, 'alerts', null).sort).toBeUndefined()
    expect(withoutColumn(view, 'alerts')).toEqual({ group: ['language'] })
    expect(withoutColumn({ widths: { alerts: 1 } }, 'alerts')).toBeUndefined()
  })
})

describe('the chart', () => {
  const columns: QueryColumn[] = [
    { id: '$type', title: 'Type', from: { app: '$type', db: '$type' } },
    { id: 'title', title: 'Title', from: { app: 'title', db: 'title' } },
    { id: 'env', title: 'Environment', from: { app: 'env', db: 'env' } },
    { id: 'cost', title: 'Cost', from: { app: 'cost', db: 'cost' } },
  ]
  const kinds = ['enum', 'string', 'enum', 'number'] as const
  const row = (blueprint: string, type: string, env: string | null, cost: number | null): QueryRow => ({ blueprint, key: `${blueprint}-${type}-${env}-${cost}`, values: [type, 'x', env, cost] })
  const rows = [row('app', 'App', 'Prod', 300), row('app', 'App', 'Test', 100), row('db', 'Database', 'Prod', 2500), row('db', 'Database', null, null), row('app', 'App', 'Prod', 50)]

  it('draws what the view groups by, as long as what it adds up, before it counts rows', () => {
    expect(chartPlan({ group: ['$type'], totals: { title: 'count', cost: 'sum' } }, columns, [...kinds], rows, 2)).toEqual({ by: '$type', total: 'sum', column: 'cost', split: null })
    expect(chartPlan({ group: ['$type'] }, columns, [...kinds], rows, 2)).toEqual({ by: '$type', total: 'count', column: null, split: null })
  })

  it('splits by the second group, else by blueprint where it reads several, and never splits what does not add up', () => {
    expect(chartPlan({ group: ['$type', 'env'], totals: { cost: 'sum' } }, columns, [...kinds], rows, 2).split).toBe('env')
    expect(chartPlan({ group: ['env'] }, columns, [...kinds], rows, 2).split).toBe(BY_BLUEPRINT)
    expect(chartPlan({ group: ['env'], chart: { split: null } }, columns, [...kinds], rows, 2).split).toBeNull()
    expect(chartPlan({ group: ['$type', 'env'], totals: { cost: 'avg' } }, columns, [...kinds], rows, 2)).toMatchObject({ total: 'avg', split: null })
  })

  it('takes what a person picked over the view, and passes over a pick the answer cannot draw', () => {
    expect(chartPlan({ group: ['$type'], totals: { cost: 'sum' }, chart: { by: 'env', total: 'max', column: 'cost' } }, columns, [...kinds], rows, 2)).toEqual({ by: 'env', total: 'max', column: 'cost', split: null })
    expect(chartPlan({ group: ['$type'], chart: { by: 'gone', total: 'sum', column: 'title' } }, columns, [...kinds], rows, 2)).toMatchObject({ by: '$type', total: 'count', column: null })
  })

  it('makes a bar each value as long as its total, longest first and no value last, each split into parts that add up to it', () => {
    const chart = chartBars(rows, columns, { by: 'env', total: 'sum', column: 'cost', split: '$type' })
    expect(chart.bars.map((b) => [b.label, b.amount, b.parts])).toEqual([
      ['Prod', 2850, [{ key: 'db', amount: 2500 }, { key: 'app', amount: 350 }]],
      ['Test', 100, [{ key: 'app', amount: 100 }]],
      ['No value', 0, [{ key: 'db', amount: 0 }]],
    ])
    expect(chart.whole).toBe(2950)
    expect(chart.parts.map((p) => p.key)).toEqual(['db', 'app'])
  })

  it('counts rows, names the one blueprint a bar holds, and says how many bars it leaves out', () => {
    const chart = chartBars(rows, columns, { by: '$type', total: 'count', column: null, split: null }, 1)
    expect(chart.bars.map((b) => [b.label, b.amount, b.blueprint])).toEqual([['App', 3, 'app']])
    expect(chart.more).toBe(1)
    expect(chart.whole).toBe(5)
  })
})

describe('a query as one reader is shown it', () => {
  const draft = { sources: [{ blueprint: 'app', clauses: [] }, { blueprint: 'vault', clauses: [] }, { blueprint: RUNS_SOURCE, clauses: [] }] }
  const sees = (bp: string) => bp !== 'vault'

  it('leaves out the blueprints they may not see, and keeps the action runs', () => {
    expect(seenSources(draft, sees).shown.sources.map((s) => s.blueprint)).toEqual(['app', '$runs'])
    expect(seenSources(draft, null).shown).toBe(draft)
  })

  it('keeps what was left out through a change they make, and lets them take away what they see', () => {
    const { shown, back } = seenSources(draft, sees)
    expect(back({ sources: [...shown.sources, { blueprint: 'db', clauses: [] }] }).sources.map((s) => s.blueprint)).toEqual(['app', '$runs', 'db', 'vault'])
    expect(back({ sources: [] }).sources.map((s) => s.blueprint)).toEqual(['vault'])
  })
})
