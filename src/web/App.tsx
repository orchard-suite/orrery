import { useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, Ellipsis, History, LayoutGrid, Leaf, Moon, PanelLeftClose, PanelLeftOpen, Search, Sun } from 'lucide-react'
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { stopViewingAs, useWaiting, useBlueprintName, useBlueprints, useHasStars, useLiveUpdates, useMine, usePreview, useRoles, useSummary, viewingAs, useWhoAmI } from './api.ts'
import { CommandProvider, useCommand } from './components/Command.tsx'
import { KindList } from './components/KindList.tsx'
import { FavoritesPage } from './components/Favorites.tsx'
import { levelOf, perspectiveOf, worse } from './now.ts'
import { Access } from './components/Access.tsx'
import { Security } from './components/Security.tsx'
import { Actions } from './components/Actions.tsx'
import { ActionRunPage } from './components/ActionRun.tsx'
import { BatchPage } from './components/Batch.tsx'
import { ChangeSetPage } from './components/ChangeSet.tsx'
import { waitingWords } from './actions.ts'
import { Activity } from './components/Activity.tsx'
import { QueryPage } from './components/Query.tsx'
import { SchedulesPage } from './components/SchedulesPage.tsx'
import { ReportPage } from './components/Report.tsx'
import { ReportsPage } from './components/Reports.tsx'
import { InsightsPage } from './components/Insights.tsx'
import { Load } from './components/Load.tsx'
import { ModelPage } from './components/Model.tsx'
import { Scorecards } from './components/Scorecards.tsx'
import { EntityPage } from './components/Entity.tsx'
import { Drawer } from './components/Drawer.tsx'
import { GroundPage } from './components/Ground.tsx'
import { MapPage } from './components/Map.tsx'
import { MyKeys } from './components/MyKeys.tsx'
import { Welcome, askFor, useGreets, useKeepTimeZone } from './components/Welcome.tsx'
import { PhoneBarProvider, PhoneBarSlot } from './components/PhoneBar.tsx'
import { Popover, MenuItem } from './components/Popover.tsx'
import { Icon } from './icons.tsx'
import { isPhoto } from '../shared/icons.ts'
import { Inventory } from './components/Inventory.tsx'
import { Now } from './components/Now.tsx'
import { SearchPage } from './components/Search.tsx'
import { Sources } from './components/Sources.tsx'
import { ErrorNote, Lamp, Link, useNarrow, WaitingBadge } from './components/ui.tsx'
import { Wall } from './components/Wall.tsx'
import { navigate, useRoute, type Route } from './router.ts'
import { setTheme, useTheme } from './theme.ts'
import { setZen, useZen } from './zen.ts'
import { useRail } from './rail.ts'
import { startTelemetry, trackPage, trackReady } from './telemetry.ts'
import { PAGE_ICON, PAGE_TITLE, titleOf } from './title.ts'
import { useScrollBack, useStep } from './trail.ts'
import { PhoneBack, RecentList, TrailBar } from './components/Trail.tsx'
import { spot } from './spots.ts'
import { can, type StatusLevel } from '../shared/model.ts'

