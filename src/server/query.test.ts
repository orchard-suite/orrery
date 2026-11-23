// The SQL read path against the reference: for every kind of filter leaf,
// sort, group, and distribution, over a generated estate and two readers,
// what `query.ts` answers equals what `matches`, `compare`, `groupKey`, and
// `distribute` answer over the hydrated, viewed entities. A difference is a
// leak or a wrong row, and fails here first.

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { compare, fieldOf, matches, neighbourWheres, orderable, whereSets } from '../shared/filter.ts'
import { SHARED_LIST_MAX, type Entity, type EntityState, type Filter } from '../shared/model.ts'
import { loadConfig } from './config.ts'
import { createHub, type Hub } from './hub.ts'
import { groupKey } from './lists.ts'
import { ALL, type ListParams, type Sight } from './query.ts'
import { distribute, JOIN, JOINED, type JoinedRow } from './read.ts'
import type { View } from './visibility.ts'

// Its own database: it sets who a signed-in person is.
const DATABASE_URL = (process.env.DATABASE_URL ?? 'postgres://orrery:orrery@localhost:5433/orrery') + '_query'

let hub: Hub
let adminView: View
let personView: View

const as = (email: string, groups = 'User') => (path: string, init?: RequestInit) =>
  hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', 'x-forwarded-email': email, 'x-forwarded-groups': groups, ...init?.headers } }, { surface: 'session' })
const admin = as('admin@example.org', 'Admin')
const put = (v: unknown) => ({ method: 'PUT', body: JSON.stringify(v) })
const post = (v: unknown) => ({ method: 'POST', body: JSON.stringify(v) })

const COLLATOR = new Intl.Collator('en', { numeric: true })
const DAY = 86_400_000

/** A small deterministic generator, so a run that differs can be replayed. */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

