// A picker for one option out of many: type to narrow the list, arrows to
// move, Enter to pick. It follows the ARIA combobox pattern, so a screen
// reader hears the list, the option under the cursor, and how many match.

import { X } from 'lucide-react'
import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { input } from './ui.tsx'

export interface ComboOption {
  id: string
  label: string
  /** A line of words under the label the search also reads, such as a few of an entity's fields. It is read with what is picked. */
  line?: string
  /** A second, quieter line of text the search also reads, such as a key. */
  detail?: string
  /** A short mark after the label, such as "running now". */
  note?: string
}

/** How many options are drawn at once. Typing narrows the rest in. */
const SHOWN = 100

/**
 * Given `onQuery`, the list is searched elsewhere: what is typed is handed to
 * it, `options` are already the matches, `more` counts the matches past them,
 * and `current` is what is picked when it is not among them.
 */
export function Combobox({ id, options, value, onChange, loading = false, placeholder = 'Type to search', describedBy, invalid = false, required = false, onQuery, more = 0, current }: { id?: string; options: ComboOption[]; value: string | null; onChange: (id: string | null) => void; loading?: boolean; placeholder?: string; describedBy?: string; invalid?: boolean; required?: boolean; onQuery?: (query: string) => void; more?: number; current?: ComboOption | null }) {
  const own = useId()
  const inputId = id ?? own
  const listId = `${inputId}-list`
  const lineId = `${inputId}-line`
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const list = useRef<HTMLUListElement>(null)
  const picked = options.find((o) => o.id === value) ?? (current && current.id === value ? current : null)
  const matched = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q && !onQuery ? options.filter((o) => o.label.toLowerCase().includes(q) || o.line?.toLowerCase().includes(q) || o.detail?.toLowerCase().includes(q)) : options
  }, [options, query, onQuery])
  const shown = matched.slice(0, SHOWN)
  const past = matched.length - shown.length + more
  const ask = (next: string) => {
    setQuery(next)
    onQuery?.(next)
  }

  const show = (index: number) => {
    setActive(index)
    list.current?.querySelector(`#${CSS.escape(`${listId}-${index}`)}`)?.scrollIntoView({ block: 'nearest' })
  }
  const pick = (option: ComboOption) => {
    onChange(option.id)
    setOpen(false)
    ask('')
  }
  const keys = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!open) return (setOpen(true), show(picked ? Math.max(0, shown.indexOf(picked)) : 0))
      const by = event.key === 'ArrowDown' ? 1 : -1
      show(Math.min(Math.max(active + by, 0), shown.length - 1))
    } else if (event.key === 'Enter' && open) {
      event.preventDefault()
      if (shown[active]) pick(shown[active])
    } else if (event.key === 'Escape' && open) {
      // The list closes first; a second Escape closes whatever holds the picker.
      event.stopPropagation()
      setOpen(false)
      ask('')
    }
  }

  return (
    <div className="relative">
      <div className="relative">
        <input
          id={inputId}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && shown[active] ? `${listId}-${active}` : undefined}
          aria-describedby={[describedBy, picked?.line && !open ? lineId : null].filter(Boolean).join(' ') || undefined}
          aria-invalid={invalid || undefined}
          aria-required={required || undefined}
          autoComplete="off"
          className={`${input} w-full pr-8`}
          placeholder={loading ? 'Loading…' : options.length || onQuery ? placeholder : 'Nothing to pick from'}
          value={open ? query : (picked?.label ?? '')}
          onChange={(e) => (ask(e.target.value), setOpen(true), setActive(0))}
          onClick={() => setOpen(true)}
          onBlur={() => (setOpen(false), ask(''))}
          onKeyDown={keys}
        />
        {picked && !open && (
          <button type="button" aria-label={`Clear ${picked.label}`} title="Clear" onClick={() => onChange(null)} className="absolute inset-y-0 right-1 my-auto flex size-6 items-center justify-center rounded-sm text-ink-400 hover:text-ink-100">
            <X className="size-3.5" />
          </button>
        )}
      </div>
      {picked?.line && !open && (
        <div id={lineId} className="mt-1 break-words text-[13px] text-ink-300">
          {picked.line}
        </div>
      )}
      {picked?.detail && !open && <div className="mt-1 break-all font-mono text-[12px] text-ink-400">{picked.detail}</div>}
      <ul ref={list} id={listId} role="listbox" hidden={!open} className="absolute inset-x-0 z-10 mt-1 max-h-64 overflow-y-auto rounded-sm border border-ink-600 bg-ink-850 py-1 elevate-pop">
        {shown.map((o, i) => (
          <li
            key={o.id}
            id={`${listId}-${i}`}
            role="option"
            aria-selected={o.id === value}
            onMouseDown={(e) => e.preventDefault()}
            onMouseEnter={() => setActive(i)}
            onClick={() => pick(o)}
            className={`cursor-pointer px-3 py-1.5 text-sm ${i === active ? 'bg-ink-700 text-ink-100' : 'text-ink-200'}`}
          >
            {/* Options often differ only at the end, such as a version, so nothing is cut: the label and the detail each wrap. */}
            <div className="flex items-baseline gap-2">
              <span className="min-w-0 break-all">{o.label}</span>
              {o.note && <span className="ml-auto shrink-0 font-mono text-[10px] text-green">{o.note}</span>}
            </div>
            {o.line && <div className="break-words text-[13px] text-ink-300">{o.line}</div>}
            {o.detail && <div className="break-all font-mono text-[12px] text-ink-400">{o.detail}</div>}
          </li>
        ))}
        {!shown.length && <li className="px-3 py-1.5 text-sm text-ink-400">{loading ? 'Loading…' : 'Nothing matches'}</li>}
        {past > 0 && <li className="px-3 py-1.5 font-mono text-[12px] text-ink-400">{past} more: type to narrow</li>}
      </ul>
      <div className="sr-only" aria-live="polite">
        {open ? `${matched.length + more} ${matched.length + more === 1 ? 'option' : 'options'}` : ''}
      </div>
    </div>
  )
}
