// The query page: the catalog read whole, across blueprints, and explored.
// Several queries stay open, one tab each. A query is one line of chips: the
// blueprints it reads, each with its own conditions, and the conditions on the
// answer's columns, which can test what no one blueprint holds. The same query
// reads as text too. Beside the answer stand its fields, each column's values
// counted live, a press away from narrowing by them, and its columns, each
// saying what fills it in each blueprint, out along relations too. The answer
// is a grid that sorts, groups, adds up, and opens a row in place, or a chart.
// Every blueprint keeps its own colour, on its chip, on each column it fills,
// and on each row it gave. A change runs the query again by itself. Running
// only reads, so an admin viewing as someone runs it as them, and sees what
// they would.

import { BarChart3, BookMarked, Columns3, Copy, Download, FileChartColumn, Filter, Globe, House, Lock, Play, Plus, RotateCw, Save, Table2, Trash2, Users, X } from 'lucide-react'
import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ChartTotal, GridClause, QueryChart, QueryColumn, QueryResult, QuerySource, QuerySpec, QueryView, SavedQuery } from '../../shared/api.ts'
import { RUN_COLUMNS, RUNS_SOURCE } from '../../shared/api.ts'
import { columnFormat, columnKind, keptRows, shape, spread, type ColumnKind } from '../../shared/answer.ts'
import { conditionsFilter, typesIn } from '../../shared/clauses.ts'
import { parseQuery, printQuery } from '../../shared/query-text.ts'
import { numberText } from '../../shared/currency.ts'
import { ACTION_RUN_STATES, datasetOf, ENTITY_STATES, STATUS_LEVELS, valueColor, type ActionView, type Blueprint, type EntityState, type FieldDef, type FieldFormat, type Home } from '../../shared/model.ts'
import { exportQuery, useBlueprintName, useDatasets, useQueryKinds, useRefreshDataset, useDeleteQuery, useQueryAnswer, useQueryAudiences, useSaveQuery, useSavedQueries, useSavedQuery, useViewingAs, useWhoAmI } from '../api.ts'
import { conditionFields, opsFor } from '../conditions.ts'
import { BlueprintIcon } from '../icons.tsx'
import { BY_BLUEPRINT, chartBars, chartPlan, choicesIn, seenSources, clauseText, editable, hueOf, joined, left, library, readableOf, removeQuestion, RUNS, sharingOf, shortName, withoutColumn, type Bar, type Readable, type Sharing } from '../query.ts'
import { closeQuery, closeTab, newTab, openQuery, readOf, sameDraft, showTab, specOf, updateTab, useTabs, type Draft, type Tab } from '../query-tabs.ts'
import { navigate } from '../router.ts'
import { useHere } from '../trail.ts'
import { ago } from '../format.ts'
import { BatchDrawer, useBatchActions } from './Batch.tsx'
import { ReportCompose } from './ReportCompose.tsx'
import { Conditions, type Choice, type ConditionField } from './Clauses.tsx'
import { Drawer } from './Drawer.tsx'
import { HomePicker, HomeRef } from './HomePicker.tsx'
import { Picker } from './Picker.tsx'
import { MenuItem, Popover } from './Popover.tsx'
import { QueryColumns } from './QueryColumns.tsx'
import { QueryFields } from './QueryFields.tsx'
import { QueryGrid } from './QueryGrid.tsx'
import { Button, Empty, ErrorNote, Link, swatch, useNarrow, input } from './ui.tsx'

/** How long the page waits after a change before it reads the query again. */
const SETTLE_MS = 350

export function QueryPage({ id }: { id: string | null }) {
  const { tabs, active } = useTabs()
  useEffect(() => openQuery(id), [id])
  const tab = tabs.find((t) => t.key === active) ?? null
  return (
    <div className="flex h-full min-h-0 flex-col pt-4 pb-3 max-md:h-auto">
      <TabStrip tabs={tabs} active={active} />
      {tab && <Workbench key={tab.key} tab={tab} />}
    </div>
  )
}

/** The open queries, one tab each, and one more to open. */
function TabStrip({ tabs, active }: { tabs: Tab[]; active: string | null }) {
  const close = (t: Tab) => {
    if (!sameDraft(t.draft, t.kept) && !confirm(`Close "${t.draft.title || 'A new query'}"? What changed since it was saved is lost.`)) return
    const front = closeTab(t.key)
    navigate({ page: 'query', id: front?.id ?? null })
  }
  return (
    <div className="flex min-w-0 items-end gap-1 border-b border-ink-800">
      <div role="tablist" aria-label="Open queries" className="flex min-w-0 items-end gap-0.5 overflow-x-auto">
        {tabs.map((t) => {
          const on = t.key === active
          const changed = !sameDraft(t.draft, t.kept) && t.loaded
          const name = t.draft.title || (t.id ? '…' : 'A new query')
          return (
            <div key={t.key} className={`group flex shrink-0 items-center rounded-t-md border-b-2 ${on ? 'border-orbit bg-ink-900' : 'border-transparent hover:bg-ink-900/60'}`}>
              <button
                type="button"
                role="tab"
                aria-selected={on}
                onClick={() => {
                  showTab(t.key)
                  navigate({ page: 'query', id: t.id })
                }}
                className={`max-w-[18rem] truncate py-2 pr-1 pl-3 text-[13px] ${on ? 'text-ink-50' : 'text-ink-300 hover:text-ink-100'}`}
                title={name}
              >
                {name}
                {changed && <span className="ml-1.5 text-amber" aria-label="changed since it was saved">●</span>}
              </button>
              <button type="button" aria-label={`Close ${name}`} onClick={() => close(t)} className="mr-1 rounded p-1 text-ink-500 hover:text-ink-100 max-md:p-1.5">
                <X aria-hidden className="size-3.5" />
              </button>
            </div>
          )
        })}
      </div>
      <button
        type="button"
        aria-label="Open a new query"
        title="Open a new query"
        onClick={() => {
          newTab()
          navigate({ page: 'query', id: null })
        }}
        className="mb-1 shrink-0 rounded p-1.5 text-ink-400 hover:bg-ink-850 hover:text-ink-100"
      >
        <Plus aria-hidden className="size-4" />
      </button>
    </div>
  )
}

/** Where a narrow window opens what stands beside the answer on a wide one. */
type Side = 'fields' | 'columns' | 'library' | null

