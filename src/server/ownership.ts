// What each person owns, walked once and then moved in place. Every path of
// the person setting's `owns` is kept step by step: which entities each step
// reaches, which link from the step before reaches each, and by how many
// routes. The database writes every link that moves, and every entity that
// comes, goes, or is deleted or brought back, to `link_journal`; a read first
// takes what came since the last one and works out again only the entities it
// names, against the database as it stands. Working one out again twice is
// the same as once, so a move is never feared read twice, and a transaction
// that may still have been open at the last read is read again.

import { entityId, type EntityRef, type OwnsPath } from '../shared/model.ts'
import { parsePath, type Hop } from '../shared/filter.ts'
import type { Blueprints } from './blueprints.ts'
import type { Db } from './db.ts'
import { JOURNAL_MS, STALE_MS, journalHorizon, journalSince } from './journal.ts'
import type { Logger } from './log.ts'
import { stepsAlong } from './links.ts'
import { timed } from './metrics.ts'

/** Who links to whom along one hop: [the entity that holds the link, the entity it points at]. */
type Link = readonly [string, string]

/** One path walked from one person. */
interface Walk {
  path: OwnsPath
  hops: Hop[]
  /** By step, each entity reached and by how many routes. Step 0 is the person. */
  steps: Map<string, number>[]
  /** By step from 1, each entity reached and the entities of the step before it is reached from. */
  from: Map<string, Set<string>>[]
  /** By step from 1, each entity of the step before and the entities it reaches. */
  to: Map<string, Set<string>>[]
}

interface Fact {
  person: EntityRef
  walks: Walk[]
  /** Every entity a path ends at, with the roles of every path that does: replaced, never changed, when it moves. */
  ids: Map<string, string[]>
}

export class Ownership {
  private readonly db: Db
  private readonly blueprints: Blueprints
  private readonly log: Logger
  private paths: OwnsPath[] = []
  private readonly facts = new Map<string, Fact>()
  /** The oldest transaction that may have been open at the last look: every row from it on is read again. */
  private horizon: string | null = null
  private lookedAt = 0
  /** One look or build at a time, in order: a fact built after a look is never passed over by it. */
  private lane: Promise<unknown> = Promise.resolve()
  /** A look asked for and not yet started, which later askers share. */
  private next: Promise<void> | null = null
  /** Whether the hub heard that links or entities moved since the last look: only then is there anything to read. */
  private dirty = true

  constructor(db: Db, blueprints: Blueprints, log: Logger) {
    this.db = db
    this.blueprints = blueprints
    this.log = log
  }

  /** The paths every person owns by. A change of them forgets everything walked. */
  setPaths(paths: OwnsPath[]): void {
    const same = paths.length === this.paths.length && paths.every((p, i) => p.path === this.paths[i]!.path && p.as === this.paths[i]!.as)
    this.paths = paths
    if (!same) this.forget()
  }

  /**
   * Told when a write that may move a link or an entity's state committed:
   * the next read looks at the journal first. Every writer says so as it
   * commits, and another hub's writes are heard through the bridge.
   */
  moved(): void {
    this.dirty = true
  }

  /** Forgets everything walked: the next read walks afresh. For a change to the model, which every path reads. */
  forget(): void {
    if (this.facts.size) this.log.info('what people own is walked afresh', { people: this.facts.size })
    this.facts.clear()
  }

  /** What each person owns, by the person's id: every entity a path ends at, with the roles of the paths that do. */
  async of(people: EntityRef[]): Promise<Map<string, Map<string, string[]>>> {
    await this.fresh()
    const missing = people.filter((p) => !this.facts.has(entityId(p)))
    if (missing.length) await this.inLane(() => timed('ownership.walk', () => this.build([...new Map(missing.map((p) => [entityId(p), p])).values()].filter((p) => !this.facts.has(entityId(p))))))
    return new Map(people.map((p) => [entityId(p), this.facts.get(entityId(p))?.ids ?? new Map()]))
  }

