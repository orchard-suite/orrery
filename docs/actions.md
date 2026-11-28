# Self-service actions

An action is a form a person fills and a backend that does the work. The hub
validates the inputs, renders the backend's payload, hands it over, and keeps
the run as a row with a log. The hub itself runs no command: the backend is
yours, and it reports back. The one backend the hub carries out itself,
`record`, only writes an entity of the catalog, as a source you name. With
`caller`, the tool or person who asks does the work and reports: the hub
holds the approval and the record. With `job`, a starter you run starts one
container for the run the moment it is approved, so nothing of whoever
asked has to stay awake for it.

## The definition

```yaml
actions:
  - id: upgrade_argocd_app            # lowercase letters, digits, _
    title: Upgrade an ArgoCD application
    description: Set a container image to a new tag in the application's kustomization, commit it, and let ArgoCD roll it out.
    icon: argocd                       # a name from the icon set; without one it is drawn with its blueprint's icon, or a rocket
    group: Operations                  # the heading it is listed under when it has no home
    home: team:platform                # the one entity it belongs to, of any blueprint; it is listed under it (An action's home, below)
    blueprint: argocd_app              # the action runs on one entity of it, or of a list of them; leave out for a global action
    where: { field: sync_status, op: eq, value: Synced }   # only on entities this filter takes (optional)
    inputs:
      workload: { type: entity, title: Workload, blueprint: k8s_workload, required: true, where: { relation: namespace, target: "{{ entity.relations.namespace }}" } }
      image: { type: enum, title: Image, required: true, values: "{{ inputs.workload.fields.images }}" }
      tag: { type: string, title: New tag, required: true, description: The tag to deploy, such as 0.9.13. }
    backend: { ... }
    approval: false                    # true holds the run until someone else approves
    judge: true                        # an action with a change input: the estate's judge adds people to who is asked (Approval by the judge, below)
    confirm: false                     # true shows the person what they filled in, to check, before it is sent; always on for an input that changes a list (below)
    refreshes: [allowed_origins]       # fields of the entity it runs on that a run may write back once it succeeds (Writing back what a run changed, below)
    form: true                         # false: no form; only a tool starts it (An action with no form, below)
    access:                            # who may run it; left out, only an admin
      grants:
        - { path: teams, values: [platform] }
      home: true                       # whoever owns its home; or the ways of owning it, such as [lead]
      rules:                           # who may run it on which entity (see Who may run an action on what)
        - { owns: [developer] }
```

An action is defined in a catalog file under `actions:`, where git owns it,
or on the Self-service page by whoever holds `actions.manage`. A product can
declare its own actions with `PUT /v1/actions/{id}` each time it starts, so
the button is part of the product that does the work. It puts them with its
own source token once an admin gives its source the `actions` grant
(`actions: true` on the source, set on the Sources page or with
`PUT /v1/sources/{id}`). The action's origin is then `{kind: "source",
source}`, the source's write record lists it, and only that source removes it
with its token or puts over it; another source is refused with 409, and a
source without the grant with 403, recorded as a refusal. A token whose role
holds `actions.manage` works too, and its actions read as made in the web
app. Git still wins over both. Only an admin sets `access` and `home`; a save
by anyone else keeps the access and the home an admin gave the action, and a
new action without access is an admin's alone until an admin opens it. An import
brings one in the same way a scorecard comes in. The page's editor has a
Form tab and a YAML tab over the same definition: it checks the definition
as it is typed, with the hub's own checks, and previews the form it makes.

Write the description for a person and an agent: it is what the Self-service
page shows and what an agent reads to decide when to run the action.

## Inputs

| Type | What the form shows | What the hub stores | Options | Rules |
| --- | --- | --- | --- | --- |
| `string` | a text box | the text | `many`, `narrows`, `unique`, `current` | `pattern`, `minLength`, `maxLength` |
| `text` | a text area for several lines of plain text | the text, with its line breaks | | `pattern`, `minLength`, `maxLength` |
| `markdown` | a text area; the run's page shows it formatted, above everything else | the text | `narrows` | `minLength`, `maxLength` |
| `attachment` | a text area in a fixed-width font; the run's page shows it folded under its title, to open, copy, or download | the text exactly as sent, at most 1,000,000 characters | | `maxLength` |
| `change` | a text area for a change statement as JSON; the run's page shows the change it states, above the decision | the statement, checked against the change statement contract | | |
| `number` | a number box | the number | `many`, `narrows`, `unique`, `current` | `min`, `max` |
| `boolean` | a checkbox | true or false | `narrows` | |
| `date` | a calendar | the day, as `YYYY-MM-DD` | `narrows` | `min`, `max` |
| `datetime` | a date and a time, asked for in the person's own time zone | the moment in UTC, as `2026-03-10T14:30:00.000Z` | | `min`, `max` |
| `email` | a text box that must hold an email address | the address, its domain in lower case | `many`, `narrows`, `unique`, `current` | `pattern` |
| `url` | a text box that must hold a URL | the URL | `many`, `narrows`, `unique`, `current` | `pattern` |
| `enum` | a select over `values`, or a row of buttons | the value picked | `many`, `values`, `display`, `narrows` | `minLength`, `maxLength` |
| `entity` | a select over the entities of `blueprint`, one or a list, that `where` takes | the entity id, `blueprint:key` | `many`, `blueprint`, `where`, `sort`, `current`, `narrows`, `show` | `minLength`, `maxLength` |
| `person` | a select over the people of the estate that `where` takes | the person's entity id, `blueprint:key` | `many`, `where`, `sort`, `current`, `narrows`, `show` | `minLength`, `maxLength` |

The kinds are one list, `INPUT_KINDS` in `src/shared/input-kinds.ts`. The
builder, the form, the hub's checks, the run page, and what an agent reads
all come from it. An option or a rule a kind does not take is refused when
the action is saved.

Every input takes `title`, `description`, `required`, `default`, and `when`
(Asking an input only when it matters, below). The
title and the description are rendered over the scope as the form fills, so
an input can say what it is about: `description: "Running now: {{ entity.fields.images.0 }}"`
shows the person what is deployed while they pick the new version. An
`enum` takes `values`: a list, or a template that renders to one, and an
optional `display`: `list`, the select, or `buttons`, which shows every value
at once as a button to press. Use buttons for a few short values. An `entity`
takes `blueprint`, an optional `where`, the same filter the search uses, and
an optional `sort`, `field` or `-field` as the search sorts: `-tag` offers
the highest version first, since a sort reads the numbers in text as numbers
and puts `0.9.10` after `0.9.9`. An unset value sorts last either way. Sort
versions by tag, not by `pushed_at`: an old tag pushed again is newest by
date. Left out, options come by title. An optional
`current` is a template whose value, or values, name the option in use now
by id, key, or title, and the form marks it "running now":
`current: "{{ entity.fields.images }}"` marks the tag a workload runs.

An `entity` input's `default` names its starting pick, rendered over the
scope like any template: an id (`blueprint:key`), a bare key of the input's
blueprint (one that holds no colon), an entity, or a list of them, whose first
is taken. So `default: "{{ entity.relations.app }}"` picks the run's own
app, from a `many` relation as well. A single entity input whose `where`
leaves exactly one option picks it: `where: { field: email, op: eq, value:
"{{ entity.fields.requested_by }}" }` fills in the person who asked. The
default counts on the hub too: a run asked for without that input takes it.

A `person` input is an `entity` input over the blueprint the estate says a
person is, which an admin sets on the Access page. It names no `blueprint` of
its own, and takes `where`, `sort`, `current`, and `default` as an entity
input does. An action with a `person` input is refused while the estate does
not say who a person is. Nothing fills it with whoever is running the action:
the scope already carries that as `{{ by.name }}`.

A `date` is a day with no time. A `datetime` is a moment: the form asks for
it on the person's own clock and names their time zone, and the hub keeps it
in UTC. A value sent to the hub must carry its offset, as
`2026-03-10T14:30:00Z` or `2026-03-10T09:30:00-05:00`.

An input marked `narrows` narrows what the action runs on. It names a
relation of every blueprint the action runs on, for an `entity` input whose
`blueprint` that relation points at, or a field, for any other input. The
form asks it first, then offers only the entities that point at or hold what
was picked. Run on an entity, from its row, its page, or a link, the input is
filled from the entity and shown, not asked; the hub fills it the same way,
and refuses a value that disagrees with the entity.

```yaml
blueprint: [app_service, function_app, virtual_machine]
inputs:
  environment: { type: entity, blueprint: environment, narrows: environment, required: true }
```

`many: true` makes the value a list: an `entity`, `person`, or `enum` input
is picked with checkboxes, and a `string`, `number`, `email`, or `url` input
is asked a row a value. Each row is its own box, checked by the input's kind
and rules as the person leaves it. **Add another** under the rows, or Enter in
a row, adds an empty row and moves to it. Each row has a remove button: it
shows while the row is pointed at or holds the focus, always on a touch
screen, and Tab reaches it like any button. Pasting several lines into a row
makes a row a line. An empty row is dropped when the form is sent, and a value
given twice is refused, by the form and the hub alike, with the value named:
`expected each value once: https://a.example.org is in the list twice`. The
same editor is drawn in the form, the run-again form, and the builder's
preview. Nothing picked is an empty list. In the scope a list of entities is a list of entity shapes, so
`{{ inputs.workloads }}` renders as JSON for a backend, and
`{{ inputs.workloads.key }}` is the list of their keys.

### Changing a list the entity holds

A `many` input of `string`, `number`, `email`, or `url` takes `current`: a
template of the list the entity holds now. The input then changes that list,
such as the web origins an app allows.

```yaml
- id: set_allowed_origins
  title: Change allowed origins
  description: Changes the web origins the app accepts. The identity team approves it.
  blueprint: web_app
  inputs:
    origins:
      type: url
      title: Allowed origins
      many: true
      current: "{{ entity.fields.allowed_origins }}"
  access:
    rules:
      - { owns: true, approval: true }
  backend:
    type: runner
    runner: identity-runner
    command: [/set-origins, --app, "{{ entity.key }}", "--want={{ inputs.origins }}", "--had={{ run.current.origins }}"]
```

- The form starts from the list `current` renders to, unless the input has a
  `default`. The person edits it row by row.
- The form always asks for a review, whatever `confirm` says. The review shows
  the change against `current`: **Added**, **Removed**, and **Unchanged**,
  folded under its count. The button stays off until the person ticks **This
  is what I want**.
- A run that leaves the list as it is, as a set, is refused: neither the
  order nor a value given twice counts. The form says so at the input, and
  the hub refuses it with `Input "origins": this is the list as it is now, so
  nothing would change` before anything is asked or approved. With several
  such inputs, the run is refused only when it changes none of them.
- The hub renders `current` again when the run is asked for, over the entity
  as the person who asked sees it, and keeps that list on the run as
  `current`, by input name. A run that waits for approval keeps it as it was,
  whatever the entity holds later.
- The run's page shows the same **Added** and **Removed** lists under **What
  it changes**, so whoever approves it sees exactly what changes. The record
  in the approvals blueprint says it in its `reason`: `Allowed origins adds:
  https://d.example.org` and `Allowed origins removes: https://c.example.org`.
- The backend's scope holds the kept list as `run.current.<input>`. A backend
  compares it with what is live and refuses the run when the two differ:
  someone changed the list between the ask and the run.
- An agent reads `current` on the input in `list_actions`, and `run_action`
  answers `changes`: per input, what the run adds, what it removes, and how
  many values it keeps.
- Such an input cannot be asked once for many: each entity holds its own
  list, so a batch of the action is refused.

`current` on any other kind but `entity` and `person` is refused when the
action is saved, and so is `current` on a list kind without `many: true`.

An `attachment` is for a long text a backend or a tool sends with the run,
such as the full plan of an infrastructure apply. The run's page keeps it
folded under its title until the reader opens it, and offers it to copy or
download either way. Only the run keeps it: a list of runs, the activity log,
and a notice say only how long it is.

### A change statement

A `change` input is for a tool that changes a live thing, such as an
infrastructure apply: it sends what the change will do as a **change
statement**, the platform kit's contract (`change/schema/statement.json` in
`github.com/orchard-suite/platformkit`). An action declares at most one, and
never as a list, worked out, or in a batch:

```yaml
inputs:
  plan:
    type: change
    title: The change
    required: true
```

The tool sends the statement as an object, or as JSON text of one:

```json
{ "inputs": { "plan": { "key": "plan-7f3a2c", "writer": { "name": "infra", "version": "3.1.0" }, "actor": { "kind": "agent", "id": "agent-1", "on_behalf_of": "user@example.com" }, "things": [{ "blueprint": "workload", "key": "acme-api-prod" }], "artifact": { "kind": "plan", "digest": "sha256:9f2c…" }, "applier": "hub", "effects": [{ "kind": "stops", "subject": { "blueprint": "workload", "key": "acme-api-prod" }, "path": "in-place", "size": 2, "undo": "yes", "claim": { "from": "writer" } }] } } }
```

The hub checks it as the run is asked and refuses one that breaks it,
naming the input and the part: against the contract's schema, and against
the rules the platform kit's validator adds to it. No name but the actor's
`id` and `on_behalf_of` holds an email address; no name holds `=`, a PEM
header, what reads as a JSON web token, or a run of 32 letters and digits
that mixes upper case, lower case, and digits; and an effect of a base kind
with no unit (`opens`, `loses`, `cuts`) has no size. A kind the estate adds
is the judge's to check. The schema and the base kinds it checks with are
copies in `src/shared/change/`, of the platform kit version `go.mod`
requires; a Go test holds each copy to that version byte for byte.
The run keeps the statement and its digest (`statementDigest`): `sha256:`
over its canonical form, as the contract takes it.

Whoever decides the run reads the change, not its JSON: the run's page shows
where it runs (a job the hub starts, or the machine that asked), who asked,
the artifact, the things it touches, each effect with the thing it is on,
its path, its size, whether it can be undone, and where the claim came from,
and each part the writer could not name an effect for. A notice of a run
that waits says the same in words.

A run that carries a statement writes four kinds of change event, each in
the contract's shape, in the activity row of the change that made it:

| Event | When | What it says |
| --- | --- | --- |
| `change.stated` | the run is asked | the statement and its digest |
| `change.routed` | right after | the route: to people, the people who may decide the run now and its quorum, when it waits for approval; to no one when it does not. The hub is the judge (`orrery`, its version, the pack `action.<action id>`, the rule `action-approval`), unless the action opts in to the estate's judge: then it carries that judge, its route with the action's own approvers added, its reasons, the fences, and its drafts (below) |
| `change.decided` | each approve and decline | who, and yes or no |
| `change.ended` | the run reaches a final state, once | `ok`, `failed`, or `refused`, and the applier's check |

Each event's key is the run's: `<run id>.stated`, `.routed`, `.decided.<n>`
(the nth answer), and `.ended`, and each after the first names the stated
one. The check comes from what the applier reports as outputs:
`statement_check` is `matched`, `differed`, or `unchecked` (unchecked when it
reports none), and `statement_differs` names the statement's fields that
differed, comma-separated. A statement that differed was refused by its
applier and ends `refused`. A run that is declined, sent back, or cancelled
before it ran ends `refused`; one stopped while it ran, or whose outcome is
not known, ends `failed`.

The Annals forwarder sends each event as a record of its own (README,
Access). A run whose action has no `change` input writes none of this; a
statement sent to one is dropped like any input the action does not ask.

With `DISPATCH_URL` and `DISPATCH_TOKEN` set, every one of the four events
also goes to the desk, which keeps each change on the things it touches and
watches it from its end. This is the only way the desk hears of a change.
They go in batches of up to 200, as `POST /v1/change-events` with the body
`{"events": [...]}`. The desk answers 200 with how many it kept, or 400
with `{"error", "index", "reason"}` naming the first event it refuses, keeping none of
the batch. A refused batch is sent again in halves until the event the desk
refuses is alone, and only that event is logged and passed over. Any other
answer, a 400 that names no index among them, leaves the events in the log:
the forwarder keeps its own mark, moved only past rows a minute old, and the
next pass sends them again. So a desk that is down, or does not take the
route yet, loses nothing, fails no run, and holds up no notice.
`orrery.dispatch.change_events` counts what the desk answered.

### Approval by the judge

An action with a `change` input may hand who must look at each run to the
estate's judge (Trellis), with `judge: true` beside its approval settings:

```yaml
id: apply_plan
inputs:
  plan:
    type: change
    required: true
backend: { type: job, starter: east, template: infra-apply }
judge: true
```

Each run's statement goes to the judge before the run is queued, as
`POST <JUDGE_URL>/v1/judge` with the body `{"statement": ...}` and the
header `Authorization: Bearer <JUDGE_TOKEN>`. Both are hub settings:
`JUDGE_URL` is the judge's machine door on the cluster network, and
`JUDGE_TOKEN` a token the judge issued for the hub. With either unset the
judge is off, the way Annals and the desk are off without their tokens:
the hub starts, logs that the judge is off, and calls nothing. The token
is never logged. A 200 answers `{"judge": {"name", "version", "pack"}, "route",
"reasons", "drafts"}`, the platform kit's `Route`, `RouteReason`, and
`Draft`: a route is `{"to": "no_one"}`, or `{"to": "people", "grants":
[{"path", "field", "values"}], "quorum", "by", "start"}`, its grants named
as the hub names approvers. A 400 answers `{"error", "reason"}`. The hub
holds the answer to the kit's route rules (`validateRoute`): a route of no
one names no one, no quorum, and no time; a route to people names 1 to 16
grants of 1 to 50 people each and a quorum of at least 1; a reason names an
effect or a part of the statement (by an index the statement has), a fence,
or a rule; no fence stands on a route of no one; no name holds an address
or what reads as a value or a secret. Anything else the answer says is
passed over.

**The judge only adds.** The action keeps the approval it names for itself
(`approval`, `quorum`, `selfApproval`) and the approvals its access rules
name (`approval` on a rule, tiers, approvers a product named):

- A route of no one queues the run at once only when the action and its
  rules ask no one. When they ask someone, the run waits for them as if no
  judge were asked. A judge answer of no one on an action with
  `approval: true` still waits for that approval.
- A route to people asks its grants as well: the run waits for `quorum`
  yeses from people its grants let in, never its asker, and no override, and
  for whatever the action's own approval asks. Both must be met. Each yes
  counts for whatever it may (`for` on each of `approvedBy`: `action`,
  `route`, or both), and the yes that leaves nothing owed starts the run. A
  run only the route holds has `approvalsNeeded` 0.

**The fences.** Each sends the run to people as `approval: true` sends a
run, to someone other than its asker, and is a reason on its route:

| Fence | When |
| --- | --- |
| `judge_down` | the judge gave no answer: `JUDGE_URL` or `JUDGE_TOKEN` is unset, the call failed, it took longer than three seconds (the hub waits no longer, and never waits on the judge to pass a change), it answered anything but 200 (a 401 or 403 for the hub's token too), or its answer breaks the rules above. The route then names no judge |
| `asker` | the judge said no one, and the statement's `applier` is `asker`: a change applied on the machine that asked never goes to no one |
| `unknown` | the judge said no one, and the statement lists a part the writer could not name an effect for, or the judge gave an effect the proof `unknown` |

A run of a judge-routed action that states no change goes to people the
same way, without asking the judge, and writes no change event.

**What the run keeps.** The run keeps its route as its `change.routed`
event says it (`routed`): the judge, the route, each reason, and each
draft. What the route asks beside the action's own approval is
`routeAsks` (`{grants, need}`). The quorum, `by`, and `start` are the
run's own, whatever the action says later:

- The run is not started before `start`: a run approved before then is
  queued for then (`retryAt`), its log says so, and whoever would start it
  earlier is refused. A caller's run left unstarted is given up counting
  from `start`.
- `by` is when the decision is due. It shows on the ask.
- A draft is what a pack not counting yet would have answered. It is kept
  and shown, marked as a draft, and never changes who is asked.

**The ask.** The run's page shows, under the statement, who judged it, the
route, when it is due and when it may start, each reason (which effect, on
which thing, at what proof, and which fence), and each draft. A notice of
a run that waits says the same in words.

**An approval binds to the statement.** Each yes keeps the digest of the
statement it was given for (`digest` on each of `approvedBy`). An approve
call may send `{"digest"}`, the `statementDigest` the approver was shown;
the run's page always does, and a digest that is not the run's is refused
409. A different statement is a new run, and the applier's own check of
what it holds stays as it is.

The `change.routed` event carries the judge (absent only under
`judge_down`), the route the run takes: to people when the route or the
action asks anyone, with the route's grants and then the action's own
approvers, the larger of the two quorums, and the route's `by` and
`start`; its reasons: the judge's, then the fences, then `action-approval`
when the action's own approval holds the run; and the judge's drafts.

### The watch's verdict

The estate's watch reads what a change did once it ended, and says it as a
`change.observed` event: for each effect kind on each thing, by the path the
change took, whether it looked and saw nothing (`clean`), saw harm (`harm`),
or could not look (`blind`). It posts the event to
`POST /v1/ingest/change-events`, `{"events": [...]}` (up to 100), with a
source token whose source an admin gave the `watches` grant on the Sources
page. The hub reads each event strictly against the platform kit's
event schema (`change/schema/event.json`, copied to `src/shared/change/` and
held to the kit version `go.mod` requires), so a field the contract does
not have is refused. Its `of` must name a `change.stated` event this hub
sent (`orrery`, `<run id>.stated`), and its digest must be that change's.
One bad event refuses the batch with 400 `{"error", "index"}` and none of
it is kept. The sender is the source's own id, whatever the event says. An
event is kept once for each sender and key, as a `change.observed` row with
its run; posted again it counts as a duplicate. The answer is
`{"kept", "duplicate"}`.

Each verdict moves the **safe paths** of the things it saw, kept as
`orrery_safe_path` entities, one for each thing and path, keyed
`<blueprint>/<key>/<path>`:

| Sight | What it moves |
| --- | --- |
| `clean`, on a path other than `in-place`, of a kind that is no exposure | `proven_at`, to the end of the watch's window, and `proven_run` |
| `harm`, on such a path | `failed_at` and `failed_run`; a path one kind saw harm on is not proven by another |
| `blind` | nothing |
| `in-place`, or an exposure kind | nothing: in-place absorbs nothing, and the statement itself proves an exposure |

A day only moves forward, so a verdict with an earlier window, or one sent
twice, changes nothing. A thing the catalog does not hold gets no safe path,
and a safe path goes with its thing: once the thing is deleted, the next
lifecycle pass lets its safe paths go.
A safe path is green while it was proven after it last did harm, and red
otherwise. A kind the estate adds counts as a disruption, since the watch
watches nothing else. The thing's page lists its safe paths and their days,
and a safe path is seen by whoever sees its thing until an admin says
otherwise, as for the hub's other blueprints
(`/v1/access/hub-blueprints/orrery_safe_path`).

### Rules

A rule is what a value must keep. The form checks it as the person leaves the
input and again when they submit, and shows what is wrong at the input. The
hub checks every value again, whoever sent it.

| Rule | On | What it holds |
| --- | --- | --- |
| `pattern` | `string`, `text`, `email`, `url` | A regular expression the whole value must match. |
| `minLength`, `maxLength` | `string`, `text`, `markdown` | How many characters the text holds. `attachment` takes `maxLength` alone. |
| `minLength`, `maxLength` | `enum`, `entity`, `person` with `many: true` | How many are picked. |
| `min`, `max` | `number` | The least and the most. |
| `min`, `max` | `date`, `datetime` | The earliest and the latest day. |

A day bound is a day, `2026-03-10`, or one counted from today: `today`,
`today+30d`, `today-2w`, `today+1m`, `today-1y`. Today is the day in UTC. A
day bounds a `datetime` too: `min` from the start of that day, `max` to its
end. A `datetime` also takes a moment with an offset as a bound.

A pattern is matched against the whole value, never a part of it, so
`[A-Z]+-\d+` takes `OPS-12` and refuses `see OPS-12`. It is at most 200
characters, and a repeat inside a repeat, such as `(a+)+`, is refused: one
can take forever to match. The check is plain, so it also refuses some
patterns that are safe, such as `([a-z]+-)+`. Where that happens, write a
looser pattern with no group that repeats, such as `[a-z-]+`, and let the
backend refuse the rest. With a `many` input, each item keeps the pattern,
and a list a person types holds each value once.

Each rule has its own plain error. `hint` replaces it with words of your own,
for a rule whose error would not tell the person what to type:

```yaml
inputs:
  ticket:
    type: string
    required: true
    pattern: "[A-Z]+-\\d+"
    hint: Give the ticket's key, such as OPS-12
  starts: { type: date, required: true, min: today, max: today+30d }
  reviewers: { type: person, many: true, minLength: 1, maxLength: 3 }
  size: { type: enum, values: [small, medium, large], display: buttons, default: small }
  contact: { type: email }
  reason: { type: text, maxLength: 500 }
```

A hint with no rule and no `unique` beside it is refused, and so is `min`
past `max` or `minLength` past `maxLength`.

### Asking an input only when it matters

`when` on an input is a filter, the same one the search uses, over the
inputs above it. The input is asked only while the filter matches. Each
input above is a field by its own name:

```yaml
inputs:
  env: { type: enum, values: [dev, prod], required: true }
  ticket:
    type: string
    required: true
    when: { field: env, op: eq, value: prod }
```

The form shows `ticket` once `env` is `prod`, and takes it away when `env`
changes. An input that is not asked is not required and not checked, and the
run stores nothing for it. The hub decides again at every run, over the
values it checked: what is sent for an input that is not asked is dropped,
never refused. What a person typed into an input before it went away is
forgotten when they submit.

An `entity` or a `person` input reads as its id, `blueprint:key`. A `when`
does not step into the fields of what was picked. An input that was itself
not asked, or was left empty, reads as unset, so `{ field: ticket, op: exists }`
is false for it.

A `when` is refused when it reads an input declared after it, one that does
not exist, or the input itself. It is refused when it tests anything but an
input, and when it reads the time (`within`, `older`): which inputs a run
was asked never moves after the run. It is refused on an input that
`narrows`: that input is asked before the entity the action runs on, so it
is always asked.

### Working a value out

`value` on an input is an expression over the inputs above it, in the
language of calculation fields (the README's "Fields" names what it can do). The input is never
asked: the form shows what the expression gives, and it changes as the
person fills in the inputs it reads.

```yaml
inputs:
  name: { type: string, required: true, pattern: "[a-z][a-z0-9]*" }
  env: { type: enum, values: [dev, prod], required: true }
  slug:
    type: string
    title: Its name in the cluster
    value: "lower(name) + '-' + env"
    maxLength: 40
```

The hub works the value out again at every run and never takes it from the
request. What it gives is checked as the input's kind and by its rules, as a
typed value would be: a `slug` longer than 40 characters is refused with a
plain error that names `slug`. The result is not turned into the kind: an
expression for a `number` input must give a number. An expression that gives
nothing leaves the input empty.

The expression must parse, and may read only inputs declared above it. A
worked-out input has no `default`, is not `required`, and is not `many`. A
kind that is picked (`enum`, `entity`, `person`) is never worked out, and
neither is an input that `narrows`. An `entity` input the expression reads
is its id. A worked-out input may carry a `when`: it is then worked out only
while the `when` matches.

### Refusing a value that is taken

`unique: { blueprint, field }` on a `string`, `email`, `url`, or `number`
input refuses a value that an active entity of that blueprint already holds
in that field. `field` is `key`, `title`, or one of the blueprint's fields.
Text is the same whatever its case, so `Billing` is taken when `billing`
exists.

```yaml
inputs:
  name:
    type: string
    required: true
    unique: { blueprint: service, field: title }
    hint: A service by that name exists. Pick another name
```

The hub checks when the run is asked for, and the form shows the refusal at
the input. The refusal says "Name is already taken", or the input's `hint`.
The check is the hub's own, over every entity, whoever asks. It says that a
value is taken and nothing else: not which entity holds it, and nothing a
person who may not see that blueprint could not have guessed by trying. The
form does not check as the person types. Whoever saves the action must see
the blueprint, and the field must exist.

Two runs asked for at the same moment can both pass the check, since
neither has written anything yet. Where that matters, let the backend that
creates the thing refuse the second.

### What shows under each option

`show: [field, ...]` on an `entity` or a `person` input puts those fields of
each option on a second line under its title, in the list and under the
option picked. It takes at most 4 fields.

```yaml
inputs:
  team: { type: entity, blueprint: team, required: true, show: [lead, channel] }
```

The fields are read as the person may see them: one they may not see is
left out, and so is one an option does not hold. A value reads as it does
in a grid cell. A field must exist on at least one blueprint the input picks
from; on the others it is skipped.

### Sections

`sections` on the action groups its inputs under headings. Each section has
a `title`, an optional `description`, and the `inputs` under it, in the
order the form asks them.

```yaml
sections:
  - title: What it is
    inputs: [name, env, slug]
  - title: Who owns it
    description: The team that is paged when it breaks.
    inputs: [team, ticket]
```

An input no section names is asked last, under no heading. A section whose
inputs are all not asked is not drawn. An input that `narrows` is asked
with what the action runs on, above every section, so a section may not
name one.

A section is refused when it names an input that does not exist, an input
twice, or an input another section names, and when it holds no input. The
sections must keep the order the inputs need: an input may not come before
one its `when` or its `value` reads.

### Walking through it as steps

`walk: true` on an action with `sections` shows one section at a time. The
form says where the person is, as "Step 2 of 4", with Back and Next. Each
step is checked before Next moves on, and the last step's button runs the
action. With `confirm: true`, or an input that changes a list the entity
holds, the check of everything filled in comes after the last step.

A step that holds no asked input is skipped, and the count is of the steps
left. The inputs no section names are a last step, "Everything else". When
the form asks what the action runs on, that is the first step. A walk with
one step is drawn as a plain form. When the hub refuses a run over one
input, the form goes to that input's step.

### A full form

One action with sections, a walk, an input asked only for production, a
worked-out value, and a unique check:

```yaml
id: new_service
title: Ask for a new service
description: Asks the platform team for a new service. Use it before any code exists.
icon: rocket
confirm: true
walk: true
inputs:
  name:
    type: string
    title: Name
    description: Lowercase letters and digits.
    required: true
    pattern: "[a-z][a-z0-9]*"
    maxLength: 30
  env:
    type: enum
    title: Environment
    values: [dev, prod]
    display: buttons
    default: dev
    required: true
  slug:
    type: string
    title: Its name in the cluster
    value: "lower(name) + '-' + env"
    unique: { blueprint: service, field: key }
    hint: A service with that name runs there already. Pick another name
  team:
    type: entity
    title: Owning team
    blueprint: team
    required: true
    show: [lead, channel]
  ticket:
    type: string
    title: Change ticket
    required: true
    pattern: "[A-Z]+-\\d+"
    when: { field: env, op: eq, value: prod }
sections:
  - title: What it is
    inputs: [name, env, slug]
  - title: Who owns it
    description: The team that is paged when it breaks.
    inputs: [team, ticket]
backend:
  type: webhook
  url: https://hooks.example.org/new-service
  body:
    service: "{{ inputs.slug }}"
    team: "{{ inputs.team.key }}"
    ticket: "{{ inputs.ticket }}"
```

The person fills in a name and an environment and sees the slug form under
them. Step 2 asks for the team, each option with its lead and its channel
under it, and for a ticket only when the environment is `prod`. The hub
works the slug out again, refuses it when a service already has that key,
and stores no ticket for a run in `dev`.

## The scope

Any string in an action's inputs or backend may hold `{{ path }}`. A string
that is exactly one `{{ path }}` becomes the value at the path, whatever its
type, so `values: "{{ inputs.workload.fields.images }}"` is the list of
images. Any other string has each `{{ path }}` written into it; nothing
becomes an empty string, an object becomes JSON. On a list, a number picks
one item (`images.0`) and a name reads it on every item, leaving out those
without it (`inputs.workloads.key`).

| Path | What it holds |
| --- | --- |
| `entity` | the entity the action runs on: `id`, `blueprint`, `key`, `title`, `icon`, `state`, `status`, `fields.<name>`, `relations.<name>` |
| `entity.relations.<name>` | the target's id for a relation declared `many: false`, a list of ids otherwise |
| `inputs.<name>` | the value of an input above this one; an entity input is the entity in the shape above, so `inputs.workload.fields.images` works |
| `run.id`, `run.url`, `run.at` | the run, where it can be watched in the hub, and when it was asked for |
| `run.current.<input>` | for an input that changes a list the entity holds (Changing a list the entity holds, above), that list as the hub rendered it when the run was asked for, kept as it was. Set only once the run is asked for, so a form's template reads nothing there |
| `by.name` | who asked |
| `by.address` | where the person who asked called from, as the hub read it (Where the caller is, below). Set only on a run a person asked for themselves in the browser |
| `action.id`, `action.title` | the action |

The form renders an input's `where` and `values` over the scope as it is
filled, so an input below one that changed offers new options. The hub
renders them again when the run is asked for, and refuses a value the form
could not have offered. The same code renders both: `src/shared/template.ts`.

### Where the caller is

`by.address` is the public address the person who asked called from. The hub
reads it from the request through the one proxy header it trusts
(`CLIENT_ADDRESS_HEADER`, `x-real-ip` unless the estate says otherwise; see
the settings in the README), and never from anything in the form. It is set
only when a person signed in asks for the run themselves, from the browser.
A schedule's run, a batch, a product asking for a person (`for` or
`requestedFor`), a tool call, a personal token, an access token, and an admin
viewing as someone hold none, so `{{ by.address }}` reads nothing there.

An input may start from it, so the form is filled in with the address and the
person still sees it and may change it:

```yaml
- id: allow_my_network
  title: Allow my network
  description: Records the address you call from, for the allow list.
  blueprint: person
  self: true                       # on your own person alone (An action on yourself, below)
  access: { everyone: true }
  inputs:
    address: { type: string, required: true, default: "{{ by.address }}" }
  backend:
    type: webhook
    url: https://ops.example.org/hooks/allow
    body: { address: "{{ inputs.address }}", seen: "{{ by.address }}", person: "{{ entity.key }}", by: "{{ by.name }}" }
```

When the run is asked for, the hub reads the address from that request
again and fills the default in itself. A value sent in its place is kept as
the input, and recorded as differing: the run's log says what the hub filled
in and what was sent, the activity row names the input under `differs`, and
the run keeps the address the hub read as `byAddress`. The backend gets both,
`inputs.address` as typed and `by.address` as read, and decides which to
trust. The same holds for any default that reads `by`. A run that waits for
approval keeps the address it was asked from, and is sent with it once
approved.

The form fills the address in from `GET /v1/whoami` (`address`), which the
page reads once when it opens. A person who moves to another network keeps
the old one in the form until the page is loaded again; the hub still reads
the new one on submit and records the difference.

**The proxy in front of the hub decides it.** The hub never sees the
caller's own connection. The ingress must write the caller's real address
into the trusted header, over whatever the caller sent, and every proxy
between it and the hub must pass that header on untouched. A header the hub
does not trust is never read. With `x-forwarded-for` trusted, set
`CLIENT_ADDRESS_HOPS` to the number of proxies in front of the hub that add
to it: the hub reads the entry that many from its end, never one further in,
which the caller could have written. An estate whose ingress does neither
sets `CLIENT_ADDRESS_HEADER=none`, and no run has an address.

## Backends

**`webhook`** posts a JSON body to a URL you run.

```yaml
backend:
  type: webhook
  url: https://ops.example.org/hooks/restart
  method: POST                     # or PUT
  secretRef: ops_hook              # a hub secret sent as a bearer token (optional)
  query: { why: "{{ inputs.why }}" }   # rendered, encoded, and added to the URL; a value that renders to nothing is left out (optional)
  headers: { x-source: orrery }    # rendered (optional)
  body: { workload: "{{ entity.key }}", why: "{{ inputs.why }}" }   # rendered (optional)
  timeout: 15m                     # how long the hub waits for the answer (default 15m)
```

Without `body`, the payload is `{ run, action, entity, inputs, by }` in the
shapes above; `run` holds `current` for a run that changes a list. A 2xx answer puts the run in `running`; anything else fails it
with the answer's first 200 characters in the log. `method` may also be
`GET`, `PUT`, or `DELETE`.

`finish: answer` ends the run on the answer instead: a 2xx succeeds it, with
the answer's first 200 characters in the log. Use it for an API that does the
work before it answers and reports nothing after. Such a webhook reports
nothing, so it cannot write back what it changed: an action with `refreshes`
leaves `finish` out and reports (Writing back what a run changed, below).

#### How long the hub waits

The hub waits for a webhook's answer for its `timeout`: 15 minutes when the
action names none, and never longer than a run may go unheard from
(`ACTION_TIMEOUT_MINUTES`), or than the action's `ceiling`. Whatever handed the run on (the request that
asked for it, an approval, a batch, a retry) waits two seconds at most. A
slower answer puts the run in `running`, with `waiting for webhook to answer,
for up to 15 minutes` in its log, and the hub waits for it behind the
request. So nobody's page hangs on a slow webhook, and a batch of many hands
its calls out one after another instead of all at once.
A backend that does its calls one at a time still gets them all at once:
give such an action a `concurrency` (A few at a time), so the calls wait
their turn in the hub, not behind the backend's door.

A run whose webhook gives no answer in time, whose connection closes after
the request went out, or that a gateway in front of it answers with 504,
ends `unknown`: the webhook was reached and may have done the work, so the
run is no failure. It is never tried again, it does not count toward the
action's failures in a row, and its notice says to check before running it
again. Its backend may still report how it ended (`succeeded` or `failed`),
and that settles it. A webhook that cannot be reached at all (a refused
connection, a name that does not resolve) still fails the run.

For work longer than a few minutes, leave `finish` out: the webhook answers
2xx at once, the run is `running`, and the webhook reports how it ended
through `/v1/action-runs/{id}/report` (Steps and outputs). Nothing then holds
a connection open, and a hub restart loses nothing.

A long wait holds only if nothing between the hub and the webhook cuts the
connection first. The hub sets no limit of its own on the answer and probes
the connection every 30 seconds while it waits, so an idle NAT or load
balancer keeps it. A proxy or gateway in front of the webhook (an ingress's
read timeout, a cloud gateway's request timeout) must allow as long as the
`timeout`, or it answers 504 first, and the run ends `unknown`.

`finish: reveal` is for an answer that is a secret, such as a recovery key.
The run ends the same way, but the answer is written nowhere: not in the run,
its log, the activity log, an event, or a notice. It is on the answer to the
request that asked for the run, as `told`, up to 4,000 characters, and the web
app shows it on the run's page until the person leaves or reloads. The log
says only that it was given, and to whom. So the call is made as the person
(`onBehalf`, below), the action has no batch, and a run handed on by anything
but the request that asked for it fails without calling the API. A `GET`
carries no body.

### Calling an API as the person who asked

A webhook normally carries a hub secret, so the API sees the hub. When the API
has its own rules about who may do what, and its own audit log, it should see
the person instead:

```yaml
backend:
  type: webhook
  url: https://ops.example.org/users/{{ entity.fields.username }}/unlock
  onBehalf: ops                    # a delegate the hub is set up with
  finish: answer
  body: {}
```

The hub trades the person's own access token for one the issuer makes for
that API in their name (OAuth's on-behalf-of grant) and sends it as the bearer
token. The API then decides as it would if they had called it themselves, and
its log names them. The hub holds no right of its own there: a person the API
refuses is refused, and the run's log says what the API answered.

What the hub may call this way is the deployment's to say, never an action's.
`AUTH_DELEGATES` names each delegate, the scope asked for, and the URLs its
token may be sent to; an action that names a delegate with a URL it does not
list fails without calling anything. So nobody who can write an action can
send a person's token somewhere else.

The person's token is at hand only in their own request, so such a run starts
only from a person's own signed-in request: the one that asks for it, signed
in on the page or through an app that holds their access token for the hub,
or the approval that starts it. It cannot be tried again or be a tool, and
the save refuses a definition that says so. Many at once works: each run is
called as the person who ticked them.

#### Asked by an agent, run as the approver

Put `approval: true` beside `onBehalf` (or a rule with `approval: true`), and
anyone the action lets in may ask for a run without a sign-in of their own:
an agent through `run_action`, a token the hub made, a schedule, a batch. The
run waits, and the approval that starts it runs it as the approver:

```yaml
approval: true
backend:
  type: webhook
  url: https://ops.example.org/users/{{ entity.fields.username }}/unlock
  onBehalf: ops
  finish: answer
  body: {}
```

- The run's log says so as it is asked: `requested by agent@example.org;
  waiting for approval; it runs as whoever approves it`. `run_action` answers
  the run with `approve`, the link to the run's page, for the agent to hand
  to the person.
- Only someone who may run the action on that entity themselves approves it:
  its access and its rules, as for their own run. A holder of
  `actions.approve` the rules do not let in there is refused, and the run
  waits.
- The approval that starts it must be the approver's own signed-in request,
  on the run's page or the batch's. One made with a token the hub made, by an
  agent, or with no access token of theirs is refused, and the run waits:
  approve it on the page. When the page's own sign-in passes a token for the
  hub that no longer verifies (a login proxy that refreshed the session may
  pass one for another API), the hub answers `401` with `signIn`, where the
  login proxy starts a fresh sign-in (`AUTH_SIGN_IN_PATH`); the page sends
  the person through it and back to the same page, and they approve again. Under a quorum, the other votes need no sign-in;
  the one that makes it enough does, and the run runs as that person.
- The API is called with the approver's token, so it decides and logs as it
  would for them. The run keeps who asked (`by`) and who it ran as
  (`decidedBy`), the activity row names `runsAs`, and the log says
  `approved by lead@example.org; it runs as lead@example.org, from their own
  signed-in approval`.
- A batch is approved once, with **Approve the waiting** on its page
  (`POST /v1/action-batches/{id}/approve`): every run of it that waits is
  approved as it would be alone, and runs as the approver. One the approver
  may not decide stays waiting, counted with why. A batch's line in the
  runs list says how many of its runs wait and opens that page, and so does
  the page of each run in it.
- **Approve** on a row of the approvals blueprint (a `decide` action) is the
  approver's own signed-in approval when they press it on the page: the run
  runs as them. Pressed with no access token of theirs, the decide run fails,
  says to approve on the run's page, and the run waits.
- An approver must be able to run the action there, so a run of an action
  only its asker may run has nobody to approve it but them. Turn on
  `selfApproval` for that: the asker then approves their own run, signed in,
  and it runs as them.
- A run approved this way keeps the right to run as the approver until it
  starts, however long it waits its turn behind others of its action (its
  `concurrency`, or a `serial` line). The approval asks the issuer for a
  grant that lasts (the `offline_access` scope beside the delegate's), and
  the hub keeps it on the run, sealed with `SECRET_KEY`. When the run's turn
  comes, the hub asks the issuer for a fresh token with it. The run lets go of
  it as it is handed on, or when it ends: it is used once. It lasts as long as
  the issuer lets that grant last. If the issuer gives none, the hub logs it,
  and a run that waits past the approval fails when its turn comes.
- Nothing else proves a person's yes after their request ends, so nothing
  reuses one. The hub never tries such a run again (`retry` is refused), and
  a run asked again (a batch's failed ones, a change set's with **Retry**, a
  new run) waits for a new approval, and runs as whoever gives it.
  An answer that is revealed (`finish: reveal`) goes to the request that asks
  for the run, so such an action cannot wait for approval.

Setting it up at the issuer, once:

- The hub's app is given the delegated permission on the API, consented by an
  admin or pre-authorized by the API, and `offline_access`, so an approved run
  that waits its turn can still run as its approver.
- The hub's pod runs with a workload identity that is that same app.
- The login proxy asks for the hub's own scope beside `openid` and passes the
  access token on (`--pass-access-token` on oauth2-proxy), so the hub has a
  token it may trade. An ID token cannot be traded.

**`github_workflow`** dispatches a workflow with `workflow_dispatch`.

```yaml
backend:
  type: github_workflow
  owner: example
  repo: platform
  workflow: upgrade-image.yml      # the file name under .github/workflows
  ref: main                        # the branch the workflow runs on (default main)
  secretRef: github_token          # a hub secret: a token with Actions read and write, and Checks read, on the repository
  inputs: { run: "{{ run.id }}", path: "{{ entity.fields.path }}", image: "{{ inputs.image }}", tag: "{{ inputs.tag }}" }
```

Every input is rendered and sent as text. GitHub takes at most ten inputs.
The hub asks GitHub for the run the dispatch starts, so the run's link is
that workflow run. The hub then looks at it every `ACTION_WATCH_SECONDS`
(default 30). The workflow still reports into its run. When the workflow run
ends without reporting, as when GitHub never starts its job, the hub finishes
the run with GitHub's conclusion and the reasons the failed jobs give, such
as a spent Actions allowance. When GitHub names no run, the link is the
workflow's page and the run waits for a report.

**`runner`** queues a job for a runner source, which claims it at once.

```yaml
backend:
  type: runner
  runner: lan-runner               # a source of class runner
  command: [kubectl, rollout, restart, "deployment/{{ entity.fields.name }}"]   # argv, rendered
  env: { NAMESPACE: "{{ entity.fields.namespace }}" }                            # rendered, on top of the runner's own
  timeout: 10m                     # default 10m
```

The command is argv: each argument goes to the program as it is, never
through a shell, so a value with a space, a quote, or a `$` needs no quoting.
A list renders two ways:

- **Inside other text, a list is JSON in one argument.** `"--want={{
  inputs.origins }}"` is `--want=["https://a.example.org","https://b.example.org"]`,
  and an empty list is `--want=[]`, so the argument is always there. Use this
  for a list and for the list `run.current` kept: the command reads each
  argument as JSON and compares them.
