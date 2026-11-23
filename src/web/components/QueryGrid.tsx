// The answer's grid: every row a query kept, as its view shapes it. A column's
// header opens what can be done with it (order, group, add up, width, where it
// moves); a cell opens what can be done with its value (keep only it, leave it
// out, group by it, copy it); a group folds; a row opens in place to show all
// it holds. The title stays put while the other columns scroll sideways, and
// the foot adds up the columns the view asks for. One tab stop: the arrow keys
// move through the cells, Enter opens one, Space opens a row or folds a group.

import { useVirtualizer } from '@tanstack/react-virtual'
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Plus } from 'lucide-react'
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { RUNS_SOURCE, type QueryColumn, type QueryResult, type QueryTotal, type QueryView } from '../../shared/api.ts'
import { cells, groupId, numeric, totalsFor, type AnswerGroup, type ColumnKind, type Shaped } from '../../shared/answer.ts'
import { STATUS_LEVELS, datasetOf, type FieldFormat, type StatusLevel } from '../../shared/model.ts'
import { numberText } from '../../shared/currency.ts'
import { useBlueprints, useEntity } from '../api.ts'
import { when } from '../format.ts'
import { answerLines, cellText, groupedBy, pickValue, rowId, sortedBy, TOTAL_WORDS, totalled, widthsOf, type Line } from '../query.ts'
import { navigate } from '../router.ts'
import { MenuItem, Popover } from './Popover.tsx'
import { Lamp, Link } from './ui.tsx'

const ROW = 33
const GROUP = 35
const DETAIL = 240
const LEVELS: ReadonlySet<string> = new Set(STATUS_LEVELS)
/** The edge each row's source colour takes, pinned with the title. */
const EDGE = 3
/** The room a row's opener takes before the title. */
const OPENER = 28

export interface GridProps {
  result: QueryResult
  shaped: Shaped
  view: QueryView | undefined
  kinds: readonly ColumnKind[]
  /** How each column's numbers are shown, such as money (`columnFormat`). */
  formats: readonly (FieldFormat | undefined)[]
  hues: ReadonlyMap<string, string>
  /** What a blueprint read is called. */
  sourceTitle: (blueprint: string) => string
  /** What each blueprint fills a column with, in words, when the query reads several. */
  fromWords: (column: QueryColumn) => string | undefined
  onView: (view: QueryView | undefined) => void
  /** Opens the fields beside the grid at one column, to narrow by it, where the page has them. */
  onNarrow?: (column: string) => void
  /** Column changes, when the reader may change the query. */
  onRemove?: (column: string) => void
  onMove?: (column: string, by: -1 | 1) => void
  onEditColumn?: (column: string) => void
}

/** Where the keyboard is: a line of the grid and a column. */
interface Cursor {
  line: number
  col: number
}

