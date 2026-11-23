import type { LayoutColumn } from './columns.ts'
import type { AccessGrant, DatasetColumn, FILTER_OPS, ScorecardOrigin, FieldFormat, FieldType, ActionInputDef, ActionRun, ActionRunState, ActionView, Blueprint, Change, Entity, EntityDetail, EntityRef, EntityState, Filter, Finding, Home, Identity, PersonSetting, PersonShown, Pin, RelationRule, RoleDef, Run, Source, StatusLevel, ToolTier, User } from './model.ts'
import type { CustomIconType } from './icons.ts'
import type { OutputValue } from './run-marks.ts'
import type { BatchEstimate } from './estimate.ts'
import type { Cadence } from './cadence.ts'
import type { DataSet, EditionContent, EditionStat } from './report.ts'
import type { ScheduleTell } from './schedule.ts'
import type { MapHolder, MapView } from './map.ts'
import type { Ground, GroundCover, GroundField, GroundFoundation, GroundGuard, GroundBehind, GroundItem, GroundPeer, GroundPoint } from './ground.ts'

/** `GET /v1/sign-in` on the machine surface: how an app signs a person in to call the hub as them. Ask `issuer` for an access token with `scope`. */
export interface SignInInfo {
  issuer: string
  scope: string
}

/**
 * `GET /.well-known/oauth-protected-resource/mcp` on the machine surface: the agent tools' resource, as an MCP client
 * reads it (RFC 9728). It names the issuer to sign a person in with and the scope to ask for, as `SignInInfo` does.
 */
export interface ProtectedResourceInfo {
  resource: string
  authorization_servers: string[]
  scopes_supported: string[]
  bearer_methods_supported: ['header']
}

/**
 * The views a hub holds back until an admin opens them: each is closed to
 * everyone on a new hub. `garden` is the ground view, with everything that
 * leads to it. `welcome` is the welcome tour and the notes on each new
 * release.
 */
export const PREVIEWS = ['garden', 'welcome'] as const
export type PreviewName = (typeof PREVIEWS)[number]

/**
 * Who a preview is open to: nobody, the people named by the address they
 * sign in with, or everyone. An admin is in it only when named, like anyone
 * else. A machine token and a source are in it only once it is open to
 * everyone; a personal token is the person.
 */
export interface PreviewSetting {
  open: 'nobody' | 'people' | 'everyone'
  people: string[]
}
export type Previews = Record<PreviewName, PreviewSetting>

/** `GET` and `PUT /v1/access/previews`: who each preview is open to. An admin's alone. */
export interface PreviewsResponse {
  previews: Previews
}

/** `GET /v1/map`: the entities a map can be drawn of, each one of a blueprint that names a map and no part of another. Only what the caller sees. */
export interface MapIndexResponse {
  holders: MapIndexHolder[]
  /** Whether the hub knows what is the caller's own: only then does `yours` on a holder mean anything. */
  owned: boolean
  /** The blueprints it was read from: it moves only when one of them, or a title shown beside them, moves. */
  reads: string[]
}

/** A holder on the index, with how much its map holds: the plots and the members that name it or one of its parts, and how their checks stand, as the caller sees them. */
export interface MapIndexHolder extends MapHolder {
  plots: number
  members: number
  /** Every check on its plots and members, and of them those broken and those with no data. */
  checks: number
  failing: number
  unknown: number
  /** Whether the caller owns it, by any path the estate's ownership names. */
  yours: boolean
  /** Whether it is one of the few its estate puts first: the map's `primary` field is true on it, as the caller sees it. */
  primary: boolean
  /** What it is grouped with: the value of the map's `sector` field, or the title of the entity its `sector` relation names, as the caller sees it. Null when the map names none or it holds none. */
  sector: string | null
}

/**
 * One stop on a person's walk through a map: a climb they mean to make on one
 * place, the things it named when they added it, and so how far it has come.
 * `place` is null for what is tied to no place; `scope` keeps it to one garden
 * (`plot:<key>`) or one kind of open ground (`kind:<blueprint>`), or is null
 * for the whole place.
 */
export interface WalkStep {
  id: string
  place: string | null
  ladder: string
  from: number
  scope: string | null
  /** Each thing it names, as `blueprint:key`. */
  things: string[]
  addedAt: string
}

/** `GET /v1/mine/walk/:blueprint/:key`: the caller's walk through one map, oldest stop first. */
export interface WalkResponse {
  steps: WalkStep[]
}

/** `POST /v1/mine/walk/:blueprint/:key`: one stop to add. */
export type WalkStepRequest = Omit<WalkStep, 'id' | 'addedAt'>

/** `GET /v1/map/:blueprint/:key`: one entity's map. */
export interface MapResponse extends MapView {
  blueprint: string
  title: string
  /** The blueprints it was read from: it moves only when one of them, or a title shown beside them, moves. */
  reads: string[]
}

/** `GET /v1/ground`: how much of each blueprint's ground is inside its budgets, by blueprint. Only the blueprints that name a ground and the caller sees. */
export interface GroundIndexResponse {
  grounds: Record<string, GroundCover>
  /** The blueprints it was read from: it moves only when one of them, or a title shown beside them, moves. */
  reads: string[]
}

/** `GET /v1/ground/:blueprint`: one blueprint's ground. `read` is under `total` when the blueprint holds more than a ground reads. */
export interface GroundResponse extends Ground {
  blueprint: string
  title: string
  total: number
  read: number
  /** The action that starts a new entity from a template, when the blueprint names one and the caller may run it. */
  plant: { action: string; title: string } | null
  /** The blueprints it was read from: it moves only when one of them, or a title shown beside them, moves. */
  reads: string[]
}

/** `GET /v1/ground/:blueprint/:key`: one entity of a ground. A `source` the caller may not see is null. */
export interface GroundItemResponse {
  id: string
  blueprint: string
  title: string
  item: GroundItem
  fields: GroundField[]
  foundations: GroundFoundation[]
  guards: GroundGuard[]
  taught: { source: { blueprint: string; key: string; title: string; icon: string | null; level: StatusLevel } | null; peers: GroundPeer[] }[]
  pasts: Record<string, GroundPoint[]>
  ahead: { field: string; title: string; at: string }[]
  /** What each number worked out from related things read, in the order of its measures. A hub one release back sends none. */
  behind?: GroundBehind[]
  /** The blueprints it was read from: it moves only when one of them, or a title shown beside them, moves. */
  reads: string[]
}

export interface WhoAmIResponse {
  identity: Identity
  /** Where the caller is calling from, as the hub reads it through the proxy header it trusts: only for a person signed in in the browser. It fills `by.address` in an action's form. */
  address?: string
  version: string
  /** The address people open the hub's pages on; a page for one thing is `<web>/entities/<blueprint>/<key>`. A hub one release back sends none. */
  web?: string
  /** Whether the hub sends usage telemetry; the web app sends its own only then. */
  telemetry: boolean
  /** The previews open to this caller. A hub one release back sends none. */
  previews?: PreviewName[]
  /** Where a person says how they are told of things: their own page on the desk that delivers the hub's notices. None when the hub names no such desk. */
  notifications?: string
  /** Who a person is in the estate. Only for a person; a hub one release back sends none. */
  person?: MyPerson
}

/** Who a person is in the estate, as they see it. */
export interface MyPerson {
  /** Their own entity, when the estate holds one and they may see it. */
  entity: EntityRef | null
  /** Their entity's title: their name. */
  title: string | null
  /** The picture they show everyone: their pick, else their photo, else their entity's icon. */
  icon: string | null
  /** Their photo, as an icon name, when a source put one. */
  photo: string | null
  /** The icon they picked in its place, when they did. */
  pick: string | null
}

/** The photos a source holds, by the address each person signs in with. */
export interface PicturesResponse {
  pictures: { address: string; sha256: string }[]
}

export interface BlueprintsResponse {
  blueprints: Blueprint[]
  /** Active entities per blueprint id. */
  counts: Record<string, number>
  /** How many active entities each source owns, per blueprint id. None for a blueprint the reader sees only some of one by one. */
  held: Record<string, Record<string, number>>
  layout: CatalogLayout
  /** Blueprints only an admin changes: marked so, or read to decide who sees what. */
  adminOnly: string[]
}