export function App() {
  const client = useQueryClient()
  useLiveUpdates(client)
  useKeepTimeZone()
  const route = useRoute()
  const name = useBlueprintName()
  const said = useStep()?.name ?? null
  useEffect(() => {
    document.title = titleOf(route, name, said)
  }, [route, name, said])
  useScrollBack()
  const me = useWhoAmI()
  const telemetry = me.data?.telemetry === true
  useEffect(() => {
    if (telemetry) startTelemetry()
  }, [telemetry])
  useEffect(() => {
    if (telemetry) trackPage(route)
  }, [route, telemetry])
  useEffect(() => {
    if (telemetry) trackReady()
  }, [telemetry])
  const narrow = useNarrow()
  const { shown } = usePages(route)
  const [folded, fold] = useRail(route.page)
  // The catalog, the query page, and the model fill the window and scroll inside themselves; every other page scrolls as a page.
  // On a phone the query page and the model are pages that scroll, and what fills the window stops above the tab bar.
  const fills = route.page === 'inventory' || ((route.page === 'model' || route.page === 'query' || route.page === 'favorites') && !narrow)
  // The front page, the scorecards, the self-service catalog, and every layer of the atlas (all but one entity's bed) fill the window only where it is big enough to show their parts at once.
  const desk = (route.page === 'now' || route.page === 'scorecards' || (route.page === 'actions' && !route.id) || route.page === 'map' || (route.page === 'ground' && !route.key)) && !narrow
  const fill = fills ? (narrow ? 'h-[calc(100dvh-var(--tab-bar))]' : 'h-dvh') : desk ? 'min-h-dvh pb-16 desk:h-dvh desk:pb-0' : ''
  return (
    <CommandProvider pages={shown.map((p) => ({ page: p.page, to: p.to, icon: PAGE_ICON[p.page] }))}>
      <PhoneBarProvider>
        <a href="#main" className="sr-only rounded-sm bg-ink-100 px-3 py-2 font-mono text-[12px] text-ink-950 focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50">
          Skip to content
        </a>
        {/* `--rail` is the rail's width, read by whatever sits fixed beside it. */}
        <div className="md:pl-(--rail)" style={{ '--rail': folded ? '56px' : '312px' } as CSSProperties}>
          {!narrow && <Rail route={route} folded={folded} fold={fold} />}
          <div className={`flex min-w-0 flex-col px-4 md:pr-8 md:pl-4 ${fill || (narrow ? 'min-h-dvh pb-[calc(var(--tab-bar)+1rem)]' : 'min-h-dvh pb-16')}`}>
            <ViewingAsBanner />
            {narrow ? (
              <PhoneTop />
            ) : (
              <div className="flex h-10 shrink-0 items-center gap-4">
                <TrailBar />
                <FindButton />
              </div>
            )}
            {/* A hub that will not say who this is shows no page: an empty one would read as an empty estate. */}
            {me.error && !me.data ? (
              <div className="py-6">
                <ErrorNote error={me.error} />
              </div>
            ) : (
              <main id="main" tabIndex={-1} className={`outline-none ${fills ? 'min-h-0 flex-1' : desk ? 'flex-1 desk:min-h-0' : 'flex-1'}`}>
                {route.page === 'now' && <Now />}
                {route.page === 'wall' && <Wall />}
                {route.page === 'inventory' && <Inventory blueprint={route.blueprint} />}
                {route.page === 'entity' && <EntityPage blueprint={route.blueprint} entityKey={route.key} />}
                {route.page === 'ground' && <GroundPage blueprint={route.blueprint} entityKey={route.key} />}
                {route.page === 'map' && <MapPage blueprint={route.blueprint} entityKey={route.key ?? null} at={route.at} plot={route.plot} kind={route.kind} />}
                {route.page === 'activity' && <Activity />}
                {route.page === 'query' && <QueryPage id={route.id} />}
                {route.page === 'load' && <Load />}
                {route.page === 'access' && <Access />}
                {route.page === 'security' && <Security />}
                {route.page === 'sources' && <Sources id={route.id} shelf={route.shelf ?? null} />}
                {route.page === 'model' && <ModelPage id={route.id} focus={route.focus ?? null} />}
                {route.page === 'scorecards' && <Scorecards id={route.id} fix={route.fix ?? null} {...(route.lens ? { lens: route.lens } : {})} />}
                {route.page === 'actions' && <Actions id={route.id} />}
                {route.page === 'action-run' && <ActionRunPage id={route.id} />}
                {route.page === 'action-batch' && <BatchPage id={route.id} />}
                {route.page === 'action-set' && <ChangeSetPage id={route.id} />}
                {route.page === 'action-schedules' && <SchedulesPage id={route.id ?? null} />}
                {route.page === 'action-insights' && <InsightsPage />}
                {route.page === 'search' && <SearchPage />}
                {route.page === 'favorites' && <FavoritesPage />}
                {route.page === 'reports' && <ReportsPage />}
                {route.page === 'report' && <ReportPage reportKey={route.key} edition={route.edition ?? null} compare={route.compare ?? null} preview={route.preview ?? null} />}
              </main>
            )}
          </div>
        </div>
        {narrow && <TabBar route={route} />}
        <Welcome />
      </PhoneBarProvider>
    </CommandProvider>
  )
}

