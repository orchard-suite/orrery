// Writes to entities. Every write lands in one layer (pushed, git, ui, or
// override), and the winning value is resolved at read time in read.ts.

import type pg from 'pg'
import { DELETE_BLOCK_WINDOW, ICON_FIELD, TITLE_FIELD, entityId, isDerived, parseDuration, parseEntityId, type Blueprint, type EntityRef, type EntityState, type RunError, type Source } from '../shared/model.ts'
import type { BulkEditResponse, EntityPatch } from '../shared/api.ts'
import { Recording, record } from './activity.ts'
import type { Blueprints } from './blueprints.ts'
import type { Db } from './db.ts'
import type { Events } from './events.ts'
import { NO_QUEUE, type Queue } from './derive.ts'
import type { Load } from './load.ts'
import type { Logger } from './log.ts'
import { emptyLayers, equal, resolve, stable, validateValue, type Layers } from './values.ts'
import { recordRefusal, timed } from './metrics.ts'
import { tally, type Writes } from './writes.ts'

export interface EntityRow {
  blueprint: string
  key: string
  title: string
  state: EntityState
  owner: string
  scope: string | null
  hidden: boolean
  ui: Layers['ui']
  pushed: Layers['pushed']
  override: Layers['override']
  git: Layers['git']
  created_at: Date
  updated_at: Date
  last_seen_at: Date | null
  missing_since: Date | null
  missing_runs: number
  grace_until: Date | null
  deleted_at: Date | null
  blocked_until: Date | null
}

/** An entity row without its layers: who it is, its state, and its times. */
export type EntityHead = Omit<EntityRow, 'ui' | 'pushed' | 'override' | 'git'>

export interface RelationRow {
  blueprint: string
  key: string
  relation: string
  layer: string
  source: string
  target_blueprint: string
  target_key: string
  at: Date
  file: string | null
}

export interface WriteInput {
  blueprint: string
  key: string
  title?: string
  /** A name from the icon set, for this entity alone. Without one the entity shows its blueprint's icon. */
  icon?: string
  fields?: Record<string, unknown>
  /** Target ids (`blueprint:key`) or bare keys of the relation's target blueprint. Null clears the relation at this layer. */
  relations?: Record<string, string | string[] | null>
  /** Catalog file the entity came from, for git sources. */
  file?: string
  /**
   * The sender's own fingerprint of what it sends of the entity, any stable hash. Beside a full write it is kept; alone,
   * with nothing else but the reference, the item is a sighting: the entity sent again as it was last sent in full.
   */
  digest?: string
}

/** Whether an item names its entity by a digest alone, and sends nothing of it. */
export const isSighting = (i: WriteInput): boolean => i.digest !== undefined && i.title === undefined && i.icon === undefined && i.fields === undefined && i.relations === undefined && i.file === undefined

/** A write that passed every check that needs no stored row. */
interface Checked {
  ref: EntityRef
  bp: Blueprint
  fields: Record<string, unknown>
  relations: Map<string, EntityRef[] | null>
  file?: string
  digest?: string
}

/** An entity a write left as it was: `pushed` is its layer with newer observation times, when any moved, and `alive` says its owner saw it. */
interface Seen extends EntityRef {
  pushed: string | null
  alive: boolean
}

/** A new entity's row, held to be inserted with the rest of its batch. */
interface Created extends EntityRef {
  title: string
  pushed: string
  git: string
}

/** What a batch writes in a few statements at its end: new rows, new relations, the entities it only saw, and its activity rows. */
interface Held {
  created: Created[]
  relations: RelationRow[]
  seen: Seen[]
  recording: Recording
  /** The other ends of relations added or dropped: their incoming side moved. */
  ends: EntityRef[]
  /** What a snapshot run's owner saw: kept for its commit, which marks the rest missing. */
  noted: EntityRef[]
}

export interface WriteOptions {
  source: Source
  layer: 'pushed' | 'git'
  mode: 'upsert' | 'enrich'
  /** Replace what this source previously wrote at the layer; otherwise merge the given fields. */
  replace: boolean
  runId?: string
  /** The run is a snapshot: its commit says what it did not see, so each entity it saw is noted for it. */
  snapshot?: boolean
  scope?: string
  observedAt?: string
  file?: string
  at?: Date
}

/** `wanted` is a sighting the hub cannot take: the entity changed, its blueprint was saved, or its digest is not the one kept. Send it in full. */
export type WriteOutcome = 'created' | 'updated' | 'unchanged' | 'restored' | 'rejected' | 'wanted'

export interface WriteResult {
  outcome: WriteOutcome
  errors: RunError[]
  /** The title changed: what shows this entity beside another row moves with it. */
  titled?: boolean
  /** A relation changed: what reads who is linked to whom reads again. */
  linked?: boolean
  /** Taken from a sighting: nothing of the entity was sent or read. */
  sighted?: boolean
}

export class WriteError extends Error {
  readonly status: 400 | 403 | 404 | 409

  constructor(message: string, status: 400 | 403 | 404 | 409 = 400) {
    super(message)
    this.status = status
  }
}

const KEY = /^[^:\s][^\n\r\t\0]*$/
const NO_NAMES: ReadonlySet<string> = new Set()
/** The longest value, as JSON, an edit's activity row keeps of what it replaced. */
const WAS_LIMIT = 4000

/** Whether a source's value says nothing: unset, empty text, or an empty list. */
export function blank(value: unknown): boolean {
  return value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0)
}

/**
 * When an entity stops being kept under its blueprint's expiry: `after` past
 * the policy's datetime field, or past `createdAt` when it names none. Null
 * when the blueprint keeps entities for good or the time is not known.
 */
export function expiresAt(bp: Blueprint, value: (field: string) => unknown, createdAt: Date | null): number | null {
  const policy = bp.lifecycle?.expire
  if (!policy) return null
  const raw = policy.field ? value(policy.field) : null
  const from = policy.field ? (typeof raw === 'string' ? Date.parse(raw) : Number.NaN) : (createdAt?.getTime() ?? Number.NaN)
  return Number.isNaN(from) ? null : from + parseDuration(policy.after)
}

export class Entities {
  readonly db: Db
  readonly blueprints: Blueprints
  private readonly events: Events
  private readonly writes: Writes
  private readonly load: Pick<Load, 'note'>
  private readonly log: Logger
  /** Why a source may not make a write to an entity another source owns; attached once access rules exist. */
  private foreign: (blueprint: string, names: string[]) => string | null = () => null
  /** Why a blueprint takes no new entity now, when its budget says so; set by the hub. */
  full: (blueprint: string) => string | null = () => null