/** How a signed-in person is found in the estate, and which blueprints that makes an admin's alone. */
export interface AccessSettingsResponse {
  person: PersonSetting | null
  adminOnly: string[]
}

/**
 * How the list of blueprints is laid out, shared by everyone. Groups `order`
 * names come first, in its order; the rest follow by name. Groups `closed`
 * names start folded shut: a person opens one for themselves, and it is shut
 * again the next time they come. `blueprints` holds, for a group, the ids
 * that come first inside it, in order; the rest follow by title, so a new
 * blueprint lands at the bottom. Its key for the blueprints with no group is
 * `UNGROUPED`. Blueprints `hidden` names are left out of the catalog's list
 * until a person asks to see them.
 * `source` is set when a git source declares it, and then only git changes it.
 */
export interface CatalogLayout {
  order: string[]
  closed: string[]
  blueprints: Record<string, string[]>
  hidden: string[]
  source?: string
}

/** What a change to the layout carries: each part it names is set, and the rest stays. */
export type CatalogLayoutPatch = Partial<Pick<CatalogLayout, 'order' | 'closed' | 'blueprints' | 'hidden'>>

/** The key `CatalogLayout.blueprints` keeps the order of the blueprints with no group under. */
export const UNGROUPED = ''

export interface UsersResponse {
  users: User[]
  /** The person entity each user is, by lowercase address, under its title and picture: only those the reader may see. A hub one release back sends none. */
  people?: Record<string, PersonShown>
}

export interface RolesResponse {
  roles: RoleDef[]
}

/**
 * How many links of each relation pointing at an entity its page is sent:
 * `incomingCount` says how many there are, and the page reads the rest a page
 * at a time. A busy entity is pointed at by thousands. The page shows as many
 * of each relation the entity holds itself before it is opened, so every row
 * of links folds the same way.
 */
export const ENTITY_LINKS = 8

export interface EntitiesResponse {
  entities: Entity[]
  total: number
  limit: number
  offset: number
  /** Where the next page starts: pass it as `after`. Null when this page is the last. A cursor reads none of the rows before it, however deep. */
  next: string | null
  /**
   * Asked for with `distribution=true`: how every row that matched, not just this page, shares out each column that holds a few kinds of value. Keyed by grid column id. A column where a row holds more than a hundred values has no entry.
   * It is the slowest part of a grid's answer. `distribution=later` answers with the rows of the same kept list and without it, and `distribution=only` with it and no rows.
   */
  distribution?: Record<string, ColumnDistribution>
  /** Asked for with `group=<column>`: every group among all the rows that matched, in order, where each starts and how many it holds. */
  groups?: GridGroup[]
  /** The blueprints whose change moves this list, beside its own. Null when any change may. Sent with a grid's blocks. */
  reads?: string[] | null
  /** Which state of the hub this answer is a slice of. A block with a different one was cut from a list that has since changed. */
  version?: number
}

/** One group of a grouped grid: its value, the position of its first row among all the rows, and how many rows it holds. */
export interface GridGroup {
  key: string
  start: number
  count: number
}

/** The rows a filter matches, named the way a bulk change or delete reaches them without the grid holding every row. */
export interface EntityQuery {
  blueprint: string
  filter?: Filter
  states?: EntityState[]
  hidden?: boolean
  /** Rows to leave out though they match: unticked after ticking everything. */
  except?: EntityRef[]
}

/** How the rows that matched share out one column's values. */
export interface ColumnDistribution {
  /** The most common values first. `value` null is the rows that have none; `label` is what a person reads. */
  buckets: { value: string | null; label: string; count: number }[]
  /** Rows whose value is not among the buckets. */
  other: number
}

/** What a person changes on an entity. `title` and `icon` travel in `fields`. A null clears what a person set. */
export interface EntityPatch {
  fields?: Record<string, unknown>
  relations?: Record<string, string | string[] | null>
}

/** One edit made to many entities: how many took it, and why each of the rest refused. */
export interface BulkEditResponse {
  changed: number
  refused: (EntityRef & { reason: string })[]
}

export interface RelatedResponse {
  root: EntityRef
  nodes: Entity[]
  edges: { from: EntityRef; to: EntityRef; relation: string; declaredOn: string }[]
}

export interface WallCell {
  entity: EntityRef
  title: string
  level: StatusLevel
  reasons: string[]
}

export interface WallGroup {
  blueprint: string
  title: string
  cells: WallCell[]
}

export interface WallResponse {
  groups: WallGroup[]
  sources: Source[]
}

/** How many of a blueprint's entities are at each status that is not green. */
export interface NotGreenCounts {
  red: number
  amber: number
  grey: number
}

export interface SummaryResponse {
  generatedAt: string
  blueprints: { id: string; title: string; description?: string; active: number; missing: number; notGreen: NotGreenCounts }[]
  /** The first hundred entities that are not green, red first. */
  notGreen: WallCell[]
  staleSources: { id: string; status: StatusLevel; reason: string | null }[]
  findings: Record<string, number>
  alertsFiring: number
  lastChangeAt: string | null
}

/**
 * What is the reader's own, and how much of the estate they see: the page a
 * person lands on speaks from here. `state` says whether the hub knows what is
 * theirs: `unset` when the model does not say what a person owns, `unknown`
 * when the reader is no person the model holds, `known` otherwise.
 */
export interface MineResponse {
  /** True when nothing is withheld from the reader: an admin, or a hub that signs nobody in. */
  seesAll: boolean
  state: 'unset' | 'unknown' | 'known'
  /** The reader's own entity, when the model holds one. */
  person: { entity: EntityRef; title: string } | null
  /** What is theirs and shared with them, worst first, each with how it is theirs: the roles of the paths that reached it, none for a path that names no role. A thing of a kind they may not see is left out. `green=false` leaves out the green ones. */
  things: (WallCell & { as: string[] })[]
  /** How many things are theirs, green ones too, whatever `things` holds. */
  count: number
  /** How many things of each blueprint are theirs, green ones too, how many are not green, and how many each role reaches (absent from a hub one release back). */
  blueprints: Record<string, { count: number; notGreen: NotGreenCounts; as?: Record<string, number> }>
}

/**
 * What the reader could fill in: for each field an edit rule opens to them
 * as an owner, how many of their own entities of a blueprint hold no value
 * of it. Only fields with at least one empty are listed.
 */
export interface MineFillResponse {
  fill: { blueprint: string; field: string; title: string; count: number }[]
}

export interface FindingsResponse {
  findings: Finding[]
}

export interface ChangesResponse {
  changes: Change[]
  /** With `fold=batches`: each batch a row names, as it stands now, by id. */
  batches?: Record<string, ActionBatchSummary>
  nextSince: string | null
  /** Pass as `before` for the next older page. Null when this page was the last. */
  nextBefore: number | null
}

/** What deriving a blueprint's entities cost. */
export interface LoadDeriving {
  blueprint: string
  /** Entities derived. */
  derived: number
  /** Of those, the ones whose stored row changed. */
  changed: number
  /** Readers queued to be derived again because a row of this blueprint changed. */
  cascaded: number
  ms: number
}

/**
 * What working out one relation's links cost: a relation rule (`rule`) or a
 * relation that inherits its target (`inherit`), each time a re-link pass
 * worked it out.
 */
export interface LoadRelinking {
  blueprint: string
  relation: string
  by: 'rule' | 'inherit'
  /** Times it was worked out. */
  passes: number
  /** Entities read to work it out, over every pass: those it links, and those their paths or matches reached. */
  read: number
  /** Links added or dropped. */
  changed: number
  ms: number
}

/** What building the shape of a blueprint's grids cost: the count, the groups, and each column's share. */
export interface LoadGrids {
  blueprint: string
  builds: number
  /** The rows those builds counted, added up. */
  rows: number
  ms: number
  /** Of `ms`, the time spent sharing out the columns under the grid: the spread of values. */
  spreadMs: number
  /** The columns those builds shared out, added up: a chip, an enum, a boolean, a list, a relation, and the hub's own. */
  spreadColumns: number
}

/**
 * How the values of one field a grid may count spread over its
 * blueprint's rows, as last measured: the active and missing rows a grid
 * opens on, the values they hold, how many are different, and how many the
 * widest buckets of a grid's spread hold.
 */
