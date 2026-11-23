import { useEffect, useMemo, useRef } from 'react'
import { kindOf } from '../shared/input-kinds.ts'
import { entityIdFor } from '../shared/model.ts'
import { useShownHref, visit } from './trail.ts'

export type Route =
  | { page: 'now' }
  | { page: 'wall' }
  | { page: 'inventory'; blueprint: string | null }
  | { page: 'entity'; blueprint: string; key: string }
  | { page: 'activity' }
  | { page: 'query'; id: string | null }
  | { page: 'load' }
  | { page: 'access' }
  | { page: 'security' }
  /** One source, or with none, a shelf of the keys no source holds (`access`: access and personal keys) or the check secrets. */
  | { page: 'sources'; id: string | null; shelf?: 'access' | 'secrets' }
  | { page: 'model'; id: string | null; focus?: string }
  /** `fix` opens a scorecard on one rule of one kind: the entities that fail it, at the level it holds them back from. `lens` asks for the reader's own or everything they may see, over the page's own choice. */
  | { page: 'scorecards'; id: string | null; fix?: { kind: string; rule: string }; lens?: 'yours' | 'wide' }
  | { page: 'actions'; id: string | null }
  | { page: 'action-run'; id: string }
  /** One batch: every entity it ran on, how each stands, and what each showed. */
  | { page: 'action-batch'; id: string }
  /** One change set: every run it holds, grouped by action and inputs, how each stands, and its one decision. */
  | { page: 'action-set'; id: string }
  /** The schedules the reader may see; `id` opens one of them, with every firing it made. */
  | { page: 'action-schedules'; id?: string | null }
  | { page: 'action-insights' }
  | { page: 'search' }
  /** Everything the reader starred, across every blueprint, as one table. */
  | { page: 'favorites' }
  /** The ground under a blueprint's planet: its entities, each with its numbers and budgets. `key` opens one of them. */
  | { page: 'ground'; blueprint: string | null; key?: string }
  /**
   * The map of an entity that holds others: a program, its parts, the places its things are in, and its plots. With no
   * blueprint, every entity a map can be drawn of. `at` narrows it to one place, and null to what is placed nowhere;
   * `plot` then opens one plot there, or `kind` the things of one blueprint that lie open there.
   */
  | { page: 'map'; blueprint: string | null; key?: string; at?: string | null; plot?: string; kind?: string }
  /** The reports the reader may see: the newest editions, and their own. */
  | { page: 'reports' }
  /** One report: its newest edition, or `edition`, beside `compare`; or the preview a run drew. */
  | { page: 'report'; key: string; edition?: number; compare?: number; preview?: string }

