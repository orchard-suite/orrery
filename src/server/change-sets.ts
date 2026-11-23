// Change sets: many runs asked together for one decision. Each item names its
// own action, the entity it runs on, and its own inputs, and items may mix
// actions; the set has a title and the reason behind it. Every item is judged
// as a run of it alone would be (`judgeItem` in actions.ts), and the whole set
// is refused, naming each item, when any one would be. Each item is then its
// own run, which names the set and its place in it, so each is recorded, run,
// and retried on its own; the set is what a person reads and decides.
//
// One approval approves every run of the set, each by the rules that decide a
// run alone (`approve` in actions.ts, with the set named): a run made as a
// person runs as the approver, from their own sign-in, and a quorum asks each
// approver once for the whole set. The approver must be able to decide every
// run, and see what each runs on, before any is approved. Approved runs keep
// to each action's `concurrency`, and wait their turn in the set's order. A
// run of a set is never decided or withdrawn alone. Rejecting the set declines
// every run; the person who asked withdraws it while it waits.
//
// The approver sees one thing: the approvals inbox holds one record for the
// set (`approvals.ts`), and the notification desk hears of it once when it is
// asked, decided, and ended (`notices.ts`), never of its runs.

import { randomBytes } from 'node:crypto'
import type { BatchCounts, ChangeSetApproval, ChangeSetDecision, ChangeSetItem, ChangeSetRefusal, ChangeSetRequest, ChangeSetResponse, ChangeSetSummary } from '../shared/api.ts'
import { CHANGE_SET_MAX, entityId, type ActionRun, type ActionRunState, type Identity } from '../shared/model.ts'
import { withoutAttached } from '../shared/input-kinds.ts'
import { record } from './activity.ts'
import { ActionError, madeAsPerson, type Actions, type JudgedRun } from './actions.ts'
import { askingFor, needsOwnSignIn } from './behalf.ts'
import type { Db } from './db.ts'
import type { Events } from './events.ts'
import type { Logger } from './log.ts'
import type { View } from './visibility.ts'

export interface ChangeSetsDeps {
  db: Db
  actions: Actions
  events: Events
  /** Everyone enrolled, as the hub judges each now: who decides a set is read from them. */
  people: () => Identity[]
  /** What a person sees, to judge whether they may decide a set. */
  viewOf: (identity: Identity) => Promise<View>
  log: Logger
}

/** A set refused whole, with each item that refused it. */
export class ChangeSetRefused extends ActionError {
  readonly items: ChangeSetRefusal[]

  constructor(message: string, items: ChangeSetRefusal[]) {
    super(message, 400)
    this.items = items
  }
}

interface SetRow {
  id: string
  title: string
  note: string | null
  actor: string
  through: string | null
  retries: string | null
  created_at: Date
  decision: Exclude<ChangeSetDecision, 'pending'> | null
  decided_by: string | null
  decided_at: Date | null
  decision_note: string | null
  reminded_at: Date | null
  ended_at: Date | null
}

/** What a list of change sets is narrowed to. */
export interface ChangeSetListQuery {
  /** Asked by this person. */
  by?: string
  /** Only the sets that wait for the reader's own decision. */
  waiting?: boolean
  /** Asked at or after this. */
  since?: Date
  limit?: number
}

/** How many sets a list names at most, and how many it reads to find them. */
const LIST_MAX = 50
const LIST_READ = 500

export class ChangeSets {
  private readonly deps: ChangeSetsDeps

  constructor(deps: ChangeSetsDeps) {
    this.deps = deps
  }