/** One open query: its chips, the answer, and what stands beside it. */
function Workbench({ tab }: { tab: Tab }) {
  const saved = useSavedQuery(tab.id)
  const list = useSavedQueries()
  const me = useWhoAmI().data?.identity
  const viewing = useViewingAs()
  const all = useQueryKinds()
  const name = useBlueprintName()
  const narrow = useNarrow()
  const save = useSaveQuery()
  const remove = useDeleteQuery()
  const draft = tab.draft
  const answer = useQueryAnswer(tab.ran)
  const [mode, setMode] = useState<'simple' | 'text'>('simple')
  const [shown, setShown] = useState<'table' | 'chart'>('table')
  const [side, setSide] = useState<Side>(null)
  const [focus, setFocus] = useState<{ where: 'fields' | 'columns'; column: string; n: number } | null>(null)
  const [keeping, setKeeping] = useState<{ anchor: HTMLElement; copy: boolean } | null>(null)
  const [saveMenu, setSaveMenu] = useState<HTMLElement | null>(null)
  const [exporting, setExporting] = useState<unknown>(null)
  useHere(tab.id ? tab.kept.title || undefined : null)

  const setDraft = (next: Draft) => updateTab(tab.key, { draft: next })

  // A saved query fills its tab once, when it is opened, and runs: reading it is the first job.
  useEffect(() => {
    if (tab.loaded || !tab.id || !saved.data || !all) return
    const read = saved.data.spec.sources.map((s) => readableOf(s.blueprint, all)).filter((b): b is Readable => !!b)
    const next: Draft = { title: saved.data.title, shared: saved.data.shared, audience: saved.data.audience?.id ?? null, home: saved.data.home?.id ?? null, homeShared: saved.data.homeShared, sources: saved.data.spec.sources, columns: editable(saved.data.spec.columns, read), ...(saved.data.spec.view ? { view: saved.data.spec.view } : {}) }
    updateTab(tab.key, { draft: next, kept: next, loaded: true, ran: next.sources.length ? readOf(next) : null })
  }, [tab.loaded, tab.id, saved.data, all])

  // A change to what the query reads runs it again once the changes settle; a change to how its answer is shown needs no read.
  const reads = readOf(draft)
  useEffect(() => {
    if (!tab.loaded || !draft.sources.length || reads === tab.ran) return
    const t = setTimeout(() => updateTab(tab.key, { ran: reads }), SETTLE_MS)
    return () => clearTimeout(t)
  }, [reads, tab.loaded, tab.ran, draft.sources.length])

  // What the reader may not see of a query shared with them is left out of what the page draws, and kept as it was on a save.
  const seen = useMemo(() => seenSources(draft, all ? (bp) => all.some((b) => b.id === bp) : null), [draft, all])
  const read = useMemo(() => draft.sources.map((s) => readableOf(s.blueprint, all ?? [])).filter((b): b is Readable => !!b), [draft.sources, all])
  const hues = useMemo(() => new Map(draft.sources.map((s, i) => [s.blueprint, swatch(hueOf(i))])), [draft.sources])
  const theirs = !!saved.data && !!me && saved.data.owner !== me.name
  // An admin may change anyone's; nobody changes anything while viewing as someone.
  const changes = !viewing && (!tab.id || !!saved.data?.mine)
  const dirty = tab.loaded && !sameDraft(draft, tab.kept)
  const result = answer.data ?? null
  const kinds = useMemo<ColumnKind[]>(() => (result ? result.columns.map((c) => columnKind(c, all ?? [])) : []), [result, all])
  const formats = useMemo(() => (result ? result.columns.map((c) => columnFormat(c, all ?? [])) : []), [result, all])
  const shaped = useMemo(() => (result ? shape(result.rows, draft.view, result.columns, kinds) : null), [result, draft.view, kinds])
  const sourceTitle = (bp: string) => {
    const found = read.find((b) => b.id === bp)
    return found ? (found.id === RUNS_SOURCE ? found.title : name(found)) : bp
  }

  const setView = (view: QueryView | undefined) => {
    const { view: _was, ...rest } = draft
    setDraft(view && Object.keys(view).length ? { ...rest, view } : rest)
  }
  const setColumns = (columns: Draft['columns'], removed?: string) => setDraft({ ...draft, columns, view: removed ? withoutColumn(draft.view, removed) : draft.view })
  const store = (next: Draft, asNew: boolean) =>
    save.mutate(
      { id: asNew ? null : tab.id, query: { title: next.title.trim(), shared: next.shared, audience: next.shared ? null : next.audience, home: next.home, homeShared: next.homeShared, spec: specOf(next) } },
      {
        onSuccess: (q) => {
          setKeeping(null)
          if (q.id !== tab.id) {
            // A copy opens in a tab of its own; the first save of a new one stays in its tab.
            if (asNew && tab.id) {
              openQuery(q.id)
              navigate({ page: 'query', id: q.id })
              return
            }
            updateTab(tab.key, { id: q.id, draft: next, kept: next, loaded: true })
            navigate({ page: 'query', id: q.id })
          } else updateTab(tab.key, { draft: next, kept: next })
        },
      },
    )
  const doExport = () => {
    setExporting(true)
    exportQuery(specOf(draft), draft.title.trim() || 'Query').then(
      () => setExporting(null),
      (e: unknown) => setExporting(e),
    )
  }
  const addSource = (blueprint: string) => {
    const bp = readableOf(blueprint, all ?? [])
    if (!bp || draft.sources.some((s) => s.blueprint === blueprint)) return
    setDraft({ ...draft, sources: [...draft.sources, { blueprint, clauses: [] }], columns: joined(draft.columns, bp) })
  }
  const narrowBy = (column: string) => {
    setFocus({ where: 'fields', column, n: Date.now() })
    if (narrow || !wide) setSide('fields')
  }
  const editColumn = (column: string) => {
    setFocus({ where: 'columns', column, n: Date.now() })
    if (narrow || !wider) setSide('columns')
  }
  const moveColumn = (column: string, by: -1 | 1) => {
    const i = draft.columns.findIndex((c) => c.id === column)
    if (i < 0 || !draft.columns[i + by]) return
    const next = [...draft.columns]
    ;[next[i], next[i + by]] = [next[i + by]!, next[i]!]
    setColumns(next)
  }

  // Which rails stand beside the answer: the fields from a laptop up, the columns too on a wide screen.
  const width = useWidth()
  const wide = !narrow && width >= 1180
  const wider = !narrow && width >= 1560

  const fields = result && shaped ? <QueryFields rows={result.rows} columns={result.columns} kinds={kinds} formats={formats} view={draft.view} onView={setView} focus={focus?.where === 'fields' ? focus.column : null} key={focus?.where === 'fields' ? focus.n : 0} /> : <p className="px-1 text-[13px] text-ink-400">Run the query to count its values here.</p>
  const columnsRail = <QueryColumns columns={draft.columns} read={read} all={all ?? []} hues={hues} onChange={setColumns} focus={focus?.where === 'columns' ? focus.column : null} key={focus?.where === 'columns' ? focus.n : 0} />
  // A removal asks first, saying everyone else it goes from, and closes every tab that held it.
  const removeSaved = (q: SavedQuery) => {
    if (!confirm(removeQuestion(q, me?.name ?? ''))) return
    remove.mutate(q.id, { onSuccess: () => (closeQuery(q.id), q.id === tab.id && navigate({ page: 'query', id: null })) })
  }
  const shelf = <Library queries={list.data?.queries ?? null} me={me?.name ?? ''} current={tab.id} onRemove={viewing ? undefined : removeSaved} />

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex flex-wrap items-start gap-x-4 gap-y-2 pt-3 pb-2">
        <div className="min-w-0 flex-1 basis-80">
          {changes && tab.loaded ? <NameField value={draft.title} onChange={(title) => setDraft({ ...draft, title })} /> : <h1 className="page-title">{draft.title || (tab.id ? '' : 'A new query')}</h1>}
          <About saved={tab.id ? (saved.data ?? null) : null} theirs={theirs} viewing={viewing} dirty={dirty && changes} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => setSide('library')} opens="dialog">
            <BookMarked aria-hidden className="size-3.5" /> Queries
          </Button>
          {changes && draft.sources.length > 0 && (
            <Button kind={dirty || !tab.id ? 'solid' : 'ghost'} disabled={save.isPending || (!!tab.id && !draft.title.trim())} onClick={(e) => (tab.id ? setSaveMenu(e.currentTarget) : setKeeping({ anchor: e.currentTarget, copy: false }))} opens={tab.id ? undefined : 'dialog'}>
              <Save aria-hidden className="size-3.5" /> {save.isPending ? 'Saving…' : 'Save'}
            </Button>
          )}
          {changes && tab.id && (
            <Button opens="dialog" onClick={(e) => setKeeping({ anchor: e.currentTarget, copy: false })}>
              <SharingIcon sharing={sharingOf(draft)} /> Share
            </Button>
          )}
          {!viewing && tab.id && !changes && (
            <Button opens="dialog" onClick={(e) => setKeeping({ anchor: e.currentTarget, copy: true })}>
              <Copy aria-hidden className="size-3.5" /> Copy to my library
            </Button>
          )}
        </div>
      </header>

      <QueryBar
        draft={seen.shown}
        read={read}
        all={all ?? []}
        hues={hues}
        result={result}
        kinds={kinds}
        formats={formats}
        mode={mode}
        onMode={setMode}
        onDraft={(next) => setDraft(seen.back(next))}
        onAdd={addSource}
        onRun={() => (draft.sources.length ? (tab.ran === reads ? void answer.refetch() : updateTab(tab.key, { ran: reads })) : undefined)}
        running={answer.isFetching}
        onSide={(s) => setSide(s)}
        wide={wide}
        wider={wider}
      />

      <ErrorNote error={answer.error ?? save.error ?? remove.error} />
      {exporting !== null && exporting !== true && <ErrorNote error={exporting} />}

      {!draft.sources.length ? (
        <Start all={all ?? []} onAdd={addSource} />
      ) : (
        <div className="flex min-h-0 flex-1 gap-4 pt-3">
          {wide && (
            <aside aria-label="Fields" className="w-60 shrink-0 overflow-y-auto pr-1">
              <h2 className="label mb-2 px-1">Fields</h2>
              {fields}
            </aside>
          )}
          <section aria-label="Answer" className="flex min-w-0 flex-1 flex-col gap-2">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <div role="tablist" aria-label="Show the answer as" className="inline-flex rounded-md border border-ink-700 p-0.5">
                <ShowTab on={shown === 'table'} onClick={() => setShown('table')} icon={<Table2 aria-hidden className="size-3.5" />} label="Table" />
                <ShowTab on={shown === 'chart'} onClick={() => setShown('chart')} icon={<BarChart3 aria-hidden className="size-3.5" />} label="Chart" />
              </div>
              {draft.view?.group?.length ? <GroupChips view={draft.view} columns={result?.columns ?? []} onView={setView} /> : null}
              {result && tab.ran !== reads && <span className="text-[13px] text-ink-400">Reading the change…</span>}
              {!wider && shown === 'table' && (
                <Button className="ml-auto" onClick={() => setSide('columns')} opens="dialog">
                  <Columns3 aria-hidden className="size-3.5" /> Columns {draft.columns.length}
                </Button>
              )}
            </div>
            {result && shaped ? (
              shown === 'table' ? (
                <QueryGrid
                  result={result}
                  shaped={shaped}
                  view={draft.view}
                  kinds={kinds}
                  formats={formats}
                  hues={hues}
                  sourceTitle={sourceTitle}
                  fromWords={(c) => fromWords(c, Object.keys(result.counts), read, sourceTitle)}
                  onView={setView}
                  onNarrow={narrowBy}
                  onRemove={(column) => setColumns(draft.columns.filter((c) => c.id !== column), column)}
                  onMove={moveColumn}
                  onEditColumn={editColumn}
                />
              ) : (
                <AnswerChart result={result} rows={shaped.rows} kinds={kinds} formats={formats} view={draft.view} hues={hues} sourceTitle={sourceTitle} onView={setView} />
              )
            ) : (
              <Empty>{answer.isFetching ? 'Reading every match…' : 'Reading it…'}</Empty>
            )}
            {result && shaped && <Foot result={result} kept={shaped.rows.length} draft={seen.shown} hues={hues} sourceTitle={sourceTitle} kinds={kinds} exporting={exporting === true} onExport={doExport} saved={tab.id && saved.data && !dirty ? { id: tab.id, title: saved.data.title } : undefined} />}
          </section>
          {wider && (
            <aside aria-label="Columns" className="w-80 shrink-0 overflow-y-auto pl-1">
              <h2 className="label mb-2 px-1">Columns</h2>
              {columnsRail}
            </aside>
          )}
        </div>
      )}

      {side === 'fields' && (
        <Drawer title="Fields" onClose={() => setSide(null)} width={360}>
          <div className="p-4">{fields}</div>
        </Drawer>
      )}
      {side === 'columns' && (
        <Drawer title="Columns" onClose={() => setSide(null)} width={420}>
          <div className="p-4">{columnsRail}</div>
        </Drawer>
      )}
      {side === 'library' && (
        <Drawer title="Queries" subtitle="Yours, and what is shared with you" onClose={() => setSide(null)} width={400}>
          <div className="p-4" onClick={(e) => (e.target as HTMLElement).closest('a') && setSide(null)}>
            {shelf}
          </div>
        </Drawer>
      )}
      {saveMenu && (
        <Popover anchor={saveMenu} menu label="Save" onClose={() => setSaveMenu(null)} className="w-60 py-1">
          <MenuItem autoFocus disabled={!dirty} onClick={() => (setSaveMenu(null), store(draft, false))}>
            Save the changes
          </MenuItem>
          <MenuItem onClick={() => (setKeeping({ anchor: saveMenu, copy: true }), setSaveMenu(null))}>Save a copy…</MenuItem>
          {dirty && <MenuItem onClick={() => (setDraft(tab.kept), setSaveMenu(null))}>Undo the changes</MenuItem>}
          <MenuItem danger disabled={!saved.data} onClick={() => (setSaveMenu(null), saved.data && removeSaved(saved.data))}>
            <Trash2 aria-hidden className="size-3.5" /> Remove it
          </MenuItem>
        </Popover>
      )}
      {keeping && (
        <Keep
          anchor={keeping.anchor}
          draft={keeping.copy ? { ...draft, title: theirs ? draft.title : `${draft.title} (copy)`, shared: false, audience: null, homeShared: false } : draft}
          home={saved.data?.home ?? null}
          blueprints={(all ?? []).filter((b) => datasetOf(b.id) === null)}
          asNew={keeping.copy || !tab.id}
          copy={keeping.copy}
          pending={save.isPending}
          error={save.error}
          onClose={() => (setKeeping(null), save.reset())}
          onSave={(next) => store(next, keeping.copy || !tab.id)}
        />
      )}
    </div>
  )
}

