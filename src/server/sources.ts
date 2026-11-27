import { createHash, randomBytes } from 'node:crypto'
import { z } from 'zod'
import type { TokenIssued, TokenSummary } from '../shared/api.ts'
import { filterSchema, tiersSchema } from '../shared/action-spec.ts'
import { ACTS_FOR, EDITION_BLUEPRINT, REPORT_BLUEPRINT, RUNNER_BLUEPRINT, SAFE_PATH_BLUEPRINT, SCHEDULE_BLUEPRINT, SOURCE_BLUEPRINT, SOURCE_CLASSES, parseDuration, type GracePolicy, type Source, type SourceClass, type StatusLevel } from '../shared/model.ts'
import { record } from './activity.ts'
import type { Db } from './db.ts'
import { NO_QUEUE, type Queue } from './derive.ts'
import type { Logger } from './log.ts'
import type { SecretBox } from './secrets.ts'
import { equal, stable, type Layers } from './values.ts'
import type { Writes } from './writes.ts'

export const sourceSpecSchema = z.object({
  title: z.string().min(1),
  class: z.enum(SOURCE_CLASSES),
  description: z.string().optional(),
  blueprints: z.array(z.string()).default(['*']),
  deleteGrant: z.array(z.string()).default([]),
  cadence: z.string().nullable().default(null),
  grace: z.object({ runs: z.number().int().min(0).optional(), duration: z.string().optional() }).optional(),
  history: z.object({ blueprint: z.string().min(1), relation: z.string().min(1).optional() }).optional(),
  // Only the shape is checked: what the blueprint means is the user's.
  actsFor: z.string().regex(ACTS_FOR, 'an entity reference, <blueprint>:<key>').nullable().default(null),
  actions: z.boolean().default(false),
  scorecards: z.boolean().default(false),
  watches: z.boolean().default(false),
  // Which tools a runner runs. Null takes the rule away.
  serves: z
    .object({
      tiers: tiersSchema.min(1),
      sources: z.array(z.string().min(1)).max(50).optional(),
      on: z.object({ blueprint: z.string().min(1), where: filterSchema.optional() }).optional(),
    })
    .nullish(),
  git: z
    .object({
      url: z.string().min(1),
      branch: z.string().min(1).default('main'),
      glob: z.string().min(1).default('**/*.yaml'),
      webUrl: z.string().optional(),
      auth: z
        .discriminatedUnion('type', [z.object({ type: z.literal('token') }), z.object({ type: z.literal('github-app'), appId: z.string().min(1), installationId: z.string().min(1) })])
        .optional(),
    })
    .optional(),
})
export type SourceSpec = z.infer<typeof sourceSpecSchema>

interface SourceRow {
  id: string
  spec: SourceSpec
  git_token: string | null
  created_at: Date
  last_seen_at: Date | null
  last_run_at: Date | null
  last_error: string | null
  status: StatusLevel
  status_reason: string | null
  width: number | null
}

export const ID = /^[a-z0-9][a-z0-9_@.-]*$/

/** How long a source or a token may go on being used before the hub stores that it was. Every request would otherwise be a write. */
const SEEN_EVERY = 60_000

export class SourceError extends Error {
  readonly status: 400 | 404 | 409

  constructor(message: string, status: 400 | 404 | 409 = 400) {
    super(message)
    this.status = status
  }
}

/** Writer identities: who may write what, how often they are expected, and their tokens. */
export class Sources {
  /** The deriver's queue: an entity that changed hands has its owner and status derived again. The hub wires it. */
  queue: Queue = NO_QUEUE
  private cache = new Map<string, SourceRow>()
  /** When each source's `last_seen_at` was last stored. */
  private readonly seenStored = new Map<string, number>()

  private readonly db: Db
  private readonly secrets: SecretBox
  private readonly writes: Writes
  private readonly log: Logger

  constructor(db: Db, secrets: SecretBox, writes: Writes, log: Logger) {
    this.db = db
    this.secrets = secrets
    this.writes = writes
    this.log = log
  }

  async load(): Promise<void> {
    const rows = await this.db.query<SourceRow>('SELECT * FROM sources ORDER BY id')
    this.cache = new Map(rows.rows.map((r) => [r.id, r]))
  }

