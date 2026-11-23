// The catalog's kinds, in its areas, as the rail beside every page shows
// them: each with how many there are and, when it is not green, its lamp.

import { ArrowDown, ArrowUp, Eye, EyeOff, FolderOpen } from 'lucide-react'
import { useEffect, useId, useRef, type CSSProperties } from 'react'
import { UNGROUPED } from '../../shared/api.ts'
import type { Blueprint, StatusLevel } from '../../shared/model.ts'
import { pinnedOf } from '../actions.ts'
import { useBlueprintName, useBlueprints, useCan, useMyApprovals, usePins, useSetCatalogLayout } from '../api.ts'
import { BlueprintIcon } from '../icons.tsx'
import { worse } from '../now.ts'
import { GroupHeading, useFolds, useReveals } from './GroupHeading.tsx'
import { PinMoves, PinStar, usePinMoves } from './Star.tsx'
import { Lamp, Link, WaitingBadge } from './ui.tsx'

const areaLevel = (levels: StatusLevel[]): StatusLevel => levels.reduce(worse, 'green')

/**
 * The statuses a group heading shows. Hidden items are the architect's
 * background noise: while they are hidden, the heading's lamp is the worst of
 * what it lists, and theirs shows only as a faint outline. Once a person shows
 * them, they count like any other row.
 */
export function headingLevels(listed: Blueprint[], tucked: Blueprint[], levels: Record<string, StatusLevel>): { level: StatusLevel; tuckedLevel: StatusLevel } {
  const of = (list: Blueprint[]) => areaLevel(list.map((b) => levels[b.id] ?? 'green'))
  return { level: of(listed), tuckedLevel: of(tucked) }
}

/**
 * A group's order with `id` stepped over its neighbour in `among`, the list it
 * sits in: the shown ones, or the hidden ones. Whatever is in the other list
 * keeps its place in the order. Null when there is no neighbour that way.
 */
export function moved(members: string[], among: string[], id: string, by: -1 | 1): string[] | null {
  const neighbour = among[among.indexOf(id) + by]
  if (neighbour === undefined || !among.includes(id)) return null
  const next = members.filter((other) => other !== id)
  next.splice(next.indexOf(neighbour) + (by > 0 ? 1 : 0), 0, id)
  return next
}

/**
 * The catalog's list of blueprints, in the layout everyone shares. What the
 * person starred comes first too, in the order they keep, and stays in
 * its group as well: a star is one more way in, theirs alone, and never moves
 * a thing from where everyone finds it. They move a starred one for
 * themselves from its row under Starred. Under each heading come the group's
 * blueprints, and then the hidden ones in a folder of their own, once this
 * person asks for them or searches for one. Whoever may organize the catalog
 * moves and hides a blueprint from its row, for everyone; a hidden one moves
 * among the hidden ones.
 */
