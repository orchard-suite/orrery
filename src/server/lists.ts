import { createHash, randomBytes } from 'node:crypto'
import type { ColumnDistribution, GridGroup, ServerEvent } from '../shared/api.ts'
import { fieldOf, usesIncoming } from '../shared/filter.ts'
import { SOURCE_STANDING, type Entity, type EntityState, type Filter } from '../shared/model.ts'
import type { Db } from './db.ts'
import type { Events } from './events.ts'
import type { Load } from './load.ts'
import type { Logger } from './log.ts'
import { CLOCK_MS, readsNow, type Reader } from './read.ts'
import { ALL, OBJECT_LABEL, type ListParams, type OrderValues } from './query.ts'
import type { View } from './visibility.ts'
import { recordKept, timed } from './metrics.ts'

/** One grid's question: which rows, in which order, grouped how. */
export interface ListQuery {
  blueprint: string
  states?: EntityState[]
  includeHidden?: boolean
  filter?: Filter
  /** `field` or `-field`. */
  sort?: string
  /** A grid column id (`$owner`, a field, `r:relation`) the rows are grouped by. */
  group?: string
  /** The reader whose stars lead the order. Like the sort, no part of the listing's shape. */
  starredBy?: string
}

/**
 * The shape of one grid's answer, kept in the hub: how many rows match, how
 * they group, how they share out each column. The rows themselves are read
 * by block from the stored derived rows. The count and the groups are here
 * as soon as the listing is; how the columns share out takes the longest and
 * comes when it is counted, so a grid shows its rows without waiting for it.
 */
export interface Listing {
  /** Bumps whenever anything the hub holds changes. A browser holding an older one asks again. */
  version: number
  /** The blueprints whose change drops this listing; null when any change does. */
  reads: string[] | null
  total: number
  distribution: Promise<Record<string, ColumnDistribution>>
  groups: GridGroup[] | null
}

/** How long a listing nobody asked for again is kept. */
const IDLE_MS = 2 * 60_000
/** How long a page a person glances at is kept unasked: they come back to it. */
const RECENT_IDLE_MS = 15 * 60_000
/** How long a glanced page is taken as current with nothing moving: what it says of a source's health turns with the clock. */
const FRESH_MS = 60_000
/** How many listings are kept at once, the least recently asked dropped first. */
const MAX_LISTINGS = 64
/** How long a question waits for its next answer before the last one is given instead. */
const PATIENCE_MS = 300

/** A grid's answer kept for one question and person, with the next one while it builds. */
interface KeptListing {
  at: number
  built: number
  blueprint: string
  reads: ReadonlySet<string> | null
  basis: object
  listing: Promise<Listing>
  /** Something it reads moved since it was built: the next question builds it again. */
  stale: boolean
  /** How many times it was marked stale, so a next answer built across a move stays stale. */
  moves: number
  next: Promise<Listing> | null
}

/** A kept answer built from the whole estate for one reader. */
interface Memo {
  at: number
  /** When the answer it gives was built. */
  built: number
  value: Promise<unknown>
  /** What the reader's view was decided from when it was built. */
  basis: object
  /** Something it read has moved since it was built. */
  stale: boolean
  /** The answer being built to replace it. */
  next: Promise<unknown> | null
  /** The blueprints whose move makes it stale, once it is built; null while building, or when any move does. */
  reads: ReadonlySet<string> | null
  /** How often something it read moved: an answer built across a move is stale as soon as it lands. */
  moves: number
  /** Whether it is also stale a minute after it was built, for what turns with the clock, such as a source's health. */
  ages: boolean
}


/** How a kept page is told stale: what it reads, worked out from the answer, and whether it ages with the clock. */
export interface Keeping<T> {
  reads?: (answer: T) => Iterable<string> | null
  ages?: boolean
}

/** The blueprints an answer reads, as a set; null when it may read any. */
function readsOf<T>(reads: Keeping<T>['reads'], answer: T): ReadonlySet<string> | null {
  const found = reads?.(answer)
  return found ? new Set(found) : null
}