/**
 * Always at the top while an admin views the hub as someone else, so it is
 * never mistaken for their own view. It stays in view as the page scrolls.
 */
function ViewingAsBanner() {
  // From the stored choice, not the answer of the hub: a person who is gone makes every request fail, and the way out must still show.
  const as = viewingAs()
  const admin = useWhoAmI().data?.identity.admin
  if (!as) return null
  return (
    <div role="status" className="sticky top-0 z-40 -mx-4 flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-amber bg-amber-dim px-4 py-2 text-sm text-ink-100 md:-mr-8 md:-ml-4 md:pr-8 md:pl-4">
      <span className="min-w-0 break-words">
        Viewing as <strong>{as}</strong>. Read-only.
        {admin && <span className="text-ink-200"> They are an admin, so they see everything.</span>}
      </span>
      <button type="button" className="ml-auto rounded-md border border-ink-100 px-3 py-1 text-[13px] font-medium text-ink-100 hover:bg-ink-950/40" onClick={stopViewingAs}>
        Exit
      </button>
    </div>
  )
}

/** The pages this person may open, in the order every list of them shows, and which of them the route is on. */
function usePages(route: Route) {
  const me = useWhoAmI()
  const blueprints = useBlueprints()
  const id = me.data?.identity
  const ground = usePreview('garden')
  // Favorites is listed once the person has starred something, and while they are on it, so it never vanishes from under them.
  const starred = useHasStars().data !== false || route.page === 'favorites'
  const pages: { page: Route['page']; to: Route; shown: boolean }[] = [
    { page: 'now', to: { page: 'now' }, shown: true },
    { page: 'favorites', to: { page: 'favorites' }, shown: starred },
    { page: 'actions', to: { page: 'actions', id: null }, shown: true },
    { page: 'reports', to: { page: 'reports' }, shown: true },
    // A preview: listed only for the people an admin named.
    { page: 'ground', to: { page: 'ground', blueprint: null }, shown: ground },
    { page: 'scorecards', to: { page: 'scorecards', id: null }, shown: true },
    { page: 'model', to: { page: 'model', id: null }, shown: true },
    { page: 'inventory', to: { page: 'inventory', blueprint: route.page === 'inventory' ? route.blueprint : (blueprints.data?.blueprints[0]?.id ?? null) }, shown: true },
    { page: 'query', to: { page: 'query', id: null }, shown: true },
    { page: 'wall', to: { page: 'wall' }, shown: true },
    { page: 'activity', to: { page: 'activity' }, shown: can(id, 'audit.view') },
    { page: 'load', to: { page: 'load' }, shown: can(id, 'audit.view') },
    { page: 'sources', to: { page: 'sources', id: null }, shown: can(id, 'sources.manage') || can(id, 'tokens.manage') || can(id, 'secrets.manage') },
    { page: 'access', to: { page: 'access' }, shown: can(id, 'users.manage') || !!id?.admin },
    { page: 'security', to: { page: 'security' }, shown: !!id?.admin },
  ]
  const here: Route['page'] = route.page === 'entity' ? 'inventory' : route.page === 'action-run' || route.page === 'action-batch' || route.page === 'action-set' || route.page === 'action-schedules' || route.page === 'action-insights' ? 'actions' : route.page === 'map' ? 'ground' : route.page === 'report' ? 'reports' : route.page
  return { shown: pages.filter((p) => p.shown), here }
}

/** What a person comes to every day, at the top of the rail; the rest is how the hub is run, at its foot. */
/** The pages people use every day, a row each at the top of the rail. */
const DAILY: Route['page'][] = ['now', 'favorites', 'actions', 'reports']
/** The pages that look at the estate whole, a row of tiles under the daily ones. Every other page but the catalog runs the hub, behind Hub at the foot. */
const ESTATE: Route['page'][] = ['ground', 'scorecards', 'model']
/** Whole class names for a row of one to three tiles, so the stylesheet keeps each one. */
const TILE_COLUMNS = ['', 'grid-cols-1', 'grid-cols-2', 'grid-cols-3'] as const

