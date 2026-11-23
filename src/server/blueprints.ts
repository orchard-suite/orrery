import { createHash } from 'node:crypto'
import { z } from 'zod'
import { neighbourWheres, parsePath, renamedIn, splitMirror, usesIncoming } from '../shared/filter.ts'
import { UNGROUPED, type CatalogLayout, type CatalogLayoutPatch } from '../shared/api.ts'
import { type AccessRule, AGGREGATION_FNS, FIELD_TYPES, PIVOT_LIMIT, TREND_POINTS, VALUE_COLORS, ICON_FIELD, RESERVED_PREFIX, TITLE_FIELD, inheritCases, inheritPaths, isDerived, isLocked, isTrendHistory, parseDuration, type Blueprint, type BlueprintInput, type BlueprintOrigin, type FieldDef, type Filter, type InheritCase, type StatusRollup } from '../shared/model.ts'
import { record } from './activity.ts'
import type { Db } from './db.ts'
import type { Logger } from './log.ts'
import { compile } from '../shared/expr.ts'
import { equal, stable, validateValue } from './values.ts'

const LAYOUT_KEY = 'catalog.layout'

/** When a blueprint's shape moves, for `shape`: a millisecond on, so a derivation that read its inputs in the same millisecond as the old model counts as older. */
const movedNow = (): Date => new Date(Date.now() + 1)

const filterSchema: z.ZodType<unknown> = z.lazy(() => z.record(z.string(), z.unknown()))

/**
 * Why a filter cannot decide which case of an inherited relation an entity
 * takes, or null when it can. A case is judged on the entity's own fields and
 * relations alone: a scorecard level, a neighbour, and who points at the
 * entity are not read where relations are inherited.
 */
function refusedWhen(f: Filter): string | null {
  if (!f || typeof f !== 'object') return 'is not a filter'
  if ('and' in f) return Array.isArray(f.and) ? (f.and.map(refusedWhen).find((r) => r) ?? null) : 'is not a filter'
  if ('or' in f) return Array.isArray(f.or) ? (f.or.map(refusedWhen).find((r) => r) ?? null) : 'is not a filter'
  if ('not' in f) return refusedWhen(f.not)
  if ('scorecard' in f) return 'reads a scorecard level, which a case cannot read'
  if ('relatedTo' in f) return 'reads a neighbour, which a case cannot read'
  if ('relation' in f && f.where) return "reads the values of what a relation reaches, which a case cannot read"
  if (usesIncoming(f)) return 'asks who points at the entity, which a case cannot read'
  return null
}

const accessSchema = z.object({
  grants: z.array(z.object({ path: z.string().min(1).optional(), field: z.string().min(1).optional(), values: z.array(z.string().min(1)).min(1) })).default([]),
  /** Named audiences, defined in the hub's access policy. */
  audiences: z.array(z.string().min(1)).optional(),
  /** On a blueprint's rule: the entities a person owns, by these roles, are theirs to read. */
  owners: z.object({ roles: z.array(z.string().min(1)).min(1), fields: z.union([z.literal('all'), z.array(z.string().min(1))]) }).optional(),
  /** On a blueprint's rule: the relations naming what each entity is about; who may see that sees the entity. */
  subjects: z.array(z.string().min(1)).min(1).optional(),
})

/** Who reads a blueprint's timeline: grants and audiences alone. */
const timelineSchema = accessSchema.pick({ grants: true, audiences: true }).strict()

const fieldSchema = z.object({
  type: z.enum(FIELD_TYPES),
  access: accessSchema.optional(),
  adminEdit: z.boolean().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  overridable: z.boolean().optional(),
  values: z.array(z.string()).optional(),
  default: z.unknown().optional(),
  mirror: z.string().optional(),
  calculation: z.string().optional(),
  pivot: z.boolean().optional(),
  many: z.boolean().optional(),
  sticky: z.boolean().optional(),
  pivoted: z.object({ field: z.string().min(1), key: z.string().min(1) }).optional(),
  offered: z.object({ source: z.string().min(1), hash: z.string().min(1) }).optional(),
  chip: z.boolean().optional(),
  spread: z.boolean().optional(),
  history: z.union([z.object({ keep: z.string().min(1) }).strict(), z.object({ of: z.string().min(1), every: z.string().min(1), last: z.string().min(1) }).strict()]).optional(),
  metric: z.boolean().optional(),
  summary: z.boolean().optional(),
  budget: z.object({ max: z.number().finite().optional(), min: z.number().finite().optional() }).strict().optional(),
  format: z.object({ kind: z.literal('currency'), currency: z.string().regex(/^[A-Z]{3}$/, 'a currency is its three-letter ISO 4217 code, such as USD'), minor: z.boolean().optional() }).optional(),
  icon: z.union([z.string().min(1), z.literal(false)]).optional(),
  colors: z.record(z.string(), z.enum(VALUE_COLORS)).optional(),
  aggregation: z
    .object({
      relation: z.string(),
      fn: z.enum(AGGREGATION_FNS),
      field: z.string().optional(),
      where: filterSchema.optional(),
      window: z.object({ field: z.string().min(1), last: z.string().min(1), offset: z.string().min(1).optional() }).optional(),
      per: z.enum(['day', 'week', 'month']).optional(),
    })
    .optional(),
})

const relationSchema = z.object({
  target: z.string().min(1),
  many: z.boolean().optional(),
  required: z.boolean().optional(),
  title: z.string().optional(),
  inverseTitle: z.string().optional(),
  description: z.string().optional(),
  display: z.enum(['link', 'contain']).optional(),
  inherit: z
    .union([
      z.string().min(1),
      z
        .array(
          z
            .object({ when: filterSchema.optional(), path: z.string().min(1).optional(), target: z.string().min(1).optional() })
            .refine((c) => !!c.path !== !!c.target, 'a case gives a path or a target, not both'),
        )
        .min(1),
    ])
    .optional(),
  formerly: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)).optional(),
})

const ID = /^[a-z][a-z0-9_]*$/

const graceSchema = z.object({ runs: z.number().int().min(0).optional(), duration: z.string().optional() })

const named = z.string().min(1)
const groundSchema = z
  .object({
    loop: named.optional(),
    friction: named.optional(),
    unwanted: named.optional(),
    activity: named.optional(),
    foundations: z.array(named).max(12).optional(),
    guards: z.array(named).max(12).optional(),
    taughtBy: named.optional(),
    template: z.object({ relation: named, version: named.optional(), current: named.optional(), action: named.optional() }).strict().optional(),
    trial: named.optional(),
    ahead: z.array(named).max(12).optional(),
    trends: z.record(named, named).optional(),
  })
  .strict()

/** The kinds of field a map may group its holders by: one short value each. */
const SECTOR_TYPES: readonly string[] = ['string', 'enum', 'number', 'boolean']

const mapSchema = z
  .object({
    parts: named.optional(),
    places: named,
    plots: z.object({ blueprint: named, holder: named, placedBy: z.object({ blueprint: named, plot: named, place: named }).strict().optional() }).strict(),
    members: z.array(z.object({ blueprint: named, holder: named, place: named.optional(), plot: named.optional() }).strict()).max(40).optional(),
    primary: named.optional(),
    sector: named.optional(),
  })
  .strict()

/** What a definition that does not parse is refused with, by a save and by an offer alike. */
function invalidBlueprint(error: z.ZodError): string {
  return `Invalid blueprint: ${error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`
}

export const blueprintSchema = z.object({
  id: z.string().regex(ID, 'blueprint ids are lowercase letters, digits, and underscores'),
  title: z.string().min(1),
  description: z.string().optional(),
  icon: z.string().optional(),
  group: z.string().optional(),
  /** Read by older catalogs and dropped: nothing draws a blueprint by it. */
  canvas: z.unknown().optional().transform(() => undefined),
  wall: z.boolean().optional(),
  standalone: z.boolean().optional(),
  lifecycle: z.object({ grace: graceSchema.optional(), expire: z.object({ after: z.string().min(1), field: z.string().optional() }).optional(), keepDeleted: z.string().min(1).optional() }).optional(),
  status: z.object({ relations: z.array(z.string()).optional(), field: z.string().optional(), offered: z.object({ source: z.string().min(1), hash: z.string().min(1) }).optional() }).optional(),
  ground: groundSchema.optional(),
  map: mapSchema.optional(),
  fields: z.record(z.string().regex(/^[a-z][a-z0-9_]*$/), fieldSchema).default({}),
  relations: z.record(z.string().regex(/^[a-z][a-z0-9_]*$/), relationSchema).default({}),
  access: accessSchema.optional(),
  timeline: timelineSchema.optional(),
  adminEdit: z.boolean().optional(),
  formerly: z.array(z.string().regex(ID)).optional(),
})

/** What became of each offered blueprint, by id. */
export interface OfferResult {
  created: string[]
  /** Existing blueprints that gained fields or relations they lacked. */
  extended: string[]
  kept: string[]
  rejected: { blueprint: string; reason: string }[]
}

export class BlueprintError extends Error {
  readonly offenders: { blueprint: string; key: string; field: string; reason: string }[]
  constructor(message: string, offenders: BlueprintError['offenders'] = []) {
    super(message)
    this.offenders = offenders
  }
}

/** The blueprints, cached in memory and reloaded after every save. */
export class Blueprints {
  /** Told the ids of blueprints whose model changed, renamed to, or removed, so what their entities derive is derived again. The hub wires it. */
  onChanged: (ids: string[]) => Promise<void> = async () => undefined
  private cache = new Map<string, Blueprint>()
  /** When each blueprint first appeared, by id. */
  private created = new Map<string, string>()
  /** A former id to the blueprint that carries it now. */
  private aliases = new Map<string, string>()
  private maxNestingDepth = 2
  private shared: CatalogLayout = { order: [], closed: [], blueprints: {}, hidden: [] }
  /** `list` as last sorted; null once a blueprint or the layout has changed. Every change to `cache` or `shared` calls `moved`. */
  private sorted: Blueprint[] | null = null
  private changes = 0
  /** Each blueprint's `shapeOf` and when it last changed, in milliseconds, as `blueprints.shape` and `shaped_at` keep them. */
  private shapes = new Map<string, { shape: string; at: number }>()