/** The window's width, as it changes. */
function useWidth(): number {
  const [w, setW] = useState(() => window.innerWidth)
  useEffect(() => {
    const on = () => setW(window.innerWidth)
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])
  return w
}

function ShowTab({ on, onClick, icon, label }: { on: boolean; onClick: () => void; icon: ReactNode; label: string }) {
  return (
    <button type="button" role="tab" aria-selected={on} onClick={onClick} className={`inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-[13px] ${on ? 'bg-ink-800 text-ink-50' : 'text-ink-300 hover:text-ink-100'}`}>
      {icon} {label}
    </button>
  )
}

/** The columns the answer is grouped by, each a chip that lets go of it. */
function GroupChips({ view, columns, onView }: { view: QueryView; columns: readonly QueryColumn[]; onView: (v: QueryView | undefined) => void }) {
  const group = view.group ?? []
  return (
    <span className="flex flex-wrap items-center gap-1.5 text-[13px] text-ink-400">
      Grouped by
      {group.map((g) => {
        const title = columns.find((c) => c.id === g)?.title ?? g
        return (
          <span key={g} className="inline-flex items-center rounded-md border border-edge bg-ink-850">
            <span className="py-0.5 pr-1 pl-2 text-ink-100">{title}</span>
            <button
              type="button"
              aria-label={`Stop grouping by ${title}`}
              onClick={() => {
                const rest = group.filter((x) => x !== g)
                const { group: _g, ...others } = view
                onView(rest.length ? { ...others, group: rest } : others)
              }}
              className="grid min-h-6 w-6 place-items-center self-stretch rounded-r-md border-l border-ink-700 text-ink-400 hover:text-ink-100"
            >
              <X aria-hidden className="size-3" />
            </button>
          </span>
        )
      })}
    </span>
  )
}

