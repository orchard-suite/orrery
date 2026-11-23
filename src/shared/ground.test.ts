import { describe, expect, it } from 'vitest'
import { bucketOf, buildGround, coverOf, foundationsOf, groundFields, guardsOf, lensOf, lensState, lensTrend, linksOf, peersOf, type GroundItem, type GroundMeasure } from './ground.ts'
import type { Blueprint, Entity } from './model.ts'

const NOW = Date.parse('2026-06-01T00:00:00Z')
const DAY = 86_400_000
const ago = (days: number) => new Date(NOW - days * DAY).toISOString()
const ahead = (days: number) => new Date(NOW + days * DAY).toISOString()

const repo: Blueprint = {
  id: 'repository',
  title: 'Repository',
  origin: { kind: 'ui' },
  updatedAt: ago(0),
  ground: {
    loop: 'pipeline_minutes',
    friction: 'stuck_per_week',
    unwanted: 'lint_suppressions',
    activity: 'deploys',
    foundations: ['runtime', 'base_image'],
    guards: ['branch_protected'],
    taughtBy: 'copied_from',
    template: { relation: 'template', version: 'template_version', current: 'version' },
    trial: 'trial',
    ahead: ['waiver_ends'],
    trends: { pipeline_minutes: 'pipeline_past' },
  },
  fields: {
    pipeline_minutes: { type: 'number', title: 'Pipeline minutes', budget: { max: 10 } },
    stuck_per_week: { type: 'number', title: 'Times stuck a week' },
    lint_suppressions: { type: 'number', title: 'Lint suppressions', budget: { max: 20 } },
    coverage: { type: 'number', title: 'Coverage', budget: { min: 60 } },
    deploys: { type: 'number' },
    runtime: { type: 'string', title: 'Runtime' },
    base_image: { type: 'string', title: 'Base image' },
    branch_protected: { type: 'boolean', title: 'Protected branch' },
    trial: { type: 'boolean' },
    template_version: { type: 'string' },
    waiver_ends: { type: 'datetime', title: 'Waiver ends' },
    pipeline_past: { type: 'trend' },
  },
  relations: { copied_from: { target: 'repository', many: true }, template: { target: 'template' } },
}

const entity = (key: string, fields: Record<string, unknown>, relations: Entity['relations'] = {}, level: Entity['status']['level'] = 'green'): Entity => ({
  blueprint: 'repository',
  key,
  id: `repository:${key}`,
  title: key,
  icon: null,
  state: 'active',
  hidden: false,
  fields,
  relations,
  owner: 'test',
  scope: null,
  createdAt: ago(100),
  updatedAt: ago(1),
  lastSeenAt: null,
  missingSince: null,
  deletedAt: null,
  status: { level, reasons: level === 'red' ? ['its pipeline is failing'] : [] },
})

const past = (...values: [number, number][]) => ({ points: values.map(([days, value]) => ({ at: ago(days), value })) })
const starter = { blueprint: 'template', key: 'service-starter', title: 'Service starter' }
const currents = new Map([['template:service-starter', '3']])
const build = (entities: Entity[], bp: Blueprint = repo) => buildGround(bp, entities, { now: NOW, currents })

describe('the numbers a ground reads', () => {
  it('are the three it names, then every other number with a budget, each with where its past is kept', () => {
    expect(groundFields(repo).map((f) => [f.field, f.role, f.trend])).toEqual([
      ['pipeline_minutes', 'loop', 'pipeline_past'],
      ['stuck_per_week', 'friction', null],
      ['lint_suppressions', 'unwanted', null],
      ['coverage', null, null],
    ])
  })

  it('leave out a name whose field is gone or is not a number, and find a trend that reads the number’s history', () => {
    const bp: Blueprint = { ...repo, ground: { loop: 'gone', friction: 'runtime', unwanted: 'lint_suppressions' }, fields: { ...repo.fields, lint_past: { type: 'trend', history: { of: 'lint_suppressions', every: '1d', last: '90d' } } } }
    expect(groundFields(bp).map((f) => [f.field, f.trend])).toEqual([['lint_suppressions', 'lint_past'], ['pipeline_minutes', null], ['coverage', null]])
  })
})