export interface LoadColumn {
  blueprint: string
  field: string
  /** Whether the grid shows it as a chip. Kept for a page one release back; the Load page reads only `spread`. */
  chip: boolean
  /** Whether the grid counts it under it now: the spread of values. */
  spread: boolean
  rows: number
  values: number
  different: number
  /** The values the most common few hold: what a grid's spread draws as its own buckets. */
  top: number
  measuredAt: string
}

/** What a source's writes cost. */
export interface LoadWriting {
  source: string
  batches: number
  /** Entities it sent in full. */
  received: number
  /** Of those, the ones created, updated, or restored. */
  changed: number
  /** Entities it named by a sighting and the hub took as sent again, nothing of them sent or read. */
  sighted: number
  ms: number
}

/** What a caller's API calls cost: a person by their address, a token by its name, `anonymous` for a call nobody signed. */
export interface LoadReading {
  caller: string
  calls: number
  /** Bytes answered, before compression. */
  bytes: number
  ms: number
}

/** What one caller's calls to one route cost: the route as the hub names it, `GET /v1/entities/:blueprint/:key`. */
export interface LoadRoute extends LoadReading {
  route: string
}

/**
 * What a person's stars cost one blueprint's grids, and how many it holds now:
 * `stars` and `people` are what the hub keeps this moment; the rest is the
 * window's. A grid read whose reader starred something there is ordered with
 * their stars first and has its starred rows marked; `ms` is the time of the
 * two lookups that takes, beside what the read costs anyway.
 */
export interface LoadStars {
  blueprint: string
  stars: number
  people: number
  /** Grid reads put in their reader's stars order. */
  reads: number
  /** Rows those reads marked as starred. */
  marked: number
  ms: number
}

/** What one kind of work asked of the database: a task of the hub's by its name, a request by `METHOD /route`, or `other`. */
export interface LoadDatabase {
  work: string
  statements: number
  /** Rows the statements answered with or changed. */
  rows: number
  /** The statements' own time, added up: those sent side by side count each in full. */
  ms: number
}

/** One budget. Past `warn` the hub raises a finding; past `limit` it refuses what would add to it. Either may be left out. */
export interface Budget {
  warn?: number
  limit?: number
}

/**
 * What a budget counts:
 * - `changes`: entities a source changes in an hour. Past the limit its writes are refused until the hour turns.
 * - `calls`: API calls a caller makes in an hour. Past the limit a token is refused until the hour turns; a person never is.
 * - `entities`: entities a blueprint holds. Past the limit new ones are refused.
 * - `reads`: entities one row of a blueprint reads, on average. Nothing is refused for it: both numbers raise a finding.
 */
export const BUDGET_KINDS = ['changes', 'calls', 'entities', 'reads'] as const
export type BudgetKind = (typeof BUDGET_KINDS)[number]

/** The budgets of a hub, each kind by name: a source id, a caller, a blueprint id. `*` is the budget of every name that has none of its own. */
export type Budgets = Record<BudgetKind, Record<string, Budget>>

/** What a source or a caller used: in the hour now running, and in its fullest hour of the window. */
export interface BudgetUse {
  now: number
  peak: number
}

/** What the hub spent in one hour of the window, in milliseconds: deriving, building grid shapes, taking writes, and answering API calls. */
export interface LoadHour {
  /** The hour's start. */
  hour: string
  derive: number
  grids: number
  relink: number
  write: number
  read: number
}

/** `GET /v1/load`: what cost the hub over the last hours, each list with the most time first, beside what it holds now. */
export interface LoadResponse {
  /** The window asked for; it also holds the hour now running. */
  hours: number
  since: string
  /** The derive queue now: how many entities wait, and how long the oldest has. */
  queue: { depth: number; oldestSeconds: number | null }
  /** Each blueprint now: its active and missing entities, and how many entities one of its rows reads on average. */
  blueprints: { id: string; entities: number; reads: number }[]
  deriving: LoadDeriving[]
  grids: LoadGrids[]
  relinking: LoadRelinking[]
  writing: LoadWriting[]
  reading: LoadReading[]
  /** `reading` again, split by the route each call took. */
  routes: LoadRoute[]
  /** What each kind of work asked of the database. Absent from a hub one release back. */
  database?: LoadDatabase[]
  /** What people's stars cost each blueprint's grids, and how many each holds. Absent from a hub one release back. */
  stars?: LoadStars[]
  /** Every hour of the window, oldest first, the hour now running last. */
  hourly: LoadHour[]
  /** How each blueprint's fields a grid may count spread, as last measured. */
  columns: LoadColumn[]
  /** The budgets the hub holds its sources, callers, and blueprints to. */
  budgets: Budgets
  /** What each source changed and each caller asked, by the hour, to read against its budget. */
  use: { changes: Record<string, BudgetUse>; calls: Record<string, BudgetUse> }
  /** How what each blueprint holds moved, day by day, and what its expiry takes ahead. Absent from a hub one release back. */
  held?: LoadHeld
}

/** Days are whole UTC days, numbered from the epoch. */
export interface LoadHeld {
  /** The day now running, the last of every `came` and `left`. */
  today: number
  blueprints: LoadHeldBlueprint[]
}

/**
 * One blueprint's movement, each list a day, oldest first, ending today. The
 * history is only as long as its tombstones are kept, so it is exact: what
 * it held on a day is what it holds now, less what came since, plus what left.
 */
export interface LoadHeldBlueprint {
  id: string
  /** Entities it gained each day. */
  came: number[]
  /** Entities it lost each day. */
  left: number[]
  /** For a blueprint whose entities expire by age: how long they live, and how many it holds now leave on each day ahead, today first. */
  expire?: { afterDays: number; ahead: number[] }
}

export interface SourcesResponse {
  sources: Source[]
}

export interface SourceDetailResponse {
  source: Source
  runs: Run[]
}

/** A source token writes; an access token reads, and acts, as a machine; a personal token acts as the person who made it. */
export type TokenKind = 'source' | 'access' | 'personal'

export interface TokenIssued {
  id: string
  name: string
  kind: TokenKind
  /** Shown once. The hub stores only a hash. */
  token: string
}

export interface TokenSummary {
  id: string
  name: string
  kind: TokenKind
  role: string | null
  source: string | null
  /** The person a personal token belongs to. */
  owner: string | null
  createdAt: string
  lastUsedAt: string | null
}

/**
 * One condition of a grid's filter, as the filter panel keeps it: the value is the text that was typed.
 * A field named `r:<relation>` is a condition on a relation, as the grid names its column: `eq` and `neq`
 * compare the target's key or title with the value, and `exists` asks whether it is set.
 */
export interface GridClause {
  field: string
  op: (typeof FILTER_OPS)[number]
  value: string
  /** The test turned round: the rows it matches are left out. `eq` turns round as `neq`, so it is never set with either. */
  not?: boolean
  /**
   * On a relation (`r:<name>`) alone: the entities it reaches are tested with
   * these conditions, on their own blueprint's fields, and `match` says how
   * many must meet them. Its `op` is then `exists` and its `value` empty.
   */
  where?: GridClause[]
  /** How many of the entities a relation reaches must meet `where`: any of them, all of them (and at least one), or none. Any when left out. */
  match?: RelationMatch
}

/** How many of the entities a relation reaches a condition asks to meet its `where`. */
export const RELATION_MATCHES = ['any', 'all', 'none'] as const
export type RelationMatch = (typeof RELATION_MATCHES)[number]

/** The relation a grid condition reads, or null for a field. */
export function clauseRelation(clause: Pick<GridClause, 'field'>): string | null {
  return clause.field.startsWith('r:') ? clause.field.slice(2) : null
}

/**
 * A grid's own layout. With `arranged: 'standard'` its columns hold only what
 * a person changed by hand on top of the estate's column standard
 * (`src/shared/columns.ts`): a column placed after another, one hidden or
 * shown, a width. Without it, a layout saved before the standard lists every
 * column in the order a person left them.
 */
export interface GridLayout {
  columns: LayoutColumn[]
  arranged?: 'standard'
  /** The conditions the grid opens with, for everyone. What a person changes in their own grid is never kept. */
  filter?: GridClause[]
  /** The order the grid opens with, for everyone: `field` or `-field` as the search sorts. Left out, by title. What a person sorts in their own grid is never kept. */
  sort?: string
}

