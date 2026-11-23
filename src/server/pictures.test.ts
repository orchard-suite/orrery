import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ChangesResponse, EntitiesResponse, EntityPageResponse, PicturesResponse, WhoAmIResponse } from '../shared/api.ts'
import { loadConfig } from './config.ts'
import { createHub, type Hub } from './hub.ts'
import { jpegSize, photoSha, refusedPhoto } from './pictures.ts'

// Its own database: these tests set who a person is.
const DATABASE_URL = (process.env.DATABASE_URL ?? 'postgres://orrery:orrery@localhost:5433/orrery') + '_pictures'

let hub: Hub
let entra = ''
let other = ''

const as = (email: string, groups = 'User') => (path: string, init?: RequestInit) =>
  hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', 'x-forwarded-email': email, 'x-forwarded-groups': groups, ...init?.headers } }, { surface: 'session' })
const machine = (bearer: string) => (path: string, init?: RequestInit) => hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}`, ...init?.headers } }, { surface: 'machine' })
const json = async <T = Record<string, unknown>>(r: Response): Promise<T> => (await r.json()) as T
const put = (v: unknown) => ({ method: 'PUT', body: JSON.stringify(v) })
const post = (v: unknown) => ({ method: 'POST', body: JSON.stringify(v) })

const admin = as('admin@example.org', 'Admin')
const ada = as('ada@example.org')
const bob = as('bob@example.org')

/** The headers of a JPEG of this size and nothing more: the hub reads its frame header and never decodes it. */
function jpeg(px: number, pad = 0): Uint8Array {
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]
  const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, px >> 8, px & 0xff, px >> 8, px & 0xff, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]
  return new Uint8Array([0xff, 0xd8, ...app0, ...sof, ...new Array<number>(pad).fill(0), 0xff, 0xd9])
}
const b64 = (data: Uint8Array) => Buffer.from(data).toString('base64')
const photo = (seed: number) => ({ small: jpeg(64, seed), large: jpeg(256, seed) })
const putPhoto = (as: ReturnType<typeof machine>, address: string, p: { small: Uint8Array; large: Uint8Array }) => as(`/v1/ingest/pictures/${encodeURIComponent(address)}`, put({ small: b64(p.small), large: b64(p.large) }))
const settle = async () => {
  while (await hub.deriver.depth()) await hub.deriver.drain()
}
const iconOf = async (reader: typeof admin, blueprint: string, key: string) => json<EntityPageResponse>(await reader(`/v1/entities/${blueprint}/${encodeURIComponent(key)}`))

describe('photo bytes', () => {
  it('reads the size a JPEG says it is', () => {
    expect(jpegSize(jpeg(64))).toEqual({ width: 64, height: 64 })
    expect(jpegSize(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull()
  })

  it('takes a photo only as a square JPEG of its size, under its cap', () => {
    expect(refusedPhoto('small', jpeg(64))).toBeNull()
    expect(refusedPhoto('large', jpeg(256))).toBeNull()
    expect(refusedPhoto('small', jpeg(256))?.message).toMatch(/64x64, not 256x256/)
    expect(refusedPhoto('small', jpeg(64, 17 * 1024))?.status).toBe(413)
    expect(refusedPhoto('large', new Uint8Array([1, 2, 3]))?.status).toBe(422)
  })
})

describe('pictures', () => {
  beforeAll(async () => {
    const pg = await import('pg').then(({ default: m }) => new m.Client({ connectionString: DATABASE_URL.replace(/\/[^/]+$/, '/postgres') }))
    await pg.connect()
    await pg.query(`DROP DATABASE IF EXISTS ${DATABASE_URL.split('/').pop()}`)
    await pg.query(`CREATE DATABASE ${DATABASE_URL.split('/').pop()}`)
    await pg.end()
    hub = await createHub(loadConfig({ DATABASE_URL, DATA_DIR: mkdtempSync(join(tmpdir(), 'orrery-')), AUTH_MODE: 'proxy' }), 'test', { reset: true })
    const save = async (id: string, spec: Record<string, unknown>) => expect((await admin(`/v1/blueprints/${id}`, put({ id, ...spec }))).status).toBe(200)
    await save('person', { title: 'Person', icon: 'person', fields: { email: { type: 'string' } }, relations: {} })
    await save('service', { title: 'Service', icon: 'service', fields: { steward: { type: 'user' } }, relations: { owner: { target: 'person' } } })
    expect((await admin('/v1/access/person', put({ blueprint: 'person', field: 'email' }))).status).toBe(200)
    for (const [key, email] of [['ada', 'Ada@Example.org'], ['bob', 'bob@example.org']] as const) expect((await admin('/v1/entities', post({ blueprint: 'person', key, title: key === 'ada' ? 'Ada Lovelace' : 'Bob', fields: { email } }))).status).toBe(201)
    expect((await admin('/v1/entities', post({ blueprint: 'service', key: 'web', title: 'web', fields: { steward: 'ada@example.org' }, relations: { owner: 'ada' } }))).status).toBe(201)
    for (const [id, title] of [['entra', 'Entra'], ['other', 'Other']] as const) await hub.sources.save(id, { title, class: 'pusher', blueprints: ['service'], deleteGrant: [], cadence: null })
    entra = (await hub.sources.issueToken('source', 'entra', { source: 'entra' })).token
    other = (await hub.sources.issueToken('source', 'other', { source: 'other' })).token
    await settle()
  })

  afterAll(async () => {
    await hub?.db.close()
  })

  it('shows a person their photo once a source puts it, by the address they sign in with', async () => {
    const p = photo(1)
    const r = await putPhoto(machine(entra), 'ADA@example.org', p)
    expect(r.status).toBe(200)
    const sha = photoSha(p.small, p.large)
    expect(await json(r)).toEqual({ address: 'ada@example.org', sha256: sha })
    await settle()
    expect(await iconOf(admin, 'person', 'ada')).toMatchObject({ icon: `photo:${sha}`, picture: 'photo' })
    expect((await iconOf(admin, 'person', 'bob')).icon).toBe('person')
    expect((await json<PicturesResponse>(await machine(entra)('/v1/ingest/pictures'))).pictures).toEqual([{ address: 'ada@example.org', sha256: sha }])
    expect((await json<PicturesResponse>(await machine(other)('/v1/ingest/pictures'))).pictures).toEqual([])
  })

  it('changes nothing for the same bytes again', async () => {
    const before = (await json<ChangesResponse>(await admin('/v1/changes?kind=picture.changed&limit=100'))).changes.length
    expect((await putPhoto(machine(entra), 'ada@example.org', photo(1))).status).toBe(200)
    expect((await json<ChangesResponse>(await admin('/v1/changes?kind=picture.changed&limit=100'))).changes).toHaveLength(before)
  })

  it('refuses a photo that is not two square JPEGs of their sizes', async () => {
    expect((await putPhoto(machine(entra), 'bob@example.org', { small: jpeg(256), large: jpeg(256) })).status).toBe(422)
    expect((await machine(entra)('/v1/ingest/pictures/bob@example.org', put({ small: b64(jpeg(64)) }))).status).toBe(400)
    expect((await ada('/v1/ingest/pictures/ada@example.org', put({ small: b64(jpeg(64)), large: b64(jpeg(256)) }))).status).toBe(403)
  })

  it('serves each size by its hash, to keep for good', async () => {
    const p = photo(1)
    const sha = photoSha(p.small, p.large)
    const small = await bob(`/v1/photos/${sha}/small`)
    expect(small.status).toBe(200)
    expect(small.headers.get('content-type')).toBe('image/jpeg')
    expect(small.headers.get('cache-control')).toContain('immutable')
    expect(new Uint8Array(await small.arrayBuffer())).toEqual(p.small)
    expect(new Uint8Array(await (await bob(`/v1/photos/${sha}/large`)).arrayBuffer())).toEqual(p.large)
    expect((await bob(`/v1/photos/${'0'.repeat(64)}/small`)).status).toBe(404)
    expect((await bob(`/v1/photos/${sha}/huge`)).status).toBe(404)
  })

  it('draws a person beside what names them with their picture', async () => {
    const sha = photoSha(photo(1).small, photo(1).large)
    const list = await json<EntitiesResponse>(await admin('/v1/entities?blueprint=service'))
    const web = list.entities.find((e) => e.key === 'web')!
    expect(web.relations.owner?.[0]).toMatchObject({ key: 'ada', icon: `photo:${sha}` })
    expect(web.people?.['ada@example.org']).toMatchObject({ title: 'Ada Lovelace', icon: `photo:${sha}` })
  })

  it('tells a person who they are, with their photo', async () => {
    const sha = photoSha(photo(1).small, photo(1).large)
    const who = await json<WhoAmIResponse>(await ada('/v1/whoami'))
    expect(who.person).toEqual({ entity: { blueprint: 'person', key: 'ada' }, title: 'Ada Lovelace', icon: `photo:${sha}`, photo: `photo:${sha}`, pick: null })
  })

  it('lets a person pick an icon in place of their photo, shown to everyone, and go back to it', async () => {
    const sha = photoSha(photo(1).small, photo(1).large)
    const picked = await json<WhoAmIResponse['person']>(await ada('/v1/mine/picture', put({ icon: 'rocket' })))
    expect(picked).toMatchObject({ icon: 'rocket', photo: `photo:${sha}`, pick: 'rocket' })
    expect(await iconOf(bob, 'person', 'ada')).toMatchObject({ icon: 'rocket', picture: 'picked' })
    // A new photo never undoes the pick.
    expect((await putPhoto(machine(entra), 'ada@example.org', photo(2))).status).toBe(200)
    await settle()
    expect((await iconOf(bob, 'person', 'ada')).icon).toBe('rocket')
    const back = await json<WhoAmIResponse['person']>(await ada('/v1/mine/picture', put({ icon: null })))
    const now = photoSha(photo(2).small, photo(2).large)
    expect(back).toMatchObject({ icon: `photo:${now}`, pick: null })
    expect(await iconOf(bob, 'person', 'ada')).toMatchObject({ icon: `photo:${now}`, picture: 'photo' })
    const kinds = (await json<ChangesResponse>(await admin('/v1/changes?kind=picture.picked&limit=10'))).changes.map((c) => c.actor)
    expect(kinds).toEqual(['ada@example.org', 'ada@example.org'])
  })

  it('never lets anyone pick a photo as an icon, their own or anyone else', async () => {
    const theirs = photoSha(photo(2).small, photo(2).large)
    expect((await bob('/v1/mine/picture', put({ icon: `photo:${theirs}` }))).status).toBe(422)
    expect((await bob('/v1/mine/picture', put({ icon: 'no_such_icon' }))).status).toBe(422)
    expect((await admin('/v1/entities/person/bob', { method: 'PATCH', body: JSON.stringify({ fields: { icon: `photo:${theirs}` } }) })).status).toBeGreaterThanOrEqual(200)
    // A stored name that is no icon the hub knows draws the blueprint's.
    expect((await iconOf(admin, 'person', 'bob')).icon).not.toBe(`photo:${theirs}`)
  })

  it('lets a person with no photo pick an icon too', async () => {
    await bob('/v1/mine/picture', put({ icon: 'bug' }))
    expect(await iconOf(admin, 'person', 'bob')).toMatchObject({ icon: 'bug', picture: 'picked' })
    await bob('/v1/mine/picture', put({ icon: null }))
    expect((await iconOf(admin, 'person', 'bob')).picture).toBeUndefined()
  })

  it('lets only the source that put a photo take it away', async () => {
    expect((await machine(other)('/v1/ingest/pictures/ada@example.org', { method: 'DELETE' })).status).toBe(404)
    expect((await machine(entra)('/v1/ingest/pictures/ada@example.org', { method: 'DELETE' })).status).toBe(200)
    await settle()
    const ada = await iconOf(admin, 'person', 'ada')
    expect(ada.icon).toBe('person')
    expect(ada.picture).toBeUndefined()
  })
})
