// Where each thing lands on the atlas: the planet a map is drawn as, the
// islands a ground is drawn as, the sky, and the flowers of a continent and
// a garden. Every
// function here is pure: it works out positions from the data it is given,
// the same each time, so a picture never moves unless what it shows did.
// Drawing is the components' work (components/Atlas.tsx, Map.tsx, Ground.tsx).

import { standingOf, type Lifts, type MapLadder, type MapMember, type MapPlace, type MapPlot, type MapThing, type MapView } from '../shared/map.ts'
import type { StatusLevel } from '../shared/model.ts'

export type Point = [number, number]

// Hex geometry -----------------------------------------------------------------

const SQ3 = Math.sqrt(3)
/** The six neighbours of a hex, in axial steps. */
export const DIRS: readonly Point[] = [
  [1, 0],
  [1, -1],
  [0, -1],
  [-1, 0],
  [-1, 1],
  [0, 1],
]
/** The first corner of the edge a hex shares with each neighbour, in the order of `DIRS`. */
export const DIR_V = [0, 5, 4, 3, 2, 1] as const

export const hexKey = (q: number, r: number) => `${q},${r}`
/** The middle of a hex of size `s`, pointy side up. */
export const hexCenter = (q: number, r: number, s: number): Point => [s * SQ3 * (q + r / 2), s * 1.5 * r]
/** One corner of a hex, 0 to 5. */
export const hexCorner = (x: number, y: number, s: number, i: number): Point => {
  const a = (Math.PI / 180) * (60 * i - 30)
  return [x + s * Math.cos(a), y + s * Math.sin(a)]
}

/** The hex a point falls in. */
export function hexAt(x: number, y: number, s: number): Point {
  const q = ((SQ3 / 3) * x - y / 3) / s
  const r = ((2 / 3) * y) / s
  const z = -q - r
  let rq = Math.round(q)
  let rr = Math.round(r)
  const rz = Math.round(z)
  const dq = Math.abs(rq - q)
  const dr = Math.abs(rr - r)
  const dz = Math.abs(rz - z)
  if (dq > dr && dq > dz) rq = -rr - rz
  else if (dr > dz) rr = -rq - rz
  return [rq, rr]
}

/** A smooth roughness over the plane, so a coast is ragged the same way each time. */
const noise = (x: number, y: number) => Math.sin(x * 0.23 + 1.7) * Math.cos(y * 0.19 - 0.4) + 0.6 * Math.sin((x + y) * 0.37 + 2.1) + 0.4 * Math.sin(x * 0.61 - y * 0.47 + 0.3)

export interface Growing {
  /** Where it starts, in the plane. */
  seed: Point
  /** How many cells it grows to. */
  target: number
}

/**
 * Grows each group as one mass of hex cells, all at once so none starves,
 * each keeping a channel of one cell from the others. Each group gets
 * exactly its target where there is room. Returns each group's cells in the
 * order they grew: nearest its seed first.
 */
export function grow(groups: readonly Growing[], s: number, inside: (q: number, r: number) => boolean, rough = 2.4): Point[][] {
  const owner = new Map<string, number>()
  const cells: Point[][] = groups.map(() => [])
  const frontier = groups.map(() => new Map<string, Point>())
  const free = (q: number, r: number, gi: number) => {
    if (owner.has(hexKey(q, r)) || !inside(q, r)) return false
    return DIRS.every(([dq, dr]) => {
      const o = owner.get(hexKey(q + dq, r + dr))
      return o === undefined || o === gi
    })
  }
  const add = (gi: number, q: number, r: number) => {
    owner.set(hexKey(q, r), gi)
    cells[gi]!.push([q, r])
    frontier[gi]!.delete(hexKey(q, r))
    for (const [dq, dr] of DIRS) if (!owner.has(hexKey(q + dq, r + dr))) frontier[gi]!.set(hexKey(q + dq, r + dr), [q + dq, r + dr])
  }
  groups.forEach((g, gi) => {
    if (g.target <= 0) return
    let [q, r] = hexAt(g.seed[0], g.seed[1], s)
    // A seed that lands on another's ground walks out to the nearest free cell.
    for (let ring = 0; owner.has(hexKey(q, r)) && ring < 400; ring++) [q, r] = [q + 1, r]
    add(gi, q, r)
  })
  const max = Math.max(1, ...groups.map((g) => g.target))
  const credit = groups.map(() => 0)
  for (let guard = 0; guard < 100_000 && groups.some((g, gi) => cells[gi]!.length < g.target && credit[gi]! > -1e9); guard++) {
    groups.forEach((g, gi) => {
      if (cells[gi]!.length >= g.target) return
      credit[gi]! += g.target / max
      while (credit[gi]! >= 1 && cells[gi]!.length < g.target) {
        credit[gi]! -= 1
        let best: Point | null = null
        let bestP = Infinity
        for (const [q, r] of frontier[gi]!.values()) {
          if (!free(q, r, gi)) continue
          const [x, y] = hexCenter(q, r, s)
          const p = Math.hypot(x - g.seed[0], y - g.seed[1]) / s + rough * noise(x / s + gi * 7, y / s - gi * 3)
          if (p < bestP) {
            bestP = p
            best = [q, r]
          }
        }
        // Boxed in by its neighbours: it takes any free cell next to it, channel or not.
        if (!best) for (const [k, cell] of frontier[gi]!) if (!owner.has(k) && inside(cell[0], cell[1])) best = cell
        if (!best) {
          credit[gi] = -2e9
          break
        }
        add(gi, best[0], best[1])
      }
    })
  }
  return cells
}

// The planet ---------------------------------------------------------------------

/** The planet is drawn on a square of this side, its middle at `C`, its radius `R`. */
export const PLANET = { side: 1000, C: 500, R: 372 } as const

/** A plot where it runs on one place: the plot, its placing's status there, and what was deployed in it there. */
export interface Patch {
  plot: MapPlot
  level: StatusLevel
  members: MapMember[]
}

/** Each plot placed on a place, with what it runs there. */
export function patchesOn(map: Pick<MapView, 'plots' | 'members'>, place: string): Patch[] {
  const out: Patch[] = []
  for (const plot of map.plots) {
    const at = plot.at.find((a) => a.place === place)
    if (!at) continue
    out.push({
      plot,
      level: at.level,
      members: map.members.filter((m) => m.plot === plot.key && m.place === place),
    })
  }
  return out
}

/** What is tied to no place: the members on none, and every plot, for the checks that are its own wherever it runs. It is drawn apart from every place. */
export function nowhereOf(map: Pick<MapView, 'plots' | 'members'>): {
  plots: MapPlot[]
  members: MapMember[]
} {
  return {
    plots: map.plots,
    members: map.members.filter((m) => m.place === null),
  }
}

/** One kind of thing on the open ground of one place: the members there of one blueprint that sit in no plot. */
export interface OpenPatch {
  blueprint: string
  members: MapMember[]
}

