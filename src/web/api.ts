import { focusManager, keepPreviousData, useMutation, useMutationState, useQueries, useQuery, useQueryClient, type InvalidateQueryFilters, type QueryClient } from '@tanstack/react-query'
import { useEffect, useMemo } from 'react'
import type { ColumnStandard } from '../shared/columns.ts'
import type { ChangeSetApproval, ChangeSetResponse, ChangeSetSummary, ChangeSetsResponse, ActionInsights, DatasetsResponse, ReportsResponse, ActionSchedule, MyApprovals, ScheduleHistory, ScheduleRequest, SchedulesResponse, QueryAudiencesResponse, QueryResult, QuerySpec, SaveQueryRequest, SavedQueriesResponse, SavedQuery, ActionBatchResponse, ActionBatchSummary, ActionBatchesResponse, BatchAgainRequest, BatchApproval, BatchPreview, BatchRefusal, BatchRequest, Budgets, AccessSettingsResponse, ActionReport, ActionRunsResponse, ActionTargetsResponse, ActionsLayout, ActionsResponse, Alert, AlertRule, AssignedCheckView, BlueprintsResponse, BulkEditResponse, ChangesResponse, EntitiesResponse, LoadResponse, EntityPageResponse, EntityPatch, MineResponse, PinsOrderRequest, PinsResponse, StarResponse, StarsResponse, EntityQuery, IconsResponse, CatalogLayout, CatalogLayoutPatch, GridLayout, GridLayoutPatch, ImportReport, ModelLayout, ModelPlaceRequest, ModelPlacement, ModelTemplate, RolesResponse, RulesResponse, Scorecard, ScorecardResults, ScorecardTrend, ServerEvent, SourceDetailResponse, StreamHello, SourcesResponse, TokenIssued, TokenSummary, UsersResponse, WallResponse, WhoAmIResponse, SummaryResponse, GroundIndexResponse, GroundItemResponse, GroundResponse, MapIndexResponse, MapResponse, PreviewName, Previews, PreviewsResponse, WalkResponse, WalkStep, WalkStepRequest, MyPerson } from '../shared/api.ts'
import { TARGET_PAGE_MAX } from '../shared/api.ts'
import type { LayoutIssue } from '../shared/report.ts'
import { blueprintNamer, can, datasetBlueprint, entityId, parseEntityId, type AccessRule, type Action, type BlueprintNamer, type ActionRun, type Blueprint, type Entity, type EntityRef, type Filter, type Permission, type PersonSetting, type Pin, type RoleDef, type Run, type User, SOURCE_STANDING, REPORT_BLUEPRINT } from '../shared/model.ts'
import { actionsMoved, reordered } from './actions.ts'
import type { MineFillResponse, ReportEditionRead, ReportPage, ReportPreviewRead } from '../shared/api.ts'
import type { EditsResponse, PolicyPreview, PostureChange, PosturePreview, PostureReach, PostureResponse, PostureWho } from '../shared/posture.ts'
import type { AccessPolicy, PolicyState } from '../shared/policy.ts'
import { recall, remember } from './kept.ts'
import { noteServed } from './release.ts'
import { SIGNED_OUT, signInAgain, signedOut } from './session.ts'
import { session, timeWait } from './telemetry.ts'
import { SESSION_HEADER } from '../shared/usage.ts'
import type { PreferenceName, PreferenceValues } from '../shared/preferences.ts'
import type { WelcomeDef, WelcomeResponse } from '../shared/welcome.ts'
import { keepTold } from './told.ts'

/** Where the person an admin is viewing as is kept: for this tab only, so closing it ends the view. */
const VIEW_AS_KEY = 'orrery.view-as'
/** The header that tells the hub to answer as another person. The hub honours it for a signed-in admin alone. */
const VIEW_AS_HEADER = 'x-orrery-view-as'

/** Who an admin is viewing the hub as, or null. A page drawn away from a browser, such as on the server, views as no one. */
export const viewingAs = (): string | null => (typeof sessionStorage === 'undefined' ? null : sessionStorage.getItem(VIEW_AS_KEY))

/** A link the browser opens itself, which cannot send the header, names the person in its address. */
export const asViewed = (path: string): string => {
  const email = viewingAs()
  return email ? `${path}${path.includes('?') ? '&' : '?'}view_as=${encodeURIComponent(email)}` : path
}

/** Starts viewing as a person: the hub checks them and logs it, then the page loads again as them. */
export async function startViewingAs(email: string): Promise<void> {
  const seen = await call<{ email: string }>('/v1/view-as', { method: 'POST', body: JSON.stringify({ email }) })
  sessionStorage.setItem(VIEW_AS_KEY, seen.email)
  location.assign('/')
}

/** Back to the admin's own view. */
export function stopViewingAs(): void {
  sessionStorage.removeItem(VIEW_AS_KEY)
  location.assign('/')
}

/** An answer the hub refused or failed, with its status for whoever reads one differently, and the input of a form it was about when the hub names one. */
export class CallError extends Error {
  readonly status: number
  readonly input?: string
  constructor(message: string, status: number, input?: string) {
    super(message)
    this.status = status
    if (input !== undefined) this.input = input
  }
}

export function call<T>(path: string, init?: RequestInit): Promise<T> {
  return timeWait(callNow<T>(path, init))
}

async function callNow<T>(path: string, init?: RequestInit): Promise<T> {
  const as = viewingAs()
  const response = await fetch(path, { ...init, redirect: 'manual', headers: { 'content-type': 'application/json', [SESSION_HEADER]: session, ...(as && path !== '/v1/view-as' ? { [VIEW_AS_HEADER]: as } : {}), ...init?.headers } })
  if (signedOut(response)) {
    // A sign-in that lapsed for what the person did names where a fresh one starts; one that ended names nothing.
    const said = response.status === 401 ? ((await response.json().catch(() => null)) as { error?: string; signIn?: string } | null) : null
    const start = typeof said?.signIn === 'string' ? said.signIn : undefined
    // The page is about to be replaced, so this never settles: no error is shown on the way out.
    if (signInAgain({ storage: sessionStorage, reload: () => location.reload(), assign: (url) => location.assign(url), here: location.pathname + location.search, now: Date.now() }, start)) return new Promise<never>(() => {})
    throw new Error(start && said?.error ? said.error : SIGNED_OUT)
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string; input?: string; offenders?: { key: string; field: string; reason: string }[] } | null
    const extra = body?.offenders?.length ? ` ${body.offenders.map((o) => `${o.key}.${o.field}: ${o.reason}`).join('; ')}` : ''
    throw new CallError((body?.error ?? `${response.status} ${response.statusText}`) + extra, response.status, typeof body?.input === 'string' ? body.input : undefined)
  }
  return (await response.json()) as T
}

export const keys = {
  whoami: ['whoami'] as const,
  blueprints: ['blueprints'] as const,
  wall: ['wall'] as const,
  summary: ['summary'] as const,
  mine: ['mine'] as const,
  entities: (blueprint: string, params: string) => ['entities', blueprint, params] as const,
  entity: (ref: EntityRef) => ['entity', ref.blueprint, ref.key] as const,
  changes: (params: string) => ['changes', params] as const,
  load: (hours: number) => ['load', hours] as const,
  sources: ['sources'] as const,
  source: (id: string) => ['source', id] as const,
  tokens: ['tokens'] as const,
  roles: ['roles'] as const,
  users: ['users'] as const,
  rules: ['rules'] as const,
  grid: (blueprint: string) => ['grid', blueprint] as const,
  gridStandard: ['grid-standard'] as const,
  runs: ['runs'] as const,
  actions: ['actions'] as const,
  actionRuns: (params: string) => ['action-runs', params] as const,
  actionRun: (id: string) => ['action-run', id] as const,
  report: (key: string) => ['report', key] as const,
  actionBatch: (id: string) => ['action-batch', id] as const,
  changeSet: (id: string) => ['change-set', id] as const,
  myTokens: ['me', 'tokens'] as const,
  pins: ['pins'] as const,
  starsTable: ['stars-table'] as const,
  stars: ['stars'] as const,
  preferences: ['preferences'] as const,
  welcome: ['welcome'] as const,
  welcomeSettings: ['welcome', 'settings'] as const,
  access: ['access'] as const,
  icons: ['icons'] as const,
  alerts: ['alerts'] as const,
  previews: ['previews'] as const,
  grounds: ['ground'] as const,
  ground: (blueprint: string) => ['ground', blueprint] as const,
  groundItem: (ref: EntityRef) => ['ground', ref.blueprint, ref.key] as const,
  maps: ['map'] as const,
  map: (ref: EntityRef) => ['map', ref.blueprint, ref.key] as const,
  walk: (ref: EntityRef) => ['walk', ref.blueprint, ref.key] as const,
}

const enc = encodeURIComponent
export const entityPath = (ref: EntityRef) => `/v1/entities/${enc(ref.blueprint)}/${enc(ref.key)}`

export const useWhoAmI = () => useQuery({ queryKey: keys.whoami, queryFn: () => call<WhoAmIResponse>('/v1/whoami'), staleTime: Infinity })
/** Whether the person signed in holds this permission, whatever they are doing with it. */
export const useHolds = (permission: Permission): boolean => can(useWhoAmI().data?.identity, permission)
/** Who an admin is viewing the hub as, or null while it is their own view. A view as someone else only reads. */
export const useViewingAs = (): string | null => {
  const id = useWhoAmI().data?.identity
  return id?.viewAs ? id.name : null
}
/** Whether the person signed in may change what this permission is for. False while viewing as someone else: nothing is changed as them. */
export function useCan(permission: Permission): boolean {
  const holds = useHolds(permission)
  const viewing = useViewingAs()
  return holds && !viewing
}
/**
 * True when the signed-in person may change entities of this blueprint: they
 * hold entities.edit, and it is not an admin's alone. A blueprint access is
 * decided from a holder of access.values changes too, unless an admin marked it.
 */
export function useCanEdit(blueprint: string): boolean {
  const id = useWhoAmI().data?.identity
  const blueprints = useBlueprints().data
  const adminOnly = blueprints?.adminOnly ?? []
  const bp = blueprints?.blueprints.find((b) => b.id === blueprint)
  const marked = !!bp?.adminEdit
  // What a person sees only as its owner, or as about what they see, is theirs to read, never to change.
  if (bp?.onlyYours || bp?.onlyAbout) return false
  return can(id, 'entities.edit') && !id?.viewAs && (!!id?.admin || !adminOnly.includes(blueprint) || (can(id, 'access.values') && !marked))
}