  constructor(db: Db, blueprints: Blueprints, events: Events, writes: Writes, load: Pick<Load, 'note'>, log: Logger) {
    this.db = db
    this.blueprints = blueprints
    this.events = events
    this.writes = writes
    this.load = load
    this.log = log
  }

  /** The deriver's queue: every write puts what it touched there, on its own transaction. The hub wires it. */
  queue: Queue = NO_QUEUE

  /** Attaches the rule that keeps a source from changing what access is decided from on an entity it does not own. */
  guard(foreign: (blueprint: string, names: string[]) => string | null): void {
    this.foreign = foreign
  }

  allowed(source: Source, blueprint: string): boolean {
    // Both sides resolve through former ids: a source registered under an old id may write the renamed blueprint.
    const wanted = this.blueprints.resolve(blueprint)
    return source.blueprints.includes('*') || source.blueprints.some((b) => this.blueprints.resolve(b) === wanted)
  }

  canDelete(source: Source, blueprint: string): boolean {
    return source.deleteGrant.includes('*') || source.deleteGrant.includes(blueprint)
  }

  /** Create or update one entity from a discovered or declared source. */
  async write(input: WriteInput, opts: WriteOptions): Promise<WriteResult> {
    return (await this.writeMany([input], opts))[0]!
  }

  /**
   * Create or update many entities from one source in one transaction. The
   * rows and their relations are read together, and the entities nothing
   * changed on are marked as seen together, so a batch costs a few statements
   * and one commit however little of it moved. One result per input, in order.
   */
  writeMany(inputs: WriteInput[], opts: WriteOptions): Promise<WriteResult[]> {
    return timed('entities.write', async () => {
      const began = performance.now()
      const results = await this.writeBatch(inputs, opts)
      let changed = 0
      let sighted = 0
      let wanted = 0
      for (const r of results) {
        if (r.outcome === 'created' || r.outcome === 'updated' || r.outcome === 'restored') changed++
        else if (r.sighted) sighted++
        else if (r.outcome === 'wanted') wanted++
      }
      // A wanted sighting is sent again in full, and counted then.
      this.load.note('write', opts.source.id, { calls: 1, ms: performance.now() - began, rows: inputs.length - sighted - wanted, extra: changed, sighted })
      return results
    })
  }

  private async writeBatch(inputs: WriteInput[], opts: WriteOptions): Promise<WriteResult[]> {
    const { source } = opts
    const now = opts.at ?? new Date()
    const results = new Array<WriteResult>(inputs.length)
    const pending: { index: number; write: Checked }[] = []
    const sightings: { index: number; ref: EntityRef; bp: Blueprint; digest: string }[] = []
    inputs.forEach((input, index) => {
      if (isSighting(input)) {
        // A sighting the hub cannot take is wanted in full, and a full write says what is wrong with it.
        const bp = this.blueprints.get(input.blueprint)
        if (bp && this.allowed(source, bp.id) && KEY.test(input.key)) sightings.push({ index, ref: { blueprint: bp.id, key: input.key }, bp, digest: input.digest! })
        else results[index] = { outcome: 'wanted', errors: [] }
        return
      }
      const checked = this.check(input, source)
      if ('outcome' in checked) results[index] = checked
      else pending.push({ index, write: checked })
    })
    if (!pending.length && !sightings.length) return results
    const moved: (EntityRef & { titled: boolean; values: boolean })[] = []
    const ends: EntityRef[] = []
    await this.db.tx(async (client) => {
      const refs = pending.map((p) => p.write.ref)
      const rows = await lockRows(client, refs)
      const relations = await relationsOf(client, refs, opts.layer, source.id)
      const held: Held = { created: [], relations: [], seen: [], recording: new Recording(), ends: [], noted: [] }
      if (sightings.length) await this.sight(client, sightings, opts, now, held, results)
      const done = new Set<string>()
      for (const { index, write } of pending) {
        const id = entityId(write.ref)
        let row = rows.get(id)
        let before = relations.get(id) ?? []
        if (done.has(id)) {
          // Named twice in one batch: the second write reads what the first left.
          await flush(client, held, now, opts)
          row = await lockRow(client, write.ref)
          before = (await relationsOf(client, [write.ref], opts.layer, source.id)).get(id) ?? []
        }
        done.add(id)
        const result = await this.apply(client, write, row, before, opts, now, held)
        if (result.outcome !== 'unchanged' && result.outcome !== 'rejected') moved.push({ ...write.ref, titled: result.titled || result.outcome !== 'updated', values: result.outcome === 'updated' && !result.linked })
        results[index] = result
      }
      await flush(client, held, now, opts)
      await keepDigests(
        client,
        source.id,
        pending.filter((p) => p.write.digest !== undefined && kept(results[p.index]!, rows.get(entityId(p.write.ref)))).map((p) => ({ ...p.write.ref, digest: p.write.digest! })),
        now,
      )
      await this.queue.enqueue(client, [...moved, ...held.ends])
      // What shows a retitled, new, or restored entity beside its own rows carries its title and state.
      await this.queue.enqueueReaders(client, moved.filter((m) => m.titled))
      ends.push(...held.ends)
    })
    for (const ref of moved) this.events.emit({ type: 'entity', ...ref })
    // A run's writes wait for the leader: a pusher needs its answer, not the derived rows.
    if (!opts.runId) await this.queue.inline([...moved, ...ends], moved.filter((m) => m.titled))
    // Every accepted write counts, changed or not: the ledger says what a source writes, not what moved.
    await this.writes.note(source.id, 'entity', tally([...pending.filter((p) => results[p.index]!.outcome !== 'rejected').map((p) => p.write.bp.id), ...sightings.filter((s) => results[s.index]!.sighted).map((s) => s.bp.id)]), now)
    return results
  }

