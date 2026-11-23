# ADR-6002: A source is judged by what it promised

| | |
|---|---|
| **Decision Date** | 2026-11-22 |
| **Decision Maker** | Orrery maintainers |
| **Last Updated** | 2026-11-22 |

## Status

Accepted

## Audience

Anyone who changes how a source's status is worked out, or registers a
source.

## Purpose

Settles when a source is grey: only when it broke a promise about time it
made.

## Context

A source's status is grey when it is stale. Before this record, a source
with no cadence was also grey until it first reported, and green forever
after, however long it went quiet. So the first silence was a fault and
every later one was not.

That rule turned sources grey that were never meant to report on a clock:
the source an action's `record` backend writes as, which waits for someone
to run the action; an app that writes only when an admin decides; a tool
that writes once for each apply. Each showed "never reported" on the
sources page and in the findings, though nothing was wrong. A `record`
write also never marked its source seen, so even a used action left its
source grey.

## Decision

A source's `cadence` is its one promise about time. A source with a
cadence is grey when it has never reported, or when it has been silent for
more than twice its cadence. A source with no cadence is never grey for
being quiet: it writes when something happens, and its status comes from
its last run alone.

A write by an action's `record` backend is its source's own write, as a
pusher's is, and marks the source seen.

## Consequences

- A source that should report on a schedule says so with a cadence, or
  nothing notices when it stops. A runner that should always be up sends a
  heartbeat and names its cadence.
- A source registered with a cadence it does not keep (a writer that only
  acts on events) is grey by its own word. The fix is to drop the cadence,
  never to make it report on a timer to stay green.
- A source nothing feeds and nothing names is not shown by its status any
  more. It is retired by hand.
