// The order and visibility of a catalog grid's columns. The hub and the web
// app both arrange through this file, so a grid opens the same wherever it is
// read.
//
// An estate keeps one column standard for every grid: ranks of column
// patterns, and the patterns of columns hidden until someone shows them. A
// grid's own layout adds only what a person changed by hand: a column they
// moved, one they hid or showed, a width. What a person changed stays when
// the standard changes, and every column they did not touch follows it.

/** A grid column id: `status`, `title`, `key`, `state`, `owner`, `lastSeenAt`, `updatedAt`, or `f:` a field, `r:` a relation, `i:` what points here, `s:` a scorecard, `u:` a scorecard rule, `a:` an action. */
export type ColumnId = string

/**
 * One rank of the standard. A column takes the first rank with a pattern that
 * matches it, and sits in the rank's pattern order, then the blueprint's own.
 * A pattern is a column id with `*` for any run of characters, or `@pivot`
 * (an object field pivoted into columns) or `@pivoted` (a column a pivot made).
 */
export interface ColumnRank {
  id: string
  title?: string
  description?: string
  columns: string[]
}

export interface ColumnStandard {
  /** The ranks, first to last. A column no rank matches sits where the rank holding `*` is, or after every rank. */
  ranks: ColumnRank[]
  /** Columns hidden until someone shows them, as patterns. A pattern starting `!` shows what an earlier one hid; the last that matches wins. */
  hidden?: string[]
  /** The width a column opens at, by pattern; the first pattern that names it wins. Such as `f:portal: 44`, a link column as wide as its icon. */
  widths?: Record<string, number>
  /** The git source that declares the standard; while it does, only git changes it. */
  source?: string
}

/** What the standard needs to know of a column. */
export interface ColumnFacts {
  id: ColumnId
  /** A field that pivots an object into columns. */
  pivot?: boolean
  /** A column a pivot made. */
  pivoted?: boolean
}

/**
 * A column in a grid's own layout. `after` places it by hand: right after
 * that column, or first when null. Left out, the standard places it. `hidden`
 * left out lets the standard say.
 */
export interface LayoutColumn {
  id: ColumnId
  width?: number
  hidden?: boolean
  after?: ColumnId | null
}

/**
 * The standard a hub holds when its estate declares none: the order the grid
 * has always opened in, title first and what the hub keeps last, with
 * scorecard rules and actions hidden.
 */
export const DEFAULT_STANDARD: ColumnStandard = {
  ranks: [
    { id: 'identity', columns: ['status', 'title'] },
    { id: 'fields', columns: ['f:*'] },
    { id: 'relations', columns: ['r:*', 'i:*'] },
    { id: 'scorecards', columns: ['s:*', 'u:*'] },
    { id: 'actions', columns: ['a:*'] },
    { id: 'record', columns: ['key', 'state', 'owner', 'lastSeenAt', 'updatedAt'] },
  ],
  hidden: ['u:*', 'a:*'],
}

const patterns = new Map<string, RegExp>()
function compiled(pattern: string): RegExp {
  let re = patterns.get(pattern)
  if (!re) {
    re = new RegExp(`^${pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`)
    patterns.set(pattern, re)
  }
  return re
}

/** True when a pattern names the column. */
export function matchesColumn(pattern: string, column: ColumnFacts): boolean {
  if (pattern === '@pivot') return !!column.pivot
  if (pattern === '@pivoted') return !!column.pivoted
  return compiled(pattern).test(column.id)
}

/** Where the standard places a column: its rank, and its pattern inside the rank. A column no rank names takes the `*` rank, or comes after every rank. */
export function rankOf(standard: ColumnStandard, column: ColumnFacts): [number, number] {
  let rest: [number, number] = [standard.ranks.length, 0]
  for (const [r, rank] of standard.ranks.entries()) {
    for (const [p, pattern] of rank.columns.entries()) {
      if (pattern === '*') {
        rest = [r, p]
        continue
      }
      if (matchesColumn(pattern, column)) return [r, p]
    }
  }
  return rest
}

/** True when the standard hides the column until someone shows it. */
export function hiddenByStandard(standard: ColumnStandard, column: ColumnFacts): boolean {
  let hidden = false
  for (const pattern of standard.hidden ?? []) {
    const shows = pattern.startsWith('!')
    if (matchesColumn(shows ? pattern.slice(1) : pattern, column)) hidden = !shows
  }
  return hidden
}

/** The width the standard opens a column at, or undefined to leave it to the grid. */
export function widthByStandard(standard: ColumnStandard, column: ColumnFacts): number | undefined {
  for (const [pattern, width] of Object.entries(standard.widths ?? {})) if (matchesColumn(pattern, column)) return width
  return undefined
}

/** Every column in the order the standard gives it. `columns` is in the blueprint's own order, which breaks ties. */
export function standardOrder(standard: ColumnStandard, columns: ColumnFacts[]): ColumnFacts[] {
  const placed = columns.map((column, at) => ({ column, at, rank: rankOf(standard, column) }))
  placed.sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1] || a.at - b.at)
  return placed.map((p) => p.column)
}