  /**
   * Asks for every item of a request as one set. Each is judged as a run of
   * it alone would be; when any is refused, nothing is written and every
   * refused item is named. Someone must be able to approve every run of it.
   */
  async create(req: ChangeSetRequest, identity: Identity, view: View, how: { via: 'form' | 'tool'; through?: string; retries?: string }): Promise<ChangeSetSummary> {
    const title = req.title.trim()
    if (!title) throw new ActionError('A change set needs a title, to say what it changes', 400)
    if (!req.items.length) throw new ActionError('A change set holds at least one change', 400)
    if (req.items.length > CHANGE_SET_MAX) throw new ActionError(`A change set holds at most ${CHANGE_SET_MAX.toLocaleString('en-US')} changes, and this one has ${req.items.length.toLocaleString('en-US')}: split it`, 400)
    const id = randomBytes(6).toString('hex')
    const judged: JudgedRun[] = []
    const refused: ChangeSetRefusal[] = []
    for (const [index, item] of req.items.entries()) {
      // An action the reader may not see is said the same way as one that does not exist.
      const action = this.deps.actions.get(item.action)
      const refuse = (error: string, input?: string) => refused.push({ index, action: item.action, entity: item.entity ?? null, error, ...(input ? { input } : {}) })
      if (!action || !view.seesAction(action)) {
        refuse(`Unknown action "${item.action}"`)
        continue
      }
      if (item.entity && !view.seesBlueprint(item.entity.blueprint)) {
        refuse(`Action "${item.action}" cannot run on ${entityId(item.entity)}: it does not exist, or the action does not apply to it`)
        continue
      }
      try {
        judged.push(await this.deps.actions.judgeItem(item.action, item, identity, view, { via: how.via, ...(how.through ? { through: how.through } : {}) }))
      } catch (error) {
        if (!(error instanceof ActionError)) throw error
        refuse(error.message, error.input)
      }
    }
    if (refused.length) {
      this.deps.log.info('change set refused: some of its changes would be refused alone', { by: identity.name, items: req.items.length, refused: refused.length })
      throw new ChangeSetRefused(`${refused.length} of its ${req.items.length} changes would be refused, so none is asked: ${refused[0]!.error}`, refused)
    }
    const hold = await this.deps.actions.holdSet(id, judged, identity)
    if ('refused' in hold) throw new ChangeSetRefused(`Nobody could approve ${hold.refused.length} of its ${req.items.length} changes, so none is asked: ${hold.refused[0]!.why}`, hold.refused.map((r) => ({ index: r.index, action: req.items[r.index]!.action, entity: req.items[r.index]!.entity ?? null, error: r.why })))
    if ('none' in hold) throw new ActionError(hold.none, 409)
    await this.deps.db.tx(async (client) => {
      await client.query('INSERT INTO change_sets (id, title, note, actor, through, retries) VALUES ($1,$2,$3,$4,$5,$6)', [id, title.slice(0, 200), req.note?.trim() || null, identity.name, how.through ?? null, how.retries ?? null])
      await this.deps.actions.putSet(client, id, judged, hold.held, identity, how.through)
      await record(client, 'action.set_requested', null, null, identity.name, { set: id, title, runs: judged.length, actions: [...new Set(judged.map((j) => j.action.id))], held: hold.held, ...(how.through ? { via: how.through } : {}), ...(how.retries ? { retries: how.retries } : {}) })
    })
    this.deps.log.info('change set asked', { set: id, by: identity.name, through: how.through ?? null, runs: judged.length, actions: new Set(judged.map((j) => j.action.id)).size, held: hold.held, retries: how.retries ?? null })
    this.emit(id)
    return this.summary((await this.row(id))!, await this.runsOf(id))
  }