  /** The `ui` and `hub` sources always exist. The hub writes its own blueprints, and `also`: the blueprint it keeps its approvals in. */
  async ensureBuiltins(also: string[] = []): Promise<void> {
    if (!this.cache.has('ui')) await this.save('ui', { title: 'Web app', class: 'ui', description: 'Edits made by people in the web app.', blueprints: ['*'], deleteGrant: ['*'], cadence: null })
    const own = [SOURCE_BLUEPRINT, RUNNER_BLUEPRINT, SCHEDULE_BLUEPRINT, REPORT_BLUEPRINT, EDITION_BLUEPRINT, SAFE_PATH_BLUEPRINT, ...also]
    if (!equal(this.cache.get('hub')?.spec.blueprints, own)) {
      await this.save('hub', { title: 'Hub', class: 'hub', description: 'The hub itself: it keeps the source, runner, schedule, report, report edition, and safe path entities.', blueprints: own, deleteGrant: own, cadence: null })
    }
  }

  list(): Source[] {
    return [...this.cache.values()].map((r) => this.toSource(r))
  }

  get(id: string): Source | undefined {
    const row = this.cache.get(id)
    return row && this.toSource(row)
  }

  /** How a source stands, without the rest of it: what every entity's status reads, so it is cheap. */
  standing(id: string): { class: Source['class']; status: StatusLevel; statusReason: string | null } | undefined {
    const row = this.cache.get(id)
    if (!row) return undefined
    const { level, reason } = this.effectiveStatus(row)
    return { class: row.spec.class, status: level, statusReason: reason }
  }

  /**
   * What a source's standing puts on the entities it owns: why it greys them,
   * or null while it does not. A red or amber source leaves its entities as
   * they are, so a failed run's new reason moves none of them.
   */
  greys(id: string): string | null {
    const s = this.standing(id)
    return s && s.status === 'grey' && s.class !== 'ui' && s.class !== 'hub' ? (s.statusReason ?? 'stale') : null
  }

  require(id: string): Source {
    const s = this.get(id)
    if (!s) throw new SourceError(`Unknown source "${id}"`, 404)
    return s
  }

