// Scorecards: ordered levels of rules per blueprint. An entity reaches a
// level when every rule at that level and all lower levels passes. Rules are
// search filters, so they see mirror, aggregation, and calculation fields,
// and can ask whether a relation is set in either direction. A scope, also a
// search filter, says which entities are scored; the rest have no level. One
// scorecard may score several blueprints: the levels are shared, and each
// blueprint holds its own rules for them.

import { z } from 'zod'
import type { Scorecard, ScorecardPart, ScorecardResults, ScorecardRow, ScorecardTrend } from '../shared/api.ts'
import { META_FIELDS, levelLeaves, neighbourWheres, parsePath, scorecardsIn, splitMirror } from '../shared/filter.ts'
import { NONE, blueprintsOf, partFilters, partUsesIncoming, partsOf, scoreEntity } from '../shared/scorecard.ts'
import { NONE_LEVEL } from '../shared/filter.ts'
import { type BlueprintInput, type DefinitionOrigin, type ScorecardOrigin, type Entity, type EntityRef, type Filter } from '../shared/model.ts'
import { record } from './activity.ts'
import type { Blueprints } from './blueprints.ts'
import type { Db } from './db.ts'
import type { Logger } from './log.ts'
import type { Reader } from './read.ts'
import { stable } from './values.ts'


/** Why a scorecard was not saved, changed, or found, with the answer it is given: a scorecard that does not hold together or that git owns, or one that is not there. */
export class ScorecardError extends Error {
  readonly status: 400 | 404
  constructor(status: 400 | 404, message: string) {
    super(message)
    this.status = status
  }
}
const filterSchema: z.ZodType<Filter> = z.lazy(() => z.record(z.string(), z.unknown())) as unknown as z.ZodType<Filter>

// A judged rule names where its judge's answer is, and stands for an entity that holds an answer at all, so every reader of a rule's filter reads that field.
const ruleSchema = z
  .object({ id: z.string().regex(/^[a-z][a-z0-9_]*$/), title: z.string().min(1), description: z.string().optional(), where: filterSchema.optional(), judged: z.object({ field: z.string().min(1), check: z.string().min(1).optional() }).optional(), fix: z.string().min(1).optional() })
  .superRefine((r, ctx) => {
    // A judged rule read back holds the filter made for it; its own is always made again from `judged`.
    if (!r.where && !r.judged) ctx.addIssue({ code: 'custom', message: 'give a rule either where, a filter the hub judges, or judged, where another judge said', path: ['where'] })
  })
  .transform(({ where, judged, ...r }) => (judged ? { ...r, judged, where: { field: judged.field, op: 'exists' as const } satisfies Filter } : { ...r, where: where! }))
const reasonsSchema = z.object({ from: z.string().min(1), where: filterSchema.optional(), level: z.string().min(1), says: z.string().min(1), fix: z.string().min(1).optional(), link: z.string().min(1).optional() })

export const scorecardSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_]*$/).optional(),
    blueprint: z.string().min(1).optional(),
    blueprints: z.record(z.string().min(1), z.object({ where: filterSchema.optional(), rules: z.record(z.string().min(1), z.array(ruleSchema).min(1)), reasons: reasonsSchema.optional() })).optional(),
    title: z.string().min(1),
    description: z.string().optional(),
    where: filterSchema.optional(),
    levels: z.array(z.object({ name: z.string().min(1), rules: z.array(ruleSchema).optional() })).min(1),
    reasons: reasonsSchema.optional(),
  })
  .superRefine((spec, ctx) => {
    const issue = (message: string, path: (string | number)[] = []) => ctx.addIssue({ code: 'custom', message, path })
    if (!spec.blueprint === !spec.blueprints) issue('give either blueprint, with rules on each level, or blueprints, with rules for each')
    if (spec.blueprints) {
      if (!Object.keys(spec.blueprints).length) issue('name at least one blueprint', ['blueprints'])
      spec.levels.forEach((l, i) => l.rules?.length && issue('with blueprints, each blueprint holds its own rules; a level holds only its name', ['levels', i, 'rules']))
    } else spec.levels.forEach((l, i) => !l.rules?.length && issue('a level needs at least one rule', ['levels', i, 'rules']))
    const names = spec.levels.map((l) => l.name)
    names.forEach((n, i) => (names.indexOf(n) !== i || n === NONE) && issue(n === NONE ? `"${NONE}" is what an entity that reaches no level is called` : `level "${n}" appears twice`, ['levels', i, 'name']))
  })
  // A level always carries its rules: those of a one-blueprint scorecard, and none on one that names blueprints.
  .transform((spec) => ({ ...spec, levels: spec.levels.map((l) => ({ name: l.name, rules: l.rules ?? [] })) }))

