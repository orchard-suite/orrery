// The saved queries an entity is home to, on its own page: the collection a
// program or a team keeps, each opened on the query page. Only the queries the
// reader may open are listed, and nothing is drawn for an entity that is home
// to none.

import { House, Table2 } from 'lucide-react'
import { useId } from 'react'
import type { Entity } from '../../shared/model.ts'
import { useSavedQueries } from '../api.ts'
import { shortName } from '../query.ts'
import { Link } from './ui.tsx'

export function HomeQueries({ entity }: { entity: Entity }) {
  const list = useSavedQueries()
  const id = useId()
  const mine = (list.data?.queries ?? []).filter((q) => q.home?.id === entity.id).sort((a, b) => a.title.localeCompare(b.title))
  if (!mine.length) return null
  return (
    <section aria-labelledby={id}>
      <h2 id={id} className="label">
        Queries
      </h2>
      <ul className="mt-1.5 grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-2">
        {mine.map((q) => (
          <li key={q.id}>
            <Link to={{ page: 'query', id: q.id }} className="flex h-full gap-3 rounded-lg border border-ink-700 bg-ink-900 px-3 py-2.5 hover:border-ink-500">
              <Table2 aria-hidden className="mt-0.5 size-4 shrink-0 text-ink-300" />
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-medium break-words text-ink-50">{q.title}</span>
                {q.description && <span className="mt-0.5 line-clamp-2 block text-[12px] text-ink-300">{q.description}</span>}
                <span className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[12px] text-ink-400">
                  {q.homeShared && <House aria-label="Open to the people of this home" className="size-3.5" />}
                  {shortName(q.owner)}
                  <span aria-hidden>·</span>
                  {q.spec.sources.length === 1 ? '1 blueprint' : `${q.spec.sources.length} blueprints`}
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}