describe('how much of something there is', () => {
  it('is read against an upper budget when there is one, else against the most anything has', () => {
    expect([0, 4, 8, 12].map((v) => bucketOf(v, { max: 10 }, 100))).toEqual([0, 1, 2, 3])
    expect([0, 2, 5, 9].map((v) => bucketOf(v, null, 9))).toEqual([0, 1, 2, 3])
    expect(bucketOf(1, { max: 0 }, 1)).toBe(3)
    expect(bucketOf(null, null, 9)).toBe(0)
  })
})

describe('a ground', () => {
  const entities = [
    entity('calm', { pipeline_minutes: 6, stuck_per_week: 0, lint_suppressions: 2, coverage: 80, deploys: 30, template_version: '3', trial: true }, { template: [starter] }),
    entity('slow', { pipeline_minutes: 19, stuck_per_week: 4, lint_suppressions: 31, coverage: 40, deploys: 3, template_version: '2', pipeline_past: past([21, 12], [14, 14], [8, 15], [2, 18]) }, { template: [starter], copied_from: [{ blueprint: 'repository', key: 'calm', title: 'calm' }] }, 'red'),
    entity('copy', { lint_suppressions: 25 }, { copied_from: [{ blueprint: 'repository', key: 'calm', title: 'calm' }] }),
    entity('bare', {}),
  ]
  const ground = build(entities)

  it('puts the worst first and says which numbers are over their budget', () => {
    expect(ground.items.map((i) => i.key)).toEqual(['slow', 'copy', 'bare', 'calm'])
    const slow = ground.items[0]!
    expect(slow.over).toBe(3)
    expect(slow.inside).toBe(false)
    expect(slow.measures.map((m) => [m.field, m.over, m.bucket])).toEqual([['pipeline_minutes', true, 3], ['stuck_per_week', false, 3], ['lint_suppressions', true, 3], ['coverage', true, 2]])
    expect(slow.why).toEqual(['Pipeline minutes is 19, over its budget of 10', 'Pipeline minutes up 4 this week', 'Lint suppressions is 31, over its budget of 20', 'Coverage is 40, under its budget of 60'])
  })

  it('counts an entity inside only when it holds a budgeted number and none is over', () => {
    expect(ground.items.map((i) => [i.key, i.inside])).toEqual([['slow', false], ['copy', false], ['bare', null], ['calm', true]])
    expect(ground.cover).toEqual({ items: 4, measured: 3, inside: 1, share: 1 / 3 })
    expect(coverOf([])).toEqual({ items: 0, measured: 0, inside: 0, share: null })
  })

  it('reads how much it is used, where changes land first, and the template it started from', () => {
    const calm = ground.items.find((i) => i.key === 'calm')!
    expect(calm).toMatchObject({ activity: 30, activityBucket: 3, trial: true, template: { key: 'service-starter', version: '3', current: '3', behind: false } })
    expect(ground.items[0]).toMatchObject({ activityBucket: 1, trial: false, template: { version: '2', current: '3', behind: true } })
    expect(ground.templates).toEqual([{ blueprint: 'template', key: 'service-starter', title: 'Service starter', current: '3', planted: 2, behind: 1 }])
  })

  it('names where to go first: what got worse this week, then what is furthest over', () => {
    expect(ground.rounds.map((r) => r.key)).toEqual(['slow', 'copy'])
    expect(ground.rounds[0]!.why).toContain('Status is red: its pipeline is failing')
  })

  it('names the entities that copied from the same place', () => {
    const slow = ground.items[0]!
    expect(peersOf(ground.items, slow.taughtBy[0]!, 'slow')).toEqual([{ key: 'copy', title: 'copy', level: 'green', unwanted: 25 }])
  })

  it('says what an entity is built on and which limits hold', () => {
    const e = entity('built', { runtime: 'node 24', branch_protected: false })
    expect(foundationsOf(repo, e)).toEqual([{ field: 'runtime', title: 'Runtime', value: 'node 24' }, { field: 'base_image', title: 'Base image', value: null }])
    expect(guardsOf(repo, e)).toEqual([{ field: 'branch_protected', title: 'Protected branch', on: false }])
    expect(guardsOf(repo, entity('unknown', {}))[0]!.on).toBeNull()
  })

  it('leaves out a template the reader may not see, which the view never sends', () => {
    const hidden = build([entity('veiled', { lint_suppressions: 1 }, {})])
    expect(hidden.items[0]!.template).toBeNull()
    expect(hidden.templates).toEqual([])
  })
})

