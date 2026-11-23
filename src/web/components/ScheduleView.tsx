// One schedule, contained: what it runs, on what, when, and as whom; what may
// be done with it; its numbers over a window; a strip of every firing; and
// every firing as a row that opens to its runs: the run's steps and how it
// ended, or a batch's runs that did not succeed. It opens over the schedules
// page in a drawer, at the schedule's own address.

import { CalendarClock } from 'lucide-react'
import { useState } from 'react'
import type { ActionSchedule, ScheduleFiring } from '../../shared/api.ts'
import type { Outcome } from '../schedules.ts'
import { isOnce } from '../../shared/cadence.ts'
import { TELL_WORDS } from '../../shared/schedule.ts'
import type { ActionRunState } from '../../shared/model.ts'
import { useActionBatch, useActionRun, useActions, useScheduleHistory } from '../api.ts'
import { ago, duration } from '../format.ts'
import { HOLLOW, OUTCOME_FILL, OUTCOME_WORD, whenOf, isBatch, minutesADay, outcomeOf, runnerTime, standing, successRate, tally } from '../schedules.ts'
import { RunMark, StateBadge, STATE_WORD as RUN_WORD } from './ActionRun.tsx'
import { Drawer } from './Drawer.tsx'
import { ScheduleControls, STATE_TONE, STATE_WORD } from './Schedules.tsx'
import { Badge, Empty, ErrorNote, Link } from './ui.tsx'
import { useHere, useVisit } from '../trail.ts'

const WINDOWS = [7, 30, 90] as const
/** The firings a page of the list holds. */
const PAGE = 50

const n = (x: number) => Math.round(x).toLocaleString('en-US')
const plural = (x: number, one: string, many = `${one}s`) => `${n(x)} ${x === 1 ? one : many}`
const at = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
const keyOf = (f: ScheduleFiring) => `${f.at}|${f.batch ?? f.run ?? 'error'}`

export function ScheduleView({ id, s, onClose }: { id: string; s: ActionSchedule | null; onClose: () => void }) {
  useHere(s?.title)
  return (
    <Drawer title={s?.title ?? 'Schedule'} icon={<CalendarClock className="size-6" />} width={780} onClose={onClose} subtitle={s ? <Subtitle s={s} /> : undefined}>
      {s ? <Body s={s} onClose={onClose} /> : <div className="px-5 py-5"><Empty>No schedule "{id}" that you may see. It may have been removed.</Empty></div>}
    </Drawer>
  )
}

/** What a schedule asks each time it fires, in words: once or each time, one run or a batch, and on what kind of many. */
function shapeOf(s: ActionSchedule): string {
  const each = isOnce(s.cadence) ? '' : ' each time'
  if (s.target.entities) return `A batch on the ${s.target.entities.length.toLocaleString('en-US')} picked${each}`
  if (s.target.matching) return `A batch on what its filter matches then${each}`
  if (s.target.query) return `A batch on what a saved query matches then${each}`
  return `One run${each}`
}

function Subtitle({ s }: { s: ActionSchedule }) {
  const action = useActions().data?.actions.find((a) => a.id === s.action)
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <Badge className={STATE_TONE[s.state]}>{STATE_WORD[s.state]}</Badge>
        <span className="text-[13px] text-ink-300">{shapeOf(s)}</span>
      </div>
      <p className="text-[13px] text-ink-300">
        {action ? (
          <Link to={{ page: 'actions', id: action.id }} className="text-ink-100 hover:underline">
            {action.title}
          </Link>
        ) : (
          s.action
        )}
        {s.targetTitle ? ` on ${s.targetTitle}` : ''} · {whenOf(s)}
        {s.load?.runner ? (
          <>
            {' · '}runner <span className="font-mono text-[12px] whitespace-nowrap">{s.load.runner}</span>
          </>
        ) : null}
      </p>
    </div>
  )
}