/**
 * Why the reader may not change a value of this blueprint by hand because
 * access is decided from it, by name; null when they may. An admin and a
 * holder of access.values may, never while viewing as someone else.
 */
export function useAccessGuard(bp: Pick<Blueprint, 'decides'> | undefined): (name: string) => string | null {
  const id = useWhoAmI().data?.identity
  const may = !id?.viewAs && (!!id?.admin || can(id, 'access.values'))
  return (name) => (!may && bp?.decides?.names.includes(name) ? 'Access is decided from this: only an admin or a holder of access.values changes it' : null)
}
/** True for an admin in their own view: what only an admin changes is not shown while viewing as someone else. */
export const useIsAdmin = (): boolean => {
  const id = useWhoAmI().data?.identity
  return !!id?.admin && !id.viewAs
}
/** Whether a view still in preview is open to the reader. What it gates is not drawn, linked, or asked for when this is false. */
export const usePreview = (name: PreviewName): boolean => !!useWhoAmI().data?.previews?.includes(name)
/** Who each preview is open to. An admin's to read and to set. */
export const usePreviews = (enabled: boolean) => useQuery({ queryKey: keys.previews, queryFn: () => call<PreviewsResponse>('/v1/access/previews'), staleTime: 10_000, enabled })
export function useSavePreviews() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (previews: Previews) => call<PreviewsResponse>('/v1/access/previews', { method: 'PUT', body: JSON.stringify(previews) }),
    onSuccess: (saved) => {
      client.setQueryData(keys.previews, saved)
      void client.invalidateQueries({ queryKey: keys.whoami })
    },
  })
}
/** Each blueprint that has a ground, with how much of it is inside its budgets. Asked for only inside the preview. */
export const useGroundIndex = (enabled = true) => useQuery({ queryKey: keys.grounds, queryFn: () => call<GroundIndexResponse>('/v1/ground'), staleTime: 30_000, enabled })
export const useGround = (blueprint: string) => useQuery({ queryKey: keys.ground(blueprint), queryFn: () => call<GroundResponse>(`/v1/ground/${enc(blueprint)}`), staleTime: 30_000, placeholderData: (prev) => prev })
/** Every entity a map can be drawn of. Asked for only inside the preview. */
export const useMapIndex = (enabled = true) => useQuery({ queryKey: keys.maps, queryFn: () => call<MapIndexResponse>('/v1/map'), staleTime: 30_000, enabled })
export const useMap = (ref: EntityRef) => useQuery({ queryKey: keys.map(ref), queryFn: () => call<MapResponse>(`/v1/map/${enc(ref.blueprint)}/${enc(ref.key)}`), staleTime: 30_000, placeholderData: (prev) => prev })
export const useGroundItem = (ref: EntityRef) => useQuery({ queryKey: keys.groundItem(ref), queryFn: () => call<GroundItemResponse>(`/v1/ground/${enc(ref.blueprint)}/${enc(ref.key)}`), staleTime: 30_000 })
/** The custom icons the hub holds, by name, each with the hash of its bytes. Read again when the hub says they changed. */
export const useCustomIcons = () => useQuery({ queryKey: keys.icons, queryFn: async () => new Map((await call<IconsResponse>('/v1/icons')).icons.map((i) => [i.name, i.sha256])), staleTime: Infinity })
export const useBlueprints = () => useRemembered<BlueprintsResponse>('blueprints', '/v1/blueprints', 60_000)

/**
 * A query whose last answer this browser keeps, so the page paints with it
 * at once while the hub builds the fresh one. The kept answer is shown only
 * once the hub has said who is signed in, and only to the person it was
 * given to: never to a different person on the same browser, and never
 * while an admin views the hub as someone else. It goes into the cache as
 * already stale, so the fresh one is asked for at once and takes its place.
 */
function useRemembered<T>(what: 'blueprints' | 'summary' | 'mine' | 'alerts', path: string, staleTime: number) {
  const client = useQueryClient()
  const identity = useWhoAmI().data?.identity
  const who = identity && !identity.viewAs ? identity.name : null
  const key = keys[what]
  if (who && client.getQueryData(key) === undefined) {
    const kept = recall<T>(what, who)
    if (kept !== undefined) client.setQueryData<T>(key, kept, { updatedAt: 0 })
  }
  const query = useQuery({ queryKey: key, queryFn: () => call<T>(path), staleTime })
  const { data, isFetchedAfterMount } = query
  useEffect(() => {
    if (who && data !== undefined && isFetchedAfterMount) remember(what, who, data)
  }, [what, who, data, isFetchedAfterMount])
  return query
}
/** Names a blueprint the way every view shows it: its title, with its section beside it where another blueprint the person sees shares the title. */
/** Whether the reader may open entities of this blueprint: the hub lists only the blueprints they see. False until the list loads, so no link leads to a page that refuses them. */
export function useSeesBlueprint(id: string): boolean {
  return !!useBlueprints().data?.blueprints.some((b) => b.id === id)
}
export function useBlueprintName(): BlueprintNamer {
  const list = useBlueprints().data?.blueprints
  return useMemo(() => blueprintNamer(list ?? []), [list])
}
/** The estate at a glance: counts and what is not green per blueprint, the reds first, findings, and firing alerts. */
export const useSummary = () => useRemembered<SummaryResponse>('summary', '/v1/summary', 10_000)
/** What is the reader's own, and whether they see everything: the perspective every page speaks from. */
// What is green is left out: the hub marks the alerts, findings, and scorecard rows that touch the reader's own.
export const useMine = () => useRemembered<MineResponse>('mine', '/v1/mine?green=false', 10_000)
/** What the reader could fill in on their own things; a hub one release back has no such answer, which reads as nothing. */
export const useMineFill = (enabled: boolean) => useQuery({ queryKey: [...keys.mine, 'fill'], queryFn: () => call<MineFillResponse>('/v1/mine/fill').catch(() => ({ fill: [] }) as MineFillResponse), staleTime: 60_000, enabled })
/** One kind of the reader's own, green ones too, read only when they open it: the worst `MINE_KIND_MAX` whole, the rest counted. */
export const useMineKind = (blueprint: string | null) =>
  useQuery({ queryKey: [...keys.mine, 'kind', blueprint], queryFn: () => call<MineResponse>(`/v1/mine?blueprint=${encodeURIComponent(blueprint!)}`), staleTime: 10_000, enabled: !!blueprint })
export const useWall = () => useQuery({ queryKey: keys.wall, queryFn: () => call<WallResponse>('/v1/wall'), staleTime: 10_000 })
export const useEntities = (blueprint: string, params: URLSearchParams, enabled = true) =>
  useQuery({ queryKey: keys.entities(blueprint, params.toString()), queryFn: () => call<EntitiesResponse>(`/v1/entities?blueprint=${enc(blueprint)}&${params.toString()}`), staleTime: 10_000, placeholderData: (prev) => prev, enabled })
/** How many rows a grid asks for at once as it scrolls. */
export const BLOCK = 100

/**
 * One block of a grid's rows: a slice of the list the hub keeps for this
 * filter, sort, and grouping. The first block carries the total, the counts,
 * and the groups; every block names the version of the list it was cut from.
 */
export const useGridBlock = (blueprint: string, params: URLSearchParams, block: number, enabled = true) => {
  const q = new URLSearchParams(params)
  q.set('limit', String(BLOCK))
  q.set('offset', String(block * BLOCK))
  return useQuery({ queryKey: [...keys.entities(blueprint, params.toString()), 'block', block] as const, queryFn: () => call<EntitiesResponse>(`/v1/entities?blueprint=${enc(blueprint)}&${q.toString()}`), staleTime: 30_000, enabled, placeholderData: (prev: EntitiesResponse | undefined) => prev })
}

/**
 * How a grid's rows share out each column, asked apart from the rows: it is
 * the slowest part of a grid's answer, so the rows show first and the counts
 * fill in. It is asked again when the list it counts changes (`version`), and
 * the counts on screen stay until the new ones come.
 */
export const useGridShares = (blueprint: string, params: URLSearchParams, version: number, enabled = true) => {
  const q = new URLSearchParams(params)
  q.set('distribution', 'only')
  return useQuery({ queryKey: [...keys.entities(blueprint, params.toString()), 'shares', version] as const, queryFn: () => call<EntitiesResponse>(`/v1/entities?blueprint=${enc(blueprint)}&${q.toString()}`), staleTime: 30_000, enabled, placeholderData: (prev: EntitiesResponse | undefined) => prev })
}

/** Every row a grid's filter matches, as references: what ticking them all reaches. */
export const fetchMatching = (blueprint: string, params: URLSearchParams) => {
  const q = new URLSearchParams()
  for (const k of ['state', 'filter', 'hidden']) {
    const v = params.get(k)
    if (v) q.set(k, v)
  }
  return call<{ refs: EntityRef[]; owners: string[]; hidden: boolean; version: number }>(`/v1/entities/refs?blueprint=${enc(blueprint)}&${q.toString()}`)
}

/**
 * The next page of the entities of `blueprint` whose `relation` points at
 * `target`, in the order an entity's page lists them: from `offset` for the
 * first page past what the page was sent, then `after` the cursor each answer
 * gives.
 */
export function readPointing(blueprint: string, relation: string, target: EntityRef, from: { offset: number } | { after: string }): Promise<EntitiesResponse> {
  const at = 'after' in from ? `after=${enc(from.after)}` : `offset=${from.offset}`
  return call<EntitiesResponse>(`/v1/entities?blueprint=${enc(blueprint)}&limit=100&fields=&relations=&filter=${enc(JSON.stringify({ relation, target: entityId(target) }))}&${at}`)
}

/** Entities of one blueprint that match what was typed, for picking a relation's target. */
export const useEntitySearch = (blueprint: string, query: string) =>
  useQuery({
    queryKey: keys.entities(blueprint, `search:${query}`),
    queryFn: () => call<EntitiesResponse>(`/v1/entities?blueprint=${enc(blueprint)}&limit=40&fields=&relations=${query ? `&filter=${enc(JSON.stringify({ search: query }))}` : ''}`),
    staleTime: 10_000,
    placeholderData: (prev) => prev,
  })
/** Entities of every blueprint this person sees whose key, title, or values hold the words. Nothing is asked until there are words. */
export const useSearch = (query: string) =>
  useQuery({
    queryKey: ['search', query] as const,
    queryFn: () => call<EntitiesResponse>(`/v1/entities?limit=100&fields=&relations=&filter=${enc(JSON.stringify({ search: query }))}`),
    enabled: query.length > 0,
    staleTime: 10_000,
    placeholderData: (prev) => prev,
  })
