// The links a relation path steps along, read from the relations table alone:
// only the link that wins its relation counts, and only between entities that
// are not deleted. What a walk needs that reads no value, such as what a
// person owns or where an inherited relation ends, reads through it.

import { parseEntityId, type EntityRef } from '../shared/model.ts'
import type { Hop } from '../shared/filter.ts'
import type { Blueprints } from './blueprints.ts'
import type { Db } from './db.ts'
import { ABOVE } from './read.ts'

/** Who links to whom along one hop: [the entity of the step before, the entity the hop reaches]. */
export type Step = readonly [string, string]

/**
 * The links one hop steps along, where it does: `forward` from each of `ids`
 * as an entity of the step before, `back` to each of `ids` as an entity the
 * hop reaches. In the order of what each reaches, so a walk that keeps the
 * first of several ends keeps the same one each time.
 */
export async function stepsAlong(db: Db, blueprints: Blueprints, hop: Hop, way: 'forward' | 'back', ids: string[]): Promise<Step[]> {
  if (!ids.length) return []
  const holders = blueprints.list().filter((bp) => !!bp.relations[hop.relation] && (!hop.incoming || !hop.from || bp.id === hop.from)).map((bp) => bp.id)
  if (!holders.length) return []
  // An incoming hop steps from what a link points at to what holds it; an outgoing one the other way.
  const atHolder = hop.incoming ? way === 'back' : way === 'forward'
  const refs = ids.map((id) => parseEntityId(id)).filter((r): r is EntityRef => !!r)
  const side = atHolder ? '(r.blueprint, r.key)' : '(r.target_blueprint, r.target_key)'
  const reached = hop.incoming ? 'r.blueprint, r.key' : 'r.target_blueprint, r.target_key'
  const rows = await db.query<{ blueprint: string; key: string; target_blueprint: string; target_key: string }>(
    `SELECT DISTINCT r.blueprint, r.key, r.target_blueprint, r.target_key FROM relations r
     JOIN entities s ON s.blueprint = r.blueprint AND s.key = r.key AND s.state <> 'deleted'
     JOIN entities t ON t.blueprint = r.target_blueprint AND t.key = r.target_key AND t.state <> 'deleted'
     WHERE ${side} IN (SELECT * FROM unnest($1::text[], $2::text[])) AND r.relation = $3 AND r.blueprint = ANY($4::text[])
       AND NOT EXISTS (SELECT 1 FROM relations w WHERE w.blueprint = r.blueprint AND w.key = r.key AND w.relation = r.relation AND w.layer = ANY(${ABOVE}))
     ORDER BY ${reached}`,
    [refs.map((r) => r.blueprint), refs.map((r) => r.key), hop.relation, holders],
  )
  return rows.rows.map((r) => {
    const holder = `${r.blueprint}:${r.key}`
    const target = `${r.target_blueprint}:${r.target_key}`
    return hop.incoming ? ([target, holder] as const) : ([holder, target] as const)
  })
}

/** The ids at the end of `hops` from each of `starts`, by the start's id, each in the order `stepsAlong` reaches them. */
export async function reachAlong(db: Db, blueprints: Blueprints, starts: string[], hops: Hop[]): Promise<Map<string, string[]>> {
  let at = new Map(starts.map((id) => [id, [id]]))
  for (const hop of hops) {
    const here = [...new Set([...at.values()].flat())]
    const steps = await stepsAlong(db, blueprints, hop, 'forward', here)
    const next = new Map<string, string[]>()
    for (const [from, to] of steps) {
      const list = next.get(from)
      if (list) list.push(to)
      else next.set(from, [to])
    }
    at = new Map([...at].map(([start, ids]) => [start, [...new Set(ids.flatMap((id) => next.get(id) ?? []))]]))
  }
  return at
}
