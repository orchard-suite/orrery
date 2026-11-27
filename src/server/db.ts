import { AsyncLocalStorage } from 'node:async_hooks'
import { randomBytes } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import pg from 'pg'
import type { Config } from './config.ts'
import type { Logger } from './log.ts'
import { collecting, currentWork, recordConnectionWait } from './metrics.ts'
import { identityFromEnv, tokenSource } from './workload.ts'

/** Numbered SQL files, applied once each, in order, at start. */
const MIGRATIONS_DIR = resolve(import.meta.dirname, 'migrations')

/** The advisory lock every hub takes before it migrates, so two hubs starting at once apply each step once. */
export const LOCK_SPACE = 1869771378
const MIGRATE_LOCK = 1

/**
 * How long a step waits for a table another hub is using before it lets go
 * and tries again. A step waiting for a table holds every later reader of it
 * behind it, so the wait is short and the pause between tries long.
 */
const LOCK_WAIT = '500ms'
const LOCK_TRIES = 60
/** How often a hub asks again for the migration another hub holds. */
const MIGRATE_POLL_MS = 250

export interface Migration {
  id: string
  sql: string
}

/**
 * A step whose first line is `-- concurrently:` builds one index on a table
 * the hub writes all the time, outside a transaction, so no write waits for
 * it while it builds: it is one `CREATE [UNIQUE] INDEX CONCURRENTLY IF NOT
 * EXISTS` and nothing else. Every other step runs in a transaction of its own.
 */
const CONCURRENT_MARK = /^--\s*concurrently:/
const CONCURRENT_INDEX = /^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\s+IF\s+NOT\s+EXISTS\s+([a-z_][a-z0-9_]*)\s+ON\s+[^;]+;?\s*$/i

/** The index a step outside a transaction builds, or null for a step that runs in one. Throws on a step marked so that is not one index built concurrently. */
export function concurrentIndex(m: Migration): string | null {
  if (!CONCURRENT_MARK.test(m.sql)) return null
  const code = m.sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n')
  const built = CONCURRENT_INDEX.exec(code)
  if (!built) throw new Error(`migration ${m.id} runs outside a transaction, so it is one CREATE INDEX CONCURRENTLY IF NOT EXISTS and nothing else`)
  return built[1]!
}

/** The migrations in `migrations/`, by file name: `0001-base.sql` before `0002-...`. */
export function migrations(dir = MIGRATIONS_DIR): Migration[] {
  const list = readdirSync(dir)
    .filter((f) => /^\d{4}-[a-z0-9-]+\.sql$/.test(f))
    .sort()
    .map((f) => ({ id: f.replace(/\.sql$/, ''), sql: readFileSync(join(dir, f), 'utf8') }))
  for (const m of list) concurrentIndex(m)
  return list
}

export type Queryable = Pick<pg.PoolClient, 'query'>

/** The transaction a call runs inside, and what waits for it to commit. */
const open = new AsyncLocalStorage<{ client: object; committed: (() => void)[] }>()

/**
 * Runs `fn` once what `client` wrote is committed: after the transaction
 * commits when `client` is the one `tx` opened, at once otherwise. A
 * transaction that rolls back drops it.
 */
export function afterCommit(client: object, fn: () => void): void {
  const tx = open.getStore()
  if (tx?.client === client) tx.committed.push(fn)
  else fn()
}

/** Where the hub's database is, and, signing in as a workload identity, the token that is its password. */
export interface Connection {
  url: string
  password?: () => Promise<string>
}

/** The scope Azure Database for PostgreSQL takes Entra tokens for. */
const POSTGRES_SCOPE = 'https://ossrdbms-aad.database.windows.net/.default'

/** The connection `DATABASE_AUTH` asks for: the URL's own password, or the pod's workload identity. */
export function connectionOf(config: Pick<Config, 'DATABASE_URL' | 'DATABASE_AUTH'>, env: NodeJS.ProcessEnv = process.env): Connection {
  if (config.DATABASE_AUTH === 'password') return { url: config.DATABASE_URL }
  return { url: config.DATABASE_URL, password: tokenSource(identityFromEnv(env), POSTGRES_SCOPE) }
}

/**
 * The settings `pg` opens a connection with. Given a connection string, `pg`
 * takes every field from it and drops a password passed beside it, so a
 * token password goes with the URL's parts instead.
 */
export function clientConfig(connection: Connection): pg.ClientConfig {
  if (!connection.password) return { connectionString: connection.url }
  const url = new URL(connection.url)
  return {
    host: decodeURIComponent(url.hostname),
    port: Number(url.port || 5432),
    user: decodeURIComponent(url.username),
    database: decodeURIComponent(url.pathname.slice(1)),
    ssl: url.searchParams.get('sslmode') !== 'disable',
    password: connection.password,
  }
}

/** A wait this long for a connection is logged when it ends. */
const SLOW_WAIT_MS = 1000
/** A wait this long is logged while it lasts, at the next look. */
const STUCK_MS = 10_000
/** How often the pool's queue is looked at. */
const WATCH_MS = 30_000
/** How many of the oldest waits one log line names. */
const WAITS_LOGGED = 5

