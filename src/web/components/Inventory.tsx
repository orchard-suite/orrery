import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ArrowUpDown, ChevronDown, ChevronRight, ChevronsLeftRight, ChevronsRightLeft, Columns3, Download, EyeOff, Filter, GripVertical, Group, Lock, MoreHorizontal, PanelRight, Pencil, Plus, Search, SlidersHorizontal, Star, Trash2, X } from 'lucide-react'
import { useQueries, useQueryClient } from '@tanstack/react-query'
import { useVirtualizer, type Virtualizer } from '@tanstack/react-virtual'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { clauseRelation, type ColumnDistribution, type EntitiesResponse, type EntityPatch, type EntityQuery, type GridClause, type GridGroup, type GridLayout, type GridLayoutPatch } from '../../shared/api.ts'
import { arrange, fromLegacy, placeByHand, placeByStandard, showByHand, sizeByStandard, type ColumnFacts, type LayoutColumn } from '../../shared/columns.ts'
import { currencyOf, formatCurrency } from '../../shared/currency.ts'
import { matches } from '../../shared/filter.ts'
import { NONE, blueprintsOf, inScope, partFor, reached, scoreEntity } from '../../shared/scorecard.ts'
import { iconNamed, linkMark, linksOf } from '../../shared/icons.ts'
import { ENTITY_STATES, FIELD_TYPES, actionTargets, addressKey, entityId, isSpread, isLocked, valueColor, type ActionView, type Blueprint, type Entity, type EntityRef, type EntityState, type FieldDef, type Filter as FilterDsl, type StatusLevel } from '../../shared/model.ts'
import { BLOCK, call, keys, useAccessGuard, useEntity, useActions, useBlueprintName, useBlueprints, useBulkEdit, useCreateEntity, useDeleteEntities, useEditEntity, useEntityAction, useGridBlock, useGridShares, type BulkTarget, useGrid, useGridStandard, useSaveBlueprint, useSaveGrid, useScorecards, useCan, useCanEdit, useIsAdmin, useSetStarred, usePins, useViewingAs, asViewed } from '../api.ts'
import { iconOf, pinnedOf } from '../actions.ts'
import { clauseFilter, shareClause, typesIn, withShare } from '../../shared/clauses.ts'
import { opsFor, reachOf } from '../conditions.ts'
import { ago, humanTimes, short, words } from '../format.ts'
import { BlueprintIcon, Icon } from '../icons.tsx'
import { isSpec, prefill, readSpec, specSummary } from '../spec.ts'
import { browseFrom } from '../browse.ts'
import { navigate, onLinkClick, href } from '../router.ts'
import { useZen } from '../zen.ts'
import { useChanged, useEscape } from '../layers.ts'
import { addWords, opened, openedColumns } from '../editable.ts'
import { EntityIcon, fieldLock, IconPicker, RelationEditor, relationPatch, TITLE_DEF, ValueEditor } from './editors.tsx'
import { BlueprintIndex } from './BlueprintIndex.tsx'
import { Conditions, type Choice, type ConditionField } from './Clauses.tsx'
import { Drawer } from './Drawer.tsx'
import { EntityStar, PinStar } from './Star.tsx'
import { EntityPanel, Value } from './Entity.tsx'
import { RunDrawer } from './ActionForm.tsx'
import { BatchDrawer, useBatchActions } from './Batch.tsx'
import { FieldPopover, NAME, specOf } from './FieldForm.tsx'
import { TypeGlyph } from './FieldType.tsx'
import { PhoneBar } from './PhoneBar.tsx'
import { StatusPicker, statusWords } from './StatusPicker.tsx'
import { MenuItem, Popover, walk } from './Popover.tsx'
import { DistributionBar } from './Distribution.tsx'
import { Button, Chip, Empty, ErrorNote, input, Kicker, Lamp, Link, Panel, useNarrow } from './ui.tsx'
import { isTrend, TrendCell } from './Trend.tsx'
import { spot } from '../spots.ts'
import { PAGE_ICON } from '../title.ts'
import { useScrollBackIn, useVisit } from '../trail.ts'

/** The way up to every blueprint on a phone, drawn as its page, so it is never taken for Back. */
const EveryBlueprint = PAGE_ICON.inventory

interface Column {
  id: string
  title: string
  kind: 'meta' | 'field' | 'relation' | 'incoming' | 'scorecard' | 'rule' | 'action'
  width: number
  def?: FieldDef
  /** For a relation: the blueprint it points at. */
  target?: string
  /** For an action: the action each row's button runs. */
  action?: ActionView
}

const META: Omit<Column, 'width'>[] = [
  { id: 'status', title: '', kind: 'meta' },
  { id: 'title', title: 'Title', kind: 'meta' },
  { id: 'key', title: 'Identifier', kind: 'meta' },
  { id: 'state', title: 'State', kind: 'meta' },
  { id: 'owner', title: 'Source', kind: 'meta' },
  { id: 'lastSeenAt', title: 'Last seen', kind: 'meta' },
  { id: 'updatedAt', title: 'Last update', kind: 'meta' },
]

type Clause = GridClause

/** Every part must hold: none is no filter, one is itself. */
function joined(parts: FilterDsl[]): FilterDsl | null {
  return parts.length === 0 ? null : parts.length === 1 ? parts[0]! : { and: parts }
}


/** The kind of value each thing the hub keeps of every entity holds, where it is not text. */
const META_TYPES: Partial<Record<string, FieldDef['type']>> = { state: 'enum', lastSeenAt: 'datetime', updatedAt: 'datetime' }

/** The column a condition's field is shared out under: what the hub keeps by its bare name, a relation as itself, a field as `f:`. */
function columnOf(field: string): string {
  return field.startsWith('$') ? field.slice(1) : field.startsWith('r:') ? field : `f:${field}`
}

/** The width of the column of checkboxes that leads every row for whoever may edit. */
const LEAD = 32
/** The width of the column of row actions pinned to the right edge; the add-property column is pinned just inside it. */
const ACTIONS = 32
/** An entity's state as a chip: present, gone quiet, gone. */
const STATE_DEF = { type: 'enum', values: [...ENTITY_STATES], colors: { active: 'green', missing: 'yellow', deleted: 'grey' } } satisfies Pick<FieldDef, 'type' | 'values' | 'colors'>
type OnEdit = (ref: EntityRef, patch: EntityPatch) => void

/** The catalog: one table per blueprint, in the shape of a service catalog. */
export function Inventory({ blueprint }: { blueprint: string | null }) {
  const blueprints = useBlueprints()
  const list = blueprints.data?.blueprints ?? []
  const counts = blueprints.data?.counts ?? {}
  const hidden = new Set(blueprints.data?.layout.hidden ?? [])
  const current = list.find((b) => b.id === blueprint) ?? list.find((b) => !hidden.has(b.id)) ?? list[0]
  const narrow = useNarrow()
  const pins = usePins().data
  if (narrow) {
    // A phone has no room for the list beside the grid: it starts at the list of blueprints, and a blueprint fills the screen.
    const picked = list.find((b) => b.id === blueprint)
    if (!picked)
      return (
        <div className="-mx-3 h-full overflow-y-auto px-3">
          <BlueprintIndex
            title="Catalog"
            intro="Everything the hub keeps, by blueprint."
            all={list}
            counts={counts}
            hidden={hidden}
            starred={pinnedOf(pins ?? [], list, 'blueprint')}
            to={(id) => ({ page: 'inventory', blueprint: id })}
            actions={
              <Link to={{ page: 'favorites' }} className="flex w-fit items-center gap-1.5 btn btn-ghost">
                <Star aria-hidden className="size-3.5" /> Your favorites
              </Link>
            }
          />
        </div>
      )
    return (
      <div {...spot('catalog.grid')} className="h-full min-h-0 pt-2">
        <Grid key={picked.id} bp={picked} />
      </div>
    )
  }
  // On a desk the kinds are in the rail beside every page, so the grid has the width.
  return <div {...spot('catalog.grid')} className="h-full py-3">{current ? <Grid key={current.id} bp={current} /> : <Empty>No blueprints yet. Build one on the Model page.</Empty>}</div>
}

