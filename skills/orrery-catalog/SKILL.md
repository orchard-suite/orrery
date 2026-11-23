---
name: orrery-catalog
description: Ask the Orrery catalog before anything else what exists, where it runs, who owns it, whether it is healthy, and what is open against it. Use when a question or a task touches the estate (a service, a workload, a cluster, a host, a repository, a cloud resource, an alert, a cost, a deployment) and before reaching for kubectl, a cloud portal, a hypervisor, or a forge. Also use to run a self-service action.
---

# Orrery catalog

Orrery is one graph of the estate: what exists, who owns it, how it is
doing, and what is open against it. It is read first, and it is the only
inventory. A status page, an asset list, or a tracker beside it is a second
inventory and is never built.

## First, the estate's hubs

Read `~/.toolkit/config/orrery.md` if it exists. It holds this estate's
hubs: what each one is for, where it answers, and where its key is kept.
Where it has a rule, it wins over this skill. Say which hub an answer came
from whenever the file names more than one.

## Read it first

The plugin's MCP server is one hub, the one at `ORRERY_MCP_URL`. It tells
you, as you connect, the order to climb in: start broad, narrow, and stop
when you can answer. Every answer is small and says, as `more`, the exact
call that reads what it left out: follow it rather than asking for
everything. To count, find the newest, or group, ask `run_query` once
instead of paging.

| Question | Tool |
| --- | --- |
| Who you answer for ("I", "my") and when their day began ("today") | `who_am_i` |
| What is in this estate, and what is not green? | `estate_summary` |
| What kinds of thing exist? | `describe_model` with no blueprint |
| What one kind holds and how it connects | `describe_model` with that blueprint |
| Find things by a person's words (`q`, across every kind) or a filter | `search_entities` |
| How many, the newest, the most, or grouped, across every match, as one table of the columns you pick | `run_query` |
| One thing: its values, and each way it is linked with how many | `get_entity` |
| What it runs on, what runs on it, what it calls | `traverse` |
| What is not green, and why | `get_status` (counts; one blueprint to list them) |
| What changed, and who changed it | `get_changes` |
| What is wrong with the catalog itself | `list_findings` (counts; one kind to list them) |
| How well something meets a standard | `get_scorecard` |
| What a person or agent may do here | `list_actions` (with `entity` for one thing), `list_actions` with `action` to read one in full, then `run_action` (or `propose_changes` for many changes to approve at once) and `get_action_run` |
| What a team's report said, an older edition, or two editions side by side | `get_report` (find the report with `search_entities` first); to define or change one, read the guide's Reports section, check the layout with `check_report_layout`, then run the report's actions with `run_action` |
| What a table published from outside the catalog holds, such as a warehouse view | `list_datasets`, then `run_query` with the source `$data:<id>` and its column ids |
| What a thing looks like right now, from its own systems | `list_tools` (with `entity`), then `call_tool`; the answer is what the tool printed |
| How each thing of a kind stands against the budgets its estate set, worst first | `get_ground`, when the hub lists it (the ground is in preview) |
| What costs the hub, and who asks the most | `get_load` |
| What the hub holds its sources and callers to | `get_budgets`, and `set_budgets` to change it |

When the MCP server is not connected, and for any hub but the one it is
connected to, the same reads are the hub's REST API at `<hub>/v1` with a
bearer token (schema at `/v1/openapi.json`); the load and the budgets are
`GET /v1/load`, `GET /v1/budgets`, and `PUT /v1/budgets`. Send them with
`curl`: an edge in front of a hub may refuse other clients.

Read what you need once and keep it for the task: a hub may hold a token
to a budget of calls an hour. An answer of `429` says so, with the reason
and a `Retry-After`. Do not loop on it: use what you have, or tell the
person the budget on the hub's Load page is spent.

## Then go to the system

Go to the cluster, the cloud, or the forge only for what the catalog does
not hold: a pod's log, a live metric, a file. Say which entity you started
from, by its `blueprint:key`, so the next reader can follow.

## When the catalog is wrong or missing something

The catalog is fixed at its source, never worked around:

- A thing that exists but is missing, or a fact that is wrong: find the
  source that writes it (`get_entity` with `provenance: true` names where
  each value came from) and fix that source. Use the `orrery-model` skill.
- Software that should say what it is and what it connects to: use the
  `orrery-describe` skill.
- A finding from `list_findings` is a real defect: fix its cause, do not
  hide it.

## Rules

- Never print or log a token. Read it into a variable and use it.
- An entity is named by `blueprint:key`; a key is `<scope>/<stable id>`,
  never a display name.
- A budget's limit makes the hub refuse a source or a caller. Set one only
  when the person asked for it, take the number from `get_load`, and send
  every budget each time: one left out is no longer held.
- `run_action` runs real work on someone's behalf. Run one only when the
  person asked for that outcome, and report the run's id and result.
- A run that waits for approval answers `approve`, a link. Give the person
  that link and say who must approve it; never ask them to do the work by
  hand instead. An action that calls an API as a person (its log says "it
  runs as whoever approves it") runs as the approver, once they approve it
  signed in on that page. A batch that waits is approved at once on its own
  page, `/actions/batches/<id>`: give that link, not each run's.
- A run goes on without you. `run_action` answers `next`, which says
  whether anything of yours must stay for it; for every backend but `caller`
  nothing must. Give the person the run's id and its link, then stop: never
  sleep, poll in a loop, or keep a shell alive to wait for an approval or a
  long job. Read the run later, from any session, with `get_action_run`: its
  state, steps, log, outputs, and link.
- When the person wants many changes, each with its own action, thing, or
  inputs, ask them as one change set with `propose_changes`, never as many
  runs or many batches: they approve it once, on the page its `approve` link
  opens. A refused set names each refused item by `index`; mend those and ask
  again.
- An input with `current` changes a list the thing holds, such as its
  allowed origins. Read what it holds now with `get_entity`, send the whole
  list as it should be, every value once, and tell the person what
  `run_action` answers under `changes`: what it adds and what it removes. A
  run that leaves the list as it is is refused.
- A run refused because "it would wait for an approval nobody can give"
  was never made. Tell the person what the refusal says would let someone
  approve it; do not ask again until that changed.