- **As the whole argument, a list is one argument per item**, and none for an
  empty list, so `[restart, "{{ inputs.workloads.key }}"]` runs `restart` with
  each key. Use it only for a list that comes last, since an empty one leaves
  no argument to mark where it was.
The runner runs the command, streams its output into the log, and finishes
the run with the exit code. A command that writes JSON lines names the run's
summary with a `summary` on a line, the last one wins; without one the
summary is the exit code. The run page shows a JSON line as its `msg` and
what else it carries, an error or a warning marked so, and the raw line on
hover.

A runner keeps one call to the hub open, and the hub answers it the moment a
job is queued, so a job starts in well under a second. `GET
/v1/ingest/runner/jobs?wait=<seconds>&max=<n>` is that call: `wait` holds it
for up to 30 seconds while nothing is queued, and `max` is how many jobs the
runner has room for. The stock runner runs up to `JOBS` commands at once
(default 4; 0 takes no jobs) and asks only for its free slots. A runner that
stops kills the commands it was running and reports each `failed`, so no run
is left open. While a command prints nothing, the runner says every half
minute that it still holds it, so a quiet job is never taken for a dead
one, however long its `timeout`. The hub gives up on a job two minutes
after its own `timeout` has passed with no result, or once its runner has
not been heard from for `ACTION_TIMEOUT_MINUTES` (A run lives by being
heard from, below).

The stock runner image is distroless and holds
only the runner; for jobs, build an image with the tools the jobs need and
copy `/runner` in from `orrery-runner`. `orrery-access-runner` is one: the
runner and `entra-grant` (Granting access in Entra, below). `orrery-azure-runner`
is another: the runner, `azure-restart` (Restarting Azure resources, below),
and `azure-job-start` (Starting Azure Container Apps jobs, below).
`orrery-telemetry-runner` is a third: the runner, `telemetry-query`
(Reading logs and metrics, below), and `annals-read` (Reading Annals'
tables, below).

**`job`** starts one container for the run, on a platform the estate runs.

```yaml
backend:
  type: job
  starter: job-starter             # a source of class runner: the starter that starts the job
  template: infra-apply            # one of the starter's own job templates, by name, or one the entity names
  image: "registry.example.org/infra/runner:{{ entity.fields.runner_version }}"   # rendered
  command: [infra, apply]          # argv, rendered (optional)
  args: ["--workspace", "{{ entity.key }}"]                                       # rendered (optional)
  env: { WORKSPACE: "{{ entity.key }}" }                                          # rendered (optional)
```

The starter claims the run the moment it is approved, starts a Kubernetes
Job or an Azure Container Apps job execution for it, and reports how its
container ended. Whoever asked need not stay. Use it for work that runs
long or waits for a person. One container for each run, below, has the
whole of it: what the job is handed, how it reports, the starter, and the
least role each platform needs.

**`record`** writes one entity of the catalog and succeeds the run.

```yaml
backend:
  type: record
  source: access-requests          # a source that pushes, registered for the blueprint
  blueprint: it_approval
  key: "orrery/{{ run.id }}"       # rendered
  mode: upsert                     # or enrich: only an entity that exists
  title: "{{ entity.title }} for {{ by.name }}"
  fields: { decision: pending, reason: "{{ inputs.reason }}", requested_at: "{{ run.at }}" }   # rendered
  relations: { app: "{{ entity.key }}" }                                                    # rendered
```

The entity is written as `source`, the same way that source's pusher would
write it, so it shows in that source's write record and the source owns what
it creates. A refused write fails the run with the hub's reason. A record
never writes a field or relation who a person is, or what a job runs as, is
decided from (Who may run an action, below), on any entity: the hub refuses to save such an action, and
checks again when a run starts.

**`caller`** hands nothing off: whoever asked for the run carries it out
and reports into it. It is for a tool that truly must run where it was
asked, and wants the hub's approval and a record of its own work: one that
needs the files, the sign-in, or the network of the machine it is on.

```yaml
backend: { type: caller }
backend: { type: caller, timeout: 8h }   # how long a run may go unheard from; default ACTION_TIMEOUT_MINUTES
```

Approved, or asked for without approval, the run waits `queued` for the one
who asked to start it, with the log line `waiting for <them> to start it`.
Their first `running` report starts it (Reporting back, below). A run nobody
starts within `ACTION_TIMEOUT_MINUTES` of its approval is cancelled, so a
tool that died while it waited leaves nothing open. Once started, it is
given up when the hub has not heard from it for its `timeout`; a tool that
keeps reporting keeps its run.

**Choose `job` instead when the work can run somewhere else.** With
`caller`, the thing that asked holds the work: it must still be awake when
the approval comes, and stay awake until the work ends. A run approved
after the asker went away is cancelled, and one whose asker died mid-work
ends `unknown`. An approval that takes hours, or work that takes hours,
outlives a shell, a laptop's lid, and an agent's session. A `job` holds
none of it in the asker: the run starts by itself when it is approved (One
container for each run, below).

The tool should ask as the person running it, so the run names who asked
and the approver knows whom they approve. A tool that holds a person's
sign-in asks the machine port with that person's access token
(`AUTH_API_SCOPE` in the README). `GET /v1/sign-in` on the machine port
answers, with no token, the `issuer` to ask and the `scope` to ask it for:

```bash
az account get-access-token --tenant <tenant> --scope "$(curl -s $ORRERY_URL/v1/sign-in | jq -r .scope)"
```

### Reports

An action with the `report` backend makes, changes, previews, or publishes
one of the hub's reports (docs/modelling.md, Reports). It acts as the
person who ran it, judged as theirs: the report's owner, someone who owns
the report's home, or an admin. Anyone else gets a failed run that says
why. Each verb reads its inputs by fixed names, and the action is refused
when it lacks one or names it with another kind:

| Verb | Runs on | Inputs |
| --- | --- | --- |
| `create` | nothing | `title` (string or text), `home` (entity, or a string holding `blueprint:key`), `layout` (markdown), `recipients` (email, many; optional), `note` (optional) |
| `edit` | `orrery_report` | `layout` (markdown), or `version` (number) to put that version back; `version` wins when both are sent; `note` (optional) |
| `recipients` | `orrery_report` | `recipients` (email, many) |
| `hand` | `orrery_report` | `owner` (email): the new owner's sign-in address |
| `preview` | `orrery_report` | `fresh` (boolean; optional): read every tool again |
| `publish` | `orrery_report` | none |
| `remove` | `orrery_report` | none |

A layout that does not read is refused before the run is written, naming
`layout` and every problem with its line.

The hub brings a whole set itself, under ids no estate may take:
`orrery_report_new`, `orrery_report_edit`, `orrery_report_restore`,
`orrery_report_preview`, `orrery_report_publish`, `orrery_report_recipients`,
`orrery_report_hand`, and `orrery_report_remove`. Each is open to everyone,
since the backend judges who may change the report, and none is a tile on
the self-service page: the Reports page and a report's own page offer them.
Nobody else changes or removes one, and no other action takes an id
starting `orrery_`. An estate defines its own beside them only to add what
they lack, such as an approval. The same set, as an estate would write it:

```yaml
- id: new_report
  title: New report
  access: { everyone: true }
  inputs:
    title: { type: string, required: true }
    home: { type: entity, blueprint: team, required: true }
    layout: { type: markdown, required: true }
    recipients: { type: email, many: true }
  backend: { type: report, verb: create }
- id: edit_report
  title: Edit report
  blueprint: orrery_report
  listed: false
  access: { everyone: true }
  inputs:
    layout: { type: markdown, required: true, default: "{{ entity.fields.layout }}" }
    note: { type: string, title: What changed }
  backend: { type: report, verb: edit }
- id: restore_report
  title: Put a version back
  blueprint: orrery_report
  listed: false
  access: { everyone: true }
  inputs: { version: { type: number, required: true } }
  backend: { type: report, verb: edit }
- id: preview_report
  title: Preview
  blueprint: orrery_report
  listed: false
  access: { everyone: true, tiers: [read] }   # the owner's writer and tools need the read tier on the report
  backend: { type: report, verb: preview }
- id: publish_report
  title: Publish
  blueprint: orrery_report
  listed: false
  schedule: { min: 1d }                        # only publish may be scheduled
  access: { everyone: true, tiers: [read] }
  backend: { type: report, verb: publish }
- id: report_recipients
  title: Change recipients
  blueprint: orrery_report
  listed: false
  access: { everyone: true }
  inputs: { recipients: { type: email, many: true, required: true } }
  backend: { type: report, verb: recipients }
```

Approvals, rules, and quorums work as on any action: put `approval: true`
on `edit_report` to have every layout change approved. A change is made
before the request answers. A publish or a preview runs on behind it, in
the steps **Gather**, **Write** (when it has narrative blocks), **Draw**,
then for a publish **Publish**, **Deliver**, and **Verify**, which reads
the edition back. Each ends with the headline numbers as outputs. A
preview's link opens the drawing on the report's page; it is kept with the
run and sent to nobody.

A `hand` moves the report's owner and the owner of every schedule that runs
on the report, in one run. It is refused, naming `owner`, unless the new
owner has signed in, may see the report, and can read every saved query and
call every tool its layout names: the report's data is read as them from
then on.

A publish tells the notification desk once, as `report.published`, naming
the recipients who sign in and may see the report then: at most 20, what
one event addresses. A wider audience subscribes to the report on the desk.

## Reporting back

A backend tells the hub how it is going:

```
POST /v1/action-runs/{id}/report
{ "state": "running" | "succeeded" | "failed", "label": "committing", "link": "https://...", "summary": "orrery is at 0.9.13", "log": ["checked out", "tag set"], "step": "Tag", "outputs": { "version": "0.9.13" } }
```

Every field is optional. Log lines are appended with the time they arrive.
`running` starts a run that is `queued`; on a serial action it is refused
with 409 while another run of its line is running (One at a time, below), and
on an action with a `concurrency` while it has no room (A few at a time,
below); the run stays `queued` until it may start. A
new `state` is logged too, with its summary (`succeeded: orrery is at 0.9.13`),
and a new summary on its own is logged as a line, so the log tells the whole
run. A terminal `state` closes the run and writes an `action.finished` activity
row.
The caller is an access token whose role holds `actions.report`. From a shell,
the CLI does it:

```bash
ORRERY_URL=https://orrery-ingest.example.org ORRERY_TOKEN=orr_acc_... \
  orrery report "$RUN" --label committing --log "tag set"
orrery report "$RUN" --state succeeded --link "$RUN_URL" --summary "orrery is at 0.9.13"
```

A runner reports on the job it claimed with its own source token, at
`POST /v1/ingest/runner/jobs/{id}/report`, the same body.

### Steps and outputs

A backend may say which step it is in and what the run ended with. Both are
optional: a run with neither is a log and a summary, as before.

A **step** is a name, 80 characters at most, and the moment it started. It
starts in one of three ways, and each line that follows is kept under it
until the next step starts:

- `step` on a report starts the step before that report's lines;
- a log line that is exactly `::step:: <name>` starts it, and the line
  itself is not kept;
- a JSON log line that carries a `step` starts it, and the line is kept.

Naming the step a run is already in starts nothing. A step has no end of its
own: it ends when the next one starts or the run finishes, and the step
under way when a run fails is the one that failed. The run page draws the
steps on its timeline with how long each took, and folds the log under them.

An **output** is a named value the run ended with: a version, an address, a
count. It is set in one of two ways:

- `outputs` on a report, an object of names to a text, a number, or a
  boolean, and `null` to take one away;
- a log line that is exactly `::output:: <name>=<value>`, which is not kept
  as a line.

A log line `::refresh:: <field>=<value>` hands back a value of the entity
the run is on, to write once the run succeeds; it is not kept as a line
(Writing back what a run changed, below).

A log line that is exactly `::final::` says the try's failure is the answer:
an action with a `retry` (Trying again) does not try it again. The line is not
kept.

A name is 1 to 64 of `A-Z a-z 0-9 _ . -`, a text is 2,000 characters at
most, and a run holds 50. The last value set for a name wins. A marker line
that breaks a rule is kept as an ordinary line, so nothing a backend says is
lost; a report whose `outputs` would take the run past 50 is refused with
400. The run page shows the outputs in a Result panel above the log, each
with a copy button, and a value that is a web address as a link.

An output may be a picture: a PNG, JPEG, or WebP image as a base64 data
address, `data:image/jpeg;base64,...`, of at most 256 KB. The run page shows
it as an image, such as a screenshot of what the job looked at. Where no
picture shows, in a notification or an agent's answer, it reads as what it
is and its size.
`get_action_run` and `GET /v1/action-runs/{id}` carry `steps` and `outputs`,
and the finished event the notification desk gets carries the outputs.

The markers are what a `runner` job uses: the runner passes each line of the
command's output on as it is, and the hub reads the markers. So a shell job
names its steps and outputs with `echo`:

```bash
echo "::step:: Restart"
kubectl -n "$NAMESPACE" rollout restart "deployment/$NAME"

echo "::step:: Verify"
kubectl -n "$NAMESPACE" rollout status "deployment/$NAME" --timeout=5m
echo "::output:: replicas=$(kubectl -n "$NAMESPACE" get "deployment/$NAME" -o jsonpath='{.status.readyReplicas}')"
```

A backend that reports for itself does the same with the CLI:

```bash
orrery report "$RUN" --step Tag --log "tag set"
orrery report "$RUN" --state succeeded --output version=0.9.13 --output url="$RELEASE_URL"
```

**Name the last step Verify, and only where it is true.** A backend's last
step is named `Verify` and checks that the effect was observed: the new
worker answered, the rollout finished, the tag is on the remote. A backend
that only asks for a change and does not look afterwards has no `Verify`
step. A reader then knows what a green run means.

**Outputs are not secret.** An output is what the backend chose to report,
and it is shown to whoever may see the run, on the page, through the API, to
agents, and on the notification desk. Never put a password, a token, or a
key in one, or in a log line. The hub itself never puts a secret in an
output.

### A run lives by being heard from

A run under way lives by being heard from, not by a clock that started
with it. Every report counts, one that carries nothing included: `POST
/v1/action-runs/{id}/report` with `{}` or no body says only that the run is
alive, changes nothing a reader sees, and is stored at most once a minute.
A run that keeps reporting is never given up for how long it has run.

A run the hub has not heard from for `ACTION_TIMEOUT_MINUTES` (default 60),
counted from its last report, or from its start when nothing reported, is
given up with the log line `not heard from for 60 minutes; given up`.
Nothing said how it ended, and it may have done its work, so it ends
`unknown`, never `failed`; its backend may still report how it ended, and
that settles it. `heardAt` on a run says when the hub last heard from it.

An action may also name a `ceiling`, the longest a run may stay running
however often it reports:

```yaml
ceiling: 12h
```

A run past it ends `unknown` the same way, with `no result after 720
minutes; given up`. Each backend meets the two the way it holds its work:

| Backend | Given up for silence after | Its ceiling |
|---|---|---|
| `webhook`, `github_workflow` | `ACTION_TIMEOUT_MINUTES` | The action's `ceiling`, or none |
| `caller` | Its own `timeout`, or `ACTION_TIMEOUT_MINUTES` | The action's `ceiling`, or none |
| `runner` | `ACTION_TIMEOUT_MINUTES`; its runner says every half minute that it holds a quiet command | Its own `timeout` and two minutes more: the runner ends the command then. It takes no `ceiling` |
| `job` | `ACTION_TIMEOUT_MINUTES`; its starter says on every pass that the job runs | The action's `ceiling`, 7 days when it names none, and five minutes more: the starter stops the job then |

A GitHub workflow the hub watches is heard from each time GitHub says it is
still going, so a long workflow is not given up while GitHub can be asked
about it; one that has already ended is finished sooner, as
`github_workflow` above says. An approved `caller` run nobody starts within
`ACTION_TIMEOUT_MINUTES` is cancelled. `record`, `decide`, `schedule`, and
`report` runs are the hub's own, end as they start, and take no `ceiling`.

### Writing back what a run changed

A run often changes a value in the world that a source also reads into the
catalog, such as the web origins an app allows. The source comes round on
its own schedule, an hour later perhaps, and until then the catalog shows
the old value. The run knows the new one the moment it succeeds, so it can
hand it back.

The action names the fields it may write back, under `refreshes`:

```yaml
actions:
  - id: set_allowed_origins
    title: Set allowed origins
    blueprint: entra_app
    where: { field: allowed_origins, op: exists }
    inputs:
      origins: { type: string, required: true, description: The origins, one per line. }
    refreshes: [allowed_origins, allow_credentials]
    backend:
      type: runner
      runner: lan-runner
      command: [set-origins, "{{ entity.key }}", "{{ inputs.origins }}"]
```

Its command prints one line for each field, once it has set it:

```bash
echo '::refresh:: allowed_origins=["https://app.example.org","https://admin.example.org"]'
echo '::refresh:: allow_credentials=true'
```

The line is exactly `::refresh:: <field>=<value>`. The value is JSON: a
list is a JSON array, a boolean `true` or `false`, a number as it is
written, and a text in double quotes. A value that is not JSON is taken as
the text written, so `::refresh:: owner=platform` is the text `platform`.
A line is 64 KB at most; a longer one, or one that breaks the rule, stays an
ordinary log line. The line works from anything that reports: a command in
any language prints it, and the runner passes every line on as it is; a
backend that reports for itself puts it in `log`, and `orrery report --log`
does the same. No SDK is needed. The last value for a field wins.

The hub holds what the run hands back until the run ends, and then:

- **Only when the run succeeds.** A run that fails writes nothing, and its
  log says so; a run that is cancelled writes nothing either. A run whose outcome is `unknown` keeps what
  it handed back until its backend says how it ended. A run that is tried
  again starts with nothing held.
- **Only on the run's own entity.** The line names no entity: it is always
  the one the run ran on, in a batch each run's own.
- **Only the fields the action names.** A line for any other field is
  dropped as it arrives, with a log line that names it.
- **As the entity's owning source.** The value lands in that source's
  pushed layer, the way its own push writes it, so a field access is decided
  from, which only the owning source may write, takes it. The source's next
  push replaces it as usual. An entity kept by git or by people, or one that
  is gone, writes nothing, and the log says why.
- **A value of the wrong type is refused alone.** It is not written, the log
  says why (`not written back: allowed_origins: expected an array, got
  string`), and the run still succeeds with the rest written.

What was written is recorded: an `action.wrote_back` activity row names the
run, the action, the entity, the source it was written as, and each field
with the value it held before and the one it holds now. The run's page shows
a **Wrote back** panel with the same, beside the Result, and the run's
answer carries it as `wroteBack: [{field, was, now}]`; a reader who may not
see a field is not shown it there. A field that already held the value is
not written and not listed.

The hub refuses to save an action whose `refreshes` names a field that is not
a field of every blueprint it runs on, or one the hub works out (a
calculation, a mirror, an aggregation, a history trend), or one who a person
is, or what a job runs as, is decided from. It also refuses an action on no blueprint, and a backend
that reports nothing back: `record`, `decide`, `schedule`, `report`, and a
webhook with `finish`. A `runner`, a reporting `webhook`, a `caller`, and a
`github_workflow` whose steps call `orrery report` all write back the same
way.

## Who may run an action

Nobody but an admin, until the action says so. Its `access` block names who,
with the same grants that decide who sees a blueprint (see "Who sees what"
in the README): each grant starts from the signed-in person's own entity,
follows `path`, and lets them in when a value it reads is in `values`. A
grant with no path names people by their sign-in address, or a machine access
token by its name. Any grant is enough; `everyone: true` opens the action to
anyone signed in.

```yaml
access:
  everyone: false
  grants:
    - { values: [ada@example.org, release-bot] }        # these people and this token
    - { path: teams, values: [platform] }                 # anyone on the platform team
    - { path: teams.<-program:team, values: [orrery] }    # anyone on the team that owns the orrery program
```