  private readonly db: Db
  private readonly log: Logger

  /** Checks a blueprint against what else reads the model: scorecards refuse a field that would loop through a level. Attached once they exist. */
  private guard: (spec: BlueprintInput) => void = () => {}

  constructor(db: Db, log: Logger) {
    this.db = db
    this.log = log
  }

  /** When what derivation reads of a blueprint last changed: a stored row derived before it is of another model. */
  shapedAt(id: string): number | undefined {
    const at = this.shapes.get(id)?.at
    if (at !== undefined) return at
    // One kept by no path that records its shape is read as changed when it was saved: that derives again, and is never wrong.
    const saved = this.cache.get(id)?.updatedAt
    return saved ? Date.parse(saved) : undefined
  }

  /**
   * Keeps a blueprint's shape as it is now. One that stands as `kept` says
   * keeps its moment; any other changed at `at`. Stored where it moved, so
   * every hub and a restart read the same: a write that misses it is read as
   * a change, which derives again and is never wrong.
   */
  /**
   * Called in the same turn the cache takes the blueprint, before anything is
   * awaited, with the moment that turn ends (`movedNow`): a derivation stamps
   * its rows with the moment it began to read, so one that began before the
   * model moved, or in the same millisecond, is read as older than the shape
   * and derived again.
   */
  private async shape(bp: Blueprint, kept: { shape: string | null; at: Date | null } | undefined, at: Date): Promise<boolean> {
    const shape = shapeOf(bp)
    const same = kept?.shape === shape && kept.at
    this.shapes.set(bp.id, { shape, at: same ? kept.at!.getTime() : at.getTime() })
    if (!same) await this.db.query('UPDATE blueprints SET shape = $2, shaped_at = $3 WHERE id = $1', [bp.id, shape, at])
    return !same
  }

  /** A number that changes whenever a blueprint or the layout does: what is worked out from the model holds while it stands. */
  revision(): number {
    return this.changes
  }

  private moved(): void {
    this.sorted = null
    this.changes++
  }

  attachGuard(guard: (spec: BlueprintInput) => void): void {
    this.guard = guard
  }

  async load(): Promise<void> {
    const rows = await this.db.query<{ id: string; spec: BlueprintInput; origin: BlueprintOrigin; updated_at: Date; created_at: Date | null; shape: string | null; shaped_at: Date | null }>('SELECT * FROM blueprints ORDER BY id')
    this.created = new Map(rows.rows.map((r) => [r.id, (r.created_at ?? r.updated_at).toISOString()]))
    for (const row of rows.rows) {
      // A blueprint stored before a name was reserved may still define a field under it. Nothing reads or writes
      // such a field, and while it is there every save of the blueprint is refused, so it is taken out here.
      const taken = [TITLE_FIELD, ICON_FIELD].filter((name) => name in (row.spec.fields ?? {}))
      if (!taken.length) continue
      for (const name of taken) delete row.spec.fields[name]
      await this.db.query('UPDATE blueprints SET spec = $2 WHERE id = $1', [row.id, JSON.stringify(row.spec)])
      this.log.warn('blueprint field dropped: its name is reserved for every entity', { blueprint: row.id, fields: taken })
    }
    this.cache = new Map(rows.rows.map((r) => [r.id, { ...r.spec, id: r.id, origin: r.origin, updatedAt: r.updated_at.toISOString() }]))
    this.shapes = new Map()
    for (const r of rows.rows) await this.shape(this.cache.get(r.id)!, { shape: r.shape, at: r.shaped_at }, r.updated_at)
    this.indexAliases()
    const depth = await this.db.query<{ value: number }>(`SELECT value FROM settings WHERE key = 'canvas.maxNestingDepth'`)
    this.maxNestingDepth = depth.rows[0]?.value ?? 2
    const shared = await this.db.query<{ value: Partial<CatalogLayout> }>(`SELECT value FROM settings WHERE key = '${LAYOUT_KEY}'`)
    this.shared = { order: [], closed: [], blueprints: {}, hidden: [], ...shared.rows[0]?.value }
    this.moved()
    this.log.info('blueprints loaded', { count: this.cache.size })
  }

  /**
   * Groups the layout names first, in its order; other groups by name; ungrouped blueprints last. Within a group,
   * the blueprints the layout names first, in its order; the rest by title.
   */
  list(): Blueprint[] {
    const rank = (group: string | undefined): number => {
      const at = group === undefined ? -1 : this.shared.order.indexOf(group)
      return at < 0 ? this.shared.order.length : at
    }
    const place = (bp: Blueprint): number => {
      const named = this.shared.blueprints[bp.group ?? UNGROUPED] ?? []
      const at = named.indexOf(bp.id)
      return at < 0 ? named.length : at
    }
    this.sorted ??= [...this.cache.values()].sort((a, b) => rank(a.group) - rank(b.group) || (a.group ?? '\uffff').localeCompare(b.group ?? '\uffff') || place(a) - place(b) || a.title.localeCompare(b.title))
    return [...this.sorted]
  }

  /**
   * Every relation the blueprints define, as the two columns of a SQL `unnest($n::text[], $m::text[])`. A relation taken
   * off a blueprint keeps its rows, the way a removed field keeps its values, so putting it back brings its links back;
   * every read of links joins on this so a removed one is read nowhere.
   */
  definedRelations(): [string[], string[]] {
    const blueprints: string[] = []
    const relations: string[] = []
    for (const bp of this.cache.values()) {
      for (const name of Object.keys(bp.relations)) {
        blueprints.push(bp.id)
        relations.push(name)
      }
    }
    return [blueprints, relations]
  }

  layout(): CatalogLayout {
    return this.shared
  }

  /**
   * Sets the parts of the layout the patch names; what it leaves out stays.
   * A git source that declares any part owns all of it: `source` names that
   * source, and a person cannot change the layout until git stops declaring
   * it. `source` null is a person's change, or git letting go.
   */
  async setLayout(patch: CatalogLayoutPatch, source: string | null): Promise<CatalogLayout> {
    if (!source && this.shared.source) throw new BlueprintError(`The layout of the catalog is declared in git by source "${this.shared.source}"; change it there`)
    return this.writeLayout(patch, source)
  }