/** True when a filter reads past the entity's own values: who it is related to, who points at it, or the values of what a relation reaches. */
export function reachesOut(f: Filter): boolean {
  if ('and' in f) return f.and.some(reachesOut)
  if ('or' in f) return f.or.some(reachesOut)
  if ('not' in f) return reachesOut(f.not)
  return 'relatedTo' in f || usesIncoming(f) || ('relation' in f && !!f.where)
}

/** The value a row is grouped under: a relation's targets, or a field shown short. What `query.ts` groups by in SQL; the two are held equal in `query.test.ts`. */
export function groupKey(e: Entity, group: string): string {
  if (group.startsWith('r:')) return (e.relations[group.slice(2)] ?? []).map((t) => t.title ?? t.key).join(', ') || '—'
  const v = fieldOf(e, group)
  if (v === null || v === undefined || v === '') return '—'
  if (Array.isArray(v)) return v.map(String).join(', ')
  // An object is one group, however it is written: its JSON prints differently here and in Postgres.
  return typeof v === 'object' ? OBJECT_LABEL : String(v)
}

/**
 * The rows a grid scrolls through. Reading a blueprint's rows, filtering,
 * sorting, and counting them is done once per question and person, then kept
 * until anything in the hub changes; every block a grid scrolls to is a slice
 * of it. A person's own access shapes what is kept, so a listing is never
 * shared between two people.
 */
/** The stamp a move of everything is kept under: no blueprint id holds a space. */
const EVERYTHING = '* everything'

/** How long the stamps that moved wait to be stored together. */
const STORE_STAMPS_MS = 1000

export class Lists {
  private readonly reader: Reader
  private readonly load: Pick<Load, 'note'>
  private readonly log: Logger
  /** Each listing with the blueprints whose change moves it; null reads everything. */
  /** The listings given while a newer one built. */
  private readonly behindOf = new WeakSet<Listing>()
  /** The pass deriving what is stale of each blueprint a listing is being built for, while it runs. */
  private readonly ensuring = new Map<string, Promise<void>>()
  private readonly kept = new Map<string, KeptListing>()
  private readonly memos = new Map<string, Memo>()
  /** Counts every change, so a listing built later always carries a higher version than one dropped before it. */
  private current = 1
  /**
   * When each blueprint last moved, and under `EVERYTHING` when everything did, by the time of the event that said so:
   * what a tag names a list's state by. Every hub hears the same events with the same times, and keeps them in
   * `list_stamps` as well, so every hub names the same state the same way, before a restart and after it.
   */
  private readonly stamps = new Map<string, number>()
  /** The stamps moved since they were last stored. */
  private readonly unstored = new Map<string, number>()
  private storing: NodeJS.Timeout | null = null
  /** Whether the stamps were read and this hub said it started: until then its tags are its own (`boot`). */
  private shared = false
  /** Tells this hub's own tags from another's: an answer numbered by `numberOf` is only this process's. */
  private readonly boot = randomBytes(6).toString('base64url')
  private readonly db: Db
  private readonly release: string
  /** The time of the event being heard, what it moves is stamped with: 0 outside one, when now is. */
  private at = 0
  /** A number for each answer and each reader's view a tag has named, for as long as it is kept. */
  private readonly named = new WeakMap<object, number>()
  private namedCount = 0

  constructor(reader: Reader, events: Events, load: Pick<Load, 'note'>, log: Logger, db: Db, release: string) {
    this.reader = reader
    this.load = load
    this.log = log
    this.db = db
    this.release = release
    events.subscribe((event) => {
      this.at = event.at ?? Date.now()
      try {
        this.hear(event)
      } finally {
        this.at = 0
      }
    })
  }

