// Automatic layout of the model page with ELK: tiers from the relations.
// What nothing points at is the first tier and what only gets pointed at the
// last, left to right. Each connected component is laid out alone and the
// components are packed into a block. Every position returned is absolute and
// fully expanded; `compact` in the shared layout is what the view applies.

import type { ELK, ElkExtendedEdge, ElkNode } from 'elkjs/lib/elk-api.js'
import bundled from 'elkjs/lib/elk.bundled.js'
import type { Blueprint } from '../shared/model.ts'
import { GAP, MODEL_H, MODEL_W, type Rect } from '../shared/layout.ts'
import type { Logger } from './log.ts'

export interface LayoutNode {
  id: string
  w: number
  h: number
}

export interface LayoutEdge {
  from: string
  to: string
}

// The bundle is CommonJS: its default export is the constructor, which the types do not say.
const elk: ELK = new (bundled as unknown as new () => ELK)()

/** How far apart cards sit: room enough for their lines to read. `node` is between cards in one tier, `tier` between tiers. */
const SPACING = { node: GAP * 4, tier: GAP * 8 }

/** The layout that placed a stored model. Bump it when the arrangement changes enough that an old one should be redone. */
export const MODEL_LAYOUT_GENERATION = 3

// Tiers run left to right, so a wide screen holds more of the model.
const ROOT_OPTIONS = {
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.separateConnectedComponents': 'false',
  'elk.spacing.nodeNode': String(SPACING.node),
  'elk.spacing.componentComponent': String(SPACING.node * 2),
  'elk.layered.spacing.nodeNodeBetweenLayers': String(SPACING.tier),
  'elk.layered.spacing.edgeNodeBetweenLayers': String(SPACING.node),
  'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
  'elk.layered.crossingMinimization.thoroughness': '30',
  'elk.edgeRouting': 'POLYLINE',
  'elk.padding': '[top=0,left=0,bottom=0,right=0]',
}

/** Lays the cards out in tiers from the edges, each connected component alone, and packs the components. Returns an absolute rect per card. */
export async function layout(nodes: LayoutNode[], edges: LayoutEdge[], log?: Logger): Promise<Map<string, Rect>> {
  const started = Date.now()
  const byId = new Map(nodes.map((n) => [n.id, n]))
  // One edge per pair and none to itself: ELK lays those out badly or not at all.
  const seen = new Set<string>()
  const kept: LayoutEdge[] = []
  for (const e of edges) {
    if (e.from === e.to || !byId.has(e.from) || !byId.has(e.to)) continue
    const key = `${e.from}>${e.to}`
    if (seen.has(key)) continue
    seen.add(key)
    kept.push(e)
  }
  // Islands: ELK puts every component in one row, so each is laid out alone and packed here.
  const group = new Map<string, string>(nodes.map((n) => [n.id, n.id]))
  const find = (id: string): string => {
    let cur = id
    while (group.get(cur) !== cur) cur = group.get(cur)!
    group.set(id, cur)
    return cur
  }
  for (const e of kept) group.set(find(e.from), find(e.to))
  const components = new Map<string, LayoutNode[]>()
  for (const n of nodes) components.set(find(n.id), [...(components.get(find(n.id)) ?? []), n])
  const laid: { nodes: Map<string, Rect>; w: number; h: number; first: string }[] = []
  for (const members of components.values()) {
    const inside = new Set(members.map((m) => m.id))
    const elkEdges: ElkExtendedEdge[] = kept.filter((e) => inside.has(e.from)).map((e) => ({ id: `${e.from}>${e.to}`, sources: [e.from], targets: [e.to] }))
    const graph = await elk.layout({ id: 'root', layoutOptions: ROOT_OPTIONS, children: members.map((n) => ({ id: n.id, width: n.w, height: n.h })), edges: elkEdges })
    const out = new Map<string, Rect>()
    for (const n of graph.children ?? []) out.set(n.id, { x: Math.round(n.x ?? 0), y: Math.round(n.y ?? 0), w: Math.round(n.width ?? 0), h: Math.round(n.height ?? 0) })
    let w = 0
    let h = 0
    for (const r of out.values()) {
      w = Math.max(w, r.x + r.w)
      h = Math.max(h, r.y + r.h)
    }
    laid.push({ nodes: out, w, h, first: members[0]!.id })
  }
  const packed = pack(laid, SPACING.node)
  const result = new Map<string, Rect>()
  for (const [i, c] of laid.entries()) {
    const at = packed[i]!
    for (const [id, r] of c.nodes) result.set(id, { ...r, x: r.x + at.x, y: r.y + at.y })
  }
  log?.info('layout', { nodes: nodes.length, edges: kept.length, components: laid.length, ms: Date.now() - started })
  return result
}