/** What each blueprint read fills a column with, in words, when there are several. */
function fromWords(column: QueryColumn, sources: string[], read: Readable[], titleOf: (bp: string) => string): string | undefined {
  if (sources.length < 2) return undefined
  const filled = sources.filter((s) => column.from[s] !== undefined)
  if (!filled.length) return 'No blueprint fills it'
  return filled
    .map((bp) => {
      const field = column.from[bp]!
      const found = read.find((b) => b.id === bp)
      const choice = found ? choicesIn(found).find((c) => c.id === field) : undefined
      return `${titleOf(bp)}: ${choice?.title ?? field}`
    })
    .join('; ')
}

/** The query as one line: its blueprints, each opening its own conditions, then the conditions on the answer's columns; or the same as text. */
function QueryBar({ draft, read, all, hues, result, kinds, formats, mode, onMode, onDraft, onAdd, onRun, running, onSide, wide, wider }: { draft: Draft; read: Readable[]; all: readonly Blueprint[]; hues: ReadonlyMap<string, string>; result: QueryResult | null; kinds: readonly ColumnKind[]; formats: readonly (FieldFormat | undefined)[]; mode: 'simple' | 'text'; onMode: (m: 'simple' | 'text') => void; onDraft: (d: Draft) => void; onAdd: (bp: string) => void; onRun: () => void; running: boolean; onSide: (s: Side) => void; wide: boolean; wider: boolean }) {
  const name = useBlueprintName()
  const [editing, setEditing] = useState<{ blueprint: string; anchor: HTMLElement } | null>(null)
  const [adding, setAdding] = useState<HTMLElement | null>(null)
  const counts = result?.counts ?? null
  const columns = result?.columns ?? []
  const where = draft.view?.where ?? []
  // A column shown as money takes and says its amounts as money, the way its field does in a grid.
  const fields: ConditionField[] = columns.map((c, i) => ({ id: c.id, title: c.title, ...(kinds[i] && kinds[i] !== 'relation' ? { type: kinds[i] } : {}), ...(formats[i] ? { def: { type: 'number' as const, format: formats[i] } } : {}) }))
  const choices = (field: string): Choice[] | null => {
    const i = columns.findIndex((c) => c.id === field)
    if (i < 0 || !result || kinds[i] === 'number' || kinds[i] === 'datetime') return null
    const s = spread(result.rows, i, kinds[i], 100)
    return s.buckets.filter((b) => b.key !== null).map((b) => ({ value: clauseText(b.value), label: b.label, count: b.count }))
  }
  const setWhere = (next: GridClause[]) => {
    const { where: _w, ...rest } = draft.view ?? {}
    const view = next.length ? { ...rest, where: next } : rest
    const { view: _v, ...others } = draft
    onDraft(Object.keys(view).length ? { ...others, view } : others)
  }
  const names = useMemo(() => ({ blueprints: all.map((b) => ({ id: b.id, title: name(b) })) }), [all, name])
  return (
    <div className="space-y-2 border-y border-ink-800 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <div role="tablist" aria-label="Write the query as" className="inline-flex rounded-md border border-ink-700 p-0.5">
          <ShowTab on={mode === 'simple'} onClick={() => onMode('simple')} icon={null} label="Simple" />
          <ShowTab on={mode === 'text'} onClick={() => onMode('text')} icon={null} label="Text" />
        </div>
        {mode === 'simple' && (
          <>
            <ul aria-label="Blueprints read" className="flex flex-wrap items-center gap-1.5">
              {draft.sources.map((s) => {
                const bp = read.find((b) => b.id === s.blueprint)
                const narrowed = s.clauses.filter((c) => c.field).length + (s.search?.trim() ? 1 : 0)
                const title = s.blueprint === RUNS_SOURCE ? RUNS.title : bp ? name(bp) : s.blueprint
                return (
                  <li key={s.blueprint}>
                    <button type="button" aria-haspopup="dialog" onClick={(e) => setEditing({ blueprint: s.blueprint, anchor: e.currentTarget })} className="flex items-center gap-2 rounded-md border border-ink-700 border-l-[3px] bg-ink-900 py-1 pr-2.5 pl-2 text-[13px] hover:border-ink-500" style={{ borderLeftColor: hues.get(s.blueprint) }}>
                      <BlueprintIcon bp={bp} className="size-3.5" />
                      <span className="font-medium text-ink-50">{title}</span>
                      {counts && <span className="text-ink-300 tabular-nums">{(counts[s.blueprint] ?? 0).toLocaleString('en-US')}</span>}
                      {narrowed > 0 && <span className="text-[12px] text-orbit">{narrowed === 1 ? '1 condition' : `${narrowed} conditions`}</span>}
                    </button>
                  </li>
                )
              })}
              {draft.sources.length > 0 && (
                <li>
                  <button type="button" aria-haspopup="dialog" onClick={(e) => setAdding(e.currentTarget)} className="btn btn-ghost border-dashed">
                    <Plus aria-hidden className="size-3.5" /> Blueprint
                  </button>
                </li>
              )}
            </ul>
            {draft.sources.length > 0 && <span aria-hidden className="h-5 w-px bg-ink-700 max-md:hidden" />}
            {draft.sources.length > 0 && (
              <Conditions clauses={where} onChange={setWhere} fields={fields} add="Where" ops={(field) => opsFor(fields.find((f) => f.id === field)?.type, false, choices(field) !== null)} choices={choices} />
            )}
          </>
        )}
        <div className="ml-auto flex items-center gap-2">
          {!wide && draft.sources.length > 0 && (
            <Button onClick={() => onSide('fields')} opens="dialog">
              <Filter aria-hidden className="size-3.5" /> Fields
            </Button>
          )}
          <Button kind="solid" disabled={!draft.sources.length || running} onClick={onRun} title="Read every match again">
            {running ? <RotateCw aria-hidden className="size-3.5" /> : <Play aria-hidden className="size-3.5" />} {running ? 'Running…' : 'Run'}
          </Button>
        </div>
      </div>
      {mode === 'text' && <TextQuery draft={draft} names={names} blueprints={all} onDraft={onDraft} toColumns={(columns, sources) => editable(columns, sources.map((s) => readableOf(s.blueprint, all)).filter((b): b is Readable => !!b))} />}
      {editing && (
        <Popover anchor={editing.anchor} width={460} label={`What to read of ${editing.blueprint}`} onClose={() => setEditing(null)}>
          <SourceEditor
            source={draft.sources.find((s) => s.blueprint === editing.blueprint)!}
            bp={read.find((b) => b.id === editing.blueprint)}
            hue={hues.get(editing.blueprint) ?? 'var(--color-ink-600)'}
            count={counts?.[editing.blueprint] ?? null}
            onChange={(next) => onDraft({ ...draft, sources: draft.sources.map((x) => (x.blueprint === next.blueprint ? next : x)) })}
            onRemove={() => {
              onDraft({ ...draft, sources: draft.sources.filter((x) => x.blueprint !== editing.blueprint), columns: left(draft.columns, editing.blueprint) })
              setEditing(null)
            }}
          />
        </Popover>
      )}
      {adding && (
        <Popover anchor={adding} width={380} label="Read a blueprint" onClose={() => setAdding(null)}>
          <div className="p-3">
            <BlueprintPicker all={all} taken={draft.sources.map((s) => s.blueprint)} onPick={(bp) => (onAdd(bp), setAdding(null))} />
          </div>
        </Popover>
      )}
    </div>
  )
}

function BlueprintPicker({ all, taken, onPick }: { all: readonly Blueprint[]; taken: string[]; onPick: (bp: string) => void }) {
  const name = useBlueprintName()
  return (
    <div className="flex">
      <Picker
        label={taken.length ? 'Read another blueprint' : 'Pick a blueprint to read'}
        placeholder="Type a blueprint's name"
        value={null}
        onChange={(picked) => picked && onPick(picked)}
        options={[...(taken.includes(RUNS_SOURCE) ? [] : [{ id: RUNS_SOURCE, label: RUNS.title, note: 'The runs you may see, newest first', group: 'Self-service' }]), ...all.filter((b) => !taken.includes(b.id)).map((b) => ({ id: b.id, label: name(b), note: b.id, ...(b.group ? { group: b.group } : {}) }))]}
      />
    </div>
  )
}