/** The open ground of a place, kind by kind, the biggest kind first. */
export function openOn(map: Pick<MapView, 'members'>, place: string | null): OpenPatch[] {
  const by = new Map<string, MapMember[]>()
  for (const m of map.members) if (m.place === place && (place === null || !m.plot)) by.set(m.blueprint, [...(by.get(m.blueprint) ?? []), m])
  return [...by.entries()].map(([blueprint, members]) => ({ blueprint, members })).sort((a, b) => b.members.length - a.members.length || a.blueprint.localeCompare(b.blueprint))
}

export interface PlanetCell {
  q: number
  r: number
  /** Its middle on the globe. */
  x: number
  y: number
  /** Its corners on the globe. */
  poly: Point[]
  /** The index of its land in `Planet.lands`. */
  land: number
  /** A plot where it runs on this place, or one part's things of one kind on the place's open ground. */
  patch: Patch | null
  open: OpenPatch | null
  /** The part whose region it lies in: its plot's, or its open ground's. */
  part: string
  /** Every part its things belong to, the holder among them. */
  parts: string[]
  /** The things that sit on this place and that the cell is painted by: a plot's members there, or the members of the kind. A plot's own checks are not here: they are tied to no place. */
  here: MapThing[]
}

export interface PlanetLand {
  place: MapPlace
  patches: Patch[]
  open: OpenPatch[]
  cells: PlanetCell[]
  /** The middle of its cells, and its highest point, on the globe. */
  middle: Point
  top: number
}

export interface Planet {
  lands: PlanetLand[]
  cells: PlanetCell[]
  /** Each cell by its hex, to find its neighbours. */
  at: Map<string, PlanetCell>
}

/** Wraps a point of the flat disk the land grows on onto the near half of a sphere, so the land bunches toward the rim as a globe's does. */
export function onSphere(x: number, y: number, flatR: number): Point {
  const rf = Math.hypot(x, y)
  if (!rf) return [PLANET.C, PLANET.C]
  const th = (rf / flatR) * (Math.PI / 2) * 0.96
  const rp = PLANET.R * Math.sin(th)
  return [PLANET.C + (x / rf) * rp, PLANET.C + (y / rf) * rp]
}

/** Where each land starts: round a ring from the upper left, the biggest first. */
function seeds(sizes: readonly number[], flatR: number): Point[] {
  const n = sizes.length
  if (n === 1) return [[0, 0]]
  const order = sizes.map((v, i) => [v, i] as const).sort((a, b) => b[0] - a[0])
  const out: Point[] = sizes.map(() => [0, 0])
  // Every land starts on the ring, the smallest too, so each lies against the rim and names itself with a short line from the sea beyond it.
  const ring = order
  ring.forEach(([, i], k) => {
    const a = -2.3 + (k / ring.length) * Math.PI * 2
    out[i] = [Math.cos(a) * flatR * 0.42, Math.sin(a) * flatR * 0.42]
  })
  return out
}

const sizeOf = (m: { checks: unknown[] }[]) => m.length

/**
 * Shares some hexes among groups so that each group's hexes lie together as
 * one cluster: `sizes[i]` hexes to group `i`. The smallest group is cut first,
 * from the tip of what is left that lies furthest from its middle, taking the
 * free hexes next to it nearest its start; the largest keeps what remains, the
 * middle. Each group's hexes come nearest its start first.
 */
export function clusterHexes(hexes: readonly Point[], sizes: readonly number[]): Point[][] {
  const free = new Map(hexes.map((h) => [hexKey(h[0], h[1]), h]))
  const gap = (a: Point, b: Point) => {
    const [ax, ay] = hexCenter(a[0], a[1], 1)
    const [bx, by] = hexCenter(b[0], b[1], 1)
    return Math.hypot(ax - bx, ay - by)
  }
  // The middle of some hexes, as a hex that need not be whole.
  const middle = (list: readonly Point[]): Point => {
    const [x, y] = middleOf(list.map((h) => hexCenter(h[0], h[1], 1)))
    const r = y / 1.5
    return [x / SQ3 - r / 2, r]
  }
  const first = (list: readonly Point[], score: (h: Point) => number) => list.reduce((best, h) => (score(h) - score(best) || h[0] - best[0] || h[1] - best[1]) < 0 ? h : best)
  const order = sizes.map((n, i) => [n, i] as const).sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const out: Point[][] = sizes.map(() => [])
  order.forEach(([size, g], k) => {
    if (!size || !free.size) return
    const left = [...free.values()]
    if (k === order.length - 1) {
      const mid = middle(left)
      out[g] = left.sort((a, b) => gap(a, mid) - gap(b, mid) || a[0] - b[0] || a[1] - b[1]).slice(0, size)
      return
    }
    const mid = middle(left)
    const seed = first(left, (h) => -gap(h, mid))
    const take = [seed]
    free.delete(hexKey(seed[0], seed[1]))
    while (take.length < size && free.size) {
      const beside = take.flatMap(([q, r]) => DIRS.map(([dq, dr]) => free.get(hexKey(q + dq, r + dr)))).filter((h): h is Point => !!h)
      // Boxed in: it takes the nearest free hex, wherever that is.
      const next = first(beside.length ? beside : [...free.values()], (h) => gap(h, seed))
      take.push(next)
      free.delete(hexKey(next[0], next[1]))
    }
    out[g] = take
  })
  return out
}

/**
 * The map as a planet, at one grain: one land a place, one cell each plot
 * that runs there and one cell each part's things of one kind on its open ground, the
 * each land grown on a flat disk and wrapped onto a globe. On a land the
 * ground of one part lies together as one cluster, a region: its plots, with
 * its open ground round them. What sits in a cell is drawn a level down.
 */
