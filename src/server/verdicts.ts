// The watch's verdicts on the changes this hub stated, as the estate's watch
// posts them: `change.observed` events, each about one run's change. A batch
// is checked whole before any of it is kept, so a refusal names the first
// event it cannot take and keeps none. Each event is read strictly against
// the platform kit's contract, must name a change.stated event this hub sent
// with that change's digest, and is the sending source's: the sender is the
// source's own id, whatever the body says. One is kept once for each sender
// and key, as an activity row with its run, and laid on the safe paths it
// went through. The watch sends its verdict to Annals itself, so the Annals
// forwarder leaves these rows out.

import { CHANGE_SENDER, readObserved, type ChangeObserved } from '../shared/change.ts'
import type { Actions } from './actions.ts'
import { record } from './activity.ts'
import type { Db } from './db.ts'
import type { Logger } from './log.ts'
import type { SafePaths } from './safe-paths.ts'

/** The most events one post carries. */
export const VERDICTS_MAX = 100

/** A batch the hub took: how many it kept, and how many it already held. */
export interface Taken {
  kept: number
  duplicate: number
}

/** A batch the hub refused whole: why, and the index of the first event it could not take. */
export class VerdictRefused extends Error {
  readonly index: number

  constructor(index: number, reason: string) {
    super(`events[${index}]: ${reason}`)
    this.index = index
  }
}

/** The run a stated key of this hub's names: `<run>.stated`, as the hub keys its change.stated events. */
const STATED = /^(.+)\.stated$/

interface Checked {
  event: ChangeObserved
  run: { id: string; action: string; entity: { blueprint: string; key: string } | null }
}

export interface VerdictsDeps {
  db: Db
  actions: Pick<Actions, 'getRun'>
  safePaths: Pick<SafePaths, 'apply'>
  log: Logger
}

export class Verdicts {
  private readonly deps: VerdictsDeps

  constructor(deps: VerdictsDeps) {
    this.deps = deps
  }

  /** Takes a batch from `sender`, the source that posted it. Throws `VerdictRefused` before it keeps anything. */
  async take(sender: string, events: unknown[]): Promise<Taken> {
    const checked: Checked[] = []
    for (const [i, raw] of events.entries()) checked.push(await this.check(sender, raw, i))
    const taken: Taken = { kept: 0, duplicate: 0 }
    for (const c of checked) {
      if (await this.held(sender, c.event.key)) {
        taken.duplicate++
        this.deps.log.debug('verdict already kept', { sender, key: c.event.key, run: c.run.id })
        continue
      }
      // Laid on first: a verdict kept and never laid on would be a duplicate when it came again. Laying one on twice moves nothing.
      const paths = await this.deps.safePaths.apply(c.event, c.run.id)
      if (await this.keep(sender, c)) {
        taken.kept++
        this.deps.log.info('verdict kept', { sender, key: c.event.key, run: c.run.id, action: c.run.action, sights: c.event.sights?.length ?? 0, incidents: c.event.incidents?.length ?? 0, ...paths })
      } else taken.duplicate++
    }
    return taken
  }

  /** The event as the hub keeps it, or the refusal of the batch at its index. */
  private async check(sender: string, raw: unknown, index: number): Promise<Checked> {
    const read = readObserved(raw)
    if (!read.ok) throw new VerdictRefused(index, read.error)
    const event = read.event
    if (event.sender !== sender) this.deps.log.info('verdict sent under another name: kept as the source that posted it', { sender, said: event.sender, key: event.key })
    if (event.of.sender !== CHANGE_SENDER) throw new VerdictRefused(index, `of.sender is ${event.of.sender}: this hub takes verdicts on the changes it stated, sent as ${CHANGE_SENDER}`)
    const id = STATED.exec(event.of.key)?.[1]
    const run = id ? await this.deps.actions.getRun(id) : null
    if (!run?.statementDigest) throw new VerdictRefused(index, `of.key ${event.of.key} names no change this hub stated`)
    if (run.statementDigest !== event.digest) throw new VerdictRefused(index, `digest is ${event.digest}, the change ${event.of.key} stated ${run.statementDigest}`)
    return { event: { ...event, sender }, run: { id: run.id, action: run.action, entity: run.entity } }
  }

  private async held(sender: string, key: string): Promise<boolean> {
    const found = await this.deps.db.query(`SELECT 1 FROM changes WHERE kind = 'change.observed' AND source = $1 AND detail->'event'->>'key' = $2`, [sender, key])
    return !!found.rowCount
  }

  /** Keeps the event with its run. False when another post kept the same one first. */
  private async keep(sender: string, c: Checked): Promise<boolean> {
    try {
      await record(this.deps.db, 'change.observed', c.run.entity, sender, null, { action: c.run.action, run: c.run.id, event: c.event })
      return true
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') return false
      throw error
    }
  }
}
