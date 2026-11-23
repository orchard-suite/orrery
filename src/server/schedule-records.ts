// The hub's schedules as records of its own schedule blueprint, so whoever
// runs the hub sees every job set to run in one grid: filter it, query it,
// export it, and pause, resume, or fire many at once with actions on it. The
// schedules stay the truth; this writes each one that is still a job as it
// stands, and drops the record of one that is gone, declined, or done. A
// change writes them at once on the hub that took it, and the leading hub
// writes them every half minute, so a firing on another hub shows too. Each
// record links to what its schedule runs on, through one relation for each
// blueprint an action runs on; a pass first keeps those relations in step
// with the actions, so an action that runs on a new kind of thing shows
// within the same half minute.

import type { ActionSchedule } from '../shared/api.ts'
import { isOnce } from '../shared/cadence.ts'
import { entityId, SCHEDULE_BLUEPRINT, type EntityRef, type RelationDef, type StatusLevel } from '../shared/model.ts'
import type { Actions } from './actions.ts'
import type { Blueprints } from './blueprints.ts'
import { ensureHubBlueprints, scheduleRelations } from './builtin.ts'
import type { Db } from './db.ts'
import type { Entities, WriteInput } from './entities.ts'
import type { Events } from './events.ts'
import type { Logger } from './log.ts'
import { FAILED_NOTE, PAUSED_BY, type Schedules } from './schedules.ts'
import type { Sources } from './sources.ts'
import { stable } from './values.ts'

export interface ScheduleRecordsDeps {
  db: Db
  entities: Entities
  blueprints: Blueprints
  actions: Actions
  sources: Sources
  schedules: Schedules
  events: Events
  publicUrl: string
  log: Logger
}

type LastResult = 'succeeded' | 'failed' | 'mixed' | 'running'

/** How the runs of a schedule's last firing stand. */
interface LastFiring {
  schedule: string
  succeeded: number
  failed: number
  open: number
  runs: number
}

export class ScheduleRecords {
  private readonly deps: ScheduleRecordsDeps
  private running: Promise<number> | null = null
  private next: Promise<number> | null = null

  constructor(deps: ScheduleRecordsDeps) {
    this.deps = deps
  }

  /** Writes them soon, from a change: what goes wrong is logged, and the next pass writes them again. */
  soon(): void {
    this.pass().catch((error: unknown) => this.deps.log.warn('schedule records not written', { error }))
  }

  /**
   * Writes the record of every schedule that is still a job, and drops the
   * rest. How many it changed. One pass runs at a time on a hub: a pass asked
   * while one runs runs once after it, however many were asked. Another hub
   * writing the same new record at once is met by trying again.
   */
  pass(): Promise<number> {
    if (this.running) {
      this.next ??= this.running.catch(() => 0).then(() => {
        this.next = null
        return this.pass()
      })
      return this.next
    }
    this.running = this.write()
      .catch((error: unknown) => (isDuplicate(error) ? this.write() : Promise.reject(error)))
      .finally(() => {
        this.running = null
      })
    return this.running
  }

  private async write(): Promise<number> {
    const hub = this.deps.sources.get('hub')
    if (!hub) {
      this.deps.log.warn('schedule records not written: the hub source is missing')
      return 0
    }
    const relations = await this.relations()
    const schedules = await this.deps.schedules.live()
    const last = await this.lastFirings()
    const hits = await this.deps.schedules.hits()
    const items: WriteInput[] = schedules.map((s) => this.recordOf(s, last.get(s.id), linksOf(hits.get(s.id) ?? [], relations, (id) => this.deps.blueprints.resolve(id))))
    const results = await this.deps.entities.writeMany(items, { source: hub, layer: 'pushed', mode: 'upsert', replace: true })
    let changed = 0
    results.forEach((result, i) => {
      if (result.outcome === 'rejected') this.deps.log.error('schedule record rejected', { schedule: items[i]!.key, errors: result.errors })
      else if (result.outcome !== 'unchanged') changed++
    })
    const keep = new Set(schedules.map((s) => s.id))
    const held = await this.deps.db.query<{ key: string }>(`SELECT key FROM entities WHERE blueprint = $1 AND state <> 'deleted'`, [SCHEDULE_BLUEPRINT])
    const gone = held.rows.filter((r) => !keep.has(r.key)).map((r) => ({ blueprint: SCHEDULE_BLUEPRINT, key: r.key }))
    if (gone.length) await this.deps.entities.tombstone(gone, 'hub', null, { reason: 'the schedule was removed, declined, or is done' }, false)
    if (changed || gone.length) this.deps.log.info('schedule records written', { schedules: schedules.length, changed, dropped: gone.length })
    else this.deps.log.debug('schedule records unchanged', { schedules: schedules.length })
    return changed + gone.length
  }

