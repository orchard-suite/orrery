import { describe, expect, it } from 'vitest'
import type { Scorecard, ScorecardRow } from '../shared/api.ts'
import { advises, groupLifts, lensOf, liftsOf, movement, readingOf, scopeWords, standing, standingByDay, yoursOf } from './scorecards.ts'
import { partsOf } from '../shared/scorecard.ts'

const rule = (id: string) => ({
  id,
  title: id,
  where: { field: id, op: 'exists' as const },
})
const card: Scorecard = {
  id: 'sc',
  title: 'Card',
  blueprints: {
    svc: {
      rules: { Bronze: [rule('readme'), rule('ci')], Silver: [rule('owner')] },
    },
    db: { rules: { Bronze: [rule('backup')] } },
  },
  levels: [
    { name: 'Bronze', rules: [] },
    { name: 'Silver', rules: [] },
  ],
  origin: { kind: 'ui' },
  updatedAt: '',
}
const row = (blueprint: string, level: number, rules: Record<string, boolean | null>): ScorecardRow => ({
  entity: { blueprint, key: `${blueprint}${Math.random()}` },
  title: 't',
  level,
  levelName: '',
  rules,
})

describe('scorecard readings', () => {
  it('counts a rule as lifting a row only when it alone holds the row at the level it stops at', () => {
    const rows = [
      row('svc', -1, { readme: false, ci: true, owner: false }), // readme alone stops it at Bronze
      row('svc', -1, { readme: false, ci: false, owner: true }), // two rules stop it: neither lifts
      row('svc', 0, { readme: true, ci: true, owner: false }), // owner alone stops it at Silver
      row('db', -1, { backup: false }),
    ]
    const by = Object.fromEntries(liftsOf(card, rows).map((l) => [`${l.blueprint}.${l.rule.id}`, [l.scored, l.failing, l.lifts]]))
    expect(by).toEqual({
      'svc.readme': [3, 2, 1],
      'svc.ci': [3, 1, 0],
      'svc.owner': [3, 2, 1],
      'db.backup': [1, 1, 1],
    })
  })

  it('sorts the rules that lift the most first', () => {
    const rows = [row('svc', -1, { readme: false, ci: true, owner: false }), row('svc', -1, { readme: false, ci: true, owner: false }), row('db', -1, { backup: false })]
    expect(liftsOf(card, rows).map((l) => l.rule.id)).toEqual(['readme', 'backup', 'owner', 'ci'])
  })

  it('stands at 0 with nothing reached and 1 with everything at the top, and counts the top a blueprint can reach', () => {
    expect(standing(card, [4, 0, 0])).toBe(0)
    expect(standing(card, [0, 0, 4])).toBe(1)
    expect(standing(card, [0, 2, 2])).toBe(0.75)
    const rows = [row('db', 0, { backup: true }), row('svc', 0, { readme: true, ci: true, owner: false })]
    expect(readingOf({ scorecard: card, rows, counts: [0, 2, 0], outOfScope: 0 }).top).toBe(1)
  })

  it('reads the standing by day and how it moved between the first and last kept day', () => {
    const byDay = standingByDay({
      days: ['a', 'b', 'c', 'd'],
      levels: ['none', 'Bronze', 'Silver'],
      series: {
        none: [0, 4, 2, 0],
        Bronze: [0, 0, 2, 0],
        Silver: [0, 0, 0, 0],
      },
    })
    expect(byDay).toEqual([null, 0, 0.25, null])
    expect(movement(byDay)).toEqual({ change: 0.25, days: 1 })
    expect(movement([null, 0.5, null])).toBeNull()
  })

  it('groups one rule across the kinds that hold it, adding up what it lifts', () => {
    const lift = (blueprint: string, id: string, title: string, level: number, lifts: number) => ({ rule: { id, title, where: { field: id, op: 'exists' as const } }, blueprint, level, scored: 10, failing: lifts + 1, lifts })
    const groups = groupLifts([lift('rg', 'pid', 'Carries pid', 0, 172), lift('net', 'pid', 'Carries pid', 0, 71), lift('app', 'tf', 'Managed by Terraform', 1, 171), lift('rg', 'none', 'Never', 0, 0)])
    expect(groups.map((g) => [g.title, g.lifts, g.failing, g.parts.map((p) => p.blueprint)])).toEqual([
      ['Carries pid', 243, 245, ['rg', 'net']],
      ['Managed by Terraform', 171, 172, ['app']],
    ])
  })
})

