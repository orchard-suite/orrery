# orrery

One graph of the estate. Read `README.md` first for what it is; this file is
how the code is shaped and the rules that keep it that way.

This repository is public and estate-neutral. Every name in a test, an
example, or a doc comes from the fixture world:
https://github.com/orchard-suite/hedge/blob/main/docs/fixtures.md.

## Shape

- `src/shared` is the contract: the model (`model.ts`), the search filter and
  relation paths (`filter.ts`), the icon names (`icons.ts`), the layout
  maths (`layout.ts`), the shape and checks of an action's definition
  (`action-spec.ts`), the kinds of input an action asks for
  (`input-kinds.ts`: `INPUT_KINDS` is the one registry, and each kind says
  its title, the options and rules it takes, how a value is checked, when
  it is empty, and how it reads as text), which of an action's inputs a
  run is asked for (`asked.ts`: `askedInputs` is the one decision, in
  declared order, each `when` judged over the inputs above it, and each
  worked-out `value` computed from them; the hub runs it over checked
  values and the form over what is typed, and the hub's answer wins; it
  also puts the asked inputs under the action's `sections`), what a run
  changes in a list the entity holds (`list-change.ts`: a `many` input of a
  kind that does not pick, with `current`; `heldList` is the one reading of
  what `current` renders to, and `listChange` and `runChanges` the one
  reading of the change, as a set, which the form's review, the hub's
  refusal of a run that changes nothing, the run page, the approvals record,
  and `run_action` all share; the hub keeps the list on the run as
  `current`, and the scope gives it as `run.current`), the expression
  language (`expr.ts`: no assignment, no loops, nothing but the names it is
  given; a calculation field reads the entity's own fields with it, and an
  action's worked-out input reads the inputs above it), the access policy (`policy.ts`: audiences, field
  classes, and how a rule resolves through them), the ground (`ground.ts`:
  what a ground says of a blueprint's entities, worked out the same on
  either side), the change statement (`change.ts`: its check against the
  platform kit's schema, its canonical form, and how it reads in words; the
  schema and the worked examples in `change/` are copies of the platform
  kit's at the version `go.mod` requires, held to it byte for byte by
  `change/pinned_test.go`, so they move only by copying them again when that
  requirement moves, never by hand), and the wire types
  (`api.ts`). The hub knows nothing about Azure, k8s, or offices; it
  knows blueprints, entities, relations, sources, and layers. `title` and
  `icon` are reserved fields every entity carries: they are stored and
  resolved like any field, and a blueprint's `icon` is the default for its
  entities. Server and web app both import this directory. A filter means
  what `matches` in `filter.ts` says it means, and `compare` is the one
  order, on either side; the hub's SQL in `src/server/query.ts` is a
  translation of them, leaf for leaf, held equal by `query.test.ts`. A
  relation leaf with a `where` reads the values of what it reaches:
  `matches` cannot see them on the relation, so it is given, under
  `whereKey`, the ids that meet each `where` (`whereSets` works them out
  from what the reader sees), the way `relatedTo` is given its sets, and
  `query.ts` reads the reached rows in a nested `EXISTS`. Whatever judges a
  filter in memory without those sets (a scorecard, an aggregation's
  `where`, a case of an inherited relation) refuses the leaf. Search
  reads the key, the title, and the text of each field value the reader may
  see, at any depth of a list or an object; never a field name.
- `src/server` runs directly under Node 24 with no build step. Imports carry
  the `.ts` extension. Only erasable TypeScript syntax is allowed: no enums,
  no parameter properties.
  - `entities.ts` is the only place a value is written. Every write lands in
    one layer (`pushed`, `git`, `ui`, `override`) and never touches another,
    except the one rule that a moved pushed value clears its override.
    `editFromUi` takes the fields a person changes only as the entity's
    owner (`authored`): there a source's value is never written over,
    unless the field is sticky. A hand edit's activity row keeps the hand
    values it replaced (`was`, `wasRelations`), so it can be put back. A
    hand edit of a relation also drops a source's links of it to what does
    not exist (`dangling` on the row): nothing else removes one a source
    stopped writing.
  - `values.ts` resolves the winning value for a field. Precedence lives
    there and nowhere else. A field the hub computes (`isDerived`) has no
    stored winner: a value kept from before it was computed is neither shown
    nor named as where the value came from.
  - `read.ts` turns rows into entities: relations in both directions, derived
    fields, and status. Every view and every agent reads through it. Derived
    fields read other entities' derived fields, so it loads everything a path
    reaches in batches, then computes in dependency order. A path a derived
    value walks (a mirror, an aggregation, the rollup) reaches only active
    entities (`present` on the pass): one missing or deleted is neither an
    end nor stepped through, and is kept in its reads, so its state alone
    moving derives the reader again. A walk for who a grant reaches is not
    held to it. An end read only
    for a count or a stored value is not derived in turn, and is loaded with
    only the values the path's mirrors and aggregations name (`Plan.narrow`,
    `needNarrow`): never its relations or its other fields, and whole where
    its stored row is behind, or a filter reads what it reaches. The result of that
    compute is stored: a read is `entities JOIN derived`, hydrated with no
    computation (`derive` in it), and a row with no derived row, or one older
    than its entity's last change, the last change to what derivation reads
    of its blueprint (`shapedAt` in `blueprints.ts`), or its scorecards,
    is computed for that read and queued to be stored. What derivation reads
    of a blueprint is `shapeOf`: everything but the parts its lists name
    (descriptions, titles, formats, chips, grounds, access, former names), so
    a save that moves only those derives nothing again and queues nothing; a
    part added to the model counts until it is named there. What is worked out
    from the model alone (`readsFor`, the model's stamp) is kept until a
    blueprint, the layout, or a scorecard changes (`revision` on each). A value that reads the time is never recomputed
    for a read: the row says when it next changes (`expires_at`, worked out
    as it is derived: a trend's span ending, an entity leaving a window, an
    age crossing its span, the hour for a calculation of the time), and the
    leader derives it again then. A neighbour a compute needs is borrowed
    from its stored row the same way. A read of many entities by reference
    that shows only what is stored (`hydrated`) reads no layers: they are
    most of a row's size, and only a row whose derived row is not current is
    read whole, to derive it.
    A list (`list`) is answered in SQL by `query.ts`: the filter, the sort,
    the groups, and the distribution run in Postgres over the stored rows
    (the distribution counts each column's single values in one pass, opens
    up only the rows that hold several, and keeps the top values in the
    statement, so it answers in a few rows; a column where a row holds more
    than `SHARED_LIST_MAX` values is a document, and is left out unopened),
    the reader's visibility inside the statement (a hidden field is refused
    before it, an owner-opened field reads only on the rows they own, and a
    relation to or from a blueprint they may not see is refused before it),
    and only the page asked for
    is hydrated and put through the view. Before a blueprint is listed,
    `ensureDerived` derives what is missing or stale among its rows while
    that is few. Nothing is kept in memory across reads: copy an entity
    before adding to it, and put the reader's view on it before anyone sees
    it. The hub's own
    source and runner entities get their live facts (`status`, last run,
    last seen, last error) laid over from `sources` as they are read, never
    written. A walk inside a re-link reads afresh.
  - `derive.ts` owns when derived state is computed and what is kept of it:
    the `derived` table (fields, relations with titles, icon as stored,
    level, reasons with the blueprint each came from, levels, a search
    text, and `reads`: every entity id whose change moves the row: its
    relation targets, the ends of every path a mirror, an aggregation, or
    the rollup follows, and what a longer path steps through) and the
    `derive_queue`. The index on `reads` keeps no pending list
    (`fastupdate = off`): readers are looked up a thousand ids to a
    statement, and with the list on each lookup walks every entry the hubs
    just derived. Every writer puts what it touched, and the other end of
    every relation it added or dropped, on the queue in its own transaction
    through the `Queue` the hub wires to it (`entities.ts`, `rules.ts`,
    `runs.ts`, `checks.ts`, `alerts.ts`, `history.ts`, `sources.ts`; a
    change to what derivation reads of a blueprint, or to a scorecard,
    queues the blueprint and everything that reads it).
    A small write outside a run is derived on the request before it
    answers, and so is what read it, round by round while each round is
    small (`inline`), so a hand edit shows at once. A stored row that
    changes sends back only the readers that read a part of it that moved
    (`PART` and `readersOf` in `read.ts`, `partsMoved` here): a field by
    name, the status, the levels, the relations, the icon, and who points at
    the entity (`pointed`, kept only where a path of another blueprint steps
    through it that way). What each blueprint reads of another comes from
    the model alone (`needs`). A row that only shows an entity beside it
    reads its title and state, which are in no stored row: whoever changes
    one calls `enqueueReaders`, which sends every reader back. So a new way
    for a derived value to read a neighbour names the part it reads in
    `needs`, or the value goes stale. `way` on a row counts how it was
    derived; count `WAY` up when a release derives rows another way: a hub
    that takes the lead queues every row an earlier way derived (`upgrade`)
    and the deriving passes work them out again a batch at a time, while the
    stored rows are still read, and the reconcile is the backstop. A run's writes are
    answered without deriving anything: a pusher never waits for derived
    state. The leader drains the rest every
    `DERIVE_EVERY_SECONDS`, queues the readers of whatever changed, emits a
    `derived` event per batch, and runs the rules pass after it. A
    derivation from older inputs never overwrites one from newer:
    `derived_at` decides. Each stored row keeps a fingerprint of all it
    holds (`fingerprint`, of this `WAY`): a row derived the same is told by
    it alone, has its `derived_at` moved in place and nothing else, and is
    never read whole; only a row whose fingerprint moved is read, to say
    which parts moved. Only the deriver writes a stored row, so a fingerprint
    stands for what is stored. A batch's time is noted against each
    blueprint by what its rows read (one for the row, one for each entity it
    read), so a plain row is never charged for a rollup derived beside it. Hubs share the queue: a pass marks what it took
    (`taken_until`) and the others pass it over, and a writer never touches
    a taken row: `derive_queue` holds one waiting row an entity and any
    number taken, so an entity that changes while a hub derives it is
    queued anew beside the taken row and derived again. A writer that
    finds its entity waiting already holds that row with a shared lock
    until it commits, and a pass's take skips a held row: otherwise a pass
    derives the entity from before the change and removes the only row that
    says it changed. Every insert into
    the queue goes in key order (`queueing`), or two transactions that
    queue some of the same new entities deadlock. `backfill` on a lead derives what has no derived
    row, which is everything the first time;
    `reconcile` on the tick is the backstop; `clock` re-derives the rows
    whose `expires_at` has arrived, and nothing else for the time; `standing`
    re-derives a source's entities when what its standing puts on them flips
    (`greys` in `sources.ts`: grey and why, never a red run's reason). A trend's spans
    lie on the grid its `every` lays from the epoch, so it reads the same
    all through a span: a value that reads the time must read the same until
    the moment its row names, or it churns every row that reads it.
  - `lists.ts` keeps each grid's answer's shape: how many rows match, how
    they group, and how they share out each column, once per question and
    person. The count and the groups are waited for; how the columns share
    out is a promise on the listing, so the web grid asks for its rows with
    `distribution=later` and for the counts beside them with
    `distribution=only`, and never waits for the slowest part to show rows; the rows themselves are read by block from the stored rows
    (`block`), in the same order, each time a grid scrolls, and never counted
    again (`page` in `query.ts`). A listing built cold has its block read
    beside its count, both after the one pass that derives what is stale
    (`ensure`), so a grid opened cold waits for the slower, not the sum. A listing is marked
    stale only when a blueprint it reads moves (`readsFor` in `read.ts`), or when
    the title of something its rows show beside them moves. An event that
    knows what moved names it: an `entity` event carries `titled`, a
    `derived` event carries the blueprints whose rows landed, and an
    `estate` event carries the blueprints it moved. An `estate` event without
    them marks everything, so name them wherever you know them. A source's
    offer names the blueprints it created or extended (`offered` on the
    `blueprints` event) and marks only what reads them: an offer carries no
    access rule and changes nothing that exists. Any other model change
    forgets every kept answer. The next
    question builds a stale listing again and waits a moment for it
    (`PATIENCE_MS`); when it is slower, the last listing is given meanwhile,
    with no tag, and its rows are still read fresh. A listing built for
    what the reader saw before is never given: it is built again and waited
    for. A list's tag (`tag`) names the time each blueprint it reads last
    moved, by the time of the event that said so (`at`, stamped once by the
    hub that emits it), and the release: every hub hears the same events,
    stores what it heard in `list_stamps`, and reads it as it starts, so a
    reader's tag holds on any hub and across a restart. A hub that starts
    says so (`started`), and no tag named before then is answered as
    unchanged anywhere: what it missed while it was not listening is older.
    So an event names only the blueprints it moved, and a list's tag reads
    only its blueprint and what its rows read (`listReads`); what shows a
    neighbour moves through the neighbour's own event, which stamps the
    blueprints beside it only when its title, state, status, or icon moved.
    A run that
    commits emits `sources`: what it says of the run and its source moved,
    and that is laid over the hub's own source and runner entities alone
    (`SOURCE_STANDING` in `src/shared/model.ts`). So it moves those two
    blueprints, on either side, and a kept page that names what it reads
    stands through it unless it reads one of them. A grid scrolls by reading blocks of it, and `read.ts`
    `dress` adds the slow per-row parts to that block only. The wall and the
    summary are kept there the same way. Never key a kept
    answer without the reader: what each person sees is their own.
  - `runs.ts` owns the lifecycle: what a committed snapshot may delete, grace,
    the mass-drop guard, expiry by age, tombstones, purge. A snapshot is
    charged by what changed: each batch notes what it saw, in full or by a
    sighting, in one `run_seen` row and writes nothing on an entity it leaves
    as it was (any other
    unchanged write stores its sighting once in fifteen minutes), the commit
    marks missing what no row names, and `scope_seen` says
    once when the scope's last snapshot committed. `seenAt` reads an active
    entity's last-seen from that, and `SEEN` in `query.ts` is the same in
    SQL. A value a snapshot leaves as it was keeps its `observedAt`.
  - `rules.ts` computes relations: relation rules into the `rule` layer, and
    relations that inherit into the `inherited` layer, below every other.
    A rule on a relation that holds one target reads a list on its source
    side in order, and the first member that finds anything decides; if that
    member finds several, it links the one still seen if the rest are
    missing, and otherwise none, and logs it: never pick one of them.
    After a commit, and on the lifecycle tick, it re-links only what reads a
    blueprint that moved since the last pass. Everything is re-linked when
    the model changes, when a hub starts or takes the lead, and every
    `RELINK_MINUTES`. A git pull that changed nothing a catalog defines
    announces no model change (`git.ts`), so a store tells a save of what it
    keeps by `equal` in `values.ts`, never by its text: what a hub reads back
    from Postgres holds an object's keys in Postgres's order. A commit, and a person's save of
    an entity, a blueprint, or a rule, is answered before its re-link runs
    (`runs.relink`; on a hub that only serves, the leader runs it when it
    hears the change), and commits that land during a pass share the one
    queued after it. An inherited relation is filled again only for the
    entities a move reaches: each pass reads `link_journal` from where it
    last looked (`journal.ts`, the reader `ownership.ts` shares) and walks
    each path back from the link or entity that moved (`movedUnder`), over
    the links as they stand; it may name an entity nothing changed for,
    never miss one. It reads keys and links alone (`links.ts`, the one read
    of the links a path steps along, which `ownership.ts` shares), and an
    entity's values only where a case reads them (`when`). One with such a
    case is not told by the journal, and is filled whole when a blueprint it
    reads moved. So whatever an inherited relation reads beyond links and
    whether an entity is deleted needs its own way to say it moved. A rule
    reads its sides afresh each time it is evaluated: stored values alone
    where it matches on a stored value, the entities whole where it matches
    on a derived one. A rule that is due is evaluated only when what it
    matches on moved: the pass keeps, by rule, a stamp of each side (it
    moves when any entity of the side does, and reads no value) and a digest
    of what the rule can read of the side to match on, and a rule whose
    sides hold what they held is passed over (`asItWas`, `judge`). What is
    kept is read between two fresh stamps around the rule's own read, never
    from what the pass read earlier: a side may move while a pass runs. A
    pass over everything evaluates every rule. So a rule that comes to read
    something beyond an entity's key, title, state, owner, and one field
    adds it to `digest`. A rule or an inherited relation that changes links
    says which blueprint moved as it changes it.
    `findings.ts` computes findings at read time from current state.
    `conventions.ts` keeps the estate's relation conventions (the relations
    every blueprint of some groups names), declared from git under
    `config.conventions` the way the column standard is; `unmetConventions`
    in `src/shared/conventions.ts` is the one answer to which blueprints
    fall short, and each is a finding. A convention never adds a relation.
    `catalog.ts` and `git.ts` load catalog YAML; `catalog.ts` also imports a
    model from the web app. `templates/` holds the models offered for import.
  - `checks.ts` owns health checks, secrets, runner assignment, and the
    built-in runner. A result queues its entity to be derived only when it
    is new or says something else of what status reads: whether it passed,
    and what it failed with. `alerts.ts` takes Alertmanager webhooks and matches them
    by alert rules. `scorecards.ts` scores entities and keeps the level
    history. A rule either holds a filter the hub judges or is `judged`:
    another judge decided it, and `ruleOutcome` in `src/shared/scorecard.ts`
    is the one reading of what it said (pass, fail, no data, or not
    applying), from an object a `checks` aggregation fills (`checksOf` in
    `src/shared/model.ts`). No data holds an entity below a level as a
    failure does, and is never counted as one. A source that holds the
    `scorecards` grant puts and removes its own scorecards, and they are
    its alone, as a git source's are git's. `layout.ts` is ELK, which lays the model page out into tiers, left to
    right. A stored position is always the fully expanded one: `compact` in
    `src/shared/layout.ts` is the only thing that moves a card when a card
    opens, and nothing is written for it.
    `actions.ts` is self-service: an action's definition, the validation of a
    run's inputs, each by its kind in `src/shared/input-kinds.ts` and against
    the options rendered over the same scope the form used (a refusal over
    one input names it: `ActionError.input`, answered as `input` beside
    `error`). `request` in it asks `src/shared/asked.ts` which inputs the
    run is asked for: one that is not asked is stored null and what was
    sent for it is dropped, never refused, and a worked-out one is always
    computed again, never taken from the request, then checked as its kind.
    An `attachment` input is a long text the run alone keeps: a list of runs,
    the activity row, and a notice carry only its length (`withoutAttached`
    in `input-kinds.ts`), and the run's page folds it until it is opened.
    `taken` is the `unique` check: the hub's own read of every active
    entity, whoever asks, answering only that a value is held. Then the hand-off to a webhook, a GitHub workflow, a runner job, or a
    starter's job (or to nobody, for `caller`: whoever asked does the work and reports), the
    `record` backend's one entity write, and the run's log. An action's
    `retry` tries a failed run again in the same row: every failure the hub
    may retry goes through `nextTry`, which alone decides whether it is
    tried again (the action's tries, the try's `final`), and `requeue`
    puts it back with `retry_at`; `retryDue` hands it on when due. How long
    a batch takes is `src/shared/estimate.ts` alone, read by the preview and
    the batch page in `batches.ts`: the action's `meanSeconds` and the
    runner's `width` (kept from its claims) at first, the batch's own pace once
    it has one. A batch asks its form once for many: `unbatchable` in
    `src/shared/action-spec.ts` is the one answer to which inputs cannot be,
    read by the save, the grid, and the batch, and `inputsForMany` fills each
    run's inputs that narrow the target from its own entity. A change set is
    many runs asked for one decision (`change-sets.ts`, ADR-5009): each item
    is judged by `judgeItem`, the same `judge` a run alone goes through, and
    the set is refused whole when any item is, naming each. Its runs name
    the set (`change_set`, `set_index`) and are decided, withdrawn, and told
    only as the set: `undecidable` refuses a run of a set unless the set
    asks, and every activity row about one names it as `set`. `holdSet` says
    who holds its runs and that someone decides them all. A run under way
    lives by being heard from (ADR-5010): `lifeOf` is the one reading of how
    long a run of an action may go unheard from and how long it may run at
    all, and `expire` the one place a run is given up, as `unknown`. Every
    report stamps `heard_at`, and one that carries nothing does only that,
    at most once a minute (`heard`); a new backend says how it is heard
    from in `lifeOf`, never with a clock of its own. A `job` backend is one
    container a run (ADR-4002; `claimJobs`, `heldBy`): a starter, which is a runner
    source, claims the run, is handed the credential made for that run alone
    (`job_token`, kept as a hash, gone when the run ends or is put back),
    and reports as a runner does. The hub starts and stops nothing: a job's
    run under way is stopped by ending it `cancelled` (`stop`), which its
    starter reads and acts on. Only that starter says a run's outcome is
    `unknown`, and a job's own report never carries a state. A job's
    `template` names what the job runs as, so nobody who may run the action
    chooses it: it is a fixed name, or reads only locked fields of the entity
    the run is on (`templateIssues`, `templateFieldIssue`, and `jobTemplate`
    in `src/shared/action-spec.ts`). `templateOf` is the one place the hub
    works the name out, over its own read of the entity and never a caller's
    view or the run's scope, when a run is asked for and again as it is
    claimed; `accessNames` holds every field `templateReads` gives as what
    access is decided from, in both of its scopes, so no other source, no
    hand, no `record`, and no `refreshes` writes one. Never let a template
    read `inputs`, `by`, or anything a caller or a run can set, and never
    put the rendered name in a run's log: it says what the field holds. Never
    retry a run the hub timed out: its job may still be going. A webhook's
    answer holds whatever handed the run on for `HOLD_MS` at most, then is
    waited for behind it, up to the action's `timeout` (`WEBHOOK_TIMEOUT`
    when it names none): never hold a request for a backend. A call that gets
    no answer in time, whose connection closes after it went out, or that a
    gateway answers 504 may have done its work (`mayHaveLanded`): the run
    ends `unknown`, which is no failure, is never tried again, and is still
    its backend's to settle by a report. Only a call that never went out is
    a webhook that could not be reached. An action's `concurrency` is
    the most of its runs in flight at once: `start` is the one gate, a turn
    taken under a lock on the action (and the line, for `serial`), so a
    runner's claim, a caller's start, and every hand-off to a webhook or a
    workflow pass it; the hub's own hand-offs also wait behind what was
    queued first (`TURN_ORDER`). A run that ends, or is put back to be tried
    again, hands on the next (`pump`), and `turns` on a timer is the
    backstop. Never drop or replace a run for it. Schedules are
    `schedules.ts`: a firing is an ordinary run or batch asked as its owner
    and judged at that moment, and nothing on repeat fires before someone
    approves it. One that fires once (`once` in `src/shared/cadence.ts`) is a
    run put off: it asks no approval, any action a person may run may be put
    off, and it is `done` once it fired. A schedule runs on one entity, the
    entities picked, what a grid's filter matches when it fires (`matching`),
    or what a saved query matches then; `manyOf` is the one reading of which
    batch a firing asks. The schedule drawer (`ScheduleDrawer`) is opened by
    **Run later…** from the action form, the batch drawer, and the map's
    tray; it is drawn inside the form that opened it, so its submit stops
    there.
    A schedule's history (`history`) is read from the runs that name it,
    a batch as one firing, and a firing that asked nothing from its
    `schedule.fired` row in the activity log, where only it is. The page
    is `components/SchedulesPage.tsx`, one schedule opened over it is
    `components/ScheduleView.tsx`, and what both work out (how a firing
    went, the lanes, the tally, the runner minutes by hour) is
    `src/web/schedules.ts`, pure and tested alone. In the runs list, what
    a schedule fired is one line a schedule a day in the reader's own time
    zone (`days`, asked as `group=origin`), shown where its batches would
    be shown, and opened to its firings (`components/ScheduleLine.tsx`);
    the runs and batches beside it are only what a person asked by hand.
    A run whose action has a `change` input states a change
    (`change-events.ts`): its digest is kept on the run, and its
    `change.stated` and `change.routed` events are written in the
    transaction that writes the run, each yes and no's `change.decided` with
    the decision, and its one `change.ended` (`endChange`, guarded by
    `change_ended_at`) wherever the run ends. Each event is the platform
    kit's shape in the row's `detail.event`; the Annals forwarder and the
    notice forwarder read it there and nowhere else. Never write one for a
    run that states nothing.
    `insights.ts` reads usage from the runs alone. `approvals.ts` writes the
    hub's own approvals into the estate's approvals blueprint from the
    activity log; never write them where a run or schedule is decided. A run
    that `revises` another is the next round of the same ask, and the rounds
    of one ask are one record (`roundsOf` in `actions.ts` is the one walk of
    them): a round that revises a run still waiting supersedes it. A
    run's pictures live in `action_run_images`, never in `outputs`, so no
    list reads them. What a run hands back on a `::refresh::` line (`run-marks.ts`)
    is held on the run (`refresh`) for the fields its action `refreshes`
    alone, and settled where every run ends (`finished`): `write-back.ts`
    writes it on the run's own entity as its owning source once the run
    succeeds, through `Entities.write`, and records `action.wrote_back`;
    anything else is let go with a log line. Never let a run write back on
    another entity or as any source but the owner. `targets` in it
    is the one answer to which entities a person may run an action on: the
    target picker, the `actions` each grid row and entity page carries,
    `list_actions`, and the run check all read it. It is asked of the stored
    rows each time, as references, for the entities in question (`among`),
    and never kept: a grid row costs its page, never the whole blueprint,
    and what is stale is looked for among the page alone (`ensure` in
    `derive.ts`, given its keys).
    Only the picker's full list asks after every entity. An action is answered to a reader with whether
    they may run it, its last run, the icon to draw (`iconShown`, the only
    place that order is worked out), and what its runs say of it (`stats`,
    one statement for every action): `listFor` for all of them, `shown`
    for one. An action may name a `home`: one entity of any blueprint. The
    hub never learns what a program or a team is; a home is whatever entity
    the catalog holds. `homes` resolves every home of a listing in one batch
    through the reader's `View`, and `placed` puts it on the action as
    `homeShown` (title, icon, and `yours`), leaving the definition's `home`
    out for a reader who may not see its blueprint. The icon to draw falls
    back to the home's before the blueprint's. The page's shared layout
    names a section by a home's entity id or a group's name, so its routes
    in `http.ts` read and save it through the view too: a home the reader
    may not see is left out, and kept in place when they save.
    A run answered to a reader names what it ran on by title, read in one
    batch through `titlesOf` in `read.ts` after the view has let the run
    through, and its entity and person inputs the same way
    (`inputTitles`). A run also holds the steps its backend named and the outputs
    it ended with. `src/shared/run-marks.ts` is the one reading of what
    names them inside a reported line (`::step::`, `::output::`, `::final::`,
    and a JSON line's `step`), and its limits; `report` reads a report's lines through
    it under a lock on the run's row and writes the log, the steps, and the
    outputs in one update, so two reports never lose each other's. A line
    is kept under the step under way; a marker that breaks a rule stays a
    line. An output is what the backend chose to say and is shown to
    whoever may see the run: the hub never puts a secret in one. A backend
    the hub ships names its last step `Verify` only when it checks that the
    effect was observed. `src/shared/template.ts` is the `{{ path }}`
    rendering both sides use. `filtersFor` in `actions.ts` is the one
    reading of an action's `where` and its rules' for one caller: `@me` and
    the day names filled in (`forAsker`), and a `self` action narrowed to
    the caller's own person entity, an admin's too; every read of those
    filters goes through it. `by.address` is where the caller is, set only on
    a run a person asks for themselves in the browser (`ownAddress` in
    `http.ts`), kept on the run as `by_address`, and read from
    `client-address.ts`, the one reader of the trusted proxy header that
    telemetry reads too. A default that reads `by` is filled in by the hub
    again on every run; a value sent in its place is kept and recorded as
    differing, never refused.
  - A pivot is not a kind of field. `syncPivots` in `blueprints.ts` makes an
    ordinary calculation field for each property of a pivoted object, marked
    `pivoted`, and removes them when the pivot is turned off. Nothing else
    treats a made field differently from one a person wrote.
  - `builtin.ts` is the only model the hub brings: the reserved `orrery_`
    blueprints it keeps entities for (sources, runners, schedules, reports,
    and report editions). It also brings the hub's own actions,
    `HUB_ACTIONS`: the ones its reports are made and changed with. A report links to its home through one relation
    per blueprint a home is in, `home_<blueprint>` (`reportRelations`), and
    is seen by whoever sees its home until an admin says otherwise; an
    edition is always seen by whoever sees its report (`subjects`). A
    new hub holds nothing else. `schedule-records.ts` writes the schedule
    entities from the schedules table, which stays the truth. A schedule
    links to what it runs on (`hits` on its row: what it names, or what its
    filter or saved query matched when it was last saved or fired) through
    one relation per blueprint an action runs on, `on_<blueprint>`, made from
    the actions by `scheduleRelations` and kept in step by each records
    pass. When an admin opens a hub blueprint by `subjects`, the hub names
    every relation it has (`ruleOf`), so a schedule is seen by whoever sees
    what it runs on. Removing a blueprint drops a hub blueprint's relation to
    it and is never refused for one.
  - `access.ts` keeps the people the login proxy has let in and the roles
    given to them. `auth.ts` turns a request into an identity with
    permissions, and `allow` in it guards a route. The permissions are the
    fixed list in `src/shared/model.ts`; roles are the users' own.
  - `visibility.ts` decides what a person sees: the access rules on
    blueprints and fields, and which blueprints only an admin changes. It
    holds the access policy (audiences and field classes) and resolves every
    rule through `src/shared/policy.ts`: a rule's audiences expand to their
    grants, and a field a class matches takes the class's rule. Nothing
    reads `access.grants` alone to decide who gets in. Every
    read route asks it for a `View` and passes what it returns through it;
    `read.ts` filters and sorts on what the view leaves, so a hidden value
    never decides a result.
    A blueprint's `timeline` rule says who reads its entities' timelines
    (`readsTimeline`): `changes` on the view drops every activity row about
    one of its entities for anyone else, on the entity page, the activity
    log, and an agent's tools alike, and the blueprint is shown to them with
    `noTimeline` and never the rule. It holds grants and audiences alone.
    A derived field that reads what is withheld is withheld with it
    (`readsWithheld`), but for one: an aggregation marked `summary`, which
    `summarises` holds to a number or a trend. `summaries` on a `View` names
    the fields a reader is shown that way, and every surface asks it for
    what the number must not carry: `entity` drops a trend's link,
    `refused` and the search in `query.ts` let nothing read a trend shown
    so, `shown` in `http.ts` and `describe_model` say the field is derived
    and not from what, and a save from that reader keeps the definition.
    A new derived kind that could read a summary's value asks `sealed`.
    It also says what a person owns: `owned` follows the person setting's
    `owns` paths from their entity. Owning never opens a blueprint. It opens
    a field only where a class's `owned` says so, and then only on the
    entities the reader owns or owns through the class's relations
    (`hiddenOn` in `Restricted`); everywhere else the field is withheld as
    before. It opens an action on one entity only where an action rule's
    `owns` asks for it (`gate` says which rules let a person in), and a
    whole action only where its `access.home` asks for it and the person
    owns the action's home (`homeLetsIn`); nobody is let in that way while
    what a person owns is unset or unknown. What a person owns is
    `ownership.ts`: each `owns` path walked once a person, step by step,
    with the link from the step before that reaches each entity and how
    many routes do, then moved in place. The database writes every link
    that moves, and every entity that comes, goes, or crosses into or out
    of deleted, to `link_journal` (the triggers in
    `0041-link-journal.sql`), whoever wrote it; a read after the hub heard
    that something moved takes what the journal holds from the oldest
    transaction that could still have been open at the last read, and works
    out again only the entities it names, against the database as it
    stands, so reading a move twice is harmless and a late commit is never
    passed over. A hop going in works out the entity holding the moved
    link, never the one it points at, which thousands may point at. The
    leader lets go of journal rows no hub still reads (`JournalPruner`); a
    hub that has not read it for half an hour walks afresh, and a model
    change walks everything afresh. The gate, the homes of a listing, the
    view, and the routes in `http.ts` read it with `ownedKept` or
    `ownedMany`, which find each person's entity once (`peopleKept`, read
    again when an entity of the person blueprint moves), and `warm` asks
    for everyone before a page judges them. A list is
    filtered and sorted on the rows as the view left them, so a route that
    filters or sorts a list asks `refusedQuery`; what is judged on every
    entity at once, such as a scorecard, asks `refusedFilter`, which still
    refuses a field opened to owners. A view's `basis` changes when what the
    reader reaches or owns changes, or what is about what they see, and a
    kept listing built on another basis is built again. All three are kept as
    the same object while they read the same (`keptReach`, `keptOwns`,
    `keptAbouts`), so working one out again after a derive pass rebuilds none
    of the reader's pages. A blueprint whose rule names `subjects` is seen
    one by one like one opened to owners: `aboutOf` reads, in one query a
    blueprint (`aboutIds` in `read.ts`), the ids whose subject relations
    point at what the reader sees whole, owns, or sees as about something,
    and `oneByOne` is the one set every list, count, link, and the summary
    filter by. It is read again when an entity of such a blueprint moves. `/v1/mine`
    reads what is theirs through the same `View`: each thing is counted by
    the level its stored row holds (`levelsOf` in `read.ts`), and only what
    the answer shows is read whole, so a person who owns thousands of green
    things costs what is not green.
    The web app speaks to a person from there (`perspectiveOf` in
    `src/web/now.ts`): their own first, "what you can see" for the rest, and
    "the estate" only to a reader who sees everything. The scorecards page
    reads through the same order (`lensOf` in `src/web/scorecards.ts`): it
    opens on the rows the reader owns, folds the scorecards that score none
    of theirs, and says what to do next only to a reader who can do it
    (`advises`): elsewhere it says how things stand.
    `accessNames` is everything access is decided from, worked out from the
    rules and never marked by hand: what grants read, what action filters
    and rules read on what they run on, the ownership paths a rule or an
    action's home asks for (`ownsAsked`), and what fills each of those. `refusesHandEdit` keeps a person's edit off
    them unless they are an admin or hold `access.values`;
    `refusesForeignWrite` keeps a source off them on what it does not own.
    The edit rules of the access policy (`edits` in `src/shared/policy.ts`)
    are the other way to change a value by hand, beside `entities.edit`:
    `openable` is what rules may open on a blueprint, whoever asks (never a
    derived, locked, or admin-marked field, nor anything in `accessNames`),
    `editor` is what they open to one person (`opens` on one entity, `reach`
    and `could` on a blueprint), and `annotateEdits` puts `editable` on the
    entities a grid block or an entity page answers with. An owner rule's
    ownership paths join `accessNames` for the blueprints it names, through
    `ownerPathsTo`. `editing` in `http.ts` is the one place a hand edit is
    let in: by the permission and `refusesHandEdit`, or by a rule on that
    entity. A new way to change a value by hand asks it.
    `annotatePeople` puts `people` on the same entities: the person each
    `user` value names, found through the person setting (`peopleKept`) by
    `addressKey` in `src/shared/model.ts`, only where the reader may see
    them. The grid and the entity page link a `user` value through it, and
    leave an address that names nobody they may see as text.
  - `posture.ts` is the security posture behind the Security page: every
    rule judged for every person and token (every field too, an open one
    included), the audiences and classes with whom they let in and what
    they cover, the access map, the findings, the teams (each value a grant
    names, who it lets in, and what it opens), the review queue, and a
    change to many rules or to the policy with its preview. It decides
    nothing itself: who sees and runs what comes from `Visibility` (`view`,
    `mayRun`, `viewWith` for a policy not saved yet, and `grantsLetIn` for a
    rule not saved yet), and a saved change goes through the same blueprint
    and action saves, and checks, as their editors. It keeps the review
    stamps: when each blueprint was last reviewed, and its fields then. A
    blueprint's first appearance is `createdAt` in `blueprints.ts`. An
    action's item also says where it belongs, who it is open to, and when it
    last ran. Its home is the one thing in a snapshot that is the reader's:
    `snapshot` takes who asks and reads the home through their `View`
    (`homes` in `actions.ts`), so never keep a snapshot without the reader.
    The runs are counted for every action in one statement (`usage` in
    `actions.ts`). An action nobody ran in 90 days, whose definition is older
    than that, is a finding (`action-unused`); the hub keeps no date an
    action was first made, so its age is `updatedAt`, which a save that
    changes nothing leaves alone. Its wire types are
    `src/shared/posture.ts`; its page is `components/Security.tsx`, with
    `SecurityPolicy.tsx`, `SecurityMap.tsx`, `SecurityActions.tsx` (the
    Actions tab), `SecurityEdits.tsx` (the Who edits tab, over `edits` in
    `posture.ts`: each value's one authority, the edit rules and their
    editor, what they open to one person, and the standing overrides; what
    it works out is `components/security-edits.ts`, pure and tested alone),
    and `SecurityWho.tsx` (everyone one thing lets in). What
    the Actions tab shows and how its filters decide is
    `components/security-actions.ts`, pure and tested alone; the words the
    page says twice are `components/security-words.ts`.
  - `icons.ts` is the custom icons: what an icon may hold, who owns one (a
    git source wins over every other owner), the icons a git source loads
    from `icons/` beside its catalog files, and the files `/v1/icons`
    serves, built-in brand files included. A custom icon's name is never one
    of the set's. `read.ts` takes a custom icon's name as a picture.
  - `pictures.ts` is people's pictures (ADR-5008), kept by the address a
    person signs in with and never as an entity's value: the photo a source
    puts (`/v1/ingest/pictures`), two square JPEGs whose sizes and caps are
    `PHOTO_SIZES` in `src/shared/icons.ts`, named `photo:<sha256>` by their
    bytes and served for good at `/v1/photos/<sha256>/<size>`; and the icon a
    person picks in its place (`/v1/mine/picture`), theirs alone and shown to
    everyone. The person entity the person setting answers to the address
    shows the pick, else the photo: `read.ts` lays it on as it builds the
    entity, so it is stored as the derived icon and drawn wherever the entity
    is drawn, and `hydrate` lays it on again so a change shows before the
    row is derived again. A change queues that entity. An icon written as a
    value that names a photo is no icon, and no picker offers a photo but the
    reader's own, on their own entity. `annotatePeople` and `peopleShown` in
    `visibility.ts` put each person's picture on what a reader is shown. A
    photo never enters `/v1/icons`. The web app draws a photo round, small
    everywhere and large only where `Icon` is told `large`.
  - `notices.ts` sends every self-service run to the notification desk at
    `DISPATCH_URL` as events, read from the activity log the way the Annals
    forwarder reads it. The hub names the people an event is for (`reaches`):
    a run that waits is for the people a rule lets decide it (`deciders` in
    `actions.ts`), a scheduled run's or batch's end is for its schedule's
    people only when its `tell` asks for that result (`worthTelling` in
    `src/shared/schedule.ts`, the one reading of it), and every other event
    is for whoever asked. Every event carries its kind's declared weight
    (`DECLARED_KINDS`): what worked is a `notice`, what failed or waits a
    `notify`, so a new kind that splits by outcome is two kinds. How each
    person is reached, and which channels hear besides, is the desk's to
    decide, never the hub's. A tool's run is told to nobody. A run waiting for approval
    names the hub's approve and decline calls as the event's `actions`;
    whoever a channel lets click one calls the hub as themselves, and
    `mayDecide` decides as on the page.
  - `queries.ts` reads the catalog whole for the query page: each source
    through the reader's `View`, every row it matches. A column names what
    fills it in each blueprint (`from`); a plain id is that id in every
    blueprint that has it. The columns every entity has are `META_COLUMNS`
    in `src/shared/answer.ts`, each under a `$` name; a field a blueprint
    defines wins a bare name such as `state` (`metaIn`), as in a filter,
    and both sides read a column's meaning from there alone. A column may read through relations: `r:<path>`
    is the titles at the end of a relation path and `r:<path>@<field>` a
    field there (`pathColumn` in `src/shared/answer.ts`); the ids are walked
    a page at a time (`reachAll`), every end is read once from its stored row
    (`hydrated`), and each passes through the reader's view. What the reader
    may not see fills nothing, and a plain id they may see nowhere is no
    column. A source of a blueprint they may not see is left out of their
    answer, and so is one no blueprint has, so the two read the same
    (`sourcesOf`); only a reader who sees everything is told it is unknown.
    The page draws neither, and keeps both as they were on a save
    (`seenSources` in `src/web/query.ts`). A query's `view` (conditions on its columns, the order, the
    groups, the totals) is read by `src/shared/answer.ts` alone: the page
    shapes the answer with it, and the hub with the same code wherever it
    hands an answer on, so an export, a schedule, and an agent take the rows
    the person saw (`kept`). A saved query is its
    owner's, and shared with everyone, with one audience of the access
    policy the owner is in, or with the people who own its home. Who is in
    an audience is worked out on each ask through `grantsLetIn`, never kept,
    and a person is never shown an audience they are not in. A query's home
    is one entity of any blueprint, as an action's: it is read through the
    reader's view with the actions' homes (`homes` in `actions.ts`), and who
    owns it is `homeLetsIn` in `visibility.ts`, the same answer an action's
    `access.home` asks. Only someone who owns the home, or an admin, opens a
    query to its people. The library shelves each home's collection
    (`library` in `src/web/query.ts`), and the home's page lists it
    (`components/HomeQueries.tsx`) beside its actions; the home is picked
    with `components/HomePicker.tsx`, which the action builder shares. The page (`components/Query.tsx`) keeps
    several queries open, one tab each, in memory alone (`query-tabs.ts`),
    and reads each answer once per change of its sources and columns
    (`useQueryAnswer`); its view shapes the answer in the browser and asks
    nothing of the hub. Beside the answer stand its fields, each column's
    values counted over the rows every other condition keeps
    (`components/QueryFields.tsx`), and its columns
    (`components/QueryColumns.tsx`); the answer is `components/QueryGrid.tsx`,
    one tab stop moved by the arrow keys. How a column's numbers are shown, such as money, is `columnFormat` in
    `src/shared/answer.ts`: the field's `format` where every blueprint that
    fills the column gives the same one. The page shows cells, totals, groups,
    ranges, conditions, and the chart by it, the export writes it as Excel's number
    format, and `run_query` names it; the stored number never changes. The same query reads as text
    (`src/shared/query-text.ts`: `printQuery` and `parseQuery`, the one form
    both sides share, with `normalizeQuery`). The text is written in
    `components/QueryEditor.tsx`, a CodeMirror editor loaded only when the
    text is opened. What may come next where the cursor stands, and what
    each name in the text is read against, is the parser's answer alone:
    `readQuery` reads the text up to the cursor and notes what each read
    that reached the end would have taken (`expected`), and where every
    blueprint, field, and column it read stands (`marks`). The editor keeps
    no grammar of its own: a new part of the language offers itself once the
    parser reads it. What those answers mean against the blueprints the
    reader sees (the offers, a name's meaning, a name nothing the query
    reads has) is `src/web/query-complete.ts`, pure and tested alone. What the page works out of a
    query (its columns, each blueprint's colour, the library's shelves, the
    grid's lines, a value picked from a column, the chart's plan and bars:
    `chartPlan` fills what the view's `chart` leaves out from its groups and
    totals, and `chartBars` draws it) is `src/web/query.ts`, pure
    and tested alone.
  - `reports.ts` keeps reports: each is an entity of the hub's
    `orrery_report`, and each edition one of `orrery_report_edition`, written
    by the hub alone. A report changes only through a run of an action with
    the `report` backend, judged there as the person who ran it (its owner,
    someone who owns its home, or an admin); the `/v1/reports` routes read.
    Every layout is kept in `report_versions`; an edition's blocks and data
    in `report_editions`, let go once its record expires; a preview's in
    `report_previews`, with its run. A publish reads every data set as the
    report's owner, never as the hub or the asker, calls the report's writer
    (a runner tool) for prose, and tells the recipients who may see it
    through a `report.published` row the notice forwarder sends. The
    forwarder sends the edition drawn for mail with it (`mailOf`), so the
    desk's letter is the report; a recipient who never signed in is judged
    as a person arriving with no role (`arriving`), never left out for
    that. The grammar
    and what an edition keeps are `src/shared/report.ts` (`parseLayout`
    names every problem with its line; `buildContent` takes every number from
    data); `src/shared/report-draw.ts` is the one drawer, `web` on the
    theme's tokens and `email` inline, escaping everything it draws, a
    writer's little Markdown included. A number is judged by two marks,
    `good` and `bad` (`toneOf`, ADR-5006): a layout never names a colour or
    writes a condition, and a tone is drawn as a shape with a name, never
    colour alone. A new block is one kind in
    `BLOCK_KINDS` and a branch of `parseLayout`, `buildContent`, and both
    profiles. The hub calls no model. The Query page shapes and a report
    composes (ADR-5005): a saved query reaches a report as its own view
    shapes it (`dataOfAnswer`), and a block that names only its data shows
    that (`statsOf`, `chartOf`); never add a block option that restates
    what a query's view says. The hub brings the report actions itself
    (`HUB_ACTIONS` in `builtin.ts`, saved by `ensureBuiltins` with the
    origin `hub`; nobody else changes one or takes an `orrery_` id), and
    the web app runs them by id. `hand` moves a report's owner and, through
    `handOver` in `schedules.ts`, the owner of every schedule that runs on
    it, only once the new owner can read all its layout names. A preview
    reads saved queries afresh and takes a tool's rows from the newest
    edition while the layout asks the tool the same. The pages are
    `components/Reports.tsx` (the list, newest editions first),
    `components/Report.tsx` (one report, its edition first), and
    `components/ReportCompose.tsx` (the form, which writes a layout only
    through `printLayout`); what they work out is `src/web/report.ts`,
    pure and tested alone. A report's record draws its layout as an outline
    (`components/ReportOutline.tsx`), never as a field of text.
  - `datasets.ts` reads published datasets: a read tool with a `dataset`
    block answers one table, which a saved query reads as the source
    `$data:<id>` (ADR-3002). `datasetBlueprint` in `src/shared/model.ts` is
    a dataset as the query code takes a blueprint, columns as fields, so
    `queries.ts` and the web's query code treat it as one: `kinds` there,
    and `useQueryKinds` in the web app, are every blueprint and every
    dataset. Its rows are read whole, each as the entity `rowEntity` makes
    of it, and a source's conditions are judged on them with `matches`.
    Who may read one is `mayReadDataset` in `actions.ts`: an admin, the
    action's own `access`, or the read tier on its entity; a source not
    open to the reader is left out, never marked. A read that calls the
    tool is a run of whoever read it (`askDataset`), and its answer is kept
    in `dataset_answers` for the dataset's `fresh`. Never join a dataset to
    the catalog, give it inputs from a query, or let a layout carry a
    statement for one.
  - `writes.ts` is the write ledger: per source, the entities it wrote by
    blueprint, the blueprints it offered, and the actions it put, noted
    where each write is accepted and stored at most once a minute a source.
    A hub answers with what is stored and what it noted itself since; the
    table tells the other hubs when it is stored, and each reads it again
    (`read`), so serving hubs say the same of a source.
    `Entities` notes entity writes; the offer and action routes note theirs.
  - `load.ts` is the load ledger: by the hour, what deriving and grid
    shapes cost by blueprint, what re-linking cost by relation (each rule and
    inherited relation a pass works out), what writes cost by source,
    what API calls cost by caller, what people's stars cost each blueprint's
    grids (`star`: the reads their stars ordered, the rows marked, and the
    lookups' time, noted by `/v1/entities`; `/v1/load` adds what `stars.ts`
    holds now, through `starsLoad`), and what each kind of work asked of the
    database (`db`: statements, rows, and their time), noted where the work
    is done (`Deriver`, `Lists.build`, `Rules`, `Entities.writeMany`, one
    middleware in `http.ts`, and where `metrics.ts` times a statement) and
    added to `load_hours` at most once a minute. A statement is counted
    under the work that sent it: the innermost `timed` task, else the route
    its request ends at (`working` in `metrics.ts`), else `other` with the
    statement's verb and table. Those names are fixed sets; never name work by an entity, a person, or an
    address. A note is a map update: it never
    waits, never throws, and never becomes a metric label. What the Load page
    and the budget findings say of it (which budget a name is held to, how
    near it is, the advice for each kind, and the signals no budget counts,
    each with what is seen, why it costs, and what can be done) is
    `src/shared/load-signals.ts`, pure and tested alone. Every hub adds to
    the same rows, so nothing reads a hub's own counts but `flush`. A grid's
    build notes the spread of values apart (`spread`), as a part of its
    time. `cardinality.ts` measures how the values of each field a grid may
    count (`SPREAD_TYPES` in `src/shared/model.ts`) spread (rows, values,
    different ones, and what the spread's buckets hold, a list's values one
    by one) into `column_profiles`, a blueprint at a time on the lifecycle
    tick once its measure is old; `columnFit` in `load-signals.ts` is the one
    reading of whether a column is worth its count, and reads nothing of its
    chip. What each blueprint held, day by day, is never stored: `held` in
    `runs.ts` works it back from the entities, by the day each came and the
    day each tombstone left, only as far back as tombstones are kept, so it
    is exact; for a blueprint that expires by age it also says when what it
    holds now leaves, by the same reading as `expireAged`. `heldTrend` in
    `load-signals.ts` is the one forecast of it, at the last four weeks'
    pace, and the page warns a month before a budget is passed. How a value looks (a
    chip) and whether the grid counts it (`isSpread` in
    `src/shared/model.ts`, read by the SQL spread, `distribute`, and the
    grid's filter picks) are two settings: never read one for the other.
  - `budgets.ts` holds the hub's load to numbers the estate sets on the
    Load page: entities a source changes in an hour, API calls a caller
    makes in an hour, entities a blueprint holds, and entities one row of a
    blueprint reads, each by name with `*` for the rest. The hub ships
    none. Past `warn` a budget is a finding (`findings`); past `limit` the
    hub refuses: `hold` throws `OverBudget` (429 with `Retry-After`) at the
    start of a run, at each batch, at each single write, and for a token's
    call, and `full` rejects a new entity where `Entities` would create it.
    Both read what is kept in memory and never wait: what the ledger stored
    of the hour, read again in the background at most every half minute,
    plus what this hub noted since. A budget counts the ledger's own
    counts, so a new kind of budget is a new count in `load.ts` first. A
    person's call is never refused, and the routes a budget is read and set
    on answer whoever asks.
  - `previews.ts` holds the views the hub keeps back until an admin opens
    them: the names in `PREVIEWS` in `src/shared/api.ts`, each open to
    nobody on a new hub, then to the people named, then to everyone, set on
    the Access page and kept in the `previews` setting. `open` in it is the
    one answer to whether a caller is in a preview. Only a person can be
    named, by the address they are kept under: an admin is in only when
    named, a personal token is its person, and a view as someone is theirs.
    A machine token and a source are in only once it is open to everyone.
  - `ground.ts` builds the ground of a blueprint that names one (`ground`
    on the blueprint, `GroundDef` in `src/shared/model.ts`), for one reader
    from what their `View` shows, through `buildGround` in
    `src/shared/ground.ts`: each entity's numbers against the `budget` on
    its number fields, where to go first, the templates and the trial, the
    forecast, and the share inside every budget by week. It stores nothing
    and reads at most `GROUND_LIMIT` entities. A bed (`item`) also carries,
    for each number an aggregation works out, its receipt (`behind`,
    `behindOf` in `src/shared/ground.ts`): what the aggregation's path
    reaches, through the reader's view, each marked by `aggregates` in
    `read.ts`, the same test the value was counted with. A ground and a map each name
    the blueprints they read (`reads`), and are kept, on the hub and in the
    page, until one of those moves or a title shown beside them does: the
    estate never sits still, and an answer every move threw away would be
    built again on every event. A field's `budget` is the
    estate's own range for a value in the catalog; it has nothing to do
    with the load budgets in `budgets.ts`, and it refuses nothing.
    `checkGround` in `blueprints.ts` holds a ground to fields and relations
    of the right kind. What a ground says is in plain words (`over`,
    `inside`, `unwanted`); only the web app draws a garden of it.
  - `map.ts` builds the map of an entity whose blueprint names one (`map`
    on the blueprint, `MapDef` in `src/shared/model.ts`), for one reader
    from what their `View` shows, through `buildMap` in `src/shared/map.ts`:
    the holder and its parts, the places, the plots and where each is
    placed, and the members, in a plot or open. Every check reaches it in
    one shape, `MapCheck`: a scorecard rule, a budget, or a guard that
    passes, fails, or is `unknown` when nothing it reads has a value the
    reader may see. A new kind of check is a new `CheckKind` there, so the
    map can take over a scorecard's work one rule at a time. A scorecard
    with `reasons` turns a level that falls short into its gaps
    (`scorecardChecks`): `Maps.reasonsFor` reads the records once a map,
    through the view, by the id of what each points at, and `fixesOf` ranks
    the fixes across a map. Each thing
    carries the actions its reader may run on it (`actions.annotate`, on
    copies), so a map ticks several and runs one action on all. `tally`,
    `fronts`, and `tendFirst` there are the one way a map's checks are
    counted, ranked by kind, and summed into where to tend first. It reads at
    most `MAP_LIMIT` entities of a blueprint and names the ones it cut. Its
    index says how many plots and members name each holder or one of its
    parts and how their checks stand, read through the reader's view,
    whether the reader owns each holder (`yours`, from what `visibility.ts`
    keeps of what a person owns; `owned` says whether the estate says what
    anyone owns at all), and what the map itself says of each: `primary`
    (the map's `primary` boolean field) and `sector` (its `sector` field's
    value, or the title of the entity its `sector` relation names), each
    read from what the view let through, so a field the reader may not see
    reads as not primary and no sector. It is kept for a reader as the map
    is.
    `checkMap` in `blueprints.ts` holds a map to relations of the right
    blueprints. Its routes, `/v1/map`, and its tool, `get_map`, are in the
    garden preview.
  - `behalf.ts` calls another API as the person who asked, for a webhook
    that names a delegate (`onBehalf`): it trades the access token their
    sign-in gave the hub for one the issuer makes for that API in their name,
    as the pod's workload identity. `auth.ts` puts that token on the request
    (`askingAs`): the machine port's own bearer, or on the session port the
    one the login proxy passes beside the ID token, which never says who is
    calling. `tokenFor` is the only place one is traded: only inside that
    person's own request, and only for a URL the deployment's
    `AUTH_DELEGATES` lists. The one thing kept past a request is the
    grant a person's own signed-in approval gives a run that waits its turn
    (`hold`, the issuer's refresh-capable grant, never an access token
    alone): sealed on the run as `behalf_grant`, taken off it as it is handed
    on (`takeGrant` in `actions.ts`), and dropped when it ends or is put back
    to be tried again, so a retry or a schedule never finds one. A grant the
    run holds is asked with before the request under way, which may be an
    approval whose token has ended. Never keep a person's token any other
    way, and never let an action say where one may be sent. A session whose
    login proxy passes a token for the hub that does not hold is marked
    (`signInStale` in `auth.ts`), and what needs the person's own token asks
    `needsOwnSignIn`, which answers `SignInAgain`: a `401` naming
    `AUTH_SIGN_IN_PATH`, which `session.ts` in the web app follows once.
  - `model-edit.ts` is the one way a person changes the model: a blueprint,
    a relation rule, a scorecard, or an alert rule saved whole (`save`),
    changed by a JSON Merge Patch over its stored definition (`change`, which
    then saves through `save`), removed, renamed, or handed over, with the
    checks on who may say it (`guardModel`: what only an admin sets, and
    what the caller may not see kept as it was) and what follows a save (the
    pivots, the `blueprints` event, the re-link). The model page's routes,
    the `PATCH` routes, and the agent's model tools in `mcp.ts` all call it,
    and `modelRefusal` is the one reading of a refusal both doors answer
    with. `model` is the model as a reader sees it in the import's form,
    which `/v1/model/export` answers. A new part of the model a person edits
    is a kind in `MODEL_KINDS` and a branch of each method, never a route of
    its own beside them (ADR-5001).
  - `activity.ts` is the activity log. `record` in it is the only place a
    row is written, and it names the actor from the request it runs in. A row
    written inside an agent's tool call says so in its detail (`door: mcp`).
  - `http.ts` is the API; `mcp.ts` exposes the same read surface to agents.
    No answer to an agent grows with the estate: every answer goes into the
    agent's model. `cards.ts` is the one shape of what an agent is shown: a
    list is a page with its total, a thing in a list is a card (its first
    small values within `CARD_FIELDS_CHARS`, a bigger one said, the names of
    the rest, and each relation as a count with its first
    few links), one thing shows each way it is linked as a count with the
    first `SHOWN_LINKS`, and wherever something is left out the answer names,
    as `more`, the exact tool call that reads the rest. `AGENT_INSTRUCTIONS`
    in `mcp.ts` is the order an agent climbs in, sent as the server's
    instructions; a tool's description says only its own part. An agent is
    given a person's words, never a blueprint: `q` on `search_entities` finds
    every word in any order across every kind and answers `kinds`, how many
    of each blueprint matched (`kinds` in `read.ts`); a word holds of a thing
    when its stem is in the thing's text or names its kind (`wordsFilter` in
    `cards.ts`), since people say "approvals" for the kind. The hub knows who asks from their sign-in, so an agent is never
    told and never passes it: a filter says `@me` and `@today` and the hub
    fills them in (`forAsker` in `src/shared/filter.ts`, `whoAsks` in
    `mcp.ts`), in a filter and in `run_query`'s view alike (`askerValue`). A view a
    caller sends is judged before it is answered: a condition, a sort, a group,
    or a total on a column the answer lacks, or a time or a number ordered
    against what is neither, is refused with how to mend it (`viewProblem` in
    `src/shared/answer.ts`), never passed over. `who_am_i` says
    who the agent answers for (their address, their own entity) and their
    day: `dayOf` in `src/shared/day.ts` reads it in the `timeZone` preference,
    which the web app keeps to the browser's clock (`useKeepTimeZone`), and an input an agent
    might ask a person for says, in its own description, to work it out. No
    read tool requires an input: an agent's host asks the person for a
    required input it cannot fill, so a call that names nothing is answered
    with how to find it (`FIND_FIRST`). A filter a caller sends is read by
    `readFilter` in `src/shared/filter.ts`, on both doors: an empty object as
    the whole filter is no filter, since a host fills what it leaves blank with
    `{}`, but an empty condition inside one is refused, since a host loses what
    a condition said that way and an answer without it is wider than the
    question; a part that is no filter is named in the answer, never a crash.
    An agent writes every value as text, and `typedFilter` reads it as its
    field's type. A question that
    matched nothing says why (`whyNone`): how many things each condition
    matches alone, and, for a condition on a field that matches none, the
    values the field holds, so an agent mends a guessed value itself. A new tool, or
    a new part of an answer, is bounded the same way before it ships. The
    entity route sends the first `ENTITY_LINKS` of each kind of thing that
    points at an entity and `incomingCount` (`most` on `get` in `read.ts`),
    and the entity page reads the rest a page at a time.
    A query's answer as its view shows it is `shown` in `queries.ts`, the
    one shape `run_query` and `?shaped=true` on the query routes both
    answer with.
  - `metrics.ts` is every metric the hub sends over OTLP, and the only
    place an instrument is made. It times every Postgres statement where the
    pool opens a connection, so a query needs nothing to be counted. Time new
    hub work with `timed` and a `Task` name. A label is a fixed set of values:
    never an entity, a key, a person, or a path. The one exception is the
    field gauge, `observeFields`, whose series are the entities of the fields
    an architect marks `metric`; it alone is also sent to Application
    Insights, and it alone is held to no count of series (`METER_VIEWS`):
    the SDK folds every series past its 2,000 into one overflow series. The standard's required set lives here too: how each request
    signed in (`recordAuth`), every refusal on policy by a fixed reason
    (`recordRefusal`, hooked where `access.refused` is recorded and where
    `Hidden` and `AdminOnly` are answered), every call out by peer
    (`fetchTimed`, never plain `fetch`; `fetchPatient` for a call that may
    wait past the five minutes Node's own fetch allows an answer), the derive queue's depth, who is
    active (read from `presence.ts`), and what the page reports of how it felt (`recordMeasure`).
    An agent's tool call is counted under a name in `AGENT_TOOLS` in
    `mcp.ts`, or `unknown`; a new tool is added there. Every usage event,
    refusal reason, and tool starts at zero (`seedCounts`). Each pod sends
    its own `service.instance.id`, so two pods in a rollout never write the
    same series.
  - `presence.ts` is who was here in the last day, kept in Postgres so
    every hub reports the same count and a restart forgets nothing: people
    from `users.last_seen_at`, which `access.ts` moves at most once a minute
    for a sign-in or a personal token, and browser tabs in `browser_tabs`,
    written at most once a minute a tab and pruned on the lifecycle tick.
  - `pins.ts` is what each person pinned to the top of their own pages: one
    row a pin, in the order they keep them, `MOST_PINS` of a kind at most:
    an action on the self-service page, a blueprint on the catalog's list
    (first, and still in its group), each kept in the order the person
    moves them to. A pin names
    what it points at and nothing more: nothing removes one when its action
    or blueprint goes or closes to the person, and whoever answers shows
    only the pins the reader may use today (`offered` in `actions.ts`, or a
    blueprint they see some of), so one comes back when it does. A renamed
    blueprint takes its pins with it. It is read on every ask and never kept in memory.
    Its routes, under `/v1/mine/pins`, ask only that the caller is a person
    (a personal token is one; a machine keeps none), need no permission, and
    write no activity row: the routes send `ACTION_PINNED` and
    `ACTION_UNPINNED` themselves. `pinned` on an action a person reads comes
    from it.
  - `stars.ts` is what each person starred: their favorite entities, one
    row a star, with no limit. Every catalog grid a person reads puts what
    they starred first, whatever its sort and inside each group
    (`starredBy` in `query.ts`, after the group and before the sort), and
    marks each such row `starred`; the favorites page is one table of them
    (`/v1/mine/stars/table`), built by handing `queries.ts` each
    blueprint's keys. A query, an export, a schedule, and a report never
    read stars, so what they hand on reads the same for everyone
    (ADR-5007): never give `queries.ts` or the query language a star. The
    order is no part of a kept listing's shape, so a star rebuilds nothing
    in `lists.ts`; a grid's tag names the reader's star stamp, and a cursor
    the reader. A grid where the reader starred nothing is ordered and
    marked without stars, so it costs one count and nothing more. A star to what the reader may not see is kept, never shown
    or counted. It goes only when `runs.ts` purges its entity
    (`forgetStars`, in the purge's transaction), and moves with a renamed
    blueprint. Its routes, under `/v1/mine/stars`, are built as the pins'
    are; they send `ENTITY_STARRED` and `ENTITY_UNSTARRED` themselves.
  - `walks.ts` keeps each person's walk through a map: one row a stop, a
    climb on one place (a ladder, the rung it starts from, and the garden
    or kind it is kept to, or none), with the things it named then, so its
    progress is read from the map as it stands. `MOST_STEPS` at most on one
    map. Its routes, under `/v1/mine/walk`, are built as the pins' are and
    sit in the garden preview; they send `WALK_STEP_ADDED` and
    `WALK_STEP_REMOVED` themselves.
  - `preferences.ts` keeps each person's preferences: one row a preference
    they set, by the names `PREFERENCES` in `src/shared/preferences.ts`
    holds, each with its fallback and the values it takes. A new preference
    is one entry there and nothing else. Its routes, under
    `/v1/mine/preferences`, are built as the pins' are: a person only, no
    permission, no activity row, read on every ask, never kept in memory.
  - `welcome.ts` keeps what the estate sets of the welcome tour: which
    blueprint and entity it shows, the actions it may show, best first, and
    each step's words, with a step's words for a reader who may run no
    action where the step has them (`empty`). The
    steps, their order, and the places they point at are the hub's
    (`TOUR_STEPS` and `SPOTS` in `src/shared/welcome.ts`); an estate never
    adds one. A git source declares it under `config.welcome` and owns it
    while it does, as with the column standard. `GET /v1/welcome` builds a
    reader's tour through their `View` with `buildTour`: a pick they may not
    see falls back to the first they may (the first ranked action they may
    run, else any), and a step that needs what they cannot see is left out. It and the settings route live in the `welcome`
    preview.
  - `history.ts` keeps the history of the fields marked `history`: on the
    lifecycle tick it reads them through `read.ts`, writes a point only where
    a value moved, lets go of what a field no longer keeps, queues the
    entities whose trends read the new points, and names the
    blueprints that gained a point in an `estate` event, so only what reads
    them is read again. `read.ts` reads the points back for a trend from
    history before it computes anything else. It also gives the field gauge
    its readings, from the same kept values.
  - `telemetry.ts` is what the hub tells Application Insights about how it
    is used, on when `APPLICATIONINSIGHTS_CONNECTION_STRING` is set: a span
    for each API call, with who made it, and the usage events. Every event
    name is in `src/shared/usage.ts`, and an event is never named inline.
    What the hub sends for something that writes no activity row is in
    `HUB_EVENTS` there, so it starts at zero with the rest.
    `activity.ts` sends each row it writes through `sendChanges` once the
    row's transaction commits (`afterCommit` in `db.ts`), so a change in the
    activity log needs nothing more to be counted. `traced` puts the
    request's session, caller's address, and route on the active context,
    and every event sent inside the request carries them. The web app's page views
    and events reach it through `POST /v1/telemetry`, which stamps the
    signed-in person. `appinsights.ts` turns the spans, log records, and the
    field gauge's points into the ingestion API's envelopes; nothing else
    knows that format. The same route relays each batch to the Faro
    receiver at `FARO_URL` as `orrery-web` (`faroPayload`), with the person
    the hub signed in and never the page's word, and counts its views,
    waits, and errors into the metrics, so the page reports whenever any
    store keeps it (`telemetryOn`).
  - The hub never writes its own description. `orrery.yaml` and `logo.svg`
    at the root say what this repository builds, for the forge reader of an
    estate that reads it; the image ships neither.
  - `db.ts` opens the database as `connectionOf` says: with the URL's own
    password, or with `DATABASE_AUTH=azure` as the pod's workload identity,
    whose Entra token (`workload.ts`) is the password. The pool and the
    leader's connection share it. Every pooled connection turns Postgres's
    statement compiling off (`SET jit = off`) before its first statement:
    the hub's statements are many and short, and compiling one cost half a
    second of a grid's shape.
  - `db.ts` applies the numbered files in `migrations/` at start, each once,
    recorded in `schema_migrations`, under an advisory lock. During a
    rollout the release before runs on the new schema, so a step only adds:
    a step that drops, renames, or retypes comes a release after the code
    that read the old shape is gone, and says so on a `-- contract:` line.
    Never edit a step that has shipped; add the next one. Never write a step
    that rewrites a large table.
  - `bridge.ts` is what hubs on one database tell each other, over Postgres
    `LISTEN` and `NOTIFY`. The database itself says when a table a hub loads
    into memory changed (the triggers in `0008-definitions-notify.sql`, by
    the pool's `application_name`), and each other hub reads it again
    (`reload` in `hub.ts`). Every event a hub emits is sent on, and told to
    the other hubs' listeners after they have read again what changed
    before it (`deliver` in `events.ts`, never sent on twice). A table a new
    store loads from gets a trigger, and the store joins `readAgain` in
    `hub.ts`. Nothing a hub must know of another may live only in memory.
    `ROLE` says what a hub does: `api` never takes the lead and leaves the
    re-link after a commit to the leader, `worker` is a hub given no
    traffic, and `all` is both. Any number of each may run: every hub that
    is not `api` drains the derive queue (`deriving` in `main.ts`), and only
    the leader links again and runs the timed jobs; a hub that derives
    beside it tells it through the `derived` event.
  - `leader.ts` decides which hub runs the background work in `jobs.ts`:
    the one holding a Postgres advisory lock. Two hubs serve side by side
    during a rollout, and anything that runs on a timer belongs in `Jobs`,
    never on a timer of its own. `Jobs` runs the first passes one after
    another, in the order they were added. A hub that takes the lead runs
    `catchUp` in `hub.ts`, which reads again everything the hub keeps in
    memory and tells only its own listeners so (`local` in `events.ts`: the
    other hubs kept up), then `backfill`, then the jobs; a store that loads
    at start is added to `catchUp` too.
  - A hub is ready as soon as it listens: derived state is in the database,
    so there is nothing to warm. `/readyz` depends on nothing but draining.
    Never make it wait for a read.
  - `main.ts` drains on `SIGTERM`: `/readyz` turns 503, the hub keeps
    answering for `DRAIN_SECONDS`, ends the event streams, waits for the
    requests it holds, stores what it noted, then lets go of the lead.
  - `hub.ts` wires it all. `main.ts` and the tests share it.
- `src/web` is a Vite React app served by the server from `dist/web` in
  production and proxied from the Vite dev server locally. `trail.ts` is the
  one history of a tab: every visit is a step, one for each browser entry,
  whose id rides on `history.state`, so Back, Forward, a swipe, the
  breadcrumb, and the whole trail's list all move the browser and never a
  copy of it. `navigate` in `router.ts` writes through it, and `useRoute`
  reads the shown step, so a page and its step always move together. A page
  names what a step shows with `useHere` (a run's title, an entity's), which
  the breadcrumb and the window's title read; one that does not is named by
  its address (`stepName` in `title.ts`). The breadcrumb is the path, not
  the history: a step reached from the main menu (`start` on `Link`: the
  rail, its kinds, the logo, the tab bar) or a jump from the command bar, or
  opened first, starts a path, and the breadcrumb reaches back no further
  (`cameFrom`); Back, Forward, and the whole trail still walk every step. A
  link inside a page never starts one. `components/Trail.tsx` draws it:
  the strip above every desk page and Back on a phone's top bar. Our Back
  goes up the path one place (`upFrom`) and is off where the path starts,
  as an app's back is; the browser's own Back, a mouse's, and a swipe walk
  every step, as on every site. Recent (`RecentList`, beside Back on a
  desk and under More on a phone) lists the whole trail. A way
  up to a page's list on a phone is drawn as that page's icon, never an
  arrow, so it is never taken for Back. `components/editors.tsx`
  holds the editors every view shares (icon picker, value editor, relation
  picker), opened in a `Popover` so a clipped table cell can show one.
  An `openapi` field's document is read on the entity page as a reference,
  its operations opened in place, by `components/Spec.tsx`; `spec.ts` reads
  the document, its refs included, into what that panel shows: how each
  operation signs in, a request ready to paste and an example response, and,
  from the pushed value the last push replaced, what changed. A link to one
  operation is the page's address with `#<field>:<METHOD> <path>`.
  The model page's camera is `useCamera` in `components/graph.ts`, to the
  canvas standard: one way for every device, the wheel always zooms
  and glides, a drag on the empty canvas pans, Shift and a drag picks, and
  `wheelZoom` is the one reading of a wheel event. React Flow's own wheel
  handling stays off.
  The front page's answers (`summary`, `mine`, `alerts`, `blueprints`) are
  kept in the browser by `kept.ts`, keyed to the signed-in person, and put
  back into the query cache as stale once `/v1/whoami` has said who they
  are, so the page paints while the hub builds the fresh ones. A kept answer
  is never shown to another person or while viewing as someone else.
  `components/FieldForm.tsx` is the form for a field's definition, shared by
  the model page and the grid. `FieldPopover` in it changes one field and
  saves at once: a card on the model page and the grid's column menu both
  open it. A blueprint's whole editor, its relation popover, and the import
  are `components/BlueprintEditor.tsx`, shared by the model page and the
  phone. A task that needs more room
  than a popover opens in a `Drawer`, a modal panel at the side of the page;
  an action's form opens in one wherever it is run from, through `RunDrawer`
  in `components/ActionForm.tsx`. Escape closes the newest thing a person
  opened, wherever focus is: a popover, a drawer, a dialog, the palette, the
  tour, or a panel or form with a close or Cancel button. Each holds its
  place with `useEscape` in `layers.ts` while it is open, and never listens
  for Escape itself; a control that spends Escape on itself first (an open
  list, a field that clears) stops the event. A form holding changes it has
  not saved asks before Escape lets them go: it says so through `unsaved` on
  `useEscape`, a `Popover`, or a `Drawer`, and `useChanged` there says whether
  what it holds moved since it opened. A page holding changes it has not
  saved asks before a visit takes the person elsewhere, or the tab closes,
  through `useLeaveGuard` in `router.ts`; the browser's own Back is never
  held. That form draws each input from `CONTROLS` (a list of a kind that
  does not pick is `ListEditor`, a box a row, whose rows, pastes, and row
  checks are `src/web/list-rows.ts`),
  one control a kind, and checks it with the same `checkInput` the hub runs;
  the builder in `components/ActionEditor.tsx` asks only for the options and
  rules a kind takes. A new kind is one entry in `INPUT_KINDS` and one in
  `CONTROLS`: nothing else names a kind. The form asks only the inputs
  `askedInputs` names, under the action's sections, and a walked form's
  steps are `walkSteps` in `actions.ts`: a step with nothing asked is never
  one. A filter a person edits as conditions is `Conditions` in
  `components/Clauses.tsx` over `src/shared/clauses.ts`: a chip each, said
  as a sentence, opened to change it in a popover whose every list is
  searched by typing. The grid's filter bar stays folded under its Filter
  button until a person opens it or picks a share of the spread, so a
  shared filter curates the rows out of sight. It, a query's sources, and the
  builder's "Ask only when" all draw it; which tests a kind of field offers
  and what each is called is `src/web/conditions.ts`. A condition may be
  turned round (`not` on `GridClause`), and a value is read as text where
  its field holds text (`typesOf`), on either side. A share of the grid's
  spread of values is a button: `shareClause` is the one answer to what
  condition it stands for, and `withShare` to what it replaces; a click keeps
  its rows, Control, Command, or Option leaves them out, and the condition's
  own choices are counted without the conditions on its field. What a button does to an
  action's sections in the builder is worked out in `builder.ts`. A run's page (`ActionRunPage` in
  `components/ActionRun.tsx`) reads what happened to the run from `happened`
  in `actions.ts` and draws its log with `components/RunLog.tsx`; `runlog.ts`
  is everything that log is worked out from: a line's reading, a terminal's
  colours as spans, the groups by step, and the text that is copied and
  downloaded. A colour in a log is one of the `ansi` tokens, never the
  colour the escape names. Every request goes through
  `call` in `api.ts`, except the page's telemetry in `telemetry.ts`, which
  leaves by beacon as a tab closes. When an answer says the sign-in has ended, `session.ts`
  reloads the page so the login proxy signs the person in again; a view never
  handles that itself. The event stream opens with the hub's version:
  `release.ts` compares it with the release the page was built from and
  `NewRelease` offers a reload, and a stream that dropped reads everything
  on screen again. What the stream says moved goes through `markStale`: a
  tab in view reads it again at once, and a hidden tab only when it comes
  back into view. A built file that fails to load reloads the page once
  (`index.html`). The API stays backward compatible for one release, for the
  pages still open on the one before. On a phone, below the `md`
  breakpoint that `useNarrow` in `components/ui.tsx` reports, the pages sit
  in a tab bar at the bottom, and a `Popover` or a `Drawer` rises from the
  bottom as a sheet; the spacing a popover's classes give is laid round
  what it holds there (`sheetParts`), under the handle. A page puts its heading and buttons in the top bar
  through `PhoneBar` in `components/PhoneBar.tsx`, in place of the logo, and
  a blueprint's search opens there from a magnifier. The catalog starts at the list of blueprints, and a
  blueprint's rows are cards or a table whose titles stay put while its
  columns scroll sideways, read through
  the same blocks as the desk's grid. A record opened from that list steps to
  its neighbours through `browse.ts`. The model page walks one blueprint at a
  time in `components/ModelWalk.tsx`, its neighbours drawn by `Orbit`, and is
  changed there as sentences: each part of a sentence opens the one thing it
  says, through the same forms the desk uses, and the last sentence adds a
  property or a relation. `src/web/sentences.ts` is the one place the model
  is said in words: a kind of field, a count, a copy. Search, at `/search`, finds entities of every
  blueprint. A sideways swipe is `useSwipe` in `components/swipe.ts`, and
  every swipe has a button that does the same.
  The catalog grid and the query page fill the window and scroll inside
  themselves (on a phone the query page scrolls as a page). The front page fills the window where `useDesk` in `components/ui.tsx`
  says the window is big enough (the `desk` variant in `styles.css`, which
  must match): the sky takes the height left between the headline and the
  chosen area's list, and every list scrolls inside itself. Elsewhere it
  scrolls as a page. The Self-service start page does the same: its actions
  and its runs side bar (`RunsPanel` in `components/ActionRun.tsx`) each
  scroll under a header that stays put. That header holds what waits for the
  reader and the search; under it come what they pinned, their recent runs,
  and the sections of tiles (`ApprovalsBand`, `Pinned`, `Recent`, and `Tile`
  in `components/ActionStart.tsx`, laid out by `Catalog` and `Sections` in
  `components/Actions.tsx`). `PinStar` in `components/Star.tsx` is the one control that pins or
  lets go, on a tile, on an action's own page, and beside a blueprint's
  name on its grid; `PinMoves` there, over `usePinMoves`, is the one that
  moves a pin a place earlier or later, on a pinned tile and on a starred
  kind in the rail and on a phone. It, like every control that moves a row,
  keeps the focus on itself as its row moves; `EntityStar` there the one that stars an entity, on
  a grid row, a phone card, and an entity page; the favorites page is
  `components/Favorites.tsx`, drawn by `QueryGrid`; `usePins` in `api.ts` reads
  a hub that keeps no pins as null, and then there is no star and no Pinned. `actions.ts` is what those pages say of an
  action and of a run: the icon to draw, whether it is failing, how long it
  usually takes, what a run was on, and the sections of tiles. `sectionOf`
  says which section a tile sits in: its home as the reader sees it, else
  its group. `sectionsOf` is the one order: the reader's own homes, then the
  shared order, the other homes, the other groups, and what has neither
  last. `movedSection` is the one move Organize saves, and it never saves
  the lift of a reader's own homes. `actionsMoved` is the one answer to
  whether an event moves the list a page holds: a home's title or icon, or
  a blueprint what the reader owns is read from, which the hub names as
  `reads` beside the list. The pins are read again with it. `HomeActions` in
  `components/ActionStart.tsx` lists a home's actions on its entity page. It
  is the one place that reads what a hub one release back does not send, so
  a component never reads `iconShown`, `stats`, `homeShown`, or
  `entityTitle` itself.
  The ground pages are an atlas under the sky, and the data is the star:
  a page of it never explains itself. What a mark means is in the picture's
  key and in `docs/ground.md`; a panel holds data and actions, never a
  sentence about how the view works, and a heading is two or three words.
  Every layer fills the window through `Shell` in `components/Atlas.tsx`,
  where `useDesk` says the window is big enough (`App.tsx` names them with
  the other pages that fill it): the picture is the stage, one translucent
  panel along the right edge scrolls inside itself, and the page never
  scrolls. A stage whose picture is a list longer than the window (a
  continent's meadow and walk, a garden) scrolls inside itself; a
  continent's meadow stays pinned at its top while the walk scrolls under it.
  Pointing at something on a stage repaints and never moves: a mark it
  lights changes colour, never size, so nothing slides out from under the
  pointer. Elsewhere the parts
  stack, stage first. Every panel is the same skeleton in the same order:
  the peek while a thing is opened, the verdict (`Verdict`), one bar with
  its three counts (`SkyBand`), one ranked list (`Ranked`: plain rows, one
  red bar each), then what is the view's own. `Shell` also owns what every
  layer shares and nothing else draws: the key (`legend`, a list of
  `KeyMark`: the real mark, a word or two for the corner, a sentence for
  the full key behind the "?"), the first visit (`tour`, three `CoachStep`s
  shown once a browser and replayed from the key), and the arrival (a layer
  reached by a press on the layer above opens out from the press, once, and
  not under reduced motion). The lens is `LensPicker`, one control on every
  layer that has one, floating on the stage's upper left: "Every check",
  then each check by name. `/ground` and `/map` are the star chart in
  `components/AtlasSky.tsx`: map holders only, each as far from the sun as
  its share of broken checks, in the bands `skyBand` in `atlas.ts` names;
  one that holds nothing or has no check is not drawn. `skyChart` there is
  the whole layout, and nothing else places a body: a band is as wide as
  its bodies need, a body's bearing is its slot in its sector's slice by
  its key and never follows its health, and inside a band the less broken
  are never further out. Which bodies are drawn large is the page's: the
  map's primaries, the reader's own, and their pins, or every body where
  the map names no primary. Which stand named is narrower: the primaries,
  the pins, and what a search finds (the worst few and the largest few
  where the map names no primary); every other body names itself when
  pointed at, focused, or opened. `skyNames` in `atlas.ts` is the one
  placement of a name: the far side of its body from the sun first, or the
  side that faces away from a large neighbour close by, then the other
  sides in a fixed order, then off its body on a tie line. Touching, no
  other body may be nearer the name than twice its own or within the clear
  room; tied, no large body may be as near as its own, and the line must
  run clear. A spot in another large body's caption zone (straight above,
  below, or beside it) is a last resort, on a tie line only. A name with
  no clean spot is dropped, never forced. The names that must stand are
  asked first, the largest first, may step out further, and a sector's
  name gives way to them; a name shown only for a moment is placed last,
  so it never moves one that stands. A name's plate is part of its body's
  pointer target; the body is the one tab stop. A kind with a ground is
  never a body: it is a lens, listed in the panel. A kind's ground is
  `components/Ground.tsx`: an archipelago, one hex cell an entity and one
  island the folder its keys share, read through one lens at a time
  (`lensOf` in `src/shared/ground.ts`: every budget, or one), which the
  storm, the fog, the verdict, the counts, and the gold route of the
  rounds all follow; an entity's own status is not a budget and is never
  drawn on the map. One entity's page is its bed, drawn by
  `components/GroundArt.tsx`. A map is `components/Map.tsx`, one grain a
  level: the planet draws one cell a plot on each place it runs on and one
  cell each part's things of one kind on a place's open ground, the cells
  of one part together as one cluster on a land (`planetOf`), never one
  a thing; a continent (`at` on the route) draws a meadow, one flower a
  garden or a patch, with the walk under it; a garden (`plot`, or `kind`
  for one kind of open ground there) draws a plate of specimens, one flower
  a thing. Every check climbs a ladder (`ladder` and `rung` on `MapCheck`,
  `ladders` on the map): a scorecard's levels, or a budget or a guard as a
  ladder of one rung. `standingOf`, `climbsOf`, `mendedBy`, `inBloom`, and
  `growthOf` in `src/shared/map.ts` are the one reading of how far a thing
  got and what mends it, and the lens picks a ladder. A flower is
  `flowerOf` in `atlas.ts`, a slice a ladder at the same bearing on every
  flower, drawn by `FlowerArt`. A person's walk is theirs alone, kept by
  `walks.ts` the way pins are (no permission, no activity row, read on
  every ask) under `/v1/mine/walk`, in the garden preview; what a page
  reads of it (what it grows, a stop's progress, what blooms) is
  `src/web/walk.ts`, pure and tested alone. Colour on a map means health
  and nothing else; gold is what the walk grows. What is
  tied to no place (`at` null: the members on none, and every plot for the
  checks that are its own wherever it runs, `nowhereOf` in `atlas.ts`) is
  no continent: it lies on a bench beside the globe (`benchOf`) and opens
  as a meadow of its own, kind by kind and then the plots. So a plot's
  own checks are counted there and on no place, and `byPlace` in
  `src/shared/map.ts` is the one count of a map place by place: the places
  and no place add up to the whole. The code knows it only as no place;
  "the workshop" is a word in `ground.ts`. A plot is any entity a holder
  holds (a service, a team, a site), so no text on a map names one
  industry's kinds: it says the words in `MAP_WORDS` and the model's own
  kind names (`kindName`). A plot's peek names each side of it (its own
  checks, and each place it is on) as `kin`. A holder's parts are drawn only
  when asked for: a chip a part, and the one picked is outlined while the
  rest stands back. Where each thing lands is worked out in `atlas.ts`,
  pure and the same each time: the hex land, the globe, the bench, the
  islands, the sky's bands, the flowers, labels that keep out of
  each other's way, and markers fanned apart. Every colour is a token
  (`--color-atlas-*` in `styles.css`, in both themes). A click on a thing,
  on every layer, opens a peek of it (`PeekCard`) at the head of the
  panel, never a tick: what it is, how it is and why, its page in the
  catalog, and the addresses its `url` fields hold (`links` on a ground
  item and a map thing, from `linksOf`). A hover card reads the mark aloud
  with its reason, in a line or two. The keyboard opens the same peek: a
  body of the sky is a tab stop (Space peeks, Enter opens its planet), and
  the globe is one tab stop whose arrow keys walk from cell to cell. A
  thing's name is set by `NameText` (and `wrapName` in a picture): broken
  only after a dot, a hyphen, an underscore, or a space, a piece too long
  for its line cut with an ellipsis and the whole name kept as its title.
  Ticking is apart, in `components/Hands.tsx`: a tick box is drawn only
  for a thing whose `actions` are not empty, in its peek and on its row,
  and the tray only while something is ticked, so a reader who may act on
  nothing sees neither. Every mark stands for one number the reader can
  open, no data is never drawn as healthy, and nothing moves on its own.
  Text in a picture is sized in screen pixels from the picture's width,
  never under the floor, and never turned more than 45 degrees.
  `ground.ts` holds the words: the atlas has one reading, a garden's names
  (`WORDS`, `MAP_WORDS`), and a garden's word never reaches an address or
  the API.
  The sky on the front page draws an arc round a kind that has a ground and
  lands on it. All of it is shown only where `usePreview('garden')` in
  `api.ts` says so.
  The welcome tour is `components/Tour.tsx`: an overlay that opens each
  step's page, finds the place it points at by its mark (`spot` in
  `spots.ts`, one mark per name in `SPOTS`, held there by `spots.test.ts`),
  and skips a step whose place this screen does not draw. A new place the
  tour points at is a name in `SPOTS`, a mark on the component, and a step.
  `components/Welcome.tsx` decides what greets a person, once a load: the
  tour when its version is above their `welcomed`, else the notes in
  `whats-new.ts` they have not read. A note names `after`, the release that
  was current when it was written; a change a person would notice adds one,
  in their words. Both are shown only where `useGreets` says so: the
  `welcome` preview, a person, and never while viewing as someone.
  `components/Sources.tsx` is the sources and the keys that sign in. A
  source's own keys sit on its page and are made there; the keys no source
  holds (access and personal keys) and the check secrets are shelves in its
  list (`shelf` on the route). `src/web/sources.ts` groups and searches that
  list, pure and tested alone. A key is made in a drawer that shows its
  secret in the place it was made, and registering a source opens that
  drawer next.
  `public/icons`
  is generated, one colour SVG per brand: add a brand to `src/shared/icons.ts`
  and, when it is not in the default set, its source to
  `scripts/brand-icons.mjs`, then run `npm run icons`. The same script
  vendors Microsoft's whole Azure service icon pack as the `azure_` names in
  the generated `src/shared/azure-icons.ts`: never edit that file or add an
  Azure service by hand. A mark drawn in black is repainted in the theme's
  ink: the script writes a light theme copy under `public/icons/light` and
  the name to the generated `src/shared/inked-icons.ts`, and `Icon` swaps it.
  The app reads as an app, not a terminal: labels and buttons are sentence
  case in the sans font, and the mono font is for ids, keys, paths, and code.
  A button's look is the `btn` utility with `btn-ghost`, `btn-solid`, or
  `btn-danger` in `styles.css`, for a link or a label that acts as one too,
  and a small label is `label`. A field's kind is drawn by `TypePill` or
  `TypeGlyph` in `components/FieldType.tsx`, the same picture and colour
  wherever it shows.
  The app has two themes, dark by default and light, kept per browser by
  `theme.ts`. Every colour is a token in `styles.css`; light swaps the same
  tokens under `data-theme='light'`. A component never names a colour: it
  uses a token class, or `var(--color-...)` where a style object or a graph
  library takes a colour.
  The rail along a desk's left (`Rail` in `App.tsx`) holds the daily pages
  as rows (`DAILY`: Favorites only once the reader starred something they
  may see, `useHasStars`), the pages that look at the estate whole as one
  row of tiles (`ESTATE`), the catalog's kinds, and at its foot the
  account and `HubMenu`, every other page in one panel. Zen mode and the
  theme are switches at its top, beside the fold. Search is never in the rail: on a desk it
  is `FindButton` at the right end of the strip above every page, and on a
  phone the Search tab and Now's own box. It folds to its icons: the switches,
  the daily pages, the tiles, the catalog, and its foot, without the kinds. Whether it
  is folded is `useRail` in `rail.ts`, kept per browser like the theme; the
  model page brings its own blueprint list, so the rail folds each time a
  person arrives there, and opening it there lasts the visit. Its width is
  `--rail`, which whatever sits fixed beside it reads.
  Zen mode (`zen.ts`) is the estate without the alarm, kept per browser
  like the theme. `data-zen` on the root swaps red, amber, green, and the
  alarm value colours in `styles.css` for quiet ones, and stills the lamps'
  glow; what removes something reads `danger`, which zen never touches. A
  lamp on a page a person browses (the rail, the grid, search, the palette,
  the model, an entity) is drawn `calm`, and `Lamp` draws no calm lamp in
  zen; the grid drops its status column and picker, and an entity its
  status line. Now speaks of the estate, not of what fails: its headline
  counts things, the sky draws every kind as a quiet dot (`Sky` reads
  `useZen`), and what needs attention folds into one line. The pages made
  to show health (the wall, scorecards, sources, security, ground)
  keep every lamp, in the quiet colours: never mark one of theirs `calm`. A
  field's own coloured value is data: zen quiets its colour and never hides
  it.
- The web app meets WCAG 2.2 AA in both themes. The contrast each token
  keeps is written at the top of `styles.css`: text is `ink-500` or
  brighter, never `ink-600` or below, and a field's border is `edge`. The
  focus ring is global: never take the outline off something Tab reaches.
  Every control has a name and every field a label. A status is never colour
  alone: `Lamp` gives each level a shape and a spoken name. Whatever a
  pointer does, the keyboard does: the catalog grid moves by arrow keys from
  one tab stop, a `Popover` takes focus in and gives it back, and a drag has
  a menu item that does the same. Check a change with axe in both themes.
- `src/server/fixtures/catalog` is test data the server tests load as a git
  source. It exercises the hub; it is not a model to copy.
- `docs/modelling.md` is the guide to modelling an estate. Its rules hold for
  any model; the blueprints it names are an example, never a model the hub
  ships.
- `src/server/fixtures/model.yaml` is the model the tests import through
  `/v1/model/import`. It exercises the importer; it is not offered.
- `.claude-plugin/`, `.mcp.json`, `skills/`, and `scripts/mcp-headers.sh` are
  the agent plugin. The person's key is its `personal_key` setting
  (`userConfig`), sent as a static header; Claude Code gives the header
  script no setting values and lets what it prints win, so the script asks
  `claude plugin configure --json` whether the key is set and prints nothing
  when it is, else falls back to the tokens file. A skill reads the rules from the hub's `modelling_guide`
  and never copies them; a change to a convention changes
  `docs/modelling.md`, and the skills only when what an agent does changes.
- `sdk/` is the Go module every pusher, runner, and shell job uses. A pusher
  contains only fetch, shape, and the blueprints it writes, which it offers
  to the hub at start. `sdk/photos` is the one way a pusher puts people's
  photos: it makes a photo into the hub's two sizes and keeps the hub's
  photos in step with a provider's, given a `Fetch` and each person's
  address (the one their person entity answers to) and id. `cmd/orrery` is the command line, in two halves. A
  machine's commands (`main.go`: push, put, patch, delete, heartbeat,
  refresh-git, report) use the SDK with a source or access token. A
  person's commands (`commands.go`: login, actions, action, run, watch,
  runs, get, search, queries, query) are each one call to `/v1` as the
  person signed in, and hold no rule: nothing there names an action, a
  blueprint, an input kind, or a permission, and what the hub's answer does
  not say the command does not work out. A person command that needs
  something the API does not answer adds it to the API first (as
  `?shaped=true` on a query). `-o json` prints the hub's answer as it came.
  A release publishes it for people's computers through
  `.github/actions/cli`, as `ghcr.io/orchard-suite/orrery:cli-<version>`. The
  maintainer's machine runs it from `~/.local/bin/orrery`, built from this
  checkout; a change under `cmd/orrery` is done once it is rebuilt there:
  `go build -ldflags "-X main.version=$(git describe --tags --abbrev=0 | sed 's/^v//')" -o ~/.local/bin/orrery ./cmd/orrery`.
  `person.go` is the one client and the sign-in: a hub's line in the tokens
  file, which the agent plugin also reads when its `personal_key` setting is
  empty. `store.go` is that file and the keychains; a key is never
  printed, logged, or put on a command line. A revealed answer (`told`) is
  written to the terminal itself (`tty`) and nowhere else, and with no
  terminal the run is not asked for. `output.go` is the tables and `help.go`
  every command's help, written for an agent that reads it cold: a new
  command or flag is added there in the same change. `cmd/pusher-k8s` is
  the in-cluster pusher, with its blueprints in `blueprints.yaml` beside it;
  `cmd/pusher-entra` pushes an Entra tenant's enterprise apps, their
  assignments, groups, and users, the same way, and puts each user's
  profile photo, through `sdk/photos`, as their picture; `cmd/entra-grant` gives a
  person access in Entra for a runner job; `cmd/azure-restart` restarts an
  Azure app or virtual machine for a runner job; `cmd/azure-job-start` starts
  an Azure Container Apps job and follows it to its end for a runner job;
  `cmd/telemetry-query` reads logs from Loki and metrics from Prometheus for
  a runner's tool, and only reads; `cmd/job-starter` starts one container
  for each run of a `job` action and keeps the hub told of it: `Starter` in
  `starter.go` is the whole of what it decides, over a `Platform` (start,
  seen, stop) that `kubernetes.go` and `azure.go` each are, and it keeps no
  state between passes, so nothing it must know may live only in its
  memory. What an estate lets it start is its config (`config.go`): never
  let an action's own words pick a namespace, a manifest, or an image the
  template does not allow. `cmd/internal/containerapps` is the one client
  of Azure Container Apps jobs, which `azure-job-start` shares;
  `cmd/internal/workload` is
  the one workload identity sign-in, in any tenant, they all use;
  `cmd/internal/graph` is the one Microsoft Graph client the Entra commands
  use; `cmd/runner` is the health check runner.

