# ADR-2001: A waiting run keeps its approver's grant, sealed

| | |
|---|---|
| **Decision Date** | 2026-11-20 |
| **Decision Maker** | Orrery maintainers |
| **Last Updated** | 2026-11-22 |

## Status

Accepted

## Audience

Anyone who changes how the hub calls an API as a person, how a run made as
its approver is approved or handed on, or what the hub keeps of a person's
sign-in.

## Purpose

Settles the one way the hub keeps a person's right to call an API in their
name past the request that gave it, so a run that waits its turn still runs
as the person who approved it.

## Context

A change set of sixty runs that call an API as the approver was approved
once. Its action runs one at a time (ADR-4003). The first forty-nine ran;
the last eleven failed. The hub could trade the person's token only while
their approval request was open, and a run handed on later, by a run ending
or by the timer, had none. The hub's rule was never to keep a person's
token past their request.

## Decision

When a person's own signed-in approval starts runs made as them, the hub
asks the issuer, with that request's token, for its refresh-capable grant
(`offline_access`), never an access token alone. It seals the grant with
`SECRET_KEY` and keeps it on each run it starts (`behalf_grant`), one grant
for one approval of many runs (`hold` in `behalf.ts`).

When the run's turn comes, the hub asks the issuer for a fresh token with
that grant, before any token of the request under way. The grant names its
person and its delegate, and is refused for anyone or anything else. It is
taken off the run as the run is handed on (`takeGrant`), and dropped when
the run ends or is put back to be tried again, so a retry or a schedule
never finds one.

This is the only way the hub keeps anything of a person's sign-in. The
approval that keeps it must carry the person's own token for the hub; one
whose token has lapsed is sent to sign in again (`needsOwnSignIn`), never
approved without it.

## What this means for the code

- Never keep a person's token, or anything that makes one, any other way.
- A new path that hands a run made as a person on reads the run's grant
  first, through `takeGrant`.
- Every hub of a deployment shares `SECRET_KEY`, or a grant sealed on one
  cannot be opened on another.

## Verification

`src/server/behalf.test.ts` holds a change set under a concurrency of one
whose approval's token ends before the later runs start, each run calling
as the approver; the retry of what failed; and a grant refused for another
person, another URL, and one it cannot unseal.

## Consequences

A run waits as long as it must and still runs as its approver. The issuer
must let the hub's app ask for `offline_access`: without it the hub logs
that the run keeps no grant, and a run that waits past the approval fails
when its turn comes. A leaked database holds sealed grants, useless without
`SECRET_KEY`, each good only for one person and one API.

## Related

- `docs/actions.md`, "Asked by an agent, run as the approver".
- ADR-4003, why a run waits its turn.
