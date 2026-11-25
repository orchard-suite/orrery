# orrery

A self-hosted control plane and console for everything you own and run:
push it in, see how it connects, know if it's healthy, and act on it.

Orrery is an estate's control plane: the one service that holds the state
of its things and carries out changes to them. It holds the model, the
inventory, the actions, the approvals, the schedules, the reports, and the
scores. It is also the console: where the people who run a platform see
everything they own and act on it, as lists and actions. Other tools feed
it and act through it, and keep their own pages. An app built for a
business keeps its own portal and its own rules, and uses Orrery as an
API, an inventory, an action runner, and an approval system. No business
logic lives in Orrery.

Every existing tool shows its own slice: the Azure portal, Grafana, GitHub,
Proxmox, UniFi. Orrery joins the slices into one graph with live status on
top, so a person or an AI agent can answer "what do I have, how does it fit
together, and is it healthy?" from one place.

It never changes the systems it describes on its own: a self-service action
asks a backend you run to make a change, and shows what came of it. It stores
no time series and schedules nothing. Pushers run on your own platforms and
only ever connect out to the hub.

## How it works

**Blueprints** are typed schemas for one kind of thing. The hub knows nothing
about clouds or clusters; it knows blueprints. Every grid, page, and form is
generated from them. Define them in a git catalog or in the web app:

```yaml
blueprints:
  - id: azure_sql_database
    title: Azure SQL Database
    description: A single database on an Azure SQL logical server.
    fields:
      sku:         { type: string, title: SKU }
      max_size_gb: { type: number }
      last_seen:   { type: datetime, overridable: false }
      portal:      { type: url, title: Azure portal }
      notes:       { type: markdown }
    relations:
      server: { target: azure_sql_server, many: false, display: contain }
      system: { target: system, many: false }
```

**Entities** are instances, identified as `blueprint:key`. Keys are chosen by
the writing source and must be stable. Relations may point at an entity that
does not exist yet; they connect when it arrives, so the order sources run in
never matters.

**Sources** are writer identities: one pusher per cluster, one git repo, the
web app, the hub itself. Each is registered with the blueprints it may write,
whether it may delete, and how often it is expected. A source that stops
reporting turns grey on the wall.

An admin may say what a source acts for: `actsFor`, an entity reference
`<blueprint>:<key>` such as the service whose token it is. The hub checks its
shape and nothing more, and each change is an activity row. The hub also
keeps what each source has written: the entities it wrote by blueprint, with
a count and the last time, the blueprints it offered that the hub took, and
the actions it put. A refused write is not counted, and a removed source's
record goes with it. `GET /v1/sources` and `GET /v1/sources/{id}` carry
both, as `actsFor` and `writes: {entities: [{blueprint, count, lastAt}],
blueprints: [{id, lastAt}], actions: [{id, lastAt}]}`; anyone who reads may
read them. What is stored trails what the hub answers by up to a minute.

**Runs and scopes.** A pusher opens a run over a scope (a cluster, an org, a
subscription), sends batches, and commits. Only a committed snapshot can mark
things missing, and only within its own source and scope. A run that crashes
deletes nothing. A snapshot opened while another of the same scope is still
open supersedes it: the older one is abandoned, so two overlapping snapshots
never mark each other's entities missing. If a snapshot would drop more than 30% of its scope, it still
commits, but the entities get extended grace, the source turns amber, and a
finding asks a person to decide.

**Value precedence.** Every value records where it came from. Lowest to
highest: blueprint default, a value typed in the web app, a pushed value, a
soft override, git. A soft override remembers the pushed value it replaced;
when the pushed value moves, the override clears and the timeline says so.
Git always wins and is locked in the UI. If you want a value to survive any
upstream change, put it in git.

**Open by default.** Whoever holds `entities.edit` may change any value,
pushed ones included: the change stands over the pushed value until the
source pushes a different one, and then gives way. A field marked `sticky`
keeps the person's change instead, for a value that is an opinion, such as a
repository's main language. A pusher's blueprints leave their fields open.

**Open to owners, a few fields at a time.** Most people hold no
`entities.edit`. An **edit rule** in the access policy opens the fields and
relations it names, on the blueprints it names, to the owners of each entity
or to an audience, and nothing else: see "Edit rules" under Access. An owner
writes where no source says a value and never over one, so a source stays
the truth for what it sends.

**Locked fields.** A field marked `overridable: false` is written by sources
and by nobody else. A person cannot set it or change it in the web app, on a
new entity or an existing one, and neither can an access token through
`/v1/entities`. Whoever holds `model.edit` ticks **locked** on the field in
the model editor, or a catalog file sets the flag.

**Money.** A `number` field can say how it is shown with
`format: { kind: currency, currency: USD, minor: true }`. With `minor`, the
stored number is a whole count of the currency's smallest unit, so `123456`
shows as `$1,234.56` in the grid, on the entity page, in the editor, and on
the query page, and hovering the grid cell shows the stored number. A query
column every blueprint fills with the same money shows it in its cells, its
totals, its groups, and its range under **Fields**, and an export writes the
amounts with Excel's money format. A condition on money is typed and read as
an amount (`$1,700`) and keeps the stored number. Only the display changes:
the field sorts, filters, sums, and feeds calculations as the stored number,
and a whole number adds exactly where a decimal would not. Agents see the
format in `describe_model` and on each money column of `run_query`. A value with a
fraction is refused on a `minor` field. A pusher may offer the format; the
model editor has a **Currency** box on a number field.

**Value colours.** An enum, a boolean, and a text, address, or person field
marked `chip: true` show as coloured chips. The grid draws how a column's
values share out the rows that matched under it for an enum, a boolean, a
list, and a chip, and a filter on one picks its value from them. A field's
`spread` changes that on its own: `false` keeps a chip and drops the count,
for a column of many values such as a version, and `true` counts plain text.
The model editor calls it **Count under the grid**. A list column where one
row holds more than a hundred values gets no such bar. Every
colour comes from one palette: `blue`, `turquoise`, `green`, `lime`,
`yellow`, `orange`, `red`, `pink`, `purple`, `brown`, and `grey`, which is
kept for no value. A field names the colour of any value in `colors`;
whoever holds `model.edit` picks them in the model editor. A value it leaves
out wears the colour it names (`red`, `amber`), an enum value the colour at
its place in the list, a boolean green or grey, and anything else one taken
from its text, the same every time and never one that reads as a status
(red, orange, yellow, lime, green, or the amber-like brown):

```yaml
environment: { type: enum, values: [production, staging, development], colors: { production: red, staging: yellow, development: green } }
```

**Links.** A `url` field's links show as small marks in the grid, with the
address on hover, and beside the address on the entity page. A link into a
console or tool the hub knows wears that site's logo, and so does a tool
hosted under your own domain when its host says what it is
(`gitlab.example.org`, `grafana.example.org`). A field can name an icon from
the set for all its links, or turn icons off to show the address: a person
picks either in the field's form. A link to anywhere else is a plain link
mark. Tick **list** on the field and it holds several links, such as the
dashboards or runbooks of a service, each with its own mark.

```yaml
portal: { type: url, title: Azure Portal, icon: azure }
dashboards: { type: url, many: true }
```

An enum takes **list** too: the field then holds several of its values at
once, each shown as a chip, such as the skills a person has or the languages
a repository is written in. The grid counts each value, and a filter matches
any one of them.

```yaml
skills: { type: enum, values: [csharp, python, kubernetes], many: true }
```

**Title and icon** are values like any other, carried by every entity. An
entity shows its blueprint's icon until it has one of its own: push `icon`
beside `title`, set it in a catalog file, or pick one in the web app. An icon
a person picks stays for as long as no source pushes one; over a pushed icon
it is a soft override. A name outside the icon set and the custom icons is
ignored and the blueprint's icon shows.

**Git sources** are registered repos of catalog files, pulled every 15
minutes, on demand, or from a webhook. A private repo authenticates with a
static token or a GitHub App, whose installation token the hub mints on
every pull. Git values always win and are locked in the UI. Removing a git
source hands the blueprints, rules, and scorecards it defined to the web app,
where they become editable.

**Relation rules** join things without agreeing on a tagging convention:

```yaml
relationRules:
  - blueprint: k8s_workload
    relation: system
    match: { target: system, where: "target.key == source.labels['app.kubernetes.io/part-of']" }
```

They are re-evaluated continuously. Changing one re-links the whole estate.
An entity a rule finds no target for is a finding, unless the rule says
`optional: true`: for a rule most entities are expected not to match, such as
workloads running images from outside the registry.
A rule on a relation that holds one target and finds several links none of
them: it has no evidence for one over the others. The hub logs it, and the
entity is left unlinked until only one target matches. A target its source no
longer sees (missing) is weaker evidence: when exactly one of the matches is
still seen, that one is linked. A list on the source
side is read in order: the first member that finds anything decides, so a
specific name ahead of a general one wins.
A list on either side matches on any of its members, so a person who holds
several addresses is found by each of them:

```yaml
  - blueprint: commit
    relation: author
    match: { target: user, where: "target.emails == source.author_email" }
```

**Findings** list what is wrong with the graph itself: dangling relations,
entities connected to nothing, rules that matched nothing, stale sources,
mass drops, cleared overrides (unless the source now sends what was set),
refused writes (until the source's next run of the same scope commits), a
field one source wrote and another overwrote, and a path in the model that
names something the model no longer has. A link from a blueprint that expires
by age, a record of something that happened, to an entity since deleted is
history and raises no finding. A blueprint marked `standalone: true` holds
things that may be connected to nothing, such as mailing lists nobody owns,
and raises no finding for one.

## What ships in the box

Almost nothing, on purpose. The model is yours: the hub has no notion of a
cloud, a cluster, a system, or a team until you define one.

- **No model.** A new hub holds only its own blueprints, below. Every
  other blueprint is the estate's: a person makes it on the Model page,
  imports it, declares it in a catalog file, or a pusher offers it.
- **Import.** In the web app, Model → Import brings in a file of your own.
  An import creates what is missing, adds fields and relations to a
  blueprint that exists, and never changes or removes anything, so it is
  safe to run again. Everything it brings is yours to edit. The hub also
  offers **Kubernetes links**, which ties what the Kubernetes pusher writes
  to a model's `sw_service`, `sw_workload`, `sw_environment`, and `team`.
  `docs/modelling.md` is the guide to modelling an estate, with an example
  model for a software estate.
- **`orrery_source`, `orrery_runner`, and `orrery_schedule`.** The hub keeps
  one entity per source, per runner, and per action schedule that is still a
  job, so a stale source or a failing schedule shows like anything else. A
  schedule links to what it runs on, so the page of each thing lists the
  schedules that run on it, and an admin may show each schedule to whoever
  can see what it runs on. The hub also keeps `orrery_report` and
  `orrery_report_edition`: a team's reports and every edition they publish
  (Reports, below). These are locked, and every id starting with
  `orrery_` is reserved for the hub, so they never collide with a blueprint of
  yours.
- **Pushers bring their own blueprints.** A pusher offers the blueprints it
  writes when it starts. The hub creates the ones that do not exist. One that
  exists gains the fields and relations it lacks, and the status field when it
  has none, so several pushers can share one blueprint. A ground and a
  number's budget are the estate's to name: only a model someone imports sets
  them on a blueprint that exists, and only where there is none. A field a source
  brought keeps that source's mark (`offered`: the source and a fingerprint of
  its definition), and the source's next offer replaces it while nobody has
  edited it since, so a product keeps its own rules current. Once a person
  edits the field, or another writer defines it, it stays as they left it. A
  budget, a rule on who sees the field, and a lock on who changes it are the
  estate's own and are not an edit: the source's next offer still replaces the
  rest and keeps all three. The
  status field a source chose moves the same way. A source may only offer
  blueprints it is registered for, and never sets the mark itself. A field a
  source did not bring, such as one made by hand before the product could
  offer it, is handed to it by an admin: `POST
  /v1/blueprints/{id}/hand-over` with `{ source, fields, status }` marks each
  named field as the source's, with the fingerprint of its definition now
  (and with `status: true`, the status field too), so the source's next offer
  replaces them. It is refused on a blueprint git or the hub defines, for a
  source the hub does not know, and for a field the blueprint lacks, and it
  is recorded in the activity log like any change to a blueprint.

- **An icon set.** A blueprint's `icon` names one of about 1,300 icons: concepts
  (`service`, `team`, `database`, `rocket`), colour brand logos
  (`kubernetes`, `argocd`, `teams`, `github`), and Microsoft's icon for every
  Azure service (`azure_app_services`, `azure_storage_accounts`,
  `azure_service_bus`). It is the
  default for the blueprint's entities, and each entity can carry its own. The
  names are in `src/shared/icons.ts`, and the same picker opens from a
  blueprint in the model editor and from any entity's icon. An unknown name
  shows a box.
- **Custom icons.** A picture the set lacks, such as your own app's logo, is a
  custom icon: an SVG, PNG, or WebP of at most 256 KiB, named in lowercase
  letters, digits, and underscores, never a name the set already has. Any
  name works wherever an icon is named, and the picker offers them under
  Custom. A git source loads `icons/<name>.svg|png|webp` beside its catalog
  files, owns them, and removes one when its file leaves the repository; a
  git icon is changed only in git. The forge reader puts a repository's
  logo when it reads its `orrery.yaml` (`icon:`), and anyone with
  `entities.edit` can put one through the API. An SVG that holds a script,
  an event handler, a `javascript:` address, a `foreignObject`, an entity
  declaration, or a link that is not inside itself or a `data:image/` is
  refused.

  | Route | Who | Answers |
  | --- | --- | --- |
  | `PUT /v1/icons/{name}` | a source token, or `entities.edit` | the image as the body, its type in `Content-Type`; `{name, type, sha256, size}`. 400 a bad name, 409 a built-in name or an icon set in git, 413 too big, 415 another type, 422 bytes it may not hold |
  | `GET /v1/icons/{name}` | anyone who reads | the custom icon, else the built-in brand file (`?theme=light` for the light ink copy), else 404; `ETag` and `If-None-Match` answer 304 |
  | `GET /v1/icons` | anyone who reads | `{icons: [{name, type, sha256, size, owner, updatedAt}]}` |
  | `DELETE /v1/icons/{name}` | an admin | `{ok: true}`, or 404 |

  Putting new bytes or removing an icon writes one activity row; the same
  bytes again write none.

Blueprints are listed under the `group` each one names. Groups are free text:
there is no fixed list. The order of the groups is one shared setting, the
same for everyone: the groups it names come first, the rest follow by name,
and blueprints with no group come last. A group can also start closed for
everyone. Anyone opens or closes a group for themselves with a click on its
heading, and it goes back to how it starts when they reload. Whoever holds
`catalog.organize` moves a group, and sets whether it starts open or closed,
from its heading in the sidebar.

Inside a group, blueprints are listed by title until someone orders them.
Whoever holds `catalog.organize` moves a blueprint up or down from its row in
the catalog's sidebar, for everyone. From then on the group keeps that order,
and a new blueprint lands at the bottom, by title. The same person hides a
blueprint from its row, to keep a long group short. A hidden blueprint is
still there, with its entities, its page, and its place in the model: it is
only left out of the catalog's list. Anyone brings a group's hidden blueprints
back for themselves with **Show hidden items** on its heading. They are listed
in a folder of their own at the bottom of the group, apart from the order of
the rest, and a search finds them too.