beforeAll(async () => {
  const pg = await import('pg').then(({ default: m }) => new m.Client({ connectionString: DATABASE_URL.replace(/\/[^/]+$/, '/postgres') }))
  await pg.connect()
  await pg.query(`DROP DATABASE IF EXISTS ${DATABASE_URL.split('/').pop()}`)
  await pg.query(`CREATE DATABASE ${DATABASE_URL.split('/').pop()}`)
  await pg.end()
  hub = await createHub(loadConfig({ DATABASE_URL, DATA_DIR: mkdtempSync(join(tmpdir(), 'orrery-')), AUTH_MODE: 'proxy', DERIVE_INLINE_MAX: '500' }), 'test', { reset: true })

  const save = async (id: string, spec: Record<string, unknown>) => expect((await admin(`/v1/blueprints/${id}`, put({ id, ...spec }))).status).toBe(200)
  await save('team', { title: 'Team', fields: {}, relations: {} })
  // A blueprint the person may not see: its titles must never be matched or shown to them.
  await save('vault', { title: 'Vault', fields: { code: { type: 'string' } }, relations: {}, access: { grants: [{ path: 'team', values: ['platform'] }] } })
  await save('thing', {
    title: 'Thing',
    fields: {
      str: { type: 'string' },
      num: { type: 'number' },
      flag: { type: 'boolean' },
      tags: { type: 'array' },
      meta: { type: 'object' },
      when: { type: 'datetime' },
      level: { type: 'enum', values: ['low', 'mid', 'high'] },
      // Withheld from everyone but the platform team; the calculation reads it, so it is withheld with it.
      secret: { type: 'string', access: { grants: [{ path: 'team', values: ['platform'] }] } },
      secret_len: { type: 'number', calculation: 'secret != null ? 1 : 0' },
      peers_count: { type: 'number', aggregation: { relation: 'peer', fn: 'count' } },
    },
    relations: { peer: { target: 'thing', many: true }, vault: { target: 'vault' }, team: { target: 'team', many: true } },
  })
  await save('person', { title: 'Person', fields: {}, relations: { team: { target: 'team', many: true } } })
  expect((await admin('/v1/access/person', put({ blueprint: 'person' }))).status).toBe(200)
  expect(
    (
      await admin(
        '/v1/scorecards/sized',
        put({ blueprint: 'thing', title: 'Sized', levels: [{ name: 'Bronze', rules: [{ id: 'some', title: 'Some', where: { field: 'num', op: 'gte', value: 10 } }] }, { name: 'Silver', rules: [{ id: 'lots', title: 'Lots', where: { field: 'num', op: 'gte', value: 50 } }] }] }),
      )
    ).status,
  ).toBe(200)

  const create = async (blueprint: string, key: string, title: string, fields: Record<string, unknown> = {}, relations: Record<string, unknown> = {}) =>
    expect((await admin('/v1/entities', post({ blueprint, key, title, fields, relations }))).status, `${blueprint}:${key}`).toBe(201)
  await create('team', 'platform', 'Platform')
  await create('team', 'sales', 'Sales')
  await create('person', 'ada@example.org', 'Ada', {}, { team: ['sales'] })
  for (const v of ['v1', 'v2']) await create('vault', v, `Vault ${v.toUpperCase()}`, { code: `code-${v}` })

  const r = rng(7)
  const pick = <T>(list: T[]): T => list[Math.floor(r() * list.length)]!
  const titles = ['thing-2', 'thing-10', 'Thing-1', 'Éclair', 'apple', 'Apple', 'z-9.10', 'z-9.9', 'b 1', 'b 01']
  for (let i = 0; i < 60; i++) {
    const fields: Record<string, unknown> = {}
    if (r() > 0.2) fields.str = pick(['alpha', 'Beta', 'gamma ray', 'δelta', 'x-1', 'x-10', 'x-2', '', 'needle in hay'])
    if (r() > 0.2) fields.num = pick([0, 1, 1.5, 2, 10, 10.5, 50, 99, -3, 1e6])
    if (r() > 0.3) fields.flag = r() > 0.5
    if (r() > 0.3) fields.tags = Array.from({ length: Math.floor(r() * 4) }, () => pick(['a', 'b', 'c', 'needle', 'd']))
    if (r() > 0.5) fields.meta = { k: pick(['needle', 'other']), n: Math.floor(r() * 5), deep: { leaf: pick(['hay', 'needle']) } }
    if (r() > 0.3) fields.when = new Date(Date.now() - Math.floor(r() * 90) * DAY).toISOString()
    if (r() > 0.3) fields.level = pick(['low', 'mid', 'high'])
    if (r() > 0.5) fields.secret = pick(['hush', 'needle hush', 'quiet'])
    const relations: Record<string, unknown> = {}
    if (i > 0 && r() > 0.4) relations.peer = [...new Set(Array.from({ length: 1 + Math.floor(r() * 3) }, () => `t${Math.floor(r() * i)}`))]
    if (r() > 0.6) relations.vault = pick(['v1', 'v2'])
    if (r() > 0.6) relations.team = [pick(['platform', 'sales'])]
    await create('thing', `t${i}`, `${pick(titles)} ${i}`, fields, relations)
  }
  // A few hidden, and one missing, so states and hiding are in play.
  for (const k of ['t3', 't4']) expect((await admin(`/v1/entities/thing/${k}`, { method: 'PATCH', body: JSON.stringify({ hidden: true }) })).status).toBe(200)
  await hub.db.query(`UPDATE entities SET state = 'missing', missing_since = now() WHERE blueprint = 'thing' AND key = 't5'`)
  await hub.deriver.enqueue(hub.db, [{ blueprint: 'thing', key: 't5' }])
  while ((await hub.deriver.depth()) > 0) await hub.deriver.drain()

  adminView = await hub.visibility.view({ kind: 'user', name: 'admin@example.org', admin: true, roles: [], permissions: [] })
  personView = await hub.visibility.view({ kind: 'user', name: 'ada@example.org', admin: false, roles: [], permissions: [] })
  expect(personView.hiddenFields('thing').has('secret')).toBe(true)
  expect(personView.seesBlueprint('vault')).toBe(false)
})

afterAll(async () => {
  await hub.close()
})

/** Every row of the blueprints, hydrated as the hub reads them, nobody's view yet. */
async function everything(): Promise<Entity[]> {
  const rows = await hub.db.query<JoinedRow>(`SELECT ${JOINED} ${JOIN} WHERE e.state <> 'deleted' ORDER BY e.blueprint, e.title, e.key`)
  return hub.reader.derive(rows.rows)
}