  /** What an event moves of the kept listings and pages, and of the stamps. */
  private hear(event: ServerEvent): void {
    // A write moves the listings that read its blueprint, read again from rows derived on the way where none is stored
    // yet; the derived rows landing moves them once more, to what is stored.
    if (event.type === 'entity') this.moved([event.blueprint], event.titled)
    else if (event.type === 'derived') this.moved(event.blueprints, event.titled)
    else if (event.type === 'estate') this.moved(event.blueprints ?? null)
    // A source changes what is said of it, laid over the hub's own source and runner entities as they are read: the
    // pages that read those, or that may read anything, never a grid's rows.
    else if (event.type === 'sources') this.dropMemos(SOURCE_STANDING)
    // The model, who may see what, and which custom icons exist change everything: an entity naming an icon that comes or goes shows another.
    // An offer only adds: what read the blueprints it touched is built again, and given meanwhile as it stood.
    else if (event.type === 'blueprints' && event.offered) this.moved(event.offered)
    else if (event.type === 'blueprints' || event.type === 'access' || event.type === 'icons') this.changed()
    // The actions offered on a list's rows are named on them: no list is built again, but none is the same answer.
    // A hub that started may have missed what moved before it listened: no tag named before then holds.
    else if (event.type === 'actions' || event.type === 'started') this.stamp(EVERYTHING)
  }

  /**
   * Reads the stamps every hub stored, then says this hub started, so no tag named before it can be answered as
   * unchanged here or anywhere: what it missed while it was not listening is older than that. From then on its tags
   * are the same as every other hub's. Called once the hub hears the others.
   */
  async start(events: Events): Promise<void> {
    const read = await this.readStamps()
    events.emit({ type: 'started' })
    this.shared = true
    this.log.info('list tags shared with every hub', { stamps: read })
    // What the others heard just before this hub listened is stored a moment after: read again once it is.
    const again = setTimeout(() => void this.readStamps().catch((error: unknown) => this.log.warn('list stamps not read again', { error })), 2 * STORE_STAMPS_MS + 500)
    again.unref()
  }

  /** Takes every stamp stored that is later than this hub's own. */
  private async readStamps(): Promise<number> {
    const kept = await this.db.query<{ name: string; at: string }>('SELECT name, at::text FROM list_stamps')
    for (const r of kept.rows) if (Number(r.at) > (this.stamps.get(r.name) ?? 0)) this.stamps.set(r.name, Number(r.at))
    return kept.rowCount ?? 0
  }

  /** Marks a stamp moved to the time of the event being heard, and stores it a moment later with the rest. */
  private stamp(name: string): void {
    const at = this.at || Date.now()
    if (at <= (this.stamps.get(name) ?? 0)) return
    this.stamps.set(name, at)
    this.unstored.set(name, at)
    if (this.storing) return
    this.storing = setTimeout(() => void this.store(), STORE_STAMPS_MS)
    this.storing.unref()
  }

  /** Stores the stamps that moved, never moving one back: every hub stores what it heard, and the latest wins. */
  async store(): Promise<void> {
    if (this.storing) clearTimeout(this.storing)
    this.storing = null
    if (!this.unstored.size) return
    const taken = [...this.unstored]
    this.unstored.clear()
    try {
      await this.db.query(`INSERT INTO list_stamps (name, at) SELECT * FROM unnest($1::text[], $2::bigint[]) ON CONFLICT (name) DO UPDATE SET at = GREATEST(list_stamps.at, EXCLUDED.at)`, [taken.map(([n]) => n), taken.map(([, at]) => at)])
    } catch (error) {
      for (const [name, at] of taken) if (at > (this.unstored.get(name) ?? 0)) this.unstored.set(name, at)
      this.log.warn('list stamps not stored; kept for the next try', { stamps: taken.length, error })
    }
  }

  get version(): number {
    return this.current
  }

  /** Forgets every listing and every page, the last answers kept to give while the next builds too: the next question is answered from the database. */
  changed(): void {
    this.moved(null)
    this.kept.clear()
    this.memos.clear()
  }