export function planetOf(map: MapView): Planet {
  const parts = [map.holder.key, ...map.parts.map((p) => p.key)]
  const rank = (part: string) => parts.indexOf(part)
  // Open ground is cut part by part, so each cell lies in one part's region: one cell a part's things of one kind there.
  const byPart = (o: OpenPatch): OpenPatch[] => [...new Set(o.members.map((m) => m.part))].sort((x, y) => rank(x) - rank(y)).map((part) => ({ blueprint: o.blueprint, members: o.members.filter((m) => m.part === part) }))
  const plan = map.places.map((place) => ({ place, patches: patchesOn(map, place.key), open: openOn(map, place.key).flatMap(byPart) }))
  const total = plan.reduce((n, p) => n + p.patches.length + p.open.length, 0)
  const s = 10
  // The disk holds the land at about half its area, and is never so small that a few cells fill the globe.
  const flatR = Math.max(s * 12, Math.sqrt((total * 2.6 * s * s) / (0.5 * Math.PI)))
  const at = seeds(
    plan.map((p) => p.patches.length + p.open.length),
    flatR,
  )
  const inside = (q: number, r: number) => {
    const [x, y] = hexCenter(q, r, s)
    return Math.hypot(x, y) < flatR - s * 2
  }
  const grown = grow(
    plan.map((p, i) => ({ seed: at[i]!, target: p.patches.length + p.open.length })),
    s,
    inside,
  )
  const lands: PlanetLand[] = []
  const cells: PlanetCell[] = []
  plan.forEach((p, li) => {
    const order = grown[li]!
    // What the land holds, each with the part it belongs to: a garden its plot's, a patch of open ground its things'.
    const gardens = [...p.patches].sort((a, b) => sizeOf(b.members) - sizeOf(a.members) || a.plot.title.localeCompare(b.plot.title))
    const held = [...gardens.map((patch) => ({ part: patch.plot.part, patch, open: null })), ...p.open.map((open) => ({ part: open.members[0]?.part ?? map.holder.key, patch: null, open }))]
    // Each part's ground is one cluster of the land, its gardens nearest the cluster's start and its open ground round them.
    const here = [...new Set(held.map((h) => h.part))].sort((x, y) => rank(x) - rank(y))
    const clusters = clusterHexes(
      order.slice(0, held.length),
      here.map((part) => held.filter((h) => h.part === part).length),
    )
    const mine: PlanetCell[] = []
    const cell = (q: number, r: number, part: string, patch: Patch | null, open: OpenPatch | null): PlanetCell => {
      const [fx, fy] = hexCenter(q, r, s)
      const [x, y] = onSphere(fx, fy, flatR)
      const poly = [0, 1, 2, 3, 4, 5].map((i) => {
        const [cx, cy] = hexCorner(fx, fy, s * 1.01, i)
        return onSphere(cx, cy, flatR)
      })
      const here: MapThing[] = patch ? patch.members : (open?.members ?? [])
      return { q, r, x, y, poly, land: li, patch, open, part, parts: [...new Set(patch ? [patch.plot.part, ...patch.members.map((m) => m.part)] : here.map((m) => m.part))], here }
    }
    here.forEach((part, k) => held.filter((h) => h.part === part).forEach((h, i) => mine.push(cell(clusters[k]![i]![0], clusters[k]![i]![1], part, h.patch, h.open))))
    cells.push(...mine)
    const middle = mine.length ? middleOf(mine.map((c) => [c.x, c.y])) : ([PLANET.C, PLANET.C] as Point)
    lands.push({ place: p.place, patches: p.patches, open: p.open, cells: mine, middle, top: mine.length ? Math.min(...mine.map((c) => c.y)) : PLANET.C })
  })
  return { lands, cells, at: new Map(cells.map((c) => [hexKey(c.q, c.r), c])) }
}

const middleOf = (pts: readonly Point[]): Point => (pts.length ? [pts.reduce((n, p) => n + p[0], 0) / pts.length, pts.reduce((n, p) => n + p[1], 0) / pts.length] : [0, 0])
/** The edges of the planet's cells that face the sea or another land, as one path: each land's coast. */
export const planetCoast = (planet: Planet): string => planetEdges(planet, (c, n) => n.land === c.land)

/** The edges round some of the planet's cells, as one path: every edge of a cell `of` keeps whose neighbour is no cell, is not kept, or is not `joined` to it. */
export function planetEdges(planet: Planet, joined: (c: PlanetCell, n: PlanetCell) => boolean, of: (c: PlanetCell) => boolean = () => true): string {
  let coast = ''
  for (const c of planet.cells) {
    if (!of(c)) continue
    DIRS.forEach(([dq, dr], d) => {
      const n = planet.at.get(hexKey(c.q + dq, c.r + dr))
      if (n && of(n) && joined(c, n)) return
      const a = c.poly[DIR_V[d]!]!
      const b = c.poly[(DIR_V[d]! + 1) % 6]!
      coast += `M${a[0].toFixed(1)} ${a[1].toFixed(1)}L${b[0].toFixed(1)} ${b[1].toFixed(1)}`
    })
  }
  return coast
}

/** Points as an SVG polygon's list. */
export const pointsOf = (poly: readonly Point[]) => poly.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')

// The islands of a ground ------------------------------------------------------

/** The folder a key sits in: every segment of it but the last. A key with no folder sits in none. */
export function folderOf(key: string): string {
  const at = key.lastIndexOf('/')
  return at > 0 ? key.slice(0, at) : ''
}

/** The name an island is called by: the last segment of its folder. */
export const folderName = (folder: string) => folder.slice(folder.lastIndexOf('/') + 1)

export interface Island<T> {
  /** The folder its keys share, or null for the island of the few. */
  folder: string | null
  items: T[]
}

export interface IslandCell<T> {
  q: number
  r: number
  x: number
  y: number
  island: number
  item: T
}

export interface Archipelago<T> {
  s: number
  islands: Island<T>[]
  cells: IslandCell<T>[]
  at: Map<string, IslandCell<T>>
  /** The box every cell sits in, with room round it for names: x, y, width, height. */
  box: [number, number, number, number]
}

/**
 * A ground as islands: one island a folder of keys, the biggest first, the
 * folders of fewer than `few` gathered on one island of their own. Each
 * settles in the nearest open water along its own bearing, so the whole is
 * one archipelago, wider than tall or taller than wide as the screen is.
 * Within an island, cells are filled nearest the middle first, in the
 * items' given order: worst first lands in the middle.
 */
export function archipelagoOf<T extends { key: string }>(items: readonly T[], { tall = false, long = false, few = 3 }: { tall?: boolean; long?: boolean; few?: number } = {}): Archipelago<T> {
  const by = new Map<string, T[]>()
  for (const it of items) {
    const f = folderOf(it.key)
    by.set(f, [...(by.get(f) ?? []), it])
  }
  const islands: Island<T>[] = []
  const small: T[] = []
  for (const [folder, list] of by) list.length >= few && folder ? islands.push({ folder, items: list }) : small.push(...list)
  islands.sort((a, b) => b.items.length - a.items.length || a.folder!.localeCompare(b.folder!))
  if (small.length) islands.push({ folder: null, items: small })
  const s = 10
  // Islands spread wider than tall, taller than wide (`tall`), or taller still (`long`), for a column beside a long rail.
  const [ax, ay] = long ? [0.62, 1.9] : tall ? [0.9, 1.5] : [1.5, 0.9]
  const owner = new Map<string, number>()
  const hexDist = (q: number, r: number) => (Math.abs(q) + Math.abs(r) + Math.abs(q + r)) / 2
  const clear = (q0: number, r0: number, rad: number) => {
    for (let dq = -rad; dq <= rad; dq++) for (let dr = -rad; dr <= rad; dr++) if (hexDist(dq, dr) <= rad && owner.has(hexKey(q0 + dq, r0 + dr))) return false
    return true
  }
  const grownCells: Point[][] = []
  islands.forEach((isl, ii) => {
    const need = Math.ceil(Math.sqrt(isl.items.length / 3)) + 2
    let seed: Point = [0, 0]
    if (ii) {
      const a = ii * 2.39996 + 0.4
      for (let d = 0; d < 600; d += 0.5) {
        const h = hexAt(Math.cos(a) * d * s * ax, Math.sin(a) * d * s * ay, s)
        if (clear(h[0], h[1], need)) {
          seed = h
          break
        }
      }
    }
    const [sx, sy] = hexCenter(seed[0], seed[1], s)
    const got: Point[] = []
    const front = new Map<string, Point>()
    const add = (q: number, r: number) => {
      owner.set(hexKey(q, r), ii)
      got.push([q, r])
      front.delete(hexKey(q, r))
      for (const [dq, dr] of DIRS) if (!owner.has(hexKey(q + dq, r + dr))) front.set(hexKey(q + dq, r + dr), [q + dq, r + dr])
    }
    add(seed[0], seed[1])
    while (got.length < isl.items.length) {
      let best: Point | null = null
      let bp = Infinity
      for (const [k, [q, r]] of front) {
        if (owner.has(k)) continue
        if (
          DIRS.some(([dq, dr]) => {
            const o = owner.get(hexKey(q + dq, r + dr))
            return o !== undefined && o !== ii
          })
        )
          continue
        const [x, y] = hexCenter(q, r, s)
        const p = Math.hypot(x - sx, (y - sy) * 1.15) / s + 1.3 * noise(x / s + ii * 5, y / s - ii * 2)
        if (p < bp) {
          bp = p
          best = [q, r]
        }
      }
      if (!best) break
      add(best[0], best[1])
    }
    grownCells.push(got)
  })
  const cells: IslandCell<T>[] = []
  islands.forEach((isl, ii) => {
    grownCells[ii]!.forEach(([q, r], i) => {
      const item = isl.items[i]
      if (!item) return
      const [x, y] = hexCenter(q, r, s)
      cells.push({ q, r, x, y, island: ii, item })
    })
  })
  const xs = cells.map((c) => c.x)
  const ys = cells.map((c) => c.y)
  const x0 = Math.min(0, ...xs)
  const y0 = Math.min(0, ...ys)
  const box: [number, number, number, number] = [x0 - s * 14, y0 - s * 6, Math.max(0, ...xs) - x0 + s * 28, Math.max(0, ...ys) - y0 + s * 12]
  return {
    s,
    islands,
    cells,
    at: new Map(cells.map((c) => [hexKey(c.q, c.r), c])),
    box,
  }
}

