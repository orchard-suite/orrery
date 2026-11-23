// What one hub tells the others on its database, over Postgres LISTEN and
// NOTIFY, so hubs that serve side by side, as an API hub and a worker do,
// stay one hub to whoever reads them. Two things travel. A table a hub keeps
// in memory changed: the database says so itself (the triggers in
// `0008-definitions-notify.sql`), and each other hub reads it again. And the
// events a hub emits: each other hub tells them to its own listeners, after
// it has read again whatever changed before them.

import pg from 'pg'
import { setTimeout as sleep } from 'node:timers/promises'
import type { ServerEvent } from '../shared/api.ts'
import { clientConfig, type Db } from './db.ts'
import type { Events } from './events.ts'
import type { Logger } from './log.ts'

const EVENTS = 'orrery_events'
const DEFINITIONS = 'orrery_definitions'
/** NOTIFY carries at most 8000 bytes; a message of events stays well under it. */
const MAX_MESSAGE = 6000
/** How long emitted events wait to be sent together. */
const SEND_AFTER_MS = 20
const RETRY_MS = 5_000
/** How long after a reading-again this hub's own change may still have been overwritten by it. */
const OWN_CHANGE_MS = 2_000

export interface BridgeHooks {
  /** Reads again what this hub keeps in memory of these tables. */
  reload(tables: ReadonlySet<string>): Promise<void>
  /** Reads everything again and drops every kept answer: the connection was down, and what was said meanwhile is lost. */
  catchUp(): Promise<void>
}

export class Bridge {
  private readonly db: Db
  private readonly events: Events
  private readonly log: Logger
  private readonly hooks: BridgeHooks
  private client: pg.Client | null = null
  private stopped = false
  /** Tables changed elsewhere and not read again yet. */
  private changed = new Set<string>()
  /** The reading-again running now. */
  private reading: Promise<void> | null = null
  /** When the last reading-again ended. */
  private readAt = 0
  /** What was heard is handled in the order it came. */
  private heard: Promise<void> = Promise.resolve()
  private outbox: ServerEvent[] = []
  private sending: NodeJS.Timeout | null = null

  constructor(db: Db, events: Events, log: Logger, hooks: BridgeHooks) {
    this.db = db
    this.events = events
    this.log = log
    this.hooks = hooks
  }

  /** Starts listening, and sends on every event this hub emits from here on. */
  async start(): Promise<void> {
    await this.connect()
    this.events.forward = (event) => this.send(event)
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.events.forward = null
    if (this.sending) clearTimeout(this.sending)
    await this.flush()
    await this.heard.catch(() => undefined)
    await this.reading
    const client = this.client
    this.client = null
    await client?.end().catch(() => undefined)
  }

  /** Resolves once everything heard so far is handled. */
  async settled(): Promise<void> {
    await this.heard
    while (this.reading) await this.reading
  }

  private async connect(): Promise<void> {
    const client = new pg.Client({ ...clientConfig(this.db.connection), keepAlive: true })
    client.on('error', (error) => this.lost(client, error))
    client.on('end', () => this.lost(client, null))
    client.on('notification', (n) => {
      if (n.channel === DEFINITIONS) this.definitions(n.payload ?? '')
      else if (n.channel === EVENTS) this.heard = this.heard.then(() => this.message(n.payload ?? '')).catch((error: unknown) => this.log.warn('could not handle what another hub said', { error }))
    })
    await client.connect()
    await client.query(`LISTEN ${EVENTS}`)
    await client.query(`LISTEN ${DEFINITIONS}`)
    this.client = client
  }

  private lost(client: pg.Client, error: Error | null): void {
    if (this.client !== client || this.stopped) return
    this.client = null
    this.log.warn('connection to the other hubs lost; connecting again', { error })
    void (async () => {
      while (!this.stopped && !this.client) {
        try {
          await this.connect()
          await this.hooks.catchUp()
          this.log.info('connected to the other hubs again, and caught up')
        } catch (error) {
          this.log.warn('could not connect to the other hubs', { error })
          await sleep(RETRY_MS)
        }
      }
    })()
  }

  /**
   * A table changed. One another hub changed is read again. This hub's own
   * change is already in its memory, unless a reading-again is under way or
   * just ended: that one may have read the table before the change and put
   * the old rows back, so the table is read once more.
   */
  private definitions(payload: string): void {
    const at = payload.lastIndexOf(' ')
    const [hub, table] = [payload.slice(0, at), payload.slice(at + 1)]
    if (hub === this.db.name && !this.reading && !this.changed.size && Date.now() - this.readAt > OWN_CHANGE_MS) return
    this.changed.add(table)
    this.reading ??= this.readAgain().finally(() => {
      this.reading = null
      this.readAt = Date.now()
    })
  }

  private async readAgain(): Promise<void> {
    while (this.changed.size && !this.stopped) {
      const tables = this.changed
      this.changed = new Set()
      try {
        await this.hooks.reload(tables)
      } catch (error) {
        this.log.warn('could not read again what another hub changed; trying again', { tables: [...tables], error })
        for (const t of tables) this.changed.add(t)
        await sleep(RETRY_MS)
      }
    }
  }

  /** Events another hub emitted, told here once what changed before them is read again. */
  private async message(payload: string): Promise<void> {
    const { from, events } = JSON.parse(payload) as { from: string; events: ServerEvent[] }
    if (from === this.db.name) return
    while (this.reading) await this.reading
    for (const event of events) this.events.deliver(event)
  }

  private send(event: ServerEvent): void {
    this.outbox.push(event)
    this.sending ??= setTimeout(() => {
      this.sending = null
      void this.flush()
    }, SEND_AFTER_MS)
  }

  private async flush(): Promise<void> {
    const events = this.outbox.splice(0)
    if (!events.length) return
    const messages: string[] = []
    let batch: string[] = []
    let size = 0
    const close = () => {
      if (batch.length) messages.push(`{"from":${JSON.stringify(this.db.name)},"events":[${batch.join(',')}]}`)
      batch = []
      size = 0
    }
    for (const event of events) {
      // One too long to send is sent as the event that reads everything again.
      const text = JSON.stringify(event)
      const fits = text.length <= MAX_MESSAGE ? text : JSON.stringify({ type: 'estate' } satisfies ServerEvent)
      if (size + fits.length > MAX_MESSAGE) close()
      batch.push(fits)
      size += fits.length
    }
    close()
    try {
      await this.db.query('SELECT pg_notify($1, m) FROM unnest($2::text[]) AS m', [EVENTS, messages])
    } catch (error) {
      this.log.warn('events not sent to the other hubs', { events: events.length, error })
    }
  }
}