function Body({ s, onClose }: { s: ActionSchedule; onClose: () => void }) {
  const [days, setDays] = useVisit<(typeof WINDOWS)[number]>('schedule.days', 30)
  const history = useScheduleHistory(days, s.id)
  const firings = history.data?.firings ?? []
  const t = tally([s], firings)
  const rate = successRate(t)
  const [open, setOpen] = useState<string | null>(null)
  const [shown, setShown] = useState(PAGE)
  const newest = [...firings].reverse()
  const first = open ?? (newest[0] ? keyOf(newest[0]) : null)
  const minutes = minutesADay(s)
  const facts: [string, string, string?][] = [
    ['Next', s.nextAt ? at(s.nextAt) : s.state === 'awaiting' ? 'once approved' : s.state === 'done' ? 'none: it fired once' : 'not while it is ' + STATE_WORD[s.state], s.nextAt ? ago(s.nextAt) : undefined],
    ['Last fired', s.lastAt ? ago(s.lastAt) : 'never'],
    ['Firings', n(t.firings), t.errors ? `${n(t.errors)} asked nothing` : undefined],
    ['Runs', n(t.runs), t.open ? `${n(t.open)} still open` : undefined],
    ['Succeeded', rate === null ? '—' : `${(rate * 100).toFixed(rate > 0.999 || rate < 0.001 ? 0 : 1)}%`, t.failed ? `${n(t.failed)} failed` : undefined],
    ['Runner time', runnerTime(t.seconds), isOnce(s.cadence) ? (s.load?.runnerSeconds != null ? `asks ${runnerTime(s.load.runnerSeconds)} in all` : 'what it asks is known once the action has run') : minutes !== null ? `asks ${runnerTime(minutes * 60)} a day` : 'what it asks is known once the action has run'],
  ]
  const pick = (f: ScheduleFiring) => {
    const k = keyOf(f)
    setOpen(k)
    const i = newest.findIndex((x) => keyOf(x) === k)
    if (i >= shown) setShown(i + 1)
    requestAnimationFrame(() => document.getElementById(`firing-${k}`)?.scrollIntoView({ block: 'nearest' }))
  }
  return (
    <div className="divide-y divide-ink-800">
      <section className="space-y-3 px-5 py-4">
        {standing(s) && <p className="text-[13px] text-amber">{standing(s)}</p>}
        <ScheduleControls s={s} onRemoved={onClose} />
        <p className="text-[12px] text-ink-400">
          {s.owner} set it up {ago(s.createdAt)}.{s.decidedBy ? ` ${s.state === 'declined' ? 'Declined' : 'Approved'} by ${s.decidedBy}${s.decidedAt ? ` ${ago(s.decidedAt)}` : ''}.` : ''}
          {` It tells ${[s.owner, ...s.deliver].join(', ')} ${TELL_WORDS[s.tell].said}.`}
        </p>
      </section>
      <section className="px-5 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-[13px] font-semibold text-ink-100">Over the last</h3>
          <div role="group" aria-label="Window" className="flex rounded-md border border-ink-700 p-0.5">
            {WINDOWS.map((d) => (
              <button key={d} type="button" aria-pressed={d === days} onClick={() => setDays(d)} className={`min-h-6 rounded px-2 py-0.5 text-[12px] ${d === days ? 'bg-ink-700 text-ink-50' : 'text-ink-300 hover:text-ink-100'}`}>
                {d} days
              </button>
            ))}
          </div>
        </div>
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
          {facts.map(([k, v, note]) => (
            <div key={k} className="min-w-0">
              <dt className="label">{k}</dt>
              <dd className="text-[17px] font-medium break-words text-ink-50">{v}</dd>
              {note && <dd className="text-[12px] text-ink-400">{note}</dd>}
            </div>
          ))}
        </dl>
      </section>
      <section className="px-5 py-4">
        <ErrorNote error={history.error} />
        {firings.length ? <Strip firings={firings} days={days} onPick={pick} /> : <p className="text-[13px] text-ink-400">{history.isLoading ? 'Loading…' : s.state === 'awaiting' ? 'Nothing has fired yet. It fires once someone approves it.' : `Nothing fired in the last ${days} days.`}</p>}
      </section>
      {firings.length > 0 && (
        <section className="px-5 py-4">
          <h3 className="text-[13px] font-semibold text-ink-100">
            Every firing <span className="font-normal text-ink-400">· newest first</span>
          </h3>
          <ul className="mt-2 divide-y divide-ink-800 border-y border-ink-800">
            {newest.slice(0, shown).map((f) => (
              <Firing key={keyOf(f)} f={f} open={first === keyOf(f)} onToggle={() => setOpen(first === keyOf(f) ? '' : keyOf(f))} />
            ))}
          </ul>
          {newest.length > shown && (
            <button type="button" className="mt-3 text-[13px] font-medium text-ink-200 hover:text-ink-50" onClick={() => setShown(shown + PAGE)}>
              Show {n(Math.min(PAGE, newest.length - shown))} older
            </button>
          )}
        </section>
      )}
    </div>
  )
}