describe('the forecast', () => {
  it('says when a number still inside its budget leaves it, from the line through its last four weeks', () => {
    const rising = entity('rising', { pipeline_minutes: 8, pipeline_past: past([21, 5], [14, 6], [7, 7]) })
    const flat = entity('flat', { pipeline_minutes: 8, pipeline_past: past([21, 8], [14, 8], [7, 8]) })
    const over = entity('over', { pipeline_minutes: 12, pipeline_past: past([21, 5], [14, 8], [7, 10]) })
    const short = entity('short', { pipeline_minutes: 8, pipeline_past: past([7, 7]) })
    const { crossings } = build([rising, flat, over, short]).forecast
    expect(crossings).toEqual([{ key: 'rising', title: 'rising', field: 'pipeline_minutes', measure: 'Pipeline minutes', value: 8, limit: 10, days: 14 }])
  })

  it('reads the dates that fall due in the next two weeks, by day', () => {
    const { ahead: due } = build([entity('a', { waiver_ends: ahead(3) }), entity('b', { waiver_ends: ahead(3) }), entity('late', { waiver_ends: ahead(40) }), entity('gone', { waiver_ends: ago(2) })]).forecast
    expect(due).toEqual([{ day: ahead(3).slice(0, 10), field: 'waiver_ends', title: 'Waiver ends', items: [{ key: 'a', title: 'a' }, { key: 'b', title: 'b' }] }])
  })

  it('names the budgeted numbers whose past is not kept', () => {
    expect(build([]).forecast.without).toEqual(['Lint suppressions', 'Coverage'])
  })
})

describe('the seasons', () => {
  it('are the share inside budget at the end of each week, from the pasts kept', () => {
    const bp: Blueprint = { ...repo, fields: { pipeline_minutes: repo.fields.pipeline_minutes!, pipeline_past: { type: 'trend' } }, ground: { loop: 'pipeline_minutes', trends: { pipeline_minutes: 'pipeline_past' } } }
    const seasons = build([entity('mended', { pipeline_minutes: 6, pipeline_past: past([30, 15], [10, 6]) }), entity('steady', { pipeline_minutes: 4, pipeline_past: past([60, 4]) }), entity('new', { pipeline_minutes: 4 })], bp).seasons
    expect(seasons).toHaveLength(12)
    expect(seasons.at(-1)).toEqual({ week: ago(0).slice(0, 10), measured: 3, inside: 3, share: 1 })
    expect(seasons.at(-3)).toMatchObject({ measured: 2, inside: 1, share: 0.5 })
    expect(seasons[0]).toMatchObject({ measured: 0, share: null })
  })

  it('are empty when no budgeted number keeps a past', () => {
    const bp: Blueprint = { ...repo, ground: { unwanted: 'lint_suppressions' }, fields: { lint_suppressions: repo.fields.lint_suppressions! } }
    expect(build([entity('a', { lint_suppressions: 3 })], bp).seasons).toEqual([])
  })
})

