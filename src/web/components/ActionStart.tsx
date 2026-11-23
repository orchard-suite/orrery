// The parts of the Self-service start page above and inside its sections:
// what waits for the reader, what they pinned, what they ran last, and one
// action as a tile.

import { Hourglass, Info, Lock, TriangleAlert, UserCheck } from 'lucide-react'
import { useId, useState, type ReactNode } from 'react'
import type { ActionRun, ActionView, Entity, Pin } from '../../shared/model.ts'
import { failing, homeOf, iconOf, named, pinnedOf, recent, targetOf, waitingWords } from '../actions.ts'
import type { ActionSchedule } from '../../shared/api.ts'
import { useActions, useApprovals, useOwnRuns, usePins, useScheduleApprovals, useScheduleControl, useSetApprovals, useViewingAs } from '../api.ts'
import { SetDecide } from './ChangeSet.tsx'
import { setSaid } from '../change-sets.ts'
import { PinMoves, PinStar, usePinMoves } from './Star.tsx'
import { ago, when } from '../format.ts'
import { Icon } from '../icons.tsx'
import { RunDrawer } from './ActionForm.tsx'
import { DecideButtons, RowDecide, RunMark } from './ActionRun.tsx'
import { Button, ErrorNote, Link } from './ui.tsx'

/** How many waiting runs, change sets, and schedules the band shows before it sends the reader to the rest. */
const BAND = 3

/**
 * The runs and schedules that wait for the reader's word, at the top of the
 * start page: how many, the first few to approve or decline where they are,
 * and a way to the rest. Nothing is drawn while nothing waits.
 */
export function ApprovalsBand({ onSeeAll }: { onSeeAll: () => void }) {
  const { runs } = useApprovals()
  const sets = useSetApprovals()
  const schedules = useScheduleApprovals()
  const actions = useActions().data?.actions ?? []
  const id = useId()
  if (!runs.length && !sets.length && !schedules.length) return null
  const titleOf = (action: string) => actions.find((a) => a.id === action)?.title ?? action
  return (
    <section aria-labelledby={id} className="rounded-lg border border-amber/50 bg-ink-900/70 px-4 pt-3 pb-1.5">
      <div className="flex items-center gap-2">
        <Hourglass aria-hidden className="size-4 shrink-0 text-amber" />
        <h2 id={id} className="min-w-0 flex-1 text-sm font-semibold text-ink-50">
          {waitingWords({ runs: runs.length, sets: sets.length, schedules: schedules.length })}
        </h2>
        <Button onClick={onSeeAll} title="Open everything that needs your approval">
          See all
        </Button>
      </div>
      <ul className="mt-2 divide-y divide-ink-800/70 border-t border-ink-800/70">
        {sets.slice(0, BAND).map((s) => (
          <li key={s.id} className="flex flex-wrap items-center gap-x-4 gap-y-1.5 py-2">
            <div className="flex min-w-0 flex-1 basis-64 flex-wrap items-baseline gap-x-2.5">
              <Link to={{ page: 'action-set', id: s.id }} className="text-sm font-medium text-ink-50 hover:underline">
                {s.title}
              </Link>
              <span className="min-w-0 truncate text-[13px] text-ink-300">{setSaid(s)}</span>
              <span className="text-[12px] text-ink-400">
                asked by {s.by},{' '}
                <time dateTime={s.createdAt} title={when(s.createdAt)}>
                  {ago(s.createdAt)}
                </time>
              </span>
            </div>
            <SetDecide set={s} what={`change set ${s.title}, asked by ${s.by}`} />
          </li>
        ))}
        {runs.slice(0, Math.max(0, BAND - sets.length)).map((r) => {
          const title = titleOf(r.action)
          const on = targetOf(r)
          return (
            <li key={r.id} className="flex flex-wrap items-center gap-x-4 gap-y-1.5 py-2">
              <div className="flex min-w-0 flex-1 basis-64 flex-wrap items-baseline gap-x-2.5">
                <Link to={{ page: 'action-run', id: r.id }} className="text-sm font-medium text-ink-50 hover:underline">
                  {title}
                </Link>
                {on && <span className="min-w-0 truncate text-[13px] text-ink-300">{on}</span>}
                <span className="text-[12px] text-ink-400">
                  asked by {r.by},{' '}
                  <time dateTime={r.createdAt} title={when(r.createdAt)}>
                    {ago(r.createdAt)}
                  </time>
                </span>
              </div>
              <RowDecide run={r} what={`${named(title, r)}, asked by ${r.by}`} />
            </li>
          )
        })}
        {schedules.slice(0, Math.max(0, BAND - sets.length - runs.length)).map((s) => (
          <li key={s.id} className="flex flex-wrap items-center gap-x-4 gap-y-1.5 py-2">
            <div className="flex min-w-0 flex-1 basis-64 flex-wrap items-baseline gap-x-2.5">
              <Link to={{ page: 'action-schedules' }} className="text-sm font-medium text-ink-50 hover:underline">
                {s.title}
              </Link>
              <span className="min-w-0 text-[13px] text-ink-300">
                {titleOf(s.action)}
                {s.targetTitle ? ` on ${s.targetTitle}` : ''} · {s.when}
              </span>
              <span className="text-[12px] text-ink-400">
                asked by {s.owner},{' '}
                <time dateTime={s.createdAt} title={when(s.createdAt)}>
                  {ago(s.createdAt)}
                </time>
              </span>
            </div>
            <ScheduleDecide schedule={s} what={`schedule ${s.title}, asked by ${s.owner}`} />
          </li>
        ))}
      </ul>
    </section>
  )
}

