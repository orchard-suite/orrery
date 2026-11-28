// Forwards the activity log to Annals: every row a person or a
// token wrote, and every row that changes the model, the sources, the
// secrets, who may do what, or an action, whoever wrote it. The inventory
// that pushers and the hub's own passes write is left out: it is the estate
// changing, not someone acting on it.
//
// A run's change events (`change.stated`, `.routed`, `.decided`, `.ended`)
// go as Annals' change records: keyed by the event's own key, caused by the
// stated event, with the things and effects the statement names and its
// digest as the change's hash.
//
// The watch's verdict on a change (`change.observed`) is kept here too, and
// left out: the watch sends it to Annals itself, so it is never there twice.
//
// The rows are already written when a pass runs, so an Annals that is down
// loses nothing. A pass sends every row after a mark and moves the mark only
// past rows logged more than a minute ago, so a row whose transaction
// commits late is still sent; Annals keeps one copy of each `event_key`.
//
// One bad row never holds up the rest. An event Annals refuses in a batch is
// logged and passed over. A batch Annals refuses whole, as one it cannot
// read or one too large, is sent again in halves until the row it cannot
// take is alone, and that row alone is logged and passed over. An Annals
// that is down, or could not store what it took, keeps the mark where it is,
// and the next pass sends the same rows again.

import type { Db } from './db.ts'
import type { Logger } from './log.ts'
import { fetchTimed, recordAnnals } from './metrics.ts'
import { eventOfRow } from './change-events.ts'
import { markOf, moveMark, settledCeiling } from './log-mark.ts'
import type { ChangeEvent, ChangeReason, ChangeStatement } from '../shared/change.ts'

export interface AnnalsConfig {
  /** Annals' API port, such as http://annals-api.annals.svc:8081. */
  url: string
  /** A token Annals issued for the source `orrery`. */
  token: string
}

/** The categories forwarded whoever wrote the row. */
const GOVERNANCE = ['model', 'layout', 'sources', 'secrets', 'access', 'actions']
/** The actor kinds whose every row is forwarded. */
const ACTORS = ['user', 'token']
/** The rows of what another member told the hub and tells Annals itself: the watch's verdict on a change. */
const HEARD_ELSEWHERE = ['change.observed']
/** Events in one POST; Annals takes up to 1000. */
const BATCH = 500
const MARK_KEY = 'annals.forwarded'
/** Annals' limit on a reason or a title, in bytes. */
const TEXT_MAX = 512
/** Annals' limits on a label's value, and on the things one event names besides its target. */
const LABEL_MAX = 63
const ITEMS_MAX = 100

interface Row {
  id: string
  at: Date
  kind: string
  category: string
  outcome: 'ok' | 'refused' | 'failed'
  blueprint: string | null
  key: string | null
  source: string | null
  actor: string | null
  actor_kind: 'user' | 'token' | 'source' | 'hub'
  detail: Record<string, unknown>
}

/** One Annals event, as docs/event.md in Annals describes it. */
export interface AnnalsEvent {
  at: string
  source: 'orrery'
  event_key: string
  actor: { kind: 'person' | 'agent' | 'system'; id: string; email?: string; on_behalf_of?: string }
  authority?: { approval: { required: true; by: string; at: string } }
  action: { verb: string; target: { system: 'orrery'; kind: string; id: string; title?: string }; outcome: Row['outcome']; reason?: string }
  /** The event_key of the record that set this one off, and its source when that is another sender's. */
  cause?: string
  cause_source?: string
  /** Things the event touched besides its target: a change's catalog entities. */
  items?: { system: string; kind: string; id: string }[]
  /** What a change was stated to do to each live thing. */
  effects?: { kind: string; subject: { blueprint: string; key: string }; path: string; size?: number; undo: string; claim: string }[]
  change?: { after_hash: string }
  labels: Record<string, string>
}

interface Receipt {
  index: number
  /** `failed` is Annals' own failure to store a valid event: it is sent again, never passed over. */
  status: 'stored' | 'duplicate' | 'refused' | 'failed'
  reason?: string
}

/** The answers that refuse what was posted, whole: a body Annals cannot read, and one too large. */
const REFUSED_WHOLE = new Set([400, 413])

export class AnnalsForwarder {
  private readonly db: Db
  private readonly config: AnnalsConfig
  private readonly log: Logger
  private readonly post: typeof fetch

  constructor(db: Db, config: AnnalsConfig, log: Logger, post: typeof fetch = (input, init) => fetchTimed('annals', input as string | URL, init)) {
    this.db = db
    this.config = config
    this.log = log
    this.post = post
  }