/** The edges between islands and the sea, as one path. */
export function islandCoast<T>(arch: Archipelago<T>): string {
  let out = ''
  for (const c of arch.cells)
    DIRS.forEach(([dq, dr], d) => {
      const n = arch.at.get(hexKey(c.q + dq, c.r + dr))
      if (n && n.island === c.island) return
      const a = hexCorner(c.x, c.y, arch.s, DIR_V[d]!)
      const b = hexCorner(c.x, c.y, arch.s, (DIR_V[d]! + 1) % 6)
      out += `M${a[0].toFixed(1)} ${a[1].toFixed(1)}L${b[0].toFixed(1)} ${b[1].toFixed(1)}`
    })
  return out
}

// Labels that keep out of each other's way ---------------------------------------

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

const crosses = (a: Box, b: Box, gap = 0) => a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap

/**
 * Places each label at the first of its candidate boxes that runs into no
 * label placed before it and no obstacle, in the order given: what matters
 * most goes first. A label with no free place is left out (null), never
 * drawn over another. An obstacle that names an `owner` stands in the way
 * of every label but that one: a land does not keep its own name off it.
 * `within` keeps every label inside the picture.
 */
export function placeLabels(candidates: readonly Box[][], obstacles: readonly (Box & { owner?: number })[] = [], gap = 2, within?: Box): (Box | null)[] {
  const placed: Box[] = []
  const inside = (b: Box) => !within || (b.x >= within.x && b.y >= within.y && b.x + b.w <= within.x + within.w && b.y + b.h <= within.y + within.h)
  return candidates.map((options, i) => {
    const free = options.find((b) => inside(b) && !placed.some((p) => crosses(p, b, gap)) && !obstacles.some((o) => o.owner !== i && crosses(o, b, gap)))
    if (free) placed.push(free)
    return free ?? null
  })
}

/** Whether the line from `a` to `b` runs through the box, its edge widened by `gap`. */
export function lineHits(a: Point, b: Point, box: Box, gap = 0): boolean {
  const [x0, y0, x1, y1] = [box.x - gap, box.y - gap, box.x + box.w + gap, box.y + box.h + gap]
  let lo = 0
  let hi = 1
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  for (const [p, q] of [
    [-dx, a[0] - x0],
    [dx, x1 - a[0]],
    [-dy, a[1] - y0],
    [dy, y1 - a[1]],
  ] as const) {
    if (p === 0) {
      if (q < 0) return false
      continue
    }
    const r = q / p
    if (p < 0) lo = Math.max(lo, r)
    else hi = Math.min(hi, r)
    if (lo > hi) return false
  }
  return true
}

/** The point of a box nearest `p`: where a line from `p` meets the box. */
export const nearestOn = (box: Box, p: Point): Point => [Math.min(box.x + box.w, Math.max(box.x, p[0])), Math.min(box.y + box.h, Math.max(box.y, p[1]))]

/**
 * Pushes markers that sit on each other apart, round the middle of the
 * crowd they make, so each can be read and picked. A marker alone stays
 * where it is. Returns where each is drawn.
 */
export function fanOut(points: readonly Point[], minGap: number): Point[] {
  const out = points.map((p) => [p[0], p[1]] as Point)
  const seen = new Set<number>()
  for (let i = 0; i < out.length; i++) {
    if (seen.has(i)) continue
    // The crowd: every marker within reach of one already in it.
    const crowd = [i]
    seen.add(i)
    for (let k = 0; k < crowd.length; k++)
      for (let j = 0; j < out.length; j++) {
        if (seen.has(j)) continue
        const a = points[crowd[k]!]!
        const b = points[j]!
        if (Math.hypot(a[0] - b[0], a[1] - b[1]) < minGap) {
          seen.add(j)
          crowd.push(j)
        }
      }
    if (crowd.length < 2) continue
    const mid = middleOf(crowd.map((c) => points[c]!))
    const radius = Math.max(minGap, (minGap * crowd.length) / (2 * Math.PI))
    crowd
      .sort((a, b) => a - b)
      .forEach((c, k) => {
        const a = -Math.PI / 2 + (k / crowd.length) * Math.PI * 2
        out[c] = [mid[0] + Math.cos(a) * radius, mid[1] + Math.sin(a) * radius]
      })
  }
  return out
}

// A flower ---------------------------------------------------------------------

/** How a petal stands: at the top of its ladder, stopped short by a broken check, or stopped by one with no data. */
export type PetalKind = 'top' | 'short' | 'blind'

export interface Petal {
  d: string
  kind: PetalKind
  ladder: string
}

/** Where a petal would reach at the top of its ladder: drawn behind it, in gold where a plan grows it there. */
export interface PetalGhost {
  d: string
  ladder: string
  grows: boolean
}

export interface FlowerShape {
  /** The side of the square it is drawn in; its heart is in the middle. */
  size: number
  heart: number
  /** The rings a petal grows through: one a rung, the outer one the top of every ladder. Drawn only on a flower of several things. */
  rings: number[]
  ghosts: PetalGhost[]
  petals: Petal[]
  /** A short stroke where a ladder reads no thing of this flower: the petal is not there to grow. */
  stubs: { x1: number; y1: number; x2: number; y2: number; ladder: string }[]
}