  /** What can be told about a write without reading the entity: the blueprint takes it, the source may write it, and every value fits. */
  /**
   * Takes each sighting whose digest is the one kept for its source, while the entity is active and nothing changed it
   * and its blueprint was not saved since the digest was kept: it counts as the full write it names, which changed
   * nothing, without a value of it read. Every other sighting is wanted in full.
   */
  private async sight(client: pg.PoolClient, sightings: { index: number; ref: EntityRef; bp: Blueprint; digest: string }[], opts: WriteOptions, now: Date, held: Held, results: WriteResult[]): Promise<void> {
    const res = await client.query<Pick<EntityRow, 'blueprint' | 'key' | 'state' | 'owner' | 'scope' | 'last_seen_at' | 'updated_at'> & { digest: string; digest_at: Date }>(
      `SELECT e.blueprint, e.key, e.state, e.owner, e.scope, e.last_seen_at, e.updated_at, d.digest, d.at AS digest_at
       FROM unnest($1::text[], $2::text[]) AS v(blueprint, key)
       JOIN ingest_digests d ON d.source = $3 AND d.blueprint = v.blueprint AND d.key = v.key
       JOIN entities e ON e.blueprint = v.blueprint AND e.key = v.key`,
      [sightings.map((s) => s.ref.blueprint), sightings.map((s) => s.ref.key), opts.source.id],
    )
    const kept = new Map(res.rows.map((r) => [entityId(r), r]))
    for (const s of sightings) {
      const row = kept.get(entityId(s.ref))
      const current = row && row.state === 'active' && row.digest === s.digest && row.digest_at >= row.updated_at && row.digest_at.getTime() >= Date.parse(s.bp.updatedAt)
      if (!current) {
        results[s.index] = { outcome: 'wanted', errors: [] }
        continue
      }
      const keepsAlive = opts.mode === 'upsert' && row.owner === opts.source.id
      if (opts.snapshot && keepsAlive) held.noted.push(s.ref)
      if (keepsAlive && !markedSeen(row, opts, now)) held.seen.push({ ...s.ref, pushed: null, alive: true })
      results[s.index] = { outcome: 'unchanged', errors: [], sighted: true }
    }
  }

  private check(input: WriteInput, source: Source): Checked | WriteResult {
    const ref = { blueprint: this.blueprints.resolve(input.blueprint), key: input.key }
    const reject = (reason: string, field?: string): WriteResult => ({ outcome: 'rejected', errors: [{ ...ref, field, reason }] })
    const bp = this.blueprints.get(input.blueprint)
    if (!bp) return reject(`unknown blueprint "${input.blueprint}"`)
    if (!this.allowed(source, bp.id)) return reject(`source "${source.id}" may not write blueprint "${bp.id}"`)
    if (typeof input.key !== 'string' || !KEY.test(input.key)) return reject('key must be a non-empty string without a leading colon or control characters')

    const errors: RunError[] = []
    const fields = stripNul({ ...(input.fields ?? {}), ...(input.title !== undefined ? { [TITLE_FIELD]: input.title } : {}), ...(input.icon !== undefined ? { [ICON_FIELD]: input.icon } : {}) }) as Record<string, unknown>
    for (const [name, value] of Object.entries(fields)) {
      const def = this.blueprints.fieldDef(bp, name)
      if (!def) {
        errors.push({ ...ref, field: name, reason: `blueprint "${bp.id}" has no field "${name}"` })
        continue
      }
      if (isDerived(def)) {
        errors.push({ ...ref, field: name, reason: `"${name}" is derived and cannot be written` })
        continue
      }
      const reason = validateValue(def, value)
      if (reason) errors.push({ ...ref, field: name, reason })
    }
    const relations = new Map<string, EntityRef[] | null>()
    for (const [given, value] of Object.entries(input.relations ?? {})) {
      const name = bp.relations[given] ? given : (Object.entries(bp.relations).find(([, d]) => d.formerly?.includes(given))?.[0] ?? given)
      const def = bp.relations[name]
      if (!def) {
        errors.push({ ...ref, field: name, reason: `blueprint "${bp.id}" has no relation "${name}"` })
        continue
      }
      if (value === null) {
        relations.set(name, null)
        continue
      }
      const raw = Array.isArray(value) ? value : [value]
      const targets: EntityRef[] = []
      for (const item of raw) {
        if (typeof item !== 'string' || !item) {
          errors.push({ ...ref, field: name, reason: 'relation targets are identifiers' })
          continue
        }
        const parsed = parseEntityId(item) ?? { blueprint: def.target, key: item }
        if (parsed.blueprint !== def.target) {
          errors.push({ ...ref, field: name, reason: `relation "${name}" targets ${def.target}, not ${parsed.blueprint}` })
          continue
        }
        // A target named twice is one relation.
        if (!targets.some((t) => t.blueprint === parsed.blueprint && t.key === parsed.key)) targets.push(parsed)
      }
      if (!def.many && targets.length > 1) errors.push({ ...ref, field: name, reason: `relation "${name}" is to-one, got ${targets.length} targets` })
      relations.set(name, targets)
    }
    if (errors.length) return { outcome: 'rejected', errors }
    return { ref, bp, fields, relations, file: input.file, digest: input.digest }
  }

