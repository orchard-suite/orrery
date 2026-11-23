import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { entityId } from '../shared/model.ts'
import { loadConfig } from './config.ts'
import { createHub, type Hub } from './hub.ts'
import { createLogger } from './log.ts'
import { JournalPruner } from './ownership.ts'

// Its own database: these tests write links straight into it, under every hub-level check, as any writer might.
const DATABASE_URL = (process.env.DATABASE_URL ?? 'postgres://orrery:orrery@localhost:5433/orrery') + '_ownership'

let hub: Hub

const as = (email: string, groups = 'Admin') => (path: string, init?: RequestInit) =>
  hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', 'x-forwarded-email': email, 'x-forwarded-groups': groups, ...init?.headers } }, { surface: 'session' })
const admin = as('admin@example.org')
const put = (v: unknown) => ({ method: 'PUT', body: JSON.stringify(v) })
const post = (v: unknown) => ({ method: 'POST', body: JSON.stringify(v) })

const PEOPLE = ['ada@example.org', 'bob@example.org', 'cy@example.org']
const TEAMS = ['red', 'blue', 'green']
const THINGS = Array.from({ length: 12 }, (_, i) => `t${i}`)
const OWNS = [
  { as: 'owner', path: '<-owner' },
  { as: 'team', path: '<-lead.<-team' },
  { as: 'member', path: 'team.<-team' },
  { as: 'team', path: '<-lead.<-parent.<-team' },
]
const LAYERS = ['inherited', 'pushed', 'ui'] as const

/** Who owns what, worked out as a fresh walk of the database would: the answer the kept one must always equal. */
async function walked(address: string): Promise<Record<string, string[]>> {
  const me = { blueprint: 'user', key: address }
  const ends = await hub.reader.reachAll([me], OWNS.map((p) => p.path))
  const out: Record<string, string[]> = {}
  for (const p of OWNS) for (const id of ends.get(p.path)?.get(entityId(me)) ?? []) (out[id] ??= []).push(p.as)
  for (const roles of Object.values(out)) roles.sort()
  return out
}

/** Who owns what as the hub keeps it. */
async function kept(address: string): Promise<Record<string, string[]>> {
  const owned = await hub.visibility.ownedKept(address)
  if (owned.state !== 'known') return {}
  return Object.fromEntries([...owned.ids].map(([id, roles]) => [id, [...roles].sort()]))
}

/** A write straight to the database, said as every writer says it once it commits. */
async function written(blueprint: string, sql: string, values: unknown[]): Promise<void> {
  await hub.db.query(sql, values)
  hub.events.emit({ type: 'estate', blueprints: [blueprint] })
}
const link = (blueprint: string, key: string, relation: string, layer: string, target: string, targetKey: string) =>
  written(blueprint, `INSERT INTO relations (blueprint, key, relation, layer, source, target_blueprint, target_key) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`, [blueprint, key, relation, layer, `test:${layer}`, target, targetKey])
const unlink = (blueprint: string, key: string, relation: string, layer: string) => written(blueprint, `DELETE FROM relations WHERE blueprint = $1 AND key = $2 AND relation = $3 AND layer = $4`, [blueprint, key, relation, layer])
const state = (blueprint: string, key: string, to: 'active' | 'deleted' | 'flip') =>
  written(blueprint, `UPDATE entities SET state = CASE WHEN $3 = 'flip' THEN CASE WHEN state = 'deleted' THEN 'active' ELSE 'deleted' END ELSE $3 END WHERE blueprint = $1 AND key = $2`, [blueprint, key, to])

