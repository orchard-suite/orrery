import { readFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { concurrentIndex, Db, migrations, type Migration } from './db.ts'
import { createLogger } from './log.ts'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://orrery:orrery@localhost:5433/orrery'
// A database of its own, so a fresh schema can be built from nothing.
const NAME = 'orrery_migrate_test'
const url = (() => {
  const u = new URL(DATABASE_URL)
  u.pathname = `/${NAME}`
  return u.toString()
})()
const log = createLogger('db')

async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: DATABASE_URL })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

let db: Db

beforeAll(async () => {
  await admin(async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${NAME} WITH (FORCE)`)
    await c.query(`CREATE DATABASE ${NAME}`)
  })
  db = new Db({ url }, log)
})

afterAll(async () => {
  await db.close()
  await admin((c) => c.query(`DROP DATABASE IF EXISTS ${NAME} WITH (FORCE)`))
})

/** Holds a lock on a table that every ALTER TABLE on it must wait for, until `release` is called. */
async function holdTable(table: string): Promise<() => Promise<void>> {
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  await client.query('BEGIN')
  await client.query(`LOCK TABLE ${table} IN ACCESS SHARE MODE`)
  return async () => {
    await client.query('COMMIT')
    await client.end()
  }
}

describe('migrations', () => {
  it('builds the schema from nothing and records each step once', async () => {
    await db.migrate(log)
    const done = (await db.query<{ id: string }>('SELECT id FROM schema_migrations ORDER BY id')).rows.map((r) => r.id)
    expect(done).toEqual(migrations().map((m) => m.id))
    expect((await db.query("SELECT to_regclass('public.entities') AS t")).rows[0]!.t).toBe('entities')
  })

  it('keeps no pending list on the index that answers who reads an entity, so a lookup never walks what hubs just derived', async () => {
    const options = (await db.query<{ reloptions: string[] | null }>("SELECT reloptions FROM pg_class WHERE relname = 'derived_reads'")).rows[0]!.reloptions
    expect(options).toContain('fastupdate=off')
  })

  it('finds the tombstones old enough to remove without reading a row, and reads none of the entities still there', async () => {
    await db.query(`INSERT INTO entities (blueprint, key, title, owner, state, deleted_at)
      SELECT 'thing', 'k' || i, 't', 'estate', CASE WHEN i % 4 = 0 THEN 'deleted' ELSE 'active' END, CASE WHEN i % 4 = 0 THEN now() - interval '1 day' END FROM generate_series(1, 4000) i`)
    await db.query('VACUUM ANALYZE entities')
    const plan = (await db.query<{ 'QUERY PLAN': string }>(`EXPLAIN SELECT blueprint, key FROM entities WHERE state = 'deleted' AND deleted_at < now() - interval '90 days' AND blueprint <> ALL(ARRAY['x'])`)).rows.map((r) => r['QUERY PLAN']).join('\n')
    expect(plan).toContain('Index Only Scan using entities_tombstones')
    await db.query(`DELETE FROM entities WHERE blueprint = 'thing'`)
  })

  it('finds the runs that dropped most of their scope from an index of only those, reading no other run', async () => {
    await db.query(`INSERT INTO runs (id, source, mode, scope, state, started_at, mass_drop)
      SELECT 'plan-' || i, 'plan-test', 'snapshot', 'default', 'committed', now() - (i || ' minutes')::interval, i % 2000 = 0 FROM generate_series(1, 8000) i`)
    await db.query('VACUUM ANALYZE runs')
    const plan = (await db.query<{ 'QUERY PLAN': string }>(`EXPLAIN SELECT id, source, scope, counts, started_at FROM runs WHERE mass_drop = true AND started_at > now() - interval '7 days' ORDER BY started_at DESC`)).rows.map((r) => r['QUERY PLAN']).join('\n')
    expect(plan).toContain('Index Scan using runs_mass_drops')
    await db.query(`DELETE FROM runs WHERE source = 'plan-test'`)
  })

  it('finds the runs still open from an index of only those, whether by source and scope or by age', async () => {
    await db.query(`INSERT INTO runs (id, source, mode, scope, state, started_at)
      SELECT 'plan-' || i, 'plan-test', 'snapshot', 'default', CASE WHEN i % 4000 = 0 THEN 'open' ELSE 'committed' END, now() - (i || ' minutes')::interval FROM generate_series(1, 8000) i`)
    await db.query('VACUUM ANALYZE runs')
    const explain = async (sql: string) => (await db.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${sql}`)).rows.map((r) => r['QUERY PLAN']).join('\n')
    expect(await explain(`UPDATE runs SET state = 'abandoned', finished_at = now() WHERE state = 'open' AND mode = 'snapshot' AND source = 'plan-test' AND scope = 'default' RETURNING *`)).toContain('runs_open')
    expect(await explain(`UPDATE runs SET state = 'abandoned', finished_at = now() WHERE state = 'open' AND started_at < now() - interval '1 hour' RETURNING *`)).toContain('runs_open')
    await db.query(`DELETE FROM runs WHERE source = 'plan-test'`)
  })

  it('finds what a person set by hand from indexes of only those, reading none of what sources alone wrote', async () => {
    await db.query(`INSERT INTO entities (blueprint, key, title, owner, ui) SELECT 'thing', 'k' || i, 't', 'src', CASE WHEN i % 1000 = 0 THEN '{"team": {"value": "x"}}'::jsonb ELSE '{}'::jsonb END FROM generate_series(1, 6000) i`)
    await db.query(`INSERT INTO relations (blueprint, key, relation, layer, source, target_blueprint, target_key) SELECT 'thing', 'k' || i, 'team', CASE WHEN i % 1000 = 0 THEN 'ui' ELSE 'pushed' END, 'src', 'team', 't1' FROM generate_series(1, 6000) i`)
    await db.query('VACUUM ANALYZE entities')
    await db.query('VACUUM ANALYZE relations')
    const explain = async (sql: string) => (await db.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${sql}`)).rows.map((r) => r['QUERY PLAN']).join('\\n')
    expect(await explain(`SELECT key FROM entities WHERE blueprint = 'thing' AND (ui <> '{}'::jsonb OR override <> '{}'::jsonb) AND ui ?| ARRAY['team']`)).toContain('entities_by_hand')
    expect(await explain(`SELECT key FROM relations WHERE blueprint = 'thing' AND layer = 'ui' AND relation = ANY(ARRAY['team'])`)).toContain('relations_by_hand')
    await db.query(`DELETE FROM relations WHERE blueprint = 'thing'`)
    await db.query(`DELETE FROM entities WHERE blueprint = 'thing'`)
  })

  it('drops the values kept on a field the hub computes, from every layer, and keeps every stored field', async () => {
    const spec = { id: 'member', fields: { left_at: { type: 'datetime', mirror: '<-exit:member.left_at' }, count: { type: 'number', aggregation: { relation: '<-exit:member', fn: 'count' } }, office: { type: 'string' } } }
    await db.query(`INSERT INTO blueprints (id, spec, origin) VALUES ('member', $1, '{"kind":"ui"}')`, [JSON.stringify(spec)])
    const kept = (value: string) => ({ value, source: 'src', at: '2026-11-01T00:00:00Z' })
    await db.query(`INSERT INTO entities (blueprint, key, owner, pushed, ui) VALUES ('member', 'a', 'src', $1, $2), ('member', 'b', 'src', $3, '{}')`, [
      JSON.stringify({ left_at: kept('2026-06-04'), office: kept('Detroit') }),
      JSON.stringify({ count: { value: 3, by: 'user@example.com', at: '2026-11-01T00:00:00Z' } }),
      JSON.stringify({ office: kept('Remote') }),
    ])
    const step = migrations().find((m) => m.id === '0044-derived-values-unstored')!
    await db.query(step.sql)
    const rows = (await db.query<{ key: string; pushed: Record<string, unknown>; ui: Record<string, unknown> }>(`SELECT key, pushed, ui FROM entities WHERE blueprint = 'member' ORDER BY key`)).rows
    expect(rows.map((r) => [r.key, Object.keys(r.pushed), Object.keys(r.ui)])).toEqual([
      ['a', ['office'], []],
      ['b', ['office'], []],
    ])
    await db.query(`DELETE FROM entities WHERE blueprint = 'member'`)
    await db.query(`DELETE FROM blueprints WHERE id = 'member'`)
  })

  it('takes no table lock on a start with nothing new, so the hub serving beside it never waits', async () => {
    const release = await holdTable('tokens')
    try {
      const started = Date.now()
      await db.migrate(log)
      expect(Date.now() - started).toBeLessThan(2_000)
    } finally {
      await release()
    }
  })

  it('lets go of a table another hub is using and tries again, rather than holding everything behind it', async () => {
    const step: Migration = { id: '9001-test-add', sql: 'ALTER TABLE tokens ADD COLUMN migrate_test TEXT' }
    const release = await holdTable('tokens')
    const migrating = db.migrate(log, [...migrations(), step])
    await sleep(4_000)
    // While the step waits, the table stays readable: the step does not sit in the lock queue.
    const read = await Promise.race([db.query('SELECT count(*) FROM tokens').then(() => 'read'), sleep(1_000).then(() => 'blocked')])
    expect(read).toBe('read')
    await release()
    await migrating
    expect((await db.query("SELECT 1 FROM schema_migrations WHERE id = '9001-test-add'")).rowCount).toBe(1)
  })

  it('applies a step once when two hubs start at once', async () => {
    const step: Migration = { id: '9002-test-once', sql: 'CREATE TABLE migrate_once (id INT)' }
    const other = new Db({ url }, log)
    try {
      await Promise.all([db.migrate(log, [...migrations(), step]), other.migrate(log, [...migrations(), step])])
    } finally {
      await other.close()
    }
    expect((await db.query("SELECT 1 FROM schema_migrations WHERE id = '9002-test-once'")).rowCount).toBe(1)
  })

  it('builds an index outside a transaction, and no write to the table waits while it builds', async () => {
    await db.query('CREATE TABLE migrate_busy (id INT, kind TEXT)')
    // A writer whose transaction is open as the build starts: the build waits for it, and writes go on beside both.
    const writer = new pg.Client({ connectionString: url })
    await writer.connect()
    await writer.query('BEGIN')
    await writer.query("INSERT INTO migrate_busy VALUES (1, 'a')")
    const step: Migration = { id: '9003-test-concurrently', sql: '-- concurrently: a test of a step outside a transaction.\nCREATE INDEX CONCURRENTLY IF NOT EXISTS migrate_busy_kind ON migrate_busy (kind, id DESC);\n' }
    const migrating = db.migrate(log, [...migrations(), step])
    try {
      await sleep(1_000)
      const wrote = await Promise.race([db.query("INSERT INTO migrate_busy VALUES (2, 'b')").then(() => 'wrote'), sleep(2_000).then(() => 'blocked')])
      expect(wrote).toBe('wrote')
    } finally {
      await writer.query('COMMIT')
      await writer.end()
    }
    await migrating
    expect((await db.query<{ valid: boolean }>("SELECT indisvalid AS valid FROM pg_index WHERE indexrelid = 'migrate_busy_kind'::regclass")).rows[0]?.valid).toBe(true)
    expect((await db.query("SELECT 1 FROM schema_migrations WHERE id = '9003-test-concurrently'")).rowCount).toBe(1)
  })

  it('finishes a concurrent build that stopped half way, rather than passing over the index it left', async () => {
    await db.query('CREATE TABLE migrate_half (v INT)')
    await db.query('INSERT INTO migrate_half VALUES (1), (1)')
    // A unique build over a value held twice fails after the index exists: Postgres keeps it, marked invalid.
    await expect(db.query('CREATE UNIQUE INDEX CONCURRENTLY migrate_half_v ON migrate_half (v)')).rejects.toThrow()
    const valid = async () => (await db.query<{ valid: boolean }>("SELECT indisvalid AS valid FROM pg_index WHERE indexrelid = 'migrate_half_v'::regclass")).rows[0]?.valid
    expect(await valid()).toBe(false)
    await db.query('DELETE FROM migrate_half')
    const step: Migration = { id: '9004-test-half', sql: '-- concurrently: a test of a build tried again.\nCREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS migrate_half_v ON migrate_half (v);\n' }
    await db.migrate(log, [...migrations(), step])
    expect(await valid()).toBe(true)
    expect((await db.query("SELECT 1 FROM schema_migrations WHERE id = '9004-test-half'")).rowCount).toBe(1)
  })

  it('runs outside a transaction only one index built concurrently', () => {
    expect(concurrentIndex({ id: 'x', sql: 'CREATE INDEX IF NOT EXISTS a ON t (b);' })).toBeNull()
    expect(concurrentIndex({ id: 'x', sql: '-- concurrently: why.\nCREATE INDEX CONCURRENTLY IF NOT EXISTS a_b ON t (b);' })).toBe('a_b')
    expect(() => concurrentIndex({ id: 'x', sql: '-- concurrently: why.\nCREATE INDEX CONCURRENTLY a_b ON t (b);' })).toThrow(/IF NOT EXISTS/)
    expect(() => concurrentIndex({ id: 'x', sql: '-- concurrently: why.\nCREATE INDEX CONCURRENTLY IF NOT EXISTS a_b ON t (b); DROP TABLE t;' })).toThrow()
    expect(migrations().filter((m) => concurrentIndex(m)).map((m) => m.id)).toContain('0062-changes-kind')
  })

  it('reads the activity log by a kind it holds few of from that kind alone', async () => {
    await db.query(`INSERT INTO changes (at, kind, category, outcome, actor_kind, detail) SELECT now(), 'entity.updated', 'estate', 'ok', 'source', '{}' FROM generate_series(1, 20000)`)
    await db.query('ANALYZE changes')
    const plan = (await db.query<{ 'QUERY PLAN': string }>(`EXPLAIN SELECT * FROM changes WHERE kind = ANY(ARRAY['icon.removed']) ORDER BY id DESC LIMIT 100`)).rows.map((r) => r['QUERY PLAN']).join('\n')
    expect(plan).toContain('changes_kind')
    await db.query(`DELETE FROM changes WHERE kind = 'entity.updated'`)
  })

  it('keeps every step after the base one runnable by the release before it', () => {
    // During a rollout the old release runs on the new schema. A step that drops, renames, or retypes
    // something must come a release after the code that read it is gone, and say so on a `-- contract:` line.
    const destructive = /\b(DROP\s+(TABLE|COLUMN|INDEX|VIEW)|RENAME\b|ALTER\s+COLUMN\s+\S+\s+(TYPE|SET\s+NOT\s+NULL)|SET\s+DATA\s+TYPE)\b/i
    const offenders = migrations()
      .filter((m) => m.id !== '0001-base')
      .filter((m) => {
        const code = m.sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n')
        return destructive.test(code) && !/^--\s*contract:/m.test(m.sql)
      })
      .map((m) => m.id)
    expect(offenders).toEqual([])
    expect(destructive.test('ALTER TABLE x DROP COLUMN y')).toBe(true)
    expect(destructive.test('ALTER TABLE x ADD COLUMN IF NOT EXISTS y TEXT')).toBe(false)
  })

  it('reads its files in order', () => {
    const ids = migrations().map((m) => m.id)
    expect(ids[0]).toBe('0001-base')
    expect([...ids].sort()).toEqual(ids)
    expect(readFileSync(new URL('./migrations/0001-base.sql', import.meta.url), 'utf8')).toContain('CREATE TABLE IF NOT EXISTS entities')
  })
})
