// The ground of each blueprint that names one, built for one reader from
// what their view shows: the blueprint without the fields they may not see,
// and the entities and values their view lets through. Nothing here reads
// around the view, so a ground never counts what its reader cannot open.

import type { GroundIndexResponse, GroundItemResponse, GroundResponse } from '../shared/api.ts'
import { GROUND_LIMIT, behindOf, buildGround, datesAhead, foundationsOf, guardsOf, pastsOf, peersOf, type GroundBehind, type GroundItem } from '../shared/ground.ts'
import { entityId, parseEntityId, type Blueprint, type EntityRef, type Identity } from '../shared/model.ts'
import type { Actions } from './actions.ts'
import type { Blueprints } from './blueprints.ts'
import type { Lists } from './lists.ts'
import { aggregates, type Reader } from './read.ts'
import type { View } from './visibility.ts'

interface Deps {
  blueprints: Blueprints
  reader: Reader
  lists: Lists
  actions: Actions
  /** A blueprint as a view shows it. */
  shown: (bp: Blueprint, view: View) => Blueprint
}

export class Grounds {
  private readonly deps: Deps

  constructor(deps: Deps) {
    this.deps = deps
  }

  /** The blueprints that name a ground and that this view sees. */
  grounded(view: View): Blueprint[] {
    return this.deps.blueprints.list().filter((bp) => bp.ground && view.seesBlueprint(bp.id))
  }

  /** How much of each ground is inside its budgets, for the sky. */
  async index(identity: Identity, view: View): Promise<GroundIndexResponse> {
    const grounds: GroundIndexResponse['grounds'] = {}
    const reads = new Set<string>()
    // Each ground stands alone: they are built side by side.
    const built = await Promise.all(this.grounded(view).map(async (bp) => [bp, await this.of(identity, view, bp.id)] as const))
    for (const [bp, ground] of built) {
      if (!ground) continue
      grounds[bp.id] = ground.cover
      for (const b of ground.reads) reads.add(b)
    }
    return { grounds, reads: [...reads] }
  }

  /** One blueprint's ground, kept for a reader until the hub changes. Null when the blueprint names none or the view does not see it. */
  async of(identity: Identity, view: View, blueprint: string): Promise<GroundResponse | null> {
    const id = this.deps.blueprints.resolve(blueprint)
    const stored = this.deps.blueprints.get(id)
    if (!stored?.ground || !view.seesBlueprint(id)) return null
    // Kept until a blueprint it reads moves; it reads the clock too, so it also ages.
    return this.deps.lists.recent(`ground\0${id}`, `${identity.kind}\0${identity.name}`, view.basis, () => this.build(identity, view, stored), { reads: (ground) => ground.reads })
  }

  /** The blueprints a ground reads: its own, and the one its templates come from. */
  private readsOf(bp: Blueprint): string[] {
    const template = bp.ground?.template
    const target = template ? bp.relations[template.relation]?.target : undefined
    return target && target !== bp.id ? [bp.id, target] : [bp.id]
  }

  private async build(identity: Identity, view: View, stored: Blueprint): Promise<GroundResponse> {
    const { reader, actions, shown } = this.deps
    const bp = shown(stored, view)
    const plant = bp.ground?.template?.action
    const [{ entities: read, total }, currents, offered] = await Promise.all([
      reader.list({ blueprint: bp.id, limit: GROUND_LIMIT, view }),
      this.currents(view, bp),
      plant ? actions.listFor(identity, view).then((all) => all.find((a) => a.id === plant)) : Promise.resolve(undefined),
    ])
    // The reader's rows may be ones it keeps: what a caller may run is written on copies.
    const entities = read.map((e) => ({ ...e }))
    await actions.annotate(identity, view, entities)
    const ground = buildGround(bp, entities, { now: Date.now(), currents })
    return { ...ground, blueprint: bp.id, title: bp.title, total, read: entities.length, plant: offered?.canRun ? { action: offered.id, title: offered.title } : null, reads: this.readsOf(stored) }
  }

