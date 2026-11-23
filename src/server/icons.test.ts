import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ChangesResponse, IconsResponse } from '../shared/api.ts'
import { applyCatalog } from './catalog.ts'
import { loadConfig } from './config.ts'
import { createHub, type Hub } from './hub.ts'
import { refusedImage, refusedName } from './icons.ts'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://orrery:orrery@localhost:5433/orrery'

let hub: Hub
let pusher = ''
let editor = ''
let reader = ''

const as = (email: string, groups: string) => (path: string, init?: RequestInit) => hub.app.request(path, { ...init, headers: { 'x-forwarded-email': email, 'x-forwarded-groups': groups, ...init?.headers } }, { surface: 'session' })
const admin = as('admin@example.com', 'Admin')
const person = as('person@example.com', 'User')
const machine = (bearer: string) => (path: string, init?: RequestInit) => hub.app.request(path, { ...init, headers: { authorization: `Bearer ${bearer}`, ...init?.headers } }, { surface: 'machine' })
const json = async <T = Record<string, unknown>>(r: Response): Promise<T> => (await r.json()) as T
const svg = (inner = '<circle cx="8" cy="8" r="6" fill="#2fd07a"/>') => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">${inner}</svg>`
const putSvg = (text: string, type = 'image/svg+xml') => ({ method: 'PUT', headers: { 'content-type': type }, body: text })
const iconChanges = async () => (await json<ChangesResponse>(await admin('/v1/changes?kind=icon.changed,icon.removed&limit=1000'))).changes
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])

beforeAll(async () => {
  const config = loadConfig({ DATABASE_URL, DATA_DIR: mkdtempSync(join(tmpdir(), 'orrery-')), AUTH_MODE: 'proxy' })
  hub = await createHub(config, 'test', { reset: true })
  const by = { admin: true, permissions: [] as never[], kind: 'user' as const, name: 'local', roles: [] }
  await hub.access.saveRole('editor', { title: 'Editor', permissions: ['entities.edit'] }, by)
  await hub.access.saveRole('looker', { title: 'Looker', permissions: [] }, by)
  await hub.sources.save('tally', { title: 'Tally', class: 'pusher', blueprints: ['sw_service'], deleteGrant: [], cadence: null })
  pusher = (await hub.sources.issueToken('source', 'tally', { source: 'tally' })).token
  editor = (await hub.sources.issueToken('access', 'editor', { role: 'editor' })).token
  reader = (await hub.sources.issueToken('access', 'looker', { role: 'looker' })).token
})

afterAll(async () => {
  await hub.close()
})