/** A mark's colour as a small swatch: filled, or hollow for a firing that asked nothing. */
export function Swatch({ o }: { o: Outcome }) {
  return <span aria-hidden className={`inline-block h-2.5 rounded-sm ${HOLLOW.has(o) ? 'w-2.5' : 'w-1.5'}`} style={HOLLOW.has(o) ? { boxShadow: `inset 0 0 0 1.5px ${OUTCOME_FILL[o]}` } : { background: OUTCOME_FILL[o] }} />
}

/** How a mark is painted: filled with its outcome's colour, or outlined for a firing that asked nothing. */
export function markPaint(o: Outcome): { fill: string; stroke?: string; strokeWidth?: number } {
  return HOLLOW.has(o) ? { fill: 'none', stroke: OUTCOME_FILL[o], strokeWidth: 1.5 } : { fill: OUTCOME_FILL[o] }
}

/** Every firing in the window, oldest to newest left to right: its height the runner time it took, its colour how it went. A click opens it in the list. */
function Strip({ firings, days, onPick }: { firings: ScheduleFiring[]; days: number; onPick: (f: ScheduleFiring) => void }) {
  const top = Math.max(1, ...firings.map((f) => f.seconds))
  const H = 64
  // Each firing takes an equal step, the newest at the right edge, so a schedule that fired once or twice reads as recent.
  const w = Math.min(100 / firings.length, 3)
  const outcomes = [...new Set(firings.map(outcomeOf))]
  return (
    <figure>
      <figcaption className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[12px] text-ink-400">
        <span>Each firing over {days} days, oldest on the left. Taller took more runner time.</span>
        {outcomes.map((o) => (
          <span key={o} className="flex items-center gap-1.5 text-ink-300">
            <Swatch o={o} />
            {OUTCOME_WORD[o]}
          </span>
        ))}
      </figcaption>
      <svg className="mt-2 block w-full" height={H} role="img" aria-label={`${plural(firings.length, 'firing')}; the longest took ${runnerTime(top)}`}>
        {firings.map((f, i) => {
          const h = f.error ? 16 : Math.max(3, Math.sqrt(f.seconds / top) * H)
          return (
            <rect key={keyOf(f)} x={`${100 - (firings.length - i) * w}%`} y={H - h} width={`${Math.max(w - (firings.length > 200 ? 0 : w * 0.25), 0.2)}%`} height={h} {...markPaint(outcomeOf(f))} className="cursor-pointer" onClick={() => onPick(f)}>
              <title>{`${at(f.at)} · ${f.error ? 'asked nothing' : `${plural(f.runs, 'run')}${f.failed ? `, ${n(f.failed)} failed` : ''} · ${runnerTime(f.seconds)}`}`}</title>
            </rect>
          )
        })}
      </svg>
    </figure>
  )
}

/** The share of a firing's runs by how each ended, as one bar. */
function Split({ f }: { f: ScheduleFiring }) {
  const parts: [number, string][] = [
    [f.succeeded, 'var(--color-green)'],
    [f.failed, 'var(--color-red)'],
    // Still open is hatched: begun, not done.
    [f.open, 'repeating-linear-gradient(135deg, var(--color-orbit) 0 2px, transparent 2px 4px)'],
    [f.stopped, 'var(--color-ink-500)'],
  ]
  return (
    <span aria-hidden className="flex h-1.5 w-24 overflow-hidden rounded-full bg-ink-800">
      {parts.map(([v, c], i) => (v ? <span key={i} style={{ flexGrow: v, flexBasis: 0, minWidth: 3, background: c }} /> : null))}
    </span>
  )
}

/** One firing as a row: when, how many runs, how they went, and how long; opened, its runs. */
function Firing({ f, open, onToggle }: { f: ScheduleFiring; open: boolean; onToggle: () => void }) {
  const o = outcomeOf(f)
  const took = f.startedAt && f.endedAt ? duration(Date.parse(f.endedAt) - Date.parse(f.startedAt)) : null
  const what = f.error ? 'Asked nothing' : [plural(f.runs, 'run'), f.failed ? `${n(f.failed)} failed` : null, f.open ? `${n(f.open)} open` : null, f.stopped ? `${n(f.stopped)} stopped` : null, took ? `took ${took}` : null, f.seconds ? `${runnerTime(f.seconds)} runner time` : null].filter(Boolean).join(' · ')
  const k = keyOf(f)
  return (
    <li id={`firing-${k}`}>
      <button type="button" aria-expanded={open} onClick={onToggle} className="grid w-full grid-cols-[0.75rem_minmax(0,1fr)_auto] items-center gap-x-3 py-2 text-left hover:bg-ink-850/60">
        <span aria-hidden className="size-2.5 rounded-full" style={HOLLOW.has(o) ? { boxShadow: `inset 0 0 0 1.5px ${OUTCOME_FILL[o]}` } : { background: OUTCOME_FILL[o] }} />
        <span className="min-w-0">
          <span className="text-[13px] font-medium text-ink-100">{at(f.at)}</span>
          <span className="block text-[12px] text-ink-400">
            <span className="sr-only">{OUTCOME_WORD[o]}. </span>
            {what}
          </span>
        </span>
        {!f.error && <Split f={f} />}
      </button>
      {open && (
        <div className="pb-3 pl-6">
          {f.error ? <p className="text-[13px] text-red">It failed before it asked anything: {f.error}</p> : f.batch ? <BatchRuns id={f.batch} /> : f.run ? <OneRun id={f.run} /> : null}
        </div>
      )}
    </li>
  )
}