export type ScorecardSpec = z.infer<typeof scorecardSchema> & { id: string }

export { NONE }

/** The history point of an entity that left a scorecard's scope. It is no level, so a trend stops counting the entity. */
export const OUT_OF_SCOPE = '-'

/** Every filter a scorecard reads: its scope and each rule. A reader who may not see what one reads does not see the scorecard. */
export function scorecardFilters(sc: Pick<Scorecard, 'blueprint' | 'blueprints' | 'where' | 'levels'>): Filter[] {
  return partsOf(sc).flatMap(partFilters)
}

/** What the dependency check needs of a scorecard. */
type CardShape = Pick<Scorecard, 'id' | 'blueprint' | 'blueprints' | 'where' | 'levels'>

/**
 * The first loop through a scorecard's level, or null. A scorecard reads its
 * scope's and its rules' fields and the levels of other scorecards; a derived
 * field reads other fields, and an aggregation's `where` reads levels of what
 * it reaches. A loop that passes through a scorecard would score an entity on
 * a level that is not computed yet, so it is refused where it is saved. A
 * loop among fields alone is the reader's to end and is not reported here.
 */
export function levelCycle(cards: CardShape[], blueprints: BlueprintInput[], start?: string): string[] | null {
  const byId = new Map(blueprints.map((b) => [b.id, b]))
  const edges = new Map<string, Set<string>>()
  const edge = (from: string, to: string) => {
    let set = edges.get(from)
    if (!set) edges.set(from, (set = new Set()))
    set.add(to)
  }
  /** Where a path ends; undefined when a hop cannot be followed to one blueprint. */
  const endOf = (from: BlueprintInput, path: string): BlueprintInput | undefined => {
    let hops
    try {
      hops = parsePath(path)
    } catch {
      return undefined
    }
    let at: BlueprintInput | undefined = from
    for (const hop of hops) {
      if (!at) return undefined
      at = hop.incoming ? (hop.from ? byId.get(hop.from) : undefined) : byId.get(at.relations[hop.relation]?.target ?? '')
    }
    return at
  }
  /** The field nodes a name on `end` means; on an unknown end, every blueprint's field of that name. */
  const fieldNodes = (end: BlueprintInput | undefined, name: string): string[] => {
    const plain = name.startsWith('fields.') ? name.slice(7) : name
    if (plain.startsWith('$')) return []
    return (end ? [end] : blueprints).filter((b) => plain in b.fields).map((b) => `field ${b.id}.${plain}`)
  }
  const reads = (from: string, end: BlueprintInput | undefined, f: Filter) => {
    for (const name of fieldsOf(f)) for (const n of fieldNodes(end, name)) edge(from, n)
    for (const sc of scorecardsIn(f)) edge(from, `scorecard ${sc}`)
  }
  for (const sc of cards) {
    const node = `scorecard ${sc.id}`
    for (const part of partsOf(sc)) for (const f of partFilters(part)) reads(node, byId.get(part.blueprint), f)
  }
  for (const bp of blueprints) {
    for (const [name, def] of Object.entries(bp.fields)) {
      const node = `field ${bp.id}.${name}`
      if (def.mirror) {
        const { path, field } = splitMirror(def.mirror)
        for (const n of fieldNodes(endOf(bp, path), field)) edge(node, n)
      }
      if (def.aggregation) {
        const end = endOf(bp, def.aggregation.relation)
        if (def.aggregation.field) for (const n of fieldNodes(end, def.aggregation.field)) edge(node, n)
        if (def.aggregation.window) for (const n of fieldNodes(end, def.aggregation.window.field)) edge(node, n)
        if (def.aggregation.where) reads(node, end, def.aggregation.where)
      }
      if (def.calculation) for (const other of Object.keys(bp.fields)) if (other !== name && new RegExp(`\\b${other}\\b`).test(def.calculation)) edge(node, `field ${bp.id}.${other}`)
    }
  }
  const done = new Set<string>()
  const stack: string[] = []
  const onStack = new Set<string>()
  const visit = (node: string): string[] | null => {
    if (onStack.has(node)) {
      const loop = [...stack.slice(stack.indexOf(node)), node]
      return loop.some((n) => n.startsWith('scorecard ')) ? loop : null
    }
    if (done.has(node)) return null
    stack.push(node)
    onStack.add(node)
    for (const next of edges.get(node) ?? []) {
      const found = visit(next)
      if (found) return found
    }
    stack.pop()
    onStack.delete(node)
    done.add(node)
    return null
  }
  // Starting from what is being saved names the loop from there.
  for (const node of [...(start ? [start] : []), ...[...edges.keys()].sort()]) {
    const found = visit(node)
    if (found) return found
  }
  return null
}