## Rules of the house

- Two surfaces, two ports. The session port takes the person from the login
  proxy: from the signed ID token it passes on when `AUTH_ISSUER` is set, and
  then never from a header; from its identity headers only when no issuer is
  set. The machine port trusts only bearer tokens: the hub's own, and, with
  `AUTH_API_SCOPE` set, an access token the issuer signed for an app to call
  the hub as a person (`verifyAccess` in `signin.ts`). Never let a header
  set identity on the machine port.
- An admin may view the hub as another person, read-only, to check the access
  rules. `viewingAs` in `auth.ts` reads `x-orrery-view-as` (or `view_as` on a
  GET, for the event stream and downloads) on the session surface from a real
  admin, never from a token and never on the machine port, and makes the
  identity that person's with the admin kept on `identity.viewAs`. The activity
  log and the logs name the admin. Any request that is not a read is refused
  while viewing as someone. A read sent as a POST, because what it asks is
  too long for an address (a query, its export, a batch's preview), is named in `READ_POSTS` in
  `auth.ts` and let through. The web app shows no edit control: `useCan`,
  `useCanEdit`, and `useIsAdmin` are false then, and only `useHolds` says what
  the person holds. `mcp.ts` and `/v1/ingest` never see it.
- The login proxy says who a person is and whether they are an admin, and
  nothing more. What anyone else may do is a role given in the hub. Never
  map a claim to a permission, and never give the admin role in the hub.
- Only a person is ever restricted. An admin, a machine access token, and a
  source see everything. A personal token is the person.
- A view in preview does not exist to a caller it is not open to. Its
  routes answer `404` as an unknown address does, its agent tool is not
  listed, and the web app draws no link, page, or control of it and asks for
  none of its data. Guard a new surface of one on the server with
  `previews.open`, and in the web app with `usePreview`; never with a role
  or `useIsAdmin`. The model's own part of a preview (`ground` on a
  blueprint, `budget` on a field) is saved and read like the rest of the
  model, by whoever may read and change the model.
