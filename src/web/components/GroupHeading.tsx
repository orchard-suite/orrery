import { ArrowDown, ArrowUp, ArrowUpToLine, ChevronDown, ChevronRight, Eye, EyeOff, Folder, FolderOpen } from 'lucide-react'
import { useSyncExternalStore } from 'react'
import { useBlueprints, useCan, useSetCatalogLayout } from '../api.ts'
import type { StatusLevel } from '../../shared/model.ts'
import { worse } from '../now.ts'
import { Kicker, Lamp, LEVEL_NAME } from './ui.tsx'

// What this person opened or closed for themselves. It lives as long as the page: a reload goes back to what everyone shares.
const mine = new Map<string, boolean>()
// The groups this person asked to see the hidden blueprints of, kept the same way.
const revealed = new Set<string>()
const watchers = new Set<() => void>()
let version = 0
const watch = (fn: () => void) => (watchers.add(fn), () => void watchers.delete(fn))
const UNGROUPED = '\0'
const changed = () => {
  version++
  for (const fn of watchers) fn()
}

/** Whether a group is folded shut right now: this person's own choice, or else the shared default. `group` null is the blueprints with no group. */
export function useFolds(): { shut: (group: string | null) => boolean; toggle: (group: string | null) => void } {
  useSyncExternalStore(watch, () => version, () => version)
  const closed = useBlueprints().data?.layout.closed ?? []
  const shut = (group: string | null) => mine.get(group ?? UNGROUPED) ?? (group !== null && closed.includes(group))
  return {
    shut,
    toggle: (group) => {
      mine.set(group ?? UNGROUPED, !shut(group))
      changed()
    },
  }
}

/** Whether this person is looking at a group's hidden blueprints right now. Nobody is until they ask, and a reload forgets it. */
export function useReveals(): { shown: (group: string | null) => boolean; toggle: (group: string | null) => void } {
  useSyncExternalStore(watch, () => version, () => version)
  const shown = (group: string | null) => revealed.has(group ?? UNGROUPED)
  return {
    shown,
    toggle: (group) => {
      if (!revealed.delete(group ?? UNGROUPED)) revealed.add(group ?? UNGROUPED)
      changed()
    },
  }
}

/**
 * A group heading in a blueprint sidebar. A click folds the group shut or
 * open for this person, until they reload. The order of the headings and
 * which start closed are one shared view: whoever may organize the catalog
 * changes them from here, for everyone. `heading` null is the blueprints with
 * no group, which come last. With `hides`, the list under the heading leaves
 * the hidden blueprints out, and the heading is where a person asks to see
 * them.
 */