export const useEntity = (ref: EntityRef) => useQuery({ queryKey: keys.entity(ref), queryFn: () => call<EntityPageResponse>(`${entityPath(ref)}?provenance=true`) })
export const useChanges = (params: URLSearchParams, enabled: boolean) => useQuery({ queryKey: keys.changes(params.toString()), queryFn: () => call<ChangesResponse>(`/v1/changes?${params.toString()}`), staleTime: 5_000, placeholderData: (prev) => prev, enabled })
/** What costs the hub over the last hours. It moves with every call, so it is read again each minute while it is on screen. */
export const useLoad = (hours: number, enabled: boolean) => useQuery({ queryKey: keys.load(hours), queryFn: () => call<LoadResponse>(`/v1/load?hours=${hours}`), staleTime: 30_000, refetchInterval: 60_000, placeholderData: (prev) => prev, enabled })
/** Sets every budget at once. What the Load page says of them is read again. */
export function useSaveBudgets() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (budgets: Budgets) => call<Budgets>('/v1/budgets', { method: 'PUT', body: JSON.stringify(budgets) }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['load'] })
    },
  })
}
export const useRoles = () => useQuery({ queryKey: keys.roles, queryFn: () => call<RolesResponse>('/v1/roles'), staleTime: 30_000 })
export const useUsers = () => useQuery({ queryKey: keys.users, queryFn: () => call<UsersResponse>('/v1/users'), staleTime: 10_000 })
export const useSources = () => useQuery({ queryKey: keys.sources, queryFn: () => call<SourcesResponse>('/v1/sources'), staleTime: 10_000 })
export const useSource = (id: string) => useQuery({ queryKey: keys.source(id), queryFn: () => call<SourceDetailResponse>(`/v1/sources/${enc(id)}`), staleTime: 5_000 })
export const useTokens = (enabled: boolean) => useQuery({ queryKey: keys.tokens, queryFn: () => call<{ tokens: TokenSummary[] }>('/v1/tokens'), enabled })
export const useRules = () => useQuery({ queryKey: keys.rules, queryFn: () => call<RulesResponse>('/v1/rules'), staleTime: 30_000 })
/** The estate's column standard every grid opens with. It changes with the model, so it is read again when the blueprints move. */
export const useGridStandard = () => useQuery({ queryKey: keys.gridStandard, queryFn: () => call<ColumnStandard>('/v1/grid-standard'), staleTime: Infinity })
export const useGrid = (blueprint: string) => useQuery({ queryKey: keys.grid(blueprint), queryFn: () => call<GridLayout>(`/v1/grid/${enc(blueprint)}`), staleTime: Infinity })
export const useRuns = () => useQuery({ queryKey: keys.runs, queryFn: () => call<{ runs: Run[] }>('/v1/runs'), staleTime: 5_000 })

export function useSaveGrid(blueprint: string) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (patch: GridLayoutPatch) => call<GridLayout>(`/v1/grid/${enc(blueprint)}`, { method: 'PUT', body: JSON.stringify(patch) }),
    // A dropped column lands at once; a refused save brings back what the hub keeps.
    onMutate: (patch) => client.setQueryData<GridLayout>(keys.grid(blueprint), (kept) => ({ columns: [], ...kept, ...patch })),
    onSuccess: (layout) => client.setQueryData(keys.grid(blueprint), layout),
    onError: () => client.invalidateQueries({ queryKey: keys.grid(blueprint) }),
  })
}

/**
 * Shows an edit at once in every cached list and page; the refetch that
 * follows brings what depends on it. A null is left for that refetch: clearing
 * what a person set may bring a pushed value back.
 */
function showEdit(client: QueryClient, refs: EntityRef[], patch: EntityPatch): void {
  const ids = new Set(refs.map(entityId))
  const { title, icon, ...fields } = Object.fromEntries(Object.entries(patch.fields ?? {}).filter(([, v]) => v !== null && v !== undefined))
  const relations: Record<string, EntityRef[]> = {}
  for (const [name, value] of Object.entries(patch.relations ?? {})) {
    if (value !== null) relations[name] = (Array.isArray(value) ? value : [value]).map(parseEntityId).filter((r): r is EntityRef => !!r)
  }
  const apply = <T extends Entity>(e: T): T =>
    ids.has(e.id) ? { ...e, ...(typeof title === 'string' ? { title } : {}), ...(typeof icon === 'string' ? { icon } : {}), fields: { ...e.fields, ...fields }, relations: { ...e.relations, ...relations } } : e
  client.setQueriesData<EntitiesResponse>({ queryKey: ['entities'] }, (old) => old && { ...old, entities: old.entities.map(apply) })
  for (const ref of refs) client.setQueryData<EntityPageResponse>(keys.entity(ref), (old) => old && apply(old))
}

/** A person's edit to one entity, from wherever its value is shown. */
export function useEditEntity() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ ref, patch }: { ref: EntityRef; patch: EntityPatch }) => call<EntityPageResponse>(entityPath(ref), { method: 'PATCH', body: JSON.stringify(patch) }),
    onMutate: async ({ ref, patch }) => {
      await client.cancelQueries({ queryKey: ['entities'] })
      showEdit(client, [ref], patch)
    },
    onSettled: (_data, _error, { ref }) => {
      void client.invalidateQueries({ queryKey: keys.entity(ref) })
      void client.invalidateQueries({ queryKey: ['entities'] })
    },
  })
}

/** One edit to many entities. The answer names each entity that refused it. */
/** The rows a bulk change reaches: named one by one, or every row a filter matches but the ones left out. */
export type BulkTarget = { entities: EntityRef[]; query?: never } | { query: EntityQuery; entities?: never }

export function useBulkEdit() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (input: EntityPatch & BulkTarget & { hidden?: boolean }) => call<BulkEditResponse>('/v1/entities/bulk', { method: 'POST', body: JSON.stringify(input) }),
    onMutate: async ({ entities, fields, relations }) => {
      await client.cancelQueries({ queryKey: ['entities'] })
      // Rows named one by one change on screen at once; rows reached through a filter change when the grid reads them again.
      if (entities) showEdit(client, entities, { fields, relations })
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['entity'] })
      void client.invalidateQueries({ queryKey: ['entities'] })
      void client.invalidateQueries({ queryKey: keys.wall })
    },
  })
}

/** Deletes entities made in the web app. Anything a source owns refuses. */
export function useDeleteEntities() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (target: BulkTarget) => call<BulkEditResponse>('/v1/entities/delete', { method: 'POST', body: JSON.stringify(target) }),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['entity'] })
      void client.invalidateQueries({ queryKey: ['entities'] })
      void client.invalidateQueries({ queryKey: keys.wall })
    },
  })
}

export function useEntityAction(ref: EntityRef) {
  const client = useQueryClient()
  const done = () => {
    void client.invalidateQueries({ queryKey: keys.entity(ref) })
    void client.invalidateQueries({ queryKey: ['entities'] })
    void client.invalidateQueries({ queryKey: keys.wall })
  }
  return {
    hide: useMutation({ mutationFn: (hidden: boolean) => call(`${entityPath(ref)}/hidden`, { method: 'PUT', body: JSON.stringify({ hidden }) }), onSuccess: done }),
    remove: useMutation({ mutationFn: () => call(entityPath(ref), { method: 'DELETE' }), onSuccess: done }),
    cleanup: useMutation({ mutationFn: () => call(`${entityPath(ref)}/cleanup`, { method: 'POST' }), onSuccess: done }),
  }
}

export function useCreateEntity() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (input: { blueprint: string; key: string; title: string; icon?: string; fields?: Record<string, unknown> }) => call<EntityPageResponse>('/v1/entities', { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['entities'] }),
  })
}

export function useSaveBlueprint() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ id, spec }: { id: string; spec: Record<string, unknown> }) => call<Blueprint>(`/v1/blueprints/${enc(id)}`, { method: 'PUT', body: JSON.stringify(spec) }),
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.blueprints }),
  })
}

/** Sets who sees one of the hub's own blueprints. Null puts it back to admins only. */
export function useSetHubAccess() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ id, access }: { id: string; access: AccessRule | null }) => call<Blueprint>(`/v1/access/hub-blueprints/${enc(id)}`, { method: 'PUT', body: JSON.stringify({ access }) }),
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.blueprints }),
  })
}

/** Renames a blueprint with everything it holds. Every list is stale afterwards, so every query is asked again. */
export function useRenameBlueprint() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ id, to }: { id: string; to: string }) => call<Blueprint>(`/v1/blueprints/${enc(id)}/rename`, { method: 'POST', body: JSON.stringify({ to }) }),
    onSuccess: () => void client.invalidateQueries(),
  })
}

export const useTemplates = (enabled: boolean) => useQuery({ queryKey: ['model', 'templates'], queryFn: () => call<{ templates: ModelTemplate[] }>('/v1/model/templates'), enabled, staleTime: Infinity })

export function useImportModel() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (what: { template: string } | { yaml: string }) => call<ImportReport>('/v1/model/import', { method: 'POST', body: JSON.stringify(what) }),
    onSuccess: () => void client.invalidateQueries(),
  })
}

export function useDeleteBlueprint() {
  const client = useQueryClient()
  return useMutation({ mutationFn: (id: string) => call(`/v1/blueprints/${enc(id)}`, { method: 'DELETE' }), onSuccess: () => void client.invalidateQueries({ queryKey: keys.blueprints }) })
}

export function useSaveRule() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ id, spec }: { id: string; spec: Record<string, unknown> }) => call(`/v1/rules/${enc(id)}`, { method: 'PUT', body: JSON.stringify(spec) }),
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.rules }),
  })
}

export function useDeleteRule() {
  const client = useQueryClient()
  return useMutation({ mutationFn: (id: string) => call(`/v1/rules/${enc(id)}`, { method: 'DELETE' }), onSuccess: () => void client.invalidateQueries({ queryKey: keys.rules }) })
}

export function useSaveSource() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ id, spec }: { id: string; spec: Record<string, unknown> }) => call(`/v1/sources/${enc(id)}`, { method: 'PUT', body: JSON.stringify(spec) }),
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.sources }),
  })
}

