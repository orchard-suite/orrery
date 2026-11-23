// The Self-service page: the start page, where a person finds and runs an
// action beside the runs, and one action's own page with its form, its runs,
// and its definition.

import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Search } from 'lucide-react'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { stringify as toYaml } from 'yaml'
import type { ActionsLayout } from '../../shared/api.ts'
import { actionTargets, entityId, type ActionView } from '../../shared/model.ts'
import { homeOf, iconOf, movedSection, NO_SECTION, sectionOf, sectionsOf } from '../actions.ts'
import { useActions, useActionsLayout, useBlueprintName, useBlueprints, useCan, useDeleteAction, usePins, usePinsError, useSetActionsLayout } from '../api.ts'
import { Icon } from '../icons.tsx'
import { navigate, startFromSearch } from '../router.ts'
import { ActionEditor } from './ActionEditor.tsx'
import { ActionForm, RunDrawer, type RunStart } from './ActionForm.tsx'
import { RunsPanel, type RunsTab } from './ActionRun.tsx'
import { ApprovalsBand, Pinned, Recent, Tile } from './ActionStart.tsx'
import { PinStar } from './Star.tsx'
import { Button, Empty, ErrorNote, input, Kicker, Link, Panel } from './ui.tsx'
import { spot } from '../spots.ts'
import { useHere, useVisit } from '../trail.ts'

export function Actions({ id }: { id: string | null }) {
  const list = useActions()
  const all = list.data?.actions ?? []
  const current = all.find((a) => a.id === id)
  const [creating, setCreating] = useState(false)
  if (id && !current) return <div className="py-6">{list.isLoading ? <p className="text-sm text-ink-400">Loading…</p> : <Empty>No action {id}.</Empty>}</div>
  if (!current && !creating) return <Catalog actions={all.filter((a) => a.form !== false && a.listed !== false && a.origin.kind !== 'hub')} loading={list.isLoading} onCreate={() => setCreating(true)} />
  // The catalog fills a big window, so the editor opened from it scrolls inside that window too.
  return <div className={`space-y-6 py-6 ${current ? '' : 'desk:h-full desk:overflow-y-auto'}`}>{current ? <Detail action={current} /> : <ActionEditor onDone={() => setCreating(false)} />}</div>
}

const BACKEND: Record<ActionView['backend']['type'], string> = { webhook: 'Webhook', github_workflow: 'GitHub workflow', runner: 'Runner', job: 'A container for each run', record: 'Records an entity', caller: 'Done by whoever asks', decide: 'Decides an approval', schedule: 'Changes a schedule', report: 'Keeps a report' }

/** The place of an action with no blueprint, among the places actions run. */
const ANYWHERE = ''

