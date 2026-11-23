# ADR-3001: Editions keep their body and data beside their record

| | |
|---|---|
| **Decision Date** | 2026-11-18 |
| **Decision Maker** | Orrery maintainers |
| **Last Updated** | 2026-11-18 |

## Status

Accepted

## Audience

Anyone who changes what an edition keeps, or how long.

## Purpose

Settles where an edition's body and data live, and when they go.

## Context

An edition is history people read and compare. Its record should stay
small, while its body and the data it read are what make it worth keeping.

## Decision

An edition is an entity of `orrery_report_edition`, history that expires
`REPORT_KEEP_DAYS` (730 by default) after `published_at`. Its blocks and its
data sets are kept in `report_editions`, a table no list reads, and read
only through the edition's routes. The lifecycle tick lets go of a kept
edition once its record is gone. A preview's drawing is kept with its run in
`report_previews` and let go with the run's pictures.

## What this means for the code

No file store and no estate setting are needed. A data set keeps at most
`DATA_ROWS_MAX` rows.

## Verification

`src/server/reports.test.ts` reads an edition's body and data, and removes
them with their report.

## Consequences

Kept editions grow the hub's database by their data. A report that reads
large data sets should narrow its saved queries.

## Related

Platform standard `sort-every-catalog-blueprint-as-inventory-record-history-or-`.