const mark = (
    <svg viewBox="0 0 32 32" className="size-6" aria-hidden>
      <circle cx="16" cy="16" r="13" className="fill-none stroke-ink-300" strokeWidth="1.2" />
      <circle cx="16" cy="16" r="7" className="fill-none stroke-ink-400" strokeWidth="1" />
      <circle cx="16" cy="16" r="2.2" className="fill-amber" />
      <circle cx="23" cy="16" r="1.6" className="fill-green" />
      <circle cx="9.5" cy="9" r="1.4" className="fill-red" />
    </svg>
)

const logo = (
  <Link start to={{ page: 'now' }} className="flex items-center gap-2.5">
    {mark}
    <span className="text-lg font-semibold tracking-tight">orrery</span>
  </Link>
)

/** Who is signed in and what they hold. Its menu holds their own entity's page where the estate holds one they may see, for a person who signs in their keys and the tour, and the hub's version. */
function Account({ compact = false }: { compact?: boolean }) {
  const me = useWhoAmI()
  const roles = useRoles()
  const [menu, setMenu] = useState<HTMLElement | null>(null)
  const [keys, setKeys] = useState(false)
  const greets = useGreets()
  const id = me.data?.identity
  if (!id) return null
  const held = id.admin ? 'Admin' : id.roles.map((r) => roles.data?.roles.find((x) => x.id === r)?.title ?? r).join(', ') || 'reads only'
  // Only a person who signs in has keys of their own.
  const person = id.kind === 'user' && id.name !== 'local' && !id.viewAs
  // A person is called by their own entity's name and drawn by their picture; one the estate does not hold, by their address.
  const self = me.data?.person
  const called = self?.title ?? id.name.split('@')[0]!
  const own = self?.entity ?? null
  return (
    <>
      <button type="button" {...spot('account')} aria-haspopup="menu" aria-expanded={!!menu} className={`flex min-h-8 min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-ink-800 ${compact ? '' : 'flex-1'}`} title={id.admin ? `${held}: you hold every permission` : id.permissions.length ? `You may: ${id.permissions.join(', ')}` : 'You read what you have access to and change nothing'} onClick={(e) => setMenu(e.currentTarget)}>
        <span className="grid size-6 shrink-0 place-items-center overflow-hidden rounded-full bg-ink-700 text-[12px] font-semibold text-ink-100 uppercase" aria-hidden>
          {self?.icon ? <Icon name={self.icon} className={isPhoto(self.icon) ? 'size-6' : 'size-3.5'} /> : called.slice(0, 1)}
        </span>
        {compact ? (
          <span className="sr-only">{called}, {held}</span>
        ) : (
          <span className="flex min-w-0 flex-1 flex-col leading-tight">
            <span className="truncate text-[13px] text-ink-200" title={id.name}>{called}</span>
            <span className="truncate text-[12px] text-ink-400">{held}</span>
          </span>
        )}
        {!compact && <ChevronDown className="size-3 shrink-0 text-ink-400" aria-hidden />}
      </button>
      {menu && (
        <Popover anchor={menu} onClose={() => setMenu(null)} width={220} menu label="Your account" className="py-1">
          {own && <MenuItem onClick={() => (navigate({ page: 'entity', blueprint: own.blueprint, key: own.key }, { start: true }), setMenu(null))}>Your page</MenuItem>}
          {person && <MenuItem onClick={() => (setKeys(true), setMenu(null))}>API keys</MenuItem>}
          {person && me.data?.notifications && <MenuItem onClick={() => (window.open(me.data.notifications, '_blank', 'noopener'), setMenu(null))}>Notifications</MenuItem>}
          {greets && <MenuItem onClick={() => (askFor('tour'), setMenu(null))}>Take the tour</MenuItem>}
          {greets && <MenuItem onClick={() => (askFor('notes'), setMenu(null))}>What’s new</MenuItem>}
          {me.data && <div className={`${own || person || greets ? 'mt-1 border-t' : ''} border-ink-700 px-3 pt-1.5 pb-1 font-mono text-[12px] text-ink-400`}>v{me.data.version}</div>}
        </Popover>
      )}
      {keys && <MyKeys onClose={() => setKeys(false)} />}
    </>
  )
}

