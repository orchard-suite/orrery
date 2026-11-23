import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { BulkEditResponse, EntitiesResponse } from '../shared/api.ts'
import { loadConfig } from './config.ts'
import { createHub, type Hub } from './hub.ts'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://orrery:orrery@localhost:5433/orrery'

let hub: Hub
const session = (path: string, init?: RequestInit) => hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', ...init?.headers } }, { surface: 'session' })
const json = async <T,>(r: Response): Promise<T> => {
  expect(r.status, await r.clone().text()).toBe(200)
  return (await r.json()) as T
}
const body = (v: unknown) => ({ body: JSON.stringify(v) })
const grid = async (query: string) => json<EntitiesResponse>(await session(`/v1/entities?blueprint=crate&distribution=true&${query}`))
const ROWS = 450
const pad = (i: number) => String(i).padStart(3, '0')

beforeAll(async () => {
  hub = await createHub(loadConfig({ DATABASE_URL, DATA_DIR: mkdtempSync(join(tmpdir(), 'orrery-')), AUTH_MODE: 'none' }), 'test', { reset: true })
  const put = await session('/v1/blueprints/crate', { method: 'PUT', ...body({ title: 'Crate', fields: { size: { type: 'enum', values: ['s', 'm', 'l'] }, rank: { type: 'number' } } }) })
  expect(put.status, await put.clone().text()).toBe(200)
  for (let i = 0; i < ROWS; i++) {
    const made = await session('/v1/entities', { method: 'POST', ...body({ blueprint: 'crate', key: `c${pad(i)}`, title: `Crate ${pad(i)}`, fields: { size: ['s', 'm', 'l'][i % 3], rank: i } }) })
    expect(made.status).toBe(201)
  }
}, 120_000)

afterAll(async () => {
  await hub.close()
})

