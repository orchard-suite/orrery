// The hub's own approvals as records in the estate's approvals blueprint. An
// estate keeps one inbox of every approval its systems hold, as a blueprint a
// person picks (`approvals` under Access): each system pushes its own, and
// approving one runs an action that asks the system that owns it. The hub's
// share is the runs and schedules that wait for someone to decide them; this
// writes each as a record, as the hub, and keeps it as the run or schedule
// stands, from the activity log, so nothing that decides one writes it here.
//
// A record carries the fields its blueprint declares and no other, so an
// estate names only what it wants: `source`, `kind`, `title`, `decision`
// (pending, approved, declined, or expired), `reason`, `requested_by`,
// `requested_at`, `decided_by`, `decided_at`, `decision_note`, `approvals_needed`
// (how many people must approve; one unless the action asks for more),
// `approved_by` (who has, while it waits for the rest), `round` (which round
// of its ask the record shows), and `url`;
// and the relations `requester` and `approvers` to the person blueprint,
// which an ownership path can open each record to. A person is linked only
// when their record exists, so a run a machine asked for links no one. The
// entity a run or schedule acts on is linked through the one other relation
// whose target is that entity's blueprint, so an estate links what it wants
// by declaring a relation to it: `service` to its services, say.
//
// A run that `revises` another is the next round of the same ask, so an ask
// is one record however many rounds it takes: keyed by its first round, and
// showing its newest, whose page `url` names. The rounds before stay on the
// hub as runs.

import type { MyApprovals } from '../shared/api.ts'
import { changeLines, runChanges } from '../shared/list-change.ts'
import type { ActionInputDef, ActionRun, Blueprint, EntityRef, Identity } from '../shared/model.ts'
import type { Actions } from './actions.ts'
import type { Blueprints } from './blueprints.ts'
import type { ChangeSets } from './change-sets.ts'
import type { Db } from './db.ts'
import type { Entities } from './entities.ts'
import type { Logger } from './log.ts'
import type { Reader } from './read.ts'
import type { Schedules } from './schedules.ts'
import type { Sources } from './sources.ts'
import type { View } from './visibility.ts'

/** The setting naming the blueprint the hub writes its approvals into. */
export interface ApprovalsSetting {
  blueprint: string
}

const SETTING_KEY = 'approvals'
const MARK_KEY = 'approvals.mirrored'
const KINDS = ['action.set_requested', 'action.set_approved', 'action.set_rejected', 'action.set_withdrawn', 'action.requested', 'action.voted', 'action.approved', 'action.declined', 'action.returned', 'action.cancelled', 'action.finished', 'schedule.requested', 'schedule.changed', 'schedule.approved', 'schedule.declined', 'schedule.removed']
/**
 * What moves who may decide a run or schedule already waiting, without
 * naming one: an action's definition, a role, a person coming, changing, or
 * going, and the access policy and the approvals setting. Each sends every
 * pending record back to be judged again.
 */
const MOVES_DECIDERS = ['action.changed', 'role.changed', 'user.enrolled', 'user.changed', 'user.removed', 'access.changed']
const BATCH = 200
/** The source every record of the hub's own approvals is written as. */
export const APPROVALS_SOURCE = 'hub'

export type Decision = 'pending' | 'approved' | 'declined' | 'expired'

/** What one record of the hub's says, before it is cut to what its blueprint declares. */
interface Record_ {
  key: string
  title: string
  fields: Record<string, unknown>
  requester: string
  approvers: string[]
  /** The one entity the run or schedule acts on, or null. */
  on: EntityRef | null
}

export interface ApprovalsDeps {
  db: Db
  blueprints: Blueprints
  entities: Entities
  reader: Reader
  sources: Sources
  actions: Actions
  schedules: Schedules
  sets: ChangeSets
  /** Everyone enrolled, as the hub judges each now. */
  people: () => Identity[]
  /** What a person sees, to judge whether they may decide a run. */
  viewOf: (identity: Identity) => Promise<View>
  /** The person blueprint, and the field a sign-in address is kept in when it is not the key. */
  person: () => { blueprint: string; field?: string } | null
  publicUrl: string
  log: Logger
}

