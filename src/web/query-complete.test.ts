import { describe, expect, it } from 'vitest'
import type { Blueprint } from '../shared/model.ts'
import { readQuery, type Names } from '../shared/query-text.ts'
import { meaningOf, offers, unknownMarks } from './query-complete.ts'

const bp = (id: string, title: string, fields: Blueprint['fields'], relations: Blueprint['relations'] = {}, description?: string): Blueprint => ({ id, title, fields, relations, ...(description ? { description } : {}) }) as Blueprint
const blueprints: Blueprint[] = [
  bp('issue', 'Issue', { state: { type: 'enum', title: 'Issue state', values: ['open', 'closed'] }, draft: { type: 'boolean' }, created_at: { type: 'datetime', description: 'When it was opened.' } }, { repository: { target: 'repo', many: false, title: 'Repository' } }, 'An issue or pull request.'),
  bp('repo', 'Repository', { name: { type: 'string' }, stars: { type: 'number' } }, { team: { target: 'team', many: false } }),
  bp('team', 'Team', { lead: { type: 'string', description: 'Who leads it.' } }),
]
const names: Names = { blueprints: blueprints.map((b) => ({ id: b.id, title: b.title })) }

/** What the editor offers with the cursor where `|` stands in the text. */
function at(text: string): string[] {
  const cursor = text.indexOf('|<')
  const before = text.slice(0, cursor)
  const typed = /[A-Za-z0-9_$:.@-]*$/.exec(before)![0]
  return offers(readQuery(before.slice(0, before.length - typed.length), names).expected, typed, names, blueprints).map((o) => o.label)
}

describe('the editor offers', () => {
  it('the blueprints after from, by the names the text reads them by', () => {
    expect(at('from |<')).toEqual(['Issue', 'Repository', 'Team'])
  })

  it('the source’s fields, relations, and what every entity has under where', () => {
    const got = at('from Issue | where |<')
    expect(got).toEqual(expect.arrayContaining(['state', 'draft', 'created_at', 'r:repository', '$status', '$state']))
    expect(got).not.toContain('name')
  })

  it('the fields of what a relation reaches inside its brackets', () => {
    expect(at('from Issue | where r:repository any (|<')).toEqual(expect.arrayContaining(['name', 'stars', 'r:team']))
  })

  it('an enum’s values, true and false, and the entity’s own states after a test', () => {
    expect(at('from Issue | where state == |<')).toEqual(['"open"', '"closed"'])
    expect(at('from Issue | where draft == |<')).toEqual(['true', 'false'])
    expect(at('from Repository | where $state == |<')).toEqual(['"active"', '"missing"', '"deleted"'])
  })

  it('each hop of a relation path and the fields at its end in a column', () => {
    expect(at('from Issue\ncolumns r:repository.|<')).toContain('r:repository.team')
    expect(at('from Issue\ncolumns r:repository.team@|<')).toEqual(expect.arrayContaining(['r:repository.team@lead', 'r:repository.team@$status']))
  })

  it('only the query’s own columns in the view', () => {
    expect(at('from Issue\ncolumns title, state\nsort by |<')).toEqual(['title', 'state'])
  })
})

describe('a name in the text', () => {
  const marks = (text: string) => readQuery(text, names).marks

  it('means the field its blueprint defines, or what every entity has', () => {
    const [, state, status] = marks('from Issue | where state == "open" and $status == "red"')
    expect(meaningOf(state!, blueprints)).toEqual({ title: 'Issue state', kind: 'enum', description: undefined })
    expect(meaningOf(status!, blueprints)).toMatchObject({ title: 'Status', kind: 'every entity' })
  })

  it('is unknown where nothing the query reads has it', () => {
    const got = unknownMarks(marks('from Issue | where nope == 1 and r:repository any (stars > 3)\ncolumns title, r:repository@stars, ghost\nsort by stars'), blueprints)
    expect(got.map((m) => m.kind === 'field' && m.id)).toEqual(['nope', 'ghost', 'stars'])
  })

  it('is known as a column every entity has before the query reads anything', () => {
    expect(unknownMarks(marks('columns $type, title, $status'), blueprints)).toEqual([])
  })
})
