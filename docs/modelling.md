# Modelling guide

How to put an estate into Orrery so that it stays consistent as it grows.

Orrery ships no model. A new hub holds only its own `orrery_source`,
`orrery_runner`, `orrery_schedule`, `orrery_report`, `orrery_report_edition`,
and `orrery_safe_path`. An estate brings its model itself: a file through Model →
Import in the web app, a catalog file in a git source, or the blueprints its
pushers offer. The rules in this guide hold for any model.

## Naming blueprints

Orrery holds any concept for any industry. Name blueprints by one method, so
that blueprints designed for one estate work in the next, and an estate only
adds what is its own.

**Every blueprint belongs to one pack, and its id says which.** An id is
`<prefix>_<thing>`, in lowercase letters, digits, and underscores. The title
stays plain ("Service"). The blueprint's `group` is its section in the
catalog's menu, not its pack: every estate has the same sections in the same
order, so people find a thing in the same place at every company. They are
Catalog, each cloud by its name, On-premises, Kubernetes, Network,
Organization, Finance, each workplace or home system by its name, Operations,
and Orrery. A thing gets no section because there is a lot of it: container
images are in Catalog, and security findings in Operations. A pack names each
blueprint's section and icon.

**Core is small and has no prefix.** An idea belongs in Core only if a
pharmacist, a plant manager, and a platform engineer would all mean the same
thing by it: organization, department, team, person, customer, vendor, site,
`program`, `project`, `program_portfolio`, `business_capability`. Those ids
are the standard's words for the ideas. An estate that says one another way uses its own word everywhere the
idea shows, its id, title, and every shared relation to it: where staff call
a customer an account, the blueprint is `account` and so is the relation.
Only Core is named per estate; pack ids are the same everywhere. A word that fails the test gets a pack, even
when the estate has one meaning for it today. "Service" is a service line in
a hospital and field service in a plant, so software's is `sw_service`.

**Each pack has a prefix.**

| Pack | Prefix | Holds |
| --- | --- | --- |
| Software engineering | `sw_` | repositories, services, APIs, workloads, environments, pipelines, releases, deployments, container images |
| Finance | `fin_` | the organization's own books: what it pays for on a recurring bill, what it bills customers |
| FinOps | `finops_` | what IT spends on cloud and software: invoices, invoice lines, purchases, billing periods, software subscriptions, program cost allocations, program portfolio costs |
| IT operations | `it_` | hardware, workstations, virtual machines, mobile devices, incidents, support tickets, machine identities, risks |
| Security | `sec_` | vulnerabilities, findings |
| An industry's own | its own | `mfg_` manufacturing, `rx_` pharmaceutical, and so on, made by the estate that needs it |

A prefix is taken once and never means two things.

**Claim only the meaning you hold.** A blueprint has three names, and each
does one job. Its id is the precise meaning, and it is taken for good. Its
title is the plain word people say, and other blueprints may share it. Its
section, the `group`, keeps blueprints that share a title apart: wherever the
hub shows a title another blueprint shares, it shows the section beside it,
as "Portfolio · Finance".

- Before taking an id, ask what else the word means: in another department,
  in another industry, or in this organization later. If it means anything
  else anywhere, qualify it: `program_portfolio`, not `portfolio`. A
  college's art, finance, and strategy departments can each have their own
  portfolio blueprint, all titled "Portfolio", in their own sections.
- A prefix scopes the field, not the meaning. `fin_` says finance, not which
  invoice. What one team tracks of its own takes that team's field: IT's
  cloud and software spend is `finops_`, so the company's finance keeps
  `fin_`, and IT's risk register is `it_risk`, so a company-wide register can
  come later.
- A bare id is for Core only, and only for a meaning every industry shares:
  `business_capability`, not `capability`, because a plant means a measure
  of a process by it.
- When in doubt, take the longer id. A narrow id can be widened later; a
  wide one, once taken, blocks the next meaning.

**Separate lists for separate things.** A pack splits a thing into its own
blueprints when people keep them as separate lists: different owners,
sources, fields, or life. A `kind` field only sorts inside one list. So
hardware, workstations, virtual machines, and mobile devices are four
blueprints, not one list of devices, and a cloud's machines stay in the
cloud's own list. Every estate weighs one long list of many kinds against
several short lists of one kind each: it may split a list further, or keep a
system's own list (a `vmware_vm`) as its virtual machines, but never merges
lists into one.

**A system's own objects are named after the system.** What one product's
pusher reads carries that product's prefix (`k8s_`, `argocd_`, `azure_`, `entra_`,
`proxmox_`, `github_`) and is defined by the pusher, not by a pack. `orrery_`
is the hub's own.

**Entra.** The Entra pusher brings its own lists: `entra_app`,
`entra_user`, `entra_group`, and `entra_app_role_assignment`, one per user or
group given a role on an app. It links a user to the core `person` only when
the estate imports, once, the relation rule that matches them by email:

```yaml
relationRules:
  - id: entra_user.person
    blueprint: entra_user
    relation: person
    match: { target: person, where: "target.email == source.email" }
```

`it_approval` is the IT pack's record of a request someone decides: one
Entra holds, which the pusher writes, or one asked for through an action
(`docs/actions.md`, Requests and approvals). Beside it, `it_access_review` is
the record of one person's sign-off of one application's access: who kept
access, who lost it, and when. An action on the application writes it, and
removes what the reviewer took away where Orrery can (`docs/actions.md`,
Reviewing access).