  /** The version each template is at now, by its entity id, as the view shows it. */
  private async currents(view: View, bp: Blueprint): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>()
    const template = bp.ground?.template
    const target = template ? bp.relations[template.relation]?.target : undefined
    const field = template?.current
    if (!target || !field || !view.seesBlueprint(target)) return out
    const { entities } = await this.deps.reader.list({ blueprint: target, limit: GROUND_LIMIT, view })
    for (const e of entities) {
      const value = e.fields[field]
      out.set(e.id, typeof value === 'string' && value !== '' ? value : typeof value === 'number' ? String(value) : null)
    }
    return out
  }

  /** One entity of a ground, with what it is built on, the limits it holds, and who copied from the same place. */
  async item(identity: Identity, view: View, ref: EntityRef): Promise<GroundItemResponse | null> {
    const ground = await this.of(identity, view, ref.blueprint)
    const stored = this.deps.blueprints.get(ref.blueprint)
    const item = ground?.items.find((i) => i.key === ref.key)
    if (!ground || !stored || !item) return null
    const read = await this.deps.reader.get(ref)
    const entity = read && view.detail(read)
    if (!entity) return null
    const bp = this.deps.shown(stored, view)
    const taught: GroundItemResponse['taught'] = []
    for (const source of item.taughtBy) {
      const there = await this.deps.reader.get(source)
      const seen = there && view.detail(there)
      taught.push({
        source: seen ? { blueprint: seen.blueprint, key: seen.key, title: seen.title, icon: seen.icon, level: seen.status.level } : null,
        peers: seen ? peersOf(ground.items, source, item.key) : [],
      })
    }
    const behind = await this.behind(view, bp, ref, item)
    const reached = behind.flatMap((b) => b.rows.map((r) => r.blueprint))
    return { blueprint: ground.blueprint, title: ground.title, item, fields: ground.fields, foundations: foundationsOf(bp, entity), guards: guardsOf(bp, entity), taught, pasts: pastsOf(bp, entity), ahead: datesAhead(bp, entity, Date.now()), behind, id: entityId(ref), reads: [...new Set([...ground.reads, ...item.taughtBy.map((t) => t.blueprint), ...reached])] }
  }

  /**
   * What each of its numbers that is worked out from related things read: the
   * things at the end of the number's path, through the reader's view, each
   * marked by the same test the hub counted with. What the view hides is left
   * out, so a reader who may not see every one sees a receipt that adds up to
   * less, never a count of what they may not see.
   */
  private async behind(view: View, bp: Blueprint, ref: EntityRef, item: GroundItem): Promise<GroundBehind[]> {
    const { reader, blueprints } = this.deps
    const aggregated = item.measures.flatMap((m) => {
      const agg = bp.fields[m.field]?.aggregation
      return agg ? [{ field: m.field, agg }] : []
    })
    if (!aggregated.length) return []
    const reach = await reader.reachAll([ref], aggregated.map((a) => a.agg.relation), { present: true })
    const id = entityId(ref)
    const ids = new Map(aggregated.map((a) => [a.field, reach.get(a.agg.relation)?.get(id) ?? []]))
    const refs = [...new Set([...ids.values()].flat())].slice(0, GROUND_LIMIT).flatMap((i) => parseEntityId(i) ?? [])
    const seen = new Map((await reader.hydrated(refs)).flatMap((e) => view.entity({ ...e }) ?? []).map((e) => [e.id, e]))
    const now = Date.now()
    return aggregated.map(({ field, agg }) => behindOf(field, agg, (ids.get(field) ?? []).flatMap((i) => seen.get(i) ?? []), aggregates(agg, now), (b) => {
      const def = blueprints.get(b)
      return def && view.seesBlueprint(b) ? this.deps.shown(def, view) : undefined
    }))
  }
}
