# ADR-5001: One way to change the model, on every door

| | |
|---|---|
| **Decision Date** | 2026-11-17 |
| **Decision Maker** | Orrery maintainers |
| **Last Updated** | 2026-11-17 |

## Status

Accepted

## Audience

Anyone who adds a way to change a blueprint, a field, a relation, a
relation rule, a scorecard, or an alert rule: a route, an agent tool, a
command, or a new part of the model.

## Purpose

Settles that every change a person makes to the model goes through one
module, `src/server/model-edit.ts`, and that a partial change is a JSON
Merge Patch over the stored definition.

## Context

The model page saved through routes whose checks lived inside the route
handlers. Nothing else could change what existed: the import and a
pusher's offer only add, so an agent that had to change one field's
calculation could not, and a person had to do it in the browser. Adding
agent tools and a partial-change route beside the page's routes would
have copied those checks, and the copies would drift.

## Decision

- `ModelEdits` in `src/server/model-edit.ts` is the only code that saves,
  changes, removes, renames, or hands over a part of the model for a
  person. It holds who may say what (what only an admin sets, what the
  caller may not see kept as it was) and what follows a save (the pivots,
  the `blueprints` event, the re-link). Each store still decides what a
  definition may say.
- The model page's `PUT` routes, the `PATCH` routes, and the agent's
  `edit_model`, `delete_from_model`, and `rename_blueprint` tools all call
  it. A change through any of them lands on the same definition, is refused
  with the same words (`modelRefusal`), and is recorded under the caller;
  a change through an agent's tool carries `door: mcp` on its row.
- A partial change is JSON Merge Patch (RFC 7396) over the definition the
  hub stores: an object merges, `null` removes, anything else, a list
  included, replaces it whole. An id that does not exist yet is created
  from the patch.
- The model reads back whole, in the form `/v1/model/import` takes, through
  `GET /v1/model/export`, as the reader may see it.

## What this means for the code

- A new door to the model (a route, a tool, a command) calls `ModelEdits`;
  it never calls a store's `save` itself.
- A new part of the model a person edits is a kind in `MODEL_KINDS` and a
  branch of each `ModelEdits` method, never a route of its own beside them.
- A new refusal a store throws for a person's change is read in
  `modelRefusal`, so the API and the tools answer with it alike.

## Verification

`src/server/model-edit.test.ts` makes each change three ways (the page's
whole save, `PATCH`, and `edit_model`) and holds the three definitions
equal, the refusals word for word, and a caller without `model.edit`
refused on every door.

## Consequences

- An agent changes any part of the model a person can, as that person, and
  nothing more.
- A merge patch cannot remove one item from a list: the list is sent whole.
  That is the price of one simple, standard rule for every part.

## Related

- `AGENTS.md`, the `model-edit.ts` entry.
- Platform standard 2026.1107.1839: `two-interfaces-over-one-api-no-logic-in-either`,
  `pushers-and-imports-can-only-add-to-the-model`,
  `design-agent-authored-formats-for-low-syntax-risk-and-a-fast` (a name a
  definition does not take is refused, never dropped). It departs from
  `generate-agent-tools-from-the-http-api-s-own-openapi-documen`: the hub's
  agent tools are written by hand, so every answer stays bounded.
