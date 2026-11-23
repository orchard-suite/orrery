// Budgets: how much a source may change, a caller may ask, and a blueprint
// may hold before the hub says so, and before it refuses. The hub ships none:
// each estate sets its own numbers, on the Load page, from what that page
// shows. Past `warn` a budget raises a finding. Past `limit` the hub refuses
// what would add to it, with the reason: a source's writes and a caller's
// calls until the hour turns, a blueprint's new entities until it holds
// fewer. What is counted is the load ledger's own count, so a budget and the
// Load page always agree.

import { z } from 'zod'
import { BUDGET_KINDS, type Budget, type BudgetKind, type Budgets as BudgetSet, type BudgetUse } from '../shared/api.ts'
import { BUDGET_ADVICE, budgetFor } from '../shared/load-signals.ts'
import type { Finding } from '../shared/model.ts'
import type { Db } from './db.ts'
import type { Load, LoadKind } from './load.ts'
import type { Logger } from './log.ts'

const KEY = 'budgets'
/** How long what the database says of this hour, and of what each blueprint holds, is taken as current. */
const FRESH_MS = 30_000
const HOUR_MS = 3_600_000

const budgetSchema = z.object({ warn: z.number().int().positive().optional(), limit: z.number().int().positive().optional() }).strict().refine((b) => b.warn !== undefined || b.limit !== undefined, 'a budget needs a warn or a limit').refine((b) => b.warn === undefined || b.limit === undefined || b.warn <= b.limit, 'warn must not be above limit')
/** The budgets of one kind, by the name each is for. */
export const namedBudgets = z.record(z.string().min(1).max(200), budgetSchema)
export const budgetsSchema = z.object({ changes: namedBudgets.default({}), calls: namedBudgets.default({}), entities: namedBudgets.default({}), reads: namedBudgets.default({}) }).strict()

const NONE: BudgetSet = { changes: {}, calls: {}, entities: {}, reads: {} }

/** A refusal for being over budget: what to answer, and how long until it is worth asking again, when time alone lifts it. */
export class OverBudget extends Error {
  readonly retryAfterSeconds: number | null

  constructor(message: string, retryAfterSeconds: number | null) {
    super(message)
    this.retryAfterSeconds = retryAfterSeconds
  }
}

/** The ledger's count a budget of each hourly kind is held against. */
const COUNTED: Record<'changes' | 'calls', { kind: LoadKind; column: 'extra' | 'calls' }> = { changes: { kind: 'write', column: 'extra' }, calls: { kind: 'read', column: 'calls' } }

const count = (n: number) => Math.round(n).toLocaleString('en-US')
/** What can be done when a name passes its budget, as the Load page says it, and where to do it. */
const advice = (kind: BudgetKind) => `${BUDGET_ADVICE[kind].fixes.join(' ')} The Load page shows what it costs, and sets the budget.`

export class Budgets {
  private set: BudgetSet = NONE
  /** What every hub stored of the hour now running, as last read. */
  private hour = { at: -1, read: 0, flushes: -1, changes: new Map<string, number>(), calls: new Map<string, number>() }
  /** What each blueprint holds, as last read. */
  private holds = { read: 0, entities: new Map<string, number>() }
  private reading: Promise<void> | null = null

  private readonly db: Db
  private readonly load: Load
  private readonly log: Logger

  constructor(db: Db, load: Load, log: Logger) {
    this.db = db
    this.load = load
    this.log = log
  }

  async read(): Promise<void> {
    const row = await this.db.query<{ value: unknown }>('SELECT value FROM settings WHERE key = $1', [KEY])
    const parsed = budgetsSchema.safeParse(row.rows[0]?.value ?? {})
    if (!parsed.success) this.log.warn('stored budgets do not read; none is held', { error: parsed.error.message })
    this.set = parsed.success ? parsed.data : NONE
    await this.readNow(true)
  }

  get(): BudgetSet {
    return this.set
  }

