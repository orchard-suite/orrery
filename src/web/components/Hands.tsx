// Hands: one action on several things at once. A reader ticks things on a
// ground or a map, picks one action every one of them may run, fills its form
// once, and each thing gets its own run, so each is recorded, approved, and
// refused on its own. Only a thing the reader may run an action on can be
// ticked, so where there is none there is no box and no tray. The tray says
// what is ticked and offers the actions.

import { useState } from 'react'
import type { ScheduleTarget } from '../../shared/api.ts'
import { narrowingInputs, type ActionRun, type ActionView } from '../../shared/model.ts'
import { useActions, useEntity, useRunAction } from '../api.ts'
import { counted, sharedActions } from '../ground.ts'
import { Icon } from '../icons.tsx'
import { ActionForm } from './ActionForm.tsx'
import { Drawer } from './Drawer.tsx'
import { Button, ErrorNote, Link } from './ui.tsx'

/** A thing that may be ticked: what it is, and the actions its reader may run on it. */
export interface Tickable {
  blueprint: string
  key: string
  title: string
  actions: string[]
}

export const tickId = (t: Pick<Tickable, 'blueprint' | 'key'>) => `${t.blueprint}:${t.key}`

/** What is ticked, by id, with a way to tick or untick some at once. */
export function useTicks(): [ReadonlySet<string>, (ids: readonly string[], on: boolean) => void, () => void] {
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set())
  const tick = (ids: readonly string[], on: boolean) =>
    setTicked((was) => {
      const next = new Set(was)
      for (const id of ids) {
        if (on) next.add(id)
        else next.delete(id)
      }
      return next
    })
  return [ticked, tick, () => setTicked(new Set())]
}

/** Whether the reader may run any action on any of these: only then does a view draw a tick box at all. */
export const tickable = (things: readonly Pick<Tickable, 'actions'>[]) => things.some((t) => t.actions.length > 0)

/** The ids of those of some things the reader may run an action on: what a tick takes. */
export const tickIds = (things: readonly Tickable[]) => things.filter((t) => t.actions.length > 0).map(tickId)

/** The tray along the bottom while anything is ticked: how many, the actions they share, and a way to let go. */
export function HandsTray({ chosen, noun, onClear }: { chosen: Tickable[]; noun: [string, string]; onClear: () => void }) {
  const actions = useActions().data?.actions ?? []
  const [running, setRunning] = useState<ActionView | null>(null)
  if (!chosen.length) return null
  const runnable = actions.filter((a) => a.canRun)
  const shared = sharedActions(
    chosen,
    runnable.map((a) => a.id),
  ).flatMap((id) => runnable.find((a) => a.id === id) ?? [])
  return (
    <>
      {/* On a desk the tray is the shell's last row, so the stage gives it room. On a phone it docks over the tab bar, and the page keeps room under its content for it. */}
      <div aria-hidden className="h-28 desk:hidden" />
      <div role="region" aria-label="Ticked" className="fixed inset-x-0 bottom-[var(--tab-bar)] z-30 border-t border-ink-700 bg-ink-900 elevate-pop md:bottom-0 md:left-(--rail) desk:static desk:mt-3 desk:shrink-0 desk:rounded-xl desk:border">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-2 px-4 py-3 md:pr-8 md:pl-4 desk:max-w-none desk:px-4 desk:py-2">
          <span className="mr-1 text-sm font-medium text-ink-50">
            {counted(chosen.length, noun[0], noun[1])} ticked
          </span>
          {shared.map((a) => (
            <Button key={a.id} title={a.description ?? a.title} opens="dialog" onClick={() => setRunning(a)} className="flex items-center gap-1.5">
              <Icon name={a.icon ?? 'rocket'} className="size-3.5" />
              {a.title}
            </Button>
          ))}
          {shared.length === 0 && <span className="text-[13px] text-ink-300">No action you may run fits every one of them.</span>}
          <Button onClick={onClear} className="ml-auto">
            Clear
          </Button>
        </div>
      </div>
      {running && <Hands action={running} items={chosen} onClose={() => setRunning(null)} />}
    </>
  )
}