describe('what an icon may be', () => {
  it('takes a plain name, never a built-in one', () => {
    expect(refusedName('tally')).toBeNull()
    expect(refusedName('backup_watch')).toBeNull()
    expect(refusedName('Tally')?.status).toBe(400)
    expect(refusedName('_tally')?.status).toBe(400)
    expect(refusedName('a'.repeat(64))?.status).toBe(400)
    for (const builtIn of ['grafana', 'service', 'azure_key_vaults', 'azure_anything']) expect(refusedName(builtIn)?.status).toBe(409)
  })

  it('refuses an SVG that could run or fetch anything', () => {
    const bad = [
      svg('<script>alert(1)</script>'),
      svg('<circle onload="alert(1)" r="2"/>'),
      svg('<a href="javascript:alert(1)"><circle r="2"/></a>'),
      svg('<foreignObject><div/></foreignObject>'),
      svg('<image href="https://example.org/x.png"/>'),
      svg('<use xlink:href="other.svg#a"/>'),
      `<!DOCTYPE svg [<!ENTITY x "y">]>${svg()}`,
    ]
    for (const text of bad) expect(refusedImage('image/svg+xml', new TextEncoder().encode(text))?.status, text).toBe(422)
    expect(refusedImage('image/svg+xml', new TextEncoder().encode(svg('<use href="#a"/><image href="data:image/png;base64,AAAA"/>')))).toBeNull()
  })

  it('checks the type, the size, and the magic bytes', () => {
    expect(refusedImage('image/gif', PNG)?.status).toBe(415)
    expect(refusedImage('image/png', PNG)).toBeNull()
    expect(refusedImage('image/png', new TextEncoder().encode(svg()))?.status).toBe(422)
    expect(refusedImage('image/webp', new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '))).toBeNull()
    expect(refusedImage('image/webp', PNG)?.status).toBe(422)
    expect(refusedImage('image/svg+xml', new TextEncoder().encode('<html></html>'))?.status).toBe(422)
    expect(refusedImage('image/svg+xml', new TextEncoder().encode(svg(' '.repeat(256 * 1024))))?.status).toBe(413)
  })
})

describe('the icon routes', () => {
  it('lets a push token put an icon, and the same bytes again change nothing', async () => {
    const put = await machine(pusher)('/v1/icons/tally', putSvg(svg()))
    expect(put.status).toBe(200)
    const answer = await json(put)
    expect(answer).toMatchObject({ name: 'tally', type: 'image/svg+xml', size: svg().length })
    expect(answer.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect((await iconChanges()).map((c) => [c.kind, c.source, c.detail.icon])).toEqual([['icon.changed', 'tally', 'tally']])
    expect((await machine(pusher)('/v1/icons/tally', putSvg(svg()))).status).toBe(200)
    expect(await iconChanges()).toHaveLength(1)
    expect((await machine(pusher)('/v1/icons/tally', putSvg(svg('<rect width="4" height="4"/>')))).status).toBe(200)
    expect(await iconChanges()).toHaveLength(2)
  })

  it('serves an icon with its tag, and answers 304 for the same tag', async () => {
    const res = await machine(reader)('/v1/icons/tally')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/svg+xml')
    expect(res.headers.get('cache-control')).toBe('private, max-age=300')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; style-src 'unsafe-inline'")
    const etag = res.headers.get('etag')!
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/)
    expect(await res.text()).toBe(svg('<rect width="4" height="4"/>'))
    const again = await machine(reader)('/v1/icons/tally', { headers: { 'if-none-match': etag } })
    expect(again.status).toBe(304)
    expect(again.headers.get('etag')).toBe(etag)
    expect((await machine(reader)('/v1/icons/tally', { headers: { 'if-none-match': '"other"' } })).status).toBe(200)
  })

  it('serves a built-in brand file, its light copy, and nothing for a concept or an unknown name', async () => {
    const brand = await person('/v1/icons/grafana')
    expect(brand.status).toBe(200)
    expect(brand.headers.get('content-type')).toBe('image/svg+xml')
    const dark = await person('/v1/icons/github')
    const light = await person('/v1/icons/github?theme=light')
    expect(light.status).toBe(200)
    expect(light.headers.get('etag')).not.toBe(dark.headers.get('etag'))
    expect((await person('/v1/icons/service')).status).toBe(404)
    expect((await person('/v1/icons/nothing_here')).status).toBe(404)
  })

  it('lists the custom icons with their owners', async () => {
    const { icons } = await json<IconsResponse>(await person('/v1/icons'))
    expect(icons.map((i) => [i.name, i.owner, i.type])).toEqual([['tally', 'tally', 'image/svg+xml']])
    expect(icons[0]!.updatedAt).toMatch(/^\d{4}-/)
  })

  it('refuses a put the caller may not make, or bytes it may not hold', async () => {
    expect((await machine(reader)('/v1/icons/mine', putSvg(svg()))).status).toBe(403)
    expect((await person('/v1/icons/mine', putSvg(svg()))).status).toBe(403)
    expect((await machine(editor)('/v1/icons/grafana', putSvg(svg()))).status).toBe(409)
    expect((await machine(editor)('/v1/icons/Bad-Name', putSvg(svg()))).status).toBe(400)
    expect((await machine(editor)('/v1/icons/mine', putSvg(svg('<script/>')))).status).toBe(422)
    expect((await machine(editor)('/v1/icons/mine', putSvg(svg(), 'text/plain'))).status).toBe(415)
    expect((await machine(editor)('/v1/icons/mine', putSvg(svg(' '.repeat(256 * 1024))))).status).toBe(413)
    const png = await machine(editor)('/v1/icons/mine', { method: 'PUT', headers: { 'content-type': 'image/png' }, body: PNG })
    expect(png.status).toBe(200)
    expect((await json<IconsResponse>(await admin('/v1/icons'))).icons.find((i) => i.name === 'mine')?.owner).toBe('ui')
    // A source token reads nothing, the icons among it.
    expect((await machine(pusher)('/v1/icons/tally')).status).toBe(403)
  })

  it('shows a custom icon on an entity that names it, and drops it when the icon goes', async () => {
    expect((await machine(pusher)('/v1/ingest/blueprints', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ blueprints: [{ id: 'sw_service', title: 'Service', icon: 'service' }] }) })).status).toBe(200)
    expect((await machine(pusher)('/v1/ingest/entities/sw_service/tally', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Tally', icon: 'tally' }) })).status).toBe(201)
    const read = async () => (await json<{ icon: string }>(await admin('/v1/entities/sw_service/tally'))).icon
    expect(await read()).toBe('tally')
    expect((await machine(editor)('/v1/icons/tally', { method: 'DELETE' })).status).toBe(403)
    expect((await admin('/v1/icons/tally', { method: 'DELETE' })).status).toBe(200)
    expect((await iconChanges())[0]).toMatchObject({ kind: 'icon.removed', actor: 'admin@example.com', detail: { icon: 'tally' } })
    expect(await read()).toBe('service')
    expect((await admin('/v1/icons/tally', { method: 'DELETE' })).status).toBe(404)
    expect((await person('/v1/icons/tally')).status).toBe(404)
  })
})

describe('icons in a git source', () => {
  it('loads the icons beside the catalog, wins over every other owner, and removes what leaves the repository', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orrery-icons-'))
    mkdirSync(join(dir, 'catalog', 'icons'), { recursive: true })
    writeFileSync(join(dir, 'catalog', 'estate.yaml'), 'entities: []\n')
    writeFileSync(join(dir, 'catalog', 'icons', 'alloy.svg'), svg())
    writeFileSync(join(dir, 'catalog', 'icons', 'mine.svg'), svg('<rect width="2" height="2"/>'))
    writeFileSync(join(dir, 'catalog', 'icons', 'notes.txt'), 'not an icon')
    writeFileSync(join(dir, 'catalog', 'icons', 'grafana.svg'), svg())
    const source = await hub.sources.save('house', { title: 'House', class: 'git', blueprints: ['*'], deleteGrant: [], cadence: null, git: { url: 'https://example.org/house.git', branch: 'main', glob: 'catalog/**/*.yaml' } })
    const report = await applyCatalog(hub, source, dir, 'catalog/**/*.yaml')
    expect(report.errors).toEqual([{ file: join('catalog', 'icons', 'grafana.svg'), reason: expect.stringMatching(/built-in/) }])
    const owners = async () => Object.fromEntries((await json<IconsResponse>(await admin('/v1/icons'))).icons.map((i) => [i.name, i.owner]))
    expect(await owners()).toEqual({ alloy: 'git:house', mine: 'git:house' })
    const changed = (await iconChanges()).length
    await applyCatalog(hub, source, dir, 'catalog/**/*.yaml')
    expect(await iconChanges()).toHaveLength(changed)
    const locked = await machine(editor)('/v1/icons/alloy', putSvg(svg('<rect width="3" height="3"/>')))
    expect(locked.status).toBe(409)
    expect((await json(locked)).error).toMatch(/set in git/)
    rmSync(join(dir, 'catalog', 'icons', 'alloy.svg'))
    await applyCatalog(hub, source, dir, 'catalog/**/*.yaml')
    expect(await owners()).toEqual({ mine: 'git:house' })
  })
})