/** A change to a grid's shared layout: what it does not name stays as it is. */
export type GridLayoutPatch = Partial<GridLayout>

export interface RulesResponse {
  rules: RelationRule[]
}

/**
 * `titled` on an entity event says its title or state moved, so what shows it beside another row moves too.
 * `values` says only its values moved: it was there before, and its relations and state stand as they were.
 */
/** The first message on the event stream: the version of the hub that serves it. */
export interface StreamHello {
  version: string
}

/** `at` is when the hub that emitted it did so, in milliseconds: every hub that hears an event hears the same time. */
export type ServerEvent = { at?: number } & (
  | { type: 'entity'; blueprint: string; key: string; titled?: boolean; values?: boolean }
  | { type: 'estate'; blueprints?: string[] }
  /** Derived rows of these blueprints landed; `titled` names those whose titles or states may have moved, so what shows them beside its rows reads again. */
  | { type: 'derived'; blueprints: string[]; titled: string[] }
  // `offered`: the blueprints a source's offer created or extended, when that is all that changed. An offer carries no access
  // rule and changes nothing that exists, so what anyone was shown stands.
  | { type: 'blueprints'; offered?: string[] } | { type: 'icons' } | { type: 'sources' } | { type: 'access' } | { type: 'actions' } | { type: 'action_run'; id: string } | { type: 'schedules' }
  /** A hub started listening: what it missed before then is older than this, so no tag named before it holds. */
  | { type: 'started' }
)

export type EntityDetailResponse = EntityDetail

/** A custom icon the hub holds. `owner` is the source that put it, `git:<source>` for one a git source loaded, or `ui`. */
export interface CustomIcon {
  name: string
  type: CustomIconType
  sha256: string
  size: number
  owner: string
  updatedAt: string
}

export interface IconsResponse {
  icons: CustomIcon[]
}

// Health checks and runners ---------------------------------------------------

export interface HealthCheck {
  url: string
  method: 'GET' | 'HEAD' | 'POST'
  expectStatus: number | string
  expectBody?: string
  timeoutMs: number
  auth?: { type: 'bearer' | 'basic' | 'header'; secretRef: string; header?: string }
  runners: string[]
  expect: 'reachable' | 'unreachable'
  insecure: boolean
}

export interface CheckResult {
  blueprint: string
  key: string
  field: string
  runner: string
  ok: boolean
  status: number | null
  latencyMs: number | null
  error: string | null
  at: string
}

export interface AssignedCheckView {
  entity: EntityRef
  title: string
  field: string
  check: HealthCheck
  results: CheckResult[]
}

// Alerts ----------------------------------------------------------------------------

export interface Alert {
  fingerprint: string
  source: string
  status: string
  labels: Record<string, string>
  annotations: Record<string, string>
  startsAt: string | null
  endsAt: string | null
  entity: EntityRef | null
  updatedAt: string
  /** Whether it fires on something the reader owns. Left out when the hub does not know what they own. */
  yours?: boolean
}

export interface AlertRule {
  id: string
  blueprint: string
  where: string
  origin: { kind: 'ui' } | { kind: 'git'; source: string; file: string }
}

// Scorecards --------------------------------------------------------------------

export interface ScorecardRule {
  id: string
  title: string
  description?: string
  /** What an entity must match to pass. On a judged rule it is made from `judged`: the entity holds what the judge said. */
  where: Filter
  /**
   * A rule another judge decided: its state on an entity is the entry under
   * `check` (the rule's id when left out) in the entity's `field`, which a
   * `checks` aggregation fills: `pass`, `fail`, or `unknown` when the judge
   * had no data. With no entry, the rule does not apply to the entity.
   */
  judged?: { field: string; check?: string }
  /** What to do when it fails, in one line, for a rule no record explains. */
  fix?: string
}

/**
 * Where a scorecard that copies another judge's verdict finds why an entity
 * falls short: records of `from` that point at the entity, through any
 * relation, each naming in `level` the level it holds the entity below, in
 * `says` what is missing, and in `fix` what to do. `where` keeps the records
 * that feed this scorecard.
 */
export interface ScorecardReasons {
  from: string
  where?: Filter
  level: string
  says: string
  fix?: string
  link?: string
}

export interface ScorecardLevel {
  name: string
  /** The level's rules on a one-blueprint scorecard. Empty on one that names `blueprints`: there each blueprint holds its own. */
  rules: ScorecardRule[]
}

/** One blueprint's part of a scorecard that scores several: its own scope, and its rules by level name. */
export interface ScorecardBlueprintRules {
  where?: Filter
  rules: Record<string, ScorecardRule[]>
  /** Where this blueprint's reasons are, in place of the scorecard's. */
  reasons?: ScorecardReasons
}

/** What a scorecard scores on one blueprint: the scope there, and every level with that blueprint's rules. Made by `partsOf`. */
export interface ScorecardPart {
  blueprint: string
  where?: Filter
  levels: ScorecardLevel[]
  reasons?: ScorecardReasons
}

/**
 * A scorecard scores one blueprint (`blueprint`, with rules on each level)
 * or several (`blueprints`, each with its own rules by level name). The
 * levels, and so what a level name means, are the same on every blueprint.
 */
export interface Scorecard {
  id: string
  blueprint?: string
  blueprints?: Record<string, ScorecardBlueprintRules>
  title: string
  description?: string
  /** Which entities it scores. Left out, every one. An entity outside it has no level and is counted nowhere. With `blueprints`, it holds on every blueprint, together with each one's own. */
  where?: Filter
  levels: ScorecardLevel[]
  /** Where the records are that say why an entity falls short of a level. */
  reasons?: ScorecardReasons
  origin: ScorecardOrigin
  updatedAt: string
}

export interface ScorecardRow {
  entity: EntityRef
  title: string
  level: number
  levelName: string
  /** Each rule that applies to it: passed, failed, or null when its judge had no data. A rule that does not apply is left out. */
  rules: Record<string, boolean | null>
  /** Whether the reader owns it. Left out when the hub does not know what they own. */
  yours?: boolean
}

export interface ScorecardResults {
  scorecard: Scorecard
  /** One per entity in scope. */
  rows: ScorecardRow[]
  /** Entities in scope at each level, `none` first. */
  counts: number[]
  /** Entities of the blueprint the scope leaves out: not scored, and in no count. */
  outOfScope: number
}

export interface ScorecardTrend {
  days: string[]
  levels: string[]
  series: Record<string, number[]>
}

export interface EntityScorecard {
  scorecard: string
  title: string
  level: number
  levelName: string
  levels: string[]
}

export interface EntityPageResponse extends EntityDetail {
  /** Whether the reader owns it, by what the model says a person owns. */
  yours: boolean
  /** How the entity is the reader's: the roles of the paths that reached it. Empty when it is not theirs or no path names a role. */
  yoursAs: string[]
  checks: AssignedCheckView[]
  alerts: Alert[]
  scorecards: EntityScorecard[]
}

/** A model the hub carries for import: a starting point an architect brings in and then owns. */
export interface ModelTemplate {
  id: string
  title: string
  description: string
  blueprints: string[]
}

/** What an import did. Nothing that existed was changed: blueprints only gained what they lacked. */
export interface ImportReport {
  blueprints: { created: string[]; extended: string[]; kept: string[] }
  rules: { created: string[]; kept: string[] }
  scorecards: { created: string[]; kept: string[] }
  alertRules: { created: string[]; kept: string[] }
  actions: { created: string[]; kept: string[] }
  entities: { created: number; kept: number }
  errors: string[]
}

/** The shared arrangement of the data model graph. A blueprint without a position is placed automatically. */
export interface ModelLayout {
  positions: Record<string, { x: number; y: number }>
  hidden: string[]
  /** The layout that placed these positions. An older one is laid out again, once, on the next read. */
  generation?: number
}

/** What a reader asks of `POST /v1/model/layout/place`: where their own view would place its cards, saved nowhere. */
export interface ModelPlaceRequest {
  hidden: string[]
  /** Where the reader's cards stand now; each one missing is placed beside its neighbours. Ignored with `rearrange`. */
  positions?: Record<string, { x: number; y: number }>
  /** Lay out what is shown from scratch, then each hidden one beside its neighbours. */
  rearrange?: boolean
}

