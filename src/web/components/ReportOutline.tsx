// A report's layout on its record, as an outline a person reads: the data it
// names and one line a block. The Markdown itself folds under it.

import { useId } from 'react'
import { parseLayout } from '../../shared/report.ts'
import { blockLine } from '../report.ts'

export function ReportOutline({ layout }: { layout: string }) {
  const id = useId()
  const read = parseLayout(layout)
  return (
    <section aria-labelledby={id} className="rounded-lg border border-ink-700 bg-ink-900/70">
      <h2 id={id} className="label border-b border-ink-700 px-4 py-2.5">
        Layout
      </h2>
      <div className="space-y-3 px-4 py-3">
        {read.layout ? (
          <>
            <ul className="flex flex-wrap gap-1.5" aria-label="Data">
              {Object.entries(read.layout.data).map(([name, def]) => (
                <li key={name} className="rounded-sm bg-ink-800 px-2 py-0.5 text-[12px] text-ink-200">
                  <span className="font-mono">{name}</span> <span className="text-ink-400">{'query' in def ? 'saved query' : `tool ${def.tool}`}</span>
                </li>
              ))}
            </ul>
            <ol className="space-y-1">
              {read.layout.blocks.map((b) => {
                const line = blockLine(b)
                return (
                  <li key={b.line} className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-2 text-[13px]">
                    <span className="text-ink-400">{line.kind}</span>
                    <span className="line-clamp-2 text-ink-100">{line.says}</span>
                  </li>
                )
              })}
            </ol>
          </>
        ) : (
          <p className="text-[13px] text-ink-300">This layout does not read: {read.issues[0]?.message}</p>
        )}
        <details>
          <summary className="cursor-pointer text-[12px] text-ink-300 hover:text-ink-100">Show the Markdown</summary>
          <pre className="mt-2 max-h-96 overflow-auto rounded bg-ink-900 p-2 font-mono text-[11px] whitespace-pre-wrap text-ink-200">{layout}</pre>
        </details>
      </div>
    </section>
  )
}