A git catalog can declare the layout instead, and then only git changes it.
Each key is optional, and the key for blueprints with no group is `""`:

```yaml
config:
  catalog:
    groupOrder: [Catalog, Cloud, Kubernetes]
    closedGroups: [Kubernetes]
    blueprintOrder:
      Catalog: [sw_service, sw_api, sw_repository]
    hiddenBlueprints: [azure_management_group, azure_subscription]
```

## Modelling

**Taking a relation off a blueprint** keeps its links. Nothing reads them
any more: not the entity, the entity it pointed at, a search, or a finding.
Put the relation back and its links come back with it. A removed field keeps
its values the same way.

**Derived fields** are computed when an entity is read, never stored.

- A **mirror** reads a field through relations, one hop per dot:
  `mirror: team.department.title`. A hop starting with `<-` follows relations
  that point at the entity: `<-argocd_app:workload.sync_status`.
- An **aggregation** counts or reduces what a relation path reaches:

  ```yaml
  services:     { type: number, aggregation: { relation: '<-team:department.<-sw_service:team', fn: count } }
  cost:         { type: number, aggregation: { relation: '<-resource:service', fn: sum, field: monthly_cost } }
  deploys_30d:  { type: number, aggregation: { relation: '<-sw_deployment:service', fn: count, window: { field: deployed_at, last: 30d } } }
  deploys_week: { type: number, aggregation: { relation: '<-sw_deployment:service', fn: count, window: { field: deployed_at, last: 90d }, per: week } }
  deploys_prev: { type: number, aggregation: { relation: '<-sw_deployment:service', fn: count, window: { field: deployed_at, last: 30d, offset: 30d } } }
  ```

  `fn` is `count`, `sum`, `avg`, `median`, `p90`, `min`, or `max`; `p90` is
  the ninetieth percentile by nearest rank. `where` filters the related
  entities with a search filter. `window` keeps those whose datetime field
  falls in the last so long; `offset` moves it back, so `last: 30d, offset:
  30d` is the thirty days before the last thirty, for a trend. `per` turns the
  count or sum into a rate per `day`, `week`, or `month` over the window's own
  span. An entity reached by two routes counts once.

  A mirror, an aggregation, and the status rollup reach only **active**
  entities. One its source no longer sees (missing) or that is gone
  (deleted) is not there: it is not counted, not mirrored, not stepped
  through to what lies beyond it, and lends no status. When it comes back,
  or goes, whatever read it is worked out again at once.
- A **calculation** is an expression over the entity's own fields, its `key`,
  and its `title`: `days_until(cert_expires)`, `ready / replicas * 100`,
  `'https://logs.example.org/?service=' + key`. A calculation may read
  another; the hub works each out after the ones it reads, wherever the
  fields sit in the blueprint. `hours_since(last_run_at)`
  counts whole hours, and `hour_now('America/Chicago')` (0 to 23) and
  `weekday_now('America/Chicago')` (1 for Monday to 7 for Sunday) read the
  time now in a zone, so a status can depend on the time of day. A value
  that reads the clock is computed again when anything it reads moves, and
  on the hour. It reads into an object
  too: `tags["pid"]`. `list(emails, aliases, author)` joins values into one
  list, leaving out empty ones and repeats, and `lower` lowers every member of
  a list. A relation rule matches a list on any of its members, so a person
  is found by every address and name they are known by. For a relation that
  holds one target, a list on the source side is in order of preference: the
  first member that finds anything decides. `before_last(key,
  '/')` cuts a path back to what holds it, such as the project a repository
  sits in, so `list(key, before_last(key, '/'))` lets a rule link a
  repository to the program that lists either its project or the repository
  itself.
- **History** keeps a derived `number` or `enum` over time. `history: {
  keep: 730d }` on a mirror, an aggregation, or a calculation makes the hub
  read the field of every entity on each lifecycle tick (every five minutes)
  and keep a point when the value moved since the entity's last one, so a
  value that holds still costs nothing. Points older than `keep` go, all but
  the newest of each entity, which says what the value was when the window
  opens. A field that stops keeping a history, a blueprint removed, and an
  entity purged take their points with them. Points are records, not
  entities: they never load with the estate. A written value is its writer's
  to keep, so a field a source or a person writes takes no history.
- A **trend from history** draws one: a `trend` field with `history: { of:
  <field>, every: 1w, last: 104w }` reads the history of a field of the same
  blueprint that keeps one, and is a point for each `every` counting back
  from now over the `last`, each the value held at the end of its span. An
  enum is drawn as steps of its values' places, with the values as labels. It
  is computed when the entity is read and kept with the blueprint's other
  derived values; a new point read again only what reads that blueprint. It
  reaches no farther back than the field keeps, and holds at most 400 points.

  ```yaml
  lead_time:       { type: number, aggregation: { relation: '<-deployment:service', fn: median, field: lead_time_hours, window: { field: deployed_at, last: 30d } }, history: { keep: 730d }, metric: true }
  lead_time_trend: { type: trend, history: { of: lead_time, every: 1w, last: 104w } }
  ```