export function useDeleteSource() {
  const client = useQueryClient()
  return useMutation({ mutationFn: (id: string) => call(`/v1/sources/${enc(id)}`, { method: 'DELETE' }), onSuccess: () => void client.invalidateQueries({ queryKey: keys.sources }) })
}

export function useRefreshSource() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => call<{ errors: { file: string; reason: string }[] }>(`/v1/sources/${enc(id)}/refresh`, { method: 'POST' }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.sources })
      void client.invalidateQueries({ queryKey: keys.blueprints })
      void client.invalidateQueries({ queryKey: ['source'] })
    },
  })
}

/** Sets a part of how the list of blueprints is laid out, for everyone. */
export function useSetCatalogLayout() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (patch: CatalogLayoutPatch) => call<CatalogLayout>('/v1/catalog/layout', { method: 'PUT', body: JSON.stringify(patch) }),
    onSettled: () => void client.invalidateQueries({ queryKey: keys.blueprints }),
  })
}

/** Sets the picture a person shows everyone in place of their photo, or null for their photo again. */
export function usePickPicture() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (icon: string | null) => call<MyPerson>('/v1/mine/picture', { method: 'PUT', body: JSON.stringify({ icon }) }),
    onSuccess: (person) => {
      client.setQueryData<WhoAmIResponse>(keys.whoami, (old) => old && { ...old, person })
      if (person.entity) void client.invalidateQueries({ queryKey: keys.entity(person.entity) })
    },
  })
}

export function useSaveRole() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...spec }: Pick<RoleDef, 'id' | 'title' | 'description' | 'permissions'>) => call<RoleDef>(`/v1/roles/${enc(id)}`, { method: 'PUT', body: JSON.stringify(spec) }),
    onMutate: (role) => client.setQueryData<RolesResponse>(keys.roles, (old) => old && { roles: old.roles.map((r) => (r.id === role.id ? { ...r, ...role } : r)) }),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: keys.roles })
      void client.invalidateQueries({ queryKey: keys.whoami })
    },
  })
}

export function useDeleteRole() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => call(`/v1/roles/${enc(id)}`, { method: 'DELETE' }),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: keys.roles })
      void client.invalidateQueries({ queryKey: keys.users })
    },
  })
}

export function useSetUserRoles() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ email, roles }: { email: string; roles: string[] }) => call<User>(`/v1/users/${enc(email)}/roles`, { method: 'PUT', body: JSON.stringify({ roles }) }),
    onMutate: ({ email, roles }) => client.setQueryData<UsersResponse>(keys.users, (old) => old && { users: old.users.map((u) => (u.email === email ? { ...u, roles } : u)) }),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: keys.users })
      void client.invalidateQueries({ queryKey: keys.whoami })
    },
  })
}

export function useAddUser() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (input: { email: string; roles: string[] }) => call<User>('/v1/users', { method: 'POST', body: JSON.stringify(input) }),
    onSettled: () => void client.invalidateQueries({ queryKey: keys.users }),
  })
}

export function useRemoveUser() {
  const client = useQueryClient()
  return useMutation({ mutationFn: (email: string) => call(`/v1/users/${enc(email)}`, { method: 'DELETE' }), onSettled: () => void client.invalidateQueries({ queryKey: keys.users }) })
}

export function useIssueToken() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (input: { kind: 'source' | 'access'; name: string; role?: string; source?: string }) => call<TokenIssued>('/v1/tokens', { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.tokens }),
  })
}

export function useRevokeToken() {
  const client = useQueryClient()
  return useMutation({ mutationFn: (id: string) => call(`/v1/tokens/${enc(id)}`, { method: 'DELETE' }), onSuccess: () => void client.invalidateQueries({ queryKey: keys.tokens }) })
}

export const useMyTokens = (enabled: boolean) => useQuery({ queryKey: keys.myTokens, queryFn: () => call<{ tokens: TokenSummary[] }>('/v1/me/tokens'), enabled })

export function useMyTokenActions() {
  const client = useQueryClient()
  const done = () => void client.invalidateQueries({ queryKey: keys.myTokens })
  return {
    issue: useMutation({ mutationFn: (name: string) => call<TokenIssued>('/v1/me/tokens', { method: 'POST', body: JSON.stringify({ name }) }), onSuccess: done }),
    rotate: useMutation({ mutationFn: (id: string) => call<TokenIssued>(`/v1/me/tokens/${enc(id)}/rotate`, { method: 'POST' }), onSuccess: done }),
    revoke: useMutation({ mutationFn: (id: string) => call(`/v1/me/tokens/${enc(id)}`, { method: 'DELETE' }), onSuccess: done }),
  }
}

export const useAccessSettings = () => useQuery({ queryKey: keys.access, queryFn: () => call<AccessSettingsResponse>('/v1/access'), staleTime: 30_000 })

/** The security posture: every rule, judged for every person and token, with the findings. An admin's alone. */
export const usePosture = (enabled: boolean) => useQuery({ queryKey: ['posture'], queryFn: () => call<PostureResponse>('/v1/posture'), enabled, staleTime: 10_000 })
export const usePostureReach = (who: { kind: 'person' | 'token'; name: string } | null) =>
  useQuery({ queryKey: ['posture', 'reach', who?.kind, who?.name], queryFn: () => call<PostureReach>(`/v1/posture/reach?kind=${who!.kind}&name=${enc(who!.name)}`), enabled: !!who, staleTime: 10_000 })
export const usePostureWho = (target: string | null) => useQuery({ queryKey: ['posture', 'who', target], queryFn: () => call<PostureWho>(`/v1/posture/who?target=${enc(target!)}`), enabled: !!target, staleTime: 10_000 })
/** Who changes what by hand, with the standing overrides; with a person, what the edit rules open to them. */
export const useEdits = (person: string | null) => useQuery({ queryKey: ['posture', 'edits', person], queryFn: () => call<EditsResponse>(`/v1/posture/edits${person ? `?person=${enc(person)}` : ''}`), staleTime: 10_000 })
/** The audiences and field classes. An admin's to read, or a holder of posture.read's. */
export const usePolicy = (enabled: boolean) => useQuery({ queryKey: ['posture', 'policy'], queryFn: () => call<PolicyState>('/v1/posture/policy'), enabled, staleTime: 30_000 })

/** A new policy: previewed, and saved when `save` is true. */
export function usePolicyChange() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ policy, save }: { policy: AccessPolicy; save: boolean }) => call<PolicyPreview>('/v1/posture/policy', { method: 'POST', body: JSON.stringify({ policy, save }) }),
    onSuccess: (result) => {
      if (!result.saved) return
      void client.invalidateQueries({ queryKey: ['posture'] })
      void client.invalidateQueries({ queryKey: keys.blueprints })
    },
  })
}

/** Marks blueprints reviewed as they stand. */
export function useMarkReviewed() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (blueprints: string[]) => call<{ reviewed: string[] }>('/v1/posture/review', { method: 'POST', body: JSON.stringify({ blueprints }) }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['posture'] }),
  })
}

export function usePostureChange() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ change, save }: { change: PostureChange; save: boolean }) => call<PosturePreview>('/v1/posture/change', { method: 'POST', body: JSON.stringify({ change, save }) }),
    onSuccess: (result) => {
      if (!result.saved) return
      void client.invalidateQueries({ queryKey: ['posture'] })
      void client.invalidateQueries({ queryKey: keys.blueprints })
      void client.invalidateQueries({ queryKey: keys.actions })
      void client.invalidateQueries({ queryKey: keys.access })
    },
  })
}

export function useSetPerson() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (person: PersonSetting | null) => call<AccessSettingsResponse>('/v1/access/person', { method: 'PUT', body: JSON.stringify(person) }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.access })
      void client.invalidateQueries({ queryKey: keys.blueprints })
      void client.invalidateQueries({ queryKey: keys.mine })
    },
  })
}

/** How long to wait before opening a stream the hub refused. */
const REOPEN_MS = 5_000

/**
 * Marks what moved as stale. A page in view reads it again at once; a page
 * in a hidden tab reads it again only when it comes back into view, so a tab
 * left open in the background asks the hub nothing.
 */
export function markStale(client: QueryClient, filters: InvalidateQueryFilters = {}): Promise<void> {
  return client.invalidateQueries({ ...filters, refetchType: focusManager.isFocused() ? 'active' : 'none' })
}