/** How old the rows of the datasets a query reads are, and the way to read them from their tools again. */
function DatasetFresh({ ids }: { ids: string[] }) {
  const datasets = useDatasets()
  const refresh = useRefreshDataset()
  const [busy, setBusy] = useState(false)
  const read = (datasets.data?.datasets ?? []).filter((d) => ids.includes(d.id)).flatMap((d) => (d.fetchedAt ? [d.fetchedAt] : []))
  const oldest = read.sort()[0]
  const again = async () => {
    setBusy(true)
    try {
      for (const id of ids) await refresh.mutateAsync(id)
    } finally {
      setBusy(false)
    }
  }
  return (
    <span className="inline-flex items-center gap-2">
      {oldest && <span title="When its rows were last read from outside the catalog">Read {ago(oldest)}</span>}
      <Button disabled={busy} onClick={() => void again()} title={refresh.error instanceof Error ? refresh.error.message : 'Read the dataset from its tool again'}>
        <RotateCw aria-hidden className="size-3.5" /> {busy ? 'Reading…' : 'Refresh'}
      </Button>
    </span>
  )
}

/** Starts a report from a saved query: its numbers and its table, ready to be given a title and a home. */
function ToReport({ query }: { query: { id: string; title: string } }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <FileChartColumn aria-hidden className="size-3.5" /> Make a report
      </Button>
      {open && <ReportCompose query={query} onClose={() => setOpen(false)} />}
    </>
  )
}

/** A query with nothing read yet: what to start from. */
function Start({ all, onAdd }: { all: readonly Blueprint[]; onAdd: (bp: string) => void }) {
  return (
    <div className="mx-auto mt-10 w-full max-w-xl space-y-4 px-1">
      <h2 className="text-[15px] font-medium text-ink-50">What do you want to read?</h2>
      <p className="text-[13px] text-ink-300">Pick a blueprint. Every row that matches is read at once. Narrow it by its own fields, read more blueprints beside it, then explore the answer: count its values, group it, add it up, and follow its relations.</p>
      <BlueprintPicker all={all} taken={[]} onPick={onAdd} />
    </div>
  )
}

/** The query as text: what it reads, its columns, and how its answer is shown, read back when it is applied. */
/** The editor for the text, loaded the first time the text is opened. */
const QueryEditor = lazy(() => import('./QueryEditor.tsx'))

function TextQuery({ draft, names, blueprints, onDraft, toColumns }: { draft: Draft; names: Parameters<typeof printQuery>[1]; blueprints: readonly Blueprint[]; onDraft: (d: Draft) => void; /** The columns as the page edits them, for the blueprints the text reads. */ toColumns: (columns: QuerySpec['columns'], sources: QuerySource[]) => Draft['columns'] }) {
  const printed = useMemo(() => printQuery(specOf(draft), names), [draft, names])
  const [text, setText] = useState(printed)
  const [error, setError] = useState<{ message: string; line: number; column: number } | null>(null)
  // A change made another way writes the text again, unless what is typed has not been applied.
  const typed = text !== printed
  const was = useRef(printed)
  useEffect(() => {
    if (!typed || text === was.current) setText(printed)
    was.current = printed
  }, [printed])
  // The editor is made once, so it reads the latest text through this when it applies.
  const current = useRef(text)
  current.current = text
  const apply = () => {
    const parsed = parseQuery(current.current, names)
    if ('error' in parsed) {
      setError(parsed.error)
      return
    }
    setError(null)
    const { sources, columns, view } = parsed.spec
    const { view: _was, ...rest } = draft
    onDraft({ ...rest, sources, columns: toColumns(columns, sources), ...(view ? { view } : {}) })
  }
  return (
    <div className="space-y-1.5">
      <Suspense fallback={<pre className={`${input} block min-h-24 w-full whitespace-pre-wrap font-mono text-[13px] leading-relaxed`}>{text}</pre>}>
        <QueryEditor value={text} onChange={setText} onApply={apply} names={names} blueprints={blueprints} describedBy="query-text-help" />
      </Suspense>
      <div className="flex flex-wrap items-center gap-3 text-[12px]">
        <Button kind={typed ? 'solid' : 'ghost'} disabled={!typed} onClick={apply}>
          Apply
        </Button>
        <span id="query-text-help" className="text-ink-400">
          Apply with ⌘ Enter. Suggestions come as you type, or with Ctrl Space: blueprints after <code className="font-mono">from</code>, their fields after <code className="font-mono">where</code> and <code className="font-mono">columns</code>, and the next part of the query. Point at a name to see what it is.
        </span>
        {error && (
          <span role="alert" className="text-red">
            Line {error.line}, column {error.column}: {error.message}
          </span>
        )}
      </div>
    </div>
  )
}

/**
 * The answer drawn as bars: one for each value of a column, as long as the
 * rows it stands for or a total over a number column of them (the sum of a
 * cost, say), longest first, each split into the values of another column or
 * the blueprints the rows came from. What it draws is part of the view
 * (`chartPlan`), so a saved query opens on its chart, and a number reads in
 * its column's format, money as money.
 */