`it_application` is the IT pack's list of the applications people in the
organization use: a defined deployment someone signs in to or opens, whether
installed on their machine (a mail client), cloud-hosted on another
company's platform (an issue tracker bought as SaaS), or self-hosted here (a
deployment tool, a portal built in-house). An application is not a service.
Most services are jobs, APIs, backends, or products sold to customers, and
never become applications; an application links to the services it is
built from only when they were built here, and through them to their
repositories. It is inventory a person keeps, a short list that changes
slowly, kept by the portal that shows it (My Apps offers the blueprint).

| Field or relation | Means |
| --- | --- |
| `hosting` | `installed`, `saas`, or `self_hosted` |
| `url` | where people open it; for an installed one, where to get it |
| `lifecycle`, `tier`, `description` | the shared names |
| `access`, `access_role`, `access_groups` | how a person gets it: `open`, `direct` with a role, `group` through the groups named, or `package` |
| `assign_teams` | the teams that may grant it; the action that reads it guards it, so only an admin or a holder of `access.values` changes it |
| `sign_in` | the `entra_app`s people sign in through, test and production alike |
| `services`, `workload`, `api` | what it is built from, deployed as, or the outside API it is |
| `team`, `business_capabilities` | the shared names |

**A classification is its own blueprint, in its own pack.** A scheme that
sorts things (platform pillars, cost centres, product families, therapeutic
areas) is a blueprint of the pack it belongs to, never one shared "domain"
reused for several schemes. It has `order`, `description`, and an optional
`parent` to itself for a hierarchy. Things link to it by a relation named
after it (`pillars`), and its pack may add that relation, and the fields that
place a thing inside the scheme (`category`), to another pack's blueprint.

**Shared names fit the packs together.** A blueprint in any pack that needs
one of these uses exactly this name:

| Name | Kind | Means |
| --- | --- | --- |
| `team` | relation to `team` | owned by |
| `person` | relation to `person` | the one person accountable for it or using it |
| `site` | relation to `site` | where it physically is |
| `program` | relation to `program` | who pays |
| `vendor` | relation to `vendor` | who supplies it |
| `customer` | relation to `customer` | who it is for, under the estate's word for a customer |
| `business_capabilities` | relation to `business_capability` | the capabilities it serves |
| `parent` | relation to its own blueprint | the one above it in a hierarchy |
| `description`, `notes` | fields | one line, and the long story in markdown |
| `lifecycle` | enum field | `planned`, `active`, `retiring`, `retired` |
| `*_cents`, `*_at`, `*_count` | fields | money in the currency's smallest unit, a time, a count |

Any other relation to another pack's blueprint is named after the target's
thing without its prefix (`services`, `repository`), plural when it holds
many.

**A rename keeps the old name.** A blueprint or a relation moved to a new name
keeps the old one under `formerly`, as Changing the model says, so writers and
readers move at their own pace.

## An example: a software estate

The blueprints this guide names are one example, a model for an estate that
builds and runs software, named by the method above. An estate that models
something else keeps the rules and brings its own blueprints. Delivery,
Exposure, and Money below name blueprints the same way: they are the names to
use when an estate models those things, not blueprints the hub has.

### The pieces

| Blueprint | What it is | Who makes it |
| --- | --- | --- |
| `sw_repository` | A repository on a forge | A forge pusher |
| `sw_service` | One deployable piece of software, homed in a repository | A person |
| `program` | A body of work someone owns and pays for. Can span repositories | A person, or a pusher that reads the list of them |
| `sw_workload` | Services that are deployed together | A person |
| `sw_api` | An interface a service provides to consumers | A person, a pusher, or an uploaded specification |
| `sw_environment` | A place software runs as a whole: production, test, QA | A person |
| `business_capability` | A high-level concern that cuts across programs | A person |
| `organization`, `department`, `team`, `person` | Who owns things | A person |
| Whatever runs things | Clusters, cloud resources, VMs, ArgoCD applications | Pushers |
| `sw_deployment` | One rollout | Pushers |

### Its rules

**A service lives in a repository.** That is the only "inside of" in the
model. A repository that holds several services is normal: each service names
the repository, and `path` says where in it.

**A workload comes from how things are deployed, not from who owns what.** A
workload lists its services. One service may be part of several workloads, and
a service that is deployed alone needs no workload at all. One workload is
deployed to as many environments as it needs; it is not made again per
environment.

**Each service, workload, and repository names its program.** Nothing is
implied. A service homed in one program's repository may be part of another
program's workload, and both facts stay true.

**A capability is a concern, not a parent.** Identity, billing, shipping.
Anything that takes part in it names it in `business_capabilities`: services,
workloads, databases, servers, outside APIs. A thing may name several. Model
the capabilities people talk about across programs. Do not model the modules
inside one application.

**An API is what consumers call.** A service's own administration endpoints
are not one. Every API goes in the one `sw_api` blueprint, whoever writes it
and whoever runs it: `external` and `visibility` are fields, not separate
kinds. An outside API earns a row when a service of the estate calls it,
such as Microsoft Graph or an email provider, so the row can carry its
consumers. A cloud's own services are not APIs: the cloud pusher catalogs
the resources, and the management API every one of them has links to no
service.

**Set ownership where it is known.** `team` inherits. A program owned by one
team needs the team set once, on the program. Where one workload or one
service belongs to someone else, set it there and it wins there.

**Let a record about a thing be seen by whoever sees the thing.** A finding,
a verdict, or a review names what it is about through a relation. Close the
blueprint to everyone, then name those relations in its rule's `subjects`:
whoever may see a resource sees the findings about it, and the findings
follow when access to the resource narrows. Never open such records to
everyone so the people who must act on them can read them. Leave out a
relation that names no subject, such as the pillar a finding sits under.

