// Schedules: an action asked again and again on a cadence, as the person who
// set it up. A schedule runs nothing until someone who decides approvals
// approves it, and it says before then what load it adds: how many runs each
// firing asks, the runner time they take, and when in the day they land, so
// the people who size the platform see every schedule's cost first. Changing
// what it runs, on what, or when asks for approval again. Each firing is an
// ordinary run or batch, judged as its owner's at that moment: someone who
// can no longer run the action, or who left, stops their schedule.

import { randomBytes } from 'node:crypto'
import { SCHEDULE_HISTORY_DAYS, type ActionBatchSummary, type EntityQuery, type ActionSchedule, type ScheduleDay, type ScheduleFiring, type ScheduleHistory, type ScheduleLoad, type ScheduleRequest, type ScheduleState, type ScheduleTarget } from '../shared/api.ts'
import { cadenceProblem, cadenceWords, firesPerDay, firingsByHour, isOnce, nextFiring, shortestGapMs, type Cadence } from '../shared/cadence.ts'
import { estimate } from '../shared/estimate.ts'
import { DEFAULT_TELL, firesTheSame, type ScheduleTell } from '../shared/schedule.ts'
import { actionTargets, can, entityId, parseDuration, type Action, type ActionRun, type ActionRunState, type EntityRef, type Identity } from '../shared/model.ts'
import type { Actions } from './actions.ts'
import { record } from './activity.ts'
import type { Batches } from './batches.ts'
import type { Blueprints } from './blueprints.ts'
import type { Db } from './db.ts'
import type { Events } from './events.ts'
import type { Logger } from './log.ts'
import { equal } from './values.ts'
import type { Queries } from './queries.ts'
import type { Reader } from './read.ts'
import type { View } from './visibility.ts'

/** The hub reading a schedule for itself: it sees every one, and decides none. */
const HUB: Identity = { kind: 'user', name: 'hub', admin: false, roles: [], permissions: [] }

/** The most lines of schedule days one runs list reads. */
const DAYS_MOST = 200

/** A time zone Postgres and the browser both know, or UTC. */
function zoneOr(tz: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return tz
  } catch {
    return 'UTC'
  }
}

/** The most people one schedule tells of each result, beside its owner. */
const DELIVER_MAX = 20

export class ScheduleError extends Error {
  readonly status: 400 | 403 | 404 | 409
  constructor(message: string, status: 400 | 403 | 404 | 409 = 400) {
    super(message)
    this.status = status
  }
}

interface Row {
  id: string
  action: string
  title: string
  owner: string
  target: ScheduleTarget
  inputs: Record<string, unknown>
  cadence: Cadence
  deliver: string[]
  tell: ScheduleTell
  state: ScheduleState
  load: ScheduleLoad | null
  decided_by: string | null
  decided_at: Date | null
  note: string | null
  next_at: Date | null
  last_at: Date | null
  last_run: string | null
  last_batch: string | null
  /** What it runs on: what it was asked to run on, or what its filter or saved query matched when it was last saved or fired. */
  hits: EntityRef[]
  created_at: Date
  updated_at: Date
}

export interface SchedulesDeps {
  db: Db
  actions: Actions
  batches: Batches
  queries: Queries
  reader: Reader
  blueprints: Blueprints
  /** The person behind a sign-in address as the hub judges them now, or null when they no longer sign in. */
  identityFor: (email: string) => Identity | null
  /** What a person sees. */
  viewOf: (identity: Identity) => Promise<View>
  events: Events
  log: Logger
}

/** How a schedule's note begins when its last firing failed before it asked anything. */
export const FAILED_NOTE = 'the last firing failed: '

/** How a schedule's note begins when a person paused it. */
export const PAUSED_BY = 'paused by '

/** The states of a schedule that is still a job: it fires, waits to, or is paused. */
export const LIVE_STATES: ScheduleState[] = ['awaiting', 'active', 'paused']

/** The longest a schedule that fires once may be put off. */
const ONCE_AHEAD_MS = 366 * 86_400_000

/** Whether a schedule fires on its own: one that fires once never waits for approval, and any other only once someone approved it. */
const approved = (row: Pick<Row, 'cadence' | 'decided_by'>): boolean => isOnce(row.cadence) || !!row.decided_by

/** The state a schedule starts in, and starts in again when changed: one that fires once is a run put off, firing at its moment; any other waits for approval. */
const firstState = (c: Cadence): { state: ScheduleState; next: Date | null } => (isOnce(c) ? { state: 'active', next: nextFiring(c, new Date()) } : { state: 'awaiting', next: null })

/** Whether someone decides schedules: an admin, or anyone who decides approvals. */
export function decides(identity: Identity): boolean {
  return !!identity.admin || can(identity, 'actions.approve')
}

export class Schedules {
  private readonly deps: SchedulesDeps

  constructor(deps: SchedulesDeps) {
    this.deps = deps
  }

  /** The schedules the reader may see: their own, or every one for someone who decides. */
  async list(identity: Identity): Promise<ActionSchedule[]> {
    const rows = decides(identity) ? await this.deps.db.query<Row>('SELECT * FROM action_schedules ORDER BY created_at DESC') : await this.deps.db.query<Row>('SELECT * FROM action_schedules WHERE owner = $1 ORDER BY created_at DESC', [identity.name])
    return Promise.all(rows.rows.map((r) => this.shown(r, identity)))
  }

  async get(id: string, identity: Identity): Promise<ActionSchedule> {
    return this.shown(await this.held(id, identity), identity)
  }

