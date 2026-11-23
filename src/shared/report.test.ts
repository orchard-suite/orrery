import { describe, expect, it } from 'vitest'
import { buildContent, cellOf, changeOf, draftOf, leadOf, formatNumber, gap, headlineOf, parseLayout, printLayout, tableOf, toneOf, writerData, WRITER_DATA_MAX, type DataSet } from './report.ts'
import { coversOf, drawEdition, whenOf } from './report-draw.ts'

const front = '---\nwriter: write_prose\ndata:\n  runs: { query: q1 }\n  flaky: { tool: flaky_tests, entity: repo:api, inputs: { days: 7 } }\n---\n'

describe('a layout', () => {
  it('reads front matter, headings, paragraphs, and each kind of block, with the line each starts on', () => {
    const { layout, issues } = parseLayout(`${front}# Tests\n\nHow the week went.\nTwo lines.\n\n\`\`\`stats\ndata: runs\nitems:\n  - { name: passed, title: Passed, of: sum, column: passed, better: up }\n  - { name: runs, of: count }\n\`\`\`\n\`\`\`chart\ntype: trend\ndata: runs\nx: day\ny: [passed, failed]\n\`\`\`\n\`\`\`table\ndata: flaky\nlimit: 5\n\`\`\`\n\`\`\`narrative\ndata: [runs, flaky]\ninstruction: Say what changed.\n\`\`\`\n`)
    expect(issues).toEqual([])
    expect(layout!.writer).toBe('write_prose')
    expect(layout!.data).toEqual({ runs: { query: 'q1' }, flaky: { tool: 'flaky_tests', entity: 'repo:api', inputs: { days: 7 } } })
    expect(layout!.blocks.map((b) => [b.kind, b.line])).toEqual([['heading', 7], ['text', 9], ['stats', 12], ['chart', 18], ['table', 24], ['narrative', 28]])
    expect(layout!.blocks[3]).toMatchObject({ type: 'trend', x: 'day', y: ['passed', 'failed'] })
  })

  it('names every problem in one pass, each with its line, and never passes over an unknown name', () => {
    const { layout, issues } = parseLayout(`---\ndata:\n  runs: { query: q1, tool: t }\n  Bad: { query: q2 }\n---\n\`\`\`stats\ndata: runs\ncolour: red\nitems:\n  - { name: x, of: median }\n\`\`\`\n\`\`\`chart\ntype: pie\ndata: gone\nx: a\ny: b\n\`\`\`\n\`\`\`narrative\ndata: runs\ninstruction: hi\n\`\`\`\n\`\`\`\n\`\`\`\n`)
    expect(layout).toBeNull()
    const said = issues.map((i) => `${i.line}: ${i.message}`)
    expect(said).toEqual(expect.arrayContaining([
      '1: a narrative block needs a writer: name the runner tool that writes prose in the front matter, as writer',
      '3: data set "runs" names one query or one tool',
      '4: data set "Bad": a name is lowercase letters, digits, and _',
      '8: stats block: unknown "colour"; it takes data, title, items',
      '9: stats item 1: of is one of count, sum, avg, min, max, first, last',
      '13: chart block: type is one of trend, bars, delta',
      '22: a block names its kind after the fence: stats, chart, table, scorecard, narrative',
    ]))
  })

  it('refuses a stat named twice, a block of nothing, and a block left open', () => {
    expect(parseLayout('```stats\ndata: a\nitems: [{ name: n, of: count }, { name: n, of: count }]\n```').issues.map((i) => i.message)).toContain('stat "n" is named twice: once on line 1')
    expect(parseLayout('# Only a heading').issues.map((i) => i.message)).toEqual(['a layout holds at least one block: stats, chart, table, scorecard, narrative'])
    expect(parseLayout('```table\ndata: a').issues.map((i) => i.message)).toContain('the block opened here is never closed with ```')
  })
})