**Keep a timeline to the people who run the thing.** An entity's timeline
says what changed on it, who changed it, and what it replaced. Whoever sees
the entity reads it, until the blueprint's `timeline` rule names who does.
Give one to a blueprint whose changes say something about a person, such as
the people themselves: an audience of the access policy that runs the
estate reads it, and everyone else still sees the entity as it stands.

**Give each kind of responsibility a pair.** A team whose job it is, and a
person who answers, the person inheriting the team's lead: `team` and
`owner` for the thing itself, and as many more pairs as the estate has
layers, such as `app_team` and `app_owner` for what runs on a machine,
`platform_team` and `platform_owner` for what it sits on, or `qa_team` and
`qa_owner`. Use the same names on every blueprint, so one `owns` path in the
person setting covers them all. Naming a person on one entity never takes it
from the team: the lead still reaches it through the team, and
`{ as: team, path: <-lead.<-team }` puts it on their Now.

**Delegating upkeep never moves ownership.** When the team that owns a kind
of asset hands its day-to-day upkeep to another, such as DNS records or
employee accounts to a systems team, the owner keeps the platform pair and
the team that does the work takes `team` and `owner`. Both see it on their
Now, each by their own role.

**Keep a person's address in a `user` field.** Who asked, who decided, who
ran it: a source often knows a person only by their sign-in address. Type
that field `user`, never `string` or `email`. The grid and the entity page
show a `user` value as a link to the person the person setting finds by that
address, under their name, to a reader who may see them; to anyone else,
and for an address that is nobody here, it stays the address. A field links
to the person and never makes them an owner: ownership walks relations, so
name a person a thing answers to with a relation, as above.

**Let the entity pick the default.** When the team depends on the entity, as
a backend service takes its program's backend team and a frontend one the
frontend team, give `inherit` ordered cases with a `when`. Where nothing
above an entity holds a default, such as a workstation, end the cases with a
fixed `target`.

**Ownership is not a tag.** A cloud tag describes what a resource is: its
program, environment, and exposure. Who answers for it changes with people,
not with the resource, so it is set in the hub and inherited from the program
the tag names, never written into infrastructure code.

**Set the environment where things run.** `environment` inherits too. When a
whole subscription or cluster is production, say so on the subscription or
the cluster. When one holds several environments, leave it unset and say so on
each resource group or namespace.

**People author in the web app.** Programs, workloads, services, and
capabilities are made and changed there. Nothing in a code repository has to
describe itself to the hub. A repository may: see Landscape.

## Linking what is discovered

A running thing finds its service by a relation rule. The Kubernetes links
template on Model → Import brings these two, for a model that has
`sw_service`, `sw_workload`, `sw_environment`, and `team`:

| Thing | Finds | By |
| --- | --- | --- |
| Kubernetes workload | its service | the `app.kubernetes.io/name` label equals the service's key |
| ArgoCD application | its workload | its name equals the workload's key |

These are ordinary relation rules, on the Model page under rules. Change the
label, or add a rule for another platform:

```yaml
relationRules:
  - blueprint: azure_resource
    relation: service
    match: { target: sw_service, where: "target.key == source.tags['service']" }
```

A rule's link is the lowest thing above inheritance: anything a pusher sets,
or a person sets, wins over it.

## Bringing in your own platform

A pusher brings the blueprints it writes. To tie them into the model, add the
relations with a file of your own and import it. A blueprint that exists gains
what it lacks, so the file only has to name what is new:

```yaml
blueprints:
  - id: azure_subscription
    title: Azure subscription
    relations:
      environment: { target: sw_environment }
  - id: azure_resource_group
    title: Azure resource group
    relations:
      environment: { target: sw_environment, inherit: subscription.environment }
  - id: azure_resource
    title: Azure resource
    relations:
      service: { target: sw_service }
      environment: { target: sw_environment, inherit: resource_group.environment }
      team: { target: team, inherit: service.team }
  - id: sw_service
    title: Service
    status: { relations: ['<-azure_resource:service'] }
```

The last entry makes a service's status the worst of the resources that run
it.

An entity can also report its own status through an enum field of `red`,
`amber`, `green`, and `grey`, named by `status: { field: health }`. Write a
`health_reason` string beside it whenever the value is not green: the hub
shows it next to the status wherever the status is shown, so a person sees
why without reading the pusher. A timestamp in the reason, such as
`a client secret expires 2026-11-12T08:03:00Z`, is shown as a span from now.
Red is for something broken or about to break now; something that needs
attention before it breaks is amber.

## Currency

The hub has one number type and no decimal. Keep money as a whole number of
the currency's smallest unit, and say so in the field:

```yaml
cost_cents: { type: number, format: { kind: currency, currency: USD, minor: true } }
```

`123456` is shown as `$1,234.56` in tables, cards, and the entity page, and
the editor takes `1234.56`. The format is display only. The field is still the
stored number to a sort, a filter, an aggregation, and a calculation, so a sum
of cents is exact. A value with a fraction is refused on a `minor` field. A
`currency` is a three-letter ISO 4217 code, and only a `number` has a format.

## What belongs in the catalog

Every blueprint is one of four kinds. Decide which before adding one, and say
which in its description.

| Kind | What it is | How long it stays |
| --- | --- | --- |
| Inventory | A thing that exists: a service, a repository, a pipeline, a machine, a subscription. It carries its current status, and each push overwrites it | While a source still sees it |
| Record | Something a person acts on and answers for: an invoice, an incident, a help desk ticket, a risk | Its retention, said in its description |
| History | Something that happened and is worth counting: a release, a deployment | Its retention, set as `lifecycle.expire` |
| Noise | Anything else | Never kept |

A record earns a blueprint when a person acts on it, it links to inventory,
losing one is a real gap, and its number grows with the business rather than
with machine activity.