  /** One set with every run in its place, for a reader who may see it. */
  async get(id: string, identity: Identity, view: View): Promise<ChangeSetResponse> {
    const row = await this.row(id)
    const runs = row ? await this.runsOf(id) : []
    if (!row || !(await this.sees(row, runs, identity, view))) throw new ActionError(`Unknown change set "${id}"`, 404)
    const shown = await this.deps.actions.titles(runs, view)
    const items: ChangeSetItem[] = shown.map((r, index) => ({
      index,
      run: r.id,
      action: r.action,
      actionTitle: this.deps.actions.get(r.action)?.title ?? r.action,
      entity: r.entity,
      entityTitle: r.entityTitle ?? null,
      inputs: withoutAttached(this.deps.actions.get(r.action)?.inputs, r.inputs),
      ...(r.inputTitles ? { inputTitles: r.inputTitles } : {}),
      state: r.state,
      summary: r.summary,
      approvalsNeeded: r.approvalsNeeded ?? 1,
      approvedBy: r.approvedBy ?? [],
      attempt: r.attempt,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
    }))
    const summary = this.summary(row, runs)
    const mine = row.actor === identity.name || !!identity.admin
    const canDecide = summary.decision === 'pending' && !identity.viewAs && (await this.whyNot(identity, view, id, runs)) === null
    return { ...summary, items, canDecide, canWithdraw: mine && summary.decision === 'pending', canRetry: mine && summary.done && (summary.counts.failed ?? 0) > 0 }
  }

  /**
   * Approves every run of a set that waits, in the set's order, as one
   * decision: each as it would be approved alone. Nothing is approved unless
   * the approver may decide every run of it; a run made as a person runs as
   * them, from this request's own sign-in.
   */
  async approve(id: string, identity: Identity, view: View, note?: string): Promise<ChangeSetApproval> {
    const { row, waiting } = await this.deciding(id, identity, view)
    const people = waiting.filter((r) => { const a = this.deps.actions.get(r.action); return !!a && !!madeAsPerson(a) })
    if (people.length && askingFor()?.toLowerCase() !== identity.name.toLowerCase()) {
      this.deps.log.warn('change set approval refused: some of its runs are made as whoever approves them, and the approval carries no sign-in of theirs', { set: id, by: identity.name, asPerson: people.length })
      needsOwnSignIn(identity.name, 'Approving this change set')
      throw new ActionError(`${people.length} of its changes are made as whoever approves them, from their own signed-in approval, and this approval carries no sign-in of yours: approve it on its page, ${this.deps.actions.setUrl(id)}`, 403)
    }
    let approved = 0
    let voted = 0
    for (const run of waiting) {
      const done = await this.deps.actions.approve(run.id, identity, view, note, id)
      if (done.state === 'awaiting') voted++
      else approved++
    }
    const left = (await this.runsOf(id)).filter((r) => r.state === 'awaiting').length
    if (!left) await this.decided(row, 'approved', identity, note)
    this.deps.log.info(left ? 'change set approved by one of several' : 'change set approved', { set: id, by: identity.name, approved, voted, left })
    this.emit(id)
    return { approved, voted, set: this.summary((await this.row(id))!, await this.runsOf(id)) }
  }

  /** Rejects a set: every run of it that waits is declined, as one decision, by someone who may decide every one. */
  async reject(id: string, identity: Identity, view: View, reason?: string): Promise<ChangeSetSummary> {
    const { row, waiting } = await this.deciding(id, identity, view)
    for (const run of waiting) await this.deps.actions.decline(run.id, identity, reason, view, id)
    await this.decided(row, 'rejected', identity, reason)
    this.deps.log.info('change set rejected', { set: id, by: identity.name, declined: waiting.length })
    this.emit(id)
    return this.summary((await this.row(id))!, await this.runsOf(id))
  }

  /** Withdraws a set that waits: every run of it is cancelled. Whoever asked for it, or an admin. */
  async withdraw(id: string, identity: Identity, reason?: string): Promise<ChangeSetSummary> {
    const row = await this.row(id)
    if (!row || (row.actor !== identity.name && !identity.admin)) throw new ActionError(`Unknown change set "${id}"`, 404)
    const waiting = (await this.runsOf(id)).filter((r) => r.state === 'awaiting')
    if (row.decision || !waiting.length) throw new ActionError(`Change set "${id}" is ${row.decision ?? 'approved'}: only one that waits for its decision is withdrawn`, 409)
    for (const run of waiting) await this.deps.actions.withdraw(run.id, identity, reason, id)
    await this.decided(row, 'withdrawn', identity, reason)
    this.deps.log.info('change set withdrawn', { set: id, by: identity.name, cancelled: waiting.length })
    this.emit(id)
    return this.summary((await this.row(id))!, await this.runsOf(id))
  }

