# ADR-5003: A report's layout is blocks, drawn by one drawer

| | |
|---|---|
| **Decision Date** | 2026-11-18 |
| **Decision Maker** | Orrery maintainers |
| **Last Updated** | 2026-11-18 |

## Status

Accepted

## Audience

Anyone who adds a block, changes how an edition looks, or writes a layout.

## Purpose

Settles what a person or an agent writes for a report, and how the hub
draws it.

## Context

A report must read the same in the hub and in mail, look like the hub,
and take its numbers only from data. Free HTML would let a layout put
anything on the hub's page, look different in every report, and let a
model invent numbers.

## Decision

A layout is a short Markdown document: front matter naming the data sets
and the writer, then headings, paragraphs, and fenced blocks (`stats`,
`chart` of `trend`, `bars`, or `delta`, `table`, `scorecard`, `narrative`), each a small
YAML map. Every non-narrative block names a data set. `parseLayout` in
`src/shared/report.ts` names every problem in one pass with its line, and
refuses an unknown block, key, or data set. `drawEdition` in
`src/shared/report-draw.ts` is the one drawer: a `web` profile on the
theme's tokens and an `email` profile of inline styles and tables.
Everything it draws from data or prose is escaped.

## What this means for the code

- A new block is a kind in `BLOCK_KINDS`, its reading in `parseLayout`, its
  content in `buildContent`, and its drawing in both profiles.
- An edition keeps its blocks as drawn from (`EditionContent`), so it reads
  the same for as long as it is kept.

## Verification

`src/shared/report.test.ts` checks the grammar's errors and lines, the
numbers and changes, and that both profiles escape what they draw.

## Consequences

People never write HTML. An agent mends a layout from the error message,
and `check_report_layout` reads one before an edit. A structural edit API
for layouts is not built; an edit sends the whole layout.

## Related

Platform standard `design-agent-authored-formats-for-low-syntax-risk-and-a-fast`.