So one project can carry ten actions for different hands: two for everyone
on the program, four for its developers, two for the infrastructure team,
and two for a few named people. The same grant shape covers all of them.

### An action's home

An action may name one entity it belongs to: `home: <blueprint>:<key>`. The
home is an entity of any blueprint, such as the program, the team, or the
product the action serves. The hub gives no blueprint a special meaning
here: the catalog's own entities are the homes, and the person setting's
ownership paths (README, What is yours) say who owns each one.

A home does two things.

- **It is where the action is listed.** On the Self-service page the action
  sits in its home's section, headed by the home's icon and title, in place
  of its `group`. The home's own page lists its actions as tiles, under
  Actions. An action with no `icon` is drawn with its home's icon.
- **It can say who runs it.** `home: true` under `access` opens the action
  to whoever owns its home, on everything it runs on, as a grant would. A
  list, such as `home: [lead]`, takes only those who own it in one of those
  ways: the `as` names of the ownership paths. So the people of a program
  run the program's actions, and nobody keeps a list of them on each one.

```yaml
- id: rotate_keys
  title: Rotate keys
  home: program:orrery
  access:
    home: [developer]     # the developers of the orrery program
```

The rules that keep this safe:

- Only an admin sets `home`, as only an admin sets `access`. A save by
  anyone else keeps the home it had. The home's blueprint must exist, and be
  one the person saving may see. The entity itself need not exist yet.
- `access.home` needs a `home`. It lets nobody in while the hub does not
  know what a person owns: no ownership paths, or no entity for the person.
- What a home's people are read from is guarded like every other value
  access is decided from (What the rules read is guarded, below).
- A reader who may not see the home's blueprint is told nothing of the home:
  not its id, title, or icon. For them the action sits under its `group`.
  The same holds when the home's entity is gone.
- `GET /v1/actions` gives each action `homeShown`: `{id, entity, title,
  icon, yours}` as the reader sees the home, or null. `yours` is true when
  the reader owns it. `home` stays what the definition says.
  `GET /v1/actions?for=<email>` and `list_actions` give `home: {id, title}`.
- `GET /v1/actions` also gives `reads`: the blueprints what the reader owns
  is read from, when any action has a home or a rule asks who owns what. The
  page reads its actions and pins again when one of them changes, so an
  action shows up, or leaves, as ownership moves. A machine gets none.

The Security page has an Actions tab: every action as a row, with its home,
who may run it, how many people that is, whether a run waits for approval,
its backend, and when it last ran. It says "its home's people" where an
action is open that way. Its filters keep what one person may run, what a
team or an audience opens, one backend, and what is open to everyone, never
waits for approval, or never ran. A row opens to the people it lets in.

The page raises three findings about actions: one open to the people of a
home nobody owns, one whose home is no longer in the catalog, and one nobody
has run in the last 90 days whose definition has not changed in that time.
An action with no form counts by its runs like any other.

The Self-service page is a start page. At the top, only while something
waits, are the runs that need the reader's approval: how many, and the first
three, each with Approve and Decline. Under it is one search box, which the
`/` key reaches, and a filter by blueprint. Then come the reader's recent
runs, the newest of each action and target and five at most, each with an
Again that opens the form filled in as that run was. Nothing is stored for
that list: it is read from the runs they asked by hand
(`GET /v1/action-runs?by=<them>&scheduled=false`). What their schedules fire
runs as them too, but is not listed there; it is on the Schedules page.

Beside the recent runs is Pinned: the actions the reader starred, as tiles
in the order they keep them. The star on a tile, and on an action's own
page, pins it or lets it go, and each pinned tile has Move earlier and Move
later. Pins are a person's own and the hub keeps them, so they are the same
in every browser: 50 at most, changed by nobody else, and written to no
activity log. A pin to an action the person may no longer run or change is
kept and not shown, and shows again when the action opens to them again. A
machine's token keeps none. An admin viewing the hub as someone sees that
person's pins and changes none.

| Call | What it does |
| --- | --- |
| `GET /v1/mine/pins` | `{pins: [{kind, id}]}`, in order: the pins to actions the caller may run or change today, and to blueprints they see, which the catalog's list puts first |
| `PUT /v1/mine/pins/action/<id>` | Pin an action the caller may run or change, after the others. Pinning one again changes nothing |
| `DELETE /v1/mine/pins/action/<id>` | Let a pin go |
| `PUT /v1/mine/pins` | Body `{order: [{kind: "action", id}]}`: the named pins come first, in that order, and the rest keep theirs after them |

Each answers the pins as they now stand. An action in `GET /v1/actions`
says `pinned` for a person, and `list_actions` says the same to an agent.

Below, the actions are small tiles in sections. An action with a home sits
in its home's section, headed by the home's icon and title, which open the
home's page. The homes the reader owns come first, headed "Your" and the
blueprint's title, such as "Your program: Orrery". Then come the other homes
and the groups, then "Everything else": the actions with neither. A tile is
the action's icon and its title. The tile opens the form in a panel at the side of the
page, and a small control on it opens the action's own page. The description
is the tile's hover text, and is read in full at the top of the form. An
action with no `icon` is drawn with the icon of its home, else with the icon
of the blueprint it runs on when it runs on exactly one, and with a rocket
otherwise. A tile carries a
mark when the action needs approval, and another when its last three runs or
more all failed. The form says the same of a failing action, and how long
the action usually takes: the median of its last twenty runs that succeeded,
once three have.

Beside the tiles the runs are a list, in three tabs: the person's own, those
waiting for their approval, and everyone's. A run is named by what it ran
on, by title. A run's page shows what happened to it as a timeline (how long
it waited for approval, how long it sat queued and which runner took it, how
long it ran, and each step the backend named with its duration), then what it
ended with in a Result panel, then its log as it grows, and a Run again that
opens the form filled in as that run was. The log keeps a terminal's colours,
shows each line's time since the run started, folds under the steps (a step
under way or failed is open, a finished one closed), follows the newest line
when asked, and can be searched, copied, and downloaded as `<run id>.log`. Anyone folds a section
for themselves; whoever holds `catalog.organize` sets the order of the
sections and which start closed, for everyone, with the Organize control on
the page. The shared order names a home by its entity id and a group by its
name, and a reader's own homes are lifted above it for them alone. A home
the reader may not see is left out of the order they read, and kept where
it was when they save.

An action a person may not run is not there for them: not on the
Self-service page, not on an entity, not in an agent's answers. A holder of
`actions.manage` sees every action they may see the blueprints of, marked
with whether they may run it, so they can edit what they cannot run. Only an
admin sets or changes an action's `access` or its `home`, the way only an admin sets who
sees a blueprint; and the blueprints a grant's path reads through take
changes from admins only, so nobody adds themselves to a team.

| Permission | Lets a person or a token |
| --- | --- |
| `actions.report` | report on runs: for the workflows and runners that do the work |
| `actions.approve` | approve or decline any run that waits for it |
| `actions.manage` | define and remove actions |
| `actions.ask` | ask for an action in a named person's name (Asking in a person's name, below): for a product that takes a signed-in person's request. A machine access token only |
| `tools.lend` | call a tool in a named person's name, with the tiers their request holds (Tools, below): for a product whose agent works that person's request. A machine access token only |
| `tools.read` | call any tool of the `read` tier: for an assistant that only looks |
| `actions.list` | list the actions a named person may run, `GET /v1/actions?for=<email>`: for a portal that shows each person their own buttons. It reads as that person, changes nothing, and answers only what a button needs: id, title, description, icon, the icon to draw (`iconShown`), group, home (`{id, title}`, when the person may see it), blueprint, approval, and the last run |

An action with `approval: true` holds every run in `awaiting` until someone
other than the requester approves it; declining closes it. A holder of
`actions.approve` decides any run. On an entity, so does anyone a rule lets
run the action there without approval: the people trusted to do it
themselves vouch for someone else. Each run awaiting approval says whether
the reader may decide it, as `canDecide`. The run keeps
who decided and when, as `decidedBy` and `decidedAt`. The runs waiting for a
person's approval are counted beside Self-service in the top bar, and the
tab of runs waiting for their approval has Approve and Decline on each row;
a reason for declining is given on the run's page.
`GET /v1/action-runs?by=<name>` lists the runs one person or token asked for.

Whoever may decide a run has a third answer: send it back. `POST
/v1/action-runs/{id}/return` with `{note}`, or Send back on the run's page,
ends the run as `returned` and keeps the note, which says what to change.
The run page of the person who asked shows it. They ask again with a new
run that names the old one, `revises: <run id>`, so the two read as one
story; only their own run of that action on that entity is revised, and only
one sent back or one still waiting for its decision. A declined run is over;
a returned one is an invitation.

Each run that revises another is the next round of the same ask. A round
that revises a run still waiting supersedes it: the older round ends
`cancelled`, its log saying `superseded by run <id>, its next round`, so only
the newest round of an ask is ever decided. A product that hears a person's
answer somewhere else, such as a comment on its ticket, asks its next round
this way without waiting for anyone to send the run back.

### Who asks

A run a person's agent asks for, with a personal token its person made for
it, is the person's run (`by`) and the agent's ask (`agent`, the token's
name). The run page says `Asked by the agent <name> for <person>`, its log
says `requested by <name>, the agent of <person>`, and every activity row the
agent writes carries `detail.agent`, so Annals records the agent as the
actor, for its person. The agent sees and may run what its person may, and it
never decides a run or a schedule: its person, or someone else, decides it
signed in.

Whether the person decides what their own agent asks is the deployment's
(`AGENT_PERSON_DECIDES`). With `true`, they are not its asker: they may give
the action's own approval and what its route asks, as anyone else would, and
they are told it waits. With `false`, the default, the agent and its person
are one asker, and someone else decides it. Either way an agent's yes counts
for nothing.

`selfApproval: true` lets the person who asked approve their own run too,
when they may approve it at all. It is for an estate with one approver: the
run still names who asked and who approved, its log says `approved by <them>,
who asked for it`, and the activity row carries `selfApproved: true`. Turn it
off once a second person approves, and the two-person check is back.

A run that would wait for an approval nobody can give is refused as it is
asked: each person who signs in is judged as their Approve button would
judge them, and when none may decide it the ask answers `409` with what
would let someone (`selfApproval`, `actions.approve`, or a rule that runs it
without approval). In a batch each such run is turned down with that reason,
as one the rules turn down is. A run whose product named its `approvers`
waits for them, signed in yet or not.

A rule may say the same for the people it lets in: `approval: self` holds
their runs until they approve them themselves, having read what they asked
for (Who may run an action on what, below). It is for a request a product
drew up for them, such as a plan: the person sees it before anything runs.
A run held that way is decided by its asker alone, while a rule still lets
them run the action there: nobody else the same rule lets in, no holder of
`actions.approve`, and no admin approves, declines, or sends it back. An
admin still withdraws it. A rule that says self never lets a person vouch
for someone else's run. A run that asks for a tool tier its action does
not carry waits for someone who holds that tier instead, as any other run.
Each run says whose approval it waits for, from the moment it is asked:
`heldFor` is `self` for its asker's alone, `others` for someone else's, and
null for a run that never waited. A product that relays the decision checks
it against `heldFor` and `decidedBy`.

A product that asks in a person's name may also name who decides the run
when it waits: `approvers`, a list of grants in the shape a rule's take
(`{ path, field, values }`), judged on the decider's own person entity.
`[{ path: teams, values: [platform-engineering] }]` names everyone on that
team. Then only someone those grants let in approves, declines, or sends
the run back: never the person it was asked for, and no admin or holder of
`actions.approve` by that alone. The rules still say whether it waits; the
approvers only say who decides it. A tool tier it asks for is still granted
only by an approver who holds it. A person asking for themselves names no
approvers: the hub refuses it. The product checks a decider itself before
it acts on a decision with `POST /v1/access/lets-in` (`{address, grants}`,
answered `{letsIn}`; a machine access token holding `actions.ask`). The run keeps them as `approvers`, and the
approvals inbox names those people as its `approvers`.

A product may also ask a run as itself, for a person who stays data:
`requestedFor: <address>` in place of `for`, from a machine access token
holding `actions.ask`. The action's own access must let the product in, as
any caller: a grant that names the token, `{ values: [<token name>] }`. The
person needs no role and sees nothing; the hub does not add them. The run
is the product's (`by` is the token), keeps the person as `requestedFor`,
and its page reads "Asked by the product for them". The person never
decides it, whoever else would. With `approvers` it always waits, for one
of them, whatever the rule says: the product asks for their decision. Its
waiting notice goes to the approvers and names the person as "Asked for";
what becomes of it is told to nobody, so whatever the person hears comes
from the product. A tool tier its approver granted is lent to that person's
request (`as` with the run) while the run is under way and the product may
still ask for the action there, even when the person may not ask for it;
the lane's own tiers still need the person let in. The approvals inbox
names the person as its `requester`.

Whoever decides a run may leave a note: `POST
/v1/action-runs/{id}/approve` and `/decline` take an optional `{note}` and
`{reason}`. The run keeps it as `note`, beside `decidedBy` and `decidedAt`,
its page shows it, and the approvals inbox carries it as `decision_note`.

A job's run under way is stopped with the same call (How long it may run,
and stopping it, below).
The person who asked withdraws a run not started yet, waiting for approval
or approved, with `POST /v1/action-runs/{id}/withdraw` (body `{reason?}`), or
with Withdraw it on the run's page; so does an admin. It ends `cancelled` and
never runs.

### Asking in a person's name

A product that takes a signed-in person's request, such as a desk a person
reports a problem to, asks for the run as that person: `POST
/v1/actions/{id}/run` with `for: <their sign-in address>`, on the machine
port, with a machine access token whose role holds `actions.ask`.

```
POST /v1/actions/change_stakeholder/run
{ "entity": { "blueprint": "repository", "key": "shop-api" }, "inputs": { "request": "req-41" }, "for": "ada@example.org" }
```

- The hub judges the request exactly as if the person had asked: the rules
  that let them in, the entities they may ask on, and whether it waits.
- The run names the person as who asked. Its log and its activity row name
  the product too (`requested by ada@example.org through desk`, `detail.via`),
  and in Annals the product is the actor, on the person's behalf.
- The product never borrows an admin's override. Asked for through a
  product, an admin is a person the rules either name or do not.
- A person the hub has not met is added with no role, as on a first
  sign-in. They may still ask only where a rule names them.
- Before it asks, the product can read where the person may ask: `GET
  /v1/actions/{id}/targets?for=<their sign-in address>`, with a machine
  access token whose role holds `actions.list`. It answers `{entities,
  approval}` as the rules alone judge that person: the entities they may
  run the action on, and the ids of those where a run waits. Someone the
  hub has not met is judged the same way, as a person with no role whom a
  rule may still name by address, and reading adds nobody.
- A person, or a token without the permission, is refused with 403, and the
  refusal is recorded.

### An action with no form

`form: false` is for an action whose work only a tool can do, such as a CLI
that applies the plan it saved on its own machine. Nobody gets a form for it:
it is not on the Self-service page, not on an entity, and not among the
actions an agent is offered, and a browser or an agent that asks to run it
is refused with 403, recorded as a refusal. A tool asks for its runs on the
machine port, under the action's own `access`. Its runs, the approvals they
wait for, the notices they send, and their history show as any other's, and
a holder of `actions.manage` still opens the action from its runs to edit it.

### An action run only from its rows

`listed: false` keeps an action off the Self-service page: no tile, no pin,
and nothing on its home's page. People run it where it belongs, from a row of
its blueprint, an entity's page, or a tick of several, such as approving a
record in an approvals inbox. It needs a `blueprint`, and runs, approvals,
and access work as for any other action.

Every action is one of two kinds, and its definition says which:

- **A form action** is something a person sets out to do: send a command,
  deploy, request access, reserve an address. They start from the
  Self-service page, and the form asks what it runs on when it runs on
  something. It is listed.
- **A row action** answers a record that asks something of a person, such as
  an approval to decide or an alert to acknowledge. Nobody sets out to do it
  in general: they meet the record and act on it. It sits only on the
  record's row and page, and is `listed: false`. Its inputs, such as why a
  run was declined, are still asked when it runs.

When an action could be either, ask where a person is when they want it. If
they are looking at the record, it is a row action.

```yaml
id: approve_in_inbox
blueprint: it_approval
listed: false
backend: { type: decide, verdict: approve }
```

### More than one approval

An action that waits for approval needs one yes by default. `quorum` asks for more:

```yaml
id: restart_prod_database
blueprint: db_instance
approval: true
quorum: { need: 2 }
```

- The run waits until `need` different people have approved. Whoever may approve it by the action's rules approves; the same
  person's second yes is refused, and they are shown nothing more to decide. A decline or a send back from anyone ends it at once.
- Each approval is kept on the run (`approvedBy`) and logged as `action.voted`; the one that makes it enough starts the run and
  is the one `decidedBy` names. Two people approving at the same moment are two yeses, and the run starts once.
- The count is fixed when the run is asked. Changing the action later moves no run already waiting.
- A batch asks the same count of each run. A rule that lets someone approve their own run (`approval: self`) cannot be used with
  `quorum`, and an action nobody approves has no one to ask.
- `quorum` is an object so a rule beyond a bare count, such as one yes from each of two teams, can sit beside `need` without
  changing what exists.
- The inbox record says it: `approvals_needed`, and `approved_by` while it waits. For an approval another system holds, such as
  an Azure DevOps check, the connector sets `approvals_needed` from the check's own minimum. Orrery never decides that count
  for the owner; the owner's check is what DevOps enforces.

### One at a time

`serial` names the inputs that make runs one line. Runs of the action on the
same entity with the same values of those inputs are one line; `serial: []`
makes the entity alone the line.

```yaml
id: infra_apply
blueprint: sw_service
approval: true
inputs:
  environment: { type: string, required: true }
  commit: { type: string }
serial: [environment]
backend: { type: caller }
```

- Asking again for exactly what a run not started yet asked for, as the same
  person, gives back that run: nobody approves the same thing twice.
- A newer request of the line cancels every run of it not started yet,
  waiting for approval or approved, with the log line `replaced by run <id>`.
  Only the newest is ever approved and run.
- Only one run of the line runs at a time. A start while another runs is
  refused, and the run waits `queued` until that one ends.

Only a `runner`, a `job`, or a `caller` backend may be serial, because the
hub sees when they start; a runner or a starter is not handed a run whose
line is busy.

### A few at a time

`concurrency` is the most runs of the action in flight at once, on any
entity, across every batch and every single run. It is for a backend that
does one call at a time, or only a few, where handing it everything at once
would queue the work behind its own door until the hub stops waiting.

```yaml
id: grant_access
blueprint: account
batch: { max: 100 }
concurrency: 1
backend: { type: webhook, url: "https://grants.example.org/grant", finish: answer, timeout: 2m }
```

- A run with no room stays `queued`, with `waits its turn: 1 of its runs are
  in flight, the most it runs at once` in its log. Nothing is replaced or
  dropped: every run asked for, approved, or tried again runs.
- Runs take their turn oldest first, a run asked for alone before a run of a
  batch. As one ends (succeeded, failed, unknown, or put back to be tried
  again) the hub hands on the next.
- Approving many batches at once, or many runs one after another, keeps to
  it: a turn is taken under a lock, on any hub.
- A runner is not handed a job with no room, and a caller's start is refused
  with 409 until there is room.

Only a backend whose end the hub sees may name it: a `runner`, a `webhook`,
a `caller`, or a `github_workflow`. A webhook whose answer is revealed may
not, since its answer is given only on the request that asked for the run.
`serial` and `concurrency` may stand together: a run then waits for both.

Every request, refusal, approval, decline, cancel, and finish is an activity row
under the `actions` category, with the run id, the entity, and who did it. With Annals configured, each of those rows is also an event in it (README, Access), so a run's whole story, who asked, who approved, and how it ended, sits beside what every other product did.

### Many at once

`batch` lets a person run the action on many entities at once. `max` is the
most one batch holds, 50,000 at most. The hub plans one of thousands in a moment; the preview names the first 500 it runs on and counts all of them.

```yaml
id: kiosk_command
blueprint: kiosk
batch: { max: 5000 }
retry: { tries: 3, backoff: 5s }
inputs:
  command: { type: enum, values: [ping, restart, reboot], required: true }
backend: { type: runner, runner: kiosk-commands, command: [/kioskctl, "{{ inputs.command }}", "{{ entity.key }}"] }
```

- On the blueprint's grid, a person who may run it ticks rows, or ticks the box
  at the top for every row the grid's filter matches, and the action shows in
  the bar along the top. A person who may not edit the blueprint still ticks
  rows when a batch action is theirs to run.
- The drawer asks the action's own form once, then lists every entity it
  would run on, by title, and the ones it would not, with why: one gone, one
  the action's `where` leaves out, one no rule lets them run it on, or one
  whose own value an input refuses. Nothing is sent until they tick that they
  mean it and press Run. `POST /v1/actions/{id}/batch/preview` answers the
  same list.
- An input marked `narrows` is never asked of a batch: each run fills it from
  its own entity, as a run on one entity does, so one batch restarts apps in
  several environments, each run holding its own. What else is asked is one
  answer for all, so an input that reads the entity, or reads an input that
  narrows (in its `when`, its `value`, or a template), cannot be asked once
  for many: an action with `batch` and such an input is refused when it is
  saved.
- Sent (`POST /v1/actions/{id}/batch`), each entity gets its own run, judged by
  the same rules as a run asked for alone: a run that needs approval waits for
  it, and its deciders hear of it as of any other. The runs name the batch.
- A runner is handed every run asked for alone before any run of a batch, so
  one person's thousand never holds up another person's one. A runner runs as
  many at once as its `JOBS` says, and says so each time it asks for work
  (`width`), which the hub keeps on the runner's source.
- The drawer says how long the batch takes before it is sent: the action's
  mean time a run (its newest 50 that ended with the same inputs, failed ones
  too, or with any inputs while fewer than three did) times the runs,
  with what already waits for the same runner, over the runner's width. A
  webhook or workflow is handed every run at once, so it takes one run's time.
  It says nothing until the action has three timed runs, or while the runner
  has never said its width. `estimate` and `ahead` on the preview carry it.