export function parseRoute({ pathname, search }: { pathname: string; search: string }): Route {
  const parts = pathname.split('/').filter(Boolean).map(decodeURIComponent)
  switch (parts[0]) {
    case 'inventory':
      return { page: 'inventory', blueprint: parts[1] ?? null }
    case 'entities':
      if (parts[1] && parts[2] !== undefined) return { page: 'entity', blueprint: parts[1], key: parts.slice(2).join('/') }
      return { page: 'inventory', blueprint: parts[1] ?? null }
    case 'activity':
    case 'timeline':
      return { page: 'activity' }
    case 'query':
      return { page: 'query', id: parts[1] ?? null }
    case 'load':
      return { page: 'load' }
    case 'access':
      return { page: 'access' }
    case 'security':
      return { page: 'security' }
    case 'blueprints':
      return { page: 'model', id: parts[1] ?? null }
    case 'sources': {
      const shelf = new URLSearchParams(search).get('shelf')
      return !parts[1] && (shelf === 'access' || shelf === 'secrets') ? { page: 'sources', id: null, shelf } : { page: 'sources', id: parts[1] ?? null }
    }
    case 'model': {
      const focus = new URLSearchParams(search).get('focus')
      return focus && !parts[1] ? { page: 'model', id: null, focus } : { page: 'model', id: parts[1] ?? null }
    }
    case 'scorecards': {
      const q = new URLSearchParams(search)
      const kind = q.get('kind')
      const rule = q.get('rule')
      const lens = q.get('lens')
      const asked: { lens?: 'yours' | 'wide' } = lens === 'yours' || lens === 'wide' ? { lens } : {}
      return parts[1] && kind && rule ? { page: 'scorecards', id: parts[1], fix: { kind, rule }, ...asked } : { page: 'scorecards', id: parts[1] ?? null, ...asked }
    }
    case 'actions':
      if (parts[1] === 'runs' && parts[2]) return { page: 'action-run', id: parts[2] }
      if (parts[1] === 'batches' && parts[2]) return { page: 'action-batch', id: parts[2] }
      if (parts[1] === 'sets' && parts[2]) return { page: 'action-set', id: parts[2] }
      if (parts[1] === 'schedules') return { page: 'action-schedules', id: parts[2] ?? null }
      if (parts[1] === 'insights') return { page: 'action-insights' }
      return { page: 'actions', id: parts[1] ?? null }
    case 'wall':
      return { page: 'wall' }
    case 'search':
      return { page: 'search' }
    case 'favorites':
      return { page: 'favorites' }
    case 'ground':
      if (parts[1] && parts[2] !== undefined) return { page: 'ground', blueprint: parts[1], key: parts.slice(2).join('/') }
      return { page: 'ground', blueprint: parts[1] ?? null }
    case 'reports': {
      if (!parts[1]) return { page: 'reports' }
      const q = new URLSearchParams(search)
      const number = (name: string) => (Number.isInteger(Number(q.get(name))) && Number(q.get(name)) > 0 ? { [name]: Number(q.get(name)) } : {})
      return { page: 'report', key: parts.slice(1).join('/'), ...number('edition'), ...number('compare'), ...(q.get('preview') ? { preview: q.get('preview')! } : {}) }
    }
    case 'map': {
      if (!parts[1] || parts[2] === undefined) return { page: 'map', blueprint: null }
      const route: Route = { page: 'map', blueprint: parts[1], key: parts.slice(2).join('/') }
      const q = new URLSearchParams(search)
      const at = q.has('nowhere') ? null : (q.get('at') ?? '')
      if (at === '') return route
      const plot = q.get('plot')
      const kind = q.get('kind')
      return { ...route, at, ...(plot ? { plot } : kind ? { kind } : {}) }
    }
    default:
      return { page: 'now' }
  }
}

/**
 * What an action's form starts from when its link says so:
 * `/actions/{id}?entity=<blueprint>:<key>&input.<name>=<value>`. A number or
 * a boolean input takes its value as typed; a many input takes the name more
 * than once. An entity, the action's or an input's, may be named by its bare
 * key when it holds no colon; a person input's bare key is of the blueprint
 * the estate says a person is. Nothing runs until the person presses Run.
 */
export function startFromSearch(search: string, inputs: Record<string, { type: string; many?: boolean; blueprint?: string | string[] }>, blueprint?: string | string[], person?: string | null): { entity?: string; inputs: Record<string, unknown> } {
  const q = new URLSearchParams(search)
  const out: { entity?: string; inputs: Record<string, unknown> } = { inputs: {} }
  // A bare key names an entity only where one blueprint is meant.
  const one = (b: string | string[] | undefined) => (typeof b === 'string' ? b : b?.length === 1 ? b[0] : undefined)
  const entity = q.get('entity')
  const target = one(blueprint)
  if (entity) out.entity = (target && entityIdFor(entity, target)) || entity
  for (const [name, def] of Object.entries(inputs)) {
    const given = q.getAll(`input.${name}`).filter((v) => v !== '')
    if (!given.length) continue
    const kind = kindOf(def.type)
    // The one blueprint a bare key is of: the one the input names, or for a person, the one the estate says a person is.
    const of = kind.picks === 'entity' ? (kind.person ? (person ?? undefined) : one(def.blueprint)) : undefined
    const typed = given
      .map((v) => (kind.defaultAs === 'number' ? Number(v) : kind.defaultAs === 'toggle' ? v === 'true' : of ? (entityIdFor(v, of) ?? v) : v))
      .filter((v) => typeof v !== 'number' || Number.isFinite(v))
    if (typed.length) out.inputs[name] = def.many ? typed : typed[0]
  }
  return out
}