- Every route that returns entity data, a count of it, or a blueprint goes
  through the caller's `View`. A new read route that skips it leaks. A filter,
  a sort, or a scorecard rule that reads a field the caller may not see is
  refused, never answered. What a person may not see is left out, never
  marked: no placeholder, no count of what was withheld, and no relation to
  or from a blueprint they may not see, on an entity or on a blueprint. A
  save from them keeps what they were not shown as it was.
- The audiences and classes are an admin's alone to change, or a git
  source's while it declares them under `config.access`; when git lets go
  they stay as they were. A class decides its fields wherever they are: a
  rule written on a classified field is refused, never merged.
- Access rules, admin-only marks, and a field's `summary` mark are set by
  admins alone. What access is
  decided from is changed by hand only by an admin or a holder of
  `access.values`, through `refusesHandEdit` in `visibility.ts`, which every
  edit route asks in `http.ts`. Never let a pusher's offer carry a rule or a
  mark.
- Every route that changes something is guarded by `allow` with a
  permission and an activity kind. A route never tests a role id: it asks
  for a permission. Nobody hands out a permission they do not hold; keep
  that check in `access.ts`. What is one person's own to change needs no
  permission, and its route asks only that the caller is that person: their
  tokens, which still write an activity row, and their pins, which write
  none. A hand edit of an entity's values is the one change two things let
  in: `entities.edit`, or an edit rule that opens every value of the change
  to the caller on that entity. Its routes ask `editing` in `http.ts`, and
  nothing else decides it.
