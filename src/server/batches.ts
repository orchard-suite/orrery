// Batches: one action asked for on many entities at once. A person picks the
// entities from a grid, sees every one before anything is sent, and each gets
// its own run, judged by the same rules as a run asked for alone, so each is
// recorded, refused, approved, and retried on its own. A batch is the
// question that picked them, what was asked, and who asked; its runs name it.
//
// A batch's runs wait behind every run asked for alone: a runner claims a
// single run before any run of a batch (`claim` in actions.ts), so a person
// who asks for one thing never waits behind someone else's thousand. The
// activity log holds one row for asking the batch and one for each run's end,
// as a run alone does, so what each run did is on record. The notification
// desk hears of a batch once when it is asked and once when it ends, never of
// each run (`notices.ts`), except a run that waits for approval, whose
// deciders hear of it as of any other.

import { randomBytes } from 'node:crypto'
import type { ActionBatchResponse, ActionBatchSummary, BatchAgainRequest, BatchApproval, BatchCounts, BatchItem, BatchPreview, BatchRefusal, BatchRequest, EntityQuery } from '../shared/api.ts'
import { BATCH_MAX, PREVIEW_LISTED, actionTargets, entityId, isFinished, type Action, type ActionRunState, type EntityRef, type Filter, type Identity } from '../shared/model.ts'
import { isImageOutput, type OutputValue } from '../shared/run-marks.ts'
import { PACE_WINDOW, estimate, type BatchEstimate } from '../shared/estimate.ts'
import { record } from './activity.ts'
import { ActionError, type Actions } from './actions.ts'
import type { Db } from './db.ts'
import type { Events } from './events.ts'
import type { Logger } from './log.ts'
import type { Reader } from './read.ts'
import type { View } from './visibility.ts'

export interface BatchesDeps {
  db: Db
  actions: Actions
  reader: Reader
  events: Events
  log: Logger
}

interface BatchRow {
  id: string
  action: string
  blueprint: string
  query: { entities?: EntityRef[]; query?: EntityQuery }
  inputs: Record<string, unknown>
  actor: string
  asked: number
  refused: BatchRefusal[]
  created_at: Date
  stopped_at: Date | null
  stopped_by: string | null
  ended_at: Date | null
  schedule: string | null
}

/** One run of a batch as its grid reads it: what it ran on, how it stands, and what it said. */
/** What a list of batches is narrowed to. */
export interface BatchListQuery {
  action?: string
  by?: string
  since?: Date
  /** Asked before this. */
  until?: Date
  states?: ActionRunState[]
  /** Fired by this schedule; null for only the batches a person asked by hand. */
  schedule?: string | null
  /** How many at most; `LIST_MAX` unless named. */
  limit?: number
}

/** How a batch stands, for its summary. */
interface Standing {
  counts: BatchCounts
  ended: Date | null
  cover: { run: string; name: string } | null
}

interface ItemRow {
  id: string
  blueprint: string
  key: string
  state: ActionRunState
  summary: string | null
  outputs: Record<string, OutputValue>
  started_at: Date | null
  finished_at: Date | null
  attempt: number
  retry_at: Date | null
  runs: number
  images: string[] | null
}

/** How many batches a list names at most. */
const LIST_MAX = 50
/** The most batches one list reads, when it names how many. */
const BATCHES_MOST = 500

export class Batches {
  private readonly deps: BatchesDeps

  constructor(deps: BatchesDeps) {
    this.deps = deps
  }

