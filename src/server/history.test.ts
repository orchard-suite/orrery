import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { metrics } from '@opentelemetry/api'
import { MeterProvider, MetricReader } from '@opentelemetry/sdk-metrics'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ServerEvent } from '../shared/api.ts'
import type { Entity, TrendValue } from '../shared/model.ts'
import { metricItemsOf } from './appinsights.ts'
import { loadConfig } from './config.ts'
import { spanEnd, trendOf } from './history.ts'
import { createHub, type Hub } from './hub.ts'
import { FIELD_GAUGE } from './metrics.ts'

// The history the hub keeps of derived fields, the trends read from it, and the gauge of fields marked metric.

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://orrery:orrery@localhost:5433/orrery'
const DAY = 86_400_000

class Reader extends MetricReader {
  protected async onShutdown(): Promise<void> {}
  protected async onForceFlush(): Promise<void> {}
}

const reader = new Reader()
let hub: Hub
let token = ''

const session = (path: string, init?: RequestInit) => hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', ...init?.headers } }, { surface: 'session' })
const machine = (path: string, init?: RequestInit) => hub.app.request(path, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...init?.headers } }, { surface: 'machine' })
const body = (v: unknown) => ({ body: JSON.stringify(v) })
const saveBlueprint = (id: string, spec: unknown) => session(`/v1/blueprints/${id}`, { method: 'PUT', ...body(spec) })

async function reading(key: string, value: number): Promise<void> {
  const res = await machine(`/v1/ingest/entities/meter/${key}`, { method: 'PUT', ...body({ title: key, fields: { reading: value } }) })
  expect([200, 201], await res.clone().text()).toContain(res.status)
}
const points = async (key: string, field: string) =>
  (await hub.db.query<{ at: Date; value: unknown }>('SELECT at, value FROM field_history WHERE blueprint = $1 AND key = $2 AND field = $3 ORDER BY at', ['meter', key, field])).rows
const listed = async (key: string) => ((await (await session('/v1/entities?blueprint=meter&limit=100')).json()) as { entities: Entity[] }).entities.find((e) => e.key === key)!
const entity = async (key: string) => (await (await session(`/v1/entities/meter/${key}`)).json()) as Entity

const METER = {
  title: 'Meter',
  fields: {
    reading: { type: 'number' },
    doubled: { type: 'number', calculation: 'reading * 2', history: { keep: '730d' }, metric: true },
    level: { type: 'enum', values: ['low', 'mid', 'high'], calculation: "reading > 20 ? 'high' : reading > 10 ? 'mid' : 'low'", history: { keep: '730d' }, metric: true },
    plain: { type: 'number', calculation: 'reading + 1' },
    doubled_trend: { type: 'trend', history: { of: 'doubled', every: '1w', last: '4w' } },
    level_trend: { type: 'trend', history: { of: 'level', every: '1w', last: '4w' } },
  },
  relations: {},
}

beforeAll(async () => {
  // The meter is set before the hub is made, as main.ts does.
  metrics.setGlobalMeterProvider(new MeterProvider({ readers: [reader] }))
  hub = await createHub(loadConfig({ DATABASE_URL, DATA_DIR: mkdtempSync(join(tmpdir(), 'orrery-')), AUTH_MODE: 'none' }), 'test', { reset: true })
  await hub.sources.save('estate', { title: 'estate', class: 'pusher', blueprints: ['*'], deleteGrant: [], cadence: null })
  token = (await hub.sources.issueToken('source', 'estate', { source: 'estate' })).token
  const res = await saveBlueprint('meter', METER)
  expect(res.status, await res.clone().text()).toBe(200)
})

afterAll(async () => {
  await hub.close()
  metrics.disable()
})