export function KindList({ list, counts, levels, current }: { list: Blueprint[]; counts: Record<string, number>; levels: Record<string, StatusLevel>; current: string | undefined }) {
  const search = ''
  const layout = useBlueprints().data?.layout
  const allowed = useCan('catalog.organize') && !layout?.source
  const set = useSetCatalogLayout()
  const folds = useFolds()
  const reveals = useReveals()
  const hidden = new Set(layout?.hidden ?? [])
  const name = useBlueprintName()
  // The approvals blueprint says how many of its records wait for the reader's decision.
  const approvals = useMyApprovals()
  const starred = pinnedOf(usePins().data ?? [], list, 'blueprint')
  // The arrow a shared move was made with: its row is put back in the page once the hub answers, which drops the focus.
  const base = useId()
  const held = useRef<string | null>(null)
  const places = list.map((b) => b.id).join('\n')
  useEffect(() => {
    if (!held.current) return
    document.getElementById(held.current)?.focus()
    held.current = null
  }, [places])
  const moves = usePinMoves(starred.map((b) => ({ kind: 'blueprint', id: b.id })))
  const found = (b: Blueprint) => !search || name(b).toLowerCase().includes(search)
  const button = 'rounded-sm p-0.5 text-ink-500 hover:bg-ink-700 hover:text-ink-100 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-ink-500'
  /**
   * The way into a blueprint's grid, with what it says of it: its lamp, what waits, how many there are. The count keeps a
   * column of its own at the row's end. `controls` is how many small buttons the row's controls hold beside its star:
   * while the row is pointed at or holds the focus they sit just before the count, and the count makes room for them.
   */
  const link = (b: Blueprint, away: boolean, controls: number) => (
    <Link start to={{ page: 'inventory', blueprint: b.id }} current={current === b.id} className="flex min-w-0 flex-1 items-center gap-2.5 px-2.5 py-1.5 text-[13px]" title={b.description} style={{ '--controls': `${1.75 + controls + 0.25}rem` } as CSSProperties}>
      <BlueprintIcon bp={b} className="size-4 shrink-0 text-ink-400" />
      <span className={`min-w-0 flex-1 break-words group-focus-within/row:truncate group-hover/row:truncate ${away ? 'text-ink-500' : ''}`}>{name(b)}</span>
      {levels[b.id] && levels[b.id] !== 'green' && <Lamp level={levels[b.id]!} calm />}
      {approvals?.blueprint === b.id && <WaitingBadge n={approvals.waiting} title={`${approvals.waiting} ${approvals.waiting === 1 ? 'approval waits' : 'approvals wait'} for your decision`} />}
      <span className="box-content w-12 shrink-0 text-right text-[12px] text-ink-400 tabular-nums group-focus-within/row:pl-(--controls) group-hover/row:pl-(--controls)">{(counts[b.id] ?? 0).toLocaleString('en-US')}</span>
    </Link>
  )
  const star = (b: Blueprint) => <PinStar pin={{ kind: 'blueprint', id: b.id }} name={name(b)} className="size-5 rounded-sm" />
  // A row's controls sit in the room its count makes before itself while the row is pointed at or holds the focus. They
  // are only faded out the rest of the time, never taken out of the page, so a control a move was made with can take the
  // focus back once its row moves.
  const controlsLook = 'absolute inset-y-0 right-[calc(3rem+0.625rem)] flex items-center opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100'
  const rowLook = (b: Blueprint) => `group/row relative flex items-center rounded-lg ${current === b.id ? 'bg-ink-800 text-ink-50' : 'text-ink-200 hover:bg-ink-850'}`
  return (
    <>
      {set.error && <div className="px-2 py-1 text-xs text-red">{set.error.message}</div>}
      {starred.some(found) && (
        <div>
          <div className="px-2.5 pt-1.5 pb-1 text-[12px] font-medium text-ink-400">Starred</div>
          <div className="space-y-px">
            {starred.filter(found).map((b, i) => (
              <div key={b.id} className={rowLook(b)}>
                {link(b, false, moves.movable ? 2 : 0)}
                <span className={controlsLook}>
                  {star(b)}
                  <PinMoves moves={moves} pin={{ kind: 'blueprint', id: b.id }} name={name(b)} at={i} of={starred.length} look={(off) => `${button} ${off ? 'opacity-30 hover:bg-transparent hover:text-ink-500' : ''}`} />
                </span>
              </div>
            ))}
          </div>
          <p aria-live="polite" className="sr-only">
            {moves.said}
          </p>
        </div>
      )}
      {[...new Set(list.map((b) => b.group ?? null))].map((group) => {
        const members = list.filter((b) => (b.group ?? null) === group)
        if (!members.some(found)) return null
        const shown = members.filter((b) => !hidden.has(b.id))
        const tucked = members.filter((b) => hidden.has(b.id))
        const revealing = tucked.length > 0 && (search ? tucked.some(found) : reveals.shown(group))
        const move = (among: Blueprint[], id: string, by: -1 | 1) => {
          const next = moved(members.map((b) => b.id), among.map((b) => b.id), id, by)
          if (!next || set.isPending) return
          held.current = `${base}-${id}-${by < 0 ? 'up' : 'down'}`
          set.mutate({ blueprints: { [group ?? UNGROUPED]: next } })
        }
        const row = (b: Blueprint) => {
          const away = hidden.has(b.id)
          const among = away ? tucked : shown
          const at = among.indexOf(b)
          const arrows = (
            <>
              <button type="button" id={`${base}-${b.id}-up`} className={`${button} ${at === 0 ? 'opacity-30 hover:bg-transparent hover:text-ink-500' : ''}`} aria-disabled={at === 0 || undefined} aria-label={`Move ${name(b)} up, for everyone`} title="Move up, for everyone" onClick={() => move(among, b.id, -1)}>
                <ArrowUp aria-hidden className="size-3" />
              </button>
              <button type="button" id={`${base}-${b.id}-down`} className={`${button} ${at === among.length - 1 ? 'opacity-30 hover:bg-transparent hover:text-ink-500' : ''}`} aria-disabled={at === among.length - 1 || undefined} aria-label={`Move ${name(b)} down, for everyone`} title="Move down, for everyone" onClick={() => move(among, b.id, 1)}>
                <ArrowDown aria-hidden className="size-3" />
              </button>
            </>
          )
          return (
            <div key={b.id} className={`${rowLook(b)} ${away ? 'pl-4' : ''}`}>
              {link(b, away, allowed ? 3 : 0)}
              <span className={controlsLook}>
                {star(b)}
                {allowed && arrows}
                {allowed && (away ? (
                    <button type="button" className={button} disabled={set.isPending} title="Show in the list again, for everyone" onClick={() => set.mutate({ hidden: [...hidden].filter((id) => id !== b.id) })}>
                      <Eye className="size-3" />
                    </button>
                  ) : (
                    <button type="button" className={button} disabled={set.isPending} title="Hide from the list, for everyone. It stays in the group's hidden items" onClick={() => set.mutate({ hidden: [...hidden, b.id] })}>
                      <EyeOff className="size-3" />
                    </button>
                  ))}
              </span>
            </div>
          )
        }
        return (
          <div key={group ?? UNGROUPED}>
            <GroupHeading heading={group} hides {...headingLevels(revealing ? members : shown, revealing ? [] : tucked, levels)} />
            {(search || !folds.shut(group)) && (
              <div className="space-y-px">
                {shown.filter(found).map(row)}
                {revealing && (
                  <>
                    <button type="button" className="flex w-full items-center gap-2 px-2 pt-1.5 pb-0.5 text-left text-xs text-ink-500 hover:text-ink-200 disabled:hover:text-ink-500" disabled={!!search} title={search ? 'Hidden items that match what you typed' : 'Stop showing the hidden items'} onClick={() => reveals.toggle(group)}>
                      <FolderOpen className="size-3.5 shrink-0" />
                      <span>Hidden items</span>
                      <span className="ml-auto text-[12px] tabular-nums">{tucked.length}</span>
                    </button>
                    {tucked.filter(found).map(row)}
                  </>
                )}
              </div>
            )}
          </div>
        )
      })}
    </>
  )
}