  /**
   * The entities a request names, in title order: those named one by one, or
   * every one the question matches but the rows left out. Each is judged as
   * it would be alone, and one it would refuse is named with why.
   */
  private async plan(action: Action, picked: EntityRef[], identity: Identity, view: View): Promise<{ take: { blueprint: string; key: string; title: string }[]; refused: BatchRefusal[]; approval: number; waits: string[]; max: number }> {
    if (!action.batch) throw new ActionError(`Action "${action.id}" does not run on many at once`, 400)
    const targets = actionTargets(action)
    let refs = picked
    const seen = new Set<string>()
    refs = refs.filter((r) => !seen.has(entityId(r)) && !!seen.add(entityId(r)))
    const max = Math.min(action.batch.max, BATCH_MAX)
    if (refs.length > max) throw new ActionError(`That picks ${refs.length.toLocaleString('en-US')}, and one batch of "${action.title}" holds at most ${max.toLocaleString('en-US')}: narrow it`, 400)
    const allowed = await this.deps.actions.targets(identity, view, action, refs)
    const titles = await this.deps.reader.titlesOf(refs)
    const take: { blueprint: string; key: string; title: string }[] = []
    const refused: BatchRefusal[] = []
    const waits: string[] = []
    // The action's filter, as this caller reads it, is the same for each: read once which of them it takes.
    const filters = await this.deps.actions.filtersFor(identity, action)
    const taken = action.where || action.self ? await this.within(refs, (blueprint) => filters.where(blueprint)) : null
    for (const ref of refs) {
      const id = entityId(ref)
      const title = titles.get(id)
      // An entity gone, of the wrong kind, or one the reader may not see is said the same way, so a refusal tells nobody what exists.
      if (!title || !targets.includes(ref.blueprint) || !view.seesEntity(ref)) {
        refused.push({ ...ref, title: title ?? ref.key, reason: 'It does not exist, or the action does not apply to it' })
        continue
      }
      if (taken && !taken.has(id)) {
        refused.push({ ...ref, title, reason: 'The action does not apply to it' })
        continue
      }
      const target = allowed.get(id)
      if (!target) {
        refused.push({ ...ref, title, reason: 'No rule lets you run it on this' })
        continue
      }
      if (target.approval !== false) waits.push(id)
      take.push({ blueprint: ref.blueprint, key: ref.key, title })
    }
    take.sort((a, b) => a.title.localeCompare(b.title) || a.key.localeCompare(b.key))
    return { take, refused, approval: waits.length, waits, max }
  }

  /** The ids of the entities a filter takes, of those named, the filter read for each blueprint. */
  private async within(refs: EntityRef[], whereOn: (blueprint: string) => Filter | undefined): Promise<Set<string>> {
    const out = new Set<string>()
    const byBlueprint = new Map<string, string[]>()
    for (const r of refs) byBlueprint.set(r.blueprint, [...(byBlueprint.get(r.blueprint) ?? []), r.key])
    for (const [blueprint, keys] of byBlueprint) {
      const where = whereOn(blueprint)
      const { entities } = await this.deps.reader.list({ blueprint, states: ['active'], includeHidden: true, filter: { and: [{ field: '$key', op: 'in', value: keys }, ...(where ? [where] : [])] }, limit: Infinity })
      for (const e of entities) out.add(e.id)
    }
    return out
  }

  /**
   * The entities a request picks, before each is judged: those named one by
   * one, or every one a grid's question matched, which the caller read with
   * the reader's own view (`picked`).
   */
  private picked(action: Action, req: BatchRequest, picked: EntityRef[] | null): EntityRef[] {
    if (!!req.entities === !!req.query) throw new ActionError('Name the entities, or the question that picks them, not both', 400)
    if (req.query && !actionTargets(action).includes(req.query.blueprint)) throw new ActionError(`Action "${action.id}" does not run on a ${req.query.blueprint}`, 400)
    return req.query ? (picked ?? []) : req.entities!
  }

