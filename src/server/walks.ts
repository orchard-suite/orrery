// Each person's walk through a map: the stops they mean to make, one climb on
// one place each. A walk is theirs alone, as their pins are, so it is no
// change to the estate and writes no activity row. A stop keeps the things it
// named when it was added, so how far it has come is read from the map as it
// stands; nothing here reads the map, and a stop whose things the reader no
// longer sees is shown as what is left of it. The table is read on every ask
// and never kept in memory, so hubs have nothing to tell each other about it.

import { randomUUID } from 'node:crypto'
import type { WalkStep, WalkStepRequest } from '../shared/api.ts'
import { MAP_LIMIT, MOST_STEPS } from '../shared/map.ts'
import type { EntityRef } from '../shared/model.ts'
import type { Db } from './db.ts'
import type { Logger } from './log.ts'

/** A person already keeps as many stops on one map as one may. */
export class WalkFull extends Error {
  readonly status = 409
  constructor() {
    super(`Your walk here has ${MOST_STEPS} stops, the most one keeps. Take one off first.`)
  }
}

/** The most things one stop names: as many as a map reads of one blueprint. */
export const MOST_STEP_THINGS = MAP_LIMIT

interface Row {
  id: string
  place: string | null
  ladder: string
  from_rung: number
  scope: string | null
  things: string[]
  created_at: Date
}

const stepOf = (r: Row): WalkStep => ({ id: r.id, place: r.place, ladder: r.ladder, from: r.from_rung, scope: r.scope, things: r.things, addedAt: r.created_at.toISOString() })

export class Walks {
  private readonly db: Db
  private readonly log: Logger

  constructor(db: Db, log: Logger) {
    this.db = db
    this.log = log
  }

  /** A person's stops on one map, oldest first. */
  async of(person: string, map: EntityRef): Promise<WalkStep[]> {
    const rows = await this.db.query<Row>('SELECT id, place, ladder, from_rung, scope, things, created_at FROM walk_steps WHERE person = $1 AND holder_blueprint = $2 AND holder_key = $3 ORDER BY created_at, id', [person, map.blueprint, map.key])
    return rows.rows.map(stepOf)
  }

  /** Adds a stop after the others. The same climb added again keeps its stop and takes the things it names now. */
  async add(person: string, map: EntityRef, step: WalkStepRequest): Promise<boolean> {
    return this.db.tx(async (tx) => {
      // One person's walk on one map changes one stop at a time, so two adds cannot both pass the count.
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`walk:${person}:${map.blueprint}:${map.key}`])
      const same = await tx.query<{ id: string }>(
        `UPDATE walk_steps SET things = $8 WHERE person = $1 AND holder_blueprint = $2 AND holder_key = $3 AND place IS NOT DISTINCT FROM $4 AND ladder = $5 AND from_rung = $6 AND scope IS NOT DISTINCT FROM $7 RETURNING id`,
        [person, map.blueprint, map.key, step.place, step.ladder, step.from, step.scope, step.things],
      )
      if (same.rowCount) return false
      const held = (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM walk_steps WHERE person = $1 AND holder_blueprint = $2 AND holder_key = $3', [person, map.blueprint, map.key])).rows[0]!.n
      if (held >= MOST_STEPS) {
        this.log.info('walk step refused: the person holds the most on this map', { person, map: `${map.blueprint}:${map.key}`, held })
        throw new WalkFull()
      }
      await tx.query('INSERT INTO walk_steps (id, person, holder_blueprint, holder_key, place, ladder, from_rung, scope, things) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)', [randomUUID(), person, map.blueprint, map.key, step.place, step.ladder, step.from, step.scope, step.things])
      return true
    })
  }

  /** Takes one stop off. False when the person had no such stop on this map. */
  async remove(person: string, map: EntityRef, id: string): Promise<boolean> {
    const gone = await this.db.query('DELETE FROM walk_steps WHERE person = $1 AND holder_blueprint = $2 AND holder_key = $3 AND id = $4', [person, map.blueprint, map.key, id])
    return (gone.rowCount ?? 0) > 0
  }
}
