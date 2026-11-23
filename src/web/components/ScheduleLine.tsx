// What a schedule fired on one day, as one line of the runs list: a schedule
// that fires every hour is one line a day, not twenty-four. The line says
// which schedule, how often it fires, how many times it fired, how its runs
// stand, and why the newest failure failed; opened, it lists each firing
// beneath it, a batch as one line, and the schedule's own page holds the rest.

import { CalendarClock, ChevronDown, ChevronRight } from 'lucide-react'
import { useState } from 'react'
import type { ScheduleDay } from '../../shared/api.ts'
import type { ActionView } from '../../shared/model.ts'
import { useActionRuns } from '../api.ts'
import { ago, when } from '../format.ts'
import { daySpan, dayState } from '../schedules.ts'
import { RunMark, RunRow } from './ActionRun.tsx'
import { BatchCounts, BatchRunRow } from './BatchLine.tsx'
import { Link } from './ui.tsx'

/** How many firings an opened day lists before it points to the schedule's page. */
const LISTED = 500

/**
 * One schedule's day as one row of the runs list: closed, what it is, how
 * often it fires, and how its runs stand; open, every firing that day. Where
 * the runs are not all the reader's own, whose schedule it is is said too.
 */
export function ScheduleDayRow({ line, action, me, who }: { line: ScheduleDay; action: ActionView | undefined; me: string; who: boolean }) {
  const [open, setOpen] = useState(false)
  const actionTitle = action?.title ?? line.action
  const title = line.title ?? actionTitle
  const state = dayState(line)
  const owner = line.owner === me ? 'you' : line.owner
  const fired = `fired ${line.firings.toLocaleString('en-US')} ${line.firings === 1 ? 'time' : 'times'}`
  return (
    <li className="px-1 py-2" title={who ? `Scheduled by ${owner}` : undefined}>
      <div className="flex items-center gap-2.5">
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} aria-label={open ? 'Hide its firings' : 'Show its firings'} className="text-ink-400 hover:text-ink-100">
          {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </button>
        <RunMark state={state} />
        {line.title ? (
          <Link to={{ page: 'action-schedules', id: line.schedule }} className="min-w-0 truncate text-sm font-medium text-ink-50 hover:underline">
            {title}
          </Link>
        ) : (
          <span className="min-w-0 truncate text-sm font-medium text-ink-50">{title}</span>
        )}
        {title !== actionTitle && <span className="min-w-0 truncate text-[13px] text-ink-300">{actionTitle}</span>}
        <span className="flex shrink-0 items-center gap-1 rounded-sm border border-ink-700 px-1 text-[11px] text-ink-300">
          <CalendarClock aria-hidden className="size-3" />
          {line.when ?? 'a removed schedule'}
        </span>
        {who && <span className="sr-only">, scheduled by {owner}</span>}
        <time dateTime={line.lastAt} title={when(line.lastAt)} className="ml-auto shrink-0 pl-1 text-[12px] text-ink-400">
          {ago(line.lastAt)}
        </time>
      </div>
      <div className="mt-1 min-w-0 space-y-0.5 pl-10">
        <BatchCounts batch={line} />
        <p className="truncate text-[12px] text-ink-400">
          {fired}
          {line.missed > 0 && `, ${line.missed.toLocaleString('en-US')} asked nothing`}
          {line.targetTitle && ` · on ${line.targetTitle}`}
          {who && ` · ${owner}`}
        </p>
        {state === 'failed' && line.error && (
          <p className="truncate text-[12px] text-ink-300" title={line.error}>
            {line.error}
          </p>
        )}
      </div>
      {open && <Firings line={line} action={action} me={me} who={who} />}
    </li>
  )
}

/** Every firing of a schedule's day, newest first: a batch as one line, a run asked alone as its row. */
function Firings({ line, action, me, who }: { line: ScheduleDay; action: ActionView | undefined; me: string; who: boolean }) {
  const { from, to } = daySpan(line.day)
  const runs = useActionRuns(new URLSearchParams({ group: 'origin', schedule: line.schedule, from: from.toISOString(), to: to.toISOString(), limit: String(LISTED) }))
  if (!runs.data) return <p className="py-2 pl-10 text-[12px] text-ink-400">{runs.error ? 'Could not read its firings.' : 'Loading its firings…'}</p>
  const firings = [...runs.data.runs.map((run) => ({ kind: 'run' as const, run, at: run.createdAt })), ...(runs.data.batches ?? []).map((batch) => ({ kind: 'batch' as const, batch, at: batch.createdAt }))].sort((a, b) => b.at.localeCompare(a.at))
  return (
    <div className="mt-2 ml-10 rounded-sm border border-ink-800">
      {line.missed > 0 && (
        <p className="border-b border-ink-800 px-3 py-1.5 text-[12px] text-ink-300">
          {line.missed.toLocaleString('en-US')} {line.missed === 1 ? 'firing' : 'firings'} asked nothing{line.error ? `: ${line.error}` : ''}
        </p>
      )}
      <ul aria-label="Its firings" className="max-h-96 divide-y divide-ink-800/70 overflow-y-auto px-2">
        {firings.map((f) => (f.kind === 'run' ? <RunRow key={f.run.id} run={f.run} action={action} me={me} scoped={false} who={who} decide={false} /> : <BatchRunRow key={f.batch.id} batch={f.batch} action={action} who={who} />))}
      </ul>
      {(runs.data.more || line.title) && (
        <p className="border-t border-ink-800 px-3 py-1.5 text-[12px]">
          {runs.data.more && <span className="text-ink-400">Only the newest {LISTED.toLocaleString('en-US')} · </span>}
          {line.title && (
            <Link to={{ page: 'action-schedules', id: line.schedule }} className="font-medium text-ink-100 hover:underline">
              Open the schedule: every firing and its load
            </Link>
          )}
        </p>
      )}
    </div>
  )
}
