// Test files run side by side, one per worker, and most of them reset the
// database they are given. So each worker gets a database of its own: the
// one DATABASE_URL names, with the worker's number on the end. A file that
// builds a database of its own from DATABASE_URL builds it under that name
// too, so two workers never share one.
import pg from 'pg'

const base = process.env.DATABASE_URL ?? 'postgres://orrery:orrery@localhost:5433/orrery'
const worker = process.env.VITEST_POOL_ID
const marked = '__ORRERY_TEST_DATABASE'

if (worker && !process.env[marked]) {
  const url = new URL(base)
  const name = `${url.pathname.slice(1)}_w${worker}`
  url.pathname = `/${name}`
  process.env.DATABASE_URL = url.toString()
  process.env[marked] = name
  await ensure(base, name)
}

/** Creates the database unless it is there. Only a test file that reaches Postgres needs it, so an unreachable server is left for that file to report. */
async function ensure(admin: string, name: string): Promise<void> {
  const client = new pg.Client({ connectionString: admin })
  try {
    await client.connect()
  } catch {
    return
  }
  try {
    const { rowCount } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])
    if (!rowCount) await client.query(`CREATE DATABASE "${name}"`)
  } finally {
    await client.end()
  }
}
