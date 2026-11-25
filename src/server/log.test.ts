import { Hono } from 'hono'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Jobs } from './jobs.ts'
import { createLogger } from './log.ts'
import { timed } from './metrics.ts'
import { inSpan } from './spans.ts'
import type { AppEnv } from './auth.ts'
import { startTelemetry, traced, type Telemetry } from './telemetry.ts'

let telemetry: Telemetry

/** The lines `fn` writes to stdout, parsed. */
async function linesOf(fn: () => Promise<void>): Promise<Record<string, unknown>[]> {
  const written: string[] = []
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    written.push(String(chunk))
    return true
  })
  try {
    await fn()
  } finally {
    spy.mockRestore()
  }
  return written.flatMap((w) => w.split('\n')).filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
}

beforeAll(async () => {
  // Nothing set: no span is sent anywhere, and spans are still made.
  telemetry = await startTelemetry(createLogger('test'), 'test', {})
})

afterAll(async () => {
  await telemetry.shutdown()
})

// The tests run at LOG_LEVEL=error: every line here is written as an error so it is written at all.
describe('log lines', () => {
  it('name their time timestamp, with level and msg', async () => {
    const [line] = await linesOf(async () => createLogger('test').error('hello', { n: 1 }))
    expect(line).toMatchObject({ level: 'error', msg: 'hello', component: 'test', n: 1 })
    expect(Number.isNaN(Date.parse(String(line?.timestamp)))).toBe(false)
    expect(line).not.toHaveProperty('ts')
  })

  it('carry no trace id outside any span', async () => {
    const [line] = await linesOf(async () => createLogger('test').error('alone'))
    expect(line).not.toHaveProperty('trace_id')
  })

  it("carry a background pass's trace id, each pass a trace of its own", async () => {
    const log = createLogger('test')
    const jobs = new Jobs(log)
    let passes = 0
    jobs.add('lookout', 60_000, async () => {
      passes++
      log.error('looked')
      await timed('findings', async () => log.error('inside a task'))
    })
    // Started inside another span, as a hub takes the lead inside a request's work: the pass is still a root.
    const lines = await linesOf(() =>
      inSpan('outer', async () => {
        log.error('outer')
        jobs.start()
        await vi.waitFor(() => expect(passes).toBe(1))
        await jobs.stop()
      }),
    )
    const outer = lines.find((l) => l.msg === 'outer')
    const looked = lines.find((l) => l.msg === 'looked')
    const task = lines.find((l) => l.msg === 'inside a task')
    expect(looked?.trace_id).toMatch(/^[0-9a-f]{32}$/)
    expect(looked?.trace_id).not.toBe(outer?.trace_id)
    // A timed task is a span inside the pass: the same trace, its own span.
    expect(task?.trace_id).toBe(looked?.trace_id)
    expect(task?.span_id).not.toBe(looked?.span_id)
  })

  it('carry a timed task\'s trace id where no pass runs it', async () => {
    const [line] = await linesOf(() => timed('findings', async () => createLogger('test').error('task alone')))
    expect(line?.trace_id).toMatch(/^[0-9a-f]{32}$/)
  })

  it("carry a request's trace id in what its handler logs", async () => {
    const log = createLogger('test')
    const app = new Hono<AppEnv>()
    app.use('*', traced)
    app.get('/v1/things/:id', (c) => {
      log.error('handled')
      return c.text('ok')
    })
    const lines = await linesOf(async () => {
      expect((await app.request('/v1/things/one', {}, { surface: 'session' })).status).toBe(200)
    })
    expect(lines.find((l) => l.msg === 'handled')?.trace_id).toMatch(/^[0-9a-f]{32}$/)
  })
})