export function GroupHeading({ heading, hides = false, level, tuckedLevel }: { heading: string | null; hides?: boolean; /** The worst status of what the group lists, shown beside its name when it is not green. */ level?: StatusLevel; /** The worst status of the hidden items not listed, shown faint when it is worse than `level`. */ tuckedLevel?: StatusLevel }) {
  const blueprints = useBlueprints()
  const allowed = useCan('catalog.organize')
  const set = useSetCatalogLayout()
  const folds = useFolds()
  const reveals = useReveals()
  const all = blueprints.data?.blueprints ?? []
  // The headings as they stand now, which the hub already sorted.
  const groups = [...new Set(all.map((b) => b.group).filter((g): g is string => !!g))]
  const layout = blueprints.data?.layout
  const shut = folds.shut(heading)
  const members = all.filter((b) => (b.group ?? null) === heading)
  const tucked = hides ? members.filter((b) => layout?.hidden.includes(b.id)).length : 0
  const inside = members.length - tucked
  const button = 'rounded-sm p-0.5 text-ink-500 hover:bg-ink-700 hover:text-ink-100 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-ink-500'
  const revealing = reveals.shown(heading)
  const reveal = tucked > 0 && (
    <button
      type="button"
      className={`${button} ${revealing ? 'text-ink-300' : 'hidden group-focus-within/heading:inline-flex group-hover/heading:inline-flex'}`}
      title={revealing ? 'Stop showing the hidden items. It is yours alone' : `Show hidden items: ${tucked} in this group. It is yours alone: they are hidden again when you reload`}
      onClick={() => {
        // The hidden items are listed inside the group, so a closed group opens to show them.
        if (!revealing && shut) folds.toggle(heading)
        reveals.toggle(heading)
      }}
    >
      {revealing ? <Eye className="size-3" /> : <EyeOff className="size-3" />}
    </button>
  )
  const name = (
    <button type="button" className="flex min-w-0 flex-1 items-center gap-1 text-left hover:text-ink-200" title={shut ? 'Open this group. It is yours alone: it goes back to how it starts when you reload' : 'Close this group. It is yours alone: it goes back to how it starts when you reload'} onClick={() => folds.toggle(heading)}>
      {shut ? <ChevronRight className="size-3 shrink-0" /> : <ChevronDown className="size-3 shrink-0" />}
      <span className="min-w-0 break-words group-focus-within/heading:truncate group-hover/heading:truncate">{heading ?? 'Other'}</span>
      {/* With some kinds hidden from the list, the heading says how many it shows of how many there are. */}
      {tucked > 0 ? <span className="shrink-0 whitespace-nowrap text-ink-400" title={`${tucked} hidden from the list`}>{inside} of {members.length}</span> : shut && <span className="text-ink-400">{inside}</span>}
      {level && level !== 'green' && <Lamp level={level} className="ml-1" calm />}
      {tuckedLevel && tuckedLevel !== 'green' && worse(level ?? 'green', tuckedLevel) !== (level ?? 'green') && <Lamp level={tuckedLevel} faint calm className="ml-1" title={`A hidden item is ${LEVEL_NAME[tuckedLevel]}`} />}
    </button>
  )
  if (heading === null) return <Kicker className="group/heading flex items-center gap-0.5 px-2 pt-3 pb-1">{name}{reveal}</Kicker>
  const why = layout?.source ? `The layout of the catalog is declared in git by source "${layout.source}"; change it there` : !allowed ? 'The layout of the catalog is shared by everyone. Changing it needs the "catalog.organize" permission' : ''
  const startsShut = layout?.closed.includes(heading) ?? false
  const at = groups.indexOf(heading)
  const move = (to: number) => {
    const next = groups.filter((g) => g !== heading)
    next.splice(to, 0, heading)
    set.mutate({ order: next })
  }
  const startShut = () => set.mutate({ closed: startsShut ? (layout?.closed ?? []).filter((g) => g !== heading) : [...(layout?.closed ?? []), heading] })
  return (
    <Kicker className="group/heading flex items-center gap-0.5 px-2 pt-3 pb-1">
      {name}
      {reveal}
      {set.error && <span className="normal-case tracking-normal text-red" title={set.error.message}>!</span>}
      {why ? (
        startsShut && (
          <span className="p-0.5 text-ink-500" title={`Starts closed for everyone. ${why}`}>
            <Folder className="size-3" />
          </span>
        )
      ) : (
        <>
          <span className="hidden group-focus-within/heading:flex group-hover/heading:flex">
            <button type="button" className={button} disabled={at === 0 || set.isPending} title="Pin to the top, for everyone" onClick={() => move(0)}>
              <ArrowUpToLine className="size-3" />
            </button>
            <button type="button" className={button} disabled={at === 0 || set.isPending} title="Move up, for everyone" onClick={() => move(at - 1)}>
              <ArrowUp className="size-3" />
            </button>
            <button type="button" className={button} disabled={at === groups.length - 1 || set.isPending} title="Move down, for everyone" onClick={() => move(at + 1)}>
              <ArrowDown className="size-3" />
            </button>
          </span>
          <button type="button" className={`${button} ${startsShut ? 'text-ink-300' : 'hidden group-focus-within/heading:inline-flex group-hover/heading:inline-flex'}`} disabled={set.isPending} title={startsShut ? 'Starts closed for everyone. Click to make it start open' : 'Starts open for everyone. Click to make it start closed'} onClick={startShut}>
            {startsShut ? <Folder className="size-3" /> : <FolderOpen className="size-3" />}
          </button>
        </>
      )}
    </Kicker>
  )
}