/** The field names a filter reads. */
function fieldsOf(f: Filter): string[] {
  if ('and' in f) return f.and.flatMap(fieldsOf)
  if ('or' in f) return f.or.flatMap(fieldsOf)
  if ('not' in f) return fieldsOf(f.not)
  return 'field' in f ? [f.field] : []
}

/** Scorecards in an order where one that reads another's level on the same entity comes after it. The save-time check keeps it free of loops. */
function inDependencyOrder(cards: Scorecard[]): Scorecard[] {
  const byId = new Map(cards.map((c) => [c.id, c]))
  const out: Scorecard[] = []
  const placed = new Set<string>()
  const place = (c: Scorecard, seen: Set<string>) => {
    if (placed.has(c.id) || seen.has(c.id)) return
    seen.add(c.id)
    for (const f of scorecardFilters(c)) for (const id of scorecardsIn(f)) {
      const dep = byId.get(id)
      if (dep) place(dep, seen)
    }
    placed.add(c.id)
    out.push(c)
  }
  for (const c of cards) place(c, new Set())
  return out
}

/** How many entities a scorecard scores at a time. */
const SCORE_BLOCK = 5000

export class Scorecards {
  private cache: Scorecard[] = []

  private readonly db: Db
  private readonly blueprints: Blueprints
  private readonly reader: Reader
  private readonly log: Logger

  /** Told the blueprints a saved or removed scorecard scores, so their levels are derived again. The hub wires it. */
  onChanged: (blueprints: string[]) => Promise<void> = async () => undefined
  /** When each blueprint's scorecards last changed on this hub, so a row derived before then is read as cold. */
  private readonly moved = new Map<string, number>()

  changedAt(blueprint: string): number | null {
    return this.moved.get(blueprint) ?? null
  }

  private loads = 0

  revision(): number {
    return this.loads
  }

  private async changed(blueprints: string[]): Promise<void> {
    for (const bp of blueprints) this.moved.set(bp, Date.now())
    await this.onChanged(blueprints)
  }

  constructor(db: Db, blueprints: Blueprints, reader: Reader, log: Logger) {
    this.db = db
    this.blueprints = blueprints
    this.reader = reader
    this.log = log
    reader.attachScorecards(this)
    blueprints.attachGuard((spec) => {
      for (const [name, def] of Object.entries(spec.fields)) if (def.aggregation?.where) this.checkLevels(def.aggregation.where, `Field "${name}": aggregation`)
      this.checkCycles({ blueprint: spec })
    })
  }