- Everything that changes the estate, the model, a shared layout, or who may
  do what writes an activity row through `record`. A save that changed
  nothing writes none. A secret's value never goes in a row.
- The model belongs to the user. The hub ships no catalog: never add a
  blueprint, group, rule, or scorecard to the hub that names a platform, a
  vendor, or a way of organising an estate. Server and web code never test
  for a blueprint id other than the reserved ones in `src/shared/model.ts`.
  The icon set is the one place products are named: an icon is a picture, not
  a model. The files in `src/server/templates` are offered for import and
  nothing more: the hub never loads one by itself, and what an import brings
  is the importer's to edit.
- Ids starting with `orrery_` are the hub's own blueprints, defined in
  `builtin.ts` and locked. Nothing else may define one. The one thing about
  them that is not the hub's is who sees them: admins only until an admin
  shares one through `/v1/access/hub-blueprints/:id`, kept in the
  `hub.access` setting and applied each time the hub writes them.
- The hub seeds no blueprint. A hub that holds `repository` or `service`
  from an earlier version keeps them as the user's own: never re-create,
  overwrite, or remove them. The starter roles are seeded once and are the
  user's from then on: never re-create or overwrite one.
- A setting everyone shares, such as the order of the groups and of the
  blueprints inside them, which groups start closed, and which blueprints
  are hidden from the catalog's list, is changed where it is shown by
  whoever holds its permission. When a git source declares it, git owns it until it stops.
  The model graph's layout is one: anyone may show, hide, move, and
  rearrange its cards for themselves until they leave the page (a rearrange
  is worked out by `POST /v1/model/layout/place`, which saves nothing), and
  a holder of `model.edit` saves what they changed for everyone, so the hub
  places a hidden blueprint as it places a shown one.
  What is one person's own is stored only where they would expect it on
  every device: their pins (`pins.ts`), their stars (`stars.ts`), their
  preferences (`preferences.ts`), their walk through each map
  (`walks.ts`), and the picture they pick (`pictures.ts`), and nowhere
  else. What is about one browser or one
  screen (the theme, zen mode, a panel's width) stays in that browser. What
  a page is doing right now, such as a group opened or closed, is never
  stored. The filter
  and the sort a catalog grid opens with are the same: the shared one is kept with the
  grid's columns, and what a person changes in their own grid is gone when
  the page loads again. Back and Forward still find a page as it was left:
  what it shows on a step (a filter, a tab, a search, how far a list
  scrolled) is held on that step in memory through `useVisit` and
  `useScrollBackIn` in `trail.ts`, and a reload or a new visit starts clean.
- A grid's columns open in the order of the estate's column standard
  (`src/shared/columns.ts`, kept by `standard.ts`); `arrange` there is the
  only place an order is worked out, on both sides. A grid's own layout holds
  only what a person changed by hand on top of it. Never write a whole column
  order into a grid to make it follow the standard, and never clear a
  person's hand change to restore consistency: change the standard instead.
- A pusher offers its blueprints, and an import does the same. The hub
  creates the missing ones and adds to an existing one the fields, relations,
  rollup paths, and enum values it lacks (new values go after its own). An offer never changes or removes anything that
  exists, and never touches a blueprint defined in git or by the hub.
- Any source registered for a blueprint may write any of its fields. A write
  over a value another source wrote is accepted, logged as a warning, and
  raised as a finding. Do not add field ownership to refuse it. The one
  exception is what access is decided from (`accessNames` and
  `refusesForeignWrite` in `visibility.ts`): a blueprint only an admin
  changes, a field marked so, and what a grant's path reads. A source may
  write those only on an entity it owns; a git source and an admin always
  may. `entities.ts` asks before every write.
- A source may only write the blueprints it is registered for, and only the
  owning source (or a delete grant) can delete. Enrichers never keep an entity
  alive. Keep those checks in `entities.ts` and `runs.ts`. Ownership moves
  only when a person hands one pusher's entities to another, or to people
  (`release`), in `sources.ts`. An entity people keep is never missing:
  `release` brings back what the source had stopped seeing, and
  `restoreKept` in `runs.ts` brings back any other on the periodic pass,
  before anything is expired.
- Only a committed snapshot deletes, and only within its own source and
  scope. A failed or abandoned run deletes nothing. The one other path is a
  blueprint's own `lifecycle.expire`, which removes entities by age. Do not
  add another path that removes entities, and never one without a tombstone.
- An action never changes the estate or any system itself. The hub renders a
  payload and hands it to a backend a person named: a webhook, a GitHub
  workflow, a runner, or a starter that starts one container for the run
  (`job`), or leaves it to the one who asked (`caller`). The hub runs no
  command, and holds no credential of a cloud or a cluster: a starter the
  estate runs starts a job, and the job runs as its own identity. A run's
  own credential (`orr_run_`) is no hub token: `authenticate` lets it into
  the report and the read of its own run on the machine port and nowhere
  else, as an identity of kind `run`, so it never reaches a view. Never
  give that identity another route, and never hand a job a token of any
  other kind. A webhook carries a hub secret, or, where it names a
  delegate, the token of the person who asked and never the hub's own. An
  answer a webhook reveals (`finish: reveal`) is handed to the request that
  asked for the run and written nowhere: never put it in a row, a log, an
  event, or a notice. The one exception is the
  `record` backend: it writes one entity of the catalog, as the source the
  action names, through the same write a pusher makes, and never a value
  access is decided from. Every run is a row with a
  log, written in `actions.ts` and nowhere else, and a backend reports into it
  through the hub's own API: an access token holding `actions.report`, or the
  runner that claimed the job. Who may run an action is the action's own
  `access`, the same grants that decide who sees a blueprint, judged by
  `visibility.ts`: nobody but an admin until it says so. Its `rules` say who
  runs it on which entity, by who they are, what they own of it, and what it
  is. Its `access.home` opens it to the people who own its `home`, an entity
  of any blueprint. No permission opens an action, and only an admin sets
  its access or its home: the save in `http.ts` keeps both for anyone else. A
  run on an entity no rule takes is refused the way one on nothing is.
- A product may speak for a person (`for` on a run, `as` on a tool call) only
  as a machine access token holding `actions.ask` or `tools.lend`, on the
  machine port (`standIn` in `http.ts`). The hub then judges the person, never
  the product, and never as an admin: a stood-in identity carries no override.
  The row names the person as actor and the product in `detail.via`.
  A product may instead ask a run as itself for a person (`requestedFor`):
  then its own access is judged, the run is the product's, and the person is
  data on it alone (`requested_for`): never a decider (`undecidable`), never
  told of it (`reaches` in `notices.ts`), and never added to the hub.
- A tool is an action with a `tool` block, and its command runs with a
  runner's key. So only an admin's save, git, or a source the runner's
  `serves.sources` names may define or change one, and a runner runs a tool
  only as its `serves` says: the tier, the source, and the entity it was
  declared from. Check that at the save, at the listing, and at every call
  (`tools` and `call` in `actions.ts`). Never let `actions.manage` or a
  source's own offer widen what a runner serves.
- The tiers of a lent tool call are worked out on every call from the rows as
  they stand (`tiersLent`): the lane action's tiers if the person may still
  ask for it there, plus what a live run of theirs was granted: one they
  asked, or one the lending product asked for them while it may still ask
  for the action there. Never mint a
  token that carries tiers, and never lend a tier the person holds through
  some other action. Nobody approves a tier they do not hold (`undecidable`).
- Secrets never leave the hub on the read side. Git tokens and check secrets
  are sealed with `SECRET_KEY`; ingest tokens are stored hashed and shown
  once. A runner receives check secrets over the machine surface only.
- A push costs what moved, not what it carried. A batch is one transaction
  through `writeMany`; never write a run's entities one transaction each. An
  entity nothing changed on gets no statement of its own. A sender names an
  entity by the digest of what it last sent of it (a sighting), and the hub
  takes that without a value of it read while the entity is active, has not
  changed since, and its blueprint was not saved since (`sight` in
  `entities.ts`, the digests in `ingest_digests`); every other sighting is
  answered as `wanted`, to be sent in full. So a pusher keeps no state of its
  own to send less: anything that changes an entity's stored values moves its
  `updated_at`, or a sighting takes a digest that no longer stands.
- Anything that changes an entity or its relations emits an `entity` event or
  calls `touch` on the rules, and puts what it touched on the derive queue in
  its own transaction, both ends of a relation included. That is how the
  rules know what to re-link and the deriver what to derive; a change that
  says nothing waits for the periodic pass and the reconcile.
- That a source was seen, or a token used, is stored at most once a minute.
  Do not add a write to every request.
- Logs are JSON lines on stdout. Log both branches of any decision that
  changes what a view shows or what a run deletes.
- No continuously repainting CSS animations in the web app.
- The catalog is edited in place. A value a person may change is changed
  where it is shown, in the grid, on the entity page, and in the side panel,
  through the shared editors. Never add an edit mode, or a save button for
  one value. A value that cannot be changed says why on hover.
- A person's edit goes through `editFromUi`, so it lands in the `ui` layer or
  as an override. A view never writes a value any other way.
- A field is open unless someone locks it. A pusher's blueprints do not lock
  the fields they write: locking is the architect's choice, made in the hub.
  Lock in a pusher only what identifies the entity, such as an id. Open
  means open to a holder of `entities.edit`. To everyone else a value is
  closed until an edit rule names it: never open a field to owners by a flag
  on the field or a test of a blueprint, and never let an owner's edit
  stand over what a source says.
- The web app marks what is open, never what is closed: a pencil where an
  edit rule opens a value to a reader who may change nothing else there
  (`src/web/editable.ts` reads `editable`), and the words of what an empty
  one waits for. A reader who holds `entities.edit` sees no such mark. A
  failing mark that one value would mend opens that value
  (`components/FixValue.tsx`, `src/web/fix.ts`).
- Descriptions on blueprints and fields are first-class. When writing a
  blueprint, for the hub or for a pusher, write the description for a person
  and an agent.
- `package.json` is the version of record. Go binaries take their version from
  the tag through ldflags.
- What an image is built from is said once each: the `go` line in `go.mod` is
  the Go that compiles every program (the release installs exactly that
  version, so keep it a current patch release), `base` in `go.Dockerfile` is
  what every Go image starts from, and `NODE` in `Dockerfile` is the hub's
  Node. An image scanner's finding is fixed there and in the modules
  (`go.mod`, `package.json`), never by patching a built image. Keep the
  `k8s.io` and `sigs.k8s.io` helper modules at what the `k8s.io/client-go`
  release in use asks for; `go get -u` takes them past it and the build
  breaks.

## Delivery

Agents push to `main`. Commit on `main` and land with `make land` (`make land
BRANCH=<branch>` from a worktree). It runs `make check`, then
`release-damnit land`. CI runs the same check on GitHub's hosted runners
(`test.yml`, with Postgres as a service), then versions every `feat` and
`fix` since the last release tag, tags it, and builds and signs the tag's
images, plugin, and command line under `ghcr.io/orchard-suite`.
Never edit the version in `package.json`, `package-lock.json`, the manifest, or
`CHANGELOG.md` by hand.

## Checks

```bash
make check      # typecheck, tests, web build, go vet, go test, the API judge
```

The server tests need a Postgres at `DATABASE_URL` (defaults to
`postgres://orrery:orrery@localhost:5433/orrery`). `make check` starts the
`orrery-pg` container on that port when it is not running. It also judges
`openapi.json` against the latest tag with
[Trellis](https://github.com/orchard-suite/trellis), in Docker, and fails on
a breaking change. In CI the workflow's Postgres service stands in for the
container.

`bench/scale.ts` pushes, links, and reads an estate of 38,515 entities
(`BENCH_SCALE` multiplies it) through the API and prints the time of each
step. It uses its own database, `orrery_bench`. `.climb/scale.json` climbs it.

Run it before every commit. Its estate is made up from the test catalog: it
catches a change that costs more than before, and it is no measure of how
fast the hub is for the people who use it.

`bench/copy.ts` is that measure. It reads a copy of the database of a hub in use,
restored locally into `BENCH_COPY` (`orrery_copy`) and stamped
`taken <ISO time>` in its comment, the way that hub's people use it: the
grids that cost the hub most in its last week, cold, as an admin and as its
busiest person who is not one, then search, the summary, the posture, the
ground view cold (every ground's cover beside the map index, as an admin and
as that person, then the largest map), the entity most pointed at derived
again alone, and every entity derived again. It clones the copy to `orrery_copy_bench` each
run and starts the hub without its jobs, so nothing in the copy reaches out.
It names a grid by its rank, never by its blueprint, and prints the copy's
age. `.climb/floor.json` climbs it. A speed target is judged on it, never on
`bench/scale.ts`. Which hub is copied, how, and when is not this
repository's: no copy, dump, or setting for one enters it.

`bench/posture.ts` reads the security posture of an estate the size of a
mid-sized organisation's (some two hundred people, two and a half thousand
items, actions opened to owners) and fails when a read takes over two
seconds or a warm read sends over 40 statements. Run it when you change what
the posture, the gate, or what a person owns reads. It uses
`orrery_bench_posture`.

`bench/fleet.ts` runs hubs as separate processes on one database
(`FLEET_API` serving, `FLEET_WORKERS` deriving), pushes the same estate
through the serving hubs in turn, and fails unless every hub answers the
same, an edit through one shows through the others, and a budget set on
one is held by all. Run it when you change what hubs share: the queue, the
bridge, a kept answer, a migration. It uses `orrery_fleet`, a database that
is new each run, so it also shows a statement that is planned badly while
the tables are not yet measured.
