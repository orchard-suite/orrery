// The conditions of a filter, as a row of chips: each says its condition as a
// sentence and opens to change it, and a button adds one. Every list in it is
// searched by typing. The grid's filter bar, a query's sources, and the action
// builder's "Ask only when" all draw their conditions with it, and keep them
// wherever they like. A relation that says what it reaches (`reaches`) also
// tests their fields: any, every, or none of them meeting conditions of their
// own, set here with the same chips. What each test is called is
// `conditions.ts`.

import { ChevronLeft, Plus, X } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import type { GridClause } from '../../shared/api.ts'
import { firstTest, hintFor, matchWords, opsFor, reachSentence, sameTest, sentence, testOf, testsOf, testWords, valueless, valueShown, type Choice, type ConditionField, type Test } from '../conditions.ts'
import { currencyOf, storedText } from '../../shared/currency.ts'
import { TypeGlyph } from './FieldType.tsx'
import { Popover } from './Popover.tsx'
import { Chip, input } from './ui.tsx'

export type { Choice, ConditionField } from '../conditions.ts'

/** How many choices a list draws at once. Typing narrows the rest in. */
const SHOWN = 100

/** Whether a press asks for the test turned round: Control, Command, or Option held. */
export function turning(event: { ctrlKey: boolean; metaKey: boolean; altKey: boolean }): boolean {
  return event.ctrlKey || event.metaKey || event.altKey
}

export function Conditions({
  clauses,
  onChange,
  fields,
  ops,
  choices,
  labelOf,
  onEditing,
  add = 'Filter',
  stacked = false,
  children,
}: {
  clauses: readonly GridClause[]
  onChange: (next: GridClause[]) => void
  /** The fields a condition may test. One a condition already names is kept, whether or not it is among them. */
  fields: readonly ConditionField[]
  /** The tests a condition on a field may make, the one a new condition starts with first. */
  ops: (field: string) => readonly GridClause['op'][]
  /** The values a condition on a field picks from, or null to have its value typed. */
  choices?: (field: string) => Choice[] | null
  /** What a condition's value reads as when its choices do not name it. */
  labelOf?: (clause: GridClause) => string
  /** Told which field the open editor tests, and null when it closes, so the choices can be read for it. */
  onEditing?: (field: string | null) => void
  /** What the button that adds a condition says. */
  add?: string
  /** One chip a line, for a narrow sheet. */
  stacked?: boolean
  /** What follows the chips on their line, such as the buttons that keep a filter. */
  children?: ReactNode
}) {
  const [editing, setEditing] = useState<{ at: number | null; anchor: HTMLElement } | null>(null)
  // What the open editor holds typed and not yet taken: a press outside keeps it.
  const typed = useRef<() => GridClause | null>(() => null)
  const byId = useMemo(() => new Map(fields.map((f) => [f.id, f])), [fields])
  const done = (clause: GridClause | null) => {
    if (clause && editing) onChange(editing.at === null ? [...clauses, clause] : clauses.map((c, i) => (i === editing.at ? clause : c)))
    setEditing(null)
  }
  return (
    <div role="group" aria-label="Conditions" className={stacked ? 'flex flex-col items-stretch gap-2' : 'flex flex-wrap items-center gap-1.5'}>
      {clauses.map((c, i) => {
        const field = byId.get(c.field)
        const title = field?.title ?? c.field
        const picked = choices?.(c.field)?.find((v) => v.value === c.value)
        const label = picked?.label ?? labelOf?.(c) ?? valueShown(c, currencyOf(field?.def), 'said')
        const said = sentence(c, title, label, field?.type, field?.reaches)
        return (
          <span key={i} className="inline-flex max-w-full min-w-0 items-stretch rounded-md border border-edge bg-ink-850 text-[13px]">
            <button type="button" aria-haspopup="dialog" aria-label={`Change the condition ${said}`} title="Change this condition" onClick={(e) => setEditing({ at: i, anchor: e.currentTarget.parentElement! })} className={`flex min-w-0 items-center gap-1.5 rounded-l-md py-1 pr-1.5 pl-2.5 hover:bg-ink-800 ${stacked ? 'flex-1 py-2' : ''}`}>
              <span className="shrink-0 text-ink-100">{title || 'Pick a field'}</span>
              {c.where ? (
                <span className={`min-w-0 truncate ${c.match === 'none' || c.not ? 'text-orbit' : 'text-ink-300'}`}>{reachSentence(c, field?.reaches)}</span>
              ) : (
                <span className={`shrink-0 ${c.op === 'neq' || c.not ? 'text-orbit' : 'text-ink-400'}`}>{testWords(c, field?.type)}</span>
              )}
              {!valueless(c) && (picked?.color ? <Chip value={c.value} label={label} def={{ type: 'string', colors: { [c.value]: picked.color } }} /> : <span className="min-w-0 truncate font-medium text-ink-50">{label || '…'}</span>)}
            </button>
            <button type="button" aria-label={`Remove the condition ${said}`} title="Remove this condition" onClick={() => onChange(clauses.filter((_, j) => j !== i))} className="grid w-6 shrink-0 place-items-center rounded-r-md border-l border-ink-700 text-ink-400 hover:bg-ink-800 hover:text-ink-100">
              <X className="size-3.5" aria-hidden />
            </button>
          </span>
        )
      })}
      <button type="button" aria-haspopup="dialog" disabled={!fields.length} onClick={(e) => setEditing({ at: null, anchor: e.currentTarget })} className={`btn btn-ghost border-dashed ${stacked ? 'justify-center' : ''}`}>
        <Plus className="size-3.5" aria-hidden /> {add}
      </button>
      {children}
      {editing && (
        <Popover anchor={editing.anchor} width={320} label={editing.at === null ? 'Add a condition' : 'Change the condition'} onClose={() => done(null)} onOutside={() => done(typed.current())}>
          <Editor held={typed} initial={editing.at === null ? null : (clauses[editing.at] ?? null)} fields={fields} byId={byId} ops={ops} choices={choices} onEditing={onEditing} onDone={done} />
        </Popover>
      )}
    </div>
  )
}