  /**
   * Marks stale the listings that read any of these blueprints, every one
   * when null, and forgets every page built from the whole estate. A title
   * that moved also marks the listings whose rows show it beside them: what
   * points at its blueprint, and what it points at. A stale listing is built
   * again on the next question, and given meanwhile when that is slow.
   */
  moved(blueprints: readonly string[] | null, titled: boolean | readonly string[] = false): void {
    this.current++
    const shown = titled === true ? blueprints : titled || []
    const near = shown?.length ? new Set(shown.flatMap((b) => this.reader.beside(b))) : null
    const touched = blueprints && [...blueprints, ...(near ?? [])]
    if (!touched) this.stamp(EVERYTHING)
    else for (const b of touched) this.stamp(b)
    let dropped = 0
    for (const hit of this.kept.values()) {
      const reads = hit.reads
      if (blueprints && reads && !blueprints.some((b) => reads.has(b)) && !near?.has(hit.blueprint)) continue
      hit.stale = true
      hit.moves++
      dropped++
    }
    this.dropMemos(touched)
    if (dropped) this.log.debug('listings marked stale: what they read changed', { dropped, kept: this.kept.size, blueprints: blueprints ?? 'everything', titled, version: this.current })
  }

  /**
   * The pages that read any of these blueprints, every one when null: a page
   * is kept, marked stale, to be given while its next one builds. One that
   * reads none of them stands.
   */
  private dropMemos(blueprints: readonly string[] | null): void {
    const reading = (reads: ReadonlySet<string> | null) => !blueprints || !reads || blueprints.some((b) => reads.has(b))
    for (const hit of this.memos.values()) {
      if (!reading(hit.reads)) continue
      hit.moves++
      hit.stale = true
    }
  }

  /**
   * A tag for an answer read from these blueprints, null for one any change
   * moves: it is the same while none of them moves, and names `asked`, the
   * question and who asked it. Taken before the answer is read, so an
   * answer is never named for a state older than the one it shows.
   */
  tag(asked: string, reads: Iterable<string> | null): string {
    const stamp = (name: string) => this.stamps.get(name) ?? 0
    const state = reads === null ? `*${Math.max(0, ...this.stamps.values())}` : `${stamp(EVERYTHING)}:${[...new Set(reads)].sort().map((b) => `${b}=${stamp(b)}`).join(',')}`
    // The release names it too: another release may answer the same question in another shape.
    return `${this.shared ? this.release : this.boot}.${createHash('sha256').update(asked).update('\0').update(state).digest('base64url').slice(0, 22)}`
  }

  /** A tag for one kept answer, such as a page built from the whole estate: the same for as long as that very answer is given, and only on this hub. */
  tagOf(asked: string, answer: object): string {
    return this.tag(`${this.boot}\0${asked}\0${this.numberOf(answer)}`, [])
  }

  /** What a reader's view is named by in a tag: the same on every hub for a reader who sees everything, else this hub's own number for it. */
  basisOf(view: View): string {
    return view.all ? '*' : `${this.boot}.${this.numberOf(view.basis)}`
  }

  /** A number for an object a tag names, such as a reader's view: the same object, the same number. */
  numberOf(o: object): number {
    let n = this.named.get(o)
    if (n === undefined) this.named.set(o, (n = ++this.namedCount))
    return n
  }

  /**
   * The blueprints whose move may change a list of this blueprint: what its rows read, and with `incoming`, what points
   * at them too. Null when that cannot be told. A title, a state, a status, or an icon shown beside a row moves the
   * blueprints beside it when it moves (`moved`), so what only shows a neighbour reads nothing more here.
   */
  listReads(blueprint: string, incoming = false): string[] | null {
    const reads = this.reader.readsFor(blueprint)
    return reads ? [blueprint, ...reads, ...(incoming ? this.reader.beside(blueprint) : [])] : null
  }

