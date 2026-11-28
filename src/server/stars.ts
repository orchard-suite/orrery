// What each person starred: their favorite entities, across every blueprint.
// A star is a person's own way of finding things in the catalog, so it is no
// change to the estate and writes no activity row. Every catalog grid a person
// reads puts what they starred first (`starredBy` in `query.ts`), and their
// favorites page lists it. A query, a report, an export, and a schedule never
// read it: they have readers downstream, and one person's stars would move
// what all of them see (ORY-5007).
//
// A star names an entity and nothing more. One to something the person may no
// longer see is kept and never shown or counted, so it shows again when they
// may. It goes only when the hub lets go of its entity for good, when its
// tombstone is purged (`runs.ts`). A renamed blueprint takes its stars with
// it (`blueprints.ts`). The table is read on every ask and never
// kept in memory, so hubs have nothing to tell each other about it.

import type { EntityRef } from '../shared/model.ts'
import type { Db, Queryable } from './db.ts'

export class Stars {
  private readonly db: Db

  constructor(db: Db) {
    this.db = db
  }

  /** Everything a person starred, newest first, whether or not they may still see it. */
  async of(person: string): Promise<EntityRef[]> {
    const rows = await this.db.query<EntityRef>('SELECT blueprint, key FROM stars WHERE person = $1 ORDER BY created_at DESC, blueprint, key', [person])
    return rows.rows.map((r) => ({ blueprint: r.blueprint, key: r.key }))
  }

  /** Stars an entity. False when it was starred already. */
  async add(person: string, ref: EntityRef): Promise<boolean> {
    const added = await this.db.query('INSERT INTO stars (person, blueprint, key) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [person, ref.blueprint, ref.key])
    return (added.rowCount ?? 0) > 0
  }

  /** Lets go of one star. False when it was not starred. */
  async remove(person: string, ref: EntityRef): Promise<boolean> {
    const gone = await this.db.query('DELETE FROM stars WHERE person = $1 AND blueprint = $2 AND key = $3', [person, ref.blueprint, ref.key])
    return (gone.rowCount ?? 0) > 0
  }

  /** Which of these entities the person starred, by entity id. */
  async among(person: string, refs: readonly EntityRef[]): Promise<Set<string>> {
    if (!refs.length) return new Set()
    const rows = await this.db.query<{ id: string }>(
      `SELECT s.blueprint || ':' || s.key AS id FROM stars s
       JOIN unnest($2::text[], $3::text[]) AS r(blueprint, key) ON r.blueprint = s.blueprint AND r.key = s.key
       WHERE s.person = $1`,
      [person, refs.map((r) => r.blueprint), refs.map((r) => r.key)],
    )
    return new Set(rows.rows.map((r) => r.id))
  }

  /**
   * How many stars a person keeps of one blueprint, or of every one, and what names their state: the stamp moves
   * whenever one is added or let go, so a grid's tag moves with the order the stars give it. A star let go lowers the
   * count; one added raises the newest time. A grid of a person who holds none there is ordered without them.
   */
  async held(person: string, blueprint?: string): Promise<{ count: number; stamp: string }> {
    const rows = await this.db.query<{ n: number; at: string | null }>(
      `SELECT count(*)::int AS n, max(created_at)::text AS at FROM stars WHERE person = $1${blueprint ? ' AND blueprint = $2' : ''}`,
      blueprint ? [person, blueprint] : [person],
    )
    const { n, at } = rows.rows[0]!
    return { count: n, stamp: `${n}@${at ?? ''}` }
  }

  /** How many stars each blueprint holds now, and how many people keep them: what the Load page counts them by. */
  async kept(): Promise<Map<string, { stars: number; people: number }>> {
    const rows = await this.db.query<{ blueprint: string; n: string; people: string }>('SELECT blueprint, count(*)::text AS n, count(DISTINCT person)::text AS people FROM stars GROUP BY blueprint')
    return new Map(rows.rows.map((r) => [r.blueprint, { stars: Number(r.n), people: Number(r.people) }]))
  }
}

/** Lets go of the stars of entities the hub let go of for good, inside the transaction that let them go. */
export async function forgetStars(tx: Queryable, refs: readonly EntityRef[]): Promise<number> {
  if (!refs.length) return 0
  const gone = await tx.query('DELETE FROM stars s USING unnest($1::text[], $2::text[]) AS r(blueprint, key) WHERE s.blueprint = r.blueprint AND s.key = r.key', [refs.map((r) => r.blueprint), refs.map((r) => r.key)])
  return gone.rowCount ?? 0
}
