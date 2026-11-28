import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { applyCatalog } from './catalog.ts'
import { loadConfig } from './config.ts'
import { createHub, type Hub } from './hub.ts'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://orrery:orrery@localhost:5433/orrery'

let hub: Hub
let token = ''
const machine = (path: string, init?: RequestInit) => hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...init?.headers } }, { surface: 'machine' })
const session = (path: string, init?: RequestInit) => hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', ...init?.headers } }, { surface: 'session' })
const json = async <T>(res: Response): Promise<T> => (await res.json()) as T

beforeAll(async () => {
  const config = loadConfig({ DATABASE_URL, DATA_DIR: mkdtempSync(join(tmpdir(), 'orrery-')), AUTH_MODE: 'none' })
  hub = await createHub(config, 'test', { reset: true })
  await hub.blueprints.save({ id: 'gizmo', title: 'Gizmo', fields: { size: { type: 'number' } } }, { kind: 'ui' }, 'test', async () => [])
  await hub.blueprints.save({ id: 'part', title: 'Part', fields: { on_one: { type: 'number', aggregation: { relation: 'gizmo', fn: 'count', where: { relatedTo: 'gizmo:one' } } } }, relations: { gizmo: { target: 'gizmo' } } }, { kind: 'ui' }, 'test', async () => [])
  await hub.sources.save('maker', { title: 'Maker', class: 'pusher', blueprints: ['gizmo', 'part'], deleteGrant: [], cadence: null })
  token = (await hub.sources.issueToken('source', 'maker', { source: 'maker' })).token
  expect((await machine('/v1/ingest/entities/gizmo/one', { method: 'PUT', body: JSON.stringify({ fields: { size: 1 } }) })).status).toBe(201)
  expect((await machine('/v1/ingest/entities/part/bolt', { method: 'PUT', body: JSON.stringify({ relations: { gizmo: ['gizmo:one'] } }) })).status).toBe(201)
  await hub.blueprints.rename('gizmo', 'shop_gizmo', 'test')
  await hub.sources.load()
})

afterAll(async () => {
  await hub.close()
})