function AnswerChart({ result, rows, kinds, formats, view, hues, sourceTitle, onView }: { result: QueryResult; rows: QueryResult['rows']; kinds: readonly ColumnKind[]; formats: readonly (FieldFormat | undefined)[]; view: QueryView | undefined; hues: ReadonlyMap<string, string>; sourceTitle: (bp: string) => string; onView: (v: QueryView | undefined) => void }) {
  const columns = result.columns
  const sources = Object.keys(result.counts)
  const plan = useMemo(() => chartPlan(view, columns, kinds, rows, sources.length), [view, columns, kinds, rows, sources.length])
  const chart = useMemo(() => chartBars(rows, columns, plan), [rows, columns, plan])
  const at = (id: string | null) => (id ? columns.findIndex((c) => c.id === id) : -1)
  const titleOf = (id: string | null) => columns[at(id)]?.title ?? id ?? ''
  const pick = (patch: QueryChart) => onView({ ...view, chart: { ...view?.chart, ...patch } })
  const byAt = at(plan.by)
  const money = plan.total === 'count' ? undefined : formats[at(plan.column)]
  const said = (n: number) => numberText(n, money)
  const measure = plan.total === 'count' ? 'Rows' : `${CHART_WORDS[plan.total]} ${titleOf(plan.column)}`
  const most = Math.max(...chart.bars.map((b) => Math.abs(b.amount)), 0) || 1
  const colourOf = (key: string, i: number) => (plan.split === BY_BLUEPRINT ? (hues.get(key) ?? 'var(--color-ink-500)') : swatch(hueOf(i)))
  const partLabel = (p: { key: string; label: string }) => (plan.split === BY_BLUEPRINT ? sourceTitle(p.key) : p.label)
  const colours = new Map(chart.parts.map((p, i) => [p.key, colourOf(p.key, i)]))
  const numbers = columns.map((c, i) => ({ c, i })).filter(({ i }) => kinds[i] === 'number')
  const splits = columns.filter((c, i) => c.id !== plan.by && kinds[i] !== 'number' && kinds[i] !== 'datetime' && c.id !== BY_BLUEPRINT)
  const keep = (b: Bar) => onView({ ...view, where: [...(view?.where ?? []).filter((c) => !(c.field === plan.by && c.op === 'eq')), b.key === null ? { field: plan.by, op: 'exists', value: '', not: true } : { field: plan.by, op: 'eq', value: clauseText(b.value) }] })
  return (
    <div className="min-h-0 overflow-auto rounded-md border border-ink-800 p-4">
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px]">
        <label className="flex items-center gap-2 text-ink-300">
          Bars by
          <select className={`${input} py-1`} value={plan.by} onChange={(e) => pick({ by: e.target.value })}>
            {columns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-ink-300">
          Length
          <select className={`${input} py-1`} value={plan.total === 'count' ? 'count' : `${plan.total}:${plan.column}`} onChange={(e) => (e.target.value === 'count' ? pick({ total: 'count' }) : pick({ total: e.target.value.split(':')[0] as ChartTotal, column: e.target.value.slice(e.target.value.indexOf(':') + 1) }))}>
            <option value="count">Rows</option>
            {numbers.flatMap(({ c }) =>
              (['sum', 'avg', 'max', 'min'] as const).map((t) => (
                <option key={`${t}:${c.id}`} value={`${t}:${c.id}`}>
                  {CHART_WORDS[t]} {c.title}
                </option>
              )),
            )}
          </select>
        </label>
        {(plan.total === 'count' || plan.total === 'sum') && (
          <label className="flex items-center gap-2 text-ink-300">
            Split by
            <select className={`${input} py-1`} value={plan.split ?? ''} onChange={(e) => pick({ split: e.target.value || null })}>
              <option value="">Nothing</option>
              {sources.length > 1 && plan.by !== BY_BLUEPRINT && <option value={BY_BLUEPRINT}>Blueprint</option>}
              {splits.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title}
                </option>
              ))}
            </select>
          </label>
        )}
        <span className="ml-auto text-ink-300">
          {measure}: <span className="font-medium text-ink-50 tabular-nums">{said(chart.whole)}</span>
        </span>
      </div>
      {chart.parts.length > 1 && (
        <ul className="mb-3 flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-ink-300" aria-label={`Split by ${plan.split === BY_BLUEPRINT ? 'blueprint' : titleOf(plan.split)}`}>
          {chart.parts.map((p) => (
            <li key={p.key} className="inline-flex items-center gap-1.5">
              <span aria-hidden className="size-2 rounded-[2px]" style={{ background: colours.get(p.key) }} /> {partLabel(p)}
            </li>
          ))}
        </ul>
      )}
      <ul className="space-y-1.5" aria-label={`${measure} by ${titleOf(plan.by)}`}>
        {chart.bars.map((b) => (
          <li key={b.key ?? '∅'} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 text-[13px] md:grid-cols-[minmax(6rem,14rem)_minmax(0,1fr)_auto]">
            <button type="button" title="Keep only these rows" onClick={() => keep(b)} className={`truncate py-1 text-left hover:underline ${b.key === null ? 'text-ink-400 italic' : 'text-ink-100'}`}>
              {typeof b.value === 'number' && kinds[byAt] === 'number' ? numberText(b.value, formats[byAt]) : b.label}
            </button>
            <span className="flex h-4 overflow-hidden rounded-sm bg-ink-850 max-md:order-last max-md:col-span-2" style={{ width: `${Math.max(0.5, (Math.abs(b.amount) / most) * 100)}%` }} aria-hidden>
              {b.parts.length ? (
                b.parts.map((p) => <span key={p.key} className="h-full" title={`${partLabel(chart.parts.find((x) => x.key === p.key) ?? { key: p.key, label: p.key })}: ${said(p.amount)}`} style={{ width: `${b.amount ? (p.amount / b.amount) * 100 : 0}%`, background: colours.get(p.key) }} />)
              ) : (
                <span className="h-full w-full" style={{ background: (b.blueprint && hues.get(b.blueprint)) || 'var(--color-orbit)' }} />
              )}
            </span>
            <span className="min-w-16 text-right text-ink-200 tabular-nums">{said(b.amount)}</span>
          </li>
        ))}
      </ul>
      {chart.more > 0 && <p className="mt-3 text-[12px] text-ink-400">{chart.more.toLocaleString('en-US')} smaller bars are not drawn. Narrow the rows, or draw bars by another column.</p>}
    </div>
  )
}

/** What a bar's length is said as, before the column's name. */
const CHART_WORDS: Readonly<Record<Exclude<ChartTotal, 'count'>, string>> = { sum: 'Sum of', avg: 'Average', max: 'Highest', min: 'Lowest' }

/** Under the answer: how many rows it keeps of how many it read, each blueprint's share, how long it took, and what to do with all of them. */
function Foot({ result, kept, draft, hues, sourceTitle, kinds, exporting, onExport, saved }: { result: QueryResult; kept: number; draft: Draft; hues: ReadonlyMap<string, string>; sourceTitle: (bp: string) => string; kinds: readonly ColumnKind[]; exporting: boolean; onExport: () => void; saved?: { id: string; title: string } }) {
  const narrowed = kept !== result.rows.length
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px] text-ink-300">
      <span>
        <span className="font-medium text-ink-50 tabular-nums">{kept.toLocaleString('en-US')}</span> {kept === 1 ? 'row' : 'rows'}
        {narrowed && <> of {result.rows.length.toLocaleString('en-US')} read</>}
      </span>
      {Object.keys(result.counts).length > 1 &&
        Object.entries(result.counts).map(([bp, n]) => (
          <span key={bp} className="inline-flex items-center gap-1.5">
            <span aria-hidden className="size-2 rounded-[2px]" style={{ background: hues.get(bp) }} />
            {sourceTitle(bp)} {n.toLocaleString('en-US')}
          </span>
        ))}
      {result.ms !== undefined && <span className="tabular-nums">{result.ms < 1000 ? `${result.ms} ms` : `${(result.ms / 1000).toFixed(1)} s`}</span>}
      {result.truncated && <span className="text-amber">More matched than one answer holds. Narrow it to read them all.</span>}
      <div className="ml-auto flex flex-wrap gap-2">
        <Button disabled={exporting} onClick={onExport}>
          <Download aria-hidden className="size-3.5" /> {exporting ? 'Exporting…' : 'Export to Excel'}
        </Button>
        {draft.sources.some((s) => datasetOf(s.blueprint) !== null) && <DatasetFresh ids={draft.sources.flatMap((s) => datasetOf(s.blueprint) ?? [])} />}
        {/* A report reads a saved query as it stands when it publishes, so only a saved one starts a report. */}
        {saved && <ToReport query={saved} />}
        {draft.sources
          .filter((s) => s.blueprint !== RUNS_SOURCE && datasetOf(s.blueprint) === null)
          .map((s) => (
            <SourceActions key={s.blueprint} source={s} title={sourceTitle(s.blueprint)} result={result} draft={draft} kinds={kinds} saved={saved} />
          ))}
      </div>
    </div>
  )
}

/** The most rows a batch is asked for by name; past it, the rows a view narrows are too many to name. */
const NAMED_MAX = 2000