  async get(q: ListQuery, view: View, who: string): Promise<Listing> {
    this.sweep()
    // The order of the rows is no part of the shape: a grid sorted another way, or with other stars first, has the same count, groups, and distribution.
    const id = JSON.stringify([who, q.blueprint, q.states ?? null, !!q.includeHidden, q.filter ?? null, q.group ?? null])
    let hit = this.kept.get(id)
    // What the reader may see moved since it was built, such as what they own: build it again.
    if (hit && hit.basis !== view.basis) {
      this.kept.delete(id)
      hit = undefined
    }
    // A filter that compares with the time now turns on its own: built again once it is a minute old. The rows' own
    // values that read the time are the deriver's: a row derived again lands as a `derived` event and drops the listing.
    if (hit && hit.built < Date.now() - CLOCK_MS && q.filter && readsNow(q.filter)) {
      this.kept.delete(id)
      hit = undefined
    }
    if (hit) {
      hit.at = Date.now()
      this.kept.delete(id)
      this.kept.set(id, hit)
      if (!hit.stale) {
        recordKept('listing', 'hit')
        return hit.listing
      }
      return this.renewed(id, hit, q, view)
    }
    recordKept('listing', 'miss')
    const listing = this.started(q, view)
    const kept: KeptListing = { at: Date.now(), built: Date.now(), blueprint: q.blueprint, reads: this.readsOf(q), basis: view.basis, listing, stale: false, moves: 0, next: null }
    listing.catch(() => this.kept.get(id) === kept && this.kept.delete(id))
    this.kept.set(id, kept)
    // A listing whose columns could not be counted is not kept: the next question counts again.
    listing.then((built) => built.distribution).catch(() => this.kept.get(id) === kept && kept.listing === listing && this.kept.delete(id))
    while (this.kept.size > MAX_LISTINGS) this.kept.delete(this.kept.keys().next().value!)
    return listing
  }

  /** A filter that names another entity or relation reads more than the blueprint itself, so it is read again on any change. */
  private readsOf(q: ListQuery): ReadonlySet<string> | null {
    return q.filter && reachesOut(q.filter) ? null : this.reader.readsFor(q.blueprint)
  }

  private started(q: ListQuery, view: View): Promise<Listing> {
    const version = this.current
    const reads = this.readsOf(q)
    return timed('listing.build', () => this.build(q, view, version, reads))
  }

  /**
   * A stale listing's next answer, waited for a moment; when it takes
   * longer, the last listing is given meanwhile. Its rows are read fresh by
   * block either way: only the count and the shares may be one build behind.
   * The next answer takes the last one's place: stale still when something
   * moved while it built.
   */
  private renewed(id: string, hit: KeptListing, q: ListQuery, view: View): Promise<Listing> {
    if (!hit.next) {
      const began = hit.moves
      const reads = this.readsOf(q)
      const next = this.started(q, view)
      hit.next = next
      next.then(
        (built) => {
          if (this.kept.get(id) !== hit || hit.next !== next) return
          // Kept only once its columns are counted, so a listing that cannot count them never stands in for one that did.
          built.distribution.then(
            () => {
              if (this.kept.get(id) !== hit || hit.next !== next) return
              hit.listing = next
              hit.built = Date.now()
              hit.reads = reads
              hit.stale = hit.moves !== began
              hit.next = null
            },
            () => hit.next === next && (hit.next = null),
          )
        },
        (error: unknown) => {
          if (hit.next === next) hit.next = null
          this.log.warn('the next listing failed; the last one stays', { blueprint: q.blueprint, error })
        },
      )
    }
    const next = hit.next
    const last = hit.listing
    let waited: ReturnType<typeof setTimeout> | undefined
    const patience = new Promise<'late'>((done) => (waited = setTimeout(() => done('late'), PATIENCE_MS)))
    return Promise.race([next.then((listing) => ({ ok: true as const, listing }), () => ({ ok: false as const })), patience]).then((won) => {
      clearTimeout(waited)
      if (won !== 'late' && won.ok) {
        recordKept('listing', 'miss')
        return won.listing
      }
      recordKept('listing', 'stale')
      this.log.debug('gave the last listing while the next builds', { blueprint: q.blueprint })
      return last.then((listing) => (this.behindOf.add(listing), listing))
    })
  }

