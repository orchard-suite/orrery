import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FindingsResponse } from '../shared/api.ts'
import type { Conventions } from '../shared/conventions.ts'
import { applyCatalog } from './catalog.ts'
import { loadConfig } from './config.ts'
import { createHub, type Hub } from './hub.ts'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://orrery:orrery@localhost:5433/orrery'

let hub: Hub
const as = (email: string, groups = 'User') => (path: string, init?: RequestInit) => hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', 'x-forwarded-email': email, 'x-forwarded-groups': groups, ...init?.headers } }, { surface: 'session' })
const admin = as('admin@example.org', 'Admin')
const put = (v: unknown) => ({ method: 'PUT', body: JSON.stringify(v) })
const unmet = async () => ((await (await admin('/v1/findings')).json()) as FindingsResponse).findings.filter((f) => f.kind === 'unmet_convention')

const platform = { id: 'platform', title: 'Platform owner', groups: ['Cloud'], relations: ['platform_team'] }

beforeAll(async () => {
  const config = loadConfig({ DATABASE_URL, DATA_DIR: mkdtempSync(join(tmpdir(), 'orrery-')), AUTH_MODE: 'proxy' })
  hub = await createHub(config, 'test', { reset: true })
  expect((await admin('/v1/blueprints/crew', put({ id: 'crew', title: 'Crew', fields: {}, relations: {} }))).status).toBe(200)
  expect((await admin('/v1/blueprints/bucket', put({ id: 'bucket', title: 'Bucket', group: 'Cloud', fields: {}, relations: {} }))).status).toBe(200)
  expect((await admin('/v1/blueprints/disk', put({ id: 'disk', title: 'Disk', group: 'Cloud', fields: {}, relations: { platform_team: { target: 'crew' } } }))).status).toBe(200)
  expect((await admin('/v1/blueprints/badge', put({ id: 'badge', title: 'Badge', group: 'Office', fields: {}, relations: {} }))).status).toBe(200)
})

afterAll(async () => {
  await hub.close()
})

describe('relation conventions', () => {
  it('are none until someone sets them, and then name each blueprint of a held group that falls short', async () => {
    expect(await (await admin('/v1/conventions')).json()).toEqual({ conventions: [] })
    expect(await unmet()).toEqual([])
    expect((await admin('/v1/conventions', put({ conventions: [platform] }))).status).toBe(200)
    expect(await unmet()).toEqual([expect.objectContaining({ level: 'amber', blueprint: 'bucket', title: 'Bucket has no platform_team' })])
  })

  it('clear a finding once the blueprint gains the relation', async () => {
    expect((await admin('/v1/blueprints/bucket', put({ id: 'bucket', title: 'Bucket', group: 'Cloud', fields: {}, relations: { platform_team: { target: 'crew' } } }))).status).toBe(200)
    expect(await unmet()).toEqual([])
  })

  it('refuse two conventions with one id, and need model.edit to change', async () => {
    expect((await admin('/v1/conventions', put({ conventions: [platform, platform] }))).status).toBe(400)
    expect((await as('someone@example.org')('/v1/conventions', put({ conventions: [] }))).status).toBe(403)
  })

  it('are owned by a git source while it declares them, and left to people when it stops', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orrery-conventions-'))
    const source = await hub.sources.save('estate', { title: 'Estate', class: 'git', blueprints: ['*'], deleteGrant: [], cadence: null, git: { url: 'https://example.org/estate.git', branch: 'main', glob: '**/*.yaml' } })
    const office = { id: 'office', groups: ['Office'], relations: ['platform_team'] }
    writeFileSync(join(dir, 'conventions.yaml'), `config:\n  conventions: ${JSON.stringify([office])}\n`)
    expect((await applyCatalog(hub, source, dir, '**/*.yaml')).errors).toEqual([])
    expect(await (await admin('/v1/conventions')).json()).toEqual({ conventions: [office], source: 'estate' } satisfies Conventions)
    expect(await unmet()).toEqual([expect.objectContaining({ blueprint: 'badge' })])
    expect((await admin('/v1/conventions', put({ conventions: [platform] }))).status).toBe(409)

    writeFileSync(join(dir, 'conventions.yaml'), 'entities: []\n')
    expect((await applyCatalog(hub, source, dir, '**/*.yaml')).errors).toEqual([])
    expect(await (await admin('/v1/conventions')).json()).toEqual({ conventions: [office] })
    expect((await admin('/v1/conventions', put({ conventions: [] }))).status).toBe(200)
    expect(await unmet()).toEqual([])
  })
})
