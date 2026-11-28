// The change events of a run that carries a change statement: stated when it
// is asked, routed right after, decided for each yes and no, and ended when it
// reaches a final state. Each is the platform kit's event shape, kept in the
// `detail.event` of the activity row written with the change that made it, so
// the Annals forwarder carries it as it carries every other row, and the
// change event forwarder carries each one to the dispatch desk. A run of an
// action that opts in to the estate's judge is routed as the judge answers,
// with the action's own approval kept beside it; any other is routed by the
// hub itself: a run that waits for approval goes to people, any other to no
// one.

import { createHash } from 'node:crypto'
import { canonical, CHANGE_CHECKS, CHANGE_EVENTS, CHANGE_SENDER, CHECK_OUTPUT, DIFFERS_OUTPUT, STATEMENT_FIELDS, type ChangeCheck, type ChangeDecided, type ChangeEnded, type ChangeEvent, type ChangeGrant, type ChangeJudge, type ChangeReason, type ChangeRouted, type ChangeRouting, type ChangeStated, type ChangeStatement } from '../shared/change.ts'
import type { ActionRunState, RouteAsks } from '../shared/model.ts'
import type { OutputValue } from '../shared/run-marks.ts'

/** The statement's identity: `sha256:` and the hex of SHA-256 over its canonical form, as the platform kit takes it. */
export function digestOf(statement: ChangeStatement): string {
  return `sha256:${createHash('sha256').update(canonical(statement)).digest('hex')}`
}

/** The key of a run's change.stated event, which every later event of the run names as `of`. Keys are the run's own, so a pass sent twice is one record. */
export const statedKey = (run: string): string => `${run}.stated`

/** The rule the hub routes by until the estate's judge does: the action's own approval. */
export const HUB_RULE = 'action-approval'

/** The most people a grant of a route names, and the most grants, as the contract holds them. */
const VALUES_MAX = 50
const GRANTS_MAX = 16

/** What every event after the stated one carries. */
function after(run: string, digest: string, key: string, at: Date) {
  return { sender: CHANGE_SENDER, key, at: at.toISOString(), of: { sender: CHANGE_SENDER, key: statedKey(run) }, digest }
}

export function statedEvent(run: string, statement: ChangeStatement, digest: string, at: Date): ChangeStated {
  return { event: 'change.stated', sender: CHANGE_SENDER, key: statedKey(run), at: at.toISOString(), digest, statement }
}

/**
 * How the judge routed a run of an action that opts in to it: its answer, or
 * null when it gave none; the fences the hub holds beside the answer, each a
 * reason that sent the run to people; what the route asks beside the
 * action's own approval; and whether the action's own approval holds the
 * run as well.
 */
export interface JudgedRoute {
  answer: (ChangeRouting & { judge: ChangeJudge }) | null
  fences: ChangeReason[]
  asks: RouteAsks | null
  own: boolean
}

/** Grants as the contract holds them: at most `GRANTS_MAX`, each naming 1 to `VALUES_MAX` people. */
function clipped(grants: ChangeGrant[]): ChangeGrant[] {
  return grants
    .map((g) => ({ ...g, values: g.values.slice(0, VALUES_MAX) }))
    .filter((g) => g.values.length)
    .slice(0, GRANTS_MAX)
}

/**
 * A run's route as its change.routed event says it. `waitsOn` names who the
 * action's own approval waits on, or is null when it waits on no one, and
 * `quorum` is how many of them must agree. With no judge (`judged` null) the
 * hub is the judge, by the action's approval. A run the judge routed is to
 * people when its route asks for people or the action's own approval does:
 * the route's grants first, then the action's, the larger of the two
 * quorums, and the route's due and start times. Its reasons are the judge's,
 * then the fences, then the action's own approval when it holds the run.
 * The judge is absent only when it gave no answer.
 */