/** The data grid for one blueprint, edited in place: a click on a value changes it. The catalog page and the model page both show it. */
/** `embedded` is a grid inside something that names the blueprint already, such as a drawer: it leaves out its own heading. */
export function Grid({ bp, embedded = false }: { bp: Blueprint; embedded?: boolean }) {
  const blueprintName = useBlueprintName()
  const bpName = blueprintName(bp)
  const allBlueprints = useBlueprints().data?.blueprints ?? []
  const canEdit = useCanEdit(bp.id)
  // Rows are ticked to change many at once, or to run an action on many: whoever may do either ticks.
  const batchActions = useBatchActions(bp.id)
  const ticks = canEdit || batchActions.length > 0
  const canArrange = useCan('views.arrange')
  const canAuthor = useCan('model.edit')
  const narrow = useNarrow()
  const [more, setMore] = useState(false)
  const [search, setSearch] = useVisit(`grid.${bp.id}.search`, '')
  // On a phone the search is a magnifier in the top bar, and stays open while it holds words.
  const [seeking, setSeeking] = useState(false)
  const seek = narrow && !embedded && (seeking || search !== '')
  const grid = useGrid(bp.id)
  const standard = useGridStandard()
  const save = useSaveGrid(bp.id)
  const layout: GridLayout = grid.data ?? { columns: [] }
  // The shared filter the grid opens with. A condition on a field or a relation that is gone is left out.
  const defaults = useMemo(() => (grid.data?.filter ?? []).filter((c) => c.field.startsWith('$') || c.field in bp.fields || (clauseRelation(c) ?? '') in bp.relations), [grid.data, bp])
  // What this person made of the filter: theirs until the page loads again, and null while they follow the shared one.
  const [own, setClauses] = useVisit<Clause[] | null>(`grid.${bp.id}.filter`, null)
  const clauses = own ?? defaults
  const changed = own !== null && JSON.stringify(own) !== JSON.stringify(defaults)
  const [state, setState] = useVisit<'active,missing' | 'active' | 'missing' | 'deleted'>(`grid.${bp.id}.state`, 'active,missing')
  const [hidden, setHidden] = useVisit(`grid.${bp.id}.hidden`, false)
  // The status levels this person shows, all of them when none is picked. Theirs until the page loads again, like the filter.
  const [picked, setLevels] = useVisit<StatusLevel[]>(`grid.${bp.id}.levels`, [])
  // Zen mode shows no health: no status column, no status picker, and no pick of one left over.
  const zen = useZen()
  const levels = zen ? NO_LEVELS : picked
  // The shared order the grid opens with, by title when there is none or its field is gone; and, like the filter, what this person sorts is theirs until the page loads again.
  const sortDefault = useMemo(() => {
    const by = grid.data?.sort?.replace(/^-/, '')
    return by && (by === 'title' || by.startsWith('$') || by in bp.fields) ? grid.data!.sort! : 'title'
  }, [grid.data, bp])
  const [ownSort, setSort] = useVisit<string | null>(`grid.${bp.id}.sort`, null)
  const sort = ownSort ?? sortDefault
  const [groupBy, setGroupBy] = useVisit(`grid.${bp.id}.group`, '')
  const typeOf = useMemo(() => typesIn(bp, (id) => allBlueprints.find((b) => b.id === id)), [bp, allBlueprints])
  // Everything the grid is narrowed by but the conditions on one field, or on none.
  const narrowedBut = (field: string | null): FilterDsl[] => [...clauses.filter((c) => c.field && c.field !== field).map((c) => clauseFilter(c, typeOf)), ...(search.trim() ? [{ search: search.trim() }] : [])]
  const unpicked = useMemo(() => narrowedBut(null), [clauses, search, typeOf]) // eslint-disable-line react-hooks/exhaustive-deps
  const byLevel = (parts: FilterDsl[]) => joined([...parts, ...(levels.length ? [{ field: '$status', op: 'in' as const, value: levels }] : [])])
  const filter = useMemo(() => byLevel(unpicked), [unpicked, levels]) // eslint-disable-line react-hooks/exhaustive-deps
  // A cell shows three of what points at a row and counts the rest, so only three are asked for.
  const question = (f: FilterDsl | null) => {
    // The rows come first; how they share out each column is asked beside them and fills in.
    const q = new URLSearchParams({ state, sort, incoming: '3', layers: 'true', distribution: 'later' })
    if (hidden) q.set('hidden', 'true')
    if (groupBy) q.set('group', groupBy)
    if (f) q.set('filter', JSON.stringify(f))
    return q
  }
  const params = question(filter)
  // The picker counts each level without its own pick, so a level left out keeps its number: the same question with no status picked, which the grid most often asked a moment before.
  const unpickedParams = question(joined(unpicked))
  // The rows wait for the shared filter, so the grid never shows what the filter leaves out.
  // The rows the grid draws, as positions among all that matched; the blocks they sit in, and the one after, are read.
  const [range, setRange] = useState<[number, number]>([0, BLOCK])
  const rows = useRows(bp.id, params, !grid.isPending, range[0], range[1])
  // The columns an edit rule opens to the reader on a row in view, for a reader the grid as a whole is not open to.
  const yours = useMemo(() => openedColumns(rows.loaded), [rows.loaded])
  const everyLevel = useGridShares(bp.id, unpickedParams, 0, !grid.isPending && levels.length > 0)
  // The field a condition is being picked for. Where conditions on it narrow the grid already, its values are counted without them, so every value it may take is there to pick, with its number.
  const [choosing, setChoosing] = useState<string | null>(null)
  const recount = choosing !== null && clauses.some((c) => c.field === choosing)
  const without = useGridShares(bp.id, question(byLevel(recount ? narrowedBut(choosing) : [])), 0, !grid.isPending && recount)
  const levelCounts = Object.fromEntries(((levels.length ? everyLevel.data?.distribution : rows.distribution)?.status?.buckets ?? []).map((b) => [b.value, b.count])) as Partial<Record<StatusLevel, number>>
  // A blueprint whose rows all have no status has nothing to pick between.
  const showLevels = !zen && (levels.length > 0 || Object.entries(levelCounts).some(([l, n]) => l !== 'grey' && n > 0))
  const edit = useEditEntity()
  const onEdit: OnEdit = (ref, patch) => edit.mutate({ ref, patch })
  const scorecards = useScorecards()
  const cards = (scorecards.data?.scorecards ?? []).filter((s) => blueprintsOf(s).includes(bp.id))
  // Every action that runs on these rows can be a column of buttons, shown on the rows the reader may run it on.
  const actionList = useActions().data?.actions
  const runsHere = useMemo(() => (actionList ?? []).filter((a) => actionTargets(a).includes(bp.id)), [actionList, bp.id])

  const all = useMemo<Column[]>(
    () => [
      ...META.slice(0, 2).map((m) => ({ ...m, width: m.id === 'status' ? 36 : 240 })),
      ...Object.entries(bp.fields).map(([id, f]) => ({ id: `f:${id}`, title: f.title ?? id, kind: 'field' as const, width: f.type === 'markdown' || f.type === 'object' ? 240 : f.type === 'url' ? 200 : 150, def: f })),
      ...Object.entries(bp.relations).map(([id, r]) => ({ id: `r:${id}`, title: r.title ?? id, kind: 'relation' as const, width: 180, target: r.target })),
      // Everything that points here is a column too, named by the relation's inverse title, and by the blueprint too where several share it.
      ...((pointing) => {
        const shared = new Set([...Map.groupBy(pointing, (p) => p.title.toLowerCase())].filter(([, list]) => list.length > 1).map(([title]) => title))
        return pointing.map((p) => ({ id: p.id, title: shared.has(p.title.toLowerCase()) ? `${p.title} · ${p.of}` : p.title, kind: 'incoming' as const, width: 180 }))
      })(
        allBlueprints.flatMap((other) =>
          Object.entries(other.relations)
            .filter(([, r]) => r.target === bp.id)
            .map(([name, r]) => ({ id: `i:${other.id}.${name}`, title: r.inverseTitle ?? `${blueprintName(other)} (${name})`, of: blueprintName(other) })),
        ),
      ),
      ...cards.flatMap((s) => [
        { id: `s:${s.id}`, title: s.title, kind: 'scorecard' as const, width: 130 },
        ...(partFor(s, bp.id)?.levels ?? []).flatMap((l) => l.rules.map((r) => ({ id: `u:${s.id}.${r.id}`, title: r.title, kind: 'rule' as const, width: 150 }))),
      ]),
      ...runsHere.map((a) => ({ id: `a:${a.id}`, title: a.title, kind: 'action' as const, width: 150, action: a })),
      ...META.slice(2).map((m) => ({ ...m, width: m.id === 'key' ? 220 : 130 })),
    ],
    [bp, cards, allBlueprints, runsHere],
  )
  const byId = useMemo(() => new Map(all.map((c) => [c.id, c])), [all])
  // What the column standard needs to know of each column: its id, and whether a pivot made it or it pivots.
  const facts = useMemo((): ColumnFacts[] => all.map((c) => ({ id: c.id, pivot: !!c.def?.pivot, pivoted: !!c.def?.pivoted })), [all])
  // What a person changed by hand on top of the estate's column standard. A layout saved before the standard is read as every column placed by hand where it was.
  const hand = useMemo((): LayoutColumn[] => (layout.arranged === 'standard' ? layout.columns : fromLegacy(layout.columns)), [layout])
  // Every column in the order the grid draws it, the hidden ones in their place: the standard's order, with a person's moves, hides, and widths on top.
  const order = useMemo(() => (standard.data ? arrange(standard.data, facts, hand) : []), [standard.data, facts, hand])
  const columns = useMemo(
    () =>
      order.flatMap((l): Column[] => {
        const c = byId.get(l.id)
        return c && !l.hidden && !(zen && c.id === 'status') ? [{ ...c, width: l.width ?? c.width }] : []
      }),
    [byId, order, zen],
  )
  const hiddenIds = new Set(order.filter((l) => l.hidden).map((l) => l.id))
  const persist = (next: GridLayoutPatch) => canArrange && save.mutate(next)
  // A grid keeps only what a person changed on top of the standard, so a change to the standard moves every column nobody touched.
  const keep = (columns: LayoutColumn[]) => persist({ columns, arranged: 'standard' })
  const toggle = (id: string) => {
    const column = facts.find((c) => c.id === id)
    if (column && standard.data) keep(showByHand(standard.data, column, hand, !hiddenIds.has(id)))
  }
  const resize = (id: string, width: number) => keep([...hand.filter((l) => l.id !== id), { ...hand.find((l) => l.id === id), id, width: Math.max(40, Math.round(width)) }])
  const unmove = (id: string) => keep(placeByStandard(hand, id))
  const unsize = (id: string) => keep(sizeByStandard(hand, id))
  const reorder = (id: string, to: Drop) => {
    const moving = order.find((l) => l.id === id)
    const rest = order.filter((l) => l.id !== id)
    const at = rest.findIndex((l) => l.id === to.id)
    if (!moving || at < 0) return
    rest.splice(at + (to.side === 'after' ? 1 : 0), 0, moving)
    if (rest.every((l, i) => l.id === order[i]!.id)) return
    // A move is kept as the column now before it, so the columns around it still follow the standard.
    keep(placeByHand(hand, rest.map((l) => l.id), id))
  }
  // The column beside one, either way, and the move that puts it on the far side of it.
  const moves = (id: string) => {
    const at = columns.findIndex((c) => c.id === id)
    const left = columns[at - 1]
    const right = columns[at + 1]
    return { left: left && (() => reorder(id, { id: left.id, side: 'before' })), right: right && (() => reorder(id, { id: right.id, side: 'after' })) }
  }
  const headDrag = useReorder(reorder)
  const pickDrag = useReorder(reorder)

  const [menu, setMenu] = useState<{ col: Column; anchor: HTMLElement } | null>(null)
  const [editingProperty, setEditingProperty] = useState<{ name: string; anchor: HTMLElement } | null>(null)
  const [picker, setPicker] = useState(false)
  const [filtering, setFiltering] = useState(false)
  const [creating, setCreating] = useState(false)
  const [addingProperty, setAddingProperty] = useState(false)
  const [peek, setPeek] = useState<EntityRef | null>(null)
  // A phone shows the rows as cards, or as a table whose titles stay put while its columns scroll sideways. Each person's own, kept only while the page is open.
  const [look, pickLook] = useState<PhoneLook>(looks.get(bp.id) ?? 'cards')
  const setLook = (next: PhoneLook) => (looks.set(bp.id, next), pickLook(next))
  const [sorting, setSorting] = useState(false)
  const total = rows.total
  // How many of the kind there are, whatever the grid shows of them.
  const every = useBlueprints().data?.counts[bp.id] ?? total
  const [tools, setTools] = useState(false)
  const toolsOn = (ownSort !== null ? 1 : 0) + (clauses.length ? 1 : 0) + (groupBy ? 1 : 0) + (state !== 'active,missing' ? 1 : 0)
  const stateWords: Record<string, string> = { 'active,missing': 'active and missing', active: 'active', missing: 'missing', deleted: 'deleted' }
  const shownCount = [`${total.toLocaleString('en-US')}${every > total ? ` of ${every.toLocaleString('en-US')}` : ''} ${total === 1 ? 'thing' : 'things'}${groupBy && rows.groups ? ` in ${rows.groups.length} groups` : ''}`, clauses.length ? `${clauses.length} ${clauses.length === 1 ? 'filter' : 'filters'} on` : '', levels.length ? statusWords(levels) : '', search ? `matching “${search}”` : '', stateWords[state] ?? state].filter(Boolean).join(' · ')
  const dist = rows.distribution
  // What is ticked: rows one by one, or every row the filter matches but the ones unticked after.
  const pick = useSelection(params.toString())
  const { selection } = pick
  const chosenCount = selection.all ? total - selection.except.size : selection.ids.size
  const filterQuery = (): EntityQuery => ({ blueprint: bp.id, ...(filter ? { filter } : {}), states: state.split(',') as EntityState[], ...(hidden ? { hidden: true } : {}) })
  const lead = ticks ? LEAD : 0
  const shown = columns
  // What a phone shows beside the title: the shown columns, in the grid's order.
  const glance = columns.filter((c) => c.id !== 'status' && c.id !== 'title')
  const spreadAt = shown.findIndex((c) => !dist?.[c.id] && (c.width ?? 0) >= 120)
  const [collapsedGroups, setCollapsedGroups] = useVisit<Set<string>>(`grid.${bp.id}.folded`, () => new Set())
  // What the grid draws, top to bottom: each group's heading and, unless it is folded, a place for each of its rows.
  const lines = useMemo(() => layOut(total, groupBy ? rows.groups : null, collapsedGroups), [total, groupBy, rows.groups, collapsedGroups])
  const scroller = useRef<HTMLDivElement>(null)
  const virtual = useVirtualizer({ count: lines.length, getScrollElement: () => scroller.current, estimateSize: () => (!narrow ? ROW_HEIGHT : look === 'cards' ? CARD_HEIGHT : LINE_HEIGHT), overscan: 20, measureElement: (el) => el.getBoundingClientRect().height })
  const drawn = virtual.getVirtualItems()
  // Rows drawn another way are measured again.
  useEffect(() => virtual.measure(), [narrow, look]) // eslint-disable-line react-hooks/exhaustive-deps
  // Ask for the blocks the drawn rows sit in, and the one after, so scrolling on finds rows waiting.
  const firstRow = drawn.map((v) => lines[v.index]).find((l) => l?.kind === 'row')
  const lastRow = [...drawn].reverse().map((v) => lines[v.index]).find((l) => l?.kind === 'row')
  const from = firstRow?.kind === 'row' ? firstRow.at : 0
  const to = lastRow?.kind === 'row' ? lastRow.at + BLOCK : BLOCK
  // A scroll inside the same blocks changes nothing; one into another block asks for it.
  useEffect(() => {
    if (Math.floor(from / BLOCK) !== Math.floor(range[0] / BLOCK) || Math.floor(to / BLOCK) !== Math.floor(range[1] / BLOCK)) setRange([from, to])
  }, [from, to]) // eslint-disable-line react-hooks/exhaustive-deps
  const padTop = drawn[0]?.start ?? 0
  const padBottom = drawn.length ? virtual.getTotalSize() - drawn[drawn.length - 1]!.end : 0
  // The keyboard enters the grid once, at the cell it last stood on, or the first drawn row when that row has scrolled away.
  const [cursor, setCursor] = useState<{ id: string; col: number } | null>(null)
  const drawnIds = drawn.flatMap((v) => {
    const line = lines[v.index]
    const e = line?.kind === 'row' ? rows.at(line.at) : undefined
    return e ? [e.id] : []
  })
  const home = cursor?.id === HEAD || (cursor && drawnIds.includes(cursor.id)) ? cursor.id : drawnIds[0]
  const table = useRef<HTMLTableElement>(null)
  // What sits inside a cell is reached through the cell, so Tab leaves the grid in one step instead of walking every row.
  useLayoutEffect(() => {
    table.current?.querySelectorAll<HTMLElement>(':is(td, th)[data-col] :is(a, button, input, select, textarea)').forEach((el) => (el.tabIndex = -1))
  })
  // A different question starts at the top; a list come back to starts where it was left.
  const asked = useRef(params.toString())
  useEffect(() => {
    if (asked.current === params.toString()) return
    asked.current = params.toString()
    virtual.scrollToIndex(0)
  }, [params.toString()]) // eslint-disable-line react-hooks/exhaustive-deps
  // Where the rows stand is kept on the step, on a desk's grid and a phone's list alike, so Back from a record finds the list where it was left.
  const noteScroll = useScrollBackIn(scroller, `grid.${bp.id}`)
  // What the hub keeps about every entity is asked for with a $, so a field named owner or state stays reachable.
  // They are listed in the order of the grid's columns, so a field is found where the grid shows it.
  const place = new Map(order.map((l, i) => [l.id, i]))
  const fieldOptions = [...META.filter((m) => m.id !== 'status').map((m) => ({ id: `$${m.id}`, title: m.title, column: m.id, type: META_TYPES[m.id] ?? 'string' })), ...Object.entries(bp.fields).map(([id, f]) => ({ id, title: f.title ?? id, column: `f:${id}`, type: f.type, def: f }))].sort((a, b) => (place.get(a.column) ?? 0) - (place.get(b.column) ?? 0))
  // A relation filters like a field, named as its column is: the condition picks one of the targets the rows hold.
  const filterOptions: (ConditionField & { column: string })[] = [...fieldOptions, ...Object.entries(bp.relations).map(([id, r]) => {
    const reaches = reachOf(bp, `r:${id}`, allBlueprints, blueprintName)
    return { id: `r:${id}`, title: r.title ?? id, column: `r:${id}`, ...(reaches ? { reaches } : {}) }
  })].sort((a, b) => (place.get(a.column) ?? 0) - (place.get(b.column) ?? 0))
  // How every matching row shares out a field's values: counted without the conditions on that field while one is picked for it.
  const sharesFor = (field: string) => (field === choosing && recount ? without.data?.distribution : dist)
  const defOf = (field: string) => (field === '$state' ? STATE_DEF : field.startsWith('$') || field.startsWith('r:') ? undefined : bp.fields[field])
  // Whether a condition on a field picks its value from a list: a relation, what the hub counts of every entity, and a field of a few kinds of value.
  const picksFrom = (field: string) => field.startsWith('r:') || field === '$state' || field === '$owner' || isSpread(bp.fields[field])
  // The values a condition picks from: every value the matching rows hold, most common first and counted, then any other an enum or a boolean may take.
  const choicesFor = (field: string): Choice[] | null => {
    if (!picksFrom(field)) return null
    const def = defOf(field)
    const out = new Map<string, Choice>()
    for (const b of sharesFor(field)?.[columnOf(field)]?.buckets ?? []) if (b.value !== null) out.set(b.value, { value: b.value, label: b.label, count: b.count, color: valueColor(def, b.value) })
    const may = field === '$state' ? [...ENTITY_STATES] : def?.type === 'enum' ? (def.values ?? []) : def?.type === 'boolean' ? ['true', 'false'] : []
    for (const v of may) if (!out.has(v)) out.set(v, { value: v, label: def?.type === 'boolean' ? (v === 'true' ? 'yes' : 'no') : v, color: valueColor(def, v) })
    return [...out.values()]
  }
  // A relation's target is kept by its id; it reads as its title, from the counts or from a row on screen that points at it.
  const labelOf = (c: Clause): string => {
    const relation = clauseRelation(c)
    if (relation === null) return c.value
    const counted = dist?.[c.field]?.buckets.find((b) => b.value === c.value)?.label
    return counted ?? rows.loaded.flatMap((e) => e.relations[relation] ?? []).find((t) => entityId(t) === c.value)?.title ?? c.value
  }
  // A share of a column picked from the bar under it: its rows kept, or with a key held, left out. The filter bar opens to show what it did.
  const pickShare = (col: Column, value: string | null, not: boolean) => {
    const clause = shareClause(col.id, col.id === 'state' ? 'enum' : col.def?.type, value, not)
    if (!clause) return
    setClauses(withShare(clauses, clause))
    setFiltering(true)
  }

  // What keeps the filter: back to the one everyone starts with, or made it.
  const keeping = (
    <>
      {clauses.length > 1 && <Button onClick={() => setClauses([])}>Clear</Button>}
      {changed && defaults.length > 0 && <Button onClick={() => setClauses(null)}>Back to the default</Button>}
      {changed && canArrange && <Button onClick={() => save.mutate({ filter: clauses.filter((c) => c.field) }, { onSuccess: () => setClauses(null) })}>{clauses.some((c) => c.field) ? 'Make this the default for everyone' : 'Remove the default for everyone'}</Button>}
      {defaults.length > 0 && <span className="text-[12px] text-ink-500">{changed ? 'Yours until the page loads again.' : 'Everyone starts with this filter.'}</span>}
      {!clauses.length && !narrow && <span className="text-[12px] text-ink-500">Or click a share in the spread of values at the bottom. Ctrl-click leaves it out.</span>}
    </>
  )
  // The filter's conditions, as chips: a bar above the grid on a desk, a sheet on a phone.
  const filterBody = <Conditions clauses={clauses} onChange={setClauses} fields={filterOptions} ops={(field) => opsFor(defOf(field)?.type ?? filterOptions.find((f) => f.id === field)?.type, field.startsWith('r:'), picksFrom(field))} choices={choicesFor} labelOf={labelOf} onEditing={setChoosing} stacked={narrow}>{keeping}</Conditions>
  const pickerBody = (
    <>
      {order.flatMap((l) => byId.get(l.id) ?? []).map((c) => {
        // A phone has no drag: a shown column moves by its arrows there.
        const step = narrow && canArrange && !hiddenIds.has(c.id) ? moves(c.id) : null
        return (
          <div key={c.id} className="flex items-center">
            <label
              {...(canArrange && !narrow ? pickDrag.item(c.id) : {})}
              title={canArrange && !narrow ? 'Drag to move this column' : undefined}
              className={`flex min-w-0 flex-1 items-center gap-1.5 rounded-sm px-1.5 text-[13px] text-ink-300 ${narrow ? 'py-2.5' : 'py-1'} ${canArrange && !narrow ? 'cursor-grab hover:bg-ink-800' : ''} ${pickDrag.dragging === c.id ? 'opacity-40' : ''} ${pickDrag.mark(c.id)}`}
            >
              {canArrange && !narrow && <GripVertical className="size-3 text-ink-500" />}
              <input type="checkbox" disabled={!canArrange} checked={!hiddenIds.has(c.id)} onChange={() => toggle(c.id)} /> <span className="truncate">{c.title || 'Status'}</span>
            </label>
            {step && (
              <>
                <button type="button" className="grid size-10 place-items-center text-ink-400 disabled:opacity-30" disabled={!step.left} aria-label={`Move ${c.title || 'Status'} up`} onClick={() => step.left?.()}>
                  <ArrowUp className="size-4" />
                </button>
                <button type="button" className="grid size-10 place-items-center text-ink-400 disabled:opacity-30" disabled={!step.right} aria-label={`Move ${c.title || 'Status'} down`} onClick={() => step.right?.()}>
                  <ArrowDown className="size-4" />
                </button>
              </>
            )}
          </div>
        )
      })}
      {!canArrange && <span className="text-[12px] text-ink-500">The column layout is shared. Changing it needs the "views.arrange" permission.</span>}
    </>
  )

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 pt-2 md:gap-3 md:pt-0">
      {!embedded && narrow ? (
        // On a phone the heading and its buttons sit in the top bar, and the description opens under it from a tap on the title.
        <>
          <PhoneBar>
            {seek ? (
              <>
                <h1 className="sr-only">{bpName}</h1>
                <div className="relative min-w-0 flex-1">
                  <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-500" aria-hidden />
                  <input type="search" autoFocus enterKeyHint="search" className={`${input} w-full py-1 pl-9`} aria-label={`Search ${bpName}`} placeholder={`Search ${total} ${total === 1 ? 'entity' : 'entities'}`} value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), setSearch(''), setSeeking(false))} />
                </div>
                <button type="button" className="shrink-0 px-1.5 py-2 text-sm font-medium text-orbit" onClick={() => (setSearch(''), setSeeking(false))}>
                  Cancel
                </button>
              </>
            ) : (
              <>
                <Link to={{ page: 'inventory', blueprint: null }} className="grid size-9 shrink-0 place-items-center rounded-full text-ink-300" title="Every blueprint">
                  <EveryBlueprint className="size-5" aria-hidden />
                  <span className="sr-only">Every blueprint</span>
                </Link>
                <BlueprintIcon bp={bp} className="size-4.5 shrink-0 text-ink-300" />
                <h1 className="min-w-0 flex-1 truncate text-[17px] font-semibold tracking-tight">
                  {bp.description ? (
                    <button type="button" aria-expanded={more} className="max-w-full truncate text-left" onClick={() => setMore(!more)}>
                      {bpName}
                    </button>
                  ) : (
                    bpName
                  )}
                </h1>
                <PinStar pin={{ kind: 'blueprint', id: bp.id }} name={bpName} className="size-9 rounded-full" />
                <button type="button" onClick={() => setSeeking(true)} className="grid size-9 shrink-0 place-items-center rounded-full text-ink-300" title={`Search ${bpName}`}>
                  <Search className="size-5" aria-hidden />
                  <span className="sr-only">Search {bpName}</span>
                </button>
                {canEdit && (
                  <button type="button" onClick={() => setCreating(true)} className="btn btn-solid size-8 shrink-0 rounded-full p-0" title={`New ${bpName}`}>
                    <Plus className="size-4" aria-hidden />
                    <span className="sr-only">New {bpName}</span>
                  </button>
                )}
              </>
            )}
          </PhoneBar>
          {more && bp.description && <p className="shrink-0 text-sm text-ink-400">{bp.description}</p>}
        </>
      ) : (
        <div className="flex flex-wrap items-start gap-3">
          {!embedded && <BlueprintIcon bp={bp} className="mt-1.5 size-5 text-ink-300" />}
          <div className="min-w-0 flex-1">
            {!embedded && (
              <div className="flex items-center gap-1">
                <h1 className="page-title">{bpName}</h1>
                <PinStar pin={{ kind: 'blueprint', id: bp.id }} name={bpName} />
              </div>
            )}
            {bp.description && !embedded && <p className="mt-1 max-w-3xl text-sm text-ink-300">{bp.description}</p>}
            {!embedded && <p className="mt-1 text-[13px] text-ink-400">{shownCount}</p>}
            {!embedded && bp.onlyYours && <p className="mt-1 text-[13px] text-ink-400">Only yours: you see the ones you own, and only some of what is kept about them.</p>}
            {!embedded && bp.onlyAbout && !bp.onlyYours && <p className="mt-1 text-[13px] text-ink-400">Only the ones about what you can see.</p>}
          </div>
          <div className="flex items-center gap-2">
            {!embedded && (
              <Link to={{ page: 'model', id: null, focus: bp.id }} title="Show this blueprint on the model" className="hidden btn btn-ghost md:block">
                Model
              </Link>
            )}
            {canEdit && (
              <button onClick={() => setCreating(true)} className="flex items-center gap-1.5 btn btn-solid">
                <Plus className="size-3.5" /> {narrow ? 'New' : bpName}
              </button>
            )}
          </div>
        </div>
      )}

      {narrow ? (
        // On a phone the tools wrap onto as many short rows as they need, all in reach. The search is in the top bar, unless this grid sits inside another page.
        <div className="shrink-0 space-y-1.5">
          {embedded && (
            <div className="relative">
              <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-500" aria-hidden />
              <input type="search" className={`${input} w-full py-1 pl-9`} aria-label={`Search ${bpName}`} placeholder={`Search ${total} ${total === 1 ? 'entity' : 'entities'}`} value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
          )}
          <div className="flex flex-wrap items-center gap-1.5">
            <div role="group" aria-label="Show the rows as" className="flex rounded-md border border-ink-600 p-0.5">
              {(['cards', 'table'] as const).map((l) => (
                <button key={l} type="button" aria-pressed={look === l} onClick={() => setLook(l)} className={`rounded-md px-3 py-1.5 text-[13px] font-medium ${look === l ? 'bg-ink-700 text-ink-100' : 'text-ink-400'}`}>
                  {l === 'cards' ? 'Cards' : 'Table'}
                </button>
              ))}
            </div>
            <span className="order-last basis-full text-[12px] text-ink-400">{shownCount}</span>
            {/* The tools that change what the rows show wait in one sheet, so the rows keep the screen. */}
            {showLevels && <StatusPicker picked={levels} counts={levelCounts} onChange={setLevels} compact />}
            <Tool icon={<SlidersHorizontal className="size-3.5" />} label={toolsOn ? `Tools · ${toolsOn}` : 'Tools'} active={toolsOn > 0} onClick={() => setTools(true)} />
            {tools && (
              <Drawer title="Tools" subtitle={bpName} onClose={() => setTools(false)}>
                <div className="flex flex-col items-stretch gap-2 p-4 *:justify-start">
            <Tool icon={<ArrowUpDown className="size-3.5" />} label="Sort" active={ownSort !== null} onClick={() => (setTools(false), setSorting(true))} />
            <Tool icon={<Filter className="size-3.5" />} label={clauses.length ? `Filter · ${clauses.length}` : 'Filter'} active={filtering || clauses.length > 0} onClick={() => (setTools(false), setFiltering(!filtering))} />
            <Tool icon={<Group className="size-3.5" />} label={groupBy ? `Group · ${fieldOptions.find((f) => f.id === groupBy)?.title ?? groupBy}` : 'Group'} active={!!groupBy} onClick={() => setGroupBy(groupBy ? '' : '$owner')} />
            {groupBy && (
              <select className={`${input} py-1 text-[13px]`} aria-label="Group by" value={groupBy} onChange={(e) => setGroupBy(e.target.value)}>
                {fieldOptions.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.title}
                  </option>
                ))}
                {Object.keys(bp.relations).map((r) => (
                  <option key={r} value={`r:${r}`}>
                    {r}
                  </option>
                ))}
              </select>
            )}
            <Tool icon={<Columns3 className="size-3.5" />} label="Columns" active={picker} onClick={() => (setTools(false), setPicker(!picker))} />
            <select className={`${input} py-1 text-[13px]`} aria-label="Which entities" value={state} onChange={(e) => setState(e.target.value as typeof state)}>
              <option value="active,missing">Active and missing</option>
              <option value="active">Active</option>
              <option value="missing">Missing</option>
              <option value="deleted">Deleted</option>
            </select>
                </div>
              </Drawer>
            )}
          </div>
        </div>
      ) : (
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-ink-500" />
            <input className={`${input} w-72 pl-7`} aria-label={`Search ${bpName}`} placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          {showLevels && <StatusPicker picked={levels} counts={levelCounts} onChange={setLevels} compact={embedded} />}
          {/* The filter bar stays folded until it is asked for, so the shared filter curates the rows out of the way and the grid keeps the room. */}
          <Tool icon={<Filter className="size-3.5" />} label={clauses.length ? `Filter · ${clauses.length}` : 'Filter'} active={filtering || clauses.length > 0} onClick={() => setFiltering(!filtering)} />
          <Tool icon={<Group className="size-3.5" />} label={groupBy ? `Group · ${fieldOptions.find((f) => f.id === groupBy)?.title ?? groupBy}` : 'Group'} active={!!groupBy} onClick={() => setGroupBy(groupBy ? '' : '$owner')} />
          {groupBy && (
            <select className={`${input} text-[13px]`} aria-label="Group by" value={groupBy} onChange={(e) => setGroupBy(e.target.value)}>
              {fieldOptions.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.title}
                </option>
              ))}
              {Object.keys(bp.relations).map((r) => (
                <option key={r} value={`r:${r}`}>
                  {r}
                </option>
              ))}
            </select>
          )}
          <Tool icon={<Columns3 className="size-3.5" />} label="Columns" active={picker} onClick={() => setPicker(!picker)} />
          <select className={`${input} text-[13px]`} aria-label="Which entities" value={state} onChange={(e) => setState(e.target.value as typeof state)}>
            <option value="active,missing">Active and missing</option>
            <option value="active">Active</option>
            <option value="missing">Missing</option>
            <option value="deleted">Deleted</option>
          </select>
          <label className="flex items-center gap-1.5 text-[13px] whitespace-nowrap text-ink-400">
            <input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} /> Hidden
          </label>
          <a className="btn btn-ghost ml-auto" href={asViewed(`/v1/export?blueprint=${encodeURIComponent(bp.id)}&scope=all`)} title="Export as catalog YAML">
            <Download className="size-3.5" /> YAML
          </a>
        </div>
      )}
      {narrow ? (
        filtering && (
          <Drawer title="Filter" onClose={() => setFiltering(false)}>
            <div className="p-4">{filterBody}</div>
          </Drawer>
        )
      ) : (
        filtering && <div className="shrink-0">{filterBody}</div>
      )}
      {picker && (narrow ? (
        <Drawer title="Columns" subtitle="What a card shows first, and the columns a swipe steps through" onClose={() => setPicker(false)}>
          <div className="flex flex-col p-2">{pickerBody}</div>
        </Drawer>
      ) : (
        <Panel className="flex shrink-0 flex-wrap gap-x-1 gap-y-1 px-3 py-2">{pickerBody}</Panel>
      ))}
      {sorting && (
        <Drawer title="Sort" onClose={() => setSorting(false)}>
          <div role="radiogroup" aria-label="Sort by" className="divide-y divide-ink-800">
            {fieldOptions.map((f) => {
              const key = f.id === '$title' ? 'title' : f.id
              const on = sort.replace(/^-/, '') === key
              const down = on && sort.startsWith('-')
              return (
                <button key={f.id} type="button" role="radio" aria-checked={on} className={`flex w-full items-center gap-3 px-4 py-3 text-left text-[15px] ${on ? 'font-medium text-ink-100' : 'text-ink-300'}`} onClick={() => (setSort(on ? (down ? key : `-${key}`) : key), setSorting(false))}>
                  <span className="min-w-0 flex-1 truncate">{f.title}</span>
                  {on && (
                    <span className="flex items-center gap-1 text-[13px] text-ink-400">
                      {down ? <ArrowDown className="size-4" /> : <ArrowUp className="size-4" />}
                      {down ? 'Descending' : 'Ascending'}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
          {(ownSort !== null || canArrange) && (
            <div className="flex flex-wrap gap-2 border-t border-ink-700 p-4">
              {ownSort !== null && <Button onClick={() => (setSort(null), setSorting(false))}>Back to the default</Button>}
              {ownSort !== null && ownSort !== sortDefault && canArrange && <Button onClick={() => save.mutate({ sort }, { onSuccess: () => (setSort(null), setSorting(false)) })}>Make this the default for everyone</Button>}
            </div>
          )}
        </Drawer>
      )}
      {creating && <Create bp={bp} onDone={() => setCreating(false)} />}
      {addingProperty && <AddProperty bp={bp} onDone={() => setAddingProperty(false)} />}
      {chosenCount > 0 && <PickAll picked={chosenCount} all={selection.all} loaded={rows.loaded.length} total={total} every={every} onAll={pick.all} />}
      {chosenCount > 0 && <BulkBar bp={bp} count={chosenCount} target={selection.all ? { query: { ...filterQuery(), except: [...selection.except.values()] } } : { entities: [...selection.ids.values()] }} loaded={rows.loaded.filter((e) => pick.has(e))} onClear={pick.clear} edits={canEdit} actions={batchActions} />}
      <ErrorNote error={rows.error ?? save.error ?? edit.error} />

      {narrow ? (
        <PhoneList
          bp={bp}
          scroller={scroller}
          virtual={virtual}
          lines={lines}
          rows={rows}
          look={look}
          glance={glance}
          canEdit={canEdit}
          onEdit={onEdit}
          onScrolled={noteScroll}
          onOpen={(e, at) => {
            browseFrom({ blueprint: bp.id, params: params.toString(), total, at, key: e.key })
          }}
          collapsed={collapsedGroups}
          onToggleGroup={(key) => setCollapsedGroups((cur) => {
            const next = new Set(cur)
            if (next.has(key)) next.delete(key)
            else next.add(key)
            return next
          })}
        />
      ) : (
        <>
          {/* The grid scrolls inside the page: its header, its distributions, and its row actions stay in view. Header and footer stick a pixel past the edge, so a row never shows through a half-pixel gap. */}
          {/* A cell the keyboard moves to scrolls clear of the header, the footer, and the pinned columns. */}
          <div ref={scroller} onScroll={noteScroll} className="min-h-0 flex-1 overflow-auto rounded-md border border-ink-700 bg-ink-900/70" style={{ scrollPadding: `40px ${ACTIONS + (canAuthor ? 120 : 0)}px 48px ${pinnedEnd(shown, lead)}px` }}>
            <table ref={table} onKeyDown={moveInGrid} role="grid" aria-label={bpName} aria-rowcount={lines.length + 1} className="w-max min-w-full border-separate border-spacing-0 text-sm">
              <thead>
                <tr aria-rowindex={1}>
                  {ticks && (
                    <th data-col={-1} tabIndex={cursor?.id === HEAD && cursor.col === -1 ? 0 : -1} onFocus={() => setCursor({ id: HEAD, col: -1 })} className={`sticky -top-px z-30 bg-ink-900 px-2 focus-visible:-outline-offset-2 left-0 ${EDGE.below}`} style={{ width: LEAD, minWidth: LEAD }}>
                      <input type="checkbox" title={`Select all ${total} rows that match`} aria-label={`Select all ${total} rows that match`} checked={total > 0 && chosenCount === total} ref={(el) => {
                          if (el) el.indeterminate = chosenCount > 0 && chosenCount < total
                        }} onChange={(ev) => (ev.target.checked ? pick.all() : pick.clear())} />
                    </th>
                  )}
                  {shown.map((c, i) => (
                    <Header key={c.id} col={c} index={i} cursor={cursor?.id === HEAD && cursor.col === i} onCursor={() => setCursor({ id: HEAD, col: i })} pinned={pinnedClass(shown, i, 'head')} left={stickyLeft(shown, i, lead)} sort={sort} onOpen={(anchor) => setMenu({ col: c, anchor })} onResize={canArrange ? (w) => resize(c.id, w) : undefined} drag={canArrange ? headDrag.item(c.id) : undefined} dragging={headDrag.dragging === c.id} mark={headDrag.mark(c.id)} yours={!canEdit && yours.has(c.id)} />
                  ))}
                  {canAuthor && (
                    <th data-col={shown.length} tabIndex={cursor?.id === HEAD && cursor.col === shown.length ? 0 : -1} onFocus={() => setCursor({ id: HEAD, col: shown.length })} className={`sticky -top-px z-30 bg-ink-900 px-2 py-2 text-left focus-visible:-outline-offset-2 ${EDGE.below} ${EDGE.left} ${PINNED_RIGHT}`} style={{ right: ACTIONS }}>
                      {/* A column of its own only as wide as its button: a plus that adds a property. */}
                      <button onClick={() => setAddingProperty(true)} className="grid size-6 place-items-center rounded-md text-ink-400 hover:bg-ink-800 hover:text-ink-100" title="Add a property to this kind">
                        <Plus className="size-4" aria-hidden />
                        <span className="sr-only">Add a property</span>
                      </button>
                    </th>
                  )}
                  <th className={`sticky -top-px right-0 z-30 bg-ink-900 ${EDGE.below} ${canAuthor ? '' : EDGE.left}`} style={{ width: ACTIONS, minWidth: ACTIONS }}>
                    <span className="sr-only">Row actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {padTop > 0 && <tr style={{ height: padTop }} aria-hidden />}
                {drawn.map((v) => {
                  const line = lines[v.index]!
                  if (line.kind === 'group') {
                    const g = line.group
                    return (
                      <GroupHeadingRow key={`g:${g.key}`} measure={virtual.measureElement} index={v.index} group={g} columns={shown.length} extra={canAuthor ? 1 : 0} ticks={ticks} collapsed={collapsedGroups.has(g.key)} onToggle={() => setCollapsedGroups((cur) => {
                        const next = new Set(cur)
                        if (next.has(g.key)) next.delete(g.key)
                        else next.add(g.key)
                        return next
                      })} />
                    )
                  }
                  const e = rows.at(line.at)
                  if (!e) return <PendingRow key={`p:${line.at}`} measure={virtual.measureElement} index={v.index} columns={shown} ticks={ticks} extra={canAuthor ? 1 : 0} />
                  return <Row key={e.id} measure={virtual.measureElement} index={v.index} e={e} columns={shown} bp={bp} canEdit={canEdit} ticks={ticks} extra={canAuthor ? 1 : 0} selected={pick.has(e)} onSelect={(on) => pick.set(e, on)} onEdit={onEdit} onPeek={setPeek} cursor={e.id === home ? (cursor?.id === e.id ? cursor.col : 0) : null} onCursor={(col) => setCursor({ id: e.id, col })} />
                })}
                {padBottom > 0 && <tr style={{ height: padBottom }} aria-hidden />}
              </tbody>
              {dist && total > 0 && (
                <tfoot>
                  {/* The row of bars is named in the first cell wide enough that holds no bar. */}
                  <tr>
                    {ticks && <td className={`sticky -bottom-px z-30 bg-ink-900 left-0 ${EDGE.above}`} />}
                    {shown.map((c, i) => {
                      // The status column is too narrow for a bar; its spread is the status picker's counts.
                      const d: ColumnDistribution | undefined = c.id === 'status' ? undefined : dist[c.id]
                      return (
                        <td key={c.id} className={`sticky -bottom-px bg-ink-900 px-2 py-2.5 ${EDGE.above} ${pinnedClass(shown, i, 'head') || 'z-20'}`} style={{ width: c.width, maxWidth: c.width, left: stickyLeft(shown, i, lead) }}>
                          {d ? <DistributionBar dist={d} total={total} colorOf={(value) => valueColor(c.id === 'state' ? STATE_DEF : c.def, value)} onPick={(value, not) => pickShare(c, value, not)} /> : i === spreadAt && <span className="text-[12px] whitespace-nowrap text-ink-400">Spread of values</span>}
                        </td>
                      )
                    })}
                    {canAuthor && <td className={`sticky -bottom-px z-30 bg-ink-900 ${EDGE.above} ${EDGE.left} ${PINNED_RIGHT}`} style={{ right: ACTIONS }} />}
                    <td className={`sticky right-0 -bottom-px z-30 bg-ink-900 ${EDGE.above} ${canAuthor ? '' : EDGE.left}`} />
                  </tr>
                </tfoot>
              )}
            </table>
            {rows.ready && total === 0 && <div className="px-4 py-10 text-center text-sm text-ink-400">Nothing matches.</div>}
          </div>
          <div className="flex flex-wrap items-center gap-3 text-[12px] text-ink-400">
            {embedded && <span>{shownCount}</span>}
            {canEdit ? <span className="ml-auto">Click a value to change it. Tick rows to change many at once.</span> : <span className="ml-auto">{yours.size > 0 ? 'A pencil marks a column you can change on the rows that are yours. ' : ''}Click a value to read all of it.{ticks && ' Tick rows, or tick the box at the top for every row that matches, to run an action on all of them.'}</span>}
          </div>
        </>
      )}
      {menu && (
        <ColumnMenu
          bp={bp}
          col={menu.col}
          anchor={menu.anchor}
          sort={sort}
          onSort={(next) => setSort(next)}
          sortDefault={sortDefault}
          onSortDefault={() => setSort(null)}
          onShareSort={canArrange ? () => save.mutate({ sort }, { onSuccess: () => setSort(null) }) : undefined}
          onHide={canArrange ? () => toggle(menu.col.id) : undefined}
          onMove={canArrange ? moves(menu.col.id) : undefined}
          onUnmove={canArrange && order.find((l) => l.id === menu.col.id)?.moved ? () => unmove(menu.col.id) : undefined}
          onUnsize={canArrange && order.find((l) => l.id === menu.col.id)?.sized ? () => unsize(menu.col.id) : undefined}
          onWiden={canArrange ? (by) => resize(menu.col.id, menu.col.width + by) : undefined}
          canAuthor={canAuthor}
          onEdit={(name) => setEditingProperty({ name, anchor: menu.anchor })}
          onClose={() => setMenu(null)}
        />
      )}
      {editingProperty && bp.fields[editingProperty.name] && <FieldPopover key={editingProperty.name} bp={bp} name={editingProperty.name} anchor={editingProperty.anchor} onClose={() => setEditingProperty(null)} />}
      {peek && (
        <Peek key={`${peek.blueprint}:${peek.key}`} entityRef={peek} onClose={() => setPeek(null)} />
      )}
    </div>
  )
}

/** How a phone draws a blueprint's rows. */
type PhoneLook = 'cards' | 'table'

/** How a phone draws each blueprint's list, while the page stays open. */
const looks = new Map<string, PhoneLook>()

/** How tall a card is drawn before it is measured, and a line of the table. */
const CARD_HEIGHT = 76
const LINE_HEIGHT = 52
/** The most values a card shows under its title. */
const CARD_VALUES = 3
/** How wide the table's title column is; it stays put while the rest scroll under it. */
const TITLE_WIDTH = 168

/** How wide a column is on a phone: the grid's width, kept between a thumb's width and half the screen. */
function phoneWidth(col: Column): number {
  return Math.min(200, Math.max(96, col.width ?? 140))
}

/** True when a row holds nothing for a column, so a card skips it. */
function blank(e: Entity, col: Column): boolean {
  const name = col.id.slice(2)
  if (col.kind === 'field') {
    const v = e.fields[name]
    return v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0)
  }
  if (col.kind === 'relation') return !e.relations[name]?.length
  if (col.kind === 'incoming') return !e.incomingRefs?.[name]?.length
  if (col.kind === 'action') return !e.actions?.includes(name)
  return col.id === 'key' && e.key === e.title
}

/**
 * The catalog on a phone: the rows the grid reads, drawn as cards, or as a
 * table whose titles stay put while its columns scroll sideways, so a flick
 * moves through many columns and those beside the one in view stay in sight.
 * A card or a title opens its record, which steps on through the list; in the
 * table a tap on a value changes it. The heading of the group in view stays
 * at the top.
 */
function PhoneList({ bp, scroller, virtual, lines, rows, look, glance, canEdit, onEdit, onOpen, onScrolled, collapsed, onToggleGroup }: { bp: Blueprint; scroller: React.RefObject<HTMLDivElement | null>; onScrolled: (event: React.UIEvent<HTMLDivElement>) => void; virtual: Virtualizer<HTMLDivElement, Element>; lines: Line[]; rows: ReturnType<typeof useRows>; look: PhoneLook; glance: Column[]; canEdit: boolean; onEdit: OnEdit; onOpen: (e: Entity, at: number) => void; collapsed: ReadonlySet<string>; onToggleGroup: (key: string) => void }) {
  const blueprintName = useBlueprintName()
  const table = look === 'table'
  // The column headings sit above the rows' scroll and follow it sideways.
  const headings = useRef<HTMLDivElement>(null)
  const follow = () => {
    if (headings.current && scroller.current) headings.current.scrollLeft = scroller.current.scrollLeft
  }
  useLayoutEffect(follow)
  const width = table ? TITLE_WIDTH + glance.reduce((sum, c) => sum + phoneWidth(c), 0) : undefined
  const drawn = virtual.getVirtualItems()
  // The group the top of the list is in, once its heading has scrolled away.
  const top = drawn.find((v) => v.end > virtual.scrollOffset!)
  let heading: GridGroup | null = null
  if (top) {
    for (let i = top.index; i >= 0; i--) {
      const line = lines[i]
      if (line?.kind === 'group') {
        heading = (virtual.measurementsCache[i]?.start ?? 0) < (virtual.scrollOffset ?? 0) ? line.group : null
        break
      }
    }
  }
  // In the table a group's heading spans the screen, not the columns, and stays put as they scroll.
  const groupLine = (group: GridGroup) => (
    <div className={table ? 'sticky left-0 w-screen' : undefined}>
      <GroupLine group={group} collapsed={collapsed.has(group.key)} onToggle={() => onToggleGroup(group.key)} />
    </div>
  )
  return (
    <div className="-mx-3 flex min-h-0 flex-1 flex-col border-t border-ink-800">
      {table && (
        <div ref={headings} aria-hidden className="shrink-0 overflow-hidden border-b border-ink-800 bg-ink-900">
          <div className="flex text-[12px] font-medium text-ink-400" style={{ width }}>
            <span className="sticky left-0 shrink-0 border-r border-ink-800 bg-ink-900 px-3 py-2" style={{ width: TITLE_WIDTH }}>
              Title
            </span>
            {glance.map((c) => (
              <span key={c.id} className="shrink-0 truncate px-3 py-2" style={{ width: phoneWidth(c) }}>
                {words(c.title) || 'Status'}
              </span>
            ))}
          </div>
        </div>
      )}
      <div ref={scroller} onScroll={(e) => (onScrolled(e), table && follow())} className={`relative min-h-0 flex-1 overscroll-contain ${table ? 'overflow-auto' : 'overflow-y-auto'}`}>
        {heading && <div className={`sticky top-0 z-20 h-0 ${table ? 'left-0 w-screen' : ''}`}>{groupLine(heading)}</div>}
        <ul aria-label={blueprintName(bp)} className="relative min-w-full" style={{ height: virtual.getTotalSize(), width }}>
          {drawn.map((v) => {
            const line = lines[v.index]!
            const e = line.kind === 'row' ? rows.at(line.at) : undefined
            return (
              <li key={line.kind === 'group' ? `g:${line.group.key}` : (e?.id ?? `p:${line.at}`)} ref={virtual.measureElement} data-index={v.index} className="absolute inset-x-0 top-0 border-b border-ink-800" style={{ transform: `translateY(${v.start}px)` }}>
                {line.kind === 'group' ? (
                  groupLine(line.group)
                ) : !e ? (
                  <div className={`flex items-center gap-3 px-3 ${table ? 'sticky left-0 w-screen' : ''}`} style={{ height: table ? LINE_HEIGHT : CARD_HEIGHT }} aria-busy>
                    <span className="h-3 w-1/2 rounded-sm bg-ink-800" />
                  </div>
                ) : table ? (
                  <PhoneRow e={e} bp={bp} glance={glance} canEdit={canEdit} onEdit={onEdit} onOpen={() => onOpen(e, line.at)} />
                ) : (
                  <PhoneCard e={e} bp={bp} glance={glance} onOpen={() => onOpen(e, line.at)} />
                )}
              </li>
            )
          })}
        </ul>
        {rows.ready && rows.total === 0 && <div className="sticky left-0 w-screen px-4 py-10 text-center text-sm text-ink-400">Nothing matches.</div>}
      </div>
    </div>
  )
}

/** A group's heading in the phone's list: its value and how many rows hold it. */
function GroupLine({ group, collapsed, onToggle }: { group: GridGroup; collapsed: boolean; onToggle: () => void }) {
  return (
    <button type="button" onClick={onToggle} aria-expanded={!collapsed} className="flex w-full items-center gap-2 border-b border-ink-800 bg-ink-850 px-3 py-2 text-left text-[13px] font-semibold text-ink-200">
      {collapsed ? <ChevronRight className="size-4" /> : <ChevronDown className="size-4" />}
      <span className="truncate">{group.key}</span>
      <span className="font-normal text-ink-500">· {group.count}</span>
    </button>
  )
}

/** The link to a row's record, over the whole of the card or line it sits in. What it notes first lets the record step through the list. */
function OpenLink({ e, onOpen, className = '' }: { e: Entity; onOpen: () => void; className?: string }) {
  const to = { page: 'entity', blueprint: e.blueprint, key: e.key } as const
  return (
    <a href={href(to)} onClick={(ev) => (onOpen(), onLinkClick(ev))} className={`truncate after:absolute after:inset-0 ${e.state === 'missing' || e.hidden ? 'text-ink-400' : 'text-ink-100'} ${className}`}>
      {e.title}
    </a>
  )
}

const NO_LEVELS: StatusLevel[] = []

/** One row as a card: its status, its picture, its title, and the first few values it holds, named. */
function PhoneCard({ e, bp, glance, onOpen }: { e: Entity; bp: Blueprint; glance: Column[]; onOpen: () => void }) {
  const values = glance.filter((c) => !blank(e, c)).slice(0, CARD_VALUES)
  return (
    <div className="relative flex gap-3 px-3 py-3 active:bg-ink-850">
      <Lamp level={e.status.level} className="mt-1.5" calm />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <Icon name={e.icon ?? bp.icon} className="size-4 shrink-0 text-ink-300" />
          <OpenLink e={e} onOpen={onOpen} className="text-[15px] font-medium" />
          {e.hidden && <span className="shrink-0 text-[12px] text-ink-500">Hidden</span>}
          {/* A phone has nothing to point with: a favorite shows its star, and a thing is starred from its own page. */}
          {e.starred && <EntityStar e={e} className="relative z-10 ml-auto size-7" />}
        </div>
        {values.length > 0 && (
          <dl className="mt-1 flex flex-wrap gap-x-4 text-[13px]">
            {values.map((c) => (
              <div key={c.id} className="flex min-h-6 max-w-full min-w-0 items-center gap-1.5">
                <dt className="shrink-0 text-ink-400">{words(c.title)}</dt>
                <dd className="relative z-10 min-w-0 truncate text-ink-200">
                  <Cell e={e} col={c} />
                </dd>
              </div>
            ))}
          </dl>
        )}
      </div>
      <ChevronRight className="mt-1 size-4 shrink-0 text-ink-500" aria-hidden />
    </div>
  )
}

/** One row of the phone's table: its status and title, which stay put, and a value under each column, changed where it stands with a tap. */
function PhoneRow({ e, bp, glance, canEdit, onEdit, onOpen }: { e: Entity; bp: Blueprint; glance: Column[]; canEdit: boolean; onEdit: OnEdit; onOpen: () => void }) {
  const [editing, setEditing] = useState<{ col: Column; anchor: HTMLElement } | null>(null)
  const [reading, setReading] = useState<{ col: Column; anchor: HTMLElement; lock: string } | null>(null)
  const admin = useIsAdmin()
  const visible = new Set(useBlueprints().data?.blueprints.map((b) => b.id))
  const guard = useAccessGuard(bp)
  return (
    <div className="flex min-h-13 items-stretch">
      <div className="sticky left-0 z-10 flex shrink-0 items-center gap-2 border-r border-ink-800 bg-ink-950 px-3 py-2 active:bg-ink-850" style={{ width: TITLE_WIDTH }}>
        <Lamp level={e.status.level} calm />
        <OpenLink e={e} onOpen={onOpen} className="min-w-0 flex-1 text-[14px] font-medium" />
        {e.starred && <EntityStar e={e} className="size-7" />}
      </div>
      {glance.map((col) => {
        const held = canEdit ? cellLock(e, col, admin, visible, guard) : ''
        const mine = held !== null && cellOpened(e, col)
        const lock = mine ? null : held
        const name = words(col.title) || 'Status'
        const read = lock !== null && readable(e, col)
        const open = (anchor: HTMLElement) => (lock === null ? setEditing({ col, anchor }) : setReading({ col, anchor, lock }))
        return (
          <div
            key={col.id}
            className={`flex shrink-0 items-center truncate px-3 text-[13px] text-ink-200 ${lock === null || read ? 'active:bg-ink-850' : ''}`}
            style={{ width: phoneWidth(col) }}
            role={lock === null || read ? 'button' : undefined}
            tabIndex={lock === null || read ? 0 : undefined}
            aria-label={lock === null ? `Change ${name} of ${e.title}` : read ? `Read ${name} of ${e.title}` : undefined}
            title={lock || undefined}
            onClick={lock === null || read ? (ev) => !(ev.target as HTMLElement).closest('a, button') && open(ev.currentTarget) : undefined}
            onKeyDown={lock === null || read ? (ev) => (ev.key === 'Enter' || ev.key === ' ') && (ev.preventDefault(), open(ev.currentTarget)) : undefined}
          >
            <span className="sr-only">{name}: </span>
            {blank(e, col) ? mine ? <ToFill col={col} /> : <span className="text-ink-500">—</span> : <Cell e={e} col={col} />}
          </div>
        )
      })}
      {editing && <CellEditor e={e} bp={bp} col={editing.col} anchor={editing.anchor} onEdit={(patch) => onEdit(e, patch)} onClose={() => setEditing(null)} />}
      {reading && <CellInspector e={e} col={reading.col} anchor={reading.anchor} lock={reading.lock} onClose={() => setReading(null)} />}
    </div>
  )
}

function Tool({ icon, label, active, onClick }: { icon: React.ReactNode; label: string; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} aria-pressed={active} className={`btn max-md:py-1 ${active ? 'border-ink-300 bg-ink-800 text-ink-100' : 'btn-ghost'}`}>
      {icon} {label}
    </button>
  )
}

function sortKey(c: Column): string {
  if (c.kind === 'field') return c.id.slice(2)
  return c.kind === 'meta' && c.id !== 'title' ? `$${c.id}` : c.id
}

/** The values a field can only take one of, when it has such a list. */
interface RowProps {
  columns: Column[]
  bp: Blueprint
  canEdit: boolean
  extra: number
  onEdit: OnEdit
  onPeek: (ref: EntityRef) => void
}

/** A group's heading in a grouped grid: its value and how many rows hold it, among all that matched. */
function GroupHeadingRow({ measure, index, group, columns, extra, ticks, collapsed, onToggle }: Measured & { group: GridGroup; columns: number; extra: number; ticks: boolean; collapsed: boolean; onToggle: () => void }) {
  return (
    <tr ref={measure} data-index={index} aria-rowindex={index + 2} className={`${ROW} bg-ink-850/60`} style={{ height: ROW_HEIGHT }}>
      {ticks && <td className="z-10 bg-ink-850 px-2 sticky left-0" />}
      <td colSpan={columns + extra + 1} className="px-3 py-1.5">
        <button onClick={onToggle} aria-expanded={!collapsed} className="flex items-center gap-2 font-mono text-[12px] text-ink-200">
          {collapsed ? <ChevronRight className="size-3.5" /> : <ChevronDown className="size-3.5" />}
          {group.key} <span className="text-ink-500">· {group.count}</span>
        </button>
      </td>
    </tr>
  )
}

/** A row the grid has not read yet: its place is held, at its height, until its block arrives. */
function PendingRow({ measure, index, columns, ticks, extra }: Measured & { columns: Column[]; ticks: boolean; extra: number }) {
  return (
    <tr ref={measure} data-index={index} aria-rowindex={index + 2} className={ROW} style={{ height: ROW_HEIGHT }} aria-busy>
      {ticks && <td />}
      {columns.map((c) => (
        <td key={c.id} className="px-2" style={{ width: c.width, maxWidth: c.width }}>
          <span className="block h-2.5 w-2/3 rounded-sm bg-ink-800" />
        </td>
      ))}
      <td colSpan={extra + 1} />
    </tr>
  )
}

/** Why a cell cannot be changed here. Null when it can; empty when it is not a value a person sets. `guard` says why access decided from it keeps it from the reader. */
function cellLock(e: Entity, col: Column, admin: boolean, visible: ReadonlySet<string>, guard: (name: string) => string | null): string | null {
  if (col.kind === 'field') return fieldLock(col.def, e.layers?.[col.id.slice(2)], admin) ?? guard(col.id.slice(2))
  if (col.kind === 'relation') {
    if (e.relationLayers?.[col.id.slice(2)] === 'git') return 'Set in git: change it there'
    return guard(col.id.slice(2))
  }
  return ''
}

/** Whether an edit rule opens a cell to the reader on this row, though the grid as a whole is not theirs to change. */
function cellOpened(e: Entity, col: Column): boolean {
  return (col.kind === 'field' || col.kind === 'relation') && opened(e, col.kind, col.id.slice(2))
}

/** An empty value that is the reader's to fill, said quietly where the value would be. */
function ToFill({ col }: { col: Column }) {
  return <span className="text-ink-500">{addWords(words(col.title))}</span>
}

function Row({ measure, index, e, columns, bp, canEdit, ticks, extra, selected, onSelect, onEdit, onPeek, cursor, onCursor }: RowProps & Measured & { e: Entity; ticks: boolean; selected: boolean; onSelect: (on: boolean) => void; cursor: number | null; onCursor: (col: number) => void }) {
  const actions = useEntityAction(e)
  const guard = useAccessGuard(bp)
  const star = useSetStarred()
  const viewing = useViewingAs()
  const [menu, setMenu] = useState<HTMLElement | null>(null)
  const [editing, setEditing] = useState<{ col: Column; anchor: HTMLElement } | null>(null)
  const [reading, setReading] = useState<{ col: Column; anchor: HTMLElement; lock: string } | null>(null)
  const admin = useIsAdmin()
  const visible = new Set(useBlueprints().data?.blueprints.map((b) => b.id))
  const edit = (patch: EntityPatch) => onEdit(e, patch)
  const lead = ticks ? LEAD : 0
  const bg = selected ? 'bg-ink-850' : 'bg-ink-900 group-hover:bg-ink-850'
  const title = columns.find((c) => c.id === 'title')
  return (
    <tr ref={measure} data-index={index} aria-rowindex={index + 2} aria-selected={ticks ? selected : undefined} className={`group ${ROW} ${selected ? 'bg-ink-850' : 'hover:bg-ink-850/70'} ${e.hidden ? 'text-ink-400' : ''}`} style={{ height: ROW_HEIGHT }}>
      {ticks && (
        <td data-col={-1} tabIndex={cursor === -1 ? 0 : -1} onFocus={() => onCursor(-1)} className={`z-10 px-2 focus-visible:-outline-offset-2 sticky left-0 ${bg}`}>
          <input type="checkbox" aria-label={`Select ${e.title}`} checked={selected} onChange={(ev) => onSelect(ev.target.checked)} />
        </td>
      )}
      {columns.map((c, i) => {
        const held = canEdit ? cellLock(e, c, admin, visible, guard) : ''
        // A rule that opens the value to the reader on this row lifts whatever kept the grid from them.
        const mine = held !== null && cellOpened(e, c)
        const lock = mine ? null : held
        const read = lock !== null && readable(e, c)
        const open = (anchor: HTMLElement) => (lock === null ? setEditing({ col: c, anchor }) : setReading({ col: c, anchor, lock }))
        return (
          <td
            key={c.id}
            data-col={i}
            tabIndex={cursor === i ? 0 : -1}
            onFocus={() => onCursor(i)}
            className={`max-w-0 truncate px-2 py-1.5 align-middle focus-visible:-outline-offset-2 ${stickyLeft(columns, i, 0) === undefined ? '' : `${bg} ${pinnedClass(columns, i)}`} ${lock === null || read ? 'cursor-pointer hover:shadow-[inset_0_0_0_1px_var(--color-ink-500)]' : ''}`}
            style={{ width: c.width, maxWidth: c.width, left: stickyLeft(columns, i, lead) }}
            title={[cellTitle(e, c), lock].filter(Boolean).join('\n') || undefined}
            onClick={lock === null || read ? (ev) => !(ev.target as HTMLElement).closest('a, button') && open(ev.currentTarget) : undefined}
            onKeyDown={lock === null || read ? (ev) => ev.target === ev.currentTarget && (ev.key === 'Enter' || ev.key === 'F2') && (ev.preventDefault(), open(ev.currentTarget)) : undefined}
          >
            {c.id === 'title' ? (
              <TitleCell e={e} canEdit={canEdit} onEdit={edit} onPeek={() => onPeek({ blueprint: e.blueprint, key: e.key })} onRename={(anchor) => setEditing({ col: c, anchor })} />
            ) : mine && blank(e, c) ? (
              <ToFill col={c} />
            ) : (
              <Cell e={e} col={c} />
            )}
          </td>
        )
      })}
      {extra > 0 && <td className={`sticky z-10 ${bg} ${EDGE.left} ${PINNED_RIGHT}`} style={{ right: ACTIONS }} />}
      <td data-col={columns.length} tabIndex={cursor === columns.length ? 0 : -1} onFocus={() => onCursor(columns.length)} className={`sticky right-0 z-10 px-1 focus-visible:-outline-offset-2 ${bg} ${extra > 0 ? '' : EDGE.left}`} style={{ width: ACTIONS, minWidth: ACTIONS }}>
        <button className={`grid size-6 place-items-center rounded-sm text-ink-500 hover:bg-ink-700 hover:text-ink-100 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100`} title="More" aria-label={`More for ${e.title}`} aria-haspopup="menu" aria-expanded={!!menu} onClick={(ev) => setMenu(ev.currentTarget)}>
          <MoreHorizontal className="size-3.5" />
        </button>
        {menu && (
          <Popover anchor={menu} onClose={() => setMenu(null)} width={176} menu label={e.title} className="py-1">
            <MenuItem onClick={() => navigate({ page: 'entity', blueprint: e.blueprint, key: e.key })}>Open</MenuItem>
            <MenuItem onClick={() => (onPeek({ blueprint: e.blueprint, key: e.key }), setMenu(null))}>Open beside the table</MenuItem>
            {!viewing && <MenuItem onClick={() => (star.mutate({ ref: { blueprint: e.blueprint, key: e.key }, on: !e.starred }), setMenu(null))}>{e.starred ? 'Unstar' : 'Star'}</MenuItem>}
            {(canEdit || opened(e, 'field', 'title')) && e.layers?.title !== 'git' && title && <MenuItem onClick={() => (setEditing({ col: title, anchor: menu }), setMenu(null))}>Rename</MenuItem>}
            {canEdit && <MenuItem onClick={() => (actions.hide.mutate(!e.hidden), setMenu(null))}>{e.hidden ? 'Unhide' : 'Hide'}</MenuItem>}
            {canEdit && e.owner === 'ui' && (
              <MenuItem danger onClick={() => (setMenu(null), confirm(`Delete ${e.title}?`) && actions.remove.mutate())}>
                Delete
              </MenuItem>
            )}
          </Popover>
        )}
        {editing && <CellEditor e={e} bp={bp} col={editing.col} anchor={editing.anchor} onEdit={edit} onClose={() => setEditing(null)} />}
        {reading && <CellInspector e={e} col={reading.col} anchor={reading.anchor} lock={reading.lock} onClose={() => setReading(null)} />}
      </td>
    </tr>
  )
}

/** The editor for one cell: the relation picker for a relation, the value editor for a field or the title. */
function CellEditor({ e, bp, col, anchor, onEdit, onClose }: { e: Entity; bp: Blueprint; col: Column; anchor: HTMLElement; onEdit: (patch: EntityPatch) => void; onClose: () => void }) {
  const name = col.id.slice(2)
  if (col.kind === 'relation') {
    const def = bp.relations[name]
    if (!def) return null
    return <RelationEditor anchor={anchor} target={def.target} many={!!def.many} value={e.relations[name] ?? []} onCommit={(targets) => (onEdit(relationPatch(name, !!def.many, targets)), onClose())} onClose={onClose} />
  }
  const field = col.kind === 'field'
  // The editor is named for its column, which a field without a title of its own takes from its name.
  return <ValueEditor anchor={anchor} def={field && col.def ? { ...col.def, title: col.title } : TITLE_DEF} value={field ? e.fields[name] : e.title} onCommit={(value) => (onEdit({ fields: { [field ? name : 'title']: value } }), onClose())} onClose={onClose} />
}

/** Whether a cell the reader cannot change opens to be read in full: a value or a relation that holds something. */
function readable(e: Entity, col: Column): boolean {
  return (col.kind === 'field' || col.kind === 'relation' || col.kind === 'incoming') && !blank(e, col)
}

/** How many things an inspector lists before it offers to find among them. */
const FINDABLE = 8

/**
 * One cell read in full, for a reader who cannot change it: every value of a
 * list, every thing a relation reaches, long text unclipped. It opens over
 * the cell as the editor does, and says why the value cannot be changed
 * here when the reader may change others.
 */
function CellInspector({ e, col, anchor, lock, onClose }: { e: Entity; col: Column; anchor: HTMLElement; lock: string; onClose: () => void }) {
  const name = col.id.slice(2)
  const title = words(col.title)
  return (
    <Popover anchor={anchor} place="over" width={col.kind === 'field' ? 360 : 320} onClose={onClose} label={`${title} of ${e.title}`}>
      <div className={`max-md:max-w-none ${col.kind === 'field' ? 'max-w-[28rem]' : 'max-w-[24rem]'}`}>
        <Kicker className="border-b border-ink-700 px-3 py-1.5">{title}</Kicker>
        {col.kind === 'field' ? (
          <div className="max-h-96 overflow-y-auto px-3 py-2 text-[13px] whitespace-pre-wrap [overflow-wrap:anywhere] text-ink-200">
            <Value value={e.fields[name]} def={col.def} people={e.people} />
          </div>
        ) : col.kind === 'relation' ? (
          <Targets targets={e.relations[name] ?? []} />
        ) : (
          <Pointing e={e} name={name} />
        )}
        {lock && (
          <div className="flex items-center gap-1.5 border-t border-ink-700 px-3 py-1.5 text-[12px] text-ink-400">
            <Lock className="size-3 shrink-0" />
            {lock}
          </div>
        )}
      </div>
    </Popover>
  )
}

/** Who points at a row under one key. The grid reads only the first few of each, so the rest are read from the row's own page when there are more. */
function Pointing({ e, name }: { e: Entity; name: string }) {
  const few = e.incomingRefs?.[name] ?? []
  const more = (e.incomingCount?.[name] ?? few.length) > few.length
  return more ? <AllPointing e={e} name={name} /> : <Targets targets={few} />
}

function AllPointing({ e, name }: { e: Entity; name: string }) {
  const page = useEntity({ blueprint: e.blueprint, key: e.key })
  if (!page.data) return <div className="px-3 py-2 text-[13px] text-ink-400">{page.error ? 'Could not read them.' : 'Reading…'}</div>
  return <Targets targets={page.data.incomingRefs?.[name] ?? []} />
}

/** Things a cell points at, each a link to its page; a long list can be searched. */
function Targets({ targets }: { targets: (EntityRef & { title?: string; icon?: string | null })[] }) {
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const shown = needle ? targets.filter((t) => `${t.title ?? ''} ${t.key}`.toLowerCase().includes(needle)) : targets
  return (
    <div onKeyDown={(ev) => walk(ev, 'input, a')}>
      {targets.length > FINDABLE && (
        <div className="flex items-center gap-2 border-b border-ink-700 px-3 py-1.5">
          <input className="min-w-0 flex-1 bg-transparent text-sm text-ink-100 outline-none" aria-label="Find among them" placeholder={`Find among ${targets.length}`} value={query} onChange={(ev) => setQuery(ev.target.value)} autoFocus />
          {needle && <span className="shrink-0 font-mono text-[11px] text-ink-400">{shown.length}</span>}
        </div>
      )}
      <ul className="max-h-80 overflow-y-auto py-1">
        {shown.map((t) => (
          <li key={`${t.blueprint}/${t.key}`}>
            <Link to={{ page: 'entity', blueprint: t.blueprint, key: t.key }} className="flex min-w-0 items-baseline gap-2 px-3 py-1 text-[13px] text-ink-100 hover:bg-ink-800 focus-visible:bg-ink-800">
              {t.icon && <Icon name={t.icon} className="size-3.5 shrink-0 self-center text-ink-400" />}
              <span className="min-w-0 [overflow-wrap:anywhere]">{t.title ?? t.key.split('/').pop()}</span>
              {t.title && t.title !== t.key && <span className="ml-auto min-w-0 shrink truncate font-mono text-[11px] text-ink-500">{t.key}</span>}
            </Link>
          </li>
        ))}
        {shown.length === 0 && <li className="px-3 py-1 text-[13px] text-ink-400">Nothing matches.</li>}
      </ul>
    </div>
  )
}

function TitleCell({ e, canEdit, onEdit, onPeek, onRename }: { e: Entity; canEdit: boolean; onEdit: (patch: EntityPatch) => void; onPeek: () => void; onRename: (cell: HTMLElement) => void }) {
  return (
    <span className="flex items-center gap-2">
      <EntityIcon e={e} layer={e.layers?.icon} canEdit={canEdit || opened(e, 'field', 'icon')} onEdit={onEdit} />
      <Link to={{ page: 'entity', blueprint: e.blueprint, key: e.key }} className={`truncate hover:underline ${e.state === 'missing' || e.hidden ? 'text-ink-400' : 'text-orbit'}`}>
        {e.title}
      </Link>
      <EntityStar e={e} quiet className="p-1" />
      <span className="ml-auto hidden shrink-0 items-center group-hover:flex group-focus-within:flex">
        {(canEdit || opened(e, 'field', 'title')) && e.layers?.title !== 'git' && (
          <button className="rounded-sm p-1 text-ink-500 hover:bg-ink-700 hover:text-ink-100" title="Rename" onClick={(ev) => onRename(ev.currentTarget.closest('td')!)}>
            <Pencil className="size-3" />
          </button>
        )}
        <button className="rounded-sm p-1 text-ink-500 hover:bg-ink-700 hover:text-ink-100" title="Open beside the table" onClick={onPeek}>
          <PanelRight className="size-3" />
        </button>
      </span>
    </span>
  )
}

/**
 * What whoever ticked rows can do to all of them at once: give them an icon,
 * set one field or relation, hide them, delete the ones made here. Each
 * entity takes the edit on its own; the bar says how many refused and why.
 */
/**
 * Says what a selection holds against what the grid matches. Every row read so
 * far ticked by hand leaves the rest unpicked, so it offers every row that
 * matches. Every match picked, it says how many the filter leaves out, so a
 * default filter hiding some rows is never missed.
 */
function PickAll({ picked, all, loaded, total, every, onAll }: { picked: number; all: boolean; loaded: number; total: number; every: number; onAll: () => void }) {
  const n = (x: number) => x.toLocaleString('en-US')
  if (!all && picked >= loaded && total > picked)
    return (
      <div role="status" className="flex flex-wrap items-center gap-2 rounded-sm border border-ink-700 bg-ink-850 px-3 py-1.5 text-[13px] text-ink-200">
        Every row loaded so far is picked: {n(picked)} of the {n(total)} that match.
        <button type="button" className="font-medium text-ink-50 underline" onClick={onAll}>
          Pick all {n(total)} that match
        </button>
      </div>
    )
  if (all && every > total)
    return (
      <div role="status" className="rounded-sm border border-ink-700 bg-ink-850 px-3 py-1.5 text-[13px] text-ink-300">
        All {n(picked)} that match are picked. The filter leaves out {n(every - total)} more of the {n(every)}.
      </div>
    )
  return null
}

function BulkBar({ bp, count, target, loaded, onClear, edits, actions }: { bp: Blueprint; count: number; target: BulkTarget; loaded: Entity[]; onClear: () => void; edits: boolean; actions: ActionView[] }) {
  const bulk = useBulkEdit()
  const [running, setRunning] = useState<ActionView | null>(null)
  const remove = useDeleteEntities()
  const [icon, setIcon] = useState<HTMLElement | null>(null)
  const [setting, setSetting] = useState<{ id: string; anchor: HTMLElement } | null>(null)
  // Whether to hide or unhide, and whether every row was made here, read from the ticked rows the grid has read.
  const many = loaded.length < count
  const admin = useIsAdmin()
  const guard = useAccessGuard(bp)
  const fields = Object.entries(bp.fields).filter(([name, def]) => fieldLock(def, undefined, admin) === null && guard(name) === null)
  const relations = Object.entries(bp.relations).filter(([name]) => guard(name) === null)
  const allHidden = loaded.length > 0 && loaded.every((e) => e.hidden)
  const name = setting?.id.slice(2) ?? ''
  const relation = setting?.id.startsWith('r:') ? bp.relations[name] : undefined
  const refused = bulk.data?.refused ?? []
  return (
    <Panel className="flex flex-wrap items-center gap-2 border-orbit/60 px-3 py-2">
      <span className="font-mono text-[12px] text-ink-100">{count.toLocaleString('en-US')} selected{many && target.query ? ' · every row that matches' : ''}</span>
      {actions.map((a) => (
        <Button key={a.id} kind="solid" opens="dialog" title={a.description ?? a.title} onClick={() => setRunning(a)}>
          <span className="flex items-center gap-1.5">
            <Icon name={iconOf(a)} className="size-3.5" />
            {a.title}
          </span>
        </Button>
      ))}
      {running && <BatchDrawer action={running} request={target.query ? { query: target.query } : { entities: target.entities }} count={count} onClose={() => setRunning(null)} />}
      {edits && <>
      <Button onClick={(ev) => setIcon(ev.currentTarget)}>Icon</Button>
      <select className={input} value="" onChange={(ev) => ev.target.value && setSetting({ id: ev.target.value, anchor: ev.target })}>
        <option value="">Set a value…</option>
        {fields.map(([id, def]) => (
          <option key={id} value={`f:${id}`}>
            {def.title ?? id}
          </option>
        ))}
        {relations.map(([id, def]) => (
          <option key={id} value={`r:${id}`}>
            {def.title ?? id} → {def.target}
          </option>
        ))}
      </select>
      <Button onClick={() => bulk.mutate({ ...target, hidden: !allHidden })}>{allHidden ? 'Unhide' : 'Hide'}</Button>
      {/* Only rows made here can be deleted; a row a source owns is refused and named, never deleted. */}
      {loaded.length > 0 && loaded.every((e) => e.owner === 'ui') && (
        <Button kind="danger" disabled={remove.isPending} onClick={() => confirm(`Delete ${count} ${count === 1 ? 'entity' : 'entities'}?`) && remove.mutate(target, { onSuccess: (r) => r.refused.length === 0 && onClear() })}>
          Delete
        </Button>
      )}
      </>}
      <Button onClick={onClear}>Clear selection</Button>
      {bulk.isPending && <span className="font-mono text-[12px] text-ink-400">saving…</span>}
      {bulk.data && !bulk.isPending && (
        <span className={`font-mono text-[12px] ${refused.length ? 'text-amber' : 'text-ink-400'}`} title={refused.map((r) => `${r.key}: ${r.reason}`).join('\n')}>
          changed {bulk.data.changed}
          {refused.length > 0 && ` · ${refused.length} refused: ${refused[0]!.reason}`}
        </span>
      )}
      {remove.data && remove.data.refused.length > 0 && <span className="font-mono text-[12px] text-amber" title={remove.data.refused.map((r) => `${r.key}: ${r.reason}`).join('\n')}>deleted {remove.data.changed} · {remove.data.refused.length} refused: {remove.data.refused[0]!.reason}</span>}
      <ErrorNote error={bulk.error ?? remove.error} />
      {icon && <IconPicker anchor={icon} value={null} onPick={(picked) => (bulk.mutate({ ...target, fields: { icon: picked } }), setIcon(null))} resets={[{ label: 'Back to the icon each had before', run: () => (bulk.mutate({ ...target, fields: { icon: null } }), setIcon(null)) }]} onClose={() => setIcon(null)} />}
      {setting && relation && <RelationEditor anchor={setting.anchor} place="below" target={relation.target} many={!!relation.many} value={[]} onCommit={(targets) => (bulk.mutate({ ...target, ...relationPatch(name, !!relation.many, targets) }), setSetting(null))} onClose={() => setSetting(null)} />}
      {setting && !relation && bp.fields[name] && <ValueEditor anchor={setting.anchor} place="below" def={bp.fields[name]} value={undefined} onCommit={(value) => (bulk.mutate({ ...target, fields: { [name]: value } }), setSetting(null))} onClose={() => setSetting(null)} />}
    </Panel>
  )
}

/** How tall each line of the grid is drawn: a cell's padding, its text, and its rule. Every row, heading, and placeholder is held to it, so the scrollbar is right before a row is read. */
const ROW_HEIGHT = 37

/** A drawn line tells the grid its real height, so the scrollbar stays true however tall a row turns out. */
interface Measured {
  measure: (el: HTMLTableRowElement | null) => void
  index: number
}

/** One line the grid draws: a group's heading, or the row at a position among all that matched. */
type Line = { kind: 'group'; group: GridGroup } | { kind: 'row'; at: number }

/** The lines of the whole list, top to bottom. A folded group keeps its heading and none of its rows. */
export function layOut(total: number, groups: GridGroup[] | null | undefined, folded: ReadonlySet<string>): Line[] {
  if (!groups) return Array.from({ length: total }, (_, at) => ({ kind: 'row', at }))
  const out: Line[] = []
  for (const group of groups) {
    out.push({ kind: 'group', group })
    if (folded.has(group.key)) continue
    for (let i = 0; i < group.count; i++) out.push({ kind: 'row', at: group.start + i })
  }
  return out
}

/**
 * The rows of one grid, read a block at a time. The first block brings the
 * total, the counts, and the groups; the rest are read as the grid scrolls to
 * them. A block cut from a list the hub has since changed is read again, so
 * rows never mix two states of the list.
 */
function useRows(blueprint: string, params: URLSearchParams, enabled: boolean, from: number, to: number) {
  const head = useGridBlock(blueprint, params, 0, enabled)
  const total = head.data?.total ?? 0
  const lastBlock = Math.max(0, Math.ceil(total / BLOCK) - 1)
  const blocks: number[] = []
  for (let b = Math.max(1, Math.floor(from / BLOCK)); b <= Math.min(lastBlock, Math.floor(Math.max(from, to - 1) / BLOCK)); b++) blocks.push(b)
  const client = useQueryClient()
  const blockKey = (b: number) => [...keys.entities(blueprint, params.toString()), 'block', b] as const
  const others = useQueries({
    queries: blocks.map((b) => {
      const q = new URLSearchParams(params)
      q.set('limit', String(BLOCK))
      q.set('offset', String(b * BLOCK))
      // While a block is read again, the rows it held stay on screen.
      return { queryKey: blockKey(b), queryFn: () => call<EntitiesResponse>(`/v1/entities?blueprint=${encodeURIComponent(blueprint)}&${q.toString()}`), staleTime: 30_000, enabled: enabled && !!head.data, placeholderData: (prev: EntitiesResponse | undefined) => prev }
    }),
  })
  // The newest list any block was cut from. A block cut from an older one is read again, and shows its rows until the new ones come.
  const all = [head.data, ...others.map((o) => o.data)]
  const newest = Math.max(0, ...all.map((d) => d?.version ?? 0))
  const stale = others.map((o, i) => (o.data && (o.data.version ?? 0) < newest && !o.isFetching ? blocks[i]! : null)).filter((b): b is number => b !== null)
  const headStale = !!head.data && (head.data.version ?? 0) < newest && !head.isFetching
  useEffect(() => {
    for (const b of stale) void client.invalidateQueries({ queryKey: blockKey(b), exact: true })
    if (headStale) void client.invalidateQueries({ queryKey: blockKey(0), exact: true })
  }, [stale.join(','), headStale]) // eslint-disable-line react-hooks/exhaustive-deps
  const shares = useGridShares(blueprint, params, newest, enabled && !!head.data)
  const byBlock = new Map<number, Entity[]>()
  if (head.data) byBlock.set(0, head.data.entities)
  others.forEach((o, i) => o.data && byBlock.set(blocks[i]!, o.data.entities))
  return {
    ready: !!head.data,
    total,
    distribution: shares.data?.distribution,
    groups: head.data?.groups ?? null,
    error: head.error ?? others.find((o) => o.error)?.error ?? null,
    /** The row at a position among all that matched, once its block is read. */
    at: (i: number): Entity | undefined => byBlock.get(Math.floor(i / BLOCK))?.[i % BLOCK],
    /** Every row read so far. */
    loaded: [...byBlock.values()].flat(),
  }
}

/**
 * What a person ticked: rows one by one, or every row that matches with the
 * ones unticked after. Ticking every row never reads them; a bulk change sends
 * the filter instead. A different filter, sort, or grouping starts it over.
 */
function useSelection(question: string) {
  const empty = { all: false, ids: new Map<string, EntityRef>(), except: new Map<string, EntityRef>() }
  const [state, setState] = useState({ question, ...empty })
  const selection = state.question === question ? state : { question, ...empty }
  const ref = (e: Entity): EntityRef => ({ blueprint: e.blueprint, key: e.key })
  return {
    selection,
    has: (e: Entity) => (selection.all ? !selection.except.has(e.id) : selection.ids.has(e.id)),
    set: (e: Entity, on: boolean) =>
      setState(() => {
        const next = { ...selection, ids: new Map(selection.ids), except: new Map(selection.except) }
        if (selection.all) {
          if (on) next.except.delete(e.id)
          else next.except.set(e.id, ref(e))
        } else if (on) next.ids.set(e.id, ref(e))
        else next.ids.delete(e.id)
        return next
      }),
    all: () => setState({ question, ...empty, all: true }),
    clear: () => setState({ question, ...empty }),
  }
}

/** The checkbox, the status lamp, and the title stay put while the rest of a very wide table scrolls. */
/** How much a column's menu widens or narrows it at a time. */
const WIDEN = 40

/** The grid's cursor on the header row rather than on an entity's row. */
const HEAD = '#head'

/** Where the pinned columns end, so a cell scrolled to by the keyboard is not left under them. */
function pinnedEnd(columns: Column[], lead: number): number {
  return columns.reduce((end, c, i) => {
    const left = stickyLeft(columns, i, lead)
    return left === undefined ? end : Math.max(end, left + c.width)
  }, lead)
}

/**
 * The keys of the grid. Arrows move between cells, Home and End go to either
 * end of the row. Enter on a cell that does not edit, or Space, uses what is
 * in it: the link first, then a button or a box to tick.
 */
function moveInGrid(event: React.KeyboardEvent<HTMLTableElement>): void {
  const cell = event.target as HTMLElement
  if (event.defaultPrevented || (cell.tagName !== 'TD' && cell.tagName !== 'TH') || cell.dataset.col === undefined) return
  const row = cell.parentElement!
  const col = Number(cell.dataset.col)
  const cells = [...row.querySelectorAll<HTMLElement>('[data-col]')]
  // The rows of the header and the body, in order; a row without this column, such as a group's heading, is passed over.
  const across = (by: number): HTMLElement | null => {
    const rows = [...event.currentTarget.querySelectorAll('tr')]
    for (let at = rows.indexOf(row as HTMLTableRowElement) + by; at >= 0 && at < rows.length; at += by) {
      const found = rows[at]!.querySelector<HTMLElement>(`[data-col="${col}"]`)
      if (found) return found
    }
    return null
  }
  const to = {
    ArrowLeft: cells[cells.indexOf(cell) - 1],
    ArrowRight: cells[cells.indexOf(cell) + 1],
    Home: cells[0],
    End: cells.at(-1),
    ArrowUp: across(-1),
    ArrowDown: across(1),
  }[event.key]
  if (to) {
    event.preventDefault()
    to.focus()
    return
  }
  if (event.key === 'Enter' || event.key === ' ') {
    const inside = cell.querySelector<HTMLElement>('a[href]') ?? cell.querySelector<HTMLElement>('button, input')
    if (!inside) return
    event.preventDefault()
    inside.click()
  }
}

/** One entity beside the table. It takes focus when it opens and gives it back to what opened it when it closes. */
function Peek({ entityRef, onClose }: { entityRef: EntityRef; onClose: () => void }) {
  const ref = useRef<HTMLElement>(null)
  useEscape(onClose)
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    ref.current?.focus()
    return () => opener?.focus()
  }, [])
  return (
    <aside ref={ref} tabIndex={-1} aria-label={entityRef.key} className="fixed top-0 right-0 z-40 h-dvh w-[480px] max-w-full overflow-y-auto border-l border-ink-600 bg-ink-900 outline-none elevate-drawer">
      <EntityPanel entityRef={entityRef} onClose={onClose} />
    </aside>
  )
}