export interface ModelPlacement {
  positions: Record<string, { x: number; y: number }>
}

// Self-service actions ---------------------------------------------------------

/** The actions a reader may run, and for a holder of `actions.manage` the rest too, each marked `canRun`. */
/** What a portal shows of an action a person may run: enough for a button, never the backend or who else may run it. */
export type ActionSummary = Pick<ActionView, 'id' | 'title' | 'description' | 'icon' | 'iconShown' | 'group' | 'blueprint' | 'approval' | 'lastRun' | 'pinned'> & {
  /** The action's home, as the person sees it: null when it has none or they may not see it. */
  home?: { id: string; title: string } | null
}
export interface ActionSummariesResponse {
  actions: ActionSummary[]
}

/** The records of the estate's approvals blueprint that wait for this person: pending, and naming them among the approvers. */
export interface MyApprovals {
  /** The approvals blueprint, when the hub names one and the person may see it. */
  blueprint: string | null
  waiting: number
}

/** A person's pins, in their order: only those to what they may use today. */
export interface PinsResponse {
  pins: Pin[]
}

/** What a person starred that they may see today, newest first. */
export interface StarsResponse {
  stars: EntityRef[]
}

/** Whether an entity is one of the caller's favorites, after a star or an unstar. */
export interface StarResponse {
  starred: boolean
}

/** The pins to put first, in this order. Those not named keep their order after them. */
export interface PinsOrderRequest {
  order: Pin[]
}

export interface ActionsResponse {
  actions: ActionView[]
  /**
   * The blueprints what the reader owns is read from, when an action asks
   * who owns what: its home, or a rule's `owns`. A change to one may move
   * which homes are theirs and what they may run. Empty when none asks, or
   * the reader is no person.
   */
  reads?: string[]
  /**
   * The blueprint the estate says a person is, which a person input picks
   * from: null when it says none, or the reader may not see it.
   */
  person?: string | null
}
export type { ActionView }

export interface ActionRunsResponse {
  runs: ActionRun[]
  /** Older runs match too: ask again with a larger limit. Only the runs the reader may see are in `runs`, so it may hold fewer than the limit. */
  more: boolean
  /**
   * With `group=batch`: the batches asked over the same span as `runs`, each
   * one line where its runs would have been many, and `runs` holds only the
   * runs asked alone.
   */
  batches?: ActionBatchSummary[]
  /**
   * With `group=batch` or `group=origin`: the change sets asked over the same
   * span as `runs`, each one line, and `runs` holds no run of one.
   */
  sets?: ChangeSetSummary[]
  /**
   * With `group=origin`: what each schedule fired over the same span as
   * `runs`, one line a schedule a day in the reader's `tz`; `runs` and
   * `batches` then hold only what a person asked by hand. With `schedule`,
   * `from`, and `to`, the list is that schedule's firings over that span
   * instead, each batch one line, and this is left out.
   */
  schedules?: ScheduleDay[]
}

/**
 * What one schedule fired on one day, as one line of the runs list: how many
 * times it fired, how its runs stand now, and why the newest failure failed.
 * A firing that asked nothing is counted in `missed`, not in `counts`.
 */
export interface ScheduleDay {
  schedule: string
  /** The schedule's title and its cadence in words; null once it was removed. */
  title: string | null
  when: string | null
  /** What it runs on, said only to its owner and to a reader who sees everything. */
  targetTitle: string | null
  /** Whose schedule it is: every firing is asked as them. */
  owner: string
  action: string
  blueprint: string | null
  /** The reader's local day, as `YYYY-MM-DD`. */
  day: string
  firstAt: string
  lastAt: string
  /** Times it fired that day: a batch, or a run asked alone, each once. */
  firings: number
  counts: BatchCounts
  /** Firings that failed before they asked anything. */
  missed: number
  /** Why the newest failure failed: a run's summary, or why a firing asked nothing. */
  error: string | null
}

/**
 * One action on many entities at once: the entities named one by one, or the
 * question a grid asked, with the rows left out. Each entity gets its own run.
 * `preview` asks nothing: it answers what would be asked, and on what.
 */
export interface BatchRequest {
  entities?: EntityRef[]
  query?: EntityQuery
  inputs: Record<string, unknown>
}

/** An entity a batch could not ask for, and why. */
export interface BatchRefusal {
  blueprint: string
  key: string
  title: string
  reason: string
}

/**
 * What a batch would be asked for: every entity it runs on, by title, and the
 * ones it would not, with why, before anything is sent. `approval` counts the
 * runs that would wait for approval. A batch holds at most `max` entities.
 */
export interface BatchPreview {
  action: string
  total: number
  max: number
  /** The first `PREVIEW_LISTED` it would run on; `total` counts them all. */
  entities: { blueprint: string; key: string; title: string }[]
  /** The first `PREVIEW_LISTED` it would not run on, with why; `refusedTotal` counts them all. */
  refused: BatchRefusal[]
  refusedTotal: number
  approval: number
  /** How long it would take, from the action's history and its runner's width, or null when that is not known yet. */
  estimate: BatchEstimate | null
  /** The runs already waiting for the same runner, which go first: a batch's time counts them. */
  ahead: number
}

/** How many runs of a batch are in each state. */
export type BatchCounts = Partial<Record<ActionRunState, number>>

/** A batch as a list shows it: what it ran, on how many, by whom, and how its runs stand. */
export interface ActionBatchSummary {
  id: string
  action: string
  blueprint: string
  inputs: Record<string, unknown>
  by: string
  asked: number
  refused: number
  counts: BatchCounts
  /** Every run of it has finished, or it was stopped and what was left was cancelled. */
  done: boolean
  createdAt: string
  stoppedAt: string | null
  stoppedBy: string | null
  /** When its last run ended, once every one has. */
  endedAt: string | null
  /** A picture one of its runs reported, to show the batch by: read at `/v1/action-runs/{run}/outputs/{name}`. */
  cover: { run: string; name: string } | null
}

/**
 * One entity of a batch, as its results grid shows it: the newest run on it
 * of the batch, what that run ended with in a word, and whether it holds an
 * image to show. A run asked again on the entity is its newest; `runs` counts
 * them all.
 */
export interface BatchItem {
  blueprint: string
  key: string
  title: string
  run: string
  state: ActionRunState
  summary: string | null
  /** The outputs that are not images, to read at a glance. */
  outputs: Record<string, OutputValue>
  /** The names of the outputs that are images: each is read at `/v1/action-runs/{run}/outputs/{name}`. */
  images: string[]
  /** How many runs the batch has asked on it: more than one once someone ran it again. */
  runs: number
  /** The try of its newest run under way, or its last, counting from 1. */
  attempt: number
  /** While its newest run waits to be tried again: when the next try is due. */
  retryAt: string | null
  startedAt: string | null
  finishedAt: string | null
}

export interface ActionBatchResponse extends ActionBatchSummary {
  /** How long it still has, while any of its runs waits or runs; null when it is over or nothing says. */
  left: BatchEstimate | null
  items: BatchItem[]
  refusedItems: BatchRefusal[]
  /** Whether the reader may stop it or ask again on its entities: who asked it, or an admin. */
  canAct: boolean
  /** Whether the reader decides the runs of it that wait for approval, judged on the first that waits; each is judged again as it is approved. */
  canDecide: boolean
}

/** What one approval of a batch did: the runs it started, the ones it gave a vote that still wait for more, and why the rest were not approved, each reason once with how many it held back. */
export interface BatchApproval {
  approved: number
  voted: number
  refused: { reason: string; runs: number }[]
}

export interface ActionBatchesResponse {
  batches: ActionBatchSummary[]
}

/** Ask again on some entities of a batch: those named, or every one whose newest run ended in one of `states`. */
export interface BatchAgainRequest {
  entities?: EntityRef[]
  states?: ActionRunState[]
}

/** One change of a change set as it is asked: an action, the entity it runs on when it has one, and that run's own inputs. */
export interface ChangeSetItemRequest {
  action: string
  entity?: EntityRef
  inputs: Record<string, unknown>
}

/**
 * Many runs asked together for one decision: each item its own action,
 * entity, and inputs, in the order they should run. `note` says why, for
 * whoever decides it. A product with `actions.ask` names `for` to ask as a
 * person, as it does for one run.
 */