  /** Every schedule that is still a job, as the hub itself reads it: what the schedule blueprint holds. */
  async live(): Promise<ActionSchedule[]> {
    const rows = await this.deps.db.query<Row>('SELECT * FROM action_schedules WHERE state = ANY($1) ORDER BY created_at', [LIVE_STATES])
    return Promise.all(rows.rows.map((r) => this.shown(r, HUB)))
  }

  /** What each schedule that is still a job runs on, by its id: what its record in the catalog links to. */
  async hits(): Promise<Map<string, EntityRef[]>> {
    const rows = await this.deps.db.query<Pick<Row, 'id' | 'hits'>>('SELECT id, hits FROM action_schedules WHERE state = ANY($1)', [LIVE_STATES])
    return new Map(rows.rows.map((r) => [r.id, r.hits]))
  }

  /** One schedule as the hub itself reads it, for a notice; null when it is gone. */
  async find(id: string): Promise<ActionSchedule | null> {
    const row = (await this.deps.db.query<Row>('SELECT * FROM action_schedules WHERE id = $1', [id])).rows[0]
    return row ? this.shown(row, HUB) : null
  }

  /**
   * Every firing over the last `days` of the schedules the reader may see, or
   * of the one named: each run asked alone, and each batch as one firing, with
   * how its runs stand now and the runner time they took. A firing that failed
   * before it asked anything is read from the activity log, where only it is.
   */
  async history(identity: Identity, q: { days: number; schedule?: string }): Promise<ScheduleHistory> {
    const days = Math.min(Math.max(Math.trunc(q.days) || 7, 1), SCHEDULE_HISTORY_DAYS)
    const since = new Date(Date.now() - days * 86_400_000)
    const ids = q.schedule ? [(await this.held(q.schedule, identity)).id] : (decides(identity) ? await this.deps.db.query<{ id: string }>('SELECT id FROM action_schedules') : await this.deps.db.query<{ id: string }>('SELECT id FROM action_schedules WHERE owner = $1', [identity.name])).rows.map((r) => r.id)
    if (!ids.length) return { since: since.toISOString(), days, firings: [] }
    const asked = await this.deps.db.query<{ schedule: string; at: Date; run: string | null; batch: string | null; runs: number; succeeded: number; failed: number; open: number; seconds: number; started_at: Date | null; ended_at: Date | null }>(
      `SELECT schedule, min(created_at) AS at, CASE WHEN max(batch) IS NULL THEN min(id) END AS run, max(batch) AS batch,
              count(*)::int AS runs,
              count(*) FILTER (WHERE state = 'succeeded')::int AS succeeded,
              count(*) FILTER (WHERE state = 'failed')::int AS failed,
              count(*) FILTER (WHERE state IN ('awaiting', 'queued', 'running'))::int AS open,
              coalesce(sum(extract(epoch FROM finished_at - started_at)) FILTER (WHERE started_at IS NOT NULL AND finished_at IS NOT NULL), 0)::float8 AS seconds,
              min(started_at) AS started_at,
              CASE WHEN count(*) FILTER (WHERE state IN ('awaiting', 'queued', 'running')) = 0 THEN max(finished_at) END AS ended_at
         FROM action_runs
        WHERE schedule = ANY($1) AND created_at >= $2
        GROUP BY schedule, coalesce(batch, id)`,
      [ids, since],
    )
    const failed = await this.deps.db.query<{ schedule: string; at: Date; reason: string | null }>(
      `SELECT detail->>'schedule' AS schedule, at, detail->>'reason' AS reason FROM changes
        WHERE kind = 'schedule.fired' AND outcome = 'failed' AND detail->>'schedule' = ANY($1) AND at >= $2`,
      [ids, since],
    )
    const firings: ScheduleFiring[] = [
      ...asked.rows.map((r) => ({ schedule: r.schedule, at: r.at.toISOString(), run: r.run, batch: r.batch, runs: r.runs, succeeded: r.succeeded, failed: r.failed, open: r.open, stopped: r.runs - r.succeeded - r.failed - r.open, seconds: Math.round(r.seconds), startedAt: r.started_at?.toISOString() ?? null, endedAt: r.ended_at?.toISOString() ?? null, error: null })),
      ...failed.rows.map((r) => ({ schedule: r.schedule, at: r.at.toISOString(), run: null, batch: null, runs: 0, succeeded: 0, failed: 0, open: 0, stopped: 0, seconds: 0, startedAt: null, endedAt: null, error: r.reason ?? 'it failed before it asked anything' })),
    ].sort((a, b) => a.at.localeCompare(b.at))
    return { since: since.toISOString(), days, firings }
  }

