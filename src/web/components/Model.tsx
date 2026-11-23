import { applyNodeChanges, Background, BaseEdge, ControlButton, Controls, Handle, MarkerType, MiniMap, Position, ReactFlow, ReactFlowProvider, useReactFlow, type Connection, type Edge, type EdgeProps, type Node, type NodeChange, type NodeProps, type Viewport } from '@xyflow/react'
import { ArrowRight, ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, Eye, EyeOff, Import, Info, Lock, Maximize, Minus, MoreHorizontal, Pencil, Plus, Search, Table2, Trash2, Workflow } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { blueprintNamer, isLocked, type Blueprint } from '../../shared/model.ts'
import { compact, expand, MODEL_H, MODEL_ROW, MODEL_W, squeeze, squeezed, unsqueezed, type Point, type Rect, type Size, type Squeeze } from '../../shared/layout.ts'
import { useBlueprintName, useBlueprints, useIsAdmin, useModelLayout, usePlaceModel, useSaveBlueprint, useSaveModelLayout, useCan } from '../api.ts'
import { Drawer } from './Drawer.tsx'
import { BlueprintIcon, grouped } from '../icons.tsx'
import { navigate, useLeaveGuard } from '../router.ts'
import { AlertRulesPanel, RulesPanel } from './Blueprints.tsx'
import { MenuItem, Popover } from './Popover.tsx'
import { FieldPopover, specOf } from './FieldForm.tsx'
import { cameraProps, DURATION, LINE, LINE_LIT, useCamera, useFlyTo, useTier, ZOOM_STEP, type Tier } from './graph.ts'
import { Grid } from './Inventory.tsx'
import { TypePill } from './FieldType.tsx'
import { Badge, ErrorNote, input, Kicker, Link, Panel, useNarrow } from './ui.tsx'
import { ModelWalk } from './ModelWalk.tsx'
import { BlueprintEditor, ImportPanel, lockOf, ORIGIN_LABEL, RelationPopover } from './BlueprintEditor.tsx'
import { GroupHeading, useFolds } from './GroupHeading.tsx'
import { useVisit } from '../trail.ts'

/** A row on a card's field table: a field or a relation, by name. */
type CardRow = { kind: 'field' | 'relation'; name: string }

/** What a card is told. `locked` says why its fields cannot be changed here, null when they can. */
type BpNodeData = { bp: Blueprint; blueprints: Record<string, Blueprint>; editing: boolean; count: number; expanded: boolean; tier: Tier; dim: boolean; locked: string | null; onToggle: () => void; onRow: (row: CardRow, anchor: HTMLElement) => void; onAdd: (kind: CardRow['kind'], anchor: HTMLElement) => void }
type BpNode = Node<BpNodeData, 'blueprint'>

const NO_COUNTS: Record<string, number> = {}
const NO_POSITIONS: Record<string, Point> = {}

/**
 * A reader's own view of the model, laid over the shared layout for as long as
 * they stay on the page: what they show and hide (null follows the shared
 * list), and where they put cards, in stored points.
 */
type Draft = { hidden: string[] | null; positions: Record<string, Point> }
const FOLLOWS: Draft = { hidden: null, positions: {} }

/** The data model: every blueprint, its fields, and the relations between them. Where blueprints are built. `focus` is a blueprint to open on the graph. */
export function ModelPage({ id, focus }: { id: string | null; focus: string | null }) {
  // A phone walks the model one blueprint at a time instead of drawing the graph.
  const narrow = useNarrow()
  if (narrow) return <ModelWalk id={id ?? focus} />
  return (
    <ReactFlowProvider>
      <h1 className="sr-only">Model</h1>
      <Inner id={id} focus={focus} />
    </ReactFlowProvider>
  )
}