describe('a grid scrolling a long list', () => {
  it('sends any block of the sorted rows, with the counts of all of them', async () => {
    const first = await grid('sort=rank&limit=100&offset=0')
    expect(first.total).toBe(ROWS)
    expect(first.entities.map((e) => e.key)).toEqual(Array.from({ length: 100 }, (_, i) => `c${pad(i)}`))
    expect(first.distribution?.['f:size']?.buckets.map((b) => b.count)).toEqual([150, 150, 150])
    const deep = await grid('sort=rank&limit=100&offset=400')
    expect(deep.entities.map((e) => e.key)).toEqual(Array.from({ length: 50 }, (_, i) => `c${pad(400 + i)}`))
    // Both blocks are slices of one kept listing.
    expect(deep.version).toBe(first.version)
  })

  it('sends the rows without the counts, and the counts without the rows, of the same listing', async () => {
    const rows = await json<EntitiesResponse>(await session('/v1/entities?blueprint=crate&distribution=later&sort=rank&limit=100&offset=0'))
    expect(rows.entities).toHaveLength(100)
    expect(rows.total).toBe(ROWS)
    expect(rows).not.toHaveProperty('distribution')
    const counts = await json<EntitiesResponse>(await session('/v1/entities?blueprint=crate&distribution=only&sort=rank'))
    expect(counts.entities).toEqual([])
    expect(counts.total).toBe(ROWS)
    expect(counts.distribution?.['f:size']?.buckets.map((b) => b.count)).toEqual([150, 150, 150])
    expect(counts.version).toBe(rows.version)
  })

  it('reads a block of a kept listing without counting the list again, and a cold one beside its count', async () => {
    const asked = '/v1/entities?blueprint=crate&distribution=later&sort=rank&limit=100'
    await session(`${asked}&offset=0`)
    const statements: string[] = []
    const query = hub.db.query.bind(hub.db)
    hub.db.query = ((...args: Parameters<typeof query>) => (statements.push(String(args[0])), query(...args))) as typeof hub.db.query
    try {
      const deeper = await json<EntitiesResponse>(await session(`${asked}&offset=100`))
      expect(deeper.entities[0]!.key).toBe('c100')
      expect(deeper.total).toBe(ROWS)
      // The reader's stars name the grid's tag, and are counted apart from the list.
      expect(statements.filter((s) => s.includes('count(*)') && !s.includes('FROM stars'))).toEqual([])
      // Built cold: the rows and the count are both asked before either answers.
      hub.lists.changed()
      statements.length = 0
      let open = 0
      let most = 0
      hub.db.query = ((...args: Parameters<typeof query>) => {
        statements.push(String(args[0]))
        if (!String(args[0]).includes('ORDER BY') && !String(args[0]).includes('count(*)')) return query(...args)
        most = Math.max(most, ++open)
        return query(...args).finally(() => open--)
      }) as typeof hub.db.query
      const cold = await json<EntitiesResponse>(await session(`${asked}&offset=0`))
      expect(cold.entities[0]!.key).toBe('c000')
      expect(cold.total).toBe(ROWS)
      expect(most).toBeGreaterThan(1)
    } finally {
      hub.db.query = query
    }
  })

  it('gives the last count while the next is slow to build, untagged, with rows read fresh, and the next once built', async () => {
    const asked = '/v1/entities?blueprint=crate&distribution=later&sort=rank&limit=1&offset=0'
    const before = await json<EntitiesResponse>(await session(asked))
    expect(before.total).toBe(ROWS)
    const rows = hub.reader.sql.rows.bind(hub.reader.sql)
    let release: () => void = () => undefined
    const held = new Promise<void>((done) => (release = done))
    hub.reader.sql.rows = (async (...args: Parameters<typeof rows>) => (await held, rows(...args))) as typeof rows
    try {
      expect((await session('/v1/entities', { method: 'POST', ...body({ blueprint: 'crate', key: 'a-new', title: 'A new crate', fields: { size: 's', rank: -1 } }) })).status).toBe(201)
      const late = await session(asked)
      expect(late.headers.get('etag')).toBeNull()
      const behind = await json<EntitiesResponse>(late)
      expect(behind.total).toBe(ROWS)
      expect(behind.entities[0]!.key).toBe('a-new')
      release()
      await new Promise((done) => setTimeout(done, 50))
      const after = await session(asked)
      expect(after.headers.get('etag')).not.toBeNull()
      expect((await json<EntitiesResponse>(after)).total).toBe(ROWS + 1)
    } finally {
      release()
      hub.reader.sql.rows = rows
      await session('/v1/entities/crate/a-new', { method: 'DELETE' })
    }
  })

  it('names a new version once anything changes, and the next block reads it', async () => {
    const before = await grid('sort=rank&limit=1')
    const edited = await session('/v1/entities/crate/c000', { method: 'PATCH', ...body({ fields: { rank: 1000 } }) })
    expect(edited.status).toBe(200)
    const after = await grid('sort=rank&limit=1')
    expect(after.version).toBeGreaterThan(before.version!)
    expect(after.entities[0]!.key).toBe('c001')
    await session('/v1/entities/crate/c000', { method: 'PATCH', ...body({ fields: { rank: 0 } }) })
  })

  it('groups every matching row, not one page of them', async () => {
    const res = await grid(`group=size&sort=rank&limit=5&filter=${encodeURIComponent(JSON.stringify({ field: 'rank', op: 'lt', value: 300 }))}`)
    expect(res.total).toBe(300)
    expect(res.groups).toEqual([
      { key: 'l', start: 0, count: 100 },
      { key: 'm', start: 100, count: 100 },
      { key: 's', start: 200, count: 100 },
    ])
    // Rows run group by group, each in the asked order.
    expect(res.entities.map((e) => e.fields.size)).toEqual(['l', 'l', 'l', 'l', 'l'])
    expect(res.entities.map((e) => e.fields.rank)).toEqual([2, 5, 8, 11, 14])
  })

  it('names every row a filter matches, for ticking them all', async () => {
    const filter = encodeURIComponent(JSON.stringify({ field: 'size', op: 'eq', value: 'm' }))
    const res = await json<{ refs: { key: string }[] }>(await session(`/v1/entities/refs?blueprint=crate&filter=${filter}`))
    expect(res.refs).toHaveLength(150)
  })

  it('changes and deletes every row a filter matches but the ones left out', async () => {
    const filter = { field: 'size', op: 'eq', value: 's' }
    const query = { blueprint: 'crate', filter, except: [{ blueprint: 'crate', key: 'c000' }] }
    const edited = await json<BulkEditResponse>(await session('/v1/entities/bulk', { method: 'POST', ...body({ query, fields: { rank: -1 } }) }))
    expect(edited).toEqual({ changed: 149, refused: [] })
    const lowest = await grid('sort=rank&limit=150')
    expect(lowest.entities.filter((e) => e.fields.rank === -1)).toHaveLength(149)
    const deleted = await json<BulkEditResponse>(await session('/v1/entities/delete', { method: 'POST', ...body({ query }) }))
    expect(deleted.changed).toBe(149)
    expect((await grid('limit=1')).total).toBe(ROWS - 149)
    expect((await session('/v1/entities/crate/c000')).status).toBe(200)
  })

  it('refuses a bulk change that names both rows and a filter', async () => {
    const res = await session('/v1/entities/bulk', { method: 'POST', ...body({ entities: [{ blueprint: 'crate', key: 'c001' }], query: { blueprint: 'crate' }, fields: { rank: 1 } }) })
    expect(res.status).toBe(400)
  })
})