  /**
   * One checked write, inside the caller's transaction. `row` is the entity
   * as it stands, locked, and `before` the relations this source wrote at the
   * layer. A new entity, its new relations, its activity rows, and an
   * entity nothing changed on are not written here: they are added to `held`
   * for the caller to write with the rest of the batch.
   */
  private async apply(client: pg.PoolClient, write: Checked, row: EntityRow | undefined, before: RelationRow[], opts: WriteOptions, now: Date, held: Held): Promise<WriteResult> {
    const { source } = opts
    const { ref, bp, fields, relations } = write
    const file = write.file ?? opts.file
    const at = now.toISOString()
    const reject = (reason: string): WriteResult => ({ outcome: 'rejected', errors: [{ ...ref, reason }] })
    if (!row) {
      if (opts.mode === 'enrich') return reject('entity does not exist and enrich never creates')
      if (opts.layer === 'git' && source.class !== 'git') return reject('only git sources write the git layer')
      const full = this.full(ref.blueprint)
      if (full) {
        recordRefusal('over_budget')
        return reject(full)
      }
    }
    if (row && row.owner !== source.id && source.class !== 'git') {
      const refused = this.foreign(ref.blueprint, [...Object.keys(fields), ...relations.keys()])
      if (refused) {
        recordRefusal('foreign_write')
        this.log.warn('write refused: access is decided from it', { ...ref, source: source.id, owner: row.owner, reason: refused })
        return reject(refused)
      }
    }
    if (row?.blocked_until && row.blocked_until > now && row.state === 'deleted') {
      this.log.info('write ignored: entity recently deleted', { ...ref, source: source.id, blockedUntil: row.blocked_until })
      return reject(`deleted explicitly at ${row.deleted_at?.toISOString()}; re-creation is blocked until ${row.blocked_until.toISOString()}`)
    }
    if (!row || row.state === 'deleted') {
      // Something already past its expiry is not brought in or back: the next pass would only remove it again.
      const until = expiresAt(bp, (name) => fields[name], row?.created_at ?? null)
      if (until !== null && until <= now.getTime()) {
        this.log.debug('write ignored: past its expiry', { ...ref, source: source.id, expired: new Date(until) })
        return { outcome: 'unchanged', errors: [] }
      }
    }
    const layers: Layers = row ? { ui: row.ui, pushed: row.pushed, override: row.override, git: row.git } : emptyLayers()
    const changedFields: string[] = []
    /** A value that stayed the same was seen again at a later time, outside a snapshot: the layer is stored again, and nothing is recorded. */
    let observed = false
    /** Fields this write took over from another source, with the source that held each. */
    const overwrote: Record<string, string> = {}
    const clearedOverrides: { field: string; basis: unknown; pushed: unknown; override: unknown }[] = []

    if (opts.layer === 'pushed') {
      if (opts.replace) {
        for (const [name, entry] of Object.entries(layers.pushed)) {
          if (entry.source === source.id && !(name in fields)) {
            delete layers.pushed[name]
            changedFields.push(name)
          }
        }
      }
      for (const [name, value] of Object.entries(fields)) {
        const current = layers.pushed[name]
        if (current?.observedAt && opts.observedAt && opts.observedAt < current.observedAt) {
          this.log.debug('field skipped: older than stored observation', { ...ref, field: name, observedAt: opts.observedAt, stored: current.observedAt })
          continue
        }
        if (current && equal(current.value, value)) {
          // A snapshot says again what stands on every run, so a value it leaves as it was keeps the time it was last changed.
          if (!opts.snapshot && opts.observedAt && current.observedAt !== opts.observedAt) {
            current.observedAt = opts.observedAt
            observed = true
          }
          continue
        }
        if (current && current.source !== source.id) {
          // Accepted, and said out loud: two sources on one field means one of them is pushing what is not its own.
          overwrote[name] = current.source
          this.log.warn('field written by one source overwritten by another', { ...ref, field: name, source: source.id, previous: current.source })
        }
        layers.pushed[name] = { value, source: source.id, at, observedAt: opts.observedAt, prev: current?.value }
        changedFields.push(name)
        const override = layers.override[name]
        if (override && !equal(override.basis, value)) {
          if (this.blueprints.fieldDef(bp, name)?.sticky) {
            // The person's value stays; what it stands over is now the new pushed value.
            override.basis = value
            this.log.info('override kept: the field is sticky, so a moved pushed value does not clear it', { ...ref, field: name })
          } else {
            delete layers.override[name]
            clearedOverrides.push({ field: name, basis: override.basis, pushed: value, override: override.value })
          }
        }
      }
    } else {
      if (opts.replace) {
        for (const [name, entry] of Object.entries(layers.git)) {
          if (entry.source === source.id && !(name in fields)) {
            delete layers.git[name]
            changedFields.push(name)
          }
        }
      }
      for (const [name, value] of Object.entries(fields)) {
        const current = layers.git[name]
        if (current && equal(current.value, value) && current.file === (file ?? '')) continue
        layers.git[name] = { value, source: source.id, file: file ?? '', at }
        changedFields.push(name)
      }
    }

    const keep = new Set<string>()
    const changedRelations = new Set<string>()
    const wanted: RelationRow[] = []
    for (const [name, targets] of relations) {
      for (const t of targets ?? []) {
        const id = `${name}|${t.blueprint}|${t.key}`
        keep.add(id)
        if (!before.some((r) => r.relation === name && r.target_blueprint === t.blueprint && r.target_key === t.key)) {
          changedRelations.add(name)
          wanted.push({ ...ref, relation: name, layer: opts.layer, source: source.id, target_blueprint: t.blueprint, target_key: t.key, at: now, file: file ?? null })
          held.ends.push({ blueprint: t.blueprint, key: t.key })
        }
      }
    }
    for (const r of before) {
      const touched = relations.has(r.relation) || opts.replace
      if (touched && !keep.has(`${r.relation}|${r.target_blueprint}|${r.target_key}`)) {
        changedRelations.add(r.relation)
        held.ends.push({ blueprint: r.target_blueprint, key: r.target_key })
        await client.query('DELETE FROM relations WHERE blueprint = $1 AND key = $2 AND relation = $3 AND layer = $4 AND source = $5 AND target_blueprint = $6 AND target_key = $7', [
          r.blueprint,
          r.key,
          r.relation,
          r.layer,
          r.source,
          r.target_blueprint,
          r.target_key,
        ])
      }
    }
    held.relations.push(...wanted)

    const title = String(resolve(TITLE_FIELD, layers, undefined)?.value ?? ref.key)
    const changed = changedFields.length > 0 || changedRelations.size > 0
    const isOwner = !row || row.owner === source.id
    const keepsAlive = opts.mode === 'upsert' && isOwner
    let outcome: WriteOutcome = row ? (changed ? 'updated' : 'unchanged') : 'created'
    if (row && keepsAlive && row.state !== 'active') outcome = 'restored'
    if (opts.snapshot && keepsAlive) held.noted.push(ref)

    if (!row) {
      held.created.push({ ...ref, title, pushed: JSON.stringify(layers.pushed), git: JSON.stringify(layers.git) })
    } else if (outcome !== 'unchanged' || title !== row.title) {
      await client.query(
        `UPDATE entities SET title = $3, pushed = $4, override = $5, git = $6, updated_at = CASE WHEN $7 THEN $8 ELSE updated_at END,
             last_seen_at = CASE WHEN $9 THEN $8 ELSE last_seen_at END,
             scope = CASE WHEN $9 THEN COALESCE($10, scope) ELSE scope END,
             state = CASE WHEN $9 THEN 'active' ELSE state END,
             missing_since = CASE WHEN $9 THEN NULL ELSE missing_since END,
             missing_runs = CASE WHEN $9 THEN 0 ELSE missing_runs END,
             grace_until = CASE WHEN $9 THEN NULL ELSE grace_until END,
             deleted_at = CASE WHEN $9 THEN NULL ELSE deleted_at END,
             blocked_until = CASE WHEN $9 THEN NULL ELSE blocked_until END
           WHERE blueprint = $1 AND key = $2`,
        [ref.blueprint, ref.key, title, JSON.stringify(layers.pushed), JSON.stringify(layers.override), JSON.stringify(layers.git), changed, now, keepsAlive, opts.scope ?? null],
      )
    } else if (observed || (keepsAlive && !markedSeen(row, opts, now))) {
      held.seen.push({ ...ref, pushed: observed ? JSON.stringify(layers.pushed) : null, alive: keepsAlive })
    }

    if (outcome === 'created') {
      held.recording.add('entity.created', ref, source.id, null, { fields: Object.keys(fields), relations: [...relations.keys()], layer: opts.layer, run: opts.runId ?? null }, now)
    } else if (outcome === 'restored') {
      held.recording.add('entity.restored', ref, source.id, null, { previous: row?.state, fields: changedFields, run: opts.runId ?? null }, now)
    } else if (outcome === 'updated') {
      held.recording.add('entity.updated', ref, source.id, null, { fields: changedFields, relations: [...changedRelations], layer: opts.layer, run: opts.runId ?? null, ...(Object.keys(overwrote).length ? { overwrote } : {}) }, now)
    }
    for (const c of clearedOverrides) {
      held.recording.add('override.cleared', ref, source.id, null, c, now)
      this.log.info('override cleared: pushed value moved away from its basis', { ...ref, field: c.field })
    }
    return { outcome, errors: [], titled: !!row && title !== row.title, linked: changedRelations.size > 0 }
  }