  private async writeLayout(patch: CatalogLayoutPatch, source: string | null): Promise<CatalogLayout> {
    const names = (list: string[]) => [...new Set(list.map((g) => g.trim()).filter(Boolean))]
    const before = this.shared
    const next: CatalogLayout = {
      order: names(patch.order ?? before.order),
      closed: names(patch.closed ?? before.closed).sort(),
      // A group with nothing named has no order of its own, so it is not kept.
      blueprints: Object.fromEntries(Object.entries(patch.blueprints ?? before.blueprints).map(([group, ids]) => [group.trim(), names(ids)] as const).filter(([, ids]) => ids.length)),
      hidden: names(patch.hidden ?? before.hidden).sort(),
      ...(source ? { source } : {}),
    }
    if (stable(next) === stable(before)) return before
    await this.db.query(`INSERT INTO settings (key, value) VALUES ('${LAYOUT_KEY}', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(next)])
    const released = before.source && !source ? { releasedBy: before.source } : {}
    const folded = { closed: next.closed.filter((g) => !before.closed.includes(g)), opened: before.closed.filter((g) => !next.closed.includes(g)) }
    const hid = { hidden: next.hidden.filter((id) => !before.hidden.includes(id)), shown: before.hidden.filter((id) => !next.hidden.includes(id)) }
    const groups = stable(next.order) !== stable(before.order)
    // Only the groups whose blueprints moved are written down, each with how it stood.
    const moved = [...new Set([...Object.keys(next.blueprints), ...Object.keys(before.blueprints)])].filter((group) => stable(next.blueprints[group] ?? []) !== stable(before.blueprints[group] ?? []))
    const quiet = !folded.closed.length && !folded.opened.length && !hid.hidden.length && !hid.shown.length
    if (folded.closed.length || folded.opened.length) await record(this.db, 'catalog.folded', null, source, null, folded)
    if (hid.hidden.length || hid.shown.length) await record(this.db, 'catalog.hidden', null, source, null, hid)
    if (groups || moved.length || quiet) {
      const blueprints = moved.length ? { blueprints: Object.fromEntries(moved.map((group) => [group, { order: next.blueprints[group] ?? [], before: before.blueprints[group] ?? [] }])) } : {}
      await record(this.db, 'catalog.ordered', null, source, null, { ...(groups || !moved.length ? { order: next.order, before: before.order } : {}), ...blueprints, ...released })
    }
    this.log.info('catalog layout set', { order: next.order, closed: next.closed, blueprints: next.blueprints, hidden: next.hidden, source })
    this.shared = next
    this.moved()
    return next
  }

  /** A git source that stops declaring the layout, or is removed, leaves it as it stands for people to change. */
  async releaseLayout(source: string): Promise<boolean> {
    if (this.shared.source !== source) return false
    await this.writeLayout({}, null)
    return true
  }

  private indexAliases(): void {
    this.aliases = new Map([...this.cache.values()].flatMap((bp) => (bp.formerly ?? []).filter((old) => !this.cache.has(old)).map((old) => [old, bp.id] as const)))
  }

  /** The id a blueprint has now: the id itself, or the blueprint that was renamed from it. */
  resolve(id: string): string {
    return this.cache.has(id) ? id : (this.aliases.get(id) ?? id)
  }

  /** A filter with every former blueprint id it names, in an entity id or an incoming hop, moved to the blueprint it became. */
  current(f: Filter): Filter {
    return this.aliases.size ? renamedIn(f, (id) => this.resolve(id)) : f
  }

  /** When a blueprint first appeared in the hub. */
  createdAt(id: string): string | null {
    return this.created.get(id) ?? null
  }

  get(id: string): Blueprint | undefined {
    return this.cache.get(this.resolve(id))
  }

  require(id: string): Blueprint {
    const bp = this.get(id)
    if (!bp) throw new BlueprintError(`Unknown blueprint "${id}"`)
    return bp
  }

  /** Every field a value may be stored under, including the reserved title and icon. */
  fieldDef(bp: Blueprint, field: string): FieldDef | undefined {
    if (field === TITLE_FIELD) return { type: 'string', title: 'Title' }
    if (field === ICON_FIELD) return { type: 'string', title: 'Icon', default: bp.icon }
    return bp.fields[field]
  }

  /**
   * Validates and stores a blueprint. Adding fields is always allowed; a type
   * change is refused when any stored value no longer fits, listing the
   * entities. Removed fields keep their data until purge. `arriving` names
   * blueprints being saved in the same batch, so two that relate to each
   * other (a team has a lead, a person has teams) can both land.
   */
  async save(input: unknown, origin: BlueprintOrigin, actor: string, values: (id: string, field: string) => Promise<{ key: string; value: unknown }[]>, arriving: ReadonlySet<string> = new Set()): Promise<Blueprint> {
    const parsed = blueprintSchema.safeParse(input)
    if (!parsed.success) throw new BlueprintError(invalidBlueprint(parsed.error))
    const spec = parsed.data as BlueprintInput
    for (const reserved of [TITLE_FIELD, ICON_FIELD]) if (reserved in spec.fields) throw new BlueprintError(`"${reserved}" is reserved; every blueprint has it`)
    if (spec.id.startsWith(RESERVED_PREFIX) !== (origin.kind === 'hub')) throw new BlueprintError(`Blueprint ids starting with "${RESERVED_PREFIX}" are reserved for the hub's own blueprints`)
    const renamed = this.aliases.get(spec.id)
    if (renamed && !this.cache.has(spec.id)) throw new BlueprintError(`Blueprint "${spec.id}" was renamed to "${renamed}"; use that id`)
    // A blueprint that names a former id which still exists takes it over: the rename keeps every entity.
    for (const old of spec.formerly ?? []) {
      const from = this.cache.get(old)
      if (!from || this.cache.has(spec.id)) continue
      const sameWriter = isLocked(from.origin) && from.origin.kind === origin.kind && 'source' in from.origin && 'source' in origin && from.origin.source === origin.source
      await this.rename(old, spec.id, actor, sameWriter)
    }
    const existing = this.cache.get(spec.id)
    if (existing?.formerly?.length) spec.formerly = [...new Set([...existing.formerly, ...(spec.formerly ?? [])])]
    for (const rel of Object.values(spec.relations)) rel.target = this.resolve(rel.target)
    // A relation that names a former name takes over the links stored under it, and the old relation goes.
    const moves: [string, string][] = []
    for (const [name, rel] of Object.entries(spec.relations)) {
      for (const old of rel.formerly ?? []) {
        if (old === name) continue
        if (existing?.relations[old]) moves.push([old, name])
        delete spec.relations[old]
      }
    }
    if (existing && existing.origin.kind === 'git' && origin.kind !== 'git') {
      throw new BlueprintError(`Blueprint "${spec.id}" is defined in git (${existing.origin.file}); edit it there`)
    }
    for (const [name, rel] of Object.entries(spec.relations)) {
      if (rel.target !== spec.id && !this.cache.has(rel.target) && !arriving.has(rel.target)) {
        // A pending target is fine for entities, but a blueprint must exist to be related to.
        throw new BlueprintError(`Relation "${name}" targets unknown blueprint "${rel.target}"`)
      }
    }
    const owners = spec.access?.owners
    if (owners && Array.isArray(owners.fields)) {
      for (const name of owners.fields) if (!spec.fields[name]) throw new BlueprintError(`Owners read "${name}", which blueprint "${spec.id}" does not have`)
    }
    for (const name of spec.access?.subjects ?? []) if (!spec.relations[name]) throw new BlueprintError(`Subjects name "${name}", which is not a relation of blueprint "${spec.id}"`)
    for (const [name, def] of Object.entries(spec.fields)) {
      if (def.access?.owners) throw new BlueprintError(`Field "${name}": owners open a blueprint's entities; a field's rule has no owners`)
      if (def.access?.subjects) throw new BlueprintError(`Field "${name}": subjects open a blueprint's entities; a field's rule has no subjects`)
      if (def.many && def.type !== 'url' && def.type !== 'enum') throw new BlueprintError(`Field "${name}": only a url or an enum holds a list, and this is a ${def.type}`)
      if (def.format && def.type !== 'number') throw new BlueprintError(`Field "${name}": only a number has a format, and this is a ${def.type}`)
      if (def.pivot && def.type !== 'object') throw new BlueprintError(`Field "${name}": only an object can be pivoted, and this is a ${def.type}`)
      if (def.pivot && !pivotPath(spec.fields, name)) throw new BlueprintError(`Field "${name}": a pivot reads a value a source or a person wrote, or a property pivoted out of one; this field is derived another way`)
      if (def.calculation) {
        try {
          compile(def.calculation)
        } catch (error) {
          throw new BlueprintError(`Field "${name}": bad calculation: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      checkHistory(spec.fields, name, def)
      if (def.metric && def.type !== 'number' && def.type !== 'enum') throw new BlueprintError(`Field "${name}": only a number or an enum is exported as a metric, and this is a ${def.type}`)
      const before = existing?.fields[name]
      if (def.mirror) this.checkSaved(spec, before?.mirror === def.mirror ? existing : undefined, splitMirror(def.mirror).path, `Field "${name}": mirror`)
      if (def.aggregation) {
        const agg = def.aggregation
        this.checkSaved(spec, before?.aggregation?.relation === agg.relation ? existing : undefined, agg.relation, `Field "${name}": aggregation`)
        if (agg.where && neighbourWheres(agg.where as Filter).length) throw new BlueprintError(`Field "${name}": an aggregation's where reads the related entity's own values, not what a relation of it reaches`)
        if (agg.fn !== 'count' && !agg.field) throw new BlueprintError(`Field "${name}": ${agg.fn} needs the field to read on the related entity`)
        if (agg.window) checkDuration(agg.window.last, `Field "${name}": window`)
        if (agg.window?.offset) checkDuration(agg.window.offset, `Field "${name}": window offset`)
        if (agg.per && !agg.window) throw new BlueprintError(`Field "${name}": a rate per ${agg.per} needs a window to measure over`)
        if (agg.per && agg.fn !== 'count' && agg.fn !== 'sum') throw new BlueprintError(`Field "${name}": only a count or a sum can be a rate per ${agg.per}`)
        if (agg.fn === 'checks' && def.type !== 'object') throw new BlueprintError(`Field "${name}": checks hold each rule's state by its id, an object, and this is a ${def.type}`)
      }
      if (def.summary) {
        if (!def.aggregation) throw new BlueprintError(`Field "${name}": only an aggregation is a summary; a field worked out from summaries is shown with them`)
        if (def.type !== 'number' && def.type !== 'trend' && def.aggregation.fn !== 'checks') throw new BlueprintError(`Field "${name}": a summary is a number, a trend, or checks, and this is a ${def.type}`)
        if (def.aggregation.fn === 'count' && def.type !== 'number') throw new BlueprintError(`Field "${name}": a count is a number, and this is a ${def.type}`)
      }
      if (def.budget) {
        if (def.type !== 'number') throw new BlueprintError(`Field "${name}": only a number has a budget, and this is a ${def.type}`)
        if (def.budget.max === undefined && def.budget.min === undefined) throw new BlueprintError(`Field "${name}": a budget needs a max, a min, or both`)
        if (def.budget.max !== undefined && def.budget.min !== undefined && def.budget.min > def.budget.max) throw new BlueprintError(`Field "${name}": a budget's min is at most its max`)
      }
    }
    // A ground is checked when it is set or changed. A field it names that goes later is read as not set.
    if (spec.ground && !equal(spec.ground, existing?.ground ?? null)) this.checkGround(spec, arriving)
    if (spec.map && !equal(spec.map, existing?.map ?? null)) this.checkMap(spec, arriving)
    for (const path of spec.status?.relations ?? []) this.checkSaved(spec, existing?.status?.relations?.includes(path) ? existing : undefined, path, 'Status rollup')
    const grants = [...(spec.access?.grants ?? []).map((g) => ({ g, what: 'Access' })), ...(spec.timeline?.grants ?? []).map((g) => ({ g, what: 'Timeline' })), ...Object.entries(spec.fields).flatMap(([name, def]) => (def.access?.grants ?? []).map((g) => ({ g, what: `Field "${name}": access` })))]
    for (const { g, what } of grants) {
      if (!g.path) continue
      try {
        parsePath(g.path)
      } catch (error) {
        throw new BlueprintError(`${what}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    for (const [name, rel] of Object.entries(spec.relations)) {
      for (const c of inheritCases(rel)) {
        if (c.when) {
          const refused = refusedWhen(c.when as Filter)
          if (refused) throw new BlueprintError(`Relation "${name}": inherit when ${refused}`)
        }
        if (!c.path) continue
        const held = existing?.relations[name]
        const end = this.checkSaved(spec, held?.target === rel.target && inheritPaths(held).includes(c.path) ? existing : undefined, c.path, `Relation "${name}": inherit`)
        if (end && end.id !== rel.target) throw new BlueprintError(`Relation "${name}": inherit ends at ${end.id}, but the relation targets ${rel.target}`)
      }
    }
    const expire = spec.lifecycle?.expire
    if (expire) {
      if (checkDuration(expire.after, 'Expiry') <= 0) throw new BlueprintError('Expiry: "after" must be longer than 0')
      if (expire.field && spec.fields[expire.field]?.type !== 'datetime') throw new BlueprintError(`Expiry: "${expire.field}" is not a datetime field of "${spec.id}"`)
    }
    const keep = spec.lifecycle?.keepDeleted
    if (keep !== undefined && checkDuration(keep, 'Keep deleted') <= 0) throw new BlueprintError('Keep deleted: must be longer than 0')
    this.checkNesting(spec)
    try {
      this.guard(spec)
    } catch (error) {
      throw new BlueprintError(error instanceof Error ? error.message : String(error))
    }
    if (existing) {
      const offenders: BlueprintError['offenders'] = []
      for (const [name, def] of Object.entries(spec.fields)) {
        const before = existing.fields[name]
        if (!before || (before.type === def.type && (def.type !== 'enum' || sameValues(before.values, def.values)))) continue
        for (const { key, value } of await values(spec.id, name)) {
          const reason = validateValue(def, value)
          if (reason) offenders.push({ blueprint: spec.id, key, field: name, reason })
        }
      }
      if (offenders.length) {
        throw new BlueprintError(`Type change refused: ${offenders.length} value(s) do not fit the new type`, offenders)
      }
    }
    for (const [from, to] of moves) await this.moveRelation(spec.id, from, to, actor)
    // Git and pushers save what they hold on every pass. A save of what already stands writes nothing: `updatedAt` is
    // when the blueprint last changed, and everything worked out from the blueprint holds until it does.
    if (existing) {
      const { origin: was, updatedAt: _since, ...stands } = existing
      if (stable(stands) === stable(spec) && stable(was) === stable(origin)) {
        this.log.debug('blueprint saved as it stands', { blueprint: spec.id, origin: origin.kind })
        return existing
      }
    }
    const now = new Date()
    await this.db.query(
      `INSERT INTO blueprints (id, spec, origin, updated_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET spec = EXCLUDED.spec, origin = EXCLUDED.origin, updated_at = EXCLUDED.updated_at`,
      [spec.id, JSON.stringify(spec), JSON.stringify(origin), now],
    )
    const changed = !existing || !equal(existing.fields, spec.fields) || !equal(existing.relations, spec.relations)
    // Git and pushers save what they hold on every pass; only a save that changed something is activity.
    const { origin: _origin, updatedAt: _at, ...before } = existing ?? ({} as Partial<Blueprint>)
    if (!existing || stable(before) !== stable(spec)) {
      const writer = origin.kind === 'git' || origin.kind === 'source' ? origin.source : null
      await record(this.db, 'blueprint.changed', { blueprint: spec.id }, writer, actor, { created: !existing, origin, model: changed })
    }
    const bp: Blueprint = { ...spec, origin, updatedAt: now.toISOString() }
    this.cache.set(spec.id, bp)
    const was = this.shapes.get(spec.id)
    const reshaped = await this.shape(bp, was ? { shape: was.shape, at: new Date(was.at) } : undefined, movedNow())
    this.moved()
    if (!this.created.has(spec.id)) this.created.set(spec.id, now.toISOString())
    this.indexAliases()
    this.log.info('blueprint saved', { blueprint: spec.id, origin: origin.kind, created: !existing, changed, reshaped })
    // Only a save that moved what derivation reads derives anything again: a description, a format, or a ground moves nothing stored.
    if (reshaped) await this.onChanged([spec.id])
    return bp
  }

  /**
   * Creates the offered blueprints that do not exist yet. One that exists
   * gains the offered fields, relations, and status rollup paths it lacks,
   * and from a model someone brings a ground and a number's budget where it
   * has none, and
   * is otherwise left exactly as it is, so whoever brings a model never overwrites an edit made
   * since, and several writers can share one blueprint. Blueprints may relate
   * to each other in any order, and in a circle.
   */
  async offer(inputs: unknown[], origin: BlueprintOrigin, actor: string, values: (id: string, field: string) => Promise<{ key: string; value: unknown }[]>): Promise<OfferResult> {
    const created: string[] = []
    const extended: string[] = []
    const kept: string[] = []
    let rejected: { blueprint: string; reason: string }[] = []
    const idOf = (input: unknown): string => String((input as { id?: unknown } | null)?.id ?? '')
    const arriving = new Set(inputs.map(idOf))
    /** What is still to save: a new blueprint as offered, or an existing one with what it lacks added. */
    const source = origin.kind === 'source' ? origin.source : null
    /** A field as this source brings it: marked with the source and the fingerprint of what it offered. */
    const marked = (def: FieldDef): FieldDef => (source ? { ...def, offered: { source, hash: fingerprint(def) } } : def)
    const build = (input: unknown): { spec: unknown; origin: BlueprintOrigin; added: string[] } | null => {
      const existing = this.get(idOf(input))
      if (!existing) return { spec: source ? markOffer(input, source) : input, origin, added: [] }
      const offered = blueprintSchema.safeParse(input)
      if (!offered.success) return null
      const fields = Object.entries(offered.data.fields)
        .filter(([name]) => !(name in existing.fields))
        .map(([name, def]) => [name, marked(def as FieldDef)] as const)
      // A field this source brought, untouched since, takes the source's new definition: a product keeps its own rules current.
      const updated = source
        ? Object.entries(offered.data.fields).flatMap(([name, def]) => {
            const before = existing.fields[name]
            if (!before?.offered || before.offered.source !== source || fingerprint(before) !== before.offered.hash) return []
            return fingerprint(def as FieldDef) === before.offered.hash ? [] : [[name, { ...marked(def as FieldDef), ...estateOwn(before, def as FieldDef) }] as const]
          })
        : []
      // The status field moves the same way: set where there is none, or moved by the source that chose it while nobody else has.
      const wantStatus = source ? offered.data.status?.field : undefined
      const had = existing.status
      const statusMoves = !!wantStatus && had?.field !== wantStatus && (!had?.field || (had.offered?.source === source && had.offered.hash === had.field))
      const relations = Object.entries(offered.data.relations).filter(([name]) => !(name in existing.relations))
      // An enum the blueprint has gains the values it lacks, after its own, so every value already written still fits.
      const values = Object.entries(offered.data.fields).flatMap(([name, def]) => {
        const before = existing.fields[name]
        if (def.type !== 'enum' || before?.type !== 'enum') return []
        const missing = (def.values ?? []).filter((v) => !(before.values ?? []).includes(v))
        return missing.length ? [[name, { ...before, values: [...(before.values ?? []), ...missing] }] as const] : []
      })
      // A rollup path is additive too: it is how what a pusher discovers shows on what a person authored.
      const rollups = (offered.data.status?.relations ?? []).filter((path) => !existing.status?.relations?.includes(path))
      // A ground and a budget are the estate's own, so only a model someone brings sets them, and only where there is none.
      const ground = !source && !existing.ground ? offered.data.ground : undefined
      // A map is the estate's own too, and lands the same way.
      const map = !source && !existing.map ? offered.data.map : undefined
      const budgets = source
        ? []
        : Object.entries(offered.data.fields).flatMap(([name, def]) => {
            const before = existing.fields[name]
            return def.budget && before?.type === 'number' && !before.budget ? [[name, { ...before, budget: def.budget }] as const] : []
          })
      const added = [
        ...fields.map(([name]) => name),
        ...updated.map(([name]) => `updated:${name}`),
        ...values.map(([name]) => `values:${name}`),
        ...budgets.map(([name]) => `budget:${name}`),
        ...(ground ? ['ground'] : []),
        ...(map ? ['map'] : []),
        ...relations.map(([name]) => name),
        ...rollups.map((path) => `status:${path}`),
        ...(statusMoves ? [`status.field:${wantStatus}`] : []),
      ]
      if (!added.length || isLocked(existing.origin)) return null
      const { origin: kept, updatedAt: _at, ...spec } = existing
      let status = rollups.length ? { ...existing.status, relations: [...(existing.status?.relations ?? []), ...rollups] } : existing.status
      if (statusMoves) status = { ...status, field: wantStatus, offered: { source: source!, hash: wantStatus! } }
      return { spec: { ...spec, status, ...(ground ? { ground } : {}), ...(map ? { map } : {}), fields: { ...existing.fields, ...Object.fromEntries(values), ...Object.fromEntries(budgets), ...Object.fromEntries(updated), ...Object.fromEntries(fields) }, relations: { ...existing.relations, ...Object.fromEntries(relations) } }, origin: kept, added }
    }
    if (origin.kind === 'source') inputs = inputs.map(withoutLocks)
    // An offer that names a former id renames that blueprint first, so it is extended with everything it holds kept.
    // One defined by another writer is left alone, and the offer of it is refused rather than made beside it.
    const refusedRenames: { blueprint: string; reason: string }[] = []
    for (const input of inputs) {
      const id = idOf(input)
      if (this.get(id)) continue
      const formerly = (input as { formerly?: unknown } | null)?.formerly
      const old = Array.isArray(formerly) ? formerly.find((f): f is string => typeof f === 'string' && this.cache.has(f)) : undefined
      if (!old) continue
      const from = this.cache.get(old)!
      const byItsWriter = isLocked(from.origin) && 'source' in from.origin && 'source' in origin && from.origin.source === origin.source
      if (isLocked(from.origin) && !byItsWriter) {
        refusedRenames.push({ blueprint: id, reason: `"${old}" is defined by ${from.origin.kind === 'git' ? `git (${from.origin.file})` : 'the hub'}; rename it there to "${id}" first` })
        continue
      }
      await this.rename(old, id, actor, byItsWriter)
    }
    inputs = inputs.filter((input) => !refusedRenames.some((r) => r.blueprint === idOf(input)))
    // An offer of a blueprint the hub has must parse before anything of it is added; one that does not is refused, never kept.
    const unreadable: { blueprint: string; reason: string }[] = []
    let pending: unknown[] = []
    for (const input of inputs) {
      const parsed = this.get(idOf(input)) ? blueprintSchema.safeParse(input) : null
      if (parsed && !parsed.success) unreadable.push({ blueprint: idOf(input), reason: invalidBlueprint(parsed.error) })
      else if (build(input)) pending.push(input)
      else {
        kept.push(idOf(input))
        this.log.info('offered blueprint kept as it is', { blueprint: idOf(input), actor })
      }
    }
    while (pending.length) {
      const next: unknown[] = []
      rejected = []
      for (const input of pending) {
        const todo = build(input)!
        try {
          const saved = await this.save(todo.spec, todo.origin, actor, values, arriving)
          if (todo.added.length) {
            extended.push(saved.id)
            this.log.info('offered blueprint extended: missing fields and relations added', { blueprint: saved.id, actor, added: todo.added })
          } else created.push(saved.id)
        } catch (error) {
          next.push(input)
          rejected.push({ blueprint: idOf(input), reason: error instanceof Error ? error.message : String(error) })
        }
      }
      if (next.length === pending.length) break
      pending = next
    }
    rejected = [...refusedRenames, ...unreadable, ...rejected]
    for (const r of rejected) this.log.warn('offered blueprint refused', { ...r, actor })
    return { created, extended, kept, rejected }
  }

  /**
   * Keeps the fields pivots make in step with the data: a field for each
   * property a pivoted object holds on any entity, and none left from a pivot
   * that was turned off. A made field stays when its property is gone from
   * every entity, so nothing that reads it breaks on a quiet day. Blueprints
   * in git and the hub's own are left alone: git lists its fields itself.
   * Returns the ids of the blueprints it changed.
   */
  async syncPivots(): Promise<string[]> {
    const changed: string[] = []
    for (const bp of [...this.cache.values()]) {
      const wanted = Object.values(bp.fields).some((d) => d.pivot || d.pivoted)
      if (!wanted) continue
      if (isLocked(bp.origin)) {
        this.log.debug('pivot skipped: the blueprint is locked, so it lists its own fields', { blueprint: bp.id, origin: bp.origin.kind })
        continue
      }
      const fields = { ...bp.fields }
      const removed: string[] = []
      // A property pivoted out of a field that is itself removed goes with it, so this runs until nothing more goes.
      for (let gone = true; gone; ) {
        gone = false
        for (const [name, def] of Object.entries(fields)) {
          if (!def.pivoted || fields[def.pivoted.field]?.pivot) continue
          delete fields[name]
          removed.push(name)
          gone = true
        }
      }
      const added: string[] = []
      for (const [name, def] of Object.entries(fields)) {
        if (!def.pivot) continue
        const path = pivotPath(fields, name)
        if (!path) continue
        const rows = await this.db.query<{ key: string; type: string; n: string }>(
          `SELECT k.key, jsonb_typeof(k.value) AS type, count(*)::text AS n
           FROM entities e,
             LATERAL (SELECT COALESCE(e.git #> $2::text[], e.override #> $2::text[], e.pushed #> $2::text[], e.ui #> $2::text[]) AS v) s,
             LATERAL jsonb_each(CASE WHEN jsonb_typeof(s.v) = 'object' THEN s.v ELSE '{}'::jsonb END) k
           WHERE e.blueprint = $1 AND e.state <> 'deleted' GROUP BY 1, 2 ORDER BY 1, 3 DESC`,
          [bp.id, path],
        )
        const made = new Set(Object.values(fields).filter((d) => d.pivoted?.field === name).map((d) => d.pivoted!.key))
        // The type most of a property's values have; a null says nothing about it.
        const types = new Map<string, string>()
        for (const r of rows.rows) if (r.type !== 'null' && (!types.has(r.key) || Number(r.n) > Number(rows.rows.find((x) => x.key === r.key && x.type === types.get(r.key))?.n ?? 0))) types.set(r.key, r.type)
        for (const key of new Set(rows.rows.map((r) => r.key))) {
          if (made.has(key)) continue
          const quote = !key.includes('"') ? '"' : !key.includes("'") ? "'" : null
          if (!quote) {
            this.log.warn('pivot skipped a property: its name holds both kinds of quote, which a calculation cannot write', { blueprint: bp.id, field: name, key })
            continue
          }
          if (made.size >= PIVOT_LIMIT) {
            this.log.warn('pivot stopped at its limit: the object holds more properties than it makes fields for', { blueprint: bp.id, field: name, limit: PIVOT_LIMIT })
            break
          }
          const slug = key.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'value'
          let id = `${name}_${slug}`
          for (let n = 2; id in fields || id === TITLE_FIELD || id === ICON_FIELD; n++) id = `${name}_${slug}_${n}`
          const type = types.get(key) ?? 'string'
          fields[id] = {
            type: (['number', 'boolean', 'object', 'array'] as const).find((t) => t === type) ?? 'string',
            title: key,
            description: `The "${key}" property of ${def.title ?? name}.`,
            calculation: `${name}[${quote}${key}${quote}]`,
            pivoted: { field: name, key },
          }
          made.add(key)
          added.push(id)
        }
      }
      if (!added.length && !removed.length) continue
      const { origin, updatedAt: _at, ...spec } = bp
      try {
        await this.save({ ...spec, fields }, origin, 'hub', async () => [])
        changed.push(bp.id)
        this.log.info('pivot fields synced', { blueprint: bp.id, added, removed })
      } catch (error) {
        this.log.warn('pivot fields not synced: the blueprint would not save', { blueprint: bp.id, added, removed, error })
      }
    }
    return changed
  }

  /** Removes a blueprint. One a git source defined is removed only by that source, when its catalog stops defining it. */
  async remove(id: string, actor: string, bySource?: string): Promise<void> {
    const bp = this.require(id)
    if (bp.origin.kind === 'git' && bp.origin.source !== bySource) throw new BlueprintError(`Blueprint "${id}" is defined in git; remove it there`)
    if (bp.origin.kind === 'hub') throw new BlueprintError(`Blueprint "${id}" is the hub's own and cannot be removed`)
    const users = this.list().filter((other) => other.id !== id && Object.values(other.relations).some((r) => r.target === id))
    // The hub's own blueprints link to what actions run on; they follow the model and never hold a blueprint in it.
    const held = users.filter((u) => u.origin.kind !== 'hub')
    if (held.length) throw new BlueprintError(`Blueprint "${id}" is the target of relations on ${held.map((u) => u.id).join(', ')}`)
    for (const hub of users.filter((u) => u.origin.kind === 'hub')) {
      const { origin, updatedAt: _at, ...spec } = hub
      const relations = Object.fromEntries(Object.entries(spec.relations).filter(([, r]) => r.target !== id))
      let access = spec.access
      if (access?.subjects) {
        const { subjects, ...rest } = access
        const kept = subjects.filter((name) => relations[name])
        access = kept.length ? { ...rest, subjects: kept } : rest
      }
      await this.save({ ...spec, relations, ...(access ? { access } : {}) }, origin, 'hub', async () => [])
      this.log.info('a hub blueprint lets go of its relations to a blueprint being removed', { blueprint: hub.id, removed: id })
    }
    await this.db.query('DELETE FROM blueprints WHERE id = $1', [id])
    await this.db.query('DELETE FROM field_history WHERE blueprint = $1', [id])
    await record(this.db, 'blueprint.changed', { blueprint: id }, null, actor, { removed: true })
    this.cache.delete(id)
    this.moved()
    // The layout lets go of it too, so a blueprint made later under the same id starts shown, and at the bottom.
    const laid = this.shared.hidden.includes(id) || Object.values(this.shared.blueprints).some((ids) => ids.includes(id))
    if (laid) {
      const next: CatalogLayout = {
        ...this.shared,
        blueprints: Object.fromEntries(Object.entries(this.shared.blueprints).map(([group, ids]) => [group, ids.filter((other) => other !== id)] as const).filter(([, ids]) => ids.length)),
        hidden: this.shared.hidden.filter((other) => other !== id),
      }
      await this.db.query(`UPDATE settings SET value = $1 WHERE key = '${LAYOUT_KEY}'`, [JSON.stringify(next)])
      this.shared = next
      this.moved()
    }
    this.log.info('blueprint removed', { blueprint: id, laid })
  }

  /**
   * A relation path must be well formed, and every hop that lands on a
   * blueprint the hub knows must exist there. A hop from a blueprint that is
   * not defined yet passes: blueprints arrive in any order.
   */
  /**
   * An access grant's path starts at the person blueprint, not the blueprint it guards. A path that names a relation
   * the person blueprint does not have reaches nothing, so the grant could never let anyone in: it is refused.
   * `saving` stands in for the person blueprint when that is the one being saved.
   */
  checkGrantPath(person: string, path: string, what: string, saving?: BlueprintInput): void {
    const from = saving?.id === person ? saving : this.cache.get(person)
    if (!from) return
    this.checkPath(from, path, what)
  }

  /**
   * A path a save carries is checked as `checkPath` does, except that one
   * the same field, rollup, or relation held already broken before the save
   * (`existing`, given only then) is let through: it is a finding
   * (`brokenPaths`), and it must not stop an edit of something else.
   */
  private checkSaved(spec: BlueprintInput, existing: BlueprintInput | undefined, path: string, what: string): BlueprintInput | undefined {
    try {
      return this.checkPath(spec, path, what)
    } catch (error) {
      if (!existing || !(error instanceof BlueprintError)) throw error
      try {
        this.checkPath(existing, path, what)
      } catch {
        this.log.info('blueprint save keeps a path that was already broken', { blueprint: spec.id, what, path })
        return undefined
      }
      throw error
    }
  }

  private checkPath(spec: BlueprintInput, path: string, what: string): BlueprintInput | undefined {
    let hops
    try {
      hops = parsePath(path)
    } catch (error) {
      throw new BlueprintError(`${what}: ${error instanceof Error ? error.message : String(error)}`)
    }
    const known = (id: string): BlueprintInput | undefined => (id === spec.id ? spec : this.cache.get(id))
    let at: BlueprintInput | undefined = spec
    for (const hop of hops) {
      if (hop.incoming) {
        const from: BlueprintInput | undefined = hop.from ? known(hop.from) : undefined
        const rel = from?.relations[hop.relation]
        if (from && !rel) throw new BlueprintError(`${what}: blueprint "${from.id}" has no relation "${hop.relation}"`)
        if (rel && at && rel.target !== at.id) throw new BlueprintError(`${what}: "${from!.id}.${hop.relation}" points at ${rel.target}, not ${at.id}`)
        at = from
      } else {
        if (!at) return undefined
        const rel: BlueprintInput['relations'][string] | undefined = at.relations[hop.relation]
        if (!rel) throw new BlueprintError(`${what}: blueprint "${at.id}" has no relation "${hop.relation}"`)
        at = known(rel.target)
      }
    }
    return at
  }

  /** Every path in the model that names a relation the model no longer has: what a rename or a removal elsewhere left behind. */
  brokenPaths(): { blueprint: string; reason: string }[] {
    const out: { blueprint: string; reason: string }[] = []
    for (const bp of this.cache.values()) {
      const check = (path: string, what: string): void => {
        try {
          this.checkPath(bp, path, what)
        } catch (error) {
          out.push({ blueprint: bp.id, reason: error instanceof Error ? error.message : String(error) })
        }
      }
      for (const [name, def] of Object.entries(bp.fields)) {
        if (def.mirror) check(splitMirror(def.mirror).path, `Field "${name}": mirror`)
        if (def.aggregation) check(def.aggregation.relation, `Field "${name}": aggregation`)
      }
      for (const path of bp.status?.relations ?? []) check(path, 'Status rollup')
      for (const [name, rel] of Object.entries(bp.relations)) for (const path of inheritPaths(rel)) check(path, `Relation "${name}": inherit`)
    }
    return out
  }

  /**
   * Hands fields, and with `status` the status field, to a source: each is
   * marked as that source's, with the fingerprint of the definition it has
   * now, so the source's next offer replaces it as if the source had brought
   * it. Refused on a blueprint git or the hub defines, for a source the hub
   * does not know, and for a field the blueprint lacks.
   */
  async handOver(id: string, to: { source: string; fields: string[]; status: boolean }, known: (source: string) => boolean, actor: string): Promise<Blueprint> {
    const bp = this.require(id)
    if (isLocked(bp.origin)) throw new BlueprintError(`Blueprint "${id}" is ${bp.origin.kind === 'git' ? 'defined in git; its definitions are git\'s' : "the hub's own"}, so nothing of it is handed to a source`)
    if (!known(to.source)) throw new BlueprintError(`There is no source "${to.source}"`)
    if (!to.fields.length && !to.status) throw new BlueprintError('Name the fields to hand over, or the status field, or both')
    const lacking = to.fields.filter((name) => !bp.fields[name])
    if (lacking.length) throw new BlueprintError(`Blueprint "${id}" has no field ${lacking.map((n) => `"${n}"`).join(', ')}`)
    const statusField = bp.status?.field
    if (to.status && !statusField) throw new BlueprintError(`Blueprint "${id}" has no status field to hand over`)
    const fields = { ...bp.fields }
    for (const name of to.fields) fields[name] = { ...bp.fields[name]!, offered: { source: to.source, hash: fingerprint(bp.fields[name]!) } }
    const status = to.status ? { ...bp.status, offered: { source: to.source, hash: statusField! } } : bp.status
    const { origin, updatedAt: _at, ...was } = bp
    const spec: BlueprintInput = { ...was, fields, ...(status ? { status } : {}) }
    if (stable(spec) === stable(was)) {
      this.log.info('hand-over changed nothing: the source already held what was named', { blueprint: id, source: to.source, fields: to.fields, status: to.status, actor })
      return bp
    }
    const now = new Date()
    await this.db.query('UPDATE blueprints SET spec = $2, updated_at = $3 WHERE id = $1', [id, JSON.stringify(spec), now])
    await record(this.db, 'blueprint.changed', { blueprint: id }, null, actor, { handedOver: { source: to.source, fields: to.fields, status: to.status } })
    const saved: Blueprint = { ...spec, origin, updatedAt: now.toISOString() }
    this.cache.set(id, saved)
    const shaped = this.shapes.get(id)
    await this.shape(saved, shaped ? { shape: shaped.shape, at: new Date(shaped.at) } : undefined, movedNow())
    this.moved()
    this.log.info('definitions handed to a source', { blueprint: id, source: to.source, fields: to.fields, status: to.status, actor })
    return saved
  }

  /**
   * Gives a blueprint a new id and takes everything with it: its entities
   * with what people typed on them, relations in both directions, history,
   * rules, scorecards, layouts, and every path in another blueprint that
   * names it. Callers reload whatever caches rules, scorecards, and sources.
   */
  async rename(from: string, to: string, actor: string, byItsWriter = false): Promise<Blueprint> {
    const bp = this.require(from)
    if (isLocked(bp.origin) && !byItsWriter) throw new BlueprintError(`Blueprint "${from}" is ${bp.origin.kind === 'git' ? 'defined in git; rename it there' : "the hub's own and cannot be renamed"}`)
    if (!ID.test(to)) throw new BlueprintError('blueprint ids are lowercase letters, digits, and underscores')
    if (to.startsWith(RESERVED_PREFIX)) throw new BlueprintError(`Blueprint ids starting with "${RESERVED_PREFIX}" are reserved for the hub's own blueprints`)
    if (this.cache.has(to)) throw new BlueprintError(`Blueprint "${to}" already exists`)
    const repath = (path: string): string => path.split('.').map((hop) => (hop.startsWith(`<-${from}:`) ? `<-${to}:${hop.slice(from.length + 3)}` : hop)).join('.')
    const regrant = (rule: AccessRule): AccessRule => ({ ...rule, grants: rule.grants.map((g) => (g.path ? { ...g, path: repath(g.path) } : g)) })
    const respec = (spec: BlueprintInput): BlueprintInput => ({
      ...spec,
      id: spec.id === from ? to : spec.id,
      ...(spec.id === from ? { formerly: [...new Set([...(spec.formerly ?? []), from])] } : {}),
      status: spec.status?.relations ? { ...spec.status, relations: spec.status.relations.map(repath) } : spec.status,
      ...(spec.access ? { access: regrant(spec.access) } : {}),
      ...(spec.timeline ? { timeline: regrant(spec.timeline) } : {}),
      fields: Object.fromEntries(
        Object.entries(spec.fields).map(([name, def]) => [
          name,
          { ...def, ...(def.mirror ? { mirror: repath(def.mirror) } : {}), ...(def.aggregation ? { aggregation: { ...def.aggregation, relation: repath(def.aggregation.relation) } } : {}), ...(def.access ? { access: regrant(def.access) } : {}) },
        ]),
      ),
      relations: Object.fromEntries(Object.entries(spec.relations).map(([name, rel]) => [name, { ...rel, target: rel.target === from ? to : rel.target, ...(rel.inherit ? { inherit: typeof rel.inherit === 'string' ? repath(rel.inherit) : rel.inherit.map((c): InheritCase => (c.path ? { ...c, path: repath(c.path) } : c)) } : {}) }])),
    })
    const counts = await this.db.tx(async (client) => {
      const moved = await client.query(`UPDATE entities SET blueprint = $2 WHERE blueprint = $1`, [from, to])
      // The derived rows of the old id go; every entity of the new id is derived again once the rename lands.
      await client.query('DELETE FROM derived WHERE blueprint = $1', [from])
      await client.query('DELETE FROM derive_queue WHERE blueprint = $1', [from])
      for (const table of ['relations', 'changes', 'scorecard_history', 'field_history', 'check_results', 'alerts', 'relation_rules', 'alert_rules', 'grid_layouts', 'stars']) {
        await client.query(`UPDATE ${table} SET blueprint = $2 WHERE blueprint = $1`, [from, to])
      }
      await client.query(`UPDATE relations SET target_blueprint = $2 WHERE target_blueprint = $1`, [from, to])
      await client.query(`UPDATE relation_rules SET target = $2 WHERE target = $1`, [from, to])
      // Whoever pinned the blueprint keeps it pinned under its new id.
      await client.query(`UPDATE pins SET id = $2 WHERE kind = 'blueprint' AND id = $1`, [from, to])
      const cards = await client.query<{ id: string; spec: { blueprint?: string; blueprints?: Record<string, unknown> } }>('SELECT id, spec FROM scorecards')
      for (const card of cards.rows) {
        const own = card.spec.blueprints
        // A scorecard over several blueprints holds the renamed one's rules under its new id.
        const respecced = { ...card.spec, ...(card.spec.blueprint === from ? { blueprint: to } : {}), ...(own ? { blueprints: Object.fromEntries(Object.entries(own).map(([id, part]) => [id === from ? to : id, part])) } : {}) }
        const text = renamedIds(JSON.stringify(respecced), from, to)
        if (text !== JSON.stringify(card.spec)) await client.query('UPDATE scorecards SET spec = $2 WHERE id = $1', [card.id, text])
      }
      const all = await client.query<{ id: string; spec: BlueprintInput }>('SELECT id, spec FROM blueprints')
      for (const row of all.rows) {
        const next = JSON.parse(renamedIds(JSON.stringify(respec({ ...row.spec, id: row.id })), from, to)) as BlueprintInput
        if (row.id === from) await client.query('UPDATE blueprints SET id = $2, spec = $3, updated_at = now() WHERE id = $1', [from, to, JSON.stringify(next)])
        else if (!equal(next, { ...row.spec, id: row.id })) await client.query('UPDATE blueprints SET spec = $2, updated_at = now() WHERE id = $1', [row.id, JSON.stringify(next)])
      }
      const swap = (ids: string[] | undefined): string[] | undefined => ids?.map((id) => (id === from ? to : id))
      const sources = await client.query<{ id: string; spec: { blueprints?: string[]; deleteGrant?: string[] } }>('SELECT id, spec FROM sources')
      for (const s of sources.rows) {
        if (!s.spec.blueprints?.includes(from) && !s.spec.deleteGrant?.includes(from)) continue
        await client.query('UPDATE sources SET spec = $2 WHERE id = $1', [s.id, JSON.stringify({ ...s.spec, blueprints: swap(s.spec.blueprints), deleteGrant: swap(s.spec.deleteGrant) })])
      }
      const layout = await client.query<{ value: { positions: Record<string, unknown>; hidden: string[] } }>(`SELECT value FROM settings WHERE key = 'model.layout'`)
      const value = layout.rows[0]?.value
      if (value) {
        const next = { positions: Object.fromEntries(Object.entries(value.positions).map(([id, p]) => [id === from ? to : id, p])), hidden: value.hidden.map((id) => (id === from ? to : id)) }
        await client.query(`UPDATE settings SET value = $1 WHERE key = 'model.layout'`, [JSON.stringify(next)])
      }
      const shared = await client.query<{ value: Partial<CatalogLayout> }>(`SELECT value FROM settings WHERE key = '${LAYOUT_KEY}'`)
      const laid = shared.rows[0]?.value
      if (laid) {
        const next = { ...laid, blueprints: Object.fromEntries(Object.entries(laid.blueprints ?? {}).map(([group, ids]) => [group, swap(ids)])), hidden: swap(laid.hidden) }
        await client.query(`UPDATE settings SET value = $1 WHERE key = '${LAYOUT_KEY}'`, [JSON.stringify(next)])
      }
      // The setting that says which blueprint a signed-in person is follows it too.
      await client.query(`UPDATE settings SET value = jsonb_set(value::jsonb, '{blueprint}', to_jsonb($1::text)) WHERE key = 'access.person' AND value->>'blueprint' = $2`, [to, from])
      await record(client, 'blueprint.changed', { blueprint: to }, null, actor, { renamedFrom: from })
      return { entities: moved.rowCount ?? 0 }
    })
    await this.load()
    this.log.info('blueprint renamed', { from, to, actor, entities: counts.entities })
    await this.onChanged([to])
    return this.require(to)
  }

  /**
   * Forgets a name a blueprint was known by, so the name is free for another
   * blueprint. A writer that still names it under `formerly` puts it back, so
   * forget a name once every writer has moved off it.
   */
  async forget(id: string, name: string, actor: string): Promise<Blueprint> {
    const bp = this.require(id)
    if (bp.origin.kind === 'git') throw new BlueprintError(`Blueprint "${id}" is defined in git (${bp.origin.file}); take "${name}" out of its formerly there`)
    if (!bp.formerly?.includes(name)) throw new BlueprintError(`Blueprint "${id}" was never called "${name}"`)
    await this.db.tx(async (client) => {
      const row = await client.query<{ spec: BlueprintInput }>('SELECT spec FROM blueprints WHERE id = $1 FOR UPDATE', [id])
      const spec = { ...row.rows[0]!.spec }
      const rest = (spec.formerly ?? []).filter((old) => old !== name)
      if (rest.length) spec.formerly = rest
      else delete spec.formerly
      await client.query('UPDATE blueprints SET spec = $2, updated_at = now() WHERE id = $1', [id, JSON.stringify(spec)])
      await record(client, 'blueprint.changed', { blueprint: id }, null, actor, { forgot: name })
    })
    await this.load()
    this.log.info('blueprint former name forgotten', { id, name, actor })
    return this.require(id)
  }

  /** Moves the links stored under one relation of a blueprint to another, and every path that walks them in from elsewhere. */
  private async moveRelation(blueprint: string, from: string, to: string, actor: string): Promise<void> {
    const moved = await this.db.tx(async (client) => {
      const res = await client.query(`UPDATE relations SET relation = $3 WHERE blueprint = $1 AND relation = $2`, [blueprint, from, to])
      const all = await client.query<{ id: string; spec: BlueprintInput }>('SELECT id, spec FROM blueprints')
      const before = `<-${blueprint}:${from}`
      for (const row of all.rows) {
        const text = JSON.stringify(row.spec)
        const next = text.replaceAll(`"${before}"`, `"<-${blueprint}:${to}"`).replaceAll(`"${before}.`, `"<-${blueprint}:${to}.`)
        if (next !== text) await client.query('UPDATE blueprints SET spec = $2, updated_at = now() WHERE id = $1', [row.id, next])
      }
      await record(client, 'blueprint.changed', { blueprint }, null, actor, { relationRenamed: { from, to } })
      return res.rowCount ?? 0
    })
    for (const row of (await this.db.query<{ id: string; spec: BlueprintInput }>('SELECT id, spec FROM blueprints')).rows) {
      const cached = this.cache.get(row.id)
      if (!cached || row.id === blueprint) continue
      const next = { ...cached, ...row.spec, id: row.id }
      this.cache.set(row.id, next)
      const was = this.shapes.get(row.id)
      await this.shape(next, was ? { shape: was.shape, at: new Date(was.at) } : undefined, movedNow())
    }
    this.moved()
    this.log.info('relation renamed', { blueprint, from, to, links: moved, actor })
  }

  /**
   * Nesting guardrails: only to-one relations nest, one nesting relation per
   * blueprint, no cycles, and a bounded depth.
   */
  /** Every name a ground gives is a field or a relation of the kind it is read as. */
  private checkGround(spec: BlueprintInput, arriving: ReadonlySet<string>): void {
    const ground = spec.ground ?? {}
    const field = (name: string | undefined, what: string, type?: FieldDef['type']) => {
      if (name === undefined) return
      const def = spec.fields[name]
      if (!def) throw new BlueprintError(`Ground: ${what} names "${name}", which is not a field of "${spec.id}"`)
      if (type && def.type !== type) throw new BlueprintError(`Ground: ${what} reads a ${type} field, and "${name}" is a ${def.type}`)
    }
    const relation = (name: string | undefined, what: string) => {
      if (name === undefined) return undefined
      const rel = spec.relations[name]
      if (!rel) throw new BlueprintError(`Ground: ${what} names "${name}", which is not a relation of "${spec.id}"`)
      return rel
    }
    for (const role of ['loop', 'friction', 'unwanted', 'activity'] as const) field(ground[role], role, 'number')
    for (const name of ground.foundations ?? []) field(name, 'foundations')
    for (const name of ground.guards ?? []) field(name, 'guards', 'boolean')
    for (const name of ground.ahead ?? []) field(name, 'ahead', 'datetime')
    field(ground.trial, 'trial', 'boolean')
    relation(ground.taughtBy, 'taughtBy')
    for (const [of, trend] of Object.entries(ground.trends ?? {})) {
      field(of, 'trends', 'number')
      field(trend, `trends of "${of}"`, 'trend')
    }
    const template = ground.template
    const rel = relation(template?.relation, 'template')
    if (!template || !rel) return
    if (rel.many) throw new BlueprintError(`Ground: template reads a relation to one entity, and "${template.relation}" holds many`)
    field(template.version, 'template version')
    const target = rel.target === spec.id ? spec : this.cache.get(rel.target)
    // A target arriving in the same batch is not read yet: its field is checked when the ground next changes.
    if (template.current !== undefined && target && !target.fields[template.current]) throw new BlueprintError(`Ground: template current names "${template.current}", which is not a field of "${rel.target}"`)
    if (template.current !== undefined && !target && !arriving.has(rel.target)) throw new BlueprintError(`Ground: template targets unknown blueprint "${rel.target}"`)
  }

  /** Every relation a map names is a relation of its blueprint to the blueprint the map reads it as. */
  private checkMap(spec: BlueprintInput, arriving: ReadonlySet<string>): void {
    const map = spec.map!
    const bp = (id: string) => (id === spec.id ? spec : this.cache.get(id))
    // A blueprint arriving in the same batch is not read yet: what the map names of it is checked when the map next changes.
    const known = (id: string, what: string) => {
      if (!bp(id) && !arriving.has(id)) throw new BlueprintError(`Map: ${what} names unknown blueprint "${id}"`)
      return bp(id)
    }
    const relation = (on: string, name: string, target: string, what: string, one = true) => {
      const owner = known(on, what)
      if (!owner) return
      const rel = owner.relations[name]
      if (!rel) throw new BlueprintError(`Map: ${what} names "${name}", which is not a relation of "${on}"`)
      if (rel.target !== target) throw new BlueprintError(`Map: ${what} reads "${name}" of "${on}" as a relation to "${target}", and it targets "${rel.target}"`)
      if (one && rel.many) throw new BlueprintError(`Map: ${what} reads a relation to one entity, and "${name}" of "${on}" holds many`)
    }
    if (map.parts !== undefined) relation(spec.id, map.parts, spec.id, 'parts')
    known(map.places, 'places')
    relation(map.plots.blueprint, map.plots.holder, spec.id, 'plots holder')
    const by = map.plots.placedBy
    if (by) {
      relation(by.blueprint, by.plot, map.plots.blueprint, 'plots placedBy plot')
      relation(by.blueprint, by.place, map.places, 'plots placedBy place')
    }
    for (const m of map.members ?? []) {
      relation(m.blueprint, m.holder, spec.id, `members ${m.blueprint} holder`)
      if (m.place !== undefined) relation(m.blueprint, m.place, map.places, `members ${m.blueprint} place`)
      if (m.plot !== undefined) relation(m.blueprint, m.plot, map.plots.blueprint, `members ${m.blueprint} plot`)
    }
    if (map.primary !== undefined && spec.fields[map.primary]?.type !== 'boolean') throw new BlueprintError(`Map: primary names "${map.primary}", which is not a boolean field of "${spec.id}"`)
    if (map.sector !== undefined) {
      const field = spec.fields[map.sector]
      const rel = spec.relations[map.sector]
      if (!field && !rel) throw new BlueprintError(`Map: sector names "${map.sector}", which is not a field or a relation of "${spec.id}"`)
      if (field && !SECTOR_TYPES.includes(field.type)) throw new BlueprintError(`Map: sector reads "${map.sector}" of "${spec.id}" as one value to group by, and it is a ${field.type} field`)
      if (!field && rel?.many) throw new BlueprintError(`Map: sector reads a relation to one entity, and "${map.sector}" of "${spec.id}" holds many`)
    }
  }

  private checkNesting(spec: BlueprintInput): void {
    const contains = Object.entries(spec.relations).filter(([, r]) => r.display === 'contain')
    if (contains.length > 1) throw new BlueprintError(`Only one relation per blueprint may nest (display: contain); ${spec.id} has ${contains.map(([n]) => n).join(', ')}`)
    const [entry] = contains
    if (!entry) return
    const [name, rel] = entry
    if (rel.many) throw new BlueprintError(`Relation "${name}" cannot nest: only to-one relations nest, so an entity sits in one box`)
    // parent(bp) = the blueprint bp nests inside.
    const parentOf = new Map<string, string>()
    for (const bp of this.cache.values()) {
      if (bp.id === spec.id) continue
      const c = Object.values(bp.relations).find((r) => r.display === 'contain')
      if (c) parentOf.set(bp.id, c.target)
    }
    parentOf.set(spec.id, rel.target)
    // Cycle check from this blueprint.
    const seen = new Set<string>()
    let cursor: string | undefined = spec.id
    while (cursor) {
      if (seen.has(cursor)) throw new BlueprintError(`Relation "${name}" would create a nesting cycle through ${[...seen].join(' > ')}`)
      seen.add(cursor)
      cursor = parentOf.get(cursor)
    }
    // Depth: longest chain anywhere in the graph, since this blueprint may be a parent too.
    const childrenOf = new Map<string, string[]>()
    for (const [child, parent] of parentOf) childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), child])
    const depth = (bp: string): number => 1 + Math.max(0, ...(childrenOf.get(bp) ?? []).map(depth))
    const roots = [...new Set([...parentOf.values()])].filter((p) => !parentOf.has(p))
    const deepest = Math.max(0, ...roots.map(depth)) - 1
    if (deepest > this.maxNestingDepth) {
      throw new BlueprintError(`Relation "${name}" would nest ${deepest} levels deep; the limit is ${this.maxNestingDepth}. Nest only when the child lives inside the parent; use lines for uses, runs, deploys, and routes to`)
    }
  }
}

function checkDuration(text: string, what: string): number {
  try {
    return parseDuration(text)
  } catch (error) {
    throw new BlueprintError(`${what}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * A field's history: kept only of a number or an enum the hub derives, and
 * read by a trend only from a field of the same blueprint that keeps it, over
 * no more than it keeps and in no more points than a trend holds.
 */
function checkHistory(fields: Record<string, FieldDef>, name: string, def: FieldDef): void {
  const history = def.history
  if (!history) return
  if (isTrendHistory(history)) {
    if (def.type !== 'trend') throw new BlueprintError(`Field "${name}": only a trend reads another field's history, and this is a ${def.type}`)
    if (def.mirror || def.aggregation || def.calculation) throw new BlueprintError(`Field "${name}": a trend read from history is derived from it alone, so it takes no mirror, aggregation, or calculation`)
    const of = fields[history.of]
    if (!of) throw new BlueprintError(`Field "${name}": history: the blueprint has no field "${history.of}"`)
    if (!of.history || isTrendHistory(of.history)) throw new BlueprintError(`Field "${name}": history: "${history.of}" keeps no history; give it history: { keep: ... }`)
    const every = checkDuration(history.every, `Field "${name}": history every`)
    const last = checkDuration(history.last, `Field "${name}": history last`)
    if (every <= 0 || last <= 0) throw new BlueprintError(`Field "${name}": history: every and last must be longer than 0`)
    if (last < every) throw new BlueprintError(`Field "${name}": history: last (${history.last}) is shorter than every (${history.every})`)
    if (Math.ceil(last / every) > TREND_POINTS) throw new BlueprintError(`Field "${name}": history: ${history.last} every ${history.every} is ${Math.ceil(last / every)} points; a trend holds at most ${TREND_POINTS}`)
    const keep = checkDuration(of.history.keep, `Field "${history.of}": history keep`)
    if (last > keep) throw new BlueprintError(`Field "${name}": history: last (${history.last}) reaches farther back than "${history.of}" keeps (${of.history.keep})`)
    return
  }
  if (def.type !== 'number' && def.type !== 'enum') throw new BlueprintError(`Field "${name}": only a number or an enum keeps a history, and this is a ${def.type}`)
  if (!isDerived(def)) throw new BlueprintError(`Field "${name}": only a derived field (a mirror, an aggregation, or a calculation) keeps a history; a written value is the writer's to keep`)
  if (checkDuration(history.keep, `Field "${name}": history keep`) <= 0) throw new BlueprintError(`Field "${name}": history keep must be longer than 0`)
}

function sameValues(a: string[] | undefined, b: string[] | undefined): boolean {
  return equal(a ?? [], b ?? [])
}

/**
 * Where a pivoted object is stored inside a value layer: the field a source
 * or a person wrote, then one step per property it was pivoted out through.
 * Null when the field is derived some other way, so there is nothing stored to read.
 */
export function pivotPath(fields: Record<string, FieldDef>, name: string, seen: ReadonlySet<string> = new Set()): string[] | null {
  const def = fields[name]
  if (!def || seen.has(name)) return null
  if (def.pivoted) {
    const parent = pivotPath(fields, def.pivoted.field, new Set([...seen, name]))
    return parent && [...parent, def.pivoted.key]
  }
  return isDerived(def) ? null : [name, 'value']
}

/**
 * The fingerprint of a field's definition, keys in order: everything but the
 * hub's own marks and what only the estate says of the field (`estateOwn`).
 * Setting a budget, a rule on who sees the field, or a lock on who changes
 * it is not an edit of the definition.
 */
/** What derivation never reads of a blueprint: who sees and changes it, how it is grouped and drawn, and what it was called. */
const UNREAD_OF_BLUEPRINT = ['description', 'group', 'ground', 'map', 'access', 'timeline', 'adminEdit', 'formerly', 'origin', 'updatedAt', 'restricted', 'noTimeline', 'onlyYours', 'onlyAbout', 'decides'] as const
/** What derivation never reads of a field: how it is named, explained, and shown, its range on a ground, and who sees it. */
const UNREAD_OF_FIELD = ['title', 'description', 'format', 'budget', 'chip', 'spread', 'colors', 'metric', 'offered', 'access', 'adminEdit', 'summary', 'restricted'] as const
/** What derivation never reads of a relation: how it is named, explained, and drawn, and what it was called. */
const UNREAD_OF_RELATION = ['title', 'inverseTitle', 'description', 'display', 'formerly'] as const

const without = <T extends object>(o: T, keys: readonly string[]): Partial<T> => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k))) as Partial<T>

/**
 * A fingerprint of what derivation reads of a blueprint: everything but what
 * the lists above name. A stored row is current for its blueprint's model
 * while this stands, so a save that moves none of it derives nothing again.
 * A part not named there counts: one added to the model is read until it is
 * known not to be.
 */
export function shapeOf(spec: BlueprintInput | Blueprint): string {
  const fields = Object.fromEntries(Object.entries(spec.fields ?? {}).map(([name, def]) => [name, without(def, UNREAD_OF_FIELD)]))
  const relations = Object.fromEntries(Object.entries(spec.relations ?? {}).map(([name, def]) => [name, without(def, UNREAD_OF_RELATION)]))
  return createHash('sha256').update(stable({ ...without(spec, UNREAD_OF_BLUEPRINT), fields, relations })).digest('hex').slice(0, 32)
}

export function fingerprint(def: FieldDef): string {
  const { offered: _o, pivoted: _p, restricted: _r, derived: _d, budget: _b, access: _a, adminEdit: _e, summary: _s, ...rest } = def
  return createHash('sha256').update(stable(rest)).digest('hex').slice(0, 16)
}

/**
 * What only the estate says of a field: its budget, who may see it, whether
 * its result is a summary, and who may change it. A source's next definition replaces the rest and never
 * these, so a budget a source sends counts only when it first brings the
 * field. A budget goes when the field stops being a number, and the summary
 * mark when it stops being an aggregation that can be one.
 */
function estateOwn(before: FieldDef, next: Pick<FieldDef, 'type' | 'aggregation'>): Pick<FieldDef, 'budget' | 'access' | 'adminEdit' | 'summary'> {
  return { budget: next.type === 'number' ? before.budget : undefined, access: before.access, adminEdit: before.adminEdit, summary: next.aggregation && (next.type === 'number' || next.type === 'trend') ? before.summary : undefined }
}

/** A model part as JSON with the entity ids of `from` that its filters name (`target`, `relatedTo`) and its incoming hops (`<-from:`) under `to`. */
function renamedIds(json: string, from: string, to: string): string {
  return json.replaceAll(`"<-${from}:`, `"<-${to}:`).replaceAll(`"target":"${from}:`, `"target":"${to}:`).replaceAll(`"relatedTo":"${from}:`, `"relatedTo":"${to}:`)
}


/** A blueprint a source creates by offering it: every field and the status field marked as the source's. */
function markOffer(input: unknown, source: string): unknown {
  if (!input || typeof input !== 'object') return input
  const bp = input as { fields?: Record<string, FieldDef>; status?: StatusRollup }
  const fields = bp.fields && Object.fromEntries(Object.entries(bp.fields).map(([k, def]) => [k, def && typeof def === 'object' ? { ...def, offered: { source, hash: fingerprint(def) } } : def]))
  const status = bp.status?.field ? { ...bp.status, offered: { source, hash: bp.status.field } } : bp.status
  return { ...bp, ...(fields ? { fields } : {}), ...(status ? { status } : {}) }
}

/** An offer from a pusher: who may see or change something is an admin's to say, so an offered rule, lock, or summary mark is dropped. */
function withoutLocks(input: unknown): unknown {
  if (!input || typeof input !== 'object') return input
  const { access: _a, timeline: _t, adminEdit: _e, fields, status, ...raw } = input as Record<string, unknown>
  const rest = status && typeof status === 'object' ? { ...raw, status: (({ offered: _s, ...st }) => st)(status as Record<string, unknown>) } : raw
  if (!fields || typeof fields !== 'object') return rest
  return { ...rest, fields: Object.fromEntries(Object.entries(fields as Record<string, unknown>).map(([k, f]) => [k, f && typeof f === 'object' ? (({ access: _x, adminEdit: _y, summary: _w, offered: _z, ...def }) => def)(f as Record<string, unknown>) : f])) }
}