function Catalog({ actions, loading, onCreate }: { actions: ActionView[]; loading: boolean; onCreate: () => void }) {
  const layout = useActionsLayout()
  const blueprints = useBlueprints().data?.blueprints ?? []
  const name = useBlueprintName()
  const canManage = useCan('actions.manage')
  const canOrganize = useCan('catalog.organize')
  const canAudit = useCan('audit.view')
  // A hub that keeps no pins leaves the reader's runs the row to themselves.
  const pinning = usePins().data !== null
  const pinsError = usePinsError()
  const [organizing, setOrganizing] = useState(false)
  const [query, setQuery] = useVisit('actions.query', '')
  const [on, setOn] = useVisit<string | null>('actions.on', null)
  const [runnable, setRunnable] = useVisit('actions.runnable', false)
  const [running, setRunning] = useState<{ action: ActionView; start?: RunStart } | null>(null)
  // The tab the runs side bar was last sent to from here. Each send counts up, so the side bar starts over on that tab.
  const [sent, setSent] = useState<{ tab: RunsTab; times: number } | null>(null)
  useEffect(() => {
    if (sent) document.getElementById(`runs-${sent.tab}`)?.focus()
  }, [sent])
  const search = useRef<HTMLInputElement>(null)
  // A slash goes to the search from anywhere on the page, unless it is being typed into something or a dialog is open.
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return
      const at = event.target
      if (at instanceof HTMLElement && (at.isContentEditable || at.matches('input, textarea, select'))) return
      if (!search.current || document.querySelector('[aria-modal="true"]')) return
      event.preventDefault()
      search.current.focus()
    }
    document.addEventListener('keydown', key)
    return () => document.removeEventListener('keydown', key)
  }, [])
  // The places actions run, in the order the catalog lists blueprints, anywhere last.
  const placesOf = (a: ActionView) => (actionTargets(a).length ? actionTargets(a) : [ANYWHERE])
  const places = [...new Set(actions.flatMap(placesOf))].sort((a, b) => (a === ANYWHERE ? 1 : b === ANYWHERE ? -1 : blueprints.findIndex((x) => x.id === a) - blueprints.findIndex((x) => x.id === b)))
  const someLocked = actions.some((a) => !a.canRun)
  const q = query.trim().toLowerCase()
  const shown = actions.filter((a) => {
    if (on !== null && !placesOf(a).includes(on)) return false
    if (runnable && !a.canRun) return false
    if (!q) return true
    return [a.title, a.description, homeOf(a)?.title ?? a.group, a.id, ...actionTargets(a).map((b) => name(b))].some((t) => t?.toLowerCase().includes(q))
  })
  const filtering = !!q || on !== null || runnable
  const clear = () => (setQuery(''), setOn(null), setRunnable(false))
  // The start page, and the runs in a side bar. Where the window is big enough each fills it and scrolls inside itself
  // under a header that stays put; elsewhere the page scrolls and the side bar sticks beside the actions.
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-x-10 gap-y-8 py-6 xl:grid-cols-[minmax(0,1fr)_minmax(320px,380px)] 2xl:grid-cols-[minmax(0,1fr)_minmax(360px,420px)] desk:h-full desk:grid-rows-[minmax(0,1fr)] desk:pb-0">
      <div {...spot('actions.catalog')} className="min-w-0 space-y-5 desk:flex desk:min-h-0 desk:flex-col desk:space-y-0">
        <div className="space-y-4 desk:border-b desk:border-ink-800 desk:pb-4">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="page-title min-w-0 flex-1 basis-64">Self-service</h1>
            <div className="flex flex-wrap gap-2">
              <Link to={{ page: 'action-schedules' }} className="btn btn-ghost">
                Schedules
              </Link>
              {canAudit && (
                <Link to={{ page: 'action-insights' }} className="btn btn-ghost">
                  Insights
                </Link>
              )}
              {canOrganize && actions.length > 0 && <Button onClick={() => setOrganizing(!organizing)}>{organizing ? 'Done organizing' : 'Organize'}</Button>}
              {canManage && (
                <Button kind="solid" onClick={onCreate}>
                  New action
                </Button>
              )}
            </div>
          </div>
          <ApprovalsBand onSeeAll={() => setSent({ tab: 'approvals', times: (sent?.times ?? 0) + 1 })} />
          {actions.length > 0 && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-3">
                <div className="relative min-w-60 max-w-md flex-1">
                  <Search aria-hidden className="pointer-events-none absolute inset-y-0 left-2.5 my-auto size-3.5 text-ink-400" />
                  <input ref={search} type="search" aria-label="Search actions" aria-keyshortcuts="/" placeholder="Search actions" className={`${input} w-full py-1.5 pl-8`} value={query} onChange={(e) => setQuery(e.target.value)} />
                  {!query && (
                    <kbd aria-hidden title="Press / to search" className="pointer-events-none absolute inset-y-0 right-2 my-auto hidden h-5 items-center rounded-sm border border-ink-600 px-1.5 font-mono text-[11px] text-ink-400 md:flex">
                      /
                    </kbd>
                  )}
                </div>
                {someLocked && (
                  <label className="flex items-center gap-1.5 text-sm text-ink-300">
                    <input type="checkbox" checked={runnable} onChange={(e) => setRunnable(e.target.checked)} /> Only what I can run
                  </label>
                )}
                <span className="ml-auto text-[12px] text-ink-400" aria-live="polite">
                  {filtering ? `${shown.length} of ${actions.length}` : `${actions.length} ${actions.length === 1 ? 'action' : 'actions'}`}
                </span>
              </div>
              {places.length > 1 && (
                <div role="group" aria-label="Runs on" className="flex flex-wrap items-center gap-1.5">
                  <span className="mr-1 text-[12px] text-ink-400">Runs on</span>
                  <Chip pressed={on === null} onClick={() => setOn(null)}>
                    Any
                  </Chip>
                  {places.map((p) => (
                    <Chip key={p || 'anywhere'} pressed={on === p} onClick={() => setOn(on === p ? null : p)}>
                      {p === ANYWHERE ? 'Anywhere' : name(p)}
                    </Chip>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
        <div className="space-y-6 desk:min-h-0 desk:flex-1 desk:overflow-y-auto desk:pt-4 desk:pr-2 desk:pb-8 desk:[mask-image:linear-gradient(to_bottom,black_calc(100%-2rem),transparent)]">
          {/* What is the reader's own, side by side where there is room, above what everyone sees. A search is over the actions alone. */}
          <ErrorNote error={pinsError} />
          {!filtering && actions.length > 0 && (
            <div className={`grid grid-cols-[minmax(0,1fr)] gap-x-10 gap-y-5 ${pinning ? 'max-w-5xl lg:grid-cols-2' : 'max-w-3xl'}`}>
              <Pinned actions={actions} onRun={(action) => setRunning({ action })} />
              <Recent actions={actions} onAgain={(action, run) => setRunning({ action, start: { entity: run.entity ? entityId(run.entity) : null, inputs: run.inputs } })} />
            </div>
          )}
          {layout.data && <Sections actions={actions} shown={shown} filtering={filtering} layout={layout.data} organizing={organizing} onRun={(action) => setRunning({ action })} />}
          {!loading && actions.length === 0 && <Empty>No actions yet.{canManage ? ' Make one with New action, or declare one in a catalog file.' : ''}</Empty>}
          {filtering && shown.length === 0 && (
            <Empty>
              No action matches.{' '}
              <button type="button" className="text-ink-100 underline underline-offset-2" onClick={clear}>
                Clear the search
              </button>
            </Empty>
          )}
        </div>
      </div>
      <aside aria-label="Runs" className="flex min-w-0 flex-col xl:sticky xl:top-6 xl:max-h-[calc(100dvh-3rem)] xl:self-start desk:static desk:max-h-none desk:min-h-0 desk:self-stretch">
        {/* What waits for the reader is at the top of the page, so the side bar opens on their own runs until they ask for the rest. */}
        <RunsPanel key={sent?.times ?? 0} start={sent?.tab ?? 'mine'} />
      </aside>
      {running && <RunDrawer action={running.action} start={running.start} onClose={() => setRunning(null)} />}
    </div>
  )
}

function Chip({ pressed, onClick, children }: { pressed: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-pressed={pressed} onClick={onClick} className={`rounded-full border px-2.5 py-0.5 text-[12px] transition-colors ${pressed ? 'border-ink-200 bg-ink-800 text-ink-100' : 'border-ink-600 text-ink-300 hover:border-ink-400 hover:text-ink-100'}`}>
      {children}
    </button>
  )
}

/**
 * The sections, each a fold of tiles: the homes the reader owns first, then
 * the rest in the shared order. A home's section is headed by the home, as a
 * link to its page. While a search is on, every section with a match is open
 * and the rest are gone.
 */
function Sections({ actions, shown, filtering, layout, organizing, onRun }: { actions: ActionView[]; shown: ActionView[]; filtering: boolean; layout: ActionsLayout; organizing: boolean; onRun: (a: ActionView) => void }) {
  const save = useSetActionsLayout()
  const name = useBlueprintName()
  const base = useId()
  const ordered = sectionsOf(actions, layout.order)
  // What a person opens or closes is theirs alone: it starts from the shared default and is kept nowhere.
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const isOpen = (s: string) => filtering || (open[s] ?? !layout.closed.includes(s))
  const startClosed = (s: string, closed: boolean) => save.mutate({ closed: closed ? [...new Set([...layout.closed, s])] : layout.closed.filter((x) => x !== s) })
  return (
    <div className="space-y-4">
      <ErrorNote error={save.error} />
      {ordered.map(({ key: s, home }, i) => {
        const mine = shown.filter((a) => sectionOf(a) === s).sort((a, b) => a.title.localeCompare(b.title))
        if (filtering && !mine.length) return null
        const expanded = isOpen(s)
        const listId = `${base}-${i}`
        const called = home?.title ?? (s || NO_SECTION)
        const up = movedSection(ordered, layout.order, s, -1)
        const down = movedSection(ordered, layout.order, s, 1)
        const fold = { type: 'button' as const, 'aria-expanded': expanded, 'aria-controls': listId, disabled: filtering, onClick: () => setOpen({ ...open, [s]: !expanded }) }
        const chevron = expanded ? <ChevronDown aria-hidden className="size-3.5" /> : <ChevronRight aria-hidden className="size-3.5" />
        return (
          <section key={s || '\u0000'} aria-labelledby={`${listId}-h`}>
            <div className="flex flex-wrap items-center gap-2">
              {home ? (
                // A link cannot sit inside the button that folds, so the fold is the chevron alone, named for the section it folds.
                <h2 id={`${listId}-h`} className="flex min-w-0 items-center gap-1 py-0.5 text-[13px] font-medium text-ink-300">
                  <button {...fold} aria-labelledby={`${listId}-n`} className="flex size-6 shrink-0 items-center justify-center rounded-sm hover:bg-ink-800 hover:text-ink-100 disabled:hover:bg-transparent disabled:hover:text-ink-300">
                    {chevron}
                  </button>
                  <span id={`${listId}-n`} className="flex min-w-0 items-center gap-1.5">
                    {home.yours && <span className="shrink-0">{`Your ${name(home.entity.blueprint).toLowerCase()}:`}</span>}
                    <Link to={{ page: 'entity', ...home.entity }} title={`Open ${home.title}`} className="flex min-w-0 items-center gap-1.5 rounded-sm text-ink-100 underline-offset-2 hover:underline">
                      <Icon name={home.icon} className="size-4 shrink-0" />
                      <span className="truncate">{home.title}</span>
                    </Link>
                  </span>
                  <span className="shrink-0 text-ink-400">· {mine.length}</span>
                </h2>
              ) : (
                <h2 id={`${listId}-h`}>
                  <button {...fold} className="flex items-center gap-1.5 rounded-sm py-1 pr-2 text-[13px] font-medium text-ink-300 hover:text-ink-100 disabled:hover:text-ink-300">
                    {chevron}
                    {called}
                    <span className="text-ink-400">· {mine.length}</span>
                  </button>
                </h2>
              )}
              {organizing && (
                <div className="flex items-center gap-1 text-[12px] text-ink-400">
                  {/* What belongs to no section is always last, so it has nowhere to move. */}
                  {s !== '' && (
                    <>
                      <button type="button" disabled={!up} onClick={() => up && save.mutate({ order: up })} className="rounded-sm border border-ink-600 px-1.5 py-0.5 hover:border-ink-300 disabled:opacity-30" title="Move up for everyone" aria-label={`Move ${called} up for everyone`}>
                        <ArrowUp aria-hidden className="size-3" />
                      </button>
                      <button type="button" disabled={!down} onClick={() => down && save.mutate({ order: down })} className="rounded-sm border border-ink-600 px-1.5 py-0.5 hover:border-ink-300 disabled:opacity-30" title="Move down for everyone" aria-label={`Move ${called} down for everyone`}>
                        <ArrowDown aria-hidden className="size-3" />
                      </button>
                    </>
                  )}
                  <label className="ml-2 flex items-center gap-1" title="Everyone sees this section folded when they arrive">
                    <input type="checkbox" checked={layout.closed.includes(s)} onChange={(e) => startClosed(s, e.target.checked)} /> Starts closed
                  </label>
                </div>
              )}
            </div>
            <ul id={listId} hidden={!expanded} className="mt-1.5 grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-2">
              {mine.map((a) => (
                <Tile key={a.id} action={a} onRun={() => onRun(a)} />
              ))}
            </ul>
          </section>
        )
      })}
    </div>
  )
}

function Detail({ action }: { action: ActionView }) {
  useHere(action.title)
  const canManage = useCan('actions.manage')
  // The blueprint a person input's bare key is of, in a link that fills the form in.
  const people = useActions().data?.person
  const remove = useDeleteAction()
  const pinsError = usePinsError()
  const [editing, setEditing] = useState(false)
  // What the hub says beside the definition is no part of what the editor holds.
  const { origin, updatedAt: _u, canRun: _c, lastRun: _l, iconShown: _i, stats: _s, pinned: _p, homeShown: _h, ...spec } = action
  const name = useBlueprintName()
  const home = homeOf(action)
  // An action a source put is its own until it puts it again: a person may still change or remove it.
  const editable = canManage && origin.kind !== 'git'
  return (
    <div {...spot('action.page')} className="space-y-6">
      <nav aria-label="Breadcrumb">
        <Kicker>
          <Link to={{ page: 'actions', id: null }} className="hover:text-ink-200">
            Self-service
          </Link>
          {home ? ` / ${home.title}` : action.group ? ` / ${action.group}` : ''}
        </Kicker>
      </nav>
      <div className="flex flex-wrap items-start gap-4">
        <Icon name={iconOf(action)} className="mt-1 size-8" />
        <div className="min-w-0 flex-1 basis-64">
          <div className="flex items-center gap-1.5">
            <h1 className="page-title min-w-0">{action.title}</h1>
            {/* An action with no form has no tile on the start page, so there is nowhere a pin to it would show. */}
            {action.form !== false && action.listed !== false && <PinStar pin={{ kind: 'action', id: action.id }} name={action.title} />}
          </div>
          {action.description && <p className="mt-1 max-w-3xl text-sm text-ink-300">{action.description}</p>}
          <ul className="mt-3 flex flex-wrap items-center gap-2 text-[12px] text-ink-300" aria-label="About this action">
            <li className="rounded-sm border border-ink-700 px-2 py-0.5">
              {actionTargets(action).length ? (
                <>
                  On{' '}
                  {actionTargets(action).map((b, i) => (
                    <span key={b}>
                      {i > 0 && ', '}
                      <Link to={{ page: 'inventory', blueprint: b }} className="text-ink-100 hover:underline">
                        {name(b)}
                      </Link>
                    </span>
                  ))}
                </>
              ) : (
                'Runs anywhere'
              )}
            </li>
            {home && (
              <li className="flex items-center gap-1.5 rounded-sm border border-ink-700 px-2 py-0.5">
                Home:
                <Link to={{ page: 'entity', ...home.entity }} className="flex items-center gap-1 text-ink-100 hover:underline">
                  <Icon name={home.icon} className="size-3.5" />
                  {home.title}
                </Link>
              </li>
            )}
            {!!action.access?.home && <li className="rounded-sm border border-ink-700 px-2 py-0.5">Open to the people who own its home</li>}
            {!!action.access?.rules?.length && <li className="rounded-sm border border-ink-700 px-2 py-0.5">Who runs it depends on what they are to each one</li>}
            <li className="rounded-sm border border-ink-700 px-2 py-0.5">{BACKEND[action.backend.type]}</li>
            <li className="rounded-sm border border-ink-700 px-2 py-0.5" title={origin.kind === 'git' ? 'Change it in the catalog file' : undefined}>
              {origin.kind === 'git' ? <>Defined in git: <span className="font-mono">{origin.file}</span></> : origin.kind === 'source' ? <>Put by source <span className="font-mono">{origin.source}</span></> : origin.kind === 'hub' ? 'One of the hub\'s own' : 'Made in the web app'}
            </li>
            {action.approval && <li className="rounded-sm border border-amber/50 px-2 py-0.5 text-amber">Needs approval</li>}
            {action.confirm && <li className="rounded-sm border border-ink-700 px-2 py-0.5">Asks for a check before it runs</li>}
          </ul>
        </div>
        <div className="flex flex-wrap gap-2">
          {editable && <Button onClick={() => setEditing(!editing)}>{editing ? 'Close editor' : 'Edit'}</Button>}
          {editable && (
            <Button kind="danger" onClick={() => confirm(`Remove action ${action.title}? Its runs stay.`) && remove.mutate(action.id, { onSuccess: () => navigate({ page: 'actions', id: null }) })}>
              Remove
            </Button>
          )}
        </div>
      </div>
      <ErrorNote error={remove.error} />
      <ErrorNote error={pinsError} />
      {editing ? (
        <ActionEditor initial={toYaml(spec)} id={action.id} onDone={() => setEditing(false)} />
      ) : (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <Panel className="self-start px-5 py-4">
            <h2 className="mb-4 text-base font-semibold text-ink-100">Run it</h2>
            {action.canRun ? <ActionForm key={action.id} action={action} start={startFromSearch(window.location.search, action.inputs, action.blueprint, people)} /> : <WhoMay action={action} />}
          </Panel>
          <RunsPanel action={action.id} />
        </div>
      )}
    </div>
  )
}

/** For a manager who may edit an action but not run it: who may. */
function WhoMay({ action }: { action: ActionView }) {
  if (action.form === false) return <p className="text-sm text-ink-300">This action has no form: only its tool starts it. Its runs and approvals show below and on the runs page.</p>
  const a = action.access
  if (!a || (!a.everyone && !a.grants?.length && !a.audiences?.length && !a.home)) return <p className="text-sm text-ink-300">Only an admin runs this action. An admin opens it to others with an access block.</p>
  return (
    <div className="space-y-1 text-sm text-ink-300">
      <p>You may edit this action, not run it. It is open to:</p>
      <ul className="list-disc pl-5 font-mono text-[12px]">
        {a.everyone && <li>everyone signed in</li>}
        {a.home && <li>{`the people who own its home${Array.isArray(a.home) ? ` as ${a.home.join(' or ')}` : ''}`}</li>}
        {(a.audiences ?? []).map((id) => (
          <li key={id}>the {id} audience</li>
        ))}
        {(a.grants ?? []).map((g, i) => (
          <li key={i}>
            {g.path ? `${g.path}${g.field ? `.${g.field}` : ''} is one of ` : ''}
            {g.values.join(', ')}
          </li>
        ))}
      </ul>
    </div>
  )
}
