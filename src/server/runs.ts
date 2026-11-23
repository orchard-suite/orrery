// Runs, scopes, and the lifecycle: what a committed snapshot may delete,
// grace periods, the mass-drop guard, expiry by age, tombstones, and purge.

import { randomBytes } from 'node:crypto'
import { DEFAULT_GRACE, MASS_DROP_THRESHOLD, RUNNER_BLUEPRINT, SOURCE_BLUEPRINT, parseDuration, type Blueprint, type EntityRef, type Run, type RunError as RunErrorRecord, type Source } from '../shared/model.ts'
import type { Blueprints } from './blueprints.ts'
import type { LoadHeld, LoadHeldBlueprint } from '../shared/api.ts'
import type { Db } from './db.ts'
import { record } from './activity.ts'
import { expiresAt, type Entities, type EntityRow, type WriteInput } from './entities.ts'
import type { Events } from './events.ts'
import { NO_QUEUE, type Queue } from './derive.ts'
import type { Logger } from './log.ts'
import type { Rules } from './rules.ts'
import type { Sources } from './sources.ts'
import { resolve, type Layers } from './values.ts'
import { timed } from './metrics.ts'
import { forgetStars } from './stars.ts'

interface RunRow {
  id: string
  source: string
  mode: 'snapshot' | 'incremental'
  write_mode: 'upsert' | 'enrich'
  scope: string
  state: Run['state']
  started_at: Date
  finished_at: Date | null
  counts: Partial<Run['counts']>
  errors: RunErrorRecord[]
  mass_drop: boolean
}

const EMPTY_COUNTS: Run['counts'] = { received: 0, created: 0, updated: 0, unchanged: 0, rejected: 0, missing: 0, deleted: 0, sighted: 0 }
const MAX_ERRORS = 200
const ABANDON_AFTER = parseDuration('2h')
const MASS_DROP_EXTENSION = parseDuration('7d')
const DAY_MS = 86_400_000
/** The longest history `held` reads back. */
const HELD_DAYS = 90
/** How far ahead `held` says what expiry takes. */
const HELD_AHEAD_DAYS = 365

export class RunError extends Error {
  readonly status: 400 | 403 | 404 | 409

  constructor(message: string, status: 400 | 403 | 404 | 409 = 400) {
    super(message)
    this.status = status
  }
}

export class Runs {
  private readonly db: Db
  private readonly blueprints: Blueprints
  private readonly sources: Sources
  private readonly entities: Entities
  private readonly rules: Rules
  private readonly events: Events
  private readonly log: Logger

  /** The deriver's queue: an entity gone missing or purged is derived again, or forgotten. The hub wires it. */
  queue: Queue = NO_QUEUE
  /** Links again what reads what a commit moved, without the commit waiting for it. A hub that only serves leaves it to the leader. */
  relink: () => void = () => void this.rules.evaluateMoved().catch(() => undefined)
  /** When the last snapshot of each source's scope committed, as `scope_seen` holds it. */
  private readonly seen = new Map<string, Date>()

  async load(): Promise<void> {
    const rows = await this.db.query<{ source: string; scope: string; seen_at: Date }>('SELECT source, scope, seen_at FROM scope_seen')
    this.seen.clear()
    for (const r of rows.rows) this.seen.set(`${r.source}\n${r.scope}`, r.seen_at)
  }

  /**
   * When an entity was last seen. A snapshot that commits saw every entity
   * of its source and scope it left active, and says so once for the scope,
   * so an active entity was seen at the later of that and its own row.
   */
  seenAt(row: Pick<EntityRow, 'state' | 'owner' | 'scope' | 'last_seen_at'>): Date | null {
    const scoped = row.state === 'active' && row.scope !== null ? this.seen.get(`${row.owner}\n${row.scope}`) : undefined
    return scoped && (!row.last_seen_at || scoped > row.last_seen_at) ? scoped : row.last_seen_at
  }

  constructor(db: Db, blueprints: Blueprints, sources: Sources, entities: Entities, rules: Rules, events: Events, log: Logger) {
    this.db = db
    this.blueprints = blueprints
    this.sources = sources
    this.entities = entities
    this.rules = rules
    this.events = events
    this.log = log
  }