- **Metric** exports a `number` or an `enum`: `metric: true` adds the field
  to the gauge `orrery.field.value`, one series per entity, labelled
  `blueprint`, `field`, and `key`, with an enum as its value's place among its
  values. It is read on each collection from the values the hub already keeps
  (see [Metrics](#metrics)). It is for dashboards and alerts on recent
  windows; the long view is a trend from history.
- A **pivot** gives each property of an `object` field a field of its own.
  Tick **pivot** on a field such as `tags` and the hub makes `tags_pid`,
  `tags_tier`, and one more for every property it meets on any entity, each a
  calculation that reads that property. A made field is a field like any
  other: a column, a filter, a group, a scorecard rule, and what a relation
  rule matches on, such as `target.pid == source.tags_pid`. Retitle or
  describe one and it keeps that. Hide the columns you do not want. A
  property that is itself an object can be pivoted again. Turn the pivot off
  and the made fields go. A blueprint in git lists such fields itself, as
  calculations.

Derived fields read each other, across entities: an organization can sum a
number its departments sum from their teams. A blueprint whose path names a
relation that does not exist is refused when it is saved.

**Filters** are what search, scorecard rules, and `where` share:

```yaml
{ field: tier, op: eq, value: critical }         # eq neq gt gte lt lte in contains prefix exists
{ field: last_push, op: within, value: 30d }     # a datetime in the last 30 days; `older` is the opposite
{ relation: team }                               # the relation is set
{ relation: team, target: 'team:platform' }      # set to this entity, named by id, key, or title
{ relation: '<-sw_workload:service' }            # something points here through that relation
{ relation: repository, where: { field: days_idle, op: gt, value: 90 } }               # reaches one that meets where
{ relation: repository, where: { ... }, every: true }                                  # reaches at least one, and every one meets it
{ not: { relation: team, where: { field: '$status', op: eq, value: red } } }           # reaches none that meets it
{ scorecard: secure, op: gte, value: Silver }    # the level reached on a scorecard; eq neq gt gte lt lte in exists
{ search: needle }                               # the key, the title, or the text of any field value, at any depth
{ and: [...] }  { or: [...] }  { not: {...} }
```

`gt`, `gte`, `lt`, and `lte` order numbers by size, before text, and text as
a person reads it, digit runs as numbers; a list or an object is neither above
nor below anything. A grid sorts the same way. `search` reads the key, the
title, and the text inside each field value the reader may see, never a field
name.

A relation's `where` is a filter read on the entities the relation reaches,
with their own fields, as the reader sees them: a query's source and the
grid offer it as "any", "every", or "no" Repository where those conditions
hold. A `where` that reads a field or a blueprint the reader may not see is
refused. A scorecard, an aggregation's `where`, and a case of an inherited
relation are worked out from the entity and its stored neighbours alone, so
they refuse one.

A scorecard level compares in that scorecard's own order, never by name, and
`none` sits below the first level. An entity outside the scorecard's scope
has no level, so it matches no level condition, `neq` and `lt` included;
`exists` asks whether it is in scope, and `not exists` finds what the scope
leaves out. A scorecard or a level that does not exist is refused, not
matched against nothing. Because aggregations take a filter, a program counts
what it owns at a level across any relation path:

```yaml
secure_silver: { type: number, aggregation: { relation: '<-resource:program', fn: count, where: { scorecard: secure, op: gte, value: Silver } } }
secure_scored: { type: number, aggregation: { relation: '<-resource:program', fn: count, where: { scorecard: secure, op: exists } } }
```

Divide one by the other in a calculation for the share at Silver or above:
the denominator counts only what the scorecard scores.

A field name means the blueprint's field. What the hub keeps about every
entity answers to `$key`, `$title`, `$icon`, `$blueprint`, `$state`, `$owner` (the
owning source), `$status`, `$createdAt`, `$updatedAt`, and `$lastSeenAt`, and
to the bare name when no field has it.

**Things that happened.** A deployment or an incident is not something a
snapshot keeps seeing: it happened once and the source forgets it. Push those
in an incremental run, which never marks anything missing, and let the
blueprint say how long to keep them:

```yaml
- id: sw_deployment
  lifecycle: { expire: { after: 180d, field: deployed_at } }
```

Past that age the hub tombstones the entity on its next lifecycle pass, and a
later push of the same thing is ignored. Without `field` the age counts from
when the hub first saw it. Windowed aggregations over such a blueprint give
deployment frequency, change failure rate, and the like.

**How long the deleted stay.** A deleted entity is kept as a tombstone, so one
that comes back keeps its notes and edits. The hub keeps it `TOMBSTONE_DAYS`;
a blueprint whose entities come and go sets its own time:

```yaml
- id: k8s_pod
  lifecycle: { keepDeleted: 1d }
```

The relations a source pushed from an entity it deleted are dropped on the
next lifecycle pass; a source that brings the entity back pushes them again.
What a person set stays with the tombstone.

**Inherited relations.** A relation can name a path to take its target from
while nothing sets it on the entity itself:

```yaml
relations:
  team:        { target: team, inherit: program.team }
  environment: { target: sw_environment, inherit: resource_group.environment }
```

Set a team on a program and every service in it is owned by that team; set
one on a single service and that wins there. Declare a subscription or a
cluster to be production and everything in it is; declare one resource group
or one namespace to be test and only that is. An inherited relation counts
everywhere a set one does: in filters, scorecards, and rollups. It shows as
`inherited`, and clearing what a person set brings it back.

Where the target depends on the entity, `inherit` takes ordered cases. Each
case may hold a `when` filter on the entity's own fields and relations, and
gives either a `path` to follow or one `target` entity by key, for a default
nothing above the entity holds. The first case the entity matches that
reaches a target gives it; a case whose path reaches nothing passes the
entity to the next:

```yaml
team:
  target: team
  inherit:
    - { when: { field: type, op: eq, value: backend }, path: program.backend_team }
    - { when: { field: type, op: eq, value: frontend }, path: program.frontend_team }
    - { path: program.software_team }
    - { target: platform-engineering }
```

A `when` cannot read a scorecard level, a neighbour, or who points at the
entity. A person's edit to a value a case reads moves the relation at once; a
pushed one moves it on the next re-link.

**Ownership.** People, teams, departments, and the organization are
blueprints like any other, which an estate brings in its own model. In the
example model ownership is a `team` relation on whatever is owned, set where
it is known and inherited beneath. An estate with several kinds of
responsibility gives each its own pair: a team whose job it is and a person
who answers, the person inheriting the team's lead (`docs/modelling.md`).

The hub's person setting says what a person owns: relation paths from their
entity, each optionally naming how what it reaches is theirs, such as
`{ as: qa, path: <-qa_owner }`. One thing can be theirs several ways. Now
leads with their things and groups them by these roles, and an entity page
says how it is the reader's.

**API specifications.** A field of type `openapi` holds an OpenAPI or Swagger
document, read in place on the entity page, or a link to where one is kept.
The page groups the operations by tag, says how each one signs in, and
writes a request for each, in curl and PowerShell, beside an example of its
response. When a push replaces the document, it says which operations were
added, removed, or changed. Each operation has a link of its own.
Creating an entity of a blueprint that has one offers "From a
specification": pick a JSON or YAML file and the title, description, version,
and base URL are filled in from it, ready to adjust.

**Trends.** A field of type `trend` holds a short series over time that
another system keeps the history of, or that the hub draws from a field it
keeps the history of (a trend from history, above): a list of points (`at`, `value`), and
how to draw them (`step` to hold each value until the next, `min`, `max`,
`labels` for named values, `unit`, the `from` and `to` the axis spans), with
a `link` to where the full history is. A grid draws it as a small line; a
press opens the chart with its words and the link, and the entity page draws
the chart. It holds at most 400 points, because it is a summary: the hub
keeps no history of it, and a source sends only the points where the value
changed, so a row is rewritten only when it moves. An aggregation (`max`,
`where` a pack) carries a trend from a record to the thing it is about.

**Ground.** A `number` field may carry a `budget`, the range your estate
wants it to stay in: `budget: { max: 15 }`, `{ min: 70 }`, or both. This is
not a load budget (see Budgets under Views): it holds nothing back and
raises no finding. It is what the ground view judges an entity by. A
blueprint has a ground when its `ground` says which of its fields mean
what. Every part is optional, and the hub ships none:

```yaml
repository:
  fields:
    pipeline_minutes:   { type: number, budget: { max: 15 }, history: { keep: 365d } }
    stuck_per_week:     { type: number, budget: { max: 5 } }
    copied_workarounds: { type: number, budget: { max: 2 } }
  ground:
    loop: pipeline_minutes        # a number: how long one round of work takes
    friction: stuck_per_week      # a number: how often work on it gets stuck
    unwanted: copied_workarounds  # a number: how much is there that should not be
    activity: commits_per_week    # a number: how busy it is
    foundations: [cluster, base_image, runtime]   # what it is built on, the deepest first
    guards: [protected_branch, signed_images]     # booleans: limits that hold or do not
    taughtBy: copied_from         # a relation to what its patterns were copied from
    template: { relation: started_from, version: template_version, current: version, action: new_repository }
    trial: on_trial               # a boolean: changes to the platform land here first
    ahead: [certificate_expires]  # datetimes the forecast reads
    trends: { stuck_per_week: stuck_past }        # a number's past, where no trend reads its history
```

`template` names a relation to one entity, the field here that holds the
version this one started at, the field on the template that holds the
version current now, and the action that starts a new one. A number's past
comes from a `trend` field that reads its kept history, or from the trend
`trends` names for it; without a past, the forecast and the weeks leave
that number out. The model editor's **Ground** tab sets all of it, and a
number property's form sets its budget, for whoever the preview is open to.

**Renaming a blueprint** in the model editor takes its entities with it,
along with what people typed on them, relations in both directions, history,
rules, scorecards, and every path in another blueprint that names it.

**Several sources, one field.** Any source registered for a blueprint may
write any of its fields. When one overwrites a value another source wrote,
the value is accepted, a warning is logged, and a finding says which source
overwrote which, so the field can be given to one of them.

## Views

- **Catalog.** Where the app opens. One wide table per blueprint: properties, relations in both
  directions, scorecard levels and each rule, with filter, group, and column
  controls. Column visibility, order, and width are shared by everyone. Every
  table opens in the order of the estate's **column standard** (see Column
  standard below), and a table keeps only what someone changed by hand on top
  of it: a column moved, hidden, shown, or widened. So
  is the filter a table opens with: build it in the filter panel and make it
  the default, with the `views.arrange` permission. A condition can read any
  property or relation column: a relation picks one of the targets the rows
  hold, such as an environment, so a table can open on Prod alone. A reader who
  may not see a condition's field or relation target is not shown it. So is the sort: sort a
  column, then pick "Make this sort the default for everyone" from its menu.
  Anyone can change either for themselves, and the default is back when the
  page loads again. The table is edited in place: click a value to change it, click a row's icon to
  pick another, click a relation to find its target by name. Tick rows, or a
  whole group, to give them an icon, set one value, or hide them all at once.
  A row opens beside the table without leaving it.
- **Favorites.** A person stars what they come back to: a row's star in any
  table, **Star** on a thing's page, or **Star** from a row's menu. What
  they starred comes first in every table of its kind they open, whatever
  the sort, and first inside each group; the filter still decides what
  shows. **Favorites** in the menu lists every starred thing of every kind
  as one table, each kind's fields and relations a column. A star on a
  blueprint, beside its name on its table, puts it under **Starred** at the
  top of the catalog's list. Stars are a person's own, on every device:
  they write no activity row, a machine has none, and there is no limit to
  how many. A star to something the person may no longer see is kept,
  never shown or counted, and shows again when they may; it goes only when
  the hub purges what it names. A query, an export, a schedule, and a
  report never read stars, so what they hand on reads the same for
  everyone (ADR-5007).
- **Model.** The data model as a graph, left to right: blueprints as cards,
  relations as lines, a loop for a relation to itself, and a dotted line
  where two shown blueprints meet only through hidden ones. Each card names
  the sources that feed it, and opens to show its properties, each with its
  kind, and its relations, each with its target. The card open in the editor
  wears an orange ring, and the blueprints one line away from it stay lit
  while the rest step back. Architects drag cards into place and choose which
  blueprints show; the arrangement is shared. One field or relation is
  changed on its card: open the fields, click a row to edit or delete it, or
  add one at the card's foot, and it saves at once. Dragging from one card to
  another adds a relation the same way. The rest of a blueprint is edited in
  a side panel, in tabs: details, properties, relations, lifecycle, access,
  and the same blueprint as YAML. Clicking a blueprint in the sidebar flies to its card; its table
  opens in a drawer over the graph. `/model?focus=<id>` opens the model on one
  blueprint, which is where a catalog's **Model** button goes.
- **Entity page.** Fields with provenance badges, relations both ways,
  status, timeline, notes, deep links out. There is no edit mode: click the
  title, the icon, a value, or a relation to change it. Enter or a click
  elsewhere keeps the change, Escape drops it, and an override has a way back
  to the pushed value. What points here is one row per reverse title: every
  blueprint whose `owner` reads "Owns" lands in one Owns row, split by kind.
  In a grid, columns that share a reverse title also name their blueprint.
- **Scorecards**: where entities stand on the ladder, how many pass each
  rule, the last 30 days, and every entity against every rule.
- **Blueprints** with a YAML editor for whoever holds `model.edit`.
- **Activity**, **Sources** (registration, tokens, runs), and **Access**
  (people and roles), each shown to whoever holds its permission.
- **Load.** What the hub spends its time on, and for whom, over the last
  hour, day, or week. It opens with a verdict: what is past or near a
  budget, where most of the time goes, and the hub's time hour by hour in
  three areas: taking in (sources writing), working out (deriving and grid
  shapes), and answering (API calls). Under it, **Needs a look** lists
  each source, caller, or blueprint worth a look, worst first: past a
  limit, past a warning, near one (four fifths of the way), or costing
  more than it needs to where no budget counts it (sending what did not
  change, changing all it sends, heavy or slow answers, one change
  rippling into many derives, costly rows, a grid built again often, a
  chip that shows little, a derive backlog). Each opens to what is seen,
  why it costs, and what can be done, and to its budget for whoever may set
  one. Then each area with
  the names that cost it most, and every list in full, folded. It is shown
  to whoever holds `audit.view`, and `GET /v1/load` answers the same, with
  the window's hours. Every hub on the database adds to the same hourly
  rows, which are kept for `LOAD_DAYS`. A grid's build says how much of it
  went to the spread of values under the grid, and over how many columns.
  **Columns: counts** lists every field a grid may count as last measured:
  its rows, its values, how many are different, and the share the spread
  draws as buckets of its own. A count over values that rarely repeat costs
  more than it shows, and a column not counted whose few values repeat could
  be. Whether a value is drawn as a chip has no part in it. A person who may
  change the model opens the field from there. The leader measures each
  blueprint every few hours on the lifecycle tick.
  **Blueprints: favorites** lists what people's stars cost each kind's
  grids: the stars it holds now and how many people keep them, the grid
  reads put in a reader's stars order, the starred rows each marked, and the
  stars' own time per read. A read by someone who starred nothing there
  costs what it did before stars.
- **Budgets**, set on the Load page by whoever holds `budgets.set`, hold
  the hub's load to numbers you choose. The hub ships none. Each budget has
  a warning, a limit, or both, for one name or for `*`, every name with no
  budget of its own:

  | Budget | Counts | Past the limit |
  | --- | --- | --- |
  | Source changes | Entities a source changes in an hour | Its writes answer `429` with `Retry-After` until the hour turns |
  | Caller calls | API calls a caller makes in an hour | A token's calls answer `429` until the hour turns; a person is never refused |
  | Blueprint entities | Entities a blueprint holds | A new entity of it is refused, with the reason; what it holds is still changed |
  | Blueprint reads | Entities one row of a blueprint reads, on average | Nothing is refused: both numbers raise a finding |

  Past its warning a budget raises an **Over budget** finding, amber, and
  red past its limit; an hourly budget is judged by the fullest hour of the
  last day. The Load page shows each count beside its budget. The budget
  for every source does not hold the web app's edits or the hub's own
  writes. A limit is held to within half a minute of traffic, since each
  hub stores its counts once a minute. `GET` and `PUT /v1/budgets` read and
  set them all at once, and an agent does the same with `get_budgets` and
  `set_budgets`, beside `get_load` for what the Load page shows. Set them
  from what the Load page shows: a warning a
  little above a normal busy hour, a limit where the hub would start to
  suffer.
- **Ground.** In preview: an admin opens it on the Access page, and until
  then it is there for nobody. Where the catalog is the sky, the ground is
  what lies under it, drawn as an atlas you walk down one grain a level:
  the sky of programs, a planet, a continent, a garden, and each kind's own
  ground. `docs/ground.md` is its guide: what every mark means on every
  level. Every level fills the window. The picture is the stage; a panel
  beside it holds the verdict, one bar with its three counts, one ranked
  list, and what the reader can do, and it explains nothing. The key sits
  small in a corner of the picture, in the picture's own marks, with a
  **?** that opens the whole key and replays a three-step first visit. A
  hover card reads a mark aloud, a click peeks it at the head of the panel,
  and the lens at the picture's upper left makes a level ask about one
  check alone. The sky is a chart of health: each program as far from the
  sun as its share of broken checks, in bands as wide as their bodies need;
  the model's `map.primary` says which are drawn large and named, and
  `map.sector` what groups them round the circle. A planet shows where:
  each continent a place, each cell a garden (a service running there) or
  a patch of its open ground, painted by its broken checks, with what is
  tied to no place, a service's own checks among it, on the workshop's
  bench. The continents and the workshop add up to the planet's total,
  each check once. A continent is a meadow, one flower a garden, its
  petals the ladders its checks climb (a scorecard's levels), with the walk
  under it: the climbs that mend the most, which a person keeps as their
  own; a garden is a plate of specimens, one flower a thing. A kind's ground is an
  archipelago, one cell an entity, read through one budget at a time.
  Ticking is apart from the click: a tick box stands only on a thing the
  reader may run an action on, and the tray that runs one action on
  everything ticked shows only then. On the front page a kind that has a
  ground carries an arc as long as its share inside every budget, and
  choosing it lands there. `GET /v1/ground`, `/v1/ground/<blueprint>`,
  `/v1/ground/<blueprint>/<key>`, `/v1/map`, and
  `/v1/map/<blueprint>/<key>` answer the same in plain words, for what
  the caller may see.
- **Status.** Every entity of a blueprint marked `wall: true`, plus runners
  and sources, each reduced to one colour. A blueprint can roll its status up
  from everything that points at it.
- **Search.** One box that finds entities of every blueprint you can see,
  by name, key, or value. On a desk it is **Find anything** at the right
  end of the strip above every page, or ⌘K.
- **The side bar.** Zen mode and the light theme sit at its top, beside
  the button that folds it. Now, Favorites (once you star something), Self-service,
  and Reports are its rows. Ground, Scorecards, and Model are one row of
  tiles under them. The catalog's kinds fill the rest. At its foot, your
  name opens your menu, and **Hub** opens every page that runs the hub: Query, Status, Activity,
  Load, Sources, Access, and Security, each shown to whoever may open it.
- **Your trail.** Every page shows Back and Forward and the places that
  led to it, each one click back, so the installed app, which has no
  browser bar, still says where you are and how you got there. The places
  start where you last picked a page from the menu or jumped with the
  command bar: Self-service › Schedules › a schedule › its batch. Back
  goes up that path one place and stops where it starts; the browser's own
  Back, a mouse's back button, and a swipe still go to the page you were
  just on. Recent lists every page you opened in the tab. Going back finds a page as it was left: its
  filter, search, tab, and scroll. A reload or a new visit starts clean.
- **On a phone.** The pages sit in a tab bar at the bottom: Now, Catalog,
  Search, Self-service, and More. The catalog starts at the list of blueprints; a
  blueprint's rows are cards that show the first values of the shared column
  order, or a table whose titles stay put while a flick scrolls through its
  columns, where a tap on a value changes it. A record opened from the list swipes to the next
  one, and Back returns to the list as it was left. The model is walked one
  blueprint at a time: what it is joined to sits in a ring around it, and a
  tap walks there. A record shows the same ring. Menus, editors, and panels
  rise from the bottom of the screen.

### Queries

The catalog grid reads one blueprint a page at a time, as a person scrolls,
and is how most people work. The **Query** page reads the catalog whole and
lets you explore it. Several queries stay open at once, one tab each.

- **The query** is one line of chips. Each blueprint it reads is a chip in
  its own colour, with how many rows it matched; open one for its conditions,
  a search, and which states to read. A condition on a relation can test what
  the relation reaches: a service whose repository is idle over 90 days, or a
  repository with no team. Beside the blueprints, **Where** conditions test
  the answer's own columns, across every blueprint. **Text** shows the same
  query as a pipe language a Kusto reader knows, and reads it back:

  ```text
  from Repository
    | where $status != "green" and days_idle > 90
  from Service
  columns title, $status, language, r:team.department@name
  where language in ("Go", "C#")
  sort by days_idle desc
  group by language
  total open_alerts sum
  ```

- **Fields** stand beside the answer: each column's values, counted live
  over the rows every other condition keeps. Press a value to keep only its
  rows; hold Control, Command, or Option to leave them out. A number or a time
  shows how it spreads, and narrows by a lowest and a highest.
- **Columns** says, for each blueprint, what fills each column: a field, a
  relation, one of the columns every entity has (type, title, key, status,
  state, source, last seen, last update), or nothing. So one column can read
  a service's open alerts and a repository's Dependabot alerts side by side.
  **Follow a relation** reads a column along relations: the team that owns a
  repository, that team's department, or a field there, such as the
  department's cost centre. Each hop reads only what you may see.
- **The answer** is every row that matched, up to 50,000, as a grid or a
  chart. A column's header sorts it, groups by it, adds it up (rows, rows
  with a value, different values, sum, average, lowest, highest), moves it,
  or removes it; drag its edge to widen it. A cell keeps only its value,
  leaves it out, or groups by it. A group folds, and shows its count and what
  each column adds up to; the foot adds up every row kept. A row opens in
  place to show everything it holds. The chart draws a bar for each value of
  one column, as long as the rows it stands for or a total over a number
  column (the sum of a cost by type, say), longest first, and splits each bar
  by another column or by blueprint. It starts on what the query groups by
  and adds up, and what you pick is saved with the query. The arrow keys move through the cells,
  Enter opens one, and Space opens a row. Its titles stay put while the other
  columns scroll sideways. The conditions on columns, the order, the groups,
  the totals, and the widths are kept with the query. **Export to Excel**
  writes the rows the answer keeps, in its order, and a sheet for each
  blueprint when it reads more than one; a schedule and an agent take the
  same rows. **Run on all** opens any action that runs on many of a
  blueprint read, on every row of it the answer keeps, as one batch.
- **Save** keeps the query in your library. **Share** says where it belongs
  and who else may open it. Its home is one entity of any blueprint, such as
  a program or a team, as an action's is: the library lists each home's
  queries together, and the home's page lists them under **Queries**. Who
  may open it: only you, the people who own its home, an audience of the
  access policy that you are in, or everyone. Only someone who owns the
  home, or an admin, opens a query to its people. You can only see and share
  to audiences you are in. Everyone means every person who signs in, and
  every agent with an access token.
  Whoever opens it reads it with their own access, so two people may get
  different answers: a blueprint or a column of a field they may not see is
  left out. Only
  the owner and the admins change or remove a saved query; anyone who may
  open it can copy it to their own library. The bin beside a query in
  **Queries** removes it, after saying who else loses it.

**Action runs** is a source too: the runs a reader may see, with columns of
their own, such as the action, who asked, the state, and how long each took.

Running a query only reads, so an admin viewing the hub as someone runs any
of their queries as them and sees exactly what they would. Every row and
column is read through the reader's own view. `POST /v1/query` runs one,
`POST /v1/query/export` exports one, `/v1/queries` keeps them,
`/v1/queries?home=<blueprint:key>` lists one home's collection,
`/v1/queries/audiences` lists the audiences the caller may share with, and
`/v1/queries/{id}/run` and `/v1/queries/{id}/export` run a saved one by its
id. `POST /v1/query` and `/v1/queries/{id}/run` take `?shaped=true` for a
caller that does not shape the answer itself: the hub then answers as the
query's view shows it, with the rows the view keeps, in its order, up to
`limit` (200, at most 2000), and its groups and totals. Agents call
`run_query`, whose columns may name a field per blueprint and which answers
in that same shape.

### Column standard

One standard orders the columns of every table, so the first few columns
answer the same questions on every blueprint. It is a list of ranks, first to
last, each a list of column patterns, and a list of patterns hidden until
someone shows them. A column takes the first rank with a pattern that names
it, sits in that pattern's order, then the blueprint's own. A pattern is a
column id with `*` for any run of characters: `title`, `f:cost_*_cents`,
`r:program`, `i:*` (what points here), `s:*` (scorecard levels), `u:*`
(scorecard rules), `a:*` (actions), and the record columns `key`, `state`,
`owner` (the source), `lastSeenAt`, and `updatedAt`. `@pivot` names an object
field pivoted into columns and `@pivoted` a column a pivot made. The rank
holding `*` takes every column no pattern names. A hidden pattern starting
`!` shows what an earlier one hid. `widths` sets the width a column opens at, by
pattern, the first that names it winning: `f:portal: 44` makes a link column
as wide as its icon, and a column that narrow is headed by its icon alone,
its name on hover.

```yaml
config:
  columns:
    ranks:
      - { id: identity, columns: [status, title] }
      - { id: ownership, columns: [r:program, r:owner] }
      - { id: detail, columns: ['*'] }
      - { id: record, columns: [key, state, owner, lastSeenAt, updatedAt] }
    hidden: ['@pivot']
    widths: { f:portal: 44 }
```

A catalog file in a git source declares it under `config.columns` and owns it
while it does; otherwise whoever holds `views.arrange` changes it with
`PUT /v1/grid-standard`. A hub with none opens tables as it always has: title
first, fields, relations, scorecards, actions, then the record columns.

A person's change to one table is kept on top of the standard and survives
every change to it. A moved column is kept as the column it now follows, so
everything around it still follows the standard; "Back to the standard place"
in its menu lets go, and "Back to the standard width" does the same for a
width. A hide or a show is kept only where it differs from what
the standard says. A table arranged before the standard keeps its whole saved
order, every column pinned where it was, until it is put on the standard by
saving it with `arranged: standard` and only the changes worth keeping.
`GET /v1/grid/<blueprint>` returns `arranged: standard` and only the hand
changes for a table on the standard.

### Relation conventions

A convention names relations every blueprint of some groups carries, such as
the pair that says who owns a thing at the platform layer:

```yaml
config:
  conventions:
    - id: platform
      title: Platform owner
      groups: [Cloud, Identity]
      relations: [platform_team, platform_owner]
```

A blueprint in one of those groups that lacks one of the relations is an
`unmet_convention` finding, so a kind a pusher brings later is caught the day
it arrives. A convention only checks: the hub never adds the relation, and a
blueprint moved to another group changes what is checked, never what it
holds. A catalog file in a git source declares them under `config.conventions`
and owns them while it does; otherwise whoever holds `model.edit` changes them
with `PUT /v1/conventions`.

## Agents

The read surface is built for them. REST (`/v1/openapi.json`) and an MCP
server at `/mcp` expose the same tools: `who_am_i`, `modelling_guide`, `describe_model`,
`estate_summary`, `search_entities`, `run_query`, `get_entity`, `traverse`, `get_status`,
`list_findings`, `get_changes`, `get_scorecard`, `list_actions`,
`run_action`, `get_action_run`, `get_report`, `check_report_layout`, `list_datasets`,
`get_load`, `get_budgets`, and `set_budgets`. A caller the ground preview is open to is also given
`get_ground`.

An agent changes the model as the person it answers for, the way the model
page does: `get_model_definition` reads a blueprint, a relation rule, a
scorecard, or an alert rule exactly as it is defined; `edit_model` lays a
change over it (JSON Merge Patch: an object merges, `null` removes, anything
else replaces); `delete_from_model` and `rename_blueprint` do the rest. Over
HTTP the same changes are `PUT` (whole) and `PATCH` (the merge) on
`/v1/blueprints/{id}`, `/v1/rules/{id}`, `/v1/scorecards/{id}`, and
`/v1/alert-rules/{id}`, and `GET /v1/model/export` reads the whole model in
the YAML `/v1/model/import` takes. Every one of them runs through
`src/server/model-edit.ts`, the code the model page's saves run through,
needs `model.edit`, and is recorded under the caller.

The `notes` field on every blueprint is the estate's memory:
why this exists, what breaks if it goes.

Every answer is small however large the estate grows, because an agent reads
every answer into its model. A list is a page with its total. A thing in a
list is a card: its first small values within a fixed size, the names of the
rest, and each relation as a count with its first few links. One thing shows each way it is linked as a count and the first ten.
A value too big to show is said instead. Wherever an answer leaves something
out, it names, as `more`, the exact tool call that reads the rest. The server
tells every agent the order to climb in as it connects, and never to ask a
person for a blueprint, a field, or a filter: orient
(`estate_summary`, `describe_model`), find (`search_entities` with `q`, the
person's own words, which searches every kind and says how many of each
matched, then a blueprint, a filter, a sort, and fields), read one (`get_entity`), go deeper through `more`, and
count, sort, or group with `run_query` rather than paging through
everything. `get_status` and `list_findings` count first and list one
blueprint or kind on request; `list_actions` lists the actions briefly and
reads one in full. `orrery.agent.answer.size` records how big each answer
was, by tool.

Agents authenticate with a bearer token on the ingest host. There are two
kinds:

- A **personal key** acts as the person who made it. Anyone who signs in
  makes their own from their name in the top bar, **API keys**, and can
  rotate or delete it there. An agent holding one sees only what that person
  sees, may do what their roles allow, and what it changes is recorded as
  theirs. A personal key cannot make, rotate, or delete keys.
- An **access token** is for a machine. It is bound to a role, reads
  everything, and may do what its role allows. It is issued on the Sources
  page.

```
ORRERY_URL=https://orrery-ingest.example.org/mcp   Authorization: Bearer orr_usr_…
```

An agent needs only the ingest host and a token. The ingest host's root
redirects to `/v1/openapi.json`, which needs no token, names the ingest host
as its server, and says in its description where the token goes and which
calls to make first. A request without a working token is answered with `401`
and a `docs` pointer to the same spec.

Every REST path is versioned under `/v1`: `/v1/entities` reads the catalog
and `/v1/ingest/runs` takes a source's push.

### The agent plugin

This repository is also a Claude Code plugin: the MCP server, and three
skills that teach an agent to work with any Orrery. `orrery-catalog` reads
the catalog before anything else; `orrery-model` puts something in the
catalog on the shared names, read live from the hub's `modelling_guide`;
`orrery-describe` writes the `orrery.yaml` a forge reader reads to put a
repository's service, its logo, and its APIs in the catalog.

```bash
claude plugin marketplace add <path or URL of this repository>
claude plugin install orrery@orrery
```

Every release also publishes the plugin on its own, as a zip pushed to the
public package `ghcr.io/orchard-suite/orrery:plugin-<version>` (an OCI artifact,
signed like the images). An estate that must not point its marketplace at
this repository pulls the zip with `oras pull`, hosts it where its own
people fetch from, and lists it as an `archive` source pinned by `sha256`;
the zip's sha256 is the artifact's single layer digest. The zip holds the
plugin alone: the manifest, the skills, the MCP wiring, and the one script
the wiring calls.

It needs the hub and your personal key:

- `ORRERY_MCP_URL`, the hub's ingest host such as
  `https://orrery-ingest.example.org`, set in the shell or in Claude Code's
  `env` settings (per project when projects use different hubs). The name
  differs from an app's `ORRERY_URL` on purpose, so an app run from the same
  shell never writes to a hub as a person.
- The personal key, the plugin's `personal_key` setting. Make one on the hub
  from the menu under your name in the top bar, API keys. Claude Code asks for it when you turn the plugin on from
  `/plugin`; to set or change it later, run
  `/plugin configure orrery@<marketplace>` in Claude Code. It is kept in the
  system's secure store (the macOS keychain), never in a settings file. From
  a script, pipe it in: `claude plugin configure orrery@<marketplace>
  --values-stdin` reads `{"personal_key": "..."}`.

With no key set, the plugin uses the hub's line in `~/.config/orrery/tokens`
(or the file `ORRERY_TOKENS_FILE` names), the sign-in the command line keeps:
one line per hub, its ingest host and a command that prints a personal key,
usually a vault read. Name the vault's subscription in the command, so the
read does not depend on the CLI's current default. A key that is set wins
over the file.

```
https://orrery-ingest.example.org  az keyvault secret show --subscription Ops --vault-name ops -n orrery-key --query value -o tsv
```

When neither gives a key, the hub answers 401 and the server fails to
connect. Set the key, or run the file's command by hand to see the real
error.

An estate with more than one hub, or with rules of its own for the catalog,
writes them in `~/.toolkit/config/orrery.md` on the machines its agents work
from: what each hub is for, where it answers, and where its key is kept. The
`orrery-catalog` skill reads that file first, so the plugin itself names no
hub. The MCP server is the one hub at `ORRERY_MCP_URL`; an agent reads any
other hub the file names through its REST API, with that hub's line in the
tokens file.

## Command line

`orrery` is a third door for a person, beside the web app and the agent
tools, for the times a command is easier: a script, a terminal, an agent
with a shell. It holds no rule of its own. Every command is one call to the
same API the web app makes, as the person signed in, so the hub decides what
they see, what they may run, and what a run needs, and every run is the same
row with the same log and the same activity. A new action or blueprint needs
no new release of it.

```bash
orrery login --hub https://orrery-ingest.example.org   # once: asks for a personal key, keeps it in the keychain
orrery actions                                         # what you may run
orrery actions --entity service:checkout               # what you may run on one entity
orrery action restart-app                              # what it does and the inputs it takes
orrery run restart-app --entity service:checkout --input why="stuck after deploy"
orrery get service:checkout                            # one entity
orrery search checkout --blueprint service --fields tier,language
orrery queries && orrery query <id>                    # a saved query, shaped as its page shows it
orrery help run                                        # every command explains itself
```

Output is a table for reading and `-o json` for a script: the hub's own
answer, unchanged. `orrery run` follows the run to its end and prints each
log line under its step, then the state, the summary, the steps, the
outputs, and the link. It exits 0 when the run succeeded, 1 when the hub
refused it or the run failed, was declined, cancelled, or sent back, and 2
when it was still going at `--timeout` (30 minutes unless given); `orrery
watch <run-id>` picks it up again. An input is `--input name=value`, sent as
text, which the hub reads as the input's own type; `name:=<json>` sends JSON
as it is, and a name given more than once is a list.

The agent plugin reads this sign-in too when its own key is not set:
`orrery login` writes the hub's line in `~/.config/orrery/tokens` (see The
agent plugin, above). With no more said it asks for a personal key without
showing it and keeps it where the system keeps secrets: the macOS keychain,
the Secret Service where `secret-tool` is installed, and otherwise a file
only the person can read. With `--command` it keeps no key and remembers a
command that prints a token, such as a vault read. A hub with
`AUTH_API_SCOPE` set also takes its issuer's access token for the person
(`GET /v1/sign-in` names the issuer and the scope), so a command that prints
one signs a person in with no key at all; an action that calls another
system as the person (`onBehalf`) needs that sign-in, since the hub cannot
trade a personal key for their token. The hub is asked who the token is
before anything is kept, a machine's token is refused, and a key is never
printed.

