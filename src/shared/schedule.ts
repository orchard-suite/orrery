// What a schedule says beside what it fires: when its people hear of a
// firing, and whether a change to it changes what fires. The hub decides with
// these and the schedule drawer says them in words, so both sides agree.

import type { ActionRunState } from './model.ts'
import type { ScheduleRequest } from './api.ts'

/**
 * When a schedule's owner and the people it names hear of a firing's result:
 * only when the firing failed, when anything in it failed, or every time. A
 * firing that could not ask anything, and a schedule that stops, are told
 * whatever it says.
 */
export const SCHEDULE_TELLS = ['failed', 'anyFailed', 'every'] as const
export type ScheduleTell = (typeof SCHEDULE_TELLS)[number]

/** What a schedule says when nobody chose: a schedule fires often, and a result that worked is worth no message. */
export const DEFAULT_TELL: ScheduleTell = 'failed'

/** Each way in words: the drawer's label, what it means for one run and for many, and how a sentence says it. */
export const TELL_WORDS: Record<ScheduleTell, { label: string; note: string; said: string }> = {
  failed: { label: 'When it fails', note: 'Its run failed, or every run of its batch did.', said: 'only when it fails' },
  anyFailed: { label: 'When anything fails', note: 'Its run failed, or any run of its batch did.', said: 'when anything in it fails' },
  every: { label: 'Every time', note: 'Each result, whether it worked or not.', said: 'of every result' },
}

/**
 * Whether a firing's result is told to the schedule's people: a firing that
 * failed is one where something failed and nothing succeeded. A run whose
 * outcome is unknown is told as a failure is, since someone must look at it.
 * A run that is still going, or one nobody ran, counts as neither.
 */
export function worthTelling(tell: ScheduleTell, counts: Partial<Record<ActionRunState, number>>): boolean {
  const failed = (counts.failed ?? 0) + (counts.unknown ?? 0)
  if (tell === 'every') return true
  if (tell === 'anyFailed') return failed > 0
  return failed > 0 && !(counts.succeeded ?? 0)
}

/**
 * Whether a change fires the same as before: the same action, on the same
 * thing, with the same inputs, at the same times. Only a change that fires
 * differently asks for approval again; a new name or who hears does not.
 */
export function firesTheSame(a: Pick<ScheduleRequest, 'action' | 'target' | 'inputs' | 'cadence'>, b: Pick<ScheduleRequest, 'action' | 'target' | 'inputs' | 'cadence'>): boolean {
  return a.action === b.action && same(a.target, b.target) && same(a.inputs, b.inputs) && same(a.cadence, b.cadence)
}

/** Two JSON values alike, whatever order their keys came in. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ka = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined)
  const kb = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined)
  return ka.length === kb.length && ka.every((k) => same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
}
