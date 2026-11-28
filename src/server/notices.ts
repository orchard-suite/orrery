// Tells a dispatch desk about self-service runs, as events its
// subscriptions send on to the channels that want them: a run asked for, one
// waiting for approval, approved, declined, sent back, and finished. The hub
// says what happened, what it was about, and the people it is for: a run that
// waits is for the people a rule lets decide it, and what became of a run is
// for whoever asked. A scheduled run or batch is for the schedule's owner and
// the people it names, only for the results the schedule says (`tell`); a
// firing that asked nothing because it failed is always theirs. Every event
// carries the weight its kind is declared with, so a notice only lands in a
// person's list. dispatch decides how each of them hears. A run waiting
// for approval also names the hub's own approve and decline calls, so a
// channel that can act, such as a chat bot, can offer them; whoever clicks
// calls the hub as themselves, and the hub decides as it does for the page.
// A run that waits too long is told once more. A tool's run is never told:
// an agent calls tools all day, and each is in the activity log.
//
// It also declares its kinds to the desk, once for each hub that forwards, so
// each person can choose there how they hear of each.
//
// A run that states a change is asked with its statement in words: each
// effect, each part nobody could name, and where it runs.
//
// It reads the activity log the way the Annals forwarder does: a pass sends
// every action row after a mark and moves the mark only past rows logged a
// minute ago, so a row whose transaction commits late is still sent. A row
// sent twice is one event: dispatch keeps one per key.

import type { Db } from './db.ts'
import type { Logger } from './log.ts'
import type { Actions } from './actions.ts'
import type { Batches } from './batches.ts'
import type { ChangeSets } from './change-sets.ts'
import type { Schedules } from './schedules.ts'
import type { Identity } from '../shared/model.ts'
import type { Reader } from './read.ts'
import type { Blueprints } from './blueprints.ts'
import { fetchTimed } from './metrics.ts'
import { attachedInputs, changeInput } from '../shared/input-kinds.ts'
import { applierText, CHANGE_SENDER, routingLines, statementLines, type ChangeStatement } from '../shared/change.ts'
import { markOf, moveMark, settledCeiling } from './log-mark.ts'
import { outputText } from '../shared/run-marks.ts'
import { parseEntityId, REPORT_BLUEPRINT, type ActionRun } from '../shared/model.ts'
import { worthTelling } from '../shared/schedule.ts'

export interface NoticesConfig {
  /** The dispatch desk's API port, such as http://dispatch-api.dispatch.svc:8081. */
  url: string
  /** A token the desk issued; its name is the producer the desk shows. */
  token: string
  /** The hub's own address, for the link to a run. */
  publicUrl: string
  /** A group on the desk that hears of a run that waits when no rule names a decider, or names too many to address. */
  approvers?: string
  /** Hours a run may wait for approval before its deciders are told once more; 0 never tells them again. */
  remindHours: number
}

const KINDS = ['action.set_requested', 'action.set_approved', 'action.set_rejected', 'action.set_withdrawn', 'action.set_finished', 'action.requested', 'action.approved', 'action.declined', 'action.returned', 'action.cancelled', 'action.finished', 'action.batched', 'action.batch_finished', 'schedule.requested', 'schedule.changed', 'schedule.approved', 'schedule.declined', 'schedule.paused', 'schedule.fired', 'report.published']
type Weight = 'notice' | 'notify' | 'page'
/**
 * The kinds of event this forwarder sends, as the desk's `PUT /v1/kinds` takes
 * them: what a person reads when they choose how to hear of each. The weight is
 * what every event of the kind is sent with: a notice lands in a person's list
 * and sends nothing unless they choose otherwise; a notify reaches them. What
 * worked is a notice and what failed a notify, so each is chosen apart.
 */
