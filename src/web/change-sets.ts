// What the web app works out of a change set, pure: its runs grouped by
// action and then by the inputs they share, how the set stands in one mark,
// and its decision in a word.

import type { ChangeSetDecision, ChangeSetItem, ChangeSetSummary } from '../shared/api.ts'
import type { ActionRunState } from '../shared/model.ts'

/** The runs of one action that share every input, in the set's order. */
export interface InputGroup {
  key: string
  inputs: Record<string, unknown>
  titles: Record<string, string>
  items: ChangeSetItem[]
}

/** One action of a set: its runs, by the inputs they share. */
export interface ActionGroup {
  action: string
  actionTitle: string
  runs: number
  groups: InputGroup[]
}

/** The same inputs as one text, whatever order their names came in: an empty value says nothing. */
function inputsKey(inputs: Record<string, unknown>): string {
  return JSON.stringify(
    Object.keys(inputs)
      .filter((k) => inputs[k] !== null && inputs[k] !== '' && !(Array.isArray(inputs[k]) && (inputs[k] as unknown[]).length === 0))
      .sort()
      .map((k) => [k, inputs[k]]),
  )
}

/**
 * A set's runs by action, in the order the set first names each, and under
 * each by the inputs its runs share, in the order each set of inputs first
 * comes: a person reads "add to program 803: these three" once, not three
 * times.
 */
export function groupItems(items: ChangeSetItem[]): ActionGroup[] {
  const out: ActionGroup[] = []
  for (const item of items) {
    let action = out.find((a) => a.action === item.action)
    if (!action) out.push((action = { action: item.action, actionTitle: item.actionTitle, runs: 0, groups: [] }))
    action.runs++
    const key = inputsKey(item.inputs)
    const group = action.groups.find((g) => g.key === key)
    if (group) {
      group.items.push(item)
      Object.assign(group.titles, item.inputTitles ?? {})
    } else action.groups.push({ key, inputs: item.inputs, titles: { ...(item.inputTitles ?? {}) }, items: [item] })
  }
  return out
}

/** A set's state in one mark: waiting while it waits, as it was decided otherwise, and once approved how its runs stand. */
export function setState(set: Pick<ChangeSetSummary, 'decision' | 'counts' | 'done'>): ActionRunState {
  if (set.decision === 'pending') return 'awaiting'
  if (set.decision === 'rejected') return 'declined'
  if (set.decision === 'withdrawn') return 'cancelled'
  if (!set.done) return (set.counts.running ?? 0) > 0 ? 'running' : 'queued'
  if ((set.counts.failed ?? 0) > 0) return 'failed'
  if ((set.counts.unknown ?? 0) > 0) return 'unknown'
  if ((set.counts.succeeded ?? 0) > 0) return 'succeeded'
  return 'cancelled'
}

/** How a set was decided, in a word or two. */
export const DECISION_WORD: Record<ChangeSetDecision, string> = { pending: 'waiting for approval', approved: 'approved', rejected: 'rejected', withdrawn: 'withdrawn' }

/** What a set changes, in a line: how many changes of which actions. */
export function setSaid(set: Pick<ChangeSetSummary, 'size' | 'actions'>): string {
  const many = (n: number, one: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : `${one}s`}`
  return `${many(set.size, 'change')}: ${set.actions.map((a) => `${a.title}${set.actions.length > 1 ? ` (${a.runs.toLocaleString('en-US')})` : ''}`).join(', ')}`
}