describe('what a change drops', () => {
  it('keeps a listing when another blueprint moves, and drops it when its own does', async () => {
    const put = await session('/v1/blueprints/shelf', { method: 'PUT', ...body({ title: 'Shelf', fields: { size: { type: 'string' } } }) })
    expect(put.status, await put.clone().text()).toBe(200)
    expect((await session('/v1/entities', { method: 'POST', ...body({ blueprint: 'shelf', key: 's1', title: 'Shelf 1' }) })).status).toBe(201)
    const before = await grid('limit=1')
    // A shelf has nothing to do with crates: their list is kept.
    expect((await session('/v1/entities/shelf/s1', { method: 'PATCH', ...body({ fields: { size: 'big' } }) })).status).toBe(200)
    expect((await grid('limit=1')).version).toBe(before.version)
    // A crate moved: their list is read again.
    expect((await session('/v1/entities/crate/c001', { method: 'PATCH', ...body({ fields: { rank: 7 } }) })).status).toBe(200)
    expect((await grid('limit=1')).version).toBeGreaterThan(before.version!)
  })

  it('drops a listing when the title of what its rows point at moves', async () => {
    const put = await session('/v1/blueprints/crate', { method: 'PUT', ...body({ title: 'Crate', fields: { size: { type: 'enum', values: ['s', 'm', 'l'] }, rank: { type: 'number' } }, relations: { shelf: { target: 'shelf' } } }) })
    expect(put.status, await put.clone().text()).toBe(200)
    const before = await grid('limit=1')
    // A value nobody shows beside a crate keeps the list.
    expect((await session('/v1/entities/shelf/s1', { method: 'PATCH', ...body({ fields: { size: 'small' } }) })).status).toBe(200)
    expect((await grid('limit=1')).version).toBe(before.version)
    // A crate shows its shelf's title, so a renamed shelf drops it.
    expect((await session('/v1/entities/shelf/s1', { method: 'PATCH', ...body({ fields: { title: 'Top shelf' } }) })).status).toBe(200)
    expect((await grid('limit=1')).version).toBeGreaterThan(before.version!)
  })

  it('tells the first block what its list reads', async () => {
    expect((await grid('limit=1')).reads).toEqual(['crate'])
    expect((await grid('limit=1&offset=1')).reads).toBeUndefined()
  })
})

