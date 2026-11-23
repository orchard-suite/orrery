// The fields beside the answer: for each column, how its values share out
// among the rows, counted live. A value is a button: a press keeps only the
// rows that hold it, and with Control, Command, or Option held leaves them out.
// A number or a time also shows its range, which narrows by a lowest and a
// highest. Each column's values are counted over the rows every other
// condition keeps, so a picked value leaves the others to pick.

import { ChevronDown, ChevronRight } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { GridClause, QueryColumn, QueryRow, QueryView } from '../../shared/api.ts'
import { spread, type ColumnKind, type Spread } from '../../shared/answer.ts'
import { STATUS_LEVELS, type FieldFormat, type StatusLevel } from '../../shared/model.ts'
import { currencyText, numberText, storedText } from '../../shared/currency.ts'
import { when } from '../format.ts'
import { between, isKey, picks, pickValue, rowsBeside } from '../query.ts'
import { turning } from './Clauses.tsx'
import { Lamp, input } from './ui.tsx'

const LEVELS: ReadonlySet<string> = new Set(STATUS_LEVELS)
/** How many values a column lists before it says how many more there are. */
const LISTED = 6

export function QueryFields({ rows, columns, kinds, formats, view, onView, focus }: { rows: readonly QueryRow[]; columns: readonly QueryColumn[]; kinds: readonly ColumnKind[]; /** How each column's numbers are shown, such as money. */ formats: readonly (FieldFormat | undefined)[]; view: QueryView | undefined; onView: (v: QueryView | undefined) => void; /** A column to open and bring into sight. */ focus: string | null }) {
  const [find, setFind] = useState('')
  const where = view?.where ?? []
  const setWhere = (next: GridClause[]) => {
    const { where: _w, ...rest } = view ?? {}
    onView(next.length ? { ...rest, where: next } : rest)
  }
  const shown = columns.map((c, i) => ({ c, i })).filter(({ c }) => !isKey(c.id) && (!find.trim() || c.title.toLowerCase().includes(find.trim().toLowerCase())))
  return (
    <div className="space-y-1">
      <input className={`${input} w-full`} aria-label="Find a column" placeholder="Find a column" value={find} onChange={(e) => setFind(e.target.value)} />
      {shown.map(({ c, i }) => (
        <Field key={c.id} column={c} index={i} kind={kinds[i]} format={formats[i]} rows={rows} columns={columns} kinds={kinds} where={where} onWhere={setWhere} focused={focus === c.id} />
      ))}
      {!shown.length && <p className="px-1 py-2 text-[13px] text-ink-400">No column is called that.</p>}
    </div>
  )
}