An action whose answer is revealed once (`finish: reveal`) writes it to the
terminal itself and nowhere else: never to standard output, a pipe, a file,
or `-o json`. With no terminal, such as inside an agent's shell, the run is
not asked for.

Which hub a command speaks to: `--hub`, else `ORRERY_MCP_URL`, else the first
hub signed in to. A script that carries a token of its own sets
`ORRERY_MCP_URL` and `ORRERY_TOKEN`.

Build it from a checkout with `go build -ldflags "-X main.version=<version>"
-o orrery ./cmd/orrery`, or take it from the `orrery-cli` image of a release.

Every release also publishes it for people's computers, as one signed OCI
artifact in the hub's public package, `ghcr.io/orchard-suite/orrery:cli-<version>`:
`orrery-darwin-arm64`, `orrery-linux-amd64`, and their `SHA256SUMS`, one
layer a file. An estate verifies the signature with `cosign verify`, pulls the
files with `oras pull`, checks each against `SHA256SUMS`, and serves them from
where its own people fetch.

## Pushers

A Go module holds the shared machinery. A pusher only fetches and shapes:

```go
client, _ := sdk.FromEnv()
client.Snapshot(ctx, "cluster-a", func(add func(sdk.Entity) error) error {
    for _, ns := range namespaces {
        add(sdk.Entity{Blueprint: "k8s_namespace", Key: "cluster-a/" + ns.Name, Title: ns.Name, // Icon: "folder" gives one entity its own
            Fields: map[string]any{"name": ns.Name}, Relations: map[string]any{"cluster": "cluster-a"}})
    }
    return nil
})
```

Things that only accumulate go in an incremental run under a scope of their
own, so the snapshot never marks them missing:

```go
client.Incremental(ctx, "cluster-a/deployments", func(add func(sdk.Entity) error) error { ... })
```

A run costs what changed, however much it names. A pusher sends everything it
sees on every run and keeps nothing between runs; the SDK names each entity
first by its digest (`sdk.Digest`, a fingerprint of what is sent of it), and
the hub takes each such sighting as the full write it names while that still
stands: the entity is active, nothing changed it since, and its blueprint was
not saved since. Nothing of it is read. The rest come back as `wanted`, and
the SDK sends them in full in the same run. A sender that is not the SDK does
the same over the API: a hub that takes sightings answers `sightings: true`
when a run opens, keeps the `digest` a full write comes with, and takes an
item of `blueprint`, `key`, and `digest` alone as a sighting.

A pusher carries the blueprints it writes and offers them before its first
run:

```go
model, _ := sdk.ParseCatalog(blueprintsYAML) // go:embed blueprints.yaml
client.OfferBlueprints(ctx, model.Blueprints)
```

`cmd/runner` runs health checks from one network segment. `cmd/pusher-k8s`
pushes a cluster (nodes, namespaces, workloads, pods, services, ingresses,
Gateway API gateways and HTTP routes, network policies including Cilium's, volume claims with the nodes holding
their Longhorn replicas, ArgoCD applications) as one snapshot, and ArgoCD's sync history as
`sw_deployment` entities in an incremental run; run it as a CronJob. A run
of a job is a fact about the job, not an entity: a pod a Job owns is never
pushed as `k8s_pod`. A CronJob's workload carries its run record from the
Jobs the cluster still holds: the last run's status, start, finish, and
length, when it last succeeded and last failed and why, how many runs are
going now, and two trends, run times and results. Its health is red when the
newest finished run failed, grey when suspended, and green otherwise. A Job no
CronJob owns is a workload of kind `Job` with the record of its one run. A
job's workload runs on the nodes its pods run on now, and the volumes its
pods mount name it. Its
blueprints are in `cmd/pusher-k8s/blueprints.yaml`. An ingress annotated
`orrery/icon: <name>`, or a gateway or HTTP route annotated so, is drawn with that icon of the hub's set, such as
`gitlab`; an icon a person picks in the hub stays over it.

`cmd/pusher-entra` pushes one Entra tenant, one snapshot per run: each
enabled enterprise app the tenant owns or an admin added, with a web sign-in,
as `entra_app` (whether anyone in the tenant may sign in or only those
assigned, the roles people may be given, and where a person opens it); each
assignment of a user or a group to one, and in which role, as
`entra_app_role_assignment`; the groups assigned, with their direct members,
as `entra_group`; and those users as `entra_user`. An app lists who holds it,
and a user which apps they hold. It reads Microsoft Graph as a workload
identity (`AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_FEDERATED_TOKEN_FILE`)
holding Graph's `Application.Read.All`, `User.Read.All`, and
`GroupMember.Read.All`, never with a secret, and uploads an app's Entra logo,
when it is a PNG or WebP, as the custom icon `entra_<app id without dashes>`.
It also puts each user's photo on the hub as their picture, under their mail
or else their sign-in name, cropped square at 64 and 256 pixels: reading
photos needs `ProfilePhoto.Read.All`, which `User.Read.All` already covers.
It puts only a photo that changed, removes one only once Graph says the user
has none or the user is no longer pushed, and, when Graph refuses the read,
warns once and changes no photo. A photo that fails never fails the push.
`ENTRA_PHOTOS=false` turns photos off.
`ENTRA_REQUESTS` (`consent`, `packages`) also pushes the requests Entra holds
waiting (admin consent, access packages) as pending `it_approval`, in a
snapshot of their own, so one decided in Entra leaves the next push.
`DRY_RUN=1` reads once and prints the entities with no hub. Its blueprints
are in `cmd/pusher-entra/blueprints.yaml`; the link from a user to the core
`person` is offered on its own from `person.yaml`, and a hub without `person`
refuses only that.

