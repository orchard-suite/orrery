import { describe, expect, it } from 'vitest'
import { brokenOn, buildMap, byPlace, checksOf, climbsOf, fixesOf, fronts, growthOf, inBloom, mendedBy, standingOf, tally, tendFirst, worse, type MapCheck, type MapInput, type MapLadder } from './map.ts'
import type { Blueprint, Entity, MapDef, RelatedRef, StatusLevel } from './model.ts'

const at = '2026-06-01T00:00:00Z'

const ref = (blueprint: string, key: string): RelatedRef[] => [{ blueprint, key, title: key }]

const entity = (blueprint: string, key: string, fields: Record<string, unknown> = {}, relations: Entity['relations'] = {}, level: StatusLevel = 'green'): Entity => ({
  blueprint,
  key,
  id: `${blueprint}:${key}`,
  title: key,
  icon: null,
  state: 'active',
  hidden: false,
  fields,
  relations,
  owner: 'test',
  scope: null,
  createdAt: at,
  updatedAt: at,
  lastSeenAt: null,
  missingSince: null,
  deletedAt: null,
  status: { level, reasons: [] },
})

const blueprint = (id: string, extra: Partial<Blueprint> = {}): Blueprint => ({ id, title: id, origin: { kind: 'ui' }, updatedAt: at, fields: {}, relations: {}, ...extra })

const service = blueprint('service', {
  ground: { guards: ['has_tests'] },
  fields: { has_tests: { type: 'boolean', title: 'Has tests' }, open_bugs: { type: 'number', title: 'Open bugs', budget: { max: 5 } } },
})

const def: MapDef = {
  parts: 'parent',
  places: 'environment',
  plots: { blueprint: 'service', holder: 'program', placedBy: { blueprint: 'running', plot: 'service', place: 'environment' } },
  members: [
    { blueprint: 'app', holder: 'program', place: 'environment', plot: 'service' },
    { blueprint: 'database', holder: 'program', place: 'environment' },
  ],
}

const scorecard = {
  id: 'accountable',
  title: 'Accountable',
  blueprints: { database: { rules: { Bronze: [{ id: 'tagged', title: 'Carries a pid', where: { field: 'pid', op: 'exists' as const } }, { id: 'in_program', title: 'Belongs to a program', where: { relation: 'program' } }] } } },
  levels: [{ name: 'Bronze', rules: [] }],
}

function input(): MapInput {
  return {
    def,
    holder: entity('program', 'comet'),
    parts: [entity('program', 'comet-cms', {}, { parent: ref('program', 'comet') })],
    places: [entity('environment', 'Prod'), entity('environment', 'Test'), entity('environment', 'Dev')],
    plots: [
      { ...entity('service', 'players', { has_tests: true, open_bugs: 9 }, { program: ref('program', 'comet') }), actions: ['redeploy'] },
      entity('service', 'content', { has_tests: false }, { program: ref('program', 'comet-cms') }),
      entity('service', 'library', {}, { program: ref('program', 'comet') }),
    ],
    placers: [
      entity('running', 'players@Prod', {}, { service: ref('service', 'players'), environment: ref('environment', 'Prod') }, 'red'),
      entity('running', 'players@Test', {}, { service: ref('service', 'players'), environment: ref('environment', 'Test') }),
      entity('running', 'content@Prod', {}, { service: ref('service', 'content'), environment: ref('environment', 'Prod') }),
    ],
    members: [
      { spec: def.members![0]!, entities: [entity('app', 'players-prod', {}, { program: ref('program', 'comet'), environment: ref('environment', 'Prod'), service: ref('service', 'players') })] },
      {
        spec: def.members![1]!,
        entities: [
          entity('database', 'orders-prod', { pid: '803' }, { program: ref('program', 'comet'), environment: ref('environment', 'Prod') }),
          entity('database', 'orders-test', {}, { program: ref('program', 'comet'), environment: ref('environment', 'Test') }, 'amber'),
        ],
      },
    ],
    blueprints: new Map([['service', service]]),
    scorecards: [scorecard],
    truncated: [],
  }
}

