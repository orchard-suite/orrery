// What a run does to a list an entity holds, drawn the one way: the confirm
// step of the form, the run's page, and so whoever approves it, all show what
// it adds and what it removes, with what it keeps folded under a count. A
// change is marked by a sign and a word, never by colour alone.

import { Minus, Plus } from 'lucide-react'
import type { ReactNode } from 'react'
import type { ListChange } from '../../shared/list-change.ts'

export function ListChangeView({ change, text }: { change: ListChange; text: (value: unknown) => string }) {
  const { added, removed, unchanged } = change
  if (!added.length && !removed.length) return <p className="text-sm text-ink-300">Nothing changes.</p>
  return (
    <div className="space-y-2 text-sm">
      {added.length > 0 && <Part title="Added" values={added} text={text} sign={<Plus aria-hidden className="mt-0.5 size-3.5 shrink-0 text-green" />} />}
      {removed.length > 0 && <Part title="Removed" values={removed} text={text} sign={<Minus aria-hidden className="mt-0.5 size-3.5 shrink-0 text-red" />} strike />}
      {unchanged.length > 0 && (
        <details>
          <summary className="cursor-pointer text-ink-300">Unchanged ({unchanged.length.toLocaleString('en-US')})</summary>
          <ul className="mt-1 space-y-0.5 pl-5">
            {unchanged.map((v) => (
              <li key={JSON.stringify(v)} className="break-all font-mono text-[12px] text-ink-300">
                {text(v)}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}

function Part({ title, values, text, sign, strike = false }: { title: string; values: unknown[]; text: (value: unknown) => string; sign: ReactNode; strike?: boolean }) {
  return (
    <div>
      <p className="font-medium text-ink-100">
        {title} ({values.length.toLocaleString('en-US')})
      </p>
      <ul aria-label={title} className="mt-0.5 space-y-0.5">
        {values.map((v) => (
          <li key={JSON.stringify(v)} className="flex items-start gap-1.5">
            {sign}
            <span className={`min-w-0 break-all font-mono text-[12px] text-ink-100 ${strike ? 'line-through decoration-ink-400' : ''}`}>{text(v)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