`cmd/entra-grant` gives a person access in Entra for a self-service action a
runner carries out: it assigns a user a role on an app, or adds a user to a
group, and closes the `it_approval` it was asked for. The
`orrery-access-runner` image is the runner with it. `docs/actions.md`
(Granting access in Entra) has the actions and the permissions it needs.

`cmd/azure-restart` restarts an Azure web app, function app, slot, or virtual
machine for a self-service action a runner carries out, signed in as its
workload identity to whichever tenant holds the resource. The
`orrery-azure-runner` image is the runner with it. `docs/actions.md`
(Restarting Azure resources) has the one role it needs.

`cmd/azure-job-start` starts an Azure Container Apps job, such as a pusher
on a schedule, for a self-service action a runner carries out, and follows
the execution until it ends. The same `orrery-azure-runner` image carries
it. `docs/actions.md` (Starting Azure Container Apps jobs) has the role it
needs.

`cmd/job-starter` starts one container for each run of a `job` action: a
Kubernetes Job, or an execution of an Azure Container Apps job, from a
template the estate owns. It claims a run the moment it is approved, says
while the job runs that it does, and reports how the container ended, so
long work and work that waits for a person is never held by whoever asked.
It keeps no state, and holds one right on its platform: start a job, see
it, and stop it. One action serves many templates, each with an identity of
its own, when a locked field of the entity the run is on names which: the
hub works the name out, and nobody who may run the action chooses it. The
`orrery-job-starter` image holds it and nothing else.
`docs/actions.md` (One container for each run) has its config and the role
each platform needs.

`cmd/telemetry-query` reads log lines from Loki and series from Prometheus
for a tool a runner carries out, so an agent is lent "read the logs" and
"read a metric" without holding a key. It only reads. The
`orrery-telemetry-runner` image is the runner with it. `docs/actions.md`
(Reading logs and metrics) has its two commands and a tool for each.

`cmd/orrery` is the command line. Its machine commands are for shell jobs
and hooks, with a source token (a person's commands are under Command line,
above); `push` offers the blueprints in the file, then writes its entities:

```bash
orrery push catalog.yaml --scope offices
orrery patch system billing --field tier=critical
orrery delete k8s_workload cluster-a/old/thing
```

When one pusher replaces another, hand the old source's entities to the new
one before you retire it. The new source takes their ownership, their pushed
fields, and their relations, and with `scope` they move into the scope it
snapshots, so its next run keeps what it still sees and deletes the rest:

```bash
curl -X POST https://orrery.example.com/v1/sources/old-pusher/hand-over \
  -d '{"to": "new-pusher", "scope": "azure/all"}'
```

The new source must be registered for every blueprint the old one owns. Then
the old source owns nothing and can be removed.

When a list a pusher copied in becomes one people keep in the catalog, hand
its entities to the web app instead, with `"to": "ui"`. Each entity is then
people's: what the source said of it and the links it wrote stand as typed
by whoever handed them, a value a person had set over the source's stays,
and what other sources say of it is still theirs. Nothing is deleted, and
the source can be removed. An entity the source had stopped seeing comes
back as active: no run sights what people keep, so the hub never leaves one
of theirs missing, and its periodic pass brings back any it finds.

When a pusher starts to push what people typed in first, give it those
entities by name. It takes their ownership, and with `scope` they move into
the scope it snapshots; what people set on them stays theirs. This matters
where access is decided from a blueprint, such as people and teams: only the
source that owns such an entity may write to it.

```bash
curl -X POST https://orrery.example.com/v1/sources/entra-pusher/adopt \
  -d '{"entities": [{"blueprint": "person", "key": "someone@example.org"}], "scope": "entra/employees"}'
```

## Run it

```bash
docker run -d --name orrery-pg -p 5433:5432 -e POSTGRES_PASSWORD=orrery -e POSTGRES_USER=orrery -e POSTGRES_DB=orrery postgres:17-alpine
npm install
npm run dev     # hub on :8080 (UI) and :8081 (ingest), web on :5173
```

