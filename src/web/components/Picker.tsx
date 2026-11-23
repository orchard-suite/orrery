import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { input, Kicker } from './ui.tsx'

export interface PickerOption {
  id: string
  label: string
  /** A line under the label, such as the id or what kind of thing it is. */
  note?: string
  /** A heading the option is listed under. */
  group?: string
}

/** The most options a search lists at once; typing narrows the rest. */
const SHOWN = 60
/** The tallest the list grows, and the least room below the box before it opens above instead. */
const TALLEST = 320
const LEAST = 160

/**
 * Where the list sits, fixed to the window, so no box that scrolls or clips
 * round the picker cuts it short. It stays inside the picker in the page, so a
 * popover or drawer round it still holds it as its own.
 */
interface Place {
  left: number
  width: number
  top?: number
  bottom?: number
  height: number
}

function placeBy(box: HTMLElement): Place {
  const r = box.getBoundingClientRect()
  const below = window.innerHeight - r.bottom - 12
  const above = r.top - 12
  if (below >= LEAST || below >= above) return { left: r.left, width: r.width, top: r.bottom + 4, height: Math.min(TALLEST, below) }
  return { left: r.left, width: r.width, bottom: window.innerHeight - r.top + 4, height: Math.min(TALLEST, above) }
}

/**
 * Pick one of many by typing: a search box whose matches drop down below it
 * (above, where there is more room there), grouped, moved through by the arrow keys and taken by Enter. For a list too
 * long for a select.
 */
export function Picker({ label, options, value, onChange, placeholder, typed }: { label: string; options: PickerOption[]; value: string | null; onChange: (id: string | null) => void; placeholder: string; /** An option for what was typed, when no option is it, such as an address nobody has yet. */ typed?: (q: string) => PickerOption | null }) {
  const id = useId()
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const [at, setAt] = useState(0)
  const box = useRef<HTMLInputElement>(null)
  const [place, setPlace] = useState<Place | null>(null)
  useLayoutEffect(() => {
    const input = box.current
    if (!open || !input) return setPlace(null)
    const follow = () => setPlace(placeBy(input))
    follow()
    window.addEventListener('scroll', follow, true)
    window.addEventListener('resize', follow)
    return () => {
      window.removeEventListener('scroll', follow, true)
      window.removeEventListener('resize', follow)
    }
  }, [open])
  const picked = options.find((o) => o.id === value) ?? null
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  const matches = useMemo(() => options.filter((o) => words.every((w) => `${o.label} ${o.note ?? ''}`.toLowerCase().includes(w))), [options, q])
  const extra = typed && q.trim() && !options.some((o) => o.id.toLowerCase() === q.trim().toLowerCase()) ? typed(q.trim()) : null
  const shown = [...(extra ? [extra] : []), ...matches.slice(0, SHOWN)]
  const take = (o: PickerOption) => {
    onChange(o.id)
    setQ('')
    setOpen(false)
  }
  return (
    <div className="relative min-w-0 flex-1 basis-64">
      <label htmlFor={id} className="block">
        <Kicker>{label}</Kicker>
      </label>
      <input
        ref={box}
        id={id}
        role="combobox"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-activedescendant={open && shown[at] ? `${id}-${at}` : undefined}
        aria-autocomplete="list"
        autoComplete="off"
        data-1p-ignore
        data-lpignore="true"
        data-form-type="other"
        className={`${input} mt-1 w-full`}
        value={open ? q : (picked?.label ?? '')}
        placeholder={placeholder}
        onFocus={() => (setOpen(true), setAt(0))}
        onBlur={() => setOpen(false)}
        onChange={(e) => (setQ(e.target.value), setOpen(true), setAt(0))}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') (e.preventDefault(), setOpen(true), setAt((i) => Math.min(i + 1, shown.length - 1)))
          else if (e.key === 'ArrowUp') (e.preventDefault(), setAt((i) => Math.max(i - 1, 0)))
          else if (e.key === 'Enter' && open && shown[at]) (e.preventDefault(), take(shown[at]))
          else if (e.key === 'Escape' && open) (e.stopPropagation(), setOpen(false), setQ(''))
        }}
      />
      {open && place && (
        <ul id={`${id}-list`} role="listbox" aria-label={label} style={{ position: 'fixed', left: place.left, width: place.width, top: place.top, bottom: place.bottom, maxHeight: place.height }} className="z-50 overflow-y-auto rounded-md border border-edge bg-ink-900 py-1 text-sm shadow-lg shadow-ink-950/40">
          {shown.map((o, i) => (
            <li key={o.id}>
              {o.group && o.group !== shown[i - 1]?.group && <div className="px-3 pt-2 pb-1 text-[12px] font-medium text-ink-400">{o.group}</div>}
              <div
                id={`${id}-${i}`}
                role="option"
                aria-selected={i === at}
                className={`cursor-pointer px-3 py-1.5 ${i === at ? 'bg-ink-800 text-ink-50' : 'text-ink-200'}`}
                onMouseDown={(e) => (e.preventDefault(), take(o))}
                onMouseEnter={() => setAt(i)}
              >
                <div className="truncate">{o.label}</div>
                {o.note && <div className="truncate font-mono text-[12px] text-ink-500">{o.note}</div>}
              </div>
            </li>
          ))}
          {!shown.length && <li className="px-3 py-2 text-ink-400">Nothing matches.</li>}
          {matches.length > SHOWN && <li className="px-3 py-2 text-[12px] text-ink-400">{matches.length - SHOWN} more: type to narrow.</li>}
        </ul>
      )}
    </div>
  )
}