  /** Create an entity from the web app. It is owned by the `ui` source and only a person deletes it. */
  async createFromUi(given: WriteInput, actor: string): Promise<void> {
    const input = { ...given, blueprint: this.blueprints.resolve(given.blueprint) }
    const bp = this.blueprints.get(input.blueprint)
    if (!bp) throw new WriteError(`Unknown blueprint "${input.blueprint}"`, 404)
    if (typeof input.key !== 'string' || !KEY.test(input.key)) throw new WriteError('key must be a non-empty string without a leading colon or control characters')
    const now = new Date()
    const ends = await this.db.tx(async (client) => {
      const row = await lockRow(client, input)
      if (row && row.state !== 'deleted') throw new WriteError(`${input.blueprint}:${input.key} already exists`, 409)
      const full = row ? null : this.full(input.blueprint)
      if (full) throw new WriteError(full[0]!.toUpperCase() + full.slice(1), 409)
      const title = input.title ?? input.key
      if (row) {
        await client.query(`UPDATE entities SET state = 'active', owner = 'ui', title = $3, deleted_at = NULL, blocked_until = NULL, missing_since = NULL, missing_runs = 0, updated_at = $4 WHERE blueprint = $1 AND key = $2`, [
          input.blueprint,
          input.key,
          title,
          now,
        ])
        await record(client, 'entity.restored', input, 'ui', actor, { previous: 'deleted' }, now)
      } else {
        await client.query(`INSERT INTO entities (blueprint, key, title, state, owner, created_at, updated_at, last_seen_at) VALUES ($1,$2,$3,'active','ui',$4,$4,$4)`, [input.blueprint, input.key, title, now])
        await record(client, 'entity.created', input, 'ui', actor, { layer: 'ui' }, now)
      }
      // In the same transaction: a value the blueprint refuses leaves no entity behind.
      return this.applyEdit(client, bp, input, { fields: { ...(input.fields ?? {}), [TITLE_FIELD]: input.title ?? input.key, ...(input.icon !== undefined ? { [ICON_FIELD]: input.icon } : {}) }, relations: input.relations ?? {} }, actor, now, NO_NAMES)
    })
    this.events.emit({ type: 'entity', blueprint: input.blueprint, key: input.key, titled: true })
    await this.queue.inline([input, ...ends], [input])
  }

  /**
   * A person's edit. A field a source provides becomes a soft override tied
   * to that value; a field no source provides becomes a UI value. Git-set
   * and non-overridable fields are locked. `authored` names the fields the
   * person changes only as the entity's owner: an owner writes where no
   * source says a value, and over one only where the field is sticky.
   */
  async editFromUi(given: EntityRef, patch: EntityPatch, actor: string, authored: ReadonlySet<string> = NO_NAMES): Promise<void> {
    const ref = { ...given, blueprint: this.blueprints.resolve(given.blueprint) }
    const bp = this.blueprints.get(ref.blueprint)
    if (!bp) throw new WriteError(`Unknown blueprint "${ref.blueprint}"`, 404)
    const ends = await this.db.tx((client) => this.applyEdit(client, bp, ref, patch, actor, new Date(), authored))
    const titled = patch.fields !== undefined && TITLE_FIELD in patch.fields
    this.events.emit({ type: 'entity', ...ref, titled, values: patch.relations === undefined })
    await this.queue.inline([ref, ...ends], titled ? [ref] : [])
  }

