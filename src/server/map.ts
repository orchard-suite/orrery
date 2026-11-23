// The map of an entity whose blueprint names one, built for one reader from
// what their view shows. Every read goes through the view, so a map never
// counts or names what its reader cannot open.

import type { MapIndexResponse, MapResponse, Scorecard } from '../shared/api.ts'
import { buildMap, checksOf, MAP_LIMIT, type MapInput, type ReasonsAbout } from '../shared/map.ts'
import { partsOf } from '../shared/scorecard.ts'
import type { Blueprint, Entity, EntityRef, Filter, Identity, MapDef } from '../shared/model.ts'
import type { Actions } from './actions.ts'
import type { Blueprints } from './blueprints.ts'
import type { Lists } from './lists.ts'
import type { Logger } from './log.ts'
import { timed } from './metrics.ts'
import type { Reader } from './read.ts'
import type { Scorecards } from './scorecards.ts'
import type { Owned, View } from './visibility.ts'

interface Deps {
  blueprints: Blueprints
  reader: Reader
  lists: Lists
  scorecards: Scorecards
  actions: Actions
  log: Logger
  /** What a person owns, as the hub keeps it. */
  owned: (who: string) => Promise<Owned>
  /** The blueprints what a person owns is read from. */
  ownedReads: () => Iterable<string>
  /** A blueprint as a view shows it. */
  shown: (bp: Blueprint, view: View) => Blueprint
}

/** The blueprints these scorecards read the records from that say why a thing falls short. */
function reasonsFrom(scorecards: readonly Scorecard[]): string[] {
  return [...new Set(scorecards.flatMap((sc) => partsOf(sc).flatMap((p) => (p.reasons ? [p.reasons.from] : []))))]
}

/** The most entities the map index reads of one plot or member blueprint. */
const INDEX_LIMIT = 20_000

export class Maps {
  private readonly deps: Deps

  constructor(deps: Deps) {
    this.deps = deps
  }

  /**
   * The records that may say why a thing falls short, for these scorecards:
   * every entity of each blueprint their reasons come from that the view
   * shows, read once, by the id of each entity it points at. A reader who
   * sees none of them gets none, and the scorecard's rules stand.
   */
  private async reasonsFor(view: View, scorecards: readonly Scorecard[]): Promise<ReasonsAbout> {
    const out = new Map<string, Entity[]>()
    for (const blueprint of reasonsFrom(scorecards)) {
      if (!this.deps.blueprints.get(blueprint) || !view.seesSome(blueprint)) continue
      const { entities, total } = await this.deps.reader.list({ blueprint, limit: INDEX_LIMIT, view })
      if (total > entities.length) this.deps.log.warn('map read only the first records that say why a thing falls short', { blueprint, read: entities.length, total })
      for (const r of entities) for (const ends of Object.values(r.relations)) for (const t of ends) out.set(`${t.blueprint}:${t.key}`, [...(out.get(`${t.blueprint}:${t.key}`) ?? []), r])
    }
    return out
  }

  /** The blueprints that name a map and that this view sees. */
  private mapped(view: View): (Blueprint & { map: MapDef })[] {
    return this.deps.blueprints.list().filter((bp): bp is Blueprint & { map: MapDef } => !!bp.map && view.seesBlueprint(bp.id))
  }

  /**
   * The entities a map can be drawn of: each one of a mapped blueprint that is
   * no part of another, with how many plots and members name it or one of its
   * parts. Each count is a count the reader's view answers, so it never counts
   * what they cannot open, and whether the reader owns it. Kept for a reader
   * until the hub changes or what they own does.
   */
  async index(identity: Identity, view: View): Promise<MapIndexResponse> {
    return this.deps.lists.recent('map\0index', `${identity.kind}\0${identity.name}`, view.basis, () => timed('map.index', () => this.buildIndex(identity, view)), { reads: (index) => index.reads, ages: false })
  }

