// Self-service actions: a form a person fills, and a backend that does the
// work. The hub never runs a command. It validates the inputs, renders the
// backend's payload over the run's scope, hands it over, and keeps the run
// as a row with a log that the backend reports into. An action and a run are
// written here and nowhere else.

import { createHash, randomBytes } from 'node:crypto'
import { z } from 'zod'
import type { GridClause, ActionReport, ActionTargetsResponse, RunActionRequest, RunnerJob, ServerEvent, StarterJob, StarterRun, ToolCaller, ToolCallRequest, ToolSummary } from '../shared/api.ts'
import { checkAction, jobTemplate, narrowedBy, narrowValue, templateReads, unbatchable, type ActionSpec } from '../shared/action-spec.ts'
import { isAsked, workedOut } from '../shared/asked.ts'
import { changeInput, countError, INPUT_KINDS, inputEmpty, listOf, twiceIn, withoutAttached } from '../shared/input-kinds.ts'
import type { ChangeGrant, ChangeReason, ChangeRouting, ChangeStatement } from '../shared/change.ts'
import { changes, editsList, heldList, runChanges } from '../shared/list-change.ts'
import { ACTION_ICON, JOB_CEILING, RESERVED_PREFIX, SCHEDULE_BLUEPRINT, namesSelf, TOOL_TIERS, actionTargets, can, entityId, isFinished, narrowingInputs, parseDuration, retryWait, type BatchWidth, parseEntityId, entityIdFor, inputPicks, type Action, type ActionBackend, type Home, type ActionInputDef, type ActionRun, type ActionRunState, type HeldFor, type AccessGrant, type Approval, type ApprovalPart, type RouteAsks, owedOf, owedWords, type ActionOrigin, type ActionStats, type ActionRule, type ActionTool, type ActionView, type Entity, type EntityRef, type Filter, type Identity, type InputUnique, type Outcome, type Source, type ToolTier, type WroteBack } from '../shared/model.ts'
import { OUTPUTS_MAX, isImageOutput, readLines, type OutputValue, type RunLine, type RunStep } from '../shared/run-marks.ts'
import { pathsOf, render, scopeEntity, type Scope } from '../shared/template.ts'
import { record } from './activity.ts'
import { checkOf, decidedEvent, digestOf, endedEvent, outcomeOf, routedEvent, routingOf, statedEvent, type JudgedRoute } from './change-events.ts'
import type { ChangeJudgeClient } from './judge.ts'
import { recordActionRun, type RunnerReading } from './metrics.ts'
import { approvalOf } from './approvals.ts'
import type { Blueprints } from './blueprints.ts'
import { BehalfError, askingFor, needsOwnSignIn, type Behalf } from './behalf.ts'
import type { Checks } from './checks.ts'
import type { Db, Queryable } from './db.ts'
import type { Entities } from './entities.ts'
import type { Events } from './events.ts'
import type { Logger } from './log.ts'
import { fetchPatient, fetchTimed } from './metrics.ts'
import { ALL } from './query.ts'
import type { Reader } from './read.ts'
import type { ActionGate, Owned, View } from './visibility.ts'
import type { ReportDone, RunPen } from './reports.ts'
import type { ReportVerb } from '../shared/report.ts'
import type { Sources } from './sources.ts'
import { stable } from './values.ts'
import { heldBack, writeBack } from './write-back.ts'
import { FilterError, forAsker, matches, namesAsker, usesIncoming, type Asker } from '../shared/filter.ts'

// What the hub reads back from GitHub about a workflow run it started.
const dispatched = z.object({ workflow_run_id: z.number(), run_url: z.string().url(), html_url: z.string().url() })
const workflowRun = z.object({ status: z.string(), conclusion: z.string().nullable() })
const workflowJobs = z.object({ jobs: z.array(z.object({ name: z.string(), conclusion: z.string().nullable(), check_run_url: z.string().url() })) })
const annotations = z.array(z.object({ annotation_level: z.string(), message: z.string() }))

/** At most this many reasons from GitHub go into a run's log. */
const REASONS = 5

/** How long an action usually takes is read from this many of its newest runs that worked, once this many of them were timed. */
const TIMED_RUNS = 20
const TIMED_ENOUGH = 3
/** What each run of a batch costs is the mean of this many of the action's newest runs that ended, failed ones too: few enough to follow a change. */
export const MEAN_RUNS = 50
const NO_STATS: ActionStats = { usualSeconds: null, meanSeconds: null, failedInARow: 0 }

/** The most spellings of one text, differing only in case, read to find who holds it. */
const SAME_TEXT_MAX = 50
/** The most of a revealed answer the hub hands back. */
const TOLD_MAX = 4000

export class ActionError extends Error {
  readonly status: 400 | 403 | 404 | 409
  /** The input the error is about, when it is about one. */
  readonly input?: string

  constructor(message: string, status: 400 | 403 | 404 | 409 = 400, input?: string) {
    super(message)
    this.status = status
    if (input !== undefined) this.input = input
  }
}

/**
 * An entity a person may run an action on, and whether a run there waits for
 * approval: `false` runs at once, `'self'` waits for the person to approve it
 * themselves, `true` waits for someone else.
 */
export interface Target {
  approval: boolean | 'self'
}

/** What one page of the target picker asks for: one entity by id, the targets that hold a text, and how many at most. */
export interface TargetPage {
  of?: string
  search?: string
  limit: number
}

/** Every filter given, as one; none when none is. */
function allOf(parts: (Filter | undefined)[]): Filter | undefined {
  const given = parts.filter((p): p is Filter => !!p)
  return given.length > 1 ? { and: given } : given[0]
}

/** Whether a value's templates read who asks (`by`): what the hub fills in from that is its own word about the caller. */
function readsAsker(value: unknown): boolean {
  return pathsOf(value).some((p) => p === 'by' || p.startsWith('by.'))
}

/** Whether an action's runs write this field or relation of a blueprint: a `record` backend's own write, or what a run hands back to `refreshes`. */
function writes(action: Action, blueprint: string, name: string): boolean {
  const backend = action.backend
  if (backend.type === 'record' && backend.blueprint === blueprint && (name in (backend.fields ?? {}) || name in (backend.relations ?? {}))) return true
  return !!action.refreshes?.includes(name) && actionTargets(action).includes(blueprint)
}

/** Whether an action's job is started from a template its entity names, so the entity is read for it. */
function readsEntity(action: Action): boolean {
  return action.backend.type === 'job' && templateReads(action.backend.template).length > 0
}

/** A filter nothing meets. */
const NOTHING: Filter = { or: [] }

/**
 * An action's filters as one caller reads them. `where` is the action's own
 * filter on one blueprint it runs on, `@me` and the day names filled in for
 * the caller, narrowed to their own person entity for a `self` action; `rule`
 * is a rule's `where`, filled in the same way.
 */
export interface ActionFilters {
  where(blueprint: string): Filter | undefined
  rule(rule: ActionRule): Filter | undefined
  /** The caller's own person entity, as `blueprint:key`, when a filter, `self`, or a rule's `self` role asked for it and the catalog holds one. */
  own: string | null
}

/** The filter an answered input that narrows the target asks the database: the entity it points at, or the value its field holds. Null when the value is not one the database compares as the form does. */
function narrowFilter(def: ActionInputDef, value: unknown): Filter | null {
  if (INPUT_KINDS[def.type].picks === 'entity') return typeof value === 'string' ? { relation: def.narrows!, target: value } : null
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? { field: def.narrows!, op: 'eq', value } : null
}

/** How strict an approval is, least first: of two rules that let a person in, the least strict stands. */
const STRICT = new Map<Target['approval'], number>([[false, 0], ['self', 1], [true, 2]])

/** The most a tool's output holds on its run: what it prints past this is dropped, and the run says so. */
const TOOL_OUTPUT_MAX = 256 * 1024
/** The most of a tool's output one call answers with. The rest is read from the run. */
const TOOL_TEXT_MAX = 64 * 1024
/** The line a runner's claim writes, which a tool's own output follows. */
const CLAIMED = 'claimed by runner '
/** The line that says a tool's output was cut. */
const CUT = 'output cut: the tool printed more than its run holds'
/** How long past its own timeout a runner's job may stay running before the hub gives it up: the time its runner has to kill it and say so. */
const RUNNER_GRACE_MS = 2 * 60_000
/** A runner's timeout when its action names none. */
const RUNNER_TIMEOUT = '10m'
/** How long past its ceiling a job's run may stay running before the hub gives it up: the time its starter has to stop the job and say so. */
const JOB_GRACE_MS = 5 * 60_000
/** A report that says nothing but that its run is alive is stored at most this often. */
const HEARD_EVERY_MS = 60_000
/** What a run's own credential starts with, so the door tells it from every token the hub gives a person, a machine, or a source. */
export const RUN_TOKEN_PREFIX = 'orr_run_'
/** The most runs a starter names in one ask of how its runs stand. */
export const STARTER_SEEN_MAX = 1000
/** How long the hub waits for a webhook's answer when its action names no `timeout`: room for slow directory, cloud, or provisioning work. */
export const WEBHOOK_TIMEOUT = '15m'
/** How long the hub waits for GitHub to take a workflow's dispatch. */
const GITHUB_WAIT_MS = 30_000
/** How long a revealed answer is waited for: the person's own request holds it, and what stands in front of the hub cuts a request held longer. */
const REVEAL_WAIT_MS = 30_000
/** How long whatever hands a run on waits for its backend's answer before the call carries on behind it, so a batch hands its calls out one after another and nobody's request is held. */
export const HOLD_MS = 2_000
/** The longest the door holds a tool call open for its run to end. */
export const TOOL_WAIT_MS = 120_000
/** The most jobs one claim hands a runner. */
export const CLAIM_MAX = 50
/** The SQL of each run column a query of runs filters on. */
const RUN_SQL: Record<string, string> = {
  'run:by': 'actor',
  'run:state': 'state',
  'run:batch': 'batch',
  'run:schedule': 'schedule',
  'run:summary': 'summary',
  'run:decidedBy': 'decided_by',
  'run:entity': 'key',
  'run:createdAt': 'created_at',
  'run:startedAt': 'started_at',
  'run:finishedAt': 'finished_at',
  'run:attempt': 'attempt',
  'run:seconds': 'extract(epoch FROM finished_at - started_at)',
}
const RUN_TIMES = new Set(['run:createdAt', 'run:startedAt', 'run:finishedAt'])
const RUN_NUMBERS = new Set(['run:attempt', 'run:seconds'])

/** Text matched as itself inside an ILIKE pattern: its own percent, underscore, and backslash escaped. */
function likeText(text: string): string {
  return text.replace(/[%_\\]/g, (m) => `\\${m}`)
}

/** How many rows one statement of a retention pass lets go. */
const PRUNE_CHUNK = 5000
/** The widest a runner may say it is. */
export const RUNNER_WIDTH_MAX = 1000

/** Whose request a lent tool call works, as the hub read it: the person's identity and view, and what the caller named. */
export interface Lent {
  person: Identity
  view: View
  as: ToolCaller
  /** The product that lends the call: a run it asked for the person carries its tiers to them. */
  lender: Identity
}

/** The blueprint an activity row about an action names: the first it runs on, or none. */
function firstTarget(a: Pick<Action, 'blueprint'>): { blueprint: string } | null {
  const first = actionTargets(a)[0]
  return first ? { blueprint: first } : null
}

interface RunRow {
  id: string
  action: string
  blueprint: string | null
  key: string | null
  inputs: Record<string, unknown>
  actor: string
  state: ActionRunState
  label: string | null
  link: string | null
  summary: string | null
  log: RunLine[]
  steps: RunStep[]
  outputs: Record<string, OutputValue>
  claimed_by: string | null
  decided_by: string | null
  decided_at: Date | null
  created_at: Date
  started_at: Date | null
  finished_at: Date | null
  /** When the hub last heard from it while it ran; null until it does. */
  heard_at: Date | null
  /** The GitHub API address of the workflow run a `github_workflow` dispatch started, while the hub watches it. */
  watch_url: string | null
  tiers: ToolTier[] | null
  revises: string | null
  note: string | null
  approvals_needed: number
  approved_by: Approval[]
  held_for: HeldFor | null
  approvers: AccessGrant[] | null
  requested_for: string | null
  agent: string | null
  by_address: string | null
  current: Record<string, unknown[]> | null
  batch: string | null
  change_set: string | null
  set_index: number | null
  attempt: number
  final: boolean
  retry_at: Date | null
  schedule: string | null
  images: string[] | null
  refresh: Record<string, unknown> | null
  wrote_back: WroteBack[] | null
  /** The digest of the change statement the run carries; null for a run whose action has no change input. */
  statement_digest: string | null
  /** When its change.ended event was written: once, whatever ends the run. */
  change_ended_at: Date | null
  /** Its change's route, as its change.routed event says it; null for a run that states no change. */
  routed: ChangeRouting | null
  /** What its route asks beside the action's own approval; null when it asks nothing more. */
  route_asks: RouteAsks | null
}

/** What a change to a run replaces on its row. */
type RunPatch = Partial<Pick<RunRow, 'state' | 'label' | 'link' | 'summary' | 'claimed_by' | 'decided_by' | 'watch_url' | 'note'>> & { startedAt?: Date; finishedAt?: Date; decidedAt?: Date; heardAt?: Date }

/** A failed try's next one: when it is due, its number, how long it waits, and the log line that says so, given why the try failed. */
interface NextTry {
  at: Date
  attempt: number
  waitMs: number
  line: (why: string | null) => string
}

/**
 * Who is reporting on a run: a runner source, which may only report the job it claimed (a starter is one, for the job
 * runs it claimed); a person or access token; or a job run's own container, with the credential made for that run,
 * which says what it does and never how it ended.
 */
export type Reporter = { kind: 'runner'; source: string } | { kind: 'caller'; name: string } | { kind: 'job'; run: string }

/** What a run asks of the hub's reports, each judged as the person's own change would be (`reports.ts`). */
export interface ReportControl {
  check(verb: ReportVerb, inputs: Record<string, unknown>, who: Identity, entity: Entity | null): Promise<{ input: string; message: string } | null>
  change(verb: Exclude<ReportVerb, 'publish' | 'preview'>, run: ActionRun, who: Identity): Promise<ReportDone>
  publish(run: ActionRun, preview: boolean, who: Identity, pen: RunPen): Promise<ReportDone>
}

/** What a run asks of the hub's schedules, each judged as the person's own change would be. */
export interface ScheduleControl {
  decide(id: string, approve: boolean, identity: Identity, note?: string): Promise<unknown>
  pause(id: string, paused: boolean, identity: Identity): Promise<unknown>
  runNow(id: string, identity: Identity): Promise<unknown>
}

export interface ActionsDeps {
  db: Db
  /** The person behind a sign-in address as the hub judges them now, with every permission they hold; null when they no longer sign in. */
  identityFor: (email: string) => Identity | null
  blueprints: Blueprints
  reader: Reader
  sources: Sources
  checks: Checks
  events: Events
  log: Logger
  /** Where a run can be watched: the hub's public address. */
  publicUrl: string
  /** The GitHub REST API a `github_workflow` backend calls. */
  githubApi: string
  /** Calls another API as the person who asked, for a webhook that names a delegate. */
  behalf: Behalf
  /** How long a run under way may go unheard from before the hub gives up on it. */
  timeoutMinutes: number
  /** The blueprint the estate says a person is, which a person input picks from. */
  person: () => string | null
  /** What the person who asked for a run may see. A run carries only that, however late it is sent. */
  viewOf: (requester: string) => Promise<View>
  /** Whether an identity may run an action: an admin, everyone when the action says so, or whoever its grants or a rule let in. */
  mayRun: (identity: Identity, action: Action) => Promise<boolean>
  /** Whether grants let a person in, judged on their own person entity as every rule's are. */
  grantsLetIn: (address: string, grants: AccessGrant[]) => Promise<boolean>
  /** How an identity may run an action: on everything it runs on, or by the rules that let them in. */
  gate: (identity: Identity, action: Action) => Promise<ActionGate>
  /** What a person owns, with how. */
  owned: (who: string) => Promise<Owned>
  /** Who asks, as a filter names them: their address, their own person entity whether or not they may see it, and the day names on their clock. */
  asker: (identity: Pick<Identity, 'kind' | 'name'>) => Promise<Asker>
  /** Where a `record` backend writes. */
  entities: Entities
  /** Why a `record` backend may not write these names on this blueprint, whoever owns the entity: access is decided from them. Null when it may. */
  decides: (blueprint: string, names: string[]) => string | null
  /** The ids of the actions a person pinned, or null for a machine, which pins nothing. */
  pinned: (identity: Identity) => Promise<ReadonlySet<string> | null>
  /** Everyone who signs in, as the rules alone judge them: with no admin override and no permission to approve. */
  people: () => Identity[]
  /** Everyone who could press Approve, as the hub judges each now: each person who signs in and each access token, an admin and a holder of `actions.approve` as they are. */
  deciding: () => Promise<Identity[]>
  /** What an identity may see. */
  seenBy: (identity: Identity) => Promise<View>
  /** The estate's judge, asked the route of each run of an action that opts in to it (`judge: true`). */
  judge: ChangeJudgeClient
  /** Whether a person decides a run their own agent asked for, as someone who did not ask (`AGENT_PERSON_DECIDES`, ORY-2002). */
  agentPersonDecides?: boolean
  /** The hub's own version, which names it as the judge of a change it routes itself. */
  version: string
}

/** What judging who may decide a run reads of it: a run that waits, or one about to. */
/** A run as it was judged on being asked, before anything is written: see `judge`. */
export interface JudgedRun {
  action: Action
  entity: Entity | null
  inputs: Record<string, unknown>
  kept: Record<string, unknown[]>
  listed: string[]
  differs: { input: string; filled: unknown; sent: unknown }[]
  waits: boolean
  selfHeld: boolean
  /** How many yeses the action's own approval asks: none for a run only its route holds. */
  needed: number
  /** How the judge routed it, for a run of an action that opts in to the judge and states a change; null otherwise. */
  judged: JudgedRoute | null
  tiers: ToolTier[]
  requestedFor: string | null
  approvers: AccessGrant[] | null
  revisedRun: ActionRun | null
  runId: string
  requestedAt: Date
  scope: Scope
}
type Judged = JudgedRun

/** What decides the hub's change sets, as the person who ran a `decide` action on a record of one. */
export interface SetControl {
  decide(id: string, approve: boolean, who: Identity, view: View, note?: string): Promise<void>
}

/** Where an activity row is written: the pool, or the transaction the change it records is made in. */
type Recorder = Parameters<typeof record>[0]

/** A change statement a run is asked with: the statement, its digest, and its route as its change.routed event says it. */
interface Stated {
  statement: ChangeStatement
  digest: string
  routing: ChangeRouting
}

type Waiting = Pick<ActionRun, 'id' | 'action' | 'entity' | 'by' | 'agent' | 'state' | 'approvedBy' | 'approvalsNeeded' | 'requestedFor' | 'approvers' | 'heldFor' | 'tiers' | 'changeSet' | 'routeAsks'>

/** A URL with the rendered query added to it, each value encoded. A value that rendered to nothing is left out, so an input nobody filled changes nothing. */
function withQuery(url: string, query: Record<string, unknown>): string {
  const added = new URLSearchParams()
  for (const [name, value] of Object.entries(query)) if (value !== null && value !== undefined && asText(value) !== '') added.set(name, asText(value))
  const text = added.toString()
  return text ? `${url}${url.includes('?') ? '&' : '?'}${text}` : url
}

export class Actions {
  private cache: Action[] = []

  private readonly deps: ActionsDeps

  constructor(deps: ActionsDeps) {
    this.deps = deps
  }

  // Definitions ----------------------------------------------------------------

  async load(): Promise<void> {
    const rows = await this.deps.db.query<{ id: string; spec: ActionSpec; origin: ActionOrigin; updated_at: Date }>('SELECT * FROM actions ORDER BY id')
    this.cache = rows.rows.map((r) => ({ ...r.spec, id: r.id, origin: r.origin, updatedAt: r.updated_at.toISOString() }))
  }

  list(): Action[] {
    return [...this.cache]
  }

  get(id: string): Action | undefined {
    return this.cache.find((a) => a.id === id)
  }

  require(id: string): Action {
    const a = this.get(id)
    if (!a) throw new ActionError(`Unknown action "${id}"`, 404)
    return a
  }

  /**
   * The actions as one reader gets them: those `view` lets them see that they
   * may run, and for a holder of `actions.manage` the rest too, so they can
   * edit what they cannot run. Each carries its newest run the reader may see,
   * the icon it is drawn with, and what its runs say of it.
   */
  async listFor(identity: Identity, view: View): Promise<ActionView[]> {
    const [offered, last, stats, pinned] = await Promise.all([this.offered(identity, view), this.lastRuns(view), this.stats(), this.deps.pinned(identity)])
    const homes = await this.homes(identity, view, offered.map((o) => o.action.home))
    return offered.map(({ action: a, canRun }) => ({ ...this.placed(a, view, homes), canRun, lastRun: last.get(a.id) ?? null, stats: stats.get(a.id) ?? NO_STATS, ...(pinned ? { pinned: pinned.has(a.id) } : {}) }))
  }

  /**
   * Homes as one reader sees them, by entity id, read in one batch however
   * many actions or saved queries name one. A home of a blueprint the reader
   * may not see, or one that is not there, is left out. `yours` is the
   * reader's by any ownership path, from the kept answer.
   */
  async homes(identity: Identity, view: View, ids: readonly (string | null | undefined)[]): Promise<Map<string, Home>> {
    const refs = new Map<string, EntityRef>()
    for (const id of ids) {
      const ref = id ? parseEntityId(id) : null
      if (ref && view.seesBlueprint(ref.blueprint)) refs.set(entityId(ref), ref)
    }
    const out = new Map<string, Home>()
    if (!refs.size) return out
    const [found, owned] = await Promise.all([this.deps.reader.hydrated([...refs.values()]), identity.kind === 'user' ? this.deps.owned(identity.name) : null])
    for (const e of view.entities(found)) out.set(e.id, { id: e.id, entity: { blueprint: e.blueprint, key: e.key }, title: e.title, icon: e.icon ?? null, yours: owned?.state === 'known' && owned.ids.has(e.id) })
    return out
  }

  /**
   * An action with where it belongs, as one reader gets it: its home as they
   * see it, and the icon it is drawn with. The home its definition names is
   * left out for a reader who may not see the home's blueprint.
   */
  private placed(a: Action, view: View, homes: Map<string, Home>): Action & Pick<ActionView, 'iconShown' | 'homeShown'> {
    const ref = a.home ? parseEntityId(a.home) : null
    const homeShown = (a.home && homes.get(a.home)) || null
    const { home: _home, ...rest } = a
    const named = ref && !view.seesBlueprint(ref.blueprint) ? rest : a
    return { ...named, iconShown: this.iconShown(a, homeShown), homeShown }
  }

  /** The actions one reader is offered, each with whether they may run it. It reads no run: a list and a person's pins both start here. */
  async offered(identity: Identity, view: View): Promise<{ action: Action; canRun: boolean }[]> {
    const out: { action: Action; canRun: boolean }[] = []
    for (const a of this.cache) {
      if (!view.seesAction(a)) continue
      // An action with no form is run by its tool alone, and a tool is called through the door: nobody gets a button for either.
      const canRun = a.form !== false && !a.tool && (await this.deps.mayRun(identity, a))
      if (canRun || can(identity, 'actions.manage')) out.push({ action: a, canRun })
    }
    return out
  }

  /**
   * The icon an action is drawn with, the first of these it has: its own,
   * then its home's as the reader sees it, then that of the one blueprint it
   * runs on, then the plain one. An action is only ever shown to a reader
   * who sees every blueprint it runs on.
   */
  iconShown(a: Action, home: Pick<Home, 'icon'> | null = null): string {
    const targets = actionTargets(a)
    const borrowed = targets.length === 1 ? this.deps.blueprints.get(targets[0]!)?.icon : undefined
    return a.icon ?? home?.icon ?? borrowed ?? ACTION_ICON
  }

  /**
   * What each action's runs say of it, in one statement over them all: the
   * median time its newest twenty runs that worked took, once three of them
   * were timed, and how many of its newest runs that ended in success or
   * failure failed before one worked. `only` asks for one action. It counts
   * every run, whoever asked and whatever it ran on, and names none.
   */
  async stats(only?: string): Promise<Map<string, ActionStats>> {
    const rows = await this.deps.db.query<{ action: string; usual: number | null; timed: number; mean: number | null; ended: number; failed: number }>(
      `SELECT action,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY took) FILTER (WHERE timed) AS usual,
              (count(*) FILTER (WHERE timed))::int AS timed,
              avg(took) FILTER (WHERE ended) AS mean,
              (count(*) FILTER (WHERE ended))::int AS ended,
              coalesce(min(n) FILTER (WHERE state = 'succeeded') - 1, count(*))::int AS failed
       FROM (
         SELECT action, state, n, extract(epoch FROM finished_at - started_at)::float8 AS took, state = 'succeeded' AND started_at IS NOT NULL AND of_state <= ${TIMED_RUNS} AS timed,
                started_at IS NOT NULL AND n <= ${MEAN_RUNS} AS ended
         FROM (
           SELECT action, state, started_at, finished_at,
                  row_number() OVER (PARTITION BY action ORDER BY finished_at DESC) AS n,
                  row_number() OVER (PARTITION BY action, state ORDER BY finished_at DESC) AS of_state
           FROM action_runs
           WHERE state IN ('succeeded', 'failed') AND finished_at IS NOT NULL AND ($1::text IS NULL OR action = $1)
         ) ranked
       ) done
       GROUP BY action`,
      [only ?? null],
    )
    return new Map(rows.rows.map((r) => [r.action, { usualSeconds: r.usual === null || r.timed < TIMED_ENOUGH ? null : Math.round(r.usual), meanSeconds: r.mean === null || r.ended < TIMED_ENOUGH ? null : r.mean, failedInARow: r.failed }]))
  }

  /**
   * When each action was last asked for and how many times in the last
   * `days` days, in one statement over every run, whoever asked and whatever
   * became of it. An action nobody ever ran has no row.
   */
  async usage(days: number): Promise<Map<string, { lastRunAt: string; recent: number }>> {
    const rows = await this.deps.db.query<{ action: string; last: Date; recent: number }>(
      `SELECT action, max(created_at) AS last, (count(*) FILTER (WHERE created_at > now() - make_interval(days => $1)))::int AS recent FROM action_runs GROUP BY action`,
      [days],
    )
    return new Map(rows.rows.map((r) => [r.action, { lastRunAt: r.last.toISOString(), recent: r.recent }]))
  }

  /** One action as a reader gets it. `canRun` is the caller's to say: a list and a page ask it differently. */
  async shown(a: Action, identity: Identity, view: View, canRun: boolean): Promise<ActionView> {
    const [last, stats, pinned, homes] = await Promise.all([this.lastRuns(view), this.stats(a.id), this.deps.pinned(identity), this.homes(identity, view, [a.home])])
    return { ...this.placed(a, view, homes), canRun, lastRun: last.get(a.id) ?? null, stats: stats.get(a.id) ?? NO_STATS, ...(pinned ? { pinned: pinned.has(a.id) } : {}) }
  }

  /**
   * An action's filters as one caller reads them (`ActionFilters`). The
   * caller is worked out only when a filter names them or the action is
   * `self`. A filter that names the caller's own entity, when the catalog
   * holds none for them, takes nothing, as `self` then does. Every read of an
   * action's `where` or a rule's goes through this, so the form, a grid row,
   * a batch, and a run agree.
   */
  async filtersFor(identity: Pick<Identity, 'kind' | 'name'>, action: Action): Promise<ActionFilters> {
    const rules = action.access?.rules ?? []
    const asks = !!action.self || rules.some(namesSelf) || [action.where, ...rules.map((r) => r.where)].some((f) => !!f && namesAsker(f))
    const who = asks ? await this.deps.asker(identity) : null
    const fill = (f: Filter | undefined): Filter | undefined => {
      if (!f || !who || !namesAsker(f)) return f
      try {
        return forAsker(f, who)
      } catch (error) {
        if (!(error instanceof FilterError)) throw error
        this.deps.log.debug('action filter names the caller\'s own entity, and the catalog holds none for them: it takes nothing', { action: action.id, by: identity.name })
        return NOTHING
      }
    }
    const where = fill(action.where)
    const filled = new Map(rules.map((r) => [r, fill(r.where)]))
    const own = who?.person ? parseEntityId(who.person) : null
    if (action.self) this.deps.log.debug(own ? 'self action: it runs on the caller\'s own person alone' : 'self action: the catalog holds no person for the caller, so it runs on nothing', { action: action.id, by: identity.name, person: who?.person ?? null })
    return {
      own: who?.person ?? null,
      where: (blueprint) => (action.self ? allOf([where, own?.blueprint === blueprint ? { field: '$key', op: 'eq', value: own.key } : NOTHING]) : where),
      rule: (r) => (filled.has(r) ? filled.get(r) : fill(r.where)),
    }
  }

