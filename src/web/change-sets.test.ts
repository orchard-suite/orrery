import { describe, expect, it } from 'vitest'
import type { ChangeSetItem } from '../shared/api.ts'
import { groupItems, setSaid, setState } from './change-sets.ts'

const item = (index: number, action: string, key: string, inputs: Record<string, unknown>): ChangeSetItem => ({
  index,
  run: `r${index}`,
  action,
  actionTitle: action === 'add' ? 'Add to program' : 'Set function',
  entity: { blueprint: 'person', key },
  entityTitle: key.toUpperCase(),
  inputs,
  state: 'awaiting',
  summary: null,
  approvalsNeeded: 1,
  approvedBy: [],
  attempt: 1,
  startedAt: null,
  finishedAt: null,
})

describe('a change set read by a person', () => {
  it('groups its runs by action, then by the inputs they share, each in the order the set names it', () => {
    const groups = groupItems([
      item(0, 'add', 'a', { program: '803' }),
      item(1, 'add', 'b', { program: '987' }),
      item(2, 'set', 'c', { function: 'QA' }),
      item(3, 'add', 'd', { program: '803', note: null }),
    ])
    expect(groups.map((g) => [g.action, g.runs, g.groups.map((i) => i.items.map((x) => x.entity?.key))])).toEqual([
      ['add', 3, [['a', 'd'], ['b']]],
      ['set', 1, [['c']]],
    ])
  })

  it('reads its state in one mark, and what it changes in a line', () => {
    expect(setState({ decision: 'pending', counts: { awaiting: 3 }, done: false })).toBe('awaiting')
    expect(setState({ decision: 'rejected', counts: { declined: 3 }, done: true })).toBe('declined')
    expect(setState({ decision: 'withdrawn', counts: { cancelled: 3 }, done: true })).toBe('cancelled')
    expect(setState({ decision: 'approved', counts: { running: 1, queued: 2 }, done: false })).toBe('running')
    expect(setState({ decision: 'approved', counts: { succeeded: 2, failed: 1 }, done: true })).toBe('failed')
    expect(setState({ decision: 'approved', counts: { succeeded: 3 }, done: true })).toBe('succeeded')
    expect(setSaid({ size: 3, actions: [{ id: 'add', title: 'Add to program', runs: 2 }, { id: 'set', title: 'Set function', runs: 1 }] })).toBe('3 changes: Add to program (2), Set function (1)')
    expect(setSaid({ size: 1, actions: [{ id: 'add', title: 'Add to program', runs: 1 }] })).toBe('1 change: Add to program')
  })
})
