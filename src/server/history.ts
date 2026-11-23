// The history the hub keeps of a derived number or enum marked `history`, and
// the values it exports of a field marked `metric`. On each lifecycle tick it
// reads every such field through the read side, records a point for each
// entity whose value moved since its last one, and lets go of points older
// than the field's `keep`. A trend field reads the points back (`trendOf`).

import { isTrendHistory, parseDuration, TREND_POINTS, type Blueprint, type FieldDef, type TrendHistory, type TrendValue } from '../shared/model.ts'
import type { Db } from './db.ts'
import type { Events } from './events.ts'
import { NO_QUEUE, type Queue } from './derive.ts'
import type { Logger } from './log.ts'
import type { Reader } from './read.ts'
import { stable } from './values.ts'

/** One point of a field's history, oldest first wherever a list of them is read. */
export interface HistoryPoint {
  at: Date
  value: unknown
}

/** One entity's value of a field marked `metric`, as the gauge reports it. */
export interface FieldReading {
  blueprint: string
  field: string
  key: string
  value: number
}

/** The fields of a blueprint whose history the hub keeps, with how long. */
function keptFields(bp: Blueprint): { name: string; keep: number }[] {
  return Object.entries(bp.fields).flatMap(([name, def]) => (def.history && !isTrendHistory(def.history) ? [{ name, keep: parseDuration(def.history.keep) }] : []))
}

/** A value as a number on a chart or a gauge: a number as it is, an enum value as its place among the field's values. Null for anything else. */
export function numberOf(def: Pick<FieldDef, 'type' | 'values'>, value: unknown): number | null {
  if (def.type === 'number') return typeof value === 'number' && Number.isFinite(value) ? value : null
  if (def.type === 'enum' && typeof value === 'string') {
    const at = (def.values ?? []).indexOf(value)
    return at >= 0 ? at : null
  }
  return null
}

/** The end of the span of `every` that `now` lies in: the next line of the grid `every` lays from the epoch, strictly after `now`. */
export function spanEnd(now: number, every: number): number {
  return (Math.floor(now / every) + 1) * every
}

/**
 * A trend over one entity's history of a field: one point for each `every`
 * over the `last`, each the value held at the end of its span. The spans end
 * on the grid `every` lays from the epoch, the newest being the one under
 * way, which holds the value held now: so the trend reads the same all
 * through a span, and moves only as a point lands or a span ends. A span
 * that ends before the first point, or holds a value that is not a number or
 * a known enum value, has no point. Null when no span has one.
 */
export function trendOf(points: readonly HistoryPoint[], of: Pick<FieldDef, 'type' | 'values'>, history: TrendHistory, now: number): TrendValue | null {
  const every = parseDuration(history.every)
  const last = parseDuration(history.last)
  const spans = Math.min(TREND_POINTS, Math.ceil(last / every))
  const newest = spanEnd(now, every)
  const out: TrendValue['points'] = []
  let i = 0
  let held: unknown = undefined
  for (let k = spans - 1; k >= 0; k--) {
    const end = newest - k * every
    while (i < points.length && points[i]!.at.getTime() <= end) held = points[i++]!.value
    if (held === undefined) continue
    const value = numberOf(of, held)
    if (value !== null) out.push({ at: new Date(end).toISOString(), value })
  }
  if (!out.length) return null
  const window = { from: new Date(newest - last).toISOString(), to: new Date(newest).toISOString() }
  if (of.type !== 'enum') return { points: out, ...window }
  const values = of.values ?? []
  return { points: out, ...window, step: true, min: 0, max: Math.max(0, values.length - 1), labels: Object.fromEntries(values.map((v, at) => [String(at), v])) }
}

/**
 * The points a trend over `of` reads for `keys`: every one inside the window
 * that opens at `from`, and the newest one before it, which says what was
 * held when the window opened. By key, oldest first.
 */
export async function seriesFor(db: Db, blueprint: string, of: string, keys: string[], from: Date): Promise<Map<string, HistoryPoint[]>> {
  const out = new Map<string, HistoryPoint[]>()
  if (!keys.length) return out
  const rows = await db.query<{ key: string; at: Date; value: unknown }>(
    `(SELECT key, at, value FROM field_history WHERE blueprint = $1 AND field = $2 AND key = ANY($3) AND at > $4)
     UNION ALL
     (SELECT DISTINCT ON (key) key, at, value FROM field_history WHERE blueprint = $1 AND field = $2 AND key = ANY($3) AND at <= $4 ORDER BY key, at DESC)
     ORDER BY key, at`,
    [blueprint, of, keys, from],
  )
  for (const r of rows.rows) {
    let list = out.get(r.key)
    if (!list) out.set(r.key, (list = []))
    list.push({ at: r.at, value: r.value })
  }
  return out
}

export class FieldHistory {
  private readonly db: Db
  private readonly blueprints: { list(): Blueprint[] }
  private readonly reader: Reader
  private readonly events: Events
  private readonly log: Logger

  /** The deriver's queue: an entity that gained a point has its trends derived again. The hub wires it. */
  queue: Queue = NO_QUEUE

  constructor(db: Db, blueprints: { list(): Blueprint[] }, reader: Reader, events: Events, log: Logger) {
    this.db = db
    this.blueprints = blueprints
    this.reader = reader
    this.events = events
    this.log = log
  }