/** Keeps queries fresh from the server's event stream. */
export function useLiveUpdates(client: QueryClient): void {
  useEffect(() => {
    // The blueprints that moved since the grids were last told, gathered so a burst of changes reads each grid once. Null is everything.
    // A title that moved also moves the grids that show it beside their rows.
    let moved: Set<string> | null = new Set()
    let titled = new Set<string>()
    const invalidateEstate = debounce(() => {
      void markStale(client, { queryKey: keys.wall })
      void markStale(client, { queryKey: keys.summary })
      void markStale(client, { queryKey: keys.mine })
      void markStale(client, { queryKey: keys.alerts })
      void markStale(client, { queryKey: ['scorecard'] })
      // A grid is read again when its blueprint moved, or one it shows beside it: what its rows point at and what points at them.
      const changed = moved
      const renamed = titled
      moved = new Set()
      titled = new Set()
      const all = client.getQueryData<BlueprintsResponse>(keys.blueprints)?.blueprints ?? []
      const beside = (bp: string): string[] => [...Object.values(all.find((b) => b.id === bp)?.relations ?? {}).map((r) => r.target), ...all.filter((b) => Object.values(b.relations).some((r) => r.target === bp)).map((b) => b.id)]
      // A ground or a map names the blueprints it read; one from a hub that names none may read anything.
      const movesRead = (q: { state: { data: unknown } }): boolean => {
        const reads = (q.state.data as { reads?: string[] } | undefined)?.reads
        return !changed || !reads || reads.some((b) => changed.has(b) || beside(b).some((n) => renamed.has(n)))
      }
      void markStale(client, { queryKey: keys.grounds, predicate: movesRead })
      void markStale(client, { queryKey: keys.maps, predicate: movesRead })
      // A grid reads what its list reads, as the hub told it with the first block, and the titles of what it shows beside its rows.
      const readsOf = (q: { queryKey: readonly unknown[] }): string[] | null => {
        const head = client.getQueryData<EntitiesResponse>([...q.queryKey.slice(0, 3), 'block', 0])
        return head?.reads === undefined ? [String(q.queryKey[1])] : head.reads
      }
      void markStale(client, { queryKey: ['entities'], predicate: (q) => {
        const bp = String(q.queryKey[1])
        const reads = readsOf(q)
        return !changed || !reads || reads.some((b) => changed.has(b)) || beside(bp).some((b) => renamed.has(b))
      } })
      // The favorites table reads the blueprints it holds rows of.
      void markStale(client, { queryKey: keys.starsTable, predicate: (q) => {
        const holds = Object.keys((q.state.data as QueryResult | undefined)?.counts ?? {})
        return !changed || holds.some((b) => changed.has(b) || beside(b).some((n) => renamed.has(n)))
      } })
      void markStale(client, { queryKey: ['changes'] })
      void markStale(client, { queryKey: keys.sources })
    }, 800)
    // The actions follow the estate where `actionsMoved` says so, and a person's pins are the actions they are offered.
    const reread = debounce(() => {
      void markStale(client, { queryKey: keys.actions, exact: true })
      void markStale(client, { queryKey: keys.pins })
    }, 800)
    const handle = (event: MessageEvent<string>) => {
      const parsed = JSON.parse(event.data) as ServerEvent
      if (parsed.type === 'entity') void markStale(client, { queryKey: keys.entity(parsed) })
      // A report's record moves with every edit and every edition, so its page is read again with it.
      if (parsed.type === 'entity' && parsed.blueprint === REPORT_BLUEPRINT) void markStale(client, { queryKey: keys.report(parsed.key) })
      if (parsed.type === 'entity' && parsed.blueprint === REPORT_BLUEPRINT) void markStale(client, { queryKey: ['reports'] })
      if (actionsMoved(parsed, client.getQueryData<ActionsResponse>(keys.actions))) reread()
      if (parsed.type === 'blueprints') {
        // A changed access rule changes what this person sees everywhere.
        void markStale(client, { queryKey: keys.blueprints })
        void markStale(client, { queryKey: keys.access })
        void markStale(client, { queryKey: ['entity'] })
        void markStale(client, { queryKey: ['model-layout'] })
        void markStale(client, { queryKey: keys.grounds })
        void markStale(client, { queryKey: keys.maps })
        void markStale(client, { queryKey: keys.gridStandard })
        // What a person may see of their stars and pinned blueprints moves with the model and its access.
        void markStale(client, { queryKey: keys.starsTable })
        void markStale(client, { queryKey: keys.stars })
        void markStale(client, { queryKey: keys.pins })
      }
      if (parsed.type === 'actions') return void markStale(client, { queryKey: keys.actions })
      // An icon that comes or goes changes which entities show it, so the grids are read again too.
      if (parsed.type === 'icons') void markStale(client, { queryKey: keys.icons })
      if (parsed.type === 'schedules') void markStale(client, { queryKey: ['schedules'] })
      if (parsed.type === 'action_run') {
        void markStale(client, { queryKey: keys.actionRun(parsed.id) })
        // A batch says its own id when it moves as a whole; a run of one moves the batches it is in.
        void markStale(client, { queryKey: ['action-batch'] })
        // So does a change set, and a run of one moves its set.
        void markStale(client, { queryKey: ['change-set'] })
        void markStale(client, { queryKey: ['change-sets'] })
        void markStale(client, { queryKey: ['action-runs'] })
        // A scheduled run that moves moves its schedule's firing.
        void markStale(client, { queryKey: ['schedules', 'history'] })
        // Each action carries its newest run.
        void markStale(client, { queryKey: keys.actions, exact: true })
        return
      }
      if (parsed.type === 'access') {
        // A role given or changed may be this person's own.
        for (const queryKey of [keys.whoami, keys.roles, keys.users, keys.previews, ['changes']]) void markStale(client, { queryKey })
        return
      }
      if (moved) {
        if (parsed.type === 'entity') {
          moved.add(parsed.blueprint)
          if (parsed.titled) titled.add(parsed.blueprint)
        }
        else if (parsed.type === 'estate' && parsed.blueprints) for (const b of parsed.blueprints) moved.add(b)
        // What a source says of itself is laid over the hub's own source and runner entities, and nothing else.
        else if (parsed.type === 'sources') for (const b of SOURCE_STANDING) moved.add(b)
        else if (parsed.type === 'derived') {
          for (const b of parsed.blueprints) moved.add(b)
          for (const b of parsed.titled) titled.add(b)
        } else moved = null
      }
      invalidateEstate()
    }
    // A stream that drops says nothing of why. Asking who this is finds an ended sign-in, on a page nobody is touching too.
    const ask = debounce(() => void call('/v1/whoami').catch(() => {}), 2_000)
    // The browser opens a stream that ended again by itself; one refused outright, as by a hub between releases, is opened again here.
    let source: EventSource | null = null
    let reopen: ReturnType<typeof setTimeout> | null = null
    let dropped = false
    const open = () => {
      const stream = new EventSource(asViewed('/v1/events'))
      source = stream
      for (const type of ['entity', 'estate', 'derived', 'blueprints', 'sources', 'access', 'actions', 'action_run', 'icons']) stream.addEventListener(type, handle)
      stream.addEventListener('hello', (event: MessageEvent<string>) => {
        noteServed((JSON.parse(event.data) as StreamHello).version)
        // A stream that dropped missed what changed meanwhile, perhaps a whole release: everything shown is read again.
        if (dropped) void markStale(client)
        dropped = false
      })
      stream.addEventListener('error', () => {
        dropped = true
        ask()
        if (stream.readyState === EventSource.CLOSED) reopen = setTimeout(open, REOPEN_MS)
      })
    }
    open()
    return () => {
      if (reopen) clearTimeout(reopen)
      source?.close()
    }
  }, [client])
}

function debounce(fn: () => void, ms: number): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  return () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(fn, ms)
  }
}

// Scorecards, checks, alerts, secrets ------------------------------------------

export const useScorecards = () => useQuery({ queryKey: ['scorecards'], queryFn: () => call<{ scorecards: Scorecard[] }>('/v1/scorecards'), staleTime: 30_000 })
const scorecardResults = (id: string) => ({ queryKey: ['scorecard', id, 'results'], queryFn: () => call<ScorecardResults>(`/v1/scorecards/${enc(id)}/results`), staleTime: 10_000 })
const scorecardTrend = (id: string) => ({ queryKey: ['scorecard', id, 'trend'], queryFn: () => call<ScorecardTrend>(`/v1/scorecards/${enc(id)}/trend?days=30`), staleTime: 60_000 })
/** Every scorecard's results and trend at once, in the order given: what the page needs to set them side by side. */
export function useScorecardReadings(ids: string[]) {
  const results = useQueries({ queries: ids.map(scorecardResults) })
  const trends = useQueries({ queries: ids.map(scorecardTrend) })
  return ids.map((id, i) => ({ id, results: results[i]!, trend: trends[i]! }))
}
export const useAlerts = () => useRemembered<{ alerts: Alert[] }>('alerts', '/v1/alerts', 10_000)
export const useAlertRules = () => useQuery({ queryKey: ['alert-rules'], queryFn: () => call<{ rules: AlertRule[] }>('/v1/alert-rules'), staleTime: 30_000 })
export const useChecks = () => useQuery({ queryKey: ['checks'], queryFn: () => call<{ checks: AssignedCheckView[] }>('/v1/checks'), staleTime: 10_000 })
export const useSecrets = (enabled: boolean) => useQuery({ queryKey: ['secrets'], queryFn: () => call<{ secrets: { name: string; updatedAt: string }[] }>('/v1/secrets'), enabled })

export function useSaveScorecard() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ id, spec }: { id: string; spec: Record<string, unknown> }) => call<Scorecard>(`/v1/scorecards/${enc(id)}`, { method: 'PUT', body: JSON.stringify(spec) }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['scorecards'] }),
  })
}
export function useDeleteScorecard() {
  const client = useQueryClient()
  return useMutation({ mutationFn: (id: string) => call(`/v1/scorecards/${enc(id)}`, { method: 'DELETE' }), onSuccess: () => void client.invalidateQueries({ queryKey: ['scorecards'] }) })
}
export function useSaveAlertRule() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ id, spec }: { id: string; spec: Record<string, unknown> }) => call(`/v1/alert-rules/${enc(id)}`, { method: 'PUT', body: JSON.stringify(spec) }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['alert-rules'] }),
  })
}
export function useDeleteAlertRule() {
  const client = useQueryClient()
  return useMutation({ mutationFn: (id: string) => call(`/v1/alert-rules/${enc(id)}`, { method: 'DELETE' }), onSuccess: () => void client.invalidateQueries({ queryKey: ['alert-rules'] }) })
}
export function useSetSecret() {
  const client = useQueryClient()
  return useMutation({ mutationFn: ({ name, value }: { name: string; value: string }) => call(`/v1/secrets/${enc(name)}`, { method: 'PUT', body: JSON.stringify({ value }) }), onSuccess: () => void client.invalidateQueries({ queryKey: ['secrets'] }) })
}
export function useDeleteSecret() {
  const client = useQueryClient()
  return useMutation({ mutationFn: (name: string) => call(`/v1/secrets/${enc(name)}`, { method: 'DELETE' }), onSuccess: () => void client.invalidateQueries({ queryKey: ['secrets'] }) })
}

export const useModelLayout = () => useQuery({ queryKey: ['model-layout'], queryFn: () => call<ModelLayout>('/v1/model/layout'), staleTime: 30_000 })

/** Where the reader's own view of the model would place its cards. It saves nothing, so it is asked fresh each time. */
export const usePlaceModel = () => useMutation({ mutationFn: (ask: ModelPlaceRequest) => call<ModelPlacement>('/v1/model/layout/place', { method: 'POST', body: JSON.stringify(ask) }) })

/** Saves part of the shared model layout. A null position hands a blueprint back to automatic placement. */
export function useSaveModelLayout() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (patch: { positions?: Record<string, { x: number; y: number } | null>; hidden?: string[]; rearrange?: boolean }) => call<ModelLayout>('/v1/model/layout', { method: 'PUT', body: JSON.stringify(patch) }),
    onMutate: (patch) => {
      // A rearrangement is the hub's to lay out: the old places stand until its answer.
      if (patch.rearrange) return
      client.setQueryData<ModelLayout>(['model-layout'], (cur) => {
        const positions = { ...(cur?.positions ?? {}) }
        for (const [id, p] of Object.entries(patch.positions ?? {})) {
          if (p === null) delete positions[id]
          else positions[id] = p
        }
        return { positions, hidden: patch.hidden ?? cur?.hidden ?? [] }
      })
    },
    onSuccess: (layout, patch) => {
      client.setQueryData(['model-layout'], layout)
      // A blueprint handed back to automatic placement gets its place on the next read.
      if (Object.values(patch.positions ?? {}).some((p) => p === null)) void client.invalidateQueries({ queryKey: ['model-layout'] })
    },
  })
}