  /** Whether a listing was given while a newer one built: an answer from it is not the state its tag names, so it carries none. */
  behind(listing: Listing): boolean {
    return this.behindOf.has(listing)
  }

  private async build(q: ListQuery, view: View, version: number, reads: ReadonlySet<string> | null): Promise<Listing> {
    const started = Date.now()
    const began = performance.now()
    const params = this.params(q)
    await this.ensure(q.blueprint)
    const sight = view.all ? ALL : view
    // Counted beside the rest and not waited for: whoever asks for it waits, and a grid's rows do not.
    // Its own time is noted beside the build's, so the Load page says what the spread of values costs.
    const counting = performance.now()
    let spread = { ms: 0, columns: 0 }
    const distribution = this.reader.sql.distribution(params, sight).then((counted) => {
      spread = { ms: performance.now() - counting, columns: Object.keys(counted).length }
      return view.all ? counted : view.distribution(q.blueprint, counted)
    })
    const [{ total }, groups] = await Promise.all([this.reader.sql.rows(params, sight, { limit: 0, offset: 0 }), q.group ? this.reader.sql.groups(params, sight) : Promise.resolve(null)]).catch((error: unknown) => {
      // The count failed: nobody will ask for the columns, so their failure is heard here.
      distribution.catch(() => undefined)
      throw error
    })
    distribution.then(
      () => {
        this.log.info('listing built', { blueprint: q.blueprint, rows: total, groups: groups?.length ?? 0, ms: Date.now() - started })
        // Only a blueprint the model holds is counted: a name a caller made up would be kept as one more row.
        const known = this.reader.known(q.blueprint)
        if (known) {
          this.load.note('shape', known, { calls: 1, ms: performance.now() - began, rows: total })
          this.load.note('spread', known, { calls: 1, ms: spread.ms, extra: spread.columns })
        }
      },
      (error: unknown) => this.log.warn('could not count how a listing shares out its columns', { blueprint: q.blueprint, error }),
    )
    return { version, reads: reads && [...reads], total, distribution, groups }
  }

  /** Derives what is stale of a blueprint before it is listed: once at a time, so a block read beside the listing waits for the same pass. */
  private ensure(blueprint: string): Promise<void> {
    let pass = this.ensuring.get(blueprint)
    if (!pass) {
      pass = this.reader.ensureDerived(blueprint, this.reader.staleBefore(blueprint)).finally(() => this.ensuring.delete(blueprint))
      this.ensuring.set(blueprint, pass)
    }
    return pass
  }

  /** A grid question as the SQL side takes it. */
  params(q: ListQuery): ListParams {
    return { blueprint: q.blueprint, states: q.states ?? ['active', 'missing'], includeHidden: !!q.includeHidden, filter: q.filter, sort: q.sort, group: q.group, ...(q.starredBy ? { starredBy: q.starredBy } : {}) }
  }

  /**
   * One block of a kept listing's rows, in its order: read from the stored
   * rows now, hydrated, and put through the reader's view. The listing
   * itself holds no rows.
   */
  async block(q: ListQuery, view: View, offset: number, limit: number, after: OrderValues | null = null): Promise<{ entities: Entity[]; next: OrderValues | null }> {
    // A listing being built derives what is stale first: a block read beside it waits for that, and for nothing else.
    await this.ensuring.get(q.blueprint)
    const { rows, next } = await this.reader.sql.page(this.params(q), view.all ? ALL : view, { limit, offset, after })
    const page = await this.reader.derive(rows)
    return { entities: view.all ? page : view.entities(page), next }
  }