const f1 = (v: number) => v.toFixed(1)

/** A petal from the heart's edge at `inner` to `len`, between bearings `b0` and `b1` in degrees, round at the tip. */
function petalPath(c: number, inner: number, len: number, b0: number, b1: number): string {
  const P = (deg: number, r: number) => [c + Math.cos((deg * Math.PI) / 180) * r, c + Math.sin((deg * Math.PI) / 180) * r] as const
  const mid = (b0 + b1) / 2
  const [x0, y0] = P(b0, inner)
  const [x1, y1] = P(b0, inner + (len - inner) * 0.72)
  const [cx1, cy1] = P(b0, len)
  const [xt, yt] = P(mid, len)
  const [cx2, cy2] = P(b1, len)
  const [x2, y2] = P(b1, inner + (len - inner) * 0.72)
  const [x3, y3] = P(b1, inner)
  return `M${f1(x0)} ${f1(y0)}L${f1(x1)} ${f1(y1)}Q${f1(cx1)} ${f1(cy1)} ${f1(xt)} ${f1(yt)}Q${f1(cx2)} ${f1(cy2)} ${f1(x2)} ${f1(y2)}L${f1(x3)} ${f1(y3)}A${f1(inner)} ${f1(inner)} 0 0 0 ${f1(x0)} ${f1(y0)}Z`
}

/**
 * A flower of some things on the ladders of a map: one slice of the circle a
 * ladder, always at the same bearing (the first straight up, the rest round
 * clockwise), so a petal means the same ladder on every flower of the map. In
 * a slice, the things stand side by side, the lowest rung first, each run of
 * one rung one petal as wide as its share and as long as its rung, the top at
 * radius `R`. A flower of one thing is a slim petal a ladder, with the ghost
 * of a full one behind it. What a plan grows to the top has its ghost drawn
 * in gold.
 */
export function flowerOf<T extends Pick<MapThing, 'checks'>>(things: readonly T[], ladders: readonly MapLadder[], R: number, lifts: Lifts<T> = () => false): FlowerShape {
  const pad = 2
  const c = R + pad
  const one = things.length === 1
  const inner = Math.max(2.5, R * (one ? 0.1 : 0.16))
  const n = Math.max(1, ladders.length)
  const slice = 360 / n
  const gap = n === 1 ? 0 : Math.min(10, slice * 0.12)
  const out: FlowerShape = { size: 2 * c, heart: inner * 0.85, rings: one ? [] : [1, 2, 3].map((k) => inner + ((R - inner) * k) / 3), ghosts: [], petals: [], stubs: [] }
  const reach = (reached: number, of: number) => inner + (R - inner) * (reached === 0 ? 0.12 : reached / of)
  ladders.forEach((ladder, i) => {
    const centre = -90 + i * slice
    const stood = things.flatMap((t) => {
      const s = standingOf(t, ladder)
      return s ? [{ t, s, grows: s.stop === 'fail' && lifts(t, ladder.id) }] : []
    })
    if (!stood.length) {
      if (one) {
        const a = (centre * Math.PI) / 180
        out.stubs.push({ x1: c + Math.cos(a) * (inner + 3), y1: c + Math.sin(a) * (inner + 3), x2: c + Math.cos(a) * (inner + R * 0.16), y2: c + Math.sin(a) * (inner + R * 0.16), ladder: ladder.id })
      }
      return
    }
    // Lowest rung first; what stops it, a break before no data; what a plan grows first among its rung.
    const rank = (x: (typeof stood)[number]) => x.s.reached * 4 + (x.s.stop === 'fail' ? 0 : x.s.stop === 'unknown' ? 1 : 2) - (x.grows ? 0.5 : 0)
    stood.sort((a, b) => rank(a) - rank(b))
    const width = one ? Math.min(slice - gap, 46) : slice - gap
    const start = centre - width / 2
    const step = width / stood.length
    let k = 0
    while (k < stood.length) {
      const first = stood[k]!
      let end = k
      while (end + 1 < stood.length && rank(stood[end + 1]!) === rank(first)) end++
      const trim = Math.min(0.6, step * 0.12)
      const b0 = start + step * k + (one ? 0 : trim)
      const b1 = start + step * (end + 1) - (one ? 0 : trim)
      const kind: PetalKind = first.s.stop === null ? 'top' : first.s.stop === 'fail' ? 'short' : 'blind'
      if (one || first.grows) out.ghosts.push({ d: petalPath(c, inner, R, b0, b1), ladder: ladder.id, grows: first.grows })
      out.petals.push({ d: petalPath(c, inner, reach(first.s.reached, first.s.of), b0, b1), kind, ladder: ladder.id })
      k = end + 1
    }
  })
  return out
}

/** A name with places it may break: after a dot, a dash, an underscore, or a slash. Never inside a word, a hump of camel case included: a long name wraps at its punctuation or its spaces, and is given the room its words need. */
export function breakable(name: string): string {
  return name.replace(/([./_-])(?=\S)/g, '$1​')
}

/**
 * The rounds in walking order: stop by stop, island by island, so the route
 * never doubles back. Islands go in the order of their first, most pressing
 * stop; within an island the stops keep their order. An island is the folder
 * of its keys, or, for folders of fewer than `few`, the island of the few.
 */
export function routeOrder<T extends { key: string }>(rounds: readonly T[], items: readonly { key: string }[], few = 3): T[] {
  const size = new Map<string, number>()
  for (const it of items) size.set(folderOf(it.key), (size.get(folderOf(it.key)) ?? 0) + 1)
  const islandOf = (key: string) => {
    const f = folderOf(key)
    return f && (size.get(f) ?? 0) >= few ? f : '\0few'
  }
  const order: string[] = []
  for (const r of rounds) if (!order.includes(islandOf(r.key))) order.push(islandOf(r.key))
  return order.flatMap((isl) => rounds.filter((r) => islandOf(r.key) === isl))
}

// The sky of programs -------------------------------------------------------------

/** The bands of the sky, nearest the sun first: how much of a holder's checks are broken. The last holds those nothing could judge. */
export const SKY_BANDS = ['clear', 'few', 'many', 'storm', 'unjudged'] as const
export type SkyBand = (typeof SKY_BANDS)[number]

/** The share of broken checks a band starts at: a few under one in five, many under half, a storm from half. */
export const SKY_FROM: Record<Exclude<SkyBand, 'unjudged'>, number> = { clear: 0, few: 0, many: 0.2, storm: 0.5 }

interface Judged {
  plots: number
  members: number
  checks: number
  failing: number
  unknown: number
}

/**
 * The band a holder orbits in: by its share of broken checks, or `unjudged`
 * when every check it has is without data. Null for a holder that holds
 * nothing or has no check at all: there is nothing to say of its health, so
 * it is not drawn.
 */
export function skyBand(h: Judged): SkyBand | null {
  if (!h.checks || h.plots + h.members === 0) return null
  if (h.unknown >= h.checks) return 'unjudged'
  if (!h.failing) return 'clear'
  const share = h.failing / h.checks
  return share >= SKY_FROM.storm ? 'storm' : share >= SKY_FROM.many ? 'many' : 'few'
}