  /** Asks again, as a new set for approval, for every item of a set whose run failed. Whoever asked for it, or an admin. */
  async retry(id: string, identity: Identity, view: View, how: { via: 'form' | 'tool' }): Promise<ChangeSetSummary> {
    const row = await this.row(id)
    if (!row || (row.actor !== identity.name && !identity.admin)) throw new ActionError(`Unknown change set "${id}"`, 404)
    const failed = (await this.runsOf(id)).filter((r) => r.state === 'failed')
    if (!failed.length) throw new ActionError(`Change set "${id}" has no change that failed`, 409)
    this.deps.log.info('change set asked again for its failed changes', { set: id, by: identity.name, failed: failed.length })
    return this.create({ title: `Retry: ${row.title}`.slice(0, 200), ...(row.note ? { note: row.note } : {}), items: failed.map((r) => ({ action: r.action, ...(r.entity ? { entity: r.entity } : {}), inputs: r.inputs })) }, identity, view, { ...how, retries: id })
  }

  /** Decides a set as a `decide` action asks, for the approvals inbox: approve or reject. */
  async decide(id: string, approve: boolean, who: Identity, view: View, note?: string): Promise<void> {
    if (approve) await this.approve(id, who, view, note)
    else await this.reject(id, who, view, note)
  }

  /** The newest sets the reader may see, or only those that wait for their decision. */
  async list(identity: Identity, view: View, q: ChangeSetListQuery = {}): Promise<ChangeSetSummary[]> {
    const most = Math.min(q.limit ?? LIST_MAX, LIST_MAX)
    const out: ChangeSetSummary[] = []
    // A page of sets at a time, with their runs, until the list is full: a reader is shown only the sets they may see.
    for (let read = 0; read < LIST_READ && out.length < most; read += LIST_MAX) {
      const rows = await this.deps.db.query<SetRow>(
        `SELECT * FROM change_sets WHERE ($1::text IS NULL OR actor = $1) AND ($2::timestamptz IS NULL OR created_at >= $2) AND (NOT $3::boolean OR decision IS NULL) ORDER BY created_at DESC, id LIMIT $4 OFFSET $5`,
        [q.by ?? null, q.since ?? null, !!q.waiting, LIST_MAX, read],
      )
      const runs = await this.runsOfMany(rows.rows.map((r) => r.id))
      for (const row of rows.rows) {
        if (out.length >= most) break
        const held = runs.get(row.id) ?? []
        if (!(await this.sees(row, held, identity, view))) continue
        if (q.waiting && (identity.viewAs || !held.some((r) => r.state === 'awaiting') || (await this.whyNot(identity, view, row.id, held)) !== null)) continue
        out.push(this.summary(row, held))
      }
      if (rows.rows.length < LIST_MAX) break
    }
    return out
  }

  /**
   * What a set holds, for its notice and its record: the row, its runs, who
   * may decide it while it waits (`deciders`, everyone its Approve button
   * lets in), and who a rule names to decide it (`named`, who to tell).
   */
  async told(id: string, tell = false): Promise<{ summary: ChangeSetSummary; runs: ActionRun[]; deciders: string[]; named: string[] } | null> {
    const row = await this.row(id)
    if (!row) return null
    const runs = await this.runsOf(id)
    const summary = this.summary(row, runs)
    const pending = summary.decision === 'pending'
    return { summary, runs, deciders: pending && !tell ? await this.deciders(id, runs) : [], named: pending && tell ? await this.deps.actions.setDeciders(id, runs) : [] }
  }

  /** The sign-in addresses of everyone enrolled who may decide every run of a set that waits. */
  async deciders(id: string, runs?: ActionRun[]): Promise<string[]> {
    const held = runs ?? (await this.runsOf(id))
    const named: string[] = []
    for (const person of this.deps.people()) if ((await this.whyNot(person, await this.deps.viewOf(person), id, held)) === null) named.push(person.name)
    this.deps.log.debug(named.length ? 'change set has deciders' : 'nobody enrolled decides the change set', { set: id, deciders: named.length })
    return named
  }

