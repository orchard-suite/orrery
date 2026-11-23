// Relations the hub computes. A relation rule says "link every <blueprint>
// to the <target> whose <path> equals my <path>"; its matches land in the
// `rule` layer, below anything a pusher sets directly. A relation that names
// a path to inherit from is filled from that path while nothing else sets
// it; that lands in the `inherited` layer, below everything.
//
// Re-linking reads whole blueprints, so it is done only where something
// moved: the hub keeps the blueprints whose entities or relations changed
// since the last pass, and a pass re-links only what reads one of them.
// An inherited relation with no condition reads who is linked to whom and
// no value, so it is filled again only where an entity came or went or a
// link changed.
// Everything is re-linked when the model changes, when a hub starts or
// takes the lead, and on a slow clock as the net under those passes.

import { z } from 'zod'
import { matches, parsePath, splitMirror, usesIncoming, type Hop } from '../shared/filter.ts'
import { RESERVED_PREFIX, entityId, inheritCases, type DefinitionOrigin, type Entity, type RelationDef, type RelationRule } from '../shared/model.ts'
import { record } from './activity.ts'
import type { Blueprints } from './blueprints.ts'
import type { Db, Queryable } from './db.ts'
import type { Events } from './events.ts'
import { NO_QUEUE, type Queue } from './derive.ts'
import type { EntityRef } from '../shared/model.ts'
import type { Logger } from './log.ts'
import type { Reader } from './read.ts'
import { stable } from './values.ts'
import { timed } from './metrics.ts'
import { NO_LOAD, relinkName, type Load } from './load.ts'
import { reachAlong } from './links.ts'
import { STALE_MS, journalHorizon, journalSince, type Moved } from './journal.ts'
import { DefinitionError } from './definition-error.ts'

export const ruleSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_.-]*$/).optional(),
  blueprint: z.string().min(1),
  relation: z.string().min(1),
  match: z.object({ target: z.string().min(1), where: z.string().min(1) }),
  optional: z.boolean().optional(),
})

interface Side {
  side: string
  path: string[]
}

/** Parses `target.key == source.tags['app-name']` into its two sides. */
export function parseWhere(expr: string): { source: string[]; target: string[] } {
  const sides = parseSides(expr, ['source', 'target'])
  return { source: sides.source!, target: sides.target! }
}

/** Parses `<a>.<path> == <b>.<path>` where a and b are the two given side names, in either order. */
export function parseSides(expr: string, names: [string, string]): Record<string, string[]> {
  const parts = expr.split('==')
  if (parts.length !== 2) throw new DefinitionError(`where must be "<a> == <b>", got "${expr}"`)
  const sides = parts.map((p) => parseSide(p.trim(), names))
  const out: Record<string, string[]> = {}
  for (const s of sides) out[s.side] = s.path
  if (!out[names[0]] || !out[names[1]]) throw new DefinitionError(`where must compare one ${names[0]}.<path> with one ${names[1]}.<path>, got "${expr}"`)
  return out
}