export interface SkyBody {
  id: string
  band: SkyBand
  /** Its share of broken checks. */
  share: number
  /** How big it is drawn. */
  r: number
  /** What it is grouped with round the circle, or null for none. */
  sector: string | null
  /** What orders it inside its sector: the same key always takes the same place among the same bodies. */
  key: string
}

/** One slice of the circle: the bodies of one sector, between two bearings. */
export interface SkySector {
  name: string | null
  from: number
  to: number
  count: number
}

export interface SkyChart {
  /** Where each body sits. */
  at: Map<string, Point>
  /** How big each body is drawn: its own size, shrunk with the whole chart where the chart had to shrink to fit. */
  r: Map<string, number>
  /** Each band's nearest and furthest radius from the sun. */
  rings: Record<SkyBand, [number, number]>
  /** The slices, in order round the circle from the top. */
  sectors: SkySector[]
  /** How big the sun is drawn. */
  sun: number
}

export interface SkyRoom {
  /** The sun's place, and the furthest radius a band may reach. */
  c: number
  radius: number
  /** How big the sun is drawn: no band comes nearer. */
  sun: number
  /** How wide each band's name is drawn, and how tall: a name sits across the top of its band's near edge, and no body sits under one. */
  nameWidth: Record<SkyBand, number>
  nameHeight: number
  /** The least room between two bodies. */
  gap?: number
}

/** The narrowest an occupied band is drawn. */
const BAND_LEAST = 34

/**
 * The chart of the sky. Three things are worked out, each from the bodies
 * alone, so the same bodies always land the same:
 *
 * A body's bearing is its own: the circle is cut in slices, one a sector, in
 * the sectors' alphabetical order with the unnamed last, each as wide as its
 * share of the bodies; in its slice a body takes its place by its key. So a
 * body's bearing never follows its health: only its distance does.
 *
 * A band takes the room its bodies need. Inside a band the bodies stand on
 * levels, the fewer of its checks broken the nearer the sun: walking them in
 * that order, a body joins the level before it while it touches nothing
 * there, and starts the next level out when it would. Bodies with the same
 * share are walked in an order that keeps neighbours apart, so a band of
 * equals fills a few whole levels rather than one a body. An empty band is
 * as thin as its name. What room the chart has left goes to the occupied
 * bands by how many they hold, and inside a band each level's bodies spread
 * into the room before the next level by their share, so a wide band reads
 * as a gradient. A chart that needs more room than it has is drawn smaller,
 * bodies and all.
 *
 * No two bodies touch: two on one level are far enough apart round it, and
 * two levels are further apart than their biggest bodies reach.
 */
export function skyChart(bodies: readonly SkyBody[], room: SkyRoom): SkyChart {
  const gap = room.gap ?? 5
  const n = bodies.length
  // Bearings: sectors in order, each body a slot of the same width.
  const names = [...new Set(bodies.map((b) => b.sector))].sort((a, b) => (a === null ? 1 : b === null ? -1 : a.localeCompare(b)))
  const ordered = names.flatMap((name) => bodies.filter((b) => b.sector === name).sort((a, b) => a.key.localeCompare(b.key) || a.id.localeCompare(b.id)))
  const slotOf = new Map(ordered.map((b, i) => [b.id, i]))
  const turn = n ? (2 * Math.PI) / n : 0
  const bearing = (b: SkyBody) => -Math.PI / 2 + (slotOf.get(b.id)! + 0.5) * turn
  const sectors: SkySector[] = []
  let from = 0
  for (const name of names) {
    const count = bodies.filter((b) => b.sector === name).length
    sectors.push({ name, from: -Math.PI / 2 + from * turn, to: -Math.PI / 2 + (from + count) * turn, count })
    from += count
  }

  // One pass lays every band out from the sun; `lift` is how much bigger names are drawn against the bodies when the chart is drawn smaller.
  const lay = (lift: number) => {
    const nameH = room.nameHeight * lift
    const rho = new Map<string, number>()
    // For each body, how far the next level out (or its band's far edge) lies past its own, and where it stands among its level's shares, from 0 for the least broken to 1 for the most.
    const reach = new Map<string, { next: number; among: number }>()
    const rings = {} as Record<SkyBand, [number, number]>
    let r0 = room.sun
    for (const band of SKY_BANDS) {
      const mine = bodies.filter((b) => b.band === band)
      const nameW = room.nameWidth[band] * lift
      // Under the band's own name, across the top of its near edge, no body sits.
      const underName = (b: SkyBody, dist: number) => {
        const a = bearing(b)
        const [x, y] = [Math.cos(a) * dist, Math.sin(a) * dist]
        return Math.abs(x) < nameW / 2 + b.r + gap && y < 0 && Math.abs(-y - r0) < nameH / 2 + b.r + gap
      }
      // Whether a body at this bearing would reach under the name of the band after this one, which sits across this band's far edge.
      const nearTop = (b: SkyBody, dist: number) => {
        const a = bearing(b)
        return Math.sin(a) < 0 && Math.abs(Math.cos(a) * dist) < Math.max(...SKY_BANDS.map((x) => room.nameWidth[x])) * lift * 0.5 + b.r + gap
      }
      // Equal shares are walked so that neighbours round the circle are far apart in the walk: every `stride`th slot first.
      const typical = mine.length ? mine.reduce((s, b) => s + b.r, 0) / mine.length : 0
      const arc = Math.max(1e-6, turn * (r0 + typical + gap))
      const stride = Math.max(1, Math.ceil((2 * typical + gap) / arc))
      const walk = [...mine].sort((a, b) => a.share - b.share || (slotOf.get(a.id)! % stride) - (slotOf.get(b.id)! % stride) || slotOf.get(a.id)! - slotOf.get(b.id)!)
      const made: { base: number; maxR: number; bodies: SkyBody[] }[] = []
      for (const b of walk) {
        const cur = made.at(-1)
        if (cur) {
          const dist = cur.base + Math.max(cur.maxR, b.r)
          const a = bearing(b)
          const clear = cur.bodies.every((o) => 2 * dist * Math.abs(Math.sin((a - bearing(o)) / 2)) >= b.r + o.r + gap)
          if (clear && !underName(b, dist)) {
            cur.bodies.push(b)
            cur.maxR = Math.max(cur.maxR, b.r)
            continue
          }
        }
        // The next level out: past the last one's biggest body, and past the band's name where this body stands under it.
        let base = cur ? cur.base + 2 * cur.maxR + gap : r0 + gap
        while (underName(b, base + b.r)) base += 2
        made.push({ base, maxR: b.r, bodies: [b] })
      }
      for (const l of made) for (const b of l.bodies) rho.set(b.id, l.base + l.maxR)
      // The band ends past its furthest body, with room for the next band's name over any body that stands under it; an empty one is as thin as its own name.
      const far = made.length ? Math.max(...made.flatMap((l) => l.bodies.map((b) => l.base + l.maxR + b.r + (nearTop(b, l.base + l.maxR) ? nameH / 2 + gap : gap)))) : r0
      const r1 = Math.max(far, r0 + (made.length ? BAND_LEAST : nameH + 4))
      made.forEach((l, i) => {
        const shares = l.bodies.map((b) => b.share)
        const [lo, hi] = [Math.min(...shares), Math.max(...shares)]
        const next = made[i + 1] ? made[i + 1]!.base + made[i + 1]!.maxR : r1
        for (const b of l.bodies) reach.set(b.id, { next: next - (l.base + l.maxR), among: hi > lo ? (b.share - lo) / (hi - lo) : 0 })
      })
      rings[band] = [r0, r1]
      r0 = r1
    }
    return { rho, reach, rings, outer: r0 }
  }

  let laid = lay(1)
  let zoom = 1
  if (laid.outer > room.radius) {
    // Drawn smaller, the names (which keep their size on screen) are bigger against the bodies: lay it out once more for them, then fit.
    laid = lay(laid.outer / room.radius)
    zoom = Math.min(1, room.radius / laid.outer)
  }
  // Room left over goes to the occupied bands, by how many they hold: each stretches from its near edge, so no two bodies come nearer.
  const spare = Math.max(0, room.radius - laid.outer * zoom) / zoom
  const held = SKY_BANDS.map((band) => bodies.filter((b) => b.band === band).length)
  const all = held.reduce((s, v) => s + v, 0)
  const rings = {} as Record<SkyBand, [number, number]>
  const stretch = {} as Record<SkyBand, { from: number; to: number; by: number }>
  let at0 = room.sun
  SKY_BANDS.forEach((band, i) => {
    const [r0, r1] = laid.rings[band]
    const width = r1 - r0
    const extra = all ? (spare * held[i]!) / all : 0
    stretch[band] = { from: r0, to: at0, by: width ? (width + extra) / width : 1 }
    rings[band] = [at0 * zoom, (at0 + width + extra) * zoom]
    at0 += width + extra
  })
  const at = new Map<string, Point>()
  const r = new Map<string, number>()
  for (const b of bodies) {
    const s = stretch[b.band]
    // Stretched, a level has room before the next: its bodies spread into it by their share, the less broken nearer, so a wide band is a gradient and never a few crowded circles. None comes nearer the next level than it stood before.
    const { next, among } = laid.reach.get(b.id)!
    const dist = (s.to + (laid.rho.get(b.id)! - s.from) * s.by + next * (s.by - 1) * among) * zoom
    const a = bearing(b)
    at.set(b.id, [room.c + Math.cos(a) * dist, room.c + Math.sin(a) * dist])
    r.set(b.id, b.r * zoom)
  }
  return { at, r, rings, sectors, sun: room.sun * zoom }
}