// Self-service actions ---------------------------------------------------------------

export const useActions = () => useQuery({ queryKey: keys.actions, queryFn: () => call<ActionsResponse>('/v1/actions'), staleTime: 30_000 })
export const useActionsLayout = () => useQuery({ queryKey: [...keys.actions, 'layout'], queryFn: () => call<ActionsLayout>('/v1/actions/layout'), staleTime: 30_000 })
export function useSetActionsLayout() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (patch: Partial<ActionsLayout>) => call<ActionsLayout>('/v1/actions/layout', { method: 'PUT', body: JSON.stringify(patch) }),
    onSuccess: (layout) => client.setQueryData([...keys.actions, 'layout'], layout),
  })
}
// A walk ---------------------------------------------------------------------------

/**
 * The caller's walk through one map: the stops they put on it, oldest first.
 * Null where the hub keeps none for them: a machine, or a hub one release
 * behind this page. A page then offers no stop to add.
 */
export const useWalk = (ref: EntityRef) =>
  useQuery({
    queryKey: keys.walk(ref),
    queryFn: () =>
      call<WalkResponse>(`/v1/mine/walk/${enc(ref.blueprint)}/${enc(ref.key)}`).then(
        (r): WalkStep[] | null => r.steps,
        (error: unknown) => {
          if (error instanceof CallError && (error.status === 404 || error.status === 403)) return null
          throw error
        },
      ),
    staleTime: 30_000,
  })
/** Puts a stop on the walk, or takes one off; the walk shows the change at once and takes the hub's answer. */
export function useWalkChange(ref: EntityRef) {
  const client = useQueryClient()
  const path = `/v1/mine/walk/${enc(ref.blueprint)}/${enc(ref.key)}`
  return useMutation({
    mutationFn: (change: { add: WalkStepRequest } | { remove: string }) =>
      'add' in change ? call<WalkResponse>(path, { method: 'POST', body: JSON.stringify(change.add) }) : call<WalkResponse>(`${path}/${enc(change.remove)}`, { method: 'DELETE' }),
    onMutate: async (change) => {
      await client.cancelQueries({ queryKey: keys.walk(ref) })
      client.setQueryData<WalkStep[] | null>(keys.walk(ref), (steps) =>
        !steps ? steps : 'add' in change ? [...steps, { ...change.add, id: `pending:${steps.length}`, addedAt: new Date().toISOString() }] : steps.filter((x) => x.id !== change.remove),
      )
    },
    onSuccess: (answer) => client.setQueryData(keys.walk(ref), answer.steps),
    onError: () => client.invalidateQueries({ queryKey: keys.walk(ref) }),
  })
}

// Pins -----------------------------------------------------------------------------

/**
 * What the person pinned, in their order: the one thing they arrange for
 * themselves that the hub keeps. Null from a hub that keeps no pins, one
 * release behind this page: a page then offers no star and says nothing.
 */
export const usePins = () =>
  useQuery({
    queryKey: keys.pins,
    queryFn: () =>
      call<PinsResponse>('/v1/mine/pins').then(
        (r): Pin[] | null => r.pins,
        (error: unknown) => {
          if (error instanceof CallError && error.status === 404) return null
          throw error
        },
      ),
    staleTime: 30_000,
  })
/** Every change to the pins, so each can tell whether another is on its way. */
const PINNING = ['pins', 'change'] as const
/**
 * A change to the pins that shows at once: the page holds what the change
 * will make of them, takes the hub's answer once no other change is on its
 * way, and goes back to what the hub holds when the change is refused.
 */
function usePinsChange<V>(send: (change: V) => Promise<PinsResponse>, after: (pins: Pin[], change: V) => Pin[]) {
  const client = useQueryClient()
  return useMutation({
    mutationKey: PINNING,
    mutationFn: send,
    onMutate: async (change) => {
      await client.cancelQueries({ queryKey: keys.pins })
      client.setQueryData<Pin[] | null>(keys.pins, (pins) => (pins ? after(pins, change) : pins))
    },
    onSuccess: (answer) => {
      if (client.isMutating({ mutationKey: PINNING }) === 1) client.setQueryData(keys.pins, answer.pins)
    },
    onError: () => client.invalidateQueries({ queryKey: keys.pins }),
  })
}
const samePin = (a: Pin, b: Pin) => a.kind === b.kind && a.id === b.id
/** Pins one thing after the others, or lets it go. */
export const useSetPinned = () =>
  usePinsChange(
    ({ pin, on }: { pin: Pin; on: boolean }) => call<PinsResponse>(`/v1/mine/pins/${enc(pin.kind)}/${enc(pin.id)}`, { method: on ? 'PUT' : 'DELETE' }),
    (pins, { pin, on }) => [...pins.filter((p) => !samePin(p, pin)), ...(on ? [pin] : [])],
  )
/** Puts the pins in a new order. */
export const useOrderPins = () => usePinsChange((order: Pin[]) => call<PinsResponse>('/v1/mine/pins', { method: 'PUT', body: JSON.stringify({ order } satisfies PinsOrderRequest) }), reordered)
/** An entity with its star set or let go, as the page shows it before the hub answers. */
function withStar<T extends Entity>(e: T, on: boolean): T {
  const { starred: _was, ...rest } = e
  return (on ? { ...rest, starred: true } : rest) as T
}

/**
 * Stars an entity as one of the person's favorites, or lets it go. The star
 * shows at once; the grids of its blueprint are read again, so it moves to
 * where the hub orders it, first.
 */
export function useSetStarred() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ ref, on }: { ref: EntityRef; on: boolean }) => call<StarResponse>(`/v1/mine/stars/${enc(ref.blueprint)}/${enc(ref.key)}`, { method: on ? 'PUT' : 'DELETE' }),
    onMutate: async ({ ref, on }) => {
      const id = entityId(ref)
      await client.cancelQueries({ queryKey: ['entities', ref.blueprint] })
      client.setQueriesData<EntitiesResponse>({ queryKey: ['entities', ref.blueprint] }, (old) => old && { ...old, entities: old.entities.map((e) => (e.id === id ? withStar(e, on) : e)) })
      client.setQueryData<EntityPageResponse>(keys.entity(ref), (old) => old && withStar(old, on))
    },
    onSettled: (_answer, _error, { ref }) => {
      void client.invalidateQueries({ queryKey: ['entities', ref.blueprint] })
      void client.invalidateQueries({ queryKey: keys.entity(ref) })
      void client.invalidateQueries({ queryKey: keys.starsTable })
      void client.invalidateQueries({ queryKey: keys.stars })
    },
  })
}

/** Whether the person starred anything they may see today: the side bar lists Favorites only then. A machine, which keeps no stars, reads as false. */
export const useHasStars = () =>
  useQuery({
    queryKey: [...keys.stars, viewingAs()] as const,
    queryFn: () =>
      call<StarsResponse>('/v1/mine/stars').then(
        (r) => r.stars.length > 0,
        (error: unknown) => {
          if (error instanceof CallError && error.status === 403) return false
          throw error
        },
      ),
    staleTime: 60_000,
  })

/** One table of everything the person starred and may see, across every blueprint: their favorites page. */
export const useStarsTable = () => useQuery({ queryKey: [...keys.starsTable, viewingAs()] as const, queryFn: () => call<QueryResult>('/v1/mine/stars/table'), staleTime: 30_000 })

/** Why the newest change to the pins was refused, or null when it was not. */
export function usePinsError(): unknown {
  const last = useMutationState({ filters: { mutationKey: PINNING }, select: (m) => m.state }).at(-1)
  return last?.status === 'error' ? last.error : null
}

/** How many runs a list of them reads at first. */
export const RUNS_PAGE = 50
export const useActionRuns = (params: URLSearchParams, enabled = true) => useQuery({ queryKey: keys.actionRuns(params.toString()), queryFn: () => call<ActionRunsResponse>(`/v1/action-runs?${params.toString()}`), enabled, staleTime: 5_000, placeholderData: (prev) => prev })
/**
 * The runs waiting for this person's approval: those awaiting it that the hub
 * says they may decide. None while viewing as someone. `settled` is false
 * until the hub has answered, so an empty list is not read as "nothing waits".
 */
export function useApprovals(): { runs: ActionRun[]; settled: boolean } {
  const viewing = useViewingAs()
  const me = useWhoAmI().data?.identity.name
  // A run of a change set is decided with its set: it is never one of these.
  const runs = useActionRuns(new URLSearchParams({ state: 'awaiting', limit: '100', sets: 'apart' }), !!me && !viewing)
  if (viewing) return { runs: [], settled: true }
  return { runs: (runs.data?.runs ?? []).filter((r) => r.canDecide && !r.changeSet), settled: !runs.isPending }
}
/** The change sets that wait for this person's decision, each one approval. None while viewing as someone. */
export function useSetApprovals(): ChangeSetSummary[] {
  const viewing = useViewingAs()
  const me = useWhoAmI().data?.identity.name
  const sets = useChangeSets(new URLSearchParams({ waiting: 'true' }), !!me && !viewing)
  return viewing ? [] : (sets.data?.sets ?? [])
}
/** How many runs, change sets, and schedules wait for this person's decision: the count beside the Self-service link. None while viewing as someone. */
export function useWaiting(): { runs: number; sets: number; schedules: number } {
  return { runs: useApprovals().runs.length, sets: useSetApprovals().length, schedules: useScheduleApprovals().length }
}
/** The schedules that wait for this person's decision. None while viewing as someone, or for someone who does not decide. */
export function useScheduleApprovals(): ActionSchedule[] {
  const viewing = useViewingAs()
  const decides = useCan('actions.approve')
  const schedules = useSchedulesAwaiting(decides && !viewing).data?.schedules ?? []
  return viewing ? [] : schedules
}
/** The records of the estate's approvals blueprint that wait for this person. None while viewing as someone, or from a hub that keeps none. */
export function useMyApprovals(): MyApprovals | null {
  const viewing = useViewingAs()
  const me = useWhoAmI().data?.identity
  const asked = useQuery({ queryKey: [...keys.mine, 'approvals'], queryFn: () => call<MyApprovals>('/v1/mine/approvals').catch(() => null), staleTime: 10_000, enabled: me?.kind === 'user' && !viewing })
  return viewing ? null : (asked.data ?? null)
}
/** The person's own newest runs, the ones they asked for by hand. */
export function useOwnRuns() {
  const me = useWhoAmI().data?.identity.name
  // What a person ran by hand: a schedule of theirs fires as them, but they did not run it.
  return useActionRuns(new URLSearchParams({ limit: String(RUNS_PAGE), by: me ?? '', scheduled: 'false' }), !!me)
}
export const useActionRun = (id: string) => useQuery({ queryKey: keys.actionRun(id), queryFn: () => call<ActionRun>(`/v1/action-runs/${enc(id)}`), staleTime: 2_000 })
/** Entities an action input may pick from: the active ones of the blueprint the rendered filter takes, which is what the hub accepts. */
/** The entities of the blueprints an entity input picks from that a filter takes, each blueprint in its sort, one after another. */
export function useActionOptions(blueprints: string[], filter: Filter | undefined, sort = 'title', enabled = true): { data: { entities: Entity[] } | undefined; isLoading: boolean } {
  return useQueries({
    queries: blueprints.map((blueprint) => ({
      queryKey: keys.entities(blueprint, `options:${sort}:${JSON.stringify(filter ?? null)}`),
      queryFn: () => call<EntitiesResponse>(`/v1/entities?blueprint=${enc(blueprint)}&state=active&limit=500&sort=${enc(sort)}${filter ? `&filter=${enc(JSON.stringify(filter))}` : ''}`),
      staleTime: 10_000,
      placeholderData: (prev: EntitiesResponse | undefined) => prev,
      enabled,
    })),
    combine: (results) => ({ data: results.every((r) => r.data) ? { entities: results.flatMap((r) => r.data!.entities) } : undefined, isLoading: results.some((r) => r.isLoading) }),
  })
}

