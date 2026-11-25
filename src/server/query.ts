// The read side in SQL. A list of entities is one statement over
// `entities JOIN derived`: the filter, the sort, the groups, and the
// distribution are worked out by Postgres from the stored derived rows, so a
// page costs what it shows however large the estate. Every leaf of `Filter`
// has one translation here, mirroring `matches` in `src/shared/filter.ts`
// leaf for leaf; `query.test.ts` holds the two equal. What the reader may not
// see never reaches a predicate: a hidden field is refused before any SQL,
// an owner-opened field reads only on the rows the reader owns, and a
// relation target in a blueprint the reader may not see never matches by its
// title.

import { ICON_NAMES, PHOTO_PREFIX } from '../shared/icons.ts'
import type { ColumnDistribution, GridGroup } from '../shared/api.ts'
import { parsePath, type Hop } from '../shared/filter.ts'
import { isSpread, parseDuration, SHARED_LIST_MAX, type Blueprint, type EntityState, type Filter } from '../shared/model.ts'
import type { Blueprints } from './blueprints.ts'
import type { Db } from './db.ts'
import type { HeadedRow, Only } from './read.ts'
import { headedOnly, JOIN } from './read.ts'
import type { View } from './visibility.ts'

/** What a query needs of the reader's view. */
export type Sight = Pick<View, 'seesBlueprint' | 'hiddenFields' | 'summaries' | 'openedTo' | 'oneByOne'>

const NONE: ReadonlySet<string> = new Set()
/** The sight of a reader nothing is withheld from. */
export const ALL: Sight = { seesBlueprint: () => true, hiddenFields: () => NONE, summaries: () => NONE, openedTo: () => [], oneByOne: () => null }

/** One grid's question, as SQL answers it. */
export interface ListParams {
  blueprint?: string
  states: EntityState[]
  includeHidden: boolean
  filter?: Filter
  /** `field` or `-field`. */
  sort?: string
  /** A grid column id (`$owner`, a field, `r:relation`) the rows are grouped by. */
  group?: string
  /**
   * The person whose stars come first, in every order and inside each group: a catalog grid's reader. A query, an
   * export, and a report never name one, so what they read is ordered the same for everyone.
   */
  starredBy?: string
  /** Only what `starredBy` starred: their favorites. */
  starredOnly?: boolean
}

/** Whether `person` starred the row. */
const STARRED = (person: string) => `EXISTS (SELECT 1 FROM stars s WHERE s.person = ${person} AND s.blueprint = e.blueprint AND s.key = e.key)`

/** One part of a list's order: what it orders by, and which way. */
interface OrderPart {
  expr: string
  desc?: boolean
  /** A number, sent as text so it keeps every digit. */
  numeric?: boolean
}

/** The values one row holds in each part of its list's order: where a page that starts after it begins. */
export type OrderValues = (string | boolean | null)[]

/** A cursor that cannot start a page of this list. */
export class CursorError extends Error {}

/** A column shows its most common values one by one, and the rest together. */
export const BUCKETS = 12

/** The label a grouped or counted target in a blueprint the reader may not see shows. */
/** The one group every object value falls in: its JSON prints differently in Node and in Postgres, so neither is the key. */
export const OBJECT_LABEL = '{…}'

/** The rank each relation layer wins by: higher wins, as `RELATION_LAYERS` in read.ts. */
const LAYER_RANK = `CASE layer WHEN 'git' THEN 5 WHEN 'ui' THEN 4 WHEN 'pushed' THEN 3 WHEN 'rule' THEN 2 ELSE 1 END`

/** The text of a scalar JSON value as `searchTexts` and `String()` give it. */
const TEXT = (x: string) => `(CASE WHEN jsonb_typeof(${x}) = 'string' THEN ${x} #>> '{}' ELSE ${x}::text END)`

/** Whether a JSON value takes part in an order or a comparison: `orderable` in filter.ts. */
const ORDERABLE = (x: string) => `(${x} IS NOT NULL AND jsonb_typeof(${x}) IN ('number', 'string', 'boolean'))`

/** An ISO timestamp the way `toISOString` prints one, for the time columns a filter may read by their bare name. */
/** When an entity was last seen, as `seenAt` in `runs.ts` says it: an active one at the later of its own row and its scope's last snapshot. */
const SEEN = `CASE WHEN e.state = 'active' THEN GREATEST(e.last_seen_at, (SELECT s.seen_at FROM scope_seen s WHERE s.source = e.owner AND s.scope = e.scope)) ELSE e.last_seen_at END`