/** The pages that run the hub, behind one button at the rail's foot. Open, they stand over the whole foot, inside the rail; the button is lit while one of them is open. */
function HubMenu({ pages, here, compact = false }: { pages: { page: Route['page']; to: Route }[]; here: Route['page']; compact?: boolean }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  useEffect(() => setAnchor(null), [here])
  if (!pages.length) return null
  const on = pages.some((p) => p.page === here)
  const look = on ? 'border-ink-600 bg-ink-800 text-ink-50' : 'border-ink-700 bg-ink-850 text-ink-300 hover:border-ink-600 hover:text-ink-100'
  return (
    <>
      <button type="button" aria-haspopup="dialog" aria-expanded={!!anchor} aria-label={compact ? 'Hub' : undefined} title="The pages that run the hub" onClick={(e) => setAnchor(compact ? e.currentTarget : (e.currentTarget.parentElement ?? e.currentTarget))} className={`flex shrink-0 items-center justify-center gap-1.5 rounded-lg border text-[13px] font-medium transition-colors ${compact ? 'size-10' : 'h-8 px-2.5'} ${look}`}>
        <LayoutGrid className={`size-3.5 ${on ? 'text-orbit' : 'text-ink-400'}`} aria-hidden />
        {!compact && 'Hub'}
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)} width={256} label="Running the hub" className="p-2">
          <nav aria-label="Running the hub" className="grid grid-cols-3 gap-1">
            {pages.map((p) => {
              const Glyph = PAGE_ICON[p.page]
              const at = p.page === here
              return (
                <Link key={p.page} start to={p.to} current={at} className={`flex flex-col items-center gap-1 rounded-md px-1 pt-2 pb-1.5 text-[12px] font-medium transition-colors ${at ? 'bg-ink-800 text-ink-50' : 'text-ink-300 hover:bg-ink-800 hover:text-ink-100'}`}>
                  <Glyph className={`size-4 ${at ? 'text-orbit' : 'text-ink-400'}`} aria-hidden />
                  {PAGE_TITLE[p.page]}
                </Link>
              )
            })}
          </nav>
        </Popover>
      )}
    </>
  )
}

/**
 * The rail along the left of a desk: the pages people use every day, the
 * pages that look at the estate whole as a row of tiles, the catalog's areas
 * and kinds with their health, and, at its foot, who is signed in and the
 * pages that run the hub. Search is in the strip above every page. It stays
 * beside every page. Folded, it keeps the pages as icons and leaves the
 * catalog's kinds out.
 */
