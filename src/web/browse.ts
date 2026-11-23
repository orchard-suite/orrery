// The list a record was opened from, so a phone can step to the record
// before or after it without going back. The catalog notes the list and the
// place when a row is opened; the record page reads the rows beside it from
// the same kept listing the list read, and steps in place of itself, so Back
// still returns to the list. It lives for the browser tab.

import { BLOCK, useGridBlock } from './api.ts'
import { navigate } from './router.ts'
import type { EntityRef } from '../shared/model.ts'

interface Browsing {
  blueprint: string
  /** The list's question: its filter, sort, grouping, and state, as the catalog asked it. */
  params: string
  total: number
  /** The record's place in the list, from 0. */
  at: number
  key: string
}

const KEY = 'orrery.browse'

/** Notes that a record was opened from a list, at a place in it. */
export function browseFrom(browsing: Browsing): void {
  sessionStorage.setItem(KEY, JSON.stringify(browsing))
}

function read(): Browsing | null {
  try {
    const raw = sessionStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as Browsing) : null
  } catch {
    return null
  }
}

/**
 * Where a record stands in the list it was opened from, and the steps to its
 * neighbours. Null when it was not opened from a list, or the list moved on to
 * another record since.
 */
export function useBrowse(ref: EntityRef): { at: number; total: number; previous: (() => void) | null; next: (() => void) | null } | null {
  const b = read()
  const on = !!b && b.blueprint === ref.blueprint && b.key === ref.key
  const params = new URLSearchParams(on ? b.params : '')
  const at = on ? b.at : 0
  // The blocks the neighbours sit in: one block, or two at a block's edge. A list the catalog just showed is read from its cache.
  const before = useGridBlock(ref.blueprint, params, Math.floor(Math.max(0, at - 1) / BLOCK), on && at > 0)
  const after = useGridBlock(ref.blueprint, params, Math.floor((at + 1) / BLOCK), on && at + 1 < (b?.total ?? 0))
  if (!on) return null
  const step = (i: number, block: typeof before) => {
    // A block still showing the rows of the one read before it is not the block asked for.
    const e = block.isPlaceholderData ? undefined : block.data?.entities[i % BLOCK]
    if (!e) return null
    return () => {
      browseFrom({ ...b, at: i, key: e.key })
      navigate({ page: 'entity', blueprint: e.blueprint, key: e.key }, { replace: true })
    }
  }
  return { at, total: b.total, previous: at > 0 ? step(at - 1, before) : null, next: at + 1 < b.total ? step(at + 1, after) : null }
}