History is allowed only with `lifecycle.expire`, counted from the field that
says when it happened:

```yaml
lifecycle:
  expire: { after: 730d, field: released_at }
```

Noise is never a blueprint: a run, a build, a job execution, an intermediate
build output such as a package handed to a deploy, a commit, a log line, a
metric point, or an alert below incident level. The inventory entity carries
the latest result, and a link goes to the system that keeps the rest.

What a model costs the hub shows on its Load page, and a hub may hold it to
budgets set there. Five habits keep a model inside them:

- **Send what changed.** A value that moves on every run, such as a time the
  source looked or a counter, makes every push a change, and each change is
  derived again with everything that reads it. Leave it out, or round it to
  what a person needs.
- **Count what repeats.** A counted column is counted under the grid on
  every build. Mark a text, address, or person field a chip when a few
  values repeat across many rows, such as a state or who asked; leave a
  name that is nearly always new, a street address, or an id as text. A
  chip of many values, such as a version, keeps its look with its count off
  (`spread: false`). The Load page's **Columns: counts** says which fit each
  way.
- **Let what happened expire.** History without `lifecycle.expire` grows
  for ever, and every grid of it counts every row.
- **Roll up in steps.** A field that aggregates over thousands of entities
  is worked out again when any one of them changes. Aggregate onto the
  thing one level up, and from there onto the next.
- **Read once and listen.** A consumer pages through a list once, keeps what
  it read, and follows the events stream for what moves. One that pulls
  whole lists in a loop is held by its budget of calls.

How a measure moved over time is not a blueprint either. Mark the derived
field `history: { keep: 730d }` and the hub keeps a point each time its value
moves; a `trend` field with `history: { of: <field>, every: 1w, last: 104w }`
draws it. `metric: true` exports the field as a gauge for dashboards and
alerts on recent windows. Mark only the few measures someone watches: each
marked field is a point per entity on every move and, with `metric`, a series
per entity.

## Reports

A report is a team's recurring summary kept in the hub: a weekly view of
test runs, a month's costs, a fleet's health. It is defined once and
published again and again, by a person or a schedule, and every published
copy is kept to read and compare later. The hub keeps both itself, in two of
its own blueprints:

- **Report** (`orrery_report`), inventory: one report people own. It holds
  its owner, its layout and the layout's version, its data sets, its
  writer, its recipients, and the newest edition's summary and headline
  numbers. It belongs to one home, usually a team, through a
  `home_<blueprint>` relation. Its schedules are the schedules of its
  publish action, under **Schedules** on its page.
- **Report edition** (`orrery_report_edition`), history: one published copy.
  It holds its number, when it was published, what it said in a line, its
  headline numbers, the layout version it used, who or what started it,
  and links to its body and its data. It expires `REPORT_KEEP_DAYS` (730 by
  default) after it was published.

A run is noise, and never an entity. An edition is something people read
and compare, as a release is.

Whoever may see a report's home sees the report, and whoever sees a report
sees its editions. Its owner, the people who own its home, and admins change
and publish it. An admin may widen who sees reports under Access, as for the
hub's other blueprints.

People meet reports on the **Reports** page: the newest editions first, then
their own. A report opens on its newest edition; its record, its schedule,
and its layout stand one click behind it. A home's own page lists its
reports.

**The Query page shapes; a report composes.** A report puts saved queries in
order, says what changed in words, freezes the result as an edition, and
sends it. It has no filters for its reader, no drill-down, no visuals beyond
its four blocks, and no math of its own beyond a stat over a column. A
number or a chart is changed in its query. What a reader must click to
change belongs on the Query page, or in the estate's analysis tool, and a
report links to it.

### The layout

A layout is a short Markdown document. Front matter names the data sets and
the writer. Then come headings, plain paragraphs, and fenced blocks. Each
block is a small YAML map. Nobody writes HTML: the hub draws every edition
in one style, for its page and for mail.

````markdown
---
writer: write_prose            # a runner tool on orrery_report; needed only for narrative blocks
covers: 7                      # the days each edition covers, its publish day the last; left out, none is said
data:
  suites: { query: q_8f2c }    # a saved query, read as the report's owner
  flaky: { tool: flaky_tests, entity: repo:api, inputs: { days: 7 } }   # a runner tool, called as the owner
---

# Weekly test automation

What ran across the team's suites this week.

```stats
data: suites
items:
  - { name: passed, title: Passed, of: sum, column: passed, better: up }
  - { name: failed, title: Failed, of: sum, column: failed, better: down, good: 0, bad: 10 }
  - { name: suites, title: Suites, of: count }
```

```narrative
data: [suites, flaky]
instruction: Say in two sentences how the week went, and name the worst suite.
```

```chart
type: delta                    # trend, bars, or delta
title: Failures by suite
data: suites
x: title                       # the label, or the column along the bottom for a trend
y: failed                      # the number; a trend takes a list
```

```table
data: flaky
columns: [test, failures]      # left out, every column
limit: 20                      # at most 200
health:
  failures: { good: 0, bad: 5 }   # marks each number: on track, to watch, or off track
```

```scorecard
title: Suites
data: suites
label: title                   # what names each row; left out, the first column
columns: [pass_rate, nights_lost]
health:
  pass_rate: { good: 95, bad: 90 }
  nights_lost: { good: 0, bad: 2 }
trend: { columns: [week_1, week_2, week_3, week_4], title: Four weeks, good: 80, bad: 50 }
```
````