function stickyLeft(columns: Column[], i: number, lead: number): number | undefined {
  if (i > 1 || !['status', 'title'].includes(columns[i]!.id)) return undefined
  return lead + (i === 1 && columns[0]!.id === 'status' ? columns[0]!.width : 0)
}

/**
 * How a column pinned to the left sits, with a rule on its right when it is
 * the last one. A body cell rides above the cells that scroll under it, and
 * a header or footer cell above the body cells.
 */
function pinnedClass(columns: Column[], i: number, edge: 'body' | 'head' = 'body'): string {
  return stickyLeft(columns, i, 0) === undefined ? '' : `sticky ${edge === 'body' ? 'z-10' : 'z-30'} ${columns[i]!.id === 'title' ? EDGE.right : ''}`
}

/** The rules that edge the header, the footer, and the pinned columns. The table keeps its borders apart, so each travels with its sticky cell. */
const EDGE = { below: 'border-b border-b-ink-700', above: 'border-t border-t-ink-700', left: 'border-l border-l-ink-700', right: 'border-r border-r-ink-700' }
/** A soft shadow on a column pinned to the right, so what scrolls under it reads as more to see, not as cut off. */
const PINNED_RIGHT = 'shadow-[-18px_0_16px_-8px_var(--color-shade)]'
/** The rule under every row, drawn on its cells. */
const ROW = '[&>td]:border-b [&>td]:border-b-ink-800'