export interface ChangeSetRequest {
  title: string
  note?: string
  items: ChangeSetItemRequest[]
  for?: string
}

/** One item a change set would not hold, by its place in the request, with why: the whole set is refused when any is. */
export interface ChangeSetRefusal {
  index: number
  action: string
  entity: EntityRef | null
  error: string
  /** The input the refusal is about, when it is about one. */
  input?: string
}

/** How a change set stands as a whole: waiting, approved, rejected, or withdrawn by whoever asked. */
export const CHANGE_SET_DECISIONS = ['pending', 'approved', 'rejected', 'withdrawn'] as const
export type ChangeSetDecision = (typeof CHANGE_SET_DECISIONS)[number]

/** A change set as a list shows it: what it is called, who asked, how it was decided, and how its runs stand. */
export interface ChangeSetSummary {
  id: string
  title: string
  note: string | null
  by: string
  /** The product that asked in the person's name, when one did. */
  through: string | null
  /** The set whose failed items this one asks again for. */
  retries: string | null
  createdAt: string
  decision: ChangeSetDecision
  decidedBy: string | null
  decidedAt: string | null
  decisionNote: string | null
  /** How many runs it holds. */
  size: number
  /** Each action it runs, with how many of its runs it holds, in the order the set first names it. */
  actions: { id: string; title: string; runs: number }[]
  counts: BatchCounts
  /** Every run of it has ended. */
  done: boolean
  endedAt: string | null
  /** Where a person opens it, to read it or decide it. */
  url: string
}

/** One run of a change set, in its place: what it runs, on what, with which inputs, and how it stands. */
export interface ChangeSetItem {
  index: number
  run: string
  action: string
  actionTitle: string
  entity: EntityRef | null
  entityTitle: string | null
  inputs: Record<string, unknown>
  /** The titles of the entities and people its inputs name, by the id each input holds. */
  inputTitles?: Record<string, string>
  state: ActionRunState
  summary: string | null
  approvalsNeeded: number
  approvedBy: { by: string; at: string }[]
  attempt: number
  startedAt: string | null
  finishedAt: string | null
}

export interface ChangeSetResponse extends ChangeSetSummary {
  items: ChangeSetItem[]
  /** Whether the reader decides it now: one approval of theirs approves every run that waits. */
  canDecide: boolean
  /** Whether the reader may withdraw it: whoever asked for it, or an admin, while it waits. */
  canWithdraw: boolean
  /** Whether the reader may ask again for the items that failed, as a new set: whoever asked for it, or an admin, once it ended with failures. */
  canRetry: boolean
}

/** What one approval of a change set did: the runs it started, and the ones it gave a vote that still wait for more. */
export interface ChangeSetApproval {
  approved: number
  voted: number
  set: ChangeSetSummary
}

export interface ChangeSetsResponse {
  sets: ChangeSetSummary[]
}

/** What the target picker offers: the entities the reader may run the action on, and those whose runs wait for approval. */
/** The most targets one page of the target picker holds. */
export const TARGET_PAGE_MAX = 50

export interface ActionTargetsResponse {
  entities: Entity[]
  approval: string[]
  /** Asked for a page: how many targets match, the ones past the page included. */
  total?: number
}

/** What a person sends to run an action: the entity it runs on, when it has a blueprint, and the inputs. An entity input carries the id `blueprint:key`. */
export interface RunActionRequest {
  entity?: EntityRef
  inputs: Record<string, unknown>
  /** Tool tiers the run asks for beyond what the action carries. The run then waits for someone who holds them. */
  tiers?: ToolTier[]
  /** The run this one asks again for: one of the asker's own, on the same action and entity, that was sent back. */
  revises?: string
  /** The person to ask as, by sign-in address. Only a caller with `actions.ask` names one; the hub judges the request as that person's. */
  for?: string
  /**
   * Who decides the run, when it waits: grants judged on the decider's own person entity, as a rule's are. Named only
   * with `for`, by the product asking. Then only someone they let in decides it: never its asker, and no admin or holder
   * of `actions.approve` by that alone.
   */
  approvers?: AccessGrant[]
  /**
   * The person a product asks the run for, by sign-in address, when it asks as itself. The run is the product's: its
   * own access lets it run the action, and the person needs none and sees nothing. The run keeps them as
   * `requestedFor`, as data: they never decide it, and the hub tells them nothing of it. Named only by a machine access
   * token with `actions.ask`, never with `for`. With `approvers`, the run always waits for one of them.
   */
  requestedFor?: string
}

/** What sends a run back to its asker: why, and what to change. */
export interface ReturnRunRequest {
  note: string
}

/** A tool as the door lists it: enough for an agent to pick one and call it. */
export interface ToolSummary {
  id: string
  title: string
  description?: string
  tier: ToolTier
  inputs: Record<string, ActionInputDef>
}
export interface ToolsResponse {
  tools: ToolSummary[]
}

/**
 * What a tool call sends: the entity the tool runs on, when it has a
 * blueprint, and its inputs. `as` is for a product that works a person's
 * request and holds `tools.lend`: the call is judged as that person, with the
 * tiers of the named action where they may ask for it, and the tiers the
 * named run of it was granted while that run is approved and not yet done.
 */
export interface ToolCallRequest {
  entity?: EntityRef
  inputs?: Record<string, unknown>
  as?: ToolCaller
}
/** Whose request a lent call works: the person, the action they asked for, the entity they asked for it on, and the run that was approved, when one was. */
export interface ToolCaller {
  person: string
  action: string
  entity: EntityRef
  run?: string
}

/**
 * What a tool call answers. `text` is what the tool printed, cut short and
 * marked `truncated` when it printed more than the door carries. A call that
 * outlives the door's wait answers with the run still `queued` or `running`;
 * a call that needs approval answers `awaiting`. The run is read by its id.
 */
export interface ToolCallResponse {
  run: string
  state: ActionRunState
  summary: string | null
  text: string
  truncated: boolean
  outputs: Record<string, OutputValue>
}

/**
 * What a backend tells the hub about a run. Every report says the run is alive, one that carries nothing too.
 * `log` lines are appended; a terminal `state` closes the run.
 * `step` starts a step before the lines are read, and a line may start one or set an output itself
 * (`run-marks.ts`). `outputs` are merged into what the run holds, and null takes one away.
 */
export interface ActionReport {
  /** `unknown` is the word of the starter that held a job run alone: its job is gone, and nobody saw how it ended. */
  state?: Extract<ActionRunState, 'running' | 'succeeded' | 'failed' | 'unknown'>
  label?: string
  link?: string
  summary?: string
  log?: string[]
  step?: string
  outputs?: Record<string, OutputValue | null>
}

/**
 * How the Self-service page lays its sections out, the same for everyone. A
 * section is a home, named by its entity id, or a group, named by its name.
 * Sections `order` names come first, in its order, then the other homes by
 * title and the other groups by name; sections `closed` names start folded
 * shut, the empty name being the section of what has neither. A reader's own
 * homes are lifted to the top where they are read, never here.
 */
export interface ActionsLayout {
  order: string[]
  closed: string[]
}

/** A queued run a runner has claimed, with its command rendered. */
export interface RunnerJob {
  run: string
  action: string
  command: string[]
  env: Record<string, string>
  timeoutMs: number
}

/**
 * A queued job run a starter has claimed, rendered: what to start, from which
 * of the starter's own templates (`template`, the name the hub worked out
 * for this run), and what the job is handed. `token` is the
 * credential made for this run alone, given here once and kept by the hub
 * only as its hash. `try` counts the tries of the run from 1, so a job is
 * named by the run and its try. `ceilingMs` is how long the job may run.
 */
export interface StarterJob {
  run: string
  action: string
  try: number
  template: string
  image: string
  command: string[]
  args: string[]
  env: Record<string, string>
  token: string
  ceilingMs: number
}

/** What a starter says it still sees on its platform, to be told how each of those runs stands. */
export interface StarterRunsRequest {
  seen?: string[]
}

/** A run a starter claimed, as the hub holds it now: what the starter keeps alive, ends, or stops. */
export interface StarterRun {
  run: string
  try: number
  state: ActionRunState
  startedAt: string | null
  ceilingMs: number
  /** What the run's own job said of it, so its starter says why it failed only when the job did not. */
  summary: string | null
}

