# ADR-5006: A report judges a number by two marks

| | |
|---|---|
| **Decision Date** | 2026-11-19 |
| **Decision Maker** | Orrery maintainers |
| **Last Updated** | 2026-11-19 |

## Status

Accepted

## Audience

Anyone who adds a way for a report to say that a number is good or bad.

## Purpose

Settles how a report shows health, so every report shows it the same way and no layout carries colours or rules of its own.

## Context

An edition showed every number in the same ink: a pass rate of 84 read as
100 did. A team's weekly report is read for what is off track, and a
scorecard of the things it covers, one row each with a mark and a short
trend, is the page people look at first. Letting a layout pick colours or
write conditions would give every report its own look and its own little
language.

## Decision

A layout judges a number by two marks, `good` and `bad`. Higher is better
where `good` is the larger, lower where it is the smaller. A number at or
past `good` is on track, one short of `bad` is off track, and one between
is to watch. `toneOf` in `src/shared/report.ts` is the one reading.

Three places take the marks: a `stats` item, a column of a `table`
(`health`), and a column of a `scorecard`. A `scorecard` block is one row a
thing: its name, a mark for the worst of its judged numbers, its numbers,
and a `trend` of small bars, one a column, which the same two marks may
judge. A layout sets no colour and writes no condition.

The drawer shows a tone as a shape with a name and a colour, never colour
alone, in both profiles. An edition keeps each tone it worked out, so it
reads the same whatever the marks become.

## What this means for the code

- A new place a report shows health takes `good` and `bad` and asks
  `toneOf`; it never takes a colour, a word, or a rule.
- A tone's shape, name, and colour are `MARK` and the tone tokens in
  `src/shared/report-draw.ts` and `styles.css`, and nothing else names them.
- A mail's header carries the report's home and its date in the edition's
  own time zone (`home` and `zone` on `EditionContent`): the zone of the
  schedule that fired it, else its owner's.

## Verification

`src/shared/report.test.ts` holds the reading of the marks, the scorecard, and both drawings.

## Consequences

Reports show health alike and stay comparable. A judgment two marks cannot say, such as one that reads two columns, belongs in the data set as a column of its own.

## Related

- [ADR-5003](5003-report-layout-is-blocks.md): the layout is blocks.
- [ADR-5005](5005-the-query-page-shapes-a-report-composes.md): the Query page shapes, a report composes.
