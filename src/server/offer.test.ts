import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Blueprint } from '../shared/model.ts'
import { loadConfig } from './config.ts'
import { createHub, type Hub } from './hub.ts'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://orrery:orrery@localhost:5433/orrery'

let hub: Hub
let product = ''
let other = ''
const session = (path: string, init?: RequestInit) => hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', ...init?.headers } }, { surface: 'session' })
const machine = (path: string, init?: RequestInit, bearer = product) => hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}`, ...init?.headers } }, { surface: 'machine' })
const body = (v: unknown) => ({ body: JSON.stringify(v) })
const offer = async (blueprint: unknown, bearer = product) => (await machine('/v1/ingest/blueprints', { method: 'PUT', ...body({ blueprints: [blueprint] }) }, bearer)).json() as Promise<{ created: string[]; extended: string[]; kept: string[]; rejected: unknown[] }>
const stored = async (id: string) => (await (await session(`/v1/blueprints/${id}`)).json()) as Blueprint

const rule = (calculation: string, status = 'status') => ({
  id: 'gauge',
  title: 'Gauge',
  status: { field: status },
  fields: { reading: { type: 'number' }, status: { type: 'enum', values: ['red', 'green'], calculation }, verdict: { type: 'enum', values: ['red', 'green'], calculation } },
})

beforeAll(async () => {
  const config = loadConfig({ DATABASE_URL, DATA_DIR: mkdtempSync(join(tmpdir(), 'orrery-')), AUTH_MODE: 'none' })
  hub = await createHub(config, 'test', { reset: true })
  await hub.sources.save('product', { title: 'product', class: 'pusher', blueprints: ['*'], deleteGrant: [], cadence: null })
  await hub.sources.save('other', { title: 'other', class: 'pusher', blueprints: ['*'], deleteGrant: [], cadence: null })
  product = (await hub.sources.issueToken('source', 'product', { source: 'product' })).token
  other = (await hub.sources.issueToken('source', 'other', { source: 'other' })).token
})

afterAll(async () => {
  await hub.close()
})

describe('an offer that does not parse', () => {
  it('is refused with the reason when the blueprint exists, never kept', async () => {
    const widget = { id: 'widget', title: 'Widget', fields: { size: { type: 'number' } } }
    expect(await offer(widget)).toMatchObject({ created: ['widget'] })
    const res = await offer({ ...widget, fields: { ...widget.fields, kind: { type: 'enum', values: ['a', 'b'], colors: { b: 'gray' } } } })
    expect(res.kept).toEqual([])
    expect(res.rejected).toEqual([{ blueprint: 'widget', reason: expect.stringContaining('fields.kind.colors.b') }])
    expect((await stored('widget')).fields.kind).toBeUndefined()
  })
})

describe('a definition a source brought', () => {
  it('takes that source’s next definition while nobody has edited it', async () => {
    expect(await offer(rule("reading > 10 ? 'red' : 'green'"))).toMatchObject({ created: ['gauge'] })
    expect((await stored('gauge')).fields.status?.offered?.source).toBe('product')
    expect(await offer(rule("reading > 20 ? 'red' : 'green'"))).toMatchObject({ extended: ['gauge'] })
    expect((await stored('gauge')).fields.status?.calculation).toBe("reading > 20 ? 'red' : 'green'")
    // The same offer again changes nothing.
    expect(await offer(rule("reading > 20 ? 'red' : 'green'"))).toMatchObject({ kept: ['gauge'] })
  })

  it('stays as a person edited it, and another source never moves it', async () => {
    const bp = await stored('gauge')
    const res = await session('/v1/blueprints/gauge', { method: 'PUT', ...body({ ...bp, fields: { ...bp.fields, verdict: { ...bp.fields.verdict, calculation: "reading > 99 ? 'red' : 'green'" } } }) })
    expect(res.status, await res.clone().text()).toBe(200)
    await offer(rule("reading > 30 ? 'red' : 'green'"))
    const after = await stored('gauge')
    expect(after.fields.verdict?.calculation).toBe("reading > 99 ? 'red' : 'green'")
    expect(after.fields.status?.calculation).toBe("reading > 30 ? 'red' : 'green'")
    await offer(rule("reading > 40 ? 'red' : 'green'"), other)
    expect((await stored('gauge')).fields.status?.calculation).toBe("reading > 30 ? 'red' : 'green'")
  })

  it('cannot be claimed by a source sending the hub’s mark itself', async () => {
    const forged = rule("reading > 50 ? 'red' : 'green'")
    ;(forged.fields.status as Record<string, unknown>).offered = { source: 'other', hash: 'x' }
    await offer(forged, other)
    expect((await stored('gauge')).fields.status?.offered?.source).toBe('product')
  })

  it('still takes the source’s next definition after the estate sets a budget or a lock, and keeps both', async () => {
    const meter = (title: string, budget?: { max: number }) => ({ id: 'meter', title: 'Meter', fields: { lag: { type: 'number', title, ...(budget ? { budget } : {}) } } })
    expect(await offer(meter('Lag'))).toMatchObject({ created: ['meter'] })
    const bp = await stored('meter')
    const res = await session('/v1/blueprints/meter', { method: 'PUT', ...body({ ...bp, fields: { lag: { ...bp.fields.lag, budget: { max: 5 }, adminEdit: true } } }) })
    expect(res.status, await res.clone().text()).toBe(200)
    // The source's own budget, sent later, never moves the estate's.
    expect(await offer(meter('Lag, in hours', { max: 99 }))).toMatchObject({ extended: ['meter'] })
    expect((await stored('meter')).fields.lag).toMatchObject({ title: 'Lag, in hours', budget: { max: 5 }, adminEdit: true, offered: { source: 'product' } })
    expect(await offer(meter('Lag, in hours', { max: 99 }))).toMatchObject({ kept: ['meter'] })
  })
})

describe('a model someone imports', () => {
  const bed = { id: 'bed', title: 'Bed', fields: { weeds: { type: 'number' }, wait: { type: 'number' }, fenced: { type: 'boolean' } } }
  const bring = async (yaml: string) => {
    const res = await session('/v1/model/import', { method: 'POST', ...body({ yaml }) })
    expect(res.status, await res.clone().text()).toBe(200)
  }

  it('names the ground and the budgets on what a source brought, where there are none', async () => {
    expect(await offer(bed)).toMatchObject({ created: ['bed'] })
    await bring('blueprints:\n  - id: bed\n    title: Bed\n    ground: { loop: wait, unwanted: weeds, guards: [fenced] }\n    fields:\n      weeds: { type: number, budget: { max: 0 } }\n')
    const after = await stored('bed')
    expect(after.ground).toEqual({ loop: 'wait', unwanted: 'weeds', guards: ['fenced'] })
    expect(after.fields.weeds).toMatchObject({ budget: { max: 0 }, offered: { source: 'product' } })
    // The source still keeps the field current, and the budget stays.
    await offer({ ...bed, fields: { ...bed.fields, weeds: { type: 'number', title: 'Weeds' } } })
    expect((await stored('bed')).fields.weeds).toMatchObject({ title: 'Weeds', budget: { max: 0 } })
  })

  it('never moves a ground or a budget that is already set', async () => {
    await bring('blueprints:\n  - id: bed\n    title: Bed\n    ground: { loop: weeds }\n    fields:\n      weeds: { type: number, budget: { max: 9 } }\n')
    const after = await stored('bed')
    expect(after.ground?.loop).toBe('wait')
    expect(after.fields.weeds?.budget).toEqual({ max: 0 })
  })

  it('is the only one that names a ground: a source’s offer sets none on a blueprint that exists', async () => {
    const plot = { id: 'plot', title: 'Plot', fields: { wait: { type: 'number' } } }
    await offer(plot)
    expect(await offer({ ...plot, ground: { loop: 'wait' } })).toMatchObject({ kept: ['plot'] })
    expect((await stored('plot')).ground).toBeUndefined()
  })
})

describe('the status field a source chose', () => {
  it('is set where the blueprint has none, and moved only by the source that set it', async () => {
    const res = await session('/v1/blueprints/meter', { method: 'PUT', ...body({ title: 'Meter', fields: { level: { type: 'enum', values: ['red', 'green'] } } }) })
    expect(res.status).toBe(200)
    const meter = (field: string) => ({ id: 'meter', title: 'Meter', status: { field }, fields: { level: { type: 'enum', values: ['red', 'green'] }, state: { type: 'enum', values: ['red', 'green'] } } })
    expect(await offer(meter('level'))).toMatchObject({ extended: ['meter'] })
    expect((await stored('meter')).status?.field).toBe('level')
    await offer(meter('state'), other)
    expect((await stored('meter')).status?.field).toBe('level')
    await offer(meter('state'))
    expect((await stored('meter')).status?.field).toBe('state')
  })

  it('stays where a person put it', async () => {
    const bp = await stored('meter')
    expect((await session('/v1/blueprints/meter', { method: 'PUT', ...body({ ...bp, status: { field: 'level' } }) })).status).toBe(200)
    await offer({ id: 'meter', title: 'Meter', status: { field: 'state' }, fields: { state: { type: 'enum', values: ['red', 'green'] } } })
    expect((await stored('meter')).status?.field).toBe('level')
  })
})

describe('a definition handed to a source', () => {
  const hand = (id: string, v: unknown) => session(`/v1/blueprints/${id}/hand-over`, { method: 'POST', ...body(v) })
  const dial = (verdict: string, status = 'verdict') => ({
    id: 'dial',
    title: 'Dial',
    status: { field: status },
    fields: { reading: { type: 'number' }, verdict: { type: 'enum', values: ['red', 'green'], calculation: verdict }, state: { type: 'enum', values: ['red', 'green'], calculation: verdict } },
  })

  it('is taken from the source’s next offer, as if the source had brought it', async () => {
    // A person made the blueprint, so an offer only adds what it lacks.
    const made = await session('/v1/blueprints/dial', { method: 'PUT', ...body({ title: 'Dial', status: { field: 'state' }, fields: { reading: { type: 'number' }, verdict: { type: 'enum', values: ['red', 'green'], calculation: "reading > 1 ? 'red' : 'green'" }, state: { type: 'enum', values: ['red', 'green'] } } }) })
    expect(made.status, await made.clone().text()).toBe(200)
    await offer(dial("reading > 5 ? 'red' : 'green'"))
    expect((await stored('dial')).fields.verdict?.calculation).toBe("reading > 1 ? 'red' : 'green'")
    expect((await stored('dial')).status?.field).toBe('state')

    const res = await hand('dial', { source: 'product', fields: ['verdict'], status: true })
    expect(res.status, await res.clone().text()).toBe(200)
    const handed = await stored('dial')
    expect(handed.fields.verdict?.offered?.source).toBe('product')
    expect(handed.status?.offered).toEqual({ source: 'product', hash: 'state' })
    expect(handed.fields.reading?.offered).toBeUndefined()

    expect(await offer(dial("reading > 5 ? 'red' : 'green'"))).toMatchObject({ extended: ['dial'] })
    const after = await stored('dial')
    expect(after.fields.verdict?.calculation).toBe("reading > 5 ? 'red' : 'green'")
    expect(after.status?.field).toBe('verdict')
    // Another source's offer still moves nothing it was not handed.
    await offer(dial("reading > 9 ? 'red' : 'green'"), other)
    expect((await stored('dial')).fields.verdict?.calculation).toBe("reading > 5 ? 'red' : 'green'")
  })

  it('is recorded in the activity log', async () => {
    const rows = await hub.db.query<{ detail: { handedOver?: unknown } }>("SELECT detail FROM changes WHERE kind = 'blueprint.changed' AND blueprint = 'dial' AND detail ? 'handedOver'")
    expect(rows.rows.map((r) => r.detail.handedOver)).toEqual([{ source: 'product', fields: ['verdict'], status: true }])
  })

  it('refuses an unknown source, a field the blueprint lacks, a blueprint git defines, and nothing named', async () => {
    const refused = async (id: string, v: unknown, says: string) => {
      const res = await hand(id, v)
      expect(res.status).toBe(400)
      expect(((await res.json()) as { error: string }).error).toContain(says)
    }
    await refused('dial', { source: 'nobody', fields: ['verdict'] }, 'There is no source "nobody"')
    await refused('dial', { source: 'product', fields: ['verdict', 'absent'] }, 'has no field "absent"')
    await refused('dial', { source: 'product' }, 'Name the fields')
    await hub.db.query(`UPDATE blueprints SET origin = '{"kind":"git","source":"repo","file":"dial.yaml"}' WHERE id = 'dial'`)
    await hub.blueprints.load()
    await refused('dial', { source: 'product', fields: ['verdict'] }, 'defined in git')
  })
})