  /** The edit itself, inside the caller's transaction. */
  private async applyEdit(client: pg.PoolClient, bp: Blueprint, ref: EntityRef, patch: EntityPatch, actor: string, now: Date, authored: ReadonlySet<string>): Promise<EntityRef[]> {
    const at = now.toISOString()
    const row = await lockRow(client, ref)
    if (!row || row.state === 'deleted') throw new WriteError(`${ref.blueprint}:${ref.key} does not exist`, 404)
    const layers: Layers = { ui: row.ui, pushed: row.pushed, override: row.override, git: row.git }
    const changed: string[] = []
    /** The hand value each changed field held before, null where it held none: what puts the edit back. */
    const was: Record<string, unknown> = {}
    const note = (name: string) => {
      changed.push(name)
      was[name] = layers.override[name]?.value ?? layers.ui[name]?.value ?? null
    }
    for (const [name, value] of Object.entries(patch.fields ?? {})) {
      const def = this.blueprints.fieldDef(bp, name)
      if (!def) throw new WriteError(`Blueprint "${bp.id}" has no field "${name}"`)
      if (isDerived(def)) throw new WriteError(`"${name}" is derived and cannot be edited`, 403)
      if (layers.git[name]) throw new WriteError(`"${name}" is set in git (${layers.git[name].file}); edit it there`, 403)
      if (def.overridable === false) throw new WriteError(`"${name}" is locked: only sources write it`, 403)
      const reason = validateValue(def, value)
      if (reason) throw new WriteError(`${name}: ${reason}`)
      const pushed = layers.pushed[name]
      if (authored.has(name) && pushed && !def.sticky && !blank(pushed.value)) {
        this.log.info('owner edit refused: a source says this value', { ...ref, field: name, actor, source: pushed.source })
        throw new WriteError(`"${name}" comes from ${pushed.source}: change it there`, 403)
      }
      if (value === null || value === undefined) {
        if (layers.override[name] || layers.ui[name]) note(name)
        delete layers.override[name]
        delete layers.ui[name]
      } else if (pushed) {
        if (equal(pushed.value, value)) {
          // Setting it back to what the source says removes the override.
          if (layers.override[name]) note(name)
          delete layers.override[name]
        } else if (!layers.override[name] || !equal(layers.override[name].value, value)) {
          note(name)
          layers.override[name] = { value, basis: pushed.value, by: actor, at }
        }
      } else if (!layers.ui[name] || !equal(layers.ui[name].value, value)) {
        note(name)
        layers.ui[name] = { value, by: actor, at }
      }
    }
    const changedRelations: string[] = []
    /** The entities each changed relation named by hand before. */
    const wasRelations: Record<string, string[]> = {}
    /** The links to nothing a source had made, dropped with the edit. */
    const dangling: Record<string, string[]> = {}
    const ends: EntityRef[] = []
    for (const [name, value] of Object.entries(patch.relations ?? {})) {
      const def = bp.relations[name]
      if (!def) throw new WriteError(`Blueprint "${bp.id}" has no relation "${name}"`)
      const gitRows = await client.query('SELECT 1 FROM relations WHERE blueprint = $1 AND key = $2 AND relation = $3 AND layer = $4 LIMIT 1', [ref.blueprint, ref.key, name, 'git'])
      if (gitRows.rowCount) throw new WriteError(`Relation "${name}" is set in git; edit it there`, 403)
      const targets = value === null ? [] : (Array.isArray(value) ? value : [value]).map((v) => parseEntityId(v) ?? { blueprint: def.target, key: v })
      for (const t of targets) if (t.blueprint !== def.target) throw new WriteError(`Relation "${name}" targets ${def.target}, not ${t.blueprint}`)
      if (!def.many && targets.length > 1) throw new WriteError(`Relation "${name}" is to-one`)
      const dropped = await client.query<{ target_blueprint: string; target_key: string }>('DELETE FROM relations WHERE blueprint = $1 AND key = $2 AND relation = $3 AND layer = $4 RETURNING target_blueprint, target_key', [ref.blueprint, ref.key, name, 'ui'])
      for (const r of dropped.rows) ends.push({ blueprint: r.target_blueprint, key: r.target_key })
      wasRelations[name] = dropped.rows.map((r) => entityId({ blueprint: r.target_blueprint, key: r.target_key }))
      // A source's link of it to what does not exist goes with the hand edit: one the source no longer writes would stand under the hand value forever. A source that writes it again puts it back.
      const nowhere = await client.query<{ source: string; target_blueprint: string; target_key: string }>(
        `DELETE FROM relations r WHERE r.blueprint = $1 AND r.key = $2 AND r.relation = $3 AND r.layer = 'pushed'
           AND NOT EXISTS (SELECT 1 FROM entities t WHERE t.blueprint = r.target_blueprint AND t.key = r.target_key AND t.state <> 'deleted')
         RETURNING r.source, r.target_blueprint, r.target_key`,
        [ref.blueprint, ref.key, name],
      )
      if (nowhere.rowCount) {
        dangling[name] = nowhere.rows.map((r) => entityId({ blueprint: r.target_blueprint, key: r.target_key }))
        this.log.info('hand edit dropped source links to nothing', { ...ref, relation: name, actor, links: nowhere.rows.map((r) => ({ source: r.source, target: entityId({ blueprint: r.target_blueprint, key: r.target_key }) })) })
      } else {
        this.log.debug('hand edit found no source link to nothing', { ...ref, relation: name })
      }
      for (const t of targets) {
        await client.query(`INSERT INTO relations (blueprint, key, relation, layer, source, target_blueprint, target_key, at) VALUES ($1,$2,$3,'ui',$4,$5,$6,$7)`, [ref.blueprint, ref.key, name, actor, t.blueprint, t.key, now])
        ends.push(t)
      }
      changedRelations.push(name)
    }
    const title = String(resolve(TITLE_FIELD, layers, undefined)?.value ?? ref.key)
    await client.query('UPDATE entities SET ui = $3, override = $4, title = $5, updated_at = $6 WHERE blueprint = $1 AND key = $2', [ref.blueprint, ref.key, JSON.stringify(layers.ui), JSON.stringify(layers.override), title, now])
    if (changed.length || changedRelations.length) {
      // A value too long to keep in the log is left out: the edit is still named, and is put back by hand.
      const kept = Object.fromEntries(Object.entries(was).filter(([, v]) => JSON.stringify(v).length <= WAS_LIMIT))
      await record(client, 'entity.updated', ref, 'ui', actor, { fields: changed, relations: changedRelations, layer: 'ui', ...(changed.length ? { was: kept } : {}), ...(Object.keys(wasRelations).length ? { wasRelations } : {}), ...(Object.keys(dangling).length ? { dangling } : {}) }, now)
    }
    await this.queue.enqueue(client, [ref, ...ends])
    if (patch.fields !== undefined && TITLE_FIELD in patch.fields) await this.queue.enqueueReaders(client, [ref])
    return ends
  }

  /**
   * One change made to many entities at once. Each entity is edited on its
   * own, so one that refuses (a value set in git, a field that cannot be
   * overridden) does not stop the rest; the answer names every refusal.
   */
  async editManyFromUi(refs: EntityRef[], change: EntityPatch & { hidden?: boolean }, actor: string, authored: (ref: EntityRef) => ReadonlySet<string> = () => NO_NAMES): Promise<BulkEditResponse> {
    const refused: BulkEditResponse['refused'] = []
    const edits = change.fields || change.relations
    for (const ref of refs) {
      try {
        if (edits) await this.editFromUi(ref, change, actor, authored(ref))
        if (change.hidden !== undefined) await this.setHidden(ref, change.hidden, actor)
      } catch (error) {
        if (!(error instanceof WriteError)) throw error
        refused.push({ blueprint: ref.blueprint, key: ref.key, reason: error.message })
        this.log.info('bulk edit refused for one entity', { ...ref, actor, reason: error.message })
      }
    }
    this.log.info('bulk edit applied', { actor, entities: refs.length, changed: refs.length - refused.length, refused: refused.length, fields: Object.keys(change.fields ?? {}), relations: Object.keys(change.relations ?? {}), hidden: change.hidden ?? null })
    return { changed: refs.length - refused.length, refused }
  }

