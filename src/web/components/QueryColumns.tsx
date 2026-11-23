// The columns of a query, beside its answer: each in order, named, and saying
// what fills it in each blueprint read; and the fields that could become one,
// including what lies along a relation, such as a repository's team's
// department. A column is moved with its buttons, so the keyboard does what
// a drag would.

import { ArrowDown, ArrowUp, ChevronRight, CornerDownRight, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { QueryColumnSpec } from '../../shared/api.ts'
import { pathEnd, type Readable as Modelled } from '../../shared/answer.ts'
import type { Blueprint } from '../../shared/model.ts'
import { useBlueprintName } from '../api.ts'
import { addable, choicesIn, columnFor, isMeta, left, type Readable } from '../query.ts'
import { Picker } from './Picker.tsx'
import { input } from './ui.tsx'

export function QueryColumns({ columns, read, all, hues, onChange, focus }: { columns: QueryColumnSpec[]; read: Readable[]; all: readonly Blueprint[]; hues: ReadonlyMap<string, string>; onChange: (columns: QueryColumnSpec[], removed?: string) => void; /** A column to bring into sight and focus. */ focus: string | null }) {
  const name = useBlueprintName()
  const offered = useMemo(() => addable(read, columns), [read, columns])
  const put = (i: number, next: QueryColumnSpec) => onChange(columns.map((c, j) => (j === i ? next : c)))
  const move = (i: number, by: -1 | 1) => {
    const next = [...columns]
    ;[next[i], next[i + by]] = [next[i + by]!, next[i]!]
    onChange(next)
  }
  return (
    <div className="space-y-4">
      <ol className="space-y-1.5" aria-label="Columns, in order">
        {columns.map((c, i) => (
          <ColumnRow key={c.id} column={c} index={i} count={columns.length} read={read} hues={hues} titleOf={(bp) => name(bp)} focused={focus === c.id} onPut={(next) => put(i, next)} onMove={(by) => move(i, by)} onRemove={() => onChange(columns.filter((_, j) => j !== i), c.id)} />
        ))}
      </ol>
      {read.length > 0 && (
        <div className="space-y-3">
          <Picker
            label="Add a column"
            placeholder="Type a field's name"
            value={null}
            onChange={(picked) => picked && onChange([...columns, columnFor(picked, read, columns)])}
            options={offered.map((o) => {
              const names = o.in.map((b) => name(read.find((x) => x.id === b) ?? b)).join(', ')
              return { id: o.id, label: o.title, note: isMeta(o.id) ? 'Every entity has it' : o.id, group: o.in.length === read.length ? (read.length > 1 ? 'In every blueprint' : 'What it reads') : `Only in ${names}` }
            })}
          />
          <Follow read={read} all={all} columns={columns} onAdd={(c) => onChange([...columns, c])} />
        </div>
      )}
    </div>
  )
}

function ColumnRow({ column, index, count, read, hues, titleOf, focused, onPut, onMove, onRemove }: { column: QueryColumnSpec; index: number; count: number; read: Readable[]; hues: ReadonlyMap<string, string>; titleOf: (bp: Readable) => string; focused: boolean; onPut: (c: QueryColumnSpec) => void; onMove: (by: -1 | 1) => void; onRemove: () => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLLIElement>(null)
  useEffect(() => {
    if (!focused) return
    setOpen(true)
    ref.current?.scrollIntoView({ block: 'nearest' })
    ref.current?.querySelector<HTMLInputElement>('input')?.focus()
  }, [focused])
  const filled = read.filter((bp) => column.from[bp.id] !== undefined)
  return (
    <li ref={ref} className="rounded-md border border-ink-700 bg-ink-950/40">
      <div className="flex items-center gap-1 px-1.5 py-1">
        <button type="button" aria-expanded={open} aria-label={`What fills ${column.title}`} onClick={() => setOpen(!open)} className="rounded p-1 text-ink-400 hover:text-ink-100">
          <ChevronRight aria-hidden className={`size-3.5 ${open ? 'rotate-90' : ''}`} />
        </button>
        <input className={`${input} min-w-0 flex-1 border-transparent bg-transparent px-1.5 py-0.5 text-[13px] hover:border-edge`} aria-label={`Name of column ${index + 1}`} value={column.title} onChange={(e) => onPut({ ...column, title: e.target.value })} />
        {read.length > 1 && (
          <span className="flex gap-0.5" aria-label={`Filled in ${filled.map(titleOf).join(', ') || 'no blueprint'}`}>
            {read.map((bp) => (
              <span key={bp.id} aria-hidden className="size-1.5 rounded-[2px]" style={column.from[bp.id] !== undefined ? { background: hues.get(bp.id) } : { boxShadow: 'inset 0 0 0 1px var(--color-ink-500)' }} />
            ))}
          </span>
        )}
        <button type="button" className="rounded p-1 text-ink-400 hover:text-ink-100 disabled:opacity-40" aria-label={`Move ${column.title} up`} disabled={index === 0} onClick={() => onMove(-1)}>
          <ArrowUp aria-hidden className="size-3.5" />
        </button>
        <button type="button" className="rounded p-1 text-ink-400 hover:text-ink-100 disabled:opacity-40" aria-label={`Move ${column.title} down`} disabled={index === count - 1} onClick={() => onMove(1)}>
          <ArrowDown aria-hidden className="size-3.5" />
        </button>
        <button type="button" className="rounded p-1 text-ink-400 hover:text-ink-100" aria-label={`Remove the column ${column.title}`} onClick={onRemove}>
          <X aria-hidden className="size-3.5" />
        </button>
      </div>
      {open && (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2 gap-y-1.5 border-t border-ink-800 px-2.5 py-2">
          {read.map((bp) => (
            <FromRow key={bp.id} bp={bp} title={titleOf(bp)} hue={hues.get(bp.id)!} value={column.from[bp.id] ?? ''} column={column.title} onChange={(field) => onPut({ ...column, from: field ? { ...column.from, [bp.id]: field } : left([column], bp.id)[0]!.from })} />
          ))}
        </dl>
      )}
    </li>
  )
}

/** What one blueprint fills a column with: a field, a relation, one of the columns every entity has, what a path reads, or nothing. */
function FromRow({ bp, title, hue, value, column, onChange }: { bp: Readable; title: string; hue: string; value: string; column: string; onChange: (field: string | null) => void }) {
  const choices = useMemo(() => choicesIn(bp), [bp])
  const twice = useMemo(() => {
    const seen = new Map<string, number>()
    for (const c of choices) seen.set(c.title, (seen.get(c.title) ?? 0) + 1)
    return new Set([...seen].filter(([, n]) => n > 1).map(([t]) => t))
  }, [choices])
  const groups = ['Every entity', 'Run', 'Fields', 'Relations'] as const
  const along = value && !choices.some((c) => c.id === value)
  return (
    <>
      <dt className="flex items-center gap-1.5 text-[12px] text-ink-300">
        <span aria-hidden className="size-2 shrink-0 rounded-[2px]" style={{ background: hue }} />
        {title}
      </dt>
      <dd>
        <select className={`${input} w-full py-1 text-[13px] ${value ? '' : 'text-ink-400'}`} aria-label={`What ${title} fills ${column} with`} value={value} onChange={(e) => onChange(e.target.value || null)}>
          <option value="">Leave empty</option>
          {along && <option value={value}>{value}</option>}
          {groups.filter((g) => choices.some((c) => c.group === g)).map((g) => (
            <optgroup key={g} label={g}>
              {choices
                .filter((c) => c.group === g)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {twice.has(c.title) ? `${c.title} (${c.id})` : c.title}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
      </dd>
    </>
  )
}

/** One step of a walk: a relation taken from where the walk stands. */
interface Hop {
  relation: string
  title: string
}

/**
 * A column read along relations: start from a blueprint read, take a
 * relation, then another, and end on a field of what it reaches, or on what
 * it reaches itself, by title.
 */
function Follow({ read, all, columns, onAdd }: { read: Readable[]; all: readonly Blueprint[]; columns: QueryColumnSpec[]; onAdd: (c: QueryColumnSpec) => void }) {
  const name = useBlueprintName()
  const starts = read.filter((r) => Object.keys(r.relations).length > 0)
  const [from, setFrom] = useState<string>(starts[0]?.id ?? '')
  const [hops, setHops] = useState<Hop[]>([])
  const start = starts.find((r) => r.id === from) ?? starts[0]
  const model: readonly Modelled[] = all
  const at = start && hops.length ? pathEnd(start, hops.map((h) => h.relation).join('.'), model) : start
  if (!starts.length) return null
  const path = hops.map((h) => h.relation).join('.')
  const add = (field: string | null, fieldTitle: string | null) => {
    if (!start) return
    const id = field === null ? `r:${path}` : `r:${path}@${field}`
    const taken = new Set(columns.map((c) => c.id))
    let key = id
    for (let n = 2; taken.has(key); n++) key = `${id}~${n}`
    onAdd({ id: key, title: [...hops.map((h) => h.title), ...(fieldTitle ? [fieldTitle] : [])].join(' › '), from: { [start.id]: id } })
    setHops([])
  }
  const relations = at ? Object.entries(at.relations).map(([id, def]) => ({ id, title: def.title ?? id, target: def.target })) : []
  const ends = hops.length && at ? [{ id: '', title: 'Its title' }, { id: '$status', title: 'Status' }, ...Object.entries(at.fields).filter(([id]) => id !== 'title' && id !== 'icon').map(([id, def]) => ({ id, title: def.title ?? id }))] : []
  return (
    <section aria-label="Follow a relation" className="space-y-2 rounded-md border border-dashed border-ink-700 p-2.5">
      <h3 className="text-[13px] font-medium text-ink-100">Follow a relation</h3>
      <p className="text-[12px] text-ink-400">Read a field of what a row is related to, one relation after another.</p>
      {read.length > 1 && (
        <select className={`${input} w-full py-1 text-[13px]`} aria-label="Start from" value={start?.id ?? ''} onChange={(e) => (setFrom(e.target.value), setHops([]))}>
          {starts.map((r) => (
            <option key={r.id} value={r.id}>
              From {name(r)}
            </option>
          ))}
        </select>
      )}
      {hops.length > 0 && (
        <ol className="flex flex-wrap items-center gap-1 text-[12px] text-ink-200" aria-label="The walk so far">
          <li>{start ? name(start) : ''}</li>
          {hops.map((h, i) => (
            <li key={i} className="flex items-center gap-1">
              <ChevronRight aria-hidden className="size-3 text-ink-500" /> {h.title}
            </li>
          ))}
          <li>
            <button type="button" className="ml-1 text-ink-400 underline hover:text-ink-100" onClick={() => setHops(hops.slice(0, -1))}>
              Step back
            </button>
          </li>
        </ol>
      )}
      {relations.length > 0 && hops.length < 4 && (
        <select className={`${input} w-full py-1 text-[13px]`} aria-label={hops.length ? 'Then follow' : 'Follow'} value="" onChange={(e) => { const r = relations.find((x) => x.id === e.target.value); if (r) setHops([...hops, { relation: r.id, title: r.title }]) }}>
          <option value="">{hops.length ? 'Then follow…' : 'Follow…'}</option>
          {relations.map((r) => (
            <option key={r.id} value={r.id}>
              {r.title} → {name(all.find((b) => b.id === r.target) ?? { id: r.target, title: r.target })}
            </option>
          ))}
        </select>
      )}
      {ends.length > 0 && (
        <div className="flex items-center gap-1.5">
          <CornerDownRight aria-hidden className="size-3.5 shrink-0 text-ink-500" />
          <select className={`${input} min-w-0 flex-1 py-1 text-[13px]`} aria-label="And read" value="__" onChange={(e) => { const f = ends.find((x) => x.id === e.target.value); if (f) add(f.id || null, f.id ? f.title : null) }}>
            <option value="__">And read…</option>
            {ends.map((f) => (
              <option key={f.id || 'title'} value={f.id}>
                {f.title}
              </option>
            ))}
          </select>
        </div>
      )}
    </section>
  )
}