function Header({ col, index, cursor, onCursor, pinned, left, sort, onOpen, onResize, drag, dragging, mark, yours }: { col: Column; yours: boolean; index: number; cursor: boolean; onCursor: () => void; pinned: string; left: number | undefined; sort: string; onOpen: (anchor: HTMLElement) => void; onResize?: (width: number) => void; drag?: DragProps; dragging: boolean; mark: string }) {
  const ref = useRef<HTMLTableCellElement>(null)
  const [width, setWidth] = useState(col.width)
  const glyph = col.def?.type === 'url' ? iconNamed(col.def.icon) : null
  useEffect(() => setWidth(col.width), [col.width])
  const key = sortKey(col)
  const active = sort === key || sort === `-${key}`
  const start = (e: React.MouseEvent) => {
    if (!onResize) return
    e.preventDefault()
    const x0 = e.clientX
    const w0 = width
    const move = (ev: MouseEvent) => setWidth(Math.max(40, w0 + ev.clientX - x0))
    const up = (ev: MouseEvent) => {
      removeEventListener('mousemove', move)
      removeEventListener('mouseup', up)
      onResize(Math.max(40, w0 + ev.clientX - x0))
    }
    addEventListener('mousemove', move)
    addEventListener('mouseup', up)
  }
  return (
    <th ref={ref} {...drag} data-col={index} tabIndex={cursor ? 0 : -1} onFocus={onCursor} onKeyDown={(e) => e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onOpen(ref.current!))} aria-haspopup="menu" aria-sort={active ? (sort.startsWith('-') ? 'descending' : 'ascending') : undefined} style={{ width, minWidth: width, maxWidth: width, left }} className={`sticky -top-px bg-ink-900 px-2 py-2 text-left text-[12px] font-medium text-ink-400 focus-visible:-outline-offset-2 ${EDGE.below} ${pinned || 'z-20'} ${dragging ? 'opacity-40' : ''} ${mark}`}>
      {/* Not a button: Firefox never starts a drag from inside one, and the heading is what a person drags. */}
      {/* The heading cell is what the keyboard stands on; this is what the pointer clicks and drags. */}
      {/* One line: a heading narrower than its name ends in an ellipsis, and the hover gives the whole name. */}
      <span className={`block cursor-pointer truncate text-left hover:text-ink-200 ${active ? 'text-ink-100' : ''}`} onClick={() => onOpen(ref.current!)} title={[words(col.title), col.def?.description ?? (drag ? 'Drag to move this column' : undefined)].filter(Boolean).join('\n')}>
        {/* A column as narrow as an icon, such as a link, is headed by the icon its links wear, and its name is on hover. */}
        {width < NARROW && col.def ? (
          glyph ? <Icon name={glyph} className="inline size-4 align-[-3px] text-ink-300" /> : <TypeGlyph def={col.def} className="inline align-[-2px]" />
        ) : col.def && <TypeGlyph def={col.def} className="mr-1 inline align-[-2px]" />}
        {width >= NARROW && col.def?.pivoted && <span className="mr-1 text-ink-500" title={`A property of ${col.def.pivoted.field}`}>{col.def.pivoted.field} ▸</span>}
        {(width >= NARROW || !col.def) && words(col.title)}
        {active && (sort.startsWith('-') ? ' ↓' : ' ↑')}
        {/* A column the reader may change on rows of their own, though the grid is not theirs: said once, at its head. */}
        {yours && width >= NARROW && (
          <span title="Yours to change on the rows that are yours">
            <Pencil aria-hidden className="ml-1 inline size-3 align-[-1px] text-ink-500" />
            <span className="sr-only"> (yours to change on the rows that are yours)</span>
          </span>
        )}
      </span>
      {/* A drag resizes the column; its menu does the same a step at a time. */}
      {onResize && <span aria-hidden onMouseDown={start} className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize hover:bg-ink-600" />}
    </th>
  )
}