describe('whose rows the page reads', () => {
  const mine = (r: ScorecardRow): ScorecardRow => ({ ...r, yours: true })
  const theirs = (r: ScorecardRow): ScorecardRow => ({ ...r, yours: false })

  it("opens on the reader's own when they own any scored row, and lets them ask for everything", () => {
    const results = [{ rows: [theirs(row('svc', -1, {}))] }, { rows: [mine(row('db', 0, {}))] }]
    expect(lensOf(results, undefined)).toEqual({ lens: 'yours', owns: true })
    expect(lensOf(results, 'wide')).toEqual({ lens: 'wide', owns: true })
  })

  it('has only the wide lens for a reader who owns nothing scored, or whose ownership is unknown', () => {
    expect(lensOf([{ rows: [theirs(row('svc', -1, {}))] }], 'yours')).toEqual({ lens: 'wide', owns: false })
    expect(lensOf([{ rows: [row('svc', -1, {})] }], undefined)).toEqual({ lens: 'wide', owns: false })
  })

  it("counts the reader's own again, level by level, and nothing out of scope", () => {
    const rows = [mine(row('svc', -1, {})), mine(row('svc', 1, {})), theirs(row('svc', -1, {})), theirs(row('svc', 0, {}))]
    const narrowed = yoursOf({ scorecard: card, rows, counts: [2, 1, 1], outOfScope: 5 })
    expect(narrowed.rows).toHaveLength(2)
    expect(narrowed.counts).toEqual([1, 0, 1])
    expect(narrowed.outOfScope).toBe(0)
    expect(readingOf(narrowed)).toMatchObject({ scored: 2, none: 1, top: 1 })
  })

  it('advises only a reader looking at their own, or one who sees the whole estate', () => {
    expect(advises('yours', false)).toBe(true)
    expect(advises('wide', true)).toBe(true)
    expect(advises('wide', false)).toBe(false)
  })
})

describe('a rule its judge had no data on', () => {
  it('holds a row below its level, is no failure, and keeps the failure beside it from lifting the row alone', () => {
    const rows = [
      row('svc', -1, { readme: false, ci: null }), // fails one and no data on the other: fixing the failure lifts nothing
      row('svc', -1, { readme: false }), // ci does not apply: the failure alone holds it
    ]
    const by = Object.fromEntries(liftsOf(card, rows).map((l) => [`${l.blueprint}.${l.rule.id}`, [l.scored, l.failing, l.lifts]]))
    expect(by['svc.readme']).toEqual([2, 2, 1])
    expect(by['svc.ci']).toEqual([1, 0, 0])
  })
})

describe('a scope said in words', () => {
  const judged = (field: string) => ({ id: 'x', title: 'x', where: { field, op: 'exists' as const }, judged: { field } })
  const named = (id: string) => id.toUpperCase()

  it('says once that a judge answered, where that is all a scope asks', () => {
    const sc: Scorecard = { ...card, blueprints: { svc: { where: { field: 'said', op: 'exists' }, rules: { Bronze: [judged('said')] } } } }
    expect(scopeWords(partsOf(sc), [], named)).toBe('Scored where its judge answered')
  })

  it("says each condition by the field's own title, and the kind it holds on where a card scores several", () => {
    const sc: Scorecard = { ...card, blueprints: { svc: { where: { field: 'env', op: 'eq', value: 'Prod' }, rules: { Bronze: [rule('readme')] } }, db: { rules: { Bronze: [rule('backup')] } } } }
    const words = scopeWords(partsOf(sc), [{ id: 'svc', title: 'Service', origin: { kind: 'ui' }, updatedAt: '', relations: {}, fields: { env: { type: 'string', title: 'Environment' } } }], named)
    expect(words).toMatch(/^Scope: SVC: Environment .*Prod$/)
    expect(words).not.toContain('{')
  })
})