  async save(given: unknown): Promise<BudgetSet> {
    const next = budgetsSchema.parse(given)
    await this.db.query('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [KEY, JSON.stringify(next)])
    this.set = next
    await this.readNow(true)
    return next
  }

  /** The budget a name is held to: its own, else the one for everything. */
  budgetOf(kind: BudgetKind, name: string): Budget | undefined {
    return budgetFor(this.set, kind, name)
  }

  /**
   * Refuses a source's write or a caller's call when it is past its limit
   * for the hour. It reads what is kept in memory and never waits: what
   * other hubs counted is read again in the background, so a limit holds to
   * within half a minute of traffic.
   */
  hold(kind: 'changes' | 'calls', name: string): void {
    const limit = this.budgetOf(kind, name)?.limit
    if (limit === undefined) return
    this.refresh()
    const used = this.usedThisHour(kind, name)
    if (used < limit) return
    const left = Math.max(1, Math.ceil((HOUR_MS - (Date.now() % HOUR_MS)) / 1000))
    throw new OverBudget(
      kind === 'changes'
        ? `Source "${name}" changed ${count(used)} entities this hour; its budget is ${count(limit)}. The hub takes its writes again when the hour turns. Send less that changes, or have the budget raised on the Load page.`
        : `"${name}" made ${count(used)} API calls this hour; its budget is ${count(limit)}. The hub answers it again when the hour turns. Ask less often, or have the budget raised on the Load page.`,
      left,
    )
  }

  /** Why a blueprint takes no new entity now, or null when it does. */
  full(blueprint: string): string | null {
    const limit = this.budgetOf('entities', blueprint)?.limit
    if (limit === undefined) return null
    this.refresh()
    const held = this.holds.entities.get(blueprint) ?? 0
    return held < limit ? null : `blueprint "${blueprint}" holds ${count(held)} entities; its budget is ${count(limit)}. It takes no new one until it holds fewer or the budget is raised on the Load page`
  }

  private usedThisHour(kind: 'changes' | 'calls', name: string): number {
    const noted = this.load.noted(COUNTED[kind].kind, name)
    const stored = this.hour.at === Math.floor(Date.now() / HOUR_MS) ? (this.hour[kind].get(name) ?? 0) : 0
    return stored + (noted ? noted[COUNTED[kind].column] : 0)
  }

  /** Reads again, in the background, what a limit is held against, once it is stale or this hub stored more of it. */
  private refresh(): void {
    const hour = Math.floor(Date.now() / HOUR_MS)
    const stale = Date.now() - this.hour.read > FRESH_MS || this.hour.at !== hour || this.hour.flushes !== this.load.flushes
    if (!stale || this.reading) return
    this.reading = this.readNow()
      .catch((error: unknown) => this.log.warn('could not read what the budgets are held against', { error }))
      .finally(() => {
        this.reading = null
      })
  }

  /** Reads now what every hub stored of this hour, and what each blueprint holds once that is stale or `whole` asks. Nothing is read while no limit is set. */
  async readNow(whole = false): Promise<void> {
    if (!BUDGET_KINDS.some((kind) => Object.values(this.set[kind]).some((b) => b.limit !== undefined))) return
    const flushes = this.load.flushes
    const hour = Math.floor(Date.now() / HOUR_MS)
    const sums = await this.db.query<{ kind: LoadKind; name: string; calls: string; extra: string }>(`SELECT kind, name, calls::text AS calls, extra::text AS extra FROM load_hours WHERE hour = $1 AND kind IN ('write', 'read')`, [new Date(hour * HOUR_MS)])
    const changes = new Map<string, number>()
    const calls = new Map<string, number>()
    for (const r of sums.rows) {
      if (r.kind === 'write') changes.set(r.name, Number(r.extra))
      else calls.set(r.name, Number(r.calls))
    }
    this.hour = { at: hour, read: Date.now(), flushes, changes, calls }
    if (Object.values(this.set.entities).some((b) => b.limit !== undefined) && (whole || Date.now() - this.holds.read > FRESH_MS)) {
      const held = await this.db.query<{ blueprint: string; n: string }>(`SELECT blueprint, count(*)::text AS n FROM entities WHERE state IN ('active', 'missing') GROUP BY blueprint`)
      this.holds = { read: Date.now(), entities: new Map(held.rows.map((r) => [r.blueprint, Number(r.n)])) }
    }
  }

  /** What each source and caller used in the hour now running and in its fullest hour since `since`, for those a budget could apply to. */
  async use(since: Date): Promise<Record<'changes' | 'calls', Record<string, BudgetUse>>> {
    const out: Record<'changes' | 'calls', Record<string, BudgetUse>> = { changes: {}, calls: {} }
    const hour = new Date(Math.floor(Date.now() / HOUR_MS) * HOUR_MS)
    const rows = await this.db.query<{ kind: LoadKind; name: string; now: string; peak: string }>(
      `SELECT kind, name,
              coalesce(max(CASE kind WHEN 'write' THEN extra ELSE calls END) FILTER (WHERE hour = $2), 0)::text AS now,
              max(CASE kind WHEN 'write' THEN extra ELSE calls END)::text AS peak
       FROM load_hours WHERE hour >= $1 AND kind IN ('write', 'read') GROUP BY kind, name`,
      [since, hour],
    )
    for (const r of rows.rows) out[r.kind === 'write' ? 'changes' : 'calls'][r.name] = { now: Number(r.now), peak: Number(r.peak) }
    return out
  }

  /** One finding for each name past its budget: amber past `warn`, red past `limit`. An hourly budget is judged by the fullest hour of the last day, so the finding stays to be read. */
  async findings(): Promise<Finding[]> {
    const set = this.set
    if (!BUDGET_KINDS.some((kind) => Object.keys(set[kind]).length)) return []
    const out: Finding[] = []
    const judge = (kind: BudgetKind, name: string, used: number): { budget: Budget; past: 'warn' | 'limit' } | null => {
      const budget = this.budgetOf(kind, name)
      if (!budget) return null
      if (budget.limit !== undefined && used >= budget.limit) return { budget, past: 'limit' }
      if (budget.warn !== undefined && used >= budget.warn) return { budget, past: 'warn' }
      return null
    }
    if (Object.keys(set.changes).length || Object.keys(set.calls).length) {
      await this.load.flush()
      const peaks = await this.db.query<{ kind: LoadKind; name: string; hour: Date; used: string }>(
        `SELECT DISTINCT ON (kind, name) kind, name, hour, (CASE kind WHEN 'write' THEN extra ELSE calls END)::text AS used
         FROM load_hours WHERE hour > now() - interval '24 hours' AND kind IN ('write', 'read')
         ORDER BY kind, name, CASE kind WHEN 'write' THEN extra ELSE calls END DESC, hour DESC`,
      )
      for (const r of peaks.rows) {
        const kind = r.kind === 'write' ? 'changes' : 'calls'
        const used = Number(r.used)
        const over = judge(kind, r.name, used)
        if (!over) continue
        const of = over.budget[over.past]!
        const refused = over.past === 'limit'
        out.push(
          kind === 'changes'
            ? {
                kind: 'over_budget',
                level: refused ? 'red' : 'amber',
                title: `Source ${r.name} changed ${count(used)} entities in an hour; its budget is ${count(of)}`,
                detail: `In the hour from ${r.hour.toISOString()}. ${refused ? 'Past its limit the hub refuses its writes until the hour turns.' : 'Past its limit the hub would refuse its writes.'} ${advice('changes')}`,
                source: r.name,
              }
            : {
                kind: 'over_budget',
                level: refused ? 'red' : 'amber',
                title: `${r.name} made ${count(used)} API calls in an hour; its budget is ${count(of)}`,
                detail: `In the hour from ${r.hour.toISOString()}. ${refused ? 'Past its limit the hub refuses a token until the hour turns; a person is never refused.' : 'Past its limit the hub would refuse a token.'} ${advice('calls')}`,
              },
        )
      }
    }
    if (Object.keys(set.entities).length || Object.keys(set.reads).length) {
      const [held, reads] = await Promise.all([
        this.db.query<{ blueprint: string; n: string }>(`SELECT blueprint, count(*)::text AS n FROM entities WHERE state IN ('active', 'missing') GROUP BY blueprint`),
        Object.keys(set.reads).length ? this.db.query<{ blueprint: string; reads: number }>('SELECT blueprint, avg(cardinality(reads))::float8 AS reads FROM derived GROUP BY blueprint') : Promise.resolve({ rows: [] as { blueprint: string; reads: number }[] }),
      ])
      for (const r of held.rows) {
        const used = Number(r.n)
        const over = judge('entities', r.blueprint, used)
        if (!over) continue
        out.push({
          kind: 'over_budget',
          level: over.past === 'limit' ? 'red' : 'amber',
          title: `Blueprint ${r.blueprint} holds ${count(used)} entities; its budget is ${count(over.budget[over.past]!)}`,
          detail: `${over.past === 'limit' ? 'Past its limit the hub refuses new entities of it.' : 'Past its limit the hub would refuse new entities of it.'} ${advice('entities')}`,
          blueprint: r.blueprint,
        })
      }
      for (const r of reads.rows) {
        const used = Math.round(r.reads * 10) / 10
        const over = judge('reads', r.blueprint, used)
        if (!over) continue
        out.push({
          kind: 'over_budget',
          level: over.past === 'limit' ? 'red' : 'amber',
          title: `One ${r.blueprint} reads ${count(used)} entities on average; its budget is ${count(over.budget[over.past]!)}`,
          detail: `${BUDGET_ADVICE.reads.why} ${advice('reads')}`,
          blueprint: r.blueprint,
        })
      }
    }
    return out
  }
}
