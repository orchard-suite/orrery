# ADR-4003: An action caps its runs in flight

| | |
|---|---|
| **Decision Date** | 2026-11-20 |
| **Decision Maker** | Orrery maintainers |
| **Last Updated** | 2026-11-22 |

## Status

Accepted

## Audience

Anyone who changes how a run starts, is handed on, or ends, or who writes an
action whose backend can only take a few calls at once.

## Purpose

Settles how many runs of one action may be in flight at once, so a backend
that does one call at a time is never handed ninety together.

## Context

About ninety runs of one webhook action were approved at once. The hub sent
every call at the same moment. The backend took one at a time, so most
calls waited in its line until the hub gave up on them. Webhook runs passed
no gate: only runner and caller runs were held back, by `serial`, and
`serial` also cancels older waiting runs, which throws away batch work.

## Decision

An action may say `concurrency: <n>`: at most `n` of its runs are in flight
at once, on any entity, across every single run, batch, and change set.

`start` in `actions.ts` is the one gate. A run takes its turn there under a
lock on the action (and on the line, for `serial`), so a runner's claim, a
caller's start, and every hand-off to a webhook or a workflow pass it, on
any hub. The hub's own hand-offs wait behind what was queued first
(`TURN_ORDER`): single runs, then batch runs, oldest first. A run that
waits stays `queued`, and its log says `waits its turn`. Nothing is
cancelled, dropped, or replaced.

A run that ends, or is put back to be tried again, hands on the next
(`pump`); `turns` on a timer is the backstop for a hub that stopped while
it held a turn. The save refuses the setting where a run could never wait:
the hub's own backends and a webhook that reveals its answer.

## What this means for the code

- A new way to start a run goes through `start`, never around it.
- A new way for a run to end, or to be put back, calls `pump`.

## Verification

`src/server/webhook-wait.test.ts` and `src/server/actions.test.ts` hold three
batches approved at once against a slow webhook under a limit of one, a
limit of two, and a caller's second start refused until the first ends.

## Consequences

A slow backend gets calls as fast as it answers them, and every run still
happens. A run may wait a long time for its turn: one made as a person
keeps a grant to call as its approver until it starts (ADR-2001).

## Related

- `docs/actions.md`, "A few at a time".
- ADR-5009, a change set keeps each action's `concurrency`.