- The batch page says how long is left (`left`): from the same history at
  first, then at the batch's own pace, once 20 of its runs have ended in the
  last five minutes. That pace holds what the history cannot see: claiming,
  retries, a slow day.
- The batch's page (`/actions/batches/{id}`) shows a card for every entity:
  how its newest run stands, what it said, and the first image it reported.
  The counts at the top filter the cards. Whoever asked, or an admin, stops it
  (what has not started is cancelled; what runs finishes), runs one entity
  again, or runs every one that failed again, in the same batch.
- An image a run reported is read alone at `GET
  /v1/action-runs/{run}/outputs/{name}`, so a page of a thousand cards loads
  each as it scrolls into view.
- With a `retry` (below), a run that fails for a passing reason is tried again
  before its card says failed, so a batch shows what each entity really said
  rather than a hiccup. A card waiting for its next try says Retrying, and
  past the first try, which try it is on.
- The runs list shows a batch as one line where its runs would have been many:
  what ran, on how many, a bar of how its runs stand, the picture one of them
  reported, and how long it took. Opened, it lists every run, the failed
  first, each opening its own page. `GET /v1/action-runs?group=batch` answers
  the runs asked alone in `runs` and the batches of the same span in
  `batches`, each with `cover` (the picture) and `endedAt`.
- What a schedule fired is one line too: one line a schedule a day, so a
  schedule that fires every hour does not bury what people asked by hand. The
  line names the schedule, how often it fires, what it runs on, how many times
  it fired, a bar of how its runs stand, and why the newest failure failed,
  counting a firing that asked nothing. Opened, it lists each firing, a batch
  as one line. `GET /v1/action-runs?group=origin&tz=<zone>` answers the runs
  and batches a person asked by hand in `runs` and `batches`, and the
  schedules' days of the same span in `schedules`, each day read in `tz`.
  Adding `schedule=<id>&from=<instant>&to=<instant>` lists that schedule's
  firings over the span instead. A reader sees a schedule's line where they
  would see its batches, and what it runs on only when it is theirs.
- The activity log holds one row for asking the batch (`action.batched`), one
  for each run's end as for any run, and one when its last run ends
  (`action.batch_finished`). The log page shows the batch as that first row,
  with how it stands, and opens it to every row it wrote:
  `GET /v1/changes?fold=batches` folds them and names each batch in
  `batches`, and `?batch=<id>` reads one batch's rows. Looking for one kind of
  row, or only what was refused or failed, shows every row unfolded. The dispatch desk hears of the batch when it is
  asked and when it ends, never of each run.

Every input of a batch is asked once for all of them, so an input whose
options, filter, default, or words read the entity it runs on is refused, as is
an action with an input that `narrows` what it runs on. The grid offers an
action for many only when each of its inputs is one pick from a fixed list.

### Many changes for one decision

A batch is one action with one answer for many entities. A change set is many
runs asked together for one decision, each with its own action, entity, and
inputs: add one person to one program and another to a second, and set a
third person's function, in one set. It is made by an agent or a product as
much as by a person, so it is asked through the API (`POST /v1/change-sets`)
or the agent's `propose_changes` tool, and decided on its page.

```json
{
  "title": "Program members for the fall term",
  "note": "The roster the program leads sent on Monday.",
  "items": [
    { "action": "add_to_program", "entity": { "blueprint": "person", "key": "a" }, "inputs": { "program": "program:803" } },
    { "action": "add_to_program", "entity": { "blueprint": "person", "key": "b" }, "inputs": { "program": "program:987" } },
    { "action": "set_function", "entity": { "blueprint": "person", "key": "c" }, "inputs": { "function": "QA" } }
  ]
}
```

- Every item is judged as a run of it alone would be: the action is open to
  whoever asks, its `where` takes the entity, a rule lets them run it there,
  and each input is checked as its kind checks it. When any item would be
  refused, nothing is asked, and the answer is `{error, items}`: each refused
  item by its `index`, with its `error` and, when the refusal is about one,
  its `input`. A set holds at most 500 changes.
- Every run of a set waits for the set's one decision, even one a rule would
  run at once. When whoever asked could run every item without anyone else's
  approval, it waits for their own yes; otherwise for someone else, each run
  decided by the rules that decide a run alone (`selfApproval`, a quorum, a
  rule that trusts someone there). Someone must be able to decide every run
  of it, and see what each runs on, or it is refused as it is asked.
- The approver sees one thing: one line in their approvals on the
  Self-service page, one record in the estate's approvals blueprint
  (`orrery/set/<id>`, kind `change set`), and one notice from the desk
  (`action.set_awaiting_approval`), with Approve all and Reject. The runs of a
  set never show as approvals of their own, and none is decided or withdrawn
  alone: their own approve, decline, and withdraw answer 409 with the set's
  link.
- The set's page (`/actions/sets/{id}`) lists every run, grouped by action and
  then by inputs, with what each runs on, then how each stands once it runs.
  Each run's page links back to its set, and the runs list shows a set as one
  line.
- One approval (`POST /v1/change-sets/{id}/approve`) approves every run that
  waits, in the set's order, each as it would be approved alone. Nothing is
  approved unless the approver may decide every one. A run called as a person
  (`onBehalf`) runs as the approver, from their own signed-in approval, so a
  set holding one is approved on its page. A quorum asks each approver once
  for the whole set. Approved runs keep to each action's `concurrency`, and
  the runs of one action wait their turn in the order the set names them.
- `reject` declines every run that waits; `withdraw`, by whoever asked or an
  admin, cancels every one while the set waits.
- Once every run has ended with some failed, whoever asked (or an admin)
  asks again for the failed ones (`POST /v1/change-sets/{id}/retry`): a new
  set, judged and decided like the first, naming it as `retries`.
- `GET /v1/change-sets` lists the newest sets the reader may see, `by=<address>`
  those one person asked, and `waiting=true` those that wait for the reader's
  own decision. A reader sees a set only when they may see what every run of
  it runs on.
- The activity log holds a row for asking the set (`action.set_requested`),
  for its decision (`action.set_approved`, `action.set_rejected`,
  `action.set_withdrawn`), and for its end (`action.set_finished`), and each
  run's own rows name the set as `set`.

### Trying again

`retry` tries a failed run again, in the same run, before it is called
failed. `tries` is how many tries a run gets in all, 2 to 5. `backoff` is the
first wait, 1s to 10m; each wait after it is three times the one before, with
up to a fifth more at random, so a batch's retries do not land at once.

```yaml
retry: { tries: 3, backoff: 5s }    # waits about 5s, then 15s
```

- A try fails when its backend reports `failed`, a webhook answers a server
  error (5xx but 504), 408, or 429, or cannot be reached, or a workflow ends failed
  without reporting. The run goes back to the queue with a line in its log,
  `try 1 of 3 failed: <why>; trying again in 5s`, and an `action.retried`
  activity row. Its runner, start time, summary, and outputs are cleared for
  the next try; its log and steps keep every try's story.
- At the next try's time the hub hands it on: a runner may claim it again,
  a starter starts a new job for it, with a new credential, and a webhook or
  a workflow is called again. A runner's job asked for alone
  still goes before any of a batch.
- A failure that is an answer, not a hiccup, says so with a log line that is
  exactly `::final::` (Steps and outputs), and is never tried again. So is a
  webhook's other refusals (4xx), a workflow someone cancelled, a run the hub
  timed out (it may still be going), a run whose outcome is `unknown`, and
  one it cannot render.
- The run is one run throughout: one approval, one `action.finished` row when
  its last try ends, and `attempt` on the run says which try it is on. A run
  withdrawn or a batch stopped while it waits is cancelled, and is not tried
  again.
- Only a runner, a job, a webhook, or a workflow backend retries. A `record` backend
  writes in the hub at once, and a `caller` backend is started by whoever
  asked.

Try again only what is safe to do twice. A failed try may have done part of
its work before it failed.

### Later, once or on a schedule

Every action may be run later, once: a run put off to a moment the person
picks, at most a year ahead. `schedule` lets people also run the action on a
cadence, as themselves. `min` is the shortest gap between two firings a
schedule of it may ask for, an hour at the least.

```yaml
schedule: { min: 1d }
```

- A person sets one up with **Run later…** wherever they may run the action:
  its form, an entity's page, the grid's batch drawer for the rows picked, the
  query page, and the tray of things ticked on a map. They pick **Once**, at a
  moment (in an hour, tonight, tomorrow morning, Monday, or any date and
  time), or **On repeat**: every hour at a minute, every 2, 3, 4, 6, 8, or 12
  hours from a time, every day at a time, or on some days of the week at a
  time, in a time zone. They name it, and who else hears of each result. The
  form offers no cadence tighter than `min`, and **On repeat** only where the
  action has `schedule`. The form is checked as for a run before it opens.
- What it runs on is what the form ran on: one entity, the very entities
  picked (the same ones each time), every row the grid's filter matches when
  it fires (but the rows left out), or every row a saved query matches when
  it fires. All but one entity, or none, fire as a batch, and need an action
  that runs on many.
- A run put off asks nobody's approval: it fires at its moment as if its
  owner ran it then, and each run is approved as any other would be. Once it
  fired it is done, and **Run again now** fires it again.
- One on repeat runs nothing until someone who decides approvals (an admin, or a holder of
  `actions.approve`) approves it, on the Schedules page or in **Needs my
  approval**. The schedule says the load it adds first: the runs each firing
  asks, the runner time they take, how long one firing lasts at the runner's
  width, and when in the day it lands. Changing what it runs, on what, or
  when asks for approval again; changing its name, or who hears of what,
  keeps it as it stands. Whoever decides is told when one waits, and the
  owner when it is decided or stops.
- Each firing is an ordinary run or batch, judged as the owner's at that
  moment: retries, the time a batch takes, its page, and the activity log all
  apply, and each run and batch names its schedule. A schedule whose owner no
  longer signs in or may no longer run the action, whose action no longer
  allows schedules, or whose saved query is gone, pauses itself and says why.
  A firing the hub missed while it was down runs once, not once for each.
- Its owner, or someone who decides, pauses, resumes, changes, removes, or
  runs it now.
- **Tell me** (`tell`) says which results the owner, and everyone the
  schedule names, hear of: `failed` (the default) when its run failed or
  every run of its batch did, `anyFailed` when its run or any run of its
  batch failed, and `every` for every result. A run whose outcome is
  `unknown` is told as a failure is, since someone must look at it. A firing that could not ask
  anything (`schedule.failed`) and a schedule that stops are told whatever it
  says. A result nobody is told of still goes to the desk, for the channels
  whose subscriptions take it.
- The Schedules page is where an owner runs them. It says how theirs stand,
  then puts each schedule on one clock, grouped by state: every firing over
  the last day, week, or 30 days is a mark, its height the runner time it
  took and its colour how it went, and what is still to come is drawn past
  now. Under the lanes are the runner minutes those firings took, hour by
  hour. Beside them are an average day, as a dial of the runner minutes the
  running schedules ask each hour (what the waiting ones would add is dashed),
  and the window's tally: firings, runs, how they went, runner time, and
  single runs against batches. Someone who decides sees everyone's too.
- A schedule opens at its own address, `/actions/schedules/{id}`: its facts
  over 7, 30, or 90 days, a strip of every firing, and every firing as a row
  that opens to its runs. A run shows its steps and how it ended. A batch
  shows its runs counted by state, and the ones that did not succeed, by name.
- `GET /v1/schedules`, `POST /v1/schedules`, `PUT /v1/schedules/{id}`,
  `POST /v1/schedules/{id}/approve|decline|pause|resume|run`,
  `GET /v1/schedules/awaiting`, and `GET /v1/schedules/history?days=7`
  (add `&schedule={id}` for one). History gives each firing: its run or
  batch, its runs by how they ended, and the runner time they took. A firing
  that asked nothing gives its reason. The activity log holds `schedule.requested`,
  `schedule.approved`, `schedule.declined`, `schedule.changed`,
  `schedule.paused`, `schedule.removed`, and each `schedule.fired`.

### Every schedule in the catalog

The hub keeps every schedule that is still a job as an entity of its own
blueprint `orrery_schedule` (Schedule, in the Orrery section, beside Source
and Runner): one that waits for approval, fires, or is paused. One removed,
declined, or done drops out. The record says what action it runs, whose it
is, what it runs on, when, its next and last firing, how the last firing's
runs went, the runs and runner minutes it asks a day, who approved it and
when, why it is paused, and a link to its page. Its status is green while it
fires and its last firing went well, red when that firing failed, amber
when the hub paused it because it can no longer fire, and grey while it
waits or a person paused it. A change shows at once on the hub that took
it, and every change, a firing on another hub too, within half a minute.

Each record links to what its schedule runs on, through one relation for
each kind of thing an action runs on, named `on_<blueprint>`
(`on_k8s_node`, say). A schedule on one entity, or on the entities picked,
links to those. One on a filter or a saved query links to what it matched
when it was last saved or fired. So the page of each thing lists, under
**Schedules**, every schedule that runs on it. The relations follow the
actions: an action that runs on a new kind adds one within half a minute,
and a blueprint that is removed takes its relation with it.

Like the hub's other blueprints, only an admin sees it until an admin opens
it under Access. There an admin may also tick **Also show each one to anyone
who can see what it links to**: then a person sees each schedule that runs
on something they can see, and no other. The hub names every `on_`
relation in that rule itself, so a new one is covered the moment it appears.
They read the schedule and never change it. The grid, the query page, and
export read it as any other.
An action with the `schedule` backend pauses, resumes, or fires now the
schedule a record stands for, so a grid's batch drawer changes many at once:

```yaml
id: pause_schedule
blueprint: orrery_schedule
listed: false                                  # run from the record or the grid, never from the Self-service page
batch: { max: 100 }
backend: { type: schedule, verb: pause }       # or resume, or run
```

It changes the schedule as the person who ran it, judged as their own change
on the Schedules page would be: its owner, or someone who decides approvals.
Anyone else gets a failed run that says why, and the schedule is left as it
was.

### What self-service is used for

**Insights**, from the Self-service page for whoever holds `audit.view`,
reads it all from the runs the hub keeps, over the last 7, 30, or 90 days:
every action with its runs, the people who ran it, how many failed, were
tried again, ran in batches or on schedules, how long they took, and when it
last ran, so an action nobody uses shows; who runs the most; each action's
batches, how many, how big, how long; and each runner on an average day,
hour by hour, with the runner time its runs took, how long they waited for
it, and what approved schedules add. `GET /v1/action-insights?days=30`.

The metrics `orrery.action.runs`, `orrery.action.run.duration`,
`orrery.runner.queued`, `orrery.runner.running`, and `orrery.runner.width`
(README, Metrics) carry the same to a dashboard, to size and scale what
runs the runners.

### Approvals as records

