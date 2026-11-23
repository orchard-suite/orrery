---
name: orrery-model
description: Put something into an Orrery catalog the right way, or change how it is modelled. Use before adding or changing a blueprint, a field (its type, calculation, mirror, aggregation, or access), a relation, a relation rule, a scorecard, a source, a catalog file, or a pusher; when deciding what kind of entity a new thing is; when writing to the catalog from code or a pipeline; and when two estates (home and work, or several companies) should model the same thing the same way.
---

# Orrery model

Every estate that runs Orrery shares one set of names, so an agent that
knows one catalog knows the next. The rules are the hub's own modelling
guide. Read them from the hub you are working on; do not work from memory
or from this file.

## Steps

1. Call `modelling_guide`. Read the sections for what you are adding:
   naming blueprints, what belongs in the catalog, the shared names, and
   the example model's pieces and rules when the estate builds and runs
   software. The hub brings
   no model of its own: what exists is what the estate brought.
2. Call `describe_model` to see what the hub already has. Reuse a blueprint
   that already means the thing. A new blueprint is the last resort, and it
   says in its description which kind it is: inventory, record, or history
   with a retention.
3. Choose who writes it. The system of record pushes it; a person authors
   a short list of slow, valuable things; a repository describes the service it
   builds in its `orrery.yaml` (the `orrery-describe` skill). A list nobody keeps up stays out.
4. Name it by the guide's method: a word every industry shares stays in
   the unprefixed core, anything else takes its pack's prefix, and what one
   product's pusher reads takes that product's. A rename keeps the old id
   under `formerly`. A Core idea, and a shared relation to it, takes the
   estate's own word for it, which `describe_model` shows: never assume
   `customer` where the hub has `account`.
5. Choose the key: `<scope>/<stable id>`, never a display name. Software is
   keyed by its repository path, so the same service has the same key in
   every estate.
6. Write it through that one writer, then read it back with `get_entity`
   and `list_findings`.

## Changing the model

A model change goes to the hub, never into a file. The hub's model is its
own: the model page, the API, and these tools change the same thing with
the same checks, and each change is recorded under the person you answer
for. Change it only when the person asks, and only with their
`model.edit` permission: a refusal says which one is missing.

1. Read the part first with `get_model_definition`: a blueprint (`kind`
   left out), a `rule`, a `scorecard`, or an `alert_rule`. A blueprint's
   answer names the rules, scorecards, and alert rules on it under `on`.
   `changeable: false` means git or the hub defines it: change the catalog
   file in its repository instead, and say so.
2. Change it with `edit_model`. `change` is laid over the definition you
   read: an object merges, `null` removes, and anything else, a list
   included, replaces it whole.
   - One field's calculation: `{fields: {cost: {calculation: "a + b"}}}`.
   - A key out of a list in a calculation: send the whole calculation
     without it.
   - Add a field: `{fields: {owner_keys: {type: "string", title: "Owner keys", description: "..."}}}`.
   - Remove a field or a relation: `{fields: {old: null}}`, `{relations: {old: null}}`.
   - Add a relation: `{relations: {team: {target: "team", title: "Team"}}}`.
   - A new id creates the part, and `change` is then its whole definition.
3. A refusal changes nothing and says why: a calculation that does not
   compile, a type the stored values do not fit (with the values), a part
   only an admin changes. Mend the change and send it again; never work
   around the hub.
4. Remove a whole part with `delete_from_model`, and give a blueprint a new
   id with `rename_blueprint`. Read the result back with
   `get_model_definition`.

Over HTTP the same changes are `PATCH` (the same merge) or `PUT` (whole) on
`/v1/blueprints/{id}`, `/v1/rules/{id}`, `/v1/scorecards/{id}`, and
`/v1/alert-rules/{id}`, with a personal token. `GET /v1/model/export` reads
the whole model as the YAML `/v1/model/import` takes, to keep a copy or
compare two hubs.

## Traps that have bitten before

- **Inventing a type the model already has.** In a software estate a thing
  that looks new is usually an `sw_service`, an `sw_api`, a `business_capability`,
  or a `program` with a field. Check `describe_model` and the guide's shared
  names before naming anything.
- **Two writers for one field.** Each field has one owner, and the last
  writer wins. Two sources writing the same field flip it back and forth
  and raise a finding. Give each fact one source.
- **A snapshot that erases someone else's work.** A source that runs
  snapshots replaces everything it wrote on each entity it sends. Never
  write extra facts onto those entities through the same source; give them
  a source of their own.
- **Derived fields.** A mirrored, aggregated, or calculated field cannot be
  written. Write the thing it mirrors (a service's description mirrors its
  repository's).
- **A value that moves on every run.** A timestamp of when the source
  looked, or a counter, makes every push a change. The hub derives each
  change again with everything that reads it, and holds a source to a budget
  of changes an hour: past it, writes answer `429` until the hour turns.
  Send what changed and nothing that only says the source ran.
- **A blueprint that only grows.** Things that happened need
  `lifecycle.expire`. A hub may refuse new entities of a blueprint past its
  budget, with the reason in the rejected write.
- **Removing a blueprint.** A blueprint a catalog file defined is removed by
  deleting it from that file, not from the web app.

## Two estates

When the same software runs in more than one estate, model its software
side (what it is, the APIs it offers and calls) the same in
both, and keep its deployment side (where it runs, its cost, its health)
in each estate. Compare with `describe_model` on both hubs before changing
either, and say where they differ.