/**
 * What running an action later on the ticked things runs on: the one thing
 * as its form would, or every ticked thing as one batch where the action
 * runs on many. An action that does not cannot be put off for several.
 */
function laterOn(action: ActionView, items: Tickable[]): { target: ScheduleTarget; title: string } | null | undefined {
  if (items.length === 1) return undefined
  if (!action.batch) return null
  return { target: { entities: items.map((i) => ({ blueprint: i.blueprint, key: i.key })) }, title: `${action.title} on ${items.length.toLocaleString('en-US')} ticked` }
}

interface Outcome {
  key: string
  title: string
  run?: ActionRun
  refused?: string
}

/**
 * One action on several things. The form is filled once, on the first of
 * them; what was typed is then asked of each of the rest. Every thing gets
 * its own run, so each is recorded, approved, and refused on its own.
 */
function Hands({ action, items, onClose }: { action: ActionView; items: Tickable[]; onClose: () => void }) {
  const first = items[0]!
  const entity = useEntity({ blueprint: first.blueprint, key: first.key })
  const run = useRunAction()
  const [outcomes, setOutcomes] = useState<Outcome[] | null>(null)
  const [changed, setChanged] = useState(false)
  const left = outcomes ? items.length - outcomes.length : 0
  const rest = async (done: ActionRun, sent: Record<string, unknown>) => {
    // An input that narrows the target is what each thing holds: the hub fills it in for each.
    const narrowing = narrowingInputs(action)
    const inputs = Object.fromEntries(Object.entries(sent).filter(([name]) => !narrowing.includes(name)))
    const out: Outcome[] = [{ key: tickId(first), title: first.title, run: done }]
    setOutcomes([...out])
    for (const item of items.slice(1)) {
      try {
        out.push({ key: tickId(item), title: item.title, run: await run.mutateAsync({ id: action.id, entity: { blueprint: item.blueprint, key: item.key }, inputs }) })
      } catch (e) {
        out.push({ key: tickId(item), title: item.title, refused: e instanceof Error ? e.message : String(e) })
      }
      setOutcomes([...out])
    }
  }
  return (
    // While runs are still being asked for the drawer stays, so the answers are read where they were asked.
    <Drawer title={action.title} icon={<Icon name={action.icon ?? 'rocket'} className="size-6" />} subtitle={<p>{outcomes ? `Asked for ${outcomes.length} of ${items.length}.` : `On ${items.length} of them. Fill it in once, on ${first.title}; each gets its own run.`}</p>} onClose={left > 0 ? () => undefined : onClose} unsaved={changed && !outcomes}>
      {outcomes ? (
        <div className="space-y-4 p-4">
          <ul aria-live="polite" className="space-y-2 text-sm">
            {outcomes.map((o) => (
              <li key={o.key} className="rounded-md border border-ink-700 px-3 py-2">
                <span className="font-medium text-ink-100">{o.title}</span>
                {o.run ? (
                  <Link to={{ page: 'action-run', id: o.run.id }} className="ml-2 text-[13px] text-ink-200 underline underline-offset-4">
                    {o.run.state === 'awaiting' ? 'Waiting for approval' : 'Asked'}
                  </Link>
                ) : (
                  <span className="mt-0.5 block text-[13px] text-red">Refused: {o.refused}</span>
                )}
              </li>
            ))}
          </ul>
          {left > 0 ? (
            <p className="text-[13px] text-ink-400">Asking for {left} more…</p>
          ) : (
            <Button kind="solid" onClick={onClose}>
              Done
            </Button>
          )}
        </div>
      ) : entity.data ? (
        <ActionForm action={action} entity={entity.data} layout="drawer" onCancel={onClose} onChanged={setChanged} onDone={(done, sent) => void rest(done, sent)} later={laterOn(action, items)} />
      ) : (
        <div className="p-4">{entity.error ? <ErrorNote error={entity.error} /> : <p className="text-[13px] text-ink-400">Loading…</p>}</div>
      )}
    </Drawer>
  )
}
