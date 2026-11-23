import { describe, expect, it } from 'vitest'
import type { LoadColumn, LoadResponse } from './api.ts'
import { budgetFor, budgetState, byFit, bySubject, columnFit, heldTrend, loadSignals, said } from './load-signals.ts'

const empty = (): LoadResponse => ({
  hours: 24,
  since: '2026-11-13T17:00:00.000Z',
  queue: { depth: 0, oldestSeconds: null },
  blueprints: [],
  deriving: [],
  grids: [],
  relinking: [],
  writing: [],
  reading: [],
  routes: [],
  hourly: [],
  columns: [],
  budgets: { changes: {}, calls: {}, entities: {}, reads: {} },
  use: { changes: {}, calls: {} },
})

describe('budgets', () => {
  it('holds a name to its own budget, else the one for everything, but never the hub’s own sources to that one', () => {
    const budgets = { changes: { '*': { warn: 10 }, scanner: { warn: 50 } }, calls: {}, entities: {}, reads: {} }
    expect(budgetFor(budgets, 'changes', 'scanner')).toEqual({ warn: 50 })
    expect(budgetFor(budgets, 'changes', 'k8s')).toEqual({ warn: 10 })
    expect(budgetFor(budgets, 'changes', 'hub')).toBeUndefined()
    expect(budgetFor(budgets, 'calls', 'anyone')).toBeUndefined()
  })

  it('says a number is near its budget from four fifths of the first threshold', () => {
    expect(budgetState(79, { warn: 100, limit: 500 })).toBe('ok')
    expect(budgetState(80, { warn: 100, limit: 500 })).toBe('near')
    expect(budgetState(100, { warn: 100, limit: 500 })).toBe('warn')
    expect(budgetState(500, { warn: 100, limit: 500 })).toBe('limit')
    expect(budgetState(400, { limit: 500 })).toBe('near')
  })
})

describe('load signals', () => {
  it('raises a source past its warning with what it costs and what to do', () => {
    const load = empty()
    load.budgets.changes['*'] = { warn: 2500, limit: 20000 }
    load.writing = [{ source: 'scanner', batches: 600, received: 120000, changed: 4000, sighted: 0, ms: 40_000 }]
    load.use.changes.scanner = { now: 6, peak: 2600 }
    const [signal] = loadSignals(load)
    expect(signal).toMatchObject({ level: 'warn', area: 'in', subject: { kind: 'source', id: 'scanner' }, value: 2600, budget: { kind: 'changes', held: { warn: 2500, limit: 20000 } } })
    expect(signal!.seen).toBe('scanner changed 2,600 entities in its fullest hour.')
    expect(signal!.fixes.length).toBeGreaterThan(1)
  })

  it('raises a blueprint whose rows read near their budget, by the name a person reads', () => {
    const load = empty()
    load.budgets.reads['*'] = { warn: 200 }
    load.blueprints = [{ id: 'team', entities: 21, reads: 170.4 }, { id: 'pod', entities: 192, reads: 5 }]
    const signals = loadSignals(load, (id) => (id === 'team' ? 'Team' : id))
    expect(signals).toHaveLength(1)
    expect(signals[0]).toMatchObject({ level: 'near', title: 'Reads per row', seen: 'One Team reads 170.4 entities on average.' })
  })

  it('marks what no budget counts: unchanged sends, heavy answers, slow routes, fan-out, costly rows, rebuilt grids, and a backlog', () => {
    const load = empty()
    load.writing = [
      { source: 'k8s', batches: 5800, received: 960000, changed: 7000, sighted: 0, ms: 510_000 },
      { source: 'tally', batches: 100, received: 4000, changed: 4000, sighted: 0, ms: 9_000 },
    ]
    load.reading = [{ caller: 'scanner read', calls: 1800, bytes: 1_400_000_000, ms: 290_000 }]
    load.routes = [{ caller: 'someone', route: 'PUT /v1/blueprints/:id', calls: 200, bytes: 1000, ms: 2_400_000 }]
    load.deriving = [
      { blueprint: 'repo', derived: 9600, changed: 480, cascaded: 2100, ms: 86_000 },
      { blueprint: 'image_repo', derived: 2100, changed: 300, cascaded: 0, ms: 105_000 },
    ]
    load.grids = [{ blueprint: 'kiosk', builds: 190, rows: 840_000, ms: 218_000, spreadMs: 150_000, spreadColumns: 9 }]
    load.queue = { depth: 4000, oldestSeconds: 30 }
    const titles = loadSignals(load).map((s) => `${s.subject.id}: ${s.title}`)
    expect(titles).toEqual(
      expect.arrayContaining([
        'k8s: Sends what did not change',
        'tally: Changes all it sends',
        'scanner read: Heavy answers',
        'someone: Slow calls to PUT /v1/blueprints/:id',
        'repo: Readers per change',
        'image_repo: Costly rows',
        'kiosk: Grid built again often',
        'derive: Derive backlog',
      ]),
    )
    expect(titles[0]).toBe('derive: Derive backlog')
  })

  it('says nothing of a quiet hub', () => {
    const load = empty()
    load.budgets.changes['*'] = { warn: 2500 }
    load.writing = [{ source: 'k8s', batches: 10, received: 100, changed: 5, sighted: 0, ms: 1_000 }]
    load.use.changes.k8s = { now: 1, peak: 5 }
    expect(loadSignals(load)).toEqual([])
  })

  it('gathers a subject’s signals into one row at its worst level, worst rows first', () => {
    const load = empty()
    load.budgets.calls['*'] = { warn: 100 }
    load.reading = [
      { caller: 'quiet', calls: 10, bytes: 300 * 1024 ** 2, ms: 9_000 },
      { caller: 'busy', calls: 500, bytes: 500 * 1024 ** 2, ms: 1_000 },
    ]
    load.use.calls = { quiet: { now: 0, peak: 10 }, busy: { now: 0, peak: 150 } }
    const groups = bySubject(loadSignals(load))
    expect(groups.map((g) => [g.subject.id, g.level, g.signals.length])).toEqual([
      ['busy', 'warn', 2],
      ['quiet', 'watch', 1],
    ])
  })

  it('says each unit as a person reads it', () => {
    expect(said(0.0072, 'percent')).toBe('0.7%')
    expect(said(790 * 1024, 'bytes')).toBe('790.0 kB')
    expect(said(11_200, 'ms')).toBe('11.2 s')
    expect(said(201.84, 'decimal')).toBe('201.8')
  })
})