  /**
   * What each schedule fired, one line a schedule a day in `tz`, newest first:
   * how many times it fired, how its runs stand now, and why the newest
   * failure failed. A firing that asked nothing is read from the activity log,
   * where only it is. The reader sees a schedule's line where they would see
   * its batches: their own, everything for an admin or a reader who sees all,
   * and otherwise an action they see and may run, on a blueprint they see
   * some of. Without `since` it reads back `SCHEDULE_HISTORY_DAYS`.
   */
  async days(identity: Identity, view: View, q: { tz: string; since?: Date; action?: string; by?: string; states?: ActionRunState[] }): Promise<ScheduleDay[]> {
    const tz = zoneOr(q.tz)
    const since = q.since ?? new Date(Date.now() - SCHEDULE_HISTORY_DAYS * 86_400_000)
    // One row a firing and state: few enough to add up here, and a firing counted once however its runs stand.
    const asked = await this.deps.db.query<{ schedule: string; day: string; action: string; blueprint: string | null; actor: string; firing: string; state: ActionRunState; n: number; first_at: Date; last_at: Date; error: string | null }>(
      `SELECT schedule, to_char(created_at AT TIME ZONE $1, 'YYYY-MM-DD') AS day, action, min(blueprint) AS blueprint, min(actor) AS actor,
              coalesce(batch, id) AS firing, state, count(*)::int AS n, min(created_at) AS first_at, max(created_at) AS last_at,
              (array_agg(summary ORDER BY created_at DESC))[1] AS error
         FROM action_runs
        WHERE schedule IS NOT NULL AND created_at >= $2 AND ($3::text IS NULL OR action = $3) AND ($4::text IS NULL OR actor = $4)
        GROUP BY 1, 2, 3, coalesce(batch, id), state`,
      [tz, since, q.action ?? null, q.by ?? null],
    )
    const missed = await this.deps.db.query<{ schedule: string; day: string; action: string; actor: string | null; n: number; first_at: Date; last_at: Date; reason: string | null }>(
      `SELECT detail->>'schedule' AS schedule, to_char(at AT TIME ZONE $1, 'YYYY-MM-DD') AS day, detail->>'action' AS action, min(actor) AS actor,
              count(*)::int AS n, min(at) AS first_at, max(at) AS last_at, (array_agg(detail->>'reason' ORDER BY at DESC))[1] AS reason
         FROM changes
        WHERE kind = 'schedule.fired' AND outcome = 'failed' AND at >= $2 AND ($3::text IS NULL OR detail->>'action' = $3) AND ($4::text IS NULL OR actor = $4)
        GROUP BY 1, 2, 3`,
      [tz, since, q.action ?? null, q.by ?? null],
    )
    const lines = new Map<string, ScheduleDay & { firingIds: Set<string>; errorAt: number }>()
    const line = (r: { schedule: string; day: string; action: string; actor: string | null; first_at: Date; last_at: Date }, blueprint: string | null) => {
      const key = `${r.schedule}|${r.day}`
      let l = lines.get(key)
      if (!l) {
        l = { schedule: r.schedule, title: null, when: null, targetTitle: null, owner: r.actor ?? '', action: r.action, blueprint, day: r.day, firstAt: r.first_at.toISOString(), lastAt: r.last_at.toISOString(), firings: 0, counts: {}, missed: 0, error: null, firingIds: new Set(), errorAt: 0 }
        lines.set(key, l)
      }
      if (r.first_at.toISOString() < l.firstAt) l.firstAt = r.first_at.toISOString()
      if (r.last_at.toISOString() > l.lastAt) l.lastAt = r.last_at.toISOString()
      l.blueprint ??= blueprint
      return l
    }
    const failedAt = (l: { error: string | null; errorAt: number }, at: Date, why: string | null) => {
      if (at.getTime() < l.errorAt) return
      l.errorAt = at.getTime()
      l.error = why
    }
    for (const r of asked.rows) {
      const l = line(r, r.blueprint)
      l.firingIds.add(r.firing)
      l.counts[r.state] = (l.counts[r.state] ?? 0) + r.n
      if (r.state === 'failed') failedAt(l, r.last_at, r.error)
    }
    for (const r of missed.rows) {
      const l = line(r, null)
      l.missed += r.n
      failedAt(l, r.last_at, r.reason ?? 'it failed before it asked anything')
    }
    const wanted = (l: ScheduleDay) => !q.states || q.states.some((st) => (l.counts[st] ?? 0) > 0) || (q.states.includes('failed') && l.missed > 0)
    const found = [...lines.values()].filter(wanted)
    if (!found.length) return []
    const rows = await this.deps.db.query<Row>('SELECT * FROM action_schedules WHERE id = ANY($1)', [[...new Set(found.map((l) => l.schedule))]])
    const schedules = new Map(rows.rows.map((r) => [r.id, r]))
    const runs = new Map<string, boolean>()
    const shown: ScheduleDay[] = []
    for (const { firingIds, errorAt: _, ...l } of found.sort((a, b) => b.lastAt.localeCompare(a.lastAt)).slice(0, DAYS_MOST)) {
      const row = schedules.get(l.schedule)
      const owner = row?.owner ?? l.owner
      const theirs = owner === identity.name || identity.admin || view.all
      if (!theirs) {
        const action = this.deps.actions.get(l.action)
        if (!action || !view.seesAction(action) || (l.blueprint && !view.seesSome(l.blueprint))) continue
        if (!runs.has(action.id)) runs.set(action.id, await this.deps.actions.mayRun(identity, action))
        if (!runs.get(action.id)) continue
      }
      shown.push({ ...l, owner, firings: firingIds.size + l.missed, title: row?.title ?? null, when: row ? cadenceWords(row.cadence) : null, targetTitle: row && theirs ? await this.targetTitle(row) : null })
    }
    if (shown.length < Math.min(found.length, DAYS_MOST)) this.deps.log.debug('schedule days hidden from a reader', { reader: identity.name, shown: shown.length, hidden: Math.min(found.length, DAYS_MOST) - shown.length })
    else this.deps.log.debug('schedule days all shown to a reader', { reader: identity.name, shown: shown.length })
    return shown
  }

  /** The schedules waiting for the reader to decide them. */
  async awaiting(identity: Identity): Promise<ActionSchedule[]> {
    if (!decides(identity)) return []
    const rows = await this.deps.db.query<Row>(`SELECT * FROM action_schedules WHERE state = 'awaiting' ORDER BY created_at`)
    return Promise.all(rows.rows.map((r) => this.shown(r, identity)))
  }