Locally `AUTH_MODE=none` makes every browser an admin. Register a source and
issue it a token from the Sources page, then point a pusher at
`http://localhost:8081`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | Session surface: browsers, behind the login proxy |
| `INGEST_PORT` | `8081` | Machine surface: pushers, runners, agents, bearer tokens only |
| `ROLE` | `all` | `all` serves and runs the background work. `api` only serves. `worker` runs the background work and takes no traffic. See **Running it** |
| `DATABASE_URL` | local dev Postgres | Postgres connection string |
| `DATABASE_POOL_MAX` | `10` | Postgres connections the hub holds at most. Two hubs serve during a rollout, each with this many |
| `DATABASE_STATEMENT_SECONDS` | `60` | Seconds one statement may run before Postgres ends it. Migrations are not bound by it |
| `DERIVE_EVERY_SECONDS` | `2` | How often the leader derives and stores what writers queued |
| `DERIVE_CLOCK_SECONDS` | `60` | How often the hub looks for stored rows whose values have reached the moment they change with the time (an age crossing a day, an entity leaving a window, a trend's span ending) and derives them again |
| `DERIVE_INLINE_MAX` | `50` | A write of at most this many entities is derived before the request answers, and so is what read them while each round stays this small |
| `DERIVE_BATCH` | `2000` | Queued entities one pass takes at a time |
| `DERIVE_BUDGET_MS` | `1500` | How long one pass may run before it yields to the next tick |
| `DATA_DIR` | `./data` | Git checkouts and the generated secret key |
| `PUBLIC_URL` | `http://localhost:8080` | URL browsers reach the app on |
| `AUTH_MODE` | `none` | `proxy` takes the person from the login proxy. `none` makes every browser an admin, for local runs |
| `AUTH_ISSUER` | (none) | With `proxy`, the OIDC issuer of the ID token the login proxy passes in `Authorization` (oauth2-proxy `--pass-authorization-header`). The hub verifies it and reads the person's email and roles from it, so a caller that reaches the session port around the proxy is refused. Unset, the hub trusts `X-Forwarded-Email` and `X-Forwarded-Groups` |
| `AUTH_AUDIENCE` | (none) | The audience of those ID tokens, the login proxy's client id. Required with `AUTH_ISSUER` |
| `AUTH_API_SCOPE` | (none) | A scope, such as `access_as_user`. With it, the machine port also takes the issuer's access tokens for `AUTH_AUDIENCE` that carry it, as the person they name. A chat bot uses it to act as the person who clicked, never as itself. `GET /v1/sign-in` on the machine port tells an app, with no token, the issuer and the scope (`<AUTH_AUDIENCE>/<AUTH_API_SCOPE>`) to ask for. An MCP client reads the same from `/.well-known/oauth-protected-resource/mcp`, and `/mcp` points to it when it refuses a call with no token, so an agent platform such as Copilot Studio signs each person in and calls the tools as them |
| `AUTH_DELEGATES` | (none) | The APIs the hub may call as the person who asked, as JSON by name: `{"ops":{"scope":"api://ops/.default","urls":["https://ops.example.org/"]}}`. A webhook action names one as `onBehalf` (see `docs/actions.md`). Needs `AUTH_API_SCOPE`, a workload identity on the pod that is the hub's own app at the issuer, and a login proxy that passes the person's access token for the hub in `X-Forwarded-Access-Token` |
| `AUTH_SESSION_HEADERS` | `false` | `true` keeps the session port on `X-Forwarded-Email` and `X-Forwarded-Groups` with `AUTH_ISSUER` set, for a front door that passes no ID token. The issuer then serves only `AUTH_API_SCOPE` on the machine port. Only the front door may reach the session port then |
| `AUTH_SIGN_IN_PATH` | `/oauth2/start` | Where the login proxy starts a fresh sign-in on the hub's host. When a person signed in on the page does something that needs their own token for the hub (an approval or a run made as them) and the token the proxy passes beside the session no longer verifies, as after oauth2-proxy refreshes a session, the hub answers `401` with this path and the page sends them through it and back, once |
| `ROLE_GROUP_ADMIN` | `Admin` | Group or app-role claim values, comma separated, that make a person an admin |
| `ROLE_GROUP_USER` | `User` | Claim values that let a person in. A person with neither claim is refused |
| `EMAIL_DOMAIN_ALIASES` | (none) | Mail domains that are aliases of the sign-in domain, as `alias=domain` pairs separated by commas. A person's address on an alias is rewritten to the sign-in domain |
| `SECRET_KEY` | generated | Base64 32-byte key that encrypts git credentials at rest |
| `DRAIN_SECONDS` | `5` | How long a stopping hub keeps answering after `/readyz` turns 503, while the load balancer moves away |
| `STOP_SECONDS` | `20` | How long a stopping hub waits for the requests it holds before it cuts them |
| `GIT_POLL_MINUTES` | `15` | How often git sources are pulled |
| `LIFECYCLE_MINUTES` | `5` | How often grace and purge run, and what moved is re-linked |
| `RELINK_MINUTES` | `60` | How often every relation rule and inherited relation is re-linked, whether or not anything it reads moved. A change is re-linked as it lands; this is the net under that |
| `TOMBSTONE_DAYS` | `90` | How long a deleted entity is kept for a return, where its blueprint's `lifecycle.keepDeleted` says nothing |
| `RUN_KEEP_DAYS` | `365` | How long an ended action run is kept, with its log and outputs; its batch goes with its last run |
| `REPORT_KEEP_DAYS` | `730` | How long a report's edition is kept from when it was published: its record, its body, and its data |
| `RUN_IMAGE_DAYS` | `30` | How long the pictures runs reported are kept: most of what runs weigh |
| `RUN_DAYS` | `30` | How long a finished run's row is kept. An open run is never removed |
| `ACTIVITY_DAYS` | `90` | How long the activity log is kept |
| `LOAD_DAYS` | `14` | How long the load ledger is kept: what deriving, grids, writes, and API calls cost by the hour |
| `CHECK_MINUTES` | `2` | How often the built-in runner executes its checks |
| `ACTION_TIMEOUT_MINUTES` | `60` | How long an action run under way may go unheard from before the hub gives it up, as `unknown`: counted from its last report, one that carries nothing included, or from its start. A run that keeps reporting is never given up for it (docs/actions.md, A run lives by being heard from) |
| `ACTION_WATCH_SECONDS` | `30` | How often the hub looks at the GitHub workflow runs it started |
| `GITHUB_API_URL` | `https://api.github.com` | The GitHub REST API a `github_workflow` backend calls |
| `ANNALS_URL`, `ANNALS_TOKEN` | (none) | [Annals](https://github.com/orchard-suite/annals)' API port and a token it issued for the source `orrery`. With both, the activity log is forwarded to it (see Access) |
| `ANNALS_EVERY_SECONDS` | `30` | How often the activity log is forwarded to Annals |
| `DISPATCH_URL`, `DISPATCH_TOKEN` | (none) | A dispatch desk's API port and a token it issued. With both, every self-service run is told to it as events (docs/actions.md, Telling people about runs) |
| `DISPATCH_EVERY_SECONDS` | `5` | How often runs are told to dispatch |
| `DISPATCH_APPROVERS_GROUP` | (none) | A group on the desk that hears of a run waiting for approval when no rule names who decides it, or more than twenty people are named. Unset, such a run is for nobody by name |
| `DISPATCH_REMIND_HOURS` | `24` | How long a run waits for approval before its deciders are told once more. `0` never reminds |
| `DISPATCH_PUBLIC_URL` | (none) | The desk's address for people. With it, the profile menu links each person to the page where they choose how they are told |
| `CLIENT_ADDRESS_HEADER` | `x-real-ip` | The one header the hub reads a caller's address from, for telemetry and for an action's `by.address` (docs/actions.md, Where the caller is). The ingress must write the caller's real address into it over whatever the caller sent, and strip anything a caller could forge; no other header is read. `none` trusts no header |
| `CLIENT_ADDRESS_HOPS` | `1` | How many proxies in front of the hub add an entry to that header, for one that lists addresses such as `x-forwarded-for`: the hub reads the entry that many from its end |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | (none) | An OTLP/HTTP collector the hub sends its metrics to every 30 seconds, and its traces (see Traces and logs). Unset, no metrics or traces are kept. `OTEL_SERVICE_NAME` and `OTEL_RESOURCE_ATTRIBUTES` name the hub there |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | (none) | An Application Insights resource's connection string. With it, the hub sends who uses it and how: requests, usage events, page views, and errors (see Usage telemetry). Unset, nothing is sent |
| `FARO_URL` | (none) | A Grafana Faro receiver. With it, what a person's browser reports is relayed there as the app `orrery-web`: page views, the events the page sees, how long the person waited, the web vitals, and errors. `FARO_API_KEY` is the receiver's key; without it the hub takes each batch and drops it, counted |

## Access

Sign-in decides who gets in. The hub decides what they may do.

- The login proxy passes one of two claims. `User` lets a person in. `Admin`
  lets them in with every permission. In Entra these are two app roles on the
  app registration, sent in the `roles` claim.
- The hub enrolls each person the first time they come in and lists them on
  the **Access** page, with when they were first and last seen. **Add
  person** puts someone there before they first sign in, with the roles they
  will have when they do. Sign-in still decides whether they get in.
- A person is kept under one address, lowercase. When the login proxy gives
  a mail address on an alias of the sign-in domain, `EMAIL_DOMAIN_ALIASES`
  rewrites it, so a person is one row however they arrive. People already
  kept under an alias move to their sign-in address when the hub starts.
- Everyone who gets in reads what the access rules below let them see. An
  admin sees everything. Changing anything takes a permission. The permissions are a fixed list: `entities.edit`,
  `views.arrange`, `catalog.organize`, `model.edit`, `sources.refresh`,
  `sources.manage`, `secrets.manage`, `tokens.manage`, `budgets.set`,
  `users.manage`, `audit.view`, `posture.read`, `access.values`, and the
  ones for actions and tools (docs/actions.md).
- A **role** is a named bundle of permissions that you define on the Access
  page and give to people. A hub starts with three you can change or remove:
  Viewer, Contributor, Architect. The Admin role is the hub's own.
- Nobody hands out a permission they do not hold: not in a role, and not
  through a token.
- **Who sees what.** An admin may give a blueprint, or one field of it, an
  access rule. Without one, everyone sees it. With one, only the people a
  rule lets in see it, plus every admin and every machine access token.
  - A rule starts from the signed-in person's own entity. On the Access page
    an admin picks the blueprint that holds people, and whether its key or a
    field holds the sign-in address.
  - Each line of a rule follows a relation path from that entity, reads a
    field or the key and title where it ends, and lets the person in when the
    value is one it names: `team` is one of `platform-engineering`,
    `department` is one of `human-resources`, or, with no path, the person's
    own address. Any line is enough.
  - A rule may also name **audiences** instead of writing lines out by hand.
    An audience is a named set of people: addresses named one by one, plus
    any grant lines and other audiences it holds. Name people one by one
    unless everyone a team or department reaches, now and later, belongs.
    Change an audience once and every rule naming it follows.
  - A **class** gathers a kind of sensitive field, such as cost, across every
    blueprint: field-name patterns (`cost_*`, `*_cents`), optionally narrowed
    to some blueprints, plus fields named outright and fields left out with a
    reason. A field a class matches is seen by the class's audiences and
    nobody else, wherever it appears, and a blueprint that arrives later with
    a matching field is covered from its first read. A rule written by hand
    on such a field is refused: change the class, or leave the field out.
  - A class may also open its fields to **owners**: a person sees them on an
    entity they own, or on one whose relation named in `through`, such as
    `program`, points at something they own, by the ownership paths under
    "What is yours". `roles` limits which of those paths count, such as
    `program`; empty, every path does. On every other entity the fields stay
    hidden, so a sort, a filter, a count, or an export reads them as blank
    there. A scorecard is judged on every entity at once, so one that reads
    such a field stays hidden from an owner. Owners read these fields; they
    never change them.
  - A blueprint's rule may also open its **entities to their owners**:
    `owners: { roles: [owner], fields: [url, quota] }`. Someone the rule
    does not let in still sees each entity of it they own by one of `roles`
    (the `as` of a path under "What is yours"), and no other: in its grid,
    marked as only theirs and counted by theirs alone, in search, on Now,
    and on their own person. `roles` is required, so a team lead does not
    reach every member's things by a team path. `fields` names what an
    owner reads; anything a source adds later stays hidden from owners until
    it is named. `all` shows every field instead, for a blueprint where
    nothing new would be sensitive. Either way a field's own rule and its
    class still hold, a link to anything else they may not see stays out,
    and a field worked out across the blueprint elsewhere, such as a count,
    stays hidden, since it would tell them of the rest. Owners never change
    what they read this way. Only the steps of the ownership paths that end
    on the blueprint become what access is decided from: opening a drive's
    `holder` to owners leaves `holder` on every other blueprint free to
    edit. The Security page says what each blueprint opens to owners, and
    who sees some of it so today.
  - A blueprint's rule may also open its **entities to whoever sees what
    they are about**: `subjects: [storage, database_server]` names the
    relations that point at what each entity is about, such as a finding's
    resource. Someone the rule does not let in still sees an entity when
    they may see an entity it points at through one of them: a whole
    blueprint, one they own, or one itself about something they see. So a
    team that sees its storage accounts sees the findings about them, and
    the findings follow when access to the accounts narrows. A relation the
    rule does not name, such as a finding's pillar, opens nothing. They read
    every field a field rule or class does not keep from them, in its grid
    marked as only what is about what they see, in search, and on the page
    of what it is about. They never change what they read this way. The
    Security page says what each blueprint opens this way, and how many
    people see some of it so today.
  - A field worked out from what a reader may not see is hidden from them
    with it: a mirror, a calculation, a trend, and an aggregation over a
    blueprint or a field they are not let into. An admin may mark such an
    aggregation a **summary**, `summary: true` on the field, when the number
    is for everyone and the entities it counts are not: the level a thing
    reached, how many findings stand open. Everyone who may see the field
    then reads its result, and what is worked out from it: a calculation, a
    trend of its history, a mirror of it, a budget on it, a scorecard level
    that reads it. Nothing else opens. The entities it reads stay out of
    every grid, search, query, export, map, and agent tool, with their keys,
    their fields, and the relation to them; the field is described as
    derived, never from what; a trend is given without the link to its
    history; and no filter, sort, or search reads a trend shown this way. A
    filter or a sort on the number works, since it tells a reader only the
    number they are shown: with a count, how many there are on each thing
    they see, and when that moves. A summary is a `number` or a `trend`, and
    the mark opens nothing where the result could be anything else, such as
    the largest of a text. The field's own rule and its class still hold.
    The Security page names every summary and how many people see it by the
    mark alone, and `GET /v1/posture/who` says which people those are.
  - An **edit rule** says who changes values by hand without holding
    `entities.edit`. It names blueprints (`sw_service`, `it_*`), fields
    (`description`, `notes`; `title` and `icon` are fields), relations, and
    who: `audiences`, who change the values on every entity, and `owned`,
    which lets in whoever owns the entity by the ownership paths under
    "What is yours". `owned.roles` limits which paths count; empty, every
    one does. `owned.through` counts owning what the entity points at, such
    as its `program`. The role `self` is a person on their own person
    entity, for a rule that lets people describe themselves.

    ```yaml
    edits:
      - id: service-notes
        title: Service notes
        blueprints: [sw_service]
        fields: [description, notes, runbook]
        relations: [depends_on]
        owned: { roles: [owner, team] }
      - id: device-desk
        title: Device desk
        blueprints: [it_*]
        fields: ['*']
        audiences: [it-operations]
    ```

    A rule opens only what it names, so a new blueprint or a new field opens
    nothing. No rule opens a derived or locked field, one an admin marked,
    a value set in git, or anything access is decided from. The relations a
    rule lets owners in through (`owner`, `team`) become what access is
    decided from on the blueprints it names, so nobody makes themselves an
    owner. A rule may open named fields on a blueprint only an admin
    changes, such as a team's icon to its members.

    Whoever a rule lets in as an **owner** writes where no source says a
    value, or where the field is `sticky`; over a pushed value they are told
    which source it comes from. Whoever it lets in by an **audience** may
    correct a pushed value too, as a holder of `entities.edit` does: the
    correction gives way when the source says something else.

    The grid and the entity page mark what a rule opens to the reader: a
    pencil at the head of the column or beside the field's name, and an
    empty value that is theirs says "Add a description". Now lists what is
    theirs to fill in. On a scorecard, the failing mark of a rule that reads
    one field opens that field, or says where it is changed.
  - A person must pass both the blueprint's rule and the field's to see a
    field.
  - A blueprint a person may not see is not there for them: not in the
    catalog, a search, the wall, the activity log, findings, or
    an agent's answers. Nor is any link to or from one: an entity they can
    see shows no sign of it, and the blueprints they read do not name the
    relation.
  - A field a person may not see is left out of every entity, search, sort,
    filter, column count, and export they get, along with every field
    derived from it, a trend drawn from its history included. Nothing says
    a field was left out.
    When the hidden field is the blueprint's status field or its reason,
    the status keeps its colour and says only that something they cannot
    see is not green.
  - An alert the hub matched to no entity is seen only by those who see
    everything: its labels may name anything.
- **What is yours.** Beside the person blueprint, an admin lists relation
  paths from a person's entity to what they own: `teams.<-team` reaches
  everything a team of theirs is named on, `<-person` everything that names
  them. Owning is not seeing: it never opens a blueprint, and opens a field
  only where a class opens it to owners, on what they own. A thing of a
  blueprint the person may not see is not theirs to be shown. Owning also
  opens an action whose rule asks for it, on that entity alone, and an
  action whose `access.home` asks for it, to the people who own the action's
  home (see Self-service).
  - Now speaks to the person about what is theirs: its verdict, what needs
    them, and their own things by kind. What they see that is not theirs is
    counted apart, under "elsewhere". The command bar leads the same way,
    `/v1/findings` marks what touches their own, and an entity page says
    **Yours** when it is.
  - Without paths, or for someone the person blueprint does not hold, the
    hub says it does not know what is theirs and speaks for everything
    shared with them. Only a person who sees everything is told about "the
    estate".
  - An action works with what the person who asked for it may see. An action
    on, or picking from, a hidden blueprint is not offered to them, and a
    run's payload or job leaves out the fields they may not read.
- **Nobody changes what access is decided from by hand, but an admin or a
  holder of `access.values`.** The person blueprint, and every blueprint a
  rule's path reads through, such as teams and departments, are guarded
  whole: their entities, their values, their relations. So is every field
  and relation an action's filter or rule reads on what it runs on, such as
  an environment, and every relation a person's ownership paths follow once
  a rule or an action's home asks for ownership, with what fills each one (the path it inherits
  by, the field a relation rule matches on, what a mirror or calculation
  reads). The hub works this out from the rules themselves; nobody marks it.
  Otherwise anyone could add themselves to a team, or move production into
  test, and widen their own reach. Give `access.values` through a role, such
  as a security contributor. A guarded value says so on hover and opens no
  editor. Git and the source that owns an entity still write it. An admin
  may also mark any blueprint or field **only an admin changes**, which
  `access.values` does not open. Access rules and these marks are set by
  admins only, and a pusher's offered blueprints never bring them.
- **Previews.** A view the hub is still trying is held back until an admin
  opens it, at the foot of the Access page: to nobody, to the people named,
  or to everyone. A new hub opens none. A person is named by the address
  they sign in with, and may be named before they first come in. Being an
  admin does not put you in: name yourself. A personal key is its person; an
  access token and a source are in only once the view is open to everyone.
  To everyone else the view is not there: no link, no page, and a `404`
  from its API. `GET` and `PUT /v1/access/previews` read and set it, and
  every change is in the activity log. The previews now are **Garden
  view**, the Ground page and everything that leads to it, and **Welcome
  tour**, the tour and the release notes below.
- **Welcome tour.** In preview. A person's first visit opens a short tour:
  the page dims, a hole opens over one place at a time (the pages, Now's
  verdict, the sky, what needs them, search, the catalog, one entity,
  Self-service, one action, their account menu), and a note beside it says
  what it is. The steps and their order are the hub's, so the tour holds on
  any hub; the estate picks the catalog, the entity, and the actions it may
  show, and may reword or leave out any step, on the Access page or in git:

  ```yaml
  config:
    welcome:
      version: 2              # count it up to show the tour to everyone again
      blueprint: service      # the catalog the tour opens
      example: checkout       # the key of one of its entities to open
      actions:                # best first: each person sees the first they may run
        - request-database
        - restart-service
      steps:
        hello: { title: Welcome to the platform }
        selfservice: { empty: "Ask the platform team for access to an action." }
        grid: { text: "Every {{ blueprint }} the platform runs, and who owns it." }
        needs: { shown: false }
  ```

  A git source that declares it owns it while it does. The tour a person
  gets is built for them (`GET /v1/welcome`): a catalog they may not see
  becomes the first they see, they are shown the first of the actions they
  may run, else the first action they may run at all, and a step that would
  show something they may not see is left out. A person who may run no
  action skips the action's step, and Self-service tells them how they get
  one (`empty`, which the estate may reword). A place their
  screen does not draw, such as the rail on a phone, skips its step. They
  can leave it at any step and take it again from their account menu.
- **What's new.** In the same preview. The first time a person opens a new
  release, a note says what changed since the release they last saw, in
  their words, not the changelog's. The notes live in `src/web/whats-new.ts`.
- **Preferences.** What the hub keeps for one person on every device: the
  tour they last finished and the release whose notes they last saw, besides
  their pins and their stars. Each one is named in `src/shared/preferences.ts`;
  `GET /v1/mine/preferences` reads them and
  `PUT /v1/mine/preferences/<name>` with `{value}` sets one. They are a
  person's alone: no permission, no activity row, none for a machine token,
  and none set while an admin views as someone. What is about one browser,
  such as the theme, stays in that browser.
- When a sign-in ends while a page is open, the page reloads itself and the
  login proxy signs the person in again, back where they were. The web app
  reads that from a redirect or a `401` on any `/v1` request.

### Security posture

The Security page, at `/security`, is where an admin sets the audiences and
classes, and audits every rule in one place. It judges each rule for every
person the hub knows (everyone who signed in or was added, and every person
entity) and every machine access token, with the same evaluation every page
uses. A token or role holding `posture.read` reads all of it and changes
nothing.

- **Overview** shows how every field's reach was decided (in a class, a rule
  of its own, open and reviewed, or open because nobody decided), each
  audience with whom it lets in today and what names it, each class with
  what it covers, and the grants written out by hand, each one a click from
  becoming an audience. Editing an audience or a class previews who gains
  and loses sight of every blueprint, field, and action before it saves, and
  the save records an `access.changed` row. Removing an audience takes it
  out of every audience that holds it.
- **Map** lays every blueprint, by section, against every audience and the
  people in none: how many of each column's people see it, admins aside, and
  how many of its fields are kept from them.
- **Review** lists every blueprint, the ones never reviewed or holding fields
  that came after the last review first, newest first, with when each came
  and the new fields, the ones a class covers marked. **Mark reviewed**
  stamps them as they stand (an `access.reviewed` row); a field that lands
  later, such as one a pivot makes, puts its blueprint back in the queue.
- **Set by hand** lists every value a person set on a field or relation access
  is decided from, with who and when, and whether it stands over what a source
  sent. Leave one to keep it; **Clear** gives it back to its sources.
- A catalog file may declare the audiences, classes, and edit rules under
  `config.access` (`audiences`, `classes`, `edits`). Git owns them while it does, and
  the page refuses changes. When git stops declaring them they stay as they
  were and are changed here again: letting go never opens what they guard.

- **Findings**, one panel a kind, point at what could widen someone's reach: an action open to
  everyone or to most people, people who may run an action on something they
  cannot see, non-admins holding a permission that widens reach
  (`tokens.manage`, since every machine token reads everything;
  `actions.manage`; `users.manage`; `sources.manage`), access tokens with the
  admin role, sources that define actions, an action open to the people of a
  home nobody owns, an action whose home is gone, an action nobody has run
  in 90 days whose definition is older than that, a grant path the model lacks, and
  a blueprint a grant reads through that others can change, an audience
  that lets nobody in or names people the hub does not know, a class that
  covers nothing or sets aside rules written on its fields, field rules that
  only repeat their blueprint's, and a field nobody but an admin sees
  because nobody passes both its rule and its blueprint's. Each finding
  names what and who it is about, and opens the change form on its targets.
- **Actions** lists every action as a row: its home, who may run it
  (everyone, each audience, each grant, its home's people, and how many
  rules it has), how many people that is, whether a run waits for approval
  (always, by a rule, or never), what does the work, and when it last ran,
  with how many runs the last 90 days saw. Filter by a person or token (what
  they may run), a team a grant names, an audience, a backend, and by open
  to everyone, no approval, and never run; the filters hold together. A row
  opens to the people it lets in, one by one, each with what lets them in.
- **Every rule** lists every blueprint, every field (an open one too, so it
  can be found and locked here), and every action: who may see or run it,
  how many people that is, who changes it, and what is worth knowing. Filter
  by kind, section, and who. Rows can be picked for one change, and picked
  fields made into a class.
- **Who edits** answers who changes each value by hand, in four numbers a
  blueprint: by an edit rule, by the holders of `entities.edit`, by admins
  alone, and by sources alone. A blueprint opens to each field with the one
  that holds it and why. It lists the edit rules and edits them, says what
  the rules open to one person and on how many of their things, and lists
  the standing overrides: every hand value over what a source says, oldest
  first, since one stays for as long as the source says the same.
- **Who can** finds, by typing, one person or token for what they may see,
  change, and run, and through which audience or grant; or one blueprint,
  field, or action for everyone it lets in, restricted ones first.
- **A change** to the picked rows replaces, adds to, or removes from their
  audiences and grants, opens them to everyone, gives actions back to admins alone, or sets
  or clears the admin-only mark. **Preview** lists, row by row, who gains and
  who loses seeing or running it, who gains or loses changing it, and which
  blueprints would become an admin's alone because a new grant reads through
  them. **Save** writes each blueprint and action the way its own editor
  does, with the same checks, and records an `access.changed` row for each.
  A git-defined rule, one of the hub's own blueprints, an unknown target, a
  field a class covers, and a grant path the model lacks are left as they
  are, with the reason.

The API is `GET /v1/posture`, `GET /v1/posture/reach`,
`GET /v1/posture/who`, `POST /v1/posture/change`, `GET` and
`POST /v1/posture/policy`, and `POST /v1/posture/review` (`save: false`
previews).

