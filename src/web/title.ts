import { CircleDot, FileChartColumn, Flame, Gauge, Globe, History, LayoutGrid, LayoutList, RadioTower, Search, ShieldCheck, Sprout, Star, TableProperties, Users, Waypoints, Zap } from 'lucide-react'
import type { BlueprintNamer } from '../shared/model.ts'
import type { Route } from './router.ts'

/** What each page is called, in the top bar and in the window's title. */
export const PAGE_TITLE: Record<Route['page'], string> = { now: 'Now', inventory: 'Catalog', entity: 'Catalog', model: 'Model', scorecards: 'Scorecards', actions: 'Self-service', 'action-run': 'Self-service', 'action-batch': 'Self-service', 'action-set': 'Self-service', 'action-schedules': 'Schedules', 'action-insights': 'Self-service insights', wall: 'Status', activity: 'Activity', query: 'Query', load: 'Load', sources: 'Sources', access: 'Access', security: 'Security', search: 'Search', favorites: 'Favorites', ground: 'Ground', map: 'Map', reports: 'Reports', report: 'Reports' }

/** The picture of each page, wherever it is listed: the rail, the tab bar, the command bar, the trail. */
export const PAGE_ICON: Record<Route['page'], typeof Search> = { now: CircleDot, inventory: LayoutList, entity: LayoutList, ground: Sprout, map: Globe, actions: Zap, 'action-run': Zap, 'action-batch': Zap, 'action-set': Zap, 'action-schedules': Zap, 'action-insights': Zap, model: Waypoints, scorecards: Gauge, wall: LayoutGrid, activity: History, query: TableProperties, load: Flame, sources: RadioTower, access: Users, security: ShieldCheck, search: Search, favorites: Star, reports: FileChartColumn, report: FileChartColumn }

/** The thing a route opens, as the address alone names it: a blueprint by its name, an entity by its key, anything else by its id. */
export function thingOf(route: Route, name: BlueprintNamer): string | null {
  return (
    (route.page === 'entity' ? route.key.split('/').pop()
    : route.page === 'inventory' ? route.blueprint && name(route.blueprint)
    : route.page === 'ground' ? (route.key?.split('/').pop() ?? (route.blueprint && name(route.blueprint)))
    : route.page === 'model' ? route.id && name(route.id)
    : 'id' in route ? route.id
    : null) ?? null
  )
}

/**
 * The window's title names the page, and the thing on it, so a tab and a
 * screen reader say where you are. `said` is what the page itself says it
 * shows (`useHere` in `trail.ts`), which wins over what the address names.
 */
export function titleOf(route: Route, name: BlueprintNamer, said: string | null = null): string {
  return [said ?? thingOf(route, name), PAGE_TITLE[route.page], 'orrery'].filter(Boolean).join(' · ')
}

/** What the trail calls one step: what its page says it shows, else the thing its address names, else the page. */
export function stepName(route: Route, name: BlueprintNamer, said: string | null): string {
  return said ?? thingOf(route, name) ?? PAGE_TITLE[route.page]
}