/** Narrower than this, a column's heading is its icon alone. */
const NARROW = 72

type Drop = { id: string; side: 'before' | 'after' }
type DragProps = ReturnType<ReturnType<typeof useReorder>['item']>
/** Where a dragged column will land: a rule on the near edge of the one under the pointer. */
const MARK = { before: 'shadow-[inset_2px_0_0_var(--color-orbit)]', after: 'shadow-[inset_-2px_0_0_var(--color-orbit)]' }

function sideOf(e: React.DragEvent<HTMLElement>): Drop['side'] {
  const box = e.currentTarget.getBoundingClientRect()
  return e.clientX < box.left + box.width / 2 ? 'before' : 'after'
}

/** Drag one item onto another to move it to that side of it. Each list keeps its own, so a column dragged from the grid never lands in the picker. */
function useReorder(onDrop: (id: string, to: Drop) => void) {
  const [dragging, setDragging] = useState<string | null>(null)
  const [over, setOver] = useState<Drop | null>(null)
  const end = () => (setDragging(null), setOver(null))
  const item = (id: string) => ({
    draggable: true,
    onDragStart: (e: React.DragEvent<HTMLElement>) => {
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('text/plain', id)
      setDragging(id)
    },
    onDragOver: (e: React.DragEvent<HTMLElement>) => {
      if (!dragging) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      const side = sideOf(e)
      if (over?.id !== id || over.side !== side) setOver({ id, side })
    },
    // The drop reads its own side: the last hover may not have rendered yet.
    onDrop: (e: React.DragEvent<HTMLElement>) => {
      e.preventDefault()
      if (dragging) onDrop(dragging, { id, side: sideOf(e) })
      end()
    },
    onDragEnd: end,
  })
  const mark = (id: string) => (dragging && dragging !== id && over?.id === id ? MARK[over.side] : '')
  return { item, mark, dragging }
}