describe('a renamed blueprint', () => {
  it('remembers the id it had, and its entities and relations moved with it', () => {
    expect(hub.blueprints.get('shop_gizmo')?.formerly).toEqual(['gizmo'])
    expect(hub.blueprints.get('gizmo')?.id).toBe('shop_gizmo')
    expect(hub.blueprints.get('part')?.relations.gizmo?.target).toBe('shop_gizmo')
  })

  it('takes a write and a read under the old id, from a source registered before the rename', async () => {
    expect((await machine('/v1/ingest/entities/gizmo/two', { method: 'PATCH', body: JSON.stringify({ fields: { size: 2 } }) })).status).toBe(201)
    const row = await hub.reader.get({ blueprint: 'gizmo', key: 'two' })
    expect(row?.blueprint).toBe('shop_gizmo')
    expect((await hub.reader.list({ blueprint: 'gizmo' })).entities.map((e) => e.key).sort()).toEqual(['one', 'two'])
    const stored = await hub.db.query<{ blueprint: string }>(`SELECT DISTINCT blueprint FROM entities WHERE key IN ('one', 'two')`)
    expect(stored.rows.map((r) => r.blueprint)).toEqual(['shop_gizmo'])
  })

  it('reaches its entities from a filter that still names the old id', async () => {
    const keys = async (filter: object) => (await hub.reader.list({ blueprint: 'part', filter: filter as never })).entities.map((e) => e.key)
    expect(await keys({ relation: 'gizmo', target: 'gizmo:one' })).toEqual(['bolt'])
    expect(await keys({ relation: 'gizmo', target: 'shop_gizmo:one' })).toEqual(['bolt'])
    expect(await keys({ relatedTo: 'gizmo:one' })).toEqual(['bolt'])
    expect(await keys({ not: { relation: 'gizmo', target: 'gizmo:one' } })).toEqual([])
  })

  it('moves the entity ids its model filters name', () => {
    expect(hub.blueprints.get('part')?.fields.on_one?.aggregation?.where).toEqual({ relatedTo: 'shop_gizmo:one' })
  })

  it('takes an offer under the old id as an offer to the new one, and never makes the old one again', async () => {
    const res = await json<{ created: string[]; extended: string[] }>(await machine('/v1/ingest/blueprints', { method: 'PUT', body: JSON.stringify({ blueprints: [{ id: 'gizmo', title: 'Gizmo', fields: { colour: { type: 'string' } } }] }) }))
    expect(res).toMatchObject({ created: [], extended: ['shop_gizmo'] })
    expect(hub.blueprints.list().map((b) => b.id)).not.toContain('gizmo')
    expect(hub.blueprints.get('shop_gizmo')?.fields.colour).toBeDefined()
    expect(hub.blueprints.get('shop_gizmo')?.formerly).toEqual(['gizmo'])
  })

  it('refuses a new blueprint under a former id', async () => {
    await expect(hub.blueprints.save({ id: 'gizmo', title: 'Another' }, { kind: 'ui' }, 'test', async () => [])).rejects.toThrow(/renamed to "shop_gizmo"/)
  })

  it('forgets a former id on request, and the id is free for another blueprint', async () => {
    await hub.blueprints.rename('shop_gizmo', 'shop_gadget', 'test')
    expect(hub.blueprints.get('shop_gadget')?.formerly).toEqual(['gizmo', 'shop_gizmo'])
    const res = await session('/v1/blueprints/shop_gadget/formerly/gizmo', { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(hub.blueprints.get('shop_gadget')?.formerly).toEqual(['shop_gizmo'])
    expect(hub.blueprints.get('gizmo')).toBeUndefined()
    await hub.blueprints.save({ id: 'gizmo', title: 'Gizmo' }, { kind: 'ui' }, 'test', async () => [])
    expect(hub.blueprints.get('gizmo')?.id).toBe('gizmo')
    expect(hub.blueprints.get('shop_gizmo')?.id).toBe('shop_gadget')
    expect((await session('/v1/blueprints/shop_gadget/formerly/nothing', { method: 'DELETE' })).status).toBe(400)
  })
})

describe('a catalog file renaming its own blueprint', () => {
  it('names the old id under formerly, and every entity stays', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orrery-formerly-'))
    const source = await hub.sources.save('file', { title: 'File', class: 'git', blueprints: ['*'], deleteGrant: ['*'], cadence: null, git: { url: 'https://example.org/file.git', branch: 'main', glob: '**/*.yaml' } })
    writeFileSync(join(dir, 'model.yaml'), 'blueprints:\n  - id: widget\n    title: Widget\nentities:\n  - { blueprint: widget, key: a }\n')
    expect((await applyCatalog(hub, source, dir, '**/*.yaml')).errors).toEqual([])
    writeFileSync(join(dir, 'model.yaml'), 'blueprints:\n  - id: shop_widget\n    title: Widget\n    formerly: [widget]\nentities:\n  - { blueprint: shop_widget, key: a }\n')
    const report = await applyCatalog(hub, source, dir, '**/*.yaml')
    expect(report.errors).toEqual([])
    expect(hub.blueprints.get('shop_widget')?.origin).toMatchObject({ kind: 'git', source: 'file' })
    expect(hub.blueprints.list().map((b) => b.id)).not.toContain('widget')
    expect((await hub.reader.get({ blueprint: 'shop_widget', key: 'a' }))?.state).toBe('active')
  })
})

describe('an offer or an import that names a former id', () => {
  it('renames the blueprint and extends it, keeping what other writers added', async () => {
    await hub.blueprints.save({ id: 'doohickey', title: 'Doohickey', fields: { pusher_only: { type: 'string' } } }, { kind: 'ui' }, 'test', async () => [])
    await hub.entities.createFromUi({ blueprint: 'doohickey', key: 'x', fields: { pusher_only: 'kept' }, relations: {} }, 'test')
    const res = await hub.blueprints.offer([{ id: 'kit_doohickey', title: 'Doohickey', group: 'Kit', formerly: ['doohickey'], fields: { size: { type: 'number' } } }], { kind: 'ui' }, 'test', async () => [])
    expect(res.extended).toEqual(['kit_doohickey'])
    const bp = hub.blueprints.get('kit_doohickey')!
    expect(Object.keys(bp.fields).sort()).toEqual(['pusher_only', 'size'])
    expect(bp.formerly).toEqual(['doohickey'])
    expect((await hub.reader.get({ blueprint: 'kit_doohickey', key: 'x' }))?.fields.pusher_only).toBe('kept')
  })
})

describe('a relation that names a former name', () => {
  it('takes over the links stored under it, the paths that walk them, and writes that still use it', async () => {
    await hub.blueprints.save({ id: 'tag', title: 'Tag' }, { kind: 'ui' }, 'test', async () => [])
    await hub.blueprints.save({ id: 'thing', title: 'Thing', relations: { tags: { target: 'tag', many: true } } }, { kind: 'ui' }, 'test', async () => [])
    await hub.blueprints.save({ id: 'tag', title: 'Tag', fields: { things: { type: 'number', aggregation: { relation: '<-thing:tags', fn: 'count' } } } }, { kind: 'ui' }, 'test', async () => [])
    await hub.entities.createFromUi({ blueprint: 'tag', key: 'red', relations: {} }, 'test')
    await hub.entities.createFromUi({ blueprint: 'thing', key: 'a', relations: { tags: ['red'] } }, 'test')
    await hub.blueprints.offer([{ id: 'thing', title: 'Thing', relations: { labels: { target: 'tag', many: true, formerly: ['tags'] } } }], { kind: 'ui' }, 'test', async () => [])
    const thing = hub.blueprints.get('thing')!
    expect(Object.keys(thing.relations)).toEqual(['labels'])
    expect(hub.blueprints.get('tag')?.fields.things?.aggregation?.relation).toBe('<-thing:labels')
    expect((await hub.reader.get({ blueprint: 'thing', key: 'a' }))?.relations.labels?.map((t) => t.key)).toEqual(['red'])
    await hub.sources.save('tagger', { title: 'Tagger', class: 'pusher', blueprints: ['thing'], deleteGrant: [], cadence: null })
    const result = await hub.entities.write({ blueprint: 'thing', key: 'b', relations: { tags: ['red'] } }, { source: hub.sources.get('tagger')!, layer: 'pushed', mode: 'upsert', replace: false })
    expect(result.outcome).toBe('created')
    expect((await hub.reader.get({ blueprint: 'thing', key: 'b' }))?.relations.labels?.map((t) => t.key)).toEqual(['red'])
  })
})

describe('an offer naming a former id another writer defines', () => {
  it('is refused, and makes nothing beside it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orrery-formerly-'))
    const source = await hub.sources.save('defs', { title: 'Defs', class: 'git', blueprints: ['*'], deleteGrant: ['*'], cadence: null, git: { url: 'https://example.org/defs.git', branch: 'main', glob: '**/*.yaml' } })
    writeFileSync(join(dir, 'model.yaml'), 'blueprints:\n  - id: sprocket\n    title: Sprocket\n')
    expect((await applyCatalog(hub, source, dir, '**/*.yaml')).errors).toEqual([])
    const res = await hub.blueprints.offer([{ id: 'kit_sprocket', title: 'Sprocket', formerly: ['sprocket'] }], { kind: 'ui' }, 'test', async () => [])
    expect(res.rejected[0]?.reason).toMatch(/rename it there/)
    expect(hub.blueprints.list().map((b) => b.id)).not.toContain('kit_sprocket')
    expect(hub.blueprints.get('sprocket')?.id).toBe('sprocket')
  })
})

