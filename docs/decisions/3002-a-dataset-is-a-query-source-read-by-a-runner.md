# ADR-3002: A table outside the catalog is a query source, read by a runner tool

| | |
|---|---|
| **Decision Date** | 2026-11-19 |
| **Decision Maker** | Orrery maintainers |
| **Last Updated** | 2026-11-19 |

## Status

Accepted

## Audience

Anyone who wants data from a warehouse or another store in a query or a report.

## Purpose

Settles how facts that live outside the catalog are read, without copying them in and without the hub holding a key.

## Context

Some facts are kept well in a store of their own: a lakehouse's summarised
views of test runs or costs. Pushing them into entities makes two stores to
keep in step. Reading them through a tool that answers one named question
per report puts an engineer on the path of every new number. Letting a
report carry its own SQL would hand whoever edits a report the runner's
whole reach, with no bound on what a statement costs.

## Decision

A **dataset** is a read tool with a `dataset` block: the entity it is called
on, the columns it answers with and their types, and how long an answer is
kept. It is called with no inputs and answers one table. A saved query reads
it as the source `$data:<id>`, with its columns as fields, so the Query page
filters, groups, totals, and charts it with the code it uses for a
blueprint, and a report reads it as any saved query.

Who may read a dataset is the action's own `access`, or the read tier on
its entity. Each read that calls the tool is a run of whoever read it. An
answer is kept in `dataset_answers` for the dataset's `fresh`, and bounded
by what one tool call carries. A dataset is never joined to the catalog.

## What this means for the code

- `src/server/datasets.ts` reads and keeps answers; `mayReadDataset` and
  `askDataset` in `actions.ts` judge and ask.
- `datasetBlueprint` in `src/shared/model.ts` is a dataset as the query code
  takes a blueprint; `queries.ts` reads its rows and judges a source's
  conditions on them with `matches`.
- A new store is a new tool on a runner. The hub gains no connector, no
  credential, and no query language of its own.

## Verification

`src/server/datasets.test.ts` holds the checks on a definition, who is listed one, typed rows, the kept answer, filters and groups, and a shared query for a reader it is not open to.

## Consequences

People build on warehouse facts without an engineer per question. A new column is still a change to the published table, by whoever owns the store. Rows are as fresh as the last read.

## Related

Platform standard `keep-reports-to-frozen-catalog-snapshots-and-live-series-in-`, `self-service-cloud-operations-run-as-a-narrow-machine-identi`, `lend-an-agent-telemetry-through-the-hub-s-tool-door-never-th`; [ADR-5005](5005-the-query-page-shapes-a-report-composes.md).