describe('a field that keeps a history', () => {
  it('is only a derived number or enum, and a trend reads only a field that keeps one', async () => {
    const refused = async (fields: Record<string, unknown>, says: string) => {
      const res = await saveBlueprint('odd', { title: 'Odd', fields: { n: { type: 'number' }, ...fields } })
      expect(res.status).toBe(400)
      expect(((await res.json()) as { error: string }).error).toContain(says)
    }
    await refused({ kept: { type: 'number', history: { keep: '30d' } } }, 'only a derived field')
    await refused({ kept: { type: 'string', calculation: 'n', history: { keep: '30d' } } }, 'only a number or an enum keeps a history')
    await refused({ kept: { type: 'number', calculation: 'n', history: { keep: 'soon' } } }, 'Bad duration')
    await refused({ t: { type: 'trend', history: { of: 'n', every: '1w', last: '4w' } } }, 'keeps no history')
    await refused({ k: { type: 'number', calculation: 'n', history: { keep: '7d' } }, t: { type: 'trend', history: { of: 'k', every: '1w', last: '4w' } } }, 'reaches farther back')
    await refused({ k: { type: 'number', calculation: 'n', history: { keep: '730d' } }, t: { type: 'trend', history: { of: 'k', every: '1d', last: '500d' } } }, 'at most 400')
    await refused({ m: { type: 'string', metric: true } }, 'only a number or an enum is exported')
  })

  it('records a point only when the value moved', async () => {
    await reading('m1', 5)
    await hub.history.record()
    expect((await points('m1', 'doubled')).map((p) => p.value)).toEqual([10])
    expect((await points('m1', 'level')).map((p) => p.value)).toEqual(['low'])
    // A field without history keeps none.
    expect(await points('m1', 'plain')).toEqual([])
    await hub.history.record()
    expect(await points('m1', 'doubled')).toHaveLength(1)
    await reading('m1', 6)
    await hub.history.record()
    expect((await points('m1', 'doubled')).map((p) => p.value)).toEqual([10, 12])
    // The level did not move, so it has no new point.
    expect((await points('m1', 'level')).map((p) => p.value)).toEqual(['low'])
  })

  it('lets go of points older than it keeps, all but the one held when the window opens', async () => {
    await hub.db.query("DELETE FROM field_history WHERE key = 'm1'")
    const insert = (daysAgo: number, value: number) => hub.db.query("INSERT INTO field_history (blueprint, key, field, at, value) VALUES ('meter', 'm1', 'doubled', $1, $2)", [new Date(Date.now() - daysAgo * DAY), JSON.stringify(value)])
    await insert(900, 2)
    await insert(800, 4)
    await insert(100, 12)
    await hub.history.record()
    expect((await points('m1', 'doubled')).map((p) => p.value)).toEqual([4, 12])
  })

  it('drops what a field no longer keeps', async () => {
    await saveBlueprint('meter', { ...METER, fields: { ...METER.fields, plain: { type: 'number', calculation: 'reading + 1', history: { keep: '30d' } } } })
    await hub.history.record()
    expect((await points('m1', 'plain')).map((p) => p.value)).toEqual([7])
    expect((await saveBlueprint('meter', METER)).status).toBe(200)
    await hub.history.record()
    expect(await points('m1', 'plain')).toEqual([])
  })
})