  /** Runs one look or build after every one before it. */
  private inLane<T>(work: () => Promise<T>): Promise<T> {
    const run = this.lane.then(work, work)
    this.lane = run.catch(() => {})
    return run
  }

  /** A look at the journal that starts after this call: one already under way may have read before what the caller saw. */
  private fresh(): Promise<void> {
    if (!this.dirty && Date.now() - this.lookedAt <= STALE_MS) return this.next ?? Promise.resolve()
    if (!this.next) {
      const next = this.inLane(async () => {
        if (this.next === next) this.next = null
        await timed('ownership.look', () => this.look())
      })
      this.next = next
    }
    return this.next
  }

  /** Reads what moved since the last look and moves what is kept to match. */
  private async look(): Promise<void> {
    // Cleared before the read: what is heard while it reads is read at the next look.
    this.dirty = false
    if (!this.facts.size) {
      this.horizon = null
      return
    }
    if (Date.now() - this.lookedAt > STALE_MS) {
      this.log.info('what people own is walked afresh: the last look at what moved is older than the journal keeps', { people: this.facts.size })
      this.facts.clear()
      this.horizon = null
      return
    }
    const { horizon, moved } = await journalSince(this.db, this.horizon)
    const touched = new Set<string>()
    for (const m of moved) {
      touched.add(`${m.blueprint}:${m.key}`)
      if (m.targetBlueprint !== null && m.targetKey !== null) touched.add(`${m.targetBlueprint}:${m.targetKey}`)
    }
    if (touched.size) await this.move([...touched])
    this.horizon = horizon
    this.lookedAt = Date.now()
  }

  /** Walks every path from each of these people, a step at a time for all of them at once. */
  private async build(people: EntityRef[]): Promise<void> {
    if (!people.length) return
    // Taken before the walk: what moves after it is read at the next look, and what the walk already saw is read again harmlessly.
    if (this.horizon === null) {
      this.horizon = await journalHorizon(this.db)
      this.lookedAt = Date.now()
    }
    const facts = people.map((person): Fact => ({ person, walks: this.paths.map((path) => this.walk(path, person)), ids: new Map() }))
    // Paths that start alike reach the same entities along what they share, so each shared hop is read once.
    const shared = new Map<string, readonly Link[]>()
    for (const [p, path] of this.paths.entries()) {
      const walks = facts.map((f) => f.walks[p]!)
      for (const [i, hop] of walks[0]!.hops.entries()) {
        const prefix = JSON.stringify(walks[0]!.hops.slice(0, i + 1))
        let links = shared.get(prefix)
        if (!links) {
          const before = new Set(walks.flatMap((w) => [...w.steps[i]!.keys()]))
          links = await this.links(hop, 'forward', [...before])
          shared.set(prefix, links)
        }
        for (const w of walks) {
          for (const [prev, nextId] of links) if (w.steps[i]!.has(prev)) this.link(w, i + 1, prev, nextId)
          for (const nextId of w.from[i + 1]!.keys()) w.steps[i + 1]!.set(nextId, this.routes(w, i + 1, nextId))
        }
      }
    }
    for (const f of facts) {
      f.ids = idsOf(f.walks)
      this.facts.set(entityId(f.person), f)
    }
    this.log.debug('what people own walked', { people: facts.length, paths: this.paths.length, owned: facts.map((f) => f.ids.size) })
  }

  private walk(path: OwnsPath, person: EntityRef): Walk {
    const hops = parsePath(path.path)
    return {
      path,
      hops,
      steps: [new Map([[entityId(person), 1]]), ...hops.map(() => new Map<string, number>())],
      from: [new Map(), ...hops.map(() => new Map<string, Set<string>>())],
      to: [new Map(), ...hops.map(() => new Map<string, Set<string>>())],
    }
  }