/**
 * What a run asks, a line an input: each value as given, and for an input that
 * changes a list the entity holds, what it adds and what it removes against
 * the list kept as it was asked, so whoever approves reads the change itself.
 */
export function reasonOf(defs: Record<string, ActionInputDef> | undefined, run: Pick<ActionRun, 'inputs' | 'current'>): string {
  const changed = runChanges(defs, run.inputs, run.current)
  return Object.entries(run.inputs)
    .filter(([, v]) => v !== null && v !== '')
    .flatMap(([k, v]) => {
      const title = defs?.[k]?.title ?? k
      const c = changed[k]
      return c ? changeLines(title, c) : [`${title}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`]
    })
    .join('\n')
}

/** The key of the record a run, schedule, or change set of the hub's is written under: for a run, the first round of its ask. */
export function approvalKey(kind: 'run' | 'schedule' | 'set', id: string): string {
  return `orrery/${kind}/${id}`
}

/** What a record's key says it stands for: one of the hub's runs, schedules, or change sets, or null for anyone else's. */
export function approvalOf(key: string): { kind: 'run' | 'schedule' | 'set'; id: string } | null {
  const m = /^orrery\/(run|schedule|set)\/([^/]+)$/.exec(key)
  return m ? { kind: m[1] as 'run' | 'schedule' | 'set', id: m[2]! } : null
}

export class Approvals {
  private readonly deps: ApprovalsDeps
  private current: ApprovalsSetting | null = null

  constructor(deps: ApprovalsDeps) {
    this.deps = deps
  }

  async load(): Promise<void> {
    const row = await this.deps.db.query<{ value: ApprovalsSetting }>('SELECT value FROM settings WHERE key = $1', [SETTING_KEY])
    this.current = row.rows[0]?.value ?? null
  }

  setting(): ApprovalsSetting | null {
    return this.current
  }

