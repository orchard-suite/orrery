# ADR-5010: A run lives by being heard from

| | |
|---|---|
| **Decision Date** | 2026-11-21 |
| **Decision Maker** | Orrery maintainers |
| **Last Updated** | 2026-11-21 |

## Status

Accepted

## Audience

Anyone who changes when the hub gives up on a run, or adds a backend.

## Purpose

Settles when a run under way is given up: when the hub has not heard from
it, never because a fixed time from its start ran out.

## Context

The hub gave up a run once it had been running for `ACTION_TIMEOUT_MINUTES`,
an hour by default, whatever it was doing. A run that reported every minute
for two hours was given up at the first hour, and the only way round it
was a longer clock. Work that takes days, as one container for each run
(ADR-4002), cannot live under any fixed clock that is also short enough to
notice a dead backend.

## Decision

A run under way lives by being heard from. Every report counts, one that
carries nothing included. A run the hub has not heard from for its silence
window, counted from its last report or from its start, is given up as
`unknown`. A run that keeps reporting is never given up for how long it has
run.

An action may still name a hard `ceiling`, the longest a run may stay
running however often it is heard from.

`ACTION_TIMEOUT_MINUTES` keeps its name. Its documented meaning was always
how long a run may stay running without a report; the code now does what
that says. It is the silence window.

Each backend meets the rule the way it holds its work:

- A `webhook` or a `github_workflow` run is silent after the hub's window,
  and takes the action's `ceiling`. A workflow the hub watches is heard
  from each time its forge says it is still going.
- A `caller` run's own `timeout` is its silence window.
- A `runner` job is ended by its runner at its own `timeout`, so that and a
  short grace is its ceiling, and it takes no other. Its runner says while
  a quiet command runs that it still holds it.
- A `job` run's ceiling is its action's, 7 days when it names none; its
  starter says while the job runs that it does.

No existing action is given up sooner than before: silence since the last
report is never longer than the time since the start, and no ceiling is
shorter than the limit it replaces.

## What this means for the code

- `lifeOf` in `actions.ts` is the one reading of a run's silence window and
  ceiling, and `expire` the one place a run is given up. A new backend says
  there how it is heard from, and never keeps a clock of its own.
- Whatever speaks for a run stamps `heard_at`: `report`, and `heard` for
  word that changes nothing else, stored at most once a minute.
- A run given up is `unknown`, never `failed`, and is still its backend's
  to settle.

## Verification

`src/server/job-runs.test.ts` holds a run three days old kept while it
reports and one silent for an hour given up, a report that carries nothing
taken as word of the run and stored once a minute, a ceiling ending a run
that reports, and a runner's three hour job kept past the hub's hour while
its runner is heard from. `src/server/actions.test.ts` holds a long
workflow kept while its forge says it runs. `cmd/runner` holds the runner
saying it holds a quiet command.

## Consequences

Long work needs no long clock, and a dead backend is still noticed within
the hub's window. A backend that reports nothing for longer than the window
while it works is given up, as it was at the window's end before. A run
with no ceiling whose backend reports for ever runs for ever; name a
`ceiling` where that matters.

New to the platform standard, version 2026.1120.2003: no rule there covers
how a run is kept alive.

## Related

[ADR-4002](4002-a-job-action-runs-as-one-container-for-each-run.md).
`docs/actions.md`, A run lives by being heard from.
