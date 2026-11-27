// Carries every change event of a run (stated, routed, decided, ended) to the
// dispatch desk, where the watch takes up a change from the event that it
// ended. Each goes as the platform kit's event, read from the activity row
// that keeps it, in batches to `POST /v1/change-events`. The rows are the
// store: a pass sends every event after its mark and moves the mark only past
// rows a minute old, so an event waits in the log until the desk takes it, and
// none is dropped. A desk that is down, or that does not take the route yet,
// keeps the mark where it is, and the next pass sends the same events again;
// that never stops a run, and never the notices, which have a mark of their own.
//
// The desk answers 200 with how many it kept, or 400 naming the index of the
// first event it refuses, keeping none of the batch. A refused batch is sent
// again in halves until the event it cannot take is alone, and only that
// event is logged and passed over, so one bad event never holds up the rest.
// A 400 that names no index is no refusal of an event: the batch waits.

import { CHANGE_EVENTS, type ChangeEvent } from '../shared/change.ts'
import { eventOfRow } from './change-events.ts'
import type { Db } from './db.ts'
import type { Logger } from './log.ts'
import { markOf, moveMark, settledCeiling } from './log-mark.ts'
import { fetchTimed, recordDispatchChanges } from './metrics.ts'

export interface DispatchChangesConfig {
  /** The dispatch desk's API port, such as http://dispatch-api.dispatch.svc:8081. */
  url: string
  /** A token the desk issued. */
  token: string
}

const MARK_KEY = 'dispatch.change-events.forwarded'
/** Events in one post. */
const BATCH = 200

interface Row {
  id: string
  kind: string
  detail: Record<string, unknown>
}

/** What the desk said of a batch it did not keep: the first event it refuses, or nothing it named. */
async function refusedAt(res: Response): Promise<{ index: number | null; answer: string }> {
  const answer = (await res.text()).slice(0, 500)
  try {
    const body: unknown = JSON.parse(answer)
    const index = typeof body === 'object' && body !== null && 'index' in body ? body.index : null
    return { index: typeof index === 'number' && Number.isInteger(index) && index >= 0 ? index : null, answer }
  } catch {
    return { index: null, answer }
  }
}

export class DispatchChanges {
  private readonly db: Db
  private readonly config: DispatchChangesConfig
  private readonly log: Logger
  private readonly post: typeof fetch
  /** Rows above the mark this hub already sent: the mark waits for rows to settle, so they come up again until it passes them. */
  private readonly sent = new Set<string>()

  constructor(db: Db, config: DispatchChangesConfig, log: Logger, post: typeof fetch = (input, init) => fetchTimed('dispatch', input as string | URL, init)) {
    this.db = db
    this.config = config
    this.log = log
    this.post = post
  }

  /**
   * Sends every change event after the mark that this hub has not sent yet,
   * then moves the mark to the newest settled row. A post the desk does not
   * take throws before the mark moves. How many the desk kept.
   */
  async pass(): Promise<number> {
    const mark = await markOf(this.db, MARK_KEY)
    const ceiling = await settledCeiling(this.db)
    let kept = 0
    let after = mark
    for (;;) {
      const rows = await this.db.query<Row>(`SELECT id, kind, detail FROM changes WHERE id > $1 AND kind = ANY($2) ORDER BY id LIMIT $3`, [after, CHANGE_EVENTS, BATCH])
      if (!rows.rows.length) break
      after = rows.rows.at(-1)!.id
      const fresh = rows.rows.filter((r) => !this.sent.has(r.id))
      const events = fresh.flatMap((r) => {
        const e = eventOfRow(r.kind, r.detail)
        if (!e) this.log.warn('change row carries no change event; passed over', { change: r.id, kind: r.kind })
        return e ? [{ row: r.id, event: e }] : []
      })
      if (events.length) kept += await this.send(events)
      for (const r of fresh) this.sent.add(r.id)
      if (rows.rows.length < BATCH) break
    }
    if (await moveMark(this.db, MARK_KEY, mark, ceiling)) for (const id of this.sent) if (BigInt(id) <= BigInt(ceiling!)) this.sent.delete(id)
    if (kept) this.log.info('change events sent to dispatch', { events: kept, mark: ceiling ?? mark })
    return kept
  }

  /** Posts one batch. A batch refused at an index is sent again in halves; an event refused alone is logged and passed over. Anything else the desk does not keep throws. */
  private async send(batch: { row: string; event: ChangeEvent }[]): Promise<number> {
    const res = await this.post(`${this.config.url.replace(/\/+$/, '')}/v1/change-events`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.config.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ events: batch.map((b) => b.event) }),
      signal: AbortSignal.timeout(30_000),
    })
    if (res.status === 400) {
      const { index, answer } = await refusedAt(res)
      if (index === null) {
        recordDispatchChanges('failed', batch.length)
        throw new Error(`dispatch answered 400 and named no event it refuses: ${answer.slice(0, 200)}`)
      }
      if (batch.length === 1) {
        recordDispatchChanges('refused', 1)
        this.log.warn('dispatch refused a change event; passed over', { change: batch[0]!.row, key: batch[0]!.event.key, event: batch[0]!.event.event, reason: answer.slice(0, 200) })
        return 0
      }
      this.log.warn('dispatch refused a batch of change events; sending it in halves to find the one it cannot take', { events: batch.length, index, reason: answer.slice(0, 200) })
      const half = Math.ceil(batch.length / 2)
      return (await this.send(batch.slice(0, half))) + (await this.send(batch.slice(half)))
    }
    if (!res.ok) {
      recordDispatchChanges('failed', batch.length)
      throw new Error(`dispatch answered ${res.status}: ${(await res.text()).slice(0, 200)}`)
    }
    const body = (await res.json().catch(() => ({}))) as { kept?: unknown }
    const kept = typeof body.kept === 'number' ? body.kept : batch.length
    recordDispatchChanges('kept', kept)
    if (kept < batch.length) recordDispatchChanges('duplicate', batch.length - kept)
    return kept
  }
}