beforeAll(async () => {
  const pg = await import('pg').then(({ default: m }) => new m.Client({ connectionString: DATABASE_URL.replace(/\/[^/]+$/, '/postgres') }))
  await pg.connect()
  await pg.query(`DROP DATABASE IF EXISTS ${DATABASE_URL.split('/').pop()}`)
  await pg.query(`CREATE DATABASE ${DATABASE_URL.split('/').pop()}`)
  await pg.end()
  hub = await createHub(loadConfig({ DATABASE_URL, DATA_DIR: mkdtempSync(join(tmpdir(), 'orrery-')), AUTH_MODE: 'proxy' }), 'test', { reset: true })
  const save = async (spec: { id: string }) => expect((await admin(`/v1/blueprints/${spec.id}`, put(spec))).status).toBe(200)
  await save({ id: 'team', title: 'Team', fields: {}, relations: {} } as { id: string })
  await save({ id: 'user', title: 'Person', fields: {}, relations: { team: { target: 'team' } } } as { id: string })
  await save({ id: 'team', title: 'Team', fields: {}, relations: { lead: { target: 'user' }, parent: { target: 'team' } } } as { id: string })
  await save({ id: 'thing', title: 'Thing', fields: {}, relations: { owner: { target: 'user' }, team: { target: 'team' } } } as { id: string })
  const create = async (blueprint: string, key: string) => expect((await admin('/v1/entities', post({ blueprint, key, title: key }))).status).toBe(201)
  for (const p of PEOPLE) await create('user', p)
  for (const t of TEAMS) await create('team', t)
  for (const t of THINGS) await create('thing', t)
  expect((await admin('/v1/access/person', put({ blueprint: 'user', owns: OWNS }))).status).toBe(200)
})

afterAll(async () => {
  await hub.close()
})