/** The actions that run on many of one blueprint read, each to run on every row of it the answer keeps. */
function SourceActions({ source, title, result, draft, kinds, saved }: { source: QuerySource; title: string; result: QueryResult; draft: Draft; kinds: readonly ColumnKind[]; saved?: { id: string; title: string } }) {
  const actions = useBatchActions(source.blueprint)
  const viewing = useViewingAs()
  const blueprints = useQueryKinds()
  const bp = blueprints?.find((b) => b.id === source.blueprint)
  const [running, setRunning] = useState<ActionView | null>(null)
  // Conditions on the answer's columns narrow it past what the blueprint's own filter says: then the rows are named one by one.
  const where = draft.view?.where ?? []
  const named = useMemo(() => (where.length ? keptRows(result.rows, { where }, result.columns, kinds).filter((r) => r.blueprint === source.blueprint) : null), [where, result, kinds, source.blueprint])
  const count = named ? named.length : (result.counts[source.blueprint] ?? 0)
  if (viewing || !actions.length || !count) return null
  if (named && named.length > NAMED_MAX) return <span className="text-[13px] text-ink-400">Narrow the {title} to {NAMED_MAX.toLocaleString('en-US')} to run an action on them</span>
  // Values are read as the hub reads them: a field that holds text keeps it as text.
  const filter = conditionsFilter(source.clauses, source.search, bp ? typesIn(bp, (id) => blueprints?.find((b) => b.id === id)) : undefined)
  const request = named ? { entities: named.map((r) => ({ blueprint: r.blueprint, key: r.key })) } : { query: { blueprint: source.blueprint, ...(filter ? { filter } : {}), states: source.states ?? (['active', 'missing'] as EntityState[]), ...(source.hidden ? { hidden: true } : {}) } }
  return (
    <>
      <select className={input} aria-label={`Run an action on the ${count} ${title}`} value="" onChange={(e) => setRunning(actions.find((a) => a.id === e.target.value) ?? null)}>
        <option value="">
          Run on {count === 1 ? 'the 1' : `all ${count.toLocaleString('en-US')}`} {title}…
        </option>
        {actions.map((a) => (
          <option key={a.id} value={a.id}>
            {a.title}
          </option>
        ))}
      </select>
      {running && <BatchDrawer action={running} request={request} count={count} onClose={() => setRunning(null)} saved={saved} />}
    </>
  )
}

/** One blueprint the query reads: its conditions, a search, and which states. */
function SourceEditor({ source, bp, hue, count, onChange, onRemove }: { source: QuerySource; bp: Readable | undefined; hue: string; count: number | null; onChange: (s: QuerySource) => void; onRemove: () => void }) {
  const name = useBlueprintName()
  const runs = source.blueprint === RUNS_SOURCE
  const blueprints = useQueryKinds()
  const fields = useMemo<ConditionField[]>(() => (runs ? [...RUN_COLUMNS] : bp && blueprints ? conditionFields(bp, blueprints, name) : []), [bp, runs, blueprints, name])
  const states = source.states ?? ['active', 'missing']
  const title = runs ? RUNS.title : bp ? name(bp) : source.blueprint
  return (
    <section aria-label={title} className="space-y-3 border-l-[3px] p-4" style={{ borderLeftColor: hue }}>
      <div className="flex items-center gap-2">
        <BlueprintIcon bp={bp} className="size-4" />
        <h2 className="min-w-0 flex-1 text-[15px] font-medium break-words text-ink-50">{title}</h2>
        {count !== null && <span className="text-[12px] text-ink-300 tabular-nums">{count.toLocaleString('en-US')} matched</span>}
      </div>
      {runs ? (
        <p className="text-[12px] text-ink-400">The runs you may see, newest first: your own, the ones you decide, and those of actions you may run. A time takes a date, or within and older take a span such as 7d.</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          <input className={`${input} min-w-0 flex-1 basis-40 text-[13px]`} aria-label={`Search ${title}`} placeholder="Search its keys, titles, and values" value={source.search ?? ''} onChange={(e) => onChange({ ...source, search: e.target.value })} />
          <select className={`${input} text-[13px]`} aria-label={`Which ${title} to read`} value={states.join(',')} onChange={(e) => onChange({ ...source, states: e.target.value.split(',') as EntityState[] })}>
            <option value="active,missing">Active and missing</option>
            {ENTITY_STATES.map((s) => (
              <option key={s} value={s}>
                Only {s}
              </option>
            ))}
            <option value={ENTITY_STATES.join(',')}>Every state</option>
          </select>
        </div>
      )}
      <Conditions
        clauses={source.clauses}
        onChange={(clauses) => onChange({ ...source, clauses })}
        fields={fields}
        add="Condition"
        ops={(field) => opsFor(fields.find((f) => f.id === field)?.type, !runs && field.startsWith('r:'), choicesOf(field, runs ? undefined : bp?.fields[field]) !== null)}
        choices={(field) => choicesOf(field, runs ? undefined : bp?.fields[field])}
      />
      <div className="flex justify-end border-t border-ink-700 pt-3">
        <Button kind="danger" onClick={onRemove}>
          Stop reading {title}
        </Button>
      </div>
    </section>
  )
}

/** The values a condition on a field picks from: an enum's, a boolean's, a status level, or a run's state. Null where the value is typed. */
function choicesOf(field: string, def: FieldDef | undefined): Choice[] | null {
  const values = field === 'run:state' ? [...ACTION_RUN_STATES] : field === '$status' ? [...STATUS_LEVELS] : def?.type === 'enum' ? (def.values ?? []) : def?.type === 'boolean' ? ['true', 'false'] : null
  return values && values.map((value) => ({ value, label: value, color: valueColor(def, value) }))
}