/**
 * One page of what the reader may run an action on, narrowed by the inputs
 * answered above the pick, and which of those wait for approval: the targets
 * that hold `q`, or the one target `of` names. The hub searches, so the page
 * never holds every target.
 */
export const useActionTargets = (id: string, narrow: Record<string, unknown>, page: { q?: string; of?: string }, enabled = true) =>
  useQuery({
    queryKey: ['action-targets', id, JSON.stringify(narrow), page.q ?? '', page.of ?? ''],
    queryFn: () => call<ActionTargetsResponse>(`/v1/actions/${enc(id)}/targets?narrow=${enc(JSON.stringify(narrow))}&limit=${TARGET_PAGE_MAX}${page.q ? `&q=${enc(page.q)}` : ''}${page.of ? `&of=${enc(page.of)}` : ''}`),
    staleTime: 10_000,
    placeholderData: (prev) => prev,
    enabled,
  })

export function useSaveAction() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ id, spec }: { id: string; spec: Record<string, unknown> }) => call<Action>(`/v1/actions/${enc(id)}`, { method: 'PUT', body: JSON.stringify(spec) }),
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.actions }),
  })
}
export function useDeleteAction() {
  const client = useQueryClient()
  return useMutation({ mutationFn: (id: string) => call(`/v1/actions/${enc(id)}`, { method: 'DELETE' }), onSuccess: () => void client.invalidateQueries({ queryKey: keys.actions }) })
}
export function useRunAction() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ id, entity, inputs }: { id: string; entity?: EntityRef; inputs: Record<string, unknown> }) => call<ActionRun>(`/v1/actions/${enc(id)}/run`, { method: 'POST', body: JSON.stringify({ entity, inputs }) }),
    onSuccess: (run) => {
      if (run.told !== undefined) keepTold(run.id, run.told)
      void client.invalidateQueries({ queryKey: ['action-runs'] })
    },
  })
}
/** What a batch would be asked for, and on what: every entity by title, and the ones it would not run on, with why. Nothing is asked. */
export function useBatchPreview(action: string, request: BatchRequest | null) {
  return useQuery({
    queryKey: ['batch-preview', action, JSON.stringify(request)],
    queryFn: () => call<BatchPreview>(`/v1/actions/${enc(action)}/batch/preview`, { method: 'POST', body: JSON.stringify(request) }),
    enabled: !!request,
    staleTime: 15_000,
    retry: false,
  })
}
export function useStartBatch() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ action, request }: { action: string; request: BatchRequest }) => call<ActionBatchSummary>(`/v1/actions/${enc(action)}/batch`, { method: 'POST', body: JSON.stringify(request) }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['action-runs'] })
      void client.invalidateQueries({ queryKey: ['action-batches'] })
    },
  })
}
/** A batch with each entity's newest run. While runs are open it is read again as the event stream says they move, and every few seconds besides. */
export const useActionBatch = (id: string) =>
  useQuery({ queryKey: keys.actionBatch(id), queryFn: () => call<ActionBatchResponse>(`/v1/action-batches/${enc(id)}`), staleTime: 2_000, refetchInterval: (q) => (q.state.data && q.state.data.done ? false : 5_000) })
export const useActionBatches = (action?: string) => useQuery({ queryKey: ['action-batches', action ?? ''], queryFn: () => call<ActionBatchesResponse>(`/v1/action-batches${action ? `?action=${enc(action)}` : ''}`), staleTime: 5_000 })
/** Stopping a batch, or asking again on some of its entities. */
export function useBatchControl(id: string) {
  const client = useQueryClient()
  const settle = () => {
    void client.invalidateQueries({ queryKey: keys.actionBatch(id) })
    void client.invalidateQueries({ queryKey: ['action-batches'] })
    void client.invalidateQueries({ queryKey: ['action-runs'] })
  }
  return {
    stop: useMutation({ mutationFn: () => call<ActionBatchSummary>(`/v1/action-batches/${enc(id)}/stop`, { method: 'POST' }), onSettled: settle }),
    again: useMutation({ mutationFn: (request: BatchAgainRequest) => call<{ asked: number; refused: BatchRefusal[] }>(`/v1/action-batches/${enc(id)}/again`, { method: 'POST', body: JSON.stringify(request) }), onSettled: settle }),
    approve: useMutation({ mutationFn: () => call<BatchApproval>(`/v1/action-batches/${enc(id)}/approve`, { method: 'POST', body: '{}' }), onSettled: settle }),
  }
}
/** Where an image a run reported is read, as an image. */
export const runImageUrl = (run: string, name: string) => asViewed(`/v1/action-runs/${enc(run)}/outputs/${enc(name)}`)
/** Approving, sending back, or declining a run that waits for it, or withdrawing one the reader asked for. */
/** One change set with every run in its place. While runs are open it is read again as the event stream says they move, and every few seconds besides. */
export const useChangeSet = (id: string) =>
  useQuery({ queryKey: keys.changeSet(id), queryFn: () => call<ChangeSetResponse>(`/v1/change-sets/${enc(id)}`), staleTime: 2_000, refetchInterval: (q) => (q.state.data && (q.state.data.done || q.state.data.decision === 'pending') ? false : 5_000) })
/** The newest change sets the reader may see, as `params` narrows them: `by`, `waiting=true`. */
export const useChangeSets = (params: URLSearchParams, enabled = true) => useQuery({ queryKey: ['change-sets', params.toString()], queryFn: () => call<ChangeSetsResponse>(`/v1/change-sets?${params}`), staleTime: 5_000, enabled })
/** Deciding a change set as one, withdrawing it, or asking again for what of it failed. */
export function useChangeSetControl(id: string) {
  const client = useQueryClient()
  const settle = () => {
    void client.invalidateQueries({ queryKey: keys.changeSet(id) })
    void client.invalidateQueries({ queryKey: ['change-sets'] })
    void client.invalidateQueries({ queryKey: ['action-runs'] })
  }
  return {
    approve: useMutation({ mutationFn: (note?: string) => call<ChangeSetApproval>(`/v1/change-sets/${enc(id)}/approve`, { method: 'POST', body: JSON.stringify(note ? { note } : {}) }), onSettled: settle }),
    reject: useMutation({ mutationFn: (reason?: string) => call<ChangeSetSummary>(`/v1/change-sets/${enc(id)}/reject`, { method: 'POST', body: JSON.stringify(reason ? { reason } : {}) }), onSettled: settle }),
    withdraw: useMutation({ mutationFn: () => call<ChangeSetSummary>(`/v1/change-sets/${enc(id)}/withdraw`, { method: 'POST', body: '{}' }), onSettled: settle }),
    retry: useMutation({ mutationFn: () => call<ChangeSetSummary>(`/v1/change-sets/${enc(id)}/retry`, { method: 'POST', body: '{}' }), onSettled: settle }),
  }
}
/** Decides one run. `digest` is the statement's digest the reader was shown, for a run that states a change: an approval binds to it. */
export function useDecideRun(id: string, digest?: string) {
  const client = useQueryClient()
  const settle = () => {
    void client.invalidateQueries({ queryKey: keys.actionRun(id) })
    void client.invalidateQueries({ queryKey: ['action-runs'] })
  }
  return {
    approve: useMutation({ mutationFn: (note?: string) => call<ActionRun>(`/v1/action-runs/${enc(id)}/approve`, { method: 'POST', body: JSON.stringify({ ...(note ? { note } : {}), ...(digest ? { digest } : {}) }) }), onSettled: settle }),
    decline: useMutation({ mutationFn: (reason: string) => call<ActionRun>(`/v1/action-runs/${enc(id)}/decline`, { method: 'POST', body: JSON.stringify({ reason }) }), onSettled: settle }),
    sendBack: useMutation({ mutationFn: (note: string) => call<ActionRun>(`/v1/action-runs/${enc(id)}/return`, { method: 'POST', body: JSON.stringify({ note }) }), onSettled: settle }),
    withdraw: useMutation({ mutationFn: () => call<ActionRun>(`/v1/action-runs/${enc(id)}/withdraw`, { method: 'POST', body: '{}' }), onSettled: settle }),
  }
}
export type { ActionReport }

/**
 * The signed-in person's preferences, kept by the hub for them on every
 * device. Null for a caller who keeps none: a machine, or a hub one release
 * back that has no preferences yet.
 */
export const usePreferences = (enabled = true) =>
  useQuery({
    queryKey: keys.preferences,
    enabled,
    queryFn: () =>
      call<{ preferences: PreferenceValues }>('/v1/mine/preferences').then(
        (r): PreferenceValues | null => r.preferences,
        (error: unknown) => {
          if (error instanceof CallError && (error.status === 404 || error.status === 403)) return null
          throw error
        },
      ),
    staleTime: 60_000,
  })
