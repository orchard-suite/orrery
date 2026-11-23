// Find anything, in every blueprint at once. Most visits from a phone are a
// look-up, so this page is one tap from anywhere on one. What a title holds
// ranks first; a match in a key or a value follows.

import { ChevronRight, Search as SearchIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useBlueprintName, useBlueprints, useSearch, useSummary } from '../api.ts'
import { areasOf } from '../now.ts'
import { BlueprintIcon, Icon } from '../icons.tsx'
import { rank } from './Command.tsx'
import { ErrorNote, input, Lamp, Link } from './ui.tsx'
import { useVisit } from '../trail.ts'

export function SearchPage() {
  const [query, setQuery] = useVisit('search.query', '')
  const [asked, setAsked] = useVisit('search.asked', '')
  // A pause in typing asks; every key does not.
  useEffect(() => {
    const t = setTimeout(() => setAsked(query.trim()), 200)
    return () => clearTimeout(t)
  }, [query])
  const found = useSearch(asked)
  const blueprints = useBlueprints().data?.blueprints ?? []
  const byId = new Map(blueprints.map((b) => [b.id, b]))
  const name = useBlueprintName()
  const summary = useSummary()
  const areas = summary.data ? areasOf(blueprints, summary.data, name).filter((a) => a.count > 0) : []
  const box = useRef<HTMLInputElement>(null)
  useEffect(() => box.current?.focus(), [])
  const words = asked.toLowerCase()
  const results = asked ? [...(found.data?.entities ?? [])].sort((a, b) => rank(a.title, words) - rank(b.title, words) || a.title.localeCompare(b.title)) : []
  // The blueprints in the order their best match ranks, each with its matches.
  const sections = [...new Set(results.map((e) => e.blueprint))].map((id) => ({ id, items: results.filter((e) => e.blueprint === id) }))
  const total = found.data?.total ?? 0
  return (
    <div className="space-y-4 py-3">
      <h1 className="sr-only">Search</h1>
      <div className="relative">
        <SearchIcon className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-500" aria-hidden />
        <input ref={box} type="search" enterKeyHint="search" className={`${input} w-full py-2.5 pl-9 text-base`} aria-label="Search everything" placeholder="Search every kind" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      <ErrorNote error={found.error} />
      {!asked && (
        <>
          <p className="px-1 text-sm text-ink-400">Type a name, a key, or a value. Every kind you can see is searched. Or start from a kind:</p>
          <div className="space-y-4">
            {areas.map((area) => (
              <section key={area.name} aria-label={area.name}>
                <h2 className="mb-1.5 px-1 text-[13px] font-semibold text-ink-300">{area.name}</h2>
                <div className="flex flex-wrap gap-1.5">
                  {area.kinds
                    .filter((k) => k.count > 0)
                    .sort((a, b) => b.count - a.count)
                    .map((k) => (
                      <Link key={k.id} to={{ page: 'inventory', blueprint: k.id }} className="inline-flex min-h-9 items-center gap-1.5 rounded-full border border-ink-700 px-3 text-[13px] text-ink-200">
                        {k.level !== 'green' && <Lamp level={k.level} calm />}
                        {k.title}
                        <span className="text-[12px] text-ink-400 tabular-nums">{k.count.toLocaleString('en-US')}</span>
                      </Link>
                    ))}
                </div>
              </section>
            ))}
          </div>
        </>
      )}
      {asked && found.data && results.length === 0 && <p className="px-1 text-sm text-ink-400">Nothing holds “{asked}”.</p>}
      {asked && total > results.length && (
        <p className="px-1 text-[12px] text-ink-400">
          Showing {results.length} of {total}. Add a word to narrow it.
        </p>
      )}
      <div role="status" className="sr-only">
        {asked && found.data ? `${total} found` : ''}
      </div>
      {sections.map(({ id, items }) => {
        const bp = byId.get(id)
        return (
          <section key={id}>
            <h2 className="mb-1.5 flex items-center gap-2 px-1 text-[13px] font-semibold text-ink-300">
              <BlueprintIcon bp={bp} className="size-3.5 text-ink-400" />
              {name(bp ?? id)}
              <span className="font-normal text-ink-500">· {items.length}</span>
            </h2>
            <ul className="divide-y divide-ink-800 overflow-hidden rounded-xl border border-ink-700 bg-ink-900/70">
              {items.map((e) => (
                <li key={e.id}>
                  <Link to={{ page: 'entity', blueprint: e.blueprint, key: e.key }} className="flex items-center gap-3 px-3 py-2.5">
                    <Lamp level={e.status.level} calm />
                    <Icon name={e.icon ?? bp?.icon} className="size-4 shrink-0 text-ink-300" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[15px] font-medium text-ink-100">{e.title}</span>
                      {e.key.toLowerCase() !== e.title.toLowerCase() && <span className="block truncate font-mono text-[12px] text-ink-400">{e.key}</span>}
                    </span>
                    <ChevronRight className="size-4 shrink-0 text-ink-500" aria-hidden />
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )
      })}
    </div>
  )
}
