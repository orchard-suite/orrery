// The safe paths of the catalog's things: each way a change reached a thing
// without changing it in place, and when the watch last proved it. Having a
// path proves nothing; a change that went through it and was watched does.
// So a record is made only from the watch's verdict on a change, and moves
// only forward: a clean sight moves the day it was proven, a sight of harm
// the day it failed, and a blind sight neither. The hub writes the records as
// its own source, one entity of `orrery_safe_path` for each thing and path,
// linked to the thing through the relation for its blueprint.

import { kindFamily, PATH_IN_PLACE, type ChangeObserved, type ChangeRef } from '../shared/change.ts'
import { entityId, SAFE_PATH_BLUEPRINT, SAFE_PATH_OF, type StatusLevel } from '../shared/model.ts'
import type { Blueprints } from './blueprints.ts'
import { ensureHubBlueprints, safePathRelations } from './builtin.ts'
import type { Db } from './db.ts'
import type { Entities, WriteInput } from './entities.ts'
import type { Events } from './events.ts'
import type { Logger } from './log.ts'
import type { Reader } from './read.ts'
import type { Sources } from './sources.ts'

/** What one watched change says of one path to one thing: proven, or failed. */
export interface PathStep {
  subject: ChangeRef
  path: string
  outcome: 'proven' | 'failed'
}

/**
 * What an observation says of the safe paths it went through. A sight counts
 * when its path is not in-place and its kind is not an exposure: the watch
 * watches disruption effects alone, so a kind the estate adds counts too. A
 * clean sight proves its path, a sight of harm fails it, and a blind one says
 * nothing. A path the change hurt on one kind is failed, whatever another
 * kind saw.
 */
export function pathSteps(e: Pick<ChangeObserved, 'sights'>): PathStep[] {
  const steps = new Map<string, PathStep>()
  for (const s of e.sights ?? []) {
    if (s.path === PATH_IN_PLACE || kindFamily(s.kind) === 'exposure' || s.verdict === 'blind') continue
    const id = `${s.subject.blueprint}/${s.subject.key}/${s.path}`
    const outcome = s.verdict === 'harm' ? 'failed' : 'proven'
    if (steps.get(id)?.outcome === 'failed') continue
    steps.set(id, { subject: { blueprint: s.subject.blueprint, key: s.subject.key }, path: s.path, outcome })
  }
  return [...steps.values()]
}

/** A safe path's key: its thing's blueprint and key, and the path. A blueprint holds no slash and a path is a slug, so it reads back one way. */
export const safePathKey = (subject: ChangeRef, path: string): string => `${subject.blueprint}/${subject.key}/${path}`

/** What a safe path holds of its proof. */
export interface Proof {
  proven_at: string | null
  proven_run: string | null
  failed_at: string | null
  failed_run: string | null
}

/** A safe path's proof after one step, at `at`, by the change of `run`: each day only ever moves forward. */
export function stepped(held: Proof, step: PathStep['outcome'], at: string, run: string): Proof {
  const later = (was: string | null) => was === null || Date.parse(at) > Date.parse(was)
  if (step === 'proven') return later(held.proven_at) ? { ...held, proven_at: at, proven_run: run } : held
  return later(held.failed_at) ? { ...held, failed_at: at, failed_run: run } : held
}

/** How a safe path stands: green while it was proven after it last did harm, red otherwise. */
export function standing(p: Proof): { status: StatusLevel; reason: string } {
  if (p.proven_at && (!p.failed_at || Date.parse(p.proven_at) > Date.parse(p.failed_at))) return { status: 'green', reason: p.failed_at ? 'proven since it last did harm' : 'proven, and never seen to do harm' }
  return { status: 'red', reason: p.proven_at ? 'it did harm after it was last proven' : 'it did harm, and was never proven' }
}

export interface SafePathsDeps {
  db: Db
  entities: Entities
  blueprints: Blueprints
  reader: Reader
  sources: Sources
  events: Events
  log: Logger
}

export class SafePaths {
  private readonly deps: SafePathsDeps
  /** One observation is laid on at a time on a hub, so two verdicts on one path never read the same proof. */
  private turn: Promise<unknown> = Promise.resolve()

  constructor(deps: SafePathsDeps) {
    this.deps = deps
  }

