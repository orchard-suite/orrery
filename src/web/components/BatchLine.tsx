// A batch as one line in a list of many: the runs list and the activity log
// show a batch where its runs would have been a hundred lines. The line says
// what ran, on how many, how they stand, and the picture one of them
// reported; opened, it lists every run beneath it, and the batch's own page
// holds the whole grid.

import { ChevronDown, ChevronRight } from 'lucide-react'
import { useState } from 'react'
import type { ActionBatchSummary } from '../../shared/api.ts'
import { isFinished, type ActionRunState, type ActionView } from '../../shared/model.ts'
import { roughly } from '../../shared/estimate.ts'
import { runImageUrl, useActionBatch, useBlueprintName } from '../api.ts'
import { ago, duration, when } from '../format.ts'
import { RunMark, STATE_WORD } from './ActionRun.tsx'
import { Link } from './ui.tsx'

export const BAR: Record<ActionRunState, string> = { succeeded: 'bg-green', failed: 'bg-red', unknown: 'bg-amber', running: 'bg-orbit', queued: 'bg-ink-600', awaiting: 'bg-amber', returned: 'bg-amber', cancelled: 'bg-ink-500', declined: 'bg-ink-500' }

/** The order the states are counted in, worst first. */
export const ORDER: ActionRunState[] = ['failed', 'unknown', 'running', 'queued', 'awaiting', 'returned', 'succeeded', 'cancelled', 'declined']

/** How many runs a batch holds, newest on each entity. */
export function batchSize(b: Pick<ActionBatchSummary, 'counts'>): number {
  return Object.values(b.counts).reduce((n, c) => n + (c ?? 0), 0)
}

/** The batch's state in one mark: running while any run is open, failed when any failed, else how its runs ended. */
export function batchState(b: Pick<ActionBatchSummary, 'counts' | 'done'>): ActionRunState {
  if (!b.done) return (b.counts.running ?? 0) > 0 ? 'running' : 'queued'
  if ((b.counts.failed ?? 0) > 0) return 'failed'
  if ((b.counts.succeeded ?? 0) > 0) return 'succeeded'
  return 'cancelled'
}

/** What was asked, in words: the values of its inputs. */
export function batchAsked(b: Pick<ActionBatchSummary, 'inputs'>): string {
  return Object.values(b.inputs)
    .filter((v) => v !== null && v !== '' && v !== undefined)
    .map(String)
    .join(', ')
}

/** The counts, worst first, as a thin bar and in words. */
export function BatchCounts({ batch }: { batch: Pick<ActionBatchSummary, 'counts'> }) {
  const total = Math.max(batchSize(batch), 1)
  const shown = ORDER.filter((s) => batch.counts[s])
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span aria-hidden className="flex h-1.5 w-20 shrink-0 overflow-hidden rounded-full bg-ink-800">
        {shown.map((s) => (
          <span key={s} className={BAR[s]} style={{ width: `${((batch.counts[s] ?? 0) / total) * 100}%` }} />
        ))}
      </span>
      <span className="truncate text-[12px] text-ink-300">{shown.map((s) => `${(batch.counts[s] ?? 0).toLocaleString('en-US')} ${STATE_WORD[s]}`).join(' · ')}</span>
    </span>
  )
}

/** The picture a batch is shown by, small, or nothing when none of its runs reported one. */
export function BatchCover({ batch, className = 'h-10 w-16' }: { batch: Pick<ActionBatchSummary, 'cover'>; className?: string }) {
  if (!batch.cover) return null
  return <img src={runImageUrl(batch.cover.run, batch.cover.name)} alt="" loading="lazy" className={`${className} shrink-0 rounded-sm border border-ink-700 bg-ink-950 object-cover`} />
}

/** How long it took, once it is over: from when it was asked to when its last run ended. */
export function batchTook(b: Pick<ActionBatchSummary, 'createdAt' | 'endedAt'>): string | null {
  return b.endedAt ? duration(Date.parse(b.endedAt) - Date.parse(b.createdAt)) : null
}

/**
 * A batch as one row of the runs list: closed, what ran and how its runs
 * stand; open, every run under it, each opening its own page, and the batch's
 * page for the grid.
 */