const ISO = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`

/**
 * Collects the parameters of one statement. A builder may add one that the
 * statement ends up not reading (a branch not taken); `finish` drops those
 * and renumbers the rest, since Postgres cannot type a parameter nothing
 * reads.
 */
class Params {
  private readonly values: unknown[] = []
  add(value: unknown): string {
    this.values.push(value)
    return `$${this.values.length}`
  }

  /** The statement with only the parameters it reads, numbered in order of first use. */
  finish(sql: string): { sql: string; values: unknown[] } {
    const used = new Map<number, number>()
    const values: unknown[] = []
    const renumbered = sql.replace(/\$(\d+)(?!\d)/g, (_, n: string) => {
      const at = Number(n)
      let next = used.get(at)
      if (next === undefined) {
        values.push(this.values[at - 1])
        used.set(at, (next = values.length))
      }
      return `$${next}`
    })
    return { sql: renumbered, values }
  }
}

/** The LIKE pattern that finds `q` anywhere, with LIKE's own characters escaped. */
function likeAnywhere(q: string): string {
  return `%${q.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`
}

export class Query {
  private readonly db: Db
  private readonly blueprints: Blueprints
  private readonly icons: { has(name: string): boolean; names(): string[] }

  constructor(db: Db, blueprints: Blueprints, icons: { has(name: string): boolean; names(): string[] }) {
    this.db = db
    this.blueprints = blueprints
    this.icons = icons
  }

  /**
   * The rows a question matches, in its order, one page of them, with how
   * many there are in all. A page starts `offset` rows in, or right after the
   * row whose order values are `after`, which reads none of the rows before
   * it. `next` is the order values of the page's last row when more follow.
   */
  async rows(p: ListParams, view: Sight, page: { limit: number; offset: number; after?: OrderValues | null; only?: Only }): Promise<{ rows: HeadedRow[]; total: number; next: OrderValues | null }> {
    const counting = new Params()
    const count = counting.finish(`SELECT count(*)::text AS n ${JOIN} WHERE ${this.where(p, view, counting)}`)
    const [listed, total] = await Promise.all([page.limit === 0 ? Promise.resolve({ rows: [], next: null }) : this.page(p, view, page), this.db.query<{ n: string }>(count.sql, count.values)])
    return { ...listed, total: Number(total.rows[0]!.n) }
  }

  /** One page of the rows a question matches, in its order, without counting them all: a block of a listing that holds the count. `only` cuts what each row carries. */
  async page(p: ListParams, view: Sight, page: { limit: number; offset: number; after?: OrderValues | null; only?: Only }): Promise<{ rows: HeadedRow[]; next: OrderValues | null }> {
    const q = new Params()
    const where = this.where(p, view, q)
    const parts = this.orderParts(p, view, q)
    const order = parts.map((o) => (o.desc ? `${o.expr} DESC` : o.expr)).join(', ')
    const after = page.after ? ` AND ${this.after(parts, page.after, q)}` : ''
    // One row past the page says whether more follow; it is never given.
    const finite = Number.isFinite(page.limit)
    const limit = finite ? ` LIMIT ${q.add(page.limit + 1)}` : ''
    const offset = page.offset && !page.after ? ` OFFSET ${q.add(page.offset)}` : ''
    // Numbers go as text, so a value too precise for JSON comes back exactly.
    const values = `jsonb_build_array(${parts.map((o) => (o.numeric ? `(${o.expr})::text` : o.expr)).join(', ')}) AS order_values`
    // The page is found from the keys alone, then read whole: built for every row the question matches, the stored
    // values (a kilobyte a row) are what the sort carries and spills to disk, and all but the page are thrown away.
    const found = `SELECT e.blueprint, e.key, ${values}, row_number() OVER (ORDER BY ${order}) AS place ${JOIN} WHERE ${where}${after} ORDER BY ${order}${limit}${offset}`
    const listing = q.finish(`SELECT ${headedOnly(page.only, (v) => q.add(v))}, p.order_values FROM (${found}) p JOIN entities e ON e.blueprint = p.blueprint AND e.key = p.key LEFT JOIN derived d ON d.blueprint = e.blueprint AND d.key = e.key ORDER BY p.place`)
    const listed = await this.db.query<HeadedRow & { order_values?: OrderValues }>(listing.sql, listing.values)
    const more = finite && listed.rows.length > page.limit
    const rows = more ? listed.rows.slice(0, page.limit) : listed.rows
    const next = more ? (rows.at(-1)?.order_values ?? null) : null
    for (const r of rows) delete r.order_values
    return { rows, next }
  }

  /**
   * The rows after one in the order: past it in the first part they differ
   * in. Where two rows tie on every part before, those parts are both unset
   * or both set, since each part before says which kind of value follows.
   */
  private after(parts: OrderPart[], values: OrderValues, q: Params): string {
    if (values.length !== parts.length) throw new CursorError('the cursor does not fit this order')
    const past = parts.map((part, i) => {
      const tied = parts.slice(0, i).map((o, j) => `${o.expr} IS NOT DISTINCT FROM ${q.add(values[j])}`)
      return `(${[...tied, `${part.expr} ${part.desc ? '<' : '>'} ${q.add(values[i])}`].join(' AND ')})`
    })
    return `(${past.join(' OR ')})`
  }

  /** The references the question matches, in its order: what a bulk change reaches. */
  async refs(p: ListParams, view: Sight): Promise<{ blueprint: string; key: string; owner: string; hidden: boolean }[]> {
    const q = new Params()
    const where = this.where(p, view, q)
    const order = this.orderBy(p, view, q)
    const { sql, values } = q.finish(`SELECT e.blueprint, e.key, e.owner, e.hidden ${JOIN} WHERE ${where} ORDER BY ${order}`)
    return (await this.db.query<{ blueprint: string; key: string; owner: string; hidden: boolean }>(sql, values)).rows
  }

  /** Every group among the rows the question matches, in order, where each starts and how many it holds. The rows themselves order by group first when `p.group` is set. */
  async groups(p: ListParams, view: Sight): Promise<GridGroup[]> {
    if (!p.group) return []
    const q = new Params()
    const where = this.where(p, view, q)
    const key = this.groupKey(p, view, q)
    const { sql, values } = q.finish(`SELECT ${key} AS key, count(*)::text AS n ${JOIN} WHERE ${where} GROUP BY 1 ORDER BY (${key} = '—'), ${key} COLLATE orrery_natural`)
    const res = await this.db.query<{ key: string; n: string }>(sql, values)
    let start = 0
    return res.rows.map((r) => {
      const g = { key: r.key, start, count: Number(r.n) }
      start += g.count
      return g
    })
  }

  /**
   * How the rows the question matches share out each column that holds a
   * few kinds of value, as `distribute` in read.ts counts them. One read of
   * the rows takes every column's value from each; a row that holds one
   * value in a column, as nearly every row does, is counted for every column
   * in one pass, and only the rows that hold several are opened up. The
   * database keeps the most common values of each column and adds up the
   * rest, so the answer is a few rows however many values a column has.
   * Values as common as each other make the cut in the order of their
   * labels' bytes, which sorts fastest; what is kept is shown in a
   * person's order. A column where a row holds more than `SHARED_LIST_MAX`
   * values is left out of the answer, and none of its lists are opened.
   */
  async distribution(p: ListParams, view: Sight): Promise<Record<string, ColumnDistribution>> {
    const bp = p.blueprint ? this.blueprints.get(p.blueprint) : undefined
    if (!bp) return {}
    const q = new Params()
    const where = this.where(p, view, q)
    // Each column's value on one row as JSON: `own` holds one value always, a field one or a list, a relation a list of targets.
    const columns: { id: string; raw: string; kind: 'own' | 'field' | 'relation' }[] = [
      { id: 'state', raw: 'to_jsonb(e.state)', kind: 'own' },
      { id: 'owner', raw: 'to_jsonb(e.owner)', kind: 'own' },
      { id: 'status', raw: `to_jsonb(coalesce(d.level, 'grey'))`, kind: 'own' },
    ]
    for (const [name, def] of Object.entries(bp.fields)) {
      if (!isSpread(def)) continue
      const v = this.fieldValue(name, bp, view, q)
      if (v) columns.push({ id: `f:${name}`, raw: v, kind: 'field' })
    }
    for (const [name, rel] of Object.entries(bp.relations)) {
      if (view.seesBlueprint(rel.target)) columns.push({ id: `r:${name}`, raw: `(d.relations->${q.add(name)}::text)`, kind: 'relation' })
    }
    // A stored row of any size is kept compressed, and each value read from `fields` would unpack all of it again:
    // seventeen microseconds a column a row. So each row's fields are unpacked once, in a step of its own the
    // planner does not fold away, and every column reads the unpacked value. The step sits after the join, on the row
    // the join found, so the join is planned as any other: a fence around the stored rows themselves was joined
    // by walking all of them for each entity while the tables were new and not yet measured.
    const unpacked = `FROM entities e LEFT JOIN derived dd ON dd.blueprint = e.blueprint AND dd.key = e.key
      CROSS JOIN LATERAL (SELECT dd.blueprint, dd.key, dd.level, dd.reasons, dd.levels, dd.icon, dd.search_all, dd.derived_at, dd.relations, dd.fields || '{}'::jsonb AS fields OFFSET 0) d`
    // A scalar counts once; a list once under each value it holds; null, unset, '', and an object not at all.
    const counts = (x: string) => `(jsonb_typeof(${x}) IN ('string', 'number', 'boolean') AND ${x} <> '""'::jsonb)`
    // `o` is the one value a row holds in a column, `m` its list when it holds several and one of them counts, and
    // `l` whether its list is too long to share out. A list that long is never read past its length.
    const picked = columns.flatMap((c, i) => {
      const x = `s.c${i}`
      if (c.kind === 'own') return [`${x} AS o${i}`]
      const list = `jsonb_typeof(${x}) = 'array'`
      const several = `${list} AND jsonb_array_length(${x}) BETWEEN 2 AND ${SHARED_LIST_MAX}`
      const long = `coalesce(${list} AND jsonb_array_length(${x}) > ${SHARED_LIST_MAX}, FALSE) AS l${i}`
      if (c.kind === 'relation') return [`CASE WHEN ${list} AND jsonb_array_length(${x}) = 1 THEN ${x}->0 END AS o${i}`, `CASE WHEN ${several} THEN ${x} END AS m${i}`, long]
      return [`CASE WHEN ${counts(x)} THEN ${x} WHEN ${list} AND jsonb_array_length(${x}) = 1 AND ${counts(`${x}->0`)} THEN ${x}->0 END AS o${i}`, `CASE WHEN ${several} THEN CASE WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(${x}) AS a(v) WHERE ${counts('a.v')}) THEN ${x} END END AS m${i}`, long]
    })
    // One pass counts every column's single values: a grouping set per column. GROUPING takes at most 31 columns, so they go thirty at a time.
    const single: string[] = []
    for (let from = 0; from < columns.length; from += 30) {
      const part = columns.slice(from, from + 30).map((_, j) => from + j)
      const names = part.map((i) => `o${i}`)
      const arms = part.map((i, j) => `WHEN ${2 ** part.length - 1 - 2 ** (part.length - 1 - j)} THEN ${i}`)
      single.push(`SELECT CASE GROUPING(${names.join(', ')}) ${arms.join(' ')} END AS col, coalesce(${names.join(', ')}) AS v, count(*) AS n FROM r GROUP BY GROUPING SETS (${names.map((n) => `(${n})`).join(', ')})`)
    }
    const lists = columns.flatMap((c, i) => (c.kind === 'own' ? [] : [{ i, relation: c.kind === 'relation' }]))
    const spread = `(VALUES ${lists.map((l) => `(${l.i}, r.m${l.i}, ${l.relation})`).join(', ')}) AS t(col, vs, rel)`
    const several = `(${lists.map((l) => `r.m${l.i} IS NOT NULL`).join(' OR ')})`
    const member = `(t.rel OR ${counts('a.v')})`
    // A list's values, each once per row; and how many rows hold a list, which the single pass counted as having no value.
    // The columns left out: one row anywhere among the matches holds a list too long to share out.
    const skipped = lists.length ? `SELECT t.col FROM (SELECT ${lists.map((l) => `bool_or(l${l.i}) AS l${l.i}`).join(', ')} FROM r) h CROSS JOIN LATERAL (VALUES ${lists.map((l) => `(${l.i}, h.l${l.i})`).join(', ')}) AS t(col, long) WHERE t.long` : `SELECT NULL::int AS col WHERE FALSE`
    const many = lists.length ? `SELECT t.col, x.v, count(*) AS n FROM r CROSS JOIN LATERAL ${spread} CROSS JOIN LATERAL (SELECT DISTINCT a.v FROM jsonb_array_elements(t.vs) AS a(v) WHERE ${member}) x WHERE ${several} AND t.vs IS NOT NULL AND t.col NOT IN (SELECT col FROM skipped) GROUP BY 1, 2` : `SELECT NULL::int AS col, NULL::jsonb AS v, 0::bigint AS n WHERE FALSE`
    const held = lists.length ? `SELECT t.col, t.n FROM (SELECT ${lists.map((l) => `count(m${l.i}) AS h${l.i}`).join(', ')} FROM r) h CROSS JOIN LATERAL (VALUES ${lists.map((l) => `(${l.i}, h.h${l.i})`).join(', ')}) AS t(col, n)` : `SELECT NULL::int AS col, 0::bigint AS n WHERE FALSE`
    const target = `jsonb_typeof(v) = 'object'`
    const { sql, values } = q.finish(
      `WITH r AS MATERIALIZED (SELECT ${picked.join(', ')} FROM (SELECT ${columns.map((c, i) => `${c.raw} AS c${i}`).join(', ')} ${unpacked} WHERE ${where} OFFSET 0) s),
            single AS MATERIALIZED (${single.join(' UNION ALL ')}),
            skipped AS MATERIALIZED (${skipped}),
            many AS MATERIALIZED (${many}),
            held AS (${held}),
            listed AS (SELECT DISTINCT col FROM many),
            counted AS (
              SELECT col, v, n FROM single WHERE v IS NOT NULL AND col NOT IN (SELECT col FROM listed)
              UNION ALL
              SELECT col, v, sum(n) AS n FROM (SELECT col, v, n FROM single WHERE v IS NOT NULL AND col IN (SELECT col FROM listed) UNION ALL SELECT col, v, n FROM many) u GROUP BY 1, 2),
            shown AS (
              SELECT col, n,
                CASE WHEN ${target} THEN (v->>'blueprint') || ':' || (v->>'key') ELSE ${TEXT('v')} END AS value,
                CASE WHEN ${target} THEN coalesce(v->>'title', v->>'key') WHEN jsonb_typeof(v) = 'boolean' THEN (CASE WHEN v = 'true'::jsonb THEN 'yes' ELSE 'no' END) ELSE ${TEXT('v')} END AS label
              FROM counted),
            ranked AS (SELECT col, value, label, n, row_number() OVER (PARTITION BY col ORDER BY n DESC, label COLLATE "C", value COLLATE "C") AS place, sum(n) OVER (PARTITION BY col) AS total FROM shown)
       SELECT col, value, label, n::text AS n, total::text AS total FROM ranked WHERE place <= ${q.add(BUCKETS)}
       UNION ALL
       SELECT s.col, NULL, NULL, (s.n - coalesce(m.n, 0))::text, NULL FROM single s LEFT JOIN held m ON m.col = s.col WHERE s.v IS NULL
       UNION ALL
       SELECT col, NULL, NULL, NULL, NULL FROM skipped`,
    )
    // A row with no count names a column that was left out.
    const res = await this.db.query<{ col: number; value: string | null; label: string | null; n: string | null; total: string | null }>(sql, values)
    const out: Record<string, ColumnDistribution> = {}
    for (const [i, c] of columns.entries()) {
      const mine = res.rows.filter((r) => r.col === i)
      if (mine.some((r) => r.n === null)) continue
      const buckets: ColumnDistribution['buckets'] = mine.filter((r) => r.value !== null).map((r) => ({ value: r.value, label: r.label!, count: Number(r.n) })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
      const all = Number(mine.find((r) => r.total !== null)?.total ?? 0)
      const other = all - buckets.reduce((n, b) => n + b.count, 0)
      const nothing = Number(mine.find((r) => r.value === null)?.n ?? 0)
      if (nothing) buckets.push({ value: null, label: 'No value', count: nothing })
      out[c.id] = { buckets, other }
    }
    return out
  }

  // The statement's parts ------------------------------------------------------

  private where(p: ListParams, view: Sight, q: Params): string {
    const parts = [`e.state = ANY(${q.add(p.states)}::text[])`]
    if (!p.includeHidden) parts.push('NOT e.hidden')
    if (p.blueprint) {
      parts.push(`e.blueprint = ${q.add(p.blueprint)}`)
      // A blueprint the reader sees one by one lists those entities of it, and no other.
      const mine = view.oneByOne(p.blueprint)
      if (mine) parts.push(`(e.blueprint || ':' || e.key) = ANY(${q.add([...mine])}::text[])`)
    } else {
      const mine = this.blueprints.list().flatMap((bp) => [...(view.oneByOne(bp.id) ?? [])])
      parts.push(mine.length ? `(e.blueprint = ANY(${q.add(this.seen(view))}::text[]) OR (e.blueprint || ':' || e.key) = ANY(${q.add(mine)}::text[]))` : `e.blueprint = ANY(${q.add(this.seen(view))}::text[])`)
    }
    // A filter saved before a rename, in an action or a query, still names the former id; it reaches the blueprint it became.
    if (p.filter) parts.push(this.predicate(this.blueprints.current(p.filter), p.blueprint ? this.blueprints.get(p.blueprint) : undefined, view, q))
    if (p.starredOnly) parts.push(p.starredBy ? STARRED(q.add(p.starredBy)) : 'FALSE')
    return parts.join(' AND ')
  }

  /** The blueprints the reader may see, as ids. */
  private seen(view: Sight): string[] {
    return this.blueprints.list().filter((bp) => view.seesBlueprint(bp.id)).map((bp) => bp.id)
  }

  private orderBy(p: ListParams, view: Sight, q: Params): string {
    return this.orderParts(p, view, q).map((o) => (o.desc ? `${o.expr} DESC` : o.expr)).join(', ')
  }

  /** The parts rows are ordered by, first to last. The key comes last, so no two rows tie on all of them. */
  private orderParts(p: ListParams, view: Sight, q: Params): OrderPart[] {
    const parts: OrderPart[] = []
    if (p.group) parts.push({ expr: `(${this.groupKey(p, view, q)} = '—')` }, { expr: `${this.groupKey(p, view, q)} COLLATE orrery_natural` })
    // What the reader starred leads whatever the order, inside each group: false comes before true.
    if (p.starredBy && !p.starredOnly) parts.push({ expr: `(NOT ${STARRED(q.add(p.starredBy))})` })
    if (p.sort) {
      const desc = p.sort.startsWith('-')
      const name = desc ? p.sort.slice(1) : p.sort
      const k = this.valueOf(name, p.blueprint ? this.blueprints.get(p.blueprint) : undefined, view, q)
      // Unset, lists, and objects last whichever way; numbers before text, each in their own order: `compare` in filter.ts.
      parts.push({ expr: `(NOT ${ORDERABLE(k)})` }, { expr: `(jsonb_typeof(${k}) <> 'number')` }, { expr: `(CASE WHEN jsonb_typeof(${k}) = 'number' THEN (${k}::text)::numeric END)`, desc, numeric: true }, { expr: `(CASE WHEN jsonb_typeof(${k}) IN ('string', 'boolean') THEN ${k} #>> '{}' END) COLLATE orrery_natural`, desc })
    }
    parts.push({ expr: 'e.blueprint' }, { expr: 'e.title COLLATE orrery_natural' }, { expr: 'e.key' })
    return parts
  }

  /** The text a row is grouped under: `groupKey` in lists.ts. */
  private groupKey(p: ListParams, view: Sight, q: Params): string {
    const group = p.group!
    if (group.startsWith('r:')) {
      const rel = group.slice(2)
      return `coalesce(nullif((SELECT string_agg(coalesce(t->>'title', t->>'key'), ', ' ORDER BY o) FROM jsonb_array_elements(coalesce(d.relations->${q.add(rel)}::text, '[]'::jsonb)) WITH ORDINALITY AS r(t, o)), ''), '—')`
    }
    const v = this.valueOf(group, p.blueprint ? this.blueprints.get(p.blueprint) : undefined, view, q)
    return `(CASE
      WHEN ${v} IS NULL OR jsonb_typeof(${v}) = 'null' OR ${v} = '""'::jsonb THEN '—'
      WHEN jsonb_typeof(${v}) = 'array' THEN coalesce((SELECT string_agg(${TEXT('x')}, ', ' ORDER BY o) FROM jsonb_array_elements(${v}) WITH ORDINALITY AS a(x, o)), '')
      WHEN jsonb_typeof(${v}) = 'object' THEN ${q.add(OBJECT_LABEL)}::text
      ELSE ${TEXT(v)} END)`
  }

  // Values -----------------------------------------------------------------------

  /**
   * A value by name, as `fieldOf` reads it: `$name` is what the hub keeps
   * about every entity, `fields.x` a field, and a bare name a field when the
   * blueprint defines one, else what the hub keeps. Without a blueprint the
   * name is resolved per blueprint the reader sees. JSON, or NULL for unset.
   */
  private valueOf(name: string, bp: Blueprint | undefined, view: Sight, q: Params): string {
    if (name.startsWith('$')) return this.meta(name.slice(1), bp, view, q) ?? 'NULL::jsonb'
    if (name.startsWith('fields.')) return this.fieldValueAcross(name.slice(7), bp, view, q)
    if (bp) return name in bp.fields ? (this.fieldValue(name, bp, view, q) ?? 'NULL::jsonb') : (this.meta(name, bp, view, q) ?? 'NULL::jsonb')
    // Without a blueprint, a field the blueprint defines wins per blueprint, and the rest read what the hub keeps.
    const arms = this.seen(view)
      .map((id) => this.blueprints.get(id)!)
      .filter((b) => name in b.fields)
      .map((b) => `WHEN ${q.add(b.id)} THEN ${this.fieldValue(name, b, view, q) ?? 'NULL::jsonb'}`)
    const meta = this.meta(name, undefined, view, q) ?? 'NULL::jsonb'
    return arms.length ? `(CASE e.blueprint ${arms.join(' ')} ELSE ${meta} END)` : meta
  }

  /** Whether the row has a value under this name at all: its blueprint defines the field, or the hub keeps it. */
  private known(name: string, bp: Blueprint | undefined, view: Sight, q: Params): string {
    const bare = name.startsWith('$') ? null : name.startsWith('fields.') ? name.slice(7) : name
    const metaKnown = this.meta(name.startsWith('$') ? name.slice(1) : name, undefined, view, q) !== null
    if (name.startsWith('$')) return metaKnown ? 'TRUE' : 'FALSE'
    if (bp) return bare! in bp.fields || (!name.startsWith('fields.') && metaKnown) ? 'TRUE' : 'FALSE'
    const having = this.seen(view).filter((id) => bare! in this.blueprints.get(id)!.fields)
    if (!name.startsWith('fields.') && metaKnown) return 'TRUE'
    return having.length ? `(e.blueprint = ANY(${q.add(having)}::text[]))` : 'FALSE'
  }

  private fieldValueAcross(name: string, bp: Blueprint | undefined, view: Sight, q: Params): string {
    if (bp) return this.fieldValue(name, bp, view, q) ?? 'NULL::jsonb'
    const arms = this.seen(view).map((id) => `WHEN ${q.add(id)} THEN ${this.fieldValue(name, this.blueprints.get(id)!, view, q) ?? 'NULL::jsonb'}`)
    return arms.length ? `(CASE e.blueprint ${arms.join(' ')} END)` : 'NULL::jsonb'
  }

  /**
   * One blueprint's field as the reader sees it on each row: the stored
   * value, blank where the field is hidden to them, and where a class opens
   * it to owners, the value on the rows they own and blank on the rest. Null
   * when the field is hidden on every row.
   */
  private fieldValue(name: string, bp: Blueprint, view: Sight, q: Params): string | null {
    const hidden = view.hiddenFields(bp.id).has(name)
    const opened = hidden ? view.openedTo(bp.id).find((o) => o.field === name) : undefined
    // Nothing is added to the statement for a field hidden on every row: a parameter nothing reads leaves Postgres unable to type it.
    if (hidden && !opened) return null
    const raw = `(d.fields->${q.add(name)}::text)`
    return opened ? `(CASE WHEN ${this.owned(opened, view, q)} THEN ${raw} END)` : raw
  }

  /** Whether the reader owns the row for an opened field: the row itself, or a target of one of the class's relations, in a blueprint they see. */
  private owned(opened: { ids: string[]; through: string[] }, view: Sight, q: Params): string {
    const ids = q.add(opened.ids)
    const parts = [`(e.blueprint || ':' || e.key) = ANY(${ids}::text[])`]
    for (const rel of opened.through) {
      parts.push(`EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(d.relations->${q.add(rel)}::text, '[]'::jsonb)) t WHERE ((t->>'blueprint') || ':' || (t->>'key')) = ANY(${ids}::text[]) AND (t->>'blueprint') = ANY(${q.add(this.seen(view))}::text[]))`)
    }
    return `(${parts.join(' OR ')})`
  }

  /** What the hub keeps about every entity, by name, as JSON; null for a name it does not keep. */
  private meta(name: string, bp: Blueprint | undefined, view: Sight, q: Params): string | null {
    switch (name) {
      case 'key':
        return 'to_jsonb(e.key)'
      case 'title':
        return 'to_jsonb(e.title)'
      case 'blueprint':
        return 'to_jsonb(e.blueprint)'
      case 'state':
        return 'to_jsonb(e.state)'
      case 'owner':
        return 'to_jsonb(e.owner)'
      case 'status':
        return 'to_jsonb(d.level)'
      case 'createdAt':
        return `to_jsonb(${ISO('e.created_at')})`
      case 'updatedAt':
        return `to_jsonb(${ISO('e.updated_at')})`
      case 'lastSeenAt':
        return `to_jsonb(${ISO(SEEN)})`
      case 'icon': {
        // The picture shown: the entity's own when it is one of the set, a custom icon, or a person's photo, else its blueprint's.
        const known = q.add([...ICON_NAMES, ...this.icons.names()])
        const fallback = bp ? `${q.add(bp.icon ?? null)}::text` : `(SELECT b.spec->>'icon' FROM blueprints b WHERE b.id = e.blueprint)`
        return `to_jsonb(CASE WHEN d.icon = ANY(${known}::text[]) OR d.icon LIKE '${PHOTO_PREFIX}%' THEN d.icon ELSE ${fallback} END)`
      }
      default:
        return null
    }
  }

  // Predicates -----------------------------------------------------------------

  /** One filter as SQL, every leaf false where it would be null, as `matches` decides it. */
  private predicate(f: Filter, bp: Blueprint | undefined, view: Sight, q: Params): string {
    if ('and' in f) return f.and.length ? `(${f.and.map((x) => this.predicate(x, bp, view, q)).join(' AND ')})` : 'TRUE'
    if ('or' in f) return f.or.length ? `(${f.or.map((x) => this.predicate(x, bp, view, q)).join(' OR ')})` : 'FALSE'
    if ('not' in f) return `(NOT ${this.predicate(f.not, bp, view, q)})`
    if ('state' in f) return `(e.state = ${q.add(f.state)})`
    if ('search' in f) return this.search(f.search, bp, view, q)
    if ('relation' in f) return f.where ? this.reaching(f.relation, f.where, !!f.every, bp, view, q) : this.relation(f.relation, f.target, bp, view, q)
    if ('relatedTo' in f) return this.relatedTo(f.relatedTo, q)
    if ('scorecard' in f) return this.level(f.scorecard, f.op, f.value, q)
    return this.field(f.field, f.op, f.value, bp, view, q)
  }

  /** The key, the title, and the text of every field value the reader may see, searched for `text`, lowercased: `matches` with `searchTexts`. */
  private search(text: string, bp: Blueprint | undefined, view: Sight, q: Params): string {
    const lower = text.toLowerCase()
    const needle = q.add(lower)
    const pattern = q.add(likeAnywhere(lower))
    // Which fields the reader may see of a row, by blueprint: every field but the hidden, and an opened one on the rows they own.
    const visible = (b: Blueprint): string => {
      // A summary is shown as its number and never searched: its text is not the reader's to find.
      const hidden = [...view.hiddenFields(b.id), ...view.summaries(b.id)]
      if (!hidden.length) return 'TRUE'
      const parts = [`NOT (f.key = ANY(${q.add(hidden)}::text[]))`]
      for (const o of view.openedTo(b.id)) parts.push(`(f.key = ${q.add(o.field)} AND ${this.owned(o, view, q)})`)
      return `(${parts.join(' OR ')})`
    }
    const perBlueprint = bp ? visible(bp) : `(CASE e.blueprint ${this.seen(view).map((id) => `WHEN ${q.add(id)} THEN ${visible(this.blueprints.get(id)!)}`).join(' ')} ELSE FALSE END)`
    return `(d.search_all LIKE ${pattern} ESCAPE '\\' AND (position(${needle} in lower(e.key)) > 0 OR position(${needle} in lower(e.title)) > 0
      OR EXISTS (SELECT 1 FROM jsonb_each(d.fields) f, jsonb_path_query(f.value, 'strict $.**') AS leaf WHERE ${perBlueprint} AND jsonb_typeof(leaf) IN ('string', 'number', 'boolean') AND position(${needle} in lower(${TEXT('leaf')})) > 0)))`
  }

  /**
   * A relation of the row's own, or who points at it (`<-rel`, `<-bp:rel`)
   * through the winning layer, with or without a named target. A target is
   * named by its id, its key, or its title. A relation to or from a
   * blueprint the reader may not see is refused before it reaches here.
   */
  private relation(spec: string, target: string | undefined, bp: Blueprint | undefined, view: Sight, q: Params): string {
    // Added only where a title is matched: a parameter nothing reads leaves Postgres unable to type it.
    const seen = () => q.add(this.seen(view))
    if (!spec.startsWith('<-')) {
      const own = `jsonb_array_elements(coalesce(d.relations->${q.add(spec)}::text, '[]'::jsonb)) t`
      if (target === undefined) return `(jsonb_array_length(coalesce(d.relations->${q.add(spec)}::text, '[]'::jsonb)) > 0)`
      const t = q.add(target)
      return `EXISTS (SELECT 1 FROM ${own} WHERE ((t->>'blueprint') || ':' || (t->>'key')) = ${t} OR (t->>'key') = ${t} OR ((t->>'title') = ${t} AND (t->>'blueprint') = ANY(${seen()}::text[])))`
    }
    const pointing = this.pointing(parsePath(spec)[0]!, q)
    if (target === undefined) return `EXISTS (${pointing})`
    const t = q.add(target)
    return `EXISTS (${pointing} AND ((r.blueprint || ':' || r.key) = ${t} OR r.key = ${t} OR (s.title = ${t} AND r.blueprint = ANY(${seen()}::text[]))))`
  }

  /**
   * Whether the entities a relation reaches meet a filter: one of them, or,
   * `every`, at least one and all of them, as `matches` judges it over the
   * sets `whereSets` gives. Each is read as a row of its own, its stored
   * values as the reader sees them; the filter is refused before it reaches
   * here when it reads what they may not see.
   */
  private reaching(spec: string, where: Filter, every: boolean, bp: Blueprint | undefined, view: Sight, q: Params): string {
    // The entity reached, named by the expressions given, as a row of its own: inside it `e` and `d` are that entity, as every predicate reads them.
    const reached = (blueprint: string, key: string, test: string) =>
      `EXISTS (SELECT 1 FROM entities e LEFT JOIN derived d ON d.blueprint = e.blueprint AND d.key = e.key WHERE e.blueprint = ${blueprint} AND e.key = ${key} AND e.state <> 'deleted' AND ${test})`
    if (!spec.startsWith('<-')) {
      const target = bp?.relations[spec]?.target
      const inner = this.predicate(where, target ? this.blueprints.get(target) : undefined, view, q)
      const own = `jsonb_array_elements(coalesce(d.relations->${q.add(spec)}::text, '[]'::jsonb)) t`
      const meets = reached(`(t->>'blueprint')`, `(t->>'key')`, inner)
      if (!every) return `EXISTS (SELECT 1 FROM ${own} WHERE ${meets})`
      return `(jsonb_array_length(coalesce(d.relations->${q.add(spec)}::text, '[]'::jsonb)) > 0 AND NOT EXISTS (SELECT 1 FROM ${own} WHERE NOT ${meets}))`
    }
    const hop = parsePath(spec)[0]!
    const inner = this.predicate(where, hop.from ? this.blueprints.get(hop.from) : undefined, view, q)
    const pointing = this.pointing(hop, q)
    const meets = reached('r.blueprint', 'r.key', inner)
    if (!every) return `EXISTS (${pointing} AND ${meets})`
    return `(EXISTS (${pointing}) AND NOT EXISTS (${pointing} AND NOT ${meets}))`
  }

  /** Who points at the row through one incoming hop, in the winning layer of each, as rows `r` of relations beside their entity `s`: a statement to add conditions to. */
  private pointing(hop: Hop, q: Params): string {
    const [bps, rels] = this.blueprints.definedRelations()
    const parts = [`r.target_blueprint = e.blueprint`, `r.target_key = e.key`, `r.relation = ${q.add(hop.relation)}`, `(r.blueprint, r.relation) IN (SELECT * FROM unnest(${q.add(bps)}::text[], ${q.add(rels)}::text[]))`, `s.state <> 'deleted'`]
    if (hop.from) parts.push(`r.blueprint = ${q.add(hop.from)}`)
    // Only the winning layer of each (entity, relation) holds: no row of the same source entity and relation sits in a higher layer.
    parts.push(`NOT EXISTS (SELECT 1 FROM relations r2 WHERE r2.blueprint = r.blueprint AND r2.key = r.key AND r2.relation = r.relation AND (${LAYER_RANK.replaceAll('layer', 'r2.layer')}) > (${LAYER_RANK.replaceAll('layer', 'r.layer')}))`)
    return `SELECT 1 FROM relations r JOIN entities s ON s.blueprint = r.blueprint AND s.key = r.key WHERE ${parts.join(' AND ')}`
  }

  /** Whether the row is related to one named entity, either way, in any layer: `relatedSets` in read.ts. */
  private relatedTo(id: string, q: Params): string {
    const at = id.indexOf(':')
    if (at <= 0) return 'FALSE'
    const [bps, rels] = this.blueprints.definedRelations()
    const b = q.add(id.slice(0, at))
    const k = q.add(id.slice(at + 1))
    const defined = `(SELECT * FROM unnest(${q.add(bps)}::text[], ${q.add(rels)}::text[]))`
    return `(EXISTS (SELECT 1 FROM relations r WHERE r.target_blueprint = ${b} AND r.target_key = ${k} AND r.blueprint = e.blueprint AND r.key = e.key AND (r.blueprint, r.relation) IN ${defined})
      OR EXISTS (SELECT 1 FROM relations r WHERE r.blueprint = ${b} AND r.key = ${k} AND r.target_blueprint = e.blueprint AND r.target_key = e.key AND (r.blueprint, r.relation) IN ${defined}))`
  }

  /** The level the row reached on a scorecard against a name, as `levelMatches` judges it. Out of scope matches nothing. */
  private level(scorecard: string, op: string, value: unknown, q: Params): string {
    const lv = `(d.levels->${q.add(scorecard)}::text)`
    const scope = `(${lv} IS NOT NULL AND jsonb_typeof(${lv}) = 'array')`
    if (op === 'exists') return scope
    const at = `(jsonb_array_length(${lv}) - 1)`
    // The rank of a name: -1 for `none`, its place in what was reached, or NULL for a name not reached.
    const rank = (name: string) => `(CASE WHEN ${name} = 'none' THEN -1 ELSE array_position(ARRAY(SELECT jsonb_array_elements_text(${lv})), ${name}) - 1 END)`
    const eq = (name: string) => `(CASE WHEN ${at} < 0 THEN ${name} = 'none' ELSE (${lv}->>${at}) = ${name} END)`
    const gte = (name: string) => `(${rank(name)} IS NOT NULL)`
    const gt = (name: string) => `(${rank(name)} IS NOT NULL AND ${at} > ${rank(name)})`
    const names = Array.isArray(value) ? value : [value]
    const one = (fn: (n: string) => string) => (typeof value === 'string' ? fn(q.add(value)) : 'FALSE')
    let test: string
    switch (op) {
      case 'eq':
        test = one(eq)
        break
      case 'neq':
        test = `(NOT ${one(eq)})`
        break
      case 'gte':
        test = one(gte)
        break
      case 'gt':
        test = one(gt)
        break
      case 'lt':
        test = `(NOT ${one(gte)})`
        break
      case 'lte':
        test = `(NOT ${one(gt)})`
        break
      case 'in':
        test = Array.isArray(value) && names.length ? `(${names.map((n) => (typeof n === 'string' ? eq(q.add(n)) : 'FALSE')).join(' OR ')})` : 'FALSE'
        break
      default:
        test = 'FALSE'
    }
    return `(${scope} AND coalesce(${test}, FALSE))`
  }

  /** One field against a value, op by op as `matches` reads them. */
  private field(name: string, op: string, value: unknown, bp: Blueprint | undefined, view: Sight, q: Params): string {
    const v = this.valueOf(name, bp, view, q)
    const set = `(${v} IS NOT NULL AND jsonb_typeof(${v}) <> 'null')`
    const given = value !== null && value !== undefined
    const json = () => `${q.add(JSON.stringify(value ?? null))}::jsonb`
    // A name the row has at all: a field its blueprint defines, or something the hub keeps. `fieldOf` gives undefined otherwise, which equals nothing but undefined.
    const known = this.known(name, bp, view, q)
    switch (op) {
      case 'exists':
        return set
      case 'eq':
        // A null value and an unset field are one value here, as `stable` prints both as null; a name the row does not have equals only a value left out.
        return value === undefined ? `(NOT ${known})` : `(${known} AND coalesce(${v}, 'null'::jsonb) = ${json()})`
      case 'neq':
        return value === undefined ? known : `(NOT (${known} AND coalesce(${v}, 'null'::jsonb) = ${json()}))`
      case 'in':
        return Array.isArray(value) && value.length ? `(${known} AND coalesce(${v}, 'null'::jsonb) = ANY(${q.add(value.map((x) => JSON.stringify(x ?? null)))}::jsonb[]))` : 'FALSE'
      case 'gt':
      case 'gte':
      case 'lt':
      case 'lte': {
        if (!given || !(typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean')) return 'FALSE'
        const sign = op === 'gt' ? '>' : op === 'gte' ? '>=' : op === 'lt' ? '<' : '<='
        // Numbers against a number by size; text against text as a person reads it; a number and a text never compare equal, numbers first.
        if (typeof value === 'number') {
          const n = q.add(value)
          return `(${ORDERABLE(v)} AND (CASE WHEN jsonb_typeof(${v}) = 'number' THEN (${v}::text)::numeric ${sign} ${n} ELSE ${sign.startsWith('>') ? 'TRUE' : 'FALSE'} END))`
        }
        const t = q.add(String(value))
        return `(${ORDERABLE(v)} AND (CASE WHEN jsonb_typeof(${v}) = 'number' THEN ${sign.startsWith('<') ? 'TRUE' : 'FALSE'} ELSE (${v} #>> '{}') COLLATE orrery_natural ${sign} ${t} COLLATE orrery_natural END))`
      }
      case 'contains': {
        const parts: string[] = []
        if (typeof value === 'string') {
          parts.push(`(jsonb_typeof(${v}) = 'string' AND position(${q.add(value.toLowerCase())} in lower(${v} #>> '{}')) > 0)`)
          parts.push(`(jsonb_typeof(${v}) = 'object' AND ${v} ? ${q.add(value)})`)
        }
        parts.push(`(jsonb_typeof(${v}) = 'array' AND ${v} @> jsonb_build_array(${json()}))`)
        return `(${parts.join(' OR ')})`
      }
      case 'prefix':
        return typeof value === 'string' ? `(jsonb_typeof(${v}) = 'string' AND (${v} #>> '{}') LIKE ${q.add(`${value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`)} ESCAPE '\\')` : 'FALSE'
      case 'within':
      case 'older': {
        if (typeof value !== 'string') return 'FALSE'
        let span: number
        try {
          span = parseDuration(value)
        } catch {
          return 'FALSE'
        }
        const t = `orrery_ts(${v} #>> '{}')`
        const edge = `(now() - make_interval(secs => ${q.add(span / 1000)}))`
        return op === 'within' ? `(jsonb_typeof(${v}) = 'string' AND ${t} IS NOT NULL AND ${t} <= now() AND ${t} >= ${edge})` : `(jsonb_typeof(${v}) = 'string' AND ${t} IS NOT NULL AND ${t} < ${edge})`
      }
      default:
        return 'FALSE'
    }
  }
}