describe('column fit', () => {
  const column = (over: Partial<LoadColumn>): LoadColumn => ({ blueprint: 'kiosk', field: 'f', chip: false, spread: false, rows: 8000, values: 8000, different: 1, top: 8000, measuredAt: '2026-11-16T12:00:00.000Z', ...over })

  it('says a count over values that rarely repeat costs more than it shows', () => {
    // A serial a row: the spread's twelve widest buckets hold a dozen rows of eight thousand.
    expect(columnFit(column({ field: 'serial', chip: true, spread: true, different: 7900, top: 40 }))).toBe('costly')
    // A city a few rows: still slivers.
    expect(columnFit(column({ field: 'city', chip: true, spread: true, different: 2900, top: 900 }))).toBe('costly')
    // Fifty states: the widest dozen hold most of the rows.
    expect(columnFit(column({ field: 'state', chip: true, spread: true, different: 50, top: 5200 }))).toBe('fine')
    // Many values, but a few hold most of the rows.
    expect(columnFit(column({ field: 'version', chip: true, spread: true, different: 300, top: 7000 }))).toBe('fine')
    // A chip whose count is off costs nothing to count, however many values it holds.
    expect(columnFit(column({ field: 'version', chip: true, spread: false, different: 8000, top: 40 }))).toBe('fine')
    // Plain text counted on purpose is held to the same.
    expect(columnFit(column({ field: 'serial', spread: true, different: 7900, top: 40 }))).toBe('costly')
  })

  it('says a column not counted whose few values repeat could be, chip or not, and nothing of what is unique or sparse', () => {
    expect(columnFit(column({ field: 'state', different: 50, top: 5200 }))).toBe('candidate')
    // How it looks has no part in it: a chip whose count is off is judged the same as plain text.
    expect(columnFit(column({ field: 'state', chip: true, spread: false, different: 50, top: 5200 }))).toBe('candidate')
    expect(columnFit(column({ field: 'serial', different: 7900, top: 40 }))).toBe('fine')
    // One value everywhere says nothing; a handful of rows is too few to tell.
    expect(columnFit(column({ field: 'client', different: 1 }))).toBe('fine')
    expect(columnFit(column({ field: 'tier', rows: 10, values: 10, different: 2, top: 10 }))).toBe('fine')
    // Rows that hold a value of their own among few that repeat: each value held under five times.
    expect(columnFit(column({ field: 'owner', values: 120, different: 40, top: 60 }))).toBe('fine')
  })

  it('orders costly counts first, then chips waiting, each by how many values they hold', () => {
    const fine = column({ field: 'state', chip: true, spread: true, different: 50, top: 5200 })
    const waiting = column({ field: 'region', different: 4, top: 8000 })
    const costly = column({ field: 'serial', chip: true, spread: true, different: 7900, top: 40 })
    expect(byFit([fine, waiting, costly]).map((c) => c.field)).toEqual(['serial', 'region', 'state'])
  })

  it('raises a costly count on its blueprint, with what it shows and how to stop it', () => {
    const load = empty()
    load.columns = [column({ field: 'serial', chip: true, spread: true, different: 7900, top: 40 }), column({ field: 'state', different: 50, top: 5200 })]
    const signals = loadSignals(load, (id) => (id === 'kiosk' ? 'Comet Kiosk' : id), (_, f) => (f === 'serial' ? 'Serial' : f))
    expect(signals).toHaveLength(1)
    expect(signals[0]).toMatchObject({ level: 'watch', area: 'work', subject: { kind: 'blueprint', id: 'kiosk' }, title: 'Counting Serial shows little', unit: 'percent' })
    expect(signals[0]!.seen).toBe('Serial on Comet Kiosk holds 7,900 different values in 8,000 rows. The spread under the grid draws 0.5% of them; the rest is "other".')
  })
})