/** The ids `matches` and `compare` give for a question, over the viewed entities: the reference the SQL must equal. */
async function reference(p: ListParams, view: View): Promise<{ ids: string[]; entities: Entity[] }> {
  const all = await everything()
  let list = all.filter((e) => p.states.includes(e.state as EntityState) && (p.includeHidden || !e.hidden) && (!p.blueprint || e.blueprint === p.blueprint))
  if (p.filter) {
    // Who points at each entity, as `attachIncoming` gives it, for a filter that asks.
    for (const e of list) e.incomingRefs = undefined
    const copies = list.map((e) => ({ ...e }))
    await hub.reader.attachIncoming(copies)
    list = copies
  }
  list = view.all ? list : view.entities(list)
  if (p.filter) {
    const related = new Map<string, Set<string>>()
    const walk = async (f: Filter): Promise<void> => {
      if ('and' in f) for (const x of f.and) await walk(x)
      else if ('or' in f) for (const x of f.or) await walk(x)
      else if ('not' in f) await walk(f.not)
      else if ('relatedTo' in f) {
        const [b, k] = f.relatedTo.split(':')
        const rows = await hub.db.query<{ blueprint: string; key: string }>(
          `SELECT blueprint, key FROM relations WHERE target_blueprint = $1 AND target_key = $2 UNION SELECT target_blueprint, target_key FROM relations WHERE blueprint = $1 AND key = $2`,
          [b, k],
        )
        related.set(f.relatedTo, new Set(rows.rows.map((x) => `${x.blueprint}:${x.key}`)))
      }
    }
    await walk(p.filter)
    // What a relation reaches is judged on every entity the reader sees, as they see it, of any state but deleted: the stored rows the SQL reads.
    let sets = related
    if (neighbourWheres(p.filter).length) {
      const reachable = (await everything()).map((e) => ({ ...e, incomingRefs: undefined }))
      await hub.reader.attachIncoming(reachable)
      sets = whereSets(p.filter, view.all ? reachable : view.entities(reachable), related)
    }
    list = list.filter((e) => matches(e, p.filter!, sets))
  }
  const tie = (a: Entity, b: Entity) => a.blueprint.localeCompare(b.blueprint) || COLLATOR.compare(a.title, b.title) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  if (p.sort) {
    const desc = p.sort.startsWith('-')
    const name = desc ? p.sort.slice(1) : p.sort
    list.sort((a, b) => {
      const x = fieldOf(a, name)
      const y = fieldOf(b, name)
      const c = compare(x, y)
      // Unset last whichever way; everything else flips with the direction.
      const r = !orderable(x) || !orderable(y) ? c : desc ? -c : c
      return r || tie(a, b)
    })
  } else list.sort(tie)
  if (p.group) {
    const keys = [...new Set(list.map((e) => groupKey(e, p.group!)))].sort((a, b) => (a === '—' ? 1 : b === '—' ? -1 : COLLATOR.compare(a, b)))
    const at = new Map(keys.map((k, i) => [k, i]))
    list.sort((a, b) => at.get(groupKey(a, p.group!))! - at.get(groupKey(b, p.group!))!)
  }
  return { ids: list.map((e) => e.id), entities: list }
}

async function sqlIds(p: ListParams, view: View): Promise<string[]> {
  const sight: Sight = view.all ? ALL : view
  const { rows } = await hub.reader.sql.rows(p, sight, { limit: Infinity, offset: 0 })
  return rows.map((r) => `${r.blueprint}:${r.key}`)
}

const base = (extra: Partial<ListParams> = {}): ListParams => ({ blueprint: 'thing', states: ['active', 'missing'], includeHidden: false, ...extra })

async function same(p: ListParams, view: View, label: string): Promise<void> {
  const ref = await reference(p, view)
  const got = await sqlIds(p, view)
  expect(got, label).toEqual(ref.ids)
}

const readers = () => [
  ['admin', adminView],
  ['person', personView],
] as const