  /**
   * Marks each set whose last run has ended, once, and writes its end to the
   * activity log, which tells whoever asked. A set rejected or withdrawn ends
   * as it is decided, and is told then. Run by the leader.
   */
  async ended(): Promise<string[]> {
    const rows = await this.deps.db.query<SetRow>(
      `UPDATE change_sets s SET ended_at = now()
       WHERE s.ended_at IS NULL
         AND EXISTS (SELECT 1 FROM action_runs r WHERE r.change_set = s.id)
         AND NOT EXISTS (SELECT 1 FROM action_runs r WHERE r.change_set = s.id AND r.state IN ('awaiting', 'queued', 'running'))
       RETURNING *`,
    )
    if (!rows.rows.length) return []
    const runs = await this.runsOfMany(rows.rows.map((r) => r.id))
    for (const row of rows.rows) {
      const c = this.summary(row, runs.get(row.id) ?? []).counts
      if (row.decision === 'rejected' || row.decision === 'withdrawn') {
        this.deps.log.debug('change set ended as it was decided: nothing more to tell', { set: row.id, decision: row.decision })
        continue
      }
      await record(this.deps.db, 'action.set_finished', null, null, null, { set: row.id, title: row.title, requestedBy: row.actor, succeeded: c.succeeded ?? 0, failed: c.failed ?? 0, unknown: c.unknown ?? 0, cancelled: c.cancelled ?? 0, declined: c.declined ?? 0 }, new Date(), (c.failed ?? 0) > 0 ? 'failed' : 'ok')
      this.deps.log.info('change set finished', { set: row.id, counts: c })
      this.emit(row.id)
    }
    return rows.rows.map((r) => r.id)
  }

  /** The sets that have waited for their decision longer than `hours`, whose deciders were never told again. */
  async overdue(hours: number): Promise<string[]> {
    const rows = await this.deps.db.query<{ id: string }>(`SELECT id FROM change_sets WHERE decision IS NULL AND reminded_at IS NULL AND ended_at IS NULL AND created_at < now() - make_interval(hours => $1) ORDER BY created_at LIMIT 100`, [hours])
    return rows.rows.map((r) => r.id)
  }

  /** Keeps that a set's deciders were told again, so they are told once. */
  async reminded(id: string): Promise<void> {
    await this.deps.db.query('UPDATE change_sets SET reminded_at = now() WHERE id = $1', [id])
  }

  /** The set and its runs that wait, once this identity may decide every one of them. Throws what keeps them from it. */
  private async deciding(id: string, identity: Identity, view: View): Promise<{ row: SetRow; waiting: ActionRun[] }> {
    const row = await this.row(id)
    const runs = row ? await this.runsOf(id) : []
    if (!row || !(await this.sees(row, runs, identity, view))) throw new ActionError(`Unknown change set "${id}"`, 404)
    const waiting = runs.filter((r) => r.state === 'awaiting')
    if (row.decision || !waiting.length) throw new ActionError(`Change set "${id}" is ${row.decision ?? 'approved'}, not waiting for its decision`, 409)
    const why = await this.whyNot(identity, view, id, waiting)
    if (why) {
      this.deps.log.warn('change set decision refused', { set: id, by: identity.name, reason: why })
      throw new ActionError(why, 403)
    }
    return { row, waiting }
  }

  /** Why one identity may not decide every run of a set that waits, or null when they may: the first run that keeps them from it says why. */
  private async whyNot(identity: Identity, view: View, id: string, runs: ActionRun[]): Promise<string | null> {
    const waiting = runs.filter((r) => r.state === 'awaiting')
    if (!waiting.length) return 'Nothing of it waits for a decision'
    for (const run of waiting) {
      const why = await this.deps.actions.whyNotInSet(identity, view, run, id)
      if (why) return waiting.length > 1 ? `${why} (one of the ${waiting.length} changes that wait)` : why
    }
    return null
  }