  /** Asks for a schedule as the reader's. One that repeats waits for approval; one that fires once fires at its moment. */
  async request(input: ScheduleRequest, identity: Identity): Promise<ActionSchedule> {
    const { action, view } = await this.checked(input, identity)
    const load = await this.loadOf(action, input.target, input.inputs, input.cadence, view, identity)
    const hits = await this.hitsOf(input.target, action, identity, view)
    const id = randomBytes(6).toString('hex')
    const first = firstState(input.cadence)
    await this.deps.db.query(
      `INSERT INTO action_schedules (id, action, title, owner, target, inputs, cadence, deliver, tell, state, load, next_at, hits) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [id, action.id, input.title, identity.name, JSON.stringify(input.target), JSON.stringify(input.inputs), JSON.stringify(input.cadence), JSON.stringify(input.deliver ?? []), input.tell ?? DEFAULT_TELL, first.state, JSON.stringify(load), first.next, JSON.stringify(hits)],
    )
    await record(this.deps.db, 'schedule.requested', this.firstTarget(action), null, identity.name, { schedule: id, action: action.id, title: input.title, when: cadenceWords(input.cadence), runs: load.runs, perDay: load.perDay, runnerSeconds: load.runnerSeconds })
    this.deps.events.emit({ type: 'schedules' })
    this.deps.log.info(first.state === 'awaiting' ? 'schedule requested: it waits for approval' : 'schedule requested: it fires once, at its moment', { schedule: id, action: action.id, by: identity.name, runs: load.runs, perDay: load.perDay, next: first.next })
    return this.get(id, identity)
  }

  /**
   * Changes a schedule: what it runs, on what, when, or who hears. One that
   * repeats and fires differently waits for approval again; one that fires
   * once fires at its new moment. A change to its name or to who hears of
   * what keeps it as it stands: what it adds to the platform is the same.
   */
  async change(id: string, input: ScheduleRequest, identity: Identity): Promise<ActionSchedule> {
    const row = await this.held(id, identity)
    this.mayChange(row, identity)
    if (input.action !== row.action) throw new ScheduleError('A schedule runs one action; set up another for another action')
    if (firesTheSame(input, row)) {
      if ((input.deliver ?? []).length > DELIVER_MAX) throw new ScheduleError(`A schedule tells at most ${DELIVER_MAX} people`)
      const tell = input.tell ?? DEFAULT_TELL
      const deliver = input.deliver ?? []
      if (input.title === row.title && tell === row.tell && equal(deliver, row.deliver)) {
        this.deps.log.info('schedule saved as it was', { schedule: id, by: identity.name })
        return this.get(id, identity)
      }
      await this.deps.db.query(`UPDATE action_schedules SET title = $2, deliver = $3, tell = $4, updated_at = now() WHERE id = $1`, [id, input.title, JSON.stringify(deliver), tell])
      await record(this.deps.db, 'schedule.changed', this.firstTarget(this.deps.actions.get(row.action)), null, identity.name, { schedule: id, action: row.action, title: input.title, tell, deliver: deliver.length, fires: 'same' })
      this.deps.events.emit({ type: 'schedules' })
      this.deps.log.info('schedule changed: it fires the same, so it stands as it was', { schedule: id, by: identity.name, state: row.state, tell })
      return this.get(id, identity)
    }
    const owner = this.deps.identityFor(row.owner) ?? identity
    const { action, view } = await this.checked(input, owner)
    const load = await this.loadOf(action, input.target, input.inputs, input.cadence, view, identity)
    const hits = await this.hitsOf(input.target, action, owner, view)
    const first = firstState(input.cadence)
    await this.deps.db.query(
      `UPDATE action_schedules SET title = $2, target = $3, inputs = $4, cadence = $5, deliver = $6, tell = $7, load = $8, state = $9, decided_by = NULL, decided_at = NULL, note = NULL, next_at = $10, hits = $11, updated_at = now() WHERE id = $1`,
      [id, input.title, JSON.stringify(input.target), JSON.stringify(input.inputs), JSON.stringify(input.cadence), JSON.stringify(input.deliver ?? []), input.tell ?? DEFAULT_TELL, JSON.stringify(load), first.state, first.next, JSON.stringify(hits)],
    )
    await record(this.deps.db, 'schedule.changed', this.firstTarget(action), null, identity.name, { schedule: id, action: action.id, when: cadenceWords(input.cadence), runs: load.runs, perDay: load.perDay })
    this.deps.log.info('schedule changed: it fires differently', { schedule: id, by: identity.name, state: first.state })
    this.deps.events.emit({ type: 'schedules' })
    return this.get(id, identity)
  }

  /** Approves or declines a schedule that waits. Approved, it fires next at its cadence. */
  async decide(id: string, approve: boolean, identity: Identity, note?: string): Promise<ActionSchedule> {
    // An agent asks and never decides: its person decides, signed in (ORY-2002).
    if (identity.agent) throw new ScheduleError(`An agent never decides a schedule: ${identity.name} decides it, signed in`, 403)
    if (!decides(identity)) throw new ScheduleError('Only someone who decides approvals approves a schedule', 403)
    const row = await this.held(id, identity)
    if (row.state !== 'awaiting') throw new ScheduleError(`The schedule is ${row.state}, not waiting for a decision`, 409)
    const next = approve ? nextFiring(row.cadence, new Date()) : null
    await this.deps.db.query(`UPDATE action_schedules SET state = $2, decided_by = $3, decided_at = now(), note = $4, next_at = $5, updated_at = now() WHERE id = $1`, [id, approve ? 'active' : 'declined', identity.name, note ?? null, next])
    await record(this.deps.db, approve ? 'schedule.approved' : 'schedule.declined', this.firstTarget(this.deps.actions.get(row.action)), null, identity.name, { schedule: id, action: row.action, owner: row.owner, ...(note ? { reason: note } : {}) })
    this.deps.events.emit({ type: 'schedules' })
    this.deps.log.info(approve ? 'schedule approved' : 'schedule declined', { schedule: id, action: row.action, by: identity.name })
    return this.get(id, identity)
  }

  /** Pauses a schedule, or starts an approved one firing again. */
  async pause(id: string, paused: boolean, identity: Identity): Promise<ActionSchedule> {
    const row = await this.held(id, identity)
    this.mayChange(row, identity)
    if (paused) {
      if (row.state !== 'active') throw new ScheduleError(`The schedule is ${row.state}, not firing`, 409)
      await this.deps.db.query(`UPDATE action_schedules SET state = 'paused', note = $2, next_at = NULL, updated_at = now() WHERE id = $1`, [id, `${PAUSED_BY}${identity.name}`])
    } else {
      if (row.state !== 'paused' || !approved(row)) throw new ScheduleError('Only a paused schedule someone approved fires again', 409)
      const next = nextFiring(row.cadence, new Date())
      if (!next) throw new ScheduleError('Its moment has passed: change it to a new one, or run it now', 409)
      await this.deps.db.query(`UPDATE action_schedules SET state = 'active', note = NULL, next_at = $2, updated_at = now() WHERE id = $1`, [id, next])
    }
    await record(this.deps.db, 'schedule.paused', this.firstTarget(this.deps.actions.get(row.action)), null, identity.name, { schedule: id, action: row.action, paused })
    this.deps.events.emit({ type: 'schedules' })
    return this.get(id, identity)
  }

  async remove(id: string, identity: Identity): Promise<void> {
    const row = await this.held(id, identity)
    this.mayChange(row, identity)
    await this.deps.db.query('DELETE FROM action_schedules WHERE id = $1', [id])
    await record(this.deps.db, 'schedule.removed', this.firstTarget(this.deps.actions.get(row.action)), null, identity.name, { schedule: id, action: row.action, owner: row.owner })
    this.deps.events.emit({ type: 'schedules' })
  }

  /** Fires an approved schedule now, without waiting for its time: to prove it, or because it is wanted now. */
  async runNow(id: string, identity: Identity): Promise<ActionSchedule> {
    const row = await this.held(id, identity)
    this.mayChange(row, identity)
    if (!approved(row) || row.state === 'declined' || row.state === 'awaiting') throw new ScheduleError('A schedule fires only once someone approved it', 409)
    await this.fire(row)
    return this.get(id, identity)
  }

  /** Fires every active schedule whose time has come, each once, and sets its next time. How many fired. */
  async due(): Promise<number> {
    const taken = await this.deps.db.tx(async (client) => {
      const rows = (await client.query<Row>(`SELECT * FROM action_schedules WHERE state = 'active' AND next_at <= now() ORDER BY next_at FOR UPDATE SKIP LOCKED`)).rows
      // A schedule the hub missed while it was down fires once, not once for every time it missed.
      for (const r of rows) await client.query('UPDATE action_schedules SET next_at = $2 WHERE id = $1', [r.id, nextFiring(r.cadence, new Date())])
      return rows
    })
    for (const row of taken) await this.fire(row)
    if (!taken.length) this.deps.log.debug('no schedule is due')
    return taken.length
  }

  /** Who hears of a scheduled run's or batch's result (its owner and the people it names), and which results; null for no schedule, or one that is gone. */
  async audienceOf(schedule: string | null | undefined): Promise<{ owner: string; deliver: string[]; tell: ScheduleTell } | null> {
    if (!schedule) return null
    return (await this.deps.db.query<{ owner: string; deliver: string[]; tell: ScheduleTell }>('SELECT owner, deliver, tell FROM action_schedules WHERE id = $1', [schedule])).rows[0] ?? null
  }

  /** Everyone who decides schedules, by sign-in address. */
  deciders(people: Identity[]): string[] {
    return people.filter(decides).map((p) => p.name)
  }

  // ---------------------------------------------------------------------------

  /**
   * One firing, as the owner now: one run on one entity or on none, or a
   * batch on many: the entities picked, every row a grid's question matches
   * now, or every row a saved query matches now of the action's blueprints.
   * What stops it from firing pauses it, with why. One that fires once is
   * done once it fired, whether its firing asked anything or not.
   */
  private async fire(row: Row): Promise<void> {
    const owner = this.deps.identityFor(row.owner)
    const action = this.deps.actions.get(row.action)
    const stop = async (why: string) => {
      await this.deps.db.query(`UPDATE action_schedules SET state = 'paused', note = $2, next_at = NULL, updated_at = now() WHERE id = $1`, [row.id, why])
      await record(this.deps.db, 'schedule.paused', null, null, null, { schedule: row.id, action: row.action, paused: true, reason: why }, new Date(), 'failed')
      this.deps.events.emit({ type: 'schedules' })
      this.deps.log.warn('schedule paused: it cannot fire', { schedule: row.id, action: row.action, reason: why })
    }
    if (!owner) return stop(`${row.owner} no longer signs in to the hub`)
    if (!action) return stop(`the action "${row.action}" is gone`)
    if (!action.schedule && !isOnce(row.cadence)) return stop('the action no longer allows schedules')
    if (!(await this.deps.actions.mayRun(owner, action))) return stop(`${row.owner} may no longer run the action`)
    const view = await this.deps.viewOf(owner)
    // One that fires once has fired: it is done, and fires again only when someone runs it now.
    const done = `state = CASE WHEN cadence->>'every' = 'once' AND state = 'active' THEN 'done' ELSE state END, next_at = CASE WHEN cadence->>'every' = 'once' THEN NULL ELSE next_at END`
    try {
      let runs = 0
      let run: string | null = null
      let batch: string | null = null
      let hits: EntityRef[] = []
      const many = await this.manyOf(row.target, action, owner, view)
      if (many === 'gone') return stop('its saved query is gone, or no longer shared with its owner')
      if (many) {
        for (const part of many) {
          if (!part.refs.length) continue
          hits.push(...part.refs)
          const asked: ActionBatchSummary = await this.deps.batches.start(action.id, part.query ? { query: part.query, inputs: row.inputs } : { entities: part.refs, inputs: row.inputs }, part.query ? part.refs : null, owner, view)
          await this.deps.db.query('UPDATE action_batches SET schedule = $2 WHERE id = $1', [asked.id, row.id])
          await this.deps.db.query('UPDATE action_runs SET schedule = $2 WHERE batch = $1', [asked.id, row.id])
          batch = asked.id
          runs += asked.asked
        }
        if (!runs) this.deps.log.info('schedule fired on nothing: nothing it runs on matched', { schedule: row.id, action: action.id })
      } else {
        const asked: ActionRun = await this.deps.actions.request(action.id, { ...(row.target.entity ? { entity: row.target.entity } : {}), inputs: row.inputs }, owner, view)
        await this.deps.db.query('UPDATE action_runs SET schedule = $2 WHERE id = $1', [asked.id, row.id])
        run = asked.id
        runs = 1
        hits = row.target.entity ? [row.target.entity] : []
      }
      const load = await this.loadOf(action, row.target, row.inputs, row.cadence, view, owner, runs)
      // A firing that asked what it should clears what the one before it said of its failure.
      await this.deps.db.query(`UPDATE action_schedules SET last_at = now(), last_run = coalesce($2, last_run), last_batch = coalesce($3, last_batch), load = $4, hits = $5, note = CASE WHEN note LIKE '${FAILED_NOTE}%' THEN NULL ELSE note END, ${done} WHERE id = $1`, [row.id, run, batch, JSON.stringify(load), JSON.stringify(hits)])
      await record(this.deps.db, 'schedule.fired', this.firstTarget(action), null, row.owner, { schedule: row.id, action: action.id, runs, ...(run ? { run } : {}), ...(batch ? { batch } : {}) })
      this.deps.events.emit({ type: 'schedules' })
      this.deps.log.info('schedule fired', { schedule: row.id, action: action.id, runs, run, batch, once: isOnce(row.cadence) })
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error)
      await this.deps.db.query(`UPDATE action_schedules SET last_at = now(), note = $2, ${done} WHERE id = $1`, [row.id, `${FAILED_NOTE}${why}`.slice(0, 500)])
      await record(this.deps.db, 'schedule.fired', this.firstTarget(action), null, row.owner, { schedule: row.id, action: action.id, runs: 0, reason: why }, new Date(), 'failed')
      this.deps.events.emit({ type: 'schedules' })
      this.deps.log.warn('schedule firing failed', { schedule: row.id, action: action.id, error: why })
    }
  }

  /**
   * What a firing asks a batch on, part by part: the entities picked, every
   * row a grid's question matches now (but those it left out), or every row
   * each source of a saved query matches now, of the action's blueprints.
   * Null for one entity or none, which is one run; `gone` for a saved query
   * its owner can no longer open.
   */
  private async manyOf(target: ScheduleTarget, action: Action, owner: Identity, view: View): Promise<{ query?: EntityQuery; refs: EntityRef[] }[] | null | 'gone'> {
    const keys = async (q: EntityQuery) => (await this.deps.queries.run([{ blueprint: q.blueprint, ...(q.filter ? { filter: q.filter } : {}), ...(q.states ? { states: q.states } : {}), ...(q.hidden ? { hidden: true } : {}) }], ['key'], view)).rows.map((r) => ({ blueprint: r.blueprint, key: r.key }))
    if (target.entities) return [{ refs: target.entities }]
    if (target.matching) {
      const except = new Set((target.matching.except ?? []).map(entityId))
      return [{ query: target.matching, refs: (await keys(target.matching)).filter((r) => !except.has(entityId(r))) }]
    }
    if (!target.query) return null
    const saved = await this.deps.queries.get(target.query, owner).catch(() => null)
    if (!saved) return 'gone'
    const targets = new Set(actionTargets(action))
    // Conditions on the answer's columns read what no source's filter can say: the firing runs on the rows they keep, by name.
    if (saved.spec.view?.where?.length) {
      const refs = await this.deps.queries.keptRefs(saved.spec, view, owner, targets)
      return [...new Set(refs.map((r) => r.blueprint))].map((blueprint) => ({ refs: refs.filter((r) => r.blueprint === blueprint) }))
    }
    const parts: { query: EntityQuery; refs: EntityRef[] }[] = []
    for (const source of this.deps.queries.sources(saved.spec, view).filter((x) => targets.has(x.blueprint))) {
      const query: EntityQuery = { blueprint: source.blueprint, ...(source.filter ? { filter: source.filter } : {}), ...(source.states ? { states: source.states } : {}), ...(source.hidden ? { hidden: true } : {}) }
      parts.push({ query, refs: await keys(query) })
    }
    return parts
  }

  /** What a schedule runs on now, as its owner sees it: the entity or the entities it names, or what its filter or saved query matches. */
  private async hitsOf(target: ScheduleTarget, action: Action, owner: Identity, view: View): Promise<EntityRef[]> {
    const many = await this.manyOf(target, action, owner, view)
    if (many === 'gone') return []
    if (many) return many.flatMap((part) => part.refs)
    return target.entity ? [target.entity] : []
  }

  /**
   * What a schedule asks is checked as a run of it would be: the person may
   * run the action, the target is theirs to see, and, for one that repeats,
   * the action allows schedules and the cadence is no tighter than it
   * allows. One that fires once is a run put off: any action the person may
   * run may be put off, to a moment still to come, at most a year ahead.
   */
  private async checked(input: ScheduleRequest, identity: Identity): Promise<{ action: Action; view: View }> {
    const action = this.deps.actions.get(input.action)
    if (!action) throw new ScheduleError(`Unknown action "${input.action}"`, 404)
    const once = isOnce(input.cadence)
    if (!once && !action.schedule) throw new ScheduleError(`"${action.title}" does not repeat on a schedule; it may be run once, later`, 403)
    if (!(await this.deps.actions.mayRun(identity, action))) throw new ScheduleError(`You may not run "${action.title}"`, 403)
    const problem = cadenceProblem(input.cadence)
    if (problem) throw new ScheduleError(`cadence: ${problem}`)
    if (input.cadence.every === 'once') {
      const at = Date.parse(input.cadence.on)
      if (at <= Date.now() + 30_000) throw new ScheduleError('Pick a moment still to come')
      if (at > Date.now() + ONCE_AHEAD_MS) throw new ScheduleError('A run is put off a year at most')
    } else if (action.schedule && shortestGapMs(input.cadence) < parseDuration(action.schedule.min)) throw new ScheduleError(`"${action.title}" runs at most once every ${action.schedule.min}`)
    if ((input.deliver ?? []).length > DELIVER_MAX) throw new ScheduleError(`A schedule tells at most ${DELIVER_MAX} people`)
    for (const [name, def] of Object.entries(action.inputs)) if (def.required && (input.inputs[name] === undefined || input.inputs[name] === null || input.inputs[name] === '')) throw new ScheduleError(`Input "${def.title ?? name}" is required`)
    const view = await this.deps.viewOf(identity)
    const targets = actionTargets(action)
    const t = input.target
    if ([t.entity, t.entities, t.matching, t.query].filter(Boolean).length > 1) throw new ScheduleError('A schedule runs on one entity, the entities picked, a filter, or a saved query: one of them')
    const many = (what: string) => {
      if (!action.batch) throw new ScheduleError(`"${action.title}" does not run on many at once, so it cannot run on ${what}`)
      return action.batch.max
    }
    if (t.entity) {
      if (!targets.includes(t.entity.blueprint)) throw new ScheduleError(`"${action.title}" does not run on ${t.entity.blueprint}`)
      const e = await this.deps.reader.get(t.entity)
      if (!e || !view.seesEntity(t.entity)) throw new ScheduleError('That entity does not exist, or you may not see it', 404)
    } else if (t.entities) {
      const max = many('the entities picked')
      if (t.entities.length > max) throw new ScheduleError(`"${action.title}" runs on ${max} at most at once`)
      const off = t.entities.find((e) => !targets.includes(e.blueprint))
      if (off) throw new ScheduleError(`"${action.title}" does not run on ${off.blueprint}`)
      if (t.entities.some((e) => !view.seesEntity(e))) throw new ScheduleError('Some of those picked do not exist, or you may not see them', 404)
    } else if (t.matching) {
      many('a filter')
      if (!targets.includes(t.matching.blueprint)) throw new ScheduleError(`"${action.title}" does not run on ${t.matching.blueprint}`)
      const read = t.matching.filter ? view.refusedQuery(t.matching.blueprint, t.matching.filter) : null
      if (read) throw new ScheduleError(`The filter reads "${read}", which you cannot see`, 403)
    } else if (t.query) {
      const saved = await this.deps.queries.get(t.query, identity).catch(() => null)
      if (!saved) throw new ScheduleError('That saved query does not exist, or is not shared with you', 404)
      if (!saved.spec.sources.some((s) => targets.includes(s.blueprint))) throw new ScheduleError(`The saved query reads none of what "${action.title}" runs on`)
      many('a saved query')
    } else if (targets.length) throw new ScheduleError(`"${action.title}" runs on a ${targets[0]}: name one, pick some, or name a saved query`)
    return { action, view }
  }

  /** The load a schedule adds: `runs` when a firing already counted them, else what its target matches now. */
  private async loadOf(action: Action, target: ScheduleTarget, inputs: Record<string, unknown>, cadence: Cadence, view: View, identity: Identity, runs?: number): Promise<ScheduleLoad> {
    const count = runs ?? (await this.countOf(action, target, view, identity))
    const mean = await this.deps.actions.meanFor(action, inputs)
    const width = this.deps.actions.widthOf(action)
    const runnerSeconds = mean === null ? null : Math.round(count * mean)
    const hours = firingsByHour(cadence, new Date()).map((n) => (runnerSeconds === null ? 0 : Math.round(n * runnerSeconds)))
    return { runs: count, runnerSeconds, estimate: estimate({ left: count, meanSeconds: mean, width }), perDay: firesPerDay(cadence), hours, runner: action.backend.type === 'runner' ? action.backend.runner : null }
  }

  /** How many runs a firing asks now: one, the entities picked, or what a grid's question or a saved query matches. */
  private async countOf(action: Action, target: ScheduleTarget, view: View, identity: Identity): Promise<number> {
    const total = async (q: EntityQuery) => (await this.deps.reader.list({ blueprint: q.blueprint, filter: q.filter, states: q.states, includeHidden: !!q.hidden, limit: 1, view })).total
    if (target.entities) return target.entities.length
    if (target.matching) return Math.max(0, (await total(target.matching)) - (target.matching.except?.length ?? 0))
    if (!target.query) return 1
    const saved = await this.deps.queries.get(target.query, identity).catch(() => null)
    if (!saved) return 0
    const targets = new Set(actionTargets(action))
    if (saved.spec.view?.where?.length) return (await this.deps.queries.keptRefs(saved.spec, view, identity, targets)).length
    let count = 0
    for (const source of this.deps.queries.sources(saved.spec, view).filter((x) => targets.has(x.blueprint))) count += await total(source)
    return count
  }

  /**
   * Hands every schedule that runs on one entity to a new owner: each fires
   * as them from then on. Whoever may hand the entity over is judged by the
   * caller. Answers how many moved.
   */
  async handOver(entity: EntityRef, to: string, by: string): Promise<number> {
    const moved = await this.deps.db.query<{ id: string; action: string; owner: string }>(
      `WITH held AS (SELECT id, owner FROM action_schedules WHERE target->'entity'->>'blueprint' = $1 AND target->'entity'->>'key' = $2 AND lower(owner) <> lower($3) FOR UPDATE)
       UPDATE action_schedules s SET owner = $3, updated_at = now() FROM held WHERE s.id = held.id RETURNING s.id, s.action, held.owner`,
      [entity.blueprint, entity.key, to],
    )
    for (const row of moved.rows) await record(this.deps.db, 'schedule.changed', entity, null, by, { schedule: row.id, action: row.action, owner: to, from: row.owner })
    if (moved.rows.length) this.deps.events.emit({ type: 'schedules' })
    this.deps.log.info(moved.rows.length ? 'schedules handed over with what they run on' : 'no schedule to hand over: none runs on it', { entity: `${entity.blueprint}:${entity.key}`, to, by, schedules: moved.rows.length })
    return moved.rows.length
  }

  private async held(id: string, identity: Identity): Promise<Row> {
    const row = (await this.deps.db.query<Row>('SELECT * FROM action_schedules WHERE id = $1', [id])).rows[0]
    if (!row || (row.owner !== identity.name && !decides(identity))) throw new ScheduleError(`Unknown schedule "${id}"`, 404)
    return row
  }

  private mayChange(row: Row, identity: Identity): void {
    if (row.owner !== identity.name && !decides(identity)) throw new ScheduleError('Only its owner, or someone who decides approvals, changes a schedule', 403)
  }

  /** The entities picked, by title: two of them by name, and how many more. */
  private async picked(refs: EntityRef[]): Promise<string> {
    const titles = await this.deps.reader.titlesOf(refs.slice(0, 2))
    const named = refs.slice(0, 2).map((r) => titles.get(entityId(r)) ?? r.key)
    return refs.length > 2 ? `${named.join(', ')} and ${(refs.length - 2).toLocaleString('en-US')} more` : named.join(' and ')
  }

  private firstTarget(action: Action | undefined): { blueprint: string } | null {
    const first = action ? actionTargets(action)[0] : undefined
    return first ? { blueprint: first } : null
  }

  /** What a schedule runs on, in words: the entity's title, the picked ones, the filter's blueprint, or the saved query's title. */
  private async targetTitle(r: Row): Promise<string | null> {
    if (r.target.entity) return (await this.deps.reader.titlesOf([r.target.entity])).get(entityId(r.target.entity)) ?? r.target.entity.key
    if (r.target.entities) return this.picked(r.target.entities)
    if (r.target.matching) return `every ${this.deps.blueprints.get(r.target.matching.blueprint)?.title ?? r.target.matching.blueprint} its filter matches`
    if (r.target.query) return (await this.deps.db.query<{ title: string }>('SELECT title FROM saved_queries WHERE id = $1', [r.target.query])).rows[0]?.title ?? null
    return null
  }

  private async shown(r: Row, identity: Identity): Promise<ActionSchedule> {
    const targetTitle = await this.targetTitle(r)
    return {
      id: r.id,
      action: r.action,
      title: r.title,
      owner: r.owner,
      target: r.target,
      targetTitle,
      inputs: r.inputs,
      cadence: r.cadence,
      when: cadenceWords(r.cadence),
      deliver: r.deliver,
      tell: r.tell,
      state: r.state,
      load: r.load,
      decidedBy: r.decided_by,
      decidedAt: r.decided_at?.toISOString() ?? null,
      note: r.note,
      nextAt: r.next_at?.toISOString() ?? null,
      lastAt: r.last_at?.toISOString() ?? null,
      lastRun: r.last_run,
      lastBatch: r.last_batch,
      createdAt: r.created_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
      mine: r.owner === identity.name || decides(identity),
      canDecide: r.state === 'awaiting' && decides(identity),
    }
  }
}