An estate that keeps one inbox of every approval its systems hold names the
blueprint it keeps them in under Access (`PUT /v1/access/approvals` with
`{ "blueprint": "it_approval" }`, an admin's). From then on the hub writes
its own approvals there, as the source `hub`: each run that waits for
someone to decide it, and each schedule that waits for approval, under the
key `orrery/run/<id>` or `orrery/schedule/<id>`, and keeps the record as the
run or schedule stands, from the activity log, within half a minute. The
rounds of one ask (each run that `revises` another) are one record, under
the key of its first round, as its newest round stands: one pending item an
ask, however many rounds it takes, titled `(round <n>)` from the second
round on. Deciding the record decides its newest round.

A record carries only what its blueprint declares of `source` (`orrery`),
`kind` (`action run` or `schedule`), `decision` (`pending`, `approved`,
`declined`, or `expired`; the blueprint must have this one), `reason`,
`requested_by`, `requested_at`, `decided_by`, `decided_at`, `decision_note`,
`round` (which round of its ask it shows, from 1), and `url` (the newest
round's page), and of the relations `requester` and `approvers` to the person
blueprint. `approvers` names everyone who may decide the run or schedule
while it waits, as its Approve button judges them: the people a rule names,
whoever holds `actions.approve`, and admins; for a run held for its asker's
own approval, the asker alone. Who that is is judged again for every
pending record when it may have moved: an action's definition, a role, a
person enrolled, changed, or removed, the access policy, and the approvals
setting. `decision_note` is what its decider wrote.
`reason` says each input the run was asked with, in full, so a plan a
product asked about is read in the record as well as on the run's page. A
record that should link to another record the asking product writes, such
as a change request, links by a relation rule on the run's address: the
product keeps the run's page in a field of its own record, and the rule
matches `target.<field> == source.url`. A person is linked only when
their record exists, so a run a machine asked for names no requester. The
entity a run or schedule acts on is linked too, through the one other
relation of the blueprint whose target is that entity's blueprint: declare
`service: { target: sw_service }` and an approval of a run on a service
links it, so the approval's team and program can be inherited through it.
None, or more than one, links nothing. An ownership path such as `{ as:
approver, path: <-it_approval:approvers }` and an `owners` rule on the
blueprint open each record to the people it names, and no other.

The rail shows, beside the approvals blueprint, how many of its pending
records name the reader among their `approvers`, of every system that writes
there, and beside Self-service how many runs and schedules wait for them.
`GET /v1/mine/approvals` answers the first: `{ blueprint, waiting }`.

An action with the `decide` backend decides the run or schedule a record
stands for:

```yaml
id: approve_in_inbox
blueprint: it_approval
where: { field: source, op: eq, value: orrery }
listed: false                                   # run from the record, never from the Self-service page
backend: { type: decide, verdict: approve }    # or decline, with note: "{{ inputs.why }}"
```

It decides as the person who ran it, judged as their own decision on the run
or schedule would be: someone who may not decide it gets a failed run that
says why, and the run or schedule is left as it was. A record of another
system's is decided by an action of that system's, which is a row action
too: `listed: false`.

### Keeping runs

A run's pictures are kept apart from it, so a list of runs or a batch's grid
never reads them; the run names them, and each is read alone at `GET
/v1/action-runs/{run}/outputs/{name}`. The hub lets go of pictures older than
`RUN_IMAGE_DAYS` (30 by default) and of runs that ended longer ago than
`RUN_KEEP_DAYS` (365), with any batch none of whose runs are left, once an
hour, a few thousand rows at a time.

Runs are also a source on the **Query** page, **Action runs**: filtered on
their own columns (action, who asked, what they ran on, state, when asked,
started, and finished, seconds, tries, batch, schedule, who decided, summary)
and exported like any query. Each reader reads the runs the runs list shows
them: their own, those they decide or decided, those of actions they may run,
and every run for whoever manages actions.

## Telling people about runs

With `DISPATCH_URL` and `DISPATCH_TOKEN` set, the hub tells a dispatch desk
about every run, as one event each: `action.requested` when a run is asked
for and goes ahead, `action.awaiting_approval` when it waits,
`action.approved`, `action.declined`, `action.returned`,
`action.cancelled`, and `action.succeeded` or `action.failed` when it
ends. A batch is told as one: `action.batched` when it is asked, and
`action.batch_succeeded` or `action.batch_failed` (some of its runs failed)
when its last run ends. A schedule adds `schedule.awaiting_approval`,
`schedule.approved`, `schedule.declined`, `schedule.failed` (a firing that
asked nothing), and `schedule.paused`. A report's publish adds
`report.published`, a `notify` for its recipients, with what the edition says
in a line, its headline numbers, and links to read and forward it (Reports,
above). A tool's run (Tools, below) is told to nobody.

The hub also declares those kinds to the desk (`PUT /v1/kinds`), each with
a title, a sentence, and its weight, so each person can choose on the desk
how they hear of each kind. It declares them when it starts forwarding and
asks again on the next pass when the desk did not take them. Every event is
sent with its kind's weight: what worked, and what only says something was
asked, is a `notice`, which lands in a person's list on the desk and sends
nothing unless they choose a way for it; what failed or waits for someone is
a `notify`, which reaches them.

Who hears of what is decided in two places, each owning one question:

- The hub decides which events are for whom: the rules below, and a
  schedule's **Tell me**, which says which of its results are worth its
  people's attention.
- Each person decides on the desk how they hear of each kind, or not at all
  but in their list. The profile menu links there (`DISPATCH_PUBLIC_URL`).

The hub names the people an event is for, and the desk reaches each the way
they chose:

- A run that waits is for the people a rule lets decide it. An admin's
  override and `actions.approve` name nobody, since they would name the
  same people for every run. When no rule names anyone, or more than twenty
  people are named, it is for the desk group in `DISPATCH_APPROVERS_GROUP`;
  with no group set it is for nobody by name.
- Approved, declined, sent back, cancelled, and ended are for whoever
  asked, unless they did it themselves.
- A scheduled run's or batch's end is for the schedule's owner and the
  people it names, only when its **Tell me** asks for that result. A
  firing that asked nothing is for them always.
- A run that goes ahead without approval is for nobody by name.

Besides those people, dispatch's subscriptions send each event to the
channels that want it, such as a program's Teams channel for anything about
that program's services.

A run that has waited for `DISPATCH_REMIND_HOURS` (default 24; 0 turns it
off) is told to its deciders once more, as `action.awaiting_approval` under
the key `remind:<run id>`, and never again.

`DISPATCH_PUBLIC_URL` is the desk's address for people. With it set, the
profile menu links each person to the page where they choose how they are
told.

Each event carries:

- a title a person reads at a glance, such as "Restart a service on
  shop-api-prod waits for approval";
- the entity the run is on, so a subscription anchored on a program takes
  the runs on its app services;
- facts: the action, the entity under its blueprint's title, who asked,
  each input (an entity input by its title), and who decided;
- labels a subscription can match: `action`, `blueprint`, `state`,
  `schedule` (the schedule's id, on what a schedule ran), and each input
  whose value is a plain value, such as `tier=Prod`. A subscription that
  matches `schedule` to an empty value takes only what people ran by hand;
- a link to the run, where whoever may approve it approves it. Anyone else
  who follows it sees the run, or nothing, as the run's own access says.
- on a run that waits, `actions`: the hub's own approve and decline calls.
  A channel that can act, such as the desk's Teams bot, shows them as
  buttons. Whoever clicks one signs in as themselves and calls the hub with
  their own token (`AUTH_API_SCOPE` in the README), so the hub decides
  exactly as on the run's page: someone who may not decide it is refused.

A run that states a change (A change statement, above) is asked with the
statement in words: the event's text says each effect and each part nobody
could name, and its facts say the change's key and where it runs. The change
itself reaches the desk as its change events (A change statement, above),
never as a notice.

A pass reads the activity log the way the Annals forwarder does, keyed
`change:<id>`, so a desk that is down loses nothing and a row sent twice is
one event.

## Who may run an action on what

`grants` and `audiences` let a person run an action on everything it runs
on. `rules` say who may run it on which entity. A rule holds up to three
parts, and every part it gives must hold:

- **Who they are**: `audiences` and `grants`, as above: any one of them is
  enough. `require` narrows that with grants that must all hold, such as a
  program's team and one of the teams that do the work:
  `grants: [{ path: teams, values: [frontend, backend, qa] }]`,
  `require: [{ path: teams, values: [shop] }]`. A rule with none of them
  lets in anyone signed in, so the other parts decide.
- **What they are to the entity**: `owns`. `true` takes what is theirs in any
  way; a list of roles takes what they are those to. The roles are the `as`
  of the person setting's ownership paths (README, What is yours), so the
  catalog's own ownership decides it: a developer of the program that owns
  an app service, the QA owner of a program, an owner by name.
- **What the entity is**: `where`, the search filter, such as an environment.

A rule may also name people it never lets in, by sign-in address:
`except: [dana@example.org]`. That is a team but for one of its members.
Another rule may still let that person in.

`owns: [self]` lets a person in on their own person entity: the one the
person setting finds for whoever signs in. It counts only where a rule names
it: `owns: true` takes what is theirs by an ownership path, never their own
person entity. An admin is still let in on every entity; an action that must
run on the caller alone, an admin included, says `self: true` (An action on
yourself, below).

```yaml
access:
  rules:
    - { owns: [self] }             # each person on their own person entity
```

`@me` and the day names (`@today`, `@yesterday`, `@tomorrow`, `@now`) are
read for whoever asks in an action's own `where` and in each rule's, as in
any filter: `@me` as a field's value is their sign-in address, and as a
relation's target or `relatedTo` their own person entity. A filter that
names their own entity takes nothing for someone the catalog holds no person
for.

```yaml
- id: reset_my_laptop
  title: Reset my laptop
  blueprint: laptop
  where: { relation: holder, target: "@me" }   # the laptops whose holder is you, for an admin too
  access: { everyone: true }
```

A rule with `approval: true` holds the runs it lets in for approval, until
someone a rule lets in there without approval, or a holder of
`actions.approve`, approves it. `approval: self` holds them until the person
who asked approves their own, and nobody else decides them. Where more than one rule lets a person in on
an entity, the one without approval wins, then `self`, then `true`. An entity the action's own `where` leaves out is never offered,
whatever the rules say.

```yaml
- id: restart_shop_service
  title: Restart a shop service
  blueprint: [app_service, function_app, virtual_machine]
  where: { relation: program, target: program:shop }
  inputs:
    environment: { type: entity, blueprint: environment, narrows: environment, required: true }
  backend: { type: runner, runner: platform-runner, command: [restart, "{{ entity.blueprint }}", "{{ entity.fields.azure_id }}"] }
  access:
    rules:
      # Developers restart what their program owns, anywhere. A restart touches only their app.
      - { audiences: [digital_development], owns: [developer] }
      # QA restarts the program's app services in test.
      - { audiences: [digital_quality], owns: [qa], where: { relation: environment, target: environment:test } }
      # The program's project manager restarts production once one of its developers approves.
      - { owns: [program], where: { relation: environment, target: environment:production }, approval: true }
```

The hub works out, for each person and action, the entities its rules let
them run it on, and keeps that answer until something in the hub changes.
Every surface reads that one answer:

- The form's pick of what it runs on offers only those, narrowed by the
  inputs asked before it, and says which wait for approval. The hub
  searches them as the person types and sends the first page, so a pick
  over thousands of entities reads and sends only that page.
- `GET /v1/actions/{id}/targets?narrow={"environment":"environment:test"}`
  answers the same list: `{entities, approval}`. Add `q=<text>` to keep the
  targets that hold the text, `of=<blueprint:key>` to ask after one, or
  `limit=<n>` (at most 50), and it answers one page in title order with
  `total`, the count of every match.
- Each row of a grid block, and each entity page, carries `actions`: the
  ids the reader may run there. The entity page and the side panel show
  those as buttons, and an action is a column of buttons in its blueprints'
  grids, hidden until someone with `views.arrange` shows it.
- A run on anything else is refused the way a run on an entity that does not
  exist is, and recorded as `access.refused`, so a refusal tells nobody what
  exists.
- `list_actions` with `entity` lists the actions an agent may run on it.

**What the rules read is guarded.** A rule is only as good as the values it
reads. Every field and relation an action's `where` or a rule's `where` reads
on what it runs on, every relation the ownership paths a rule or an action's
`access.home` asks for follow, and what fills each of those (the paths and conditions a relation
inherits by, the field a relation rule matches on, the path of a mirror or
an aggregation, the fields a calculation names), and every field a `job`
backend's `template` reads on what it runs on (One action for many
identities, below), take changes by hand only
from an admin or a holder of `access.values`. A source writes them only on
an entity it owns, and git always may. Otherwise a person could move a
production service into test, or put their team on a program, and widen
their own reach. A guarded value says why on hover and opens no editor. The
Security page lists every value set by hand on one of them, to keep or clear.

**The backend acts as a machine.** A run hands the backend the entity it is
on; the backend acts with its own identity, never the person's. Give that
identity only what the actions need, such as restart and nothing else, on
the scope the actions cover, and lock in the pusher the field that names the
resource (`overridable: false`), so nobody points a row at another resource.
A `runner` backend takes its jobs from the hub over the machine port, so
nobody can start one any other way.

### An action on yourself

`self: true` runs the action on the caller's own person alone: the entity
the person setting finds for whoever signs in. It binds everyone, an admin
too, the way the action's `where` does, so the action shows on the caller's
own person page and on nobody else's, and a run asked for on another person
is refused as a run on nothing is. Someone the catalog holds no person for
runs it on nothing. Who may run it there is still its `access`:
`access: { everyone: true }` lets every person act on themselves. The action
runs on the blueprint the estate says a person is; one that names another, or
asks for a `batch`, is refused when it is saved.

```yaml
- id: allow_my_network
  title: Allow my network
  blueprint: person
  self: true
  access: { everyone: true }
  inputs:
    address: { type: string, required: true, default: "{{ by.address }}" }
  backend: { type: webhook, url: https://ops.example.org/hooks/allow }
```

### Delegating an action per entity

A grant says who may run an action; its `where` says which entities it runs
on. Together they delegate one action to one team for some entities only:
the entities name the teams in a field, and each delegated team has its own
action that runs where the field names it.

```yaml
- id: assign_application_service_desk
  title: Give someone an application (service desk)
  blueprint: it_application
  where: { field: assign_teams, op: contains, value: service-desk }
  access: { grants: [{ path: teams, values: [service-desk] }] }
  # inputs and backend as in Granting access in Entra, below
```

The hub applies `where` again when a run starts, so a run asked for on an
entity the filter does not take is refused, whatever the caller sent; an
entity input's `where` is applied again the same way. Access is decided from
every such field, so it is guarded without a mark: a person changes one only
as an admin or with `access.values`, and a source only on an entity it owns,
in either write mode. Every field or relation a grant's path reads, and every
field an admin marked, is guarded the same way, and a `record` backend never
writes one on any entity. Only the source that owns the entity, a git source,
or an admin does.

## Tools

A tool is a command an agent calls and reads the answer of: show how an app
is set up, read the last errors, restart a worker. It is an action with a
`tool` block. It has no form, no approval, and no access rule of its own;
who may call it is decided by its **tier**, and its command runs on a runner
with that runner's key. So a product lends an agent a tool, never a key.

A read tool with a `dataset` block is a **dataset**: one table a saved query
reads beside the catalog (docs/modelling.md, Datasets). It is the one tool
with `access` of its own, which says who may read it in a query. It is
called with no inputs, so each input takes a default or is not required.

```yaml
- id: shop_app_show
  title: Show an app
  description: How one app of the shop is set up and whether it runs.
  blueprint: repository
  inputs:
    app: { type: string, required: true }
  backend: { type: runner, runner: shop-test-reader, command: [az, webapp, show, --name, "{{ inputs.app }}"], timeout: 30s }
  tool: { tier: read, from: "repository:shop-api" }
```

**Tiers.** `read` looks at how a thing is set up and how it runs. `data`
reads what it holds. `act` changes it. A tool has one tier.

**Who holds a tier.** An action's `access.tiers` are the tiers that come
with it: whoever may ask for that action on an entity holds those tiers
there. An admin holds every tier, and a machine access token with
`tools.read` holds `read` everywhere.

```yaml
access:
  rules: [{ owns: [developer] }]
  tiers: [read]        # a developer of the repository reads what its tools show
```

A run may ask for more than its action carries, with `tiers` on the request.
Such a run always waits, whatever its rule says, and only someone who holds
every tier it asks for on that entity approves it: nobody grants what they do
not hold. Approved, the run holds those tiers until it ends.

**Which runner runs it.** A runner lends its key only as its own rule says.
An admin sets that rule on the runner's source, as `serves`:

```yaml
serves:
  tiers: [read]                    # the tiers a tool on this runner may have
  sources: [desk-tools]            # sources that may put a tool on it with their own token; none: only an admin and git
  on:                              # where a tool on it may be declared from
    blueprint: repository
    where: { relation: program, target: "program:shop" }
```

A runner with no `serves` runs no tool. A tool names the entity it was
declared from in `tool.from`, such as the repository whose file holds it,
and the runner takes it only when that entity is one its `on` takes. So one
runner holds one key for one program at one tier, and no other program's
repository can put a command on it. The hub checks the rule when the tool is
saved, when it is listed, and again on every call. A runner with no `on`
serves tools of no entity, which only an admin or a `tools.read` token
calls.

Only an admin's save, a git file, or a source the runner names defines or
changes a tool. A holder of `actions.manage` does not: a tool's command is
whatever its definition says, run with the runner's key.

**Calling one.**

```
GET  /v1/tools?entity=repository:shop-api
POST /v1/tools/shop_app_show/call
{ "entity": { "blueprint": "repository", "key": "shop-api" }, "inputs": { "app": "shop-api-test" } }
```

The list answers the tools the caller holds the tier for on that entity,
each with its `tier` and `inputs`. The call queues the job, waits for the
runner, and answers on the same call:

```json
{ "run": "…", "state": "succeeded", "summary": "exit 0", "text": "…what the command printed…", "truncated": false, "outputs": {} }
```

- A call waits as long as the tool's `timeout`. A tool no runner took in
  that time is cancelled, so nothing runs after its caller stopped waiting.
- `text` is at most 64 KB, its head kept, with `truncated: true` beyond
  that. A run holds at most 256 KB of what a tool printed.
- Every call is a run, with an `action.requested` and an `action.finished`
  activity row that carry `tool: <tier>`, so Annals holds each look and
  each change. Tool runs stay out of the run lists people read; `GET
  /v1/action-runs?tools=true` includes them.
- A caller who lacks the tier is refused with 403, and the refusal is
  recorded.

**Lending a tool to a person's request.** A product whose agent works a
person's request calls the tool in that person's name, with `as`, on the
machine port, with a machine access token whose role holds `tools.lend`:

```json
{ "entity": { "blueprint": "repository", "key": "shop-api" }, "inputs": { "app": "shop-api-test" },
  "as": { "person": "ada@example.org", "action": "change_developer", "entity": { "blueprint": "repository", "key": "shop-api" }, "run": "…" } }
```

- The tiers are worked out on every call, from what the hub holds now: the
  tiers of the action the person asked in, if they may still ask for it on
  that entity, plus the tiers `run` was granted, while that run is theirs,
  of that action, on that entity, and still `queued` or `running`. There is
  no token to steal and nothing to expire: when the run ends, or the person
  leaves the team, the next call is refused.
- A tier the person holds through some other action is not lent. The
  request stays in its lane.
- The call reaches only the entity the request is on.
- With the `act` tier, the product may also ask for a plain action through
  the same door, and the hub judges that as the person's own request.
- The run names the person, and `detail.via` names the product.
- `GET /v1/tools?entity=…&for=<person>&action=<action>[&run=<id>]` lists
  what such a call may reach.

## Links that open a form filled in

`/actions/{id}?entity=<blueprint>:<key>&input.<name>=<value>` opens the
action's form on that entity with those inputs filled in. A many input takes
`input.<name>` more than once; a number or a boolean is typed as the input
is. An entity, the action's or an input's, may be named by its bare key when
the key holds no colon, and so may a person: `?entity=it_application:jira` and `?entity=jira` open
the same form. Nothing runs until the person presses Run, and the hub checks
every value as it would a typed one. A portal links to a request this way:
`/actions/request_app_access?entity=it_application:jira`.

## Requests and approvals

The requests below are about applications. An application (`it_application`,
see the modelling guide) is what people use: installed, SaaS, or hosted
here. It names the Entra apps people sign in through (`sign_in`), how a
person gets it (`access`: `open`, `direct`, `group`, or `package`), the role
a direct grant gives (`access_role`), the groups a group grant adds people
to (`access_groups`), and, marked only an admin changes, the teams that may
grant it (`assign_teams`).

`it_approval` is a record of a request someone has to decide. The Entra
pusher writes the ones Entra holds (admin consent, access packages) with
`system: entra` and the page to decide on; they leave once decided there. A
request made here is an action with a `record` backend, one per access mode,
so the request's kind follows the application. It is decided by actions on
the approval itself, so the approval's page shows its buttons and the list
of pending approvals is the one place to look.

```yaml
- id: request_app_access
  title: Ask for an application
  blueprint: it_application
  where: { field: access, op: eq, value: direct }
  inputs:
    reason: { type: string, title: Why you need it, required: true }
  backend:
    type: record
    source: access-requests
    blueprint: it_approval
    key: "orrery/{{ run.id }}"
    title: "{{ entity.title }} for {{ by.name }}"
    fields:
      decision: pending
      kind: app_access
      system: orrery
      reason: "{{ inputs.reason }}"
      requested_by: "{{ by.name }}"
      requested_at: "{{ run.at }}"
    relations: { application: "{{ entity.key }}" }
  access: { everyone: true }

- id: request_group_access
  title: Ask for an application
  blueprint: it_application
  where: { field: access, op: eq, value: group }
  inputs:
    reason: { type: string, title: Why you need it, required: true }
  backend:
    type: record
    source: access-requests
    blueprint: it_approval
    key: "orrery/{{ run.id }}"
    title: "{{ entity.title }} for {{ by.name }}"
    fields:
      decision: pending
      kind: group_access
      system: orrery
      reason: "{{ inputs.reason }}"
      requested_by: "{{ by.name }}"
      requested_at: "{{ run.at }}"
    relations: { application: "{{ entity.key }}" }
  access: { everyone: true }

- id: decline_access
  title: Decline
  blueprint: it_approval
  where: { field: decision, op: eq, value: pending }
  inputs:
    note: { type: string, title: Why, required: true }
  backend:
    type: record
    source: access-requests
    blueprint: it_approval
    key: "{{ entity.key }}"
    mode: enrich
    fields: { decision: declined, decided_by: "{{ by.name }}", decided_at: "{{ run.at }}", decision_note: "{{ inputs.note }}" }
  access: { grants: [{ path: teams, values: [service-desk, platform] }] }
```

`it_approval` needs the relation `application` to `it_application`; the
`access-requests` source is registered for `it_approval`. An approve action
for a team picks the approval's application only when the application names
that team in `assign_teams`, so a team sees every approval but can grant only
its own.

## Restarting Azure resources

`cmd/azure-restart` restarts one Azure resource for a runner job: a web app, a
function app, a slot, or a virtual machine, named by its resource id. It
refuses any other kind of resource. It signs in as its own workload identity,
never with a secret, to the tenant the resource's subscription belongs to,
which it asks Azure for. So one identity serves several tenants: register a
multi-tenant app, give it a federated credential for the runner's service
account, and consent to it in each other tenant.

Azure answers an app's restart as soon as it has issued it, in about a
second, and the old worker goes on answering for a while. So an app is
restarted only once every one of its instances runs a worker process that
started after the restart was asked: it reads the app's instances and their
processes until they do, leaving out the deployment site's own. A worker
starts on an app's first request, so with `--url` it asks the app each round
too. An app whose workers it may not read is said to be issued, never
restarted. A virtual machine's restart is followed until Azure says it is done.
Then, with `--url`, it asks the app until it answers: at its health check path
when `--health` names one, which only a 2xx passes, else at its address, where
any answer below 500 does. A 401 or a 403 says only that the runner may not
reach it, and the summary says so. The restart and the answer share `--wait`
(10m). It names its steps, `Sign in`, `Restart`, and for an app `Verify`,
which is where it watches for the new worker and the answer; a virtual
machine's restart has no `Verify`, because nothing is checked after Azure says
it is done. Every step is a line in the run's log, and the summary says what came of
it and how long it took: "Restarted shop-api-test: a new worker started 29s after
the restart was asked, and its health check answered 200. 31s in all." It exits
0 when the resource restarted and, when asked, answered; 1 when it failed or did
not come back; and 2 when it was asked wrongly. The
`orrery-azure-runner` image is the runner with it.

The identity needs one custom role, and nothing else:

```json
{
  "Name": "Orrery Restarter",
  "Description": "Restarts web apps, function apps, their slots, and virtual machines, for Orrery self-service actions. Reads only the instances and processes of an app, to see a restart happen.",
  "Actions": [
    "Microsoft.Web/sites/restart/action",
    "Microsoft.Web/sites/slots/restart/action",
    "Microsoft.Web/sites/instances/read",
    "Microsoft.Web/sites/instances/processes/read",
    "Microsoft.Web/sites/slots/instances/read",
    "Microsoft.Web/sites/slots/instances/processes/read",
    "Microsoft.Compute/virtualMachines/restart/action",
    "Microsoft.Compute/locations/operations/read"
  ],
  "AssignableScopes": ["/providers/Microsoft.Management/managementGroups/<root>"]
}
```

It reads no resource's settings and lists nothing but a restarted app's
workers. The hub decides who may restart
what (Who may run an action on what); the role bounds the worst a mistake
there can do to a restart. Lock the field that holds the resource id in the
hub, so nobody points a row at another resource:

```yaml
- id: restart_service
  title: Restart a service
  blueprint: [azure_app_service, azure_compute]
  # Every app, and of the compute only the virtual machines: an app has no type.
  where: { or: [{ field: type, op: eq, value: vm }, { not: { field: type, op: exists } }] }
  inputs:
    tier: { type: enum, title: Environment, values: [Prod, Preprod, Test, Dev, RnD], narrows: env_tier, required: true }
  # An app is asked at its address and health check path once it restarted; a machine has neither, so they render empty.
  backend: { type: runner, runner: azure-restart, command: [/azure-restart, --url, "{{ entity.fields.url }}", --health, "{{ entity.fields.health_check_path }}", "{{ entity.fields.resource_id }}"], timeout: 15m }
```

## Starting Azure Container Apps jobs

`cmd/azure-job-start` starts one Azure Container Apps job for a runner job,
named by its resource id, and follows the execution it started until it
ends. It is for running a job on a schedule now, such as a pusher, instead of
waiting for its next run. It refuses anything that is not a Container Apps
job. It signs in as its own workload identity, never with a secret, to the
tenant the job's subscription belongs to, the same way `azure-restart` does.

```
azure-job-start [--wait 20m] <job resource id>
```

Azure names the execution when it takes the start; when it does not, the
newest execution that started since is the one followed. It names its steps
`Sign in`, `Start`, and `Run`. Every change of its
status is a line in the run's log, and the summary says how it ended and how
long it ran by Azure's clock: "comet-sync ran for 2m14s and succeeded." It
exits 0 when the execution succeeded; 1 when it failed, stopped, was
degraded, did not end within `--wait`, or Azure refused the start; and 2 when
it was asked wrongly. Keep the action's `timeout` longer than `--wait`. The
`orrery-azure-runner` image carries it at `/azure-job-start`.

The identity needs one custom role, and nothing else:

```json
{
  "Name": "Orrery Job Starter",
  "Description": "Starts Azure Container Apps jobs and follows their executions, for Orrery self-service actions.",
  "Actions": [
    "Microsoft.App/jobs/start/action",
    "Microsoft.App/jobs/executions/read",
    "Microsoft.App/jobs/read"
  ],
  "AssignableScopes": ["/subscriptions/<subscription>/resourceGroups/<the jobs' resource group>"]
}
```

It cannot change a job, read its secrets, or stop one. The hub decides who
may start what; the role's scope bounds which jobs a mistake there can
start. Lock the field that holds the job's id in the hub, so nobody points a
row at another job:

```yaml
- id: run_job_now
  title: Run now
  description: Run this job now instead of waiting for its schedule. The run follows it to the end.
  blueprint: orrery_source
  where: { field: job_id, op: exists }
  backend: { type: runner, runner: orrery-azure-runner, command: [/azure-job-start, "{{ entity.fields.job_id }}"], timeout: 20m }
```

## One container for each run

The `job` backend runs each run as one container of its own, on a platform
the estate runs: a Kubernetes Job, or an execution of an Azure Container
Apps job. It is for work that runs long or waits for a person. The rule
under it: work that waits for a person is never held by the thing that
asked. With `caller`, a tool that asks for an approval must also come back
and do the work, so a run approved overnight finds nothing awake to start
it. With `job`, the run's container is started the moment the run is
approved, or asked for when it needs no approval, and whoever asked may
stop and read the run later.

Three parts, each with one job:

- **The hub** holds the run, the approval, and the log. It holds no cloud
  or cluster credential, and starts nothing itself.
- **A starter** the estate runs (`cmd/job-starter`, the image
  `orrery-job-starter`) signs in to the hub as a runner source and connects
  out, as a runner does. It claims the runs that name it, starts one job
  for each from a template the estate owns, says while a job runs that it
  does, and reports how the container ended. It holds one right on its
  platform: start a job, see it, and stop it.
- **The job** is the container. It runs as its own identity, which the
  estate's template gives it (a service account with a workload identity,
  or a job's own managed identity). No shared runner holds that power, and
  neither does the starter.

### The definition

```yaml
backend:
  type: job
  starter: job-starter             # a source of class runner: the starter that starts the job
  template: infra-apply            # one of the starter's own templates, by name: lowercase letters, digits, - and _;
                                   # or a name the run's entity gives: One action for many identities, below
  image: "registry.example.org/infra/runner:{{ entity.fields.runner_version }}"   # rendered; required
  command: [infra, apply]          # argv, rendered; left out, the template's own command runs (optional)
  args: ["--workspace", "{{ entity.key }}"]                                       # rendered (optional)
  env: { WORKSPACE: "{{ entity.key }}", ASKED_BY: "{{ by.name }}" }               # rendered, over the template's own (optional)
ceiling: 12h                       # on the action: the longest a run may take; 7d when left out
```

`image`, `command`, `args`, and `env` are rendered over the run's scope, as
a runner's `command` and `env` are: a list as a whole argument is one
argument per item, and inside other text it is JSON (the `runner` backend,
above). An environment name is letters, digits, and `_`, and never starts
with `ORRERY_`: those are what the hub and the starter hand the job. An
image that renders to nothing fails the run before anything is started.

`template` is a name and nothing more. Where the job runs, as what, with
which resources and secrets, and which images it may run are the estate's
to say, in the starter's own config. The action asks; the starter's config
decides. So a value a caller types can never point a job at another
namespace or identity, and an image the template does not allow is refused
by the starter, with the run failed and the reason in its log. Take the
image, or its tag, from a field the estate locks, not from a free input,
where you can.

### One action for many identities

A template carries the identity its jobs run as. An estate with one
identity for each project, or each zone, has one template for each. One
action serves them all when the entity the run is on says which:

```yaml
blueprint: workspace
backend:
  type: job
  starter: job-starter
  template: "infra-apply-{{ entity.fields.infra_principal }}"   # the workspace's own field names the template
  image: registry.example.org/infra/runner:1.4.0
```

```yaml
# the blueprint
workspace:
  fields:
    infra_principal: { type: string, overridable: false }       # locked: only sources write it
```

A run on a workspace whose `infra_principal` is `network-prod` starts from
the starter's template `infra-apply-network-prod`. The starter is as it
was: it knows its templates by name, and each one still bounds its own
namespace, identity, and images.

The rule this keeps: **nobody who may run the action chooses what its job
runs as.** The estate's model decides, through the entity the run is on and
a field no caller writes. The hub holds that in four ways.

**The template reads the entity's own fields and nothing else.** Every
`{{ }}` in it is `entity.fields.<name>`. The save is refused for `inputs`,
which whoever asks chooses, for `by`, which is whoever asks, and for
anything else: the entity's key, title, or relations, the run, another
field's inside. An action on no blueprint has no entity to read, and is
refused too.

**Each field it reads is locked.** On every blueprint the action runs on,
the field is a `string` or an `enum` holding one value, a source stores it
(never a calculation, a mirror, an aggregation, or a trend), and it says
`overridable: false`. That is the lock the README describes (Locked
fields): only sources write it, and nobody sets or changes it by hand, an
admin included. The save is refused otherwise, saying which field and why. For
an `enum`, every value it allows must be fit for a name.

**The hub holds the field as a value access is decided from**, from the
moment the action is saved (What the rules read is guarded, above). Locked
says no person writes it. This says which machine may:

| Who | May they write the field? |
|---|---|
| The source that owns the entity | Yes. It is the estate's word on what the entity is |
| A catalog file in git | Yes |
| Another source, registered for the blueprint or not | No: the write is refused, as `access is decided from "infra_principal"` |
| A person by hand, an admin or a holder of `access.values` included | No: it is locked |
| An edit rule | No: it never opens the field |
| A `record` backend, on any entity | No: the save is refused, and the write is checked again when a run starts |
| A run's `refreshes` | No: the save is refused, the action's own included |
| A change set | No: it is runs of actions, each judged as above |

An action that already writes the field makes the job action's own save
fail, naming it: remove that write first.

**The name is worked out by the hub, from its own read of the entity.** Not
from what whoever asked may see: a field they cannot read still names the
template, and a refusal never says the value. It is read twice. When the
run is asked for, alone or in a batch, an entity whose field holds nothing,
or anything but lowercase letters, digits, `-` and `_`, is refused with
409, and a batch names it among the entities it will not run on. And again
as the starter claims the run, which is what the starter is handed: a run
approved after its source moved the entity starts as the model says then.
A run whose entity no longer names a template then fails before any job is
started, with why in its log. So does one whose field the model unlocked
after the action was saved: the lock is checked on every run, not only on
the save.

What is left to the estate: keep the sources that may create an entity of
the blueprint to the ones it trusts to say what that entity runs as, since
a source owns what it creates. And give the starter a template only for an
identity it should be able to start. A name no template has fails the run,
with the starter's reason.

A job action takes `approval`, `quorum`, access rules, `serial`,
`concurrency`, `retry`, `batch`, `schedule`, and `refreshes` as a runner's
does. It is never a tool: a tool answers in the call.

### Declaring one from a tool

A tool whose work should run this way declares the action from its own
source, as any product declares its actions (The definition, above): `PUT
/v1/actions/{id}` on the machine port with its source token, once an admin
gave its source the `actions` grant. The body is the definition, with the
`job` backend:

```bash
curl -X PUT "$ORRERY_URL/v1/actions/infra_apply" -H "authorization: Bearer $ORRERY_TOKEN" -H 'content-type: application/json' -d '{
  "title": "Apply infrastructure",
  "description": "Apply a planned change to one workspace. It waits for approval, then runs as a job of its own.",
  "blueprint": "workspace",
  "inputs": { "plan": { "type": "attachment", "title": "Plan", "required": true }, "reason": { "type": "string", "title": "Why", "required": true } },
  "approval": true,
  "serial": [],
  "ceiling": "12h",
  "backend": { "type": "job", "starter": "job-starter", "template": "infra-apply", "image": "registry.example.org/infra/runner:1.4.0", "command": ["infra", "apply"], "args": ["--workspace", "{{ entity.key }}"], "env": { "WORKSPACE": "{{ entity.key }}" } }
}'
```

The save is refused with 400 when `starter` is not a runner source, or
when its `template` reads anything but locked fields of the entity (One
action for many identities, above). The
tool then asks for a run (`POST /v1/actions/infra_apply/run`, as the person
running it, or `orrery run infra_apply --no-wait`), prints the run's id and
link, and exits. It does not wait for the approval, and it does not come
back to do the work. Only an admin sets the action's `access` and `home`.

### What the job is handed

The container starts with the template's own environment, the action's
`env` over it, and these:

| Name | What it is |
|---|---|
| `ORRERY_URL` | The hub's machine address, as the job reaches it |
| `ORRERY_RUN` | The run's id |
| `ORRERY_ACTION` | The action's id |
| `ORRERY_TOKEN` | A credential made for this run alone |

The run's inputs reach the job two ways. The action renders the ones the
job needs into `env`, `command`, and `args`. And the job reads its whole
run, every input included, with its credential: `GET
/v1/action-runs/$ORRERY_RUN` answers the run, with `inputs` as the hub
checked them. Read a long input, such as an `attachment`, that way: an
environment cannot carry one.

The credential (`orr_run_...`) is a handle on one run, never a hub token. It
opens two calls on the machine port, for its own run and no other: the
report and the read. Every other call with it, a list, an entity, another
run, an agent's tool, answers 401. The hub makes it as the starter claims
the run, hands it over once, and keeps only its hash. It ends when the run
does, or when the run is put back to be tried again. On Kubernetes it is in
a Secret the Job owns, never in the pod's spec. On Azure Container Apps an
execution can be handed nothing but environment values, so it is one, and
whoever may read the job's executions may read it: keep that to the people
who may see the run.

### How the job reports

The job says what it does on its own run, through the same call every
backend reports with (Reporting back, below):

```bash
orrery report "$ORRERY_RUN" --step Plan --log "3 to add, 1 to change"
orrery report "$ORRERY_RUN" --step Apply --log "applied module network"
orrery report "$ORRERY_RUN" --summary "4 changes applied" --output changes=4 --link "$STATE_URL"
```

`orrery report` reads `ORRERY_URL` and `ORRERY_TOKEN`, which the job has.
Without the CLI it is `POST $ORRERY_URL/v1/action-runs/$ORRERY_RUN/report`
with the credential as a bearer token. Steps, log lines, outputs, the
summary, the label, the link, and the `::step::`, `::output::`,
`::refresh::`, and `::final::` marker lines all work as they do for any
backend.

The job never says how its run ended: a report from it that carries a
`state` is refused with 400. The run's end is read from how the container
ended, by the starter: exit 0 is `succeeded`, anything else is `failed`. So
the job reports its summary, then exits with the code that says how it
went. A run whose job said nothing at all still ends truthfully. When the
job gave no summary, a failed run's summary is the platform's reason (`exit
137: OOMKilled`); when it gave one, that stands and the platform's reason
is a log line.

### How long it may run, and stopping it

A job's run lives as every run does, by being heard from (A run lives by
being heard from, below). The starter says it is alive on every pass while
the job runs, so nothing of the job's has to report for that. Its
`ceiling`, 7 days when the action names none, is how long it may run: the
starter stops a job past it and fails the run (`stopped: it ran past its
ceiling of 12h0m0s`), and on Kubernetes the Job's own deadline ends it then
too.

Whoever asked for a run, or an admin, stops it while its job runs: the
**Stop it** button on the run's page, or `POST
/v1/action-runs/{id}/withdraw`, the call that withdraws a run not started
yet. `canStop` on the run says the reader may. The run ends `cancelled` at
once, and the starter stops its job on its next pass. Only a job's run can
be stopped this way: for any other backend the hub has nothing it can have
stopped.

### The starter

The starter keeps nothing between passes. Each job it starts carries its
run's id, as labels on Kubernetes and in the execution's environment on
Azure Container Apps, and the hub answers which runs the starter claimed.
So a starter that restarts carries on from the two: on every pass (15
seconds by default) it reads the jobs it started and asks the hub how
those runs stand.

| What it finds | What it does |
|---|---|
| A running run, its job still going | Says the run is alive |
| A running run, its job ended | Reports `succeeded` or `failed`, with why |
| A running run, no job on the platform | Reports `unknown`: `its job is gone`. It waits two minutes after the claim first, since a new job may not show yet |
| A run the hub gave up for silence, its job still going | Leaves the job running; reports the true end when it ends |
| A cancelled run, its job still going | Stops the job |
| A job past its run's ceiling | Stops it, and fails the run, finally |
| A job whose container has not started within `start_within` | Stops it, and fails the run with what it waited for, such as `ImagePullBackOff` |
| A job of a run the hub does not say is the starter's | Leaves it alone |

A pass that cannot read the platform, or the hub, judges nothing: no run is
called gone because an API did not answer. `unknown` is the starter's alone
to say: no other reporter may.

It reads its config from `CONFIG` (default `/etc/job-starter/config.yaml`):

```yaml
platform: kubernetes               # or azure-container-apps; one starter serves one platform
start_within: 15m                  # how long a container may take to start (default 15m)
templates:
  infra-apply:
    images:                        # what a run may ask this template for
      - registry.example.org/infra/              # ends in /, :, or @: every image that starts with it
      - registry.example.org/tools/plan:1.2.3    # anything else: that one image
    container: main                # the container that takes the run's image, command, and environment; the first when left out
    namespace: infra-jobs          # kubernetes: the namespace its Jobs are made in
    manifest: infra-apply.yaml     # kubernetes: a Job manifest, in the config's own folder
    # job: /subscriptions/<id>/resourceGroups/<group>/providers/Microsoft.App/jobs/infra-apply   # azure-container-apps: the job to start
```

A template with no `images` allows none, and the config is refused. Its
environment: `ORRERY_URL` and `ORRERY_TOKEN` (a token of its runner
source), `JOB_ORRERY_URL` when a job reaches the hub at another address,
`INTERVAL` (default `15s`), and `JOBS`, the most runs it claims in one ask
(default 10). The image holds the starter and nothing else: no shell, no
package manager, no cloud CLI. A job never runs in it. Each family of jobs
has an image of its own, with exactly the tools those jobs call, and a
template that names it. Run one starter for each platform and trust
boundary, never one that can start everything.

**On Kubernetes**, the template's manifest is an ordinary `batch/v1` Job
the estate writes and owns:

```yaml
apiVersion: batch/v1
kind: Job
spec:
  ttlSecondsAfterFinished: 86400   # how long a finished Job stays to be looked at (a day when left out)
  template:
    metadata:
      labels: { azure.workload.identity/use: "true" }
    spec:
      serviceAccountName: infra-apply          # the identity the job runs as
      containers:
        - name: main
          image: registry.example.org/infra/runner:0   # replaced by the run's
          resources: { limits: { memory: 2Gi } }
```

The starter names the Job `orrery-<run>-<try>`, puts it in the template's
namespace, labels it and its pod `orrery/starter`, `orrery/run`,
`orrery/try`, and `orrery/template`, sets the run's image, command,
arguments, and environment on the container, and leaves everything else as
written. Where the manifest names none, it sets `backoffLimit: 0` (the hub
tries a run again, never the platform), `restartPolicy: Never`, and a
deadline at the run's ceiling. The starter needs this Role in each
namespace its templates name, and nothing else in the cluster:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata: { name: orrery-job-starter, namespace: infra-jobs }
rules:
  - { apiGroups: [batch], resources: [jobs], verbs: [create, get, list, delete] }
  - { apiGroups: [""], resources: [pods], verbs: [list] }
  - { apiGroups: [""], resources: [secrets], verbs: [create] }
```

It reads no Secret: it may only create the one that holds a run's
credential, which the Job owns and takes with it when it goes. Whoever may
create a Job in a namespace may run a pod as any service account there, so
give job runs a namespace of their own, holding only the service accounts
jobs may run as.

**On Azure Container Apps**, the template names a job that exists. The
starter reads the job, and starts one execution of it with the job's own
containers, the run's image, command, arguments, and environment set on the
one the template names. The job's other containers, its resources, and its
secret references stand. It signs in as its own workload identity
(`AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_FEDERATED_TOKEN_FILE`), never
with a secret, to the tenant the job's subscription belongs to. The
execution runs as the job's own managed identity. The starter's identity
needs one custom role on the jobs its templates name, and nothing else:

```json
{
  "Name": "Orrery Job Run Starter",
  "Description": "Starts executions of Azure Container Apps jobs for Orrery job runs, reads them, and stops one.",
  "Actions": [
    "Microsoft.App/jobs/read",
    "Microsoft.App/jobs/start/action",
    "Microsoft.App/jobs/executions/read",
    "Microsoft.App/jobs/stop/execution/action"
  ],
  "AssignableScopes": ["/subscriptions/<subscription>/resourceGroups/<the jobs' resource group>"]
}
```

It cannot change a job or read its secrets. The job's own timeout
(`replicaTimeout`) is the platform's; the starter stops an execution at the
run's ceiling when that comes sooner.

The starter speaks to the hub with three calls, as its runner source:

- `GET /v1/ingest/starter/jobs?wait=<seconds>&max=<n>` claims the queued
  runs that name it, held open up to 30 seconds while none is queued. Each
  is `{run, action, try, template, image, command, args, env, token,
  ceilingMs}`, and is `running` from then on.
- `POST /v1/ingest/starter/runs` with `{seen: [run ids]}` answers every run
  it holds that is still running, and each seen run it once claimed, as
  `{run, try, state, startedAt, ceilingMs, summary}`.
- `POST /v1/ingest/runner/jobs/{run}/report`, the runner's own report, for
  the runs it claimed. A report that carries nothing says the run is alive.

### An example

An apply that waits for approval, one at a time for each workspace, and
runs for up to twelve hours as a job of its own:

```yaml
actions:
  - id: infra_apply
    title: Apply infrastructure
    description: Apply a planned change to one workspace. It waits for approval, then runs as a job of its own.
    blueprint: workspace
    inputs:
      plan: { type: attachment, title: Plan, required: true }
      reason: { type: string, title: Why, required: true }
    approval: true
    serial: []                     # one apply at a time on a workspace
    ceiling: 12h
    backend:
      type: job
      starter: job-starter
      template: infra-apply
      image: "registry.example.org/infra/runner:{{ entity.fields.runner_version }}"
      command: [infra, apply]
      args: ["--workspace", "{{ entity.key }}"]
      env: { WORKSPACE: "{{ entity.key }}", ASKED_BY: "{{ by.name }}" }
    access:
      rules:
        - { owns: true }
```

## Reading logs and metrics

`cmd/telemetry-query` reads logs and metrics for a tool (Tools, above): log
lines from Loki, and series from Prometheus. It only reads. The two
addresses come from the runner's environment, never from an argument, and
it asks only the query paths, so nothing a caller types reaches a write, a
delete, or an admin endpoint. The `orrery-telemetry-runner` image is the
runner with it, at `/telemetry-query`.

```
telemetry-query logs --query '<LogQL>' [--since 1h] [--limit 200]
telemetry-query metrics --query '<PromQL>' [--since 1h] [--step 1m]
```

`logs` asks Loki for the lines the query finds in the last `--since` (1h),
at most `--limit` (200), newest first. It prints one line per entry: the
time in UTC, a few of the stream's labels (`namespace`, `pod`, `container`,
`app`, `service_name`, `job`, `level`, those it has), then the line. The
last line counts them, and says so when the limit was reached.