  /**
   * Registers or changes a source. A spec that leaves out `actsFor`,
   * `actions`, `scorecards`, `watches`, or `serves` keeps what the source had, so a save that does
   * not know of them never clears what an admin set.
   */
  async save(id: string, input: unknown, gitToken?: string | null): Promise<Source> {
    if (!ID.test(id)) throw new SourceError('source ids are lowercase letters, digits, and _ @ . -')
    const existing = this.cache.get(id)
    const was = existing && sourceSpecSchema.safeParse(existing.spec).data
    const given = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
    const parsed = sourceSpecSchema.safeParse({ ...given, actsFor: 'actsFor' in given ? given.actsFor : (was?.actsFor ?? null), actions: 'actions' in given ? given.actions : (was?.actions ?? false), scorecards: 'scorecards' in given ? given.scorecards : (was?.scorecards ?? false), watches: 'watches' in given ? given.watches : (was?.watches ?? false), serves: 'serves' in given ? given.serves : was?.serves })
    if (!parsed.success) throw new SourceError(`Invalid source: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
    const spec = parsed.data
    if (spec.serves == null) delete spec.serves
    if (spec.serves && spec.class !== 'runner') throw new SourceError('only a runner serves tools')
    if (spec.cadence) parseDuration(spec.cadence)
    if (spec.grace?.duration) parseDuration(spec.grace.duration)
    if (spec.class === 'git' && !spec.git) throw new SourceError('a git source needs git: { url, branch, glob }')
    if (spec.history && spec.class !== 'event') throw new SourceError('only an event source keeps alert history')
    if (spec.history && !spec.blueprints.includes('*') && !spec.blueprints.includes(spec.history.blueprint)) throw new SourceError(`the source must be registered for ${spec.history.blueprint} to keep alert history in it`)
    const sealed = gitToken === undefined ? (existing?.git_token ?? null) : gitToken ? this.secrets.seal(gitToken) : null
    const res = await this.db.query<SourceRow>(
      `INSERT INTO sources (id, spec, git_token) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET spec = EXCLUDED.spec, git_token = EXCLUDED.git_token RETURNING *`,
      [id, JSON.stringify(spec), sealed],
    )
    const row = res.rows[0]!
    this.cache.set(id, row)
    const grants = { ...(spec.actsFor !== (was?.actsFor ?? null) ? { actsFor: spec.actsFor } : {}), ...(spec.actions !== (was?.actions ?? false) ? { actions: spec.actions } : {}), ...(spec.scorecards !== (was?.scorecards ?? false) ? { scorecards: spec.scorecards } : {}), ...(spec.watches !== (was?.watches ?? false) ? { watches: spec.watches } : {}), ...(stable(spec.serves ?? null) !== stable(was?.serves ?? null) ? { serves: spec.serves ?? null } : {}) }
    if (!existing || stable(was ?? existing.spec) !== stable(spec) || sealed !== existing.git_token) await record(this.db, 'source.changed', null, id, null, { created: !existing, class: spec.class, ...grants })
    this.log.info('source saved', { source: id, class: spec.class, created: !existing, ...grants })
    return this.toSource(row)
  }

  /**
   * Removes a source. What a git source defined (blueprints, rules,
   * scorecards, alert rules, actions) is handed to the web app as editable: without
   * its source nothing could ever change it again. The links it wrote go with
   * it. Callers reload whatever caches those definitions, and drop what reads
   * the blueprints whose links moved. Returns how many definitions were handed
   * over and those blueprints.
   */
  async remove(id: string): Promise<{ handed: number; unlinked: string[] }> {
    if (id === 'ui' || id === 'hub') throw new SourceError(`source "${id}" is built in`)
    if (!this.cache.has(id)) throw new SourceError(`Unknown source "${id}"`, 404)
    const owned = await this.db.query<{ n: string }>(`SELECT count(*)::text AS n FROM entities WHERE owner = $1 AND state <> 'deleted'`, [id])
    if (Number(owned.rows[0]?.n) > 0) throw new SourceError(`source "${id}" still owns ${owned.rows[0]?.n} entities; they must expire or be deleted first`, 409)
    let handed = 0
    for (const table of ['blueprints', 'relation_rules', 'scorecards', 'alert_rules', 'actions']) {
      const res = await this.db.query(`UPDATE ${table} SET origin = '{"kind":"ui"}' WHERE origin->>'kind' = 'git' AND origin->>'source' = $1`, [id])
      handed += res.rowCount ?? 0
    }
    const ends = await this.db.tx(async (client) => {
      const gone = await client.query<{ blueprint: string; key: string; target_blueprint: string; target_key: string }>(
        `DELETE FROM relations WHERE source = $1 AND layer IN ('pushed', 'git') RETURNING blueprint, key, target_blueprint, target_key`,
        [id],
      )
      const refs = gone.rows.flatMap((r) => [{ blueprint: r.blueprint, key: r.key }, { blueprint: r.target_blueprint, key: r.target_key }])
      await this.queue.enqueue(client, refs)
      return refs
    })
    await this.queue.inline(ends)
    const unlinked = [...new Set(ends.map((r) => r.blueprint))]
    await this.db.query('DELETE FROM sources WHERE id = $1', [id])
    await this.db.query('DELETE FROM tokens WHERE source = $1', [id])
    await this.writes.forget(id)
    await record(this.db, 'source.changed', null, id, null, { removed: true, definitionsHandedToTheWebApp: handed, linksOn: unlinked })
    this.cache.delete(id)
    this.log.info('source removed', { source: id, definitionsHandedToTheWebApp: handed, linksOn: unlinked })
    return { handed, unlinked }
  }

  /**
   * Hands every entity a source owns to another source, for when one pusher
   * replaces another. The receiver takes the ownership, the pushed fields,
   * and the relations the giver wrote, so its next snapshot keeps or deletes
   * them as its own. With a scope, the entities move into it, the scope the
   * receiver snapshots. With blueprints, only the entities of those move, for
   * when another pusher takes over one part of what a source writes. Nothing
   * is deleted here.
   */
  async handOver(id: string, to: string, scope?: string, only?: string[]): Promise<{ entities: number; relations: number }> {
    const from = this.require(id)
    const receiver = this.require(to)
    if (id === to) throw new SourceError('a source cannot hand its entities to itself')
    if (from.class !== 'pusher' || receiver.class !== 'pusher') throw new SourceError('only a pusher hands its entities to another pusher')
    return this.db.tx(async (client) => {
      const owned = await client.query<{ blueprint: string }>(`SELECT DISTINCT blueprint FROM entities WHERE owner = $1 AND state <> 'deleted' AND ($2::text[] IS NULL OR blueprint = ANY($2))`, [id, only ?? null])
      const refused = owned.rows.map((r) => r.blueprint).filter((b) => !receiver.blueprints.includes('*') && !receiver.blueprints.includes(b))
      if (refused.length) throw new SourceError(`source "${to}" is not registered for ${refused.join(', ')}`, 409)
      const entities = await client.query<{ blueprint: string; key: string }>(
        `UPDATE entities SET owner = $2, scope = COALESCE($3, scope),
           pushed = (SELECT COALESCE(jsonb_object_agg(f.key, CASE WHEN f.value->>'source' = $1 THEN jsonb_set(f.value, '{source}', to_jsonb($2::text)) ELSE f.value END), '{}'::jsonb) FROM jsonb_each(pushed) f)
         WHERE owner = $1 AND state <> 'deleted' AND ($4::text[] IS NULL OR blueprint = ANY($4)) RETURNING blueprint, key`,
        [id, to, scope ?? null, only ?? null],
      )
      await this.queue.enqueue(client, entities.rows)
      // A link the receiver already holds is kept once, as the receiver's.
      await client.query(
        `DELETE FROM relations r USING entities e
         WHERE r.source = $1 AND r.layer = 'pushed' AND e.blueprint = r.blueprint AND e.key = r.key AND e.owner = $2
           AND EXISTS (SELECT 1 FROM relations m WHERE m.blueprint = r.blueprint AND m.key = r.key AND m.relation = r.relation AND m.layer = r.layer
             AND m.source = $2 AND m.target_blueprint = r.target_blueprint AND m.target_key = r.target_key)`,
        [id, to],
      )
      const relations = await client.query(
        `UPDATE relations r SET source = $2 FROM entities e
         WHERE r.source = $1 AND r.layer = 'pushed' AND e.blueprint = r.blueprint AND e.key = r.key AND e.owner = $2`,
        [id, to],
      )
      const counts = { entities: entities.rowCount ?? 0, relations: relations.rowCount ?? 0 }
      if (counts.entities) await record(client, 'source.changed', null, id, null, { handedTo: to, scope: scope ?? null, blueprints: only ?? null, ...counts })
      this.log.info('source handed its entities over', { source: id, to, scope: scope ?? null, blueprints: only ?? null, ...counts })
      return counts
    })
  }

  /**
   * Hands every entity a pusher owns to people, for when a list a source
   * copied in becomes one people keep here. Each entity is the web app's
   * from then on: what the source said of it, and the links it wrote, stand
   * as if `actor` had typed them, with a value a person had set over the
   * source's kept in its place. What other sources say of it stays theirs.
   * With blueprints, only the entities of those move. Nothing is deleted.
   */
  async release(id: string, actor: string, only?: string[]): Promise<{ entities: number; relations: number }> {
    const from = this.require(id)
    if (from.class !== 'pusher') throw new SourceError('only a pusher hands its entities to people')
    return this.db.tx(async (client) => {
      const now = new Date().toISOString()
      const owned = await client.query<{ blueprint: string; key: string; state: string; ui: Layers['ui']; pushed: Layers['pushed']; override: Layers['override'] }>(
        `SELECT blueprint, key, state, ui, pushed, override FROM entities WHERE owner = $1 AND state <> 'deleted' AND ($2::text[] IS NULL OR blueprint = ANY($2)) ORDER BY blueprint, key FOR UPDATE`,
        [id, only ?? null],
      )
      for (const row of owned.rows) {
        const ui = { ...row.ui }
        const pushed = { ...row.pushed }
        const override = { ...row.override }
        for (const [field, said] of Object.entries(row.pushed)) {
          if (said.source !== id) continue
          const over = override[field]
          // What showed is kept: the person's value where it stood over the source's, else the source's.
          ui[field] = over && equal(over.basis, said.value) ? { value: over.value, by: over.by, at: over.at } : { value: said.value, by: actor, at: now }
          delete pushed[field]
          delete override[field]
        }
        await client.query(`UPDATE entities SET owner = 'ui', scope = NULL, state = 'active', missing_since = NULL, missing_runs = 0, grace_until = NULL, ui = $3, pushed = $4, override = $5, updated_at = $6 WHERE blueprint = $1 AND key = $2`, [row.blueprint, row.key, JSON.stringify(ui), JSON.stringify(pushed), JSON.stringify(override), now])
        // No run sights what people keep, so one the source had stopped seeing would stay missing until it was deleted.
        if (row.state === 'missing') await record(client, 'entity.restored', row, 'ui', actor, { previous: 'missing', handedFrom: id })
      }
      const refs = owned.rows.map((r) => ({ blueprint: r.blueprint, key: r.key }))
      const keys = [refs.map((r) => r.blueprint), refs.map((r) => r.key)]
      // A link a person already made is kept once, as theirs.
      await client.query(
        `DELETE FROM relations r WHERE r.source = $1 AND r.layer = 'pushed' AND (r.blueprint, r.key) IN (SELECT * FROM unnest($2::text[], $3::text[]))
           AND EXISTS (SELECT 1 FROM relations m WHERE m.blueprint = r.blueprint AND m.key = r.key AND m.relation = r.relation AND m.layer = 'ui'
             AND m.target_blueprint = r.target_blueprint AND m.target_key = r.target_key)`,
        [id, ...keys],
      )
      const relations = await client.query(`UPDATE relations r SET layer = 'ui', source = $4, at = $5 WHERE r.source = $1 AND r.layer = 'pushed' AND (r.blueprint, r.key) IN (SELECT * FROM unnest($2::text[], $3::text[]))`, [id, ...keys, actor, now])
      await this.queue.enqueue(client, refs)
      await this.queue.enqueueReaders(client, owned.rows.filter((r) => r.state === 'missing'))
      const counts = { entities: refs.length, relations: relations.rowCount ?? 0 }
      if (counts.entities) await record(client, 'source.changed', null, id, actor, { handedTo: 'ui', blueprints: only ?? null, ...counts })
      this.log.info('source handed its entities to people', { source: id, actor, blueprints: only ?? null, ...counts })
      return counts
    })
  }

  /**
   * Gives a pusher entities a person made in the web app, named one by one,
   * for when a source starts to push what people typed in first. The pusher
   * takes the ownership, so its writes land on them where access is decided
   * from them, and with a scope they move into the scope it snapshots. What
   * people set on them stays, in their own layer. An entity a source owns is
   * refused, and so is a blueprint the pusher is not registered for.
   */
  async adopt(to: string, refs: { blueprint: string; key: string }[], scope?: string): Promise<{ entities: number }> {
    const receiver = this.require(to)
    if (receiver.class !== 'pusher') throw new SourceError('only a pusher takes over entities people made')
    const refused = [...new Set(refs.map((r) => r.blueprint))].filter((b) => !receiver.blueprints.includes('*') && !receiver.blueprints.includes(b))
    if (refused.length) throw new SourceError(`source "${to}" is not registered for ${refused.join(', ')}`, 409)
    return this.db.tx(async (client) => {
      const found = await client.query<{ blueprint: string; key: string; owner: string }>(
        `SELECT blueprint, key, owner FROM entities WHERE (blueprint, key) IN (SELECT * FROM unnest($1::text[], $2::text[])) AND state <> 'deleted'`,
        [refs.map((r) => r.blueprint), refs.map((r) => r.key)],
      )
      const missing = refs.filter((r) => !found.rows.some((f) => f.blueprint === r.blueprint && f.key === r.key))
      if (missing.length) throw new SourceError(`no such entity: ${missing.map((r) => `${r.blueprint}:${r.key}`).join(', ')}`, 404)
      const sourced = found.rows.filter((f) => f.owner !== 'ui')
      if (sourced.length) throw new SourceError(`a source owns ${sourced.map((f) => `${f.blueprint}:${f.key} (${f.owner})`).join(', ')}; hand that source's entities over instead`, 409)
      const moved = await client.query(
        `UPDATE entities SET owner = $3, scope = COALESCE($4, scope) WHERE (blueprint, key) IN (SELECT * FROM unnest($1::text[], $2::text[])) AND owner = 'ui' AND state <> 'deleted'`,
        [refs.map((r) => r.blueprint), refs.map((r) => r.key), to, scope ?? null],
      )
      await this.queue.enqueue(client, refs)
      const counts = { entities: moved.rowCount ?? 0 }
      const named = refs.map((r) => `${r.blueprint}:${r.key}`)
      if (counts.entities) await record(client, 'source.changed', null, to, null, { adopted: named, scope: scope ?? null, count: counts.entities })
      this.log.info('source took over entities people made', { source: to, scope: scope ?? null, adopted: named, count: counts.entities })
      return counts
    })
  }

  gitToken(id: string): string | null {
    const sealed = this.cache.get(id)?.git_token
    return sealed ? this.secrets.open(sealed) : null
  }

  /**
   * Notes what a source just did. What the hub answers with is always
   * current; a patch that only says the source was seen is stored at most
   * once a minute, and anything else at once.
   */
  async touch(id: string, patch: { seen?: Date; run?: Date; error?: string | null; status?: StatusLevel; reason?: string | null; width?: number }): Promise<void> {
    const row = this.cache.get(id)
    if (!row) return
    // A runner says its width on every claim; only a new one is stored.
    const widened = patch.width !== undefined && patch.width !== row.width
    if (widened) row.width = patch.width!
    const seenOnly = !patch.run && patch.error === undefined && !patch.status && !widened
    const now = Date.now()
    if (seenOnly && now - (this.seenStored.get(id) ?? 0) < SEEN_EVERY) {
      if (patch.seen) row.last_seen_at = patch.seen
      return
    }
    this.seenStored.set(id, now)
    if (patch.seen) row.last_seen_at = patch.seen
    if (patch.run) row.last_run_at = patch.run
    if (patch.error !== undefined) row.last_error = patch.error
    if (patch.status) {
      row.status = patch.status
      row.status_reason = patch.reason ?? null
    }
    await this.db.query('UPDATE sources SET last_seen_at = $2, last_run_at = $3, last_error = $4, status = $5, status_reason = $6, width = $7 WHERE id = $1', [id, row.last_seen_at, row.last_run_at, row.last_error, row.status, row.status_reason, row.width])
  }

  /** Grace for entities this source owns: the source's own policy, else the blueprint's, else the default. */
  grace(id: string): GracePolicy | undefined {
    return this.cache.get(id)?.spec.grace
  }

  private toSource(row: SourceRow): Source {
    const { level, reason } = this.effectiveStatus(row)
    return {
      id: row.id,
      title: row.spec.title,
      class: row.spec.class,
      description: row.spec.description,
      blueprints: row.spec.blueprints,
      deleteGrant: row.spec.deleteGrant,
      cadence: row.spec.cadence,
      grace: row.spec.grace,
      history: row.spec.history,
      actsFor: row.spec.actsFor ?? null,
      actions: row.spec.actions ?? false,
      scorecards: row.spec.scorecards ?? false,
      watches: row.spec.watches ?? false,
      ...(row.spec.serves ? { serves: row.spec.serves } : {}),
      ...(row.width !== null && row.width !== undefined ? { width: row.width } : {}),
      writes: this.writes.of(row.id),
      git: row.spec.git ? { ...row.spec.git, hasToken: !!row.git_token } : undefined,
      createdAt: row.created_at.toISOString(),
      lastSeenAt: row.last_seen_at?.toISOString() ?? null,
      lastRunAt: row.last_run_at?.toISOString() ?? null,
      lastError: row.last_error,
      status: level,
      statusReason: reason,
    }
  }

  /**
   * A source is judged only by what it promised. One with a cadence is grey
   * once it is silent past twice that, or has never reported. One with none
   * writes when something happens (a person deciding, an apply, a run of an
   * action whose record it is) and is never grey for being quiet
   * (ADR-6002). Stale wins over everything; otherwise the last run decides.
   */
  private effectiveStatus(row: SourceRow): { level: StatusLevel; reason: string | null } {
    if (row.spec.class === 'ui' || row.spec.class === 'hub') return { level: 'green', reason: null }
    if (row.spec.cadence) {
      const last = [row.last_seen_at, row.last_run_at].filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0]
      const limit = parseDuration(row.spec.cadence) * 2
      if (!last) return { level: 'grey', reason: 'never reported' }
      const age = Date.now() - last.getTime()
      if (age > limit) return { level: 'grey', reason: `stale: last seen ${last.toISOString()}, expected every ${row.spec.cadence}` }
    }
    if (row.last_error) return { level: 'red', reason: `last run failed: ${row.last_error}` }
    return { level: row.status === 'grey' ? 'green' : row.status, reason: row.status_reason }
  }

  // Tokens -------------------------------------------------------------------

  /**
   * `role` is the id of the role an access token is bound to; the caller has
   * checked that it exists. A personal token belongs to `owner`, a person's
   * address, and acts as that person.
   */
  async issueToken(kind: TokenKind, name: string, opts: { role?: string; source?: string; owner?: string }): Promise<TokenIssued> {
    if (kind === 'source' && !opts.source) throw new SourceError('a source token needs a source')
    if (kind === 'source' && !this.cache.has(opts.source!)) throw new SourceError(`Unknown source "${opts.source}"`, 404)
    if (kind === 'access' && !opts.role) throw new SourceError('an access token needs a role')
    if (kind === 'personal' && !opts.owner) throw new SourceError('a personal token needs the person it belongs to')
    const id = randomBytes(6).toString('hex')
    const token = newToken(kind)
    await this.db.query('INSERT INTO tokens (id, kind, name, hash, role, source, owner) VALUES ($1,$2,$3,$4,$5,$6,$7)', [id, kind, name, hashToken(token), opts.role ?? null, opts.source ?? null, opts.owner ?? null])
    this.log.info('token issued', { id, kind, name, role: opts.role, source: opts.source, owner: opts.owner })
    return { id, name, kind, token }
  }

  /** Every token, or only the personal ones of one person. */
  async listTokens(owner?: string): Promise<TokenSummary[]> {
    const rows = owner ? await this.db.query<TokenRow>('SELECT * FROM tokens WHERE owner = $1 ORDER BY created_at', [owner]) : await this.db.query<TokenRow>('SELECT * FROM tokens ORDER BY created_at')
    return rows.rows.map(toSummary)
  }

  /** With `owner`, only a token that person holds is revoked. */
  async revokeToken(id: string, owner?: string): Promise<{ name: string; kind: TokenKind }> {
    const res = owner ? await this.db.query<{ name: string; kind: TokenKind }>('DELETE FROM tokens WHERE id = $1 AND owner = $2 RETURNING name, kind', [id, owner]) : await this.db.query<{ name: string; kind: TokenKind }>('DELETE FROM tokens WHERE id = $1 RETURNING name, kind', [id])
    if (!res.rowCount) throw new SourceError(`Unknown token "${id}"`, 404)
    this.log.info('token revoked', { id, owner })
    return res.rows[0]!
  }

  /** A new secret for a token a person holds. The old one stops working at once. */
  async rotateToken(id: string, owner: string): Promise<TokenIssued> {
    const token = newToken('personal')
    const res = await this.db.query<{ name: string }>(`UPDATE tokens SET hash = $3, last_used_at = NULL WHERE id = $1 AND owner = $2 AND kind = 'personal' RETURNING name`, [id, owner, hashToken(token)])
    if (!res.rowCount) throw new SourceError(`Unknown token "${id}"`, 404)
    this.log.info('token rotated', { id, owner })
    return { id, name: res.rows[0]!.name, kind: 'personal', token }
  }

  /** A person's tokens go with them. */
  async revokeOwnedBy(owner: string): Promise<number> {
    const res = await this.db.query('DELETE FROM tokens WHERE owner = $1', [owner])
    if (res.rowCount) this.log.info('personal tokens revoked with their person', { owner, count: res.rowCount })
    return res.rowCount ?? 0
  }

  /** The token a secret belongs to. When it was last used is stored at most once a minute. */
  async authenticate(token: string): Promise<TokenSummary | null> {
    const r = (await this.db.query<TokenRow>('SELECT * FROM tokens WHERE hash = $1', [hashToken(token)])).rows[0]
    if (!r) return null
    if (!r.last_used_at || Date.now() - r.last_used_at.getTime() >= SEEN_EVERY) {
      r.last_used_at = new Date()
      await this.db.query('UPDATE tokens SET last_used_at = $2 WHERE id = $1', [r.id, r.last_used_at])
    }
    return toSummary(r)
  }
}

type TokenKind = TokenSummary['kind']

interface TokenRow {
  id: string
  kind: TokenKind
  name: string
  role: string | null
  source: string | null
  owner: string | null
  created_at: Date
  last_used_at: Date | null
}

function toSummary(r: TokenRow): TokenSummary {
  return { id: r.id, kind: r.kind, name: r.name, role: r.role, source: r.source, owner: r.owner, createdAt: r.created_at.toISOString(), lastUsedAt: r.last_used_at?.toISOString() ?? null }
}

const PREFIX: Record<TokenKind, string> = { source: 'src', access: 'acc', personal: 'usr' }

function newToken(kind: TokenKind): string {
  return `orr_${PREFIX[kind]}_${randomBytes(24).toString('base64url')}`
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function isSourceClass(value: string): value is SourceClass {
  return (SOURCE_CLASSES as readonly string[]).includes(value)
}