function Inner({ id, focus: arriveAt }: { id: string | null; focus: string | null }) {
  const blueprints = useBlueprints()
  const blueprintName = useBlueprintName()
  const stored = useModelLayout()
  const saveLayout = useSaveModelLayout()
  const canAuthor = useCan('model.edit')
  const flow = useReactFlow<BpNode, Edge>()
  const tier = useTier()
  const list = useMemo(() => blueprints.data?.blueprints ?? [], [blueprints.data])
  const byId = useMemo(() => Object.fromEntries(list.map((b) => [b.id, b])), [list])
  const counts = blueprints.data?.counts ?? NO_COUNTS
  const [search, setSearch] = useVisit('model.search', '')
  const [find, setFind] = useVisit('model.find', '')
  const folds = useFolds()
  const [expanded, setExpanded] = useVisit<Set<string>>('model.expanded', new Set())
  const [mode3, setMode3] = useVisit<'graph' | 'cards' | 'rules'>('model.mode', 'graph')
  const [editing, setEditing] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [importing, setImporting] = useState(false)
  // A row's menu on a card, and the popover that changes or adds one field or relation there.
  const [rowMenu, setRowMenu] = useState<{ bpId: string; row: CardRow; anchor: HTMLElement } | null>(null)
  const [cardEdit, setCardEdit] = useState<{ bpId: string; kind: CardRow['kind']; name: string | null; target: string; anchor: HTMLElement } | null>(null)
  const saveBp = useSaveBlueprint()
  const admin = useIsAdmin()
  const adminOnly = blueprints.data?.adminOnly
  const [filterOpen, setFilterOpen] = useState(false)
  // The show and hide list, grouped and sorted as it stood when it opened. A click flips a row's eye where it is, so the list never jumps under the pointer.
  const [filterRows, setFilterRows] = useState<{ id: string; hidden: boolean }[]>([])
  // A card's menu, hung under the card. The pointer opens it with a right-click, the keyboard with Shift+F10 or the menu key on a focused card.
  const [menu, setMenu] = useState<{ id: string; anchor: HTMLElement } | null>(null)
  const menuFor = (bpId: string) => {
    const anchor = graphRef.current?.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(bpId)}"]`)
    if (anchor) setMenu({ id: bpId, anchor })
  }
  // Whether the open editor holds changes not saved. Anything that would close or swap it asks first.
  const unsaved = useRef(false)
  const onDirty = useCallback((dirty: boolean) => {
    unsaved.current = dirty
  }, [])
  const leave = (): boolean => !unsaved.current || confirm('Discard the changes you have not saved to this blueprint?')
  // Only a model author saves the reader's own view for everyone.
  const [draft, setDraft] = useState<Draft>(FOLLOWS)
  const place = usePlaceModel()
  const open = (bpId: string) => {
    if (bpId === editing && !creating) return
    if (!leave()) return
    setEditing(bpId)
    setCreating(false)
  }
  // A change made on a card saves at once, so the open editor's unsaved draft of the same blueprint goes first.
  const mine = (bpId: string): boolean => bpId !== editing || creating || leave()
  const locks = useMemo(() => Object.fromEntries(list.map((b) => [b.id, lockOf(b, canAuthor, !admin && (adminOnly ?? []).includes(b.id))])), [list, canAuthor, admin, adminOnly])
  const onRow = useCallback((bpId: string, row: CardRow, anchor: HTMLElement) => setRowMenu({ bpId, row, anchor }), [])
  const onAdd = useCallback((bpId: string, kind: CardRow['kind'], anchor: HTMLElement) => setCardEdit({ bpId, kind, name: null, target: '', anchor }), [])
  const drop = (bp: Blueprint, row: CardRow) => {
    const what = row.kind === 'field' ? `the property ${bp.fields[row.name]?.title ?? row.name}? Its values are kept, but no view shows them.` : `the relation ${row.name} from ${blueprintName(bp)}?`
    if (!mine(bp.id) || !confirm(`Delete ${what}`)) return
    const key = row.kind === 'field' ? 'fields' : 'relations'
    const { [row.name]: _gone, ...rest } = bp[key]
    saveBp.mutate({ id: bp.id, spec: { ...specOf(bp), [key]: rest } })
  }
  const browsing = list.find((b) => b.id === id) ?? null
  const editingBp = list.find((b) => b.id === editing) ?? null
  const storedPositions = stored.data?.positions ?? NO_POSITIONS
  const positions = useMemo(() => (Object.keys(draft.positions).length ? { ...storedPositions, ...draft.positions } : storedPositions), [storedPositions, draft.positions])
  const hidden = useMemo(() => new Set(draft.hidden ?? stored.data?.hidden ?? []), [draft.hidden, stored.data])
  const curated = useMemo(() => new Set(stored.data?.hidden ?? []), [stored.data])
  const hiddenChanged = hidden.size !== curated.size || [...hidden].some((x) => !curated.has(x))
  const shifted = Object.entries(draft.positions).filter(([bpId, p]) => storedPositions[bpId]?.x !== p.x || storedPositions[bpId]?.y !== p.y)
  const changed = hiddenChanged || shifted.length > 0
  useLeaveGuard((to) => {
    if (to?.page === 'model') return null
    if (unsaved.current) return 'Discard the changes you have not saved to this blueprint?'
    return canAuthor && changed ? 'Discard how you changed the model view? It is not saved for everyone.' : null
  })
  const saveView = () =>
    saveLayout.mutate({ ...(hiddenChanged ? { hidden: [...hidden] } : {}), ...(shifted.length ? { positions: Object.fromEntries(shifted) } : {}) }, { onSuccess: () => setDraft(FOLLOWS) })
  const placeAt = (at: Record<string, Point>) => setDraft((d) => ({ ...d, positions: { ...d.positions, ...at } }))
  const shown = useMemo(() => list.filter((b) => !hidden.has(b.id) && positions[b.id]), [list, hidden, positions])
  const toggle = useCallback((bpId: string) => setExpanded((cur) => {
    const next = new Set(cur)
    if (next.has(bpId)) next.delete(bpId)
    else next.add(bpId)
    return next
  }), [])
  const arranged = useMemo(() => arrange(shown, list, positions, expanded), [shown, list, positions, expanded])
  // The card being edited and the blueprints one line away from it: what it points at and what points at it.
  const focus = useMemo(() => (editing && arranged.rects[editing] ? neighbours(editing, arranged.edges) : null), [editing, arranged])
  const built = useMemo(() => build(arranged, shown, counts, { blueprints: byId, tier, focus, expanded, editing, locks, onToggle: toggle, onRow, onAdd }), [arranged, shown, counts, byId, tier, focus, expanded, editing, locks, toggle, onRow, onAdd])
  const [nodes, setNodes] = useState<BpNode[]>(built.nodes)
  const dragging = useRef(false)
  // React Flow keeps which cards are selected, for a drag of several; a rebuild keeps them selected.
  useEffect(() => {
    if (!dragging.current) setNodes((cur) => {
      const picked = new Set(cur.filter((n) => n.selected).map((n) => n.id))
      return built.nodes.map((n) => (picked.has(n.id) ? { ...n, selected: true } : n))
    })
  }, [built.nodes])
  const graphRef = useRef<HTMLDivElement>(null)
  const cam = useCamera(graphRef)
  // A rearrangement shows the whole model once its cards have landed in their new places.
  const refit = useRef(false)
  useEffect(() => {
    if (!refit.current) return
    refit.current = false
    const t = setTimeout(cam.fit, 60)
    return () => clearTimeout(t)
  }, [nodes, cam])
  // A rearrangement lays out what this reader shows, in their own view; a model author saves it like any other change.
  const rearrange = () =>
    (!shifted.length || confirm('Lay out the blueprints shown here again? Where you placed cards is forgotten.')) &&
    place.mutate({ hidden: [...hidden], rearrange: true }, { onSuccess: (r) => ((refit.current = true), setDraft((d) => ({ ...d, positions: r.positions }))) })
  // One card back where the hub would place it beside its neighbours, in this reader's view.
  const placeAgain = (bpId: string) => {
    const { [bpId]: _gone, ...rest } = positions
    place.mutate({ hidden: [...hidden], positions: rest }, { onSuccess: (r) => placeAt(r.positions) })
  }
  const flyTo = useFlyTo()
  // The graph unmounts while the cards or the rules are shown; it comes back where it was.
  const camera = useRef<Viewport | undefined>(undefined)
  // The blueprint the camera last landed on, null for the whole model. A new one, from a link here, flies to it.
  const landed = useRef<string | null | undefined>(undefined)
  const ready = nodes.length > 0
  useEffect(() => {
    if (!ready) return
    const target = arriveAt
    if (landed.current === target) return
    landed.current = target
    const there = !!target && shown.some((b) => b.id === target)
    if (target && list.some((b) => b.id === target)) (setMode3('graph'), open(target), setImporting(false))
    if (there) return flyTo(target)
    // A small model opens whole. A big one opens at a readable size on the kind most joined to others, with its neighbours round it; F shows the whole.
    if (nodes.length > 20) {
      const degree = new Map<string, number>()
      for (const e of built.edges) for (const id of [e.source, e.target]) degree.set(id, (degree.get(id) ?? 0) + 1)
      // The hub is a kind that holds things, so the first view is never centred on an empty one. It opens centred on the hub at a size
      // its cards read at; its neighbours run off round it, and F shows the whole.
      const hub = [...degree].filter(([id]) => (counts[id] ?? 0) > 0).sort((a, b) => b[1] - a[1])[0]?.[0]
      if (hub) {
        const t = setTimeout(() => {
          const node = flow.getNode(hub)
          if (node) void flow.setCenter(node.position.x + (node.measured?.width ?? 0) / 2, node.position.y + (node.measured?.height ?? 0) / 2, { zoom: 0.9, duration: DURATION })
        }, 60)
        return () => clearTimeout(t)
      }
    }
    const t = setTimeout(cam.fit, 60)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- lands once per target, when the graph first has cards
  }, [ready, arriveAt])
  const nodeTypes = useMemo(() => ({ blueprint: BlueprintNodeView }), [])
  const edgeTypes = useMemo(() => ({ loop: LoopEdge }), [])
  const onNodesChange = useCallback((changes: NodeChange<BpNode>[]) => setNodes((cur) => applyNodeChanges(changes, cur)), [])
  const visible = list.filter((b) => !search || blueprintName(b).toLowerCase().includes(search.toLowerCase()) || b.id.includes(search.toLowerCase()))
  const setHidden = (ids: string[]) => setDraft((d) => ({ ...d, hidden: ids }))
  const groupRows = (h: ReadonlySet<string>) =>
    [...list].sort((a, b) => Number(!h.has(a.id)) - Number(!h.has(b.id)) || blueprintName(a).localeCompare(blueprintName(b))).map((b) => ({ id: b.id, hidden: h.has(b.id) }))
  // Show all and Hide all move every row, so the list groups again at once.
  const setAllHidden = (ids: string[]) => (setFilterRows(groupRows(new Set(ids))), setHidden(ids))
  // A blueprint that arrives while the list is open goes at its end.
  const filterList = [...filterRows.filter((r) => byId[r.id]), ...list.filter((b) => !filterRows.some((r) => r.id === b.id)).map((b) => ({ id: b.id, hidden: hidden.has(b.id) }))]
  // A blueprint picked from the list: its editor opens and the graph flies to its card.
  const select = (bpId: string) => {
    if ((bpId !== editing || creating) && !leave()) return
    setEditing(bpId)
    setCreating(false)
    setMode3('graph')
    if (shown.some((b) => b.id === bpId)) flyTo(bpId)
  }
  const seek = (q: string) => {
    setFind(q)
    const needle = q.trim().toLowerCase()
    if (!needle) return
    const hit = shown.find((b) => blueprintName(b).toLowerCase().includes(needle)) ?? shown.find((b) => b.id.includes(needle))
    if (!hit) return
    if (!unsaved.current) open(hit.id)
    flyTo(hit.id)
  }
  const onConnect = (c: Connection) => {
    if (!canAuthor || !c.source || !c.target) return
    const from = list.find((b) => b.id === c.source)
    if (!from) return
    if (from.origin.kind === 'git') {
      alert(`${blueprintName(from)} is defined in git; add the relation in ${from.origin.file}`)
      return
    }
    if (from.origin.kind === 'hub') {
      alert(`${blueprintName(from)} is the hub's own blueprint and takes no relations. Draw the line from the other blueprint instead.`)
      return
    }
    if (locks[from.id]) {
      alert(`${blueprintName(from)}: ${locks[from.id]}.`)
      return
    }
    const anchor = graphRef.current?.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(from.id)}"]`)
    if (anchor && mine(from.id)) setCardEdit({ bpId: from.id, kind: 'relation', name: null, target: c.target, anchor })
  }

  return (
    <div className="flex h-full gap-3 py-3">
      {/* While a panel is open beside the graph, the list steps aside on all but the widest screens, so the graph keeps room to be read. */}
      <aside aria-label="Blueprints" className={`hidden w-64 shrink-0 flex-col rounded-md border border-ink-700 bg-ink-900/70 ${editingBp || creating || importing ? '2xl:flex' : 'lg:flex'}`}>
        <div className="border-b border-ink-800 p-3">
          <div className="flex items-center gap-2">
            <Kicker>Blueprints · {list.length}</Kicker>
            {canAuthor && (
              <span className="ml-auto flex gap-1">
                <button className="rounded-sm border border-ink-600 p-1 text-ink-300 hover:border-ink-300 hover:text-ink-100" title="Import a model: a template the hub offers, or a file of your own" onClick={() => leave() && (setImporting(true), setCreating(false), setEditing(null))}>
                  <Import className="size-3.5" />
                </button>
                <button className="rounded-sm border border-ink-600 p-1 text-ink-300 hover:border-ink-300 hover:text-ink-100" title="New blueprint" onClick={() => leave() && (setCreating(true), setImporting(false), setEditing(null), navigate({ page: 'model', id: null }))}>
                  <Plus className="size-3.5" />
                </button>
              </span>
            )}
          </div>
          <div className="relative mt-2">
            <Search className="absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-ink-500" />
            <input className={`${input} w-full pl-7`} aria-label="Find a blueprint" placeholder="Find a blueprint" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
        </div>
        <nav aria-label="Blueprints" className="min-h-0 flex-1 overflow-y-auto p-2">
          {grouped(visible).map(({ starts, group, item: b }) => (
            <div key={b.id}>
              {starts && <GroupHeading heading={group} />}
            <div className={!search && folds.shut(group) ? 'hidden' : 'contents'}>
            <div className={`group flex items-center rounded-sm ${editing === b.id ? 'bg-ink-800 text-ink-100' : 'text-ink-300 hover:bg-ink-850'}`}>
              <button type="button" onClick={() => select(b.id)} aria-current={editing === b.id ? 'true' : undefined} className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1 text-left text-sm" title={hidden.has(b.id) || !positions[b.id] ? `Open ${b.title}. It is hidden from the graph.` : `Open ${b.title} and fly to it`}>
                <BlueprintIcon bp={b} className="size-3.5 shrink-0 text-ink-400" />
                <span className={`truncate ${hidden.has(b.id) ? 'text-ink-500' : ''}`}>{blueprintName(b)}</span>
                {isLocked(b.origin) && <Lock className="size-3 shrink-0 text-ink-500" aria-label={ORIGIN_LABEL[b.origin.kind]} />}
                <span className="ml-auto text-[12px] text-ink-500 tabular-nums">{counts[b.id] ?? 0}</span>
              </button>
              <Link to={{ page: 'model', id: b.id }} className="px-1.5 py-1 text-ink-500 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100 hover:text-ink-100" title={`Browse what is in ${b.title}`} aria-label={`Browse what is in ${b.title}`}>
                <Table2 className="size-3" />
              </Link>
            </div>
            </div>
            </div>
          ))}
        </nav>
        <div className="m-2 flex rounded-md border border-ink-700 bg-ink-900 p-0.5 text-[12px] font-medium">
          {(['graph', 'cards', 'rules'] as const).map((m) => (
            <button key={m} onClick={() => setMode3(m)} aria-pressed={mode3 === m} className={`flex-1 rounded py-1 capitalize ${mode3 === m ? 'bg-ink-800 text-ink-100' : 'text-ink-400 hover:text-ink-200'}`}>
              {m}
            </button>
          ))}
        </div>
      </aside>
      <div
        ref={graphRef}
        className="graph relative min-w-0 flex-1 overflow-hidden rounded-md border border-ink-700 bg-ink-900/60"
        onKeyDown={(e) => {
          // A focused card: Enter opens it, Shift+F10 or the menu key opens its menu.
          const card = (e.target as HTMLElement).closest<HTMLElement>('.react-flow__node')
          const bpId = card === e.target ? card.dataset.id : undefined
          if (!bpId) return
          if (e.key === 'Enter') (e.preventDefault(), open(bpId))
          else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) (e.preventDefault(), menuFor(bpId))
        }}
      >
        {mode3 === 'graph' ? (
          <>
            <ReactFlow<BpNode, Edge>
              {...cameraProps()}
              defaultViewport={camera.current}
              onMoveEnd={(_e, v) => {
                camera.current = v
              }}
              nodes={nodes}
              edges={built.edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              onNodesChange={onNodesChange}
              onNodeClick={(_e, n) => open(n.id)}
              onNodeDoubleClick={(_e, n) => flyTo(n.id)}
              onNodeDragStart={() => {
                dragging.current = true
              }}
              onNodeDragStop={(_e, node, moved) => {
                dragging.current = false
                const dragged = moved.length ? moved : [node]
                placeAt(Object.fromEntries(dragged.map((n) => [n.id, unsqueezed(expand(n.id, n.position, { w: MODEL_W, h: MODEL_H }, arranged.rects, arranged.shown), arranged.squeeze)])))
              }}
              onNodeContextMenu={(e, n) => {
                e.preventDefault()
                menuFor(n.id)
              }}
              onPaneClick={() => (setMenu(null), editing && leave() && setEditing(null))}
              onConnect={onConnect}
              nodesConnectable={canAuthor}
              snapToGrid
              snapGrid={[8, 8]}
              connectionLineStyle={{ stroke: LINE_LIT, strokeWidth: 1.5 }}
            >
              <Background gap={24} size={1} color="var(--color-grid)" />
              <Controls showInteractive={false} showZoom={false} showFitView={false} position="bottom-left">
                <ControlButton onClick={() => cam.zoomBy(ZOOM_STEP)} title="Zoom in (+)" aria-label="Zoom in">
                  <Plus />
                </ControlButton>
                <ControlButton onClick={() => cam.zoomBy(1 / ZOOM_STEP)} title="Zoom out (-)" aria-label="Zoom out">
                  <Minus />
                </ControlButton>
                <ControlButton onClick={cam.fit} title="Show the whole model (F)" aria-label="Show the whole model">
                  <Maximize />
                </ControlButton>
                <ControlButton onClick={() => setExpanded(expanded.size ? new Set() : new Set(shown.map((b) => b.id)))} title={expanded.size ? "Hide every card's fields" : "Show every card's fields"} aria-label={expanded.size ? "Hide every card's fields" : "Show every card's fields"}>
                  {expanded.size ? <ChevronsDownUp /> : <ChevronsUpDown />}
                </ControlButton>
              </Controls>
              <MiniMap pannable zoomable ariaLabel="Overview of the model" nodeColor={(n) => (n.id === editing ? 'var(--color-edit)' : 'var(--color-ink-500)')} nodeStrokeWidth={0} position="bottom-right" />
            </ReactFlow>
            <div className="pointer-events-none absolute inset-x-3 top-3 flex flex-wrap items-start gap-2 *:pointer-events-auto">
              <div className="relative shrink-0">
                <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-ink-500" />
                <input className={`${input} w-56 pl-7`} aria-label="Find and fly to" placeholder="Find and fly to" value={find} onChange={(e) => seek(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && seek(find)} />
              </div>
              <span className="hidden min-w-0 flex-1 pt-1.5 text-[12px] text-ink-400 2xl:block">{`Scroll or pinch to zoom, drag to pan, F for the whole model. Click a card to open it and light its neighbours. Double-click to fly to it. Right-click or Shift+F10 for more. Drag cards to arrange your own view; Shift and drag to pick several.${canAuthor ? " Drag from a card's right dot to relate it." : ''}`}</span>
            <div className="ml-auto flex shrink-0 gap-2">
              {changed && (
                <button onClick={() => setDraft(FOLLOWS)} disabled={saveLayout.isPending} title="Show the model as everyone sees it" className="btn btn-ghost bg-ink-850">
                  Reset
                </button>
              )}
              {canAuthor && changed && (
                <button onClick={saveView} disabled={saveLayout.isPending} title="Make this view the one everyone sees" className="btn btn-solid">
                  Save for everyone
                </button>
              )}
              <button onClick={rearrange} disabled={place.isPending} title="Lay out the blueprints shown here again, from scratch, in your view" className="btn btn-ghost bg-ink-850">
                <Workflow className="size-3.5" aria-hidden /> Rearrange
              </button>
            </div>
            <div className="relative w-72 min-w-44 max-w-full shrink">
              <button onClick={() => (filterOpen || setFilterRows(groupRows(hidden)), setFilterOpen(!filterOpen))} className="flex w-full items-center gap-2 rounded-md border border-ink-600 bg-ink-850 px-3 py-1.5 text-sm text-ink-200 hover:border-ink-400">
                <span className="flex-1 text-left">
                  Showing {shown.length} of {list.length}
                </span>
                {hidden.size > 0 ? <EyeOff className="size-3.5 text-ink-400" /> : <Eye className="size-3.5 text-ink-400" />}
              </button>
              {filterOpen && (
                <Panel className="mt-1 max-h-[60vh] overflow-y-auto py-1">
                  <div className="flex gap-2 border-b border-ink-800 px-3 py-1.5">
                    <button className="text-[12px] font-medium text-ink-300 hover:text-ink-100" onClick={() => setAllHidden([])}>Show all</button>
                    <button className="text-[12px] font-medium text-ink-300 hover:text-ink-100" onClick={() => setAllHidden(list.map((b) => b.id))}>Hide all</button>
                  </div>
                  {filterList.map((row, i, arr) => {
                    const b = byId[row.id]!
                    return (
                      <div key={b.id}>
                        {(i === 0 || arr[i - 1]!.hidden !== row.hidden) && <Kicker className="px-3 pt-2 pb-1">{row.hidden ? 'Hidden' : 'Shown'}</Kicker>}
                        <button onClick={() => setHidden(hidden.has(b.id) ? [...hidden].filter((x) => x !== b.id) : [...hidden, b.id])} className="flex w-full items-center gap-2 px-3 py-1 text-left text-sm hover:bg-ink-800">
                          <BlueprintIcon bp={b} className="size-3.5 text-ink-400" />
                          <span className={`flex-1 truncate ${hidden.has(b.id) ? 'text-ink-500' : ''}`}>{blueprintName(b)}</span>
                          {hidden.has(b.id) ? <EyeOff className="size-3.5 text-ink-500" /> : <Eye className="size-3.5 text-ink-400" />}
                        </button>
                      </div>
                    )
                  })}
                  {!canAuthor && <div className="border-t border-ink-800 px-3 py-2 text-[12px] text-ink-500">What you show, hide, and move lasts until you leave this page.</div>}
                </Panel>
              )}
            </div>
            </div>
            {menu && (
              <Popover anchor={menu.anchor} onClose={() => setMenu(null)} width={208} menu label={blueprintName(menu.id)} className="py-1">
                <MenuItem onClick={() => (setMenu(null), navigate({ page: 'model', id: menu.id }))}>Browse its catalog</MenuItem>
                <MenuItem onClick={() => (setMenu(null), open(menu.id))}>{isLocked(list.find((b) => b.id === menu.id)?.origin ?? { kind: 'ui' }) ? 'View blueprint' : 'Edit blueprint'}</MenuItem>
                <MenuItem onClick={() => (setMenu(null), toggle(menu.id))}>{expanded.has(menu.id) ? 'Hide fields' : 'Show fields'}</MenuItem>
                <div className="my-1 border-t border-ink-700" role="separator" />
                <MenuItem onClick={() => (setMenu(null), placeAgain(menu.id))}>Place it again</MenuItem>
                <MenuItem onClick={() => (setMenu(null), setHidden([...hidden, menu.id]))}>Hide from the model</MenuItem>
              </Popover>
            )}
            {rowMenu &&
              (() => {
                const bp = list.find((b) => b.id === rowMenu.bpId)
                if (!bp) return null
                const { row } = rowMenu
                const target = row.kind === 'relation' ? list.find((b) => b.id === bp.relations[row.name]?.target) : undefined
                const close = () => setRowMenu(null)
                return (
                  <Popover anchor={rowMenu.anchor} onClose={close} width={208} menu label={`${blueprintName(bp)} ${row.name}`} className="py-1">
                    <MenuItem onClick={() => (close(), mine(bp.id) && setCardEdit({ bpId: bp.id, kind: row.kind, name: row.name, target: '', anchor: rowMenu.anchor }))}>
                      <Pencil className="size-3.5 text-ink-400" /> {row.kind === 'field' ? 'Edit property' : 'Edit relation'}
                    </MenuItem>
                    {target && shown.some((b) => b.id === target.id) && (
                      <MenuItem onClick={() => (close(), select(target.id))}>
                        <ArrowRight className="size-3.5 text-ink-400" /> Go to {blueprintName(target)}
                      </MenuItem>
                    )}
                    <MenuItem danger onClick={() => (close(), drop(bp, row))}>
                      <Trash2 className="size-3.5" /> {row.kind === 'field' ? 'Delete property' : 'Delete relation'}
                    </MenuItem>
                  </Popover>
                )
              })()}
            {cardEdit &&
              (() => {
                const bp = list.find((b) => b.id === cardEdit.bpId)
                if (!bp) return null
                const close = () => setCardEdit(null)
                return cardEdit.kind === 'field' ? (
                  <FieldPopover bp={bp} name={cardEdit.name} anchor={cardEdit.anchor} onClose={close} />
                ) : (
                  <RelationPopover bp={bp} all={list} name={cardEdit.name} target={cardEdit.target || (list.find((b) => b.id !== bp.id) ?? bp).id} anchor={cardEdit.anchor} onClose={close} />
                )
              })()}
          </>
        ) : mode3 === 'cards' ? (
          <div className="grid h-full content-start gap-3 overflow-y-auto p-4 sm:grid-cols-2 xl:grid-cols-3">
            {visible.map((b) => (
              <button key={b.id} onClick={() => open(b.id)} className={`rounded-md border p-3 text-left ${editing === b.id ? 'border-ink-300' : 'border-ink-700 hover:border-ink-500'} bg-ink-900/70`}>
                <div className="flex items-center gap-2">
                  <BlueprintIcon bp={b} className="size-4 text-ink-300" />
                  <span className="font-medium">{blueprintName(b)}</span>
                  <span className="ml-auto text-[12px] text-ink-500 tabular-nums">{counts[b.id] ?? 0}</span>
                </div>
                <p className="mt-1 line-clamp-2 text-[12px] text-ink-400">{b.description}</p>
                <div className="mt-2 flex flex-wrap gap-1">
                  {Object.entries(b.fields).slice(0, 14).map(([k, f]) => (
                    <Badge key={k} className="border-ink-700 text-ink-300" title={`${f.type}${f.description ? `: ${f.description}` : ''}`}>
                      {k}
                    </Badge>
                  ))}
                  {Object.keys(b.fields).length > 14 && <Badge className="border-ink-700 text-ink-500">+{Object.keys(b.fields).length - 14}</Badge>}
                  {Object.entries(b.relations).map(([k, r]) => (
                    <Badge key={k} className="border-orbit/40 text-orbit">
                      {k} → {r.target}
                    </Badge>
                  ))}
                </div>
              </button>
            ))}
          </div>
        ) : (
          <div className="h-full space-y-4 overflow-y-auto p-4">
            <RulesPanel canAuthor={canAuthor} blueprints={list} />
            <AlertRulesPanel canAuthor={canAuthor} blueprints={list} />
          </div>
        )}
        <ErrorNote error={saveLayout.error ?? saveBp.error} />
      </div>
      {browsing && (
        <Drawer title={blueprintName(browsing)} subtitle={browsing.description} icon={<BlueprintIcon bp={browsing} className="size-5 text-ink-300" />} width={1200} onClose={() => navigate({ page: 'model', id: null, focus: browsing.id })}>
          <div className="h-full p-4">
            <Grid key={browsing.id} bp={browsing} embedded />
          </div>
        </Drawer>
      )}
      {importing && !editingBp && !creating && (
        <aside aria-label="Import a model" className="w-[480px] shrink-0 overflow-y-auto rounded-lg border border-ink-700 bg-ink-900/70">
          <ImportPanel onClose={() => setImporting(false)} />
        </aside>
      )}
      {(editingBp || creating) && (
        <aside aria-label="Blueprint" className="w-[520px] shrink-0 overflow-y-auto rounded-lg border border-ink-700 bg-ink-900/70">
          {/* A save from a card gives the blueprint a new time, and the editor starts again from what was saved. */}
          <BlueprintEditor key={editingBp ? `${editingBp.id}:${editingBp.updatedAt}` : 'new'} bp={editingBp} all={list} canAuthor={canAuthor} count={editingBp ? (counts[editingBp.id] ?? 0) : 0} onDirty={onDirty} onSaved={(savedId) => (setCreating(false), setEditing(savedId))} onClose={() => leave() && (setCreating(false), setEditing(null))} />
        </aside>
      )}
    </div>
  )
}

