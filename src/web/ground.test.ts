import { describe, expect, it } from 'vitest'
import type { GroundBehindRow, GroundItem, GroundMeasure } from '../shared/ground.ts'
import { breaksText, budgetText, checkText, foldText, checksText, fixText, goalText, nameBeside, sharedStart, toFix, valueText, counted, coverText, crossingText, dueDay, itemText, measureText, percent, sharedActions, spanText, standing, tidyGround, trendText, weekText, withBudget } from './ground.ts'

const measure = (over: Partial<GroundMeasure>): GroundMeasure => ({ field: 'pipeline_minutes', title: 'Pipeline minutes', role: 'loop', value: 19, budget: { max: 15 }, over: true, bucket: 3, week: 4, ...over })

const item = (over: Partial<GroundItem>): GroundItem => ({ key: 'billing', title: 'Billing', icon: null, level: 'amber', reasons: [], measures: [measure({})], over: 1, inside: false, activity: 12, activityBucket: 2, trial: false, template: null, taughtBy: [], actions: [], links: [], worse: 0.2, why: [], ...over })

describe('a budget in words', () => {
  it('says a ceiling, a floor, or both', () => {
    expect(budgetText({ max: 15 })).toBe('at most 15')
    expect(budgetText({ min: 80 })).toBe('at least 80')
    expect(budgetText({ min: 3, max: 15 })).toBe('3 to 15')
  })

  it('says there is none, for a number with none and for one with neither side', () => {
    expect(budgetText(null)).toBe('no budget')
    expect(budgetText({})).toBe('no budget')
  })
})

describe('one number in words', () => {
  it('says where it stands against its budget', () => {
    expect(standing(measure({}))).toBe('outside its budget')
    expect(standing(measure({ value: 9, over: false }))).toBe('inside its budget')
    expect(standing(measure({ budget: null, over: false }))).toBe('no budget')
    expect(standing(measure({ value: null, over: false }))).toBe('not known')
  })

  it('is a sentence part with the budget it is read against', () => {
    expect(measureText(measure({}))).toBe('Pipeline minutes 19, outside its budget of at most 15')
    expect(measureText(measure({ budget: null, over: false }))).toBe('Pipeline minutes 19')
    expect(measureText(measure({ value: null }))).toBe('Pipeline minutes not known')
  })

  it('says how far it moved this week, and nothing when it did not or its past is not kept', () => {
    expect(weekText(measure({ week: 4 }))).toBe('up 4 this week')
    expect(weekText(measure({ week: -2 }))).toBe('down 2 this week')
    expect(weekText(measure({ week: 0 }))).toBe('')
    expect(weekText(measure({ week: null }))).toBe('')
  })
})

describe('what a picture of one entity says', () => {
  it('is its status and every number, in one sentence a screen reader says', () => {
    expect(itemText(item({}), 'Degraded')).toBe('Billing: Degraded. Pipeline minutes 19, outside its budget of at most 15.')
  })

  it('adds the trial and a template it has fallen behind', () => {
    const text = itemText(item({ trial: true, template: { blueprint: 'template', key: 'service', title: 'Service', version: '1.2', current: '1.4', behind: true } }), 'Healthy')
    expect(text).toContain('on trial')
    expect(text).toContain('started from Service at 1.2, now at 1.4')
  })
})

describe('the forecast in words', () => {
  it('counts days, then weeks', () => {
    expect(spanText(1)).toBe('1 day')
    expect(spanText(9)).toBe('9 days')
    expect(spanText(15)).toBe('about 2 weeks')
  })

  it('says when a number reaches its budget', () => {
    expect(crossingText({ key: 'billing', title: 'Billing', field: 'pipeline_minutes', measure: 'Pipeline minutes', value: 13, limit: 15, days: 15 })).toBe('Pipeline minutes is 13 and reaches its budget of 15 in about 2 weeks')
  })

  it('says a number already at its budget is there, not that it will reach it', () => {
    expect(crossingText({ key: 'billing', title: 'Billing', field: 'pipeline_minutes', measure: 'Pipeline minutes', value: 15, limit: 15, days: 1 })).toBe('Pipeline minutes is 15, right at its budget, and on its way out')
  })

  it('names the day a date falls due as the day the hub named', () => {
    expect(dueDay('2026-06-03')).toBe('Wednesday, Jun 3')
  })
})