/** What the workshop's bench draws as one square cell: one kind of thing on no place, or one plot, for its own checks. */
export interface BenchCell {
  x: number
  y: number
  /** The side of its square. */
  s: number
  open: OpenPatch | null
  plot: MapPlot | null
}

/**
 * What is tied to no place laid on a bench `w` wide from its top left, at
 * the planet's grain: one square cell each kind of thing on no place, the
 * biggest kind first, then one each plot, for the checks that are its own.
 * Cells are as big as fit a bench `h` tall, and never bigger than `most`.
 */
export function benchOf(map: Pick<MapView, 'plots' | 'members'>, w: number, h: number, most = 14): { cells: BenchCell[]; h: number } {
  const all: { open: OpenPatch | null; plot: MapPlot | null }[] = [...openOn(map, null).map((open) => ({ open, plot: null })), ...map.plots.map((plot) => ({ open: null, plot }))]
  if (!all.length) return { cells: [], h: 0 }
  // The biggest square that lays them all inside the bench.
  let s = most
  while (s > 2 && Math.ceil(all.length / Math.floor(w / s)) * s > h) s -= 0.25
  const cols = Math.max(1, Math.floor(w / s))
  return { cells: all.map((it, i) => ({ ...it, x: (i % cols) * s, y: Math.floor(i / cols) * s, s })), h: Math.ceil(all.length / cols) * s }
}

// The names on the sky --------------------------------------------------------------

/** A body on the sky as a name is placed against it: where it is, how big, and whether it is one of the small dots. */
export interface SkyDisc {
  id: string
  x: number
  y: number
  r: number
  minor?: boolean
}

/**
 * A name asking for a place: the body it names, how big its plate is drawn in
 * each shape it may take (on one line, on two), the first preferred, and how
 * far off its body it may stand on a tie line, nearest first. A name with no
 * `ties` stands touching its body or not at all.
 */
export interface SkyNameAsk {
  id: string
  shapes: readonly { w: number; h: number }[]
  ties?: readonly number[]
}

/** Where a name was put: its plate, which of its shapes it took, and whether it stands off its body, joined to it by a tie line. */
export interface SkyNameSpot {
  box: Box
  shape: number
  tied: boolean
}

export interface SkyNameRoom {
  /** The sun: a name's first choice is the far side of its body from here. */
  c: Point
  /** What every name stays inside. */
  view: Box
  /** What no name and no tie line may lie on: the sun, the bands' names, the sectors' names. */
  keepOut: readonly Box[]
  /** How far a name that touches its body stands from it. */
  touch: number
  /** The least clear room between a name, or its tie line, and a body that is not its own: more for a body drawn large, which a name is most easily read as, less for a small dot. */
  clear: number
  clearMinor: number
}

/** How far a box's nearest edge is from a disc's edge: zero or less where they meet. */
const boxToDisc = (box: Box, d: Pick<SkyDisc, 'x' | 'y' | 'r'>): number => {
  const [nx, ny] = nearestOn(box, [d.x, d.y])
  return Math.hypot(nx - d.x, ny - d.y) - d.r
}

/** How far a line's nearest point is from a disc's edge. */
const lineToDisc = (a: Point, b: Point, d: Pick<SkyDisc, 'x' | 'y' | 'r'>): number => {
  const [vx, vy] = [b[0] - a[0], b[1] - a[1]]
  const t = Math.max(0, Math.min(1, ((d.x - a[0]) * vx + (d.y - a[1]) * vy) / (vx * vx + vy * vy || 1)))
  return Math.hypot(a[0] + vx * t - d.x, a[1] + vy * t - d.y) - d.r
}

/** The sides of a body a name may stand on, as sixteen bearings, clockwise from the right. */
const SIDES = Array.from({ length: 16 }, (_, i) => (i * Math.PI) / 8)

/**
 * Where each name goes, so that a name is never read as another body's. The
 * names are placed in the order asked, each at the first of its own spots
 * that is clean, so whoever is asked first has first pick.
 *
 * Its spots are fixed by its body and its large neighbours alone. First the
 * far side of its body from the sun, touching it, or, where another large
 * body stands close by, the side that faces away from the nearest of them. Then the other sides, touching, nearest that bearing
 * first and clockwise where two are as near, and after them over and under
 * its body slid to one side. Then the same again at each of its tie
 * distances, nearest first, where the name is joined back to its body by a
 * line. At each spot it tries its shapes in the order given.
 *
 * A spot is clean when the plate is on the picture, lies on nothing kept
 * clear, on no body, on no name or tie line placed before it, and when it is
 * plainly its own body's. Touching, that means every other body is clear of
 * the plate and at least twice as far from it as its own body is. On a tie
 * line the line says whose it is, so it means no large body is as near the
 * plate as its own, by the clear room; every small dot is most of its clear
 * room away, so the plate never touches one; and the line itself passes
 * clear of every other body, every kept box, and every other name.
 *
 * A spot in another large body's caption zone (the band straight above,
 * below, or beside it, as deep as it is wide) is passed over, however near
 * the name's own body is: it is taken only on a tie line, and only when no
 * spot outside every such zone is clean.
 *
 * A name with no clean spot is left out. The same asks always land the same.
 */