describe('checksOf', () => {
  it('puts scorecard rules, budgets, and guards in one shape', () => {
    const checks = checksOf(entity('service', 's', { has_tests: false, open_bugs: 2 }), service, [])
    expect(checks).toEqual([
      { kind: 'budget', id: 'open_bugs', title: 'Open bugs', of: null, state: 'pass', ladder: 'budget:open_bugs', rung: 0 },
      { kind: 'guard', id: 'has_tests', title: 'Has tests', of: null, state: 'fail', ladder: 'guard:has_tests', rung: 0 },
    ])
  })

  it('says no data, never zero or a fail, where a check reads nothing that has a value', () => {
    const checks = checksOf(entity('service', 's'), service, [])
    expect(checks.map((c) => c.state)).toEqual(['unknown', 'unknown'])
  })

  it('fails a scorecard rule on a relation that is missing, and has no data for a field rule with nothing to read', () => {
    const checks = checksOf(entity('database', 'd'), undefined, [scorecard])
    expect(checks.map((c) => [c.id, c.of, c.state, c.ladder, c.rung])).toEqual([
      ['tagged', 'Accountable, Bronze', 'unknown', 'accountable', 0],
      ['in_program', 'Accountable, Bronze', 'fail', 'accountable', 0],
    ])
  })
})

describe('a scorecard whose rules another judge decided', () => {
  const judged = {
    id: 'recoverable',
    title: 'Recoverable',
    levels: [{ name: 'Bronze', rules: [] }],
    blueprints: {
      database: {
        rules: {
          Bronze: [
            { id: 'backed_up', title: 'Has a backup', where: { field: 'said', op: 'exists' as const }, judged: { field: 'said', check: 'db.backed-up' } },
            { id: 'tagged', title: 'Has a criticality', where: { field: 'said', op: 'exists' as const }, judged: { field: 'said', check: 'tagged' } },
            { id: 'geo', title: 'Kept in two regions', where: { field: 'said', op: 'exists' as const }, judged: { field: 'said', check: 'geo' } },
          ],
        },
      },
    },
  }

  it('checks each rule as the judge said it, and leaves out one that does not apply', () => {
    const checks = checksOf(entity('database', 'd', { said: { 'db.backed-up': 'fail', tagged: 'unknown' } }), undefined, [judged])
    expect(checks.map((c) => [c.id, c.state])).toEqual([
      ['backed_up', 'fail'],
      ['tagged', 'unknown'],
    ])
  })
})