  /** The schedule blueprint's relations as the actions stand now, written first when they moved. */
  private async relations(): Promise<Record<string, RelationDef>> {
    const now = scheduleRelations(this.deps.actions.list(), this.deps.blueprints)
    const held = this.deps.blueprints.get(SCHEDULE_BLUEPRINT)?.relations ?? {}
    if (stable(now) === stable(held)) return now
    await ensureHubBlueprints(this.deps.db, this.deps.blueprints, this.deps.entities, { schedules: now })
    this.deps.log.info('the schedule blueprint links to what actions run on now', { before: Object.keys(held), after: Object.keys(now) })
    // Only the schedule blueprint moved: what reads it is built again, and nothing else kept is dropped.
    this.deps.events.emit({ type: 'blueprints', offered: [SCHEDULE_BLUEPRINT] })
    return now
  }

  private recordOf(s: ActionSchedule, last: LastFiring | undefined, relations: Record<string, string[]>): WriteInput {
    const result = resultOf(last)
    const failedBefore = !!s.note?.startsWith(FAILED_NOTE)
    const { status, reason } = standingOf(s, failedBefore ? 'failed' : result)
    const perDay = s.load?.perDay ?? null
    return {
      blueprint: SCHEDULE_BLUEPRINT,
      key: s.id,
      title: s.title,
      fields: {
        action: s.action,
        owner: s.owner,
        state: s.state,
        status,
        status_reason: reason,
        when: s.when,
        repeats: !isOnce(s.cadence),
        target: s.targetTitle,
        next_at: s.nextAt,
        last_at: s.lastAt,
        last_result: failedBefore ? 'failed' : result,
        runs_count: s.load?.runs ?? null,
        firings_per_day: perDay,
        runner_minutes_per_day: s.load?.runnerSeconds != null && perDay != null ? Math.round((s.load.runnerSeconds * perDay) / 6) / 10 : null,
        decided_by: s.decidedBy,
        decided_at: s.decidedAt,
        note: s.note,
        created_at: s.createdAt,
        url: `${this.deps.publicUrl}/actions/schedules/${encodeURIComponent(s.id)}`,
      },
      relations,
    }
  }

  /** Each schedule's latest firing: its one run, or every run of its batch. */
  private async lastFirings(): Promise<Map<string, LastFiring>> {
    const rows = await this.deps.db.query<LastFiring>(
      `WITH latest AS (
         SELECT DISTINCT ON (schedule) schedule, id, batch FROM action_runs WHERE schedule IS NOT NULL ORDER BY schedule, created_at DESC
       )
       SELECT l.schedule,
              count(*) FILTER (WHERE r.state = 'succeeded')::int AS succeeded,
              count(*) FILTER (WHERE r.state = 'failed')::int AS failed,
              count(*) FILTER (WHERE r.state IN ('awaiting', 'queued', 'running'))::int AS open,
              count(*)::int AS runs
         FROM latest l
         JOIN action_runs r ON (l.batch IS NOT NULL AND r.batch = l.batch) OR (l.batch IS NULL AND r.id = l.id)
        GROUP BY l.schedule`,
    )
    return new Map(rows.rows.map((r) => [r.schedule, r]))
  }
}

/** What a schedule runs on, by the relation that links to each blueprint of it; what no relation reaches is left out. */
export function linksOf(hits: EntityRef[], relations: Record<string, RelationDef>, resolve: (id: string) => string): Record<string, string[]> {
  const byTarget = new Map(Object.entries(relations).map(([name, def]) => [def.target, name]))
  const out: Record<string, string[]> = {}
  for (const hit of hits) {
    const blueprint = resolve(hit.blueprint)
    const name = byTarget.get(blueprint)
    if (name) (out[name] ??= []).push(entityId({ blueprint, key: hit.key }))
  }
  for (const name of Object.keys(out)) out[name] = [...new Set(out[name])].sort()
  return out
}

/** Postgres refusing a second row under a key another writer just took. */
function isDuplicate(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505'
}

function resultOf(last: LastFiring | undefined): LastResult | null {
  if (!last?.runs) return null
  if (last.open) return 'running'
  if (last.failed && last.succeeded) return 'mixed'
  if (last.failed) return 'failed'
  return last.succeeded ? 'succeeded' : null
}

/** Green while it fires well, red when its last firing failed, amber when the hub paused it, grey while it waits or a person paused it. */
function standingOf(s: ActionSchedule, result: LastResult | null): { status: StatusLevel; reason: string | null } {
  if (s.state === 'awaiting') return { status: 'grey', reason: 'waits for approval' }
  if (s.state === 'paused') return s.note?.startsWith(PAUSED_BY) ? { status: 'grey', reason: s.note } : { status: 'amber', reason: s.note ? `the hub paused it: ${s.note}` : 'paused' }
  if (result === 'failed') return { status: 'red', reason: s.note?.startsWith(FAILED_NOTE) ? s.note : 'every run of its last firing failed' }
  if (result === 'mixed') return { status: 'amber', reason: 'some runs of its last firing failed' }
  return { status: 'green', reason: null }
}