describe('a page a person glances at', () => {
  /** A build whose answer comes when the test says. */
  const later = <T,>() => {
    let give!: (value: T) => void
    const value = new Promise<T>((done) => (give = done))
    return { value, give }
  }
  const moved = () => hub.events.emit({ type: 'entity', blueprint: 'crate', key: 'c000' })

  it('gives the last answer while the next builds after an offer adds to the model, and waits for its own after any other model change', async () => {
    const basis = {}
    const slow = later<string>()
    const ask = (build: () => Promise<string>) => hub.lists.recent('front', 'offer-reader@example.org', basis, build, { ages: false })
    expect(await ask(async () => 'first')).toBe('first')
    hub.events.emit({ type: 'blueprints', offered: ['crate'] })
    expect(await ask(() => slow.value)).toBe('first')
    slow.give('second')
    await new Promise((done) => setTimeout(done, 10))
    expect(await ask(async () => 'unused')).toBe('second')
    hub.events.emit({ type: 'blueprints' })
    const own = later<string>()
    const waited = ask(() => own.value)
    own.give('third')
    expect(await waited).toBe('third')
  })

  it('lets go of the least recently asked page when too many are kept, never one still in use', async () => {
    const basis = {}
    let builds = 0
    const front = () => hub.lists.recent('front', 'in-use@example.org', basis, async () => ++builds, { ages: false })
    expect(await front()).toBe(1)
    for (let i = 0; i < 100; i++) {
      await hub.lists.recent('front', `passer-${i}@example.org`, basis, async () => i, { ages: false })
      if (i % 10 === 0) expect(await front()).toBe(1)
    }
    expect(await front()).toBe(1)
    expect(builds).toBe(1)
  })

  it('gives the last answer while the next is slow to build, and the next once it is built', async () => {
    const basis = {}
    expect(await hub.lists.recent('glance', 'a', basis, async () => 'first')).toBe('first')
    moved()
    const slow = later<string>()
    expect(await hub.lists.recent('glance', 'a', basis, () => slow.value)).toBe('first')
    slow.give('second')
    expect(await hub.lists.recent('glance', 'a', basis, async () => 'never asked')).toBe('second')
  })

  it('waits for the next answer when it comes in time', async () => {
    const basis = {}
    await hub.lists.recent('quick', 'a', basis, async () => 'first')
    moved()
    expect(await hub.lists.recent('quick', 'a', basis, async () => 'second')).toBe('second')
  })

  it('never gives an answer built for what the reader saw before', async () => {
    await hub.lists.recent('seen', 'a', {}, async () => 'before')
    moved()
    const slow = later<string>()
    const asked = hub.lists.recent('seen', 'a', {}, () => slow.value)
    setTimeout(() => slow.give('after'), 400)
    expect(await asked).toBe('after')
  })

  it('is told a source reported only when it reads what a source says of itself, or may read anything', async () => {
    const basis = {}
    let builds = 0
    const page = (what: string, reads?: string[]) => hub.lists.recent(what, 'a', basis, async () => ++builds, { ages: false, ...(reads ? { reads: () => reads } : {}) })
    const crates = await page('crates', ['crate'])
    const standing = await page('standing', ['orrery_source'])
    const anything = await page('anything')
    hub.events.emit({ type: 'sources' })
    expect(await page('crates', ['crate'])).toBe(crates)
    expect(await page('standing', ['orrery_source'])).toBeGreaterThan(standing)
    expect(await page('anything')).toBeGreaterThan(anything)
  })

  it('takes an answer a minute old as stale though nothing moved', async () => {
    const basis = {}
    expect(await hub.lists.recent('aged', 'a', basis, async () => 'first')).toBe('first')
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 61_000)
    try {
      expect(await hub.lists.recent('aged', 'a', basis, async () => 'second')).toBe('second')
    } finally {
      clock.mockRestore()
    }
  })

  it('gives no last answer once the model or access changes', async () => {
    const basis = {}
    await hub.lists.recent('model', 'a', basis, async () => 'before')
    hub.events.emit({ type: 'access' })
    const slow = later<string>()
    const asked = hub.lists.recent('model', 'a', basis, () => slow.value)
    setTimeout(() => slow.give('after'), 400)
    expect(await asked).toBe('after')
  })
})