function Rail({ route, folded, fold }: { route: Route; folded: boolean; fold: (folded: boolean) => void }) {
  const { shown, here } = usePages(route)
  const blueprints = useBlueprints()
  const summary = useSummary()
  const mine = useMine().data
  const levels = Object.fromEntries((summary.data?.blueprints ?? []).map((b) => [b.id, levelOf(b.notGreen)]))
  // Now's lamp is the reader's own health when the hub knows what is theirs, else what they see: the same as Now's verdict.
  const ownLevels = mine && perspectiveOf(mine).whose === 'yours' ? Object.values(mine.blueprints).map((b) => levelOf(b.notGreen)) : Object.values(levels)
  const estate = ownLevels.reduce<StatusLevel>(worse, 'green')
  const page = (p: (typeof shown)[number]) => {
    const Glyph = PAGE_ICON[p.page]
    const on = p.page === here
    const look = on ? 'bg-ink-800 text-ink-50' : 'text-ink-300 hover:bg-ink-850 hover:text-ink-100'
    if (folded)
      return (
        <Link key={p.page} start to={p.to} current={on} title={PAGE_TITLE[p.page]} label={PAGE_TITLE[p.page]} className={`relative grid size-10 place-items-center rounded-lg transition-colors ${look}`}>
          <Glyph className={`size-4 ${on ? 'text-orbit' : 'text-ink-400'}`} aria-hidden />
          {p.page === 'now' && estate !== 'green' && <Lamp level={estate} size="sm" calm className="absolute top-1.5 right-1.5" />}
          {p.page === 'actions' && (
            <span className="absolute -top-0.5 -right-1 flex">
              <Waiting />
            </span>
          )}
        </Link>
      )
    return (
      <Link key={p.page} start to={p.to} current={on} className={`flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors ${look}`}>
        <Glyph className={`size-4 shrink-0 ${on ? 'text-orbit' : 'text-ink-400'}`} aria-hidden />
        <span className="flex-1">{PAGE_TITLE[p.page]}</span>
        {p.page === 'now' && estate !== 'green' && <Lamp level={estate} calm />}
        {p.page === 'actions' && <Waiting />}
      </Link>
    )
  }
  const tile = (p: (typeof shown)[number]) => {
    const Glyph = PAGE_ICON[p.page]
    const on = p.page === here
    return (
      <Link key={p.page} start to={p.to} current={on} className={`flex min-w-0 flex-col items-center gap-1 rounded-lg border px-1 pt-2 pb-1.5 text-[12px] font-medium transition-colors ${on ? 'border-ink-700 bg-ink-800 text-ink-50' : 'border-ink-800 bg-ink-850 text-ink-300 hover:border-ink-700 hover:text-ink-100'}`}>
        <Glyph className={`size-4 shrink-0 ${on ? 'text-orbit' : 'text-ink-400'}`} aria-hidden />
        <span className="max-w-full truncate">{PAGE_TITLE[p.page]}</span>
      </Link>
    )
  }
  const daily = shown.filter((p) => DAILY.includes(p.page))
  const whole = shown.filter((p) => ESTATE.includes(p.page))
  // Folded, the kinds are gone, so the catalog keeps one way in beside the daily pages.
  const catalog = shown.find((p) => p.page === 'inventory')
  const running = shown.filter((p) => !DAILY.includes(p.page) && !ESTATE.includes(p.page) && p.page !== 'inventory')
  const toggle = (
    <button type="button" className="grid size-6 place-items-center rounded-sm text-ink-400 hover:bg-ink-800 hover:text-ink-200" title={folded ? 'Open the side bar' : 'Fold the side bar'} aria-label={folded ? 'Open the side bar' : 'Fold the side bar'} aria-expanded={!folded} onClick={() => fold(!folded)}>
      {folded ? <PanelLeftOpen className="size-3.5" aria-hidden /> : <PanelLeftClose className="size-3.5" aria-hidden />}
    </button>
  )
  if (folded)
    return (
      <aside aria-label="Navigation" {...spot('nav')} className="fixed inset-y-0 left-0 z-30 flex w-14 flex-col items-center overflow-y-auto border-r border-ink-800 bg-ink-900 py-3">
        <Link start to={{ page: 'now' }} label="orrery" className="grid size-10 place-items-center rounded-lg">
          {mark}
        </Link>
        <div className="mt-1 flex flex-col items-center gap-1 text-ink-400">
          {toggle}
          <ZenSwitch />
          <ThemeSwitch />
        </div>
        <nav aria-label="Pages" className="mt-3 flex flex-col items-center gap-px">
          {daily.map((p) => page(p))}
          {whole.map((p) => page(p))}
          {catalog && page(catalog)}
        </nav>
        <div className="mt-auto flex flex-col items-center gap-2 border-t border-ink-800 pt-2">
          <HubMenu pages={running} here={here} compact />
          <Account compact />
        </div>
      </aside>
    )
  return (
    <aside aria-label="Navigation" {...spot('nav')} className="fixed inset-y-0 left-0 z-30 flex w-(--rail) flex-col border-r border-ink-800 bg-ink-900">
      <div className="flex items-center justify-between px-4 pt-4 pb-3">
        {logo}
        <span className="flex items-center gap-1 text-ink-400">
          <ZenSwitch />
          <ThemeSwitch />
          {toggle}
        </span>
      </div>
      <nav aria-label="Pages" className="space-y-px px-2">
        {daily.map((p) => page(p))}
      </nav>
      {whole.length > 0 && (
        <nav aria-label="The estate" className={`mt-2 grid gap-1.5 px-2 ${TILE_COLUMNS[whole.length]}`}>
          {whole.map((p) => tile(p))}
        </nav>
      )}
      <nav aria-label="Catalog" {...spot('catalog.kinds')} className="mt-3 min-h-0 flex-1 overflow-y-auto border-t border-ink-800 px-2 pt-2 pb-6 [mask-image:linear-gradient(to_bottom,black_calc(100%-2rem),transparent)]">
        <div className="flex items-center gap-2.5 px-2.5 py-1.5 text-[12px] font-medium text-ink-400">
          All kinds
          <span className="ml-auto tabular-nums">{Object.values(blueprints.data?.counts ?? {}).reduce((a, b) => a + b, 0).toLocaleString('en-US')}</span>
        </div>
        <KindList list={blueprints.data?.blueprints ?? []} counts={blueprints.data?.counts ?? {}} levels={levels} current={route.page === 'inventory' ? (route.blueprint ?? undefined) : route.page === 'entity' ? route.blueprint : undefined} />
      </nav>
      <div className="flex items-center gap-1.5 border-t border-ink-800 px-2 py-2">
        <Account />
        <HubMenu pages={running} here={here} />
      </div>
    </aside>
  )
}