## Activity

Every change is recorded with who made it: a person, an agent with an access
token, a source, or the hub itself. That covers entities, runs, the model,
the shared layouts, sources, secrets, tokens, people, and roles. A request
refused for lack of a permission is recorded, and so is a write the hub
turned down. Reads are not recorded, and a secret's value never is.

The **Activity** page shows the log to whoever holds `audit.view`, with
filters for who acted, what was touched, and when: one click hides what
sources wrote and leaves what people did. `GET /v1/changes` and the
`get_changes` tool answer the same questions. Rows older than
`ACTIVITY_DAYS` are removed.

With `ANNALS_URL` and `ANNALS_TOKEN` set, the hub forwards the log to
Annals, one event per row with the key `change:<id>`: every row a
person or an access token wrote, and every change to the model, layouts,
sources, secrets, access, and actions, whoever made it. What pushers and the
hub's own passes write about the estate stays here. A pass sends every row
after a mark and moves the mark past rows a minute old, so an Annals that is
down loses nothing and a row committed late is still sent; Annals keeps
one copy of each key. `orrery.annals.events` counts the answers.

## Deploy

Two hostnames, two ingress policies. The UI host sits behind an Entra login
proxy that passes the signed ID token (`AUTH_ISSUER`, `AUTH_AUDIENCE`); the
ingest host reaches the machine port directly and accepts only tokens. One
replica, one Postgres. An agent or script that works on a person's behalf uses
that person's personal token on the ingest host, never the session port.
An app a person signs in to, such as a chat bot, can act for them the same way:
with `AUTH_API_SCOPE` set, it asks the issuer for an access token to the hub's
API with that scope and sends it to the ingest host. The hub checks the
issuer's signature, the audience, and the scope, then gives the person the
roles the token names, as at sign-in. An ID token never passes there.

### Releases without downtime

Roll the hub out with the new pod beside the old one: a surge of one, none
unavailable. For the short time both serve, each is safe beside the other:

- **Ready and alive are apart.** `/readyz` says the hub takes traffic;
  `/healthz` says the process answers. Point the readiness probe at
  `/readyz` and liveness at `/healthz`. Give the first start a startup probe:
  a migration runs before the hub listens.
- **A new hub has nothing to warm.** Every entity's derived fields, status,
  and resolved relations are kept in the `derived` table, worked out when
  their inputs change, so a hub reads them like any other row and is ready
  as soon as it listens. The first hub to lead after this table arrives
  derives every entity once (`backfill`) before its other work; a read
  meanwhile derives what it needs on the way.
- **A stopping hub drains.** On `SIGTERM` it turns `/readyz` to 503 and keeps
  answering for `DRAIN_SECONDS`, then takes no new connections, ends the
  browser event streams so they reconnect to the next hub, waits up to
  `STOP_SECONDS` for the requests it holds, and exits. Give the pod a
  termination grace period longer than both. A login proxy in the same pod
  needs a `preStop` sleep longer than the drain, so it outlives the hub.
- **One hub runs the background work.** Git sync, the built-in checks, the
  lifecycle pass, action watching, and the Annals and dispatch forwarders run
  on the hub holding a Postgres advisory lock. The old hub lets go as it
  stops; the new one takes the lock, reads again everything it keeps in
  memory, and tells every browser to read again. Its first
  background passes then run one after another, so a hub that has just
  taken the lead is not doing all its work at once beside the people it
  serves.
- **Every working hub derives.** The leader and every other hub that is not
  serving only take from the derive queue every `DERIVE_EVERY_SECONDS`, each
  its own entities: what any hub wrote is derived and stored within that,
  and shown to every browser as it lands. A small write outside a run
  is derived on the request itself, so a hand edit shows at once; a pusher's
  run is answered without waiting for any of it.
- **Serving can run apart from the background work.** One hub does both by
  default. To keep every answer off the background work's thread, run two
  deployments of the same image on one database: `ROLE=api` behind the
  services, and `ROLE=worker` with no traffic. The API hub never takes the
  lead, so no request waits behind a derive pass, a git sync, or a re-link.
  Hubs on one database tell each other what they change over Postgres
  `LISTEN` and `NOTIFY`: a hub reads a definition again as soon as another
  changes it, and a browser on the API hub hears what the worker derived.
  Nothing else connects them, and a hub may come or go at any time.
- **Scaling out is a replica count.** More `ROLE=api` hubs take more reads
  and pushes: a run may open on one, send its batches to others, and commit
  on another, and every hub answers the same; only what the Sources page
  and the status wall count of a source's writes trails by up to a minute
  on a hub that did not take them. More `ROLE=worker` hubs derive
  faster: one of them leads and runs the timed work, and all of them share
  the queue. `bench/fleet.ts` runs such a fleet as separate processes and
  checks it: at 115,000 entities, one worker finished deriving a first push
  about 38 seconds after it landed, two after 16, and four after 4 to 11. A hub that
  stops mid-pass leaves what it took to be taken again two minutes later.
- **Migrations wait their turn.** Each numbered file in
  `src/server/migrations` is applied once, recorded in `schema_migrations`,
  under an advisory lock. A start with nothing new takes no table lock, and a
  step that cannot get a table at once lets go and tries again, so it never
  stalls the hub still serving.
- **The browser keeps up.** A page from the old release that asks for a file
  the new one lacks gets a 404 and loads the page once more. The event stream
  opens with the hub's version; a page built from an older one offers a
  reload, and a stream that dropped reads everything on screen again.

```bash
docker build --platform linux/amd64 -t orrery .
docker build --platform linux/amd64 -f go.Dockerfile --target pusher-k8s -t orrery-pusher-k8s .
docker build --platform linux/amd64 -f go.Dockerfile --target pusher-entra -t orrery-pusher-entra .
docker build --platform linux/amd64 -f go.Dockerfile --target access-runner -t orrery-access-runner .
docker build --platform linux/amd64 -f go.Dockerfile --target azure-runner -t orrery-azure-runner .
docker build --platform linux/amd64 -f go.Dockerfile --target telemetry-runner -t orrery-telemetry-runner .
docker build --platform linux/amd64 -f go.Dockerfile --target job-starter -t orrery-job-starter .
```

Each release CI cuts on `main` publishes the hub, the k8s pusher, the Entra
pusher, the CLI, the runner, the access runner, the Azure runner, the
telemetry runner, and the job starter images, tagged with the version, to the GitHub Container
Registry as `ghcr.io/orchard-suite/orrery`, `orrery-pusher-k8s`, `orrery-pusher-entra`,
`orrery-cli`, `orrery-runner`, `orrery-access-runner`,
`orrery-azure-runner`, `orrery-telemetry-runner`, and `orrery-job-starter`. A cluster pulls those with no secret; pin them by digest. The
hub image carries the server's TypeScript source, as it runs, without its tests
or test fixtures.

The Go images hold their programs on a distroless static base: CA
certificates, time zones, and a user that is not root, with no shell and no
packages to patch. The hub image is Node on Alpine with git, as the `node`
user, without npm, corepack, or yarn; each build takes the system packages of
its day. The programs are compiled with the Go that `go.mod` names.

## Metrics

With `OTEL_EXPORTER_OTLP_ENDPOINT` set, the hub sends OpenTelemetry metrics
to that collector. Every label is a fixed set of values: a route pattern, a
table, a task. None names an entity or a person, except the field gauge below,
which an architect turns on field by field.

| Metric | Labels | What it shows |
| --- | --- | --- |
| `http.server.request.duration` | `orrery.surface`, `http.route`, `http.request.method`, `http.response.status_code`, `orrery.version` | How long each route takes to answer, under the release running, so a board compares one release with the one before |
| `db.client.operation.duration` | `db.operation.name`, `db.collection.name`, `orrery.outcome` | Every Postgres statement, by verb and the first table it names |
| `db.client.connection.count`, `db.client.connection.pending_requests` | `db.client.connection.state` | The pool: connections in use and idle, and the calls waiting for one that no idle connection is about to answer. The reads the gauges make of the database as they are collected are never counted |
| `db.client.connection.wait_time` | | How long each call waited for a pooled connection, in seconds, the gauges' own reads left out |
| `orrery.task.duration` | `orrery.task`, `orrery.outcome` | Hub work: re-link passes, rules, inherited relations, listings, findings, commits, batch writes, git refreshes, the lifecycle tick |
| `orrery.kept.lookups` | `orrery.kept`, `orrery.result` | Whether a grid's listing or a page's answer was already kept |
| `orrery.queue.depth` | `orrery.queue` | Entities waiting to be derived |
| `http.client.request.duration` | `orrery.peer`, `http.response.status_code` | Every call the hub makes out: GitHub, a webhook, a health check, the issuer, the incident desk, Annals, the Faro receiver |
| `orrery.auth` | `orrery.surface`, `orrery.outcome` | How each request signed in: let in, refused, or a token whose person has gone |
| `orrery.refusals` | `orrery.reason` | Requests turned down on policy: a permission not held, a view-as, an action's rules, a hidden field read, a hand edit of what access is decided from, a source's write it does not own, a blueprint a source did not offer |
| `orrery.usage.events` | `orrery.event`, `orrery.source` | Usage events by name (see Usage telemetry), from the hub or a page. Every name is a series from the start, at zero until it happens, so a board lists what nobody uses |
| `orrery.agent.calls` | `orrery.tool` | MCP tool calls, by tool; a name the hub has no tool for counts as `unknown`. Every tool and every refusal reason starts at zero |
| `orrery.agent.answer.size` | `orrery.tool` | How big the answer to one MCP tool call was, in bytes, by tool. A batch of calls is not measured |
| `orrery.people`, `orrery.browser.sessions` | | People who made a request, and browser tabs that reported, in the last day, read from the database: every hub reports the same count, and a restart loses none |
| `orrery.browser.views` | `orrery.page` | Pages opened in the web app |
| `orrery.action.runs` | `orrery.action`, `orrery.origin`, `orrery.outcome` | Action runs that ended, by action, what asked them (`alone`, `batch`, `schedule`), and how they ended |
| `orrery.action.run.duration` | `orrery.action`, `orrery.origin` | How long a run took, started to finished, in seconds |
| `orrery.runner.queued`, `orrery.runner.running`, `orrery.runner.width` | `orrery.runner` | Each runner's runs waiting for it, its runs going, and how many it runs at once: how far behind and how full it is, to size what runs it |
| `orrery.browser.wait` | `orrery.page`, `orrery.measure` | How long a person waited, in seconds: `wait` from what they did until the answer was on screen, `ready` to the first useful screen, and the web vitals `lcp` and `inp`. The buckets have edges at 1 s and 4 s, the objective and the limit |
| `orrery.browser.shift` | `orrery.page` | Cumulative layout shift |
| `orrery.browser.errors`, `orrery.browser.batches` | `orrery.outcome` | Errors a page did not catch, and what became of each batch the page sent: relayed, dropped, failed |
| `nodejs.eventloop.delay.p99`, `nodejs.eventloop.delay.max` | | How long the hub was too busy computing to answer |
| `process.memory.usage`, `process.cpu.time` | `process.memory.kind`, `process.cpu.state` | The process itself |
| `orrery.build_info` | `version` | The release running |
| `orrery.field.value` | `blueprint`, `field`, `key` | Each entity's value of every field marked `metric`: a number as it is, an enum as its value's place among its values |

The field gauge is also sent to Application Insights as a custom metric, with
its labels as dimensions, when `APPLICATIONINSIGHTS_CONNECTION_STRING` is
set; no other metric is, since Application Insights bills a custom metric by
what it receives.

A statement slower than a second also writes a `slow query` warning with its
verb, table, time, and SQL text. The SQL is the parameterised text; no value
is ever in it.

## Traces and logs

Every API call runs in a server span named by its method and route pattern,
every background pass in a root span named by its job, and every piece of
timed hub work (the tasks of `orrery.task.duration`) in a span of its own
inside whatever runs it. With `OTEL_EXPORTER_OTLP_ENDPOINT` set, the spans go
to that collector; with `APPLICATIONINSIGHTS_CONNECTION_STRING` set, the
server spans go to Application Insights as requests. With neither, they are
made and kept nowhere.

Logs are one JSON object per line on stdout: `timestamp`, `level`, `msg`,
`component`, and the context as fields. A line written inside a span carries
its `trace_id` and `span_id`, so a log line is found beside its trace.

## Usage telemetry

With `APPLICATIONINSIGHTS_CONNECTION_STRING` set, the hub tells Application
Insights who uses it and how. People are named by their sign-in address, so
the resource's users, sessions, funnels, and flows read as people.

| What | Lands in | Carries |
| --- | --- | --- |
| Each API call, on either surface, by its route pattern | `requests` | The person (`user_AuthenticatedId`), the browser tab's session, where the caller is, the surface; a token or source as `initiatedBy` |
| Each change a person or an access token makes that the activity log records | `customEvents` | The event's name, `initiatedBy`, `blueprint`, `key`, `writtenAs` (the source the change was written as, `ui` for a person's edit), and the row's detail, never an action run's inputs |
| Each finished self-service run, failed or not | `customEvents` (`Action Run Finished`) | Who asked, the backend, the state, and `seconds` as a measurement |
| Each MCP tool an agent calls | `customEvents` (`Agent Tool Called`) | `tool` |
| Each page a person opens | `pageViews` | The page's name, its path, and the blueprint it shows |
| Each action form a person opens | `customEvents` (`Action Form Opened`) | `action` |
| Errors: a request that fails with a 5xx, and an error a page did not catch | `exceptions` | The message and the stack |

The page reports through the hub alone, at `POST /v1/telemetry`, and only
when `/v1/whoami` says telemetry is on: when any of Application Insights,
the Faro receiver, or the OTLP metrics is set. It never holds a key or says
who it is. Besides the page views, events, and errors above, it reports how
the page felt: each request's wait from the click until the answer is on
screen, the time to the first useful screen, and the web vitals. Those land
in the hub's metrics as `orrery.browser.wait` and `orrery.browser.shift`,
and, with `FARO_URL` set, in the Faro receiver as measurements of
`orrery-web`.

Event names are a thing and what was done to it, in the past tense and
Title Case (`Blueprint Changed`, `Action Run Requested`); every name is in
`src/shared/usage.ts`. Every event carries `initiatedBy`, and `source` says
which side sent it: `api` for the hub, `web` for a page. A detail named as
one of those is sent as `detail.<name>`. An event the hub sends inside a
request carries that request's operation, its session, and where its caller
is, so a person's changes sit in their visit beside their page views.

Where a caller is comes from the address the ingress writes into the one
header the hub trusts, `CLIENT_ADDRESS_HEADER` (`x-real-ip` unless set),
and from no other header. The resource keeps the
city and country it reads from the address, not the address. A call with no
address of its own, such as a pusher's from inside the cluster, is placed
nowhere rather than where the hub runs.

What a pusher's run did to the estate is not sent, nor is a refusal, nor are
the event stream, icons, and the web app's own files. The page posts what it
saw to `POST /v1/telemetry`. The hub stamps the signed-in person on it and
sends it on, so the page never holds the key. Without the setting, the hub
tells the page to send nothing.

## Health, scorecards, nesting