  /** What a batch would be asked for, and on what. Nothing is asked. `matched` is what the request's question matched, when it has one. */
  async preview(id: string, req: BatchRequest, matched: EntityRef[] | null, identity: Identity, view: View): Promise<BatchPreview> {
    const action = this.deps.actions.require(id)
    await this.open(action, identity)
    const plan = await this.plan(action, this.picked(action, req, matched), identity, view)
    // What each entity holds of its own inputs is judged as the batch will judge it, so the preview names what it would refuse.
    const filled = await this.deps.actions.inputsForMany(action, plan.take, req.inputs, identity, view, 'preview')
    if (filled.refused.length) {
      const out = new Set(filled.refused.map(entityId))
      const approving = new Set(plan.waits)
      plan.take = plan.take.filter((e) => !out.has(entityId(e)))
      plan.approval = plan.take.filter((e) => approving.has(entityId(e))).length
      plan.refused = [...plan.refused, ...filled.refused]
    }
    const ahead = await this.deps.actions.queuedAhead(action, null)
    const time = estimate({ left: plan.take.length + ahead, meanSeconds: await this.deps.actions.meanFor(action, req.inputs), width: this.deps.actions.widthOf(action) })
    this.deps.log.debug('batch previewed', { action: id, by: identity.name, entities: plan.take.length, refused: plan.refused.length, ahead, estimate: time })
    // A preview names the first few hundred of each, and counts them all: a batch of thousands is not sent back whole.
    return { action: id, total: plan.take.length, max: plan.max, entities: plan.take.slice(0, PREVIEW_LISTED), refused: plan.refused.slice(0, PREVIEW_LISTED), refusedTotal: plan.refused.length, approval: plan.approval, estimate: time, ahead }
  }

  /** Refuses an identity the action does not name, as a run alone would. */
  private async open(action: Action, identity: Identity): Promise<void> {
    if (action.tool || action.form === false) throw new ActionError(`Action "${action.id}" is not asked from a form`, 403)
    if (!(await this.deps.actions.mayRun(identity, action))) {
      await record(this.deps.db, 'access.refused', { blueprint: actionTargets(action)[0] }, null, identity.name, { action: action.id, reason: 'the action does not name them', batch: true }, new Date(), 'refused')
      throw new ActionError(`Action "${action.id}" is not open to you`, 403)
    }
  }