export function routingOf(action: string, version: string, judged: JudgedRoute | null, waitsOn: ChangeGrant[] | null, quorum: number): ChangeRouting {
  if (!judged) return { judge: { name: CHANGE_SENDER, version, pack: `action.${action}` }, route: waitsOn ? { to: 'people', grants: clipped(waitsOn), quorum: Math.max(1, quorum) } : { to: 'no_one' }, reasons: [{ rule: HUB_RULE }] }
  const answer = judged.answer
  const said = answer?.route.to === 'people' ? answer.route : null
  const people = !!judged.asks || !!waitsOn
  const reasons = [...(answer?.reasons ?? []), ...judged.fences, ...(judged.own && waitsOn ? [{ rule: HUB_RULE }] : [])]
  return {
    ...(answer ? { judge: answer.judge } : {}),
    route: people ? { to: 'people', grants: clipped([...(judged.asks?.grants ?? []), ...(waitsOn ?? [])]), quorum: Math.max(1, judged.asks?.need ?? 0, waitsOn ? quorum : 0), ...(said?.by ? { by: said.by } : {}), ...(said?.start ? { start: said.start } : {}) } : { to: 'no_one' },
    ...(reasons.length ? { reasons } : {}),
    ...(answer?.drafts?.length ? { drafts: answer.drafts } : {}),
  }
}

/** A run's change.routed event: its route, as `routingOf` works it out. */
export function routedEvent(run: { id: string }, digest: string, at: Date, routing: ChangeRouting): ChangeRouted {
  return { event: 'change.routed', ...after(run.id, digest, `${run.id}.routed`, at), ...routing }
}

/** One yes or no, the `n`th answer the run was given, counting from 1. */
export function decidedEvent(run: string, digest: string, at: Date, n: number, by: string, answer: 'yes' | 'no'): ChangeDecided {
  return { event: 'change.decided', ...after(run, digest, `${run}.decided.${n}`, at), by: { kind: 'person', id: by }, answer }
}

/**
 * The applier's check, from what the run reported: `statement_check` is
 * matched, differed, or unchecked, and `statement_differs` names the
 * statement's fields that differed, comma-separated. A run that reported no
 * check is unchecked. A name that is no field of a statement is left out.
 */
export function checkOf(outputs: Record<string, OutputValue>): { check: ChangeCheck; differs: string[] } {
  const said = outputs[CHECK_OUTPUT]
  const check = (CHANGE_CHECKS as readonly unknown[]).includes(said) ? (said as ChangeCheck) : 'unchecked'
  const listed = typeof outputs[DIFFERS_OUTPUT] === 'string' ? (outputs[DIFFERS_OUTPUT] as string).split(',').map((f) => f.trim()) : []
  const differs = check === 'differed' ? listed.filter((f): f is (typeof STATEMENT_FIELDS)[number] => (STATEMENT_FIELDS as readonly string[]).includes(f)) : []
  return { check, differs }
}

/** How a change ended, from the final state its run reached, and why when it did not go well. A statement that differed was refused by its applier, never run. */
export function outcomeOf(state: ActionRunState, check: ChangeCheck, stopped = false): { outcome: ChangeEnded['outcome']; reason?: string } {
  if (check === 'differed') return { outcome: 'refused', reason: 'the applier refused it: the statement it recomputed differed from the one judged' }
  switch (state) {
    case 'succeeded':
      return { outcome: 'ok' }
    case 'failed':
      return { outcome: 'failed', reason: 'the run failed' }
    case 'unknown':
      return { outcome: 'failed', reason: 'the hub stopped waiting before it heard how the run ended' }
    case 'declined':
      return { outcome: 'refused', reason: 'declined' }
    case 'returned':
      return { outcome: 'refused', reason: 'sent back to be asked again' }
    case 'cancelled':
      return stopped ? { outcome: 'failed', reason: 'stopped while it ran' } : { outcome: 'refused', reason: 'cancelled before it ran' }
    default:
      return { outcome: 'failed', reason: `ended ${state}` }
  }
}

export function endedEvent(run: string, digest: string, at: Date, outcome: ChangeEnded['outcome'], check: ChangeCheck, differs: string[]): ChangeEnded {
  return { event: 'change.ended', ...after(run, digest, `${run}.ended`, at), outcome, check, ...(check === 'differed' && differs.length ? { differs } : {}) }
}

/** The change event an activity row carries, when it is one this hub sent of a run's. The watch's verdict is another member's, and none of these. */
export function eventOfRow(kind: string, detail: Record<string, unknown>): ChangeEvent | null {
  const e = detail.event
  if (!(CHANGE_EVENTS as readonly string[]).includes(kind) || typeof e !== 'object' || e === null) return null
  return (e as ChangeEvent).event === kind ? (e as ChangeEvent) : null
}