/** Turns zen mode on or off in this browser: the estate in quiet colours, with no alarms while you browse. */
function ZenSwitch() {
  const zen = useZen()
  const label = zen ? 'Leave zen mode' : 'Zen mode: quiet colours, and no alarms while you browse'
  return (
    <button type="button" className={`grid size-6 place-items-center rounded-sm hover:bg-ink-800 hover:text-ink-200 ${zen ? 'text-orbit' : ''}`} title={label} aria-label="Zen mode" aria-pressed={zen} onClick={() => setZen(!zen)}>
      <Leaf className="size-3.5" aria-hidden />
    </button>
  )
}

/** Switches this browser between the night sky and daylight. */
function ThemeSwitch() {
  const theme = useTheme()
  const next = theme === 'dark' ? 'light' : 'dark'
  return (
    <button type="button" className="grid size-6 place-items-center rounded-sm hover:bg-ink-800 hover:text-ink-200" title={`Switch to ${next} mode`} aria-label={`Switch to ${next} mode`} onClick={() => setTheme(next)}>
      {theme === 'dark' ? <Sun className="size-3.5" aria-hidden /> : <Moon className="size-3.5" aria-hidden />}
    </button>
  )
}

/** Find anything, at the right end of the strip above every page on a desk. A phone finds from its Search tab and from Now. */
function FindButton() {
  const open = useCommand()
  return (
    <button type="button" {...spot('find')} onClick={() => open(true)} aria-haspopup="dialog" className="flex h-8 w-64 shrink-0 items-center gap-2.5 rounded-lg border border-ink-700 bg-ink-850 pr-1.5 pl-3 text-left text-[13px] text-ink-400 transition-colors hover:border-ink-600 hover:text-ink-200 max-lg:w-auto">
      <Search className="size-4 shrink-0" aria-hidden />
      <span className="flex-1 max-lg:sr-only">Find anything</span>
      <kbd className="rounded-md border border-ink-700 px-1.5 font-mono text-[12px] text-ink-400">⌘K</kbd>
    </button>
  )
}

/** A phone's top bar: the logo, or what the page puts there through `PhoneBar`. */
function PhoneTop() {
  return (
    <header className="group flex h-12 shrink-0 items-center gap-1 border-b border-ink-800">
      <PhoneBack />
      <span className="group-has-[[data-bar]>*]:hidden">{logo}</span>
      <PhoneBarSlot className="flex min-w-0 flex-1 items-center gap-1.5 empty:hidden" />
    </header>
  )
}

