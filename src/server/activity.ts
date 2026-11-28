// The activity log: one row for everything that changes the estate, the model,
// or who may do what. Every row is written here and nowhere else.

import { AsyncLocalStorage } from 'node:async_hooks'
import { ACTIVITY_CATEGORIES, ACTOR_KINDS, OUTCOMES, categoryOf, type ActivityCategory, type ActorKind, type Change, type EntityRef, type Outcome } from '../shared/model.ts'
import { afterCommit, type Db } from './db.ts'
import type { Logger } from './log.ts'
import { recordRefusal, type Refusal } from './metrics.ts'
import { sendChanges } from './telemetry.ts'

/** The reason a refusal is counted under, from what the refusing route wrote about it. */
function refusalOf(detail: Record<string, unknown>): Refusal {
  if ('viewAs' in detail) return 'view_as'
  if ('action' in detail) return 'action_rule'
  return 'permission'
}

/** Who a request acts as. */
export interface Who {
  kind: ActorKind
  name: string
  /** The door the request came through when it was an agent's tool, so a row says a change was an agent's. */
  door?: 'mcp'
  /** The agent asking with its person's token (ORY-2002): the row is the person's, and says the agent asked. */
  agent?: string
}

const acting = new AsyncLocalStorage<Who>()

/** Runs `fn` as an actor: every row recorded inside it, however deep, is theirs. */
export function actingAs<T>(who: Who, fn: () => T): T {
  return acting.run(who, fn)
}

/**
 * Writes one row. A person or an access token acting right now is the actor,
 * whatever the caller names. Otherwise a source that is not the web app is,
 * and with neither it is the hub itself: what it does at start and on its
 * timers.
 */