```
2026-03-10T11:59:00.000Z {namespace=shop pod=api-1 container=api app=shop-api level=error} it broke
2026-03-10T11:58:00.000Z {namespace=shop level=info} it started
2 log lines from the last 1h, newest first.
```

`metrics` without `--since` asks Prometheus for the query's value now, and
prints one line per series: its labels and its value. With `--since` it asks
for the range, a point every `--step` (1m), and prints each series' min,
max, last, and points count, then up to 30 of its points, evenly sampled.
The last line counts the series.

```
up{instance="a:80",job="shop"} min=0 max=1 last=1 points=61
  2026-03-10T11:00:00Z=1 2026-03-10T11:02:00Z=1 2026-03-10T11:04:00Z=0 ...
1 series, for the last 1h, a point every 1m.
```

A time span is a Go duration, or whole days or weeks: `30m`, `6h`, `2d`,
`1w`. An empty `--since`, `--limit`, or `--step` is the same as leaving it
out, and `--step` is read only with `--since`, so a tool may pass every flag
on every call.

Set these on the runner. Each command needs only its own address:

| Variable | What it is |
| --- | --- |
| `LOKI_URL` | Loki's address, such as `http://loki.example.org:3100`. `logs` needs it. |
| `LOKI_TOKEN` | Sent to Loki as a bearer token, when set. |
| `LOKI_TENANT` | Sent to Loki as `X-Scope-OrgID`, when set. |
| `PROMETHEUS_URL` | Prometheus' address, such as `http://prometheus.example.org:9090`. `metrics` needs it. |
| `PROMETHEUS_TOKEN` | Sent to Prometheus as a bearer token, when set. |

A tool's answer is at most 64 KB, so the command keeps its own small.
`--limit` is at most 1000 and `--since` at most 7d; more is brought down to
that. A log line is cut at 2000 bytes. A range's step is widened so a series
has at most 1000 points. Printing stops near 60 KB, and the last line then
says the output was cut and to narrow the query. Each request waits at most
25 seconds, so give the tool a `timeout` of 30s.

It exits 0 when the backend answered; 1 when the backend did not answer or
refused the query, with what the backend said; and 2 when it was asked
wrongly, such as with no query or with its address unset.

A tool for each. A number input renders as its digits, and an input left
out renders as its `default`, or as an empty argument when it has none:

```yaml
- id: read_logs
  title: Read logs
  description: Log lines from the estate's log store, newest first. The query is LogQL.
  inputs:
    query: { type: string, required: true }
    since: { type: string, default: 1h }
    limit: { type: number, default: 200 }
  backend: { type: runner, runner: telemetry-runner, command: [/telemetry-query, logs, --query, "{{ inputs.query }}", --since, "{{ inputs.since }}", --limit, "{{ inputs.limit }}"], timeout: 30s }
  tool: { tier: read }

- id: read_metric
  title: Read a metric
  description: What a PromQL query gives. With no since, its value now. With since, each series over that time.
  inputs:
    query: { type: string, required: true }
    since: { type: string }
    step: { type: string, default: 1m }
  backend: { type: runner, runner: telemetry-runner, command: [/telemetry-query, metrics, --query, "{{ inputs.query }}", --since, "{{ inputs.since }}", --step, "{{ inputs.step }}"], timeout: 30s }
  tool: { tier: read }
```

The runner's source needs `serves: { tiers: [read] }`, or it runs no tool.
These two name no entity, so an admin or a `tools.read` token calls them. To
lend them inside a person's request, give each a `blueprint` and a
`tool.from`, and the runner's `serves` an `on` that takes that entity
(Tools, above).

The runner reads whatever its addresses and tokens let it read, for every
caller who holds the tier. Bound that at the backend: a token or a tenant
that sees only what these tools should show.

## Reading Annals' tables