  /** Drops UI values and overrides for fields git now provides, and hands a UI-owned entity to git. */
  async cleanupShadowed(ref: EntityRef, actor: string): Promise<{ fields: string[]; ownerChanged: boolean }> {
    const now = new Date()
    const result = await this.db.tx(async (client) => {
      const row = await lockRow(client, ref)
      if (!row || row.state === 'deleted') throw new WriteError(`${ref.blueprint}:${ref.key} does not exist`, 404)
      const fields: string[] = []
      for (const name of Object.keys(row.git)) {
        if (row.ui[name] || row.override[name]) {
          delete row.ui[name]
          delete row.override[name]
          fields.push(name)
        }
      }
      const gitSource = Object.values(row.git)[0]?.source
      const ownerChanged = row.owner === 'ui' && !!gitSource
      await client.query('UPDATE entities SET ui = $3, override = $4, owner = $5, updated_at = $6 WHERE blueprint = $1 AND key = $2', [
        ref.blueprint,
        ref.key,
        JSON.stringify(row.ui),
        JSON.stringify(row.override),
        ownerChanged ? gitSource : row.owner,
        now,
      ])
      if (fields.length || ownerChanged) await record(client, 'entity.updated', ref, 'ui', actor, { cleanup: fields, ownerChanged, layer: 'ui' }, now)
      await this.queue.enqueue(client, [ref])
      return { fields, ownerChanged }
    })
    this.events.emit({ type: 'entity', ...ref })
    await this.queue.inline([ref])
    return result
  }

  async setHidden(ref: EntityRef, hidden: boolean, actor: string): Promise<void> {
    await this.db.tx(async (client) => {
      const res = await client.query(`UPDATE entities SET hidden = $3 WHERE blueprint = $1 AND key = $2 AND state <> 'deleted'`, [ref.blueprint, ref.key, hidden])
      if (!res.rowCount) throw new WriteError(`${ref.blueprint}:${ref.key} does not exist`, 404)
      await record(client, 'entity.hidden', ref, 'ui', actor, { hidden })
      await this.queue.enqueue(client, [ref])
    })
    // A hidden entity leaves what shows it beside another row.
    this.events.emit({ type: 'entity', ...ref, titled: true })
    await this.queue.inline([ref], [ref])
  }

  /** A person deletes a UI-owned entity. Anything a source owns can only be hidden. */
  async deleteFromUi(ref: EntityRef, actor: string): Promise<void> {
    const row = (await this.db.query<EntityRow>('SELECT * FROM entities WHERE blueprint = $1 AND key = $2', [ref.blueprint, ref.key])).rows[0]
    if (!row || row.state === 'deleted') throw new WriteError(`${ref.blueprint}:${ref.key} does not exist`, 404)
    if (row.owner !== 'ui') throw new WriteError(`${ref.blueprint}:${ref.key} is owned by source "${row.owner}", which would recreate it. Hide it instead`, 403)
    await this.tombstone([ref], 'ui', actor, { reason: 'deleted by a person' }, false)
  }

  /** A source with a delete grant removes an entity now and blocks snapshots from recreating it for a short window. */
  async explicitDelete(ref: EntityRef, source: Source): Promise<void> {
    if (!this.canDelete(source, ref.blueprint)) throw new WriteError(`source "${source.id}" holds no delete grant for "${ref.blueprint}"`, 403)
    const row = (await this.db.query<EntityRow>('SELECT * FROM entities WHERE blueprint = $1 AND key = $2', [ref.blueprint, ref.key])).rows[0]
    if (!row || row.state === 'deleted') throw new WriteError(`${ref.blueprint}:${ref.key} does not exist`, 404)
    await this.tombstone([ref], source.id, null, { reason: 'explicit delete' }, true)
  }

  /** Marks entities deleted. The row stays as a tombstone until purge, so a return keeps its UI values and notes. */
  async tombstone(refs: EntityRef[], source: string, actor: string | null, detail: Record<string, unknown>, block: boolean): Promise<void> {
    const now = new Date()
    const blocked = block ? new Date(now.getTime() + parseDuration(DELETE_BLOCK_WINDOW)) : null
    await this.db.tx(async (client) => {
      for (const ref of refs) {
        const res = await client.query(`UPDATE entities SET state = 'deleted', deleted_at = $3, blocked_until = $4, updated_at = $3 WHERE blueprint = $1 AND key = $2 AND state <> 'deleted'`, [ref.blueprint, ref.key, now, blocked])
        if (res.rowCount) await record(client, 'entity.deleted', ref, source, actor, detail, now)
      }
      // A deleted entity has no derived row; what pointed at it, and what it pointed at, shows it gone.
      const ends = await client.query<{ blueprint: string; key: string }>(
        `SELECT target_blueprint AS blueprint, target_key AS key FROM relations WHERE (blueprint, key) IN (SELECT * FROM unnest($1::text[], $2::text[]))`,
        [refs.map((r) => r.blueprint), refs.map((r) => r.key)],
      )
      await this.queue.forget(client, refs)
      await this.queue.enqueue(client, ends.rows)
    })
    this.log.info('entities deleted', { count: refs.length, source, block })
    for (const ref of refs) this.events.emit({ type: 'entity', ...ref, titled: true })
  }

  /** Values stored for a field across a blueprint, for type-change checks. */
  async valuesOf(blueprint: string, field: string): Promise<{ key: string; value: unknown }[]> {
    const rows = await this.db.query<EntityRow>(`SELECT * FROM entities WHERE blueprint = $1 AND state <> 'deleted'`, [blueprint])
    const out: { key: string; value: unknown }[] = []
    for (const row of rows.rows) {
      const r = resolve(field, { ui: row.ui, pushed: row.pushed, override: row.override, git: row.git }, undefined)
      if (r && r.value !== null && r.value !== undefined) out.push({ key: row.key, value: r.value })
    }
    return out
  }
}

/** Postgres JSON cannot hold U+0000; a device name with one would fail the whole batch. */
function stripNul(value: unknown): unknown {
  if (typeof value === 'string') return value.includes('\0') ? value.replaceAll('\0', '') : value
  if (Array.isArray(value)) return value.map(stripNul)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k.replaceAll('\0', ''), stripNul(v)]))
  return value
}

async function lockRow(client: pg.PoolClient, ref: EntityRef): Promise<EntityRow | undefined> {
  const res = await client.query<EntityRow>('SELECT * FROM entities WHERE blueprint = $1 AND key = $2 FOR UPDATE', [ref.blueprint, ref.key])
  return res.rows[0]
}