/** The pages a phone reaches with its thumb: the four most used, and the rest under More. */
const TABS: { page: Route['page']; to: Route }[] = [
  { page: 'now', to: { page: 'now' } },
  { page: 'inventory', to: { page: 'inventory', blueprint: null } },
  { page: 'search', to: { page: 'search' } },
  { page: 'actions', to: { page: 'actions', id: null } },
]

/** The bar along the bottom of a phone. A tab on the page it names goes to that page's start, as a tab bar does. */
export function TabBar({ route }: { route: Route }) {
  const { shown, here } = usePages(route)
  const [more, setMore] = useState(false)
  // Recent opens from More as a sheet of its own, tied to the More button.
  const moreButton = useRef<HTMLButtonElement>(null)
  const [recent, setRecent] = useState(false)
  // A page change closes either sheet.
  useEffect(() => (setMore(false), setRecent(false)), [route])
  const rest = shown.filter((p) => !TABS.some((t) => t.page === p.page))
  const elsewhere = rest.some((p) => p.page === here)
  // The page a tab is on gets a pill behind it, and its icon takes the accent.
  const tab = (on: boolean) => `flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-full text-[12px] font-medium tracking-tight whitespace-nowrap transition-colors ${on ? 'bg-ink-800 text-ink-100 *:first:text-orbit' : 'text-ink-400'}`
  return (
    <nav aria-label="Pages" {...spot('nav')} className="fixed inset-x-2 bottom-(--tab-gap) z-30 flex h-14 gap-0.5 rounded-full border border-ink-700 bg-ink-900/90 p-1 shadow-lg shadow-ink-950/60 backdrop-blur-xl">
      {TABS.map(({ page, to }) => {
        const Glyph = PAGE_ICON[page]
        return (
        <Link key={page} start to={to} current={page === here} className={tab(page === here)}>
          <span className="relative flex">
            <Glyph className="size-5" aria-hidden />
            {page === 'actions' && (
              <span className="absolute -top-1 -right-3 flex">
                <Waiting />
              </span>
            )}
          </span>
          {PAGE_TITLE[page]}
        </Link>
        )
      })}
      <button ref={moreButton} type="button" aria-haspopup="dialog" aria-expanded={more} className={tab(elsewhere)} onClick={() => setMore(true)}>
        <Ellipsis className="size-5" aria-hidden />
        {elsewhere ? PAGE_TITLE[here] : 'More'}
      </button>
      {more && (
        <Drawer title="More" onClose={() => setMore(false)}>
          <ul className="divide-y divide-ink-800">
            <li>
              <button type="button" aria-haspopup="menu" className="flex w-full items-center gap-3 px-4 py-3.5 text-left text-[15px] font-medium text-ink-200" onClick={() => (setMore(false), setRecent(true))}>
                <History className="size-4 text-ink-400" aria-hidden />
                Recent
                <ChevronRight className="ml-auto size-4 text-ink-500" aria-hidden />
              </button>
            </li>
            {rest.map((p) => (
              <li key={p.page}>
                <Link start to={p.to} current={p.page === here} className={`flex items-center gap-3 px-4 py-3.5 text-[15px] font-medium ${p.page === here ? 'text-ink-100' : 'text-ink-200'}`}>
                  {PAGE_TITLE[p.page]}
                  <ChevronRight className="ml-auto size-4 text-ink-500" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
          <div className="flex items-center gap-3 border-t border-ink-700 px-3 py-2 text-ink-400">
            <Account />
            <span className="ml-auto flex items-center gap-1">
              <ZenSwitch />
              <ThemeSwitch />
            </span>
          </div>
        </Drawer>
      )}
      {recent && moreButton.current && <RecentList anchor={moreButton.current} onClose={() => setRecent(false)} />}
    </nav>
  )
}

/** How many runs, change sets, and schedules wait for this person's approval, beside the Self-service link. Nothing when none do. */
function Waiting() {
  const waiting = useWaiting()
  return <WaitingBadge n={waiting.runs + waiting.sets + waiting.schedules} title={waitingWords(waiting, 'for your approval')} />
}