export function skyNames(asks: readonly SkyNameAsk[], discs: readonly SkyDisc[], room: SkyNameRoom): Map<string, SkyNameSpot> {
  const out = new Map<string, SkyNameSpot>()
  const crosses = (p: Box, q: Box, gap = 2) => p.x < q.x + q.w + gap && q.x < p.x + p.w + gap && p.y < q.y + q.h + gap && q.y < p.y + p.h + gap
  const inside = (b: Box) => b.x >= room.view.x && b.y >= room.view.y && b.x + b.w <= room.view.x + room.view.w && b.y + b.h <= room.view.y + room.view.h
  const clearOf = (d: SkyDisc) => (d.minor ? room.clearMinor : room.clear)
  const taken: Box[] = []
  const lines: [Point, Point][] = []
  for (const ask of asks) {
    const own = discs.find((d) => d.id === ask.id)
    if (!own || out.has(ask.id)) continue
    const large = discs.filter((d) => d.id !== own.id && !d.minor)
    // Its first choice: the far side from the sun, or, where another large body stands close by, the side that faces away from the nearest of them, so its name never leans toward a neighbour.
    const near = large.map((d) => ({ d, gap: Math.hypot(d.x - own.x, d.y - own.y) - d.r - own.r })).sort((a, b) => a.gap - b.gap)[0]
    const outward = near && near.gap < 2 * own.r ? Math.atan2(own.y - near.d.y, own.x - near.d.x) : Math.atan2(own.y - room.c[1], own.x - room.c[0])
    const turn = (a: number) => Math.abs(Math.atan2(Math.sin(a - outward), Math.cos(a - outward)))
    // Another large body's caption zone: the band straight above, below, left, or right of it, as deep as it is wide, where a name reads as its caption however near its own body is. A plate is in it when more than a quarter of its width or height lies in the band, unless its own body stands between the two.
    const span = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0))
    const captions = (box: Box) =>
      large.some((d) => {
        const deep = 2 * d.r
        const upDown = span(box.x, box.x + box.w, d.x - d.r, d.x + d.r) > box.w / 4 && ((box.y >= d.y && box.y - (d.y + d.r) < deep) || (box.y + box.h <= d.y && d.y - d.r - (box.y + box.h) < deep))
        const sides = span(box.y, box.y + box.h, d.y - d.r, d.y + d.r) > box.h / 4 && ((box.x >= d.x && box.x - (d.x + d.r) < deep) || (box.x + box.w <= d.x && d.x - d.r - (box.x + box.w) < deep))
        return (upDown || sides) && lineToDisc([d.x, d.y], [box.x + box.w / 2, box.y + box.h / 2], own) > 0
      })
    // The plate stands `gap` off the body on that bearing: beside it, over or under it, or with its near corner on the bearing where that is a diagonal.
    // Over or under its body a plate may also slide along: `slide` from -1 to 1 moves it from hanging off the body's left to hanging off its right, so it can lean away from a neighbour.
    const at = (bearing: number, gap: number, shape: { w: number; h: number }, slide = 0): Box => {
      const [ux, uy] = [Math.cos(bearing), Math.sin(bearing)]
      const reach = own.r + gap
      const beside = Math.abs(uy) < 0.38
      const over = Math.abs(ux) < 0.38
      const x = beside || !over ? (ux > 0 ? own.x + (beside ? reach : ux * reach) : own.x - (beside ? reach : -ux * reach) - shape.w) : own.x + ux * reach - shape.w / 2 + slide * Math.max(0, shape.w / 2 - own.r / 2)
      const y = over || !beside ? (uy > 0 ? own.y + (over ? reach : uy * reach) : own.y - (over ? reach : -uy * reach) - shape.h) : own.y + uy * reach - shape.h / 2
      return { x, y, w: shape.w, h: shape.h }
    }
    // The line a name off its body is tied by: from the body's edge to the plate's nearest point.
    const tieOf = (box: Box): [Point, Point] => {
      const end = nearestOn(box, [own.x, own.y])
      const far = Math.hypot(end[0] - own.x, end[1] - own.y) || 1
      return [[own.x + ((end[0] - own.x) / far) * own.r, own.y + ((end[1] - own.y) / far) * own.r], end]
    }
    const sides = [...SIDES].sort((a, b) => turn(a) - turn(b) || a - b)
    // Each side as it stands, then the sides over and under the body slid along, the smaller slides first.
    const places: [number, number][] = [[outward, 0], ...sides.map((a): [number, number] => [a, 0]), ...[0.5, -0.5, 1, -1].flatMap((slide) => sides.filter((a) => Math.abs(Math.cos(a)) < 0.38).map((a): [number, number] => [a, slide]))]
    const spots: SkyNameSpot[] = [null, ...(ask.ties ?? [])].flatMap((tie) => places.flatMap(([a, slide]) => ask.shapes.map((shape, i) => ({ box: at(a, tie ?? room.touch, shape, slide), shape: i, tied: tie !== null }))))
    const clean = ({ box, tied }: SkyNameSpot) => {
      if (!inside(box) || room.keepOut.some((k) => crosses(k, box)) || taken.some((t) => crosses(t, box)) || lines.some(([p, q]) => lineHits(p, q, box, 3))) return false
      const mine = Math.max(0, boxToDisc(box, own))
      const others = discs.filter((d) => d.id !== own.id)
      // Touching: no other body near it, and none nearer than twice its own.
      if (!tied) return others.every((d) => boxToDisc(box, d) >= Math.max(clearOf(d), 2 * mine))
      // Tied: no large body is as near as its own, every small dot is clear, and the line back runs clear of every other body, kept box, and name.
      const [from, to] = tieOf(box)
      return others.every((d) => boxToDisc(box, d) >= (d.minor ? room.clearMinor * 0.6 : mine + room.clear) && lineToDisc(from, to, d) >= room.clearMinor / 2) && !room.keepOut.some((k) => lineHits(from, to, k, 2)) && !taken.some((t) => lineHits(from, to, t, 2))
    }
    // A spot in a neighbour's caption zone is a last resort, and only on a tie line, which says whose the name is.
    const spot = spots.find((sp) => !captions(sp.box) && clean(sp)) ?? spots.find((sp) => sp.tied && captions(sp.box) && clean(sp))
    if (!spot) continue
    taken.push(spot.box)
    if (spot.tied) lines.push(tieOf(spot.box))
    out.set(ask.id, spot)
  }
  return out
}
