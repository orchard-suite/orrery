# ADR-5009: A change set is decided as one

| | |
|---|---|
| **Decision Date** | 2026-11-20 |
| **Decision Maker** | Orrery maintainers |
| **Last Updated** | 2026-11-20 |

## Status

Accepted

## Audience

Anyone who changes how runs are asked, approved, listed, or told, or who
builds a product or an agent that asks for many runs at once.

## Purpose

Settles how many runs, each with its own action, entity, and inputs, are
asked for one decision, so an approver reads and decides a bulk change once
without any run escaping the rules that judge a run alone.

## Context

An agent prepared sixty changes for a person to approve across two actions,
each run with its own inputs. A batch is one action with one answer over
many entities, so the agent made twenty-two batches. The approver saw sixty
rows in their approvals and opened twenty-two pages to approve them. The
hub had no way to hold many runs for one decision.

## Decision

A change set is its own record (`change_sets`): a title, a note that says
why, who asked, and how it was decided as a whole. Each item is still its
own run, which names the set and its place in it (`change_set`,
`set_index`), so each is recorded, run, retried, and kept on its own.

Every item is judged as a run of it alone would be, by the same code
(`judgeItem` over `judge` in `actions.ts`). When any item would be refused,
nothing is written, and every refused item is named by its place. Every run
of a set waits for the set's one decision: for the asker's own yes when
they could run every item without anyone else's approval, and for others
otherwise. Someone must be able to decide every run of it, seeing what each
runs on, or the set is refused as it is asked.

A run of a set is decided, withdrawn, and told only as the set. One
approval approves every run that waits, in the set's order, each through
the approval a run alone goes through, so `selfApproval`, a quorum, and a
run made as the approver hold unchanged. Nothing is approved unless the
approver may decide every run. Rejecting declines every run; the asker
withdraws the whole set. The approvals record, the desk's notice, and the
start page's band each show the set once.

## What this means for the code

- A new rule on who may decide a run belongs in `undecidable`; a set reads
  it for each of its runs with the set named, and never judges a run itself.
- A path that decides or withdraws a run refuses a run of a set unless the
  set asks it (`set` on `approve`, `decline`, `withdraw`).
- Every activity row about a run of a set names it (`set` in the detail),
  so the notice forwarder and the approvals pass tell the set instead.
- A list of runs that folds batches folds sets too; `sets=apart` leaves
  their runs out of any list.

## Verification

`src/server/change-sets.test.ts` holds a set of two actions with their own
inputs shown as one approval and told once, one approval running every run
as decided by the approver with a concurrency of one kept in the set's
order, a refused item refusing the whole set, reject, withdraw, the retry
of what failed, the agent's tool, and the inbox's one record.
`src/server/behalf.test.ts` holds a set whose runs call an API as the
approver.

## Consequences

An approver reads a bulk change once and decides it once. An agent asks
for what the person wants in one call. A set is all or nothing at the
door: one bad item sends the whole set back, which is what an approver
expects of a change they read as one. A set cannot mix runs that only
different people may decide; it is split by who approves.

## Related

- `docs/actions.md`, "Many changes for one decision".
