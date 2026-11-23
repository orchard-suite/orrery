import pg from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
import { Db } from './db.ts'
import { working } from './metrics.ts'
import { createLogger, type Logger } from './log.ts'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://orrery:orrery@localhost:5433/orrery'

const db = new Db({ url: DATABASE_URL }, createLogger('db'))

afterAll(async () => {
  await db.close()
})

describe('the database pool', () => {
  it('keeps answering after Postgres closes an idle connection, as it does on a restart', async () => {
    const pid = (await db.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid
    const admin = new pg.Client({ connectionString: DATABASE_URL })
    await admin.connect()
    await admin.query('SELECT pg_terminate_backend($1)', [pid])
    await admin.end()
    // The pool drops the closed connection; no listener here, so only the pool's own one hears it.
    for (let i = 0; i < 100 && db.pool.totalCount > 0; i++) await new Promise((resolve) => setTimeout(resolve, 20))
    expect(db.pool.totalCount).toBe(0)
    expect((await db.query<{ ok: number }>('SELECT 1 AS ok')).rows[0]!.ok).toBe(1)
  })

  it('runs every statement as it is, on each connection it opens: Postgres compiles none', async () => {
    const jit = await Promise.all([db.query<{ jit: string }>('SHOW jit'), db.query<{ jit: string }>('SHOW jit'), db.tx((client) => client.query<{ jit: string }>('SHOW jit'))])
    expect(jit.map((r) => r.rows[0]!.jit)).toEqual(['off', 'off', 'off'])
  })

  it('logs a call stuck waiting for a connection, with the work and the code that asked', async () => {
    const lines: { msg: string; fields: Record<string, unknown> }[] = []
    const record = (msg: string, fields?: Record<string, unknown>) => void lines.push({ msg, fields: fields ?? {} })
    const log: Logger = { debug: record, info: record, warn: record, error: record, child: () => log }
    const small = new Db({ url: DATABASE_URL }, log, { max: 1, statementSeconds: 60 })
    let letGo!: () => void
    let holding!: () => void
    const inside = new Promise<void>((resolve) => (holding = resolve))
    const held = small.tx(() => {
      holding()
      return new Promise<void>((resolve) => (letGo = resolve))
    })
    // The one connection is held once the transaction runs; a call after that waits for it.
    await inside
    const askedForReport = () => working('report test', () => small.query('SELECT 1'))
    const waiting = askedForReport()

    const seen = small.waiting()
    expect(seen).toHaveLength(1)
    expect(seen[0]!.work).toBe('report test')
    expect(seen[0]!.from.join(' ')).toContain('askedForReport')

    small.lookAtWaits(performance.now() + 60_000)
    const stuck = lines.find((l) => l.msg === 'connection waits stuck')
    expect(stuck?.fields).toMatchObject({ queued: 1, tracked: 1, idle: 0, total: 1 })

    letGo()
    await held
    await waiting
    expect(small.waiting()).toEqual([])
    await small.close()
  })
})