  /**
   * Works out again, in every kept walk, each of these entities where it can
   * stand in one: what reaches it at each step, and what it reaches at the
   * next. The steps go in order, so what a step reached is settled before the
   * step after it is read.
   */
  private async move(touched: string[]): Promise<void> {
    const facts = [...this.facts.values()]
    let changed = 0
    for (const [p, path] of this.paths.entries()) {
      const walks = facts.map((f) => f.walks[p]!)
      const hops = parsePath(path.path)
      for (const [i, hop] of hops.entries()) {
        const step = i + 1
        // What reaches each touched entity this hop can reach. Going out, also what each touched entity of the step
        // before reaches: a link it now holds may win over the one that reached something else. Going in, a link that
        // moves names the entity that holds it, which this hop reaches, so the entity it points at needs no reading:
        // a busy one is pointed at by thousands.
        const kinds = this.reaches(hop)
        const ends = touched.filter((id) => kinds.has(id.slice(0, id.indexOf(':'))))
        const starts = hop.incoming ? [] : touched.filter((id) => walks.some((w) => w.steps[step - 1]!.has(id)))
        if (!ends.length && !starts.length) continue
        const [back, forward] = await Promise.all([this.links(hop, 'back', ends), this.links(hop, 'forward', starts)])
        const reachedFrom = groupBy(back, (l) => l[1], (l) => l[0])
        const reaching = groupBy(forward, (l) => l[0], (l) => l[1])
        for (const w of walks) {
          for (const id of ends) {
            const prevs = new Set([...(reachedFrom.get(id) ?? [])].filter((prev) => w.steps[step - 1]!.has(prev)))
            if (prevs.size || w.from[step]!.has(id)) changed += await this.setFrom(w, step, id, prevs)
          }
          for (const id of starts) if (w.steps[step - 1]!.has(id)) changed += await this.setTo(w, step, id, reaching.get(id) ?? new Set())
        }
      }
    }
    for (const f of facts) {
      const ids = idsOf(f.walks)
      if (!sameIds(f.ids, ids)) f.ids = ids
    }
    this.log.debug('what people own moved in place', { touched: touched.length, people: facts.length, links: changed })
  }

  /** Sets what reaches an entity at a step, and carries any change in its routes on. The links that changed. */
  private async setFrom(w: Walk, step: number, id: string, prevs: Set<string>): Promise<number> {
    const was = new Set(w.from[step]!.get(id) ?? [])
    let changed = 0
    for (const prev of was) if (!prevs.has(prev)) changed += this.unlink(w, step, prev, id)
    for (const prev of prevs) if (!was.has(prev)) changed += this.link(w, step, prev, id)
    if (changed) await this.recount(w, step, id)
    return changed
  }

  /** Sets what an entity of the step before reaches at a step, and carries each change on. The links that changed. */
  private async setTo(w: Walk, step: number, prev: string, nexts: Set<string>): Promise<number> {
    const was = new Set(w.to[step]!.get(prev) ?? [])
    let changed = 0
    const moved: string[] = []
    for (const id of [...was]) {
      if (nexts.has(id)) continue
      changed += this.unlink(w, step, prev, id)
      moved.push(id)
    }
    for (const id of nexts) {
      if (was.has(id)) continue
      changed += this.link(w, step, prev, id)
      moved.push(id)
    }
    for (const id of moved) await this.recount(w, step, id)
    return changed
  }

  private link(w: Walk, step: number, prev: string, id: string): number {
    let from = w.from[step]!.get(id)
    if (!from) w.from[step]!.set(id, (from = new Set()))
    if (from.has(prev)) return 0
    from.add(prev)
    let to = w.to[step]!.get(prev)
    if (!to) w.to[step]!.set(prev, (to = new Set()))
    to.add(id)
    return 1
  }

  private unlink(w: Walk, step: number, prev: string, id: string): number {
    const from = w.from[step]!.get(id)
    if (!from?.delete(prev)) return 0
    if (!from.size) w.from[step]!.delete(id)
    const to = w.to[step]!.get(prev)
    to?.delete(id)
    if (to && !to.size) w.to[step]!.delete(prev)
    return 1
  }