describe('what a blueprint holds over time', () => {
  /** `days` of history, each day gaining `came` and losing `left`. */
  const moved = (days: number, came: number, left = 0, expire?: { afterDays: number; ahead: number[] }) => ({ id: 'deploys', came: new Array<number>(days).fill(came), left: new Array<number>(days).fill(left), ...(expire ? { expire } : {}) })

  it('works each day back from now by what came and left since', () => {
    const t = heldTrend(moved(5, 10, 2), 100)
    expect(t.history).toEqual([68, 76, 84, 92, 100])
  })

  it('says nothing ahead from fewer than a week of full days', () => {
    const t = heldTrend(moved(5, 10), 100, { warn: 120 })
    expect(t.perWeek).toBeNull()
    expect(t.forecast).toEqual([])
    expect(t.passes).toEqual({ warn: null, limit: null })
  })

  it('grows a blueprint nothing expires by its net pace, and says when it passes its budget', () => {
    const t = heldTrend(moved(60, 12, 2), 1000, { warn: 1100, limit: 2000 })
    expect(t.perWeek).toBe(70)
    expect(t.forecast[29]).toBe(1300)
    expect(t.levels).toBeNull()
    expect(t.passes).toEqual({ warn: 10, limit: 100 })
  })

  it('levels a blueprint that expires where a day’s arrivals times their life comes to', () => {
    // 100 a day, each living 30 days; what it holds now leaves 100 a day over the next 10.
    const ahead = new Array<number>(365).fill(0)
    for (let d = 1; d <= 10; d++) ahead[d] = 100
    const t = heldTrend(moved(60, 100, 0, { afterDays: 30, ahead }), 1000, { limit: 3000 })
    expect(t.levels).toBe(3000)
    expect(t.forecast[9]).toBe(1000)
    // From day 30 the first of the new arrivals expire as fast as more come.
    expect(t.forecast[29]).toBe(3000)
    expect(t.forecast[200]).toBe(3000)
    expect(t.passes.limit).toBe(30)
  })

  it('says the trend in words, and warns a month before a budget is passed', () => {
    const load = { ...empty(), blueprints: [{ id: 'deploys', entities: 900, reads: 1 }], budgets: { changes: {}, calls: {}, entities: { '*': { warn: 1200, limit: 5000 } }, reads: {} }, held: { today: 20000, blueprints: [moved(60, 12)] } }
    const [s] = loadSignals(load)
    expect(s).toMatchObject({ level: 'near', title: 'Entities held in a month', subject: { kind: 'blueprint', id: 'deploys' } })
    expect(s!.trend?.passes.warn).toBe(25)
    expect(s!.seen).toContain('It gained 84 a week over the last four weeks.')
    expect(s!.seen).toContain('holds about 1,260 in a month')
    expect(s!.seen).toContain('Nothing expires it, so it keeps growing.')
    expect(loadSignals({ ...load, held: { today: 20000, blueprints: [moved(60, 1)] } })).toEqual([])
  })
})