  async load(): Promise<void> {
    const rows = await this.db.query<{ id: string; spec: ScorecardSpec; origin: DefinitionOrigin; updated_at: Date }>('SELECT * FROM scorecards ORDER BY id')
    this.cache = inDependencyOrder(rows.rows.map((r) => ({ ...r.spec, id: r.id, origin: r.origin, updatedAt: r.updated_at.toISOString() }) as Scorecard))
    this.loads++
  }

  /** Every scorecard, by id. */
  list(): Scorecard[] {
    return [...this.cache].sort((a, b) => a.id.localeCompare(b.id))
  }

  /**
   * Refuses a filter that names a scorecard the hub does not have, or a level
   * that scorecard does not have. `bound` limits which scorecards it may read
   * a level of: a rule reads the entity it scores, so only one that scores the
   * same blueprint has a level there.
   */
  checkLevels(f: Filter, what: string, extra: CardShape[] = [], bound?: string): void {
    for (const leaf of levelLeaves(f)) {
      const sc = extra.find((c) => c.id === leaf.scorecard) ?? this.get(leaf.scorecard)
      if (!sc) throw new ScorecardError(400, `${what}: no scorecard "${leaf.scorecard}"`)
      if (bound && !blueprintsOf(sc).includes(bound)) throw new ScorecardError(400, `${what}: scorecard "${sc.id}" does not score ${bound}, so it has no level here`)
      const names = [NONE_LEVEL, ...sc.levels.map((l) => l.name)]
      for (const v of leaf.op === 'exists' ? [] : Array.isArray(leaf.value) ? leaf.value : [leaf.value]) {
        if (typeof v !== 'string' || !names.includes(v)) throw new ScorecardError(400, `${what}: scorecard "${sc.id}" has no level "${String(v)}"; its levels are ${names.join(', ')}`)
      }
    }
  }

  /** Throws when saving these blueprints, or this scorecard, would make a loop through a level. */
  checkCycles(change: { blueprint?: BlueprintInput; scorecard?: CardShape }): void {
    const cards: CardShape[] = this.cache.filter((c) => c.id !== change.scorecard?.id)
    if (change.scorecard) cards.push(change.scorecard)
    const bps: BlueprintInput[] = this.blueprints.list().filter((b) => b.id !== change.blueprint?.id)
    if (change.blueprint) bps.push(change.blueprint)
    const loop = levelCycle(cards, bps, change.scorecard ? `scorecard ${change.scorecard.id}` : undefined)
    if (loop) {
      this.log.warn('level loop refused', { loop })
      throw new ScorecardError(400, `A scorecard would read its own level: ${loop.join(' → ')}`)
    }
  }

  get(id: string): Scorecard | undefined {
    return this.cache.find((s) => s.id === id)
  }

  forBlueprint(blueprint: string): Scorecard[] {
    return this.cache.filter((s) => blueprintsOf(s).includes(blueprint))
  }

  /** The id a scorecard is stored under: its own, or one made from its blueprint and title. */
  idFor(spec: { id?: unknown; blueprint?: unknown; title?: unknown }): string {
    return typeof spec.id === 'string' ? spec.id : `${String(spec.blueprint)}_${String(spec.title).toLowerCase().replace(/[^a-z0-9]+/g, '_')}`
  }

  /**
   * Refuses a field name the blueprint does not have. A rule or a scope that
   * names one would read nothing on every entity, which is a typo, not a
   * standard. What the hub keeps about every entity, by its bare or `$` name,
   * is always there.
   */
  private checkFields(part: ScorecardPart, bp: BlueprintInput, what: string): void {
    for (const f of partFilters(part)) {
      for (const name of fieldsOf(f)) {
        const plain = name.startsWith('fields.') ? name.slice(7) : name
        if (plain.startsWith('$') || plain in bp.fields || META_FIELDS.has(plain)) continue
        throw new ScorecardError(400, `${what} "${plain}", which blueprint "${bp.id}" does not have`)
      }
    }
  }