export const DECLARED_KINDS: { kind: string; title: string; description: string; weight: Weight }[] = [
  { kind: 'action.requested', title: 'An action was run', description: 'Someone ran a self-service action that needed no approval.', weight: 'notice' },
  { kind: 'action.awaiting_approval', title: 'A run waits for your approval', description: 'A self-service run waits for approval, and you are one of the people who may decide it.', weight: 'notify' },
  { kind: 'action.approved', title: 'Your run was approved', description: 'Someone approved a run you asked for.', weight: 'notify' },
  { kind: 'action.declined', title: 'Your run was declined', description: 'Someone declined a run you asked for, with the reason they gave.', weight: 'notify' },
  { kind: 'action.returned', title: 'Your run was sent back', description: 'Someone sent a run you asked for back with a note, to be asked again.', weight: 'notify' },
  { kind: 'action.cancelled', title: 'Your run was cancelled', description: 'A run you asked for was cancelled before it started.', weight: 'notice' },
  { kind: 'action.succeeded', title: 'Your run worked', description: 'A run you asked for succeeded, or one your schedule ran that asks to tell you of every result.', weight: 'notice' },
  { kind: 'action.failed', title: 'Your run failed', description: 'A run you asked for, or one your schedule ran, failed.', weight: 'notify' },
  { kind: 'action.unknown', title: 'Your run may not have worked', description: 'A run you asked for, or one your schedule ran, was handed on, and the hub stopped waiting before it heard how it ended: check what it did before running it again.', weight: 'notify' },
  { kind: 'action.batched', title: 'A batch was run', description: 'Someone ran a self-service action on many things at once.', weight: 'notice' },
  { kind: 'action.batch_succeeded', title: 'Your batch worked', description: 'Every run of a batch you asked for, or one your schedule ran, has ended, and none failed.', weight: 'notice' },
  { kind: 'action.batch_failed', title: 'Your batch had failures', description: 'Every run of a batch you asked for, or one your schedule ran, has ended, and some failed: how many worked and how many failed.', weight: 'notify' },
  { kind: 'action.batch_unknown', title: 'Your batch may not all have worked', description: 'Every run of a batch you asked for, or one your schedule ran, has ended, none failed, and the hub stopped waiting on some before it heard how they ended: how many worked and how many are not known.', weight: 'notify' },
  { kind: 'action.set_awaiting_approval', title: 'A change set waits for your approval', description: 'Someone asked for many changes at once, as one change set, and you may approve every one of them with one decision: its title, why it was asked, and what it changes.', weight: 'notify' },
  { kind: 'action.set_approved', title: 'Your change set was approved', description: 'Someone approved a change set you asked for; its changes run now.', weight: 'notify' },
  { kind: 'action.set_rejected', title: 'Your change set was rejected', description: 'Someone rejected a change set you asked for, with the reason they gave; none of its changes runs.', weight: 'notify' },
  { kind: 'action.set_withdrawn', title: 'A change set was withdrawn', description: 'Whoever asked for a change set withdrew it before it was decided.', weight: 'notice' },
  { kind: 'action.set_succeeded', title: 'Your change set worked', description: 'Every change of a change set you asked for has ended, and none failed.', weight: 'notice' },
  { kind: 'action.set_failed', title: 'Your change set had failures', description: 'Every change of a change set you asked for has ended, and some failed: how many worked and how many failed. Its page asks again for the ones that failed.', weight: 'notify' },
  { kind: 'action.set_unknown', title: 'Your change set may not all have worked', description: 'Every change of a change set you asked for has ended, none failed, and the hub stopped waiting on some before it heard how they ended.', weight: 'notify' },
  { kind: 'schedule.awaiting_approval', title: 'A schedule waits for your approval', description: 'Someone asked to run a self-service action on a schedule, or changed one, with the load it adds; you decide approvals.', weight: 'notify' },
  { kind: 'schedule.approved', title: 'Your schedule was approved', description: 'Someone approved a schedule you set up; it fires from its next time.', weight: 'notify' },
  { kind: 'schedule.declined', title: 'Your schedule was declined', description: 'Someone declined a schedule you set up, with the reason they gave.', weight: 'notify' },
  { kind: 'schedule.failed', title: 'Your schedule could not run', description: 'A schedule you set up, or one that names you, failed to fire and asked nothing, with why. It fires again at its next time.', weight: 'notify' },
  { kind: 'schedule.paused', title: 'Your schedule stopped', description: 'A schedule you set up was paused, or could not fire and paused itself, with why.', weight: 'notify' },
  { kind: 'report.published', title: 'A report you receive was published', description: 'A new edition of a report that names you as a recipient: what it says in a line, its headline numbers, and a link to read it whole.', weight: 'notify' },
]
const WEIGHT = new Map(DECLARED_KINDS.map((k) => [k.kind, k.weight]))
/** The weight a kind is declared with; a kind declared nowhere reaches people, as the desk's own default does. */
const weightOf = (kind: string): Weight => WEIGHT.get(kind) ?? 'notify'
/** The most people, groups, and chains one event may be addressed to. */
const TO_MAX = 20
/** A name the desk takes as a person's address. */
const EMAIL = /^[^\s@<>"']+@[^\s@<>"']+\.[A-Za-z]{2,}$/

/** A schedule's people as an event's addresses: its owner, then each person it names, once each. */
function peopleOf(audience: { owner: string; deliver: string[] }): { person: string }[] {
  return [...new Set([audience.owner, ...audience.deliver])].filter((p) => EMAIL.test(p)).slice(0, TO_MAX).map((person) => ({ person }))
}
const MARK_KEY = 'notices.forwarded'
const BATCH = 200

interface Row {
  id: string
  kind: string
  at: Date
  actor: string | null
  detail: Record<string, unknown>
}

/** One event, as dispatch's `POST /v1/events` takes it. */
/** The most bytes of a page the desk takes with an event. */
const PAGE_MAX = 256 * 1024

/** The longest name and value the desk takes of a fact. */
const FACT_NAME_MAX = 80
const FACT_VALUE_MAX = 500

/** Facts as the desk takes them: each name and value cut to its limit, so one long input never has the desk refuse the whole event. */
export function fitFacts(facts: NoticeEvent['facts']): NoticeEvent['facts'] {
  const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)
  return facts.filter((f) => f.name).map((f) => ({ name: cut(f.name, FACT_NAME_MAX), value: cut(f.value, FACT_VALUE_MAX) }))
}