  /**
   * Reads each plot and member blueprint once, everything in it that names a
   * holder, and adds each up under the holder it names, or the holder of the
   * part it names: how many plots and members, and how their checks stand.
   * That is one read a blueprint rather than one a holder, and no map is
   * built. A blueprint holding more than `INDEX_LIMIT` such entities is read
   * to that many and named in the log, its counts a floor.
   */
  private async buildIndex(identity: Identity, view: View): Promise<MapIndexResponse> {
    const { reader, log } = this.deps
    // Only a person owns things, and only where the estate says what a person owns. What they own is worked out beside
    // the reads, and waited for only where a holder is marked as theirs.
    const owning = identity.kind === 'user' ? this.deps.owned(identity.name) : Promise.resolve(null)
    // A failure is the index's to report where it waits, never an unhandled one while it reads.
    owning.catch(() => {})
    const holders: MapIndexResponse['holders'] = []
    const seen = (blueprint: string) => !!this.deps.blueprints.get(blueprint) && view.seesBlueprint(blueprint)
    for (const bp of this.mapped(view)) {
      const def = bp.map
      const filter: Filter | undefined = def.parts ? { not: { relation: def.parts } } : undefined
      const specs = [{ blueprint: def.plots.blueprint, holder: def.plots.holder, plot: true }, ...(def.members ?? []).map((m) => ({ blueprint: m.blueprint, holder: m.holder, plot: false }))]
      const shown = new Map<string, Blueprint>()
      for (const spec of specs) if (seen(spec.blueprint)) shown.set(spec.blueprint, this.deps.shown(this.deps.blueprints.get(spec.blueprint)!, view))
      const scorecards = this.deps.scorecards.list().filter((sc) => [...shown.keys()].some((b) => sc.blueprint === b || !!sc.blueprints?.[b]))
      // Every read here stands alone: they are asked side by side, so the index waits for the slowest, not the sum.
      const [{ entities }, parts, reasons, read] = await Promise.all([
        reader.list({ blueprint: bp.id, filter, limit: MAP_LIMIT, view }),
        def.parts ? reader.list({ blueprint: bp.id, filter: { relation: def.parts }, limit: MAP_LIMIT, view }).then((r) => r.entities) : Promise.resolve([]),
        this.reasonsFor(view, scorecards),
        Promise.all(specs.map((spec) => (shown.has(spec.blueprint) ? reader.list({ blueprint: spec.blueprint, filter: { relation: spec.holder }, limit: INDEX_LIMIT, view }) : null))),
      ])
      // Which holder each part rolls up to, so what names a part counts for its holder.
      const holderOf = new Map<string, string>(entities.map((e) => [e.key, e.key]))
      if (def.parts) {
        for (const p of parts) {
          const parent = p.relations[def.parts]?.[0]?.key
          if (parent && holderOf.has(parent)) holderOf.set(p.key, parent)
        }
      }
      const sums = new Map(entities.map((e) => [e.key, { plots: 0, members: 0, checks: 0, failing: 0, unknown: 0 }]))
      const left = specs.filter((spec) => !shown.has(spec.blueprint))
      if (left.length) log.info('map index leaves a blueprint out of its counts: the reader does not see it', { blueprint: bp.id, left: left.map((l) => l.blueprint) })
      const cut: string[] = []
      for (const [i, spec] of specs.entries()) {
        const shownBp = shown.get(spec.blueprint)
        const listed = read[i]
        if (!shownBp || !listed) continue
        const { entities: things, total } = listed
        if (total > things.length) cut.push(spec.blueprint)
        for (const t of things) {
          const named = t.relations[spec.holder]?.[0]
          const holder = named && named.blueprint === bp.id ? holderOf.get(named.key) : undefined
          const sum = holder ? sums.get(holder) : undefined
          if (!sum) continue
          if (spec.plot) sum.plots++
          else sum.members++
          for (const c of checksOf(t, shownBp, scorecards, reasons)) {
            sum.checks++
            if (c.state === 'fail') sum.failing++
            else if (c.state === 'unknown') sum.unknown++
          }
        }
      }
      if (cut.length) log.warn('map index read only the first entities of a blueprint: its counts are a floor', { blueprint: bp.id, cut, limit: INDEX_LIMIT })
      // The map's own word on each holder, read from what the view let through: a field the reader may not see is not there, so it reads as not primary and in no sector.
      const sectorOf = (e: Entity): string | null => {
        if (!def.sector) return null
        const named = e.relations[def.sector]?.[0]
        if (named) return named.title ?? named.key
        const value = e.fields[def.sector]
        return typeof value === 'string' ? value || null : typeof value === 'number' || typeof value === 'boolean' ? String(value) : null
      }
      const owned = await owning
      const mine = owned?.state === 'known' ? owned.ids : null
      for (const e of entities) holders.push({ blueprint: bp.id, key: e.key, title: e.title, icon: e.icon, level: e.status.level, ...sums.get(e.key)!, yours: !!mine?.has(e.id), primary: !!def.primary && e.fields[def.primary] === true, sector: sectorOf(e) })
      const mineOf = holders.filter((h) => h.blueprint === bp.id)
      log.info('map index read what the map says of each holder', { blueprint: bp.id, names: { primary: def.primary ?? null, sector: def.sector ?? null }, primary: mineOf.filter((h) => h.primary).length, minor: mineOf.filter((h) => !h.primary).length, inSector: mineOf.filter((h) => h.sector !== null).length, inNone: mineOf.filter((h) => h.sector === null).length })
    }
    holders.sort((a, b) => a.title.localeCompare(b.title))
    const owned = await owning
    const mine = owned?.state === 'known' ? owned.ids : null
    log.info('map index built', { holders: holders.length, empty: holders.filter((h) => !h.plots && !h.members).length, holding: holders.filter((h) => h.plots || h.members).length, failing: holders.filter((h) => h.failing > 0).length, clear: holders.filter((h) => h.checks > 0 && h.failing === 0).length, owned: owned?.state ?? 'not a person', yours: holders.filter((h) => h.yours).length, others: holders.filter((h) => !h.yours).length })
    const reads = this.mapped(view).flatMap((bp) => [bp.id, bp.map.plots.blueprint, ...(bp.map.members ?? []).map((m) => m.blueprint)])
    const scored = this.deps.scorecards.list().filter((sc) => reads.some((b) => sc.blueprint === b || !!sc.blueprints?.[b]))
    // Which holders are the reader's own moves with what they own.
    const owns = mine ? [...this.deps.ownedReads()] : []
    return { holders, owned: !!mine, reads: [...new Set([...reads, ...reasonsFrom(scored), ...owns])] }
  }