  /**
   * The entities one identity may run an action on, by id, each with whether
   * a run there waits for approval: everything the action's filter takes when
   * they may run it anywhere, else what each rule that lets them in takes.
   * Rules read the true values, not the reader's view of them; a blueprint
   * they may not see gives nothing. `among` asks after those entities alone,
   * and null after every one, for the target picker. Asked of the stored rows
   * each time as references and never kept, so it costs what is asked about,
   * not what the blueprint holds.
   */
  async targets(identity: Identity, view: View | undefined, action: Action, among: readonly EntityRef[] | null): Promise<Map<string, Target>> {
    const out = new Map<string, Target>()
    // A blueprint the reader sees some of, such as the entities a rule opens to them as owners, gives what of it they see.
    const kinds = actionTargets(action).filter((b) => (!view || view.seesSome(b)) && (!among || among.some((r) => r.blueprint === b)))
    if (!kinds.length) return out
    const gate = await this.deps.gate(identity, action)
    if (!gate.open && !gate.rules.length) return out
    const owned = gate.rules.some((r) => r.owns) ? await this.deps.owned(identity.name) : null
    const filters = await this.filtersFor(identity, action)
    // Their own person entity is theirs as `self`, for a rule that names it; it is theirs in no other way.
    const mine = filters.own
    for (const blueprint of kinds) {
      const keys = among ? [...new Set(among.filter((r) => r.blueprint === blueprint).map((r) => r.key))] : null
      await this.deps.reader.ensureDerived(blueprint, this.deps.reader.staleBefore(blueprint), keys ?? undefined)
      const taken = async (where?: Filter) => {
        const filter = allOf([keys ? { field: '$key', op: 'in', value: keys } : undefined, filters.where(blueprint), where])
        return (await this.deps.reader.sql.refs({ blueprint, states: ['active'], includeHidden: true, filter }, ALL)).map(entityId)
      }
      if (gate.open) {
        for (const id of await taken()) out.set(id, { approval: !!action.approval })
        continue
      }
      for (const rule of gate.rules) {
        for (const id of await taken(filters.rule(rule))) {
          if (rule.owns) {
            const roles = owned?.state === 'known' ? owned.ids.get(id) : undefined
            const self = id === mine && namesSelf(rule)
            if (!self && (!roles || (rule.owns !== true && !rule.owns.some((r) => roles.includes(r))))) continue
          }
          const approval: Target['approval'] = action.approval ? true : (rule.approval ?? false)
          const was = out.get(id)
          if (!was || STRICT.get(approval)! < STRICT.get(was.approval)!) out.set(id, { approval })
        }
      }
    }
    if (view && !view.all) for (const id of [...out.keys()]) if (!view.seesEntity(parseEntityId(id)!)) out.delete(id)
    const asked = among ? among.length : 'every entity'
    if (gate.open) this.deps.log.debug('action targets: open on everything its filter takes', { action: action.id, by: identity.name, asked, targets: out.size })
    else this.deps.log.debug('action targets: what the rules that let them in take', { action: action.id, by: identity.name, asked, rules: gate.rules.length, owned: owned?.state ?? null, targets: out.size })
    return out
  }