describe('a lens', () => {
  const m = (field: string, value: number | null, max: number | null, week: number | null = null): GroundMeasure => ({ field, title: field, role: null, value, budget: max === null ? null : { max }, over: value !== null && max !== null && value > max, bucket: 0, week })
  const it2 = (key: string, measures: GroundMeasure[]): GroundItem => ({ key, title: key, icon: null, level: 'green', reasons: [], measures, over: measures.filter((x) => x.over).length, inside: null, activity: null, activityBucket: 0, trial: false, template: null, taughtBy: [], actions: [], links: [], worse: 0, why: [] })
  const items = [
    it2('both', [m('prs', 3, 0, 1), m('red', 2, 0, -1), m('speed', 900, null)]),
    it2('prs-only', [m('prs', 9, 0, 0), m('red', 0, 0, -2)]),
    it2('calm', [m('prs', 0, 0, -1), m('red', 0, 0, 0)]),
    it2('blind', [m('prs', null, 0), m('red', 0, 0)]),
    it2('nothing', [m('prs', null, 0), m('red', null, 0)]),
  ]

  it('reads an entity by any budget or by one alone, and no number is never inside', () => {
    expect(items.map((i) => lensState(i, null))).toEqual(['over', 'over', 'inside', 'inside', 'none'])
    expect(items.map((i) => lensState(i, 'prs'))).toEqual(['over', 'over', 'inside', 'none', 'none'])
    expect(items.map((i) => lensState(i, 'red'))).toEqual(['over', 'inside', 'inside', 'inside', 'none'])
    // A number with no budget is not something a lens can ask about.
    expect(items.map((i) => lensState(i, 'speed'))).toEqual(['none', 'none', 'none', 'none', 'none'])
  })

  it('counts each way of standing and walks the ones outside, what got worse first, then the furthest out', () => {
    const any = lensOf(items, null)
    expect([any.over, any.inside, any.none]).toEqual([2, 2, 1])
    expect(any.rounds.map((r) => r.key)).toEqual(['both', 'prs-only'])
    const prs = lensOf(items, 'prs')
    expect([prs.over, prs.inside, prs.none]).toEqual([2, 1, 2])
    expect(prs.rounds.map((r) => [r.key, r.why])).toEqual([
      ['both', ['prs is 3, over its budget of 0']],
      ['prs-only', ['prs is 9, over its budget of 0']],
    ])
    expect(lensOf(items, 'red').rounds.map((r) => r.key)).toEqual(['both'])
  })

  it('says how many came inside and went outside since last week, only of those whose past is kept', () => {
    // On stale PRs: "both" was at 2 and is at 3 (outside both times), "prs-only" did not move, "calm" was at 1 and is at 0.
    expect(lensTrend(items, 'prs')).toEqual({ better: 1, worse: 0, same: 2 })
    // On red pipelines: "prs-only" was at 2 and is at 0: it came inside.
    expect(lensTrend(items, 'red')).toEqual({ better: 1, worse: 0, same: 2 })
    expect(lensTrend([it2('new', [m('prs', 2, 0, 2)])], 'prs')).toEqual({ better: 0, worse: 1, same: 0 })
  })

  it('says nothing of a trend, never "the same", where no past is kept', () => {
    expect(lensTrend([it2('a', [m('prs', 3, 0)]), it2('b', [m('prs', 0, 0)])], 'prs')).toBeNull()
    expect(lensOf([it2('a', [m('prs', 3, 0)])], null).trend).toBeNull()
  })
})

describe('the addresses an entity holds', () => {
  it('are its url fields that hold a web address, by title, and no other field', () => {
    const bp = { id: 'repo', title: 'Repo', fields: { url: { type: 'url', title: 'At the forge' }, docs: { type: 'url' }, notes: { type: 'string' }, odd: { type: 'url' } }, relations: {} } as unknown as Blueprint
    expect(linksOf(bp, { fields: { url: 'https://forge.example.com/acme/repo', docs: '', notes: 'https://example.com', odd: 'javascript:alert(1)' } })).toEqual([{ title: 'At the forge', url: 'https://forge.example.com/acme/repo' }])
    expect(linksOf(undefined, { fields: { url: 'https://example.com' } })).toEqual([])
  })
})
