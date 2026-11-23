# ADR-5005: The Query page shapes data, a report composes it

| | |
|---|---|
| **Decision Date** | 2026-11-19 |
| **Decision Maker** | Orrery maintainers |
| **Last Updated** | 2026-11-19 |

## Status

Accepted

## Audience

Anyone who adds to what a report block can do, or builds a way to edit a report.

## Purpose

Settles where the shape of a number or a chart is decided, so the hub grows one analysis tool and not two.

## Context

A report's blocks first described their own math and charts: which column
to sum, what goes along the bottom. The Query page already filters, groups,
totals, and charts an answer, and people know it. A second editor for the
same choices, inside a report builder, would turn the hub into a business
intelligence tool, which the estate already has elsewhere.

## Decision

A saved query reaches a report as its own view shapes it: a grouped view
gives one row a group with its totals, and the totals over every row ride
along. A `stats`, `chart`, or `table` block may name only its data and show
that shape. A person changes a number or a chart in its query.

A report is made and changed with a form that picks saved queries, orders
the blocks, and takes the instruction of each written summary. The form
writes the same Markdown layout an agent writes, through `printLayout`.
There is no designer: no reader filters, no drill-down, no visuals beyond
the layout's blocks, no page layout, and no math language. What needs those is
a query, or the estate's analysis tool, and a report links to it.

## What this means for the code

- `dataOfAnswer` in `src/server/reports.ts` is the one reading of a saved
  query's answer as a data set; `statsOf` and `chartOf` in
  `src/shared/report.ts` are what a block shows when it says nothing.
- `printLayout` and `draftOf` are the form's only way to and from text.
- A new block option that restates what a query's view can say is refused.

## Verification

`src/shared/report.test.ts` holds the defaults and the round trip of a layout through the form; `src/server/datasets.test.ts` holds a grouped answer as a data set.

## Consequences

Reports stay small and comparable. A report that needs a shape no query view gives must wait for the Query page to gain it.

## Related

Platform standard `keep-reports-to-frozen-catalog-snapshots-and-live-series-in-`, `design-agent-authored-formats-for-low-syntax-risk-and-a-fast`; [ADR-5003](5003-report-layout-is-blocks.md).