  /**
   * What the target picker offers: the entities one identity may run the
   * action on that every narrowing input given holds, as `view` shows them,
   * in title order, with the ids whose runs wait for approval.
   */
  async targetList(identity: Identity, view: View, action: Action, narrow: Record<string, unknown>): Promise<{ entities: Entity[]; approval: string[] }> {
    const allowed = await this.targets(identity, view, action, null)
    const filters = await this.filtersFor(identity, action)
    const given = narrowingInputs(action).filter((n) => narrow[n] !== undefined && narrow[n] !== null && narrow[n] !== '')
    const out: Entity[] = []
    for (const blueprint of actionTargets(action)) {
      if (!view.seesSome(blueprint)) continue
      const { entities } = await this.deps.reader.list({ blueprint, states: ['active'], includeHidden: true, filter: filters.where(blueprint), limit: Infinity })
      for (const e of entities) if (allowed.has(e.id) && given.every((n) => narrowedBy(e, action.inputs[n]!, narrow[n]))) out.push(e)
    }
    out.sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id))
    return { entities: view.entities(out), approval: out.filter((e) => allowed.get(e.id)!.approval !== false).map((e) => e.id) }
  }

  /**
   * One page of what the target picker offers, so it never reads or sends
   * every target: `of` asks after one entity, `search` keeps the targets that
   * hold the text, and `limit` keeps the first of them in title order. The
   * rules that let the reader in are read into the question asked of the
   * database. A rule that reads who owns a row, or what points at it, is not
   * a question the database answers, so then the whole list is worked out and
   * cut here.
   */
  async targetPage(identity: Identity, view: View, action: Action, narrow: Record<string, unknown>, page: TargetPage): Promise<ActionTargetsResponse> {
    const gate = await this.deps.gate(identity, action)
    if (!gate.open && !gate.rules.length) return { entities: [], approval: [], total: 0 }
    const of = page.of ? parseEntityId(page.of) : null
    const given = narrowingInputs(action).filter((n) => narrow[n] !== undefined && narrow[n] !== null && narrow[n] !== '')
    const narrowing = given.map((n) => narrowFilter(action.inputs[n]!, narrow[n]))
    const exact = gate.open || !gate.rules.some((r) => r.owns || (r.where && usesIncoming(r.where)))
    if (!exact || narrowing.some((f) => !f)) {
      this.deps.log.debug('action targets: a page cut from the whole list', { action: action.id, by: identity.name })
      const all = await this.targetList(identity, view, action, narrow)
      const hits = all.entities.filter((e) => (!of || e.id === entityId(of)) && (!page.search || matches(e, { search: page.search })))
      const shown = hits.slice(0, page.limit)
      const ids = new Set(shown.map((e) => e.id))
      return { entities: shown, approval: all.approval.filter((id) => ids.has(id)), total: hits.length }
    }
    const filters = await this.filtersFor(identity, action)
    const rules = gate.open || gate.rules.some((r) => !r.where) ? undefined : { or: gate.rules.map((r) => filters.rule(r)!) }
    const out: Entity[] = []
    let total = 0
    for (const blueprint of actionTargets(action)) {
      if (!view.seesSome(blueprint) || (of && of.blueprint !== blueprint)) continue
      const filter = allOf([filters.where(blueprint), rules, ...(narrowing as Filter[]), page.search ? { search: page.search } : undefined, of ? { field: '$key', op: 'eq', value: of.key } : undefined])
      const listed = await this.deps.reader.list({ blueprint, states: ['active'], includeHidden: true, filter, limit: page.limit, view })
      out.push(...listed.entities.filter((e) => given.every((n) => narrowedBy(e, action.inputs[n]!, narrow[n]))))
      total += listed.total
    }
    out.sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id))
    const shown = out.slice(0, page.limit)
    return { entities: shown, approval: await this.waiting(gate, action, shown), total }
  }

  /** Which of these targets wait for approval: the least strict of the rules whose filter takes each, asked of the stored rows as the whole list asks it. */
  private async waiting(gate: ActionGate, action: Action, shown: Entity[]): Promise<string[]> {
    if (action.approval) return shown.map((e) => e.id)
    if (gate.open || !shown.length) return []
    const levels = new Set(gate.rules.map((r) => r.approval ?? false))
    if (levels.size === 1) return levels.has(false) ? [] : shown.map((e) => e.id)
    const least = new Map<string, Target['approval']>()
    for (const blueprint of new Set(shown.map((e) => e.blueprint))) {
      const keys = shown.filter((e) => e.blueprint === blueprint).map((e) => e.key)
      for (const rule of gate.rules) {
        const { entities } = await this.deps.reader.list({ blueprint, states: ['active'], includeHidden: true, filter: allOf([{ field: '$key', op: 'in', value: keys }, rule.where]), limit: keys.length })
        const approval = rule.approval ?? false
        for (const e of entities) {
          const was = least.get(e.id)
          if (was === undefined || STRICT.get(approval)! < STRICT.get(was)!) least.set(e.id, approval)
        }
      }
    }
    return shown.filter((e) => (least.get(e.id) ?? false) !== false).map((e) => e.id)
  }

  /** Marks each entity with the actions this identity may run on it. The entities are the caller's copies. */
  async annotate(identity: Identity, view: View, entities: Entity[]): Promise<void> {
    const kinds = new Set(entities.map((e) => e.blueprint))
    const relevant = this.cache.filter((a) => !a.tool && actionTargets(a).some((b) => kinds.has(b)) && view.seesAction(a))
    const allowed = await Promise.all(relevant.map(async (a) => [a.id, await this.targets(identity, view, a, entities)] as const))
    for (const e of entities) e.actions = allowed.filter(([, t]) => t.has(e.id)).map(([id]) => id)
  }

  /**
   * The newest run of each action that `view` lets through. It reads the
   * newest run on each blueprint, so a run on a blueprint the reader may not
   * see never hides an older one they may.
   */
  async lastRuns(view: View): Promise<Map<string, NonNullable<ActionView['lastRun']>>> {
    const rows = await this.deps.db.query<RunRow>('SELECT * FROM (SELECT DISTINCT ON (action, blueprint) * FROM action_runs ORDER BY action, blueprint, created_at DESC) newest ORDER BY created_at DESC')
    const out = new Map<string, NonNullable<ActionView['lastRun']>>()
    for (const run of view.runs(rows.rows.map(toRun))) if (!out.has(run.action)) out.set(run.action, { id: run.id, state: run.state, at: run.createdAt })
    return out
  }

  /**
   * Git wins over every other writer, and an action one source put is that
   * source's: another source may not put over it. `admin` says an admin makes
   * the save: a tool's command runs with its runner's key for whoever holds
   * its tier, so one is defined or changed only by git, by a source its
   * runner names, or by an admin.
   */
  /**
   * Keeps the hub's own actions as the release defines them: each saved when
   * it is new or differs, and one the release no longer brings removed. Asked
   * once the hub's blueprints stand, since they run on them.
   */
  async ensureBuiltins(specs: readonly Record<string, unknown>[]): Promise<void> {
    for (const spec of specs) await this.save(spec, { kind: 'hub' }, true)
    const kept = new Set(specs.map((s) => String(s.id)))
    for (const a of this.list().filter((x) => x.origin.kind === 'hub' && !kept.has(x.id))) await this.remove(a.id, { kind: 'hub' })
  }

  async save(input: unknown, origin: ActionOrigin, admin = false): Promise<Action> {
    const checked = checkAction(input, this.deps.blueprints.list(), this.deps.person())
    if (!checked.spec) throw new ActionError(`Invalid action: ${checked.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
    const spec = checked.spec
    if (spec.backend.type === 'runner') {
      const runner = this.deps.sources.get(spec.backend.runner)
      if (!runner || runner.class !== 'runner') throw new ActionError(`backend.runner: "${spec.backend.runner}" is not a runner source`)
      // A tool borrows its runner's identity, so the runner's own rule says whether this one may.
      const unserved = spec.tool ? notServed(spec.tool, runner, origin) : null
      if (unserved) {
        this.deps.log.warn('tool refused: its runner does not serve it', { action: spec.id, runner: runner.id, origin: origin.kind, reason: unserved })
        throw new ActionError(`tool: ${unserved}`, 403)
      }
    }
    if (spec.backend.type === 'job') {
      const starter = this.deps.sources.get(spec.backend.starter)
      if (!starter || starter.class !== 'runner') throw new ActionError(`backend.starter: "${spec.backend.starter}" is not a runner source: a starter signs in as one`)
      // What the template reads says what the job runs as, so nothing a person may run writes it: the hub refuses such a write from here on, and says so now.
      for (const name of templateReads(spec.backend.template)) {
        for (const b of actionTargets(spec)) {
          const writer = this.cache.find((a) => a.id !== spec.id && writes(a, b, name))
          if (writer) throw new ActionError(`backend.template: it reads ${b}.${name}, which the action "${writer.id}" writes, so whoever runs that one would choose what this job runs as: a field a template reads is written by its source alone`)
        }
      }
    }
    if (spec.backend.type === 'record') {
      const writer = this.deps.sources.get(spec.backend.source)
      if (!writer || writer.class === 'git' || writer.class === 'runner') throw new ActionError(`backend.source: "${spec.backend.source}" is not a source that pushes`)
      if (!this.deps.entities.allowed(writer, spec.backend.blueprint)) throw new ActionError(`backend.source: "${writer.id}" is not registered for blueprint "${spec.backend.blueprint}"`)
      const refused = this.deps.decides(spec.backend.blueprint, [...Object.keys(spec.backend.fields ?? {}), ...Object.keys(spec.backend.relations ?? {})])
      if (refused) throw new ActionError(`backend: ${refused}`, 403)
    }
    for (const b of spec.refreshes ? actionTargets(spec) : []) {
      const refused = this.deps.decides(b, spec.refreshes!)
      if (refused) throw new ActionError(`refreshes: ${refused}`, 403)
    }
    const existing = this.get(spec.id)
    if (origin.kind !== 'hub' && (existing?.origin.kind === 'hub' || spec.id.startsWith(RESERVED_PREFIX))) {
      this.deps.log.warn('action refused: the id is one of the hub\'s own', { action: spec.id, origin: origin.kind })
      throw new ActionError(`Action "${spec.id}" is one of the hub's own: ids starting ${RESERVED_PREFIX} are kept by the hub. Define another beside it`, 409)
    }
    if (origin.kind === 'ui' && !admin && (spec.tool || existing?.tool)) {
      this.deps.log.warn('tool refused: only an admin defines one by hand', { action: spec.id, defines: !!spec.tool, changes: !!existing?.tool })
      throw new ActionError('Only an admin, git, or a source its runner names defines or changes a tool', 403)
    }
    if (existing && existing.origin.kind === 'git' && origin.kind !== 'git') throw new ActionError(`Action "${spec.id}" is defined in git (${existing.origin.file}); edit it there`, 409)
    if (existing?.origin.kind === 'source' && origin.kind === 'source' && existing.origin.source !== origin.source) throw new ActionError(`Action "${spec.id}" was put by source "${existing.origin.source}"`, 409)
    // Git saves what it holds on every pass; only a save that changed something is activity, and only it moves when the definition last changed.
    const { origin: was, updatedAt: _at, ...before } = existing ?? ({} as Partial<Action>)
    const changed = !existing || stable(before) !== stable(spec) || stable(was) !== stable(origin)
    await this.deps.db.query(`INSERT INTO actions (id, spec, origin, updated_at) VALUES ($1, $2, $3, now()) ON CONFLICT (id) DO UPDATE SET spec = EXCLUDED.spec, origin = EXCLUDED.origin, updated_at = CASE WHEN $4 THEN now() ELSE actions.updated_at END`, [spec.id, JSON.stringify(spec), JSON.stringify(origin), changed])
    await this.load()
    if (changed) {
      await record(this.deps.db, 'action.changed', firstTarget(spec), 'source' in origin ? origin.source : null, null, { action: spec.id, created: !existing, origin, backend: spec.backend.type })
      this.deps.events.emit({ type: 'actions' })
    }
    this.deps.log.info('action saved', { action: spec.id, origin: origin.kind, backend: spec.backend.type, inputs: Object.keys(spec.inputs).length })
    return this.get(spec.id)!
  }

  /** `by` is who removes it: git removes what it defined, a source only what it put, and a person anything git did not define. */
  async remove(id: string, by: ActionOrigin = { kind: 'ui' }): Promise<void> {
    const existing = this.require(id)
    if (existing.origin.kind === 'hub' && by.kind !== 'hub') throw new ActionError(`Action "${id}" is one of the hub's own, and stays`, 409)
    if (existing.origin.kind === 'git' && by.kind !== 'git') throw new ActionError(`Action "${id}" is defined in git; remove it there`, 409)
    if (by.kind === 'source' && !(existing.origin.kind === 'source' && existing.origin.source === by.source)) {
      this.deps.log.warn('action removal refused: not put by this source', { action: id, source: by.source, origin: existing.origin.kind })
      throw new ActionError(`Source "${by.source}" did not put action "${id}"`, 403)
    }
    await this.deps.db.query('DELETE FROM actions WHERE id = $1', [id])
    await this.load()
    await record(this.deps.db, 'action.changed', firstTarget(existing), 'source' in by ? by.source : null, null, { action: id, removed: true })
    this.deps.events.emit({ type: 'actions' })
    this.deps.log.info('action removed', { action: id, by: by.kind })
  }

  // Runs ---------------------------------------------------------------------------

  /** The runs that match, newest first, up to `limit`, and whether older ones match too. */
  async listRuns(q: { action?: string; state?: string; by?: string; entity?: EntityRef; limit?: number; tools?: boolean; byHand?: boolean; alone?: 'batch' | 'origin'; sets?: 'apart'; schedule?: string; from?: Date; to?: Date }): Promise<{ runs: ActionRun[]; more: boolean }> {
    const params: unknown[] = []
    const where: string[] = []
    const add = (sql: string, value: unknown) => {
      params.push(value)
      where.push(sql.replace('?', `$${params.length}`))
    }
    if (q.action) add('action = ?', q.action)
    // A tool's runs are many and small: a list names them only when asked for them, or for their action.
    else if (!q.tools) add('NOT (action = ANY(?))', this.cache.filter((a) => a.tool).map((a) => a.id))
    if (q.state) add('state = ANY(?)', q.state.split(','))
    if (q.by) add('actor = ?', q.by)
    // A list that folds batches lists the runs asked alone; each batch and each change set is one line of its own. One that folds by origin leaves out what a schedule fired too.
    if (q.alone) where.push('batch IS NULL')
    // A change set is decided and read as one: a list that keeps sets apart names none of their runs.
    if (q.alone || q.sets) where.push('change_set IS NULL')
    if (q.alone === 'origin' || q.byHand) where.push('schedule IS NULL')
    if (q.schedule) add('schedule = ?', q.schedule)
    if (q.from) add('created_at >= ?', q.from)
    if (q.to) add('created_at < ?', q.to)
    if (q.entity) {
      add('blueprint = ?', q.entity.blueprint)
      add('key = ?', q.entity.key)
    }
    const limit = Math.min(q.limit ?? 50, 500)
    // One row past the page says whether there is more.
    params.push(limit + 1)
    const rows = await this.deps.db.query<RunRow>(`SELECT * FROM action_runs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT $${params.length}`, params)
    // A list shows what each run was, not what it carries: an attachment is read on the run's own page.
    const runs = rows.rows.slice(0, limit).map(toRun).map((r) => ({ ...r, inputs: withoutAttached(this.get(r.action)?.inputs, r.inputs) }))
    return { runs, more: rows.rows.length > limit }
  }

  /**
   * The runs one reader may see. A run on an entity the view hides is never
   * among them. An admin, a machine token, and a source see the rest. A person
   * sees a run of an action they see and may run or manage, a run they asked
   * for or decided, and a run awaiting approval they may decide. A run whose
   * action is gone is shown to a person never. Each run awaiting approval says
   * whether this reader may decide it.
   */
  async runsFor(identity: Identity, view: View, list: ActionRun[]): Promise<ActionRun[]> {
    const shown = await Promise.all(view.runs(list).map(async (run) => (run.state === 'awaiting' ? { ...run, canDecide: await this.mayDecide(identity, view, run) } : run.state === 'running' && this.stoppable(run) ? { ...run, canStop: run.by === identity.name || identity.admin } : run)))
    if (view.all) return this.titled(shown, view)
    const runs = new Map<string, boolean>()
    const out: ActionRun[] = []
    for (const run of shown) {
      const action = this.get(run.action)
      if (!action || !view.seesAction(action)) continue
      if (run.by === identity.name || run.decidedBy === identity.name || run.canDecide || can(identity, 'actions.manage')) {
        out.push(run)
        continue
      }
      if (!runs.has(action.id)) runs.set(action.id, await this.deps.mayRun(identity, action))
      if (runs.get(action.id)) out.push(run)
    }
    if (out.length < list.length) this.deps.log.debug('runs hidden from a reader', { reader: identity.name, shown: out.length, hidden: list.length - out.length })
    else this.deps.log.debug('runs all shown to a reader', { reader: identity.name, shown: out.length })
    return this.titled(out.map((run) => withheldBack(run, view)), view)
  }

  /**
   * Runs, newest first, `limit` at most and older than `before` when given,
   * that the conditions match: each on a run column of `RUN_COLUMNS`, made
   * one SQL test with its value as a parameter. The action is matched by its
   * id or its title. A tool's runs are left out, as the runs list leaves them.
   */
  async runsMatching(clauses: readonly GridClause[], limit: number, before: string | null): Promise<ActionRun[]> {
    const params: unknown[] = []
    const p = (v: unknown) => (params.push(v), `$${params.length}`)
    const where: string[] = [`NOT (action = ANY(${p(this.cache.filter((a) => a.tool).map((a) => a.id))}))`]
    if (before) where.push(`created_at < ${p(new Date(before))}`)
    for (const c of clauses) where.push(this.runTest(c, p))
    const rows = await this.deps.db.query<RunRow>(`SELECT * FROM action_runs WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ${p(limit)}`, params)
    return rows.rows.map(toRun).map((r) => ({ ...r, inputs: withoutAttached(this.get(r.action)?.inputs, r.inputs) }))
  }

  /** One condition on a run column as an SQL test, its value given to `p` as a parameter. A condition turned round holds wherever the test does not, a null included. */
  private runTest(c: GridClause, p: (v: unknown) => string): string {
    return c.not ? `(${this.runTestOnce(c, p)}) IS NOT TRUE` : this.runTestOnce(c, p)
  }

  private runTestOnce(c: GridClause, p: (v: unknown) => string): string {
    if (c.field === 'run:action') {
      const v = c.value.toLowerCase()
      const hit = (a: Action) => [a.id.toLowerCase(), a.title.toLowerCase()].some((t) => (c.op === 'contains' ? t.includes(v) : c.op === 'prefix' ? t.startsWith(v) : t === v))
      const ids = this.cache.filter(hit).map((a) => a.id)
      return c.op === 'neq' ? `NOT (action = ANY(${p(ids)}))` : `action = ANY(${p(ids)})`
    }
    const col = RUN_SQL[c.field]
    if (!col) throw new ActionError(`Runs have no column "${c.field}"`)
    const time = RUN_TIMES.has(c.field)
    const value = time ? new Date(c.value) : RUN_NUMBERS.has(c.field) ? Number(c.value) : c.value
    const like = (pattern: string) => `${col}::text ILIKE ${p(pattern)}`
    switch (c.op) {
      case 'exists':
        return `${col} IS NOT NULL`
      case 'eq':
        return `${col} = ${p(value)}`
      case 'neq':
        return `${col} IS DISTINCT FROM ${p(value)}`
      case 'contains':
        return like(`%${likeText(c.value)}%`)
      case 'prefix':
        return like(`${likeText(c.value)}%`)
      case 'gt':
        return `${col} > ${p(value)}`
      case 'gte':
        return `${col} >= ${p(value)}`
      case 'lt':
        return `${col} < ${p(value)}`
      case 'lte':
        return `${col} <= ${p(value)}`
      case 'within':
      case 'older':
        if (!time) throw new ActionError(`"${c.op}" asks of a time, and "${c.field}" is none`)
        return `${col} ${c.op === 'within' ? '>=' : '<'} ${p(new Date(Date.now() - parseDuration(c.value)))}`
      default:
        throw new ActionError(`Runs are not filtered with "${c.op}"`)
    }
  }

  /**
   * Each run on an entity with that entity's title, or null when the entity is
   * gone, and the titles of the entities its inputs picked, by id. All of them
   * are read once. Only for runs a reader was already let see: whoever sees a
   * blueprint sees the titles of its entities, and a title of a blueprint
   * `view` does not see is never read for them.
   */
  private async titled(runs: ActionRun[], view: View): Promise<ActionRun[]> {
    const refs = new Map<string, EntityRef>()
    const picked = new Map<string, string[]>()
    for (const run of runs) {
      if (run.entity) refs.set(entityId(run.entity), run.entity)
      const defs = this.get(run.action)?.inputs ?? {}
      const ids: string[] = []
      for (const [name, value] of Object.entries(run.inputs)) {
        const def = defs[name]
        if (!def || INPUT_KINDS[def.type].picks !== 'entity') continue
        for (const id of Array.isArray(value) ? value : [value]) {
          const ref = typeof id === 'string' ? parseEntityId(id) : null
          if (!ref || !view.seesBlueprint(ref.blueprint)) continue
          refs.set(id as string, ref)
          ids.push(id as string)
        }
      }
      if (ids.length) picked.set(run.id, ids)
    }
    if (!refs.size) return runs
    const titles = await this.deps.reader.titlesOf([...refs.values()])
    return runs.map((run) => {
      const named = Object.fromEntries((picked.get(run.id) ?? []).flatMap((id) => (titles.has(id) ? [[id, titles.get(id)!]] : [])))
      return { ...run, ...(run.entity ? { entityTitle: titles.get(entityId(run.entity)) ?? null } : {}), ...(Object.keys(named).length ? { inputTitles: named } : {}) }
    })
  }

  async getRun(id: string): Promise<ActionRun | null> {
    const rows = await this.deps.db.query<RunRow>('SELECT * FROM action_runs WHERE id = $1', [id])
    return rows.rows[0] ? toRun(rows.rows[0]) : null
  }

  /** Every run of the change sets named, each set's in its order. */
  async runsOfSets(ids: string[]): Promise<ActionRun[]> {
    if (!ids.length) return []
    const rows = await this.deps.db.query<RunRow>('SELECT * FROM action_runs WHERE change_set = ANY($1) ORDER BY change_set, set_index', [ids])
    return rows.rows.map(toRun)
  }

  private async requireRun(id: string): Promise<ActionRun> {
    const run = await this.getRun(id)
    if (!run) throw new ActionError(`Unknown run "${id}"`, 404)
    return run
  }

  /**
   * The rounds of one ask, from any run of them: each run that `revises`
   * another is the next round of the same ask. `first` is the run the rounds
   * started from, `latest` the newest, and `ids` every round in order. Null
   * for a run that does not exist.
   */
  async roundsOf(id: string): Promise<{ first: string; latest: ActionRun; ids: string[] } | null> {
    const start = await this.getRun(id)
    if (!start) return null
    const back: string[] = []
    let at: ActionRun = start
    // A round revises one asked before it, so the walk back ends; the bound guards a row written by hand.
    for (let i = 0; at.revises && i < MAX_ROUNDS; i++) {
      const before = await this.getRun(at.revises)
      if (!before) break
      back.unshift(before.id)
      at = before
    }
    const ids = [...back, start.id]
    let latest = start
    for (let i = 0; i < MAX_ROUNDS; i++) {
      const next = await this.deps.db.query<RunRow>('SELECT * FROM action_runs WHERE revises = $1 ORDER BY created_at DESC LIMIT 1', [latest.id])
      if (!next.rows[0]) break
      latest = toRun(next.rows[0])
      ids.push(latest.id)
    }
    return { first: ids[0]!, latest, ids }
  }

  /**
   * Asks for an action to run. Every input is checked against its definition,
   * with its options rendered over the scope the way the form rendered them,
   * so a value the form could not have offered is refused. The run is written
   * and handed to the backend, unless the action waits for approval.
   */
  /**
   * `view` is what the requester may see. An entity they may not see, the one
   * the action runs on or one picked for an input, is refused as if it did
   * not exist, so no action carries its values anywhere for them.
   */
  /**
   * `how.via` says whether a form or a tool asked; `how.through` names the
   * product that asked in the person's name; `how.address` is where the
   * person called from, given only when they asked for themselves, signed in.
   */
  async request(id: string, body: RunActionRequest, identity: Identity, view?: View, how: { via?: 'form' | 'tool'; through?: string; address?: string } = {}): Promise<ActionRun> {
    const { via = 'form', through, address } = how
    const action = this.require(id)
    await this.admit(action, identity, via, through)
    return this.ask(action, body, identity, view, { through, ...(address && !through ? { address } : {}) })
  }

  /**
   * Refuses an identity an action is not asked by this way: a tool is called,
   * an action with no form is asked only by its tool, and the action's own
   * `access` must name them. Each refusal is recorded.
   */
  private async admit(action: Action, identity: Identity, via: 'form' | 'tool', through?: string): Promise<void> {
    const id = action.id
    if (action.tool) throw new ActionError(`Action "${id}" is a tool: it is called through /v1/tools/${id}/call`)
    if (action.form === false && via === 'form') {
      await record(this.deps.db, 'access.refused', firstTarget(action), null, identity.name, { action: id, reason: 'only its tool starts it' }, new Date(), 'refused')
      this.deps.log.warn('action refused: it has no form, and only its tool starts it', { action: id, by: identity.name })
      throw new ActionError(`Action "${id}" has no form: only its tool starts it`, 403)
    }
    if (!(await this.deps.mayRun(identity, action))) {
      await record(this.deps.db, 'access.refused', firstTarget(action), null, identity.name, { action: id, reason: 'the action does not name them', ...(through ? { via: through } : {}) }, new Date(), 'refused')
      this.deps.log.warn('action refused: the caller is not named by it', { action: id, by: identity.name })
      throw new ActionError(`Action "${id}" is not open to you`, 403)
    }
    this.deps.log.debug('action allowed', { action: id, by: identity.name, through: through ?? null })
  }

  /**
   * Writes the run an identity asked for, once something let them ask: an
   * action's access, or a tool's tier. `through` names the caller that asked
   * in the person's name. A tool's run never waits, and is not held to the
   * action's rules: its tier was the check.
   */
  private async ask(action: Action, body: RunActionRequest, identity: Identity, view: View | undefined, how: { through?: string; tool?: boolean; address?: string }): Promise<ActionRun> {
    const { entity, inputs, kept, listed, differs, tiers, requestedFor, approvers, revisedRun, runId, requestedAt, scope, waits, selfHeld, needed: asks, judged } = await this.judge(action, body, identity, view, how)
    const revises = revisedRun?.id ?? null
    // A run of the line not started yet that asked for exactly this, by the same person, is the answer: asking again does not ask twice.
    const unstarted = action.serial ? await this.inLine(action, entity, inputs, ['awaiting', 'queued']) : []
    const same = unstarted.find((r) => r.by === identity.name && (r.agent ?? null) === (identity.agent ?? null) && (r.requestedFor ?? null) === requestedFor && stable(r.inputs) === stable(inputs) && stable(r.tiers) === stable(tiers))
    if (same) {
      this.deps.log.info('action asked again: the run not started yet stands', { action: action.id, run: same.id, by: identity.name, state: same.state })
      return same
    }
    // A run made as its asker, started now, calls with their own token: one their browser lets lapse is a fresh sign-in away.
    if (!waits && madeAsPerson(action) && !how.through) needsOwnSignIn(identity.name, 'Running this')
    const state: ActionRunState = waits ? 'awaiting' : 'queued'
    // A rule that says self holds the run for its asker's own yes; a tier it asks for is granted only by someone who holds it, so that run waits for others.
    // Approvers a product named decide it instead, and never its asker.
    const held: HeldFor | null = !waits ? null : selfHeld && !tiers.length && !approvers ? 'self' : 'others'
    const routeAsks = judged?.asks ?? null
    const waiting: Waiting = { id: runId, action: action.id, entity: entity ? { blueprint: entity.blueprint, key: entity.key } : null, by: identity.name, agent: identity.agent ?? null, state: 'awaiting', approvedBy: [], approvalsNeeded: asks, requestedFor, approvers, heldFor: held, tiers, routeAsks }
    // What the route asks waits for the people it names, however few of them have signed in yet; the action's own approval must have someone who could give it.
    if (waits && asks > 0) {
      const decider = await this.undecided({ ...waiting, routeAsks: null }, await this.deps.deciding())
      if ('why' in decider) {
        this.deps.log.warn('action run refused: nobody could approve it', { action: action.id, by: identity.name, entity: entity?.id ?? null, reason: decider.why })
        throw new ActionError(decider.why, 409)
      }
      this.deps.log.debug('action run waits for someone who may approve it', { action: action.id, by: identity.name, entity: entity?.id ?? null, decider: decider.by })
    }
    const who = `${how.through ? `${identity.name} through ${how.through}` : identity.agent ? `${identity.agent}, the agent of ${identity.name}` : identity.name}${requestedFor ? ` for ${requestedFor}` : ''}`
    const requested = { at: requestedAt.toISOString(), message: waits ? `requested by ${who}; waiting for approval${madeAsPerson(action) ? '; it runs as whoever approves it' : ''}` : `requested by ${who}` }
    const noted = differs.map((d) => ({ at: requestedAt.toISOString(), message: `input "${d.input}" differs from what the hub filled in for whoever asked: ${asText(d.filled)} filled in, ${asText(d.sent)} sent` }))
    const stated = await this.statementOf(action, inputs, waits ? waiting : null, judged)
    // The run, the row that says it was asked, and its change events are written together: what was stated is never lost to a run that failed to be written, nor the run to its events.
    await this.deps.db.tx(async (client) => {
      await client.query('INSERT INTO action_runs (id, action, blueprint, key, inputs, actor, state, log, created_at, tiers, revises, approvals_needed, held_for, approvers, requested_for, by_address, current, statement_digest, routed, route_asks, agent) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)', [
        runId,
        action.id,
        entity?.blueprint ?? null,
        entity?.key ?? null,
        JSON.stringify(inputs),
        identity.name,
        state,
        JSON.stringify([requested, ...noted]),
        requestedAt,
        JSON.stringify(tiers),
        revises,
        asks,
        held,
        approvers ? JSON.stringify(approvers) : null,
        requestedFor,
        how.address ?? null,
        listed.length ? JSON.stringify(kept) : null,
        stated?.digest ?? null,
        stated ? JSON.stringify(stated.routing) : null,
        stated && routeAsks ? JSON.stringify(routeAsks) : null,
        identity.agent ?? null,
      ])
      // The row says who really called, the tier a tool reached with, and what the run asked to be granted, each only when there is one.
      const told = { ...(how.through ? { via: how.through } : {}), ...(requestedFor ? { requestedFor } : {}), ...(action.tool ? { tool: action.tool.tier } : {}), ...(tiers.length ? { tiers } : {}), ...(revises ? { revises } : {}), ...(differs.length ? { differs: differs.map((d) => d.input) } : {}), ...(listed.length ? { current: kept } : {}) }
      await record(client, 'action.requested', entity, null, identity.name, { action: action.id, run: runId, inputs: withoutAttached(action.inputs, inputs), state, ...told })
      if (stated) await this.recordStated(client, { id: runId, action: action.id, entity }, stated, requestedAt)
    })
    this.deps.log.info('action requested', { action: action.id, run: runId, entity: entity?.id, by: identity.name, through: how.through ?? null, requestedFor: !!requestedFor, state, tiers, revises })
    this.deps.events.emit({ type: 'action_run', id: runId })
    // A round that revises a run still waiting supersedes it: only the newest round is ever decided.
    if (revisedRun?.state === 'awaiting') await this.cancel(revisedRun, `superseded by run ${runId}, its next round, asked by ${identity.name}`, identity.name)
    // A newer request of the line replaces every one not started yet, so only the newest is ever approved and run.
    const replaced = unstarted.filter((r) => r.id !== revises)
    for (const old of replaced) await this.cancel(old, `replaced by run ${runId}, asked by ${identity.name}`, identity.name)
    if (replaced.length) this.deps.log.info('older runs of the line replaced', { action: action.id, run: runId, replaced: replaced.map((r) => r.id) })
    else if (action.serial) this.deps.log.debug('no run of the line waits to be replaced', { action: action.id, run: runId })
    // An answer that is revealed is handed back on this request and written nowhere.
    let revealed: string | undefined
    if (!waits) await this.dispatch(await this.requireRun(runId), scope, (answer) => void (revealed = answer))
    const run = await this.requireRun(runId)
    return revealed === undefined ? run : { ...run, told: revealed }
  }

  /**
   * Judges a run as it is asked, and writes nothing: what it runs on, that a
   * rule lets the asker run it there and whether it waits, the tiers it asks
   * for, and every input checked as its kind checks it. Throws what refuses it.
   */
  private async judge(action: Action, body: RunActionRequest, identity: Identity, view: View | undefined, how: { through?: string; tool?: boolean; address?: string }): Promise<Judged> {
    const id = action.id
    let entity: Entity | null = null
    let waits = !how.tool && !!action.approval
    let selfHeld = false
    const targets = actionTargets(action)
    // What the form sent, with each input that narrows the target set from the target.
    const sent: Record<string, unknown> = { ...(body.inputs ?? {}) }
    if (targets.length) {
      const named = targets.length === 1 ? `a ${targets[0]}` : `one of ${targets.join(', ')}`
      if (!body.entity) throw new ActionError(`Action "${id}" runs on ${named}: say which`)
      if (!targets.includes(body.entity.blueprint)) throw new ActionError(`Action "${id}" runs on ${named}, not a ${body.entity.blueprint}`)
      const missing = new ActionError(`Action "${id}" cannot run on ${entityId(body.entity)}: it does not exist, or the action does not apply to it`)
      entity = await this.pick(body.entity, (await this.filtersFor(identity, action)).where(body.entity.blueprint), view)
      if (!entity) throw missing
      if (!how.tool) {
        const target = (await this.targets(identity, view, action, [body.entity])).get(entity.id)
        if (!target) {
          // Said the same way as an entity that is not there, so a refusal tells nobody what exists.
          await record(this.deps.db, 'access.refused', body.entity, null, identity.name, { action: id, reason: 'no rule lets them run it on this', ...(how.through ? { via: how.through } : {}) }, new Date(), 'refused')
          this.deps.log.warn('action refused: no rule lets the caller run it on this entity', { action: id, by: identity.name, entity: entity.id })
          throw missing
        }
        this.deps.log.debug('action allowed on the entity', { action: id, by: identity.name, entity: entity.id, approval: target.approval })
        waits = target.approval !== false
        selfHeld = target.approval === 'self'
      }
      // An input that narrows the target is what the target holds: given otherwise, the form and the target disagree.
      for (const name of narrowingInputs(action)) {
        const def = action.inputs[name]!
        const held = narrowValue(entity, def)
        const given = sent[name]
        const picks = this.picksOf(def)
        // A bare key names an entity only when the input picks from one blueprint.
        const asId = picks.length === 1 && typeof given === 'string' ? (entityIdFor(given, picks[0]!) ?? given) : given
        if (given !== undefined && given !== null && given !== '' && stable(asId) !== stable(held)) throw new ActionError(`Input "${name}": ${entity.title} is not in ${String(asId)}`, 400, name)
        sent[name] = held
      }
    }
    const named = await this.templateOf(action, entity)
    if ('refused' in named) {
      this.deps.log.info('action run refused: its entity names no job template', { action: id, by: identity.name, entity: entity?.id ?? null, reason: named.refused })
      throw new ActionError(`Action "${id}" cannot run here: ${named.refused}`, 409)
    }
    // Tiers the action does not carry are a grant somebody who holds them makes: the run waits for that, whatever the rule says.
    const carried = action.access?.tiers ?? []
    const asked = how.tool ? [] : (body.tiers ?? [])
    const tiers = TOOL_TIERS.filter((t) => asked.includes(t) && !carried.includes(t))
    if (tiers.length) {
      if (!entity) throw new ActionError(`Action "${id}" runs on no entity, so its run can be granted no tool tier`)
      this.deps.log.info('action run asks for tiers its action does not carry: it waits for someone who holds them', { action: id, by: identity.name, entity: entity.id, tiers })
      waits = true
    } else if (asked.length) this.deps.log.debug('action run asks for no tier beyond what its action carries', { action: id, by: identity.name, asked })
    // A product that asks as itself for a person names them as data; naming approvers then asks for their decision.
    const requestedFor = body.requestedFor ?? null
    const approvers = body.approvers?.length ? body.approvers : null
    if (requestedFor && approvers && !waits) {
      this.deps.log.info('action run asked for a person names approvers: it waits for them', { action: id, by: identity.name })
      waits = true
    }
    const revisedRun = how.tool ? null : await this.revised(action, entity, identity, body.revises)
    const runId = randomBytes(6).toString('hex')
    const requestedAt = new Date()
    const scope = this.baseScope(action, entity, runId, identity.name, requestedAt.toISOString(), how.address)
    // A default the hub fills in from who asks is its own word about them: a value sent in its place is kept, and recorded as differing.
    const differs: { input: string; filled: unknown; sent: unknown }[] = []
    // The lists the entity holds now, for the inputs that change one: rendered here, as the run is asked for, and kept on it as they are.
    const kept: Record<string, unknown[]> = {}
    const inputs = await this.inputsFor(action, sent, scope, view, runId, (d) => differs.push(d), kept)
    if (differs.length) this.deps.log.info('action run: inputs differ from what the hub filled in for who asks', { action: id, run: runId, by: identity.name, inputs: differs.map((d) => d.input) })
    const listed = Object.keys(kept)
    if (listed.length) {
      // A run that leaves every list as it is would change nothing: it is refused before anyone is asked to approve it.
      const changed = Object.entries(runChanges(action.inputs, inputs, kept)).filter(([, c]) => changes(c))
      if (!changed.length) {
        this.deps.log.info('action run refused: it changes nothing in the lists it edits', { action: id, by: identity.name, inputs: listed })
        throw new ActionError(`Input "${listed[0]}": this is the list as it is now, so nothing would change`, 400, listed[0])
      }
      this.deps.log.debug('action run changes the lists it edits', { action: id, run: runId, inputs: changed.map(([name]) => name) })
      ;(scope.run as Record<string, unknown>).current = kept
    }
    // A report run's inputs are checked against the report as well, so a layout that does not read is refused before anything is asked.
    if (action.backend.type === 'report' && this.reports) {
      const wrong = await this.reports.check(action.backend.verb, inputs, identity, entity)
      if (wrong) {
        this.deps.log.info('report run refused: its inputs do not hold', { action: id, by: identity.name, input: wrong.input })
        throw new ActionError(wrong.message, 400, wrong.input)
      }
    }
    // The one place whether a run waits is settled: what the action and its rules ask, with the judge's route added for an action that opts in.
    const routed = await this.route(action, inputs, runId, waits, selfHeld)
    return { action, entity, inputs, kept, listed, differs, ...routed, tiers, requestedFor, approvers, revisedRun, runId, requestedAt, scope }
  }

  /**
   * The inputs a run holds, each checked as its kind checks it over `scope`,
   * which grows input by input: one not asked holds nothing, a worked-out one
   * is the hub's own, and an empty one takes its default. Throws on the first
   * input it refuses. Into `kept` go the lists the entity holds now, for each
   * input asked that edits one, rendered over the scope above it.
   */
  private async inputsFor(action: Action, sent: Record<string, unknown>, scope: Scope, view: View | undefined, runId: string, differs?: (d: { input: string; filled: unknown; sent: unknown }) => void, kept?: Record<string, unknown[]>): Promise<Record<string, unknown>> {
    const inputs: Record<string, unknown> = {}
    for (const [name, def] of Object.entries(action.inputs)) {
      const empty = (v: unknown) => inputEmpty(def, v)
      // An input is asked by the inputs above it, as they were checked. One not asked holds nothing, whatever was sent for it.
      if (!isAsked(def, inputs)) {
        if (!empty(sent[name])) this.deps.log.debug('input not asked: what was sent for it is dropped', { action: action.id, run: runId, input: name })
        else this.deps.log.debug('input not asked', { action: action.id, run: runId, input: name })
        inputs[name] = def.many ? [] : null
        ;(scope.inputs as Record<string, unknown>)[name] = def.many ? [] : null
        continue
      }
      if (kept && editsList(def)) kept[name] = heldList(def, render(def.current, scope))
      // A worked-out input is the hub's to work out: what was sent for it is never read.
      const given = def.value !== undefined ? workedOut(def, inputs) : sent[name]
      const filled = def.default === undefined ? undefined : render(def.default, scope)
      const value = empty(given) ? filled : given
      // What the hub fills in from who asks is read again here, never taken from the form: a value sent that differs is told.
      if (differs && !empty(given) && def.value === undefined && readsAsker(def.default) && !empty(filled) && asText(given).trim() !== asText(filled).trim()) differs({ input: name, filled, sent: given })
      if (empty(value)) {
        if (def.required) throw new ActionError(`Input "${name}" is required`, 400, name)
        // Nothing picked for a list is an empty list, so a template reads no items.
        inputs[name] = def.many ? [] : null
        ;(scope.inputs as Record<string, unknown>)[name] = def.many ? [] : null
        continue
      }
      const checked = await this.check(name, def, value, scope, view)
      inputs[name] = checked.stored
      ;(scope.inputs as Record<string, unknown>)[name] = checked.inScope
    }
    return inputs
  }

  /**
   * The inputs each entity of a batch would run with: what was sent, checked
   * once for each set of values the inputs that narrow the target take, each
   * filled from its entity as a run alone fills it. An input that reads the
   * entity, or reads what narrows it, is refused, since one answer cannot hold
   * for each. An entity whose own values an input refuses, or that names no
   * template for the action's job, is named with why, and the rest go on; a
   * refusal of what was sent stops the batch. `shared` is what every run
   * holds alike: what was sent, checked.
   */
  async inputsForMany(action: Action, entities: { blueprint: string; key: string; title: string }[], sent: Record<string, unknown>, identity: Pick<Identity, 'kind' | 'name'>, view: View, batch: string): Promise<{ inputs: Map<string, Record<string, unknown>>; shared: Record<string, unknown>; refused: { blueprint: string; key: string; title: string; reason: string }[] }> {
    const [blocked, why] = [...unbatchable(action.inputs)][0] ?? []
    if (blocked) throw new ActionError(`Input "${blocked}" ${why}, so it cannot be asked once for many`, 400, blocked)
    const narrowing = narrowingInputs(action)
    const asked = Object.fromEntries(Object.entries(sent).filter(([name]) => !narrowing.includes(name)))
    if (Object.keys(asked).length < Object.keys(sent).length) this.deps.log.debug('batch: a value sent for an input that narrows the target is dropped; each entity fills its own', { action: action.id, batch })
    // Each entity's values for what narrows it, read from the stored rows as the reader sees them.
    const held = new Map<string, { entity: { blueprint: string; key: string; title: string }; values: Record<string, unknown> }[]>()
    const shown = narrowing.length ? new Map((await this.deps.reader.hydrated(entities)).flatMap((e) => { const seen = view.entity(e); return seen ? [[seen.id, seen] as const] : [] })) : null
    const refused: { blueprint: string; key: string; title: string; reason: string }[] = []
    // What each entity names for the action's job, read as the hub holds it, in one read for them all.
    const own = readsEntity(action) ? new Map((await this.deps.reader.hydrated(entities)).map((e) => [e.id, e])) : null
    for (const e of entities) {
      const named = own ? this.templateOn(action, own.get(entityId(e)) ?? null, e) : null
      if (named && 'refused' in named) {
        refused.push({ ...e, reason: `It cannot run here: ${named.refused}` })
        continue
      }
      const seen = shown?.get(entityId(e))
      if (shown && !seen) {
        refused.push({ ...e, reason: 'It does not exist, or the action does not apply to it' })
        continue
      }
      const values = Object.fromEntries(narrowing.map((n) => [n, narrowValue(seen!, action.inputs[n]!)]))
      const line = stable(values)
      held.set(line, [...(held.get(line) ?? []), { entity: e, values }])
    }
    const inputs = new Map<string, Record<string, unknown>>()
    let shared: Record<string, unknown> | null = null
    const filters = await this.filtersFor(identity, action)
    for (const group of held.values()) {
      const first = await this.pick(group[0]!.entity, filters.where(group[0]!.entity.blueprint), view)
      if (!first) throw new ActionError(`${group[0]!.entity.title} no longer exists, or the action no longer applies to it`, 409)
      let checked: Record<string, unknown>
      try {
        checked = await this.inputsFor(action, { ...asked, ...group[0]!.values }, this.baseScope(action, first, batch, identity.name, new Date().toISOString()), view, batch)
      } catch (error) {
        // What an entity holds itself is refused for that entity alone; what was sent is refused for all.
        if (!(error instanceof ActionError) || !error.input || !narrowing.includes(error.input)) throw error
        this.deps.log.info('batch: entities refused for what narrows them', { action: action.id, batch, input: error.input, entities: group.length, reason: error.message })
        for (const { entity } of group) refused.push({ ...entity, reason: error.message })
        continue
      }
      shared ??= Object.fromEntries(Object.entries(checked).filter(([name]) => !narrowing.includes(name)))
      for (const { entity } of group) inputs.set(entityId(entity), checked)
    }
    if (narrowing.length) this.deps.log.debug('batch: inputs filled from each entity', { action: action.id, batch, sets: held.size, refused: refused.length })
    return { inputs, shared: shared ?? asked, refused }
  }

  /**
   * Asks for the action on each entity, as one batch: every run is judged by
   * the same rules as one asked for alone, and each is its own row naming the
   * batch, holding the inputs `inputsForMany` gave its entity. An entity whose
   * run the rules or its own values turn down is named with why, and the rest
   * go on.
   */
  async askMany(action: Action, entities: { blueprint: string; key: string; title: string }[], sent: Record<string, unknown>, identity: Identity, view: View, batch: string): Promise<{ runs: number; waiting: number; inputs: Record<string, unknown>; refused: { blueprint: string; key: string; title: string; reason: string }[] }> {
    const allowed = await this.targets(identity, view, action, entities)
    const filled = await this.inputsForMany(action, entities, sent, identity, view, batch)
    const refused = [...filled.refused]
    const out = new Set(refused.map(entityId))
    const rows: { id: string; entity: EntityRef; state: ActionRunState; held: HeldFor | null; inputs: Record<string, unknown> }[] = []
    const at = new Date()
    let found: string | undefined
    let pool: Identity[] | undefined
    let undecided = 0
    for (const e of entities) {
      if (out.has(entityId(e))) continue
      const target = allowed.get(entityId(e))
      if (!target) {
        refused.push({ ...e, reason: 'No rule lets you run it on this' })
        continue
      }
      const waits = !!action.approval || target.approval !== false
      const row = { id: randomBytes(6).toString('hex'), entity: { blueprint: e.blueprint, key: e.key }, state: (waits ? 'awaiting' : 'queued') as ActionRunState, held: (!waits ? null : target.approval === 'self' ? 'self' : 'others') as HeldFor | null, inputs: filled.inputs.get(entityId(e))! }
      if (waits) {
        // A run nobody could approve would wait for ever: it is turned down with why, as one the rules turn down is.
        const decider = await this.undecided({ id: row.id, action: action.id, entity: row.entity, by: identity.name, agent: identity.agent ?? null, state: 'awaiting', approvedBy: [], approvalsNeeded: needed(action), requestedFor: null, approvers: null, heldFor: row.held, tiers: [] }, (pool ??= await this.deps.deciding()), found)
        if ('why' in decider) {
          refused.push({ ...e, reason: decider.why })
          undecided++
          continue
        }
        found = decider.by ?? found
      }
      rows.push(row)
    }
    if (undecided) this.deps.log.warn('batch: runs nobody could approve turned down', { action: action.id, batch, by: identity.name, undecided })
    else this.deps.log.debug('batch: every run that waits has someone who may approve it', { action: action.id, batch })
    if (!rows.length) throw new ActionError(refused.length ? `It may run on none of the ${refused.length} picked: ${refused[0]!.reason}` : 'Nothing is picked', 400)
    if (madeAsPerson(action) && rows.some((r) => r.state === 'queued')) needsOwnSignIn(identity.name, 'Running these')
    // One statement for every run, and one line in each log: a batch of thousands is asked in a moment.
    const said = (state: ActionRunState) => JSON.stringify([{ at: at.toISOString(), message: state === 'awaiting' ? `requested by ${identity.name} in batch ${batch}; waiting for approval${madeAsPerson(action) ? '; it runs as whoever approves it' : ''}` : `requested by ${identity.name} in batch ${batch}` }])
    for (let i = 0; i < rows.length; i += 1000) {
      const part = rows.slice(i, i + 1000)
      await this.deps.db.query(
        `INSERT INTO action_runs (id, action, blueprint, key, inputs, actor, state, log, created_at, tiers, batch, approvals_needed, held_for, agent)
         SELECT id, $1, blueprint, key, inputs::jsonb, $2, state, log::jsonb, $3, '[]'::jsonb, $4, CASE WHEN state = 'awaiting' THEN $11::int ELSE 1 END, held, $13 FROM unnest($5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::text[], $12::text[]) AS t(id, blueprint, key, state, log, inputs, held)`,
        [action.id, identity.name, at, batch, part.map((r) => r.id), part.map((r) => r.entity.blueprint), part.map((r) => r.entity.key), part.map((r) => r.state), part.map((r) => said(r.state)), part.map((r) => JSON.stringify(r.inputs)), needed(action), part.map((r) => r.held), identity.agent ?? null],
      )
    }
    // A run that waits is told to its deciders as any other is; a run that goes straight to its runner is the batch's to tell.
    const waiting = rows.filter((r) => r.state === 'awaiting')
    for (const r of waiting) await record(this.deps.db, 'action.requested', r.entity, null, identity.name, { action: action.id, run: r.id, inputs: withoutAttached(action.inputs, r.inputs), state: 'awaiting', batch })
    for (const r of rows.filter((r) => r.state === 'queued')) if (action.backend.type !== 'runner') await this.dispatch(await this.requireRun(r.id), await this.scopeOf(await this.requireRun(r.id)))
    if (action.backend.type === 'runner' && rows.some((r) => r.state === 'queued')) await this.deps.db.query(`UPDATE action_runs SET log = log || $2::jsonb WHERE batch = $1 AND state = 'queued' AND id = ANY($3)`, [batch, JSON.stringify([{ at: new Date().toISOString(), message: `queued for runner ${action.backend.runner}` }]), rows.filter((r) => r.state === 'queued').map((r) => r.id)])
    this.deps.events.emit({ type: 'action_run', id: batch })
    return { runs: rows.length, waiting: waiting.length, inputs: filled.shared, refused }
  }

  /** Cancels every run of a batch nobody has started. How many it cancelled. */
  async cancelBatch(batch: string, why: string, actor: string): Promise<number> {
    const at = new Date()
    const done = await this.deps.db.query<RunRow>(`UPDATE action_runs SET state = 'cancelled', finished_at = $2, retry_at = NULL, behalf_grant = NULL, log = log || $3::jsonb WHERE batch = $1 AND state IN ('awaiting', 'queued') RETURNING *`, [batch, at, JSON.stringify([{ at: at.toISOString(), message: why }])])
    for (const row of done.rows) await record(this.deps.db, 'action.cancelled', toRun(row).entity, null, actor, { action: row.action, run: row.id, requestedBy: row.actor, reason: why, batch })
    if (done.rowCount) this.deps.events.emit({ type: 'action_run', id: batch })
    return done.rowCount ?? 0
  }

  /**
   * Judges one item of a change set as a run of it alone is judged, and
   * writes nothing: the action must be open to the asker this way, a rule
   * must let them run it on its entity, and every input is checked as its
   * kind checks it. Throws what refuses it. An item asks no tier, names no
   * approvers, and revises nothing.
   */
  async judgeItem(id: string, item: { entity?: EntityRef; inputs: Record<string, unknown> }, identity: Identity, view: View, how: { via: 'form' | 'tool'; through?: string }): Promise<JudgedRun> {
    const action = this.require(id)
    await this.admit(action, identity, how.via, how.through)
    return this.judge(action, { ...(item.entity ? { entity: item.entity } : {}), inputs: item.inputs }, identity, view, how.through ? { through: how.through } : {})
  }

  /**
   * Who holds a change set's runs, and whether anyone may decide them as one.
   * Every run of a set waits for the set's one decision: held for the asker's
   * own yes when they could run every item without anyone else's approval,
   * and for others otherwise, each run then decided by the rules a run alone
   * is. Someone enrolled must be able to decide every run of it, seeing each,
   * or it would wait for ever: `refused` names each item nobody could decide
   * even alone, and `none` says when each has a decider but nobody decides
   * them all.
   */
  async holdSet(set: string, items: JudgedRun[], identity: Identity): Promise<{ held: HeldFor; decider: string } | { held: HeldFor; refused: { index: number; why: string }[] } | { held: HeldFor; none: string }> {
    const held: HeldFor = items.every((i) => !i.waits || i.selfHeld) ? 'self' : 'others'
    const runs = items.map((i) => this.setWaiting(set, i, identity, held))
    const pool = await this.deps.deciding()
    for (const person of held === 'self' ? pool.filter((p) => p.name === identity.name) : pool) {
      if (await this.decidesAll(person, await this.deps.seenBy(person), runs, set)) {
        this.deps.log.debug('change set has someone who decides every run of it', { set, held, decider: person.name, runs: runs.length })
        return { held, decider: person.name }
      }
    }
    const refused: { index: number; why: string }[] = []
    for (const [index, run] of runs.entries()) {
      const alone = await this.undecidedIn(run, pool, set)
      if ('why' in alone) refused.push({ index, why: alone.why })
    }
    this.deps.log.warn('change set refused: nobody may decide every run of it', { set, held, by: identity.name, undecidable: refused.length, runs: runs.length })
    if (refused.length) return { held, refused }
    return { held, none: held === 'self' ? 'Every change of it is yours to run, so it waits for your own yes, and you may not approve every one of them yourself' : 'Each change of it has someone who may approve it, but nobody may approve them all, so one approval could not decide it: split it by who approves each' }
  }

  /** Why nobody enrolled would decide one run of a change set, or who first would: as `undecided` judges a run alone, within its set. */
  private async undecidedIn(run: Waiting, pool: Identity[], set: string): Promise<{ by: string } | { why: string }> {
    for (const person of pool) if (!(await this.undecidable(person, await this.deps.seenBy(person), run, set)) && (!run.entity || (await this.deps.seenBy(person)).seesEntity(run.entity))) return { by: person.name }
    const alone = await this.undecided({ ...run, changeSet: null }, pool)
    return 'why' in alone ? alone : { why: 'Nobody who may approve it also sees what it runs on' }
  }

  /**
   * The people a rule lets decide every run of a change set that waits: who
   * to tell that it waits, as `deciders` names them for a run alone.
   */
  async setDeciders(set: string, runs: ActionRun[]): Promise<string[]> {
    const waiting = runs.filter((r) => r.state === 'awaiting')
    if (!waiting.length) return []
    const named: string[] = []
    for (const person of this.deps.people()) {
      let runsAll = true
      for (const id of new Set(waiting.map((r) => r.action))) {
        const action = this.get(id)
        if (!action || !(await this.deps.mayRun(person, action))) runsAll = false
      }
      if (runsAll && (await this.decidesAll(person, await this.deps.seenBy(person), waiting, set))) named.push(person.name)
    }
    this.deps.log.debug(named.length ? 'change set has deciders by rule' : 'no rule names a decider of the change set', { set, deciders: named })
    return named
  }

  /** Whether one identity decides every run of a change set, seeing what each runs on. */
  async decidesAll(identity: Identity, view: View, runs: Waiting[], set: string): Promise<boolean> {
    for (const run of runs) {
      if (run.entity && !view.all && !view.seesEntity(run.entity)) return false
      if (await this.undecidable(identity, view, run, set)) return false
    }
    return true
  }

  /** Why one identity may not decide one run of a change set as part of the set, or null when they may. */
  async whyNotInSet(identity: Identity, view: View, run: ActionRun, set: string): Promise<string | null> {
    if (run.entity && !view.all && !view.seesEntity(run.entity)) return 'You do not see everything it changes'
    return this.undecidable(identity, view, run, set)
  }

  /** A judged item as the run it would be, waiting in its set. */
  private setWaiting(set: string, i: JudgedRun, identity: Identity, held: HeldFor): Waiting {
    return { id: i.runId, action: i.action.id, entity: i.entity ? { blueprint: i.entity.blueprint, key: i.entity.key } : null, by: identity.name, agent: identity.agent ?? null, state: 'awaiting', approvedBy: [], approvalsNeeded: setNeed(i), requestedFor: null, approvers: null, heldFor: held, tiers: [], changeSet: set, routeAsks: i.judged?.asks ?? null }
  }

  /**
   * Writes the runs of a change set, each waiting for the set's decision, in
   * the set's own transaction: each is its own row naming the set and its
   * place in it, with the one activity row a run alone that waits writes.
   */
  async putSet(client: Queryable, set: string, items: JudgedRun[], held: HeldFor, identity: Identity, through?: string): Promise<void> {
    const who = through ? `${identity.name} through ${through}` : identity.name
    // Each run of a set waits for the set's one decision, so each that states a change is routed to the people who decide it in the set.
    const stated: (Stated | null)[] = []
    for (const i of items) stated.push(await this.statementOf(i.action, i.inputs, this.setWaiting(set, i, identity, held), i.judged, set))
    for (const [index, i] of items.entries()) {
      const at = i.requestedAt.toISOString()
      const requested = { at, message: `requested by ${who} in change set ${set}; waiting for its approval${madeAsPerson(i.action) ? '; it runs as whoever approves it' : ''}` }
      const noted = i.differs.map((d) => ({ at, message: `input "${d.input}" differs from what the hub filled in for whoever asked: ${asText(d.filled)} filled in, ${asText(d.sent)} sent` }))
      await client.query('INSERT INTO action_runs (id, action, blueprint, key, inputs, actor, state, log, created_at, tiers, approvals_needed, held_for, current, change_set, set_index, statement_digest, routed, route_asks, agent) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)', [
        i.runId,
        i.action.id,
        i.entity?.blueprint ?? null,
        i.entity?.key ?? null,
        JSON.stringify(i.inputs),
        identity.name,
        'awaiting',
        JSON.stringify([requested, ...noted]),
        i.requestedAt,
        '[]',
        setNeed(i),
        held,
        i.listed.length ? JSON.stringify(i.kept) : null,
        set,
        index,
        stated[index]?.digest ?? null,
        stated[index] ? JSON.stringify(stated[index].routing) : null,
        stated[index] && i.judged?.asks ? JSON.stringify(i.judged.asks) : null,
        identity.agent ?? null,
      ])
      const told = { ...(through ? { via: through } : {}), ...(i.differs.length ? { differs: i.differs.map((d) => d.input) } : {}), ...(i.listed.length ? { current: i.kept } : {}) }
      await record(client, 'action.requested', i.entity, null, identity.name, { action: i.action.id, run: i.runId, inputs: withoutAttached(i.action.inputs, i.inputs), state: 'awaiting', set, ...told })
      const said = stated[index]
      if (said) await this.recordStated(client, { id: i.runId, action: i.action.id, entity: i.entity }, said, i.requestedAt)
    }
  }

  /** Runs as a reader is shown them, each with the titles of what it ran on and what its inputs name; none is left out. */
  async titles(runs: ActionRun[], view: View): Promise<ActionRun[]> {
    return this.titled(runs, view)
  }

  /** Where a person opens one run, to read it or decide it. */
  runUrl(id: string): string {
    return `${this.deps.publicUrl.replace(/\/+$/, '')}/actions/runs/${encodeURIComponent(id)}`
  }

  /** Where a person opens one change set, to read it or decide it. */
  setUrl(id: string): string {
    return `${this.deps.publicUrl.replace(/\/+$/, '')}/actions/sets/${encodeURIComponent(id)}`
  }

  /** Whether an identity may run an action at all, before what it runs on is asked. */
  async mayRun(identity: Identity, action: Action): Promise<boolean> {
    return this.deps.mayRun(identity, action)
  }

  /**
   * The run a new one asks again for, checked: one of the asker's own, of the
   * same action on the same entity, that was sent back or still waits for its
   * decision. One that still waits is superseded by the new round once that
   * is asked. Null when none is named.
   */
  private async revised(action: Action, entity: Entity | null, identity: Identity, id: string | undefined): Promise<ActionRun | null> {
    if (!id) return null
    const old = await this.getRun(id)
    const same = old && old.action === action.id && old.by === identity.name && (old.entity ? entityId(old.entity) : null) === (entity?.id ?? null)
    if (!old || !same) {
      this.deps.log.warn('run refused: the run it revises is not the asker\'s own of this action here', { action: action.id, by: identity.name, revises: id })
      throw new ActionError(`Run "${id}" is not one of yours of this action here, so a new run cannot revise it`)
    }
    if (old.state !== 'returned' && old.state !== 'awaiting') {
      this.deps.log.info('run refused: the run it revises was decided or ended', { action: action.id, by: identity.name, revises: id, state: old.state })
      throw new ActionError(`Run "${id}" is ${old.state}: only a run sent back, or one still waiting for its decision, is revised`, 409)
    }
    this.deps.log.debug('run revises one of its asker\'s own', { action: action.id, by: identity.name, revises: id, state: old.state })
    return old
  }

  /**
   * Withdraws a run nobody has started: the person who asked, or an admin.
   * It ends `cancelled` and never runs.
   */
  async withdraw(id: string, identity: Identity, reason?: string, set?: string): Promise<ActionRun> {
    const run = await this.requireRun(id)
    if (run.by !== identity.name && !identity.admin) throw new ActionError('Only the person who asked for a run, or an admin, withdraws it', 403)
    if (run.state === 'running' && this.stoppable(run)) {
      if (!(await this.stop(run, `stopped by ${identity.name}${reason ? `: ${reason}` : ''}`, identity.name))) throw new ActionError(`Run "${id}" ended while it was stopped`, 409)
      return this.requireRun(id)
    }
    if (run.changeSet && run.changeSet !== set) throw new ActionError(`Run "${id}" is one of a change set, which is withdrawn whole: ${this.setUrl(run.changeSet)}`, 409)
    if (run.state !== 'awaiting' && run.state !== 'queued') throw new ActionError(`Run "${id}" is ${run.state}: only a run not started yet is withdrawn, or a job's run under way, whose job is then stopped`, 409)
    if (!(await this.cancel(run, `withdrawn by ${identity.name}${reason ? `: ${reason}` : ''}`, identity.name))) throw new ActionError(`Run "${id}" started or ended while it was withdrawn`, 409)
    return this.requireRun(id)
  }

  /** The runs of the line `inputs` on `entity` belong to, in the given states, oldest first. None for an action that is not serial. */
  private async inLine(action: Action, entity: EntityRef | null, inputs: Record<string, unknown>, states: ActionRunState[]): Promise<ActionRun[]> {
    if (!action.serial) return []
    const rows = await this.deps.db.query<RunRow>('SELECT * FROM action_runs WHERE action = $1 AND blueprint IS NOT DISTINCT FROM $2 AND key IS NOT DISTINCT FROM $3 AND state = ANY($4) ORDER BY created_at', [action.id, entity?.blueprint ?? null, entity?.key ?? null, states])
    const line = lineOf(action.serial, inputs)
    return rows.rows.map(toRun).filter((r) => lineOf(action.serial!, r.inputs) === line)
  }

  /**
   * Starts a queued run, unless another of its line is running, or its action
   * already has as many runs in flight as its `concurrency`. Under a lock on
   * the line and one on the action, so two starts at once never both win.
   * `inOrder` also holds it behind any run of the action queued before it
   * (`TURN_ORDER`), for the runs the hub hands on itself. `claimer` is what
   * claimed it, for the line that says so. Says why it waits, or the state
   * that kept it from starting.
   */
  private async start(run: ActionRun, claimedBy: string | null, inOrder = false, claimer: 'runner' | 'starter' = 'runner'): Promise<{ started: true } | { waits: string } | { state: ActionRunState }> {
    // A run its route names a start for never starts before it, whoever would start it.
    const from = run.routed?.route.to === 'people' ? run.routed.route.start : undefined
    if (from && Date.parse(from) > Date.now()) {
      this.deps.log.info('action run waits for the start its route names', { run: run.id, action: run.action, start: from })
      return { waits: `its route lets it start no earlier than ${from}` }
    }
    const action = this.get(run.action)
    const line = action?.serial ? `${run.action}|${run.entity ? entityId(run.entity) : ''}|${lineOf(action.serial, run.inputs)}` : null
    const out = await this.deps.db.tx(async (client) => {
      if (line) {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [line])
        const running = await client.query<RunRow>(`SELECT * FROM action_runs WHERE action = $1 AND blueprint IS NOT DISTINCT FROM $2 AND key IS NOT DISTINCT FROM $3 AND state = 'running' AND id <> $4`, [run.action, run.entity?.blueprint ?? null, run.entity?.key ?? null, run.id])
        const busy = running.rows.map(toRun).find((r) => lineOf(action!.serial!, r.inputs) === lineOf(action!.serial!, run.inputs))
        if (busy) return { waits: `run "${busy.id}" of the same line is running` }
      }
      if (action?.concurrency) {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`concurrency|${run.action}`])
        const flying = (await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM action_runs WHERE action = $1 AND state = 'running' AND id <> $2`, [run.action, run.id])).rows[0]?.n ?? 0
        if (flying >= action.concurrency) return { waits: `${flying} of its runs are in flight, the most it runs at once` }
        if (inOrder) {
          const first = (await client.query<{ id: string }>(`SELECT id FROM action_runs WHERE action = $1 AND state = 'queued' AND retry_at IS NULL ORDER BY ${TURN_ORDER} LIMIT 1`, [run.action])).rows[0]?.id
          if (first && first !== run.id) return { waits: `run "${first}" was queued before it and starts first` }
        }
      }
      const at = new Date()
      const message = claimedBy ? `claimed by ${claimer} ${claimedBy}` : 'started'
      const done = await client.query<{ state: ActionRunState }>(
        `UPDATE action_runs SET state = 'running', claimed_by = coalesce($2, claimed_by), started_at = coalesce(started_at, $3), log = log || $4::jsonb WHERE id = $1 AND state = 'queued' RETURNING state`,
        [run.id, claimedBy, at, JSON.stringify(claimedBy ? [{ at: at.toISOString(), message }] : [])],
      )
      if (!done.rowCount) return { state: (await client.query<{ state: ActionRunState }>('SELECT state FROM action_runs WHERE id = $1', [run.id])).rows[0]?.state ?? run.state }
      return { started: true as const }
    })
    if ('started' in out) this.deps.events.emit({ type: 'action_run', id: run.id })
    else if ('waits' in out) this.deps.log.debug('action run waits its turn', { run: run.id, action: run.action, why: out.waits })
    return out
  }

  /** Ends a run nobody has started as cancelled, and says so in the activity log. False when it had already started or ended. */
  private async cancel(run: ActionRun, why: string, actor: string | null): Promise<boolean> {
    const at = new Date()
    const done = await this.deps.db.query(`UPDATE action_runs SET state = 'cancelled', finished_at = $2, retry_at = NULL, behalf_grant = NULL, job_token = NULL, log = log || $3::jsonb WHERE id = $1 AND state IN ('awaiting', 'queued')`, [run.id, at, JSON.stringify([{ at: at.toISOString(), message: why }])])
    if (!done.rowCount) {
      this.deps.log.info('action run not cancelled: it had started or ended', { run: run.id, action: run.action })
      return false
    }
    this.deps.events.emit({ type: 'action_run', id: run.id })
    await record(this.deps.db, 'action.cancelled', run.entity, null, actor, { action: run.action, run: run.id, requestedBy: run.by, reason: why, ...(run.batch ? { batch: run.batch } : {}), ...setOf(run) })
    await this.endChange(run, 'cancelled')
    this.deps.log.info('action run cancelled', { run: run.id, action: run.action, by: actor, reason: why })
    return true
  }

  /** Whether the hub can have a run under way stopped: only a job's, whose starter stops the job once the run has ended as cancelled. */
  private stoppable(run: Pick<ActionRun, 'action'>): boolean {
    return this.get(run.action)?.backend.type === 'job'
  }

  /**
   * Ends a job's run under way as cancelled. The hub stops nothing itself: the
   * run's starter asks how its runs stand, finds this one cancelled, and stops
   * the job. The run's own credential ends here, and what it handed back to
   * write is let go. False when the run had already ended.
   */
  private async stop(run: ActionRun, why: string, actor: string | null): Promise<boolean> {
    const at = new Date()
    const done = await this.deps.db.query(`UPDATE action_runs SET state = 'cancelled', finished_at = $2, job_token = NULL, log = log || $3::jsonb WHERE id = $1 AND state = 'running'`, [run.id, at, JSON.stringify([{ at: at.toISOString(), message: why }, { at: at.toISOString(), message: `its job is stopped by starter ${run.claimedBy ?? 'unknown'} as it next asks how its runs stand` }])])
    if (!done.rowCount) {
      this.deps.log.info('action run not stopped: it had ended', { run: run.id, action: run.action })
      return false
    }
    this.deps.events.emit({ type: 'action_run', id: run.id })
    await this.settleWriteBack(run.id, this.get(run.action), 'cancelled')
    await record(this.deps.db, 'action.cancelled', run.entity, null, actor, { action: run.action, run: run.id, requestedBy: run.by, reason: why, stopped: true, ...(run.batch ? { batch: run.batch } : {}), ...setOf(run) })
    await this.endChange(run, 'cancelled', true)
    this.deps.log.info('action run stopped while its job ran', { run: run.id, action: run.action, by: actor, starter: run.claimedBy, reason: why })
    this.freed(run.action)
    return true
  }

  /**
   * Why one identity may not approve, decline, or send back a run awaiting
   * approval, or null when they may. A holder of `actions.approve` decides
   * any run; on an entity, so does whoever a rule lets run the action there
   * without someone else's approval: the people trusted to do it themselves
   * vouch for someone else. The person who asked decides their own only where
   * a rule says `approval: self`, or the action's `selfApproval` lets a
   * decider. A run a rule holds for its asker's own approval (`heldFor:
   * self`) is decided by its asker alone, while a rule still lets them run
   * it there: nobody else, not a holder of `actions.approve`, not an admin.
   * A rule that says self lets a person decide only their own run, never
   * vouch for someone else's. A run that asks for tool tiers is decided only
   * by someone who holds each of them on its entity: nobody grants what they
   * do not hold.
   */
  /**
   * Whether `identity` asked for a run themselves, as the rules that keep an asker from deciding mean it: the run's
   * person, unless their agent asked it and the hub lets a person decide what their agent asks (ORY-2002).
   */
  private asked(run: Pick<Waiting, 'by' | 'agent'>, identity: Pick<Identity, 'name'>): boolean {
    return run.by === identity.name && !(run.agent && this.deps.agentPersonDecides)
  }

  private async undecidable(identity: Identity, view: View | undefined, run: Waiting, set?: string): Promise<string | null> {
    const judged = await this.counts(identity, view, run, set)
    return 'why' in judged ? judged.why : null
  }

  /**
   * What one identity's yes would count for on a run awaiting approval, of
   * what it still waits for: the action's own approval (`action`, judged as
   * `undecidable` says), what its route asks (`route`: someone its grants
   * let in, never its asker, holding any tier it asks), or both. A yes that
   * would count for nothing is refused, with why.
   */
  private async counts(identity: Identity, view: View | undefined, run: Waiting, set?: string): Promise<{ counts: ApprovalPart[] } | { why: string }> {
    if (run.state !== 'awaiting') return { why: `it is ${run.state}, not awaiting approval` }
    // An agent asks and never decides: its person decides, signed in (ORY-2002).
    if (identity.agent) return { why: `An agent never decides a run: ${identity.name} decides it, signed in, on its page` }
    // A run of a change set is decided with its set, as one: never alone.
    if (run.changeSet && run.changeSet !== set) return { why: `It is decided with its change set, as one: ${this.setUrl(run.changeSet)}` }
    const owed = owedOf(run)
    if ((run.approvedBy ?? []).some((a) => a.by === identity.name)) return { why: `You already approved it; it waits for ${owedWords(owed)}` }
    const action = this.get(run.action)
    // The person a product asked a run for never decides it, whoever else would.
    if (run.requestedFor && run.requestedFor.toLowerCase() === identity.name.toLowerCase()) return { why: 'This run was asked for you, and the person it is for never decides it' }
    // A run made as a person is made as whoever approves it, so only someone who could run it here themselves approves it into running as them.
    if (action && madeAsPerson(action) && !((await this.deps.mayRun(identity, action)) && (!run.entity || (await this.targets(identity, view, action, [run.entity])).has(entityId(run.entity))))) return { why: `This run is made as whoever approves it, and only someone who may run "${action.title}" here themselves approves it` }
    const counts: ApprovalPart[] = []
    const ownWhy = owed.action > 0 ? await this.ownUndecidable(identity, view, run, action) : null
    if (owed.action > 0 && !ownWhy) counts.push('action')
    let routeWhy: string | null = null
    if (run.routeAsks && owed.route > 0) {
      // Who the route names decides what it asks, beside the action's own approval: never the person who asked, and no override.
      if (this.asked(run, identity)) routeWhy = 'The person who asked for this run never decides what its route asks'
      else if (!(await this.deps.grantsLetIn(identity.name, run.routeAsks.grants))) routeWhy = 'Only someone its route names decides what the route asks'
      else routeWhy = await this.lacksTiers(identity, view, run)
      if (!routeWhy) counts.push('route')
    }
    if (counts.length) return { counts }
    return { why: ownWhy ?? routeWhy ?? `It waits for ${owedWords(owed)}, and yours would count for none of it` }
  }

  /** Why one identity may not give the action's own approval of a run, or null when they may: see `undecidable`. */
  private async ownUndecidable(identity: Identity, view: View | undefined, run: Waiting, action: Action | undefined): Promise<string | null> {
    // What the rules let this person do on the run's entity, read only where a check needs it: most people are judged without it.
    let reading: Promise<Target | undefined> | undefined
    const targetOf = () => (reading ??= action && run.entity ? this.targets(identity, view, action, [run.entity]).then((m) => m.get(entityId(run.entity!))) : Promise.resolve(undefined))
    // The run is theirs (`own`), and they asked it (`asked`) unless their agent did where the hub lets them decide that (ORY-2002).
    const own = run.by === identity.name
    const asked = this.asked(run, identity)
    // A run whose product named its approvers is decided by someone they let in alone: never its asker, and no override.
    if (run.approvers?.length) {
      if (asked) return 'The person who asked for this run never decides it: the people it names as approvers do'
      if (!(await this.deps.grantsLetIn(identity.name, run.approvers))) return 'Only someone the run names as an approver decides it'
      return this.lacksTiers(identity, view, run)
    }
    if (run.heldFor === 'self') {
      if (!own) return 'A rule holds this run for the approval of the person who asked for it, and only they decide it'
      // A run on nothing is theirs to run while the action names them; on an entity, while a rule lets them run it there.
      const still = run.entity ? !!(await targetOf()) : !!action && (await this.deps.mayRun(identity, action))
      return still ? null : 'No rule lets you run this action here any more, so you no longer decide it'
    }
    // A run asked before the hub kept whom it waits for is held for its asker where their rule says self.
    const legacySelf = run.heldFor == null && own && (await targetOf())?.approval === 'self'
    if (asked && !legacySelf && !action?.selfApproval) return 'A run is approved by someone other than the person who asked for it'
    if (!can(identity, 'actions.approve')) {
      const target = await targetOf()
      if (!(target && (target.approval === false || legacySelf))) return 'Only someone who may run this action here without approval, or who holds actions.approve, decides it'
    }
    return this.lacksTiers(identity, view, run)
  }

  /**
   * Why nobody would ever decide a run about to wait, or null when someone
   * enrolled may: judged for each person as `undecidable` judges them when
   * they press Approve. A run that waits for nobody never starts, so it is
   * refused as it is asked, saying what would let someone decide it. Approvers
   * a product named are its own word on who decides, so such a run waits for
   * them however few of them have signed in yet.
   */
  private async undecided(run: Waiting, pool: Identity[], first?: string): Promise<{ by: string | null } | { why: string }> {
    if (run.approvers?.length) return { by: null }
    // The one found for the run before is asked first, so a batch finds its decider at the first try for every run but one.
    const people = [...pool].sort((a, b) => Number(b.name === first) - Number(a.name === first))
    for (const person of people) if (!(await this.undecidable(person, await this.deps.seenBy(person), run))) return { by: person.name }
    const action = this.get(run.action)
    const title = action?.title ?? run.action
    const asker = people.find((p) => p.name === run.by)
    const askerWould = !!asker && this.asked(run, asker) && can(asker, 'actions.approve') && !action?.selfApproval && run.heldFor !== 'self'
    const fix = askerWould
      ? `Nobody but you could approve it, and "${title}" never lets the person who asked approve their own run: an admin turns on "the person who asked may approve their own run" (selfApproval) on the action, or gives someone else actions.approve`
      : `Nobody may approve it: an admin gives someone actions.approve, or a rule that lets someone run "${title}" here without approval`
    return { why: `This run would wait for an approval nobody can give. ${fix}` }
  }

  /** Why one identity may not grant the tool tiers a run asks for, or null when it asks none or they hold each. */
  private async lacksTiers(identity: Identity, view: View | undefined, run: Waiting): Promise<string | null> {
    if (!run.tiers.length || identity.admin) return null
    const held = run.entity ? await this.tiersHeld(identity, view, run.entity) : new Set<ToolTier>()
    const lacking = run.tiers.filter((t) => !held.has(t))
    return lacking.length ? `The run asks for the ${lacking.join(' and ')} tool tier${lacking.length > 1 ? 's' : ''}, which only someone who holds ${lacking.length > 1 ? 'them' : 'it'} here grants` : null
  }

  /**
   * The people a rule lets decide a run awaiting approval: who to tell that it
   * waits. An admin's override and `actions.approve` name nobody here, since
   * they would name the same people for every run.
   */
  async deciders(run: ActionRun): Promise<string[]> {
    const action = this.get(run.action)
    if (!action || run.state !== 'awaiting') return []
    const named: string[] = []
    for (const person of this.deps.people()) {
      // Approvers a product named, and the people its route names, decide it whether or not the action lets them run it; otherwise a rule must.
      if (!run.approvers?.length && !run.routeAsks && !(await this.deps.mayRun(person, action))) continue
      if (!(await this.undecidable(person, await this.deps.seenBy(person), run))) named.push(person.name)
    }
    this.deps.log.debug(named.length ? 'run has deciders by rule' : 'no rule names a decider of the run', { run: run.id, action: run.action, deciders: named })
    return named
  }

  /** The runs that have awaited approval for longer than `hours` and whose deciders were never told again. A change set's runs are told again as their set. */
  async overdue(hours: number): Promise<ActionRun[]> {
    const rows = await this.deps.db.query<RunRow>(`SELECT * FROM action_runs WHERE state = 'awaiting' AND reminded_at IS NULL AND change_set IS NULL AND created_at < now() - make_interval(hours => $1) ORDER BY created_at LIMIT 100`, [hours])
    return rows.rows.map(toRun)
  }

  /** Keeps that a run's deciders were told again, so they are told once. */
  async reminded(id: string): Promise<void> {
    await this.deps.db.query('UPDATE action_runs SET reminded_at = now() WHERE id = $1', [id])
  }

  /** Whether one identity may decide a run awaiting approval. */
  async mayDecide(identity: Identity, view: View | undefined, run: ActionRun): Promise<boolean> {
    const why = await this.undecidable(identity, view, run)
    if (run.state === 'awaiting') this.deps.log.debug(why ? 'run not decidable by them' : 'run decidable by them', { run: run.id, action: run.action, by: identity.name, reason: why })
    return !why
  }

  /** The run, when it awaits approval and this identity may decide it, with what their yes counts for. Throws what keeps them from it. */
  private async decidable(id: string, identity: Identity, view: View | undefined, set?: string): Promise<ActionRun & { counts: ApprovalPart[] }> {
    const run = await this.requireRun(id)
    if (run.state !== 'awaiting') throw new ActionError(`Run "${id}" is ${run.state}, not awaiting approval`, 409)
    if (run.changeSet && run.changeSet !== set) throw new ActionError(`Run "${id}" is one of a change set, which is decided as one: ${this.setUrl(run.changeSet)}`, 409)
    const judged = await this.counts(identity, view, run, set)
    if ('why' in judged) {
      this.deps.log.warn('run decision refused', { run: id, action: run.action, by: identity.name, reason: judged.why })
      throw new ActionError(judged.why, 403)
    }
    return { ...run, counts: judged.counts }
  }

  /**
   * `set` is the change set deciding the run as one of its own, when one is.
   * `digest` is the digest of the statement the approver was shown, when the
   * run states a change: an approval binds to it, so one shown another
   * statement is refused. Each yes keeps the digest it was given for, and
   * what it counts for: the action's own approval, what the route asks, or
   * both. The yes that leaves nothing owed starts the run, or, when its route
   * names a start still to come, queues it for then.
   */
  async approve(id: string, identity: Identity, view?: View, note?: string, set?: string, digest?: string): Promise<ActionRun> {
    const run = await this.decidable(id, identity, view, set)
    if (run.statementDigest) {
      if (digest !== undefined && digest !== run.statementDigest) {
        this.deps.log.warn('run approval refused: it was given for another statement', { run: id, action: run.action, by: identity.name, digest, carries: run.statementDigest })
        throw new ActionError(`The statement you approve (${digest}) is not the one this run carries (${run.statementDigest}): a different statement is a different run. Read the run again and decide what it carries`, 409)
      }
      const name = changeInput(this.get(run.action)?.inputs ?? {})
      const held = name ? (run.inputs[name] as ChangeStatement | null) : null
      if (!held || digestOf(held) !== run.statementDigest) {
        this.deps.log.error('run approval refused: the statement it carries no longer has the digest it was asked with', { run: id, action: run.action, by: identity.name })
        throw new ActionError('The statement this run carries is not the one it was asked with, so it cannot be approved', 409)
      }
    } else if (digest !== undefined) this.deps.log.info('approval names a statement, and the run states none: the digest is passed over', { run: id, action: run.action, by: identity.name })
    const said = note?.trim() ? `: ${note.trim()}` : ''
    // Whether the approver asked it themselves: never so of a person deciding what their agent asked, where the hub lets them (ORY-2002).
    const own = this.asked(run, identity)
    const at = new Date()
    const action = this.get(run.action)
    // A run made as a person starts as whoever gives the approval that makes it enough, with their own sign-in: one that carries none leaves it waiting.
    const asThem = !!action && !!madeAsPerson(action)
    const signedIn = askingFor()?.toLowerCase() === identity.name.toLowerCase()
    // What lets the run call as the approver when its turn comes, if it waits behind others of its action: kept from this request alone.
    const grant = action && asThem && signedIn ? await this.holdFor(action, identity.name, id) : null
    // The earliest its route lets it start: a run made enough before then is queued for then, and handed on when it comes.
    const start = run.routed?.route.to === 'people' && run.routed.route.start ? new Date(run.routed.route.start) : null
    const later = start && start.getTime() > at.getTime() ? start : null
    // One approval adds a name, and the one that leaves nothing owed starts the run. Under a lock on the row, so two people approving
    // at once are two names, never the same count twice, and exactly one of them starts it.
    type Owed = Record<ApprovalPart, number>
    type Vote = { gone: string } | { again: Owed } | { adds: Owed } | { unsigned: true } | { names: Approval[]; enough: boolean; left: Owed; counts: ApprovalPart[] }
    const voted = await this.deps.db.tx(async (client): Promise<Vote> => {
      const held = (await client.query<RunRow>('SELECT * FROM action_runs WHERE id = $1 FOR UPDATE', [id])).rows[0]
      if (!held || held.state !== 'awaiting') return { gone: held?.state ?? 'gone' }
      const names = [...(held.approved_by ?? [])]
      const now = toRun(held)
      if (names.some((n) => n.by === identity.name)) return { again: owedOf(now) }
      // What this yes counts for, of what is still owed now that the row is held: another yes may have closed a part since it was judged.
      const before = owedOf(now)
      const counts = run.counts.filter((part) => before[part] > 0)
      if (!counts.length) return { adds: before }
      names.push({ by: identity.name, at: at.toISOString(), ...(held.statement_digest ? { digest: held.statement_digest } : {}), for: counts })
      const left = owedOf({ ...now, approvedBy: names })
      const enough = left.action === 0 && left.route === 0
      if (enough && asThem && !signedIn) return { unsigned: true }
      await client.query(`UPDATE action_runs SET approved_by = $2::jsonb${enough ? `, state = 'queued', decided_by = $3, decided_at = $4, note = $5, behalf_grant = $6, retry_at = $7` : ''} WHERE id = $1`, enough ? [id, JSON.stringify(names), identity.name, at, note?.trim() || null, grant, later] : [id, JSON.stringify(names)])
      // Each yes is its own change.decided event, counted in the order the yeses came, and written with the yes itself.
      if (held.statement_digest) await this.recordDecided(client, run, held.statement_digest, at, names.length, identity.name, 'yes')
      return { names, enough, left, counts }
    })
    if ('gone' in voted) throw new ActionError(`Run "${id}" is ${voted.gone}, not awaiting approval`, 409)
    if ('again' in voted) throw new ActionError(`You already approved it; it waits for ${owedWords(voted.again)}`, 409)
    if ('adds' in voted) throw new ActionError(`Your approval adds nothing it still waits for: it waits for ${owedWords(voted.adds)}`, 409)
    if ('unsigned' in voted) {
      this.deps.log.warn('run approval refused: the run is made as whoever approves it, and the approval carries no sign-in of theirs', { run: id, action: run.action, by: identity.name, signedInAs: askingFor() })
      needsOwnSignIn(identity.name, 'Approving this run')
      throw new ActionError(`This run is made as whoever approves it, from their own signed-in approval, and this approval carries no sign-in of yours: approve it on the run's page, ${this.runUrl(id)}`, 403)
    }
    const need = run.approvalsNeeded ?? 1
    const routeNeed = run.routeAsks?.need ?? 0
    const counted = voted.counts.includes('route') && routeNeed ? (voted.counts.includes('action') && need ? ', for the action and its route' : ', for its route') : ''
    const bound = run.statementDigest ? { digest: run.statementDigest } : {}
    if (!voted.enough) {
      await this.update(id, {}, `approved by ${identity.name}${counted}; ${run.routeAsks ? `waiting for ${owedWords(voted.left)}` : `${voted.names.length} of ${need}, waiting for ${voted.left.action} more`}${said}`)
      await record(this.deps.db, 'action.voted', run.entity, null, identity.name, { action: run.action, run: id, requestedBy: run.by, given: voted.names.length, needed: need, ...(run.routeAsks ? { routeNeeded: routeNeed, for: voted.counts } : {}), ...bound, ...setOf(run) })
      this.deps.log.info('action run approved by one of several', { run: id, action: run.action, by: identity.name, given: voted.names.length, needed: need, routeNeeded: routeNeed, counts: voted.counts })
      return this.requireRun(id)
    }
    const total = need + routeNeed
    const others = voted.names.slice(0, -1).map((n) => n.by)
    await this.update(id, {}, `approved by ${identity.name}${own ? ', who asked for it' : ''}${counted}${others.length ? `; ${voted.names.length} of ${total}, with ${others.join(', ')}` : ''}${run.tiers.length ? `; granted ${run.tiers.join(', ')}` : ''}${asThem ? `; it runs as ${identity.name}, from their own signed-in approval` : ''}${said}`)
    await record(this.deps.db, 'action.approved', run.entity, null, identity.name, { action: run.action, run: id, requestedBy: run.by, ...(run.agent ? { requestedByAgent: run.agent } : {}), selfApproved: own, ...(total > 1 ? { approvedBy: voted.names.map((n) => n.by), needed: need } : {}), ...(run.routeAsks ? { routeNeeded: routeNeed } : {}), ...(run.tiers.length ? { tiers: run.tiers } : {}), ...(asThem ? { runsAs: identity.name } : {}), ...bound, ...setOf(run) })
    this.deps.log.info(own ? 'action run approved by whoever asked for it' : 'action run approved', { run: id, action: run.action, by: identity.name, tiers: run.tiers, needed: need, routeNeeded: routeNeed, runsAs: asThem ? identity.name : null })
    if (later) {
      await this.update(id, {}, `its route lets it start no earlier than ${later.toISOString()}: queued until then`)
      this.deps.log.info('approved run waits for the start its route names', { run: id, action: run.action, start: later.toISOString() })
      return this.requireRun(id)
    }
    await this.dispatch(await this.requireRun(id), await this.scopeOf(await this.requireRun(id)))
    return this.requireRun(id)
  }

  /**
   * The sealed grant a run made as a person keeps from its approver's own
   * signed-in approval, so it still calls as them when its turn comes after
   * the approval has ended. Null when the issuer gives none that lasts: the
   * run then calls as them only while this request is under way.
   */
  private async holdFor(action: Action, person: string, run: string): Promise<string | null> {
    const name = madeAsPerson(action)
    if (!name) return null
    try {
      const held = await this.deps.behalf.hold(name, person)
      if (held) this.deps.log.info('run keeps the right to call as its approver until it starts', { run, action: action.id, runsAs: person, delegate: name })
      else this.deps.log.warn('run keeps no right to call as its approver: the issuer gave no grant that lasts, so it calls as them only while the approval is under way', { run, action: action.id, runsAs: person, delegate: name })
      return held
    } catch (error) {
      if (!(error instanceof BehalfError)) throw error
      this.deps.log.warn('run keeps no right to call as its approver: the issuer refused a grant that lasts', { run, action: action.id, runsAs: person, delegate: name, reason: error.message })
      return null
    }
  }

  /** Takes the grant a run holds off it, as it is handed on: it is used once, and nothing later finds it. */
  private async takeGrant(id: string): Promise<string | null> {
    const taken = await this.deps.db.query<{ behalf_grant: string | null }>(`UPDATE action_runs r SET behalf_grant = NULL FROM (SELECT id, behalf_grant FROM action_runs WHERE id = $1 FOR UPDATE) was WHERE r.id = was.id AND was.behalf_grant IS NOT NULL RETURNING was.behalf_grant`, [id])
    return taken.rows[0]?.behalf_grant ?? null
  }

  async decline(id: string, identity: Identity, reason?: string, view?: View, set?: string): Promise<ActionRun> {
    const run = await this.decidable(id, identity, view, set)
    await this.update(id, { state: 'declined', decided_by: identity.name, decidedAt: new Date(), finishedAt: new Date(), note: reason?.trim() || null }, `declined by ${identity.name}${reason?.trim() ? `: ${reason.trim()}` : ''}`)
    await record(this.deps.db, 'action.declined', run.entity, null, identity.name, { action: run.action, run: id, requestedBy: run.by, reason: reason ?? null, ...setOf(run) })
    if (run.statementDigest) {
      await this.recordDecided(this.deps.db, run, run.statementDigest, new Date(), (run.approvedBy ?? []).length + 1, identity.name, 'no')
      await this.endChange(run, 'declined')
    }
    this.deps.log.info('action run declined', { run: id, action: run.action, by: identity.name })
    return this.requireRun(id)
  }

  /**
   * Sends a run awaiting approval back to whoever asked, with a note that
   * says what to change. It ends `returned` and never runs; the asker asks
   * again with a run that `revises` it. Whoever may approve it may send it back.
   */
  async sendBack(id: string, identity: Identity, note: string, view?: View): Promise<ActionRun> {
    const run = await this.decidable(id, identity, view)
    const at = new Date()
    await this.update(id, { state: 'returned', decided_by: identity.name, decidedAt: at, finishedAt: at, note }, `sent back by ${identity.name}: ${note}`)
    await record(this.deps.db, 'action.returned', run.entity, null, identity.name, { action: run.action, run: id, requestedBy: run.by, note, ...setOf(run) })
    await this.endChange(run, 'returned')
    this.deps.log.info('action run sent back', { run: id, action: run.action, by: identity.name })
    return this.requireRun(id)
  }

  // Tools --------------------------------------------------------------------------

  /**
   * The tool tiers one identity holds on an entity: every tier for an admin,
   * `read` for a machine token with `tools.read`, and otherwise the tiers of
   * each action they may ask for there, whether or not their run would wait.
   */
  async tiersHeld(identity: Identity, view: View | undefined, entity: EntityRef): Promise<Set<ToolTier>> {
    if (identity.admin) return new Set(TOOL_TIERS)
    const out = new Set<ToolTier>(identity.kind === 'token' && can(identity, 'tools.read') ? ['read'] : [])
    const id = entityId(entity)
    for (const a of this.cache) {
      const tiers = (a.access?.tiers ?? []).filter((t) => !out.has(t))
      if (tiers.length && (await this.targets(identity, view, a, [entity])).has(id)) for (const t of tiers) out.add(t)
    }
    return out
  }

  /**
   * The tiers a lent call reaches with: those of the action the person asked
   * for, while they may still ask for it on that entity, and those the named
   * run of it was granted, while that run is approved and not yet done. The
   * run is theirs when they asked it, or when the lender asked it as itself
   * for them and may still ask for it there: then its tiers reach them though
   * they may not ask for the action. Never what the person holds through
   * another action: a request stays in its lane.
   */
  private async tiersLent(lent: Lent): Promise<Set<ToolTier>> {
    const out = new Set<ToolTier>()
    const lane = this.get(lent.as.action)
    const id = entityId(lent.as.entity)
    if (!lane || lane.tool) return out
    const run = lent.as.run ? await this.getRun(lent.as.run) : null
    const live = !!run && run.action === lane.id && !!run.entity && entityId(run.entity) === id && (run.state === 'queued' || run.state === 'running')
    // A run the lender asked as itself for this person is theirs while the lender may still ask for it there: its approver granted its tiers to that request.
    const forThem = live && !!run.requestedFor && run.requestedFor.toLowerCase() === lent.person.name.toLowerCase() && run.by === lent.lender.name && (await this.targets(lent.lender, undefined, lane, [lent.as.entity])).has(id)
    const mayAsk = (await this.targets(lent.person, lent.view, lane, [lent.as.entity])).has(id)
    if (mayAsk) for (const t of lane.access?.tiers ?? []) out.add(t)
    if (forThem || (mayAsk && live && run.by === lent.person.name)) for (const t of run!.tiers) out.add(t)
    if (!mayAsk && !forThem) this.deps.log.info('lent call holds no tier: the person may not ask for that action there, and no live run was asked for them', { action: lent.as.action, entity: id, person: lent.person.name })
    else this.deps.log.debug('lent call holds its tiers', { action: lane.id, entity: id, person: lent.person.name, run: lent.as.run ?? null, mayAsk, forThem, tiers: [...out] })
    return out
  }

  /**
   * The tools one caller may call on an entity, or the tools of no entity
   * when none is named. A tool is listed when the caller holds its tier
   * there, the tool's filter takes the entity, and its runner still serves it.
   */
  async tools(identity: Identity, view: View | undefined, entity: EntityRef | null, lent?: Lent): Promise<ToolSummary[]> {
    const who = lent?.person ?? identity
    const seen = lent?.view ?? view
    if (lent && (!entity || entityId(entity) !== entityId(lent.as.entity))) return []
    const held = lent ? await this.tiersLent(lent) : entity ? await this.tiersHeld(who, seen, entity) : this.tiersAnywhere(who)
    const out: ToolSummary[] = []
    for (const a of this.cache) {
      if (!a.tool || !held.has(a.tool.tier)) continue
      const kinds = actionTargets(a)
      if (entity ? !kinds.includes(entity.blueprint) || !(await this.pick(entity, (await this.filtersFor(who, a)).where(entity.blueprint), seen)) : kinds.length > 0) continue
      if (await this.unserved(a)) continue
      out.push({ id: a.id, title: a.title, ...(a.description ? { description: a.description } : {}), tier: a.tool.tier, inputs: a.inputs })
    }
    return out
  }

  /** The tiers an identity holds on no entity at all, for a tool that runs on none: an admin's, and `read` for a machine token with `tools.read`. */
  private tiersAnywhere(identity: Identity): Set<ToolTier> {
    if (identity.admin) return new Set(TOOL_TIERS)
    return new Set<ToolTier>(identity.kind === 'token' && can(identity, 'tools.read') ? ['read'] : [])
  }

  /** Why a tool's runner will not run it now, or null: the runner's rule as it stands, and the entity the tool was declared from as it is now. */
  private async unserved(action: Action): Promise<string | null> {
    if (!action.tool || action.backend.type !== 'runner') return 'it is not a tool'
    const runner = this.deps.sources.get(action.backend.runner)
    if (!runner || runner.class !== 'runner') return `runner "${action.backend.runner}" is gone`
    const refused = notServed(action.tool, runner, action.origin)
    if (refused) return refused
    const on = runner.serves?.on
    const from = action.tool.from ? parseEntityId(action.tool.from) : null
    if (on && !(from && (await this.pick(from, on.where)))) return `runner "${runner.id}" does not serve tools declared from ${action.tool.from}`
    return null
  }

  /**
   * Calls a tool: the door. The caller reaches with the tiers they hold on
   * the entity, or, for a product that works a person's request, with the
   * tiers `lent` carries, as that person. A tool's run is asked for at once
   * and never waits. A lent call that holds `act` may also name a plain
   * action: it is asked for as the person, by the action's own rules, and may
   * wait for approval like any other request of theirs.
   */
  async call(id: string, body: ToolCallRequest, identity: Identity, view: View | undefined, lent?: Lent): Promise<ActionRun> {
    const action = this.require(id)
    const who = lent?.person ?? identity
    const seen = lent?.view ?? view
    const through = lent ? identity.name : undefined
    const refuse = async (reason: string, message: string): Promise<never> => {
      await record(this.deps.db, 'access.refused', body.entity ?? firstTarget(action), null, who.name, { action: id, reason, ...(through ? { via: through } : {}) }, new Date(), 'refused')
      this.deps.log.warn('tool call refused', { action: id, by: who.name, through: through ?? null, entity: body.entity ? entityId(body.entity) : null, reason })
      throw new ActionError(message, 403)
    }
    if (!action.tool) {
      if (!lent) throw new ActionError(`Action "${id}" is not a tool: it is run through /v1/actions/${id}/run`)
      if (!(await this.tiersLent(lent)).has('act')) return refuse('the request holds no act tier', `Action "${id}" changes something, and this request was not granted the act tier`)
      this.deps.log.info('plain action asked for through the door, as the person whose request it is', { action: id, by: who.name, through })
      return this.request(id, { ...(body.entity ? { entity: body.entity } : {}), inputs: body.inputs ?? {} }, who, seen, { via: 'tool', through })
    }
    const tier = action.tool.tier
    const kinds = actionTargets(action)
    if (kinds.length && !body.entity) throw new ActionError(`Tool "${id}" runs on ${kinds.length === 1 ? `a ${kinds[0]}` : `one of ${kinds.join(', ')}`}: say which`)
    if (lent && !(body.entity && entityId(body.entity) === entityId(lent.as.entity))) return refuse('a lent call reaches only the entity its request is on', `Tool "${id}" is called on the entity the request is on, and nowhere else`)
    const held = lent ? await this.tiersLent(lent) : body.entity && kinds.length ? await this.tiersHeld(who, seen, body.entity) : this.tiersAnywhere(who)
    if (!held.has(tier)) return refuse(`no ${tier} tier held`, `Tool "${id}" needs the ${tier} tier${body.entity ? ` on ${entityId(body.entity)}` : ''}, which ${lent ? 'this request was not granted' : 'you do not hold'}`)
    const unserved = await this.unserved(action)
    if (unserved) {
      this.deps.log.warn('tool call refused: its runner does not serve it', { action: id, by: who.name, reason: unserved })
      throw new ActionError(`Tool "${id}" cannot run: ${unserved}`, 409)
    }
    this.deps.log.debug('tool call allowed', { action: id, by: who.name, through: through ?? null, tier, entity: body.entity ? entityId(body.entity) : null })
    return this.ask(action, { ...(body.entity && kinds.length ? { entity: body.entity } : {}), inputs: body.inputs ?? {} }, who, seen, { through, tool: true })
  }

  /** Every action that is a dataset, whoever asks. */
  datasets(): Action[] {
    return this.cache.filter((a) => !!a.dataset && !!a.tool)
  }

  /** The entity a dataset's tool is called on, or null when it runs on none. */
  private datasetEntity(action: Action): EntityRef | null {
    return action.dataset?.entity ? parseEntityId(action.dataset.entity) : null
  }

  /**
   * Whether an identity may read a dataset: an admin, whoever its own access
   * lets in, or whoever holds the read tier on the entity it is called on.
   */
  async mayReadDataset(action: Action, identity: Identity, view: View | undefined): Promise<boolean> {
    if (!action.dataset || !action.tool) return false
    if (identity.admin) return true
    if (action.access && (await this.deps.mayRun(identity, action))) return true
    const entity = this.datasetEntity(action)
    return (entity ? await this.tiersHeld(identity, view, entity) : this.tiersAnywhere(identity)).has('read')
  }

  /**
   * Asks a dataset's tool for its rows, as whoever reads it: a run of theirs
   * in the ledger like any tool call. Refused for whoever may not read it,
   * and when its runner no longer serves it.
   */
  async askDataset(id: string, identity: Identity, view: View | undefined): Promise<ActionRun> {
    const action = this.require(id)
    if (!(await this.mayReadDataset(action, identity, view))) {
      await record(this.deps.db, 'access.refused', this.datasetEntity(action) ?? firstTarget(action), null, identity.name, { action: id, reason: 'the dataset is not open to them' }, new Date(), 'refused')
      this.deps.log.warn('dataset read refused', { action: id, by: identity.name })
      throw new ActionError(`Dataset "${id}" is not open to you`, 403)
    }
    const unserved = await this.unserved(action)
    if (unserved) {
      this.deps.log.warn('dataset read refused: its runner does not serve it', { action: id, by: identity.name, reason: unserved })
      throw new ActionError(`Dataset "${id}" cannot be read: ${unserved}`, 409)
    }
    const entity = this.datasetEntity(action)
    this.deps.log.debug('dataset read allowed', { action: id, by: identity.name })
    return this.ask(action, { ...(entity ? { entity } : {}), inputs: {} }, identity, view, { tool: true })
  }

  /**
   * Waits for a run to end, up to `ms`, and answers it as it stands then. A
   * tool's run no runner took in that time is cancelled: an answer that comes
   * after the caller stopped waiting is one nobody reads.
   */
  async settled(id: string, ms: number, signal?: AbortSignal): Promise<ActionRun> {
    let run = await this.watched(ms, (event) => event.type === 'action_run' && event.id === id, () => this.requireRun(id), (r) => isFinished(r.state) || r.state === 'awaiting', signal)
    if (run.state === 'queued' && this.get(run.action)?.tool) {
      this.deps.log.warn('tool run given up: no runner took it while its caller waited', { run: id, action: run.action, waitedMs: ms })
      await this.cancel(run, 'no runner took it while its caller waited; given up', null)
      run = await this.requireRun(id)
    }
    return run
  }

  /**
   * Looks now, and again after each event that matches, until `done` takes
   * what it saw, `ms` have passed, or `signal` says nobody waits any more.
   * It listens before it looks, so an event between two looks is never lost.
   */
  private async watched<T>(ms: number, match: (event: ServerEvent) => boolean, look: () => Promise<T>, done: (seen: T) => boolean, signal?: AbortSignal): Promise<T> {
    const deadline = Date.now() + ms
    let heard = false
    let wake: (() => void) | null = null
    const off = this.deps.events.subscribe((event) => {
      if (!match(event)) return
      heard = true
      wake?.()
    })
    try {
      for (;;) {
        heard = false
        const seen = await look()
        const left = deadline - Date.now()
        if (done(seen) || left <= 0 || signal?.aborted) return seen
        if (!heard) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(end, left)
            function end(): void {
              clearTimeout(timer)
              signal?.removeEventListener('abort', end)
              resolve()
            }
            wake = end
            signal?.addEventListener('abort', end, { once: true })
          })
          wake = null
        }
      }
    } finally {
      off()
    }
  }

  /** How long the door waits on a call of this action: its runner's own timeout, and never past `max`. */
  waitOf(action: Action, max: number): number {
    return Math.min(action.backend.type === 'runner' ? parseDuration(action.backend.timeout ?? RUNNER_TIMEOUT) : max, max)
  }

  /** What a tool printed, from its run: the lines after its runner's claim, without the hub's own closing line, cut at what one call carries. */
  said(run: ActionRun): { text: string; truncated: boolean } {
    const from = run.log.findLastIndex((l) => l.message.startsWith(CLAIMED))
    const lines = run.log.slice(from + 1, isFinished(run.state) && from >= 0 ? -1 : undefined).map((l) => l.message)
    const text = from < 0 ? '' : lines.join('\n')
    const cut = lines.includes(CUT)
    return text.length > TOOL_TEXT_MAX ? { text: text.slice(0, TOOL_TEXT_MAX), truncated: true } : { text, truncated: cut }
  }

  /**
   * What a backend says about a run. A runner may only speak for the job it claimed.
   *
   * A report is read against what the run holds: the step under way decides which lines start a
   * step, and the outputs it holds decide whether another fits. So the run's row is locked while
   * the report is read and written, and two reports at once land one after the other.
   */
  async report(id: string, report: ActionReport, by: Reporter): Promise<ActionRun> {
    const asked = await this.requireRun(id)
    if (by.kind === 'runner' && asked.claimedBy !== by.source) throw new ActionError(`Run "${id}" was not claimed by runner "${by.source}"`, 403)
    if (by.kind === 'job' && by.run !== id) throw new ActionError(`A run's own credential reports on that run alone, not on "${id}"`, 403)
    // How a job's run ended is read from how its container ended, by the starter that sees it: the job says what it does.
    if (by.kind === 'job' && report.state) throw new ActionError('A job says what it does, never how its run ended: its starter reports that from how the container exits, 0 for succeeded. Leave state out', 400)
    // Only whoever held the work alone can say nobody saw how it ended.
    if (report.state === 'unknown' && !(by.kind === 'runner' && this.stoppable(asked))) throw new ActionError('Only the starter that claimed a job\'s run says its outcome is unknown, when its job is gone: report succeeded or failed', 400)
    if (isFinished(asked.state) && asked.state !== 'unknown') throw new ActionError(`Run "${id}" is already ${asked.state}`, 409)
    if (asked.state === 'unknown' && report.state === 'running') throw new ActionError(`Run "${id}" ended with its outcome unknown: report how it ended, succeeded or failed`, 409)
    if (asked.state === 'awaiting') throw new ActionError(`Run "${id}" is still waiting for approval`, 409)
    // A report that carries nothing says only that the run is alive.
    if (Object.values(report).every((v) => v === undefined)) {
      await this.heard(id)
      return asked
    }
    // Starting takes its own lock on the line the run is in, so it comes before this report's.
    if (report.state === 'running' && asked.state === 'queued') {
      const started = await this.start(asked, null)
      if ('waits' in started) throw new ActionError(`Run "${id}" waits its turn: ${started.waits}`, 409)
      if ('state' in started) throw new ActionError(`Run "${id}" is ${started.state}`, 409)
    }
    const { run, again } = await this.deps.db.tx(async (client) => {
      const held = (await client.query<RunRow>('SELECT * FROM action_runs WHERE id = $1 FOR UPDATE', [id])).rows[0]
      if (!held) throw new ActionError(`Unknown run "${id}"`, 404)
      const run = toRun(held)
      // A run whose outcome the hub does not know is still its backend's to settle.
      if (isFinished(run.state) && run.state !== 'unknown') throw new ActionError(`Run "${id}" is already ${run.state}`, 409)
      const at = new Date()
      // Every report says the run is alive.
      const patch: RunPatch = { heardAt: at }
      if (report.label !== undefined) patch.label = report.label
      if (report.link !== undefined) patch.link = report.link
      if (report.summary !== undefined) patch.summary = report.summary
      if (report.state) {
        patch.state = report.state
        if (!run.startedAt) patch.startedAt = at
        if (isFinished(report.state)) patch.finishedAt = at
      }
      // The outputs the report names itself: null takes one away, anything else is kept.
      const named = Object.entries(report.outputs ?? {})
      const dropped = named.filter(([, value]) => value === null).map(([name]) => name)
      const outputs: Record<string, OutputValue> = {}
      for (const [name, value] of named) if (value !== null) outputs[name] = value
      const names = new Set([...Object.keys(run.outputs), ...run.images, ...Object.keys(outputs)])
      for (const name of dropped) names.delete(name)
      if (names.size > OUTPUTS_MAX) throw new ActionError(`A run holds at most ${OUTPUTS_MAX} outputs, and this report would make it ${names.size}`, 400)
      // The step the report names starts first, then its lines are read in order, each under the step under way.
      const stamp = at.toISOString()
      const steps: RunStep[] = []
      let under = run.steps.at(-1)?.name ?? null
      if (report.step && report.step !== under) {
        under = report.step
        steps.push({ name: under, at: stamp })
      }
      const read = readLines(report.log ?? [], { step: under, held: [...names] }, stamp)
      // What the backend hands back to write on the entity waits on the run until it ends: only the fields the action refreshes.
      const back = heldBack(this.get(run.action), read.refresh)
      for (const message of back.lines) read.log.push({ at: stamp, message })
      if (back.lines.length) this.deps.log.info('run handed back values its action does not refresh', { run: id, action: run.action, dropped: Object.keys(read.refresh).filter((f) => !(f in back.kept)) })
      if (Object.keys(back.kept).length) await client.query(`UPDATE action_runs SET refresh = refresh || $2::jsonb WHERE id = $1`, [id, JSON.stringify(back.kept)])
      // A failed try of an action that retries is tried again in this run, unless the backend called it final.
      const again = report.state === 'failed' ? this.nextTry(run, held.final || read.final) : null
      if (again) {
        delete patch.state
        delete patch.finishedAt
      }
      // A state change and its summary are part of the run's story, so they land in the log as well as on the run.
      // The line for a state is the hub's own, under no step; a summary alone is the backend's word on the step under way.
      // A tool's run holds only so much of what the tool printed: the rest is cut, and the run says so once.
      const log = this.get(run.action)?.tool ? fitting(run.log, read.log) : read.log
      if (again) log.push({ at: stamp, message: again.line(report.summary ?? null) })
      else if (report.state && report.state !== run.state) log.push({ at: stamp, message: report.summary ? `${report.state}: ${report.summary}` : report.state })
      else if (report.summary !== undefined && report.summary !== run.summary) log.push(read.under === null ? { at: stamp, message: report.summary } : { at: stamp, message: report.summary, step: read.under })
      await this.write(client, id, patch, { log, steps: [...steps, ...read.steps], outputs: { ...outputs, ...read.outputs }, dropped: dropped.filter((name) => !(name in read.outputs)) })
      if (again) await this.requeue(client, id, again.at)
      else if (read.final) await client.query('UPDATE action_runs SET final = true WHERE id = $1', [id])
      return { run, again }
    })
    this.deps.events.emit({ type: 'action_run', id })
    if (again) {
      await this.retried(run, again, report.summary ?? null, by.kind === 'runner' ? by.source : null)
      return this.requireRun(id)
    }
    if (report.state && isFinished(report.state)) {
      await this.finished(run, by.kind === 'runner' ? by.source : null, by.kind === 'caller' ? by.name : null, { action: run.action, run: id, state: report.state, summary: report.summary ?? null, ...(report.state === 'unknown' ? { gone: true } : {}) }, report.state === 'failed' ? 'failed' : 'ok')
      this.deps.log.info('action run finished', { run: id, action: run.action, state: report.state, reportedBy: by.kind === 'runner' ? by.source : by.kind === 'job' ? 'its own job' : by.name })
    }
    return this.requireRun(id)
  }

  /**
   * Notes that a run under way was heard from, at most once a minute: a
   * heartbeat changes nothing a reader is shown, so it tells no one.
   */
  private async heard(id: string): Promise<void> {
    await this.deps.db.query(`UPDATE action_runs SET heard_at = now() WHERE id = $1 AND state = 'running' AND (heard_at IS NULL OR heard_at < now() - make_interval(secs => $2))`, [id, HEARD_EVERY_MS / 1000])
  }

  /** The run a job's own credential speaks for, while that run holds it; null for anything else. */
  async runOfToken(token: string): Promise<string | null> {
    if (!token.startsWith(RUN_TOKEN_PREFIX)) return null
    return (await this.deps.db.query<{ id: string }>('SELECT id FROM action_runs WHERE job_token = $1', [hashRunToken(token)])).rows[0]?.id ?? null
  }

  /** Claims as `claimJobs` does, and with nothing to hand over waits up to `ms`, as `claimWithin` does for a runner. */
  async claimJobsWithin(starter: string, ms: number, signal?: AbortSignal, max = CLAIM_MAX): Promise<StarterJob[]> {
    return this.watched(ms, (event) => event.type === 'action_run' || event.type === 'actions', async () => (signal?.aborted ? [] : this.claimJobs(starter, max)), (jobs) => jobs.length > 0, signal)
  }

  /**
   * Hands a starter the queued job runs that name it, `max` at most, each
   * rendered, and marks them running under it, in the order a runner's jobs
   * are claimed. Each is handed the credential made for that run alone, here
   * and never again: the hub keeps its hash. A run handed over has started,
   * so its starter starts its job or says why it could not.
   */
  async claimJobs(starter: string, max = CLAIM_MAX): Promise<StarterJob[]> {
    const mine = new Set(this.cache.filter((a) => a.backend.type === 'job' && a.backend.starter === starter).map((a) => a.id))
    if (!mine.size) return []
    const rows = await this.deps.db.query<RunRow>(`SELECT * FROM action_runs WHERE state = 'queued' AND retry_at IS NULL AND action = ANY($1) ORDER BY ${TURN_ORDER} LIMIT $2`, [[...mine], max * 4])
    const jobs: StarterJob[] = []
    for (const row of rows.rows) {
      if (jobs.length >= max) break
      const run = toRun(row)
      const action = this.get(run.action)
      if (!action || action.backend.type !== 'job') continue
      const backend = action.backend
      let rendered: Pick<StarterJob, 'template' | 'image' | 'command' | 'args' | 'env'>
      try {
        // What the job runs as is read now, as the job starts, from what the hub itself holds of the entity: never from the scope, which is what whoever asked may see.
        const named = await this.templateOf(action, run.entity)
        if ('refused' in named) throw new Error(named.refused)
        const scope = await this.scopeOf(run)
        const argv = (parts: string[] | undefined) => (render(parts ?? [], scope) as unknown[]).flatMap((part) => (Array.isArray(part) ? part.map(asText) : [asText(part)]))
        rendered = { template: named.name, image: asText(render(backend.image, scope)).trim(), command: argv(backend.command), args: argv(backend.args), env: Object.fromEntries(Object.entries(render(backend.env ?? {}, scope) as Record<string, unknown>).map(([k, v]) => [k, asText(v)])) }
        if (!rendered.image) throw new Error('its image renders to nothing')
      } catch (error) {
        await this.update(run.id, { state: 'failed', finishedAt: new Date() }, `cannot render the job: ${error instanceof Error ? error.message : String(error)}`)
        await this.finished(run, null, null, { action: run.action, run: run.id, state: 'failed', reason: 'render' }, 'failed')
        continue
      }
      const started = await this.start(run, starter, false, 'starter')
      if (!('started' in started)) continue
      const token = `${RUN_TOKEN_PREFIX}${randomBytes(24).toString('base64url')}`
      await this.deps.db.query('UPDATE action_runs SET job_token = $2, heard_at = now() WHERE id = $1', [run.id, hashRunToken(token)])
      this.deps.log.info('action job claimed by its starter', { run: run.id, action: action.id, starter, template: rendered.template, image: rendered.image, try: run.attempt })
      jobs.push({ run: run.id, action: action.id, try: run.attempt, ...rendered, token, ceilingMs: jobCeiling(action) })
    }
    return jobs
  }

  /**
   * How the runs a starter claimed stand: every one still running, and each
   * of `seen`, the runs whose jobs it still finds on its platform. A starter
   * keeps no state of its own, so this is how one that restarted learns what
   * it holds: it says a running run is alive while its job is, reports how
   * the job ended, and stops the job of a run that ended without it. A run
   * another source claimed is never answered.
   */
  async heldBy(starter: string, seen: string[]): Promise<StarterRun[]> {
    const rows = await this.deps.db.query<RunRow>(`SELECT * FROM action_runs WHERE claimed_by = $1 AND (state = 'running' OR id = ANY($2)) ORDER BY created_at`, [starter, seen.slice(0, STARTER_SEEN_MAX)])
    return rows.rows.flatMap((row) => {
      const action = this.get(row.action)
      // A run of an action gone since is still its starter's to end; one a runner's own job claimed is not a job's run.
      if (action && action.backend.type !== 'job') return []
      return [{ run: row.id, try: row.attempt ?? 1, state: row.state, startedAt: row.started_at?.toISOString() ?? null, ceilingMs: jobCeiling(action), summary: row.summary }]
    })
  }

  /**
   * Claims as `claim` does, and with nothing to hand over waits up to `ms`
   * for a run to be asked for or approved. A runner that holds this call open
   * starts a job as it is asked for, not on its next pass. Once `signal` says
   * the runner hung up, nothing more is claimed: a job handed to nobody would
   * run nowhere.
   */
  async claimWithin(runner: string, ms: number, signal?: AbortSignal, max = CLAIM_MAX): Promise<RunnerJob[]> {
    return this.watched(ms, (event) => event.type === 'action_run' || event.type === 'actions', async () => (signal?.aborted ? [] : this.claim(runner, max)), (jobs) => jobs.length > 0, signal)
  }

  /**
   * Hands a runner the queued runs that name it, `max` at most, rendered, and
   * marks them running under it: every run asked for alone, oldest first,
   * then the runs of batches, oldest first. A run handed over has started, so
   * a runner asks only for what it has room to run.
   */
  async claim(runner: string, max = CLAIM_MAX): Promise<RunnerJob[]> {
    const mine = new Set(this.cache.filter((a) => a.backend.type === 'runner' && a.backend.runner === runner).map((a) => a.id))
    if (!mine.size) return []
    // A run asked for alone goes before any run of a batch, so one person's thousand never holds up another's one.
    const rows = await this.deps.db.query<RunRow>(`SELECT * FROM action_runs WHERE state = 'queued' AND retry_at IS NULL AND action = ANY($1) ORDER BY ${TURN_ORDER} LIMIT $2`, [[...mine], max * 4])
    const jobs: RunnerJob[] = []
    for (const row of rows.rows) {
      if (jobs.length >= max) break
      const run = toRun(row)
      const action = this.get(run.action)
      if (!action || action.backend.type !== 'runner') continue
      let scope: Scope
      try {
        scope = await this.scopeOf(run)
      } catch (error) {
        await this.update(run.id, { state: 'failed', finishedAt: new Date() }, `cannot render the job: ${error instanceof Error ? error.message : String(error)}`)
        continue
      }
      const command = (render(action.backend.command, scope) as unknown[]).flatMap((part) => (Array.isArray(part) ? part.map(asText) : [asText(part)]))
      const env = Object.fromEntries(Object.entries(render(action.backend.env ?? {}, scope) as Record<string, unknown>).map(([k, v]) => [k, asText(v)]))
      const started = await this.start(run, runner)
      if (!('started' in started)) continue
      this.deps.log.info('action job claimed', { run: run.id, action: action.id, runner })
      jobs.push({ run: run.id, action: action.id, command, env, timeoutMs: parseDuration(action.backend.timeout ?? RUNNER_TIMEOUT) })
    }
    return jobs
  }

  /**
   * How a run of this action is kept. A run lives by being heard from:
   * `silenceMs` is how long it may go unheard from before the hub gives it
   * up, the hub's own time, or a caller backend's `timeout` when it names
   * one. `ceilingMs` is the longest it may run however often it is heard
   * from, or null for none: for a runner's job its own timeout and a little
   * more, because the runner ends it then and one that never says so is
   * gone; for a job's run its ceiling and a little more, the time its
   * starter has to stop the job; for any other the action's `ceiling`.
   */
  private lifeOf(action: Action | undefined): { silenceMs: number; ceilingMs: number | null } {
    const hub = this.deps.timeoutMinutes * 60_000
    const named = action?.ceiling ? parseDuration(action.ceiling) : null
    if (action?.backend.type === 'runner') return { silenceMs: hub, ceilingMs: parseDuration(action.backend.timeout ?? RUNNER_TIMEOUT) + RUNNER_GRACE_MS }
    if (action?.backend.type === 'job') return { silenceMs: hub, ceilingMs: jobCeiling(action) + JOB_GRACE_MS }
    if (action?.backend.type === 'caller' && action.backend.timeout) return { silenceMs: parseDuration(action.backend.timeout), ceilingMs: named }
    return { silenceMs: hub, ceilingMs: named }
  }

  /**
   * Gives up on runs under way that passed their ceiling, or that the hub
   * has not heard from for as long as they may be silent: since their last
   * report, or their start when nothing reported. Nothing said how one
   * ended, and it may have done its work, so its outcome is unknown, never a
   * failure.
   */
  async expire(): Promise<number> {
    const cutoff = new Date(Date.now() - this.deps.timeoutMinutes * 60_000)
    const running = await this.deps.db.query<RunRow>(`SELECT * FROM action_runs WHERE state = 'running'`)
    let late = 0
    for (const row of running.rows) {
      const life = this.lifeOf(this.get(row.action))
      const started = (row.started_at ?? row.created_at).getTime()
      const heard = Math.max(started, row.heard_at?.getTime() ?? 0)
      const over = life.ceilingMs !== null && Date.now() - started > life.ceilingMs
      const silent = Date.now() - heard > life.silenceMs
      if (!over && !silent) continue
      late++
      // Past its ceiling is said first: it is so however often the run was heard from.
      const why = over ? `no result after ${spoken(life.ceilingMs!)}; given up` : `not heard from for ${spoken(life.silenceMs)}; given up`
      await this.unknown(toRun(row), why, { timedOut: true, ...(over ? {} : { silent: true }) })
      this.deps.log.warn(over ? 'action run passed its ceiling' : 'action run went silent', { run: row.id, action: row.action, startedAt: row.started_at, heardAt: row.heard_at, ceilingMs: life.ceilingMs, silenceMs: life.silenceMs })
    }
    if (!late) this.deps.log.debug('every action run under way is within its ceiling and heard from', { running: running.rows.length })
    // A run waiting for whoever asked to start it, and never started, is given up the same way: nothing will ever pick it up.
    // One waiting its turn behind another of its line is not idle: its time counts from when the line was last free.
    const callers = this.cache.filter((a) => a.backend.type === 'caller').map((a) => a.id)
    // A run its route lets start only later is idle from then, not from its approval.
    const queued = callers.length ? await this.deps.db.query<RunRow>(`SELECT * FROM action_runs WHERE state = 'queued' AND action = ANY($1) AND greatest(coalesce(decided_at, created_at), coalesce((routed->'route'->>'start')::timestamptz, '-infinity')) < $2`, [callers, cutoff]) : { rows: [] }
    let given = 0
    for (const row of queued.rows) {
      const run = toRun(row)
      const freed = await this.lineFreed(run)
      if (freed === 'busy' || (freed && freed > cutoff)) {
        this.deps.log.info('approved run kept: it waits its turn behind others of its action', { run: run.id, action: run.action, lineFreed: freed === 'busy' ? null : freed.toISOString() })
        continue
      }
      this.deps.log.info('approved run given up: nobody started it', { run: run.id, action: run.action, decidedAt: run.decidedAt })
      if (await this.cancel(run, `not started within ${this.deps.timeoutMinutes} minutes of its approval; given up`, null)) given++
    }
    if (!given) this.deps.log.debug('no approved run waits too long for whoever asked to start it')
    return late + given
  }

  /**
   * When a run last had its turn free: `busy` while another of its line runs,
   * or its action has as many in flight as its `concurrency`; else the newest
   * finish among the others that held it back, or null when none has run.
   */
  private async lineFreed(run: ActionRun): Promise<'busy' | Date | null> {
    const action = this.get(run.action)
    if (!action?.serial && !action?.concurrency) return null
    const ends: Date[] = []
    if (action.serial) {
      const others = (await this.inLine(action, run.entity, run.inputs, ['running', 'succeeded', 'failed', 'cancelled'])).filter((r) => r.id !== run.id)
      if (others.some((r) => r.state === 'running')) return 'busy'
      ends.push(...others.flatMap((r) => (r.finishedAt ? [new Date(r.finishedAt)] : [])))
    }
    if (action.concurrency) {
      const held = (await this.deps.db.query<{ flying: number; freed: Date | null }>(`SELECT count(*) FILTER (WHERE state = 'running')::int AS flying, max(finished_at) AS freed FROM action_runs WHERE action = $1 AND id <> $2 AND state IN ('running', 'succeeded', 'failed', 'cancelled', 'unknown')`, [action.id, run.id])).rows[0]
      if (held && held.flying >= action.concurrency) return 'busy'
      if (held?.freed) ends.push(held.freed)
    }
    return ends.length ? new Date(Math.max(...ends.map((d) => d.getTime()))) : null
  }

  /**
   * Looks at the GitHub workflow runs the hub started. A workflow reports into
   * its run itself; one that ended without reporting, such as a job GitHub
   * never started, is finished here with GitHub's conclusion and the reasons
   * its jobs give. One GitHub says is still going is heard from, so it is
   * not given up for silence. A run GitHub cannot be asked about waits for
   * `expire`.
   */
  async watch(): Promise<number> {
    const rows = await this.deps.db.query<RunRow>(`SELECT * FROM action_runs WHERE state = 'running' AND watch_url IS NOT NULL`)
    let finished = 0
    for (const row of rows.rows) {
      const backend = this.get(row.action)?.backend
      if (backend?.type !== 'github_workflow') {
        this.deps.log.debug('action run not watched: its action no longer starts a workflow', { run: row.id, action: row.action })
        continue
      }
      const secret = await this.deps.checks.openSecret(backend.secretRef)
      if (secret === undefined) {
        this.deps.log.warn('action run not watched: secret missing', { run: row.id, action: row.action, secret: backend.secretRef })
        continue
      }
      const headers = { accept: 'application/vnd.github+json', authorization: `Bearer ${secret}`, 'user-agent': 'orrery-actions/1' }
      const gh = await this.github(row.watch_url!, headers, workflowRun, row.id)
      if (!gh) continue
      if (gh.status !== 'completed') {
        // GitHub says the workflow is still going, which is word of the run: it is heard from.
        await this.heard(row.id)
        this.deps.log.debug('workflow run still going', { run: row.id, status: gh.status })
        continue
      }
      const state: ActionRunState = gh.conclusion === 'success' ? 'succeeded' : 'failed'
      const reasons = state === 'failed' ? await this.whyFailed(row.watch_url!, headers, row.id) : []
      // The workflow may have reported while GitHub was asked; its word stands.
      if ((await this.getRun(row.id))?.state !== 'running') {
        this.deps.log.debug('workflow run reported while it was watched', { run: row.id })
        continue
      }
      const ended = `workflow run ended ${gh.conclusion ?? 'with no conclusion'} without reporting`
      // A workflow someone cancelled was stopped on purpose: that is not a failure to try again.
      if (state === 'failed' && (await this.failOrRetry(toRun(row), ended, reasons, gh.conclusion === 'cancelled' || row.final))) {
        finished++
        continue
      }
      await this.update(row.id, { state, finishedAt: new Date() }, ended, ...reasons)
      await this.finished(toRun(row), null, null, { action: row.action, run: row.id, state, conclusion: gh.conclusion, watched: true }, state === 'failed' ? 'failed' : 'ok')
      this.deps.log.warn('action run finished by its workflow run on GitHub', { run: row.id, action: row.action, state, conclusion: gh.conclusion, reasons: reasons.length })
      finished++
    }
    return finished
  }

  /** Why a workflow run's jobs did not succeed: each job's failure annotations, or its conclusion when it has none. */
  private async whyFailed(runUrl: string, headers: Record<string, string>, run: string): Promise<string[]> {
    const jobs = await this.github(`${runUrl}/jobs`, headers, workflowJobs, run)
    const out: string[] = []
    for (const job of jobs?.jobs ?? []) {
      if (job.conclusion === 'success' || job.conclusion === 'skipped') continue
      const notes = (await this.github(`${job.check_run_url}/annotations`, headers, annotations, run)) ?? []
      const failures = notes.filter((n) => n.annotation_level === 'failure').map((n) => `job ${job.name}: ${n.message}`)
      out.push(...(failures.length ? failures : [`job ${job.name} ended ${job.conclusion ?? 'with no conclusion'}`]))
    }
    return [...new Set(out)].slice(0, REASONS)
  }

  /** One read from the GitHub API, or null, logged, when it fails or answers something else. */
  private async github<T>(url: string, headers: Record<string, string>, shape: z.ZodType<T>, run: string): Promise<T | null> {
    try {
      const res = await fetchTimed('github', url, { headers, signal: AbortSignal.timeout(15_000) })
      if (!res.ok) {
        this.deps.log.warn('github read refused', { run, url, status: res.status })
        return null
      }
      const parsed = shape.safeParse(await res.json())
      if (!parsed.success) {
        this.deps.log.warn('github read answered an unexpected shape', { run, url })
        return null
      }
      return parsed.data
    } catch (error) {
      this.deps.log.warn('github could not be reached', { run, url, error: error instanceof Error ? error.message : String(error) })
      return null
    }
  }

  // Inside -------------------------------------------------------------------------

  /**
   * The entity, when it exists and the filter takes it, as `view` sees it:
   * none when its blueprint is hidden from them, and without the fields they
   * may not read, so a payload never carries what the requester cannot see.
   */
  private async pick(ref: EntityRef, where: Filter | undefined, view?: View): Promise<Entity | null> {
    // The entity alone decides: one a rule opens to the reader as its owner is theirs to run on, though the rest of its blueprint is not.
    if (view && !view.seesEntity(ref)) return null
    const only: Filter = { and: [{ field: '$key', op: 'eq', value: ref.key }, ...(where ? [where] : [])] }
    const { entities } = await this.deps.reader.list({ blueprint: ref.blueprint, states: ['active'], includeHidden: true, filter: only, limit: 1, incoming: true })
    const e = entities[0] ?? null
    return e && view ? view.entity(e) : e
  }

  /** `address` is where the person called from, only on a run they asked for themselves: absent, `by.address` reads nothing. */
  private baseScope(action: Action, entity: Entity | null, runId: string, by: string, at: string, address?: string | null): Scope {
    return {
      action: { id: action.id, title: action.title },
      entity: entity ? scopeEntity(entity, this.deps.blueprints.get(entity.blueprint)) : null,
      inputs: {},
      run: { id: runId, url: this.runUrl(runId), at },
      by: { name: by, ...(address ? { address } : {}) },
    }
  }

  /** The scope of a stored run, with its entity inputs resolved again. */
  /**
   * The job template a run of a `job` action on this entity starts from
   * (`jobTemplate`), over the hub's own read of the entity: a field whoever
   * asked may not see still names it. Any other backend names none.
   */
  private async templateOf(action: Action, on: EntityRef | null | undefined): Promise<{ name: string } | { refused: string }> {
    return this.templateOn(action, on && readsEntity(action) ? await this.pick({ blueprint: on.blueprint, key: on.key }, undefined) : null, on)
  }

  /** The same over an entity already read as the hub holds it: `entity` is null when `on` is gone, or the template is a fixed name. */
  private templateOn(action: Action, entity: Entity | null, on: EntityRef | null | undefined): { name: string } | { refused: string } {
    if (action.backend.type !== 'job') return { name: '' }
    if (!readsEntity(action)) return { name: action.backend.template }
    const blueprint = entity && this.deps.blueprints.get(entity.blueprint)
    if (on && !blueprint) return { refused: `${entityId(on)} no longer exists` }
    return jobTemplate(action.backend.template, blueprint ? { blueprint, fields: entity!.fields } : null)
  }

  private async scopeOf(run: ActionRun): Promise<Scope> {
    const action = this.require(run.action)
    const view = await this.deps.viewOf(run.by)
    const entity = run.entity ? await this.pick(run.entity, undefined, view) : null
    if (run.entity && !entity) throw new ActionError(`${entityId(run.entity)} no longer exists`, 409)
    const scope = this.baseScope(action, entity, run.id, run.by, run.createdAt, run.byAddress)
    // The lists kept when the run was asked for, never what the entity holds now: a backend compares them with what is live.
    if (run.current) (scope.run as Record<string, unknown>).current = run.current
    const inputs = scope.inputs as Record<string, unknown>
    for (const [name, value] of Object.entries(run.inputs)) {
      const def = action.inputs[name]
      if (def && INPUT_KINDS[def.type].picks === 'entity' && value !== null) {
        const ids = Array.isArray(value) ? value.map(String) : [String(value)]
        const shaped: Scope[] = []
        for (const id of ids) {
          const ref = parseEntityId(id)
          const e = ref && (await this.pick(ref, undefined, view))
          if (!e) throw new ActionError(`input "${name}": ${id} no longer exists`, 409)
          shaped.push(scopeEntity(e, this.deps.blueprints.get(e.blueprint)))
        }
        inputs[name] = def.many ? shaped : shaped[0]
      } else inputs[name] = value
    }
    return scope
  }

  /** The blueprints an input picks an entity from: its own, or the one the estate says a person is. */
  private picksOf(def: ActionInputDef): string[] {
    return inputPicks(def, this.deps.person())
  }

  /** One input's value, checked against its definition. A `many` input takes a list, each item checked as one value, then counted. */
  private async check(name: string, def: ActionInputDef, value: unknown, scope: Scope, view?: View): Promise<{ stored: unknown; inScope: unknown }> {
    if (!def.many) return this.checkOne(name, def, value, scope, view)
    const items = listOf(value)
    if (!items) throw new ActionError(`Input "${name}": expected a list`, 400, name)
    const stored: unknown[] = []
    const inScope: unknown[] = []
    for (const item of items) {
      const one = await this.checkOne(name, def, item, scope, view)
      stored.push(one.stored)
      inScope.push(one.inScope)
    }
    if (def.required && !stored.length) throw new ActionError(`Input "${name}" is required`, 400, name)
    const count = twiceIn(def, stored) ?? countError(def, stored.length)
    if (count) throw new ActionError(`Input "${name}": ${count}`, 400, name)
    return { stored, inScope }
  }

  /**
   * One value, as its kind checks it: the same check the form made. What a
   * kind needs the hub for comes after it: the values an enum offers are
   * rendered here, and an entity picked must be one the action offers the
   * person who asked.
   */
  private async checkOne(name: string, def: ActionInputDef, value: unknown, scope: Scope, view?: View): Promise<{ stored: unknown; inScope: unknown }> {
    const bad = (why: string) => new ActionError(`Input "${name}": ${why}`, 400, name)
    const kind = INPUT_KINDS[def.type]
    const picks = this.picksOf(def)
    if (kind.person && !picks.length) throw bad('the estate no longer says who a person is, so there is nobody to pick')
    const values = kind.picks === 'values' ? render(def.values, scope) : null
    const checked = kind.check(def, value, { today: new Date().toISOString().slice(0, 10), allowed: Array.isArray(values) ? values.map(String) : [], picks })
    if (!checked.ok) throw bad(checked.error)
    if (kind.picks !== 'entity') {
      if (def.unique && (await this.taken(def.unique, checked.value))) {
        this.deps.log.debug('input refused: an entity already holds the value', { input: name, blueprint: def.unique.blueprint, field: def.unique.field })
        throw bad(def.hint ?? `${def.title ?? name} is already taken`)
      }
      return { stored: checked.value, inScope: checked.value }
    }
    const id = String(checked.value)
    const where = def.where ? (render(def.where, scope) as Filter) : undefined
    const e = await this.pick(parseEntityId(id)!, where, view)
    if (!e) throw bad(`${id} does not exist, or is not one the action offers here`)
    return { stored: e.id, inScope: scopeEntity(e, this.deps.blueprints.get(e.blueprint)) }
  }

  /**
   * Whether an active entity of the blueprint already holds the value in the
   * field: its key, its title, or one of its fields. Text is the same whatever
   * its case. The check is the hub's own, over every entity, whoever asks: a
   * value is taken or it is not, and the answer says no more than that.
   */
  private async taken(unique: InputUnique, value: unknown): Promise<boolean> {
    const field = unique.field === 'key' ? '$key' : unique.field === 'title' ? '$title' : `fields.${unique.field}`
    if (typeof value !== 'string') {
      const { entities } = await this.deps.reader.list({ blueprint: unique.blueprint, states: ['active'], includeHidden: true, filter: { field, op: 'eq', value }, limit: 1 })
      return entities.length > 0
    }
    // The filter language has no test that ignores case, so the order narrows to the text's own spellings and the text is compared here.
    const same: Filter = { and: [{ field, op: 'contains', value }, { field, op: 'gte', value: value.toLowerCase() }, { field, op: 'lte', value: value.toUpperCase() }] }
    const { entities } = await this.deps.reader.list({ blueprint: unique.blueprint, states: ['active'], includeHidden: true, filter: same, limit: SAME_TEXT_MAX })
    const held = (e: Entity): unknown => (unique.field === 'key' ? e.key : unique.field === 'title' ? e.title : e.fields[unique.field])
    return entities.some((e) => typeof held(e) === 'string' && (held(e) as string).toLowerCase() === value.toLowerCase())
  }

  /**
   * Hands a queued run to its backend. A webhook or workflow that refuses it fails the run here; a runner's job, or a job's run, waits to be claimed.
   * A webhook's answer is waited for here for `HOLD_MS` at most: a slower one puts the run in `running` and is waited for
   * behind whatever handed it on, up to the action's timeout, so a batch never holds its calls back behind each other.
   * `tell` takes an answer that is revealed, where the request under way is the one that asked for the run, and waits for it.
   * An action with a `concurrency` takes its turn first: a run with no room stays `queued`, and `pump` hands it on later.
   * `quiet` leaves out the line that says it waits, for the pump, which asks again and again.
   */
  private async dispatch(run: ActionRun, scope: Scope, tell?: (answer: string) => void, quiet = false): Promise<void> {
    const action = this.require(run.action)
    const backend = action.backend
    if (backend.type === 'runner') {
      // A runner waiting for work may claim the run before this line is written; then the line would sit among what the job printed, so it is left out.
      const queued = await this.deps.db.query(`UPDATE action_runs SET log = log || $2::jsonb WHERE id = $1 AND state = 'queued'`, [run.id, JSON.stringify([{ at: new Date().toISOString(), message: `queued for runner ${backend.runner}` }])])
      if (queued.rowCount) {
        this.deps.events.emit({ type: 'action_run', id: run.id })
        this.deps.log.info('action run queued for runner', { run: run.id, action: action.id, runner: backend.runner })
      } else this.deps.log.info('action run claimed before it was marked queued', { run: run.id, action: action.id, runner: backend.runner })
      return
    }
    if (backend.type === 'job') {
      // Its starter claims it as it is asked for; nothing of whoever asked has to be awake for that.
      const queued = await this.deps.db.query(`UPDATE action_runs SET log = log || $2::jsonb WHERE id = $1 AND state = 'queued'`, [run.id, JSON.stringify([{ at: new Date().toISOString(), message: `queued for starter ${backend.starter}, which starts its job` }])])
      if (queued.rowCount) this.deps.events.emit({ type: 'action_run', id: run.id })
      this.deps.log.info(queued.rowCount ? 'action run queued for its starter' : 'action run claimed before it was marked queued', { run: run.id, action: action.id, starter: backend.starter })
      return
    }
    if (backend.type === 'record') return this.writeRecord(run, backend, scope)
    if (backend.type === 'decide') return this.decideRecord(run, backend, scope)
    if (backend.type === 'schedule') return this.controlSchedule(run, backend)
    if (backend.type === 'report') return this.carryReport(run, backend)
    if (backend.type === 'caller') {
      await this.update(run.id, {}, `waiting for ${run.by} to start it`)
      this.deps.log.info('action run waits for whoever asked to start it', { run: run.id, action: action.id, by: run.by })
      return
    }
    if (backend.type === 'webhook' && backend.finish === 'reveal' && !tell) {
      // Nobody is waiting on this hand-off to be given the answer, so the backend is not asked for it.
      await this.update(run.id, { state: 'failed', finishedAt: new Date() }, `its answer is given only to ${run.by}, on the request that asks for the run: not later, and not as one of many`)
      await this.finished(run, null, null, { action: action.id, run: run.id, state: 'failed', reason: 'nobody to reveal to' }, 'failed')
      this.deps.log.warn('action run failed: its answer is revealed, and no request waits for it', { run: run.id, action: action.id, by: run.by })
      return
    }
    if (action.concurrency) {
      const turn = await this.start(run, null, true)
      if ('waits' in turn) {
        if (!quiet) await this.update(run.id, {}, `waits its turn: ${turn.waits}`)
        return
      }
      if ('state' in turn) return void this.deps.log.debug('action run not handed on: another pass started or ended it', { run: run.id, action: action.id, state: turn.state })
    }
    let req: Awaited<ReturnType<Actions['build']>>
    const as = runsAs(run)
    const grant = madeAsPerson(action) ? await this.takeGrant(run.id) : null
    try {
      req = await this.build(backend, scope, as, grant)
    } catch (error) {
      if (!(error instanceof BehalfError)) throw error
      await this.update(run.id, { state: 'failed', finishedAt: new Date() }, error.message)
      await this.finished(run, null, null, { action: action.id, run: run.id, state: 'failed', reason: 'not as the person' }, 'failed')
      this.deps.log.warn('action run failed: the hub could not call as the person it runs as', { run: run.id, action: action.id, by: run.by, runsAs: as, delegate: backend.type === 'webhook' ? backend.onBehalf : undefined, reason: error.message })
      return
    }
    if (!req) {
      await this.update(run.id, { state: 'failed', finishedAt: new Date() }, `secret "${backend.secretRef}" is not set in the hub`)
      await this.finished(run, null, null, { action: action.id, run: run.id, state: 'failed', reason: 'missing secret' }, 'failed')
      this.deps.log.warn('action run failed: secret missing', { run: run.id, action: action.id, secret: backend.secretRef })
      return
    }
    const reveal = backend.type === 'webhook' && backend.finish === 'reveal' ? tell : undefined
    const wait = backend.type === 'github_workflow' ? GITHUB_WAIT_MS : reveal ? Math.min(REVEAL_WAIT_MS, this.waitFor(action)) : this.waitFor(action)
    const sent = new Date()
    const call = this.hand(run, action, backend, req, sent, wait, as, reveal)
    // A revealed answer is the request's to give; any other slow answer carries on behind whatever handed the run on.
    if (reveal) return call
    let timer: NodeJS.Timeout | undefined
    const held = await Promise.race([call.then(() => true), new Promise<false>((done) => (timer = setTimeout(done, HOLD_MS, false)))]).finally(() => clearTimeout(timer))
    if (held) return
    void call.catch((error: unknown) => this.deps.log.error('action run not ended after its backend answered', { run: run.id, action: action.id, error }))
    // A run that took its turn is running already; the line is written on it all the same.
    await this.deps.db.query(`UPDATE action_runs SET state = 'running', started_at = coalesce(started_at, $2), log = log || $3::jsonb WHERE id = $1 AND state IN ('queued', 'running')`, [run.id, sent, JSON.stringify([{ at: new Date().toISOString(), message: `waiting for ${req.what} to answer, for up to ${spoken(wait)}` }])])
    this.deps.events.emit({ type: 'action_run', id: run.id })
    this.deps.log.info('action run waits for its backend to answer, behind whatever handed it on', { run: run.id, action: action.id, backend: backend.type, waitMs: wait })
  }

  /** How long the hub waits for a webhook of this action to answer: its `timeout`, never past how long a run may go unheard from, or its ceiling. */
  private waitFor(action: Action): number {
    const named = action.backend.type === 'webhook' && action.backend.timeout ? parseDuration(action.backend.timeout) : parseDuration(WEBHOOK_TIMEOUT)
    const life = this.lifeOf(action)
    return Math.min(named, life.silenceMs, life.ceilingMs ?? Infinity)
  }

  /**
   * Calls a run's webhook or workflow and ends the run, or puts it in
   * `running`, by what it answered. A call that gets no answer in `wait`, or
   * whose connection closes after it was sent, may have done its work: the
   * run's outcome is then unknown, and it is never tried again. One that
   * could not be sent at all was not reached.
   */
  private async hand(run: ActionRun, action: Action, backend: Extract<ActionBackend, { type: 'webhook' | 'github_workflow' }>, req: NonNullable<Awaited<ReturnType<Actions['build']>>>, sent: Date, wait: number, as: string, tell?: (answer: string) => void): Promise<void> {
    try {
      const res = await fetchPatient(backend.type === 'github_workflow' ? 'github' : 'webhook', req.url, { method: req.method, headers: req.headers, ...(req.method === 'GET' ? {} : { body: req.body }), signal: AbortSignal.timeout(wait) })
      if (res.status === 504) {
        // Something in front of the backend gave up waiting on it: the backend had the request, and may still have done the work.
        const text = (await res.text().catch(() => '')).slice(0, 200)
        return await this.unknown(run, `${req.what} answered 504${text ? `: ${text}` : ''}: something in front of it stopped waiting`, { status: 504 })
      }
      if (!res.ok) {
        const text = (await res.text().catch(() => '')).slice(0, 200)
        // A server error, a timeout, or a request to slow down passes; any other refusal would only be said again.
        const passing = res.status >= 500 || res.status === 408 || res.status === 429
        if (await this.failOrRetry(run, `${req.what} answered ${res.status}${text ? `: ${text}` : ''}`, [], !passing)) return
        await this.update(run.id, { state: 'failed', finishedAt: new Date() }, `${req.what} answered ${res.status}${text ? `: ${text}` : ''}`)
        await this.finished(run, null, null, { action: action.id, run: run.id, state: 'failed', status: res.status }, 'failed')
        this.deps.log.warn('action run refused by its backend', { run: run.id, action: action.id, backend: backend.type, status: res.status })
        return
      }
      if (backend.type === 'github_workflow') {
        // Asked with return_run_details, GitHub names the run it started, so the hub can watch it.
        const started = res.status === 200 ? dispatched.safeParse(await res.json().catch(() => null)) : null
        if (started?.success) {
          await this.update(run.id, { state: 'running', startedAt: sent, link: started.data.html_url, watch_url: started.data.run_url }, `${req.what} started run ${started.data.workflow_run_id}`)
          this.deps.log.info('action run handed to its backend', { run: run.id, action: action.id, backend: backend.type, status: res.status, workflowRun: started.data.workflow_run_id })
          return
        }
        this.deps.log.warn('github named no workflow run to watch', { run: run.id, action: action.id, status: res.status })
      }
      if (backend.type === 'webhook' && backend.finish === 'reveal' && tell) {
        // The answer is a secret: it goes to whoever asked and into no row, log, event, or notice.
        tell((await res.text().catch(() => '')).trim().slice(0, TOLD_MAX))
        const summary = `${req.what} answered ${res.status}`
        await this.update(run.id, { state: 'succeeded', startedAt: sent, finishedAt: new Date(), summary }, `${summary}; the answer was given to ${run.by} and not kept`)
        await this.finished(run, null, null, { action: action.id, run: run.id, state: 'succeeded', summary })
        this.deps.log.info('action run finished by its backend\'s answer, revealed and not kept', { run: run.id, action: action.id, status: res.status, by: run.by })
        return
      }
      if (backend.type === 'webhook' && backend.finish === 'answer') {
        // The API did the work before it answered and reports nothing after, so its answer ends the run.
        const said = (await res.text().catch(() => '')).trim().slice(0, 200)
        const summary = `${req.what} answered ${res.status}`
        await this.update(run.id, { state: 'succeeded', startedAt: sent, finishedAt: new Date(), summary }, said ? `${summary}: ${said}` : summary)
        await this.finished(run, null, null, { action: action.id, run: run.id, state: 'succeeded', summary })
        this.deps.log.info('action run finished by its backend\'s answer', { run: run.id, action: action.id, status: res.status, asPerson: backend.onBehalf ? as : null, waitedMs: Date.now() - sent.getTime() })
        return
      }
      await this.update(run.id, { state: 'running', startedAt: sent, ...(req.link ? { link: req.link } : {}) }, `${req.what} accepted (${res.status})`)
      this.deps.log.info('action run handed to its backend', { run: run.id, action: action.id, backend: backend.type, status: res.status, asPerson: backend.type === 'webhook' && Boolean(backend.onBehalf) })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      if (mayHaveLanded(error)) {
        const why = error instanceof Error && error.name === 'TimeoutError' ? `${req.what} did not answer within ${spoken(wait)}` : `${req.what} closed the connection before it answered (${causeOf(error) ?? reason})`
        return await this.unknown(run, why, { reason })
      }
      const cause = causeOf(error)
      const said = `${req.what} could not be reached: ${reason}${cause ? ` (${cause})` : ''}`
      if (await this.failOrRetry(run, said, [], false)) return
      await this.update(run.id, { state: 'failed', finishedAt: new Date() }, said)
      await this.finished(run, null, null, { action: action.id, run: run.id, state: 'failed', reason }, 'failed')
      this.deps.log.warn('action run failed: backend unreachable', { run: run.id, action: action.id, backend: backend.type, error: reason, cause })
    }
  }

  /**
   * Ends a run the hub stopped waiting on before it heard how it ended: not
   * as a failure, and never tried again, since it may have done its work.
   * Its backend may still report how it ended.
   */
  private async unknown(run: ActionRun, why: string, detail: Record<string, unknown>): Promise<void> {
    await this.update(run.id, { state: 'unknown', finishedAt: new Date() }, `${why}. It was handed on, so it may have done its work: check before running it again. Its backend may still report how it ended`)
    await this.finished(run, null, null, { action: run.action, run: run.id, state: 'unknown', ...detail })
    this.deps.log.warn('action run outcome unknown: the hub stopped waiting before its backend said how it ended', { run: run.id, action: run.action, why, ...detail })
  }

  /** How the hub changes a report, given once the reports exist: a `report` run asks it. */
  private reports: ReportControl | null = null

  controlsReportsWith(reports: ReportControl): void {
    this.reports = reports
  }

  /**
   * Carries out a `report` run as the person who asked. A change is made
   * before the request answers; a publish or a preview reads data and calls
   * tools, so it runs on behind the answer and writes its steps into the run
   * as it goes. A run that no longer finishes is given up as any other is.
   */
  private async carryReport(run: ActionRun, backend: Extract<ActionBackend, { type: 'report' }>): Promise<void> {
    const fail = async (reason: string) => {
      await this.update(run.id, { state: 'failed', finishedAt: new Date() }, reason)
      await this.finished(run, null, null, { action: run.action, run: run.id, state: 'failed', reason }, 'failed')
      this.deps.log.warn('action run failed: report not changed', { run: run.id, action: run.action, verb: backend.verb, reason })
    }
    const succeed = async (done: ReportDone, started = false) => {
      await this.write(this.deps.db, run.id, { state: 'succeeded', ...(started ? { startedAt: new Date() } : {}), finishedAt: new Date(), summary: done.summary, link: done.link }, { log: [{ at: new Date().toISOString(), message: `succeeded: ${done.summary}` }], outputs: done.outputs ?? {} })
      this.deps.events.emit({ type: 'action_run', id: run.id })
      await this.finished(run, null, null, { action: run.action, run: run.id, state: 'succeeded', summary: done.summary })
      this.deps.log.info('action run carried out a report', { run: run.id, action: run.action, verb: backend.verb, by: run.by })
    }
    const who = this.deps.identityFor(run.by)
    if (!who) return fail(`${run.by} no longer signs in to the hub`)
    if (!this.reports) return fail('the hub keeps no reports here')
    const reports = this.reports
    if (backend.verb !== 'publish' && backend.verb !== 'preview') {
      try {
        return await succeed(await reports.change(backend.verb, run, who), true)
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error))
      }
    }
    await this.update(run.id, { state: 'running', startedAt: new Date() }, backend.verb === 'preview' ? 'drawing a preview' : 'publishing')
    let under: string | null = null
    const pen: RunPen = {
      step: async (name) => {
        under = name
        await this.write(this.deps.db, run.id, {}, { log: [], steps: [{ name, at: new Date().toISOString() }] })
        this.deps.events.emit({ type: 'action_run', id: run.id })
      },
      line: async (message) => {
        await this.write(this.deps.db, run.id, {}, { log: [{ at: new Date().toISOString(), message, ...(under ? { step: under } : {}) }] })
        this.deps.events.emit({ type: 'action_run', id: run.id })
      },
    }
    // Behind the answer: whoever asked watches the run, and it ends however the publish ends.
    void reports
      .publish(run, backend.verb === 'preview', who, pen)
      .then(succeed, (error: unknown) => fail(error instanceof Error ? error.message : String(error)))
      .catch((error: unknown) => this.deps.log.error('report run could not be ended', { run: run.id, error }))
  }

  /** How the hub changes a schedule, given once the schedules exist: a `decide` or `schedule` run on a schedule's record asks it. */
  private schedules: ScheduleControl | null = null

  /** Lets a `decide` action decide the hub's change sets: they are made after the actions. */
  controlsSetsWith(sets: SetControl): void {
    this.sets = sets
  }

  private sets: SetControl | null = null

  controlsSchedulesWith(schedules: ScheduleControl): void {
    this.schedules = schedules
  }

  /**
   * Decides the hub's own run or schedule the run's entity, a record of the
   * approvals blueprint, stands for, as the person who ran the action: the
   * decision is judged as theirs would be on the run or schedule itself, so
   * one they may not decide fails here, saying why.
   */
  private async decideRecord(run: ActionRun, backend: Extract<ActionBackend, { type: 'decide' }>, scope: Scope): Promise<void> {
    const fail = async (reason: string) => {
      await this.update(run.id, { state: 'failed', finishedAt: new Date() }, reason)
      await this.finished(run, null, null, { action: run.action, run: run.id, state: 'failed', reason }, 'failed')
      this.deps.log.warn('action run failed: approval not decided', { run: run.id, action: run.action, reason })
    }
    const target = run.entity ? approvalOf(run.entity.key) : null
    if (!target) return fail('this is not an approval the hub holds: decide it where it came from')
    const who = this.deps.identityFor(run.by)
    if (!who) return fail(`${run.by} no longer signs in to the hub`)
    const note = backend.note ? asText(render(backend.note, scope)) || undefined : undefined
    const approve = backend.verdict === 'approve'
    // A run's record stands for every round of one ask: what is decided is its newest round.
    const decided = target.kind === 'run' ? ((await this.roundsOf(target.id))?.latest.id ?? target.id) : target.id
    try {
      if (target.kind === 'run') {
        const view = await this.deps.seenBy(who)
        if (approve) await this.approve(decided, who, view)
        else await this.decline(decided, who, note, view)
      } else if (target.kind === 'set') {
        if (!this.sets) return fail('the hub decides no change sets here')
        await this.sets.decide(target.id, approve, who, await this.deps.seenBy(who), note)
      } else {
        if (!this.schedules) return fail('the hub decides no schedules here')
        await this.schedules.decide(target.id, approve, who, note)
      }
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error))
    }
    const summary = `${approve ? 'approved' : 'declined'} ${target.kind} ${decided}`
    await this.update(run.id, { state: 'succeeded', startedAt: new Date(), finishedAt: new Date(), summary }, summary)
    await this.finished(run, null, null, { action: run.action, run: run.id, state: 'succeeded', summary })
  }

  /**
   * Pauses, resumes, or fires now the schedule the run's entity, a record of
   * the hub's schedule blueprint, stands for, as the person who ran the
   * action: one they may not change fails here, saying why.
   */
  private async controlSchedule(run: ActionRun, backend: Extract<ActionBackend, { type: 'schedule' }>): Promise<void> {
    const fail = async (reason: string) => {
      await this.update(run.id, { state: 'failed', finishedAt: new Date() }, reason)
      await this.finished(run, null, null, { action: run.action, run: run.id, state: 'failed', reason }, 'failed')
      this.deps.log.warn('action run failed: schedule not changed', { run: run.id, action: run.action, verb: backend.verb, reason })
    }
    if (run.entity?.blueprint !== SCHEDULE_BLUEPRINT) return fail('this is not one of the hub\'s schedules')
    const id = run.entity.key
    const who = this.deps.identityFor(run.by)
    if (!who) return fail(`${run.by} no longer signs in to the hub`)
    if (!this.schedules) return fail('the hub changes no schedules here')
    try {
      if (backend.verb === 'run') await this.schedules.runNow(id, who)
      else await this.schedules.pause(id, backend.verb === 'pause', who)
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error))
    }
    const summary = `${backend.verb === 'run' ? 'fired' : backend.verb === 'pause' ? 'paused' : 'resumed'} schedule ${id}`
    await this.update(run.id, { state: 'succeeded', startedAt: new Date(), finishedAt: new Date(), summary, link: `${this.deps.publicUrl}/actions/schedules/${encodeURIComponent(id)}` }, summary)
    await this.finished(run, null, null, { action: run.action, run: run.id, state: 'succeeded', summary })
    this.deps.log.info('action run changed a schedule', { run: run.id, action: run.action, schedule: id, verb: backend.verb, by: run.by })
  }

  /**
   * Writes the entity a `record` backend names, as its source, and finishes
   * the run. Access is checked again here, with the rules as they are now:
   * an action never writes what access is decided from, whoever owns it.
   */
  private async writeRecord(run: ActionRun, backend: Extract<ActionBackend, { type: 'record' }>, scope: Scope): Promise<void> {
    const fail = async (reason: string) => {
      await this.update(run.id, { state: 'failed', finishedAt: new Date() }, reason)
      await this.finished(run, null, null, { action: run.action, run: run.id, state: 'failed', reason }, 'failed')
      this.deps.log.warn('action run failed: record not written', { run: run.id, action: run.action, blueprint: backend.blueprint, reason })
    }
    const source = this.deps.sources.get(backend.source)
    if (!source) return fail(`source "${backend.source}" no longer exists`)
    const fields = (render(backend.fields ?? {}, scope) ?? {}) as Record<string, unknown>
    const relations = (render(backend.relations ?? {}, scope) ?? {}) as Record<string, string | string[] | null>
    const refused = this.deps.decides(backend.blueprint, [...Object.keys(fields), ...Object.keys(relations)])
    if (refused) return fail(refused)
    const key = asText(render(backend.key, scope))
    const title = backend.title === undefined ? undefined : asText(render(backend.title, scope))
    const result = await this.deps.entities.write({ blueprint: backend.blueprint, key, title, fields, relations }, { source, layer: 'pushed', mode: backend.mode ?? 'upsert', replace: false })
    if (result.outcome === 'rejected') return fail(`${backend.blueprint}:${key} was refused: ${result.errors.map((e) => (e.field ? `${e.field}: ${e.reason}` : e.reason)).join('; ')}`)
    // The write is the source's own, as a pusher's is: it was seen now.
    await this.deps.sources.touch(source.id, { seen: new Date() })
    const summary = `${result.outcome} ${backend.blueprint}:${key}`
    await this.update(run.id, { state: 'succeeded', startedAt: new Date(), finishedAt: new Date(), summary, link: `${this.deps.publicUrl}/entities/${encodeURIComponent(backend.blueprint)}/${encodeURIComponent(key)}` }, summary)
    await this.finished(run, null, null, { action: run.action, run: run.id, state: 'succeeded', summary })
    this.deps.log.info('action run recorded an entity', { run: run.id, action: run.action, blueprint: backend.blueprint, key, outcome: result.outcome, source: source.id })
  }

  /** The request a webhook or workflow backend makes. Null when the secret it names is not in the hub. */
  private async build(backend: Exclude<ActionBackend, { type: 'runner' | 'job' | 'record' | 'caller' | 'decide' | 'schedule' | 'report' }>, scope: Scope, by: string, grant: string | null = null): Promise<{ url: string; method: string; headers: Record<string, string>; body: string; what: string; link?: string } | null> {
    const secret = backend.secretRef ? await this.deps.checks.openSecret(backend.secretRef) : undefined
    if (backend.secretRef && secret === undefined) return null
    const headers: Record<string, string> = { 'content-type': 'application/json', 'user-agent': 'orrery-actions/1' }
    if (secret !== undefined) headers.authorization = `Bearer ${secret}`
    if (backend.type === 'github_workflow') {
      headers.accept = 'application/vnd.github+json'
      const inputs = Object.fromEntries(Object.entries(render(backend.inputs ?? {}, scope) as Record<string, unknown>).map(([k, v]) => [k, asText(v)]))
      const url = `${this.deps.githubApi}/repos/${encodeURIComponent(backend.owner)}/${encodeURIComponent(backend.repo)}/actions/workflows/${encodeURIComponent(backend.workflow)}/dispatches`
      return { url, method: 'POST', headers, body: JSON.stringify({ ref: backend.ref ?? 'main', inputs, return_run_details: true }), what: `workflow ${backend.workflow}`, link: `https://github.com/${backend.owner}/${backend.repo}/actions/workflows/${backend.workflow}` }
    }
    for (const [k, v] of Object.entries(render(backend.headers ?? {}, scope) as Record<string, unknown>)) headers[k.toLowerCase()] = asText(v)
    const url = withQuery(asText(render(backend.url, scope)), render(backend.query ?? {}, scope) as Record<string, unknown>)
    // Asked last, so no rendered header replaces the person's token, and only for the URL the delegate lists.
    if (backend.onBehalf) headers.authorization = `Bearer ${await this.deps.behalf.tokenFor(backend.onBehalf, by, url, grant)}`
    const payload = backend.body === undefined ? { run: scope.run, action: scope.action, entity: scope.entity, inputs: scope.inputs, by: scope.by } : render(backend.body, scope)
    return { url, method: backend.method ?? 'POST', headers, body: JSON.stringify(payload), what: 'webhook' }
  }

  /**
   * How many runs of the action go at once: its runner's width, as the runner
   * last said; every one for a backend handed all at once (a webhook, a
   * workflow, or a job, each its own container); null when that is not known, such as for a runner that has
   * never said, or a caller's runs, which wait for a person.
   */
  widthOf(action: Action): BatchWidth | null {
    const backend = action.backend
    if (backend.type === 'runner') return this.deps.sources.get(backend.runner)?.width ?? null
    if (backend.type === 'webhook' || backend.type === 'github_workflow' || backend.type === 'job') return 'all'
    return null
  }

  /**
   * What each run of a batch costs: the mean time of the action's newest
   * runs that ended with the same inputs, failed ones too, since a batch asks
   * its inputs once and a reboot is no ping; the action's own mean when too
   * few such runs have ended.
   */
  async meanFor(action: Action, inputs: Record<string, unknown>): Promise<number | null> {
    const asked = Object.fromEntries(Object.entries(inputs).filter(([, v]) => v !== null && v !== undefined && v !== ''))
    const rows = await this.deps.db.query<{ mean: number | null; n: number }>(
      `SELECT avg(took) AS mean, count(*)::int AS n FROM (
         SELECT extract(epoch FROM finished_at - started_at)::float8 AS took FROM action_runs
         WHERE action = $1 AND state IN ('succeeded', 'failed') AND started_at IS NOT NULL AND finished_at IS NOT NULL AND inputs @> $2::jsonb
         ORDER BY finished_at DESC LIMIT ${MEAN_RUNS}
       ) newest`,
      [action.id, JSON.stringify(asked)],
    )
    const same = rows.rows[0]
    if (same && same.mean !== null && same.n >= TIMED_ENOUGH) return same.mean
    return (await this.stats(action.id)).get(action.id)?.meanSeconds ?? null
  }

  /**
   * Lets go of what is past keeping: the pictures of runs older than
   * `imageDays`, and runs that ended longer ago than `keepDays`, with the
   * batches none of whose runs are left. A batch of thousands is let go a few
   * thousand rows at a time, so no pass holds the table long.
   */
  async prune(keepDays: number, imageDays: number): Promise<{ images: number; runs: number; batches: number }> {
    const chunk = async (sql: string, params: unknown[]): Promise<number> => {
      let total = 0
      for (;;) {
        const n = (await this.deps.db.query(sql, params)).rowCount ?? 0
        total += n
        if (n < PRUNE_CHUNK) return total
      }
    }
    const images = await chunk(`DELETE FROM action_run_images WHERE ctid IN (SELECT ctid FROM action_run_images WHERE created_at < now() - make_interval(days => $1) LIMIT ${PRUNE_CHUNK})`, [imageDays])
    if (images) await this.deps.db.query(`UPDATE action_runs r SET images = '{}' WHERE cardinality(images) > 0 AND NOT EXISTS (SELECT 1 FROM action_run_images i WHERE i.run = r.id)`, [])
    const runs = await chunk(`DELETE FROM action_runs WHERE id IN (SELECT id FROM action_runs WHERE finished_at IS NOT NULL AND created_at < now() - make_interval(days => $1) LIMIT ${PRUNE_CHUNK})`, [keepDays])
    if (runs) await this.deps.db.query('DELETE FROM action_run_images i WHERE NOT EXISTS (SELECT 1 FROM action_runs r WHERE r.id = i.run)', [])
    const batches = (await this.deps.db.query(`DELETE FROM action_batches b WHERE created_at < now() - make_interval(days => $1) AND NOT EXISTS (SELECT 1 FROM action_runs r WHERE r.batch = b.id)`, [keepDays])).rowCount ?? 0
    // A change set goes with the last of its runs, as a batch does.
    const sets = (await this.deps.db.query(`DELETE FROM change_sets s WHERE created_at < now() - make_interval(days => $1) AND NOT EXISTS (SELECT 1 FROM action_runs r WHERE r.change_set = s.id)`, [keepDays])).rowCount ?? 0
    if (images || runs || batches || sets) this.deps.log.info('action runs let go', { images, runs, batches, sets, keepDays, imageDays })
    else this.deps.log.debug('no action run is past keeping', { keepDays, imageDays })
    return { images, runs, batches }
  }

  /** One picture a run reported, as its data address; null when it has none of that name, or it is past keeping. */
  async image(run: string, name: string): Promise<string | null> {
    return (await this.deps.db.query<{ data: string }>('SELECT data FROM action_run_images WHERE run = $1 AND name = $2', [run, name])).rows[0]?.data ?? null
  }

  /** Each runner's width, as it last said, by runner. */
  runnerWidths(): Map<string, number> {
    const out = new Map<string, number>()
    for (const a of this.cache) if (a.backend.type === 'runner') {
      const width = this.deps.sources.get(a.backend.runner)?.width
      if (width !== undefined) out.set(a.backend.runner, width)
    }
    return out
  }

  /** Each runner now: its runs waiting (a retry still waiting its turn is not), its runs going, and its width. */
  async runnerReadings(): Promise<RunnerReading[]> {
    const runnerOf = new Map(this.cache.flatMap((a) => (a.backend.type === 'runner' ? [[a.id, a.backend.runner] as const] : [])))
    const rows = await this.deps.db.query<{ action: string; state: 'queued' | 'running'; n: number }>(`SELECT action, state, count(*)::int AS n FROM action_runs WHERE state IN ('queued', 'running') AND retry_at IS NULL AND action = ANY($1) GROUP BY action, state`, [[...runnerOf.keys()]])
    const widths = this.runnerWidths()
    const out = new Map<string, RunnerReading>()
    for (const runner of new Set(runnerOf.values())) out.set(runner, { runner, queued: 0, running: 0, width: widths.get(runner) ?? null })
    for (const r of rows.rows) {
      const at = out.get(runnerOf.get(r.action)!)!
      at[r.state] += r.n
    }
    return [...out.values()]
  }

  /** How many queued runs of the runner's actions there are that are not in the batch: the queue a new batch waits behind. */
  async queuedAhead(action: Action, batch: string | null): Promise<number> {
    const backend = action.backend
    if (backend.type !== 'runner') return 0
    const mine = this.cache.filter((a) => a.backend.type === 'runner' && a.backend.runner === backend.runner).map((a) => a.id)
    const rows = await this.deps.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM action_runs WHERE state IN ('queued', 'running') AND action = ANY($1) AND batch IS DISTINCT FROM $2`, [mine, batch])
    return rows.rows[0]?.n ?? 0
  }

  /**
   * When a failed try of a run is tried again, or null when it is not: its
   * action has no retry, its tries are spent, or its failure is final.
   */
  private nextTry(run: ActionRun, final: boolean): NextTry | null {
    const retry = this.get(run.action)?.retry
    if (!retry || final || run.attempt >= retry.tries) return null
    const waitMs = retryWait(parseDuration(retry.backoff), run.attempt)
    const at = new Date(Date.now() + waitMs)
    const tries = retry.tries
    return { at, attempt: run.attempt + 1, waitMs, line: (why) => `try ${run.attempt} of ${tries} failed${why ? `: ${why}` : ''}; trying again in ${Math.round(waitMs / 1000)}s` }
  }

  /** Puts a failed try back in the queue for its next one, due at `at`: the try's runner, start, summary, and outputs are the next try's to set. */
  private async requeue(db: { query: (text: string, params: unknown[]) => Promise<unknown> }, id: string, at: Date): Promise<void> {
    await db.query('DELETE FROM action_run_images WHERE run = $1', [id])
    await db.query(`UPDATE action_runs SET state = 'queued', attempt = attempt + 1, final = false, retry_at = $2, claimed_by = NULL, started_at = NULL, heard_at = NULL, job_token = NULL, summary = NULL, watch_url = NULL, outputs = '{}', images = '{}', refresh = '{}', behalf_grant = NULL WHERE id = $1`, [id, at])
  }

  /** Says a run is tried again: in the activity log and the hub's own log. */
  private async retried(run: ActionRun, again: NextTry, why: string | null, source: string | null): Promise<void> {
    await record(this.deps.db, 'action.retried', run.entity, source, null, { action: run.action, run: run.id, requestedBy: run.by, failed: run.attempt, next: again.attempt, at: again.at.toISOString(), reason: why, ...(run.batch ? { batch: run.batch } : {}), ...setOf(run) })
    this.deps.log.info('action run tried again', { run: run.id, action: run.action, failedTry: run.attempt, nextTry: again.attempt, waitMs: again.waitMs, reason: why })
    this.freed(run.action)
  }

  /**
   * A failure the hub saw itself, such as a backend it could not reach: tried
   * again when the action retries and it is not final, and true when it was.
   * False leaves the run for the caller to fail.
   */
  private async failOrRetry(run: ActionRun, why: string, more: string[], final: boolean): Promise<boolean> {
    const again = this.nextTry(run, final)
    if (!again) return false
    const at = new Date().toISOString()
    await this.write(this.deps.db, run.id, {}, { log: [...[why, ...more].map((message) => ({ at, message })), { at, message: again.line(null) }] })
    await this.requeue(this.deps.db, run.id, again.at)
    this.deps.events.emit({ type: 'action_run', id: run.id })
    await this.retried(run, again, why, null)
    return true
  }

  /**
   * Hands on every run that is due: one whose next try has come, or one
   * approved before the start its route names, once that start has come. A
   * runner's, or a job's, becomes one to claim, and any other backend is
   * handed it. A run cancelled while it waited is not touched. How many it
   * handed on.
   */
  async retryDue(): Promise<number> {
    const due = await this.deps.db.query<RunRow>(`UPDATE action_runs SET retry_at = NULL WHERE state = 'queued' AND retry_at IS NOT NULL AND retry_at <= now() RETURNING *`)
    for (const row of due.rows) {
      const run = toRun(row)
      const action = this.get(run.action)
      this.deps.log.info(run.attempt > 1 ? 'action run next try due' : 'action run due: the start its route names has come', { run: run.id, action: run.action, attempt: run.attempt })
      if (!action || action.backend.type === 'runner' || action.backend.type === 'job') {
        this.deps.events.emit({ type: 'action_run', id: run.id })
        continue
      }
      let scope: Scope
      try {
        scope = await this.scopeOf(run)
      } catch (error) {
        await this.update(run.id, { state: 'failed', finishedAt: new Date() }, `cannot render the next try: ${error instanceof Error ? error.message : String(error)}`)
        await this.finished(run, null, null, { action: run.action, run: run.id, state: 'failed', reason: 'render' }, 'failed')
        continue
      }
      await this.dispatch(run, scope)
    }
    if (!due.rowCount) this.deps.log.debug('no action run is due another try')
    return due.rowCount ?? 0
  }

  /**
   * Writes a run's `action.finished` row. Who asked, the backend, and how long
   * the run took ride along, so the row tells the run's whole story.
   */
  private async finished(run: ActionRun, source: string | null, actor: string | null, detail: Record<string, unknown>, outcome: Outcome = 'ok'): Promise<void> {
    const seconds = Math.round((Date.now() - Date.parse(run.createdAt)) / 1000)
    const action = this.get(run.action)
    const ended = typeof detail.state === 'string' ? detail.state : outcome === 'failed' ? 'failed' : 'succeeded'
    // A run that ended keeps no right to call as anyone.
    await this.deps.db.query('UPDATE action_runs SET behalf_grant = NULL WHERE id = $1 AND behalf_grant IS NOT NULL', [run.id])
    // Nor does its job keep its credential, but for a run the hub only stopped hearing from: that job may be alive, and still says what it does.
    if (ended !== 'unknown' || detail.gone) await this.deps.db.query('UPDATE action_runs SET job_token = NULL WHERE id = $1 AND job_token IS NOT NULL', [run.id])
    await this.settleWriteBack(run.id, action, ended)
    const started = (await this.getRun(run.id))?.startedAt ?? run.startedAt
    recordActionRun({ action: run.action, origin: run.schedule ? 'schedule' : run.batch ? 'batch' : 'alone', outcome: ended, seconds: started ? (Date.now() - Date.parse(started)) / 1000 : null })
    await record(this.deps.db, 'action.finished', run.entity, source, actor, { ...detail, requestedBy: run.by, backend: action?.backend.type ?? null, seconds, ...(action?.tool ? { tool: action.tool.tier } : {}), ...(run.batch ? { batch: run.batch } : {}), ...setOf(run) }, new Date(), outcome)
    await this.endChange(run, ended as ActionRunState)
    this.freed(run.action)
  }

  /** A run of the action left its turn: the next ones are handed on behind whatever ended it. */
  private freed(id: string): void {
    if (!this.get(id)?.concurrency) return
    void this.pump(id).catch((error: unknown) => this.deps.log.error('action runs not handed on after one ended', { action: id, error }))
  }

  /** The actions this hub is handing runs on for, and whether a run ended meanwhile, so the pass looks again. */
  private pumping = new Map<string, boolean>()

  /**
   * Hands on the runs of an action with a `concurrency` that wait their turn,
   * oldest first, while it has room. A runner's job is claimed by its runner,
   * a job's run by its starter, and a caller's started by its caller, so for
   * them this only says a turn came free. Two hubs may pass at once: a start is decided under a lock.
   */
  private async pump(id: string): Promise<void> {
    const action = this.get(id)
    if (!action?.concurrency) return
    if (action.backend.type === 'runner' || action.backend.type === 'caller' || action.backend.type === 'job') return void this.deps.events.emit({ type: 'action_run', id })
    if (this.pumping.has(id)) return void this.pumping.set(id, true)
    this.pumping.set(id, false)
    let handed = 0
    try {
      do {
        this.pumping.set(id, false)
        for (;;) {
          const row = (await this.deps.db.query<RunRow>(`SELECT * FROM action_runs WHERE action = $1 AND state = 'queued' AND retry_at IS NULL ORDER BY ${TURN_ORDER} LIMIT 1`, [id])).rows[0]
          if (!row) break
          const run = toRun(row)
          let scope: Scope
          try {
            scope = await this.scopeOf(run)
          } catch (error) {
            await this.update(run.id, { state: 'failed', finishedAt: new Date() }, `cannot render the run: ${error instanceof Error ? error.message : String(error)}`)
            await this.finished(run, null, null, { action: run.action, run: run.id, state: 'failed', reason: 'render' }, 'failed')
            continue
          }
          await this.dispatch(run, scope, undefined, true)
          // Still queued: there was no room, and the next run that ends hands it on.
          if ((await this.getRun(run.id))?.state === 'queued') break
          handed++
        }
      } while (this.pumping.get(id))
    } finally {
      this.pumping.delete(id)
    }
    if (handed) this.deps.log.info('action runs handed on as earlier ones ended', { action: id, handed })
    else this.deps.log.debug('no action run waiting its turn had room', { action: id })
  }

  /**
   * The backstop for `pump`: every action with a `concurrency` hands on what
   * waits its turn, so a turn is never lost to a hub that stopped while it
   * held one. How many actions it looked at.
   */
  async turns(): Promise<number> {
    const capped = this.cache.filter((a) => a.concurrency && a.backend.type !== 'runner' && a.backend.type !== 'caller' && a.backend.type !== 'job').map((a) => a.id)
    if (!capped.length) return 0
    const waiting = await this.deps.db.query<{ action: string }>(`SELECT DISTINCT action FROM action_runs WHERE state = 'queued' AND retry_at IS NULL AND action = ANY($1)`, [capped])
    for (const { action } of waiting.rows) await this.pump(action)
    return waiting.rows.length
  }

  /**
   * Every run ends here, so what its backend handed back is settled here: written on its entity when it succeeded,
   * let go otherwise. The values are taken off the run in the same statement that reads them, so they are settled once.
   */
  private async settleWriteBack(id: string, action: Action | undefined, ended: string): Promise<void> {
    // A run whose outcome is unknown is still its backend's to settle, and what it handed back waits with it.
    if (ended === 'unknown') return
    const taken = await this.deps.db.query<{ refresh: Record<string, unknown> }>(`UPDATE action_runs r SET refresh = '{}' FROM (SELECT id, refresh FROM action_runs WHERE id = $1 FOR UPDATE) was WHERE r.id = was.id AND was.refresh <> '{}' RETURNING was.refresh`, [id])
    const held = taken.rows[0]?.refresh
    if (!held || !Object.keys(held).length) return
    if (ended !== 'succeeded' || !action) {
      this.deps.log.info('run wrote nothing back: it did not succeed', { run: id, action: action?.id ?? null, state: ended, fields: Object.keys(held) })
      await this.update(id, {}, `nothing written back: the run ${ended === 'succeeded' ? 'has no action' : `ended ${ended}`}`)
      return
    }
    const run = await this.getRun(id)
    if (!run) return
    const done = await writeBack({ db: this.deps.db, blueprints: this.deps.blueprints, reader: this.deps.reader, sources: this.deps.sources, entities: this.deps.entities, decides: this.deps.decides, log: this.deps.log }, run, action, held)
    if (done.wrote.length) await this.deps.db.query('UPDATE action_runs SET wrote_back = $2 WHERE id = $1', [id, JSON.stringify(done.wrote)])
    await this.update(id, {}, ...done.lines)
  }

  // Change events ---------------------------------------------------------------------

  /**
   * Whether a run waits, given what its action and its rules ask (`waits`,
   * `selfHeld`), with the judge's route for an action that opts in to it.
   * The route only adds: a route to people asks its grants beside whoever
   * the action asks, and a route of no one leaves the run as the action
   * left it. A run with no statement, one the judge gave no answer for, or
   * one a fence holds goes to people as `approval: true` sends a run: to
   * someone other than its asker. The fences: a route of no one is refused
   * for a change applied on the machine that asked (`asker`), and for one
   * with a part the writer could not name or an effect the judge holds no
   * proof of (`unknown`); no answer is `judge_down`.
   */
  private async route(action: Action, inputs: Record<string, unknown>, run: string, waits: boolean, selfHeld: boolean): Promise<{ waits: boolean; selfHeld: boolean; needed: number; judged: JudgedRoute | null }> {
    const own = { waits, selfHeld, needed: waits ? needed(action) : 1 }
    if (!action.judge) return { ...own, judged: null }
    const name = changeInput(action.inputs)
    const statement = name ? (inputs[name] as ChangeStatement | null) : null
    const toPeople = (judged: JudgedRoute | null) => ({ waits: true, selfHeld: false, needed: needed(action), judged })
    if (!statement) {
      this.deps.log.info('judged action run states no change: it goes to people', { action: action.id, run })
      return toPeople(null)
    }
    const answer = await this.deps.judge.route(statement, { run, action: action.id })
    if (!answer.ok) {
      this.deps.log.warn('change goes to people: the judge gave no answer', { action: action.id, run, reason: answer.why })
      return toPeople({ answer: null, fences: [{ fence: 'judge_down' }], asks: null, own: waits })
    }
    const routing = answer.routing
    if (routing.route.to === 'people') {
      const asks = { grants: routing.route.grants, need: routing.route.quorum }
      this.deps.log.info(waits ? 'change routed to people beside the action\'s own approval' : 'change routed to people', { action: action.id, run, pack: routing.judge.pack, grants: asks.grants.length, need: asks.need, own: waits })
      return { waits: true, selfHeld, needed: waits ? needed(action) : 0, judged: { answer: routing, fences: [], asks, own: waits } }
    }
    const fences: ChangeReason[] = []
    if (statement.applier === 'asker') fences.push({ fence: 'asker' })
    for (const [part] of (statement.unknown ?? []).entries()) fences.push({ fence: 'unknown', part })
    for (const r of routing.reasons ?? []) if (r.effect !== undefined && r.proof === 'unknown') fences.push({ fence: 'unknown', effect: r.effect, proof: 'unknown' })
    if (fences.length) {
      this.deps.log.info('route of no one refused: a fence sends the change to people', { action: action.id, run, fences: fences.map((f) => f.fence) })
      return toPeople({ answer: routing, fences, asks: null, own: waits })
    }
    this.deps.log.info(waits ? 'change routed to no one: the action\'s own approval still holds it' : 'change routed to no one: it is queued at once', { action: action.id, run, pack: routing.judge.pack })
    return { ...own, judged: { answer: routing, fences: [], asks: null, own: waits } }
  }

  /**
   * The change statement a run is asked with, its digest, and its route as
   * its change.routed event says it, or null when the action has no change
   * input or the run was given none. `waiting` is the run as it waits, or
   * null for one that starts at once; `judged` is how the judge routed it,
   * for an action that opts in to the judge.
   */
  private async statementOf(action: Action, inputs: Record<string, unknown>, waiting: Waiting | null, judged: JudgedRoute | null, set?: string): Promise<Stated | null> {
    const name = changeInput(action.inputs)
    const statement = name ? (inputs[name] as ChangeStatement | null) : null
    if (!statement) return null
    const digest = digestOf(statement)
    // Who the action's own approval waits on; a run only its route holds waits on no one of the action's.
    const own = waiting && (waiting.approvalsNeeded ?? 1) > 0 ? { ...waiting, routeAsks: null } : null
    const waitsOn = own ? await this.waitsOn(own, set) : null
    const named = waitsOn && waitsOn.some((g) => g.values.length) ? waitsOn : null
    if (waitsOn && !named) this.deps.log.warn('change routed to people names nobody: no one may decide its run now', { run: waiting?.id ?? null, action: action.id })
    const routing = routingOf(action.id, this.deps.version, judged, waitsOn ? (named ?? [{ values: [] }]) : null, waiting?.approvalsNeeded ?? 1)
    this.deps.log.info('action run states a change', { action: action.id, run: waiting?.id ?? null, input: name, key: statement.key, digest, route: routing.route.to, judge: routing.judge?.name ?? null })
    return { statement, digest, routing }
  }

  /**
   * Who a run that waits waits on, as Orrery names approvers: the approvers
   * a product named, or each person and token who may decide it now, by
   * their address.
   */
  private async waitsOn(run: Waiting, set?: string): Promise<ChangeGrant[]> {
    if (run.approvers?.length) return run.approvers
    const names: string[] = []
    for (const who of await this.deps.deciding()) if (!(await this.undecidable(who, await this.deps.seenBy(who), run, set))) names.push(who.name)
    this.deps.log.debug(names.length ? 'change routed to the people who may decide its run' : 'change routed to people, and nobody may decide its run now', { run: run.id, action: run.action, deciders: names.length })
    return [{ values: [...new Set(names)] }]
  }

  /** Writes a run's change.stated and change.routed events, with the run's own rows. */
  private async recordStated(client: Recorder, run: { id: string; action: string; entity: EntityRef | null }, stated: Stated, at: Date): Promise<void> {
    const ref = run.entity ? { blueprint: run.entity.blueprint, key: run.entity.key } : null
    await record(client, 'change.stated', ref, null, null, { action: run.action, run: run.id, event: statedEvent(run.id, stated.statement, stated.digest, at) })
    await record(client, 'change.routed', ref, null, null, { action: run.action, run: run.id, event: routedEvent(run, stated.digest, at, stated.routing) })
  }

  private async recordDecided(client: Recorder, run: Pick<ActionRun, 'id' | 'action' | 'entity'>, digest: string, at: Date, n: number, by: string, answer: 'yes' | 'no'): Promise<void> {
    await record(client, 'change.decided', run.entity, null, null, { action: run.action, run: run.id, event: decidedEvent(run.id, digest, at, n, by, answer) })
  }

  /**
   * Writes a run's change.ended event once it reaches a final state, with the
   * applier's check read from what the run reported. It is written once,
   * whatever ends the run: a run whose outcome was not known and is settled
   * later keeps the event it ended with first.
   */
  private async endChange(run: Pick<ActionRun, 'id' | 'action' | 'entity' | 'statementDigest'>, state: ActionRunState, stopped = false): Promise<void> {
    if (!run.statementDigest) return
    const held = await this.deps.db.query<{ statement_digest: string; outputs: Record<string, OutputValue> }>(`UPDATE action_runs SET change_ended_at = now() WHERE id = $1 AND statement_digest IS NOT NULL AND change_ended_at IS NULL RETURNING statement_digest, outputs`, [run.id])
    const row = held.rows[0]
    if (!row) {
      this.deps.log.info('change already ended: its run ended before', { run: run.id, action: run.action, state })
      return
    }
    const { check, differs } = checkOf(row.outputs ?? {})
    const { outcome, reason } = outcomeOf(state, check, stopped)
    if (check === 'differed' && !differs.length) this.deps.log.warn('applier said the statement differed, and named no field that did', { run: run.id, action: run.action })
    this.deps.log.info('change ended', { run: run.id, action: run.action, state, outcome, check, differs })
    await record(this.deps.db, 'change.ended', run.entity, null, null, { action: run.action, run: run.id, state, ...(stopped ? { stopped } : {}), ...(reason ? { reason } : {}), event: endedEvent(run.id, row.statement_digest, new Date(), outcome, check, differs) }, new Date(), outcome === 'ok' ? 'ok' : 'failed')
  }

  /** A change the hub makes to a run itself, with the lines that say so. They are under no step. */
  private async update(id: string, patch: RunPatch, ...lines: string[]): Promise<void> {
    const at = new Date().toISOString()
    await this.write(this.deps.db, id, patch, { log: lines.map((message) => ({ at, message })) })
    this.deps.events.emit({ type: 'action_run', id })
  }

  /** The one statement that changes a run after it is asked for: what is in `patch` replaces, and everything in `add` is added to what the row holds. */
  private async write(db: { query: (text: string, params: unknown[]) => Promise<unknown> }, id: string, patch: RunPatch, add: { log: RunLine[]; steps?: RunStep[]; outputs?: Record<string, OutputValue>; dropped?: string[] }): Promise<void> {
    // A picture is kept apart from the run's outputs, so what lists runs never reads it; the run keeps its name.
    const pictures = Object.entries(add.outputs ?? {}).filter((e): e is [string, string] => typeof e[1] === 'string' && isImageOutput(e[1]))
    const plain = Object.fromEntries(Object.entries(add.outputs ?? {}).filter(([name]) => !pictures.some(([p]) => p === name)))
    // A name set as text drops a picture of that name, and a picture drops text of that name: one value a name.
    const gone = [...(add.dropped ?? []), ...Object.keys(plain)]
    if (pictures.length || gone.length) {
      await db.query('DELETE FROM action_run_images WHERE run = $1 AND name = ANY($2)', [id, gone])
      for (const [name, data] of pictures) await db.query('INSERT INTO action_run_images (run, name, data) VALUES ($1, $2, $3) ON CONFLICT (run, name) DO UPDATE SET data = EXCLUDED.data, created_at = now()', [id, name, data])
      await db.query('UPDATE action_runs SET images = ARRAY(SELECT DISTINCT n FROM unnest(images || $2::text[]) n WHERE NOT (n = ANY($3::text[])) ORDER BY n) WHERE id = $1', [id, pictures.map(([n]) => n), gone.filter((n) => !pictures.some(([p]) => p === n))])
    }
    add = { ...add, outputs: plain, dropped: [...(add.dropped ?? []), ...pictures.map(([n]) => n)] }
    await db.query(
      `UPDATE action_runs SET state = coalesce($2, state), label = coalesce($3, label), link = coalesce($4, link), summary = coalesce($5, summary), claimed_by = coalesce($6, claimed_by), started_at = coalesce($7, started_at), finished_at = coalesce($8, finished_at), decided_by = coalesce($10, decided_by), decided_at = coalesce($11, decided_at), watch_url = coalesce($12, watch_url), log = log || $9::jsonb, steps = steps || $13::jsonb, outputs = (outputs - $15::text[]) || $14::jsonb, note = coalesce($16, note), heard_at = coalesce($17, heard_at) WHERE id = $1`,
      [id, patch.state ?? null, patch.label ?? null, patch.link ?? null, patch.summary ?? null, patch.claimed_by ?? null, patch.startedAt ?? null, patch.finishedAt ?? null, JSON.stringify(add.log), patch.decided_by ?? null, patch.decidedAt ?? null, patch.watch_url ?? null, JSON.stringify(add.steps ?? []), JSON.stringify(add.outputs ?? {}), add.dropped ?? [], patch.note ?? null, patch.heardAt ?? null],
    )
  }
}

/** A run as a reader is shown it: what it wrote back on a field they may not see is left out. */
function withheldBack(run: ActionRun, view: View): ActionRun {
  if (!run.wroteBack || !run.entity) return run
  const hidden = view.hiddenFields(run.entity.blueprint)
  if (!hidden.size) return run
  const { wroteBack, ...rest } = run
  const seen = wroteBack.filter((w) => !hidden.has(w.field))
  return seen.length ? { ...rest, wroteBack: seen } : rest
}

/** What an activity row about a run says of the change set it was asked in: the set is told as one, so its runs' rows name it. */
function setOf(run: Pick<ActionRun, 'changeSet'>): { set?: string } {
  return run.changeSet ? { set: run.changeSet } : {}
}

/** The most rounds one ask is walked through: far past any a person sends back. */
const MAX_ROUNDS = 100

/** The order runs of an action wait their turn in: a run asked for alone before a run of a batch, then oldest first, and the runs of one change set in their place in it. */
const TURN_ORDER = '(batch IS NOT NULL), created_at, set_index NULLS FIRST, id'

/** The values of a serial action's line inputs, as one comparable string. */
function lineOf(serial: string[], inputs: Record<string, unknown>): string {
  return stable(serial.map((name) => inputs[name] ?? null))
}

/** The delegate a run of this action is called through as a person (`onBehalf`), or null when the hub calls as itself. */
export function madeAsPerson(action: Pick<Action, 'backend'>): string | null {
  return action.backend.type === 'webhook' ? (action.backend.onBehalf ?? null) : null
}

/**
 * The person a run of an action made as a person is called as: whoever gave
 * the approval that started it, else whoever asked. Either way it is called
 * only from that person's own signed-in request, or from the grant their own
 * signed-in approval left on the run until it starts (`tokenFor` in
 * behalf.ts), so nothing later (a retry, a schedule) can call as them.
 */
export function runsAs(run: Pick<ActionRun, 'by' | 'decidedBy'>): string {
  return run.decidedBy ?? run.by
}

/** How many people must approve a run of this action before it starts: its quorum, else one. */
export function needed(action: Pick<Action, 'quorum'>): number {
  return action.quorum?.need ?? 1
}

/** How many yeses the action's own approval asks of a run of a change set, which waits for the set's decision whether or not it would wait alone: none for one only its route holds. */
function setNeed(i: Pick<JudgedRun, 'action' | 'waits' | 'needed'>): number {
  return i.waits ? i.needed : needed(i.action)
}

function asText(value: unknown): string {
  if (value === null || value === undefined) return ''
  return typeof value === 'object' ? JSON.stringify(value) : String(value)
}

function toRun(r: RunRow): ActionRun {
  return {
    id: r.id,
    action: r.action,
    entity: r.blueprint && r.key ? { blueprint: r.blueprint, key: r.key } : null,
    inputs: r.inputs,
    by: r.actor,
    state: r.state,
    label: r.label,
    link: r.link,
    summary: r.summary,
    log: r.log,
    steps: r.steps,
    outputs: r.outputs,
    claimedBy: r.claimed_by,
    decidedBy: r.decided_by,
    decidedAt: r.decided_at?.toISOString() ?? null,
    createdAt: r.created_at.toISOString(),
    startedAt: r.started_at?.toISOString() ?? null,
    finishedAt: r.finished_at?.toISOString() ?? null,
    heardAt: r.heard_at?.toISOString() ?? null,
    tiers: r.tiers ?? [],
    revises: r.revises,
    note: r.note,
    approvalsNeeded: r.approvals_needed ?? 1,
    approvedBy: r.approved_by ?? [],
    heldFor: r.held_for ?? null,
    approvers: r.approvers ?? null,
    requestedFor: r.requested_for ?? null,
    agent: r.agent ?? null,
    byAddress: r.by_address ?? null,
    ...(r.current ? { current: r.current } : {}),
    batch: r.batch ?? null,
    changeSet: r.change_set ?? null,
    attempt: r.attempt ?? 1,
    retryAt: r.retry_at?.toISOString() ?? null,
    schedule: r.schedule ?? null,
    images: r.images ?? [],
    ...(r.wrote_back?.length ? { wroteBack: r.wrote_back } : {}),
    ...(r.statement_digest ? { statementDigest: r.statement_digest } : {}),
    ...(r.routed ? { routed: r.routed } : {}),
    routeAsks: r.route_asks ?? null,
  }
}

/**
 * Why a runner will not run a tool, or null: the runner's own rule, set by
 * an admin, against the tool's tier, who defined it, and whether it says
 * where it was declared.
 */
function notServed(tool: ActionTool, runner: Source, origin: ActionOrigin): string | null {
  const serves = runner.serves
  if (!serves) return `runner "${runner.id}" serves no tools`
  if (!serves.tiers.includes(tool.tier)) return `runner "${runner.id}" does not serve the ${tool.tier} tier`
  if (origin.kind === 'source' && !(serves.sources ?? []).includes(origin.source)) return `runner "${runner.id}" takes no tools from source "${origin.source}"`
  if (serves.on && !tool.from) return `runner "${runner.id}" serves tools declared from a ${serves.on.blueprint}, and this one does not say where it was declared`
  if (serves.on && parseEntityId(tool.from!)?.blueprint !== serves.on.blueprint) return `runner "${runner.id}" serves tools declared from a ${serves.on.blueprint}, not from ${tool.from}`
  return null
}

/** The lines of a report a tool's run still has room for, with the line that says the rest was cut. */
function fitting(held: RunLine[], lines: RunLine[]): RunLine[] {
  if (held.some((l) => l.message === CUT)) return []
  let size = held.reduce((n, l) => n + l.message.length, 0)
  const out: RunLine[] = []
  for (const line of lines) {
    if (size + line.message.length > TOOL_OUTPUT_MAX) {
      out.push({ at: line.at, message: CUT })
      break
    }
    size += line.message.length
    out.push(line)
  }
  return out
}

/** A wait in words: "15 minutes", "30 seconds", and past two days, "7 days". */
function spoken(ms: number): string {
  const [n, unit] = ms >= 2 * 86_400_000 ? [Math.round(ms / 86_400_000), 'day'] : ms >= 60_000 ? [Math.round(ms / 60_000), 'minute'] : [Math.round(ms / 1000), 'second']
  return `${n} ${unit}${n === 1 ? '' : 's'}`
}

/** How long a job's run of this action may stay running: its `ceiling`, or `JOB_CEILING`. */
function jobCeiling(action: Pick<Action, 'ceiling'> | undefined): number {
  return parseDuration(action?.ceiling ?? JOB_CEILING)
}

/** What the hub keeps of a run's own credential. */
function hashRunToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** What lies under a failed call: the error the client gave its cause, such as a refused connection. */
function causeOf(error: unknown): string | null {
  const cause = error instanceof Error ? error.cause : null
  if (!(cause instanceof Error)) return null
  const code = 'code' in cause && typeof cause.code === 'string' ? cause.code : null
  return code && !cause.message.includes(code) ? `${code}: ${cause.message}` : cause.message
}

/** The causes that say a call's connection was open, and its request may have gone out, when it ended without an answer. */
const OPEN_THEN_CLOSED = new Set(['UND_ERR_SOCKET', 'ECONNRESET', 'EPIPE', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'])

/** Whether a call that ended without an answer may have reached its backend: it waited out its time, or its connection closed under it. */
function mayHaveLanded(error: unknown): boolean {
  if (error instanceof Error && error.name === 'TimeoutError') return true
  const cause = error instanceof Error ? error.cause : null
  return cause instanceof Error && 'code' in cause && typeof cause.code === 'string' && OPEN_THEN_CLOSED.has(cause.code)
}
