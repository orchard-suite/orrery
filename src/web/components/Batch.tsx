// Batches in the web app: one action run on many things at once. From a grid,
// a person ticks things (or ticks every one a filter matches), picks an action
// that runs on many, and fills its form once. Before anything is sent the
// drawer lists every thing it would run on, and the ones it would not, with
// why. Sent, each thing gets its own run, and the batch's page shows them all
// as a grid of cards: how each stands, what it said, and the picture it
// reported, so a person reads a thousand at a glance and opens the ones that
// need a look. A thing whose run failed is asked again from there, one at a
// time or all of them.

import { CalendarClock, Check, ChevronRight, Circle, CircleHelp, Hourglass, ImageOff, Minus, RotateCcw, Square, X } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import type { ActionBatchResponse, BatchItem, BatchRequest } from '../../shared/api.ts'
import { isFinished, type ActionRunState, type ActionView } from '../../shared/model.ts'
import { unbatchable } from '../../shared/action-spec.ts'
import { inputEmpty } from '../../shared/input-kinds.ts'
import { iconOf, inputShown } from '../actions.ts'
import { runImageUrl, useActionBatch, useActions, useBatchControl, useBatchPreview, useBlueprintName, useStartBatch } from '../api.ts'
import { roughly } from '../../shared/estimate.ts'
import { ago, duration } from '../format.ts'
import { Icon } from '../icons.tsx'
import { navigate } from '../router.ts'
import { ActionForm } from './ActionForm.tsx'
import { STATE_WORD } from './ActionRun.tsx'
import { BAR, ORDER, batchTook } from './BatchLine.tsx'
import { ScheduleDrawer, startCadence } from './Schedules.tsx'
import { Drawer } from './Drawer.tsx'
import { Button, Empty, ErrorNote, Kicker, Link, Panel, input } from './ui.tsx'
import { useHere, useVisit } from '../trail.ts'

/** The most names the drawer lists before it says how many more there are. */
const LISTED = 200

/**
 * The drawer a grid opens for an action on many: the action's own form,
 * filled once, then every thing it would run on, then Run. A batch's inputs
 * are the same for each, but for what narrows the target, which each thing
 * fills itself; an action that asks nothing goes straight to what it runs on.
 * It may run later instead, once or on repeat: on the saved query the many
 * came from (`saved`), as it is saved, on what the grid's filter matches
 * then, or on the very ones picked.
 */