function parseSide(text: string, names: [string, string]): Side {
  const m = new RegExp(`^(${names[0]}|${names[1]})((?:\\.[A-Za-z_][A-Za-z0-9_-]*|\\[(?:'[^']*'|"[^"]*")\\])+)$`).exec(text)
  if (!m) throw new DefinitionError(`bad path "${text}": use ${names[0]}.tags['app-name'] or ${names[1]}.key`)
  const path: string[] = []
  for (const seg of m[2]!.matchAll(/\.([A-Za-z_][A-Za-z0-9_-]*)|\[(?:'([^']*)'|"([^"]*)")\]/g)) path.push(seg[1] ?? seg[2] ?? seg[3] ?? '')
  return { side: m[1]!, path }
}

export function valueAt(e: Entity, path: string[]): unknown {
  const [head, ...rest] = path
  let cur: unknown
  if (head === 'key' || head === 'title' || head === 'state' || head === 'owner') cur = e[head]
  else if (head === 'fields') cur = rest.length ? e.fields[rest.shift()!] : e.fields
  else cur = e.fields[head!]
  for (const seg of rest) {
    if (cur && typeof cur === 'object') cur = (cur as Record<string, unknown>)[seg]
    else return undefined
  }
  return cur
}

/** A relation that names a path to inherit from. */
interface Inherited {
  blueprint: string
  relation: string
  def: RelationDef
}

/** The parts of an entity a rule can match on that are stored on it and read nothing else. */
const OWN = new Set(['key', 'state', 'owner'])

/** One side of a rule: the blueprint it reads, the part every entity has or the field its path names, and whether it reads stored values alone. */
interface RuleSide {
  blueprint: string
  part: 'key' | 'title' | 'state' | 'owner' | null
  field: string | null
  own: boolean
}

/** What one side of a rule held when the rule was last evaluated: `stamp` moves when any of its entities does, `digest` only when what the rule matches on does. */
interface SideSeen {
  stamp: string
  digest: string
}

/** An inherited relation that more entities than this may have moved under is read whole: one read of the blueprint costs less than asking for so many by key. */
const WHOLE = 2000

export class Rules {
  private cache: RelationRule[] = []
  /** Told whenever the rules are read again, so what reads them follows. */
  private readonly listeners: (() => void)[] = []
  /** The deriver's queue: a link added or dropped moves both its ends. The hub wires it. */
  queue: Queue = NO_QUEUE
  /** Blueprints whose entities or relations moved since they were last re-linked. Null is everything: the hub just started, or the model changed. */
  private moved: Set<string> | null = null
  /** Those of `moved` where an entity came or went or a relation changed, and not only a value. */
  private linked = new Set<string>()
  /** When a pass last re-linked everything. */
  private allAt = 0
  /** Passes run one after another, so two commits never re-link the same rule at once. */
  private pass: Promise<void> = Promise.resolve()
  /** The pass waiting behind the running one, which every new commit joins. */
  private queued: Promise<void> | null = null
  /** The oldest transaction that could still have been open when the link journal was last read. Null until a pass has re-linked everything. */
  private horizon: string | null = null
  private lookedAt = 0
  /** The journal rows the last look read: one read again from a transaction that was still open then is not worked out twice. */
  private seen = new Set<string>()
  /** By rule, the rule as it was last evaluated and what its two sides held then. A rule whose sides hold the same is not evaluated again. */
  private readonly matched = new Map<string, { spec: string; sides: SideSeen[] }>()
  /** Each side's stamp as a pass last read it: many rules read the same side. */
  private stamps = new Map<string, Promise<string>>()
  /** Each side's digest in a pass, with the stamp the side held before and after it was read: it stands while the stamp does. */
  private digests = new Map<string, { stamp: string; digest: string }>()

  private readonly db: Db
  private readonly blueprints: Blueprints
  private readonly reader: Reader
  private readonly events: Events
  private readonly ledger: Pick<Load, 'note'>
  private readonly log: Logger

  constructor(db: Db, blueprints: Blueprints, reader: Reader, events: Events, log: Logger, ledger: Pick<Load, 'note'> = NO_LOAD) {
    this.db = db
    this.blueprints = blueprints
    this.reader = reader
    this.events = events
    this.ledger = ledger
    this.log = log
    events.subscribe((event) => {
      if (event.type === 'entity') this.touch([event.blueprint], event.values)
      else if (event.type === 'blueprints') this.moved = null
    })
  }

  /** Notes that entities or relations of these blueprints moved, for the next pass. `values` says only values moved: nothing came or went, and every link stands. */
  touch(blueprints: Iterable<string>, values = false): void {
    for (const b of blueprints) {
      this.moved?.add(b)
      if (!values) this.linked.add(b)
    }
  }

  async load(): Promise<void> {
    const rows = await this.db.query<{ id: string; blueprint: string; relation: string; target: string; where_expr: string; optional: boolean; origin: DefinitionOrigin }>('SELECT * FROM relation_rules ORDER BY id')
    this.cache = rows.rows.map((r) => ({ id: r.id, blueprint: r.blueprint, relation: r.relation, match: { target: r.target, where: r.where_expr }, ...(r.optional ? { optional: true } : {}), origin: r.origin }))
    // A rule that went, or says something else now, is evaluated afresh: its links may have gone with it.
    for (const [id, kept] of this.matched) {
      const rule = this.cache.find((r) => r.id === id)
      if (!rule || kept.spec !== stable([rule.blueprint, rule.relation, rule.match])) this.matched.delete(id)
    }
    for (const listener of this.listeners) listener()
  }

  /** Calls `listener` each time the rules are read again. */
  onLoad(listener: () => void): void {
    this.listeners.push(listener)
  }

  list(): RelationRule[] {
    return [...this.cache]
  }

  async save(input: unknown, origin: DefinitionOrigin): Promise<RelationRule> {
    const parsed = ruleSchema.safeParse(input)
    if (!parsed.success) throw new DefinitionError(`Invalid rule: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
    const r = parsed.data
    const bp = this.blueprints.require(r.blueprint)
    const def = bp.relations[r.relation]
    if (!def) throw new DefinitionError(`Blueprint "${r.blueprint}" has no relation "${r.relation}"`)
    if (def.target !== r.match.target) throw new DefinitionError(`Relation "${r.relation}" targets ${def.target}, not ${r.match.target}`)
    parseWhere(r.match.where)
    const id = r.id ?? `${r.blueprint}.${r.relation}`
    const existing = this.cache.find((x) => x.id === id)
    if (existing && existing.origin.kind === 'git' && origin.kind !== 'git') throw new DefinitionError(`Rule "${id}" is defined in git (${existing.origin.file}); edit it there`)
    await this.db.query(
      `INSERT INTO relation_rules (id, blueprint, relation, target, where_expr, optional, origin) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO UPDATE SET blueprint = EXCLUDED.blueprint, relation = EXCLUDED.relation, target = EXCLUDED.target, where_expr = EXCLUDED.where_expr, optional = EXCLUDED.optional, origin = EXCLUDED.origin`,
      [id, r.blueprint, r.relation, r.match.target, r.match.where, !!r.optional, JSON.stringify(origin)],
    )
    await this.load()
    // Git saves what it holds on every pass; only a save that changed something is activity.
    const same = existing && existing.blueprint === r.blueprint && existing.relation === r.relation && stable(existing.match) === stable(r.match) && !!existing.optional === !!r.optional && stable(existing.origin) === stable(origin)
    if (!same) {
      await record(this.db, 'rule.changed', { blueprint: r.blueprint }, 'source' in origin ? origin.source : null, null, { rule: id, created: !existing, origin })
      // What the estate says of the rule, such as whether it found a target, moves with it.
      this.events.emit({ type: 'estate', blueprints: [r.blueprint] })
    }
    this.log.info('relation rule saved', { rule: id, origin: origin.kind })
    return this.cache.find((x) => x.id === id)!
  }

  async remove(id: string, origin?: DefinitionOrigin['kind']): Promise<void> {
    const existing = this.cache.find((x) => x.id === id)
    if (!existing) throw new DefinitionError(`Unknown rule "${id}"`, 404)
    if (existing.origin.kind === 'git' && origin !== 'git') throw new DefinitionError(`Rule "${id}" is defined in git; remove it there`)
    await this.db.tx(async (client) => {
      await client.query('DELETE FROM relation_rules WHERE id = $1', [id])
      const gone = await client.query<{ blueprint: string; key: string; target_blueprint: string; target_key: string }>('DELETE FROM relations WHERE layer = $1 AND source = $2 RETURNING blueprint, key, target_blueprint, target_key', ['rule', `rule:${id}`])
      await this.queue.enqueue(client, gone.rows.flatMap((r) => [r, { blueprint: r.target_blueprint, key: r.target_key }]))
    })
    this.touch([existing.blueprint])
    await this.load()
    await record(this.db, 'rule.changed', { blueprint: existing.blueprint }, 'source' in existing.origin && origin === 'git' ? existing.origin.source : null, null, { rule: id, removed: true })
    this.events.emit({ type: 'estate', blueprints: [existing.blueprint] })
    this.log.info('relation rule removed', { rule: id })
  }

  /** Re-links the whole estate. Runs when the model changes, so a changed rule takes effect everywhere. */
  evaluateAll(): Promise<void> {
    this.moved = null
    return this.evaluateMoved()
  }

  /**
   * The periodic pass. Re-links what moved since the last pass, and
   * everything once `everyMs` has gone by since everything was last
   * re-linked: a whole pass reads every blueprint a rule names, and almost
   * every one finds nothing to change.
   */
  evaluateDue(everyMs: number): Promise<void> {
    if (Date.now() - this.allAt >= everyMs) this.moved = null
    return this.evaluateMoved()
  }

  /** Resolves when every pass already asked for has finished. */
  settled(): Promise<void> {
    return this.pass
  }

  /**
   * Re-links what reads something that moved since the last pass. Runs after
   * every commit. Commits that land while a pass runs share the one queued
   * after it, so a burst of pushes costs two passes, not one each.
   */
  evaluateMoved(): Promise<void> {
    if (this.queued) {
      this.log.debug('re-link pass joined the one already queued')
      return this.queued
    }
    const next = this.pass.then(() => {
      this.queued = null
      return this.relink()
    })
    this.queued = next
    this.pass = next.catch((error) => this.log.error('re-link pass failed', { error }))
    return next
  }

  /**
   * Every blueprint's entities read once in a pass for the conditions of the
   * inherited relations, until a rule or an inherited relation changes them.
   * Null outside a pass, where each read goes to the database. A rule never
   * reads through it: what a rule is kept as matching on must be what it read.
   */
  private read: Map<string, Promise<Entity[]>> | null = null

  /** A blueprint's entities, every one hidden or not, with their derived values, read afresh. */
  private entities(blueprint: string): Promise<Entity[]> {
    return this.reader.list({ blueprint, includeHidden: true, limit: Infinity }).then((r) => r.entities)
  }

  /** `entities`, read once in a pass: what a case's condition reads. */
  private entitiesOf(blueprint: string): Promise<Entity[]> {
    const fresh = () => this.entities(blueprint)
    if (!this.read) return fresh()
    let hit = this.read.get(blueprint)
    if (!hit) {
      hit = fresh()
      this.read.set(blueprint, hit)
    }
    return hit
  }

  /**
   * What one side of a rule reads, afresh each time: a blueprint's stored
   * values alone when the side names a stored value, and its entities
   * derived fields and all otherwise.
   */
  private sideOf(blueprint: string, path: string[]): Promise<Entity[]> {
    return this.side(blueprint, path).own ? this.reader.stored(blueprint) : this.entities(blueprint)
  }

  /**
   * A rule or an inherited relation changed relations: everything after it
   * in the pass reads the database again, since a changed relation moves the
   * derived fields of whatever reads through it, and its ends are derived
   * again before it returns. That moves the stamp of every side that reads a
   * derived value, so no stamp or digest read before it stands.
   */
  private forget(): void {
    this.read?.clear()
    this.stamps.clear()
    this.digests.clear()
  }

  private side(blueprint: string, path: string[]): RuleSide {
    const [head, next] = path
    const part = head === 'key' || head === 'title' || head === 'state' || head === 'owner' ? head : null
    const field = part ? null : ((head === 'fields' ? next : head) ?? null)
    const def = field === null ? undefined : this.blueprints.get(blueprint)?.fields[field]
    return { blueprint, part, field, own: !!part || (!!def && !def.mirror && !def.aggregation && !def.calculation) }
  }

  /** A rule's two sides, where what they hold can be told from what is stored. Null for a hub blueprint, whose live facts are laid over as it is read and stored nowhere. */
  private sidesOf(rule: RelationRule): RuleSide[] | null {
    if (rule.blueprint.startsWith(RESERVED_PREFIX) || rule.match.target.startsWith(RESERVED_PREFIX)) return null
    const where = parseWhere(rule.match.where)
    return [this.side(rule.blueprint, where.source), this.side(rule.match.target, where.target)]
  }

  /**
   * A side's stamp, a count and a sum of each row's hash, so it reads in any
   * order: it moves when an entity of the side comes, goes, or has a
   * stored value or its state moved, and, for a side that reads derived
   * values, when a stored derived row moved. It reads no value, so it costs
   * little, and says nothing of which value moved.
   */
  private stamp(side: RuleSide, afresh = false): Promise<string> {
    const name = `${side.blueprint}\u0000${side.own}`
    let hit = afresh ? undefined : this.stamps.get(name)
    if (!hit) {
      hit = this.db
        .query<{ stamp: string }>(
          side.own
            ? `SELECT (count(*) || ':' || coalesce(sum(hashtextextended(concat_ws(chr(31), e.key, e.state, e.title, e.owner, e.updated_at::text), 0)), 0)) AS stamp FROM entities e WHERE e.blueprint = $1 AND e.state IN ('active', 'missing')`
            : `SELECT (count(*) || ':' || coalesce(sum(hashtextextended(concat_ws(chr(31), e.key, e.state, e.title, e.owner, e.updated_at::text, d.fingerprint), 0)), 0)) AS stamp
               FROM entities e LEFT JOIN derived d ON d.blueprint = e.blueprint AND d.key = e.key WHERE e.blueprint = $1 AND e.state IN ('active', 'missing')`,
          [side.blueprint],
        )
        .then((r) => r.rows[0]!.stamp)
      this.stamps.set(name, hit)
    }
    return hit
  }

  /**
   * A digest of what a rule matches on in a side: each entity's key and the
   * one part or field the rule reads, as each layer holds it or as its
   * derived row does, over the entities a rule reads. Nothing else of an
   * entity moves what a rule links, so a title that moves passes the rule
   * over. Null when a derived row is behind its entity: the rule then reads
   * a value worked out for the read, which is stored nowhere to compare with.
   */
  private async digest(side: RuleSide): Promise<string | null> {
    const sum = (held: string) => `(count(*) || ':' || coalesce(sum(hashtextextended(concat_ws(chr(31), e.key, ${held}), 0)), 0))`
    if (side.part) {
      const res = await this.db.query<{ digest: string }>(`SELECT ${sum(`coalesce(e.${side.part}, '')`)} AS digest FROM entities e WHERE e.blueprint = $1 AND e.state IN ('active', 'missing')`, [side.blueprint])
      return res.rows[0]!.digest
    }
    if (side.own) {
      const held = `coalesce((e.git -> $2 -> 'value')::text, ''), coalesce((e.override -> $2)::text, ''), coalesce((e.pushed -> $2 -> 'value')::text, ''), coalesce((e.ui -> $2 -> 'value')::text, '')`
      const res = await this.db.query<{ digest: string }>(`SELECT ${sum(held)} AS digest FROM entities e WHERE e.blueprint = $1 AND e.state IN ('active', 'missing')`, [side.blueprint, side.field ?? ''])
      return res.rows[0]!.digest
    }
    const res = await this.db.query<{ digest: string; behind: boolean | null }>(
      `SELECT ${sum(`coalesce((d.fields -> $2)::text, '')`)} AS digest, bool_or(d.derived_at IS NULL OR d.derived_at < e.updated_at) AS behind
       FROM entities e LEFT JOIN derived d ON d.blueprint = e.blueprint AND d.key = e.key WHERE e.blueprint = $1 AND e.state IN ('active', 'missing')`,
      [side.blueprint, side.field ?? ''],
    )
    return res.rows[0]!.behind ? null : res.rows[0]!.digest
  }

  /** A side's name in the pass's digests: two rules that read the same part of the same blueprint share it. */
  private named(side: RuleSide): string {
    return `${side.blueprint}\u0000${side.own}\u0000${side.part ?? ''}\u0000${side.field ?? ''}`
  }

  /** Whether both sides of a rule hold what they held when it was last evaluated: nothing it would work out can differ. */
  private async asItWas(rule: RelationRule, sides: RuleSide[], stamps: string[]): Promise<boolean> {
    const kept = this.matched.get(rule.id)
    if (!kept || kept.spec !== stable([rule.blueprint, rule.relation, rule.match])) return false
    for (const [i, side] of sides.entries()) {
      if (kept.sides[i]!.stamp === stamps[i]) continue
      // Something of the side moved: only what the rule matches on decides.
      const digest = await this.digest(side)
      // Read after the stamp: judge takes it only while a fresh stamp says nothing moved since.
      if (digest !== null) this.digests.set(this.named(side), { stamp: stamps[i]!, digest })
      if (digest !== kept.sides[i]!.digest) return false
    }
    for (const [i, seen] of kept.sides.entries()) seen.stamp = stamps[i]!
    return true
  }

  /**
   * Evaluates a rule and keeps what its sides held as it did. The stamps are
   * read afresh before the digests, the rule then reads its sides afresh,
   * and the stamps are read again: only when neither moved is the digest of
   * what the rule read, and kept. A stamp kept from earlier in the pass may
   * be older than what the rule reads, so none is used here.
   */
  private async judge(rule: RelationRule, sides: RuleSide[] | null, asked: string[] | null): Promise<void> {
    this.matched.delete(rule.id)
    const stamps = sides && asked ? await Promise.all(sides.map((side) => this.stamp(side, true))).catch(() => null) : null
    // A digest that cannot be read keeps nothing: the rule is evaluated all the same.
    const digests =
      sides && stamps
        ? await Promise.all(
            sides.map(async (side, i) => {
              const kept = this.digests.get(this.named(side))
              return kept && kept.stamp === stamps[i] ? kept.digest : this.digest(side)
            }),
          ).catch(() => null)
        : null
    await this.evaluate(rule)
    if (!sides || !stamps || !digests) return
    const after = await Promise.all(sides.map((side) => this.stamp(side, true))).catch(() => null)
    if (!after) return
    const seen: SideSeen[] = []
    for (const [i, side] of sides.entries()) {
      const digest = digests[i]
      if (digest === null || digest === undefined || after[i] !== stamps[i]) return
      this.digests.set(this.named(side), { stamp: after[i]!, digest })
      seen.push({ stamp: after[i]!, digest })
    }
    this.matched.set(rule.id, { spec: stable([rule.blueprint, rule.relation, rule.match]), sides: seen })
  }

  private async relink(): Promise<void> {
    this.read = new Map()
    this.stamps = new Map()
    this.digests = new Map()
    try {
      await timed('rules.relink', () => this.relinkOnce())
    } finally {
      this.read = null
    }
  }

  private async relinkOnce(): Promise<void> {
    let moved = this.moved
    const linked = this.linked
    this.moved = new Set()
    this.linked = new Set()
    if (moved && (this.horizon === null || Date.now() - this.lookedAt > STALE_MS)) {
      this.log.info('everything is re-linked: the last look at what moved is older than the journal keeps')
      moved = null
    }
    if (!moved) {
      this.allAt = Date.now()
      // Taken before anything is read: what moves from here on is read at the next pass, and what this pass already saw is read again harmlessly.
      this.horizon = await journalHorizon(this.db)
      this.lookedAt = Date.now()
      this.seen = new Set()
    }
    // What a rule or an inherited relation changes earlier in the pass counts for those after it.
    const due = (reads: Set<string> | null, links = false): boolean => {
      const since = this.moved
      if (!moved || !since || !reads) return true
      const [was, now] = links ? [linked, this.linked] : [moved, since]
      for (const b of reads) if (was.has(b) || now.has(b)) return true
      return false
    }
    let skipped = 0
    let same = 0
    if (moved && !moved.size) {
      skipped = this.cache.length
      this.log.debug('nothing moved: no rule re-linked')
    } else {
      for (const rule of this.cache) {
        if (!due(this.ruleReads(rule))) {
          skipped++
          this.log.debug('rule skipped: nothing it reads moved', { rule: rule.id })
          continue
        }
        try {
          // Each rule yields first, so the requests waiting behind a long pass are answered between rules.
          await new Promise((resolveYield) => setImmediate(resolveYield))
          let sides = this.sidesOf(rule)
          let stamps: string[] | null = null
          try {
            stamps = sides && (await Promise.all(sides.map((side) => this.stamp(side))))
            if (moved && sides && stamps && (await this.asItWas(rule, sides, stamps))) {
              same++
              this.log.debug('rule skipped: what it matches on is as it was', { rule: rule.id })
              continue
            }
          } catch (error) {
            // What its sides hold could not be read: the rule is evaluated all the same, and nothing is kept of it.
            this.log.warn('rule evaluated without what its sides held', { rule: rule.id, error })
            sides = null
            this.matched.delete(rule.id)
          }
          await this.judge(rule, sides, stamps)
        } catch (error) {
          this.log.error('rule evaluation failed', { rule: rule.id, error })
        }
      }
    }
    if (!moved) await this.inheritAll()
    else await this.inheritMoved((d) => due(this.inheritReads(d)))
    if (!moved || moved.size) this.log.info('re-link pass', { moved: moved ? [...moved] : 'everything', rules: this.cache.length - skipped - same, rulesSkipped: skipped, rulesAsTheyWere: same })
  }

  /**
   * Every blueprint an entity of `id` reads to work out its derived fields:
   * itself, what its mirrors and aggregations pass through, and what those
   * read in turn. Null when that cannot be told, which reads everything.
   */
  private reads(id: string, seen = new Set<string>()): Set<string> | null {
    if (seen.has(id)) return seen
    seen.add(id)
    const bp = this.blueprints.get(id)
    if (!bp) return seen
    for (const def of Object.values(bp.fields)) {
      const path = def.mirror ? splitMirror(def.mirror).path : def.aggregation?.relation
      if (!path) continue
      // Who points at the ends decides the value, and anything may point at them.
      if (def.aggregation?.where && usesIncoming(def.aggregation.where)) return null
      const through = this.along(id, path)
      if (!through) return null
      for (const b of through) if (!this.reads(b, seen)) return null
    }
    return seen
  }

  /** The blueprints a relation path passes through from `from`, ends included. Null for a path that does not parse. */
  private along(from: string, path: string): Set<string> | null {
    let hops
    try {
      hops = parsePath(path)
    } catch {
      return null
    }
    const through = new Set<string>()
    let at = new Set([from])
    for (const hop of hops) {
      const next = new Set<string>()
      for (const bp of this.blueprints.list()) {
        const def = bp.relations[hop.relation]
        if (!def) continue
        if (hop.incoming) {
          if (at.has(def.target) && (!hop.from || hop.from === bp.id)) next.add(bp.id)
        } else if (at.has(bp.id)) next.add(def.target)
      }
      for (const b of next) through.add(b)
      at = next
    }
    return through
  }

  /** What one side of a rule reads: the blueprint alone for a stored value, and everything its derived fields read otherwise. */
  private sideReads(blueprint: string, path: string[]): Set<string> | null {
    const [head, next] = path
    if (head && OWN.has(head)) return new Set([blueprint])
    const def = this.blueprints.get(blueprint)?.fields[(head === 'fields' ? next : head) ?? '']
    if (head === 'title' || (def && !def.mirror && !def.aggregation && !def.calculation)) return new Set([blueprint])
    return this.reads(blueprint)
  }

  private ruleReads(rule: RelationRule): Set<string> | null {
    const where = parseWhere(rule.match.where)
    const source = this.sideReads(rule.blueprint, where.source)
    const target = this.sideReads(rule.match.target, where.target)
    return source && target ? new Set([...source, ...target]) : null
  }

  /** What an inherited relation reads: every case's path, the target blueprint a fixed case names, and what a case's condition reads on the entity. */
  private inheritReads(d: Inherited): Set<string> | null {
    const out = new Set([d.blueprint])
    for (const c of inheritCases(d.def)) {
      const through = c.path ? this.along(d.blueprint, c.path) : new Set([d.def.target])
      if (!through) return null
      for (const b of through) out.add(b)
      if (c.when) {
        // A condition on a derived field reads what the field reads.
        const own = this.reads(d.blueprint)
        if (!own) return null
        for (const b of own) out.add(b)
      }
    }
    return out
  }

  private inherited(): Inherited[] {
    return this.blueprints.list().flatMap((bp) =>
      Object.entries(bp.relations)
        .filter(([, def]) => def.inherit)
        .map(([relation, def]) => ({ blueprint: bp.id, relation, def })),
    )
  }

  /**
   * Fills every relation that names a path to inherit from, wherever nothing
   * sets the relation on the entity itself.
   */
  async inheritAll(): Promise<void> {
    const live = this.inherited().map((d) => `inherit:${d.blueprint}.${d.relation}`)
    const stale = await this.db.tx(async (client) => {
      const gone = await client.query<{ blueprint: string; key: string; target_blueprint: string; target_key: string }>(`DELETE FROM relations WHERE layer = 'inherited' AND source <> ALL($1) RETURNING blueprint, key, target_blueprint, target_key`, [live])
      await this.queue.enqueue(client, gone.rows.flatMap((r) => [r, { blueprint: r.target_blueprint, key: r.target_key }]))
      return new Set(gone.rows.flatMap((r) => [r.blueprint, r.target_blueprint]))
    })
    await this.inheritWhere(() => true)
    if (stale.size) this.events.emit({ type: 'estate', blueprints: [...stale] })
  }

  /**
   * Fills the inherited relations `due` picks. One inherited relation can
   * feed the next (a resource reads its group's environment, which reads its
   * subscription's), so this repeats until nothing moves.
   */
  private async inheritWhere(due: (d: Inherited) => boolean): Promise<void> {
    const defs = this.inherited()
    for (let round = 0; defs.length && round < 8; round++) {
      let changed = false
      for (const d of defs) {
        if (!due(d)) {
          this.log.debug('inherited relation skipped: nothing it reads moved', { blueprint: d.blueprint, relation: d.relation })
          continue
        }
        try {
          changed = (await timed('rules.inherit', () => this.inherit(d.blueprint, d.relation, d.def))) || changed
        } catch (error) {
          this.log.error('relation inheritance failed', { blueprint: d.blueprint, relation: d.relation, error })
        }
      }
      if (!changed) break
    }
  }

  /**
   * Fills the inherited relations something moved under since the last look
   * at the link journal, each for the entities that moved alone. A relation
   * with a case that reads the entity's values (`when`) is not told by the
   * journal: it is filled whole when `due` says a blueprint it reads moved.
   * What one relation fills is journalled as any link is, so the next round
   * reads it, until a round changes nothing.
   */
  private async inheritMoved(due: (d: Inherited) => boolean): Promise<void> {
    const defs = this.inherited()
    for (let round = 0; defs.length && round < 8; round++) {
      const looked = await journalSince(this.db, this.horizon)
      const moves = looked.moved.filter((m) => !this.seen.has(m.seq))
      this.horizon = looked.horizon
      this.lookedAt = Date.now()
      this.seen = new Set(looked.moved.map((m) => m.seq))
      let changed = false
      for (const d of defs) {
        try {
          let only: string[] | null = null
          if (inheritCases(d.def).some((c) => c.when)) {
            if (!due(d)) {
              this.log.debug('inherited relation skipped: nothing it reads moved', { blueprint: d.blueprint, relation: d.relation })
              continue
            }
          } else {
            only = await this.movedUnder(d, moves)
            if (only && !only.length) continue
          }
          const keys = only
          changed = (await timed('rules.inherit', () => this.inherit(d.blueprint, d.relation, d.def, keys))) || changed
        } catch (error) {
          this.log.error('relation inheritance failed', { blueprint: d.blueprint, relation: d.relation, error })
        }
      }
      if (!changed) break
    }
  }

  /**
   * The keys of the entities whose inherited relation these moves may have
   * changed: the entity itself came, went, or had the relation set or
   * cleared, or a link moved, or an entity came or went, somewhere along a
   * path it inherits by. Each is found by walking the path back, over the
   * links as they stand, from where the move is: the entity holding a link
   * that moved still reaches back to whoever read through it. It may name an
   * entity nothing changed for, never miss one. Null is every entity.
   */
  private async movedUnder(d: Inherited, moves: Moved[]): Promise<string[] | null> {
    if (!moves.length) return []
    const keys = new Set<string>()
    for (const m of moves) if (m.blueprint === d.blueprint && (m.relation === null || m.relation === d.relation)) keys.add(m.key)
    for (const c of inheritCases(d.def)) {
      if (!c.path) {
        // A fixed target that came or went moves every entity that falls through to it.
        if (moves.some((m) => m.relation === null && m.blueprint === d.def.target && m.key === c.target)) return null
        continue
      }
      let hops: Hop[]
      try {
        hops = parsePath(c.path)
      } catch {
        return null
      }
      const kinds = this.kindsAlong(d.blueprint, hops)
      // By place on the path (0 is the entity itself), the entities a move stands at.
      const at: Map<string, EntityRef>[] = kinds.map(() => new Map())
      const stand = (place: number, blueprint: string, key: string): void => {
        if (kinds[place]!.has(blueprint)) at[place]!.set(`${blueprint}:${key}`, { blueprint, key })
      }
      for (const m of moves) {
        if (m.relation === null) {
          for (let place = 1; place < kinds.length; place++) stand(place, m.blueprint, m.key)
          continue
        }
        if (m.targetBlueprint === null || m.targetKey === null) continue
        // A link a hop steps along stands at the place the hop steps from: its holder going out, what it points at going in.
        for (const [i, hop] of hops.entries()) {
          if (hop.relation !== m.relation) continue
          if (hop.incoming) stand(i, m.targetBlueprint, m.targetKey)
          else stand(i, m.blueprint, m.key)
        }
      }
      let carried = new Map<string, EntityRef>()
      for (let place = hops.length; place >= 1; place--) {
        const from = new Map([...carried, ...at[place]!])
        carried = await this.back(hops[place - 1]!, [...from.values()], kinds[place - 1]!)
        if (carried.size > WHOLE) return null
      }
      for (const ref of [...carried.values(), ...at[0]!.values()]) keys.add(ref.key)
      if (keys.size > WHOLE) return null
    }
    return [...keys]
  }

  /** The blueprints an entity at each place on a path from `from` may be of: place 0 is `from` itself. */
  private kindsAlong(from: string, hops: Hop[]): Set<string>[] {
    const kinds = [new Set([from])]
    for (const hop of hops) {
      const before = kinds.at(-1)!
      const next = new Set<string>()
      for (const bp of this.blueprints.list()) {
        const def = bp.relations[hop.relation]
        if (!def) continue
        if (hop.incoming) {
          if (before.has(def.target) && (!hop.from || hop.from === bp.id)) next.add(bp.id)
        } else if (before.has(bp.id)) next.add(def.target)
      }
      kinds.push(next)
    }
    return kinds
  }

  /** One hop walked backwards: the entities of `kinds` that step along `hop` to one of `refs`, over every link as it stands, whichever layer holds it and whatever state its ends are in. */
  private async back(hop: Hop, refs: EntityRef[], kinds: Set<string>): Promise<Map<string, EntityRef>> {
    const out = new Map<string, EntityRef>()
    if (!refs.length || !kinds.size) return out
    // Going out, a hop steps from the holder of a link to what it points at; going in, the other way.
    const [near, far] = hop.incoming ? ['target_', ''] : ['', 'target_']
    const rows = await this.db.query<{ blueprint: string; key: string }>(
      `SELECT DISTINCT r.${near}blueprint AS blueprint, r.${near}key AS key FROM relations r
       WHERE (r.${far}blueprint, r.${far}key) IN (SELECT * FROM unnest($1::text[], $2::text[])) AND r.relation = $3 AND r.${near}blueprint = ANY($4::text[])`,
      [refs.map((r) => r.blueprint), refs.map((r) => r.key), hop.relation, [...kinds]],
    )
    for (const r of rows.rows) out.set(`${r.blueprint}:${r.key}`, r)
    return out
  }

  /**
   * Fills one inherited relation: for every entity of the blueprint, or,
   * given `only`, for the entities of those keys alone. It reads the keys,
   * which of them have the relation set by something else, and the links
   * along each path; an entity's values only where a case asks of them.
   */
  private async inherit(blueprint: string, relation: string, def: RelationDef, only: string[] | null = null): Promise<boolean> {
    const started = performance.now()
    let read = 0
    const cases = inheritCases(def)
    const keys = (
      await this.db.query<{ key: string }>(`SELECT key FROM entities WHERE blueprint = $1 AND state IN ('active', 'missing')${only ? ' AND key = ANY($2::text[])' : ''}`, only ? [blueprint, only] : [blueprint])
    ).rows.map((r) => r.key)
    // An entity whose relation is set by a rule, a source, a person, or git keeps what it has.
    const direct = new Set(
      (
        await this.db.query<{ key: string }>(
          `SELECT DISTINCT key FROM relations WHERE blueprint = $1 AND relation = $2 AND layer <> 'inherited'${only ? ' AND key = ANY($3::text[])' : ''}`,
          only ? [blueprint, relation, only] : [blueprint, relation],
        )
      ).rows.map((r) => r.key),
    )
    const open = keys.filter((key) => !direct.has(key))
    // A case's condition reads the entity's values, derived ones too: they are read only for a relation that has one.
    const values = cases.some((c) => c.when) ? new Map((only ? (await this.reader.list({ blueprint, includeHidden: true, limit: Infinity, filter: { field: '$key', op: 'in', value: open } })).entities : await this.entitiesOf(blueprint)).map((e) => [e.key, e])) : null
    // Each entity takes the first case it matches that reaches a target; one that reaches nothing passes it to the next.
    const wanted = new Set<string>()
    const taken: number[] = []
    let rest = open
    for (const c of cases) {
      const fits = c.when ? rest.filter((key) => { const e = values?.get(key); return !!e && matches(e, c.when!) }) : rest
      const reached = new Set<string>()
      if (fits.length && c.path) {
        const ends = await reachAlong(this.db, this.blueprints, fits.map((key) => `${blueprint}:${key}`), parsePath(c.path))
        const prefix = `${def.target}:`
        for (const key of fits) {
          const targets = (ends.get(`${blueprint}:${key}`) ?? []).filter((id) => id.startsWith(prefix))
          read += targets.length
          if (!targets.length) continue
          reached.add(key)
          for (const t of def.many ? targets : targets.slice(0, 1)) wanted.add(`${key}\u0000${t.slice(prefix.length)}`)
        }
      } else if (fits.length && c.target) {
        const there = (await this.reader.rowsFor([{ blueprint: def.target, key: c.target }], false)).length > 0
        if (!there) this.log.warn('inherited relation names a target that does not exist', { blueprint, relation, target: `${def.target}:${c.target}` })
        else
          for (const key of fits) {
            reached.add(key)
            wanted.add(`${key}\u0000${c.target}`)
          }
      }
      taken.push(reached.size)
      rest = rest.filter((key) => !reached.has(key))
    }
    const source = `inherit:${blueprint}.${relation}`
    const current = await this.db.query<{ key: string; target_blueprint: string; target_key: string }>(`SELECT key, target_blueprint, target_key FROM relations WHERE layer = $1 AND source = $2${only ? ' AND blueprint = $3 AND key = ANY($4::text[])' : ''}`, ['inherited', source, ...(only ? [blueprint, only] : [])])
    const held = new Map(current.rows.map((r) => [`${r.key}\u0000${r.target_key}`, r.target_blueprint]))
    const have = new Set(held.keys())
    const add = [...wanted].filter((k) => !have.has(k))
    const drop = [...have].filter((k) => !wanted.has(k))
    if (add.length || drop.length) {
      const pairs = (list: string[]) => list.map((k) => k.split('\u0000') as [string, string])
      const links: Link[] = [...pairs(drop).map(([key, target]): Link => [blueprint, key, held.get(`${key}\u0000${target}`)!, target]), ...pairs(add).map(([key, target]): Link => [blueprint, key, def.target, target])]
      await this.db.tx((client) => relink(client, this.queue, { blueprint, relation, layer: 'inherited', source }, links.slice(0, drop.length), links.slice(drop.length)))
      await this.queue.inline(endsOf(links))
      this.touch([blueprint])
      this.events.emit({ type: 'estate', blueprints: [blueprint] })
      this.forget()
    }
    this.ledger.note('relink', relinkName(blueprint, relation, 'inherit'), { calls: 1, ms: performance.now() - started, rows: keys.length + read, extra: add.length + drop.length })
    this.log.info('relation inherited', { blueprint, relation, asked: only ? only.length : 'every entity', cases: taken, entities: keys.length, setDirectly: keys.length - open.length, unmatched: rest.length, inherited: wanted.size, added: add.length, dropped: drop.length })
    return add.length + drop.length > 0
  }

  evaluate(rule: RelationRule): Promise<{ matched: number; unmatched: number; changed: boolean }> {
    return timed('rules.evaluate', () => this.evaluateRule(rule))
  }

  private async evaluateRule(rule: RelationRule): Promise<{ matched: number; unmatched: number; changed: boolean }> {
    const started = performance.now()
    const where = parseWhere(rule.match.where)
    const sources = await this.sideOf(rule.blueprint, where.source)
    const targets = await this.sideOf(rule.match.target, where.target)
    const many = !!this.blueprints.get(rule.blueprint)?.relations[rule.relation]?.many
    // A list on either side matches on any one of its members: a person with several addresses is found by each. The source's
    // list is also an order of preference, read below.
    const members = (v: unknown): unknown[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v.filter((x) => x !== undefined && x !== null) : [v])
    const index = new Map<string, Entity[]>()
    for (const t of targets) {
      for (const v of new Set(members(valueAt(t, where.target)).map(stable))) {
        const list = index.get(v)
        if (list) list.push(t)
        else index.set(v, [t])
      }
    }
    const wanted = new Set<string>()
    let matched = 0
    // A relation that holds one target and finds several has no evidence for any of them: it links none, rather than whichever
    // the read happened to list first, and says so.
    const ambiguous: { source: string; targets: string[] }[] = []
    for (const s of sources) {
      const seen = new Map<string, Entity>()
      // A list on the source side is in order of preference: for a relation that holds one target, the first member that
      // finds anything decides, so a specific name ahead of a general one wins. A relation that holds several takes every hit.
      for (const v of members(valueAt(s, where.source))) {
        for (const t of index.get(stable(v)) ?? []) seen.set(entityId(t), t)
        if (!many && seen.size) break
      }
      let hits = [...seen.values()]
      if (!hits.length) continue
      if (!many && hits.length > 1) {
        // A target its source no longer sees is weaker evidence than one it does: one still seen among them is the one.
        const current = hits.filter((t) => t.state === 'active')
        if (current.length !== 1) {
          ambiguous.push({ source: s.key, targets: hits.map((t) => t.key).sort() })
          continue
        }
        hits = current
      }
      matched++
      for (const t of hits) wanted.add(`${s.blueprint}\u0000${s.key}\u0000${t.blueprint}\u0000${t.key}`)
    }
    if (ambiguous.length) this.log.warn('rule matched several targets for one relation, linked none', { rule: rule.id, sources: ambiguous.length, first: ambiguous.slice(0, 5) })
    const source = `rule:${rule.id}`
    const current = await this.db.query<{ blueprint: string; key: string; target_blueprint: string; target_key: string }>('SELECT blueprint, key, target_blueprint, target_key FROM relations WHERE layer = $1 AND source = $2', ['rule', source])
    const have = new Set(current.rows.map((r) => `${r.blueprint}\u0000${r.key}\u0000${r.target_blueprint}\u0000${r.target_key}`))
    const add = [...wanted].filter((k) => !have.has(k))
    const drop = [...have].filter((k) => !wanted.has(k))
    if (add.length || drop.length) {
      const ends = (list: string[]) => list.map((k) => k.split('\u0000') as Link)
      await this.db.tx((client) => relink(client, this.queue, { blueprint: rule.blueprint, relation: rule.relation, layer: 'rule', source }, ends(drop), ends(add)))
      await this.queue.inline(endsOf([...ends(drop), ...ends(add)]))
      this.touch([rule.blueprint])
      this.forget()
      this.events.emit({ type: 'estate', blueprints: [rule.blueprint] })
    }
    const unmatched = sources.length - matched
    this.ledger.note('relink', relinkName(rule.blueprint, rule.relation, 'rule'), { calls: 1, ms: performance.now() - started, rows: sources.length + targets.length, extra: add.length + drop.length })
    this.log.info('rule evaluated', { rule: rule.id, sources: sources.length, matched, unmatched, ambiguous: ambiguous.length, added: add.length, dropped: drop.length })
    return { matched, unmatched, changed: add.length + drop.length > 0 }
  }
}

/** One relation as `[blueprint, key, target blueprint, target key]`. */
type Link = [string, string, string, string]

/** Both ends of each link, each once. */
function endsOf(links: Link[]): EntityRef[] {
  const out = new Map<string, EntityRef>()
  for (const l of links) {
    out.set(`${l[0]}:${l[1]}`, { blueprint: l[0], key: l[1] })
    out.set(`${l[2]}:${l[3]}`, { blueprint: l[2], key: l[3] })
  }
  return [...out.values()]
}

/**
 * Removes and adds one rule's or one inherited relation's links, each list in
 * one statement. What is removed was read with this source, and a link's
 * key names one row, so the source is not asked again here.
 */
async function relink(client: Queryable, queue: Queue, at: { blueprint: string; relation: string; layer: 'rule' | 'inherited'; source: string }, drop: Link[], add: Link[]): Promise<void> {
  const col = (list: Link[], i: number) => list.map((l) => l[i])
  // Both ends of every link that moved: the owner's relation and the target's incoming side.
  await queue.enqueue(client, [...drop, ...add].flatMap((l) => [{ blueprint: l[0], key: l[1] }, { blueprint: l[2], key: l[3] }]))
  if (drop.length) {
    await client.query(
      `DELETE FROM relations r USING unnest($1::text[], $2::text[], $3::text[], $4::text[]) AS v(blueprint, key, target_blueprint, target_key)
       WHERE r.blueprint = v.blueprint AND r.key = v.key AND r.relation = $5 AND r.layer = $6 AND r.target_blueprint = v.target_blueprint AND r.target_key = v.target_key`,
      [col(drop, 0), col(drop, 1), col(drop, 2), col(drop, 3), at.relation, at.layer],
    )
  }
  if (add.length) {
    await client.query(
      `INSERT INTO relations (blueprint, key, relation, layer, source, target_blueprint, target_key)
       SELECT v.blueprint, v.key, $5, $6, $7, v.target_blueprint, v.target_key FROM unnest($1::text[], $2::text[], $3::text[], $4::text[]) AS v(blueprint, key, target_blueprint, target_key)
       ON CONFLICT DO NOTHING`,
      [col(add, 0), col(add, 1), col(add, 2), col(add, 3), at.relation, at.layer, at.source],
    )
  }
}