  /**
   * Whether a reader may see a set: only when they may see what every run of
   * it runs on, and then whoever asked for it, decided it, or may decide it,
   * an admin, or someone the hub shows every one of its runs.
   */
  private async sees(row: SetRow, runs: ActionRun[], identity: Identity, view: View): Promise<boolean> {
    if (view.all) return true
    if (view.runs(runs).length < runs.length) return false
    if (row.actor === identity.name || row.decided_by === identity.name || identity.admin) return true
    if (runs.some((r) => r.state === 'awaiting') && (await this.whyNot(identity, view, row.id, runs)) === null) return true
    return (await this.deps.actions.runsFor(identity, view, runs)).length === runs.length
  }

  /** Writes how a set was decided as a whole, once, with the activity row that says so. */
  private async decided(row: SetRow, decision: Exclude<ChangeSetDecision, 'pending'>, identity: Identity, note?: string): Promise<void> {
    const at = new Date()
    const done = await this.deps.db.query('UPDATE change_sets SET decision = $2, decided_by = $3, decided_at = $4, decision_note = $5 WHERE id = $1 AND decision IS NULL', [row.id, decision, identity.name, at, note?.trim() || null])
    if (!done.rowCount) return void this.deps.log.info('change set already decided', { set: row.id, decision })
    const kind = decision === 'approved' ? 'action.set_approved' : decision === 'rejected' ? 'action.set_rejected' : 'action.set_withdrawn'
    await record(this.deps.db, kind, null, null, identity.name, { set: row.id, title: row.title, requestedBy: row.actor, ...(note?.trim() ? { [decision === 'approved' ? 'note' : 'reason']: note.trim() } : {}) })
  }

  private async row(id: string): Promise<SetRow | null> {
    return (await this.deps.db.query<SetRow>('SELECT * FROM change_sets WHERE id = $1', [id])).rows[0] ?? null
  }

  /** Every run of a set, in its place. */
  private async runsOf(id: string): Promise<ActionRun[]> {
    return (await this.runsOfMany([id])).get(id) ?? []
  }

  private async runsOfMany(ids: string[]): Promise<Map<string, ActionRun[]>> {
    const out = new Map<string, ActionRun[]>()
    if (!ids.length) return out
    for (const run of await this.deps.actions.runsOfSets(ids)) if (run.changeSet) out.set(run.changeSet, [...(out.get(run.changeSet) ?? []), run])
    return out
  }

  private summary(row: SetRow, runs: ActionRun[]): ChangeSetSummary {
    const counts: BatchCounts = {}
    for (const r of runs) counts[r.state] = (counts[r.state] ?? 0) + 1
    const open = (['awaiting', 'queued', 'running'] as ActionRunState[]).reduce((n, s) => n + (counts[s] ?? 0), 0)
    const actions: ChangeSetSummary['actions'] = []
    for (const r of runs) {
      const at = actions.find((a) => a.id === r.action)
      if (at) at.runs++
      else actions.push({ id: r.action, title: this.deps.actions.get(r.action)?.title ?? r.action, runs: 1 })
    }
    const ended = runs.reduce<string | null>((last, r) => (r.finishedAt && (!last || r.finishedAt > last) ? r.finishedAt : last), null)
    return {
      id: row.id,
      title: row.title,
      note: row.note,
      by: row.actor,
      through: row.through,
      retries: row.retries,
      createdAt: row.created_at.toISOString(),
      decision: row.decision ?? (counts.awaiting ? 'pending' : 'approved'),
      decidedBy: row.decided_by,
      decidedAt: row.decided_at?.toISOString() ?? null,
      decisionNote: row.decision_note,
      size: runs.length,
      actions,
      counts,
      done: runs.length > 0 && open === 0,
      endedAt: open === 0 ? ended : null,
      url: this.deps.actions.setUrl(row.id),
    }
  }

  private emit(id: string): void {
    this.deps.events.emit({ type: 'action_run', id })
  }
}