/** One preference with a value it takes. */
export type PreferenceChange = { [K in PreferenceName]: { name: K; value: PreferenceValues[K] } }[PreferenceName]
/** Sets one preference. It shows at once, and goes back to what the hub holds when the hub refuses it. */
export function useSetPreference() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ name, value }: PreferenceChange) => call<{ preferences: PreferenceValues }>(`/v1/mine/preferences/${encodeURIComponent(name)}`, { method: 'PUT', body: JSON.stringify({ value }) }),
    onMutate: ({ name, value }) => client.setQueryData<PreferenceValues | null>(keys.preferences, (held) => (held ? { ...held, [name]: value } : held)),
    onSuccess: (answer) => client.setQueryData(keys.preferences, answer.preferences),
    onError: () => client.invalidateQueries({ queryKey: keys.preferences }),
  })
}

/** The welcome tour as the hub builds it for this reader. Asked for only inside its preview. */
export const useWelcome = (enabled: boolean) => useQuery({ queryKey: keys.welcome, queryFn: () => call<WelcomeResponse>('/v1/welcome'), enabled, staleTime: 60_000 })
/** What the estate sets of the tour. An admin's to read and to set. */
export const useWelcomeSettings = (enabled: boolean) => useQuery({ queryKey: keys.welcomeSettings, queryFn: () => call<{ welcome: WelcomeDef }>('/v1/access/welcome'), enabled, staleTime: 10_000 })
export function useSaveWelcome() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (welcome: Omit<WelcomeDef, 'source'>) => call<{ welcome: WelcomeDef }>('/v1/access/welcome', { method: 'PUT', body: JSON.stringify(welcome) }),
    onSuccess: (saved) => {
      client.setQueryData(keys.welcomeSettings, saved)
      void client.invalidateQueries({ queryKey: keys.welcome, exact: true })
    },
  })
}

// Queries ---------------------------------------------------------------------

export const useSavedQueries = () => useQuery({ queryKey: ['queries'], queryFn: () => call<SavedQueriesResponse>('/v1/queries'), staleTime: 10_000 })
/** The audiences the reader is in: the ones they may share a query with. */
export const useQueryAudiences = (enabled: boolean) => useQuery({ queryKey: ['queries', 'audiences'], queryFn: () => call<QueryAudiencesResponse>('/v1/queries/audiences'), staleTime: 60_000, enabled })
export const useSavedQuery = (id: string | null) => useQuery({ queryKey: ['query', id ?? ''], queryFn: () => call<SavedQuery>(`/v1/queries/${enc(id!)}`), enabled: !!id, staleTime: 10_000 })
/** Runs a query: every row it matches, read when asked, not as the grid pages. */
/**
 * The answer to what a query reads (`readOf` in `query-tabs.ts`: its sources
 * and columns), read when asked and kept while the page is open, so each open
 * query keeps its answer. Its view shapes the answer in the page and asks
 * nothing of the hub. It is read again only when asked to.
 */
export function useQueryAnswer(read: string | null) {
  return useQuery({ queryKey: ['query-answer', viewingAs(), read] as const, queryFn: () => call<QueryResult>('/v1/query', { method: 'POST', body: read! }), enabled: read !== null, staleTime: Infinity, gcTime: 30 * 60_000, refetchOnWindowFocus: false, retry: false })
}
/** Saves a query as new, or changes the one named. */
export function useSaveQuery() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ id, query }: { id: string | null; query: SaveQueryRequest }) => (id ? call<SavedQuery>(`/v1/queries/${enc(id)}`, { method: 'PUT', body: JSON.stringify(query) }) : call<SavedQuery>('/v1/queries', { method: 'POST', body: JSON.stringify(query) })),
    onSuccess: (saved) => {
      client.setQueryData(['query', saved.id], saved)
      void client.invalidateQueries({ queryKey: ['queries'] })
    },
  })
}
export function useDeleteQuery() {
  const client = useQueryClient()
  return useMutation({ mutationFn: (id: string) => call<null>(`/v1/queries/${enc(id)}`, { method: 'DELETE' }).catch((e: unknown) => (e instanceof SyntaxError ? null : Promise.reject(e))), onSuccess: () => void client.invalidateQueries({ queryKey: ['queries'] }) })
}
/** Asks for a query as a workbook and saves it where the browser saves downloads. */
export async function exportQuery(spec: QuerySpec, title: string): Promise<void> {
  const as = viewingAs()
  const response = await fetch('/v1/query/export', { method: 'POST', headers: { 'content-type': 'application/json', [SESSION_HEADER]: session, ...(as ? { [VIEW_AS_HEADER]: as } : {}) }, body: JSON.stringify({ spec, title }) })
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null
    throw new CallError(body?.error ?? `${response.status} ${response.statusText}`, response.status)
  }
  const name = /filename="([^"]+)"/.exec(response.headers.get('content-disposition') ?? '')?.[1] ?? 'query.xlsx'
  const url = URL.createObjectURL(await response.blob())
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  URL.revokeObjectURL(url)
}

// Schedules and insights ---------------------------------------------------------

export const useSchedules = () => useQuery({ queryKey: ['schedules'], queryFn: () => call<SchedulesResponse>('/v1/schedules'), staleTime: 10_000 })
/** The schedules that wait for the reader to decide them: none for someone who does not decide. */
export const useSchedulesAwaiting = (enabled = true) => useQuery({ queryKey: ['schedules', 'awaiting'], queryFn: () => call<SchedulesResponse>('/v1/schedules/awaiting'), staleTime: 10_000, enabled })
/** The firings over the last `days` of every schedule the reader may see, or of the one named. */
export const useScheduleHistory = (days: number, schedule?: string) => useQuery({ queryKey: ['schedules', 'history', days, schedule ?? ''], queryFn: () => call<ScheduleHistory>(`/v1/schedules/history?days=${days}${schedule ? `&schedule=${enc(schedule)}` : ''}`), staleTime: 10_000, placeholderData: keepPreviousData })
/** Asks for a schedule, or changes the one named: either waits for approval. */
export function useAskSchedule() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ id, request }: { id: string | null; request: ScheduleRequest }) => (id ? call<ActionSchedule>(`/v1/schedules/${enc(id)}`, { method: 'PUT', body: JSON.stringify(request) }) : call<ActionSchedule>('/v1/schedules', { method: 'POST', body: JSON.stringify(request) })),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['schedules'] }),
  })
}
/** What can be done to one schedule: decide it, pause or resume it, fire it now, or remove it. */
export function useScheduleControl(id: string) {
  const client = useQueryClient()
  const done = () => void client.invalidateQueries({ queryKey: ['schedules'] })
  const post = (what: string, body?: unknown) => call<ActionSchedule>(`/v1/schedules/${enc(id)}/${what}`, { method: 'POST', body: JSON.stringify(body ?? {}) })
  return {
    approve: useMutation({ mutationFn: () => post('approve'), onSuccess: done }),
    decline: useMutation({ mutationFn: (reason?: string) => post('decline', { reason }), onSuccess: done }),
    pause: useMutation({ mutationFn: () => post('pause'), onSuccess: done }),
    resume: useMutation({ mutationFn: () => post('resume'), onSuccess: done }),
    run: useMutation({ mutationFn: () => post('run'), onSuccess: done }),
    remove: useMutation({ mutationFn: () => call<null>(`/v1/schedules/${enc(id)}`, { method: 'DELETE' }).catch((e: unknown) => (e instanceof SyntaxError ? null : Promise.reject(e))), onSuccess: done }),
  }
}
export const useActionInsights = (days: number, enabled = true) => useQuery({ queryKey: ['action-insights', days], queryFn: () => call<ActionInsights>(`/v1/action-insights?days=${days}`), staleTime: 60_000, enabled })

/** A report's page: its record, versions, and editions. */
/** The reports the reader may see, newest edition first; with `home`, the reports of one entity. */
export const useReports = (home?: string) => useQuery({ queryKey: ['reports', home ?? null], queryFn: () => call<ReportsResponse>(`/v1/reports${home ? `?home=${enc(home)}` : ''}`), staleTime: 30_000 })
/** What a layout cannot be read for, each with its line; an empty list when it reads. Nothing is saved. */
export const checkLayout = (layout: string) => call<{ issues: LayoutIssue[] }>('/v1/reports/check', { method: 'POST', body: JSON.stringify({ layout }) })
/** Every kind of thing a query may read: the blueprints, and each dataset the reader may read, as the blueprint the query code takes it for. */
export function useQueryKinds(): Blueprint[] | undefined {
  const blueprints = useBlueprints().data?.blueprints
  const datasets = useDatasets().data?.datasets
  return useMemo(() => (blueprints ? [...blueprints, ...(datasets ?? []).map((d) => ({ ...datasetBlueprint(d), group: 'Datasets' }))] : undefined), [blueprints, datasets])
}
/** The datasets the reader may read in a query. */
export const useDatasets = () => useQuery({ queryKey: ['datasets'], queryFn: () => call<DatasetsResponse>('/v1/datasets'), staleTime: 60_000 })
/** Reads a dataset from its tool again, whatever is kept. */
export function useRefreshDataset() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => call<{ fetchedAt: string; rows: number }>(`/v1/datasets/${enc(id)}/refresh`, { method: 'POST', body: '{}' }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['datasets'] })
      void client.invalidateQueries({ queryKey: ['query-answer'] })
    },
  })
}
export const useReport = (key: string) => useQuery({ queryKey: keys.report(key), queryFn: () => call<ReportPage>(`/v1/reports/${enc(key)}`), staleTime: 30_000 })
/** One edition whole, or a preview a run drew: what it was drawn from never changes, so it is read once. */
export const useReportEdition = (key: string, number: number | null) => useQuery({ queryKey: [...keys.report(key), 'edition', number], queryFn: () => call<ReportEditionRead>(`/v1/reports/${enc(key)}/editions/${number}`), staleTime: Infinity, enabled: number !== null })
export const useReportPreview = (key: string, run: string | null) => useQuery({ queryKey: [...keys.report(key), 'preview', run], queryFn: () => call<ReportPreviewRead>(`/v1/reports/${enc(key)}/previews/${enc(run!)}`), staleTime: Infinity, enabled: run !== null })
export const useReportVersion = (key: string, version: number | null) => useQuery({ queryKey: [...keys.report(key), 'version', version], queryFn: () => call<{ layout: string }>(`/v1/reports/${enc(key)}/versions/${version}`), staleTime: Infinity, enabled: version !== null })