describe('a layout a form writes', () => {
  it('reads back as the same layout', () => {
    const text = `${front}# Tests\n\nHow the week went.\n\n\`\`\`stats\ndata: runs\nitems:\n  - { name: passed, title: Passed, of: sum, column: passed, better: up, unit: "%" }\n\`\`\`\n\`\`\`stats\ndata: flaky\n\`\`\`\n\`\`\`chart\ndata: runs\n\`\`\`\n\`\`\`chart\ntype: trend\ndata: runs\ntitle: By day\nx: day\ny: [passed, failed]\n\`\`\`\n\`\`\`table\ndata: flaky\ncolumns: [a, b]\nlimit: 5\n\`\`\`\n\`\`\`narrative\ndata: [runs, flaky]\ninstruction: "Say what changed: briefly."\n\`\`\`\n`
    const first = parseLayout(text)
    expect(first.issues).toEqual([])
    const again = parseLayout(printLayout(draftOf(first.layout!)))
    expect(again.issues).toEqual([])
    expect(draftOf(again.layout!)).toEqual(draftOf(first.layout!))
  })

  it('refuses two stats blocks that both show what one data set brings', () => {
    expect(parseLayout('---\ndata:\n  a: { query: q }\n---\n```stats\ndata: a\n```\n```stats\ndata: a\n```').issues.map((i) => i.message)).toContain('two stats blocks show the numbers of data set "a": the other is on line 5')
  })
})

const set = (columns: string[], rows: unknown[][]): DataSet => ({ columns: columns.map((id) => ({ id, title: id })), rows, total: rows.length, truncated: false })

describe('an edition', () => {
  const { layout } = parseLayout(`---\nwriter: w\ndata:\n  teams: { query: q }\n---\n\`\`\`stats\ndata: teams\nitems:\n  - { name: open, title: Open, of: sum, column: open, better: down }\n  - { name: teams, of: count }\n\`\`\`\n\`\`\`chart\ntype: delta\ndata: teams\nx: team\ny: open\n\`\`\`\n\`\`\`table\ndata: teams\ncolumns: [team, missing]\n\`\`\`\n\`\`\`narrative\ndata: teams\ninstruction: Say it.\n\`\`\`\n`)
  const now = { teams: set(['team', 'open'], [['a', 3], ['b', '5'], ['c', null]]) }
  const before = { headline: { open: 10, teams: 3 }, data: { teams: set(['team', 'open'], [['a', 4], ['b', 6]]) } }

  it('takes every number from its data, and what changed from the edition before', () => {
    const content = buildContent(layout!, now, new Map([[3, { text: 'All good.' }]]), before, { title: 'T', number: 2, publishedAt: '2026-11-18T12:00:00Z' })
    expect(headlineOf(content.blocks)).toEqual({ open: 8, teams: 3 })
    expect(content.blocks[0]).toMatchObject({ items: [{ value: 8, was: 10 }, { value: 3, was: 3 }] })
    expect(content.blocks[1]).toMatchObject({ series: [{ points: [{ label: 'a', value: 3, was: 4 }, { label: 'b', value: 5, was: 6 }, { label: 'c', value: null, was: null }] }] })
    expect(content.blocks[2]).toMatchObject({ gap: 'no column "missing"', rows: [] })
    expect(content.blocks[3]).toEqual({ kind: 'narrative', text: 'All good.' })
  })

  it('says why a block holds nothing, and never draws a gap as a number', () => {
    const content = buildContent(layout!, { teams: gap('the query is gone') }, new Map([[3, { gap: 'the writer failed' }]]), null, { title: 'T', number: 1, publishedAt: '2026-11-18T12:00:00Z' })
    expect(content.blocks[0]).toMatchObject({ gap: 'the query is gone', items: [{ value: null }, { value: null }] })
    expect(content.blocks[3]).toMatchObject({ text: null, gap: 'the writer failed' })
    expect(drawEdition(content, 'web')).toContain('–')
  })

  it('reads a good change as good only when the stat says which way is better', () => {
    expect(changeOf({ value: 8, was: 10, better: 'down' })).toEqual({ text: '▼ 2', tone: 'good' })
    expect(changeOf({ value: 8, was: 10 })).toEqual({ text: '▼ 2', tone: 'flat' })
    expect(changeOf({ value: 8, was: null })).toBeNull()
    expect(formatNumber(1234.567, undefined, '%')).toBe('1,234.57%')
    expect(formatNumber(97, 1)).toBe('97.0')
  })
})

