import { metrics } from '@opentelemetry/api'
import { MeterProvider, MetricReader } from '@opentelemetry/sdk-metrics'
import { afterAll, describe, expect, it } from 'vitest'
import { createLogger } from './log.ts'
import { FIELD_GAUGE, METER_VIEWS, observeFields } from './metrics.ts'

class Reader extends MetricReader {
  protected async onShutdown(): Promise<void> {}
  protected async onForceFlush(): Promise<void> {}
}

afterAll(() => metrics.disable())

describe('field gauge', () => {
  it('exports every entity of a metric field, however many there are', async () => {
    const reader = new Reader()
    metrics.setGlobalMeterProvider(new MeterProvider({ views: METER_VIEWS, readers: [reader] }))
    const readings = Array.from({ length: 5_000 }, (_, i) => ({ blueprint: 'widget', field: 'size', key: `w-${i}`, value: i % 4 }))
    observeFields(async () => readings, createLogger('test'))
    const { resourceMetrics } = await reader.collect()
    const points = resourceMetrics.scopeMetrics.flatMap((s) => s.metrics).find((m) => m.descriptor.name === FIELD_GAUGE)?.dataPoints ?? []
    expect(points.filter((p) => p.attributes['otel.metric.overflow'])).toHaveLength(0)
    expect(new Set(points.map((p) => p.attributes.key)).size).toBe(5_000)
  })
})
