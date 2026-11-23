// Which hub runs the background work. During a rollout two hubs serve side
// by side; only the one holding this advisory lock runs the passes, and the
// lock passes to the new hub when the old one lets go as it stops.

import { setTimeout as sleep } from 'node:timers/promises'
import pg from 'pg'
import { clientConfig, type Connection, LOCK_SPACE } from './db.ts'
import type { Logger } from './log.ts'

const LEADER_LOCK = 2

export interface LeaderHandlers {
  /** This hub now runs the background work. Another hub may have changed things it keeps in memory. */
  lead: () => Promise<void>
  /** This hub no longer does; resolves once its running passes have finished. */
  follow: () => Promise<void>
}

/**
 * Holds the leader lock on a connection of its own, since an advisory lock
 * lives as long as the session that took it. A hub that cannot take it asks
 * again every `retryMs`. A hub whose connection drops has lost the lock and
 * stops leading at once.
 */
export class Leadership {
  private readonly connection: Connection
  private readonly log: Logger
  private readonly retryMs: number
  private client: pg.Client | null = null
  private leading = false
  private stopped = false
  /** The step running now: taking the lock, or giving up leading. */
  private step: Promise<void> = Promise.resolve()
  private handlers: LeaderHandlers | null = null

  constructor(connection: Connection, log: Logger, retryMs = 5_000) {
    this.connection = connection
    this.log = log
    this.retryMs = retryMs
  }

  get isLeader(): boolean {
    return this.leading
  }

  start(handlers: LeaderHandlers): void {
    this.handlers = handlers
    void this.loop()
  }

  /** Stops asking; a leader stops its work, then lets go of the lock for the next hub. */
  async stop(): Promise<void> {
    this.stopped = true
    await this.step
    if (this.leading) await this.stepDown('stopping')
    const client = this.client
    this.client = null
    if (client) {
      await client.query('SELECT pg_advisory_unlock($1, $2)', [LOCK_SPACE, LEADER_LOCK]).catch(() => undefined)
      await client.end().catch(() => undefined)
    }
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      await this.step
      if (!this.leading && !this.stopped) {
        this.step = this.tryLead()
        await this.step
      }
      if (!this.stopped) await sleep(this.retryMs)
    }
  }

  private async tryLead(): Promise<void> {
    try {
      const client = await this.connect()
      const got = (await client.query<{ got: boolean }>('SELECT pg_try_advisory_lock($1, $2) AS got', [LOCK_SPACE, LEADER_LOCK])).rows[0]!.got
      if (!got || this.stopped) {
        if (got) await client.query('SELECT pg_advisory_unlock($1, $2)', [LOCK_SPACE, LEADER_LOCK])
        return
      }
      this.leading = true
      this.log.info('leading: this hub runs the background work')
      await this.handlers!.lead()
    } catch (error) {
      this.log.warn('leader lock not taken', { error })
    }
  }

  private async connect(): Promise<pg.Client> {
    if (this.client) return this.client
    const client = new pg.Client({ ...clientConfig(this.connection), keepAlive: true })
    // A dropped connection takes the lock with it: another hub may already lead.
    client.on('error', (error) => this.lost(client, error))
    client.on('end', () => this.lost(client, null))
    await client.connect()
    this.client = client
    return client
  }

  private lost(client: pg.Client, error: Error | null): void {
    if (this.client !== client) return
    this.client = null
    if (this.leading && !this.stopped) {
      this.log.warn('leader connection lost: stopping the background work', { error })
      this.step = this.stepDown('connection lost')
    }
  }

  private async stepDown(reason: string): Promise<void> {
    this.leading = false
    this.log.info('following: another hub may run the background work', { reason })
    await this.handlers!.follow()
  }
}