/**
 * The height of a card with its field table open: its header; a heading, a row
 * for the title, and a row per field; a heading and a row per relation, when it
 * has any; and the footer. The borders and padding are the 15.
 */
const openHeight = (b: Blueprint) => {
  const relations = Object.keys(b.relations).length
  return MODEL_H + 15 + (2 + Object.keys(b.fields).length + (relations ? relations + 1 : 0) + 1) * MODEL_ROW
}

/** A blueprint and every blueprint one line away from it, either way. */
export function neighbours(id: string, edges: { from: string; to: string }[]): Set<string> {
  const out = new Set([id])
  for (const e of edges) {
    if (e.from === id) out.add(e.to)
    if (e.to === id) out.add(e.from)
  }
  return out
}

/**
 * The shown cards' rects with the room hidden cards left closed up (`squeeze`,
 * undone when a card is dropped), shown positions for the cards that are
 * open, and the lines between the shown blueprints: one per relation, and a
 * bridge where one shown blueprint reaches another only through hidden ones.
 */
interface Arranged {
  squeeze: Squeeze
  rects: Record<string, Rect>
  shown: Record<string, Size>
  at: Record<string, Point>
  edges: { from: string; to: string; title: string; contain: boolean; bridge: boolean }[]
}

export function arrange(shown: Blueprint[], all: Blueprint[], positions: Record<string, Point>, expanded: Set<string>): Arranged {
  const ids = new Set(shown.map((b) => b.id))
  const stored = (id: string): Rect => ({ ...positions[id]!, w: MODEL_W, h: MODEL_H })
  const sq = squeeze(shown.map((b) => stored(b.id)), all.filter((b) => !ids.has(b.id) && positions[b.id]).map((b) => stored(b.id)))
  const rects = Object.fromEntries(shown.map((b) => [b.id, { ...squeezed(positions[b.id]!, sq), w: MODEL_W, h: MODEL_H }]))
  const open = Object.fromEntries(shown.filter((b) => expanded.has(b.id)).map((b) => [b.id, { w: MODEL_W, h: openHeight(b) }]))
  const at = compact(rects, open)
  const edges: Arranged['edges'] = shown.flatMap((b) => Object.entries(b.relations).filter(([, r]) => ids.has(r.target)).map(([name, r]) => ({ from: b.id, to: r.target, title: r.title ?? name, contain: r.display === 'contain', bridge: false })))
  const byId = new Map(all.map((b) => [b.id, b]))
  const named = blueprintNamer(all)
  const direct = new Set(edges.map((e) => `${e.from}>${e.to}`))
  for (const b of shown) {
    // Walk out through hidden blueprints only, nearest first; the first path to each shown one is the one the bridge names.
    const queue = Object.values(b.relations).filter((r) => !ids.has(r.target) && byId.has(r.target)).map((r) => [r.target])
    const seen = new Set(queue.map((path) => path[0]!))
    const reached = new Set<string>()
    while (queue.length) {
      const path = queue.shift()!
      for (const r of Object.values(byId.get(path.at(-1)!)!.relations)) {
        if (ids.has(r.target)) {
          if (r.target === b.id || reached.has(r.target) || direct.has(`${b.id}>${r.target}`)) continue
          reached.add(r.target)
          edges.push({ from: b.id, to: r.target, title: `via ${path.map((id) => named(id)).join(', ')}`, contain: false, bridge: true })
        } else if (byId.has(r.target) && !seen.has(r.target)) {
          seen.add(r.target)
          queue.push([...path, r.target])
        }
      }
    }
  }
  return { squeeze: sq, rects, shown: open, at, edges }
}