/**
 * A layout saved before the standard listed every column in the order a
 * person left them. It is read as that person placing each listed column
 * after the one before it, shown unless it was hidden, so such a grid opens
 * as it did.
 */
export function fromLegacy(columns: { id: ColumnId; width?: number; hidden?: boolean }[]): LayoutColumn[] {
  return columns.map((c, i) => ({ ...c, hidden: c.hidden ?? false, after: i === 0 ? null : columns[i - 1]!.id }))
}

/** One column as the grid draws it: shown or hidden, its width when a person or the standard set one, and whether a person placed or sized it. */
export interface Arranged {
  id: ColumnId
  hidden: boolean
  width?: number
  moved: boolean
  sized: boolean
}

/**
 * Every column the grid has, in the order it draws them, hidden ones in their
 * place: the standard's order, with each column a person moved put right
 * after the column they put it after. A move whose anchor is gone, or moved
 * itself and not placed, falls back to the column's standard place.
 */
export function arrange(standard: ColumnStandard, columns: ColumnFacts[], layout: LayoutColumn[]): Arranged[] {
  const present = new Map(columns.map((c) => [c.id, c]))
  const own = new Map(layout.filter((l) => present.has(l.id)).map((l) => [l.id, l]))
  const moves = layout.filter((l) => present.has(l.id) && l.after !== undefined)
  const moving = new Set(moves.map((l) => l.id))
  const order = standardOrder(standard, columns)
  const out: ColumnId[] = order.filter((c) => !moving.has(c.id)).map((c) => c.id)

  // Columns placed after the same column keep the order they were saved in: a later one goes past the hand-placed run already there.
  const placed = new Set<ColumnId>()
  let pending = moves
  for (;;) {
    const left: LayoutColumn[] = []
    for (const move of pending) {
      const anchor = move.after ?? null
      const at = anchor === null ? -1 : out.indexOf(anchor)
      if (anchor !== null && at < 0) {
        left.push(move)
        continue
      }
      let index = at + 1
      while (index < out.length && placed.has(out[index]!)) index++
      out.splice(index, 0, move.id)
      placed.add(move.id)
    }
    if (left.length === 0 || left.length === pending.length) {
      // What cannot be placed by hand goes where the standard puts it: before the first column the standard puts after it.
      for (const move of left) {
        const rank = order.findIndex((c) => c.id === move.id)
        const next = out.findIndex((id) => order.findIndex((c) => c.id === id) > rank)
        out.splice(next < 0 ? out.length : next, 0, move.id)
      }
      break
    }
    pending = left
  }

  return out.map((id) => {
    const mine = own.get(id)
    const column = present.get(id)!
    const width = mine?.width ?? widthByStandard(standard, column)
    return { id, hidden: mine?.hidden ?? hiddenByStandard(standard, column), ...(width !== undefined ? { width } : {}), moved: moving.has(id), sized: mine?.width !== undefined }
  })
}

/**
 * The layout a person's move leaves: the moved column placed right after the
 * column now before it in `drawn`, the order after the move. Every other
 * column placed by hand is placed again after the column now before it, so
 * the grid draws exactly what the person dropped: a column dropped in front
 * of one placed by hand stays in front of it, and one placed after the moved
 * column stays where it was. A column the standard places is left to it.
 */
export function placeByHand(layout: LayoutColumn[], drawn: ColumnId[], id: ColumnId): LayoutColumn[] {
  const before = (column: ColumnId): ColumnId | null => {
    const at = drawn.indexOf(column)
    return at <= 0 ? null : drawn[at - 1]!
  }
  const kept = layout.find((l) => l.id === id)
  const others = layout.filter((l) => l.id !== id).map((l) => (l.after === undefined || !drawn.includes(l.id) ? l : { ...l, after: before(l.id) }))
  return [...others, { ...kept, id, after: before(id) }]
}

/** The layout with one column back where the standard puts it. */
export function placeByStandard(layout: LayoutColumn[], id: ColumnId): LayoutColumn[] {
  return layout.flatMap((l) => {
    if (l.id !== id) return [l]
    const { after: _after, ...rest } = l
    return Object.keys(rest).length > 1 ? [rest] : []
  })
}

/** The layout with one column back at the width the standard gives it. */
export function sizeByStandard(layout: LayoutColumn[], id: ColumnId): LayoutColumn[] {
  return layout.flatMap((l) => {
    if (l.id !== id) return [l]
    const { width: _width, ...rest } = l
    return Object.keys(rest).length > 1 ? [rest] : []
  })
}

/** The layout with one column shown or hidden by hand, or left to the standard when that is what the standard says. */
export function showByHand(standard: ColumnStandard, column: ColumnFacts, layout: LayoutColumn[], hidden: boolean): LayoutColumn[] {
  const kept = layout.find((l) => l.id === column.id) ?? { id: column.id }
  const { hidden: _hidden, ...rest } = kept
  const next: LayoutColumn = hidden === hiddenByStandard(standard, column) ? rest : { ...rest, hidden }
  const others = layout.filter((l) => l.id !== column.id)
  return Object.keys(next).length > 1 ? [...others, next] : others
}
