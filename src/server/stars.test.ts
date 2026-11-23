import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { EntitiesResponse, EntityPageResponse, LoadResponse, PinsResponse, QueryResult, StarsResponse, TokenIssued } from '../shared/api.ts'
import { loadConfig } from './config.ts'
import { createHub, type Hub } from './hub.ts'
import { starsLoad } from './load.ts'

// Its own database: these tests sign people in and star what they see, which every other test would then read.
const DATABASE_URL = (process.env.DATABASE_URL ?? 'postgres://orrery:orrery@localhost:5433/orrery') + '_stars'

let hub: Hub

const PERSON = 'user@example.com'
const OTHER = 'other@example.com'

const as = (email: string, groups = 'User') => (path: string, init?: RequestInit) =>
  hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', 'x-forwarded-email': email, 'x-forwarded-groups': groups, ...init?.headers } }, { surface: 'session' })
const bearer = (token: string) => (path: string, init?: RequestInit) => hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...init?.headers } }, { surface: 'machine' })
const json = async <T = Record<string, unknown>>(r: Response): Promise<T> => (await r.json()) as T
const put = (v?: unknown) => ({ method: 'PUT', ...(v === undefined ? {} : { body: JSON.stringify(v) }) })
const post = (v: unknown) => ({ method: 'POST', body: JSON.stringify(v) })

const admin = as('admin@example.com', 'Admin')
const person = as(PERSON)
const other = as(OTHER)
type Caller = (path: string, init?: RequestInit) => Response | Promise<Response>

const star = (who: Caller, blueprint: string, key: string) => who(`/v1/mine/stars/${blueprint}/${key}`, put())
const unstar = (who: Caller, blueprint: string, key: string) => who(`/v1/mine/stars/${blueprint}/${key}`, { method: 'DELETE' })
const starred = async (who: Caller) => (await json<StarsResponse>(await who('/v1/mine/stars'))).stars.map((s) => `${s.blueprint}:${s.key}`)
const keys = async (who: Caller, query: string) => (await json<EntitiesResponse>(await who(`/v1/entities?${query}`))).entities.map((e) => e.key)

/** Boxes of each size, so a sort by size and a group by colour both have something to order. */
const BOXES: [string, number, string][] = [
  ['a', 1, 'red'],
  ['b', 2, 'blue'],
  ['c', 3, 'red'],
  ['d', 4, 'blue'],
  ['e', 5, 'red'],
]

beforeAll(async () => {
  const pg = await import('pg').then(({ default: m }) => new m.Client({ connectionString: DATABASE_URL.replace(/\/[^/]+$/, '/postgres') }))
  await pg.connect()
  await pg.query(`DROP DATABASE IF EXISTS ${DATABASE_URL.split('/').pop()}`)
  await pg.query(`CREATE DATABASE ${DATABASE_URL.split('/').pop()}`)
  await pg.end()
  hub = await createHub(loadConfig({ DATABASE_URL, DATA_DIR: mkdtempSync(join(tmpdir(), 'orrery-')), AUTH_MODE: 'proxy' }), 'test', { reset: true })
  const save = async (id: string, spec: Record<string, unknown>) => expect((await admin(`/v1/blueprints/${id}`, put({ id, ...spec }))).status).toBe(200)
  await save('box', { title: 'Box', fields: { size: { type: 'number' }, colour: { type: 'string' } }, relations: {} })
  await save('pipe', { title: 'Pipe', fields: { length: { type: 'number' } }, relations: {} })
  await save('vault', { title: 'Vault', fields: {}, relations: {}, access: { grants: [{ values: ['nobody@example.org'] }] } })
  for (const [key, size, colour] of BOXES) expect((await admin('/v1/entities', post({ blueprint: 'box', key, title: key, fields: { size, colour } }))).status).toBe(201)
  for (const key of ['p1', 'p2']) expect((await admin('/v1/entities', post({ blueprint: 'pipe', key, title: key, fields: { length: 10 } }))).status).toBe(201)
  expect((await admin('/v1/entities', post({ blueprint: 'vault', key: 'v1', title: 'v1', fields: {} }))).status).toBe(201)
  await Promise.all([person('/v1/whoami'), other('/v1/whoami')])
})