function Field({ column, index, kind, format, rows, columns, kinds, where, onWhere, focused }: { column: QueryColumn; index: number; kind: ColumnKind; format: FieldFormat | undefined; rows: readonly QueryRow[]; columns: readonly QueryColumn[]; kinds: readonly ColumnKind[]; where: readonly GridClause[]; onWhere: (w: GridClause[]) => void; focused: boolean }) {
  const narrowed = where.some((c) => c.field === column.id)
  // The title is every row's own: listing it says nothing, so it starts folded, as do the columns past the first few.
  const [open, setOpen] = useState(column.id !== 'title' && index < 8)
  const ref = useRef<HTMLElement>(null)
  useEffect(() => {
    if (!focused) return
    setOpen(true)
    ref.current?.scrollIntoView({ block: 'nearest' })
    ref.current?.querySelector<HTMLElement>('button')?.focus()
  }, [focused])
  const [all, setAll] = useState(false)
  const s: Spread | null = useMemo(() => (open ? spread(rowsBeside(rows, where, column.id, columns, kinds), index, kind, all ? 60 : LISTED) : null), [open, rows, where, column.id, columns, kinds, index, kind, all])
  const id = `field-${index}`
  return (
    <section ref={ref} aria-labelledby={id} className={`rounded-md ${narrowed ? 'bg-ink-900' : ''}`}>
      <h3 id={id}>
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex w-full items-center gap-1.5 rounded-md px-1 py-1.5 text-left text-[13px] font-medium text-ink-100 hover:bg-ink-850">
          {open ? <ChevronDown aria-hidden className="size-3.5 shrink-0 text-ink-400" /> : <ChevronRight aria-hidden className="size-3.5 shrink-0 text-ink-400" />}
          <span className="min-w-0 flex-1 break-words">{column.title}</span>
          {narrowed && <span className="text-[12px] font-normal text-orbit">narrowed</span>}
        </button>
      </h3>
      {s && (
        <div className="space-y-0.5 pb-2 pl-5">
          {s.range && <Range column={column.id} kind={kind} format={format} range={s.range} where={where} onWhere={onWhere} />}
          {(!s.range || s.buckets.length <= LISTED) && (
            <ul className="space-y-0.5">
              {s.buckets.map((b) => {
                const state = picks(where, column.id, b.value)
                const total = Math.max(1, rows.length)
                return (
                  <li key={b.key ?? '∅'}>
                    <button
                      type="button"
                      aria-pressed={state !== null}
                      title={state === 'kept' ? 'Kept: press again to let it go' : state === 'left out' ? 'Left out: press again to let it go' : 'Keep only these. Hold Control, Command, or Option to leave them out.'}
                      onClick={(e) => onWhere(pickValue(where, column.id, b.value, turning(e)))}
                      className={`grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 rounded px-1.5 py-1 text-left text-[13px] hover:bg-ink-850 ${state === 'kept' ? 'text-ink-50' : state === 'left out' ? 'text-ink-400 line-through' : 'text-ink-200'}`}
                    >
                      <span className="flex min-w-0 items-center gap-1.5">
                        {column.id === '$status' && typeof b.value === 'string' && LEVELS.has(b.value) && <Lamp level={b.value as StatusLevel} size="sm" />}
                        <span className={`min-w-0 break-words ${b.key === null ? 'text-ink-400 italic' : ''}`}>{kind === 'datetime' && typeof b.value === 'string' ? when(b.value) : typeof b.value === 'number' ? numberText(b.value, format) : b.label}</span>
                      </span>
                      <span className="text-[12px] text-ink-400 tabular-nums">{b.count.toLocaleString('en-US')}</span>
                      <span aria-hidden className="col-span-2 mt-0.5 h-[3px] overflow-hidden rounded-full bg-ink-800">
                        <span className={`block h-full rounded-full ${state === 'kept' ? 'bg-orbit' : 'bg-ink-500'}`} style={{ width: `${Math.max(2, (b.count / total) * 100)}%` }} />
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
          {!s.range && s.other > 0 && (
            <button type="button" onClick={() => setAll(!all)} className="px-1.5 text-[12px] text-ink-300 hover:text-ink-50">
              {all ? 'Fewer' : `${s.other.toLocaleString('en-US')} more rows hold other values`}
            </button>
          )}
        </div>
      )}
    </section>
  )
}

/**
 * A number's or a time's range: how the rows spread between the lowest and
 * the highest, and a lowest and a highest to keep between. Money is typed and
 * read as money, and kept as the stored number.
 */
function Range({ column, kind, format, range, where, onWhere }: { column: string; kind: ColumnKind; format: FieldFormat | undefined; range: NonNullable<Spread['range']>; where: readonly GridClause[]; onWhere: (w: GridClause[]) => void }) {
  const time = kind === 'datetime'
  const money = format?.kind === 'currency' ? format : undefined
  const bound = (op: 'gte' | 'lte') => {
    const held = where.find((c) => c.field === column && c.op === op && !c.not)?.value ?? ''
    return money && held !== '' && Number.isFinite(Number(held)) ? currencyText(Number(held), money) : held
  }
  const [wrong, setWrong] = useState<string | null>(null)
  const [min, setMin] = useState(bound('gte'))
  const [max, setMax] = useState(bound('lte'))
  useEffect(() => {
    setMin(bound('gte'))
    setMax(bound('lte'))
  }, [where, column])
  const most = Math.max(...range.bins)
  const step = (range.max - range.min) / range.bins.length
  const text = (n: number) => (time ? new Date(n).toISOString().slice(0, 10) : String(Math.round(n * 100) / 100))
  const said = (n: number) => (time ? when(new Date(n).toISOString()) : numberText(n, format))
  const keep = () => {
    const lo = min ? storedText(min, format) : { value: '' }
    const hi = max ? storedText(max, format) : { value: '' }
    if ('error' in lo) return setWrong(lo.error)
    if ('error' in hi) return setWrong(hi.error)
    setWrong(null)
    onWhere(between(where, column, lo.value || null, hi.value || null))
  }
  return (
    <div className="space-y-1.5 pr-1">
      <div className="flex h-9 items-end gap-px" role="group" aria-label="How the rows spread: press a bar to keep its span">
        {range.bins.map((n, i) => {
          const lo = range.min + step * i
          const hi = i === range.bins.length - 1 ? range.max : range.min + step * (i + 1)
          return (
            <button key={i} type="button" aria-label={`${n} rows from ${said(lo)} to ${said(hi)}`} title={`${n} rows: ${said(lo)} to ${said(hi)}`} onClick={() => onWhere(between(where, column, text(lo), text(hi)))} className="h-full flex-1 rounded-t-[2px] hover:opacity-80">
              <span className="block w-full rounded-t-[2px] bg-ink-500" style={{ height: `${n ? Math.max(8, (n / most) * 100) : 0}%`, marginTop: 'auto' }} />
            </button>
          )
        })}
      </div>
      <div className="flex justify-between text-[12px] text-ink-400 tabular-nums">
        <span>{said(range.min)}</span>
        <span>{said(range.max)}</span>
      </div>
      <form
        className="flex items-center gap-1.5"
        onSubmit={(e) => {
          e.preventDefault()
          keep()
        }}
      >
        <input className={`${input} w-0 min-w-0 flex-1 py-1 text-[12px]`} aria-label="Lowest" placeholder="Lowest" type={time ? 'date' : 'text'} inputMode={time ? undefined : 'decimal'} value={min} onChange={(e) => setMin(e.target.value)} onBlur={keep} />
        <span className="text-ink-400">to</span>
        <input className={`${input} w-0 min-w-0 flex-1 py-1 text-[12px]`} aria-label="Highest" placeholder="Highest" type={time ? 'date' : 'text'} inputMode={time ? undefined : 'decimal'} value={max} onChange={(e) => setMax(e.target.value)} onBlur={keep} />
      </form>
      {wrong && (
        <p role="alert" className="text-[12px] text-red">
          {wrong}
        </p>
      )}
    </div>
  )
}