export interface NoticeEvent {
  kind: string
  key: string
  title: string
  text?: string
  /** The event drawn whole as an HTML page, for the desk's mail alone. */
  page?: string
  severity?: 'critical' | 'warning' | 'info'
  entity?: { blueprint: string; key: string; title: string }
  facts: { name: string; value: string }[]
  links: { title: string; url: string }[]
  /** Calls on the producer's own API that a channel able to act may offer, made as the person who clicks. */
  actions?: { title: string; path: string; style?: 'positive' | 'destructive'; done: string }[]
  labels: Record<string, string>
  /** The people and groups it is for, besides whatever a subscription sends it to. */
  to?: ({ person: string } | { group: string })[]
  /** How hard it pushes on the people it reaches: its kind's declared weight. */
  weight: Weight
  at: string
}

export interface NoticesDeps {
  db: Db
  actions: Actions
  batches: Batches
  sets: ChangeSets
  schedules: Schedules
  /** Everyone enrolled, as the hub judges each now: who decides a schedule is read from them. */
  people: () => Identity[]
  reader: Reader
  blueprints: Blueprints
  /** An edition of a report drawn as a mail, or null when it is gone. Without it a published edition is told as a notice alone. */
  mailOf?: (report: string, edition: number) => Promise<string | null>
  log: Logger
}

export class NoticeForwarder {
  private readonly deps: NoticesDeps
  private readonly config: NoticesConfig
  private readonly post: typeof fetch
  /** Rows above the mark this hub already told: the mark waits for rows to settle, so they come up again until it passes them. */
  private readonly told = new Set<string>()
  /** Whether this forwarder has declared its kinds to the desk. */
  private declared = false

  constructor(deps: NoticesDeps, config: NoticesConfig, post: typeof fetch = (input, init) => fetchTimed('dispatch', input as string | URL, init)) {
    this.deps = deps
    this.config = config
    this.post = post
  }

  /**
   * Sends every action row after the mark that this hub has not told yet, then
   * moves the mark to the newest settled row. A row is told as soon as it is
   * seen; the mark waits until rows settle, so one that commits late is never
   * passed over. A hub that takes the lead tells the rows above the mark again,
   * under the same keys, and dispatch keeps one of each.
   */
  async pass(): Promise<number> {
    const { db, log } = this.deps
    if (!this.declared) await this.declare()
    const mark = await markOf(db, MARK_KEY)
    const ceiling = await settledCeiling(db)
    let sent = 0
    let after = mark
    for (;;) {
      // A run of a batch is the batch's to tell, unless it waits for someone to decide it. A run of a change set is always the set's.
      const rows = await db.query<Row>(`SELECT id, kind, at, actor, detail FROM changes WHERE id > $1 AND kind = ANY($2) AND NOT (detail ? 'tool') AND (kind LIKE 'action.batch%' OR NOT (detail ? 'batch') OR detail->>'state' = 'awaiting') AND (kind LIKE 'action.set\\_%' OR NOT (detail ? 'set')) AND (kind <> 'schedule.fired' OR outcome = 'failed') AND (kind NOT LIKE 'action.set\\_%' OR outcome <> 'failed' OR kind = 'action.set_finished') ORDER BY id LIMIT $3`, [after, KINDS, BATCH])
      for (const row of rows.rows) {
        after = row.id
        if (this.told.has(row.id)) continue
        const event = await this.eventOf(row)
        if (event) sent += await this.send(event)
        else log.debug('action row not told: its run is gone', { change: row.id, kind: row.kind })
        this.told.add(row.id)
      }
      if (rows.rows.length < BATCH) break
    }
    if (await moveMark(db, MARK_KEY, mark, ceiling)) for (const id of this.told) if (BigInt(id) <= BigInt(ceiling!)) this.told.delete(id)
    if (this.config.remindHours > 0) sent += await this.remind()
    if (sent) log.info('runs told to dispatch', { events: sent, mark: ceiling ?? mark })
    return sent
  }

  /** Tells the deciders of each run and change set that has waited too long, once: each keeps that it was told, so no hub tells it twice. */
  private async remind(): Promise<number> {
    let sent = 0
    for (const set of await this.deps.sets.overdue(this.config.remindHours)) {
      const event = await this.setEvent({ id: set, kind: 'action.set_requested', at: new Date(), actor: null, detail: { set } }, true)
      if (event) sent += await this.send(event)
      await this.deps.sets.reminded(set)
      this.deps.log.info('change set still awaiting approval; its deciders told again', { set, to: event?.to ?? [] })
    }
    for (const run of await this.deps.actions.overdue(this.config.remindHours)) {
      const event = await this.eventOf({ id: run.id, kind: 'action.requested', at: new Date(), actor: run.by, detail: { run: run.id, state: 'awaiting' } }, true)
      if (event) sent += await this.send(event)
      await this.deps.actions.reminded(run.id)
      this.deps.log.info('run still awaiting approval; its deciders told again', { run: run.id, action: run.action, to: event?.to ?? [] })
    }
    return sent
  }