  /** How many routes reach an entity at a step: the sum of those that reach each entity it is reached from. */
  private routes(w: Walk, step: number, id: string): number {
    let n = 0
    for (const prev of w.from[step]!.get(id) ?? []) n += w.steps[step - 1]!.get(prev) ?? 0
    return n
  }

  /**
   * Counts an entity's routes at a step again, and carries a change on: one
   * that arrives reaches what the next step reads from it, one that leaves
   * reaches nothing more, and either way what it leads to counts its routes
   * again.
   */
  private async recount(w: Walk, step: number, id: string): Promise<void> {
    const was = w.steps[step]!.get(id) ?? 0
    const now = this.routes(w, step, id)
    if (now === was) return
    if (now) w.steps[step]!.set(id, now)
    else w.steps[step]!.delete(id)
    if (step === w.hops.length) return
    const next = step + 1
    if (!was) for (const [, reached] of await this.links(w.hops[step]!, 'forward', [id])) this.link(w, next, id, reached)
    const led = [...(w.to[next]!.get(id) ?? [])]
    if (!now) for (const reached of led) this.unlink(w, next, id, reached)
    for (const reached of led) await this.recount(w, next, reached)
  }

  /** The blueprints an entity this hop reaches may be of: what holds the relation going in, what it points at going out. */
  private reaches(hop: Hop): Set<string> {
    const out = new Set<string>()
    for (const bp of this.blueprints.list()) {
      const def = bp.relations[hop.relation]
      if (!def) continue
      if (!hop.incoming) out.add(def.target)
      else if (!hop.from || bp.id === hop.from) out.add(bp.id)
    }
    return out
  }

  private links(hop: Hop, way: 'forward' | 'back', ids: string[]): Promise<readonly Link[]> {
    return stepsAlong(this.db, this.blueprints, hop, way, ids)
  }
}

/** Every entity a walk ends at, with the role of each path that does. */
function idsOf(walks: Walk[]): Map<string, string[]> {
  const ids = new Map<string, string[]>()
  for (const w of walks) {
    for (const id of w.steps[w.hops.length]!.keys()) {
      const roles = ids.get(id) ?? []
      if (w.path.as && !roles.includes(w.path.as)) roles.push(w.path.as)
      ids.set(id, roles)
    }
  }
  return ids
}

function sameIds(a: Map<string, string[]>, b: Map<string, string[]>): boolean {
  if (a.size !== b.size) return false
  for (const [id, roles] of a) {
    const other = b.get(id)
    if (!other || other.length !== roles.length || roles.some((r) => !other.includes(r))) return false
  }
  return true
}

function groupBy<T>(list: readonly T[], key: (t: T) => string, value: (t: T) => string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  for (const t of list) {
    let set = out.get(key(t))
    if (!set) out.set(key(t), (set = new Set()))
    set.add(value(t))
  }
  return out
}

/**
 * Lets go of what the journal no longer owes anyone: the rows of every
 * transaction older than the oldest one that could still have been open an
 * hour ago. A hub that looked within half an hour reads only from a later
 * one, and a hub that has not looked for longer walks afresh, so nothing a
 * hub still reads is let go. Run by the leader; one that just took the lead
 * remembers nothing yet and lets go of nothing for an hour.
 */
export class JournalPruner {
  private readonly db: Db
  private readonly log: Logger
  private readonly seen: { at: number; xmin: string }[] = []

  constructor(db: Db, log: Logger) {
    this.db = db
    this.log = log
  }

  async pass(): Promise<void> {
    const now = Date.now()
    this.seen.push({ at: now, xmin: await journalHorizon(this.db) })
    let bound: string | null = null
    while (this.seen.length > 1 && this.seen[1]!.at <= now - JOURNAL_MS) this.seen.shift()
    if (this.seen[0]!.at <= now - JOURNAL_MS) bound = this.seen[0]!.xmin
    if (!bound) return
    const gone = await this.db.query('DELETE FROM link_journal WHERE xid < $1::xid8', [bound])
    if (gone.rowCount) this.log.info('link journal let go of what no hub still reads', { rows: gone.rowCount })
  }
}