describe('a trend read from history', () => {
  it('holds the value at the end of each week, the weeks on the grid from the epoch, the newest under way', () => {
    const WEEK = 7 * DAY
    const now = Date.UTC(2026, 10, 7)
    // The epoch began on a Thursday, so a week's spans end on Thursdays; the newest ends after now.
    const end = spanEnd(now, WEEK)
    expect(new Date(end).getUTCDay()).toBe(4)
    expect(end).toBeGreaterThan(now)
    expect(end - now).toBeLessThanOrEqual(WEEK)
    const before = (ms: number) => new Date(end - ms)
    const history = [
      { at: before(3 * WEEK + 2 * DAY), value: 1 },
      { at: before(2 * WEEK + DAY), value: 3 },
      { at: before(2 * WEEK), value: 4 },
      { at: before(WEEK + DAY), value: 5 },
    ]
    const trend = trendOf(history, { type: 'number' }, { of: 'x', every: '1w', last: '4w' }, now)
    // A point on a span's end belongs to that span; the newest span holds the value held now.
    expect(trend).toEqual({
      points: [
        { at: before(3 * WEEK).toISOString(), value: 1 },
        { at: before(2 * WEEK).toISOString(), value: 4 },
        { at: before(WEEK).toISOString(), value: 5 },
        { at: before(0).toISOString(), value: 5 },
      ],
      from: before(4 * WEEK).toISOString(),
      to: before(0).toISOString(),
    })
    // Anywhere in the same span, the trend reads the same.
    expect(trendOf(history, { type: 'number' }, { of: 'x', every: '1w', last: '4w' }, end - 1)).toEqual(trend)
    const levels = trendOf([{ at: before(3 * WEEK + 5 * DAY), value: 'low' }, { at: before(WEEK + 2 * DAY), value: 'high' }], { type: 'enum', values: ['low', 'mid', 'high'] }, { of: 'x', every: '1w', last: '4w' }, now)
    expect(levels).toMatchObject({ step: true, min: 0, max: 2, labels: { '0': 'low', '1': 'mid', '2': 'high' } })
    expect(levels?.points.map((p) => p.value)).toEqual([0, 0, 2, 2])
    expect(trendOf([], { type: 'number' }, { of: 'x', every: '1w', last: '4w' }, now)).toBeNull()
  })

  it('reads the history of the entity it is on', async () => {
    await reading('m2', 1)
    await hub.db.query("DELETE FROM field_history WHERE key = 'm2'")
    const WEEK = 7 * DAY
    const end = spanEnd(Date.now(), WEEK)
    for (const [at, value] of [[end - 3 * WEEK - DAY, 2], [end - WEEK - DAY, 6], [Date.now() - 60_000, 2]] as const) {
      await hub.db.query("INSERT INTO field_history (blueprint, key, field, at, value) VALUES ('meter', 'm2', 'doubled', $1, $2)", [new Date(at), JSON.stringify(value)])
    }
    // Points written by hand are derived by hand: nothing wrote them through the hub.
    await hub.deriver.inline([{ blueprint: 'meter', key: 'm2' }])
    const trend = (await entity('m2')).fields.doubled_trend as TrendValue
    expect(trend.points.map((p) => p.value)).toEqual([2, 2, 6, 2])
    expect(trend.step).toBeUndefined()
  })

  it('is read again when a new point lands, and the point names only its blueprint as moved', async () => {
    await saveBlueprint('other', { title: 'Other', fields: {}, relations: {} })
    await reading('m3', 3)
    await hub.history.record()
    const before = (await entity('m3')).fields.doubled_trend as TrendValue
    expect(before.points.at(-1)?.value).toBe(6)
    await reading('m3', 30)
    // The write moved the entity; its trend reads history alone, so the kept listing holds the old value until a point lands.
    expect(((await listed('m3')).fields.doubled_trend as TrendValue).points.at(-1)?.value).toBe(6)
    expect(((await listed('m3')).fields.doubled_trend as TrendValue).points.at(-1)?.value).toBe(6)
    const heard: ServerEvent[] = []
    const stop = hub.events.subscribe((e) => heard.push(e))
    await hub.history.record()
    stop()
    expect(heard).toEqual([{ type: 'estate', blueprints: ['meter'], at: expect.any(Number) }])
    const after = await listed('m3')
    expect((after.fields.doubled_trend as TrendValue).points.at(-1)?.value).toBe(60)
    expect((after.fields.level_trend as TrendValue).points.at(-1)).toMatchObject({ value: 2 })
  })
})

describe('the gauge of fields marked metric', () => {
  it('reports the marked fields of every entity, and nothing else', async () => {
    const { resourceMetrics } = await reader.collect()
    const gauge = resourceMetrics.scopeMetrics.flatMap((s) => s.metrics).find((m) => m.descriptor.name === FIELD_GAUGE)
    const seen = (gauge?.dataPoints ?? []).map((p) => ({ ...p.attributes, value: p.value }))
    expect(new Set(seen.map((p) => (p as Record<string, unknown>).field))).toEqual(new Set(['doubled', 'level']))
    expect(seen).toContainEqual({ blueprint: 'meter', field: 'doubled', key: 'm3', value: 60 })
    expect(seen).toContainEqual({ blueprint: 'meter', field: 'level', key: 'm3', value: 2 })
    // Application Insights is sent the gauge alone, as a custom metric with the labels as its dimensions.
    const items = metricItemsOf(resourceMetrics, 'key', new Set([FIELD_GAUGE]))
    expect(items.length).toBe(seen.length)
    expect(items.every((i) => i.data.baseType === 'MetricData')).toBe(true)
    expect(items).toContainEqual(expect.objectContaining({ data: { baseType: 'MetricData', baseData: { ver: 2, metrics: [{ name: FIELD_GAUGE, kind: 0, value: 60, count: 1 }], properties: { blueprint: 'meter', field: 'doubled', key: 'm3' } } } }))
  })
})