describe('what a person owns', () => {
  it('moves in place as links come and go, and is what a fresh walk finds', async () => {
    await link('thing', 't0', 'owner', 'pushed', 'user', 'ada@example.org')
    await link('team', 'red', 'lead', 'pushed', 'user', 'ada@example.org')
    await link('thing', 't1', 'team', 'pushed', 'team', 'red')
    expect(await kept('ada@example.org')).toEqual({ 'thing:t0': ['owner'], 'thing:t1': ['team'] })
    // A thing the team gains is ada's at once; one it loses is not.
    await link('thing', 't2', 'team', 'pushed', 'team', 'red')
    await unlink('thing', 't1', 'team', 'pushed')
    expect(await kept('ada@example.org')).toEqual({ 'thing:t0': ['owner'], 'thing:t2': ['team'] })
    // The team led by another: everything ada owned through it goes to bob.
    await unlink('team', 'red', 'lead', 'pushed')
    await link('team', 'red', 'lead', 'pushed', 'user', 'bob@example.org')
    expect(await kept('ada@example.org')).toEqual({ 'thing:t0': ['owner'] })
    expect(await kept('bob@example.org')).toEqual({ 'thing:t2': ['team'] })
  })

  it('follows the link that wins its relation, and leaves out what is deleted', async () => {
    // A hand edit over what was pushed names cy; the pushed link to ada no longer counts.
    await link('thing', 't3', 'owner', 'pushed', 'user', 'ada@example.org')
    await link('thing', 't3', 'owner', 'ui', 'user', 'cy@example.org')
    expect(await kept('ada@example.org')).not.toHaveProperty('thing:t3')
    expect(await kept('cy@example.org')).toHaveProperty('thing:t3')
    await unlink('thing', 't3', 'owner', 'ui')
    expect(await kept('ada@example.org')).toHaveProperty('thing:t3')
    await state('thing', 't3', 'deleted')
    expect(await kept('ada@example.org')).not.toHaveProperty('thing:t3')
    await state('thing', 't3', 'active')
    expect(await kept('ada@example.org')).toHaveProperty('thing:t3')
  })

  it('takes a team over its own, and what the teams under a team hold', async () => {
    await link('user', 'cy@example.org', 'team', 'pushed', 'team', 'blue')
    await link('thing', 't6', 'team', 'pushed', 'team', 'blue')
    await link('thing', 't7', 'team', 'pushed', 'team', 'green')
    expect(await kept('cy@example.org')).toMatchObject({ 'thing:t6': ['member'] })
    // A hand edit puts cy on green: blue's things are no longer theirs.
    await link('user', 'cy@example.org', 'team', 'ui', 'team', 'green')
    const after = await kept('cy@example.org')
    expect(after).toHaveProperty('thing:t7')
    expect(after).not.toHaveProperty('thing:t6')
    // Cy leads blue, and green sits under blue: what green holds is cy's by the team too, though nothing names green.
    await link('team', 'green', 'parent', 'pushed', 'team', 'blue')
    await link('team', 'blue', 'lead', 'ui', 'user', 'cy@example.org')
    expect((await kept('cy@example.org'))['thing:t7']).toEqual(['member', 'team'])
    expect(await kept('cy@example.org')).toEqual(await walked('cy@example.org'))
  })

  it('never walks again what it keeps, however much moves', async () => {
    await kept('ada@example.org')
    const walks = vi.spyOn(hub.reader, 'reachAll')
    const statements = vi.spyOn(hub.db, 'query')
    try {
      await link('thing', 't4', 'owner', 'pushed', 'user', 'ada@example.org')
      statements.mockClear()
      await kept('ada@example.org')
      expect(walks).not.toHaveBeenCalled()
      // A look at what moved, and the links of the one thing it names: never every link into ada.
      expect(statements.mock.calls.length).toBeLessThan(12)
    } finally {
      walks.mockRestore()
      statements.mockRestore()
    }
  })

  it('stays what a fresh walk finds through any run of moves', async () => {
    // A fixed seed, so a failure is the same run every time.
    let seed = 7
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed % n
    }
    const pick = <T,>(list: readonly T[]): T => list[rand(list.length)]!
    for (let step = 0; step < 300; step++) {
      const move = rand(10)
      const layer = pick(LAYERS)
      if (move === 0) await link('thing', pick(THINGS), 'owner', layer, 'user', pick(PEOPLE))
      else if (move === 1) await unlink('thing', pick(THINGS), 'owner', layer)
      else if (move === 2) await link('thing', pick(THINGS), 'team', layer, 'team', pick(TEAMS))
      else if (move === 3) await unlink('thing', pick(THINGS), 'team', layer)
      else if (move === 4) {
        const team = pick(TEAMS)
        await unlink('team', team, 'lead', layer)
        await link('team', team, 'lead', layer, 'user', pick(PEOPLE))
      } else if (move === 5) await link('user', pick(PEOPLE), 'team', layer, 'team', pick(TEAMS))
      else if (move === 6) await unlink('user', pick(PEOPLE), 'team', layer)
      else if (move === 7) await link('team', pick(TEAMS), 'parent', layer, 'team', pick(TEAMS))
      else if (move === 8) await unlink('team', pick(TEAMS), 'parent', layer)
      else if (rand(3)) await state('thing', pick(THINGS), 'flip')
      else await state('team', pick(TEAMS), 'flip')
      for (const p of PEOPLE) expect(await kept(p), `${p} after step ${step}`).toEqual(await walked(p))
    }
  })
})

describe('the journal of moved links', () => {
  it('lets go only of what is older than every look a hub may still trust', async () => {
    const pruner = new JournalPruner(hub.db, createLogger('ownership'))
    const before = Number((await hub.db.query<{ n: string }>('SELECT count(*)::text AS n FROM link_journal')).rows[0]!.n)
    expect(before).toBeGreaterThan(0)
    await pruner.pass()
    expect(Number((await hub.db.query<{ n: string }>('SELECT count(*)::text AS n FROM link_journal')).rows[0]!.n)).toBe(before)
    // An hour on, what was open then is let go.
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 61 * 60_000)
    try {
      await link('thing', 't5', 'owner', 'pushed', 'user', 'cy@example.org')
      await pruner.pass()
    } finally {
      clock.mockRestore()
    }
    const after = Number((await hub.db.query<{ n: string }>('SELECT count(*)::text AS n FROM link_journal')).rows[0]!.n)
    expect(after).toBeLessThan(before)
  })
})
