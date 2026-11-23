// Layout maths both sides share: the card sizes and the
// compaction that lets a box close or a card open without anything being
// rewritten. A stored position is always the fully expanded one; `compact`
// turns stored positions into shown ones for the current set of shrunk or
// grown cards, and `expand` is its inverse for a card someone has just dropped.
// `squeeze` closes the room hidden cards left, before either.

/** Space between cards. */
export const GAP = 16

/** A blueprint card on the model page, and one row of its field table. */
export const MODEL_W = 260
export const MODEL_H = 44
export const MODEL_ROW = 24


export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface Size {
  w: number
  h: number
}

export type Point = { x: number; y: number }

/** True when two spans share any length. */
const overlaps = (a0: number, a1: number, b0: number, b1: number): boolean => a0 < b1 && b0 < a1

/** Half a pixel, so a card flush against a box's edge still counts as beside it. */
const EPS = 0.5

/** The nodes whose shown size differs from their stored one, with the difference. */
function changes(rects: Record<string, Rect>, shown: Record<string, Size>): { id: string; r: Rect; dx: number; dy: number }[] {
  const out: { id: string; r: Rect; dx: number; dy: number }[] = []
  for (const [id, s] of Object.entries(shown)) {
    const r = rects[id]
    if (!r) continue
    const dx = r.w - s.w
    const dy = r.h - s.h
    if (dx || dy) out.push({ id, r, dx, dy })
  }
  return out
}

/**
 * The shift a card at stored rect `me` gets: everything that sits past a
 * changed card's stored extent, in the same band, moves by the change.
 */
function shiftOf(id: string, me: Rect, changed: { id: string; r: Rect; dx: number; dy: number }[]): Point {
  let x = 0
  let y = 0
  for (const c of changed) {
    if (c.id === id) continue
    if (c.dx && me.x >= c.r.x + c.r.w - EPS && overlaps(me.y, me.y + me.h, c.r.y, c.r.y + c.r.h)) x -= c.dx
    if (c.dy && me.y >= c.r.y + c.r.h - EPS && overlaps(me.x, me.x + me.w, c.r.x, c.r.x + c.r.w)) y -= c.dy
  }
  return { x, y }
}

/**
 * Shown positions for stored rects, given the shown size of every card whose
 * size differs. A card to the right of a shrunk one, in its row band, moves
 * left by the shrink; a card below it, in its column band, moves up. A grown
 * card pushes the same neighbours away. Cards that overlap the changed card's
 * own extent stay.
 */
export function compact(rects: Record<string, Rect>, shown: Record<string, Size>): Record<string, Point> {
  const changed = changes(rects, shown)
  const out: Record<string, Point> = {}
  for (const [id, r] of Object.entries(rects)) {
    const s = changed.length ? shiftOf(id, r, changed) : { x: 0, y: 0 }
    out[id] = { x: r.x + s.x, y: r.y + s.y }
  }
  return out
}

/**
 * The stored position for a card dropped at a shown position: the inverse of
 * `compact` for one card. Where a shrunk card's old extent makes two stored
 * positions show at the same place, the one past the card wins, so a drop
 * beside a closed box lands beside its open one too. Each axis is solved
 * exactly by scanning the changed cards in order; the two are alternated
 * until the band each depends on settles.
 */
export function expand(id: string, at: Point, size: Size, rects: Record<string, Rect>, shown: Record<string, Size>): Point {
  const changed = changes(rects, shown).filter((c) => c.id !== id)
  if (!changed.length) return { ...at }
  let sx = at.x
  let sy = at.y
  for (let i = 0; i < 6; i++) {
    const nx = solve(at.x, changed.filter((c) => c.dx && overlaps(sy, sy + size.h, c.r.y, c.r.y + c.r.h)).map((c) => ({ edge: c.r.x + c.r.w, d: c.dx })))
    const ny = solve(at.y, changed.filter((c) => c.dy && overlaps(nx, nx + size.w, c.r.x, c.r.x + c.r.w)).map((c) => ({ edge: c.r.y + c.r.h, d: c.dy })))
    if (nx === sx && ny === sy) break
    sx = nx
    sy = ny
  }
  return { x: sx, y: sy }
}