/** The query's name, typed in place: it wraps as a heading would, and grows to hold it, so a long name is never cut. */
function NameField({ value, onChange }: { value: string; onChange: (title: string) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const fit = () => {
      el.style.height = '0px'
      el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`
    }
    fit()
    const watch = new ResizeObserver(fit)
    watch.observe(el.parentElement ?? el)
    void document.fonts?.ready.then(fit)
    return () => watch.disconnect()
  }, [value])
  return (
    <textarea
      ref={ref}
      rows={1}
      className="page-title -mx-1 block w-full resize-none overflow-hidden rounded-md border border-transparent bg-transparent px-1 hover:border-edge focus:border-ink-300"
      aria-label="Query name"
      placeholder="A new query"
      value={value}
      onChange={(e) => onChange(e.target.value.replace(/\s*\n\s*/g, ' '))}
      onKeyDown={(e) => e.key === 'Enter' && e.preventDefault()}
    />
  )
}

/** Whose query it is, who may open it, and whether it changed since it was saved. */
function About({ saved, theirs, viewing, dirty }: { saved: SavedQuery | null; theirs: boolean; viewing: string | null; dirty: boolean }) {
  const parts: ReactNode[] = []
  if (viewing) parts.push(<span key="v">What {viewing} sees, read as them</span>)
  if (saved) {
    if (saved.home)
      parts.push(
        <Link key="h" to={{ page: 'entity', ...saved.home.entity }} className="inline-flex items-center gap-1 text-ink-200 hover:underline max-md:min-h-11">
          <House aria-hidden className="size-3.5" /> {saved.home.title}
        </Link>,
      )
    parts.push(<span key="o">{theirs ? `By ${shortName(saved.owner)}` : 'In your library'}</span>)
    parts.push(
      <span key="s" className="inline-flex items-center gap-1">
        <SharingIcon sharing={sharingOf(saved)} /> {sharingWords(saved)}
      </span>,
    )
  } else parts.push(<span key="n">Not saved</span>)
  if (dirty && saved) parts.push(<span key="d" className="text-amber">Changed since it was saved</span>)
  return <p className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-ink-400">{parts}</p>
}

const sharingWords = (q: Pick<SavedQuery, 'shared' | 'audience' | 'home' | 'homeShared'>) => (q.shared ? 'Everyone can open it' : q.audience ? `${q.audience.title} can open it` : q.homeShared ? `The people of ${q.home?.title ?? 'its home'} can open it` : 'Only you can open it')
/** Who may open one, in a word or two for a list. */
const sharingShort = (q: Pick<SavedQuery, 'shared' | 'audience' | 'home' | 'homeShared'>) => (q.shared ? 'Everyone' : q.audience ? q.audience.title : q.homeShared ? `People of ${q.home?.title ?? 'its home'}` : 'Only you')

function SharingIcon({ sharing }: { sharing: Sharing }) {
  const Shape = sharing === 'everyone' ? Globe : sharing === 'audience' ? Users : sharing === 'home' ? House : Lock
  return <Shape aria-hidden className="size-3.5" />
}

/** The library: each home's collection, then what the reader saved, then what others shared with an audience they are in, then with everyone. A query opens in a tab of its own. */
function Library({ queries, me, current, onRemove }: { queries: SavedQuery[] | null; me: string; current: string | null; /** Removes one the reader may change, after asking; left out, nothing is removed here. */ onRemove?: (q: SavedQuery) => void }) {
  const [find, setFind] = useState('')
  const shelves = useMemo(() => library(queries ?? [], me, find), [queries, me, find])
  return (
    <nav aria-label="Saved queries" className="space-y-4">
      <input className={`${input} w-full`} aria-label="Find a saved query" placeholder="Find a query by name, owner, home, or audience" value={find} onChange={(e) => setFind(e.target.value)} />
      {queries && !shelves.length && <p className="text-[13px] text-ink-400">{find ? 'No saved query matches.' : 'Nothing saved yet. Save a query to keep it here, and share it when others need it.'}</p>}
      {shelves.map((s) => (
        <section key={s.id} aria-label={s.title}>
          <h3 className="label mb-1 flex items-baseline justify-between gap-2 px-2">
            <span>{s.title}</span>
            <span className="tabular-nums">{s.queries.length}</span>
          </h3>
          <ul className="space-y-0.5">
            {s.queries.map((q) => (
              <li key={q.id} className="group flex items-start gap-1">
                <Link to={{ page: 'query', id: q.id }} current={q.id === current} className={`block min-w-0 flex-1 rounded-md px-2 py-1.5 ${q.id === current ? 'bg-ink-800 text-ink-50' : 'text-ink-200 hover:bg-ink-850 hover:text-ink-50'}`}>
                  <span className="block text-[13px] break-words">{q.title}</span>
                  <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[12px] text-ink-400">
                    {q.owner === me ? (
                      <>
                        <SharingIcon sharing={sharingOf(q)} /> {sharingShort(q)}
                      </>
                    ) : (
                      shortName(q.owner)
                    )}
                    <span aria-hidden>·</span>
                    {q.spec.sources.length === 1 ? '1 blueprint' : `${q.spec.sources.length} blueprints`}
                  </span>
                </Link>
                {onRemove && q.mine && (
                  <button type="button" aria-label={`Remove ${q.title}`} title="Remove it" onClick={() => onRemove(q)} className="mt-1 shrink-0 rounded-md p-1.5 text-ink-400 hover:bg-ink-850 hover:text-red max-md:p-3">
                    <Trash2 aria-hidden className="size-3.5" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </nav>
  )
}

/**
 * Saves the query to the reader's library, and says where it belongs and who
 * may open it: only them, an audience they are in, the people of its home, or
 * everyone. A query with a home is listed under it, in the library and on the
 * home's own page.
 */
function Keep({ anchor, draft, home: known, blueprints, asNew, copy, pending, error, onClose, onSave }: { anchor: HTMLElement; draft: Draft; home: Home | null; blueprints: readonly Blueprint[]; asNew: boolean; copy: boolean; pending: boolean; error: unknown; onClose: () => void; onSave: (d: Draft) => void }) {
  const [title, setTitle] = useState(draft.title)
  const [sharing, setSharing] = useState<Sharing>(sharingOf(draft))
  const audiences = useQueryAudiences(true).data?.audiences ?? null
  const [audience, setAudience] = useState<string | null>(draft.audience)
  const [home, setHome] = useState<string | null>(draft.home)
  const chosen = audience ?? audiences?.[0]?.id ?? null
  const homeName = home && known?.id === home ? known.title : null
  const shown = sharing === 'home' && !home ? 'private' : sharing
  const ok = !!title.trim() && (shown !== 'audience' || !!chosen)
  const heading = asNew ? (copy ? 'Copy to your library' : 'Save to your library') : 'Share this query'
  const submit = () => ok && onSave({ ...draft, title: title.trim(), shared: shown === 'everyone', audience: shown === 'audience' ? chosen : null, home, homeShared: shown === 'home' })
  return (
    <Popover anchor={anchor} width={420} onClose={onClose} label={heading}>
      <form
        className="space-y-3 p-4"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <h2 className="text-[15px] font-medium text-ink-50 max-md:hidden">{heading}</h2>
        <label className="block space-y-1">
          <span className="label">Name</span>
          <input autoFocus className={`${input} w-full`} value={title} placeholder="Name it to find it again" onChange={(e) => setTitle(e.target.value)} />
        </label>
        <div role="group" aria-label="Where it belongs" className="space-y-1">
          <span className="label block">Where it belongs</span>
          <p className="text-[13px] text-ink-200">{home ? (homeName ?? <HomeRef value={home} />) : 'Nowhere yet'}</p>
          <p className="text-[12px] text-ink-400">A program, a team, or any entity. The query is listed under it in the library and on its page.</p>
          <HomePicker value={home} blueprints={blueprints} onChange={setHome} />
        </div>
        <fieldset className="space-y-1.5">
          <legend className="label mb-1">Who can open it</legend>
          <Choice on={shown === 'private'} onPick={() => setSharing('private')} icon={<Lock aria-hidden className="size-4" />} title="Only you" note="It stays in your library. Nobody else sees it." />
          <Choice on={shown === 'home'} onPick={() => setSharing('home')} disabled={!home} icon={<House aria-hidden className="size-4" />} title={homeName ? `The people of ${homeName}` : 'The people of its home'} note={home ? 'Everyone who owns its home: its teams, its leads, and its members. Only one of them, or an admin, opens it to them.' : 'Pick where it belongs first.'} />
          <Choice on={shown === 'audience'} onPick={() => setSharing('audience')} disabled={audiences !== null && !audiences.length} icon={<Users aria-hidden className="size-4" />} title="An audience you are in" note={audiences !== null && !audiences.length ? 'You are in no audience of the access policy yet.' : 'The people of one audience the access policy names.'}>
            {shown === 'audience' && audiences && audiences.length > 0 && (
              <select className={`${input} mt-2 w-full`} aria-label="Audience" value={chosen ?? ''} onChange={(e) => setAudience(e.target.value)}>
                {audiences.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.title}
                  </option>
                ))}
              </select>
            )}
          </Choice>
          <Choice on={shown === 'everyone'} onPick={() => setSharing('everyone')} icon={<Globe aria-hidden className="size-4" />} title="Everyone" note="Every person who signs in to Orrery, and every agent with an access token." />
        </fieldset>
        <ul className="list-disc space-y-1 border-t border-ink-700 pt-3 pl-4 text-[12px] text-ink-300">
          <li>Whoever opens it reads it with their own access. They see only the rows and columns they may see, so two people can get different answers.</li>
          <li>Only you and the admins can change it. Others run it, export it, or copy it to their own library.</li>
          <li>An admin can check one person's answer: view the hub as them, then open it.</li>
        </ul>
        <ErrorNote error={error} />
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button kind="solid" type="submit" disabled={!ok || pending}>
            {pending ? 'Saving…' : asNew ? 'Save to your library' : 'Save'}
          </Button>
        </div>
      </form>
    </Popover>
  )
}

function Choice({ on, onPick, disabled = false, icon, title, note, children }: { on: boolean; onPick: () => void; disabled?: boolean; icon: ReactNode; title: string; note: string; children?: ReactNode }) {
  return (
    <label className={`flex gap-3 rounded-md border px-3 py-2.5 ${disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'} ${on ? 'border-orbit bg-orbit/10' : 'border-ink-700 hover:border-ink-500'}`}>
      <input type="radio" name="query-sharing" className="sr-only" checked={on} disabled={disabled} onChange={onPick} />
      <span className={`mt-0.5 ${on ? 'text-orbit' : 'text-ink-300'}`}>{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-medium text-ink-50">{title}</span>
        <span className="block text-[12px] text-ink-400">{note}</span>
        {children}
      </span>
    </label>
  )
}

