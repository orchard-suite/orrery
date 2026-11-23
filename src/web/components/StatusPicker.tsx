import { ChevronDown } from 'lucide-react'
import { useRef, useState, type ReactNode } from 'react'
import { STATUS_LEVELS, type StatusLevel } from '../../shared/model.ts'
import { Popover } from './Popover.tsx'
import { Lamp, LEVEL_NAME } from './ui.tsx'

/** The levels a person most often wants alone: everything that is not well. */
const ATTENTION: StatusLevel[] = ['red', 'amber']

const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1)

/** What a pick is called on its button and in the grid's count line. */
export function statusWords(picked: StatusLevel[]): string {
  if (sameLevels(picked, ATTENTION)) return 'needs attention'
  return STATUS_LEVELS.filter((l) => picked.includes(l))
    .map((l) => LEVEL_NAME[l])
    .join(' or ')
}

function sameLevels(a: StatusLevel[], b: StatusLevel[]): boolean {
  return a.length === b.length && b.every((l) => a.includes(l))
}

/**
 * Which status levels a grid shows. None picked shows every row. Each level
 * carries its lamp's shape and spoken name and a count of the rows that hold
 * it, counted without this pick so every level keeps its number. A desk shows
 * the levels side by side; a narrow toolbar shows one button that opens them.
 */
export function StatusPicker({ picked, counts, onChange, compact }: { picked: StatusLevel[]; counts: Partial<Record<StatusLevel, number>>; onChange: (next: StatusLevel[]) => void; compact: boolean }) {
  const toggle = (l: StatusLevel) => onChange(picked.includes(l) ? picked.filter((p) => p !== l) : STATUS_LEVELS.filter((s) => s === l || picked.includes(s)))
  const count = (l: StatusLevel) => <span className="font-mono text-[11px] text-ink-400 tabular-nums">{(counts[l] ?? 0).toLocaleString('en-US')}</span>
  if (!compact) {
    return (
      <div role="group" aria-label="Show rows by status" className="flex overflow-hidden rounded-md border border-ink-600">
        {STATUS_LEVELS.map((l) => {
          const on = picked.includes(l)
          return (
            <button key={l} type="button" aria-pressed={on} onClick={() => toggle(l)} title={on ? `Stop showing only ${LEVEL_NAME[l]} rows` : `Show ${LEVEL_NAME[l]} rows`} className={`flex items-center gap-1.5 border-r border-ink-600 px-2.5 py-1 text-[13px] last:border-r-0 ${on ? 'bg-ink-700 text-ink-100 shadow-[inset_0_-2px_0_var(--color-orbit)]' : 'text-ink-300 hover:bg-ink-800 hover:text-ink-100'}`}>
              <Lamp level={l} />
              {cap(LEVEL_NAME[l])}
              {count(l)}
            </button>
          )
        })}
      </div>
    )
  }
  return <CompactPicker picked={picked} onChange={onChange} toggle={toggle} count={count} />
}

function CompactPicker({ picked, onChange, toggle, count }: { picked: StatusLevel[]; onChange: (next: StatusLevel[]) => void; toggle: (l: StatusLevel) => void; count: (l: StatusLevel) => ReactNode }) {
  const button = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const on = picked.length > 0
  return (
    <>
      <button ref={button} type="button" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)} className={`btn max-md:py-1 ${on ? 'border-ink-300 bg-ink-800 text-ink-100' : 'btn-ghost'}`}>
        {on ? STATUS_LEVELS.filter((l) => picked.includes(l)).map((l) => <Lamp key={l} level={l} />) : null}
        {on ? cap(statusWords(picked)) : 'Status'}
        <ChevronDown className="size-3.5" aria-hidden />
      </button>
      {open && button.current && (
        <Popover anchor={button.current} width={240} label="Show rows by status" onClose={() => setOpen(false)}>
          <div className="p-1.5">
            {STATUS_LEVELS.map((l) => (
              <label key={l} className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-[13px] hover:bg-ink-800 max-md:py-2.5">
                <input type="checkbox" checked={picked.includes(l)} onChange={() => toggle(l)} />
                <Lamp level={l} />
                <span className="flex-1 text-ink-100">{cap(LEVEL_NAME[l])}</span>
                {count(l)}
              </label>
            ))}
            <div className="my-1 h-px bg-ink-700" />
            <button type="button" className="block w-full rounded-sm px-2 py-1.5 text-left text-[12px] text-ink-300 hover:bg-ink-800" onClick={() => (onChange(ATTENTION), setOpen(false))}>
              <span className="text-orbit">Needs attention</span> · failing and warning
            </button>
            <button type="button" className="block w-full rounded-sm px-2 py-1.5 text-left text-[12px] text-ink-300 hover:bg-ink-800" onClick={() => (onChange([]), setOpen(false))}>
              <span className="text-orbit">Everything</span> · every status
            </button>
          </div>
        </Popover>
      )}
    </>
  )
}