afterAll(async () => {
  await hub.close()
})

beforeEach(async () => {
  await hub.db.query('DELETE FROM stars')
  await hub.db.query('DELETE FROM pins')
})

describe("a person's stars", () => {
  it('are kept newest first, and starring twice or letting go of what is not starred changes nothing', async () => {
    expect((await star(person, 'box', 'b')).status).toBe(200)
    expect((await star(person, 'pipe', 'p2')).status).toBe(200)
    expect((await star(person, 'box', 'b')).status).toBe(200)
    expect(await starred(person)).toEqual(['pipe:p2', 'box:b'])
    expect((await unstar(person, 'box', 'b')).status).toBe(200)
    expect((await unstar(person, 'box', 'b')).status).toBe(200)
    expect(await starred(person)).toEqual(['pipe:p2'])
  })

  it('are theirs alone', async () => {
    await star(person, 'box', 'd')
    expect(await starred(other)).toEqual([])
    expect(await keys(other, 'blueprint=box&sort=size')).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('come first in every order of every grid, and are marked on each row', async () => {
    await star(person, 'box', 'b')
    await star(person, 'box', 'd')
    expect(await keys(person, 'blueprint=box&sort=size')).toEqual(['b', 'd', 'a', 'c', 'e'])
    expect(await keys(person, 'blueprint=box&sort=-size')).toEqual(['d', 'b', 'e', 'c', 'a'])
    // The grid's own path: a kept listing's blocks.
    expect(await keys(person, 'blueprint=box&sort=-size&distribution=later')).toEqual(['d', 'b', 'e', 'c', 'a'])
    const rows = (await json<EntitiesResponse>(await person('/v1/entities?blueprint=box&sort=size'))).entities
    expect(rows.filter((e) => e.starred).map((e) => e.key)).toEqual(['b', 'd'])
  })

  it('come first inside each group, and leave the groups in their order', async () => {
    await star(person, 'box', 'e')
    await star(person, 'box', 'b')
    const answer = await json<EntitiesResponse>(await person('/v1/entities?blueprint=box&sort=size&group=colour&distribution=later'))
    expect(answer.groups?.map((g) => g.key)).toEqual(['blue', 'red'])
    expect(answer.entities.map((e) => e.key)).toEqual(['b', 'd', 'e', 'a', 'c'])
  })

  it('keep their place across the pages of a grid', async () => {
    await star(person, 'box', 'c')
    const seen: string[] = []
    let next: string | null = null
    do {
      const page: EntitiesResponse = await json<EntitiesResponse>(await person(`/v1/entities?blueprint=box&sort=size&limit=2${next ? `&after=${next}` : ''}`))
      seen.push(...page.entities.map((e) => e.key))
      next = page.next
    } while (next)
    expect(seen).toEqual(['c', 'a', 'b', 'd', 'e'])
  })

  it('move the tag of a grid, so a copy from before a star is not taken as current', async () => {
    const first = await person('/v1/entities?blueprint=box&sort=size')
    const tag = first.headers.get('etag')!
    expect((await person('/v1/entities?blueprint=box&sort=size', { headers: { 'if-none-match': tag } })).status).toBe(304)
    await star(person, 'box', 'e')
    expect((await person('/v1/entities?blueprint=box&sort=size', { headers: { 'if-none-match': tag } })).status).toBe(200)
  })

  it('are marked on the entity page', async () => {
    await star(person, 'box', 'a')
    expect((await json<EntityPageResponse>(await person('/v1/entities/box/a'))).starred).toBe(true)
    expect((await json<EntityPageResponse>(await person('/v1/entities/box/b'))).starred).toBeUndefined()
    expect((await json<EntityPageResponse>(await other('/v1/entities/box/a'))).starred).toBeUndefined()
  })

  it('are listed alone across every blueprint', async () => {
    await star(person, 'box', 'c')
    await star(person, 'pipe', 'p1')
    expect((await keys(person, 'starred=true')).sort()).toEqual(['c', 'p1'])
    expect(await keys(person, 'blueprint=box&starred=true')).toEqual(['c'])
  })

  it('never reach what the person may not see, and one kept from before is neither shown nor counted', async () => {
    expect((await star(person, 'vault', 'v1')).status).toBe(404)
    expect((await star(person, 'box', 'nothing')).status).toBe(404)
    // A star from when they could see it.
    await hub.db.query("INSERT INTO stars (person, blueprint, key) VALUES ($1, 'vault', 'v1')", [PERSON])
    await star(person, 'box', 'a')
    expect(await starred(person)).toEqual(['box:a'])
    const table = await json<QueryResult>(await person('/v1/mine/stars/table'))
    expect(Object.keys(table.counts)).toEqual(['box'])
    expect(await keys(person, 'starred=true')).toEqual(['a'])
    expect((await hub.db.query('SELECT 1 FROM stars WHERE person = $1', [PERSON])).rowCount).toBe(2)
  })

  it('make one table of every favorite, each blueprint a source and its fields columns', async () => {
    await star(person, 'box', 'b')
    await star(person, 'pipe', 'p2')
    const table = await json<QueryResult>(await person('/v1/mine/stars/table'))
    expect(table.counts).toEqual({ box: 1, pipe: 1 })
    expect(table.columns.map((c) => c.id)).toEqual(expect.arrayContaining(['$type', 'title', 'size', 'colour', 'length', '$status']))
    expect(table.rows).toHaveLength(2)
  })

  it('never order a query: what a query reads is the same for everyone', async () => {
    const spec = { sources: [{ blueprint: 'box', clauses: [] }], columns: ['title', 'size'] }
    const before = await json<QueryResult>(await person('/v1/query', post(spec)))
    await star(person, 'box', 'e')
    await star(person, 'box', 'c')
    const after = await json<QueryResult>(await person('/v1/query', post(spec)))
    expect(after.rows).toEqual(before.rows)
  })

  it('go when the hub purges what they name, and nowhere else', async () => {
    await star(person, 'pipe', 'p1')
    await star(person, 'pipe', 'p2')
    await hub.db.query("UPDATE entities SET state = 'deleted', deleted_at = now() - interval '200 days' WHERE blueprint = 'pipe' AND key = 'p1'")
    // A tombstone still holds its star.
    expect((await hub.db.query("SELECT 1 FROM stars WHERE key = 'p1'")).rowCount).toBe(1)
    await hub.runs.purge(90)
    expect((await hub.db.query<{ key: string }>('SELECT key FROM stars WHERE person = $1', [PERSON])).rows.map((r) => r.key)).toEqual(['p2'])
  })

  it("are for a person, and a personal token is the person: a machine keeps none, and its grid has no stars first", async () => {
    await star(person, 'box', 'e')
    const issued = await json<TokenIssued>(await person('/v1/me/tokens', post({ name: 'agent' })))
    expect(await starred(bearer(issued.token))).toEqual(['box:e'])
    const machine = bearer((await hub.sources.issueToken('access', 'machine', { role: 'reader' })).token)
    expect((await machine('/v1/mine/stars')).status).toBe(403)
    expect((await machine('/v1/mine/stars/box/a', put())).status).toBe(403)
    expect(await keys(machine, 'blueprint=box&sort=-size')).toEqual(['e', 'd', 'c', 'b', 'a'])
  })
})

describe('a blueprint pinned to the catalog', () => {
  it('is pinned and let go like an action, and only where the person sees it', async () => {
    expect((await person('/v1/mine/pins/blueprint/pipe', put())).status).toBe(200)
    expect((await person('/v1/mine/pins/blueprint/vault', put())).status).toBe(404)
    expect((await json<PinsResponse>(await person('/v1/mine/pins'))).pins).toEqual([{ kind: 'blueprint', id: 'pipe' }])
    expect((await person('/v1/mine/pins/blueprint/pipe', { method: 'DELETE' })).status).toBe(200)
    expect((await json<PinsResponse>(await person('/v1/mine/pins'))).pins).toEqual([])
  })

  it('follows its blueprint when it is renamed, and so do the stars of its entities', async () => {
    await admin('/v1/blueprints/tube', put({ id: 'tube', title: 'Tube', fields: {}, relations: {} }))
    await admin('/v1/entities', post({ blueprint: 'tube', key: 't1', title: 't1', fields: {} }))
    await person('/v1/mine/pins/blueprint/tube', put())
    await star(person, 'tube', 't1')
    expect((await admin('/v1/blueprints/tube/rename', post({ to: 'hose' }))).status).toBe(200)
    expect((await json<PinsResponse>(await person('/v1/mine/pins'))).pins).toEqual([{ kind: 'blueprint', id: 'hose' }])
    expect(await starred(person)).toEqual(['hose:t1'])
  })
})

describe('what stars cost, on the Load page', () => {
  /** Every statement the hub sends while `fn` runs. */
  const sent = async (fn: () => unknown): Promise<string[]> => {
    const statements: string[] = []
    const query = hub.db.query.bind(hub.db)
    hub.db.query = ((...args: Parameters<typeof query>) => (statements.push(String(args[0])), query(...args))) as typeof hub.db.query
    try {
      await fn()
    } finally {
      hub.db.query = query
    }
    return statements
  }

  it('counts each grid read a reader’s stars ordered, the rows it marked, and what each kind holds now', async () => {
    await star(person, 'box', 'b')
    await star(person, 'box', 'd')
    await star(other, 'box', 'd')
    await hub.load.flush()
    const before = (await json<LoadResponse>(await admin('/v1/load?hours=1'))).stars?.find((r) => r.blueprint === 'box')
    await person('/v1/entities?blueprint=box&sort=size&distribution=later')
    await person('/v1/entities?blueprint=box&sort=-size')
    const box = (await json<LoadResponse>(await admin('/v1/load?hours=1'))).stars?.find((r) => r.blueprint === 'box')
    expect(box).toMatchObject({ stars: 3, people: 2 })
    expect(box!.reads - (before?.reads ?? 0)).toBe(2)
    expect(box!.marked - (before?.marked ?? 0)).toBe(4)
    expect(box!.ms).toBeGreaterThan(0)
  })

  it('orders and marks nothing for a reader who starred nothing there, and notes no read', async () => {
    await star(person, 'pipe', 'p1')
    await hub.load.flush()
    const before = (await json<LoadResponse>(await admin('/v1/load?hours=1'))).stars?.find((r) => r.blueprint === 'box')?.reads ?? 0
    const statements = await sent(() => person('/v1/entities?blueprint=box&sort=size&distribution=later'))
    expect(statements.filter((s) => s.includes('FROM stars s'))).toEqual([])
    expect((await json<LoadResponse>(await admin('/v1/load?hours=1'))).stars?.find((r) => r.blueprint === 'box')?.reads ?? 0).toBe(before)
    expect(await keys(person, 'blueprint=box&sort=size')).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('lists every kind that holds stars or had a grid ordered by them, the most time first', () => {
    const rows = starsLoad([{ blueprint: 'box', reads: 4, marked: 6, ms: 12 }, { blueprint: 'gone', reads: 1, marked: 1, ms: 30 }], new Map([['box', { stars: 3, people: 2 }], ['pipe', { stars: 5, people: 1 }]]))
    expect(rows).toEqual([
      { blueprint: 'gone', reads: 1, marked: 1, ms: 30, stars: 0, people: 0 },
      { blueprint: 'box', reads: 4, marked: 6, ms: 12, stars: 3, people: 2 },
      { blueprint: 'pipe', reads: 0, marked: 0, ms: 0, stars: 5, people: 1 },
    ])
  })
})
