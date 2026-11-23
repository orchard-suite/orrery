// A cursor names where the next page of a list starts: right after the last
// row given, by the values that row holds in each part of the list's order.
// It carries a fingerprint of the question it was cut from, so a cursor is
// never read against another list's order.

import { createHash } from 'node:crypto'
import type { EntityState, Filter } from '../shared/model.ts'
import { CursorError, type OrderValues } from './query.ts'

/** What decides a list's rows and their order: a cursor fits only the question it was cut from. */
export interface CursorQuestion {
  blueprint?: string
  states?: EntityState[]
  includeHidden?: boolean
  filter?: Filter
  sort?: string
  group?: string
  /** The reader whose stars lead the order: a cursor cut for one person's order is not another's. */
  starredBy?: string
  starredOnly?: boolean
}

function fingerprint(q: CursorQuestion): string {
  const shape = [q.blueprint ?? null, q.states ?? null, !!q.includeHidden, q.filter ?? null, q.sort ?? null, q.group ?? null, ...(q.starredBy ? [q.starredBy, !!q.starredOnly] : [])]
  return createHash('sha256').update(JSON.stringify(shape)).digest('base64url').slice(0, 16)
}

export function encodeCursor(q: CursorQuestion, values: OrderValues): string {
  return Buffer.from(JSON.stringify({ q: fingerprint(q), v: values })).toString('base64url')
}

/** The order values a cursor names, refused when it was cut from another question or is not one at all. */
export function decodeCursor(q: CursorQuestion, cursor: string): OrderValues {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch {
    throw new CursorError('the cursor is not one this hub gave')
  }
  const { q: print, v } = (parsed ?? {}) as { q?: unknown; v?: unknown }
  if (!Array.isArray(v) || !v.every((x) => x === null || typeof x === 'string' || typeof x === 'boolean')) throw new CursorError('the cursor is not one this hub gave')
  if (print !== fingerprint(q)) throw new CursorError('the cursor was given for another list: ask with the same blueprint, filter, state, sort, and group')
  return v as OrderValues
}
