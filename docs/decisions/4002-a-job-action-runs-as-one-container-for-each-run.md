# ADR-4002: A job action runs as one container for each run

| | |
|---|---|
| **Decision Date** | 2026-11-21 |
| **Decision Maker** | Orrery maintainers |
| **Last Updated** | 2026-11-21 |

## Status

Accepted

## Audience

Anyone who changes how a run is handed to its backend, adds a backend or a
platform a job runs on, or builds a tool whose work is long or waits for
approval.

## Purpose

Settles where long work, and work that waits for a person, runs: as one
container for each run, started by the actions engine through a starter
the estate runs, so the thing that asked never holds the work.

## Context

The `caller` backend leaves the work to whoever asked. A tool that asks
for an approval must then also come back and do the work. On one hub, of
193 runs of one such action in two weeks, 21 of the 169 that were decided
waited over an hour for approval, 4 approved runs were cancelled because
nobody started them within the hub's hour, and 2 running runs were given up
with no result. The asker is often an agent's shell, which lives two hours
at most, so nothing is awake to start a run approved overnight.

The `runner` backend does hold the work, but as a command inside a shared
runner process: it dies with that process, is capped by the hub's time,
and runs with everything the runner holds.

The rule under the decision: **work that waits for a person is never held
by the thing that asked.**

## Decision

A new backend, `job`, runs each run as one container on a platform the
estate runs. Three parts, each with one job:

- **The hub** holds the run, the approval, and the log, as for every
  backend. It holds no cloud or cluster credential, and starts and stops
  nothing itself.
- **A starter** the estate runs signs in to the hub as a runner source and
  connects out. It claims a run the moment it is approved, or asked for
  when it needs no approval, and starts one job for it. It holds one right
  on its platform: start a job, see it, and stop it. It keeps no state: a
  job carries its run's id, and the hub answers which runs the starter
  claimed, so a starter that restarts carries on from the two.
- **The job** runs as its own identity, a workload identity the estate's
  template gives it. No shared runner holds that power, and the starter
  holds none of it.

Two platforms from the first release, behind one interface (`Platform` in
`cmd/job-starter`): a Kubernetes Job made from a manifest the estate owns,
in a namespace the estate names, and an execution of an existing Azure
Container Apps job, with the run's image, command, and environment on the
job's own template.

The estate bounds what an action may ask for, in the starter's own config:
which templates exist, where each runs and as what, and which images each
may run. An action names a template and an image and nothing more. A
caller's input alone never picks a namespace, an identity, or an image the
template does not allow.

A template carries the identity its jobs run as, and an estate has one
identity for each project or zone. So one action may serve many templates:
its `template` is a fixed name, or a name the entity the run is on gives,
as `infra-apply-{{ entity.fields.infra_principal }}`. The rule that keeps
this safe: **nobody who may run the action chooses what its job runs as.**
The estate's model decides, through the entity the run is on and a field no
caller writes. Three things hold it:

- The template reads only fields of the entity the run is on. Inputs, who
  asks, the entity's key, title, and relations, and the run are refused
  when the action is saved.
- Each field it reads is locked: a stored `string` or `enum` of one value
  that says `overridable: false`, so only sources write it and nobody
  changes it by hand, an admin included. A field the hub works out is
  refused, since it is decided by every value it reads.
- The hub holds each such field as a value access is decided from. So only
  the source that owns the entity, or a catalog file in git, writes it:
  never another source, an edit rule, a `record` backend, or a run's
  `refreshes`. A lock alone would leave those open.

The hub works the name out from its own read of the entity, when the run
is asked for and again as its starter claims it, and checks the lock each
time. The starter is unchanged: it is handed a name, and each of its
templates still bounds its own namespace, identity, and images.

The job is handed a credential made for its one run (`orr_run_`). It opens
the report and the read of that run, and no other call. The hub keeps its
hash, and it ends with the run. It is never a hub token.

The end of a job's run is read from how its container ended, by the
starter. The job says what it does (steps, lines, outputs, its summary) and
never how it ended. A run whose job is gone ends `unknown`, said by its
starter alone, with the reason in its log. A run is stopped by ending it
`cancelled`; the starter stops its job. A job's run may take 7 days unless
its action names another `ceiling`.

`caller` stays, for a tool that truly must run where it was asked.

## What this means for the code

- A backend that holds work outside the asker is claimed and reported on
  through the hub's own protocol: `claimJobs`, `heldBy`, and the runner's
  report in `actions.ts`. A new platform is a `Platform` in
  `cmd/job-starter`, never a new backend type or a credential in the hub.
- The run's credential is let in by `authenticate` to two routes of its own
  run, as an identity of kind `run`. It is never given another route, and
  no other kind of token is ever handed to a job.