export function QueryGrid({ result, shaped, view, kinds, formats, hues, sourceTitle, fromWords, onView, onNarrow, onRemove, onMove, onEditColumn }: GridProps) {
  const id = useId()
  const columns = result.columns
  const scroller = useRef<HTMLDivElement>(null)
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set())
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  const lines = useMemo(() => answerLines(shaped, folded, open), [shaped, folded, open])
  // Sizes are kept by line, not by place: grouping or opening a row moves every line after it.
  const virtual = useVirtualizer({ count: lines.length, getScrollElement: () => scroller.current, getItemKey: (i) => lineKey(lines[i]!), estimateSize: (i) => (lines[i]?.kind === 'group' ? GROUP : lines[i]?.kind === 'detail' ? DETAIL : ROW), overscan: 16 })
  const [room, setRoom] = useState(1200)
  const [dragged, setDragged] = useState<{ column: string; width: number } | null>(null)
  const widths = useMemo(() => {
    const set = { ...view?.widths, ...(dragged ? { [dragged.column]: dragged.width } : {}) }
    return widthsOf(columns, result.rows, room, set)
  }, [columns, result.rows, room, view?.widths, dragged])
  const titleAt = Math.max(0, columns.findIndex((c) => c.id === 'title'))
  const total = EDGE + OPENER + widths.reduce((a, b) => a + b, 0)
  const sort = view?.sort?.[0]
  const grouped = new Set(view?.group ?? [])
  const several = Object.keys(result.counts).length > 1
  const [more, setMore] = useState(false)
  const [cursor, setCursor] = useState<Cursor | null>(null)
  // The cursor is drawn while the keyboard moves it, and not after a press of the pointer.
  const [keyed, setKeyed] = useState(false)
  const [menu, setMenu] = useState<{ anchor: HTMLElement; kind: 'head' | 'cell' | 'foot'; col: number; value?: unknown } | null>(null)

  const measure = () => {
    const el = scroller.current
    if (!el) return
    setMore(el.scrollLeft + el.clientWidth < el.scrollWidth - 2)
    setRoom(Math.max(320, Math.round(el.clientWidth / 40) * 40))
  }
  useLayoutEffect(() => {
    measure()
    const el = scroller.current
    if (!el) return
    const watch = new ResizeObserver(measure)
    watch.observe(el)
    return () => watch.disconnect()
  }, [total])
  // A cursor past the end, after the rows narrowed, comes back to the last line.
  useEffect(() => setCursor((c) => (c && c.line >= lines.length ? (lines.length ? { line: lines.length - 1, col: c.col } : null) : c)), [lines.length])

  const toggle = (set: ReadonlySet<string>, key: string) => {
    const next = new Set(set)
    if (!next.delete(key)) next.add(key)
    return next
  }
  const fold = (group: AnswerGroup) => setFolded((f) => toggle(f, groupId(group.path)))
  const openRow = (key: string) => setOpen((o) => toggle(o, key))

  const cellEl = (line: number, col: number) => document.getElementById(`${id}-${line}-${col}`)
  const move = (to: Cursor) => {
    setCursor(to)
    virtual.scrollToIndex(to.line, { align: 'auto' })
    requestAnimationFrame(() => cellEl(to.line, to.col)?.scrollIntoView({ block: 'nearest', inline: 'nearest' }))
  }
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!lines.length) return
    setKeyed(true)
    const at = cursor ?? { line: 0, col: titleAt }
    const line = lines[at.line]
    const step: Record<string, () => Cursor> = {
      ArrowDown: () => ({ line: Math.min(lines.length - 1, at.line + 1), col: at.col }),
      ArrowUp: () => ({ line: Math.max(0, at.line - 1), col: at.col }),
      ArrowRight: () => ({ line: at.line, col: Math.min(columns.length - 1, at.col + 1) }),
      ArrowLeft: () => ({ line: at.line, col: Math.max(0, at.col - 1) }),
      Home: () => ({ line: e.ctrlKey || e.metaKey ? 0 : at.line, col: 0 }),
      End: () => ({ line: e.ctrlKey || e.metaKey ? lines.length - 1 : at.line, col: columns.length - 1 }),
      PageDown: () => ({ line: Math.min(lines.length - 1, at.line + 20), col: at.col }),
      PageUp: () => ({ line: Math.max(0, at.line - 20), col: at.col }),
    }
    if (step[e.key]) {
      e.preventDefault()
      move(step[e.key]!())
      return
    }
    if (!cursor || !line) return
    if (e.key === ' ') {
      e.preventDefault()
      if (line.kind === 'group') fold(line.group)
      else openRow(rowId(line.row))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (line.kind === 'group') fold(line.group)
      else if (line.kind === 'row' && at.col === titleAt && datasetOf(line.row.blueprint) !== null) return
      else if (line.kind === 'row' && at.col === titleAt) navigate(line.row.blueprint === RUNS_SOURCE ? { page: 'action-run', id: line.row.key } : { page: 'entity', blueprint: line.row.blueprint, key: line.row.key })
      else if (line.kind === 'row') {
        const el = cellEl(at.line, at.col)
        if (el) setMenu({ anchor: el, kind: 'cell', col: at.col, value: line.row.values[at.col] })
      }
    }
  }

  // The pinned title keeps an edge, so what scrolls under it reads as scrolled, not cut.
  const pin = 'sticky z-[1] shadow-[1px_0_0_var(--color-ink-700)]'
  const pinLeft = EDGE + OPENER
  const totalShown = (i: number, t: number | string) => totalText(t, kinds[i], formats[i], view?.totals?.[columns[i]!.id])
  const cellClass = (i: number) => `${numeric(kinds[i]) ? 'text-right tabular-nums' : ''}`
  const active = cursor ? `${id}-${cursor.line}-${cursor.col}` : undefined

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scroller}
        onScroll={measure}
        tabIndex={0}
        onKeyDown={onKey}
        onPointerDown={() => setKeyed(false)}
        onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && setKeyed(false)}
        onFocus={() => !cursor && lines.length && setCursor({ line: 0, col: titleAt })}
        // Rows open and groups fold, so it is a tree of rows: the keyboard's Space does both.
        role="treegrid"
        aria-label="Answer"
        aria-rowcount={lines.length + 1}
        aria-colcount={columns.length}
        aria-activedescendant={active}
        className="min-h-0 flex-1 overflow-auto rounded-md border border-ink-800 max-md:h-[70dvh] max-md:flex-none"
      >
        <div style={{ width: total, minWidth: '100%' }} className="relative">
          <div role="row" className="sticky top-0 z-10 flex border-b border-ink-700 bg-ink-900">
            <span aria-hidden className="sticky left-0 z-[2] shrink-0 bg-ink-900" style={{ width: EDGE + OPENER }} />
            {columns.map((c, i) => (
              <Header
                key={c.id}
                column={c}
                width={widths[i]!}
                right={numeric(kinds[i])}
                pinned={i === titleAt ? pin : ''}
                left={i === titleAt ? pinLeft : undefined}
                sort={sort?.column === c.id ? (sort.desc ? 'descending' : 'ascending') : undefined}
                grouped={grouped.has(c.id)}
                sources={several ? Object.keys(result.counts) : []}
                hues={hues}
                words={fromWords(c)}
                onOpen={(anchor) => setMenu({ anchor, kind: 'head', col: i })}
                onResize={(width, done) => (done ? (setDragged(null), onView({ ...view, widths: { ...view?.widths, [c.id]: width } })) : setDragged({ column: c.id, width }))}
              />
            ))}
          </div>
          <div style={{ height: virtual.getTotalSize(), position: 'relative' }}>
            {virtual.getVirtualItems().map((v) => {
              const line = lines[v.index]!
              return (
                <div key={lineKey(line)} ref={virtual.measureElement} data-index={v.index} className="absolute left-0 w-full" style={{ transform: `translateY(${v.start}px)` }}>
                  {line.kind === 'group' ? (
                    <GroupLine id={id} index={v.index} line={line} columns={columns} widths={widths} kinds={kinds} formats={formats} totalShown={totalShown} titleAt={titleAt} pin={pin} pinLeft={pinLeft} cursor={keyed ? cursor : null} onFold={() => fold(line.group)} />
                  ) : line.kind === 'detail' ? (
                    <Detail line={line} room={room} />
                  ) : (
                    <div role="row" aria-rowindex={v.index + 2} aria-expanded={line.open} className="group flex border-b border-ink-800/60 text-[13px]" style={{ minHeight: ROW }}>
                      <span aria-hidden className="sticky left-0 z-[2] shrink-0" style={{ width: EDGE, background: hues.get(line.row.blueprint) ?? 'var(--color-ink-600)' }} />
                      {/* The pointer's way to open a row; the keyboard's is Space on the row, and the row says whether it is open. */}
                      <span aria-hidden className="sticky z-[2] flex shrink-0 items-start justify-center bg-ink-950 pt-1.5 group-hover:bg-ink-850 max-md:pt-0.5" style={{ left: EDGE, width: OPENER }}>
                        <button type="button" tabIndex={-1} aria-label={line.open ? 'Close the row' : 'Open the row'} onClick={() => openRow(rowId(line.row))} className="rounded p-0.5 text-ink-400 hover:text-ink-100 max-md:p-1.5">
                          {line.open ? <ChevronDown aria-hidden className="size-3.5" /> : <ChevronRight aria-hidden className="size-3.5" />}
                        </button>
                      </span>
                      {line.row.values.map((value, i) => {
                        const on = keyed && cursor?.line === v.index && cursor.col === i
                        return (
                          <div
                            key={i}
                            id={`${id}-${v.index}-${i}`}
                            role="gridcell"
                            aria-colindex={i + 1}
                            onClick={(e) => {
                              setCursor({ line: v.index, col: i })
                              if (i !== titleAt && !(e.target as HTMLElement).closest('a')) setMenu({ anchor: e.currentTarget, kind: 'cell', col: i, value })
                            }}
                            className={`px-2.5 py-1.5 break-words text-ink-200 ${i === titleAt ? `${pin} bg-ink-950 group-hover:bg-ink-850` : 'cursor-pointer group-hover:bg-ink-850/60'} ${cellClass(i)} ${on ? 'outline-2 -outline-offset-2 outline-orbit' : ''}`}
                            style={{ width: widths[i], flex: 'none', ...(i === titleAt ? { left: pinLeft } : {}) }}
                          >
                            {i === titleAt && datasetOf(line.row.blueprint) !== null ? (
                              <span className="text-ink-50">{cellText(value) || line.row.key}</span>
                            ) : i === titleAt ? (
                              <Link to={line.row.blueprint === RUNS_SOURCE ? { page: 'action-run', id: line.row.key } : { page: 'entity', blueprint: line.row.blueprint, key: line.row.key }} className="-my-1 inline-block min-w-6 py-1 text-ink-50 hover:underline max-md:min-h-6" tabIndex={-1}>
                                {cellText(value) || line.row.key}
                              </Link>
                            ) : (
                              <Cell value={value} column={columns[i]!} kind={kinds[i]} format={formats[i]} />
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
          <Foot columns={columns} widths={widths} kinds={kinds} totalShown={totalShown} view={view} totals={shaped.totals} titleAt={titleAt} pin={pin} pinLeft={pinLeft} count={shaped.rows.length} onOpen={(anchor, col) => setMenu({ anchor, kind: 'foot', col })} />
        </div>
      </div>
      {more && <div aria-hidden className="pointer-events-none absolute inset-y-px right-px w-10 rounded-r-md bg-gradient-to-l from-ink-950 to-transparent" />}
      {menu && menu.kind === 'head' && (
        <HeaderMenu
          anchor={menu.anchor}
          column={columns[menu.col]!}
          kind={kinds[menu.col]}
          first={menu.col === 0}
          last={menu.col === columns.length - 1}
          view={view}
          sort={sort?.column === columns[menu.col]!.id ? (sort.desc ? 'desc' : 'asc') : null}
          onView={onView}
          {...(onNarrow ? { onNarrow: () => onNarrow(columns[menu.col]!.id) } : {})}
          onRemove={onRemove && (() => onRemove(columns[menu.col]!.id))}
          onMove={onMove && ((by) => onMove(columns[menu.col]!.id, by))}
          onEdit={onEditColumn && (() => onEditColumn(columns[menu.col]!.id))}
          onClose={() => setMenu(null)}
        />
      )}
      {menu && menu.kind === 'cell' && <CellMenu anchor={menu.anchor} column={columns[menu.col]!} value={menu.value} view={view} onView={onView} onClose={() => (setMenu(null), scroller.current?.focus())} />}
      {menu && menu.kind === 'foot' && <TotalMenu anchor={menu.anchor} column={columns[menu.col]!} kind={kinds[menu.col]} view={view} onView={onView} onClose={() => setMenu(null)} />}
    </div>
  )
}

function lineKey(line: Line): string {
  if (line.kind === 'group') return `g${groupId(line.group.path)}`
  return `${line.kind === 'detail' ? 'd' : 'r'}${rowId(line.row)}`
}

/** One value as the grid writes it: a status with its lamp, a time in the reader's own, a number with its separators, a list joined. */
function Cell({ value, column, kind, format }: { value: unknown; column: QueryColumn; kind: ColumnKind; format: FieldFormat | undefined }) {
  const all = cells(value)
  if (!all.length) return null
  if (column.id === '$status' && typeof value === 'string' && LEVELS.has(value)) {
    return (
      <span className="inline-flex items-center gap-1.5">
        <Lamp level={value as StatusLevel} calm /> {value}
      </span>
    )
  }
  if (kind === 'number') return <>{all.map((v) => (typeof v === 'number' ? numberText(v, format) : cellText(v))).join(', ')}</>
  if (kind === 'datetime') return <>{all.map((v) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? when(v) : cellText(v))).join(', ')}</>
  return <>{cellText(value)}</>
}

/** A column's header: its name and order, a square for each blueprint read that fills it, and an edge to drag its width by. */
function Header({ column, width, right, pinned, left, sort, grouped, sources, hues, words, onOpen, onResize }: { column: QueryColumn; width: number; right: boolean; pinned: string; left: number | undefined; sort: 'ascending' | 'descending' | undefined; grouped: boolean; sources: string[]; hues: ReadonlyMap<string, string>; words: string | undefined; onOpen: (anchor: HTMLElement) => void; onResize: (width: number, done: boolean) => void }) {
  const start = (e: ReactPointerEvent<HTMLSpanElement>) => {
    e.preventDefault()
    const from = e.clientX
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    let now = width
    const moved = (m: PointerEvent) => {
      now = Math.max(72, Math.round(width + m.clientX - from))
      onResize(now, false)
    }
    const up = () => {
      el.removeEventListener('pointermove', moved)
      el.removeEventListener('pointerup', up)
      onResize(now, true)
    }
    el.addEventListener('pointermove', moved)
    el.addEventListener('pointerup', up)
  }
  return (
    <div role="columnheader" aria-sort={sort} className={`relative ${pinned ? `${pinned} bg-ink-900` : ''}`} style={{ width, flex: 'none', ...(left !== undefined ? { left } : {}) }} title={words}>
      <button type="button" aria-haspopup="menu" onClick={(e) => onOpen(e.currentTarget)} className={`flex w-full flex-col px-2.5 pt-2 pb-1.5 text-left hover:bg-ink-850 ${right ? 'items-end text-right' : ''}`}>
        <span className={`flex items-center gap-1 text-[12px] font-medium break-words ${sort || grouped ? 'text-ink-50' : 'text-ink-300'}`}>
          {column.title}
          {sort === 'ascending' && <ArrowUp aria-label="low to high" className="size-3 shrink-0" />}
          {sort === 'descending' && <ArrowDown aria-label="high to low" className="size-3 shrink-0" />}
          {grouped && <span className="text-[11px] font-normal text-ink-400">grouped</span>}
        </span>
        {sources.length > 1 && (
          <span className="mt-1 flex gap-1">
            {sources.map((s) => (
              <span key={s} aria-hidden className="size-1.5 rounded-[2px]" style={column.from[s] !== undefined ? { background: hues.get(s) } : { boxShadow: 'inset 0 0 0 1px var(--color-ink-500)' }} />
            ))}
            {words && <span className="sr-only">{words}</span>}
          </span>
        )}
      </button>
      <span aria-hidden onPointerDown={start} onDoubleClick={() => onResize(0, true)} className="absolute inset-y-0 -right-1 z-[3] w-2 cursor-col-resize hover:bg-orbit/40" />
    </div>
  )
}

/** A group's heading: the value it holds, how many rows, and what each column adds up to under it. A press folds it. */
function GroupLine({ id, index, line, columns, widths, kinds, formats, totalShown, titleAt, pin, pinLeft, cursor, onFold }: { id: string; index: number; line: Extract<Line, { kind: 'group' }>; columns: readonly QueryColumn[]; widths: number[]; kinds: readonly ColumnKind[]; formats: readonly (FieldFormat | undefined)[]; totalShown: (i: number, t: number | string) => string; titleAt: number; pin: string; pinLeft: number; cursor: Cursor | null; onFold: () => void }) {
  const g = line.group
  const column = columns.find((c) => c.id === g.column)
  const at = columns.findIndex((c) => c.id === g.column)
  const label = !cells(g.value).length ? 'No value' : typeof g.value === 'number' && kinds[at] === 'number' ? numberText(g.value, formats[at]) : cellText(g.value)
  return (
    <div role="row" aria-rowindex={index + 2} aria-expanded={!line.folded} aria-level={line.depth + 1} className="flex border-b border-ink-700 bg-ink-900 text-[13px]" style={{ minHeight: GROUP }}>
      <span aria-hidden className="sticky left-0 z-[2] shrink-0 bg-ink-900" style={{ width: EDGE }} />
      <span aria-hidden className="sticky z-[2] flex shrink-0 items-center justify-center bg-ink-900" style={{ left: EDGE, width: OPENER }}>
        <button type="button" tabIndex={-1} aria-label={line.folded ? `Open ${label}` : `Fold ${label}`} onClick={onFold} className="rounded p-0.5 text-ink-300 hover:text-ink-50 max-md:p-1">
          {line.folded ? <ChevronRight aria-hidden className="size-4" /> : <ChevronDown aria-hidden className="size-4" />}
        </button>
      </span>
      {columns.map((c, i) => {
        const on = cursor?.line === index && cursor.col === i
        const t = g.totals[c.id]
        return (
          <div key={c.id} id={`${id}-${index}-${i}`} role="gridcell" className={`px-2.5 py-2 ${i === titleAt ? `${pin} bg-ink-900` : ''} ${numeric(kinds[i]) ? 'text-right tabular-nums' : ''} ${on ? 'outline-2 -outline-offset-2 outline-orbit' : ''}`} style={{ width: widths[i], flex: 'none', ...(i === titleAt ? { left: pinLeft } : {}) }} onClick={i === titleAt ? onFold : undefined}>
            {i === titleAt ? (
              <span className="flex flex-wrap items-baseline gap-x-2" style={{ paddingLeft: line.depth * 14 }}>
                <span className="text-[12px] text-ink-400">{column?.title}</span>
                <span className="font-medium break-words text-ink-50">
                  {g.column === '$status' && typeof g.value === 'string' && LEVELS.has(g.value) ? (
                    <span className="inline-flex items-center gap-1.5">
                      <Lamp level={g.value as StatusLevel} /> {label}
                    </span>
                  ) : (
                    label
                  )}
                </span>
                <span className="text-[12px] text-ink-300 tabular-nums">{g.count.toLocaleString('en-US')}</span>
              </span>
            ) : t !== undefined && t !== null ? (
              <span className="text-ink-100">{totalShown(i, t)}</span>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

/** A total as the foot and a group write it: a sum, a mean, or a bound of money as money; a count as a count. */
function totalText(t: number | string, kind: ColumnKind, format: FieldFormat | undefined, total: QueryTotal | undefined): string {
  if (typeof t === 'number') return numberText(t, total && COUNTS.has(total) ? undefined : format)
  return kind === 'datetime' && !Number.isNaN(Date.parse(t)) ? when(t) : t
}

/** The totals that count rows or values, whatever the column holds. */
const COUNTS: ReadonlySet<QueryTotal> = new Set(['count', 'filled', 'distinct'])

/** The foot: what each column adds up to over every row kept, and a way to have one add up. */
function Foot({ columns, widths, kinds, totalShown, view, totals, titleAt, pin, pinLeft, count, onOpen }: { columns: readonly QueryColumn[]; widths: number[]; kinds: readonly ColumnKind[]; totalShown: (i: number, t: number | string) => string; view: QueryView | undefined; totals: Shaped['totals']; titleAt: number; pin: string; pinLeft: number; count: number; onOpen: (anchor: HTMLElement, col: number) => void }) {
  return (
    <div role="row" className="sticky bottom-0 z-10 flex border-t border-ink-700 bg-ink-900 text-[12px]">
      <span aria-hidden className="sticky left-0 z-[2] shrink-0 bg-ink-900" style={{ width: EDGE + OPENER }} />
      {columns.map((c, i) => {
        const total = view?.totals?.[c.id]
        const t = totals[c.id]
        return (
          <div key={c.id} role="gridcell" className={`${i === titleAt ? `${pin} bg-ink-900` : ''}`} style={{ width: widths[i], flex: 'none', ...(i === titleAt ? { left: pinLeft } : {}) }}>
            <button type="button" aria-haspopup="menu" onClick={(e) => onOpen(e.currentTarget, i)} aria-label={total ? `${c.title}: ${TOTAL_WORDS[total]} ${t ?? ''}. Change how it adds up` : `Add up ${c.title}`} className={`flex w-full items-baseline gap-1.5 px-2.5 py-1.5 hover:bg-ink-850 ${numeric(kinds[i]) ? 'justify-end' : ''} ${total ? 'text-ink-100' : 'text-ink-500 hover:text-ink-200'}`}>
              {total ? (
                <>
                  <span className="text-ink-400">{TOTAL_WORDS[total]}</span>
                  <span className="tabular-nums">{t === null || t === undefined ? '–' : totalShown(i, t)}</span>
                </>
              ) : i === titleAt ? (
                <span className="text-ink-300 tabular-nums">{count.toLocaleString('en-US')} rows</span>
              ) : (
                <Plus aria-hidden className="size-3" />
              )}
            </button>
          </div>
        )
      })}
    </div>
  )
}

/** What can be done with a column: its order, its groups, how it adds up, its width and place, and narrowing by it. */
function HeaderMenu({ anchor, column, kind, first, last, view, sort, onView, onNarrow, onRemove, onMove, onEdit, onClose }: { anchor: HTMLElement; column: QueryColumn; kind: ColumnKind; first: boolean; last: boolean; view: QueryView | undefined; sort: 'asc' | 'desc' | null; onView: (v: QueryView | undefined) => void; onNarrow?: () => void; onRemove?: () => void; onMove?: (by: -1 | 1) => void; onEdit?: () => void; onClose: () => void }) {
  const grouped = !!view?.group?.includes(column.id)
  const total = view?.totals?.[column.id]
  const width = view?.widths?.[column.id]
  const act = (f: () => void) => () => (f(), onClose())
  const low = kind === 'number' ? '1 → 9' : kind === 'datetime' ? 'Oldest first' : 'A → Z'
  const high = kind === 'number' ? '9 → 1' : kind === 'datetime' ? 'Newest first' : 'Z → A'
  return (
    <Popover anchor={anchor} menu label={`${column.title} column`} onClose={onClose} className="w-60 py-1">
      <Section title={column.title} />
      <MenuItem check="radio" active={sort === 'asc'} autoFocus onClick={act(() => onView(sortedBy(view, column.id, sort === 'asc' ? null : false)))}>
        Sort {low}
      </MenuItem>
      <MenuItem check="radio" active={sort === 'desc'} onClick={act(() => onView(sortedBy(view, column.id, sort === 'desc' ? null : true)))}>
        Sort {high}
      </MenuItem>
      <MenuItem check="checkbox" active={grouped} onClick={act(() => onView(groupedBy(view, column.id, !grouped)))}>
        Group by {column.title}
      </MenuItem>
      {onNarrow && <MenuItem onClick={act(onNarrow)}>Narrow by its values…</MenuItem>}
      <Section title="Add up" />
      {totalsFor(kind).map((t) => (
        <MenuItem key={t} check="radio" active={total === t} onClick={act(() => onView(totalled(view, column.id, total === t ? null : t)))}>
          {TOTAL_WORDS[t]}
        </MenuItem>
      ))}
      <Section title="Column" />
      {onMove && !first && <MenuItem onClick={act(() => onMove(-1))}>Move left</MenuItem>}
      {onMove && !last && <MenuItem onClick={act(() => onMove(1))}>Move right</MenuItem>}
      {width !== undefined && (
        <MenuItem
          onClick={act(() => {
            const { [column.id]: _w, ...widths } = view?.widths ?? {}
            const { widths: _all, ...rest } = view ?? {}
            onView(Object.keys(widths).length ? { ...rest, widths } : rest)
          })}
        >
          Fit its width again
        </MenuItem>
      )}
      {onEdit && <MenuItem onClick={act(onEdit)}>Rename, or change what fills it…</MenuItem>}
      {onRemove && (
        <MenuItem danger onClick={act(onRemove)}>
          Remove the column
        </MenuItem>
      )}
    </Popover>
  )
}

function Section({ title }: { title: string }) {
  return <div className="px-3 pt-2 pb-1 text-[12px] font-medium text-ink-400">{title}</div>
}

/** What can be done with a cell's value: keep only the rows holding it, leave them out, group by its column, or copy it. A list offers each of its values. */
function CellMenu({ anchor, column, value, view, onView, onClose }: { anchor: HTMLElement; column: QueryColumn; value: unknown; view: QueryView | undefined; onView: (v: QueryView | undefined) => void; onClose: () => void }) {
  const all = cells(value)
  const values: unknown[] = all.length ? all.slice(0, 6) : [null]
  const where = view?.where ?? []
  const keep = (v: unknown, not: boolean) => () => {
    const next = pickValue(where, column.id, v, not)
    const { where: _w, ...rest } = view ?? {}
    onView(next.length ? { ...rest, where: next } : rest)
    onClose()
  }
  const words = (v: unknown) => (v === null ? 'no value' : cellText(v))
  return (
    <Popover anchor={anchor} menu label={`${column.title}: ${cellText(value) || 'no value'}`} onClose={onClose} className="w-72 py-1">
      <Section title={column.title} />
      {values.map((v, i) => (
        <div key={i}>
          <MenuItem autoFocus={i === 0} onClick={keep(v, false)}>
            <span className="min-w-0 truncate">
              Keep only <b className="font-medium text-ink-50">{words(v)}</b>
            </span>
          </MenuItem>
          <MenuItem onClick={keep(v, true)}>
            <span className="min-w-0 truncate">
              Leave out <b className="font-medium text-ink-50">{words(v)}</b>
            </span>
          </MenuItem>
        </div>
      ))}
      {!view?.group?.includes(column.id) && (
        <MenuItem
          onClick={() => {
            onView(groupedBy(view, column.id, true))
            onClose()
          }}
        >
          Group by {column.title}
        </MenuItem>
      )}
      {all.length > 0 && (
        <MenuItem
          onClick={() => {
            void navigator.clipboard?.writeText(cellText(value))
            onClose()
          }}
        >
          Copy the value
        </MenuItem>
      )}
    </Popover>
  )
}

/** How a column adds up at the foot and in each group. */
function TotalMenu({ anchor, column, kind, view, onView, onClose }: { anchor: HTMLElement; column: QueryColumn; kind: ColumnKind; view: QueryView | undefined; onView: (v: QueryView | undefined) => void; onClose: () => void }) {
  const total = view?.totals?.[column.id]
  const pick = (t: QueryTotal | null) => () => (onView(totalled(view, column.id, t)), onClose())
  return (
    <Popover anchor={anchor} menu label={`Add up ${column.title}`} onClose={onClose} className="w-56 py-1">
      <Section title={`Add up ${column.title}`} />
      {totalsFor(kind).map((t, i) => (
        <MenuItem key={t} check="radio" autoFocus={i === 0} active={total === t} onClick={pick(t)}>
          {TOTAL_WORDS[t]}
        </MenuItem>
      ))}
      {total && <MenuItem onClick={pick(null)}>Do not add it up</MenuItem>}
    </Popover>
  )
}

/** A row opened in place: everything its entity holds that the reader may see, and where to go from it. */
function Detail({ line, room }: { line: Extract<Line, { kind: 'detail' }>; room: number }) {
  const { row } = line
  return (
    <div className="border-b border-ink-700 bg-ink-900">
      <div className="sticky left-0 px-4 py-3" style={{ width: Math.max(300, room - 4), paddingLeft: EDGE + OPENER }}>
        {row.blueprint === RUNS_SOURCE ? (
          <p className="text-[13px] text-ink-300">
            A run of an action. <Link to={{ page: 'action-run', id: row.key }}>Open its page</Link> for its log, its steps, and what it ended with.
          </p>
        ) : datasetOf(row.blueprint) !== null ? (
          <p className="text-[13px] text-ink-300">A row of a dataset: everything it holds is in its columns.</p>
        ) : (
          <EntityDetail blueprint={row.blueprint} entityKey={row.key} room={room} />
        )}
      </div>
    </div>
  )
}

function EntityDetail({ blueprint, entityKey, room }: { blueprint: string; entityKey: string; room: number }) {
  const entity = useEntity({ blueprint, key: entityKey })
  const bp = useBlueprints().data?.blueprints.find((b) => b.id === blueprint)
  if (entity.isError) return <p className="text-[13px] text-ink-400">It could not be read.</p>
  if (!entity.data) return <p className="text-[13px] text-ink-400">Reading it…</p>
  const e = entity.data
  const fields = Object.entries(e.fields).filter(([name, v]) => name !== 'title' && name !== 'icon' && cells(v).length > 0)
  const relations = Object.entries(e.relations).filter(([, list]) => list.length > 0)
  const rows: { name: string; text: ReactNode }[] = [
    { name: 'Key', text: <span className="font-mono text-[12px] break-all">{e.key}</span> },
    ...relations.map(([name, list]) => ({ name: bp?.relations[name]?.title ?? name, text: list.map((r) => r.title ?? r.key).join(', ') })),
    ...fields.map(([name, v]) => ({ name: bp?.fields[name]?.title ?? name, text: <span className="break-words">{bp?.fields[name]?.type === 'datetime' && typeof v === 'string' ? when(v) : cellText(v)}</span> })),
  ]
  return (
    <div className="space-y-3">
      {/* As many columns as hold a name and a value side by side, each at least 340 wide. */}
      <dl className="grid gap-x-8 gap-y-1 text-[13px]" style={{ gridTemplateColumns: `repeat(${Math.max(1, Math.min(3, Math.floor(room / 380)))}, minmax(0, 1fr))` }}>
        {rows.map((r) => (
          <div key={r.name} className="flex min-w-0 gap-3 border-b border-dashed border-ink-800 py-1">
            <dt className="w-36 shrink-0 break-words text-ink-400">{r.name}</dt>
            <dd className="min-w-0 text-ink-100">{r.text}</dd>
          </div>
        ))}
      </dl>
      <div className="flex flex-wrap gap-2">
        <Link to={{ page: 'entity', blueprint, key: entityKey }} className="btn btn-ghost">
          Open its page
        </Link>
        <button type="button" className="btn btn-ghost" onClick={() => void navigator.clipboard?.writeText(JSON.stringify(e, null, 2))}>
          Copy as JSON
        </button>
      </div>
    </div>
  )
}

