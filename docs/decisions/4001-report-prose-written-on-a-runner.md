# ADR-4001: A report's prose is written on a runner

| | |
|---|---|
| **Decision Date** | 2026-11-18 |
| **Decision Maker** | Orrery maintainers |
| **Last Updated** | 2026-11-18 |

## Status

Accepted

## Audience

Anyone who changes how a narrative block gets its words.

## Purpose

Settles where the model that writes a report's prose runs.

## Context

The hub calls no model. Runner tools already run commands with keys the
hub never holds, and answer the caller in the same call.

## Decision

A report names a writer in its front matter: a runner tool on
`orrery_report` that takes `instruction` and `data`. For each narrative
block the hub calls it as the report's owner, on the report, with the
block's instruction and the data sets the block names (bounded by
`writerData`, with the headline numbers already worked out), and takes
what it prints as the prose. A failure or nothing printed is a gap the
edition shows, never a failed publish.

## What this means for the code

The hub keeps no model client, key, or prompt. Which model, and how it is
called, is the estate's runner command.

## Verification

`src/server/reports.test.ts` publishes with a writer the test answers as a
runner would.

## Consequences

The owner needs the writer's tier on the report: the estate's publish action
carries it (`access.tiers`). Numbers never come from the model.

## Related

[ADR-5003](5003-report-layout-is-blocks.md).