  /**
   * Asks for the action on every entity the request names, each its own run,
   * and keeps the batch. The inputs are checked once, as the form sent them,
   * with what narrows the target filled from each entity;
   * an entity a run alone would refuse is kept on the batch with why.
   */
  async start(id: string, req: BatchRequest, matched: EntityRef[] | null, identity: Identity, view: View): Promise<ActionBatchSummary> {
    const action = this.deps.actions.require(id)
    await this.open(action, identity)
    const plan = await this.plan(action, this.picked(action, req, matched), identity, view)
    if (!plan.take.length) throw new ActionError(plan.refused.length ? `It may run on none of the ${plan.refused.length} picked: ${plan.refused[0]!.reason}` : 'Nothing is picked', 400)
    const batchId = randomBytes(6).toString('hex')
    // Every run is checked as one alone would be; a refusal of what was sent stops the batch before anything is written.
    const asked = await this.deps.actions.askMany(action, plan.take, req.inputs, identity, view, batchId)
    const refused = [...plan.refused, ...asked.refused]
    await this.deps.db.query('INSERT INTO action_batches (id, action, blueprint, query, inputs, actor, asked, refused) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [
      batchId,
      action.id,
      req.query?.blueprint ?? plan.take[0]!.blueprint,
      JSON.stringify(req.query ? { query: req.query } : { entities: req.entities }),
      JSON.stringify(asked.inputs),
      identity.name,
      asked.runs,
      JSON.stringify(refused),
    ])
    await record(this.deps.db, 'action.batched', { blueprint: plan.take[0]!.blueprint }, null, identity.name, { action: action.id, batch: batchId, inputs: asked.inputs, runs: asked.runs, refused: refused.length, waiting: asked.waiting })
    this.deps.log.info('batch asked', { action: action.id, batch: batchId, by: identity.name, runs: asked.runs, refused: refused.length, waiting: asked.waiting })
    this.deps.events.emit({ type: 'action_run', id: batchId })
    return this.summary((await this.row(batchId))!, await this.standings([batchId]))
  }

  /**
   * Stops a batch: every run of it not started yet is cancelled. What is
   * running is left to end. Who asked for it, or an admin.
   */
  async stop(id: string, identity: Identity): Promise<ActionBatchSummary> {
    const row = await this.mine(id, identity)
    if (row.stopped_at) return this.summary(row, await this.standings([id]))
    const at = new Date()
    const cancelled = await this.deps.actions.cancelBatch(id, `the batch was stopped by ${identity.name}`, identity.name)
    await this.deps.db.query('UPDATE action_batches SET stopped_at = $2, stopped_by = $3 WHERE id = $1 AND stopped_at IS NULL', [id, at, identity.name])
    await record(this.deps.db, 'action.batch_stopped', { blueprint: row.blueprint }, null, identity.name, { action: row.action, batch: id, cancelled })
    this.deps.log.info('batch stopped', { batch: id, action: row.action, by: identity.name, cancelled })
    this.deps.events.emit({ type: 'action_run', id })
    return this.summary((await this.row(id))!, await this.standings([id]))
  }

  /**
   * Asks again, in the same batch, on some of its entities: those named, or
   * each whose newest run ended in one of the states given. One whose newest
   * run has not ended is left to end. Each new run is judged as one alone.
   */
  async again(id: string, req: BatchAgainRequest, identity: Identity, view: View): Promise<{ asked: number; refused: BatchRefusal[] }> {
    const row = await this.mine(id, identity)
    const action = this.deps.actions.require(row.action)
    await this.open(action, identity)
    const items = await this.items(id)
    const named = req.entities ? new Set(req.entities.map(entityId)) : null
    const states = new Set(req.states ?? [])
    const pick = items.filter((i) => isFinished(i.state) && (named ? named.has(entityId(i)) : states.has(i.state)))
    if (!pick.length) return { asked: 0, refused: [] }
    const plan = await this.plan(action, pick.map((i) => ({ blueprint: i.blueprint, key: i.key })), identity, view)
    if (!plan.take.length) return { asked: 0, refused: plan.refused }
    await this.deps.db.query('UPDATE action_batches SET stopped_at = NULL, stopped_by = NULL, ended_at = NULL WHERE id = $1', [id])
    const asked = await this.deps.actions.askMany(action, plan.take, row.inputs, identity, view, id)
    await this.deps.db.query('UPDATE action_batches SET asked = asked + $2 WHERE id = $1', [id, asked.runs])
    await record(this.deps.db, 'action.batched', { blueprint: row.blueprint }, null, identity.name, { action: row.action, batch: id, again: true, runs: asked.runs, refused: plan.refused.length + asked.refused.length })
    this.deps.log.info('batch asked again', { batch: id, action: row.action, by: identity.name, runs: asked.runs })
    this.deps.events.emit({ type: 'action_run', id })
    return { asked: asked.runs, refused: [...plan.refused, ...asked.refused] }
  }

  /** The batch, if the reader may act on it: who asked for it, or an admin. Anyone else is told it does not exist. */
  private async mine(id: string, identity: Identity): Promise<BatchRow> {
    const row = await this.row(id)
    if (!row || (row.actor !== identity.name && !identity.admin)) throw new ActionError(`Unknown batch "${id}"`, 404)
    return row
  }

  /**
   * How long a batch still has: its runs waiting or running, with what of
   * its runner's queue goes before them, at its own pace over the last few
   * minutes once that is steady, and at the action's history before.
   */
  private async left(row: BatchRow, counts: BatchCounts): Promise<BatchEstimate | null> {
    const open = (counts.queued ?? 0) + (counts.running ?? 0)
    if (!open) return null
    const action = this.deps.actions.get(row.action)
    if (!action) return null
    const pace = await this.deps.db.query<{ ended: number; seconds: number | null }>(
      `SELECT (count(*) FILTER (WHERE finished_at >= now() - make_interval(secs => $2)))::int AS ended,
              extract(epoch FROM now() - greatest(now() - make_interval(secs => $2), min(started_at) FILTER (WHERE finished_at IS NULL OR finished_at >= now() - make_interval(secs => $2))))::float8 AS seconds
       FROM action_runs WHERE batch = $1 AND started_at IS NOT NULL`,
      [row.id, PACE_WINDOW],
    )
    const p = pace.rows[0]
    return estimate({
      left: open + (await this.deps.actions.queuedAhead(action, row.id)),
      meanSeconds: await this.deps.actions.meanFor(action, row.inputs),
      width: this.deps.actions.widthOf(action),
      ...(p && p.seconds !== null ? { pace: { ended: p.ended, seconds: p.seconds } } : {}),
    })
  }

  private async row(id: string): Promise<BatchRow | null> {
    return (await this.deps.db.query<BatchRow>('SELECT * FROM action_batches WHERE id = $1', [id])).rows[0] ?? null
  }

  /** The newest run of the batch on each entity, with how many runs it had there. */
  private async items(id: string): Promise<ItemRow[]> {
    const rows = await this.deps.db.query<ItemRow>(
      `SELECT DISTINCT ON (blueprint, key) id, blueprint, key, state, summary, outputs, images, started_at, finished_at, attempt, retry_at,
              (count(*) OVER (PARTITION BY blueprint, key))::int AS runs
       FROM action_runs WHERE batch = $1 ORDER BY blueprint, key, created_at DESC`,
      [id],
    )
    return rows.rows
  }

  /** How the runs of each batch stand, counting only the newest on each entity. */
  private async counts(ids: string[]): Promise<Map<string, BatchCounts>> {
    const out = new Map<string, BatchCounts>()
    if (!ids.length) return out
    const rows = await this.deps.db.query<{ batch: string; state: ActionRunState; n: number }>(
      `SELECT batch, state, count(*)::int AS n FROM (
         SELECT DISTINCT ON (batch, blueprint, key) batch, state FROM action_runs WHERE batch = ANY($1) ORDER BY batch, blueprint, key, created_at DESC
       ) newest GROUP BY batch, state`,
      [ids],
    )
    for (const r of rows.rows) out.set(r.batch, { ...out.get(r.batch), [r.state]: r.n })
    return out
  }

  /**
   * How each batch stands: its counts, when its last run ended, and a picture
   * to show it by, the first image any of its runs that worked reported. The
   * picture is found without reading every run: the first that holds one will
   * do.
   */
  private async standings(ids: string[]): Promise<Map<string, Standing>> {
    const out = new Map<string, Standing>()
    if (!ids.length) return out
    const [counts, ended, covers] = await Promise.all([
      this.counts(ids),
      this.deps.db.query<{ batch: string; ended: Date | null }>(`SELECT batch, max(finished_at) AS ended FROM action_runs WHERE batch = ANY($1) GROUP BY batch`, [ids]),
      this.deps.db.query<{ batch: string; run: string; name: string }>(
        `SELECT b.id AS batch, c.run, c.name FROM unnest($1::text[]) b(id)
         CROSS JOIN LATERAL (
           SELECT r.id AS run, r.images[1] AS name FROM action_runs r
           WHERE r.batch = b.id AND r.state = 'succeeded' AND cardinality(r.images) > 0 LIMIT 1
         ) c`,
        [ids],
      ),
    ])
    const endedOf = new Map(ended.rows.map((r) => [r.batch, r.ended]))
    const coverOf = new Map(covers.rows.map((r) => [r.batch, { run: r.run, name: r.name }]))
    for (const id of ids) out.set(id, { counts: counts.get(id) ?? {}, ended: endedOf.get(id) ?? null, cover: coverOf.get(id) ?? null })
    return out
  }

  private summary(row: BatchRow, standings: Map<string, Standing>): ActionBatchSummary {
    const st = standings.get(row.id)
    const c = st?.counts ?? {}
    const open = (c.awaiting ?? 0) + (c.queued ?? 0) + (c.running ?? 0)
    return {
      id: row.id,
      action: row.action,
      blueprint: row.blueprint,
      inputs: row.inputs,
      by: row.actor,
      asked: row.asked,
      refused: row.refused.length,
      counts: c,
      done: open === 0,
      createdAt: row.created_at.toISOString(),
      stoppedAt: row.stopped_at?.toISOString() ?? null,
      stoppedBy: row.stopped_by,
      endedAt: open === 0 ? (st?.ended?.toISOString() ?? null) : null,
      cover: st?.cover ?? null,
    }
  }

  /**
   * One batch with every entity's newest run, for a reader who may see its
   * runs: who asked for it, an admin, or someone the action lets run. Its
   * images are named, never carried: a grid reads each as it shows it.
   */
  async get(id: string, identity: Identity, view: View): Promise<ActionBatchResponse> {
    const row = await this.row(id)
    if (!row || !(await this.sees(row, identity, view))) throw new ActionError(`Unknown batch "${id}"`, 404)
    const items = await this.items(id)
    const titles = await this.deps.reader.titlesOf(items)
    const shown: BatchItem[] = items.map((i) => {
      const outputs: Record<string, OutputValue> = i.outputs ?? {}
      const images = i.images ?? []
      return { blueprint: i.blueprint, key: i.key, title: titles.get(entityId(i)) ?? i.key, run: i.id, state: i.state, summary: i.summary, outputs, images, runs: i.runs, attempt: i.attempt, retryAt: i.retry_at?.toISOString() ?? null, startedAt: i.started_at?.toISOString() ?? null, finishedAt: i.finished_at?.toISOString() ?? null }
    })
    shown.sort((a, b) => a.title.localeCompare(b.title) || a.key.localeCompare(b.key))
    const standings = await this.standings([id])
    const waiting = items.find((i) => i.state === 'awaiting')
    const first = waiting ? await this.deps.actions.getRun(waiting.id) : null
    const canDecide = first ? await this.deps.actions.mayDecide(identity, view, first) : false
    return { ...this.summary(row, standings), left: await this.left(row, standings.get(id)?.counts ?? {}), items: shown, refusedItems: row.refused, canAct: row.actor === identity.name || !!identity.admin, canDecide }
  }

  /**
   * Approves every run of a batch that waits for approval, as one decision:
   * each run is approved as it would be alone, judged on its own entity, and
   * one the approver may not decide is left waiting and counted with why. A
   * run made as a person runs as the approver, from this request's sign-in.
   */
  async approve(id: string, identity: Identity, view: View, note?: string): Promise<BatchApproval> {
    const row = await this.row(id)
    if (!row || !(await this.sees(row, identity, view))) throw new ActionError(`Unknown batch "${id}"`, 404)
    const waiting = await this.deps.db.query<{ id: string }>(`SELECT id FROM action_runs WHERE batch = $1 AND state = 'awaiting' ORDER BY created_at, id`, [id])
    if (!waiting.rowCount) throw new ActionError(`Batch "${id}" has no run waiting for approval`, 409)
    let approved = 0
    let voted = 0
    const why = new Map<string, number>()
    for (const { id: run } of waiting.rows) {
      try {
        const done = await this.deps.actions.approve(run, identity, view, note)
        if (done.state === 'awaiting') voted++
        else approved++
      } catch (error) {
        if (!(error instanceof ActionError)) throw error
        why.set(error.message, (why.get(error.message) ?? 0) + 1)
      }
    }
    const refused = [...why].map(([reason, runs]) => ({ reason, runs }))
    this.deps.log.info(approved || voted ? 'batch approved' : 'batch approval refused for every run', { batch: id, action: row.action, by: identity.name, approved, voted, refused: waiting.rows.length - approved - voted })
    this.deps.events.emit({ type: 'action_run', id })
    if (!approved && !voted) throw new ActionError(refused[0]!.reason, 403)
    return { approved, voted, refused }
  }

  /** Whether a reader may see a batch: who asked for it, an admin, or someone the action lets run and who may see its blueprint. */
  private async sees(row: BatchRow, identity: Identity, view: View): Promise<boolean> {
    if (row.actor === identity.name || identity.admin || view.all) return true
    const action = this.deps.actions.get(row.action)
    if (!action || !view.seesAction(action) || !view.seesSome(row.blueprint)) return false
    return this.deps.actions.mayRun(identity, action)
  }

  /**
   * The newest batches the reader may see: of one action, asked by one
   * person, asked at or after `since`, holding a run in one of `states`, when
   * the question names them.
   */
  async list(identity: Identity, view: View, q: BatchListQuery = {}): Promise<ActionBatchSummary[]> {
    const rows = await this.deps.db.query<BatchRow>(
      `SELECT * FROM action_batches b
       WHERE ($1::text IS NULL OR action = $1) AND ($2::text IS NULL OR actor = $2) AND ($3::timestamptz IS NULL OR created_at >= $3)
         AND ($4::text[] IS NULL OR EXISTS (SELECT 1 FROM action_runs r WHERE r.batch = b.id AND r.state = ANY($4)))
         AND ($6::timestamptz IS NULL OR created_at < $6)
         AND (NOT $7::boolean OR schedule IS NULL) AND ($8::text IS NULL OR schedule = $8)
       ORDER BY created_at DESC LIMIT $5`,
      [q.action ?? null, q.by ?? null, q.since ?? null, q.states ?? null, Math.min(q.limit ?? LIST_MAX, BATCHES_MOST), q.until ?? null, q.schedule === null, q.schedule ?? null],
    )
    const seen: BatchRow[] = []
    for (const r of rows.rows) if (await this.sees(r, identity, view)) seen.push(r)
    const standings = await this.standings(seen.map((r) => r.id))
    return seen.map((r) => this.summary(r, standings))
  }

  /** Each named batch the reader may see, as it stands now, by id. */
  async summaries(ids: string[], identity: Identity, view: View): Promise<Record<string, ActionBatchSummary>> {
    if (!ids.length) return {}
    const rows = await this.deps.db.query<BatchRow>('SELECT * FROM action_batches WHERE id = ANY($1)', [ids])
    const seen: BatchRow[] = []
    for (const r of rows.rows) if (await this.sees(r, identity, view)) seen.push(r)
    const standings = await this.standings(seen.map((r) => r.id))
    return Object.fromEntries(seen.map((r) => [r.id, this.summary(r, standings)]))
  }

  /**
   * Marks each batch whose last run has ended, once, and writes its end to the
   * activity log, which tells the desk. A batch asked again opens again and
   * ends again. Run by the leader.
   */
  async ended(): Promise<string[]> {
    const rows = await this.deps.db.query<{ id: string; action: string; blueprint: string; actor: string }>(
      `UPDATE action_batches b SET ended_at = now()
       WHERE b.ended_at IS NULL
         AND EXISTS (SELECT 1 FROM action_runs r WHERE r.batch = b.id)
         AND NOT EXISTS (SELECT 1 FROM action_runs r WHERE r.batch = b.id AND r.state IN ('awaiting', 'queued', 'running'))
       RETURNING b.id, b.action, b.blueprint, b.actor`,
    )
    if (!rows.rows.length) return []
    const counts = await this.counts(rows.rows.map((r) => r.id))
    for (const r of rows.rows) {
      const c = counts.get(r.id) ?? {}
      await record(this.deps.db, 'action.batch_finished', { blueprint: r.blueprint }, null, null, { action: r.action, batch: r.id, requestedBy: r.actor, succeeded: c.succeeded ?? 0, failed: c.failed ?? 0, unknown: c.unknown ?? 0, cancelled: c.cancelled ?? 0, declined: c.declined ?? 0 }, new Date(), (c.failed ?? 0) > 0 ? 'failed' : 'ok')
      this.deps.log.info('batch finished', { batch: r.id, action: r.action, counts: c })
      this.deps.events.emit({ type: 'action_run', id: r.id })
    }
    return rows.rows.map((r) => r.id)
  }

  /** What a batch holds, for its notice: the action, who asked, and how its runs stand. */
  async told(id: string): Promise<{ row: BatchRow; counts: BatchCounts } | null> {
    const row = await this.row(id)
    if (!row) return null
    return { row, counts: (await this.counts([id])).get(id) ?? {} }
  }
}
