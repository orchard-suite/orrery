import { describe, expect, it } from 'vitest'
import type { ReportEditionLine, ReportEditionRead } from '../shared/api.ts'
import { parseLayout, draftOf } from '../shared/report.ts'
import { blockLine, compareEditions, freeName, levelOf, nextOf, trendsOf, withoutData } from './report.ts'

const edition = (number: number, open: number | null, rows: unknown[][]): ReportEditionRead => ({
  content: { title: 'R', number, publishedAt: `2026-11-0${number}T12:00:00Z`, blocks: [{ kind: 'stats', items: [{ name: 'open', title: 'Open', value: open, was: null, better: 'down' }] }] },
  data: { teams: { columns: [{ id: 'team', title: 'Team' }, { id: 'open', title: 'Open' }], rows, total: rows.length, truncated: false } },
})

describe('a report page', () => {
  it('draws each headline number across the editions, oldest first, leaving out an edition that does not hold it', () => {
    const editions: ReportEditionLine[] = [{ number: 3, publishedAt: '2026-11-03T00:00:00Z', summary: '', headline: { open: 2 } }, { number: 2, publishedAt: '2026-11-02T00:00:00Z', summary: '', headline: {} }, { number: 1, publishedAt: '2026-11-01T00:00:00Z', summary: '', headline: { open: 5 } }]
    expect(trendsOf([{ name: 'open', title: 'Open', unit: '%' }, { name: 'gone', title: 'Gone' }], editions)).toEqual([{ stat: { name: 'open', title: 'Open', unit: '%' }, trend: { points: [{ at: '2026-11-01T00:00:00Z', value: 5 }, { at: '2026-11-03T00:00:00Z', value: 2 }], unit: '%' } }])
  })

  it('lays two editions side by side, the older first, with how each number moved', () => {
    const c = compareEditions(edition(4, 3, [['a', 3]]), edition(2, 5, [['a', 4], ['b', 1]]))
    expect(c).toMatchObject({ older: 2, newer: 4, stats: [{ name: 'open', older: 5, newer: 3, change: { text: '▼ 2', tone: 'good' } }] })
    expect(c.data).toEqual([{ name: 'teams', columns: ['Team', 'Open'], older: { rows: [['a', '4'], ['b', '1']], total: 2 }, newer: { rows: [['a', '3']], total: 1 } }])
  })
})

describe('the reports list', () => {
  const schedule = (state: 'active' | 'awaiting' | 'paused', when: string) => ({ id: when, title: when, when, state, nextAt: null, owner: 'a@example.org' })

  it('says when a report publishes next: its live schedule first, then what it waits for', () => {
    expect(nextOf({ schedules: [] })).toBe('No schedule')
    expect(nextOf({ schedules: [schedule('paused', 'Mondays'), schedule('active', 'Fridays at 8:00 AM')] })).toBe('Fridays at 8:00 AM')
    expect(nextOf({ schedules: [schedule('awaiting', 'Daily')] })).toBe('Daily, waiting for approval')
    expect(nextOf({ schedules: [schedule('paused', 'Mondays')] })).toBe('Mondays, paused')
  })

  it('draws a status the lamp has no level for as grey', () => {
    expect([levelOf('green'), levelOf('red'), levelOf('who knows')]).toEqual(['green', 'red', 'grey'])
  })
})

describe('the report form', () => {
  const draft = draftOf(parseLayout('---\nwriter: w\ndata:\n  cost: { query: q1 }\n  runs: { query: q2 }\n---\n# Week\n```stats\ndata: cost\n```\n```chart\ndata: runs\ntitle: By night\nx: night\ny: passed\n```\n```narrative\ndata: [cost, runs]\ninstruction: Say it.\n```\n```narrative\ndata: cost\ninstruction: Only cost.\n```').layout!)

  it('names a new data set from its query, never one the draft holds', () => {
    expect(freeName('Cost by team', [])).toBe('cost_by_team')
    expect(freeName('Cost by team', ['cost_by_team', 'cost_by_team_2'])).toBe('cost_by_team_3')
    expect(freeName('2026 runs', [])).toBe('n_2026_runs')
  })

  it('takes a data set away with every block that read only it, and leaves a summary that reads another', () => {
    const left = withoutData(draft, 'cost')
    expect(Object.keys(left.data)).toEqual(['runs'])
    expect(left.blocks.map((b) => b.kind)).toEqual(['heading', 'chart', 'narrative'])
    expect(left.blocks[2]).toMatchObject({ data: ['runs'] })
  })

  it('says each block in a line, for the outline on a report\'s record', () => {
    const { layout } = parseLayout('---\nwriter: w\ndata:\n  cost: { query: q1 }\n---\n```stats\ndata: cost\n```\n```chart\ndata: cost\ntitle: By team\n```\n```table\ndata: cost\nlimit: 5\n```\n```narrative\ndata: cost\ninstruction: Say   what\n  changed.\n```')
    expect(layout!.blocks.map(blockLine)).toEqual([
      { kind: 'Numbers', says: 'what cost adds up' },
      { kind: 'Chart', says: 'By team: as cost shows it' },
      { kind: 'Table', says: 'cost, 5 rows' },
      { kind: 'Written', says: 'Say what changed.' },
    ])
  })
})