/** One call waiting for a pooled connection: since when, under what work, from where, and whether a gauge asked for it as it was read. */
interface Wait {
  since: number
  work: string | undefined
  from: Error
  collector: boolean
}

/** A wait as a log line tells it. */
export interface WaitSeen {
  ms: number
  work: string | null
  from: string[]
}

/** The caller's frames outside this file, the runtime, and the libraries: who asked for the connection. */
function callerOf(from: Error): string[] {
  return (from.stack ?? '')
    .split('\n')
    .filter((line) => line.startsWith('    at ') && !line.includes('/db.ts') && !line.includes('node:') && !line.includes('node_modules'))
    .slice(0, 4)
    .map((line) => line.trim().slice(3).replace(/(?:file:\/\/)?\/\S*?\/src\//, ''))
}

/** What the pool is held to: how many connections, and how long one statement may run. */
export interface PoolLimits {
  max: number
  statementSeconds: number
}

export class Db {
  readonly pool: pg.Pool
  readonly connection: Connection
  /** This hub's name among the hubs on the database: every statement it runs carries it, so a change it made is known as its own. */
  readonly name = `orrery-${randomBytes(6).toString('hex')}`
  private readonly log: Logger
  /** Every call waiting for a connection now. A superset of the pool's own queue: a call joins before it asks and leaves once it holds one. */
  private readonly waits = new Set<Wait>()
  private readonly watch: NodeJS.Timeout

  constructor(connection: Connection, log: Logger, limits: PoolLimits = { max: 10, statementSeconds: 60 }) {
    this.connection = connection
    // The hub's statements are many and short. Postgres compiling one costs more than the run it saves: it took half
    // a second of a grid's shape. So every connection runs them as they are, set before its first statement.
    const onConnect = async (client: pg.ClientBase): Promise<void> => void (await client.query('SET jit = off'))
    this.pool = new pg.Pool({ ...clientConfig(connection), max: limits.max, statement_timeout: Math.round(limits.statementSeconds * 1000), application_name: this.name, onConnect })
    // Postgres closing an idle connection, on a restart or a failover, is
    // raised here; the pool drops that connection and opens a new one on the
    // next query. Unheard, it would end the process.
    this.pool.on('error', (error) => log.warn('idle database connection lost', { error }))
    this.log = log
    this.watch = setInterval(() => this.lookAtWaits(), WATCH_MS)
    this.watch.unref()
  }

  /** The calls waiting for a connection now, oldest first. */
  waiting(now = performance.now()): WaitSeen[] {
    return [...this.waits].sort((a, b) => a.since - b.since).map((w) => ({ ms: Math.round(now - w.since), work: w.work ?? null, from: callerOf(w.from) }))
  }

  /**
   * How many calls wait for a connection now and will not get one at once:
   * the gauges' own reads left out, and less the idle connections the pool
   * hands to the oldest waits on its next turn.
   */
  pending(): number {
    let waiting = 0
    for (const w of this.waits) if (!w.collector) waiting++
    return Math.max(0, waiting - this.pool.idleCount)
  }

  /**
   * Logs the pool's queue when something in it is stuck: a call waiting
   * STUCK_MS or more, or the pool counting more waiting than this hub's
   * calls, which only a caller outside this class can be.
   */
  lookAtWaits(now = performance.now()): void {
    const seen = this.waiting(now)
    const stuck = seen.filter((w) => w.ms >= STUCK_MS)
    const queued = this.pool.waitingCount
    if (stuck.length === 0 && queued <= this.waits.size) return
    this.log.warn('connection waits stuck', { queued, tracked: this.waits.size, idle: this.pool.idleCount, total: this.pool.totalCount, oldest: (stuck.length ? stuck : seen).slice(0, WAITS_LOGGED) })
  }

  /** A pooled connection, its wait recorded while it lasts and logged when it ran long. */
  private async acquire(): Promise<pg.PoolClient> {
    const wait: Wait = { since: performance.now(), work: currentWork(), from: new Error('connection asked for'), collector: collecting() }
    this.waits.add(wait)
    try {
      return await this.pool.connect()
    } finally {
      this.waits.delete(wait)
      const ms = performance.now() - wait.since
      if (!wait.collector) recordConnectionWait(ms / 1000)
      if (ms >= SLOW_WAIT_MS) this.log.warn('slow connection wait', { ms: Math.round(ms), work: wait.work ?? null, from: callerOf(wait.from), idle: this.pool.idleCount, total: this.pool.totalCount })
    }
  }

  /**
   * Applies every migration not yet recorded, each in its own transaction,
   * under an advisory lock so a second hub starting at once waits. It waits
   * by asking for the lock again and again, never inside a statement that
   * blocks: a statement waiting holds a snapshot open, and an index built
   * concurrently waits for every snapshot, so the two would wait on each
   * other until Postgres ended one as a deadlock. A start
   * with nothing new takes no table lock. A step that cannot get a table lock
   * within a few seconds rolls back and tries again, so it never holds up
   * the hub still serving beside it.
   */
  async migrate(log: Logger, list = migrations()): Promise<void> {
    const client = await this.acquire()
    try {
      // A step waits for another hub's migration and may run long itself: neither is cut by the statement timeout.
      await client.query('SET statement_timeout = 0')
      for (let waited = 0; !(await client.query<{ got: boolean }>('SELECT pg_try_advisory_lock($1, $2) AS got', [LOCK_SPACE, MIGRATE_LOCK])).rows[0]!.got; waited++) {
        if (!waited) log.info('migration waits for another hub migrating')
        await sleep(MIGRATE_POLL_MS)
      }
      await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())')
      const done = new Set((await client.query<{ id: string }>('SELECT id FROM schema_migrations')).rows.map((r) => r.id))
      const due = list.filter((m) => !done.has(m.id))
      for (const m of due) await apply(client, m, log)
      log.info('schema ready', { applied: due.map((m) => m.id), migrations: list.length })
    } finally {
      await client.query('SELECT pg_advisory_unlock($1, $2)', [LOCK_SPACE, MIGRATE_LOCK]).catch(() => undefined)
      // The connection goes back to the pool with the timeout every other statement runs under.
      await client.query('RESET statement_timeout').catch(() => undefined)
      client.release()
    }
  }

  query<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = []): Promise<pg.QueryResult<T>> {
    return this.run<T>(text, params)
  }

  /** One statement on its own connection, handed back after. A failed statement drops its connection, as `pool.query` does. */
  private async run<T extends pg.QueryResultRow>(text: string, params: unknown[]): Promise<pg.QueryResult<T>> {
    const client = await this.acquire()
    let failed: Error | undefined
    try {
      return await client.query<T>(text, params)
    } catch (error) {
      failed = error instanceof Error ? error : new Error(String(error))
      throw error
    } finally {
      client.release(failed)
    }
  }

  /** Runs `fn` inside a transaction. Rolls back when it throws. */
  async tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.acquire()
    const committed: (() => void)[] = []
    try {
      await client.query('BEGIN')
      const result = await open.run({ client, committed }, () => fn(client))
      await client.query('COMMIT')
      for (const done of committed) done()
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }

  /** Empties every table. Tests only. */
  async reset(): Promise<void> {
    await this.pool.query('TRUNCATE blueprints, entities, relations, derived, derive_queue, sources, tokens, runs, changes, relation_rules, grid_layouts, settings, scorecards, scorecard_history, field_history, secrets, check_results, alerts, alert_rules, users, roles, actions, action_runs, action_batches, action_run_images, action_schedules, saved_queries, icons, source_writes, browser_tabs, run_seen, scope_seen, load_hours, pins, person_preferences, ingest_digests, list_stamps, column_profiles, report_versions, report_editions, report_previews, dataset_answers')
  }

  async close(): Promise<void> {
    clearInterval(this.watch)
    await this.pool.end()
  }
}