function build(a: Arranged, shown: Blueprint[], counts: Record<string, number>, ctx: { blueprints: Record<string, Blueprint>; tier: Tier; focus: Set<string> | null; expanded: Set<string>; editing: string | null; locks: Record<string, string | null>; onToggle: (id: string) => void; onRow: (id: string, row: CardRow, anchor: HTMLElement) => void; onAdd: (id: string, kind: CardRow['kind'], anchor: HTMLElement) => void }): { nodes: BpNode[]; edges: Edge[] } {
  const nodes: BpNode[] = shown.map((b) => ({
    id: b.id,
    type: 'blueprint',
    position: a.at[b.id]!,
    style: { width: MODEL_W },
    data: { bp: b, blueprints: ctx.blueprints, editing: ctx.editing === b.id, count: counts[b.id] ?? 0, expanded: ctx.expanded.has(b.id), tier: ctx.tier, dim: !!ctx.focus && !ctx.focus.has(b.id), locked: ctx.locks[b.id] ?? null, onToggle: () => ctx.onToggle(b.id), onRow: (row, anchor) => ctx.onRow(b.id, row, anchor), onAdd: (kind, anchor) => ctx.onAdd(b.id, kind, anchor) },
  }))
  // One line per pair of blueprints, however many relations it carries; a blueprint that points at itself gets a loop.
  const lines = new Map<string, { from: string; to: string; titles: string[]; contain: boolean; bridge: boolean }>()
  for (const e of a.edges) {
    const key = `${e.from}>${e.to}`
    const cur = lines.get(key)
    if (cur) (cur.titles.push(e.title), (cur.contain &&= e.contain))
    else lines.set(key, { from: e.from, to: e.to, titles: [e.title], contain: e.contain, bridge: e.bridge })
  }
  const edges: Edge[] = []
  if (ctx.tier !== 'far') {
    for (const e of lines.values()) {
      // Lit: a line at the card being edited. Every other line steps back.
      const lit = !!ctx.editing && (e.from === ctx.editing || e.to === ctx.editing)
      const dim = !!ctx.focus && !lit
      // Only the lines at the selected card are named, so a well-connected card does not bury the graph in labels.
      const named = lit
      const colour = lit ? LINE_LIT : LINE
      edges.push({
        id: `${e.from}>${e.to}`,
        source: e.from,
        target: e.to,
        type: e.from === e.to ? 'loop' : 'default',
        label: named ? e.titles.join(', ') : e.titles.length > 1 ? `×${e.titles.length}` : undefined,
        labelStyle: { fill: lit ? 'var(--color-ink-100)' : 'var(--color-ink-300)', fontSize: 10, fontWeight: 500, fontFamily: 'var(--font-sans)', opacity: dim ? 0.2 : 1 },
        labelBgStyle: { fill: 'var(--color-ink-900)', fillOpacity: 0.95 },
        labelBgPadding: [6, 3],
        labelBgBorderRadius: 6,
        style: { stroke: colour, strokeWidth: lit ? 1.8 : 1.1, opacity: dim ? 0.25 : e.bridge ? 0.6 : 1, strokeDasharray: e.bridge ? '1 4' : e.contain ? '5 4' : undefined, strokeLinecap: e.bridge ? 'round' : undefined },
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: colour },
        zIndex: lit ? 1 : 0,
      })
    }
  }
  return { nodes, edges }
}