**Health checks.** A field of type `healthcheck` holds a URL, what to expect,
and which runners should try it. The hub's built-in runner covers public
URLs; a runner (`cmd/runner`) in each network segment pulls its checks and
pushes results back, outbound only. One check on several runners is a
reachability matrix: the intranet is up from the LAN and correctly
unreachable from guest Wi-Fi. Secrets for authenticated checks live in the
hub's encrypted store and are referenced by name.

**Alerts.** An Alertmanager webhook source attaches firing alerts to entities
by label matching, with alert rules like `target.name ==
alert.labels['namespace']`. Prometheus stays the authority on thresholds.
A firing alert lives only until it resolves. To keep a record, give the
event source a `history` blueprint it is registered to write: the hub then
writes every alert it sends as an entity of that blueprint, keyed
`<source>/<fingerprint>`, filling the fields the blueprint has (`summary`,
`status`, `severity`, `health`, `rule`, `started_at`, `resolved_at`,
`duration_hours`, `labels`) and, with `history.relation`, pointing it at the
entity the alert matched. The record stays after the alert resolves, so
aggregations count incidents and time to recover, and the blueprint's own
`lifecycle.expire` decides how long it is kept.

An entity's status is the worst of its checks, its alerts, its freshness, and
a self-reported status field. A blueprint can also roll up from everything
that points at it.

**Scorecards.** Ordered levels of rules for one blueprint or several, in git or the web app.
Rules are search filters, so they see mirror, aggregation, and calculation
fields, and can ask whether a relation is set in either direction. Shown as a
badge on the entity, a matrix per scorecard, and a level trend over time.

A scorecard's `where` is its scope, a search filter like any other: only the
entities it matches are scored.

```yaml
- id: storage_secure
  blueprint: storage
  title: Secure
  where: { field: environment, op: eq, value: Prod }
  levels:
    - name: Bronze
      rules:
        - { id: tls12, title: Minimum TLS 1.2, where: { field: min_tls, op: eq, value: TLS1_2 } }
```

One scorecard can score several blueprints, so a pillar such as Secure is
written once and its levels mean the same everywhere. Name the levels once,
with no rules, and give each blueprint its own rules by level name:

```yaml
- id: secure
  title: Secure
  where: { field: environment, op: eq, value: Prod }     # holds on every blueprint
  levels: [{ name: Bronze }, { name: Silver }, { name: Gold }]
  blueprints:
    storage:
      where: { field: kind, op: neq, value: logs }       # and this one only on storage
      rules:
        Bronze: [{ id: tls12, title: Minimum TLS 1.2, where: { field: min_tls, op: eq, value: TLS1_2 } }]
        Silver: [{ id: no_shared_key, title: Shared key off, where: { field: shared_key, op: eq, value: false } }]
        Gold:   [{ id: private, title: Private network, where: { field: public_network, op: eq, value: false } }]
    key_vault:
      rules:
        Bronze: [{ id: rbac, title: RBAC permission model, where: { field: rbac, op: eq, value: true } }]
        Silver: [{ id: purge, title: Purge protection, where: { field: purge_protection, op: eq, value: true } }]
```

A scorecard gives either `blueprint`, with rules on each level, or
`blueprints`, with levels that carry only a name; one written with
`blueprint` is stored and scored exactly as it always was. Each blueprint
scores on its own rules, and its scope is the shared `where` together with
its own. A blueprint need not have a rule at every level, but it never
stands on a level it has no rule for: the key vault above tops out at Silver,
and an entity is never called Gold where nothing about Gold was checked. A
level with no rule in the middle is passed on the way up. The scorecard is
refused when it names a blueprint, or a level, that does not exist, a
blueprint with no rules, or a rule that reads a field its blueprint does not
have (what the hub keeps about every entity, such as `$state`, is always
there). The matrix shows one table per blueprint, and renaming a blueprint
moves its rules with it.

A rule may carry a `fix`: what to do when it fails, in one line, shown beside
it on the map.

A scorecard that copies another tool's verdict, one rule per level on the
tier that tool wrote, says nothing about what is missing. Give it `reasons`:
where the records are that say why. Each is an entity of `from` that points at
the scored entity through any relation, naming in `level` the level it holds
the entity below, in `says` what is missing, and in `fix` what to do; `link`
is a URL field, and `where` keeps the records that feed this scorecard. A
blueprint of a scorecard that scores several may give its own.

```yaml
- id: accountable
  title: Accountable
  levels: [{ name: Bronze }, { name: Silver }, { name: Gold }]
  reasons: { from: finding, where: { field: pack, op: eq, value: accountable }, level: tier, says: detail, fix: fix, link: board }
  blueprints:
    storage:
      rules:
        Silver: [{ id: silver, title: Judged Silver or better, where: { field: tier_rank, op: gte, value: 2 } }]
```

On the map a level that falls short becomes its gaps, one check each, so one
missing thing counts once, at its level. A level that falls short only
because a lower one did adds nothing, and one no record the reader may see
explains keeps its rule, said to have no reason given. The records are read
through the reader's view, like everything else. The scorecard is refused
when `from` is no blueprint, or a field it names is not on it.

Every entity a scorecard scores carries the levels it reached, lowest first,
in `levels` keyed by scorecard id: `{ secure: [Bronze, Silver] }`, and `[]`
when it reached none. That is what a filter reads.

A rule may read another scorecard's level on the same blueprint, so one
scorecard can build on another. A loop through a level is refused when it
is saved, with the loop named: a scorecard that reads its own level,
directly, through another scorecard, or through a derived field that
aggregates over that level. The check runs when a scorecard is saved and
when a blueprint is, so neither side can close a loop the other opened.
A person who may not see a field or a blueprint a scorecard reads may not
filter on its level either, and an aggregation over it is withheld from them.

An entity outside the scope is not scored. It has no level, is in no count,
and no pass rate divides by it; the matrix says how many the scope left out,
and the grid shows `n/a`. Write a production-only rule as a scope, never as
`not prod or rule`, which counts every test resource as passing. When an
entity leaves the scope, the trend stops counting it from then on.

**Nesting.** A relation with `display: contain` says the entity lives inside
its target: a database inside its server, a workload inside its namespace
inside its cluster. Readers that draw the estate, such as Vantage over the
API, nest by it. The hub refuses a model that nests deeper than two levels
(`canvas.maxNestingDepth` in a catalog's config changes the limit), so use
lines for uses, runs, deploys, and routes to. Orrery draws no picture of the
estate itself.

## Self-service

An **action** is a form a person fills and a backend that does the work:
upgrade an application, restart a workload, open a firewall port. The hub
validates the inputs, renders the backend's payload, hands it over, and
keeps the run as a row with a log the backend reports into. The hub itself
runs no command.

An action is defined like a scorecard, in a catalog file or on the
Self-service page, and runs on one entity of a blueprint, of one of several
blueprints, or anywhere. Its
inputs are typed: text, a number, a yes or no, a date, a date and time, an
email address, a URL, a pick from a list, an entity of a blueprint, or a
person, each with rules a value must keep. Any string in an action may hold `{{ path }}` over the
run's scope, so an input can depend on the entity and on the inputs above it:

```yaml
actions:
  - id: upgrade_app
    title: Upgrade an application
    blueprint: argocd_app
    inputs:
      workload: { type: entity, blueprint: k8s_workload, required: true, where: { relation: namespace, target: "{{ entity.relations.namespace }}" } }
      image: { type: enum, required: true, values: "{{ inputs.workload.fields.images }}" }
      tag: { type: string, required: true }
    backend:
      type: github_workflow
      owner: example
      repo: platform
      workflow: upgrade-image.yml
      secretRef: github_token
      inputs: { run: "{{ run.id }}", path: "{{ entity.fields.path }}", image: "{{ inputs.image }}", tag: "{{ inputs.tag }}" }
```

Four backends do the work outside the hub: a `webhook` that takes the
rendered body, a `github_workflow` dispatched with rendered inputs, a
`runner` job that the named runner claims, executes, and streams back, and
a `job`, one container for the run, which a starter you run starts on
Kubernetes or Azure Container Apps the moment the run is approved, so long
work and work that waits for a person is never held by whoever asked. A run
under way lives by being heard from: one that keeps reporting is never
given up, and one the hub has not heard from for `ACTION_TIMEOUT_MINUTES`
ends `unknown`. A backend reports progress, a link, and
a summary to `POST /v1/action-runs/{id}/report` with an access token whose
role holds `actions.report`; `orrery report` in the CLI does it from a
workflow step. It may also name the steps it goes through and the outputs
the run ended with, on the report or as `::step::` and `::output::` lines
in what it logs; the run's page draws them as a timeline, a Result panel,
and a log folded by step. An output is shown to whoever may see the run, so
it never holds a secret. An action that `refreshes` fields of what it runs on
takes their new values back on `::refresh::` lines, and writes them on the
entity, as its owning source, once the run succeeds, so the catalog shows
the change before the source comes round again. An action can wait for `approval` by someone other than the
requester, and can ask the person to `confirm` what they filled in first.

**Who may run what, on what.** Nobody but an admin, until the action says so. Its
`access` names them with the same grants that decide who sees a blueprint:
`everyone`, people by their sign-in address, a token by its name, or whoever a
relation path from the person's own entity reaches, such as the team that
owns the project. Those run it on everything it runs on. Its `rules` say who
runs it on which entity, each with up to three parts that must all hold:
who the person is (`audiences`, `grants`), what they are to the entity
(`owns`: `true`, or roles from the person setting's ownership paths, such as
`developer` or `qa`), and what the entity is (`where`, such as in
production). A rule may hold its runs for `approval`. Developers restart
their program's services anywhere and QA only in test:

```yaml
access:
  rules:
    - { audiences: [digital_development], owns: [developer], where: { not: { relation: env, target: env:prod } } }
    - { audiences: [digital_development], owns: [developer], where: { relation: env, target: env:prod }, approval: true }
    - { audiences: [digital_quality], owns: [qa], where: { relation: env, target: env:test } }
```

The hub works out, once per person and action until something changes, the
entities each person may run it on. The form offers only those, each row of
the catalog and each entity page shows only those as buttons, and a run on
anything else is refused the way a run on nothing is, so a refusal tells
nobody what exists. An input marked `narrows: env` is asked before the
entity, offers only entities in what was picked, and is filled from the
entity when the action is run on one. An action is a column of buttons in
its blueprints' grids, hidden until someone shows it. An action a person may
not run is not there for them, on the Self-service page, on an entity, or in
an agent's answers; a holder of `actions.manage` sees it to edit it.

An action may have a `home`: one entity of any blueprint that it belongs
to, such as the program or the team it serves. The action is listed under
its home on the Self-service page and on the home's own page, and
`home: true` under `access` opens it to the people who own that entity, by
the person setting's ownership paths. Only an admin sets a home. An action
without one carries a `group`, so the shared ones each sit under their own
heading.
The Self-service page is a start page: the runs that wait for the reader's
approval, the actions they pinned, their recent runs to run again, and each
action as a small tile with its icon, in sections: the homes the reader
owns first, then the other homes and the groups. A person
pins an action with its star, 50 at most; the pins are theirs alone, in the
order they keep them, and the same in every browser.
An app can put its own actions with its source token when an admin gives its
source the `actions` grant; such an action's origin is `{kind: "source",
source}`, and no other source may put over it or remove it.
Agents see the actions they may run through `list_actions` and run one with
`run_action`. The permissions are `actions.report`, `actions.approve`,
`actions.manage`, `actions.list`, and `actions.ask`; every request, refusal,
approval, send-back, and finish is an activity row. `docs/actions.md` has the
details and a worked example.

A **tool** is an action an agent calls and reads the answer of, such as
"show how this app is set up". It runs on a runner with that runner's key,
so a product lends an agent a tool and never a key. Who may call one is
decided by its tier (`read`, `data`, `act`), which a person holds on an
entity through the actions they may ask for there. An admin says on each
runner's source which tiers it serves, which sources may put a tool on it,
and which entities a tool on it may be declared from. `GET /v1/tools` lists
what a caller may reach and `POST /v1/tools/{id}/call` runs one and answers
what it printed; agents have `list_tools` and `call_tool`. A product calls
in a person's name with `tools.lend`, and an assistant that only looks holds
`tools.read`. `docs/actions.md` has the details under Tools.

## Reports

A team defines a report once and publishes it again and again, by hand or on
a schedule; every published copy, an **edition**, is kept to read and
compare later. A report's layout is a short Markdown document of blocks
(`stats`, `chart`, `table`, `scorecard`, `narrative`) over named data sets: saved queries
read as the report's owner, and runner tools called as them. People never
write HTML: the hub draws every edition in one style, on its page and as a
page to forward by mail. Only a narrative block's prose comes from a model,
written by the report's writer, a runner tool; the hub calls no model.

Everything a report does is an action with the `report` backend: create,
edit, put a version back, preview, publish, change recipients, hand over,
remove. The hub brings these actions itself. So who may do it, who approves
it, and its history are the actions engine's. Handing a report over moves
its schedules with it.
Run now, pause, and resume are the publish action's schedule. A publish
tells the report's recipients through the notification desk, each only
while they may see it.

`/reports` lists what the reader's teams published, newest first, and their
own reports; **New report** opens a form that picks saved queries, orders
the blocks, and takes what each written summary should say. A block shows a
saved query as the query's own view shapes it, so a number or a chart is
changed on the Query page. A home's own page lists its reports.

`/reports/<key>` shows the newest edition, every edition, each headline
number's trend across them, the layout's versions, and two editions side by
side. The routes under `/v1/reports` read; agents use `get_report` and
`check_report_layout`. The grammar is in docs/modelling.md, Reports; the
actions in docs/actions.md, Reports.

Reports are catalog data and frozen snapshots for people. A live time series
from a metric or log store stays in the observability tool. Editions are kept
`REPORT_KEEP_DAYS` (Run it, below).

## Datasets

A table kept in a store outside the catalog, such as a warehouse view, is
published as a **dataset**: a read tool with a `dataset` block that names
its columns. A saved query reads it beside the catalog, as the source
`$data:<id>`, so people filter, group, total, and chart it on the Query
page, and a report reads it like any saved query. Its command runs on a
runner under the runner's identity, so the hub holds no key to the store;
its answer is kept for a while and read again when stale. Who may read one
is the action's own access. `GET /v1/datasets` lists the ones the caller
may read, and agents use `list_datasets`. docs/modelling.md, Datasets, has
the definition and its limits.

## Layout

```
src/shared     model, filter, icon names, and wire types (server and web)
src/server     Hono API, Postgres, runs and lifecycle, rules, checks, alerts, scorecards, actions, MCP
src/web        React app
sdk            Go module for pushers and runners
cmd/orrery     the command line: a person's commands, and a machine's
cmd/pusher-k8s in-cluster pusher
cmd/pusher-entra Entra pusher: apps, assignments, groups, users, requests
cmd/entra-grant  gives a person access in Entra, for a runner job
cmd/azure-restart restarts an Azure app or virtual machine, for a runner job
cmd/azure-job-start starts an Azure Container Apps job, for a runner job
cmd/telemetry-query reads logs from Loki and metrics from Prometheus, for a runner's tool
cmd/job-starter starts one container for each run of a job action, on Kubernetes or Azure Container Apps
cmd/internal   workload identity sign-in, the Microsoft Graph client the Entra commands share, and the Container Apps jobs client
cmd/runner     health check runner
docs           the modelling guide and the self-service guide
scripts        vendors the brand icons into the web app
```

```bash
make check     # typecheck, tests, web build, go vet, go test
```
