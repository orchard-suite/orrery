# Decisions

This folder is Orrery's record of decisions: one decision per record, with
the reasons behind it.

| Prefix | Category |
|---|---|
| 0xxx | Governance |
| 1xxx | Infrastructure |
| 2xxx | Security |
| 3xxx | Data |
| 4xxx | Compute |
| 5xxx | Development |
| 6xxx | Operations |

## Records

### Security

| Number | Title | Status | Last updated |
|---|---|---|---|
| [2001](2001-a-waiting-run-keeps-its-approvers-grant.md) | A waiting run keeps its approver's grant, sealed | Accepted | 2026-11-22 |

### Development

| Number | Title | Status | Last updated |
|---|---|---|---|
| [5001](5001-one-way-to-change-the-model.md) | One way to change the model, on every door | Accepted | 2026-11-17 |
| [5002](5002-reports-change-through-actions.md) | A report is a hub record changed only by actions | Accepted | 2026-11-19 |
| [5003](5003-report-layout-is-blocks.md) | A report's layout is blocks, drawn by one drawer | Accepted | 2026-11-18 |
| [5004](5004-the-hub-brings-its-report-actions.md) | The hub brings the actions of its own reports | Accepted | 2026-11-19 |
| [5005](5005-the-query-page-shapes-a-report-composes.md) | The Query page shapes data, a report composes it | Accepted | 2026-11-19 |
| [5006](5006-a-report-judges-a-number-by-two-marks.md) | A report judges a number by two marks | Accepted | 2026-11-19 |
| [5007](5007-stars-order-the-catalog-never-a-query.md) | A person's stars order the catalog, never a query | Accepted | 2026-11-19 |
| [5008](5008-a-person-is-drawn-by-their-own-picture.md) | A person is drawn by their own picture | Accepted | 2026-11-20 |
| [5009](5009-a-change-set-is-decided-as-one.md) | A change set is decided as one | Accepted | 2026-11-20 |
| [5010](5010-a-run-lives-by-being-heard-from.md) | A run lives by being heard from | Accepted | 2026-11-21 |

### Data

| Number | Title | Status | Last updated |
|---|---|---|---|
| [3001](3001-editions-kept-beside-their-record.md) | Editions keep their body and data beside their record | Accepted | 2026-11-18 |
| [3002](3002-a-dataset-is-a-query-source-read-by-a-runner.md) | A table outside the catalog is a query source, read by a runner tool | Accepted | 2026-11-19 |

### Compute

| Number | Title | Status | Last updated |
|---|---|---|---|
| [4001](4001-report-prose-written-on-a-runner.md) | A report's prose is written on a runner | Accepted | 2026-11-18 |
| [4002](4002-a-job-action-runs-as-one-container-for-each-run.md) | A job action runs as one container for each run | Accepted | 2026-11-21 |
| [4003](4003-an-action-caps-its-runs-in-flight.md) | An action caps its runs in flight | Accepted | 2026-11-22 |

### Operations

| Number | Title | Status | Last updated |
|---|---|---|---|
| [6001](6001-reports-delivered-by-the-desk.md) | Reports reach people through the desk, and stay snapshots | Accepted | 2026-11-18 |
| [6002](6002-a-source-is-judged-by-what-it-promised.md) | A source is judged by what it promised | Accepted | 2026-11-22 |

## Adding or changing a record

Copy `0000-template.md` to `CNNN-short-title.md`: the first digit is the
category, the last three run in order within it, and a number is never
reused. A record is Proposed, Accepted, Deprecated, or Superseded by
another. Strengthen a record in place while its decision stands, and
update its Last Updated. When the decision is reversed, write a new record
and mark the old one Superseded by it. Update this index in the same
commit.
