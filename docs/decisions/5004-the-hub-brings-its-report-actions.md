# ADR-5004: The hub brings the actions of its own reports

| | |
|---|---|
| **Decision Date** | 2026-11-19 |
| **Decision Maker** | Orrery maintainers |
| **Last Updated** | 2026-11-19 |

## Status

Accepted

## Audience

Anyone who adds a thing the hub keeps itself and wonders whether an estate must define its actions.

## Purpose

Settles who defines the actions that make and change a report.

## Context

Reports change only through actions with the `report` backend
([ADR-5002](5002-reports-change-through-actions.md)). At first each estate
wrote those actions itself, six or more of them, from the guide, before
anyone could make a report. The web app could not offer a form of its own
either: it did not know which action of an estate made a report.

## Decision

The hub keeps its own report actions, under ids starting `orrery_`, as it
keeps its own blueprints: `orrery_report_new`, `_edit`, `_restore`,
`_preview`, `_publish`, `_recipients`, `_hand`, and `_remove`. They are
defined in `HUB_ACTIONS` in `builtin.ts` and saved at start with the origin
`hub`. Nobody else changes or removes one, and no other action takes an id
with that prefix. Each is open to everyone, because the backend judges who
may change the report. An estate that wants an approval or a rule defines
its own action beside them.

They name no platform, vendor, or way of organising an estate, so the rule
that the hub ships no catalog stands: they act only on the hub's own
blueprint.

## What this means for the code

- `HUB_ACTIONS` in `src/server/builtin.ts` is the list; `ensureBuiltins` in
  `actions.ts` saves it and removes a hub action the release no longer
  brings.
- The web app runs these ids by name, from the Reports page and a report's
  own page. They are no tile on the self-service page, and the welcome
  tour never picks one.
- A new thing the hub keeps for itself brings its actions the same way.

## Verification

`src/server/reports.test.ts` runs the hub's actions and holds that an admin can neither change nor remove one, nor take the prefix.

## Consequences

An estate makes a report with no setup beyond a writer tool. It can no longer rename or restyle these actions; it adds its own beside them.

## Related

Platform standard `the-hub-ships-no-catalog-the-model-belongs-to-the-user`, `extend-the-existing-actions-engine-every-run-goes-to-the-led`; [ADR-5002](5002-reports-change-through-actions.md).