describe('a block that says nothing of its own', () => {
  const { layout } = parseLayout('---\ndata:\n  cost: { query: q }\n  plain: { query: p }\n---\n```stats\ndata: cost\n```\n```stats\ndata: plain\n```\n```chart\ndata: cost\n```\n```chart\ndata: plain\n```')
  const cost: DataSet = { ...set(['program', 'rows', 'cost_sum'], [['a', 2, 30], ['b', 1, 12]]), shape: { totals: [{ name: 'cost', title: 'Cost', value: 42 }], chart: { x: 'program', y: ['cost_sum'] } } }
  const plain = set(['name', 'note', 'n'], [['x', 'hi', 1], ['y', 'yo', 4]])

  it('shows what its data set brings: a query\'s totals and chart, else its row count and its first number column', () => {
    const content = buildContent(layout!, { cost, plain }, new Map(), { headline: { cost_cost: 40 }, data: {} }, { title: 'T', number: 2, publishedAt: '2026-11-18T12:00:00Z' })
    expect(content.blocks[0]).toMatchObject({ items: [{ name: 'cost_cost', title: 'Cost', value: 42, was: 40 }] })
    expect(content.blocks[1]).toMatchObject({ items: [{ name: 'plain_rows', title: 'Rows', value: 2 }] })
    expect(content.blocks[2]).toMatchObject({ type: 'bars', x: 'program', series: [{ name: 'cost_sum', points: [{ label: 'a', value: 30 }, { label: 'b', value: 12 }] }] })
    expect(content.blocks[3]).toMatchObject({ type: 'bars', x: 'name', series: [{ name: 'n', points: [{ label: 'x', value: 1 }, { label: 'y', value: 4 }] }] })
  })

  it('says so when its data set holds no number to draw', () => {
    const content = buildContent(layout!, { cost, plain: set(['a', 'b'], [['x', 'y']]) }, new Map(), null, { title: 'T', number: 1, publishedAt: '2026-11-18T12:00:00Z' })
    expect(content.blocks[3]).toMatchObject({ series: [], gap: 'no number column to draw' })
  })
})

describe('written prose', () => {
  const written = (text: string) => ({ title: 'T', number: 1, publishedAt: '2026-11-18T12:00:00Z', blocks: [{ kind: 'narrative' as const, text }] })

  it('draws the little Markdown a writer may use, in both profiles', () => {
    const text = '## What happened\n\nTwo **pipelines** failed, see [the runs](https://ci.example.org/runs).\n\n- `ui` lost 3 nights\n- api held\n\n| pipeline | nights |\n| --- | --- |\n| ui | 3 |'
    for (const profile of ['web', 'email'] as const) {
      const html = drawEdition(written(text), profile)
      expect(html).toMatch(/<h4[^>]*>What happened<\/h4>/)
      expect(html).toContain('<strong>pipelines</strong>')
      expect(html).toMatch(/<a href="https:\/\/ci\.example\.org\/runs"[^>]*>the runs<\/a>/)
      expect(html).toMatch(/<li[^>]*><code>ui<\/code> lost 3 nights<\/li>/)
      expect(html).toMatch(/<th[^>]*>pipeline<\/th>/)
      expect(html).toMatch(/<td[^>]*>3<\/td>/)
    }
  })

  it('escapes what a writer wrote, and links only to an http address', () => {
    const html = drawEdition(written('<img src=x onerror=1> [x](javascript:alert(1)) **<b>**'), 'web')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('href="javascript')
    expect(html).toContain('<strong>&lt;b&gt;</strong>')
  })
})

describe('what a tool answers', () => {
  it('reads a list of objects, or named columns and rows, and says why anything else is no table', () => {
    expect(tableOf('[{"a":1},{"a":2,"b":"x"}]')).toMatchObject({ columns: [{ id: 'a' }, { id: 'b' }], rows: [[1, null], [2, 'x']], total: 2 })
    expect(tableOf('{"columns":["a"],"rows":[[1],[2]]}')).toMatchObject({ rows: [[1], [2]] })
    expect(tableOf('nope').error).toBe('the tool did not answer with JSON')
    expect(tableOf('{"a":1}').error).toBe('the tool answered JSON that is not a list of rows')
  })

  it('gives a writer no more data than it can take, the headline numbers first', () => {
    const big = set(['text'], Array.from({ length: 2000 }, (_, i) => [`row ${i} ${'x'.repeat(200)}`]))
    const text = writerData(['big'], { big }, { n: 1 })
    expect(text.length).toBeLessThanOrEqual(WRITER_DATA_MAX)
    expect(JSON.parse(text)).toMatchObject({ headline: { n: 1 }, data: { big: { total: 2000 } } })
  })
})