  /** Names the blueprint the hub writes its approvals into, or none. From then on the hub writes there, as the hub. */
  async set(next: ApprovalsSetting | null): Promise<void> {
    if (next) {
      const bp = this.deps.blueprints.get(next.blueprint)
      if (!bp) throw new Error(`Unknown blueprint "${next.blueprint}"`)
      if (!bp.fields.decision) throw new Error(`Blueprint "${next.blueprint}" has no "decision" field: an approval's record says how it was decided`)
      await this.deps.db.query('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [SETTING_KEY, JSON.stringify(next)])
    } else await this.deps.db.query('DELETE FROM settings WHERE key = $1', [SETTING_KEY])
    this.current = next
    await this.deps.sources.ensureBuiltins(next ? [next.blueprint] : [])
    this.deps.log.info('approvals blueprint set', { approvals: next })
  }

  /**
   * Writes the record of every run and schedule an approval row in the
   * activity log names since the last pass, as each stands now. Rows of a run
   * that never waited for anyone are passed over. How many it wrote.
   */
  async pass(): Promise<number> {
    // The setting is read again each pass: an admin names the blueprint on whichever hub took the request, and the hub that leads the background work is often another.
    await this.load()
    const setting = this.current
    if (!setting) {
      this.deps.log.debug('approvals not written: no approvals blueprint is named')
      return 0
    }
    // So is who may write it: the hub source learns the blueprint where the setting was saved.
    if (!this.deps.sources.get(APPROVALS_SOURCE)?.blueprints.includes(setting.blueprint)) await this.deps.sources.load()
    const bp = this.deps.blueprints.get(setting.blueprint)
    if (!bp) {
      this.deps.log.warn('approvals not written: their blueprint is gone', { blueprint: setting.blueprint })
      return 0
    }
    const mark = (await this.deps.db.query<{ value: { id: string } }>('SELECT value FROM settings WHERE key = $1', [MARK_KEY])).rows[0]?.value.id ?? '0'
    let after = mark
    let written = 0
    let moved: string | null = null
    const seen = new Set<string>()
    for (;;) {
      const rows = await this.deps.db.query<{ id: string; kind: string; detail: Record<string, unknown> }>(`SELECT id, kind, detail FROM changes WHERE id > $1 AND kind = ANY($2) ORDER BY id LIMIT $3`, [after, [...KINDS, ...MOVES_DECIDERS], BATCH])
      for (const row of rows.rows) {
        after = row.id
        if (MOVES_DECIDERS.includes(row.kind)) {
          moved ??= row.kind
          continue
        }
        const schedule = typeof row.detail.schedule === 'string' ? row.detail.schedule : null
        // A run of a change set is the set's: the set is one record, however many runs it holds.
        const set = typeof row.detail.set === 'string' ? row.detail.set : null
        const run = set ? null : typeof row.detail.run === 'string' ? row.detail.run : null
        const at = schedule ? `s:${schedule}` : set ? `c:${set}` : run ? `r:${run}` : null
        if (!at || seen.has(at)) continue
        seen.add(at)
        const rec = schedule ? await this.scheduleRecord(schedule, row.kind) : set ? await this.setRecord(set) : run ? await this.runRecord(run) : null
        // Rounds of one ask are one record: written once a pass.
        if (rec && run && seen.has(rec.key)) continue
        if (rec) seen.add(rec.key)
        if (rec && (await this.write(bp, rec))) written++
      }
      if (rows.rows.length < BATCH) break
    }
    // Who may decide moved: every record still pending is judged again, so the inbox follows the rules as they stand now.
    if (moved) {
      const runs = await this.deps.db.query<{ id: string }>(`SELECT id FROM action_runs WHERE state = 'awaiting' AND change_set IS NULL ORDER BY created_at, id`)
      const sets = await this.deps.db.query<{ id: string }>(`SELECT id FROM change_sets WHERE decision IS NULL AND ended_at IS NULL ORDER BY created_at, id`)
      const schedules = await this.deps.db.query<{ id: string }>(`SELECT id FROM action_schedules WHERE state = 'awaiting' ORDER BY created_at, id`)
      let again = 0
      for (const { id } of runs.rows) {
        if (seen.has(`r:${id}`)) continue
        seen.add(`r:${id}`)
        const rec = await this.runRecord(id)
        if (!rec || seen.has(rec.key)) continue
        seen.add(rec.key)
        if (await this.write(bp, rec)) again++
      }
      for (const { id } of sets.rows) {
        if (seen.has(`c:${id}`)) continue
        seen.add(`c:${id}`)
        const rec = await this.setRecord(id)
        if (rec && (await this.write(bp, rec))) again++
      }
      for (const { id } of schedules.rows) {
        if (seen.has(`s:${id}`)) continue
        seen.add(`s:${id}`)
        const rec = await this.scheduleRecord(id, 'schedule.changed')
        if (rec && (await this.write(bp, rec))) again++
      }
      written += again
      this.deps.log.info('pending approvals judged again: who may decide them moved', { blueprint: bp.id, because: moved, runs: runs.rowCount, sets: sets.rowCount, schedules: schedules.rowCount, written: again })
    } else this.deps.log.debug('who may decide pending approvals did not move this pass', { blueprint: bp.id })
    if (after !== mark) await this.deps.db.query('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [MARK_KEY, JSON.stringify({ id: after })])
    if (written) this.deps.log.info('approvals written', { blueprint: bp.id, written })
    return written
  }

  /**
   * The record of the ask a run is a round of, as its newest round stands, or
   * null when no round of it ever waited for anyone to decide it.
   */
  private async runRecord(id: string): Promise<Record_ | null> {
    const rounds = await this.deps.actions.roundsOf(id)
    if (!rounds) return null
    const run = rounds.latest
    const asked = await this.deps.db.query('SELECT 1 FROM changes WHERE kind = $1 AND detail->>\'run\' = ANY($2) AND detail->>\'state\' = \'awaiting\' LIMIT 1', ['action.requested', rounds.ids])
    if (!asked.rowCount) return null
    const round = rounds.ids.length
    const action = this.deps.actions.get(run.action)
    const doing = action?.title ?? run.action
    const on = run.entityTitle ?? run.entity?.key
    const decision: Decision = run.state === 'awaiting' ? 'pending' : run.state === 'declined' || run.state === 'returned' ? 'declined' : run.state === 'cancelled' && !run.decidedBy ? 'expired' : 'approved'
    // Everyone who may decide it, as its Approve button judges them: the people a rule names, whoever holds actions.approve, and admins.
    // Whoever has already approved is no longer asked, so the inbox of someone who said yes does not still wait for them.
    const approvers = run.state === 'awaiting' ? await this.mayDecide(run) : []
    const given = run.approvedBy ?? []
    const need = run.approvalsNeeded ?? 1
    return {
      key: approvalKey('run', rounds.first),
      title: `${doing}${on ? ` on ${on}` : ''}${round > 1 ? ` (round ${round})` : ''}`,
      requester: run.requestedFor ?? run.by,
      approvers,
      on: run.entity ?? null,
      fields: {
        source: 'orrery',
        kind: 'action run',
        decision,
        reason: reasonOf(action?.inputs, run) || null,
        requested_by: run.requestedFor ?? run.by,
        requested_at: run.createdAt,
        decided_by: run.decidedBy,
        decided_at: run.decidedAt,
        decision_note: run.note,
        approvals_needed: need,
        approved_by: given.map((g) => g.by),
        round,
        url: `${this.deps.publicUrl.replace(/\/+$/, '')}/actions/runs/${encodeURIComponent(run.id)}`,
      },
    }
  }

  /**
   * The record of a change set: one for the whole set, whoever decides it.
   * Its reason says why it was asked, then what it changes, an action a line
   * with how many runs of it. One withdrawn by whoever asked expires.
   */
  private async setRecord(id: string): Promise<Record_ | null> {
    const told = await this.deps.sets.told(id)
    if (!told) return null
    const { summary: set, runs, deciders } = told
    const decision: Decision = set.decision === 'pending' ? 'pending' : set.decision === 'rejected' ? 'declined' : set.decision === 'withdrawn' ? 'expired' : 'approved'
    const changes = set.actions.map((a) => `${a.title}: ${a.runs} ${a.runs === 1 ? 'change' : 'changes'}`)
    const on = new Set(runs.map((r) => (r.entity ? `${r.entity.blueprint}:${r.entity.key}` : '')))
    const one = on.size === 1 ? runs[0]!.entity : null
    return {
      key: approvalKey('set', id),
      title: `Change set: ${set.title}`,
      requester: set.by,
      approvers: deciders,
      on: one,
      fields: {
        source: 'orrery',
        kind: 'change set',
        decision,
        reason: [set.note, ...changes].filter(Boolean).join('\n'),
        requested_by: set.by,
        requested_at: set.createdAt,
        decided_by: set.decidedBy,
        decided_at: set.decidedAt,
        decision_note: set.decisionNote,
        approvals_needed: Math.max(1, ...runs.map((r) => r.approvalsNeeded ?? 1)),
        approved_by: [...new Set(runs.flatMap((r) => (r.state === 'awaiting' ? (r.approvedBy ?? []).map((g) => g.by) : [])))],
        url: set.url,
      },
    }
  }

  /** The sign-in addresses of everyone enrolled who may decide a run that waits. */
  private async mayDecide(run: ActionRun): Promise<string[]> {
    const named: string[] = []
    for (const person of this.deps.people()) if (await this.deps.actions.mayDecide(person, await this.deps.viewOf(person), run)) named.push(person.name)
    return named
  }

  /** The record of a schedule; one removed while it waited expires, and one removed after its decision keeps it. */
  private async scheduleRecord(id: string, kind: string): Promise<Record_ | null> {
    const s = await this.deps.schedules.find(id)
    if (!s) {
      if (kind !== 'schedule.removed') return null
      const held = await this.deps.reader.get({ blueprint: this.current!.blueprint, key: approvalKey('schedule', id) })
      if (!held || held.fields.decision !== 'pending') return null
      return { key: held.key, title: held.title, requester: String(held.fields.requested_by ?? ''), approvers: [], on: null, fields: { decision: 'expired' } }
    }
    const action = this.deps.actions.get(s.action)
    const decision: Decision = s.state === 'awaiting' ? 'pending' : s.state === 'declined' ? 'declined' : 'approved'
    const minutes = s.load?.runnerSeconds === null || s.load?.runnerSeconds === undefined ? null : Math.round((s.load.runnerSeconds * s.load.perDay) / 60)
    return {
      key: approvalKey('schedule', id),
      title: `Schedule: ${s.title}`,
      requester: s.owner,
      approvers: s.state === 'awaiting' ? this.deps.schedules.deciders(this.deps.people()) : [],
      on: s.target.entity ?? null,
      fields: {
        source: 'orrery',
        kind: 'schedule',
        decision,
        reason: [`${action?.title ?? s.action}${s.targetTitle ? ` on ${s.targetTitle}` : ''}, ${s.when}`, s.load ? `${s.load.runs} runs each time` : null, minutes !== null ? `about ${minutes} runner-minutes a day` : null].filter(Boolean).join('\n'),
        requested_by: s.owner,
        requested_at: s.createdAt,
        decided_by: s.decidedBy,
        decided_at: s.decidedAt,
        decision_note: s.state === 'declined' ? s.note : null,
        url: `${this.deps.publicUrl.replace(/\/+$/, '')}/actions/schedules`,
      },
    }
  }

  /**
   * How many records of the approvals blueprint wait for this person: pending,
   * and naming them among the approvers, of every system that writes there.
   * Read through their view, so a record they may not see is not counted.
   */
  async waitingFor(identity: Identity, view: View): Promise<MyApprovals> {
    await this.load()
    const bp = this.current ? this.deps.blueprints.get(this.current.blueprint) : undefined
    if (!bp || !view.seesBlueprint(bp.id)) return { blueprint: null, waiting: 0 }
    const person = this.deps.person()
    const key = identity.kind === 'user' && person && bp.relations.approvers?.target === person.blueprint ? await this.personKey(identity.name) : null
    if (!person || !key) return { blueprint: bp.id, waiting: 0 }
    const filter = { and: [{ field: 'decision', op: 'eq' as const, value: 'pending' }, { relation: 'approvers', target: `${person.blueprint}:${key}` }] }
    if (view.refusedQuery(bp.id, filter)) return { blueprint: bp.id, waiting: 0 }
    const { total } = await this.deps.reader.list({ blueprint: bp.id, filter, limit: 0, view })
    return { blueprint: bp.id, waiting: total }
  }

  /** Writes a record as the hub, with the fields and relations its blueprint declares. False when the hub refused it. */
  private async write(bp: Blueprint, rec: Record_): Promise<boolean> {
    const fields = Object.fromEntries(Object.entries(rec.fields).filter(([name]) => name in bp.fields))
    const relations: Record<string, string | string[] | null> = {}
    const person = this.deps.person()
    const target = (name: string) => bp.relations[name] && person && bp.relations[name]!.target === person.blueprint
    if (target('requester') && rec.requester) relations.requester = await this.personKey(rec.requester)
    if (target('approvers')) relations.approvers = (await Promise.all(rec.approvers.map((a) => this.personKey(a)))).filter((k): k is string => !!k)
    const on = rec.on
    const reaching = on ? Object.entries(bp.relations).filter(([name, def]) => name !== 'requester' && name !== 'approvers' && def.target === on.blueprint) : []
    if (on && reaching.length === 1) relations[reaching[0]![0]] = bp.relations[reaching[0]![0]]!.many ? [on.key] : on.key
    const source = this.deps.sources.get(APPROVALS_SOURCE)
    if (!source) return false
    const result = await this.deps.entities.write({ blueprint: bp.id, key: rec.key, title: rec.title, fields, relations }, { source, layer: 'pushed', mode: 'upsert', replace: false })
    if (result.outcome === 'rejected') {
      this.deps.log.warn('approval record refused', { key: rec.key, errors: result.errors })
      return false
    }
    return true
  }

  /** The key of a person's record, by their sign-in address: the key itself, or the record whose address field holds it. */
  private async personKey(email: string): Promise<string | null> {
    const person = this.deps.person()
    if (!person) return null
    if (!person.field) {
      const key = email.toLowerCase()
      // Only whether the record is there: never its page, which reads everything that points at a person.
      return (await this.deps.reader.rowsFor([{ blueprint: person.blueprint, key }], false)).length ? key : null
    }
    const found = await this.deps.reader.list({ blueprint: person.blueprint, filter: { field: person.field, op: 'eq', value: email }, limit: 1 })
    return found.entities[0]?.key ?? null
  }
}