/** Applies one migration and records it, trying again while another hub holds a table it needs. */
async function apply(client: pg.PoolClient, m: Migration, log: Logger): Promise<void> {
  const index = concurrentIndex(m)
  if (index) return build(client, m, index, log)
  for (let attempt = 1; ; attempt++) {
    const started = Date.now()
    try {
      await client.query('BEGIN')
      await client.query(`SET LOCAL lock_timeout = '${LOCK_WAIT}'`)
      await client.query(m.sql)
      await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [m.id])
      await client.query('COMMIT')
      log.info('migration applied', { migration: m.id, attempt, ms: Date.now() - started })
      return
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      const busy = (error as { code?: string }).code === '55P03'
      if (!busy || attempt >= LOCK_TRIES) {
        log.error('migration failed', { migration: m.id, attempt, error })
        throw error
      }
      log.warn('migration waits: a table it needs is in use', { migration: m.id, attempt })
      await sleep(Math.min(attempt, 5) * 1000)
    }
  }
}

/**
 * Builds one index concurrently, outside a transaction, and records the step.
 * Writes to the table go on while it builds; the build waits for whatever is
 * under way on the table, with no timeout, since its waiting holds nobody up.
 * A build that stopped half way, here or on a hub that died, leaves an index
 * Postgres marks invalid, which `IF NOT EXISTS` would pass over: the next try
 * drops it, concurrently, and builds it again, so the step is recorded only
 * with an index that answers.
 */
async function build(client: pg.PoolClient, m: Migration, index: string, log: Logger): Promise<void> {
  const started = Date.now()
  try {
    const left = await client.query<{ valid: boolean }>(`SELECT i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relname = $1 AND n.nspname = current_schema()`, [index])
    if (left.rows[0] && !left.rows[0].valid) {
      log.warn('migration finds the index a build left half done; dropping it to build again', { migration: m.id, index })
      await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${index}`)
    } else if (left.rows[0]) log.info('migration finds its index built already', { migration: m.id, index })
    else log.debug('migration builds its index', { migration: m.id, index })
    await client.query(m.sql)
    await client.query('INSERT INTO schema_migrations (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [m.id])
    log.info('migration applied', { migration: m.id, concurrently: true, ms: Date.now() - started })
  } catch (error) {
    log.error('migration failed; the next start builds its index again', { migration: m.id, index, concurrently: true, error })
    throw error
  }
}