  async save(input: unknown, origin: ScorecardOrigin): Promise<Scorecard> {
    const parsed = scorecardSchema.safeParse(input)
    if (!parsed.success) throw new ScorecardError(400, `Invalid scorecard: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
    const spec = parsed.data
    const id = this.idFor(spec)
    const names = spec.levels.map((l) => l.name)
    const parts = partsOf(spec)
    for (const [blueprint, own] of Object.entries(spec.blueprints ?? {})) {
      for (const level of Object.keys(own.rules)) if (!names.includes(level)) throw new ScorecardError(400, `Blueprint "${blueprint}" has rules for level "${level}", which the scorecard does not have; its levels are ${names.join(', ')}`)
      if (!Object.values(own.rules).some((r) => r.length)) throw new ScorecardError(400, `Blueprint "${blueprint}" has no rules`)
    }
    for (const part of parts) {
      const bp = this.blueprints.get(part.blueprint)
      if (!bp) throw new ScorecardError(400, `Unknown blueprint "${part.blueprint}"`)
      // A level is worked out from the entity and its stored neighbours alone: the values of what a relation reaches are not there to read.
      if (partFilters(part).some((f) => neighbourWheres(f).length)) throw new ScorecardError(400, `On ${part.blueprint}, a rule or the scope reads the values of what a relation reaches, which a scorecard cannot read`)
      // A one-blueprint scorecard is saved as it always was; one that names several is checked field by field, so one pillar cannot drift on one blueprint unnoticed.
      if (spec.blueprints) this.checkFields(part, bp, `On ${part.blueprint}, a rule reads`)
      // The records that say why name their fields on a blueprint the hub knows.
      if (part.reasons) {
        const from = this.blueprints.get(part.reasons.from)
        if (!from) throw new ScorecardError(400, `On ${part.blueprint}, reasons come from unknown blueprint "${part.reasons.from}"`)
        const { level, says, fix, link } = part.reasons
        for (const [what, name] of [['level', level], ['says', says], ['fix', fix], ['link', link]] as const) if (name && !(name in from.fields)) throw new ScorecardError(400, `On ${part.blueprint}, reasons read "${name}" as ${what}, which blueprint "${from.id}" does not have`)
      }
      // A rule id is a column of the matrix, and the matrix of one blueprint holds every rule it has.
      const ids = new Set<string>()
      for (const l of part.levels) for (const r of l.rules) {
        if (ids.has(r.id)) throw new ScorecardError(400, spec.blueprints ? `Rule id "${r.id}" appears twice on ${part.blueprint}` : `Rule id "${r.id}" appears twice`)
        ids.add(r.id)
      }
    }
    const existing = this.get(id)
    if (existing && existing.origin.kind === 'git' && origin.kind !== 'git') throw new ScorecardError(400, `Scorecard "${id}" is defined in git (${existing.origin.file}); edit it there`)
    // A judge's scorecard is its own: the next put would undo a hand change, and another source would fight it.
    if (existing?.origin.kind === 'source' && !(origin.kind === 'source' && origin.source === existing.origin.source)) {
      this.log.warn('scorecard save refused: put by a source', { scorecard: id, owner: existing.origin.source, by: origin.kind === 'source' ? origin.source : origin.kind })
      throw new ScorecardError(400, `Scorecard "${id}" is put by source "${existing.origin.source}"; change it there`)
    }
    const self: CardShape = { ...spec, id }
    for (const part of parts) {
      if (part.where) this.checkLevels(part.where, 'Scope', [self], part.blueprint)
      for (const l of part.levels) for (const r of l.rules) this.checkLevels(r.where, `Rule "${r.id}"`, [self], part.blueprint)
    }
    this.checkCycles({ scorecard: self })
    await this.db.query(
      `INSERT INTO scorecards (id, spec, origin, updated_at) VALUES ($1, $2, $3, now()) ON CONFLICT (id) DO UPDATE SET spec = EXCLUDED.spec, origin = EXCLUDED.origin, updated_at = now()`,
      [id, JSON.stringify({ ...spec, id }), JSON.stringify(origin)],
    )
    await this.load()
    // Git saves what it holds on every pass; only a save that changed something is activity.
    const { origin: was, updatedAt: _at, ...before } = existing ?? ({} as Partial<Scorecard>)
    if (!existing || stable(before) !== stable({ ...spec, id }) || stable(was) !== stable(origin)) {
      await record(this.db, 'scorecard.changed', spec.blueprint ? { blueprint: spec.blueprint } : null, 'source' in origin ? origin.source : null, null, { scorecard: id, created: !existing, origin })
      await this.changed([...new Set([...(existing ? partsOf(existing).map((p) => p.blueprint) : []), ...partsOf(this.cache.find((x) => x.id === id)!).map((p) => p.blueprint)])])
    }
    this.log.info('scorecard saved', { scorecard: id, origin: origin.kind, blueprints: parts.map((p) => p.blueprint), levels: spec.levels.length })
    return this.get(id)!
  }

  /** `by` is who removes it: git removes what it defined, a source only what it put, and a person anything git did not define. */
  async remove(id: string, by: ScorecardOrigin = { kind: 'ui' }): Promise<void> {
    const existing = this.get(id)
    if (!existing) throw new ScorecardError(404, `Unknown scorecard "${id}"`)
    const origin = by.kind
    if (existing.origin.kind === 'git' && origin !== 'git') throw new ScorecardError(400, `Scorecard "${id}" is defined in git; remove it there`)
    if (by.kind === 'source' && !(existing.origin.kind === 'source' && existing.origin.source === by.source)) {
      this.log.warn('scorecard removal refused: not put by this source', { scorecard: id, source: by.source, origin: existing.origin.kind })
      throw new ScorecardError(400, `Source "${by.source}" did not put scorecard "${id}"`)
    }
    await this.db.query('DELETE FROM scorecards WHERE id = $1', [id])
    await this.db.query('DELETE FROM scorecard_history WHERE scorecard = $1', [id])
    await this.load()
    await record(this.db, 'scorecard.changed', existing.blueprint ? { blueprint: existing.blueprint } : null, 'source' in by ? by.source : null, null, { scorecard: id, removed: true })
    await this.changed(partsOf(existing).map((p) => p.blueprint))
    this.log.info('scorecard removed', { scorecard: id })
  }

  /** Scores every active entity of every blueprint the scorecard scores. */
  async results(id: string): Promise<ScorecardResults> {
    const sc = this.get(id)
    if (!sc) throw new ScorecardError(404, `Unknown scorecard "${id}"`)
    const { rows, out } = await this.scoreAll(sc)
    const counts = new Array(sc.levels.length + 1).fill(0) as number[]
    for (const r of rows) counts[r.level + 1]!++
    return { scorecard: sc, rows, counts, outOfScope: out.length }
  }

  /** Every active entity of the scorecard's blueprints: a row for each in scope, and the refs of those it leaves out. */
  private async scoreAll(sc: Scorecard): Promise<{ rows: ScorecardRow[]; out: EntityRef[] }> {
    const rows: ScorecardRow[] = []
    const out: EntityRef[] = []
    for (const part of partsOf(sc)) {
      let scored = 0
      let seen = 0
      // One block at a time, so a blueprint of any size is scored without being held whole in memory.
      for (let offset = 0; ; offset += SCORE_BLOCK) {
        const { entities, total } = await this.reader.list({ blueprint: part.blueprint, states: ['active'], limit: SCORE_BLOCK, offset, incoming: partUsesIncoming(part) })
        for (const e of entities) {
          const row = this.score(sc, e)
          if (row) (rows.push(row), scored++)
          else out.push({ blueprint: e.blueprint, key: e.key })
        }
        seen += entities.length
        if (!entities.length || seen >= total) break
      }
      if (part.where) this.log.debug('scorecard scope applied', { scorecard: sc.id, blueprint: part.blueprint, scored, outOfScope: seen - scored })
      else this.log.debug('scorecard has no scope; every entity scored', { scorecard: sc.id, blueprint: part.blueprint, scored })
    }
    return { rows, out }
  }

  /** Scores one entity; null when it is outside the scorecard's scope. A rule that asks who points at the entity needs `incomingRefs` on it. */
  score(sc: Scorecard, e: Entity): ScorecardRow | null {
    return scoreEntity(sc, e)
  }

  /** Levels for one entity across every scorecard on its blueprint that has it in scope. */
  forEntity(e: Entity): { scorecard: string; title: string; level: number; levelName: string; levels: string[] }[] {
    return this.forBlueprint(e.blueprint).flatMap((sc) => {
      const r = this.score(sc, e)
      return r ? [{ scorecard: sc.id, title: sc.title, level: r.level, levelName: r.levelName, levels: sc.levels.map((l) => l.name) }] : []
    })
  }

  /**
   * Records a history point for every entity whose level changed since the
   * last point. The level is the one the stored row holds, compared and
   * written in one statement a scorecard: no entity is built or scored again
   * for a point, so a pass over a blueprint of any size reads only its levels.
   */
  async recordHistory(): Promise<number> {
    let recorded = 0
    for (const sc of this.cache) {
      const blueprints = blueprintsOf(sc)
      for (const blueprint of blueprints) await this.reader.ensureDerived(blueprint, this.reader.staleBefore(blueprint))
      // In scope, a row's level is the last it reached, or none. Out of scope, the scorecard is absent from its levels:
      // an entity that left the scope stops counting from here on, with one point no level answers to.
      const written = await this.db.query(
        `INSERT INTO scorecard_history (scorecard, blueprint, key, level)
         SELECT $1::text, n.blueprint, n.key, n.level
         FROM (SELECT e.blueprint, e.key, CASE WHEN jsonb_typeof(d.levels->$1::text) = 'array' THEN coalesce(d.levels->$1::text->>(-1), $3::text) ELSE $4::text END AS level
               FROM entities e JOIN derived d ON d.blueprint = e.blueprint AND d.key = e.key
               WHERE e.blueprint = ANY($2::text[]) AND e.state = 'active' AND NOT e.hidden) n
         LEFT JOIN LATERAL (SELECT h.level FROM scorecard_history h WHERE h.scorecard = $1::text AND h.blueprint = n.blueprint AND h.key = n.key ORDER BY h.at DESC LIMIT 1) was ON TRUE
         WHERE was.level IS DISTINCT FROM n.level AND NOT (n.level = $4::text AND was.level IS NULL)
         ON CONFLICT DO NOTHING`,
        [sc.id, blueprints, NONE, OUT_OF_SCOPE],
      )
      recorded += written.rowCount ?? 0
    }
    if (recorded) this.log.info('scorecard history recorded', { points: recorded })
    return recorded
  }

  /** Entities per level per day over the last `days`, from the history. */
  async trend(id: string, days = 30): Promise<ScorecardTrend> {
    const sc = this.get(id)
    if (!sc) throw new ScorecardError(404, `Unknown scorecard "${id}"`)
    const rows = await this.db.query<{ blueprint: string; key: string; level: string; at: Date }>('SELECT blueprint, key, level, at FROM scorecard_history WHERE scorecard = $1 ORDER BY at', [id])
    const levels = [NONE, ...sc.levels.map((l) => l.name)]
    const dayList: string[] = []
    for (let i = days - 1; i >= 0; i--) dayList.push(new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10))
    const series: Record<string, number[]> = Object.fromEntries(levels.map((l) => [l, new Array(days).fill(0)]))
    dayList.forEach((day, di) => {
      const cutoff = new Date(`${day}T23:59:59.999Z`)
      const state = new Map<string, string>()
      for (const r of rows.rows) {
        if (r.at <= cutoff) state.set(`${r.blueprint}:${r.key}`, r.level)
      }
      for (const level of state.values()) if (series[level]) series[level]![di]!++
    })
    return { days: dayList, levels, series }
  }
}