/** One axis: shown = stored - sum of `d` over edges at or before stored. Picks the furthest stored value that shows at `shownAt`. */
function solve(shownAt: number, steps: { edge: number; d: number }[]): number {
  const sorted = [...steps].sort((a, b) => a.edge - b.edge)
  let sum = 0
  const prefix = [0]
  for (const s of sorted) {
    sum += s.d
    prefix.push(sum)
  }
  for (let k = sorted.length; k >= 0; k--) {
    const stored = shownAt + prefix[k]!
    const passedLast = k === 0 || sorted[k - 1]!.edge - EPS <= stored
    const beforeNext = k === sorted.length || sorted[k]!.edge - EPS > stored
    if (passedLast && beforeNext) return stored
  }
  return shownAt
}

/**
 * One gap between the shown cards along an axis, stored from `a` to `b`,
 * shown `len` long. Inside it a point scales, so the squeeze can be undone.
 */
interface Fold {
  a: number
  b: number
  len: number
}

/** The room the hidden cards left on the model page, closed up, one axis at a time. */
export interface Squeeze {
  x: Fold[]
  y: Fold[]
}

/** The room a closed gap keeps: the widest a laid-out model leaves between its cards. */
export const ROOM = GAP * 8

/** The spans a set of rects covers along one axis, merged and in order. */
function spans(rects: Rect[], axis: 'x' | 'y'): [number, number][] {
  const size = axis === 'x' ? 'w' : 'h'
  const sorted = rects.map((r): [number, number] => [r[axis], r[axis] + r[size]]).sort((p, q) => p[0] - q[0])
  const out: [number, number][] = []
  for (const s of sorted) {
    const last = out.at(-1)
    if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1])
    else out.push([...s])
  }
  return out
}

function folds(shown: Rect[], hidden: Rect[], axis: 'x' | 'y'): Fold[] {
  const mine = spans(shown, axis)
  const theirs = spans(hidden, axis)
  const out: Fold[] = []
  for (let i = 1; i < mine.length; i++) {
    const a = mine[i - 1]![1]
    const b = mine[i]![0]
    if (b - a > ROOM && theirs.some(([s, e]) => s < b && e > a)) out.push({ a, b, len: ROOM })
  }
  return out
}

/**
 * How to close the room hidden cards left between the shown ones. Along each
 * axis, a gap between shown cards that a hidden card sits in closes to `ROOM`.
 * A gap no hidden card sits in stays as it was, so a model with nothing
 * hidden shows exactly as stored.
 */
export function squeeze(shown: Rect[], hidden: Rect[]): Squeeze {
  return { x: folds(shown, hidden, 'x'), y: folds(shown, hidden, 'y') }
}

function along(v: number, fs: Fold[]): number {
  let out = v
  for (const f of fs) {
    if (v >= f.b) out -= f.b - f.a - f.len
    else if (v > f.a) out -= (v - f.a) * (1 - f.len / (f.b - f.a))
  }
  return out
}

function back(v: number, fs: Fold[]): number {
  let shift = 0
  for (const f of fs) {
    const start = f.a - shift
    if (v >= start + f.len) shift += f.b - f.a - f.len
    else if (v > start) return f.a + ((v - start) * (f.b - f.a)) / f.len
    else break
  }
  return v + shift
}

/** Where a stored point shows once the squeeze closes the room. */
export function squeezed(p: Point, s: Squeeze): Point {
  return { x: along(p.x, s.x), y: along(p.y, s.y) }
}

/** The stored point that shows at `p`, to the pixel: the inverse of `squeezed`. */
export function unsqueezed(p: Point, s: Squeeze): Point {
  return { x: Math.round(back(p.x, s.x)), y: Math.round(back(p.y, s.y)) }
}