  /** Lays an observation of the change of `run` on the safe paths it went through. How many it proved and failed, and the things the catalog does not hold. */
  apply(e: ChangeObserved, run: string): Promise<{ proven: number; failed: number; unknown: number }> {
    const next = this.turn.then(() => this.lay(e, run))
    this.turn = next.catch(() => undefined)
    return next
  }

  private async lay(e: ChangeObserved, run: string): Promise<{ proven: number; failed: number; unknown: number }> {
    const { blueprints, entities, log } = this.deps
    const counts = { proven: 0, failed: 0, unknown: 0 }
    const steps: PathStep[] = []
    for (const step of pathSteps(e)) {
      const subject = { blueprint: blueprints.resolve(step.subject.blueprint), key: step.subject.key }
      if (blueprints.get(subject.blueprint) && (await this.holds(subject))) steps.push({ ...step, subject })
      else {
        counts.unknown++
        log.info('safe path not written: the catalog holds no such thing', { run, subject: entityId(subject), path: step.path, outcome: step.outcome })
      }
    }
    if (!steps.length) {
      log.debug('observation proves no safe path', { run, key: e.key, sights: e.sights?.length ?? 0 })
      return counts
    }
    const hub = this.deps.sources.get('hub')
    if (!hub) throw new Error('safe paths not written: the hub source is missing')
    await this.relate(steps.map((s) => s.subject.blueprint))
    const items: WriteInput[] = []
    for (const step of steps) {
      const key = safePathKey(step.subject, step.path)
      const held = await this.proofOf(key)
      const proof = stepped(held, step.outcome, e.to, run)
      const { status, reason } = standing(proof)
      const title = (await this.deps.reader.get(step.subject))?.title ?? step.subject.key
      items.push({
        blueprint: SAFE_PATH_BLUEPRINT,
        key,
        title: `${step.path} on ${title}`,
        fields: { path: step.path, subject_blueprint: step.subject.blueprint, subject_key: step.subject.key, ...proof, status, status_reason: reason },
        relations: { [`${SAFE_PATH_OF}${step.subject.blueprint}`]: [entityId(step.subject)] },
      })
      counts[step.outcome]++
      log.info(proof === held ? 'safe path kept: the watch saw it earlier than it was last seen' : step.outcome === 'proven' ? 'safe path proven' : 'safe path failed', { run, key, at: e.to, status })
    }
    const results = await entities.writeMany(items, { source: hub, layer: 'pushed', mode: 'upsert', replace: true })
    results.forEach((r, i) => {
      if (r.outcome === 'rejected') log.error('safe path rejected', { key: items[i]!.key, errors: r.errors })
    })
    return counts
  }

  /** Whether the catalog holds the thing, as anything but a tombstone. */
  private async holds(ref: ChangeRef): Promise<boolean> {
    const found = await this.deps.db.query(`SELECT 1 FROM entities WHERE blueprint = $1 AND key = $2 AND state <> 'deleted'`, [ref.blueprint, ref.key])
    return !!found.rowCount
  }

  /** What a safe path holds of its proof now; nothing for a path never watched. */
  private async proofOf(key: string): Promise<Proof> {
    const f = (await this.deps.reader.get({ blueprint: SAFE_PATH_BLUEPRINT, key }))?.fields ?? {}
    const text = (v: unknown) => (typeof v === 'string' && v ? v : null)
    return { proven_at: text(f.proven_at), proven_run: text(f.proven_run), failed_at: text(f.failed_at), failed_run: text(f.failed_run) }
  }

  /** The safe path blueprint links to each blueprint given, written first when one is new to it. */
  private async relate(things: string[]): Promise<void> {
    const held = this.deps.blueprints.get(SAFE_PATH_BLUEPRINT)?.relations ?? {}
    const relations = safePathRelations([...Object.values(held).map((r) => r.target), ...things], this.deps.blueprints)
    if (Object.keys(relations).length === Object.keys(held).length) return
    await ensureHubBlueprints(this.deps.db, this.deps.blueprints, this.deps.entities, { safePaths: relations })
    this.deps.events.emit({ type: 'blueprints', offered: [SAFE_PATH_BLUEPRINT] })
    this.deps.log.info('the safe path blueprint links to a new kind of thing', { before: Object.keys(held), after: Object.keys(relations) })
  }
}