  /** Declares the kinds this forwarder sends. A desk that does not take them is logged and asked again on the next pass; events go on either way. */
  private async declare(): Promise<void> {
    try {
      const res = await this.post(`${this.config.url.replace(/\/+$/, '')}/v1/kinds`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${this.config.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ kinds: DECLARED_KINDS }),
        signal: AbortSignal.timeout(15_000),
      })
      if (!res.ok) throw new Error(`dispatch answered ${res.status}: ${(await res.text()).slice(0, 200)}`)
      this.declared = true
      this.deps.log.info('kinds declared to dispatch', { kinds: DECLARED_KINDS.length })
    } catch (error) {
      this.deps.log.warn('kinds not declared to dispatch; asking again on the next pass', { error })
    }
  }

  /** Posts one event. A refusal of the event itself is logged and passed over; anything else throws, so the mark stays. */
  private async send(event: NoticeEvent): Promise<number> {
    const res = await this.post(`${this.config.url.replace(/\/+$/, '')}/v1/events`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.config.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...event, facts: fitFacts(event.facts) }),
      signal: AbortSignal.timeout(15_000),
    })
    if (res.status === 400 && event.page !== undefined) {
      // A desk that takes no page still tells the notice: the edition's links are in it.
      this.deps.log.warn('dispatch refused an event with its page; sending the notice alone', { key: event.key, kind: event.kind, answer: (await res.text()).slice(0, 200) })
      const { page: _page, ...plain } = event
      return this.send(plain)
    }
    if (res.status === 400) {
      this.deps.log.warn('dispatch refused a run event', { key: event.key, kind: event.kind, answer: (await res.text()).slice(0, 200) })
      return 0
    }
    if (!res.ok) throw new Error(`dispatch answered ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const got = (await res.json()) as { repeat?: boolean }
    return got.repeat ? 0 : 1
  }

  /**
   * The event a published edition tells: for the recipients the hub let
   * through when it published, each of whom could see the report then. It
   * says what the edition says in a line, its headline numbers, and where to
   * read it, and carries the edition drawn as a mail, so a letter is the
   * report itself; how each person hears is the desk's.
   */
  private async reportEvent(row: Row): Promise<NoticeEvent | null> {
    const d = row.detail
    const to = (Array.isArray(d.to) ? d.to : []).filter((p): p is string => typeof p === 'string' && EMAIL.test(p))
    if (!to.length || typeof d.report !== 'string') {
      this.deps.log.debug('published edition told to nobody: it names no recipient', { change: row.id, report: d.report ?? null })
      return null
    }
    const title = typeof d.title === 'string' ? d.title : d.report
    const facts = (Array.isArray(d.facts) ? d.facts : []).filter((f): f is { name: string; value: string } => !!f && typeof f === 'object' && typeof (f as { name?: unknown }).name === 'string' && typeof (f as { value?: unknown }).value === 'string')
    const drawn = typeof d.edition === 'number' ? ((await this.deps.mailOf?.(d.report, d.edition)) ?? null) : null
    const page = drawn !== null && Buffer.byteLength(drawn) <= PAGE_MAX ? drawn : null
    if (drawn !== null && page === null) this.deps.log.warn('published edition told without its page: it is larger than the desk takes', { change: row.id, report: d.report, bytes: Buffer.byteLength(drawn) })
    else this.deps.log.debug(page === null ? 'published edition told without its page: none was drawn' : 'published edition told with its page', { change: row.id, report: d.report })
    const links = [typeof d.url === 'string' ? { title: 'Read the edition', url: d.url } : null, typeof d.body === 'string' ? { title: 'Open it as a page to forward', url: d.body } : null].filter((l): l is { title: string; url: string } => !!l)
    return {
      kind: 'report.published',
      key: `change:${row.id}`,
      title: `${title}: edition ${String(d.edition ?? '')}`,
      ...(typeof d.summary === 'string' && d.summary ? { text: d.summary.slice(0, 4000) } : {}),
      ...(page !== null ? { page } : {}),
      entity: { blueprint: REPORT_BLUEPRINT, key: d.report, title },
      facts: facts.slice(0, 20),
      links,
      labels: { report: d.report, ...(typeof d.schedule === 'string' ? { schedule: d.schedule } : {}) },
      to: to.slice(0, TO_MAX).map((person) => ({ person })),
      weight: weightOf('report.published'),
      at: row.at.toISOString(),
    }
  }

  /** The event an action row tells, or null when its run is gone. `again` tells a run that still waits, once more. */
  async eventOf(row: Row, again = false): Promise<NoticeEvent | null> {
    if (row.kind === 'action.batched' || row.kind === 'action.batch_finished') return this.batchEvent(row)
    if (row.kind.startsWith('action.set_')) return this.setEvent(row)
    if (row.kind.startsWith('schedule.')) return this.scheduleEvent(row)
    if (row.kind === 'report.published') return this.reportEvent(row)
    const runId = typeof row.detail.run === 'string' ? row.detail.run : null
    const run = runId ? await this.deps.actions.getRun(runId) : null
    if (!run) return null
    const action = this.deps.actions.get(run.action)
    const doing = action?.title ?? run.action
    const target = run.entity ? await this.deps.reader.get(run.entity) : null
    const on = target ? ` on ${target.title}` : ''
    const who = row.actor ?? 'the hub'
    const finished = row.kind === 'action.finished' ? (typeof row.detail.state === 'string' ? row.detail.state : run.state) : null
    const kind = row.kind === 'action.requested' && row.detail.state === 'awaiting' ? 'action.awaiting_approval' : finished ? (finished === 'failed' ? 'action.failed' : finished === 'unknown' ? 'action.unknown' : 'action.succeeded') : row.kind
    const title = {
      'action.requested': `${run.by} ran ${doing}${on}`,
      'action.awaiting_approval': `${doing}${on} ${again ? 'still waits' : 'waits'} for approval`,
      'action.approved': `${who} approved ${doing}${on}`,
      'action.declined': `${who} declined ${doing}${on}`,
      'action.returned': `${who} sent ${doing}${on} back`,
      'action.cancelled': `${doing}${on} was cancelled`,
      'action.succeeded': `${doing}${on} succeeded`,
      'action.failed': `${doing}${on} failed`,
      'action.unknown': `${doing}${on} may not have worked`,
    }[kind] ?? `${doing}${on}`
    const facts: NoticeEvent['facts'] = [{ name: 'Action', value: doing }]
    if (target) facts.push({ name: this.deps.blueprints.get(target.blueprint)?.title ?? target.blueprint, value: target.title })
    facts.push({ name: 'Asked by', value: run.by })
    if (run.requestedFor) facts.push({ name: 'Asked for', value: run.requestedFor })
    const labels: Record<string, string> = { action: run.action, state: finished ?? run.state }
    if (run.entity) labels.blueprint = run.entity.blueprint
    if (run.schedule) labels.schedule = run.schedule
    // An attachment is read on the run's page: a notice says nothing of it. A change statement is said in words below.
    const attached = new Set(attachedInputs(action?.inputs))
    const stating = changeInput(action?.inputs)
    const statement = stating ? (run.inputs[stating] as ChangeStatement | null) : null
    if (statement) facts.push({ name: 'Change', value: statement.key }, { name: 'Runs on', value: applierText(statement.applier) })
    for (const [name, value] of Object.entries(run.inputs)) {
      if (attached.has(name) || name === stating) continue
      const shown = await this.shown(value)
      if (shown === null) continue
      facts.push({ name: action?.inputs[name]?.title ?? name, value: shown })
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') labels[name] = String(value)
    }
    if (run.decidedBy && kind !== 'action.awaiting_approval' && kind !== 'action.requested') facts.push({ name: 'Decided by', value: run.decidedBy })
    if (finished) for (const [name, value] of Object.entries(run.outputs)) facts.push({ name, value: outputText(value).slice(0, 500) })
    if (finished) for (const name of run.images) facts.push({ name, value: '(a picture; shown on the run page)' })
    const event: NoticeEvent = {
      kind,
      key: again ? `remind:${run.id}` : `change:${row.id}`,
      title,
      facts: facts.slice(0, 20),
      links: [{ title: kind === 'action.awaiting_approval' ? 'Review the run' : 'Open the run', url: `${this.config.publicUrl.replace(/\/+$/, '')}/actions/runs/${encodeURIComponent(run.id)}` }],
      labels,
      weight: weightOf(kind),
      at: row.at.toISOString(),
    }
    if (kind === 'action.awaiting_approval') {
      const at = `/v1/action-runs/${encodeURIComponent(run.id)}`
      event.actions = [
        { title: 'Approve', path: `${at}/approve`, style: 'positive', done: 'approved' },
        { title: 'Decline', path: `${at}/decline`, style: 'destructive', done: 'declined' },
      ]
    }
    // Whoever is asked to approve a change reads what it states, not its JSON.
    // A run the judge routed says why it is asked as well; the hub's own route says nothing the run's deciders do not.
    if (kind === 'action.awaiting_approval' && statement) event.text = [...statementLines(statement), ...(run.routed && run.routed.judge?.name !== CHANGE_SENDER ? routingLines(run.routed, statement) : [])].join('\n').slice(0, 4000)
    if (finished === 'failed' || finished === 'unknown') event.severity = 'warning'
    if (finished && run.summary) event.text = run.summary.slice(0, 4000)
    if (kind === 'action.declined' && typeof row.detail.reason === 'string' && row.detail.reason) event.text = `Why: ${row.detail.reason}`
    if (kind === 'action.returned' && typeof row.detail.note === 'string') event.text = `Note: ${row.detail.note}`.slice(0, 4000)
    if (kind === 'action.cancelled' && typeof row.detail.reason === 'string') event.text = row.detail.reason
    if (target) event.entity = { blueprint: target.blueprint, key: target.key, title: target.title }
    const to = await this.reaches(kind, row.actor, run)
    if (to.length) event.to = to
    return event
  }

  /**
   * Who an event is for. A run that waits is for the people a rule lets
   * decide it, or the approvers group when no rule names anyone or names more
   * than one event may be addressed to; one decided before it was told is for
   * nobody. What became of a run is for whoever
   * asked, unless they did it themselves, or a product asked it for a person. A run only asked for is for nobody:
   * a subscription sends it where it is wanted.
   */
  private async reaches(kind: string, actor: string | null, run: ActionRun): Promise<NonNullable<NoticeEvent['to']>> {
    const group = this.config.approvers ? [{ group: this.config.approvers }] : []
    if (kind === 'action.awaiting_approval') {
      if (run.state !== 'awaiting') return []
      const named = (await this.deps.actions.deciders(run)).filter((name) => EMAIL.test(name))
      if (!named.length || (named.length > TO_MAX && group.length)) return group
      return named.slice(0, TO_MAX).map((person) => ({ person }))
    }
    if (kind === 'action.requested') return []
    // A run a product asked as itself for a person is the product's: what became of it is told to nobody, and the person it is for hears only from the product.
    if (run.requestedFor) return []
    const ended = kind === 'action.succeeded' || kind === 'action.failed' || kind === 'action.unknown'
    // A scheduled run's end is for its schedule's people, and only for the results the schedule says.
    const audience = ended ? await this.deps.schedules.audienceOf(run.schedule) : null
    if (audience) {
      const told = worthTelling(audience.tell, kind === 'action.failed' ? { failed: 1 } : kind === 'action.unknown' ? { unknown: 1 } : { succeeded: 1 })
      this.deps.log.debug(told ? "scheduled run's end told to its schedule's people" : "scheduled run's end told to nobody: its schedule does not ask for it", { run: run.id, schedule: run.schedule, kind, tell: audience.tell })
      return told ? peopleOf(audience) : []
    }
    return actor !== run.by && EMAIL.test(run.by) ? [{ person: run.by }] : []
  }

  /** The event of a schedule asked for, changed, decided, or stopped: one that waits is for whoever decides, the rest for its owner. */
  private async scheduleEvent(row: Row): Promise<NoticeEvent | null> {
    const id = typeof row.detail.schedule === 'string' ? row.detail.schedule : null
    if (!id) return null
    const deciders = this.deps.schedules.deciders(this.deps.people()).filter((p) => EMAIL.test(p))
    const s = await this.deps.schedules.find(id)
    if (!s) return null
    const action = this.deps.actions.get(s.action)
    const doing = action?.title ?? s.action
    const waits = row.kind === 'schedule.requested' || row.kind === 'schedule.changed'
    // A change that fires the same leaves the schedule as it stood: there is nothing new to decide.
    if (waits && (s.state !== 'awaiting' || row.detail.fires === 'same')) return null
    const kind = waits ? 'schedule.awaiting_approval' : row.kind === 'schedule.fired' ? 'schedule.failed' : row.kind
    const minutes = s.load?.runnerSeconds === null || s.load?.runnerSeconds === undefined ? null : Math.round((s.load.runnerSeconds * s.load.perDay) / 60)
    const facts: NoticeEvent['facts'] = [
      { name: 'Action', value: doing },
      { name: 'When', value: s.when },
      { name: 'Owner', value: s.owner },
      ...(s.targetTitle ? [{ name: 'On', value: s.targetTitle }] : []),
      ...(s.load ? [{ name: 'Runs each time', value: s.load.runs.toLocaleString('en-US') }] : []),
      ...(minutes !== null ? [{ name: 'Runner time a day', value: `about ${minutes.toLocaleString('en-US')} minutes` }] : []),
    ]
    const title = {
      'schedule.awaiting_approval': `${s.owner} asks to run ${doing} ${s.when}`,
      'schedule.approved': `${row.actor ?? 'Someone'} approved your schedule: ${s.title}`,
      'schedule.declined': `${row.actor ?? 'Someone'} declined your schedule: ${s.title}`,
      'schedule.paused': `Your schedule stopped: ${s.title}`,
      'schedule.failed': `Your schedule could not run: ${s.title}`,
    }[kind] ?? s.title
    const event: NoticeEvent = {
      kind,
      key: `change:${row.id}`,
      title,
      facts: facts.slice(0, 20),
      links: [{ title: waits ? 'Review the schedule' : 'Open the schedule', url: `${this.config.publicUrl.replace(/\/+$/, '')}/actions/schedules/${encodeURIComponent(s.id)}` }],
      labels: { action: s.action, schedule: s.id },
      weight: weightOf(kind),
      at: row.at.toISOString(),
    }
    if (waits) {
      const at = `/v1/schedules/${encodeURIComponent(s.id)}`
      event.actions = [
        { title: 'Approve', path: `${at}/approve`, style: 'positive', done: 'approved' },
        { title: 'Decline', path: `${at}/decline`, style: 'destructive', done: 'declined' },
      ]
      const group = this.config.approvers ? [{ group: this.config.approvers }] : []
      event.to = deciders.length && deciders.length <= TO_MAX ? deciders.map((person) => ({ person })) : group
    } else if (kind === 'schedule.failed') {
      // A firing that asked nothing is told whatever the schedule asks: it is the failure every choice keeps.
      event.severity = 'warning'
      event.to = peopleOf({ owner: s.owner, deliver: s.deliver })
    } else if (EMAIL.test(s.owner)) event.to = [{ person: s.owner }]
    if (typeof row.detail.reason === 'string') event.text = row.detail.reason
    if (row.kind === 'schedule.paused' && row.detail.paused === false) return null
    return event
  }

  /** The event of a batch asked or ended: one for the whole batch, for whoever asked for it when it ends. */
  private async batchEvent(row: Row): Promise<NoticeEvent | null> {
    const id = typeof row.detail.batch === 'string' ? row.detail.batch : null
    const told = id ? await this.deps.batches.told(id) : null
    if (!told) return null
    const { row: batch, counts } = told
    const action = this.deps.actions.get(batch.action)
    const doing = action?.title ?? batch.action
    const n = (k: keyof typeof counts) => counts[k] ?? 0
    const ended = row.kind === 'action.batch_finished'
    const kind = ended ? (n('failed') ? 'action.batch_failed' : n('unknown') ? 'action.batch_unknown' : 'action.batch_succeeded') : row.kind
    const many = (count: number, one: string) => `${count.toLocaleString('en-US')} ${count === 1 ? one : `${one}s`}`
    const runs = Object.values(counts).reduce((a, b) => a + (b ?? 0), 0)
    const facts: NoticeEvent['facts'] = [{ name: 'Action', value: doing }, { name: 'Asked by', value: batch.actor }, { name: 'Runs', value: String(runs) }]
    if (ended) for (const [s, name] of [['succeeded', 'Succeeded'], ['failed', 'Failed'], ['unknown', 'Outcome unknown'], ['cancelled', 'Cancelled'], ['declined', 'Declined']] as const) if (n(s)) facts.push({ name, value: String(n(s)) })
    for (const [name, value] of Object.entries(batch.inputs)) {
      const shown = await this.shown(value)
      if (shown !== null) facts.push({ name: action?.inputs[name]?.title ?? name, value: shown })
    }
    const labels: Record<string, string> = { action: batch.action, blueprint: batch.blueprint, batch: batch.id }
    if (batch.schedule) labels.schedule = batch.schedule
    const event: NoticeEvent = {
      kind,
      key: `change:${row.id}`,
      title: ended ? `${doing} on ${many(runs, 'thing')}: ${[n('failed') && `${n('failed').toLocaleString('en-US')} failed`, n('unknown') && `${n('unknown').toLocaleString('en-US')} not known`].filter(Boolean).join(', ') || 'all done'}` : `${batch.actor} ran ${doing} on ${many(runs, 'thing')}`,
      facts: facts.slice(0, 20),
      links: [{ title: 'Open the batch', url: `${this.config.publicUrl.replace(/\/+$/, '')}/actions/batches/${encodeURIComponent(batch.id)}` }],
      labels,
      weight: weightOf(kind),
      at: row.at.toISOString(),
    }
    if (ended && (n('failed') || n('unknown'))) event.severity = 'warning'
    // The batch's end is for whoever asked, or for its schedule's people when the schedule asks for it; asking it is for nobody, as a run asked for is: a subscription sends it where it is wanted.
    if (ended) {
      const audience = await this.deps.schedules.audienceOf(batch.schedule)
      if (audience) {
        const told = worthTelling(audience.tell, counts)
        this.deps.log.debug(told ? "scheduled batch's end told to its schedule's people" : "scheduled batch's end told to nobody: its schedule does not ask for it", { batch: batch.id, schedule: batch.schedule, failed: n('failed'), succeeded: n('succeeded'), tell: audience.tell })
        if (told) event.to = peopleOf(audience)
      } else if (EMAIL.test(batch.actor)) event.to = [{ person: batch.actor }]
    }
    return event
  }

  /**
   * The event of a change set: one for the whole set. Asked, it is for every
   * person who may approve all of it, with the set's own approve and reject
   * calls; decided or ended, for whoever asked, unless they decided it.
   * `again` tells a set that still waits, once more.
   */
  private async setEvent(row: Row, again = false): Promise<NoticeEvent | null> {
    const id = typeof row.detail.set === 'string' ? row.detail.set : null
    const told = id ? await this.deps.sets.told(id, true) : null
    if (!told) return null
    const { summary: set, named: deciders } = told
    const n = (k: keyof typeof set.counts) => set.counts[k] ?? 0
    const asked = row.kind === 'action.set_requested'
    const kind = asked ? 'action.set_awaiting_approval' : row.kind === 'action.set_finished' ? (n('failed') ? 'action.set_failed' : n('unknown') ? 'action.set_unknown' : 'action.set_succeeded') : row.kind
    // A set asked is told while it still waits; once decided there is nothing to decide.
    if (asked && set.decision !== 'pending') return null
    const many = (count: number, one: string) => `${count.toLocaleString('en-US')} ${count === 1 ? one : `${one}s`}`
    const who = row.actor ?? 'Someone'
    const title = {
      'action.set_awaiting_approval': `${set.title}: ${many(set.size, 'change')} ${again ? 'still wait' : 'wait'} for approval`,
      'action.set_approved': `${who} approved ${set.title}`,
      'action.set_rejected': `${who} rejected ${set.title}`,
      'action.set_withdrawn': `${set.title} was withdrawn`,
      'action.set_succeeded': `${set.title}: all ${many(set.size, 'change')} done`,
      'action.set_failed': `${set.title}: ${n('failed').toLocaleString('en-US')} of ${many(set.size, 'change')} failed`,
      'action.set_unknown': `${set.title}: ${n('unknown').toLocaleString('en-US')} of ${many(set.size, 'change')} not known`,
    }[kind] ?? set.title
    const facts: NoticeEvent['facts'] = [{ name: 'Asked by', value: set.by }, { name: 'Changes', value: String(set.size) }, ...set.actions.map((a) => ({ name: a.title, value: many(a.runs, 'change') }))]
    if (kind === 'action.set_failed' || kind === 'action.set_unknown' || kind === 'action.set_succeeded') for (const [s, name] of [['succeeded', 'Succeeded'], ['failed', 'Failed'], ['unknown', 'Outcome unknown'], ['cancelled', 'Cancelled']] as const) if (n(s)) facts.push({ name, value: String(n(s)) })
    if (set.decidedBy && !asked) facts.push({ name: 'Decided by', value: set.decidedBy })
    const event: NoticeEvent = {
      kind,
      key: again ? `remind:set:${set.id}` : `change:${row.id}`,
      title,
      facts: facts.slice(0, 20),
      links: [{ title: asked ? 'Review the change set' : 'Open the change set', url: set.url }],
      labels: { set: set.id, ...Object.fromEntries(set.actions.slice(0, 5).map((a, i) => [`action${i ? i + 1 : ''}`, a.id])) },
      weight: weightOf(kind),
      at: row.at.toISOString(),
    }
    if (set.note && asked) event.text = set.note.slice(0, 4000)
    if (kind === 'action.set_rejected' && typeof row.detail.reason === 'string') event.text = `Why: ${row.detail.reason}`
    if (kind === 'action.set_failed' || kind === 'action.set_unknown') event.severity = 'warning'
    const group = this.config.approvers ? [{ group: this.config.approvers }] : []
    if (asked) {
      const at = `/v1/change-sets/${encodeURIComponent(set.id)}`
      event.actions = [
        { title: 'Approve all', path: `${at}/approve`, style: 'positive', done: 'approved' },
        { title: 'Reject', path: `${at}/reject`, style: 'destructive', done: 'rejected' },
      ]
      // As for a run alone: the people a rule names, or the approvers group when it names nobody or more than one event may be addressed to.
      const named = deciders.filter((p) => EMAIL.test(p))
      const to = !named.length || (named.length > TO_MAX && group.length) ? group : named.slice(0, TO_MAX).map((person) => ({ person }))
      if (to.length) event.to = to
    } else if (kind !== 'action.set_withdrawn' && row.actor !== set.by && EMAIL.test(set.by)) event.to = [{ person: set.by }]
    return event
  }

  /** An input's value as a card shows it: an entity by its title, a list joined, nothing for an empty one. */
  private async shown(value: unknown): Promise<string | null> {
    if (value === null || value === undefined || value === '') return null
    if (Array.isArray(value)) {
      const parts = (await Promise.all(value.map((v) => this.shown(v)))).filter((v): v is string => v !== null)
      return parts.length ? parts.join(', ') : null
    }
    if (typeof value === 'string') {
      const ref = parseEntityId(value)
      if (ref) {
        const e = await this.deps.reader.get(ref)
        if (e) return e.title
      }
      return value.slice(0, 500)
    }
    if (typeof value === 'object') return JSON.stringify(value).slice(0, 500)
    return String(value)
  }
}