| Block | What it shows |
| --- | --- |
| `stats` | Headline numbers. Each item's `of` is `count`, `sum`, `avg`, `min`, `max`, `first`, or `last` of a `column`. Its `name` is the number every edition keeps; `title`, `unit`, `decimals` (0 to 4), and `better` (`up` or `down`) say how it reads. Each shows its change since the edition before. With no `items`, it shows what its data set brings: each total its saved query adds up (kept as `<data set>_<column>`), or how many rows it holds. |
| `chart` | `trend`: a line for each `y` column along `x`, in the rows' order. `bars`: one bar a row. `delta`: each row's `y` beside the same `x` in the edition before. What it leaves out it takes from its data set: a grouped query's groups and the column its own chart adds up, else bars of the first number column by the first column. |
| `table` | The rows of a data set, the first `limit`. `health` judges a shown column's numbers by two marks. |
| `scorecard` | One row a thing: its name, a mark for the worst of its judged numbers, its `columns`, and its `trend` as small bars, one a column, oldest first (at most 12). `health` judges a column, shown or not: one it does not show marks the row and colours no cell. `good` and `bad` on `trend` judge each bar; a zero stands as a line on the floor, and a week not read as nothing. |
| `narrative` | Prose written by the writer from the data sets it names, and the headline numbers. The writer may use a little Markdown, which the hub draws: headings, lists, tables, bold, italic, code, and links to an http address. Everything else is shown as text. A later block that says only `rest: true` goes on from it: the narrative then stands as its first paragraph alone, set apart as the lead, and the rest of its prose is drawn where that block stands. |

The shortest block names only its data: `data: cost` under `stats`,
`chart`, or `table` shows the saved query as the query shapes it. That is
what the form on the Reports page writes.

A number is judged by two marks, `good` and `bad`, set together: on a
`stats` item, or for a column under `health`. Higher is better where `good`
is the larger, and lower where it is the smaller. A number at or past `good`
is on track, one short of `bad` is off track, and one between is to watch.
Each is drawn as a shape with a name and a colour. A layout sets no colour.

A mail opens with the report's home, its title, and its date in the time
zone of the schedule that fired it, or its owner's when a person published
it. In a mail a `trend` is columns, drawn from a little under its least
number where its numbers stand far from zero, and it says where it starts.

A plain paragraph of a layout may hold links, bold, italic, and code, as a
writer's prose does. A paragraph that is one link alone is drawn as a
button.

A tool answers a list of rows, each an object of column values. To say how
its columns read, it answers `{ columns, rows }` instead: each row a list of
values, and each column its id, or `{ id, title, unit, decimals }`. A table
and a scorecard head the column with its title and say each of its numbers
with its unit and places. A saved query's columns bring their own titles.

A column is named by its id or its title. Numbers always come from data
sets; only a narrative block reaches a model, and only with the data the run
read.

A layout that does not read is refused before anything runs, with every
problem and its line: an unknown block, key, or data set, a stat named
twice, a saved query the owner may not read, a tool that is no tool. Agents
check one with `check_report_layout`, and people see the same message on the
form. A data set that fails to read at publish, or a writer that fails, is a
gap the edition says, never a failed publish.

### Data sets and the writer

A **query** data set is a saved query, read in the owner's view, as its own
view shapes it. A view that groups gives one row a group: the values it is
grouped by, `rows` (how many it holds), and each total it adds up, as
`<column>_<total>`. Any other view gives its rows, narrowed and ordered. The
totals over every row ride along for a `stats` block. A **tool** data set is a
runner tool that prints a table as JSON: a list of objects, or
`{ columns, rows }`. It runs on `entity`, or on the report when it is a
tool on `orrery_report` and names none. A data set keeps at most 5,000 rows.

The **writer** is a runner tool on `orrery_report` with two inputs,
`instruction` and `data`. Its command calls whatever model the estate uses
and prints the prose. The hub never calls a model.

```yaml
id: write_prose
title: Write a report's prose
blueprint: orrery_report
inputs:
  instruction: { type: text, required: true }
  data: { type: attachment, required: true }
backend:
  type: runner
  runner: reports-runner
  command: [report-writer]
  env: { INSTRUCTION: "{{ inputs.instruction }}", DATA: "{{ inputs.data }}" }
tool: { tier: read }
```

Every data set and the writer are read **as the report's owner**: a saved
query through their view, a tool with the tiers they hold. So a report
never shows what its owner cannot see, and the owner needs the writer's tier
on the report: the publish action carries it (`access.tiers: [read]`).

### Running a report

Everything a report does is an action with the `report` backend
(docs/actions.md, Reports): create, edit, put an older version back,
preview, publish, change recipients, and remove. An edit form fills the
current layout in with `default: "{{ entity.fields.layout }}"`. The hub
brings these actions itself (`orrery_report_new`, `_edit`, `_restore`,
`_preview`, `_publish`, `_recipients`, `_hand`, `_remove`), so an estate
defines none to start; it defines its own beside them only to add an
approval or a rule.

A preview reads its saved queries afresh, since they are what its author
just changed, and takes a tool's rows from the newest edition while the
layout asks the tool the same; `fresh` reads everything. It keeps the
drawing with its run alone. A publish keeps the next edition and sends it to
its recipients through the notification desk, each only while they may see
the report. The letter is the edition itself, drawn for mail. A recipient
who never signed in is judged as they would be on arriving: the access
rules decide, not whether they have visited. To publish on a schedule, schedule the publish action on the
report; run now, pause, and resume are the schedule's.

**Hand over** gives a report to a new owner, with every schedule that
publishes it. Its data is read as them from then on, so the hub refuses the
move unless they sign in, may see the report, and can read every saved query
and call every tool its layout names.

### What a report is not