/** The pull of a loop's curve above its card: it peaks three quarters of the way up, clear of the card's top. */
const LOOP = MODEL_H * 2

/** A relation from a blueprint to itself: out of the card's right side, over its top, into its left side. */
function LoopEdge({ sourceX, sourceY, targetX, targetY, label, labelStyle, labelBgStyle, labelBgPadding, labelBgBorderRadius, style, markerEnd }: EdgeProps) {
  const path = `M ${sourceX} ${sourceY} C ${sourceX + 48} ${sourceY - LOOP}, ${targetX - 48} ${targetY - LOOP}, ${targetX} ${targetY}`
  return <BaseEdge path={path} labelX={(sourceX + targetX) / 2} labelY={(sourceY + targetY) / 2 - LOOP * 0.75} label={label} labelStyle={labelStyle} labelShowBg labelBgStyle={labelBgStyle} labelBgPadding={labelBgPadding} labelBgBorderRadius={labelBgBorderRadius} style={style} markerEnd={markerEnd} />
}

function BlueprintNodeView({ data, selected }: NodeProps<BpNode>) {
  const { bp } = data
  const blueprintName = useBlueprintName()
  const far = data.tier === 'far'
  const near = data.tier === 'near'
  const relations = Object.entries(bp.relations)
  return (
    // The card being edited wears the edit ring; a card picked for a drag of several, the orbit border.
    // A card away from the one being edited goes grey and flat, and its words keep their contrast.
    <div className={`rounded-lg border elevate-card ${data.editing ? 'border-edit ring-2 ring-edit/40' : selected ? 'border-orbit' : data.dim ? 'border-ink-800' : 'border-ink-700'} ${data.dim ? 'bg-ink-900 grayscale' : 'bg-ink-850'}`}>
      <Handle type="target" position={Position.Left} style={{ top: MODEL_H / 2 }} className="!size-2 !border-0 !bg-ink-500" />
      <Handle type="source" position={Position.Right} style={{ top: MODEL_H / 2 }} className="!size-2 !border-0 !bg-orbit" />
      <div className="flex items-center gap-2 pr-3 pl-1.5" style={{ height: MODEL_H }} title={bp.description ? `${blueprintName(bp)} (${bp.id}): ${bp.description}` : `${blueprintName(bp)} (${bp.id})`}>
        {!far && (
          <button
            className="nodrag rounded-sm p-0.5 text-ink-400 hover:bg-ink-700 hover:text-ink-100"
            onClick={(e) => {
              e.stopPropagation()
              data.onToggle()
            }}
            title={data.expanded ? 'Hide fields' : 'Show fields'}
          >
            {data.expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          </button>
        )}
        <span className={`grid shrink-0 place-items-center rounded-md border border-ink-700 bg-ink-800 ${far ? 'size-9' : 'size-7'}`}>
          <BlueprintIcon bp={bp} className={`text-ink-200 ${far ? 'size-6' : 'size-4'}`} />
        </span>
        <div className="min-w-0 flex-1">
          <div className={`truncate leading-tight font-semibold ${far ? 'text-[20px]' : data.tier === 'mid' ? 'text-[15px]' : 'text-[13px]'}`}>{blueprintName(bp)}</div>
          {near && (
            <div className="truncate text-[12px] text-ink-400">
              {data.count.toLocaleString()} {data.count === 1 ? 'entity' : 'entities'}
            </div>
          )}
        </div>
        {!far && bp.description && <Info className="size-3 shrink-0 text-ink-500" aria-hidden />}
        {!far && isLocked(bp.origin) && <Lock className="size-3 shrink-0 text-ink-500" aria-label={ORIGIN_LABEL[bp.origin.kind]} />}
      </div>
      {data.expanded && (
        <>
          <div className="border-t border-ink-700 px-3 py-1">
            <CardHeading>Properties · {Object.keys(bp.fields).length + 1}</CardHeading>
            <TableRow label="Title" title="title: every entity's title. Built in." right={<TypePill def={{ type: 'string' }} />} />
            {Object.entries(bp.fields).map(([k, f]) => (
              <TableRow key={k} label={f.title ?? k} title={f.description ? `${k}: ${f.description}` : k} right={<TypePill def={f} />} onOpen={data.locked ? undefined : (anchor) => data.onRow({ kind: 'field', name: k }, anchor)} />
            ))}
            {relations.length > 0 && <CardHeading>Relations · {relations.length}</CardHeading>}
            {relations.map(([k, r]) => {
              const to = data.blueprints[r.target]
              return (
                <TableRow
                  key={k}
                  label={r.title ?? k}
                  title={`${k}: ${r.many ? 'many' : 'one'} ${blueprintName(to ?? r.target)}${r.description ? `. ${r.description}` : ''}`}
                  right={
                    <span className="inline-flex min-w-0 items-center gap-1 rounded-full bg-orbit/10 px-1.5 py-px text-[12px] font-medium text-orbit">
                      <BlueprintIcon bp={to} className="size-3 shrink-0" />
                      <span className="truncate">{blueprintName(to ?? r.target)}</span>
                      {r.many && <span className="shrink-0 opacity-80">· many</span>}
                    </span>
                  }
                  onOpen={data.locked ? undefined : (anchor) => data.onRow({ kind: 'relation', name: k }, anchor)}
                />
              )
            })}
          </div>
          <div className="flex items-center gap-1 border-t border-ink-700 px-2" style={{ height: MODEL_ROW + 4 }}>
            {data.locked ? (
              <span className="flex min-w-0 items-center gap-1 px-1 text-[12px] text-ink-400">
                <Lock className="size-3 shrink-0" aria-hidden /> <span className="truncate">{data.locked}</span>
              </span>
            ) : (
              (['field', 'relation'] as const).map((kind) => (
                <button key={kind} type="button" className="nodrag flex h-6 items-center gap-1 rounded-md px-1.5 text-[12px] font-medium text-ink-400 hover:bg-ink-800 hover:text-ink-100" onClick={(e) => (e.stopPropagation(), data.onAdd(kind, e.currentTarget))} aria-label={`New ${kind === 'field' ? 'property' : 'relation'} on ${bp.title}`}>
                  <Plus className="size-3" /> {kind === 'field' ? 'Property' : 'Relation'}
                </button>
              ))
            )}
          </div>
        </>
      )}
    </div>
  )
}

/** A heading inside a card's field table, one row tall. */
function CardHeading({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-end pb-0.5 text-[12px] font-medium text-ink-400" style={{ height: MODEL_ROW }}>
      {children}
    </div>
  )
}

/** One row of a card's field table: a name on the left, what it is on the right. With `onOpen` it is a button that opens the row's menu. */
function TableRow({ label, right, title, onOpen }: { label: string; right: ReactNode; title?: string; onOpen?: (anchor: HTMLElement) => void }) {
  const inner = (
    <>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {right}
      {onOpen && <MoreHorizontal className="size-3 shrink-0 text-ink-400 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100" aria-hidden />}
    </>
  )
  if (!onOpen)
    return (
      <div className="flex items-center gap-2 text-[12px] text-ink-200" style={{ height: MODEL_ROW }} title={title}>
        {inner}
      </div>
    )
  return (
    <button type="button" className="nodrag group -mx-1.5 flex w-[calc(100%+0.75rem)] items-center gap-2 rounded-md px-1.5 text-left text-[12px] text-ink-200 hover:bg-ink-800" style={{ height: MODEL_ROW }} title={title} aria-haspopup="menu" onClick={(e) => (e.stopPropagation(), onOpen(e.currentTarget))}>
      {inner}
    </button>
  )
}