  /**
   * `memo` for a page a person glances at, such as the front page. Once
   * something it read moves, the next question starts the next answer and
   * waits for it a moment; when it takes longer, the last answer is given
   * meanwhile. The last answer is given only for the view it was built for:
   * once what the reader may see moves, `basis` is another object, and the
   * question waits for its own answer.
   */
  recent<T>(what: string, who: string, basis: object, build: () => Promise<T>, keeping: Keeping<T> = {}): Promise<T> {
    this.sweep()
    const id = JSON.stringify([who, what])
    const hit = this.memos.get(id)
    if (!hit || hit.basis !== basis) {
      recordKept('memo', 'miss')
      if (hit) this.log.info('a kept page was built for what the reader saw before; building it again', { what })
      return this.keep(id, basis, build, keeping)
    }
    this.asked(id, hit)
    if (hit.ages && hit.at - hit.built > FRESH_MS) hit.stale = true
    if (!hit.stale) {
      recordKept('memo', 'hit')
      return hit.value as Promise<T>
    }
    hit.next ??= this.renew(id, hit, build, keeping.reads)
    const last = hit.value as Promise<T>
    const next = hit.next as Promise<T>
    let waited: ReturnType<typeof setTimeout> | undefined
    const patience = new Promise<'late'>((done) => (waited = setTimeout(() => done('late'), PATIENCE_MS)))
    return Promise.race([next.then((value) => ({ ok: true as const, value }), () => ({ ok: false as const })), patience]).then((won) => {
      clearTimeout(waited)
      if (won !== 'late' && won.ok) {
        recordKept('memo', 'miss')
        return won.value
      }
      recordKept('memo', 'stale')
      this.log.debug('gave the last answer while the next builds', { what })
      return last
    })
  }

  private keep<T>(id: string, basis: object, build: () => Promise<T>, keeping: Keeping<T>): Promise<T> {
    const memo: Memo = { at: Date.now(), built: Date.now(), value: Promise.resolve(), basis, stale: false, next: null, reads: null, moves: 0, ages: keeping.ages ?? true }
    const value = timed('memo.build', build).then(
      (answer) => {
        if (this.memos.get(id) === memo) memo.reads = readsOf(keeping.reads, answer)
        return answer
      },
      (error: unknown) => {
        if (this.memos.get(id) === memo) this.memos.delete(id)
        throw error
      },
    )
    memo.value = value
    this.memos.set(id, memo)
    while (this.memos.size > MAX_LISTINGS) {
      const oldest = this.memos.keys().next().value!
      this.memos.delete(oldest)
      this.log.info('a kept page was let go: more are kept than fit', { kept: this.memos.size, max: MAX_LISTINGS })
    }
    return value
  }

  /** Builds the next answer of a stale page, and keeps it in the last one's place: stale still when something moved while it built. */
  private renew<T>(id: string, hit: Memo, build: () => Promise<T>, reads: Keeping<T>['reads']): Promise<T> {
    const began = hit.moves
    // While it builds, any move may be one the next answer reads.
    hit.reads = null
    return timed('memo.build', build).then(
      (value) => {
        if (this.memos.get(id) === hit) {
          hit.value = Promise.resolve(value)
          hit.built = Date.now()
          hit.stale = hit.moves !== began
          hit.reads = readsOf(reads, value)
          hit.next = null
        }
        return value
      },
      (error: unknown) => {
        if (this.memos.get(id) === hit) hit.next = null
        this.log.warn('the next answer of a kept page failed; the last one stays', { error })
        throw error
      },
    )
  }

  /** A kept answer asked for again goes to the back of the line, so the one let go when too many are kept is the least recently asked. */
  private asked(id: string, hit: Memo): void {
    hit.at = Date.now()
    this.memos.delete(id)
    this.memos.set(id, hit)
  }

  private sweep(): void {
    const cutoff = Date.now() - IDLE_MS
    for (const [id, hit] of this.kept) if (hit.at < cutoff) this.kept.delete(id)
    const longer = Date.now() - RECENT_IDLE_MS
    for (const [id, hit] of this.memos) if (hit.at < longer) this.memos.delete(id)
  }
}