describe('a source registered under an old id', () => {
  it('may write the renamed blueprint under its new id', async () => {
    await hub.blueprints.save({ id: 'widget2', title: 'Widget' }, { kind: 'ui' }, 'test', async () => [])
    const source = await hub.sources.save('old-list', { title: 'Old list', class: 'pusher', blueprints: ['widget2'], deleteGrant: [], cadence: null })
    await hub.blueprints.rename('widget2', 'kit_widget2', 'test')
    expect(hub.entities.allowed(source, 'kit_widget2')).toBe(true)
    expect(hub.entities.allowed(source, 'widget2')).toBe(true)
    expect(hub.entities.allowed(source, 'tag')).toBe(false)
  })
})

/** Runs the hub's clock `ms` ahead of the real one, as it is when the database's runs behind, and gives back the undo. */
function clockAhead(ms: number): () => void {
  const Real = globalThis.Date
  const Ahead = class extends Real {
    constructor(...args: unknown[]) {
      if (args.length) super(...(args as [string | number | Date]))
      else super(Real.now() + ms)
    }
    static override now(): number {
      return Real.now() + ms
    }
  }
  vi.stubGlobal('Date', Ahead)
  return () => vi.unstubAllGlobals()
}

describe('a rename on a hub whose clock runs ahead of the database', () => {
  it('reads what was derived before it as stale, so a filter by the new id still finds it', async () => {
    // The hub stamps a derivation with its own clock: the rename must stamp the model's change with the same one.
    const undo = clockAhead(5_000)
    try {
      await hub.blueprints.save({ id: 'cog', title: 'Cog' }, { kind: 'ui' }, 'test', async () => [])
      await hub.blueprints.save({ id: 'wheel', title: 'Wheel', relations: { cog: { target: 'cog' } } }, { kind: 'ui' }, 'test', async () => [])
      await hub.entities.createFromUi({ blueprint: 'cog', key: 'c1', relations: {} }, 'test')
      await hub.entities.createFromUi({ blueprint: 'wheel', key: 'w1', relations: { cog: ['c1'] } }, 'test')
      await hub.blueprints.rename('cog', 'shop_cog', 'test')
      const keys = async (filter: object) => (await hub.reader.list({ blueprint: 'wheel', filter: filter as never })).entities.map((e) => e.key)
      expect(await keys({ relation: 'cog', target: 'shop_cog:c1' })).toEqual(['w1'])
      expect(await keys({ relation: 'cog', target: 'cog:c1' })).toEqual(['w1'])
    } finally {
      undo()
    }
  })
})