export function BatchDrawer({ action, request, count, onClose, saved }: { action: ActionView; request: Omit<BatchRequest, 'inputs'>; count: number; onClose: () => void; saved?: { id: string; title: string } }) {
  const asksAnything = Object.values(action.inputs).some((def) => !def.narrows && def.value === undefined)
  const [answers, setAnswers] = useState<Record<string, unknown> | null>(asksAnything ? null : {})
  const asked: BatchRequest | null = answers ? { ...request, inputs: answers } : null
  const preview = useBatchPreview(action.id, asked)
  const start = useStartBatch()
  const [confirmed, setConfirmed] = useState(false)
  const [scheduling, setScheduling] = useState(false)
  const [changed, setChanged] = useState(false)
  const p = preview.data
  const blueprintName = useBlueprintName()
  const kind = p?.entities[0] ? blueprintName(p.entities[0].blueprint) : 'thing'
  const run = () => {
    if (!asked) return
    start.mutate({ action: action.id, request: asked }, { onSuccess: (b) => navigate({ page: 'action-batch', id: b.id }) })
  }
  const said = answers ? Object.entries(answers).flatMap(([n, v]) => (inputEmpty(action.inputs[n]!, v) ? [] : [`${action.inputs[n]!.title ?? n}: ${inputShown(action.inputs[n], v)}`])) : []
  return (
    <Drawer title={action.title} icon={<Icon name={iconOf(action)} className="size-6" />} subtitle={<p>On {count.toLocaleString('en-US')} picked. Each gets its own run.</p>} onClose={onClose} unsaved={changed}>
      {!answers ? (
        <ActionForm action={action} layout="drawer" onCancel={onClose} onChanged={setChanged} onMany={(inputs) => (setAnswers(inputs), setConfirmed(false))} />
      ) : (
        <>
          <div className="space-y-5 px-5 py-5">
            {said.length > 0 && (
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
                <span className="text-ink-200">{said.join(' · ')}</span>
                <Button onClick={() => setAnswers(null)}>Change</Button>
              </div>
            )}
            {preview.isFetching && !p && <p className="text-sm text-ink-400">Working out what it runs on…</p>}
            <ErrorNote error={preview.error} />
            {p && (
              <div className="space-y-3">
                <h3 className="text-base font-semibold text-ink-100">
                  It runs on {p.total.toLocaleString('en-US')} {p.total === 1 ? kind : `${kind}s`}
                </h3>
                {p.estimate && (
                  <p className="text-sm text-ink-300">
                    Takes {roughly(p.estimate.seconds)}, from how long its runs usually take{p.ahead > 0 ? `, after the ${p.ahead.toLocaleString('en-US')} already waiting for the same runner` : ''}.
                  </p>
                )}
                {p.approval > 0 && <p className="text-sm text-amber">{p.approval.toLocaleString('en-US')} of them wait for someone else to approve.</p>}
                <ol aria-label="What it runs on" className="max-h-72 divide-y divide-ink-800 overflow-y-auto rounded-sm border border-ink-700 text-sm">
                  {p.entities.slice(0, LISTED).map((e) => (
                    <li key={`${e.blueprint}:${e.key}`} className="flex gap-3 px-3 py-1.5">
                      <span className="min-w-0 flex-1 truncate text-ink-100">{e.title}</span>
                      {e.title !== e.key && <span className="max-w-[45%] truncate font-mono text-[12px] text-ink-400">{e.key}</span>}
                    </li>
                  ))}
                  {p.total > LISTED && <li className="px-3 py-1.5 text-ink-400">and {(p.total - Math.min(LISTED, p.entities.length)).toLocaleString('en-US')} more</li>}
                </ol>
                {p.refusedTotal > 0 && (
                  <details className="rounded-sm border border-ink-700 px-3 py-2 text-sm">
                    <summary className="cursor-pointer text-ink-200">It does not run on {p.refusedTotal.toLocaleString('en-US')} of those picked</summary>
                    <ul className="mt-2 space-y-1">
                      {p.refused.slice(0, LISTED).map((r) => (
                        <li key={`${r.blueprint}:${r.key}`}>
                          <span className="text-ink-100">{r.title}</span> <span className="text-ink-400">{r.reason}</span>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
                {p.total > 0 && (
                  <label className="flex items-start gap-2 text-sm text-ink-200">
                    <input type="checkbox" className="mt-0.5" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
                    <span>
                      Yes, run {action.title}
                      {said.length ? (
                        <>
                          {' '}with <strong className="text-ink-50">{said.join(', ')}</strong>
                        </>
                      ) : null}{' '}
                      on all {p.total.toLocaleString('en-US')} of these
                    </span>
                  </label>
                )}
              </div>
            )}
            <ErrorNote error={start.error} />
          </div>
          <div className="sticky bottom-0 flex flex-wrap items-center gap-2 border-t border-ink-700 bg-ink-900 px-5 py-3">
            <Button kind="solid" disabled={!p || !p.total || !confirmed || start.isPending} onClick={run}>
              {start.isPending ? 'Sending…' : p ? `Run on ${p.total.toLocaleString('en-US')}` : 'Run'}
            </Button>
            {p && p.total > 0 && (
              <Button opens="dialog" onClick={() => setScheduling(true)}>
                <span className="flex items-center gap-1.5">
                  <CalendarClock className="size-3.5" /> Run later…
                </span>
              </Button>
            )}
            <Button onClick={onClose}>Cancel</Button>
          </div>
        </>
      )}
      {scheduling && answers && p && <ScheduleDrawer request={{ action: action.id, title: `${action.title} on ${saved ? saved.title : `${p.total.toLocaleString('en-US')} ${p.total === 1 ? kind : `${kind}s`}`}`, target: saved ? { query: saved.id } : request.entities ? { entities: request.entities } : { matching: request.query! }, inputs: answers, cadence: startCadence() }} onClose={() => setScheduling(false)} />}
    </Drawer>
  )
}

/**
 * Whether an action may be offered for many at once from a grid: it says it
 * runs on many, on this blueprint, and asks nothing one answer cannot give
 * every thing alike (`unbatchable`).
 */
export function batchable(a: ActionView, blueprint: string): boolean {
  if (!a.batch || !a.canRun) return false
  const on = Array.isArray(a.blueprint) ? a.blueprint : a.blueprint ? [a.blueprint] : []
  return on.includes(blueprint) && unbatchable(a.inputs).size === 0
}

/** The actions a grid of this blueprint offers for many at once. */
export function useBatchActions(blueprint: string): ActionView[] {
  const all = useActions().data?.actions ?? []
  return useMemo(() => all.filter((a) => batchable(a, blueprint)), [all, blueprint])
}

/** How each state is drawn on a card: its colour, its mark, and the word read aloud. */
const LOOK: Record<ActionRunState, { tone: string; mark: ReactNode }> = {
  succeeded: { tone: 'border-green/60 bg-green/10 text-green', mark: <Check aria-hidden className="size-3.5" /> },
  failed: { tone: 'border-red/70 bg-red/10 text-red', mark: <X aria-hidden className="size-3.5" /> },
  unknown: { tone: 'border-amber/60 bg-amber/10 text-amber', mark: <CircleHelp aria-hidden className="size-3.5" /> },
  running: { tone: 'border-orbit/60 bg-orbit/10 text-orbit', mark: <Circle aria-hidden className="size-3.5" /> },
  queued: { tone: 'border-ink-600 bg-ink-850 text-ink-300', mark: <Square aria-hidden className="size-3.5" /> },
  awaiting: { tone: 'border-amber/60 bg-amber/10 text-amber', mark: <Hourglass aria-hidden className="size-3.5" /> },
  returned: { tone: 'border-amber/60 bg-amber/10 text-amber', mark: <Hourglass aria-hidden className="size-3.5" /> },
  cancelled: { tone: 'border-ink-600 bg-ink-850 text-ink-400', mark: <Minus aria-hidden className="size-3.5" /> },
  declined: { tone: 'border-ink-600 bg-ink-850 text-ink-400', mark: <Minus aria-hidden className="size-3.5" /> },
}

/** The colour of each state's part of the bar. */


type Show = 'all' | ActionRunState

/** One batch: its counts, then a card for every thing it ran on. */
export function BatchPage({ id }: { id: string }) {
  const batch = useActionBatch(id)
  const actions = useActions().data?.actions ?? []
  const [show, setShow] = useVisit<Show>('batch.show', 'all')
  const [query, setQuery] = useVisit('batch.query', '')
  useHere(batch.data && batchHeading(batch.data))
  const [open, setOpen] = useState<BatchItem | null>(null)
  if (batch.error) return <div className="py-6"><ErrorNote error={batch.error} /></div>
  const b = batch.data
  if (!b) return <p className="py-6 text-sm text-ink-400">Loading…</p>
  const action = actions.find((a) => a.id === b.action)
  const q = query.trim().toLowerCase()
  const items = b.items.filter((i) => (show === 'all' || i.state === show) && (!q || i.title.toLowerCase().includes(q) || i.key.toLowerCase().includes(q)))
  return (
    <div className="space-y-5 py-6">
      <Header batch={b} title={action?.title ?? b.action} icon={action ? iconOf(action) : 'rocket'} />
      <Counts batch={b} show={show} onShow={setShow} />
      <div className="flex flex-wrap items-center gap-2">
        <input type="search" aria-label="Find a thing in the batch" placeholder={`Find among ${b.items.length.toLocaleString('en-US')}`} className={`${input} w-72`} value={query} onChange={(e) => setQuery(e.target.value)} />
        <span className="text-[13px] text-ink-400">
          Showing {items.length.toLocaleString('en-US')}
          {show !== 'all' ? ` ${STATE_WORD[show]}` : ''}
        </span>
      </div>
      {items.length === 0 ? (
        <Empty>Nothing here matches.</Empty>
      ) : (
        <ul aria-label="Each thing it ran on" className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
          {items.map((i) => (
            <Card key={`${i.blueprint}:${i.key}`} item={i} batch={b} onOpen={() => setOpen(i)} />
          ))}
        </ul>
      )}
      {b.refusedItems.length > 0 && (
        <details className="rounded-sm border border-ink-700 px-3 py-2 text-sm">
          <summary className="cursor-pointer text-ink-200">Not run on {b.refusedItems.length.toLocaleString('en-US')} of those picked</summary>
          <ul className="mt-2 space-y-1">
            {b.refusedItems.map((r) => (
              <li key={`${r.blueprint}:${r.key}`}>
                <span className="text-ink-100">{r.title}</span> <span className="text-ink-400">{r.reason}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {open && <Peek item={open} batch={b} onClose={() => setOpen(null)} />}
    </div>
  )
}

/** A batch said in a few words: what it asked, and on how many things. */
function batchHeading(batch: ActionBatchResponse): string {
  const asked = Object.entries(batch.inputs).filter(([, v]) => v !== null && v !== '').map(([, v]) => String(v)).join(', ')
  const n = batch.items.length
  return `${asked ? `${asked} on ` : ''}${n.toLocaleString('en-US')} ${n === 1 ? 'thing' : 'things'}`
}

function Header({ batch, title, icon }: { batch: ActionBatchResponse; title: string; icon: string }) {
  const control = useBatchControl(batch.id)
  const failed = batch.counts.failed ?? 0
  const open = (batch.counts.queued ?? 0) + (batch.counts.awaiting ?? 0)
  const waiting = batch.counts.awaiting ?? 0
  return (
    <div className="flex flex-wrap items-start gap-3">
      <Icon name={icon} className="mt-1 size-6 text-ink-300" />
      <div className="min-w-0 flex-1 basis-64">
        <Kicker>
          <Link to={{ page: 'actions', id: batch.action }} className="hover:underline">
            {title}
          </Link>{' '}
          · batch
        </Kicker>
        <h1 className="page-title">{batchHeading(batch)}</h1>
        <p className="mt-1 text-[13px] text-ink-400">
          Asked by {batch.by} {ago(batch.createdAt)}
          {batch.stoppedAt ? ` · stopped by ${batch.stoppedBy} ${ago(batch.stoppedAt)}` : batch.done ? ` · finished${batchTook(batch) ? ` in ${batchTook(batch)}` : ''}` : ' · running'}
        </p>
      </div>
      {(batch.canAct || (batch.canDecide && waiting > 0)) && (
        <div className="flex flex-wrap gap-2">
          {batch.canDecide && waiting > 0 && (
            <Button kind="solid" disabled={control.approve.isPending} onClick={() => control.approve.mutate()}>
              <span className="flex items-center gap-1.5">
                <Check className="size-3.5" /> Approve the {waiting.toLocaleString('en-US')} waiting
              </span>
            </Button>
          )}
          {batch.canAct && failed > 0 && batch.done && (
            <Button kind="solid" disabled={control.again.isPending} onClick={() => control.again.mutate({ states: ['failed'] })}>
              <span className="flex items-center gap-1.5">
                <RotateCcw className="size-3.5" /> Run the {failed.toLocaleString('en-US')} failed again
              </span>
            </Button>
          )}
          {batch.canAct && !batch.done && open > 0 && (
            <Button kind="danger" disabled={control.stop.isPending} onClick={() => confirm(`Stop the batch? The ${open.toLocaleString('en-US')} not started yet are cancelled; what is running finishes.`) && control.stop.mutate()}>
              Stop
            </Button>
          )}
        </div>
      )}
      <ErrorNote error={control.again.error ?? control.stop.error ?? control.approve.error} />
    </div>
  )
}

/** The count in each state, as buttons that show only that state. */
function Counts({ batch, show, onShow }: { batch: ActionBatchResponse; show: Show; onShow: (s: Show) => void }) {
  const total = batch.items.length
  const done = ORDER.filter((s) => isFinished(s)).reduce((n, s) => n + (batch.counts[s] ?? 0), 0)
  return (
    <Panel className="space-y-3 px-4 py-3">
      <div className="flex items-center gap-3">
        <div className="h-2 flex-1 overflow-hidden rounded-full bg-ink-800" role="progressbar" aria-label="Runs ended" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
          <div className="flex h-full">
            {ORDER.map((s) => {
              const n = batch.counts[s] ?? 0
              return n ? <div key={s} className={BAR[s]} style={{ width: `${(n / Math.max(total, 1)) * 100}%` }} /> : null
            })}
          </div>
        </div>
        <span className="font-mono text-[12px] text-ink-300">
          {done.toLocaleString('en-US')} of {total.toLocaleString('en-US')} ended
          {batch.left && <span title={batch.left.basis === 'pace' ? 'At the pace of its runs over the last few minutes' : 'From how long its runs usually take'}> · {roughly(batch.left.seconds)} left</span>}
        </span>
      </div>
      <div role="group" aria-label="Show" className="flex flex-wrap gap-2">
        <Button kind={show === 'all' ? 'solid' : 'ghost'} onClick={() => onShow('all')}>
          All {total.toLocaleString('en-US')}
        </Button>
        {ORDER.filter((s) => batch.counts[s]).map((s) => (
          <Button key={s} kind={show === s ? 'solid' : 'ghost'} onClick={() => onShow(show === s ? 'all' : s)}>
            <span className={`flex items-center gap-1.5 ${show === s ? '' : LOOK[s].tone.split(' ').find((c) => c.startsWith('text-'))}`}>
              {LOOK[s].mark}
              {(batch.counts[s] ?? 0).toLocaleString('en-US')} {STATE_WORD[s]}
            </span>
          </Button>
        ))}
      </div>
    </Panel>
  )
}

/** What a card says of its state: a run waiting for its next try says so, not merely that it is queued. */
function stateWord(item: BatchItem): string {
  return item.retryAt && item.state === 'queued' ? 'Retrying' : STATE_WORD[item.state]
}

/** Which try and which run a thing is on, when either is past its first: `try 2`, `run 2`. */
function tryNote(item: BatchItem): string {
  const parts: string[] = []
  if (item.attempt > 1) parts.push(`try ${item.attempt}`)
  if (item.runs > 1) parts.push(`run ${item.runs}`)
  return parts.join(' · ')
}

/** One thing: its state at a glance, the picture it reported, and a way to ask again. */
function Card({ item, batch, onOpen }: { item: BatchItem; batch: ActionBatchResponse; onOpen: () => void }) {
  const look = LOOK[item.state]
  const image = item.images[0]
  const facts = Object.entries(item.outputs).slice(0, 2)
  return (
    <li className={`flex flex-col overflow-hidden rounded-md border ${look.tone.split(' ').find((c) => c.startsWith('border-'))} bg-ink-900`}>
      <button type="button" onClick={onOpen} className="group block aspect-video w-full overflow-hidden bg-ink-950 text-left" aria-label={`Open ${item.title}`}>
        {image ? <img src={runImageUrl(item.run, image)} alt={`What ${item.title} showed`} loading="lazy" className="h-full w-full object-contain group-hover:opacity-90" /> : <span className="grid h-full place-items-center text-ink-600">{isFinished(item.state) ? <ImageOff aria-hidden className="size-6" /> : <span className="text-[12px] text-ink-400">{stateWord(item)}…</span>}</span>}
      </button>
      <div className="flex min-w-0 flex-1 flex-col gap-1 px-3 py-2">
        <div className="flex items-center gap-1.5">
          <span className={`flex shrink-0 items-center gap-1 rounded-sm px-1 text-[11px] font-medium ${look.tone}`}>
            {look.mark}
            {stateWord(item)}
          </span>
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink-100" title={item.title}>
            {item.title}
          </span>
        </div>
        {item.state === 'failed' && item.summary && <p className="line-clamp-2 text-[12px] text-red" title={item.summary}>{item.summary}</p>}
        {facts.length > 0 && (
          <p className="truncate text-[12px] text-ink-300">
            {facts.map(([k, v]) => `${k.replace(/_/g, ' ')} ${String(v)}`).join(' · ')}
          </p>
        )}
        <div className="mt-auto flex items-center gap-2 pt-1 text-[12px] text-ink-400">
          {item.startedAt && item.finishedAt && <span>{duration(Date.parse(item.finishedAt) - Date.parse(item.startedAt))}</span>}
          {tryNote(item) && <span>{tryNote(item)}</span>}
          <Link to={{ page: 'action-run', id: item.run }} className="ml-auto hover:text-ink-100" label={`Open the run on ${item.title}`}>
            <span className="flex items-center">
              Run <ChevronRight aria-hidden className="size-3" />
            </span>
          </Link>
        </div>
        {batch.canAct && isFinished(item.state) && item.state !== 'succeeded' && <Again batch={batch.id} item={item} />}
      </div>
    </li>
  )
}

function Again({ batch, item }: { batch: string; item: BatchItem }) {
  const control = useBatchControl(batch)
  return (
    <Button disabled={control.again.isPending} onClick={() => control.again.mutate({ entities: [{ blueprint: item.blueprint, key: item.key }] })} className="mt-1 w-full">
      <span className="flex items-center justify-center gap-1.5">
        <RotateCcw className="size-3" /> {control.again.isPending ? 'Asking…' : 'Run again'}
      </span>
    </Button>
  )
}

/** One thing's picture, large, with what its run said. */
function Peek({ item, batch, onClose }: { item: BatchItem; batch: ActionBatchResponse; onClose: () => void }) {
  return (
    <Drawer title={item.title} subtitle={<p className={LOOK[item.state].tone.split(' ').find((c) => c.startsWith('text-'))}>{stateWord(item)}{tryNote(item) ? ` · ${tryNote(item)}` : ''}</p>} onClose={onClose}>
      <div className="space-y-4 px-5 py-5">
        {item.images.map((name) => (
          <figure key={name} className="space-y-1">
            <img src={runImageUrl(item.run, name)} alt={`${name} from ${item.title}`} className="w-full rounded-sm border border-ink-700 bg-ink-950" />
            <figcaption className="text-[12px] text-ink-400">{name.replace(/_/g, ' ')}</figcaption>
          </figure>
        ))}
        {item.summary && <p className="text-sm text-ink-200">{item.summary}</p>}
        {Object.keys(item.outputs).length > 0 && (
          <dl className="divide-y divide-ink-800 rounded-sm border border-ink-700 text-sm">
            {Object.entries(item.outputs).map(([k, v]) => (
              <div key={k} className="flex gap-3 px-3 py-1.5">
                <dt className="w-40 shrink-0 text-ink-300">{k.replace(/_/g, ' ')}</dt>
                <dd className="min-w-0 break-words text-ink-100">{String(v)}</dd>
              </div>
            ))}
          </dl>
        )}
        <div className="flex flex-wrap gap-2">
          <Link to={{ page: 'action-run', id: item.run }} className="btn btn-ghost">
            Open the run
          </Link>
          <Link to={{ page: 'entity', blueprint: item.blueprint, key: item.key }} className="btn btn-ghost">
            Open {item.title}
          </Link>
          {batch.canAct && isFinished(item.state) && <Again batch={batch.id} item={item} />}
        </div>
      </div>
    </Drawer>
  )
}