  /** Every entity of a blueprint the hub has not deleted, hidden or not, derived fields and all, from what the read side keeps. */
  private async entitiesOf(blueprint: string) {
    return (await this.reader.list({ blueprint, states: ['active', 'missing'], includeHidden: true, limit: Infinity })).entities
  }

  /** The kept fields' values of every active or missing entity of a blueprint, hidden or not, straight from the stored rows: no entity is built for a point. */
  private async valuesOf(blueprint: string, names: string[]): Promise<{ key: string; fields: Record<string, unknown> }[]> {
    const rows = await this.db.query<{ key: string; fields: Record<string, unknown> }>(
      `SELECT e.key, (SELECT coalesce(jsonb_object_agg(f.key, f.value), '{}'::jsonb) FROM jsonb_each(d.fields) f WHERE f.key = ANY($2::text[])) AS fields
       FROM entities e JOIN derived d ON d.blueprint = e.blueprint AND d.key = e.key WHERE e.blueprint = $1 AND e.state IN ('active', 'missing')`,
      [blueprint, names],
    )
    return rows.rows
  }

  /**
   * The lifecycle tick's part: a point for every entity whose value of a kept
   * field moved since its last point, then the points the fields no longer
   * keep. A blueprint that gained a point is named as moved, so only what
   * reads it is read again.
   */
  async record(now = new Date()): Promise<number> {
    const moved: string[] = []
    let recorded = 0
    const kept: string[] = []
    for (const bp of this.blueprints.list()) {
      const fields = keptFields(bp)
      if (!fields.length) continue
      const names = fields.map((f) => f.name)
      for (const name of names) kept.push(`${bp.id}\n${name}`)
      const entities = await this.valuesOf(bp.id, names)
      const last = await this.db.query<{ field: string; key: string; value: unknown }>(
        'SELECT DISTINCT ON (field, key) field, key, value FROM field_history WHERE blueprint = $1 AND field = ANY($2) ORDER BY field, key, at DESC',
        [bp.id, names],
      )
      const lastBy = new Map(last.rows.map((r) => [`${r.field}\n${r.key}`, stable(r.value)]))
      const keys: string[] = []
      const at: string[] = []
      const values: string[] = []
      for (const e of entities) {
        for (const name of names) {
          const value = e.fields[name] ?? null
          const was = lastBy.get(`${name}\n${e.key}`)
          // Nothing known yet is no point; once something was, a value gone is a point too.
          if (was === undefined ? value === null : was === stable(value)) continue
          keys.push(e.key)
          at.push(name)
          values.push(JSON.stringify(value))
        }
      }
      if (keys.length) {
        await this.db.query('INSERT INTO field_history (blueprint, key, field, at, value) SELECT $1, k, f, $2, v FROM unnest($3::text[], $4::text[], $5::jsonb[]) AS t(k, f, v) ON CONFLICT DO NOTHING', [bp.id, now, keys, at, values])
        recorded += keys.length
        moved.push(bp.id)
        // A trend read from this history moves with the point: derived now when few moved, by the leader's pass otherwise.
        if (Object.values(bp.fields).some((def) => isTrendHistory(def.history))) {
          const refs = [...new Set(keys)].map((key) => ({ blueprint: bp.id, key }))
          await this.queue.enqueue(this.db, refs)
          await this.queue.inline(refs)
        }
        this.log.info('field history recorded', { blueprint: bp.id, points: keys.length, entities: entities.length })
      } else {
        this.log.debug('field history unchanged', { blueprint: bp.id, entities: entities.length })
      }
      for (const { name, keep } of fields) {
        const cutoff = new Date(now.getTime() - keep)
        // The newest point at or before the cutoff stays: it is the value held when the window opens.
        const gone = await this.db.query(
          `DELETE FROM field_history h WHERE h.blueprint = $1 AND h.field = $2 AND h.at < $3
             AND EXISTS (SELECT 1 FROM field_history n WHERE n.blueprint = h.blueprint AND n.field = h.field AND n.key = h.key AND n.at > h.at AND n.at <= $3)`,
          [bp.id, name, cutoff],
        )
        if (gone.rowCount) this.log.info('field history expired', { blueprint: bp.id, field: name, points: gone.rowCount, olderThan: cutoff })
      }
    }
    // A field that no longer keeps a history, of a blueprint or an entity that is gone, keeps none.
    const dropped = await this.db.query(
      `DELETE FROM field_history h WHERE NOT (h.blueprint || chr(10) || h.field = ANY($1))
         OR NOT EXISTS (SELECT 1 FROM entities e WHERE e.blueprint = h.blueprint AND e.key = h.key)`,
      [kept],
    )
    if (dropped.rowCount) this.log.info('field history dropped: its field keeps none, or its entity is gone', { points: dropped.rowCount })
    if (moved.length) this.events.emit({ type: 'estate', blueprints: moved })
    return recorded
  }

  /** Every entity's value of every field marked `metric`, in one pass over what the read side keeps. */
  async readings(): Promise<FieldReading[]> {
    const out: FieldReading[] = []
    for (const bp of this.blueprints.list()) {
      const fields = Object.entries(bp.fields).filter(([, def]) => def.metric && (def.type === 'number' || def.type === 'enum'))
      if (!fields.length) continue
      for (const e of await this.entitiesOf(bp.id)) {
        for (const [name, def] of fields) {
          const value = numberOf(def, e.fields[name])
          if (value !== null) out.push({ blueprint: bp.id, field: name, key: e.key, value })
        }
      }
    }
    return out
  }
}
