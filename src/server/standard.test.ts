import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { GridLayout } from '../shared/api.ts'
import { DEFAULT_STANDARD, type ColumnStandard } from '../shared/columns.ts'
import { applyCatalog } from './catalog.ts'
import { loadConfig } from './config.ts'
import { createHub, type Hub } from './hub.ts'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://orrery:orrery@localhost:5433/orrery'

let hub: Hub
const as = (email: string, groups = 'User') => (path: string, init?: RequestInit) => hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', 'x-forwarded-email': email, 'x-forwarded-groups': groups, ...init?.headers } }, { surface: 'session' })
const admin = as('admin@example.org', 'Admin')
const put = (v: unknown) => ({ method: 'PUT', body: JSON.stringify(v) })

beforeAll(async () => {
  const config = loadConfig({ DATABASE_URL, DATA_DIR: mkdtempSync(join(tmpdir(), 'orrery-')), AUTH_MODE: 'proxy' })
  hub = await createHub(config, 'test', { reset: true })
  expect((await admin('/v1/blueprints/gadget', put({ id: 'gadget', title: 'Gadget', fields: { sku: { type: 'string' } }, relations: {} }))).status).toBe(200)
})

afterAll(async () => {
  await hub.close()
})


const standard: Omit<ColumnStandard, 'source'> = {
  ranks: [
    { id: 'identity', columns: ['status', 'title'] },
    { id: 'ownership', columns: ['r:program', 'r:owner'] },
    { id: 'rest', columns: ['*'] },
  ],
  hidden: ['@pivot'],
}

describe('the column standard', () => {
  it('is the default until someone sets one, and a person may change it', async () => {
    expect(await (await admin('/v1/grid-standard')).json()).toEqual(DEFAULT_STANDARD)
    expect((await admin('/v1/grid-standard', put(standard))).status).toBe(200)
    expect(await (await admin('/v1/grid-standard')).json()).toEqual(standard)
    expect((await admin('/v1/grid-standard', put({ ranks: [] }))).status).toBe(400)
  })

  it('needs views.arrange to change', async () => {
    expect((await as('someone@example.org')('/v1/grid-standard', put(standard))).status).toBe(403)
  })

  it('is owned by a git source while it declares it, and left to people when it stops', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orrery-columns-'))
    const source = await hub.sources.save('estate', { title: 'Estate', class: 'git', blueprints: ['*'], deleteGrant: [], cadence: null, git: { url: 'https://example.org/estate.git', branch: 'main', glob: '**/*.yaml' } })
    const declared = { ...standard, hidden: ['@pivot', 'f:sku'] }
    writeFileSync(join(dir, 'columns.yaml'), `config:\n  columns: ${JSON.stringify(declared)}\n`)
    expect((await applyCatalog(hub, source, dir, '**/*.yaml')).errors).toEqual([])
    expect(await (await admin('/v1/grid-standard')).json()).toEqual({ ...declared, source: 'estate' })
    const refused = await admin('/v1/grid-standard', put(standard))
    expect(refused.status).toBe(409)

    writeFileSync(join(dir, 'columns.yaml'), 'entities: []\n')
    expect((await applyCatalog(hub, source, dir, '**/*.yaml')).errors).toEqual([])
    expect(await (await admin('/v1/grid-standard')).json()).toEqual(declared)
    expect((await admin('/v1/grid-standard', put(standard))).status).toBe(200)
  })
})

describe('a grid on the standard', () => {
  it('keeps what a person placed by hand and that it rides the standard', async () => {
    const layout = { arranged: 'standard', columns: [{ id: 'f:sku', after: 'title' }, { id: 'key', hidden: false, width: 90 }] }
    expect((await admin('/v1/grid/gadget', put(layout))).status).toBe(200)
    const read = (await (await admin('/v1/grid/gadget')).json()) as GridLayout
    expect(read.arranged).toBe('standard')
    expect(read.columns).toEqual(layout.columns)
  })
})