export function href(route: Route): string {
  switch (route.page) {
    case 'now':
      return '/'
    case 'wall':
      return '/wall'
    case 'inventory':
      return route.blueprint ? `/inventory/${encodeURIComponent(route.blueprint)}` : '/inventory'
    case 'entity':
      return `/entities/${encodeURIComponent(route.blueprint)}/${route.key.split('/').map(encodeURIComponent).join('/')}`
    case 'activity':
      return '/activity'
    case 'query':
      return route.id ? `/query/${encodeURIComponent(route.id)}` : '/query'
    case 'load':
      return '/load'
    case 'access':
      return '/access'
    case 'security':
      return '/security'
    case 'sources':
      if (route.id) return `/sources/${encodeURIComponent(route.id)}`
      return route.shelf ? `/sources?shelf=${route.shelf}` : '/sources'
    case 'model':
      if (route.id) return `/model/${encodeURIComponent(route.id)}`
      return route.focus ? `/model?focus=${encodeURIComponent(route.focus)}` : '/model'
    case 'scorecards': {
      const q = new URLSearchParams(route.id && route.fix ? route.fix : {})
      if (route.lens) q.set('lens', route.lens)
      const path = route.id ? `/scorecards/${encodeURIComponent(route.id)}` : '/scorecards'
      return q.size ? `${path}?${q}` : path
    }
    case 'actions':
      return route.id ? `/actions/${encodeURIComponent(route.id)}` : '/actions'
    case 'action-run':
      return `/actions/runs/${encodeURIComponent(route.id)}`
    case 'action-batch':
      return `/actions/batches/${encodeURIComponent(route.id)}`
    case 'action-set':
      return `/actions/sets/${encodeURIComponent(route.id)}`
    case 'action-schedules':
      return route.id ? `/actions/schedules/${encodeURIComponent(route.id)}` : '/actions/schedules'
    case 'action-insights':
      return '/actions/insights'
    case 'search':
      return '/search'
    case 'favorites':
      return '/favorites'
    case 'ground':
      if (!route.blueprint) return '/ground'
      return `/ground/${encodeURIComponent(route.blueprint)}${route.key ? `/${route.key.split('/').map(encodeURIComponent).join('/')}` : ''}`
    case 'reports':
      return '/reports'
    case 'report': {
      const q = new URLSearchParams()
      if (route.preview) q.set('preview', route.preview)
      if (route.edition) q.set('edition', String(route.edition))
      if (route.compare) q.set('compare', String(route.compare))
      return `/reports/${encodeURIComponent(route.key)}${q.size ? `?${q}` : ''}`
    }
    case 'map': {
      if (!route.blueprint || route.key === undefined) return '/map'
      const path = `/map/${encodeURIComponent(route.blueprint)}/${route.key.split('/').map(encodeURIComponent).join('/')}`
      if (route.at === undefined) return path
      const q = new URLSearchParams()
      if (route.at === null) q.set('nowhere', '')
      else q.set('at', route.at)
      if (route.plot) q.set('plot', route.plot)
      else if (route.kind) q.set('kind', route.kind)
      return `${path}?${q.toString().replace(/^nowhere=(&|$)/, 'nowhere$1')}`
    }
  }
}

/**
 * Goes to a route. `replace` takes the place of the one shown, so Back skips
 * it: stepping from one record to the next is one visit. `start` begins a new
 * path for the breadcrumb: the main menu and a jump from the command bar go
 * there, and a link inside a page never does.
 */
export function navigate(route: Route, { replace = false, start = false }: { replace?: boolean; start?: boolean } = {}): void {
  for (const ask of guards) {
    const question = ask(route)
    if (question && !confirm(question)) return
  }
  visit(href(route), { replace, start })
  dispatchEvent(new PopStateEvent('popstate'))
}

/** The route shown: the trail's step, so a page never draws on a step that is not its own. */
export function useRoute(): Route {
  const shown = useShownHref()
  return useMemo(() => parseRoute(shown ? new URL(shown, location.origin) : location), [shown])
}

export function onLinkClick(event: React.MouseEvent<HTMLAnchorElement>, { start = false }: { start?: boolean } = {}): void {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
  event.preventDefault()
  navigate(parseRoute(new URL(event.currentTarget.href)), { start })
}

/** What a page asks before a visit takes the person elsewhere: the question, or null to let them go. Null for `to` is the tab closing or reloading. */
type Guard = (to: Route | null) => string | null
const guards = new Set<Guard>()

/**
 * Holds a person on a page that holds changes they have not saved: a visit
 * through `navigate` asks first, and so does the browser before the tab
 * closes or reloads. The browser's own Back is never held.
 */
export function useLeaveGuard(ask: Guard): void {
  const latest = useRef(ask)
  useEffect(() => {
    latest.current = ask
  })
  useEffect(() => {
    const guard: Guard = (to) => latest.current(to)
    const unload = (event: BeforeUnloadEvent) => void (guard(null) && event.preventDefault())
    guards.add(guard)
    addEventListener('beforeunload', unload)
    return () => {
      guards.delete(guard)
      removeEventListener('beforeunload', unload)
    }
  }, [])
}