Reports are catalog data and frozen snapshots for people. A live series from
a metric or log store stays in the observability tool, where it is kept and
queried; a report is never a metric explorer. A number worth watching over
time in the catalog is a `history` field and a `trend`, as above; a report
draws its own numbers across its editions.

## Datasets

Some facts live in a store outside the catalog and belong there: a
warehouse's tables, a lakehouse's views. Copying them into entities makes
two stores to keep in step. A **dataset** lets a saved query read such a
table beside the catalog instead, so people filter, group, total, and chart
it on the Query page, and a report reads it like any other saved query.

A dataset is a read tool with a `dataset` block. Its command runs on a
runner, under the runner's own identity, and prints the rows as JSON (a list
of objects, or `{ columns, rows }`). The hub holds no key to the store.

```yaml
id: nightly_runs
title: Nightly test runs
description: One row a pipeline a night, from the quality lakehouse.
blueprint: lakehouse                 # the kind of record the store is in the catalog
tool: { tier: read }
dataset:
  entity: lakehouse:quality          # the record it reads: the tool is called on it
  fresh: 15m                         # how long an answer is kept; 15m when left out
  columns:
    - { id: pipeline, title: Pipeline }
    - { id: night, type: datetime }
    - { id: passed, type: number }
    - { id: pass_rate, title: Pass rate, type: number }
access: { audiences: [quality] }     # who may read it; left out, only who holds the read tier there
backend:
  type: runner
  runner: reports-runner
  command: [read-view, quality.nightly_runs]
```

- **One dataset is one table**, already at the grain people ask about. The
  tool takes no inputs, and its answer is at most what one tool call
  carries (64 KB), so publish a summarised view, never a raw fact table.
- **Its columns are declared**, each a `string`, `number`, `boolean`, or
  `datetime`, so a column sorts, filters, and adds up as its type before any
  row is read. A column the tool does not answer is empty; one the dataset
  does not name is dropped.
- **Who may read it** is the action's `access`, set by an admin as on any
  action, or the `read` tier on the entity it names. A dataset is the one
  tool with access of its own. A shared query that reads a dataset leaves
  it out for a reader it is not open to.
- **A read is a run** of whoever read it, in the ledger like any tool call.
  An answer is kept for `fresh`, so a query costs a runner's job only when
  its rows are stale. **Refresh** on the Query page reads it again.
- **In a query it is the source `$data:<id>`**, and its columns are its
  fields. It reads beside blueprints, never joined to them: a report puts a
  dataset query and a catalog query side by side, and a written summary may
  read both.
- **Only an admin, git, or a source its runner names defines one**, as for
  any tool: its command runs with the runner's key.

Keep to this: an entity is something the estate has or did, with an owner
and a page. A table of measurements about it, kept and queried well
elsewhere, is a dataset.

## Delivery

| Blueprint | Kind | One per | Kept |
| --- | --- | --- | --- |
| `sw_pipeline` | Inventory | CI/CD pipeline | While the forge has it |
| `sw_release` | History | Version of a service | 730 days from `released_at` |
| `sw_deployment` | History | Rollout of a version to an environment | 180 days from `deployed_at` |
| `sw_container_image` | Inventory | Tag in a registry of our own; a tag from anyone else's only while something runs it | While the registry has it |

A pipeline run is never an entity. The pipeline carries what its runs say:

| Field | Type | Meaning |
| --- | --- | --- |
| `system` | enum `github`, `gitlab`, `azure_devops` | Where it runs |
| `url` | url | The pipeline's page |
| `default_branch` | string | The branch its numbers are counted on |
| `last_status` | enum `success`, `failed`, `running`, `canceled`, `other` | Its newest run on the default branch |
| `last_run_at`, `last_run_url` | datetime, url | That run |
| `recent_runs` | array | The newest five runs, newest first, each `{status, at, url, duration_seconds}` |
| `runs_7d`, `runs_30d` | number | Finished runs in each window |
| `success_rate_7d`, `success_rate_30d` | number | Percent of finished runs that succeeded; empty with no runs |
| `trend_week`, `trend_month` | enum `improving`, `steady`, `worsening` | The window's success rate against the window before it: ten points or more up is improving, ten or more down is worsening; empty when either window has no runs |
| `duration_p50_seconds` | number | The median length of the successful runs in the last 30 days |

A pipeline links to its `sw_repository` through `repository`. A container
image is a published artifact: a registry of our own keeps every tag, and a
workload links to the images it runs.

## Exposure

A machine or an image carries its software and known vulnerabilities as
fields, whatever reads them:

| Field | Meaning |
| --- | --- |
| `software_count` | Packages or applications found |
| `cve_total`, `cve_critical`, `cve_high` | Known vulnerabilities, all and by severity |
| `cve_kev` | Those in the CISA Known Exploited Vulnerabilities catalog |
| `cve_fixable` | Those with a fixed version available |
| `epss_max` | The highest EPSS score among them |

Only a notable vulnerability becomes a `sec_vulnerability` entity: one in
KEV, rated Critical, or with an EPSS of at least 0.1. Every other one is only
counted on the machine or image. A vulnerability is keyed by its CVE id and
carries `severity`, `cvss`, `epss`, `kev`, `kev_due`, `fix_state`,
`fixed_in`, `description`, and `url`, with one relation for each blueprint it
is found on, named after that blueprint's thing without its prefix
(`hardware` for `it_hardware`, `workstations` for `it_workstation`, `images` for `sw_container_image`). A record that
names a machine, such as a risk, reads its exposure through that link.

## Money

What IT pays for software and cloud is FinOps's own. Two blueprints hold it:

| Blueprint | Kind | Fields |
| --- | --- | --- |
| `finops_software_subscription` | Inventory | `vendor`, `product`, `plan`, `status`, `billing_model`, `seats`, `first_billed`, `last_billed`, `next_billed`, `yearly_cost_cents`, `url` |
| `finops_invoice` | Record | `vendor`, `billing_account`, `invoice_date`, `period_start`, `period_end`, `amount_cents`, `currency`, `status`, `document` |

A `finops_invoice_line` is one charge on an invoice, linked to the invoice and,
where it bought one, to its subscription. A subscription links to what it
serves.

Money is held close with a field class, not a rule on each field. Name every
amount so one pattern finds it wherever it lands: a cost ends `_cents`
(`cost_month_to_date_cents`, `amount_cents`), and a budget starts `budget`.
A class matching `*_cents` then covers a new blueprint's money the moment it
arrives. A field that looks like money but is not, such as a public tax line,
is left out of the class with its reason.

## Who writes what

The system of record pushes, and the catalog links. A register that owns a
list (reservations, risks, vendors) pushes it from its own
records, and its owner keeps changing it there. A person types an entity in by
hand only for a short list of valuable things that change slowly. A list that
grows on its own, or that a person would have to keep up, needs a source that
pushes it, or it stays out.

## Landscape

The landscape is every piece of software the platform runs or calls, placed
on the concerns it covers, and the flows between them. It needs no
blueprint of its own:

| Thing | Blueprint | Key |
| --- | --- | --- |
| Software built here | `sw_service`, `origin: built` | its repository path, such as `github/acme/tally/cmd/tally` |
| Open source the estate runs | `sw_service`, `origin: adopted` | its upstream repository, such as `github/argoproj/argo-cd` |
| A service someone else runs, only called | `sw_api`, `external: true` | `<vendor>/<api>`, such as `cloudflare/api` |
| What a service offers others | `sw_api`, with its `service` | `<service key>/<id>` |
| A flow that works | `sw_service.consumes` to an `sw_api` | |
| A flow still to build | `sw_service.will_consume` to an `sw_api` | |

An estate places its services on its own scheme of concerns, a
classification of its own (see Naming blueprints): a service names every
concern it covers, so overlap is several, and a field such as `category` is
its box inside one. The software side of a service, these fields and
relations, is the same in every estate that runs it; where it runs, what it
costs, and how it is doing belong to the estate.

**A repository describes the service it builds.** It keeps an `orrery.yaml`
at its root, or beside each service when it builds several: its key, the APIs it `provides`, and the API keys it `consumes`
and `will_consume`; its logo under `icon:`, a custom icon name and a file in
the repository (`icon: { name: tally, file: logo.svg }`, both or neither);
and, when the software belongs to one estate, its place in that estate's
scheme under `fields:` and `relations:`, written onto its service as they
are. Software meant for any estate leaves them out, and each estate places it
in its own scheme. The forge reader that reads the repository for an estate
reads the file with it and writes the service, its logo, its connectors, and
each API it provides. So an estate lists the services of the repositories it
reads, and nothing else: a running app never writes its own description, and
an estate that runs an app from a repository it does not read sees its
workload and its image, never its service. A file whose key is not its
repository's, or a folder in it, describes nothing; one in a folder names a
service at or under that folder. Software that has no
such file, such as open source the estate runs and services only called, is
written by a person or a catalog file. Its mark is a built-in brand icon when
the set has one, and otherwise a custom icon in the catalog repository's
`icons/` beside its catalog files.

## Shared names

The same idea has the same name in every estate, so an agent that knows one
knows the other:

| Idea | Blueprint |
| --- | --- |
| Someone in the organization | `person`, keyed by their email |
| A body of work someone owns and pays for | `program` |
| Services deployed together | `sw_workload` |
| A stage software runs in | `sw_environment`, with `type` `development`, `pre_production`, or `production`; its key is the name the deploy system uses |
| A code issue: a bug or a feature in a repository | `github_issue`, or the forge's own name |
| A help desk ticket from a person who needs help | `it_support_ticket` |
| The application a grant, a request, or a review is about | the relation `application`, to `it_application`; a system's grant reaches it directly or through the system's own app, as an Entra assignment does through the application's `sign_in` |
| Money | A whole number of the currency's smallest unit, in a field ending `_cents` |
| A key | `<scope>/<stable id>`, never a display name |
| Open source the estate runs | `sw_service` with `origin: adopted` |

## Keeping it honest

- **Scorecards.** A model brings its own. The example model would ask of a
  service whether it is homed, owned, classified, and operable, and of a
  program whether it has an owner and something in it. A scorecard can be scoped to what it should judge, can score
  several blueprints on the same levels, and its level can be read by a
  filter or an aggregation; see "Health, scorecards, nesting" in the README.
- **A judge's scorecard.** When another tool judges (a conformance board,
  a scanner), copy each of its rules, never one tier number: a level then
  shows what it asks, rule by rule. The judge writes, on its record about
  each entity, an object of its rule ids to `pass`, `fail`, or `unknown`
  (it had no data). An aggregation with `fn: checks` reads that object
  onto the entity, the worst answer winning, and is marked a summary so
  everyone who sees the entity sees the answers and nothing else of the
  record. Each scorecard rule is then `judged: { field, check }`, its
  state that entry: a failure and no data both hold the entity below the
  level, and a rule the judge left out does not apply to it. Scope the
  scorecard to `{ field, op: exists }`, what the judge answered on. A
  judge whose source holds the `scorecards` grant puts these scorecards
  itself, so a new rule is a new column with no hand edit.