/** A firing that asked one run: how it ended, its steps, and what it said. */
function OneRun({ id }: { id: string }) {
  const run = useActionRun(id)
  if (run.error) return <ErrorNote error={run.error} />
  const r = run.data
  if (!r) return <p className="text-[12px] text-ink-400">Loading…</p>
  return (
    <div className="space-y-2 text-[13px]">
      <div className="flex flex-wrap items-center gap-2">
        <StateBadge run={r} />
        {r.entityTitle && <span className="text-ink-300">on {r.entityTitle}</span>}
        {r.claimedBy && <span className="text-ink-400">· ran on <span className="font-mono text-[12px]">{r.claimedBy}</span></span>}
        <Link to={{ page: 'action-run', id: r.id }} className="ml-auto inline-block py-1 text-ink-100 underline hover:text-ink-50">
          Open the run
        </Link>
      </div>
      {r.summary && <p className="break-words text-ink-200">{r.summary}</p>}
      {r.steps.length > 0 && (
        <ol className="space-y-0.5 text-[12px] text-ink-300">
          {r.steps.map((st, i) => (
            <li key={`${st.name}-${i}`} className="flex gap-2">
              <span className="text-ink-400">{i + 1}.</span>
              <span>{st.name}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

/** The states a batch's runs are counted by, in the order said. */
const COUNTED: ActionRunState[] = ['succeeded', 'failed', 'unknown', 'running', 'queued', 'awaiting', 'declined', 'cancelled', 'returned']
/** The most runs of a batch listed by name in a firing; the batch's own page lists every one. */
const LISTED = 12

/** A firing that asked a batch: its runs counted by how each ended, and the ones that did not succeed by name. */
function BatchRuns({ id }: { id: string }) {
  const batch = useActionBatch(id)
  if (batch.error) return <ErrorNote error={batch.error} />
  const b = batch.data
  if (!b) return <p className="text-[12px] text-ink-400">Loading…</p>
  const off = b.items.filter((i) => i.state !== 'succeeded').sort((x, y) => x.title.localeCompare(y.title, undefined, { numeric: true }))
  return (
    <div className="space-y-2 text-[13px]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {COUNTED.filter((st) => b.counts[st]).map((st) => (
          <span key={st} className="flex items-center gap-1.5 text-ink-200">
            <RunMark state={st} /> {n(b.counts[st]!)} {RUN_WORD[st]}
          </span>
        ))}
        {b.refused > 0 && <span className="text-ink-400">{n(b.refused)} refused</span>}
        <Link to={{ page: 'action-batch', id: b.id }} className="ml-auto inline-block py-1 text-ink-100 underline hover:text-ink-50">
          Open the batch
        </Link>
      </div>
      {off.length > 0 ? (
        <ul className="divide-y divide-ink-800 rounded-md border border-ink-800">
          {off.slice(0, LISTED).map((i) => (
            <li key={i.run} className="flex items-start gap-2 px-2.5 py-0.5">
              <span className="py-1.5">
                <RunMark state={i.state} />
              </span>
              <Link to={{ page: 'action-run', id: i.run }} className="min-w-0 shrink-0 py-1 text-ink-100 hover:underline">
                {i.title}
              </Link>
              {i.summary && <span className="min-w-0 py-1 break-words text-[12px] text-ink-400">{i.summary}</span>}
            </li>
          ))}
          {off.length > LISTED && <li className="px-2.5 py-1.5 text-[12px] text-ink-400">and {n(off.length - LISTED)} more on the batch’s page</li>}
        </ul>
      ) : (
        <p className="text-[12px] text-ink-400">Every run succeeded.</p>
      )}
    </div>
  )
}