/**
 * Shelf packing: the biggest components first, then the rest in rows no wider
 * than a block of the target aspect ratio. Same-size islands are ordered by
 * their first id, which starts with the blueprint, so loose cards of one kind
 * sit together.
 */
function pack(items: { w: number; h: number; first: string }[], gap: number): { x: number; y: number }[] {
  const order = items.map((it, i) => ({ it, i })).sort((a, b) => b.it.h * b.it.w - a.it.h * a.it.w || a.it.first.localeCompare(b.it.first))
  const area = items.reduce((sum, it) => sum + (it.w + gap * 2) * (it.h + gap * 2), 0)
  const rowWidth = Math.max(Math.sqrt(area * ASPECT), ...items.map((it) => it.w))
  const out: { x: number; y: number }[] = new Array(items.length)
  let x = 0
  let y = 0
  let rowH = 0
  for (const { it, i } of order) {
    if (x > 0 && x + it.w > rowWidth) {
      y += rowH + gap * 2
      x = 0
      rowH = 0
    }
    out[i] = { x, y }
    x += it.w + gap * 2
    rowH = Math.max(rowH, it.h)
  }
  return out
}

const ASPECT = 1.6

/**
 * Positions for every blueprint that has none, hidden ones included, so a
 * reader can show a hidden one without a save. What is shown is placed first,
 * the whole of it laid out when nothing is stored, and each hidden one then
 * sits beside its neighbours.
 */
export async function placeAll(blueprints: Blueprint[], hidden: readonly string[], stored: Record<string, { x: number; y: number }>, log?: Logger): Promise<Record<string, { x: number; y: number }>> {
  const shown = await placeModel(blueprints.filter((b) => !hidden.includes(b.id)), stored, log)
  const rest = await placeModel(blueprints, { ...stored, ...shown }, log)
  return { ...shown, ...rest }
}

/**
 * Positions for the blueprints that have none on the model page. With nothing
 * stored the whole model is laid out; otherwise each newcomer sits left of
 * what it points at, or right of what points at it, in the first free slot.
 */
export async function placeModel(blueprints: Blueprint[], stored: Record<string, { x: number; y: number }>, log?: Logger): Promise<Record<string, { x: number; y: number }>> {
  const unplaced = blueprints.filter((b) => !stored[b.id])
  if (!unplaced.length) return {}
  const ids = new Set(blueprints.map((b) => b.id))
  const edges = blueprints.flatMap((b) => Object.values(b.relations).filter((r) => ids.has(r.target) && r.target !== b.id).map((r) => ({ from: b.id, to: r.target })))
  if (!Object.keys(stored).length) {
    const laid = await layout(blueprints.map((b) => ({ id: b.id, w: MODEL_W, h: MODEL_H })), edges, log)
    return Object.fromEntries(blueprints.map((b) => [b.id, { x: laid.get(b.id)!.x, y: laid.get(b.id)!.y }]))
  }
  const pos: Record<string, { x: number; y: number }> = { ...stored }
  const taken = (p: { x: number; y: number }) => Object.values(pos).some((q) => Math.abs(q.x - p.x) < MODEL_W + SPACING.node && Math.abs(q.y - p.y) < MODEL_H + SPACING.node)
  const free = (p: { x: number; y: number }) => {
    const out = { ...p }
    while (taken(out)) out.y += MODEL_H + SPACING.node
    return out
  }
  const added: Record<string, { x: number; y: number }> = {}
  let fallback = { x: 0, y: Math.max(0, ...Object.values(stored).map((p) => p.y + MODEL_H + SPACING.tier)) }
  for (const b of unplaced) {
    const target = edges.find((e) => e.from === b.id && pos[e.to])?.to
    const source = edges.find((e) => e.to === b.id && pos[e.from])?.from
    let p: { x: number; y: number }
    if (target) p = free({ x: pos[target]!.x - MODEL_W - SPACING.node, y: pos[target]!.y })
    else if (source) p = free({ x: pos[source]!.x + MODEL_W + SPACING.node, y: pos[source]!.y })
    else {
      p = free(fallback)
      fallback = { x: fallback.x + MODEL_W + SPACING.node, y: fallback.y }
    }
    pos[b.id] = p
    added[b.id] = p
  }
  log?.info('model placed', { count: Object.keys(added).length })
  return added
}
