# ADR-5007: A person's stars order the catalog, never a query

| | |
|---|---|
| **Decision Date** | 2026-11-19 |
| **Decision Maker** | Orrery maintainers |
| **Last Updated** | 2026-11-19 |

## Status

Accepted

## Audience

Anyone who changes how the catalog's grids order their rows, or how a query, an export, a schedule, or a report reads the catalog.

## Purpose

Settles where a person's favorites may change what the hub answers, so the convenience of finding things never moves what others are handed.

## Context

People come back to a few things of each kind: a couple of services, a
couple of pipelines, a few storage accounts. They asked to star them, find
them first wherever they look, and see them all in one place. The hub
already orders a grid's rows in SQL (`orderParts` in `query.ts`) and keeps
each grid's shape per question and person (`lists.ts`). A query is a
different thing: it is saved, shared, exported, scheduled, and read by
reports, and what it answers is handed on to people downstream.

## Decision

A star is a person's own, kept on every device in the `stars` table, one
row an entity. There is no limit to how many a person keeps: the cost of a
star is an indexed lookup per row ordered, whatever the count.

Every catalog grid a person reads puts what they starred first, whatever
its sort, and first inside each group, leaving the groups in their order.
The filter still decides which rows show. A grid row and an entity page say
`starred: true` for the reader.

A query never reads stars: no condition, no column, no order, and nothing
in the query text. So a query, its export, a schedule's firing, and a
report's data read the same for everyone. The favorites page is one table
of what a person starred, built by giving the query code each blueprint's
keys; the query code knows nothing of stars.

A blueprint is starred as a pin of the `blueprint` kind, and comes first in
the person's catalog list, under Starred, and stays in its group too. A star
is one more way in: a person who looks for a kind where everyone keeps it
still finds it there.

A star to something the person may no longer see is kept, never shown or
counted, and shows again when they may. It goes only when the hub purges
the entity it names, and moves with a blueprint that is renamed.

## What this means for the code

- `starredBy` on a grid's question puts the reader's stars first in
  `orderParts`, after the group and before the sort. Only the catalog's
  routes set it: `/v1/entities` and `search_entities`. `queries.ts` never
  does.
- The order is no part of a kept listing's shape, so a star rebuilds
  nothing kept. A grid's tag names the reader's star stamp, and a cursor
  names the reader, so neither outlives a star.
- `/v1/mine/stars` and its routes are a person's own, as the pins' are: no
  permission, no activity row, none for a machine.
- The purge lets go of the stars of what it removes, in its transaction.
- A grid where the reader starred nothing is ordered and marked without
  stars: it costs one count. Where stars order it, the load ledger notes the
  read under `star` by blueprint, and the Load page lists what stars cost
  each kind's grids beside how many it holds and how many people keep them.

## Verification

`src/server/stars.test.ts` holds a grid's order, a group's order, paging,
the tag, what may not be seen, the purge, the rename, and that a query's
rows are the same before and after a star.

## Consequences

A person finds their own first everywhere they browse. An analyst's query
gives the same rows whoever runs it. A favorites view that should be a
saved query is not one: it lives on its own page.

## Related

- [ADR-5005](5005-the-query-page-shapes-a-report-composes.md): the Query page shapes data a report composes.