- Nothing the starter must know may live only in its memory. What it holds
  is what the hub says it claimed and what the platform shows.
- What a job runs as is never read from anything a caller or a run can set.
  `templateIssues` in `src/shared/action-spec.ts` is the check on a
  definition, `jobTemplate` the one working out of a name, and `templateOf`
  in `actions.ts` the one place the hub reads the entity for it. A field a
  template reads is among `accessNames`, in both of its scopes. A new thing
  a template may read needs the same three: a check on the definition, a
  lock no person writes past, and a place among what access is decided
  from.
- The starter ships as a bare image, `orrery-job-starter`: the starter and
  nothing else. A job never runs in it.

## Verification

`src/server/job-runs.test.ts` holds a run that waits for approval and is
claimed the moment it is approved, the credential reporting on and reading
its own run and refused on nine other calls and on the session port, a job
refused a `state`, a run stopped while its job runs, a job gone, a run the
hub gave up settled by its starter later, the ceiling, a retry as a new job
with a new credential, a concurrency of one, and an agent told it need not
stay. `cmd/job-starter` holds the starter's decisions over a fake hub and
platform (alive, ended, gone, cancelled, past its ceiling, never started, a
platform that cannot be read, a restart), the Job built from an estate's
manifest and its credential kept out of the Job, and the Container Apps
execution started and found again by the run it carries.

For a template the entity names, `src/shared/action-spec.test.ts` holds
the definitions refused (inputs, who asks, the key, a relation, a field
that is not locked, one the hub works out, one that is no single name, an
enum value no template is named by, no blueprint, the action's own
`refreshes`) and the name worked out or refused without saying the value.
`src/server/job-runs.test.ts` holds one action on two entities starting
from two templates, for a person who may not read the field; the field
refused to a holder of `access.values`, an admin, a source that does not
own the entity, a `record` backend, and a `refreshes`, and taken from the
source that owns the entity; the save refused while another action writes
the field; a run refused on an entity that names no template, alone and in
a batch; and a run approved after its entity moved, lost its value, or had
its field unlocked.

## Consequences

A tool asks for a run and stops. A run approved overnight starts by itself.
Each family of jobs needs an image and a template of its own, and each
platform a starter, to build, sign, and keep current. An estate with one
identity for each project or zone writes one action, not one for each, and
adds a template to its starter for each identity. What its jobs run as is
then as true as the source that owns each entity: a source that may create
an entity of the blueprint says what that entity runs as. On Azure Container
Apps a run's credential is an environment value of its execution, readable
by whoever may read the job's executions: an execution can be handed
nothing else. A starter that is down for longer than the hub's time lets
its runs end `unknown` until it is back and reports their true end.

It builds to these rules of the platform standard, version 2026.1120.2003:

- `extend-the-existing-actions-engine-every-run-goes-to-the-led`: the job
  is a backend of the one actions engine, and every run is in its ledger.
- `ship-the-job-runner-as-a-bare-image-and-give-each-family-of-`: the
  starter is a bare image, and each family of jobs has its own.
- `self-service-cloud-operations-run-as-a-narrow-machine-identi`: a job
  runs as a machine identity built for it, never as the person asking, and
  the starter's role is start, read, and stop. Each tier or zone keeps an
  identity of its own, as a template of its own. The rule's last point,
  that what an action is pointed at comes from a field only its source
  writes, locked against hand edits, is what a template the entity names
  is held to, and the hub refuses a definition that does not meet it.
- `workload-identity-instead-of-cloud-keys`: the job and the starter sign
  in as workload identities; no key or secret of a cloud exists.
- `devices-report-to-the-house-nothing-commands-them`: the starter connects
  out and asks; the hub sends it nothing and holds no way into a platform.
- `give-a-sandboxed-agent-a-handle-on-one-request-never-a-hub-c`: the job
  holds a handle on one run, never a hub credential.

It departs from one rule, by the owner's ruling of 2026-11-21:

- `size-the-runner-fleet-by-keys-program-tier-and-power` says one runner
  holds one key, and sizes the fleet by keys. A starter holds no cloud key
  at all: each job holds its own, as its own workload identity. So the
  fleet of starters is sized by platform and trust boundary, and a key is a
  template, not a runner. Actions are not sized by keys either: one action
  serves every key of its kind, and the entity the run is on names which.

Four things here are new to the standard: a job for each run as a backend
of the actions engine; a run that lives by being heard from (ADR-5010); the
rule that work that waits for a person is never held by the thing that
asked; and the rule that nobody who may run an action chooses what its job
runs as, which the entity's own locked field says.

## Related

[ADR-5010](5010-a-run-lives-by-being-heard-from.md). `docs/actions.md`,
One container for each run, and One action for many identities under it.
