// The spans the hub's own work runs in. A background pass is a root span of
// its own, named by its job; a timed task is a span inside whatever runs it,
// or a root where nothing does. Until `startTelemetry` sets a provider they
// are no-ops, so tests and tools that never start it make none.

import { context, ROOT_CONTEXT, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api'

/** Runs `fn` inside a span called `name`, ended when `fn` settles and marked as an error when it throws. */
export async function inSpan<T>(name: string, fn: () => Promise<T>, opts: { root?: boolean } = {}): Promise<T> {
  const parent = opts.root ? ROOT_CONTEXT : context.active()
  const span = trace.getTracer('orrery').startSpan(name, { kind: SpanKind.INTERNAL }, parent)
  try {
    return await context.with(trace.setSpan(parent, span), fn)
  } catch (error) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.message : String(error) })
    throw error
  } finally {
    span.end()
  }
}