/** One condition being made or changed: its field first, then its test and value. A value picked from the list is taken at once; one typed, on Enter. */
function Editor({ held, initial, fields, byId, ops, choices, onEditing, onDone }: { held: { current: () => GridClause | null }; initial: GridClause | null; fields: readonly ConditionField[]; byId: Map<string, ConditionField>; ops: (field: string) => readonly GridClause['op'][]; choices?: (field: string) => Choice[] | null; onEditing?: (field: string | null) => void; onDone: (clause: GridClause | null) => void }) {
  const [field, setField] = useState(initial?.field ?? '')
  const [test, setTest] = useState<Test>(initial ? testOf(initial) : { op: 'eq' })
  const [typed, setTyped] = useState(initial && !valueless(initial) ? valueShown(initial, currencyOf(byId.get(initial.field)?.def)) : '')
  const [wrong, setWrong] = useState<string | null>(null)
  // The conditions on what a relation reaches, while a test of them is picked.
  const [where, setWhere] = useState<GridClause[]>(initial?.where ?? [])
  useEffect(() => {
    onEditing?.(field || null)
    return () => onEditing?.(null)
  }, [field]) // eslint-disable-line react-hooks/exhaustive-deps
  const made = (t: Test, value: string): GridClause => ({ field, op: t.op, value: valueless(t) ? '' : value, ...(t.not ? { not: true } : {}), ...(t.match ? { match: t.match, where } : {}) })
  const take = (t: Test, value: string) => onDone(made(t, value))
  // An amount of money is typed as money and kept as the number the field stores.
  const stored = (text: string) => storedText(text, valueless(test) ? undefined : byId.get(field)?.def?.format)
  const takeTyped = (t: Test, text: string) => {
    const read = stored(text)
    if ('error' in read) return setWrong(read.error)
    take(t, read.value)
  }
  // A value typed into the box, or the conditions set on what a relation reaches, is held for a press outside; a list is picked from, never held.
  held.current = () => {
    if (field && test.match) return made(test, '')
    if (!field || valueless(test) || choices?.(field) || !typed.trim()) return null
    const read = stored(typed.trim())
    return 'error' in read ? null : made(test, read.value)
  }
  if (!field) {
    return (
      <SearchList
        label="Field"
        placeholder="Filter by…"
        items={fields.map((f) => ({ key: f.id, text: f.title, item: f }))}
        draw={(f) => (
          <span className="flex min-w-0 items-center gap-2">
            {f.def ? <TypeGlyph def={f.def} /> : <span className="size-3 shrink-0" />}
            <span className="truncate">{f.title}</span>
          </span>
        )}
        onPick={(f) => {
          setField(f.id)
          setTest(firstTest(ops(f.id)))
          setTyped('')
        }}
      />
    )
  }
  const def = byId.get(field)
  const reach = def?.reaches
  const tests = testsOf(ops(field), reach)
  const shown = tests.some((t) => sameTest(t, test)) ? tests : [test, ...tests]
  const picks = valueless(test) ? null : (choices?.(field) ?? null)
  // The test turned round, for a value picked with a key held: eq is turned as neq.
  const turned = (t: Test): Test => (t.op === 'eq' ? { op: 'neq' } : t.op === 'neq' ? { op: 'eq' } : { op: t.op, ...(t.not ? {} : { not: true }) })
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-1 border-b border-ink-700 px-1.5 pt-1.5 pb-1">
        <button type="button" onClick={() => setField('')} className="flex min-w-0 items-center gap-1 rounded-sm px-1.5 py-1 text-[13px] font-medium text-ink-100 hover:bg-ink-800" title="Pick another field">
          <ChevronLeft className="size-3.5 shrink-0 text-ink-400" aria-hidden />
          <span className="truncate">{def?.title ?? field}</span>
        </button>
      </div>
      <div role="radiogroup" aria-label="Test" className="flex flex-wrap gap-1 px-2 pt-2">
        {shown.map((t) => {
          const on = sameTest(t, test)
          return (
            <button
              key={`${t.not ? '!' : ''}${t.op}`}
              type="button"
              role="radio"
              aria-checked={on}
              // A test that asks for no value is taken at once; one of what a relation reaches asks for its conditions first.
              onClick={() => (t.match ? setTest(t) : valueless(t) ? take(t, '') : setTest(t))}
              className={`rounded-full border px-2 py-0.5 text-[12px] ${on ? 'border-ink-300 bg-ink-700 text-ink-50' : 'border-ink-700 text-ink-300 hover:border-ink-500 hover:text-ink-100'}`}
            >
              {t.match && reach ? `${matchWords(t.match, reach.title)} where…` : testWords(t, def?.type)}
            </button>
          )
        })}
      </div>
      {test.match && reach ? (
        <div className="flex flex-col gap-2 p-2">
          <p className="text-[12px] text-ink-400">{test.match === 'all' ? `Keeps a row when it has at least one ${reach.title}, and every one meets these.` : test.match === 'none' ? `Keeps a row when none of its ${reach.title} meets these. With none set, it has no ${reach.title}.` : `Keeps a row when one of its ${reach.title} meets these. With none set, it has one.`}</p>
          <Conditions
            clauses={where}
            onChange={setWhere}
            fields={reach.fields}
            add="Condition"
            ops={(f) => {
              const inner = reach.fields.find((x) => x.id === f)
              return opsFor(inner?.type, f.startsWith('r:'), !!inner?.choices)
            }}
            choices={(f) => reach.fields.find((x) => x.id === f)?.choices ?? null}
          />
          <div className="flex justify-end">
            <button type="button" className="btn btn-solid" onClick={() => take(test, '')}>
              Apply
            </button>
          </div>
        </div>
      ) : valueless(test) ? null : picks ? (
        <SearchList<Choice>
          label="Value"
          placeholder="Search the values…"
          items={picks.map((p) => ({ key: p.value, text: p.label, item: p }))}
          current={initial?.field === field ? initial.value : undefined}
          typed={(q) => ({ key: `typed:${q}`, text: `Use “${q}”`, item: { value: q, label: q } })}
          draw={(p) => (
            <span className="flex min-w-0 flex-1 items-center gap-2">
              {p.color ? <Chip value={p.value} label={p.label} def={{ type: 'string', colors: { [p.value]: p.color } }} /> : <span className="min-w-0 truncate">{p.label}</span>}
              {p.count !== undefined && <span className="ml-auto shrink-0 font-mono text-[11px] text-ink-400 tabular-nums">{p.count.toLocaleString('en-US')}</span>}
            </span>
          )}
          onPick={(p, turn) => take(turn ? turned(test) : test, p.value)}
          foot={test.op === 'eq' || test.op === 'contains' ? 'Hold Ctrl or ⌘ as you pick to leave the value out.' : undefined}
        />
      ) : (
        <form
          className="flex gap-2 p-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (typed.trim()) takeTyped(test, typed.trim())
          }}
        >
          <input autoFocus className={`${input} min-w-0 flex-1 text-[13px]`} aria-label="Value" placeholder={hintFor(test, def?.type, currencyOf(def?.def))} value={typed} onChange={(e) => (setTyped(e.target.value), setWrong(null))} />
          <button type="submit" className="btn btn-solid" disabled={!typed.trim()}>
            Apply
          </button>
        </form>
      )}
      {wrong && (
        <p role="alert" className="px-3 pb-2 text-[12px] text-red">
          {wrong}
        </p>
      )}
    </div>
  )
}