  /**
   * Sends every forwarded row after the mark, then moves the mark to the
   * newest row logged more than a minute ago. A failed post throws before the
   * mark moves, so the next pass sends the same rows again.
   */
  async pass(): Promise<number> {
    const mark = await markOf(this.db, MARK_KEY)
    const ceiling = await settledCeiling(this.db)
    let sent = 0
    let after = mark
    for (;;) {
      const rows = await this.db.query<Row>(
        `SELECT id, at, kind, category, outcome, blueprint, key, source, actor, actor_kind, detail
           FROM changes
          WHERE id > $1 AND (category = ANY($2) OR actor_kind = ANY($3)) AND kind <> ALL($5)
          ORDER BY id LIMIT $4`,
        [after, GOVERNANCE, ACTORS, BATCH, HEARD_ELSEWHERE],
      )
      if (!rows.rows.length) break
      sent += await this.send(rows.rows.map(toEvent))
      after = rows.rows.at(-1)!.id
      if (rows.rows.length < BATCH) break
    }
    await moveMark(this.db, MARK_KEY, mark, ceiling)
    if (sent) this.log.info('annals forwarded', { events: sent, mark: ceiling ?? mark })
    return sent
  }

  /**
   * Posts one batch and counts what Annals holds of it. An event Annals
   * refuses is logged and passed over: posting it again would be refused
   * again. A batch refused whole is posted again in halves, so only the row
   * Annals cannot take is passed over. Anything else that is not stored
   * throws, before the mark moves.
   */
  private async send(events: AnnalsEvent[]): Promise<number> {
    const res = await this.post(`${this.config.url.replace(/\/+$/, '')}/v1/events`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.config.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(events),
      signal: AbortSignal.timeout(30_000),
    })
    if (REFUSED_WHOLE.has(res.status)) {
      const answer = (await res.text()).slice(0, 200)
      if (events.length === 1) {
        recordAnnals('refused', 1)
        this.log.warn('annals refused an activity row', { eventKey: events[0]!.event_key, status: res.status, reason: answer })
        return 0
      }
      this.log.warn('annals refused a batch whole; sending it in halves to find the rows it cannot take', { events: events.length, status: res.status, reason: answer })
      const half = Math.ceil(events.length / 2)
      return (await this.send(events.slice(0, half))) + (await this.send(events.slice(half)))
    }
    if (!res.ok) {
      recordAnnals('failed', events.length)
      throw new Error(`Annals answered ${res.status}: ${(await res.text()).slice(0, 200)}`)
    }
    const { results } = (await res.json()) as { results: Receipt[] }
    let held = 0
    let unstored = 0
    results.forEach((r, i) => {
      recordAnnals(r.status, 1)
      if (r.status === 'stored' || r.status === 'duplicate') held++
      else if (r.status === 'refused') this.log.warn('annals refused an activity row', { eventKey: events[i]?.event_key, status: r.status, reason: r.reason })
      else unstored++
    })
    // What Annals took and did not store is sent again from the same mark; what it stored comes back a duplicate.
    if (unstored) throw new Error(`Annals did not store ${unstored} of ${events.length} events`)
    return held
  }
}