- **Summaries.** A count or a level worked out from entities only some
  people may see is hidden from everyone else, like the entities. When the
  number is for everyone and the list is not (how many findings stand open
  on a service, the tier it reached, what a judge said of each rule), mark
  the aggregation `summary: true`.
  Readers who may not see the list then get the number and what is worked
  out from it, and nothing of the list. Mark the aggregation, never the
  fields that read it. Only an admin sets it, and it is off unless set. Do
  not mark a count whose size alone gives the list away, such as one over a
  list of one. See "Access" in the README.
- **Findings.** The hub reports a required relation that is not set, a
  relation whose target never arrived, a path in the model that names
  something the model no longer has, a field one source wrote and another
  overwrote, and an entity connected to nothing. That last one is how a
  thing nobody has linked shows up. Mark a blueprint `standalone: true` only
  when its entities are complete on their own, such as a mailing list or an
  invoice. Never mark it to quiet a gap a rule or an owner should fill.
- **Conventions.** Where every blueprint of a group should carry the same
  relations, such as the platform pair on everything a cloud pusher brings,
  declare a relation convention for the group. The hub reports each
  blueprint of the group that lacks one, including one a pusher offers
  later. It never adds the relation: add it in the model.
- **Required relations.** Mark a relation `required` when an entity without it
  is wrong, and the hub lists every one that lacks it. An inherited relation
  counts as set.

## The ground

The ground view is in preview: it shows only to the people an admin opened
it to. The model's part of it is ordinary model, read and written like the
rest, and worth setting before anyone looks.

- **A budget is the estate's own number.** Put `budget: { max }`, `{ min }`,
  or both on a `number` field when there is a value the entity should stay
  inside: minutes a pipeline may take, a share of tests that must pass.
  Write only a budget someone agreed to; a guessed one teaches people to
  ignore it. It is not a load budget: it refuses nothing and raises no
  finding. A budget on a field a source brought is still yours: the source
  keeps the field's rule current and never moves the budget.
- **A model file can carry both.** An import gives a blueprint that exists
  the file's `ground` when it has none, and the file's `budget` on a number
  that has none. To put a budget on a field a source brought, name the field
  in the file with its type and the budget, and nothing else. Change either
  afterwards in the model editor; an import never moves one that is set.
- **Name a ground on the blueprint people tend.** That is the one whose
  entities are each somebody's work, such as a repository or a service.
  `ground` says which field is how long one round of work takes (`loop`),
  how often work gets stuck (`friction`), how much is there that should not
  be (`unwanted`), and how busy it is (`activity`). Leave out a part no
  source counts yet. Never point one at a number that means something else
  to fill the picture.
- **A source counts; the ground only shows.** Each number is a field a
  source writes or the hub derives. Friction has to be counted where the
  work happens, by a source that writes the count here.
- **Keep a past for a number you budget.** Mark it `history: { keep }` and
  give it a `trend` from history, or name the trend a source fills under
  `ground.trends`. The forecast and the weeks read only numbers with a past.
- **`taughtBy` is a relation to where a pattern came from.** Set it when
  one entity was copied from another, so a fault found in one leads to the
  one that taught it and to everything else that learned from it.
- **A template is an entity.** Model what entities are started from as a
  blueprint of their own, with the version current now as a field, and name
  it under `ground.template` with the action that starts a new one. The hub
  ships no template and starts nothing itself; the action hands off as any
  action does.
- **`trial` marks the few that take changes first.** A boolean field, true
  on the entities a change to the platform lands on before the rest.
- **A map shows one holder whole.** Put `map` on the blueprint whose
  entities hold others, such as a program. `places` is the blueprint of the
  places things run, such as environments. `plots` names the blueprint of
  what people tend there, such as services, its relation to the holder, and
  `placedBy`: the blueprint that puts a plot in a place, such as a running
  service, with its relations to the plot and the place. `members` lists
  what else is deployed for the holder, such as apps and databases, each by
  its relations to the holder, its place, and its plot. A member that names
  no plot lies open on its place. `parts` is a to-one relation of the
  blueprint to itself, such as a program's parent: a part's things are drawn
  on its holder's map. An import sets `map` only where none is set.
- **Say which holders come first, and what groups them.** Where a hub holds
  many holders, the page that shows them all at once draws most as small
  dots. `map.primary` names a boolean field of the holder's blueprint: the
  few on which it is true are drawn large and named. Mark the handful the
  estate would name first, not most of them. `map.sector` names a field of
  the blueprint, or a to-one relation of it, such as an account or a
  portfolio: holders that share its value stand together, each on a
  bearing of its own that does not move when its health does. Leave either
  out and every holder is drawn by what it holds, in one group.
- **One shape for every check.** On a map, each scorecard rule, each budget,
  and each guard holds, is broken, or has no data. A rule whose fields hold
  nothing the reader may see has no data; it never counts as a pass or a
  fail. So a missing value never reads as zero.

## Changing the model

- **Rename** a blueprint from the model editor. Its entities, what people
  typed on them, and everything that names it move with it. The old id
  stays in the blueprint's `formerly`: a source, a reader, or an offer that
  still names it reaches the renamed blueprint, so writers can move to the
  new id at their own pace, and no blueprint is made again under the old
  one. A filter that names one of its entities by the old id, such as
  `old_id:key` in an action's input or a saved query, still finds it, and
  the filters in the model are moved to the new id. A catalog file renames a blueprint it defines by giving the new id
  and the old one under `formerly`.
- **Forget a former name** once every writer has moved off it:
  `DELETE /v1/blueprints/<id>/formerly/<name>`. A former name holds its
  word as long as it is kept, so forget one another blueprint may need. A
  writer or a catalog file that still lists it under `formerly` puts it back.
- **Add a field** in the model editor, or from the catalog table like adding a
  column.
- **Import again** after an upgrade to pick up what a newer template adds.
  Nothing you changed is touched.