/** Every run the starter holds that is still running, and each run it named that it once claimed. */
export interface StarterRunsResponse {
  starter: string
  runs: StarterRun[]
}

/**
 * One blueprint a query reads: its conditions, as the grid's filter panel
 * keeps them, an optional search, and which states. Each source is read
 * through the reader's own view.
 */
export interface QuerySource {
  blueprint: string
  clauses: GridClause[]
  search?: string
  /** Left out: active and missing, as the grid shows. */
  states?: EntityState[]
  hidden?: boolean
}

/** A published dataset as one reader may read it: a table a query reads beside the catalog, as the source `$data:<id>`. */
export interface DatasetSummary {
  id: string
  title: string
  description: string | null
  icon: string | null
  columns: DatasetColumn[]
  /** How long an answer is kept before its tool is called again. */
  fresh: string
  /** The catalog's record of what it reads, where the reader may see it. */
  entity: { blueprint: string; key: string; title: string } | null
  /** When its rows were last read; null before the first read. */
  fetchedAt: string | null
}

export interface DatasetsResponse {
  datasets: DatasetSummary[]
}

/**
 * A column that names, for each blueprint the query reads, what fills it
 * there: a field, a relation (`r:<name>`), or one of the columns every entity
 * has. A blueprint it does not name leaves it empty. `id` keeps the column
 * apart from the others; `title` is what its header says.
 */
export interface QueryColumnSpec {
  id: string
  title: string
  from: Record<string, string>
}

/**
 * A query: the blueprints it reads, and the columns it shows. A column is a
 * `QueryColumnSpec`, or an id that is the same in every blueprint: a field or
 * a relation (`r:<name>`) by its id, the same id across blueprints one
 * column, or one of the columns every entity has (`META_COLUMNS` in
 * `answer.ts`): `$type`, `title`, `$key`, `$status`, `$state`, `$owner`,
 * `$lastSeenAt`, `$updatedAt`. A bare `key`, `state`, `lastSeenAt`, or
 * `updatedAt` is the field of that name where a blueprint has one, and the
 * column every entity has elsewhere.
 */
export interface QuerySpec {
  sources: QuerySource[]
  columns: (string | QueryColumnSpec)[]
  /** How the answer is narrowed, ordered, grouped, and added up once it is read. Left out, it is every row as read. */
  view?: QueryView
}

/** How a column adds up: in a group's row, and at the foot of the answer. */
export const QUERY_TOTALS = ['count', 'filled', 'distinct', 'sum', 'avg', 'min', 'max'] as const
export type QueryTotal = (typeof QUERY_TOTALS)[number]

/** How long a bar of the answer's chart is: the rows it stands for, or a total over a number column of them. */
export const CHART_TOTALS = ['count', 'sum', 'avg', 'min', 'max'] as const
export type ChartTotal = (typeof CHART_TOTALS)[number]

/**
 * What the answer's chart draws: a bar for each value of one column (`by`),
 * as long as a total over the rows that hold it (`total`, over `column`
 * unless it counts rows), and each bar split into the values of another
 * column (`split`; null for none). What it leaves out is worked out from the
 * rest of the view: the first group, the first sum, and the second group or
 * the blueprints.
 */
export interface QueryChart {
  by?: string
  total?: ChartTotal
  column?: string
  split?: string | null
}

/** The most columns an answer is grouped by at once. */
export const QUERY_GROUPS_MAX = 3

/** One order of the rows: by a column, low to high unless `desc`. */
export interface QuerySort {
  column: string
  desc?: boolean
}

/**
 * How a query's answer is shown once it is read, kept with the query. Its
 * conditions read the answer's columns, across every source, so they can test
 * what no single blueprint holds: a column filled from a different field in
 * each, or read through a relation. `src/shared/answer.ts` is the one reading
 * of it: the page shapes the answer with it, and the hub with the same code
 * wherever it hands an answer on (an export, a batch, a schedule, an agent).
 */
export interface QueryView {
  /** Conditions on the answer's columns: a row stays when it meets them all. A clause's `field` names a column by its id. */
  where?: GridClause[]
  /** The order of the rows, by each column in turn. Left out, they come as read: by source, then by title. */
  sort?: QuerySort[]
  /** The columns the rows are grouped by, outermost first, at most `QUERY_GROUPS_MAX`. */
  group?: string[]
  /** How each column adds up in a group's row and at the foot, by column id. */
  totals?: Record<string, QueryTotal>
  /** The widths a person gave columns, in pixels, by column id. */
  widths?: Record<string, number>
  /** What the chart draws, where a person picked it. */
  chart?: QueryChart
}

export interface QueryColumn {
  id: string
  title: string
  /** For each blueprint read, what fills the column there; a blueprint left out leaves it empty, or reads nothing the reader may see by that name. */
  from: Record<string, string>
}

/** One row of a query's answer: what it is, and a value for each column, in the columns' order. */
export interface QueryRow {
  blueprint: string
  key: string
  values: unknown[]
}

/** A query's answer: every row that matched, up to `QUERY_ROWS_MAX`, and how many each source matched. */
export interface QueryResult {
  columns: QueryColumn[]
  rows: QueryRow[]
  /** How many each source matched, by blueprint. */
  counts: Record<string, number>
  /** More matched than one answer holds; narrow it. */
  truncated: boolean
  /** How long the hub took to read it, in milliseconds. */
  ms?: number
}

/** A group of a shown answer: what it holds and adds up to, and the groups inside it, without its rows. */
export interface QueryAnswerGroup {
  column: string
  value: string | null
  count: number
  totals: Record<string, number | string | null>
  groups?: QueryAnswerGroup[]
}

/**
 * A query's answer as its view shows it, for a caller that does not shape it
 * itself (an agent, a command line): the rows the view keeps, in its order,
 * up to `limit`, with the groups and the totals when the view asks for them.
 */
export interface QueryAnswer {
  /** How many each source matched, by blueprint, as read, before the view. */
  counts: Record<string, number>
  /** Each column, with how its numbers are shown where every blueprint that fills it agrees. */
  columns: (QueryColumn & { format?: FieldFormat })[]
  /** How many rows the view keeps. */
  kept: number
  rows: QueryRow[]
  /** How many of the kept rows this answer holds. */
  shown: number
  truncated: boolean
  groups?: QueryAnswerGroup[]
  totals?: Record<string, number | string | null>
}

/**
 * A query kept by name, in whoever saved it's library. It is theirs alone,
 * shared with everyone (`shared`), or shared with one audience of the access
 * policy they are in (`audience`). Whoever saved it, or an admin, changes it.
 * Whoever opens it reads it through their own access, so two people may get
 * different answers.
 */
export interface SavedQuery {
  id: string
  title: string
  description: string | null
  owner: string
  shared: boolean
  /** The audience it is shared with, when it is shared with one rather than everyone. */
  audience: { id: string; title: string } | null
  /** The one entity it belongs to, as the reader sees it: it is listed under its home, and on its home's page. Null for none, or a home the reader may not see. */
  home: Home | null
  /** It opens to the people who own its home, in any way the person setting's `owns` paths say. */
  homeShared: boolean
  spec: QuerySpec
  createdAt: string
  updatedAt: string
  /** Whether the reader may change it. */
  mine: boolean
}

export interface SavedQueriesResponse {
  queries: SavedQuery[]
}

export interface SaveQueryRequest {
  title: string
  description?: string | null
  /** Everyone may open it. */
  shared?: boolean
  /** The audience that may open it: one the person saving is in. Left out or null with `shared` false, it is theirs alone. */
  audience?: string | null
  /** The entity it belongs to, `blueprint:key`, one the person saving sees. Null takes it off its home; left out, it keeps the one it has. */
  home?: string | null
  /** It opens to the people who own its home: only someone who owns the home, or an admin, opens it so. Shared with everyone or an audience, it is not. */
  homeShared?: boolean
  spec: QuerySpec
}

/** Where a schedule stands: waiting for someone to approve it, firing, paused, declined, or done: one that fires once, after it fired. */
export type ScheduleState = 'awaiting' | 'active' | 'paused' | 'declined' | 'done'