/** Approve or decline a schedule where it waits. A decline asks why, since its owner reads it. */
function ScheduleDecide({ schedule, what }: { schedule: ActionSchedule; what: string }) {
  const control = useScheduleControl(schedule.id)
  return (
    <DecideButtons
      what={what}
      busy={control.approve.isPending || control.decline.isPending}
      error={control.approve.error ?? control.decline.error}
      onApprove={() => control.approve.mutate()}
      onDecline={() => {
        const why = prompt('Why decline it? The owner reads this.')
        if (why !== null) control.decline.mutate(why)
      }}
    />
  )
}

/**
 * What the reader ran last, one row for each action and target, each to run
 * again from the entity and the inputs it had. It reads their own runs and
 * keeps nothing. `actions` are the ones the page offers: a run of any other
 * is left out, since there is no form here to run it from.
 */
export function Recent({ actions, onAgain }: { actions: ActionView[]; onAgain: (action: ActionView, run: ActionRun) => void }) {
  const own = useOwnRuns()
  const id = useId()
  const offered = new Map(actions.map((a) => [a.id, a]))
  const runs = recent((own.data?.runs ?? []).filter((r) => offered.has(r.action)))
  return (
    <section aria-labelledby={id} className="min-w-0">
      <h2 id={id} className="py-1 text-[13px] font-medium text-ink-300">
        Recent
      </h2>
      {runs.length === 0 ? (
        <p className="mt-1 text-[13px] text-ink-400">{own.isLoading ? 'Loading…' : 'What you run shows here.'}</p>
      ) : (
        <ul className="mt-1 divide-y divide-ink-800/70 border-y border-ink-800/70">
          {runs.map((r) => {
            const action = offered.get(r.action)!
            const on = targetOf(r)
            return (
              <li key={r.id} className="flex min-h-10 items-center gap-2.5 px-1 py-1">
                <RunMark state={r.state} />
                <Link to={{ page: 'action-run', id: r.id }} className="min-w-0 truncate text-sm font-medium text-ink-50 hover:underline" title="Open this run">
                  {action.title}
                </Link>
                {on && <span className="min-w-0 truncate text-[13px] text-ink-300">{on}</span>}
                <time dateTime={r.createdAt} title={when(r.createdAt)} className="ml-auto shrink-0 pl-1 text-[12px] text-ink-400">
                  {ago(r.createdAt)}
                </time>
                {action.canRun && (
                  <Button opens="dialog" onClick={() => onAgain(action, r)} title="Open its form as this run was filled in" className="shrink-0">
                    Again<span className="sr-only">: {named(action.title, r)}</span>
                  </Button>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

/**
 * The star that pins an action to the top of the reader's own start page, or
 * lets it go: filled while it is pinned. There is none while viewing as
 * someone, whose pins are not the viewer's to change, and none against a hub
 * that keeps no pins.
 */
/**
 * What the reader pinned, as tiles in the order they keep them, each to move
 * a place earlier or later. It is theirs alone and the hub keeps it, so it is
 * the same in every browser. `actions` are the ones the page offers: a pin to
 * any other is left out. An admin viewing as someone reads that person's pins
 * and moves none.
 */
export function Pinned({ actions, onRun }: { actions: ActionView[]; onRun: (action: ActionView) => void }) {
  const pins = usePins()
  const viewing = useViewingAs()
  const id = useId()
  const pinned = pinnedOf(pins.data ?? [], actions)
  const moves = usePinMoves(pinned.map((a): Pin => ({ kind: 'action', id: a.id })))
  // A hub that keeps no pins has no such section.
  if (pins.data === null) return null
  const mover = (off: boolean) => `relative z-10 flex size-7 shrink-0 items-center justify-center rounded-md text-ink-400 ${off ? 'opacity-40' : 'hover:bg-ink-800 hover:text-ink-100'}`
  return (
    <section aria-labelledby={id} className="min-w-0">
      <h2 id={id} className="py-1 text-[13px] font-medium text-ink-300">
        Pinned
      </h2>
      {pins.isError ? (
        <ErrorNote error={pins.error} />
      ) : pinned.length === 0 ? (
        <p className="mt-1 text-[13px] text-ink-400">{pins.isLoading ? 'Loading…' : viewing ? 'Nothing pinned.' : 'Star an action to keep it here.'}</p>
      ) : (
        <ul className="mt-1.5 grid grid-cols-[minmax(0,1fr)] gap-2">
          {pinned.map((a, i) => (
            <Tile key={a.id} action={a} onRun={() => onRun(a)}>
              <PinMoves moves={moves} pin={{ kind: 'action', id: a.id }} name={a.title} at={i} of={pinned.length} look={mover} />
            </Tile>
          ))}
        </ul>
      )}
      <p aria-live="polite" className="sr-only">
        {moves.said}
      </p>
    </section>
  )
}

/** What a person should know of an action before they run it, each as a mark of its own shape with its words for a hover and a screen reader. */
function Marks({ action }: { action: ActionView }) {
  const fails = failing(action)
  return (
    <>
      {action.approval && (
        <span title="Needs approval" className="flex shrink-0 items-center text-amber">
          <UserCheck aria-hidden className="size-3.5" />
          <span className="sr-only">. Needs approval</span>
        </span>
      )}
      {fails && (
        <span title={fails} className="flex shrink-0 items-center text-red">
          <TriangleAlert aria-hidden className="size-3.5" />
          <span className="sr-only">. {fails}</span>
        </span>
      )}
    </>
  )
}

/**
 * One action as a tile in its section: its icon and its title, and nothing
 * else to read. The tile runs the action, and a small control beside it opens
 * the action's page. For someone who may change the action and not run it,
 * the tile is the link to its page. The description is a hover and a screen
 * reader's description here, and is read in full at the top of the form. Its
 * star pins it; `children` are the controls a section adds before the star.
 */
export function Tile({ action, onRun, children }: { action: ActionView; onRun: () => void; children?: ReactNode }) {
  const id = useId()
  // The one control that covers the tile.
  const cover = "after:absolute after:inset-0 after:content-['']"
  const about = action.description ? `${id}-about` : undefined
  return (
    <li className="relative flex min-h-11 items-center gap-2.5 rounded-lg border border-ink-700 bg-ink-900/60 py-1.5 pr-1.5 pl-3 transition-colors hover:border-ink-500 hover:bg-ink-850 focus-within:border-ink-500 focus-within:bg-ink-850">
      <Icon name={iconOf(action)} className="size-5 shrink-0" />
      {action.canRun ? (
        <>
          <button type="button" aria-haspopup="dialog" title={action.description} aria-describedby={about} onClick={onRun} className={`flex min-w-0 flex-1 items-center gap-2 rounded-sm text-left ${cover}`}>
            <span className="min-w-0 truncate text-sm font-medium text-ink-100">
              <span className="sr-only">Run </span>
              {action.title}
            </span>
            <Marks action={action} />
          </button>
          <Link to={{ page: 'actions', id: action.id }} label={`Details of ${action.title}`} title="Details: its form, its runs, and its definition" className="relative z-10 flex size-7 shrink-0 items-center justify-center rounded-md text-ink-400 hover:bg-ink-800 hover:text-ink-100">
            <Info aria-hidden className="size-4" />
          </Link>
        </>
      ) : (
        <Link to={{ page: 'actions', id: action.id }} title={action.description} describedBy={about} className={`flex min-w-0 flex-1 items-center gap-2 rounded-sm ${cover}`}>
          <span className="min-w-0 truncate text-sm font-medium text-ink-200">{action.title}</span>
          <Marks action={action} />
          <span title="You may edit it, not run it" className="mr-1.5 ml-auto flex shrink-0 items-center text-ink-400">
            <Lock aria-hidden className="size-3.5" />
            <span className="sr-only">. You may edit it, not run it</span>
          </span>
        </Link>
      )}
      {children}
      <PinStar pin={{ kind: 'action', id: action.id }} name={action.title} />
      {about && (
        <span id={about} className="sr-only">
          {action.description}
        </span>
      )}
    </li>
  )
}

/**
 * The actions an entity is home to, on its own page: a tile each, as on the
 * start page. Nothing is drawn for an entity that is home to none. A tile's
 * form opens on the entity where the action runs on it, and plain otherwise.
 */
export function HomeActions({ entity }: { entity: Entity }) {
  const actions = useActions()
  const [open, setOpen] = useState<ActionView | null>(null)
  const id = useId()
  const mine = (actions.data?.actions ?? []).filter((a) => a.form !== false && a.listed !== false && homeOf(a)?.id === entity.id).sort((a, b) => a.title.localeCompare(b.title))
  if (!mine.length) return null
  return (
    <section aria-labelledby={id}>
      <h2 id={id} className="label">
        Actions
      </h2>
      <ul className="mt-1.5 grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-2">
        {mine.map((a) => (
          <Tile key={a.id} action={a} onRun={() => setOpen(a)} />
        ))}
      </ul>
      {open && <RunDrawer action={open} entity={(entity.actions ?? []).includes(open.id) ? entity : undefined} onClose={() => setOpen(null)} />}
    </section>
  )
}