/** What a click on a column's heading offers: sort it, hide it, and change or delete the field behind it. */
function ColumnMenu({ bp, col, anchor, sort, onSort, sortDefault, onSortDefault, onShareSort, onHide, onMove, onUnmove, onUnsize, onWiden, canAuthor, onEdit, onClose }: { bp: Blueprint; col: Column; anchor: HTMLElement; sort: string; onSort: (sort: string) => void; sortDefault: string; onSortDefault: () => void; onShareSort?: () => void; onHide?: () => void; onMove?: { left?: () => void; right?: () => void }; onUnmove?: () => void; onUnsize?: () => void; onWiden?: (by: number) => void; canAuthor: boolean; onEdit: (name: string) => void; onClose: () => void }) {
  const save = useSaveBlueprint()
  const key = sortKey(col)
  const sortable = col.kind === 'meta' || col.kind === 'field'
  const name = col.kind === 'field' ? col.id.slice(2) : null
  const locked = bp.origin.kind === 'git' ? `This blueprint lives in git (${bp.origin.file}): change the field there` : bp.origin.kind === 'hub' ? "This blueprint is the hub's own: its fields cannot be changed" : undefined
  const run = (action: () => void) => (action(), onClose())
  const remove = () => {
    if (!name || !confirm(`Delete the property ${col.title}? Its values are kept, but no view shows them.`)) return
    const { [name]: _gone, ...fields } = bp.fields
    // A sort on a field that is gone sorts by nothing, so the grid goes back to its titles.
    save.mutate({ id: bp.id, spec: { ...specOf(bp), fields } }, { onSuccess: () => (sort.replace(/^-/, '') === key && onSort('title'), onClose()) })
  }
  return (
    <Popover anchor={anchor} onClose={onClose} width={256} menu label={col.title} className="py-1">
      {sortable && (
        <>
          <MenuItem active={sort === key} onClick={() => run(() => onSort(key))}>
            <ArrowUp className="size-3.5 text-ink-400" /> Sort ascending
          </MenuItem>
          <MenuItem active={sort === `-${key}`} onClick={() => run(() => onSort(`-${key}`))}>
            <ArrowDown className="size-3.5 text-ink-400" /> Sort descending
          </MenuItem>
        </>
      )}
      {sort !== sortDefault && (
        <>
          <MenuItem onClick={() => run(onSortDefault)}>
            <X className="size-3.5 text-ink-400" /> Back to the default sort
          </MenuItem>
          {/* The sort is shared from the column it is on, so what everyone gets is the column the menu names. */}
          {onShareSort && sort.replace(/^-/, '') === key && (
            <MenuItem title="Everyone opens this grid sorted this way. What anyone sorts after is theirs until the page loads again." onClick={() => run(onShareSort)}>
              <ArrowUpDown className="size-3.5 text-ink-400" /> Make this sort the default for everyone
            </MenuItem>
          )}
        </>
      )}
      {onHide && (
        <>
          {sortable && <div role="separator" className="my-1 border-t border-ink-700" />}
          {/* Moving and sizing a column without a drag. */}
          {onWiden && (
            <>
              <MenuItem onClick={() => run(() => onWiden(WIDEN))}>
                <ChevronsLeftRight className="size-3.5 text-ink-400" /> Wider
              </MenuItem>
              <MenuItem disabled={col.width <= 40} onClick={() => run(() => onWiden(-WIDEN))}>
                <ChevronsRightLeft className="size-3.5 text-ink-400" /> Narrower
              </MenuItem>
              {onUnsize && (
                <MenuItem title="This column was sized by hand. Put it back at the width the column standard gives it." onClick={() => run(onUnsize)}>
                  <ChevronsLeftRight className="size-3.5 text-ink-400" /> Back to the standard width
                </MenuItem>
              )}
            </>
          )}
          {onMove && (
            <>
              <MenuItem disabled={!onMove.left} onClick={() => onMove.left && run(onMove.left)}>
                <ArrowLeft className="size-3.5 text-ink-400" /> Move left
              </MenuItem>
              <MenuItem disabled={!onMove.right} onClick={() => onMove.right && run(onMove.right)}>
                <ArrowRight className="size-3.5 text-ink-400" /> Move right
              </MenuItem>
              {onUnmove && (
                <MenuItem title="This column was moved by hand. Put it back where the column standard places it." onClick={() => run(onUnmove)}>
                  <ArrowUpDown className="size-3.5 text-ink-400" /> Back to the standard place
                </MenuItem>
              )}
            </>
          )}
          <MenuItem onClick={() => run(onHide)}>
            <EyeOff className="size-3.5 text-ink-400" /> Hide column
          </MenuItem>
        </>
      )}
      {name && canAuthor && (
        <>
          <MenuItem disabled={!!locked} title={locked} onClick={() => run(() => onEdit(name))}>
            <Pencil className="size-3.5 text-ink-400" /> Edit property
          </MenuItem>
          <MenuItem danger disabled={!!locked || save.isPending} title={locked} onClick={remove}>
            <Trash2 className="size-3.5" /> Delete property
          </MenuItem>
        </>
      )}
      {!sortable && !onHide && !(name && canAuthor) && <div className="px-3 py-1 text-[12px] text-ink-500">Nothing to do with this column.</div>}
      {save.error && (
        <div className="px-3 py-1">
          <ErrorNote error={save.error} />
        </div>
      )}
    </Popover>
  )
}