`cmd/annals-read` reads a table Annals publishes and prints it as the
`{ columns, rows }` a dataset or a report reads (Tools, above, and
docs/modelling.md, Datasets). It only reads. Annals' address and token come
from the runner's environment, never from an argument, and each command
asks one fixed path. The `orrery-telemetry-runner` image carries it, at
`/annals-read`.

```
annals-read gate-families [--weeks 12]
annals-read gate-drafts [--weeks 12]
```

`gate-families` is the change gate's four numbers, one row a week and
effect family, each with its coverage: needless asks, misses, unknowns,
and the wait, and whether the family was scored or its watch too blind.
`gate-drafts` is each draft gate pack's replay, one row a week: how many
asks it would have sent to no one, and how many of those did harm. What
each column counts is Annals' own to say, in its README. `--weeks` is how
many weeks, the current one counted, from 1 to 52; empty or left out is
Annals' default, 12.

| Variable | What it is |
| --- | --- |
| `ANNALS_URL` | Annals' API port, such as `http://annals.example.org:8081`. |
| `ANNALS_TOKEN` | A token Annals issued. These tables are counts, so any token reads them. |

It exits 0 when Annals answered a table; 1 when Annals did not answer,
refused, answered something that is not a table, or answered more than a
tool call carries (ask fewer weeks); and 2 when it was asked wrongly.

The gate's numbers as two datasets, each read by a saved query or a report
as `$data:<id>`. Like the telemetry tools above, they name no entity, so an
admin and the people the dataset's `access` names read them:

```yaml
- id: gate_families
  title: Change gate by family
  description: Needless asks, misses, unknowns, and the wait, a row a week and effect family, from Annals.
  dataset:
    fresh: 1h
    columns:
      - { id: week, title: Week, type: datetime }
      - { id: family, title: Family }
      - { id: score, title: Score }
      - { id: needless, title: Needless asks, type: number }
      - { id: misses, title: Misses, type: number }
      - { id: unknowns, title: Unknowns, type: number }
      - { id: coverage, title: Coverage, type: number }
      - { id: wait_median, title: Median wait, type: number }
  backend: { type: runner, runner: telemetry-runner, command: [/annals-read, gate-families, --weeks, "12"], timeout: 30s }
  access: { audiences: [platform] }
  tool: { tier: read }

- id: gate_drafts
  title: Change gate drafts
  description: Each draft gate pack's asks it would have sent to no one, and their harm, a row a week, from Annals.
  dataset:
    fresh: 1h
    columns:
      - { id: week, title: Week, type: datetime }
      - { id: pack, title: Draft pack }
      - { id: to_no_one, title: Would send to no one, type: number }
      - { id: harmed, title: Of those, did harm, type: number }
      - { id: coverage, title: Coverage, type: number }
  backend: { type: runner, runner: telemetry-runner, command: [/annals-read, gate-drafts, --weeks, "12"], timeout: 30s }
  access: { audiences: [platform] }
  tool: { tier: read }
```

A report keeps one edition a week when its publish action is scheduled
weekly on it (docs/modelling.md, Running a report).

## Granting access in Entra

`entra-grant`, in the `orrery-access-runner` image, gives the access: it
assigns a user a role on an enterprise app, or adds a user to a group, and
then marks the approval approved, with the runner's source token. It is
idempotent: access already held is success. It refuses a dynamic group, a
role the app does not give people, and a disabled user.

It takes access away the same way: it removes a user's or a group's role on
an app, or a user from a group. Access already gone is success. It refuses a
dynamic group and a role the app does not define, and takes access from a
disabled user too.

```
entra-grant assign --app <entra_app key or client id> --user <entra_user key, object id, or email> --role <value or default> [--approval <it_approval key> --by <email>]
entra-grant add-to-group --group <entra_group key or object id> --user <...> [--approval <it_approval key> --by <email>]
entra-grant unassign --app <...> (--user <...> | --group <entra_group key or object id>) --role <value or default>
entra-grant remove-from-group --group <...> --user <...>
```

Each run names its steps: `Sign in`, then `Give access` and, with
`--approval`, `Close the approval`; `Remove access` for the two that take it
away; `Review` and `Record the review` for a review (Reviewing access,
below). None is named `Verify`: the command trusts Entra's answer and does
not read the assignment back.

An application granted directly gets the assign action; one granted through
a group gets the group action. Each is an action on the approval, per
delegated team, with the approval's application and requester picked for
the approver. The application's first `sign_in` app is the one assigned, in
its `access_role`, or a role the approver picks from the app's roles:

```yaml
- id: approve_app_access_service_desk
  title: Approve and assign
  blueprint: it_approval
  where: { and: [{ field: kind, op: eq, value: app_access }, { field: decision, op: eq, value: pending }] }
  inputs:
    application: { type: entity, blueprint: it_application, required: true, default: "{{ entity.relations.application }}", where: { and: [{ relatedTo: "{{ entity.id }}" }, { field: assign_teams, op: contains, value: service-desk }] } }
    app: { type: entity, blueprint: entra_app, required: true, default: "{{ inputs.application.relations.sign_in }}", where: { relatedTo: "{{ inputs.application.id }}" } }
    user: { type: entity, blueprint: entra_user, required: true, where: { field: email, op: eq, value: "{{ entity.fields.requested_by }}" } }
    role: { type: enum, required: true, default: "{{ inputs.application.fields.access_role }}", values: "{{ inputs.app.fields.roles }}" }
  backend:
    type: runner
    runner: access-runner
    command: [/entra-grant, assign, --app, "{{ inputs.app.key }}", --user, "{{ inputs.user.key }}", --role, "{{ inputs.role }}", --approval, "{{ entity.key }}", --by, "{{ by.name }}"]
  access: { grants: [{ path: teams, values: [service-desk] }] }

- id: approve_group_access_service_desk
  title: Approve and add to the group
  blueprint: it_approval
  where: { and: [{ field: kind, op: eq, value: group_access }, { field: decision, op: eq, value: pending }] }
  inputs:
    application: { type: entity, blueprint: it_application, required: true, default: "{{ entity.relations.application }}", where: { and: [{ relatedTo: "{{ entity.id }}" }, { field: assign_teams, op: contains, value: service-desk }] } }
    group: { type: entity, blueprint: entra_group, required: true, default: "{{ inputs.application.relations.access_groups }}", where: { and: [{ relatedTo: "{{ inputs.application.id }}" }, { field: dynamic, op: eq, value: false }] } }
    user: { type: entity, blueprint: entra_user, required: true, where: { field: email, op: eq, value: "{{ entity.fields.requested_by }}" } }
  backend:
    type: runner
    runner: access-runner
    command: [/entra-grant, add-to-group, --group, "{{ inputs.group.key }}", --user, "{{ inputs.user.key }}", --approval, "{{ entity.key }}", --by, "{{ by.name }}"]
  access: { grants: [{ path: teams, values: [service-desk] }] }
```

An application's `access_role` empty leaves the role for the approver to
pick. Actions on `it_application` itself give someone an application with
no request at all, delegated the same way:

```yaml
- id: give_application_service_desk
  title: Give someone this application
  blueprint: it_application
  where: { and: [{ field: access, op: eq, value: direct }, { field: assign_teams, op: contains, value: service-desk }] }
  inputs:
    app: { type: entity, blueprint: entra_app, required: true, default: "{{ entity.relations.sign_in }}", where: { relatedTo: "{{ entity.id }}" } }
    user: { type: entity, blueprint: entra_user, required: true }
    role: { type: enum, required: true, default: "{{ entity.fields.access_role }}", values: "{{ inputs.app.fields.roles }}" }
  backend:
    type: runner
    runner: access-runner
    command: [/entra-grant, assign, --app, "{{ inputs.app.key }}", --user, "{{ inputs.user.key }}", --role, "{{ inputs.role }}"]
  access: { grants: [{ path: teams, values: [service-desk] }] }

- id: add_to_application_group_service_desk
  title: Add someone to this application's group
  blueprint: it_application
  where: { and: [{ field: access, op: eq, value: group }, { field: assign_teams, op: contains, value: service-desk }] }
  inputs:
    group: { type: entity, blueprint: entra_group, required: true, default: "{{ entity.relations.access_groups }}", where: { and: [{ relatedTo: "{{ entity.id }}" }, { field: dynamic, op: eq, value: false }] } }
    user: { type: entity, blueprint: entra_user, required: true }
  backend:
    type: runner
    runner: access-runner
    command: [/entra-grant, add-to-group, --group, "{{ inputs.group.key }}", --user, "{{ inputs.user.key }}"]
  access: { grants: [{ path: teams, values: [service-desk] }] }
```

The runner's identity needs leave to change assignments and members. Give it
only that:

- **With Entra ID P1:** a custom Entra role holding only
  `microsoft.directory/servicePrincipals/appRoleAssignedTo/update`, assigned
  to the identity at the scope of each enterprise app it may grant, one app at
  a time; and Groups Administrator, scoped to an administrative unit that
  holds only the access groups. It then cannot touch any other app or group,
  and needs no Graph application permission to write.
- **Without P1:** the Graph application permissions
  `AppRoleAssignment.ReadWrite.All` and `GroupMember.ReadWrite.All`. These
  reach every app and group in the tenant, and the first can grant the
  identity more permissions, so the actions' grants and filters are the only
  limit. Use its own registration with no secret, and only the access runner.

The runner's source must be registered for `it_approval` to close an
approval, and for `it_access_review` to record a review (below).

## Reviewing access

An access review is one person checking who holds an application, taking
away what should go, and signing off. The sign-off is an `it_access_review`
(see the modelling guide): when, by whom, which system, how many accounts
kept and removed, which were removed, and notes, with the relation
`application` to the `it_application`. An application's reviews are listed
on its page.

For an application people sign in to through Entra, the review removes and
signs off in one run. `entra-grant review` takes away each assignment named
after its flags, counts the user and group assignments the app keeps, then
writes the review with the runner's source token:

```
entra-grant review --application <it_application key> --app <entra_app key>... --key <it_access_review key> --by <email> [--note <text>] [<entra_app_role_assignment key>...]
```

An assignment the app no longer holds was removed already, and counts as
removed. When a removal fails it stops before writing the review, and the
log says what it removed; run it again to finish. The reviewer picks what to
take away from the assignments of the application's `sign_in` app; what is
left unpicked is kept:

```yaml
- id: review_app_access
  title: Review who has access
  description: Check who holds this application through Entra, take away what should go, and sign off. The removals happen in Entra at once; the sign-off is an access review on the application.
  blueprint: it_application
  where: { relation: sign_in }
  inputs:
    app: { type: entity, title: Sign-in app, blueprint: entra_app, required: true, default: "{{ entity.relations.sign_in }}", where: { relatedTo: "{{ entity.id }}" } }
    remove: { type: entity, title: Take away, description: Everyone left unticked keeps their access., blueprint: entra_app_role_assignment, many: true, where: { relation: app, target: "{{ inputs.app.id }}" } }
    note: { type: string, title: Note, description: "What you checked, and why anything went." }
  confirm: true
  backend:
    type: runner
    runner: access-runner
    command: [/entra-grant, review, --application, "{{ entity.key }}", --app, "{{ inputs.app.key }}", --key, "orrery/{{ run.id }}", --by, "{{ by.name }}", --note, "{{ inputs.note }}", "{{ inputs.remove.key }}"]
  access: { grants: [{ path: teams, values: [service-desk] }] }
```

The assignments come last in the command, one argument each (Backends,
`runner`). A filter follows one relation, so the form offers one sign-in
app's assignments at a time: an application that signs in through more than
one app is reviewed once per app.

For a system Orrery cannot change, the review records the decision, and the
removal happens in that system by hand. A `record` backend writes the review
straight from the form:

```yaml
- id: record_app_access_review
  title: Record an access review
  description: Sign off who holds this application in a system Orrery cannot change. Remove the accounts there by hand; this records what you kept and removed.
  blueprint: it_application
  where: { not: { relation: sign_in } }
  inputs:
    system: { type: string, title: System, required: true, default: "{{ entity.title }}", description: Where the access is kept. }
    kept: { type: number, title: Accounts kept, required: true }
    removed_count: { type: number, title: Accounts removed, required: true, default: 0 }
    removed: { type: string, title: Removed accounts, many: true, description: One per line, as the system names them. }
    note: { type: string, title: Note, description: "What you checked, and why anything went." }
  confirm: true
  backend:
    type: record
    source: access-requests
    blueprint: it_access_review
    key: "orrery/{{ run.id }}"
    title: "Access review by {{ by.name }}"
    fields:
      reviewed_at: "{{ run.at }}"
      reviewed_by: "{{ by.name }}"
      system: "{{ inputs.system }}"
      kept_count: "{{ inputs.kept }}"
      removed_count: "{{ inputs.removed_count }}"
      removed: "{{ inputs.removed }}"
      notes: "{{ inputs.note }}"
    relations: { application: "{{ entity.key }}" }
  access: { grants: [{ path: teams, values: [service-desk] }] }
```

A template cannot count, so the form asks for both counts. The
`access-requests` source is registered for `it_access_review` as well as
`it_approval`. Every run of either action reaches Annals like any other,
so each removal and sign-off is in the history too.

## Agents

The MCP server lists the actions the agent may run with `list_actions`, runs
one with `run_action`, and follows it with `get_action_run`, which carries
the run's log, each line under its step, its `steps`, and its `outputs`.
`list_actions` gives each input with its type and its rules, says what every
type is, and names the blueprint a `person` input picks from. It gives an
input's `when`, marks one the hub works out as `workedOut`, and gives its
`unique` and its `current`. For an input that changes a list the entity
holds, the agent sends the whole list as it should be, and `run_action`
answers `changes`: per input, what the run adds, what it removes, and how many
it keeps, for the agent to tell the person. A run that changes nothing is
refused over that input. An agent sends nothing for an input that is not asked or is worked
out: what it sends for one is dropped, never refused. A `run_action`
that is refused over one input answers `{error, input}`, with the input's
name, so the agent knows which value to change; `POST /v1/actions/{id}/run`
answers the same. `list_actions`
with `entity` lists only the actions the agent may run on that entity, with
whether a run there waits for approval. A run that waits answers `approve`,
the link to its page, and `next`, what to tell the person: the agent hands
the link on and never decides the run. `next` also says, for every run not
yet ended, whether anything of the agent's must stay for it. For every
backend but `caller` nothing must: the hub holds the run, so the agent asks,
tells the person, and stops, and `get_action_run` reads the run's state,
steps, log, outputs, and link at any time after, from any session. From a
shell, `orrery run <action> --no-wait` asks and returns, and `orrery watch
<run> --once` reads the run as it stands. For an action called as a person
(`onBehalf` with `approval`), the run runs as whoever approves it there,
signed in. An agent with a
person's key is that person; an agent with a machine token is named in a
grant by the token's name.

An agent that prepares many runs for a person to approve asks them as one
change set with `propose_changes`: a title, a note that says why, and the
items, each `{action, entity, inputs}`. A refused set names each refused item
by its `index`. A set that is asked answers `approve`, the link to its page,
where the person reads every change and approves them all at once.

`list_tools` lists the tools the agent holds the tier for, on an entity or
of none, and `call_tool` calls one and answers what it printed (Tools,
above). An agent calls only with its own tiers; lending in a person's name
is the REST door's alone.

## A worked example: upgrade an ArgoCD application

The estate has `argocd_app` entities with `path` (where in the repository the
kustomization lives) and a `namespace` relation, and `k8s_workload` entities
with `images`, both from the Kubernetes pusher. The generic action picks the
app, a workload in the namespace it deploys into, the images to move, and a
tag for all of them; `overrides` takes `image:tag` lines for the odd case
where two images go to different versions in tandem.

```yaml
actions:
  - id: upgrade_argocd_app
    title: Upgrade an ArgoCD application
    description: Set container images to new tags in the application's kustomization, commit it, and let ArgoCD roll it out. Pick the workload that runs the images, the images to move, and the tag; add image:tag lines to send some to a different tag.
    icon: argocd
    group: Operations
    blueprint: argocd_app
    inputs:
      workload: { type: entity, title: Workload, blueprint: k8s_workload, required: true, where: { relation: namespace, target: "{{ entity.relations.namespace }}" } }
      images: { type: enum, title: Images, many: true, required: true, values: "{{ inputs.workload.fields.images }}" }
      tag: { type: string, title: New tag, required: true, description: The tag every picked image moves to, such as 0.9.13. }
      overrides: { type: string, title: Overrides, many: true, description: "image:tag, one per line, for an image that goes to a different tag." }
    backend:
      type: github_workflow
      owner: example
      repo: platform
      workflow: upgrade-image.yml
      secretRef: github_token
      inputs: { run: "{{ run.id }}", path: "{{ entity.fields.path }}", images: "{{ inputs.images }}", tag: "{{ inputs.tag }}", overrides: "{{ inputs.overrides }}" }
    access:
      grants:
        - { path: teams, values: [platform] }
```

A tailored action for one application needs no picking at all. Bound to the
one cluster workload it deploys, it shows what runs now beside the versions
on offer; a form whose `where` leaves one entity picks it on its own:

```yaml
  - id: deploy_orrery
    title: Deploy orrery
    description: Move the hub, the Kubernetes pusher, and the runner to one version, in one commit. Pick the version from the tags the registry holds.
    icon: rocket
    group: Orrery
    blueprint: k8s_workload
    where: { field: $key, op: eq, value: home/orrery/orrery }
    inputs:
      version: { type: entity, title: Version, required: true, blueprint: container_image, where: { relation: repository, target: "container_repository:registry.example.org/orrery" }, sort: -tag, current: "{{ entity.fields.images }}", description: "Running now: {{ entity.fields.images.0 }}" }
    backend:
      type: github_workflow
      owner: example
      repo: platform
      workflow: upgrade-image.yml
      secretRef: github_token
      inputs:
        run: "{{ run.id }}"
        path: kubernetes/workloads/orrery/envs/prod
        images: '["registry.example.org/orrery:{{ inputs.version.fields.tag }}", "registry.example.org/orrery-pusher-k8s:{{ inputs.version.fields.tag }}", "registry.example.org/orrery-runner:{{ inputs.version.fields.tag }}"]'
    access:
      grants:
        - { values: [ada@example.org] }
```

The hub needs the secret `github_token`: a fine-grained personal access token
with Actions read and write on the repository, set on the Sources page under
secrets. The repository needs `ORRERY_TOKEN`, an access token bound to a role
holding `actions.report`, and the variable `ORRERY_URL`, the hub's ingest
host.

The workflow takes `images` as a JSON list of `name:tag` (an image picked
from the workload comes with the tag it runs now, so `tag` says where it
goes; an override line, or a tailored action, names the tag outright). It
sets every entry in one commit, pushes, and reports. ArgoCD with automated
sync rolls the commit out on its own.

```yaml
name: Upgrade image
on:
  workflow_dispatch:
    inputs:
      run: { description: The orrery run to report into, required: true }
      path: { description: The ArgoCD application path, required: true }
      images: { description: 'JSON list of image:tag to set', required: true }
      tag: { description: The tag every listed image moves to; without it, each entry's own tag, required: false }
      overrides: { description: 'JSON list of image:tag that win over tag', required: false }
permissions:
  contents: write
jobs:
  upgrade:
    runs-on: ubuntu-latest
    env:
      ORRERY_URL: ${{ vars.ORRERY_URL }}
      ORRERY_TOKEN: ${{ secrets.ORRERY_TOKEN }}
      RUN_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}
    steps:
      - uses: actions/checkout@v4
      - name: A report helper
        run: |
          cat > /usr/local/bin/report <<'SH'
          #!/bin/sh
          # report <run> <json body>: tell the hub how the run is going.
          curl -sS -f -X POST "$ORRERY_URL/api/action-runs/$1/report" -H "authorization: Bearer $ORRERY_TOKEN" -H 'content-type: application/json' -d "$2" > /dev/null
          SH
          chmod +x /usr/local/bin/report
      - name: Report start
        run: |
          report "${{ inputs.run }}" "{\"label\": \"setting the tags\", \"link\": \"$RUN_URL\"}"
      - name: Set the tags
        env:
          IMAGES: ${{ inputs.images }}
          TAG: ${{ inputs.tag }}
          OVERRIDES: ${{ inputs.overrides }}
        run: |
          set -euo pipefail
          file="${{ inputs.path }}/kustomization.yaml"
          base="$(dirname "$(dirname "${{ inputs.path }}")")/base/kustomization.yaml"
          [ -f "$base" ] && file="$base"
          # Every image to set: picked images take TAG when given, overrides win, each entry is name:tag.
          wanted=$(jq -rn --arg tag "$TAG" --argjson images "$IMAGES" --argjson overrides "${OVERRIDES:-[]}" '
            ($images | map(if $tag == "" then . else (split(":")[:-1] | join(":")) + ":" + $tag end))
            + $overrides
            | map(split(":") | {name: (.[:-1] | join(":")), tag: .[-1]})
            | group_by(.name) | map(last) | .[] | "\(.name) \(.tag)"')
          changed=()
          while read -r name tag; do
            grep -q "name: $name\$" "$file" || { echo "$file does not list $name"; exit 1; }
            sed -i "\|name: $name\$|,\|newTag:|s|newTag: .*|newTag: \"$tag\"|" "$file"
            changed+=("$name to $tag")
          done <<< "$wanted"
          if git diff --quiet; then echo "nothing to change"; exit 1; fi
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git commit -am "chore(k8s): upgrade $(IFS=,; echo "${changed[*]}") [skip ci]"
          git push
          report "${{ inputs.run }}" "$(jq -cn --arg file "$file" --arg sha "$(git rev-parse --short HEAD)" --args '{log: (($ARGS.positional | map($file + ": " + .)) + ["pushed " + $sha])}' "${changed[@]}")"
      - name: Report success
        run: |
          report "${{ inputs.run }}" '{"state": "succeeded", "summary": "the images are set; ArgoCD will roll them out"}'
      - name: Report failure
        if: failure()
        run: |
          report "${{ inputs.run }}" '{"state": "failed", "summary": "the upgrade did not go through; see the workflow run"}'
```