describe('how much of a ground is inside its budgets', () => {
  it('counts the ones inside of the ones with a budgeted number', () => {
    expect(coverText({ items: 12, measured: 10, inside: 7, share: 0.7 })).toBe('7 of 10 inside every budget')
    expect(percent(0.7)).toBe('70%')
  })

  it('says so when nothing has a budget to hold', () => {
    expect(coverText({ items: 12, measured: 0, inside: 0, share: null })).toBe('12 with no budget to hold')
  })
})

describe('the actions offered on several entities', () => {
  it('are those every one of them allows, of those the reader may run', () => {
    expect(sharedActions([{ actions: ['rebuild', 'archive'] }, { actions: ['archive', 'rebuild', 'rename'] }], ['archive', 'rebuild', 'rename'])).toEqual(['archive', 'rebuild'])
  })

  it('leave out one the reader may not run, and are none when nothing is chosen', () => {
    expect(sharedActions([{ actions: ['rebuild'] }, { actions: ['rebuild'] }], [])).toEqual([])
    expect(sharedActions([], ['rebuild'])).toEqual([])
  })
})

describe('how a lens moved since last week, in words', () => {
  it('says how many got worse and better, or that it is the same', () => {
    expect(trendText({ better: 2, worse: 1, same: 5 })).toBe('1 worse, 2 better than last week')
    expect(trendText({ better: 0, worse: 3, same: 0 })).toBe('3 worse than last week')
    expect(trendText({ better: 0, worse: 0, same: 4 })).toBe('same as last week')
  })

  it('says nothing where no past is kept', () => {
    expect(trendText(null)).toBe('')
  })
})

describe('a budget typed on a number', () => {
  it('sets one side and keeps the other', () => {
    expect(withBudget({ type: 'number', budget: { min: 3 } }, 'max', '15')).toEqual({ type: 'number', budget: { min: 3, max: 15 } })
  })

  it('takes a side away when it is emptied, and the budget with the last side', () => {
    expect(withBudget({ type: 'number', budget: { min: 3, max: 15 } }, 'min', '')).toEqual({ type: 'number', budget: { max: 15 } })
    expect(withBudget({ type: 'number', title: 'Minutes', budget: { max: 15 } }, 'max', ' ')).toEqual({ type: 'number', title: 'Minutes' })
  })

  it('changes nothing while what is typed is not a number yet', () => {
    const def = { type: 'number' as const, budget: { max: 15 } }
    expect(withBudget(def, 'max', '-')).toBe(def)
  })
})

describe('a ground as it is saved', () => {
  it('keeps only the parts that name something', () => {
    expect(tidyGround({ loop: 'pipeline_minutes', friction: undefined, guards: [], trends: {}, template: { relation: 'template', version: undefined } })).toEqual({ loop: 'pipeline_minutes', template: { relation: 'template' } })
  })

  it('drops a template with no relation, and is no ground at all when nothing is named', () => {
    expect(tidyGround({ template: { relation: '', version: 'template_version' } })).toBeUndefined()
    expect(tidyGround({})).toBeUndefined()
  })
})

describe('counts in a sentence', () => {
  it('says broken before no data, and that every check holds when neither', () => {
    expect(checksText(1200, 3)).toBe('1,200 broken, 3 with no data')
    expect(checksText(0, 3)).toBe('3 with no data')
    expect(checksText(0, 0)).toBe('Every check holds')
  })

  it('names one thing and several things', () => {
    expect(counted(1, 'thing')).toBe('1 thing')
    expect(counted(2, 'thing')).toBe('2 things')
    expect(counted(3, 'repository', 'repositories')).toBe('3 repositories')
  })
})