describe('a scorecard that copies a verdict, with its reasons', () => {
  // A tier copied from another judge: three levels, each one rule on the tier's rank.
  const tier = (n: number) => ({ field: 'tier', op: 'gte' as const, value: n })
  const copied = {
    id: 'accountable',
    title: 'Accountable',
    blueprint: 'database',
    levels: [
      { name: 'Bronze', rules: [{ id: 'bronze', title: 'Judged Bronze or better', where: tier(1) }] },
      { name: 'Silver', rules: [{ id: 'silver', title: 'Judged Silver or better', where: tier(2) }] },
      { name: 'Gold', rules: [{ id: 'gold', title: 'Judged Gold', where: tier(3) }] },
    ],
    reasons: { from: 'finding', where: { field: 'pack', op: 'eq' as const, value: 'accountable' }, level: 'tier', says: 'detail', fix: 'fix', link: 'board' },
  }
  const db = (rank: number) => entity('database', 'd', { tier: rank })
  const finding = (key: string, level: string, detail: string, pack = 'accountable') =>
    entity('finding', key, { pack, tier: level, detail, fix: `Fix ${detail}`, board: `https://judge.example.org/${key}` }, { database: ref('database', 'd') })
  const about = (...records: Entity[]) => new Map([['database:d', records]])

  it('counts one missing thing once, at the level it holds the thing below, with what to do', () => {
    const checks = checksOf(db(1), undefined, [copied], about(finding('f1', 'silver', 'no ManagedBy tag')))
    expect(checks.map((c) => [c.title, c.level, c.state])).toEqual([
      ['Judged Bronze or better', 'Bronze', 'pass'],
      ['no ManagedBy tag', 'Silver', 'fail'],
    ])
    expect(checks[1]).toMatchObject({ fix: 'Fix no ManagedBy tag', link: 'https://judge.example.org/f1' })
  })

  it('adds a gap for each record at a level, and one at a higher level too', () => {
    const checks = checksOf(db(1), undefined, [copied], about(finding('f1', 'silver', 'no ManagedBy tag'), finding('f2', 'silver', 'no Environment tag'), finding('f3', 'gold', 'no alerts')))
    expect(checks.filter((c) => c.state === 'fail').map((c) => [c.title, c.level])).toEqual([
      ['no ManagedBy tag', 'Silver'],
      ['no Environment tag', 'Silver'],
      ['no alerts', 'Gold'],
    ])
  })

  it('keeps the rule, said to have no reason, where no record the reader may see explains it', () => {
    const checks = checksOf(db(1), undefined, [copied], about(finding('f9', 'silver', 'another pack', 'secure')))
    expect(checks.filter((c) => c.state === 'fail').map((c) => [c.title, c.unexplained])).toEqual([['Judged Silver or better', true]])
    expect(checksOf(db(1), undefined, [copied]).filter((c) => c.state === 'fail').map((c) => c.id)).toEqual(['silver'])
  })

  it('leaves its rules as they are where it holds, or has no data', () => {
    expect(checksOf(db(3), undefined, [copied], about()).map((c) => c.state)).toEqual(['pass', 'pass', 'pass'])
    expect(checksOf(entity('database', 'd'), undefined, [copied], about()).map((c) => c.state)).toEqual(['unknown', 'unknown', 'unknown'])
  })

  it('counts a record naming no level at the first level that falls short', () => {
    const checks = checksOf(db(0), undefined, [copied], about(finding('f1', 'platinum', 'odd tier')))
    expect(checks.filter((c) => c.state === 'fail').map((c) => [c.title, c.level])).toEqual([['odd tier', 'Bronze']])
  })

  it('puts each gap on its scorecard\'s ladder at its level\'s rung, and ranks the fixes across things', () => {
    const one = { blueprint: 'database', key: 'd', title: 'd', icon: null, level: 'red' as const, reasons: [], part: 'comet', failing: 1, unknown: 0, actions: [], links: [], checks: checksOf(db(1), undefined, [copied], about(finding('f1', 'silver', 'no ManagedBy tag'))) }
    expect(one.checks.find((c) => c.state === 'fail')).toMatchObject({ ladder: 'accountable', rung: 1 })
    const other = { ...one, key: 'e' }
    expect(fixesOf([one, other]).map((f) => [f.title, f.things.length])).toEqual([['no ManagedBy tag', 2]])
    expect(fixesOf([one, other], 'secure')).toEqual([])
  })

  it('gives the same gap on two things one id, so they count as one check', () => {
    const a = checksOf(db(1), undefined, [copied], about(finding('f1', 'silver', 'no ManagedBy tag')))
    const other = checksOf(entity('database', 'e', { tier: 1 }), undefined, [copied], new Map([['database:e', [entity('finding', 'f2', { pack: 'accountable', tier: 'silver', detail: 'no ManagedBy tag' }, { database: ref('database', 'e') })]]]))
    expect(a.find((c) => c.state === 'fail')!.id).toBe(other.find((c) => c.state === 'fail')!.id)
  })
})

describe('buildMap', () => {
  const map = buildMap(input())

  it('reads the holder and its parts as one map, each thing under the one it belongs to', () => {
    expect(map.holder.key).toBe('comet')
    expect(map.parts.map((p) => p.key)).toEqual(['comet-cms'])
    expect(map.plots.find((p) => p.key === 'content')!.part).toBe('comet-cms')
    expect(map.plots.find((p) => p.key === 'players')!.part).toBe('comet')
  })

  it('places a plot wherever something places it, worst first, and leaves an unplaced one with nowhere', () => {
    const players = map.plots.find((p) => p.key === 'players')!
    expect(players.at.map((a) => [a.place, a.level])).toEqual([
      ['Prod', 'red'],
      ['Test', 'green'],
    ])
    expect(map.plots.find((p) => p.key === 'library')!.at).toEqual([])
    expect(map.counts).toMatchObject({ plots: 3, placed: 2, members: 3, open: 2 })
  })

  it('lists only the places something is in, the busiest first', () => {
    expect(map.places.map((p) => [p.key, p.plots, p.members, p.open])).toEqual([
      ['Prod', 2, 2, 1],
      ['Test', 1, 1, 1],
    ])
    expect(map.places[0]!.level).toBe('red')
    expect(map.places[1]!.level).toBe('amber')
  })

  it('keeps a member in its plot when it names one, and open on its place when it does not', () => {
    const app = map.members.find((m) => m.key === 'players-prod')!
    expect([app.place, app.plot]).toEqual(['Prod', 'players'])
    const db = map.members.find((m) => m.key === 'orders-test')!
    expect([db.place, db.plot]).toEqual(['Test', null])
  })

  it('names every ladder its checks climb: the scorecards first, then the budgets, then the guards', () => {
    expect(map.ladders).toEqual([
      { id: 'accountable', title: 'Accountable', rungs: ['Bronze'] },
      { id: 'budget:open_bugs', title: 'Open bugs', rungs: ['Open bugs'] },
      { id: 'guard:has_tests', title: 'Has tests', rungs: ['Has tests'] },
    ])
  })

  it('counts a fail and a no-data apart', () => {
    const players = map.plots.find((p) => p.key === 'players')!
    expect([players.failing, players.unknown]).toEqual([1, 0])
    const db = map.members.find((m) => m.key === 'orders-test')!
    expect([db.failing, db.unknown]).toEqual([0, 1])
    expect(map.counts.unknown).toBeGreaterThan(0)
  })
})

