# ADR-5002: A report is a hub record changed only by actions

| | |
|---|---|
| **Decision Date** | 2026-11-18 |
| **Decision Maker** | Orrery maintainers |
| **Last Updated** | 2026-11-19 |

## Status

Accepted

## Audience

Anyone who changes how reports are made, changed, or published, or adds a
new way to touch one.

## Purpose

Settles where a report lives and the one way it changes.

## Context

Teams get recurring reports from many systems, each with its own place for
the schedule, the instructions, the recipients, and the history. The hub
already has saved queries, runner tools, schedules, and actions with
per-entity rules, approvals, and a ledger.

## Decision

A report is an entity of the hub's reserved blueprint `orrery_report`,
written by the hub alone. It changes only through a run of an action with
the `report` backend (`create`, `edit`, `recipients`, `hand`, `remove`,
`publish`, `preview`). The backend judges the change as the person who ran it: the
report's owner, someone who owns its home, or an admin. Every layout is
kept in `report_versions`, so a version can be put back. `hand` gives a
report to a new owner with every schedule that runs on it, and is refused
unless they can read everything its layout names, since its data is read
as its owner. The routes under
`/v1/reports` only read.

## What this means for the code

- `src/server/reports.ts` is the only writer of a report and its editions.
- `src/shared/action-spec.ts` holds a report action to its verb's blueprint
  and its inputs by fixed names (`REPORT_INPUTS`).
- A new way to change a report is a new verb, never a route.

## Verification

`src/server/reports.test.ts` runs every verb through actions, refuses a
change by someone who neither owns the report nor its home, and puts back
an older version.

## Consequences

Who may ask, who approves, what was asked, and when come from the actions
engine and the ledger. The hub brings the report actions itself
([ADR-5004](5004-the-hub-brings-its-report-actions.md)). A no-sign-in hub's local admin counts as a person,
so a run asked as them acts as them.

## Related

Platform standard `extend-the-existing-actions-engine-every-run-goes-to-the-led`,
`sort-every-catalog-blueprint-as-inventory-record-history-or-`;
[ADR-5003](5003-report-layout-is-blocks.md), [ADR-3001](3001-editions-kept-beside-their-record.md).