export function BatchRunRow({ batch, action, who }: { batch: ActionBatchSummary; action: ActionView | undefined; who: boolean }) {
  const [open, setOpen] = useState(false)
  const name = useBlueprintName()
  const size = batchSize(batch)
  const asked = batchAsked(batch)
  const took = batchTook(batch)
  return (
    <li className="px-1 py-2" title={who ? `Asked by ${batch.by}` : undefined}>
      <div className="flex items-center gap-2.5">
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} aria-label={open ? 'Hide its runs' : 'Show its runs'} className="text-ink-400 hover:text-ink-100">
          {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </button>
        <RunMark state={batchState(batch)} />
        <Link to={{ page: 'action-batch', id: batch.id }} className="min-w-0 truncate text-sm font-medium text-ink-50 hover:underline">
          {action?.title ?? batch.action}
          {asked ? ` · ${asked}` : ''}
        </Link>
        <span className="shrink-0 rounded-sm border border-ink-700 px-1 text-[11px] text-ink-300">
          batch of {size.toLocaleString('en-US')} {size === 1 ? name(batch.blueprint) : `${name(batch.blueprint)}s`}
        </span>
        <time dateTime={batch.createdAt} title={when(batch.createdAt)} className="ml-auto shrink-0 pl-1 text-[12px] text-ink-400">
          {ago(batch.createdAt)}
        </time>
      </div>
      <div className="mt-1 flex items-center gap-3 pl-10">
        <BatchCover batch={batch} />
        <div className="min-w-0 flex-1 space-y-0.5">
          <BatchCounts batch={batch} />
          {(batch.counts.awaiting ?? 0) > 0 && (
            <Link to={{ page: 'action-batch', id: batch.id }} className="block text-[12px] text-amber hover:underline">
              Decide the {(batch.counts.awaiting ?? 0).toLocaleString('en-US')} waiting on the batch’s page
            </Link>
          )}
          <p className="text-[12px] text-ink-400">
            {who ? `${batch.by} · ` : ''}
            {took ? `took ${took}` : batch.done ? 'stopped' : 'running'}
          </p>
        </div>
      </div>
      {open && <BatchMembers id={batch.id} />}
    </li>
  )
}

/** How many runs an opened batch lists before it points to its own page. */
const LISTED = 200

/** Every entity's newest run of a batch, one line each, the failed first. */
export function BatchMembers({ id }: { id: string }) {
  const batch = useActionBatch(id)
  if (!batch.data) return <p className="py-2 pl-10 text-[12px] text-ink-400">{batch.error ? 'Could not read its runs.' : 'Loading its runs…'}</p>
  const items = [...batch.data.items].sort((a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state) || a.title.localeCompare(b.title))
  return (
    <div className="mt-2 ml-10 rounded-sm border border-ink-800">
      {!batch.data.done && batch.data.left && <p className="border-b border-ink-800 px-3 py-1.5 text-[12px] text-ink-300">{roughly(batch.data.left.seconds)} left</p>}
      <ul aria-label="Its runs" className="max-h-80 divide-y divide-ink-800/70 overflow-y-auto">
        {items.slice(0, LISTED).map((i) => (
          <li key={i.run} className="flex items-center gap-2.5 px-3 py-1.5 text-[13px]">
            <RunMark state={i.state} />
            <Link to={{ page: 'action-run', id: i.run }} className="min-w-0 flex-1 truncate text-ink-100 hover:underline">
              {i.title}
            </Link>
            <span className="max-w-[45%] truncate text-[12px] text-ink-400" title={i.summary ?? undefined}>
              {i.state === 'failed' ? i.summary : Object.entries(i.outputs).slice(0, 2).map(([k, v]) => `${k.replace(/_/g, ' ')} ${String(v)}`).join(' · ')}
            </span>
            {i.startedAt && i.finishedAt && isFinished(i.state) && <span className="shrink-0 text-[11px] text-ink-500">{duration(Date.parse(i.finishedAt) - Date.parse(i.startedAt))}</span>}
          </li>
        ))}
      </ul>
      <p className="border-t border-ink-800 px-3 py-1.5 text-[12px]">
        {items.length > LISTED && <span className="text-ink-400">and {(items.length - LISTED).toLocaleString('en-US')} more · </span>}
        <Link to={{ page: 'action-batch', id }} className="font-medium text-ink-100 hover:underline">
          Open the batch: every result and picture
        </Link>
      </p>
    </div>
  )
}