/** An action's button on a row the reader may run it on; nothing on one they may not. It opens the action's form on the row. */
function ActionCell({ e, action }: { e: Entity; action: ActionView }) {
  const [open, setOpen] = useState(false)
  if (!e.actions?.includes(action.id)) return <span className="text-ink-500" title={`You may not run ${action.title} on this`}>—</span>
  return (
    <>
      <button type="button" aria-haspopup="dialog" title={action.description ?? action.title} aria-label={`${action.title}: ${e.title}`} onClick={() => setOpen(true)} className="btn btn-ghost inline-flex max-w-full items-center gap-1.5 px-2 py-0.5 text-[12px]">
        <Icon name={iconOf(action)} className="size-3.5 shrink-0" />
        <span className="truncate">{action.title}</span>
      </button>
      {open && <RunDrawer action={action} entity={e} onClose={() => setOpen(false)} />}
    </>
  )
}

/** How many values a cell draws before it says how many more there are. */
const SHOWN = 3

function Cell({ e, col }: { e: Entity; col: Column }) {
  if (col.kind === 'meta') {
    switch (col.id) {
      case 'status':
        return <Lamp level={e.status.level} title={humanTimes(e.status.reasons.join('\n'))} />
      case 'key':
        return <span className="font-mono text-[12px] text-ink-300">{e.key}</span>
      case 'state':
        return <Chip value={e.state} def={STATE_DEF} />
      case 'owner':
        return <span className="font-mono text-[12px] text-ink-300">{e.owner}</span>
      case 'lastSeenAt':
        return <span className="text-[13px] text-ink-400 tabular-nums">{ago(e.lastSeenAt)}</span>
      case 'updatedAt':
        return <span className="text-[13px] text-ink-400 tabular-nums">{ago(e.updatedAt)}</span>
    }
  }
  if (col.kind === 'relation') {
    const targets = e.relations[col.id.slice(2)] ?? []
    return (
      <span className="flex gap-1 overflow-hidden whitespace-nowrap">
        {targets.slice(0, SHOWN).map((t) => <TargetChip key={t.key} target={t} />)}
        {targets.length > SHOWN && <span className="shrink-0 font-mono text-[12px] text-ink-500">+{targets.length - SHOWN}</span>}
      </span>
    )
  }
  if (col.kind === 'incoming') {
    const sources = e.incomingRefs?.[col.id.slice(2)] ?? []
    const count = e.incomingCount?.[col.id.slice(2)] ?? sources.length
    return (
      <span className="flex gap-1 overflow-hidden whitespace-nowrap">
        {sources.slice(0, SHOWN).map((t) => <TargetChip key={t.key} target={t} />)}
        {count > SHOWN && <span className="shrink-0 font-mono text-[12px] text-ink-500">+{count - SHOWN}</span>}
      </span>
    )
  }
  if (col.kind === 'scorecard') return <ScorecardCell e={e} scorecard={col.id.slice(2)} />
  if (col.kind === 'rule') return <RuleCell e={e} id={col.id.slice(2)} />
  if (col.kind === 'action') return <ActionCell e={e} action={col.action!} />
  const v = e.fields[col.id.slice(2)]
  const def = col.def
  if (v === null || v === undefined || v === '') return <span className="text-ink-500">—</span>
  return <FieldValue v={v} def={def} people={e.people} />
}

