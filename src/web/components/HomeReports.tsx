// The reports an entity is home to, on its own page: each opens on its newest
// edition. Only the reports the reader may see are listed, and nothing is
// drawn for an entity that is home to none.

import { FileChartColumn } from 'lucide-react'
import { useId } from 'react'
import type { Entity } from '../../shared/model.ts'
import { useReports } from '../api.ts'
import { ago } from '../format.ts'
import { nextOf } from '../report.ts'
import { Link } from './ui.tsx'

export function HomeReports({ entity }: { entity: Entity }) {
  const list = useReports(entity.id)
  const id = useId()
  const mine = list.data?.reports ?? []
  if (!mine.length) return null
  return (
    <section aria-labelledby={id}>
      <h2 id={id} className="label">
        Reports
      </h2>
      <ul className="mt-1.5 grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-2">
        {mine.map((r) => (
          <li key={r.key}>
            <Link to={{ page: 'report', key: r.key }} className="flex h-full gap-3 rounded-lg border border-ink-700 bg-ink-900 px-3 py-2.5 hover:border-ink-500">
              <FileChartColumn aria-hidden className="mt-0.5 size-4 shrink-0 text-ink-300" />
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-medium break-words text-ink-50">{r.title}</span>
                {r.latest && <span className="mt-0.5 line-clamp-2 block text-[12px] text-ink-300">{r.latest.summary}</span>}
                <span className="mt-1 block text-[12px] text-ink-400">
                  {r.latest ? `Edition ${r.latest.number}, ${ago(r.latest.publishedAt)}` : 'Never published'} · {nextOf(r)}
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}