interface Listed<T> {
  key: string
  text: string
  item: T
}

/** A search box over a list: typing narrows it, the arrows move, Enter or a click picks. A key held as it picks asks for the test turned round. */
function SearchList<T>({ label, placeholder, items, draw, onPick, current, typed, foot }: { label: string; placeholder: string; items: Listed<T>[]; draw: (item: T) => ReactNode; onPick: (item: T, turn: boolean) => void; current?: string; typed?: (q: string) => Listed<T>; foot?: string }) {
  const id = useId()
  const [q, setQ] = useState('')
  const [at, setAt] = useState(() => Math.max(0, current === undefined ? 0 : items.findIndex((i) => i.key === current)))
  const list = useRef<HTMLUListElement>(null)
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  const matched = useMemo(() => (words.length ? items.filter((i) => words.every((w) => i.text.toLowerCase().includes(w))) : items), [items, q]) // eslint-disable-line react-hooks/exhaustive-deps
  const extra = typed && q.trim() && !items.some((i) => i.text.toLowerCase() === q.trim().toLowerCase()) ? typed(q.trim()) : null
  const shown = [...matched.slice(0, SHOWN), ...(extra ? [extra] : [])]
  const move = (to: number) => {
    const next = Math.min(Math.max(to, 0), shown.length - 1)
    setAt(next)
    list.current?.querySelector(`#${CSS.escape(`${id}-${next}`)}`)?.scrollIntoView({ block: 'nearest' })
  }
  const keys = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      move(at + (e.key === 'ArrowDown' ? 1 : -1))
    } else if (e.key === 'Enter' && shown[at]) {
      e.preventDefault()
      onPick(shown[at].item, turning(e))
    }
  }
  const press = (e: MouseEvent, item: T) => {
    e.preventDefault()
    onPick(item, turning(e))
  }
  return (
    <div className="flex flex-col">
      <div className="p-2">
        <input
          autoFocus
          role="combobox"
          aria-label={label}
          aria-expanded
          aria-controls={`${id}-list`}
          aria-autocomplete="list"
          aria-activedescendant={shown[at] ? `${id}-${at}` : undefined}
          autoComplete="off"
          data-1p-ignore
          className={`${input} w-full text-[13px]`}
          placeholder={placeholder}
          value={q}
          onChange={(e) => (setQ(e.target.value), setAt(0))}
          onKeyDown={keys}
        />
      </div>
      <ul ref={list} id={`${id}-list`} role="listbox" aria-label={label} className="max-h-72 overflow-y-auto px-1 pb-1">
        {shown.map((i, n) => (
          <li
            key={i.key}
            id={`${id}-${n}`}
            role="option"
            aria-selected={n === at}
            onMouseDown={(e) => e.preventDefault()}
            onMouseEnter={() => setAt(n)}
            onClick={(e) => press(e, i.item)}
            // Control and a click is the menu's on a Mac: it turns the test round here too.
            onContextMenu={(e) => press(e, i.item)}
            className={`flex cursor-pointer items-center rounded-sm px-2 py-1.5 text-[13px] ${n === at ? 'bg-ink-800 text-ink-50' : 'text-ink-200'} ${current === i.key ? 'font-medium' : ''}`}
          >
            {i === extra ? <span className="truncate text-ink-200">{i.text}</span> : draw(i.item)}
          </li>
        ))}
        {!shown.length && <li className="px-2 py-1.5 text-[13px] text-ink-400">Nothing matches.</li>}
        {matched.length > SHOWN && <li className="px-2 py-1.5 text-[12px] text-ink-400">{matched.length - SHOWN} more: type to narrow.</li>}
      </ul>
      {foot && <p className="border-t border-ink-700 px-3 py-1.5 text-[11px] text-ink-400">{foot}</p>}
      <div className="sr-only" aria-live="polite">
        {`${shown.length} ${shown.length === 1 ? 'option' : 'options'}`}
      </div>
    </div>
  )
}
