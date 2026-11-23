// Every blueprint as a list a thumb can work, in the catalog's groups: where
// a phone starts the catalog and the model. A group folds shut and opens the
// way it does in the rail on a desk, and starts as everyone shares it. The
// blueprints hidden from the catalog wait inside their group until this person
// asks for them or searches for one. Where a page passes what the person
// starred, those come first, under Starred, and stay in their groups too;
// under Starred, the person moves each a place up or down for themselves.

import { ChevronDown, ChevronRight, EyeOff, FolderOpen, Search } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { UNGROUPED } from '../../shared/api.ts'
import type { Blueprint } from '../../shared/model.ts'
import { useBlueprintName } from '../api.ts'
import { BlueprintIcon } from '../icons.tsx'
import type { Route } from '../router.ts'
import { useFolds, useReveals } from './GroupHeading.tsx'
import { PinMoves, usePinMoves } from './Star.tsx'
import { Empty, input, Link } from './ui.tsx'

/** A count of entities, in words. */
export const entities = (n: number) => `${n} ${n === 1 ? 'entity' : 'entities'}`

export function BlueprintIndex({ title, intro, all, counts, hidden = new Set(), to, details, actions, starred = [] }: { title: string; intro: string; all: Blueprint[]; counts: Record<string, number>; hidden?: ReadonlySet<string>; to: (id: string) => Route; details?: (b: Blueprint) => ReactNode; /** Buttons under the intro, such as a new blueprint. */ actions?: ReactNode; /** What the person starred, in their order: listed first. */ starred?: Blueprint[] }) {
  const [find, setFind] = useState('')
  const name = useBlueprintName()
  const folds = useFolds()
  const reveals = useReveals()
  const words = find.trim().toLowerCase()
  const found = (b: Blueprint) => !words || name(b).toLowerCase().includes(words)
  const moves = usePinMoves(starred.map((b) => ({ kind: 'blueprint', id: b.id })))
  /** A blueprint's row, and under Starred its place among the starred (`at`), to move it from. */
  const row = (b: Blueprint, at?: number) => (
    <li key={b.id} className="flex items-center">
      <Link to={to(b.id)} className={`flex min-w-0 flex-1 items-center gap-3 px-3 py-3 ${hidden.has(b.id) ? 'pl-6' : ''}`}>
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-ink-800 text-ink-200">
          <BlueprintIcon bp={b} className="size-4.5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className={`block truncate text-[15px] font-medium ${hidden.has(b.id) ? 'text-ink-400' : 'text-ink-100'}`}>{name(b)}</span>
          <span className="block truncate text-[12px] text-ink-400">{details ? details(b) : entities(counts[b.id] ?? 0)}</span>
        </span>
        {!(at !== undefined && moves.movable) && <ChevronRight className="size-4 shrink-0 text-ink-500" aria-hidden />}
      </Link>
      {at !== undefined && <PinMoves moves={moves} pin={{ kind: 'blueprint', id: b.id }} name={name(b)} at={at} of={starred.length} look={(off) => `grid size-10 shrink-0 place-items-center rounded-md text-ink-400 last:mr-1 ${off ? 'opacity-40' : 'active:bg-ink-800'}`} />}
    </li>
  )
  const groups = [...new Set(all.map((b) => b.group ?? null))]
  return (
    <div className="space-y-3 pt-2 pb-6">
      <h1 className="page-title">{title}</h1>
      <p className="text-sm text-ink-400">{intro}</p>
      {actions}
      {all.length === 0 ? (
        <Empty>No blueprints yet. Build one on the Model page.</Empty>
      ) : (
        <>
          <div className="relative">
            <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-500" aria-hidden />
            <input type="search" className={`${input} w-full py-2.5 pl-9 text-base`} aria-label="Find a blueprint" placeholder="Find a blueprint" value={find} onChange={(e) => setFind(e.target.value)} />
          </div>
          <ul className="-mx-3 divide-y divide-ink-800 border-y border-ink-800">
            {starred.some(found) && (
              <li>
                <div className="bg-ink-950/40 px-3 py-2.5 text-[12px] font-medium text-ink-400">Starred</div>
                {/* A search lists only some of them, so they move only from the whole list. */}
                <ul className="divide-y divide-ink-800 border-t border-ink-800">{words ? starred.filter(found).map((b) => row(b)) : starred.map((b, i) => row(b, i))}</ul>
                <p aria-live="polite" className="sr-only">
                  {moves.said}
                </p>
              </li>
            )}
            {groups.map((group) => {
              const members = all.filter((b) => (b.group ?? null) === group)
              if (!members.some(found)) return null
              const shown = members.filter((b) => !hidden.has(b.id))
              const tucked = members.filter((b) => hidden.has(b.id))
              // A search opens every group and finds the hidden blueprints too, as the rail does.
              const open = !!words || !folds.shut(group)
              const revealing = tucked.length > 0 && (words ? tucked.some(found) : reveals.shown(group))
              return (
                <li key={group ?? UNGROUPED}>
                  <button type="button" aria-expanded={open} disabled={!!words} onClick={() => folds.toggle(group)} className="flex w-full items-center gap-2 bg-ink-950/40 px-3 py-2.5 text-left text-[12px] font-medium text-ink-400">
                    {open ? <ChevronDown className="size-4 shrink-0" aria-hidden /> : <ChevronRight className="size-4 shrink-0" aria-hidden />}
                    <span className="min-w-0 flex-1 truncate">{group ?? 'Other'}</span>
                    <span className="shrink-0 tabular-nums">{tucked.length > 0 ? `${shown.length} of ${members.length}` : members.length}</span>
                  </button>
                  {open && (
                    <ul className="divide-y divide-ink-800 border-t border-ink-800">
                      {shown.filter(found).map((b) => row(b))}
                      {tucked.length > 0 && !words && (
                        <li>
                          <button type="button" aria-expanded={revealing} onClick={() => reveals.toggle(group)} className="flex w-full items-center gap-2 px-3 py-3 text-left text-[13px] text-ink-400">
                            {revealing ? <FolderOpen className="size-4 shrink-0" aria-hidden /> : <EyeOff className="size-4 shrink-0" aria-hidden />}
                            <span className="flex-1">{revealing ? 'Hide the hidden items' : 'Show hidden items'}</span>
                            <span className="shrink-0 tabular-nums">{tucked.length}</span>
                          </button>
                        </li>
                      )}
                      {revealing && tucked.filter(found).map((b) => row(b))}
                    </ul>
                  )}
                </li>
              )
            })}
          </ul>
          {!all.some(found) && <p className="text-sm text-ink-400">No blueprint is called that.</p>}
        </>
      )}
    </div>
  )
}