  /** One entity's map, kept for a reader until the hub changes. Null when its blueprint names no map, or the view shows neither. */
  async of(identity: Identity, view: View, ref: EntityRef): Promise<MapResponse | null> {
    const id = this.deps.blueprints.resolve(ref.blueprint)
    const stored = this.deps.blueprints.get(id)
    if (!stored?.map || !view.seesBlueprint(id)) return null
    const read = await this.deps.reader.get({ blueprint: id, key: ref.key })
    const holder = read && view.detail(read)
    if (!holder) return null
    return this.deps.lists.recent(`map\0${id}\0${ref.key}`, `${identity.kind}\0${identity.name}`, view.basis, () => timed('map.build', () => this.build(identity, view, stored, stored.map!, holder)), { reads: (map) => map.reads, ages: false })
  }

  private async build(identity: Identity, view: View, bp: Blueprint, def: MapDef, holder: Entity): Promise<MapResponse> {
    const { reader, log } = this.deps
    const truncated: string[] = []
    const shown = new Map<string, Blueprint>()
    // Reads a blueprint through the view, only when the view sees it. A blueprint it does not see reads as empty.
    const read = async (blueprint: string, filter?: Filter): Promise<Entity[]> => {
      const stored = this.deps.blueprints.get(blueprint)
      if (!stored || !view.seesBlueprint(blueprint)) {
        log.info('map leaves a blueprint out: the reader does not see it', { blueprint, map: bp.id })
        return []
      }
      shown.set(blueprint, this.deps.shown(stored, view))
      const { entities, total } = await reader.list({ blueprint, filter, limit: MAP_LIMIT, view })
      if (total > entities.length) truncated.push(blueprint)
      return entities
    }
    const naming = (relation: string, keys: Entity[]): Filter => ({ or: keys.map((e) => ({ relation, target: e.id })) })
    const parts = def.parts ? await read(bp.id, { relation: def.parts, target: holder.id }) : []
    const owners = [holder, ...parts]
    // What places the plots waits for the plots; every other read stands alone and is asked beside them.
    const by = def.plots.placedBy
    const [{ plots, placers }, places, members] = await Promise.all([
      read(def.plots.blueprint, naming(def.plots.holder, owners)).then(async (plots) => ({ plots, placers: by && plots.length ? await read(by.blueprint, naming(by.plot, plots)) : [] })),
      read(def.places),
      Promise.all((def.members ?? []).map(async (spec): Promise<MapInput['members'][number]> => ({ spec, entities: await read(spec.blueprint, naming(spec.holder, owners)) }))),
    ])
    // The reader's rows may be ones it keeps: what a caller may run is written on copies.
    const copies = (list: Entity[]) => list.map((e) => ({ ...e }))
    const own = { plots: copies(plots), members: members.map((m) => ({ spec: m.spec, entities: copies(m.entities) })) }
    await this.deps.actions.annotate(identity, view, [...own.plots, ...own.members.flatMap((m) => m.entities)])
    const scorecards = this.deps.scorecards.list().filter((sc) => [...shown.keys()].some((b) => sc.blueprint === b || !!sc.blueprints?.[b]))
    const reasons = await this.reasonsFor(view, scorecards)
    // Read side by side, the blueprints it cut are named in a fixed order.
    const map = buildMap({ def, holder, parts, places, plots: own.plots, placers, members: own.members, blueprints: shown, scorecards, reasons, truncated: truncated.sort() })
    // Both sides of what decides the picture: what sits in a plot and what lies open, and which checks pass, fail, or have no data.
    log.info('map built', {
      blueprint: bp.id,
      plots: map.counts.plots,
      placed: map.counts.placed,
      unplaced: map.counts.plots - map.counts.placed,
      members: map.counts.members,
      inPlots: map.counts.members - map.counts.open,
      open: map.counts.open,
      checks: map.counts.checks,
      failing: map.counts.failing,
      unknown: map.counts.unknown,
      passing: map.counts.checks - map.counts.failing - map.counts.unknown,
      truncated: truncated.length,
      actionable: [...map.plots, ...map.members].filter((t) => t.actions.length > 0).length,
      unactionable: [...map.plots, ...map.members].filter((t) => t.actions.length === 0).length,
    })
    return { ...map, blueprint: bp.id, title: bp.title, reads: [...new Set([bp.id, ...shown.keys(), ...reasonsFrom(scorecards)])] }
  }
}
