// How the values of each field a grid may count under it (`SPREAD_TYPES`)
// spread over its blueprint's rows: how many rows hold one, how many values
// they hold, how many are different, and how many the widest buckets of a
// grid's spread hold. A list counts each of its values, as the spread does.
// The leader measures a blueprint on the lifecycle tick when its last measure
// is old, and replaces what it kept of it; the Load page reads the table.

import type { LoadColumn } from '../shared/api.ts'
import { isSpread, maySpread, type Blueprint } from '../shared/model.ts'
import type { Blueprints } from './blueprints.ts'
import type { Db } from './db.ts'
import type { Logger } from './log.ts'
import { timed } from './metrics.ts'
import { BUCKETS } from './query.ts'

/** How old a blueprint's measure may grow before it is measured again. How values spread moves slowly. */
export const MEASURE_EVERY_MS = 6 * 3_600_000

/** The fields of a blueprint a grid may count. */
export const countable = (bp: Blueprint): string[] =>
  Object.entries(bp.fields)
    .filter(([, def]) => maySpread(def.type))
    .map(([name]) => name)
    .sort()

export class Cardinality {
  private readonly db: Db
  private readonly blueprints: Pick<Blueprints, 'list' | 'get'>
  private readonly log: Logger

  constructor(db: Db, blueprints: Pick<Blueprints, 'list' | 'get'>, log: Logger) {
    this.db = db
    this.blueprints = blueprints
    this.log = log
  }

  /**
   * Measures every blueprint whose measure is older than `every`, or that has
   * a field a grid may count and was not measured yet, and lets go of what was kept
   * of a field or a blueprint that is gone.
   */
  async measure(every = MEASURE_EVERY_MS): Promise<void> {
    await timed('columns.measure', async () => {
      const wanted = new Map(this.blueprints.list().map((bp) => [bp.id, countable(bp)] as const).filter(([, fields]) => fields.length))
      const kept = await this.db.query<{ blueprint: string; fields: string[]; at: Date }>('SELECT blueprint, array_agg(field) AS fields, min(measured_at) AS at FROM column_profiles GROUP BY blueprint')
      const keptOf = new Map(kept.rows.map((r) => [r.blueprint, r]))
      const gone = await this.db.query(
        `DELETE FROM column_profiles c WHERE NOT EXISTS (SELECT 1 FROM unnest($1::text[], $2::text[]) AS w(blueprint, field) WHERE w.blueprint = c.blueprint AND w.field = c.field)`,
        [[...wanted].flatMap(([id, fields]) => fields.map(() => id)), [...wanted].flatMap(([, fields]) => fields)],
      )
      if (gone.rowCount) this.log.info('column measures let go: their fields are gone', { rows: gone.rowCount })
      for (const [id, fields] of wanted) {
        const had = keptOf.get(id)
        const fresh = had && Date.now() - had.at.getTime() < every && fields.every((f) => had.fields.includes(f))
        if (fresh) continue
        await this.measureOne(id, fields)
      }
    })
  }

  /** Measures one blueprint's fields a grid may count over its active and missing rows that are not hidden, as a grid opens on them, and replaces what was kept of it. */
  private async measureOne(blueprint: string, fields: string[]): Promise<void> {
    const began = performance.now()
    // Each row's fields are unpacked once, in a step of its own, and every field reads the unpacked value.
    const rows = (each = '') => `FROM entities e JOIN derived d ON d.blueprint = e.blueprint AND d.key = e.key
      CROSS JOIN LATERAL (SELECT d.fields || '{}'::jsonb AS fields OFFSET 0) u ${each}
      WHERE e.blueprint = $1 AND e.state IN ('active', 'missing') AND NOT e.hidden`
    const [total, spread] = await Promise.all([
      this.db.query<{ n: string }>(`SELECT count(*)::text AS n ${rows()}`, [blueprint]),
      this.db.query<{ field: string; held: string; different: string; top: string }>(
        `SELECT field, sum(n)::text AS held, count(*)::text AS different, coalesce(sum(n) FILTER (WHERE place <= $3), 0)::text AS top
         FROM (SELECT field, n, row_number() OVER (PARTITION BY field ORDER BY n DESC) AS place
               FROM (SELECT f.name AS field, a.v, count(*) AS n
                     ${rows(`CROSS JOIN unnest($2::text[]) AS f(name)
                       CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(u.fields->f.name) = 'array' THEN u.fields->f.name ELSE jsonb_build_array(u.fields->f.name) END) AS a(v)`)}
                       AND jsonb_typeof(a.v) IN ('string', 'number', 'boolean') AND a.v <> '""'::jsonb
                     GROUP BY 1, 2) c) r
         GROUP BY field`,
        [blueprint, fields, BUCKETS],
      ),
    ])
    const of = new Map(spread.rows.map((r) => [r.field, r]))
    const n = Number(total.rows[0]?.n ?? 0)
    await this.db.tx(async (tx) => {
      await tx.query('DELETE FROM column_profiles WHERE blueprint = $1', [blueprint])
      await tx.query(
        `INSERT INTO column_profiles (blueprint, field, rows, values_held, different, top_held, measured_at)
         SELECT $1, f, $2, h, d, t, now() FROM unnest($3::text[], $4::bigint[], $5::bigint[], $6::bigint[]) AS x(f, h, d, t)`,
        [blueprint, n, fields, fields.map((f) => Number(of.get(f)?.held ?? 0)), fields.map((f) => Number(of.get(f)?.different ?? 0)), fields.map((f) => Number(of.get(f)?.top ?? 0))],
      )
    })
    this.log.info('columns measured', { blueprint, fields: fields.length, rows: n, ms: Math.round(performance.now() - began) })
  }

  /** What was measured of every field the model still holds that a grid may count, beside whether it counts it now. */
  async read(): Promise<LoadColumn[]> {
    const res = await this.db.query<{ blueprint: string; field: string; rows: string; values_held: string; different: string; top_held: string; measured_at: Date }>(
      'SELECT blueprint, field, rows::text, values_held::text, different::text, top_held::text, measured_at FROM column_profiles ORDER BY blueprint, field',
    )
    return res.rows.flatMap((r) => {
      const def = this.blueprints.get(r.blueprint)?.fields[r.field]
      if (!def || !maySpread(def.type)) return []
      return [{ blueprint: r.blueprint, field: r.field, chip: !!def.chip, spread: isSpread(def), rows: Number(r.rows), values: Number(r.values_held), different: Number(r.different), top: Number(r.top_held), measuredAt: r.measured_at.toISOString() }]
    })
  }
}