describe('what is wrong with one entity, and how its numbers are worked out', () => {
  const m = (title: string, over: boolean) => ({ title, over }) as GroundMeasure
  const row = (key: string, extra: Partial<GroundBehindRow> = {}): GroundBehindRow => ({ blueprint: 'pipe', key, title: key, icon: null, level: 'red', reasons: [], value: null, counted: true, links: [], ...extra })
  const over = (field: string, value: number, max: number) => ({ field, title: field, value, budget: { max }, over: value > max }) as GroundMeasure
  it('names the things that break each number, one fix a thing however many numbers it breaks', () => {
    const red = over('red', 1, 0)
    const slowest = over('slowest', 900, 600)
    const behind = new Map([
      ['red', { field: 'red', reached: 2, counted: 1, rows: [row('build', { reasons: ['Build failed for v1.0.0'] }), row('deploy', { counted: false, level: 'green' })] }],
      ['slowest', { field: 'slowest', reached: 2, counted: 2, rows: [row('build', { value: 900 }), row('deploy', { value: 120, level: 'green' })] }],
    ])
    const fixes = toFix({ measures: [red, slowest], reasons: ['Build failed for v1.0.0'], level: 'red' }, [], behind, (f) => (f === 'red' ? 'count' : 'max'))
    expect(fixes.map((f) => (f.kind === 'thing' ? [f.row.key, f.breaks.map((m) => m.field)] : f.kind))).toEqual([['build', ['red', 'slowest']]])
  })
  it('keeps a number with nothing behind it, a fence that does not hold, and a status reason no thing gave', () => {
    const fixes = toFix({ measures: [over('stale', 1, 0), over('fine', 0, 0)], reasons: ['Idle 90 days'], level: 'red' }, [{ field: 'b', title: 'Is branch protected', on: false }, { field: 'c', title: 'Has CI', on: null }], new Map(), () => 'count')
    expect(fixes.map((f) => f.kind)).toEqual(['measure', 'guard', 'status'])
    expect(fixText(fixes)).toBe('3 things to fix.')
    expect(fixText([])).toBe('Nothing to fix.')
  })
  it('names the thing that gave a status reason though it breaks no number, and fixes nothing on a grey entity', () => {
    const behind = new Map([['red', { field: 'red', reached: 1, counted: 0, rows: [row('ci', { level: 'amber', counted: false, reasons: ['Pipeline is flaky'] })] }]])
    const amber = toFix({ measures: [over('red', 0, 0)], reasons: ['Pipeline is flaky'], level: 'amber' }, [], behind, () => 'count')
    expect(amber.map((f) => (f.kind === 'thing' ? [f.row.key, f.breaks.length] : f.kind))).toEqual([['ci', 0]])
    expect(toFix({ measures: [], reasons: ['no pipelines'], level: 'grey' }, [], new Map(), () => 'count')).toEqual([])
  })
  it('reads a related name beside its owner', () => {
    expect(nameBeside('cloud/finops / Pipeline', 'finops')).toBe('Pipeline')
    expect(nameBeside('team/Automation/QA_APIAutomation / QA-APIAutomation', 'QA_APIAutomation')).toBe('QA-APIAutomation')
    expect(nameBeside('build', 'finops')).toBe('build')
  })
  it('names nobody for a number under its least', () => {
    const few = { field: 'deploys', title: 'Deploys', value: 1, budget: { min: 4 }, over: true } as GroundMeasure
    const fixes = toFix({ measures: [few], reasons: [], level: 'red' }, [], new Map([['deploys', { field: 'deploys', reached: 1, counted: 1, rows: [row('a')] }]]), () => 'count')
    expect(fixes.map((f) => f.kind)).toEqual(['measure'])
    expect(goalText(few.budget)).toBe('should be at least 4')
  })
  it('says plainly what a number should be, and when it is out of line', () => {
    expect(goalText({ max: 0 })).toBe('should be 0')
    expect(goalText({ max: 15 })).toBe('should be at most 15')
    expect(goalText({ min: 4 })).toBe('should be at least 4')
    expect(goalText({ min: 2, max: 8 })).toBe('should be 2 to 8')
    expect(goalText(null)).toBe('')
  })
  it('names the fold under a number and what each line shows', () => {
    expect(foldText({ reached: 3, counted: 1 }, 'count', 'pipeline')).toBe('Show the 1 pipeline')
    expect(foldText({ reached: 3, counted: 0 }, 'count', 'pipeline')).toBe('')
    expect(foldText({ reached: 3, counted: 3 }, 'max', 'pipeline')).toBe('Show the 3 pipelines')
    expect(breaksText({ title: 'Red pipelines', value: 1 })).toBe('Why Red pipelines is 1.')
    expect(checkText(false)).toBe('No')
    expect(checkText(null)).toBe('Unknown')
    expect(valueText({ value: null, counted: true }, 'count')).toBe('')
    expect(valueText({ value: 57, counted: true }, 'max')).toBe('57')
    expect(valueText({ value: 291, counted: false }, 'max')).toBe('')
    expect(valueText({ value: null, counted: true }, 'max')).toBe('')
  })
  it('finds what the titles of a receipt share at their start', () => {
    const team = 'dcicometteam/Acme - Test Automation/QA_APIAutomation / '
    expect(sharedStart([`${team}QA_APIAutomation`, `${team}QA-APIAutomation`, `${team}QA_APIAutomation (YAML)`])).toBe(team)
    expect(sharedStart(['cloud/finops / Pipeline'])).toBe('')
    expect(sharedStart(['cloud/a / Pipeline', 'cloud/b / Pipeline'])).toBe('cloud/')
    expect(sharedStart(['build', 'deploy'])).toBe('')
  })
})