describe('the order', () => {
  it('puts the most broken first among things at the same status', () => {
    const map = buildMap(input())
    expect(map.plots.map((p) => p.key)).toEqual(['content', 'players', 'library'])
  })
})

describe('worse', () => {
  it('reads grey as no data, beaten by anything known', () => {
    expect(worse('grey', 'green')).toBe('green')
    expect(worse('amber', 'red')).toBe('red')
    expect(worse('green', 'amber')).toBe('amber')
  })
})

describe('the actions on a thing', () => {
  it('carries what the reader may run on it, and none where nothing was named', () => {
    const map = buildMap(input())
    expect(map.plots.find((p) => p.key === 'players')!.actions).toEqual(['redeploy'])
    expect(map.plots.find((p) => p.key === 'library')!.actions).toEqual([])
  })
})

describe('tally', () => {
  const map = buildMap(input())

  it('counts every check by state, no data apart from a fail', () => {
    expect(tally(map.plots)).toEqual({ pass: 1, fail: 2, unknown: 3 })
  })

  it('counts only one ladder when asked for it', () => {
    expect(tally(map.plots, 'guard:has_tests')).toEqual({ pass: 1, fail: 1, unknown: 1 })
    expect(tally(map.plots, 'nothing:asks')).toEqual({ pass: 0, fail: 0, unknown: 0 })
  })
})

describe('fronts', () => {
  it('ranks each ladder by how often it breaks, by its own title, naming the things it breaks on', () => {
    const map = buildMap(input())
    const all = fronts([...map.plots, ...map.members], map.ladders)
    expect(all.map((f) => [f.ladder, f.title, f.fail, f.unknown, f.pass])).toEqual([
      ['budget:open_bugs', 'Open bugs', 1, 2, 0],
      ['guard:has_tests', 'Has tests', 1, 1, 1],
      ['accountable', 'Accountable', 0, 1, 3],
    ])
    expect(all.find((f) => f.ladder === 'guard:has_tests')!.broken).toEqual(['service:content'])
  })
})

describe('tendFirst', () => {
  const map = buildMap(input())

  it('sums the plot\'s own broken checks once with those of what is planted in it, and leaves out a plot with none', () => {
    const first = tendFirst(map, 5)
    expect(first.map((t) => [t.plot.key, t.fail, t.members.length])).toEqual([
      ['content', 1, 0],
      ['players', 1, 1],
    ])
  })

  it('keeps to the most it is asked for, and to one ladder', () => {
    expect(tendFirst(map, 1).map((t) => t.plot.key)).toEqual(['content'])
    expect(tendFirst(map, 5, 'budget:open_bugs').map((t) => t.plot.key)).toEqual(['players'])
  })
})

describe('byPlace', () => {
  const map = buildMap(input())

  it('counts each check once: the members on each place, and with what is tied to none every plot\'s own checks, so the places add up to the whole map', () => {
    const parts = byPlace(map)
    // The last part is no place: the things on none, and each plot's own checks, which are the plot's wherever it runs.
    expect(parts.map((x) => x.place)).toEqual([...map.places.map((p) => p.key), null])
    const whole = tally([...map.plots, ...map.members])
    for (const state of ['pass', 'fail', 'unknown'] as const) expect(parts.reduce((k, x) => k + x.t[state], 0)).toBe(whole[state])
    const nowhere = parts.at(-1)!.t
    expect(nowhere).toEqual(tally([...map.plots, ...map.members.filter((x) => x.place === null)]))
    // No plot's own check is counted on a place.
    for (const x of parts.slice(0, -1)) expect(x.t).toEqual(tally(map.members.filter((mm) => mm.place === x.place)))
  })

  it('counts one ladder alone when asked for it, and still adds up', () => {
    const ladder = [...map.plots, ...map.members].flatMap((t) => t.checks)[0]!.ladder
    const parts = byPlace(map, ladder)
    const whole = tally([...map.plots, ...map.members], ladder)
    expect(parts.reduce((k, x) => k + x.t.fail + x.t.pass + x.t.unknown, 0)).toBe(whole.fail + whole.pass + whole.unknown)
  })
})