describe('the SQL read path equals the reference', () => {
  it('lists, with states and hidden rows', async () => {
    for (const [who, view] of readers()) {
      await same(base(), view, `${who} plain`)
      await same(base({ includeHidden: true }), view, `${who} hidden`)
      await same(base({ states: ['missing'] }), view, `${who} missing`)
      await same({ states: ['active'], includeHidden: false }, view, `${who} every blueprint`)
    }
  })

  it('searches the key, the title, and the visible field values', async () => {
    for (const [who, view] of readers()) {
      for (const q of ['needle', 'NEEDLE', 'hay', 'thing-1', 'x-1', '1.5', 'true', 'hush', 'δ', 'é', 'z-9', 't1', ' ', '%', '_']) {
        await same(base({ filter: { search: q } }), view, `${who} search ${JSON.stringify(q)}`)
        await same({ states: ['active'], includeHidden: false, filter: { search: q } }, view, `${who} search all ${JSON.stringify(q)}`)
      }
    }
  })

  it('never finds a withheld value by search', async () => {
    const got = await sqlIds(base({ filter: { search: 'hush' } }), personView)
    expect(got).toEqual([])
    expect((await sqlIds(base({ filter: { search: 'hush' } }), adminView)).length).toBeGreaterThan(0)
  })

  it('compares fields op by op', async () => {
    const leaves: Filter[] = [
      { field: 'str', op: 'exists' },
      { field: 'str', op: 'eq', value: 'alpha' },
      { field: 'str', op: 'eq', value: null },
      { field: 'str', op: 'neq', value: 'alpha' },
      { field: 'str', op: 'in', value: ['alpha', 'Beta', 'x-1'] },
      { field: 'str', op: 'contains', value: 'ETA' },
      { field: 'str', op: 'prefix', value: 'x-' },
      { field: 'str', op: 'prefix', value: 'X-' },
      { field: 'str', op: 'gt', value: 'x-2' },
      { field: 'str', op: 'lte', value: 'gamma ray' },
      { field: 'num', op: 'gt', value: 1 },
      { field: 'num', op: 'gte', value: 10 },
      { field: 'num', op: 'lt', value: 10.5 },
      { field: 'num', op: 'lte', value: 0 },
      { field: 'num', op: 'eq', value: 1.5 },
      { field: 'num', op: 'in', value: [0, 99] },
      { field: 'num', op: 'gt', value: 'x' },
      { field: 'flag', op: 'eq', value: true },
      { field: 'flag', op: 'neq', value: true },
      { field: 'flag', op: 'gt', value: 'false' },
      { field: 'tags', op: 'contains', value: 'needle' },
      { field: 'tags', op: 'eq', value: [] },
      { field: 'tags', op: 'exists' },
      { field: 'tags', op: 'gt', value: 'a' },
      { field: 'meta', op: 'contains', value: 'k' },
      { field: 'meta', op: 'eq', value: { k: 'needle', n: 1, deep: { leaf: 'hay' } } },
      { field: 'when', op: 'within', value: '30d' },
      { field: 'when', op: 'older', value: '30d' },
      { field: 'when', op: 'within', value: 'soon' },
      { field: 'level', op: 'in', value: ['low', 'high'] },
      { field: 'peers_count', op: 'gte', value: 2 },
      { field: 'secret_len', op: 'eq', value: 1 },
      { field: '$title', op: 'prefix', value: 'thing' },
      { field: '$status', op: 'eq', value: 'green' },
      { field: '$owner', op: 'eq', value: 'ui' },
      { field: '$state', op: 'eq', value: 'missing' },
      { field: 'title', op: 'contains', value: 'apple' },
      { field: 'fields.num', op: 'gt', value: 50 },
      { field: 'nope', op: 'exists' },
      { field: '$createdAt', op: 'within', value: '1d' },
      { field: '$icon', op: 'exists' },
    ]
    for (const [who, view] of readers()) {
      for (const leaf of leaves) {
        // A leaf the reader may not ask is refused before SQL; the reference has nothing to say of it.
        if (view.refusedQuery('thing', leaf)) continue
        await same(base({ filter: leaf }), view, `${who} ${JSON.stringify(leaf)}`)
        await same({ states: ['active', 'missing'], includeHidden: false, filter: leaf }, view, `${who} all ${JSON.stringify(leaf)}`)
      }
    }
  })

  it('reads relations, in both directions, by id, key, and title', async () => {
    const leaves: Filter[] = [
      { relation: 'peer' },
      { relation: 'peer', target: 'thing:t1' },
      { relation: 'peer', target: 't2' },
      { relation: 'vault' },
      { relation: 'vault', target: 'Vault V1' },
      { relation: 'vault', target: 'v1' },
      { relation: 'team', target: 'Platform' },
      { relation: '<-peer' },
      { relation: '<-thing:peer', target: 'thing:t7' },
      { relation: '<-peer', target: 't7' },
      { relatedTo: 'thing:t1' },
      { relatedTo: 'vault:v1' },
      { relatedTo: 'team:platform' },
    ]
    for (const [who, view] of readers()) {
      for (const leaf of leaves) {
        if (view.refusedQuery('thing', leaf)) continue
        await same(base({ filter: leaf }), view, `${who} ${JSON.stringify(leaf)}`)
      }
    }
  })

  it('reads the values of what a relation reaches: any, every, and none of them, either way, at depth', async () => {
    const big: Filter = { field: 'num', op: 'gte', value: 10 }
    const leaves: Filter[] = [
      { relation: 'peer', where: big },
      { relation: 'peer', where: big, every: true },
      { not: { relation: 'peer', where: big } },
      { not: { relation: 'peer', where: big, every: true } },
      { relation: 'peer', where: { and: [] } },
      { relation: 'peer', where: { search: 'needle' } },
      { relation: 'peer', where: { field: 'when', op: 'within', value: '30d' } },
      { relation: 'peer', where: { scorecard: 'sized', op: 'gte', value: 'Bronze' } },
      { relation: 'peer', where: { field: 'secret', op: 'exists' } },
      { relation: 'peer', where: { relation: 'team', where: { field: '$title', op: 'eq', value: 'Platform' } } },
      { relation: 'peer', where: { relation: 'peer', where: big, every: true } },
      { relation: 'team', where: { field: '$title', op: 'eq', value: 'Sales' } },
      { relation: 'vault', where: { field: 'code', op: 'eq', value: 'code-v1' } },
      { relation: '<-peer', where: { field: 'flag', op: 'eq', value: true } },
      { relation: '<-thing:peer', where: big, every: true },
      { not: { relation: '<-thing:peer', where: { field: 'level', op: 'eq', value: 'high' } } },
    ]
    let asked = 0
    for (const [who, view] of readers()) {
      for (const leaf of leaves) {
        if (view.refusedQuery('thing', leaf)) continue
        asked++
        await same(base({ filter: leaf }), view, `${who} ${JSON.stringify(leaf)}`)
        await same({ states: ['active', 'missing'], includeHidden: true, filter: leaf }, view, `${who} all ${JSON.stringify(leaf)}`)
      }
    }
    expect(asked).toBeGreaterThan(leaves.length)
    // The cases tell rows apart: some match, every one is fewer than any, and none is the rest of what has a peer.
    const count = async (f: Filter) => (await sqlIds(base({ filter: f }), adminView)).length
    const any = await count(leaves[0]!)
    const every = await count(leaves[1]!)
    expect(any).toBeGreaterThan(0)
    expect(every).toBeLessThan(any)
    expect(await count({ and: [{ relation: 'peer' }, leaves[2]!] })).toBe((await count({ relation: 'peer' })) - any)
  })

  it('refuses a where on what a relation reaches that reads what the reader may not see', async () => {
    expect(personView.refusedQuery('thing', { relation: 'peer', where: { field: 'secret', op: 'exists' } })).toBe('secret')
    expect(personView.refusedQuery('thing', { relation: 'vault', where: { field: 'code', op: 'exists' } })).toBe('vault')
    expect(personView.refusedQuery(undefined, { relation: 'vault', where: { field: 'code', op: 'exists' } })).toBe('vault')
    expect(personView.refusedQuery('thing', { relation: 'peer', where: { relation: 'vault', where: { and: [] } } })).toBe('vault')
    expect(personView.refusedQuery('thing', { relation: 'peer', where: { field: 'num', op: 'gt', value: 1 } })).toBeNull()
    expect(adminView.refusedQuery('thing', { relation: 'vault', where: { field: 'code', op: 'exists' } })).toBeNull()
  })

  it('refuses a relation to a blueprint the reader may not see, set or not, and its grouping', async () => {
    expect(personView.refusedQuery('thing', { relation: 'vault' })).toBe('vault')
    expect(personView.refusedQuery('thing', { relation: 'vault', target: 'Vault V1' })).toBe('vault')
    expect(adminView.refusedQuery('thing', { relation: 'vault' })).toBeNull()
    expect((await sqlIds(base({ filter: { relation: 'vault', target: 'Vault V1' } }), adminView)).length).toBeGreaterThan(0)
  })

  it('reads scorecard levels', async () => {
    const leaves: Filter[] = ['exists', 'eq', 'neq', 'gte', 'gt', 'lt', 'lte'].flatMap((op) => ['Bronze', 'Silver', 'none'].map((value) => ({ scorecard: 'sized', op, value }) as Filter))
    leaves.push({ scorecard: 'sized', op: 'in', value: ['Bronze', 'none'] })
    for (const [who, view] of readers()) for (const leaf of leaves) await same(base({ filter: leaf }), view, `${who} ${JSON.stringify(leaf)}`)
  })

  it('combines with and, or, and not', async () => {
    const f: Filter = { and: [{ or: [{ field: 'num', op: 'gte', value: 10 }, { search: 'needle' }] }, { not: { relation: 'team' } }, { not: { state: 'missing' } }] }
    for (const [who, view] of readers()) await same(base({ filter: f }), view, `${who} combined`)
  })

  it('sorts every way the grid can', async () => {
    const sorts = ['str', '-str', 'num', '-num', 'flag', '-flag', 'tags', 'when', '-when', 'level', 'peers_count', '-peers_count', '$title', '-$title', 'title', '$status', '$createdAt', '-$key', 'meta', 'nope']
    for (const [who, view] of readers()) {
      for (const sort of sorts) {
        if (view.refusedQuery('thing', { field: sort.replace(/^-/, ''), op: 'exists' })) continue
        await same(base({ sort }), view, `${who} sort ${sort}`)
        await same(base({ sort, filter: { search: 'e' } }), view, `${who} sort ${sort} filtered`)
      }
      await same({ states: ['active'], includeHidden: false, sort: '-title' }, view, `${who} sort all`)
    }
  })

  it('groups the way lists.ts grouped, counts and order alike', async () => {
    for (const [who, view] of readers()) {
      for (const group of ['level', 'flag', 'tags', 'str', 'num', 'r:peer', 'r:vault', 'r:team', '$state', 'meta']) {
        if (view.refusedQuery('thing', group.startsWith('r:') ? { relation: group.slice(2) } : { field: group, op: 'exists' })) continue
        const p = base({ group, sort: 'num' })
        await same(p, view, `${who} group ${group}`)
        const ref = await reference(p, view)
        const counts = new Map<string, number>()
        for (const e of ref.entities) counts.set(groupKey(e, group), (counts.get(groupKey(e, group)) ?? 0) + 1)
        const got = await hub.reader.sql.groups(p, view.all ? ALL : view)
        expect(got.map((g) => [g.key, g.count]), `${who} group ${group}`).toEqual([...counts.entries()])
        let start = 0
        for (const g of got) {
          expect(g.start).toBe(start)
          start += g.count
        }
      }
    }
  })

  it('shares out each column as distribute did', async () => {
    const bp = hub.blueprints.get('thing')!
    for (const [who, view] of readers()) {
      const p = base({ filter: { field: 'num', op: 'exists' } })
      const ref = await reference(p, view)
      const expected = view.all ? distribute(bp, ref.entities) : view.distribution('thing', distribute(bp, ref.entities))
      const got = await hub.reader.sql.distribution(p, view.all ? ALL : view)
      const seen = view.all ? got : view.distribution('thing', got)
      // Buckets tied on count order by label on both sides; the sets and counts are the thing.
      const norm = (d: Record<string, { buckets: { value: string | null; label: string; count: number }[]; other: number }>) => Object.fromEntries(Object.entries(d).map(([k, v]) => [k, { other: v.other, buckets: [...v.buckets].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)) }]))
      expect(norm(seen), who).toEqual(norm(expected))
    }
  })

  it('leaves out a column where a row holds a list too long to share out, and opens none of its lists', async () => {
    expect((await admin('/v1/blueprints/bundle', put({ id: 'bundle', title: 'Bundle', fields: { parts: { type: 'array' }, tags: { type: 'array' } }, relations: { peers: { target: 'bundle', many: true } } }))).status).toBe(200)
    const parts = (n: number) => Array.from({ length: n }, (_, i) => `part-${i}`)
    const create = async (key: string, fields: Record<string, unknown>) => expect((await admin('/v1/entities', post({ blueprint: 'bundle', key, title: key, fields, relations: {} }))).status).toBe(201)
    await create('small', { parts: ['part-0', 'part-1'], tags: ['a', 'b'] })
    await create('full', { parts: parts(SHARED_LIST_MAX), tags: ['a'] })
    const p: ListParams = { blueprint: 'bundle', states: ['active'], includeHidden: false }
    const bp = hub.blueprints.get('bundle')!
    // A list of exactly the most a row may hold is still counted.
    const within = await hub.reader.sql.distribution(p, ALL)
    expect(within['f:parts']!.buckets.find((b) => b.value === 'part-0')!.count).toBe(2)
    expect(within).toEqual(distribute(bp, (await reference(p, adminView)).entities))

    await create('long', { parts: parts(SHARED_LIST_MAX + 1), tags: ['b', 'c'] })
    const got = await hub.reader.sql.distribution(p, ALL)
    expect(Object.keys(got).sort()).toEqual(['f:tags', 'owner', 'r:peers', 'state', 'status'])
    expect(got).toEqual(distribute(bp, (await reference(p, adminView)).entities))
    // The rows without the long list share the column out again.
    const short: ListParams = { ...p, filter: { field: '$key', op: 'neq', value: 'long' } }
    expect((await hub.reader.sql.distribution(short, ALL))['f:parts']).toEqual(within['f:parts'])
  })

  it('counts a chip, a list, and plain text only as each field says, on both sides', async () => {
    const fields = { version: { type: 'string', chip: true, spread: false }, tier: { type: 'string', chip: true }, region: { type: 'string', spread: true }, tags: { type: 'array', spread: false } }
    expect((await admin('/v1/blueprints/release_note', put({ id: 'release_note', title: 'Release note', fields }))).status).toBe(200)
    for (const [key, version] of [['a', '1.0.1'], ['b', '1.0.2'], ['c', '1.0.2']]) expect((await admin('/v1/entities', post({ blueprint: 'release_note', key, title: key, fields: { version, tier: 'gold', region: 'east', tags: ['x'] }, relations: {} }))).status).toBe(201)
    const p: ListParams = { blueprint: 'release_note', states: ['active'], includeHidden: false }
    const got = await hub.reader.sql.distribution(p, ALL)
    // The chip whose count is off, and the list whose count is off, are not counted; plain text counted on purpose is.
    expect(Object.keys(got).sort()).toEqual(['f:region', 'f:tier', 'owner', 'state', 'status'])
    expect(got).toEqual(distribute(hub.blueprints.get('release_note')!, (await reference(p, adminView)).entities))
    // The saved field keeps the mark, so the editor shows it as set.
    expect(hub.blueprints.get('release_note')!.fields.version).toMatchObject({ chip: true, spread: false })
  })

  it('pages the same order it lists', async () => {
    const p = base({ sort: '-num' })
    const all = await sqlIds(p, adminView)
    const pages: string[] = []
    for (let offset = 0; offset < all.length; offset += 7) {
      const { rows } = await hub.reader.sql.rows(p, ALL, { limit: 7, offset })
      pages.push(...rows.map((r) => `${r.blueprint}:${r.key}`))
    }
    expect(pages).toEqual(all)
    expect(await hub.reader.sql.refs(p, ALL)).toHaveLength(all.length)
  })
})
