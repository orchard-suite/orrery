// What each person pinned to the top of their own pages. It is the one thing
// a person arranges for themselves that the hub stores: it follows them to
// every browser. A pin is theirs alone, so it is no change to the estate and
// writes no activity row.
//
// A pin names what it points at and nothing more: an action on the
// self-service page, or a blueprint on the catalog's list. Nothing here
// removes one when what it names is removed, closed to the person, or the
// person leaves: whoever answers the pins shows only what the reader may use
// today, and a pin whose action or blueprint comes back shows again. The table is read on every ask and
// never kept in memory, so hubs have nothing to tell each other about it.

import { MOST_PINS, PIN_KINDS, type Pin, type PinKind } from '../shared/model.ts'
import type { Db } from './db.ts'
import type { Logger } from './log.ts'

/** A person already keeps as many pins as one may. */
export class PinsFull extends Error {
  readonly status = 409
  constructor() {
    super(`You have ${MOST_PINS} pins of this kind, the most one person keeps. Unpin one first.`)
  }
}

export const isPinKind = (kind: unknown): kind is PinKind => PIN_KINDS.includes(kind as PinKind)

export class Pins {
  private readonly db: Db
  private readonly log: Logger

  constructor(db: Db, log: Logger) {
    this.db = db
    this.log = log
  }

  /** Everything a person pinned, in their order, whether or not they may still use it. */
  async of(person: string): Promise<Pin[]> {
    const rows = await this.db.query<Pin>('SELECT kind, id FROM pins WHERE person = $1 ORDER BY position, created_at, id', [person])
    return rows.rows.map((r) => ({ kind: r.kind, id: r.id }))
  }

  /** Pins it after the person's others. False when it was pinned already, which a full set never refuses. */
  async add(person: string, pin: Pin): Promise<boolean> {
    return this.db.tx(async (tx) => {
      // One person's pins change one at a time, so two adds cannot both pass the count.
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`pins:${person}`])
      // A kind's pins are one shelf: the most is counted a kind, and the order runs across every kind.
      const held = await tx.query<{ n: number; last: number | null; has: boolean }>('SELECT count(*) FILTER (WHERE kind = $2)::int AS n, max(position) AS last, coalesce(bool_or(kind = $2 AND id = $3), false) AS has FROM pins WHERE person = $1', [person, pin.kind, pin.id])
      const { n, last, has } = held.rows[0]!
      if (has) return false
      if (n >= MOST_PINS) {
        this.log.info('pin refused: the person holds the most of its kind', { person, kind: pin.kind, held: n })
        throw new PinsFull()
      }
      await tx.query('INSERT INTO pins (person, kind, id, position) VALUES ($1, $2, $3, $4)', [person, pin.kind, pin.id, (last ?? 0) + 1])
      return true
    })
  }

  /** Lets go of one pin. False when it was not pinned. */
  async remove(person: string, pin: Pin): Promise<boolean> {
    const gone = await this.db.query('DELETE FROM pins WHERE person = $1 AND kind = $2 AND id = $3', [person, pin.kind, pin.id])
    return (gone.rowCount ?? 0) > 0
  }

  /** Puts the named pins first, in the order given; the rest keep theirs after them. A name that is not pinned is passed over. */
  async order(person: string, first: Pin[]): Promise<void> {
    await this.db.tx(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`pins:${person}`])
      const held = (await tx.query<Pin>('SELECT kind, id FROM pins WHERE person = $1 ORDER BY position, created_at, id', [person])).rows
      const name = (p: Pin) => `${p.kind}\n${p.id}`
      const has = new Map(held.map((p) => [name(p), p]))
      const named = new Map(first.flatMap((p) => (has.has(name(p)) ? [[name(p), has.get(name(p))!] as const] : [])))
      const next = [...named.values(), ...held.filter((p) => !named.has(name(p)))]
      await tx.query(
        `UPDATE pins p SET position = o.n
         FROM unnest($2::text[], $3::text[]) WITH ORDINALITY AS o(kind, id, n)
         WHERE p.person = $1 AND p.kind = o.kind AND p.id = o.id AND p.position <> o.n`,
        [person, next.map((p) => p.kind), next.map((p) => p.id)],
      )
    })
  }
}