/**
 * What a schedule runs on, one of: one entity; the entities picked when it
 * was set up, each time the same; every row a grid's question matches when
 * it fires; every row a saved query matches of the action's blueprints when
 * it fires; or nothing, for an action that runs on none. All but one entity
 * and nothing fire as a batch.
 */
export interface ScheduleTarget {
  entity?: EntityRef
  entities?: EntityRef[]
  matching?: EntityQuery
  /** A saved query's id. */
  query?: string
}

/**
 * The load a schedule adds, worked out when it is asked for and again each
 * time it fires: how many runs each firing asks, the runner time they take
 * together, how long one firing lasts at the runner's width, and when in
 * the day it fires.
 */
export interface ScheduleLoad {
  runs: number
  /** Runner seconds one firing takes: its runs times their mean time. Null until the action has run often enough to know. */
  runnerSeconds: number | null
  /** How long one firing lasts, start to end. */
  estimate: BatchEstimate | null
  /** How many times it fires a day, on average over a week. */
  perDay: number
  /** Runner seconds it adds in each hour of the day, in UTC, on an average day. */
  hours: number[]
  /** The runner it runs on, when its action has one. */
  runner: string | null
}

export interface ActionSchedule {
  id: string
  action: string
  title: string
  owner: string
  target: ScheduleTarget
  /** What the target is called: the entity's title, or the saved query's. */
  targetTitle: string | null
  inputs: Record<string, unknown>
  cadence: Cadence
  /** The cadence in words. */
  when: string
  /** Who hears of each firing's result, beside the owner. */
  deliver: string[]
  /** Which results the owner and the people named hear of. */
  tell: ScheduleTell
  state: ScheduleState
  load: ScheduleLoad | null
  decidedBy: string | null
  decidedAt: string | null
  /** Why it was declined or paused. */
  note: string | null
  nextAt: string | null
  lastAt: string | null
  lastRun: string | null
  lastBatch: string | null
  createdAt: string
  updatedAt: string
  /** Whether the reader may change, pause, or remove it: its owner, or someone who decides. */
  mine: boolean
  /** Whether the reader may approve or decline it. */
  canDecide: boolean
}

export interface ScheduleRequest {
  action: string
  title: string
  target: ScheduleTarget
  inputs: Record<string, unknown>
  cadence: Cadence
  deliver?: string[]
  /** Which results its people hear of; only failures when left out. */
  tell?: ScheduleTell
}

export interface SchedulesResponse {
  schedules: ActionSchedule[]
}

/**
 * One time a schedule fired: the run or the batch it asked, and how its runs
 * stand now. A firing that asked nothing, because it failed before a run was
 * asked, has no run and no batch and says why in `error`.
 */
export interface ScheduleFiring {
  schedule: string
  /** When it fired: when its first run was asked. */
  at: string
  run: string | null
  batch: string | null
  runs: number
  succeeded: number
  failed: number
  /** Waiting for approval, queued, or running. */
  open: number
  /** Declined, cancelled, or sent back: ended without running to an outcome. */
  stopped: number
  /** How long its finished runs took, added up: the runner time it cost. */
  seconds: number
  /** When its first run started, and when its last ended once none is open. */
  startedAt: string | null
  endedAt: string | null
  error: string | null
}

/** Every firing of the schedules the reader may see since `since`, oldest first. */
export interface ScheduleHistory {
  since: string
  days: number
  firings: ScheduleFiring[]
}

/** The most days a schedule's history is read back. */
export const SCHEDULE_HISTORY_DAYS = 90

/** What self-service was used for over a window, and what it cost each runner, hour by hour. */
export interface ActionInsights {
  days: number
  since: string
  /** Every action, the most run first: how often, by how many people, how it went, and how long it took. */
  actions: {
    action: string
    title: string
    runs: number
    people: number
    failed: number
    /** Runs tried more than once. */
    retried: number
    batched: number
    scheduled: number
    meanSeconds: number | null
    p95Seconds: number | null
    /** Its newest run ever, so an action nobody uses shows how long it has been. */
    lastRunAt: string | null
  }[]
  /** The people who ran the most. */
  people: { person: string; runs: number; actions: number; batches: number }[]
  /** Batches, by action: how many, how big, how long. */
  batches: { action: string; batches: number; meanSize: number; largest: number; meanSeconds: number | null; scheduled: number }[]
  /**
   * Each runner on an average day of the window, by hour in UTC: the runner
   * seconds its runs took, how many started, how long they waited for it, and
   * the runner seconds approved schedules add.
   */
  runners: { runner: string; width: number | null; busySeconds: number[]; runs: number[]; waitSeconds: (number | null)[]; scheduledSeconds: number[] }[]
}

/** The query source that reads action runs rather than a blueprint: the runs the reader may see, as the runs list shows them. */
export const RUNS_SOURCE = '$runs'

/** What a query of runs may filter on and show, by id, beside the columns every row has. */
export const RUN_COLUMNS: readonly { id: string; title: string; type?: FieldType }[] = [
  { id: 'run:action', title: 'Action' },
  { id: 'run:by', title: 'Asked by' },
  { id: 'run:entity', title: 'Ran on' },
  { id: 'run:state', title: 'State', type: 'enum' },
  { id: 'run:createdAt', title: 'Asked at', type: 'datetime' },
  { id: 'run:startedAt', title: 'Started', type: 'datetime' },
  { id: 'run:finishedAt', title: 'Finished', type: 'datetime' },
  { id: 'run:seconds', title: 'Seconds', type: 'number' },
  { id: 'run:attempt', title: 'Tries', type: 'number' },
  { id: 'run:batch', title: 'Batch' },
  { id: 'run:schedule', title: 'Schedule' },
  { id: 'run:decidedBy', title: 'Decided by' },
  { id: 'run:summary', title: 'Summary' },
]

/** The audiences of the access policy the caller is in: the ones they may share a query with. */
export interface QueryAudiencesResponse {
  audiences: { id: string; title: string; description: string | null }[]
}

// Reports ---------------------------------------------------------------------

/** One version of a report's layout: who made it, when, and why. */
export interface ReportVersion {
  version: number
  note: string | null
  by: string
  at: string
  /** The version it put back, when it was a restore. */
  restoredFrom: number | null
}

/** One edition in a report's list: when, what it said in a line, and its headline numbers. */
export interface ReportEditionLine {
  number: number
  publishedAt: string
  summary: string
  headline: Record<string, number | null>
}

/** How a headline number reads: its title and how it is written. */
export interface ReportStat {
  name: string
  title: string
  unit?: string
  decimals?: number
  better?: 'up' | 'down'
}

/** A schedule that publishes a report, as the report's readers see it. */
export interface ReportSchedule {
  id: string
  title: string
  /** When it fires, in words. */
  when: string
  state: ScheduleState
  nextAt: string | null
  owner: string
}

/** One report in the list of reports: what it is, whose it is, its newest edition, and when it publishes next. */
export interface ReportLine {
  key: string
  title: string
  owner: string
  /** The entity it belongs to, as the reader sees it. */
  home: { id: string; blueprint: string; key: string; title: string } | null
  /** Whether the reader may change and publish it. */
  yours: boolean
  status: string
  statusReason: string | null
  editions: number
  /** Its newest edition: what it said, and its headline numbers with how each moved. */
  latest: { number: number; publishedAt: string; summary: string; stats: EditionStat[] } | null
  schedules: ReportSchedule[]
}

/** The reports a reader may see, the newest published first, then the ones never published. */
export interface ReportsResponse {
  reports: ReportLine[]
  /** How many there are when the list holds fewer. */
  total: number
}

/** A report's page: its record as the reader sees it, its versions and editions, newest first, and its headline numbers as the newest edition names them. */
export interface ReportPage {
  report: Entity
  /** Whether the reader may change and publish it: its owner, someone who owns its home, or an admin. */
  canChange: boolean
  versions: ReportVersion[]
  editions: ReportEditionLine[]
  stats: ReportStat[]
  /** The live schedules that publish it. */
  schedules: ReportSchedule[]
}

/** One edition whole: the blocks it was drawn from, and the data sets it read, as kept. */
export interface ReportEditionRead {
  content: EditionContent
  data: Record<string, DataSet>
}

/** A preview a run drew: the same as an edition, kept with the run alone. */
export type ReportPreviewRead = ReportEditionRead