function FieldValue({ v, def, people }: { v: unknown; def: FieldDef | undefined; people: Entity['people'] }) {
  if (def?.type === 'user' && people) {
    // A person the hub knows is a link to them, as a relation is; an address that is nobody here stays the text it is.
    const values = (Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === 'string')
    if (values.some((x) => people[addressKey(x)]))
      return (
        <span className="flex gap-1 overflow-hidden whitespace-nowrap">
          {values.map((x) => {
            const person = people[addressKey(x)]
            return person ? <TargetChip key={x} target={person} hint={x} /> : <span key={x} className="truncate">{x}</span>
          })}
        </span>
      )
  }
  if ((def?.type === 'enum' || def?.chip) && typeof v === 'string') return <Chip value={v} def={def} />
  if (typeof v === 'boolean') return <Chip value={String(v)} label={v ? 'yes' : 'no'} def={def} />
  if ((def?.type === 'url' || def?.type === 'openapi') && linksOf(v).length) {
    // A link is its mark: the address is on hover and one click away, and a list of them fits a cell.
    return (
      <span className="flex items-center gap-1 overflow-hidden whitespace-nowrap">
        {linksOf(v).map((url) => {
          const icon = linkMark(def, url)
          return (
            <a key={url} href={url} target="_blank" rel="noreferrer" title={url} className={icon ? 'inline-flex shrink-0 rounded-sm border border-ink-700 p-1 hover:border-ink-400 hover:bg-ink-700' : 'inline-block min-h-6 truncate leading-6 text-orbit hover:underline'} onClick={(ev) => ev.stopPropagation()}>
              {icon ? <Icon name={icon} className="size-4 text-ink-200" /> : url.replace(/^https?:\/\//, '')}
            </a>
          )
        })}
      </span>
    )
  }
  if (def?.type === 'datetime' && typeof v === 'string') return <span className="text-[13px] text-ink-300 tabular-nums">{ago(v)}</span>
  if (def?.type === 'trend' && isTrend(v)) return <TrendCell value={v} />
  if (def?.type === 'openapi' && isSpec(v)) return <span className="text-ink-200">{specSummary(v)}</span>
  if (def?.type === 'healthcheck' && v && typeof v === 'object') return <span className="font-mono text-[12px] text-ink-300">{(v as { url?: string }).url?.replace(/^https?:\/\//, '')}</span>
  if (Array.isArray(v) && v.every((x) => typeof x === 'string') && (def?.type === 'enum' || def?.type === 'array'))
    return (
      <span className="flex gap-1 overflow-hidden whitespace-nowrap">
        {(v as string[]).slice(0, SHOWN).map((x) => (
          <Chip key={x} value={x} def={def} />
        ))}
        {v.length > SHOWN && <span className="shrink-0 font-mono text-[12px] text-ink-500">+{v.length - SHOWN}</span>}
      </span>
    )
  if (typeof v === 'number') {
    const money = currencyOf(def)
    if (money) return <span className="font-mono text-[12px]" title={String(v)}>{formatCurrency(v, money)}</span>
    return <span className="font-mono text-[12px]">{Number.isInteger(v) ? v : v.toFixed(2)}</span>
  }
  return <span>{short(v)}</span>
}

function ScorecardCell({ e, scorecard }: { e: Entity; scorecard: string }) {
  const cards = useScorecards()
  const sc = cards.data?.scorecards.find((s) => s.id === scorecard)
  if (!sc) return null
  // The hub scores every entity it sends; scoring here again is for an entity that came without levels.
  const row = e.levels ? null : scoreEntity(sc, e)
  const got = e.levels ? e.levels[sc.id] : row && reached(sc, row)
  // Out of the scorecard's scope: it has no level, and says so.
  if (!got) return <span className="font-mono text-[12px] text-ink-500" title="Outside this scorecard's scope: not scored">n/a</span>
  const name = got.at(-1) ?? NONE
  // Levels take colours in their order, and no level is grey.
  return <Chip value={name} def={{ type: 'enum', values: sc.levels.map((l) => l.name), colors: { none: 'grey' } }} />
}

function RuleCell({ e, id }: { e: Entity; id: string }) {
  const cards = useScorecards()
  const [scorecard, rule] = id.split('.')
  const sc = cards.data?.scorecards.find((s) => s.id === scorecard)
  const r = sc && partFor(sc, e.blueprint)?.levels.flatMap((l) => l.rules).find((x) => x.id === rule)
  if (!sc || !r) return null
  if (e.levels ? !e.levels[sc.id] : !inScope(sc, e)) return <span className="font-mono text-[12px] text-ink-500" title="Outside this scorecard's scope: not scored">n/a</span>
  const ok = matches(e, r.where)
  return <span className={`font-mono text-[12px] ${ok ? 'text-green' : 'text-red'}`}>{ok ? '✓' : '✗'}</span>
}

function cellTitle(e: Entity, col: Column): string {
  if (col.kind === 'field') {
    const v = e.fields[col.id.slice(2)]
    const money = currencyOf(col.def)
    return typeof v === 'number' && money ? formatCurrency(v, money) : short(v, 500)
  }
  if (col.id === 'status') return humanTimes(e.status.reasons.join('\n'))
  return ''
}

/** An identifier made from a title: lowercase words joined by dashes. */
function slug(title: string): string {
  return title.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

/** A new entity from a title. The identifier follows the title until someone types their own. */
function Create({ bp, onDone }: { bp: Blueprint; onDone: () => void }) {
  const blueprintName = useBlueprintName()
  const create = useCreateEntity()
  const [title, setTitle] = useState('')
  const [typedKey, setTypedKey] = useState<string | null>(null)
  const [icon, setIcon] = useState<string | null>(null)
  const [picking, setPicking] = useState<HTMLElement | null>(null)
  // A blueprint that holds a specification can be filled in from one.
  const takesSpec = Object.values(bp.fields).some((f) => f.type === 'openapi')
  const [filled, setFilled] = useState<{ file: string; fields: Record<string, unknown> } | null>(null)
  const [specError, setSpecError] = useState<string | null>(null)
  const key = (typedKey ?? slug(title)).trim()
  useEscape(onDone, useChanged([title, typedKey, icon, filled]))
  return (
    <Panel className="px-4 py-3">
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          create.mutate({ blueprint: bp.id, key, title: title.trim() || key, ...(icon ? { icon } : {}), ...(filled ? { fields: filled.fields } : {}) }, { onSuccess: onDone })
        }}
      >
        <div>
          <Kicker>Icon</Kicker>
          <button type="button" className={`${input} mt-1 flex h-[30px] items-center`} title="Give it its own icon, or leave the blueprint's" onClick={(ev) => setPicking(ev.currentTarget)}>
            <Icon name={icon ?? bp.icon} className="size-4 text-ink-200" />
          </button>
        </div>
        <label className="block min-w-0 flex-1 md:flex-none">
          <Kicker>Title</Kicker>
          <input className={`${input} mt-1 w-full md:w-72`} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Human name" autoFocus required />
        </label>
        <label className="block w-full md:w-auto">
          <Kicker>Identifier</Kicker>
          <input className={`${input} mt-1 w-full font-mono md:w-56`} value={key} onChange={(e) => setTypedKey(e.target.value)} placeholder="stable-id" required />
        </label>
        <Button type="submit" kind="solid" disabled={create.isPending || !key}>
          Create {blueprintName(bp)}
        </Button>
        <Button onClick={onDone}>Cancel</Button>
        {takesSpec && (
          <label className="cursor-pointer btn btn-ghost focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-orbit hover:border-ink-300" title="Fill this in from an OpenAPI or Swagger document, JSON or YAML. You can change anything afterwards.">
            {filled ? `From ${filled.file}` : 'From a specification'}
            <input
              type="file"
              accept=".json,.yaml,.yml,application/json"
              className="sr-only"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (!file) return
                readSpec(file).then(
                  (doc) => {
                    const found = prefill(doc, bp)
                    setFilled({ file: file.name, fields: found.fields })
                    setSpecError(null)
                    if (found.title && !title) setTitle(found.title)
                  },
                  (reason: Error) => setSpecError(reason.message),
                )
              }}
            />
          </label>
        )}
        <ErrorNote error={specError ?? create.error} />
      </form>
      {picking && <IconPicker anchor={picking} value={icon ?? bp.icon} onPick={(name) => (setIcon(name), setPicking(null))} resets={icon ? [{ label: "Back to the blueprint's icon", run: () => (setIcon(null), setPicking(null)) }] : []} onClose={() => setPicking(null)} />}
    </Panel>
  )
}

/** Adds a field to the blueprint straight from the table, like adding a column. */
function AddProperty({ bp, onDone }: { bp: Blueprint; onDone: () => void }) {
  const save = useSaveBlueprint()
  const [name, setName] = useState('')
  const [type, setType] = useState<FieldDef['type']>('string')
  const [title, setTitle] = useState('')
  useEscape(onDone, useChanged([name, type, title]))
  const locked = isLocked(bp.origin)
  const ok = NAME.test(name) && !(name in bp.fields) && name !== 'title'
  return (
    <Panel className="px-4 py-3">
      {locked ? (
        <div className="text-sm text-ink-300">{bp.origin.kind === 'git' ? `This blueprint lives in git (${bp.origin.file}). Add the field there.` : "This blueprint is the hub's own and takes no new fields."}</div>
      ) : (
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            save.mutate({ id: bp.id, spec: { ...specOf(bp), fields: { ...bp.fields, [name]: { type, title: title || undefined } } } }, { onSuccess: onDone })
          }}
        >
          <label className="block min-w-0 flex-1 md:flex-none">
            <Kicker>Property</Kicker>
            <input className={`${input} mt-1 w-full font-mono md:w-48`} value={name} onChange={(e) => setName(e.target.value)} placeholder="field_name" autoFocus />
          </label>
          <label className="block">
            <Kicker>Type</Kicker>
            <select className={`${input} mt-1`} value={type} onChange={(e) => setType(e.target.value as FieldDef['type'])}>
              {FIELD_TYPES.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </label>
          <label className="block w-full md:w-auto">
            <Kicker>Title</Kicker>
            <input className={`${input} mt-1 w-full md:w-56`} value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <Button type="submit" kind="solid" disabled={!ok || save.isPending}>
            Add property
          </Button>
          <Button onClick={onDone}>Cancel</Button>
          <ErrorNote error={save.error} />
        </form>
      )}
    </Panel>
  )
}

/** A related entity this person may not see. */
/**
 * An entity a relation points at, as a link in the colour its column's distribution bar gives it: the colour
 * is the target's id run through the same palette as every chip, so each target looks the same in every row.
 * It takes the width its column gives it and is cut short only when the column is narrower than its name.
 */
/** A thing a row points at: plain, since which thing it is says nothing a colour should. */
/** A link to what a cell names. A person carries their picture, which the hub lays on where a block is read. */
function TargetChip({ target, hint }: { target: EntityRef & { title?: string; icon?: string | null }; hint?: string }) {
  return (
    <Link
      to={{ page: 'entity', blueprint: target.blueprint, key: target.key }}
      className="inline-flex min-w-0 shrink items-center gap-1 rounded-md border border-ink-700 bg-ink-850 px-1.5 py-1 text-[12px] leading-4 text-ink-100 hover:border-ink-500"
      title={hint ?? target.key}
    >
      {target.icon && <Icon name={target.icon} className="size-3.5 shrink-0 text-ink-400" />}
      <span className="truncate">{target.title ?? target.key.split('/').pop()}</span>
    </Link>
  )
}