/** Locks many rows at once, always in the same order, so two batches that share entities wait for each other instead of deadlocking. */
async function lockRows(client: pg.PoolClient, refs: EntityRef[]): Promise<Map<string, EntityRow>> {
  const res = await client.query<EntityRow>('SELECT * FROM entities WHERE (blueprint, key) IN (SELECT * FROM unnest($1::text[], $2::text[])) ORDER BY blueprint, key FOR UPDATE', [refs.map((r) => r.blueprint), refs.map((r) => r.key)])
  return new Map(res.rows.map((row) => [entityId(row), row]))
}

/** The relations one source wrote at one layer, by the entity that holds them. */
async function relationsOf(client: pg.PoolClient, refs: EntityRef[], layer: string, source: string): Promise<Map<string, RelationRow[]>> {
  // The source is matched here, not in the query: a planner that thinks a source rare walks all it wrote once per entity asked for.
  const res = await client.query<RelationRow>('SELECT * FROM relations WHERE (blueprint, key) IN (SELECT * FROM unnest($1::text[], $2::text[])) AND layer = $3', [refs.map((r) => r.blueprint), refs.map((r) => r.key), layer])
  const out = new Map<string, RelationRow[]>()
  for (const r of res.rows) {
    if (r.source !== source) continue
    const list = out.get(entityId(r))
    if (list) list.push(r)
    else out.set(entityId(r), [r])
  }
  return out
}

/** Writes what a batch held: new entities, then their relations, then what it only saw, then its activity rows. */
async function flush(client: pg.PoolClient, held: Held, now: Date, opts: WriteOptions): Promise<void> {
  const created = held.created.splice(0)
  if (created.length) {
    await client.query(
      `INSERT INTO entities (blueprint, key, title, state, owner, scope, ui, pushed, override, git, created_at, updated_at, last_seen_at)
       SELECT v.blueprint, v.key, v.title, 'active', $6, $7, '{}', v.pushed::jsonb, '{}', v.git::jsonb, $8, $8, $8
       FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[]) AS v(blueprint, key, title, pushed, git)`,
      [created.map((c) => c.blueprint), created.map((c) => c.key), created.map((c) => c.title), created.map((c) => c.pushed), created.map((c) => c.git), opts.source.id, opts.scope ?? null, now],
    )
  }
  const relations = held.relations.splice(0)
  if (relations.length) {
    const col = <K extends keyof RelationRow>(k: K) => relations.map((r) => r[k])
    await client.query(
      `INSERT INTO relations (blueprint, key, relation, layer, source, target_blueprint, target_key, at, file)
       SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::timestamptz[], $9::text[])`,
      [col('blueprint'), col('key'), col('relation'), col('layer'), col('source'), col('target_blueprint'), col('target_key'), col('at'), col('file')],
    )
  }
  await markSeen(client, held.seen.splice(0), now, opts)
  const noted = held.noted.splice(0)
  if (noted.length && opts.runId) await client.query('INSERT INTO run_seen (run_id, blueprints, keys) VALUES ($1, $2, $3)', [opts.runId, noted.map((r) => r.blueprint), noted.map((r) => r.key)])
  await held.recording.flush(client)
}

/**
 * How often a write that changes nothing stores that its owner saw the
 * entity. A pusher that sends the same entities on every run, outside a
 * snapshot, would otherwise rewrite each of them each run for nothing but
 * this time, so last-seen on such an entity is right to within this.
 */
const SEEN_EVERY_MS = 15 * 60_000

/**
 * Whether the row already says what an unchanged write would store on it.
 * A snapshot stores nothing on an entity it leaves as it was: its commit
 * says once, for the scope, that every entity it left active was seen. Any
 * other write stores the sighting once every `SEEN_EVERY_MS`.
 */
function markedSeen(row: Pick<EntityRow, 'scope' | 'last_seen_at'>, opts: WriteOptions, now: Date): boolean {
  if (opts.scope !== undefined && opts.scope !== row.scope) return false
  if (opts.snapshot) return true
  return row.last_seen_at !== null && now.getTime() - row.last_seen_at.getTime() < SEEN_EVERY_MS
}

/** Stores, in one statement, what a write leaves on the entities it changed nothing on. */
async function markSeen(client: pg.PoolClient, seen: Seen[], now: Date, opts: WriteOptions): Promise<void> {
  if (!seen.length) return
  await client.query(
    `UPDATE entities e SET pushed = COALESCE(v.pushed::jsonb, e.pushed),
       last_seen_at = CASE WHEN v.alive THEN $5::timestamptz ELSE e.last_seen_at END,
       scope = CASE WHEN v.alive THEN COALESCE($6::text, e.scope) ELSE e.scope END
     FROM unnest($1::text[], $2::text[], $3::text[], $4::boolean[]) AS v(blueprint, key, pushed, alive)
     WHERE e.blueprint = v.blueprint AND e.key = v.key`,
    [seen.map((s) => s.blueprint), seen.map((s) => s.key), seen.map((s) => s.pushed), seen.map((s) => s.alive), now, opts.scope ?? null],
  )
}

/** Whether a full write leaves its entity standing as what it sent, so the digest it came with names it from now on. */
function kept(result: WriteResult, row: EntityRow | undefined): boolean {
  if (result.outcome === 'created' || result.outcome === 'updated' || result.outcome === 'restored') return true
  // An unchanged write past its expiry brings nothing in or back.
  return result.outcome === 'unchanged' && !!row && row.state !== 'deleted'
}

/** Keeps the digest each full write came with, in one statement, after the batch's new rows are in. */
async function keepDigests(client: pg.PoolClient, source: string, digests: (EntityRef & { digest: string })[], now: Date): Promise<void> {
  if (!digests.length) return
  // An entity named twice in one batch keeps the digest of its last write.
  digests = [...new Map(digests.map((d) => [entityId(d), d])).values()]
  await client.query(
    `INSERT INTO ingest_digests (source, blueprint, key, digest, at)
     SELECT $1, v.blueprint, v.key, v.digest, $5 FROM unnest($2::text[], $3::text[], $4::text[]) AS v(blueprint, key, digest)
     ON CONFLICT (source, blueprint, key) DO UPDATE SET digest = EXCLUDED.digest, at = EXCLUDED.at`,
    [source, digests.map((d) => d.blueprint), digests.map((d) => d.key), digests.map((d) => d.digest), now],
  )
}

export { stable }