  /**
   * Opens a run. A snapshot opened while another snapshot of the same source
   * and scope is still open supersedes it: the older one is abandoned and
   * deletes nothing, so two overlapping snapshots can never mark each other's
   * entities missing.
   */
  async open(source: Source, mode: 'snapshot' | 'incremental', scope: string, writeMode: 'upsert' | 'enrich' = 'upsert'): Promise<Run> {
    if (!scope.trim()) throw new RunError('a run needs a scope')
    if (mode === 'snapshot') {
      const older = await this.db.query<RunRow>(`UPDATE runs SET state = 'abandoned', finished_at = now() WHERE state = 'open' AND mode = 'snapshot' AND source = $1 AND scope = $2 RETURNING *`, [source.id, scope])
      for (const r of older.rows) {
        this.log.warn('run abandoned: a newer snapshot of the same scope opened', { run: r.id, source: r.source, scope, startedAt: r.started_at })
        await record(this.db, 'run.failed', null, r.source, null, { run: r.id, reason: 'abandoned: a newer snapshot of the same scope opened' })
      }
      if (!older.rows.length) this.log.debug('no open snapshot of the scope to supersede', { source: source.id, scope })
    }
    const id = `${source.id}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`
    const res = await this.db.query<RunRow>('INSERT INTO runs (id, source, mode, write_mode, scope, counts) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [id, source.id, mode, writeMode, scope, JSON.stringify(EMPTY_COUNTS)])
    await this.sources.touch(source.id, { seen: new Date() })
    this.log.info('run opened', { run: id, source: source.id, mode, scope, writeMode })
    return toRun(res.rows[0]!)
  }

  async get(id: string): Promise<Run | null> {
    const res = await this.db.query<RunRow>('SELECT * FROM runs WHERE id = $1', [id])
    return res.rows[0] ? toRun(res.rows[0]) : null
  }

  async listForSource(source: string, limit = 20): Promise<Run[]> {
    const res = await this.db.query<RunRow>('SELECT * FROM runs WHERE source = $1 ORDER BY started_at DESC LIMIT $2', [source, limit])
    return res.rows.map(toRun)
  }

  async listRecent(limit = 50): Promise<Run[]> {
    const res = await this.db.query<RunRow>('SELECT * FROM runs ORDER BY started_at DESC LIMIT $1', [limit])
    return res.rows.map(toRun)
  }

  /** Writes a batch of entities into an open run, all of it or none. Updates apply immediately; only the commit may delete. */
  /**
   * Writes one batch of a run. An item that names its entity by a digest alone is a sighting: taken as the full write it
   * names when that is still what stands, else answered in `wanted`, for the sender to send in full in the same run.
   */
  async writeBatch(runId: string, source: Source, items: WriteInput[], observedAt?: string): Promise<{ run: Run; accepted: number; rejected: RunErrorRecord[]; wanted: EntityRef[] }> {
    const row = (await this.db.query<RunRow>('SELECT * FROM runs WHERE id = $1', [runId])).rows[0]
    if (!row) throw new RunError(`Unknown run "${runId}"`, 404)
    if (row.source !== source.id) throw new RunError(`run "${runId}" belongs to source "${row.source}"`, 403)
    if (row.state !== 'open') throw new RunError(`run "${runId}" is ${row.state}`, 409)
    const results = await this.entities.writeMany(items, { source, layer: source.class === 'git' ? 'git' : 'pushed', mode: row.write_mode, replace: true, runId, snapshot: row.mode === 'snapshot', scope: row.scope, observedAt })
    const rejected: RunErrorRecord[] = []
    const wanted: EntityRef[] = []
    const counts = { ...EMPTY_COUNTS, ...row.counts }
    results.forEach((result, i) => {
      if (result.outcome === 'wanted') {
        wanted.push({ blueprint: items[i]!.blueprint, key: items[i]!.key })
        return
      }
      if (result.sighted) counts.sighted++
      else counts.received++
      if (result.outcome === 'rejected') {
        counts.rejected++
        rejected.push(...result.errors)
      } else if (result.outcome === 'created') counts.created++
      else if (result.outcome === 'unchanged') counts.unchanged++
      else counts.updated++
    })
    const errors = [...row.errors, ...rejected].slice(0, MAX_ERRORS)
    const res = await this.db.query<RunRow>('UPDATE runs SET counts = $2, errors = $3 WHERE id = $1 RETURNING *', [runId, JSON.stringify(counts), JSON.stringify(errors)])
    await this.sources.touch(source.id, { seen: new Date() })
    return { run: toRun(res.rows[0]!), accepted: items.length - rejected.length - wanted.length, rejected, wanted }
  }

  /**
   * Commits a run. A snapshot marks everything in its source and scope that
   * it did not mention as missing. If that is more than the mass-drop share,
   * the run still commits, but the affected entities get extended grace, the
   * source turns amber, and a finding is raised.
   */
  commit(runId: string, source: Source): Promise<Run> {
    return timed('snapshot.commit', () => this.commitRun(runId, source))
  }

  private async commitRun(runId: string, source: Source): Promise<Run> {
    const now = new Date()
    // The blueprints this commit marks missing; what the run wrote was already told entity by entity.
    const missed = new Set<string>()
    let snapshot = false
    const run = await this.db.tx(async (client) => {
      const locked = await client.query<RunRow>('SELECT * FROM runs WHERE id = $1 FOR UPDATE', [runId])
      const row = locked.rows[0]
      if (!row) throw new RunError(`Unknown run "${runId}"`, 404)
      if (row.source !== source.id) throw new RunError(`run "${runId}" belongs to source "${row.source}"`, 403)
      // A writer that timed out waiting for its commit asks again; the commit it is asking for already happened.
      if (row.state === 'committed') {
        this.log.info('commit repeated: the run is already committed', { run: runId, source: source.id })
        return null
      }
      if (row.state !== 'open') throw new RunError(`run "${runId}" is ${row.state}`, 409)
      const counts = { ...EMPTY_COUNTS, ...row.counts }
      let massDrop = false
      if (row.mode === 'snapshot' && row.write_mode === 'upsert') {
        const blueprintFilter = source.blueprints.includes('*') ? '' : 'AND blueprint = ANY($3)'
        const params: unknown[] = [source.id, row.scope]
        if (blueprintFilter) params.push(source.blueprints)
        const inScope = `owner = $1 AND scope = $2 AND state IN ('active','missing') ${blueprintFilter}`
        const owned = Number((await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM entities WHERE ${inScope}`, params)).rows[0]!.n)
        // What the run did not see: no batch of it noted the entity.
        const unseen = (
          await client.query<Pick<EntityRow, 'blueprint' | 'key' | 'state'>>(
            `SELECT e.blueprint, e.key, e.state FROM entities e WHERE ${inScope}
               AND NOT EXISTS (SELECT 1 FROM run_seen s, unnest(s.blueprints, s.keys) AS n(blueprint, key) WHERE s.run_id = $${params.length + 1} AND n.blueprint = e.blueprint AND n.key = e.key)
             ORDER BY e.blueprint, e.key FOR UPDATE OF e`,
            [...params, runId],
          )
        ).rows
        const newlyMissing = unseen.filter((e) => e.state === 'active')
        const share = owned ? newlyMissing.length / owned : 0
        massDrop = newlyMissing.length > 0 && share > MASS_DROP_THRESHOLD
        if (massDrop) {
          this.log.warn('mass drop: snapshot removes more than the threshold share of its scope; extending grace', { run: runId, source: source.id, scope: row.scope, owned, missing: newlyMissing.length, share })
        } else {
          this.log.info('snapshot commit', { run: runId, source: source.id, scope: row.scope, owned, newlyMissing: newlyMissing.length, stillMissing: unseen.length - newlyMissing.length })
        }
        // What goes missing now was last seen by the snapshot before this one.
        const last = (await client.query<{ seen_at: Date }>('SELECT seen_at FROM scope_seen WHERE source = $1 AND scope = $2', [source.id, row.scope])).rows[0]?.seen_at ?? null
        for (const e of unseen) {
          await client.query(
            `UPDATE entities SET last_seen_at = CASE WHEN state = 'active' THEN GREATEST(last_seen_at, $6::timestamptz) ELSE last_seen_at END,
               state = 'missing', missing_since = COALESCE(missing_since, $3), missing_runs = missing_runs + 1, grace_until = CASE WHEN $4 THEN $5 ELSE grace_until END, updated_at = CASE WHEN state = 'active' THEN $3 ELSE updated_at END WHERE blueprint = $1 AND key = $2`,
            [e.blueprint, e.key, now, massDrop, new Date(now.getTime() + MASS_DROP_EXTENSION), last],
          )
          if (e.state === 'active') await record(client, 'entity.missing', e, source.id, null, { run: runId, scope: row.scope, massDrop }, now)
        }
        counts.missing = unseen.length
        await this.queue.enqueue(client, newlyMissing)
        // What shows a missing entity beside its own rows carries its state.
        await this.queue.enqueueReaders(client, newlyMissing)
        this.rules.touch(newlyMissing.map((e) => e.blueprint))
        for (const e of unseen) missed.add(e.blueprint)
        await client.query('INSERT INTO scope_seen (source, scope, seen_at) VALUES ($1, $2, $3) ON CONFLICT (source, scope) DO UPDATE SET seen_at = EXCLUDED.seen_at', [source.id, row.scope, now])
        snapshot = true
        if (massDrop) await record(client, 'run.mass_drop', null, source.id, null, { run: runId, scope: row.scope, owned, missing: newlyMissing.length, entities: newlyMissing.map((e) => ({ blueprint: e.blueprint, key: e.key })) }, now)
      }
      await client.query('DELETE FROM run_seen WHERE run_id = $1', [runId])
      const res = await client.query<RunRow>(`UPDATE runs SET state = 'committed', finished_at = $2, counts = $3, mass_drop = $4 WHERE id = $1 RETURNING *`, [runId, now, JSON.stringify(counts), massDrop])
      await record(client, 'run.committed', null, source.id, null, { run: runId, mode: row.mode, scope: row.scope, counts, massDrop }, now)
      return toRun(res.rows[0]!)
    })
    if (!run) return (await this.get(runId))!
    if (snapshot) this.seen.set(`${source.id}\n${run.scope}`, now)
    await this.sources.touch(source.id, {
      run: now,
      seen: now,
      error: null,
      status: run.massDrop ? 'amber' : 'green',
      reason: run.massDrop ? `mass drop in run ${run.id}: ${run.counts.missing} entities in scope "${run.scope}" went missing at once` : null,
    })
    const deleted = await this.expireMissing(source.id)
    if (deleted) await this.db.query('UPDATE runs SET counts = counts || $2 WHERE id = $1', [runId, JSON.stringify({ deleted })])
    // The run moved what the pages built from the whole estate say of its source: its standing, its findings.
    this.events.emit({ type: 'sources' })
    // A rule may match on a property the run just brought, so its field is made first. A run that wrote nothing brought none.
    if (run.counts.created + run.counts.updated === 0) this.log.debug('pivots left as they are: the run wrote nothing', { run: runId })
    else if ((await this.blueprints.syncPivots()).length) this.events.emit({ type: 'blueprints' })
    // The pusher is answered without waiting for the re-link. A rule that matches on a derived value of what the run
    // wrote is linked again by the pass the leader runs once the run's rows are derived and stored.
    this.relink()
    await this.syncSourceEntities(source.id)
    // What the run wrote was told entity by entity; what it marked missing or deleted is told by blueprint.
    if (missed.size) this.events.emit({ type: 'estate', blueprints: [...missed] })
    return (await this.get(runId))!
  }

  async fail(runId: string, source: Source, reason: string): Promise<Run> {
    const res = await this.db.query<RunRow>(`UPDATE runs SET state = 'failed', finished_at = now(), errors = errors || $3::jsonb WHERE id = $1 AND source = $2 AND state = 'open' RETURNING *`, [runId, source.id, JSON.stringify([{ reason }])])
    if (!res.rows[0]) throw new RunError(`run "${runId}" is not open for source "${source.id}"`, 409)
    await record(this.db, 'run.failed', null, source.id, null, { run: runId, reason })
    await this.sources.touch(source.id, { run: new Date(), error: reason, status: 'red', reason: `run ${runId} failed: ${reason}` })
    await this.syncSourceEntities(source.id)
    this.log.warn('run failed', { run: runId, source: source.id, reason })
    this.events.emit({ type: 'sources' })
    return toRun(res.rows[0])
  }

  /** Runs left open too long delete nothing and are closed as abandoned. */
  async abandonStale(): Promise<number> {
    const cutoff = new Date(Date.now() - ABANDON_AFTER)
    const res = await this.db.query<RunRow>(`UPDATE runs SET state = 'abandoned', finished_at = now() WHERE state = 'open' AND started_at < $1 RETURNING *`, [cutoff])
    for (const r of res.rows) {
      this.log.warn('run abandoned: open past the limit', { run: r.id, source: r.source, startedAt: r.started_at })
      await record(this.db, 'run.failed', null, r.source, null, { run: r.id, reason: 'abandoned: never committed' })
    }
    return res.rowCount ?? 0
  }

  /**
   * Brings back every missing entity people keep. Only a run of the owning
   * source marks an entity seen again, and the web app has no runs, so one
   * of these would otherwise wait out its grace and be deleted.
   */
  async restoreKept(): Promise<number> {
    const back = await this.db.tx(async (client) => {
      const now = new Date()
      const back = await client.query<EntityRef>(
        `UPDATE entities SET state = 'active', missing_since = NULL, missing_runs = 0, grace_until = NULL, updated_at = $1 WHERE owner = 'ui' AND state = 'missing' RETURNING blueprint, key`,
        [now],
      )
      for (const e of back.rows) await record(client, 'entity.restored', e, 'ui', null, { previous: 'missing', reason: 'kept by people' }, now)
      await this.queue.enqueue(client, back.rows)
      await this.queue.enqueueReaders(client, back.rows)
      return back.rows
    })
    if (!back.length) return 0
    const blueprints = [...new Set(back.map((e) => e.blueprint))]
    this.rules.touch(blueprints)
    this.events.emit({ type: 'estate', blueprints })
    this.log.info('restored missing entities people keep', { entities: back.length, blueprints })
    return back.length
  }

  /** Deletes missing entities whose grace (runs and duration) has elapsed. */
  async expireMissing(sourceId?: string): Promise<number> {
    const params: unknown[] = []
    let where = `state = 'missing'`
    if (sourceId) {
      params.push(sourceId)
      where += ` AND owner = $1`
    }
    const rows = await this.db.query<EntityRow>(`SELECT * FROM entities WHERE ${where}`, params)
    const now = Date.now()
    const expired: EntityRef[] = []
    for (const e of rows.rows) {
      const bp = this.blueprints.get(e.blueprint)
      const grace = { ...DEFAULT_GRACE, ...(bp?.lifecycle?.grace ?? {}), ...(this.sources.grace(e.owner) ?? {}) }
      const since = e.missing_since?.getTime() ?? now
      const runsDone = e.missing_runs >= grace.runs
      const timeDone = now - since >= parseDuration(grace.duration)
      const extended = !!e.grace_until && e.grace_until.getTime() > now
      if (runsDone && timeDone && !extended) expired.push({ blueprint: e.blueprint, key: e.key })
      else this.log.debug('missing entity kept', { blueprint: e.blueprint, key: e.key, runsDone, timeDone, extended, missingRuns: e.missing_runs, grace })
    }
    if (expired.length) await this.entities.tombstone(expired, sourceId ?? 'hub', null, { reason: 'grace expired' }, false)
    return expired.length
  }

  /**
   * Deletes entities past their blueprint's `lifecycle.expire`. This is how
   * things that happened (a deployment, an incident) leave: no snapshot ever
   * stops mentioning them, so age is the only thing that can.
   */
  async expireAged(): Promise<number> {
    let total = 0
    const now = Date.now()
    for (const bp of this.blueprints.list()) {
      const policy = bp.lifecycle?.expire
      if (!policy) continue
      const rows = await this.db.query<EntityRow>(`SELECT * FROM entities WHERE blueprint = $1 AND state <> 'deleted'`, [bp.id])
      const expired = rows.rows.filter((row) => {
        const until = expiresAt(bp, (name) => resolve(name, { ui: row.ui, pushed: row.pushed, override: row.override, git: row.git }, bp.fields[name])?.value, row.created_at)
        return until !== null && until <= now
      })
      this.log.info('expiry pass', { blueprint: bp.id, after: policy.after, field: policy.field ?? 'createdAt', kept: rows.rows.length - expired.length, expired: expired.length })
      if (expired.length) await this.entities.tombstone(expired.map((e) => ({ blueprint: e.blueprint, key: e.key })), 'hub', null, { reason: 'expired', after: policy.after, field: policy.field ?? 'createdAt' }, false)
      total += expired.length
    }
    return total
  }

  /**
   * How what each blueprint holds moved, day by day, over the last
   * `HELD_DAYS` or as long as its tombstones are kept, whichever is shorter:
   * past that, what left is purged and the history would no longer be exact.
   * For a blueprint whose entities expire by age, also how many of those it
   * holds now leave on each day ahead, by the same reading as `expireAged`.
   */
  async held(tombstoneDays: number): Promise<LoadHeld> {
    const today = Math.floor(Date.now() / DAY_MS)
    const daysOf = (bp: Blueprint | undefined) => Math.max(1, Math.min(HELD_DAYS, Math.floor(tombstoneDays), bp?.lifecycle?.keepDeleted ? Math.floor(parseDuration(bp.lifecycle.keepDeleted) / DAY_MS) : HELD_DAYS))
    const first = today - Math.min(HELD_DAYS, Math.max(1, Math.floor(tombstoneDays))) + 1
    // One pass over the table: each row is counted on the day it came and, once deleted, on the day it left.
    const moved = await this.db.query<{ blueprint: string; kind: 'came' | 'left'; day: number; n: number }>(
      `SELECT e.blueprint, x.kind, floor(extract(epoch FROM x.at) / 86400)::int AS day, count(*)::int AS n
       FROM entities e CROSS JOIN LATERAL (VALUES ('came', e.created_at), ('left', CASE WHEN e.state = 'deleted' THEN e.deleted_at END)) AS x(kind, at)
       WHERE x.at >= $1 GROUP BY 1, 2, 3`,
      [new Date(first * DAY_MS)],
    )
    const out = new Map<string, LoadHeldBlueprint>()
    const of = (id: string) => {
      let b = out.get(id)
      if (!b) {
        const days = daysOf(this.blueprints.get(id))
        b = { id, came: new Array<number>(days).fill(0), left: new Array<number>(days).fill(0) }
        out.set(id, b)
      }
      return b
    }
    for (const r of moved.rows) {
      const b = of(r.blueprint)
      const at = b.came.length - 1 - (today - r.day)
      if (at >= 0 && at < b.came.length) b[r.kind][at]! += r.n
    }
    for (const bp of this.blueprints.list()) {
      const policy = bp.lifecycle?.expire
      if (!policy) continue
      const f = policy.field ?? null
      const rows = await this.db.query<{ created_at: Date; ui: unknown; pushed: unknown; override: unknown; git: unknown }>(
        f
          ? `SELECT created_at, ui -> $2 AS ui, pushed -> $2 AS pushed, override -> $2 AS override, git -> $2 AS git FROM entities WHERE blueprint = $1 AND state <> 'deleted'`
          : `SELECT created_at, NULL AS ui, NULL AS pushed, NULL AS override, NULL AS git FROM entities WHERE blueprint = $1 AND state <> 'deleted'`,
        f ? [bp.id, f] : [bp.id],
      )
      const ahead = new Array<number>(HELD_AHEAD_DAYS).fill(0)
      // Each layer holds the one field expiry reads, as stored, so `resolve` decides between them as it does everywhere.
      const one = (v: unknown) => (v === null || v === undefined || !f ? {} : { [f]: v })
      for (const row of rows.rows) {
        const layers = { ui: one(row.ui), pushed: one(row.pushed), override: one(row.override), git: one(row.git) } as Layers
        const until = expiresAt(bp, (name) => resolve(name, layers, bp.fields[name])?.value, row.created_at)
        if (until === null) continue
        const at = Math.max(0, Math.floor(until / DAY_MS) - today)
        if (at < HELD_AHEAD_DAYS) ahead[at]! += 1
      }
      if (rows.rows.length) of(bp.id).expire = { afterDays: parseDuration(policy.after) / DAY_MS, ahead }
    }
    return { today, blueprints: [...out.values()].sort((a, b) => a.id.localeCompare(b.id)) }
  }

  /**
   * Removes tombstones older than their blueprint's `lifecycle.keepDeleted`,
   * or `retentionDays` where it says nothing, and every relation that pointed
   * at them. Also drops what sources pushed from the entities they deleted:
   * a source that brings one back pushes its relations again.
   */
  async purge(retentionDays: number): Promise<{ entities: number; relations: number }> {
    const now = Date.now()
    const own = this.blueprints.list().filter((bp) => bp.lifecycle?.keepDeleted)
    let entities = 0
    let relations = 0
    const moved = new Set<string>()
    const purgeWhere = async (where: string, params: unknown[], cutoff: Date, scope: string) => {
      const gone = await this.db.query<{ blueprint: string; key: string }>(`DELETE FROM entities WHERE state = 'deleted' AND deleted_at < $1 AND ${where} RETURNING blueprint, key`, [cutoff, ...params])
      if (!gone.rowCount) {
        this.log.debug('no tombstones to purge', { scope, olderThan: cutoff })
        return
      }
      const blueprints = gone.rows.map((e) => e.blueprint)
      const keys = gone.rows.map((e) => e.key)
      const links = await this.db.query<{ blueprint: string; key: string; target_blueprint: string; target_key: string }>(
        `DELETE FROM relations WHERE (blueprint, key) IN (SELECT * FROM unnest($1::text[], $2::text[])) OR (target_blueprint, target_key) IN (SELECT * FROM unnest($1::text[], $2::text[])) RETURNING blueprint, key, target_blueprint, target_key`,
        [blueprints, keys],
      )
      await this.db.tx(async (client) => {
        await this.queue.forget(client, gone.rows)
        // What the hub lets go of for good is nobody's favorite any more.
        const unstarred = await forgetStars(client, gone.rows)
        if (unstarred) this.log.info('stars let go with their purged entities', { scope, stars: unstarred })
        await this.queue.enqueue(client, links.rows.flatMap((r) => [r, { blueprint: r.target_blueprint, key: r.target_key }]))
      })
      entities += gone.rowCount
      relations += links.rowCount ?? 0
      for (const b of blueprints) moved.add(b)
      this.log.info('tombstones purged', { scope, count: gone.rowCount, relations: links.rowCount ?? 0, olderThan: cutoff })
    }
    for (const bp of own) await purgeWhere('blueprint = $2', [bp.id], new Date(now - parseDuration(bp.lifecycle!.keepDeleted!)), bp.id)
    await purgeWhere('blueprint <> ALL($2)', [own.map((bp) => bp.id)], new Date(now - retentionDays * 86_400_000), 'default')
    const pushed = await this.db.query<{ blueprint: string; target_blueprint: string; target_key: string }>(
      `DELETE FROM relations r USING entities e WHERE e.blueprint = r.blueprint AND e.key = r.key AND e.state = 'deleted' AND r.layer = 'pushed' RETURNING r.blueprint, r.target_blueprint, r.target_key`,
    )
    if (pushed.rowCount) {
      relations += pushed.rowCount
      await this.db.tx((client) => this.queue.enqueue(client, pushed.rows.map((r) => ({ blueprint: r.target_blueprint, key: r.target_key }))))
      for (const r of pushed.rows) moved.add(r.blueprint)
      this.log.info('pushed relations of deleted entities dropped', { count: pushed.rowCount })
    } else this.log.debug('no pushed relations on deleted entities')
    if (moved.size) this.events.emit({ type: 'estate', blueprints: [...moved] })
    return { entities, relations }
  }

  /** Removes finished runs older than `days`. An open run is never removed. */
  async pruneRuns(days: number): Promise<number> {
    const cutoff = new Date(Date.now() - days * 86_400_000)
    const gone = await this.db.query(`DELETE FROM runs WHERE state <> 'open' AND started_at < $1`, [cutoff])
    if (gone.rowCount) this.log.info('old runs removed', { count: gone.rowCount, olderThan: cutoff })
    else this.log.debug('no old runs to remove', { olderThan: cutoff })
    return gone.rowCount ?? 0
  }

  /**
   * Sources are entities too, so a dead or stale source shows on the wall.
   * Only what is stable about a source is written here: its status, last
   * run, last seen, and last error live in `sources` and are laid over the
   * entity as it is read (`live` in `read.ts`), so a run changes nothing on
   * the entity and writes no activity. With `only`, just that source is
   * written; the periodic pass writes them all.
   */
  async syncSourceEntities(only?: string): Promise<void> {
    const hub = this.sources.get('hub')
    if (!hub) return
    const items: WriteInput[] = []
    for (const s of this.sources.list()) {
      if (only && s.id !== only) continue
      items.push({
        blueprint: SOURCE_BLUEPRINT,
        key: s.id,
        title: s.title,
        fields: {
          class: s.class,
          description: s.description ?? null,
          cadence: s.cadence,
          blueprints: s.blueprints,
        },
      })
      if (s.class === 'runner') {
        const meta = await this.db.query<{ value: { version?: string; segment?: string } }>('SELECT value FROM settings WHERE key = $1', [`runner:${s.id}`])
        items.push({ blueprint: RUNNER_BLUEPRINT, key: s.id, title: s.title, fields: { segment: meta.rows[0]?.value.segment ?? s.description ?? null, version: meta.rows[0]?.value.version ?? null } })
      }
    }
    const results = await this.entities.writeMany(items, { source: hub, layer: 'pushed', mode: 'upsert', replace: true })
    results.forEach((result, i) => {
      if (result.outcome === 'rejected') this.log.error('source entity rejected', { blueprint: items[i]!.blueprint, source: items[i]!.key, errors: result.errors })
    })
    if (!only) await this.removeGoneSourceEntities()
  }

  /** A removed source's entity, and its runner's, go with it: the hub owns them, so nobody else could delete them. */
  private async removeGoneSourceEntities(): Promise<void> {
    const ids = this.sources.list().map((s) => s.id)
    const gone = await this.db.query<EntityRef>(
      `SELECT blueprint, key FROM entities WHERE blueprint IN ($1, $2) AND owner = 'hub' AND state <> 'deleted' AND NOT (key = ANY($3::text[]))`,
      [SOURCE_BLUEPRINT, RUNNER_BLUEPRINT, ids],
    )
    if (gone.rows.length) await this.entities.tombstone(gone.rows, 'hub', null, { reason: 'source removed' }, false)
  }

  /** The periodic pass: abandon stuck runs, expire, purge, re-link what moved (and everything every `relinkMinutes`), refresh source entities. */
  async tick(retentionDays: number, runDays: number, relinkMinutes: number): Promise<void> {
    const abandoned = await this.abandonStale()
    // A run that ended without committing keeps nothing of what it saw.
    await this.db.query(`DELETE FROM run_seen s USING runs r WHERE r.id = s.run_id AND r.state <> 'open'`)
    const restored = await this.restoreKept()
    const expired = await this.expireMissing()
    const aged = await this.expireAged()
    const { entities: purged } = await this.purge(retentionDays)
    await this.pruneRuns(runDays)
    if ((await this.blueprints.syncPivots()).length) this.events.emit({ type: 'blueprints' })
    await this.rules.evaluateDue(relinkMinutes * 60_000)
    await this.syncSourceEntities()
    this.log.info('lifecycle tick', { abandoned, restored, expired, aged, purged })
    // Each entity expired or purged said so as it went, by its blueprint; an abandoned run moved only what is said of its source.
    if (abandoned) this.events.emit({ type: 'sources' })
  }
}

function toRun(r: RunRow): Run {
  return {
    id: r.id,
    source: r.source,
    mode: r.mode,
    scope: r.scope,
    state: r.state,
    startedAt: r.started_at.toISOString(),
    finishedAt: r.finished_at?.toISOString() ?? null,
    counts: { ...EMPTY_COUNTS, ...r.counts },
    errors: r.errors,
    massDrop: r.mass_drop,
  }
}