describe('drawing an edition', () => {
  const content = buildContent(parseLayout('---\ndata:\n  d: { query: q }\n---\n# <b>Head</b>\n```table\ndata: d\n```\n```chart\ntype: trend\ndata: d\nx: day\ny: n\n```').layout!, { d: set(['day', 'n'], [['<script>', 1], ['mon', 2]]) }, new Map(), null, { title: 'R & D', number: 1, publishedAt: '2026-11-18T12:00:00Z' })

  it('escapes everything a data set or a heading holds', () => {
    for (const profile of ['web', 'email'] as const) {
      const html = drawEdition(content, profile, 'https://hub.example.org/reports/r?edition=1')
      expect(html).not.toContain('<script>')
      expect(html).not.toContain('<b>Head')
      expect(html).toContain('&lt;script&gt;')
    }
  })

  it('draws the web with theme tokens, and the mail with inline styles and no picture', () => {
    const web = drawEdition(content, 'web')
    expect(web).toContain('<svg class="rp-chart"')
    expect(web).not.toMatch(/#[0-9a-f]{6}/i)
    const mail = drawEdition(content, 'email', 'https://hub.example.org/x')
    expect(mail).not.toContain('<svg')
    expect(mail).not.toContain('class=')
    expect(mail).toContain('<title>R &amp; D</title>')
  })
})

describe('health', () => {
  const head = { title: 'Weekly', number: 3, publishedAt: '2026-11-19T14:00:00Z', home: 'Quality <team>', zone: 'America/Chicago' }
  const text = '---\ndata:\n  p: { query: q }\n---\n```stats\ndata: p\nitems:\n  - { name: rate, of: avg, column: rate, good: 95, bad: 90 }\n  - { name: lost, of: sum, column: lost, good: 0, bad: 2 }\n  - { name: n, of: count }\n  - { name: most, of: max, column: rate }\n  - { name: least, of: min, column: rate }\n```\n```table\ndata: p\ncolumns: [name, rate]\nhealth:\n  rate: { good: 95, bad: 90 }\n```\n```scorecard\ndata: p\ntitle: Pipelines\nhealth:\n  rate: { good: 95, bad: 90 }\n  lost: { good: 0, bad: 2 }\ntrend: { columns: [w1, w2], title: Two weeks, good: 80, bad: 50 }\n```\n```chart\ntype: trend\ndata: p\nx: name\ny: rate\n```\n```chart\ntype: bars\ndata: p\nx: name\ny: lost\n```'
  const rows = set(['name', 'rate', 'lost', 'w1', 'w2'], [['api', 100, 0, 100, 60], ['ui', 92, 1, 40, 0], ['<b>', 84, 3, 90, 85]])
  const read = parseLayout(text)
  const content = buildContent(read.layout!, { p: rows }, new Map(), null, head)

  it('judges a number by two marks, higher or lower as they say, and never one that is missing', () => {
    expect([96, 95, 94, 90, 89].map((v) => toneOf(v, { good: 95, bad: 90 }))).toEqual(['good', 'good', 'warn', 'warn', 'bad'])
    expect([0, 1, 2, 3].map((v) => toneOf(v, { good: 0, bad: 2 }))).toEqual(['good', 'warn', 'warn', 'bad'])
    expect(toneOf(null, { good: 1, bad: 0 })).toBeNull()
  })

  it('is read from a layout and written back the same, and a wrong mark is named', () => {
    expect(read.issues).toEqual([])
    expect(draftOf(parseLayout(printLayout(draftOf(read.layout!))).layout!)).toEqual(draftOf(read.layout!))
    const said = parseLayout('---\ndata:\n  p: { query: q }\n---\n```table\ndata: p\nhealth:\n  rate: { good: 5, bad: 5 }\n```\n```scorecard\ndata: p\ntrend: { title: x }\n```\n```stats\ndata: p\nitems:\n  - { name: n, of: count, good: 1 }\n```').issues.map((i) => i.message)
    expect(said).toEqual(['table block: health of "rate": good and bad differ; higher is better where good is the larger', 'scorecard block: trend: columns is a list of number columns, oldest first', 'stats item 1: good and bad are two numbers, set together'])
  })

  it('marks each judged number, and a scorecard row by the worst of its own', () => {
    expect(content.blocks[0]).toMatchObject({ items: [{ name: 'rate', value: 92, tone: 'warn' }, { name: 'lost', value: 4, tone: 'bad' }, { name: 'n' }, { name: 'most' }, { name: 'least' }] })
    expect(content.blocks[1]).toMatchObject({ tones: [[null, 'good'], [null, 'warn'], [null, 'bad']] })
    expect(content.blocks[2]).toMatchObject({ label: 'name', columns: ['rate', 'lost'], trend: 'Two weeks', rows: [{ label: 'api', tone: 'good', trend: [{ value: 100, tone: 'good' }, { value: 60, tone: 'warn' }] }, { label: 'ui', tone: 'warn' }, { label: '<b>', tone: 'bad', cells: [{ text: '84', tone: 'bad' }, { text: '3', tone: 'bad' }] }] })
    const unshown = buildContent(parseLayout('---\ndata:\n  p: { query: q }\n---\n```table\ndata: p\ncolumns: [name]\nhealth:\n  rate: { good: 95, bad: 90 }\n```').layout!, { p: rows }, new Map(), null, head)
    expect(unshown.blocks[0]).toMatchObject({ gap: 'health names "rate", a column it does not show', rows: [] })
  })

  it('is drawn as a shape with a name, never as colour alone, in both profiles', () => {
    const web = drawEdition(content, 'web')
    expect(web).toContain('<span class="rp-mark rp-tone-bad" role="img" aria-label="Off track" title="Off track">■</span>')
    expect(web).toContain('rp-stat rp-stat-warn')
    expect(web).not.toMatch(/#[0-9a-f]{6}/i)
    expect(web).not.toContain('<b>')
    const mail = drawEdition(content, 'email')
    expect(mail).toContain('<span title="Watch" style="color:#9a6700">▲</span>')
    expect(mail).not.toContain('<b>')
    expect(mail).not.toContain('class=')
  })

  it('heads a mail with the home and the date in the edition\'s own time zone', () => {
    expect(whenOf(head)).toBe('Thursday, November 19, 2026 at 8:00 AM CST')
    expect(whenOf({ publishedAt: head.publishedAt, zone: 'Nowhere/Land' })).toContain('UTC')
    const mail = drawEdition(content, 'email')
    expect(mail).toContain('Quality &lt;team&gt;</p>')
    expect(mail).toContain('Edition 3 · Thursday, November 19, 2026 at 8:00 AM CST')
  })

  it('lays a mail\'s tiles in equal rows, draws a trend over a range that shows its move, and no bar for nothing', () => {
    const mail = drawEdition(content, 'email')
    // Five tiles: three and two, the short row filled out.
    const tiles = mail.slice(mail.indexOf('table-layout:fixed;width:100%'), mail.indexOf('</table>', mail.indexOf('table-layout:fixed;width:100%')))
    expect(tiles.split('<tr>').length - 1).toBe(2)
    expect(tiles).toContain('<td></td>')
    // 84 to 100 is drawn from a little under 84, and says so.
    expect(mail).toContain('Columns start at 78.67.')
    expect(mail).toContain('height="72"')
    // The lost bars: api lost none, and draws none.
    expect(mail).toContain('<td width="100%" style="padding:2px 0"></td>')
  })
})

describe('a report as a letter', () => {
  const head = { title: 'Weekly', number: 3, publishedAt: '2026-11-19T14:00:00Z', zone: 'America/Chicago' }
  const text = '---\nwriter: w\ncovers: 30\ndata:\n  p: { tool: t }\n---\n```narrative\ndata: p\ninstruction: Say it.\n```\n```scorecard\ndata: p\nlabel: name\ncolumns: [passed, rate]\nhealth:\n  pct: { good: 80, bad: 50 }\ntrend: { columns: [w1, w2], good: 80, bad: 50 }\n```\n```narrative\nrest: true\n```\n[Open the dashboard](https://hub.example.org/q)\n\nSee [the board](https://hub.example.org/b) <b>now</b>.'
  const rows = tableOf(JSON.stringify({ columns: ['name', { id: 'passed', title: 'Releases passed' }, { id: 'rate', title: 'Tests passing', unit: '%', decimals: 1 }, 'pct', 'w1', 'w2'], rows: [['ui', '0 of 8', 35.1, 0, 0, 0], ['api', '7 of 7', 100, 100, 100, null]] }))
  const read = parseLayout(text)
  const content = buildContent(read.layout!, { p: rows }, new Map([[0, { text: 'Worse this week.\n\n## Lost nights\n\nEight were lost.' }]]), null, head)

  it('reads a tool\'s own column titles, units, and places, and says each number so', () => {
    expect(rows.columns[2]).toEqual({ id: 'rate', title: 'Tests passing', unit: '%', decimals: 1 })
    expect(cellOf(100, rows.columns[2])).toBe('100.0%')
    expect(cellOf(35.123, rows.columns[0])).toBe('35.12')
    const card = content.blocks[1]!
    expect(card.kind === 'scorecard' && [card.columns, card.rows[0]!.cells.map((c) => c.text)]).toEqual([['Releases passed', 'Tests passing'], ['0 of 8', '35.1%']])
  })

  it('marks a scorecard row by a column it judges and does not show', () => {
    const card = content.blocks[1]!
    expect(card.kind === 'scorecard' && card.rows.map((r) => [r.tone, r.cells.some((c) => c.tone)])).toEqual([['bad', false], ['good', false]])
    const none = buildContent(parseLayout(text.replace('pct:', 'nope:')).layout!, { p: rows }, new Map(), null, head).blocks[1]!
    expect(none.kind === 'scorecard' && none.gap).toBe('no column "nope"')
  })

  it('stands a narrative\'s first paragraph as the lead where a block goes on from it', () => {
    expect(leadOf('One.\n\nTwo.\n\nThree.')).toEqual({ lead: 'One.', rest: 'Two.\n\nThree.' })
    expect([content.blocks[0], content.blocks[2]]).toEqual([{ kind: 'narrative', text: 'Worse this week.', lead: true }, { kind: 'narrative', text: '## Lost nights\n\nEight were lost.' }])
    expect(draftOf(parseLayout(printLayout(draftOf(read.layout!))).layout!)).toEqual(draftOf(read.layout!))
    expect(parseLayout('---\nwriter: w\ndata:\n  p: { tool: t }\n---\n```narrative\nrest: true\n```\n```table\ndata: p\n```').issues.map((i) => i.message)).toEqual(['narrative block: rest goes on from the narrative block before it, and only one may'])
    const unwritten = buildContent(read.layout!, { p: rows }, new Map([[0, { gap: 'the writer failed' }]]), null, head)
    expect([unwritten.blocks[0], unwritten.blocks[2]]).toEqual([{ kind: 'narrative', text: null, gap: 'the writer failed' }, { kind: 'narrative', text: '' }])
  })

  it('says the days it covers, in its own zone, and refuses a count that is none', () => {
    expect(coversOf(content)).toBe('October 21 to November 19, 2026')
    expect(coversOf({ ...head, covers: 400 })).toBe('October 16, 2025 to November 19, 2026')
    expect(coversOf(head)).toBe('')
    expect(parseLayout(text.replace('covers: 30', 'covers: 0')).issues[0]!.message).toMatch(/^covers is how many days/)
  })

  it('draws the lead apart, a zero as a line on the floor, and a layout\'s lone link as a button', () => {
    const mail = drawEdition(content, 'email')
    expect(mail).toContain('October 21 to November 19, 2026')
    expect(mail).toMatch(/bgcolor="#fff8e1"[^>]*>.*Worse this week\./)
    // Both of ui's weeks are zero and judged bad: two red lines; api's unread week draws nothing.
    expect(mail.match(/height="2" bgcolor="#cf222e"/g)).toHaveLength(2)
    expect(mail).toMatch(/<a href="https:\/\/hub\.example\.org\/q" style="display:inline-block[^"]*">Open the dashboard<\/a>/)
    expect(mail).toContain('<a href="https://hub.example.org/b" style="color:#0969da">the board</a> &lt;b&gt;now&lt;/b&gt;.')
    const web = drawEdition(content, 'web')
    expect(web).toContain('class="rp-prose rp-lead"')
    expect(web).toContain('<a href="https://hub.example.org/q" class="btn btn-solid">Open the dashboard</a>')
  })
})

describe('a data set names its query or tool as written', () => {
  it('keeps an id YAML would read as a number', () => {
    const { layout, issues } = parseLayout('---\nwriter: 0042\ndata:\n  big: { query: 5e3412 }\n  zero: { query: 012345678901 }\n  tool: { tool: 1e5, entity: repo:007 }\n---\n```table\ndata: big\n```\n')
    expect(issues).toEqual([])
    expect(layout!.writer).toBe('0042')
    expect(layout!.data).toEqual({ big: { query: '5e3412' }, zero: { query: '012345678901' }, tool: { tool: '1e5', entity: 'repo:007' } })
  })
})