/** An address Annals takes as an email. */
const EMAIL = /^[^\s@<>"']+@[^\s@<>"']+\.[A-Za-z]{2,}$/

/**
 * A person, by the email they sign in with, which is also their id here. The
 * email goes in its own field too, so Annals' people directory finds the
 * person whichever id they were posted as. A user that is not an address,
 * such as the built-in hub or an agent's account, is a system.
 */
function person(id: string): AnnalsEvent['actor'] {
  return EMAIL.test(id) && id.length <= 256 ? { kind: 'person', id, email: id.toLowerCase() } : { kind: 'system', id }
}

/** The rows that are a person's answer to a run that waited for one. */
const DECISIONS = new Set(['action.approved', 'action.declined', 'action.returned'])

/** Annals' shape of one activity row. */
export function toEvent(row: Row): AnnalsEvent {
  const change = eventOfRow(row.kind, row.detail)
  if (change) return changeRecord(change, text(row.detail.reason))
  const d = row.detail
  const action = text(d.action)
  // A product that carried a person's request is the one that acted, for them.
  const via = text(d.via)
  const actor: AnnalsEvent['actor'] = row.actor_kind === 'user' && row.actor
    ? via
      ? { kind: 'system', id: `token:${via}`, on_behalf_of: row.actor }
      : person(row.actor)
    : { kind: 'system', id: row.actor_kind === 'token' && row.actor ? `token:${row.actor}` : row.source ? `source:${row.source}` : 'orrery' }
  const at = row.at.toISOString()
  const event: AnnalsEvent = {
    at,
    source: 'orrery',
    event_key: `change:${row.id}`,
    actor,
    action: { verb: row.kind, target: clipTarget(targetOf(row)), outcome: row.outcome },
    labels: { category: row.category, actor_kind: row.actor_kind, ...(action ? { action: clip(action, 64) } : {}) },
  }
  if (row.outcome !== 'ok') event.action.reason = clip(reasonOf(row), TEXT_MAX)
  if (DECISIONS.has(row.kind) && row.actor) event.authority = { approval: { required: true, by: row.actor, at } }
  return event
}

/**
 * Annals' shape of one change event. Each is a record of its own, about the
 * change its stated event names: who stated it, the route the judge gave,
 * each yes or no, and how it ended. Every event but the stated one names that
 * event as its cause; the stated one alone carries the things and effects.
 * `reason` is why a change that ended did not go well, as the hub said it.
 */
export function changeRecord(e: ChangeEvent, reason?: string): AnnalsEvent {
  const stated = e.event === 'change.stated' ? e.key : e.of!.key
  const event: AnnalsEvent = {
    at: e.at,
    source: 'orrery',
    event_key: e.key,
    actor: { kind: 'system', id: 'orrery' },
    action: { verb: e.event, target: { system: 'orrery', kind: 'change', id: clip(stated, 256) }, outcome: 'ok' },
    change: { after_hash: e.digest },
    labels: {},
  }
  if (e.event !== 'change.stated') {
    event.cause = e.of!.key
    event.cause_source = e.of!.sender
  }
  switch (e.event) {
    case 'change.stated': {
      const s = e.statement
      event.actor = actorOf(s.actor)
      event.items = (s.things ?? []).slice(0, ITEMS_MAX).map((t) => ({ system: 'catalog', kind: t.blueprint, id: t.key }))
      event.effects = (s.effects ?? []).map(effectOf)
      event.labels = { applier: s.applier, writer: clip(s.writer.name, LABEL_MAX) }
      break
    }
    case 'change.routed':
      event.labels = { route: e.route.to, ...(e.route.to === 'people' ? { quorum: String(e.route.quorum) } : {}), ...(e.judge ? { judge: clip(e.judge.name, LABEL_MAX), pack: clip(e.judge.pack, LABEL_MAX) } : {}), ...fencesOf(e.reasons) }
      break
    case 'change.decided':
      event.actor = person(e.by.id)
      event.labels = { answer: e.answer }
      break
    case 'change.ended':
      event.action.outcome = e.outcome
      if (e.outcome !== 'ok') event.action.reason = clip(`${reason ?? (e.outcome === 'refused' ? 'refused' : 'failed')}${e.differs?.length ? `; it differed in ${e.differs.join(', ')}` : ''}`, TEXT_MAX)
      event.labels = { check: e.check }
      break
  }
  return event
}

/** The fences a route names, as one label: absent when none sent the change to people. */
function fencesOf(reasons: ChangeReason[] | undefined): { fences?: string } {
  const fences = [...new Set((reasons ?? []).flatMap((r) => (r.fence ? [r.fence] : [])))]
  return fences.length ? { fences: fences.join(',') } : {}
}

/** Who stated a change: a person by their address, an agent or a system by its name, with whoever it acts for. */
function actorOf(a: ChangeStatement['actor']): AnnalsEvent['actor'] {
  if (a.kind === 'person') return person(a.id)
  return { kind: a.kind, id: a.id, ...(a.on_behalf_of ? { on_behalf_of: a.on_behalf_of } : {}) }
}

function effectOf(e: NonNullable<ChangeStatement['effects']>[number]): NonNullable<AnnalsEvent['effects']>[number] {
  return { kind: e.kind, subject: { blueprint: e.subject.blueprint, key: e.subject.key }, path: e.path, ...(e.size !== undefined ? { size: e.size } : {}), undo: e.undo, claim: e.claim.from }
}

/** What a row is about: an entity, a run, or the thing its kind names. */
function targetOf(row: Row): AnnalsEvent['action']['target'] {
  const d = row.detail
  const on = (kind: string, id: string | undefined, title?: string) => ({ system: 'orrery' as const, kind, id: id ?? row.kind, ...(title ? { title } : {}) })
  if (row.blueprint && row.key) return on(row.blueprint, row.key)
  const run = text(d.run)
  if (run) return on(row.category === 'actions' ? 'action_run' : 'run', run, text(d.action))
  switch (row.kind.split('.')[0]) {
    case 'action':
      return on('action', text(d.action))
    case 'role':
      return on('role', text(d.role))
    case 'token':
      return on('token', text(d.name) ?? text(d.token))
    case 'secret':
      return on('secret', text(d.name))
    case 'source':
      return on('source', row.source ?? undefined)
    case 'access':
      return on('access', text(d.viewed) ?? text(d.viewAs) ?? text(d.listFor) ?? row.blueprint ?? text(d.path))
  }
  return row.blueprint ? on('blueprint', row.blueprint) : on(row.category, undefined)
}

/** Why a row did not go well: its own reason or summary, else what was answered. */
function reasonOf(row: Row): string {
  const d = row.detail
  const status = typeof d.status === 'number' ? `answered ${d.status}` : undefined
  return text(d.reason) ?? text(d.summary) ?? status ?? text(d.error) ?? text(d.state) ?? row.kind
}

function text(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined
}

function clipTarget<T extends { id: string; title?: string }>(t: T): T {
  return { ...t, id: clip(t.id, 256), ...(t.title ? { title: clip(t.title, TEXT_MAX) } : {}) }
}

/** One line within `max` bytes, never cutting a character in half. */
export function clip(s: string, max: number): string {
  const line = s.replace(/[\r\n]+/g, ' ')
  const bytes = new TextEncoder().encode(line)
  if (bytes.length <= max) return line
  let cut = max
  while (cut > 0 && (bytes[cut]! & 0xc0) === 0x80) cut--
  return new TextDecoder().decode(bytes.slice(0, cut))
}