export async function record(
  client: Queryable,
  kind: string,
  ref: Partial<EntityRef> | null,
  source: string | null,
  actor: string | null,
  detail: Record<string, unknown>,
  at: Date = new Date(),
  outcome: Outcome = 'ok',
): Promise<void> {
  const r = recorded(kind, ref, source, actor, detail, at, outcome)
  if (kind === 'access.refused') recordRefusal(refusalOf(detail))
  await client.query('INSERT INTO changes (at, kind, category, outcome, blueprint, key, source, actor, actor_kind, detail) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [r.at, r.kind, r.category, r.outcome, r.blueprint, r.key, r.source, r.actor, r.actorKind, r.detail])
  afterCommit(client, () => sendChanges([{ ...r, detail: r.facts }]))
}

type Queryable = { query: (text: string, params: unknown[]) => Promise<unknown> }

interface Recorded {
  at: Date
  kind: string
  category: ActivityCategory
  outcome: Outcome
  blueprint: string | null
  key: string | null
  source: string | null
  actor: string | null
  actorKind: ActorKind
  detail: string
  /** The detail before it is written as JSON, for the usage event the row is sent as. */
  facts: Record<string, unknown>
}

function recorded(kind: string, ref: Partial<EntityRef> | null, source: string | null, actor: string | null, detail: Record<string, unknown>, at: Date, outcome: Outcome): Recorded {
  const who = acting.getStore()
  if (who?.door) detail = { ...detail, door: who.door }
  if (who?.agent) detail = { ...detail, agent: who.agent }
  const person = who && who.kind !== 'source' ? who : null
  const from = source ?? (who?.kind === 'source' ? who.name : null)
  const actorKind: ActorKind = person ? person.kind : from && from !== 'ui' ? 'source' : 'hub'
  return { at, kind, category: categoryOf(kind), outcome, blueprint: ref?.blueprint ?? null, key: ref?.key ?? null, source: from, actor: person?.name ?? actor, actorKind, detail: JSON.stringify(detail), facts: detail }
}

/**
 * Rows held to be written together, in the order they were added: a batch
 * that changes many entities writes its rows in one statement. The actor is
 * read when a row is added, as `record` reads it.
 */
export class Recording {
  private rows: Recorded[] = []

  add(kind: string, ref: Partial<EntityRef> | null, source: string | null, actor: string | null, detail: Record<string, unknown>, at: Date = new Date(), outcome: Outcome = 'ok'): void {
    this.rows.push(recorded(kind, ref, source, actor, detail, at, outcome))
  }

  async flush(client: Queryable): Promise<void> {
    const rows = this.rows
    if (!rows.length) return
    this.rows = []
    const col = <K extends keyof Recorded>(k: K) => rows.map((r) => r[k])
    await client.query(
      `INSERT INTO changes (at, kind, category, outcome, blueprint, key, source, actor, actor_kind, detail)
       SELECT at, kind, category, outcome, blueprint, key, source, actor, actor_kind, detail::jsonb
       FROM unnest($1::timestamptz[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::text[]) WITH ORDINALITY
         AS r(at, kind, category, outcome, blueprint, key, source, actor, actor_kind, detail, n)
       ORDER BY n`,
      [col('at'), col('kind'), col('category'), col('outcome'), col('blueprint'), col('key'), col('source'), col('actor'), col('actorKind'), col('detail')],
    )
    afterCommit(client, () => sendChanges(rows.map((r) => ({ ...r, detail: r.facts }))))
  }
}

/** The row that stands for a whole batch in a log that folds batches. */
export const BATCH_ROW = 'action.batched'

export interface ActivityQuery {
  since?: string
  until?: string
  /** Rows older than this id, for the next page. */
  before?: string
  blueprint?: string
  key?: string
  kind?: string
  source?: string
  actor?: string
  /** Comma separated; each list narrows to its members. */
  actorKind?: string
  category?: string
  outcome?: string
  /** Only the rows of this batch: its asking, each run's end, retries, cancels. */
  batch?: string
  /** `batches`: a batch is one row, the one that asked it; the rest of its rows are read with `batch`. */
  fold?: string
  limit?: string | number
}

type Row = Omit<Change, 'id' | 'at' | 'actorKind'> & { id: string; at: Date; actor_kind: ActorKind }

/** Newest first. An unknown value in a list matches nothing rather than everything. */
export async function listActivity(db: Db, q: ActivityQuery, max = 1000): Promise<Change[]> {
  const params: unknown[] = []
  const where: string[] = []
  const add = (sql: string, value: unknown) => {
    params.push(value)
    where.push(sql.replace('?', `$${params.length}`))
  }
  const oneOf = <T extends string>(text: string | undefined, known: readonly T[], column: string) => {
    if (!text) return
    add(`${column} = ANY(?)`, text.split(',').filter((v): v is T => (known as readonly string[]).includes(v)))
  }
  if (q.since) add('at > ?', new Date(q.since))
  if (q.until) add('at <= ?', new Date(q.until))
  if (q.before && Number.isFinite(Number(q.before))) add('id < ?', Number(q.before))
  if (q.blueprint) add('blueprint = ?', q.blueprint)
  if (q.key) add('key = ?', q.key)
  if (q.kind) add('kind = ANY(?)', q.kind.split(','))
  if (q.source) add('source = ?', q.source)
  if (q.actor) add(`actor ILIKE ?`, `%${q.actor.replace(/[%_\\]/g, '\\$&')}%`)
  oneOf<ActorKind>(q.actorKind, ACTOR_KINDS, 'actor_kind')
  oneOf<ActivityCategory>(q.category, ACTIVITY_CATEGORIES, 'category')
  oneOf<Outcome>(q.outcome, OUTCOMES, 'outcome')
  if (q.batch) add(`detail->>'batch' = ?`, q.batch)
  // The row that first asked the batch stands for it; asking it again is one of its rows.
  else if (q.fold === 'batches') add(`(detail->>'batch' IS NULL OR (kind = ? AND detail->>'again' IS NULL))`, BATCH_ROW)
  params.push(Math.min(Number(q.limit ?? 100) || 100, max))
  const rows = await db.query<Row>(`SELECT * FROM changes ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT $${params.length}`, params)
  return rows.rows.map(({ actor_kind, ...r }) => ({ ...r, id: Number(r.id), at: r.at.toISOString(), actorKind: actor_kind }))
}

/** Removes rows older than the retention. */
export async function pruneActivity(db: Db, days: number, log: Logger): Promise<number> {
  const cutoff = new Date(Date.now() - days * 86_400_000)
  const gone = await db.query('DELETE FROM changes WHERE at < $1', [cutoff])
  if (gone.rowCount) log.info('activity pruned', { count: gone.rowCount, olderThan: cutoff })
  return gone.rowCount ?? 0
}
