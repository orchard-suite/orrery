// Forwards the activity log to Annals: every row a person or a
// token wrote, and every row that changes the model, the sources, the
// secrets, who may do what, or an action, whoever wrote it. The inventory
// that pushers and the hub's own passes write is left out: it is the estate
// changing, not someone acting on it.
//
// The rows are already written when a pass runs, so an Annals that is down
// loses nothing. A pass sends every row after a mark and moves the mark only
// past rows logged more than a minute ago, so a row whose transaction
// commits late is still sent; Annals keeps one copy of each `event_key`.

import type { Db } from './db.ts'
import type { Logger } from './log.ts'
import { fetchTimed, recordAnnals } from './metrics.ts'

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
/** Events in one POST; Annals takes up to 1000. */
const BATCH = 500
/** A row logged this recently may sit behind one whose transaction has not committed. */
const SETTLE_SECONDS = 60
const MARK_KEY = 'annals.forwarded'
/** Annals' limit on a reason or a title, in bytes. */
const TEXT_MAX = 512

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
  actor: { kind: 'person' | 'system'; id: string; email?: string; on_behalf_of?: string }
  authority?: { approval: { required: true; by: string; at: string } }
  action: { verb: string; target: { system: 'orrery'; kind: string; id: string; title?: string }; outcome: Row['outcome']; reason?: string }
  labels: Record<string, string>
}

interface Receipt {
  index: number
  status: 'stored' | 'duplicate' | 'refused' | 'error'
  reason?: string
}

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
    const mark = await this.mark()
    const settled = await this.db.query<{ id: string | null }>(`SELECT max(id) AS id FROM changes WHERE coalesce(logged_at, at) < clock_timestamp() - make_interval(secs => $1)`, [SETTLE_SECONDS])
    const ceiling = settled.rows[0]?.id ?? null
    let sent = 0
    let after = mark
    for (;;) {
      const rows = await this.db.query<Row>(
        `SELECT id, at, kind, category, outcome, blueprint, key, source, actor, actor_kind, detail
           FROM changes
          WHERE id > $1 AND (category = ANY($2) OR actor_kind = ANY($3))
          ORDER BY id LIMIT $4`,
        [after, GOVERNANCE, ACTORS, BATCH],
      )
      if (!rows.rows.length) break
      sent += await this.send(rows.rows.map(toEvent))
      after = rows.rows.at(-1)!.id
      if (rows.rows.length < BATCH) break
    }
    if (ceiling && BigInt(ceiling) > BigInt(mark)) {
      await this.db.query(`INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [MARK_KEY, JSON.stringify({ id: ceiling })])
    }
    if (sent) this.log.info('annals forwarded', { events: sent, mark: ceiling ?? mark })
    return sent
  }

  private async mark(): Promise<string> {
    const row = await this.db.query<{ value: { id: string } }>(`SELECT value FROM settings WHERE key = $1`, [MARK_KEY])
    return row.rows[0]?.value.id ?? '0'
  }

  /** Posts one batch and counts what Annals holds of it. A refused event is logged and passed over: posting it again would be refused again. */
  private async send(events: AnnalsEvent[]): Promise<number> {
    const res = await this.post(`${this.config.url.replace(/\/+$/, '')}/v1/events`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.config.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(events),
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) {
      recordAnnals('failed', events.length)
      throw new Error(`Annals answered ${res.status}: ${(await res.text()).slice(0, 200)}`)
    }
    const { results } = (await res.json()) as { results: Receipt[] }
    let held = 0
    results.forEach((r, i) => {
      recordAnnals(r.status, 1)
      if (r.status === 'stored' || r.status === 'duplicate') held++
      else this.log.warn('annals refused an activity row', { eventKey: events[i]?.event_key, status: r.status, reason: r.reason })
    })
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