describe('the ladders', () => {
  const secure: MapLadder = { id: 'secure', title: 'Secure', rungs: ['Bronze', 'Silver', 'Gold'] }
  const tested: MapLadder = { id: 'guard:has_tests', title: 'Has tests', rungs: ['Has tests'] }
  const check = (ladder: string, rung: number, state: MapCheck['state']): MapCheck => ({ kind: 'scorecard', id: `${ladder}${rung}`, title: `rung ${rung}`, of: null, state, ladder, rung })
  /** A thing with these states on Secure, Bronze up, and on the guard where given. */
  const thing = (key: string, states: MapCheck['state'][], guard?: MapCheck['state']) => ({ key, checks: [...states.map((st, rung) => check('secure', rung, st)), ...(guard ? [{ ...check('guard:has_tests', 0, guard), kind: 'guard' as const }] : [])] })
  const ladders = [secure, tested]

  it('stands a thing on the highest rung it holds with every rung below, and says what stops it', () => {
    expect(standingOf(thing('a', ['pass', 'fail', 'fail']), secure)).toEqual({ reached: 1, of: 3, stop: 'fail' })
    expect(standingOf(thing('b', ['pass', 'unknown', 'fail']), secure)).toEqual({ reached: 1, of: 3, stop: 'unknown' })
    expect(standingOf(thing('c', ['pass', 'unknown', 'pass']), secure)).toEqual({ reached: 1, of: 3, stop: 'unknown' })
    expect(standingOf(thing('d', ['pass', 'pass', 'pass']), secure)).toEqual({ reached: 3, of: 3, stop: null })
    expect(standingOf(thing('e', ['pass']), tested)).toBeNull()
  })

  it('reads a rung of several rules as broken when one breaks, though another has no data', () => {
    const t = { checks: [check('secure', 0, 'unknown'), check('secure', 0, 'fail')] }
    expect(standingOf(t, secure)).toEqual({ reached: 0, of: 3, stop: 'fail' })
  })

  it('groups the things stopped on one rung into a climb, the one that mends most first, and leaves out what no data stops', () => {
    const things = [thing('a', ['pass', 'fail', 'fail']), thing('b', ['pass', 'fail', 'fail']), thing('c', ['fail', 'fail', 'fail'], 'fail'), thing('d', ['pass', 'unknown', 'pass']), thing('e', ['pass', 'pass', 'pass'], 'pass')]
    const climbs = climbsOf(things, ladders)
    expect(climbs.map((c) => [c.ladder, c.from, c.things.map((t) => t.key), c.mends])).toEqual([
      ['secure', 1, ['a', 'b'], 4],
      ['secure', 0, ['c'], 3],
      ['guard:has_tests', 0, ['c'], 1],
    ])
    expect(brokenOn(things[2]!, 'secure')).toBe(3)
  })

  it('mends what a plan takes to the top, and brings a thing into bloom only when nothing is left short or unknown', () => {
    const a = thing('a', ['pass', 'fail', 'fail'], 'fail')
    const d = thing('d', ['pass', 'unknown', 'fail'])
    const onlySecure = (_t: unknown, ladder: string) => ladder === 'secure'
    expect(mendedBy([a, d], onlySecure)).toBe(3)
    expect(inBloom(a, ladders, onlySecure)).toBe(false)
    expect(inBloom(a, ladders, () => true)).toBe(true)
    // A broken rung above one with no data: the plan mends the break, but the thing waits for its data.
    expect(inBloom(d, ladders, () => true)).toBe(false)
    expect(inBloom({ checks: [] }, ladders)).toBe(false)
  })

  it('grows in stages by the share of checked things in full bloom, and leaves out what nothing checks', () => {
    const full = thing('f', ['pass', 'pass', 'pass'])
    const short = thing('s', ['pass', 'fail', 'fail'])
    expect(growthOf([full, short, { checks: [] }], ladders)).toEqual({ full: 1, checked: 2, stage: 2 })
    expect(growthOf([full, short], ladders, () => true)).toEqual({ full: 2, checked: 2, stage: 4 })
    expect(growthOf([short], ladders)).toEqual({ full: 0, checked: 1, stage: 0 })
  })
})
